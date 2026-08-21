/**
 * Governed commerce-approval errors (Phase 0M.9).
 *
 * The same two rules every error module in this repository follows: **no error
 * carries private data** — a reason code is a classification, never a profile
 * value, a provider message, or free text — and **internal causes are
 * non-enumerable**, so `JSON.stringify(error)` cannot leak a driver message.
 */

import { attachInternalCause } from "../product/error-cause";

export type CommerceApprovalErrorCode =
  | "INVALID_COMMERCE_APPROVAL_INPUT"
  | "COMMERCE_APPROVAL_ACTOR_NOT_AUTHORIZED"
  | "COMMERCE_APPROVAL_SELF_ACTION_NOT_PERMITTED"
  | "CORRUPT_COMMERCE_APPROVAL_RECORD"
  | "COMMERCE_APPROVAL_PERSISTENCE_FAILURE";

export class CommerceApprovalServiceError extends Error {
  readonly code: CommerceApprovalErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: CommerceApprovalErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "CommerceApprovalServiceError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/** Malformed input. `fields` names paths only — never the rejected value. */
export class InvalidCommerceApprovalInputError extends CommerceApprovalServiceError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_COMMERCE_APPROVAL_INPUT", "Invalid commerce approval input");
    this.name = "InvalidCommerceApprovalInputError";
    this.fields = fields;
  }
}

/**
 * The acting account holds no active `participant:commerce-approve` entitlement.
 *
 * `reasonCodes` is the committed internal-authorization vocabulary, surfaced
 * unchanged. Raised **before any participant state is read**, so an unauthorized
 * caller learns nothing about the target — not even whether it exists.
 */
export class CommerceApprovalActorNotAuthorizedError extends CommerceApprovalServiceError {
  readonly reasonCodes: string[];
  constructor(reasonCodes: string[]) {
    super(
      "COMMERCE_APPROVAL_ACTOR_NOT_AUTHORIZED",
      "That account may not decide commerce approval",
    );
    this.name = "CommerceApprovalActorNotAuthorizedError";
    this.reasonCodes = reasonCodes;
  }
}

/**
 * An actor tried to decide commerce approval for the participant its own account
 * owns.
 *
 * 0M.8's separation-of-duties rule, extended for the reason it most obviously
 * applies: clearing yourself to take money is the decision that most needs a
 * second person. Established from the persisted `accountId` foreign key, never
 * inferred from an email, a name, or an identifier prefix.
 */
export class CommerceApprovalSelfActionNotPermittedError extends CommerceApprovalServiceError {
  constructor() {
    super(
      "COMMERCE_APPROVAL_SELF_ACTION_NOT_PERMITTED",
      "An actor may not decide commerce approval for their own participant",
    );
    this.name = "CommerceApprovalSelfActionNotPermittedError";
  }
}

export class CorruptCommerceApprovalRecordError extends CommerceApprovalServiceError {
  readonly fields: string[];
  constructor(fields: string[], cause?: unknown) {
    super(
      "CORRUPT_COMMERCE_APPROVAL_RECORD",
      "A stored commerce approval record failed validation",
      cause,
    );
    this.name = "CorruptCommerceApprovalRecordError";
    this.fields = fields;
  }
}

export class CommerceApprovalPersistenceFailureError extends CommerceApprovalServiceError {
  readonly stage: string;
  constructor(stage: string, cause?: unknown) {
    super(
      "COMMERCE_APPROVAL_PERSISTENCE_FAILURE",
      "A commerce approval persistence operation failed",
      cause,
    );
    this.name = "CommerceApprovalPersistenceFailureError";
    this.stage = stage;
  }
}
