/**
 * Buyer checkout, Order, and post-sale contract tests (Phase 0M.9).
 *
 * Pure decisions only — no database, no clock, no network. The end-to-end
 * transaction flow is asserted by `buyer-checkout-and-order.integration.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  BuyerIdentity,
  NEVER_ON_ORDER,
  ORDER_LIFECYCLE_STATES,
  ORDER_LIFECYCLE_TRANSITIONS,
  OrderQuote,
  PlaceOrderInput,
  isTerminalOrderLifecycleState,
  isValidOrderLifecycleTransition,
  orderRepresentsCompletedSale,
  quotedBuyerTotalMinorUnits,
} from "../src/contracts/marketplace/order";
import {
  BuyerPaymentRequest,
  BuyerPaymentResult,
  NEVER_ON_BUYER_PAYMENT_REQUEST,
  paymentSucceeded,
} from "../src/contracts/marketplace/buyer-payment";
import {
  NEVER_ON_PROCEEDS_OBLIGATION,
  PROCEEDS_OBLIGATION_STATES,
  ProceedsParty,
  deriveProceedsClaims,
  isValidProceedsObligationTransition,
} from "../src/contracts/marketplace/proceeds-obligation";
import {
  NEVER_ON_PURCHASE_EVIDENCE,
  evaluatePurchaseReviewEligibility,
  reviewSubjectRefFor,
  toReviewSubmissionAuthorityView,
} from "../src/contracts/marketplace/purchase-evidence";
import { CommercialRetailBasis } from "../src/contracts/marketplace/listing-source";

const body = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const ORDER_ID = `mon:order:${body("M9C0RD")}`;
const ACCOUNT_ID = `mon:acct:${body("M9CACCT")}`;
const PARTICIPANT_ID = `mon:mpart:${body("M9CPART")}`;
const PRODUCT_ID = `mon:product:${body("M9CPR0D")}`;
const LISTING_ID = `mon:listing:${body("M9CLST")}`;
const DIGEST = "a".repeat(64);

describe("0M.9 — buyer identity", () => {
  it("gives a guest no field for an account or a participant", () => {
    expect(
      BuyerIdentity.safeParse({
        buyerKind: "GUEST_BUYER",
        guestClaimCodeDigest: DIGEST,
        buyerAccountId: ACCOUNT_ID,
      }).success,
    ).toBe(false);
    expect(
      BuyerIdentity.safeParse({
        buyerKind: "GUEST_BUYER",
        guestClaimCodeDigest: DIGEST,
        buyerParticipantId: PARTICIPANT_ID,
      }).success,
    ).toBe(false);
  });

  it("gives an account buyer no field for a claim digest", () => {
    expect(
      BuyerIdentity.safeParse({
        buyerKind: "ACCOUNT_BUYER",
        buyerAccountId: ACCOUNT_ID,
        buyerParticipantId: null,
        guestClaimCodeDigest: DIGEST,
      }).success,
    ).toBe(false);
  });

  it("permits an account buyer with no participant — buying claims nothing", () => {
    expect(
      BuyerIdentity.parse({
        buyerKind: "ACCOUNT_BUYER",
        buyerAccountId: ACCOUNT_ID,
        buyerParticipantId: null,
      }),
    ).toMatchObject({ buyerParticipantId: null });
  });

  it("refuses a claim digest that is not a hex SHA-256", () => {
    for (const bad of ["", "not-a-digest", "A".repeat(64), "a".repeat(63)]) {
      expect(
        BuyerIdentity.safeParse({ buyerKind: "GUEST_BUYER", guestClaimCodeDigest: bad }).success,
        bad,
      ).toBe(false);
    }
  });
});

describe("0M.9 — order lifecycle", () => {
  it("has exactly the four states the flow needs", () => {
    expect([...ORDER_LIFECYCLE_STATES]).toEqual([
      "PENDING_PAYMENT",
      "PAID",
      "PAYMENT_FAILED",
      "CANCELLED",
    ]);
  });

  it("moves out of PENDING_PAYMENT three ways and never back into it", () => {
    expect(isValidOrderLifecycleTransition("PENDING_PAYMENT", "PAID")).toBe(true);
    expect(isValidOrderLifecycleTransition("PENDING_PAYMENT", "PAYMENT_FAILED")).toBe(true);
    expect(isValidOrderLifecycleTransition("PENDING_PAYMENT", "CANCELLED")).toBe(true);
    for (const from of ORDER_LIFECYCLE_STATES) {
      expect(isValidOrderLifecycleTransition(from, "PENDING_PAYMENT"), from).toBe(false);
    }
  });

  it("makes PAID terminal — a reversal is settlement standing, not an Order edit", () => {
    expect(isTerminalOrderLifecycleState("PAID")).toBe(true);
    expect(ORDER_LIFECYCLE_TRANSITIONS.PAID).toEqual([]);
  });

  it("never lets a failed payment become paid — a retry is a new Order", () => {
    expect(isValidOrderLifecycleTransition("PAYMENT_FAILED", "PAID")).toBe(false);
    expect(ORDER_LIFECYCLE_TRANSITIONS.PAYMENT_FAILED).toEqual(["CANCELLED"]);
  });

  it("treats only PAID as a completed sale", () => {
    for (const state of ORDER_LIFECYCLE_STATES) {
      expect(orderRepresentsCompletedSale(state), state).toBe(state === "PAID");
    }
  });
});

describe("0M.9 — the quote", () => {
  const quote = OrderQuote.parse({
    currency: "USD",
    quotedCommercialRetailAmountMinorUnits: 10_000,
    quotedTaxAmountMinorUnits: 825,
    quotedShippingAmountMinorUnits: 1_299,
    quotedOtherPassThroughAmountMinorUnits: 50,
  });

  it("derives the buyer total and stores none of it", () => {
    expect(quotedBuyerTotalMinorUnits(quote)).toBe(12_174);
    expect(Object.keys(quote)).not.toContain("quotedBuyerTotalMinorUnits");
    expect(NEVER_ON_ORDER).toContain("quotedBuyerTotalMinorUnits");
  });

  it("keeps tax, shipping, and pass-through outside the commercial basis", () => {
    /* Structural: CommercialRetailBasis is a strictObject over the merchandise
       price alone, so a pass-through amount has nowhere to enter a calculator. */
    for (const field of [
      "quotedTaxAmountMinorUnits",
      "quotedShippingAmountMinorUnits",
      "quotedOtherPassThroughAmountMinorUnits",
      "taxAmountMinorUnits",
      "shippingAmountMinorUnits",
    ]) {
      expect(
        CommercialRetailBasis.safeParse({
          commercialRetailPriceMinorUnits: 10_000,
          currency: "USD",
          [field]: 500,
        }).success,
        field,
      ).toBe(false);
    }
  });
});

