/**
 * Pre-live commerce control contract tests (Phase 1.2).
 *
 * **NO NETWORK, NO TAX VENDOR, NO PAYMENT PROVIDER.** Every boundary is a pure
 * function or an injected double.
 *
 * Shape and refusal only. The end-to-end behaviour — that checkout refuses
 * without tax, that a denial blocks payment, that a reversal reconciles — lives
 * in `pre-live-commerce-controls.integration.test.ts`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  NEVER_ON_TAX_EVIDENCE,
  TAX_PROVIDERS,
  TAX_TREATMENTS,
  TaxCalculationRequest,
  TaxJurisdictionCode,
  TaxQuote,
  taxQuoteIsCoherent,
} from "../src/contracts/marketplace/tax-calculation";
import {
  NEVER_ON_TRANSACTION_REVERSAL,
  REVERSAL_KINDS,
  REVERSAL_SCOPES,
  TransactionReversalError,
  TransactionReversalRecord,
  deriveFullReversalAmounts,
  reconcileFullReversal,
  reversedBuyerTotalMinorUnits,
} from "../src/contracts/marketplace/transaction-reversal";
import {
  NEVER_ON_RISK_POLICY,
  RISK_DENIAL_REASON_CODES,
  RiskDecision,
  RiskPolicyVersionRecord,
  canonicalizeDenialReasons,
} from "../src/contracts/marketplace/transaction-risk";
import { PASS_THROUGH_AMOUNT_FIELDS } from "../src/contracts/marketplace/transaction-accounting";
import {
  BasketFulfillmentError,
  DELIVERY_MODES,
  evaluateBasketFulfillment,
} from "../src/contracts/marketplace/basket-fulfillment";
import {
  ALLOWANCE_CONSUMED_BY,
  DEFAULT_SUCCESSFUL_DOWNLOAD_ALLOWANCE,
  DEFERRED_DELIVERY_IMPLEMENTATION,
  DELIVERY_HOST_TYPES,
  DELIVERY_TOKEN_PROPERTIES,
  EXTERNAL_DELIVERY_RULE,
  GUEST_DELIVERY_RECOVERY,
  NEVER_PERSISTED_FOR_DELIVERY,
  REDOWNLOAD_POLICY,
  RESERVED_DELIVERY_MODELS,
} from "../src/contracts/marketplace/digital-delivery-policy";
import {
  createFlatRateTaxAdapter,
  createUnavailableTaxAdapter,
  guardTaxPort,
  createZeroRateTaxAdapter,
  isTaxCalculationEnabled,
  resolveTaxPort,
} from "../src/server/tax/tax-adapters";
import {
  IncoherentTaxQuoteError,
  TaxCalculationUnavailableError,
} from "../src/server/tax/tax-errors";
import { LIVE_READINESS_BLOCKER_CODES } from "../src/server/operations/live-commerce-readiness";
import { STRIPE_MODES } from "../src/server/payments/stripe-runtime-config";

const opaque = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const SNAPSHOT_ID = `mon:txsnp:${opaque("P12SNAP")}`;
const ORDER_ID = `mon:order:${opaque("P12RDER")}`;
const REVERSAL_ID = `mon:txrev:${opaque("P12REV")}`;
const RISK_POLICY_ID = `mon:rpol:${opaque("P12RP0L")}`;
const AT = "2028-05-01T10:00:00.000Z";

const request = (over: Record<string, unknown> = {}) => ({
  currency: "USD" as const,
  commercialRetailAmountMinorUnits: 10_000,
  shippingAmountMinorUnits: 0,
  internalProductId: `mon:product:${opaque("P12PR0D")}`,
  sellerParticipantId: `mon:mpart:${opaque("P12SELLER")}`,
  buyerJurisdictionCode: null,
  at: AT,
  ...over,
});

// — 1 —

describe("1.2 · the tax boundary refuses rather than defaults", () => {
  it("throws when no engine is configured, and never returns a convenient zero", async () => {
    /* THE most important behaviour in the phase. A zero returned because tax is
       unconfigured is indistinguishable from a zero that is genuinely correct,
       and the difference is a liability nobody recorded. */
    await expect(createUnavailableTaxAdapter().calculate(request())).rejects.toBeInstanceOf(
      TaxCalculationUnavailableError,
    );
    expect(isTaxCalculationEnabled({})).toBe(false);
    await expect(resolveTaxPort({}).calculate(request())).rejects.toBeInstanceOf(
      TaxCalculationUnavailableError,
    );
    /* An unrecognised provider is a refusal too, not a fallback to zero. */
    await expect(
      resolveTaxPort({ MONACADO_TAX_ENABLED: "true", MONACADO_TAX_PROVIDER: "AVALARA" }).calculate(
        request(),
      ),
    ).rejects.toBeInstanceOf(TaxCalculationUnavailableError);
  });

  it("names only test adapters, and installs no tax vendor", () => {
    expect(TAX_PROVIDERS).toEqual(["TEST_ZERO_RATE", "TEST_FLAT_RATE"]);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const names = [...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)];
    for (const vendor of ["avatax", "taxjar", "@avalara/avatax-rest-v2-sdk", "vertex"]) {
      expect(names, vendor).not.toContain(vendor);
    }
  });

  it("distinguishes 'no regime consulted' from 'a rate of zero applies'", async () => {
    const quote = await createZeroRateTaxAdapter().calculate(request());
    /* OUT_OF_SCOPE tells an auditor something true. TAXABLE + 0 would mislead. */
    expect(quote.treatment).toBe("OUT_OF_SCOPE");
    expect(quote.taxAmountMinorUnits).toBe(0);
    expect(TAX_TREATMENTS).toEqual(["TAXABLE", "EXEMPT", "OUT_OF_SCOPE"]);
  });

  it("assesses tax on retail plus shipping, and never on tax", async () => {
    const quote = await createFlatRateTaxAdapter({ basisPoints: 1_000 }).calculate(
      request({ shippingAmountMinorUnits: 500 }),
    );
    expect(quote.basisAmountMinorUnits).toBe(10_500);
    expect(quote.taxAmountMinorUnits).toBe(1_050);
    expect(quote.treatment).toBe("TAXABLE");
  });

  it("refuses an engine that contradicts itself", () => {
    const base = {
      provider: "TEST_FLAT_RATE" as const,
      providerCalculationRef: "flat-1",
      currency: "USD" as const,
      basisAmountMinorUnits: 10_000,
      jurisdictionCode: null,
      calculatedAt: AT,
    };
    /* Not-taxable with a non-zero amount is an engine contradicting itself, and
       charging it would charge tax nobody said was due. */
    expect(
      taxQuoteIsCoherent(
        TaxQuote.parse({ ...base, treatment: "EXEMPT", taxAmountMinorUnits: 100 }),
      ),
    ).toBe(false);
    /* Tax larger than the thing taxed is always an error, and it overcharges. */
    expect(
      taxQuoteIsCoherent(
        TaxQuote.parse({ ...base, treatment: "TAXABLE", taxAmountMinorUnits: 10_001 }),
      ),
    ).toBe(false);
    expect(
      taxQuoteIsCoherent(
        TaxQuote.parse({ ...base, treatment: "TAXABLE", taxAmountMinorUnits: 750 }),
      ),
    ).toBe(true);
  });

  it("rejects an adapter that assessed a different sale", async () => {
    /* The guard also checks the basis. An engine that priced something other
       than what Monacado asked about is an engine nobody can reconcile against
       the Order. */
    const wrongBasis = {
      async calculate() {
        return {
          provider: "TEST_FLAT_RATE" as const,
          providerCalculationRef: "x",
          currency: "USD" as const,
          taxAmountMinorUnits: 0,
          basisAmountMinorUnits: 999_999,
          treatment: "EXEMPT" as const,
          jurisdictionCode: null,
          calculatedAt: AT,
        };
      },
    };
    await expect(guardTaxPort(wrongBasis).calculate(request())).rejects.toBeInstanceOf(
      IncoherentTaxQuoteError,
    );
  });

  it("carries a bounded jurisdiction CODE and refuses an address", () => {
    expect(TaxJurisdictionCode.safeParse("US-CA").success).toBe(true);
    expect(TaxJurisdictionCode.safeParse("GB").success).toBe(true);
    for (const address of ["221B Baker Street", "us-ca", "SW1A 1AA, London", ""]) {
      expect(TaxJurisdictionCode.safeParse(address).success, address).toBe(false);
    }
  });

  it("has no field for buyer personal data on a request or a quote", () => {
    expect(TaxCalculationRequest.safeParse(request()).success).toBe(true);
    for (const forbidden of NEVER_ON_TAX_EVIDENCE) {
      expect(
        TaxCalculationRequest.safeParse({ ...request(), [forbidden]: "x" }).success,
        forbidden,
      ).toBe(false);
    }
  });

  it("keeps tax outside every commercial basis", () => {
    /* 0M.T1 asserted this of its own pass-through fields; 1.2 does not change
       it by giving tax a real value. */
    expect(PASS_THROUGH_AMOUNT_FIELDS).toContain("taxAmountMinorUnits");
    const accounting = readFileSync(
      new URL("../src/contracts/marketplace/transaction-accounting.ts", import.meta.url),
      "utf8",
    );
    const identity = accounting.slice(
      accounting.indexOf("export function reconcileTransactionEconomics"),
    );
    for (const field of PASS_THROUGH_AMOUNT_FIELDS) {
      /* No pass-through term appears in the identity that divides revenue. */
      expect(identity.slice(0, identity.indexOf("\n}")).includes(field), field).toBe(false);
    }
  });
});

