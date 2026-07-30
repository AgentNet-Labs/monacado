/**
 * Internal publication-worker status application-service tests (Phase 0E.7.4.1).
 *
 * Run ONLY against the disposable local MySQL (RUN_DB_TESTS=1). Self-skips
 * otherwise. Never point at production.
 *
 * NO NETWORK. Authorization and audit are injected fakes; there is no identity
 * provider, session, API key, or shared secret anywhere in this phase. Every
 * instant is explicit.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { PublicationWorkerRunRepository } from "../src/server/product/publication-worker-run-repository";
import {
  getInternalPublicationWorkerStatus,
  type InternalPublicationWorkerStatusDeps,
  type WorkerRunHistoryPort,
} from "../src/server/product/publication-worker-status-service";
import {
  InvalidWorkerStatusRequestError,
  UnsafeWorkerStatusResponseError,
  WorkerStatusAccessDeniedError,
  WorkerStatusQueryFailureError,
} from "../src/server/product/worker-status-errors";
import { InvalidWorkerRunInputError } from "../src/server/product/worker-run-errors";
import {
  InternalPublicationWorkerStatus,
  PUBLICATION_WORKER_STATUS_READ_CAPABILITY,
  WORKER_STATUS_ACTOR_TYPES,
  type PublicationWorkerStatusAuditHook,
  type PublicationWorkerStatusAuthorizer,
  type WorkerStatusAuthorizationDecision,
} from "../src/contracts/product/publication-worker-status";
import type { PublicationWorkerRunRecord } from "../src/contracts/product/publication-worker-run";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = getPrisma();
const repo = new PublicationWorkerRunRepository(db);

const NOW = "2027-01-15T12:00:00.000Z";
const shift = (seconds: number): string =>
  new Date(Date.parse(NOW) + seconds * 1_000).toISOString();

const PREFIX = "istest-";
let seq = 0;
const nextCycleId = (): string => {
  seq += 1;
  return `${PREFIX}${String(seq).padStart(4, "0")}`;
};

/**
 * The status service reads the WHOLE store, so every case starts from an empty
 * table. Operational evidence has no foreign key and is disposable by design.
 */
async function clearRuns(): Promise<void> {
  await db.publicationWorkerRun.deleteMany({});
}

// — Injected authorization and audit —

const allow: PublicationWorkerStatusAuthorizer = {
  authorizePublicationWorkerStatusRead: () => "AUTHORIZED",
};
const deny: PublicationWorkerStatusAuthorizer = {
  authorizePublicationWorkerStatusRead: () => "DENIED",
};

class RecordingAudit implements PublicationWorkerStatusAuditHook {
  events: Array<{ name: string; event: Record<string, unknown> }> = [];
  constructor(private readonly throwOn: string | undefined = undefined) {}
  private hook(name: string) {
    return (event: object) => {
      this.events.push({ name, event: { ...event } as Record<string, unknown> });
      if (this.throwOn === name) throw new Error("audit backend unavailable");
    };
  }
  publicationWorkerStatusReadAuthorized = this.hook("authorized");
  publicationWorkerStatusReadDenied = this.hook("denied");
  publicationWorkerStatusReadCompleted = this.hook("completed");
  publicationWorkerStatusReadFailed = this.hook("failed");
  names(): string[] {
    return this.events.map((e) => e.name);
  }
  text(): string {
    return JSON.stringify(this.events);
  }
}

/** Counts every query, so "denied performs no query" is provable. */
class CountingHistory implements WorkerRunHistoryPort {
  calls = 0;
  constructor(private readonly inner: WorkerRunHistoryPort = repo) {}
  async listRecentPublicationWorkerRuns(input: unknown): Promise<PublicationWorkerRunRecord[]> {
    this.calls += 1;
    return this.inner.listRecentPublicationWorkerRuns(input);
  }
}

// — Requests —

