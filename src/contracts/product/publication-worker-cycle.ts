/**
 * Bounded publication worker-cycle contract (Phase 0E.7.1).
 *
 * One cycle invokes the Phase 0E.6.3 single-run orchestration a **bounded**
 * number of times and returns. It is not a daemon: there is no sleep, no timer,
 * no polling interval, no scheduler, and no self-rescheduling. Deciding to run
 * another cycle stays outside.
 *
 * The bound is the whole point. An unbounded loop over a queue is indistinguish-
 * able from a daemon, and a daemon needs shutdown semantics, backoff, and
 * supervision that this phase deliberately does not have. A cycle that always
 * terminates can be invoked from a test, a one-shot process, or a future
 * scheduler without any of them inheriting a hidden loop.
 *
 * Every instant and every identifier comes from an injected provider. Nothing
 * here reads a clock or generates randomness.
 */

import { z } from "zod";
import { PublicationRunOutcome, PUBLICATION_RUN_OUTCOMES } from "./publication-run";
import { LeaseDurationSeconds, MAX_RECOVERY_LIMIT, MIN_RECOVERY_LIMIT } from "./product-publication-outbox";
import { SafeErrorCode } from "./safe-error-metadata";

/** Hard bounds on one cycle. A cap, not a suggestion. */
export const MIN_CYCLE_RUNS = 1;
export const MAX_CYCLE_RUNS = 100;

/**
 * How a cycle ended.
 *
 *   DISABLED           — Registrar integration is off. No queue access at all.
 *   NO_WORK            — the FIRST run found nothing. Distinguished from
 *                        COMPLETED because "nothing was due" and "we drained
 *                        what was due" call for different operator attention.
 *   COMPLETED          — work was processed and then the queue ran dry.
 *   RUN_LIMIT_REACHED  — the bound stopped us, and work may well remain.
 *   SHUTDOWN_REQUESTED — the injected signal asked us to stop.
 *   FAILED             — a cycle-level fault ended it early.
 */
export const WORKER_CYCLE_OUTCOMES = [
  "DISABLED",
  "NO_WORK",
  "COMPLETED",
  "RUN_LIMIT_REACHED",
  "SHUTDOWN_REQUESTED",
  "FAILED",
] as const;
export const WorkerCycleOutcome = z.enum(WORKER_CYCLE_OUTCOMES);
export type WorkerCycleOutcome = z.infer<typeof WorkerCycleOutcome>;

/** Optional one-time expired-claim recovery at cycle start. */
export const CycleRecoverySettings = z.strictObject({
  limit: z.int().min(MIN_RECOVERY_LIMIT).max(MAX_RECOVERY_LIMIT),
  /** When recovered items become eligible again. Explicit; never computed. */
  availableAt: z.iso.datetime().optional(),
});
export type CycleRecoverySettings = z.infer<typeof CycleRecoverySettings>;

/**
 * Input to one cycle. Providers and hooks are injected separately as functions,
 * so this schema stays a pure data contract that can be validated.
 */
export const WorkerCycleInput = z.strictObject({
  cycleStartedAt: z.iso.datetime(),
  maximumRuns: z.int().min(MIN_CYCLE_RUNS).max(MAX_CYCLE_RUNS),
  leaseDurationSeconds: LeaseDurationSeconds,
  /** Optional caller-supplied correlation id. Opaque and bounded. */
  cycleId: z.string().min(1).max(191).optional(),
  /** Present enables one bounded recovery sweep; absent disables it entirely. */
  recovery: CycleRecoverySettings.optional(),
});
export type WorkerCycleInput = z.infer<typeof WorkerCycleInput>;

/** Safe counts of expired-claim recovery. Never the recovered rows themselves. */
export const CycleRecoveryCounts = z.strictObject({
  examined: z.int().min(0),
  recoveredCount: z.int().min(0),
  skippedCount: z.int().min(0),
});
export type CycleRecoveryCounts = z.infer<typeof CycleRecoveryCounts>;

/**
 * Counts by orchestration outcome. A closed record with one key per known
 * outcome — not a growable map, so a cycle cannot accumulate unbounded keys and
 * an unrecognised outcome cannot be silently absorbed.
 */
