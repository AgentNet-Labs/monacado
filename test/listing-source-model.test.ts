/**
 * Authoritative Listing source model tests (Phase 0M.4A).
 *
 * Offline: no database, no network, no clock. Every instant is supplied.
 *
 * The economics assertions are exact integer arithmetic throughout. Where a
 * boundary matters — the minimum viable retail price, the sale window edges — the
 * test checks the value one minor unit or one millisecond either side, because a
 * boundary asserted only from the inside is a boundary that has not been tested.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DEFERRED_LISTING_EXTENSIONS,
  INITIAL_LISTING_LIFECYCLE_STATE,
  LISTING_BLOCKING_REASONS,
  LISTING_LIFECYCLE_STATES,
  LISTING_TYPES,
  ListingEconomicsError,
  ListingPlacement,
  ListingSourceRecord,
  ListingSourceVersion,
  MonacadoWholesaleAcquisitionPolicy,
  NEVER_ON_LISTING_SOURCE_RECORD,
  SELLER_SALE_ISOLATED_FROM,
  calculateMonacadoRetainedAmount,
  calculateMorWholesaleAcquisition,
  calculatePromotedListingEconomics,
  calculateSellerDirectEconomics,
  effectiveSellerRetailPrice,
  evaluateListingBuyerEligibility,
  evaluateUpstreamOfferReview,
  isSaleActive,
  isTerminalListingLifecycleState,
  isValidListingLifecycleTransition,
  minimumViablePromotedRetailPrice,
  offerChangeForcesReview,
  sellerSaleForcesPromoterReview,
  type MonacadoWholesaleAcquisitionPolicy as AcquisitionPolicy,
} from "../src/contracts/marketplace/listing-source";

const body = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const LISTING = `mon:listing:${body("0M4ALISTING")}`;
const SREC = `mon:srec:${body("0M4ASREC")}`;
const STOREFRONT = `mon:storefront:${body("0M4ASTFRNT")}`;
const PRODUCT = `mon:product:${body("0M4APRODUCT")}`;
const PARTICIPANT = `mon:mpart:${body("0M4APART")}`;
const ACTOR = `mon:actor:${body("0M4AACTOR")}`;
const OFFER = `mon:offer:${body("0M4AOFFER")}`;
const OFFER_SREC = `mon:srec:${body("0M4AOFFERSREC")}`;

/**
 * The **current standard** Monacado wholesale-acquisition policy, as a test
 * fixture: 750 basis points plus 100 minor units retained, i.e. an acquisition
 * amount of 92.5% of the commercial retail price minus $1.00.
 *
 * The values are supplied here, never imported from the contract — that is the
 * whole point of the abstraction, and a test that reached for a shipped constant
 * would prove the opposite of what it claims.
 */
const STANDARD_RETAINED_BASIS_POINTS = 750;
const STANDARD_RETAINED_FIXED_MINOR_UNITS = 100;

const acquisitionPolicy = (
  overrides: Partial<AcquisitionPolicy> = {},
): AcquisitionPolicy => ({
  policyId: "mon:acqpolicy:test-only",
  policyVersion: "test-1",
  currency: "USD",
  retainedPercentageBasisPoints: STANDARD_RETAINED_BASIS_POINTS,
  retainedFixedAmountMinorUnits: STANDARD_RETAINED_FIXED_MINOR_UNITS,
  roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
  ...overrides,
});

const sellerPlacement = (overrides: Record<string, unknown> = {}) => ({
  listingType: "SELLER_DIRECT" as const,
  retail: { retailPriceMinorUnits: 2_000, retailPriceCurrency: "USD" },
  sale: null,
  ...overrides,
});

const saleSchedule = (overrides: Record<string, unknown> = {}) => ({
  salePriceMinorUnits: 1_500,
  salePriceCurrency: "USD",
  saleStartsAt: "2027-03-01T00:00:00.000Z",
  saleEndsAt: "2027-03-08T00:00:00.000Z",
  ...overrides,
});

const offerDependency = (overrides: Record<string, unknown> = {}) => ({
  internalOfferId: OFFER,
  offerSourceRecordId: OFFER_SREC,
  acceptedOfferSourceRecordVersion: "3",
  acceptedWholesalePriceMinorUnits: 1_000,
  acceptedWholesalePriceCurrency: "USD",
  acceptedCommissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
  acceptedAt: "2027-02-01T00:00:00.000Z",
  ...overrides,
});

const promotedPlacement = (overrides: Record<string, unknown> = {}) => ({
  listingType: "PROMOTED" as const,
  retail: { retailPriceMinorUnits: 2_500, retailPriceCurrency: "USD" },
  offerDependency: offerDependency(),
  upstreamReviewState: "ACCEPTED_CURRENT_VERSION" as const,
  ...overrides,
});

const record = (placement: unknown) => ({
  listingSourceRecordId: SREC,
  internalListingId: LISTING,
  currentSourceRecordVersion: "1",
  storefrontId: STOREFRONT,
  internalProductId: PRODUCT,
  controllingParticipantId: PARTICIPANT,
  sourceSystem: "monacado",
  sourceRecordType: "Listing",
  sourceClass: "governed-database-record",
  lifecycle: "ACTIVE",
  placement,
  createdAt: "2027-01-01T00:00:00.000Z",
  updatedAt: "2027-02-01T00:00:00.000Z",
});

const version = (placement: unknown) => ({
  listingSourceRecordId: SREC,
  sourceRecordVersion: "1",
  supersedesSourceRecordVersion: null,
  internalListingId: LISTING,
  sourceSystem: "monacado",
  sourceRecordType: "Listing",
  sourceClass: "governed-database-record",
  storefrontId: STOREFRONT,
  internalProductId: PRODUCT,
  controllingParticipantId: PARTICIPANT,
  lifecycle: "ACTIVE",
  placement,
  authorizedByParticipantId: PARTICIPANT,
  authorizedByActorId: ACTOR,
  recordedAt: "2027-02-01T00:00:00.000Z",
});

const liveStorefront = {
  lifecycle: "ACTIVE" as const,
  visibility: "PUBLIC" as const,
  goLiveApproval: "APPROVED" as const,
};

const eligibilityInput = (overrides: Record<string, unknown> = {}) => ({
  lifecycle: "ACTIVE" as const,
  listingType: "SELLER_DIRECT" as const,
  productAvailability: "available" as const,
  storefrontExposure: liveStorefront,
  controllingParticipantStatus: "ACTIVE" as const,
  controllingRoleStatus: "ACTIVE" as const,
  ...overrides,
});

// — 1/2. Valid listings —

