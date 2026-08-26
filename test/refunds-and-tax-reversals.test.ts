/**
 * Refund and tax-reversal contract tests (Phase 1.9).
 *
 * Pure decisions, adapters driven by injected doubles, and **no database, no
 * network, no Stripe account, no credential, no live money, and no AgentNet
 * publication**. Every Stripe client here is an object literal that records what
 * it was handed.
 *
 * What these prove that an integration test cannot:
 *
 *   - the partial-refund refusal is **structural**, not a rule somebody remembers;
 *   - the composite lifecycle is total and names the one inconsistent resting
 *     state rather than collapsing it into "in progress";
 *   - live credentials are refused at the adapter boundary, three ways;
 *   - the idempotency keys are stable across attempts and disclose nothing;
 *   - the private capsules are deterministic, carry no PII, and publish nothing.
 */

import { describe, expect, it } from "vitest";
import type Stripe from "stripe";

import {
  IMMUTABLE_REFUND_FIELDS,
  NEVER_ON_ORDER_REFUND,
  PARTIAL_LINE_REFUND_DEFERRAL,
  REFUND_UNIT_POLICY,
  SINGLE_LINE_EXECUTION_LIMIT,
  REFUND_FAILURE_CODES,
  REFUND_REFUSAL_CODES,
  REFUND_LIFECYCLE_STATES,
  REFUND_LIFECYCLE_STATES_NEEDING_OPERATOR,
  REFUND_REASON_CODES,
  REFUND_RETRY_POLICY,
  REFUND_SCOPES,
  REFUND_STATUSES,
  OrderRefundRecord,
  classifyRefundFailure,
  deriveRefundAmount,
  singleOrderLineRef,
  nextRefundAttemptAt,
  nextRefundDelaySeconds,
  refundIsCoherent,
  refundLifecycleState,
  requiresTaxReversal,
  reversalReasonForRefund,
  type RefundReasonCode,
  type RefundStatus,
} from "../src/contracts/marketplace/order-refund";
import {
  MARKETPLACE_REFUND_POSTURE,
  REQUIRED_MARKETPLACE_POLICY_NEXT_VERSION,
  SHIPPING_ALLOCATION_SEAM,
  SellerRefundTerms,
  refundWindowIsOpen,
  sellerRefundPolicyIssues,
  shippingIsRefundable,
} from "../src/contracts/marketplace/seller-refund-policy";
import {
  GUEST_REFUND_INITIATION,
  OrderRefundReceiptView,
  RECEIPT_SURFACE,
  RefundProcedureView,
} from "../src/contracts/marketplace/refund-disclosure";
import {
  IMMUTABLE_TAX_REVERSAL_FIELDS,
  NEVER_ON_TAX_REVERSAL,
  OrderTaxReversalRecord,
  REVERSED_TAX_TRANSACTION_LIFECYCLE_STATE,
  TAX_REVERSAL_SCOPES,
  TAX_REVERSAL_STATUSES,
  classifyTaxReversalFailure,
  taxReversalIsCoherent,
  taxReversalProviderReference,
  type TaxReversalStatus,
} from "../src/contracts/marketplace/tax-reversal";
import {
  NEVER_ON_PROCEEDS_RECOVERY_EXCEPTION,
  PROCEEDS_RECOVERY_STATUSES,
  ProceedsRecoveryExceptionRecord,
  RECOVERY_EXECUTION_DEFERRAL,
  isValidProceedsRecoveryTransition,
  recoveryReasonForObligationState,
} from "../src/contracts/marketplace/proceeds-recovery";
import {
  HEALTHY_REFUND_FINDING_CODES,
  REFUND_FINDINGS_NEEDING_OPERATOR,
  REFUND_PROVIDER_AUDIT_SEAM,
  REFUND_RECONCILIATION_FINDING_CODES,
  refundFindingNeedsOperator,
} from "../src/contracts/marketplace/refund-reconciliation";
import {
  NON_REQUEUEABLE_REFUND_REMEDIATION,
  REFUND_OPERATIONS_POLICY,
  isRequeueableRefundFailure,
  isRequeueableTaxReversalFailure,
  refundBacklogIsHealthy,
  refundOperatorActionFor,
  taxReversalOperatorActionFor,
} from "../src/contracts/marketplace/refund-operations";
import {
  DEFAULT_REFUND_CAPSULE_SEMVER,
  NEVER_IN_REFUND_CAPSULE,
  REFUND_CAPSULE_PUBLICATION_DISPOSITION,
  REFUND_MAPPING_VERSION,
  projectRefundCapsule,
  refundCapsuleHash,
  RefundProjectionError,
} from "../src/contracts/marketplace/refund.capsule";
import {
  DEFAULT_TAX_REVERSAL_CAPSULE_SEMVER,
  NEVER_IN_TAX_REVERSAL_CAPSULE,
  TAX_REVERSAL_MAPPING_VERSION,
  projectTaxReversalCapsule,
  taxReversalCapsuleHash,
} from "../src/contracts/marketplace/tax-reversal.capsule";
import {
  CAPSULE_VISIBILITY_POLICY,
  capsuleVisibilityFor,
  isPubliclyDiscoverable,
} from "../src/contracts/capsule/visibility";
import {
  REFUND_EXECUTION_FAILURE_CODES,
  RefundExecutionResult,
} from "../src/contracts/marketplace/transaction-reversal";
import { OUTBOUND_EMAIL_PURPOSES } from "../src/contracts/marketplace/outbound-email";
import {
  REFUND_IDEMPOTENCY_KEY_PREFIX,
  TAX_REVERSAL_IDEMPOTENCY_KEY_PREFIX,
  refundIdempotencyKey,
  taxReversalIdempotencyKey,
} from "../src/server/marketplace/refund-idempotency";
import {
  ACCEPTED_STRIPE_REFUND_STATUSES,
  classifyStripeRefundError,
  createStripeRefundAdapter,
  createStripeRefundClient,
  refundFailureCodeFor,
  stripeRefundReasonFor,
  type StripeRefundClient,
} from "../src/server/payments/stripe-refund-adapter";
import {
  classifyStripeTaxReversalError,
  createStripeTaxReversalAdapter,
  createStripeTaxReversalClient,
  type StripeTaxReversalClient,
} from "../src/server/tax/stripe-tax-reversal-adapter";
import {
  isAuthorizedRefundProcessorRequest,
  isRefundProcessorScheduleDeclared,
  isRefundProcessorSecretConfigured,
  REFUND_PROCESSOR_ENDPOINT_PATH,
  REFUND_PROCESSOR_SCHEDULE_GUIDANCE,
} from "../src/server/payments/refund-processor-route-handler";
import {
  REFUND_CAPABILITY_IMPLEMENTATION,
  REFUND_READINESS_EXCLUSIONS,
  evaluateRefundReadiness,
} from "../src/server/operations/refund-readiness";
import { StripeCredentialError } from "../src/server/payments/stripe-runtime-config";
import type { StripeTaxRuntimeConfig } from "../src/server/tax/tax-runtime-config";
import type { StripeRuntimeConfig } from "../src/server/payments/stripe-runtime-config";

// — Fixtures. Every literal is a shape no account owns. —

const ORDER_ID = "mon:order:P19T0RDER0000000000000000A";
const REFUND_ID = "mon:refnd:P19TREFND000000000000000AB";
const TAX_REVERSAL_ID = "mon:txrvs:P19TTXRVS00000000000000AB0";
const TAX_TRANSACTION_ID = "mon:txtax:P19TTXTAX00000000000000AB0";
const SNAPSHOT_ID = "mon:txsnp:P19TTXSNP00000000000000AB0";
const REVERSAL_ID = "mon:txrev:P19TTXREV00000000000000AB0";
const OBLIGATION_ID = "mon:pobl:P19TP0BL000000000000000AB0";
const EXCEPTION_ID = "mon:precx:P19TPRECX00000000000000AB0";
const PARTICIPANT_ID = "mon:mpart:P19TMPART00000000000000AB0";

const INTENT_REF = "pi_3P19TnotarealintentA1B2";
const REFUND_REF = "re_3P19TnotarealrefundA1B2";
const TAX_TXN_REF = "tax_1P19Tnotarealtransaction";
const TAX_REVERSAL_REF = "tax_1P19Tnotarealreversal00";

const TEST_KEY = "sk_test_p19notarealkeyatall000000";

const STRIPE_CONFIG: StripeRuntimeConfig = {
  mode: "TEST",
  apiKeyEnvVar: "MONACADO_STRIPE_SECRET_KEY",
  webhookSecretEnvVar: "MONACADO_STRIPE_WEBHOOK_SECRET",
  successUrl: "https://monacado.test/checkout/result",
  cancelUrl: "https://monacado.test/checkout/result",
  shippingCountries: ["US", "CA"],
  allowLoopbackHttp: false,
};

const STRIPE_ENV = {
  MONACADO_STRIPE_ENABLED: "true",
  MONACADO_STRIPE_MODE: "TEST",
  MONACADO_STRIPE_SECRET_KEY: TEST_KEY,
  MONACADO_STRIPE_WEBHOOK_SECRET: "whsec_p19testsigningsecret0000",
  MONACADO_STRIPE_SUCCESS_URL: STRIPE_CONFIG.successUrl,
  MONACADO_STRIPE_CANCEL_URL: STRIPE_CONFIG.cancelUrl,
};

