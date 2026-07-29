/**
 * Single-run orchestration errors (Phase 0E.6.3).
 *
 * Deliberately few. The orchestrator composes services that already have rich
 * error vocabularies — claiming, attempt preparation, dispatch, receipts,
 * remediation — and duplicating those would produce two names for one fault.
 * These cover only what is genuinely new: faults of the *orchestration itself*.
 *
 * Most abnormal endings are not errors at all. A retryable failure, a terminal
 * remote failure, and an ambiguous delivery are all normal, expected results
 * carried in `PublicationRunResult`, because a caller must distinguish eight
 * outcomes and act differently on each.
 *
 * Errors expose codes and field names only — never a credential, payload,
 * response body, hash, lock token, endpoint URL, or raw Prisma/network message.
 * Internal causes use the shared non-enumerable `attachInternalCause` pattern.
 */

import { attachInternalCause } from "./error-cause";

export type PublicationRunErrorCode =
  | "INVALID_RUN_INPUT"
  | "RUNTIME_NOT_READY"
  | "RETRY_TIME_REQUIRED"
  | "RUN_STATE_CONFLICT"
  | "POST_TRANSPORT_PERSISTENCE_FAILURE";

export class PublicationRunError extends Error {
  readonly code: PublicationRunErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: PublicationRunErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "PublicationRunError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/** The run input is malformed. `fields` names paths only. */
export class InvalidRunInputError extends PublicationRunError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_RUN_INPUT", "Invalid single-run publication input");
    this.name = "InvalidRunInputError";
    this.fields = fields;
  }
}

/**
 * The runtime configuration is neither DISABLED nor READY.
 *
 * Thrown BEFORE any work is claimed. An INCOMPLETE or INVALID configuration is
 * an operator fault, and claiming an item under it would take a lease we cannot
 * possibly use — leaving real work locked until the lease expired.
 */
export class RuntimeNotReadyError extends PublicationRunError {
  readonly state: string;
  constructor(state: string) {
    super("RUNTIME_NOT_READY", `Registrar runtime configuration is not usable (${state})`);
    this.name = "RuntimeNotReadyError";
    this.state = state;
  }
}

/**
 * A retryable failure occurred but the caller supplied no `retryAvailableAt`.
 *
 * Not silently defaulted: inventing a retry time here would be this module
 * reading a clock and choosing a backoff, which is exactly the policy decision
 * the phase keeps with the caller.
 */
export class RunRetryTimeRequiredError extends PublicationRunError {
  constructor() {
    super("RETRY_TIME_REQUIRED", "A retryable failure requires an explicit retryAvailableAt");
    this.name = "RunRetryTimeRequiredError";
  }
}

/**
 * The claim this run owned is no longer current — recovered, re-claimed,
 * remediated, or its publication settled — discovered while applying an outcome.
 */
export class RunStateConflictError extends PublicationRunError {
  readonly fields: string[];
  constructor(message: string, fields: string[], cause?: unknown) {
    super("RUN_STATE_CONFLICT", message, cause);
    this.name = "RunStateConflictError";
    this.fields = fields;
  }
}

/**
 * The request was sent, but recording the consequence failed.
 *
 * This is the most dangerous state in the phase and gets its own name: the
 * durable record no longer describes what happened to the outside world. It is
 * reported as an INDETERMINATE outcome and **never** triggers a resend — the
 * Registrar may already hold the registration.
 */
export class PostTransportPersistenceFailureError extends PublicationRunError {
  readonly transmitted: boolean;
  constructor(transmitted: boolean, cause?: unknown) {
    super(
      "POST_TRANSPORT_PERSISTENCE_FAILURE",
      "The request was sent but its outcome could not be recorded",
      cause,
    );
    this.name = "PostTransportPersistenceFailureError";
    this.transmitted = transmitted;
  }
}
