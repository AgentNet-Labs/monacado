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
 * identifiers, and (Phase 1.33) that the Product library has no count quota —
 * capacity is counted in active Listings per Storefront, not in Products.
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
import { ProductCreatorIdentityUnboundError } from "../src/contracts/product/product-source-record";
import type { MarketplaceRole } from "../src/contracts/marketplace/participant";

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
      /* Phase 1.34 — the stable application reference, returned so the page can
         act on the Product it just drafted. Asserted by SHAPE, because it is
         random by construction and a fixed value would prove it was not. */
      productRef: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{32}$/) as unknown as string,
      name: "Hand-thrown mug",
      description: "Stoneware, 350 ml.",
      promotable: true,
      generalAvailabilityState: "available",
      deliveryMode: "PHYSICAL",
      status: "DRAFT",
    });
    /* It is not an identity, and the un-namespaced body is why: no `mon:` and
       no `an:` can appear here however the answer grows. */
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
    /* Phase 1.34 — persisted, and the SAME value the route answered with. */
    expect(product!.productRef).toBe((result.body as { productRef: string }).productRef);
    expect(product!.productRef).not.toBe(product!.internalProductId);
    expect(product!.productRef).not.toBe(product!.sourceRecordId);
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
        productRef: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{32}$/) as unknown as string,
        name: "Hand-thrown mug",
        description: "Stoneware, 350 ml.",
        promotable: true,
        generalAvailabilityState: "available",
        deliveryMode: "PHYSICAL",
        recordStatus: "draft",
      },
      {
        productRef: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{32}$/) as unknown as string,
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

  it("imposes no Product-count quota: a Seller's sixth and seventh Products succeed (Phase 1.33)", async () => {
    const seller = await signIn(["SELLER"]);
    const statuses: number[] = [];
    for (let i = 1; i <= 7; i += 1) {
      statuses.push((await create(seller.cookieHeader, { ...GOOD, name: `Library product ${i}` })).status);
    }
    /* Products 1, 5, 6, and 7 named explicitly: the old five-Product limit is gone. */
    expect([statuses[0], statuses[4], statuses[5], statuses[6]]).toEqual([201, 201, 201, 201]);
    expect(statuses.every((status) => status === 201)).toBe(true);

    const versions = await versionsBy(seller.participantId!);
    expect(versions).toHaveLength(7);
    const productIds = new Set(versions.map((v) => v.internalProductId));
    expect(productIds.size).toBe(7);
    /* Seven independent Products, each with exactly one version 1 under the
       Seller's authority and no public creator identity. */
    expect(versions.every((v) => v.sourceRecordVersion === "1" && v.recordStatus === "draft")).toBe(true);
    expect(versions.every((v) => v.authorityCreatorId === null && v.factCreatorRef === null && v.factOfferRef === null)).toBe(true);
    const ids = [...productIds];
    expect(await db.product.count({ where: { internalProductId: { in: ids } } })).toBe(7);
    expect(await db.listing.count({ where: { internalProductId: { in: ids } } })).toBe(0);
    expect(await db.offer.count({ where: { internalProductId: { in: ids } } })).toBe(0);
    expect(await db.productNode.count({ where: { internalProductId: { in: ids } } })).toBe(0);
    expect(await db.productPublication.count({ where: { internalProductId: { in: ids } } })).toBe(0);

    /* The account page keeps offering Product creation and lists all seven. */
    const home = await readAccountHome(seller.accountId, { db });
    expect(home!.canCreateProduct).toBe(true);
    expect(home!.products).toHaveLength(7);
    expect(JSON.stringify(home)).not.toMatch(/mon:|an:node/);
  });
});
