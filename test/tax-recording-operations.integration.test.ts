/**
 * Tax recording operations integration tests (Phase 1.8).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * **NO NETWORK, NO STRIPE ACCOUNT, NO CREDENTIAL, NO LIVE MONEY, NO AGENTNET
 * PUBLICATION.** Both Stripe ports are injected doubles.
 *
 * What only a database can show:
 *
 *   - the dispatcher endpoint runs one real bounded cycle end to end;
 *   - pending and retry-due work is processed, and non-due work is skipped;
 *   - a **live claim is not stolen**, and an expired one is recovered;
 *   - a recorded row is never reprocessed;
 *   - a permanent failure is never retried automatically, and a governed
 *     requeue puts exactly the requeueable ones back;
 *   - a zero-tax sale moves through the same pipeline as any other;
 *   - the backlog and readiness reflect what is actually stuck.
 *
 * **Test isolation.** Every identifier carries the `P18T` opaque prefix and every
 * account address the `taxops-` local part. No `deleteMany({})` appears.
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
import { recordPaymentResult } from "../src/server/marketplace/order-service";
import type { OrderIdProvider } from "../src/server/marketplace/order-ids";
import type { GuestClaimCodeProvider } from "../src/server/marketplace/guest-claim-code";
import type { ParticipantIdProvider } from "../src/server/marketplace/participant-ids";
import type { BuyerPaymentInitiationPort } from "../src/contracts/marketplace/buyer-payment";
import { beginCheckout } from "../src/server/payments/executable-checkout-service";
import { getOrderTaxEvidence } from "../src/server/tax/tax-evidence-service";
import {
  getTaxTransactionForOrder,
  listUnreportedTaxTransactions,
} from "../src/server/tax/tax-transaction-service";
import { runTaxTransactionRecordingCycle } from "../src/server/tax/tax-transaction-recorder";
import {
  handleTaxRecorderRequest,
} from "../src/server/tax/tax-recorder-route-handler";
import {
  evaluateTaxOperationsReadiness,
  inspectStuckTaxRecordings,
  requeueTaxRecording,
  summarizeTaxRecordingBacklog,
  TaxRequeueRefusedError,
} from "../src/server/tax/tax-recording-operations-service";
import { TAX_TRANSACTION_RETRY_POLICY } from "../src/contracts/marketplace/tax-transaction";

import type {
  TaxTransactionRecordingPort,
  TaxTransactionRecordingRequest,
  TaxTransactionRecordingResult,
} from "../src/server/tax/stripe-tax-transaction-adapter";
import type { TaxEvidenceIdProvider } from "../src/server/tax/tax-calculation-ids";
import {
  createStripeTaxAdapter,
  type StripeTaxCalculationClient,
} from "../src/server/tax/stripe-tax-adapter";
import type { StripeTaxRuntimeConfig } from "../src/server/tax/tax-runtime-config";
import {
  resolveProductTaxFacts,
  summarizeProductTaxClassificationReadiness,
} from "../src/server/product/product-tax-facts-service";
import {
  ensureShippedMarketplacePolicyActive,
  ensureSellerRefundPolicy,
  verifyPrimarySupportContact,
} from "./support/marketplace-policy-fixture";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const TAG = "P18T";
const PRODUCT_TAG = "P18TPR0D";
const PRODUCT_PREFIX = `mon:product:${PRODUCT_TAG}`;
const ACCOUNT_EMAIL_PREFIX = "taxops-";
const PASSWORD = "correct-horse-battery-staple-1-2";

const NOW = "2028-06-01T09:00:00.000Z";
const CHECKOUT_AT = "2028-06-05T12:00:00.000Z";
const PAID_AT = "2028-06-05T12:00:05.000Z";
const EXPIRES_AT = "2028-08-30T10:00:00.000Z";

const DIGITAL_TAX_CODE = "txcd_TEST_DIGITAL";
const PHYSICAL_TAX_CODE = "txcd_TEST_TANGIBLE";

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const ACTOR = `mon:actor:${pad26("P18TACT0R")}`;
const RECORDER = `mon:acct:${pad26("P18TREC0RDER")}`;

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
const buyerSnapshotIds = {
  nextBuyerSnapshotId: () => `mon:obsn:${pad26(`P18T0BSN${next()}`)}`,
};

const BUYER_DETAILS = {
  name: "Synthetic Buyer",
  email: "p18t-buyer@example.test",
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

const TAX_CONFIG: StripeTaxRuntimeConfig = {
  mode: "TEST",
  apiKeyEnvVar: "MONACADO_STRIPE_SECRET_KEY",
  taxCodes: { DIGITAL_GOOD: DIGITAL_TAX_CODE, PHYSICAL_GOOD: PHYSICAL_TAX_CODE },
  shippingTaxCode: null,
  configVersion: "taxops-map/1",
};

/**
 * A Stripe Tax client double.
 *
 * Records every call, so what Monacado *sent* can be asserted — the half a
 * returned value cannot show, and the half where a buyer's street address would
 * leak if one ever crossed the boundary.
 */
