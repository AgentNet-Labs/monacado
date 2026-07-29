/**
 * Worker-cycle errors (Phase 0E.7.1).
 *
 * Three. The cycle composes services that already report claim, attempt,
 * transport, receipt, remediation, and orchestration faults precisely; re-raising
 * those under cycle names would give one fault two vocabularies.
 *
 * What is genuinely new is faults of the *cycle's own collaborators*: malformed
 * cycle input, and a provider that cannot supply the time or the attempt identity
 * a run requires.
 *
 * Deliberately NOT errors: a failed individual run, a monitoring-hook failure, or
 * expired-claim recovery failing. Each is collected as a bounded issue code and
 * the cycle result reports it, because none of them makes the cycle's own
 * accounting untrue — and turning a hook failure into a thrown error would let
 * observability break correctness.
 *
 * Errors carry codes and field names only. Internal causes use the shared
 * non-enumerable pattern.
 */

import { attachInternalCause } from "./error-cause";

export type WorkerCycleErrorCode =
  | "INVALID_WORKER_CYCLE_INPUT"
  | "TIME_PROVIDER_FAILURE"
  | "ATTEMPT_ID_PROVIDER_FAILURE";

export class WorkerCycleError extends Error {
  readonly code: WorkerCycleErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: WorkerCycleErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "WorkerCycleError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/**
 * The cycle input is malformed — including a `maximumRuns` outside its bounds,
 * which is the same fault as any other invalid field and does not need its own
 * class. `fields` names paths only.
 */
export class InvalidWorkerCycleInputError extends WorkerCycleError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_WORKER_CYCLE_INPUT", "Invalid publication worker-cycle input");
    this.name = "InvalidWorkerCycleInputError";
    this.fields = fields;
  }
}

/**
 * The injected clock threw, or returned something that is not a usable instant.
 *
 * Fatal rather than collected: every durable record the orchestration writes is
 * stamped with these instants, and continuing without a trustworthy clock would
 * write a timeline that never happened.
 */
export class TimeProviderFailureError extends WorkerCycleError {
  constructor(cause?: unknown) {
    super("TIME_PROVIDER_FAILURE", "The injected time provider did not return a usable instant", cause);
    this.name = "TimeProviderFailureError";
  }
}

/**
 * The injected attempt-id provider threw, or returned an id the contracts refuse.
 *
 * Also fatal. A run cannot proceed without a valid attempt identity, and
 * inventing one here is exactly what the injected provider exists to prevent.
 */
export class AttemptIdProviderFailureError extends WorkerCycleError {
  constructor(cause?: unknown) {
    super(
      "ATTEMPT_ID_PROVIDER_FAILURE",
      "The injected submission-attempt id provider did not return a usable id",
      cause,
    );
    this.name = "AttemptIdProviderFailureError";
  }
}
