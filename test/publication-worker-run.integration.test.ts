/**
 * Durable worker-run status integration tests (Phase 0E.7.3).
 *
 * Run ONLY against the disposable local MySQL (RUN_DB_TESTS=1). Self-skips
 * otherwise. Never point at production.
 *
 * NO NETWORK. The worker cycle is faked wherever the entry point is exercised, so
 * nothing opens a socket or contacts a Registrar. Every instant is explicit.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { PublicationWorkerRunRepository } from "../src/server/product/publication-worker-run-repository";
import { getPublicationWorkerHealth } from "../src/server/product/publication-worker-health-service";
import {
  DuplicateWorkerRunCycleIdError,
  InvalidWorkerRunInputError,
  WorkerRunNotFoundError,
  WorkerRunTerminalConflictError,
} from "../src/server/product/worker-run-errors";
import {
  EXIT_CONFIGURATION,
  EXIT_STATUS_PERSISTENCE_FAILURE,
  EXIT_SUCCESS,
  main,
  type RunWorkerCycle,
  type WorkerCommandDeps,
} from "../scripts/run-publication-worker";
import { WORKER_ENV_KEYS } from "../src/server/product/worker-runtime-config";
import { ENV_KEYS as REGISTRAR_ENV_KEYS } from "../src/server/registrar/registrar-runtime-config";
import { emptyOutcomeCounts, type WorkerCycleResult } from "../src/contracts/product/publication-worker-cycle";
import type { MonitoringSink, MonitoringStream } from "../src/server/product/worker-monitoring";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = getPrisma();
const repo = new PublicationWorkerRunRepository(db);

const NOW = "2026-12-01T10:00:00.000Z";
const shift = (iso: string, seconds: number): string =>
  new Date(Date.parse(iso) + seconds * 1_000).toISOString();

/** Every cycle id this file writes shares this prefix, so cleanup is exact. */
const PREFIX = "wrtest-";
let seq = 0;
const nextCycleId = (): string => {
  seq += 1;
  return `${PREFIX}${String(seq).padStart(4, "0")}`;
};

async function cleanup(): Promise<void> {
  await db.publicationWorkerRun.deleteMany({ where: { cycleId: { startsWith: PREFIX } } });
}

// — Synthetic command fixtures (no network, no real Registrar) —

const SECRET_VAR = "MONACADO_TEST_FAKE_RUNSTATUS_TOKEN";
const FAKE_SECRET = "fake-runstatus-token-not-a-real-credential";
const FAKE_REGISTRAR_ID = "an:registrar:0000000000000000000000TEST";

function readyEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    [WORKER_ENV_KEYS.enabled]: "true",
    [WORKER_ENV_KEYS.maximumRuns]: "4",
    [WORKER_ENV_KEYS.leaseSeconds]: "3600",
    [WORKER_ENV_KEYS.retryDelaySeconds]: "900",
    [REGISTRAR_ENV_KEYS.enabled]: "true",
    [REGISTRAR_ENV_KEYS.registrarId]: FAKE_REGISTRAR_ID,
    [REGISTRAR_ENV_KEYS.endpoint]: "https://registrar.example/v1/register",
    [REGISTRAR_ENV_KEYS.allowedOrigins]: "https://registrar.example",
    [REGISTRAR_ENV_KEYS.credentialMode]: "BEARER_ENV",
    [REGISTRAR_ENV_KEYS.bearerTokenEnv]: SECRET_VAR,
    ...overrides,
  };
}

class RecordingSink implements MonitoringSink {
  lines: Array<{ stream: MonitoringStream; line: string }> = [];
  writeLine(stream: MonitoringStream, line: string): void {
    this.lines.push({ stream, line });
  }
  events(): Array<Record<string, unknown>> {
    return this.lines.map(({ line }) => JSON.parse(line) as Record<string, unknown>);
  }
  names(): string[] {
    return this.events().map((e) => String(e.event));
  }
  text(): string {
    return this.lines.map((l) => l.line).join("\n");
  }
}

