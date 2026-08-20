/**
 * Notification obligation errors (Phase 0M.N1).
 *
 * Two rules inherited from every error module here — no error carries private
 * data, and internal causes are non-enumerable — plus one specific to this
 * domain:
 *
 *   **No error carries notice content.** An obligation deliberately cannot hold
 *   a subject line or a body; an error raised while manipulating one must not
 *   become the channel that does. Errors name identifiers and closed-enum members
 *   only.
 */

import { attachInternalCause } from "../product/error-cause";

export type NotificationObligationErrorCode =
  | "INVALID_OBLIGATION_INPUT"
  | "OBLIGATION_NOT_FOUND"
  | "DUPLICATE_OBLIGATION"
  | "INVALID_OBLIGATION_TRANSITION"
  | "RECIPIENT_PARTICIPANT_NOT_FOUND"
  | "OFFER_VERSION_NOT_FOUND"
  | "CORRUPT_OBLIGATION_RECORD"
  | "OBLIGATION_PERSISTENCE_FAILURE";

export class NotificationObligationServiceError extends Error {
  readonly code: NotificationObligationErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: NotificationObligationErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "NotificationObligationServiceError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/** Malformed input. `fields` names paths only — never the rejected value. */
export class InvalidObligationInputError extends NotificationObligationServiceError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_OBLIGATION_INPUT", "Invalid notification obligation input");
    this.name = "InvalidObligationInputError";
    this.fields = fields;
  }
}

export class ObligationNotFoundError extends NotificationObligationServiceError {
  constructor() {
    super("OBLIGATION_NOT_FOUND", "No notification obligation exists for this identifier");
    this.name = "ObligationNotFoundError";
  }
}

/**
 * An obligation with this deduplication identity already exists.
 *
 * Enforced by the `obligationKey` unique index rather than a read-then-write
 * check, so two concurrent recordings of the same governed event cannot both
 * succeed.
 *
 * **Raised only by the general create path.** The Offer-change path treats the
 * same condition as *already satisfied* and returns the existing row: replaying
 * one governed Offer change must not fail, and must not produce a second notice
 * either.
 */
export class DuplicateObligationError extends NotificationObligationServiceError {
  constructor(cause?: unknown) {
    super("DUPLICATE_OBLIGATION", "That notification obligation already exists", cause);
    this.name = "DuplicateObligationError";
  }
}

/**
 * A lifecycle change the transition table forbids.
 *
 * Carries the attempted transition — both ends are members of a closed public
 * enum, so naming them discloses nothing the caller did not already supply. The
 * consequential refusals are backwards: "unread again" would erase that someone
 * looked, and re-opening a resolved obligation would misrepresent a second event
 * as the first.
 */
export class InvalidObligationTransitionError extends NotificationObligationServiceError {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) {
    super("INVALID_OBLIGATION_TRANSITION", "That obligation status change is not permitted");
    this.name = "InvalidObligationTransitionError";
    this.from = from;
    this.to = to;
  }
}

export class RecipientParticipantNotFoundError extends NotificationObligationServiceError {
  constructor(cause?: unknown) {
    super(
      "RECIPIENT_PARTICIPANT_NOT_FOUND",
      "No participant exists to be owed this obligation",
      cause,
    );
    this.name = "RecipientParticipantNotFoundError";
  }
}

/**
 * The Offer source version the change names does not exist.
 *
 * An obligation binds to an exact version, so a version that was never persisted
 * would produce a notice about a change nobody can look up.
 */
export class OfferVersionNotFoundError extends NotificationObligationServiceError {
  constructor() {
    super("OFFER_VERSION_NOT_FOUND", "No Offer source version exists for that record and version");
    this.name = "OfferVersionNotFoundError";
  }
}

export class CorruptObligationRecordError extends NotificationObligationServiceError {
  readonly fields: string[];
  constructor(fields: string[], cause?: unknown) {
    super("CORRUPT_OBLIGATION_RECORD", "A stored obligation record failed validation", cause);
    this.name = "CorruptObligationRecordError";
    this.fields = fields;
  }
}

export class ObligationPersistenceFailureError extends NotificationObligationServiceError {
  readonly stage: string;
  constructor(stage: string, cause?: unknown) {
    super("OBLIGATION_PERSISTENCE_FAILURE", "An obligation persistence operation failed", cause);
    this.name = "ObligationPersistenceFailureError";
    this.stage = stage;
  }
}