describe("0M.9 — placing an Order accepts no commercial figure", () => {
  const valid = {
    internalListingId: LISTING_ID,
    buyerAccountId: null,
    taxAmountMinorUnits: 0,
    shippingAmountMinorUnits: 0,
    otherPassThroughAmountMinorUnits: 0,
    currency: "USD",
    productAvailability: "available",
    placedAt: "2027-12-01T00:00:00.000Z",
  };

  it("accepts the minimum a caller genuinely knows", () => {
    expect(PlaceOrderInput.safeParse(valid).success).toBe(true);
  });

  it("refuses every economic figure, and the source version too", () => {
    for (const forbidden of [
      "commercialRetailAmountMinorUnits",
      "quotedCommercialRetailAmountMinorUnits",
      "retailPriceMinorUnits",
      "monacadoRetainedAmountMinorUnits",
      "morWholesaleAcquisitionAmountMinorUnits",
      "sellerProceedsMinorUnits",
      "sellerFundedCommissionMinorUnits",
      "promoterNetProceedsMinorUnits",
      "listingSourceRecordVersion",
      "policyVersion",
      // Go-live approval was removed at the FIX NOW correction: a caller able to
      // pass APPROVED would be a caller able to make a Listing purchasable.
      "storefrontGoLiveApproval",
      "buyerEmail",
      "shippingAddress",
      "cardNumber",
    ]) {
      expect(
        PlaceOrderInput.safeParse({ ...valid, [forbidden]: 1 }).success,
        forbidden,
      ).toBe(false);
    }
  });

  it("requires the pass-through amounts explicitly, with no silent zero default", () => {
    const { taxAmountMinorUnits, ...withoutTax } = valid;
    expect(taxAmountMinorUnits).toBe(0);
    expect(PlaceOrderInput.safeParse(withoutTax).success).toBe(false);
  });

  it("treats a guest as the default rather than an exception", () => {
    expect(PlaceOrderInput.parse(valid).buyerAccountId).toBeNull();
  });
});

