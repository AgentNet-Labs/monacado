/**
 * Single-run publication orchestration contract (Phase 0E.6.3).
 *
 * One invocation may claim and process **at most one** due publication outbox
 * item. There is no loop, no scheduler, and no automatic retry: a caller decides
 * whether to invoke again, because only a layer that can see attempt history can
 * decide that safely.
 *
 * The result is a bounded union. It carries identifiers and state names — enough
 * for an operator to act — and deliberately never carries the payload, a
 * credential, a lock token, a token hash, an integrity hash, a response body, a
 * raw network error, or a database detail.
 *
 * Every instant is supplied explicitly. Nothing here reads a clock.
 */

import { z } from "zod";
import { OutboxId, PublicationId, OutboxStatus } from "./product-publication";
import { SubmissionAttemptId, SubmissionAttemptStatus } from "./product-submission-attempt";
import { SafeErrorCode, SafeErrorSummary } from "./safe-error-metadata";
import { LeaseDurationSeconds } from "./product-publication-outbox";

/**
 * The eight ways one run can end.
 *
 *   DISABLED           — Registrar integration is off. No work was queried.
 *   NO_ELIGIBLE_WORK   — nothing was due. Not a fault.
 *   SENT               — the Registrar accepted. NOT yet registered: a receipt
 *                        is still required to make that authoritative.
 *   REMOTE_REJECTION   — the Registrar answered "no". The exchange worked.
 *   RETRY_SCHEDULED    — proven undelivered; the item is due again later.
 *   DEAD_LETTERED      — terminal remote/protocol failure; the item is parked.
 *   AMBIGUOUS_DELIVERY — may have been delivered. Nothing is resent or moved.
 *   TERMINAL_FAILURE   — a local fault (configuration, or a post-transport
 *                        persistence failure). The Registrar is not implicated.
 */
export const PUBLICATION_RUN_OUTCOMES = [
  "DISABLED",
  "NO_ELIGIBLE_WORK",
  "SENT",
  "REMOTE_REJECTION",
  "RETRY_SCHEDULED",
  "DEAD_LETTERED",
  "AMBIGUOUS_DELIVERY",
  "TERMINAL_FAILURE",
] as const;
export const PublicationRunOutcome = z.enum(PUBLICATION_RUN_OUTCOMES);
export type PublicationRunOutcome = z.infer<typeof PublicationRunOutcome>;

/**
 * Bounded, safe failure detail. Reuses the same safe-metadata contracts the
 * outbox persists, so a raw driver message or a response body cannot ride along.
 */
export const RunFailureDetail = z.strictObject({
  code: SafeErrorCode,
  summary: SafeErrorSummary,
});
export type RunFailureDetail = z.infer<typeof RunFailureDetail>;

/**
 * What one run did.
 *
 * Identifiers appear only once work was actually claimed, so a `DISABLED` or
 * `NO_ELIGIBLE_WORK` run reveals nothing about the queue's contents.
 */
export const PublicationRunResult = z.strictObject({
  outcome: PublicationRunOutcome,
  /** Present once an item was claimed. */
  outboxId: OutboxId.optional(),
  publicationId: PublicationId.optional(),
  /** Present once an attempt was prepared. */
  submissionAttemptId: SubmissionAttemptId.optional(),
  /** Terminal state of the attempt when this run finished. */
  attemptStatus: SubmissionAttemptStatus.optional(),
  /** Terminal state of the work item when this run finished. */
  outboxStatus: OutboxStatus.optional(),
  /** Whether the request may have reached the Registrar. */
  transmitted: z.boolean().optional(),
  /** Bounded status number only — never a body. */
  httpStatus: z.int().min(100).max(599).optional(),
  /** When RETRY_SCHEDULED, the explicit instant the item becomes due again. */
  retryAvailableAt: z.iso.datetime().optional(),
  failure: RunFailureDetail.optional(),
});
export type PublicationRunResult = z.infer<typeof PublicationRunResult>;

/**
 * Input to one run.
 *
 * `now`, `preparedAt`, and `dispatchedAt` are separate and all explicit. They
 * are not the same instant in reality — preparation precedes the network call,
 * which precedes the outcome write — and collapsing them into one clock read
 * would make the durable record claim a timeline that never happened.
 */
export const RunOnePublicationInput = z.strictObject({
  /** Eligibility instant and lease origin. */
  now: z.iso.datetime(),
  leaseDurationSeconds: LeaseDurationSeconds,
  /** Identity for the attempt this run may create. Supplied, never generated here. */
  submissionAttemptId: SubmissionAttemptId,
  preparedAt: z.iso.datetime(),
  dispatchedAt: z.iso.datetime(),
  /**
   * When a retryable, provably-undelivered failure occurs, the instant the item
   * becomes eligible again. Explicit — there is no backoff framework and no
   * jitter. Absent means the caller has no retry policy, and a retryable failure
   * is reported as TERMINAL_FAILURE rather than silently dropped.
   */
  retryAvailableAt: z.iso.datetime().optional(),
});
export type RunOnePublicationInput = z.infer<typeof RunOnePublicationInput>;
