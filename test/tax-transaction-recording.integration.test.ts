/**
 * Tax transaction recording integration tests (Phase 1.7).
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
 *   - a paid Order commits **exactly one** tax-recording obligation, inside the
 *     sale's own transaction;
 *   - a replayed payment webhook does not create a second;
 *   - a failed or cancelled Order creates none;
 *   - a transient provider failure leaves a **recoverable** row, and the retry
 *     succeeds idempotently against the same calculation;
 *   - the sale-time facts are **unchanged** across that retry;
 *   - reconciliation names a paid Order whose tax is not reported.
 *
 * **Test isolation.** Every identifier carries the `P17T` opaque prefix and every
 * account address the `txrecord-` local part. No `deleteMany({})` appears.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type Stripe from "stripe";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
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
import type {
  TaxTransactionRecordingPort,
  TaxTransactionRecordingRequest,
  TaxTransactionRecordingResult,
} from "../src/server/tax/stripe-tax-transaction-adapter";
import { reconcileOrderTax } from "../src/server/tax/tax-reconciliation-service";
import { projectTaxTransactionCapsule } from "../src/contracts/marketplace/tax-transaction.capsule";
import { IMMUTABLE_TAX_TRANSACTION_FIELDS } from "../src/contracts/marketplace/tax-transaction";
import type { TaxEvidenceIdProvider } from "../src/server/tax/tax-calculation-ids";
import { ProductTaxClassificationMissingError } from "../src/server/tax/tax-errors";
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

const TAG = "P17T";
const PRODUCT_TAG = "P17TPR0D";
const PRODUCT_PREFIX = `mon:product:${PRODUCT_TAG}`;
const ACCOUNT_EMAIL_PREFIX = "txrecord-";
const PASSWORD = "correct-horse-battery-staple-1-2";

const NOW = "2028-06-01T09:00:00.000Z";
const CHECKOUT_AT = "2028-06-05T12:00:00.000Z";
const PAID_AT = "2028-06-05T12:00:05.000Z";
const EXPIRES_AT = "2028-08-30T10:00:00.000Z";

const DIGITAL_TAX_CODE = "txcd_TEST_DIGITAL";
const PHYSICAL_TAX_CODE = "txcd_TEST_TANGIBLE";

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const ACTOR = `mon:actor:${pad26("P17TACT0R")}`;
const RECORDER = `mon:acct:${pad26("P17TREC0RDER")}`;

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
  nextBuyerSnapshotId: () => `mon:obsn:${pad26(`P17T0BSN${next()}`)}`,
};

const BUYER_DETAILS = {
  name: "Synthetic Buyer",
  email: "p17t-buyer@example.test",
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
  configVersion: "txrecord-map/1",
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
  const sourceRecordId = `mon:srec:${pad26(`P17TPSREC${n}`)}`;
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

  const storefrontId = `mon:storefront:${pad26(`P17TST0RE${n}`)}`;
  await db.storefront.create({
    data: {
      internalStorefrontId: storefrontId,
      storefrontSourceRecordId: `mon:srec:${pad26(`P17TSFSREC${n}`)}`,
      currentSourceRecordVersion: "1",
      ownerParticipantId: participantId,
      publicHandle: `p17t-shop-${n}`,
      lifecycle: "ACTIVE",
      visibility: "PUBLIC",
    },
  });
  const listing = await createSellerDirectListing(
    {
      storefrontId,
      internalProductId,
      controllingParticipantId: participantId,
      retail: { retailPriceMinorUnits: retailMinorUnits, retailPriceCurrency: "USD" },
      sale: null,
      actingAccountId: accountId,
      authorizedByActorId: ACTOR,
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
    { label: `P17T ${next()}`, now: NOW },
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

describeDb("1.7 — tax transaction recording", () => {
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

  /** A checkout taken all the way to PAID, with the 1.6 tax quote of 875. */
  async function paidSale(over: { taxMinorUnits?: number } = {}) {
    const seller = await seedSellerDirect();
    const policyId = await seedCommercialPolicy();
    const riskPolicyId = await seedRiskPolicy();
    const taxClient = taxClientDouble(over.taxMinorUnits ?? 875);
    const begun = await beginCheckout(
      CHECKOUT_INPUT(seller.internalListingId),
      policyId,
      {
        provider: "STRIPE",
        port: initiationDouble(),
        taxPort: createStripeTaxAdapter({ config: TAX_CONFIG, client: taxClient }),
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
    const recorded = await recordPaymentResult(
      begun.order.orderId,
      confirmation,
      PAID_AT,
      "STRIPE",
      deps(),
    );
    return { seller, begun, confirmation, sale: recorded.sale! };
  }

  // — 1 · The obligation commits with the sale —

  describe("a paid sale commits exactly one tax-recording obligation", () => {
    it("commits it inside the sale's own transaction, pinned to the calculation", async () => {
      const { begun } = await paidSale();
      const transaction = await getTaxTransactionForOrder(begun.order.orderId, { db });
      expect(transaction).not.toBeNull();
      expect(transaction).toMatchObject({
        orderId: begun.order.orderId,
        provider: "STRIPE_TAX",
        providerMode: "TEST",
        /* The EXACT calculation the sale was evidenced under. */
        providerCalculationRef: begun.taxQuote.providerCalculationRef,
        providerReference: begun.order.orderId,
        currency: "USD",
        taxableBasisMinorUnits: 10_000,
        taxAmountMinorUnits: 875,
        jurisdictionCode: "US-NY",
        treatment: "TAXABLE",
        productTaxClassification: "DIGITAL_GOOD",
        lifecycleState: "RECORDED",
        recordingStatus: "PENDING",
        attemptCount: 0,
      });
      /* Not reported yet — and the record says so rather than implying it was. */
      expect(transaction!.providerTaxTransactionRef).toBeNull();
      expect(transaction!.providerTotalAmountMinorUnits).toBeNull();

      /* It binds the 1.6 evidence row, so a filing can reach the calculation. */
      const evidence = await getOrderTaxEvidence(begun.order.orderId, { db });
      expect(transaction!.taxEvidenceId).toBe(evidence!.taxEvidenceId);
    });

    it("does not create a second when the payment webhook is replayed", async () => {
      const { begun, confirmation } = await paidSale();
      const before = await db.orderTaxTransaction.count({
        where: { orderId: begun.order.orderId },
      });

      /* Stripe delivers at least once. A redelivered success replays the sale. */
      await recordPaymentResult(begun.order.orderId, confirmation, PAID_AT, "STRIPE", deps());
      await recordPaymentResult(begun.order.orderId, confirmation, PAID_AT, "STRIPE", deps());

      expect(
        await db.orderTaxTransaction.count({ where: { orderId: begun.order.orderId } }),
      ).toBe(before);
      expect(before).toBe(1);
    });

    it("creates none for a failed Order, and none for a cancelled one", async () => {
      for (const outcome of ["FAILED", "CANCELLED"] as const) {
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

        if (outcome === "FAILED") {
          await recordPaymentResult(
            begun.order.orderId,
            { outcome: "FAILED", failureCode: "DECLINED" },
            PAID_AT,
            "STRIPE",
            deps(),
          );
        }

        /* Nothing is owed to a tax provider for a sale that never completed. */
        expect(await getTaxTransactionForOrder(begun.order.orderId, { db })).toBeNull();
      }
    });
  });

  // — 2 · Reporting, retry, and immutability —

  describe("reporting is retryable, idempotent, and leaves the facts alone", () => {
    it("records the provider transaction from the exact calculation", async () => {
      const { begun } = await paidSale();
      const port = recordingPortDouble();

      const cycle = await runTaxTransactionRecordingCycle(
        { at: PAID_AT, limit: 10 },
        { db, port },
      );
      expect(cycle.recorded).toBe(1);
      expect(port.calls).toHaveLength(1);
      expect(port.calls[0]!.providerCalculationRef).toBe(begun.taxQuote.providerCalculationRef);
      expect(port.calls[0]!.providerReference).toBe(begun.order.orderId);

      const transaction = await getTaxTransactionForOrder(begun.order.orderId, { db });
      expect(transaction).toMatchObject({
        recordingStatus: "RECORDED",
        providerTaxTransactionRef: "taxtxn_test_1",
        providerTotalAmountMinorUnits: 10_875,
        attemptCount: 1,
      });
      /* The durable identifier a later reversal names. */
      expect(transaction!.providerTaxTransactionRef).toMatch(/^taxtxn_/);
      expect(transaction!.nextAttemptAt).toBeNull();
    });

    it("leaves a recoverable row after a transient failure, then succeeds on retry", async () => {
      const { begun } = await paidSale();
      const failing = recordingPortDouble([
        { outcome: "FAILED", failureCode: "PROVIDER_UNAVAILABLE" },
      ]);

      const first = await runTaxTransactionRecordingCycle(
        { at: PAID_AT, limit: 10 },
        { db, port: failing },
      );
      expect(first.retryScheduled).toBe(1);

      const afterFailure = await getTaxTransactionForOrder(begun.order.orderId, { db });
      expect(afterFailure).toMatchObject({
        recordingStatus: "RETRY_PENDING",
        attemptCount: 1,
        lastFailureCode: "PROVIDER_UNAVAILABLE",
        lastFailureClass: "TRANSIENT",
      });
      /* The obligation is not lost, and it says when it is due again. */
      expect(afterFailure!.nextAttemptAt).not.toBeNull();
      expect(afterFailure!.providerTaxTransactionRef).toBeNull();

      /* Not due yet: a retry before its time does not burn an attempt. */
      const tooSoon = await runTaxTransactionRecordingCycle(
        { at: PAID_AT, limit: 10 },
        { db, port: recordingPortDouble() },
      );
      expect(tooSoon.claimed).toBe(0);

      /* When it is due, the retry succeeds — against the SAME calculation and
         the SAME idempotency key, so the provider returns one transaction. */
      const succeeding = recordingPortDouble();
      const RETRY_AT = "2028-06-05T13:00:00.000Z";
      const second = await runTaxTransactionRecordingCycle(
        { at: RETRY_AT, limit: 10 },
        { db, port: succeeding },
      );
      expect(second.recorded).toBe(1);
      expect(succeeding.calls[0]!.providerCalculationRef).toBe(
        begun.taxQuote.providerCalculationRef,
      );
      expect(succeeding.calls[0]!.idempotencyKey).toBe(failing.calls[0]!.idempotencyKey);

      const final = await getTaxTransactionForOrder(begun.order.orderId, { db });
      expect(final).toMatchObject({ recordingStatus: "RECORDED", attemptCount: 2 });
    });

    it("never rewrites a sale-time fact across a retry", async () => {
      const { begun } = await paidSale();
      const committed = await getTaxTransactionForOrder(begun.order.orderId, { db });

      await runTaxTransactionRecordingCycle(
        { at: PAID_AT, limit: 10 },
        { db, port: recordingPortDouble([{ outcome: "FAILED", failureCode: "PROVIDER_UNAVAILABLE" }]) },
      );
      await runTaxTransactionRecordingCycle(
        { at: "2028-06-05T13:00:00.000Z", limit: 10 },
        { db, port: recordingPortDouble() },
      );
      const recorded = await getTaxTransactionForOrder(begun.order.orderId, { db });

      /* THE property: a failed attempt, a retry, and a success moved the
         lifecycle and touched nothing about what was sold. */
      for (const field of IMMUTABLE_TAX_TRANSACTION_FIELDS) {
        expect(recorded![field], field).toEqual(committed![field]);
      }
      expect(recorded!.recordingStatus).toBe("RECORDED");
      expect(committed!.recordingStatus).toBe("PENDING");
    });

    it("stops retrying a permanent refusal rather than burning attempts", async () => {
      const { begun } = await paidSale();
      const cycle = await runTaxTransactionRecordingCycle(
        { at: PAID_AT, limit: 10 },
        { db, port: recordingPortDouble([{ outcome: "FAILED", failureCode: "CALCULATION_EXPIRED" }]) },
      );
      expect(cycle.permanentlyFailed).toBe(1);
      const row = await getTaxTransactionForOrder(begun.order.orderId, { db });
      expect(row).toMatchObject({
        recordingStatus: "FAILED_PERMANENT",
        lastFailureCode: "CALCULATION_EXPIRED",
        lastFailureClass: "PERMANENT",
      });
      /* No timer will fix it: an operator has to. */
      expect(row!.nextAttemptAt).toBeNull();
    });

    it("answers which paid sales are still unreported, and why", async () => {
      const { begun } = await paidSale();
      await runTaxTransactionRecordingCycle(
        { at: PAID_AT, limit: 10 },
        { db, port: recordingPortDouble([{ outcome: "FAILED", failureCode: "PROVIDER_REJECTED" }]) },
      );
      const outstanding = await listUnreportedTaxTransactions({ limit: 50 }, { db });
      const mine = outstanding.find((r) => r.orderId === begun.order.orderId);
      expect(mine).toBeDefined();
      expect(mine).toMatchObject({ attemptCount: 1, lastFailureCode: "PROVIDER_REJECTED" });
      expect(mine!.nextAttemptAt).not.toBeNull();
    });
  });

  // — 3 · Reconciliation —

  describe("reconciliation compares local records and consults no provider", () => {
    it("names a paid Order whose tax is not reported, then clears it", async () => {
      const { begun } = await paidSale();

      const before = await reconcileOrderTax(begun.order.orderId, PAID_AT, { db });
      expect(before!.consistent).toBe(false);
      expect(before!.findings).toContain("TAX_TRANSACTION_NOT_RECORDED");
      expect(before!.providerTaxTransactionRef).toBeNull();

      await runTaxTransactionRecordingCycle(
        { at: PAID_AT, limit: 10 },
        { db, port: recordingPortDouble() },
      );

      const after = await reconcileOrderTax(begun.order.orderId, PAID_AT, { db });
      expect(after!.consistent).toBe(true);
      expect(after!.findings).toEqual(["CONSISTENT"]);
      expect(after!.providerTaxTransactionRef).toBe("taxtxn_test_1");
    });

    it("identifies a paid Order with no tax transaction at all", async () => {
      const { begun } = await paidSale();
      /* Simulates a sale paid before this phase existed: the obligation row was
         never created, and reconciliation is what surfaces it. */
      await db.orderTaxTransaction.deleteMany({ where: { orderId: begun.order.orderId } });

      const result = await reconcileOrderTax(begun.order.orderId, PAID_AT, { db });
      expect(result!.findings).toContain("PAID_ORDER_MISSING_TAX_TRANSACTION");
      expect(result!.consistent).toBe(false);
    });

    it("identifies amount and currency divergence, reporting every finding", async () => {
      const { begun } = await paidSale();
      await db.orderTaxTransaction.update({
        where: { orderId: begun.order.orderId },
        data: { taxAmountMinorUnits: BigInt(999), currency: "EUR" },
      });

      const result = await reconcileOrderTax(begun.order.orderId, PAID_AT, { db });
      expect(result!.findings).toContain("TAX_AMOUNT_MISMATCH");
      expect(result!.findings).toContain("CURRENCY_MISMATCH");
      /* Every finding, not the first — an operator sent back for the second
         problem is an operator who fixes one and re-breaks the other. */
      expect(result!.findings.length).toBeGreaterThanOrEqual(2);
    });

    it("identifies a transaction pointing at a different calculation", async () => {
      const { begun } = await paidSale();
      await db.orderTaxTransaction.update({
        where: { orderId: begun.order.orderId },
        data: { providerCalculationRef: "taxcalc_someone_elses" },
      });
      const result = await reconcileOrderTax(begun.order.orderId, PAID_AT, { db });
      expect(result!.findings).toContain("CONFLICTING_PROVIDER_REFERENCE");
    });

    it("treats an unpaid Order as consistent rather than as a gap", async () => {
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
      const result = await reconcileOrderTax(begun.order.orderId, PAID_AT, { db });
      /* Nothing is owed for a sale that never completed; reporting it as a gap
         would bury the paid Orders that genuinely are. */
      expect(result!.consistent).toBe(true);
    });
  });

  // — 4 · Zero tax, and the private capsule —

  describe("zero tax is reported, and projects into a private capsule", () => {
    it("records a provider transaction for a zero-tax sale", async () => {
      const { begun } = await paidSale({ taxMinorUnits: 0 });
      expect(begun.order.quote.quotedTaxAmountMinorUnits).toBe(0);

      const port = recordingPortDouble([
        {
          outcome: "RECORDED",
          providerTaxTransactionRef: "taxtxn_zero_1",
          providerTaxTransactionCreatedAt: PAID_AT,
          providerTotalAmountMinorUnits: 10_000,
          providerMode: "TEST",
        },
      ]);
      const cycle = await runTaxTransactionRecordingCycle({ at: PAID_AT, limit: 10 }, { db, port });

      /* Not skipped because it is zero: a jurisdiction where Monacado collected
         nothing is a return line, not an absence. */
      expect(cycle.recorded).toBe(1);
      const row = await getTaxTransactionForOrder(begun.order.orderId, { db });
      expect(row).toMatchObject({
        taxAmountMinorUnits: 0,
        recordingStatus: "RECORDED",
        providerTaxTransactionRef: "taxtxn_zero_1",
      });
      /* And the evidence for the zero survives: which calculation, which
         classification, which jurisdiction. */
      expect(row!.providerCalculationRef).toMatch(/^taxcalc_/);
      expect(row!.productTaxClassification).toBe("DIGITAL_GOOD");
      expect(row!.jurisdictionCode).toBe("US-NY");
    });

    it("projects a private capsule from the persisted record, with no buyer PII", async () => {
      const { begun } = await paidSale();
      await runTaxTransactionRecordingCycle(
        { at: PAID_AT, limit: 10 },
        { db, port: recordingPortDouble() },
      );
      const row = await getTaxTransactionForOrder(begun.order.orderId, { db });

      const capsule = projectTaxTransactionCapsule(row, {
        generatedAt: PAID_AT,
        capsuleSemver: "1.0.0",
        mappingVersion: "tax-transaction-mapping/1.0.0",
      });
      expect(capsule.visibility).toBe("PRIVATE");
      expect(capsule.data.orderRef).toBe(begun.order.orderId);
      expect(capsule.data.providerTaxTransactionRef).toBe("taxtxn_test_1");

      const serialized = JSON.stringify(capsule);
      for (const personal of [
        BUYER_DETAILS.name,
        BUYER_DETAILS.email,
        "1 Test Street",
        "9 Delivery Road",
        "10001",
        "94103",
      ]) {
        expect(serialized, personal).not.toContain(personal);
      }

      /* And nothing was published: no publication row exists for this Order. */
      expect(await db.productPublication.count({ where: { internalProductId: begun.order.internalProductId } })).toBe(0);
    });
  });
});
