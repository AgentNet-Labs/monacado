/**
 * Listing persistence integration tests (Phase 0M.7).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * NO NETWORK. Instants and identities are injected, so nothing depends on a real
 * clock. Every value is synthetic; no real personal data appears.
 *
 * TEST ISOLATION IS DELIBERATE AND SCOPED. 0M.6 exposed why a global
 * `product.deleteMany({})` is unsafe: other suites' Products are referenced by
 * their Nodes, publications, and outbox rows, so a blanket delete hits the very
 * RESTRICT rules these phases rely on. Every fixture here carries a `M7`-tagged
 * identity or an `listing-ctl` email prefix, and cleanup matches on the prefix.
 *
 * The tests that matter most are the exact-Offer-binding ones and the round-trip
 * ones: a promoted Listing must stay bound to the version it accepted even after
 * the Offer advances, and a persisted source version must produce a capsule
 * byte-identical to the equivalent canonical in-memory source.
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
  evaluateBuyerEligibility,
  getCurrentSourceVersion,
  getEffectivePrice,
  getListing,
  getSourceVersion,
  listSourceVersions,
} from "../src/server/marketplace/listing-service";
import {
  AcceptedOfferVersionNotFoundError,
  ControllerParticipantNotFoundError,
  CorruptListingRecordError,
  DuplicateListingSourceVersionError,
  InvalidListingInputError,
  ListingEconomicsRefusedError,
  ListingNotAuthorizedError,
  ListingNotFoundError,
  ListingProductNotFoundError,
  ListingStorefrontNotFoundError,
  ListingVersionNotFoundError,
  NoMaterialListingChangeError,
  OfferProductMismatchError,
} from "../src/server/marketplace/listing-errors";
import { LISTING_ID_PATTERNS } from "../src/server/marketplace/listing-ids";
import { versionRowToSourceVersion } from "../src/server/marketplace/listing-mapper";
import {
  ListingSourceVersion,
  minimumViablePromotedRetailPrice,
} from "../src/contracts/marketplace/listing-source";
import {
  LISTING_PROJECTION_MAPPING_VERSION,
  SUPPORTED_LISTING_CAPSULE_VERSION,
  listingSourceRecordToCapsuleProjection,
} from "../src/contracts/marketplace/listing.projection";
import { canonicalJsonString } from "../src/contracts/integrity/canonical-json";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2027-11-01T09:00:00.000Z";
const LATER = "2027-11-02T09:00:00.000Z";
const PASSWORD = "correct-horse-battery-staple-9271";

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

/* Crockford alphabet excludes I, L, O and U, so tags use zeros for O. */
const PRODUCT_TAG = "M7PR0D";
const PRODUCT_PREFIX = `mon:product:${PRODUCT_TAG}`;
const ACCOUNT_EMAIL_PREFIX = "listing-ctl";

let seq = 0;
const ACTOR = `mon:actor:${pad26("M7ACT0R")}`;

const ACQUISITION_POLICY = {
  policyId: "mon:policy:acquisition/synthetic",
  policyVersion: "1",
  currency: "USD",
  /* Synthetic, and deliberately NOT Monacado's real numbers: the policy is a
     supplied input, and a real rate compiled into a test would be the same
     mistake as compiling one into the contract. */
  retainedPercentageBasisPoints: 750,
  retainedFixedAmountMinorUnits: 100,
  roundingPolicy: "HALF_UP_TO_MINOR_UNIT" as const,
};

const safeStringify = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

/**
 * Remove only what THIS suite creates.
 *
 * Scoped, never a global truncate — see the file header. Children before
 * parents, which documents the delete rules.
 */
async function cleanup(): Promise<void> {
  await db.listingSourceRecordVersionRow.deleteMany({});
  await db.listing.deleteMany({});
  await db.offerSourceRecordVersionRow.deleteMany({});
  await db.offer.deleteMany({});

  const accounts = await db.account.findMany({
    where: { email: { startsWith: ACCOUNT_EMAIL_PREFIX } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length > 0) {
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
      await db.participantActivation.deleteMany({
        where: { participantId: { in: participantIds } },
      });
      await db.participantProfile.deleteMany({
        where: { participantId: { in: participantIds } },
      });
      await db.marketplaceRoleAssignment.deleteMany({
        where: { participantId: { in: participantIds } },
      });
      await db.marketplaceParticipant.deleteMany({ where: { id: { in: participantIds } } });
    }
    await db.accountEntitlement.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.account.deleteMany({ where: { id: { in: accountIds } } });
  }

  await db.product.deleteMany({ where: { internalProductId: { startsWith: PRODUCT_PREFIX } } });
}

async function seedProduct(): Promise<string> {
  seq += 1;
  const internalProductId = `${PRODUCT_PREFIX}${pad26(String(seq)).slice(
    0,
    26 - PRODUCT_TAG.length,
  )}`;
  await db.product.create({
    data: {
      internalProductId,
      sourceRecordId: `mon:srec:${pad26(`M7PSREC${seq}`)}`,
      currentSourceRecordVersion: "1",
      recordStatus: "DRAFT",
    },
  });
  return internalProductId;
}

/** A participant holding the named roles, able to draft. */
async function seedParticipant(
  roles: Array<"SELLER" | "PROMOTER">,
): Promise<{ participantId: string; accountId: string }> {
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
  const internalStorefrontId = `mon:storefront:${pad26(`M7ST0RE${seq}`)}`;
  await db.storefront.create({
    data: {
      internalStorefrontId,
      storefrontSourceRecordId: `mon:srec:${pad26(`M7SFSREC${seq}`)}`,
      currentSourceRecordVersion: "1",
      ownerParticipantId,
      publicHandle: `m7-synthetic-shop-${seq}`,
      lifecycle: "DRAFT",
      visibility: "PRIVATE",
    },
  });
  return internalStorefrontId;
}

const retail = { retailPriceMinorUnits: 10_000, retailPriceCurrency: "USD" };

const sale = {
  salePriceMinorUnits: 8_000,
  salePriceCurrency: "USD",
  saleStartsAt: "2027-12-01T00:00:00.000Z",
  saleEndsAt: "2027-12-08T00:00:00.000Z",
};

/** A seller-direct Listing with its Product, Storefront, and seller. */
async function seedSellerDirect(overrides: Record<string, unknown> = {}) {
  const seller = await seedParticipant(["SELLER"]);
  const internalProductId = await seedProduct();
  const storefrontId = await seedStorefront(seller.participantId);
  const snapshot = await createSellerDirectListing(
    {
      storefrontId,
      internalProductId,
      controllingParticipantId: seller.participantId,
      retail,
      actingAccountId: seller.accountId,
      authorizedByActorId: ACTOR,
      now: NOW,
      ...overrides,
    },
    { db },
  );
  return { seller, internalProductId, storefrontId, snapshot };
}

/** An Offer to promote, created through 0M.6's own service. */
async function seedOffer(internalProductId: string, sellerAccountId: string, sellerId: string) {
  return createDraftOffer(
    {
      internalProductId,
      sellerParticipantId: sellerId,
      terms: {
        price: { type: "PAID", wholesalePriceMinorUnits: 5_000, wholesalePriceCurrency: "USD" },
        promotion: {
          type: "PROMOTABLE",
          commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2_000 },
        },
      },
      actingAccountId: sellerAccountId,
      authorizedByActorId: ACTOR,
      hasProductAuthority: true,
      now: NOW,
    },
    { db },
  );
}

