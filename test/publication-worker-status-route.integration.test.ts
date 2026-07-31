/**
 * Authenticated internal worker-status route tests (Phase 0E.7.4.2B).
 *
 * Run ONLY against the disposable local MySQL (RUN_DB_TESTS=1). Self-skips
 * otherwise. Never point at production.
 *
 * NO NETWORK and no framework request objects: the handler takes a cookie header
 * and a query string, so every rule is exercised directly. Sessions and
 * entitlements are real rows in the disposable database — the authorization path
 * is the production one, not a fake.
 */

import "dotenv/config";
import { readFileSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount, setAccountStatus } from "../src/server/account/account-service";
import {
  createAccountSession,
  revokeAccountSession,
} from "../src/server/account/account-session-service";
import {
  grantAccountEntitlement,
  revokeAccountEntitlement,
} from "../src/server/account/account-entitlement-service";
import { resolveAuthenticatedPrincipal } from "../src/server/account/account-principal";
import { PublicationWorkerRunRepository } from "../src/server/product/publication-worker-run-repository";
import { buildSessionCookie, SESSION_COOKIE_NAME } from "../src/server/account/session-cookie";
import {
  ROUTE_ERROR_CODES,
  handleWorkerStatusRequest,
  type WorkerStatusRouteAudit,
  type WorkerStatusRouteDeps,
} from "../src/server/operations/worker-status-route-handler";
import {
  WORKER_STATUS_QUERY_DEFAULTS,
  parseWorkerStatusQuery,
} from "../src/server/operations/worker-status-query";
import {
  createPrincipalWorkerStatusAuthorizer,
  mapAccountPrincipalToWorkerStatusCaller,
} from "../src/server/operations/worker-status-caller";
import { REQUEST_ID_RE, cryptoRequestIdProvider } from "../src/server/operations/route-runtime";
import { PUBLICATION_WORKER_STATUS_READ_CAPABILITY } from "../src/contracts/product/publication-worker-status";
import type { AuthenticatedPrincipal } from "../src/contracts/account/account";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = getPrisma();
const runs = new PublicationWorkerRunRepository(db);

const NOW = "2027-05-10T10:00:00.000Z";
const shift = (seconds: number): string =>
  new Date(Date.parse(NOW) + seconds * 1_000).toISOString();

const PASSWORD = "route-synthetic-passphrase-5512";
const CAPABILITY = PUBLICATION_WORKER_STATUS_READ_CAPABILITY;
const REQUEST_ID = "req-0000000000000000000000TEST";

let seq = 0;
const nextEmail = (): string => {
  seq += 1;
  return `route.person${seq}@example.com`;
};

const fixedClock = { now: () => new Date(NOW) };
const fixedRequestIds = { nextRequestId: () => REQUEST_ID };

class RecordingAudit implements WorkerStatusRouteAudit {
  events: Array<{ name: string; event: Record<string, unknown> }> = [];
  constructor(private readonly throwOn: string | undefined = undefined) {}
  private hook(name: string) {
    return (event: object) => {
      this.events.push({ name, event: { ...event } as Record<string, unknown> });
      if (this.throwOn === name) throw new Error("audit backend unavailable");
    };
  }
  workerStatusRouteUnauthenticated = this.hook("unauthenticated");
  workerStatusRouteDenied = this.hook("denied");
  workerStatusRouteCompleted = this.hook("completed");
  workerStatusRouteFailed = this.hook("failed");
  names(): string[] {
    return this.events.map((e) => e.name);
  }
  text(): string {
    return JSON.stringify(this.events);
  }
}

async function cleanup(): Promise<void> {
  await db.accountEntitlement.deleteMany({});
  await db.accountSession.deleteMany({});
  await db.account.deleteMany({});
  await db.publicationWorkerRun.deleteMany({});
}

/** A real account, a real session, and (optionally) a real entitlement. */
async function signIn(options: { entitled: boolean } = { entitled: true }) {
  const account = await createAccount(
    { name: "Route Operator", email: nextEmail(), password: PASSWORD, createdAt: NOW },
    { db },
  );
  if (options.entitled) {
    await grantAccountEntitlement(
      { accountId: account.accountId, capability: CAPABILITY, grantedAt: NOW },
      { db },
    );
  }
  const { token } = await createAccountSession(
    { accountId: account.accountId, createdAt: NOW, ttlSeconds: 3_600 },
    { db },
  );
  return { account, token, cookieHeader: `${SESSION_COOKIE_NAME}=${token}` };
}

