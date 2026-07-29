/**
 * `worker:publication:once` — one command, one bounded publication cycle
 * (Phase 0E.7.2). SERVER ONLY.
 *
 * Validate configuration, install shutdown handling, invoke **exactly one**
 * `runProductPublicationWorkerCycle`, emit safe machine-readable output, release
 * what it owns, and return.
 *
 * ## What this is not
 *
 * There is no daemon, no scheduler, no cron, no `setTimeout`/`setInterval`, no
 * sleep, no polling, no self-rescheduling, no restart, and no loop around the
 * cycle. Deciding to run a second cycle stays entirely outside: an external
 * supervisor invokes the command again. That is what makes this command safe to
 * run by hand, from `db:check`, or from a future scheduler without any of them
 * inheriting a hidden loop.
 *
 * ## It never calls `process.exit`
 *
 * `main` sets `process.exitCode` and returns, letting Node exit naturally once the
 * event loop drains. `process.exit` would truncate a pending stream write and,
 * worse, could kill the process mid-request — abandoning an in-flight registration
 * whose outcome has not been recorded, which is exactly the ambiguity the whole
 * publication path works to avoid.
 *
 * ## Ordering is a safety property
 *
 * Configuration → Registrar readiness → transport construction → signal handlers →
 * database client → one cycle. Every check that can refuse to run happens *before*
 * anything can be claimed, so **a startup failure cannot leave a claimed outbox
 * item behind**: at the moment it is raised, nothing has been claimed. The
 * exact-origin allow-list is applied before any secret is resolved (Phase 0E.6.2),
 * and a disabled worker touches neither the database nor the secret source.
 *
 * ## `process.env`
 *
 * Read here and nowhere else. Every collaborator receives an injected environment
 * object, which is why the whole command is testable without mutating global
 * state.
 */

import "../src/server/server-only";
import type { PrismaClient } from "@prisma/client";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { runProductPublicationWorkerCycle } from "../src/server/product/publication-worker-cycle-service";
import { createProcessShutdownSignal } from "../src/server/product/process-shutdown-signal";
import {
  loadPublicationWorkerRuntimeConfiguration,
  type WorkerRuntimeConfigurationLoad,
} from "../src/server/product/worker-runtime-config";
import {
  FixedDelayRetryTimingProvider,
  RandomSubmissionAttemptIdProvider,
  SystemTimeProvider,
  generateWorkerCycleId,
} from "../src/server/product/worker-runtime-providers";
import { WorkerDependencyConstructionFailureError } from "../src/server/product/worker-runtime-errors";
import {
  WorkerCommandReporter,
  createProcessMonitoringSink,
  type MonitoringSink,
} from "../src/server/product/worker-monitoring";
import {
  createConfiguredRegistrarTransport,
  validateRegistrarRuntimeReadiness,
} from "../src/server/registrar/registrar-runtime-factory";
import type { EnvironmentSource } from "../src/server/registrar/registrar-runtime-config";
import { ERROR_CODE_RE } from "../src/contracts/product/safe-error-metadata";
import type { RegistrarRegisterTransport } from "../src/contracts/product/registrar-transport";
import type {
  ShutdownSignal,
  SubmissionAttemptIdProvider,
  TimeProvider,
  WorkerCycleOutcome,
  WorkerCycleResult,
} from "../src/contracts/product/publication-worker-cycle";
import type { ProcessShutdownSignal } from "../src/server/product/process-shutdown-signal";

// — Exit-code policy —

/**
 * Four codes, and no more.
 *
 * A cycle that **completed coherently** is a success regardless of what the
 * Registrar said: `SENT`, `REMOTE_REJECTION`, `RETRY_SCHEDULED`, `DEAD_LETTERED`,
 * and `AMBIGUOUS_DELIVERY` are all correctly-recorded business outcomes, and
 * exiting non-zero for them would make a supervisor treat "the Registrar declined
 * this product" as "the worker is broken".
 *
 * The two sysexits values are borrowed deliberately: an operator reading `78` sees
 * a configuration problem, and `70` an internal one, without consulting a table.
 */
export const EXIT_SUCCESS = 0;
/** The cycle itself failed or threw. */
export const EXIT_CYCLE_FAILED = 1;
/** A runtime dependency could not be constructed. (sysexits EX_SOFTWARE) */
export const EXIT_STARTUP_FAILURE = 70;
/** Configuration is invalid, incomplete, or not ready. (sysexits EX_CONFIG) */
export const EXIT_CONFIGURATION = 78;

