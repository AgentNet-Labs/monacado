/**
 * Bounded publication worker-cycle integration tests (Phase 0E.7.1).
 *
 * Run ONLY against the disposable local MySQL (RUN_DB_TESTS=1). Self-skips
 * otherwise. Never point at production.
 *
 * NO NETWORK. Every transport is an injected fake. Time and attempt identities
 * come from deterministic providers, so nothing here depends on a real clock.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ProductSourceRecord } from "../src/contracts/index";
import { MONACADO_PUBLISHER_ID } from "../src/contracts/index";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { ProductRepository } from "../src/server/product/product-repository";
import {
  MONACADO_REGISTRAR_ID,
  ProductNodeRepository,
} from "../src/server/product/product-node-repository";
import { ProductPublicationService } from "../src/server/product/product-publication-service";
import { runProductPublicationWorkerCycle } from "../src/server/product/publication-worker-cycle-service";
import {
  createProcessShutdownSignal,
  SHUTDOWN_SIGNALS,
} from "../src/server/product/process-shutdown-signal";
import { InvalidWorkerCycleInputError } from "../src/server/product/worker-cycle-errors";
import { loadRegistrarRuntimeConfiguration } from "../src/server/registrar/registrar-runtime-config";
import type {
  RegisterRequestEnvelope,
  RegistrarRegisterTransport,
  TransportResult,
} from "../src/contracts/product/registrar-transport";
import type {
  RetryTimingProvider,
  ShutdownSignal,
  SubmissionAttemptIdProvider,
  TimeProvider,
  WorkerCycleMonitor,
} from "../src/contracts/product/publication-worker-cycle";
import {
  MAX_CYCLE_RUNS,
  MIN_CYCLE_RUNS,
} from "../src/contracts/product/publication-worker-cycle";

const RUN = process.env.RUN_DB_TESTS === "1";
const pad26 = (s: string): string =>
  (s.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const AVAILABLE_AT = "2026-10-01T00:00:00.000Z";
const CYCLE_START = "2026-10-01T01:00:00.000Z";
const LEASE_SECONDS = 3600;

// — Synthetic configuration —

const SECRET_VAR = "MONACADO_TEST_FAKE_CYCLE_TOKEN";
const secretSource = { [SECRET_VAR]: "fake-cycle-token-not-a-real-credential" };
const readyEnv = {
  MONACADO_REGISTRAR_ENABLED: "true",
  MONACADO_REGISTRAR_ID: MONACADO_REGISTRAR_ID,
  MONACADO_REGISTRAR_ENDPOINT: "https://registrar.example/v1/register",
  MONACADO_REGISTRAR_ALLOWED_ORIGINS: "https://registrar.example",
  MONACADO_REGISTRAR_CREDENTIAL_MODE: "BEARER_ENV",
  MONACADO_REGISTRAR_BEARER_TOKEN_ENV: SECRET_VAR,
};
const readyConfig = () => loadRegistrarRuntimeConfiguration(readyEnv);
const disabledConfig = () => loadRegistrarRuntimeConfiguration({});

// — Deterministic providers —

/** Advances by a fixed step per call. No real clock is ever consulted. */
class FakeClock implements TimeProvider {
  calls = 0;
  constructor(
    private current = Date.parse(CYCLE_START),
    private readonly stepMs = 1_000,
  ) {}
  now(): Date {
    this.calls += 1;
    const value = new Date(this.current);
    this.current += this.stepMs;
    return value;
  }
}

class FakeAttemptIds implements SubmissionAttemptIdProvider {
  issued: string[] = [];
  constructor(private readonly prefix = "WATT") {}
  nextSubmissionAttemptId(): string {
    const id = `mon:attempt:${pad26(`${this.prefix}${String(this.issued.length + 1).padStart(3, "0")}`)}`;
    this.issued.push(id);
    return id;
  }
}

const fixedRetry: RetryTimingProvider = {
  nextRetryAvailableAt: ({ attemptedAt }) => new Date(attemptedAt.getTime() + 3_600_000),
};

class FakeShutdown implements ShutdownSignal {
  checks = 0;
  constructor(private readonly requestAfter = Number.POSITIVE_INFINITY) {}
  isShutdownRequested(): boolean {
    this.checks += 1;
    return this.checks > this.requestAfter;
  }
}

