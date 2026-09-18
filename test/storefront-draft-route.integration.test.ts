/**
 * Phase 1.30 — self-service private draft Storefront, against a real database.
 *
 * Proves the route and `openOwnedDraftStorefront` together: identity and owner
 * come from the session, a DRAFT SELLER or a DRAFT PROMOTER may open one while
 * unverified, the result is DRAFT + PRIVATE with the owner as its single ACTIVE
 * SUPER_OWNER, creation and appointment are one transaction, the included
 * Storefront is free and the next requires an upgrade (also under concurrency),
 * ineligible
 * participants are refused, and nothing past a draft is written. Also proves
 * `readAccountHome` lists the draft without identifiers.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createAccountSession } from "../src/server/account/account-session-service";
import { SESSION_COOKIE_NAME } from "../src/server/account/session-cookie";
import { readAccountHome } from "../src/server/account/account-home";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import { openOwnedDraftStorefront } from "../src/server/marketplace/storefront-service";
import { cryptoStorefrontIdProvider } from "../src/server/marketplace/storefront-ids";
import {
  StorefrontPersistenceFailureError,
  StorefrontUpgradeRequiredError,
} from "../src/server/marketplace/storefront-errors";
import { INCLUDED_STOREFRONT_ALLOWANCE } from "../src/contracts/marketplace/storefront-record";
import {
  STOREFRONT_DRAFT_ROUTE_ERROR_CODES,
  handleOpenDraftStorefrontRequest,
} from "../src/server/marketplace/storefront-draft-route-handler";
import type { MarketplaceRole } from "../src/contracts/marketplace/participant";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-05-01T09:00:00.000Z";
const LATER = "2028-05-02T09:00:00.000Z";
const PASSWORD = "correct horse battery staple";
const EMAIL_PREFIX = "p130store";
const HANDLE_PREFIX = "p130-shop";
const ORIGIN = "https://monacado.test";

let seq = 0;

async function cleanup(): Promise<void> {
  const accounts = await db.account.findMany({
    where: { email: { startsWith: EMAIL_PREFIX } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return;

  const participantIds = (
    await db.marketplaceParticipant.findMany({
      where: { accountId: { in: accountIds } },
      select: { id: true },
    })
  ).map((p) => p.id);
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

/** A real UNVERIFIED account and session, with a DRAFT participant holding `roles` — or none. */
async function signIn(roles: MarketplaceRole[] | null) {
  seq += 1;
  const account = await createAccount(
    {
      name: "Storefront Caller",
      email: `${EMAIL_PREFIX}${seq}@example.com`,
      password: PASSWORD,
      createdAt: NOW,
    },
    { db },
  );
  const participant =
    roles === null
      ? null
      : await createDraftParticipant(
          { accountId: account.accountId, initialRoles: roles, now: NOW },
          { db },
        );
  const { token } = await createAccountSession(
    { accountId: account.accountId, createdAt: NOW, ttlSeconds: 7 * 24 * 3_600 },
    { db },
  );
  return {
    accountId: account.accountId,
    participantId: participant?.participant.participantId ?? null,
    cookieHeader: `${SESSION_COOKIE_NAME}=${token}`,
  };
}

function request(
  cookieHeader: string | null,
  body: unknown,
  overrides: { originHeader?: string | null } = {},
) {
  return handleOpenDraftStorefrontRequest(
    {
      contentType: "application/json",
      originHeader: overrides.originHeader === undefined ? ORIGIN : overrides.originHeader,
      cookieHeader,
      rawBody: typeof body === "string" ? body : JSON.stringify(body),
    },
    { db, now: () => LATER, appOrigin: ORIGIN },
  );
}

const handle = () => `${HANDLE_PREFIX}-${seq}`;

async function storefrontsOwnedBy(participantId: string) {
  return await db.storefront.findMany({ where: { ownerParticipantId: participantId } });
}

const describeDb = RUN ? describe : describe.skip;

