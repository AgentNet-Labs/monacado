/**
 * Durable publication worker-run status (Phase 0E.7.3) — SERVER ONLY.
 *
 * One bounded row per invocation of the one-shot worker command, recording that it
 * started, that it finished, and what bounded outcome it reported.
 *
 * **This table is evidence, never authority.** Nothing here reads or writes a
 * publication, outbox, submission-attempt, receipt, or remediation row, and no
 * method returns anything a domain decision could be based on. If this table were
 * dropped, every publication would still be in exactly the state its own records
 * describe.
 *
 * Three properties matter:
 *
 *   1. **Compare-and-set, never read-then-write.** Every terminal transition is an
 *      `updateMany` whose WHERE clause re-asserts `status = 'STARTED'`. A row that
 *      moved underneath us matches zero rows and the caller is told, rather than a
 *      second command silently overwriting the first one's evidence.
 *
 *   2. **Terminal history is immutable.** COMPLETED, FAILED, and ABANDONED never
 *      transition again. An identical terminal replay returns the stored record —
 *      that is what makes a retried finalisation safe — while a *conflicting* one
 *      fails loudly.
 *
 *   3. **No transaction spans anything interesting.** Each write is one statement.
 *      No transaction covers the worker cycle, a transport call, two publication
 *      runs, or the process lifetime, so operational bookkeeping can never hold a
 *      lock across the network.
 *
 * Every instant is supplied by the caller. This module reads no clock.
 */

import "../server-only";
import type { PublicationWorkerRun as RunRow } from "@prisma/client";
import {
  AbandonStalePublicationWorkerRunsInput,
  AbandonStalePublicationWorkerRunsResult,
  CompletePublicationWorkerRunInput,
  FailPublicationWorkerRunInput,
  ListRecentPublicationWorkerRunsInput,
  PublicationWorkerRunRecord,
  StartPublicationWorkerRunInput,
  isTerminalWorkerRunStatus,
  normalizeWorkerRunIssueCodes,
  type AbandonStalePublicationWorkerRunsResult as SweepResult,
  type PublicationWorkerRunRecord as RunRecord,
} from "../../contracts/product/publication-worker-run";
import { getPrisma } from "../db/client";
import {
  DuplicateWorkerRunCycleIdError,
  InvalidWorkerRunInputError,
  WorkerRunNotFoundError,
  WorkerRunPersistenceFailureError,
  WorkerRunTerminalConflictError,
} from "./worker-run-errors";

type Db = ReturnType<typeof getPrisma>;

/** Prisma's unique-constraint violation. */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error as { code?: unknown }).code === "P2002";

/**
 * Issue codes are stored as one sorted, comma-joined string.
 *
 * Not JSON: the codes are SCREAMING_SNAKE_CASE by contract, so they cannot contain
 * a comma, and a plain column leaves nowhere for arbitrary structure — a payload, a
 * cause, a nested object — to be smuggled into operational storage later. Sorting
 * makes the stored form byte-identical for the same set, which is what lets an
 * identical terminal replay be recognised.
 */
const encodeIssueCodes = (codes: readonly string[]): string =>
  normalizeWorkerRunIssueCodes(codes).join(",");

const decodeIssueCodes = (stored: string): string[] =>
  stored === "" ? [] : stored.split(",").filter((code) => code !== "");

/** Project a row onto the safe record. The surrogate id never leaves this module. */
function rowToRecord(row: RunRow): RunRecord {
  return PublicationWorkerRunRecord.parse({
    cycleId: row.cycleId,
    status: row.status,
    outcome: row.workerOutcome,
    exitCode: row.exitCode,
    maximumRuns: row.maximumRuns,
    runsAttempted: row.runsAttempted,
    itemsClaimed: row.itemsClaimed,
    stoppedForNoWork: row.stoppedForNoWork,
    shutdownRequested: row.shutdownRequested,
    expiredClaimsExamined: row.expiredClaimsExamined,
    expiredClaimsRecovered: row.expiredClaimsRecovered,
    expiredClaimsSkipped: row.expiredClaimsSkipped,
    issueCodes: decodeIssueCodes(row.issueCodes),
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt === null ? null : row.completedAt.toISOString(),
  });
}

function inputError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): InvalidWorkerRunInputError {
  return new InvalidWorkerRunInputError(
    Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))),
  );
}

export class PublicationWorkerRunRepository {
  constructor(private readonly db: Db = getPrisma()) {}

