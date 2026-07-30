/**
 * Worker-run status errors (Phase 0E.7.3).
 *
 * Five. The worker-run table is operational evidence, so most of what can go wrong
 * with it is an ordinary condition a caller should read from a result rather than
 * catch — but a *lifecycle* fault is different: it means the durable history no
 * longer describes what happened, and silently returning a value would let a
 * caller record a second truth.
 *
 * Deliberately NOT errors, each for a reason:
 *
 *   - **a stale sweep finding nothing.** Returned as zeroed counts. Nothing is
 *     wrong with a queue of abandoned runs that is empty.
 *   - **a run genuinely having no history to assess.** `NO_HISTORY` is a health
 *     assessment, not a fault: a freshly deployed worker has no runs, and that is
 *     the correct answer rather than an exception.
 *   - **an identical terminal replay.** Returns the existing durable record, which
 *     is the whole point of idempotency.
 *   - **worker-run persistence failing mid-command.** The *entry point* turns that
 *     into a bounded issue code and a non-zero exit code, because by then the
 *     publication work has already happened and the orchestration's own result is
 *     authoritative. `WorkerRunPersistenceFailureError` exists for the narrower
 *     case where a caller must distinguish a failed write from a successful one.
 *
 * Every error carries a stable code and, at most, a `cycleId` — which is an opaque
 * correlation id already present in the command's own output. Never a credential,
 * endpoint, payload, receipt body, hash, token, environment value, or raw
 * Prisma/MySQL message. Internal causes use the shared non-enumerable pattern, so
 * `JSON.stringify(error)` cannot leak one.
 */

import { attachInternalCause } from "./error-cause";

export type WorkerRunErrorCode =
  | "INVALID_WORKER_RUN_INPUT"
  | "DUPLICATE_WORKER_RUN_CYCLE_ID"
  | "WORKER_RUN_NOT_FOUND"
  | "WORKER_RUN_TERMINAL_CONFLICT"
  | "WORKER_RUN_PERSISTENCE_FAILURE";

export class WorkerRunError extends Error {
  readonly code: WorkerRunErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: WorkerRunErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "WorkerRunError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/**
 * Lifecycle input is malformed — including an out-of-bounds counter, an unsafe
 * issue code, or an unknown field. `fields` names paths only.
 *
 * An unsafe issue code is refused here rather than scrubbed: quietly dropping the
 * offending entry would store a run whose recorded issues differ from the ones the
 * caller observed, and truncating it is exactly how half a driver message ends up
 * in durable storage.
 */
export class InvalidWorkerRunInputError extends WorkerRunError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_WORKER_RUN_INPUT", "Invalid publication worker-run input");
    this.name = "InvalidWorkerRunInputError";
    this.fields = fields;
  }
}

/**
 * A run already exists for this cycle id.
 *
 * Reachable because `cycleId` is unique: two invocations that somehow shared an
 * operator-supplied `MONACADO_PUBLICATION_WORKER_CYCLE_ID` must not silently
 * overwrite one another's evidence.
 */
export class DuplicateWorkerRunCycleIdError extends WorkerRunError {
  readonly cycleId: string;
  constructor(cycleId: string, cause?: unknown) {
    super(
      "DUPLICATE_WORKER_RUN_CYCLE_ID",
      "A publication worker run already exists for this cycle id",
      cause,
    );
    this.name = "DuplicateWorkerRunCycleIdError";
    this.cycleId = cycleId;
  }
}

/** No run exists for the cycle id a lifecycle update named. */
export class WorkerRunNotFoundError extends WorkerRunError {
  readonly cycleId: string;
  constructor(cycleId: string) {
    super("WORKER_RUN_NOT_FOUND", "No publication worker run exists for this cycle id", undefined);
    this.name = "WorkerRunNotFoundError";
    this.cycleId = cycleId;
  }
}

/**
 * The run is already terminal and the new terminal state disagrees with it.
 *
 * Terminal history is never rewritten. A run that reported COMPLETED and is later
 * told it FAILED describes two different pasts, and the first one is the one an
 * operator has already acted on.
 */
export class WorkerRunTerminalConflictError extends WorkerRunError {
  readonly cycleId: string;
  readonly currentStatus: string;
  constructor(cycleId: string, currentStatus: string) {
    super(
      "WORKER_RUN_TERMINAL_CONFLICT",
      "This publication worker run is already terminal and cannot be rewritten",
    );
    this.name = "WorkerRunTerminalConflictError";
    this.cycleId = cycleId;
    this.currentStatus = currentStatus;
  }
}

/**
 * The durable write itself failed.
 *
 * Distinguished from the faults above because the caller's next move differs: a
 * conflict means the history is intact and disagrees, while this means the history
 * may be missing. The raw database message is never surfaced.
 */
export class WorkerRunPersistenceFailureError extends WorkerRunError {
  readonly stage: string;
  constructor(stage: string, cause?: unknown) {
    super("WORKER_RUN_PERSISTENCE_FAILURE", "A publication worker-run write failed", cause);
    this.name = "WorkerRunPersistenceFailureError";
    this.stage = stage;
  }
}
