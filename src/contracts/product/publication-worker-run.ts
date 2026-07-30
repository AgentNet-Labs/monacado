/**
 * Durable worker-run status and operational health contracts (Phase 0E.7.3).
 *
 * A `PublicationWorkerRun` is **operational evidence**, not an authority. It
 * answers "did the command run, did it finish, and what bounded outcome did it
 * report" — nothing more. Publication, outbox, submission-attempt, receipt, and
 * remediation records remain the sole authorities for what happened to the work
 * itself, and nothing here is ever read back to decide domain state.
 *
 * Two properties shape every schema below:
 *
 *   1. **Codes and counts only.** There is no field for a payload, receipt body,
 *      credential, endpoint, hash, token, environment value, raw cause, or stack
 *      trace — and no arbitrary metadata object, so there is nowhere for one to
 *      appear later. Issue codes must already satisfy the shared safe-code shape;
 *      anything else is refused rather than truncated, because an unrecognised
 *      string is exactly where a driver message would arrive.
 *
 *   2. **Every instant is explicit.** No schema or function here reads a clock.
 *      Health is assessed "as of" a supplied moment, which is what makes the
 *      classification deterministic and testable.
 *
 * Health assessment is a **pure function** of a bounded set of records and two
 * thresholds. It performs no query, so the policy can be exercised exhaustively
 * without a database.
 */

import { z } from "zod";
import { ERROR_CODE_RE, MAX_ERROR_CODE_LENGTH } from "./safe-error-metadata";
import {
  MAX_CYCLE_RUNS,
  MIN_CYCLE_RUNS,
  WorkerCycleOutcome,
} from "./publication-worker-cycle";

// — Identity —

/**
 * The command's correlation id, shared with its monitoring output. Bounded and
 * restricted to characters that cannot smuggle structure into a stored value or
 * an emitted line.
 */
export const WorkerRunCycleId = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/, "cycleId must be a short opaque correlation id");
export type WorkerRunCycleId = z.infer<typeof WorkerRunCycleId>;

// — Lifecycle status —

/**
 * Four states, and no more.
 *
 *   STARTED   — the row exists and the bounded cycle is about to run. The only
 *               non-terminal state.
 *   COMPLETED — the command produced a coherent cycle result.
 *   FAILED    — the cycle reported FAILED, threw, or the command failed after the
 *               row was created.
 *   ABANDONED — an operator explicitly reconciled a run that never reported back.
 *
 * ABANDONED exists because process death cannot be observed: a killed command
 * leaves a STARTED row forever, and inventing a timeout inside the command could
 * not cover the case where the command is the thing that died. Reconciling it is a
 * separate, explicit, operator-driven decision.
 */
export const WORKER_RUN_STATUSES = ["STARTED", "COMPLETED", "FAILED", "ABANDONED"] as const;
export const WorkerRunStatus = z.enum(WORKER_RUN_STATUSES);
export type WorkerRunStatus = z.infer<typeof WorkerRunStatus>;

/** The three states from which no transition is permitted. */
export const TERMINAL_WORKER_RUN_STATUSES = ["COMPLETED", "FAILED", "ABANDONED"] as const;

export function isTerminalWorkerRunStatus(status: string): boolean {
  return (TERMINAL_WORKER_RUN_STATUSES as readonly string[]).includes(status);
}

// — Issue codes —

/** Cap on stored codes. A command cannot accumulate an unbounded list. */
export const MAX_WORKER_RUN_ISSUE_CODES = 32;

/** One bounded, machine-safe code. Shape alone excludes prose, URLs, and JSON. */
export const WorkerRunIssueCode = z
  .string()
  .max(MAX_ERROR_CODE_LENGTH)
  .regex(ERROR_CODE_RE, "issue codes must be SCREAMING_SNAKE_CASE");
export type WorkerRunIssueCode = z.infer<typeof WorkerRunIssueCode>;

export const WorkerRunIssueCodes = z.array(WorkerRunIssueCode).max(MAX_WORKER_RUN_ISSUE_CODES);

/**
 * Deduplicate and sort a validated code list.
 *
 * Sorted rather than first-seen because the stored form is compared verbatim when
 * an identical terminal replay is checked for idempotency: two invocations that
 * observed the same issues in a different order describe the same run, and must
 * not be treated as a conflict.
 */
