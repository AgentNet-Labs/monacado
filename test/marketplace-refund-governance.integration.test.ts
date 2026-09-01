/**
 * Marketplace refund governance and receipt integration tests (Phase 1.10).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * **NO NETWORK, NO STRIPE ACCOUNT, NO CREDENTIAL, NO LIVE MONEY, NO AGENTNET
 * PUBLICATION, AND NO PRODUCTION POLICY ACTIVATION.** Every provider port is an
 * injected double, and the only policy activated is the shipped one inside this
 * disposable database.
 *
 * What only a database can show:
 *
 *   - the next Marketplace Policy version is recorded `DRAFT` **beside** the
 *     standing `ACTIVE` one, which is not touched, retired, or rewritten;
 *   - activating over a standing version is still refused;
 *   - a receipt assembled from an Order carries the terms **bound to it**, and
 *     goes on carrying them after the seller publishes new ones and moves house;
 *   - the checkout disclosure names the exact versions the Order then binds;
 *   - the dispatcher's rendered message states the historical policy.
 *
 * **Test isolation.** Every identifier carries the `P110` opaque prefix and every
 * account address the `refund-gov-` local part. No `deleteMany({})` appears. The
 * shipped Marketplace Policy is shared with every other suite, so this one
 * restores it — 1.0.0 `ACTIVE`, no 1.1.0 row — in `cleanup()`.
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
import { getOrder, recordPaymentResult } from "../src/server/marketplace/order-service";
import type { OrderIdProvider } from "../src/server/marketplace/order-ids";
import type { GuestClaimCodeProvider } from "../src/server/marketplace/guest-claim-code";
import type { ParticipantIdProvider } from "../src/server/marketplace/participant-ids";
import type { BuyerPaymentInitiationPort } from "../src/contracts/marketplace/buyer-payment";
import { beginCheckout } from "../src/server/payments/executable-checkout-service";
import {
  createStripeTaxAdapter,
  type StripeTaxCalculationClient,
} from "../src/server/tax/stripe-tax-adapter";
import type { StripeTaxRuntimeConfig } from "../src/server/tax/tax-runtime-config";
import type { TaxEvidenceIdProvider } from "../src/server/tax/tax-calculation-ids";
import {
  ensureSellerRefundPolicy,
  ensureShippedMarketplacePolicyActive,
  verifyPrimarySupportContact,
} from "./support/marketplace-policy-fixture";
import {
  activateSellerRefundPolicyVersion,
  recordSellerRefundPolicyVersion,
} from "../src/server/marketplace/seller-refund-policy-service";
import {
  consumeVerificationChallenge,
  issueVerificationChallenge,
  upsertEmailContact,
} from "../src/server/policy/email-verification-service";
import type { PolicyIdProvider } from "../src/server/policy/policy-ids";
import { resolveSellerSupportContact } from "../src/server/policy/support-contact-service";

// — Phase 1.10 under test —
import {
  bootstrapMarketplacePolicy,
  type PolicyBootstrapOutcome,
} from "../src/server/policy/marketplace-policy-bootstrap";
import {
  activateMarketplacePolicyVersion,
  getActiveMarketplacePolicyVersion,
  getMarketplacePolicyVersion,
  readMarketplacePolicy,
} from "../src/server/policy/marketplace-policy-service";
import {
  LATEST_MARKETPLACE_POLICY_VERSION,
  MARKETPLACE_POLICY_VERSION_1,
  marketplacePolicyDocument,
  MARKETPLACE_POLICY_VERSION_1_1,
  MARKETPLACE_POLICY_VERSION_1_2,
  MONACADO_MARKETPLACE_POLICY_ID,
  MONACADO_MARKETPLACE_POLICY_V1_1_HASH,
  MONACADO_MARKETPLACE_POLICY_V1_HASH,
} from "../src/contracts/marketplace/marketplace-policy-content";
import { readOrderReceipt } from "../src/server/marketplace/order-receipt-service";
import { readCheckoutRefundDisclosure } from "../src/server/marketplace/refund-disclosure-service";
import { resolveOutboundMessage } from "../src/server/notifications/email-message-resolver";
import { listEmailDeliveriesForSubject } from "../src/server/notifications/outbound-email-service";
import { enqueueSaleNotices } from "../src/server/notifications/transactional-notice-service";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const TAG = "P110";
const PRODUCT_TAG = "P110PR0D";
const PRODUCT_PREFIX = `mon:product:${PRODUCT_TAG}`;
const ACCOUNT_EMAIL_PREFIX = "refund-gov-";
const PASSWORD = "correct-horse-battery-staple-110";

const NOW = "2029-01-05T09:00:00.000Z";
const CHECKOUT_AT = "2029-01-10T12:00:00.000Z";
const PAID_AT = "2029-01-10T12:00:05.000Z";
const LATER = "2029-02-01T09:00:00.000Z";
const EXPIRES_AT = "2029-03-30T10:00:00.000Z";

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const ACTOR = `mon:actor:${pad26(`${TAG}ACT0R`)}`;
const RECORDER = `mon:acct:${pad26(`${TAG}REC0RDER`)}`;

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
  nextLockToken: () => `p110txlock${next()}`.padEnd(32, "0"),
};

const BUYER_DETAILS = {
  name: "Synthetic Buyer",
  email: "p110-buyer@example.test",
  billingAddress: {
    line1: "1 Test Street",
    line2: null,
    city: "Testville",
    region: "CA",
    postalCode: "94103",
    countryCode: "US",
  },
  shippingAddress: null,
  shipToSameAsBilling: true,
} as const;

const deps = () => ({ db, ids: orderIds, notificationIds, claimCodes });

const TAX_CONFIG: StripeTaxRuntimeConfig = {
  mode: "TEST",
  apiKeyEnvVar: "MONACADO_STRIPE_SECRET_KEY",
  taxCodes: { DIGITAL_GOOD: "txcd_TEST_DIGITAL", PHYSICAL_GOOD: "txcd_TEST_TANGIBLE" },
  shippingTaxCode: null,
  configVersion: "refund-gov-map/1",
};

/** A Stripe Tax calculation client double. No network, ever. */
function taxClientDouble(taxMinorUnits: number): StripeTaxCalculationClient {
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
              state: "CA",
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

// — Cleanup —

/**
 * Remove this suite's rows, then **restore the shared shipped policy baseline**.
 *
 * The Marketplace Policy identity is a fixed constant every suite's participants
 * are activated under, so a suite that activates 1.1.0 and walks away leaves
 * every later suite governed by terms it did not choose. The 1.1.0 row is deleted
 * — possible only once this suite's Orders are gone, since an Order `RESTRICT`s
 * the version it bound — and `ensureShippedMarketplacePolicyActive` then repairs
 * 1.0.0, which is exactly the self-heal it already performs for a suite that
 * exercises the no-ACTIVE-policy refusal.
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
    await db.orderTaxTransaction.deleteMany({ where: { orderId: { in: orderIdList } } });
    await db.orderTaxEvidence.deleteMany({ where: { orderId: { in: orderIdList } } });
    await db.orderRefundContactEvidence.deleteMany({ where: { orderId: { in: orderIdList } } });
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
    await db.participantCommerceApproval.deleteMany({
      where: { participantId: { in: participantIds } },
    });
    await db.emailVerificationChallenge.deleteMany({
      where: { participantId: { in: participantIds } },
    });
    await db.participantEmailContact.deleteMany({
      where: { participantId: { in: participantIds } },
    });
    await db.participantPolicyAcceptance.deleteMany({
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

  /* The shared shipped policy, put back exactly as every other suite expects it. */
  await db.marketplacePolicyVersionRow.deleteMany({
    where: {
      policyId: MONACADO_MARKETPLACE_POLICY_ID,
      policyVersion: MARKETPLACE_POLICY_VERSION_1_1,
    },
  });
}

