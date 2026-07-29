/**
 * Executable worker entry-point tests (Phase 0E.7.2).
 *
 * NO NETWORK and NO DATABASE. Every ambient dependency of the command —
 * environment, secret source, clock, randomness, output sink, exit-code target,
 * shutdown signal, database client, disconnect, and the cycle itself — is
 * injected, which is the whole reason a one-shot process command can be tested
 * without starting a process.
 *
 * The database is exercised at the command level by `db:check`, against the
 * disposable local instance only. Nothing here opens a socket or contacts a
 * Registrar.
 *
 * Every value below is synthetic: RFC 2606 `example` hostnames, a fabricated
 * Registrar identifier, and obviously fake secrets.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  EXIT_CONFIGURATION,
  EXIT_CYCLE_FAILED,
  EXIT_STARTUP_FAILURE,
  EXIT_SUCCESS,
  exitCodeForCycleOutcome,
  isDirectExecution,
  main,
  type RunWorkerCycle,
  type WorkerCommandDeps,
} from "../scripts/run-publication-worker";
import {
  CYCLE_ID_RE,
  MAX_RETRY_DELAY_SECONDS,
  WORKER_ENV_KEYS,
  findUnknownWorkerEnvKeys,
  loadPublicationWorkerRuntimeConfiguration,
} from "../src/server/product/worker-runtime-config";
import {
  FixedDelayRetryTimingProvider,
  RandomSubmissionAttemptIdProvider,
  SystemTimeProvider,
  generateWorkerCycleId,
} from "../src/server/product/worker-runtime-providers";
import {
  WorkerCommandReporter,
  WORKER_EVENTS,
  type MonitoringSink,
  type MonitoringStream,
} from "../src/server/product/worker-monitoring";
import { WorkerDependencyConstructionFailureError } from "../src/server/product/worker-runtime-errors";
import { ENV_KEYS as REGISTRAR_ENV_KEYS } from "../src/server/registrar/registrar-runtime-config";
import { SUBMISSION_ATTEMPT_ID_RE } from "../src/contracts/capsule/identity";
import {
  emptyOutcomeCounts,
  type WorkerCycleOutcome,
  type WorkerCycleResult,
} from "../src/contracts/product/publication-worker-cycle";
import type { PrismaClient } from "@prisma/client";

// — Synthetic fixtures —

const SECRET_VAR = "MONACADO_TEST_FAKE_WORKER_TOKEN";
const FAKE_SECRET = "fake-worker-token-not-a-real-credential";
const FAKE_REGISTRAR_ID = "an:registrar:0000000000000000000000TEST";
const ENDPOINT = "https://registrar.example/v1/register";
const ORIGIN = "https://registrar.example";
const NOW = "2026-11-02T00:00:00.000Z";

const ENTRY_POINT_PATH = new URL("../scripts/run-publication-worker.ts", import.meta.url).pathname;
const entryPointSource = (): string => readFileSync(ENTRY_POINT_PATH, "utf8");

function registrarEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    [REGISTRAR_ENV_KEYS.enabled]: "true",
    [REGISTRAR_ENV_KEYS.registrarId]: FAKE_REGISTRAR_ID,
    [REGISTRAR_ENV_KEYS.endpoint]: ENDPOINT,
    [REGISTRAR_ENV_KEYS.allowedOrigins]: ORIGIN,
    [REGISTRAR_ENV_KEYS.credentialMode]: "BEARER_ENV",
    [REGISTRAR_ENV_KEYS.bearerTokenEnv]: SECRET_VAR,
    ...overrides,
  };
}

function workerEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    [WORKER_ENV_KEYS.enabled]: "true",
    [WORKER_ENV_KEYS.maximumRuns]: "3",
    [WORKER_ENV_KEYS.leaseSeconds]: "3600",
    [WORKER_ENV_KEYS.retryDelaySeconds]: "900",
    ...registrarEnv(),
    ...overrides,
  };
}

/** Advances a fixed step per read. No real clock is ever consulted. */
class FakeClock {
  calls = 0;
  constructor(
    private current = Date.parse(NOW),
    private readonly stepMs = 1_000,
  ) {}
  now(): Date {
    this.calls += 1;
    const value = new Date(this.current);
    this.current += this.stepMs;
    return value;
  }
}

class RecordingSink implements MonitoringSink {
  lines: Array<{ stream: MonitoringStream; line: string }> = [];
  writeLine(stream: MonitoringStream, line: string): void {
    this.lines.push({ stream, line });
  }
  events(): Array<Record<string, unknown>> {
    return this.lines.map(({ line }) => JSON.parse(line) as Record<string, unknown>);
  }
  eventNames(): string[] {
    return this.events().map((e) => String(e.event));
  }
  text(): string {
    return this.lines.map((l) => l.line).join("\n");
  }
}

/** Counts every property read, so "no secret lookup" is provable. */
function countingSource(values: Record<string, string>): {
  source: Record<string, string | undefined>;
  reads: string[];
} {
  const reads: string[] = [];
  const source = new Proxy(values, {
    get(target, key) {
      if (typeof key === "string") reads.push(key);
      return Reflect.get(target, key) as string | undefined;
    },
  }) as Record<string, string | undefined>;
  return { source, reads };
}