export function normalizeWorkerRunIssueCodes(codes: readonly string[]): string[] {
  return Array.from(new Set(codes)).sort();
}

/**
 * Codes this phase can actually produce. Kept as a documented closed list — not a
 * validation gate, because a genuine future code should not require a schema
 * change to be recorded, and the shape rule already bounds what may be stored.
 */
export const KNOWN_WORKER_RUN_ISSUE_CODES = [
  "MONITORING_HOOK_FAILURE",
  "RUN_STATUS_PERSISTENCE_FAILURE",
  "CLEANUP_FAILURE",
  "WORKER_RUN_STALE",
] as const;

// — Lifecycle inputs —

/** Bounded process exit code, matching the entry point's documented policy. */
export const WorkerRunExitCode = z.int().min(0).max(255);

export const StartPublicationWorkerRunInput = z.strictObject({
  cycleId: WorkerRunCycleId,
  startedAt: z.iso.datetime(),
  maximumRuns: z.int().min(MIN_CYCLE_RUNS).max(MAX_CYCLE_RUNS),
});
export type StartPublicationWorkerRunInput = z.infer<typeof StartPublicationWorkerRunInput>;

/**
 * The full bounded summary of a finished cycle.
 *
 * `status` is derived, never supplied: a caller cannot record a FAILED outcome as
 * COMPLETED, or vice versa, because there is no field in which to disagree.
 */
export const CompletePublicationWorkerRunInput = z.strictObject({
  cycleId: WorkerRunCycleId,
  completedAt: z.iso.datetime(),
  outcome: WorkerCycleOutcome,
  exitCode: WorkerRunExitCode,
  runsAttempted: z.int().min(0).max(MAX_CYCLE_RUNS),
  itemsClaimed: z.int().min(0).max(MAX_CYCLE_RUNS),
  stoppedForNoWork: z.boolean(),
  shutdownRequested: z.boolean(),
  expiredClaimsExamined: z.int().min(0),
  expiredClaimsRecovered: z.int().min(0),
  expiredClaimsSkipped: z.int().min(0),
  issueCodes: WorkerRunIssueCodes,
});
export type CompletePublicationWorkerRunInput = z.infer<typeof CompletePublicationWorkerRunInput>;

/**
 * The command failed after the row was created but before a cycle result existed.
 *
 * At least one issue code is required: a failure with nothing to say about itself
 * would leave an operator with a FAILED row and no lead at all.
 */
export const FailPublicationWorkerRunInput = z.strictObject({
  cycleId: WorkerRunCycleId,
  completedAt: z.iso.datetime(),
  exitCode: WorkerRunExitCode,
  issueCodes: z.array(WorkerRunIssueCode).min(1).max(MAX_WORKER_RUN_ISSUE_CODES),
});
export type FailPublicationWorkerRunInput = z.infer<typeof FailPublicationWorkerRunInput>;

/** Bounds on one reconciliation sweep. */
export const MIN_ABANDON_LIMIT = 1;
export const MAX_ABANDON_LIMIT = 1_000;

/**
 * One bounded stale-run sweep.
 *
 * `startedBefore` is required and has no default: what counts as abandoned depends
 * on how long the operator's longest legitimate command can run, which this
 * contract cannot know. Guessing would risk marking a live run abandoned.
 */
export const AbandonStalePublicationWorkerRunsInput = z.strictObject({
  startedBefore: z.iso.datetime(),
  abandonedAt: z.iso.datetime(),
  limit: z.int().min(MIN_ABANDON_LIMIT).max(MAX_ABANDON_LIMIT),
});
export type AbandonStalePublicationWorkerRunsInput = z.infer<
  typeof AbandonStalePublicationWorkerRunsInput
>;

export const AbandonStalePublicationWorkerRunsResult = z.strictObject({
  examined: z.int().min(0),
  abandonedCount: z.int().min(0),
  skippedCount: z.int().min(0),
});
export type AbandonStalePublicationWorkerRunsResult = z.infer<
  typeof AbandonStalePublicationWorkerRunsResult