// — Fixtures —

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
  retailMinorUnits = 9_000,
  refundPolicy: {
    shippingRefundability?: "ALWAYS_REFUNDED" | "NEVER_REFUNDED" | "REFUNDED_WHEN_SELLER_AT_FAULT";
    refundWindowDays?: number | null;
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
  const refund = await ensureSellerRefundPolicy(db, {
    sellerParticipantId: participantId,
    recordedByAccountId: accountId,
    now: NOW,
    policyId: `mon:srpol:${participantId.slice(-26)}`,
    ...(refundPolicy.shippingRefundability === undefined
      ? {}
      : { shippingRefundability: refundPolicy.shippingRefundability }),
    ...(refundPolicy.refundWindowDays === undefined
      ? {}
      : { refundWindowDays: refundPolicy.refundWindowDays }),
  });

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

  const storefrontId = `mon:storefront:${pad26(`${TAG}ST0RE${n}`)}`;
  await db.storefront.create({
    data: {
      internalStorefrontId: storefrontId,
      storefrontSourceRecordId: `mon:srec:${pad26(`${TAG}SFSREC${n}`)}`,
      currentSourceRecordVersion: "1",
      ownerParticipantId: participantId,
      publicHandle: `p110-shop-${n}`,
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
    internalListingId: listing.record.internalListingId,
    refundPolicyId: refund.policyId,
  };
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

/**
 * The `ORDER_CONFIRMATION` commitment for this sale, enqueued and then read back.
 *
 * `1.5` separates committing from sending, and the commitment is made by the
 * webhook handler rather than by `recordPaymentResult`. This suite drives the
 * sale directly, so it makes the same commitment the webhook would through the
 * same `1.1` trigger — the subject under test is the **resolver**, and routing
 * through a webhook payload to reach it would be testing the webhook.
 *
 * Read back through the service rather than off the row, so the test consumes
 * the record shape the dispatcher consumes instead of assembling one that could
 * drift from it.
 */
async function confirmationDelivery(orderId: string) {
  await enqueueSaleNotices({ order: await getOrder(orderId, { db }), at: PAID_AT }, { db });
  const deliveries = await listEmailDeliveriesForSubject({ kind: "ORDER", ref: orderId }, { db });
  const confirmation = deliveries.find((d) => d.purpose === "ORDER_CONFIRMATION");
  if (confirmation === undefined) {
    throw new Error(`no ORDER_CONFIRMATION delivery for ${orderId}`);
  }
  return confirmation;
}

const describeDb = RUN ? describe : describe.skip;

describeDb("1.10 — marketplace refund governance and receipts", () => {
  beforeEach(async () => {
    await cleanup();
    await ensureShippedMarketplacePolicyActive(db, {
      recordedByAccountId: await seedAccount(),
      now: NOW,
    });
  });
  afterAll(async () => {
    await cleanup();
    await ensureShippedMarketplacePolicyActive(db, {
      recordedByAccountId: await seedAccount(),
      now: NOW,
    });
    await cleanup();
    await disconnectPrisma();
  });

  /** A checkout taken to PAID, under the shipped policy that is ACTIVE now. */
  async function paidSale(
    over: {
      taxMinorUnits?: number;
      retail?: number;
      shipping?: number;
      refundPolicy?: Parameters<typeof seedSellerDirect>[1];
    } = {},
  ) {
    const taxMinorUnits = over.taxMinorUnits ?? 750;
    const retail = over.retail ?? 9_000;
    const shipping = over.shipping ?? 500;
    const seller = await seedSellerDirect(retail, over.refundPolicy ?? {});
    const policyId = await seedCommercialPolicy();
    const riskPolicyId = await seedRiskPolicy();
    const begun = await beginCheckout(
      {
        internalListingId: seller.internalListingId,
        buyerAccountId: null,
        taxAmountMinorUnits: 0,
        shippingAmountMinorUnits: shipping,
        otherPassThroughAmountMinorUnits: 0,
        currency: "USD" as const,
        productAvailability: "available" as const,
        placedAt: CHECKOUT_AT,
      },
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
    await recordPaymentResult(
      begun.order.orderId,
      {
        outcome: "SUCCEEDED" as const,
        provider: "STRIPE" as const,
        providerTransactionRef: `pi_${pad26(`${TAG}PI${next()}`)}`,
      },
      PAID_AT,
      "STRIPE",
      { ...deps(), taxTransactionIds },
    );
    return { seller, orderId: begun.order.orderId, taxMinorUnits, retail, shipping };
  }

  /** Record 1.1.0 as DRAFT through the shipped operator path. */
  const recordNextVersion = async (
    recordedByAccountId: string,
    over: { activate?: boolean } = {},
  ): Promise<PolicyBootstrapOutcome> =>
    bootstrapMarketplacePolicy(
      {
        recordedByAccountId,
        now: NOW,
        activate: over.activate ?? false,
        mode: "APPLY",
        policyVersion: MARKETPLACE_POLICY_VERSION_1_1,
      },
      { db },
    );

  // — 1 · Version succession —

  describe("publishing the next governed version", () => {
    it("records 1.1.0 as DRAFT beside the standing ACTIVE 1.0.0", async () => {
      const recorder = await seedAccount();
      const outcome = await recordNextVersion(recorder);

      expect(outcome).toMatchObject({
        action: "RECORD_DRAFT",
        applied: true,
        activated: false,
        refusal: null,
        policyVersion: MARKETPLACE_POLICY_VERSION_1_1,
        contentRef: `marketplace-policy/${MARKETPLACE_POLICY_VERSION_1_1}`,
        sourceHash: MONACADO_MARKETPLACE_POLICY_V1_1_HASH,
        /* Reported on a SUCCESS, so an operator can see which terms are still
           governing while the new version sits there. */
        standingActiveVersion: MARKETPLACE_POLICY_VERSION_1,
        requiresReacceptance: true,
      });

      const recorded = await getMarketplacePolicyVersion(
        MONACADO_MARKETPLACE_POLICY_ID,
        MARKETPLACE_POLICY_VERSION_1_1,
        { db },
      );
      expect(recorded).toMatchObject({
        status: "DRAFT",
        contentHash: MONACADO_MARKETPLACE_POLICY_V1_1_HASH,
        activatedAt: null,
        retiredAt: null,
      });
    });

    it("leaves the previously activated version ACTIVE, untouched, and unchanged", async () => {
      const before = await getMarketplacePolicyVersion(
        MONACADO_MARKETPLACE_POLICY_ID,
        MARKETPLACE_POLICY_VERSION_1,
        { db },
      );
      await recordNextVersion(await seedAccount());
      const after = await getMarketplacePolicyVersion(
        MONACADO_MARKETPLACE_POLICY_ID,
        MARKETPLACE_POLICY_VERSION_1,
        { db },
      );

      /* Byte-for-byte the same governance row. A DRAFT governs nobody, and
         recording one must touch nothing that does. */
      expect(after).toEqual(before);
      expect(after?.status).toBe("ACTIVE");
      expect(after?.retiredAt).toBeNull();
      expect(after?.contentHash).toBe(MONACADO_MARKETPLACE_POLICY_V1_HASH);

      const active = await getActiveMarketplacePolicyVersion(MONACADO_MARKETPLACE_POLICY_ID, {
        db,
      });
      expect(active?.policyVersion).toBe(MARKETPLACE_POLICY_VERSION_1);
    });

    it("still refuses to ACTIVATE over a standing version", async () => {
      const recorder = await seedAccount();
      await recordNextVersion(recorder);

      const outcome = await recordNextVersion(recorder, { activate: true });
      expect(outcome).toMatchObject({
        action: "REFUSED",
        refusal: "CONFLICTING_ACTIVE_VERSION",
        conflictingActiveVersion: MARKETPLACE_POLICY_VERSION_1,
        applied: false,
        activated: false,
      });

      /* Fail closed: nothing retired, nothing activated. Supersession stays a
         deliberate act by whoever owns the marketplace terms. */
      const active = await getActiveMarketplacePolicyVersion(MONACADO_MARKETPLACE_POLICY_ID, {
        db,
      });
      expect(active?.policyVersion).toBe(MARKETPLACE_POLICY_VERSION_1);
      expect(
        (
          await getMarketplacePolicyVersion(
            MONACADO_MARKETPLACE_POLICY_ID,
            MARKETPLACE_POLICY_VERSION_1_1,
            { db },
          )
        )?.status,
      ).toBe("DRAFT");
    });

    it("writes nothing on a second record-only run", async () => {
      const recorder = await seedAccount();
      await recordNextVersion(recorder);
      const first = await getMarketplacePolicyVersion(
        MONACADO_MARKETPLACE_POLICY_ID,
        MARKETPLACE_POLICY_VERSION_1_1,
        { db },
      );

      const again = await recordNextVersion(recorder);
      expect(again.action).toBe("NO_CHANGE_ALREADY_DRAFT");
      expect(again.applied).toBe(false);
      expect(
        await getMarketplacePolicyVersion(
          MONACADO_MARKETPLACE_POLICY_ID,
          MARKETPLACE_POLICY_VERSION_1_1,
          { db },
        ),
      ).toEqual(first);
    });

    it("refuses a version this deployment does not ship, before any write", async () => {
      const outcome = await bootstrapMarketplacePolicy(
        {
          recordedByAccountId: await seedAccount(),
          now: NOW,
          activate: false,
          mode: "APPLY",
          policyVersion: "9.9.9",
        },
        { db },
      );
      expect(outcome).toMatchObject({
        action: "REFUSED",
        refusal: "SHIPPED_VERSION_UNKNOWN",
        contentRef: null,
        sourceHash: null,
        applied: false,
      });
      expect(
        await getMarketplacePolicyVersion(MONACADO_MARKETPLACE_POLICY_ID, "9.9.9", { db }),
      ).toBeNull();
    });

    it("keeps both versions readable and hash-verified against their sources", async () => {
      await recordNextVersion(await seedAccount());
      for (const version of [MARKETPLACE_POLICY_VERSION_1, MARKETPLACE_POLICY_VERSION_1_1]) {
        const read = await readMarketplacePolicy(MONACADO_MARKETPLACE_POLICY_ID, version, { db });
        expect(read.document.policyVersion).toBe(version);
        expect(read.version.contentHash).toBe(
          version === MARKETPLACE_POLICY_VERSION_1
            ? MONACADO_MARKETPLACE_POLICY_V1_HASH
            : MONACADO_MARKETPLACE_POLICY_V1_1_HASH,
        );
      }
    });

    it("activates nothing in a production environment during this suite", () => {
      /* The disposable local database is the only target, and no run in this
         suite passes a production classification or a production confirmation.
         The bootstrap's gate is exercised purely in the contracts suite. */
      expect(process.env.DATABASE_URL ?? "").toContain("127.0.0.1:3308");
      expect((process.env.NODE_ENV ?? "").toLowerCase()).not.toBe("production");
    });
  });

  // — 2 · The receipt reads what the Order bound —

  describe("the receipt", () => {
    it("states the money, the line, and the shipping treatment the sale carried", async () => {
      const sale = await paidSale({ retail: 9_000, shipping: 500, taxMinorUnits: 750 });
      const receipt = await readOrderReceipt(sale.orderId, LATER, { db });

      expect(receipt.unavailableReason).toBeNull();
      expect(receipt.lifecycle).toBe("PAID");
      expect(receipt.paidAt).toBe(PAID_AT);
      expect(receipt.money).toMatchObject({
        currency: "USD",
        merchandiseMinorUnits: 9_000,
        taxMinorUnits: 750,
        shippingMinorUnits: 500,
        otherPassThroughMinorUnits: 0,
        totalMinorUnits: 10_250,
      });
      expect(receipt.lines).toHaveLength(1);
      expect(receipt.lines[0]).toMatchObject({
        internalListingId: sale.seller.internalListingId,
        /* A reference, never today's Product title — the Order binds no Product
           source version, so a description would be read from mutable data. */
        description: null,
        merchandiseMinorUnits: 9_000,
      });
      expect(receipt.shipping).toMatchObject({
        chargedMinorUnits: 500,
        refundability: "ALWAYS_REFUNDED",
        apportionment: "NOT_APPORTIONED",
      });
    });

    it("takes the shipping rule from the seller policy the Order bound", async () => {
      const sale = await paidSale({
        refundPolicy: { shippingRefundability: "NEVER_REFUNDED" },
      });
      const receipt = await readOrderReceipt(sale.orderId, LATER, { db });
      expect(receipt.shipping.refundability).toBe("NEVER_REFUNDED");
    });

    it("names the seller by marketplace identity and never by a display name", async () => {
      const sale = await paidSale();
      const receipt = await readOrderReceipt(sale.orderId, LATER, { db });
      expect(receipt.seller.participantId).toBe(sale.seller.participantId);
      /* No authoritative seller display name exists anywhere in this repository. */
      expect(receipt.seller.displayName).toBeNull();
    });

    it("carries the exact seller policy version, complete, with its hash", async () => {
      const sale = await paidSale();
      const bound = await db.order.findUniqueOrThrow({ where: { id: sale.orderId } });
      const receipt = await readOrderReceipt(sale.orderId, LATER, { db });

      expect(receipt.refund.policyRef).toMatchObject({
        policyId: bound.sellerRefundPolicyId!,
        policyVersion: bound.sellerRefundPolicyVersion!,
      });
      expect(receipt.refund.policyVersion!.document.sections.length).toBeGreaterThan(0);
      expect(receipt.refund.policyRef!.contentHash).toBe(
        receipt.refund.policyVersion!.contentHash,
      );
    });

    it("carries the purchase-time support contact, frozen at checkout", async () => {
      const sale = await paidSale();
      const sellerEmail = (
        await db.account.findUniqueOrThrow({
          where: { id: sale.seller.accountId },
          select: { email: true },
        })
      ).email;
      const receipt = await readOrderReceipt(sale.orderId, LATER, { db });
      expect(receipt.refund.procedure!.purchaseTimeRefundContact).toMatchObject({
        address: sellerEmail,
        source: "PRIMARY_PROFILE",
        state: "VERIFIED",
      });
    });

    it("says a refund needs no buyer account", async () => {
      const sale = await paidSale();
      const receipt = await readOrderReceipt(sale.orderId, LATER, { db });
      expect(receipt.refundInitiation).toEqual({
        requiresBuyerAccount: false,
        guestVerification: "ORDER_REFERENCE_AND_PURCHASE_CONFIRMATION",
        accountCreationAfterPurchase: "NEVER_REQUIRED",
      });
      expect(receipt.refund.procedure!.requiresBuyerAccount).toBe(false);
    });

    it("carries the marketplace version the Order bound, and its rules", async () => {
      const sale = await paidSale();
      const receipt = await readOrderReceipt(sale.orderId, LATER, { db });
      expect(receipt.marketplacePolicy).toMatchObject({
        policyId: MONACADO_MARKETPLACE_POLICY_ID,
        policyVersion: MARKETPLACE_POLICY_VERSION_1,
        contentHash: MONACADO_MARKETPLACE_POLICY_V1_HASH,
      });
      /* 1.0.0 states no refund governance, and the receipt shows that it does
         not — rather than borrowing 1.1.0's rules for a sale made before them. */
      expect(receipt.marketplacePolicy!.refundSections).toEqual([]);
    });

    it("answers ORDER_NOT_FOUND rather than throwing", async () => {
      const receipt = await readOrderReceipt(`mon:order:${pad26("N0SUCH")}`, LATER, { db });
      expect(receipt.unavailableReason).toBe("ORDER_NOT_FOUND");
      expect(receipt.refund.unavailableReason).toBe("ORDER_NOT_FOUND");
      expect(receipt.marketplacePolicy).toBeNull();
    });
  });

  // — 3 · Nothing current is ever substituted —

  describe("a seller who changes everything afterwards", () => {
    it("cannot alter the receipt for a purchase already made", async () => {
      const sale = await paidSale();
      const bound = await db.order.findUniqueOrThrow({ where: { id: sale.orderId } });
      const originalAddress = (
        await db.account.findUniqueOrThrow({
          where: { id: sale.seller.accountId },
          select: { email: true },
        })
      ).email;
      const before = await readOrderReceipt(sale.orderId, LATER, { db });

      // — The seller nominates a verified dedicated support address. —
      const dedicated = `${ACCOUNT_EMAIL_PREFIX}dedicated-${next()}@example.com`;
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

      // — And publishes tighter terms. —
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
      expect(await resolveSellerSupportContact(sale.seller.participantId, { db })).toMatchObject({
        available: true,
        address: dedicated,
      });

      const after = await readOrderReceipt(sale.orderId, LATER, { db });

      /* Every historical field identical. */
      expect(after.refund.policyRef).toEqual(before.refund.policyRef);
      expect(after.refund.policyVersion!.terms).toEqual(before.refund.policyVersion!.terms);
      expect(after.refund.procedure!.purchaseTimeRefundContact).toEqual(
        before.refund.procedure!.purchaseTimeRefundContact,
      );
      expect(after.refund.procedure!.purchaseTimeRefundContact!.address).toBe(originalAddress);
      expect(after.shipping.refundability).toBe(before.shipping.refundability);
      expect(JSON.stringify(after.refund.policyVersion)).not.toContain("All sales are final.");
      expect(JSON.stringify(after.refund.procedure)).not.toContain(dedicated);

      /* And the current contact is offered beside it, under its own name. */
      expect(after.refund.currentSellerSupportContact).toBe(dedicated);
    });

    it("reproduces the receipt for a seller with no usable contact today", async () => {
      const sale = await paidSale();
      const before = await readOrderReceipt(sale.orderId, LATER, { db });
      await db.participantEmailContact.updateMany({
        where: { participantId: sale.seller.participantId },
        data: { state: "UNVERIFIED" },
      });

      const after = await readOrderReceipt(sale.orderId, LATER, { db });
      expect(after.refund.currentSellerSupportContact).toBeNull();
      /* The historical disclosure survives the seller going dark entirely. */
      expect(after.refund.procedure!.purchaseTimeRefundContact).toEqual(
        before.refund.procedure!.purchaseTimeRefundContact,
      );
      expect(after.refund.policyRef).toEqual(before.refund.policyRef);
    });
  });

  // — 4 · The dispatcher's rendered message —

  describe("the rendered confirmation", () => {
    it("states the historical policy, the procedure, and the disclosed contact", async () => {
      const sale = await paidSale({ refundPolicy: { refundWindowDays: 30 } });
      const sellerEmail = (
        await db.account.findUniqueOrThrow({
          where: { id: sale.seller.accountId },
          select: { email: true },
        })
      ).email;
      const bound = await db.order.findUniqueOrThrow({ where: { id: sale.orderId } });

      const resolved = await resolveOutboundMessage(
        await confirmationDelivery(sale.orderId),
        LATER,
        { db },
      );

      expect(resolved.resolved).toBe(true);
      if (!resolved.resolved) return;
      expect(resolved.destination).toBe(BUYER_DETAILS.email);

      const body = resolved.text;
      expect(body).toContain(sale.orderId);
      expect(body).toContain(bound.sellerRefundPolicyId!);
      expect(body).toContain(`version ${bound.sellerRefundPolicyVersion!}`);
      expect(body).toContain("Refunds may be requested within 30 days of purchase.");
      expect(body).toContain(sellerEmail);
      expect(body).toContain("You do not need a Monacado account to request a refund.");
      /* The marketplace version that governed the sale is named, so the rules can
         be produced later even though they are not inlined. */
      expect(body).toContain(`version ${MARKETPLACE_POLICY_VERSION_1}`);
    });

    it("leaks no participant, commercial policy, provider reference, or economics", async () => {
      const sale = await paidSale();
      const bound = await db.order.findUniqueOrThrow({ where: { id: sale.orderId } });
      const receipt = await readOrderReceipt(sale.orderId, LATER, { db });
      const rendered = JSON.stringify(receipt);

      /* The READ contract carries internal references by design — a renderer
         needs them. What must never carry them is the message, so this asserts
         against the rendered body rather than against the view. */
      expect(rendered).toContain(sale.seller.participantId);

      const resolved = await resolveOutboundMessage(
        await confirmationDelivery(sale.orderId),
        LATER,
        { db },
      );
      expect(resolved.resolved).toBe(true);
      if (!resolved.resolved) return;

      for (const leak of [
        sale.seller.participantId,
        bound.policyId,
        bound.storefrontId,
        bound.internalProductId,
        "mon:mpart:",
        "mon:cpol:",
        "retained",
        "proceeds",
        "commission",
      ]) {
        expect(resolved.text, leak).not.toContain(leak);
      }
    });
  });

  // — 5 · The checkout disclosure —

  describe("the checkout disclosure", () => {
    it("discloses the seller's authoritative policy and what the Order will bind", async () => {
      const seller = await seedSellerDirect(9_000, { shippingRefundability: "NEVER_REFUNDED" });
      const disclosure = await readCheckoutRefundDisclosure(
        seller.internalListingId,
        CHECKOUT_AT,
        { db },
      );

      expect(disclosure.sellerPolicy).toMatchObject({
        available: true,
        sellerParticipantId: seller.participantId,
        policyId: seller.refundPolicyId,
        policyVersion: "1",
        refundsAllowed: true,
        shippingRefundable: "NEVER_REFUNDED",
      });
      /* THE COMPLETE DOCUMENT, before purchase. A summary would be a claim the
         terms might not support. */
      expect(disclosure.sellerPolicy.document!.sections.length).toBeGreaterThan(0);
      expect(disclosure.binding).toMatchObject({
        sellerRefundPolicy: {
          policyId: seller.refundPolicyId,
          policyVersion: "1",
          contentHash: disclosure.sellerPolicy.contentHash!,
        },
        marketplacePolicy: {
          policyId: MONACADO_MARKETPLACE_POLICY_ID,
          policyVersion: MARKETPLACE_POLICY_VERSION_1,
        },
        saleRefusedWithoutBinding: true,
      });
    });

    it("binds exactly the versions it disclosed", async () => {
      const seller = await seedSellerDirect();
      const disclosure = await readCheckoutRefundDisclosure(
        seller.internalListingId,
        CHECKOUT_AT,
        { db },
      );
      const policyId = await seedCommercialPolicy();
      const riskPolicyId = await seedRiskPolicy();
      const begun = await beginCheckout(
        {
          internalListingId: seller.internalListingId,
          buyerAccountId: null,
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
          taxPort: createStripeTaxAdapter({
            config: TAX_CONFIG,
            client: taxClientDouble(0),
          }),
          riskPolicyId,
          buyerDetails: BUYER_DETAILS,
        },
        { ...deps(), taxIds, buyerSnapshotIds },
      );

      const bound = await db.order.findUniqueOrThrow({ where: { id: begun.order.orderId } });
      /* The promise the disclosure makes, kept. "The policy I was shown" and
         "the policy that governs my purchase" are the same object. */
      expect(bound.sellerRefundPolicyId).toBe(disclosure.binding.sellerRefundPolicy!.policyId);
      expect(bound.sellerRefundPolicyVersion).toBe(
        disclosure.binding.sellerRefundPolicy!.policyVersion,
      );
      expect(bound.marketplacePolicyVersion).toBe(
        disclosure.binding.marketplacePolicy!.policyVersion,
      );
    });

    it("surfaces the marketplace refund rules once the version stating them governs", async () => {
      const recorder = await seedAccount();
      await recordNextVersion(recorder);
      /* Deliberate supersession, inside the disposable database only, performed
         through the governed activation path rather than by a row write. The
         suite's cleanup deletes the 1.1.0 row and repairs 1.0.0 afterwards. */
      await activateMarketplacePolicyVersion(
        {
          policyId: MONACADO_MARKETPLACE_POLICY_ID,
          policyVersion: MARKETPLACE_POLICY_VERSION_1_1,
          activatedByAccountId: recorder,
          activatedAt: LATER,
        },
        { db },
      );

      const seller = await seedSellerDirect();
      const disclosure = await readCheckoutRefundDisclosure(
        seller.internalListingId,
        CHECKOUT_AT,
        { db },
      );

      expect(disclosure.marketplacePolicy).toMatchObject({
        policyVersion: MARKETPLACE_POLICY_VERSION_1_1,
        contentHash: MONACADO_MARKETPLACE_POLICY_V1_1_HASH,
      });
      const keys = disclosure.marketplacePolicy!.refundSections.map((s) => s.key);
      expect(keys).toContain("REFUNDS_AND_CANCELLATION");
      expect(keys).toContain("REFUND_REQUESTS");
      expect(keys).toContain("PURCHASE_RECEIPTS");
      /* Buyer-facing only: the proceeds section is a seller and promoter matter. */
      expect(keys).not.toContain("REFUND_EFFECT_ON_PROCEEDS");
    });

    it("carries the bound marketplace rules onto a receipt for a sale made under them", async () => {
      const recorder = await seedAccount();
      await recordNextVersion(recorder);
      await activateMarketplacePolicyVersion(
        {
          policyId: MONACADO_MARKETPLACE_POLICY_ID,
          policyVersion: MARKETPLACE_POLICY_VERSION_1_1,
          activatedByAccountId: recorder,
          activatedAt: LATER,
        },
        { db },
      );

      const sale = await paidSale();
      const receipt = await readOrderReceipt(sale.orderId, LATER, { db });
      expect(receipt.marketplacePolicy).toMatchObject({
        policyVersion: MARKETPLACE_POLICY_VERSION_1_1,
        contentHash: MONACADO_MARKETPLACE_POLICY_V1_1_HASH,
      });
      expect(
        receipt.marketplacePolicy!.refundSections.map((s) => s.key),
      ).toContain("REFUNDS_AND_CANCELLATION");
    });

    it("reports the seller's terms as unavailable rather than inventing any", async () => {
      const seller = await seedSellerDirect();
      await db.sellerRefundPolicyVersionRow.updateMany({
        where: { sellerParticipantId: seller.participantId },
        data: { status: "DRAFT", activeMarker: null },
      });
      const disclosure = await readCheckoutRefundDisclosure(
        seller.internalListingId,
        CHECKOUT_AT,
        { db },
      );
      expect(disclosure.sellerPolicy.available).toBe(false);
      expect(disclosure.sellerPolicy.document).toBeNull();
      expect(disclosure.binding.sellerRefundPolicy).toBeNull();
      /* And checkout would refuse the sale on it — the guarantee stated here. */
      expect(disclosure.binding.saleRefusedWithoutBinding).toBe(true);
    });
  });

  // — 6 · Standing constraints —

  describe("standing constraints", () => {
    it("publishes no capsule for a marketplace policy version", async () => {
      await recordNextVersion(await seedAccount());
      const published = await db.productPublication.count({
        where: { internalProductId: { startsWith: PRODUCT_PREFIX } },
      });
      expect(published).toBe(0);
    });

    it("ships the version this deployment says it ships", () => {
      /* The newest SHIPPED version moves every time a phase writes one — 1.12
         moved it to 1.2.0, 1.14 to 1.3.0 — so re-pinning the literal here would
         make this test a changelog. What it is FOR survives every such move and
         is asserted directly instead: shipping a newer version activates
         nothing, and what governs is whichever version the database says is
         ACTIVE. */
      expect(marketplacePolicyDocument(LATEST_MARKETPLACE_POLICY_VERSION)).not.toBeNull();
      expect(LATEST_MARKETPLACE_POLICY_VERSION).not.toBe(MARKETPLACE_POLICY_VERSION_1);
    });
  });
});