const TAX_CONFIG: StripeTaxRuntimeConfig = {
  mode: "TEST",
  apiKeyEnvVar: "MONACADO_STRIPE_SECRET_KEY",
  taxCodes: { DIGITAL_GOOD: "txcd_TEST_DIGITAL" },
  shippingTaxCode: null,
  configVersion: "p19-map/1",
};

const REFUND: OrderRefundRecord = OrderRefundRecord.parse({
  refundId: REFUND_ID,
  orderId: ORDER_ID,
  snapshotId: SNAPSHOT_ID,
  scope: "LINE_SET",
  lineRefs: [`${ORDER_ID}#L1`],
  coversWholeOrder: true,
  sellerRefundPolicyId: "mon:srpol:P19TSRP0L00000000000000AB0",
  sellerRefundPolicyVersion: "1",
  reasonCode: "CUSTOMER_REQUEST",
  requestorKind: "OPERATOR",
  requestedByAccountId: "mon:acct:P19TACCT000000000000000AB0",
  requestedAt: "2028-07-01T10:00:00.000Z",
  provider: "STRIPE",
  providerMode: "TEST",
  providerTransactionRef: INTENT_REF,
  providerRefundRef: REFUND_REF,
  providerRefundCreatedAt: "2028-07-01T10:00:05.000Z",
  currency: "USD",
  amountMinorUnits: 10_875,
  linesRetailMinorUnits: 10_000,
  linesTaxMinorUnits: 875,
  refundedShippingMinorUnits: 0,
  recordedAt: "2028-07-01T10:00:00.000Z",
  status: "REFUNDED",
  attemptCount: 1,
  nextAttemptAt: null,
  lastFailureCode: null,
  lastFailureClass: null,
  finalizedAt: "2028-07-01T10:00:05.000Z",
  requeueCount: 0,
  lastRequeuedAt: null,
  reversalId: REVERSAL_ID,
  updatedAt: "2028-07-01T10:00:05.000Z",
});

const TAX_REVERSAL: OrderTaxReversalRecord = OrderTaxReversalRecord.parse({
  taxReversalId: TAX_REVERSAL_ID,
  orderId: ORDER_ID,
  refundId: REFUND_ID,
  taxTransactionId: TAX_TRANSACTION_ID,
  scope: "FULL",
  provider: "STRIPE_TAX",
  providerMode: "TEST",
  originalProviderTaxTransactionRef: TAX_TXN_REF,
  providerReversalRef: TAX_REVERSAL_REF,
  providerReversalCreatedAt: "2028-07-01T10:00:09.000Z",
  providerReference: taxReversalProviderReference(ORDER_ID),
  currency: "USD",
  reversedTaxAmountMinorUnits: 875,
  reversedTaxableBasisMinorUnits: 10_000,
  recordedAt: "2028-07-01T10:00:05.000Z",
  status: "REVERSED",
  attemptCount: 1,
  nextAttemptAt: null,
  lastFailureCode: null,
  lastFailureClass: null,
  finalizedAt: "2028-07-01T10:00:09.000Z",
  requeueCount: 0,
  lastRequeuedAt: null,
  updatedAt: "2028-07-01T10:00:09.000Z",
});

const REFUND_CONTEXT = {
  generatedAt: "2028-07-02T00:00:00.000Z",
  capsuleSemver: DEFAULT_REFUND_CAPSULE_SEMVER,
  mappingVersion: REFUND_MAPPING_VERSION,
  lifecycleState: "COMPLETED" as const,
  taxReversalRef: TAX_REVERSAL_ID,
};

const TAX_REVERSAL_CONTEXT = {
  generatedAt: "2028-07-02T00:00:00.000Z",
  capsuleSemver: DEFAULT_TAX_REVERSAL_CAPSULE_SEMVER,
  mappingVersion: TAX_REVERSAL_MAPPING_VERSION,
};

// ---------------------------------------------------------------------------

describe("1.9 — the refund unit is a whole Order line", () => {
  it("expresses the unit as a line set, not as 'the whole Order'", () => {
    expect(REFUND_SCOPES).toEqual(["LINE_SET"]);
    expect(TAX_REVERSAL_SCOPES).toEqual(["FULL"]);
    expect(REFUND_UNIT_POLICY.unit).toBe("WHOLE_ORDER_LINE");
    expect(REFUND_UNIT_POLICY.multipleLinesSelectable).toBe(true);
    /* THE CORRECTED RULE: partial relative to the Order is permitted. */
    expect(REFUND_UNIT_POLICY.mayBePartialRelativeToOrder).toBe(true);
    expect(REFUND_UNIT_POLICY.unselectedLinesUntouched).toBe(true);
    expect(REFUND_UNIT_POLICY.selectedLinesRefundedInFull).toBe(true);
  });

  it("refuses an arbitrary per-line amount, and says so by that name", () => {
    expect(REFUND_UNIT_POLICY.arbitraryPerLineAmount).toBe("REFUSED");
    expect(PARTIAL_LINE_REFUND_DEFERRAL.refusalCode).toBe(
      "PARTIAL_LINE_REFUND_NOT_SUPPORTED",
    );
    expect(REFUND_REFUSAL_CODES).toContain("PARTIAL_LINE_REFUND_NOT_SUPPORTED");
    /* The old name implied subset-of-lines refunds were forbidden. It is gone. */
    expect(REFUND_REFUSAL_CODES).not.toContain("PARTIAL_REFUND_NOT_SUPPORTED");
  });

  it("names the allocations only a SUB-LINE split would force a ruling on", () => {
    /* Narrowed from the first draft: selecting whole lines needs no allocation
       ruling, because each line's own sale-time economics govern it. */
    expect(PARTIAL_LINE_REFUND_DEFERRAL.allocationDecisionsRequired).toEqual([
      "SELLER_PROCEEDS_WITHIN_A_LINE",
      "PROMOTER_PROCEEDS_WITHIN_A_LINE",
      "MONACADO_RETAINED_AMOUNT_WITHIN_A_LINE",
      "TAX_WITHIN_A_LINE",
      "SHIPPING_AND_PASS_THROUGH_WITHIN_A_LINE",
    ]);
    expect(PARTIAL_LINE_REFUND_DEFERRAL.owner).toBe(
      "MONACADO_MOR_BUSINESS_MODEL_SECTION_I",
    );
  });

  it("attributes the one-line limit to the Order model, not the refund policy", () => {
    expect(SINGLE_LINE_EXECUTION_LIMIT.owner).toBe("ORDER_MODEL");
    expect(SINGLE_LINE_EXECUTION_LIMIT.policyPermitsSubsetOfLines).toBe(true);
    expect(SINGLE_LINE_EXECUTION_LIMIT.subsetRefundBehaviourToday).toBe(
      "REFUSED_FAIL_CLOSED",
    );
    expect(SINGLE_LINE_EXECUTION_LIMIT.blockingEvidenceGaps).toContain(
      "NO_LINE_LEVEL_PROVIDER_TAX_EVIDENCE",
    );
  });

  it("refuses the columns a sub-line or allocation implementation would need", () => {
    for (const field of [
      "remainingRefundableMinorUnits",
      "refundedToDateMinorUnits",
      "allocationRule",
      "shippingProrationRule",
      "requestedAmountMinorUnits",
    ]) {
      expect(NEVER_ON_ORDER_REFUND).toContain(field);
      expect(() => OrderRefundRecord.parse({ ...REFUND, [field]: 1 })).toThrow();
    }
  });

  it("derives a line ref from the Order rather than minting an identity", () => {
    const ref = singleOrderLineRef(ORDER_ID);
    expect(ref.startsWith(ORDER_ID)).toBe(true);
    expect(ref).not.toBe(ORDER_ID);
    /* Not an opaque `mon:` identity: a real OrderLine row would supersede one. */
    expect(ref.startsWith("mon:oline:")).toBe(false);
  });
});