/** Throws on any property access, so "no database query" is provable. */
function forbiddenDb(): PrismaClient {
  return new Proxy(
    {},
    {
      get(_target, key) {
        throw new Error(`the database was touched: ${String(key)}`);
      },
    },
  ) as unknown as PrismaClient;
}

function cycleResult(overrides: Partial<WorkerCycleResult> = {}): WorkerCycleResult {
  return {
    outcome: "COMPLETED",
    startedAt: NOW,
    completedAt: NOW,
    runsAttempted: 1,
    itemsClaimed: 1,
    outcomeCounts: { ...emptyOutcomeCounts(), SENT: 1 },
    shutdownRequested: false,
    stoppedForNoWork: false,
    issues: [],
    ...overrides,
  };
}

interface Harness {
  deps: WorkerCommandDeps;
  sink: RecordingSink;
  exitTarget: { exitCode: number };
  clock: FakeClock;
  cycleCalls: Array<{ input: unknown; deps: Record<string, unknown> }>;
  disconnects: number;
  dbCreations: number;
  attemptIdCalls: () => number;
}

/**
 * A ready command with the cycle itself faked, so "exactly one cycle" and
 * "dependencies were constructed" are observable without any real work.
 */
function harness(
  options: {
    env?: Record<string, string | undefined>;
    secretSource?: Record<string, string | undefined>;
    cycle?: WorkerCycleResult;
    cycleImpl?: RunWorkerCycle;
    sink?: RecordingSink;
    disconnect?: () => Promise<void>;
    createShutdownSignal?: WorkerCommandDeps["createShutdownSignal"];
  } = {},
): Harness {
  const sink = options.sink ?? new RecordingSink();
  const exitTarget = { exitCode: EXIT_SUCCESS };
  const clock = new FakeClock();
  const cycleCalls: Array<{ input: unknown; deps: Record<string, unknown> }> = [];
  const state = { disconnects: 0, dbCreations: 0, attemptIds: 0 };

  const attemptIds = {
    nextSubmissionAttemptId: () => {
      state.attemptIds += 1;
      return `mon:attempt:${"0".repeat(20)}ATTEMP`;
    },
  };

  const runCycle: RunWorkerCycle =
    options.cycleImpl ??
    (async (input, deps) => {
      cycleCalls.push({ input, deps: deps as unknown as Record<string, unknown> });
      return options.cycle ?? cycleResult();
    });

  const harnessValue: Harness = {
    sink,
    exitTarget,
    clock,
    cycleCalls,
    get disconnects() {
      return state.disconnects;
    },
    get dbCreations() {
      return state.dbCreations;
    },
    attemptIdCalls: () => state.attemptIds,
    deps: {
      env: options.env ?? workerEnv(),
      secretSource: options.secretSource ?? { [SECRET_VAR]: FAKE_SECRET },
      sink,
      exitCodeTarget: exitTarget,
      time: clock,
      attemptIds,
      runCycle,
      createDb: () => {
        state.dbCreations += 1;
        return forbiddenDb();
      },
      disconnect:
        options.disconnect ??
        (async () => {
          state.disconnects += 1;
        }),
      createShutdownSignal:
        options.createShutdownSignal ??
        (() => ({ isShutdownRequested: () => false, signal: undefined, unregister: () => {} })),
      transportOverride: {
        async sendRegisterRequest() {
          throw new Error("the transport must not be used with a faked cycle");
        },
      },
    },
  };
  return harnessValue;
}

// — 1-8, 39. Operational configuration —

