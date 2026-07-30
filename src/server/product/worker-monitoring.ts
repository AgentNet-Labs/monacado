/**
 * Safe JSON-lines worker monitoring output (Phase 0E.7.2) — SERVER ONLY.
 *
 * One concrete adapter behind the Phase 0E.7.1 `WorkerCycleMonitor` interface,
 * plus the entry point's own lifecycle events. One JSON object per line, on an
 * **injected** sink, so a test asserts the exact bytes and the production command
 * is the only thing that touches a real stream.
 *
 * No logging framework, and no `console`: `console.log` interleaves and reformats,
 * and a dependency would be a lot of surface area for `write(line + "\n")`.
 *
 * ## Allow-list, not deny-list
 *
 * Every emitted line is assembled from **explicitly named fields**. Nothing is
 * spread from a domain object, so a field added to a contract later cannot appear
 * in the output by accident — it appears only when someone writes it here and
 * decides it is safe.
 *
 * Never emitted: a capsule or request payload, a receipt body, a credential, the
 * NAME of a secret variable, an endpoint or any URL, an integrity or content hash,
 * a lock token, a claim-token hash, the environment, or a raw Prisma/Zod/network
 * error. What *is* emitted: event names, a bounded cycle id, UTC ISO timestamps,
 * run indices, opaque Monacado identifiers, outcome classifications, counts, and
 * SCREAMING_SNAKE_CASE issue codes.
 *
 * ## Failure policy
 *
 * **Monitoring can never affect publication.** A sink that throws, or a value that
 * will not serialise, is contained here: the adapter attempts one minimal
 * fallback line and otherwise counts the failure and returns. It never throws at
 * the cycle, never changes an outcome, and above all never causes a resend — a
 * line written after a request was transmitted cannot unsend it.
 */

import "../server-only";
import { ERROR_CODE_RE } from "../../contracts/product/safe-error-metadata";
import type {
  TimeProvider,
  WorkerCycleMonitor,
  WorkerCycleResult,
} from "../../contracts/product/publication-worker-cycle";
import type { WorkerOutputMode } from "./worker-runtime-config";

/** Which stream a line belongs on. */
export type MonitoringStream = "stdout" | "stderr";

/** Where lines go. Injected, so tests never write to a real stream. */
export interface MonitoringSink {
  writeLine(stream: MonitoringStream, line: string): void;
}

/**
 * Stable, bounded event names. A closed list: an operator's parser and any future
 * alerting rule depend on these strings, so they are enumerated rather than
 * composed at the call site.
 *
 * **stdout carries the run's story; stderr carries what an operator must act on.**
 * Ordinary lifecycle events go to stdout so a shell pipeline can consume the
 * cycle's narrative cleanly, while configuration rejections, run failures,
 * startup failures, cleanup failures, and monitoring's own failure go to stderr so
 * they survive a caller that discards stdout.
 */
export const WORKER_EVENTS = {
  disabled: "worker.disabled",
  configurationRejected: "worker.configuration_rejected",
  registrarNotReady: "worker.registrar_not_ready",
  startupFailure: "worker.startup_failure",
  cycleStarted: "worker.cycle_started",
  expiredClaimsRecovered: "worker.expired_claims_recovered",
  runStarted: "worker.run_started",
  runCompleted: "worker.run_completed",
  runFailed: "worker.run_failed",
  cycleCompleted: "worker.cycle_completed",
  result: "worker.result",
  cleanupFailed: "worker.cleanup_failed",
  monitoringFailure: "worker.monitoring_failure",
  /**
   * Durable worker-run status (Phase 0E.7.3). These lines *announce* what was
   * written; the durable row is the authority, and this channel is secondary.
   */
  runStatusStarted: "worker.run_status_started",
  runStatusPersisted: "worker.run_status_persisted",
  runStatusPersistenceFailed: "worker.run_status_persistence_failed",
} as const;

export type WorkerEventName = (typeof WORKER_EVENTS)[keyof typeof WORKER_EVENTS];

/** Cap on how many field names or issue codes one line may carry. */
const MAX_REPORTED_CODES = 32;

/** A JSON-safe scalar. No objects, so nothing nested can smuggle a payload. */
type SafeValue = string | number | boolean | readonly string[] | Record<string, number>;

/**
 * Keep only codes that already satisfy the shared safe-code shape, and bound the
 * count. A code that fails the shape is dropped rather than truncated: an
 * unrecognised string is exactly where a raw driver message would arrive.
 */
function safeCodes(codes: readonly string[]): string[] {
  const kept: string[] = [];
  for (const code of codes) {
    if (kept.length >= MAX_REPORTED_CODES) break;
    if (typeof code === "string" && ERROR_CODE_RE.test(code) && !kept.includes(code)) {
      kept.push(code);
    }
  }
  return kept;
}

