/**
 * Bounded publication worker cycle (Phase 0E.7.1) — SERVER ONLY.
 *
 * `runProductPublicationWorkerCycle` invokes the Phase 0E.6.3 single-run
 * orchestration at most `maximumRuns` times, then returns.
 *
 * It is **not** a daemon. There is no sleep, no `setTimeout`/`setInterval`, no
 * polling after the queue drains, no self-rescheduling, and no recursion. The
 * loop is a plain bounded `for`, which is the entire safety property: a cycle
 * that always terminates can be called from a test, a one-shot process, or a
 * future scheduler without any of them inheriting a hidden loop.
 *
 * It owns no domain rules. Claiming, leases, attempt preparation, dispatch,
 * outcome persistence, and recovery all live in earlier phases and are called,
 * never reimplemented. This module never touches a domain table and never opens
 * a transaction — so no transaction can span the HTTP call or two runs.
 *
 * **Ambiguous work is never resent.** The orchestration leaves an ambiguous item
 * PROCESSING under its lease, so the next iteration simply claims a *different*
 * eligible item. The cycle does not retry, requeue, or revisit it.
 *
 * Nothing here reads a clock or generates an identifier; both come from injected
 * providers, so a test controls time exactly.
 */

import "../server-only";
import type { getPrisma } from "../db/client";
import { getPrisma as prisma } from "../db/client";
import {
  WorkerCycleInput,
  WorkerCycleResult,
  emptyOutcomeCounts,
  type CycleRecoveryCounts,
  type RetryTimingProvider,
  type ShutdownSignal,
  type SubmissionAttemptIdProvider,
  type TimeProvider,
  type WorkerCycleMonitor,
  type WorkerCycleOutcome,
  type WorkerCycleResult as CycleResult,
} from "../../contracts/product/publication-worker-cycle";
import type { PublicationRunOutcome } from "../../contracts/product/publication-run";
import type { RegistrarConfigurationLoad, EnvironmentSource } from "../registrar/registrar-runtime-config";
import type { RegistrarRegisterTransport } from "../../contracts/product/registrar-transport";
import { runOneProductPublication } from "./publication-run-service";
import { PublicationOutboxRepository } from "./publication-outbox-repository";
import {
  AttemptIdProviderFailureError,
  InvalidWorkerCycleInputError,
  TimeProviderFailureError,
} from "./worker-cycle-errors";

type Db = ReturnType<typeof getPrisma>;

export interface WorkerCycleDeps {
  configuration: RegistrarConfigurationLoad;
  secretSource: EnvironmentSource;
  time: TimeProvider;
  attemptIds: SubmissionAttemptIdProvider;
  retryTiming: RetryTimingProvider;
  shutdown: ShutdownSignal;
  monitor?: WorkerCycleMonitor;
  transportOverride?: RegistrarRegisterTransport;
  db?: Db;
}

/** A SafeErrorCode-shaped code (SCREAMING_SNAKE_CASE, bounded). */
const issueCode = (raw: unknown): string => {
  if (raw instanceof Error && "code" in raw) {
    const code = String((raw as { code?: unknown }).code);
    if (/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  }
  return "UNCLASSIFIED_RUN_FAILURE";
};

/** Read the injected clock, refusing anything that is not a usable instant. */
function readClock(time: TimeProvider): Date {
  let value: Date;
  try {
    value = time.now();
  } catch (error) {
    throw new TimeProviderFailureError(error);
  }
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TimeProviderFailureError();
  }
  return value;
}

/**
 * Invoke a monitoring hook without letting it affect correctness.
 *
 * A throwing hook is swallowed and reported as an issue code. **Documented
 * policy: a monitoring-hook failure never stops the cycle and never changes a
 * run's outcome.** The alternative — letting a logging backend abort a cycle
 * mid-flight — would make observability a source of publication failures, and a
 * hook firing after a transmitted request could not undo the send anyway.
 */
function notify(issues: string[], fn: (() => void) | undefined): void {
  if (fn === undefined) return;
  try {
    fn();
  } catch {
    if (!issues.includes("MONITORING_HOOK_FAILURE")) issues.push("MONITORING_HOOK_FAILURE");
  }
}

