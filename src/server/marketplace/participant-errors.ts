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