describe("1.9 — refund amount derivation", () => {
  const LINE = {
    lineRef: singleOrderLineRef(ORDER_ID),
    internalProductId: "mon:product:P19TPR0D000000000000000AB0",
    listingSourceRecordId: "mon:srec:P19TSREC0000000000000000AB",
    listingSourceRecordVersion: "1",
    currency: "USD" as const,
    commercialRetailAmountMinorUnits: 10_000,
    taxAmountMinorUnits: 875,
  };

  it("composes the total from lines, their tax, and policy-governed shipping", () => {
    const derived = deriveRefundAmount({
      selectedLines: [LINE],
      orderLineCount: 1,
      quotedShippingAmountMinorUnits: 500,
      quotedOtherPassThroughAmountMinorUnits: 0,
      shippingRefundability: "ALWAYS_REFUNDED",
      reasonCode: "CUSTOMER_REQUEST",
    });
    expect(derived).toMatchObject({
      derived: true,
      totalMinorUnits: 11_375,
      linesRetailMinorUnits: 10_000,
      linesTaxMinorUnits: 875,
      shippingMinorUnits: 500,
      shippingRefundable: true,
      coversWholeOrder: true,
    });
  });

  it("leaves non-refundable shipping paid, so the total is NOT the whole charge", () => {
    /* The visible proof that the "must equal the whole buyer charge" invariant
       is gone: this is a valid refund of a one-line Order for less than it. */
    const derived = deriveRefundAmount({
      selectedLines: [LINE],
      orderLineCount: 1,
      quotedShippingAmountMinorUnits: 500,
      quotedOtherPassThroughAmountMinorUnits: 0,
      shippingRefundability: "NEVER_REFUNDED",
      reasonCode: "CUSTOMER_REQUEST",
    });
    expect(derived).toMatchObject({
      derived: true,
      totalMinorUnits: 10_875,
      shippingMinorUnits: 0,
      shippingRefundable: false,
    });
  });

  it("returns shipping on seller fault, and withholds it on a change of mind", () => {
    const at = (reasonCode: RefundReasonCode) =>
      deriveRefundAmount({
        selectedLines: [LINE],
        orderLineCount: 1,
        quotedShippingAmountMinorUnits: 500,
        quotedOtherPassThroughAmountMinorUnits: 0,
        shippingRefundability: "REFUNDED_WHEN_SELLER_AT_FAULT",
        reasonCode,
      });
    expect(at("PRODUCT_FAILURE")).toMatchObject({ shippingMinorUnits: 500 });
    expect(at("DUPLICATE_PAYMENT")).toMatchObject({ shippingMinorUnits: 500 });
    /* The buyer changed their mind; the carriage still happened. */
    expect(at("CUSTOMER_REQUEST")).toMatchObject({ shippingMinorUnits: 0 });
  });

  it("FAILS CLOSED on basket shipping allocation rather than prorating", () => {
    const derived = deriveRefundAmount({
      selectedLines: [LINE],
      /* Two lines, one selected: which part of one carriage was theirs is a
         commercial ruling, not arithmetic. */
      orderLineCount: 2,
      quotedShippingAmountMinorUnits: 500,
      quotedOtherPassThroughAmountMinorUnits: 0,
      shippingRefundability: "ALWAYS_REFUNDED",
      reasonCode: "CUSTOMER_REQUEST",
    });
    expect(derived).toEqual({
      derived: false,
      refusal: "SHIPPING_ALLOCATION_NOT_GOVERNED",
    });
    expect(SHIPPING_ALLOCATION_SEAM.proration).toBe("REFUSED");
    expect(SHIPPING_ALLOCATION_SEAM.candidateRulesRequiringARuling.length).toBeGreaterThan(1);
  });

  it("refuses an ungoverned pass-through rather than silently keeping it", () => {
    expect(
      deriveRefundAmount({
        selectedLines: [LINE],
        orderLineCount: 1,
        quotedShippingAmountMinorUnits: 0,
        quotedOtherPassThroughAmountMinorUnits: 250,
        shippingRefundability: "ALWAYS_REFUNDED",
        reasonCode: "CUSTOMER_REQUEST",
      }),
    ).toEqual({ derived: false, refusal: "PASS_THROUGH_REFUND_TREATMENT_NOT_GOVERNED" });
  });

  it("refuses a selection of no lines", () => {
    expect(
      deriveRefundAmount({
        selectedLines: [],
        orderLineCount: 1,
        quotedShippingAmountMinorUnits: 0,
        quotedOtherPassThroughAmountMinorUnits: 0,
        shippingRefundability: "ALWAYS_REFUNDED",
        reasonCode: "CUSTOMER_REQUEST",
      }),
    ).toEqual({ derived: false, refusal: "NO_REFUND_LINES_SELECTED" });
  });

  it("sums several selected lines without any allocation rule", () => {
    const second = { ...LINE, lineRef: `${ORDER_ID}#L2`, commercialRetailAmountMinorUnits: 2_000, taxAmountMinorUnits: 175 };
    const derived = deriveRefundAmount({
      selectedLines: [LINE, second],
      orderLineCount: 2,
      quotedShippingAmountMinorUnits: 0,
      quotedOtherPassThroughAmountMinorUnits: 0,
      shippingRefundability: "ALWAYS_REFUNDED",
      reasonCode: "CUSTOMER_REQUEST",
    });
    /* Each line's own economics; nothing is split, so nothing needs a ruling. */
    expect(derived).toMatchObject({
      derived: true,
      totalMinorUnits: 13_050,
      coversWholeOrder: true,
    });
  });
});

describe("1.9 — the composite lifecycle", () => {
  it("is total over every (refund, tax reversal) pair", () => {
    const taxStates: Array<TaxReversalStatus | null> = [null, ...TAX_REVERSAL_STATUSES];
    for (const refundStatus of REFUND_STATUSES) {
      for (const taxReversalStatus of taxStates) {
        const state = refundLifecycleState({ refundStatus, taxReversalStatus });
        expect(REFUND_LIFECYCLE_STATES).toContain(state);
      }
    }
  });

  it("reaches COMPLETED only when BOTH provider operations succeeded", () => {
    expect(refundLifecycleState({ refundStatus: "REFUNDED", taxReversalStatus: "REVERSED" })).toBe(
      "COMPLETED",
    );
    for (const taxReversalStatus of TAX_REVERSAL_STATUSES) {
      if (taxReversalStatus === "REVERSED") continue;
      expect(
        refundLifecycleState({ refundStatus: "REFUNDED", taxReversalStatus }),
      ).not.toBe("COMPLETED");
    }
  });

  it("names the one inconsistent resting state rather than hiding it", () => {
    /* Money returned, tax reversal permanently failed, and no timer will fix it.
       Collapsing this into "in progress" is how a filing ends up containing it. */
    expect(
      refundLifecycleState({ refundStatus: "REFUNDED", taxReversalStatus: "FAILED_PERMANENT" }),
    ).toBe("MANUAL_REMEDIATION_REQUIRED");
    expect(REFUND_LIFECYCLE_STATES_NEEDING_OPERATOR).toContain("MANUAL_REMEDIATION_REQUIRED");
    expect(REFUND_LIFECYCLE_STATES_NEEDING_OPERATOR).toContain("REFUND_FAILED_PERMANENT");
  });

  it("does not call a refund with no tax reversal COMPLETED", () => {
    /* A sale the tax provider never saw has no reversal record. Claiming the tax
       lifecycle completed would be the false assurance 1.7 refused when it
       declined to skip zero-tax reporting. */
    expect(refundLifecycleState({ refundStatus: "REFUNDED", taxReversalStatus: null })).toBe(
      "REFUNDED",
    );
  });

  it("never reaches a tax state while the payment refund is unfinished", () => {
    for (const refundStatus of REFUND_STATUSES) {
      if (refundStatus === "REFUNDED") continue;
      const state = refundLifecycleState({ refundStatus, taxReversalStatus: "REVERSED" });
      expect(state.startsWith("TAX_REVERSAL")).toBe(false);
      expect(state).not.toBe("COMPLETED");
    }
  });
});

describe("1.9 — zero tax still follows the lifecycle", () => {
  it("requires a reversal whenever a transaction was reported, at any amount", () => {
    for (const taxAmountMinorUnits of [0, 1, 875]) {
      expect(
        requiresTaxReversal({ hasRecordedProviderTaxTransaction: true, taxAmountMinorUnits }),
      ).toBe(true);
    }
  });

  it("requires none when the provider holds no transaction to reverse", () => {
    /* Not because the tax was zero — because there is nothing at the provider to
       name. Fabricating a reversal target would assert a transaction existed. */
    expect(
      requiresTaxReversal({ hasRecordedProviderTaxTransaction: false, taxAmountMinorUnits: 0 }),
    ).toBe(false);
  });
});

describe("1.9 — failure classification and bounded retry", () => {
  it("treats provider-side settled conditions as permanent, and the rest transient", () => {
    expect(classifyRefundFailure("ALREADY_REFUNDED")).toBe("PERMANENT");
    expect(classifyRefundFailure("CHARGE_NOT_FOUND")).toBe("PERMANENT");
    expect(classifyRefundFailure("EVIDENCE_INCONSISTENT")).toBe("PERMANENT");
    expect(classifyRefundFailure("PROVIDER_UNAVAILABLE")).toBe("TRANSIENT");
    expect(classifyRefundFailure("UNSPECIFIED_FAILURE")).toBe("TRANSIENT");
  });

  it("keeps a tax reversal retryable while its payment refund is still running", () => {
    /* Permanent would abandon a reversal for a condition actively being fixed. */
    expect(classifyTaxReversalFailure("PAYMENT_REFUND_NOT_COMPLETE")).toBe("TRANSIENT");
    expect(classifyTaxReversalFailure("ALREADY_REVERSED")).toBe("PERMANENT");
    expect(classifyTaxReversalFailure("DUPLICATE_REFERENCE")).toBe("PERMANENT");
  });

  it("classifies every code, with no default falling off the end", () => {
    for (const code of REFUND_FAILURE_CODES) {
      expect(["TRANSIENT", "PERMANENT"]).toContain(classifyRefundFailure(code));
    }
  });

  it("stops after the attempt cap rather than retrying forever", () => {
    expect(nextRefundDelaySeconds(REFUND_RETRY_POLICY.maxAttempts)).toBeNull();
    expect(
      nextRefundAttemptAt({
        attemptCount: REFUND_RETRY_POLICY.maxAttempts,
        failedAt: "2028-07-01T10:00:00.000Z",
      }),
    ).toBeNull();
    expect(nextRefundDelaySeconds(1)).toBe(REFUND_RETRY_POLICY.backoffSeconds[0]);
  });
});

