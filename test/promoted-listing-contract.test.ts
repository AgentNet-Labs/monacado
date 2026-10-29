/**
 * Phase 1.45 — the pure promoted-Listing decisions: retail economics under the
 * governing terms, Promoter readiness, and the ordered activation/transaction
 * gate. No database.
 */

import { describe, expect, it } from "vitest";
import {
  ActivatePromotedListingInput,
  CreatePromotedListingDraftInput,
  PROMOTED_LISTING_BLOCKERS,
  PROMOTED_LISTING_NOT_EVALUATED,
  decidePromotedListingCommerce,
  evaluatePromotedRetail,
  evaluatePromoterReadiness,
  type GoverningOfferTerms,
  type PromotedListingCommerceFacts,
  type PromoterReadinessFacts,
} from "../src/contracts/marketplace/promoted-listing";
import type { RecordedOfferAcceptance } from "../src/contracts/marketplace/promotion-offer-acceptance";
import {
  ACTIVE_LISTINGS_INCLUDED_PER_STOREFRONT,
  ListingPlacement,
  LISTING_BLOCKING_REASONS,
} from "../src/contracts/marketplace/listing-source";

/* Synthetic, in the shape of the Contract's §18 rule: 7.5% of retail + $1.00. */
const POLICY = {
  policyId: "mon:policy:acquisition/synthetic",
  policyVersion: "1",
  currency: "USD",
  retainedPercentageBasisPoints: 750,
  retainedFixedAmountMinorUnits: 100,
  roundingPolicy: "HALF_UP_TO_MINOR_UNIT" as const,
};

/** $40.00 wholesale, $4.00 Seller-funded commission. */
const TERMS: GoverningOfferTerms = {
  sourceRecordVersion: "1",
  wholesalePriceMinorUnits: 4_000,
  currency: "USD",
  calculatedCommissionMinorUnits: 400,
};

const usd = (retailPriceMinorUnits: number) => ({ retailPriceMinorUnits, retailPriceCurrency: "USD" });

describe("Phase 1.45 — promoted retail economics", () => {
  it("passes ZERO Promoter proceeds: $40.00 retail over $40.00 wholesale and a $4.00 commission", () => {
    /* retained = 7.5% × 4000 + 100 = 400; Seller proceeds = 4000 − 400 = 3600;
       Promoter = 4000 − 400 − 3600 = 0. */
    const result = evaluatePromotedRetail({ retail: usd(4_000), terms: TERMS, policy: POLICY });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.economics.promoterNetProceedsMinorUnits).toBe(0);
    expect(result.economics.monacadoRetainedAmountMinorUnits).toBe(400);
    expect(result.minimumViableRetailMinorUnits).toBe(4_000);
  });

  it("refuses NEGATIVE Promoter proceeds one minor unit lower", () => {
    /* 3999: retained = round(299.925) + 100 = 400, so the Promoter is −1. */
    const result = evaluatePromotedRetail({ retail: usd(3_999), terms: TERMS, policy: POLICY });
    expect(result).toEqual({ ok: false, blocker: "NEGATIVE_PROMOTER_PROCEEDS", minimumViableRetailMinorUnits: 4_000 });
  });

  it("answers a price below the fixed retention as negative Promoter proceeds, not a lower-level code", () => {
    const result = evaluatePromotedRetail({ retail: usd(50), terms: TERMS, policy: POLICY });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.blocker).toBe("NEGATIVE_PROMOTER_PROCEEDS");
  });

  it("refuses with no price, no policy, and a currency mismatch — each its own code", () => {
    expect(evaluatePromotedRetail({ retail: null, terms: TERMS, policy: POLICY })).toMatchObject({
      ok: false,
      blocker: "RETAIL_PRICE_MISSING",
      minimumViableRetailMinorUnits: 4_000,
    });
    /* Fails closed rather than inventing a rate. */
    expect(evaluatePromotedRetail({ retail: usd(9_000), terms: TERMS, policy: null })).toEqual({
      ok: false,
      blocker: "NO_EFFECTIVE_COMMERCIAL_POLICY",
      minimumViableRetailMinorUnits: null,
    });
    expect(
      evaluatePromotedRetail({ retail: { retailPriceMinorUnits: 9_000, retailPriceCurrency: "EUR" }, terms: TERMS, policy: POLICY }),
    ).toMatchObject({ ok: false, blocker: "RETAIL_CURRENCY_MISMATCH" });
  });

  it("uses the governing version's own commission — a promotion's terms change the minimum", () => {
    const promotion: GoverningOfferTerms = { ...TERMS, sourceRecordVersion: "2", wholesalePriceMinorUnits: 3_000, calculatedCommissionMinorUnits: 300 };
    const standing = evaluatePromotedRetail({ retail: usd(3_500), terms: TERMS, policy: POLICY });
    const running = evaluatePromotedRetail({ retail: usd(3_500), terms: promotion, policy: POLICY });
    expect(standing.ok).toBe(false);
    expect(running.ok).toBe(true);
  });
});