describe("0M.9 — the payment port", () => {
  const request = {
    orderId: ORDER_ID,
    provider: "STRIPE",
    currency: "USD",
    amountMinorUnits: 12_174,
    idempotencyKey: ORDER_ID,
  };

  it("carries the buyer's total and nothing about the commercial split", () => {
    expect(BuyerPaymentRequest.safeParse(request).success).toBe(true);
    for (const forbidden of NEVER_ON_BUYER_PAYMENT_REQUEST) {
      expect(
        BuyerPaymentRequest.safeParse({ ...request, [forbidden]: "x" }).success,
        forbidden,
      ).toBe(false);
    }
  });

  it("requires an idempotency key rather than accepting its absence", () => {
    const { idempotencyKey, ...withoutKey } = request;
    expect(idempotencyKey).toBeDefined();
    expect(BuyerPaymentRequest.safeParse(withoutKey).success).toBe(false);
  });

  it("refuses a zero-amount charge", () => {
    expect(BuyerPaymentRequest.safeParse({ ...request, amountMinorUnits: 0 }).success).toBe(
      false,
    );
  });

  it("makes success and failure structurally unmistakable", () => {
    const ok = BuyerPaymentResult.parse({
      outcome: "SUCCEEDED",
      provider: "STRIPE",
      providerTransactionRef: "pi_synthetic_1",
    });
    expect(paymentSucceeded(ok)).toBe(true);

    const bad = BuyerPaymentResult.parse({ outcome: "FAILED", failureCode: "DECLINED" });
    expect(paymentSucceeded(bad)).toBe(false);

    // A success carries no failure code, and a failure no provider reference.
    expect(
      BuyerPaymentResult.safeParse({ ...ok, failureCode: "DECLINED" }).success,
    ).toBe(false);
    expect(
      BuyerPaymentResult.safeParse({ ...bad, providerTransactionRef: "pi_x" }).success,
    ).toBe(false);
  });

  it("refuses a Monacado identifier or a provider secret as a transaction reference", () => {
    for (const ref of [ORDER_ID, "sk_live_abc", "whsec_abc", "Bearer abc"]) {
      expect(
        BuyerPaymentResult.safeParse({
          outcome: "SUCCEEDED",
          provider: "STRIPE",
          providerTransactionRef: ref,
        }).success,
        ref,
      ).toBe(false);
    }
  });
});

describe("0M.9 — proceeds obligations", () => {
  const promoted = {
    transactionType: "PROMOTED" as const,
    offerBinding: {
      internalOfferId: `mon:offer:${body("M9C0FFER")}`,
      offerSourceRecordId: `mon:srec:${body("M9C0SREC")}`,
      offerSourceRecordVersion: "1",
    },
    monacadoRetainedAmountMinorUnits: 850,
    morWholesaleAcquisitionAmountMinorUnits: 9_150,
    offerWholesalePriceMinorUnits: 5_000,
    sellerFundedCommissionMinorUnits: 1_000,
    promoterRetailSpreadMinorUnits: 4_150,
    promoterNetProceedsMinorUnits: 5_150,
    sellerProceedsMinorUnits: 4_000,
  };

  it("yields one claim for a seller-direct sale", () => {
    expect(
      deriveProceedsClaims({
        transactionType: "SELLER_DIRECT",
        monacadoRetainedAmountMinorUnits: 850,
        morWholesaleAcquisitionAmountMinorUnits: 9_150,
        sellerProceedsMinorUnits: 9_150,
      }),
    ).toEqual([{ party: "SELLER", amountMinorUnits: 9_150 }]);
  });

  it("yields two for a promoted sale, the promoter's being NET proceeds", () => {
    const claims = deriveProceedsClaims(promoted);
    expect(claims).toEqual([
      { party: "SELLER", amountMinorUnits: 4_000 },
      // Spread PLUS the seller-funded commission — never the spread alone.
      { party: "PROMOTER", amountMinorUnits: 5_150 },
    ]);
    expect(claims[1]!.amountMinorUnits).not.toBe(promoted.promoterRetailSpreadMinorUnits);
  });

  it("accounts for exactly what the buyer paid, with Monacado's retention", () => {
    const claims = deriveProceedsClaims(promoted);
    const owed = claims.reduce((sum, c) => sum + c.amountMinorUnits, 0);
    expect(owed + promoted.monacadoRetainedAmountMinorUnits).toBe(10_000);
  });

  it("has no party for Monacado — retention is kept, not owed", () => {
    expect([...PROCEEDS_OBLIGATION_STATES]).toEqual(["PENDING", "ELIGIBLE", "PAID"]);
    expect(ProceedsParty.safeParse("MONACADO").success).toBe(false);
  });

  it("advances forward only, and never un-pays", () => {
    expect(isValidProceedsObligationTransition("PENDING", "ELIGIBLE")).toBe(true);
    expect(isValidProceedsObligationTransition("ELIGIBLE", "PAID")).toBe(true);
    expect(isValidProceedsObligationTransition("PENDING", "PAID")).toBe(false);
    expect(isValidProceedsObligationTransition("PAID", "ELIGIBLE")).toBe(false);
    expect(isValidProceedsObligationTransition("ELIGIBLE", "PENDING")).toBe(false);
  });

  it("names payout execution, holds, and tax as things it does not hold", () => {
    for (const forbidden of ["payoutId", "transferId", "payoutHold", "taxWithheldMinorUnits"]) {
      expect(NEVER_ON_PROCEEDS_OBLIGATION).toContain(forbidden);
    }
  });
});