/**
 * Copy only the finite numeric entries of a counts record.
 *
 * Used for `outcomeCounts` and recovery counts, which the Phase 0E.7.1 contract
 * already validates as closed records of integers. Filtering again means that even
 * if such a record were ever constructed outside the schema, a non-numeric value
 * could not ride along into the output.
 */
function numberFields(source: Readonly<Record<string, unknown>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/** Bound and shape-check configuration field names before they are reported. */
function safeFieldNames(fields: readonly string[]): string[] {
  const kept: string[] = [];
  for (const field of fields) {
    if (kept.length >= MAX_REPORTED_CODES) break;
    if (typeof field === "string" && /^[A-Za-z0-9._:() -]{1,191}$/.test(field)) {
      kept.push(field);
    }
  }
  return kept;
}

export interface WorkerCommandReporterOptions {
  sink: MonitoringSink;
  /** Injected clock. The adapter reads no global time. */
  time: TimeProvider;
  cycleId: string;
  outputMode: WorkerOutputMode;
}

/**
 * The command's single output surface.
 *
 * It carries both the entry point's own events and — via
 * `asWorkerCycleMonitor()` — the Phase 0E.7.1 hooks, so every line for one
 * invocation is stamped with the same cycle id and formatted identically.
 */
export class WorkerCommandReporter {
  /** Lines that could not be written or serialised. Observable for tests. */
  private failures = 0;

  constructor(private readonly options: WorkerCommandReporterOptions) {}

  get outputFailures(): number {
    return this.failures;
  }

  // — Entry-point lifecycle —

  disabled(): void {
    this.emit("stdout", WORKER_EVENTS.disabled, { outcome: "DISABLED" });
  }

  configurationRejected(code: string, fields: readonly string[]): void {
    this.emit("stderr", WORKER_EVENTS.configurationRejected, {
      code: safeCodes([code])[0] ?? "INVALID_WORKER_CONFIGURATION",
      fields: safeFieldNames(fields),
    });
  }

  registrarNotReady(code: string, fields: readonly string[]): void {
    this.emit("stderr", WORKER_EVENTS.registrarNotReady, {
      code: safeCodes([code])[0] ?? "REGISTRAR_NOT_READY",
      fields: safeFieldNames(fields),
    });
  }

  startupFailure(code: string, stage: string): void {
    this.emit("stderr", WORKER_EVENTS.startupFailure, {
      code: safeCodes([code])[0] ?? "WORKER_STARTUP_FAILURE",
      stage: safeFieldNames([stage])[0] ?? "unknown",
    });
  }

  cleanupFailed(code: string): void {
    this.emit("stderr", WORKER_EVENTS.cleanupFailed, {
      code: safeCodes([code])[0] ?? "RESOURCE_CLEANUP_FAILURE",
    });
  }

  // — Durable worker-run status (Phase 0E.7.3) —
  //
  // Announcements only. The durable row is the authority; these lines exist so an
  // operator watching the stream knows a row was written, and they carry no
  // database identifier, SQL text, connection detail, or raw cause.

  /** A STARTED row now exists and the cycle is about to run. */
  runStatusStarted(): void {
    this.emit("stdout", WORKER_EVENTS.runStatusStarted, { status: "STARTED" });
  }

  /** A terminal row was written. */
  runStatusPersisted(status: string, outcome: string | null): void {
    this.emit("stdout", WORKER_EVENTS.runStatusPersisted, {
      status: safeCodes([status])[0] ?? "UNKNOWN",
      ...(outcome !== null ? { outcome: safeCodes([outcome])[0] ?? "UNKNOWN" } : {}),
    });
  }

  /**
   * A durable write failed. The bounded code is the whole message: the underlying
   * database error is never surfaced, because this is exactly where a connection
   * string or a driver dump would otherwise appear.
   */
  runStatusPersistenceFailed(stage: string, code: string): void {
    this.emit("stderr", WORKER_EVENTS.runStatusPersistenceFailed, {
      stage: safeFieldNames([stage])[0] ?? "unknown",
      code: safeCodes([code])[0] ?? "RUN_STATUS_PERSISTENCE_FAILURE",
    });
  }

  /**
   * The final validated cycle result.
   *
   * Projected field by field from the Phase 0E.7.1 contract. `outcomeCounts` is a
   * closed record of integers, so emitting it wholesale cannot carry a string.
   */
  result(result: WorkerCycleResult, exitCode: number): void {
    this.emit("stdout", WORKER_EVENTS.result, {
      outcome: result.outcome,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      runsAttempted: result.runsAttempted,
      itemsClaimed: result.itemsClaimed,
      outcomeCounts: numberFields(result.outcomeCounts),
      shutdownRequested: result.shutdownRequested,
      stoppedForNoWork: result.stoppedForNoWork,
      ...(result.recovery !== undefined ? { recovery: numberFields(result.recovery) } : {}),
      issues: safeCodes(result.issues),
      exitCode,
    });
  }

  /** A cycle that threw. Classification only — never the underlying error. */
  cycleFault(code: string): void {
    this.emit("stderr", WORKER_EVENTS.startupFailure, {
      code: safeCodes([code])[0] ?? "UNCLASSIFIED_WORKER_FAILURE",
      stage: "cycle",
    });
  }

  // — Phase 0E.7.1 hooks —

  /**
   * The cycle-facing view of this reporter.
   *
   * Returned as a plain object of closures rather than `this`, so the cycle can
   * see the six hooks and nothing else — it cannot reach the entry point's own
   * event methods.
   */
  asWorkerCycleMonitor(): WorkerCycleMonitor {
    return {
      cycleStarted: (event) => {
        this.emit("stdout", WORKER_EVENTS.cycleStarted, {
          startedAt: event.startedAt,
          maximumRuns: event.maximumRuns,
        });
      },
      expiredClaimsRecovered: (event) => {
        this.emit("stdout", WORKER_EVENTS.expiredClaimsRecovered, {
          counts: numberFields(event.counts),
        });
      },
      runStarted: (event) => {
        this.emit("stdout", WORKER_EVENTS.runStarted, {
          runIndex: event.runIndex,
          submissionAttemptId: event.submissionAttemptId,
        });
      },
      runCompleted: (event) => {
        this.emit("stdout", WORKER_EVENTS.runCompleted, {
          runIndex: event.runIndex,
          submissionAttemptId: event.submissionAttemptId,
          outcome: event.outcome,
          ...(event.outboxId !== undefined ? { outboxId: event.outboxId } : {}),
          ...(event.publicationId !== undefined ? { publicationId: event.publicationId } : {}),
          durationMs: event.durationMs,
        });
      },
      runFailed: (event) => {
        this.emit("stderr", WORKER_EVENTS.runFailed, {
          runIndex: event.runIndex,
          submissionAttemptId: event.submissionAttemptId,
          issueCode: safeCodes([event.issueCode])[0] ?? "UNCLASSIFIED_RUN_FAILURE",
        });
      },
      cycleCompleted: (event) => {
        this.emit("stdout", WORKER_EVENTS.cycleCompleted, {
          outcome: event.outcome,
          runsAttempted: event.runsAttempted,
          itemsClaimed: event.itemsClaimed,
          completedAt: event.completedAt,
        });
      },
    };
  }

  // — Emission —

  /**
   * Serialise and write one line. Never throws.
   *
   * `SILENT` returns before serialising, so an embedded caller pays nothing. A
   * serialisation failure attempts one hand-built fallback line naming only the
   * event and a code; if even that cannot be written, the failure is counted and
   * dropped, because there is nowhere left to report it.
   */
  private emit(
    stream: MonitoringStream,
    event: WorkerEventName,
    fields: Record<string, SafeValue>,
  ): void {
    if (this.options.outputMode === "SILENT") return;

    let line: string;
    try {
      line = JSON.stringify({
        event,
        at: this.readIsoNow(),
        cycleId: this.options.cycleId,
        ...fields,
      });
    } catch {
      this.failures += 1;
      this.writeFallback(event);
      return;
    }
    // `JSON.stringify` returns undefined for a value it cannot represent at the
    // top level; a plain object cannot, but the check costs nothing.
    if (typeof line !== "string") {
      this.failures += 1;
      this.writeFallback(event);
      return;
    }
    this.write(stream, line);
  }

  /** A minimal line built without `JSON.stringify` of caller-supplied values. */
  private writeFallback(event: WorkerEventName): void {
    this.write(
      "stderr",
      `{"event":"${WORKER_EVENTS.monitoringFailure}","cycleId":${JSON.stringify(
        this.options.cycleId,
      )},"code":"MONITORING_SERIALISATION_FAILURE","source":"${event}"}`,
    );
  }

  private write(stream: MonitoringStream, line: string): void {
    try {
      this.options.sink.writeLine(stream, line);
    } catch {
      // Contained deliberately: observability must never become a source of
      // publication failure, and there is no second sink to complain to.
      this.failures += 1;
    }
  }

  /** The injected clock, defensively — a broken clock must not lose the event. */
  private readIsoNow(): string {
    try {
      const value = this.options.time.now();
      if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
    } catch {
      // fall through
    }
    return "unavailable";
  }
}

/**
 * The production sink: one line per event on stdout or stderr.
 *
 * `process.stdout.write` rather than `console.log`, so the exact bytes are what
 * was serialised. Permitted here because this module is the command's output
 * adapter; no reusable domain service writes to a stream.
 */
export function createProcessMonitoringSink(): MonitoringSink {
  return {
    writeLine(stream, line) {
      const target = stream === "stderr" ? process.stderr : process.stdout;
      target.write(`${line}\n`);
    },
  };
}