/**
 * Cycle outcome → exit code, as a closed record. A new outcome without an exit
 * code becomes a type error rather than silently defaulting to success.
 */
const CYCLE_EXIT_CODES: Record<WorkerCycleOutcome, number> = {
  DISABLED: EXIT_SUCCESS,
  NO_WORK: EXIT_SUCCESS,
  COMPLETED: EXIT_SUCCESS,
  RUN_LIMIT_REACHED: EXIT_SUCCESS,
  SHUTDOWN_REQUESTED: EXIT_SUCCESS,
  FAILED: EXIT_CYCLE_FAILED,
};

export function exitCodeForCycleOutcome(outcome: WorkerCycleOutcome): number {
  return CYCLE_EXIT_CODES[outcome];
}

// — Command result —

export const WORKER_COMMAND_STATUSES = [
  "DISABLED",
  "INCOMPLETE_CONFIGURATION",
  "INVALID_CONFIGURATION",
  "REGISTRAR_NOT_READY",
  "STARTUP_FAILURE",
  "CYCLE_FINISHED",
  "CYCLE_FAULT",
] as const;
export type WorkerCommandStatus = (typeof WORKER_COMMAND_STATUSES)[number];

/**
 * What the command did. Returned as well as emitted, so an embedding caller
 * (`db:check`, a test) can assert on it without parsing stdout.
 *
 * Carries codes, field names, and the already-safe cycle result — never a
 * credential, endpoint, payload, hash, token, or raw error.
 */
export interface WorkerCommandResult {
  status: WorkerCommandStatus;
  exitCode: number;
  cycleId: string;
  /** Present only when a cycle actually ran to completion. */
  cycle?: WorkerCycleResult;
  /** Bounded safe codes. */
  issues: string[];
  /** Configuration field or variable names only. */
  fields: string[];
}

// — Injected collaborators —

/** The cycle function itself, injectable so a test asserts it runs exactly once. */
export type RunWorkerCycle = typeof runProductPublicationWorkerCycle;

/**
 * Every ambient dependency, injectable. Production supplies none of them and gets
 * the real environment, clock, randomness, streams, process, and database.
 */
export interface WorkerCommandDeps {
  /** Configuration source. Defaults to `process.env` — the only read of it. */
  env?: EnvironmentSource;
  /** Secret source. Defaults to the same environment. */
  secretSource?: EnvironmentSource;
  sink?: MonitoringSink;
  /** Where the exit code is recorded. Defaults to `process`. */
  exitCodeTarget?: { exitCode: number };
  time?: TimeProvider;
  attemptIds?: SubmissionAttemptIdProvider;
  createShutdownSignal?: () => ProcessShutdownSignal;
  runCycle?: RunWorkerCycle;
  /**
   * Creates the database client. Whatever this returns is treated as **owned by
   * this command** and released in `finally`; a caller that keeps ownership pairs
   * it with a no-op `disconnect`.
   */
  createDb?: () => PrismaClient;
  disconnect?: () => Promise<void>;
  /** Test seam for the transport's HTTP layer. */
  fetchImpl?: typeof fetch;
  /** Test seam substituting the whole transport. No socket is opened. */
  transportOverride?: RegistrarRegisterTransport;
  /** Caller-supplied correlation id, overriding configuration and generation. */
  cycleId?: string;
}

/**
 * The field NAMES from a loader's issue list, discarding the rule text.
 *
 * Loader issues arrive as `path: rule message`. The rule text is safe — no loader
 * in this repository puts a value in a message — but it is not what an operator
 * needs, and reporting names only keeps the output's allow-list narrow enough to
 * enforce mechanically.
 */
function fieldNamesFromIssues(issues: readonly string[]): string[] {
  return issues.map((issue) => {
    const separator = issue.indexOf(":");
    return (separator === -1 ? issue : issue.slice(0, separator)).trim();
  });
}

/** A code that is already SCREAMING_SNAKE_CASE, or a safe classification. */
function safeCode(error: unknown, fallback: string): string {
  if (error instanceof Error && "code" in error) {
    const code = String((error as { code?: unknown }).code);
    if (ERROR_CODE_RE.test(code)) return code;
  }
  return fallback;
}

/**
 * Run the command once.
 *
 * Returns rather than exits, and sets the exit code on the injected target. The
 * only `await`ed work is the single cycle and the single cleanup.
 */
