/**
 * Structured publication-remediation errors (Phase 0E.5.2).
 *
 * Stable codes; the original cause is retained for diagnostics but attached
 * NON-ENUMERABLE via the shared `attachInternalCause` pattern.
 *
 * Nothing here exposes receipt contents, the capsule payload, hash VALUES, lock
 * tokens, credentials, or raw Prisma messages. Conflicts report field NAMES and
 * bounded state names only — a state name like `CLOSED` is safe; a hash is not.
 *
 * Database failures reuse `DatabaseError` from ./errors.
 */

import { attachInternalCause } from "./error-cause";

export type PublicationRemediationErrorCode =
  | "REMEDIATION_PUBLICATION_NOT_FOUND"
  | "REMEDIATION_NOT_REQUIRED"
  | "INVALID_REMEDIATION_ACTION"
  | "REMEDIATION_CONFLICT"
  | "REMEDIATION_REPLAY_CONFLICT"
  | "PAYLOAD_UNAVAILABLE_FOR_RETRY"
  | "RETRY_TIME_REQUIRED"
  | "PUBLICATION_CLOSED"
  | "PUBLICATION_RESOLVED"
  | "PERSISTED_REMEDIATION_CONTRACT_VIOLATION";

export class PublicationRemediationError extends Error {
  readonly code: PublicationRemediationErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see ./error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: PublicationRemediationErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "PublicationRemediationError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

export class RemediationPublicationNotFoundError extends PublicationRemediationError {
  constructor(message = "Publication not found for remediation") {
    super("REMEDIATION_PUBLICATION_NOT_FOUND", message);
    this.name = "RemediationPublicationNotFoundError";
  }
}

/**
 * Nothing is open to decide — the publication is clean, or a decision has
 * already been taken. Carries the current state NAME, which is bounded and safe.
 */
export class RemediationNotRequiredError extends PublicationRemediationError {
  readonly remediationState: string;
  constructor(remediationState: string, message?: string) {
    super(
      "REMEDIATION_NOT_REQUIRED",
      message ?? `This publication does not currently require remediation (state ${remediationState})`,
    );
    this.name = "RemediationNotRequiredError";
    this.remediationState = remediationState;
  }
}

/** The requested action is not permitted from the publication's current state. */
export class InvalidRemediationActionError extends PublicationRemediationError {
  readonly action: string;
  readonly remediationState: string;
  constructor(action: string, remediationState: string, message?: string) {
    super(
      "INVALID_REMEDIATION_ACTION",
      message ?? `Remediation action ${action} is not permitted from state ${remediationState}`,
    );
    this.name = "InvalidRemediationActionError";
    this.action = action;
    this.remediationState = remediationState;
  }
}

/**
 * The publication's surrounding state contradicts the decision — e.g. a retry
 * requested for work that is already complete, or a concurrent decision won.
 */
export class RemediationConflictError extends PublicationRemediationError {
  readonly conflictingFields: string[];
  constructor(message: string, conflictingFields: string[], cause?: unknown) {
    super("REMEDIATION_CONFLICT", message, cause);
    this.name = "RemediationConflictError";
    this.conflictingFields = conflictingFields;
  }
}

/** The same `remediationId` was replayed with different data. Field names only. */
export class RemediationReplayConflictError extends PublicationRemediationError {
  readonly conflictingFields: string[];
  constructor(message: string, conflictingFields: string[]) {
    super("REMEDIATION_REPLAY_CONFLICT", message, conflictingFields);
    this.name = "RemediationReplayConflictError";
    this.conflictingFields = conflictingFields;
  }
}

/**
 * RETRY is impossible because the capsule body was disposed of after a matching
 * acceptance. Nothing can be re-submitted, and this phase does not regenerate a
 * payload or create a replacement publication.
 */
export class PayloadUnavailableForRetryError extends PublicationRemediationError {
  constructor(message = "The capsule payload is no longer retained, so a retry cannot be authorised") {
    super("PAYLOAD_UNAVAILABLE_FOR_RETRY", message);
    this.name = "PayloadUnavailableForRetryError";
  }
}

/** RETRY was requested without the explicit time the work becomes eligible. */
export class RetryTimeRequiredError extends PublicationRemediationError {
  constructor(message = "RETRY requires an explicit retryAvailableAt") {
    super("RETRY_TIME_REQUIRED", message);
    this.name = "RetryTimeRequiredError";
  }
}

/**
 * The publication was deliberately closed. Reopening is a future phase — a later
 * receipt cannot quietly undo a governed decision.
 */
export class PublicationClosedError extends PublicationRemediationError {
  constructor(message = "This publication was closed by a governed remediation decision") {
    super("PUBLICATION_CLOSED", message);
    this.name = "PublicationClosedError";
  }
}

/** The publication was already settled by a matching acceptance. */
export class PublicationResolvedError extends PublicationRemediationError {
  constructor(message = "This publication is already resolved") {
    super("PUBLICATION_RESOLVED", message);
    this.name = "PublicationResolvedError";
  }
}

export class PersistedRemediationContractViolationError extends PublicationRemediationError {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super("PERSISTED_REMEDIATION_CONTRACT_VIOLATION", message, issues);
    this.name = "PersistedRemediationContractViolationError";
    this.issues = issues;
  }
}