describe("1/2. valid Listings of both types", () => {
  it("accepts a SELLER_DIRECT record and version", () => {
    expect(ListingSourceRecord.safeParse(record(sellerPlacement())).success).toBe(true);
    expect(ListingSourceVersion.safeParse(version(sellerPlacement())).success).toBe(true);
  });

  it("accepts a PROMOTED record and version", () => {
    expect(ListingSourceRecord.safeParse(record(promotedPlacement())).success).toBe(true);
    expect(ListingSourceVersion.safeParse(version(promotedPlacement())).success).toBe(true);
  });

  it("accepts a seller Listing with a complete sale schedule", () => {
    const placement = sellerPlacement({ sale: saleSchedule() });
    expect(ListingPlacement.safeParse(placement).success).toBe(true);
  });

  it("names both listing types and no third", () => {
    expect([...LISTING_TYPES]).toEqual(["SELLER_DIRECT", "PROMOTED"]);
  });

  it("starts DRAFT and treats ENDED and WITHDRAWN as terminal", () => {
    expect(INITIAL_LISTING_LIFECYCLE_STATE).toBe("DRAFT");
    expect(isTerminalListingLifecycleState("ENDED")).toBe(true);
    expect(isTerminalListingLifecycleState("WITHDRAWN")).toBe(true);
    expect(isValidListingLifecycleTransition("DRAFT", "ACTIVE")).toBe(true);
    expect(isValidListingLifecycleTransition("ENDED", "ACTIVE")).toBe(false);
    expect(LISTING_LIFECYCLE_STATES).toHaveLength(5);
  });
});

// — 3. Discrimination —

describe("3. the two shapes cannot be mixed", () => {
  it("refuses an Offer dependency on a SELLER_DIRECT Listing", () => {
    const placement = sellerPlacement({ offerDependency: offerDependency() });
    expect(ListingPlacement.safeParse(placement).success).toBe(false);
  });

  it("refuses an upstream review state on a SELLER_DIRECT Listing", () => {
    const placement = sellerPlacement({ upstreamReviewState: "REVIEW_REQUIRED" });
    expect(ListingPlacement.safeParse(placement).success).toBe(false);
  });

  it("15. refuses a sale schedule on a PROMOTED Listing", () => {
    const placement = promotedPlacement({ sale: saleSchedule() });
    expect(ListingPlacement.safeParse(placement).success).toBe(false);
  });

  it("refuses a PROMOTED Listing with no Offer dependency", () => {
    const placement = { ...promotedPlacement() } as Record<string, unknown>;
    delete placement.offerDependency;
    expect(ListingPlacement.safeParse(placement).success).toBe(false);
  });

  it("refuses an unknown listing type", () => {
    expect(
      ListingPlacement.safeParse({ ...sellerPlacement(), listingType: "CONSIGNMENT" }).success,
    ).toBe(false);
  });
});

// — 4/5. Retail price required —

describe("4/5. a retail price is required on both types", () => {
  it("4. refuses a SELLER_DIRECT Listing with no retail price", () => {
    const placement = { ...sellerPlacement() } as Record<string, unknown>;
    delete placement.retail;
    expect(ListingPlacement.safeParse(placement).success).toBe(false);
  });

  it("5. refuses a PROMOTED Listing with no retail price", () => {
    const placement = { ...promotedPlacement() } as Record<string, unknown>;
    delete placement.retail;
    expect(ListingPlacement.safeParse(placement).success).toBe(false);
  });

  it("refuses a non-integer or negative retail price", () => {
    for (const bad of [9.99, 0, -100]) {
      const placement = sellerPlacement({
        retail: { retailPriceMinorUnits: bad, retailPriceCurrency: "USD" },
      });
      expect(ListingPlacement.safeParse(placement).success).toBe(false);
    }
  });
});

// — 6-10. Sale schedule validity —

describe("6-10. sale schedule rules", () => {
  it("6. accepts price, start, and end together", () => {
    expect(ListingPlacement.safeParse(sellerPlacement({ sale: saleSchedule() })).success).toBe(
      true,
    );
  });

  it("7. refuses a partial schedule", () => {
    for (const missing of ["salePriceMinorUnits", "saleStartsAt", "saleEndsAt"]) {
      const sale = { ...saleSchedule() } as Record<string, unknown>;
      delete sale[missing];
      expect(ListingPlacement.safeParse(sellerPlacement({ sale })).success).toBe(false);
    }
  });

  it("8. refuses a sale price at or above ordinary retail", () => {
    for (const price of [2_000, 2_500]) {
      const sale = saleSchedule({ salePriceMinorUnits: price });
      expect(ListingPlacement.safeParse(sellerPlacement({ sale })).success).toBe(false);
    }
    // One minor unit below retail is accepted.
    expect(
      ListingPlacement.safeParse(
        sellerPlacement({ sale: saleSchedule({ salePriceMinorUnits: 1_999 }) }),
      ).success,
    ).toBe(true);
  });

  it("9. refuses a sale currency that differs from ordinary retail", () => {
    const sale = saleSchedule({ salePriceCurrency: "EUR" });
    expect(ListingPlacement.safeParse(sellerPlacement({ sale })).success).toBe(false);
  });

  it("10. refuses saleStartsAt at or after saleEndsAt", () => {
    for (const [start, end] of [
      ["2027-03-08T00:00:00.000Z", "2027-03-01T00:00:00.000Z"],
      ["2027-03-01T00:00:00.000Z", "2027-03-01T00:00:00.000Z"],
    ]) {
      const sale = saleSchedule({ saleStartsAt: start, saleEndsAt: end });
      expect(ListingPlacement.safeParse(sellerPlacement({ sale })).success).toBe(false);
    }
  });

  it("accepts an absent sale as an explicit null", () => {
    expect(ListingPlacement.safeParse(sellerPlacement({ sale: null })).success).toBe(true);
  });
});

// — 11-14. Sale timing and effective price —