async function seedTerminalRun(overrides: Record<string, unknown> = {}, startedOffset = -300) {
  seq += 1;
  const cycleId = `route-${String(seq).padStart(4, "0")}`;
  await runs.startPublicationWorkerRun({
    cycleId,
    startedAt: shift(startedOffset),
    maximumRuns: 5,
  });
  await runs.completePublicationWorkerRun({
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
  return cycleId;
}

const call = (
  cookieHeader: string | null | undefined,
  query = "",
  deps: WorkerStatusRouteDeps = {},
) =>
  handleWorkerStatusRequest(
    { cookieHeader, searchParams: new URLSearchParams(query) },
    { clock: fixedClock, requestIds: fixedRequestIds, db, ...deps },
  );

// — Pure query parsing (no database) —

describe("worker-status query parser", () => {
  const parse = (q: string) => parseWorkerStatusQuery(new URLSearchParams(q));

  it("applies documented defaults to a bare query", () => {
    const result = parse("");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.query).toEqual({
      recentRunLimit: 20,
      freshnessSeconds: 900,
      failureStreakThreshold: 2,
      backlogPressureThreshold: 2,
    });
    expect(result.query).toEqual({ ...WORKER_STATUS_QUERY_DEFAULTS });
  });

  it("accepts explicit values at both bounds", () => {
    const low = parse(
      "recentRunLimit=1&freshnessSeconds=1&failureStreakThreshold=1&backlogPressureThreshold=2",
    );
    expect(low.ok).toBe(true);
    const high = parse(
      "recentRunLimit=100&freshnessSeconds=604800&failureStreakThreshold=10&backlogPressureThreshold=10",
    );
    expect(high.ok).toBe(true);
    if (!high.ok) throw new Error("unreachable");
    expect(high.query.recentRunLimit).toBe(100);
  });

  it("refuses out-of-range values rather than clamping them", () => {
    for (const q of [
      "recentRunLimit=0",
      "recentRunLimit=101",
      "freshnessSeconds=0",
      "freshnessSeconds=604801",
      "failureStreakThreshold=0",
      "failureStreakThreshold=11",
      "backlogPressureThreshold=1",
      "backlogPressureThreshold=11",
    ]) {
      const result = parse(q);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.fields).toHaveLength(1);
    }
  });

  it("refuses every non-strict integer form", () => {
    // `Number()` and `parseInt()` would each accept some of these; a security
    // boundary must not guess what the caller meant.
    for (const value of [
      "",
      " 5",
      "5 ",
      "+5",
      "-5",
      "5.0",
      "1e2",
      "0x10",
      "5abc",
      "abc",
      "Infinity",
      "NaN",
      "٥",
      "9007199254740993",
    ]) {
      const result = parse(`recentRunLimit=${encodeURIComponent(value)}`);
      expect(result.ok).toBe(false);
    }
  });

  it("refuses duplicate and unknown parameters", () => {
    const duplicate = parse("recentRunLimit=5&recentRunLimit=6");
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) throw new Error("unreachable");
    expect(duplicate.fields).toEqual(["recentRunLimit"]);

    for (const q of [
      "assessedAt=2027-01-01T00:00:00.000Z",
      "actorId=mon:acct:x",
      "actorType=INTERNAL_OPERATOR",
      "capability=publication-worker:status:read",
      "orderBy=startedAt",
      "cursor=abc",
      "where=1",
      "limit=5",
      "id=1",
    ]) {
      const result = parse(q);
      expect(result.ok).toBe(false);
    }
  });

  it("reports parameter names only, never their values", () => {
    const result = parse("recentRunLimit=999&secretish=Bearer%20abc");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.fields).toEqual(["recentRunLimit", "secretish"]);
    expect(JSON.stringify(result)).not.toContain("999");
    expect(JSON.stringify(result)).not.toContain("Bearer");
  });
});

// — Pure principal mapping and authorization (no database) —

