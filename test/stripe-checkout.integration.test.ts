/**
 * Executable checkout integration tests (Phase 1.0).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * **NO NETWORK AND NO STRIPE ACCOUNT.** Both provider ports are injected doubles
 * standing exactly where the Stripe adapters stand — the adapters' own
 * translation, including real signature verification, is proved in
 * `stripe-checkout-contracts.test.ts`. What this suite proves is the thing only a
 * database can show: that the executable flow reaches `0M.9`'s write path, that
 * it reaches it **once**, and that a failure reaches none of it.
 *
 * **Test isolation.** Every identifier carries the `P10T` opaque prefix and every
 * account address the `stripe-checkout-` local part, and every delete is filtered
 * by one of those. No `deleteMany({})` appears anywhere.
 *
 * Fixtures follow `buyer-checkout-and-order.integration.test.ts` deliberately:
 * the same seeds, the same forced-ACTIVE technique, the same governed commerce
 * approval. This phase changed no part of what makes a Listing sellable, and a
 * second way of building one would be a second thing to keep true.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ensureShippedMarketplacePolicyActive,
  verifyPrimarySupportContact,
} from "./support/marketplace-policy-fixture";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import { createDraftOffer } from "../src/server/marketplace/offer-service";
import { grantAccountEntitlement } from "../src/server/account/account-entitlement-service";
import { recordCommerceApproval } from "../src/server/marketplace/participant-commerce-approval-service";
import type { CommerceApprovalIdProvider } from "../src/server/marketplace/participant-commerce-approval-ids";
import {
  createPromotedListing,
  createSellerDirectListing,
} from "../src/server/marketplace/listing-service";
import {
  activateCommercialPolicyVersion,
  createCommercialPolicy,
  recordCommercialPolicyVersion,
} from "../src/server/marketplace/commercial-policy-service";
import type { CommercialPolicyIdProvider } from "../src/server/marketplace/commercial-policy-ids";
import {
  getOrder,
  listProceedsObligations,
} from "../src/server/marketplace/order-service";
import { PaymentResultConflictError } from "../src/server/marketplace/order-errors";
import type { OrderIdProvider } from "../src/server/marketplace/order-ids";
import type { GuestClaimCodeProvider } from "../src/server/marketplace/guest-claim-code";
import type { OutboundEmailIdProvider } from "../src/server/notifications/outbound-email-ids";
import { createCapturingMailAdapter } from "../src/server/notifications/mail-port";
import { hashGuestClaimCode } from "../src/server/marketplace/guest-claim-code";
import type { ParticipantIdProvider } from "../src/server/marketplace/participant-ids";
import type {
  BuyerPaymentConfirmation,
  BuyerPaymentInitiationPort,
  BuyerPaymentRequest,
} from "../src/contracts/marketplace/buyer-payment";
import {
  beginCheckout,
  finalizeConfirmedPayment,
} from "../src/server/payments/executable-checkout-service";
import { handleStripeWebhookRequest } from "../src/server/payments/stripe-webhook-route-handler";
import { handleOrderStatusRequest } from "../src/server/payments/order-status-route-handler";
import { handleBeginCheckoutRequest } from "../src/server/payments/checkout-route-handler";
import { GUEST_CLAIM_COOKIE_NAME } from "../src/server/payments/checkout-route-handler";
import { readListingCheckoutView } from "../src/server/payments/listing-checkout-view";
import { createZeroRateTaxAdapter } from "../src/server/tax/tax-adapters";
import type { TaxEvidenceIdProvider } from "../src/server/tax/tax-calculation-ids";
import {
  activateRiskPolicyVersion,
  createRiskPolicy,
  recordRiskPolicyVersion,
} from "../src/server/risk/risk-policy-service";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const TAG = "P10T";
const PRODUCT_TAG = "P10TPR0D";
const PRODUCT_PREFIX = `mon:product:${PRODUCT_TAG}`;
const ACCOUNT_EMAIL_PREFIX = "stripe-checkout-";
const PASSWORD = "correct-horse-battery-staple-1-0";

const NOW = "2028-01-05T09:00:00.000Z";
const CHECKOUT_AT = "2028-02-01T12:00:00.000Z";
const CONFIRMED_AT = "2028-02-01T12:00:07.000Z";

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const ACTOR = `mon:actor:${pad26("P10TACT0R")}`;
const RECORDER = `mon:acct:${pad26("P10TREC0RDER")}`;

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

const approvalIds: CommerceApprovalIdProvider = {
  nextCommerceApprovalId: () => `mon:pcap:${pad26(`${TAG}PCAP${next()}`)}`,
};

const claimCodes: GuestClaimCodeProvider = {
  nextGuestClaimCode: () => `${TAG}-guest-claim-${next()}`.padEnd(43, "x").slice(0, 43),
};

/* Phase 1.5 — the webhook now commits durable OutboundEmailDelivery rows and
   attempts them immediately, instead of sending once with no retry path. */