class FixedClock {
  constructor(private current = Date.parse(NOW)) {}
  now(): Date {
    const value = new Date(this.current);
    this.current += 1_000;
    return value;
  }
}

function cycleResult(overrides: Partial<WorkerCycleResult> = {}): WorkerCycleResult {
  return {
    outcome: "COMPLETED",
    startedAt: NOW,
    completedAt: shift(NOW, 5),
    runsAttempted: 2,
    itemsClaimed: 1,
    outcomeCounts: { ...emptyOutcomeCounts(), SENT: 1, NO_ELIGIBLE_WORK: 1 },
    shutdownRequested: false,
    stoppedForNoWork: true,
    issues: [],
    ...overrides,
  };
}

interface CommandHarness {
  deps: WorkerCommandDeps;
  sink: RecordingSink;
  exitTarget: { exitCode: number };
  cycleCalls: number;
  cycleId: string;
}

/** A READY command with the cycle faked and the REAL worker-run repository. */
function command(
  options: {
    env?: Record<string, string | undefined>;
    cycle?: WorkerCycleResult;
    cycleImpl?: RunWorkerCycle;
    workerRuns?: WorkerCommandDeps["workerRuns"];
    cycleId?: string;
  } = {},
): CommandHarness {
  const sink = new RecordingSink();
  const exitTarget = { exitCode: -1 };
  const cycleId = options.cycleId ?? nextCycleId();
  const state = { calls: 0 };

  const runCycle: RunWorkerCycle =
    options.cycleImpl ??
    (async () => {
      state.calls += 1;
      return options.cycle ?? cycleResult();
    });

  return {
    sink,
    exitTarget,
    cycleId,
    get cycleCalls() {
      return state.calls;
    },
    deps: {
      env: options.env ?? readyEnv(),
      secretSource: { [SECRET_VAR]: FAKE_SECRET },
      sink,
      exitCodeTarget: exitTarget,
      time: new FixedClock(),
      cycleId,
      runCycle: options.cycleImpl ?? runCycle,
      createDb: () => db,
      // This suite owns the client for its whole run.
      disconnect: async () => {},
      createShutdownSignal: () => ({
        isShutdownRequested: () => false,
        signal: undefined,
        unregister: () => {},
      }),
      ...(options.workerRuns !== undefined ? { workerRuns: options.workerRuns } : {}),
      transportOverride: {
        async sendRegisterRequest() {
          throw new Error("no external traffic permitted");
        },
      },
    },
  };
}

const startedRun = async (overrides: { cycleId?: string; startedAt?: string } = {}) => {
  const cycleId = overrides.cycleId ?? nextCycleId();
  await repo.startPublicationWorkerRun({
    cycleId,
    startedAt: overrides.startedAt ?? NOW,
    maximumRuns: 5,
  });
  return cycleId;
};

const completionFor = (cycleId: string, overrides: Record<string, unknown> = {}) => ({
  cycleId,
  completedAt: shift(NOW, 30),
  outcome: "COMPLETED",
  exitCode: 0,
  runsAttempted: 2,
  itemsClaimed: 1,
  stoppedForNoWork: true,
  shutdownRequested: false,
  expiredClaimsExamined: 0,
  expiredClaimsRecovered: 0,
  expiredClaimsSkipped: 0,
  issueCodes: [],
  ...overrides,
});