describeDb("1.30 — self-service draft Storefront", () => {
  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!RUN) return;
    await cleanup();
    await disconnectPrisma();
  });

  it("opens a DRAFT + PRIVATE Storefront for an unverified DRAFT Seller, owner as sole SUPER_OWNER", async () => {
    const caller = await signIn(["SELLER"]);

    const result = await request(caller.cookieHeader, {
      displayName: "Ada's Workshop",
      publicHandle: handle(),
    });

    expect(result.status).toBe(201);
    expect(result.body).toEqual({
      displayName: "Ada's Workshop",
      publicHandle: handle(),
      lifecycle: "DRAFT",
      visibility: "PRIVATE",
    });
    expect(JSON.stringify(result.body)).not.toMatch(/mon:/);

    const [store, ...others] = await storefrontsOwnedBy(caller.participantId!);
    expect(others).toHaveLength(0);
    expect([store!.lifecycle, store!.visibility, store!.currentSourceRecordVersion]).toEqual([
      "DRAFT",
      "PRIVATE",
      "1",
    ]);
    const versions = await db.storefrontSourceRecordVersionRow.findMany({
      where: { internalStorefrontId: store!.internalStorefrontId },
    });
    expect(versions.map((v) => [v.lifecycle, v.visibility, v.presentationDisplayName, v.authorizedByActorId])).toEqual([
      ["DRAFT", "PRIVATE", "Ada's Workshop", caller.accountId],
    ]);

    const governance = await db.storefrontGovernanceAssignment.findMany({
      where: { internalStorefrontId: store!.internalStorefrontId },
    });
    expect(governance.map((g) => [g.participantId, g.role, g.status, g.activeSuperOwnerForStorefrontId])).toEqual([
      [caller.participantId, "SUPER_OWNER", "ACTIVE", store!.internalStorefrontId],
    ]);

    /* A draft and nothing more: no activation, payment, approval, or verification. */
    const participant = await db.marketplaceParticipant.findUnique({ where: { id: caller.participantId! } });
    expect(participant!.status).toBe("DRAFT");
    expect(await db.participantActivation.count({ where: { participantId: caller.participantId! } })).toBe(0);
    expect(await db.participantPaymentAccount.count({ where: { participantId: caller.participantId! } })).toBe(0);
    expect(await db.participantCommerceApproval.count({ where: { participantId: caller.participantId! } })).toBe(0);
    expect((await db.account.findUnique({ where: { id: caller.accountId } }))!.emailVerifiedAt).toBeNull();
  });

  it("lets a DRAFT Promoter open one too", async () => {
    const caller = await signIn(["PROMOTER"]);

    const result = await request(caller.cookieHeader, { displayName: "Curated", publicHandle: handle() });

    expect(result.status).toBe(201);
    expect(await storefrontsOwnedBy(caller.participantId!)).toHaveLength(1);
  });

  it("refuses an account with no participant, or a participant holding no Storefront-capable role", async () => {
    const bare = await signIn(null);
    expect(await request(bare.cookieHeader, { displayName: "Nope", publicHandle: handle() })).toMatchObject({
      status: 403,
      body: { error: STOREFRONT_DRAFT_ROUTE_ERROR_CODES.notEligible },
    });

    for (const roles of [[], ["BUYER"]] as MarketplaceRole[][]) {
      const caller = await signIn(roles);
      expect((await request(caller.cookieHeader, { displayName: "Nope", publicHandle: handle() })).status).toBe(403);
      expect(await storefrontsOwnedBy(caller.participantId!)).toHaveLength(0);
    }
  });

  it("refuses a participant whose status does not permit drafting", async () => {
    for (const status of ["SUSPENDED", "CLOSED"]) {
      const caller = await signIn(["SELLER"]);
      /* Fixture only: the status a governed suspension or closure would leave. */
      await db.marketplaceParticipant.update({ where: { id: caller.participantId! }, data: { status } });

      expect(await request(caller.cookieHeader, { displayName: "Nope", publicHandle: handle() })).toMatchObject({
        status: 403,
        body: { error: STOREFRONT_DRAFT_ROUTE_ERROR_CODES.notEligible },
      });
      expect(await storefrontsOwnedBy(caller.participantId!)).toHaveLength(0);
    }
  });

  it("refuses bodies outside the strict shape, including any attempt to name an owner or state", async () => {
    const caller = await signIn(["SELLER"]);
    const other = await signIn(["SELLER"]);
    const good = { displayName: "Shop", publicHandle: handle() };
    const bodies: unknown[] = [
      { ...good, ownerParticipantId: other.participantId },
      { ...good, participantId: other.participantId },
      { ...good, actingAccountId: other.accountId },
      { ...good, role: "SUPER_OWNER" },
      { ...good, lifecycle: "ACTIVE" },
      { ...good, visibility: "PUBLIC" },
      { ...good, now: NOW },
      { displayName: "Shop", publicHandle: "Not A Handle" },
      { displayName: "   ", publicHandle: handle() },
      { displayName: "Shop" },
      "not json",
    ];
    for (const body of bodies) {
      expect((await request(caller.cookieHeader, body)).status).toBe(400);
    }
    expect(await storefrontsOwnedBy(caller.participantId!)).toHaveLength(0);
    expect(await storefrontsOwnedBy(other.participantId!)).toHaveLength(0);
  });

  it("refuses the unauthenticated and the cross-origin before any write", async () => {
    const caller = await signIn(["SELLER"]);
    const body = { displayName: "Shop", publicHandle: handle() };

    expect(await request(null, body)).toMatchObject({ status: 401 });
    expect(await request(caller.cookieHeader, body, { originHeader: "https://evil.example" })).toMatchObject({
      status: 403,
      body: { error: STOREFRONT_DRAFT_ROUTE_ERROR_CODES.crossOrigin },
    });
    expect(await storefrontsOwnedBy(caller.participantId!)).toHaveLength(0);
  });

  it("refuses a handle already in use, leaving the first Storefront untouched", async () => {
    const first = await signIn(["SELLER"]);
    const taken = handle();
    expect((await request(first.cookieHeader, { displayName: "First", publicHandle: taken })).status).toBe(201);

    const second = await signIn(["PROMOTER"]);
    expect(await request(second.cookieHeader, { displayName: "Second", publicHandle: taken })).toMatchObject({
      status: 409,
      body: { error: STOREFRONT_DRAFT_ROUTE_ERROR_CODES.handleUnavailable },
    });
    expect(await storefrontsOwnedBy(second.participantId!)).toHaveLength(0);
    expect(await storefrontsOwnedBy(first.participantId!)).toHaveLength(1);
  });

  it("is atomic: a failed SUPER_OWNER appointment leaves no Storefront behind", async () => {
    /* A governance-assignment id that already exists, taken from another
       participant's Storefront. */
    const other = await signIn(["SELLER"]);
    await request(other.cookieHeader, { displayName: "Other", publicHandle: handle() });
    const [existing] = await db.storefrontGovernanceAssignment.findMany({
      where: { participantId: other.participantId! },
    });

    const caller = await signIn(["SELLER"]);
    const collidingIds = {
      ...cryptoStorefrontIdProvider,
      nextGovernanceAssignmentId: () => existing!.id,
    };
    const callerHandle = `${HANDLE_PREFIX}-atomic-${seq}`;
    const open = (ids: typeof cryptoStorefrontIdProvider) =>
      openOwnedDraftStorefront(
        {
          publicHandle: callerHandle,
          presentation: { displayName: "Mine", tagline: null, summary: null },
          actingAccountId: caller.accountId,
          now: LATER,
        },
        { db, ids },
      );

    /* The Storefront and its first version are written, then the appointment
       fails on its own primary key inside the same transaction. */
    await expect(open(collidingIds)).rejects.toBeInstanceOf(StorefrontPersistenceFailureError);
    expect(await db.storefront.count({ where: { publicHandle: callerHandle } })).toBe(0);
    expect(
      await db.storefrontSourceRecordVersionRow.count({ where: { publicHandle: callerHandle } }),
    ).toBe(0);
    expect(await storefrontsOwnedBy(caller.participantId!)).toHaveLength(0);

    /* Control: the identical call with ordinary ids succeeds, so it was the
       appointment that failed and took the Storefront with it. */
    const opened = await open(cryptoStorefrontIdProvider);
    expect(opened.storefront.currentVersion.publicHandle).toBe(callerHandle);
    expect(opened.superOwner.role).toBe("SUPER_OWNER");
    expect(await storefrontsOwnedBy(caller.participantId!)).toHaveLength(1);
  });

  it("includes one Storefront; the next requires an upgrade and writes nothing", async () => {
    /* No Storefront entitlement exists yet, so the allowance is the included one. */
    expect(INCLUDED_STOREFRONT_ALLOWANCE).toBe(1);

    const caller = await signIn(["SELLER", "PROMOTER"]);
    const firstHandle = handle();
    expect((await request(caller.cookieHeader, { displayName: "First", publicHandle: firstHandle })).status).toBe(201);

    const secondHandle = `${HANDLE_PREFIX}-second-${seq}`;
    const refused = await request(caller.cookieHeader, { displayName: "Second", publicHandle: secondHandle });
    expect(refused).toEqual({
      status: 409,
      body: { error: STOREFRONT_DRAFT_ROUTE_ERROR_CODES.upgradeRequired },
      headers: expect.any(Object),
    });

    const owned = await storefrontsOwnedBy(caller.participantId!);
    expect(owned.map((s) => s.publicHandle)).toEqual([firstHandle]);
    expect(
      await db.storefrontSourceRecordVersionRow.count({
        where: { internalStorefrontId: owned[0]!.internalStorefrontId },
      }),
    ).toBe(1);
    expect(
      await db.storefrontGovernanceAssignment.count({
        where: { participantId: caller.participantId!, role: "SUPER_OWNER", status: "ACTIVE" },
      }),
    ).toBe(1);
    /* The second handle was not reserved anywhere. */
    expect(await db.storefront.count({ where: { publicHandle: secondHandle } })).toBe(0);
    expect(
      await db.storefrontSourceRecordVersionRow.count({ where: { publicHandle: secondHandle } }),
    ).toBe(0);

    /* The page offers no second form, and says why. */
    const home = await readAccountHome(caller.accountId, { db });
    expect(home!.canCreateStorefront).toBe(false);
    expect(home!.storefrontUpgradeRequired).toBe(true);

    /* The allowance is per participant: someone else still gets their included one. */
    const independent = await signIn(["PROMOTER"]);
    expect(
      (await request(independent.cookieHeader, { displayName: "Theirs", publicHandle: handle() })).status,
    ).toBe(201);
    expect(await storefrontsOwnedBy(independent.participantId!)).toHaveLength(1);
  });

  it("never lets concurrent requests exceed the allowance", async () => {
    const caller = await signIn(["SELLER"]);
    const open = (suffix: string) =>
      openOwnedDraftStorefront(
        {
          publicHandle: `${HANDLE_PREFIX}-race-${suffix}-${seq}`,
          presentation: { displayName: `Race ${suffix}`, tagline: null, summary: null },
          actingAccountId: caller.accountId,
          now: LATER,
        },
        { db },
      );

    const outcomes = await Promise.allSettled([open("a"), open("b")]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const [rejected] = outcomes.filter((o) => o.status === "rejected") as PromiseRejectedResult[];
    expect(rejected!.reason).toBeInstanceOf(StorefrontUpgradeRequiredError);
    expect(await storefrontsOwnedBy(caller.participantId!)).toHaveLength(1);
    expect(
      await db.storefrontGovernanceAssignment.count({
        where: { participantId: caller.participantId!, role: "SUPER_OWNER", status: "ACTIVE" },
      }),
    ).toBe(1);
  });

  it("lists the draft on the account home without identifiers", async () => {
    const caller = await signIn(["SELLER"]);
    const before = await readAccountHome(caller.accountId, { db });
    expect(before!.storefronts).toEqual([]);
    expect(before!.canCreateStorefront).toBe(true);
    expect(before!.storefrontUpgradeRequired).toBe(false);

    await request(caller.cookieHeader, { displayName: "Ada's Workshop", publicHandle: handle() });

    const after = await readAccountHome(caller.accountId, { db });
    expect(after!.storefronts).toEqual([
      {
        displayName: "Ada's Workshop",
        tagline: null,
        summary: null,
        publicHandle: handle(),
        lifecycle: "DRAFT",
        visibility: "PRIVATE",
        canEditPresentation: true,
      },
    ]);
    expect(JSON.stringify(after)).not.toMatch(/mon:/);

    const bare = await signIn(null);
    expect((await readAccountHome(bare.accountId, { db }))!.canCreateStorefront).toBe(false);
  });
});