const deliveryIds: OutboundEmailIdProvider = {
  nextOutboundDeliveryId: () => `mon:oeml:${pad26(`${TAG}0EML${next()}`)}`,
  nextSuppressionId: () => `mon:esup:${pad26(`${TAG}ESUP${next()}`)}`,
  nextProviderEventId: () => `mon:pevt:${pad26(`${TAG}PEVT${next()}`)}`,
  nextMessageDiscriminator: () => pad26(`${TAG}DISC${next()}`),
  nextLockToken: () => `lock${next()}`.padEnd(32, "0"),
};

const taxIds: TaxEvidenceIdProvider = {
  nextTaxEvidenceId: () => `mon:taxe:${pad26(`P10TTAXE${next()}`)}`,
};

const riskIds = {
  nextRiskPolicyId: () => `mon:rpol:${pad26(`P10TRP0L${next()}`)}`,
};

const policyIds: CommercialPolicyIdProvider = {
  nextPolicyId: () => `mon:cpol:${pad26(`${TAG}P0L${next()}`)}`,
};

const BUYER_DETAILS = {
  name: "Synthetic Buyer",
  email: "p10t-buyer@example.test",
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
  nextBuyerSnapshotId: () => `mon:obsn:${pad26(`P10T0BSN${next()}`)}`,
};

/**
 * The buyer fields every checkout now requires (Phase 1.2 correction).
 *
 * Completing a purchase is not anonymous. These fixtures buy DIGITAL products,
 * so no delivery address is sent — and none is asked for.
 */
const CHECKOUT_FORM_FIELDS = {
  buyerName: "Synthetic Buyer",
  buyerEmail: "p10t-buyer@example.test",
  billingLine1: "1 Test Street",
  billingCity: "Testville",
  billingRegion: "CA",
  billingPostalCode: "94000",
  billingCountryCode: "US",
  /* Phase 1.6 — a ship-to address is required for every purchase because it is
     the tax destination. This is the ordinary retail path: one box, and billing
     is copied in rather than typed twice. */
  shipToSameAsBilling: "true",
} as const;

const checkoutForm = (internalListingId: string): string =>
  new URLSearchParams({ internalListingId, ...CHECKOUT_FORM_FIELDS }).toString();

const deps = () => ({ db, ids: orderIds, notificationIds, claimCodes });

// — The provider doubles —

/**
 * An initiation port standing exactly where the Stripe adapter stands.
 *
 * It records what Monacado asked for, so a test can assert the **amount** and the
 * **idempotency key** that reached the provider boundary, and it is idempotent on
 * that key exactly as the real adapter is — Stripe's `Idempotency-Key` header
 * gives one Order one Checkout Session.
 */
function initiationDouble(): BuyerPaymentInitiationPort & {
  requests: BuyerPaymentRequest[];
} {
  const requests: BuyerPaymentRequest[] = [];
  const byKey = new Map<string, string>();
  return {
    requests,
    async initiatePayment(request) {
      requests.push(request);
      let sessionId = byKey.get(request.idempotencyKey);
      if (sessionId === undefined) {
        sessionId = `cs_test_${pad26(`${TAG}SESS${next()}`)}`;
        byKey.set(request.idempotencyKey, sessionId);
      }
      return {
        orderId: request.orderId,
        provider: "STRIPE",
        status: "REQUIRES_BUYER_ACTION",
        providerPaymentRef: sessionId,
        buyerActionUrl: `https://checkout.stripe.com/c/pay/${sessionId}`,
      };
    },
  };
}

/** What a verified Stripe delivery becomes by the time it reaches the service. */
const succeeded = (
  orderId: string,
  intentRef: string,
  buyerEmail: string | null = null,
): BuyerPaymentConfirmation => ({
  disposition: "PAYMENT_RESULT",
  orderId,
  provider: "STRIPE",
  buyerContact: buyerEmail === null ? null : { email: buyerEmail },
  result: { outcome: "SUCCEEDED", provider: "STRIPE", providerTransactionRef: intentRef },
  confirmedDetails: null,
  providerEventRef: `evt_${pad26(`${TAG}EVT${next()}`)}`,
  observedAt: CONFIRMED_AT,
});

const failed = (
  orderId: string,
  buyerEmail: string | null = null,
): BuyerPaymentConfirmation => ({
  disposition: "PAYMENT_RESULT",
  orderId,
  provider: "STRIPE",
  buyerContact: buyerEmail === null ? null : { email: buyerEmail },
  result: { outcome: "FAILED", failureCode: "DECLINED" },
  confirmedDetails: null,
  providerEventRef: `evt_${pad26(`${TAG}EVT${next()}`)}`,
  observedAt: CONFIRMED_AT,
});

/** Stripe's authoritative statement that a hosted session can no longer complete. */
const abandoned = (
  orderId: string,
  buyerEmail: string | null = null,
): BuyerPaymentConfirmation => ({
  disposition: "ABANDONED",
  orderId,
  provider: "STRIPE",
  buyerContact: buyerEmail === null ? null : { email: buyerEmail },
  confirmedDetails: null,
  providerEventRef: `evt_${pad26(`${TAG}EVT${next()}`)}`,
  observedAt: CONFIRMED_AT,
});

