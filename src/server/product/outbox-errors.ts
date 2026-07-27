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

export type PublicationOutboxErrorCode =
  | "NO_ELIGIBLE_OUTBOX_ITEM"
  | "OUTBOX_CLAIM_CONFLICT"
  | "OUTBOX_LOCK_TOKEN_MISMATCH"
  | "INVALID_OUTBOX_TRANSITION"
  | "OUTBOX_NOT_FOUND"
  | "UNSAFE_ERROR_METADATA";

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
  constructor(fromStatus: string, toStatus: string, message?: string) {
    super(
      "INVALID_OUTBOX_TRANSITION",
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
