/**
 * Buyer checkout, Order, and post-sale integration tests (Phase 0M.9).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * NO NETWORK, NO PROVIDER SDK, NO CREDENTIAL. The payment port is a scripted
 * double injected per test. Instants and identities are injected. Every value is
 * synthetic; no real personal data and no real provider reference appears.
 *
 * **Test isolation.** Every identifier this suite mints carries the `M9T` opaque
 * prefix and every account address the `checkout-` local part, and every delete
 * is filtered by one of those. No `deleteMany({})` appears anywhere.
 *
 * These are deliberately **end-to-end flow tests** rather than dozens of absence
 * assertions: the phase's whole claim is that Listing → checkout → Order →
 * payment → economics → obligations → review eligibility holds together, and that
 * is only demonstrable by running it.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import { createDraftOffer } from "../src/server/marketplace/offer-service";
import { grantAccountEntitlement } from "../src/server/account/account-entitlement-service";
import {
  getCurrentCommerceApproval,
  listCommerceApprovals,
  recordCommerceApproval,
} from "../src/server/marketplace/participant-commerce-approval-service";
import { CommerceApprovalActorNotAuthorizedError } from "../src/server/marketplace/participant-commerce-approval-errors";
import type { CommerceApprovalIdProvider } from "../src/server/marketplace/participant-commerce-approval-ids";
import { COMMERCE_APPROVAL_ID_PATTERN } from "../src/server/marketplace/participant-commerce-approval-ids";
import {
  createListingSourceVersion,
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
  advanceProceedsObligation,
  authorizeReviewSubmission,
  cancelOrder,
  claimGuestOrder,
  evaluateReviewEligibility,
  executeOrderPayment,
  getOrder,
  getPurchaseEvidence,
  listProceedsObligations,
  placeOrder,
  prepareCheckout,
  recordPaymentResult,
} from "../src/server/marketplace/order-service";
import {
  GuestClaimRefusedError,
  InvalidOrderTransitionError,
  OrderNotCompletedError,
  PaymentResultConflictError,
  ReviewNotEligibleError,
} from "../src/server/marketplace/order-errors";
import { ORDER_ID_PATTERNS } from "../src/server/marketplace/order-ids";
import type { OrderIdProvider } from "../src/server/marketplace/order-ids";
import type { GuestClaimCodeProvider } from "../src/server/marketplace/guest-claim-code";
import { hashGuestClaimCode } from "../src/server/marketplace/guest-claim-code";
import type { ParticipantIdProvider } from "../src/server/marketplace/participant-ids";
import type {
  BuyerPaymentPort,
  BuyerPaymentRequest,
  BuyerPaymentResult,
} from "../src/contracts/marketplace/buyer-payment";
import { getTransactionEconomicSnapshot } from "../src/server/marketplace/transaction-accounting-service";
import { toReviewSubmissionAuthorityView } from "../src/contracts/marketplace/purchase-evidence";
import { canPublishProductReviewCapsule } from "../src/contracts/marketplace/capability";
import { reviewAuthorityRowToRecord } from "../src/server/marketplace/order-mapper";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const TAG = "M9T";
const PRODUCT_TAG = "M9TPR0D";
const PRODUCT_PREFIX = `mon:product:${PRODUCT_TAG}`;
const ACCOUNT_EMAIL_PREFIX = "checkout-";
const PASSWORD = "correct-horse-battery-staple-0m9";

const NOW = "2027-11-01T09:00:00.000Z";
const CHECKOUT_AT = "2027-12-03T12:00:00.000Z";
const PAID_AT = "2027-12-03T12:00:05.000Z";
const LATER = "2027-12-10T09:00:00.000Z";

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const ACTOR = `mon:actor:${pad26("M9TACT0R")}`;
const RECORDER = `mon:acct:${pad26("M9TREC0RDER")}`;

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
  /** base64url of 32 bytes — the shape the real provider emits. */
  nextGuestClaimCode: () => `${TAG}-guest-claim-code-${next()}`.padEnd(43, "x").slice(0, 43),
};

const deps = () => ({ db, ids: orderIds, notificationIds, claimCodes });

/**
 * A scripted payment adapter.
 *
 * **The whole of the provider integration in this phase.** No SDK, no network, no
 * credential — the port exists precisely so the sale path is exercisable without
 * one. It records the requests it saw so a test can assert what Monacado asked
 * for, and it is idempotent on `idempotencyKey` exactly as a real adapter must be.
 */
function scriptedPort(result: BuyerPaymentResult): BuyerPaymentPort & {
  requests: BuyerPaymentRequest[];
} {
  const requests: BuyerPaymentRequest[] = [];
  const byKey = new Map<string, BuyerPaymentResult>();
  return {
    requests,
    async executePayment(request) {
      requests.push(request);
      const seen = byKey.get(request.idempotencyKey);
      if (seen !== undefined) return seen;
      byKey.set(request.idempotencyKey, result);
      return result;
    },
  };
}

const succeeds = (ref: string): BuyerPaymentResult => ({
  outcome: "SUCCEEDED",
  provider: "STRIPE",
  providerTransactionRef: ref,
});

const fails: BuyerPaymentResult = { outcome: "FAILED", failureCode: "DECLINED" };

