/**
 * Publication-outbox processing contracts (Phases 0E.3, 0E.5.1).
 *
 * Worker-facing state transitions and concurrency control for prepared Product
 * publications. This is OFFLINE: it decides WHICH item a worker may work on and
 * records WHAT happened, but performs no submission itself.
 *
 * Phase 0E.5.1 added a bounded **claim lease** and an explicit stale-claim sweep,
 * so a crashed worker cannot strand an item in PROCESSING forever. That sweep is
 * caller-driven: there is still deliberately no worker loop, no scheduled
 * polling, no background recovery, no lock stealing from a LIVE claim, no network
 * call, and no Resolver concept. `COMPLETED` means one outbox attempt finished —
 * it asserts nothing about Registrar registration.
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
 * Bounds on a claim lease (Phase 0E.5.1). The lower bound rejects a
 * zero/negative lease that would be stale the instant it is taken; the upper
 * bound rejects an effectively-infinite lease, which would reintroduce the
 * permanently-stuck claim this phase exists to prevent.
 */
export const MIN_LEASE_DURATION_SECONDS = 1;
export const MAX_LEASE_DURATION_SECONDS = 86_400; // 24 hours

export const LeaseDurationSeconds = z
  .int()
  .min(MIN_LEASE_DURATION_SECONDS, "leaseDurationSeconds must be at least 1 second")
  .max(
    MAX_LEASE_DURATION_SECONDS,
    `leaseDurationSeconds must be at most ${MAX_LEASE_DURATION_SECONDS} seconds`,
  );
export type LeaseDurationSeconds = z.infer<typeof LeaseDurationSeconds>;

/**
 * Input to claim the next eligible item. `now` is supplied explicitly at the
 * service boundary — no clock is read inside the repository, matching the
 * discipline used throughout the Product phases.
 *
 * A claim MUST establish a lease, given either as a bounded duration or as an
 * explicit expiry instant. Exactly one of the two is required: supplying both
 * would leave it ambiguous which one governs.
 */
export const ClaimOutboxInput = z
  .strictObject({
    /** Items are eligible when `availableAt <= now`. Also recorded as `lockedAt`. */
    now: z.iso.datetime(),
    /** Lease length from `now`. Mutually exclusive with `leaseExpiresAt`. */
    leaseDurationSeconds: LeaseDurationSeconds.optional(),
    /** Explicit lease expiry. Must be strictly later than `now`. */
    leaseExpiresAt: z.iso.datetime().optional(),
  })
  .superRefine((input, ctx) => {
    const hasDuration = input.leaseDurationSeconds !== undefined;
    const hasExpiry = input.leaseExpiresAt !== undefined;
    if (hasDuration === hasExpiry) {
      ctx.addIssue({
        code: "custom",
        path: ["leaseDurationSeconds"],
        message: "supply exactly one of leaseDurationSeconds or leaseExpiresAt",
      });
      return;
    }
    if (hasExpiry && Date.parse(input.leaseExpiresAt!) <= Date.parse(input.now)) {
      ctx.addIssue({
        code: "custom",
        path: ["leaseExpiresAt"],
        message: "leaseExpiresAt must be strictly later than now",
      });
    }
  });
export type ClaimOutboxInput = z.infer<typeof ClaimOutboxInput>;

/** Resolve a claim input to its explicit lease expiry instant. */
export function resolveLeaseExpiry(input: {
  now: string;
  leaseDurationSeconds?: number;
  leaseExpiresAt?: string;
}): string {
  if (input.leaseExpiresAt !== undefined) return new Date(input.leaseExpiresAt).toISOString();
  return new Date(Date.parse(input.now) + input.leaseDurationSeconds! * 1000).toISOString();
}

// — Stale-claim recovery —

/** Bounded batch size for one recovery sweep. There is no loop-until-empty. */
export const MIN_RECOVERY_LIMIT = 1;
export const MAX_RECOVERY_LIMIT = 1_000;

/** The bounded, safe error code recorded on a recovered item. */
export const LEASE_EXPIRED_ERROR_CODE = "LEASE_EXPIRED" as const;
export const LEASE_EXPIRED_ERROR_SUMMARY =
  "The claim lease expired before the attempt was resolved; the item was returned for retry." as const;

/**
 * Input to one stale-claim sweep. `now` decides which leases have expired, and
 * `availableAt` decides when recovered items become claimable again — defaulting
 * to `now`, i.e. immediately eligible. Both are explicit; no clock is read.
 */
export const RecoverExpiredClaimsInput = z.strictObject({
  now: z.iso.datetime(),
  /** Maximum rows to recover in this sweep. */
  limit: z.int().min(MIN_RECOVERY_LIMIT).max(MAX_RECOVERY_LIMIT),
  /** When recovered items become eligible again. Defaults to `now`. */
  availableAt: z.iso.datetime().optional(),
});
export type RecoverExpiredClaimsInput = z.infer<typeof RecoverExpiredClaimsInput>;

/**
 * The outcome of one sweep. `examined` counts eligible candidates seen;
 * `recovered` are the rows this caller actually won. A candidate another
 * concurrent sweep recovered first is counted in `skipped`, not an error.
 */
export const StaleClaimRecoveryResult = z.strictObject({
  now: z.iso.datetime(),
  availableAt: z.iso.datetime(),
  examined: z.int().min(0),
  recoveredCount: z.int().min(0),
  skippedCount: z.int().min(0),
  recovered: z.array(ProductPublicationOutbox),
});
export type StaleClaimRecoveryResult = z.infer<typeof StaleClaimRecoveryResult>;

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