const caller = (overrides: Record<string, unknown> = {}) => ({
  actorId: "ops.alice",
  actorType: "INTERNAL_OPERATOR",
  requestedCapability: PUBLICATION_WORKER_STATUS_READ_CAPABILITY,
  requestId: "req-0001",
  ...overrides,
});

const request = (overrides: Record<string, unknown> = {}) => ({
  caller: caller(),
  assessedAt: NOW,
  freshnessSeconds: 3_600,
  recentRunLimit: 20,
  failureStreakThreshold: 2,
  ...overrides,
});

const deps = (
  overrides: Partial<InternalPublicationWorkerStatusDeps> = {},
): InternalPublicationWorkerStatusDeps => ({
  authorizer: allow,
  db,
  ...overrides,
});

// — Fixtures —

const completionFor = (cycleId: string, overrides: Record<string, unknown> = {}) => ({
  cycleId,
  completedAt: shift(-60),
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

/** One terminal run, started `startedOffset` seconds from NOW. */
async function seedTerminal(
  overrides: Record<string, unknown> = {},
  startedOffset = -300,
): Promise<string> {
  const cycleId = nextCycleId();
  await repo.startPublicationWorkerRun({
    cycleId,
    startedAt: shift(startedOffset),
    maximumRuns: 5,
  });
  await repo.completePublicationWorkerRun(completionFor(cycleId, overrides));
  return cycleId;
}

async function seedStarted(startedOffset = -30): Promise<string> {
  const cycleId = nextCycleId();
  await repo.startPublicationWorkerRun({
    cycleId,
    startedAt: shift(startedOffset),
    maximumRuns: 5,
  });
  return cycleId;
}

describe.skipIf(!RUN)("internal publication worker status service (disposable MySQL)", () => {
  beforeEach(clearRuns);
  afterAll(async () => {
    await clearRuns();
    await disconnectPrisma();
  });

  // — Validation and authorization —

  it("accepts a strict valid request", async () => {
    const status = await getInternalPublicationWorkerStatus(request(), deps());
    expect(status.scope).toBe("PUBLICATION_WORKER_ONLY");
    expect(status.requestId).toBe("req-0001");
    expect(InternalPublicationWorkerStatus.safeParse(status).success).toBe(true);
  });

  it("refuses unknown fields, actor types, capabilities, and bounds", async () => {
    const bad: Array<Record<string, unknown>> = [
      request({ extra: true }),
      { ...request(), caller: caller({ sneak: 1 }) },
      { ...request(), caller: caller({ actorType: "EXTERNAL_USER" }) },
      { ...request(), caller: caller({ actorType: "admin" }) },
      { ...request(), caller: caller({ requestedCapability: "publication-worker:*" }) },
      { ...request(), caller: caller({ requestedCapability: "admin" }) },
      { ...request(), caller: caller({ actorId: "" }) },
      { ...request(), caller: caller({ actorId: "a".repeat(192) }) },
      { ...request(), caller: caller({ requestId: "req with space" }) },
      request({ recentRunLimit: 0 }),
      request({ recentRunLimit: 101 }),
      request({ recentRunLimit: 2.5 }),
      request({ freshnessSeconds: 0 }),
      request({ freshnessSeconds: 604_801 }),
      request({ failureStreakThreshold: 0 }),
      request({ failureStreakThreshold: 11 }),
      request({ backlogPressureThreshold: 1 }),
      request({ backlogPressureThreshold: 11 }),
      request({ assessedAt: "not-a-date" }),
    ];
    for (const input of bad) {
      await expect(getInternalPublicationWorkerStatus(input, deps())).rejects.toThrow(
        InvalidWorkerStatusRequestError,
      );
    }
    // Both bounded actor types are accepted.
    for (const actorType of WORKER_STATUS_ACTOR_TYPES) {
      const status = await getInternalPublicationWorkerStatus(
        { ...request(), caller: caller({ actorType }) },
        deps(),
      );
      expect(status.assessment).toBe("NO_HISTORY");
    }
  });

  it("authorizes before touching the database and denies without querying", async () => {
    await seedTerminal();
    const history = new CountingHistory();
    const audit = new RecordingAudit();

    await expect(
      getInternalPublicationWorkerStatus(request(), deps({ authorizer: deny, history, audit })),
    ).rejects.toThrow(WorkerStatusAccessDeniedError);

    // The whole point: a denied caller costs one authorizer call and zero rows.
    expect(history.calls).toBe(0);
    expect(audit.names()).toEqual(["denied"]);

    // The same request authorized does query.
    const allowed = new CountingHistory();
    await getInternalPublicationWorkerStatus(request(), deps({ history: allowed }));
    expect(allowed.calls).toBe(1);
  });

  it("gives a denied caller one stable code and no disclosure at all", async () => {
    // Whether history exists must not change the denial in any way.
    const withHistory = await getInternalPublicationWorkerStatus(
      request(),
      deps({ authorizer: deny }),
    ).catch((e: unknown) => e);
    await seedTerminal({ outcome: "FAILED", exitCode: 1 });
    const withFailures = await getInternalPublicationWorkerStatus(
      request(),
      deps({ authorizer: deny }),
    ).catch((e: unknown) => e);

    for (const error of [withHistory, withFailures]) {
      expect(error).toBeInstanceOf(WorkerStatusAccessDeniedError);
      const e = error as WorkerStatusAccessDeniedError;
      expect(e.code).toBe("WORKER_STATUS_ACCESS_DENIED");
      const serialised = `${JSON.stringify(e)}|${e.message}|${String(e.stack).slice(0, 200)}`;
      for (const leak of ["ops.alice", "istest-", "FAILED", "NO_HISTORY", "mysql://"]) {
        expect(serialised).not.toContain(leak);
      }
    }
    // Byte-identical messages: the denial cannot be used as an oracle.
    expect((withHistory as Error).message).toBe((withFailures as Error).message);
  });

  it("treats a throwing authorizer as a denial rather than failing open", async () => {
    const history = new CountingHistory();
    const throwing: PublicationWorkerStatusAuthorizer = {
      authorizePublicationWorkerStatusRead: () => {
        throw new Error("identity provider unavailable");
      },
    };
    const audit = new RecordingAudit();
    await expect(
      getInternalPublicationWorkerStatus(request(), deps({ authorizer: throwing, history, audit })),
    ).rejects.toThrow(WorkerStatusAccessDeniedError);
    expect(history.calls).toBe(0);
    expect(audit.text()).not.toContain("identity provider unavailable");
  });

  it("has no permissive default authorizer", async () => {
    // The dependency is required by the type; omitting it at runtime must not
    // silently authorize.
    await expect(
      getInternalPublicationWorkerStatus(request(), {
        db,
      } as unknown as InternalPublicationWorkerStatusDeps),
    ).rejects.toThrow();
    // A non-"AUTHORIZED" value — including an unimplemented stub returning
    // undefined — is a denial, not a truthiness pass.
    for (const value of [undefined, null, "", "ALLOW", true, 1]) {
      await expect(
        getInternalPublicationWorkerStatus(
          request(),
          deps({
            authorizer: {
              authorizePublicationWorkerStatusRead: () =>
                value as unknown as WorkerStatusAuthorizationDecision,
            },
          }),
        ),
      ).rejects.toThrow(WorkerStatusAccessDeniedError);
    }
  });

  // — Status composition —

  it("returns NO_HISTORY with no rows", async () => {
    const status = await getInternalPublicationWorkerStatus(request(), deps());
    expect(status.assessment).toBe("NO_HISTORY");
    expect(status.reasonCodes).toEqual(["NO_TERMINAL_RUNS"]);
    expect(status.recentRuns).toEqual([]);
    expect(status.mostRecentTerminalRunAt).toBeNull();
    expect(status.mostRecentOutcome).toBeNull();
    expect(status.counts).toEqual({
      considered: 0,
      completed: 0,
      failed: 0,
      abandoned: 0,
      withIssues: 0,
      returned: 0,
    });
  });

  it("returns HEALTHY for a recent coherent run", async () => {
    for (const outcome of ["NO_WORK", "COMPLETED", "SHUTDOWN_REQUESTED"] as const) {
      await clearRuns();
      await seedTerminal({ outcome });
      const status = await getInternalPublicationWorkerStatus(request(), deps());
      expect(status.assessment).toBe("HEALTHY");
      expect(status.mostRecentOutcome).toBe(outcome);
      expect(status.mostRecentTerminalRunAt).toBe(shift(-60));
      expect(status.counts.completed).toBe(1);
    }
  });

  it("returns DEGRADED for bounded issue codes", async () => {
    await seedTerminal({ issueCodes: ["MONITORING_HOOK_FAILURE"] });
    const status = await getInternalPublicationWorkerStatus(request(), deps());
    expect(status.assessment).toBe("DEGRADED");
    expect(status.reasonCodes).toContain("LATEST_RUN_HAS_ISSUES");
    expect(status.counts.withIssues).toBe(1);
    expect(status.recentRuns[0]!.issueCodes).toEqual(["MONITORING_HOOK_FAILURE"]);
  });

  it("returns DEGRADED for repeated RUN_LIMIT_REACHED, honouring the threshold", async () => {
    await seedTerminal({ outcome: "RUN_LIMIT_REACHED", completedAt: shift(-120) }, -400);
    await seedTerminal({ outcome: "RUN_LIMIT_REACHED", completedAt: shift(-60) }, -300);
    const status = await getInternalPublicationWorkerStatus(request(), deps());
    expect(status.assessment).toBe("DEGRADED");
    expect(status.reasonCodes).toContain("REPEATED_RUN_LIMIT_REACHED");

    // Raising the threshold to three makes two in a row ordinary again.
    const relaxed = await getInternalPublicationWorkerStatus(
      request({ backlogPressureThreshold: 3 }),
      deps(),
    );
    expect(relaxed.assessment).toBe("HEALTHY");
  });

  it("returns STALE for old coherent history", async () => {
    await seedTerminal({ completedAt: shift(-86_400) }, -87_000);
    const status = await getInternalPublicationWorkerStatus(request(), deps());
    expect(status.assessment).toBe("STALE");
    expect(status.reasonCodes).toEqual(["LATEST_RUN_STALE"]);
  });

  it("returns FAILED for a failed or abandoned latest run", async () => {
    await seedTerminal({ outcome: "FAILED", exitCode: 1 });
    const failed = await getInternalPublicationWorkerStatus(request(), deps());
    expect(failed.assessment).toBe("FAILED");
    expect(failed.reasonCodes).toContain("LATEST_RUN_FAILED");

    await clearRuns();
    await repo.startPublicationWorkerRun({
      cycleId: nextCycleId(),
      startedAt: shift(-7_200),
      maximumRuns: 5,
    });
    await repo.abandonStalePublicationWorkerRuns({
      startedBefore: shift(-1_800),
      abandonedAt: shift(-60),
      limit: 10,
    });
    const abandoned = await getInternalPublicationWorkerStatus(request(), deps());
    expect(abandoned.assessment).toBe("FAILED");
    expect(abandoned.reasonCodes).toContain("LATEST_RUN_ABANDONED");
    expect(abandoned.counts.abandoned).toBe(1);
  });

  it("keeps health precedence delegated and intact", async () => {
    // A failed run that is ALSO stale: FAILED outranks STALE, exactly as the
    // Phase 0E.7.3 policy defines. This service restates none of that.
    await seedTerminal({ outcome: "FAILED", exitCode: 1, completedAt: shift(-86_400) }, -87_000);
    const status = await getInternalPublicationWorkerStatus(request(), deps());
    expect(status.assessment).toBe("FAILED");
  });

  it("lists recent runs newest first and enforces the limit", async () => {
    const a = await seedTerminal({ completedAt: shift(-300) }, -400);
    const b = await seedTerminal({ completedAt: shift(-200) }, -300);
    const c = await seedTerminal({ completedAt: shift(-100) }, -200);

    const all = await getInternalPublicationWorkerStatus(request(), deps());
    expect(all.recentRuns.map((r) => r.cycleId)).toEqual([c, b, a]);
    expect(all.counts.returned).toBe(3);

    const limited = await getInternalPublicationWorkerStatus(
      request({ recentRunLimit: 2 }),
      deps(),
    );
    expect(limited.recentRuns).toHaveLength(2);
    expect(limited.recentRuns.map((r) => r.cycleId)).toEqual([c, b]);
    expect(limited.counts.returned).toBe(2);
  });

  it("lists in-flight runs but excludes them from the assessment", async () => {
    const inFlight = await seedStarted();
    const status = await getInternalPublicationWorkerStatus(request(), deps());
    // Visible to an operator...
    expect(status.recentRuns.map((r) => r.cycleId)).toContain(inFlight);
    expect(status.recentRuns[0]!.status).toBe("STARTED");
    expect(status.recentRuns[0]!.completedAt).toBeNull();
    expect(status.counts.returned).toBe(1);
    // ...but not evidence about health, per the existing terminal-only policy.
    expect(status.assessment).toBe("NO_HISTORY");
    expect(status.counts.considered).toBe(0);
  });

  it("retains the existing future-timestamp failure policy", async () => {
    await seedTerminal({ completedAt: shift(-60) });
    await expect(
      getInternalPublicationWorkerStatus(request({ assessedAt: shift(-3_600) }), deps()),
    ).rejects.toThrow(InvalidWorkerRunInputError);
  });

  // — Data safety —

  it("omits surrogate ids, row timestamps, and every sensitive field", async () => {
    await seedTerminal({ issueCodes: ["MONITORING_HOOK_FAILURE"] });
    await seedStarted();
    const status = await getInternalPublicationWorkerStatus(request(), deps());

    expect(Object.keys(status.recentRuns[0]!).sort()).toEqual([
      "completedAt",
      "cycleId",
      "exitCode",
      "issueCodes",
      "itemsClaimed",
      "maximumRuns",
      "recovery",
      "runsAttempted",
      "shutdownRequested",
      "startedAt",
      "status",
      "stoppedForNoWork",
      "workerOutcome",
    ]);

    const text = JSON.stringify(status);
    for (const forbidden of [
      '"id"',
      "createdAt",
      "updatedAt",
      "payload",
      "receipt",
      "Bearer",
      "authorization",
      "MONACADO_",
      "registrar.example",
      "mysql://",
      "DATABASE_URL",
      "contentHash",
      "payloadHash",
      "claimTokenHash",
      "mon:lock:",
      "prisma",
      "SELECT",
      "at Object.",
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("drops an unexpected field during projection, never returning it", async () => {
    // Two gates guard the response, and this is the first: the projection copies
    // named fields only, so a column added to persistence later cannot ride along.
    const historyWith = (extra: Record<string, unknown>): WorkerRunHistoryPort => ({
      async listRecentPublicationWorkerRuns() {
        return [
          {
            cycleId: "istest-leak",
            status: "COMPLETED",
            outcome: "COMPLETED",
            exitCode: 0,
            maximumRuns: 5,
            runsAttempted: 1,
            itemsClaimed: 1,
            stoppedForNoWork: true,
            shutdownRequested: false,
            expiredClaimsExamined: 0,
            expiredClaimsRecovered: 0,
            expiredClaimsSkipped: 0,
            issueCodes: [],
            startedAt: shift(-120),
            completedAt: shift(-60),
            ...extra,
          } as unknown as PublicationWorkerRunRecord,
        ];
      },
    });

    const status = await getInternalPublicationWorkerStatus(
      request(),
      deps({ history: historyWith({ secretColumn: "Bearer super-secret", id: 42 }) }),
    );
    const text = JSON.stringify(status);
    expect(text).not.toContain("super-secret");
    expect(text).not.toContain("secretColumn");
    expect(Object.keys(status.recentRuns[0]!)).not.toContain("id");
  });

  it("refuses to return a response that fails its own safety contract", async () => {
    // The second gate: a projected VALUE the response contract refuses. The read
    // fails rather than returning data that did not satisfy its own schema.
    const malformed: WorkerRunHistoryPort = {
      async listRecentPublicationWorkerRuns() {
        return [
          {
            cycleId: "istest-bad",
            // Not a member of the closed status vocabulary.
            status: "RUNNING",
            outcome: "COMPLETED",
            exitCode: 999,
            maximumRuns: 5,
            runsAttempted: 1,
            itemsClaimed: 1,
            stoppedForNoWork: true,
            shutdownRequested: false,
            expiredClaimsExamined: 0,
            expiredClaimsRecovered: 0,
            expiredClaimsSkipped: 0,
            issueCodes: [],
            startedAt: shift(-120),
            completedAt: shift(-60),
          } as unknown as PublicationWorkerRunRecord,
        ];
      },
    };
    const audit = new RecordingAudit();
    const error = await getInternalPublicationWorkerStatus(
      request(),
      deps({ history: malformed, audit }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsafeWorkerStatusResponseError);
    expect((error as UnsafeWorkerStatusResponseError).fields.join(" ")).toContain("recentRuns");
    // The offending value is never echoed back.
    expect(JSON.stringify(error)).not.toContain("RUNNING");
    expect(audit.names()).toContain("failed");
  });

  it("wraps a read failure without exposing the database message", async () => {
    const failing: WorkerRunHistoryPort = {
      async listRecentPublicationWorkerRuns() {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3306");
      },
    };
    const audit = new RecordingAudit();
    const error = await getInternalPublicationWorkerStatus(
      request(),
      deps({ history: failing, audit }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkerStatusQueryFailureError);
    expect(JSON.stringify(error)).not.toContain("ECONNREFUSED");
    expect((error as Error).message).not.toContain("ECONNREFUSED");
    expect(audit.text()).not.toContain("ECONNREFUSED");
  });

  // — Audit behaviour —

  it("emits authorized then completed, with safe summary data only", async () => {
    await seedTerminal({ issueCodes: ["CLEANUP_FAILURE"] });
    const audit = new RecordingAudit();
    const status = await getInternalPublicationWorkerStatus(request(), deps({ audit }));

    expect(audit.names()).toEqual(["authorized", "completed"]);
    expect(audit.events[0]!.event).toEqual({
      actorId: "ops.alice",
      actorType: "INTERNAL_OPERATOR",
      requestId: "req-0001",
      capability: PUBLICATION_WORKER_STATUS_READ_CAPABILITY,
      decision: "AUTHORIZED",
    });
    expect(audit.events[1]!.event).toEqual({
      actorId: "ops.alice",
      actorType: "INTERNAL_OPERATOR",
      requestId: "req-0001",
      capability: PUBLICATION_WORKER_STATUS_READ_CAPABILITY,
      assessment: status.assessment,
      recentRunCount: 1,
    });
    // The audit trail never embeds the answer.
    expect(audit.text()).not.toContain("recentRuns");
    expect(audit.text()).not.toContain("istest-");
  });

  it("carries no status data on a denial", async () => {
    await seedTerminal({ outcome: "FAILED", exitCode: 1 });
    const audit = new RecordingAudit();
    await getInternalPublicationWorkerStatus(request(), deps({ authorizer: deny, audit })).catch(
      () => undefined,
    );
    expect(audit.names()).toEqual(["denied"]);
    const event = audit.events[0]!.event;
    expect(Object.keys(event).sort()).toEqual([
      "actorId",
      "actorType",
      "capability",
      "decision",
      "requestId",
    ]);
    expect(audit.text()).not.toContain("FAILED");
  });

  it("swallows an audit failure without denying or altering the read", async () => {
    await seedTerminal();
    for (const failing of ["authorized", "completed"]) {
      const audit = new RecordingAudit(failing);
      const status = await getInternalPublicationWorkerStatus(request(), deps({ audit }));
      // Documented policy: the read succeeds unchanged and later hooks still fire.
      expect(status.assessment).toBe("HEALTHY");
      expect(InternalPublicationWorkerStatus.safeParse(status).success).toBe(true);
      expect(audit.names()).toEqual(["authorized", "completed"]);
    }
  });

  // — Isolation —

  it("performs no write, no worker run, and no stale-run abandonment", async () => {
    const started = await seedStarted(-7_200);
    const terminal = await seedTerminal();
    const before = await db.publicationWorkerRun.findMany({ orderBy: { cycleId: "asc" } });
    const domainBefore = await Promise.all([
      db.productPublication.count(),
      db.publicationOutbox.count(),
      db.publicationSubmissionAttempt.count(),
      db.registrarReceipt.count(),
      db.publicationRemediation.count(),
    ]);

    await getInternalPublicationWorkerStatus(request(), deps());

    const after = await db.publicationWorkerRun.findMany({ orderBy: { cycleId: "asc" } });
    expect(JSON.stringify(after, (_k, v) => (typeof v === "bigint" ? Number(v) : v))).toBe(
      JSON.stringify(before, (_k, v) => (typeof v === "bigint" ? Number(v) : v)),
    );
    // A stale STARTED row is still STARTED: reading status never abandons anything.
    expect((await repo.getPublicationWorkerRun(started))!.status).toBe("STARTED");
    expect((await repo.getPublicationWorkerRun(terminal))!.status).toBe("COMPLETED");
    expect(
      await Promise.all([
        db.productPublication.count(),
        db.publicationOutbox.count(),
        db.publicationSubmissionAttempt.count(),
        db.registrarReceipt.count(),
        db.publicationRemediation.count(),
      ]),
    ).toEqual(domainBefore);
  });
});

// — Structural assertions: no database, no environment, no transport —

describe("internal status service isolation", () => {
  const source = (): string =>
    require("node:fs").readFileSync(
      new URL("../src/server/product/publication-worker-status-service.ts", import.meta.url)
        .pathname,
      "utf8",
    ) as string;

  it("reads no process.env and opens no socket", () => {
    const code = source();
    expect(code).not.toContain("process.env[");
    expect(code).not.toContain("process.env.");
    for (const forbidden of ["fetch(", "http.request", "createServer", "WebSocket"]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("adds no HTTP route, server, scheduler, or alert sender", () => {
    const code = source();
    for (const forbidden of [
      "NextResponse",
      "NextRequest",
      "express(",
      "fastify(",
      "setTimeout(",
      "setInterval(",
      "node-cron",
      "nodemailer",
      "pagerduty",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("never invokes the worker or stale-run abandonment", () => {
    const code = source();
    for (const forbidden of [
      "runProductPublicationWorkerCycle",
      "abandonStalePublicationWorkerRuns",
      "startPublicationWorkerRun",
      "completePublicationWorkerRun",
      "failPublicationWorkerRun",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("is not exported through the browser-facing contracts barrel", () => {
    const barrel = require("node:fs").readFileSync(
      new URL("../src/contracts/index.ts", import.meta.url).pathname,
      "utf8",
    ) as string;
    for (const forbidden of [
      "publication-worker-status",
      "publication-worker-run",
      "worker-status-errors",
    ]) {
      expect(barrel).not.toContain(forbidden);
    }
  });

  it("defines no NEXT_PUBLIC capability or actor value", () => {
    expect(PUBLICATION_WORKER_STATUS_READ_CAPABILITY.startsWith("NEXT_PUBLIC_")).toBe(false);
    for (const actorType of WORKER_STATUS_ACTOR_TYPES) {
      expect(actorType.startsWith("NEXT_PUBLIC_")).toBe(false);
    }
  });

  it("has no side effect on import", async () => {
    // Importing for its exports must not query, authorize, or emit anything.
    const module = await import("../src/server/product/publication-worker-status-service");
    expect(typeof module.getInternalPublicationWorkerStatus).toBe("function");
  });
});
