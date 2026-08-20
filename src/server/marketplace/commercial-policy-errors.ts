/**
 * Versioned commercial-policy errors (Phase 0M.R1).
 *
 * Two rules, inherited from every error module in this repository:
 *
 *   1. **No error carries private data**, and none carries an economic value
 *      either. A rate, a fixed amount, or a computed figure in an error message
 *      would put Monacado's commercial terms into a log that nobody decided to
 *      publish there. Errors name identifiers and closed-enum members only.
 *
 *   2. **Internal causes are non-enumerable**, via the shared
 *      `attachInternalCause` helper, so `JSON.stringify(error)` cannot leak a
 *      driver message or a connection string.
 */

import { attachInternalCause } from "../product/error-cause";

export type CommercialPolicyErrorCode =
  | "INVALID_COMMERCIAL_POLICY_INPUT"
  | "COMMERCIAL_POLICY_NOT_FOUND"
  | "COMMERCIAL_POLICY_VERSION_NOT_FOUND"
  | "DUPLICATE_COMMERCIAL_POLICY_VERSION"
  | "AMBIGUOUS_ACTIVE_COMMERCIAL_POLICY"
  | "NO_ACTIVE_COMMERCIAL_POLICY"
  | "INVALID_COMMERCIAL_POLICY_VERSION_TRANSITION"
  | "IMMUTABLE_COMMERCIAL_POLICY_VERSION"
  | "CORRUPT_COMMERCIAL_POLICY_RECORD"
  | "COMMERCIAL_POLICY_PERSISTENCE_FAILURE";

export class CommercialPolicyServiceError extends Error {
  readonly code: CommercialPolicyErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: CommercialPolicyErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "CommercialPolicyServiceError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/** Malformed input. `fields` names paths only — never the rejected value. */
export class InvalidCommercialPolicyInputError extends CommercialPolicyServiceError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_COMMERCIAL_POLICY_INPUT", "Invalid commercial policy input");
    this.name = "InvalidCommercialPolicyInputError";
    this.fields = fields;
  }
}

export class CommercialPolicyNotFoundError extends CommercialPolicyServiceError {
  constructor() {
    super("COMMERCIAL_POLICY_NOT_FOUND", "No commercial policy exists for this identifier");
    this.name = "CommercialPolicyNotFoundError";
  }
}

export class CommercialPolicyVersionNotFoundError extends CommercialPolicyServiceError {
  constructor() {
    super(
      "COMMERCIAL_POLICY_VERSION_NOT_FOUND",
      "No commercial policy version exists for that policy and version",
    );
    this.name = "CommercialPolicyVersionNotFoundError";
  }
}

/**
 * A version label already used on this policy.
 *
 * Enforced by the `(policyId, policyVersion)` unique index rather than a
 * read-then-write check, so two concurrent recordings cannot both succeed — and
 * so a version label can never come to name two different sets of numbers.
 */
export class DuplicateCommercialPolicyVersionError extends CommercialPolicyServiceError {
  constructor(cause?: unknown) {
    super(
      "DUPLICATE_COMMERCIAL_POLICY_VERSION",
      "That version label is already recorded for this policy",
      cause,
    );
    this.name = "DuplicateCommercialPolicyVersionError";
  }
}

/**
 * More than one version of one policy is ACTIVE.
 *
 * Unreachable through the service — the `activeForPolicyId` unique index refuses
 * the second — and raised rather than resolved because "which policy applied"
 * must have exactly one answer. Choosing between two would be inventing the rule
 * the index exists to make unnecessary.
 */
export class AmbiguousActiveCommercialPolicyError extends CommercialPolicyServiceError {
  constructor(cause?: unknown) {
    super(
      "AMBIGUOUS_ACTIVE_COMMERCIAL_POLICY",
      "More than one version of this policy is active",
      cause,
    );
    this.name = "AmbiguousActiveCommercialPolicyError";
  }
}

/**
 * No version of this policy is currently active.
 *
 * An ordinary condition rather than a fault in one sense — a policy whose only
 * version is still a draft is legitimate — but a *refusal* for the caller asking
 * "what applies now", because returning a fallback rate would be exactly the
 * hard-coded economics `0M.4A` forbids.
 */
export class NoActiveCommercialPolicyError extends CommercialPolicyServiceError {
  constructor() {
    super("NO_ACTIVE_COMMERCIAL_POLICY", "No version of this policy is currently active");
    this.name = "NoActiveCommercialPolicyError";
  }
}

export class InvalidCommercialPolicyVersionTransitionError extends CommercialPolicyServiceError {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) {
    super(
      "INVALID_COMMERCIAL_POLICY_VERSION_TRANSITION",
      "That policy version status change is not permitted",
    );
    this.name = "InvalidCommercialPolicyVersionTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * An attempt to change a recorded version's economics.
 *
 * The immutability guarantee, enforced rather than described. A rate change is a
 * **new version**; editing an existing one would silently rewrite what past
 * transactions ran under, and every reconstruction of them afterwards would be
 * wrong without anything having failed.
 */
export class ImmutableCommercialPolicyVersionError extends CommercialPolicyServiceError {
  constructor() {
    super(
      "IMMUTABLE_COMMERCIAL_POLICY_VERSION",
      "A recorded policy version's economics are immutable; record a new version instead",
    );
    this.name = "ImmutableCommercialPolicyVersionError";
  }
}

export class CorruptCommercialPolicyRecordError extends CommercialPolicyServiceError {
  readonly fields: string[];
  constructor(fields: string[], cause?: unknown) {
    super(
      "CORRUPT_COMMERCIAL_POLICY_RECORD",
      "A stored commercial policy record failed validation",
      cause,
    );
    this.name = "CorruptCommercialPolicyRecordError";
    this.fields = fields;
  }
}

export class CommercialPolicyPersistenceFailureError extends CommercialPolicyServiceError {
  readonly stage: string;
  constructor(stage: string, cause?: unknown) {
    super(
      "COMMERCIAL_POLICY_PERSISTENCE_FAILURE",
      "A commercial policy persistence operation failed",
      cause,
    );
    this.name = "CommercialPolicyPersistenceFailureError";
    this.stage = stage;
  }
}