/** Records every hook invocation in order, with its full event payload. */
class RecordingMonitor implements WorkerCycleMonitor {
  events: Array<{ name: string; event: Record<string, unknown> }> = [];
  private record(name: string) {
    return (event: Record<string, unknown>) => {
      this.events.push({ name, event });
    };
  }
  cycleStarted = this.record("cycleStarted");
  expiredClaimsRecovered = this.record("expiredClaimsRecovered");
  runStarted = this.record("runStarted");
  runCompleted = this.record("runCompleted");
  runFailed = this.record("runFailed");
  cycleCompleted = this.record("cycleCompleted");
  get order(): string[] {
    return this.events.map((e) => e.name);
  }
}

// — Fake transports —

class FakeTransport implements RegistrarRegisterTransport {
  calls: RegisterRequestEnvelope[] = [];
  constructor(private readonly results: TransportResult[]) {}
  async sendRegisterRequest(request: RegisterRequestEnvelope): Promise<TransportResult> {
    this.calls.push(request);
    return this.results[Math.min(this.calls.length - 1, this.results.length - 1)]!;
  }
}

const accepted = (): TransportResult => ({ outcome: "SUCCESS", transmitted: true, httpStatus: 200 });
const rejected = (): TransportResult => ({
  outcome: "REMOTE_REJECTION",
  transmitted: true,
  httpStatus: 200,
});
const preConnect = (): TransportResult => ({
  outcome: "RETRYABLE_TRANSPORT_FAILURE",
  transmitted: false,
  failure: { code: "CONNECTION_FAILED", summary: "The connection was never established" },
});
const terminal = (): TransportResult => ({
  outcome: "TERMINAL_TRANSPORT_FAILURE",
  transmitted: false,
  httpStatus: 400,
  failure: { code: "PROTOCOL_REJECTED", summary: "Refused before processing" },
});
const ambiguous = (): TransportResult => ({
  outcome: "AMBIGUOUS_DELIVERY",
  transmitted: true,
  failure: { code: "TIMEOUT", summary: "No response before the deadline" },
});

// — Fixtures —

let n = 0;
function syntheticRecord(): ProductSourceRecord {
  n += 1;
  return {
    sourceRecordId: `mon:srec:${pad26(`W${n}SREC`)}`,
    sourceRecordVersion: "1",
    internalProductId: `mon:product:${pad26(`W${n}PRD`)}`,
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    authority: {
      creatorId: `mon:creator:${pad26(`W${n}CRTR`)}`,
      authorityScope: "product-facts",
      authorizationState: "authorized",
    },
    facts: {
      name: "Worker cycle fixture product",
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      relationships: { creator: `an:node:${pad26(`W${n}CNDE`)}` },
    },
    capsuleSemver: "1.0.0",
    mappingVersion: "0e.7.1.0",
    recordStatus: "authoring-complete",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    acquiredAt: "2026-01-01T00:00:00.000Z",
    capsuleGeneratedAt: "2026-01-01T06:30:00.000Z",
  };
}

const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);
const repo = RUN ? new ProductRepository(db) : (undefined as unknown as ProductRepository);
const nodes = RUN ? new ProductNodeRepository(db) : (undefined as unknown as ProductNodeRepository);
const pubs = RUN
  ? new ProductPublicationService(db)
  : (undefined as unknown as ProductPublicationService);
let idSeq = 0;
async function seed(): Promise<{ publicationId: string; outboxId: string; payloadHash: string }> {
  const record = syntheticRecord();
  await repo.createInitialProductSourceRecord({ record });
  const node = await nodes.issueProductNode({
    nodeId: `an:node:${pad26(`W${n}NODE`)}`,
    internalProductId: record.internalProductId,
    nodeKind: "product",
    nodePolicyRef: "an:policy:node:synthetic-0e71",
    nodePolicyVersion: "1.0.0",
    registrarId: MONACADO_REGISTRAR_ID,
    issuedAt: "2026-01-02T00:00:00.000Z",
  });
  idSeq += 1;
  const result = await pubs.prepareProductPublication({
    publicationId: `mon:pub:${pad26(`WPUB${String(idSeq).padStart(3, "0")}`)}`,
    internalProductId: record.internalProductId,
    sourceRecordId: record.sourceRecordId,
    sourceRecordVersion: "1",
    nodeId: node.nodeId,
    capsuleId: `an:capsule:${pad26(`WCAP${String(idSeq).padStart(3, "0")}`)}`,
    capsuleSemver: record.capsuleSemver,
    publishedBy: MONACADO_PUBLISHER_ID,
    publishedAt: "2026-03-01T00:00:00.000Z",
    nodePolicy: { ref: "an:policy:node:synthetic-0e71", version: "1.0.0" },
    capsulePolicy: { ref: "an:policy:capsule:synthetic-0e71", version: "1.0.0" },
    availableAt: AVAILABLE_AT,
  });
  return {
    publicationId: result.publication.publicationId,
    outboxId: result.outbox.outboxId,
    payloadHash: result.outbox.payloadHash,
  };
}

