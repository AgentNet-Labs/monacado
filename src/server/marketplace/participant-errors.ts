/**
 * Marketplace participant errors (Phase 0M.5).
 *
 * Two rules, both inherited from the account and publication error modules:
 *
 *   1. **No error carries private data.** Not an email address, a legal name, a
 *      profile value, a session token, a provider identifier, or a database
 *      message. `fields` names paths only; the offending value is never echoed,
 *      because a rejected profile field is exactly where a private value would
 *      otherwise land in a log.
 *
 *   2. **Internal causes are non-enumerable**, via the shared
 *      `attachInternalCause` helper, so `JSON.stringify(error)` cannot leak a
 *      driver message or a connection string.
 *
 * Deliberately NOT errors: a participant that holds no role, and a profile that
 * is INCOMPLETE. Those are ordinary answers a caller handles — `undefined` and a
 * derived status — not faults.
 */

import { attachInternalCause } from "../product/error-cause";

export type ParticipantErrorCode =
  | "INVALID_PARTICIPANT_INPUT"
  | "PARTICIPANT_NOT_FOUND"
  | "DUPLICATE_PARTICIPANT"
  | "ACCOUNT_NOT_FOUND_FOR_PARTICIPANT"
  | "INVALID_PARTICIPANT_TRANSITION"
  | "INVALID_ROLE_TRANSITION"
  | "ACTIVATION_NOT_PERMITTED_IN_PHASE"
  | "RESTRICTION_SCOPE_NOT_AVAILABLE_IN_PHASE"
  | "ACTIVATION_NOT_SUBMITTED"
  | "ACTIVATION_ALREADY_DECIDED"
  | "ACTIVATION_PREREQUISITES_NOT_MET"
  | "ACTIVATION_REVIEWER_NOT_AUTHORIZED"
  | "ACTIVATION_SELF_REVIEW_NOT_PERMITTED"
  | "INCOHERENT_ACTIVATION_DECISION"
  | "CORRUPT_PARTICIPANT_RECORD"
  | "PARTICIPANT_PERSISTENCE_FAILURE";

export class ParticipantError extends Error {
  readonly code: ParticipantErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: ParticipantErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "ParticipantError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/** Malformed input. `fields` names paths only — never the rejected value. */
export class InvalidParticipantInputError extends ParticipantError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_PARTICIPANT_INPUT", "Invalid participant input");
    this.name = "InvalidParticipantInputError";
    this.fields = fields;
  }
}

export class ParticipantNotFoundError extends ParticipantError {
  constructor() {
    super("PARTICIPANT_NOT_FOUND", "No participant exists for this identifier");
    this.name = "ParticipantNotFoundError";
  }
}

/**
 * The account already holds a participant.
 *
 * One participant per account is enforced by the unique index, not by a
 * read-then-write check, so two concurrent creations cannot both succeed.
 */
export class DuplicateParticipantError extends ParticipantError {
  constructor(cause?: unknown) {
    super("DUPLICATE_PARTICIPANT", "This account already holds a marketplace participant", cause);
    this.name = "DuplicateParticipantError";
  }
}

/** No account exists to anchor the participant to. */
export class AccountNotFoundForParticipantError extends ParticipantError {
  constructor(cause?: unknown) {
    super(
      "ACCOUNT_NOT_FOUND_FOR_PARTICIPANT",
      "No account exists for this identifier",
      cause,
    );
    this.name = "AccountNotFoundForParticipantError";
  }
}

/**
 * A participant status change the 0M.1 transition table forbids.
 *
 * Carries the attempted transition — both ends are members of a closed public
 * enum, so naming them discloses nothing a caller did not already supply.
 */