describe("1.9 — coherence at the boundary", () => {
  it("refuses a refund marked REFUNDED with no provider evidence", () => {
    expect(refundIsCoherent(REFUND)).toBe(true);
    expect(refundIsCoherent({ ...REFUND, providerRefundRef: null })).toBe(false);
    expect(refundIsCoherent({ ...REFUND, providerRefundCreatedAt: null })).toBe(false);
  });

  it("refuses a refund whose 'refund' reference is the original charge", () => {
    /* A provider echoing the input is not a refund. */
    expect(refundIsCoherent({ ...REFUND, providerRefundRef: INTENT_REF })).toBe(false);
  });

  it("does not police a refund that has not completed", () => {
    for (const status of REFUND_STATUSES) {
      if (status === "REFUNDED") continue;
      expect(
        refundIsCoherent({ ...REFUND, status: status as RefundStatus, providerRefundRef: null }),
      ).toBe(true);
    }
  });

  it("refuses a tax reversal whose reference echoes the original transaction", () => {
    expect(taxReversalIsCoherent(TAX_REVERSAL)).toBe(true);
    expect(
      taxReversalIsCoherent({ ...TAX_REVERSAL, providerReversalRef: TAX_TXN_REF }),
    ).toBe(false);
    expect(taxReversalIsCoherent({ ...TAX_REVERSAL, providerReversalRef: null })).toBe(false);
  });
});

describe("1.9 — provider references and idempotency", () => {
  it("derives a reversal reference distinct from the original transaction's", () => {
    /* Stripe requires `reference` unique across ALL transactions INCLUDING
       reversals, so reusing the bare Order id would be refused outright. */
    const reference = taxReversalProviderReference(ORDER_ID);
    expect(reference).not.toBe(ORDER_ID);
    expect(reference.startsWith(ORDER_ID)).toBe(true);
  });

  it("produces the same refund key on every attempt", () => {
    const first = refundIdempotencyKey({
      refundId: REFUND_ID,
      providerTransactionRef: INTENT_REF,
    });
    const second = refundIdempotencyKey({
      refundId: REFUND_ID,
      providerTransactionRef: INTENT_REF,
    });
    expect(first).toBe(second);
    expect(first.startsWith(REFUND_IDEMPOTENCY_KEY_PREFIX)).toBe(true);
  });

  it("changes the refund key when the charge changes", () => {
    /* A key reused against a different charge would let the provider return the
       first refund's result for a charge nobody meant to refund. */
    expect(
      refundIdempotencyKey({ refundId: REFUND_ID, providerTransactionRef: INTENT_REF }),
    ).not.toBe(
      refundIdempotencyKey({ refundId: REFUND_ID, providerTransactionRef: "pi_other000000" }),
    );
  });

  it("discloses nothing: 64 hex characters after a fixed prefix", () => {
    for (const key of [
      refundIdempotencyKey({ refundId: REFUND_ID, providerTransactionRef: INTENT_REF }),
      taxReversalIdempotencyKey({
        taxReversalId: TAX_REVERSAL_ID,
        originalProviderTaxTransactionRef: TAX_TXN_REF,
      }),
    ]) {
      const body = key.replace(REFUND_IDEMPOTENCY_KEY_PREFIX, "").replace(
        TAX_REVERSAL_IDEMPOTENCY_KEY_PREFIX,
        "",
      );
      expect(body).toMatch(/^[0-9a-f]{64}$/);
      expect(key).not.toContain("10875");
      expect(key).not.toContain("USD");
    }
  });

  it("namespaces the two keys apart", () => {
    expect(REFUND_IDEMPOTENCY_KEY_PREFIX).not.toBe(TAX_REVERSAL_IDEMPOTENCY_KEY_PREFIX);
  });
});

describe("1.9 — the Stripe refund adapter", () => {
  function refundClientDouble(
    refund: Partial<Stripe.Refund> = {},
  ): StripeRefundClient & {
    calls: Array<{ params: Stripe.RefundCreateParams; idempotencyKey?: string }>;
  } {
    const double = {
      calls: [] as Array<{
        params: Stripe.RefundCreateParams;
        idempotencyKey?: string;
      }>,
      async createRefund(
        params: Stripe.RefundCreateParams,
        options?: { idempotencyKey?: string },
      ): Promise<Stripe.Refund> {
        double.calls.push({
          params,
          ...(options?.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: options.idempotencyKey }),
        });
        return {
          id: REFUND_REF,
          object: "refund",
          amount: params.amount ?? 0,
          balance_transaction: null,
          charge: null,
          created: Math.floor(Date.parse("2028-07-01T10:00:05.000Z") / 1_000),
          currency: "usd",
          customer: null,
          customer_account: null,
          metadata: null,
          payment_intent: params.payment_intent ?? null,
          payment_method: null,
          reason: null,
          receipt_number: null,
          source_transfer_reversal: null,
          status: "succeeded",
          transfer_reversal: null,
          ...refund,
        } as Stripe.Refund;
      },
    };
    return double;
  }

  const REQUEST = {
    providerTransactionRef: INTENT_REF,
    provider: "STRIPE" as const,
    currency: "USD" as const,
    amountMinorUnits: 10_875,
    idempotencyKey: refundIdempotencyKey({
      refundId: REFUND_ID,
      providerTransactionRef: INTENT_REF,
    }),
  };

  it("names the exact original payment intent and the full amount", async () => {
    const client = refundClientDouble();
    const adapter = createStripeRefundAdapter({ config: STRIPE_CONFIG, client, env: STRIPE_ENV });
    const result = await adapter.executeRefund(REQUEST);

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.params.payment_intent).toBe(INTENT_REF);
    /* Sent EXPLICITLY rather than omitted: an omitted amount means "whatever is
       left", which for a partly-refunded charge would return a different figure
       than the one Monacado recorded. */
    expect(client.calls[0]!.params.amount).toBe(10_875);
    expect(result).toMatchObject({
      outcome: "EXECUTED",
      provider: "STRIPE",
      providerReversalRef: REFUND_REF,
      providerMode: "TEST",
    });
    expect(RefundExecutionResult.parse(result)).toBeTruthy();
  });

  it("passes the Monacado idempotency key on every call", async () => {
    const client = refundClientDouble();
    const adapter = createStripeRefundAdapter({ config: STRIPE_CONFIG, client, env: STRIPE_ENV });
    await adapter.executeRefund(REQUEST);
    await adapter.executeRefund(REQUEST);
    expect(client.calls.map((c) => c.idempotencyKey)).toEqual([
      REQUEST.idempotencyKey,
      REQUEST.idempotencyKey,
    ]);
  });

  it("reports the PROVIDER's creation instant, not a local clock", async () => {
    const client = refundClientDouble();
    const adapter = createStripeRefundAdapter({ config: STRIPE_CONFIG, client, env: STRIPE_ENV });
    const result = await adapter.executeRefund(REQUEST);
    expect(result).toMatchObject({ providerCreatedAt: "2028-07-01T10:00:05.000Z" });
  });

  it("refuses a refund that names a different charge than the one requested", async () => {
    /* `Stripe.Refund` carries no `livemode`, so this stands where 1.7's
       `transaction.livemode` check stands in the tax adapter. */
    const client = refundClientDouble({ payment_intent: "pi_somebodyelses0000" });
    const adapter = createStripeRefundAdapter({ config: STRIPE_CONFIG, client, env: STRIPE_ENV });
    expect(await adapter.executeRefund(REQUEST)).toEqual({
      outcome: "REFUSED",
      failureCode: "PROVIDER_REJECTED",
    });
  });

  it("accepts a pending refund and refuses a failed one", async () => {
    expect(ACCEPTED_STRIPE_REFUND_STATUSES).toEqual(["succeeded", "pending"]);
    const pending = createStripeRefundAdapter({
      config: STRIPE_CONFIG,
      client: refundClientDouble({ status: "pending" }),
      env: STRIPE_ENV,
    });
    expect(await pending.executeRefund(REQUEST)).toMatchObject({ outcome: "EXECUTED" });

    const failed = createStripeRefundAdapter({
      config: STRIPE_CONFIG,
      client: refundClientDouble({ status: "failed" }),
      env: STRIPE_ENV,
    });
    expect(await failed.executeRefund(REQUEST)).toMatchObject({ outcome: "REFUSED" });
  });

  it("refuses a LIVE credential outright, before any client exists", () => {
    for (const key of ["sk_live_realmoneyrealbuyers", "rk_live_x", "pk_live_x", "notakey"]) {
      expect(() =>
        createStripeRefundClient(STRIPE_CONFIG, {
          ...STRIPE_ENV,
          MONACADO_STRIPE_SECRET_KEY: key,
        }),
      ).toThrow(StripeCredentialError);
    }
  });

  it("refuses a non-TEST configured mode as a normalised code, not a throw", async () => {
    const adapter = createStripeRefundAdapter({
      config: { ...STRIPE_CONFIG, mode: "LIVE" as never },
      env: STRIPE_ENV,
    });
    expect(await adapter.executeRefund(REQUEST)).toEqual({
      outcome: "REFUSED",
      failureCode: "PROVIDER_MODE_NOT_PERMITTED",
    });
  });

  it("turns an unconfigured deployment into a retryable code, not an exception", async () => {
    const adapter = createStripeRefundAdapter({ env: {} });
    const result = await adapter.executeRefund(REQUEST);
    expect(result).toEqual({ outcome: "REFUSED", failureCode: "PROVIDER_NOT_CONFIGURED" });
    expect(classifyRefundFailure(refundFailureCodeFor("PROVIDER_NOT_CONFIGURED"))).toBe(
      "TRANSIENT",
    );
  });

  it("classifies provider errors from structured fields only, keeping no message", () => {
    expect(classifyStripeRefundError({ type: "StripeConnectionError" })).toBe(
      "PROVIDER_UNAVAILABLE",
    );
    expect(classifyStripeRefundError({ statusCode: 503 })).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyStripeRefundError({ code: "charge_already_refunded" })).toBe(
      "ALREADY_REVERSED",
    );
    expect(classifyStripeRefundError({ code: "resource_missing" })).toBe("CHARGE_NOT_FOUND");
    expect(classifyStripeRefundError({ code: "amount_too_large" })).toBe(
      "AMOUNT_EXCEEDS_CHARGE",
    );
    expect(classifyStripeRefundError({ message: "buyer ada@example.com" })).toBe(
      "UNSPECIFIED_FAILURE",
    );
  });

  it("maps every port failure code into the durable vocabulary", () => {
    for (const code of REFUND_EXECUTION_FAILURE_CODES) {
      expect(REFUND_FAILURE_CODES).toContain(refundFailureCodeFor(code));
    }
  });

  it("sends `fraudulent` only where somebody chose that classification", () => {
    /* Stripe adds the card and email to Radar block lists on `fraudulent`. That
       is a consequential act about a person, so nothing is guessed into it. */
    expect(stripeRefundReasonFor("FRAUD_OR_RISK")).toBe("fraudulent");
    expect(stripeRefundReasonFor("CUSTOMER_REQUEST")).toBe("requested_by_customer");
    expect(stripeRefundReasonFor("DUPLICATE_PAYMENT")).toBe("duplicate");
    for (const reason of ["PRODUCT_FAILURE", "OPERATOR_CORRECTION", "OTHER_GOVERNED_REASON"] as const) {
      expect(stripeRefundReasonFor(reason)).toBeUndefined();
    }
  });
});