describe("worker runtime configuration", () => {
  it("is disabled by default", () => {
    expect(loadPublicationWorkerRuntimeConfiguration({}).state).toBe("DISABLED");
    // An unparseable switch fails closed, matching the Registrar loader.
    expect(
      loadPublicationWorkerRuntimeConfiguration({ [WORKER_ENV_KEYS.enabled]: "perhaps" }).state,
    ).toBe("DISABLED");
  });

  it("permits a disabled configuration to omit every Registrar and cycle value", () => {
    expect(
      loadPublicationWorkerRuntimeConfiguration({ [WORKER_ENV_KEYS.enabled]: "false" }).state,
    ).toBe("DISABLED");
  });

  it("requires maximumRuns once enabled", () => {
    const load = loadPublicationWorkerRuntimeConfiguration(
      workerEnv({ [WORKER_ENV_KEYS.maximumRuns]: undefined }),
    );
    expect(load.state).toBe("INCOMPLETE");
    if (load.state !== "INCOMPLETE") throw new Error("unreachable");
    expect(load.missingFields).toContain(WORKER_ENV_KEYS.maximumRuns);
  });

  it("bounds maximumRuns consistently with the Phase 0E.7.1 cycle", () => {
    for (const value of ["0", "101", "2.5", "many"]) {
      const load = loadPublicationWorkerRuntimeConfiguration(
        workerEnv({ [WORKER_ENV_KEYS.maximumRuns]: value }),
      );
      expect(load.state).toBe("INVALID");
      if (load.state !== "INVALID") throw new Error("unreachable");
      expect(load.issues.join(" ")).toContain("maximumRuns");
    }
    expect(
      loadPublicationWorkerRuntimeConfiguration(workerEnv({ [WORKER_ENV_KEYS.maximumRuns]: "100" }))
        .state,
    ).toBe("READY");
  });

  it("requires a valid, bounded lease duration", () => {
    const missing = loadPublicationWorkerRuntimeConfiguration(
      workerEnv({ [WORKER_ENV_KEYS.leaseSeconds]: undefined }),
    );
    expect(missing.state).toBe("INCOMPLETE");

    for (const value of ["0", "86401", "later"]) {
      const load = loadPublicationWorkerRuntimeConfiguration(
        workerEnv({ [WORKER_ENV_KEYS.leaseSeconds]: value }),
      );
      expect(load.state).toBe("INVALID");
      if (load.state !== "INVALID") throw new Error("unreachable");
      expect(load.issues.join(" ")).toContain("leaseDurationSeconds");
    }
  });

  it("bounds the retry delay and the recovery limit", () => {
    for (const value of ["0", String(MAX_RETRY_DELAY_SECONDS + 1)]) {
      const load = loadPublicationWorkerRuntimeConfiguration(
        workerEnv({ [WORKER_ENV_KEYS.retryDelaySeconds]: value }),
      );
      expect(load.state).toBe("INVALID");
    }
    const recovery = loadPublicationWorkerRuntimeConfiguration(
      workerEnv({
        [WORKER_ENV_KEYS.recoveryEnabled]: "true",
        [WORKER_ENV_KEYS.recoveryLimit]: "1001",
      }),
    );
    expect(recovery.state).toBe("INVALID");

    // Recovery enabled without a limit is unfinished, not wrong.
    const noLimit = loadPublicationWorkerRuntimeConfiguration(
      workerEnv({ [WORKER_ENV_KEYS.recoveryEnabled]: "true" }),
    );
    expect(noLimit.state).toBe("INCOMPLETE");
    if (noLimit.state !== "INCOMPLETE") throw new Error("unreachable");
    expect(noLimit.missingFields).toContain(WORKER_ENV_KEYS.recoveryLimit);

    const ready = loadPublicationWorkerRuntimeConfiguration(
      workerEnv({
        [WORKER_ENV_KEYS.recoveryEnabled]: "true",
        [WORKER_ENV_KEYS.recoveryLimit]: "25",
      }),
    );
    expect(ready.state).toBe("READY");
    if (ready.state !== "READY") throw new Error("unreachable");
    expect(ready.config.recovery).toEqual({ limit: 25 });
  });

  it("requires Registrar readiness once the worker is enabled", () => {
    // Registrar entirely off: an enabled worker that could never send is unfinished.
    const off = loadPublicationWorkerRuntimeConfiguration({
      [WORKER_ENV_KEYS.enabled]: "true",
      [WORKER_ENV_KEYS.maximumRuns]: "1",
      [WORKER_ENV_KEYS.leaseSeconds]: "60",
      [WORKER_ENV_KEYS.retryDelaySeconds]: "60",
    });
    expect(off.state).toBe("INCOMPLETE");
    if (off.state !== "INCOMPLETE") throw new Error("unreachable");
    expect(off.missingFields).toContain(REGISTRAR_ENV_KEYS.enabled);

    // Registrar enabled but unfinished.
    const partial = loadPublicationWorkerRuntimeConfiguration(
      workerEnv({ [REGISTRAR_ENV_KEYS.endpoint]: undefined }),
    );
    expect(partial.state).toBe("INCOMPLETE");

    // Registrar values present but the endpoint is not allow-listed.
    const wrongOrigin = loadPublicationWorkerRuntimeConfiguration(
      workerEnv({ [REGISTRAR_ENV_KEYS.allowedOrigins]: "https://other.example" }),
    );
    expect(wrongOrigin.state).toBe("INVALID");
  });

  it("refuses an unknown worker-prefixed variable", () => {
    // The dangerous typo is in the switch itself, which would otherwise leave the
    // worker silently disabled.
    const typo = { [`${WORKER_ENV_KEYS.enabled.slice(0, -1)}`]: "true" };
    expect(findUnknownWorkerEnvKeys(typo)).toEqual([
      "MONACADO_PUBLICATION_WORKER_ENABLE",
    ]);
    const load = loadPublicationWorkerRuntimeConfiguration({
      ...workerEnv(),
      MONACADO_PUBLICATION_WORKER_MYSTERY: "1",
    });
    expect(load.state).toBe("INVALID");
    if (load.state !== "INVALID") throw new Error("unreachable");
    expect(load.issues.join(" ")).toContain("MONACADO_PUBLICATION_WORKER_MYSTERY");
  });

  it("holds no secret value and defines no NEXT_PUBLIC variable", () => {
    for (const key of Object.values(WORKER_ENV_KEYS)) {
      expect(key.startsWith("NEXT_PUBLIC_")).toBe(false);
    }
    for (const key of Object.values(REGISTRAR_ENV_KEYS)) {
      expect(key.startsWith("NEXT_PUBLIC_")).toBe(false);
    }
    const load = loadPublicationWorkerRuntimeConfiguration(workerEnv());
    if (load.state !== "READY") throw new Error("unreachable");
    // Bounds and a mode — nothing else. The credential's LOCATION stays in the
    // Registrar configuration and its value nowhere at all.
    expect(Object.keys(load.config).sort()).toEqual([
      "leaseDurationSeconds",
      "maximumRuns",
      "outputMode",
      "retryDelaySeconds",
    ]);
    expect(JSON.stringify(load.config)).not.toContain(FAKE_SECRET);
  });

  it("reads no process.env of its own", () => {
    const source = readFileSync(
      new URL("../src/server/product/worker-runtime-config.ts", import.meta.url).pathname,
      "utf8",
    );
    // The doc comment says "process.env" in prose; only a real access is a fault.
    expect(source).not.toContain("process.env[");
    expect(source).not.toContain("process.env.");
  });
});

