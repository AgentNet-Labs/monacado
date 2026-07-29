/**
 * Worker runtime / entry-point errors (Phase 0E.7.2).
 *
 * One. The entry point composes services that already report configuration,
 * transport, claim, attempt, orchestration, and cycle faults precisely; re-raising
 * those under command names would give one fault two vocabularies.
 *
 * What is genuinely new is a **runtime dependency that cannot be constructed** —
 * the transport, the retry policy, the database client, or the clock — discovered
 * before any work is claimed.
 *
 * Deliberately NOT errors, each with its reason:
 *
 *   - **invalid or incomplete worker configuration.** Returned as the `INVALID` /
 *     `INCOMPLETE` load states, exactly as Phase 0E.6.2 does. A one-shot command
 *     must emit a safe machine-readable line and set a non-zero exit code; an
 *     exception is a poor carrier for that, and an operator does not need a stack
 *     trace to be told a variable is unset. Error classes mirroring those states
 *     were written and removed as unreachable vocabulary.
 *   - **monitoring output failure.** Handled inside the output adapter, which
 *     falls back to a minimal safe line and otherwise swallows. Letting
 *     observability throw would make it a source of publication failures, and a
 *     line written after a transmitted request cannot unsend it.
 *   - **resource cleanup failure.** Recorded as a bounded issue code after the
 *     cycle has already finished. Nothing remains to be undone, and turning it
 *     into a throw would obscure the cycle outcome the operator actually needs.
 *   - **direct-runner failure.** The guard returns a boolean; a `main` rejection
 *     is classified inside `main` itself, which is what makes the exit code
 *     deterministic.
 *
 * Errors carry a stable code and a stage name only — never a credential, a secret
 * variable's name, an endpoint, a payload, a hash, a token, a receipt body, an
 * environment dump, or a raw database/network message. Internal causes use the
 * shared non-enumerable pattern, so `JSON.stringify(error)` cannot leak one.
 */

import { attachInternalCause } from "./error-cause";

export type WorkerRuntimeErrorCode = "WORKER_DEPENDENCY_CONSTRUCTION_FAILURE";

/**
 * Which dependency could not be built. A closed set of internal stage names,
 * safe to emit: none of them names a variable, a host, or a value.
 */
export const WORKER_STARTUP_STAGES = ["transport", "retryTiming", "database", "clock"] as const;
export type WorkerStartupStage = (typeof WORKER_STARTUP_STAGES)[number];

export class WorkerRuntimeError extends Error {
  readonly code: WorkerRuntimeErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: WorkerRuntimeErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "WorkerRuntimeError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/**
 * A runtime dependency could not be constructed, so no cycle was started.
 *
 * Raised **before any item is claimed**, which is the property that matters: a
 * startup failure cannot leave a claimed outbox item behind, because nothing had
 * been claimed when it was raised.
 */
export class WorkerDependencyConstructionFailureError extends WorkerRuntimeError {
  readonly stage: WorkerStartupStage;
  constructor(stage: WorkerStartupStage, cause?: unknown) {
    super(
      "WORKER_DEPENDENCY_CONSTRUCTION_FAILURE",
      "A publication worker runtime dependency could not be constructed",
      cause,
    );
    this.name = "WorkerDependencyConstructionFailureError";
    this.stage = stage;
  }
}
