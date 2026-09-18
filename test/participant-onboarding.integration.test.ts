/**
 * Phase 1.29 — self-service Seller/Promoter onboarding, against a real database.
 *
 * Proves the route and the service together: identity comes from the session and
 * nowhere else, the participant and its roles start DRAFT, the one-participant-
 * per-account invariant holds, roles are additive and idempotent, an unverified
 * account may begin, setup closes once the participant leaves drafting, and
 * nothing past setup — activation, profile, readiness — is written. Also proves
 * `readAccountHome` projects exactly the display fields from real rows.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createAccountSession } from "../src/server/account/account-session-service";
import { SESSION_COOKIE_NAME } from "../src/server/account/session-cookie";
import { readAccountHome } from "../src/server/account/account-home";
import {
  ONBOARDING_ROUTE_ERROR_CODES,
  handleBeginOnboardingRequest,
} from "../src/server/marketplace/participant-onboarding-route-handler";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-04-01T09:00:00.000Z";
const LATER = "2028-04-02T09:00:00.000Z";
const PASSWORD = "correct horse battery staple";
const EMAIL_PREFIX = "p129onboard";
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
    await db.marketplaceRoleAssignment.deleteMany({
      where: { participantId: { in: participantIds } },
    });
    await db.marketplaceParticipant.deleteMany({ where: { id: { in: participantIds } } });
  }
  await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

/** A real, UNVERIFIED account (the default) with a real persisted session. */
async function signIn() {
  seq += 1;
  const account = await createAccount(
    {
      name: "Onboarding Caller",
      email: `${EMAIL_PREFIX}${seq}@example.com`,
      password: PASSWORD,
      createdAt: NOW,
    },
    { db },
  );
  const { token } = await createAccountSession(
    { accountId: account.accountId, createdAt: NOW, ttlSeconds: 7 * 24 * 3_600 },
    { db },
  );
  return { accountId: account.accountId, cookieHeader: `${SESSION_COOKIE_NAME}=${token}` };
}

function request(
  cookieHeader: string | null,
  body: unknown,
  overrides: { originHeader?: string | null; contentType?: string | null } = {},
) {
  return handleBeginOnboardingRequest(
    {
      contentType: overrides.contentType === undefined ? "application/json" : overrides.contentType,
      originHeader: overrides.originHeader === undefined ? ORIGIN : overrides.originHeader,
      cookieHeader,
      rawBody: typeof body === "string" ? body : JSON.stringify(body),
    },
    { db, now: () => LATER, appOrigin: ORIGIN },
  );
}

async function participantOf(accountId: string) {
  return await db.marketplaceParticipant.findUnique({
    where: { accountId },
    include: { roles: { orderBy: { role: "asc" } } },
  });
}

const describeDb = RUN ? describe : describe.skip;

