/**
 * Structured publication-outbox processing errors (Phase 0E.3).
 *
 * Stable codes; the original cause is retained for diagnostics but attached
 * NON-ENUMERABLE via the shared `attachInternalCause` pattern, so it cannot
 * escape through `JSON.stringify`, object spread, or `Object.keys`.
 *
 * Nothing here exposes DATABASE_URL, credentials, host/port/database details,
 * raw Prisma messages, capsule payloads, or integrity hashes. Lock tokens are
 * never echoed either — a mismatch reports THAT it mismatched, not the value.
 *
 * Persisted-contract violations reuse `PersistedOutboxContractViolationError`
 * from ./publication-errors, and database failures reuse `DatabaseError` from
 * ./errors.
 */

import { attachInternalCause } from "./error-cause";
import { PersistedOutboxContractViolationError } from "./publication-errors";

export type PublicationOutboxErrorCode =
  | "NO_ELIGIBLE_OUTBOX_ITEM"
  | "OUTBOX_CLAIM_CONFLICT"
  | "OUTBOX_LOCK_TOKEN_MISMATCH"
  | "INVALID_OUTBOX_TRANSITION"
  | "OUTBOX_NOT_FOUND"
  | "UNSAFE_ERROR_METADATA"
  | "INVALID_LEASE_DURATION"
  | "INVALID_LEASE_EXPIRY"
  | "STALE_CLAIM"
  | "RECOVERY_CONFLICT";

export class PublicationOutboxError extends Error {
  readonly code: PublicationOutboxErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see ./error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: PublicationOutboxErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "PublicationOutboxError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/** No item is currently claimable (none due, or none in a claimable state). */
export class NoEligibleOutboxItemError extends PublicationOutboxError {
  constructor(message = "No eligible publication outbox item is available to claim") {
    super("NO_ELIGIBLE_OUTBOX_ITEM", message);
    this.name = "NoEligibleOutboxItemError";
  }
}

/**
 * The guarded update matched no row: another worker claimed or resolved the item
 * between selection and update. The caller may simply try again.
 */
export class OutboxClaimConflictError extends PublicationOutboxError {
  constructor(
    message = "The outbox item was claimed or changed by another worker",
    cause?: unknown,
  ) {
    super("OUTBOX_CLAIM_CONFLICT", message, cause);
    this.name = "OutboxClaimConflictError";
  }
}

/**
 * The presented lock token does not own the current claim — a stale worker
 * attempting to resolve someone else's claim. The token value is never echoed.
 */
export class OutboxLockTokenMismatchError extends PublicationOutboxError {
  constructor(message = "The presented lock token does not own this outbox claim") {
    super("OUTBOX_LOCK_TOKEN_MISMATCH", message);
    this.name = "OutboxLockTokenMismatchError";
  }
}

/** The requested state change is not in the permitted transition matrix. */
export class InvalidOutboxTransitionError extends PublicationOutboxError {
  readonly fromStatus: string;
  readonly toStatus: string;
  constructor(
    fromStatus: string,
    toStatus: string,
    message?: string,
    /** Lets a subclass carry a more specific code while staying an instanceof. */
    code: PublicationOutboxErrorCode = "INVALID_OUTBOX_TRANSITION",
  ) {
    super(
      code,
      message ?? `Outbox transition ${fromStatus} -> ${toStatus} is not permitted`,
    );
    this.name = "InvalidOutboxTransitionError";
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

export class OutboxNotFoundError extends PublicationOutboxError {
  constructor(message = "Publication outbox item not found") {
    super("OUTBOX_NOT_FOUND", message);
    this.name = "OutboxNotFoundError";
  }
}

/**
 * Proposed error metadata was refused. `issues` name the CLASS of unsafe content
 * (e.g. "connection-string") — never the offending value.
 */
export class UnsafeErrorMetadataError extends PublicationOutboxError {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super("UNSAFE_ERROR_METADATA", message);
    this.name = "UnsafeErrorMetadataError";
    this.issues = issues;
  }
}

// — Lease expiry and stale-claim recovery (Phase 0E.5.1) —

/** The requested lease duration is missing, non-positive, or beyond the bound. */
export class InvalidLeaseDurationError extends PublicationOutboxError {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super("INVALID_LEASE_DURATION", message);
    this.name = "InvalidLeaseDurationError";
    this.issues = issues;
  }
}

/** The supplied lease expiry is not strictly later than the supplied `now`. */
export class InvalidLeaseExpiryError extends PublicationOutboxError {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super("INVALID_LEASE_EXPIRY", message);
    this.name = "InvalidLeaseExpiryError";
    this.issues = issues;
  }
}

/**
 * The caller presented a lock token for an item that currently holds NO claim —
 * its lease expired and it was recovered, so the token is stale.
 *
 * Deliberately a SUBCLASS of `InvalidOutboxTransitionError`: resolving a claim
 * you no longer hold IS an invalid transition, and existing callers that catch
 * the general case keep working while new callers can distinguish "your claim
 * went stale" from "that transition never made sense". The token is never echoed.
 */
export class StaleClaimError extends InvalidOutboxTransitionError {
  constructor(fromStatus: string, toStatus: string) {
    super(
      fromStatus,
      toStatus,
      `The claim on this outbox item is no longer held (item is ${fromStatus}); it expired or was recovered`,
      "STALE_CLAIM",
    );
    this.name = "StaleClaimError";
  }
}

/**
 * A recovery sweep lost a race for a row to another concurrent sweep. Surfaced
 * only where a caller asked to recover one specific item; a batch sweep counts
 * it as skipped rather than failing the whole sweep.
 */
export class RecoveryConflictError extends PublicationOutboxError {
  constructor(message = "The outbox item was recovered or changed by another caller", cause?: unknown) {
    super("RECOVERY_CONFLICT", message, cause);
    this.name = "RecoveryConflictError";
  }
}

/**
 * Persisted lease state violates its contract — a PROCESSING item without a
 * lease, or a lease left behind outside PROCESSING. A subclass of the general
 * persisted-outbox violation so existing handlers keep working.
 */
export class PersistedLeaseContractViolationError extends PersistedOutboxContractViolationError {
  constructor(message: string, issues: string[]) {
    super(message, issues);
    this.name = "PersistedLeaseContractViolationError";
  }
}