  /**
   * Record that a command is about to run its one bounded cycle.
   *
   * Called only once configuration is READY, Registrar readiness has passed, the
   * pre-claim dependencies exist, shutdown handlers are installed, and the owned
   * database client has been constructed — i.e. at the point where the very next
   * thing is the cycle. Creating the row earlier would record runs that could never
   * have claimed anything; creating it later would lose exactly the evidence that
   * matters when a command dies mid-cycle.
   */
  async startPublicationWorkerRun(input: unknown): Promise<RunRecord> {
    const parsed = StartPublicationWorkerRunInput.safeParse(input);
    if (!parsed.success) throw inputError(parsed.error);
    const req = parsed.data;

    try {
      const row = await this.db.publicationWorkerRun.create({
        data: {
          cycleId: req.cycleId,
          status: "STARTED",
          maximumRuns: req.maximumRuns,
          startedAt: new Date(req.startedAt),
          issueCodes: "",
        },
      });
      return rowToRecord(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw new DuplicateWorkerRunCycleIdError(req.cycleId, error);
      throw new WorkerRunPersistenceFailureError("start", error);
    }
  }

  /**
   * Finalise a run from a validated cycle result.
   *
   * `status` is derived from the outcome, not supplied: FAILED outcomes become
   * FAILED rows and everything else becomes COMPLETED, so no caller can record a
   * failure as a success.
   *
   * An identical replay returns the stored record. A conflicting one throws. The
   * comparison covers every authoritative field, so "identical" means the two
   * finalisations describe the same run rather than merely agreeing on its outcome.
   */
  async completePublicationWorkerRun(input: unknown): Promise<RunRecord> {
    const parsed = CompletePublicationWorkerRunInput.safeParse(input);
    if (!parsed.success) throw inputError(parsed.error);
    const req = parsed.data;

    const status = req.outcome === "FAILED" ? "FAILED" : "COMPLETED";
    return this.finalize(req.cycleId, {
      status,
      workerOutcome: req.outcome,
      exitCode: req.exitCode,
      runsAttempted: req.runsAttempted,
      itemsClaimed: req.itemsClaimed,
      stoppedForNoWork: req.stoppedForNoWork,
      shutdownRequested: req.shutdownRequested,
      expiredClaimsExamined: req.expiredClaimsExamined,
      expiredClaimsRecovered: req.expiredClaimsRecovered,
      expiredClaimsSkipped: req.expiredClaimsSkipped,
      issueCodes: encodeIssueCodes(req.issueCodes),
      completedAt: new Date(req.completedAt),
    });
  }

  /**
   * Finalise a run that failed before any cycle result existed.
   *
   * `workerOutcome` stays null — there is genuinely no cycle outcome to report, and
   * writing FAILED into that column would be indistinguishable from a cycle that
   * ran and failed. The distinction matters: one means the work was attempted, the
   * other means it never was.
   */
  async failPublicationWorkerRun(input: unknown): Promise<RunRecord> {
    const parsed = FailPublicationWorkerRunInput.safeParse(input);
    if (!parsed.success) throw inputError(parsed.error);
    const req = parsed.data;

    return this.finalize(req.cycleId, {
      status: "FAILED",
      workerOutcome: null,
      exitCode: req.exitCode,
      issueCodes: encodeIssueCodes(req.issueCodes),
      completedAt: new Date(req.completedAt),
    });
  }

  /**
   * One bounded stale-run sweep, transitioning STARTED rows to ABANDONED.
   *
   * Explicit and operator-driven. It is **never** invoked automatically, on import,
   * on a timer, or at the start of a command: process death cannot be observed, so
   * only a human (or a future deployment wrapper) knows how long a legitimate
   * command may take, and an automatic sweep with a guessed cutoff would eventually
   * mark a live run abandoned.
   *
   * Oldest first, bounded batch, one compare-and-set per row. Original timestamps
   * and counters are preserved — an abandoned run keeps whatever it managed to
   * report — and terminal rows are untouchable.
   */
  async abandonStalePublicationWorkerRuns(input: unknown): Promise<SweepResult> {
    const parsed = AbandonStalePublicationWorkerRunsInput.safeParse(input);
    if (!parsed.success) throw inputError(parsed.error);
    const req = parsed.data;

    let candidates: RunRow[];
    try {
      candidates = await this.db.publicationWorkerRun.findMany({
        where: {
          status: "STARTED",
          completedAt: null,
          startedAt: { lt: new Date(req.startedBefore) },
        },
        // Deterministic: oldest start first, then identity, so two sweeps over the
        // same data process the same rows in the same order.
        orderBy: [{ startedAt: "asc" }, { cycleId: "asc" }],
        take: req.limit,
      });
    } catch (error) {
      throw new WorkerRunPersistenceFailureError("abandon-scan", error);
    }

    let abandonedCount = 0;
    let skippedCount = 0;

    for (const candidate of candidates) {
      let updated: { count: number };
      try {
        // Re-asserts STARTED: a run that finished between the scan and here is
        // skipped rather than having its own result overwritten.
        updated = await this.db.publicationWorkerRun.updateMany({
          where: { cycleId: candidate.cycleId, status: "STARTED", completedAt: null },
          data: {
            status: "ABANDONED",
            completedAt: new Date(req.abandonedAt),
            issueCodes: encodeIssueCodes([
              ...decodeIssueCodes(candidate.issueCodes),
              "WORKER_RUN_STALE",
            ]),
          },
        });
      } catch (error) {
        throw new WorkerRunPersistenceFailureError("abandon", error);
      }
      if (updated.count === 1) abandonedCount += 1;
      else skippedCount += 1;
    }

    return AbandonStalePublicationWorkerRunsResult.parse({
      examined: candidates.length,
      abandonedCount,
      skippedCount,
    });
  }

  // — Reads —

  /** One run by cycle id, or undefined. Safe projection only. */
  async getPublicationWorkerRun(cycleId: string): Promise<RunRecord | undefined> {
    const row = await this.db.publicationWorkerRun.findUnique({ where: { cycleId } });
    return row === null ? undefined : rowToRecord(row);
  }

  /**
   * Recent runs, newest first, bounded.
   *
   * Ordering is `startedAt` descending then `cycleId` descending — a total order, so
   * two calls over unchanged data return the same list even when several runs share
   * an instant. `startedAt` rather than `completedAt` because it is never null, so
   * an in-flight run does not sort unpredictably.
   *
   * There is no filter language: a bounded limit and an optional terminal-only flag
   * are what an operator needs, and an expression language over operational history
   * is a query surface nobody asked for.
   */
  async listRecentPublicationWorkerRuns(input: unknown): Promise<RunRecord[]> {
    const parsed = ListRecentPublicationWorkerRunsInput.safeParse(input);
    if (!parsed.success) throw inputError(parsed.error);
    const req = parsed.data;

    const rows = await this.db.publicationWorkerRun.findMany({
      ...(req.terminalOnly === true
        ? { where: { status: { in: ["COMPLETED", "FAILED", "ABANDONED"] } } }
        : {}),
      orderBy: [{ startedAt: "desc" }, { cycleId: "desc" }],
      take: req.limit,
    });
    return rows.map(rowToRecord);
  }

  // — Internals —

  /**
   * One compare-and-set terminal transition, with idempotent identical replay.
   *
   * The guarded update runs first. Only if it matches nothing do we read the row
   * back to decide whether this is a benign replay or a genuine conflict — so the
   * common path is a single statement and the diagnostic path costs one extra read.
   */
  private async finalize(
    cycleId: string,
    data: {
      status: string;
      workerOutcome: string | null;
      exitCode: number;
      issueCodes: string;
      completedAt: Date;
      runsAttempted?: number;
      itemsClaimed?: number;
      stoppedForNoWork?: boolean;
      shutdownRequested?: boolean;
      expiredClaimsExamined?: number;
      expiredClaimsRecovered?: number;
      expiredClaimsSkipped?: number;
    },
  ): Promise<RunRecord> {
    let updated: { count: number };
    try {
      updated = await this.db.publicationWorkerRun.updateMany({
        where: { cycleId, status: "STARTED" },
        data,
      });
    } catch (error) {
      throw new WorkerRunPersistenceFailureError("finalize", error);
    }

    if (updated.count === 1) {
      const row = await this.db.publicationWorkerRun.findUnique({ where: { cycleId } });
      if (row === null) throw new WorkerRunNotFoundError(cycleId);
      return rowToRecord(row);
    }

    const existing = await this.db.publicationWorkerRun.findUnique({ where: { cycleId } });
    if (existing === null) throw new WorkerRunNotFoundError(cycleId);
    if (!isTerminalWorkerRunStatus(existing.status)) {
      // Not terminal and not STARTED is unreachable with four states, but a future
      // state must not be silently absorbed as a conflict.
      throw new WorkerRunTerminalConflictError(cycleId, existing.status);
    }
    if (this.describesSameRun(existing, data)) return rowToRecord(existing);
    throw new WorkerRunTerminalConflictError(cycleId, existing.status);
  }

  /**
   * Whether a stored terminal row and an incoming finalisation describe the same
   * run.
   *
   * Every authoritative field is compared, including the completion instant: two
   * finalisations that agree on the outcome but disagree on when it happened are
   * two different runs of history, not a replay.
   */
  private describesSameRun(
    existing: RunRow,
    data: {
      status: string;
      workerOutcome: string | null;
      exitCode: number;
      issueCodes: string;
      completedAt: Date;
      runsAttempted?: number;
      itemsClaimed?: number;
      stoppedForNoWork?: boolean;
      shutdownRequested?: boolean;
      expiredClaimsExamined?: number;
      expiredClaimsRecovered?: number;
      expiredClaimsSkipped?: number;
    },
  ): boolean {
    const same = <T>(stored: T, incoming: T | undefined): boolean =>
      incoming === undefined || stored === incoming;
    return (
      existing.status === data.status &&
      existing.workerOutcome === data.workerOutcome &&
      existing.exitCode === data.exitCode &&
      existing.issueCodes === data.issueCodes &&
      existing.completedAt !== null &&
      existing.completedAt.getTime() === data.completedAt.getTime() &&
      same(existing.runsAttempted, data.runsAttempted) &&
      same(existing.itemsClaimed, data.itemsClaimed) &&
      same(existing.stoppedForNoWork, data.stoppedForNoWork) &&
      same(existing.shutdownRequested, data.shutdownRequested) &&
      same(existing.expiredClaimsExamined, data.expiredClaimsExamined) &&
      same(existing.expiredClaimsRecovered, data.expiredClaimsRecovered) &&
      same(existing.expiredClaimsSkipped, data.expiredClaimsSkipped)
    );
  }
}
