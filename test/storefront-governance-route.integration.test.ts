/**
 * Phase 1.21 — the Storefront governance route.
 *
 * Four guarantees, and only four. The route makes no authorization decision, so
 * this suite deliberately does not re-prove one.
 *
 * The governance authority matrix — SUPER_OWNER exclusivity, DISABLED accounts,
 * strangers, revoke-then-appoint seizure, the suspended/CLOSED standing table,
 * and the exposure-direction asymmetry — is asserted in
 * `storefront-persistence.integration.test.ts`, and the actor-provenance
 * guarantee in `application-authority-boundary.integration.test.ts`. Running any
 * of it again through a thicker pipe would prove nothing new about the pipe.
 *
 * What is new is the pipe itself: that an anonymous caller is refused before the
 * body is read, that the HTTP edge refuses an authority-shaped key rather than
 * discarding it, that the instant on a governance record is the server's, that a
 * governed refusal arrives bounded and leaks nothing, and that the route reaches
 * the trusted application command rather than the domain service beneath it.
 *
 * NO NETWORK and no framework request objects: the handler takes a cookie
 * header, a content type, an origin, and a raw body, so every rule is exercised
 * directly — the same shape `publication-worker-status-route` uses.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createAccountSession } from "../src/server/account/account-session-service";
import { SESSION_COOKIE_NAME } from "../src/server/account/session-cookie";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import {
  assignStorefrontGovernance,
  createDraftStorefront,
  listGovernanceAssignments,
} from "../src/server/marketplace/storefront-service";
import {
  GOVERNANCE_ROUTE_ERROR_CODES,
  NEVER_ON_GOVERNANCE_REQUEST,
  handleAppointGovernanceRequest,
  handleSetGovernanceStatusRequest,
} from "../src/server/marketplace/storefront-governance-route-handler";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-03-01T09:00:00.000Z";
const LATER = "2028-03-02T09:00:00.000Z";
const PASSWORD = "correct horse battery staple";
const EMAIL_PREFIX = "p121govroute";
const ORIGIN = "https://monacado.test";

let seq = 0;

async function cleanup(): Promise<void> {
  const accounts = await db.account.findMany({
    where: { email: { startsWith: EMAIL_PREFIX } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return;

  const participants = await db.marketplaceParticipant.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const participantIds = participants.map((p) => p.id);
  if (participantIds.length > 0) {
    await db.storefrontGovernanceAssignment.deleteMany({
      where: { participantId: { in: participantIds } },
    });
    await db.storefrontSourceRecordVersionRow.deleteMany({
      where: { ownerParticipantId: { in: participantIds } },
    });
    await db.storefront.deleteMany({ where: { ownerParticipantId: { in: participantIds } } });
    await db.marketplaceRoleAssignment.deleteMany({
      where: { participantId: { in: participantIds } },
    });
    await db.marketplaceParticipant.deleteMany({ where: { id: { in: participantIds } } });
  }
  await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

/** A real account, a real participant, and a real persisted session. */
async function signIn() {
  seq += 1;
  const account = await createAccount(
    {
      name: "Governance Caller",
      email: `${EMAIL_PREFIX}${seq}@example.com`,
      password: PASSWORD,
      createdAt: NOW,
    },
    { db },
  );
  const participant = await createDraftParticipant(
    { accountId: account.accountId, initialRoles: ["SELLER"], now: NOW },
    { db },
  );
  const { token } = await createAccountSession(
    /* Long enough to still be live at LATER, which is the instant every request
       below is driven at. */
    { accountId: account.accountId, createdAt: NOW, ttlSeconds: 7 * 24 * 3_600 },
    { db },
  );
  return {
    accountId: account.accountId,
    participantId: participant.participant.participantId,
    cookieHeader: `${SESSION_COOKIE_NAME}=${token}`,
  };
}

