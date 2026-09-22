/**
 * Phase 1.35 — the stable Listing application reference, and withdrawal of a
 * private seller-direct DRAFT placement.
 *
 * Phase 1.34 let a Seller create a placement and then never name one again:
 * every identifier a Listing had was internal, so the only self-service act in
 * the product had no undo. This suite proves the two halves of the fix.
 *
 * **The reference.** `listingRef` names the placement AGGREGATE, not a version
 * of it — so it survives the withdrawal that mints a new version, which is
 * exactly what makes it safe in a URL somebody kept. It is opaque,
 * un-namespaced, unique, server-minted, and refused as input.
 *
 * **The withdrawal.** One transition, `SELLER_DIRECT` + `DRAFT` → `WITHDRAWN`,
 * and the thing worth proving about it is the release: the Product + Storefront
 * pair genuinely comes free, so the same Product can be placed in the same shop
 * again under a NEW reference while the old placement keeps its history.
 *
 * **The non-disclosure.** A reference naming nothing and a real placement
 * belonging to someone else are one answer. Anything finer turns this route
 * into a census of a competitor's private shelf, assembled one 404 at a time.
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * NO NETWORK. Instants are injected; every value is synthetic. Cleanup is
 * SCOPED to this suite's own `p135` prefix.
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
import { createDraftOffer } from "../src/server/marketplace/offer-service";
import { createPromotedListing } from "../src/server/marketplace/listing-service";
import {
  LISTING_PLACEMENT_ROUTE_ERROR_CODES as PLACE_CODES,
  handleCreateListingPlacementRequest,
} from "../src/server/marketplace/listing-placement-route-handler";
import {
  LISTING_WITHDRAWAL_ROUTE_ERROR_CODES as CODES,
  handleWithdrawListingRequest,
} from "../src/server/marketplace/listing-withdrawal-route-handler";
import { CURRENT_PLACEMENT_MARKER } from "../src/server/marketplace/listing-mapper";
import { LISTING_ID_PATTERNS } from "../src/server/marketplace/listing-ids";
import type { MarketplaceRole } from "../src/contracts/marketplace/participant";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-12-01T09:00:00.000Z";
const EMAIL_PREFIX = "p135";
const ORIGIN = "https://monacado.test";
const PASSWORD = "correct-horse-battery-staple-1135";
const REF_SHAPE = /^[0-9A-HJKMNP-TV-Z]{32}$/;

const ACQUISITION_POLICY = {
  policyId: "mon:policy:acquisition/synthetic",
  policyVersion: "1",
  currency: "USD",
  retainedPercentageBasisPoints: 750,
  retainedFixedAmountMinorUnits: 100,
  roundingPolicy: "HALF_UP_TO_MINOR_UNIT" as const,
};

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

  await db.listingSourceRecordVersionRow.deleteMany({
    where: { controllingParticipantId: { in: participantIds } },
  });
  await db.listing.deleteMany({ where: { controllingParticipantId: { in: participantIds } } });
  await db.offerSourceRecordVersionRow.deleteMany({
    where: { sellerParticipantId: { in: participantIds } },
  });
  await db.offer.deleteMany({ where: { sellerParticipantId: { in: participantIds } } });
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
  await db.marketplaceRoleAssignment.deleteMany({ where: { participantId: { in: participantIds } } });
  await db.marketplaceParticipant.deleteMany({ where: { id: { in: participantIds } } });
  await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

async function signIn(roles: MarketplaceRole[] | null) {
  seq += 1;
  const account = await createAccount(
    { name: "Maker", email: `${EMAIL_PREFIX}${seq}@example.com`, password: PASSWORD, createdAt: NOW },
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

async function seedProduct(seller: Seller, name?: string): Promise<string> {
  seq += 1;
  const created = await createDraftProductAs(
    seller.actor,
    {
      name: name ?? `Widget ${seq}`,
      description: null,
      promotable: true,
      generalAvailabilityState: "available",
      deliveryMode: "DIGITAL",
    },
    { db, now: NOW },
  );
  return created.productRef;
}

async function seedStorefront(seller: Seller): Promise<string> {
  seq += 1;
  const publicHandle = `p135-shop-${seq}`;
  await createDraftStorefront(
    {
      ownerParticipantId: seller.participantId!,
      publicHandle,
      presentation: { displayName: `Shop ${seq}`, tagline: null, summary: null },
      actingAccountId: seller.accountId,
      now: NOW,
    },
    { db },
  );
  return publicHandle;
}

const place = (cookieHeader: string | null, body: unknown) =>
  handleCreateListingPlacementRequest(
    {
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader,
      rawBody: JSON.stringify(body),
    },
    { db, now: () => NOW, appOrigin: ORIGIN },
  );

const withdraw = (
  cookieHeader: string | null,
  listingRef: string,
  overrides: { originHeader?: string | null } = {},
) =>
  handleWithdrawListingRequest(
    {
      listingRef,
      originHeader: overrides.originHeader === undefined ? ORIGIN : overrides.originHeader,
      cookieHeader,
    },
    { db, now: () => NOW, appOrigin: ORIGIN },
  );

/** A Seller holding one placed Product in one of their Storefronts. */
async function seedPlacement() {
  const seller = await signIn(["SELLER"]);
  const productRef = await seedProduct(seller);
  const storefrontHandle = await seedStorefront(seller);
  const created = await place(seller.cookieHeader, { productRef, storefrontHandle });
  const listingRef = (created.body as { listingRef: string }).listingRef;
  return { seller, productRef, storefrontHandle, listingRef };
}

