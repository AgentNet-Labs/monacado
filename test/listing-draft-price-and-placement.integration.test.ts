/**
 * Phase 1.34, Rulings B and C — unpriced private DRAFT placement, and the
 * structural one-current-Listing-per-Product+Storefront invariant.
 *
 * Two separate architectural claims, proved against a real database because
 * both are ultimately claims about the schema:
 *
 * **B — a Listing is placement, not pricing.** Product = item, Listing =
 * placement, Offer = commercial terms. A private DRAFT Listing says which
 * Product appears in which Storefront, and saying that does not require having
 * decided what to charge. Before this, expressing it meant writing a zero or a
 * placeholder price — a fabricated commercial fact in an authoritative record.
 * Price and currency remain a PAIR: both, or neither, never one.
 *
 * **C — at most one CURRENT Listing per Product + Storefront.** The application
 * refuses a duplicate with a bounded `LISTING_ALREADY_EXISTS`; the composite
 * unique index refuses the one that raced past that check. Immutable historical
 * source VERSIONS are not duplicates, and a placement released by a terminal
 * lifecycle state is not one either.
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * NO NETWORK. Instants and identities are injected. Cleanup is SCOPED to this
 * suite's own `P134` / `listing-134` prefixes — never a global truncate, which
 * would hit the RESTRICT rules other suites rely on.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import { createDraftOffer } from "../src/server/marketplace/offer-service";
import {
  createListingSourceVersion,
  createPromotedListing,
  createSellerDirectListing,
  getCurrentSourceVersion,
  getEffectivePrice,
} from "../src/server/marketplace/listing-service";
import {
  CURRENT_PLACEMENT_MARKER,
  currentPlacementMarkerFor,
} from "../src/server/marketplace/listing-mapper";
import {
  InvalidListingInputError,
  ListingAlreadyExistsError,
  ListingCommercialTermsRequiredError,
} from "../src/server/marketplace/listing-errors";
import { LISTING_LIFECYCLE_STATES } from "../src/contracts/marketplace/listing-source";
import { grantProductCreatorAuthority } from "./support/product-authority-fixture";
import { syntheticProductRef } from "./support/product-ref-fixture";
import { syntheticListingRef } from "./support/listing-ref-fixture";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-10-01T09:00:00.000Z";
const LATER = "2028-10-02T09:00:00.000Z";
const PASSWORD = "correct-horse-battery-staple-1134";

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const PRODUCT_TAG = "P134PR0D";
const PRODUCT_PREFIX = `mon:product:${PRODUCT_TAG}`;
const ACCOUNT_EMAIL_PREFIX = "listing-134";

let seq = 0;

const retail = { retailPriceMinorUnits: 10_000, retailPriceCurrency: "USD" };

const ACQUISITION_POLICY = {
  policyId: "mon:policy:acquisition/synthetic",
  policyVersion: "1",
  currency: "USD",
  /* Synthetic, and deliberately NOT Monacado's real numbers — the policy is a
     supplied input, and a real rate compiled into a test would be the same
     mistake as compiling one into the contract. */
  retainedPercentageBasisPoints: 750,
  retainedFixedAmountMinorUnits: 100,
  roundingPolicy: "HALF_UP_TO_MINOR_UNIT" as const,
};