const READY_ACCOUNT = { emailVerifiedAt: "2026-01-01T00:00:00.000Z", firstName: "Pat", lastName: "Doe" };
const READY_PARTICIPANT = {
  status: "ACTIVE",
  suspended: false,
  restricted: false,
  promoterRoleStatus: "ACTIVE",
  paymentReadiness: "ENABLED",
  commerceApproval: "APPROVED",
};

describe("Phase 1.45 — Promoter readiness", () => {
  it("is empty for a fully ready Promoter", () => {
    expect(evaluatePromoterReadiness({ account: READY_ACCOUNT, participant: READY_PARTICIPANT })).toEqual([]);
  });

  it("reports every blocker, in order", () => {
    const facts: PromoterReadinessFacts = {
      account: { emailVerifiedAt: null, firstName: " ", lastName: null },
      participant: {
        status: "DRAFT",
        suspended: true,
        restricted: true,
        promoterRoleStatus: "PENDING",
        paymentReadiness: "NOT_STARTED",
        commerceApproval: "NONE",
      },
    };
    expect(evaluatePromoterReadiness(facts)).toEqual([
      "EMAIL_UNVERIFIED",
      "FIRST_NAME_MISSING",
      "LAST_NAME_MISSING",
      "PARTICIPANT_SUSPENDED",
      "PARTICIPANT_NOT_ACTIVE",
      "PROMOTER_ROLE_NOT_ACTIVE",
      "PAYMENT_NOT_READY",
      "COMMERCE_APPROVAL_MISSING",
      "PARTICIPANT_RESTRICTED",
    ]);
  });

  it("stops at a missing participant", () => {
    expect(evaluatePromoterReadiness({ account: READY_ACCOUNT, participant: null })).toEqual(["PARTICIPANT_MISSING"]);
  });
});

type Acceptance = RecordedOfferAcceptance & { id: string };
const ELIGIBLE_TERMS = {
  notEvaluated: [],
  eligible: true as const,
  governing: {
    internalOfferId: "o",
    offerSourceRecordId: "s",
    standingVersion: "1",
    promotionVersion: null,
    termsKind: "STANDING" as const,
  },
  authorizationId: "a",
  acceptance: { id: "x" } as unknown as Acceptance,
};

function facts(overrides: Partial<PromotedListingCommerceFacts<Acceptance>> = {}): PromotedListingCommerceFacts<Acceptance> {
  return {
    purpose: "ACTIVATION",
    lifecycle: "DRAFT",
    retailPresent: true,
    terms: ELIGIBLE_TERMS as PromotedListingCommerceFacts<Acceptance>["terms"],
    storefront: { controllerHasAuthority: true, ownedBySeller: false, publiclyAccessible: false, activeListingCount: 0 },
    promoterReadiness: [],
    sellerMayTransact: true,
    economics: evaluatePromotedRetail({ retail: usd(5_000), terms: TERMS, policy: POLICY }),
    activeListingAllowance: ACTIVE_LISTINGS_INCLUDED_PER_STOREFRONT,
    ...overrides,
  };
}