describe("1.9 — the Stripe Tax reversal adapter", () => {
  function reversalClientDouble(
    over: Partial<Stripe.Tax.Transaction> = {},
  ): StripeTaxReversalClient & {
    calls: Array<{
      params: Stripe.Tax.TransactionCreateReversalParams;
      idempotencyKey?: string;
    }>;
  } {
    const double = {
      calls: [] as Array<{
        params: Stripe.Tax.TransactionCreateReversalParams;
        idempotencyKey?: string;
      }>,
      async createReversal(
        params: Stripe.Tax.TransactionCreateReversalParams,
        options?: { idempotencyKey?: string },
      ): Promise<Stripe.Tax.Transaction> {
        double.calls.push({
          params,
          ...(options?.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: options.idempotencyKey }),
        });
        return {
          id: TAX_REVERSAL_REF,
          object: "tax.transaction",
          created: Math.floor(Date.parse("2028-07-01T10:00:09.000Z") / 1_000),
          currency: "usd",
          customer: null,
          customer_details: {
            address: null,
            address_source: null,
            ip_address: null,
            tax_ids: [],
            taxability_override: "none",
          },
          livemode: false,
          metadata: null,
          posted_at: Math.floor(Date.parse("2028-07-01T10:00:09.000Z") / 1_000),
          reference: params.reference,
          reversal: { original_transaction: params.original_transaction },
          ship_from_details: null,
          shipping_cost: null,
          tax_date: Math.floor(Date.parse("2028-07-01T10:00:09.000Z") / 1_000),
          type: "reversal",
          ...over,
        } as Stripe.Tax.Transaction;
      },
    };
    return double;
  }

  const REQUEST = {
    originalProviderTaxTransactionRef: TAX_TXN_REF,
    providerReference: taxReversalProviderReference(ORDER_ID),
    idempotencyKey: taxReversalIdempotencyKey({
      taxReversalId: TAX_REVERSAL_ID,
      originalProviderTaxTransactionRef: TAX_TXN_REF,
    }),
  };

  it("reverses the EXACT recorded transaction, in full, and never a calculation", async () => {
    const client = reversalClientDouble();
    const adapter = createStripeTaxReversalAdapter({
      config: TAX_CONFIG,
      client,
      env: STRIPE_ENV,
    });
    const result = await adapter.reverse(REQUEST);

    expect(client.calls).toHaveLength(1);
    const params = client.calls[0]!.params;
    expect(params.mode).toBe("full");
    expect(params.original_transaction).toBe(TAX_TXN_REF);
    expect(params.reference).toBe(taxReversalProviderReference(ORDER_ID));
    /* No calculation is named anywhere: recalculating would price a historical
       sale at today's rates. */
    expect(JSON.stringify(params)).not.toContain("calculation");
    /* And no partial-allocation parameter is sent. */
    expect(params.line_items).toBeUndefined();
    expect(params.flat_amount).toBeUndefined();

    expect(result).toMatchObject({
      outcome: "REVERSED",
      providerReversalRef: TAX_REVERSAL_REF,
      providerReversalCreatedAt: "2028-07-01T10:00:09.000Z",
      providerMode: "TEST",
    });
  });

  it("refuses a live-mode object the provider returns", async () => {
    const adapter = createStripeTaxReversalAdapter({
      config: TAX_CONFIG,
      client: reversalClientDouble({ livemode: true }),
      env: STRIPE_ENV,
    });
    expect(await adapter.reverse(REQUEST)).toEqual({
      outcome: "FAILED",
      failureCode: "PROVIDER_MODE_NOT_PERMITTED",
    });
  });

  it("refuses a returned transaction that is not a reversal", async () => {
    const adapter = createStripeTaxReversalAdapter({
      config: TAX_CONFIG,
      client: reversalClientDouble({ type: "transaction" }),
      env: STRIPE_ENV,
    });
    expect(await adapter.reverse(REQUEST)).toEqual({
      outcome: "FAILED",
      failureCode: "EVIDENCE_INCONSISTENT",
    });
  });

  it("refuses a LIVE credential outright", () => {
    expect(() =>
      createStripeTaxReversalClient(TAX_CONFIG, {
        ...STRIPE_ENV,
        MONACADO_STRIPE_SECRET_KEY: "sk_live_realmoneyrealbuyers",
      }),
    ).toThrow(StripeCredentialError);
  });

  it("turns an unconfigured deployment into a retryable code, not an exception", async () => {
    const adapter = createStripeTaxReversalAdapter({ env: {} });
    expect(await adapter.reverse(REQUEST)).toEqual({
      outcome: "FAILED",
      failureCode: "PROVIDER_NOT_CONFIGURED",
    });
  });

  it("classifies provider errors from structured fields only", () => {
    expect(classifyStripeTaxReversalError({ type: "StripeConnectionError" })).toBe(
      "PROVIDER_UNAVAILABLE",
    );
    expect(classifyStripeTaxReversalError({ code: "resource_already_exists" })).toBe(
      "DUPLICATE_REFERENCE",
    );
    expect(classifyStripeTaxReversalError({ code: "resource_missing" })).toBe(
      "ORIGINAL_TRANSACTION_NOT_FOUND",
    );
    expect(classifyStripeTaxReversalError({ message: "9 Delivery Road, Shipton" })).toBe(
      "UNSPECIFIED_FAILURE",
    );
  });
});

describe("1.9 — immutability and PII boundaries", () => {
  it("names the request-time facts a retry may never rewrite", () => {
    for (const field of ["orderId", "snapshotId", "amountMinorUnits", "providerTransactionRef"]) {
      expect(IMMUTABLE_REFUND_FIELDS).toContain(field);
    }
    for (const field of ["taxTransactionId", "originalProviderTaxTransactionRef"]) {
      expect(IMMUTABLE_TAX_REVERSAL_FIELDS).toContain(field);
    }
  });

  it("refuses every named PII and payload field on a refund", () => {
    for (const field of NEVER_ON_ORDER_REFUND) {
      expect(() => OrderRefundRecord.parse({ ...REFUND, [field]: "x" })).toThrow();
    }
  });

  it("refuses every named PII and payload field on a tax reversal", () => {
    for (const field of NEVER_ON_TAX_REVERSAL) {
      expect(() => OrderTaxReversalRecord.parse({ ...TAX_REVERSAL, [field]: "x" })).toThrow();
    }
  });

  it("moves the original tax report's lifecycle to the value 1.7 reserved", () => {
    expect(REVERSED_TAX_TRANSACTION_LIFECYCLE_STATE).toBe("REVERSED");
  });
});