// — 3, 4, 16-18. Concrete providers —

describe("worker runtime providers", () => {
  it("generates contract-valid submission-attempt identifiers", () => {
    const provider = new RandomSubmissionAttemptIdProvider();
    const ids = [
      provider.nextSubmissionAttemptId(),
      provider.nextSubmissionAttemptId(),
      provider.nextSubmissionAttemptId(),
    ];
    for (const id of ids) expect(SUBMISSION_ATTEMPT_ID_RE.test(id)).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });

  it("generates a bounded, output-safe cycle id", () => {
    const id = generateWorkerCycleId();
    expect(CYCLE_ID_RE.test(id)).toBe(true);
    expect(generateWorkerCycleId()).not.toBe(id);
  });

  it("returns Date values from the system clock only in the runtime adapter", () => {
    const value = new SystemTimeProvider().now();
    expect(value).toBeInstanceOf(Date);
    expect(Number.isNaN(value.getTime())).toBe(false);
  });

  it("applies a fixed retry delay deterministically to an explicit instant", () => {
    const retry = new FixedDelayRetryTimingProvider(900);
    const attemptedAt = new Date(NOW);
    const first = retry.nextRetryAvailableAt({ attemptedAt, runIndex: 0 });
    const second = retry.nextRetryAvailableAt({ attemptedAt, runIndex: 7 });
    // Same explicit input, same instant: no clock read, no jitter, no backoff.
    expect(first.toISOString()).toBe("2026-11-02T00:15:00.000Z");
    expect(second.toISOString()).toBe(first.toISOString());
  });

  it("refuses an out-of-bounds retry delay at construction", () => {
    expect(() => new FixedDelayRetryTimingProvider(0)).toThrow(
      WorkerDependencyConstructionFailureError,
    );
    expect(() => new FixedDelayRetryTimingProvider(MAX_RETRY_DELAY_SECONDS + 1)).toThrow(
      WorkerDependencyConstructionFailureError,
    );
  });

  it("keeps the internal cause non-enumerable", () => {
    const error = new WorkerDependencyConstructionFailureError("transport", {
      secret: FAKE_SECRET,
    });
    expect(JSON.stringify(error)).not.toContain(FAKE_SECRET);
  });
});

// — 5, 19-21, 40. Monitoring output —

