/**
 * Structured submission-attempt errors (Phase 0E.5.3).
 *
 * Stable codes; the original cause is retained for diagnostics but attached
 * NON-ENUMERABLE via the shared `attachInternalCause` pattern.
 *
 * Nothing here exposes a raw lock token, the `claimTokenHash`, the capsule
 * payload, receipt contents, integrity hash VALUES, credentials, or raw Prisma
 * messages. Conflicts report field NAMES and bounded status names only.
 *
 * Database failures reuse `DatabaseError` from ./errors.
 */

import { attachInternalCause } from "./error-cause";

export type SubmissionAttemptErrorCode =
  | "SUBMISSION_ATTEMPT_NOT_FOUND"
  | "INVALID_ATTEMPT_TRANSITION"
  | "ATTEMPT_REPLAY_CONFLICT"
  | "ATTEMPT_ALREADY_EXISTS_FOR_CLAIM"
  | "CLAIM_NO_LONGER_OWNED"
  | "CLAIM_LEASE_EXPIRED"
  | "CLAIM_TOKEN_HASH_MISMATCH"
  | "ATTEMPT_NOT_DISPATCHED"
  | "ATTEMPT_ABANDONED"
  | "RECEIPT_ATTEMPT_MISMATCH"
  | "ATTEMPT_ALREADY_HAS_RECEIPT"
  | "PERSISTED_ATTEMPT_CONTRACT_VIOLATION";

export class SubmissionAttemptError extends Error {
  readonly code: SubmissionAttemptErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see ./error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: SubmissionAttemptErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "SubmissionAttemptError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

export class SubmissionAttemptNotFoundError extends SubmissionAttemptError {
  constructor(message = "Publication submission attempt not found") {
    super("SUBMISSION_ATTEMPT_NOT_FOUND", message);
    this.name = "SubmissionAttemptNotFoundError";
  }
}

/** The requested lifecycle change is not in the permitted transition matrix. */
export class InvalidAttemptTransitionError extends SubmissionAttemptError {
  readonly fromStatus: string;
  readonly toStatus: string;
  constructor(fromStatus: string, toStatus: string, message?: string) {
    super(
      "INVALID_ATTEMPT_TRANSITION",
      message ?? `Attempt transition ${fromStatus} -> ${toStatus} is not permitted`,
    );
    this.name = "InvalidAttemptTransitionError";
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

/** The same `submissionAttemptId` was replayed with different data. Names only. */
export class AttemptReplayConflictError extends SubmissionAttemptError {
  readonly conflictingFields: string[];
  constructor(message: string, conflictingFields: string[]) {
    super("ATTEMPT_REPLAY_CONFLICT", message, conflictingFields);
    this.name = "AttemptReplayConflictError";
    this.conflictingFields = conflictingFields;
  }
}

/**
 * This claim already prepared an attempt. One outbox `attemptCount` may attempt
 * exactly once; a further attempt requires a new claim.
 */
export class AttemptAlreadyExistsForClaimError extends SubmissionAttemptError {
  constructor(message = "This claim has already prepared a submission attempt") {
    super("ATTEMPT_ALREADY_EXISTS_FOR_CLAIM", message);
    this.name = "AttemptAlreadyExistsForClaimError";
  }
}

/** The work item is not claimed, or is claimed by someone else. */
export class ClaimNoLongerOwnedError extends SubmissionAttemptError {
  readonly outboxStatus?: string;
  constructor(message = "The outbox claim is no longer held by the presenting worker", outboxStatus?: string) {
    super("CLAIM_NO_LONGER_OWNED", message);
    this.name = "ClaimNoLongerOwnedError";
    this.outboxStatus = outboxStatus;
  }
}

/** The claim's lease had already expired at the supplied instant. */
export class ClaimLeaseExpiredError extends SubmissionAttemptError {
  constructor(message = "The claim lease had expired; take a fresh claim before submitting") {
    super("CLAIM_LEASE_EXPIRED", message);
    this.name = "ClaimLeaseExpiredError";
  }
}

/** The presented token does not hash to the attempt's recorded binding. */
export class ClaimTokenHashMismatchError extends SubmissionAttemptError {
  constructor(message = "The presented lock token does not own this submission attempt") {
    super("CLAIM_TOKEN_HASH_MISMATCH", message);
    this.name = "ClaimTokenHashMismatchError";
  }
}

/** A receipt may only answer an attempt that was actually sent. */
export class AttemptNotDispatchedError extends SubmissionAttemptError {
  readonly attemptStatus: string;
  constructor(attemptStatus: string, message?: string) {
    super(
      "ATTEMPT_NOT_DISPATCHED",
      message ?? `A receipt requires a DISPATCHED attempt; this one is ${attemptStatus}`,
    );
    this.name = "AttemptNotDispatchedError";
    this.attemptStatus = attemptStatus;
  }
}

/** The attempt was abandoned, so nothing can authoritatively answer it. */
export class AttemptAbandonedError extends SubmissionAttemptError {
  constructor(message = "This submission attempt was abandoned and can no longer receive a receipt") {
    super("ATTEMPT_ABANDONED", message);
    this.name = "AttemptAbandonedError";
  }
}

/**
 * The receipt does not belong to the attempt it names — a different publication
 * or work item, or an identity/hash the attempt never asserted. Field names only.
 */
export class ReceiptAttemptMismatchError extends SubmissionAttemptError {
  readonly mismatchedFields: string[];
  constructor(message: string, mismatchedFields: string[]) {
    super("RECEIPT_ATTEMPT_MISMATCH", message);
    this.name = "ReceiptAttemptMismatchError";
    this.mismatchedFields = mismatchedFields;
  }
}

/** One attempt carries at most one authoritative receipt. */
export class AttemptAlreadyHasReceiptError extends SubmissionAttemptError {
  constructor(message = "This submission attempt already has a recorded receipt", cause?: unknown) {
    super("ATTEMPT_ALREADY_HAS_RECEIPT", message, cause);
    this.name = "AttemptAlreadyHasReceiptError";
  }
}

export class PersistedAttemptContractViolationError extends SubmissionAttemptError {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super("PERSISTED_ATTEMPT_CONTRACT_VIOLATION", message, issues);
    this.name = "PersistedAttemptContractViolationError";
    this.issues = issues;
  }
}
