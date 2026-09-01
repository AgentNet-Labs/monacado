/**
 * Phase 1.11 — disputes and chargebacks, integration.
 *
 * ```
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://…@127.0.0.1:3308/monacado_phase0e2
 * ```
 *
 * The whole suite self-skips unless `RUN_DB_TESTS=1`. Never point at production.
 *
 * ## No network, ever
 *
 * Every provider is an injected double. The Stripe dispute events below are
 * plain literals handed straight to the service as normalised observations —
 * there is no Stripe client anywhere in this file, which is the property that
 * makes "no live provider call occurred" checkable rather than asserted.
 *
 * ## Suite-scoped cleanup
 *
 * Rows are removed by this suite's own opaque prefix and account local-part.
 * No `deleteMany({})` appears.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { grantProductCreatorAuthority } from "./support/product-authority-fixture";
import { createAccount } from "../src/server/account/account-service";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import { grantAccountEntitlement } from "../src/server/account/account-entitlement-service";
import { recordCommerceApproval } from "../src/server/marketplace/participant-commerce-approval-service";
import type { CommerceApprovalIdProvider } from "../src/server/marketplace/participant-commerce-approval-ids";
import { createSellerDirectListing } from "../src/server/marketplace/listing-service";
import {
  activateCommercialPolicyVersion,
  createCommercialPolicy,
  recordCommercialPolicyVersion,
} from "../src/server/marketplace/commercial-policy-service";
import type { CommercialPolicyIdProvider } from "../src/server/marketplace/commercial-policy-ids";
import {
  activateRiskPolicyVersion,
  createRiskPolicy,
  recordRiskPolicyVersion,
} from "../src/server/risk/risk-policy-service";
import {
  advanceProceedsObligation,
  cancelOrder,
  recordPaymentResult,
} from "../src/server/marketplace/order-service";
import { ProceedsPayoutHeldError } from "../src/server/marketplace/order-errors";
import type { OrderIdProvider } from "../src/server/marketplace/order-ids";
import type { GuestClaimCodeProvider } from "../src/server/marketplace/guest-claim-code";
import type { ParticipantIdProvider } from "../src/server/marketplace/participant-ids";
import type { BuyerPaymentInitiationPort } from "../src/contracts/marketplace/buyer-payment";
import { beginCheckout } from "../src/server/payments/executable-checkout-service";
import { runTaxTransactionRecordingCycle } from "../src/server/tax/tax-transaction-recorder";
import { getTaxTransactionForOrder } from "../src/server/tax/tax-transaction-service";
import type {
  TaxTransactionRecordingPort,
  TaxTransactionRecordingRequest,
} from "../src/server/tax/stripe-tax-transaction-adapter";
import type { TaxEvidenceIdProvider } from "../src/server/tax/tax-calculation-ids";
import {
  createStripeTaxAdapter,
  type StripeTaxCalculationClient,
} from "../src/server/tax/stripe-tax-adapter";
import type { StripeTaxRuntimeConfig } from "../src/server/tax/tax-runtime-config";
import {
  ensureShippedMarketplacePolicyActive,
  ensureSellerRefundPolicy,
  verifyPrimarySupportContact,
} from "./support/marketplace-policy-fixture";

// — Phase 1.9 under test —
import {
  evaluateRefundEligibility,
  getRefundForOrder,
  getRefundLifecycleState,
  requestOrderRefund,
} from "../src/server/marketplace/order-refund-service";
import { runRefundCycle } from "../src/server/marketplace/refund-processor";
import {
  RefundAlreadyExistsError,
  RefundRefusedError,
} from "../src/server/marketplace/refund-errors";
import type { RefundIdProvider } from "../src/server/marketplace/refund-ids";
import { getTaxReversalForOrder } from "../src/server/tax/tax-reversal-service";
import { reconcileOrderRefund } from "../src/server/marketplace/refund-reconciliation-service";
import {
  activateSellerRefundPolicyVersion,
  getActiveSellerRefundPolicyVersion,
  readSellerRefundPolicyVersion,
  recordSellerRefundPolicyVersion,
} from "../src/server/marketplace/seller-refund-policy-service";
import {
  readListingRefundPolicyDisclosure,
  readOrderRefundReceipt,
} from "../src/server/marketplace/refund-disclosure-service";
import {
  initiateRefundRequest,
  RefundInitiationRefusedError,
} from "../src/server/marketplace/refund-initiation-service";
import { SellerRefundPolicyUnavailableError } from "../src/server/marketplace/order-errors";
import { resolveSellerSupportContact } from "../src/server/policy/support-contact-service";
import {
  consumeVerificationChallenge,
  issueVerificationChallenge,
  upsertEmailContact,
} from "../src/server/policy/email-verification-service";
import type { PolicyIdProvider } from "../src/server/policy/policy-ids";
import {
  evaluateRefundOperationsReadiness,
  inspectStuckRefundWork,
  listProceedsRecoveryExceptionsForRefund,
  requeueRefundWork,
  summarizeRefundBacklog,
} from "../src/server/marketplace/refund-operations-service";
import { IMMUTABLE_TAX_TRANSACTION_FIELDS } from "../src/contracts/marketplace/tax-transaction";
import { taxReversalProviderReference } from "../src/contracts/marketplace/tax-reversal";
import type {
  RefundExecutionPort,
  RefundExecutionRequest,
  RefundExecutionResult,
} from "../src/contracts/marketplace/transaction-reversal";
import type {
  TaxReversalPort,
  TaxReversalRequest,
  TaxReversalResult,
} from "../src/server/tax/stripe-tax-reversal-adapter";


// — Phase 1.11 —
import {
  disputeBlockingRefundIn,
  getDispute,
  recordDisputeObservation,
} from "../src/server/marketplace/transaction-dispute-service";
import type { DisputeIdProvider } from "../src/server/marketplace/dispute-ids";
import {
  evaluateDisputeOperationsReadiness,
  inspectOpenDisputes,
  summarizeDisputeBacklog,
} from "../src/server/marketplace/dispute-operations-service";
import {
  reconcileDispute,
  reconcileOpenDisputes,
  summarizeDisputeReconciliation,
} from "../src/server/marketplace/dispute-reconciliation-service";
import { assembleDisputeEvidenceMetadata } from "../src/server/marketplace/dispute-evidence-metadata-service";
import {
  approveDisputeEvidence,
  prepareDisputeEvidence,
  recordSellerAttestation,
  submitDisputeEvidence,
} from "../src/server/marketplace/dispute-evidence-service";
import { requestSellerDisputeEvidence } from "../src/server/notifications/dispute-notice-service";
import {
  activateChargebackFeePolicyVersion,
  readChargebackFeePolicyVersions,
  recordChargebackFeePolicyVersion,
  resolveActiveChargebackFeePolicy,
} from "../src/server/marketplace/chargeback-fee-policy-service";
import { SELLER_CHARGEBACK_FEE_BOOTSTRAP_DEFAULT } from "../src/contracts/marketplace/chargeback-fee";
import { enqueueDisputeNotices } from "../src/server/notifications/dispute-notice-service";
import { evaluateLiveCommerceReadiness } from "../src/server/operations/live-commerce-readiness";
import type { DisputeObservation } from "../src/contracts/marketplace/transaction-dispute";
import { projectDisputeCapsule } from "../src/contracts/marketplace/dispute.capsule";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const TAG = "P111T";
const PRODUCT_TAG = "P111TPR0D";
const PRODUCT_PREFIX = `mon:product:${PRODUCT_TAG}`;
const ACCOUNT_EMAIL_PREFIX = "dispute-";
const PASSWORD = "correct-horse-battery-staple-1-2";

const NOW = "2028-09-01T09:00:00.000Z";
const CHECKOUT_AT = "2028-09-05T12:00:00.000Z";
const PAID_AT = "2028-09-05T12:00:05.000Z";
const RECORDED_AT = "2028-09-05T12:00:10.000Z";
const REFUND_AT = "2028-09-10T09:00:00.000Z";
const LATER = "2028-09-10T10:00:00.000Z";
const EXPIRES_AT = "2028-11-30T10:00:00.000Z";

const DIGITAL_TAX_CODE = "txcd_TEST_DIGITAL";
const PHYSICAL_TAX_CODE = "txcd_TEST_TANGIBLE";

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const ACTOR = `mon:actor:${pad26("P19TACT0R")}`;
const RECORDER = `mon:acct:${pad26("P19TREC0RDER")}`;

let seq = 0;
const next = (): number => (seq += 1);

const orderIds: OrderIdProvider = {
  nextOrderId: () => `mon:order:${pad26(`${TAG}0RD${next()}`)}`,
  nextProceedsObligationId: () => `mon:pobl:${pad26(`${TAG}P0B${next()}`)}`,
  nextPurchaseEvidenceId: () => `mon:pvev:${pad26(`${TAG}PVEV${next()}`)}`,
  nextReviewSubmissionId: () => `mon:rsub:${pad26(`${TAG}RSUB${next()}`)}`,
  nextReviewSubmissionAuthorityId: () => `mon:rauth:${pad26(`${TAG}RAUTH${next()}`)}`,
};

const notificationIds = {
  nextParticipantId: () => `mon:mpart:${pad26(`${TAG}NP${next()}`)}`,
  nextRoleAssignmentId: () => `mon:mrole:${pad26(`${TAG}NR${next()}`)}`,
  nextProfileId: () => `mon:mprof:${pad26(`${TAG}NF${next()}`)}`,
  nextActivationId: () => `mon:mact:${pad26(`${TAG}NA${next()}`)}`,
  nextPaymentAccountId: () => `mon:mpay:${pad26(`${TAG}NY${next()}`)}`,
  nextRestrictionId: () => `mon:prst:${pad26(`${TAG}NS${next()}`)}`,
  nextObligationId: () => `mon:nobl:${pad26(`${TAG}N0BL${next()}`)}`,
} satisfies ParticipantIdProvider;

const refundIds: RefundIdProvider = {
  nextRefundId: () => `mon:refnd:${pad26(`${TAG}REFND${next()}`)}`,
  nextTaxReversalId: () => `mon:txrvs:${pad26(`${TAG}TXRVS${next()}`)}`,
  nextProceedsRecoveryExceptionId: () => `mon:precx:${pad26(`${TAG}PRECX${next()}`)}`,
  nextReversalId: () => `mon:txrev:${pad26(`${TAG}TXREV${next()}`)}`,
  nextSellerRefundPolicyId: () => `mon:srpol:${pad26(`${TAG}SRP0L${next()}`)}`,
  nextLockToken: () => `p111lock${next()}`.padEnd(32, "0"),
};

const taxIds: TaxEvidenceIdProvider = {
  nextTaxEvidenceId: () => `mon:taxe:${pad26(`${TAG}TAXE${next()}`)}`,
};
const riskIds = { nextRiskPolicyId: () => `mon:rpol:${pad26(`${TAG}RP0L${next()}`)}` };
const approvalIds: CommerceApprovalIdProvider = {
  nextCommerceApprovalId: () => `mon:pcap:${pad26(`${TAG}PCAP${next()}`)}`,
};
const claimCodes: GuestClaimCodeProvider = {
  nextGuestClaimCode: () => `${TAG}-claim-${next()}`.padEnd(43, "x").slice(0, 43),
};
const policyIds: CommercialPolicyIdProvider = {
  nextPolicyId: () => `mon:cpol:${pad26(`${TAG}P0L${next()}`)}`,
};

/** `1.3`'s policy ids, for the seller-contact-change regression. */
const contactIds: PolicyIdProvider = {
  nextAcceptanceId: () => `mon:pacc:${pad26(`${TAG}PACC${next()}`)}`,
  nextEmailContactId: () => `mon:pemc:${pad26(`${TAG}PEMC${next()}`)}`,
  nextVerificationChallengeId: () => `mon:evch:${pad26(`${TAG}EVCH${next()}`)}`,
};
const buyerSnapshotIds = {
  nextBuyerSnapshotId: () => `mon:obsn:${pad26(`${TAG}0BSN${next()}`)}`,
};
const taxTransactionIds = {
  nextTaxTransactionId: () => `mon:txtax:${pad26(`${TAG}TXTAX${next()}`)}`,
  nextLockToken: () => `p111txlock${next()}`.padEnd(32, "0"),
};

const BUYER_DETAILS = {
  name: "Synthetic Buyer",
  email: "p111t-buyer@example.test",
  billingAddress: {
    line1: "1 Test Street",
    line2: null,
    city: "Testville",
    region: "CA",
    postalCode: "94103",
    countryCode: "US",
  },
  shippingAddress: {
    line1: "9 Delivery Road",
    line2: null,
    city: "Shipton",
    region: "NY",
    postalCode: "10001",
    countryCode: "US",
  },
  shipToSameAsBilling: false,
} as const;

const deps = () => ({ db, ids: orderIds, notificationIds, claimCodes });
const refundDeps = () => ({ db, ids: refundIds });

const TAX_CONFIG: StripeTaxRuntimeConfig = {
  mode: "TEST",
  apiKeyEnvVar: "MONACADO_STRIPE_SECRET_KEY",
  taxCodes: { DIGITAL_GOOD: DIGITAL_TAX_CODE, PHYSICAL_GOOD: PHYSICAL_TAX_CODE },
  shippingTaxCode: null,
  configVersion: "dispute-map/1",
};

