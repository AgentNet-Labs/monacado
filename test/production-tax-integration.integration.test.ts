/**
 * Production tax integration tests (Phase 1.6).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * **NO NETWORK, NO STRIPE ACCOUNT, NO CREDENTIAL, NO LIVE MONEY.** The Stripe
 * Tax client is an injected double that records what it was sent; the payment
 * initiation port is a double. No production tax call and no production write
 * occurs anywhere in this file.
 *
 * What only a database can show:
 *
 *   - a Product's tax classification is **versioned**, and an old version keeps
 *     the classification it was sold under;
 *   - checkout **refuses an unclassified Product** without contacting a provider
 *     and without leaving an Order behind;
 *   - tax evidence **pins** the exact Product source version, classification,
 *     provider code, mapping version, and calculation reference;
 *   - a replayed checkout reuses **one** provider calculation;
 *   - tax still reaches the buyer's total and **no commercial basis**.
 *
 * **Test isolation.** Every identifier carries the `P16T` opaque prefix and every
 * account address the `prodtax-` local part. No `deleteMany({})` appears.
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
import { resolveTaxDestination } from "../src/contracts/marketplace/tax-destination";
import { evaluateBasketFulfillment } from "../src/contracts/marketplace/basket-fulfillment";
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
  verifyPrimarySupportContact,
} from "./support/marketplace-policy-fixture";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const TAG = "P16T";
const PRODUCT_TAG = "P16TPR0D";
const PRODUCT_PREFIX = `mon:product:${PRODUCT_TAG}`;
const ACCOUNT_EMAIL_PREFIX = "prodtax-";
const PASSWORD = "correct-horse-battery-staple-1-2";

const NOW = "2028-06-01T09:00:00.000Z";
const CHECKOUT_AT = "2028-06-05T12:00:00.000Z";
const PAID_AT = "2028-06-05T12:00:05.000Z";
const EXPIRES_AT = "2028-08-30T10:00:00.000Z";

const DIGITAL_TAX_CODE = "txcd_TEST_DIGITAL";
const PHYSICAL_TAX_CODE = "txcd_TEST_TANGIBLE";

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const ACTOR = `mon:actor:${pad26("P16TACT0R")}`;
const RECORDER = `mon:acct:${pad26("P16TREC0RDER")}`;

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
  nextBuyerSnapshotId: () => `mon:obsn:${pad26(`P16T0BSN${next()}`)}`,
};

const BUYER_DETAILS = {
  name: "Synthetic Buyer",
  email: "p16t-buyer@example.test",
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
  configVersion: "prodtax-map/1",
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
    /* Tax evidence points at the buyer snapshot, which points at the Order —
       both RESTRICT, so they come off in that order. */
    /* Phase 1.7 — a tax transaction holds RESTRICT keys onto BOTH the Order
       and its tax evidence, so it comes off before either. */
    await db.orderTaxTransaction.deleteMany({ where: { orderId: { in: orderIdList } } });
    await db.orderTaxEvidence.deleteMany({ where: { orderId: { in: orderIdList } } });
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

  const n = next();
  const internalProductId = `${PRODUCT_PREFIX}${pad26(String(n)).slice(0, 26 - PRODUCT_TAG.length)}`;
  const sourceRecordId = `mon:srec:${pad26(`P16TPSREC${n}`)}`;
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

  const storefrontId = `mon:storefront:${pad26(`P16TST0RE${n}`)}`;
  await db.storefront.create({
    data: {
      internalStorefrontId: storefrontId,
      storefrontSourceRecordId: `mon:srec:${pad26(`P16TSFSREC${n}`)}`,
      currentSourceRecordVersion: "1",
      ownerParticipantId: participantId,
      publicHandle: `p16t-shop-${n}`,
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
    { label: `P16T ${next()}`, now: NOW },
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

describeDb("1.6 — production tax integration", () => {
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

  // — 1 · the Product fact —

  describe("the classification is authoritative, versioned, and read from the pointer", () => {
    it("resolves from the version the Product currently points at", async () => {
      const seller = await seedSellerDirect({ taxClassification: "SOFTWARE" });
      const facts = await resolveProductTaxFacts(db, seller.internalProductId);
      expect(facts).toEqual({
        internalProductId: seller.internalProductId,
        sourceRecordId: seller.sourceRecordId,
        sourceRecordVersion: "1",
        taxClassification: "SOFTWARE",
        deliveryMode: "DIGITAL",
      });
    });

    it("leaves an older version saying what it said when it was sold", async () => {
      const seller = await seedSellerDirect({ taxClassification: "DIGITAL_GOOD" });
      await seedProductVersion({
        internalProductId: seller.internalProductId,
        sourceRecordId: seller.sourceRecordId,
        sourceRecordVersion: "2",
        deliveryMode: "DIGITAL",
        taxClassification: "SOFTWARE",
      });
      await db.product.update({
        where: { internalProductId: seller.internalProductId },
        data: { currentSourceRecordVersion: "2" },
      });

      /* The pointer moved; the immutable version did not. That is what lets a
         completed sale keep explaining itself after a reclassification. */
      expect((await resolveProductTaxFacts(db, seller.internalProductId))?.taxClassification).toBe(
        "SOFTWARE",
      );
      const v1 = await db.productSourceRecordVersionRow.findFirstOrThrow({
        where: { sourceRecordId: seller.sourceRecordId, sourceRecordVersion: "1" },
      });
      expect(v1.taxClassification).toBe("DIGITAL_GOOD");
    });

    it("reports an unclassified version as absent rather than defaulting it", async () => {
      const seller = await seedSellerDirect({ taxClassification: null });
      const facts = await resolveProductTaxFacts(db, seller.internalProductId);
      expect(facts?.taxClassification).toBeNull();
      /* And the readiness summary counts it, so a launch review sees the gap. */
      const summary = await summarizeProductTaxClassificationReadiness(db);
      expect(summary.unclassified).toBeGreaterThan(0);
      expect(summary.totalProducts).toBe(summary.classified + summary.unclassified);
    });
  });

  // — 2 · failing closed —

  describe("checkout refuses what it cannot classify", () => {
    it("refuses an unclassified Product, contacts no provider, and leaves no Order", async () => {
      const seller = await seedSellerDirect({ taxClassification: null });
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const taxClient = taxClientDouble();
      const port = initiationDouble();
      const before = await db.order.count();

      await expect(
        beginCheckout(
          CHECKOUT_INPUT(seller.internalListingId),
          policyId,
          {
            provider: "STRIPE",
            port,
            taxPort: createStripeTaxAdapter({ config: TAX_CONFIG, client: taxClient }),
            riskPolicyId,
            buyerDetails: BUYER_DETAILS,
          },
          { ...deps(), taxIds, buyerSnapshotIds },
        ),
      ).rejects.toBeInstanceOf(ProductTaxClassificationMissingError);

      /* Every alternative to this refusal is a guess, and a guessed tax category
         is a rate nobody chose. Nothing happens at all rather than happening at
         a made-up rate. */
      expect(await db.order.count()).toBe(before);
      expect(taxClient.calls).toHaveLength(0);
      expect(port.calls).toBe(0);
    });

    it("refuses a tangible good declared as delivered digitally", async () => {
      const seller = await seedSellerDirect({
        deliveryMode: "DIGITAL",
        taxClassification: "PHYSICAL_GOOD",
      });
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const taxClient = taxClientDouble();

      await expect(
        beginCheckout(
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
        ),
      ).rejects.toBeInstanceOf(ProductTaxClassificationMissingError);
      expect(taxClient.calls).toHaveLength(0);
    });

    it("refuses a classification this deployment has not mapped", async () => {
      const seller = await seedSellerDirect({ taxClassification: "SERVICE" });
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const before = await db.order.count();

      await expect(
        beginCheckout(
          CHECKOUT_INPUT(seller.internalListingId),
          policyId,
          {
            provider: "STRIPE",
            port: initiationDouble(),
            /* TAX_CONFIG maps DIGITAL_GOOD and PHYSICAL_GOOD only. A partial map
               is legitimate configuration; selling what it does not cover is
               what refuses. */
            taxPort: createStripeTaxAdapter({ config: TAX_CONFIG, client: taxClientDouble() }),
            riskPolicyId,
            buyerDetails: BUYER_DETAILS,
          },
          { ...deps(), taxIds, buyerSnapshotIds },
        ),
      ).rejects.toThrow();
      expect(await db.order.count()).toBe(before);
    });
  });

  // — 3 · a real calculation, end to end —

  describe("a Stripe Tax calculation reaches the Order and its evidence", () => {
    async function checkout(
      over: {
        deliveryMode?: "DIGITAL" | "PHYSICAL";
        taxClassification?: Classification;
        shippingAmountMinorUnits?: number;
        taxMinorUnits?: number;
      } = {},
    ) {
      const seller = await seedSellerDirect({
        ...(over.deliveryMode === undefined ? {} : { deliveryMode: over.deliveryMode }),
        ...(over.taxClassification === undefined
          ? {}
          : { taxClassification: over.taxClassification }),
      });
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const taxClient = taxClientDouble(over.taxMinorUnits ?? 875);
      const begun = await beginCheckout(
        CHECKOUT_INPUT(seller.internalListingId, over.shippingAmountMinorUnits ?? 0),
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
      return { seller, begun, taxClient, policyId, riskPolicyId };
    }

    it("charges the calculated amount and normalizes it into a quote", async () => {
      const { begun } = await checkout();
      expect(begun.taxQuote.provider).toBe("STRIPE_TAX");
      expect(begun.taxQuote.providerMode).toBe("TEST");
      expect(begun.taxQuote.taxAmountMinorUnits).toBe(875);
      expect(begun.order.quote.quotedTaxAmountMinorUnits).toBe(875);
      expect(begun.buyerTotalMinorUnits).toBe(10_875);
    });

    it("pins the exact Product source version, classification, and mapping", async () => {
      const { seller, begun } = await checkout({ taxClassification: "DIGITAL_GOOD" });
      const evidence = await getOrderTaxEvidence(begun.order.orderId, { db });
      expect(evidence).not.toBeNull();
      expect(evidence).toMatchObject({
        orderId: begun.order.orderId,
        provider: "STRIPE_TAX",
        providerMode: "TEST",
        providerCalculationRef: "taxcalc_test_1",
        providerCalculationExpiresAt: EXPIRES_AT,
        currency: "USD",
        taxAmountMinorUnits: 875,
        basisAmountMinorUnits: 10_000,
        treatment: "TAXABLE",
        productSourceRecordId: seller.sourceRecordId,
        productSourceRecordVersion: "1",
        productTaxClassification: "DIGITAL_GOOD",
        providerTaxCode: DIGITAL_TAX_CODE,
        providerConfigVersion: "prodtax-map/1",
        /* Derived from ship-to, which is the one tax jurisdiction source. */
        jurisdictionCode: "US-NY",
      });
      /* The reversal hook: a durable, provider-minted reference the later refund
         phase can name. Monacado never mints one. */
      expect(evidence?.providerCalculationRef).toMatch(/^taxcalc_/);
      expect(evidence?.buyerSnapshotId).not.toBeNull();
    });

    it("keeps no address in the evidence, only the snapshot linkage", async () => {
      const { begun } = await checkout();
      const row = await db.orderTaxEvidence.findUniqueOrThrow({
        where: { orderId: begun.order.orderId },
      });
      const serialized = JSON.stringify(row, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      );
      for (const personal of ["Test Street", "94103", "Testville", "p16t-buyer", "Synthetic Buyer"]) {
        expect(serialized, personal).not.toContain(personal);
      }
      /* The address lives once, on the buyer snapshot, and is reached through
         the linkage rather than copied. */
      expect(row.buyerSnapshotId).not.toBeNull();
    });

    it("sources a PHYSICAL sale to the NY ship-to address, not the CA billing one", async () => {
      const { taxClient, begun } = await checkout({
        deliveryMode: "PHYSICAL",
        taxClassification: "PHYSICAL_GOOD",
        shippingAmountMinorUnits: 1_200,
      });
      const params = taxClient.calls[0]!.params;
      expect(params.shipping_cost?.amount).toBe(1_200);
      expect(params.line_items[0]?.tax_code).toBe(PHYSICAL_TAX_CODE);
      /* The buyer bills to CA and the parcel goes to NY. Tax is sourced to
         ship-to, so NY is the destination — and it is the ONLY address that
         crosses the tax boundary. */
      expect(params.customer_details?.address).toEqual({
        country: "US",
        state: "NY",
        postal_code: "10001",
      });
      expect(params.customer_details?.address_source).toBe("shipping");
      expect(JSON.stringify(params)).not.toContain("94103");

      const evidence = await getOrderTaxEvidence(begun.order.orderId, { db });
      expect(evidence?.jurisdictionCode).toBe("US-NY");
      expect(evidence?.basisAmountMinorUnits).toBe(11_200);
      /* Billing is still collected and still evidenced — it just is not the tax
         destination. The addresses live once, on the snapshot. */
      const snapshot = await db.orderBuyerSnapshot.findUniqueOrThrow({
        where: { orderId: begun.order.orderId },
      });
      expect(snapshot.billingRegion).toBe("CA");
      expect(snapshot.shippingRegion).toBe("NY");
      expect(snapshot.taxRegionCode).toBe("NY");
    });

    it("refuses a PHYSICAL sale with no ship-to address, before the provider call", async () => {
      const seller = await seedSellerDirect({
        deliveryMode: "PHYSICAL",
        taxClassification: "PHYSICAL_GOOD",
      });
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const taxClient = taxClientDouble();
      const port = initiationDouble();
      const before = await db.order.count();

      await expect(
        beginCheckout(
          CHECKOUT_INPUT(seller.internalListingId, 1_200),
          policyId,
          {
            provider: "STRIPE",
            port,
            taxPort: createStripeTaxAdapter({ config: TAX_CONFIG, client: taxClient }),
            riskPolicyId,
            buyerDetails: { ...BUYER_DETAILS, shippingAddress: null },
          },
          { ...deps(), taxIds, buyerSnapshotIds },
        ),
      ).rejects.toMatchObject({ detail: "SHIPPING_ADDRESS_REQUIRED" });

      /* Nowhere to ship to is nowhere to source to. No engine is contacted, no
         payment is started, and no Order is left behind. */
      expect(taxClient.calls).toHaveLength(0);
      expect(port.calls).toBe(0);
      expect(await db.order.count()).toBe(before);
    });

    it("sources a DIGITAL sale to its NY ship-to address, and ships nothing", async () => {
      const { taxClient, begun } = await checkout();
      const params = taxClient.calls[0]!.params;
      /* THE settled rule: ship-to governs tax for a download exactly as it does
         for a parcel. Billing is CA; the engine is told NY. */
      expect(params.customer_details?.address_source).toBe("shipping");
      expect(params.customer_details?.address).toEqual({
        country: "US",
        state: "NY",
        postal_code: "10001",
      });
      expect(JSON.stringify(params)).not.toContain("94103");

      /* And a ship-to address does not make anything physically ship: no
         shipping cost, and the hosted page is not asked to collect a delivery
         address. */
      expect(params.shipping_cost).toBeUndefined();
      expect(begun.fulfillment.requiresShippingAddress).toBe(false);

      const evidence = await getOrderTaxEvidence(begun.order.orderId, { db });
      expect(evidence?.jurisdictionCode).toBe("US-NY");
      const snapshot = await db.orderBuyerSnapshot.findUniqueOrThrow({
        where: { orderId: begun.order.orderId },
      });
      /* Stored, not discarded — a digital Order has a ship-to address like any
         other, and it is what the tax jurisdiction was derived from. */
      expect(snapshot.shippingLine1).toBe("9 Delivery Road");
      expect(snapshot.shippingRegion).toBe("NY");
      expect(snapshot.taxRegionCode).toBe("NY");
    });

    it("accepts same-as-billing and stores a populated ship-to snapshot", async () => {
      const seller = await seedSellerDirect();
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const taxClient = taxClientDouble();
      const begun = await beginCheckout(
        CHECKOUT_INPUT(seller.internalListingId),
        policyId,
        {
          provider: "STRIPE",
          port: initiationDouble(),
          taxPort: createStripeTaxAdapter({ config: TAX_CONFIG, client: taxClient }),
          riskPolicyId,
          /* The ordinary retail convenience — one box, no address typed twice. */
          buyerDetails: { ...BUYER_DETAILS, shippingAddress: null, shipToSameAsBilling: true },
        },
        { ...deps(), taxIds, buyerSnapshotIds },
      );

      const snapshot = await db.orderBuyerSnapshot.findUniqueOrThrow({
        where: { orderId: begun.order.orderId },
      });
      /* POPULATED, not left null to mean "look at billing instead" — so a later
         correction to billing cannot move where this sale was taxed. */
      expect(snapshot.shippingLine1).toBe("1 Test Street");
      expect(snapshot.shippingRegion).toBe("CA");
      expect(snapshot.shippingCountryCode).toBe("US");
      expect(snapshot.taxRegionCode).toBe("CA");
      expect(taxClient.calls[0]!.params.customer_details?.address).toEqual({
        country: "US",
        state: "CA",
        postal_code: "94103",
      });
    });

    it("refuses a DIGITAL sale with no ship-to address, before the provider call", async () => {
      const seller = await seedSellerDirect();
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const taxClient = taxClientDouble();
      const port = initiationDouble();
      const before = await db.order.count();

      await expect(
        beginCheckout(
          CHECKOUT_INPUT(seller.internalListingId),
          policyId,
          {
            provider: "STRIPE",
            port,
            taxPort: createStripeTaxAdapter({ config: TAX_CONFIG, client: taxClient }),
            riskPolicyId,
            /* Neither an address nor same-as-billing. Never a silent fallback to
               billing: that would tax the sale to somewhere nobody nominated. */
            buyerDetails: { ...BUYER_DETAILS, shippingAddress: null },
          },
          { ...deps(), taxIds, buyerSnapshotIds },
        ),
      ).rejects.toMatchObject({ detail: "SHIPPING_ADDRESS_REQUIRED" });

      expect(taxClient.calls).toHaveLength(0);
      expect(port.calls).toBe(0);
      expect(await db.order.count()).toBe(before);
    });

    it("leaves tax outside Monacado's retention and the seller's proceeds", async () => {
      const { begun } = await checkout();
      const recorded = await recordPaymentResult(
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
      const snapshot = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { id: recorded.sale!.snapshotId },
      });

      /* THE property: retention is computed on the $100.00 retail, NOT on the
         $108.75 the buyer paid. A real tax engine changes nothing about it. */
      expect(Number(snapshot.commercialRetailAmountMinorUnits)).toBe(10_000);
      expect(Number(snapshot.taxAmountMinorUnits)).toBe(875);
      expect(Number(snapshot.monacadoRetainedAmountMinorUnits)).toBe(850);
      expect(Number(snapshot.sellerProceedsMinorUnits)).toBe(9_150);
      expect(
        Number(snapshot.monacadoRetainedAmountMinorUnits) +
          Number(snapshot.sellerProceedsMinorUnits),
      ).toBe(10_000);
    });
  });

  // — 4 · a mixed basket is ordinary for tax sourcing —

  describe("delivery modes differing does not refuse a tax destination", () => {
    it("resolves one ship-to destination for a mixed DIGITAL + PHYSICAL basket", () => {
      /* One transaction, one ship-to, one tax destination — every line shares it.
         An earlier draft of this phase refused a mixed basket because it had to
         choose between billing and shipping; with ship-to always governing, there
         is nothing left to choose and nothing to refuse.

         Asserted at the contract, because `0M.9` Orders bind a single Listing and
         no checkout can build a mixed basket yet. Split shipments and multiple
         destinations remain unimplemented and would need their own design. */
      const destination = resolveTaxDestination(BUYER_DETAILS.shippingAddress);
      expect(destination).toEqual({
        countryCode: "US",
        regionCode: "NY",
        postalCode: "10001",
      });

      /* And the fulfillment question stays separate: a mixed basket still ships,
         which is what decides whether the hosted page collects a delivery
         address — not what decides the tax destination. */
      const mixed = evaluateBasketFulfillment([
        { internalProductId: `${PRODUCT_PREFIX}D`, deliveryMode: "DIGITAL" },
        { internalProductId: `${PRODUCT_PREFIX}P`, deliveryMode: "PHYSICAL" },
      ]);
      expect(mixed.requiresShippingAddress).toBe(true);
      expect(mixed.physicalProductIds).toEqual([`${PRODUCT_PREFIX}P`]);
    });
  });

  // — 5 · idempotency —

  describe("a replayed checkout reuses one provider calculation", () => {
    it("derives the same key from the same facts, and a different one otherwise", async () => {
      const seller = await seedSellerDirect();
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const taxClient = taxClientDouble();
      const taxPort = createStripeTaxAdapter({ config: TAX_CONFIG, client: taxClient });

      for (let i = 0; i < 2; i += 1) {
        await beginCheckout(
          CHECKOUT_INPUT(seller.internalListingId),
          policyId,
          {
            provider: "STRIPE",
            port: initiationDouble(),
            taxPort,
            riskPolicyId,
            buyerDetails: BUYER_DETAILS,
          },
          { ...deps(), taxIds, buyerSnapshotIds },
        );
      }

      const [first, second] = taxClient.calls;
      expect(first?.idempotencyKey).toMatch(/^mon-tax-[0-9a-f]{64}$/);
      /* Same checkout facts → same key, so the provider returns the calculation
         it already made instead of creating a second one. */
      expect(second?.idempotencyKey).toBe(first?.idempotencyKey);

      /* A sale that could owe different tax must NOT reuse it. */
      const shipped = await beginCheckout(
        CHECKOUT_INPUT(seller.internalListingId, 500),
        policyId,
        {
          provider: "STRIPE",
          port: initiationDouble(),
          taxPort,
          riskPolicyId,
          buyerDetails: BUYER_DETAILS,
        },
        { ...deps(), taxIds, buyerSnapshotIds },
      );
      expect(shipped.order.orderId).not.toBe("");
      expect(taxClient.calls[2]?.idempotencyKey).not.toBe(first?.idempotencyKey);
    });
  });
});
