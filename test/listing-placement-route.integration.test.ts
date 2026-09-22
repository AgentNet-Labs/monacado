/**
 * Phase 1.34 — seller-direct private DRAFT Listing self-service, end to end.
 *
 * `POST /api/listings` is the first route through which a person can place a
 * Product in a Storefront. What it creates is **placement and nothing else**:
 * which Product appears in which shop, as a DRAFT, SELLER_DIRECT, unpriced
 * Listing. No price, no Offer, no commission, no activation, no Node, no
 * publication.
 *
 * The four things worth proving, in order of how badly each would fail:
 *
 *   1. **Two selectors is the whole request.** `productRef` and
 *      `storefrontHandle`. Every internal identity — the Product id, the source
 *      record, the participant, the Storefront id, a Listing id, a version, a
 *      lifecycle, a price, an Offer — is refused by the strict body rather than
 *      ignored, and identity comes from the session.
 *   2. **A refusal tells a stranger nothing.** An unknown reference, another
 *      Seller's Product, and a Storefront the caller does not control are ONE
 *      answer. Distinguishing them would make this route an oracle for what
 *      exists in somebody else's private drafts.
 *   3. **The placement invariant holds through the route**, with the same
 *      bounded `LISTING_ALREADY_EXISTS` the prerequisite established — and the
 *      other three placement shapes (same Product elsewhere, another Product
 *      here, many drafts in one shop) all still work.
 *   4. **Nothing else moved.** The Product, its `promotable` fact, its version
 *      pointer, and the Storefront are byte-identical afterwards.
 *
 * Concurrency is NOT re-proved here: the composite unique index and its
 * collision mapping are settled in `listing-draft-price-and-placement`, and a
 * second copy through an extra HTTP-shaped layer would test the layer, not the
 * guarantee.
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * NO NETWORK. Instants are injected; every value is synthetic. Cleanup is
 * SCOPED to this suite's own `p134place` email prefix.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createAccountSession } from "../src/server/account/account-session-service";
import { SESSION_COOKIE_NAME } from "../src/server/account/session-cookie";
import { readAccountHome } from "../src/server/account/account-home";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import { createDraftStorefront } from "../src/server/marketplace/storefront-service";
import { resolveActingAccount } from "../src/server/account/acting-participant-boundary";
import { createDraftProductAs } from "../src/server/marketplace/marketplace-application-service";
import { createListingSourceVersion } from "../src/server/marketplace/listing-service";
import { ListingCommercialTermsRequiredError } from "../src/server/marketplace/listing-errors";
import {
  LISTING_PLACEMENT_ROUTE_ERROR_CODES as CODES,
  handleCreateListingPlacementRequest,
} from "../src/server/marketplace/listing-placement-route-handler";
import { CURRENT_PLACEMENT_MARKER } from "../src/server/marketplace/listing-mapper";
import type { MarketplaceRole } from "../src/contracts/marketplace/participant";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-11-01T09:00:00.000Z";
const LATER = "2028-11-02T09:00:00.000Z";
const EMAIL_PREFIX = "p134place";
const ORIGIN = "https://monacado.test";
const PASSWORD = "correct-horse-battery-staple-1134";

let seq = 0;

async function cleanup(): Promise<void> {
  const accountIds = (
    await db.account.findMany({
      where: { email: { startsWith: EMAIL_PREFIX } },
      select: { id: true },
    })
  ).map((a) => a.id);
  if (accountIds.length === 0) return;
  const participantIds = (
    await db.marketplaceParticipant.findMany({
      where: { accountId: { in: accountIds } },
      select: { id: true },
    })
  ).map((p) => p.id);

  /* Children before parents, which documents the delete rules. */
  await db.listingSourceRecordVersionRow.deleteMany({
    where: { controllingParticipantId: { in: participantIds } },
  });
  await db.listing.deleteMany({
    where: { controllingParticipantId: { in: participantIds } },
  });
  const productIds = (
    await db.productSourceRecordVersionRow.findMany({
      where: { authorityCreatorParticipantId: { in: participantIds } },
      select: { internalProductId: true },
    })
  ).map((v) => v.internalProductId);
  await db.productSourceRecordVersionRow.deleteMany({
    where: { internalProductId: { in: productIds } },
  });
  await db.product.deleteMany({ where: { internalProductId: { in: productIds } } });
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
  await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

