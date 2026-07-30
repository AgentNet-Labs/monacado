/**
 * Internal operational status errors (Phase 0E.7.4.1).
 *
 * Four. The status service composes Phase 0E.7.3 services that already report
 * recent-run and health faults precisely, and re-raising those under status names
 * would give one fault two vocabularies — so `InvalidWorkerRunInputError` (bad
 * limit, bad freshness window, a run completing after the assessment instant)
 * propagates unchanged.
 *
 * What is genuinely new is faults of *this boundary*: a malformed request, a
 * refused caller, a read that failed, and a response that would not satisfy its
 * own safety contract.
 *
 * Deliberately NOT errors: `NO_HISTORY` (an assessment — a worker that has never
 * run is a fact, not a fault) and an empty recent-run list.
 *
 * Every error carries a stable code and, at most, bounded field paths. Never a
 * credential, endpoint, payload, receipt body, hash, token, environment value,
 * caller-supplied value, or raw Prisma/MySQL message. Internal causes use the
 * shared non-enumerable pattern.
 */

import { attachInternalCause } from "./error-cause";

export type WorkerStatusErrorCode =
  | "INVALID_WORKER_STATUS_REQUEST"
  | "WORKER_STATUS_ACCESS_DENIED"
  | "WORKER_STATUS_QUERY_FAILURE"
  | "UNSAFE_WORKER_STATUS_RESPONSE";

export class WorkerStatusError extends Error {
  readonly code: WorkerStatusErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: WorkerStatusErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "WorkerStatusError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/**
 * The request is malformed — an unknown field, an unrecognised actor type, the
 * wrong capability, or an out-of-range bound.
 *
 * `fields` names paths only. The offending *value* is never echoed: a request that
 * failed validation is exactly where an operator might have pasted a token into
 * the wrong field, and repeating it back would put it in a log.
 */
export class InvalidWorkerStatusRequestError extends WorkerStatusError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_WORKER_STATUS_REQUEST", "Invalid publication worker status request");
    this.name = "InvalidWorkerStatusRequestError";
    this.fields = fields;
  }
}

/**
 * The caller is not permitted to read publication-worker status.
 *
 * One stable code and **no detail at all** — not which check failed, not whether
 * any worker history exists, not whether the actor is known. A denial that
 * distinguished "no such actor" from "actor lacks capability", or "denied, and
 * there is nothing to see anyway" from "denied", would leak the very thing the
 * denial exists to protect.
 */
export class WorkerStatusAccessDeniedError extends WorkerStatusError {
  constructor() {
    super("WORKER_STATUS_ACCESS_DENIED", "Not authorized to read publication worker status");
    this.name = "WorkerStatusAccessDeniedError";
  }
}

/** A bounded read failed. The underlying database message is never surfaced. */
export class WorkerStatusQueryFailureError extends WorkerStatusError {
  readonly stage: string;
  constructor(stage: string, cause?: unknown) {
    super("WORKER_STATUS_QUERY_FAILURE", "A publication worker status read failed", cause);
    this.name = "WorkerStatusQueryFailureError";
    this.stage = stage;
  }
}

/**
 * The assembled response does not satisfy the strict response contract.
 *
 * The final `parse` is the enforcement gate for "no raw record escapes": rather
 * than returning data that failed its own safety schema, the read fails. Reachable
 * whenever the history port supplies a record the projection cannot narrow — which
 * is precisely the case the gate exists for.
 */
export class UnsafeWorkerStatusResponseError extends WorkerStatusError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super(
      "UNSAFE_WORKER_STATUS_RESPONSE",
      "The publication worker status response failed its safety contract",
    );
    this.name = "UnsafeWorkerStatusResponseError";
    this.fields = fields;
  }
}