/** Remove only what THIS suite creates. Children before parents. */
async function cleanup(): Promise<void> {
  const accounts = await db.account.findMany({
    where: { email: { startsWith: ACCOUNT_EMAIL_PREFIX } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  const participantIds = (
    accountIds.length === 0
      ? []
      : await db.marketplaceParticipant.findMany({
          where: { accountId: { in: accountIds } },
          select: { id: true },
        })
  ).map((p) => p.id);

  await db.listingSourceRecordVersionRow.deleteMany({
    where: { internalProductId: { startsWith: PRODUCT_PREFIX } },
  });
  await db.listing.deleteMany({ where: { internalProductId: { startsWith: PRODUCT_PREFIX } } });
  await db.offerSourceRecordVersionRow.deleteMany({
    where: { internalProductId: { startsWith: PRODUCT_PREFIX } },
  });
  await db.offer.deleteMany({ where: { internalProductId: { startsWith: PRODUCT_PREFIX } } });
  await db.productSourceRecordVersionRow.deleteMany({
    where: { internalProductId: { startsWith: PRODUCT_PREFIX } },
  });

  if (participantIds.length > 0) {
    await db.storefrontGovernanceAssignment.deleteMany({
      where: { participantId: { in: participantIds } },
    });
    await db.storefrontSourceRecordVersionRow.deleteMany({
      where: { ownerParticipantId: { in: participantIds } },
    });
    await db.storefront.deleteMany({ where: { ownerParticipantId: { in: participantIds } } });
    await db.participantActivation.deleteMany({ where: { participantId: { in: participantIds } } });
    await db.participantProfile.deleteMany({ where: { participantId: { in: participantIds } } });
    await db.marketplaceRoleAssignment.deleteMany({
      where: { participantId: { in: participantIds } },
    });
    await db.marketplaceParticipant.deleteMany({ where: { id: { in: participantIds } } });
  }
  if (accountIds.length > 0) {
    await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.account.deleteMany({ where: { id: { in: accountIds } } });
  }
  await db.product.deleteMany({ where: { internalProductId: { startsWith: PRODUCT_PREFIX } } });
}

async function seedProduct(creatorParticipantId?: string): Promise<string> {
  seq += 1;
  const internalProductId = `${PRODUCT_PREFIX}${pad26(String(seq)).slice(
    0,
    26 - PRODUCT_TAG.length,
  )}`;
  await db.product.create({
    data: {
      internalProductId,
      productRef: syntheticProductRef(),
      sourceRecordId: `mon:srec:${pad26(`P134PSREC${seq}`)}`,
      currentSourceRecordVersion: "1",
      recordStatus: "DRAFT",
    },
  });
  if (creatorParticipantId !== undefined) {
    await grantProductCreatorAuthority(db, {
      internalProductId,
      participantId: creatorParticipantId,
      now: NOW,
    });
  }
  return internalProductId;
}

async function seedParticipant(roles: Array<"SELLER" | "PROMOTER">) {
  seq += 1;
  const account = await createAccount(
    {
      name: "Synthetic Controller",
      email: `${ACCOUNT_EMAIL_PREFIX}${seq}@example.com`,
      password: PASSWORD,
      createdAt: NOW,
    },
    { db },
  );
  const snapshot = await createDraftParticipant(
    { accountId: account.accountId, initialRoles: roles, now: NOW },
    { db },
  );
  return { participantId: snapshot.participant.participantId, accountId: account.accountId };
}

/** A Storefront row, created directly: its own service is 0M.3C's concern. */
async function seedStorefront(ownerParticipantId: string): Promise<string> {
  seq += 1;
  const internalStorefrontId = `mon:storefront:${pad26(`P134ST0RE${seq}`)}`;
  await db.storefront.create({
    data: {
      internalStorefrontId,
      storefrontSourceRecordId: `mon:srec:${pad26(`P134SFSREC${seq}`)}`,
      currentSourceRecordVersion: "1",
      ownerParticipantId,
      publicHandle: `p134-synthetic-shop-${seq}`,
      lifecycle: "DRAFT",
      visibility: "PRIVATE",
    },
  });
  return internalStorefrontId;
}

/** One seller who owns one Storefront and holds authority over one Product. */
async function seedSellerScene() {
  const seller = await seedParticipant(["SELLER"]);
  const internalProductId = await seedProduct(seller.participantId);
  const storefrontId = await seedStorefront(seller.participantId);
  return { seller, internalProductId, storefrontId };
}

const placeSellerDirect = (
  scene: { seller: { participantId: string; accountId: string }; internalProductId: string; storefrontId: string },
  overrides: Record<string, unknown> = {},
) =>
  createSellerDirectListing(
    {
      storefrontId: scene.storefrontId,
      internalProductId: scene.internalProductId,
      controllingParticipantId: scene.seller.participantId,
      actingAccountId: scene.seller.accountId,
      now: NOW,
      ...overrides,
    },
    { db },
  );

describe.skipIf(!RUN)("Phase 1.34 Ruling B — a private DRAFT Listing needs no price", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("1. creates a seller-direct DRAFT placement with no retail price at all", async () => {
    const scene = await seedSellerScene();
    const snapshot = await placeSellerDirect(scene);

    expect(snapshot.currentVersion.lifecycle).toBe("DRAFT");
    const placement = snapshot.currentVersion.placement;
    expect(placement.listingType).toBe("SELLER_DIRECT");
    if (placement.listingType === "SELLER_DIRECT") expect(placement.retail).toBeNull();

    /* BOTH columns NULL, and no fabricated stand-in for either: not a zero
       amount, not a default currency. */
    const row = await db.listingSourceRecordVersionRow.findFirstOrThrow({
      where: { internalListingId: snapshot.record.internalListingId },
    });
    expect(row.retailPriceMinorUnits).toBeNull();
    expect(row.retailPriceCurrency).toBeNull();
  });

  it("1a. round-trips the unpriced placement back out of the database unchanged", async () => {
    const scene = await seedSellerScene();
    const snapshot = await placeSellerDirect(scene);
    const reread = await getCurrentSourceVersion(snapshot.record.internalListingId, { db });
    expect(reread).toEqual(snapshot.currentVersion);
  });

  it("2. refuses a price with no currency, and a currency with no price", async () => {
    const scene = await seedSellerScene();
    /* Price and currency are ONE nested object, so half a price is
       unrepresentable rather than rejected after the fact. */
    for (const half of [
      { retailPriceMinorUnits: 10_000 },
      { retailPriceCurrency: "USD" },
    ]) {
      await expect(placeSellerDirect(scene, { retail: half })).rejects.toBeInstanceOf(
        InvalidListingInputError,
      );
    }
    expect(await db.listing.count({ where: { internalProductId: scene.internalProductId } })).toBe(0);
  });

  it("3. leaves an existing PRICED seller-direct Listing working exactly as before", async () => {
    const scene = await seedSellerScene();
    const snapshot = await placeSellerDirect(scene, { retail });

    const placement = snapshot.currentVersion.placement;
    if (placement.listingType === "SELLER_DIRECT") {
      expect(placement.retail).toEqual(retail);
    }
    expect(await getEffectivePrice(snapshot.record.internalListingId, NOW, { db })).toEqual({
      effectivePriceMinorUnits: 10_000,
      currency: "USD",
      saleActive: false,
    });
  });

  it("3a. refuses a scheduled sale on an unpriced placement", async () => {
    const scene = await seedSellerScene();
    /* A sale is an overlay on an ordinary price — strictly lower, same currency.
       With no ordinary price there is nothing for either rule to hold against. */
    await expect(
      placeSellerDirect(scene, {
        sale: {
          salePriceMinorUnits: 8_000,
          salePriceCurrency: "USD",
          saleStartsAt: "2028-12-01T00:00:00.000Z",
          saleEndsAt: "2028-12-08T00:00:00.000Z",
        },
      }),
    ).rejects.toBeInstanceOf(InvalidListingInputError);
  });

  it("3b. refuses to quote an effective price for an unpriced placement", async () => {
    const scene = await seedSellerScene();
    const snapshot = await placeSellerDirect(scene);
    /* Zero would read as free and a fallback currency would be invented. The
       refusal arrives as this module's own bounded error, carrying the
       calculator's code — not a raw contract exception. */
    await expect(
      getEffectivePrice(snapshot.record.internalListingId, NOW, { db }),
    ).rejects.toMatchObject({
      name: "ListingEconomicsRefusedError",
      economicsCode: "LISTING_NOT_PRICED",
    });
  });

  it("4. leaves PROMOTED Listings requiring a price — the loosening is seller-direct only", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const promoter = await seedParticipant(["PROMOTER"]);
    const internalProductId = await seedProduct(seller.participantId);
    const storefrontId = await seedStorefront(promoter.participantId);
    const offer = await createDraftOffer(
      {
        internalProductId,
        sellerParticipantId: seller.participantId,
        terms: {
          price: { type: "PAID", wholesalePriceMinorUnits: 5_000, wholesalePriceCurrency: "USD" },
          promotion: {
            type: "PROMOTABLE",
            commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2_000 },
          },
        },
        actingAccountId: seller.accountId,
        now: NOW,
      },
      { db },
    );

    const promoted = (overrides: Record<string, unknown> = {}) =>
      createPromotedListing(
        {
          storefrontId,
          internalProductId,
          controllingParticipantId: promoter.participantId,
          retail: { retailPriceMinorUnits: 12_500, retailPriceCurrency: "USD" },
          acceptedOfferSourceRecordId: offer.record.offerSourceRecordId,
          acceptedOfferSourceRecordVersion: "1",
          acquisitionPolicy: ACQUISITION_POLICY,
          actingAccountId: promoter.accountId,
          now: NOW,
          ...overrides,
        },
        { db },
      );

    /* A promoted placement exists only against an accepted priced Offer, and its
       viability check has no meaning without a retail price to check. */
    await expect(promoted({ retail: null })).rejects.toBeInstanceOf(InvalidListingInputError);

    /* And the ordinary promoted path is untouched. */
    const ok = await promoted();
    const placement = ok.currentVersion.placement;
    expect(placement.listingType).toBe("PROMOTED");
    if (placement.listingType === "PROMOTED") {
      expect(placement.retail.retailPriceMinorUnits).toBe(12_500);
      expect(placement.offerDependency.acceptedOfferSourceRecordVersion).toBe("1");
    }
  });

  it("5. refuses commercial activation of an unpriced placement", async () => {
    const scene = await seedSellerScene();
    const snapshot = await placeSellerDirect(scene);

    /* Placement is not pricing — but going live IS commercial. An item in front
       of buyers at no stated price is not a draft with a gap in it. */
    await expect(
      createListingSourceVersion(
        {
          internalListingId: snapshot.record.internalListingId,
          sourceRecordVersion: "2",
          lifecycle: "ACTIVE",
          actingAccountId: scene.seller.accountId,
          now: LATER,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(ListingCommercialTermsRequiredError);

    /* Refused BEFORE anything was written: no version 2, and the placement is
       still a draft. */
    const versions = await db.listingSourceRecordVersionRow.count({
      where: { internalListingId: snapshot.record.internalListingId },
    });
    expect(versions).toBe(1);
    expect(
      (
        await db.listing.findUniqueOrThrow({
          where: { internalListingId: snapshot.record.internalListingId },
        })
      ).lifecycle,
    ).toBe("DRAFT");
  });

  it("5a. lets the same placement be priced first, and then the price is material", async () => {
    const scene = await seedSellerScene();
    const snapshot = await placeSellerDirect(scene);

    const priced = await createListingSourceVersion(
      {
        internalListingId: snapshot.record.internalListingId,
        sourceRecordVersion: "2",
        retail,
        actingAccountId: scene.seller.accountId,
        now: LATER,
      },
      { db },
    );
    const placement = priced.currentVersion.placement;
    if (placement.listingType === "SELLER_DIRECT") expect(placement.retail).toEqual(retail);

    /* Version 1 is immutable and still records the unpriced truth. */
    const v1 = await db.listingSourceRecordVersionRow.findFirstOrThrow({
      where: { internalListingId: snapshot.record.internalListingId, sourceRecordVersion: "1" },
    });
    expect(v1.retailPriceMinorUnits).toBeNull();
  });
});

describe.skipIf(!RUN)("Phase 1.34 Ruling C — one current Listing per Product + Storefront", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("6. the marker is derived from the lifecycle, and only terminal states release the pair", () => {
    /* Not a hand-written list: driven by 0M.4A's own terminal predicate, so a
       lifecycle state that gains or loses an exit changes this automatically. */
    const byState = Object.fromEntries(
      LISTING_LIFECYCLE_STATES.map((s) => [s, currentPlacementMarkerFor(s)]),
    );
    expect(byState).toEqual({
      DRAFT: CURRENT_PLACEMENT_MARKER,
      ACTIVE: CURRENT_PLACEMENT_MARKER,
      SUSPENDED: CURRENT_PLACEMENT_MARKER,
      ENDED: null,
      WITHDRAWN: null,
    });
  });

  it("7. accepts the FIRST current placement for a Product + Storefront pair", async () => {
    const scene = await seedSellerScene();
    const snapshot = await placeSellerDirect(scene, { retail });

    const row = await db.listing.findUniqueOrThrow({
      where: { internalListingId: snapshot.record.internalListingId },
    });
    expect(row.currentPlacementMarker).toBe(CURRENT_PLACEMENT_MARKER);
  });

  it("8. refuses a SECOND current placement for the same pair, minting nothing", async () => {
    const scene = await seedSellerScene();
    await placeSellerDirect(scene, { retail });

    await expect(placeSellerDirect(scene, { retail })).rejects.toBeInstanceOf(
      ListingAlreadyExistsError,
    );

    /* One Listing, one version. The refusal is not a rollback of a partial
       write — nothing was written. */
    expect(
      await db.listing.count({
        where: {
          internalProductId: scene.internalProductId,
          storefrontId: scene.storefrontId,
        },
      }),
    ).toBe(1);
    expect(
      await db.listingSourceRecordVersionRow.count({
        where: { internalProductId: scene.internalProductId },
      }),
    ).toBe(1);
  });

  it("8a. carries no identifier in the refusal", async () => {
    const scene = await seedSellerScene();
    await placeSellerDirect(scene, { retail });
    const error = await placeSellerDirect(scene, { retail }).catch((e: unknown) => e);

    /* Who already holds the pair is not a fact a refused caller is owed, and a
       raw database message must never reach a client. */
    const serialized = JSON.stringify(error);
    expect(serialized).not.toMatch(/mon:listing:/);
    expect(serialized).not.toMatch(/Duplicate entry|Unique constraint/i);
    expect((error as { code: string }).code).toBe("LISTING_ALREADY_EXISTS");
  });

  it("9. accepts the same Product in a DIFFERENT Storefront", async () => {
    const scene = await seedSellerScene();
    await placeSellerDirect(scene, { retail });

    const second = await seedStorefront(scene.seller.participantId);
    const ok = await placeSellerDirect({ ...scene, storefrontId: second }, { retail });
    expect(ok.currentVersion.storefrontId).toBe(second);
    /* §4 of the assortment rules: a Product may appear in any number of
       eligible Storefronts. There is no exclusive-placement state. */
    expect(await db.listing.count({ where: { internalProductId: scene.internalProductId } })).toBe(2);
  });

  it("10. accepts a DIFFERENT Product in the same Storefront", async () => {
    const scene = await seedSellerScene();
    await placeSellerDirect(scene, { retail });

    const other = await seedProduct(scene.seller.participantId);
    const ok = await placeSellerDirect({ ...scene, internalProductId: other }, { retail });
    expect(ok.currentVersion.internalProductId).toBe(other);
    expect(await db.listing.count({ where: { storefrontId: scene.storefrontId } })).toBe(2);
  });

  it("11. treats many immutable source VERSIONS of one Listing as one placement", async () => {
    const scene = await seedSellerScene();
    const snapshot = await placeSellerDirect(scene, { retail });

    for (const [version, amount] of [["2", 11_000], ["3", 12_000]] as const) {
      await createListingSourceVersion(
        {
          internalListingId: snapshot.record.internalListingId,
          sourceRecordVersion: version,
          retail: { retailPriceMinorUnits: amount, retailPriceCurrency: "USD" },
          actingAccountId: scene.seller.accountId,
          now: LATER,
        },
        { db },
      );
    }

    /* Three versions, one aggregate, one marker. History is not duplication. */
    expect(
      await db.listingSourceRecordVersionRow.count({
        where: { internalListingId: snapshot.record.internalListingId },
      }),
    ).toBe(3);
    expect(
      await db.listing.count({
        where: {
          internalProductId: scene.internalProductId,
          storefrontId: scene.storefrontId,
          currentPlacementMarker: CURRENT_PLACEMENT_MARKER,
        },
      }),
    ).toBe(1);
  });

  it("12. releases the pair when a TERMINAL lifecycle state is reached, and not before", async () => {
    const scene = await seedSellerScene();
    const snapshot = await placeSellerDirect(scene, { retail });

    await createListingSourceVersion(
      {
        internalListingId: snapshot.record.internalListingId,
        sourceRecordVersion: "2",
        lifecycle: "WITHDRAWN",
        actingAccountId: scene.seller.accountId,
        now: LATER,
      },
      { db },
    );

    const released = await db.listing.findUniqueOrThrow({
      where: { internalListingId: snapshot.record.internalListingId },
    });
    /* The marker cleared ATOMICALLY with the lifecycle, in the same statement. */
    expect(released.lifecycle).toBe("WITHDRAWN");
    expect(released.currentPlacementMarker).toBeNull();

    /* The seller may place the Product in that Storefront again — and the
       withdrawn placement's immutable history survives beside it. */
    const replacement = await placeSellerDirect(scene, { retail });
    expect(replacement.record.internalListingId).not.toBe(snapshot.record.internalListingId);
    expect(await db.listing.count({ where: { storefrontId: scene.storefrontId } })).toBe(2);
    expect(
      await db.listing.count({
        where: { storefrontId: scene.storefrontId, currentPlacementMarker: CURRENT_PLACEMENT_MARKER },
      }),
    ).toBe(1);
  });

  it("13. applies the invariant across BRANCHES — a promoter cannot double-place the pair", async () => {
    /* Placement uniqueness is a property of the shelf, not of who put the item
       on it. A promoted Listing and a seller-direct one are the same placement
       question for the same Product in the same Storefront. */
    const seller = await seedParticipant(["SELLER"]);
    const promoter = await seedParticipant(["SELLER", "PROMOTER"]);
    const internalProductId = await seedProduct(seller.participantId);
    const storefrontId = await seedStorefront(promoter.participantId);
    const offer = await createDraftOffer(
      {
        internalProductId,
        sellerParticipantId: seller.participantId,
        terms: {
          price: { type: "PAID", wholesalePriceMinorUnits: 5_000, wholesalePriceCurrency: "USD" },
          promotion: {
            type: "PROMOTABLE",
            commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2_000 },
          },
        },
        actingAccountId: seller.accountId,
        now: NOW,
      },
      { db },
    );

    const promoted = () =>
      createPromotedListing(
        {
          storefrontId,
          internalProductId,
          controllingParticipantId: promoter.participantId,
          retail: { retailPriceMinorUnits: 12_500, retailPriceCurrency: "USD" },
          acceptedOfferSourceRecordId: offer.record.offerSourceRecordId,
          acceptedOfferSourceRecordVersion: "1",
          acquisitionPolicy: ACQUISITION_POLICY,
          actingAccountId: promoter.accountId,
          now: NOW,
        },
        { db },
      );

    await promoted();
    await expect(promoted()).rejects.toBeInstanceOf(ListingAlreadyExistsError);
    expect(await db.listing.count({ where: { internalProductId, storefrontId } })).toBe(1);
  });

  it("12a. answers an UNAUTHORIZED caller with authority, never with the duplicate", async () => {
    /* Whether a Storefront already carries a placement of a Product is a fact
       about someone's assortment. Answering `LISTING_ALREADY_EXISTS` to a caller
       who may not place there would turn the duplicate refusal into a probe for
       a competitor's shelf — so the duplicate check is asked LAST, after every
       authority and standing decision. */
    const scene = await seedSellerScene();
    await placeSellerDirect(scene, { retail });

    const outsider = await seedParticipant(["SELLER"]);
    const refusal = await createSellerDirectListing(
      {
        storefrontId: scene.storefrontId,
        internalProductId: scene.internalProductId,
        controllingParticipantId: outsider.participantId,
        retail,
        actingAccountId: outsider.accountId,
        now: NOW,
      },
      { db },
    ).catch((e: unknown) => e);

    expect(refusal).not.toBeInstanceOf(ListingAlreadyExistsError);
    expect((refusal as { code: string }).code).toBe("LISTING_NOT_AUTHORIZED");
  });

  it("13a. refuses a second current row at the DATABASE, with the application bypassed", async () => {
    /* The application check exists to give a caller a bounded semantic answer;
       it is NOT the guarantee. This proves the guarantee itself, by inserting
       straight into the table — the only honest way to show that a code path
       nobody has written yet could not create a duplicate either. */
    const scene = await seedSellerScene();
    const first = await placeSellerDirect(scene, { retail });

    seq += 1;
    await expect(
      db.listing.create({
        data: {
          listingRef: syntheticListingRef(),
          internalListingId: `mon:listing:${pad26(`P134DUPE${seq}`)}`,
          listingSourceRecordId: `mon:srec:${pad26(`P134DUPESREC${seq}`)}`,
          currentSourceRecordVersion: "1",
          listingType: "SELLER_DIRECT",
          internalProductId: scene.internalProductId,
          storefrontId: scene.storefrontId,
          controllingParticipantId: scene.seller.participantId,
          lifecycle: "DRAFT",
          currentPlacementMarker: CURRENT_PLACEMENT_MARKER,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    /* A row carrying NO marker is fine for the same pair — that is a released
       placement, and any number of them may exist. */
    seq += 1;
    const released = await db.listing.create({
      data: {
        listingRef: syntheticListingRef(),
        internalListingId: `mon:listing:${pad26(`P134REL${seq}`)}`,
        listingSourceRecordId: `mon:srec:${pad26(`P134RELSREC${seq}`)}`,
        currentSourceRecordVersion: "1",
        listingType: "SELLER_DIRECT",
        internalProductId: scene.internalProductId,
        storefrontId: scene.storefrontId,
        controllingParticipantId: scene.seller.participantId,
        lifecycle: "WITHDRAWN",
        currentPlacementMarker: null,
      },
    });
    expect(released.currentPlacementMarker).toBeNull();
    expect(
      await db.listing.count({
        where: {
          internalProductId: scene.internalProductId,
          storefrontId: scene.storefrontId,
          currentPlacementMarker: CURRENT_PLACEMENT_MARKER,
        },
      }),
    ).toBe(1);
    expect(first.record.internalListingId).toMatch(/^mon:listing:/);
  });

  it("14. leaves exactly one current Listing when two callers race the same pair", async () => {
    const scene = await seedSellerScene();

    /* The application check and the insert are in one transaction, but two
       transactions can both pass the check before either commits — which is
       exactly why the unique index exists. Whichever loses must receive the SAME
       bounded domain answer as a caller who simply asked second, never a raw
       database error and never a generic failure. */
    const results = await Promise.allSettled([
      placeSellerDirect(scene, { retail }),
      placeSellerDirect(scene, { retail }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ListingAlreadyExistsError);

    const rows = await db.listing.findMany({
      where: {
        internalProductId: scene.internalProductId,
        storefrontId: scene.storefrontId,
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.currentPlacementMarker).toBe(CURRENT_PLACEMENT_MARKER);
    /* And no orphaned version from the loser. */
    expect(
      await db.listingSourceRecordVersionRow.count({
        where: { internalProductId: scene.internalProductId },
      }),
    ).toBe(1);
  });
});