describe("0M.9 — review eligibility", () => {
  it("licenses a review only on a completed purchase, once", () => {
    expect(
      evaluatePurchaseReviewEligibility({
        orderCompleted: true,
        purchaseEvidenceExists: true,
        authorityAlreadyExists: false,
      }),
    ).toEqual({ eligible: true, blockers: [] });
  });

  it("reports every blocker rather than the first", () => {
    expect(
      evaluatePurchaseReviewEligibility({
        orderCompleted: false,
        purchaseEvidenceExists: false,
        authorityAlreadyExists: true,
      }).blockers,
    ).toEqual([
      "ORDER_NOT_COMPLETED",
      "PURCHASE_EVIDENCE_MISSING",
      "REVIEW_ALREADY_AUTHORIZED",
    ]);
  });

  it("names the Product for a product review and the seller for a seller review", () => {
    const subjects = { internalProductId: PRODUCT_ID, sellerParticipantId: PARTICIPANT_ID };
    expect(reviewSubjectRefFor("PRODUCT_REVIEW", subjects)).toBe(PRODUCT_ID);
    expect(reviewSubjectRefFor("SELLER_REVIEW", subjects)).toBe(PARTICIPANT_ID);
  });

  it("projects onto 0M.1's view, carrying evidence as a pointer and no lineage", () => {
    const view = toReviewSubmissionAuthorityView({
      authorityId: `mon:rauth:${body("M9CRAUTH")}`,
      reviewSubmissionId: `mon:rsub:${body("M9CRSUB")}`,
      orderId: ORDER_ID,
      purchaseEvidenceId: `mon:pvev:${body("M9CPVEV")}`,
      reviewKind: "PRODUCT_REVIEW",
      reviewSubjectRef: PRODUCT_ID,
      submitter: "GUEST_BUYER",
      purchaseProvenance: "VERIFIED",
      submissionState: "SUBMITTED",
      status: "ACTIVE",
      createdAt: "2027-12-01T00:00:00.000Z",
      updatedAt: "2027-12-01T00:00:00.000Z",
    });

    // The order id is storage lineage and must not reach an authority decision.
    expect(Object.keys(view)).not.toContain("orderId");
    expect(view.purchaseEvidenceRef).toMatch(/^mon:pvev:/);
    // A guest is a first-class submitter.
    expect(view.submitter).toBe("GUEST_BUYER");
  });

  it("names review content and publication state as things evidence never holds", () => {
    for (const forbidden of ["reviewText", "rating", "capsuleId", "publishedAt", "buyerEmail"]) {
      expect(NEVER_ON_PURCHASE_EVIDENCE).toContain(forbidden);
    }
  });
});

describe("0M.9 — what an Order never holds", () => {
  it("names buyer data, economics, settlement, and payouts as absent", () => {
    for (const forbidden of [
      "buyerEmail",
      "shippingAddress",
      "cardLast4",
      "sellerProceedsMinorUnits",
      "promoterNetProceedsMinorUnits",
      "settlementState",
      "reversedAt",
      "refundAmountMinorUnits",
      "payoutId",
    ]) {
      expect(NEVER_ON_ORDER).toContain(forbidden);
    }
  });
});