interface CycleOpts {
  maximumRuns?: number;
  transport?: RegistrarRegisterTransport;
  shutdown?: ShutdownSignal;
  monitor?: WorkerCycleMonitor;
  time?: TimeProvider;
  attemptIds?: SubmissionAttemptIdProvider;
  disabled?: boolean;
  recovery?: { limit: number; availableAt?: string };
  cycleId?: string;
  dbOverride?: typeof db;
}

function cycle(opts: CycleOpts = {}) {
  return runProductPublicationWorkerCycle(
    {
      cycleStartedAt: CYCLE_START,
      maximumRuns: opts.maximumRuns ?? 3,
      leaseDurationSeconds: LEASE_SECONDS,
      ...(opts.cycleId !== undefined ? { cycleId: opts.cycleId } : {}),
      ...(opts.recovery !== undefined ? { recovery: opts.recovery } : {}),
    },
    {
      configuration: opts.disabled === true ? disabledConfig() : readyConfig(),
      secretSource,
      time: opts.time ?? new FakeClock(),
      attemptIds: opts.attemptIds ?? new FakeAttemptIds(`W${idSeq}`),
      retryTiming: fixedRetry,
      shutdown: opts.shutdown ?? new FakeShutdown(),
      ...(opts.monitor !== undefined ? { monitor: opts.monitor } : {}),
      ...(opts.transport !== undefined ? { transportOverride: opts.transport } : {}),
      db: opts.dbOverride ?? db,
    },
  );
}

async function wipe() {
  await db.publicationRemediation.deleteMany({});
  await db.registrarReceipt.deleteMany({});
  await db.publicationSubmissionAttempt.deleteMany({});
  await db.publicationOutbox.deleteMany({});
  await db.productPublication.deleteMany({});
  await db.productNode.deleteMany({});
  await db.productSourceRecordVersionRow.deleteMany({});
  await db.product.deleteMany({});
}

const outboxRow = (outboxId: string) => db.publicationOutbox.findUnique({ where: { outboxId } });