describe("1.9 — proceeds recovery is a seam, not an execution", () => {
  const EXCEPTION = ProceedsRecoveryExceptionRecord.parse({
    exceptionId: EXCEPTION_ID,
    refundId: REFUND_ID,
    orderId: ORDER_ID,
    snapshotId: SNAPSHOT_ID,
    proceedsObligationId: OBLIGATION_ID,
    participantId: PARTICIPANT_ID,
    party: "SELLER",
    amountMinorUnits: 8_150,
    currency: "USD",
    reasonCode: "PAID_BEFORE_REFUND",
    obligationStateAtRefund: "PAID",
    status: "OPEN",
    resolutionCode: null,
    raisedAt: "2028-07-01T10:00:05.000Z",
    acknowledgedAt: null,
    resolvedAt: null,
    updatedAt: "2028-07-01T10:00:05.000Z",
  });

  it("raises an exception for PAID and ELIGIBLE claims, and none for PENDING", () => {
    /* A PENDING claim needs none: `advanceProceedsObligation` already refuses to
       make a reversed sale's claim ELIGIBLE, so it can never be paid. */
    expect(recoveryReasonForObligationState("PENDING")).toBeNull();
    expect(recoveryReasonForObligationState("ELIGIBLE")).toBe("ELIGIBLE_BEFORE_REFUND");
    expect(recoveryReasonForObligationState("PAID")).toBe("PAID_BEFORE_REFUND");
  });

  it("has no RECOVERED state, because nothing here recovers anything", () => {
    expect(PROCEEDS_RECOVERY_STATUSES).toEqual(["OPEN", "ACKNOWLEDGED", "RESOLVED"]);
    expect(isValidProceedsRecoveryTransition("RESOLVED", "OPEN")).toBe(false);
    expect(isValidProceedsRecoveryTransition("OPEN", "RESOLVED")).toBe(true);
  });

  it("refuses the columns a clawback implementation would need", () => {
    for (const field of [
      "clawbackTransferRef",
      "negativeBalanceMinorUnits",
      "offsetScheduleId",
    ]) {
      expect(NEVER_ON_PROCEEDS_RECOVERY_EXCEPTION).toContain(field);
      expect(() =>
        ProceedsRecoveryExceptionRecord.parse({ ...EXCEPTION, [field]: "x" }),
      ).toThrow();
    }
  });

  it("states what is deferred and what is guaranteed instead", () => {
    expect(RECOVERY_EXECUTION_DEFERRAL.clawbackExecution).toBe("NOT_IMPLEMENTED");
    expect(RECOVERY_EXECUTION_DEFERRAL.negativeBalanceLedger).toBe("NOT_IMPLEMENTED");
    expect(RECOVERY_EXECUTION_DEFERRAL.owner).toBe("T2_SETTLEMENT_AND_PAYOUT");
    expect(RECOVERY_EXECUTION_DEFERRAL.guaranteedNow).toContain(
      "PAID_AND_ELIGIBLE_OBLIGATIONS_ARE_NEVER_REWRITTEN",
    );
  });
});

describe("1.9 — reconciliation vocabulary", () => {
  it("answers every question 1.9 requires of it", () => {
    for (const code of [
      "PAID_ORDER_NO_REFUND",
      "REFUND_PENDING",
      "PAYMENT_REFUNDED_TAX_NOT_REVERSED",
      "PAYMENT_REFUND_FAILED",
      "TAX_REVERSAL_FAILED",
      "REFUND_AMOUNT_MISMATCH",
      "CURRENCY_MISMATCH",
      "ORIGINAL_TAX_TRANSACTION_MISSING",
      "CONFLICTING_PROVIDER_REFERENCE",
      "PROCEEDS_STILL_PAYOUT_ELIGIBLE",
    ] as const) {
      expect(REFUND_RECONCILIATION_FINDING_CODES).toContain(code);
    }
  });

  it("separates healthy states from ones a human must act on", () => {
    for (const code of HEALTHY_REFUND_FINDING_CODES) {
      expect(refundFindingNeedsOperator(code)).toBe(false);
    }
    /* Expected briefly and resolved by a retry — until `TAX_REVERSAL_FAILED`
       appears beside it, which IS on the operator list. */
    expect(refundFindingNeedsOperator("PAYMENT_REFUNDED_TAX_NOT_REVERSED")).toBe(false);
    expect(REFUND_FINDINGS_NEEDING_OPERATOR).toContain("TAX_REVERSAL_FAILED");
  });

  it("uses local records only, and names the provider audit as unbuilt", () => {
    expect(REFUND_PROVIDER_AUDIT_SEAM.routineReconciliation).toBe("LOCAL_RECORDS_ONLY");
    expect(REFUND_PROVIDER_AUDIT_SEAM.providerLookup).toBe("NOT_IMPLEMENTED");
    expect(REFUND_PROVIDER_AUDIT_SEAM.conditionsRequiringIt).toEqual([
      "ALREADY_REFUNDED",
      "ALREADY_REVERSED",
    ]);
  });
});

describe("1.9 — operator actions and requeue", () => {
  it("never says retry for a condition retrying cannot fix", () => {
    expect(
      refundOperatorActionFor({ status: "FAILED_PERMANENT", lastFailureCode: "ALREADY_REFUNDED" }),
    ).toBe("RECONCILE_PROVIDER_REFUND");
    expect(
      refundOperatorActionFor({
        status: "FAILED_PERMANENT",
        lastFailureCode: "EVIDENCE_INCONSISTENT",
      }),
    ).toBe("INVESTIGATE_RECORD_DIVERGENCE");
    expect(isRequeueableRefundFailure("ALREADY_REFUNDED")).toBe(false);
    expect(isRequeueableRefundFailure("PROVIDER_UNAVAILABLE")).toBe(true);
    expect(NON_REQUEUEABLE_REFUND_REMEDIATION.ALREADY_REFUNDED).toBe(
      "RECONCILE_PROVIDER_REFUND",
    );
  });

  it("sends an unfixable tax reversal to an adjustment, not to a timer", () => {
    /* The buyer has their money and no retry brings the tax back. */
    expect(
      taxReversalOperatorActionFor({
        status: "FAILED_PERMANENT",
        lastFailureCode: "ORIGINAL_TRANSACTION_NOT_FOUND",
      }),
    ).toBe("OPERATOR_TAX_ADJUSTMENT_REQUIRED");
    expect(isRequeueableTaxReversalFailure("ORIGINAL_TRANSACTION_NOT_FOUND")).toBe(false);
    expect(isRequeueableTaxReversalFailure("PAYMENT_REFUND_NOT_COMPLETE")).toBe(true);
  });

  it("says nothing to do while work is merely in flight", () => {
    expect(refundOperatorActionFor({ status: "PENDING", lastFailureCode: null })).toBe(
      "AWAIT_SCHEDULED_CYCLE",
    );
    expect(refundOperatorActionFor({ status: "IN_PROGRESS", lastFailureCode: null })).toBe(
      "AWAIT_IN_FLIGHT_ATTEMPT",
    );
    expect(refundOperatorActionFor({ status: "REFUNDED", lastFailureCode: null })).toBe("NONE");
  });

  it("treats a manual-remediation backlog as unhealthy regardless of age", () => {
    const backlog = {
      refundsPending: 0,
      refundsInProgress: 0,
      refundsRetryPending: 0,
      refundsCompleted: 5,
      refundsPermanentlyFailed: 0,
      taxReversalsPending: 0,
      taxReversalsInProgress: 0,
      taxReversalsRetryPending: 0,
      taxReversalsCompleted: 4,
      taxReversalsPermanentlyFailed: 1,
      paymentRefundedTaxNotReversed: 0,
      manualRemediationRequired: 1,
      openProceedsRecoveryExceptions: 0,
      dueNow: 0,
      expiredClaims: 0,
      oldestUnresolvedAgeSeconds: null,
      evaluatedAt: "2028-07-01T10:00:00.000Z",
    };
    expect(refundBacklogIsHealthy(backlog)).toBe(false);
    expect(
      refundBacklogIsHealthy({
        ...backlog,
        taxReversalsPermanentlyFailed: 0,
        manualRemediationRequired: 0,
      }),
    ).toBe(true);
  });

  it("holds the tax-reversal lag threshold well inside the overdue one", () => {
    expect(REFUND_OPERATIONS_POLICY.maxTaxReversalLagSeconds).toBeLessThan(
      REFUND_OPERATIONS_POLICY.maxOverdueSeconds,
    );
  });
});