export class InvalidParticipantTransitionError extends ParticipantError {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) {
    super("INVALID_PARTICIPANT_TRANSITION", "That participant status change is not permitted");
    this.name = "InvalidParticipantTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** A role status change the 0M.1 role transition table forbids. */
export class InvalidRoleTransitionError extends ParticipantError {
  readonly role: string;
  readonly from: string;
  readonly to: string;
  constructor(role: string, from: string, to: string) {
    super("INVALID_ROLE_TRANSITION", "That role status change is not permitted");
    this.name = "InvalidRoleTransitionError";
    this.role = role;
    this.from = from;
    this.to = to;
  }
}

/**
 * A status this phase refuses to write even though 0M.1 permits the transition.
 *
 * The distinction matters: `InvalidParticipantTransitionError` means the
 * transition is illegal forever, while this means it is legal but belongs to the
 * governed activation phase (0M.8), which records WHO decided it. Collapsing
 * them would make a phase boundary look like a domain rule.
 */
export class ActivationNotPermittedInPhaseError extends ParticipantError {
  readonly attempted: string;
  constructor(attempted: string) {
    super(
      "ACTIVATION_NOT_PERMITTED_IN_PHASE",
      "Reaching that status requires a governed activation decision, which this phase does not make",
    );
    this.name = "ActivationNotPermittedInPhaseError";
    this.attempted = attempted;
  }
}

/**
 * A status whose meaning does not exist yet (Phase 0M.8).
 *
 * The sibling of `ActivationNotPermittedInPhaseError`, and distinct from it for
 * a reason worth stating. That one means "this phase does not make the decision
 * that would justify the status". This one means something stronger: **the
 * status has no machine-readable content to write.**
 *
 * `RESTRICTED` and `SUSPENDED` both mean "admitted, some capability withheld"
 * (0M.1 §4.1), and nothing in the repository expresses *which* capability —
 * `capability.ts` tests only `status !== "ACTIVE"`. Writing either would record a
 * status a later reader cannot act on, and a restriction nobody can enumerate is
 * indistinguishable from a suspension. The scope belongs to `0M.R1`.
 *
 * Fails closed and substitutes nothing: refusing is the only answer that does
 * not fabricate restriction semantics.
 */
export class RestrictionScopeNotAvailableInPhaseError extends ParticipantError {
  readonly attempted: string;
  constructor(attempted: string) {
    super(
      "RESTRICTION_SCOPE_NOT_AVAILABLE_IN_PHASE",
      "That status requires a machine-readable restriction scope, which this phase does not define",
    );
    this.name = "RestrictionScopeNotAvailableInPhaseError";
    this.attempted = attempted;
  }
}

/** There is no submitted activation to decide. */
export class ActivationNotSubmittedError extends ParticipantError {
  constructor() {
    super("ACTIVATION_NOT_SUBMITTED", "No undecided activation exists for this participant");
    this.name = "ActivationNotSubmittedError";
  }
}

/**
 * The activation has already been decided.
 *
 * The append-only guarantee, enforced rather than described: a decided row is
 * never re-decided. A reviewer who wants a different outcome records a new
 * submission and a new decision, so the first one survives in the audit trail
 * instead of being overwritten by the second.
 */
export class ActivationAlreadyDecidedError extends ParticipantError {
  constructor(cause?: unknown) {
    super("ACTIVATION_ALREADY_DECIDED", "That activation has already been decided", cause);
    this.name = "ActivationAlreadyDecidedError";
  }
}

/**
 * An approval was requested whose prerequisites do not hold.
 *
 * Carries every outstanding refusal, not the first — a reviewer told one
 * requirement at a time discovers the list one round trip at a time. Each code
 * is a member of the closed `ACTIVATION_APPROVAL_REFUSAL_CODES` vocabulary and
 * carries no value.
 */
export class ActivationPrerequisitesNotMetError extends ParticipantError {
  readonly refusalCodes: string[];
  constructor(refusalCodes: string[]) {
    super(
      "ACTIVATION_PREREQUISITES_NOT_MET",
      "This activation cannot be approved while prerequisites are outstanding",
    );
    this.name = "ActivationPrerequisitesNotMetError";
    this.refusalCodes = refusalCodes;
  }
}

/**
 * The acting account holds no active `activation:review` entitlement.
 *
 * Reviewer authority is a **persisted internal capability**, evaluated against
 * `AccountEntitlement` on every decision. This error is raised before any
 * participant state is read, so an unauthorized caller learns nothing about the
 * target — not whether it exists, not its status, not what is outstanding on it.
 *
 * `reasonCodes` are members of the closed `INTERNAL_AUTHORIZATION_REASON_CODES`
 * vocabulary — `INTERNAL_ACCOUNT_REQUIRED`, `INTERNAL_ACCOUNT_DISABLED`, or
 * `INTERNAL_CAPABILITY_NOT_GRANTED`. Each is a classification; none names the
 * account, an entitlement row, or anything about the participant.
 */
export class ActivationReviewerNotAuthorizedError extends ParticipantError {
  readonly reasonCodes: string[];
  /** The internal capability that was required. Always reported. */
  readonly requiredCapability = "activation:review";
  constructor(reasonCodes: string[] = ["INTERNAL_CAPABILITY_NOT_GRANTED"]) {
    super(
      "ACTIVATION_REVIEWER_NOT_AUTHORIZED",
      "This account is not authorized to decide activations",
    );
    this.name = "ActivationReviewerNotAuthorizedError";
    this.reasonCodes = reasonCodes;
  }
}

/**
 * The reviewer holds the entitlement but may not decide **this** activation.
 *
 * **Separation of duties**, and deliberately a separate error from
 * `ActivationReviewerNotAuthorizedError`. That one means "this account may not
 * review activations at all"; this one means "this account may review
 * activations, and not this one". Collapsing them would make a governance rule
 * look like a missing grant, and an operator would go looking for an entitlement
 * they already hold.
 *
 * The condition is exact and comes from persisted state: the target
 * `MarketplaceParticipant.accountId` equals the authorized `reviewerAccountId`.
 * Ownership is read from the foreign key, never inferred from an email, a name,
 * or anything the caller supplied — and never from identifier-prefix
 * incompatibility, which is not a security control.
 *
 * **An explicit `activation:review` grant is necessary but not sufficient.**
 * Deciding one's own admission is the decision a governed review exists to
 * prevent, and no entitlement makes it self-governed.
 *
 * Carries no identifier: naming either account would disclose the very linkage
 * the refusal is about.
 */
export class ActivationSelfReviewNotPermittedError extends ParticipantError {
  constructor() {
    super(
      "ACTIVATION_SELF_REVIEW_NOT_PERMITTED",
      "An internal reviewer may not decide the activation of a participant owned by the same account",
    );
    this.name = "ActivationSelfReviewNotPermittedError";
  }
}

/**
 * The decision and its reason code contradict each other.
 *
 * An `APPROVED` row reading `PROVIDER_DECLINED` is an audit record that argues
 * with itself, and the audit trail is the entire point of the table.
 */
export class IncoherentActivationDecisionError extends ParticipantError {
  readonly decision: string;
  readonly reasonCode: string;
  constructor(decision: string, reasonCode: string) {
    super("INCOHERENT_ACTIVATION_DECISION", "That reason code does not belong to that decision");
    this.name = "IncoherentActivationDecisionError";
    this.decision = decision;
    this.reasonCode = reasonCode;
  }
}

/**
 * A persisted row failed its contract on the way OUT of the database.
 *
 * Raised rather than returned, and deliberately distinct from an input error: an
 * unparseable stored row means the database holds something no code path should
 * have been able to write, and returning a best-effort object would let a
 * corrupt authority state flow into a capability decision. `fields` names the
 * failing paths; the stored value is never echoed.
 */
export class CorruptParticipantRecordError extends ParticipantError {
  readonly fields: string[];
  constructor(fields: string[], cause?: unknown) {
    super("CORRUPT_PARTICIPANT_RECORD", "A stored participant record failed validation", cause);
    this.name = "CorruptParticipantRecordError";
    this.fields = fields;
  }
}

/** A durable write failed. The underlying database message is never surfaced. */
export class ParticipantPersistenceFailureError extends ParticipantError {
  readonly stage: string;
  constructor(stage: string, cause?: unknown) {
    super(
      "PARTICIPANT_PERSISTENCE_FAILURE",
      "A participant persistence operation failed",
      cause,
    );
    this.name = "ParticipantPersistenceFailureError";
    this.stage = stage;
  }
}