describe("principal to caller mapping", () => {
  const principal = (overrides: Partial<AuthenticatedPrincipal> = {}): AuthenticatedPrincipal => ({
    actorId: `mon:acct:${"0".repeat(22)}ABCD`,
    actorType: "INTERNAL_OPERATOR",
    accountId: `mon:acct:${"0".repeat(22)}ABCD`,
    sessionId: `mon:asess:${"0".repeat(22)}WXYZ`,
    capabilities: [CAPABILITY],
    ...overrides,
  });

  it("maps an entitled operator onto the exact caller contract", () => {
    const caller = mapAccountPrincipalToWorkerStatusCaller(principal(), REQUEST_ID);
    expect(caller).toEqual({
      actorId: principal().actorId,
      actorType: "INTERNAL_OPERATOR",
      requestedCapability: CAPABILITY,
      requestId: REQUEST_ID,
    });
    // Nothing else crosses the boundary.
    expect(Object.keys(caller!).sort()).toEqual([
      "actorId",
      "actorType",
      "requestId",
      "requestedCapability",
    ]);
  });

  it("fails closed for an ordinary account and for a missing capability", () => {
    expect(
      mapAccountPrincipalToWorkerStatusCaller(
        principal({ actorType: "ACCOUNT", capabilities: [] }),
        REQUEST_ID,
      ),
    ).toBeUndefined();
    // actorType alone is not trusted: the capability list is the underlying fact.
    expect(
      mapAccountPrincipalToWorkerStatusCaller(principal({ capabilities: [] }), REQUEST_ID),
    ).toBeUndefined();
    expect(
      mapAccountPrincipalToWorkerStatusCaller(principal({ actorType: "ACCOUNT" }), REQUEST_ID),
    ).toBeUndefined();
  });

  it("authorizes only a matching entitled principal", () => {
    const caller = mapAccountPrincipalToWorkerStatusCaller(principal(), REQUEST_ID)!;
    expect(
      createPrincipalWorkerStatusAuthorizer(principal()).authorizePublicationWorkerStatusRead(
        caller,
      ),
    ).toBe("AUTHORIZED");

    for (const p of [
      principal({ actorType: "ACCOUNT" }),
      principal({ capabilities: [] }),
      // A caller context that no longer describes the principal it came from.
      principal({ actorId: `mon:acct:${"1".repeat(26)}` }),
    ]) {
      expect(
        createPrincipalWorkerStatusAuthorizer(p).authorizePublicationWorkerStatusRead(caller),
      ).toBe("DENIED");
    }
  });
});

// — Request id —

describe("request id provider", () => {
  it("generates bounded, opaque, unguessable ids", () => {
    const ids = Array.from({ length: 30 }, () => cryptoRequestIdProvider.nextRequestId());
    expect(new Set(ids).size).toBe(30);
    for (const id of ids) {
      expect(REQUEST_ID_RE.test(id)).toBe(true);
      expect(id.length).toBeLessThanOrEqual(64);
      // Encodes nothing: no timestamp, address, endpoint, or account fragment.
      expect(id).not.toMatch(/202[0-9]|@|\/|mon:|session/);
    }
  });
});

// — The route handler, end to end against real rows —