function taxClientDouble(taxMinorUnits = 875): StripeTaxCalculationClient & {
  calls: Array<{ params: Stripe.Tax.CalculationCreateParams; idempotencyKey?: string }>;
} {
  const double = {
    calls: [] as Array<{
      params: Stripe.Tax.CalculationCreateParams;
      idempotencyKey?: string;
    }>,
    async createCalculation(
      params: Stripe.Tax.CalculationCreateParams,
      options?: { idempotencyKey?: string },
    ): Promise<Stripe.Tax.Calculation> {
      double.calls.push({
        params,
        ...(options?.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: options.idempotencyKey }),
      });
      const basis =
        (params.line_items[0]?.amount ?? 0) + (params.shipping_cost?.amount ?? 0);
      return {
        id: `taxcalc_test_${double.calls.length}`,
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
              percentage_decimal: "8.75",
              rate_type: "percentage",
              state: "CA",
              tax_type: "sales_tax",
            },
            taxability_reason: "standard_rated",
            taxable_amount: basis,
          },
        ],
        tax_date: Math.floor(Date.parse(CHECKOUT_AT) / 1_000),
      };
    },
  };
  return double;
}

function initiationDouble(): BuyerPaymentInitiationPort & { calls: number } {
  const port = {
    calls: 0,
    async initiatePayment(request: { orderId: string }) {
      port.calls += 1;
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
  return port;
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
    /* A tax transaction points at BOTH the Order and its evidence, and every key
       is RESTRICT, so it comes off before either. */
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

type Classification = "DIGITAL_GOOD" | "SOFTWARE" | "PHYSICAL_GOOD" | "SERVICE";

async function seedProductVersion(args: {
  internalProductId: string;
  sourceRecordId: string;
  sourceRecordVersion: string;
  deliveryMode: "DIGITAL" | "PHYSICAL";
  taxClassification: Classification | null;
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
      factDeliveryMode: args.deliveryMode,
      taxClassification: args.taxClassification,
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
  over: {
    retailMinorUnits?: number;
    deliveryMode?: "DIGITAL" | "PHYSICAL";
    taxClassification?: Classification | null;
  } = {},
) {
  const retailMinorUnits = over.retailMinorUnits ?? 10_000;
  const deliveryMode = over.deliveryMode ?? "DIGITAL";
  const taxClassification =
    over.taxClassification === undefined ? "DIGITAL_GOOD" : over.taxClassification;

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
  await ensureSellerRefundPolicy(db, {
    sellerParticipantId: participantId,
    recordedByAccountId: accountId,
    now: NOW,
    policyId: `mon:srpol:${participantId.slice(-26)}`,
  });

  const n = next();
  const internalProductId = `${PRODUCT_PREFIX}${pad26(String(n)).slice(0, 26 - PRODUCT_TAG.length)}`;
  const sourceRecordId = `mon:srec:${pad26(`P18TPSREC${n}`)}`;
  await db.product.create({
    data: {
      internalProductId,
      sourceRecordId,
      currentSourceRecordVersion: "1",
      recordStatus: "DRAFT",
    },
  });
  await seedProductVersion({
    internalProductId,
    sourceRecordId,
    sourceRecordVersion: "1",
    deliveryMode,
    taxClassification,
  });

  const storefrontId = `mon:storefront:${pad26(`P18TST0RE${n}`)}`;
  await db.storefront.create({
    data: {
      internalStorefrontId: storefrontId,
      storefrontSourceRecordId: `mon:srec:${pad26(`P18TSFSREC${n}`)}`,
      currentSourceRecordVersion: "1",
      ownerParticipantId: participantId,
      publicHandle: `p18t-shop-${n}`,
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
  return {
    participantId,
    accountId,
    internalProductId,
    sourceRecordId,
    internalListingId: listing.record.internalListingId,
  };
}

async function seedCommercialPolicy(): Promise<string> {
  const policy = await createCommercialPolicy(
    { label: `P18T ${next()}`, now: NOW },
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

const CHECKOUT_INPUT = (
  internalListingId: string,
  shippingAmountMinorUnits = 0,
) => ({
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

const RECORDER_SECRET = "p18t-dispatcher-secret";
const RECORDER_ENV = { MONACADO_TAX_RECORDER_SECRET: RECORDER_SECRET };

/** A recording port double: no Stripe, no network, and it records what it got. */
function recordingPortDouble(
  script: Array<TaxTransactionRecordingResult> = [],
): TaxTransactionRecordingPort & { calls: TaxTransactionRecordingRequest[] } {
  let index = 0;
  const port = {
    calls: [] as TaxTransactionRecordingRequest[],
    async record(request: TaxTransactionRecordingRequest) {
      port.calls.push(request);
      const scripted = script[Math.min(index, script.length - 1)];
      index += 1;
      if (scripted !== undefined) return scripted;
      return {
        outcome: "RECORDED" as const,
        providerTaxTransactionRef: `taxtxn_test_${port.calls.length}`,
        providerTaxTransactionCreatedAt: PAID_AT,
        providerTotalAmountMinorUnits: 10_875,
        providerMode: "TEST" as const,
      };
    },
  };
  return port;
}

describeDb("1.8 — tax recording operations", () => {
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

  /** A checkout taken all the way to PAID, leaving a PENDING tax obligation. */
  async function paidSale(over: { taxMinorUnits?: number } = {}) {
    const seller = await seedSellerDirect();
    const policyId = await seedCommercialPolicy();
    const riskPolicyId = await seedRiskPolicy();
    const begun = await beginCheckout(
      CHECKOUT_INPUT(seller.internalListingId),
      policyId,
      {
        provider: "STRIPE",
        port: initiationDouble(),
        taxPort: createStripeTaxAdapter({
          config: TAX_CONFIG,
          client: taxClientDouble(over.taxMinorUnits ?? 875),
        }),
        riskPolicyId,
        buyerDetails: BUYER_DETAILS,
      },
      { ...deps(), taxIds, buyerSnapshotIds },
    );
    await recordPaymentResult(
      begun.order.orderId,
      {
        outcome: "SUCCEEDED",
        provider: "STRIPE",
        providerTransactionRef: `pi_${pad26(`${TAG}PI${next()}`)}`,
      },
      PAID_AT,
      "STRIPE",
      deps(),
    );
    return { seller, begun };
  }

  const taxRow = (orderId: string) =>
    db.orderTaxTransaction.findUniqueOrThrow({ where: { orderId } });

  // — 1 · The dispatcher endpoint drives a real cycle —

  describe("the dispatcher endpoint runs one bounded cycle", () => {
    it("rejects an unauthorized request without touching any work", async () => {
      const { begun } = await paidSale();
      const port = recordingPortDouble();

      for (const header of [null, "Bearer wrong", `Basic ${RECORDER_SECRET}`]) {
        const result = await handleTaxRecorderRequest(
          { authorizationHeader: header, limitParam: null, now: PAID_AT },
          { db, port, env: RECORDER_ENV },
        );
        expect(result.status).toBe(401);
      }

      /* Nothing was claimed, nothing was reported, and the work is still due. */
      expect(port.calls).toHaveLength(0);
      expect((await taxRow(begun.order.orderId)).recordingStatus).toBe("PENDING");
    });

    it("processes pending work with the correct secret, and leaks nothing", async () => {
      const { begun } = await paidSale();
      const port = recordingPortDouble();

      const result = await handleTaxRecorderRequest(
        { authorizationHeader: `Bearer ${RECORDER_SECRET}`, limitParam: null, now: PAID_AT },
        { db, port, env: RECORDER_ENV },
      );

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ ran: true, claimed: 1, recorded: 1 });

      const serialized = JSON.stringify(result.body);
      for (const forbidden of [
        RECORDER_SECRET,
        begun.order.orderId,
        BUYER_DETAILS.email,
        BUYER_DETAILS.name,
        "Delivery Road",
        "taxtxn_",
      ]) {
        expect(serialized, forbidden).not.toContain(forbidden);
      }

      const row = await taxRow(begun.order.orderId);
      expect(row.recordingStatus).toBe("RECORDED");
      expect(row.providerTaxTransactionRef).toBe("taxtxn_test_1");
    });

    it("never reprocesses a recorded row", async () => {
      const { begun } = await paidSale();
      const port = recordingPortDouble();
      const invoke = () =>
        handleTaxRecorderRequest(
          { authorizationHeader: `Bearer ${RECORDER_SECRET}`, limitParam: null, now: PAID_AT },
          { db, port, env: RECORDER_ENV },
        );

      await invoke();
      const second = await invoke();

      /* One provider call for one sale, however many cycles run. Asking twice
         would risk a second Tax Transaction for one Order. */
      expect(port.calls).toHaveLength(1);
      expect(second.body).toMatchObject({ claimed: 0, recorded: 0 });
      expect((await taxRow(begun.order.orderId)).attemptCount).toBe(1);
    });
  });

  // — 2 · Claim, retry, and recovery semantics —

  describe("claim and retry semantics are Phase 1.7's, unchanged", () => {
    it("skips a retry that is not due, then takes it when it is", async () => {
      const { begun } = await paidSale();
      await runTaxTransactionRecordingCycle(
        { at: PAID_AT, limit: 10 },
        { db, port: recordingPortDouble([{ outcome: "FAILED", failureCode: "PROVIDER_UNAVAILABLE" }]) },
      );
      const scheduled = await taxRow(begun.order.orderId);
      expect(scheduled.recordingStatus).toBe("RETRY_PENDING");

      const tooSoon = recordingPortDouble();
      const skipped = await handleTaxRecorderRequest(
        { authorizationHeader: `Bearer ${RECORDER_SECRET}`, limitParam: null, now: PAID_AT },
        { db, port: tooSoon, env: RECORDER_ENV },
      );
      expect(skipped.body).toMatchObject({ claimed: 0 });
      expect(tooSoon.calls).toHaveLength(0);

      const due = recordingPortDouble();
      const laterIso = new Date(scheduled.nextAttemptAt!.getTime() + 1_000).toISOString();
      const taken = await handleTaxRecorderRequest(
        { authorizationHeader: `Bearer ${RECORDER_SECRET}`, limitParam: null, now: laterIso },
        { db, port: due, env: RECORDER_ENV },
      );
      expect(taken.body).toMatchObject({ claimed: 1, recorded: 1 });
    });

    it("does not steal a live claim", async () => {
      const { begun } = await paidSale();
      const leaseExpiresAt = new Date(
        new Date(PAID_AT).getTime() + TAX_TRANSACTION_RETRY_POLICY.claimLeaseSeconds * 1_000,
      );
      /* Simulate a worker that holds this row right now. */
      await db.orderTaxTransaction.update({
        where: { orderId: begun.order.orderId },
        data: {
          recordingStatus: "IN_PROGRESS",
          lockToken: "someone-elses-token",
          lockedAt: new Date(PAID_AT),
          leaseExpiresAt,
        },
      });

      const port = recordingPortDouble();
      const result = await handleTaxRecorderRequest(
        { authorizationHeader: `Bearer ${RECORDER_SECRET}`, limitParam: null, now: PAID_AT },
        { db, port, env: RECORDER_ENV },
      );

      expect(result.body).toMatchObject({ claimed: 0, staleClaimsRecovered: 0 });
      expect(port.calls).toHaveLength(0);
      const row = await taxRow(begun.order.orderId);
      /* Untouched: this is lease EXPIRY, never lock stealing. */
      expect(row.lockToken).toBe("someone-elses-token");
      expect(row.recordingStatus).toBe("IN_PROGRESS");
    });

    it("recovers an expired claim and records it", async () => {
      const { begun } = await paidSale();
      await db.orderTaxTransaction.update({
        where: { orderId: begun.order.orderId },
        data: {
          recordingStatus: "IN_PROGRESS",
          lockToken: "dead-worker-token",
          lockedAt: new Date(NOW),
          leaseExpiresAt: new Date(NOW),
        },
      });

      const port = recordingPortDouble();
      const result = await handleTaxRecorderRequest(
        { authorizationHeader: `Bearer ${RECORDER_SECRET}`, limitParam: null, now: PAID_AT },
        { db, port, env: RECORDER_ENV },
      );

      /* A crashed worker costs an attempt, never the obligation. */
      expect(result.body).toMatchObject({ staleClaimsRecovered: 1, claimed: 1, recorded: 1 });
      expect((await taxRow(begun.order.orderId)).recordingStatus).toBe("RECORDED");
    });
  });

  // — 3 · Permanent failure and governed requeue —

  describe("permanent failures are surfaced, never silently retried", () => {
    async function permanentlyFailed(failureCode: string) {
      const { begun } = await paidSale();
      await db.orderTaxTransaction.update({
        where: { orderId: begun.order.orderId },
        data: {
          recordingStatus: "FAILED_PERMANENT",
          attemptCount: TAX_TRANSACTION_RETRY_POLICY.maxAttempts,
          lastFailureCode: failureCode,
          lastFailureClass: "PERMANENT",
          nextAttemptAt: null,
          finalizedAt: new Date(PAID_AT),
        },
      });
      return begun;
    }

    it("is never picked up by a cycle", async () => {
      const begun = await permanentlyFailed("PROVIDER_REJECTED");
      const port = recordingPortDouble();
      const result = await handleTaxRecorderRequest(
        { authorizationHeader: `Bearer ${RECORDER_SECRET}`, limitParam: null, now: PAID_AT },
        { db, port, env: RECORDER_ENV },
      );
      expect(result.body).toMatchObject({ claimed: 0 });
      expect(port.calls).toHaveLength(0);
      expect((await taxRow(begun.order.orderId)).recordingStatus).toBe("FAILED_PERMANENT");
    });

    it("is requeued only by an explicit operator action, and then runs", async () => {
      const begun = await permanentlyFailed("PROVIDER_UNAVAILABLE");
      const row = await taxRow(begun.order.orderId);

      const requeued = await requeueTaxRecording(
        { taxTransactionId: row.id, at: PAID_AT },
        { db },
      );
      expect(requeued.recordingStatus).toBe("RETRY_PENDING");
      /* Attempts restart so the bounded schedule runs again… */
      expect(requeued.attemptCount).toBe(0);
      /* …and the evidence that it had already been abandoned is preserved. */
      expect(requeued.requeueCount).toBe(1);
      /* The failure is RETAINED: a requeue is a decision to try again, not a
         claim the failure never happened. */
      expect(requeued.lastFailureCode).toBe("PROVIDER_UNAVAILABLE");

      const port = recordingPortDouble();
      const result = await handleTaxRecorderRequest(
        { authorizationHeader: `Bearer ${RECORDER_SECRET}`, limitParam: null, now: PAID_AT },
        { db, port, env: RECORDER_ENV },
      );
      expect(result.body).toMatchObject({ claimed: 1, recorded: 1 });
    });

    it("refuses to requeue an expired calculation, and names the remediation", async () => {
      const begun = await permanentlyFailed("CALCULATION_EXPIRED");
      const row = await taxRow(begun.order.orderId);

      await expect(
        requeueTaxRecording({ taxTransactionId: row.id, at: PAID_AT }, { db }),
      ).rejects.toBeInstanceOf(TaxRequeueRefusedError);

      const [inspection] = await inspectStuckTaxRecordings({ at: PAID_AT }, { db });
      expect(inspection).toMatchObject({
        orderId: begun.order.orderId,
        recordingStatus: "FAILED_PERMANENT",
        lastFailureCode: "CALCULATION_EXPIRED",
        requeueable: false,
        /* A paid sale whose tax was never reported. Putting that right is an
           adjustment, not a retry. */
        action: "OPERATOR_TAX_ADJUSTMENT_REQUIRED",
      });
      /* And the calculation reference survives for that adjustment to name. */
      expect(inspection!.providerCalculationRef).toMatch(/^taxcalc_/);

      const backlog = await summarizeTaxRecordingBacklog(PAID_AT, { db });
      expect(backlog.calculationExpired).toBe(1);
      expect(backlog.permanentlyFailed).toBe(1);
    });

    it("refuses to requeue a row that is not terminal", async () => {
      const { begun } = await paidSale();
      const row = await taxRow(begun.order.orderId);
      await expect(
        requeueTaxRecording({ taxTransactionId: row.id, at: PAID_AT }, { db }),
      ).rejects.toBeInstanceOf(TaxRequeueRefusedError);
    });
  });

  // — 4 · Backlog, readiness, and zero tax —

  describe("the backlog reflects what is actually stuck", () => {
    it("counts pending work, then clears once it is recorded", async () => {
      const { begun } = await paidSale();

      const before = await evaluateTaxOperationsReadiness(PAID_AT, { db });
      expect(before.backlog.pending).toBe(1);
      expect(before.backlog.dueNow).toBe(1);
      expect(before.backlog.oldestUnresolvedAgeSeconds).not.toBeNull();
      /* Pending work is not unhealthy — it is work. */
      expect(before.healthy).toBe(true);

      await handleTaxRecorderRequest(
        { authorizationHeader: `Bearer ${RECORDER_SECRET}`, limitParam: null, now: PAID_AT },
        { db, port: recordingPortDouble(), env: RECORDER_ENV },
      );

      const after = await evaluateTaxOperationsReadiness(PAID_AT, { db });
      expect(after.backlog.recorded).toBe(1);
      expect(after.backlog.pending).toBe(0);
      expect(after.backlog.oldestUnresolvedAgeSeconds).toBeNull();
      expect(after.healthy).toBe(true);
      expect(begun.order.orderId).toBeTruthy();
    });

    it("blocks readiness on a permanent-failure backlog", async () => {
      const { begun } = await paidSale();
      await db.orderTaxTransaction.update({
        where: { orderId: begun.order.orderId },
        data: {
          recordingStatus: "FAILED_PERMANENT",
          lastFailureCode: "PROVIDER_REJECTED",
          lastFailureClass: "PERMANENT",
          nextAttemptAt: null,
        },
      });

      const readiness = await evaluateTaxOperationsReadiness(PAID_AT, { db });
      /* Every permanently-failed row is a return line that will be missing. */
      expect(readiness.healthy).toBe(false);
      expect(readiness.blockers).toContain("TAX_RECORDING_PERMANENT_FAILURES");
    });

    it("blocks readiness when work is overdue, which means nothing is running", async () => {
      const { begun } = await paidSale();
      const longAfter = new Date(
        new Date(PAID_AT).getTime() + 72 * 60 * 60 * 1_000,
      ).toISOString();

      const readiness = await evaluateTaxOperationsReadiness(longAfter, { db });
      expect(readiness.healthy).toBe(false);
      expect(readiness.blockers).toContain("TAX_RECORDING_OVERDUE");
      expect(begun.order.orderId).toBeTruthy();
    });

    it("puts a zero-tax sale through the same pipeline", async () => {
      const { begun } = await paidSale({ taxMinorUnits: 0 });
      expect(begun.order.quote.quotedTaxAmountMinorUnits).toBe(0);

      /* Not special-cased out of scheduling: it is due like anything else. */
      const before = await summarizeTaxRecordingBacklog(PAID_AT, { db });
      expect(before.pending).toBe(1);
      expect(before.dueNow).toBe(1);

      const port = recordingPortDouble([
        {
          outcome: "RECORDED",
          providerTaxTransactionRef: "taxtxn_zero_1",
          providerTaxTransactionCreatedAt: PAID_AT,
          providerTotalAmountMinorUnits: 10_000,
          providerMode: "TEST",
        },
      ]);
      const result = await handleTaxRecorderRequest(
        { authorizationHeader: `Bearer ${RECORDER_SECRET}`, limitParam: null, now: PAID_AT },
        { db, port, env: RECORDER_ENV },
      );

      expect(result.body).toMatchObject({ claimed: 1, recorded: 1 });
      const row = await taxRow(begun.order.orderId);
      expect(Number(row.taxAmountMinorUnits)).toBe(0);
      expect(row.recordingStatus).toBe("RECORDED");
      expect(row.providerTaxTransactionRef).toBe("taxtxn_zero_1");
    });

    it("keeps buyer identity out of the inspection view", async () => {
      const { begun } = await paidSale();
      await db.orderTaxTransaction.update({
        where: { orderId: begun.order.orderId },
        data: {
          recordingStatus: "FAILED_PERMANENT",
          lastFailureCode: "PROVIDER_REJECTED",
          lastFailureClass: "PERMANENT",
        },
      });

      const rows = await inspectStuckTaxRecordings({ at: PAID_AT }, { db });
      const serialized = JSON.stringify(rows);
      for (const personal of [
        BUYER_DETAILS.name,
        BUYER_DETAILS.email,
        "1 Test Street",
        "9 Delivery Road",
        "10001",
      ]) {
        expect(serialized, personal).not.toContain(personal);
      }
      /* And no publication happened anywhere along the way. */
      expect(
        await db.productPublication.count({
          where: { internalProductId: begun.order.internalProductId },
        }),
      ).toBe(0);
    });
  });
});
