/**
 * Pre-live commerce control integration tests (Phase 1.2).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * **NO NETWORK, NO TAX VENDOR, NO PAYMENT PROVIDER, NO LIVE MONEY.** Every
 * boundary is an injected double.
 *
 * What only a database can show:
 *
 *   - checkout **cannot proceed** without an authoritative tax result;
 *   - tax reaches the buyer's total and **no commercial basis**;
 *   - a risk denial stops a payment before an Order exists;
 *   - a full reversal leaves the snapshot **byte-identical** and reconciles to
 *     zero;
 *   - a reversed or restricted claim **cannot become payout-eligible**.
 *
 * **Test isolation.** Every identifier carries the `P12T` opaque prefix and every
 * account address the `prelive-` local part. No `deleteMany({})` appears.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MarketplacePolicyUnavailableError,
  SellerSupportContactUnavailableError,
} from "../src/server/marketplace/order-errors";
import {
  consumeVerificationChallenge,
  degradeEmailContact,
  issueVerificationChallenge,
  upsertEmailContact,
} from "../src/server/policy/email-verification-service";
import { readOrderPolicyView } from "../src/server/policy/order-policy-view-service";
import {
  MARKETPLACE_POLICY_VERSION_1,
  MONACADO_MARKETPLACE_POLICY_ID,
} from "../src/contracts/marketplace/marketplace-policy-content";
import {
  ensureShippedMarketplacePolicyActive,
  ensureSellerRefundPolicy,
  verifyPrimarySupportContact,
} from "./support/marketplace-policy-fixture";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import { grantAccountEntitlement } from "../src/server/account/account-entitlement-service";
import { recordCommerceApproval } from "../src/server/marketplace/participant-commerce-approval-service";
import { imposeParticipantRestriction } from "../src/server/marketplace/participant-restriction-service";
import type { CommerceApprovalIdProvider } from "../src/server/marketplace/participant-commerce-approval-ids";
import { createSellerDirectListing } from "../src/server/marketplace/listing-service";
import {
  activateCommercialPolicyVersion,
  createCommercialPolicy,
  recordCommercialPolicyVersion,
} from "../src/server/marketplace/commercial-policy-service";
import type { CommercialPolicyIdProvider } from "../src/server/marketplace/commercial-policy-ids";
import {
  advanceProceedsObligation,
  getOrder,
  listProceedsObligations,
  recordPaymentResult,
} from "../src/server/marketplace/order-service";
import { ProceedsPayoutHeldError } from "../src/server/marketplace/order-errors";
import type { OrderIdProvider } from "../src/server/marketplace/order-ids";
import type { GuestClaimCodeProvider } from "../src/server/marketplace/guest-claim-code";
import type { ParticipantIdProvider } from "../src/server/marketplace/participant-ids";
import type { BuyerPaymentInitiationPort } from "../src/contracts/marketplace/buyer-payment";
import { beginCheckout } from "../src/server/payments/executable-checkout-service";
import {
  createFlatRateTaxAdapter,
  createUnavailableTaxAdapter,
  createZeroRateTaxAdapter,
} from "../src/server/tax/tax-adapters";
import { TaxCalculationUnavailableError } from "../src/server/tax/tax-errors";
import type { TaxEvidenceIdProvider } from "../src/server/tax/tax-calculation-ids";
import { getOrderTaxEvidence } from "../src/server/tax/tax-evidence-service";
import {
  BuyerSnapshotError,
  confirmBuyerSnapshot,
  getBuyerSnapshot,
} from "../src/server/marketplace/order-buyer-snapshot-service";
import { NEVER_ON_BUYER_SNAPSHOT } from "../src/contracts/marketplace/order-buyer-snapshot";
import {
  BasketFulfillmentError,
  evaluateBasketFulfillment,
} from "../src/contracts/marketplace/basket-fulfillment";
import {
  activateRiskPolicyVersion,
  createRiskPolicy,
  recordRiskPolicyVersion,
} from "../src/server/risk/risk-policy-service";
import { evaluateTransactionRisk } from "../src/server/risk/transaction-risk-service";
import { TransactionDeniedByRiskError } from "../src/server/risk/risk-errors";
import {
  getReversalForSnapshot,
  reconcileProceedsAfterReversal,
  recordFullReversal,
} from "../src/server/marketplace/transaction-reversal-service";
import { TransactionReversalError } from "../src/contracts/marketplace/transaction-reversal";
import { evaluateLiveCommerceReadiness } from "../src/server/operations/live-commerce-readiness";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const TAG = "P12T";
const PRODUCT_TAG = "P12TPR0D";
const PRODUCT_PREFIX = `mon:product:${PRODUCT_TAG}`;
const ACCOUNT_EMAIL_PREFIX = "prelive-";
const PASSWORD = "correct-horse-battery-staple-1-2";

const NOW = "2028-05-01T09:00:00.000Z";
const CHECKOUT_AT = "2028-05-05T12:00:00.000Z";
const PAID_AT = "2028-05-05T12:00:05.000Z";
const REVERSED_AT = "2028-05-20T09:00:00.000Z";

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const ACTOR = `mon:actor:${pad26("P12TACT0R")}`;
const RECORDER = `mon:acct:${pad26("P12TREC0RDER")}`;

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
const reversalIds = { nextReversalId: () => `mon:txrev:${pad26(`${TAG}REV${next()}`)}` };
const approvalIds: CommerceApprovalIdProvider = {
  nextCommerceApprovalId: () => `mon:pcap:${pad26(`${TAG}PCAP${next()}`)}`,
};
const claimCodes: GuestClaimCodeProvider = {
  nextGuestClaimCode: () => `${TAG}-claim-${next()}`.padEnd(43, "x").slice(0, 43),
};
const policyIds: CommercialPolicyIdProvider = {
  nextPolicyId: () => `mon:cpol:${pad26(`${TAG}P0L${next()}`)}`,
};

const BUYER_DETAILS = {
  name: "Synthetic Buyer",
  email: "p12t-buyer@example.test",
  billingAddress: {
    line1: "1 Test Street",
    line2: null,
    city: "Testville",
    region: "CA",
    postalCode: "94000",
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
} as const;

const buyerSnapshotIds = {
  nextBuyerSnapshotId: () => `mon:obsn:${pad26(`P12T0BSN${next()}`)}`,
};

const deps = () => ({ db, ids: orderIds, notificationIds, claimCodes });

function initiationDouble(): BuyerPaymentInitiationPort & {
  calls: number;
  lastRequest: { orderId: string; collectShippingAddress: boolean } | null;
} {
  const port = {
    calls: 0,
    lastRequest: null as { orderId: string; collectShippingAddress: boolean } | null,
    async initiatePayment(request: { orderId: string; collectShippingAddress: boolean }) {
      port.calls += 1;
      port.lastRequest = request;
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
    await db.transactionReversal.deleteMany({ where: { orderId: { in: orderIdList } } });
    /* Tax evidence points at the buyer snapshot, which points at the Order —
       both RESTRICT, so they come off in that order. */
    /* Phase 1.7 — a tax transaction holds RESTRICT keys onto BOTH the Order
       and its tax evidence, so it comes off before either. */
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
    /* Phase 1.5 — durable outbound email holds a RESTRICT key onto the
       obligation deleted further down. */
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
  /* Product source versions carry the authoritative delivery mode and hold a
     RESTRICT key onto the stable Product row, so they come off first. */
  await db.productSourceRecordVersionRow.deleteMany({
    where: { internalProductId: { startsWith: PRODUCT_PREFIX } },
  });
  await db.product.deleteMany({ where: { internalProductId: { startsWith: PRODUCT_PREFIX } } });
}