export async function main(deps: WorkerCommandDeps = {}): Promise<WorkerCommandResult> {
  // — 1. Configuration, from the application boundary —
  const env: EnvironmentSource = deps.env ?? process.env;
  const secretSource: EnvironmentSource = deps.secretSource ?? env;
  const exitTarget = deps.exitCodeTarget ?? process;
  const time = deps.time ?? new SystemTimeProvider();

  const load: WorkerRuntimeConfigurationLoad = loadPublicationWorkerRuntimeConfiguration(env);

  // Generated once, here, and never inside configuration validation.
  const cycleId =
    deps.cycleId ?? (load.state === "READY" ? load.config.cycleId : undefined) ?? generateWorkerCycleId();

  const reporter = new WorkerCommandReporter({
    sink: deps.sink ?? createProcessMonitoringSink(),
    time,
    cycleId,
    outputMode: load.state === "READY" ? load.config.outputMode : "JSON_LINES",
  });

  const settle = (result: WorkerCommandResult): WorkerCommandResult => {
    exitTarget.exitCode = result.exitCode;
    return result;
  };

  // — 2. Disabled: one safe line, no database query, no secret read —
  if (load.state === "DISABLED") {
    reporter.disabled();
    return settle({
      status: "DISABLED",
      exitCode: EXIT_SUCCESS,
      cycleId,
      issues: [],
      fields: [],
    });
  }

  // — 3. Invalid or incomplete: names and codes only, non-zero, nothing claimed —
  if (load.state === "INCOMPLETE") {
    reporter.configurationRejected("INCOMPLETE_WORKER_CONFIGURATION", load.missingFields);
    return settle({
      status: "INCOMPLETE_CONFIGURATION",
      exitCode: EXIT_CONFIGURATION,
      cycleId,
      issues: ["INCOMPLETE_WORKER_CONFIGURATION"],
      fields: [...load.missingFields],
    });
  }
  if (load.state === "INVALID") {
    const fields = fieldNamesFromIssues(load.issues);
    reporter.configurationRejected("INVALID_WORKER_CONFIGURATION", fields);
    return settle({
      status: "INVALID_CONFIGURATION",
      exitCode: EXIT_CONFIGURATION,
      cycleId,
      issues: ["INVALID_WORKER_CONFIGURATION"],
      fields,
    });
  }

  // — 4. Registrar readiness —
  //
  // Re-applies the exact-origin allow-list BEFORE checking that the credential is
  // present, so a misconfigured endpoint never causes a secret to be read
  // (Phase 0E.6.2). Presence only; the value is never read here.
  const readiness = validateRegistrarRuntimeReadiness(load.registrar.config, secretSource);
  if (readiness.status !== "READY") {
    const code = readiness.status === "INVALID" ? readiness.code : "REGISTRAR_DISABLED";
    const fields = readiness.status === "INVALID" ? readiness.fields : [];
    reporter.registrarNotReady(code, fields);
    return settle({
      status: "REGISTRAR_NOT_READY",
      exitCode: EXIT_CONFIGURATION,
      cycleId,
      issues: [code],
      fields: [...fields],
    });
  }

  // — 5-9. Dependencies, then exactly one cycle —
  let shutdown: ProcessShutdownSignal | undefined;
  let dbCreated = false;

  try {
    // The credential provider and transport, constructed once for the whole
    // command — before any claim, and before the cycle exists.
    let transport: RegistrarRegisterTransport;
    try {
      transport = createConfiguredRegistrarTransport(load.registrar.config, {
        secretSource,
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      }).transport;
    } catch (error) {
      throw new WorkerDependencyConstructionFailureError("transport", error);
    }

    const attemptIds = deps.attemptIds ?? new RandomSubmissionAttemptIdProvider();
    const retryTiming = new FixedDelayRetryTimingProvider(load.config.retryDelaySeconds);

    // Signal handlers install only now: configuration is valid, dependencies are
    // built, and a cycle is genuinely about to run. Installing them earlier would
    // change how the process responds to a signal during a run that never happens.
    shutdown = (deps.createShutdownSignal ?? createProcessShutdownSignal)();

    let db: PrismaClient;
    try {
      db = (deps.createDb ?? getPrisma)();
      dbCreated = true;
    } catch (error) {
      throw new WorkerDependencyConstructionFailureError("database", error);
    }

    let cycleStartedAt: string;
    try {
      const instant = time.now();
      if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) throw new Error("bad clock");
      cycleStartedAt = instant.toISOString();
    } catch (error) {
      throw new WorkerDependencyConstructionFailureError("clock", error);
    }

    // Recovered items become eligible at the cycle's own start instant — explicit,
    // never computed inside the sweep.
    const input = {
      cycleStartedAt,
      maximumRuns: load.config.maximumRuns,
      leaseDurationSeconds: load.config.leaseDurationSeconds,
      cycleId,
      ...(load.config.recovery !== undefined
        ? { recovery: { limit: load.config.recovery.limit, availableAt: cycleStartedAt } }
        : {}),
    };

    const runCycle = deps.runCycle ?? runProductPublicationWorkerCycle;
    const shutdownSignal: ShutdownSignal = shutdown;

    // ONE invocation. There is deliberately no loop, no retry of the cycle, and
    // no second call anywhere in this file.
    let cycle: WorkerCycleResult;
    try {
      cycle = await runCycle(input, {
        configuration: load.registrar,
        secretSource,
        time,
        attemptIds,
        retryTiming,
        shutdown: shutdownSignal,
        monitor: reporter.asWorkerCycleMonitor(),
        transportOverride: deps.transportOverride ?? transport,
        db,
      });
    } catch (error) {
      // Phase 0E.7.1 and 0E.6.3 remain authoritative for what happened to the
      // work item; the command only classifies and reports.
      const code = safeCode(error, "UNCLASSIFIED_WORKER_FAILURE");
      reporter.cycleFault(code);
      return settle({
        status: "CYCLE_FAULT",
        exitCode: EXIT_CYCLE_FAILED,
        cycleId,
        issues: [code],
        fields:
          error instanceof Error && "fields" in error && Array.isArray(error.fields)
            ? (error.fields as string[])
            : [],
      });
    }

    const exitCode = exitCodeForCycleOutcome(cycle.outcome);
    reporter.result(cycle, exitCode);
    return settle({
      status: "CYCLE_FINISHED",
      exitCode,
      cycleId,
      cycle,
      issues: [...cycle.issues],
      fields: [],
    });
  } catch (error) {
    // Startup only: raised before anything could be claimed.
    const code = safeCode(error, "WORKER_STARTUP_FAILURE");
    const stage = error instanceof WorkerDependencyConstructionFailureError ? error.stage : "unknown";
    reporter.startupFailure(code, stage);
    return settle({
      status: "STARTUP_FAILURE",
      exitCode: EXIT_STARTUP_FAILURE,
      cycleId,
      issues: [code],
      fields: [stage],
    });
  } finally {
    // — 8. Cleanup. Runs after success, after failure, and after a fault —
    //
    // Cleanup failure is tolerated: the cycle has already finished, nothing
    // remains to undo, and it must never change the outcome or start another
    // cycle. Only a bounded code is reported.
    if (shutdown !== undefined) {
      try {
        // Idempotent, and removes exactly the handlers this command installed, so
        // no listener survives `main`.
        shutdown.unregister();
      } catch {
        reporter.cleanupFailed("SHUTDOWN_HANDLER_CLEANUP_FAILURE");
      }
    }
    // `dbCreated` guards against a double disconnect and against releasing a
    // client this command never created.
    if (dbCreated) {
      try {
        await (deps.disconnect ?? disconnectPrisma)();
      } catch {
        reporter.cleanupFailed("RESOURCE_CLEANUP_FAILURE");
      }
    }
  }
}

/**
 * True when this file is the process entry point.
 *
 * Filename matching rather than `import.meta.url` or `require.main`: the
 * repository ships no `"type": "module"`, so the same source is loaded as CJS by
 * `tsx` and as ESM by Vitest, and only one of those two idioms exists in each.
 * `argv` is a parameter so the guard itself is testable.
 */
export function isDirectExecution(argv: readonly string[] = process.argv): boolean {
  const entry = argv[1];
  if (typeof entry !== "string") return false;
  return /(^|[\\/])run-publication-worker\.[cm]?[jt]s$/.test(entry);
}

// Nothing runs on import. Under Vitest, `argv[1]` is the test runner, so importing
// this module for its exports cannot start a worker.
if (isDirectExecution()) {
  void (async () => {
    // Loaded only on direct execution: importing `dotenv/config` for its side
    // effect would otherwise mutate the environment of every test that imports
    // this file for `main`.
    await import("dotenv/config");
    await main();
  })();
}
