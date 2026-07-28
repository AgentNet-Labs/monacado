/**
 * Structured Registrar-receipt and reconciliation errors (Phase 0E.4).
 *
 * Stable codes; the original cause is retained for diagnostics but attached
 * NON-ENUMERABLE via the shared `attachInternalCause` pattern, so it cannot
 * escape through `JSON.stringify`, object spread, or `Object.keys`.
 *
 * Nothing here exposes DATABASE_URL, credentials, host/port/database details,
 * raw Prisma messages, the capsule payload, a lock token, or a hash VALUE.
 * Mismatches report the NAMES of the fields that disagreed — never the expected
 * or received values, because those include content hashes.
 *
 * Persisted-contract violations for the outbox reuse
 * `PersistedOutboxContractViolationError` from ./publication-errors; database
 * failures reuse `DatabaseError` from ./errors.
 */

import { attachInternalCause } from "./error-cause";

export type RegistrarReceiptErrorCode =
  | "RECEIPT_PUBLICATION_NOT_FOUND"
  | "RECEIPT_CONFLICT"
  | "REGISTRAR_IDENTITY_MISMATCH"
  | "RECEIPT_NODE_MISMATCH"
  | "RECEIPT_CAPSULE_MISMATCH"
  | "REGISTERED_HASH_MISMATCH"
  | "INVALID_RECEIPT_STATE"
  | "PERSISTED_RECEIPT_CONTRACT_VIOLATION"
  | "RECONCILIATION_FAILURE";

export class RegistrarReceiptError extends Error {
  readonly code: RegistrarReceiptErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see ./error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: RegistrarReceiptErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "RegistrarReceiptError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/** The publication a receipt claims to describe does not exist. */
export class ReceiptPublicationNotFoundError extends RegistrarReceiptError {
  constructor(message = "Publication not found for this receipt") {
    super("RECEIPT_PUBLICATION_NOT_FOUND", message);
    this.name = "ReceiptPublicationNotFoundError";
  }
}

/**
 * A receipt already exists that contradicts this one — a replayed `receiptId` or
 * `registrarRegistrationId` with different data, a second accepted receipt, or
 * an acceptance arriving after a recorded rejection or mismatch. Reports
 * conflicting field NAMES only.
 */
export class ReceiptConflictError extends RegistrarReceiptError {
  readonly conflictingFields: string[];
  constructor(message: string, conflictingFields: string[], cause?: unknown) {
    super("RECEIPT_CONFLICT", message, cause);
    this.name = "ReceiptConflictError";
    this.conflictingFields = conflictingFields;
  }
}

/**
 * Base for the four reconciliation mismatches. These are raised only where a
 * caller asked for a strict comparison; the normal `recordRegistrarReceipt`
 * path returns a structured MISMATCH result instead of throwing, so the
 * evidence is durably recorded rather than lost.
 */
export class ReceiptMismatchError extends RegistrarReceiptError {
  /** Names of the fields that disagreed — never their values. */
  readonly mismatchedFields: string[];
  constructor(
    code: RegistrarReceiptErrorCode,
    message: string,
    mismatchedFields: string[],
  ) {
    super(code, message);
    this.name = "ReceiptMismatchError";
    this.mismatchedFields = mismatchedFields;
  }
}

export class RegistrarIdentityMismatchError extends ReceiptMismatchError {
  constructor(message = "Receipt Registrar identity does not match the expected Registrar") {
    super("REGISTRAR_IDENTITY_MISMATCH", message, ["registrarId"]);
    this.name = "RegistrarIdentityMismatchError";
  }
}

export class ReceiptNodeMismatchError extends ReceiptMismatchError {
  constructor(message = "Receipt Node ID does not match the publication's Node binding") {
    super("RECEIPT_NODE_MISMATCH", message, ["nodeId"]);
    this.name = "ReceiptNodeMismatchError";
  }
}

export class ReceiptCapsuleMismatchError extends ReceiptMismatchError {
  constructor(message = "Receipt capsule ID does not match the published capsule") {
    super("RECEIPT_CAPSULE_MISMATCH", message, ["capsuleId"]);
    this.name = "ReceiptCapsuleMismatchError";
  }
}

/** The registered content hash disagrees. The hash VALUES are never included. */
export class RegisteredHashMismatchError extends ReceiptMismatchError {
  constructor(message = "Registered content hash does not match the published capsule hash") {
    super("REGISTERED_HASH_MISMATCH", message, ["registeredContentHash"]);
    this.name = "RegisteredHashMismatchError";
  }
}

/**
 * The publication or its outbox item is not in a state that can accept this
 * receipt — e.g. an accepted receipt for an item that was never claimed.
 */
export class InvalidReceiptStateError extends RegistrarReceiptError {
  readonly outboxStatus?: string;
  constructor(message: string, outboxStatus?: string) {
    super("INVALID_RECEIPT_STATE", message);
    this.name = "InvalidReceiptStateError";
    this.outboxStatus = outboxStatus;
  }
}

export class PersistedReceiptContractViolationError extends RegistrarReceiptError {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super("PERSISTED_RECEIPT_CONTRACT_VIOLATION", message, issues);
    this.name = "PersistedReceiptContractViolationError";
    this.issues = issues;
  }
}

/** Reconciliation could not be completed atomically. */
export class ReconciliationFailureError extends RegistrarReceiptError {
  constructor(message = "Receipt reconciliation could not be committed", cause?: unknown) {
    super("RECONCILIATION_FAILURE", message, cause);
    this.name = "ReconciliationFailureError";
  }
}
