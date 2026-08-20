/**
 * MoR transaction accounting contract tests (Phase 0M.T1).
 *
 * Pure decisions only — no database, no clock, no network. The persistence,
 * exact-binding, and reconstruction behaviour is asserted by
 * `transaction-accounting.integration.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  DEFERRED_TRANSACTION_ACCOUNTING_EXTENSIONS,
  NEVER_ON_TRANSACTION_ECONOMIC_SNAPSHOT,
  PASS_THROUGH_AMOUNT_FIELDS,
  ProviderTransactionRef,
  RecordTransactionEconomicSnapshotInput,
  TRANSACTION_SETTLEMENT_STATES,
  TRANSACTION_SETTLEMENT_TRANSITIONS,
  TransactionAccountingError,
  TransactionEconomicSnapshotRecord,
  TransactionEconomics,
  buyerChargedTotalMinorUnits,
  isTerminalTransactionSettlementState,
  isValidTransactionSettlementTransition,
  reconcileTransactionEconomics,
} from "../src/contracts/marketplace/transaction-accounting";
import {
  CommercialRetailBasis,
  calculatePromotedListingEconomics,
  calculateSellerDirectEconomics,
} from "../src/contracts/marketplace/listing-source";

/** Crockford base32 excludes I, L, O, and U; every fixture body is 26 characters. */
function body(seed: string): string {
  return (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);
}

const POLICY = {
  policyId: `mon:cpol:${body("T1TPCY")}`,
  policyVersion: "1",
  currency: "USD",
  /** 7.5% */
  retainedPercentageBasisPoints: 750,
  /** $1.00 */
  retainedFixedAmountMinorUnits: 100,
  roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
} as const;

const LISTING_BINDING = {
  internalListingId: `mon:listing:${body("T1TLST")}`,
  listingSourceRecordId: `mon:srec:${body("T1TLSTSREC")}`,
  listingSourceRecordVersion: "1",
};

const OFFER_BINDING = {
  internalOfferId: `mon:offer:${body("T1T0FFER")}`,
  offerSourceRecordId: `mon:srec:${body("T1T0FFERSREC")}`,
  offerSourceRecordVersion: "1",
};

const POLICY_BINDING = { policyId: POLICY.policyId, policyVersion: POLICY.policyVersion };

const NO_PASS_THROUGH = {
  taxAmountMinorUnits: 0,
  shippingAmountMinorUnits: 0,
  otherPassThroughAmountMinorUnits: 0,
};

describe("0M.T1 — the $100 standard-policy example", () => {
  it("reproduces the seller-direct figures in the business model §C", () => {
    const economics = calculateSellerDirectEconomics({
      placement: {
        listingType: "SELLER_DIRECT",
        retail: { retailPriceMinorUnits: 10_000, retailPriceCurrency: "USD" },
        sale: null,
      },
      now: "2027-12-01T00:00:00.000Z",
      policy: POLICY,
    });

    // $8.50 retained, $91.50 acquired, all of it the seller's.
    expect(economics.monacadoRetainedAmountMinorUnits).toBe(850);
    expect(economics.morWholesaleAcquisitionAmountMinorUnits).toBe(9_150);
    expect(economics.sellerProceedsMinorUnits).toBe(9_150);
  });

  it("reproduces the promoted figures in the business model §D", () => {
    const economics = calculatePromotedListingEconomics({
      commercialRetailPriceMinorUnits: 10_000,
      currency: "USD",
      offerWholesalePriceMinorUnits: 5_000,
      offerWholesalePriceCurrency: "USD",
      sellerFundedCommissionMinorUnits: 1_000,
      policy: POLICY,
    });

    expect(economics.monacadoRetainedAmountMinorUnits).toBe(850);
    expect(economics.morWholesaleAcquisitionAmountMinorUnits).toBe(9_150);
    expect(economics.sellerProceedsMinorUnits).toBe(4_000);
    expect(economics.promoterRetailSpreadMinorUnits).toBe(4_150);
    expect(economics.promoterNetProceedsMinorUnits).toBe(5_150);

    // The identity, restated as the snapshot records it.
    reconcileTransactionEconomics({
      commercialRetailAmountMinorUnits: 10_000,
      economics: {
        transactionType: "PROMOTED",
        offerBinding: OFFER_BINDING,
        monacadoRetainedAmountMinorUnits: 850,
        morWholesaleAcquisitionAmountMinorUnits: 9_150,
        offerWholesalePriceMinorUnits: 5_000,
        sellerFundedCommissionMinorUnits: 1_000,
        promoterRetailSpreadMinorUnits: 4_150,
        promoterNetProceedsMinorUnits: 5_150,
        sellerProceedsMinorUnits: 4_000,
      },
    });
  });
});