/** Delete only what this suite created, child-to-parent. */
async function cleanup(): Promise<void> {
  const ownOrders = { startsWith: `mon:order:${TAG}` };

  await db.reviewSubmissionAuthority.deleteMany({ where: { orderId: ownOrders } });
  /* The purchase-time refund disclosure, RESTRICT to its Order (Phase 1.9). */
  await db.orderRefundContactEvidence.deleteMany({ where: { orderId: ownOrders } });
  await db.purchaseEvidence.deleteMany({ where: { orderId: ownOrders } });

  const snapshots = await db.transactionEconomicSnapshot.findMany({
    where: { orderId: ownOrders },
    select: { id: true },
  });
  const snapshotIds = snapshots.map((s) => s.id);
  if (snapshotIds.length > 0) {
    await db.proceedsObligation.deleteMany({ where: { snapshotId: { in: snapshotIds } } });
    await db.transactionSettlement.deleteMany({ where: { snapshotId: { in: snapshotIds } } });
    await db.transactionEconomicSnapshot.deleteMany({ where: { id: { in: snapshotIds } } });
  }
  await db.order.deleteMany({ where: { id: ownOrders } });

  const accounts = await db.account.findMany({
    where: { email: { startsWith: ACCOUNT_EMAIL_PREFIX } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length > 0) {
    const participants = await db.marketplaceParticipant.findMany({
      where: { accountId: { in: accountIds } },
      select: { id: true },
    });
    const participantIds = participants.map((p) => p.id);
    if (participantIds.length > 0) {
      await db.notificationObligation.deleteMany({
        where: { recipientParticipantId: { in: participantIds } },
      });
      await db.participantCommerceApproval.deleteMany({
        where: { participantId: { in: participantIds } },
      });
      const listings = await db.listing.findMany({
        where: { controllingParticipantId: { in: participantIds } },
        select: { internalListingId: true },
      });
      await db.listingSourceRecordVersionRow.deleteMany({
        where: { controllingParticipantId: { in: participantIds } },
      });
      await db.listing.deleteMany({
        where: { internalListingId: { in: listings.map((l) => l.internalListingId) } },
      });
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
    await db.accountEntitlement.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.account.deleteMany({ where: { id: { in: accountIds } } });
  }

  const ownPolicies = { startsWith: `mon:cpol:${TAG}` };
  await db.commercialPolicyVersionRow.deleteMany({ where: { policyId: ownPolicies } });
  await db.commercialPolicy.deleteMany({ where: { id: ownPolicies } });

  await db.product.deleteMany({ where: { internalProductId: { startsWith: PRODUCT_PREFIX } } });
}

// — Fixtures —

const policyIds: CommercialPolicyIdProvider = {
  nextPolicyId: () => `mon:cpol:${pad26(`${TAG}P0L${next()}`)}`,
};

async function seedProduct(): Promise<string> {
  const n = next();
  const internalProductId = `${PRODUCT_PREFIX}${pad26(String(n)).slice(
    0,
    26 - PRODUCT_TAG.length,
  )}`;
  await db.product.create({
    data: {
      internalProductId,
      sourceRecordId: `mon:srec:${pad26(`M9TPSREC${n}`)}`,
      currentSourceRecordVersion: "1",
      recordStatus: "DRAFT",
    },
  });
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

/** A participant, activated at the row level so its Listings can actually sell. */
async function seedActiveParticipant(roles: Array<"SELLER" | "PROMOTER" | "BUYER">) {
  const accountId = await seedAccount();
  const snapshot = await createDraftParticipant(
    { accountId, initialRoles: roles, now: NOW },
    { db },
  );
  const participantId = snapshot.participant.participantId;

  /* 0M.5 and 0M.8 gate activation behind a governed review this suite is not
     exercising, so the ACTIVE state a sale requires is set at the row level —
     the same technique 0M.7's own suite uses to reach a sellable Listing. */
  await db.marketplaceParticipant.update({
    where: { id: participantId },
    data: { status: "ACTIVE" },
  });
  await db.marketplaceRoleAssignment.updateMany({
    where: { participantId },
    data: { status: "ACTIVE" },
  });
  return { participantId, accountId };
}

/** A publicly accessible Storefront. */
async function seedStorefront(ownerParticipantId: string): Promise<string> {
  const n = next();
  const internalStorefrontId = `mon:storefront:${pad26(`M9TST0RE${n}`)}`;
  await db.storefront.create({
    data: {
      internalStorefrontId,
      storefrontSourceRecordId: `mon:srec:${pad26(`M9TSFSREC${n}`)}`,
      currentSourceRecordVersion: "1",
      ownerParticipantId,
      publicHandle: `m9t-shop-${n}`,
      lifecycle: "ACTIVE",
      visibility: "PUBLIC",
    },
  });
  return internalStorefrontId;
}

/**
 * An internal account holding an active `participant:commerce-approve`
 * entitlement — the only authority that can clear a participant to transact.
 */
async function seedCommerceApprover(): Promise<string> {
  const accountId = await seedAccount();
  await grantAccountEntitlement(
    { accountId, capability: "participant:commerce-approve", grantedAt: NOW },
    { db },
  );
  return accountId;
}

/** Monacado's governed clearance for one participant to transact. */
async function approveCommerce(participantId: string, approverAccountId?: string) {
  const actingAccountId = approverAccountId ?? (await seedCommerceApprover());
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
  const policy = await createCommercialPolicy(
    { label: `M9T policy ${next()}`, now: NOW },
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

/** Force a Listing ACTIVE at the row level — the state a later phase produces. */
async function forceListingActive(internalListingId: string): Promise<void> {
  const listing = await db.listing.findUniqueOrThrow({ where: { internalListingId } });
  await db.listing.update({ where: { internalListingId }, data: { lifecycle: "ACTIVE" } });
  await db.listingSourceRecordVersionRow.updateMany({
    where: { listingSourceRecordId: listing.listingSourceRecordId },
    data: { lifecycle: "ACTIVE" },
  });
}

/** A purchasable seller-direct Listing at $100.00. */
async function seedSellerDirect(sale: Record<string, unknown> | null = null) {
  const seller = await seedActiveParticipant(["SELLER"]);
  const internalProductId = await seedProduct();
  const storefrontId = await seedStorefront(seller.participantId);
  const snapshot = await createSellerDirectListing(
    {
      storefrontId,
      internalProductId,
      controllingParticipantId: seller.participantId,
      retail: { retailPriceMinorUnits: 10_000, retailPriceCurrency: "USD" },
      sale,
      actingAccountId: seller.accountId,
      authorizedByActorId: ACTOR,
      now: NOW,
    },
    { db },
  );
  await forceListingActive(snapshot.record.internalListingId);
  /* The Storefront's OWNER is whose clearance `storefrontExposure` is about. */
  await approveCommerce(seller.participantId);
  return { seller, internalProductId, storefrontId, listing: snapshot };
}

const ACQUISITION_POLICY = {
  policyId: `mon:cpol:${pad26("M9TSUPPL0ED")}`,
  policyVersion: "1",
  currency: "USD",
  retainedPercentageBasisPoints: 750,
  retainedFixedAmountMinorUnits: 100,
  roundingPolicy: "HALF_UP_TO_MINOR_UNIT" as const,
};

/**
 * A purchasable promoted Listing: $100.00 retail over a $50.00 Offer with a 20%
 * seller-funded commission — the business model §D worked example, as rows.
 */
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
  /* A promoted Listing only sells when the accepted Offer version is itself
     commercially selectable. */
  await db.offerSourceRecordVersionRow.updateMany({
    where: { offerSourceRecordId: offer.record.offerSourceRecordId },
    data: { lifecycle: "ACTIVE", availability: "AVAILABLE" },
  });
  /* And, since Phase 1.15 (Ruling 1), only while the SELLER currently offers it.
     The accepted version above is the historical terms; the stable Offer row is
     the Seller's standing authorization for new commerce, and both must hold. */
  await db.offer.update({
    where: { internalOfferId: offer.record.internalOfferId },
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
  /* The promoter owns the storefront on a promoted placement, so it is the
     promoter's clearance the exposure check reads. */
  await approveCommerce(promoter.participantId);
  return { seller, promoter, internalProductId, offer, listing };
}

/**
 * The only upstream fact a caller still supplies.
 *
 * Go-live approval is deliberately absent: it is resolved from the governed
 * `ParticipantCommerceApproval` record, and there is no parameter through which a
 * caller could assert it.
 */
const UPSTREAM = { productAvailability: "available" as const };

const NO_CHARGES = {
  taxAmountMinorUnits: 0,
  shippingAmountMinorUnits: 0,
  otherPassThroughAmountMinorUnits: 0,
};

/** Place, charge, and record — the whole flow, as one helper. */
async function buy(options: {
  internalListingId: string;
  policyId: string;
  buyerAccountId?: string | null;
  charges?: { taxAmountMinorUnits: number; shippingAmountMinorUnits: number; otherPassThroughAmountMinorUnits: number };
  result?: BuyerPaymentResult;
}) {
  const placed = await placeOrder(
    {
      internalListingId: options.internalListingId,
      buyerAccountId: options.buyerAccountId ?? null,
      ...(options.charges ?? NO_CHARGES),
      currency: "USD",
      ...UPSTREAM,
      placedAt: CHECKOUT_AT,
    },
    options.policyId,
    deps(),
  );
  const port = scriptedPort(options.result ?? succeeds(`m9t_txn_${next()}`));
  const result = await executeOrderPayment(placed.order, "STRIPE", port);
  const recorded = await recordPaymentResult(
    placed.order.orderId,
    result,
    PAID_AT,
    "STRIPE",
    deps(),
  );
  return { placed, port, result, ...recorded };
}

const describeDb = RUN ? describe : describe.skip;

describeDb("0M.9 — buyer checkout, Order, and post-sale foundation", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  describe("checkout preparation", () => {
    it("prices a seller-direct checkout from persisted data, accepting no figure", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();

      const prepared = await prepareCheckout(
        {
          internalListingId: listing.record.internalListingId,
          buyerAccountId: null,
          taxAmountMinorUnits: 825,
          shippingAmountMinorUnits: 599,
          otherPassThroughAmountMinorUnits: 0,
          currency: "USD",
          ...UPSTREAM,
          placedAt: CHECKOUT_AT,
        },
        policyId,
        { db },
      );

      expect(prepared.quote.quotedCommercialRetailAmountMinorUnits).toBe(10_000);
      expect(prepared.transactionType).toBe("SELLER_DIRECT");
      expect(prepared.promoterParticipantId).toBeNull();
      // The buyer total is the merchandise price plus the supplied charges.
      expect(prepared.buyerTotalMinorUnits).toBe(11_424);
      // The exact versions the sale will bind.
      expect(prepared.listingSourceRecordVersion).toBe("1");
      expect(prepared.policyVersion).toBe("1");
    });

    it("quotes the sale price inside a scheduled window", async () => {
      const { listing } = await seedSellerDirect({
        salePriceMinorUnits: 8_000,
        salePriceCurrency: "USD",
        saleStartsAt: "2027-12-01T00:00:00.000Z",
        saleEndsAt: "2027-12-08T00:00:00.000Z",
      });
      const policyId = await seedPolicy();

      const base = {
        internalListingId: listing.record.internalListingId,
        buyerAccountId: null,
        ...NO_CHARGES,
        currency: "USD",
        ...UPSTREAM,
      };

      const inside = await prepareCheckout({ ...base, placedAt: CHECKOUT_AT }, policyId, { db });
      expect(inside.quote.quotedCommercialRetailAmountMinorUnits).toBe(8_000);

      const outside = await prepareCheckout({ ...base, placedAt: LATER }, policyId, { db });
      expect(outside.quote.quotedCommercialRetailAmountMinorUnits).toBe(10_000);
    });

    it("resolves the promoted seller from the exact Offer version, not the controller", async () => {
      const { listing, seller, promoter } = await seedPromoted();
      const policyId = await seedPolicy();

      const prepared = await prepareCheckout(
        {
          internalListingId: listing.record.internalListingId,
          buyerAccountId: null,
          ...NO_CHARGES,
          currency: "USD",
          ...UPSTREAM,
          placedAt: CHECKOUT_AT,
        },
        policyId,
        { db },
      );

      expect(prepared.transactionType).toBe("PROMOTED");
      // The controller is the PROMOTER; the seller comes from the Offer.
      expect(prepared.promoterParticipantId).toBe(promoter.participantId);
      expect(prepared.sellerParticipantId).toBe(seller.participantId);
      expect(prepared.sellerParticipantId).not.toBe(prepared.promoterParticipantId);
    });

    it("refuses a listing that is not buyer-active, naming every reason", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();

      await expect(
        prepareCheckout(
          {
            internalListingId: listing.record.internalListingId,
            buyerAccountId: null,
            ...NO_CHARGES,
            currency: "USD",
            productAvailability: "unavailable",
            placedAt: CHECKOUT_AT,
          },
          policyId,
          { db },
        ),
      ).rejects.toMatchObject({
        blockingReasons: expect.arrayContaining(["PRODUCT_UNAVAILABLE"]),
      });
    });

    it("refuses when no commercial policy is effective — there is no fallback rate", async () => {
      const { listing } = await seedSellerDirect();
      const policy = await createCommercialPolicy(
        { label: `M9T draft-only ${next()}`, now: NOW },
        { db, ids: policyIds },
      );

      await expect(
        prepareCheckout(
          {
            internalListingId: listing.record.internalListingId,
            buyerAccountId: null,
            ...NO_CHARGES,
            currency: "USD",
            ...UPSTREAM,
            placedAt: CHECKOUT_AT,
          },
          policy.policyId,
          { db },
        ),
      ).rejects.toMatchObject({ code: "NO_EFFECTIVE_COMMERCIAL_POLICY" });
    });
  });

  describe("guest checkout", () => {
    it("completes a seller-direct guest purchase end to end", async () => {
      const { listing, seller } = await seedSellerDirect();
      const policyId = await seedPolicy();

      const { placed, order, sale, result } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
      });

      expect(placed.order.orderId).toMatch(ORDER_ID_PATTERNS.order);
      expect(placed.order.buyer.buyerKind).toBe("GUEST_BUYER");
      // The claim code is returned once and never stored raw.
      expect(placed.guestClaimCode).not.toBeNull();

      expect(order.lifecycle).toBe("PAID");
      expect(sale).not.toBeNull();

      // The economics: $8.50 retained, $91.50 to the seller.
      const { snapshot, settlement } = await getTransactionEconomicSnapshot(sale!.snapshotId, {
        db,
      });
      expect(snapshot.commercialRetailAmountMinorUnits).toBe(10_000);
      expect(snapshot.economics).toEqual({
        transactionType: "SELLER_DIRECT",
        monacadoRetainedAmountMinorUnits: 850,
        morWholesaleAcquisitionAmountMinorUnits: 9_150,
        sellerProceedsMinorUnits: 9_150,
      });
      // The provider's own reference, recorded on 0M.T1's settlement row.
      if (result.outcome !== "SUCCEEDED") throw new Error("expected a successful payment");
      expect(settlement.providerTransactionRef).toBe(result.providerTransactionRef);
      expect(settlement.provider).toBe("STRIPE");
      expect(settlement.state).toBe("PENDING");

      // One obligation, to the seller, for the whole acquisition amount.
      expect(sale!.proceedsObligations).toHaveLength(1);
      expect(sale!.proceedsObligations[0]).toMatchObject({
        party: "SELLER",
        participantId: seller.participantId,
        amountMinorUnits: 9_150,
        state: "PENDING",
      });
    });

    it("fabricates no Account and no MarketplaceParticipant for a guest", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();

      const accountsBefore = await db.account.count();
      const participantsBefore = await db.marketplaceParticipant.count();

      const { order } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
      });

      expect(await db.account.count()).toBe(accountsBefore);
      expect(await db.marketplaceParticipant.count()).toBe(participantsBefore);

      const row = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
      expect(row.buyerAccountId).toBeNull();
      expect(row.buyerParticipantId).toBeNull();
      expect(row.guestClaimCodeDigest).not.toBeNull();
    });

    it("stores only a digest of the claim code, and claims with the raw code", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const { placed } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
      });
      const code = placed.guestClaimCode!;

      const row = await db.order.findUniqueOrThrow({ where: { id: placed.order.orderId } });
      expect(row.guestClaimCodeDigest).toBe(hashGuestClaimCode(code));
      expect(row.guestClaimCodeDigest).not.toBe(code);

      const claimant = await seedAccount();
      const claimed = await claimGuestOrder(
        {
          orderId: placed.order.orderId,
          guestClaimCode: code,
          claimedByAccountId: claimant,
          claimedAt: LATER,
        },
        deps(),
      );

      expect(claimed.guestClaim.claimedByAccountId).toBe(claimant);
      expect(claimed.guestClaim.claimedAt).toBe(LATER);
      // The sale was made by a guest and the record still says so.
      expect(claimed.buyer.buyerKind).toBe("GUEST_BUYER");
    });

    it("refuses a wrong code and a second claim, indistinguishably", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const { placed } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
      });
      const claimant = await seedAccount();

      await expect(
        claimGuestOrder(
          {
            orderId: placed.order.orderId,
            guestClaimCode: "not-the-code",
            claimedByAccountId: claimant,
            claimedAt: LATER,
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(GuestClaimRefusedError);

      await claimGuestOrder(
        {
          orderId: placed.order.orderId,
          guestClaimCode: placed.guestClaimCode!,
          claimedByAccountId: claimant,
          claimedAt: LATER,
        },
        deps(),
      );
      await expect(
        claimGuestOrder(
          {
            orderId: placed.order.orderId,
            guestClaimCode: placed.guestClaimCode!,
            claimedByAccountId: claimant,
            claimedAt: LATER,
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(GuestClaimRefusedError);
    });
  });

  describe("authenticated checkout", () => {
    it("completes a purchase for an account with no participant record", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const buyerAccountId = await seedAccount();

      const { placed, order } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
        buyerAccountId,
      });

      expect(order.lifecycle).toBe("PAID");
      expect(placed.order.buyer).toEqual({
        buyerKind: "ACCOUNT_BUYER",
        buyerAccountId,
        // Buying requires no participant; most buyers have none.
        buyerParticipantId: null,
      });
      const row = await db.order.findUniqueOrThrow({ where: { id: order.orderId } });
      expect(row.guestClaimCodeDigest).toBeNull();
    });

    it("records the participant when the buying account already holds one", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const buyer = await seedActiveParticipant(["BUYER"]);

      const { placed } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
        buyerAccountId: buyer.accountId,
      });

      expect(placed.order.buyer).toEqual({
        buyerKind: "ACCOUNT_BUYER",
        buyerAccountId: buyer.accountId,
        buyerParticipantId: buyer.participantId,
      });
    });
  });

  describe("promoted checkout", () => {
    it("creates seller and promoter obligations from the snapshot's own economics", async () => {
      const { listing, seller, promoter } = await seedPromoted();
      const policyId = await seedPolicy();

      const { sale } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
      });

      const { snapshot } = await getTransactionEconomicSnapshot(sale!.snapshotId, { db });
      const e = snapshot.economics;
      if (e.transactionType !== "PROMOTED") throw new Error("expected a promoted snapshot");

      // The business model §D worked example.
      expect(e.monacadoRetainedAmountMinorUnits).toBe(850);
      expect(e.sellerProceedsMinorUnits).toBe(4_000);
      expect(e.promoterNetProceedsMinorUnits).toBe(5_150);

      const obligations = await listProceedsObligations(sale!.snapshotId, { db });
      expect(obligations).toHaveLength(2);

      const sellerClaim = obligations.find((o) => o.party === "SELLER")!;
      const promoterClaim = obligations.find((o) => o.party === "PROMOTER")!;

      expect(sellerClaim).toMatchObject({
        participantId: seller.participantId,
        amountMinorUnits: 4_000,
        state: "PENDING",
      });
      // Net proceeds — spread PLUS the seller-funded commission, not the spread alone.
      expect(promoterClaim).toMatchObject({
        participantId: promoter.participantId,
        amountMinorUnits: 5_150,
        state: "PENDING",
      });

      // The three parties account for exactly what the buyer paid.
      expect(
        sellerClaim.amountMinorUnits +
          promoterClaim.amountMinorUnits +
          e.monacadoRetainedAmountMinorUnits,
      ).toBe(snapshot.commercialRetailAmountMinorUnits);
    });

    it("binds the exact Listing, Offer, and policy versions the sale ran under", async () => {
      const { listing, offer } = await seedPromoted();
      const policyId = await seedPolicy();

      const { order, sale } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
      });

      const { snapshot } = await getTransactionEconomicSnapshot(sale!.snapshotId, { db });

      expect(order.listingSourceRecordVersion).toBe("1");
      expect(order.policyVersion).toBe("1");
      expect(snapshot.listingBinding.listingSourceRecordVersion).toBe("1");
      expect(snapshot.policyBinding).toEqual({ policyId, policyVersion: "1" });
      if (snapshot.economics.transactionType !== "PROMOTED") throw new Error("promoted");
      expect(snapshot.economics.offerBinding).toEqual({
        internalOfferId: offer.record.internalOfferId,
        offerSourceRecordId: offer.record.offerSourceRecordId,
        offerSourceRecordVersion: "1",
      });

      // The Order and its snapshot are bound one-to-one.
      const row = await db.transactionEconomicSnapshot.findUniqueOrThrow({
        where: { orderId: order.orderId },
      });
      expect(row.id).toBe(sale!.snapshotId);
    });

    it("leaves historical economics untouched when the Listing is repriced afterwards", async () => {
      const { listing, promoter } = await seedPromoted();
      const policyId = await seedPolicy();
      const { sale } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
      });

      await createListingSourceVersion(
        {
          internalListingId: listing.record.internalListingId,
          sourceRecordVersion: "2",
          retail: { retailPriceMinorUnits: 20_000, retailPriceCurrency: "USD" },
          acquisitionPolicy: ACQUISITION_POLICY,
          actingAccountId: promoter.accountId,
          authorizedByActorId: ACTOR,
          now: LATER,
        },
        { db },
      );

      const { snapshot } = await getTransactionEconomicSnapshot(sale!.snapshotId, { db });
      expect(snapshot.commercialRetailAmountMinorUnits).toBe(10_000);
      expect(snapshot.listingBinding.listingSourceRecordVersion).toBe("1");
    });
  });

  describe("tax, shipping, and pass-through", () => {
    it("charges the buyer for them and keeps them out of every commercial basis", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();

      const bare = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
      });
      const charged = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
        charges: {
          taxAmountMinorUnits: 825,
          shippingAmountMinorUnits: 1_299,
          otherPassThroughAmountMinorUnits: 50,
        },
      });

      // The buyer paid $21.74 more...
      expect(charged.placed.buyerTotalMinorUnits).toBe(12_174);
      expect(bare.placed.buyerTotalMinorUnits).toBe(10_000);
      expect(charged.port.requests[0]!.amountMinorUnits).toBe(12_174);

      // ...and every commercial figure is identical.
      const bareSnapshot = await getTransactionEconomicSnapshot(bare.sale!.snapshotId, { db });
      const chargedSnapshot = await getTransactionEconomicSnapshot(charged.sale!.snapshotId, {
        db,
      });
      expect(chargedSnapshot.snapshot.economics).toEqual(bareSnapshot.snapshot.economics);
      expect(chargedSnapshot.snapshot.commercialRetailAmountMinorUnits).toBe(10_000);

      // And the seller's obligation is unchanged by $21.74 of charges.
      const bareObligations = await listProceedsObligations(bare.sale!.snapshotId, { db });
      const chargedObligations = await listProceedsObligations(charged.sale!.snapshotId, { db });
      expect(chargedObligations[0]!.amountMinorUnits).toBe(bareObligations[0]!.amountMinorUnits);
    });
  });

  describe("failed payment", () => {
    it("creates no sale, no economics, no obligation, and no evidence", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();

      const { order, sale } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
        result: fails,
      });

      expect(sale).toBeNull();
      expect(order.lifecycle).toBe("PAYMENT_FAILED");
      expect(order.paymentFailureCode).toBe("DECLINED");
      expect(order.failedAt).toBe(PAID_AT);
      expect(order.paidAt).toBeNull();

      expect(
        await db.transactionEconomicSnapshot.count({ where: { orderId: order.orderId } }),
      ).toBe(0);
      expect(await db.purchaseEvidence.count({ where: { orderId: order.orderId } })).toBe(0);
      const snapshots = await db.transactionEconomicSnapshot.findMany({
        where: { orderId: order.orderId },
        select: { id: true },
      });
      expect(snapshots).toHaveLength(0);
    });

    it("records a PAYMENT_FAILED notice only when the buyer is a participant", async () => {
      const policyId = await seedPolicy();

      // A guest has no participant, so 0M.N1 has no recipient to key on.
      const guestListing = await seedSellerDirect();
      const guest = await buy({
        internalListingId: guestListing.listing.record.internalListingId,
        policyId,
        result: fails,
      });
      expect(
        await db.notificationObligation.count({
          where: { category: "PAYMENT_FAILED", subjectRef: guest.order.orderId },
        }),
      ).toBe(0);

      // A participant buyer does get one.
      const memberListing = await seedSellerDirect();
      const buyer = await seedActiveParticipant(["BUYER"]);
      const member = await buy({
        internalListingId: memberListing.listing.record.internalListingId,
        policyId,
        buyerAccountId: buyer.accountId,
        result: fails,
      });
      const notice = await db.notificationObligation.findFirst({
        where: { category: "PAYMENT_FAILED", subjectRef: member.order.orderId },
      });
      expect(notice?.recipientParticipantId).toBe(buyer.participantId);
      expect(notice?.subjectKind).toBe("PAYMENT");
    });

    it("does not permit a failed Order to become paid — a retry is a new Order", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const { order } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
        result: fails,
      });

      await expect(
        recordPaymentResult(
          order.orderId,
          succeeds(`m9t_late_${next()}`),
          LATER,
          "STRIPE",
          deps(),
        ),
      ).rejects.toBeInstanceOf(InvalidOrderTransitionError);
    });
  });

  describe("notification obligations for a sale", () => {
    it("tells the seller, and the promoter on a promoted sale", async () => {
      const policyId = await seedPolicy();

      const direct = await seedSellerDirect();
      const directSale = await buy({
        internalListingId: direct.listing.record.internalListingId,
        policyId,
      });
      const directNotices = await db.notificationObligation.findMany({
        where: { category: "SALE_RECORDED", subjectRef: directSale.order.orderId },
      });
      expect(directNotices).toHaveLength(1);
      expect(directNotices[0]!.recipientParticipantId).toBe(direct.seller.participantId);

      const promotedFixture = await seedPromoted();
      const promotedSale = await buy({
        internalListingId: promotedFixture.listing.record.internalListingId,
        policyId,
      });
      const promotedNotices = await db.notificationObligation.findMany({
        where: { category: "SALE_RECORDED", subjectRef: promotedSale.order.orderId },
      });
      expect(promotedNotices.map((n) => n.recipientParticipantId).sort()).toEqual(
        [promotedFixture.seller.participantId, promotedFixture.promoter.participantId].sort(),
      );
    });
  });

  describe("idempotency and conflict", () => {
    it("returns the existing sale when the same provider transaction is replayed", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const ref = `m9t_idem_${next()}`;

      const first = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
        result: succeeds(ref),
      });

      const replay = await recordPaymentResult(
        first.order.orderId,
        succeeds(ref),
        LATER,
        "STRIPE",
        deps(),
      );

      expect(replay.sale).not.toBeNull();
      expect(replay.sale!.snapshotId).toBe(first.sale!.snapshotId);
      // Nothing was written twice.
      expect(
        await db.transactionEconomicSnapshot.count({ where: { orderId: first.order.orderId } }),
      ).toBe(1);
      expect(await listProceedsObligations(first.sale!.snapshotId, { db })).toHaveLength(1);
      expect(await db.purchaseEvidence.count({ where: { orderId: first.order.orderId } })).toBe(1);
    });

    it("refuses a DIFFERENT provider transaction against a paid Order", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const first = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
        result: succeeds(`m9t_first_${next()}`),
      });

      await expect(
        recordPaymentResult(
          first.order.orderId,
          succeeds(`m9t_second_${next()}`),
          LATER,
          "STRIPE",
          deps(),
        ),
      ).rejects.toBeInstanceOf(PaymentResultConflictError);
    });

    it("uses the Order id as the idempotency key, so every retry carries one key", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const { placed, port } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
      });

      await executeOrderPayment(placed.order, "STRIPE", port);
      expect(port.requests).toHaveLength(2);
      expect(port.requests[0]!.idempotencyKey).toBe(placed.order.orderId);
      expect(port.requests[1]!.idempotencyKey).toBe(placed.order.orderId);
      // The adapter charged once.
      expect(new Set(port.requests.map((r) => r.idempotencyKey)).size).toBe(1);
    });
  });

  describe("transactionality", () => {
    it("rolls the whole sale back when one write inside it fails", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();

      const placed = await placeOrder(
        {
          internalListingId: listing.record.internalListingId,
          buyerAccountId: null,
          ...NO_CHARGES,
          currency: "USD",
          ...UPSTREAM,
          placedAt: CHECKOUT_AT,
        },
        policyId,
        deps(),
      );

      /* Force a failure inside the sale transaction: an id provider whose
         purchase-evidence id is invalid makes that insert fail after the
         snapshot, the settlement row, and the obligation have been written. */
      const brokenIds: OrderIdProvider = {
        ...orderIds,
        nextPurchaseEvidenceId: () => "not-a-valid-evidence-id".padEnd(300, "x"),
      };

      await expect(
        recordPaymentResult(
          placed.order.orderId,
          succeeds(`m9t_rollback_${next()}`),
          PAID_AT,
          "STRIPE",
          { db, ids: brokenIds, notificationIds, claimCodes },
        ),
      ).rejects.toBeTruthy();

      // Nothing survived: no snapshot, no obligation, no evidence, and the Order
      // is still awaiting payment rather than half-sold.
      const order = await getOrder(placed.order.orderId, deps());
      expect(order.lifecycle).toBe("PENDING_PAYMENT");
      expect(
        await db.transactionEconomicSnapshot.count({ where: { orderId: placed.order.orderId } }),
      ).toBe(0);
      expect(await db.purchaseEvidence.count({ where: { orderId: placed.order.orderId } })).toBe(
        0,
      );
      expect(
        await db.notificationObligation.count({
          where: { category: "SALE_RECORDED", subjectRef: placed.order.orderId },
        }),
      ).toBe(0);
    });

    it("never leaves a PAID Order without economics, or economics without an Order", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      await buy({ internalListingId: listing.record.internalListingId, policyId });

      const paidWithoutEconomics = await db.order.count({
        where: { id: { startsWith: `mon:order:${TAG}` }, lifecycle: "PAID", economicSnapshot: null },
      });
      expect(paidWithoutEconomics).toBe(0);

      const ownOrderIds = (
        await db.order.findMany({
          where: { id: { startsWith: `mon:order:${TAG}` } },
          select: { id: true },
        })
      ).map((o) => o.id);
      const economicsWithoutPaidOrder = await db.transactionEconomicSnapshot.count({
        where: { orderId: { in: ownOrderIds }, order: { lifecycle: { not: "PAID" } } },
      });
      expect(economicsWithoutPaidOrder).toBe(0);
    });
  });

  describe("order lifecycle", () => {
    it("cancels a pending Order and refuses to cancel a paid one", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();

      const pending = await placeOrder(
        {
          internalListingId: listing.record.internalListingId,
          buyerAccountId: null,
          ...NO_CHARGES,
          currency: "USD",
          ...UPSTREAM,
          placedAt: CHECKOUT_AT,
        },
        policyId,
        deps(),
      );
      const cancelled = await cancelOrder(
        { orderId: pending.order.orderId, at: LATER },
        deps(),
      );
      expect(cancelled.lifecycle).toBe("CANCELLED");
      expect(cancelled.cancelledAt).toBe(LATER);

      const paid = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
      });
      await expect(
        cancelOrder({ orderId: paid.order.orderId, at: LATER }, deps()),
      ).rejects.toBeInstanceOf(InvalidOrderTransitionError);
    });
  });

  describe("proceeds obligations", () => {
    it("advances PENDING -> ELIGIBLE -> PAID and refuses a skip or a reversal", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const { sale } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
      });
      const obligationId = sale!.proceedsObligations[0]!.obligationId;

      await expect(
        advanceProceedsObligation({ obligationId, to: "PAID", at: LATER }, deps()),
      ).rejects.toMatchObject({ code: "INVALID_PROCEEDS_OBLIGATION_TRANSITION" });

      const eligible = await advanceProceedsObligation(
        { obligationId, to: "ELIGIBLE", at: LATER },
        deps(),
      );
      expect(eligible.state).toBe("ELIGIBLE");
      expect(eligible.becameEligibleAt).toBe(LATER);

      const paid = await advanceProceedsObligation(
        { obligationId, to: "PAID", at: LATER },
        deps(),
      );
      expect(paid.state).toBe("PAID");

      await expect(
        advanceProceedsObligation({ obligationId, to: "ELIGIBLE", at: LATER }, deps()),
      ).rejects.toMatchObject({ code: "INVALID_PROCEEDS_OBLIGATION_TRANSITION" });
    });
  });

  describe("review eligibility and authority", () => {
    it("makes a completed purchase eligible for a product and a seller review", async () => {
      const { listing, seller, internalProductId } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const { order } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
      });

      expect(await evaluateReviewEligibility(order.orderId, "PRODUCT_REVIEW", deps())).toEqual({
        eligible: true,
        blockers: [],
      });

      const evidence = await getPurchaseEvidence(order.orderId, deps());
      expect(evidence.purchaseProvenance).toBe("VERIFIED");
      expect(evidence.internalProductId).toBe(internalProductId);
      expect(evidence.sellerParticipantId).toBe(seller.participantId);

      const productAuthority = await authorizeReviewSubmission(
        { orderId: order.orderId, reviewKind: "PRODUCT_REVIEW", at: LATER },
        deps(),
      );
      expect(productAuthority.reviewSubjectRef).toBe(internalProductId);
      expect(productAuthority.submissionState).toBe("SUBMITTED");

      const sellerAuthority = await authorizeReviewSubmission(
        { orderId: order.orderId, reviewKind: "SELLER_REVIEW", at: LATER },
        deps(),
      );
      expect(sellerAuthority.reviewSubjectRef).toBe(seller.participantId);
    });

    it("authorizes one submission per governed subject per Order", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const { order } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
      });

      await authorizeReviewSubmission(
        { orderId: order.orderId, reviewKind: "PRODUCT_REVIEW", at: LATER },
        deps(),
      );
      await expect(
        authorizeReviewSubmission(
          { orderId: order.orderId, reviewKind: "PRODUCT_REVIEW", at: LATER },
          deps(),
        ),
      ).rejects.toBeInstanceOf(ReviewNotEligibleError);

      expect(
        await evaluateReviewEligibility(order.orderId, "PRODUCT_REVIEW", deps()),
      ).toMatchObject({ eligible: false, blockers: ["REVIEW_ALREADY_AUTHORIZED"] });
    });

    it("authorizes a GUEST buyer's review — 0M.1 requires a purchase, not an account", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const { order } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
      });

      const authority = await authorizeReviewSubmission(
        { orderId: order.orderId, reviewKind: "PRODUCT_REVIEW", at: LATER },
        deps(),
      );
      expect(authority.submitter).toBe("GUEST_BUYER");
      expect(authority.purchaseProvenance).toBe("VERIFIED");
    });

    it("refuses review authority when no sale completed", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const { order } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
        result: fails,
      });

      expect(
        await evaluateReviewEligibility(order.orderId, "PRODUCT_REVIEW", deps()),
      ).toMatchObject({
        eligible: false,
        blockers: ["ORDER_NOT_COMPLETED", "PURCHASE_EVIDENCE_MISSING"],
      });
      await expect(
        authorizeReviewSubmission(
          { orderId: order.orderId, reviewKind: "PRODUCT_REVIEW", at: LATER },
          deps(),
        ),
      ).rejects.toBeInstanceOf(ReviewNotEligibleError);
      await expect(getPurchaseEvidence(order.orderId, deps())).rejects.toBeInstanceOf(
        OrderNotCompletedError,
      );
    });

    it("feeds 0M.1's committed capsule-authority evaluator unchanged", async () => {
      const { listing, internalProductId } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const { order } = await buy({
        internalListingId: listing.record.internalListingId,
        policyId,
      });
      const authority = await authorizeReviewSubmission(
        { orderId: order.orderId, reviewKind: "PRODUCT_REVIEW", at: LATER },
        deps(),
      );

      const row = await db.reviewSubmissionAuthority.findUniqueOrThrow({
        where: { id: authority.authorityId },
      });
      const view = toReviewSubmissionAuthorityView(reviewAuthorityRowToRecord(row));

      // A SUBMITTED authority authorizes first publication of ITS OWN review —
      // the target is the review submission, not the thing reviewed.
      expect(
        canPublishProductReviewCapsule({
          authority: view,
          action: "PUBLISH",
          target: { kind: "PRODUCT_REVIEW", ref: view.reviewSubmissionId },
        }).decision,
      ).toBe("ALLOW");

      // ...nothing over the Product capsule itself...
      expect(
        canPublishProductReviewCapsule({
          authority: view,
          action: "PUBLISH",
          target: { kind: "PRODUCT", ref: internalProductId },
        }),
      ).toMatchObject({
        decision: "DENY",
        reasonCodes: ["REVIEW_AUTHORITY_SCOPE_EXCEEDED"],
      });

      // ...and not even over somebody else's review.
      expect(
        canPublishProductReviewCapsule({
          authority: view,
          action: "PUBLISH",
          target: { kind: "PRODUCT_REVIEW", ref: `mon:rsub:${pad26("M9T0THER")}` },
        }),
      ).toMatchObject({
        decision: "DENY",
        reasonCodes: ["REVIEW_AUTHORITY_TARGET_MISMATCH"],
      });

      // The evidence is a pointer, never content.
      expect(view.purchaseEvidenceRef).toMatch(ORDER_ID_PATTERNS.purchaseEvidence);
    });
  });

  describe("storage shape", () => {
    it("stores no buyer personal data on any table this phase created", async () => {
      /* Two lists, because they were always two rules wearing one coat.
       *
       * The first is buyer PII and holds on every table, forever. The second is
       * "0M.9 built none of this machinery" — a scope assertion, and one that a
       * later phase legitimately narrows, exactly as `taxtransaction` was
       * narrowed at 1.7 and `refund` at 1.9. */
      const NEVER_BUYER_PII = [
        "email",
        "phone",
        "address",
        "ipaddress",
        "cardlast4",
        "cardnumber",
        "bankaccount",
        "devicefingerprint",
      ];
      const NO_MACHINERY_0M9 = ["chargeback", "payoutid", "taxrate", "jurisdiction"];

      for (const table of ["Order", "PurchaseEvidence", "ProceedsObligation"]) {
        const columns = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
          `SELECT COLUMN_NAME FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '${table}'`,
        );
        const names = columns.map((c) => c.COLUMN_NAME.toLowerCase());
        for (const forbidden of [
          ...NEVER_BUYER_PII,
          ...NO_MACHINERY_0M9,
          /* `refund` left the Order's list at Phase 1.9, which legitimately binds
             the seller refund-policy VERSION a sale was made under. That is a
             reference, not refund machinery and not PII — asserted positively
             below. It still holds for the other two tables, which gained
             nothing. */
          ...(table === "Order" ? [] : ["refund"]),
        ]) {
          expect(names.some((n) => n.includes(forbidden)), `${table}.${forbidden}`).toBe(false);
        }
      }
    });

    it("carries the seller refund policy as a reference, never as prose or money", async () => {
      const columns = await db.$queryRawUnsafe<
        Array<{ COLUMN_NAME: string; DATA_TYPE: string; IS_NULLABLE: string }>
      >(
        `SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'
            AND COLUMN_NAME LIKE '%efund%'`,
      );
      const byName = new Map(columns.map((c) => [c.COLUMN_NAME, c]));

      /* Exactly two, and both are identifiers. No text column, no amount, and no
         refund state — the version is authoritative and a copy would be a second
         answer able to disagree with what the buyer was shown. */
      expect([...byName.keys()].sort()).toEqual([
        "sellerRefundPolicyId",
        "sellerRefundPolicyVersion",
      ]);
      for (const column of columns) {
        expect(column.DATA_TYPE).toBe("varchar");
        /* NULLABLE, so Orders written before the binding existed stay valid and
           nothing is backfilled with terms their buyers never saw. */
        expect(column.IS_NULLABLE).toBe("YES");
      }
    });

    it("keeps settlement standing on 0M.T1's table rather than on the Order", async () => {
      const columns = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Order'`,
      );
      const names = columns.map((c) => c.COLUMN_NAME.toLowerCase());
      for (const forbidden of [
        "settlementstate",
        "fundsreceivedat",
        "settledat",
        "reversedat",
        "providertransactionref",
        "sellerproceedsminorunits",
        "monacadoretainedamountminorunits",
        "promoternetproceedsminorunits",
      ]) {
        expect(names.some((n) => n.includes(forbidden)), forbidden).toBe(false);
      }
      expect(names).toContain("quotedcommercialretailamountminorunits");
    });
  });

  describe("governed commerce approval", () => {
    it("refuses checkout when no governed approval exists", async () => {
      /* Seeded WITHOUT the approval the ordinary fixture records, so this is the
         state every participant starts in: assessed by nobody, cleared for
         nothing. */
      const seller = await seedActiveParticipant(["SELLER"]);
      const internalProductId = await seedProduct();
      const storefrontId = await seedStorefront(seller.participantId);
      const listing = await createSellerDirectListing(
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
      await forceListingActive(listing.record.internalListingId);
      const policyId = await seedPolicy();

      await expect(
        prepareCheckout(
          {
            internalListingId: listing.record.internalListingId,
            buyerAccountId: null,
            ...NO_CHARGES,
            currency: "USD",
            ...UPSTREAM,
            placedAt: CHECKOUT_AT,
          },
          policyId,
          { db },
        ),
      ).rejects.toMatchObject({ blockingReasons: ["STOREFRONT_NOT_PUBLICLY_ACCESSIBLE"] });

      // Absence is a refusal, not silence.
      expect(await getCurrentCommerceApproval(seller.participantId, { db })).toBeNull();
    });

    it("permits an otherwise-eligible checkout once approval is recorded", async () => {
      const seller = await seedActiveParticipant(["SELLER"]);
      const internalProductId = await seedProduct();
      const storefrontId = await seedStorefront(seller.participantId);
      const listing = await createSellerDirectListing(
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
      await forceListingActive(listing.record.internalListingId);
      const policyId = await seedPolicy();

      const request = {
        internalListingId: listing.record.internalListingId,
        buyerAccountId: null,
        ...NO_CHARGES,
        currency: "USD",
        ...UPSTREAM,
        placedAt: CHECKOUT_AT,
      };

      await expect(prepareCheckout(request, policyId, { db })).rejects.toBeTruthy();

      await approveCommerce(seller.participantId);

      const prepared = await prepareCheckout(request, policyId, { db });
      expect(prepared.quote.quotedCommercialRetailAmountMinorUnits).toBe(10_000);
    });

    it("gives a caller no way to supply or override approval", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();

      /* The field is gone from the input, so a caller passing it is refused
         outright by the strictObject rather than quietly ignored. */
      await expect(
        prepareCheckout(
          {
            internalListingId: listing.record.internalListingId,
            buyerAccountId: null,
            ...NO_CHARGES,
            currency: "USD",
            ...UPSTREAM,
            storefrontGoLiveApproval: "APPROVED",
            placedAt: CHECKOUT_AT,
          },
          policyId,
          { db },
        ),
      ).rejects.toMatchObject({ code: "INVALID_ORDER_INPUT" });

      await expect(
        placeOrder(
          {
            internalListingId: listing.record.internalListingId,
            buyerAccountId: null,
            ...NO_CHARGES,
            currency: "USD",
            ...UPSTREAM,
            storefrontGoLiveApproval: "APPROVED",
            placedAt: CHECKOUT_AT,
          },
          policyId,
          deps(),
        ),
      ).rejects.toMatchObject({ code: "INVALID_ORDER_INPUT" });
    });

    it("refuses an actor holding no participant:commerce-approve entitlement", async () => {
      const seller = await seedActiveParticipant(["SELLER"]);
      const bystander = await seedAccount();

      await expect(
        recordCommerceApproval(
          {
            participantId: seller.participantId,
            decision: "APPROVED",
            reasonCode: "REQUIREMENTS_MET",
            actingAccountId: bystander,
            decidedAt: NOW,
          },
          { db, ids: approvalIds },
        ),
      ).rejects.toBeInstanceOf(CommerceApprovalActorNotAuthorizedError);

      expect(await getCurrentCommerceApproval(seller.participantId, { db })).toBeNull();
    });

    it("refuses the neighbouring internal entitlements, which are not this one", async () => {
      const seller = await seedActiveParticipant(["SELLER"]);

      for (const capability of ["activation:review", "participant:restrict"] as const) {
        const actor = await seedAccount();
        await grantAccountEntitlement({ accountId: actor, capability, grantedAt: NOW }, { db });

        await expect(
          recordCommerceApproval(
            {
              participantId: seller.participantId,
              decision: "APPROVED",
              reasonCode: "REQUIREMENTS_MET",
              actingAccountId: actor,
              decidedAt: NOW,
            },
            { db, ids: approvalIds },
          ),
          capability,
        ).rejects.toMatchObject({ reasonCodes: ["INTERNAL_CAPABILITY_NOT_GRANTED"] });
      }
    });

    it("grants nothing through a marketplace role, ownership, or the account itself", async () => {
      /* A SELLER who owns the participant, is ACTIVE, and is authenticated — and
         still cannot clear themselves. Marketplace standing confers no internal
         capability, and separation of duties catches the rest. */
      const seller = await seedActiveParticipant(["SELLER", "PROMOTER", "BUYER"]);

      await expect(
        recordCommerceApproval(
          {
            participantId: seller.participantId,
            decision: "APPROVED",
            reasonCode: "REQUIREMENTS_MET",
            actingAccountId: seller.accountId,
            decidedAt: NOW,
          },
          { db, ids: approvalIds },
        ),
      ).rejects.toBeInstanceOf(CommerceApprovalActorNotAuthorizedError);

      /* Even holding the entitlement, an actor may not decide for the participant
         their OWN account owns — clearing yourself to take money is the decision
         that most needs a second person. */
      await grantAccountEntitlement(
        {
          accountId: seller.accountId,
          capability: "participant:commerce-approve",
          grantedAt: NOW,
        },
        { db },
      );
      await expect(
        recordCommerceApproval(
          {
            participantId: seller.participantId,
            decision: "APPROVED",
            reasonCode: "REQUIREMENTS_MET",
            actingAccountId: seller.accountId,
            decidedAt: NOW,
          },
          { db, ids: approvalIds },
        ),
      ).rejects.toMatchObject({ code: "COMMERCE_APPROVAL_SELF_ACTION_NOT_PERMITTED" });
    });

    it("persists the governed decision, its actor, and its history", async () => {
      const seller = await seedActiveParticipant(["SELLER"]);
      const approver = await seedCommerceApprover();

      const approved = await approveCommerce(seller.participantId, approver);
      expect(approved.approvalId).toMatch(COMMERCE_APPROVAL_ID_PATTERN);
      expect(approved).toMatchObject({
        participantId: seller.participantId,
        decision: "APPROVED",
        reasonCode: "REQUIREMENTS_MET",
        decidedAt: NOW,
        // The audit actor IS the identity the entitlement was evaluated against.
        decidedByAccountId: approver,
        supersededAt: null,
      });

      // Withdrawing supersedes rather than editing what stood.
      const withdrawn = await recordCommerceApproval(
        {
          participantId: seller.participantId,
          decision: "NOT_APPROVED",
          reasonCode: "WITHDRAWN_BY_MONACADO",
          actingAccountId: approver,
          decidedAt: LATER,
        },
        { db, ids: approvalIds },
      );
      expect(withdrawn.decision).toBe("NOT_APPROVED");

      const history = await listCommerceApprovals(seller.participantId, { db });
      expect(history).toHaveLength(2);
      const original = history.find((h) => h.approvalId === approved.approvalId)!;
      expect(original).toMatchObject({
        decision: "APPROVED",
        reasonCode: "REQUIREMENTS_MET",
        decidedByAccountId: approver,
        supersededAt: LATER,
      });

      // Exactly one decision is current.
      const current = await getCurrentCommerceApproval(seller.participantId, { db });
      expect(current?.approvalId).toBe(withdrawn.approvalId);
      expect(
        await db.participantCommerceApproval.count({
          where: { currentForParticipantId: seller.participantId },
        }),
      ).toBe(1);
    });

    it("stops selling the moment approval is withdrawn", async () => {
      const { listing, seller } = await seedSellerDirect();
      const policyId = await seedPolicy();
      const request = {
        internalListingId: listing.record.internalListingId,
        buyerAccountId: null,
        ...NO_CHARGES,
        currency: "USD",
        ...UPSTREAM,
        placedAt: CHECKOUT_AT,
      };

      await expect(prepareCheckout(request, policyId, { db })).resolves.toBeTruthy();

      const approver = await seedCommerceApprover();
      await recordCommerceApproval(
        {
          participantId: seller.participantId,
          decision: "NOT_APPROVED",
          reasonCode: "POLICY_CONCERN",
          actingAccountId: approver,
          decidedAt: LATER,
        },
        { db, ids: approvalIds },
      );

      await expect(prepareCheckout(request, policyId, { db })).rejects.toMatchObject({
        blockingReasons: ["STOREFRONT_NOT_PUBLICLY_ACCESSIBLE"],
      });
    });
  });

  describe("suite-scoped cleanup", () => {
    it("removes only this suite's rows", async () => {
      const { listing } = await seedSellerDirect();
      const policyId = await seedPolicy();
      await buy({ internalListingId: listing.record.internalListingId, policyId });

      const foreign = await db.order.count({
        where: { id: { not: { startsWith: `mon:order:${TAG}` } } },
      });

      await cleanup();

      expect(
        await db.order.count({ where: { id: { startsWith: `mon:order:${TAG}` } } }),
      ).toBe(0);
      expect(
        await db.order.count({ where: { id: { not: { startsWith: `mon:order:${TAG}` } } } }),
      ).toBe(foreign);
    });
  });
});
