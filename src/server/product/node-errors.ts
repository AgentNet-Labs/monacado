/**
 * Structured Product Node errors (Phase 0E.1).
 *
 * Stable codes; internal `cause` preserved for diagnostics only. Nothing here
 * includes DATABASE_URL, credentials, hosts with credentials, or raw Prisma
 * connection details. Reuses DatabaseError from ./errors for DB failures.
 *
 * The internal cause is retained but NON-ENUMERABLE (see ./error-cause).
 */

import { attachInternalCause } from "./error-cause";

export type ProductNodeErrorCode =
  | "PRODUCT_NOT_FOUND"
  | "PRODUCT_NODE_NOT_FOUND"
  | "INVALID_NODE_ID"
  | "NODE_ISSUANCE_CONFLICT"
  | "INVALID_LIFECYCLE_TRANSITION"
  | "PERSISTED_NODE_CONTRACT_VIOLATION";

export class ProductNodeError extends Error {
  readonly code: ProductNodeErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see ./error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: ProductNodeErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "ProductNodeError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

export class ProductNotFoundError extends ProductNodeError {
  constructor(message = "Product not found") {
    super("PRODUCT_NOT_FOUND", message);
    this.name = "ProductNotFoundError";
  }
}

export class ProductNodeNotFoundError extends ProductNodeError {
  constructor(message = "Product Node not found") {
    super("PRODUCT_NODE_NOT_FOUND", message);
    this.name = "ProductNodeNotFoundError";
  }
}

export class InvalidNodeIdError extends ProductNodeError {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super("INVALID_NODE_ID", message);
    this.name = "InvalidNodeIdError";
    this.issues = issues;
  }
}

export class NodeIssuanceConflictError extends ProductNodeError {
  /** Fields that conflict with the existing Node (names only — no values). */
  readonly conflictingFields: string[];
  constructor(message: string, conflictingFields: string[], cause?: unknown) {
    super("NODE_ISSUANCE_CONFLICT", message, cause);
    this.name = "NodeIssuanceConflictError";
    this.conflictingFields = conflictingFields;
  }
}

export class InvalidLifecycleTransitionError extends ProductNodeError {
  constructor(message: string) {
    super("INVALID_LIFECYCLE_TRANSITION", message);
    this.name = "InvalidLifecycleTransitionError";
  }
}

export class PersistedNodeContractViolationError extends ProductNodeError {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super("PERSISTED_NODE_CONTRACT_VIOLATION", message, issues);
    this.name = "PersistedNodeContractViolationError";
    this.issues = issues;
  }
}