describe("11-14. sale timing is half-open and the price is derived", () => {
  const sale = saleSchedule();
  const placement = sellerPlacement({ sale });

  it("11. is active at exactly saleStartsAt (inclusive)", () => {
    expect(isSaleActive({ sale, now: "2027-03-01T00:00:00.000Z" })).toBe(true);
  });

  it("12. is not active at exactly saleEndsAt (exclusive)", () => {
    expect(isSaleActive({ sale, now: "2027-03-08T00:00:00.000Z" })).toBe(false);
    // One millisecond earlier is still inside the window.
    expect(isSaleActive({ sale, now: "2027-03-07T23:59:59.999Z" })).toBe(true);
  });

  it("is not active one millisecond before the start", () => {
    expect(isSaleActive({ sale, now: "2027-02-28T23:59:59.999Z" })).toBe(false);
  });

  it("13. yields ordinary retail outside the window", () => {
    const before = effectiveSellerRetailPrice({ placement, now: "2027-02-01T00:00:00.000Z" });
    const after = effectiveSellerRetailPrice({ placement, now: "2027-04-01T00:00:00.000Z" });
    expect(before).toEqual({ effectivePriceMinorUnits: 2_000, currency: "USD", saleActive: false });
    expect(after.effectivePriceMinorUnits).toBe(2_000);
  });

  it("14. yields the sale price inside the window", () => {
    const during = effectiveSellerRetailPrice({ placement, now: "2027-03-03T12:00:00.000Z" });
    expect(during).toEqual({ effectivePriceMinorUnits: 1_500, currency: "USD", saleActive: true });
  });

  it("yields ordinary retail when no sale is scheduled", () => {
    const result = effectiveSellerRetailPrice({
      placement: sellerPlacement(),
      now: "2027-03-03T12:00:00.000Z",
    });
    expect(result).toEqual({
      effectivePriceMinorUnits: 2_000,
      currency: "USD",
      saleActive: false,
    });
  });

  it("never mutates the ordinary retail price when the sale starts or ends", () => {
    const p = sellerPlacement({ sale });
    effectiveSellerRetailPrice({ placement: p, now: "2027-03-03T12:00:00.000Z" });
    effectiveSellerRetailPrice({ placement: p, now: "2027-04-03T12:00:00.000Z" });
    expect(p.retail.retailPriceMinorUnits).toBe(2_000);
    expect(p.sale).toEqual(sale);
  });

  it("reads no clock — the instant is supplied", () => {
    const src = readFileSync(
      new URL("../src/contracts/marketplace/listing-source.ts", import.meta.url).pathname,
      "utf8",
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(code).not.toContain("Date.now(");
    expect(code).not.toContain("Math.random(");
    expect(code).not.toMatch(/new Date\(\s*\)/);
  });
});

// — 16/17. Seller sale isolation —

describe("16/17. a seller sale is isolated from wholesale and promoters", () => {
  it("16. does not appear in, or alter, any Offer identity or version", () => {
    const promoted = promotedPlacement();
    const before = JSON.stringify(promoted.offerDependency);

    // A seller sale exists only on a seller placement; it has nowhere to reach.
    const seller = sellerPlacement({ sale: saleSchedule() });
    effectiveSellerRetailPrice({ placement: seller, now: "2027-03-03T00:00:00.000Z" });

    expect(JSON.stringify(promoted.offerDependency)).toBe(before);
    expect(JSON.stringify(seller)).not.toContain("offer");
    expect(JSON.stringify(seller)).not.toContain("wholesale");
  });

  it("13/14. leaves promoted economics and the Offer version identical while a seller sale runs", () => {
    const policy = acquisitionPolicy();
    const promotedInput = {
      commercialRetailPriceMinorUnits: 10_000,
      currency: "USD",
      offerWholesalePriceMinorUnits: 5_000,
      offerWholesalePriceCurrency: "USD",
      sellerFundedCommissionMinorUnits: 1_000,
      policy,
    };
    const dependencyBefore = JSON.stringify(offerDependency());
    const promotedEconomics = calculatePromotedListingEconomics(promotedInput);

    // Run a seller sale over the same product; recompute promoted economics.
    const seller = sellerPlacement({ sale: saleSchedule() });
    expect(
      effectiveSellerRetailPrice({ placement: seller, now: "2027-03-03T00:00:00.000Z" })
        .saleActive,
    ).toBe(true);
    calculateSellerDirectEconomics({
      placement: seller,
      now: "2027-03-03T00:00:00.000Z",
      policy,
    });

    expect(calculatePromotedListingEconomics(promotedInput)).toEqual(promotedEconomics);
    // 14. The Offer source version the promoter accepted is untouched.
    expect(JSON.stringify(offerDependency())).toBe(dependencyBefore);
  });

  it("never forces a promoter review", () => {
    expect(sellerSaleForcesPromoterReview()).toBe(false);
  });

  it("records the facts it is isolated from", () => {
    for (const isolated of [
      "wholesalePrice",
      "offerSourceRecordVersion",
      "promotedListingEconomics",
      "promoterAcknowledgement",
      "promoterReviewRequirement",
      "promoterNotificationObligation",
      "promoterMinimumViableRetailPrice",
    ]) {
      expect(SELLER_SALE_ISOLATED_FROM).toContain(isolated);
    }
  });

  it("has no field on a seller placement through which it could reach a promoter", () => {
    const placement = sellerPlacement({ sale: saleSchedule() });
    const keys = JSON.stringify(placement);
    for (const forbidden of ["promoter", "wholesale", "offerDependency", "notification"]) {
      expect(keys.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

// — 18/19. Promoter retail autonomy —

describe("18/19. the promoter's retail price is their own", () => {
  it("18. may differ from any seller retail price", () => {
    const promoted = promotedPlacement({
      retail: { retailPriceMinorUnits: 4_000, retailPriceCurrency: "USD" },
    });
    expect(ListingPlacement.safeParse(promoted).success).toBe(true);
    expect(promoted.retail.retailPriceMinorUnits).not.toBe(
      sellerPlacement().retail.retailPriceMinorUnits,
    );
  });

  it("19. leaves the accepted wholesale price unchanged when it moves", () => {
    const dependency = offerDependency();
    const before = { ...dependency };

    for (const retail of [2_000, 3_000, 9_999]) {
      const placement = promotedPlacement({
        retail: { retailPriceMinorUnits: retail, retailPriceCurrency: "USD" },
        offerDependency: dependency,
      });
      expect(ListingPlacement.safeParse(placement).success).toBe(true);
    }

    expect(dependency).toEqual(before);
    expect(dependency.acceptedWholesalePriceMinorUnits).toBe(1_000);
    expect(dependency.acceptedOfferSourceRecordVersion).toBe("3");
  });

  it("calls the derived share a margin rate, never a commission rate", () => {
    const economics = calculatePromotedListingEconomics({
      commercialRetailPriceMinorUnits: 10_000,
      currency: "USD",
      offerWholesalePriceMinorUnits: 5_000,
      offerWholesalePriceCurrency: "USD",
      sellerFundedCommissionMinorUnits: 1_000,
      policy: acquisitionPolicy(),
    });
    expect(Object.keys(economics)).toContain("promoterMarginRateBasisPoints");
    expect(Object.keys(economics)).toContain("promoterNetProceedsMinorUnits");
    /* The only commission member is the seller-funded Offer amount carried
       through verbatim — never a retail-derived rate wearing the same word. */
    const commissionKeys = Object.keys(economics).filter((k) =>
      k.toLowerCase().includes("commission"),
    );
    expect(commissionKeys).toEqual(["sellerFundedCommissionMinorUnits"]);
  });
});

// — MoR wholesale acquisition —

describe("MoR wholesale acquisition (the binding commercial model)", () => {
  it("3/4. $100.00 retail retains $8.50 and acquires at $91.50", () => {
    const result = calculateMorWholesaleAcquisition({
      commercialRetailPriceMinorUnits: 10_000,
      currency: "USD",
      policy: acquisitionPolicy(),
    });
    expect(result.monacadoRetainedAmountMinorUnits).toBe(850);
    expect(result.morWholesaleAcquisitionAmountMinorUnits).toBe(9_150);
    // 92.5% of R − $1.00, stated the other way round.
    expect(result.morWholesaleAcquisitionAmountMinorUnits).toBe(10_000 - 850);
  });

  it("1. uses the current standard policy of 750 bp + 100 minor units", () => {
    const policy = acquisitionPolicy();
    expect(policy.retainedPercentageBasisPoints).toBe(750);
    expect(policy.retainedFixedAmountMinorUnits).toBe(100);
    expect(
      calculateMonacadoRetainedAmount({
        commercialRetailPriceMinorUnits: 10_000,
        currency: "USD",
        policy,
      }),
    ).toBe(850);
  });

  it("5/6. is integer minor-unit arithmetic with deterministic half-up rounding", () => {
    // 7.5% of 2333 = 174.975 -> 175 half-up, never 174.
    expect(
      calculateMonacadoRetainedAmount({
        commercialRetailPriceMinorUnits: 2_333,
        currency: "USD",
        policy: acquisitionPolicy({ retainedFixedAmountMinorUnits: 0 }),
      }),
    ).toBe(175);
    // Exactly .5 rounds up.
    expect(
      calculateMonacadoRetainedAmount({
        commercialRetailPriceMinorUnits: 2_500,
        currency: "USD",
        policy: acquisitionPolicy({ retainedFixedAmountMinorUnits: 0 }),
      }),
    ).toBe(188);
    // Repeatable.
    const twice = [0, 1].map(() =>
      calculateMorWholesaleAcquisition({
        commercialRetailPriceMinorUnits: 7_777,
        currency: "USD",
        policy: acquisitionPolicy(),
      }),
    );
    expect(twice[0]).toEqual(twice[1]);
  });

  it("refuses a price too small to cover the retained amount", () => {
    try {
      calculateMorWholesaleAcquisition({
        commercialRetailPriceMinorUnits: 50,
        currency: "USD",
        policy: acquisitionPolicy(),
      });
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as ListingEconomicsError).code).toBe("NEGATIVE_ACQUISITION_AMOUNT");
    }
  });

  it("refuses a policy denominated in another currency", () => {
    try {
      calculateMonacadoRetainedAmount({
        commercialRetailPriceMinorUnits: 10_000,
        currency: "USD",
        policy: acquisitionPolicy({ currency: "EUR" }),
      });
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as ListingEconomicsError).code).toBe("POLICY_CURRENCY_MISMATCH");
    }
  });

  it("requires a policy id and version", () => {
    for (const missing of ["policyId", "policyVersion"]) {
      const policy = { ...acquisitionPolicy() } as Record<string, unknown>;
      delete policy[missing];
      expect(MonacadoWholesaleAcquisitionPolicy.safeParse(policy).success).toBe(false);
    }
  });

  it("2/20. embeds no standard rate, fixed amount, or physical-goods constant", () => {
    const src = readFileSync(
      new URL("../src/contracts/marketplace/listing-source.ts", import.meta.url).pathname,
      "utf8",
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");

    expect(code).not.toMatch(/retainedPercentageBasisPoints\s*[:=]\s*750/);
    expect(code).not.toMatch(/retainedFixedAmountMinorUnits\s*[:=]\s*100\b/);
    expect(code).not.toMatch(/DEFAULT_(FEE|RATE|POLICY|RETAINED)/);
    expect(code).not.toMatch(/STANDARD_(FEE|RATE|RETAINED)/);
    // No physical-goods-specific rate anywhere.
    expect(code).not.toMatch(/PHYSICAL_[A-Z_]*(FEE|RATE|BASIS)/);
    // The policy is a required input on every economics entry point.
    expect(code).toContain("policy: MonacadoWholesaleAcquisitionPolicy");
  });

  it("19. applies the same policy whatever the goods are", () => {
    /* There is no product-kind input, so a physical item cannot be charged a
       different standard rate — the model has nowhere to express one. */
    const digital = calculateMorWholesaleAcquisition({
      commercialRetailPriceMinorUnits: 10_000,
      currency: "USD",
      policy: acquisitionPolicy(),
    });
    const physical = calculateMorWholesaleAcquisition({
      commercialRetailPriceMinorUnits: 10_000,
      currency: "USD",
      policy: acquisitionPolicy(),
    });
    expect(physical).toEqual(digital);

    const src = readFileSync(
      new URL("../src/contracts/marketplace/listing-source.ts", import.meta.url).pathname,
      "utf8",
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    for (const absent of ["productKind", "isPhysical", "fulfillmentType", "shippingRequired"]) {
      expect(code).not.toContain(absent);
    }
  });
});

// — Tax and shipping exclusion —

describe("15-18. tax and shipping are outside every basis", () => {
  const src = readFileSync(
    new URL("../src/contracts/marketplace/listing-source.ts", import.meta.url).pathname,
    "utf8",
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

  it("17/18. adds no tax or shipping field to the Listing source model", () => {
    for (const absent of [
      "taxMinorUnits",
      "taxRate",
      "salesTax",
      "vat",
      "gst",
      "shippingMinorUnits",
      "shippingCost",
      "freight",
      "deliveryCharge",
    ]) {
      expect(code.toLowerCase()).not.toContain(absent.toLowerCase());
    }
  });

  it("15/16. cannot admit a tax or shipping amount into a record or basis", () => {
    for (const field of ["taxMinorUnits", "shippingMinorUnits", "vatMinorUnits"]) {
      expect(
        ListingSourceRecord.safeParse({ ...record(sellerPlacement()), [field]: 500 }).success,
      ).toBe(false);
      expect(
        ListingPlacement.safeParse({ ...sellerPlacement(), [field]: 500 }).success,
      ).toBe(false);
    }
  });

  it("15/16. the basis is the commercial price alone, whatever a buyer eventually pays", () => {
    /* Tax and shipping would be added to a checkout total later. Because they
       cannot reach this calculation, the retained amount for a $100 item is
       $8.50 regardless of what else is on the buyer's invoice. */
    const commercialOnly = calculateMorWholesaleAcquisition({
      commercialRetailPriceMinorUnits: 10_000,
      currency: "USD",
      policy: acquisitionPolicy(),
    });
    expect(commercialOnly.monacadoRetainedAmountMinorUnits).toBe(850);

    // A caller who wrongly passed a tax-inclusive total would get a different,
    // larger retention — which is exactly why the basis is named and isolated.
    const taxInclusive = calculateMorWholesaleAcquisition({
      commercialRetailPriceMinorUnits: 10_800,
      currency: "USD",
      policy: acquisitionPolicy(),
    });
    expect(taxInclusive.monacadoRetainedAmountMinorUnits).toBeGreaterThan(850);
    // The Listing model has no field that could supply that inflated number.
    expect(code).not.toMatch(/checkoutTotal|grossTotal|taxInclusive/);
  });

  it("29. adds no checkout, tax, or shipping engine", () => {
    for (const absent of [
      "calculateTax",
      "calculateShipping",
      "checkoutTotal",
      "taxEngine",
      "shippingRate",
      "nexus",
    ]) {
      expect(code).not.toContain(absent);
    }
  });
});

// — Seller-direct economics —

describe("7/8. seller-direct MoR basis follows the effective commercial price", () => {
  const placement = sellerPlacement({
    retail: { retailPriceMinorUnits: 10_000, retailPriceCurrency: "USD" },
    sale: saleSchedule({ salePriceMinorUnits: 8_000 }),
  });

  it("7. uses the ordinary price outside the sale window", () => {
    const economics = calculateSellerDirectEconomics({
      placement,
      now: "2027-02-01T00:00:00.000Z",
      policy: acquisitionPolicy(),
    });
    expect(economics.saleActive).toBe(false);
    expect(economics.effectiveCommercialRetailPriceMinorUnits).toBe(10_000);
    expect(economics.monacadoRetainedAmountMinorUnits).toBe(850);
    expect(economics.morWholesaleAcquisitionAmountMinorUnits).toBe(9_150);
    expect(economics.sellerProceedsMinorUnits).toBe(9_150);
  });

  it("8. uses the sale price during the sale window", () => {
    const economics = calculateSellerDirectEconomics({
      placement,
      now: "2027-03-03T00:00:00.000Z",
      policy: acquisitionPolicy(),
    });
    expect(economics.saleActive).toBe(true);
    expect(economics.effectiveCommercialRetailPriceMinorUnits).toBe(8_000);
    // 7.5% of 8000 = 600, + 100 fixed = 700.
    expect(economics.monacadoRetainedAmountMinorUnits).toBe(700);
    expect(economics.sellerProceedsMinorUnits).toBe(7_300);
  });

  it("9/10. respects the inclusive start and exclusive end at the boundary", () => {
    const atStart = calculateSellerDirectEconomics({
      placement,
      now: "2027-03-01T00:00:00.000Z",
      policy: acquisitionPolicy(),
    });
    const atEnd = calculateSellerDirectEconomics({
      placement,
      now: "2027-03-08T00:00:00.000Z",
      policy: acquisitionPolicy(),
    });
    expect(atStart.effectiveCommercialRetailPriceMinorUnits).toBe(8_000);
    expect(atEnd.effectiveCommercialRetailPriceMinorUnits).toBe(10_000);
  });

  it("reconciles exactly: retained + seller proceeds = commercial price", () => {
    for (const now of ["2027-02-01T00:00:00.000Z", "2027-03-03T00:00:00.000Z"]) {
      const e = calculateSellerDirectEconomics({ placement, now, policy: acquisitionPolicy() });
      expect(e.monacadoRetainedAmountMinorUnits + e.sellerProceedsMinorUnits).toBe(
        e.effectiveCommercialRetailPriceMinorUnits,
      );
    }
  });
});

// — Promoted economics —

describe("11/12/23. promoted economics under the MoR model", () => {
  const promoted = (
    commercialRetailPriceMinorUnits: number,
    offerWholesalePriceMinorUnits = 5_000,
    sellerFundedCommissionMinorUnits = 1_000,
  ) =>
    calculatePromotedListingEconomics({
      commercialRetailPriceMinorUnits,
      currency: "USD",
      offerWholesalePriceMinorUnits,
      offerWholesalePriceCurrency: "USD",
      sellerFundedCommissionMinorUnits,
      policy: acquisitionPolicy(),
    });

  it("11. uses the promoter-controlled retail price as the MoR basis", () => {
    const e = promoted(10_000);
    expect(e.commercialRetailPriceMinorUnits).toBe(10_000);
    expect(e.monacadoRetainedAmountMinorUnits).toBe(850);
    expect(e.morWholesaleAcquisitionAmountMinorUnits).toBe(9_150);
  });

  it("12/23. charges no second Monacado fee and counts retention exactly once", () => {
    const e = promoted(10_000);
    // Supply-side pool is the acquisition amount; nothing further is deducted.
    expect(e.promoterRetailSpreadMinorUnits).toBe(9_150 - 5_000);
    expect(e.promoterNetProceedsMinorUnits).toBe(9_150 - 5_000 + 1_000);
    // Retention appears once, and the three parties sum to what the buyer paid.
    expect(
      e.sellerProceedsMinorUnits +
        e.promoterNetProceedsMinorUnits +
        e.monacadoRetainedAmountMinorUnits,
    ).toBe(e.commercialRetailPriceMinorUnits);
  });

  it("keeps the Offer layer and the MoR layer distinctly named", () => {
    const e = promoted(10_000);
    expect(e.offerWholesalePriceMinorUnits).toBe(5_000);
    expect(e.morWholesaleAcquisitionAmountMinorUnits).toBe(9_150);
    expect(e.offerWholesalePriceMinorUnits).not.toBe(
      e.morWholesaleAcquisitionAmountMinorUnits,
    );
  });

  it("22. carries the Offer's commission through unchanged and computes no second one", () => {
    const e = promoted(10_000, 5_000, 1_000);
    expect(e.sellerFundedCommissionMinorUnits).toBe(1_000);
    // The Offer identity commission + creator proceeds = wholesale still holds.
    expect(e.sellerProceedsMinorUnits + e.sellerFundedCommissionMinorUnits).toBe(
      e.offerWholesalePriceMinorUnits,
    );
  });

  it("uses Listing-side terminology, never the Offer's commission rate", () => {
    const keys = Object.keys(promoted(10_000));
    expect(keys).toContain("promoterRetailSpreadMinorUnits");
    expect(keys).toContain("promoterNetProceedsMinorUnits");
    expect(keys).toContain("promoterMarginRateBasisPoints");
    expect(keys).not.toContain("commissionRateBasisPoints");
    expect(keys).not.toContain("promoterCommissionRate");
  });

  it("is deterministic", () => {
    expect(promoted(12_345)).toEqual(promoted(12_345));
  });

  it("24. accepts exactly zero promoter net proceeds", () => {
    const minimum = minimumViablePromotedRetailPrice({
      offerWholesalePriceMinorUnits: 5_000,
      sellerFundedCommissionMinorUnits: 1_000,
      currency: "USD",
      policy: acquisitionPolicy(),
    });
    expect(promoted(minimum).promoterNetProceedsMinorUnits).toBe(0);
  });

  it("25. rejects negative promoter net proceeds", () => {
    const minimum = minimumViablePromotedRetailPrice({
      offerWholesalePriceMinorUnits: 5_000,
      sellerFundedCommissionMinorUnits: 1_000,
      currency: "USD",
      policy: acquisitionPolicy(),
    });
    try {
      promoted(minimum - 1);
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as ListingEconomicsError).code).toBe("NEGATIVE_PROMOTER_PROCEEDS");
    }
  });

  it("refuses a commission larger than the Offer wholesale price", () => {
    try {
      promoted(10_000, 5_000, 6_000);
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as ListingEconomicsError).code).toBe("COMMISSION_EXCEEDS_OFFER_WHOLESALE");
    }
  });

  it("refuses an Offer wholesale currency that differs from the commercial price", () => {
    try {
      calculatePromotedListingEconomics({
        commercialRetailPriceMinorUnits: 10_000,
        currency: "USD",
        offerWholesalePriceMinorUnits: 5_000,
        offerWholesalePriceCurrency: "EUR",
        sellerFundedCommissionMinorUnits: 0,
        policy: acquisitionPolicy(),
      });
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as ListingEconomicsError).code).toBe("WHOLESALE_CURRENCY_MISMATCH");
    }
  });

  it("handles a non-promotable Offer with zero commission", () => {
    const e = promoted(10_000, 5_000, 0);
    expect(e.sellerProceedsMinorUnits).toBe(5_000);
    expect(e.promoterNetProceedsMinorUnits).toBe(4_150);
    expect(
      e.sellerProceedsMinorUnits +
        e.promoterNetProceedsMinorUnits +
        e.monacadoRetainedAmountMinorUnits,
    ).toBe(10_000);
  });

  it("reconciles across a wide sweep of prices, wholesales, and commissions", () => {
    for (const retail of [2_000, 10_000, 12_345, 999_999]) {
      for (const wholesale of [0, 500, 5_000]) {
        for (const commission of [0, 1, 500]) {
          if (commission > wholesale) continue;
          let e;
          try {
            e = calculatePromotedListingEconomics({
              commercialRetailPriceMinorUnits: retail,
              currency: "USD",
              offerWholesalePriceMinorUnits: wholesale,
              offerWholesalePriceCurrency: "USD",
              sellerFundedCommissionMinorUnits: commission,
              policy: acquisitionPolicy(),
            });
          } catch {
            continue; // infeasible price; covered by the rejection tests
          }
          expect(
            e.sellerProceedsMinorUnits +
              e.promoterNetProceedsMinorUnits +
              e.monacadoRetainedAmountMinorUnits,
          ).toBe(retail);
        }
      }
    }
  });
});