/** A confirmation port that hands back one scripted confirmation, always. */
const confirmationDouble = (confirmation: BuyerPaymentConfirmation | null) => ({
  async confirmPayment() {
    return confirmation;
  },
});

// — Cleanup —

/**
 * Delete only what this suite created, child to parent.
 *
 * Orders are gathered **two ways**: by this suite's `P10T` id prefix, and by the
 * Listings this suite seeded. The second is not redundant — the route tests can
 * be driven with the repository's real crypto id provider, and an Order whose id
 * this suite cannot predict still holds a foreign key onto a Listing version this
 * suite is about to delete. Cleaning by prefix alone would leave that row and
 * every later run would fail on the constraint rather than on a real defect.
 */
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
    /* Delivery evidence first: it holds RESTRICT keys onto the obligation and
       the participant that are deleted further down. */
    await db.notificationDelivery.deleteMany({
      where: { subjectKind: "ORDER", subjectRef: { in: orderIdList } },
    });
    /* Phase 1.5 — durable outbound email holds a RESTRICT key onto the
       obligation deleted further down. */
    await db.outboundEmailDelivery.deleteMany({
      where: { subjectKind: "ORDER", subjectRef: { in: orderIdList } },
    });
    /* Phase 1.2 evidence holds RESTRICT keys onto the Order and the snapshot. */
    await db.transactionReversal.deleteMany({ where: { orderId: { in: orderIdList } } });
    /* Tax evidence points at the buyer snapshot, which points at the Order —
       both RESTRICT, so they come off in that order. */
    await db.orderTaxEvidence.deleteMany({ where: { orderId: { in: orderIdList } } });
    await db.orderBuyerSnapshot.deleteMany({ where: { orderId: { in: orderIdList } } });
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
    await db.participantCommerceApproval.deleteMany({
      where: { participantId: { in: participantIds } },
    });
    await db.listingSourceRecordVersionRow.deleteMany({
      where: { controllingParticipantId: { in: participantIds } },
    });
    await db.listing.deleteMany({ where: { internalListingId: { in: listingIds } } });
    await db.offerSourceRecordVersionRow.deleteMany({
      where: { sellerParticipantId: { in: participantIds } },
    });
    await db.offer.deleteMany({ where: { sellerParticipantId: { in: participantIds } } });
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

  const ownPolicies = { startsWith: `mon:cpol:${TAG}` };
  await db.commercialPolicyVersionRow.deleteMany({ where: { policyId: ownPolicies } });
  await db.commercialPolicy.deleteMany({ where: { id: ownPolicies } });

  const ownRiskPolicies = { startsWith: `mon:rpol:${TAG}` };
  await db.riskPolicyVersionRow.deleteMany({ where: { policyId: ownRiskPolicies } });
  await db.riskPolicy.deleteMany({ where: { id: ownRiskPolicies } });

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


async function seedProduct(
  deliveryMode: "DIGITAL" | "PHYSICAL" = "DIGITAL",
): Promise<string> {
  const n = next();
  const internalProductId = `${PRODUCT_PREFIX}${pad26(String(n)).slice(0, 26 - PRODUCT_TAG.length)}`;
  const sourceRecordId = `mon:srec:${pad26(`P10TPSREC${n}`)}`;
  await db.product.create({
    data: {
      internalProductId,
      sourceRecordId,
      currentSourceRecordVersion: "1",
      recordStatus: "DRAFT",
    },
  });
  await seedProductVersion(internalProductId, sourceRecordId, deliveryMode);
  return internalProductId;
}

async function seedAccount(): Promise<string> {
  const n = next();
  const account = await createAccount(
    {
      name: "Synthetic Buyer",
      email: `${ACCOUNT_EMAIL_PREFIX}${n}@example.com`,
      password: PASSWORD,
      createdAt: NOW,
    },
    { db },
  );
  return account.accountId;
}

async function seedActiveParticipant(roles: Array<"SELLER" | "PROMOTER">) {
  const accountId = await seedAccount();
  const snapshot = await createDraftParticipant({ accountId, initialRoles: roles, now: NOW }, { db });
  const participantId = snapshot.participant.participantId;
  await db.marketplaceParticipant.update({ where: { id: participantId }, data: { status: "ACTIVE" } });
  await db.marketplaceRoleAssignment.updateMany({ where: { participantId }, data: { status: "ACTIVE" } });
  /* Phase 1.3 correction — checkout refuses a sale for a seller nobody can
     reach. These participants are made ACTIVE by direct update rather than
     through review, so the contact is verified here through the real challenge
     flow. Records no acceptance: that is an activation prerequisite. */
  await verifyPrimarySupportContact(db, { participantId, accountId, now: NOW });
  return { participantId, accountId };
}

