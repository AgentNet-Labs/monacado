/**
 * Refund and tax-reversal integration tests (Phase 1.9).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * **NO NETWORK, NO STRIPE ACCOUNT, NO CREDENTIAL, NO LIVE MONEY, NO AGENTNET
 * PUBLICATION.** Every provider port — payment initiation, tax calculation, tax
 * recording, refund execution, tax reversal — is an injected double.
 *
 * What only a database can show:
 *
 *   - a full refund of a PAID Order returns the buyer's exact charge and commits
 *     the `1.2` accounting entry, the settlement reversal, the tax-reversal
 *     obligation, and any recovery exceptions **in one transaction**;
 *   - a payment refund that fails produces **no** tax reversal at all;
 *   - a payment refund that succeeds while the tax reversal fails leaves a
 *     recoverable mismatch that a later cycle closes;
 *   - the economic snapshot and the `1.7` tax transaction's sale-time facts are
 *     **byte-identical** afterwards;
 *   - unpaid proceeds become payout-ineligible, and already-paid ones raise a
 *     recovery exception rather than being rewritten;
 *   - a zero-tax sale follows the identical tax-reversal lifecycle.
 *
 * **Test isolation.** Every identifier carries the `P19T` opaque prefix and every
 * account address the `refund-` local part. No `deleteMany({})` appears.
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
import {
  DEFAULT_REFUND_CAPSULE_SEMVER,
  NEVER_IN_REFUND_CAPSULE,
  REFUND_MAPPING_VERSION,
  projectRefundCapsule,
} from "../src/contracts/marketplace/refund.capsule";
import {
  DEFAULT_TAX_REVERSAL_CAPSULE_SEMVER,
  NEVER_IN_TAX_REVERSAL_CAPSULE,
  TAX_REVERSAL_MAPPING_VERSION,
  projectTaxReversalCapsule,
} from "../src/contracts/marketplace/tax-reversal.capsule";
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

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const TAG = "P19T";
const PRODUCT_TAG = "P19TPR0D";
const PRODUCT_PREFIX = `mon:product:${PRODUCT_TAG}`;
const ACCOUNT_EMAIL_PREFIX = "refund-";
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
  nextLockToken: () => `p19lock${next()}`.padEnd(32, "0"),
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
  nextLockToken: () => `p19txlock${next()}`.padEnd(32, "0"),
};

const BUYER_DETAILS = {
  name: "Synthetic Buyer",
  email: "p19t-buyer@example.test",
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
  configVersion: "refund-map/1",
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
      publicHandle: `p19t-shop-${n}`,
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

const describeDb = RUN ? describe : describe.skip;

describeDb("1.9 — refunds and tax reversals", () => {
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
    over: {
      taxMinorUnits?: number;
      retail?: number;
      shipping?: number;
      refundPolicy?: Parameters<typeof seedSellerDirect>[1];
    } = {},
  ) {
    const taxMinorUnits = over.taxMinorUnits ?? 875;
    const retail = over.retail ?? 10_000;
    const shipping = over.shipping ?? 0;
    const seller = await seedSellerDirect(retail, over.refundPolicy ?? {});
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
    const guestClaimCode = begun.guestClaimCode;
    return {
      seller,
      orderId: begun.order.orderId,
      paymentRef: confirmation.providerTransactionRef,
      taxMinorUnits,
      retail,
      shipping,
      guestClaimCode,
    };
  }

  /** Take the sale's tax all the way to RECORDED, with no network. */
  async function recordTax(sale: {
    retail: number;
    taxMinorUnits: number;
    shipping?: number;
  }): Promise<void> {
    const outcome = await runTaxTransactionRecordingCycle(
      { at: RECORDED_AT, limit: 10 },
      {
        db,
        ids: taxTransactionIds,
        /* The provider's represented total must reconcile to basis + tax, and the
           basis is retail PLUS shipping. */
        port: recordingPortDouble(sale.retail + (sale.shipping ?? 0), sale.taxMinorUnits),
      },
    );
    expect(outcome.recorded).toBeGreaterThan(0);
  }

  async function refundedSale(over: Parameters<typeof paidSale>[0] = {}) {
    const sale = await paidSale(over);
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
    return sale;
  }

  // — 1 · A full refund of a PAID Order —

  describe("a full refund of a PAID Order", () => {
    it("returns the buyer's exact charge, from the Order's own quote", async () => {
      const sale = await paidSale();
      await recordTax(sale);

      const eligibility = await evaluateRefundEligibility(
        { orderId: sale.orderId, at: REFUND_AT },
        { db },
      );
      expect(eligibility).toMatchObject({
        eligible: true,
        refusals: [],
        /* retail + tax. Summed from the QUOTE, not recomputed from policy. */
        refundableAmountMinorUnits: 10_875,
        currency: "USD",
        provider: "STRIPE",
        providerTransactionRef: sale.paymentRef,
      });

      const refund = await requestOrderRefund(
        {
          orderId: sale.orderId,
          reasonCode: "CUSTOMER_REQUEST",
          requestorKind: "OPERATOR",
          requestedByAccountId: null,
          requestedAt: REFUND_AT,
        },
        refundDeps(),
      );
      expect(refund).toMatchObject({
        orderId: sale.orderId,
        scope: "LINE_SET",
        coversWholeOrder: true,
        lineRefs: [`${sale.orderId}#L1`],
        reasonCode: "CUSTOMER_REQUEST",
        provider: "STRIPE",
        providerMode: "TEST",
        providerTransactionRef: sale.paymentRef,
        currency: "USD",
        amountMinorUnits: 10_875,
        status: "PENDING",
        attemptCount: 0,
        providerRefundRef: null,
        reversalId: null,
      });
    });

    it("completes BOTH halves in one cycle, and names the exact original charge", async () => {
      const sale = await refundedSale();
      const refundPort = refundPortDouble();
      const taxPort = taxReversalPortDouble();

      const outcome = await runRefundCycle(
        { at: LATER, limit: 10 },
        { ...refundDeps(), refundPort, taxReversalPort: taxPort },
      );
      expect(outcome).toMatchObject({
        refundsClaimed: 1,
        refundsExecuted: 1,
        taxReversalsClaimed: 1,
        taxReversalsExecuted: 1,
      });

      /* The refund named the EXACT payment intent recorded on the settlement
         row, and the full amount. */
      expect(refundPort.calls).toHaveLength(1);
      expect(refundPort.calls[0]).toMatchObject({
        providerTransactionRef: sale.paymentRef,
        amountMinorUnits: 10_875,
        currency: "USD",
      });

      const refund = await getRefundForOrder(sale.orderId, { db });
      expect(refund).toMatchObject({ status: "REFUNDED", attemptCount: 1 });
      expect(refund!.providerRefundRef).not.toBeNull();
      expect(refund!.reversalId).not.toBeNull();

      expect(await getRefundLifecycleState(sale.orderId, { db })).toBe("COMPLETED");
    });

    it("commits the 1.2 accounting entry and reverses the settlement, together", async () => {
      const sale = await refundedSale();
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
        },
      );

      const snapshot = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { orderId: sale.orderId },
      });
      const reversal = await db.transactionReversal.findUniqueOrThrow({
        where: { snapshotId: snapshot.id },
      });
      expect(reversal).toMatchObject({ kind: "REFUND", scope: "FULL" });
      /* Derived from the snapshot, not supplied: everyone gives back exactly
         what they received. */
      expect(Number(reversal.reversedCommercialRetailAmountMinorUnits)).toBe(10_000);
      expect(Number(reversal.reversedTaxAmountMinorUnits)).toBe(875);
      expect(
        Number(reversal.reversedSellerProceedsMinorUnits) +
          Number(reversal.reversedMonacadoRetainedAmountMinorUnits),
      ).toBe(10_000);

      const settlement = await db.transactionSettlement.findUniqueOrThrow({
        where: { snapshotId: snapshot.id },
      });
      expect(settlement.state).toBe("REVERSED");
    });
  });

  // — 2 · Refusals, before any provider is contacted —

  describe("refusals happen before any provider is contacted", () => {
    it("refuses an Order that never completed", async () => {
      const seller = await seedSellerDirect();
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const begun = await beginCheckout(
        CHECKOUT_INPUT(seller.internalListingId),
        policyId,
        {
          provider: "STRIPE",
          port: initiationDouble(),
          taxPort: createStripeTaxAdapter({ config: TAX_CONFIG, client: taxClientDouble() }),
          riskPolicyId,
          buyerDetails: BUYER_DETAILS,
        },
        { ...deps(), taxIds, buyerSnapshotIds },
      );

      const eligibility = await evaluateRefundEligibility(
        { orderId: begun.order.orderId, at: REFUND_AT },
        { db },
      );
      expect(eligibility.eligible).toBe(false);
      expect(eligibility.refusals).toContain("ORDER_NOT_PAID");
      expect(eligibility.refusals).toContain("ECONOMIC_SNAPSHOT_MISSING");
      /* Every refusal, not the first. */
      expect(eligibility.refusals.length).toBeGreaterThan(1);

      await expect(
        requestOrderRefund(
          {
            orderId: begun.order.orderId,
            reasonCode: "CUSTOMER_REQUEST",
            requestorKind: "OPERATOR",
            requestedByAccountId: null,
            requestedAt: REFUND_AT,
          },
          refundDeps(),
        ),
      ).rejects.toBeInstanceOf(RefundRefusedError);
      expect(await db.orderRefund.count({ where: { orderId: begun.order.orderId } })).toBe(0);
    });

    it("refuses a cancelled Order", async () => {
      const seller = await seedSellerDirect();
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const begun = await beginCheckout(
        CHECKOUT_INPUT(seller.internalListingId),
        policyId,
        {
          provider: "STRIPE",
          port: initiationDouble(),
          taxPort: createStripeTaxAdapter({ config: TAX_CONFIG, client: taxClientDouble() }),
          riskPolicyId,
          buyerDetails: BUYER_DETAILS,
        },
        { ...deps(), taxIds, buyerSnapshotIds },
      );
      await cancelOrder({ orderId: begun.order.orderId, at: LATER }, deps());

      const eligibility = await evaluateRefundEligibility(
        { orderId: begun.order.orderId, at: REFUND_AT },
        { db },
      );
      expect(eligibility.refusals).toContain("ORDER_NOT_PAID");
    });

    it("refuses an arbitrary PER-LINE amount, writing nothing and calling nobody", async () => {
      const sale = await paidSale();
      await recordTax(sale);

      const eligibility = await evaluateRefundEligibility(
        { orderId: sale.orderId, at: REFUND_AT, requestedAmountMinorUnits: 5_000 },
        { db },
      );
      expect(eligibility.eligible).toBe(false);
      /* The refusal names the case that is actually unsupported: splitting ONE
         line. Selecting a subset of lines is permitted by policy. */
      expect(eligibility.refusals).toEqual(["PARTIAL_LINE_REFUND_NOT_SUPPORTED"]);

      await expect(
        requestOrderRefund(
          {
            orderId: sale.orderId,
            reasonCode: "CUSTOMER_REQUEST",
            requestorKind: "OPERATOR",
            requestedByAccountId: null,
            requestedAt: REFUND_AT,
            requestedAmountMinorUnits: 5_000,
          },
          refundDeps(),
        ),
      ).rejects.toMatchObject({ refusals: ["PARTIAL_LINE_REFUND_NOT_SUPPORTED"] });

      /* NO ROW, and therefore nothing a worker could ever pick up and execute. */
      expect(await db.orderRefund.count({ where: { orderId: sale.orderId } })).toBe(0);
      expect(await db.orderRefundLine.count()).toBe(0);
      expect(await db.transactionReversal.count({ where: { orderId: sale.orderId } })).toBe(0);
    });

    it("refuses a line that is not on the Order", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      const eligibility = await evaluateRefundEligibility(
        { orderId: sale.orderId, at: REFUND_AT, selectedLineRefs: [`${sale.orderId}#L9`] },
        { db },
      );
      expect(eligibility.refusals).toContain("REFUND_LINE_NOT_FOUND");
      expect(eligibility.eligible).toBe(false);
    });

    it("accepts a request that names exactly the buyer's full charge", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      const refund = await requestOrderRefund(
        {
          orderId: sale.orderId,
          reasonCode: "PRODUCT_FAILURE",
          requestorKind: "SYSTEM",
          requestedByAccountId: null,
          requestedAt: REFUND_AT,
          requestedAmountMinorUnits: 10_875,
        },
        refundDeps(),
      );
      expect(refund.status).toBe("PENDING");
    });

    it("refuses a SECOND refund of one Order rather than treating it as idempotent", async () => {
      const sale = await refundedSale();
      await expect(
        requestOrderRefund(
          {
            orderId: sale.orderId,
            reasonCode: "CUSTOMER_REQUEST",
            requestorKind: "OPERATOR",
            requestedByAccountId: null,
            requestedAt: LATER,
          },
          refundDeps(),
        ),
      ).rejects.toBeInstanceOf(RefundAlreadyExistsError);
      expect(await db.orderRefund.count({ where: { orderId: sale.orderId } })).toBe(1);
    });
  });

  // — 3 · Idempotency across retries —

  describe("a replayed cycle is idempotent", () => {
    it("does not refund a second time, and reuses the same idempotency key", async () => {
      const sale = await refundedSale();
      const refundPort = refundPortDouble();
      const taxPort = taxReversalPortDouble();
      const cycleDeps = { ...refundDeps(), refundPort, taxReversalPort: taxPort };

      await runRefundCycle({ at: LATER, limit: 10 }, cycleDeps);
      const afterFirst = await getRefundForOrder(sale.orderId, { db });

      /* A second cycle claims nothing: the row is terminal. */
      const second = await runRefundCycle({ at: LATER, limit: 10 }, cycleDeps);
      expect(second.refundsClaimed).toBe(0);
      expect(second.taxReversalsClaimed).toBe(0);
      expect(refundPort.calls).toHaveLength(1);
      expect(taxPort.calls).toHaveLength(1);

      const afterSecond = await getRefundForOrder(sale.orderId, { db });
      expect(afterSecond).toEqual(afterFirst);
      expect(await db.transactionReversal.count({ where: { orderId: sale.orderId } })).toBe(1);
    });

    it("sends an identical idempotency key on a retry after a transient failure", async () => {
      const sale = await refundedSale();
      const refundPort = refundPortDouble([
        { outcome: "REFUSED", failureCode: "PROVIDER_UNAVAILABLE" },
      ]);
      const cycleDeps = {
        ...refundDeps(),
        refundPort,
        taxReversalPort: forbiddenTaxReversalPort(),
      };

      await runRefundCycle({ at: LATER, limit: 10 }, cycleDeps);
      const retrying = await getRefundForOrder(sale.orderId, { db });
      expect(retrying).toMatchObject({
        status: "RETRY_PENDING",
        attemptCount: 1,
        lastFailureCode: "PROVIDER_UNAVAILABLE",
        lastFailureClass: "TRANSIENT",
      });

      /* Due again after the backoff. */
      await runRefundCycle(
        { at: retrying!.nextAttemptAt!, limit: 10 },
        { ...refundDeps(), refundPort, taxReversalPort: taxReversalPortDouble() },
      );

      expect(refundPort.calls).toHaveLength(2);
      /* THE PROPERTY THAT PREVENTS A DOUBLE REFUND: the same key, both times. */
      expect(refundPort.calls[0]!.idempotencyKey).toBe(refundPort.calls[1]!.idempotencyKey);
      expect(await getRefundForOrder(sale.orderId, { db })).toMatchObject({
        status: "REFUNDED",
        attemptCount: 2,
      });
    });
  });

  // — 4 · Ordering and partial provider failure —

  describe("ordering and partial provider failure", () => {
    it("creates NO tax reversal when the payment refund fails", async () => {
      const sale = await refundedSale();
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble([
            { outcome: "REFUSED", failureCode: "PROVIDER_UNAVAILABLE" },
          ]),
          /* Would throw if reached. §9: a failed payment refund must never
             produce a tax reversal. */
          taxReversalPort: forbiddenTaxReversalPort(),
        },
      );

      expect(await getTaxReversalForOrder(sale.orderId, { db })).toBeNull();
      expect(await db.transactionReversal.count({ where: { orderId: sale.orderId } })).toBe(0);
      expect(await getRefundLifecycleState(sale.orderId, { db })).toBe("REFUND_RETRY_PENDING");
    });

    it("becomes durably terminal on a permanent payment failure", async () => {
      const sale = await refundedSale();
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble([
            { outcome: "REFUSED", failureCode: "ALREADY_REVERSED" },
          ]),
          taxReversalPort: forbiddenTaxReversalPort(),
        },
      );

      const refund = await getRefundForOrder(sale.orderId, { db });
      expect(refund).toMatchObject({
        status: "FAILED_PERMANENT",
        lastFailureCode: "ALREADY_REFUNDED",
        lastFailureClass: "PERMANENT",
        nextAttemptAt: null,
      });
      expect(refund!.finalizedAt).not.toBeNull();
      expect(await getRefundLifecycleState(sale.orderId, { db })).toBe(
        "REFUND_FAILED_PERMANENT",
      );

      /* And the provider already holds a refund Monacado never saw, so a requeue
         is refused by name rather than retried into the same wall. */
      const stuck = await inspectStuckRefundWork({ at: LATER, limit: 10 }, { db });
      const row = stuck.find((r) => r.orderId === sale.orderId);
      expect(row).toMatchObject({
        kind: "PAYMENT_REFUND",
        action: "RECONCILE_PROVIDER_REFUND",
        requeueable: false,
      });
      await expect(
        requeueRefundWork({ kind: "PAYMENT_REFUND", id: refund!.refundId, at: LATER }, { db }),
      ).rejects.toMatchObject({ reason: "FAILURE_NOT_REQUEUEABLE" });
    });

    it("preserves a refunded payment whose tax reversal failed, and recovers forward", async () => {
      const sale = await refundedSale();

      /* The money goes back; the tax provider times out. */
      const first = await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble([
            { outcome: "FAILED", failureCode: "PROVIDER_UNAVAILABLE" },
          ]),
        },
      );
      expect(first).toMatchObject({ refundsExecuted: 1, taxReversalsExecuted: 0 });

      /* THE REFUND IS NOT ROLLED BACK OR HIDDEN. */
      expect(await getRefundForOrder(sale.orderId, { db })).toMatchObject({
        status: "REFUNDED",
      });
      expect(await db.transactionReversal.count({ where: { orderId: sale.orderId } })).toBe(1);

      const reversal = await getTaxReversalForOrder(sale.orderId, { db });
      expect(reversal).toMatchObject({
        status: "RETRY_PENDING",
        lastFailureCode: "PROVIDER_UNAVAILABLE",
      });
      expect(await getRefundLifecycleState(sale.orderId, { db })).toBe("TAX_REVERSAL_PENDING");

      /* Reconciliation names the mismatch from local rows alone. */
      const mismatch = await reconcileOrderRefund(sale.orderId, LATER, { db });
      expect(mismatch!.findings).toContain("PAYMENT_REFUNDED_TAX_NOT_REVERSED");
      expect(mismatch!.consistent).toBe(false);

      /* And a later cycle closes it — recovering FORWARD. */
      const taxPort = taxReversalPortDouble();
      await runRefundCycle(
        { at: reversal!.nextAttemptAt!, limit: 10 },
        { ...refundDeps(), refundPort: refundPortDouble(), taxReversalPort: taxPort },
      );

      expect(await getTaxReversalForOrder(sale.orderId, { db })).toMatchObject({
        status: "REVERSED",
        attemptCount: 2,
      });
      expect(await getRefundLifecycleState(sale.orderId, { db })).toBe("COMPLETED");

      const settled = await reconcileOrderRefund(sale.orderId, LATER, { db });
      expect(settled!.findings).toEqual(["CONSISTENT"]);
      expect(settled!.consistent).toBe(true);
    });

    it("surfaces MANUAL_REMEDIATION_REQUIRED when a tax reversal is permanently lost", async () => {
      const sale = await refundedSale();
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble([
            { outcome: "FAILED", failureCode: "ORIGINAL_TRANSACTION_NOT_FOUND" },
          ]),
        },
      );

      expect(await getRefundLifecycleState(sale.orderId, { db })).toBe(
        "MANUAL_REMEDIATION_REQUIRED",
      );
      const readiness = await evaluateRefundOperationsReadiness(LATER, { db });
      expect(readiness.healthy).toBe(false);
      expect(readiness.blockers).toContain("REFUND_MANUAL_REMEDIATION_REQUIRED");

      /* No retry can help. The operator is sent to an adjustment, not a timer. */
      const stuck = await inspectStuckRefundWork({ at: LATER, limit: 10 }, { db });
      expect(stuck.find((r) => r.kind === "TAX_REVERSAL")).toMatchObject({
        action: "OPERATOR_TAX_ADJUSTMENT_REQUIRED",
        requeueable: false,
      });
    });
  });

  // — 5 · The tax reversal names the exact original transaction —

  describe("the tax reversal targets the recorded transaction", () => {
    it("uses the exact 1.7 provider Tax Transaction reference, never a calculation", async () => {
      const sale = await refundedSale();
      const original = await getTaxTransactionForOrder(sale.orderId, { db });
      expect(original!.providerTaxTransactionRef).not.toBeNull();

      const taxPort = taxReversalPortDouble();
      await runRefundCycle(
        { at: LATER, limit: 10 },
        { ...refundDeps(), refundPort: refundPortDouble(), taxReversalPort: taxPort },
      );

      expect(taxPort.calls).toHaveLength(1);
      expect(taxPort.calls[0]!.originalProviderTaxTransactionRef).toBe(
        original!.providerTaxTransactionRef,
      );
      /* Never the calculation the transaction was created FROM. */
      expect(taxPort.calls[0]!.originalProviderTaxTransactionRef).not.toBe(
        original!.providerCalculationRef,
      );
      /* And a reference distinct from the original transaction's own. */
      expect(taxPort.calls[0]!.providerReference).toBe(
        taxReversalProviderReference(sale.orderId),
      );
      expect(taxPort.calls[0]!.providerReference).not.toBe(original!.providerReference);
    });

    it("copies the original's amounts rather than recalculating them", async () => {
      const sale = await refundedSale();
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
        },
      );
      const original = await getTaxTransactionForOrder(sale.orderId, { db });
      const reversal = await getTaxReversalForOrder(sale.orderId, { db });
      expect(reversal).toMatchObject({
        reversedTaxAmountMinorUnits: original!.taxAmountMinorUnits,
        reversedTaxableBasisMinorUnits: original!.taxableBasisMinorUnits,
        currency: original!.currency,
        provider: original!.provider,
        providerMode: original!.providerMode,
      });
    });
  });

  // — 6 · The original records are never rewritten —

  describe("the original sale is never rewritten", () => {
    it("leaves the economic snapshot byte-identical", async () => {
      const sale = await refundedSale();
      const before = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { orderId: sale.orderId },
      });

      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
        },
      );

      const after = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { orderId: sale.orderId },
      });
      expect(after).toEqual(before);
    });

    it("leaves the 1.7 tax transaction's sale-time facts unchanged", async () => {
      const sale = await refundedSale();
      const before = await getTaxTransactionForOrder(sale.orderId, { db });

      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
        },
      );

      const after = await getTaxTransactionForOrder(sale.orderId, { db });
      for (const field of IMMUTABLE_TAX_TRANSACTION_FIELDS) {
        expect(after![field]).toEqual(before![field]);
      }
      /* The ONE column a reversal moves, to the ONE value 1.7 reserved. */
      expect(before!.lifecycleState).toBe("RECORDED");
      expect(after!.lifecycleState).toBe("REVERSED");
      expect(after!.recordingStatus).toBe("RECORDED");
    });

    it("leaves the Order's own quote untouched", async () => {
      const sale = await refundedSale();
      const before = await db.order.findUniqueOrThrow({ where: { id: sale.orderId } });
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
        },
      );
      const after = await db.order.findUniqueOrThrow({ where: { id: sale.orderId } });
      expect(after.lifecycle).toBe("PAID");
      expect(after.quotedCommercialRetailAmountMinorUnits).toBe(
        before.quotedCommercialRetailAmountMinorUnits,
      );
      expect(after.quotedTaxAmountMinorUnits).toBe(before.quotedTaxAmountMinorUnits);
      /* A refund does not pretend the sale never happened. */
      expect(after.paidAt).toEqual(before.paidAt);
    });

    it("keeps the refund's own request-time facts across a retry", async () => {
      const sale = await refundedSale();
      const before = await getRefundForOrder(sale.orderId, { db });
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble([
            { outcome: "REFUSED", failureCode: "PROVIDER_UNAVAILABLE" },
          ]),
          taxReversalPort: forbiddenTaxReversalPort(),
        },
      );
      const after = await getRefundForOrder(sale.orderId, { db });
      expect(after).toMatchObject({
        orderId: before!.orderId,
        snapshotId: before!.snapshotId,
        amountMinorUnits: before!.amountMinorUnits,
        providerTransactionRef: before!.providerTransactionRef,
        reasonCode: before!.reasonCode,
        recordedAt: before!.recordedAt,
      });
    });
  });

  // — 7 · Proceeds consequences —

  describe("what a refund does to proceeds", () => {
    it("makes an unpaid claim ineligible for payout", async () => {
      const sale = await refundedSale();
      const snapshot = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { orderId: sale.orderId },
      });
      const obligation = await db.proceedsObligation.findFirstOrThrow({
        where: { snapshotId: snapshot.id },
      });
      expect(obligation.state).toBe("PENDING");

      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
        },
      );

      /* 1.2's payout hold, now actually reachable: paying out on a reversed sale
         is paying twice. */
      await expect(
        advanceProceedsObligation(
          { obligationId: obligation.id, to: "ELIGIBLE", at: LATER },
          deps(),
        ),
      ).rejects.toBeInstanceOf(ProceedsPayoutHeldError);

      /* And nothing was rewritten on it. */
      const after = await db.proceedsObligation.findUniqueOrThrow({
        where: { id: obligation.id },
      });
      expect(after.state).toBe("PENDING");
      expect(Number(after.amountMinorUnits)).toBe(Number(obligation.amountMinorUnits));

      /* A PENDING claim raises no exception: it can never be paid. */
      const refund = await getRefundForOrder(sale.orderId, { db });
      expect(
        await listProceedsRecoveryExceptionsForRefund(refund!.refundId, { db }),
      ).toHaveLength(0);
    });

    it("raises a recovery exception for an ALREADY-PAID claim rather than rewriting it", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      const snapshot = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { orderId: sale.orderId },
      });
      const obligation = await db.proceedsObligation.findFirstOrThrow({
        where: { snapshotId: snapshot.id },
      });

      /* Monacado settles the claim BEFORE the refund. */
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
          reasonCode: "PRODUCT_FAILURE",
          requestorKind: "OPERATOR",
          requestedByAccountId: null,
          requestedAt: REFUND_AT,
        },
        refundDeps(),
      );
      const outcome = await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
        },
      );
      expect(outcome.recoveryExceptionsRaised).toBe(1);

      const refund = await getRefundForOrder(sale.orderId, { db });
      const exceptions = await listProceedsRecoveryExceptionsForRefund(refund!.refundId, { db });
      expect(exceptions).toHaveLength(1);
      expect(exceptions[0]).toMatchObject({
        party: "SELLER",
        reasonCode: "PAID_BEFORE_REFUND",
        obligationStateAtRefund: "PAID",
        status: "OPEN",
        resolutionCode: null,
        /* COPIED from the obligation, never recomputed. */
        amountMinorUnits: Number(obligation.amountMinorUnits),
        currency: obligation.currency,
      });

      /* THE SETTLED CLAIM IS NOT REWRITTEN. A refund does not un-pay anybody. */
      const after = await db.proceedsObligation.findUniqueOrThrow({
        where: { id: obligation.id },
      });
      expect(after.state).toBe("PAID");
      expect(after.paidAt).not.toBeNull();
      expect(Number(after.amountMinorUnits)).toBe(Number(obligation.amountMinorUnits));

      /* And no negative obligation was fabricated. */
      expect(
        await db.proceedsObligation.count({
          where: { snapshotId: snapshot.id, amountMinorUnits: { lt: 0 } },
        }),
      ).toBe(0);
      expect(await db.proceedsObligation.count({ where: { snapshotId: snapshot.id } })).toBe(1);
    });

    it("raises an exception for a claim already ELIGIBLE, and reconciliation names it", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      const snapshot = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { orderId: sale.orderId },
      });
      const obligation = await db.proceedsObligation.findFirstOrThrow({
        where: { snapshotId: snapshot.id },
      });
      await advanceProceedsObligation(
        { obligationId: obligation.id, to: "ELIGIBLE", at: PAID_AT },
        deps(),
      );

      await requestOrderRefund(
        {
          orderId: sale.orderId,
          reasonCode: "OPERATOR_CORRECTION",
          requestorKind: "OPERATOR",
          requestedByAccountId: null,
          requestedAt: REFUND_AT,
        },
        refundDeps(),
      );
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
        },
      );

      const refund = await getRefundForOrder(sale.orderId, { db });
      const exceptions = await listProceedsRecoveryExceptionsForRefund(refund!.refundId, { db });
      expect(exceptions[0]).toMatchObject({ reasonCode: "ELIGIBLE_BEFORE_REFUND" });

      const reconciled = await reconcileOrderRefund(sale.orderId, LATER, { db });
      expect(reconciled!.findings).toContain("PROCEEDS_STILL_PAYOUT_ELIGIBLE");
      expect(reconciled!.needsOperator).toBe(true);
    });
  });

  // — 8 · Zero tax —

  describe("a zero-tax sale follows the identical lifecycle", () => {
    it("reverses the zero-tax Tax Transaction rather than skipping it", async () => {
      const sale = await refundedSale({ taxMinorUnits: 0 });
      const original = await getTaxTransactionForOrder(sale.orderId, { db });
      expect(original!.taxAmountMinorUnits).toBe(0);
      expect(original!.recordingStatus).toBe("RECORDED");

      const taxPort = taxReversalPortDouble();
      await runRefundCycle(
        { at: LATER, limit: 10 },
        { ...refundDeps(), refundPort: refundPortDouble(), taxReversalPort: taxPort },
      );

      /* THE PROVIDER IS CALLED. A jurisdiction where Monacado collected nothing
         and then refunded the sale is still a return line, and a reversal the
         provider never saw cannot appear on one. */
      expect(taxPort.calls).toHaveLength(1);
      expect(await getTaxReversalForOrder(sale.orderId, { db })).toMatchObject({
        status: "REVERSED",
        reversedTaxAmountMinorUnits: 0,
      });
      expect(await getRefundLifecycleState(sale.orderId, { db })).toBe("COMPLETED");
    });
  });

  // — 9 · Reconciliation —

  describe("reconciliation answers from local records alone", () => {
    it("distinguishes a paid Order with no refund from a completed one", async () => {
      const untouched = await paidSale();
      await recordTax(untouched);
      const before = await reconcileOrderRefund(untouched.orderId, LATER, { db });
      expect(before).toMatchObject({
        findings: ["PAID_ORDER_NO_REFUND"],
        consistent: true,
        needsOperator: false,
        refundId: null,
        lifecycleState: null,
      });
    });

    it("names a refund still in flight without calling it a defect", async () => {
      const sale = await refundedSale();
      const pending = await reconcileOrderRefund(sale.orderId, REFUND_AT, { db });
      expect(pending!.findings).toContain("REFUND_PENDING");
      expect(pending!.consistent).toBe(true);
      expect(pending!.needsOperator).toBe(false);
      expect(pending!.lifecycleState).toBe("PENDING");
    });

    it("names a permanently failed refund as needing an operator", async () => {
      const sale = await refundedSale();
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble([{ outcome: "REFUSED", failureCode: "CHARGE_NOT_FOUND" }]),
          taxReversalPort: forbiddenTaxReversalPort(),
        },
      );
      const result = await reconcileOrderRefund(sale.orderId, LATER, { db });
      expect(result!.findings).toContain("PAYMENT_REFUND_FAILED");
      expect(result!.needsOperator).toBe(true);
    });

    it("counts the backlog without naming a single buyer", async () => {
      const sale = await refundedSale();
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble([
            { outcome: "FAILED", failureCode: "PROVIDER_UNAVAILABLE" },
          ]),
        },
      );

      const backlog = await summarizeRefundBacklog(LATER, { db });
      expect(backlog.refundsCompleted).toBeGreaterThan(0);
      expect(backlog.paymentRefundedTaxNotReversed).toBe(1);

      /* Counts and ages only — no identifiers, and no amounts. */
      const serialized = JSON.stringify(backlog);
      expect(serialized).not.toContain(sale.orderId);
      expect(serialized).not.toContain(sale.paymentRef);
      expect(serialized).not.toContain(BUYER_DETAILS.email);
    });
  });

  // — 10 · Notifications —

  describe("notifications never control financial success", () => {
    it("commits buyer and seller notices after a refund completes", async () => {
      const sale = await refundedSale();
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
        },
      );

      const deliveries = await db.outboundEmailDelivery.findMany({
        where: { subjectKind: "ORDER", subjectRef: sale.orderId },
        select: { purpose: true, audience: true },
      });
      expect(deliveries.map((d) => d.purpose)).toContain("REFUND_COMPLETED");
      expect(deliveries.map((d) => d.purpose)).toContain("REFUND_RECORDED");

      const obligations = await db.notificationObligation.findMany({
        where: { subjectRef: sale.orderId, category: "REFUND_OR_CHARGEBACK" },
      });
      expect(obligations).toHaveLength(1);
      expect(obligations[0]!.recipientParticipantId).toBe(sale.seller.participantId);
    });

    it("does not create a second notice when a cycle is replayed", async () => {
      const sale = await refundedSale();
      const cycleDeps = {
        ...refundDeps(),
        refundPort: refundPortDouble(),
        taxReversalPort: taxReversalPortDouble(),
      };
      await runRefundCycle({ at: LATER, limit: 10 }, cycleDeps);
      await runRefundCycle({ at: LATER, limit: 10 }, cycleDeps);

      expect(
        await db.outboundEmailDelivery.count({
          where: { subjectRef: sale.orderId, purpose: "REFUND_COMPLETED" },
        }),
      ).toBe(1);
    });

    it("completes the refund even when notice enqueueing throws", async () => {
      const sale = await refundedSale();
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
          notices: {
            /* An id provider that refuses. Every notice write fails. */
            ids: {
              nextOutboundDeliveryId: () => {
                throw new Error("notice subsystem is down");
              },
              nextSuppressionId: () => {
                throw new Error("notice subsystem is down");
              },
              nextProviderEventId: () => {
                throw new Error("notice subsystem is down");
              },
              nextMessageDiscriminator: () => {
                throw new Error("notice subsystem is down");
              },
              nextLockToken: () => {
                throw new Error("notice subsystem is down");
              },
            },
          },
        },
      );

      /* THE MONEY WENT BACK REGARDLESS. Email is not part of financial
         integrity, and a buyer with no receipt is better off than a buyer with
         no refund. */
      expect(await getRefundForOrder(sale.orderId, { db })).toMatchObject({
        status: "REFUNDED",
      });
      expect(await db.transactionReversal.count({ where: { orderId: sale.orderId } })).toBe(1);
      expect(
        await db.outboundEmailDelivery.count({
          where: { subjectRef: sale.orderId, purpose: "REFUND_COMPLETED" },
        }),
      ).toBe(0);
    });
  });

  // — 11 · Private capsules —

  describe("private capsule projections", () => {
    it("project both records with no PII and nothing published", async () => {
      const sale = await refundedSale();
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
        },
      );

      const refund = await getRefundForOrder(sale.orderId, { db });
      const taxReversal = await getTaxReversalForOrder(sale.orderId, { db });

      const refundCapsule = projectRefundCapsule(refund, {
        generatedAt: LATER,
        capsuleSemver: DEFAULT_REFUND_CAPSULE_SEMVER,
        mappingVersion: REFUND_MAPPING_VERSION,
        lifecycleState: (await getRefundLifecycleState(sale.orderId, { db }))!,
        taxReversalRef: taxReversal!.taxReversalId,
      });
      const reversalCapsule = projectTaxReversalCapsule(taxReversal, {
        generatedAt: LATER,
        capsuleSemver: DEFAULT_TAX_REVERSAL_CAPSULE_SEMVER,
        mappingVersion: TAX_REVERSAL_MAPPING_VERSION,
      });

      expect(refundCapsule.visibility).toBe("PRIVATE");
      expect(reversalCapsule.visibility).toBe("PRIVATE");
      expect(refundCapsule.data.lifecycleState).toBe("COMPLETED");

      const serialized = JSON.stringify([refundCapsule, reversalCapsule]);
      for (const field of [...NEVER_IN_REFUND_CAPSULE, ...NEVER_IN_TAX_REVERSAL_CAPSULE]) {
        expect(serialized).not.toContain(field);
      }
      /* Real buyer values, from a real persisted sale. */
      expect(serialized).not.toContain(BUYER_DETAILS.email);
      expect(serialized).not.toContain(BUYER_DETAILS.name);
      expect(serialized).not.toContain(BUYER_DETAILS.shippingAddress.line1);
      expect(serialized).not.toContain(BUYER_DETAILS.billingAddress.postalCode);
    });

    it("publishes nothing: no outbox row, no publication, no Node", async () => {
      const sale = await refundedSale();
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
        },
      );

      /* Nothing in 1.9 touches the publication pipeline at all. Asserted against
         THIS suite's own Products, so a stray row from another suite cannot make
         the claim pass or fail by accident. */
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
      expect(
        await db.publicationOutbox.count({
          where: { publication: { is: { internalProductId: { startsWith: PRODUCT_PREFIX } } } },
        }),
      ).toBe(0);
      void sale;
    });
  });

  // — 11b · Seller refund policy: versioning, binding, and disclosure —

  describe("the seller refund policy is versioned and historical", () => {
    it("binds the EXACT active version to the Order at checkout", async () => {
      const sale = await paidSale();
      const order = await db.order.findUniqueOrThrow({ where: { id: sale.orderId } });
      const active = await getActiveSellerRefundPolicyVersion(sale.seller.participantId, { db });

      expect(order.sellerRefundPolicyId).toBe(active!.policyId);
      expect(order.sellerRefundPolicyVersion).toBe(active!.policyVersion);
      /* A REFERENCE, never prose. No column on the Order carries policy text —
         checked over the row's own values rather than a serialisation, because a
         Prisma row carries BigInts. */
      for (const value of Object.values(order)) {
        if (typeof value === "string") {
          expect(value).not.toContain("We accept returns");
          expect(value).not.toContain("Contact us at the support address");
        }
      }
    });

    it("refuses a sale the seller's terms cannot be bound to", async () => {
      const seller = await seedSellerDirect(10_000, { omit: true });
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();

      await expect(
        beginCheckout(
          CHECKOUT_INPUT(seller.internalListingId),
          policyId,
          {
            provider: "STRIPE",
            port: initiationDouble(),
            taxPort: createStripeTaxAdapter({ config: TAX_CONFIG, client: taxClientDouble() }),
            riskPolicyId,
            buyerDetails: BUYER_DETAILS,
          },
          { ...deps(), taxIds, buyerSnapshotIds },
        ),
      ).rejects.toBeInstanceOf(SellerRefundPolicyUnavailableError);

      /* Refused BEFORE any Order exists, so nothing is left behind. */
      expect(
        await db.order.count({ where: { internalListingId: seller.internalListingId } }),
      ).toBe(0);
    });

    it("keeps a historical Order on the version it was sold under", async () => {
      const sale = await paidSale();
      const bound = await db.order.findUniqueOrThrow({ where: { id: sale.orderId } });

      /* The seller publishes tighter terms AFTER the sale. */
      await recordSellerRefundPolicyVersion(
        {
          policyId: bound.sellerRefundPolicyId!,
          policyVersion: "2",
          sellerParticipantId: sale.seller.participantId,
          terms: {
            refundsAllowed: false,
            eligibilityConditions: [],
            refundWindowDays: null,
            shippingRefundability: "NEVER_REFUNDED",
            procedureKind: "CONTACT_SELLER_SUPPORT",
          },
          document: {
            title: "Returns and refunds",
            sections: [
              { key: "SUMMARY", heading: "Summary", body: "All sales are final." },
              { key: "SHIPPING", heading: "Shipping", body: "Shipping is not refunded." },
              { key: "PROCEDURE", heading: "How", body: "Contact support." },
            ],
          },
          effectiveFrom: LATER,
          recordedByAccountId: sale.seller.accountId,
          recordedAt: LATER,
        },
        { db },
      );
      await activateSellerRefundPolicyVersion(
        { policyId: bound.sellerRefundPolicyId!, policyVersion: "2", activatedAt: LATER },
        { db },
      );

      /* The Order is untouched, and the version it names is now RETIRED. */
      const after = await db.order.findUniqueOrThrow({ where: { id: sale.orderId } });
      expect(after.sellerRefundPolicyVersion).toBe("1");
      const v1 = await readSellerRefundPolicyVersion(bound.sellerRefundPolicyId!, "1", { db });
      expect(v1!.status).toBe("RETIRED");
      /* And a RETIRED version stays readable and bindable. */
      expect(v1!.terms.refundsAllowed).toBe(true);

      /* THE HISTORICAL SALE IS STILL REFUNDABLE, under the terms the buyer saw —
         not under the seller's new "all sales are final". */
      await recordTax(sale);
      const eligibility = await evaluateRefundEligibility(
        { orderId: sale.orderId, at: REFUND_AT },
        { db },
      );
      expect(eligibility.eligible).toBe(true);
      expect(eligibility.sellerRefundPolicyVersion).toBe("1");
      expect(eligibility.refusals).not.toContain("SELLER_REFUND_POLICY_FORBIDS_REFUND");
    });

    it("refuses a refund the bound version forbids, and one outside its window", async () => {
      const forbidden = await paidSale({ refundPolicy: { refundsAllowed: false } });
      await recordTax(forbidden);
      expect(
        (await evaluateRefundEligibility({ orderId: forbidden.orderId, at: REFUND_AT }, { db }))
          .refusals,
      ).toContain("SELLER_REFUND_POLICY_FORBIDS_REFUND");

      const windowed = await paidSale({ refundPolicy: { refundWindowDays: 1 } });
      await recordTax(windowed);
      /* Paid 2028-09-05, asked 2028-09-10 — five days into a one-day window. */
      expect(
        (await evaluateRefundEligibility({ orderId: windowed.orderId, at: REFUND_AT }, { db }))
          .refusals,
      ).toContain("SELLER_REFUND_WINDOW_EXPIRED");
      /* And inside it, the same Order is eligible. */
      expect(
        (
          await evaluateRefundEligibility(
            { orderId: windowed.orderId, at: "2028-09-05T18:00:00.000Z" },
            { db },
          )
        ).eligible,
      ).toBe(true);
    });

    it("discloses the complete applicable policy BEFORE purchase", async () => {
      const seller = await seedSellerDirect();
      const disclosure = await readListingRefundPolicyDisclosure(
        seller.internalListingId,
        NOW,
        { db },
      );
      expect(disclosure.available).toBe(true);
      expect(disclosure.sellerParticipantId).toBe(seller.participantId);
      expect(disclosure.refundsAllowed).toBe(true);
      expect(disclosure.shippingRefundable).toBe("ALWAYS_REFUNDED");
      /* The COMPLETE document, not a summary. */
      expect(disclosure.document!.sections.map((s) => s.key)).toEqual(
        expect.arrayContaining(["SUMMARY", "SHIPPING", "PROCEDURE"]),
      );
      expect(disclosure.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    });

    it("says so honestly when a seller has declared nothing", async () => {
      const seller = await seedSellerDirect(10_000, { omit: true });
      const disclosure = await readListingRefundPolicyDisclosure(
        seller.internalListingId,
        NOW,
        { db },
      );
      expect(disclosure.available).toBe(false);
      expect(disclosure.document).toBeNull();
    });

    it("returns the exact HISTORICAL policy and procedure on the receipt", async () => {
      const sale = await paidSale();
      const bound = await db.order.findUniqueOrThrow({ where: { id: sale.orderId } });

      /* The seller replaces their terms after the sale. */
      await recordSellerRefundPolicyVersion(
        {
          policyId: bound.sellerRefundPolicyId!,
          policyVersion: "2",
          sellerParticipantId: sale.seller.participantId,
          terms: {
            refundsAllowed: false,
            eligibilityConditions: [],
            refundWindowDays: null,
            shippingRefundability: "NEVER_REFUNDED",
            procedureKind: "MONACADO_MEDIATED",
          },
          document: {
            title: "Returns and refunds",
            sections: [
              { key: "SUMMARY", heading: "Summary", body: "All sales are final." },
              { key: "SHIPPING", heading: "Shipping", body: "Shipping is not refunded." },
              { key: "PROCEDURE", heading: "How", body: "Raise it with Monacado." },
            ],
          },
          effectiveFrom: LATER,
          recordedByAccountId: sale.seller.accountId,
          recordedAt: LATER,
        },
        { db },
      );
      await activateSellerRefundPolicyVersion(
        { policyId: bound.sellerRefundPolicyId!, policyVersion: "2", activatedAt: LATER },
        { db },
      );

      const receipt = await readOrderRefundReceipt(sale.orderId, LATER, { db });
      expect(receipt.unavailableReason).toBeNull();
      /* THE VERSION THE BUYER WAS SHOWN, not the seller's current one. */
      expect(receipt.policyRef).toMatchObject({ policyVersion: "1" });
      expect(receipt.policyVersion!.terms.refundsAllowed).toBe(true);
      expect(JSON.stringify(receipt)).toContain("We accept returns for any reason.");
      expect(JSON.stringify(receipt)).not.toContain("All sales are final.");

      /* Procedure, and the contact FROZEN at purchase. */
      expect(receipt.procedure).toMatchObject({
        kind: "CONTACT_SELLER_SUPPORT",
        requiresBuyerAccount: false,
      });
      expect(receipt.procedure!.instructions).toContain("support address");
      expect(receipt.procedure!.purchaseTimeRefundContact).toMatchObject({
        source: "PRIMARY_PROFILE",
        state: "VERIFIED",
      });
      expect(receipt.procedure!.purchaseTimeRefundContact!.address).toMatch(/^refund-/);
    });

    it("persists the support contact disclosed at purchase, with its provenance", async () => {
      const sale = await paidSale();
      const seller = await db.account.findUniqueOrThrow({
        where: { id: sale.seller.accountId },
        select: { email: true },
      });

      const evidence = await db.orderRefundContactEvidence.findUniqueOrThrow({
        where: { orderId: sale.orderId },
      });
      expect(evidence).toMatchObject({
        /* THE EXACT VALUE the buyer was shown. */
        contactAddress: seller.email,
        /* Provenance: which contact was effective, and that it was verified. */
        contactSource: "PRIMARY_PROFILE",
        contactState: "VERIFIED",
      });
      /* Supplied, never a clock read: the instant of the purchase. */
      expect(evidence.capturedAt.toISOString()).toBe(CHECKOUT_AT);

      /* And nothing else about the seller travelled with it. */
      expect(Object.keys(evidence).sort()).toEqual([
        "capturedAt",
        "contactAddress",
        "contactSource",
        "contactState",
        "createdAt",
        "orderId",
      ]);
    });
  });

  // — 11b² · A seller's later changes never rewrite an old receipt —

  describe("a seller's later changes never rewrite an old receipt", () => {
    /**
     * The scenario the correction exists for, end to end.
     *
     * 1. policy v1 and support address A are active;
     * 2. the buyer purchases — the Order binds v1 and A;
     * 3. the seller nominates a dedicated support address B *and* activates v2;
     * 4. the old receipt still shows v1 and A;
     * 5. current resolution returns B, separately, and rewrites nothing.
     */
    it("keeps the historical policy AND contact after both change", async () => {
      const sale = await paidSale();
      const bound = await db.order.findUniqueOrThrow({ where: { id: sale.orderId } });
      const originalAddress = (
        await db.account.findUniqueOrThrow({
          where: { id: sale.seller.accountId },
          select: { email: true },
        })
      ).email;

      const before = await readOrderRefundReceipt(sale.orderId, LATER, { db });
      expect(before.procedure!.purchaseTimeRefundContact!.address).toBe(originalAddress);

      // — 3a. The seller nominates a verified DEDICATED support address. —
      const dedicated = `refund-dedicated-${next()}@example.com`;
      await upsertEmailContact(
        {
          participantId: sale.seller.participantId,
          purpose: "DEDICATED_SUPPORT",
          address: dedicated,
          now: LATER,
        },
        { db, ids: contactIds },
      );
      const challenge = await issueVerificationChallenge(
        {
          participantId: sale.seller.participantId,
          purpose: "DEDICATED_SUPPORT",
          address: dedicated,
          issuedAt: LATER,
        },
        { db, ids: contactIds },
      );
      await consumeVerificationChallenge({ token: challenge.token, at: LATER }, { db });

      // — 3b. And publishes tighter terms. —
      await recordSellerRefundPolicyVersion(
        {
          policyId: bound.sellerRefundPolicyId!,
          policyVersion: "2",
          sellerParticipantId: sale.seller.participantId,
          terms: {
            refundsAllowed: false,
            eligibilityConditions: [],
            refundWindowDays: null,
            shippingRefundability: "NEVER_REFUNDED",
            procedureKind: "MONACADO_MEDIATED",
          },
          document: {
            title: "Returns and refunds",
            sections: [
              { key: "SUMMARY", heading: "Summary", body: "All sales are final." },
              { key: "SHIPPING", heading: "Shipping", body: "Shipping is not refunded." },
              { key: "PROCEDURE", heading: "How", body: "Raise it with Monacado." },
            ],
          },
          effectiveFrom: LATER,
          recordedByAccountId: sale.seller.accountId,
          recordedAt: LATER,
        },
        { db },
      );
      await activateSellerRefundPolicyVersion(
        { policyId: bound.sellerRefundPolicyId!, policyVersion: "2", activatedAt: LATER },
        { db },
      );

      /* The seller's CURRENT effective contact really has moved. */
      const current = await resolveSellerSupportContact(sale.seller.participantId, { db });
      expect(current).toMatchObject({ available: true, address: dedicated });

      // — 4. The old receipt is unchanged in both respects. —
      const after = await readOrderRefundReceipt(sale.orderId, LATER, { db });
      expect(after.policyRef).toMatchObject({ policyVersion: "1" });
      expect(after.policyVersion!.terms.refundsAllowed).toBe(true);
      expect(after.procedure!.kind).toBe("CONTACT_SELLER_SUPPORT");
      expect(after.procedure!.purchaseTimeRefundContact!.address).toBe(originalAddress);
      expect(after.procedure!.purchaseTimeRefundContact!.address).not.toBe(dedicated);
      expect(JSON.stringify(after.procedure)).not.toContain("All sales are final.");
      expect(JSON.stringify(after.procedure)).not.toContain(dedicated);

      // — 5. The current contact is offered SEPARATELY, and alters nothing. —
      expect(after.currentSellerSupportContact).toBe(dedicated);
      expect(after.procedure!.purchaseTimeRefundContact).toEqual(
        before.procedure!.purchaseTimeRefundContact,
      );
    });

    it("reproduces an old receipt for a seller with no usable contact today", async () => {
      const sale = await paidSale();
      const originalAddress = (
        await db.account.findUniqueOrThrow({
          where: { id: sale.seller.accountId },
          select: { email: true },
        })
      ).email;

      /* The seller's contact degrades — their mail now bounces. */
      await db.participantEmailContact.updateMany({
        where: { participantId: sale.seller.participantId },
        data: { state: "DELIVERY_FAILED" },
      });
      expect(
        await resolveSellerSupportContact(sale.seller.participantId, { db }),
      ).toMatchObject({ available: false });

      /* THE RECEIPT STILL RENDERS. A buyer's evidence of what they were told does
         not evaporate because the seller went dark. */
      const receipt = await readOrderRefundReceipt(sale.orderId, LATER, { db });
      expect(receipt.unavailableReason).toBeNull();
      expect(receipt.procedure!.purchaseTimeRefundContact!.address).toBe(originalAddress);
      expect(receipt.currentSellerSupportContact).toBeNull();
    });

    it("keeps a guest's refund rights tied to the historical purchase", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      const bound = await db.order.findUniqueOrThrow({ where: { id: sale.orderId } });
      const originalAddress = (
        await db.account.findUniqueOrThrow({
          where: { id: sale.seller.accountId },
          select: { email: true },
        })
      ).email;

      /* The seller decides they no longer refund anything, and their mail dies. */
      await recordSellerRefundPolicyVersion(
        {
          policyId: bound.sellerRefundPolicyId!,
          policyVersion: "2",
          sellerParticipantId: sale.seller.participantId,
          terms: {
            refundsAllowed: false,
            eligibilityConditions: [],
            refundWindowDays: null,
            shippingRefundability: "NEVER_REFUNDED",
            procedureKind: "MONACADO_MEDIATED",
          },
          document: {
            title: "Returns and refunds",
            sections: [
              { key: "SUMMARY", heading: "Summary", body: "All sales are final." },
              { key: "SHIPPING", heading: "Shipping", body: "Shipping is not refunded." },
              { key: "PROCEDURE", heading: "How", body: "Raise it with Monacado." },
            ],
          },
          effectiveFrom: LATER,
          recordedByAccountId: sale.seller.accountId,
          recordedAt: LATER,
        },
        { db },
      );
      await activateSellerRefundPolicyVersion(
        { policyId: bound.sellerRefundPolicyId!, policyVersion: "2", activatedAt: LATER },
        { db },
      );
      await db.participantEmailContact.updateMany({
        where: { participantId: sale.seller.participantId },
        data: { state: "DELIVERY_FAILED" },
      });

      /* THE GUEST'S PURCHASE-TIME RIGHTS SURVIVE BOTH. No account, and the
         governing policy is still the one they bought under. */
      const refund = await initiateRefundRequest(
        {
          orderId: sale.orderId,
          verification: { kind: "GUEST_CLAIM_CODE", guestClaimCode: sale.guestClaimCode! },
          reasonCode: "CUSTOMER_REQUEST",
          requestedAt: REFUND_AT,
        },
        refundDeps(),
      );
      expect(refund).toMatchObject({
        sellerRefundPolicyVersion: "1",
        requestedByAccountId: null,
        status: "PENDING",
      });

      /* And the instructions they follow are still the ones they were given. */
      const receipt = await readOrderRefundReceipt(sale.orderId, REFUND_AT, { db });
      expect(receipt.procedure!.purchaseTimeRefundContact!.address).toBe(originalAddress);
      expect(receipt.procedure!.instructions).toContain("support address");
    });
  });

  // — 11c · Shipping refundability follows the bound policy —

  describe("shipping refundability follows the bound seller policy", () => {
    it("includes shipping when the policy refunds it", async () => {
      const sale = await refundedSale({
        shipping: 500,
        refundPolicy: { shippingRefundability: "ALWAYS_REFUNDED" },
      });
      const refund = await getRefundForOrder(sale.orderId, { db });
      expect(refund).toMatchObject({
        linesRetailMinorUnits: 10_000,
        linesTaxMinorUnits: 875,
        refundedShippingMinorUnits: 500,
        amountMinorUnits: 11_375,
      });
    });

    it("leaves shipping PAID when the policy withholds it", async () => {
      const sale = await refundedSale({
        shipping: 500,
        refundPolicy: { shippingRefundability: "NEVER_REFUNDED" },
      });
      const refund = await getRefundForOrder(sale.orderId, { db });
      /* A valid refund of a one-line Order for LESS than the whole buyer charge —
         the visible proof that the old invariant is gone. */
      expect(refund).toMatchObject({
        refundedShippingMinorUnits: 0,
        amountMinorUnits: 10_875,
        coversWholeOrder: true,
      });
      const order = await db.order.findUniqueOrThrow({ where: { id: sale.orderId } });
      expect(Number(order.quotedShippingAmountMinorUnits)).toBe(500);

      /* And it reconciles: the reconciler re-derives the rule from the bound
         policy rather than asserting the whole charge. */
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
        },
      );
      const reconciled = await reconcileOrderRefund(sale.orderId, LATER, { db });
      expect(reconciled!.findings).toEqual(["CONSISTENT"]);
    });

    it("returns shipping on seller fault and withholds it on a change of mind", async () => {
      const fault = await refundedSale({
        shipping: 500,
        refundPolicy: { shippingRefundability: "REFUNDED_WHEN_SELLER_AT_FAULT" },
      });
      /* `refundedSale` requests CUSTOMER_REQUEST — the buyer changed their mind,
         and the carriage still happened. */
      expect(await getRefundForOrder(fault.orderId, { db })).toMatchObject({
        refundedShippingMinorUnits: 0,
      });

      const defective = await paidSale({
        shipping: 500,
        refundPolicy: { shippingRefundability: "REFUNDED_WHEN_SELLER_AT_FAULT" },
      });
      await recordTax(defective);
      await requestOrderRefund(
        {
          orderId: defective.orderId,
          reasonCode: "PRODUCT_FAILURE",
          requestorKind: "OPERATOR",
          requestedByAccountId: null,
          requestedAt: REFUND_AT,
        },
        refundDeps(),
      );
      expect(await getRefundForOrder(defective.orderId, { db })).toMatchObject({
        refundedShippingMinorUnits: 500,
      });
    });

    it("EXECUTES a fault-based shipping refund, re-deriving with its own reason", async () => {
      /* The pre-execution re-check must use THIS REFUND'S reason code. Evaluating
         with a default would compute shipping = 0 under
         REFUNDED_WHEN_SELLER_AT_FAULT and then reject a perfectly good refund as
         inconsistent with itself. */
      const sale = await paidSale({
        shipping: 500,
        refundPolicy: { shippingRefundability: "REFUNDED_WHEN_SELLER_AT_FAULT" },
      });
      await recordTax(sale);
      await requestOrderRefund(
        {
          orderId: sale.orderId,
          reasonCode: "PRODUCT_FAILURE",
          requestorKind: "OPERATOR",
          requestedByAccountId: null,
          requestedAt: REFUND_AT,
        },
        refundDeps(),
      );

      const refundPort = refundPortDouble();
      const outcome = await runRefundCycle(
        { at: LATER, limit: 10 },
        { ...refundDeps(), refundPort, taxReversalPort: taxReversalPortDouble() },
      );
      expect(outcome.refundsExecuted).toBe(1);
      expect(refundPort.calls[0]!.amountMinorUnits).toBe(11_375);
      expect(await getRefundForOrder(sale.orderId, { db })).toMatchObject({
        status: "REFUNDED",
        refundedShippingMinorUnits: 500,
      });
    });

    it("executes a refund requested inside a window that has since closed", async () => {
      /* The seller's window governs when a buyer may ASK. A request made in time
         must not become ineligible because a worker ran after it closed. */
      const sale = await paidSale({ refundPolicy: { refundWindowDays: 1 } });
      await recordTax(sale);
      const inTime = "2028-09-05T18:00:00.000Z";
      await requestOrderRefund(
        {
          orderId: sale.orderId,
          reasonCode: "CUSTOMER_REQUEST",
          requestorKind: "BUYER",
          requestedByAccountId: null,
          requestedAt: inTime,
        },
        refundDeps(),
      );

      /* The cycle runs five days later, long after the window shut. */
      const outcome = await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
        },
      );
      expect(outcome.refundsExecuted).toBe(1);
      expect(await getRefundForOrder(sale.orderId, { db })).toMatchObject({
        status: "REFUNDED",
      });
    });

    it("catches a refund whose shipping contradicts the bound policy", async () => {
      const sale = await refundedSale({
        shipping: 500,
        refundPolicy: { shippingRefundability: "NEVER_REFUNDED" },
      });
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
        },
      );

      /* Corrupt the row as a bad migration or a hand-edit might. */
      const refund = await getRefundForOrder(sale.orderId, { db });
      await db.orderRefund.update({
        where: { id: refund!.refundId },
        data: { refundedShippingMinorUnits: BigInt(500) },
      });

      const reconciled = await reconcileOrderRefund(sale.orderId, LATER, { db });
      expect(reconciled!.findings).toContain("SHIPPING_TREATMENT_CONTRADICTS_POLICY");
      expect(reconciled!.needsOperator).toBe(true);
    });
  });

  // — 11d · Guest refund initiation —

  describe("a guest can start a refund without an account", () => {
    it("verifies with the claim code and creates no Account", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      const accountsBefore = await db.account.count();

      const refund = await initiateRefundRequest(
        {
          orderId: sale.orderId,
          verification: { kind: "GUEST_CLAIM_CODE", guestClaimCode: sale.guestClaimCode! },
          reasonCode: "CUSTOMER_REQUEST",
          requestedAt: REFUND_AT,
        },
        refundDeps(),
      );

      expect(refund).toMatchObject({
        requestorKind: "BUYER",
        /* NO ACCOUNT IS FABRICATED — nobody with an account asked. */
        requestedByAccountId: null,
        status: "PENDING",
      });
      expect(await db.account.count()).toBe(accountsBefore);
      const order = await db.order.findUniqueOrThrow({ where: { id: sale.orderId } });
      expect(order.buyerKind).toBe("GUEST_BUYER");
      expect(order.buyerAccountId).toBeNull();
      expect(order.claimedByAccountId).toBeNull();
    });

    it("refuses a wrong code exactly as it refuses an unknown Order", async () => {
      const sale = await paidSale();
      await recordTax(sale);

      const wrongCode = initiateRefundRequest(
        {
          orderId: sale.orderId,
          verification: { kind: "GUEST_CLAIM_CODE", guestClaimCode: "not-the-code" },
          reasonCode: "CUSTOMER_REQUEST",
          requestedAt: REFUND_AT,
        },
        refundDeps(),
      );
      const unknownOrder = initiateRefundRequest(
        {
          orderId: `mon:order:${pad26(`${TAG}N0SUCH`)}`,
          verification: { kind: "GUEST_CLAIM_CODE", guestClaimCode: sale.guestClaimCode! },
          reasonCode: "CUSTOMER_REQUEST",
          requestedAt: REFUND_AT,
        },
        refundDeps(),
      );

      await expect(wrongCode).rejects.toBeInstanceOf(RefundInitiationRefusedError);
      await expect(unknownOrder).rejects.toBeInstanceOf(RefundInitiationRefusedError);
      /* Nothing was written by either. */
      expect(await db.orderRefund.count({ where: { orderId: sale.orderId } })).toBe(0);
    });

    it("does not let a verified buyer widen what the bound terms allow", async () => {
      const sale = await paidSale({ refundPolicy: { refundsAllowed: false } });
      await recordTax(sale);
      await expect(
        initiateRefundRequest(
          {
            orderId: sale.orderId,
            verification: { kind: "GUEST_CLAIM_CODE", guestClaimCode: sale.guestClaimCode! },
            reasonCode: "CUSTOMER_REQUEST",
            requestedAt: REFUND_AT,
          },
          refundDeps(),
        ),
      ).rejects.toMatchObject({
        refusals: expect.arrayContaining(["SELLER_REFUND_POLICY_FORBIDS_REFUND"]),
      });
    });
  });

  // — 11e · Promoter commission —

  describe("promoter commission on a refunded line", () => {
    it("records the attributable amount from sale-time evidence for every party", async () => {
      const sale = await paidSale();
      await recordTax(sale);
      const snapshot = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { orderId: sale.orderId },
      });
      const obligation = await db.proceedsObligation.findFirstOrThrow({
        where: { snapshotId: snapshot.id },
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
          reasonCode: "PRODUCT_FAILURE",
          requestorKind: "OPERATOR",
          requestedByAccountId: null,
          requestedAt: REFUND_AT,
        },
        refundDeps(),
      );
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
        },
      );

      const refund = await getRefundForOrder(sale.orderId, { db });
      const exceptions = await listProceedsRecoveryExceptionsForRefund(refund!.refundId, { db });
      expect(exceptions).toHaveLength(1);
      /* The whole obligation is attributable, because the refund covered every
         line — and both figures are recorded rather than one inferred. */
      expect(exceptions[0]!.amountMinorUnits).toBe(Number(obligation.amountMinorUnits));
      const row = await db.proceedsRecoveryException.findFirstOrThrow({
        where: { refundId: refund!.refundId },
      });
      expect(Number(row.attributableAmountMinorUnits)).toBe(
        Number(obligation.amountMinorUnits),
      );

      /* THE HISTORICAL PAYMENT RECORD IS UNCHANGED. */
      const after = await db.proceedsObligation.findUniqueOrThrow({
        where: { id: obligation.id },
      });
      expect(after.state).toBe("PAID");
      expect(after.paidAt).not.toBeNull();
      expect(Number(after.amountMinorUnits)).toBe(Number(obligation.amountMinorUnits));
    });

    it("reports a claim left payable after a refund, and one lacking recovery evidence", async () => {
      const sale = await refundedSale();
      await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
        },
      );
      const snapshot = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { orderId: sale.orderId },
      });
      const obligation = await db.proceedsObligation.findFirstOrThrow({
        where: { snapshotId: snapshot.id },
      });

      /* Force the state a bad payout run would leave: eligible on a refunded
         sale, with no recovery exception beside it. */
      await db.proceedsObligation.update({
        where: { id: obligation.id },
        data: { state: "ELIGIBLE", becameEligibleAt: new Date(LATER) },
      });

      const reconciled = await reconcileOrderRefund(sale.orderId, LATER, { db });
      /* Seller-direct sale, so it reports as a seller claim. The promoter arm of
         the same check is the `PROMOTER` branch of the identical loop. */
      expect(reconciled!.findings).toContain("PROCEEDS_STILL_PAYOUT_ELIGIBLE");
      expect(reconciled!.needsOperator).toBe(true);
    });
  });

  // — 12 · Crash recovery —

  describe("recovery after a process crash", () => {
    it("returns an expired claim to the pool, costing an attempt rather than the refund", async () => {
      const sale = await refundedSale();

      /* A worker claimed the row and died. */
      const refund = await getRefundForOrder(sale.orderId, { db });
      await db.orderRefund.update({
        where: { id: refund!.refundId },
        data: {
          status: "IN_PROGRESS",
          lockToken: "p19deadworker000000000000000000",
          lockedAt: new Date(REFUND_AT),
          leaseExpiresAt: new Date(REFUND_AT),
        },
      });

      const outcome = await runRefundCycle(
        { at: LATER, limit: 10 },
        {
          ...refundDeps(),
          refundPort: refundPortDouble(),
          taxReversalPort: taxReversalPortDouble(),
        },
      );
      expect(outcome.staleClaimsRecovered).toBeGreaterThan(0);
      /* The obligation survived, and the same cycle executed it. */
      expect(await getRefundForOrder(sale.orderId, { db })).toMatchObject({
        status: "REFUNDED",
      });
    });

    it("never steals a live claim", async () => {
      const sale = await refundedSale();
      const refund = await getRefundForOrder(sale.orderId, { db });
      await db.orderRefund.update({
        where: { id: refund!.refundId },
        data: {
          status: "IN_PROGRESS",
          lockToken: "p19liveworker00000000000000000",
          lockedAt: new Date(LATER),
          /* Lease still running. */
          leaseExpiresAt: new Date("2028-09-10T11:00:00.000Z"),
        },
      });

      const refundPort = refundPortDouble();
      const outcome = await runRefundCycle(
        { at: LATER, limit: 10 },
        { ...refundDeps(), refundPort, taxReversalPort: forbiddenTaxReversalPort() },
      );
      expect(outcome.staleClaimsRecovered).toBe(0);
      expect(outcome.refundsClaimed).toBe(0);
      expect(refundPort.calls).toHaveLength(0);
    });
  });
});