// — 26/27. Minimum viable promoted retail —

describe("26/27. minimum viable promoted retail price under the corrected model", () => {
  it("26. is exact for the standard policy", () => {
    const minimum = minimumViablePromotedRetailPrice({
      offerWholesalePriceMinorUnits: 5_000,
      sellerFundedCommissionMinorUnits: 1_000,
      currency: "USD",
      policy: acquisitionPolicy(),
    });
    /* Net supply cost is W − C = 4000, plus the $1 fixed retention, over 92.5%.
       At 4432: retained = 332 + 100, leaving exactly 0 for the promoter. */
    expect(minimum).toBe(4_432);
  });

  it("27. one minor unit lower produces negative promoter net proceeds", () => {
    const minimum = minimumViablePromotedRetailPrice({
      offerWholesalePriceMinorUnits: 5_000,
      sellerFundedCommissionMinorUnits: 1_000,
      currency: "USD",
      policy: acquisitionPolicy(),
    });
    expect(() =>
      calculatePromotedListingEconomics({
        commercialRetailPriceMinorUnits: minimum - 1,
        currency: "USD",
        offerWholesalePriceMinorUnits: 5_000,
        offerWholesalePriceCurrency: "USD",
        sellerFundedCommissionMinorUnits: 1_000,
        policy: acquisitionPolicy(),
      }),
    ).toThrow(ListingEconomicsError);
  });

  it("a seller-funded commission lowers the minimum, and Monacado is not counted twice", () => {
    const withoutCommission = minimumViablePromotedRetailPrice({
      offerWholesalePriceMinorUnits: 5_000,
      sellerFundedCommissionMinorUnits: 0,
      currency: "USD",
      policy: acquisitionPolicy(),
    });
    const withCommission = minimumViablePromotedRetailPrice({
      offerWholesalePriceMinorUnits: 5_000,
      sellerFundedCommissionMinorUnits: 1_000,
      currency: "USD",
      policy: acquisitionPolicy(),
    });
    expect(withCommission).toBeLessThan(withoutCommission);
  });

  it("is exactly minimal across rates, fixed retentions, and supply costs", () => {
    /* Half-up rounding moves the true minimum below the naive closed form by up
       to 5000/(10000-bp) — thousands of units near 100%. The boundary is checked
       at every combination rather than assumed. */
    for (const retainedPercentageBasisPoints of [0, 1, 250, 750, 2_500, 5_000, 9_000, 9_900, 9_999]) {
      for (const retainedFixedAmountMinorUnits of [0, 1, 100, 999]) {
        for (const wholesale of [0, 1, 99, 1_000, 5_000, 123_457]) {
          for (const commission of [0, Math.min(1, wholesale), Math.floor(wholesale / 2)]) {
            const policy = acquisitionPolicy({
              retainedPercentageBasisPoints,
              retainedFixedAmountMinorUnits,
            });
            const minimum = minimumViablePromotedRetailPrice({
              offerWholesalePriceMinorUnits: wholesale,
              sellerFundedCommissionMinorUnits: commission,
              currency: "USD",
              policy,
            });

            const netAt = (retail: number): bigint =>
              BigInt(retail) -
              (BigInt(retail) * BigInt(retainedPercentageBasisPoints) + 5_000n) / 10_000n -
              BigInt(retainedFixedAmountMinorUnits) -
              BigInt(wholesale - commission);

            expect(netAt(minimum) >= 0n).toBe(true);
            if (minimum > 1) expect(netAt(minimum - 1) < 0n).toBe(true);
          }
        }
      }
    }
  });

  it("refuses when no price can work", () => {
    try {
      minimumViablePromotedRetailPrice({
        offerWholesalePriceMinorUnits: 100,
        sellerFundedCommissionMinorUnits: 0,
        currency: "USD",
        policy: acquisitionPolicy({ retainedPercentageBasisPoints: 10_000 }),
      });
      throw new Error("expected a rejection");
    } catch (error) {
      expect((error as ListingEconomicsError).code).toBe("NO_VIABLE_RETAIL_PRICE");
    }
  });

  it("28. performs no risk-policy lookup or selection", () => {
    const src = readFileSync(
      new URL("../src/contracts/marketplace/listing-source.ts", import.meta.url).pathname,
      "utf8",
    );
    /* The refusal and deferral lists legitimately NAME risk concepts in order to
       exclude them, so they are removed before scanning for machinery — otherwise
       the only way to pass would be to stop documenting what is refused. */
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/export const NEVER_ON_LISTING_SOURCE_RECORD[\s\S]*?\] as const;/, "")
      .replace(/export const DEFERRED_LISTING_EXTENSIONS[\s\S]*?\] as const;/, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");

    for (const absent of [
      "lookupPolicy",
      "resolvePolicy",
      "selectPolicy",
      "riskScore",
      "riskTier",
      "highRisk",
      "reserve",
      "payoutHold",
      "velocity",
    ]) {
      expect(code).not.toContain(absent);
    }
    // The policy arrives as an argument; nothing here chooses it.
    expect(code).toContain("policy: MonacadoWholesaleAcquisitionPolicy");
  });
});
// — 30-33. Offer-version dependency —