// — Fixtures —

/**
 * A Product source version declaring how the Product is delivered.
 *
 * Phase 1.2 made `deliveryMode` an explicit authoritative Product fact, and
 * checkout **fails closed** when it is unknown — so every fixture states it
 * rather than relying on a default. That is the point: a Product that does not
 * say how it reaches a buyer cannot be sold.
 */
async function seedProductVersion(
  internalProductId: string,
  sourceRecordId: string,
  deliveryMode: "DIGITAL" | "PHYSICAL",
): Promise<void> {
  await db.productSourceRecordVersionRow.create({
    data: {
      internalProductId,
      sourceRecordId,
      sourceRecordVersion: "1",
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
      factDeliveryMode: deliveryMode,
      /* Phase 1.6 — checkout fails closed on an unclassified Product, exactly as
         Phase 1.2 made it fail closed on an unknown delivery mode. Every fixture
         states it rather than relying on a default, because there is none. */
      taxClassification: deliveryMode === "PHYSICAL" ? "PHYSICAL_GOOD" : "DIGITAL_GOOD",
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
  const n = next();
  const account = await createAccount(
    {
      name: "Synthetic",
      email: `${ACCOUNT_EMAIL_PREFIX}${n}@example.com`,
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
  deliveryMode: "DIGITAL" | "PHYSICAL" = "DIGITAL",
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
  /* Phase 1.3 correction — checkout refuses a sale for a seller nobody can
     reach. Verified here through the real challenge flow, because these
     participants are made ACTIVE by direct update rather than through review. */
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
  const sourceRecordId = `mon:srec:${pad26(`P12TPSREC${n}`)}`;
  await db.product.create({
    data: {
      internalProductId,
      sourceRecordId,
      currentSourceRecordVersion: "1",
      recordStatus: "DRAFT",
    },
  });
  await seedProductVersion(internalProductId, sourceRecordId, deliveryMode);
  const storefrontId = `mon:storefront:${pad26(`P12TST0RE${n}`)}`;
  await db.storefront.create({
    data: {
      internalStorefrontId: storefrontId,
      storefrontSourceRecordId: `mon:srec:${pad26(`P12TSFSREC${n}`)}`,
      currentSourceRecordVersion: "1",
      ownerParticipantId: participantId,
      publicHandle: `p12t-shop-${n}`,
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
    internalListingId: listing.record.internalListingId,
  };
}

async function seedCommercialPolicy(): Promise<string> {
  const policy = await createCommercialPolicy(
    { label: `P12T ${next()}`, now: NOW },
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

async function seedRiskPolicy(
  over: Partial<{
    maxSingleOrderCommercialAmountMinorUnits: number;
    requireSellerCommerceApproval: boolean;
    requireSellerPaymentReadiness: boolean;
    currency: "USD" | "EUR";
    activate: boolean;
  }> = {},
): Promise<string> {
  const policy = await createRiskPolicy(
    { label: `risk ${next()}`, now: NOW },
    { db, ids: riskIds },
  );
  await recordRiskPolicyVersion(
    {
      policyId: policy.policyId,
      policyVersion: "1",
      currency: over.currency ?? "USD",
      maxSingleOrderCommercialAmountMinorUnits:
        over.maxSingleOrderCommercialAmountMinorUnits ?? 100_000_000,
      requireSellerCommerceApproval: over.requireSellerCommerceApproval ?? false,
      requireSellerPaymentReadiness: over.requireSellerPaymentReadiness ?? false,
      effectiveFrom: NOW,
      recordedByAccountId: RECORDER,
      recordedAt: NOW,
    },
    { db },
  );
  if (over.activate !== false) {
    await activateRiskPolicyVersion(
      {
        policyId: policy.policyId,
        policyVersion: "1",
        activatedByAccountId: RECORDER,
        activatedAt: NOW,
      },
      { db },
    );
  }
  return policy.policyId;
}

const CHECKOUT_INPUT = (internalListingId: string) => ({
  internalListingId,
  buyerAccountId: null,
  taxAmountMinorUnits: 0,
  shippingAmountMinorUnits: 0,
  otherPassThroughAmountMinorUnits: 0,
  currency: "USD" as const,
  productAvailability: "available" as const,
  placedAt: CHECKOUT_AT,
});

const describeDb = RUN ? describe : describe.skip;

describeDb("1.2 — pre-live commerce controls", () => {
  beforeEach(async () => {
    await cleanup();
    /* Phase 1.3 correction — checkout refuses a sale it cannot bind to a
       governing policy version. Seeding is idempotent and shared, so the row
       survives this suite's cleanup and is written once. */
    await ensureShippedMarketplacePolicyActive(db, {
      recordedByAccountId: await seedAccount(),
      now: NOW,
    });
  });
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  // — 1 · tax —

  describe("checkout cannot proceed without an authoritative tax result", () => {
    it("refuses, writes no Order, and initiates no payment", async () => {
      const seller = await seedSellerDirect();
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const port = initiationDouble();
      const before = await db.order.count();

      await expect(
        beginCheckout(
          CHECKOUT_INPUT(seller.internalListingId),
          policyId,
          {
            provider: "STRIPE",
            port,
            taxPort: createUnavailableTaxAdapter(),
            riskPolicyId,
            buyerDetails: BUYER_DETAILS,
          },
          { ...deps(), taxIds, buyerSnapshotIds },
        ),
      ).rejects.toBeInstanceOf(TaxCalculationUnavailableError);

      /* Selling untaxed is a liability nobody recorded, so nothing happens at
         all rather than happening untaxed. */
      expect(await db.order.count()).toBe(before);
      expect(port.calls).toBe(0);
    });

    it("includes tax in the buyer total and in no commercial basis", async () => {
      const seller = await seedSellerDirect();
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();

      const begun = await beginCheckout(
        CHECKOUT_INPUT(seller.internalListingId),
        policyId,
        {
          provider: "STRIPE",
          port: initiationDouble(),
          taxPort: createFlatRateTaxAdapter({ basisPoints: 1_000, jurisdictionCode: "US-CA" }),
          riskPolicyId,
          buyerDetails: BUYER_DETAILS,
        },
        { ...deps(), taxIds, buyerSnapshotIds },
      );

      /* $100.00 retail, 10% tax → $110.00 charged. */
      expect(begun.taxQuote.taxAmountMinorUnits).toBe(1_000);
      expect(begun.buyerTotalMinorUnits).toBe(11_000);
      expect(begun.order.quote.quotedTaxAmountMinorUnits).toBe(1_000);
      expect(begun.order.quote.quotedCommercialRetailAmountMinorUnits).toBe(10_000);

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

      /* THE property: Monacado's retention is computed on the $100.00 retail,
         NOT on the $110.00 the buyer paid. Tax enlarges nobody's revenue. */
      expect(Number(snapshot.commercialRetailAmountMinorUnits)).toBe(10_000);
      expect(Number(snapshot.taxAmountMinorUnits)).toBe(1_000);
      expect(Number(snapshot.monacadoRetainedAmountMinorUnits)).toBe(850);
      expect(Number(snapshot.sellerProceedsMinorUnits)).toBe(9_150);
      expect(
        Number(snapshot.monacadoRetainedAmountMinorUnits) +
          Number(snapshot.sellerProceedsMinorUnits),
      ).toBe(10_000);
    });

    it("round-trips the evidence that explains the charge", async () => {
      const seller = await seedSellerDirect();
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();

      const begun = await beginCheckout(
        CHECKOUT_INPUT(seller.internalListingId),
        policyId,
        {
          provider: "STRIPE",
          port: initiationDouble(),
          taxPort: createFlatRateTaxAdapter({ basisPoints: 750, jurisdictionCode: "US-CA" }),
          riskPolicyId,
          buyerDetails: BUYER_DETAILS,
        },
        { ...deps(), taxIds, buyerSnapshotIds },
      );

      const evidence = await getOrderTaxEvidence(begun.order.orderId, { db });
      expect(evidence).not.toBeNull();
      expect(evidence!.provider).toBe("TEST_FLAT_RATE");
      expect(evidence!.taxAmountMinorUnits).toBe(750);
      expect(evidence!.basisAmountMinorUnits).toBe(10_000);
      expect(evidence!.treatment).toBe("TAXABLE");
      expect(evidence!.jurisdictionCode).toBe("US-CA");
      expect(evidence!.calculatedAt).toBe(CHECKOUT_AT);
      /* The amount on the evidence and the amount on the Order are the same
         answer, checked rather than assumed. */
      expect(evidence!.taxAmountMinorUnits).toBe(
        begun.order.quote.quotedTaxAmountMinorUnits,
      );
      /* And no address anywhere in the row. */
      expect(JSON.stringify(evidence)).not.toContain("@");
    });
  });

  // — 1b · buyer snapshot (Phase 1.2 correction) —

  describe("completing a purchase is not anonymous", () => {
    it("persists a guest's name, contact, and billing address without an Account or Participant", async () => {
      const seller = await seedSellerDirect();
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();

      const accountsBefore = await db.account.count();
      const participantsBefore = await db.marketplaceParticipant.count();

      const begun = await beginCheckout(
        CHECKOUT_INPUT(seller.internalListingId),
        policyId,
        {
          provider: "STRIPE",
          port: initiationDouble(),
          taxPort: createZeroRateTaxAdapter(),
          riskPolicyId,
          buyerDetails: BUYER_DETAILS,
        },
        { ...deps(), taxIds, buyerSnapshotIds },
      );

      expect(begun.order.buyer.buyerKind).toBe("GUEST_BUYER");
      /* A guest with a full snapshot is STILL A GUEST. */
      expect(await db.account.count()).toBe(accountsBefore);
      expect(await db.marketplaceParticipant.count()).toBe(participantsBefore);

      const snapshot = await getBuyerSnapshot(begun.order.orderId, { db });
      expect(snapshot).not.toBeNull();
      expect(snapshot!.name).toBe(BUYER_DETAILS.name);
      expect(snapshot!.email).toBe(BUYER_DETAILS.email);
      expect(snapshot!.billingAddress.line1).toBe("1 Test Street");
      expect(snapshot!.billingAddress.countryCode).toBe("US");
      /* Phase 1.6 — four things on every new Order: name, email, billing, and a
         ship-to address. A DIGITAL product is no exception; ship-to is its tax
         destination and implies no physical fulfillment. */
      expect(snapshot!.shippingAddress?.line1).toBe("9 Delivery Road");
      expect(snapshot!.detailSource).toBe("BUYER_SUPPLIED");
      /* Derived from the SHIP-TO address, never from billing and never an IP. */
      expect(snapshot!.taxCountryCode).toBe("US");
      expect(snapshot!.taxRegionCode).toBe("NY");
    });

    it("persists the same transaction snapshot for an account buyer, independent of profile", async () => {
      const seller = await seedSellerDirect();
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const buyerAccountId = await seedAccount();

      const begun = await beginCheckout(
        { ...CHECKOUT_INPUT(seller.internalListingId), buyerAccountId },
        policyId,
        {
          provider: "STRIPE",
          port: initiationDouble(),
          taxPort: createZeroRateTaxAdapter(),
          riskPolicyId,
          buyerDetails: BUYER_DETAILS,
        },
        { ...deps(), taxIds, buyerSnapshotIds },
      );
      expect(begun.order.buyer.buyerKind).toBe("ACCOUNT_BUYER");

      const snapshot = await getBuyerSnapshot(begun.order.orderId, { db });
      /* The snapshot records who bought THIS ORDER — not whatever the account's
         profile happens to say now, and not a pointer to it. */
      const account = await db.account.findUniqueOrThrow({ where: { id: buyerAccountId } });
      expect(snapshot!.email).toBe(BUYER_DETAILS.email);
      expect(snapshot!.email).not.toBe(account.email);
      expect(snapshot!.name).toBe(BUYER_DETAILS.name);
      expect(snapshot!.billingAddress.city).toBe("Testville");
      /* Both addresses, on an account Order exactly as on a guest one. */
      expect(snapshot!.shippingAddress?.city).toBe("Shipton");
    });

    it("refuses a checkout with no billing address, and writes no Order", async () => {
      const seller = await seedSellerDirect();
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
            taxPort: createZeroRateTaxAdapter(),
            riskPolicyId,
            buyerDetails: { ...BUYER_DETAILS, billingAddress: undefined },
          },
          { ...deps(), taxIds, buyerSnapshotIds },
        ),
      ).rejects.toBeInstanceOf(BuyerSnapshotError);
      expect(await db.order.count()).toBe(before);
    });

    it("stores a ship-to address for a DIGITAL product without shipping anything", async () => {
      /* Phase 1.6 settled this differently from `1.2`. Ship-to is required for
         EVERY purchase because it is the tax destination — but on a digital sale
         it implies no physical fulfillment, so nothing is shipped and the hosted
         page is not asked to collect a delivery address of its own. */
      const seller = await seedSellerDirect(10_000, "DIGITAL");
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const port = initiationDouble();

      const begun = await beginCheckout(
        CHECKOUT_INPUT(seller.internalListingId),
        policyId,
        {
          provider: "STRIPE",
          port,
          taxPort: createZeroRateTaxAdapter(),
          riskPolicyId,
          buyerDetails: BUYER_DETAILS,
        },
        { ...deps(), taxIds, buyerSnapshotIds },
      );

      const snapshot = await getBuyerSnapshot(begun.order.orderId, { db });
      expect(snapshot!.shippingAddress?.city).toBe("Shipton");
      /* The tax jurisdiction follows it. */
      expect(snapshot!.taxRegionCode).toBe("NY");
      /* And nothing physically ships. */
      expect(begun.fulfillment.requiresShippingAddress).toBe(false);
      expect(begun.fulfillment.physicalProductIds).toEqual([]);
      expect(port.lastRequest?.collectShippingAddress).toBe(false);
    });

    it("accepts same-as-billing and stores a populated ship-to, never a null", async () => {
      const seller = await seedSellerDirect(10_000, "DIGITAL");
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();

      const begun = await beginCheckout(
        CHECKOUT_INPUT(seller.internalListingId),
        policyId,
        {
          provider: "STRIPE",
          port: initiationDouble(),
          taxPort: createZeroRateTaxAdapter(),
          riskPolicyId,
          buyerDetails: { ...BUYER_DETAILS, shippingAddress: null, shipToSameAsBilling: true },
        },
        { ...deps(), taxIds, buyerSnapshotIds },
      );
      /* Billing is COPIED IN rather than left null to mean "look at billing" —
         so a later correction to billing cannot move where this sale was taxed. */
      const snapshot = await getBuyerSnapshot(begun.order.orderId, { db });
      expect(snapshot!.shippingAddress?.city).toBe("Testville");
      expect(snapshot!.taxRegionCode).toBe("CA");
    });

    it("requires a shipping address for a PHYSICAL product, and refuses without one", async () => {
      const seller = await seedSellerDirect(10_000, "PHYSICAL");
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const port = initiationDouble();
      const before = await db.order.count();

      await expect(
        beginCheckout(
          CHECKOUT_INPUT(seller.internalListingId),
          policyId,
          {
            provider: "STRIPE",
            port,
            taxPort: createZeroRateTaxAdapter(),
            riskPolicyId,
            buyerDetails: { ...BUYER_DETAILS, shippingAddress: null },
          },
          { ...deps(), taxIds, buyerSnapshotIds },
        ),
      ).rejects.toMatchObject({ detail: "SHIPPING_ADDRESS_REQUIRED" });
      expect(port.calls).toBe(0);

      /* Phase 1.6 correction — the refusal moved EARLIER, and the requirement is
         unchanged. A physical sale is now taxed to its delivery address, so
         "where does this go" has to be answered before the tax engine is called,
         which is before the Order is written. The error keeps its identity; what
         changed is that a purchase that cannot be delivered now leaves nothing
         behind at all. */
      const countAfterRefusal = await db.order.count();
      expect(countAfterRefusal).toBe(before);

      const begun = await beginCheckout(
        CHECKOUT_INPUT(seller.internalListingId),
        policyId,
        {
          provider: "STRIPE",
          port,
          taxPort: createZeroRateTaxAdapter(),
          riskPolicyId,
          buyerDetails: BUYER_DETAILS,
        },
        { ...deps(), taxIds, buyerSnapshotIds },
      );
      expect(begun.fulfillment.requiresShippingAddress).toBe(true);
      expect(begun.fulfillment.physicalProductIds).toHaveLength(1);
      expect(port.lastRequest?.collectShippingAddress).toBe(true);
      const snapshot = await getBuyerSnapshot(begun.order.orderId, { db });
      expect(snapshot!.shippingAddress?.city).toBe("Shipton");
    });

    it("fails closed when a Product does not declare how it is delivered", async () => {
      const seller = await seedSellerDirect();
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const port = initiationDouble();

      /* Erase the declared mode — the backward-compatibility case, and every
         Product version written before the fact existed. */
      await db.productSourceRecordVersionRow.updateMany({
        where: { internalProductId: seller.internalProductId },
        data: { factDeliveryMode: null },
      });

      await expect(
        beginCheckout(
          CHECKOUT_INPUT(seller.internalListingId),
          policyId,
          {
            provider: "STRIPE",
            port,
            taxPort: createZeroRateTaxAdapter(),
            riskPolicyId,
            buyerDetails: BUYER_DETAILS,
          },
          { ...deps(), taxIds, buyerSnapshotIds },
        ),
      ).rejects.toBeInstanceOf(BasketFulfillmentError);
      /* Never guessed either way, and no payment started. */
      expect(port.calls).toBe(0);
    });

    it("guest checkout creates no Account or Participant, digital or physical", async () => {
      for (const mode of ["DIGITAL", "PHYSICAL"] as const) {
        const seller = await seedSellerDirect(10_000, mode);
        const policyId = await seedCommercialPolicy();
        const riskPolicyId = await seedRiskPolicy();

        const accountsBefore = await db.account.count();
        const participantsBefore = await db.marketplaceParticipant.count();

        const begun = await beginCheckout(
          CHECKOUT_INPUT(seller.internalListingId),
          policyId,
          {
            provider: "STRIPE",
            port: initiationDouble(),
            taxPort: createZeroRateTaxAdapter(),
            riskPolicyId,
            buyerDetails: BUYER_DETAILS,
          },
          { ...deps(), taxIds, buyerSnapshotIds },
        );

        expect(begun.order.buyer.buyerKind, mode).toBe("GUEST_BUYER");
        expect(await db.account.count(), mode).toBe(accountsBefore);
        expect(await db.marketplaceParticipant.count(), mode).toBe(participantsBefore);
      }
    });

    it("sources tax from SHIP-TO, not from billing, when the two differ", async () => {
      const seller = await seedSellerDirect(10_000, "PHYSICAL");
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();

      const begun = await beginCheckout(
        CHECKOUT_INPUT(seller.internalListingId),
        policyId,
        {
          provider: "STRIPE",
          port: initiationDouble(),
          taxPort: createZeroRateTaxAdapter(),
          riskPolicyId,
          buyerDetails: BUYER_DETAILS,
        },
        { ...deps(), taxIds, buyerSnapshotIds },
      );
      const snapshot = await getBuyerSnapshot(begun.order.orderId, { db });
      expect(snapshot!.billingAddress.city).toBe("Testville");
      expect(snapshot!.shippingAddress?.city).toBe("Shipton");
      /* Phase 1.6 settled tax sourcing on SHIP-TO. The two addresses differ here
         (billing CA, ship-to NY) precisely so the rule is visible: the tax
         jurisdiction follows the destination, not the payment address. */
      expect(snapshot!.shippingAddress?.region).toBe("NY");
      expect(snapshot!.taxRegionCode).toBe("NY");
    });

    it("gives tax the authoritative ship-to jurisdiction and binds the evidence to the snapshot", async () => {
      const seller = await seedSellerDirect();
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();

      const seen: Array<{ destination: { countryCode: string; regionCode: string | null } | null }> =
        [];
      const recordingTaxPort = {
        async calculate(request: {
          destination: { countryCode: string; regionCode: string | null } | null;
        }) {
          seen.push({ destination: request.destination });
          const code =
            request.destination === null
              ? "US"
              : request.destination.regionCode === null
                ? request.destination.countryCode
                : `${request.destination.countryCode}-${request.destination.regionCode}`;
          return createFlatRateTaxAdapter({ basisPoints: 1_000, jurisdictionCode: code }).calculate(
            request as never,
          );
        },
      };

      const begun = await beginCheckout(
        CHECKOUT_INPUT(seller.internalListingId),
        policyId,
        {
          provider: "STRIPE",
          port: initiationDouble(),
          taxPort: recordingTaxPort as never,
          riskPolicyId,
          buyerDetails: BUYER_DETAILS,
        },
        { ...deps(), taxIds, buyerSnapshotIds },
      );

      /* The engine was asked about the SHIP-TO destination, and about no other
         location — the request carries no second one. */
      expect(seen).toHaveLength(1);
      expect(seen[0]!.destination).toEqual({
        countryCode: "US",
        regionCode: "NY",
        postalCode: "10001",
      });

      const snapshot = await getBuyerSnapshot(begun.order.orderId, { db });
      const evidence = await getOrderTaxEvidence(begun.order.orderId, { db });
      expect(evidence!.jurisdictionCode).toBe("US-NY");
      /* And the evidence names the exact snapshot whose address produced it, so
         "what address was this calculated from" stays answerable. */
      expect(evidence!.buyerSnapshotId).toBe(snapshot!.buyerSnapshotId);
    });

    it("lets Stripe-confirmed details supersede, and refuses to be overridden afterwards", async () => {
      const seller = await seedSellerDirect(10_000, "PHYSICAL");
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const begun = await beginCheckout(
        CHECKOUT_INPUT(seller.internalListingId),
        policyId,
        {
          provider: "STRIPE",
          port: initiationDouble(),
          taxPort: createZeroRateTaxAdapter(),
          riskPolicyId,
          buyerDetails: BUYER_DETAILS,
        },
        { ...deps(), taxIds, buyerSnapshotIds },
      );

      const confirmed = {
        name: "Confirmed Payer",
        email: "confirmed@example.test",
        billingAddress: {
          line1: "5 Confirmed Way",
          line2: null,
          city: "Realtown",
          region: "NY",
          postalCode: "10001",
          countryCode: "US",
        },
        shippingAddress: {
          line1: "7 Confirmed Drive",
          line2: null,
          city: "Realtown",
          region: "NY",
          postalCode: "10001",
          countryCode: "US",
        },
      };
      await confirmBuyerSnapshot(
        { orderId: begun.order.orderId, confirmed, confirmedAt: PAID_AT },
        { db },
      );

      const after = await getBuyerSnapshot(begun.order.orderId, { db });
      expect(after!.detailSource).toBe("PROVIDER_CONFIRMED");
      expect(after!.name).toBe("Confirmed Payer");
      expect(after!.billingAddress.city).toBe("Realtown");
      expect(after!.shippingAddress?.line1).toBe("7 Confirmed Drive");
      /* The jurisdiction moves with the confirmed address. */
      expect(after!.taxRegionCode).toBe("NY");

      /* A later caller cannot overwrite what the payment authorized. */
      await confirmBuyerSnapshot(
        {
          orderId: begun.order.orderId,
          confirmed: {
            name: "Attacker",
            email: "attacker@example.test",
            billingAddress: {
              line1: "1 Forged Lane",
              line2: null,
              city: "Nowhere",
              region: "TX",
              postalCode: "70000",
              countryCode: "US",
            },
            shippingAddress: null,
          },
          confirmedAt: PAID_AT,
        },
        { db },
      );
      const still = await getBuyerSnapshot(begun.order.orderId, { db });
      expect(still!.name).toBe("Confirmed Payer");
      expect(still!.billingAddress.city).toBe("Realtown");
      expect(still!.taxRegionCode).toBe("NY");
    });

    it("persists no card, CVV, or payment-method payload", async () => {
      const seller = await seedSellerDirect();
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const begun = await beginCheckout(
        CHECKOUT_INPUT(seller.internalListingId),
        policyId,
        {
          provider: "STRIPE",
          port: initiationDouble(),
          taxPort: createZeroRateTaxAdapter(),
          riskPolicyId,
          buyerDetails: BUYER_DETAILS,
        },
        { ...deps(), taxIds, buyerSnapshotIds },
      );

      /* The privacy reversal was narrow: contact and address, and nothing else.
         Card data stays at Stripe, and there is no column for any of it. */
      const columns = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'OrderBuyerSnapshot'`,
      );
      const names = columns.map((c) => c.COLUMN_NAME.toLowerCase());
      for (const forbidden of NEVER_ON_BUYER_SNAPSHOT) {
        expect(names, forbidden).not.toContain(forbidden.toLowerCase());
      }
      for (const shape of ["card", "cvv", "cvc", "pan", "iban", "kyc", "document"]) {
        expect(names.some((n) => n.includes(shape)), shape).toBe(false);
      }

      const row = await db.orderBuyerSnapshot.findUniqueOrThrow({
        where: { orderId: begun.order.orderId },
      });
      expect(JSON.stringify(row)).not.toMatch(/4242|cvv|cvc|pm_|sk_/i);
    });
  });

  // — 2 · risk —

  describe("the risk gate stands before payment", () => {
    it("permits an otherwise valid checkout", async () => {
      const seller = await seedSellerDirect();
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy({ requireSellerCommerceApproval: true });
      const port = initiationDouble();

      const begun = await beginCheckout(
        CHECKOUT_INPUT(seller.internalListingId),
        policyId,
        {
            provider: "STRIPE",
            port,
            taxPort: createZeroRateTaxAdapter(),
            riskPolicyId,
            buyerDetails: BUYER_DETAILS,
          },
        { ...deps(), taxIds, buyerSnapshotIds },
      );
      expect(begun.riskDecision.decision).toBe("ALLOW");
      /* The decision names the exact policy version, so an ALLOW is as
         explicable after the fact as a DENY. */
      expect(begun.riskDecision.policyId).toBe(riskPolicyId);
      expect(begun.riskDecision.policyVersion).toBe("1");
      expect(port.calls).toBe(1);
    });

    it("denies above the configured ceiling, before any Order exists", async () => {
      const seller = await seedSellerDirect(10_000);
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy({
        maxSingleOrderCommercialAmountMinorUnits: 9_999,
      });
      const port = initiationDouble();
      const before = await db.order.count();

      await expect(
        beginCheckout(
          CHECKOUT_INPUT(seller.internalListingId),
          policyId,
          {
            provider: "STRIPE",
            port,
            taxPort: createZeroRateTaxAdapter(),
            riskPolicyId,
            buyerDetails: BUYER_DETAILS,
          },
          { ...deps(), taxIds, buyerSnapshotIds },
        ),
      ).rejects.toMatchObject({ reasonCodes: ["ORDER_AMOUNT_EXCEEDS_LIMIT"] });

      /* A denied transaction leaves NOTHING behind — no Order, no tax evidence,
         and no payment. */
      expect(await db.order.count()).toBe(before);
      expect(port.calls).toBe(0);
    });

    it("denies a restricted seller at the gate itself", async () => {
      const seller = await seedSellerDirect();
      const riskPolicyId = await seedRiskPolicy();

      await imposeParticipantRestriction(
        {
          participantId: seller.participantId,
          scope: "payout:receive",
          reasonCode: "UNDERWRITING_REVIEW_REQUIRED",
          actingAccountId: await seedInternalActor("participant:restrict"),
          imposedAt: NOW,
        },
        { db, ids: notificationIds },
      );

      const decision = await evaluateTransactionRisk(
        {
          currency: "USD",
          commercialRetailAmountMinorUnits: 10_000,
          sellerParticipantId: seller.participantId,
          promoterParticipantId: null,
          storefrontOwnerParticipantId: seller.participantId,
        },
        riskPolicyId,
        CHECKOUT_AT,
        { db },
      );
      expect(decision.decision).toBe("DENY");
      expect(decision.reasonCodes).toContain("SELLER_RESTRICTED");
    });

    it("is not redundant with listing eligibility, which sees only the controller", async () => {
      /* Any restriction sets the participant RESTRICTED, and 0M.7's eligibility
         read catches that for the Listing's CONTROLLER — so a restricted
         seller-direct seller is refused before the gate is consulted.
         Defence in depth, and the earlier gate rightly wins.
         *
         * The gate is NOT redundant, though: on a PROMOTED sale the party owed
         * seller proceeds is the OFFER's seller, who is not the controller and
         * whose status eligibility never reads. This asserts the gate answers
         * about that party independently. */
      const seller = await seedSellerDirect();
      const riskPolicyId = await seedRiskPolicy();
      const other = await seedSellerDirect();

      await imposeParticipantRestriction(
        {
          participantId: other.participantId,
          scope: "payout:receive",
          reasonCode: "UNDERWRITING_REVIEW_REQUIRED",
          actingAccountId: await seedInternalActor("participant:restrict"),
          imposedAt: NOW,
        },
        { db, ids: notificationIds },
      );

      /* The restricted party stands in for a promoted sale's Offer seller: a
         participant the Listing's own eligibility read never looks at. */
      const decision = await evaluateTransactionRisk(
        {
          currency: "USD",
          commercialRetailAmountMinorUnits: 10_000,
          sellerParticipantId: other.participantId,
          promoterParticipantId: null,
          storefrontOwnerParticipantId: seller.participantId,
        },
        riskPolicyId,
        CHECKOUT_AT,
        { db },
      );
      expect(decision.reasonCodes).toEqual(["SELLER_RESTRICTED"]);
    });

    it("fails closed when no policy is active", async () => {
      const seller = await seedSellerDirect();
      const riskPolicyId = await seedRiskPolicy({ activate: false });

      const decision = await evaluateTransactionRisk(
        {
          currency: "USD",
          commercialRetailAmountMinorUnits: 10_000,
          sellerParticipantId: seller.participantId,
          promoterParticipantId: null,
          storefrontOwnerParticipantId: seller.participantId,
        },
        riskPolicyId,
        CHECKOUT_AT,
        { db },
      );
      /* Never a default limit. The safe reading of silence is "no". */
      expect(decision.decision).toBe("DENY");
      expect(decision.reasonCodes).toEqual(["RISK_POLICY_NOT_CONFIGURED"]);
      expect(decision.policyId).toBeNull();
    });

    it("reports every applicable reason, not the first", async () => {
      const seller = await seedSellerDirect();
      const riskPolicyId = await seedRiskPolicy({
        maxSingleOrderCommercialAmountMinorUnits: 1,
        requireSellerCommerceApproval: true,
      });
      await recordCommerceApproval(
        {
          participantId: seller.participantId,
          decision: "NOT_APPROVED",
          reasonCode: "WITHDRAWN_BY_MONACADO",
          actingAccountId: await seedInternalActor("participant:commerce-approve"),
          decidedAt: NOW,
        },
        { db, ids: approvalIds },
      );

      const decision = await evaluateTransactionRisk(
        {
          currency: "USD",
          commercialRetailAmountMinorUnits: 10_000,
          sellerParticipantId: seller.participantId,
          promoterParticipantId: null,
          storefrontOwnerParticipantId: seller.participantId,
        },
        riskPolicyId,
        CHECKOUT_AT,
        { db },
      );
      expect(decision.reasonCodes).toEqual([
        "ORDER_AMOUNT_EXCEEDS_LIMIT",
        "SELLER_NOT_COMMERCE_APPROVED",
      ]);
    });
  });

  // — 3 · reversal —

  async function completedSale() {
    const seller = await seedSellerDirect();
    const policyId = await seedCommercialPolicy();
    const riskPolicyId = await seedRiskPolicy();
    const begun = await beginCheckout(
      CHECKOUT_INPUT(seller.internalListingId),
      policyId,
      {
        provider: "STRIPE",
        port: initiationDouble(),
        taxPort: createFlatRateTaxAdapter({ basisPoints: 1_000 }),
        riskPolicyId,
        buyerDetails: BUYER_DETAILS,
      },
      { ...deps(), taxIds, buyerSnapshotIds },
    );
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
    return { seller, order: begun.order, sale: recorded.sale! };
  }

  describe("a full reversal preserves the original and reconciles", () => {
    it("leaves the snapshot byte-identical and records new evidence", async () => {
      const { sale } = await completedSale();
      const before = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { id: sale.snapshotId },
      });

      const result = await recordFullReversal(
        {
          snapshotId: sale.snapshotId,
          kind: "REFUND",
          reasonCode: "BUYER_REQUESTED",
          provider: "STRIPE",
          providerReversalRef: `re_${pad26(`${TAG}RE`)}`,
          occurredAt: REVERSED_AT,
          recordedAt: REVERSED_AT,
        },
        { db, ids: reversalIds },
      );

      const after = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { id: sale.snapshotId },
      });
      /* 0M.T1: "economic facts are not editable in place." Not one column. */
      expect(after).toEqual(before);

      expect(result.reversal.scope).toBe("FULL");
      expect(result.reversal.amounts.monacadoRetainedAmountMinorUnits).toBe(850);
      expect(result.reversal.amounts.sellerProceedsMinorUnits).toBe(9_150);
      /* Tax comes back to the buyer in full, and was never party revenue. */
      expect(result.reversal.amounts.taxAmountMinorUnits).toBe(1_000);
      expect(result.reversedBuyerTotalMinorUnits).toBe(11_000);

      /* The settlement row — 0M.T1's mutable half — is where REVERSED belongs. */
      const settlement = await db.transactionSettlement.findUniqueOrThrow({
        where: { snapshotId: sale.snapshotId },
      });
      expect(settlement.state).toBe("REVERSED");
      expect(settlement.reversedAt?.toISOString()).toBe(REVERSED_AT);
    });

    it("reconciles every proceeds claim to zero", async () => {
      const { sale } = await completedSale();
      await recordFullReversal(
        {
          snapshotId: sale.snapshotId,
          kind: "REFUND",
          reasonCode: "NOT_FULFILLABLE",
          provider: "STRIPE",
          providerReversalRef: `re_${pad26(`${TAG}RE2`)}`,
          occurredAt: REVERSED_AT,
          recordedAt: REVERSED_AT,
        },
        { db, ids: reversalIds },
      );

      const positions = await reconcileProceedsAfterReversal(sale.snapshotId, { db });
      expect(positions.length).toBeGreaterThan(0);
      for (const position of positions) {
        expect(position.netAmountMinorUnits, position.party).toBe(0);
      }
      /* The obligations themselves are untouched — forward-only, and the
         reversal is recorded beside them rather than editing them. */
      const obligations = await listProceedsObligations(sale.snapshotId, deps());
      expect(obligations.every((o) => o.state === "PENDING")).toBe(true);
    });

    it("refuses a second reversal rather than crediting twice", async () => {
      const { sale } = await completedSale();
      const args = {
        snapshotId: sale.snapshotId,
        kind: "REFUND" as const,
        reasonCode: "BUYER_REQUESTED" as const,
        provider: "STRIPE" as const,
        providerReversalRef: `re_${pad26(`${TAG}RE3`)}`,
        occurredAt: REVERSED_AT,
        recordedAt: REVERSED_AT,
      };
      await recordFullReversal(args, { db, ids: reversalIds });

      /* Deliberately NOT idempotent: a second reversal of one sale is either a
         duplicate credit or a partial arriving under the wrong name. */
      await expect(recordFullReversal(args, { db, ids: reversalIds })).rejects.toBeInstanceOf(
        TransactionReversalError,
      );
      expect(
        await db.transactionReversal.count({ where: { snapshotId: sale.snapshotId } }),
      ).toBe(1);
    });
  });

  // — 4 · payout hold —

  describe("proceeds cannot become payout-eligible when held", () => {
    it("holds a claim on a reversed sale", async () => {
      const { sale } = await completedSale();
      await recordFullReversal(
        {
          snapshotId: sale.snapshotId,
          kind: "CHARGEBACK",
          reasonCode: "DISPUTED_BY_BUYER",
          provider: "STRIPE",
          providerReversalRef: `re_${pad26(`${TAG}RE4`)}`,
          occurredAt: REVERSED_AT,
          recordedAt: REVERSED_AT,
        },
        { db, ids: reversalIds },
      );

      const [obligation] = await listProceedsObligations(sale.snapshotId, deps());
      await expect(
        advanceProceedsObligation(
          { obligationId: obligation!.obligationId, to: "ELIGIBLE", at: REVERSED_AT },
          deps(),
        ),
      ).rejects.toMatchObject({ holdReason: "SALE_REVERSED" });
    });

    it("holds a claim for a participant restricted from payout", async () => {
      const { seller, sale } = await completedSale();
      await imposeParticipantRestriction(
        {
          participantId: seller.participantId,
          scope: "payout:receive",
          reasonCode: "UNDERWRITING_REVIEW_REQUIRED",
          actingAccountId: await seedInternalActor("participant:restrict"),
          imposedAt: NOW,
        },
        { db, ids: notificationIds },
      );

      const [obligation] = await listProceedsObligations(sale.snapshotId, deps());
      await expect(
        advanceProceedsObligation(
          { obligationId: obligation!.obligationId, to: "ELIGIBLE", at: REVERSED_AT },
          deps(),
        ),
      ).rejects.toBeInstanceOf(ProceedsPayoutHeldError);

      /* And the claim is still exactly where it was. A hold does not consume it. */
      const [after] = await listProceedsObligations(sale.snapshotId, deps());
      expect(after!.state).toBe("PENDING");
    });

    it("permits eligibility when nothing holds it", async () => {
      const { sale } = await completedSale();
      const [obligation] = await listProceedsObligations(sale.snapshotId, deps());
      const advanced = await advanceProceedsObligation(
        { obligationId: obligation!.obligationId, to: "ELIGIBLE", at: REVERSED_AT },
        deps(),
      );
      expect(advanced.state).toBe("ELIGIBLE");
    });
  });

  // — 5 · readiness —

  describe("live-commerce readiness", () => {
    const CONFIGURED = (riskPolicyId: string) => ({
      MONACADO_TAX_ENABLED: "true",
      MONACADO_TAX_PROVIDER: "TEST_ZERO_RATE",
      MONACADO_MAIL_ENABLED: "true",
      MONACADO_MAIL_TRANSPORT: "LOG",
      MONACADO_RISK_POLICY_ID: riskPolicyId,
    });

    it("fails closed with nothing configured, naming every blocker", async () => {
      const readiness = await evaluateLiveCommerceReadiness(NOW, { db, env: {} });
      expect(readiness.ready).toBe(false);
      for (const code of [
        "TAX_CALCULATION_NOT_CONFIGURED",
        "RISK_POLICY_NOT_CONFIGURED",
        "NOTIFICATION_DELIVERY_NOT_CONFIGURED",
        "LIVE_PROVIDER_NOT_ENABLED",
      ]) {
        expect(readiness.blockers).toContain(code);
      }
    });

    it("names a configured-but-inactive risk policy", async () => {
      const riskPolicyId = await seedRiskPolicy({ activate: false });
      const readiness = await evaluateLiveCommerceReadiness(NOW, {
        db,
        env: CONFIGURED(riskPolicyId),
      });
      /* Configured is not the same as governing. */
      expect(readiness.blockers).toContain("RISK_POLICY_NOT_ACTIVE");
      expect(readiness.blockers).not.toContain("RISK_POLICY_NOT_CONFIGURED");
    });

    it("clears every control a fixture can supply, and still refuses live mode", async () => {
      const riskPolicyId = await seedRiskPolicy();
      const readiness = await evaluateLiveCommerceReadiness(NOW, {
        db,
        env: CONFIGURED(riskPolicyId),
      });

      expect(readiness.satisfied).toEqual(
        expect.arrayContaining(["RISK_POLICY", "NOTIFICATION_DELIVERY", "REVERSAL_ACCOUNTING"]),
      );
      /* Phase 1.6 — a TEST tax adapter no longer counts as a satisfied tax
         control. A stub returning a plausible number is MORE dangerous than no
         engine, because its answers look calculated; and the registration and
         filing postures are decisions nobody has stated here.
         `CONFIGURED` deliberately still selects TEST_ZERO_RATE, so this asserts
         exactly that: a fixture cannot configure its way to live commerce. */
      expect(readiness.blockers).toEqual([
        "TAX_PROVIDER_NOT_PRODUCTION_CAPABLE",
        "TAX_REGISTRATION_CONFIGURATION_REQUIRED",
        /* Phase 1.8 — a recorder nothing runs is durable work nobody will ever
           process. The fixture declares no dispatcher secret and no schedule, so
           this is exactly the gap the phase exists to make visible. */
        "TAX_RECORDER_NOT_OPERATIONAL",
        "TAX_FILING_OR_REMITTANCE_CONFIGURATION_REQUIRED",
        /* Phase 1.9 — the same three shapes, for refunds.
         *
         * `REVERSAL_ACCOUNTING` above is SATISFIED and these are blockers, which
         * is exactly the distinction 1.9 added: 1.2's control asks whether the
         * reversal TABLE is reachable, and a deployment can pass it while being
         * wholly unable to return anybody's money. A marketplace that can take
         * live payments and cannot refund them is not launch-ready.
         *
         * The fixture configures no Stripe block, declares no refund-processor
         * secret or schedule, and selects TEST_ZERO_RATE — so all three fail, and
         * `REFUND_BACKLOG` is satisfied because an empty backlog is a healthy
         * one. */
        "REFUND_EXECUTION_NOT_CONFIGURED",
        "REFUND_PROCESSOR_NOT_OPERATIONAL",
        "TAX_REVERSAL_NOT_CONFIGURED",
        /* Phase 1.11 — disputes, and the two halves are deliberately separate.
         *
         * `DISPUTE_INTAKE_NOT_CONFIGURED` is a CONFIGURATION gap: the fixture
         * declares no Stripe block, so no dispute event could arrive. Configure
         * one and it clears.
         *
         * Phase 1.12 replaced the single unconditional
         * `DISPUTE_EVIDENCE_RESPONSE_NOT_IMPLEMENTED` with dimensions that fail
         * for different reasons, because building the adapter cleared the first
         * question without answering the rest. The governance blocker is GONE —
         * the §I ruling resolved it, and a readiness report claiming Monacado is
         * unauthorised to represent would now be false. What remains is
         * capability and configuration: `SUBMISSION_NOT_CONFIGURED` because the
         * fixture declares no Stripe block, and `PROVIDER_MODE_TEST_ONLY`,
         * `ASSEMBLY_INCOMPLETE`, `DOCUMENT_SUBMISSION_NOT_IMPLEMENTED`, and
         * `DEADLINE_MONITORING_NOT_IMPLEMENTED` reported BY CONSTRUCTION, exactly
         * as `LIVE_PROVIDER_NOT_ENABLED` is. That is still the point of the
         * control: a marketplace that records disputes and cannot fully answer
         * them loses every one it might have won, so a built and authorised port
         * must not read as chargeback readiness.
         *
         * `DISPUTE_WEBHOOK_NOT_VERIFIABLE` is absent because it is conditional
         * on intake being configured at all — one gap is reported once.
         * `DISPUTE_BACKLOG` is satisfied because an empty book is a healthy
         * one, on `REFUND_BACKLOG`'s terms. */
        "DISPUTE_INTAKE_NOT_CONFIGURED",
        "DISPUTE_EVIDENCE_SUBMISSION_NOT_CONFIGURED",
        "DISPUTE_PROVIDER_MODE_TEST_ONLY",
        "DISPUTE_EVIDENCE_ASSEMBLY_INCOMPLETE",
        "DISPUTE_EVIDENCE_DOCUMENT_SUBMISSION_NOT_IMPLEMENTED",
        "DISPUTE_DEADLINE_MONITORING_NOT_IMPLEMENTED",
        /* Phase 1.13 — clearable by activating governed review heuristics, which
           this fixture does not do. */
        "SELLER_RISK_REVIEW_POLICY_NOT_ACTIVE",
        /* Phase 1.14 split 1.13's single `SELLER_RISK_MITIGATION_NOT_IMPLEMENTED`
           into its two independent halves, because 1.14 built the mechanism and a
           combined code would now have to be either wrong or unclearable.
           
           The first reads the ACTIVE marketplace policy row, not the newest
           version shipped: this fixture activates 1.0.0, so shipping 1.3.0
           clears nothing — which is the distinction between writing terms and
           governing under them, and the reason the code exists at all. The second
           asks whether anybody actually holds the entitlement, since a governed
           authority nobody has is a capability on paper. */
        "PARTICIPANT_MITIGATION_POLICY_NOT_ACTIVE",
        "PARTICIPANT_MITIGATION_NOT_GRANTED",
        "LIVE_PROVIDER_NOT_ENABLED",
      ]);
      expect(readiness.satisfied).toContain("REFUND_BACKLOG");
      expect(readiness.satisfied).toContain("DISPUTE_BACKLOG");
      expect(readiness.satisfied).not.toContain("TAX_CALCULATION");
      expect(readiness.ready).toBe(false);
    });
  });

  // — 7 · transaction-time commerce readiness (Phase 1.3 correction) —

  /**
   * Two conditions checked per transaction rather than only at activation.
   *
   * They live in this suite because the fixtures a checkout needs — Product,
   * Storefront, Listing, commercial policy, risk policy, tax adapter — already
   * do. Phase 1.3's own suite owns the policy, acceptance, and verification
   * machinery; this owns what happens at the till.
   */
  describe("transaction-time commerce readiness", () => {
    const begin = (internalListingId: string, policyId: string, riskPolicyId: string) =>
      beginCheckout(
        CHECKOUT_INPUT(internalListingId),
        policyId,
        {
          provider: "STRIPE",
          port: initiationDouble(),
          taxPort: createZeroRateTaxAdapter(),
          riskPolicyId,
          buyerDetails: BUYER_DETAILS,
        },
        { ...deps(), taxIds, buyerSnapshotIds },
      );

    it("binds the exact ACTIVE policy version to the Order", async () => {
      const seller = await seedSellerDirect();
      const begun = await begin(
        seller.internalListingId,
        await seedCommercialPolicy(),
        await seedRiskPolicy(),
      );

      const row = await db.order.findUniqueOrThrow({
        where: { id: begun.order.orderId },
      });
      expect(row.marketplacePolicyId).toBe(MONACADO_MARKETPLACE_POLICY_ID);
      expect(row.marketplacePolicyVersion).toBe(MARKETPLACE_POLICY_VERSION_1);

      /* Which TERMS governed, alongside which FEES did. Two separate bindings,
         because they are two separate authorities. */
      expect(row.policyId).not.toBe(row.marketplacePolicyId);
    });

    it("refuses before an Order exists when no policy is ACTIVE", async () => {
      const seller = await seedSellerDirect();
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();

      /* Retirement with nothing to replace it. Commerce must stop rather than
         continue silently ungoverned.

         Restored in `finally` because retirement is one-way by design — a
         retired version cannot be reactivated, and leaving the shared shipped
         policy retired would break every later test in the file. */
      await db.marketplacePolicyVersionRow.updateMany({
        where: { policyId: MONACADO_MARKETPLACE_POLICY_ID, status: "ACTIVE" },
        data: { status: "RETIRED", activeMarker: null },
      });
      const before = await db.order.count();

      try {
        await expect(
          begin(seller.internalListingId, policyId, riskPolicyId),
        ).rejects.toBeInstanceOf(MarketplacePolicyUnavailableError);

        /* Nothing left behind: no Order, and no payment started. */
        expect(await db.order.count()).toBe(before);
      } finally {
        await db.marketplacePolicyVersionRow.updateMany({
          where: { policyId: MONACADO_MARKETPLACE_POLICY_ID, status: "RETIRED" },
          data: {
            status: "ACTIVE",
            activeMarker: MONACADO_MARKETPLACE_POLICY_ID,
            retiredAt: null,
          },
        });
      }
    });

    it("refuses before an Order exists when the seller has no usable contact", async () => {
      const seller = await seedSellerDirect();
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();

      /* A mailbox that worked at activation and stopped working afterwards —
         the case an activation-only check cannot catch. */
      await degradeEmailContact(
        {
          participantId: seller.participantId,
          purpose: "PRIMARY_PROFILE",
          to: "DELIVERY_FAILED",
          at: CHECKOUT_AT,
        },
        { db },
      );
      const before = await db.order.count();

      await expect(
        begin(seller.internalListingId, policyId, riskPolicyId),
      ).rejects.toBeInstanceOf(SellerSupportContactUnavailableError);

      expect(await db.order.count()).toBe(before);
    });

    it("sells through a verified dedicated address, and still sells when it degrades", async () => {
      const seller = await seedSellerDirect();
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();

      await upsertEmailContact(
        {
          participantId: seller.participantId,
          purpose: "DEDICATED_SUPPORT",
          address: `p12t-help-${next()}@example.invalid`,
          now: NOW,
        },
        { db },
      );
      const issued = await issueVerificationChallenge(
        {
          participantId: seller.participantId,
          purpose: "DEDICATED_SUPPORT",
          address: (await db.participantEmailContact.findFirstOrThrow({
            where: { participantId: seller.participantId, purpose: "DEDICATED_SUPPORT" },
          })).address!,
          issuedAt: NOW,
        },
        { db },
      );
      await consumeVerificationChallenge({ token: issued.token, at: NOW }, { db });

      const first = await begin(seller.internalListingId, policyId, riskPolicyId);
      expect(first.order.orderId).toBeTruthy();

      /* The dedicated address fails; the verified primary is still there, so
         sales continue. Falling back beats stopping a working seller. */
      await degradeEmailContact(
        {
          participantId: seller.participantId,
          purpose: "DEDICATED_SUPPORT",
          to: "DELIVERY_FAILED",
          at: CHECKOUT_AT,
        },
        { db },
      );
      const second = await begin(seller.internalListingId, policyId, riskPolicyId);
      expect(second.order.orderId).not.toBe(first.order.orderId);
    });

    it("asks the canonical resolver rather than reimplementing precedence", () => {
      const source = readFileSync(
        new URL("../src/server/payments/executable-checkout-service.ts", import.meta.url),
        "utf8",
      ).replace(/\/\*[\s\S]*?\*\//g, "");

      /* Checkout goes through the ONE canonical resolver.
       *
       * Phase 1.9's historical-receipt correction changed which entry point it
       * calls — from the yes/no `hasUsableSupportContactIn` to
       * `resolveSellerSupportContactIn`, whose answer it now KEEPS, because a
       * receipt must record which contact the buyer was actually told about and
       * that cannot be reconstructed from a seller who has since changed it.
       *
       * What this test is really about is unchanged and is the second half
       * below: checkout must not REIMPLEMENT the precedence. Learning the
       * address through the canonical resolver is not a second copy of the rule;
       * deciding between a dedicated and a primary contact here would be. */
      expect(source).toContain("SellerSupportContactIn");
      for (const leak of ["DEDICATED_SUPPORT", "PRIMARY_PROFILE", "resolveEffectiveSupportContact"]) {
        expect(source, leak).not.toContain(leak);
      }
    });

    it("reads a pre-1.3 Order as historical and unbound", async () => {
      const seller = await seedSellerDirect();
      const begun = await begin(
        seller.internalListingId,
        await seedCommercialPolicy(),
        await seedRiskPolicy(),
      );

      /* An Order written before the columns existed. */
      await db.order.update({
        where: { id: begun.order.orderId },
        data: { marketplacePolicyId: null, marketplacePolicyVersion: null },
      });

      const view = await readOrderPolicyView(begun.order.orderId, { db });
      /* Reported as unbound rather than shown today's terms: a substituted
         version would look authoritative and be wrong. */
      expect(view.policyVersion).toBeNull();
      expect(view.buyerSections).toEqual([]);
      /* The commercial policy binding is untouched — this phase invented no
         history and removed none. */
      expect(view.commercialPolicy.policyId).toBe(begun.order.policyId);
      /* And support still resolves, because that is a CURRENT question. */
      expect(view.sellerSupportContact.available).toBe(true);
    });
  });
});