/** A Stripe Tax calculation client double. No network, ever. */
function taxClientDouble(taxMinorUnits = 875): StripeTaxCalculationClient {
  let calls = 0;
  return {
    async createCalculation(
      params: Stripe.Tax.CalculationCreateParams,
    ): Promise<Stripe.Tax.Calculation> {
      calls += 1;
      const basis = (params.line_items[0]?.amount ?? 0) + (params.shipping_cost?.amount ?? 0);
      return {
        id: `taxcalc_test_${TAG}_${calls}`,
        object: "tax.calculation",
        amount_total: basis + taxMinorUnits,
        currency: params.currency,
        customer: null,
        customer_details: {
          address: null,
          address_source: "billing",
          ip_address: null,
          tax_ids: [],
          taxability_override: "none",
        },
        expires_at: Math.floor(Date.parse(EXPIRES_AT) / 1_000),
        livemode: false,
        ship_from_details: null,
        shipping_cost: null,
        tax_amount_exclusive: taxMinorUnits,
        tax_amount_inclusive: 0,
        tax_breakdown: [
          {
            amount: taxMinorUnits,
            inclusive: false,
            tax_rate_details: {
              country: "US",
              flat_amount: null,
              percentage_decimal: taxMinorUnits === 0 ? "0" : "8.75",
              rate_type: "percentage",
              state: "NY",
              tax_type: "sales_tax",
            },
            taxability_reason: taxMinorUnits === 0 ? "not_collecting" : "standard_rated",
            taxable_amount: basis,
          },
        ],
        tax_date: Math.floor(Date.parse(CHECKOUT_AT) / 1_000),
      };
    },
  };
}

function initiationDouble(): BuyerPaymentInitiationPort {
  return {
    async initiatePayment(request: { orderId: string }) {
      const sessionId = `cs_test_${pad26(`${TAG}SESS${next()}`)}`;
      return {
        orderId: request.orderId,
        provider: "STRIPE" as const,
        status: "REQUIRES_BUYER_ACTION" as const,
        providerPaymentRef: sessionId,
        buyerActionUrl: `https://checkout.stripe.com/c/pay/${sessionId}`,
      };
    },
  };
}

/** A tax-recording port double, so `1.7` can reach RECORDED with no network. */
function recordingPortDouble(basis: number, tax: number): TaxTransactionRecordingPort {
  let calls = 0;
  return {
    async record(request: TaxTransactionRecordingRequest) {
      calls += 1;
      void request;
      return {
        outcome: "RECORDED" as const,
        providerTaxTransactionRef: `tax_${pad26(`${TAG}TXN${calls}${next()}`)}`,
        providerTaxTransactionCreatedAt: RECORDED_AT,
        providerTotalAmountMinorUnits: basis + tax,
        providerMode: "TEST" as const,
      };
    },
  };
}

/**
 * A refund port double: no Stripe, no network, and it records what it got.
 *
 * The `script` drives one outcome per call, so a transient failure followed by a
 * success is stated rather than simulated by timing.
 */
function refundPortDouble(
  script: RefundExecutionResult[] = [],
): RefundExecutionPort & { calls: RefundExecutionRequest[] } {
  let index = 0;
  const port = {
    calls: [] as RefundExecutionRequest[],
    async executeRefund(request: RefundExecutionRequest): Promise<RefundExecutionResult> {
      port.calls.push(request);
      const scripted = script[index];
      index += 1;
      if (scripted !== undefined) return scripted;
      return {
        outcome: "EXECUTED",
        provider: "STRIPE",
        providerReversalRef: `re_${pad26(`${TAG}RE${port.calls.length}${next()}`)}`,
        providerCreatedAt: REFUND_AT,
        providerMode: "TEST",
      };
    },
  };
  return port;
}

function taxReversalPortDouble(
  script: TaxReversalResult[] = [],
): TaxReversalPort & { calls: TaxReversalRequest[] } {
  let index = 0;
  const port = {
    calls: [] as TaxReversalRequest[],
    async reverse(request: TaxReversalRequest): Promise<TaxReversalResult> {
      port.calls.push(request);
      const scripted = script[index];
      index += 1;
      if (scripted !== undefined) return scripted;
      return {
        outcome: "REVERSED",
        providerReversalRef: `tax_${pad26(`${TAG}RVS${port.calls.length}${next()}`)}`,
        providerReversalCreatedAt: REFUND_AT,
        providerMode: "TEST",
      };
    },
  };
  return port;
}

/** A port that must never be called. Fails the test loudly if it is. */
function forbiddenTaxReversalPort(): TaxReversalPort {
  return {
    async reverse() {
      throw new Error("the tax reversal port must not be called");
    },
  };
}

// — Cleanup —

