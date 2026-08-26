/**
 * Order-expiry and buyer-notification integration tests (Phase 1.1).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * **NO NETWORK, NO STRIPE ACCOUNT, NO MAIL PROVIDER.** Both provider ports are
 * injected doubles standing where the real adapters stand; the adapters' own
 * translation — including real signature verification and the expiry event — is
 * proved in `notification-delivery-contracts.test.ts`.
 *
 * What only a database can show, and what this suite is for:
 *
 *   - an expiry cancels a pending Order **once**, and creates no economics;
 *   - a `PAID` Order is never downgraded by one;
 *   - a **guest** receives a receipt **without a `MarketplaceParticipant`
 *     appearing anywhere**;
 *   - a repeated webhook sends no second message.
 *
 * **Test isolation.** Every identifier carries the `P11T` opaque prefix and every
 * account address the `notify-checkout-` local part. No `deleteMany({})` appears.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
import type { CommerceApprovalIdProvider } from "../src/server/marketplace/participant-commerce-approval-ids";
import { createSellerDirectListing } from "../src/server/marketplace/listing-service";
import {
  activateCommercialPolicyVersion,
  createCommercialPolicy,
  recordCommercialPolicyVersion,
} from "../src/server/marketplace/commercial-policy-service";
import type { CommercialPolicyIdProvider } from "../src/server/marketplace/commercial-policy-ids";
import { getOrder } from "../src/server/marketplace/order-service";
import type { OrderIdProvider } from "../src/server/marketplace/order-ids";
import type { GuestClaimCodeProvider } from "../src/server/marketplace/guest-claim-code";
import type { ParticipantIdProvider } from "../src/server/marketplace/participant-ids";
import type {
  BuyerPaymentConfirmation,
  BuyerPaymentInitiationPort,
} from "../src/contracts/marketplace/buyer-payment";
import { beginCheckout } from "../src/server/payments/executable-checkout-service";
import { handleStripeWebhookRequest } from "../src/server/payments/stripe-webhook-route-handler";
import { handleOrderStatusRequest } from "../src/server/payments/order-status-route-handler";
import {
  createCapturingMailAdapter,
  createDisabledMailAdapter,
} from "../src/server/notifications/mail-port";
import type { OutboundEmailIdProvider } from "../src/server/notifications/outbound-email-ids";
import { destinationDigest } from "../src/server/notifications/notification-delivery-service";
import { createZeroRateTaxAdapter } from "../src/server/tax/tax-adapters";
import type { TaxEvidenceIdProvider } from "../src/server/tax/tax-calculation-ids";
import {
  activateRiskPolicyVersion,
  createRiskPolicy,
  recordRiskPolicyVersion,
} from "../src/server/risk/risk-policy-service";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const TAG = "P11T";
const PRODUCT_TAG = "P11TPR0D";
const PRODUCT_PREFIX = `mon:product:${PRODUCT_TAG}`;
const ACCOUNT_EMAIL_PREFIX = "notify-checkout-";
const PASSWORD = "correct-horse-battery-staple-1-1";
const BUYER_EMAIL = "guest-buyer@example.test";
/** What the Order buyer snapshot records — the durable, recoverable address. */
const BUYER_SNAPSHOT_EMAIL = "guest-buyer@example.test";

const NOW = "2028-03-01T09:00:00.000Z";
const CHECKOUT_AT = "2028-03-05T12:00:00.000Z";
const CONFIRMED_AT = "2028-03-05T12:00:07.000Z";

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const ACTOR = `mon:actor:${pad26("P11TACT0R")}`;
const RECORDER = `mon:acct:${pad26("P11TREC0RDER")}`;

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

/* Phase 1.5 — the webhook now commits durable OutboundEmailDelivery rows and
   attempts them immediately, instead of sending once with no retry path. */
const deliveryIds: OutboundEmailIdProvider = {
  nextOutboundDeliveryId: () => `mon:oeml:${pad26(`${TAG}0EML${next()}`)}`,
  nextSuppressionId: () => `mon:esup:${pad26(`${TAG}ESUP${next()}`)}`,
  nextProviderEventId: () => `mon:pevt:${pad26(`${TAG}PEVT${next()}`)}`,
  nextMessageDiscriminator: () => pad26(`${TAG}DISC${next()}`),
  nextLockToken: () => `lock${next()}`.padEnd(32, "0"),
};