/** An owner with a Storefront and the bootstrap SUPER_OWNER seat taken. */
async function seedGovernedStorefront() {
  const owner = await signIn();
  seq += 1;
  const snapshot = await createDraftStorefront(
    {
      ownerParticipantId: owner.participantId,
      publicHandle: `p121-shop-${seq}`,
      presentation: { displayName: "Route Shop", tagline: null, summary: null },
      actingAccountId: owner.accountId,
      now: NOW,
    },
    { db },
  );
  const internalStorefrontId = snapshot.record.internalStorefrontId;
  await assignStorefrontGovernance(
    {
      internalStorefrontId,
      participantId: owner.participantId,
      role: "SUPER_OWNER",
      actingAccountId: owner.accountId,
      now: NOW,
    },
    { db },
  );
  return { owner, internalStorefrontId };
}

const post = (
  cookieHeader: string | null,
  body: unknown,
  overrides: { contentType?: string | null; origin?: string | null; now?: string } = {},
) => ({
  request: {
    contentType: overrides.contentType === undefined ? "application/json" : overrides.contentType,
    originHeader: overrides.origin === undefined ? ORIGIN : overrides.origin,
    cookieHeader,
    rawBody: typeof body === "string" ? body : JSON.stringify(body),
  },
  deps: { db, appOrigin: ORIGIN, now: () => overrides.now ?? LATER },
});

const describeDb = RUN ? describe : describe.skip;