describe("30-33. the promoted Listing binds one exact Offer version", () => {
  it("30. records the exact accepted version and its wholesale price", () => {
    const placement = promotedPlacement();
    expect(placement.offerDependency.acceptedOfferSourceRecordVersion).toBe("3");
    expect(placement.offerDependency.acceptedWholesalePriceMinorUnits).toBe(1_000);
    expect(ListingPlacement.safeParse(placement).success).toBe(true);
  });

  it("refuses a dependency with no accepted version", () => {
    const dependency = { ...offerDependency() } as Record<string, unknown>;
    delete dependency.acceptedOfferSourceRecordVersion;
    expect(
      ListingPlacement.safeParse(promotedPlacement({ offerDependency: dependency })).success,
    ).toBe(false);
  });

  it("does not duplicate the whole Offer", () => {
    const keys = Object.keys(offerDependency());
    for (const notCopied of ["terms", "lifecycle", "availability", "effectiveInterval", "economics"]) {
      expect(keys).not.toContain(notCopied);
    }
  });

  it("31. requires review when the wholesale price changed", () => {
    expect(
      evaluateUpstreamOfferReview({
        acceptedOfferSourceRecordVersion: "3",
        currentOfferSourceRecordVersion: "4",
        changeCategoriesSinceAccepted: ["WHOLESALE_PRICE_CHANGED"],
      }),
    ).toBe("REVIEW_REQUIRED");
    expect(offerChangeForcesReview("WHOLESALE_PRICE_CHANGED")).toBe(true);
    expect(offerChangeForcesReview("COMMISSION_TERMS_CHANGED")).toBe(true);
  });

  it("does not force review for an availability-only change", () => {
    expect(
      evaluateUpstreamOfferReview({
        acceptedOfferSourceRecordVersion: "3",
        currentOfferSourceRecordVersion: "4",
        changeCategoriesSinceAccepted: ["COMMERCIAL_AVAILABILITY_CHANGED"],
      }),
    ).toBe("NO_UPSTREAM_CHANGE");
    expect(offerChangeForcesReview("COMMERCIAL_AVAILABILITY_CHANGED")).toBe(false);
  });

  it("32. never silently accepts a new version", () => {
    const state = evaluateUpstreamOfferReview({
      acceptedOfferSourceRecordVersion: "3",
      currentOfferSourceRecordVersion: "4",
      changeCategoriesSinceAccepted: ["WHOLESALE_PRICE_CHANGED"],
    });
    expect(state).not.toBe("ACCEPTED_CURRENT_VERSION");

    // A review-required Listing is not buyer-active, so the old economics cannot
    // keep selling under the new Offer.
    const eligibility = evaluateListingBuyerEligibility(
      eligibilityInput({
        listingType: "PROMOTED",
        offer: { lifecycle: "ACTIVE", availability: "AVAILABLE" },
        upstreamReviewState: "REVIEW_REQUIRED",
      }),
    );
    expect(eligibility.buyerActive).toBe(false);
    expect(eligibility.blockingReasons).toContain("OFFER_VERSION_REVIEW_REQUIRED");
  });

  it("33. explicit acceptance of the new version restores the accepted state", () => {
    const reaccepted = promotedPlacement({
      offerDependency: offerDependency({
        acceptedOfferSourceRecordVersion: "4",
        acceptedWholesalePriceMinorUnits: 1_200,
        acceptedAt: "2027-03-01T00:00:00.000Z",
      }),
      upstreamReviewState: "ACCEPTED_CURRENT_VERSION",
    });
    expect(ListingPlacement.safeParse(reaccepted).success).toBe(true);
    expect(
      evaluateUpstreamOfferReview({
        acceptedOfferSourceRecordVersion: "4",
        currentOfferSourceRecordVersion: "4",
        changeCategoriesSinceAccepted: ["WHOLESALE_PRICE_CHANGED"],
      }),
    ).toBe("ACCEPTED_CURRENT_VERSION");

    const eligibility = evaluateListingBuyerEligibility(
      eligibilityInput({
        listingType: "PROMOTED",
        offer: { lifecycle: "ACTIVE", availability: "AVAILABLE" },
        upstreamReviewState: "ACCEPTED_CURRENT_VERSION",
      }),
    );
    expect(eligibility.buyerActive).toBe(true);
  });
});