/**
 * Run one bounded cycle.
 *
 * Outcome precedence, applied in this order and documented in
 * PRODUCT_PUBLICATION_WORKER_CYCLE.md:
 *
 *   DISABLED > SHUTDOWN_REQUESTED > FAILED > NO_WORK > COMPLETED > RUN_LIMIT_REACHED
 *
 * Shutdown outranks FAILED because an operator who asked us to stop needs to know
 * we stopped, and a failing run is the ordinary reason a cycle ends early.
 */
export async function runProductPublicationWorkerCycle(
  input: unknown,
  deps: WorkerCycleDeps,
): Promise<CycleResult> {
  const parsed = WorkerCycleInput.safeParse(input);
  if (!parsed.success) {
    throw new InvalidWorkerCycleInputError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  const req = parsed.data;
  const issues: string[] = [];
  const counts = emptyOutcomeCounts();
  const idPart = req.cycleId !== undefined ? { cycleId: req.cycleId } : {};

  const finish = (
    outcome: WorkerCycleOutcome,
    state: {
      runsAttempted: number;
      itemsClaimed: number;
      shutdownRequested: boolean;
      stoppedForNoWork: boolean;
      completedAt: string;
      recovery?: CycleRecoveryCounts;
    },
  ): CycleResult => {
    notify(issues, deps.monitor?.cycleCompleted && (() =>
      deps.monitor?.cycleCompleted?.({
        ...idPart,
        outcome,
        runsAttempted: state.runsAttempted,
        itemsClaimed: state.itemsClaimed,
        completedAt: state.completedAt,
      })));
    return WorkerCycleResult.parse({
      outcome,
      ...idPart,
      startedAt: req.cycleStartedAt,
      completedAt: state.completedAt,
      runsAttempted: state.runsAttempted,
      itemsClaimed: state.itemsClaimed,
      outcomeCounts: counts,
      shutdownRequested: state.shutdownRequested,
      stoppedForNoWork: state.stoppedForNoWork,
      ...(state.recovery !== undefined ? { recovery: state.recovery } : {}),
      issues,
    });
  };

  // — 1. Disabled short-circuits before ANY database access or secret lookup —
  //
  // Not delegated to the orchestration: calling it would open a connection and
  // construct services for a cycle that can do nothing.
  if (deps.configuration.state === "DISABLED") {
    return finish("DISABLED", {
      runsAttempted: 0,
      itemsClaimed: 0,
      shutdownRequested: false,
      stoppedForNoWork: false,
      completedAt: req.cycleStartedAt,
    });
  }

  notify(issues, deps.monitor?.cycleStarted && (() =>
    deps.monitor?.cycleStarted?.({
      ...idPart,
      startedAt: req.cycleStartedAt,
      maximumRuns: req.maximumRuns,
    })));

  const db = deps.db ?? prisma();
  let recovery: CycleRecoveryCounts | undefined;

  // — 2. Optional recovery: ONCE, at cycle start, never inside the loop —
  //
  // Sweeping repeatedly would let one cycle reclaim items another worker had
  // legitimately just taken.
  if (req.recovery !== undefined) {
    try {
      const swept = await new PublicationOutboxRepository(db).recoverExpiredPublicationOutboxClaims({
        now: req.cycleStartedAt,
        limit: req.recovery.limit,
        ...(req.recovery.availableAt !== undefined ? { availableAt: req.recovery.availableAt } : {}),
      });
      // Counts only — never the recovered rows.
      recovery = {
        examined: swept.examined,
        recoveredCount: swept.recoveredCount,
        skippedCount: swept.skippedCount,
      };
      const counts_ = recovery;
      notify(issues, deps.monitor?.expiredClaimsRecovered && (() =>
        deps.monitor?.expiredClaimsRecovered?.({ ...idPart, counts: counts_ })));
    } catch (error) {
      // Recovery is an optimisation, not a precondition: failing to reclaim a
      // stale lease does not stop us processing work that is already eligible.
      const code = issueCode(error);
      if (!issues.includes(code)) issues.push(code);
    }
  }

  let runsAttempted = 0;
  let itemsClaimed = 0;
  let shutdownRequested = false;
  let stoppedForNoWork = false;
  let failed = false;

  // — 3-9. The bounded loop. No sleep, no polling, no recursion. —
  for (let runIndex = 0; runIndex < req.maximumRuns; runIndex += 1) {
    // Checked before the first run and before every subsequent one.
    if (deps.shutdown.isShutdownRequested()) {
      shutdownRequested = true;
      break;
    }

    // The attempt id is taken only once we are actually about to process, so a
    // cycle that finds no work does not burn identities.
    let submissionAttemptId: string;
    try {
      submissionAttemptId = deps.attemptIds.nextSubmissionAttemptId();
    } catch (error) {
      throw new AttemptIdProviderFailureError(error);
    }
    if (typeof submissionAttemptId !== "string" || submissionAttemptId.length === 0) {
      throw new AttemptIdProviderFailureError();
    }

    const startedAt = readClock(deps.time);
    notify(issues, deps.monitor?.runStarted && (() =>
      deps.monitor?.runStarted?.({ ...idPart, runIndex, submissionAttemptId })));

    let outcome: PublicationRunOutcome;
    let outboxId: string | undefined;
    let publicationId: string | undefined;

    try {
      const dispatchedAt = readClock(deps.time);
      const result = await runOneProductPublication(
        {
          now: startedAt.toISOString(),
          leaseDurationSeconds: req.leaseDurationSeconds,
          submissionAttemptId,
          preparedAt: startedAt.toISOString(),
          dispatchedAt: dispatchedAt.toISOString(),
          retryAvailableAt: deps.retryTiming
            .nextRetryAvailableAt({ attemptedAt: dispatchedAt, runIndex })
            .toISOString(),
        },
        {
          configuration: deps.configuration,
          secretSource: deps.secretSource,
          ...(deps.transportOverride !== undefined
            ? { transportOverride: deps.transportOverride }
            : {}),
          db,
        },
      );
      runsAttempted += 1;
      outcome = result.outcome;
      outboxId = result.outboxId;
      publicationId = result.publicationId;
    } catch (error) {
      // A provider fault is fatal and must not be absorbed as a run failure.
      if (error instanceof TimeProviderFailureError) throw error;

      runsAttempted += 1;
      failed = true;
      const code = issueCode(error);
      if (!issues.includes(code)) issues.push(code);
      const failedId = submissionAttemptId;
      const failedIndex = runIndex;
      notify(issues, deps.monitor?.runFailed && (() =>
        deps.monitor?.runFailed?.({
          ...idPart,
          runIndex: failedIndex,
          submissionAttemptId: failedId,
          issueCode: code,
        })));
      // Documented policy: a failed run STOPS the cycle. Continuing would claim
      // more work while a fault we have not diagnosed is still present, and a
      // post-transport persistence failure in particular means the durable record
      // no longer describes the outside world — the last thing to do then is take
      // on another item.
      break;
    }

    counts[outcome] += 1;
    if (outcome !== "NO_ELIGIBLE_WORK" && outcome !== "DISABLED") itemsClaimed += 1;

    const completedOutcome = outcome;
    const completedIndex = runIndex;
    const completedId = submissionAttemptId;
    const durationMs = Math.max(0, readClock(deps.time).getTime() - startedAt.getTime());
    notify(issues, deps.monitor?.runCompleted && (() =>
      deps.monitor?.runCompleted?.({
        ...idPart,
        runIndex: completedIndex,
        submissionAttemptId: completedId,
        outcome: completedOutcome,
        ...(outboxId !== undefined ? { outboxId } : {}),
        ...(publicationId !== undefined ? { publicationId } : {}),
        durationMs,
      })));

    // An empty queue ends the cycle. There is deliberately no re-poll: work that
    // arrives a moment later belongs to the next cycle, not this one.
    if (outcome === "NO_ELIGIBLE_WORK") {
      stoppedForNoWork = true;
      break;
    }
    // Configuration turning out disabled mid-cycle stops immediately.
    if (outcome === "DISABLED") break;

    // Checked again after the result, before committing to another run.
    if (deps.shutdown.isShutdownRequested()) {
      shutdownRequested = true;
      break;
    }
  }

  const completedAt = readClock(deps.time).toISOString();
  const tail = {
    runsAttempted,
    itemsClaimed,
    shutdownRequested,
    stoppedForNoWork,
    completedAt,
    ...(recovery !== undefined ? { recovery } : {}),
  };

  // Precedence as documented above.
  if (shutdownRequested) return finish("SHUTDOWN_REQUESTED", tail);
  if (failed) return finish("FAILED", tail);
  if (stoppedForNoWork) {
    return finish(runsAttempted <= 1 ? "NO_WORK" : "COMPLETED", tail);
  }
  if (runsAttempted >= req.maximumRuns) return finish("RUN_LIMIT_REACHED", tail);
  return finish("COMPLETED", tail);
}