export const RunOutcomeCounts = z.strictObject({
  DISABLED: z.int().min(0),
  NO_ELIGIBLE_WORK: z.int().min(0),
  SENT: z.int().min(0),
  REMOTE_REJECTION: z.int().min(0),
  RETRY_SCHEDULED: z.int().min(0),
  DEAD_LETTERED: z.int().min(0),
  AMBIGUOUS_DELIVERY: z.int().min(0),
  TERMINAL_FAILURE: z.int().min(0),
});
export type RunOutcomeCounts = z.infer<typeof RunOutcomeCounts>;

/**
 * What one cycle did.
 *
 * Counts, classifications, timestamps, and bounded issue codes. Never a payload,
 * credential, endpoint, hash, token, or receipt body.
 */
export const WorkerCycleResult = z.strictObject({
  outcome: WorkerCycleOutcome,
  cycleId: z.string().min(1).max(191).optional(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime(),
  /** Orchestration invocations actually made. */
  runsAttempted: z.int().min(0),
  /** Runs that claimed an item — i.e. every run except NO_ELIGIBLE_WORK. */
  itemsClaimed: z.int().min(0),
  outcomeCounts: RunOutcomeCounts,
  shutdownRequested: z.boolean(),
  /** True when the cycle ended because the queue was drained. */
  stoppedForNoWork: z.boolean(),
  recovery: CycleRecoveryCounts.optional(),
  /** Bounded, safe codes only. Capped so a long cycle cannot grow without limit. */
  issues: z.array(SafeErrorCode).max(MAX_CYCLE_RUNS + 2),
});
export type WorkerCycleResult = z.infer<typeof WorkerCycleResult>;

/** Zeroed counters for every known outcome. */
export function emptyOutcomeCounts(): RunOutcomeCounts {
  return {
    DISABLED: 0,
    NO_ELIGIBLE_WORK: 0,
    SENT: 0,
    REMOTE_REJECTION: 0,
    RETRY_SCHEDULED: 0,
    DEAD_LETTERED: 0,
    AMBIGUOUS_DELIVERY: 0,
    TERMINAL_FAILURE: 0,
  };
}

/**
 * Compile-time proof the closed record above covers every orchestration outcome.
 * Adding an outcome without a counter becomes a type error rather than a silently
 * dropped classification.
 */
const _outcomeCoverage: Record<(typeof PUBLICATION_RUN_OUTCOMES)[number], number> =
  emptyOutcomeCounts();
void _outcomeCoverage;

// — Injected collaborators —

/**
 * Cooperative shutdown. Polled, never pushed: a boolean the cycle asks about at
 * defined points is far easier to reason about than a callback that can fire
 * mid-transport.
 */
export interface ShutdownSignal {
  isShutdownRequested(): boolean;
}

/** Injected clock. There is no fallback to `Date.now()`. */
export interface TimeProvider {
  now(): Date;
}

/** Injected attempt-identity source. No ULID/UUID generation lives in the cycle. */
export interface SubmissionAttemptIdProvider {
  nextSubmissionAttemptId(): string;
}

/**
 * When a retryable, provably-undelivered failure occurs, the instant the item
 * becomes eligible again. Injected because it is a policy decision — there is no
 * backoff framework and no jitter anywhere in this phase.
 */
export interface RetryTimingProvider {
  nextRetryAvailableAt(context: { attemptedAt: Date; runIndex: number }): Date;
}

/**
 * Observability. Every field is already-safe operational data.
 *
 * Hooks are `void`-returning and synchronous by contract: a hook that could
 * return a promise would let a monitoring backend's latency stall a claim's
 * lease, and a hook that could reject mid-cycle would entangle observability
 * with correctness.
 */
export interface WorkerCycleMonitor {
  cycleStarted?(event: { cycleId?: string; startedAt: string; maximumRuns: number }): void;
  expiredClaimsRecovered?(event: { cycleId?: string; counts: CycleRecoveryCounts }): void;
  runStarted?(event: { cycleId?: string; runIndex: number; submissionAttemptId: string }): void;
  runCompleted?(event: {
    cycleId?: string;
    runIndex: number;
    submissionAttemptId: string;
    outcome: PublicationRunOutcome;
    outboxId?: string;
    publicationId?: string;
    durationMs: number;
  }): void;
  runFailed?(event: {
    cycleId?: string;
    runIndex: number;
    submissionAttemptId: string;
    issueCode: string;
  }): void;
  cycleCompleted?(event: {
    cycleId?: string;
    outcome: WorkerCycleOutcome;
    runsAttempted: number;
    itemsClaimed: number;
    completedAt: string;
  }): void;
}