// — 2 —

describe("1.2 · a reversal is new evidence, never an edit", () => {
  const sellerDirect = {
    commercialRetailAmountMinorUnits: 10_000,
    passThrough: {
      taxAmountMinorUnits: 750,
      shippingAmountMinorUnits: 500,
      otherPassThroughAmountMinorUnits: 0,
    },
    economics: {
      transactionType: "SELLER_DIRECT" as const,
      monacadoRetainedAmountMinorUnits: 850,
      morWholesaleAcquisitionAmountMinorUnits: 9_150,
      sellerProceedsMinorUnits: 9_150,
    },
  };

  const promoted = {
    commercialRetailAmountMinorUnits: 10_000,
    passThrough: {
      taxAmountMinorUnits: 0,
      shippingAmountMinorUnits: 0,
      otherPassThroughAmountMinorUnits: 0,
    },
    economics: {
      transactionType: "PROMOTED" as const,
      offerBinding: {
        internalOfferId: `mon:offer:${opaque("P12FFER")}`,
        offerSourceRecordId: `mon:srec:${opaque("P12FSREC")}`,
        offerSourceRecordVersion: "1",
      },
      monacadoRetainedAmountMinorUnits: 850,
      morWholesaleAcquisitionAmountMinorUnits: 9_150,
      offerWholesalePriceMinorUnits: 5_000,
      sellerFundedCommissionMinorUnits: 1_000,
      promoterRetailSpreadMinorUnits: 4_150,
      promoterNetProceedsMinorUnits: 5_150,
      sellerProceedsMinorUnits: 4_000,
    },
  };

  it("offers full reversals only, and says so", () => {
    expect(REVERSAL_SCOPES).toEqual(["FULL"]);
    expect(REVERSAL_KINDS).toEqual(["REFUND", "CHARGEBACK"]);
    /* Partial forces a decision about WHOSE money comes back first, and every
       allocation rule is a commercial policy decision with different winners. */
    expect(REVERSAL_SCOPES as readonly string[]).not.toContain("PARTIAL");
  });

  it("derives every amount from the snapshot, so none can be supplied", () => {
    const amounts = deriveFullReversalAmounts(sellerDirect);
    expect(amounts.sellerProceedsMinorUnits).toBe(9_150);
    expect(amounts.monacadoRetainedAmountMinorUnits).toBe(850);
    /* A seller-direct sale has no promoter counterparty — NULL, never zero. */
    expect(amounts.promoterNetProceedsMinorUnits).toBeNull();
    expect(reversedBuyerTotalMinorUnits(amounts)).toBe(11_250);
  });

  it("returns the promoted worked example exactly as it was earned", () => {
    const amounts = deriveFullReversalAmounts(promoted);
    expect(amounts.monacadoRetainedAmountMinorUnits).toBe(850);
    expect(amounts.sellerProceedsMinorUnits).toBe(4_000);
    expect(amounts.promoterNetProceedsMinorUnits).toBe(5_150);
    expect(
      amounts.monacadoRetainedAmountMinorUnits +
        amounts.sellerProceedsMinorUnits +
        amounts.promoterNetProceedsMinorUnits!,
    ).toBe(10_000);
  });

  it("balances, and refuses when it would not", () => {
    expect(() =>
      reconcileFullReversal({
        amounts: deriveFullReversalAmounts(promoted),
        transactionType: "PROMOTED",
      }),
    ).not.toThrow();

    /* A seller-direct reversal claiming a promoter share, and a promoted one
       missing it, are both misstatements of who owes whom. */
    expect(() =>
      reconcileFullReversal({
        amounts: { ...deriveFullReversalAmounts(sellerDirect), promoterNetProceedsMinorUnits: 0 },
        transactionType: "SELLER_DIRECT",
      }),
    ).toThrow(TransactionReversalError);
    expect(() =>
      reconcileFullReversal({
        amounts: { ...deriveFullReversalAmounts(promoted), promoterNetProceedsMinorUnits: null },
        transactionType: "PROMOTED",
      }),
    ).toThrow(TransactionReversalError);
    expect(() =>
      reconcileFullReversal({
        amounts: { ...deriveFullReversalAmounts(promoted), sellerProceedsMinorUnits: 1 },
        transactionType: "PROMOTED",
      }),
    ).toThrow(TransactionReversalError);
  });

  it("keeps tax and shipping out of the party identity", () => {
    /* Returned to the buyer in full, and never part of what three parties
       divided — a reversal that folded them in would take back revenue nobody
       earned. */
    expect(() =>
      reconcileFullReversal({
        amounts: deriveFullReversalAmounts(sellerDirect),
        transactionType: "SELLER_DIRECT",
      }),
    ).not.toThrow();
  });

  it("has no lifecycle, no free text, and no partial-refund machinery", () => {
    const base = {
      reversalId: REVERSAL_ID,
      snapshotId: SNAPSHOT_ID,
      orderId: ORDER_ID,
      kind: "REFUND",
      scope: "FULL",
      reasonCode: "BUYER_REQUESTED",
      currency: "USD",
      amounts: deriveFullReversalAmounts(sellerDirect),
      provider: "STRIPE",
      providerReversalRef: "re_3QxYzAbCdEf12345",
      occurredAt: AT,
      recordedAt: AT,
    };
    expect(TransactionReversalRecord.safeParse(base).success).toBe(true);
    for (const forbidden of NEVER_ON_TRANSACTION_REVERSAL) {
      expect(
        TransactionReversalRecord.safeParse({ ...base, [forbidden]: "x" }).success,
        forbidden,
      ).toBe(false);
    }
  });

  it("never writes to the snapshot", () => {
    const service = readFileSync(
      new URL("../src/server/marketplace/transaction-reversal-service.ts", import.meta.url),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    /* 0M.T1: "economic facts are not editable in place". The settlement row is
       the mutable half and is where REVERSED belongs. */
    expect(service.includes("transactionEconomicSnapshot.update")).toBe(false);
    expect(service.includes("transactionEconomicSnapshot.upsert")).toBe(false);
    expect(service.includes("transactionSettlement.update")).toBe(true);
  });
});

// — 3 —

describe("1.2 · the risk gate is narrow and fails closed", () => {
  const policy = {
    policyId: RISK_POLICY_ID,
    policyVersion: "1",
    status: "ACTIVE" as const,
    currency: "USD" as const,
    maxSingleOrderCommercialAmountMinorUnits: 50_000,
    requireSellerCommerceApproval: true,
    requireSellerPaymentReadiness: false,
    effectiveFrom: AT,
    recordedByAccountId: `mon:acct:${opaque("P12REC")}`,
    recordedAt: AT,
    retiredAt: null,
    retiredByAccountId: null,
  };

  it("builds no scoring, velocity, reserve, or review machinery", () => {
    expect(RiskPolicyVersionRecord.safeParse(policy).success).toBe(true);
    for (const forbidden of NEVER_ON_RISK_POLICY) {
      expect(
        RiskPolicyVersionRecord.safeParse({ ...policy, [forbidden]: 1 }).success,
        forbidden,
      ).toBe(false);
    }
    const vocabulary = RISK_DENIAL_REASON_CODES.join(" ").toLowerCase();
    for (const term of ["score", "velocity", "reserve", "chargeback", "model", "review"]) {
      expect(vocabulary, term).not.toContain(term);
    }
  });

  it("limits the COMMERCIAL amount, not the buyer total", () => {
    /* Tax and shipping are pass-through amounts Monacado neither earns nor
       sets. Letting them push an Order over a commercial ceiling would deny a
       sale for somebody else's rate. */
    expect(Object.keys(RiskPolicyVersionRecord.shape)).toContain(
      "maxSingleOrderCommercialAmountMinorUnits",
    );
    expect(Object.keys(RiskPolicyVersionRecord.shape)).not.toContain(
      "maxSingleOrderBuyerTotalMinorUnits",
    );
  });

  it("makes 'allowed, but…' inexpressible", () => {
    expect(
      RiskDecision.safeParse({
        decision: "ALLOW",
        reasonCodes: [],
        policyId: RISK_POLICY_ID,
        policyVersion: "1",
        evaluatedAt: AT,
      }).success,
    ).toBe(true);
    /* An ALLOW carrying reasons would force every caller to inspect a list to
       discover a permissive answer was really a refusal. */
    expect(
      RiskDecision.safeParse({
        decision: "ALLOW",
        reasonCodes: ["SELLER_RESTRICTED"],
        policyId: RISK_POLICY_ID,
        policyVersion: "1",
        evaluatedAt: AT,
      }).success,
    ).toBe(false);
    expect(
      RiskDecision.safeParse({
        decision: "DENY",
        reasonCodes: [],
        policyId: RISK_POLICY_ID,
        policyVersion: "1",
        evaluatedAt: AT,
      }).success,
    ).toBe(false);
  });

  it("reports every reason, deterministically ordered", () => {
    const codes = canonicalizeDenialReasons([
      "SELLER_NOT_COMMERCE_APPROVED",
      "ORDER_AMOUNT_EXCEEDS_LIMIT",
      "SELLER_NOT_COMMERCE_APPROVED",
    ]);
    expect(codes).toEqual(["ORDER_AMOUNT_EXCEEDS_LIMIT", "SELLER_NOT_COMMERCE_APPROVED"]);
  });

  it("names an unconfigured policy as a denial reason, not a default limit", () => {
    expect(RISK_DENIAL_REASON_CODES).toContain("RISK_POLICY_NOT_CONFIGURED");
  });

  it("keeps thresholds versioned rather than constant", () => {
    const service = readFileSync(
      new URL("../src/server/risk/transaction-risk-service.ts", import.meta.url),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    /* Every threshold is read from the resolved policy version. A literal
       ceiling in source would be a number that changes with no record of who
       changed it or what an Order was evaluated under. */
    expect(service).toContain("policy.maxSingleOrderCommercialAmountMinorUnits");
    expect(/maxSingleOrder\w*\s*[=:]\s*\d/.test(service)).toBe(false);
  });
});

// — 3b · basket delivery rule —

describe("1.2 · the basket decides whether a delivery address is needed", () => {
  const line = (id: string, mode: "DIGITAL" | "PHYSICAL" | null) => ({
    internalProductId: `mon:product:${opaque(id)}`,
    deliveryMode: mode,
  });

  it("asks for nothing when every line is digital", () => {
    const result = evaluateBasketFulfillment([line("D1", "DIGITAL"), line("D2", "DIGITAL")]);
    expect(result.requiresShippingAddress).toBe(false);
    expect(result.physicalProductIds).toEqual([]);
  });

  it("requires shipping when any line is physical", () => {
    const result = evaluateBasketFulfillment([line("P1", "PHYSICAL")]);
    expect(result.requiresShippingAddress).toBe(true);
    expect(result.physicalProductIds).toHaveLength(1);
  });

  it("requires shipping for a MIXED basket, even though multi-item checkout is unbuilt", () => {
    /* The policy is a property of a BASKET, so it is written for one now.
       Encoding today's single-Listing limit into the rule would mean rewriting
       the POLICY — not just the plumbing — the day a second line exists.
       There is nowhere to ship half an order to. */
    const result = evaluateBasketFulfillment([
      line("D1", "DIGITAL"),
      line("P1", "PHYSICAL"),
      line("D2", "DIGITAL"),
    ]);
    expect(result.requiresShippingAddress).toBe(true);
    expect(result.physicalProductIds).toEqual([`mon:product:${opaque("P1")}`]);
  });

  it("fails closed on an unknown delivery mode rather than guessing", () => {
    /* Guessing DIGITAL ships nothing to a buyer expecting a parcel; guessing
       PHYSICAL demands an address nobody needs. Both are worse than refusing,
       and only one of them is silent. */
    expect(() => evaluateBasketFulfillment([line("U1", null)])).toThrow(BasketFulfillmentError);
    expect(() =>
      evaluateBasketFulfillment([line("D1", "DIGITAL"), line("U1", null)]),
    ).toThrow(BasketFulfillmentError);

    try {
      evaluateBasketFulfillment([line("U1", null)]);
    } catch (error) {
      expect((error as BasketFulfillmentError).code).toBe("DELIVERY_MODE_UNKNOWN");
      /* Names WHICH product, so a refusal is actionable. */
      expect((error as BasketFulfillmentError).internalProductIds).toHaveLength(1);
    }
  });

  it("refuses an empty basket rather than answering a question nobody asked", () => {
    expect(() => evaluateBasketFulfillment([])).toThrow(BasketFulfillmentError);
  });

  it("keeps delivery mode a closed, explicit fact", () => {
    expect(DELIVERY_MODES).toEqual(["DIGITAL", "PHYSICAL"]);
    /* Never inferred from free-form metadata — a checkout rule read out of a
       spec key would depend on how somebody phrased it. */
    const resolver = readFileSync(
      new URL("../src/server/product/product-delivery-mode-service.ts", import.meta.url),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const inferred of ["specifications", "capabilities", "factName", "category"]) {
      expect(resolver.includes(inferred), inferred).toBe(false);
    }
    expect(resolver).toContain("factDeliveryMode");
  });
});

// — 3c · digital delivery policy —

describe("1.2 · digital delivery policy is declared, not implemented", () => {
  it("defaults to five successful downloads", () => {
    expect(DEFAULT_SUCCESSFUL_DOWNLOAD_ALLOWANCE).toBe(5);
    /* Only a completed delivery consumes allowance. Charging a buyer for their
       own dropped connection is how this kind of policy becomes hostile. */
    expect(ALLOWANCE_CONSUMED_BY).toBe("SUCCESSFUL_DOWNLOAD_ONLY");
  });

  it("keeps the durable entitlement and the transient token distinct", () => {
    /* A token is never the right. Conflating them fails BOTH ways: a lost token
       would mean a lost purchase, and a leaked one a transferable purchase. */
    expect(RESERVED_DELIVERY_MODELS).toContain("DigitalDeliveryEntitlement");
    expect(RESERVED_DELIVERY_MODELS).toContain("DigitalDeliveryToken");
    expect(REDOWNLOAD_POLICY.credentialOnReissue).toBe("FRESH_TOKEN_ONLY");
    expect(REDOWNLOAD_POLICY.originalTokenReuse).toBe("NEVER");
    /* Claiming a guest purchase into an account does not alter the right. */
    expect(GUEST_DELIVERY_RECOVERY.entitlementChangesOnClaim).toBe(false);
  });

  it("supports both hosting models, with Monacado always verifying entitlement", () => {
    expect(DELIVERY_HOST_TYPES).toEqual(["MONACADO_HOSTED", "EXTERNAL_HOSTED"]);
    /* A permanent secret URL is a bearer credential with no expiry, scope, or
       revocation — not delivery control, only the appearance of it. */
    expect(EXTERNAL_DELIVERY_RULE.permanentSecretUrl).toBe("PROHIBITED");
    expect(EXTERNAL_DELIVERY_RULE.permitted).toContain("MONACADO_ENTITLEMENT_VERIFICATION");
  });

  it("requires tokens to be opaque, short-lived, revocable, and never stored raw", () => {
    for (const property of [
      "HIGH_ENTROPY",
      "OPAQUE",
      "SHORT_LIVED",
      "REVOCABLE",
      "REPLACEABLE",
      "NEVER_PERSISTED_IN_PLAINTEXT",
    ]) {
      expect(DELIVERY_TOKEN_PROPERTIES).toContain(property);
    }
  });

  it("routes exceptional re-downloads to the seller, not to Monacado", () => {
    expect(REDOWNLOAD_POLICY.withinAllowance).toBe("SELF_SERVICE");
    expect(REDOWNLOAD_POLICY.beyondAllowance).toBe("REQUIRES_SELLER_AUTHORIZATION");
    /* The seller is the only party who can judge whether a tenth download is a
       re-install or redistribution. Monacado routes; it does not adjudicate. */
    expect(REDOWNLOAD_POLICY.exceptionalSupportOwner).toBe("SELLER");
    expect(REDOWNLOAD_POLICY.infrastructureAndRoutingOwner).toBe("MONACADO");
  });

  it("reaches a guest without inventing an identity for them", () => {
    expect(GUEST_DELIVERY_RECOVERY.createsAccount).toBe(false);
    expect(GUEST_DELIVERY_RECOVERY.createsParticipant).toBe(false);
    expect(GUEST_DELIVERY_RECOVERY.recoveryFactors).toEqual([
      "ORDER_REFERENCE",
      "VERIFIED_CHECKOUT_EMAIL",
    ]);
  });

  it("introduces no token or download-URL column anywhere", () => {
    /* Recorded BEFORE the pressure to store a token "just for debugging"
       arrives with the first support request. */
    const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
    for (const forbidden of NEVER_PERSISTED_FOR_DELIVERY) {
      expect(new RegExp(`^\\s+${forbidden}\\s`, "mi").test(schema), forbidden).toBe(false);
    }
  });

  it("does not claim delivery is built", () => {
    /* "digital delivery is done" must never be mistakable for true. */
    expect(DEFERRED_DELIVERY_IMPLEMENTATION).toContain("token minting, verification, and revocation");
    expect(DEFERRED_DELIVERY_IMPLEMENTATION).toContain("the download endpoint");
    expect(DEFERRED_DELIVERY_IMPLEMENTATION).toContain("seller authorization workflow and UI");
  });
});

// — 4 —

describe("1.2 · live-commerce readiness fails closed", () => {
  it("cannot be satisfied while live mode does not exist", () => {
    /* Not a placeholder — the accurate answer. STRIPE_MODES has one member, so
       no configuration clears this; only a reviewed phase can. */
    expect(STRIPE_MODES).toEqual(["TEST"]);
    expect(LIVE_READINESS_BLOCKER_CODES).toContain("LIVE_PROVIDER_NOT_ENABLED");
  });

  it("names every control real money depends on", () => {
    for (const code of [
      "TAX_CALCULATION_NOT_CONFIGURED",
      "RISK_POLICY_NOT_CONFIGURED",
      "NOTIFICATION_DELIVERY_NOT_CONFIGURED",
      "REVERSAL_ACCOUNTING_UNAVAILABLE",
    ]) {
      expect(LIVE_READINESS_BLOCKER_CODES).toContain(code);
    }
  });

  it("evaluates readiness without being able to enable anything", () => {
    const source = readFileSync(
      new URL("../src/server/operations/live-commerce-readiness.ts", import.meta.url),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    /* A readiness function that could also flip a flag would eventually be
       called by something that wanted the flag flipped. */
    for (const write of [".create(", ".update(", ".upsert(", ".delete(", "process.env ="]) {
      expect(source.includes(write), write).toBe(false);
    }
  });
});