/** A promoted Listing bound to an exact Offer version. */
async function seedPromoted(overrides: Record<string, unknown> = {}) {
  const seller = await seedParticipant(["SELLER"]);
  const promoter = await seedParticipant(["PROMOTER"]);
  const internalProductId = await seedProduct();
  const storefrontId = await seedStorefront(promoter.participantId);
  const offer = await seedOffer(internalProductId, seller.accountId, seller.participantId);

  const snapshot = await createPromotedListing(
    {
      storefrontId,
      internalProductId,
      controllingParticipantId: promoter.participantId,
      retail: { retailPriceMinorUnits: 12_500, retailPriceCurrency: "USD" },
      acceptedOfferSourceRecordId: offer.record.offerSourceRecordId,
      acceptedOfferSourceRecordVersion: "1",
      acquisitionPolicy: ACQUISITION_POLICY,
      actingAccountId: promoter.accountId,
      authorizedByActorId: ACTOR,
      now: NOW,
      ...overrides,
    },
    { db },
  );
  return { seller, promoter, internalProductId, storefrontId, offer, snapshot };
}

/** A synthetic projection context. Node identities are TEST-ONLY. */
function projectionContext(v: ListingSourceVersion, overrides: Record<string, unknown> = {}) {
  return {
    listingBinding: {
      listingNode: `an:node:${pad26("M7N0DELSTNG")}`,
      internalListingId: v.internalListingId,
    },
    productBinding: {
      productNode: `an:node:${pad26("M7N0DEPR0D")}`,
      internalProductId: v.internalProductId,
    },
    storefrontBinding: {
      storefrontNode: `an:node:${pad26("M7N0DEST0RE")}`,
      storefrontId: v.storefrontId,
    },
    controllerBinding: {
      controllerAuthorityNode: `an:node:${pad26("M7N0DEAUTH")}`,
      controllingParticipantId: v.controllingParticipantId,
    },
    sourceVersionBinding: {
      listingSourceRecordId: v.listingSourceRecordId,
      sourceRecordVersion: v.sourceRecordVersion,
    },
    upstream: {
      productAvailability: "available" as const,
      storefrontLifecycle: "ACTIVE" as const,
      storefrontVisibility: "PUBLIC" as const,
      storefrontGoLiveApproval: "APPROVED" as const,
      controllingParticipantStatus: "ACTIVE" as const,
      controllingRoleStatus: "ACTIVE" as const,
      offerLifecycle: "ACTIVE" as const,
      offerAvailability: "AVAILABLE" as const,
    },
    capsuleId: `an:capsule:${pad26("M7CAPSULE")}`,
    capsuleVersion: SUPPORTED_LISTING_CAPSULE_VERSION,
    mappingVersion: LISTING_PROJECTION_MAPPING_VERSION,
    generatedAt: LATER,
    nodePolicy: { ref: "mon:policy:node/listing/v1", version: "1.0.0" },
    capsulePolicy: { ref: "mon:policy:capsule/listing/v1", version: "1.0.0" },
    ...overrides,
  };
}

/** Force a Listing ACTIVE at the row level — the state a later phase produces. */
async function forceActive(internalListingId: string): Promise<void> {
  await db.listingSourceRecordVersionRow.updateMany({
    where: { internalListingId },
    data: { lifecycle: "ACTIVE" },
  });
  await db.listing.update({ where: { internalListingId }, data: { lifecycle: "ACTIVE" } });
}

const describeDb = RUN ? describe : describe.skip;