describeDb("1.29 — self-service Seller/Promoter onboarding", () => {
  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!RUN) return;
    await cleanup();
    await disconnectPrisma();
  });

  it("lets an unverified account start as a Seller: participant and role both DRAFT, nothing more", async () => {
    const caller = await signIn();
    expect((await db.account.findUnique({ where: { id: caller.accountId } }))!.emailVerifiedAt).toBeNull();

    const result = await request(caller.cookieHeader, { roles: ["SELLER"] });

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "DRAFT", roles: [{ role: "SELLER", status: "DRAFT" }] });
    /* The answer names no identifier of any kind. */
    expect(JSON.stringify(result.body)).not.toMatch(/mon:/);

    const participant = await participantOf(caller.accountId);
    expect(participant!.status).toBe("DRAFT");
    expect(participant!.roles.map((r) => [r.role, r.status, r.activatedAt])).toEqual([
      ["SELLER", "DRAFT", null],
    ]);
    expect(participant!.roles[0]!.grantedAt.toISOString()).toBe(LATER);

    /* Setup only: no activation, no profile, no payment account, no verification. */
    expect(await db.participantActivation.count({ where: { participantId: participant!.id } })).toBe(0);
    expect(await db.participantProfile.count({ where: { participantId: participant!.id } })).toBe(0);
    expect(await db.participantPaymentAccount.count({ where: { participantId: participant!.id } })).toBe(0);
    expect((await db.account.findUnique({ where: { id: caller.accountId } }))!.emailVerifiedAt).toBeNull();
  });

  it("adds Promoter to the same participant, and repeating a request changes nothing", async () => {
    const caller = await signIn();
    await request(caller.cookieHeader, { roles: ["SELLER"] });
    const first = await participantOf(caller.accountId);

    const added = await request(caller.cookieHeader, { roles: ["PROMOTER", "SELLER"] });
    expect(added.status).toBe(200);
    expect(added.body).toEqual({
      status: "DRAFT",
      roles: [
        { role: "PROMOTER", status: "DRAFT" },
        { role: "SELLER", status: "DRAFT" },
      ],
    });

    const again = await request(caller.cookieHeader, { roles: ["SELLER", "PROMOTER"] });
    expect(again.status).toBe(200);

    const after = await participantOf(caller.accountId);
    expect(after!.id).toBe(first!.id);
    expect(await db.marketplaceParticipant.count({ where: { accountId: caller.accountId } })).toBe(1);
    expect(after!.roles.map((r) => r.role)).toEqual(["PROMOTER", "SELLER"]);
    /* The original grant is kept, not rewritten by the repeat. */
    expect(after!.roles.find((r) => r.role === "SELLER")!.id).toBe(first!.roles[0]!.id);
  });

  it("acts only for the session's account; a body naming another account is refused", async () => {
    const caller = await signIn();
    const other = await signIn();

    const refused = await request(caller.cookieHeader, {
      roles: ["SELLER"],
      accountId: other.accountId,
    });
    expect(refused).toMatchObject({ status: 400, body: { error: ONBOARDING_ROUTE_ERROR_CODES.invalidRequest } });
    expect(await participantOf(other.accountId)).toBeNull();
    expect(await participantOf(caller.accountId)).toBeNull();
  });

  it("refuses bodies outside the strict shape, including BUYER and an empty choice", async () => {
    const caller = await signIn();
    const bodies: unknown[] = [
      { roles: [] },
      { roles: ["BUYER"] },
      { roles: ["SELLER"], now: NOW },
      { roles: ["SELLER"], status: "ACTIVE" },
      {},
      "not json",
    ];
    for (const body of bodies) {
      expect((await request(caller.cookieHeader, body)).status).toBe(400);
    }
    expect((await request(caller.cookieHeader, { roles: ["SELLER"] }, { contentType: "text/plain" })).status).toBe(400);
    expect(await participantOf(caller.accountId)).toBeNull();
  });

  it("refuses the unauthenticated and the cross-origin before any write", async () => {
    const caller = await signIn();

    expect(await request(null, { roles: ["SELLER"] })).toMatchObject({
      status: 401,
      body: { error: ONBOARDING_ROUTE_ERROR_CODES.unauthenticated },
    });
    expect(await request(`${SESSION_COOKIE_NAME}=not-a-real-token`, { roles: ["SELLER"] })).toMatchObject({
      status: 401,
    });
    expect(
      await request(caller.cookieHeader, { roles: ["SELLER"] }, { originHeader: "https://evil.example" }),
    ).toMatchObject({ status: 403, body: { error: ONBOARDING_ROUTE_ERROR_CODES.crossOrigin } });
    expect(await participantOf(caller.accountId)).toBeNull();
  });

  it("closes self-service setup once the participant has left drafting", async () => {
    const caller = await signIn();
    await request(caller.cookieHeader, { roles: ["SELLER"] });
    /* Fixture only: put the participant where a governed review would. */
    await db.marketplaceParticipant.update({
      where: { accountId: caller.accountId },
      data: { status: "UNDER_REVIEW" },
    });

    expect(await request(caller.cookieHeader, { roles: ["PROMOTER"] })).toMatchObject({
      status: 409,
      body: { error: ONBOARDING_ROUTE_ERROR_CODES.closed },
    });
    const after = await participantOf(caller.accountId);
    expect(after!.status).toBe("UNDER_REVIEW");
    expect(after!.roles.map((r) => r.role)).toEqual(["SELLER"]);
    /* The page offers nothing it would refuse. */
    const home = await readAccountHome(caller.accountId, { db });
    expect(home!.marketplace!.onboardingOpen).toBe(false);
    expect(home!.setupRolesAvailable).toEqual([]);
  });

  it("projects the account home from real rows without identifiers", async () => {
    const caller = await signIn();

    expect(await readAccountHome(caller.accountId, { db })).toEqual({
      name: "Onboarding Caller",
      email: `${EMAIL_PREFIX}${seq}@example.com`,
      emailVerified: false,
      marketplace: null,
      setupRolesAvailable: ["SELLER", "PROMOTER"],
      storefronts: [],
      canCreateStorefront: false,
      storefrontUpgradeRequired: false,
    });

    await request(caller.cookieHeader, { roles: ["PROMOTER"] });
    const homeAfter = await readAccountHome(caller.accountId, { db });
    expect(homeAfter!.marketplace).toEqual({
      status: "DRAFT",
      roles: [{ role: "PROMOTER", status: "DRAFT" }],
      onboardingOpen: true,
    });
    expect(homeAfter!.setupRolesAvailable).toEqual(["SELLER"]);
    expect(JSON.stringify(homeAfter)).not.toMatch(/mon:|passwordHash|argon2/);

    expect(await readAccountHome("mon:acct:0000000000000000000000NONE", { db })).toBeUndefined();
  });
});