describe("1.9 — private capsule projections", () => {
  it("projects both as PRIVATE, by governance", () => {
    expect(capsuleVisibilityFor("Refund")).toBe("PRIVATE");
    expect(capsuleVisibilityFor("TaxReversal")).toBe("PRIVATE");
    expect(isPubliclyDiscoverable("Refund")).toBe(false);
    expect(isPubliclyDiscoverable("TaxReversal")).toBe(false);
    expect(CAPSULE_VISIBILITY_POLICY.Refund).toBe("PRIVATE");

    const candidate = projectRefundCapsule(REFUND, REFUND_CONTEXT);
    expect(candidate.visibility).toBe("PRIVATE");
    expect(projectTaxReversalCapsule(TAX_REVERSAL, TAX_REVERSAL_CONTEXT).visibility).toBe(
      "PRIVATE",
    );
  });

  it("is deterministic: same record + context ⇒ identical hash", () => {
    const a = projectRefundCapsule(REFUND, REFUND_CONTEXT);
    const b = projectRefundCapsule(REFUND, REFUND_CONTEXT);
    expect(refundCapsuleHash(a)).toBe(refundCapsuleHash(b));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));

    const t1 = projectTaxReversalCapsule(TAX_REVERSAL, TAX_REVERSAL_CONTEXT);
    const t2 = projectTaxReversalCapsule(TAX_REVERSAL, TAX_REVERSAL_CONTEXT);
    expect(taxReversalCapsuleHash(t1)).toBe(taxReversalCapsuleHash(t2));
  });

  it("carries no PII, and no acting operator identity", () => {
    const serialized = JSON.stringify([
      projectRefundCapsule(REFUND, REFUND_CONTEXT),
      projectTaxReversalCapsule(TAX_REVERSAL, TAX_REVERSAL_CONTEXT),
    ]);
    for (const field of [...NEVER_IN_REFUND_CAPSULE, ...NEVER_IN_TAX_REVERSAL_CAPSULE]) {
      expect(serialized).not.toContain(field);
    }
    /* A kind is projected; an individual is not. */
    expect(serialized).not.toContain(REFUND.requestedByAccountId!);
    expect(serialized).toContain("OPERATOR");
  });

  it("mints no Node, no capsule id, and no publisher", () => {
    const candidate = projectRefundCapsule(REFUND, REFUND_CONTEXT);
    expect(Object.keys(candidate.metadata)).toEqual(["version", "provenance"]);
    expect(JSON.stringify(candidate)).not.toContain("an:node:");
    expect(JSON.stringify(candidate)).not.toContain("an:capsule:");
    expect(JSON.stringify(candidate)).not.toContain("an:publisher:");
  });

  it("publishes nothing, and says so as a checkable value", () => {
    expect(REFUND_CAPSULE_PUBLICATION_DISPOSITION).toEqual({
      visibility: "PRIVATE",
      agentNetPublication: "NONE",
      nodeRegistration: "NONE",
      registrarContact: "NONE",
      publicResolverExposure: "NONE",
    });
  });

  it("projects an unfinished refund rather than hiding the rows that matter most", () => {
    const pending = projectRefundCapsule(
      {
        ...REFUND,
        status: "RETRY_PENDING",
        providerRefundRef: null,
        providerRefundCreatedAt: null,
        finalizedAt: null,
        reversalId: null,
        lastFailureCode: "PROVIDER_UNAVAILABLE",
        lastFailureClass: "TRANSIENT",
      },
      { ...REFUND_CONTEXT, lifecycleState: "REFUND_RETRY_PENDING", taxReversalRef: null },
    );
    expect(pending.data.providerRefundRef).toBeNull();
    expect(pending.data.lifecycleState).toBe("REFUND_RETRY_PENDING");
  });

  it("fails closed on an invalid record rather than producing a best-effort capsule", () => {
    expect(() => projectRefundCapsule({ refundId: "not-an-id" }, REFUND_CONTEXT)).toThrow(
      RefundProjectionError,
    );
  });
});

describe("1.9 — the dispatcher endpoint's gate", () => {
  const SECRET = "p19-refund-processor-secret-value";
  const ENV = { MONACADO_REFUND_PROCESSOR_SECRET: SECRET };

  it("uses a DEDICATED secret, not the tax recorder's or the dispatcher's", () => {
    expect(isRefundProcessorSecretConfigured(ENV)).toBe(true);
    expect(
      isRefundProcessorSecretConfigured({ MONACADO_TAX_RECORDER_SECRET: SECRET }),
    ).toBe(false);
    expect(
      isRefundProcessorSecretConfigured({ MONACADO_EMAIL_DISPATCHER_SECRET: SECRET }),
    ).toBe(false);
  });

  it("refuses unconfigured, absent, wrong-scheme, and wrong secret identically", () => {
    expect(isAuthorizedRefundProcessorRequest(`Bearer ${SECRET}`, {})).toBe(false);
    expect(isAuthorizedRefundProcessorRequest(null, ENV)).toBe(false);
    expect(isAuthorizedRefundProcessorRequest(`Basic ${SECRET}`, ENV)).toBe(false);
    expect(isAuthorizedRefundProcessorRequest("Bearer wrong", ENV)).toBe(false);
    expect(isAuthorizedRefundProcessorRequest(`Bearer ${SECRET}`, ENV)).toBe(true);
  });

  it("treats the scheduler as an operator statement, never an inference", () => {
    expect(isRefundProcessorScheduleDeclared({})).toBe(false);
    expect(isRefundProcessorScheduleDeclared({ MONACADO_REFUND_PROCESSOR_SCHEDULE: "  " })).toBe(
      false,
    );
    expect(
      isRefundProcessorScheduleDeclared({ MONACADO_REFUND_PROCESSOR_SCHEDULE: "*/5 * * * *" }),
    ).toBe(true);
  });

  it("commits no cron, and says why", () => {
    expect(REFUND_PROCESSOR_SCHEDULE_GUIDANCE.committedCronDeclaration).toBe("NONE");
    expect(REFUND_PROCESSOR_SCHEDULE_GUIDANCE.dailyCadenceAdequate).toBe(false);
    expect(REFUND_PROCESSOR_SCHEDULE_GUIDANCE.productionPrerequisite).toBe(true);
  });
});

describe("1.9 — readiness", () => {
  const READY_ENV = {
    ...STRIPE_ENV,
    MONACADO_REFUND_PROCESSOR_SECRET: "p19-secret",
    MONACADO_REFUND_PROCESSOR_SCHEDULE: "*/5 * * * *",
    MONACADO_TAX_ENABLED: "true",
    MONACADO_TAX_PROVIDER: "STRIPE_TAX",
  };
  const AT = "2028-07-01T10:00:00.000Z";

  it("distinguishes implemented from configured from operationally invocable", () => {
    const report = evaluateRefundReadiness(AT, READY_ENV);
    expect(report.refundExecutionImplemented).toBe(true);
    expect(report.taxReversalImplemented).toBe(true);
    expect(report.refundExecutionConfigured).toBe(true);
    expect(report.taxReversalConfigured).toBe(true);
    expect(report.processorOperationallyInvocable).toBe(true);

    /* Implemented and configured, with nothing to run it. */
    const noScheduler = evaluateRefundReadiness(AT, {
      ...READY_ENV,
      MONACADO_REFUND_PROCESSOR_SCHEDULE: "",
    });
    expect(noScheduler.refundExecutionConfigured).toBe(true);
    expect(noScheduler.processorOperationallyInvocable).toBe(false);
    expect(noScheduler.blockers).toContain("REFUND_PROCESSOR_NOT_OPERATIONAL");
  });

  it("blocks a deployment that can charge and cannot refund", () => {
    const report = evaluateRefundReadiness(AT, {
      ...READY_ENV,
      MONACADO_STRIPE_ENABLED: "false",
    });
    expect(report.refundExecutionConfigured).toBe(false);
    expect(report.blockers).toContain("REFUND_EXECUTION_NOT_CONFIGURED");
    expect(report.ready).toBe(false);
  });

  it("blocks a test tax adapter from governing a real reversal", () => {
    const report = evaluateRefundReadiness(AT, {
      ...READY_ENV,
      MONACADO_TAX_PROVIDER: "TEST_ZERO_RATE",
    });
    expect(report.blockers).toContain("TAX_REVERSAL_PROVIDER_NOT_PRODUCTION_CAPABLE");
  });

  it("cannot pass, because live mode does not exist", () => {
    const report = evaluateRefundReadiness(AT, READY_ENV);
    expect(report.liveProviderEnabled).toBe(false);
    expect(report.blockers).toEqual(["LIVE_PROVIDER_NOT_ENABLED"]);
    expect(report.ready).toBe(false);
  });

  it("names what this phase does NOT make Monacado ready for", () => {
    expect(REFUND_READINESS_EXCLUSIONS.chargebackAndDisputeHandling).toBe("NOT_IMPLEMENTED");
    expect(REFUND_READINESS_EXCLUSIONS.partialRefunds).toBe("REFUSED");
    expect(REFUND_READINESS_EXCLUSIONS.payoutRecoveryExecution).toBe("NOT_IMPLEMENTED");
    expect(REFUND_CAPABILITY_IMPLEMENTATION.paymentRefundAdapter).toBe("STRIPE_TEST_MODE");
    expect(REFUND_CAPABILITY_IMPLEMENTATION.chargebackIngestion).toBe("NOT_IMPLEMENTED");
  });

  it("names the endpoint once, so a runbook and a report cannot disagree", () => {
    expect(evaluateRefundReadiness(AT, READY_ENV).processorEndpointPath).toBe(
      REFUND_PROCESSOR_ENDPOINT_PATH,
    );
  });
});

describe("1.9 — vocabulary integration with earlier phases", () => {
  it("maps every refund reason onto a 1.2 accounting reason", () => {
    for (const reason of REFUND_REASON_CODES) {
      expect(reversalReasonForRefund(reason as RefundReasonCode)).toMatch(
        /^(BUYER_REQUESTED|NOT_FULFILLABLE|MONACADO_INITIATED|CORRECTION)$/,
      );
    }
  });

  it("extends 1.2's refund port vocabulary additively", () => {
    /* Every `1.2` member still means what it meant. */
    for (const code of [
      "ALREADY_REVERSED",
      "CHARGE_NOT_FOUND",
      "AMOUNT_EXCEEDS_CHARGE",
      "PROVIDER_UNAVAILABLE",
      "UNSPECIFIED_FAILURE",
    ]) {
      expect(REFUND_EXECUTION_FAILURE_CODES).toContain(code);
    }
  });

  it("adds the two email purposes a refund needs, and keeps them distinct", () => {
    expect(OUTBOUND_EMAIL_PURPOSES).toContain("REFUND_COMPLETED");
    expect(OUTBOUND_EMAIL_PURPOSES).toContain("REFUND_RECORDED");
  });
});

