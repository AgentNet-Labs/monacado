/**
 * Identity, session, and entitlement errors (Phase 0E.7.4.2A).
 *
 * The most important one here is the one that says the least.
 * `InvalidCredentialsError` is raised for an unknown address, a wrong password,
 * and a disabled account alike — one code, one message, no fields. Distinguishing
 * them would turn the login boundary into an account-existence oracle, which is
 * how a leaked address list becomes a confirmed customer list. The timing decoy in
 * `password.ts` closes the same question on the clock; this closes it on the wire.
 *
 * Deliberately NOT errors: a session that has expired or been revoked, and an
 * account that holds no capability. Those are ordinary answers — `undefined` from
 * resolution, `false` from a capability check — because "not signed in" and "not
 * authorized" are conditions a caller handles, not faults.
 *
 * No error carries a password, a hash, a raw or hashed token, a cookie, an email,
 * a database message, or a stack. Internal causes use the shared non-enumerable
 * pattern, so `JSON.stringify(error)` cannot leak one.
 */

import { attachInternalCause } from "../product/error-cause";

export type AccountErrorCode =
  | "INVALID_ACCOUNT_INPUT"
  | "DUPLICATE_ACCOUNT_EMAIL"
  | "INVALID_CREDENTIALS"
  | "ACCOUNT_NOT_FOUND"
  | "UNSUPPORTED_CAPABILITY"
  | "ACCOUNT_PERSISTENCE_FAILURE";

export class AccountError extends Error {
  readonly code: AccountErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: AccountErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "AccountError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/**
 * Malformed input — an unknown field, a short password, an implausible address.
 * `fields` names paths only; the offending value is never echoed, because a
 * rejected credential field is exactly where a password would otherwise land in a
 * log.
 */
export class InvalidAccountInputError extends AccountError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_ACCOUNT_INPUT", "Invalid account input");
    this.name = "InvalidAccountInputError";
    this.fields = fields;
  }
}

/**
 * An account already exists for this normalised address.
 *
 * Reachable only from account *creation*, which is an administrative operation in
 * this phase — not a public signup route. If a public signup is ever added, it
 * must not surface this code to the caller for the enumeration reason above.
 */
export class DuplicateAccountEmailError extends AccountError {
  constructor(cause?: unknown) {
    super("DUPLICATE_ACCOUNT_EMAIL", "An account already exists for this email", cause);
    this.name = "DuplicateAccountEmailError";
  }
}

/**
 * Authentication failed. One code for every cause, with no fields and no detail.
 *
 * Unknown address, wrong password, and disabled account are indistinguishable by
 * construction: there is nothing on this error to tell them apart.
 */
export class InvalidCredentialsError extends AccountError {
  constructor() {
    super("INVALID_CREDENTIALS", "Invalid email or password");
    this.name = "InvalidCredentialsError";
  }
}

/**
 * No account exists for a given id.
 *
 * Raised only by administrative operations that name an account directly — a
 * grant or a revocation. Never by authentication, where it would be an oracle.
 */
export class AccountNotFoundError extends AccountError {
  constructor() {
    super("ACCOUNT_NOT_FOUND", "No account exists for this identifier");
    this.name = "AccountNotFoundError";
  }
}

/** A capability outside the closed vocabulary was requested. */
export class UnsupportedCapabilityError extends AccountError {
  constructor() {
    super("UNSUPPORTED_CAPABILITY", "That capability is not part of the known vocabulary");
    this.name = "UnsupportedCapabilityError";
  }
}

/** A durable write failed. The underlying database message is never surfaced. */
export class AccountPersistenceFailureError extends AccountError {
  readonly stage: string;
  constructor(stage: string, cause?: unknown) {
    super("ACCOUNT_PERSISTENCE_FAILURE", "An account persistence operation failed", cause);
    this.name = "AccountPersistenceFailureError";
    this.stage = stage;
  }
}
