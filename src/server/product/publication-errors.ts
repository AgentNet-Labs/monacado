/**
 * Structured Product publication errors (Phase 0E.2).
 *
 * Stable codes; internal `cause` preserved for diagnostics only. NOTHING here
 * includes DATABASE_URL, credentials, hosts with credentials, raw Prisma
 * connection details, or full capsule payloads — conflicts report field NAMES
 * only, never field values, and never the payload. Reuses `DatabaseError` from
 * ./errors for database failures.
 *
 * The internal cause is retained but NON-ENUMERABLE (see ./error-cause).
 */

import { attachInternalCause } from "./error-cause";

export type ProductPublicationErrorCode =
  | "PUBLICATION_PRODUCT_NOT_FOUND"
  | "SOURCE_RECORD_VERSION_NOT_FOUND"
  | "PRODUCT_SOURCE_MISMATCH"
  | "PRODUCT_NODE_MISMATCH"
  | "NODE_NOT_ELIGIBLE"
  | "INVALID_PUBLICATION_INPUT"
  | "DUPLICATE_CAPSULE_ID"
  | "PUBLICATION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "PERSISTED_PUBLICATION_CONTRACT_VIOLATION"
  | "PERSISTED_OUTBOX_CONTRACT_VIOLATION"
  | "ATOMIC_PREPARATION_FAILURE";

export class ProductPublicationError extends Error {
  readonly code: ProductPublicationErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see ./error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: ProductPublicationErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "ProductPublicationError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

export class PublicationProductNotFoundError extends ProductPublicationError {
  constructor(message = "Product not found for publication") {
    super("PUBLICATION_PRODUCT_NOT_FOUND", message);
    this.name = "PublicationProductNotFoundError";
  }
}

export class SourceRecordVersionNotFoundError extends ProductPublicationError {
  constructor(message = "Source-record version not found") {
    super("SOURCE_RECORD_VERSION_NOT_FOUND", message);
    this.name = "SourceRecordVersionNotFoundError";
  }
}

export class ProductSourceMismatchError extends ProductPublicationError {
  constructor(message = "Source-record version belongs to a different Product") {
    super("PRODUCT_SOURCE_MISMATCH", message);
    this.name = "ProductSourceMismatchError";
  }
}

export class ProductNodeMismatchError extends ProductPublicationError {
  constructor(message = "Product Node belongs to a different Product") {
    super("PRODUCT_NODE_MISMATCH", message);
    this.name = "ProductNodeMismatchError";
  }
}

/** The Node exists but its ANS lifecycle state does not permit publication. */
export class NodeNotEligibleError extends ProductPublicationError {
  readonly lifecycleState: string;
  constructor(lifecycleState: string, message?: string) {
    super(
      "NODE_NOT_ELIGIBLE",
      message ?? `Product Node lifecycle state ${lifecycleState} is not eligible for publication (Active required)`,
    );
    this.name = "NodeNotEligibleError";
    this.lifecycleState = lifecycleState;
  }
}

export class InvalidPublicationInputError extends ProductPublicationError {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super("INVALID_PUBLICATION_INPUT", message);
    this.name = "InvalidPublicationInputError";
    this.issues = issues;
  }
}

export class DuplicateCapsuleIdError extends ProductPublicationError {
  constructor(message = "This capsule ID is already published", cause?: unknown) {
    super("DUPLICATE_CAPSULE_ID", message, cause);
    this.name = "DuplicateCapsuleIdError";
  }
}

/**
 * A different publication already exists for the same (Node, source-record
 * version) — e.g. a second, conflicting capsule identity for one source version.
 */
export class PublicationConflictError extends ProductPublicationError {
  readonly conflictingFields: string[];
  constructor(message: string, conflictingFields: string[], cause?: unknown) {
    super("PUBLICATION_CONFLICT", message, cause);
    this.name = "PublicationConflictError";
    this.conflictingFields = conflictingFields;
  }
}

/**
 * The same preparation identity was repeated with contradictory assertions.
 * Reports conflicting field NAMES only — never the stored or submitted values.
 */
export class IdempotencyConflictError extends ProductPublicationError {
  readonly conflictingFields: string[];
  constructor(message: string, conflictingFields: string[]) {
    super("IDEMPOTENCY_CONFLICT", message);
    this.name = "IdempotencyConflictError";
    this.conflictingFields = conflictingFields;
  }
}

export class PersistedPublicationContractViolationError extends ProductPublicationError {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super("PERSISTED_PUBLICATION_CONTRACT_VIOLATION", message, issues);
    this.name = "PersistedPublicationContractViolationError";
    this.issues = issues;
  }
}

/**
 * Persisted outbox data violates its contract — a malformed/invalid payload, or
 * a stored `payloadHash` that does not match the canonical payload. The payload
 * itself is NEVER included in the message or issues.
 */
export class PersistedOutboxContractViolationError extends ProductPublicationError {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super("PERSISTED_OUTBOX_CONTRACT_VIOLATION", message, issues);
    this.name = "PersistedOutboxContractViolationError";
    this.issues = issues;
  }
}

/** The publication/outbox transaction could not be committed atomically. */
export class AtomicPreparationFailureError extends ProductPublicationError {
  constructor(message = "Publication preparation could not be committed atomically", cause?: unknown) {
    super("ATOMIC_PREPARATION_FAILURE", message, cause);
    this.name = "AtomicPreparationFailureError";
  }
}
