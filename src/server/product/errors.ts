/**
 * Structured Product repository errors (Phase 0D).
 *
 * Every error carries a stable code and may preserve an internal `cause`.
 * Messages and codes are safe to surface; the `cause` is for internal
 * diagnostics only. NOTHING here includes DATABASE_URL, credentials, hosts with
 * credentials, or raw Prisma connection details — construct messages from safe
 * text only.
 *
 * The internal cause is retained but NON-ENUMERABLE (see ./error-cause), so it
 * cannot escape through `JSON.stringify`, object spread, or `Object.keys`.
 */

import { attachInternalCause } from "./error-cause";

export type ProductRepositoryErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "DUPLICATE_PRODUCT"
  | "DUPLICATE_VERSION"
  | "IMMUTABLE_IDENTITY"
  | "CONCURRENCY_CONFLICT"
  | "PERSISTED_CONTRACT_VIOLATION"
  | "DATABASE_ERROR";

export class ProductRepositoryError extends Error {
  readonly code: ProductRepositoryErrorCode;
  /**
   * Optional internal cause, retained for diagnostics but defined
   * NON-ENUMERABLE by `attachInternalCause` — invisible to `JSON.stringify`,
   * object spread, and `Object.keys`. Declared (not initialised) here so the
   * class field never re-creates it as an enumerable property.
   */
  declare readonly internalCause?: unknown;

  constructor(code: ProductRepositoryErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "ProductRepositoryError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

export class ValidationError extends ProductRepositoryError {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super("VALIDATION_FAILED", message);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export class NotFoundError extends ProductRepositoryError {
  constructor(message: string) {
    super("NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

export class DuplicateProductError extends ProductRepositoryError {
  constructor(message: string, cause?: unknown) {
    super("DUPLICATE_PRODUCT", message, cause);
    this.name = "DuplicateProductError";
  }
}

export class DuplicateVersionError extends ProductRepositoryError {
  constructor(message: string, cause?: unknown) {
    super("DUPLICATE_VERSION", message, cause);
    this.name = "DuplicateVersionError";
  }
}

export class ImmutableIdentityError extends ProductRepositoryError {
  constructor(message: string) {
    super("IMMUTABLE_IDENTITY", message);
    this.name = "ImmutableIdentityError";
  }
}

export class ConcurrencyConflictError extends ProductRepositoryError {
  constructor(message: string) {
    super("CONCURRENCY_CONFLICT", message);
    this.name = "ConcurrencyConflictError";
  }
}

export class PersistedContractViolationError extends ProductRepositoryError {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super("PERSISTED_CONTRACT_VIOLATION", message, issues);
    this.name = "PersistedContractViolationError";
    this.issues = issues;
  }
}

export class DatabaseError extends ProductRepositoryError {
  constructor(message: string, cause?: unknown) {
    super("DATABASE_ERROR", message, cause);
    this.name = "DatabaseError";
  }
}
