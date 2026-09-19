/**
 * Phase 1.32 — SELLER-only private draft Product creation, against a real
 * database.
 *
 * Proves the route and `createDraftProductAs` together: identity and authorship
 * come from the session; a DRAFT or ACTIVE SELLER may draft, unverified; a
 * PROMOTER-only, BUYER-only, role-less, or suspended/closed participant may not;
 * the Product and its version 1 are written with the participant as creator
 * authority and NULL creator columns (ADR §10.3) — nothing fabricated; several
 * Products per SELLER are fine; and no Listing, Offer, Node, publication, or
 * outbox state appears. Also proves `readAccountHome` lists the drafts without
 * identifiers, and that the free-plan allowance (`INCLUDED_PRODUCT_ALLOWANCE`)
 * is enforced inside the write — including under concurrency.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createAccountSession } from "../src/server/account/account-session-service";
import { SESSION_COOKIE_NAME } from "../src/server/account/session-cookie";
import { readAccountHome } from "../src/server/account/account-home";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import {
  PRODUCT_DRAFT_ROUTE_ERROR_CODES as CODES,
  handleCreateDraftProductRequest,
} from "../src/server/product/product-draft-route-handler";
import { ProductRepository } from "../src/server/product/product-repository";
import {
  INCLUDED_PRODUCT_ALLOWANCE,
  ProductCreatorIdentityUnboundError,
} from "../src/contracts/product/product-source-record";
import type { MarketplaceRole } from "../src/contracts/marketplace/participant";
import { createDraftProductAs } from "../src/server/marketplace/marketplace-application-service";
import { resolveActingAccount } from "../src/server/account/acting-participant-boundary";
import { ProductUpgradeRequiredError } from "../src/server/product/errors";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-08-01T09:00:00.000Z";
const LATER = "2028-08-02T09:00:00.000Z";
const EMAIL_PREFIX = "p132product";
const ORIGIN = "https://monacado.test";

let seq = 0;

async function cleanup(): Promise<void> {
  const accountIds = (
    await db.account.findMany({ where: { email: { startsWith: EMAIL_PREFIX } }, select: { id: true } })
  ).map((a) => a.id);
  if (accountIds.length === 0) return;
  const participantIds = (
    await db.marketplaceParticipant.findMany({
      where: { accountId: { in: accountIds } },
      select: { id: true },
    })
  ).map((p) => p.id);
  const productIds = (
    await db.productSourceRecordVersionRow.findMany({
      where: { authorityCreatorParticipantId: { in: participantIds } },
      select: { internalProductId: true },
    })
  ).map((v) => v.internalProductId);
  await db.productSourceRecordVersionRow.deleteMany({ where: { internalProductId: { in: productIds } } });
  await db.product.deleteMany({ where: { internalProductId: { in: productIds } } });
  await db.marketplaceRoleAssignment.deleteMany({ where: { participantId: { in: participantIds } } });
  await db.marketplaceParticipant.deleteMany({ where: { id: { in: participantIds } } });
  await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

/** A real UNVERIFIED account and session, with a DRAFT participant holding `roles` — or none. */
async function signIn(roles: MarketplaceRole[] | null) {
  seq += 1;
  const account = await createAccount(
    { name: "Maker", email: `${EMAIL_PREFIX}${seq}@example.com`, password: "correct horse battery staple", createdAt: NOW },
    { db },
  );
  const participant =
    roles === null
      ? null
      : await createDraftParticipant({ accountId: account.accountId, initialRoles: roles, now: NOW }, { db });
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

const GOOD = {
  name: "Hand-thrown mug",
  description: "Stoneware, 350 ml.",
  promotable: true,
  generalAvailabilityState: "available",
  deliveryMode: "PHYSICAL",
};

function create(cookieHeader: string | null, body: unknown, overrides: { originHeader?: string | null } = {}) {
  return handleCreateDraftProductRequest(
    {
      contentType: "application/json",
      originHeader: overrides.originHeader === undefined ? ORIGIN : overrides.originHeader,
      cookieHeader,
      rawBody: typeof body === "string" ? body : JSON.stringify(body),
    },
    { db, now: () => LATER, appOrigin: ORIGIN },
  );
}

const versionsBy = (participantId: string) =>
  db.productSourceRecordVersionRow.findMany({ where: { authorityCreatorParticipantId: participantId } });

const describeDb = RUN ? describe : describe.skip;

describeDb("1.32 — SELLER-only private draft Product", () => {
  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!RUN) return;
    await cleanup();
    await disconnectPrisma();
  });

  it("lets an unverified DRAFT Seller draft a Product: one record, one version 1, participant authority, creator unbound", async () => {
    const seller = await signIn(["SELLER"]);

    const result = await create(seller.cookieHeader, GOOD);

    expect(result.status).toBe(201);
    expect(result.body).toEqual({
      name: "Hand-thrown mug",
      description: "Stoneware, 350 ml.",
      promotable: true,
      generalAvailabilityState: "available",
      deliveryMode: "PHYSICAL",
      status: "DRAFT",
    });
    expect(JSON.stringify(result.body)).not.toMatch(/mon:|an:/);

    const [version, ...more] = await versionsBy(seller.participantId!);
    expect(more).toHaveLength(0);
    expect({
      sourceRecordVersion: version!.sourceRecordVersion,
      recordStatus: version!.recordStatus,
      authorityScope: version!.authorityScope,
      authorityAuthorizationState: version!.authorityAuthorizationState,
      authorityCreatorParticipantId: version!.authorityCreatorParticipantId,
      authorityCreatorId: version!.authorityCreatorId,
      factCreatorRef: version!.factCreatorRef,
      factOfferRef: version!.factOfferRef,
      factName: version!.factName,
      factProductVersion: version!.factProductVersion,
      factDeliveryMode: version!.factDeliveryMode,
      capsuleSemver: version!.capsuleSemver,
      mappingVersion: version!.mappingVersion,
    }).toEqual({
      sourceRecordVersion: "1",
      recordStatus: "draft",
      authorityScope: "product-facts",
      authorityAuthorizationState: "authorized",
      authorityCreatorParticipantId: seller.participantId,
      authorityCreatorId: null,
      factCreatorRef: null,
      factOfferRef: null,
      factName: "Hand-thrown mug",
      factProductVersion: 1,
      factDeliveryMode: "PHYSICAL",
      capsuleSemver: "1.0.0",
      mappingVersion: "0b1.0.0",
    });

    const product = await db.product.findUnique({ where: { internalProductId: version!.internalProductId } });
    expect([product!.currentSourceRecordVersion, product!.recordStatus]).toEqual(["1", "draft"]);
    const internalProductId = version!.internalProductId;

    /* A draft and nothing more. */
    expect(await db.listing.count({ where: { internalProductId } })).toBe(0);
    expect(await db.offer.count({ where: { internalProductId } })).toBe(0);
    expect(await db.productNode.count({ where: { internalProductId } })).toBe(0);
    expect(await db.productPublication.count({ where: { internalProductId } })).toBe(0);
    expect((await db.account.findUnique({ where: { id: seller.accountId } }))!.emailVerifiedAt).toBeNull();

    /* And it cannot become a capsule until a real creator identity is bound. */
    await expect(
      new ProductRepository(db).generateCandidateFromPersistedProductVersion(version!.sourceRecordId, "1"),
    ).rejects.toBeInstanceOf(ProductCreatorIdentityUnboundError);
  });

  it("lets an ACTIVE Seller draft too", async () => {
    const seller = await signIn(["SELLER"]);
    /* Fixture only: the statuses a governed activation would leave. */
    await db.marketplaceParticipant.update({ where: { id: seller.participantId! }, data: { status: "ACTIVE" } });
    await db.marketplaceRoleAssignment.updateMany({
      where: { participantId: seller.participantId! },
      data: { status: "ACTIVE", activatedAt: new Date(NOW) },
    });

    expect((await create(seller.cookieHeader, GOOD)).status).toBe(201);
    expect(await versionsBy(seller.participantId!)).toHaveLength(1);
  });

  it("refuses a Promoter-only, Buyer-only, role-less, or participant-less account, writing nothing", async () => {
    for (const roles of [["PROMOTER"], ["BUYER"], [], null] as Array<MarketplaceRole[] | null>) {
      const caller = await signIn(roles);
      expect(await create(caller.cookieHeader, GOOD)).toMatchObject({
        status: 403,
        body: { error: CODES.notEligible },
      });
      if (caller.participantId !== null) expect(await versionsBy(caller.participantId)).toHaveLength(0);
    }
  });

  it("refuses a Seller whose participant status does not permit drafting", async () => {
    for (const status of ["SUSPENDED", "CLOSED"]) {
      const seller = await signIn(["SELLER"]);
      /* Fixture only: the status a governed suspension or closure would leave. */
      await db.marketplaceParticipant.update({ where: { id: seller.participantId! }, data: { status } });

      expect(await create(seller.cookieHeader, GOOD)).toMatchObject({ status: 403, body: { error: CODES.notEligible } });
      expect(await versionsBy(seller.participantId!)).toHaveLength(0);
    }
  });

  it("refuses bodies outside the strict shape, including identities, status, and commercial terms", async () => {
    const seller = await signIn(["SELLER"]);
    const other = await signIn(["SELLER"]);
    const bodies: unknown[] = [
      { ...GOOD, creatorParticipantId: other.participantId },
      { ...GOOD, accountId: other.accountId },
      { ...GOOD, relationships: { creator: "an:node:01ARZ3NDEKTSV4RRFFQ69G5FAV" } },
      { ...GOOD, creatorId: "mon:creator:01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      { ...GOOD, recordStatus: "authoring-complete" },
      { ...GOOD, price: 12 },
      { ...GOOD, storefront: "p130-shop" },
      { ...GOOD, name: "   " },
      { ...GOOD, name: "x".repeat(201) },
      { ...GOOD, deliveryMode: "SERVICE" },
      { ...GOOD, generalAvailabilityState: "live" },
      { name: "Missing the rest" },
      "not json",
    ];
    for (const body of bodies) {
      expect((await create(seller.cookieHeader, body)).status).toBe(400);
    }
    expect(await versionsBy(seller.participantId!)).toHaveLength(0);
    expect(await versionsBy(other.participantId!)).toHaveLength(0);
  });

  it("refuses the unauthenticated and the cross-origin before any write", async () => {
    const seller = await signIn(["SELLER"]);
    expect(await create(null, GOOD)).toMatchObject({ status: 401 });
    expect(await create(seller.cookieHeader, GOOD, { originHeader: "https://evil.example" })).toMatchObject({
      status: 403,
      body: { error: CODES.crossOrigin },
    });
    expect(await versionsBy(seller.participantId!)).toHaveLength(0);
  });

  it("lets one Seller draft several distinct Products, and lists them on the account home without identifiers", async () => {
    const seller = await signIn(["SELLER", "PROMOTER"]);
    expect((await create(seller.cookieHeader, GOOD)).status).toBe(201);
    expect(
      (
        await create(seller.cookieHeader, {
          name: "E-book",
          description: null,
          promotable: false,
          generalAvailabilityState: "pre-release",
          deliveryMode: "DIGITAL",
        })
      ).status,
    ).toBe(201);

    const versions = await versionsBy(seller.participantId!);
    expect(versions).toHaveLength(2);
    expect(new Set(versions.map((v) => v.internalProductId)).size).toBe(2);

    const home = await readAccountHome(seller.accountId, { db });
    expect(home!.canCreateProduct).toBe(true);
    expect(home!.products).toEqual([
      {
        name: "Hand-thrown mug",
        description: "Stoneware, 350 ml.",
        promotable: true,
        generalAvailabilityState: "available",
        deliveryMode: "PHYSICAL",
        recordStatus: "draft",
      },
      {
        name: "E-book",
        description: null,
        promotable: false,
        generalAvailabilityState: "pre-release",
        deliveryMode: "DIGITAL",
        recordStatus: "draft",
      },
    ]);
    expect(JSON.stringify(home)).not.toMatch(/mon:|an:node/);

    const promoter = await signIn(["PROMOTER"]);
    const promoterHome = await readAccountHome(promoter.accountId, { db });
    expect(promoterHome!.canCreateProduct).toBe(false);
    expect(promoterHome!.products).toEqual([]);
  });

  it("includes the free-plan allowance of Products; the next requires an upgrade and writes nothing", async () => {
    expect(INCLUDED_PRODUCT_ALLOWANCE).toBe(5);
    const seller = await signIn(["SELLER"]);

    for (let i = 1; i <= INCLUDED_PRODUCT_ALLOWANCE; i += 1) {
      expect((await create(seller.cookieHeader, { ...GOOD, name: `Product ${i}` })).status).toBe(201);
    }
    const home = await readAccountHome(seller.accountId, { db });
    expect(home!.products).toHaveLength(INCLUDED_PRODUCT_ALLOWANCE);
    expect(home!.canCreateProduct).toBe(false);
    expect(home!.productUpgradeRequired).toBe(true);

    const refused = await create(seller.cookieHeader, { ...GOOD, name: "One too many" });
    expect(refused).toEqual({
      status: 409,
      body: { error: CODES.upgradeRequired },
      headers: expect.any(Object),
    });
    expect(JSON.stringify(refused.body)).not.toMatch(/mon:|\d/);

    const versions = await versionsBy(seller.participantId!);
    expect(versions).toHaveLength(INCLUDED_PRODUCT_ALLOWANCE);
    expect(versions.some((v) => v.factName === "One too many")).toBe(false);
    expect(await db.product.count({ where: { internalProductId: { in: versions.map((v) => v.internalProductId) } } })).toBe(
      INCLUDED_PRODUCT_ALLOWANCE,
    );

    /* The allowance is per Seller: another still gets their own. */
    const other = await signIn(["SELLER"]);
    expect((await create(other.cookieHeader, GOOD)).status).toBe(201);
    const otherHome = await readAccountHome(other.accountId, { db });
    expect([otherHome!.canCreateProduct, otherHome!.productUpgradeRequired]).toEqual([true, false]);
  });

  it("never lets concurrent requests take a Seller past the allowance", async () => {
    const seller = await signIn(["SELLER"]);
    for (let i = 1; i < INCLUDED_PRODUCT_ALLOWANCE; i += 1) {
      expect((await create(seller.cookieHeader, { ...GOOD, name: `Product ${i}` })).status).toBe(201);
    }

    const resolution = await resolveActingAccount({ cookieHeader: seller.cookieHeader, now: LATER }, { db });
    if (resolution.outcome !== "AUTHENTICATED") throw new Error("unreachable");
    const outcomes = await Promise.allSettled(
      ["Race A", "Race B"].map((name) =>
        createDraftProductAs(resolution.actor, { ...GOOD, name }, { db, now: LATER }),
      ),
    );

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const [rejected] = outcomes.filter((o) => o.status === "rejected") as PromiseRejectedResult[];
    expect(rejected!.reason).toBeInstanceOf(ProductUpgradeRequiredError);
    expect(await versionsBy(seller.participantId!)).toHaveLength(INCLUDED_PRODUCT_ALLOWANCE);
  });
});