describe.skipIf(!RUN)("internal worker-status route (disposable MySQL)", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("returns 401 with no cookie, an unknown token, or a lookalike cookie", async () => {
    for (const cookieHeader of [
      null,
      undefined,
      "",
      "other=1",
      `${SESSION_COOKIE_NAME}=`,
      `${SESSION_COOKIE_NAME}=not-a-real-token`,
      `x_${SESSION_COOKIE_NAME}=abc`,
    ]) {
      const result = await call(cookieHeader);
      expect(result.status).toBe(401);
      expect(result.body).toEqual({ error: ROUTE_ERROR_CODES.unauthenticated });
      expect(result.headers["cache-control"]).toBe("no-store");
    }
  });

  it("returns 401 for expired, revoked, and disabled-account sessions", async () => {
    const expired = await signIn();
    const late = await call(expired.cookieHeader, "", {
      clock: { now: () => new Date(shift(7_200)) },
    });
    expect(late.status).toBe(401);

    const revoked = await signIn();
    await revokeAccountSession(revoked.token, { revokedAt: shift(10), db });
    expect((await call(revoked.cookieHeader)).status).toBe(401);

    const disabled = await signIn();
    await setAccountStatus(disabled.account.accountId, "DISABLED", { db });
    expect((await call(disabled.cookieHeader)).status).toBe(401);
  });

  it("never parses the query for an unauthenticated caller", async () => {
    // Authentication precedes parsing, so an anonymous caller learns nothing by
    // probing parameters — a bad query still yields 401, not 400.
    const result = await call(null, "recentRunLimit=99999&bogus=1");
    expect(result.status).toBe(401);
  });

  it("returns 403 for an ordinary authenticated account and queries no history", async () => {
    await seedTerminalRun();
    const ordinary = await signIn({ entitled: false });
    let statusCalls = 0;
    const result = await call(ordinary.cookieHeader, "", {
      getStatus: async (...args) => {
        statusCalls += 1;
        const { getInternalPublicationWorkerStatus } = await import(
          "../src/server/product/publication-worker-status-service"
        );
        return getInternalPublicationWorkerStatus(...args);
      },
    });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: ROUTE_ERROR_CODES.denied });
    // The status service is never even reached, so no worker-run query occurs.
    expect(statusCalls).toBe(0);
  });

  it("returns 403 once an entitlement is revoked, on the very next request", async () => {
    await seedTerminalRun();
    const operator = await signIn();
    expect((await call(operator.cookieHeader)).status).toBe(200);

    await revokeAccountEntitlement(
      { accountId: operator.account.accountId, capability: CAPABILITY, revokedAt: shift(10) },
      { db },
    );
    const after = await call(operator.cookieHeader);
    expect(after.status).toBe(403);
    expect(after.body).toEqual({ error: ROUTE_ERROR_CODES.denied });
  });

  it("returns 200 with the service's validated response for an entitled operator", async () => {
    const cycleId = await seedTerminalRun();
    const operator = await signIn();
    const result = await call(operator.cookieHeader);

    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["content-type"]).toContain("application/json");
    const body = result.body as Record<string, unknown>;
    expect(body.scope).toBe("PUBLICATION_WORKER_ONLY");
    expect(body.assessment).toBe("HEALTHY");
    expect(body.requestId).toBe(REQUEST_ID);
    expect((body.recentRuns as Array<{ cycleId: string }>)[0]!.cycleId).toBe(cycleId);
    // assessedAt comes from the server clock, never the caller.
    expect(body.assessedAt).toBe(NOW);
  });

  it("returns 200 for every assessment, including FAILED and NO_HISTORY", async () => {
    const operator = await signIn();

    // NO_HISTORY: an empty store is a status, not an error.
    const empty = await call(operator.cookieHeader);
    expect(empty.status).toBe(200);
    expect((empty.body as { assessment: string }).assessment).toBe("NO_HISTORY");

    // FAILED is operational data — it must not become a 500 or a 503.
    await seedTerminalRun({ outcome: "FAILED", exitCode: 1 });
    const failed = await call(operator.cookieHeader);
    expect(failed.status).toBe(200);
    expect((failed.body as { assessment: string }).assessment).toBe("FAILED");

    await cleanup();
    const reAuth = await signIn();
    await seedTerminalRun({ issueCodes: ["MONITORING_HOOK_FAILURE"] });
    const degraded = await call(reAuth.cookieHeader);
    expect(degraded.status).toBe(200);
    expect((degraded.body as { assessment: string }).assessment).toBe("DEGRADED");

    // A run that finished long before the freshness window is STALE — still 200.
    // The run is aged rather than the clock advanced, so the session stays live:
    // an expired session would be a 401 and would prove nothing about staleness.
    await cleanup();
    const staleAuth = await signIn();
    await seedTerminalRun({ completedAt: shift(-86_400) }, -86_500);
    const stale = await call(staleAuth.cookieHeader);
    expect(stale.status).toBe(200);
    expect((stale.body as { assessment: string }).assessment).toBe("STALE");
  });

  it("honours explicit bounded query parameters", async () => {
    for (let i = 0; i < 3; i += 1) await seedTerminalRun({}, -400 - i * 10);
    const operator = await signIn();

    const limited = await call(operator.cookieHeader, "recentRunLimit=2");
    expect(limited.status).toBe(200);
    expect((limited.body as { recentRuns: unknown[] }).recentRuns).toHaveLength(2);

    // A tight freshness window turns the same data STALE, proving the parameter
    // reaches the assessment rather than being ignored.
    const tight = await call(operator.cookieHeader, "freshnessSeconds=1");
    expect((tight.body as { assessment: string }).assessment).toBe("STALE");
  });

  it("returns 400 for malformed, duplicated, unknown, or out-of-range parameters", async () => {
    const operator = await signIn();
    for (const query of [
      "recentRunLimit=0",
      "recentRunLimit=101",
      "recentRunLimit=abc",
      "recentRunLimit=5.0",
      "recentRunLimit= 5",
      "recentRunLimit=",
      "recentRunLimit=5&recentRunLimit=6",
      "freshnessSeconds=604801",
      "backlogPressureThreshold=1",
      "unknownParam=1",
      "assessedAt=2027-01-01T00:00:00.000Z",
      "orderBy=startedAt",
    ]) {
      const result = await call(operator.cookieHeader, query);
      expect(result.status).toBe(400);
      // One bounded code — never the offending value or a field list.
      expect(result.body).toEqual({ error: ROUTE_ERROR_CODES.invalidQuery });
      expect(JSON.stringify(result.body)).not.toContain("recentRunLimit");
    }
  });

  it("maps an internal failure to a bounded 500 with no raw detail", async () => {
    const operator = await signIn();
    const result = await call(operator.cookieHeader, "", {
      getStatus: async () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:3306");
      },
    });
    expect(result.status).toBe(500);
    expect(result.body).toEqual({ error: ROUTE_ERROR_CODES.unavailable });
    expect(JSON.stringify(result.body)).not.toContain("ECONNREFUSED");
  });

  it("performs no database write", async () => {
    await seedTerminalRun();
    const operator = await signIn();
    const before = {
      runs: await db.publicationWorkerRun.findMany({ orderBy: { cycleId: "asc" } }),
      sessions: await db.accountSession.findMany({ orderBy: { id: "asc" } }),
      entitlements: await db.accountEntitlement.findMany({ orderBy: { id: "asc" } }),
    };

    expect((await call(operator.cookieHeader)).status).toBe(200);

    const serialise = (v: unknown) =>
      JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x));
    expect(serialise(await db.publicationWorkerRun.findMany({ orderBy: { cycleId: "asc" } }))).toBe(
      serialise(before.runs),
    );
    // Read-only session resolution: lastSeenAt is untouched.
    expect(serialise(await db.accountSession.findMany({ orderBy: { id: "asc" } }))).toBe(
      serialise(before.sessions),
    );
    expect(serialise(await db.accountEntitlement.findMany({ orderBy: { id: "asc" } }))).toBe(
      serialise(before.entitlements),
    );
  });

  it("leaks no token, cookie, email, hash, or infrastructure detail in any response", async () => {
    await seedTerminalRun();
    const operator = await signIn();
    const email = (await db.account.findUnique({ where: { id: operator.account.accountId } }))!
      .email;

    const bodies = [
      await call(operator.cookieHeader),
      await call(null),
      await call((await signIn({ entitled: false })).cookieHeader),
      await call(operator.cookieHeader, "recentRunLimit=0"),
    ].map((r) => JSON.stringify(r));

    for (const text of bodies) {
      for (const forbidden of [
        operator.token,
        SESSION_COOKIE_NAME,
        email,
        PASSWORD,
        "$argon2id$",
        "passwordHash",
        "tokenHash",
        "mon:asess:",
        "mysql://",
        "DATABASE_URL",
        "prisma",
        "ECONNREFUSED",
        "at Object.",
        '"id"',
      ]) {
        expect(text).not.toContain(forbidden);
      }
    }
  });

  it("emits safe audit events and survives an audit failure", async () => {
    await seedTerminalRun();
    const operator = await signIn();

    const completed = new RecordingAudit();
    const ok = await call(operator.cookieHeader, "", { audit: completed });
    expect(ok.status).toBe(200);
    expect(completed.names()).toEqual(["completed"]);
    expect(completed.events[0]!.event).toEqual({
      requestId: REQUEST_ID,
      actorId: operator.account.accountId,
      assessment: "HEALTHY",
      recentRunCount: 1,
    });
    // The audit trail never embeds the answer, the token, or the cookie.
    for (const forbidden of [operator.token, "recentRuns", SESSION_COOKIE_NAME, "@example.com"]) {
      expect(completed.text()).not.toContain(forbidden);
    }

    const anon = new RecordingAudit();
    await call(null, "", { audit: anon });
    expect(anon.names()).toEqual(["unauthenticated"]);
    // Nothing about any actor or any status is recorded for an anonymous caller.
    expect(Object.keys(anon.events[0]!.event)).toEqual(["requestId"]);

    const denied = new RecordingAudit();
    const ordinary = await signIn({ entitled: false });
    await call(ordinary.cookieHeader, "", { audit: denied });
    expect(denied.names()).toEqual(["denied"]);
    expect(Object.keys(denied.events[0]!.event).sort()).toEqual(["actorId", "requestId"]);

    const failed = new RecordingAudit();
    await call(operator.cookieHeader, "recentRunLimit=0", { audit: failed });
    expect(failed.names()).toEqual(["failed"]);
    expect(failed.events[0]!.event).toEqual({
      requestId: REQUEST_ID,
      issueCode: ROUTE_ERROR_CODES.invalidQuery,
    });

    // A throwing hook must not change the response.
    const throwing = new RecordingAudit("completed");
    const survived = await call(operator.cookieHeader, "", { audit: throwing });
    expect(survived.status).toBe(200);
    expect((survived.body as { assessment: string }).assessment).toBe("HEALTHY");
  });

  it("uses the real entitlement path, not a bypass", async () => {
    // The principal the route resolves is the same one the identity foundation
    // produces — no shortcut, no injected fake in this assertion.
    const operator = await signIn();
    const principal = await resolveAuthenticatedPrincipal(operator.token, { now: NOW, db });
    expect(principal!.actorType).toBe("INTERNAL_OPERATOR");
    expect(principal!.capabilities).toEqual([CAPABILITY]);
    const cookie = buildSessionCookie(operator.token, { secure: true, maxAgeSeconds: 3_600 });
    expect((await call(cookie)).status).toBe(200);
  });
});