const approvalIds: CommerceApprovalIdProvider = {
  nextCommerceApprovalId: () => `mon:pcap:${pad26(`${TAG}PCAP${next()}`)}`,
};

const claimCodes: GuestClaimCodeProvider = {
  nextGuestClaimCode: () => `${TAG}-guest-claim-${next()}`.padEnd(43, "x").slice(0, 43),
};

const taxIds: TaxEvidenceIdProvider = {
  nextTaxEvidenceId: () => `mon:taxe:${pad26(`P11TTAXE${next()}`)}`,
};

const riskIds = {
  nextRiskPolicyId: () => `mon:rpol:${pad26(`P11TRP0L${next()}`)}`,
};

const policyIds: CommercialPolicyIdProvider = {
  nextPolicyId: () => `mon:cpol:${pad26(`${TAG}P0L${next()}`)}`,
};

const BUYER_DETAILS = {
  name: "Synthetic Buyer",
  email: BUYER_EMAIL,
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
  nextBuyerSnapshotId: () => `mon:obsn:${pad26(`P11T0BSN${next()}`)}`,
};

const deps = () => ({ db, ids: orderIds, notificationIds, claimCodes });

// — Doubles —

function initiationDouble(): BuyerPaymentInitiationPort {
  const byKey = new Map<string, string>();
  return {
    async initiatePayment(request) {
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

const confirmationDouble = (confirmation: BuyerPaymentConfirmation | null) => ({
  async confirmPayment() {
    return confirmation;
  },
});

const succeeded = (
  orderId: string,
  buyerEmail: string | null = BUYER_EMAIL,
): BuyerPaymentConfirmation => ({
  disposition: "PAYMENT_RESULT",
  orderId,
  provider: "STRIPE",
  buyerContact: buyerEmail === null ? null : { email: buyerEmail },
  result: {
    outcome: "SUCCEEDED",
    provider: "STRIPE",
    providerTransactionRef: `pi_${pad26(`${TAG}PI${next()}`)}`,
  },
  confirmedDetails: null,
  providerEventRef: `evt_${pad26(`${TAG}EVT${next()}`)}`,
  observedAt: CONFIRMED_AT,
});

/** Stable across replays, so a redelivery is genuinely the same statement. */
const succeededWithRef = (
  orderId: string,
  intentRef: string,
  buyerEmail: string | null = BUYER_EMAIL,
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
  buyerEmail: string | null = BUYER_EMAIL,
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

const abandoned = (
  orderId: string,
  buyerEmail: string | null = BUYER_EMAIL,
): BuyerPaymentConfirmation => ({
  disposition: "ABANDONED",
  orderId,
  provider: "STRIPE",
  buyerContact: buyerEmail === null ? null : { email: buyerEmail },
  confirmedDetails: null,
  providerEventRef: `evt_${pad26(`${TAG}EVT${next()}`)}`,
  observedAt: CONFIRMED_AT,
});

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
    /* Delivery evidence first: it holds RESTRICT keys onto the obligation and
       the participant deleted further down. */
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
    /* Phase 1.7 — a tax transaction holds RESTRICT keys onto BOTH the Order
       and its tax evidence, so it comes off before either. */
    await db.orderTaxTransaction.deleteMany({ where: { orderId: { in: orderIdList } } });
    await db.orderTaxEvidence.deleteMany({ where: { orderId: { in: orderIdList } } });
    /* The purchase-time refund disclosure, RESTRICT to its Order (Phase 1.9). */
    await db.orderRefundContactEvidence.deleteMany({
      where: { orderId: { in: orderIdList } },
    });
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

async function seedActiveParticipant() {
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
  return { participantId, accountId };
}

async function seedPolicy(): Promise<string> {
  const policy = await createCommercialPolicy(
    { label: `P11T policy ${next()}`, now: NOW },
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

async function seedSellerDirect(deliveryMode: "DIGITAL" | "PHYSICAL" = "DIGITAL") {
  const seller = await seedActiveParticipant();
  const n = next();
  const internalProductId = `${PRODUCT_PREFIX}${pad26(String(n)).slice(0, 26 - PRODUCT_TAG.length)}`;
  const sourceRecordId = `mon:srec:${pad26(`P11TPSREC${n}`)}`;
  await db.product.create({
    data: {
      internalProductId,
      sourceRecordId,
      currentSourceRecordVersion: "1",
      recordStatus: "DRAFT",
    },
  });
  await seedProductVersion(internalProductId, sourceRecordId, deliveryMode);
  const storefrontId = `mon:storefront:${pad26(`P11TST0RE${n}`)}`;
  await db.storefront.create({
    data: {
      internalStorefrontId: storefrontId,
      storefrontSourceRecordId: `mon:srec:${pad26(`P11TSFSREC${n}`)}`,
      currentSourceRecordVersion: "1",
      ownerParticipantId: seller.participantId,
      publicHandle: `p11t-shop-${n}`,
      lifecycle: "ACTIVE",
      visibility: "PUBLIC",
    },
  });
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
  const listing = await db.listing.findUniqueOrThrow({
    where: { internalListingId: snapshot.record.internalListingId },
  });
  await db.listing.update({
    where: { internalListingId: listing.internalListingId },
    data: { lifecycle: "ACTIVE" },
  });
  await db.listingSourceRecordVersionRow.updateMany({
    where: { listingSourceRecordId: listing.listingSourceRecordId },
    data: { lifecycle: "ACTIVE" },
  });

  const approver = await seedAccount();
  await grantAccountEntitlement(
    { accountId: approver, capability: "participant:commerce-approve", grantedAt: NOW },
    { db },
  );
  await recordCommerceApproval(
    {
      participantId: seller.participantId,
      decision: "APPROVED",
      reasonCode: "REQUIREMENTS_MET",
      actingAccountId: approver,
      decidedAt: NOW,
    },
    { db, ids: approvalIds },
  );
  return { seller, internalListingId: snapshot.record.internalListingId };
}

async function begin(internalListingId: string, policyId: string, buyerAccountId: string | null) {
  return beginCheckout(
    {
      internalListingId,
      buyerAccountId,
      taxAmountMinorUnits: 0,
      shippingAmountMinorUnits: 0,
      otherPassThroughAmountMinorUnits: 0,
      currency: "USD" as const,
      productAvailability: "available" as const,
      placedAt: CHECKOUT_AT,
    },
    policyId,
    {
      provider: "STRIPE",
      port: initiationDouble(),
      taxPort: createZeroRateTaxAdapter(),
      riskPolicyId: await seedRiskPolicy(),
      buyerDetails: BUYER_DETAILS,
    },
    { ...deps(), taxIds, buyerSnapshotIds },
  );
}

/** Drive the real webhook route, with a mail port a test can read. */
function webhook(
  confirmation: BuyerPaymentConfirmation | null,
  mail = createCapturingMailAdapter(),
) {
  return {
    mail,
    run: () =>
      handleStripeWebhookRequest(
        { rawBody: "{}", signatureHeader: "t=1,v1=irrelevant-the-port-is-injected" },
        {
          db,
          port: confirmationDouble(confirmation),
          mail,
          deliveryIds,
          now: () => CONFIRMED_AT,
        },
      ),
  };
}

/**
 * Phase 1.5 — the durable delivery table, which supersedes `1.1`'s single-attempt
 * `NotificationDelivery` for email. The columns moved with the model: `category`
 * became `purpose`, `acceptedAt` became `sentAt`, `failureCode` became
 * `lastFailureCode`, and `ACCEPTED` became `DELIVERED`.
 */
const deliveriesFor = (orderId: string) =>
  db.outboundEmailDelivery.findMany({
    where: { subjectKind: "ORDER", subjectRef: orderId },
    orderBy: { id: "asc" },
  });

const describeDb = RUN ? describe : describe.skip;

describeDb("1.1 — order expiry and buyer notification delivery", () => {
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

  // — 1 · expiry —

  describe("a signed expiry cancels a pending Order", () => {
    it("moves PENDING_PAYMENT to CANCELLED and creates no economics", async () => {
      const { internalListingId } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const begun = await begin(internalListingId, policyId, null);
      expect(begun.order.lifecycle).toBe("PENDING_PAYMENT");

      const response = await webhook(abandoned(begun.order.orderId)).run();
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ handled: true, disposition: "ORDER_EXPIRED" });

      const order = await getOrder(begun.order.orderId, deps());
      expect(order.lifecycle).toBe("CANCELLED");
      expect(order.cancelledAt).toBe(CONFIRMED_AT);

      /* Nothing commercial. `cancelOrder` writes one lifecycle column and has no
         path to any of these. */
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

    it("is idempotent across repeated expiry events", async () => {
      const { internalListingId } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const begun = await begin(internalListingId, policyId, null);

      const first = await webhook(abandoned(begun.order.orderId)).run();
      expect(first.body).toMatchObject({ disposition: "ORDER_EXPIRED" });
      const cancelledAt = (
        await db.order.findUniqueOrThrow({ where: { id: begun.order.orderId } })
      ).cancelledAt;

      for (const _ of [1, 2]) {
        const replay = await webhook(abandoned(begun.order.orderId)).run();
        expect(replay.status).toBe(200);
        expect(replay.body).toMatchObject({
          disposition: "ALREADY_RECORDED",
          lifecycle: "CANCELLED",
        });
      }

      const after = await db.order.findUniqueOrThrow({ where: { id: begun.order.orderId } });
      expect(after.cancelledAt).toEqual(cancelledAt);
      /* And exactly one expiry notice, not three. */
      expect(await deliveriesFor(begun.order.orderId)).toHaveLength(1);
    });

    it("never downgrades a PAID Order", async () => {
      const { internalListingId } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const begun = await begin(internalListingId, policyId, null);

      await webhook(succeeded(begun.order.orderId)).run();
      expect((await getOrder(begun.order.orderId, deps())).lifecycle).toBe("PAID");

      /* A late or replayed expiry against a completed sale. PAID is terminal in
         0M.9's transition table, so this cannot succeed — it is reported, not
         obeyed. */
      const late = await webhook(abandoned(begun.order.orderId)).run();
      expect(late.status).toBe(200);
      expect(late.body).toMatchObject({ disposition: "ALREADY_RECORDED", lifecycle: "PAID" });

      const order = await getOrder(begun.order.orderId, deps());
      expect(order.lifecycle).toBe("PAID");
      expect(order.cancelledAt).toBeNull();
      expect(
        await db.transactionEconomicSnapshot.count({ where: { orderId: begun.order.orderId } }),
      ).toBe(1);
    });

    it("leaves a PAYMENT_FAILED Order in its more specific state", async () => {
      const { internalListingId } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const begun = await begin(internalListingId, policyId, null);

      await webhook(failed(begun.order.orderId)).run();
      const late = await webhook(abandoned(begun.order.orderId)).run();
      expect(late.body).toMatchObject({ disposition: "ALREADY_RECORDED" });
      /* "A provider declined this" is a stronger fact than "the buyer wandered
         off", and overwriting it would lose it. */
      expect((await getOrder(begun.order.orderId, deps())).lifecycle).toBe("PAYMENT_FAILED");
    });

    it("shows the buyer a terminal, non-failure result", async () => {
      const { internalListingId } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const begun = await begin(internalListingId, policyId, null);
      await webhook(abandoned(begun.order.orderId)).run();

      const status = await handleOrderStatusRequest(
        new URLSearchParams({ orderId: begun.order.orderId }),
        { db },
      );
      expect(status.status).toBe(200);
      expect(status.body).toMatchObject({ lifecycle: "CANCELLED", paymentFailureCode: null });
    });
  });

  // — 2 · guest delivery —

  describe("a guest buyer is notified without becoming a participant", () => {
    it("emails the receipt and fabricates no participant", async () => {
      const { internalListingId } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const begun = await begin(internalListingId, policyId, null);
      expect(begun.order.buyer.buyerKind).toBe("GUEST_BUYER");

      const accountsBefore = await db.account.count();
      const participantsBefore = await db.marketplaceParticipant.count();

      const w = webhook(succeeded(begun.order.orderId));
      await w.run();

      /* 0M.9's promise, still true now that a guest actually receives mail. */
      expect(await db.account.count()).toBe(accountsBefore);
      expect(await db.marketplaceParticipant.count()).toBe(participantsBefore);

      const buyerMail = w.mail.sent.filter((m) => m.to === BUYER_EMAIL);
      expect(buyerMail).toHaveLength(1);
      expect(buyerMail[0]!.subject).toContain("confirmed");
      expect(buyerMail[0]!.text).toContain(begun.order.orderId);

      const rows = await deliveriesFor(begun.order.orderId);
      const buyerRow = rows.find((r) => r.audience === "BUYER");
      expect(buyerRow).toBeDefined();
      expect(buyerRow!.status).toBe("DELIVERED");
      expect(buyerRow!.recipientParticipantId).toBeNull();
      /* No obligation exists for a guest, and none was invented. */
      expect(buyerRow!.obligationId).toBeNull();
      expect(buyerRow!.sentAt?.toISOString()).toBe(CONFIRMED_AT);
      expect(buyerRow!.providerMessageRef).not.toBeNull();
      /* Terminal on the first attempt: delivered is delivered. */
      expect(buyerRow!.attemptCount).toBe(1);
      expect(buyerRow!.nextAttemptAt).toBeNull();
    });

    it("stores a digest of the address and never the address", async () => {
      const { internalListingId } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const begun = await begin(internalListingId, policyId, null);
      await webhook(succeeded(begun.order.orderId)).run();

      const rows = await deliveriesFor(begun.order.orderId);
      const buyerRow = rows.find((r) => r.audience === "BUYER")!;
      expect(buyerRow.destinationDigest).toBe(destinationDigest(BUYER_EMAIL));
      /* The whole row, serialised, contains no address anywhere. */
      expect(JSON.stringify(buyerRow)).not.toContain(BUYER_EMAIL);
      expect(JSON.stringify(buyerRow)).not.toContain("@");
    });

    it("recovers the address from the Order snapshot when the provider reports none", async () => {
      const { internalListingId } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const begun = await begin(internalListingId, policyId, null);

      /* Phase 1.2 SUPERSEDED this test's original premise. It used to assert
         that a confirmation carrying no contact meant no notice could be sent —
         true when the address was only ever transient.
       *
       * A completed Order now carries a buyer snapshot, so the receipt is sent
       * from Monacado's own durable data. That is the improvement, and it also
       * retires 1.1's recorded gate about irrecoverable guest addresses. */
      const w = webhook(succeeded(begun.order.orderId, null));
      await w.run();

      const buyerMail = w.mail.sent.filter((m) => m.to === BUYER_SNAPSHOT_EMAIL);
      expect(buyerMail).toHaveLength(1);

      const rows = await deliveriesFor(begun.order.orderId);
      const buyerRow = rows.find((r) => r.audience === "BUYER");
      expect(buyerRow).toBeDefined();
      expect(buyerRow!.destinationDigest).toBe(destinationDigest(BUYER_SNAPSHOT_EMAIL));
      expect((await getOrder(begun.order.orderId, deps())).lifecycle).toBe("PAID");
    });
  });

  // — 3 · account buyer and participants —

  describe("an authenticated buyer and the seller are both notified", () => {
    it("sends the buyer a receipt and the seller a supplemental notice", async () => {
      const { internalListingId, seller } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const buyerAccountId = await seedAccount();
      const begun = await begin(internalListingId, policyId, buyerAccountId);
      expect(begun.order.buyer.buyerKind).toBe("ACCOUNT_BUYER");

      const w = webhook(succeeded(begun.order.orderId));
      await w.run();

      const rows = await deliveriesFor(begun.order.orderId);
      expect(rows.map((r) => r.audience).sort()).toEqual(["BUYER", "SELLER"]);

      const sellerRow = rows.find((r) => r.audience === "SELLER")!;
      expect(sellerRow.recipientParticipantId).toBe(seller.participantId);
      /* Supplemental to the canonical admin-panel obligation 0M.9 wrote. */
      expect(sellerRow.obligationId).not.toBeNull();
      expect(sellerRow.purpose).toBe("SALE_RECORDED");

      /* And the obligation it accompanies is UNTOUCHED — §3a: a supplemental
         channel can never replace the canonical notice. */
      const obligation = await db.notificationObligation.findUniqueOrThrow({
        where: { id: sellerRow.obligationId! },
      });
      expect(obligation.status).toBe("UNREAD");
      expect(obligation.acknowledgedAt).toBeNull();
      expect(obligation.resolvedAt).toBeNull();
    });
  });

  // — 4 · failure and expiry notices —

  describe("failure and expiry notices reach the buyer", () => {
    it("sends a bounded failure notice and no sale notices", async () => {
      const { internalListingId } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const begun = await begin(internalListingId, policyId, null);

      const w = webhook(failed(begun.order.orderId));
      await w.run();

      expect(w.mail.sent).toHaveLength(1);
      expect(w.mail.sent[0]!.to).toBe(BUYER_EMAIL);
      expect(w.mail.sent[0]!.text).toContain("DECLINED");
      expect(w.mail.sent[0]!.text.toLowerCase()).toContain("no payment was taken");

      const rows = await deliveriesFor(begun.order.orderId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.purpose).toBe("PAYMENT_FAILED");
      /* A failure is not a sale: nobody but the buyer hears about it. */
      expect(rows[0]!.audience).toBe("BUYER");
    });

    it("sends an expiry notice under its own category", async () => {
      const { internalListingId } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const begun = await begin(internalListingId, policyId, null);

      const w = webhook(abandoned(begun.order.orderId));
      await w.run();

      expect(w.mail.sent).toHaveLength(1);
      expect(w.mail.sent[0]!.subject).toContain("expired");
      const rows = await deliveriesFor(begun.order.orderId);
      /* ORDER_CANCELLED, not PAYMENT_FAILED — nobody declined anything. */
      expect(rows[0]!.purpose).toBe("ORDER_CANCELLED");
    });
  });

  // — 5 · duplicate suppression and provider failure —

  describe("duplicates and provider failures", () => {
    it("sends no second message when the same event is redelivered", async () => {
      const { internalListingId } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const begun = await begin(internalListingId, policyId, null);
      const intentRef = `pi_${pad26(`${TAG}STABLE`)}`;

      const first = webhook(succeededWithRef(begun.order.orderId, intentRef));
      await first.run();
      expect(first.mail.sent).toHaveLength(2); // buyer + seller

      const rowsAfterFirst = await deliveriesFor(begun.order.orderId);
      expect(rowsAfterFirst).toHaveLength(2);

      for (const _ of [1, 2]) {
        const replay = webhook(succeededWithRef(begun.order.orderId, intentRef));
        const response = await replay.run();
        expect(response.body).toMatchObject({ disposition: "ALREADY_RECORDED" });
        /* Nothing newly became true, so nobody is newly owed a message —
           decided by the OUTCOME, before the delivery key is even consulted. */
        expect(replay.mail.sent).toHaveLength(0);
      }

      expect(await deliveriesFor(begun.order.orderId)).toHaveLength(2);
    });

    it("records a provider refusal as evidence without failing the webhook", async () => {
      const { internalListingId } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const begun = await begin(internalListingId, policyId, null);

      /* Mail is not configured. The sale is already committed, so a mail outage
         must not tell Stripe the payment was not processed. */
      const response = await handleStripeWebhookRequest(
        { rawBody: "{}", signatureHeader: "t=1,v1=injected" },
        {
          db,
          port: confirmationDouble(succeeded(begun.order.orderId)),
          mail: createDisabledMailAdapter(),
          deliveryIds,
          now: () => CONFIRMED_AT,
        },
      );

      expect(response.status).toBe(200);
      expect((await getOrder(begun.order.orderId, deps())).lifecycle).toBe("PAID");

      const rows = await deliveriesFor(begun.order.orderId);
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        /* Phase 1.5 — the notice is no longer LOST. An unconfigured channel is a
           condition an operator fixes, so it is transient: the row is scheduled
           for another attempt rather than written off, and only exhausting the
           bounded policy makes it terminal. That is the whole correction. */
        expect(row.status).toBe("RETRY_PENDING");
        expect(row.lastFailureCode).toBe("CHANNEL_NOT_CONFIGURED");
        expect(row.lastFailureClass).toBe("TRANSIENT");
        expect(row.attemptCount).toBe(1);
        expect(row.nextAttemptAt).not.toBeNull();
        expect(row.sentAt).toBeNull();
        expect(row.providerMessageRef).toBeNull();
        /* Even a failure records WHERE it was going — as a digest. */
        expect(row.destinationDigest).toMatch(/^[0-9a-f]{64}$/);
      }
    });
  });
});