describeDb("1.21 — Storefront governance over HTTP", () => {
  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("refuses an anonymous caller before it reads the body", async () => {
    /* Ordering matters as much as the refusal. A route that parsed first would
       answer 400 for a malformed body and 401 for a well-formed one, turning an
       endpoint nobody may use into an oracle for which payloads are valid. So
       the malformed body below must still come back 401. */
    const garbage = post(null, "{ not json", { contentType: "application/json" });
    const anonymous = await handleAppointGovernanceRequest(garbage.request, garbage.deps);
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toEqual({ error: GOVERNANCE_ROUTE_ERROR_CODES.unauthenticated });
    expect(anonymous.headers["cache-control"]).toBe("no-store");

    /* A cookie that is not a session, and an empty one, answer identically —
       the boundary already collapses every not-signed-in condition to one
       outcome, and the route must not widen it back out. */
    for (const cookie of ["", "other=1", `${SESSION_COOKIE_NAME}=not-a-real-token`]) {
      const { request, deps } = post(cookie, { internalStorefrontId: "x" });
      expect((await handleAppointGovernanceRequest(request, deps)).status).toBe(401);
    }
  });

  it("appoints for an authorized owner, stamping the server's instant", async () => {
    const { owner, internalStorefrontId } = await seedGovernedStorefront();
    const admin = await signIn();

    const { request, deps } = post(owner.cookieHeader, {
      internalStorefrontId,
      participantId: admin.participantId,
      role: "ADMIN",
    });
    const result = await handleAppointGovernanceRequest(request, deps);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      internalStorefrontId,
      participantId: admin.participantId,
      role: "ADMIN",
      status: "ACTIVE",
      /* The route's clock, not the caller's — the caller sent no instant and
         has no field through which to send one. */
      assignedAt: LATER,
      revokedAt: null,
    });
    /* The internal row identity is not handed out: no input consumes it. */
    expect(result.body).not.toHaveProperty("governanceAssignmentId");

    const assignments = await listGovernanceAssignments(internalStorefrontId, { db });
    expect(assignments.find((a) => a.participantId === admin.participantId)?.role).toBe("ADMIN");
  });

  it("refuses an authority-shaped key rather than discarding it", async () => {
    /* `withActor` overwrites `actingAccountId`, so forwarding one would be
       harmless — but it does NOT strip `now`, and a caller who could set that
       would choose the instant their own appointment is recorded at. The HTTP
       edge refuses both, and every other authority-shaped name, because the
       schema is strict rather than because a helper cleans up afterwards. */
    const { owner, internalStorefrontId } = await seedGovernedStorefront();
    const victim = await signIn();
    const valid = {
      internalStorefrontId,
      participantId: victim.participantId,
      role: "ADMIN" as const,
    };

    for (const forbidden of NEVER_ON_GOVERNANCE_REQUEST) {
      const { request, deps } = post(owner.cookieHeader, {
        ...valid,
        [forbidden]: forbidden === "now" ? "2020-01-01T00:00:00.000Z" : victim.accountId,
      });
      const result = await handleAppointGovernanceRequest(request, deps);
      expect(`${forbidden}:${result.status}`).toBe(`${forbidden}:400`);
      expect(result.body).toEqual({ error: GOVERNANCE_ROUTE_ERROR_CODES.invalidRequest });
    }

    /* Nothing was written on the way to any of those refusals. */
    expect(await listGovernanceAssignments(internalStorefrontId, { db })).toHaveLength(1);
  });

  it("answers a stranger with a bounded refusal that names nothing", async () => {
    /* One governed-refusal case, chosen for its mapping and leak value rather
       than its authority value — the authority rule itself is proven in the
       Storefront suite. A stranger appointing themselves is the shape that
       matters: the refusal must not disclose that the Storefront exists, who
       governs it, or which gate refused. */
    const { internalStorefrontId } = await seedGovernedStorefront();
    const stranger = await signIn();

    const { request, deps } = post(stranger.cookieHeader, {
      internalStorefrontId,
      participantId: stranger.participantId,
      role: "SUPER_OWNER",
    });
    const result = await handleAppointGovernanceRequest(request, deps);

    expect(result.status).toBe(404);
    expect(result.body).toEqual({ error: GOVERNANCE_ROUTE_ERROR_CODES.notFound });

    const serialized = JSON.stringify(result);
    for (const leak of [
      "SUPER_OWNER_REQUIRED",
      "ACCOUNT_DISABLED",
      "storefront:governance",
      "reasonCodes",
      "capability",
      stranger.accountId,
    ]) {
      expect(`${leak}:${serialized.includes(leak)}`).toBe(`${leak}:false`);
    }

    /* And an unknown Storefront is indistinguishable from the above — which is
       what stops the route being an existence oracle. */
    const unknown = post(stranger.cookieHeader, {
      internalStorefrontId: `mon:storefront:${"Z".repeat(26)}`,
      participantId: stranger.participantId,
      role: "ADMIN",
    });
    const missing = await handleAppointGovernanceRequest(unknown.request, unknown.deps);
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(result.body);

    expect(await listGovernanceAssignments(internalStorefrontId, { db })).toHaveLength(1);
  });

  it("withdraws an assignment through the status route, and refuses a stranger there too", async () => {
    const { owner, internalStorefrontId } = await seedGovernedStorefront();
    const admin = await signIn();
    const appoint = post(owner.cookieHeader, {
      internalStorefrontId,
      participantId: admin.participantId,
      role: "ADMIN",
    });
    await handleAppointGovernanceRequest(appoint.request, appoint.deps);

    /* The status endpoint refuses a `role`, and the appoint endpoint refuses a
       `status` — two doors, not one door with a caller-selected branch. */
    const wrongShape = post(owner.cookieHeader, {
      internalStorefrontId,
      participantId: admin.participantId,
      role: "ADMIN",
    });
    expect((await handleSetGovernanceStatusRequest(wrongShape.request, wrongShape.deps)).status).toBe(
      400,
    );

    const stranger = await signIn();
    const byStranger = post(stranger.cookieHeader, {
      internalStorefrontId,
      participantId: admin.participantId,
      status: "REVOKED",
    });
    expect((await handleSetGovernanceStatusRequest(byStranger.request, byStranger.deps)).status).toBe(
      404,
    );

    const byOwner = post(owner.cookieHeader, {
      internalStorefrontId,
      participantId: admin.participantId,
      status: "REVOKED",
    });
    const revoked = await handleSetGovernanceStatusRequest(byOwner.request, byOwner.deps);
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ status: "REVOKED", revokedAt: LATER });

    const assignments = await listGovernanceAssignments(internalStorefrontId, { db });
    expect(assignments.find((a) => a.participantId === admin.participantId)?.status).toBe("REVOKED");
  });
});
