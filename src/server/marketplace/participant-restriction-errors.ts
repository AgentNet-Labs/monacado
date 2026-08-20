/**
 * Governed participant-restriction errors (Phase 0M.R1).
 *
 * Same two rules as every error module here: no error carries private data, and
 * internal causes are non-enumerable. One rule specific to this domain:
 *
 *   **A restriction error never explains the restriction.** The reason a
 *   participant is restricted is a bounded code on the record, decided by an
 *   operator; an error raised while *manipulating* restrictions must not become
 *   a second, unbounded channel for that same information.
 */

import { attachInternalCause } from "../product/error-cause";

export type ParticipantRestrictionErrorCode =
  | "INVALID_RESTRICTION_INPUT"
  | "RESTRICTION_NOT_FOUND"
  | "DUPLICATE_ACTIVE_RESTRICTION"
  | "RESTRICTION_ALREADY_LIFTED"
  | "RESTRICTION_ACTOR_NOT_AUTHORIZED"
  | "RESTRICTION_SELF_ACTION_NOT_PERMITTED"
  | "CORRUPT_RESTRICTION_RECORD"
  | "RESTRICTION_PERSISTENCE_FAILURE";

export class ParticipantRestrictionError extends Error {
  readonly code: ParticipantRestrictionErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: ParticipantRestrictionErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "ParticipantRestrictionError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/** Malformed input. `fields` names paths only — never the rejected value. */
export class InvalidRestrictionInputError extends ParticipantRestrictionError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_RESTRICTION_INPUT", "Invalid participant restriction input");
    this.name = "InvalidRestrictionInputError";
    this.fields = fields;
  }
}

export class RestrictionNotFoundError extends ParticipantRestrictionError {
  constructor() {
    super("RESTRICTION_NOT_FOUND", "No restriction exists for this identifier");
    this.name = "RestrictionNotFoundError";
  }
}

/**
 * This scope is already actively restricted for this participant.
 *
 * Enforced by the `(participantId, activeForScope)` unique index rather than a
 * read-then-write check. Re-imposing a scope that already stands is a duplicate,
 * not a second withholding — and permitting it would make "lift the restriction"
 * ambiguous about which one.
 */
export class DuplicateActiveRestrictionError extends ParticipantRestrictionError {
  constructor(cause?: unknown) {
    super(
      "DUPLICATE_ACTIVE_RESTRICTION",
      "That capability is already actively restricted for this participant",
      cause,
    );
    this.name = "DuplicateActiveRestrictionError";
  }
}

/**
 * The restriction has already been lifted.
 *
 * `LIFTED` is terminal. Re-imposing is a **new** restriction with its own
 * instant and actor, so the history reads as two events rather than one row that
 * changed its mind — and the original lift keeps its own actor and reason.
 */
export class RestrictionAlreadyLiftedError extends ParticipantRestrictionError {
  constructor(cause?: unknown) {
    super("RESTRICTION_ALREADY_LIFTED", "That restriction has already been lifted", cause);
    this.name = "RestrictionAlreadyLiftedError";
  }
}

/**
 * The acting account holds no active `participant:restrict` entitlement.
 *
 * Raised before any participant or restriction state is read, so an unauthorized
 * caller learns nothing about the target — not whether it exists, not its
 * status, and not what restrictions it carries.
 *
 * **Holding `activation:review` is not enough.** The two are independent grants:
 * a reviewer of admissions is not automatically a restrictor of commerce, and
 * restriction reaches capabilities an activation review never touches.
 *
 * `reasonCodes` are members of the closed `INTERNAL_AUTHORIZATION_REASON_CODES`
 * vocabulary. None names the account or anything about the participant.
 */
export class RestrictionActorNotAuthorizedError extends ParticipantRestrictionError {
  readonly reasonCodes: string[];
  /** The internal capability that was required. Always reported. */
  readonly requiredCapability = "participant:restrict";
  constructor(reasonCodes: string[] = ["INTERNAL_CAPABILITY_NOT_GRANTED"]) {
    super(
      "RESTRICTION_ACTOR_NOT_AUTHORIZED",
      "This account is not authorized to impose or lift participant restrictions",
    );
    this.name = "RestrictionActorNotAuthorizedError";
    this.reasonCodes = reasonCodes;
  }
}

/**
 * The actor holds the entitlement but may not act on **this** participant.
 *
 * Separation of duties, extending 0M.8's rule from activation review to
 * restriction: an account may restrict other participants and may never impose
 * or lift a restriction on the participant it owns. Lifting one's own is the
 * sharper half — it would let an operator restore their own commerce — and
 * imposing is refused on the same principle rather than left as an asymmetry
 * someone has to reason about.
 *
 * Deliberately a separate error from `RestrictionActorNotAuthorizedError`: the
 * caller *is* authorized to restrict generally, and being told otherwise would
 * send them looking for a grant they already hold.
 *
 * Carries no identifier — naming either account would disclose the very linkage
 * the refusal is about.
 */
export class RestrictionSelfActionNotPermittedError extends ParticipantRestrictionError {
  constructor() {
    super(
      "RESTRICTION_SELF_ACTION_NOT_PERMITTED",
      "An internal actor may not impose or lift a restriction on a participant owned by the same account",
    );
    this.name = "RestrictionSelfActionNotPermittedError";
  }
}

export class CorruptRestrictionRecordError extends ParticipantRestrictionError {
  readonly fields: string[];
  constructor(fields: string[], cause?: unknown) {
    super("CORRUPT_RESTRICTION_RECORD", "A stored restriction record failed validation", cause);
    this.name = "CorruptRestrictionRecordError";
    this.fields = fields;
  }
}

export class RestrictionPersistenceFailureError extends ParticipantRestrictionError {
  readonly stage: string;
  constructor(stage: string, cause?: unknown) {
    super("RESTRICTION_PERSISTENCE_FAILURE", "A restriction persistence operation failed", cause);
    this.name = "RestrictionPersistenceFailureError";
    this.stage = stage;
  }
}