// — 34-37. Upstream blocking —

describe("34-37. upstream states block a Listing", () => {
  it("is buyer-active when everything upstream is healthy", () => {
    expect(evaluateListingBuyerEligibility(eligibilityInput())).toEqual({
      buyerActive: true,
      blockingReasons: [],
    });
  });

  it("34. blocks on an unavailable Product", () => {
    for (const availability of ["unavailable", "pre-release", "discontinued"] as const) {
      const result = evaluateListingBuyerEligibility(
        eligibilityInput({ productAvailability: availability }),
      );
      expect(result.buyerActive).toBe(false);
      expect(result.blockingReasons).toContain("PRODUCT_UNAVAILABLE");
    }
  });

  it("35. blocks on a Storefront that is not publicly accessible", () => {
    for (const exposure of [
      { lifecycle: "SUSPENDED" as const, visibility: "PUBLIC" as const, goLiveApproval: "APPROVED" as const },
      { lifecycle: "ACTIVE" as const, visibility: "PRIVATE" as const, goLiveApproval: "APPROVED" as const },
      { lifecycle: "ACTIVE" as const, visibility: "PUBLIC" as const, goLiveApproval: "NOT_APPROVED" as const },
    ]) {
      const result = evaluateListingBuyerEligibility(
        eligibilityInput({ storefrontExposure: exposure }),
      );
      expect(result.buyerActive).toBe(false);
      expect(result.blockingReasons).toContain("STOREFRONT_NOT_PUBLICLY_ACCESSIBLE");
    }
  });

  it("36. blocks on an ineligible controlling participant or role", () => {
    const byStatus = evaluateListingBuyerEligibility(
      eligibilityInput({ controllingParticipantStatus: "SUSPENDED" }),
    );
    expect(byStatus.blockingReasons).toContain("CONTROLLING_PARTICIPANT_NOT_ACTIVE");

    const byRole = evaluateListingBuyerEligibility(
      eligibilityInput({ controllingRoleStatus: "DRAFT" }),
    );
    expect(byRole.blockingReasons).toContain("CONTROLLING_ROLE_NOT_ACTIVE");
  });

  it("37. blocks a promoted Listing on an unselectable Offer", () => {
    for (const offer of [
      { lifecycle: "SUSPENDED" as const, availability: "AVAILABLE" as const },
      { lifecycle: "ACTIVE" as const, availability: "TEMPORARILY_UNAVAILABLE" as const },
      { lifecycle: "WITHDRAWN" as const, availability: "AVAILABLE" as const },
    ]) {
      const result = evaluateListingBuyerEligibility(
        eligibilityInput({
          listingType: "PROMOTED",
          offer,
          upstreamReviewState: "ACCEPTED_CURRENT_VERSION",
        }),
      );
      expect(result.buyerActive).toBe(false);
      expect(result.blockingReasons).toContain("OFFER_NOT_COMMERCIALLY_SELECTABLE");
    }
  });

  it("blocks a promoted Listing with no Offer state supplied at all", () => {
    const result = evaluateListingBuyerEligibility(
      eligibilityInput({ listingType: "PROMOTED", upstreamReviewState: "NO_UPSTREAM_CHANGE" }),
    );
    expect(result.blockingReasons).toContain("OFFER_NOT_COMMERCIALLY_SELECTABLE");
  });

  it("blocks a Listing that is not itself ACTIVE", () => {
    for (const lifecycle of ["DRAFT", "SUSPENDED", "ENDED", "WITHDRAWN"] as const) {
      const result = evaluateListingBuyerEligibility(eligibilityInput({ lifecycle }));
      expect(result.blockingReasons).toContain("LISTING_NOT_ACTIVE");
    }
  });

  it("reports every failing condition, not just the first", () => {
    const result = evaluateListingBuyerEligibility(
      eligibilityInput({
        lifecycle: "SUSPENDED",
        productAvailability: "discontinued",
        controllingParticipantStatus: "CLOSED",
      }),
    );
    expect(result.blockingReasons).toHaveLength(3);
  });

  it("applies no Offer reason to a seller-direct Listing", () => {
    const result = evaluateListingBuyerEligibility(eligibilityInput());
    expect(result.blockingReasons).not.toContain("OFFER_NOT_COMMERCIALLY_SELECTABLE");
    expect(result.blockingReasons).not.toContain("OFFER_VERSION_REVIEW_REQUIRED");
  });

  it("names bounded reasons only", () => {
    expect(LISTING_BLOCKING_REASONS).toHaveLength(7);
    for (const reason of LISTING_BLOCKING_REASONS) {
      expect(reason).toMatch(/^[A-Z_]+$/);
    }
  });
});