>;

// — Safe projection —

/**
 * What a caller outside the service layer may see.
 *
 * The surrogate row id is deliberately absent: it is a storage detail with no
 * operational meaning, and `cycleId` already identifies a run everywhere else —
 * in the monitoring output, in the durable row, and in an operator's terminal.
 */
export const PublicationWorkerRunRecord = z.strictObject({
  cycleId: WorkerRunCycleId,
  status: WorkerRunStatus,
  outcome: WorkerCycleOutcome.nullable(),
  exitCode: WorkerRunExitCode.nullable(),
  maximumRuns: z.int().min(MIN_CYCLE_RUNS).max(MAX_CYCLE_RUNS),
  runsAttempted: z.int().min(0),
  itemsClaimed: z.int().min(0),
  stoppedForNoWork: z.boolean(),
  shutdownRequested: z.boolean(),
  expiredClaimsExamined: z.int().min(0),
  expiredClaimsRecovered: z.int().min(0),
  expiredClaimsSkipped: z.int().min(0),
  issueCodes: WorkerRunIssueCodes,
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
});
export type PublicationWorkerRunRecord = z.infer<typeof PublicationWorkerRunRecord>;

/** Bounds on a recent-history read. There is no unbounded scan. */
export const MIN_RECENT_RUN_LIMIT = 1;
export const MAX_RECENT_RUN_LIMIT = 100;
export const RecentWorkerRunLimit = z.int().min(MIN_RECENT_RUN_LIMIT).max(MAX_RECENT_RUN_LIMIT);

export const ListRecentPublicationWorkerRunsInput = z.strictObject({
  limit: RecentWorkerRunLimit,
  /** When true, only terminal rows are returned. */
  terminalOnly: z.boolean().optional(),
});
export type ListRecentPublicationWorkerRunsInput = z.infer<
  typeof ListRecentPublicationWorkerRunsInput
>;

// — Health —

/**
 * Five assessments. This is **publication-worker operational health only** — it
 * says nothing about database availability, Registrar reachability, Resolver
 * health, checkout, or Monacado as a whole. Worker history cannot support those
 * claims, and a health value that implied them would be actively misleading.
 */
export const WORKER_HEALTH_ASSESSMENTS = [
  "NO_HISTORY",
  "HEALTHY",
  "DEGRADED",
  "STALE",
  "FAILED",
] as const;
export const WorkerHealthAssessment = z.enum(WORKER_HEALTH_ASSESSMENTS);
export type WorkerHealthAssessment = z.infer<typeof WorkerHealthAssessment>;

/** Why the assessment came out as it did. A closed, bounded set. */
export const WORKER_HEALTH_REASON_CODES = [
  "NO_TERMINAL_RUNS",
  "LATEST_RUN_FAILED",
  "LATEST_RUN_ABANDONED",
  "CONSECUTIVE_FAILURES",
  "LATEST_RUN_STALE",
  "LATEST_RUN_HAS_ISSUES",
  "RECENT_FAILURES_PRESENT",
  "REPEATED_RUN_LIMIT_REACHED",
  "LATEST_RUN_COHERENT",
] as const;
export const WorkerHealthReasonCode = z.enum(WORKER_HEALTH_REASON_CODES);
export type WorkerHealthReasonCode = z.infer<typeof WorkerHealthReasonCode>;

/** Bounds on the freshness window an operator may ask about. */
export const MIN_HEALTH_FRESHNESS_SECONDS = 1;
export const MAX_HEALTH_FRESHNESS_SECONDS = 604_800; // 7 days

/** Bounds on how many consecutive failures constitute a failing worker. */
export const MIN_FAILURE_STREAK = 1;
export const MAX_FAILURE_STREAK = 10;
export const DEFAULT_FAILURE_STREAK = 2;

/**
 * Everything the pure assessment needs.
 *
 * `runs` is supplied by the caller, newest terminal instant first, so the policy
 * itself touches no database and can be tested exhaustively.
 */