// — Route module structure —

describe("route module structure", () => {
  const routePath = "../app/api/internal/operations/publication-worker/status/route.ts";
  const source = (): string => readFileSync(new URL(routePath, import.meta.url).pathname, "utf8");

  it("exports GET only", () => {
    const code = source();
    expect(code).toMatch(/export async function GET\(/);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"]) {
      expect(code).not.toMatch(new RegExp(`export (async )?function ${method}\\(`));
      expect(code).not.toMatch(new RegExp(`export const ${method}\\b`));
    }
  });

  it("is dynamic, never statically generated", () => {
    const code = source();
    expect(code).toContain('export const dynamic = "force-dynamic"');
    expect(code).toContain("export const revalidate = 0");
  });

  it("emits no CORS header and no client directive", () => {
    const code = source();
    for (const forbidden of [
      "Access-Control-Allow-Origin",
      "Access-Control-Allow-Credentials",
      "Access-Control-Allow-Methods",
      '"use client"',
      "'use client'",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it("stays thin: it decides nothing itself", () => {
    const code = source();
    // Real symbols only — the prose above the code names the concerns it
    // deliberately delegates, and a substring match would trip on that.
    for (const forbidden of [
      "prisma",
      "INTERNAL_OPERATOR",
      "process.env",
      "setTimeout(",
      "resolveAuthenticatedPrincipal",
      "parseWorkerStatusQuery",
      "createPrincipalWorkerStatusAuthorizer",
      "getInternalPublicationWorkerStatus",
    ]) {
      expect(code).not.toContain(forbidden);
    }
    // Exactly one import and one call: the whole file is a translation layer.
    expect(code.match(/^import /gm) ?? []).toHaveLength(1);
    expect(code.match(/handleWorkerStatusRequest\(/g) ?? []).toHaveLength(1);
  });

  it("adds no page, navigation entry, or sitemap", () => {
    const appFiles = readFileSync(new URL("../app/page.tsx", import.meta.url).pathname, "utf8");
    expect(appFiles).not.toContain("publication-worker");
    expect(appFiles).not.toContain("/api/");
    for (const file of ["../app/sitemap.ts", "../app/robots.ts"]) {
      let exists = true;
      try {
        readFileSync(new URL(file, import.meta.url).pathname, "utf8");
      } catch {
        exists = false;
      }
      expect(exists).toBe(false);
    }
  });

  it("keeps the handler free of environment reads, timers, and network calls", () => {
    for (const module of [
      "../src/server/operations/worker-status-route-handler.ts",
      "../src/server/operations/worker-status-query.ts",
      "../src/server/operations/worker-status-caller.ts",
    ]) {
      const code = readFileSync(new URL(module, import.meta.url).pathname, "utf8");
      expect(code).not.toContain("process.env[");
      expect(code).not.toContain("process.env.");
      for (const forbidden of ["fetch(", "createServer", "setTimeout(", "console."]) {
        expect(code).not.toContain(forbidden);
      }
      expect(code).not.toMatch(/^\s*import\s.*from\s+["']next\//m);
    }
  });

  it("never invokes the worker or stale-run abandonment", () => {
    for (const module of [
      "../src/server/operations/worker-status-route-handler.ts",
      "../app/api/internal/operations/publication-worker/status/route.ts",
    ]) {
      const code = readFileSync(new URL(module, import.meta.url).pathname, "utf8");
      for (const forbidden of [
        "runProductPublicationWorkerCycle",
        "abandonStalePublicationWorkerRuns",
        "startPublicationWorkerRun",
      ]) {
        expect(code).not.toContain(forbidden);
      }
    }
  });
});