// — 38. Privacy —

describe("38. private, risk, and payment fields cannot be recorded", () => {
  it("refuses every named private field on the record", () => {
    for (const field of NEVER_ON_LISTING_SOURCE_RECORD) {
      expect(
        ListingSourceRecord.safeParse({ ...record(sellerPlacement()), [field]: "x" }).success,
      ).toBe(false);
    }
  });

  it("refuses every named private field on the immutable version", () => {
    for (const field of NEVER_ON_LISTING_SOURCE_RECORD) {
      expect(
        ListingSourceVersion.safeParse({ ...version(sellerPlacement()), [field]: "x" }).success,
      ).toBe(false);
    }
  });

  it("names risk and payment data explicitly among the refusals", () => {
    for (const field of [
      "riskScore",
      "riskClassification",
      "cardNetworkRiskData",
      "underwritingData",
      "paymentProviderToken",
      "stripeAccountId",
      "payoutCredentials",
      "reserveAmount",
      "payoutHold",
      "email",
      "accountId",
      "moderationNotes",
    ]) {
      expect(NEVER_ON_LISTING_SOURCE_RECORD).toContain(field);
    }
  });

  it("stores no derived value as a competing source of truth", () => {
    const parsed = ListingSourceRecord.parse(record(sellerPlacement({ sale: saleSchedule() })));
    const serialized = JSON.stringify(parsed);
    for (const derived of [
      "effectivePrice",
      "saleActive",
      "monacadoFee",
      "promoterProceeds",
      "promoterMarginRate",
      "minimumViableRetail",
      "buyerActive",
      "isLive",
    ]) {
      expect(serialized).not.toContain(derived);
    }
  });

  it("defers risk management and Listing publication explicitly", () => {
    for (const deferred of [
      "riskManagement",
      "wholesaleAcquisitionPolicyLookup",
      "wholesaleAcquisitionPolicyOverrides",
      "capsuleProjection",
      "listingNode",
      "publicationState",
      "persistence",
      "checkout",
      "payoutLogic",
    ]) {
      expect(DEFERRED_LISTING_EXTENSIONS).toContain(deferred);
    }
  });

  it("introduces no capsule, Node, or publication machinery", () => {
    const src = readFileSync(
      new URL("../src/contracts/marketplace/listing-source.ts", import.meta.url).pathname,
      "utf8",
    );
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    for (const forbidden of ["@context", "bindsToNode", "an:node:", "capsuleId", "publishedBy", "PrismaClient"]) {
      expect(code).not.toContain(forbidden);
    }
  });
});