describe("safe JSON-lines monitoring", () => {
  const reporterFor = (sink: MonitoringSink) =>
    new WorkerCommandReporter({
      sink,
      time: new FakeClock(),
      cycleId: "cyc-TEST",
      outputMode: "JSON_LINES",
    });

  it("emits one parseable JSON object per line with a stable event name", () => {
    const sink = new RecordingSink();
    const reporter = reporterFor(sink);
    reporter.disabled();
    reporter.result(cycleResult(), EXIT_SUCCESS);
    const monitor = reporter.asWorkerCycleMonitor();
    monitor.cycleStarted?.({ cycleId: "cyc-TEST", startedAt: NOW, maximumRuns: 3 });
    monitor.runCompleted?.({
      runIndex: 0,
      submissionAttemptId: `mon:attempt:${"0".repeat(20)}ATTEMP`,
      outcome: "SENT",
      outboxId: `mon:obx:${"0".repeat(20)}OUTBOX`,
      durationMs: 12,
    });

    expect(sink.lines).toHaveLength(4);
    for (const { line } of sink.lines) {
      expect(line.includes("\n")).toBe(false);
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(typeof parsed.event).toBe("string");
      expect(Object.values(WORKER_EVENTS)).toContain(parsed.event);
      expect(String(parsed.at)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(parsed.cycleId).toBe("cyc-TEST");
    }
    expect(sink.eventNames()).toEqual([
      WORKER_EVENTS.disabled,
      WORKER_EVENTS.result,
      WORKER_EVENTS.cycleStarted,
      WORKER_EVENTS.runCompleted,
    ]);
  });

  it("puts actionable events on stderr and the run's story on stdout", () => {
    const sink = new RecordingSink();
    const reporter = reporterFor(sink);
    reporter.disabled();
    reporter.configurationRejected("INVALID_WORKER_CONFIGURATION", ["maximumRuns"]);
    reporter.startupFailure("WORKER_DEPENDENCY_CONSTRUCTION_FAILURE", "transport");
    reporter.cleanupFailed("RESOURCE_CLEANUP_FAILURE");
    reporter.asWorkerCycleMonitor().runFailed?.({
      runIndex: 0,
      submissionAttemptId: `mon:attempt:${"0".repeat(20)}ATTEMP`,
      issueCode: "POST_TRANSPORT_PERSISTENCE_FAILURE",
    });
    expect(sink.lines.map((l) => l.stream)).toEqual([
      "stdout",
      "stderr",
      "stderr",
      "stderr",
      "stderr",
    ]);
  });

  it("drops an issue code that is not already a safe code", () => {
    const sink = new RecordingSink();
    reporterFor(sink).result(
      cycleResult({
        issues: ["MONITORING_HOOK_FAILURE", "connect ECONNREFUSED 10.0.0.1:3306"],
      }),
      EXIT_SUCCESS,
    );
    const event = sink.events()[0]!;
    expect(event.issues).toEqual(["MONITORING_HOOK_FAILURE"]);
    expect(sink.text()).not.toContain("ECONNREFUSED");
  });

  it("contains no secret, endpoint, payload, hash, or token", () => {
    const sink = new RecordingSink();
    const reporter = reporterFor(sink);
    reporter.registrarNotReady("MISSING_CREDENTIAL_SECRET", []);
    reporter.result(cycleResult({ recovery: { examined: 2, recoveredCount: 1, skippedCount: 1 } }), 0);
    const monitor = reporter.asWorkerCycleMonitor();
    monitor.expiredClaimsRecovered?.({ counts: { examined: 2, recoveredCount: 1, skippedCount: 1 } });
    monitor.cycleCompleted?.({
      outcome: "COMPLETED",
      runsAttempted: 1,
      itemsClaimed: 1,
      completedAt: NOW,
    });

    const text = sink.text();
    for (const forbidden of [
      FAKE_SECRET,
      SECRET_VAR,
      ENDPOINT,
      ORIGIN,
      "registrar.example",
      "Bearer",
      "authorization",
      "mon:lock:",
      "claimTokenHash",
      "contentHash",
      "payload",
      "DATABASE_URL",
      "mysql://",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("survives a sink that throws and a clock that fails", () => {
    const throwing: MonitoringSink = {
      writeLine() {
        throw new Error("stdout is closed");
      },
    };
    const reporter = reporterFor(throwing);
    expect(() => reporter.result(cycleResult(), EXIT_SUCCESS)).not.toThrow();
    expect(reporter.outputFailures).toBeGreaterThan(0);

    const sink = new RecordingSink();
    const circular = new WorkerCommandReporter({
      sink,
      // A clock that throws must not lose the event.
      time: {
        now() {
          throw new Error("no clock");
        },
      },
      cycleId: "cyc-TEST",
      outputMode: "JSON_LINES",
    });
    circular.disabled();
    expect(sink.events()[0]!.at).toBe("unavailable");
  });

  it("writes nothing at all in SILENT mode", () => {
    const sink = new RecordingSink();
    new WorkerCommandReporter({
      sink,
      time: new FakeClock(),
      cycleId: "cyc-TEST",
      outputMode: "SILENT",
    }).result(cycleResult(), EXIT_SUCCESS);
    expect(sink.lines).toHaveLength(0);
  });
});

// — 2-4, 9-15, 22-34. The command —

describe("publication worker command", () => {
  it("emits one safe DISABLED result, touching no database and no secret", async () => {
    const secret = countingSource({ [SECRET_VAR]: FAKE_SECRET });
    const sink = new RecordingSink();
    const exitTarget = { exitCode: 99 };
    let dbCreations = 0;

    const result = await main({
      env: {},
      secretSource: secret.source,
      sink,
      exitCodeTarget: exitTarget,
      time: new FakeClock(),
      createDb: () => {
        dbCreations += 1;
        return forbiddenDb();
      },
      createShutdownSignal: () => {
        throw new Error("no signal handler may be installed while disabled");
      },
      runCycle: async () => {
        throw new Error("no cycle may run while disabled");
      },
    });

    expect(result.status).toBe("DISABLED");
    expect(result.exitCode).toBe(EXIT_SUCCESS);
    expect(exitTarget.exitCode).toBe(EXIT_SUCCESS);
    expect(dbCreations).toBe(0);
    expect(secret.reads).toEqual([]);
    expect(sink.eventNames()).toEqual([WORKER_EVENTS.disabled]);
  });

  it("sets a non-zero exit code for invalid configuration and claims nothing", async () => {
    const secret = countingSource({ [SECRET_VAR]: FAKE_SECRET });
    const h = harness({
      env: workerEnv({ [WORKER_ENV_KEYS.maximumRuns]: "0" }),
      secretSource: secret.source,
    });
    const result = await main({ ...h.deps, secretSource: secret.source });

    expect(result.status).toBe("INVALID_CONFIGURATION");
    expect(result.exitCode).toBe(EXIT_CONFIGURATION);
    expect(h.exitTarget.exitCode).toBe(EXIT_CONFIGURATION);
    expect(h.cycleCalls).toHaveLength(0);
    expect(h.dbCreations).toBe(0);
    expect(secret.reads).toEqual([]);
    const event = h.sink.events()[0]!;
    expect(event.event).toBe(WORKER_EVENTS.configurationRejected);
    expect(event.code).toBe("INVALID_WORKER_CONFIGURATION");
    // Field NAMES only — never the offending value, and never the rule text.
    expect(event.fields).toEqual(["maximumRuns"]);
    expect(result.fields).toEqual(["maximumRuns"]);
  });

  it("sets a non-zero exit code for incomplete configuration", async () => {
    const h = harness({ env: workerEnv({ [WORKER_ENV_KEYS.leaseSeconds]: undefined }) });
    const result = await main(h.deps);
    expect(result.status).toBe("INCOMPLETE_CONFIGURATION");
    expect(result.exitCode).toBe(EXIT_CONFIGURATION);
    expect(result.fields).toContain(WORKER_ENV_KEYS.leaseSeconds);
    expect(h.cycleCalls).toHaveLength(0);
  });

  it("validates the exact origin before ever reading the secret", async () => {
    const secret = countingSource({ [SECRET_VAR]: FAKE_SECRET });
    const h = harness({
      env: workerEnv({ [REGISTRAR_ENV_KEYS.allowedOrigins]: "https://other.example" }),
      secretSource: secret.source,
    });
    const result = await main({ ...h.deps, secretSource: secret.source });

    expect(result.status).toBe("INVALID_CONFIGURATION");
    // The whole point: a misconfigured endpoint costs no credential read.
    expect(secret.reads).toEqual([]);
    expect(h.sink.text()).not.toContain(SECRET_VAR);
    expect(h.sink.text()).not.toContain("other.example");
  });

  it("reports a missing credential as not-ready, without naming the variable", async () => {
    const h = harness({ secretSource: {} });
    const result = await main({ ...h.deps, secretSource: {} });
    expect(result.status).toBe("REGISTRAR_NOT_READY");
    expect(result.exitCode).toBe(EXIT_CONFIGURATION);
    expect(result.issues).toEqual(["MISSING_CREDENTIAL_SECRET"]);
    expect(h.cycleCalls).toHaveLength(0);
    expect(h.dbCreations).toBe(0);
    expect(h.sink.text()).not.toContain(SECRET_VAR);
  });

  it("constructs every dependency and invokes the cycle exactly once", async () => {
    const h = harness();
    const result = await main(h.deps);

    expect(result.status).toBe("CYCLE_FINISHED");
    expect(h.cycleCalls).toHaveLength(1);
    const { input, deps } = h.cycleCalls[0]!;

    // Time is explicit and comes from the injected clock, not a real one.
    expect(input).toMatchObject({
      cycleStartedAt: NOW,
      maximumRuns: 3,
      leaseDurationSeconds: 3600,
    });
    expect((input as { recovery?: unknown }).recovery).toBeUndefined();

    expect(deps.time).toBe(h.clock);
    expect(deps.attemptIds).toBeDefined();
    expect(deps.retryTiming).toBeInstanceOf(FixedDelayRetryTimingProvider);
    expect(deps.shutdown).toBeDefined();
    expect(deps.monitor).toBeDefined();
    expect(deps.transportOverride).toBeDefined();
    expect((deps.configuration as { state: string }).state).toBe("READY");
    // The database client is created once, and only after configuration passed.
    expect(h.dbCreations).toBe(1);
  });

  it("passes an explicit recovery window when recovery is enabled", async () => {
    const h = harness({
      env: workerEnv({
        [WORKER_ENV_KEYS.recoveryEnabled]: "true",
        [WORKER_ENV_KEYS.recoveryLimit]: "10",
      }),
    });
    await main(h.deps);
    expect(h.cycleCalls[0]!.input).toMatchObject({
      recovery: { limit: 10, availableAt: NOW },
    });
  });

  it("generates one cycle id, or honours the configured one", async () => {
    const generated = harness();
    const first = await main(generated.deps);
    expect(CYCLE_ID_RE.test(first.cycleId)).toBe(true);
    expect(generated.sink.events().every((e) => e.cycleId === first.cycleId)).toBe(true);

    const configured = harness({
      env: workerEnv({ [WORKER_ENV_KEYS.cycleId]: "nightly-run-7" }),
    });
    const second = await main(configured.deps);
    expect(second.cycleId).toBe("nightly-run-7");
  });

  it("generates a submission-attempt id only when the cycle asks for one", async () => {
    const idle = harness();
    await main(idle.deps);
    expect(idle.attemptIdCalls()).toBe(0);

    const working = harness({
      cycleImpl: async (_input, deps) => {
        deps.attemptIds.nextSubmissionAttemptId();
        return cycleResult();
      },
    });
    await main(working.deps);
    expect(working.attemptIdCalls()).toBe(1);
  });

  it("emits the final validated cycle result", async () => {
    const h = harness({ cycle: cycleResult({ outcome: "RUN_LIMIT_REACHED", runsAttempted: 3 }) });
    const result = await main(h.deps);
    const final = h.sink.events().find((e) => e.event === WORKER_EVENTS.result)!;
    expect(final.outcome).toBe("RUN_LIMIT_REACHED");
    expect(final.runsAttempted).toBe(3);
    expect(final.exitCode).toBe(EXIT_SUCCESS);
    expect(result.cycle?.outcome).toBe("RUN_LIMIT_REACHED");
  });

  it("maps every coherent cycle outcome to exit code 0, and FAILED to non-zero", async () => {
    const zero: WorkerCycleOutcome[] = [
      "DISABLED",
      "NO_WORK",
      "COMPLETED",
      "RUN_LIMIT_REACHED",
      "SHUTDOWN_REQUESTED",
    ];
    for (const outcome of zero) {
      const h = harness({ cycle: cycleResult({ outcome }) });
      const result = await main(h.deps);
      expect(result.exitCode).toBe(EXIT_SUCCESS);
      expect(h.exitTarget.exitCode).toBe(EXIT_SUCCESS);
    }
    const failed = harness({ cycle: cycleResult({ outcome: "FAILED", issues: ["RUN_STATE_CONFLICT"] }) });
    const result = await main(failed.deps);
    expect(result.exitCode).toBe(EXIT_CYCLE_FAILED);
    expect(failed.exitTarget.exitCode).toBe(EXIT_CYCLE_FAILED);
    expect(exitCodeForCycleOutcome("FAILED")).toBe(EXIT_CYCLE_FAILED);
  });

  it("does not treat a business outcome as a process failure", async () => {
    const h = harness({
      cycle: cycleResult({
        outcome: "COMPLETED",
        outcomeCounts: {
          ...emptyOutcomeCounts(),
          SENT: 1,
          REMOTE_REJECTION: 1,
          RETRY_SCHEDULED: 1,
          DEAD_LETTERED: 1,
          AMBIGUOUS_DELIVERY: 1,
        },
      }),
    });
    const result = await main(h.deps);
    expect(result.exitCode).toBe(EXIT_SUCCESS);
  });

  it("classifies a thrown cycle without exposing it, and exits non-zero", async () => {
    const h = harness({
      cycleImpl: async () => {
        const error = new Error(`connect ECONNREFUSED for ${FAKE_SECRET}`) as Error & {
          code: string;
        };
        error.code = "TIME_PROVIDER_FAILURE";
        throw error;
      },
    });
    const result = await main(h.deps);
    expect(result.status).toBe("CYCLE_FAULT");
    expect(result.exitCode).toBe(EXIT_CYCLE_FAILED);
    expect(result.issues).toEqual(["TIME_PROVIDER_FAILURE"]);
    expect(h.sink.text()).not.toContain(FAKE_SECRET);
    expect(h.sink.text()).not.toContain("ECONNREFUSED");
    // Cleanup still ran, and no second cycle followed.
    expect(h.disconnects).toBe(1);
  });

  it("reports a startup failure without claiming anything", async () => {
    const h = harness();
    const result = await main({
      ...h.deps,
      createDb: () => {
        throw new Error("DATABASE_URL is not set");
      },
    });
    expect(result.status).toBe("STARTUP_FAILURE");
    expect(result.exitCode).toBe(EXIT_STARTUP_FAILURE);
    expect(result.issues).toEqual(["WORKER_DEPENDENCY_CONSTRUCTION_FAILURE"]);
    expect(result.fields).toEqual(["database"]);
    expect(h.cycleCalls).toHaveLength(0);
    expect(h.sink.text()).not.toContain("DATABASE_URL");
  });

  it("cannot resend when the output sink fails", async () => {
    const throwingSink: MonitoringSink = {
      writeLine() {
        throw new Error("stdout is closed");
      },
    };
    let sends = 0;
    const h = harness({
      cycleImpl: async (_input, deps) => {
        // Drive the hooks exactly as the real cycle does; each must be harmless.
        deps.monitor?.cycleStarted?.({ startedAt: NOW, maximumRuns: 3 });
        deps.monitor?.runStarted?.({
          runIndex: 0,
          submissionAttemptId: `mon:attempt:${"0".repeat(20)}ATTEMP`,
        });
        sends += 1;
        deps.monitor?.runCompleted?.({
          runIndex: 0,
          submissionAttemptId: `mon:attempt:${"0".repeat(20)}ATTEMP`,
          outcome: "SENT",
          durationMs: 1,
        });
        return cycleResult();
      },
    });
    const result = await main({ ...h.deps, sink: throwingSink });
    // The cycle still completed coherently, and the one transmission stayed one.
    expect(result.exitCode).toBe(EXIT_SUCCESS);
    expect(result.status).toBe("CYCLE_FINISHED");
    expect(sends).toBe(1);
  });

  it("cleans up after success and after failure, exactly once", async () => {
    const ok = harness();
    await main(ok.deps);
    expect(ok.disconnects).toBe(1);

    const failed = harness({ cycle: cycleResult({ outcome: "FAILED" }) });
    await main(failed.deps);
    expect(failed.disconnects).toBe(1);
  });

  it("tolerates a cleanup failure and never starts another cycle", async () => {
    const h = harness({
      disconnect: async () => {
        throw new Error("connection reset while disconnecting from mysql://root@127.0.0.1");
      },
    });
    const result = await main(h.deps);
    expect(result.exitCode).toBe(EXIT_SUCCESS);
    expect(h.cycleCalls).toHaveLength(1);
    const cleanup = h.sink.events().find((e) => e.event === WORKER_EVENTS.cleanupFailed)!;
    expect(cleanup.code).toBe("RESOURCE_CLEANUP_FAILURE");
    expect(h.sink.text()).not.toContain("mysql://");
  });

  it("does not disconnect a resource it never created", async () => {
    const h = harness({ env: {} });
    const result = await main(h.deps);
    expect(result.status).toBe("DISABLED");
    expect(h.disconnects).toBe(0);
  });

  it("never calls process.exit", async () => {
    const spy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as unknown as typeof process.exit);
    try {
      await main(harness().deps);
      await main(harness({ env: {} }).deps);
      await main(harness({ cycle: cycleResult({ outcome: "FAILED" }) }).deps);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    // And structurally: the source contains no exit call at all.
    expect(entryPointSource()).not.toMatch(/process\s*\.\s*exit\s*\(/);
  });
});

// — 30, 31. Signal lifecycle —

describe("signal and listener lifecycle", () => {
  const listenerCount = (): number =>
    process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");

  it("installs no handler when the worker is disabled", async () => {
    const before = listenerCount();
    const h = harness({ env: {} });
    await main({ ...h.deps, createShutdownSignal: undefined });
    expect(listenerCount()).toBe(before);
  });

  it("installs no handler when configuration is rejected", async () => {
    const before = listenerCount();
    const h = harness({ env: workerEnv({ [WORKER_ENV_KEYS.maximumRuns]: "0" }) });
    await main({ ...h.deps, createShutdownSignal: undefined });
    expect(listenerCount()).toBe(before);
  });

  it("installs real handlers while running and removes them in finally", async () => {
    const before = listenerCount();
    let duringCycle = -1;
    const h = harness({
      cycleImpl: async () => {
        duringCycle = listenerCount();
        return cycleResult();
      },
    });
    await main({ ...h.deps, createShutdownSignal: undefined });
    expect(duringCycle).toBe(before + 2);
    // Nothing survives `main`.
    expect(listenerCount()).toBe(before);
  });

  it("removes handlers even when the cycle throws", async () => {
    const before = listenerCount();
    const h = harness({
      cycleImpl: async () => {
        throw new Error("boom");
      },
    });
    await main({ ...h.deps, createShutdownSignal: undefined });
    expect(listenerCount()).toBe(before);
  });
});

// — 35-38. Structure of the command itself —

describe("entry-point structure", () => {
  it("does not start the worker on import", () => {
    // This test file has already imported the module; the guard must be false for
    // the test runner's own argv.
    expect(isDirectExecution()).toBe(false);
    expect(isDirectExecution(["node", "/repo/node_modules/vitest/dist/worker.js"])).toBe(false);
    expect(isDirectExecution(["node"])).toBe(false);
  });

  it("recognises direct execution of exactly this file", () => {
    expect(isDirectExecution(["node", "/repo/scripts/run-publication-worker.ts"])).toBe(true);
    expect(isDirectExecution(["node", "scripts/run-publication-worker.js"])).toBe(true);
    expect(isDirectExecution(["node", "/repo/scripts/run-publication-worker-other.ts"])).toBe(false);
  });

  it("invokes main once, only behind the guard", () => {
    const source = entryPointSource();
    // Exactly one call site, and it is inside the guard block.
    const invocations = source.match(/^\s*(await|void)\s+main\(/gm) ?? [];
    expect(invocations).toHaveLength(1);
    const guardIndex = source.indexOf("if (isDirectExecution())");
    expect(guardIndex).toBeGreaterThan(-1);
    expect(source.indexOf("await main(")).toBeGreaterThan(guardIndex);
  });

  it("has no timer, sleep, loop, or scheduler around the cycle", () => {
    const source = entryPointSource();
    // Real API usage only — the prose above the code names these in order to
    // disclaim them, and a naive substring match would trip on that.
    for (const forbidden of [
      "setTimeout(",
      "setInterval(",
      "setImmediate(",
      "while (",
      "for (",
      "nodemon",
      "node-cron",
    ]) {
      expect(source).not.toContain(forbidden);
    }
    // Exactly one cycle invocation, and nothing repeats it.
    expect(source.match(/await runCycle\(/g) ?? []).toHaveLength(1);
  });

  it("reads process.env only at the application boundary", () => {
    const source = entryPointSource();
    // Exactly one default; the secret source derives from that same object.
    expect(source.match(/\?\?\s*process\.env/g) ?? []).toHaveLength(1);
    expect(source).not.toContain("process.env[");
    expect(source).not.toContain("process.env.");
  });

  it("ships a package script that runs once and terminates", () => {
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url).pathname, "utf8"),
    ) as { scripts: Record<string, string> };
    const script = pkg.scripts["worker:publication:once"];
    expect(script).toBe("tsx scripts/run-publication-worker.ts");
    for (const forbidden of [
      "--watch",
      "nodemon",
      "while",
      "until",
      "for ",
      "sleep",
      "cron",
      "pm2",
      "forever",
      "--restart",
      "&&",
      ";",
      "|",
      "MONACADO_",
    ]) {
      expect(script).not.toContain(forbidden);
    }
  });

  it("documents worker variables in .env.example with no secrets and no NEXT_PUBLIC", () => {
    const example = readFileSync(
      new URL("../.env.example", import.meta.url).pathname,
      "utf8",
    );
    for (const key of Object.values(WORKER_ENV_KEYS)) {
      expect(example).toContain(key);
    }
    // No NEXT_PUBLIC assignment. (The prose above the Registrar block names the
    // prefix in order to forbid it, so only an actual assignment is a fault.)
    expect(example).not.toMatch(/^\s*(#\s*)?NEXT_PUBLIC_\w+=/m);
    // Disabled by default in the example, too.
    expect(example).toMatch(
      new RegExp(`${WORKER_ENV_KEYS.enabled}="?false"?`),
    );
  });
});