describe.skipIf(!RUN)("Phase 1.35 — the Listing application reference", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("1. mints one per placement, unique, and in the shared application-reference shape", async () => {
    const { seller, storefrontHandle, listingRef } = await seedPlacement();
    expect(listingRef).toMatch(REF_SHAPE);
    expect(listingRef).toMatch(LISTING_ID_PATTERNS.applicationRef);

    const other = await seedProduct(seller, "Second widget");
    const second = await place(seller.cookieHeader, { productRef: other, storefrontHandle });
    const secondRef = (second.body as { listingRef: string }).listingRef;
    expect(secondRef).not.toBe(listingRef);

    /* Uniqueness is a constraint, not a probability argument. */
    const rows = await db.listing.findMany({
      where: { controllingParticipantId: seller.participantId! },
      select: { internalListingId: true, listingRef: true },
    });
    expect(new Set(rows.map((r) => r.listingRef)).size).toBe(rows.length);
    await expect(
      db.listing.update({
        where: { internalListingId: rows[1]!.internalListingId },
        data: { listingRef: rows[0]!.listingRef },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("2. is none of the identities around it", async () => {
    const { listingRef } = await seedPlacement();
    const row = await db.listing.findFirstOrThrow({ where: { listingRef } });
    expect(listingRef).not.toBe(row.internalListingId);
    expect(listingRef).not.toBe(row.listingSourceRecordId);
    /* Structural, not incidental: every internal identity carries a namespace
       prefix and this carries none, so it cannot be read as one. */
    expect(listingRef.startsWith("mon:")).toBe(false);
    expect(listingRef.startsWith("an:")).toBe(false);
    expect(listingRef).not.toContain(":");
    /* And it encodes nothing about what it names. */
    expect(listingRef).not.toContain(row.internalProductId.slice(-8));
    expect(listingRef).not.toContain(row.storefrontId.slice(-8));
  });

  it("3. cannot be injected by a client creating a placement", async () => {
    const seller = await signIn(["SELLER"]);
    const productRef = await seedProduct(seller);
    const storefrontHandle = await seedStorefront(seller);
    const chosen = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";

    for (const body of [
      { productRef, storefrontHandle, listingRef: chosen },
      { productRef, storefrontHandle, listingRef: null },
    ]) {
      expect(await place(seller.cookieHeader, body)).toMatchObject({
        status: 400,
        body: { error: PLACE_CODES.invalidRequest },
      });
    }
    expect(await db.listing.count({ where: { listingRef: chosen } })).toBe(0);
  });

  it("4. does NOT move when a new immutable source version is minted", async () => {
    /* The reference names the aggregate. A link held before a withdrawal still
       names the same placement after it — which is the whole reason it is not
       versioned. */
    const { seller, listingRef } = await seedPlacement();
    const before = await db.listing.findFirstOrThrow({ where: { listingRef } });

    expect((await withdraw(seller.cookieHeader, listingRef)).status).toBe(200);

    const after = await db.listing.findUniqueOrThrow({
      where: { internalListingId: before.internalListingId },
    });
    expect(after.listingRef).toBe(listingRef);
    expect(after.currentSourceRecordVersion).toBe("2");
  });
});

describe.skipIf(!RUN)("Phase 1.35 — withdrawing a private DRAFT placement", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  // — The act —

  it("5. withdraws the controller's own seller-direct DRAFT placement", async () => {
    const { seller, listingRef } = await seedPlacement();
    const result = await withdraw(seller.cookieHeader, listingRef);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ listingRef, lifecycle: "WITHDRAWN", listed: false });
    /* No internal identity, no Product, no Storefront, no price. */
    expect(JSON.stringify(result.body)).not.toMatch(/mon:|an:/);
    expect(JSON.stringify(result.body)).not.toMatch(/price|currency|offer/i);
  });

  it("6. keeps one aggregate, adds one version, and leaves version 1 untouched", async () => {
    const { seller, listingRef } = await seedPlacement();
    const before = await db.listingSourceRecordVersionRow.findFirstOrThrow({
      where: { sourceRecordVersion: "1" },
    });

    await withdraw(seller.cookieHeader, listingRef);

    const listing = await db.listing.findFirstOrThrow({ where: { listingRef } });
    expect(listing.lifecycle).toBe("WITHDRAWN");
    expect(listing.currentSourceRecordVersion).toBe("2");

    const versions = await db.listingSourceRecordVersionRow.findMany({
      where: { internalListingId: listing.internalListingId },
      orderBy: { seq: "asc" },
    });
    expect(versions).toHaveLength(2);
    expect(versions.map((v) => v.sourceRecordVersion)).toEqual(["1", "2"]);
    /* Version 1 is immutable and still records the DRAFT truth. */
    expect(versions[0]).toEqual(before);
    expect(versions[1]!.supersedesSourceRecordVersion).toBe("1");
    expect(versions[1]!.lifecycle).toBe("WITHDRAWN");
    /* The withdrawal asserts nothing commercial: the unpriced placement stays
       unpriced rather than acquiring a zero on the way out. */
    expect(versions[1]!.retailPriceMinorUnits).toBeNull();
    expect(versions[1]!.retailPriceCurrency).toBeNull();
    /* And the placement's three references are carried forward unchanged. */
    expect(versions[1]!.internalProductId).toBe(versions[0]!.internalProductId);
    expect(versions[1]!.storefrontId).toBe(versions[0]!.storefrontId);
    expect(versions[1]!.controllingParticipantId).toBe(versions[0]!.controllingParticipantId);
  });

  it("7. RELEASES the Product + Storefront pair, and the same pair works again", async () => {
    const { seller, productRef, storefrontHandle, listingRef } = await seedPlacement();
    const first = await db.listing.findFirstOrThrow({ where: { listingRef } });

    /* Occupied while it is current. */
    expect(await place(seller.cookieHeader, { productRef, storefrontHandle })).toMatchObject({
      status: 409,
      body: { error: PLACE_CODES.alreadyExists },
    });

    await withdraw(seller.cookieHeader, listingRef);
    expect(
      (await db.listing.findUniqueOrThrow({ where: { internalListingId: first.internalListingId } }))
        .currentPlacementMarker,
    ).toBeNull();

    /* And now free again — the whole point of a terminal state releasing it. */
    const again = await place(seller.cookieHeader, { productRef, storefrontHandle });
    expect(again.status).toBe(201);
    const replacementRef = (again.body as { listingRef: string }).listingRef;
    expect(replacementRef).not.toBe(listingRef);

    const all = await db.listing.findMany({
      where: { internalProductId: first.internalProductId, storefrontId: first.storefrontId },
    });
    expect(all).toHaveLength(2);
    const withdrawn = all.find((l) => l.listingRef === listingRef)!;
    const replacement = all.find((l) => l.listingRef === replacementRef)!;
    expect([withdrawn.lifecycle, withdrawn.currentPlacementMarker]).toEqual(["WITHDRAWN", null]);
    expect([replacement.lifecycle, replacement.currentPlacementMarker]).toEqual([
      "DRAFT",
      CURRENT_PLACEMENT_MARKER,
    ]);
    /* At most one current placement for the pair, still structurally true. */
    expect(all.filter((l) => l.currentPlacementMarker !== null)).toHaveLength(1);
  });

  it("8. refuses a SECOND withdrawal, and mints nothing", async () => {
    const { seller, listingRef } = await seedPlacement();
    await withdraw(seller.cookieHeader, listingRef);
    const listing = await db.listing.findFirstOrThrow({ where: { listingRef } });

    const second = await withdraw(seller.cookieHeader, listingRef);
    expect(second).toMatchObject({ status: 409, body: { error: CODES.notWithdrawable } });

    /* WITHDRAWN is terminal: a repeat is a caller believing something untrue,
       not a no-op to absorb quietly. */
    expect(
      await db.listingSourceRecordVersionRow.count({
        where: { internalListingId: listing.internalListingId },
      }),
    ).toBe(2);
    expect(
      (await db.listing.findUniqueOrThrow({ where: { internalListingId: listing.internalListingId } }))
        .currentSourceRecordVersion,
    ).toBe("2");
  });

  it("9. refuses an ACTIVE placement", async () => {
    const { seller, listingRef } = await seedPlacement();
    /* Fixture only: the state a governed activation would leave. Activation
       itself is not exposed, and an unpriced placement could not reach it. */
    const listing = await db.listing.findFirstOrThrow({ where: { listingRef } });
    await db.listing.update({
      where: { internalListingId: listing.internalListingId },
      data: { lifecycle: "ACTIVE" },
    });

    expect(await withdraw(seller.cookieHeader, listingRef)).toMatchObject({
      status: 409,
      body: { error: CODES.notWithdrawable },
    });
    expect(
      await db.listingSourceRecordVersionRow.count({
        where: { internalListingId: listing.internalListingId },
      }),
    ).toBe(1);
  });

  it("10. refuses a PROMOTED placement, in either direction", async () => {
    /* Promoted self-service does not exist, and withdrawal is not a back door
       into it: anti-self-promotion and governed economic-principal resolution
       remain unbuilt. */
    const sellerOfRecord = await signIn(["SELLER"]);
    const promoter = await signIn(["SELLER", "PROMOTER"]);
    const productRef = await seedProduct(sellerOfRecord);
    const product = await db.product.findFirstOrThrow({ where: { productRef } });
    const storefrontHandle = await seedStorefront(promoter);
    const storefront = await db.storefront.findUniqueOrThrow({ where: { publicHandle: storefrontHandle } });
    const offer = await createDraftOffer(
      {
        internalProductId: product.internalProductId,
        sellerParticipantId: sellerOfRecord.participantId!,
        terms: {
          price: { type: "PAID", wholesalePriceMinorUnits: 5_000, wholesalePriceCurrency: "USD" },
          promotion: {
            type: "PROMOTABLE",
            commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2_000 },
          },
        },
        actingAccountId: sellerOfRecord.accountId,
        now: NOW,
      },
      { db },
    );
    const promoted = await createPromotedListing(
      {
        storefrontId: storefront.internalStorefrontId,
        internalProductId: product.internalProductId,
        controllingParticipantId: promoter.participantId!,
        retail: { retailPriceMinorUnits: 12_500, retailPriceCurrency: "USD" },
        acceptedOfferSourceRecordId: offer.record.offerSourceRecordId,
        acceptedOfferSourceRecordVersion: "1",
        acquisitionPolicy: ACQUISITION_POLICY,
        actingAccountId: promoter.accountId,
        now: NOW,
      },
      { db },
    );

    /* It HAS a reference — the reference names the aggregate, not its
       commercial type — and it still cannot be withdrawn here. */
    expect(promoted.listingRef).toMatch(REF_SHAPE);
    expect(await withdraw(promoter.cookieHeader, promoted.listingRef)).toMatchObject({
      status: 409,
      body: { error: CODES.notWithdrawable },
    });
    expect(
      await db.listingSourceRecordVersionRow.count({
        where: { internalListingId: promoted.record.internalListingId },
      }),
    ).toBe(1);
  });

  // — Non-disclosure —

  it("11. answers the same for an unknown reference and another Seller's placement", async () => {
    const { seller, listingRef } = await seedPlacement();
    const stranger = await signIn(["SELLER"]);

    const answers = await Promise.all([
      /* A well-formed reference that names nothing. */
      withdraw(stranger.cookieHeader, "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ"),
      /* A real placement belonging to somebody else. */
      withdraw(stranger.cookieHeader, listingRef),
      /* A path segment that could never be a reference. */
      withdraw(stranger.cookieHeader, "not-a-reference"),
      withdraw(stranger.cookieHeader, ""),
    ]);

    /* One answer for all four. Anything finer would let a caller holding a
       guessed reference learn that it exists, who has it, or what state it is
       in — a census of a competitor's private shelf, one 404 at a time. */
    for (const answer of answers) {
      expect(answer).toEqual({
        status: 404,
        body: { error: CODES.notAvailable },
        headers: answer.headers,
      });
    }
    /* And the real placement is untouched: still DRAFT, still current, still one version. */
    const listing = await db.listing.findFirstOrThrow({ where: { listingRef } });
    expect([listing.lifecycle, listing.currentPlacementMarker]).toEqual([
      "DRAFT",
      CURRENT_PLACEMENT_MARKER,
    ]);
    expect(
      await db.listingSourceRecordVersionRow.count({
        where: { internalListingId: listing.internalListingId },
      }),
    ).toBe(1);
    expect(seller.participantId).not.toBe(stranger.participantId);
  });

  it("12. refuses a PROMOTER-only caller, a participant-less account, and a suspended one", async () => {
    const { seller, listingRef } = await seedPlacement();

    /* A promoter-only participant controls nothing here, so they get the
       non-disclosing answer rather than a hint that the reference is real. */
    const promoter = await signIn(["PROMOTER"]);
    expect(await withdraw(promoter.cookieHeader, listingRef)).toMatchObject({
      status: 404,
      body: { error: CODES.notAvailable },
    });

    /* No participant at all — there is no identity to control anything. */
    const bare = await signIn(null);
    expect(await withdraw(bare.cookieHeader, listingRef)).toMatchObject({
      status: 403,
      body: { error: CODES.notEligible },
    });

    /* A suspended participant may not author marketplace state. */
    await db.marketplaceParticipant.update({
      where: { id: seller.participantId! },
      data: { status: "SUSPENDED" },
    });
    expect(await withdraw(seller.cookieHeader, listingRef)).toMatchObject({
      status: 403,
      body: { error: CODES.notEligible },
    });

    const listing = await db.listing.findFirstOrThrow({ where: { listingRef } });
    expect(listing.lifecycle).toBe("DRAFT");
  });

  it("13. refuses a signed-out caller and a foreign origin", async () => {
    const { listingRef } = await seedPlacement();

    expect(await withdraw(null, listingRef)).toMatchObject({
      status: 401,
      body: { error: CODES.unauthenticated },
    });
    /* Origin is checked before the session, so a cross-site post never reaches
       either the cookie or the reference. */
    const seller = await signIn(["SELLER"]);
    expect(
      await withdraw(seller.cookieHeader, listingRef, { originHeader: "https://evil.example" }),
    ).toMatchObject({ status: 403, body: { error: CODES.crossOrigin } });

    const listing = await db.listing.findFirstOrThrow({ where: { listingRef } });
    expect(listing.lifecycle).toBe("DRAFT");
  });

  // — Nothing else moved —

  it("14. leaves the Product and the Storefront byte-identical", async () => {
    const { seller, productRef, storefrontHandle, listingRef } = await seedPlacement();
    const productBefore = await db.product.findFirstOrThrow({ where: { productRef } });
    const productVersionsBefore = await db.productSourceRecordVersionRow.findMany({
      where: { internalProductId: productBefore.internalProductId },
      orderBy: { seq: "asc" },
    });
    const storeBefore = await db.storefront.findUniqueOrThrow({ where: { publicHandle: storefrontHandle } });
    const storeVersionsBefore = await db.storefrontSourceRecordVersionRow.findMany({
      where: { internalStorefrontId: storeBefore.internalStorefrontId },
      orderBy: { seq: "asc" },
    });
    const govBefore = await db.storefrontGovernanceAssignment.findMany({
      where: { internalStorefrontId: storeBefore.internalStorefrontId },
      orderBy: { id: "asc" },
    });

    await withdraw(seller.cookieHeader, listingRef);

    /* Removing a placement removes a placement. The Product stays in the
       library — including its `promotable` fact — and the shop is untouched. */
    expect(await db.product.findFirstOrThrow({ where: { productRef } })).toEqual(productBefore);
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
    expect(
      await db.storefrontGovernanceAssignment.findMany({
        where: { internalStorefrontId: storeBefore.internalStorefrontId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(govBefore);
  });

  it("15. creates no Offer, price, commission, Node, publication, or order state", async () => {
    const { seller, productRef, listingRef } = await seedPlacement();
    await withdraw(seller.cookieHeader, listingRef);

    const product = await db.product.findFirstOrThrow({ where: { productRef } });
    const internalProductId = product.internalProductId;
    expect(await db.offer.count({ where: { internalProductId } })).toBe(0);
    expect(await db.offerSourceRecordVersionRow.count({ where: { internalProductId } })).toBe(0);
    expect(await db.order.count({ where: { internalProductId } })).toBe(0);
    expect(await db.productNode.count({ where: { internalProductId } })).toBe(0);
    expect(await db.productPublication.count({ where: { internalProductId } })).toBe(0);
    expect(await db.publicationOutbox.count()).toBe(0);
    expect(
      await db.listing.count({
        where: { controllingParticipantId: seller.participantId!, lifecycle: "ACTIVE" },
      }),
    ).toBe(0);
  });

  // — What the account page is given —

  it("16. drops the withdrawn placement from the account page and keeps both sides usable", async () => {
    const { seller, productRef, storefrontHandle, listingRef } = await seedPlacement();

    const before = await readAccountHome(seller.accountId, { db });
    expect(before!.placements.map((p) => p.listingRef)).toEqual([listingRef]);
    expect(before!.placements[0]!.lifecycle).toBe("DRAFT");

    await withdraw(seller.cookieHeader, listingRef);

    const after = await readAccountHome(seller.accountId, { db });
    /* The projection reads the placement MARKER, so a released placement simply
       stops being current — no history view, and none built here. */
    expect(after!.placements).toEqual([]);
    /* Both sides survive and are offerable again. */
    expect(after!.products.map((p) => p.productRef)).toContain(productRef);
    expect(after!.storefronts.map((s) => s.publicHandle)).toContain(storefrontHandle);
    expect(after!.canPlaceListing).toBe(true);
    /* And no identifier the page must not hold reaches it. */
    expect(JSON.stringify(after)).not.toMatch(/mon:|an:node/);
  });
});