export const AssessPublicationWorkerHealthInput = z.strictObject({
  assessedAt: z.iso.datetime(),
  freshnessSeconds: z
    .int()
    .min(MIN_HEALTH_FRESHNESS_SECONDS)
    .max(MAX_HEALTH_FRESHNESS_SECONDS),
  failureStreakThreshold: z
    .int()
    .min(MIN_FAILURE_STREAK)
    .max(MAX_FAILURE_STREAK)
    .optional(),
  runs: z.array(PublicationWorkerRunRecord).max(MAX_RECENT_RUN_LIMIT),
});
export type AssessPublicationWorkerHealthInput = z.infer<
  typeof AssessPublicationWorkerHealthInput
>;

export const PublicationWorkerHealth = z.strictObject({
  assessment: WorkerHealthAssessment,
  assessedAt: z.iso.datetime(),
  freshnessSeconds: z.int().min(MIN_HEALTH_FRESHNESS_SECONDS),
  /** The terminal instant of the most recent terminal run, if any. */
  mostRecentRunAt: z.iso.datetime().optional(),
  mostRecentCycleId: WorkerRunCycleId.optional(),
  mostRecentStatus: WorkerRunStatus.optional(),
  mostRecentOutcome: WorkerCycleOutcome.optional(),
  /** Seconds between that instant and `assessedAt`. Never negative. */
  ageSeconds: z.int().min(0).optional(),
  reasonCodes: z.array(WorkerHealthReasonCode).max(WORKER_HEALTH_REASON_CODES.length),
  counts: z.strictObject({
    considered: z.int().min(0),
    completed: z.int().min(0),
    failed: z.int().min(0),
    abandoned: z.int().min(0),
    withIssues: z.int().min(0),
  }),
  /**
   * A standing disclaimer, carried in the result so a consumer cannot mistake
   * this for a system-wide health signal.
   */
  scope: z.literal("PUBLICATION_WORKER_ONLY"),
});
export type PublicationWorkerHealth = z.infer<typeof PublicationWorkerHealth>;

/** Outcomes that represent a command which did its job. */
const COHERENT_OUTCOMES: readonly string[] = [
  "COMPLETED",
  "NO_WORK",
  "RUN_LIMIT_REACHED",
  "SHUTDOWN_REQUESTED",
  "DISABLED",
];

/**
 * Classify publication-worker operational health.
 *
 * **Precedence, applied in exactly this order:**
 *
 *   NO_HISTORY > FAILED > STALE > DEGRADED > HEALTHY
 *
 * `FAILED` outranks `STALE` deliberately: a worker that failed and then stopped
 * running is failing, and reporting "stale" would send an operator to look at
 * scheduling when the last thing it did was break. `STALE` outranks `DEGRADED`
 * because a run old enough to be out of window tells you nothing current about
 * degradation — the freshness problem is the one to fix first.
 *
 * Only **terminal** runs are classified. A STARTED row is evidence that something
 * is in flight, not evidence about health: it may be a healthy command running
 * right now, and calling that unhealthy would make every invocation briefly look
 * broken. A command that died leaves a STARTED row which becomes ABANDONED through
 * explicit reconciliation, and *then* counts as a failure.
 *
 * Throws on incoherent input — see the caller-facing error module. In particular a
 * run whose terminal instant is **after** `assessedAt` is refused rather than
 * clamped: assessing health as of a moment before a run finished is not a
 * conservative reading of the data, it is a contradiction, and silently treating
 * it as age zero would hide a clock or ordering bug.
 */