describe.skipIf(!RUN)("durable publication worker-run status (disposable MySQL)", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  // — Lifecycle —

  it("creates a STARTED row from explicit input", async () => {
    const cycleId = nextCycleId();
    const record = await repo.startPublicationWorkerRun({
      cycleId,
      startedAt: NOW,
      maximumRuns: 7,
    });
    expect(record).toMatchObject({
      cycleId,
      status: "STARTED",
      outcome: null,
      exitCode: null,
      maximumRuns: 7,
      runsAttempted: 0,
      itemsClaimed: 0,
      issueCodes: [],
      startedAt: NOW,
      completedAt: null,
    });
    // The surrogate row id never leaves the service.
    expect(Object.keys(record)).not.toContain("id");
  });

  it("refuses malformed start input", async () => {
    await expect(
      repo.startPublicationWorkerRun({ cycleId: nextCycleId(), startedAt: NOW }),
    ).rejects.toThrow(InvalidWorkerRunInputError);
    await expect(
      repo.startPublicationWorkerRun({
        cycleId: nextCycleId(),
        startedAt: NOW,
        maximumRuns: 101,
      }),
    ).rejects.toThrow(InvalidWorkerRunInputError);
  });

  it("enforces cycleId uniqueness", async () => {
    const cycleId = await startedRun();
    await expect(
      repo.startPublicationWorkerRun({ cycleId, startedAt: NOW, maximumRuns: 5 }),
    ).rejects.toThrow(DuplicateWorkerRunCycleIdError);
    expect(await db.publicationWorkerRun.count({ where: { cycleId } })).toBe(1);
  });

  it("completes a STARTED run with the bounded summary", async () => {
    const cycleId = await startedRun();
    const record = await repo.completePublicationWorkerRun(
      completionFor(cycleId, {
        outcome: "RUN_LIMIT_REACHED",
        runsAttempted: 4,
        itemsClaimed: 4,
        stoppedForNoWork: false,
        expiredClaimsExamined: 3,
        expiredClaimsRecovered: 2,
        expiredClaimsSkipped: 1,
        issueCodes: ["MONITORING_HOOK_FAILURE"],
      }),
    );
    expect(record).toMatchObject({
      status: "COMPLETED",
      outcome: "RUN_LIMIT_REACHED",
      runsAttempted: 4,
      itemsClaimed: 4,
      expiredClaimsExamined: 3,
      expiredClaimsRecovered: 2,
      expiredClaimsSkipped: 1,
      issueCodes: ["MONITORING_HOOK_FAILURE"],
      completedAt: shift(NOW, 30),
    });
  });

  it("derives FAILED status from a FAILED cycle outcome", async () => {
    const cycleId = await startedRun();
    const record = await repo.completePublicationWorkerRun(
      completionFor(cycleId, { outcome: "FAILED", exitCode: 1, issueCodes: ["WORKER_CYCLE_FAILURE"] }),
    );
    // Status is derived, so no caller can record a failure as a success.
    expect(record.status).toBe("FAILED");
    expect(record.outcome).toBe("FAILED");
  });

  it("fails a run that never produced a cycle result, leaving outcome null", async () => {
    const cycleId = await startedRun();
    const record = await repo.failPublicationWorkerRun({
      cycleId,
      completedAt: shift(NOW, 10),
      exitCode: 1,
      issueCodes: ["RUN_STATUS_PERSISTENCE_FAILURE"],
    });
    expect(record.status).toBe("FAILED");
    // Null, not "FAILED": the work was never attempted, which is a different fact.
    expect(record.outcome).toBeNull();
  });

  it("stores issue codes sorted and deduplicated", async () => {
    const cycleId = await startedRun();
    const record = await repo.completePublicationWorkerRun(
      completionFor(cycleId, { issueCodes: ["Z_CODE", "A_CODE", "Z_CODE"] }),
    );
    expect(record.issueCodes).toEqual(["A_CODE", "Z_CODE"]);
    const raw = await db.publicationWorkerRun.findUnique({ where: { cycleId } });
    expect(raw!.issueCodes).toBe("A_CODE,Z_CODE");
  });

  it("refuses an unsafe issue code rather than storing part of it", async () => {
    const cycleId = await startedRun();
    await expect(
      repo.completePublicationWorkerRun(
        completionFor(cycleId, { issueCodes: ["connect ECONNREFUSED 10.0.0.1:3306"] }),
      ),
    ).rejects.toThrow(InvalidWorkerRunInputError);
    const raw = await db.publicationWorkerRun.findUnique({ where: { cycleId } });
    expect(raw!.status).toBe("STARTED");
    expect(raw!.issueCodes).toBe("");
  });

  it("returns the stored record for an identical terminal replay", async () => {
    const cycleId = await startedRun();
    const first = await repo.completePublicationWorkerRun(completionFor(cycleId));
    const replay = await repo.completePublicationWorkerRun(completionFor(cycleId));
    expect(replay).toEqual(first);
    // Order-independent issue codes still count as identical.
    const withCodes = await startedRun();
    const a = await repo.completePublicationWorkerRun(
      completionFor(withCodes, { issueCodes: ["B_CODE", "A_CODE"] }),
    );
    const b = await repo.completePublicationWorkerRun(
      completionFor(withCodes, { issueCodes: ["A_CODE", "B_CODE"] }),
    );
    expect(b).toEqual(a);
  });

  it("refuses a conflicting terminal replay", async () => {
    const cycleId = await startedRun();
    await repo.completePublicationWorkerRun(completionFor(cycleId));
    for (const conflict of [
      { outcome: "NO_WORK" },
      { exitCode: 1 },
      { itemsClaimed: 99 },
      { completedAt: shift(NOW, 31) },
      { issueCodes: ["CLEANUP_FAILURE"] },
    ]) {
      await expect(
        repo.completePublicationWorkerRun(completionFor(cycleId, conflict)),
      ).rejects.toThrow(WorkerRunTerminalConflictError);
    }
    const raw = await db.publicationWorkerRun.findUnique({ where: { cycleId } });
    expect(raw!.status).toBe("COMPLETED");
    expect(raw!.exitCode).toBe(0);
  });

  it("never returns a terminal run to STARTED, or rewrites it as failed", async () => {
    const cycleId = await startedRun();
    await repo.completePublicationWorkerRun(completionFor(cycleId));
    await expect(
      repo.failPublicationWorkerRun({
        cycleId,
        completedAt: shift(NOW, 40),
        exitCode: 1,
        issueCodes: ["WORKER_CYCLE_FAILURE"],
      }),
    ).rejects.toThrow(WorkerRunTerminalConflictError);
    expect((await repo.getPublicationWorkerRun(cycleId))!.status).toBe("COMPLETED");
  });

  it("reports a missing run rather than creating one", async () => {
    await expect(
      repo.completePublicationWorkerRun(completionFor(`${PREFIX}absent`)),
    ).rejects.toThrow(WorkerRunNotFoundError);
    expect(await db.publicationWorkerRun.count({ where: { cycleId: `${PREFIX}absent` } })).toBe(0);
  });

  it("mutates no publication-domain table", async () => {
    const before = await Promise.all([
      db.productPublication.count(),
      db.publicationOutbox.count(),
      db.publicationSubmissionAttempt.count(),
      db.registrarReceipt.count(),
      db.publicationRemediation.count(),
    ]);
    const cycleId = await startedRun();
    await repo.completePublicationWorkerRun(completionFor(cycleId));
    await repo.abandonStalePublicationWorkerRuns({
      startedBefore: shift(NOW, 999),
      abandonedAt: shift(NOW, 1_000),
      limit: 10,
    });
    const after = await Promise.all([
      db.productPublication.count(),
      db.publicationOutbox.count(),
      db.publicationSubmissionAttempt.count(),
      db.registrarReceipt.count(),
      db.publicationRemediation.count(),
    ]);
    expect(after).toEqual(before);
  });

  // — Abandonment —

  it("abandons only stale STARTED rows, oldest first, within the limit", async () => {
    const oldest = await startedRun({ startedAt: shift(NOW, -7_200) });
    const middle = await startedRun({ startedAt: shift(NOW, -5_400) });
    const newest = await startedRun({ startedAt: shift(NOW, -3_600) });
    const recent = await startedRun({ startedAt: shift(NOW, -60) });
    const done = await startedRun({ startedAt: shift(NOW, -7_200) });
    await repo.completePublicationWorkerRun(completionFor(done));

    // Bounded batch: only the two oldest eligible rows.
    const sweep = await repo.abandonStalePublicationWorkerRuns({
      startedBefore: shift(NOW, -1_800),
      abandonedAt: NOW,
      limit: 2,
    });
    expect(sweep).toEqual({ examined: 2, abandonedCount: 2, skippedCount: 0 });

    expect((await repo.getPublicationWorkerRun(oldest))!.status).toBe("ABANDONED");
    expect((await repo.getPublicationWorkerRun(middle))!.status).toBe("ABANDONED");
    // Beyond the limit, still STARTED.
    expect((await repo.getPublicationWorkerRun(newest))!.status).toBe("STARTED");
    // Inside the cutoff, untouched.
    expect((await repo.getPublicationWorkerRun(recent))!.status).toBe("STARTED");
    // Terminal history is never abandoned.
    expect((await repo.getPublicationWorkerRun(done))!.status).toBe("COMPLETED");
  });

  it("records WORKER_RUN_STALE and preserves original timestamps", async () => {
    const cycleId = await startedRun({ startedAt: shift(NOW, -7_200) });
    await repo.abandonStalePublicationWorkerRuns({
      startedBefore: NOW,
      abandonedAt: shift(NOW, 5),
      limit: 10,
    });
    const record = (await repo.getPublicationWorkerRun(cycleId))!;
    expect(record.status).toBe("ABANDONED");
    expect(record.issueCodes).toEqual(["WORKER_RUN_STALE"]);
    expect(record.startedAt).toBe(shift(NOW, -7_200));
    expect(record.completedAt).toBe(shift(NOW, 5));
    expect(record.outcome).toBeNull();
  });

  it("does not overwrite a run that finished between the scan and the update", async () => {
    // The compare-and-set re-asserts STARTED, so a concurrent finish wins.
    const cycleId = await startedRun({ startedAt: shift(NOW, -7_200) });
    await repo.completePublicationWorkerRun(completionFor(cycleId));
    const sweep = await repo.abandonStalePublicationWorkerRuns({
      startedBefore: NOW,
      abandonedAt: NOW,
      limit: 10,
    });
    expect(sweep.abandonedCount).toBe(0);
    expect((await repo.getPublicationWorkerRun(cycleId))!.status).toBe("COMPLETED");
  });

  it("bounds and validates the sweep input", async () => {
    for (const bad of [
      { startedBefore: NOW, abandonedAt: NOW, limit: 0 },
      { startedBefore: NOW, abandonedAt: NOW, limit: 1_001 },
      { startedBefore: NOW, abandonedAt: NOW },
      { abandonedAt: NOW, limit: 5 },
    ]) {
      await expect(repo.abandonStalePublicationWorkerRuns(bad)).rejects.toThrow(
        InvalidWorkerRunInputError,
      );
    }
  });

  // — Queries —

  it("lists recent runs newest first, bounded, with a stable tie-break", async () => {
    const a = await startedRun({ startedAt: shift(NOW, -300) });
    const b = await startedRun({ startedAt: shift(NOW, -200) });
    const c = await startedRun({ startedAt: shift(NOW, -100) });
    await repo.completePublicationWorkerRun(completionFor(c));

    const all = await repo.listRecentPublicationWorkerRuns({ limit: 10 });
    const mine = all.filter((r) => r.cycleId.startsWith(PREFIX)).map((r) => r.cycleId);
    expect(mine).toEqual([c, b, a]);

    const limited = await repo.listRecentPublicationWorkerRuns({ limit: 1 });
    expect(limited).toHaveLength(1);

    const terminal = await repo.listRecentPublicationWorkerRuns({ limit: 10, terminalOnly: true });
    expect(terminal.filter((r) => r.cycleId.startsWith(PREFIX)).map((r) => r.cycleId)).toEqual([c]);

    for (const limit of [0, 101]) {
      await expect(repo.listRecentPublicationWorkerRuns({ limit })).rejects.toThrow(
        InvalidWorkerRunInputError,
      );
    }
  });

  it("assesses health from the durable store with an explicit instant", async () => {
    // NO_HISTORY: the table has no terminal rows for this window.
    await db.publicationWorkerRun.deleteMany({});
    const empty = await getPublicationWorkerHealth({
      assessedAt: NOW,
      freshnessSeconds: 3_600,
      limit: 10,
      db,
    });
    expect(empty.assessment).toBe("NO_HISTORY");
    expect(empty.scope).toBe("PUBLICATION_WORKER_ONLY");

    // HEALTHY: one recent coherent run.
    const healthy = await startedRun({ startedAt: shift(NOW, -120) });
    await repo.completePublicationWorkerRun(
      completionFor(healthy, { completedAt: shift(NOW, -60), outcome: "NO_WORK" }),
    );
    expect(
      (await getPublicationWorkerHealth({ assessedAt: NOW, freshnessSeconds: 3_600, limit: 10, db }))
        .assessment,
    ).toBe("HEALTHY");

    // STALE: the same data, assessed much later.
    expect(
      (
        await getPublicationWorkerHealth({
          assessedAt: shift(NOW, 86_400),
          freshnessSeconds: 3_600,
          limit: 10,
          db,
        })
      ).assessment,
    ).toBe("STALE");

    // DEGRADED: a newer coherent run carrying an operational issue.
    const degraded = await startedRun({ startedAt: shift(NOW, -30) });
    await repo.completePublicationWorkerRun(
      completionFor(degraded, { completedAt: shift(NOW, -10), issueCodes: ["MONITORING_HOOK_FAILURE"] }),
    );
    expect(
      (await getPublicationWorkerHealth({ assessedAt: NOW, freshnessSeconds: 3_600, limit: 10, db }))
        .assessment,
    ).toBe("DEGRADED");

    // FAILED: the newest terminal run failed.
    const failed = await startedRun({ startedAt: shift(NOW, -5) });
    await repo.completePublicationWorkerRun(
      completionFor(failed, { completedAt: shift(NOW, -1), outcome: "FAILED", exitCode: 1 }),
    );
    const failedHealth = await getPublicationWorkerHealth({
      assessedAt: NOW,
      freshnessSeconds: 3_600,
      limit: 10,
      db,
    });
    expect(failedHealth.assessment).toBe("FAILED");
    expect(failedHealth.mostRecentCycleId).toBe(failed);

    // Bounds are enforced by the query, not clamped.
    await expect(
      getPublicationWorkerHealth({ assessedAt: NOW, freshnessSeconds: 3_600, limit: 0, db }),
    ).rejects.toThrow(InvalidWorkerRunInputError);
    await expect(
      getPublicationWorkerHealth({ assessedAt: NOW, freshnessSeconds: 0, limit: 10, db }),
    ).rejects.toThrow(InvalidWorkerRunInputError);
    // A run completing after the assessment instant is refused, not clamped.
    await expect(
      getPublicationWorkerHealth({
        assessedAt: shift(NOW, -3_600),
        freshnessSeconds: 3_600,
        limit: 10,
        db,
      }),
    ).rejects.toThrow(InvalidWorkerRunInputError);
  });

  // — Entry-point integration —

  it("persists no run for a disabled command", async () => {
    const h = command({ env: {} });
    const result = await main(h.deps);
    expect(result.status).toBe("DISABLED");
    expect(result.exitCode).toBe(EXIT_SUCCESS);
    expect(await db.publicationWorkerRun.count({ where: { cycleId: h.cycleId } })).toBe(0);
    expect(h.cycleCalls).toBe(0);
  });

  it("persists no run for invalid or incomplete configuration", async () => {
    const invalid = command({ env: readyEnv({ [WORKER_ENV_KEYS.maximumRuns]: "0" }) });
    const a = await main(invalid.deps);
    expect(a.exitCode).toBe(EXIT_CONFIGURATION);
    expect(await db.publicationWorkerRun.count({ where: { cycleId: invalid.cycleId } })).toBe(0);

    const incomplete = command({ env: readyEnv({ [WORKER_ENV_KEYS.leaseSeconds]: undefined }) });
    const b = await main(incomplete.deps);
    expect(b.exitCode).toBe(EXIT_CONFIGURATION);
    expect(await db.publicationWorkerRun.count({ where: { cycleId: incomplete.cycleId } })).toBe(0);
  });

  it("creates exactly one row per invocation and finalises it COMPLETED", async () => {
    const h = command();
    const result = await main(h.deps);
    expect(result.status).toBe("CYCLE_FINISHED");
    expect(result.exitCode).toBe(EXIT_SUCCESS);
    expect(h.cycleCalls).toBe(1);

    expect(await db.publicationWorkerRun.count({ where: { cycleId: h.cycleId } })).toBe(1);
    const record = (await repo.getPublicationWorkerRun(h.cycleId))!;
    expect(record).toMatchObject({
      status: "COMPLETED",
      outcome: "COMPLETED",
      exitCode: 0,
      maximumRuns: 4,
      runsAttempted: 2,
      itemsClaimed: 1,
      completedAt: shift(NOW, 5),
    });
    // The durable cycleId is the one the monitoring output used.
    expect(h.sink.events().every((e) => e.cycleId === h.cycleId)).toBe(true);
    expect(h.sink.names()).toContain("worker.run_status_started");
    expect(h.sink.names()).toContain("worker.run_status_persisted");
  });

  it("writes STARTED before the cycle runs", async () => {
    let statusAtCycle: string | undefined;
    const h = command({
      cycleImpl: async () => {
        const row = await db.publicationWorkerRun.findFirst({
          where: { cycleId: { startsWith: PREFIX }, status: "STARTED" },
        });
        statusAtCycle = row?.status;
        return cycleResult();
      },
    });
    await main(h.deps);
    // The row was already durable while the cycle was executing.
    expect(statusAtCycle).toBe("STARTED");
  });

  it("finalises NO_WORK, RUN_LIMIT_REACHED, and SHUTDOWN_REQUESTED coherently", async () => {
    for (const outcome of ["NO_WORK", "RUN_LIMIT_REACHED", "SHUTDOWN_REQUESTED"] as const) {
      const h = command({
        cycle: cycleResult({
          outcome,
          runsAttempted: outcome === "NO_WORK" ? 1 : 4,
          itemsClaimed: outcome === "NO_WORK" ? 0 : 4,
          shutdownRequested: outcome === "SHUTDOWN_REQUESTED",
        }),
      });
      const result = await main(h.deps);
      expect(result.exitCode).toBe(EXIT_SUCCESS);
      const record = (await repo.getPublicationWorkerRun(h.cycleId))!;
      expect(record.status).toBe("COMPLETED");
      expect(record.outcome).toBe(outcome);
    }
  });

  it("finalises a FAILED cycle as FAILED without a second cycle", async () => {
    const h = command({
      cycle: cycleResult({ outcome: "FAILED", issues: ["MONITORING_HOOK_FAILURE"] }),
    });
    const result = await main(h.deps);
    expect(result.exitCode).not.toBe(EXIT_SUCCESS);
    expect(h.cycleCalls).toBe(1);
    const record = (await repo.getPublicationWorkerRun(h.cycleId))!;
    expect(record.status).toBe("FAILED");
    expect(record.outcome).toBe("FAILED");
    expect(record.issueCodes).toEqual(["MONITORING_HOOK_FAILURE"]);
  });

  it("attempts FAILED finalisation when the cycle throws", async () => {
    const h = command({
      cycleImpl: async () => {
        const error = new Error(`boom ${FAKE_SECRET}`) as Error & { code: string };
        error.code = "TIME_PROVIDER_FAILURE";
        throw error;
      },
    });
    const result = await main(h.deps);
    expect(result.status).toBe("CYCLE_FAULT");
    const record = (await repo.getPublicationWorkerRun(h.cycleId))!;
    expect(record.status).toBe("FAILED");
    // No cycle result existed, so there is no outcome to claim.
    expect(record.outcome).toBeNull();
    expect(record.issueCodes).toEqual(["TIME_PROVIDER_FAILURE"]);
    expect(h.sink.text()).not.toContain(FAKE_SECRET);
  });

  it("does not invoke the cycle when STARTED persistence fails", async () => {
    const h = command({
      workerRuns: {
        async startPublicationWorkerRun() {
          throw new Error("status store unavailable");
        },
        async completePublicationWorkerRun() {
          throw new Error("unreachable");
        },
        async failPublicationWorkerRun() {
          throw new Error("unreachable");
        },
      },
    });
    const result = await main(h.deps);
    expect(result.status).toBe("RUN_STATUS_FAILURE");
    expect(result.exitCode).not.toBe(EXIT_SUCCESS);
    // The whole point: no publication happens without durable evidence.
    expect(h.cycleCalls).toBe(0);
    expect(h.sink.names()).toContain("worker.run_status_persistence_failed");
    expect(h.sink.text()).not.toContain("status store unavailable");
  });

  it("does not rerun the cycle when terminal persistence fails", async () => {
    const started: string[] = [];
    const h = command({
      workerRuns: {
        async startPublicationWorkerRun(input) {
          started.push("start");
          return repo.startPublicationWorkerRun(input);
        },
        async completePublicationWorkerRun() {
          throw new Error("write failed after send");
        },
        async failPublicationWorkerRun() {
          throw new Error("unreachable");
        },
      },
    });
    const result = await main(h.deps);
    // The work already happened; a bookkeeping failure must never resend it.
    expect(h.cycleCalls).toBe(1);
    expect(started).toHaveLength(1);
    expect(result.status).toBe("RUN_STATUS_FAILURE");
    expect(result.exitCode).toBe(EXIT_STATUS_PERSISTENCE_FAILURE);
    expect(result.issues).toContain("RUN_STATUS_PERSISTENCE_FAILURE");
    // The row remains STARTED and can be reconciled to ABANDONED later.
    expect((await repo.getPublicationWorkerRun(h.cycleId))!.status).toBe("STARTED");
    expect(h.sink.text()).not.toContain("write failed after send");
  });

  it("finalises durably even when monitoring output fails", async () => {
    const throwing: MonitoringSink = {
      writeLine() {
        throw new Error("stdout is closed");
      },
    };
    const h = command();
    const result = await main({ ...h.deps, sink: throwing });
    expect(result.exitCode).toBe(EXIT_SUCCESS);
    // Durable status is the audit channel and survives a broken output channel.
    expect((await repo.getPublicationWorkerRun(h.cycleId))!.status).toBe("COMPLETED");
  });

  it("does not rewrite a durable result when cleanup fails", async () => {
    const h = command();
    const result = await main({
      ...h.deps,
      disconnect: async () => {
        throw new Error("disconnect failed");
      },
    });
    expect(result.exitCode).toBe(EXIT_SUCCESS);
    const record = (await repo.getPublicationWorkerRun(h.cycleId))!;
    expect(record.status).toBe("COMPLETED");
    // Cleanup happens after finalisation, so it cannot appear in the durable row.
    expect(record.issueCodes).toEqual([]);
  });

  it("emits exactly one final result line and no database internals", async () => {
    const h = command({ cycle: cycleResult({ issues: ["MONITORING_HOOK_FAILURE"] }) });
    await main(h.deps);
    expect(h.sink.names().filter((n) => n === "worker.result")).toHaveLength(1);
    const text = h.sink.text();
    for (const forbidden of [
      FAKE_SECRET,
      SECRET_VAR,
      "registrar.example",
      "mysql://",
      "DATABASE_URL",
      "Bearer",
      "PublicationWorkerRun",
      "SELECT",
      "UPDATE ",
      "prisma",
      '"id"',
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("persists no JSON-lines output and stores only bounded scalars", async () => {
    const h = command({ cycle: cycleResult({ issues: ["MONITORING_HOOK_FAILURE"] }) });
    await main(h.deps);
    const raw = await db.publicationWorkerRun.findUnique({ where: { cycleId: h.cycleId } });
    const serialised = JSON.stringify(raw, (_k, v) => (typeof v === "bigint" ? Number(v) : v));
    // No monitoring line, no event name, and no JSON structure reached storage.
    for (const forbidden of ["worker.", '{"event"', "stdout", "stderr", "at Object."]) {
      expect(serialised).not.toContain(forbidden);
    }
    expect(raw!.issueCodes).toBe("MONITORING_HOOK_FAILURE");
  });
});