async function cleanup(): Promise<void> {
  const accounts = await db.account.findMany({
    where: { email: { startsWith: ACCOUNT_EMAIL_PREFIX } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  const participants =
    accountIds.length === 0
      ? []
      : await db.marketplaceParticipant.findMany({
          where: { accountId: { in: accountIds } },
          select: { id: true },
        });
  const participantIds = participants.map((p) => p.id);
  const listings =
    participantIds.length === 0
      ? []
      : await db.listing.findMany({
          where: { controllingParticipantId: { in: participantIds } },
          select: { internalListingId: true },
        });
  const listingIds = listings.map((l) => l.internalListingId);

  const orders = await db.order.findMany({
    where: {
      OR: [
        { id: { startsWith: `mon:order:${TAG}` } },
        ...(listingIds.length === 0 ? [] : [{ internalListingId: { in: listingIds } }]),
      ],
    },
    select: { id: true },
  });
  const orderIdList = orders.map((o) => o.id);

  if (orderIdList.length > 0) {
    /* Every key here is RESTRICT, so the 1.9 rows come off before anything they
       point at: recovery exceptions, then tax reversals, then refunds, then the
       1.2 accounting entries the refunds referenced. */
    await db.proceedsRecoveryException.deleteMany({ where: { orderId: { in: orderIdList } } });
    await db.orderTaxReversal.deleteMany({ where: { orderId: { in: orderIdList } } });
    /* Refund LINES point at the refund, so they come off first (Phase 1.9
       correction). Every key here is RESTRICT by design. */
    await db.orderRefundLine.deleteMany({
      where: { refund: { is: { orderId: { in: orderIdList } } } },
    });
    await db.orderRefund.deleteMany({ where: { orderId: { in: orderIdList } } });
    /* Phase 1.11. Events RESTRICT to their dispute, and a dispute RESTRICTs to
       the reversal it produced — so both come off between the refund rows above
       and the 1.2 accounting entries below. Recovery exceptions were already
       removed at the top of this block, which matters because a dispute-caused
       one RESTRICTs to the dispute. */
    const disputeRows = await db.transactionDispute.findMany({
      where: { orderId: { in: orderIdList } },
      select: { id: true },
    });
    const disputeIdList = disputeRows.map((d) => d.id);
    if (disputeIdList.length > 0) {
      await db.transactionDisputeEvent.deleteMany({
        where: { disputeId: { in: disputeIdList } },
      });
      /* Phase 1.12 evidence, innermost first. The join RESTRICTs to both the
         preparation and the item, and both RESTRICT to the dispute — deliberately,
         because evidence supports a financial claim and nothing beneath it may be
         deleted out from under it. */
      const preparationRows = await db.disputeEvidencePreparation.findMany({
        where: { disputeId: { in: disputeIdList } },
        select: { id: true },
      });
      const preparationIdList = preparationRows.map((r) => r.id);
      if (preparationIdList.length > 0) {
        await db.disputeEvidencePreparationItem.deleteMany({
          where: { preparationId: { in: preparationIdList } },
        });
      }
      await db.disputeEvidencePreparation.deleteMany({
        where: { disputeId: { in: disputeIdList } },
      });
      await db.disputeEvidenceItem.deleteMany({ where: { disputeId: { in: disputeIdList } } });
      /* The $30 fee RESTRICTs to its dispute, deliberately: a fee is a financial
         claim and nothing beneath it may be deleted out from under it. */
      await db.sellerChargebackFee.deleteMany({ where: { disputeId: { in: disputeIdList } } });
      await db.transactionDispute.deleteMany({ where: { id: { in: disputeIdList } } });
    }
    await db.transactionReversal.deleteMany({ where: { orderId: { in: orderIdList } } });

    await db.orderTaxTransaction.deleteMany({ where: { orderId: { in: orderIdList } } });
    await db.orderTaxEvidence.deleteMany({ where: { orderId: { in: orderIdList } } });
    /* The purchase-time refund disclosure, RESTRICT to its Order (Phase 1.9). */
    await db.orderRefundContactEvidence.deleteMany({
      where: { orderId: { in: orderIdList } },
    });
    await db.orderBuyerSnapshot.deleteMany({ where: { orderId: { in: orderIdList } } });
    await db.notificationDelivery.deleteMany({
      where: { subjectKind: "ORDER", subjectRef: { in: orderIdList } },
    });
    await db.outboundEmailDelivery.deleteMany({
      where: { subjectKind: "ORDER", subjectRef: { in: orderIdList } },
    });
    await db.reviewSubmissionAuthority.deleteMany({ where: { orderId: { in: orderIdList } } });
    await db.purchaseEvidence.deleteMany({ where: { orderId: { in: orderIdList } } });
    const snapshots = await db.transactionEconomicSnapshot.findMany({
      where: { orderId: { in: orderIdList } },
      select: { id: true },
    });
    const snapshotIds = snapshots.map((s) => s.id);
    if (snapshotIds.length > 0) {
      await db.proceedsObligation.deleteMany({ where: { snapshotId: { in: snapshotIds } } });
      await db.transactionSettlement.deleteMany({ where: { snapshotId: { in: snapshotIds } } });
      await db.transactionEconomicSnapshot.deleteMany({ where: { id: { in: snapshotIds } } });
    }
    await db.notificationObligation.deleteMany({ where: { subjectRef: { in: orderIdList } } });
    await db.order.deleteMany({ where: { id: { in: orderIdList } } });
  }

  /* An UNATTRIBUTED dispute has no Order to find it by, so it is removed by this
     suite's own opaque prefix instead — and OUTSIDE the block above, because a
     test that recorded only an unattributable dispute leaves no Order at all,
     and an orphan surviving into the next test makes the dispute book look
     permanently unhealthy. */
  const orphaned = await db.transactionDispute.findMany({
    where: { id: { startsWith: `mon:dspt:${TAG}` } },
    select: { id: true },
  });
  if (orphaned.length > 0) {
    const ids = orphaned.map((d) => d.id);
    await db.transactionDisputeEvent.deleteMany({ where: { disputeId: { in: ids } } });
    await db.transactionDispute.deleteMany({ where: { id: { in: ids } } });
  }

  if (participantIds.length > 0) {
    await db.notificationDelivery.deleteMany({
      where: { recipientParticipantId: { in: participantIds } },
    });
    await db.outboundEmailDelivery.deleteMany({
      where: { recipientParticipantId: { in: participantIds } },
    });
    await db.notificationObligation.deleteMany({
      where: { recipientParticipantId: { in: participantIds } },
    });
    await db.participantRestriction.deleteMany({
      where: { participantId: { in: participantIds } },
    });
    await db.participantCommerceApproval.deleteMany({
      where: { participantId: { in: participantIds } },
    });
    await db.listingSourceRecordVersionRow.deleteMany({
      where: { controllingParticipantId: { in: participantIds } },
    });
    await db.listing.deleteMany({ where: { internalListingId: { in: listingIds } } });
    await db.storefront.deleteMany({ where: { ownerParticipantId: { in: participantIds } } });
    await db.marketplaceRoleAssignment.deleteMany({
      where: { participantId: { in: participantIds } },
    });
    /* RESTRICT to the participant, and Orders RESTRICT to the version row — so
       the policy comes off after the Orders above and before the seller. */
    await db.sellerRefundPolicyVersionRow.deleteMany({
      where: { sellerParticipantId: { in: participantIds } },
    });
    await db.sellerRefundPolicy.deleteMany({
      where: { sellerParticipantId: { in: participantIds } },
    });
    /* Phase 1.18 — Product source versions now name the creator participant
       with onDelete: Restrict. Detach rather than delete: the version rows are
       immutable Product history this cleanup does not own. */
    await db.productSourceRecordVersionRow.updateMany({
      where: { internalProductId: { startsWith: PRODUCT_PREFIX } },
      data: { authorityCreatorParticipantId: null },
    });
    await db.marketplaceParticipant.deleteMany({ where: { id: { in: participantIds } } });
  }

  if (accountIds.length > 0) {
    await db.accountEntitlement.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.account.deleteMany({ where: { id: { in: accountIds } } });
  }

  const own = { startsWith: `mon:cpol:${TAG}` };
  await db.commercialPolicyVersionRow.deleteMany({ where: { policyId: own } });
  await db.commercialPolicy.deleteMany({ where: { id: own } });
  const ownRisk = { startsWith: `mon:rpol:${TAG}` };
  await db.riskPolicyVersionRow.deleteMany({ where: { policyId: ownRisk } });
  await db.riskPolicy.deleteMany({ where: { id: ownRisk } });
  await db.productSourceRecordVersionRow.deleteMany({
    where: { internalProductId: { startsWith: PRODUCT_PREFIX } },
  });
  await db.product.deleteMany({ where: { internalProductId: { startsWith: PRODUCT_PREFIX } } });
}

// — Fixtures —

async function seedProductVersion(args: {
  internalProductId: string;
  sourceRecordId: string;
  sourceRecordVersion: string;
}): Promise<void> {
  await db.productSourceRecordVersionRow.create({
    data: {
      internalProductId: args.internalProductId,
      sourceRecordId: args.sourceRecordId,
      sourceRecordVersion: args.sourceRecordVersion,
      sourceSystem: "monacado",
      sourceRecordType: "Product",
      sourceClass: "governed-database-record",
      authorityCreatorId: `mon:creator:${pad26(`${TAG}CRE${next()}`)}`,
      authorityScope: "product-facts",
      authorityAuthorizationState: "authorized",
      factName: "Synthetic Product",
      factProductVersion: 1,
      factPromotable: true,
      factGeneralAvailabilityState: "available",
      factDeliveryMode: "DIGITAL",
      taxClassification: "DIGITAL_GOOD",
      factCreatorRef: `mon:creator:${pad26(`${TAG}CRF${next()}`)}`,
      capsuleSemver: "1.0.0",
      mappingVersion: "product-mapping/1.0.0",
      capsuleGeneratedAt: new Date(NOW),
      acquiredAt: new Date(NOW),
      sourceCreatedAt: new Date(NOW),
      sourceUpdatedAt: new Date(NOW),
      recordStatus: "DRAFT",
    },
  });
}

async function seedAccount(): Promise<string> {
  const account = await createAccount(
    {
      name: "Synthetic",
      email: `${ACCOUNT_EMAIL_PREFIX}${next()}@example.com`,
      password: PASSWORD,
      createdAt: NOW,
    },
    { db },
  );
  return account.accountId;
}

async function seedInternalActor(capability: string): Promise<string> {
  const accountId = await seedAccount();
  await grantAccountEntitlement({ accountId, capability, grantedAt: NOW }, { db });
  return accountId;
}

async function seedSellerDirect(
  retailMinorUnits = 10_000,
  refundPolicy: {
    shippingRefundability?: "ALWAYS_REFUNDED" | "NEVER_REFUNDED" | "REFUNDED_WHEN_SELLER_AT_FAULT";
    refundsAllowed?: boolean;
    refundWindowDays?: number | null;
    /** Skip seeding entirely, to exercise checkout's refusal. */
    omit?: boolean;
  } = {},
) {
  const accountId = await seedAccount();
  const snapshot = await createDraftParticipant(
    { accountId, initialRoles: ["SELLER"], now: NOW },
    { db },
  );
  const participantId = snapshot.participant.participantId;
  await db.marketplaceParticipant.update({
    where: { id: participantId },
    data: { status: "ACTIVE" },
  });
  await db.marketplaceRoleAssignment.updateMany({
    where: { participantId },
    data: { status: "ACTIVE" },
  });
  await verifyPrimarySupportContact(db, { participantId, accountId, now: NOW });
  /* Phase 1.9 correction — checkout binds the seller's ACTIVE refund policy and
     REFUSES a sale it cannot bind, on the same footing as the verified support
     contact above. Seeded with permissive, shipping-refundable terms so a sale
     completes and a full refund returns the whole buyer charge. */
  if (refundPolicy.omit !== true) {
    await ensureSellerRefundPolicy(db, {
      sellerParticipantId: participantId,
      recordedByAccountId: accountId,
      now: NOW,
      policyId: `mon:srpol:${participantId.slice(-26)}`,
      ...(refundPolicy.shippingRefundability === undefined
        ? {}
        : { shippingRefundability: refundPolicy.shippingRefundability }),
      ...(refundPolicy.refundsAllowed === undefined
        ? {}
        : { refundsAllowed: refundPolicy.refundsAllowed }),
      ...(refundPolicy.refundWindowDays === undefined
        ? {}
        : { refundWindowDays: refundPolicy.refundWindowDays }),
    });
  }

  const n = next();
  const internalProductId = `${PRODUCT_PREFIX}${pad26(String(n)).slice(0, 26 - PRODUCT_TAG.length)}`;
  const sourceRecordId = `mon:srec:${pad26(`${TAG}PSREC${n}`)}`;
  await db.product.create({
    data: {
      internalProductId,
      sourceRecordId,
      currentSourceRecordVersion: "1",
      recordStatus: "DRAFT",
    },
  });
  await seedProductVersion({ internalProductId, sourceRecordId, sourceRecordVersion: "1" });

  const storefrontId = `mon:storefront:${pad26(`${TAG}ST0RE${n}`)}`;
  await db.storefront.create({
    data: {
      internalStorefrontId: storefrontId,
      storefrontSourceRecordId: `mon:srec:${pad26(`${TAG}SFSREC${n}`)}`,
      currentSourceRecordVersion: "1",
      ownerParticipantId: participantId,
      publicHandle: `p111t-shop-${n}`,
      lifecycle: "ACTIVE",
      visibility: "PUBLIC",
    },
  });
  /* Phase 1.18 — a seller-direct placement requires creator authority over
     the Product, derived from its current source version. */
  await grantProductCreatorAuthority(db, {
    internalProductId: internalProductId,
    participantId: participantId,
  });
  const listing = await createSellerDirectListing(
    {
      storefrontId,
      internalProductId,
      controllingParticipantId: participantId,
      retail: { retailPriceMinorUnits: retailMinorUnits, retailPriceCurrency: "USD" },
      sale: null,
      actingAccountId: accountId,
      now: NOW,
    },
    { db },
  );
  const stable = await db.listing.findUniqueOrThrow({
    where: { internalListingId: listing.record.internalListingId },
  });
  await db.listing.update({
    where: { internalListingId: stable.internalListingId },
    data: { lifecycle: "ACTIVE" },
  });
  await db.listingSourceRecordVersionRow.updateMany({
    where: { listingSourceRecordId: stable.listingSourceRecordId },
    data: { lifecycle: "ACTIVE" },
  });
  await recordCommerceApproval(
    {
      participantId,
      decision: "APPROVED",
      reasonCode: "REQUIREMENTS_MET",
      actingAccountId: await seedInternalActor("participant:commerce-approve"),
      decidedAt: NOW,
    },
    { db, ids: approvalIds },
  );
  return { participantId, accountId, internalListingId: listing.record.internalListingId };
}

async function seedCommercialPolicy(): Promise<string> {
  const policy = await createCommercialPolicy(
    { label: `${TAG} ${next()}`, now: NOW },
    { db, ids: policyIds },
  );
  await recordCommercialPolicyVersion(
    {
      policyId: policy.policyId,
      policyVersion: "1",
      currency: "USD",
      retainedPercentageBasisPoints: 750,
      retainedFixedAmountMinorUnits: 100,
      roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
      effectiveFrom: NOW,
      recordedByAccountId: RECORDER,
      recordedAt: NOW,
    },
    { db },
  );
  await activateCommercialPolicyVersion(
    {
      policyId: policy.policyId,
      policyVersion: "1",
      activatedByAccountId: RECORDER,
      activatedAt: NOW,
    },
    { db },
  );
  return policy.policyId;
}

async function seedRiskPolicy(): Promise<string> {
  const policy = await createRiskPolicy({ label: `risk ${next()}`, now: NOW }, { db, ids: riskIds });
  await recordRiskPolicyVersion(
    {
      policyId: policy.policyId,
      policyVersion: "1",
      currency: "USD",
      maxSingleOrderCommercialAmountMinorUnits: 100_000_000,
      requireSellerCommerceApproval: false,
      requireSellerPaymentReadiness: false,
      effectiveFrom: NOW,
      recordedByAccountId: RECORDER,
      recordedAt: NOW,
    },
    { db },
  );
  await activateRiskPolicyVersion(
    {
      policyId: policy.policyId,
      policyVersion: "1",
      activatedByAccountId: RECORDER,
      activatedAt: NOW,
    },
    { db },
  );
  return policy.policyId;
}

const CHECKOUT_INPUT = (internalListingId: string, shippingAmountMinorUnits = 0) => ({
  internalListingId,
  buyerAccountId: null,
  taxAmountMinorUnits: 0,
  shippingAmountMinorUnits,
  otherPassThroughAmountMinorUnits: 0,
  currency: "USD" as const,
  productAvailability: "available" as const,
  placedAt: CHECKOUT_AT,
});

const disputeIds: DisputeIdProvider = {
  nextDisputeId: () => `mon:dspt:${pad26(`${TAG}DSPT${next()}`)}`,
  nextDisputeEventId: () => `mon:dsevt:${pad26(`${TAG}DSEVT${next()}`)}`,
  nextReversalId: () => `mon:txrev:${pad26(`${TAG}DTXREV${next()}`)}`,
  nextProceedsRecoveryExceptionId: () => `mon:precx:${pad26(`${TAG}DPRECX${next()}`)}`,
  nextDisputeEvidenceItemId: () => `mon:evitm:${pad26(`${TAG}DEVITM${next()}`)}`,
  nextDisputeEvidencePreparationId: () => `mon:evprp:${pad26(`${TAG}DEVPRP${next()}`)}`,
  nextSellerChargebackFeeId: () => `mon:cbfee:${pad26(`${TAG}CBFEE${next()}`)}`,
};

const DISPUTE_AT = "2028-09-12T09:00:00.000Z";
const DISPUTE_LATER = "2028-09-13T09:00:00.000Z";
const DUE_BY = "2028-09-20T09:00:00.000Z";

/**
 * A normalised dispute observation.
 *
 * Built as a literal rather than by running the Stripe adapter, so this suite
 * needs no Stripe client at all. The adapter's own mapping is covered by the
 * contract suite, where it can be tested without a database.
 */
function observation(over: Partial<DisputeObservation> = {}): DisputeObservation {
  const n = next();
  return {
    provider: "STRIPE",
    providerMode: "TEST",
    providerDisputeRef: `dp_${pad26(`${TAG}DP${n}`)}`,
    providerEventId: `evt_${pad26(`${TAG}EV${n}`)}`,
    providerTransactionRef: "pi_unattributed",
    providerChargeRef: `ch_${pad26(`${TAG}CH${n}`)}`,
    eventKind: "OPENED",
    disputedAmountMinorUnits: 10_875,
    currency: "USD",
    reasonCode: "PRODUCT_NOT_RECEIVED",
    status: "NEEDS_RESPONSE",
    evidenceDueBy: DUE_BY,
    responsePermitted: true,
    evidenceStagedAtProvider: false,
    evidenceSubmissionCount: 0,
    evidenceSubmittedPastDue: false,
    chargeStillRefundable: true,
    openedAt: DISPUTE_AT,
    occurredAt: DISPUTE_AT,
    providerReportedLivemode: false,
    ...over,
  };
}

const describeDb = RUN ? describe : describe.skip;

describeDb("1.11 — disputes and chargebacks", () => {
  beforeEach(async () => {
    await cleanup();
    await ensureShippedMarketplacePolicyActive(db, {
      recordedByAccountId: await seedAccount(),
      now: NOW,
    });
  });
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  /** A checkout taken to PAID. `taxMinorUnits: 0` exercises the zero-tax arm. */
  async function paidSale(
    over: { taxMinorUnits?: number; retail?: number; shipping?: number } = {},
  ) {
    const taxMinorUnits = over.taxMinorUnits ?? 875;
    const retail = over.retail ?? 10_000;
    const shipping = over.shipping ?? 0;
    const seller = await seedSellerDirect(retail, {});
    const policyId = await seedCommercialPolicy();
    const riskPolicyId = await seedRiskPolicy();
    const begun = await beginCheckout(
      CHECKOUT_INPUT(seller.internalListingId, shipping),
      policyId,
      {
        provider: "STRIPE",
        port: initiationDouble(),
        taxPort: createStripeTaxAdapter({
          config: TAX_CONFIG,
          client: taxClientDouble(taxMinorUnits),
        }),
        riskPolicyId,
        buyerDetails: BUYER_DETAILS,
      },
      { ...deps(), taxIds, buyerSnapshotIds },
    );
    const confirmation = {
      outcome: "SUCCEEDED" as const,
      provider: "STRIPE" as const,
      providerTransactionRef: `pi_${pad26(`${TAG}PI${next()}`)}`,
    };
    await recordPaymentResult(begun.order.orderId, confirmation, PAID_AT, "STRIPE", {
      ...deps(),
      taxTransactionIds,
    });
    const snapshot = await db.transactionEconomicSnapshot.findFirstOrThrow({
      where: { orderId: begun.order.orderId },
    });
    return {
      seller,
      orderId: begun.order.orderId,
      snapshotId: snapshot.id,
      paymentRef: confirmation.providerTransactionRef,
      taxMinorUnits,
      retail,
      shipping,
      buyerTotal: retail + shipping + taxMinorUnits,
    };
  }

  async function recordTax(sale: { retail: number; taxMinorUnits: number; shipping?: number }) {
    const outcome = await runTaxTransactionRecordingCycle(
      { at: RECORDED_AT, limit: 10 },
      {
        db,
        ids: taxTransactionIds,
        port: recordingPortDouble(sale.retail + (sale.shipping ?? 0), sale.taxMinorUnits),
      },
    );
    expect(outcome.recorded).toBeGreaterThan(0);
  }

  /** Record one dispute event against a sale. */
  async function dispute(
    sale: { paymentRef: string; buyerTotal: number },
    over: Partial<DisputeObservation> = {},
    at = DISPUTE_AT,
  ) {
    return recordDisputeObservation(
      observation({
        providerTransactionRef: sale.paymentRef,
        disputedAmountMinorUnits: sale.buyerTotal,
        ...over,
      }),
      { recordedAt: at },
      { db, ids: disputeIds },
    );
  }

  // — 1 · Intake —

  describe("a dispute opened against a PAID sale", () => {
    it("binds to the right Order through the settlement's payment reference alone", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale);

      expect(outcome.applied).toBe(true);
      expect(outcome.unattributed).toBe(false);

      const row = await db.transactionDispute.findUniqueOrThrow({
        where: { id: outcome.disputeId },
      });
      expect(row.orderId).toBe(sale.orderId);
      expect(row.snapshotId).toBe(sale.snapshotId);
      expect(row.providerTransactionRef).toBe(sale.paymentRef);
      expect(row.status).toBe("NEEDS_RESPONSE");
      expect(row.fundsState).toBe("NOT_WITHDRAWN");
      expect(row.remediationCode).toBeNull();
    });

    it("records the response deadline and the evidence posture", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale);
      const row = await db.transactionDispute.findUniqueOrThrow({
        where: { id: outcome.disputeId },
      });
      expect(row.evidenceDueBy?.toISOString()).toBe(DUE_BY);
      expect(row.responsePermitted).toBe(true);
      expect(row.evidenceSubmissionCount).toBe(0);
    });

    it("distinguishes no deadline from no response permitted", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale, { evidenceDueBy: null, responsePermitted: false });
      const row = await db.transactionDispute.findUniqueOrThrow({
        where: { id: outcome.disputeId },
      });
      expect(row.evidenceDueBy).toBeNull();
      expect(row.responsePermitted).toBe(false);
    });

    it("writes an event ledger row for the delivery", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale);
      const events = await db.transactionDisputeEvent.findMany({
        where: { disputeId: outcome.disputeId },
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.eventKind).toBe("OPENED");
      expect(events[0]?.applied).toBe(true);
    });

    it("stores no buyer identity and no provider payload", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale);
      const row = await db.transactionDispute.findUniqueOrThrow({
        where: { id: outcome.disputeId },
      });
      const serialised = JSON.stringify(row, (_k, v) =>
        typeof v === "bigint" ? String(v) : v,
      ).toLowerCase();
      for (const token of ["synthetic buyer", "example.test", "delivery road", "test street"]) {
        expect(serialised, token).not.toContain(token);
      }
    });
  });

  // — 2 · Idempotency and ordering —

  describe("duplicate and out-of-order provider deliveries", () => {
    it("treats a redelivered event as already recorded, writing nothing new", async () => {
      const sale = await paidSale();
      const obs = observation({
        providerTransactionRef: sale.paymentRef,
        disputedAmountMinorUnits: sale.buyerTotal,
      });
      const first = await recordDisputeObservation(
        obs,
        { recordedAt: DISPUTE_AT },
        { db, ids: disputeIds },
      );
      const second = await recordDisputeObservation(
        obs,
        { recordedAt: DISPUTE_LATER },
        { db, ids: disputeIds },
      );

      expect(first.applied).toBe(true);
      expect(second.applied).toBe(false);
      expect(second.duplicateEvent).toBe(true);
      expect(second.disputeId).toBe(first.disputeId);

      expect(await db.transactionDispute.count({ where: { orderId: sale.orderId } })).toBe(1);
      expect(
        await db.transactionDisputeEvent.count({ where: { disputeId: first.disputeId } }),
      ).toBe(1);
    });

    it("keeps one dispute when the same provider dispute arrives under a new event", async () => {
      const sale = await paidSale();
      const ref = `dp_${pad26(`${TAG}SAME`)}`;
      await dispute(sale, { providerDisputeRef: ref, eventKind: "OPENED" });
      const again = await dispute(
        sale,
        { providerDisputeRef: ref, eventKind: "UPDATED", status: "UNDER_REVIEW" },
        DISPUTE_LATER,
      );
      expect(again.applied).toBe(true);
      expect(await db.transactionDispute.count({ where: { orderId: sale.orderId } })).toBe(1);
      const row = await db.transactionDispute.findUniqueOrThrow({ where: { id: again.disputeId } });
      expect(row.status).toBe("UNDER_REVIEW");
    });

    it("ingests a stale delivery and applies nothing", async () => {
      const sale = await paidSale();
      const ref = `dp_${pad26(`${TAG}STALE`)}`;
      /* Decide it first… */
      await dispute(
        sale,
        { providerDisputeRef: ref, eventKind: "CLOSED", status: "WON", occurredAt: DISPUTE_LATER },
        DISPUTE_LATER,
      );
      /* …then deliver an OLDER event that would reopen it. */
      const stale = await dispute(
        sale,
        {
          providerDisputeRef: ref,
          eventKind: "UPDATED",
          status: "NEEDS_RESPONSE",
          occurredAt: DISPUTE_AT,
        },
        DISPUTE_LATER,
      );

      expect(stale.applied).toBe(false);
      const row = await db.transactionDispute.findUniqueOrThrow({ where: { id: stale.disputeId } });
      expect(row.status).toBe("WON");

      /* Recorded rather than silently dropped, so "why did nothing happen" is
         answerable. */
      const events = await db.transactionDisputeEvent.findMany({
        where: { disputeId: stale.disputeId },
        orderBy: { occurredAt: "asc" },
      });
      expect(events.some((e) => e.applied === false)).toBe(true);
    });

    it("refuses to reopen a decided dispute even on a newer event", async () => {
      const sale = await paidSale();
      const ref = `dp_${pad26(`${TAG}DECIDED`)}`;
      await dispute(
        sale,
        { providerDisputeRef: ref, eventKind: "CLOSED", status: "LOST", occurredAt: DISPUTE_AT },
        DISPUTE_AT,
      );
      await dispute(
        sale,
        {
          providerDisputeRef: ref,
          eventKind: "UPDATED",
          status: "NEEDS_RESPONSE",
          occurredAt: DISPUTE_LATER,
        },
        DISPUTE_LATER,
      );
      const row = await db.transactionDispute.findFirstOrThrow({
        where: { providerDisputeRef: ref },
      });
      expect(row.status).toBe("LOST");
    });
  });

  // — 3 · Attribution failures —

  describe("a dispute Monacado cannot attribute", () => {
    it("is still recorded durably, and invents no Order", async () => {
      const outcome = await recordDisputeObservation(
        observation({ providerTransactionRef: "pi_nothing_matches_this" }),
        { recordedAt: DISPUTE_AT },
        { db, ids: disputeIds },
      );
      expect(outcome.unattributed).toBe(true);
      expect(outcome.remediationCode).toBe("UNATTRIBUTABLE");
      const row = await db.transactionDispute.findUniqueOrThrow({
        where: { id: outcome.disputeId },
      });
      expect(row.orderId).toBeNull();
      expect(row.status).toBe("MANUAL_REMEDIATION_REQUIRED");
    });

    it("creates no notification obligation, because there is no participant to owe one", async () => {
      const outcome = await recordDisputeObservation(
        observation({ providerTransactionRef: "pi_nothing_matches_this_either" }),
        { recordedAt: DISPUTE_AT },
        { db, ids: disputeIds },
      );
      const enqueued = await enqueueDisputeNotices(
        { disputeId: outcome.disputeId, at: DISPUTE_AT },
        { db, notificationIds },
      );
      expect(enqueued.obligationIds).toEqual([]);
      expect(enqueued.deliveries).toEqual([]);
    });

    it("refuses a live-mode dispute arriving at a test deployment", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale, { providerReportedLivemode: true });
      expect(outcome.remediationCode).toBe("LIVEMODE_IN_TEST_DEPLOYMENT");
      expect(outcome.status).toBe("MANUAL_REMEDIATION_REQUIRED");
      /* And it writes no accounting entry off the back of a live object. */
      expect(await db.transactionReversal.count({ where: { orderId: sale.orderId } })).toBe(0);
    });
  });

  // — 4 · The economic hold —

  describe("an open dispute holds unpaid proceeds", () => {
    it("refuses to make a seller's claim payout-eligible, naming the dispute", async () => {
      const sale = await paidSale();
      await dispute(sale);

      const obligation = await db.proceedsObligation.findFirstOrThrow({
        where: { snapshotId: sale.snapshotId, party: "SELLER" },
      });
      expect(obligation.state).toBe("PENDING");

      await expect(
        advanceProceedsObligation(
        { obligationId: obligation.id, to: "ELIGIBLE", at: DISPUTE_LATER },
        deps(),
      ),
      ).rejects.toMatchObject({ holdReason: "SALE_DISPUTED" });

      /* And the claim itself is untouched — the hold rewrites nothing. */
      const after = await db.proceedsObligation.findUniqueOrThrow({ where: { id: obligation.id } });
      expect(after.state).toBe("PENDING");
      expect(after.amountMinorUnits).toBe(obligation.amountMinorUnits);
    });

    it("names the dispute hold distinctly from a reversed sale", async () => {
      const sale = await paidSale();
      await dispute(sale);
      const obligation = await db.proceedsObligation.findFirstOrThrow({
        where: { snapshotId: sale.snapshotId },
      });
      const error = await advanceProceedsObligation(
        { obligationId: obligation.id, to: "ELIGIBLE", at: DISPUTE_LATER },
        deps(),
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProceedsPayoutHeldError);
      expect((error as ProceedsPayoutHeldError).holdReason).toBe("SALE_DISPUTED");
      expect((error as ProceedsPayoutHeldError).holdReason).not.toBe("SALE_REVERSED");
    });

    it("raises recovery evidence for an already-PAID claim, rather than rewriting it", async () => {
      const sale = await paidSale();
      const obligation = await db.proceedsObligation.findFirstOrThrow({
        where: { snapshotId: sale.snapshotId, party: "SELLER" },
      });
      await advanceProceedsObligation(
        { obligationId: obligation.id, to: "ELIGIBLE", at: PAID_AT },
        deps(),
      );
      await advanceProceedsObligation(
        { obligationId: obligation.id, to: "PAID", at: PAID_AT },
        deps(),
      );

      const outcome = await dispute(sale);
      expect(outcome.raisedRecoveryExceptionIds.length).toBeGreaterThan(0);

      const exception = await db.proceedsRecoveryException.findFirstOrThrow({
        where: { proceedsObligationId: obligation.id, causeKind: "DISPUTE" },
      });
      expect(exception.reasonCode).toBe("PAID_BEFORE_DISPUTE");
      expect(exception.disputeId).toBe(outcome.disputeId);
      expect(exception.refundId).toBeNull();
      expect(exception.status).toBe("OPEN");
      /* HISTORY IS NOT REWRITTEN. */
      const after = await db.proceedsObligation.findUniqueOrThrow({ where: { id: obligation.id } });
      expect(after.state).toBe("PAID");
      expect(after.amountMinorUnits).toBe(obligation.amountMinorUnits);
    });

    it("raises recovery evidence for a promoter's already-paid commission too", async () => {
      const sale = await paidSale();
      const obligations = await db.proceedsObligation.findMany({
        where: { snapshotId: sale.snapshotId },
      });
      for (const o of obligations) {
        await advanceProceedsObligation(
        { obligationId: o.id, to: "ELIGIBLE", at: PAID_AT },
        deps(),
      );
        await advanceProceedsObligation(
        { obligationId: o.id, to: "PAID", at: PAID_AT },
        deps(),
      );
      }
      const outcome = await dispute(sale);
      const raised = await db.proceedsRecoveryException.findMany({
        where: { disputeId: outcome.disputeId },
      });
      expect(raised.length).toBe(obligations.length);
      for (const e of raised) expect(e.causeKind).toBe("DISPUTE");
    });

    it("raises nothing for a PENDING claim, which the gate already refuses", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale);
      const pendingObligations = await db.proceedsObligation.findMany({
        where: { snapshotId: sale.snapshotId, state: "PENDING" },
      });
      expect(pendingObligations.length).toBeGreaterThan(0);
      for (const o of pendingObligations) {
        const raised = await db.proceedsRecoveryException.count({
          where: { proceedsObligationId: o.id, causeKind: "DISPUTE" },
        });
        expect(raised).toBe(0);
      }
      expect(outcome.heldObligationIds.length).toBeGreaterThan(0);
    });

    it("raises exactly one exception per claim per cause, however many events arrive", async () => {
      const sale = await paidSale();
      const obligation = await db.proceedsObligation.findFirstOrThrow({
        where: { snapshotId: sale.snapshotId, party: "SELLER" },
      });
      await advanceProceedsObligation(
        { obligationId: obligation.id, to: "ELIGIBLE", at: PAID_AT },
        deps(),
      );
      await advanceProceedsObligation(
        { obligationId: obligation.id, to: "PAID", at: PAID_AT },
        deps(),
      );

      const ref = `dp_${pad26(`${TAG}MULTI`)}`;
      await dispute(sale, { providerDisputeRef: ref, eventKind: "OPENED" });
      await dispute(
        sale,
        { providerDisputeRef: ref, eventKind: "UPDATED", status: "UNDER_REVIEW" },
        DISPUTE_LATER,
      );

      expect(
        await db.proceedsRecoveryException.count({
          where: { proceedsObligationId: obligation.id, causeKind: "DISPUTE" },
        }),
      ).toBe(1);
    });

    it("executes no clawback, no offset, and no payout", async () => {
      const sale = await paidSale();
      const obligation = await db.proceedsObligation.findFirstOrThrow({
        where: { snapshotId: sale.snapshotId, party: "SELLER" },
      });
      await advanceProceedsObligation(
        { obligationId: obligation.id, to: "ELIGIBLE", at: PAID_AT },
        deps(),
      );
      await advanceProceedsObligation(
        { obligationId: obligation.id, to: "PAID", at: PAID_AT },
        deps(),
      );
      const outcome = await dispute(sale);
      const exception = await db.proceedsRecoveryException.findFirstOrThrow({
        where: { disputeId: outcome.disputeId },
      });
      /* A record of what is owed back, and nothing that moves it. */
      expect(exception.status).toBe("OPEN");
      expect(exception.resolutionCode).toBeNull();
    });
  });

  // — 5 · Won —

  describe("a dispute Monacado wins", () => {
    it("leaves the original economics entirely intact", async () => {
      const sale = await paidSale();
      const before = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { id: sale.snapshotId },
      });

      const ref = `dp_${pad26(`${TAG}WON`)}`;
      await dispute(sale, { providerDisputeRef: ref });
      await dispute(
        sale,
        { providerDisputeRef: ref, eventKind: "CLOSED", status: "WON", occurredAt: DISPUTE_LATER },
        DISPUTE_LATER,
      );

      const after = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { id: sale.snapshotId },
      });
      expect(after).toEqual(before);
      expect(await db.transactionReversal.count({ where: { orderId: sale.orderId } })).toBe(0);
      const order = await db.order.findUniqueOrThrow({ where: { id: sale.orderId } });
      expect(order.lifecycle).toBe("PAID");
    });

    it("lifts the hold with nothing to un-set, so no stale hold can survive", async () => {
      const sale = await paidSale();
      const ref = `dp_${pad26(`${TAG}WONHOLD`)}`;
      await dispute(sale, { providerDisputeRef: ref });

      const obligation = await db.proceedsObligation.findFirstOrThrow({
        where: { snapshotId: sale.snapshotId, party: "SELLER" },
      });
      await expect(
        advanceProceedsObligation(
        { obligationId: obligation.id, to: "ELIGIBLE", at: DISPUTE_LATER },
        deps(),
      ),
      ).rejects.toThrow();

      await dispute(
        sale,
        { providerDisputeRef: ref, eventKind: "CLOSED", status: "WON", occurredAt: DISPUTE_LATER },
        DISPUTE_LATER,
      );

      /* The hold is a predicate over the dispute rows, so winning releases it
         without anything being cleared. */
      const advanced = await advanceProceedsObligation(
        { obligationId: obligation.id, to: "ELIGIBLE", at: LATER },
        deps(),
      );
      expect(advanced.state).toBe("ELIGIBLE");
    });

    it("closes the exceptions it raised, as settled rather than as raised in error", async () => {
      const sale = await paidSale();
      const obligation = await db.proceedsObligation.findFirstOrThrow({
        where: { snapshotId: sale.snapshotId, party: "SELLER" },
      });
      await advanceProceedsObligation(
        { obligationId: obligation.id, to: "ELIGIBLE", at: PAID_AT },
        deps(),
      );
      await advanceProceedsObligation(
        { obligationId: obligation.id, to: "PAID", at: PAID_AT },
        deps(),
      );

      const ref = `dp_${pad26(`${TAG}WONEXC`)}`;
      await dispute(sale, { providerDisputeRef: ref });
      const won = await dispute(
        sale,
        { providerDisputeRef: ref, eventKind: "CLOSED", status: "WON", occurredAt: DISPUTE_LATER },
        DISPUTE_LATER,
      );
      expect(won.closedRecoveryExceptionIds.length).toBeGreaterThan(0);

      const exception = await db.proceedsRecoveryException.findFirstOrThrow({
        where: { disputeId: won.disputeId },
      });
      expect(exception.status).toBe("RESOLVED");
      expect(exception.resolutionCode).toBe("DISPUTE_RESOLVED_NO_RECOVERY_DUE");
      expect(exception.resolutionCode).not.toBe("RAISED_IN_ERROR");
    });

    it("fabricates no new proceeds obligation and no second sale", async () => {
      const sale = await paidSale();
      const before = await db.proceedsObligation.count({ where: { snapshotId: sale.snapshotId } });
      const ref = `dp_${pad26(`${TAG}WONNEW`)}`;
      await dispute(sale, { providerDisputeRef: ref });
      await dispute(
        sale,
        { providerDisputeRef: ref, eventKind: "CLOSED", status: "WON", occurredAt: DISPUTE_LATER },
        DISPUTE_LATER,
      );
      expect(await db.proceedsObligation.count({ where: { snapshotId: sale.snapshotId } })).toBe(
        before,
      );
      expect(await db.transactionEconomicSnapshot.count({ where: { orderId: sale.orderId } })).toBe(
        1,
      );
    });
  });

  // — 6 · Lost —

  describe("a dispute Monacado loses", () => {
    it("records a CHARGEBACK reversal against the sale, using 1.2's own path", async () => {
      const sale = await paidSale();
      const lost = await dispute(sale, { eventKind: "CLOSED", status: "LOST" });

      expect(lost.economicEffect).toBe("REVERSED_BY_THIS_DISPUTE");
      expect(lost.reversalId).not.toBeNull();

      const reversal = await db.transactionReversal.findUniqueOrThrow({
        where: { snapshotId: sale.snapshotId },
      });
      expect(reversal.kind).toBe("CHARGEBACK");
      expect(reversal.reasonCode).toBe("DISPUTED_BY_BUYER");
      expect(reversal.scope).toBe("FULL");
    });

    it("moves the settlement to REVERSED", async () => {
      const sale = await paidSale();
      await dispute(sale, { eventKind: "CLOSED", status: "LOST" });
      const settlement = await db.transactionSettlement.findUniqueOrThrow({
        where: { snapshotId: sale.snapshotId },
      });
      expect(settlement.state).toBe("REVERSED");
    });

    it("leaves the original economic snapshot byte-identical", async () => {
      const sale = await paidSale();
      const before = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { id: sale.snapshotId },
      });
      await dispute(sale, { eventKind: "CLOSED", status: "LOST" });
      const after = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { id: sale.snapshotId },
      });
      expect(after).toEqual(before);
    });

    it("leaves the Order PAID, because a chargeback is not a sale that unhappened", async () => {
      const sale = await paidSale();
      await dispute(sale, { eventKind: "CLOSED", status: "LOST" });
      const order = await db.order.findUniqueOrThrow({ where: { id: sale.orderId } });
      expect(order.lifecycle).toBe("PAID");
      expect(order.paidAt).not.toBeNull();
    });

    it("stops unpaid proceeds from paying", async () => {
      const sale = await paidSale();
      await dispute(sale, { eventKind: "CLOSED", status: "LOST" });
      const obligation = await db.proceedsObligation.findFirstOrThrow({
        where: { snapshotId: sale.snapshotId, state: "PENDING" },
      });
      await expect(
        advanceProceedsObligation(
        { obligationId: obligation.id, to: "ELIGIBLE", at: LATER },
        deps(),
      ),
      ).rejects.toMatchObject({ holdReason: "SALE_REVERSED" });
    });

    it("leaves already-paid economics as history and raises recovery evidence", async () => {
      const sale = await paidSale();
      const obligation = await db.proceedsObligation.findFirstOrThrow({
        where: { snapshotId: sale.snapshotId, party: "SELLER" },
      });
      await advanceProceedsObligation(
        { obligationId: obligation.id, to: "ELIGIBLE", at: PAID_AT },
        deps(),
      );
      await advanceProceedsObligation(
        { obligationId: obligation.id, to: "PAID", at: PAID_AT },
        deps(),
      );

      const lost = await dispute(sale, { eventKind: "CLOSED", status: "LOST" });
      const exception = await db.proceedsRecoveryException.findFirstOrThrow({
        where: { disputeId: lost.disputeId, proceedsObligationId: obligation.id },
      });
      expect(exception.reasonCode).toBe("PAID_BEFORE_DISPUTE");
      const after = await db.proceedsObligation.findUniqueOrThrow({ where: { id: obligation.id } });
      expect(after.state).toBe("PAID");
    });

    it("refuses a partial chargeback rather than rounding it up to a full reversal", async () => {
      const sale = await paidSale();
      const partial = await dispute(sale, {
        eventKind: "CLOSED",
        status: "LOST",
        disputedAmountMinorUnits: Math.floor(sale.buyerTotal / 2),
      });

      expect(partial.remediationCode).toBe("PARTIAL_AMOUNT_NOT_EXPRESSIBLE");
      expect(partial.economicEffect).toBe("NOT_EXPRESSIBLE");
      expect(partial.reversalId).toBeNull();
      /* NO accounting entry at all — misstating what three parties owe would be
         worse than recording nothing and telling an operator. */
      expect(await db.transactionReversal.count({ where: { orderId: sale.orderId } })).toBe(0);
    });

    it("records funds withdrawal separately from the verdict", async () => {
      const sale = await paidSale();
      const ref = `dp_${pad26(`${TAG}FUNDS`)}`;
      await dispute(sale, { providerDisputeRef: ref });
      await dispute(
        sale,
        {
          providerDisputeRef: ref,
          eventKind: "FUNDS_WITHDRAWN",
          status: "UNDER_REVIEW",
          occurredAt: DISPUTE_LATER,
        },
        DISPUTE_LATER,
      );
      const row = await db.transactionDispute.findFirstOrThrow({
        where: { providerDisputeRef: ref },
      });
      /* Money gone, verdict not yet in. Two axes, and the row can say so. */
      expect(row.fundsState).toBe("WITHDRAWN");
      expect(row.status).toBe("UNDER_REVIEW");
      expect(row.fundsWithdrawnAt).not.toBeNull();
    });

    it("never un-reverses a settlement when funds are reinstated", async () => {
      const sale = await paidSale();
      const ref = `dp_${pad26(`${TAG}REINST`)}`;
      await dispute(sale, { providerDisputeRef: ref, eventKind: "CLOSED", status: "LOST" });
      await dispute(
        sale,
        {
          providerDisputeRef: ref,
          eventKind: "FUNDS_REINSTATED",
          status: "LOST",
          occurredAt: DISPUTE_LATER,
        },
        DISPUTE_LATER,
      );
      const settlement = await db.transactionSettlement.findUniqueOrThrow({
        where: { snapshotId: sale.snapshotId },
      });
      /* REVERSED is terminal. Reinstatement is recorded as new evidence, not as
         an undo. */
      expect(settlement.state).toBe("REVERSED");
      const row = await db.transactionDispute.findFirstOrThrow({
        where: { providerDisputeRef: ref },
      });
      expect(row.fundsState).toBe("REINSTATED");
      expect(await db.transactionReversal.count({ where: { orderId: sale.orderId } })).toBe(1);
    });
  });

  // — 7 · Refund interaction —

  describe("a refund and a dispute cannot both reverse the same sale", () => {
    it("refuses a refund while a dispute is open", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      await dispute(sale);

      const eligibility = await evaluateRefundEligibility(
        { orderId: sale.orderId, at: DISPUTE_LATER },
        { db },
      );
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.refusals).toContain("SALE_DISPUTE_OPEN");
    });

    it("refuses a refund after a dispute is lost, naming the chargeback", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      await dispute(sale, { eventKind: "CLOSED", status: "LOST" });

      const eligibility = await evaluateRefundEligibility(
        { orderId: sale.orderId, at: LATER },
        { db },
      );
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.refusals).toContain("SALE_DISPUTE_LOST");
    });

    it("permits a refund again once a dispute is won", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      const ref = `dp_${pad26(`${TAG}WONREF`)}`;
      await dispute(sale, { providerDisputeRef: ref });
      await dispute(
        sale,
        { providerDisputeRef: ref, eventKind: "CLOSED", status: "WON", occurredAt: DISPUTE_LATER },
        DISPUTE_LATER,
      );
      const eligibility = await evaluateRefundEligibility(
        { orderId: sale.orderId, at: LATER },
        { db },
      );
      expect(eligibility.refusals).not.toContain("SALE_DISPUTE_OPEN");
      expect(eligibility.refusals).not.toContain("SALE_DISPUTE_LOST");
      expect(eligibility.eligible).toBe(true);
    });

    it("writes no second reversal when a dispute is lost on an already-refunded sale", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      await requestOrderRefund(
        {
          orderId: sale.orderId,
          reasonCode: "CUSTOMER_REQUEST",
          requestorKind: "OPERATOR",
          requestedByAccountId: null,
          requestedAt: REFUND_AT,
        },
        refundDeps(),
      );
      await runRefundCycle(
        { at: REFUND_AT, limit: 5 },
        { ...refundDeps(), refundPort: refundPortDouble(), taxReversalPort: taxReversalPortDouble() },
      );
      expect(
        await db.orderRefund.count({ where: { orderId: sale.orderId, status: "REFUNDED" } }),
      ).toBe(1);
      const reversalsBefore = await db.transactionReversal.count({
        where: { orderId: sale.orderId },
      });

      const lost = await dispute(sale, { eventKind: "CLOSED", status: "LOST" }, LATER);

      /* A DELIBERATE refusal, not a caught constraint violation — and the row
         says which of the two happened rather than leaving a reader to guess a
         reversal was simply missed. */
      expect(lost.economicEffect).toBe("ALREADY_REVERSED_BY_REFUND");
      expect(
        await db.transactionReversal.count({ where: { orderId: sale.orderId } }),
      ).toBe(reversalsBefore);
    });

    it("reverses the same tax at most once", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      await requestOrderRefund(
        {
          orderId: sale.orderId,
          reasonCode: "CUSTOMER_REQUEST",
          requestorKind: "OPERATOR",
          requestedByAccountId: null,
          requestedAt: REFUND_AT,
        },
        refundDeps(),
      );
      await runRefundCycle(
        { at: REFUND_AT, limit: 5 },
        { ...refundDeps(), refundPort: refundPortDouble(), taxReversalPort: taxReversalPortDouble() },
      );
      const before = await db.orderTaxReversal.count({ where: { orderId: sale.orderId } });
      const lost = await dispute(sale, { eventKind: "CLOSED", status: "LOST" }, LATER);
      expect(lost.taxConsequence).toBe("ALREADY_REVERSED_BY_REFUND");
      expect(await db.orderTaxReversal.count({ where: { orderId: sale.orderId } })).toBe(before);
    });

    it("raises no second recovery exception against a claim a refund already covered", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      const obligation = await db.proceedsObligation.findFirstOrThrow({
        where: { snapshotId: sale.snapshotId, party: "SELLER" },
      });
      await advanceProceedsObligation(
        { obligationId: obligation.id, to: "ELIGIBLE", at: PAID_AT },
        deps(),
      );
      await advanceProceedsObligation(
        { obligationId: obligation.id, to: "PAID", at: PAID_AT },
        deps(),
      );

      await requestOrderRefund(
        {
          orderId: sale.orderId,
          reasonCode: "CUSTOMER_REQUEST",
          requestorKind: "OPERATOR",
          requestedByAccountId: null,
          requestedAt: REFUND_AT,
        },
        refundDeps(),
      );
      await runRefundCycle(
        { at: REFUND_AT, limit: 5 },
        { ...refundDeps(), refundPort: refundPortDouble(), taxReversalPort: taxReversalPortDouble() },
      );
      const refundCaused = await db.proceedsRecoveryException.count({
        where: { proceedsObligationId: obligation.id, causeKind: "REFUND" },
      });
      expect(refundCaused).toBe(1);

      await dispute(sale, { eventKind: "CLOSED", status: "LOST" }, LATER);

      /* The two causes are separate rows against one claim — an operator must
         see both facts, and neither may overwrite the other. */
      expect(
        await db.proceedsRecoveryException.count({
          where: { proceedsObligationId: obligation.id, causeKind: "REFUND" },
        }),
      ).toBe(1);
      expect(
        await db.proceedsRecoveryException.count({
          where: { proceedsObligationId: obligation.id, causeKind: "DISPUTE" },
        }),
      ).toBeLessThanOrEqual(1);
    });

    it("reports the blocking dispute to the refund path from inside a transaction", async () => {
      const sale = await paidSale();
      await dispute(sale);
      const blocking = await db.$transaction((tx) => disputeBlockingRefundIn(tx, sale.snapshotId));
      expect(blocking).toBe("SALE_DISPUTE_OPEN");
    });
  });

  // — 8 · Tax —

  describe("the tax consequence of a lost dispute", () => {
    it("fails closed when a recorded tax transaction cannot be corrected", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      const lost = await dispute(sale, { eventKind: "CLOSED", status: "LOST" });

      expect(lost.taxConsequence).toBe("REVERSAL_REQUIRED_NOT_EXPRESSIBLE");
      /* Nothing is approximated: no reversal row is fabricated, and no refund
         row is invented to hang one from. */
      expect(await db.orderTaxReversal.count({ where: { orderId: sale.orderId } })).toBe(0);
      expect(await db.orderRefund.count({ where: { orderId: sale.orderId } })).toBe(0);
    });

    it("says there is nothing to correct when no tax transaction was recorded", async () => {
      const sale = await paidSale();
      const lost = await dispute(sale, { eventKind: "CLOSED", status: "LOST" });
      expect(lost.taxConsequence).toBe("NO_TAX_TRANSACTION");
    });

    it("handles a zero-tax sale on the same terms", async () => {
      const sale = await paidSale({ taxMinorUnits: 0 });
      await recordTax(sale);
      const lost = await dispute(sale, { eventKind: "CLOSED", status: "LOST" });
      /* A jurisdiction where nothing was collected is still a return line, so
         this is the same answer, not a special case. */
      expect(lost.taxConsequence).toBe("REVERSAL_REQUIRED_NOT_EXPRESSIBLE");
    });

    it("requires no action when the sale stands", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      const ref = `dp_${pad26(`${TAG}TAXWON`)}`;
      await dispute(sale, { providerDisputeRef: ref });
      const won = await dispute(
        sale,
        { providerDisputeRef: ref, eventKind: "CLOSED", status: "WON", occurredAt: DISPUTE_LATER },
        DISPUTE_LATER,
      );
      expect(won.taxConsequence).toBe("NO_ACTION_REQUIRED");
      expect(await db.orderTaxReversal.count({ where: { orderId: sale.orderId } })).toBe(0);
    });
  });

  // — 9 · Notifications —

  describe("notifications", () => {
    it("owes the seller an obligation and one message, and the buyer nothing", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale);
      const enqueued = await enqueueDisputeNotices(
        { disputeId: outcome.disputeId, at: DISPUTE_AT },
        { db, notificationIds },
      );

      expect(enqueued.obligationIds.length).toBeGreaterThan(0);
      expect(enqueued.deliveries.length).toBeGreaterThan(0);
      for (const delivery of enqueued.deliveries) {
        expect(delivery.purpose).toBe("DISPUTE_RECORDED");
        expect(delivery.audience).not.toBe("BUYER");
      }
    });

    it("does not resolve onto the refund's obligation for the same Order", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      await requestOrderRefund(
        {
          orderId: sale.orderId,
          reasonCode: "CUSTOMER_REQUEST",
          requestorKind: "OPERATOR",
          requestedByAccountId: null,
          requestedAt: REFUND_AT,
        },
        refundDeps(),
      );
      await runRefundCycle(
        { at: REFUND_AT, limit: 5 },
        { ...refundDeps(), refundPort: refundPortDouble(), taxReversalPort: taxReversalPortDouble() },
      );
      const refundObligations = await db.notificationObligation.findMany({
        where: { subjectRef: sale.orderId, category: "REFUND_OR_CHARGEBACK" },
      });
      expect(refundObligations.length).toBeGreaterThan(0);

      const outcome = await dispute(sale, { eventKind: "CLOSED", status: "LOST" }, LATER);
      const enqueued = await enqueueDisputeNotices(
        { disputeId: outcome.disputeId, at: LATER },
        { db, notificationIds },
      );

      /* The dispute obligation is a DIFFERENT row: without a context code it
         would have upserted onto the refund's, and the seller would never have
         learned about the chargeback. */
      for (const id of enqueued.obligationIds) {
        expect(refundObligations.map((o) => o.id)).not.toContain(id);
      }
      const disputeObligations = await db.notificationObligation.findMany({
        where: { subjectRef: sale.orderId, contextCode: { not: null } },
      });
      expect(disputeObligations.length).toBeGreaterThan(0);
    });

    it("is idempotent across repeated calls", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale);
      const first = await enqueueDisputeNotices(
        { disputeId: outcome.disputeId, at: DISPUTE_AT },
        { db, notificationIds },
      );
      const second = await enqueueDisputeNotices(
        { disputeId: outcome.disputeId, at: DISPUTE_AT },
        { db, notificationIds },
      );
      expect(second.obligationIds).toEqual(first.obligationIds);
      expect(second.deliveries.map((d) => d.deliveryId)).toEqual(
        first.deliveries.map((d) => d.deliveryId),
      );
    });

    it("does not determine financial truth", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale, { eventKind: "CLOSED", status: "LOST" });
      /* The reversal exists whether or not any message was ever queued. */
      expect(await db.transactionReversal.count({ where: { snapshotId: sale.snapshotId } })).toBe(1);
      expect(await db.outboundEmailDelivery.count({ where: { subjectRef: sale.orderId } })).toBe(
        await db.outboundEmailDelivery.count({ where: { subjectRef: sale.orderId } }),
      );
      const row = await db.transactionDispute.findUniqueOrThrow({
        where: { id: outcome.disputeId },
      });
      expect(row.economicEffect).toBe("REVERSED_BY_THIS_DISPUTE");
    });
  });

  // — 10 · Operator tooling —

  describe("operator tooling", () => {
    it("counts the book without naming anybody or any amount", async () => {
      const sale = await paidSale();
      await dispute(sale);
      const backlog = await summarizeDisputeBacklog({ at: DISPUTE_LATER }, { db });
      expect(backlog.needsResponse).toBeGreaterThan(0);
      expect(backlog.heldObligations).toBeGreaterThan(0);

      const serialised = JSON.stringify(backlog);
      expect(serialised).not.toContain("mon:order:");
      expect(serialised).not.toContain("mon:mpart:");
      expect(serialised).not.toContain(String(sale.buyerTotal));
    });

    it("surfaces the deadline and the action, with no buyer detail", async () => {
      const sale = await paidSale();
      await dispute(sale);
      const rows = await inspectOpenDisputes({ at: DISPUTE_LATER }, { db });
      expect(rows.length).toBeGreaterThan(0);
      const row = rows.find((r) => r.orderId === sale.orderId);
      expect(row).toBeDefined();
      expect(row?.action).toBe("ASSEMBLE_EVIDENCE_AND_SUBMIT_IN_DASHBOARD");
      expect(row?.secondsUntilDeadline).toBeGreaterThan(0);
      expect(row?.heldObligationCount).toBeGreaterThan(0);

      const serialised = JSON.stringify(rows);
      expect(serialised).not.toContain("Synthetic Buyer");
      expect(serialised).not.toContain("example.test");
    });

    it("blocks readiness while a dispute needs a human", async () => {
      await recordDisputeObservation(
        observation({ providerTransactionRef: "pi_no_such_settlement_here" }),
        { recordedAt: DISPUTE_AT },
        { db, ids: disputeIds },
      );
      const readiness = await evaluateDisputeOperationsReadiness({ at: DISPUTE_LATER }, { db });
      expect(readiness.healthy).toBe(false);
      expect(readiness.blockers).toContain("DISPUTE_UNATTRIBUTED");
    });

    it("reports an empty book as healthy", async () => {
      const readiness = await evaluateDisputeOperationsReadiness({ at: DISPUTE_LATER }, { db });
      expect(readiness.healthy).toBe(true);
      expect(readiness.blockers).toEqual([]);
    });

    it("names the evidence Monacado holds, by reference and never by value", async () => {
      const sale = await paidSale();
      const evidence = await assembleDisputeEvidenceMetadata(sale.orderId, { db });
      expect(evidence.length).toBeGreaterThan(0);

      const shipping = evidence.find((e) => e.evidenceCode === "SHIPPING_DOCUMENTATION");
      expect(shipping?.available).toBe(false);

      const policy = evidence.find(
        (e) => e.evidenceCode === "REFUND_POLICY_VERSION_BOUND_AT_PURCHASE",
      );
      expect(policy?.available).toBe(true);

      const serialised = JSON.stringify(evidence);
      expect(serialised).not.toContain("Synthetic Buyer");
      expect(serialised).not.toContain("example.test");
    });
  });

  // — 11 · Reconciliation —

  describe("reconciliation, from local records alone", () => {
    it("reports a held open dispute as working correctly", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale);
      const result = await reconcileDispute(
        { disputeId: outcome.disputeId, at: DISPUTE_LATER },
        { db },
      );
      expect(result.findings).toContain("DISPUTE_OPEN_PROCEEDS_HELD");
      expect(result.needsOperator).toBe(false);
    });

    it("detects a dispute that matches no sale", async () => {
      const outcome = await recordDisputeObservation(
        observation({ providerTransactionRef: "pi_orphan_reconcile" }),
        { recordedAt: DISPUTE_AT },
        { db, ids: disputeIds },
      );
      const result = await reconcileDispute(
        { disputeId: outcome.disputeId, at: DISPUTE_LATER },
        { db },
      );
      expect(result.findings).toContain("DISPUTE_UNATTRIBUTED");
      expect(result.needsOperator).toBe(true);
    });

    it("detects a refunded sale that a dispute also reversed", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      await requestOrderRefund(
        {
          orderId: sale.orderId,
          reasonCode: "CUSTOMER_REQUEST",
          requestorKind: "OPERATOR",
          requestedByAccountId: null,
          requestedAt: REFUND_AT,
        },
        refundDeps(),
      );
      await runRefundCycle(
        { at: REFUND_AT, limit: 5 },
        { ...refundDeps(), refundPort: refundPortDouble(), taxReversalPort: taxReversalPortDouble() },
      );
      const lost = await dispute(sale, { eventKind: "CLOSED", status: "LOST" }, LATER);
      const result = await reconcileDispute({ disputeId: lost.disputeId, at: LATER }, { db });
      expect(result.findings).toContain("DISPUTE_ON_ALREADY_REFUNDED_SALE");
      expect(result.needsOperator).toBe(true);
    });

    it("detects an unresolved tax consequence on a lost dispute", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      const lost = await dispute(sale, { eventKind: "CLOSED", status: "LOST" });
      const result = await reconcileDispute({ disputeId: lost.disputeId, at: LATER }, { db });
      expect(result.findings).toContain("DISPUTE_TAX_CONSEQUENCE_UNRESOLVED");
      expect(result.findings).toContain("DISPUTE_TAX_TRANSACTION_STILL_REPORTED");
    });

    it("detects a claim still payout-eligible under a dispute", async () => {
      const sale = await paidSale();
      const obligation = await db.proceedsObligation.findFirstOrThrow({
        where: { snapshotId: sale.snapshotId, party: "SELLER" },
      });
      await advanceProceedsObligation(
        { obligationId: obligation.id, to: "ELIGIBLE", at: PAID_AT },
        deps(),
      );
      const outcome = await dispute(sale);
      const result = await reconcileDispute(
        { disputeId: outcome.disputeId, at: DISPUTE_LATER },
        { db },
      );
      expect(result.findings).toContain("DISPUTE_PROCEEDS_STILL_PAYOUT_ELIGIBLE");
    });

    it("summarises a sweep", async () => {
      const sale = await paidSale();
      await dispute(sale);
      const results = await reconcileOpenDisputes({ at: DISPUTE_LATER }, { db });
      const summary = summarizeDisputeReconciliation(results);
      expect(summary.reconciled).toBeGreaterThan(0);
      expect(summary.reconciled).toBe(results.length);
    });
  });

  // — 12 · Readiness —

  describe("live-commerce readiness", () => {
    it("refuses to call a marketplace launch-ready without a dispute response path", async () => {
      const readiness = await evaluateLiveCommerceReadiness(LATER, {
        db,
        env: {} as Record<string, string>,
      });
      expect(readiness.ready).toBe(false);
      /* 1.12 built the adapter, so the unconditional blocker is gone — replaced
         by three that say precisely WHY a launch is still refused. The claim this
         test makes is unchanged: no dispute response path, no launch. */
      /* The §I ruling removed the governance blocker and 1.12 built the adapter,
         so the launch is refused on capability alone — which is the honest
         reason. */
      expect(readiness.blockers).not.toContain("DISPUTE_EVIDENCE_RESPONSE_NOT_IMPLEMENTED");
      expect(readiness.blockers).not.toContain("DISPUTE_EVIDENCE_SUBMISSION_NOT_ENABLED");
      expect(readiness.blockers).toContain("DISPUTE_PROVIDER_MODE_TEST_ONLY");
      expect(readiness.blockers).toContain("DISPUTE_EVIDENCE_ASSEMBLY_INCOMPLETE");
      expect(readiness.blockers).toContain("DISPUTE_EVIDENCE_DOCUMENT_SUBMISSION_NOT_IMPLEMENTED");
      expect(readiness.ready).toBe(false);
      expect(readiness.blockers).toContain("DISPUTE_INTAKE_NOT_CONFIGURED");
    });

    it("blocks on an unhealthy dispute book, not merely on configuration", async () => {
      await recordDisputeObservation(
        observation({ providerTransactionRef: "pi_readiness_orphan" }),
        { recordedAt: DISPUTE_AT },
        { db, ids: disputeIds },
      );
      const readiness = await evaluateLiveCommerceReadiness(LATER, {
        db,
        env: {} as Record<string, string>,
      });
      expect(readiness.blockers).toContain("DISPUTE_BACKLOG_UNHEALTHY");
    });
  });

  // — 13 · The private capsule —

  describe("the private dispute capsule", () => {
    it("projects a stored dispute with no buyer detail, and publishes nothing", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale);
      const record = await getDispute(outcome.disputeId, { db });
      expect(record).not.toBeNull();

      const capsule = projectDisputeCapsule(record, {
        generatedAt: LATER,
        capsuleSemver: "1.0.0",
        mappingVersion: "dispute-mapping/1.0.0",
      });
      expect(capsule.visibility).toBe("PRIVATE");

      const serialised = JSON.stringify(capsule);
      expect(serialised).not.toContain("Synthetic Buyer");
      expect(serialised).not.toContain("example.test");
      expect(serialised).not.toContain("Delivery Road");

      /* Nothing is queued for publication anywhere. */
      expect(
        await db.publicationOutbox.count({
          where: { publication: { is: { internalProductId: { startsWith: PRODUCT_PREFIX } } } },
        }),
      ).toBe(0);
    });
  });

  // — 14 · Suite hygiene —

  describe("suite hygiene", () => {
    it("published nothing to AgentNet and wrote no registrar receipt", async () => {
      const sale = await paidSale();
      await dispute(sale, { eventKind: "CLOSED", status: "LOST" });
      expect(
        await db.publicationOutbox.count({
          where: { publication: { is: { internalProductId: { startsWith: PRODUCT_PREFIX } } } },
        }),
      ).toBe(0);
      expect(
        await db.productPublication.count({
          where: { internalProductId: { startsWith: PRODUCT_PREFIX } },
        }),
      ).toBe(0);
      expect(
        await db.productNode.count({
          where: { internalProductId: { startsWith: PRODUCT_PREFIX } },
        }),
      ).toBe(0);
    });
  });

  // — 12 · Evidence response (Phase 1.12) —

  describe("assembling, reviewing, and sending a dispute response", () => {
    it("assembles evidence from immutable historical records alone", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      const outcome = await dispute(sale);

      const pkg = await prepareDisputeEvidence(
        { disputeId: outcome.disputeId, at: DISPUTE_LATER },
        { db, ids: disputeIds },
      );

      expect(pkg.status).toBe("PREPARED");
      expect(pkg.itemCodes).toContain("REFUND_POLICY_VERSION_BOUND_AT_PURCHASE");
      expect(pkg.itemCodes).toContain("MARKETPLACE_POLICY_VERSION_AT_PURCHASE");
      expect(pkg.itemCodes).toContain("SERVICE_DATE");
      expect(pkg.approved).toBe(false);
      expect(pkg.submitted).toBe(false);
    });

    it("cites the sale-time product version, not today's listing", async () => {
      /* The 1.11 defect this phase corrects: the availability map pointed at the
         stable Listing row, so a seller editing their product after a chargeback
         silently rewrote Monacado's evidence. The pin now comes from the tax
         transaction, which records the exact source version at sale time. */
      const sale = await paidSale();
      await recordTax(sale);
      const evidence = await assembleDisputeEvidenceMetadata(sale.orderId, { db });
      const product = evidence.find((e) => e.evidenceCode === "PRODUCT_DESCRIPTION_AT_SALE");
      expect(product?.available).toBe(true);
      expect(product?.monacadoRecordRef).toContain("@");
      expect(product?.monacadoRecordRef).not.toBe(sale.orderId);
    });

    it("reports no product description where no sale-time version was pinned", async () => {
      /* Honest rather than convenient: with no sale-time pin there is no
         immutable description, and pointing at a mutable listing would be the
         live-read substitution the receipt contract already refused. */
      const sale = await paidSale();
      await db.orderTaxTransaction.deleteMany({ where: { orderId: sale.orderId } });
      const evidence = await assembleDisputeEvidenceMetadata(sale.orderId, { db });
      const product = evidence.find((e) => e.evidenceCode === "PRODUCT_DESCRIPTION_AT_SALE");
      expect(product?.available).toBe(false);
      expect(product?.monacadoRecordRef).toBeNull();
    });

    it("does not count seller mail as buyer correspondence", async () => {
      /* The other 1.11 defect. `SALE_RECORDED` goes to the seller, and counting it
         would have Monacado telling a card network it held customer
         communication it does not hold. */
      const sale = await paidSale();
      const evidence = await assembleDisputeEvidenceMetadata(sale.orderId, { db });
      const communication = evidence.find((e) => e.evidenceCode === "CUSTOMER_COMMUNICATION");
      const buyerMail = await db.outboundEmailDelivery.count({
        where: { subjectKind: "ORDER", subjectRef: sale.orderId, audience: "BUYER" },
      });
      expect(communication?.available).toBe(buyerMail > 0);
    });

    it("does not transmit a seller's attestation on its own", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale);
      await recordSellerAttestation(
        {
          disputeId: outcome.disputeId,
          claims: ["GOODS_OR_SERVICE_SUPPLIED", "DELIVERY_EVIDENCE_HELD_OUTSIDE_MONACADO"],
          participantId: sale.seller.participantId,
          accountId: "acct-operator",
          at: DISPUTE_LATER,
        },
        { db, ids: disputeIds },
      );

      const pkg = await prepareDisputeEvidence(
        { disputeId: outcome.disputeId, at: DISPUTE_LATER },
        { db, ids: disputeIds },
      );
      expect(pkg.attestationClaims).toContain("GOODS_OR_SERVICE_SUPPLIED");
      /* Recorded, carried in the package — and still not approved and not sent. */
      expect(pkg.approved).toBe(false);
      expect(pkg.submitted).toBe(false);
      expect(pkg.status).toBe("PREPARED");
    });

    it("refuses to submit a package no operator approved", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale);
      const pkg = await prepareDisputeEvidence(
        { disputeId: outcome.disputeId, at: DISPUTE_LATER },
        { db, ids: disputeIds },
      );

      await expect(
        submitDisputeEvidence(
          { preparationId: pkg.preparationId, at: DISPUTE_LATER },
          { db, env: {} },
        ),
      ).rejects.toMatchObject({ reason: "NOT_APPROVED" });
    });

    it("refuses to send a package with no provider port configured", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale);
      const pkg = await prepareDisputeEvidence(
        { disputeId: outcome.disputeId, at: DISPUTE_LATER },
        { db, ids: disputeIds },
      );
      const approved = await approveDisputeEvidence(
        { preparationId: pkg.preparationId, accountId: "acct-operator", at: DISPUTE_LATER },
        { db },
      );
      expect(approved.approved).toBe(true);

      /* Representment is authorised — the refusal here is capability, not
         permission, which is exactly the distinction the §I ruling introduced. */
      await expect(
        submitDisputeEvidence({ preparationId: pkg.preparationId, at: DISPUTE_LATER }, { db, env: {} }),
      ).rejects.toMatchObject({ reason: "PROVIDER_NOT_CONFIGURED" });

      const row = await db.disputeEvidencePreparation.findUniqueOrThrow({
        where: { id: pkg.preparationId },
      });
      expect(row.status).toBe("SUBMISSION_REFUSED");
      expect(row.failureCode).toBe("PROVIDER_NOT_CONFIGURED");
      expect(row.submittedAt).toBeNull();
    });

    it("invalidates an approval that a provider event has overtaken", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale);
      const pkg = await prepareDisputeEvidence(
        { disputeId: outcome.disputeId, at: DISPUTE_LATER },
        { db, ids: disputeIds },
      );
      await approveDisputeEvidence(
        { preparationId: pkg.preparationId, accountId: "acct-operator", at: DISPUTE_LATER },
        { db },
      );

      /* The SAME dispute moves underneath the approval — same provider dispute
         reference, a later provider instant. */
      const opened = await db.transactionDispute.findUniqueOrThrow({
        where: { id: outcome.disputeId },
        select: { providerDisputeRef: true },
      });
      await dispute(
        sale,
        {
          eventKind: "UPDATED",
          providerDisputeRef: opened.providerDisputeRef,
          providerEventId: `evt_${pad26(`${TAG}SUPER${next()}`)}`,
          occurredAt: "2028-09-14T09:00:00.000Z",
        },
        "2028-09-14T09:00:00.000Z",
      );

      await expect(
        submitDisputeEvidence(
          { preparationId: pkg.preparationId, at: "2028-09-15T09:00:00.000Z" },
          { db, env: {} },
        ),
      ).rejects.toMatchObject({ reason: "SUPERSEDED_BY_PROVIDER_EVENT" });

      const row = await db.disputeEvidencePreparation.findUniqueOrThrow({
        where: { id: pkg.preparationId },
      });
      expect(row.status).toBe("SUPERSEDED");
    });

    it("refuses to prepare once the deadline has passed", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale);
      await expect(
        prepareDisputeEvidence(
          { disputeId: outcome.disputeId, at: "2029-01-01T00:00:00.000Z" },
          { db, ids: disputeIds },
        ),
      ).rejects.toMatchObject({ reason: "DEADLINE_PASSED" });
    });

    it("refuses to prepare when the bank permits no response", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale, { responsePermitted: false, evidenceDueBy: null });
      await expect(
        prepareDisputeEvidence(
          { disputeId: outcome.disputeId, at: DISPUTE_LATER },
          { db, ids: disputeIds },
        ),
      ).rejects.toMatchObject({ reason: "RESPONSE_NOT_PERMITTED" });
    });

    it("returns the same preparation rather than opening a second answer", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale);
      const first = await prepareDisputeEvidence(
        { disputeId: outcome.disputeId, at: DISPUTE_LATER },
        { db, ids: disputeIds },
      );
      const second = await prepareDisputeEvidence(
        { disputeId: outcome.disputeId, at: DISPUTE_LATER },
        { db, ids: disputeIds },
      );
      expect(second.preparationId).toBe(first.preparationId);
      expect(
        await db.disputeEvidencePreparation.count({ where: { disputeId: outcome.disputeId } }),
      ).toBe(1);
    });

    it("asks the seller for evidence, and records the obligation", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale);
      const requested = await requestSellerDisputeEvidence(
        { disputeId: outcome.disputeId, requestId: "req-1", at: DISPUTE_LATER },
        { db, notificationIds },
      );
      expect(requested.obligationId).not.toBeNull();

      const delivery = await db.outboundEmailDelivery.findFirst({
        where: {
          subjectKind: "ORDER",
          subjectRef: sale.orderId,
          purpose: "DISPUTE_EVIDENCE_REQUESTED",
        },
      });
      expect(delivery).not.toBeNull();
      expect(delivery?.audience).toBe("SELLER");
    });

    it("writes no provider-owned dispute state when a response is prepared", async () => {
      const sale = await paidSale();
      const outcome = await dispute(sale);
      const before = await db.transactionDispute.findUniqueOrThrow({
        where: { id: outcome.disputeId },
      });
      await prepareDisputeEvidence(
        { disputeId: outcome.disputeId, at: DISPUTE_LATER },
        { db, ids: disputeIds },
      );
      const after = await db.transactionDispute.findUniqueOrThrow({
        where: { id: outcome.disputeId },
      });
      /* The webhook remains the only writer of every one of these. */
      expect(after.status).toBe(before.status);
      expect(after.fundsState).toBe(before.fundsState);
      expect(after.evidenceSubmissionCount).toBe(before.evidenceSubmissionCount);
      expect(after.evidenceStagedAtProvider).toBe(before.evidenceStagedAtProvider);
      expect(after.lastProviderEventAt.toISOString()).toBe(before.lastProviderEventAt.toISOString());
    });

    it("leaks no buyer detail through the evidence package", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      const outcome = await dispute(sale);
      const pkg = await prepareDisputeEvidence(
        { disputeId: outcome.disputeId, at: DISPUTE_LATER },
        { db, ids: disputeIds },
      );
      const serialised = JSON.stringify(pkg);
      expect(serialised).not.toContain("Synthetic Buyer");
      expect(serialised).not.toContain("example.test");
    });

    it("stores no evidence value, only pointers and bounded claims", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      const outcome = await dispute(sale);
      await prepareDisputeEvidence(
        { disputeId: outcome.disputeId, at: DISPUTE_LATER },
        { db, ids: disputeIds },
      );
      const items = await db.disputeEvidenceItem.findMany({
        where: { disputeId: outcome.disputeId },
      });
      expect(items.length).toBeGreaterThan(0);
      const serialised = JSON.stringify(items);
      expect(serialised).not.toContain("Synthetic Buyer");
      expect(serialised).not.toContain("example.test");
      for (const item of items) {
        /* Either a citation or a bounded claim — never both, and never neither.
           Asserted as a strict exclusive-or: an item carrying BOTH a source
           reference and an attestation would be a stored claim sitting beside the
           record it purports to describe, which is exactly the second-answer
           problem 1.11 refused an evidence table over. */
        const cited = item.sourceRef !== null && item.sourceRef !== "";
        const claimed = item.attestationClaim !== null;
        expect(cited, `${item.id} carries neither a citation nor a claim`).toBe(!claimed);
      }
    });
  });


  // — 13 · The governed seller chargeback fee (Phase 1.12) —

  describe("the seller fee for a finalized lost chargeback", () => {
    /** Record and activate a fee version. The governed admin path, not a raw write. */
    async function activateFee(version: string, amountMinorUnits: number, currency = "USD") {
      await recordChargebackFeePolicyVersion(
        {
          policyVersion: version,
          amountMinorUnits,
          currency,
          effectiveFrom: DISPUTE_AT,
          recordedByAccountId: "acct-admin",
          at: DISPUTE_AT,
        },
        { db },
      );
      return activateChargebackFeePolicyVersion(
        { policyVersion: version, activatedByAccountId: "acct-admin", at: DISPUTE_AT },
        { db },
      );
    }

    async function clearFeePolicy() {
      await db.sellerChargebackFee.deleteMany({});
      await db.sellerChargebackFeePolicyVersionRow.deleteMany({});
      await db.sellerChargebackFeePolicy.deleteMany({});
    }

    beforeEach(async () => {
      await clearFeePolicy();
    });

    it("resolves the bootstrapped default to $30 USD", async () => {
      await activateFee(
        SELLER_CHARGEBACK_FEE_BOOTSTRAP_DEFAULT.policyVersion,
        SELLER_CHARGEBACK_FEE_BOOTSTRAP_DEFAULT.amountMinorUnits,
      );
      const active = await resolveActiveChargebackFeePolicy({ db });
      expect(active?.amountMinorUnits).toBe(3_000);
      expect(active?.currency).toBe("USD");
      expect(active?.policyVersion).toBe("1.0.0");
    });

    it("assesses the governed amount when a dispute is finally lost", async () => {
      await activateFee("1.0.0", 3_000);
      const sale = await paidSale();
      const outcome = await dispute(sale, { eventKind: "CLOSED", status: "LOST" });

      const fee = await db.sellerChargebackFee.findUniqueOrThrow({
        where: { disputeId: outcome.disputeId },
      });
      expect(Number(fee.amountMinorUnits)).toBe(3_000);
      expect(fee.currency).toBe("USD");
      expect(fee.state).toBe("ASSESSED");
      expect(fee.policyVersion).toBe("1.0.0");
      expect(fee.sellerParticipantId).toBe(sale.seller.participantId);
      expect(outcome.chargebackFeeId).toBe(fee.id);
    });

    it("lets an admin create and activate a new value prospectively", async () => {
      await activateFee("1.0.0", 3_000);
      const next = await activateFee("1.1.0", 4_500);
      expect(next.status).toBe("ACTIVE");
      expect(next.amountMinorUnits).toBe(4_500);

      const active = await resolveActiveChargebackFeePolicy({ db });
      expect(active?.policyVersion).toBe("1.1.0");

      /* The superseded version is retired, still readable, and its amount is
         untouched. */
      const versions = await readChargebackFeePolicyVersions({ db });
      const retired = versions.find((v) => v.policyVersion === "1.0.0");
      expect(retired?.status).toBe("RETIRED");
      expect(retired?.amountMinorUnits).toBe(3_000);
    });

    it("leaves a fee assessed under the old value exactly as it was", async () => {
      /* The immutability property the whole correction turns on. */
      await activateFee("1.0.0", 3_000);
      const sale = await paidSale();
      const outcome = await dispute(sale, { eventKind: "CLOSED", status: "LOST" });

      await activateFee("1.1.0", 9_900);

      const fee = await db.sellerChargebackFee.findUniqueOrThrow({
        where: { disputeId: outcome.disputeId },
      });
      expect(Number(fee.amountMinorUnits)).toBe(3_000);
      expect(fee.policyVersion).toBe("1.0.0");
    });

    it("assesses a later loss at the new value", async () => {
      await activateFee("1.0.0", 3_000);
      const first = await paidSale();
      const firstOutcome = await dispute(first, { eventKind: "CLOSED", status: "LOST" });

      await activateFee("1.1.0", 4_500);
      const second = await paidSale();
      const secondOutcome = await dispute(second, { eventKind: "CLOSED", status: "LOST" });

      const older = await db.sellerChargebackFee.findUniqueOrThrow({
        where: { disputeId: firstOutcome.disputeId },
      });
      const newer = await db.sellerChargebackFee.findUniqueOrThrow({
        where: { disputeId: secondOutcome.disputeId },
      });
      expect(Number(older.amountMinorUnits)).toBe(3_000);
      expect(older.policyVersion).toBe("1.0.0");
      expect(Number(newer.amountMinorUnits)).toBe(4_500);
      expect(newer.policyVersion).toBe("1.1.0");
    });

    it("fails closed when no fee policy is active, rather than defaulting", async () => {
      /* No compiled $30 anywhere. A deployment that never activated a fee charges
         nothing and says so. */
      const sale = await paidSale();
      const outcome = await dispute(sale, { eventKind: "CLOSED", status: "LOST" });
      expect(outcome.chargebackFeeId).toBeNull();
      expect(await db.sellerChargebackFee.count({ where: { orderId: sale.orderId } })).toBe(0);

      const readiness = await evaluateDisputeOperationsReadiness({ at: DISPUTE_LATER }, { db });
      expect(readiness.blockers).toContain("DISPUTE_CHARGEBACK_FEE_NOT_ASSESSED");
      expect(readiness.healthy).toBe(false);
    });

    it("assesses no fee when the dispute is merely opened", async () => {
      await activateFee("1.0.0", 3_000);
      const sale = await paidSale();
      const outcome = await dispute(sale);
      expect(outcome.chargebackFeeId).toBeNull();
      expect(await db.sellerChargebackFee.count({ where: { orderId: sale.orderId } })).toBe(0);
    });

    it("assesses no fee when the dispute is won", async () => {
      /* A seller who successfully defends a sale must be no worse off for having
         been disputed, or the fee becomes a tax on being a target. */
      await activateFee("1.0.0", 3_000);
      const sale = await paidSale();
      const outcome = await dispute(sale, { eventKind: "CLOSED", status: "WON" });
      expect(outcome.chargebackFeeId).toBeNull();
      expect(await db.sellerChargebackFee.count({ where: { orderId: sale.orderId } })).toBe(0);
    });

    it("assesses exactly one fee however often the loss is redelivered", async () => {
      await activateFee("1.0.0", 3_000);
      const sale = await paidSale();
      const first = await dispute(sale, { eventKind: "CLOSED", status: "LOST" });
      const opened = await db.transactionDispute.findUniqueOrThrow({
        where: { id: first.disputeId },
        select: { providerDisputeRef: true },
      });
      await dispute(sale, {
        eventKind: "CLOSED",
        status: "LOST",
        providerDisputeRef: opened.providerDisputeRef,
        providerEventId: `evt_${pad26(`${TAG}REDEL${next()}`)}`,
      });
      expect(await db.sellerChargebackFee.count({ where: { orderId: sale.orderId } })).toBe(1);
    });

    it("refuses to redefine a version label with a different amount", async () => {
      await activateFee("1.0.0", 3_000);
      await expect(
        recordChargebackFeePolicyVersion(
          {
            policyVersion: "1.0.0",
            amountMinorUnits: 9_999,
            currency: "USD",
            effectiveFrom: DISPUTE_AT,
            recordedByAccountId: "acct-admin",
            at: DISPUTE_AT,
          },
          { db },
        ),
      ).rejects.toMatchObject({ reason: "FEE_VERSION_ALREADY_EXISTS_WITH_DIFFERENT_VALUE" });
    });

    it("permits at most one active version, enforced by the database", async () => {
      await activateFee("1.0.0", 3_000);
      await activateFee("1.1.0", 4_500);
      const active = await db.sellerChargebackFeePolicyVersionRow.count({
        where: { status: "ACTIVE" },
      });
      expect(active).toBe(1);
    });

    it("rewrites no historical economics to make room for the fee", async () => {
      await activateFee("1.0.0", 3_000);
      const sale = await paidSale();
      const before = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { id: sale.snapshotId },
      });
      const beforeObligations = await db.proceedsObligation.findMany({
        where: { snapshotId: sale.snapshotId },
        orderBy: { id: "asc" },
      });

      await dispute(sale, { eventKind: "CLOSED", status: "LOST" });

      const after = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { id: sale.snapshotId },
      });
      const afterObligations = await db.proceedsObligation.findMany({
        where: { snapshotId: sale.snapshotId },
        orderBy: { id: "asc" },
      });

      /* Not one figure moves. The fee stands beside the sale, never inside it. */
      expect(after.commercialRetailAmountMinorUnits).toEqual(
        before.commercialRetailAmountMinorUnits,
      );
      expect(after.sellerProceedsMinorUnits).toEqual(before.sellerProceedsMinorUnits);
      expect(after.monacadoRetainedAmountMinorUnits).toEqual(
        before.monacadoRetainedAmountMinorUnits,
      );
      expect(afterObligations.map((o) => o.amountMinorUnits)).toEqual(
        beforeObligations.map((o) => o.amountMinorUnits),
      );
    });

    it("carries no buyer detail", async () => {
      await activateFee("1.0.0", 3_000);
      const sale = await paidSale();
      await dispute(sale, { eventKind: "CLOSED", status: "LOST" });
      const fees = await db.sellerChargebackFee.findMany({ where: { orderId: sale.orderId } });
      const serialised = JSON.stringify(fees, (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      );
      expect(serialised).not.toContain("Synthetic Buyer");
      expect(serialised).not.toContain("example.test");
    });
  });
});
