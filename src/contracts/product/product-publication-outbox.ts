/**
 * Publication-outbox processing contracts (Phase 0E.3).
 *
 * Worker-facing state transitions and concurrency control for prepared Product
 * publications. This phase is OFFLINE: it decides WHICH item a worker may work
 * on and records WHAT happened, but performs no submission itself.
 *
 * There is deliberately no worker loop, no scheduled polling, no lease expiry or
 * lock stealing, no network call, no Registrar receipt, no registration state,
 * no reconciliation, and no payload disposal. `COMPLETED` means one outbox
 * attempt finished — it asserts nothing about Registrar registration.
 *
 * Zod is the single authored source of truth; types are inferred. No passthrough,
 * `any`, or arbitrary metadata bags.
 */

import { z } from "zod";
import {
  LockToken,
  OutboxId,
  OutboxStatus,
  ProductPublicationOutbox,
  type OutboxStatus as OutboxStatusT,
} from "./product-publication";
import { SafeErrorCode, SafeErrorSummary } from "./safe-error-metadata";

// — Transition matrix —

/**
 * Permitted outbox transitions. Everything absent here is rejected.
 *
 * | From        | Allowed to                          |
 * | ----------- | ----------------------------------- |
 * | PENDING     | PROCESSING, CANCELLED               |
 * | RETRYABLE   | PROCESSING, CANCELLED               |
 * | PROCESSING  | RETRYABLE, COMPLETED, DEAD_LETTER   |
 * | COMPLETED   | *(terminal)*                        |
 * | DEAD_LETTER | *(terminal)*                        |
 * | CANCELLED   | *(terminal)*                        |
 *
 * Note PROCESSING → CANCELLED is NOT permitted: a claimed item must first be
 * resolved by its owning worker (retry, complete, or dead-letter).
 */
export const OUTBOX_TRANSITIONS: Readonly<Record<OutboxStatusT, readonly OutboxStatusT[]>> = {
  PENDING: ["PROCESSING", "CANCELLED"],
  RETRYABLE: ["PROCESSING", "CANCELLED"],
  PROCESSING: ["RETRYABLE", "COMPLETED", "DEAD_LETTER"],
  COMPLETED: [],
  DEAD_LETTER: [],
  CANCELLED: [],
};

/** States from which no transition is permitted. */
export const TERMINAL_OUTBOX_STATUSES: readonly OutboxStatusT[] = [
  "COMPLETED",
  "DEAD_LETTER",
  "CANCELLED",
];

/** States a due item may be claimed from. */
export const CLAIMABLE_OUTBOX_STATUSES: readonly OutboxStatusT[] = ["PENDING", "RETRYABLE"];

/** True if `to` is a permitted transition from `from`. */
export function isAllowedOutboxTransition(from: OutboxStatusT, to: OutboxStatusT): boolean {
  return OUTBOX_TRANSITIONS[from].includes(to);
}

/** True if the state permits no outgoing transition. */
export function isTerminalOutboxStatus(status: OutboxStatusT): boolean {
  return TERMINAL_OUTBOX_STATUSES.includes(status);
}

// — Claim —

/**
 * Input to claim the next eligible item. `now` is supplied explicitly at the
 * service boundary — no clock is read inside the repository, matching the
 * discipline used throughout the Product phases.
 */
export const ClaimOutboxInput = z.strictObject({
  /** Items are eligible when `availableAt <= now`. Also recorded as `lockedAt`. */
  now: z.iso.datetime(),
});
export type ClaimOutboxInput = z.infer<typeof ClaimOutboxInput>;

/**
 * The result of a successful claim: the validated PROCESSING record plus the
 * lock token the worker must present to resolve it. The token is also on the
 * record; it is surfaced here so callers need not reach into the record.
 */
export const PublicationOutboxClaim = z.strictObject({
  outbox: ProductPublicationOutbox,
  lockToken: LockToken,
});
export type PublicationOutboxClaim = z.infer<typeof PublicationOutboxClaim>;

// — Resolution inputs —

/** Common ownership proof: which item, and which claim. */
const OwnershipFields = {
  outboxId: OutboxId,
  lockToken: LockToken,
} as const;

/** PROCESSING → RETRYABLE. Reschedules the item and records why. */
export const RetryOutboxInput = z.strictObject({
  ...OwnershipFields,
  /** Explicit next eligibility time — never computed from a clock or a backoff. */
  availableAt: z.iso.datetime(),
  errorCode: SafeErrorCode,
  errorSummary: SafeErrorSummary,
});
export type RetryOutboxInput = z.infer<typeof RetryOutboxInput>;

/** PROCESSING → COMPLETED. The payload is retained for Phase 0E.4. */
export const CompleteOutboxInput = z.strictObject({
  ...OwnershipFields,
  completedAt: z.iso.datetime(),
});
export type CompleteOutboxInput = z.infer<typeof CompleteOutboxInput>;

/** PROCESSING → DEAD_LETTER. Terminal failure; the payload is retained. */
export const DeadLetterOutboxInput = z.strictObject({
  ...OwnershipFields,
  errorCode: SafeErrorCode,
  errorSummary: SafeErrorSummary,
});
export type DeadLetterOutboxInput = z.infer<typeof DeadLetterOutboxInput>;

/**
 * PENDING | RETRYABLE → CANCELLED. Requires no lock token because an unclaimed
 * item has no owner; a PROCESSING item cannot be cancelled out from under its
 * worker.
 */
export const CancelOutboxInput = z.strictObject({
  outboxId: OutboxId,
});
export type CancelOutboxInput = z.infer<typeof CancelOutboxInput>;

/** Re-exported for callers working purely with processing contracts. */
export { OutboxStatus, LockToken };