describeDb("Listing persistence (Phase 0M.7)", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  // — Creation, identity, first version —

  it("1. creates a SELLER_DIRECT Listing and its first immutable version", async () => {
    const { snapshot } = await seedSellerDirect();
    expect(snapshot.record.internalListingId).toMatch(LISTING_ID_PATTERNS.listing);
    expect(snapshot.record.listingSourceRecordId).toMatch(LISTING_ID_PATTERNS.sourceRecord);
    expect(snapshot.currentVersion.placement.listingType).toBe("SELLER_DIRECT");
    expect(snapshot.currentVersion.sourceRecordVersion).toBe("1");
    expect(snapshot.currentVersion.supersedesSourceRecordVersion).toBeNull();
    expect(snapshot.record.lifecycle).toBe("DRAFT");
  });

  it("2. creates a PROMOTED Listing bound to an exact Offer version", async () => {
    const { snapshot, offer } = await seedPromoted();
    const placement = snapshot.currentVersion.placement;
    expect(placement.listingType).toBe("PROMOTED");
    if (placement.listingType !== "PROMOTED") throw new Error("unreachable");
    expect(placement.offerDependency.acceptedOfferSourceRecordVersion).toBe("1");
    expect(placement.offerDependency.offerSourceRecordId).toBe(
      offer.record.offerSourceRecordId,
    );
    /* The accepted economics come FROM the persisted Offer version. */
    expect(placement.offerDependency.acceptedWholesalePriceMinorUnits).toBe(5_000);
    expect(placement.offerDependency.acceptedWholesalePriceCurrency).toBe("USD");
  });

  it("3. stable Listing identity persists and is readable back", async () => {
    const { snapshot } = await seedSellerDirect();
    const reread = await getListing(snapshot.record.internalListingId, { db });
    expect(reread.record.internalListingId).toBe(snapshot.record.internalListingId);
    expect(reread.record.listingSourceRecordId).toBe(snapshot.record.listingSourceRecordId);
  });

  it("4. the stable Listing points at its current version", async () => {
    const { snapshot } = await seedSellerDirect();
    const row = await db.listing.findUnique({
      where: { internalListingId: snapshot.record.internalListingId },
    });
    const versions = await db.listingSourceRecordVersionRow.findMany({
      where: { internalListingId: snapshot.record.internalListingId },
    });
    expect(versions).toHaveLength(1);
    expect(row?.currentSourceRecordVersion).toBe(versions[0]!.sourceRecordVersion);
  });

  // — References —

  it("5. refuses a Listing naming a Product that does not exist", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const storefrontId = await seedStorefront(seller.participantId);
    await expect(
      createSellerDirectListing(
        {
          storefrontId,
          internalProductId: `mon:product:${pad26("M7MISSING")}`,
          controllingParticipantId: seller.participantId,
          retail,
          actingAccountId: seller.accountId,
          authorizedByActorId: ACTOR,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(ListingProductNotFoundError);
  });

  it("6. refuses a Listing naming a Storefront that does not exist", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const internalProductId = await seedProduct();
    await expect(
      createSellerDirectListing(
        {
          storefrontId: `mon:storefront:${pad26("M7N0SUCH")}`,
          internalProductId,
          controllingParticipantId: seller.participantId,
          retail,
          actingAccountId: seller.accountId,
          authorizedByActorId: ACTOR,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(ListingStorefrontNotFoundError);
  });

  it("7. refuses a Listing whose controlling participant does not exist", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const internalProductId = await seedProduct();
    const storefrontId = await seedStorefront(seller.participantId);
    await expect(
      createSellerDirectListing(
        {
          storefrontId,
          internalProductId,
          controllingParticipantId: `mon:mpart:${pad26("M7N0B0DY")}`,
          retail,
          actingAccountId: seller.accountId,
          authorizedByActorId: ACTOR,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(ControllerParticipantNotFoundError);
  });

  // — Versioning —

  it("8. a material update mints a new version and leaves the prior one untouched", async () => {
    const { snapshot, seller } = await seedSellerDirect();
    const before = await db.listingSourceRecordVersionRow.findFirst({
      where: { internalListingId: snapshot.record.internalListingId, sourceRecordVersion: "1" },
    });

    await createListingSourceVersion(
      {
        internalListingId: snapshot.record.internalListingId,
        sourceRecordVersion: "2",
        retail: { retailPriceMinorUnits: 11_000, retailPriceCurrency: "USD" },
        actingAccountId: seller.accountId,
        authorizedByActorId: ACTOR,
        now: LATER,
      },
      { db },
    );

    const after = await db.listingSourceRecordVersionRow.findFirst({
      where: { internalListingId: snapshot.record.internalListingId, sourceRecordVersion: "1" },
    });
    expect(safeStringify(after)).toBe(safeStringify(before));
    expect(after!.retailPriceMinorUnits).toBe(10_000n);
  });

  it("9. the current-version pointer advances atomically with the new version", async () => {
    const { snapshot, seller } = await seedSellerDirect();
    await createListingSourceVersion(
      {
        internalListingId: snapshot.record.internalListingId,
        sourceRecordVersion: "2",
        lifecycle: "WITHDRAWN",
        actingAccountId: seller.accountId,
        authorizedByActorId: ACTOR,
        now: LATER,
      },
      { db },
    );
    const row = await db.listing.findUnique({
      where: { internalListingId: snapshot.record.internalListingId },
    });
    expect(row?.currentSourceRecordVersion).toBe("2");
    expect(row?.lifecycle).toBe("WITHDRAWN");
  });

  it("10. an exact historical version is retrievable by name, never as 'the latest'", async () => {
    const { snapshot, seller } = await seedSellerDirect();
    await createListingSourceVersion(
      {
        internalListingId: snapshot.record.internalListingId,
        sourceRecordVersion: "2",
        retail: { retailPriceMinorUnits: 11_000, retailPriceCurrency: "USD" },
        actingAccountId: seller.accountId,
        authorizedByActorId: ACTOR,
        now: LATER,
      },
      { db },
    );

    const v1 = await getSourceVersion(snapshot.record.internalListingId, "1", { db });
    expect(v1.placement.retail.retailPriceMinorUnits).toBe(10_000);
    const current = await getCurrentSourceVersion(snapshot.record.internalListingId, { db });
    expect(current.placement.retail.retailPriceMinorUnits).toBe(11_000);

    const versions = await listSourceVersions(snapshot.record.internalListingId, { db });
    expect(versions.map((v) => v.sourceRecordVersion)).toEqual(["1", "2"]);
    expect(versions[1]!.supersedesSourceRecordVersion).toBe("1");
  });

  it("11. refuses an unknown version rather than falling back to the current one", async () => {
    const { snapshot } = await seedSellerDirect();
    await expect(
      getSourceVersion(snapshot.record.internalListingId, "999", { db }),
    ).rejects.toBeInstanceOf(ListingVersionNotFoundError);
  });

  it("12. refuses a duplicate version label — a label mints once", async () => {
    const { snapshot, seller } = await seedSellerDirect();
    await expect(
      createListingSourceVersion(
        {
          internalListingId: snapshot.record.internalListingId,
          sourceRecordVersion: "1",
          lifecycle: "WITHDRAWN",
          actingAccountId: seller.accountId,
          authorizedByActorId: ACTOR,
          now: LATER,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(DuplicateListingSourceVersionError);
  });

  it("13. an update changing nothing material mints no version", async () => {
    const { snapshot, seller } = await seedSellerDirect();
    await expect(
      createListingSourceVersion(
        {
          internalListingId: snapshot.record.internalListingId,
          sourceRecordVersion: "2",
          retail,
          actingAccountId: seller.accountId,
          authorizedByActorId: ACTOR,
          now: LATER,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(NoMaterialListingChangeError);
    expect(
      await db.listingSourceRecordVersionRow.count({
        where: { internalListingId: snapshot.record.internalListingId },
      }),
    ).toBe(1);
  });

  // — SELLER_DIRECT price and sale schedule —

  it("14. round-trips the ordinary retail price and currency exactly", async () => {
    const { snapshot } = await seedSellerDirect();
    expect(snapshot.currentVersion.placement.retail).toEqual({
      retailPriceMinorUnits: 10_000,
      retailPriceCurrency: "USD",
    });
  });

  it("15. round-trips a scheduled sale exactly, all four fields", async () => {
    const { snapshot } = await seedSellerDirect({ sale });
    const placement = snapshot.currentVersion.placement;
    if (placement.listingType !== "SELLER_DIRECT") throw new Error("unreachable");
    expect(placement.sale).toEqual(sale);
  });

  it("16. refuses a sale in a different currency than ordinary retail", async () => {
    await expect(
      seedSellerDirect({ sale: { ...sale, salePriceCurrency: "EUR" } }),
    ).rejects.toBeInstanceOf(InvalidListingInputError);
  });

  it("17. refuses a sale priced at or above ordinary retail", async () => {
    await expect(
      seedSellerDirect({ sale: { ...sale, salePriceMinorUnits: 10_000 } }),
    ).rejects.toBeInstanceOf(InvalidListingInputError);
  });

  it("18. refuses a sale whose end is not after its start", async () => {
    await expect(
      seedSellerDirect({ sale: { ...sale, saleEndsAt: sale.saleStartsAt } }),
    ).rejects.toBeInstanceOf(InvalidListingInputError);
  });

  // — Time semantics —

  it("19. effective price is ordinary before the window, sale inside, ordinary at the end", async () => {
    const { snapshot } = await seedSellerDirect({ sale });
    const id = snapshot.record.internalListingId;

    expect(await getEffectivePrice(id, "2027-11-30T23:59:59.999Z", { db })).toEqual({
      effectivePriceMinorUnits: 10_000,
      currency: "USD",
      saleActive: false,
    });
    /* Start INCLUSIVE. */
    expect(await getEffectivePrice(id, "2027-12-01T00:00:00.000Z", { db })).toEqual({
      effectivePriceMinorUnits: 8_000,
      currency: "USD",
      saleActive: true,
    });
    /* End EXCLUSIVE — two consecutive sales cannot both be active. */
    expect(await getEffectivePrice(id, "2027-12-08T00:00:00.000Z", { db })).toEqual({
      effectivePriceMinorUnits: 10_000,
      currency: "USD",
      saleActive: false,
    });
  });

  it("20. crossing a sale boundary mutates nothing and mints no version", async () => {
    /* The whole reason no effective price is stored. */
    const { snapshot } = await seedSellerDirect({ sale });
    const id = snapshot.record.internalListingId;
    const before = await db.listingSourceRecordVersionRow.findMany({
      where: { internalListingId: id },
    });
    const stableBefore = await db.listing.findUnique({ where: { internalListingId: id } });

    for (const instant of [
      "2027-11-30T23:59:59.999Z",
      "2027-12-01T00:00:00.000Z",
      "2027-12-04T12:00:00.000Z",
      "2027-12-08T00:00:00.000Z",
    ]) {
      await getEffectivePrice(id, instant, { db });
    }

    const after = await db.listingSourceRecordVersionRow.findMany({
      where: { internalListingId: id },
    });
    const stableAfter = await db.listing.findUnique({ where: { internalListingId: id } });
    expect(safeStringify(after)).toBe(safeStringify(before));
    expect(safeStringify(stableAfter)).toBe(safeStringify(stableBefore));
    expect(after).toHaveLength(1);
  });

  // — PROMOTED: the exact Offer binding —

  it("21. round-trips the promoter's retail price exactly", async () => {
    const { snapshot } = await seedPromoted();
    expect(snapshot.currentVersion.placement.retail).toEqual({
      retailPriceMinorUnits: 12_500,
      retailPriceCurrency: "USD",
    });
  });

  it("22. refuses a promoted Listing naming an Offer version that does not exist", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const promoter = await seedParticipant(["PROMOTER"]);
    const internalProductId = await seedProduct();
    const storefrontId = await seedStorefront(promoter.participantId);
    const offer = await seedOffer(internalProductId, seller.accountId, seller.participantId);

    await expect(
      createPromotedListing(
        {
          storefrontId,
          internalProductId,
          controllingParticipantId: promoter.participantId,
          retail: { retailPriceMinorUnits: 12_500, retailPriceCurrency: "USD" },
          acceptedOfferSourceRecordId: offer.record.offerSourceRecordId,
          acceptedOfferSourceRecordVersion: "999",
          acquisitionPolicy: ACQUISITION_POLICY,
          actingAccountId: promoter.accountId,
          authorizedByActorId: ACTOR,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(AcceptedOfferVersionNotFoundError);
  });

  it("23. refuses an Offer that is for a different Product", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const promoter = await seedParticipant(["PROMOTER"]);
    const productA = await seedProduct();
    const productB = await seedProduct();
    const storefrontId = await seedStorefront(promoter.participantId);
    const offer = await seedOffer(productA, seller.accountId, seller.participantId);

    await expect(
      createPromotedListing(
        {
          storefrontId,
          /* The Listing places product B; the Offer is for product A. */
          internalProductId: productB,
          controllingParticipantId: promoter.participantId,
          retail: { retailPriceMinorUnits: 12_500, retailPriceCurrency: "USD" },
          acceptedOfferSourceRecordId: offer.record.offerSourceRecordId,
          acceptedOfferSourceRecordVersion: "1",
          acquisitionPolicy: ACQUISITION_POLICY,
          actingAccountId: promoter.accountId,
          authorizedByActorId: ACTOR,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(OfferProductMismatchError);
  });

  it("24. stays bound to the accepted version after the Offer advances", async () => {
    /* THE CENTRAL REQUIREMENT. A promoter agreed to a number; a new number is a
       new agreement, and the Listing must not follow the Offer's pointer. */
    const { snapshot, offer, seller } = await seedPromoted();

    const { createOfferSourceVersion } = await import(
      "../src/server/marketplace/offer-service"
    );
    await createOfferSourceVersion(
      {
        internalOfferId: offer.record.internalOfferId,
        sourceRecordVersion: "2",
        terms: {
          price: { type: "PAID", wholesalePriceMinorUnits: 9_000, wholesalePriceCurrency: "USD" },
          promotion: {
            type: "PROMOTABLE",
            commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2_000 },
          },
        },
        actingAccountId: seller.accountId,
        authorizedByActorId: ACTOR,
        hasProductAuthority: true,
        now: LATER,
      },
      { db },
    );

    /* The Offer moved on... */
    const offerRow = await db.offer.findUnique({
      where: { internalOfferId: offer.record.internalOfferId },
    });
    expect(offerRow?.currentSourceRecordVersion).toBe("2");

    /* ...and the Listing did not. */
    const reread = await getCurrentSourceVersion(snapshot.record.internalListingId, { db });
    const placement = reread.placement;
    if (placement.listingType !== "PROMOTED") throw new Error("unreachable");
    expect(placement.offerDependency.acceptedOfferSourceRecordVersion).toBe("1");
    expect(placement.offerDependency.acceptedWholesalePriceMinorUnits).toBe(5_000);
  });

  it("25. an explicit update may bind a newer Offer version", async () => {
    const { snapshot, offer, seller, promoter } = await seedPromoted();
    const { createOfferSourceVersion } = await import(
      "../src/server/marketplace/offer-service"
    );
    await createOfferSourceVersion(
      {
        internalOfferId: offer.record.internalOfferId,
        sourceRecordVersion: "2",
        terms: {
          price: { type: "PAID", wholesalePriceMinorUnits: 6_000, wholesalePriceCurrency: "USD" },
          promotion: {
            type: "PROMOTABLE",
            commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2_000 },
          },
        },
        actingAccountId: seller.accountId,
        authorizedByActorId: ACTOR,
        hasProductAuthority: true,
        now: LATER,
      },
      { db },
    );

    const updated = await createListingSourceVersion(
      {
        internalListingId: snapshot.record.internalListingId,
        sourceRecordVersion: "2",
        acceptedOfferSourceRecordVersion: "2",
        acquisitionPolicy: ACQUISITION_POLICY,
        actingAccountId: promoter.accountId,
        authorizedByActorId: ACTOR,
        now: LATER,
      },
      { db },
    );

    const placement = updated.currentVersion.placement;
    if (placement.listingType !== "PROMOTED") throw new Error("unreachable");
    expect(placement.offerDependency.acceptedOfferSourceRecordVersion).toBe("2");
    expect(placement.offerDependency.acceptedWholesalePriceMinorUnits).toBe(6_000);

    /* And version 1 still records what was originally accepted. */
    const v1 = await getSourceVersion(snapshot.record.internalListingId, "1", { db });
    const p1 = v1.placement;
    if (p1.listingType !== "PROMOTED") throw new Error("unreachable");
    expect(p1.offerDependency.acceptedWholesalePriceMinorUnits).toBe(5_000);
  });

  it("26. the database itself refuses a row naming a nonexistent Offer version", async () => {
    /* The composite FK makes the binding structural, not merely procedural. */
    const { snapshot } = await seedPromoted();
    const row = await db.listingSourceRecordVersionRow.findFirst({
      where: { internalListingId: snapshot.record.internalListingId },
    });
    await expect(
      db.listingSourceRecordVersionRow.update({
        where: { seq: row!.seq },
        data: { acceptedOfferSourceRecordVersion: "does-not-exist" },
      }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  // — Economics boundary —

  it("27. copies no wholesale, commission, or MoR economics into Listing columns", async () => {
    const { snapshot } = await seedPromoted();
    const row = await db.listingSourceRecordVersionRow.findFirst({
      where: { internalListingId: snapshot.record.internalListingId },
    });
    /* The accepted wholesale price IS a member of 0M.4A's AcceptedOfferDependency
       — it is what the promoter agreed to. What must NOT appear is any DERIVED
       or Monacado-layer figure. */
    for (const absent of [
      "monacadoRetainedAmountMinorUnits",
      "morWholesaleAcquisitionAmountMinorUnits",
      "sellerProceedsMinorUnits",
      "promoterRetailSpreadMinorUnits",
      "promoterNetProceedsMinorUnits",
      "promoterMarginRateBasisPoints",
      "sellerFundedCommissionMinorUnits",
      "taxAmount",
      "shippingAmount",
      "acquisitionPolicyId",
    ]) {
      expect(row).not.toHaveProperty(absent);
    }
  });

  it("28. enforces promoted viability with 0M.4A's own calculator", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const promoter = await seedParticipant(["PROMOTER"]);
    const internalProductId = await seedProduct();
    const storefrontId = await seedStorefront(promoter.participantId);
    const offer = await seedOffer(internalProductId, seller.accountId, seller.participantId);

    /* wholesale 5000, commission 20% = 1000. */
    const minimum = minimumViablePromotedRetailPrice({
      offerWholesalePriceMinorUnits: 5_000,
      sellerFundedCommissionMinorUnits: 1_000,
      currency: "USD",
      policy: ACQUISITION_POLICY,
    });

    const attempt = (retailPriceMinorUnits: number) =>
      createPromotedListing(
        {
          storefrontId,
          internalProductId,
          controllingParticipantId: promoter.participantId,
          retail: { retailPriceMinorUnits, retailPriceCurrency: "USD" },
          acceptedOfferSourceRecordId: offer.record.offerSourceRecordId,
          acceptedOfferSourceRecordVersion: "1",
          acquisitionPolicy: ACQUISITION_POLICY,
          actingAccountId: promoter.accountId,
          authorizedByActorId: ACTOR,
          now: NOW,
        },
        { db },
      );

    /* One minor unit below the minimum must fail. */
    await expect(attempt(minimum - 1)).rejects.toMatchObject({
      name: "ListingEconomicsRefusedError",
      economicsCode: "NEGATIVE_PROMOTER_PROCEEDS",
    });
    /* And the minimum itself must succeed. */
    const ok = await attempt(minimum);
    expect(ok.currentVersion.placement.retail.retailPriceMinorUnits).toBe(minimum);
  });

  // — Authorization —

  it("29. an unrelated participant cannot create a Listing under another's control", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const stranger = await seedParticipant(["SELLER"]);
    const internalProductId = await seedProduct();
    const storefrontId = await seedStorefront(seller.participantId);

    await expect(
      createSellerDirectListing(
        {
          storefrontId,
          internalProductId,
          controllingParticipantId: seller.participantId,
          retail,
          actingAccountId: stranger.accountId,
          authorizedByActorId: ACTOR,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(ListingNotAuthorizedError);
  });

  it("29b. each branch reports its OWN capability, never Product drafting", async () => {
    /* Phase 0M.7 correction: seller-direct creation used to borrow
       `product:draft:create`. Placing a Product for sale is not the same
       authorization concern as authoring the Product's facts, so each branch now
       names its own capability — asserted here through the refusal, which is
       where the governing capability surfaces. */
    const seller = await seedParticipant(["SELLER"]);
    const stranger = await seedParticipant(["SELLER"]);
    const internalProductId = await seedProduct();
    const storefrontId = await seedStorefront(seller.participantId);

    await expect(
      createSellerDirectListing(
        {
          storefrontId,
          internalProductId,
          controllingParticipantId: seller.participantId,
          retail,
          actingAccountId: stranger.accountId,
          authorizedByActorId: ACTOR,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toMatchObject({ capability: "listing:seller_direct:create" });

    /* A PROMOTER attempting the seller-direct branch is refused for lacking
       SELLER — not silently allowed by a Product-shaped rule. */
    const promoter = await seedParticipant(["PROMOTER"]);
    const promoterStorefront = await seedStorefront(promoter.participantId);
    await expect(
      createSellerDirectListing(
        {
          storefrontId: promoterStorefront,
          internalProductId,
          controllingParticipantId: promoter.participantId,
          retail,
          actingAccountId: promoter.accountId,
          authorizedByActorId: ACTOR,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toMatchObject({
      capability: "listing:seller_direct:create",
      reasonCodes: ["ROLE_NOT_HELD"],
    });
  });

  it("29c. the promoted branch still reports listing:promoted:create", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const notAPromoter = await seedParticipant(["SELLER"]);
    const internalProductId = await seedProduct();
    const storefrontId = await seedStorefront(notAPromoter.participantId);
    const offer = await seedOffer(internalProductId, seller.accountId, seller.participantId);

    await expect(
      createPromotedListing(
        {
          storefrontId,
          internalProductId,
          controllingParticipantId: notAPromoter.participantId,
          retail: { retailPriceMinorUnits: 12_500, retailPriceCurrency: "USD" },
          acceptedOfferSourceRecordId: offer.record.offerSourceRecordId,
          acceptedOfferSourceRecordVersion: "1",
          acquisitionPolicy: ACQUISITION_POLICY,
          actingAccountId: notAPromoter.accountId,
          authorizedByActorId: ACTOR,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toMatchObject({ capability: "listing:promoted:create" });
  });

  it("30. a stranger cannot mutate an existing Listing", async () => {
    const { snapshot } = await seedSellerDirect();
    const stranger = await seedParticipant(["SELLER"]);
    await expect(
      createListingSourceVersion(
        {
          internalListingId: snapshot.record.internalListingId,
          sourceRecordVersion: "2",
          lifecycle: "WITHDRAWN",
          actingAccountId: stranger.accountId,
          authorizedByActorId: ACTOR,
          now: LATER,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(ListingNotAuthorizedError);

    expect(
      await db.listingSourceRecordVersionRow.count({
        where: { internalListingId: snapshot.record.internalListingId },
      }),
    ).toBe(1);
  });

  it("31. a promoted Listing requires the PROMOTER role, not merely an account", async () => {
    const seller = await seedParticipant(["SELLER"]);
    /* Holds SELLER only — no PROMOTER role. */
    const notAPromoter = await seedParticipant(["SELLER"]);
    const internalProductId = await seedProduct();
    const storefrontId = await seedStorefront(notAPromoter.participantId);
    const offer = await seedOffer(internalProductId, seller.accountId, seller.participantId);

    await expect(
      createPromotedListing(
        {
          storefrontId,
          internalProductId,
          controllingParticipantId: notAPromoter.participantId,
          retail: { retailPriceMinorUnits: 12_500, retailPriceCurrency: "USD" },
          acceptedOfferSourceRecordId: offer.record.offerSourceRecordId,
          acceptedOfferSourceRecordVersion: "1",
          acquisitionPolicy: ACQUISITION_POLICY,
          actingAccountId: notAPromoter.accountId,
          authorizedByActorId: ACTOR,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toMatchObject({ reasonCodes: ["ROLE_NOT_HELD"] });
  });

  it("32. an unknown acting account is the guest subject, and is refused", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const internalProductId = await seedProduct();
    const storefrontId = await seedStorefront(seller.participantId);
    await expect(
      createSellerDirectListing(
        {
          storefrontId,
          internalProductId,
          controllingParticipantId: seller.participantId,
          retail,
          actingAccountId: "acct_does_not_exist",
          authorizedByActorId: ACTOR,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toMatchObject({ reasonCodes: ["ACCOUNT_REQUIRED"] });
  });

  it("33. refuses an invalid lifecycle transition using 0M.4A's own table", async () => {
    const { snapshot, seller } = await seedSellerDirect();
    /* DRAFT permits only ACTIVE and WITHDRAWN. */
    await expect(
      createListingSourceVersion(
        {
          internalListingId: snapshot.record.internalListingId,
          sourceRecordVersion: "2",
          lifecycle: "SUSPENDED",
          actingAccountId: seller.accountId,
          authorizedByActorId: ACTOR,
          now: LATER,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(ListingNotAuthorizedError);
  });

  // — Buyer-active gating —

  it("34. a persisted Listing exists while not buyer-active, and says why", async () => {
    /* Expected through 0M.7: a drafting participant is not ACTIVE, and the
       Storefront is not publicly accessible. Every blocking reason is reported,
       not just the first — a promoter fixing one should not discover the next
       only after saving. */
    const { snapshot } = await seedSellerDirect();
    const eligibility = await evaluateBuyerEligibility(
      snapshot.record.internalListingId,
      { productAvailability: "available" },
      { db },
    );
    expect(eligibility.buyerActive).toBe(false);
    expect(eligibility.blockingReasons).toContain("LISTING_NOT_ACTIVE");
    expect(eligibility.blockingReasons).toContain("STOREFRONT_NOT_PUBLICLY_ACCESSIBLE");
    expect(eligibility.blockingReasons).toContain("CONTROLLING_PARTICIPANT_NOT_ACTIVE");
  });

  // — Delete / FK —

  it("35. refuses to delete a Product a Listing depends on", async () => {
    const { internalProductId } = await seedSellerDirect();
    await expect(
      db.product.delete({ where: { internalProductId } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("36. refuses to delete a Storefront a Listing depends on", async () => {
    const { storefrontId } = await seedSellerDirect();
    await expect(
      db.storefront.delete({ where: { internalStorefrontId: storefrontId } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("37. refuses to delete a participant controlling a Listing", async () => {
    const { seller } = await seedSellerDirect();
    await expect(
      db.marketplaceParticipant.delete({ where: { id: seller.participantId } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("38. refuses to delete an accepted Offer source version a Listing depends on", async () => {
    const { offer } = await seedPromoted();
    const row = await db.offerSourceRecordVersionRow.findFirst({
      where: { internalOfferId: offer.record.internalOfferId, sourceRecordVersion: "1" },
    });
    await expect(
      db.offerSourceRecordVersionRow.delete({ where: { seq: row!.seq } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("39. refuses to delete a Listing while its history exists", async () => {
    const { snapshot } = await seedSellerDirect();
    await expect(
      db.listing.delete({ where: { internalListingId: snapshot.record.internalListingId } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  // — Reconstruction —

  it("40. reconstructs a SELLER_DIRECT row exactly, with no Offer field", async () => {
    const { snapshot } = await seedSellerDirect({ sale });
    const row = await db.listingSourceRecordVersionRow.findFirst({
      where: { internalListingId: snapshot.record.internalListingId },
    });
    const reconstructed = versionRowToSourceVersion(row!);
    expect(ListingSourceVersion.safeParse(reconstructed).success).toBe(true);
    expect(reconstructed).toEqual(snapshot.currentVersion);
    expect(reconstructed.placement).not.toHaveProperty("offerDependency");
  });

  it("41. reconstructs a PROMOTED row exactly, with no sale field", async () => {
    const { snapshot } = await seedPromoted();
    const row = await db.listingSourceRecordVersionRow.findFirst({
      where: { internalListingId: snapshot.record.internalListingId },
    });
    const reconstructed = versionRowToSourceVersion(row!);
    expect(reconstructed).toEqual(snapshot.currentVersion);
    expect(reconstructed.placement).not.toHaveProperty("sale");
  });

  it("42. a corrupt branch discriminator fails loudly", async () => {
    const { snapshot } = await seedSellerDirect();
    await db.listingSourceRecordVersionRow.updateMany({
      where: { internalListingId: snapshot.record.internalListingId },
      data: { listingType: "NONSENSE" },
    });
    await expect(
      getListing(snapshot.record.internalListingId, { db }),
    ).rejects.toBeInstanceOf(CorruptListingRecordError);
  });

  it("43. a half-populated sale arm fails loudly rather than being repaired", async () => {
    const { snapshot } = await seedSellerDirect({ sale });
    await db.listingSourceRecordVersionRow.updateMany({
      where: { internalListingId: snapshot.record.internalListingId },
      data: { salePriceCurrency: null },
    });
    await expect(
      getListing(snapshot.record.internalListingId, { db }),
    ).rejects.toBeInstanceOf(CorruptListingRecordError);
  });

  it("44. a promoted row with an incomplete Offer binding fails loudly", async () => {
    const { snapshot } = await seedPromoted();
    /* Nulling a non-FK part of the binding leaves the composite FK satisfied but
       the dependency unreconstructable — it must not degrade to "current". */
    await db.listingSourceRecordVersionRow.updateMany({
      where: { internalListingId: snapshot.record.internalListingId },
      data: { acceptedWholesalePriceMinorUnits: null },
    });
    await expect(
      getListing(snapshot.record.internalListingId, { db }),
    ).rejects.toBeInstanceOf(CorruptListingRecordError);
  });

  // — Projection compatibility —

  it("45. a persisted SELLER_DIRECT version feeds the existing projection", async () => {
    const { snapshot } = await seedSellerDirect({ sale });
    await forceActive(snapshot.record.internalListingId);
    const persisted = await getCurrentSourceVersion(snapshot.record.internalListingId, { db });

    const capsule = listingSourceRecordToCapsuleProjection({
      sourceVersion: persisted,
      context: projectionContext(persisted),
    });
    expect(capsule).toBeTruthy();

    const serialized = canonicalJsonString(capsule);
    /* The public price is self-describing: base price plus the sale schedule,
       so the capsule stays correct as time advances and NO publication is
       required merely because a sale starts or ends. */
    expect(serialized).toContain("8000");
    expect(serialized).toContain("10000");
    /* And carries no clock-derived value. */
    expect(serialized).not.toContain("currentPrice");
    expect(serialized).not.toContain("pricedAt");
  });

  it("46. a persisted PROMOTED version projects with NO public Offer reference", async () => {
    /* 0M.4B's deliberate privacy decision: the Offer capsule publishes its own
       wholesale price, so a reference would let a consumer subtract it from this
       retail price and recover the promoter's spread. Disclosure by composition
       is disclosure. */
    const { snapshot } = await seedPromoted();
    await forceActive(snapshot.record.internalListingId);
    const persisted = await getCurrentSourceVersion(snapshot.record.internalListingId, { db });

    const capsule = listingSourceRecordToCapsuleProjection({
      sourceVersion: persisted,
      context: projectionContext(persisted),
    });
    const serialized = canonicalJsonString(capsule);

    for (const leak of [
      persisted.placement.listingType === "PROMOTED"
        ? persisted.placement.offerDependency.offerSourceRecordId
        : "",
      "offerNode",
      "offerSourceRecordId",
      "wholesale",
      "commission",
      "sellerProceeds",
      "promoterSpread",
      "promoterNetProceeds",
      "monacadoRetained",
      "5000",
    ]) {
      if (leak !== "") expect(serialized).not.toContain(leak);
    }
    /* The promoter's own retail price IS public — it is what a buyer pays. */
    expect(serialized).toContain("12500");
  });

  it("47. persisted and canonical in-memory sources project byte-identically", async () => {
    const { snapshot } = await seedSellerDirect({ sale });
    await forceActive(snapshot.record.internalListingId);
    const persisted = await getCurrentSourceVersion(snapshot.record.internalListingId, { db });
    const context = projectionContext(persisted);

    /* An INDEPENDENTLY constructed canonical source with the same values — not a
       copy of the persisted object. */
    const canonical = ListingSourceVersion.parse({
      listingSourceRecordId: snapshot.record.listingSourceRecordId,
      sourceRecordVersion: "1",
      supersedesSourceRecordVersion: null,
      internalListingId: snapshot.record.internalListingId,
      sourceSystem: "monacado",
      sourceRecordType: "Listing",
      sourceClass: "governed-database-record",
      storefrontId: snapshot.record.storefrontId,
      internalProductId: snapshot.record.internalProductId,
      controllingParticipantId: snapshot.record.controllingParticipantId,
      lifecycle: "ACTIVE",
      placement: { listingType: "SELLER_DIRECT", retail, sale },
      authorizedByParticipantId: snapshot.record.controllingParticipantId,
      authorizedByActorId: ACTOR,
      recordedAt: NOW,
    });

    expect(persisted).toEqual(canonical);
    expect(
      canonicalJsonString(
        listingSourceRecordToCapsuleProjection({ sourceVersion: persisted, context }),
      ),
    ).toBe(
      canonicalJsonString(
        listingSourceRecordToCapsuleProjection({ sourceVersion: canonical, context }),
      ),
    );
  });

  // — Scope —

  it("48. issues no Listing Node and creates no publication, outbox, receipt, or order", async () => {
    const { snapshot } = await seedSellerDirect();
    expect(snapshot.record).not.toHaveProperty("nodeId");
    expect(snapshot.currentVersion).not.toHaveProperty("nodeId");
    expect(snapshot.currentVersion).not.toHaveProperty("mappingVersion");
    expect(await db.publicationOutbox.count()).toBe(0);
    expect(await db.registrarReceipt.count()).toBe(0);
    expect(await db.productPublication.count()).toBe(0);
  });

  it("49. refuses an unknown Listing rather than inventing one", async () => {
    await expect(
      getListing(`mon:listing:${pad26("M7N0SUCH")}`, { db }),
    ).rejects.toBeInstanceOf(ListingNotFoundError);
    await expect(
      listSourceVersions(`mon:listing:${pad26("M7N0SUCH")}`, { db }),
    ).rejects.toBeInstanceOf(ListingNotFoundError);
  });
});
