/**
 * Participant closure errors (Phase 1.17) — SERVER ONLY.
 *
 * On `participant-mitigation-errors`' terms: no error here carries a participant
 * name, an account identifier, a reason, or a status — an error object is where
 * operational detail leaks into a log. Every one is a bounded code a caller can
 * act on.
 */

import "../server-only";

export class ParticipantClosureError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ParticipantClosureError";
    this.code = code;
  }
}

/**
 * The caller is not the participant.
 *
 * ANSWERED AS NOT-FOUND, deliberately, and this is the same refusal
 * `requestReconsideration` already makes for the participant's own act. An
 * unauthorized caller learns nothing from it: not whether the participant
 * exists, not what status it holds, and not whether a decision stands against
 * it. A distinct "not yours" error would confirm existence to anybody who could
 * guess an identifier.
 *
 * It is also what a genuinely missing participant gets, so the two are
 * indistinguishable from outside — which is the point.
 */
export class ParticipantClosureNotFoundError extends ParticipantClosureError {
  constructor() {
    super("PARTICIPANT_CLOSURE_NOT_FOUND", "No such participant");
    this.name = "ParticipantClosureNotFoundError";
  }
}

/**
 * The participant is already closed.
 *
 * A refusal rather than a second row: closure is terminal, `CLOSED` has no
 * outgoing transition in the 0M.1 table, and re-closing would either duplicate
 * the record or overwrite the instant and reason of the real one. The unique
 * `participantId` enforces it in MySQL as well, so a concurrent second attempt
 * contends rather than both proceeding.
 */
export class ParticipantAlreadyClosedError extends ParticipantClosureError {
  constructor() {
    super("PARTICIPANT_ALREADY_CLOSED", "This participant is already closed");
    this.name = "ParticipantAlreadyClosedError";
  }
}

/**
 * The act was refused because the participant's lifecycle is terminal.
 *
 * Raised by the seams that must not let a closed participant acquire NEW state —
 * a new sale, a new governed restriction. Distinct from
 * `ParticipantActionNotPermittedError`, which reports a mitigation decision
 * (`PARTICIPANT_SUSPENDED` / `ACTION_RESTRICTED`) and would misdescribe this:
 * nothing was withheld from this participant, they ended their participation.
 */
export class ParticipantLifecycleTerminatedError extends ParticipantClosureError {
  constructor() {
    super(
      "PARTICIPANT_LIFECYCLE_TERMINATED",
      "This participant has closed and may not take part in new marketplace activity",
    );
    this.name = "ParticipantLifecycleTerminatedError";
  }
}

/** The supplied closure request did not parse. */
export class ParticipantClosureRequestError extends ParticipantClosureError {
  constructor(message: string) {
    super("PARTICIPANT_CLOSURE_REQUEST_INVALID", message);
    this.name = "ParticipantClosureRequestError";
  }
}

/** Persistence failed for a reason that is not a domain refusal. */
export class ParticipantClosurePersistenceFailureError extends ParticipantClosureError {
  readonly operation: string;
  constructor(operation: string, cause: unknown) {
    super("PARTICIPANT_CLOSURE_PERSISTENCE_FAILURE", `Closure persistence failed: ${operation}`);
    this.name = "ParticipantClosurePersistenceFailureError";
    this.operation = operation;
    this.cause = cause;
  }
}