describe.skipIf(!RUN)("Bounded publication worker cycle (integration)", () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await disconnectPrisma();
  });

  // — Disabled —

  it("1 & 2. a disabled cycle returns DISABLED without any database or secret access", async () => {
    const s = await seed();
    const transport = new FakeTransport([accepted()]);
    let dbTouched = 0;
    const watchedDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (typeof prop === "string" && prop.startsWith("publication")) dbTouched += 1;
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;
    let secretReads = 0;
    const watchedSecrets = new Proxy({} as Record<string, string | undefined>, {
      get() {
        secretReads += 1;
        return undefined;
      },
    });

    const result = await runProductPublicationWorkerCycle(
      { cycleStartedAt: CYCLE_START, maximumRuns: 3, leaseDurationSeconds: LEASE_SECONDS },
      {
        configuration: disabledConfig(),
        secretSource: watchedSecrets,
        time: new FakeClock(),
        attemptIds: new FakeAttemptIds("WDIS"),
        retryTiming: fixedRetry,
        shutdown: new FakeShutdown(),
        transportOverride: transport,
        db: watchedDb,
      },
    );

    expect(result.outcome).toBe("DISABLED");
    expect(result.runsAttempted).toBe(0);
    expect(dbTouched).toBe(0);
    expect(secretReads).toBe(0);
    expect(transport.calls).toHaveLength(0);
    expect((await outboxRow(s.outboxId))?.outboxStatus).toBe("PENDING");
  });

  // — Bounds —

  it("3 & 4. maximumRuns below the minimum or above the cap is refused", async () => {
    for (const maximumRuns of [MIN_CYCLE_RUNS - 1, MAX_CYCLE_RUNS + 1, 0, -1]) {
      await expect(cycle({ maximumRuns })).rejects.toBeInstanceOf(InvalidWorkerCycleInputError);
    }
  });

  it("5. the cycle performs at most maximumRuns orchestration runs", async () => {
    for (let i = 0; i < 4; i += 1) await seed();
    const transport = new FakeTransport([accepted()]);
    const result = await cycle({ maximumRuns: 2, transport });
    expect(result.runsAttempted).toBe(2);
    expect(result.outcome).toBe("RUN_LIMIT_REACHED");
    expect(transport.calls).toHaveLength(2);
  });

  // — Stop conditions —

  it("6 & 20. the cycle stops when the queue drains", async () => {
    await seed();
    const transport = new FakeTransport([accepted()]);
    const result = await cycle({ maximumRuns: 5, transport });
    expect(result.stoppedForNoWork).toBe(true);
    expect(result.outcome).toBe("COMPLETED");
    expect(result.outcomeCounts.NO_ELIGIBLE_WORK).toBe(1);
    expect(transport.calls).toHaveLength(1);
  });

  it("7. NO_WORK is returned when the very first run finds nothing", async () => {
    const transport = new FakeTransport([accepted()]);
    const result = await cycle({ maximumRuns: 5, transport });
    expect(result.outcome).toBe("NO_WORK");
    expect(result.runsAttempted).toBe(1);
    expect(result.itemsClaimed).toBe(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("8. two eligible items are both processed in one bounded cycle", async () => {
    const a = await seed();
    const b = await seed();
    const transport = new FakeTransport([accepted()]);
    const result = await cycle({ maximumRuns: 5, transport });
    expect(result.itemsClaimed).toBe(2);
    expect(result.outcomeCounts.SENT).toBe(2);
    for (const s of [a, b]) {
      expect((await outboxRow(s.outboxId))?.outboxStatus).toBe("PROCESSING");
    }
  });

  it("9. one attempt id is consumed per processing run, and none is wasted on an empty queue", async () => {
    await seed();
    const attemptIds = new FakeAttemptIds("WID");
    const transport = new FakeTransport([accepted()]);
    await cycle({ maximumRuns: 5, transport, attemptIds });
    // Two ids: one for the processed item, one for the run that found the queue
    // empty. The empty run still needs an id before it can ask for work.
    expect(attemptIds.issued).toHaveLength(2);
    expect(await db.publicationSubmissionAttempt.count()).toBe(1);
  });

  it("10. no hidden clock or randomness is used", async () => {
    await seed();
    const clock = new FakeClock();
    const transport = new FakeTransport([accepted()]);
    await cycle({ maximumRuns: 2, transport, time: clock });
    // Every timestamp came from the injected provider.
    expect(clock.calls).toBeGreaterThan(0);
    const source = (await import("node:fs")).readFileSync(
      "src/server/product/publication-worker-cycle-service.ts",
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("Date.now()");
    expect(code).not.toContain("new Date()");
    expect(code).not.toContain("Math.random");
  });

  // — Shutdown —

  it("11. shutdown before the first run returns SHUTDOWN_REQUESTED with no runs", async () => {
    await seed();
    const transport = new FakeTransport([accepted()]);
    const result = await cycle({ maximumRuns: 5, transport, shutdown: new FakeShutdown(0) });
    expect(result.outcome).toBe("SHUTDOWN_REQUESTED");
    expect(result.shutdownRequested).toBe(true);
    expect(result.runsAttempted).toBe(0);
    expect(transport.calls).toHaveLength(0);
  });

  it("12 & 13. shutdown after one run prevents the next, and is checked at each boundary", async () => {
    await seed();
    await seed();
    const transport = new FakeTransport([accepted()]);
    // Allow the pre-run check, then report shutdown at the post-result check.
    const shutdown = new FakeShutdown(1);
    const result = await cycle({ maximumRuns: 5, transport, shutdown });
    expect(result.outcome).toBe("SHUTDOWN_REQUESTED");
    expect(result.runsAttempted).toBe(1);
    expect(transport.calls).toHaveLength(1);
    // Checked before the run and again after its result.
    expect(shutdown.checks).toBeGreaterThanOrEqual(2);
  });

  // — Aggregation —

  it("14-18. each orchestration outcome is aggregated under its own key", async () => {
    const expectedKeys = {
      SENT: accepted,
      REMOTE_REJECTION: rejected,
      RETRY_SCHEDULED: preConnect,
      DEAD_LETTERED: terminal,
      AMBIGUOUS_DELIVERY: ambiguous,
    } as const;

    for (const [key, make] of Object.entries(expectedKeys)) {
      await wipe();
      await seed();
      const result = await cycle({
        maximumRuns: 1,
        transport: new FakeTransport([make()]),
        attemptIds: new FakeAttemptIds(`WAG${key.slice(0, 2)}`),
      });
      expect(result.outcomeCounts[key as keyof typeof result.outcomeCounts]).toBe(1);
      expect(result.itemsClaimed).toBe(1);
    }
  });

  it("19. a failed run stops the cycle under the documented policy", async () => {
    await seed();
    await seed();
    // A transport whose second call throws would be a run failure; instead force
    // a run-level failure by breaking the post-transport write.
    const brokenDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "publicationSubmissionAttempt") {
          return new Proxy(Reflect.get(target, prop, receiver) as object, {
            get(t, p, r) {
              if (p === "update" || p === "updateMany") {
                return async () => {
                  throw new Error("synthetic persistence failure");
                };
              }
              return Reflect.get(t, p, r);
            },
          });
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;

    const transport = new FakeTransport([preConnect()]);
    const result = await cycle({ maximumRuns: 5, transport, dbOverride: brokenDb });
    expect(result.outcome).toBe("FAILED");
    expect(result.runsAttempted).toBe(1);
    // 30. The failure did not cause another send.
    expect(transport.calls).toHaveLength(1);
    expect(result.issues).toContain("POST_TRANSPORT_PERSISTENCE_FAILURE");
  });

  // — Ambiguity —

  it("21 & 22. ambiguous work is never resent, but later eligible work still processes", async () => {
    const first = await seed();
    const second = await seed();
    // First call ambiguous, every later call accepted.
    const transport = new FakeTransport([ambiguous(), accepted()]);
    const result = await cycle({ maximumRuns: 5, transport });

    expect(result.outcomeCounts.AMBIGUOUS_DELIVERY).toBe(1);
    expect(result.outcomeCounts.SENT).toBe(1);
    // The ambiguous item is still held; it was sent exactly once.
    expect((await outboxRow(first.outboxId))?.outboxStatus).toBe("PROCESSING");
    expect((await outboxRow(second.outboxId))?.outboxStatus).toBe("PROCESSING");
    const sentAttempts = transport.calls.map((c) => c.outboxId);
    expect(new Set(sentAttempts).size).toBe(sentAttempts.length);
  });

  // — Recovery —

  it("23 & 25. recovery runs once when enabled and reports only safe counts", async () => {
    await seed();
    const monitor = new RecordingMonitor();
    const transport = new FakeTransport([accepted()]);
    const result = await cycle({
      maximumRuns: 3,
      transport,
      monitor,
      recovery: { limit: 10, availableAt: CYCLE_START },
    });

    expect(result.recovery).toBeDefined();
    expect(Object.keys(result.recovery ?? {}).sort()).toEqual([
      "examined",
      "recoveredCount",
      "skippedCount",
    ]);
    // Exactly one recovery event, no matter how many runs happened.
    expect(monitor.order.filter((e) => e === "expiredClaimsRecovered")).toHaveLength(1);
  });

  it("24. recovery is absent when not requested", async () => {
    await seed();
    const monitor = new RecordingMonitor();
    const result = await cycle({ maximumRuns: 2, transport: new FakeTransport([accepted()]), monitor });
    expect(result.recovery).toBeUndefined();
    expect(monitor.order).not.toContain("expiredClaimsRecovered");
  });

  // — Monitoring —

  it("26. monitoring events fire in deterministic order", async () => {
    await seed();
    const monitor = new RecordingMonitor();
    await cycle({
      maximumRuns: 2,
      transport: new FakeTransport([accepted()]),
      monitor,
      recovery: { limit: 5 },
    });
    expect(monitor.order).toEqual([
      "cycleStarted",
      "expiredClaimsRecovered",
      "runStarted",
      "runCompleted",
      "runStarted",
      "runCompleted",
      "cycleCompleted",
    ]);
  });

  it("27. monitoring receives no payload, secret, hash, token, endpoint, or raw cause", async () => {
    const s = await seed();
    const monitor = new RecordingMonitor();
    await cycle({ maximumRuns: 2, transport: new FakeTransport([accepted()]), monitor });
    const serialized = JSON.stringify(monitor.events);
    for (const forbidden of [
      "fake-cycle-token-not-a-real-credential",
      SECRET_VAR,
      "registrar.example",
      "Bearer",
      s.payloadHash,
      "lockToken",
      "claimTokenHash",
      '"payload"',
      "sha256:",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("28. a monitoring-hook failure is collected as an issue and never stops the cycle", async () => {
    await seed();
    const hostile: WorkerCycleMonitor = {
      runStarted() {
        throw new Error("hook exploded");
      },
      cycleStarted() {
        throw new Error("hook exploded");
      },
    };
    const transport = new FakeTransport([accepted()]);
    const result = await cycle({ maximumRuns: 3, transport, monitor: hostile });
    // Work still happened, and the outcome is authoritative.
    expect(result.outcomeCounts.SENT).toBe(1);
    expect(result.issues).toContain("MONITORING_HOOK_FAILURE");
    expect(["COMPLETED", "NO_WORK"]).toContain(result.outcome);
  });

  // — Structural guarantees —

  it("29 & 35. the service opens no transaction and contains no timer, sleep, or recursion", async () => {
    const source = (await import("node:fs")).readFileSync(
      "src/server/product/publication-worker-cycle-service.ts",
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const forbidden of [
      "$transaction",
      "setTimeout",
      "setInterval",
      "setImmediate",
      "process.exit",
      "process.on",
    ]) {
      expect(code).not.toContain(forbidden);
    }
    // Exactly one self-reference: the function declaration itself.
    expect(code.match(/runProductPublicationWorkerCycle/g)).toHaveLength(1);
    // No receipt ingestion.
    expect(code).not.toContain("ingestRegistrarReceipt");
  });

  // — Process adapter —

  it("31-34. the process adapter registers only when invoked and unregisters cleanly", async () => {
    const before = SHUTDOWN_SIGNALS.map((s) => process.listenerCount(s));

    const signal = createProcessShutdownSignal();
    const during = SHUTDOWN_SIGNALS.map((s) => process.listenerCount(s));
    during.forEach((count, i) => expect(count).toBe(before[i]! + 1));

    expect(signal.isShutdownRequested()).toBe(false);
    expect(signal.signal).toBeUndefined();

    // Repeated registration then cleanup must not leak.
    const second = createProcessShutdownSignal();
    second.unregister();
    signal.unregister();
    // Idempotent.
    signal.unregister();
    const after = SHUTDOWN_SIGNALS.map((s) => process.listenerCount(s));
    expect(after).toEqual(before);

    const source = (await import("node:fs")).readFileSync(
      "src/server/product/process-shutdown-signal.ts",
      "utf8",
    );
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("process.exit");
    // Nothing runs at import time: handlers are installed inside the factory only.
    expect(code.split("export function createProcessShutdownSignal")[0]).not.toContain("process.on");
  });

  it("32b. the shutdown flag latches and records the first signal", () => {
    const signal = createProcessShutdownSignal();
    try {
      process.emit("SIGTERM");
      expect(signal.isShutdownRequested()).toBe(true);
      expect(signal.signal).toBe("SIGTERM");
      process.emit("SIGINT");
      // Latched: a second signal neither clears it nor rewrites the first cause.
      expect(signal.isShutdownRequested()).toBe(true);
      expect(signal.signal).toBe("SIGTERM");
    } finally {
      signal.unregister();
    }
  });

  // — Leakage —

  it("36. cycle results and errors expose no sensitive data", async () => {
    const s = await seed();
    const result = await cycle({ maximumRuns: 2, transport: new FakeTransport([accepted()]) });
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "fake-cycle-token-not-a-real-credential",
      SECRET_VAR,
      "registrar.example",
      "Bearer",
      s.payloadHash,
      "lockToken",
      '"payload"',
      "sha256:",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    try {
      await cycle({ maximumRuns: 0 });
    } catch (error) {
      expect(Object.keys(error as object)).not.toContain("internalCause");
      expect(JSON.stringify(error)).not.toContain("internalCause");
    }
  });

  it("36b. the cycle creates no Registrar receipt", async () => {
    await seed();
    await cycle({ maximumRuns: 3, transport: new FakeTransport([accepted()]) });
    expect(await db.registrarReceipt.count()).toBe(0);
    // And the attempt is left awaiting explicit ingestion.
    const rows = await db.publicationSubmissionAttempt.findMany({});
    expect(rows.map((r) => r.attemptStatus)).toEqual(["DISPATCHED"]);
  });
});