describe("0M.T1 — the accounting identity", () => {
  const promoted = {
    transactionType: "PROMOTED" as const,
    offerBinding: OFFER_BINDING,
    monacadoRetainedAmountMinorUnits: 850,
    morWholesaleAcquisitionAmountMinorUnits: 9_150,
    offerWholesalePriceMinorUnits: 5_000,
    sellerFundedCommissionMinorUnits: 1_000,
    promoterRetailSpreadMinorUnits: 4_150,
    promoterNetProceedsMinorUnits: 5_150,
    sellerProceedsMinorUnits: 4_000,
  };

  it("accepts a balanced seller-direct sale", () => {
    reconcileTransactionEconomics({
      commercialRetailAmountMinorUnits: 10_000,
      economics: {
        transactionType: "SELLER_DIRECT",
        monacadoRetainedAmountMinorUnits: 850,
        morWholesaleAcquisitionAmountMinorUnits: 9_150,
        sellerProceedsMinorUnits: 9_150,
      },
    });
  });

  it("refuses seller proceeds that are not Offer wholesale less the commission", () => {
    expect(() =>
      reconcileTransactionEconomics({
        commercialRetailAmountMinorUnits: 10_000,
        economics: { ...promoted, sellerProceedsMinorUnits: 3_999 },
      }),
    ).toThrowError(expect.objectContaining({ code: "SELLER_PROCEEDS_IMBALANCE" }));
  });

  it("refuses an acquisition amount that does not complement the retained amount", () => {
    expect(() =>
      reconcileTransactionEconomics({
        commercialRetailAmountMinorUnits: 10_000,
        economics: { ...promoted, morWholesaleAcquisitionAmountMinorUnits: 9_100 },
      }),
    ).toThrowError(expect.objectContaining({ code: "ACQUISITION_IMBALANCE" }));
  });

  it("refuses a promoter spread that is not acquisition less Offer wholesale", () => {
    expect(() =>
      reconcileTransactionEconomics({
        commercialRetailAmountMinorUnits: 10_000,
        economics: { ...promoted, promoterRetailSpreadMinorUnits: 4_000 },
      }),
    ).toThrowError(expect.objectContaining({ code: "PROMOTER_SPREAD_IMBALANCE" }));
  });

  it("refuses promoter net that is not spread plus commission", () => {
    expect(() =>
      reconcileTransactionEconomics({
        commercialRetailAmountMinorUnits: 10_000,
        economics: { ...promoted, promoterNetProceedsMinorUnits: 5_200 },
      }),
    ).toThrowError(expect.objectContaining({ code: "PROMOTER_NET_IMBALANCE" }));
  });

  it("closes over retail for every economics the calculator produces", () => {
    /* The three-party identity is IMPLIED by the component checks above — given
       acq + retained = R, spread = acq − W, net = spread + C, and seller = W − C,
       the sum telescopes to R. The final check is therefore defence in depth
       rather than an independent condition, and this asserts the implication
       holds across the range rather than pretending an unreachable branch is
       covered. */
    for (const retail of [10_00, 100_00, 999_99, 1_000_000_00]) {
      for (const wholesale of [0, 50, 5_00]) {
        for (const commission of [0, 25, 50]) {
          if (commission > wholesale) continue;
          const e = calculatePromotedListingEconomics({
            commercialRetailPriceMinorUnits: retail,
            currency: "USD",
            offerWholesalePriceMinorUnits: wholesale,
            offerWholesalePriceCurrency: "USD",
            sellerFundedCommissionMinorUnits: commission,
            policy: POLICY,
          });
          reconcileTransactionEconomics({
            commercialRetailAmountMinorUnits: retail,
            economics: {
              transactionType: "PROMOTED",
              offerBinding: OFFER_BINDING,
              monacadoRetainedAmountMinorUnits: e.monacadoRetainedAmountMinorUnits,
              morWholesaleAcquisitionAmountMinorUnits:
                e.morWholesaleAcquisitionAmountMinorUnits,
              offerWholesalePriceMinorUnits: e.offerWholesalePriceMinorUnits,
              sellerFundedCommissionMinorUnits: e.sellerFundedCommissionMinorUnits,
              promoterRetailSpreadMinorUnits: e.promoterRetailSpreadMinorUnits,
              promoterNetProceedsMinorUnits: e.promoterNetProceedsMinorUnits,
              sellerProceedsMinorUnits: e.sellerProceedsMinorUnits,
            },
          });
        }
      }
    }
  });

  it("refuses a seller-direct sale where seller and Monacado miss retail", () => {
    expect(() =>
      reconcileTransactionEconomics({
        commercialRetailAmountMinorUnits: 10_000,
        economics: {
          transactionType: "SELLER_DIRECT",
          monacadoRetainedAmountMinorUnits: 850,
          morWholesaleAcquisitionAmountMinorUnits: 9_150,
          sellerProceedsMinorUnits: 9_000,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "RECONCILIATION_IMBALANCE" }));
  });

  it("raises TransactionAccountingError, so the service can map it to one refusal", () => {
    try {
      reconcileTransactionEconomics({
        commercialRetailAmountMinorUnits: 1,
        economics: { ...promoted },
      });
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(TransactionAccountingError);
    }
  });
});

describe("0M.T1 — tax, shipping, and pass-through stay outside the commercial basis", () => {
  it("keeps every pass-through field out of the commercial retail basis", () => {
    /* Structural, not remembered: CommercialRetailBasis is a strictObject over the
       merchandise price alone, so a pass-through amount has nowhere to enter. */
    for (const field of PASS_THROUGH_AMOUNT_FIELDS) {
      expect(
        CommercialRetailBasis.safeParse({
          commercialRetailPriceMinorUnits: 10_000,
          currency: "USD",
          [field]: 500,
        }).success,
      ).toBe(false);
    }
  });

  it("does not change the 7.5% + $1 economics when tax and shipping are charged", () => {
    const bare = calculateSellerDirectEconomics({
      placement: {
        listingType: "SELLER_DIRECT",
        retail: { retailPriceMinorUnits: 10_000, retailPriceCurrency: "USD" },
        sale: null,
      },
      now: "2027-12-01T00:00:00.000Z",
      policy: POLICY,
    });

    const withCharges = TransactionEconomicSnapshotRecord.parse({
      snapshotId: `mon:txsnp:${body("T1TSNAP")}`,
      listingBinding: LISTING_BINDING,
      policyBinding: POLICY_BINDING,
      commercialRetailAmountMinorUnits: 10_000,
      currency: "USD",
      economics: {
        transactionType: "SELLER_DIRECT",
        monacadoRetainedAmountMinorUnits: bare.monacadoRetainedAmountMinorUnits,
        morWholesaleAcquisitionAmountMinorUnits:
          bare.morWholesaleAcquisitionAmountMinorUnits,
        sellerProceedsMinorUnits: bare.sellerProceedsMinorUnits,
      },
      passThrough: {
        taxAmountMinorUnits: 825,
        shippingAmountMinorUnits: 599,
        otherPassThroughAmountMinorUnits: 100,
      },
      occurredAt: "2027-12-01T00:00:00.000Z",
      recordedAt: "2027-12-01T00:00:00.000Z",
    });

    // Unchanged by $15.24 of charges the buyer also paid.
    expect(withCharges.economics.monacadoRetainedAmountMinorUnits).toBe(850);
    expect(withCharges.economics.sellerProceedsMinorUnits).toBe(9_150);
    // And the identity still holds over the commercial amount alone.
    reconcileTransactionEconomics({
      commercialRetailAmountMinorUnits: withCharges.commercialRetailAmountMinorUnits,
      economics: withCharges.economics,
    });
    // The buyer's total is derived, never stored.
    expect(buyerChargedTotalMinorUnits(withCharges)).toBe(11_524);
    expect(Object.keys(withCharges)).not.toContain("buyerChargedTotalMinorUnits");
  });

  it("names no tax rate, jurisdiction, nexus, or remittance concept anywhere", () => {
    for (const forbidden of [
      "taxRate",
      "taxJurisdiction",
      "taxNexus",
      "taxabilityClass",
      "taxRemittedAt",
      "refundAmountMinorUnits",
      "chargebackAmountMinorUnits",
      "payoutId",
      "buyerEmail",
      "cardLast4",
      "riskScore",
    ]) {
      expect(NEVER_ON_TRANSACTION_ECONOMIC_SNAPSHOT).toContain(forbidden);
      expect(
        RecordTransactionEconomicSnapshotInput.safeParse({
          internalListingId: LISTING_BINDING.internalListingId,
          listingSourceRecordVersion: "1",
          policyId: POLICY.policyId,
          policyVersion: "1",
          currency: "USD",
          ...NO_PASS_THROUGH,
          occurredAt: "2027-12-01T00:00:00.000Z",
          recordedAt: "2027-12-01T00:00:00.000Z",
          [forbidden]: 1,
        }).success,
      ).toBe(false);
    }
  });
});

describe("0M.T1 — the two transaction types are structurally distinct", () => {
  it("gives a seller-direct sale no field for an Offer binding or promoter economics", () => {
    for (const field of [
      "offerBinding",
      "offerWholesalePriceMinorUnits",
      "sellerFundedCommissionMinorUnits",
      "promoterRetailSpreadMinorUnits",
      "promoterNetProceedsMinorUnits",
    ]) {
      expect(
        TransactionEconomics.safeParse({
          transactionType: "SELLER_DIRECT",
          monacadoRetainedAmountMinorUnits: 850,
          morWholesaleAcquisitionAmountMinorUnits: 9_150,
          sellerProceedsMinorUnits: 9_150,
          [field]: field === "offerBinding" ? OFFER_BINDING : 0,
        }).success,
      ).toBe(false);
    }
  });

  it("requires the Offer binding and every promoter figure on a promoted sale", () => {
    expect(
      TransactionEconomics.safeParse({
        transactionType: "PROMOTED",
        monacadoRetainedAmountMinorUnits: 850,
        morWholesaleAcquisitionAmountMinorUnits: 9_150,
        sellerProceedsMinorUnits: 4_000,
      }).success,
    ).toBe(false);
  });

  it("permits a negative promoter spread but never negative promoter net proceeds", () => {
    // A seller-funded commission may legitimately carry a sub-wholesale retail price.
    const parsed = TransactionEconomics.parse({
      transactionType: "PROMOTED",
      offerBinding: OFFER_BINDING,
      monacadoRetainedAmountMinorUnits: 850,
      morWholesaleAcquisitionAmountMinorUnits: 9_150,
      offerWholesalePriceMinorUnits: 9_500,
      sellerFundedCommissionMinorUnits: 500,
      promoterRetailSpreadMinorUnits: -350,
      promoterNetProceedsMinorUnits: 150,
      sellerProceedsMinorUnits: 9_000,
    });
    expect(parsed).toMatchObject({ promoterRetailSpreadMinorUnits: -350 });

    expect(
      TransactionEconomics.safeParse({ ...parsed, promoterNetProceedsMinorUnits: -1 }).success,
    ).toBe(false);
  });
});

describe("0M.T1 — settlement lifecycle", () => {
  it("has exactly the four provider-neutral states", () => {
    expect([...TRANSACTION_SETTLEMENT_STATES]).toEqual([
      "PENDING",
      "FUNDS_RECEIVED",
      "SETTLED",
      "REVERSED",
    ]);
  });

  it("moves forward along the funds path and never backwards", () => {
    expect(isValidTransactionSettlementTransition("PENDING", "FUNDS_RECEIVED")).toBe(true);
    expect(isValidTransactionSettlementTransition("FUNDS_RECEIVED", "SETTLED")).toBe(true);
    expect(isValidTransactionSettlementTransition("PENDING", "SETTLED")).toBe(false);
    expect(isValidTransactionSettlementTransition("SETTLED", "FUNDS_RECEIVED")).toBe(false);
    expect(isValidTransactionSettlementTransition("REVERSED", "FUNDS_RECEIVED")).toBe(false);
  });

  it("reaches REVERSED from every non-terminal state, and never leaves it", () => {
    for (const from of ["PENDING", "FUNDS_RECEIVED", "SETTLED"] as const) {
      expect(isValidTransactionSettlementTransition(from, "REVERSED")).toBe(true);
    }
    expect(isTerminalTransactionSettlementState("REVERSED")).toBe(true);
    expect(TRANSACTION_SETTLEMENT_TRANSITIONS.REVERSED).toEqual([]);
  });

  it("names no provider-shaped or payout concept in the state vocabulary", () => {
    const vocabulary = TRANSACTION_SETTLEMENT_STATES.join(" ").toLowerCase();
    for (const term of ["stripe", "charge", "payout", "transfer", "balance", "refund"]) {
      expect(vocabulary).not.toContain(term);
    }
  });
});

describe("0M.T1 — the provider transaction reference", () => {
  it("accepts an opaque external reference", () => {
    expect(ProviderTransactionRef.safeParse("pi_3QxYzAbCdEf12345").success).toBe(true);
  });

  it("refuses a Monacado identifier and every provider-secret shape", () => {
    for (const bad of [
      `mon:txsnp:${body("T1TSNAP")}`,
      "sk_live_abc",
      "rk_test_abc",
      "pk_live_abc",
      "whsec_abc",
      "Bearer abc",
      " padded ",
      "",
    ]) {
      expect(ProviderTransactionRef.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("0M.T1 — phase boundary", () => {
  it("records what this phase deliberately does not implement", () => {
    for (const deferred of [
      "order and order-line records",
      "checkout",
      "payment initiation",
      "payout execution",
      "tax calculation",
      "nexus determination",
      "tax remittance and filing",
      "refund and chargeback accounting",
      "processor reconciliation workflows",
    ]) {
      expect(DEFERRED_TRANSACTION_ACCOUNTING_EXTENSIONS).toContain(deferred);
    }
  });

  it("requires the pass-through amounts explicitly, with no silent zero default", () => {
    const withoutTax = {
      internalListingId: LISTING_BINDING.internalListingId,
      listingSourceRecordVersion: "1",
      policyId: POLICY.policyId,
      policyVersion: "1",
      currency: "USD",
      shippingAmountMinorUnits: 0,
      otherPassThroughAmountMinorUnits: 0,
      occurredAt: "2027-12-01T00:00:00.000Z",
      recordedAt: "2027-12-01T00:00:00.000Z",
    };
    expect(RecordTransactionEconomicSnapshotInput.safeParse(withoutTax).success).toBe(false);
    expect(
      RecordTransactionEconomicSnapshotInput.safeParse({
        ...withoutTax,
        taxAmountMinorUnits: 0,
      }).success,
    ).toBe(true);
  });

  it("takes no commercial retail price parameter — it is read from the bound version", () => {
    expect(
      RecordTransactionEconomicSnapshotInput.safeParse({
        internalListingId: LISTING_BINDING.internalListingId,
        listingSourceRecordVersion: "1",
        policyId: POLICY.policyId,
        policyVersion: "1",
        currency: "USD",
        ...NO_PASS_THROUGH,
        occurredAt: "2027-12-01T00:00:00.000Z",
        recordedAt: "2027-12-01T00:00:00.000Z",
        commercialRetailAmountMinorUnits: 1,
      }).success,
    ).toBe(false);
  });
});