async function seedStorefront(ownerParticipantId: string): Promise<string> {
  const n = next();
  const internalStorefrontId = `mon:storefront:${pad26(`P10TST0RE${n}`)}`;
  await db.storefront.create({
    data: {
      internalStorefrontId,
      storefrontSourceRecordId: `mon:srec:${pad26(`P10TSFSREC${n}`)}`,
      currentSourceRecordVersion: "1",
      ownerParticipantId,
      publicHandle: `p10t-shop-${n}`,
      lifecycle: "ACTIVE",
      visibility: "PUBLIC",
    },
  });
  return internalStorefrontId;
}

async function approveCommerce(participantId: string) {
  const actingAccountId = await seedAccount();
  await grantAccountEntitlement(
    { accountId: actingAccountId, capability: "participant:commerce-approve", grantedAt: NOW },
    { db },
  );
  return recordCommerceApproval(
    {
      participantId,
      decision: "APPROVED",
      reasonCode: "REQUIREMENTS_MET",
      actingAccountId,
      decidedAt: NOW,
    },
    { db, ids: approvalIds },
  );
}

/** A commercial policy with one ACTIVE version at the standard 7.5% + $1.00. */
async function seedPolicy(): Promise<string> {
  const policy = await createCommercialPolicy({ label: `P10T policy ${next()}`, now: NOW }, {
    db,
    ids: policyIds,
  });
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

/**
 * A risk policy with one ACTIVE version, permissive enough not to interfere.
 *
 * Phase 1.2 made the gate mandatory, so every checkout in these suites needs one.
 * The ceiling is deliberately far above any fixture amount and both participant
 * requirements are off — this suite is not testing the gate, and a policy that
 * denied here would be testing 1.2 by breaking 1.0 and 1.1.
 */
async function seedRiskPolicy(): Promise<string> {
  const policy = await createRiskPolicy(
    { label: `risk ${next()}`, now: NOW },
    { db, ids: riskIds },
  );
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

async function forceListingActive(internalListingId: string): Promise<void> {
  const listing = await db.listing.findUniqueOrThrow({ where: { internalListingId } });
  await db.listing.update({ where: { internalListingId }, data: { lifecycle: "ACTIVE" } });
  await db.listingSourceRecordVersionRow.updateMany({
    where: { listingSourceRecordId: listing.listingSourceRecordId },
    data: { lifecycle: "ACTIVE" },
  });
}

/** A purchasable seller-direct Listing at $100.00. */
async function seedSellerDirect() {
  const seller = await seedActiveParticipant(["SELLER"]);
  const internalProductId = await seedProduct();
  const storefrontId = await seedStorefront(seller.participantId);
  const snapshot = await createSellerDirectListing(
    {
      storefrontId,
      internalProductId,
      controllingParticipantId: seller.participantId,
      retail: { retailPriceMinorUnits: 10_000, retailPriceCurrency: "USD" },
      sale: null,
      actingAccountId: seller.accountId,
      authorizedByActorId: ACTOR,
      now: NOW,
    },
    { db },
  );
  await forceListingActive(snapshot.record.internalListingId);
  await approveCommerce(seller.participantId);
  return { seller, internalProductId, listing: snapshot };
}

const ACQUISITION_POLICY = {
  policyId: `mon:cpol:${pad26("P10TSUPPL0ED")}`,
  policyVersion: "1",
  currency: "USD",
  retainedPercentageBasisPoints: 750,
  retainedFixedAmountMinorUnits: 100,
  roundingPolicy: "HALF_UP_TO_MINOR_UNIT" as const,
};

/** $100.00 retail over a $50.00 Offer at 20% seller-funded commission. */
async function seedPromoted() {
  const seller = await seedActiveParticipant(["SELLER"]);
  const promoter = await seedActiveParticipant(["PROMOTER"]);
  const internalProductId = await seedProduct();
  const storefrontId = await seedStorefront(promoter.participantId);

  const offer = await createDraftOffer(
    {
      internalProductId,
      sellerParticipantId: seller.participantId,
      terms: {
        price: { type: "PAID", wholesalePriceMinorUnits: 5_000, wholesalePriceCurrency: "USD" },
        promotion: {
          type: "PROMOTABLE",
          commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2_000 },
        },
      },
      actingAccountId: seller.accountId,
      authorizedByActorId: ACTOR,
      hasProductAuthority: true,
      now: NOW,
    },
    { db },
  );
  await db.offerSourceRecordVersionRow.updateMany({
    where: { offerSourceRecordId: offer.record.offerSourceRecordId },
    data: { lifecycle: "ACTIVE", availability: "AVAILABLE" },
  });

  const listing = await createPromotedListing(
    {
      storefrontId,
      internalProductId,
      controllingParticipantId: promoter.participantId,
      retail: { retailPriceMinorUnits: 10_000, retailPriceCurrency: "USD" },
      acceptedOfferSourceRecordId: offer.record.offerSourceRecordId,
      acceptedOfferSourceRecordVersion: "1",
      acquisitionPolicy: ACQUISITION_POLICY,
      actingAccountId: promoter.accountId,
      authorizedByActorId: ACTOR,
      now: NOW,
    },
    { db },
  );
  await forceListingActive(listing.record.internalListingId);
  await approveCommerce(promoter.participantId);
  return { seller, promoter, listing };
}

const CHECKOUT_INPUT = (internalListingId: string, buyerAccountId: string | null) => ({
  internalListingId,
  buyerAccountId,
  taxAmountMinorUnits: 0,
  shippingAmountMinorUnits: 0,
  otherPassThroughAmountMinorUnits: 0,
  currency: "USD" as const,
  productAvailability: "available" as const,
  placedAt: CHECKOUT_AT,
});

/** Begin a checkout through the service, with a scripted initiation port. */
async function begin(internalListingId: string, policyId: string, buyerAccountId: string | null) {
  const port = initiationDouble();
  const begun = await beginCheckout(
    CHECKOUT_INPUT(internalListingId, buyerAccountId),
    policyId,
    {
      provider: "STRIPE",
      port,
      taxPort: createZeroRateTaxAdapter(),
      riskPolicyId: await seedRiskPolicy(),
      buyerDetails: BUYER_DETAILS,
    },
    { ...deps(), taxIds, buyerSnapshotIds },
  );
  return { begun, port };
}

/**
 * Drive the real webhook route with a scripted confirmation.
 *
 * A capturing mail adapter is injected so Phase 1.1's notice dispatch runs
 * without a provider and writes rows this suite can clean up. These 1.0 tests
 * assert nothing about delivery — that is `order-expiry-and-notification`'s
 * subject — but the dispatch must still execute, because a phase that broke it
 * should fail here too.
 */
const webhook = (confirmation: BuyerPaymentConfirmation | null) =>
  handleStripeWebhookRequest(
    { rawBody: "{}", signatureHeader: "t=1,v1=irrelevant-the-port-is-injected" },
    {
      db,
      port: confirmationDouble(confirmation),
      mail: createCapturingMailAdapter(),
      deliveryIds,
      now: () => CONFIRMED_AT,
    },
  );

const describeDb = RUN ? describe : describe.skip;

describeDb("1.0 — executable checkout, Stripe-confirmed", () => {
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

  // — 1 —

  describe("guest checkout", () => {
    it("runs the whole flow without creating an account or a participant", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();

      const accountsBefore = await db.account.count();
      const participantsBefore = await db.marketplaceParticipant.count();

      const { begun, port } = await begin(listing.record.internalListingId, policyId, null);

      /* The Order is durable BEFORE the provider is contacted — 0M.9's ordering,
         which is what makes a dead process recoverable. */
      expect(begun.order.lifecycle).toBe("PENDING_PAYMENT");
      expect(begun.order.buyer.buyerKind).toBe("GUEST_BUYER");
      expect(begun.guestClaimCode).not.toBeNull();
      expect(begun.buyerTotalMinorUnits).toBe(10_000);

      /* Monacado priced it; Stripe was told the total and the Order's key. */
      expect(port.requests).toHaveLength(1);
      expect(port.requests[0]!.amountMinorUnits).toBe(10_000);
      expect(port.requests[0]!.idempotencyKey).toBe(begun.order.orderId);
      expect(port.requests[0]!.currency).toBe("USD");

      const response = await webhook(succeeded(begun.order.orderId, `pi_${pad26(`${TAG}PI1`)}`));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ handled: true, disposition: "SALE_RECORDED" });

      const order = await getOrder(begun.order.orderId, deps());
      expect(order.lifecycle).toBe("PAID");
      expect(order.buyer.buyerKind).toBe("GUEST_BUYER");

      /* 0M.9's promise, still true through a real payment path: a guest
         purchase creates NEITHER. */
      expect(await db.account.count()).toBe(accountsBefore);
      expect(await db.marketplaceParticipant.count()).toBe(participantsBefore);
    });

    it("stores only the digest of the claim code it handed back", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const { begun } = await begin(listing.record.internalListingId, policyId, null);

      const row = await db.order.findUniqueOrThrow({ where: { id: begun.order.orderId } });
      expect(row.guestClaimCodeDigest).toBe(hashGuestClaimCode(begun.guestClaimCode!));
      expect(row.guestClaimCodeDigest).not.toBe(begun.guestClaimCode);
    });
  });

  // — 2 —

  describe("authenticated checkout", () => {
    it("binds the Order to the account without requiring a participant", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const buyerAccountId = await seedAccount();

      const { begun } = await begin(listing.record.internalListingId, policyId, buyerAccountId);
      expect(begun.order.buyer.buyerKind).toBe("ACCOUNT_BUYER");
      /* Buying requires no participant; those gate SELLING. */
      expect(
        begun.order.buyer.buyerKind === "ACCOUNT_BUYER"
          ? begun.order.buyer.buyerParticipantId
          : "unreachable",
      ).toBeNull();
      /* An account buyer gets no claim code — there is nothing to claim. */
      expect(begun.guestClaimCode).toBeNull();

      const response = await webhook(succeeded(begun.order.orderId, `pi_${pad26(`${TAG}PI2`)}`));
      expect(response.status).toBe(200);
      expect((await getOrder(begun.order.orderId, deps())).lifecycle).toBe("PAID");
    });
  });

  // — 3 —

  describe("Monacado's economics are untouched by the payment provider", () => {
    it("keeps the promoted worked example exactly as 0M.9 recorded it", async () => {
      const { seller, promoter, listing } = await seedPromoted();
      const policyId = await seedPolicy();

      const { begun, port } = await begin(listing.record.internalListingId, policyId, null);
      /* Stripe is told the BUYER TOTAL and nothing about the split. */
      expect(port.requests[0]!.amountMinorUnits).toBe(10_000);
      expect(Object.keys(port.requests[0]!).sort()).toEqual([
        "amountMinorUnits",
        /* Phase 1.2 — an instruction about what the PROVIDER must collect, not a
           fact about the buyer. It carries no address, name, or contact, and the
           point of this assertion is unchanged: nothing about the commercial
           split crosses this boundary. */
        "collectShippingAddress",
        "currency",
        "idempotencyKey",
        "orderId",
        "provider",
      ]);

      const intentRef = `pi_${pad26(`${TAG}PI3`)}`;
      await webhook(succeeded(begun.order.orderId, intentRef));

      const snapshot = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { orderId: begun.order.orderId },
        include: { settlement: true },
      });

      /* $100.00 retail, $50.00 wholesale, 20% commission — MONACADO_MOR §D. */
      expect(Number(snapshot.monacadoRetainedAmountMinorUnits)).toBe(850);

      const obligations = await listProceedsObligations(snapshot.id, deps());
      const byParty = Object.fromEntries(obligations.map((o) => [o.party, o]));
      expect(byParty.SELLER!.amountMinorUnits).toBe(4_000);
      expect(byParty.PROMOTER!.amountMinorUnits).toBe(5_150);
      expect(byParty.SELLER!.participantId).toBe(seller.participantId);
      expect(byParty.PROMOTER!.participantId).toBe(promoter.participantId);
      expect(
        850 + byParty.SELLER!.amountMinorUnits + byParty.PROMOTER!.amountMinorUnits,
      ).toBe(10_000);

      /* Stripe's reference is evidence on the settlement row, never an input to
         any of the figures above. */
      expect(snapshot.settlement?.providerTransactionRef).toBe(intentRef);
      expect(snapshot.settlement?.provider).toBe("STRIPE");
    });
  });

  // — 4 —

  describe("a repeated Stripe event changes nothing", () => {
    it("creates no second snapshot, obligation, evidence, notice, or PAID transition", async () => {
      const { listing } = await seedPromoted();
      const policyId = await seedPolicy();
      const { begun } = await begin(listing.record.internalListingId, policyId, null);
      const intentRef = `pi_${pad26(`${TAG}PI4`)}`;

      const first = await webhook(succeeded(begun.order.orderId, intentRef));
      expect(first.body).toMatchObject({ disposition: "SALE_RECORDED" });

      const after = async () => ({
        snapshots: await db.transactionEconomicSnapshot.count({
          where: { orderId: begun.order.orderId },
        }),
        settlements: await db.transactionSettlement.count({
          where: { snapshot: { orderId: begun.order.orderId } },
        }),
        obligations: await db.proceedsObligation.count({
          where: { snapshot: { orderId: begun.order.orderId } },
        }),
        evidence: await db.purchaseEvidence.count({ where: { orderId: begun.order.orderId } }),
        notices: await db.notificationObligation.count({
          where: { subjectRef: begun.order.orderId },
        }),
        authorities: await db.reviewSubmissionAuthority.count({
          where: { orderId: begun.order.orderId },
        }),
      });
      const once = await after();
      expect(once).toEqual({
        snapshots: 1,
        settlements: 1,
        obligations: 2,
        evidence: 1,
        notices: 2,
        authorities: 0,
      });

      /* Deliver it twice more. At-least-once is assumed, not hoped for. */
      for (const _ of [1, 2]) {
        const replay = await webhook(succeeded(begun.order.orderId, intentRef));
        expect(replay.status).toBe(200);
        expect(replay.body).toMatchObject({
          handled: true,
          disposition: "ALREADY_RECORDED",
          lifecycle: "PAID",
        });
      }
      expect(await after()).toEqual(once);

      const paidAt = (await db.order.findUniqueOrThrow({ where: { id: begun.order.orderId } }))
        .paidAt;
      expect(paidAt?.toISOString()).toBe(CONFIRMED_AT);
    });

    it("refuses a DIFFERENT provider transaction against a paid Order", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const { begun } = await begin(listing.record.internalListingId, policyId, null);

      await webhook(succeeded(begun.order.orderId, `pi_${pad26(`${TAG}PIA`)}`));

      /* Not an ordinary replay: the buyer may have been charged twice, and
         recording it as one would bury the only fact worth surfacing. */
      await expect(
        finalizeConfirmedPayment(succeeded(begun.order.orderId, `pi_${pad26(`${TAG}PIB`)}`), {
          db,
        }),
      ).rejects.toBeInstanceOf(PaymentResultConflictError);

      const conflicting = await webhook(
        succeeded(begun.order.orderId, `pi_${pad26(`${TAG}PIC`)}`),
      );
      expect(conflicting.status).toBe(409);
      expect(conflicting.body).toEqual({ error: "PAYMENT_RESULT_CONFLICT" });

      expect(
        await db.transactionEconomicSnapshot.count({ where: { orderId: begun.order.orderId } }),
      ).toBe(1);
    });

    it("treats a redelivered failure as already recorded rather than an invalid transition", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const { begun } = await begin(listing.record.internalListingId, policyId, null);

      const first = await webhook(failed(begun.order.orderId));
      expect(first.body).toMatchObject({ disposition: "FAILURE_RECORDED" });

      const replay = await webhook(failed(begun.order.orderId));
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ disposition: "ALREADY_RECORDED" });
    });
  });

  // — 5 —

  describe("a failed payment leaves no completed-sale economics", () => {
    it("creates no snapshot, obligation, evidence, or review authority", async () => {
      const { listing } = await seedPromoted();
      const policyId = await seedPolicy();
      const { begun } = await begin(listing.record.internalListingId, policyId, null);

      const response = await webhook(failed(begun.order.orderId));
      expect(response.status).toBe(200);

      const order = await getOrder(begun.order.orderId, deps());
      expect(order.lifecycle).toBe("PAYMENT_FAILED");
      expect(order.paymentFailureCode).toBe("DECLINED");

      expect(
        await db.transactionEconomicSnapshot.count({ where: { orderId: begun.order.orderId } }),
      ).toBe(0);
      expect(await db.purchaseEvidence.count({ where: { orderId: begun.order.orderId } })).toBe(0);
      expect(
        await db.proceedsObligation.count({
          where: { snapshot: { orderId: begun.order.orderId } },
        }),
      ).toBe(0);
      expect(
        await db.reviewSubmissionAuthority.count({ where: { orderId: begun.order.orderId } }),
      ).toBe(0);
    });

    it("never lets a failed Order become paid — a retry is a new Order", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const { begun } = await begin(listing.record.internalListingId, policyId, null);

      await webhook(failed(begun.order.orderId));
      const late = await webhook(succeeded(begun.order.orderId, `pi_${pad26(`${TAG}PID`)}`));
      expect(late.status).toBe(409);
      expect((await getOrder(begun.order.orderId, deps())).lifecycle).toBe("PAYMENT_FAILED");
    });
  });

  // — 6 —

  describe("the browser cannot assert payment success", () => {
    it("leaves an Order PENDING_PAYMENT no matter what the buyer's return page is asked", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const { begun } = await begin(listing.record.internalListingId, policyId, null);

      /* Every shape a client might try. None is a parameter the route accepts,
         and the Order does not move. */
      for (const query of [
        `orderId=${encodeURIComponent(begun.order.orderId)}`,
        `orderId=${encodeURIComponent(begun.order.orderId)}&paid=true`,
        `orderId=${encodeURIComponent(begun.order.orderId)}&lifecycle=PAID`,
        `orderId=${encodeURIComponent(begun.order.orderId)}&outcome=SUCCEEDED&providerTransactionRef=pi_forged`,
      ]) {
        const result = await handleOrderStatusRequest(new URLSearchParams(query), { db });
        expect(result.status).toBe(200);
        expect(result.body).toEqual({
          orderId: begun.order.orderId,
          lifecycle: "PENDING_PAYMENT",
          currency: "USD",
          buyerTotalMinorUnits: 10_000,
          paymentFailureCode: null,
        });
      }

      expect((await getOrder(begun.order.orderId, deps())).lifecycle).toBe("PENDING_PAYMENT");
      expect(
        await db.transactionEconomicSnapshot.count({ where: { orderId: begun.order.orderId } }),
      ).toBe(0);
    });

    it("answers a wrong order id and an unknown one identically", async () => {
      const unknown = await handleOrderStatusRequest(
        new URLSearchParams({ orderId: `mon:order:${pad26(`${TAG}N0SUCH`)}` }),
        { db },
      );
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual({ error: "ORDER_NOT_FOUND" });

      const malformed = await handleOrderStatusRequest(
        new URLSearchParams({ orderId: "not-an-order-id" }),
        { db },
      );
      expect(malformed.status).toBe(404);
      expect(malformed.body).toEqual(unknown.body);
    });
  });

  // — 7 —

  describe("the checkout route, end to end", () => {
    it("redirects a guest to the provider and hands back the claim code in a cookie only", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const port = initiationDouble();

      const result = await handleBeginCheckoutRequest(
        {
          contentType: "application/x-www-form-urlencoded",
          originHeader: "https://monacado.test",
          cookieHeader: null,
          rawBody: checkoutForm(listing.record.internalListingId),
        },
        {
          db,
          port,
          ids: orderIds,
          notificationIds,
          claimCodes,
          taxPort: createZeroRateTaxAdapter(),
          taxIds,
          buyerSnapshotIds,
          config: { policyId, riskPolicyId: await seedRiskPolicy(), appOrigin: "https://monacado.test:443" },
          now: () => CHECKOUT_AT,
        },
      );

      expect(result.status).toBe(303);
      expect(result.redirectTo).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      expect(result.headers.location).toBe(result.redirectTo);

      const cookie = result.headers["set-cookie"]!;
      expect(cookie).toContain(`${GUEST_CLAIM_COOKIE_NAME}=`);
      expect(cookie).toContain("HttpOnly");
      /* The claim code is a bearer credential and is never in a URL — not the
         redirect, not the return URL, not the response body. */
      const code = decodeURIComponent(cookie.split(";")[0]!.split("=")[1]!);
      expect(result.redirectTo).not.toContain(code);
      expect(JSON.stringify(result.body)).not.toContain(code);

      const orderId = (result.body as { orderId: string }).orderId;
      expect((await getOrder(orderId, deps())).lifecycle).toBe("PENDING_PAYMENT");
    });

    it("refuses a cross-site post and writes no Order", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const before = await db.order.count();

      const result = await handleBeginCheckoutRequest(
        {
          contentType: "application/x-www-form-urlencoded",
          originHeader: "https://evil.example",
          cookieHeader: null,
          rawBody: checkoutForm(listing.record.internalListingId),
        },
        {
          db,
          port: initiationDouble(),
          ids: orderIds,
          notificationIds,
          claimCodes,
          taxPort: createZeroRateTaxAdapter(),
          taxIds,
          buyerSnapshotIds,
          config: { policyId, riskPolicyId: await seedRiskPolicy(), appOrigin: "https://monacado.test:443" },
          now: () => CHECKOUT_AT,
        },
      );

      expect(result.status).toBe(403);
      expect(result.body).toEqual({ error: "CROSS_ORIGIN_REQUEST_REFUSED" });
      expect(await db.order.count()).toBe(before);
    });

    it("refuses a body that tries to price its own sale, and writes no Order", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const before = await db.order.count();

      const result = await handleBeginCheckoutRequest(
        {
          contentType: "application/json",
          originHeader: null,
          cookieHeader: null,
          rawBody: JSON.stringify({
            internalListingId: listing.record.internalListingId,
            ...CHECKOUT_FORM_FIELDS,
            /* The refusals are unchanged by 1.2's wider request: an address is
               not a price, and these are still rejected. */
            amountMinorUnits: 1,
            policyId: "mon:cpol:ATTACKERSCH0ICE0000000000A",
          }),
        },
        {
          db,
          port: initiationDouble(),
          ids: orderIds,
          notificationIds,
          claimCodes,
          taxPort: createZeroRateTaxAdapter(),
          taxIds,
          buyerSnapshotIds,
          config: { policyId, riskPolicyId: await seedRiskPolicy(), appOrigin: "https://monacado.test:443" },
          now: () => CHECKOUT_AT,
        },
      );

      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: "INVALID_CHECKOUT_REQUEST" });
      expect(await db.order.count()).toBe(before);
    });
  });

  // — 8 —

  describe("the buyer's Listing page prices through prepareCheckout", () => {
    it("shows the same total the provider is later asked to charge", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();

      const view = await readListingCheckoutView(
        { internalListingId: listing.record.internalListingId, policyId, now: CHECKOUT_AT },
        { db },
      );
      expect(view.purchasable).toBe(true);
      expect(view.buyerTotalMinorUnits).toBe(10_000);

      const { port } = await begin(listing.record.internalListingId, policyId, null);
      /* One pricing implementation, so the displayed price and the charged
         amount cannot drift. */
      expect(port.requests[0]!.amountMinorUnits).toBe(view.buyerTotalMinorUnits);
    });

    it("shows no price for a Listing that cannot be bought", async () => {
      const { listing, seller } = await seedSellerDirect();
      const policyId = await seedPolicy();

      /* Withdraw the governed commerce approval — the same lever 0M.9 tests. */
      await recordCommerceApproval(
        {
          participantId: seller.participantId,
          decision: "NOT_APPROVED",
          reasonCode: "WITHDRAWN_BY_MONACADO",
          actingAccountId: await (async () => {
            const id = await seedAccount();
            await grantAccountEntitlement(
              { accountId: id, capability: "participant:commerce-approve", grantedAt: NOW },
              { db },
            );
            return id;
          })(),
          decidedAt: CHECKOUT_AT,
        },
        { db, ids: approvalIds },
      );

      const view = await readListingCheckoutView(
        { internalListingId: listing.record.internalListingId, policyId, now: CHECKOUT_AT },
        { db },
      );
      expect(view.purchasable).toBe(false);
      expect(view.buyerTotalMinorUnits).toBeNull();
      expect(view.blockingReasons.length).toBeGreaterThan(0);
    });
  });
});