export function assessPublicationWorkerHealth(
  input: AssessPublicationWorkerHealthInput,
): PublicationWorkerHealth {
  const assessedMs = Date.parse(input.assessedAt);
  const threshold = input.failureStreakThreshold ?? DEFAULT_FAILURE_STREAK;

  // Terminal runs only, newest terminal instant first. Sorted here rather than
  // trusted, so the policy does not depend on the caller's ordering.
  const terminal = input.runs
    .filter((run) => isTerminalWorkerRunStatus(run.status) && run.completedAt !== null)
    .sort((a, b) => {
      const delta = Date.parse(b.completedAt!) - Date.parse(a.completedAt!);
      return delta !== 0 ? delta : b.cycleId.localeCompare(a.cycleId);
    });

  const counts = {
    considered: terminal.length,
    completed: terminal.filter((r) => r.status === "COMPLETED").length,
    failed: terminal.filter((r) => r.status === "FAILED").length,
    abandoned: terminal.filter((r) => r.status === "ABANDONED").length,
    withIssues: terminal.filter((r) => r.issueCodes.length > 0).length,
  };

  const base = {
    assessedAt: input.assessedAt,
    freshnessSeconds: input.freshnessSeconds,
    counts,
    scope: "PUBLICATION_WORKER_ONLY" as const,
  };

  // — NO_HISTORY —
  if (terminal.length === 0) {
    return PublicationWorkerHealth.parse({
      ...base,
      assessment: "NO_HISTORY",
      reasonCodes: ["NO_TERMINAL_RUNS"],
    });
  }

  const latest = terminal[0]!;
  const latestMs = Date.parse(latest.completedAt!);
  if (latestMs > assessedMs) {
    throw new RangeError("a worker run completed after the assessment instant");
  }
  const ageSeconds = Math.floor((assessedMs - latestMs) / 1_000);

  const identity = {
    mostRecentRunAt: latest.completedAt!,
    mostRecentCycleId: latest.cycleId,
    mostRecentStatus: latest.status,
    ...(latest.outcome !== null ? { mostRecentOutcome: latest.outcome } : {}),
    ageSeconds,
  };

  /** Consecutive failing runs from the newest backwards. */
  let streak = 0;
  for (const run of terminal) {
    if (run.status === "FAILED" || run.status === "ABANDONED") streak += 1;
    else break;
  }

  // — FAILED —
  const reasons: WorkerHealthReasonCode[] = [];
  if (latest.status === "FAILED") reasons.push("LATEST_RUN_FAILED");
  if (latest.status === "ABANDONED") reasons.push("LATEST_RUN_ABANDONED");
  if (streak >= threshold) reasons.push("CONSECUTIVE_FAILURES");
  if (reasons.length > 0) {
    return PublicationWorkerHealth.parse({
      ...base,
      ...identity,
      assessment: "FAILED",
      reasonCodes: reasons,
    });
  }

  // — STALE —
  if (ageSeconds > input.freshnessSeconds) {
    return PublicationWorkerHealth.parse({
      ...base,
      ...identity,
      assessment: "STALE",
      reasonCodes: ["LATEST_RUN_STALE"],
    });
  }

  // — DEGRADED —
  //
  // Any operational issue on the latest run, any failure at all in the window
  // below the streak threshold, or a run of consecutive RUN_LIMIT_REACHED
  // outcomes, which means work is arriving faster than one bounded cycle drains
  // it. One RUN_LIMIT_REACHED is ordinary; two in a row is backlog pressure.
  const degraded: WorkerHealthReasonCode[] = [];
  if (latest.issueCodes.length > 0) degraded.push("LATEST_RUN_HAS_ISSUES");
  if (counts.failed + counts.abandoned > 0) degraded.push("RECENT_FAILURES_PRESENT");
  if (
    terminal.length >= 2 &&
    terminal[0]!.outcome === "RUN_LIMIT_REACHED" &&
    terminal[1]!.outcome === "RUN_LIMIT_REACHED"
  ) {
    degraded.push("REPEATED_RUN_LIMIT_REACHED");
  }
  if (degraded.length > 0) {
    return PublicationWorkerHealth.parse({
      ...base,
      ...identity,
      assessment: "DEGRADED",
      reasonCodes: degraded,
    });
  }

  // — HEALTHY —
  //
  // A coherent, recent, issue-free terminal run. An outcome outside the coherent
  // set on a COMPLETED row would mean the persistence layer and the cycle
  // vocabulary had diverged, so it is reported as degraded rather than assumed
  // benign.
  if (latest.outcome === null || !COHERENT_OUTCOMES.includes(latest.outcome)) {
    return PublicationWorkerHealth.parse({
      ...base,
      ...identity,
      assessment: "DEGRADED",
      reasonCodes: ["LATEST_RUN_HAS_ISSUES"],
    });
  }

  return PublicationWorkerHealth.parse({
    ...base,
    ...identity,
    assessment: "HEALTHY",
    reasonCodes: ["LATEST_RUN_COHERENT"],
  });
}
