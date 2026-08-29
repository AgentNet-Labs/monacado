/**
 * Governed participant-mitigation errors (Phase 1.14) — SERVER ONLY.
 *
 * No error here carries a participant name, an amount, a rate, a score, or a
 * buyer detail — an error object is where operational detail leaks into a log.
 * Every one is a bounded code a caller can act on.
 */

import "../server-only";

export class ParticipantMitigationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ParticipantMitigationError";
    this.code = code;
  }
}

/**
 * The ACTIVE Marketplace Policy version does not authorise acting on a
 * participant.
 *
 * FAILS CLOSED, and it is the mechanism that makes Phase 1.13's recorded
 * requirement real rather than documentary. 1.2.0 authorises declining, holding,
 * or reversing a TRANSACTION on risk grounds and says nothing about withholding
 * what a participant may do next; a deployment still governed by it may run the
 * analytics and record a Staff review, and may do nothing else.
 *
 * Checked against the version ACTIVE IN THE DATABASE, never the newest version
 * shipped — publishing a document is not the same act as governing under it.
 */
export class ParticipantMitigationNotAuthorizedByPolicyError extends ParticipantMitigationError {
  readonly activePolicyVersion: string | null;
  constructor(activePolicyVersion: string | null) {
    super(
      "PARTICIPANT_MITIGATION_NOT_AUTHORIZED_BY_POLICY",
      "The active Marketplace Policy version does not authorise participant-level mitigation",
    );
    this.name = "ParticipantMitigationNotAuthorizedByPolicyError";
    this.activePolicyVersion = activePolicyVersion;
  }
}

/** The caller does not hold the entitlement this act requires. */
export class SuspensionActorNotAuthorizedError extends ParticipantMitigationError {
  readonly reasonCodes: readonly string[];
  constructor(reasonCodes: readonly string[]) {
    super("SUSPENSION_ACTOR_NOT_AUTHORIZED", "This account may not suspend or reinstate");
    this.name = "SuspensionActorNotAuthorizedError";
    this.reasonCodes = [...reasonCodes];
  }
}

/**
 * A person may not decide a matter concerning their own participant account.
 *
 * The only structural independence Monacado can offer, and the policy says so
 * rather than claiming an independent reviewer that does not exist.
 */
export class SuspensionSelfActionNotPermittedError extends ParticipantMitigationError {
  constructor() {
    super(
      "SUSPENSION_SELF_ACTION_NOT_PERMITTED",
      "An account may not suspend or reinstate its own participant",
    );
    this.name = "SuspensionSelfActionNotPermittedError";
  }
}

/** A second suspension while one already stands. The same fact, not a second one. */
export class ParticipantAlreadySuspendedError extends ParticipantMitigationError {
  constructor() {
    super("PARTICIPANT_ALREADY_SUSPENDED", "This participant already has an active suspension");
    this.name = "ParticipantAlreadySuspendedError";
  }
}

/** A concurrent reinstatement won. `LIFTED` is terminal. */
export class SuspensionAlreadyLiftedError extends ParticipantMitigationError {
  constructor() {
    super("SUSPENSION_ALREADY_LIFTED", "That suspension has already been lifted");
    this.name = "SuspensionAlreadyLiftedError";
  }
}

export class SuspensionNotFoundError extends ParticipantMitigationError {
  constructor() {
    super("SUSPENSION_NOT_FOUND", "No such suspension");
    this.name = "SuspensionNotFoundError";
  }
}

/** One reconsideration per decision, and none once the decision is lifted. */
export class ReconsiderationNotAvailableError extends ParticipantMitigationError {
  readonly reasonCode: string;
  constructor(reasonCode: string) {
    super("RECONSIDERATION_NOT_AVAILABLE", "Reconsideration is not available for that decision");
    this.name = "ReconsiderationNotAvailableError";
    this.reasonCode = reasonCode;
  }
}

export class ReconsiderationNotFoundError extends ParticipantMitigationError {
  constructor() {
    super("RECONSIDERATION_NOT_FOUND", "No such reconsideration");
    this.name = "ReconsiderationNotFoundError";
  }
}

export class ReconsiderationTransitionError extends ParticipantMitigationError {
  constructor(message: string) {
    super("RECONSIDERATION_TRANSITION_REFUSED", message);
    this.name = "ReconsiderationTransitionError";
  }
}

/** A malformed or unusable request reached a mitigation path. */
export class ParticipantMitigationRequestError extends ParticipantMitigationError {
  constructor(message: string) {
    super("PARTICIPANT_MITIGATION_REQUEST_INVALID", message);
    this.name = "ParticipantMitigationRequestError";
  }
}