// ---------------------------------------------------------------------------
// Phase 1.9 correction — seller refund policy, disclosure, and posture
// ---------------------------------------------------------------------------

describe("1.9 — seller refund policy terms", () => {
  const OK_TERMS = SellerRefundTerms.parse({
    refundsAllowed: true,
    eligibilityConditions: ["ANY_REASON"],
    refundWindowDays: 30,
    shippingRefundability: "ALWAYS_REFUNDED",
    procedureKind: "CONTACT_SELLER_SUPPORT",
  });
  const OK_DOC = {
    title: "Returns",
    sections: [
      { key: "SUMMARY" as const, heading: "Summary", body: "We accept returns." },
      { key: "WINDOW" as const, heading: "Window", body: "Within 30 days." },
      { key: "SHIPPING" as const, heading: "Shipping", body: "Shipping is refunded." },
      { key: "PROCEDURE" as const, heading: "How", body: "Email us." },
    ],
  };

  it("accepts a document that agrees with its terms", () => {
    expect(sellerRefundPolicyIssues({ terms: OK_TERMS, document: OK_DOC })).toEqual([]);
  });

  it("refuses a policy with no procedure a buyer could follow", () => {
    const doc = { ...OK_DOC, sections: OK_DOC.sections.filter((s) => s.key !== "PROCEDURE") };
    expect(sellerRefundPolicyIssues({ terms: OK_TERMS, document: doc })).toContain(
      "missing-section:PROCEDURE",
    );
  });

  it("refuses a declared window the document never mentions", () => {
    const doc = { ...OK_DOC, sections: OK_DOC.sections.filter((s) => s.key !== "WINDOW") };
    expect(sellerRefundPolicyIssues({ terms: OK_TERMS, document: doc })).toContain(
      "missing-section:WINDOW",
    );
  });

  it("always requires shipping to be disclosed, because it always has an answer", () => {
    const doc = { ...OK_DOC, sections: OK_DOC.sections.filter((s) => s.key !== "SHIPPING") };
    expect(sellerRefundPolicyIssues({ terms: OK_TERMS, document: doc })).toContain(
      "missing-section:SHIPPING",
    );
  });

  it("refuses a window on a policy that refunds nothing", () => {
    const terms = SellerRefundTerms.parse({
      refundsAllowed: false,
      eligibilityConditions: [],
      refundWindowDays: 30,
      shippingRefundability: "NEVER_REFUNDED",
      procedureKind: "CONTACT_SELLER_SUPPORT",
    });
    expect(sellerRefundPolicyIssues({ terms, document: OK_DOC })).toContain(
      "refund-window-unexpected",
    );
  });

  it("treats no declared window as always open, never as expired", () => {
    /* A seller who declared nothing has not declared that a buyer is out of time. */
    expect(
      refundWindowIsOpen({
        refundWindowDays: null,
        paidAt: "2020-01-01T00:00:00.000Z",
        at: "2030-01-01T00:00:00.000Z",
      }),
    ).toBe(true);
  });

  it("closes a declared window measured from the instant of sale", () => {
    const paidAt = "2028-07-01T00:00:00.000Z";
    expect(refundWindowIsOpen({ refundWindowDays: 30, paidAt, at: "2028-07-20T00:00:00.000Z" })).toBe(true);
    expect(refundWindowIsOpen({ refundWindowDays: 30, paidAt, at: "2028-09-01T00:00:00.000Z" })).toBe(false);
  });

  it("offers no prorated shipping member, and no discretionary one", () => {
    expect(shippingIsRefundable({ shippingRefundability: "ALWAYS_REFUNDED", reasonCode: "CUSTOMER_REQUEST" })).toBe(true);
    expect(shippingIsRefundable({ shippingRefundability: "NEVER_REFUNDED", reasonCode: "PRODUCT_FAILURE" })).toBe(false);
    expect(() =>
      SellerRefundTerms.parse({ ...OK_TERMS, shippingRefundability: "PRORATED" }),
    ).toThrow();
    expect(() =>
      SellerRefundTerms.parse({ ...OK_TERMS, atSellerDiscretion: true }),
    ).toThrow();
  });
});

describe("1.9 — marketplace posture and disclosure", () => {
  it("records the division of authority without inventing legal conclusions", () => {
    expect(MARKETPLACE_REFUND_POSTURE.policyOwner).toBe("SELLER");
    expect(MARKETPLACE_REFUND_POSTURE.enforcedVersion).toBe("BOUND_AT_PURCHASE");
    expect(MARKETPLACE_REFUND_POSTURE.shippingRefundability).toBe("SELLER_POLICY_GOVERNED");
    expect(MARKETPLACE_REFUND_POSTURE.disclosure).toEqual(["BEFORE_PURCHASE", "ON_RECEIPT"]);
    expect(MARKETPLACE_REFUND_POSTURE.monacadoOperationalAuthority).toBe("RETAINED");
    expect(MARKETPLACE_REFUND_POSTURE.statutoryRights).toBe(
      "NOT_OVERRIDDEN_BY_SELLER_POLICY",
    );
    expect(MARKETPLACE_REFUND_POSTURE.jurisdictionSpecificConclusions).toBe("NONE_ASSERTED");
  });

  it("records the required Marketplace Policy change rather than mutating one", () => {
    /* Version 1 is ACTIVE and accepted by participants. Editing its content to
       describe refund governance would silently change what people agreed to. */
    expect(REQUIRED_MARKETPLACE_POLICY_NEXT_VERSION.mutateActiveVersion).toBe("REFUSED");
    expect(REQUIRED_MARKETPLACE_POLICY_NEXT_VERSION.pointsToState).toContain(
      "SELLER_DECLARES_AND_OWNS_THE_REFUND_POLICY",
    );
    expect(REQUIRED_MARKETPLACE_POLICY_NEXT_VERSION.pointsToState).toContain(
      "BUYER_STATUTORY_RIGHTS_ARE_NOT_OVERRIDDEN",
    );
  });

  it("names the receipt surface it did not build, and what the Order already carries", () => {
    expect(RECEIPT_SURFACE.readContract).toBe("IMPLEMENTED");
    expect(RECEIPT_SURFACE.renderer).toBe("NOT_IMPLEMENTED");
    expect(RECEIPT_SURFACE.durableOnTheOrder).toContain("SELLER_REFUND_POLICY_VERSION");
    expect(RECEIPT_SURFACE.durableOnTheOrder).toContain(
      "PURCHASE_TIME_REFUND_CONTACT_ADDRESS",
    );
    expect(RECEIPT_SURFACE.mustNever).toContain(
      "SUBSTITUTE_CURRENT_POLICY_FOR_A_HISTORICAL_ORDER",
    );
    expect(RECEIPT_SURFACE.mustNever).toContain(
      "SUBSTITUTE_CURRENT_SUPPORT_CONTACT_FOR_THE_ONE_DISCLOSED",
    );
    expect(RECEIPT_SURFACE.mustNever).toContain(
      "REQUIRE_A_CURRENT_SUPPORT_CONTACT_TO_REPRODUCE_AN_OLD_RECEIPT",
    );
  });

  it("separates the purchase-time contact from the current one structurally", () => {
    /* Different names, different places in the shape: the historical value lives
       INSIDE the procedure a buyer follows, and the convenience value sits beside
       it at the top level. Nothing can pass one where the other is expected. */
    const procedure = RefundProcedureView.parse({
      kind: "CONTACT_SELLER_SUPPORT",
      instructions: "Email us.",
      purchaseTimeRefundContact: {
        address: "seller-at-purchase@example.test",
        source: "PRIMARY_PROFILE",
        state: "VERIFIED",
        capturedAt: "2028-07-01T10:00:00.000Z",
      },
      requiresBuyerAccount: false,
    });
    expect(procedure.purchaseTimeRefundContact!.address).toBe(
      "seller-at-purchase@example.test",
    );

    /* The old field name is gone, so nothing can keep reading an ask-time value
       out of the procedure. */
    expect(Object.keys(procedure)).not.toContain("sellerSupportAddress");
    expect(() =>
      RefundProcedureView.parse({
        kind: "CONTACT_SELLER_SUPPORT",
        instructions: "Email us.",
        purchaseTimeRefundContact: null,
        requiresBuyerAccount: false,
        sellerSupportAddress: "somebody-elses@example.test",
      }),
    ).toThrow();
  });

  it("renders a receipt with no current contact at all", () => {
    /* An old receipt must reproduce for a seller who has since gone dark. */
    const receipt = OrderRefundReceiptView.parse({
      orderId: "mon:order:P19T0RDER0000000000000000A",
      policyVersion: null,
      policyRef: null,
      procedure: null,
      currentSellerSupportContact: null,
      unavailableReason: "POLICY_NOT_BOUND",
      evaluatedAt: "2028-07-01T10:00:00.000Z",
    });
    expect(receipt.currentSellerSupportContact).toBeNull();
  });

  it("keeps refund initiation open to a guest, with no account fabricated", () => {
    expect(GUEST_REFUND_INITIATION.requiresBuyerAccount).toBe(false);
    expect(GUEST_REFUND_INITIATION.accountFabrication).toBe("REFUSED");
    expect(GUEST_REFUND_INITIATION.rawCredentialRetention).toBe("NONE");
    expect(GUEST_REFUND_INITIATION.enumerationResistance).toBe("IDENTICAL_REFUSAL");
  });
});