describe("Phase 1.45 — the promoted Listing commerce gate", () => {
  it("activates a ready DRAFT, and always names what it did not evaluate", () => {
    const decision = decidePromotedListingCommerce(facts());
    expect(decision).toEqual({ eligible: true, blockers: [], notEvaluated: PROMOTED_LISTING_NOT_EVALUATED });
  });

  it("includes five ACTIVE Listings per Storefront: the fifth activates, the sixth does not", () => {
    expect(ACTIVE_LISTINGS_INCLUDED_PER_STOREFRONT).toBe(5);
    const at = (activeListingCount: number) =>
      decidePromotedListingCommerce(
        facts({ storefront: { controllerHasAuthority: true, ownedBySeller: false, publiclyAccessible: false, activeListingCount } }),
      );
    expect(at(4).eligible).toBe(true);
    expect(at(5).blockers).toEqual(["STOREFRONT_ACTIVE_LISTING_LIMIT"]);
  });

  it("does not apply the limit, or require a draft, to a TRANSACTION — but requires public exposure and Seller standing", () => {
    const decision = decidePromotedListingCommerce(
      facts({
        purpose: "TRANSACTION",
        lifecycle: "ACTIVE",
        sellerMayTransact: false,
        storefront: { controllerHasAuthority: true, ownedBySeller: false, publiclyAccessible: false, activeListingCount: 99 },
      }),
    );
    expect(decision.blockers).toEqual(["SELLER_NOT_PERMITTED", "STOREFRONT_NOT_PUBLICLY_ACCESSIBLE"]);
  });

  it("reports every blocker in the declared order, deduplicated", () => {
    const decision = decidePromotedListingCommerce(
      facts({
        lifecycle: "ACTIVE",
        retailPresent: false,
        terms: { notEvaluated: [], eligible: false, blockers: ["AUTHORIZATION_NOT_APPROVED", "PRODUCT_NOT_ACTIVE"] },
        storefront: { controllerHasAuthority: false, ownedBySeller: true, publiclyAccessible: false, activeListingCount: 5 },
        promoterReadiness: ["PAYMENT_NOT_READY"],
        economics: evaluatePromotedRetail({ retail: null, terms: TERMS, policy: POLICY }),
      }),
    );
    expect(decision.eligible).toBe(false);
    expect(decision.blockers).toEqual([
      "LISTING_NOT_DRAFT",
      "PRODUCT_NOT_ACTIVE",
      "AUTHORIZATION_NOT_APPROVED",
      "STOREFRONT_AUTHORITY_REQUIRED",
      "STOREFRONT_OWNED_BY_SELLER",
      "PAYMENT_NOT_READY",
      "RETAIL_PRICE_MISSING",
      "STOREFRONT_ACTIVE_LISTING_LIMIT",
    ]);
    for (const b of decision.blockers) expect(PROMOTED_LISTING_BLOCKERS).toContain(b);
  });

  it("refuses negative proceeds at activation", () => {
    const decision = decidePromotedListingCommerce(
      facts({ economics: evaluatePromotedRetail({ retail: usd(3_999), terms: TERMS, policy: POLICY }) }),
    );
    expect(decision.blockers).toEqual(["NEGATIVE_PROMOTER_PROCEEDS"]);
  });
});

describe("Phase 1.45 — the package-based placement shape", () => {
  it("names no Offer, may be unpriced, and refuses a legacy binding beside it", () => {
    expect(ListingPlacement.safeParse({ listingType: "PROMOTED", termsBasis: "PROMOTION_PACKAGE", retail: null }).success).toBe(true);
    expect(
      ListingPlacement.safeParse({
        listingType: "PROMOTED",
        termsBasis: "PROMOTION_PACKAGE",
        retail: usd(5_000),
        offerDependency: { internalOfferId: "x" },
      }).success,
    ).toBe(false);
    expect(ListingPlacement.safeParse({ listingType: "PROMOTED", termsBasis: "OFFER_COPY", retail: null }).success).toBe(false);
  });

  it("takes only references and an optional price as draft input — no Offer, policy, or participant", () => {
    const base = {
      productRef: "mon:product:01J0000000000000000000000A",
      storefrontHandle: "shop",
      actingAccountId: "acct",
      now: "2026-10-29T00:00:00.000Z",
    };
    for (const extra of [{ offerRef: "x" }, { controllingParticipantId: "p" }, { acquisitionPolicy: POLICY }]) {
      expect(CreatePromotedListingDraftInput.safeParse({ ...base, ...extra }).success).toBe(false);
    }
    expect(ActivatePromotedListingInput.safeParse({ listingRef: "x", actingAccountId: "a", now: base.now }).success).toBe(false);
  });

  it("adds the bounded checkout-closure code to the buyer vocabulary", () => {
    expect(LISTING_BLOCKING_REASONS).toContain("PROMOTED_COMMERCE_NOT_ENABLED");
  });
});