/** A real UNVERIFIED account and session, with a DRAFT participant holding `roles` — or none. */
async function signIn(roles: MarketplaceRole[] | null) {
  seq += 1;
  const account = await createAccount(
    {
      name: "Maker",
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
  const cookieHeader = `${SESSION_COOKIE_NAME}=${token}`;
  const resolution = await resolveActingAccount({ cookieHeader, now: NOW }, { db });
  if (resolution.outcome !== "AUTHENTICATED") throw new Error("unreachable");
  return {
    accountId: account.accountId,
    participantId: participant?.participant.participantId ?? null,
    actor: resolution.actor,
    cookieHeader,
  };
}

type Seller = Awaited<ReturnType<typeof signIn>>;

/** A private draft Product authored by this Seller. Returns its productRef. */
async function seedProduct(
  seller: Seller,
  overrides: { name?: string; promotable?: boolean } = {},
): Promise<string> {
  seq += 1;
  const created = await createDraftProductAs(
    seller.actor,
    {
      name: overrides.name ?? `Hand-thrown mug ${seq}`,
      description: null,
      promotable: overrides.promotable ?? true,
      generalAvailabilityState: "available",
      deliveryMode: "PHYSICAL",
    },
    { db, now: NOW },
  );
  return created.productRef;
}

/**
 * A private draft Storefront owned by this Seller. Returns its public handle.
 *
 * `createDraftStorefront` rather than the self-service `openOwnedDraftStorefront`
 * deliberately: the latter enforces the Phase 1.30 one-Storefront allowance, and
 * two of the cases below need a Seller with two shops. That allowance is a
 * Storefront-creation rule and not the subject of this phase — reaching around
 * it in a fixture is what keeps this suite about placement.
 */
async function seedStorefront(seller: Seller, displayName = "Ada's Workshop"): Promise<string> {
  seq += 1;
  const publicHandle = `p134-shop-${seq}`;
  await createDraftStorefront(
    {
      ownerParticipantId: seller.participantId!,
      publicHandle,
      presentation: { displayName, tagline: null, summary: null },
      actingAccountId: seller.accountId,
      now: NOW,
    },
    { db },
  );
  return publicHandle;
}

function place(
  cookieHeader: string | null,
  body: unknown,
  overrides: { originHeader?: string | null; contentType?: string | null } = {},
) {
  return handleCreateListingPlacementRequest(
    {
      contentType: overrides.contentType === undefined ? "application/json" : overrides.contentType,
      originHeader: overrides.originHeader === undefined ? ORIGIN : overrides.originHeader,
      cookieHeader,
      rawBody: typeof body === "string" ? body : JSON.stringify(body),
    },
    { db, now: () => NOW, appOrigin: ORIGIN },
  );
}

/** One Seller with one Product and one Storefront — the ordinary case. */
async function seedScene() {
  const seller = await signIn(["SELLER"]);
  const productRef = await seedProduct(seller);
  const storefrontHandle = await seedStorefront(seller);
  return { seller, productRef, storefrontHandle };
}

describe.skipIf(!RUN)("Phase 1.34 — seller-direct DRAFT Listing self-service", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  // — 1. The ordinary act —

  it("1. places a Seller's own Product in their own Storefront as one unpriced DRAFT", async () => {
    const { seller, productRef, storefrontHandle } = await seedScene();

    const result = await place(seller.cookieHeader, { productRef, storefrontHandle });

    expect(result.status).toBe(201);
    expect(result.body).toEqual({
      /* Phase 1.35 — the placement's own stable reference. Asserted by SHAPE,
         because it is random by construction and a fixed value would prove it
         was not. */
      listingRef: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{32}$/) as unknown as string,
      productRef,
      storefrontHandle,
      lifecycle: "DRAFT",
      listed: false,
    });
    /* No internal identity leaves the route, and no price: the answer echoes
       the caller's own selectors and states what was created. */
    expect(JSON.stringify(result.body)).not.toMatch(/mon:|an:/);
    expect(JSON.stringify(result.body)).not.toMatch(/price|currency|retail|offer/i);

    // — exactly one aggregate, exactly one immutable version —
    const listings = await db.listing.findMany({
      where: { controllingParticipantId: seller.participantId! },
    });
    expect(listings).toHaveLength(1);
    const listing = listings[0]!;
    expect(listing.lifecycle).toBe("DRAFT");
    expect(listing.listingType).toBe("SELLER_DIRECT");
    expect(listing.currentPlacementMarker).toBe(CURRENT_PLACEMENT_MARKER);
    expect(listing.controllingParticipantId).toBe(seller.participantId);
    expect(listing.currentSourceRecordVersion).toBe("1");

    const versions = await db.listingSourceRecordVersionRow.findMany({
      where: { internalListingId: listing.internalListingId },
    });
    expect(versions).toHaveLength(1);
    const version = versions[0]!;
    expect(version.sourceRecordVersion).toBe("1");
    /* The pointer names the version that exists, and the version supersedes
       nothing — it is the first. */
    expect(version.sourceRecordVersion).toBe(listing.currentSourceRecordVersion);
    expect(version.supersedesSourceRecordVersion).toBeNull();
    expect(version.lifecycle).toBe("DRAFT");
    expect(version.listingType).toBe("SELLER_DIRECT");


    // — the placement's three references, and its authority provenance —
    const product = await db.product.findFirstOrThrow({ where: { productRef } });
    const storefront = await db.storefront.findUniqueOrThrow({ where: { publicHandle: storefrontHandle } });
    expect(listing.internalProductId).toBe(product.internalProductId);
    expect(listing.storefrontId).toBe(storefront.internalStorefrontId);
    expect(version.internalProductId).toBe(product.internalProductId);
    expect(version.storefrontId).toBe(storefront.internalStorefrontId);
    expect(version.authorizedByParticipantId).toBe(seller.participantId);
    expect(version.authorizedByActorId).toBe(seller.accountId);
    expect([version.sourceSystem, version.sourceRecordType, version.sourceClass]).toEqual([
      "monacado",
      "Listing",
      "governed-database-record",
    ]);
  });

  // — 2. No price, no Offer —

  it("2. writes NO price and NO Offer — placement is not pricing", async () => {
    const { seller, productRef, storefrontHandle } = await seedScene();
    expect((await place(seller.cookieHeader, { productRef, storefrontHandle })).status).toBe(201);

    const version = await db.listingSourceRecordVersionRow.findFirstOrThrow({
      where: { controllingParticipantId: seller.participantId! },
    });
    /* Both NULL, as a pair. Not a zero, not a default currency — a placeholder
       price is a fabricated commercial fact in an authoritative record. */
    expect(version.retailPriceMinorUnits).toBeNull();
    expect(version.retailPriceCurrency).toBeNull();
    /* And no sale overlay, which would need a price to discount. */
    expect(version.salePriceMinorUnits).toBeNull();
    expect(version.salePriceCurrency).toBeNull();

    /* The seller-direct branch has no field for an Offer, and none was created
       anywhere: no Offer, no Offer version, no accepted binding. */
    expect(version.acceptedInternalOfferId).toBeNull();
    expect(version.acceptedOfferSourceRecordId).toBeNull();
    expect(version.acceptedOfferSourceRecordVersion).toBeNull();
    expect(version.acceptedWholesalePriceMinorUnits).toBeNull();
    expect(await db.offer.count({ where: { internalProductId: version.internalProductId } })).toBe(0);
    expect(
      await db.offerSourceRecordVersionRow.count({
        where: { internalProductId: version.internalProductId },
      }),
    ).toBe(0);
  });

  it("2a. creates no Node, no publication, and no outbox work", async () => {
    const { seller, productRef, storefrontHandle } = await seedScene();
    expect((await place(seller.cookieHeader, { productRef, storefrontHandle })).status).toBe(201);

    const product = await db.product.findFirstOrThrow({ where: { productRef } });
    const internalProductId = product.internalProductId;
    expect(await db.productNode.count({ where: { internalProductId } })).toBe(0);
    expect(await db.productPublication.count({ where: { internalProductId } })).toBe(0);
    expect(await db.order.count({ where: { internalProductId } })).toBe(0);
    expect(await db.publicationOutbox.count()).toBe(0);
  });

  // — 3. Nothing else moved —

  it("3. leaves the Product and the Storefront byte-identical", async () => {
    const { seller, productRef, storefrontHandle } = await seedScene();
    const productBefore = await db.product.findFirstOrThrow({ where: { productRef } });
    const productVersionsBefore = await db.productSourceRecordVersionRow.findMany({
      where: { internalProductId: productBefore.internalProductId },
      orderBy: { seq: "asc" },
    });
    const storeBefore = await db.storefront.findUniqueOrThrow({
      where: { publicHandle: storefrontHandle },
    });
    const storeVersionsBefore = await db.storefrontSourceRecordVersionRow.findMany({
      where: { internalStorefrontId: storeBefore.internalStorefrontId },
      orderBy: { seq: "asc" },
    });

    expect((await place(seller.cookieHeader, { productRef, storefrontHandle })).status).toBe(201);

    /* A placement asserts nothing about the Product or the shop it names, so
       neither may gain a version, move its pointer, or change a fact. */
    expect(
      await db.product.findFirstOrThrow({ where: { productRef } }),
    ).toEqual(productBefore);
    expect(
      await db.productSourceRecordVersionRow.findMany({
        where: { internalProductId: productBefore.internalProductId },
        orderBy: { seq: "asc" },
      }),
    ).toEqual(productVersionsBefore);
    expect(
      await db.storefront.findUniqueOrThrow({ where: { publicHandle: storefrontHandle } }),
    ).toEqual(storeBefore);
    expect(
      await db.storefrontSourceRecordVersionRow.findMany({
        where: { internalStorefrontId: storeBefore.internalStorefrontId },
        orderBy: { seq: "asc" },
      }),
    ).toEqual(storeVersionsBefore);
  });

  // — 4. promotable is irrelevant to seller-direct placement —

  it("4. places a NOT-promotable Product, and does not touch the fact", async () => {
    /* `promotable` is the creator's statement about third-party promotion. A
       Seller placing their own Product in their own shop asks nobody's
       permission to promote anything, so the fact is not consulted — and
       placement must not quietly flip it to make itself work. */
    const seller = await signIn(["SELLER"]);
    const productRef = await seedProduct(seller, { promotable: false });
    const storefrontHandle = await seedStorefront(seller);

    expect((await place(seller.cookieHeader, { productRef, storefrontHandle })).status).toBe(201);

    const product = await db.product.findFirstOrThrow({ where: { productRef } });
    const version = await db.productSourceRecordVersionRow.findFirstOrThrow({
      where: {
        sourceRecordId: product.sourceRecordId,
        sourceRecordVersion: product.currentSourceRecordVersion,
      },
    });
    expect(version.factPromotable).toBe(false);
    expect(product.currentSourceRecordVersion).toBe("1");
  });

  // — 5. The placement invariant, through the route —

  it("5. refuses a SECOND placement of the same Product in the same Storefront", async () => {
    const { seller, productRef, storefrontHandle } = await seedScene();
    expect((await place(seller.cookieHeader, { productRef, storefrontHandle })).status).toBe(201);

    const second = await place(seller.cookieHeader, { productRef, storefrontHandle });
    expect(second).toMatchObject({ status: 409, body: { error: CODES.alreadyExists } });

    /* Nothing was written, and the first placement is untouched. */
    const listings = await db.listing.findMany({
      where: { controllingParticipantId: seller.participantId! },
    });
    expect(listings).toHaveLength(1);
    expect(listings[0]!.currentSourceRecordVersion).toBe("1");
    expect(
      await db.listingSourceRecordVersionRow.count({
        where: { internalListingId: listings[0]!.internalListingId },
      }),
    ).toBe(1);
  });

  it("6. places the same Product in a SECOND Storefront", async () => {
    const { seller, productRef, storefrontHandle } = await seedScene();
    const second = await seedStorefront(seller, "Ada's Annexe");

    expect((await place(seller.cookieHeader, { productRef, storefrontHandle })).status).toBe(201);
    expect(
      (await place(seller.cookieHeader, { productRef, storefrontHandle: second })).status,
    ).toBe(201);

    /* A Product is not consumed by being placed: no exclusive-placement state
       exists (assortment rules §4). Both stay DRAFT. */
    const listings = await db.listing.findMany({
      where: { controllingParticipantId: seller.participantId! },
    });
    expect(listings).toHaveLength(2);
    expect(listings.map((l) => l.lifecycle)).toEqual(["DRAFT", "DRAFT"]);
    expect(new Set(listings.map((l) => l.storefrontId)).size).toBe(2);
    expect(new Set(listings.map((l) => l.internalProductId)).size).toBe(1);
  });

  it("7. places a SECOND Product in the same Storefront", async () => {
    const { seller, productRef, storefrontHandle } = await seedScene();
    const other = await seedProduct(seller, { name: "Second mug" });

    expect((await place(seller.cookieHeader, { productRef, storefrontHandle })).status).toBe(201);
    expect(
      (await place(seller.cookieHeader, { productRef: other, storefrontHandle })).status,
    ).toBe(201);

    const listings = await db.listing.findMany({
      where: { controllingParticipantId: seller.participantId! },
    });
    expect(listings).toHaveLength(2);
    expect(new Set(listings.map((l) => l.internalProductId)).size).toBe(2);
  });

  it("8. lets one Storefront hold more than five DRAFT placements", async () => {
    /* Assortment rules §2: the five-per-Storefront allowance counts ACTIVE
       Listings and is enforced at activation. A draft consumes no capacity, so
       six drafts is not an upgrade conversation — and a quota accidentally
       applied here would be one. */
    const { seller, productRef, storefrontHandle } = await seedScene();
    const refs = [productRef];
    for (let i = 0; i < 5; i += 1) refs.push(await seedProduct(seller));

    for (const ref of refs) {
      expect((await place(seller.cookieHeader, { productRef: ref, storefrontHandle })).status).toBe(
        201,
      );
    }
    expect(
      await db.listing.count({
        where: { controllingParticipantId: seller.participantId!, lifecycle: "DRAFT" },
      }),
    ).toBe(6);
  });

  // — 9. A refusal tells a stranger nothing —

  it("9. answers the same for an unknown reference, another Seller's Product, and a foreign Storefront", async () => {
    const { seller, productRef, storefrontHandle } = await seedScene();
    const stranger = await signIn(["SELLER"]);
    const strangerProduct = await seedProduct(stranger, { name: "Not yours" });
    const strangerShop = await seedStorefront(stranger, "Someone else's shop");

    const unknownRef = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    const answers = await Promise.all([
      /* A reference that names nothing. */
      place(seller.cookieHeader, { productRef: unknownRef, storefrontHandle }),
      /* A real Product that belongs to somebody else. */
      place(seller.cookieHeader, { productRef: strangerProduct, storefrontHandle }),
      /* A handle that names nothing. */
      place(seller.cookieHeader, { productRef, storefrontHandle: "p134-no-such-shop" }),
      /* A real Storefront the caller does not control. */
      place(seller.cookieHeader, { productRef, storefrontHandle: strangerShop }),
    ]);

    /* One answer for all four. Separating them would confirm that a named
       reference exists and belongs to someone else, which is exactly what an
       attacker enumerating opaque references is looking for. */
    for (const answer of answers) {
      expect(answer).toEqual({
        status: 404,
        body: { error: CODES.notAvailable },
        headers: answer.headers,
      });
    }
    /* And nothing was created for anyone. */
    expect(await db.listing.count({ where: { controllingParticipantId: seller.participantId! } })).toBe(0);
    expect(
      await db.listing.count({ where: { controllingParticipantId: stranger.participantId! } }),
    ).toBe(0);
  });

  // — 10. Who may not place at all —

  it("10. refuses a PROMOTER-only participant", async () => {
    /* A promoter never holds creator authority over a Product, and this route
       is seller-direct only. It does NOT fall back to the promoted path, which
       remains non-self-service pending anti-gaming and economic-principal work. */
    const seller = await signIn(["SELLER"]);
    const productRef = await seedProduct(seller);
    const storefrontHandle = await seedStorefront(seller);

    const promoter = await signIn(["PROMOTER"]);
    const result = await place(promoter.cookieHeader, { productRef, storefrontHandle });
    expect(result).toMatchObject({ status: 403, body: { error: CODES.notEligible } });
  });

  it("11. refuses an account holding no participant", async () => {
    const seller = await signIn(["SELLER"]);
    const productRef = await seedProduct(seller);
    const storefrontHandle = await seedStorefront(seller);

    const bare = await signIn(null);
    const result = await place(bare.cookieHeader, { productRef, storefrontHandle });
    /* Not a participant at all — so there is no identity a Listing controller
       could name. The answer says the caller is ineligible, which reveals
       nothing about anybody else. */
    expect(result).toMatchObject({ status: 403, body: { error: CODES.notEligible } });
  });

  it("12. refuses a SUSPENDED participant through the existing standing seam", async () => {
    const { seller, productRef, storefrontHandle } = await seedScene();
    /* Fixture only: the status a governed suspension would leave. */
    await db.marketplaceParticipant.update({
      where: { id: seller.participantId! },
      data: { status: "SUSPENDED" },
    });

    const result = await place(seller.cookieHeader, { productRef, storefrontHandle });
    expect(result.status).toBe(403);
    expect(await db.listing.count({ where: { controllingParticipantId: seller.participantId! } })).toBe(0);
  });

  // — 13. The request boundary —

  it("13. refuses a signed-out caller", async () => {
    const result = await place(null, { productRef: "A".repeat(32), storefrontHandle: "p134-x" });
    expect(result).toMatchObject({ status: 401, body: { error: CODES.unauthenticated } });
  });

  it("14. refuses a foreign origin before reading the session", async () => {
    const { seller, productRef, storefrontHandle } = await seedScene();
    const result = await place(
      seller.cookieHeader,
      { productRef, storefrontHandle },
      { originHeader: "https://evil.example" },
    );
    expect(result).toMatchObject({ status: 403, body: { error: CODES.crossOrigin } });
    expect(await db.listing.count({ where: { controllingParticipantId: seller.participantId! } })).toBe(0);
  });

  it("15. refuses a malformed body, and every internal identity a caller might inject", async () => {
    const { seller, productRef, storefrontHandle } = await seedScene();
    const good = { productRef, storefrontHandle };

    const product = await db.product.findFirstOrThrow({ where: { productRef } });
    const storefront = await db.storefront.findUniqueOrThrow({
      where: { publicHandle: storefrontHandle },
    });

    const bodies: unknown[] = [
      "not json at all",
      {},
      { productRef },
      { storefrontHandle },
      /* Identity substitution: the internal ids are NOT accepted in place of
         the selectors, whatever they are. */
      { productRef: product.internalProductId, storefrontHandle },
      { productRef: product.sourceRecordId, storefrontHandle },
      { productRef, storefrontHandle: storefront.internalStorefrontId },
      /* Identity and authority injection: every one of these is a field the
         strict body does not have, so it is refused rather than ignored. */
      { ...good, controllingParticipantId: seller.participantId },
      { ...good, ownerParticipantId: seller.participantId },
      { ...good, actingAccountId: seller.accountId },
      { ...good, internalProductId: product.internalProductId },
      { ...good, storefrontId: storefront.internalStorefrontId },
      { ...good, internalListingId: "mon:listing:AAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { ...good, sourceRecordVersion: "1" },
      { ...good, lifecycle: "ACTIVE" },
      { ...good, retail: { retailPriceMinorUnits: 1_000, retailPriceCurrency: "USD" } },
      { ...good, retailPriceMinorUnits: 1_000 },
      { ...good, acceptedOfferSourceRecordId: "mon:srec:AAAAAAAAAAAAAAAAAAAAAAAAAA" },
      { ...good, listingType: "PROMOTED" },
      { ...good, currentPlacementMarker: "CURRENT" },
    ];

    for (const body of bodies) {
      expect(await place(seller.cookieHeader, body)).toMatchObject({
        status: 400,
        body: { error: CODES.invalidRequest },
      });
    }
    /* A form post is not this API either. */
    expect(
      await place(seller.cookieHeader, good, { contentType: "application/x-www-form-urlencoded" }),
    ).toMatchObject({ status: 400, body: { error: CODES.invalidRequest } });

    expect(await db.listing.count({ where: { controllingParticipantId: seller.participantId! } })).toBe(0);
  });

  // — 16. The activation boundary stays closed —

  it("16. still refuses to take the unpriced placement live", async () => {
    const { seller, productRef, storefrontHandle } = await seedScene();
    expect((await place(seller.cookieHeader, { productRef, storefrontHandle })).status).toBe(201);
    const listing = await db.listing.findFirstOrThrow({
      where: { controllingParticipantId: seller.participantId! },
    });

    /* There is no route and no UI for this — the attempt goes straight at the
       domain, which is the only way to reach it at all. Placement is not
       pricing, and going live is where that stops being true. */
    await expect(
      createListingSourceVersion(
        {
          internalListingId: listing.internalListingId,
          sourceRecordVersion: "2",
          lifecycle: "ACTIVE",
          actingAccountId: seller.accountId,
          now: LATER,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(ListingCommercialTermsRequiredError);

    expect(
      (await db.listing.findUniqueOrThrow({ where: { internalListingId: listing.internalListingId } }))
        .lifecycle,
    ).toBe("DRAFT");
  });

  // — 17. What the account page is given —

  it("17. shows the placement on the account page, with safe selectors only", async () => {
    const { seller, productRef, storefrontHandle } = await seedScene();
    expect((await place(seller.cookieHeader, { productRef, storefrontHandle })).status).toBe(201);

    const home = await readAccountHome(seller.accountId, { db });
    expect(home!.placements).toEqual([
      {
        listingRef: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{32}$/) as unknown as string,
        productName: expect.stringMatching(/^Hand-thrown mug /) as unknown as string,
        storefrontDisplayName: "Ada's Workshop",
        storefrontHandle,
        lifecycle: "DRAFT",
      },
    ]);
    /* The form is offered, and its two selectors are the safe ones. */
    expect(home!.canPlaceListing).toBe(true);
    expect(home!.products.map((p) => p.productRef)).toContain(productRef);
    expect(home!.storefronts.map((s) => s.publicHandle)).toContain(storefrontHandle);
    expect(home!.storefronts.every((s) => s.canPlaceProduct)).toBe(true);

    /* No internal identity, and no price, reaches the page. */
    const serialized = JSON.stringify(home);
    expect(serialized).not.toMatch(/mon:|an:node/);
    expect(serialized).not.toMatch(/retailPrice|currency/i);
  });

  it("18. offers no placement form when either half is missing", async () => {
    /* A Seller with products and nowhere to put them, and a Seller with a shop
       and nothing to put in it. Neither gets a dead control, and neither is
       redirected into an unrelated flow — both controls are already on the page. */
    const noShop = await signIn(["SELLER"]);
    await seedProduct(noShop);
    const noShopHome = await readAccountHome(noShop.accountId, { db });
    expect(noShopHome!.canPlaceListing).toBe(false);
    expect(noShopHome!.products.length).toBeGreaterThan(0);
    expect(noShopHome!.storefronts).toEqual([]);
    expect(noShopHome!.placements).toEqual([]);

    const noProduct = await signIn(["SELLER"]);
    await seedStorefront(noProduct);
    const noProductHome = await readAccountHome(noProduct.accountId, { db });
    expect(noProductHome!.canPlaceListing).toBe(false);
    expect(noProductHome!.products).toEqual([]);
    expect(noProductHome!.storefronts.length).toBeGreaterThan(0);

    const neither = await signIn(["SELLER"]);
    const neitherHome = await readAccountHome(neither.accountId, { db });
    expect(neitherHome!.canPlaceListing).toBe(false);

    /* And a promoter is never offered it, whatever they own. */
    const promoter = await signIn(["PROMOTER"]);
    expect((await readAccountHome(promoter.accountId, { db }))!.canPlaceListing).toBe(false);
  });
});
