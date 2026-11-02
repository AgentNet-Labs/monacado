/**
 * Phase 1.46 — the first complete promoted sale, against a real database.
 *
 *   - STOREFRONT GO-LIVE: the owner takes a draft Storefront ACTIVE + PUBLIC
 *     through the route; a governor without commerce approval is told why; a
 *     stranger gets 404; a second go-live is 409.
 *   - THE SALE: a package-based promoted Listing, drafted, priced, and activated
 *     through the Promoter's routes, is checked out through the executable
 *     checkout and completed by the Stripe webhook. The Order freezes the
 *     governed authority; the snapshot records it; the economics are the gate's;
 *     one SELLER and one PROMOTER obligation, to the right parties; the
 *     snapshot reconstructs from its immutable sources after the Listing moves.
 *   - NO RE-GATING AFTER PAYMENT: a Listing withdrawn between placement and
 *     payment still completes under its binding.
 *   - THE GATE: no acceptance → refused with the package blocker, no Order; the
 *     public buyer view withholds every party-describing blocker.
 *   - BINDING INTEGRITY: a forged or absent binding is refused by the snapshot
 *     service.
 *   - PRIVACY: the buyer view carries no participant identity.
 *   - RISK-POLICY BOOTSTRAP and the OPERATOR CLIs: governed, idempotent, never
 *     overriding.
 */

import "dotenv/config";
import { randomInt } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import {
  handleActivateOfferRequest,
  handleCreateOfferRequest,
  type OfferRouteResult,
} from "../src/server/marketplace/offer-route-handler";
import { handleSetProductResaleAvailabilityRequest } from "../src/server/product/product-resale-availability-route-handler";
import {
  handleAcceptOfferPackageRequest,
  handleDecidePromotionAuthorizationRequest,
  handleRequestPromotionAuthorizationRequest,
  type PromotionAuthorizationRouteResult,
} from "../src/server/marketplace/promotion-authorization-route-handler";
import {
  readPromoterOfferPackageByRefIn,
  type PromoterOfferPackageView,
} from "../src/server/marketplace/promotion-offer-acceptance-read-service";
import { readPromotedListingCommerceIn, resolvePromotedListingPolicy } from "../src/server/marketplace/promoted-listing-service";
import {
  handleActivatePromotedListingRequest,
  handleCreatePromotedListingRequest,
  handleWithdrawPromotedListingRequest,
} from "../src/server/marketplace/promoted-listing-route-handler";
import { openOwnedDraftStorefront } from "../src/server/marketplace/storefront-service";
import { handleGoLiveStorefrontRequest } from "../src/server/marketplace/storefront-go-live-route-handler";
import { prepareCheckout } from "../src/server/marketplace/checkout-service";
import { ListingNotPurchasableError } from "../src/server/marketplace/order-errors";
import { getOrder, listProceedsObligations } from "../src/server/marketplace/order-service";
import {
  reconstructTransactionEconomics,
  recordTransactionEconomicSnapshot,
} from "../src/server/marketplace/transaction-accounting-service";
import {
  CorruptTransactionRecordError,
  TransactionEconomicsRefusedError,
} from "../src/server/marketplace/transaction-accounting-errors";
import {
  activateCommercialPolicyVersion,
  createCommercialPolicy,
  recordCommercialPolicyVersion,
} from "../src/server/marketplace/commercial-policy-service";
import { recordCommerceApproval } from "../src/server/marketplace/participant-commerce-approval-service";
import { beginCheckout } from "../src/server/payments/executable-checkout-service";
import { handleStripeWebhookRequest } from "../src/server/payments/stripe-webhook-route-handler";
import { readListingCheckoutView } from "../src/server/payments/listing-checkout-view";
import { createZeroRateTaxAdapter } from "../src/server/tax/tax-adapters";
import { createCapturingMailAdapter } from "../src/server/notifications/mail-port";
import {
  RiskPolicyBootstrapRefusedError,
  bootstrapRiskPolicy,
} from "../src/server/risk/risk-policy-bootstrap";
import type {
  BuyerPaymentConfirmation,
  BuyerPaymentInitiationPort,
  BuyerPaymentRequest,
} from "../src/contracts/marketplace/buyer-payment";
import { main as operatorCommerceCommand } from "../scripts/operator-commerce";
import { main as riskPolicyBootstrapCommand } from "../scripts/risk-policy-bootstrap";
import {
  ensureSellerRefundPolicy,
  ensureShippedMarketplacePolicyActive,
  verifyPrimarySupportContact,
} from "./support/marketplace-policy-fixture";
import { sellerCommerceFixture, type FixtureActor } from "./support/seller-commerce-fixture";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2030-03-01T09:00:00.000Z";
const ORIGIN = "https://monacado.test";
const PREFIX = "p146sale";
const LOCAL_ENV = { DATABASE_URL: process.env.DATABASE_URL };

const fx = sellerCommerceFixture({ db, emailPrefix: PREFIX, now: NOW, origin: ORIGIN });

let clock = Date.parse("2030-03-02T09:00:00.000Z");
const next = (): string => new Date((clock += 10 * 60_000)).toISOString();

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const opaque = (): string => Array.from({ length: 26 }, () => CROCKFORD[randomInt(32)]).join("");

const seededCommercialPolicies: string[] = [];
const seededRiskPolicies: string[] = [];

// — Seller side, through the real routes —

interface Listed {
  seller: FixtureActor;
  productRef: string;
  internalProductId: string;
  offerRef: string;
}

const STALE_CONFIRMATION = {
  version: "9",
  calculatedCommissionMinorUnits: 0,
  calculatedSellerGrossProceedsMinorUnits: 0,
  commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
};
/** $40.00 wholesale, 10% → a $4.00 commission. */
const TERMS = { wholesalePrice: "40.00", currency: "USD", commission: { method: "PERCENT_OF_WHOLESALE", percent: "10" } };

function offerCall(
  handler: typeof handleCreateOfferRequest,
  seller: FixtureActor,
  refs: { productRef: string; offerRef?: string },
  body: Record<string, unknown>,
): Promise<OfferRouteResult> {
  const now = next();
  return handler(
    { ...refs, contentType: "application/json", originHeader: ORIGIN, cookieHeader: seller.cookieHeader, rawBody: JSON.stringify(body) },
    { db, now: () => now, appOrigin: ORIGIN },
  );
}

async function listed(): Promise<Listed> {
  const seller = await fx.readySeller();
  /* Checkout's own Seller prerequisites — Phase 1.46 records these as
     workarounds: there is no refund-policy or support-contact UI yet. */
  await verifyPrimarySupportContact(db, { participantId: seller.participantId, accountId: seller.accountId, now: NOW });
  await ensureSellerRefundPolicy(db, {
    sellerParticipantId: seller.participantId,
    recordedByAccountId: seller.accountId,
    now: NOW,
    policyId: `mon:srpol:${seller.participantId.slice(-26)}`,
  });
  const product = await fx.activeProduct(seller);
  const set = await handleSetProductResaleAvailabilityRequest(
    {
      productRef: product.productRef,
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader: seller.cookieHeader,
      rawBody: JSON.stringify({ resaleAvailability: "AVAILABLE" }),
    },
    { db, now: next, appOrigin: ORIGIN },
  );
  expect(set.status).toBe(200);
  const created = await offerCall(handleCreateOfferRequest, seller, { productRef: product.productRef }, { terms: TERMS });
  expect(created.status).toBe(201);
  const item = { seller, ...product, offerRef: created.body.offerRef as string };
  const refs = { productRef: item.productRef, offerRef: item.offerRef };
  const asked = await offerCall(handleActivateOfferRequest, seller, refs, { confirmation: STALE_CONFIRMATION });
  expect(asked.status).toBe(409);
  const done = await offerCall(handleActivateOfferRequest, seller, refs, { confirmation: asked.body.disclosure });
  expect(done.status, JSON.stringify(done.body)).toBeLessThan(300);
  return item;
}

function cycleCall(
  handler: typeof handleAcceptOfferPackageRequest,
  actor: FixtureActor,
  item: Listed,
  authorizationRef: string,
  body: unknown,
  now = next(),
): Promise<PromotionAuthorizationRouteResult> {
  return handler(
    { productRef: item.productRef, authorizationRef, contentType: "application/json", originHeader: ORIGIN, cookieHeader: actor.cookieHeader, rawBody: JSON.stringify(body) },
    { db, now: () => now, appOrigin: ORIGIN },
  );
}

async function approvedAndAccepted(promoter: FixtureActor, item: Listed, opts: { accept: boolean }): Promise<void> {
  const r = await handleRequestPromotionAuthorizationRequest(
    { productRef: item.productRef, contentType: "application/json", originHeader: ORIGIN, cookieHeader: promoter.cookieHeader, rawBody: "{}" },
    { db, now: next, appOrigin: ORIGIN },
  );
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const ref = r.body.authorizationRef as string;
  expect((await cycleCall(handleDecidePromotionAuthorizationRequest, item.seller, item, ref, { decision: "APPROVE" })).status).toBe(200);
  if (!opts.accept) return;
  const at = next();
  const v: PromoterOfferPackageView | null = await db.$transaction((tx) =>
    readPromoterOfferPackageByRefIn(tx, { authorizationRef: ref, promoterParticipantId: promoter.participantId }, at),
  );
  expect(v).not.toBeNull();
  const promotion = v!.promotion === null ? null : (({ inForce: _d, ...rest }) => rest)(v!.promotion);
  const accepted = await cycleCall(handleAcceptOfferPackageRequest, promoter, item, ref, { offerRef: v!.offerRef, standing: v!.standing, promotion }, at);
  expect(accepted.status, JSON.stringify(accepted.body)).toBeLessThan(300);
}

// — Policies —

/** The configured checkout policy: 7.5% of retail + $1.00, HALF_UP. */
async function configuredPolicy(): Promise<string> {
  const governor = await fx.seedOperator("commercial-policy:govern");
  const policy = await createCommercialPolicy({ label: `P146 policy ${next()}`, now: NOW }, { db });
  seededCommercialPolicies.push(policy.policyId);
  await recordCommercialPolicyVersion(
    {
      policyId: policy.policyId,
      policyVersion: "1",
      currency: "USD",
      retainedPercentageBasisPoints: 750,
      retainedFixedAmountMinorUnits: 100,
      roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
      effectiveFrom: NOW,
      recordedByAccountId: governor,
      recordedAt: NOW,
    },
    { db },
  );
  await activateCommercialPolicyVersion(
    { policyId: policy.policyId, policyVersion: "1", activatedByAccountId: governor, activatedAt: NOW },
    { db },
  );
  process.env.MONACADO_CHECKOUT_POLICY_ID = policy.policyId;
  return policy.policyId;
}

const RISK_CONTROLS = {
  currency: "USD",
  maxSingleOrderCommercialAmountMinorUnits: 50_000,
  requireSellerCommerceApproval: true,
  requireSellerPaymentReadiness: true,
};

/** Through the Phase 1.46 governed bootstrap, held by a separate staff account. */
async function riskPolicy(): Promise<string> {
  const staff = await fx.seedOperator("risk-policy:govern");
  const policyId = `mon:rpol:${opaque()}`;
  seededRiskPolicies.push(policyId);
  const outcome = await bootstrapRiskPolicy({ actorAccountId: staff, policyId, controls: RISK_CONTROLS, now: NOW }, { db });
  expect(outcome).toEqual({ outcome: "ACTIVATED", policyId, policyVersion: "1" });
  return policyId;
}

// — Storefront go-live, through the route —

let handles = 0;
const goLive = (actor: FixtureActor, publicHandle: string, rawBody = "{}") =>
  handleGoLiveStorefrontRequest(
    { publicHandle, contentType: "application/json", originHeader: ORIGIN, cookieHeader: actor.cookieHeader, rawBody },
    { db, now: next, appOrigin: ORIGIN },
  );

async function draftStorefront(owner: FixtureActor): Promise<string> {
  handles += 1;
  const publicHandle = `p146-shop-${handles}-${randomInt(1_000_000)}`;
  await openOwnedDraftStorefront(
    {
      publicHandle,
      presentation: { displayName: "Promoter Shop", tagline: null, summary: null },
      actingAccountId: owner.accountId,
      now: next(),
    },
    { db },
  );
  return publicHandle;
}

// — The promoted Listing, through the Promoter's routes —

const listingCall = (
  handler: (r: never, d: never) => Promise<{ status: number; body: Record<string, unknown> }>,
  actor: FixtureActor,
  ref: { productRef: string } | { listingRef: string },
  body: unknown,
) =>
  handler(
    { ...ref, contentType: "application/json", originHeader: ORIGIN, cookieHeader: actor.cookieHeader, rawBody: JSON.stringify(body) } as never,
    { db, now: next, appOrigin: ORIGIN } as never,
  );

interface Scene {
  item: Listed;
  promoter: FixtureActor;
  policyId: string;
  riskPolicyId: string;
  listingRef: string;
  internalListingId: string;
}

async function scene(opts: { accept?: boolean; activate?: boolean } = {}): Promise<Scene> {
  const item = await listed();
  const promoter = await fx.readyParticipant(["PROMOTER"]);
  await approvedAndAccepted(promoter, item, { accept: opts.accept !== false });
  const policyId = await configuredPolicy();
  const riskPolicyId = await riskPolicy();
  const handle = await draftStorefront(promoter);
  expect((await goLive(promoter, handle)).status).toBe(200);

  const created = await listingCall(handleCreatePromotedListingRequest as never, promoter, { productRef: item.productRef }, {
    storefrontHandle: handle,
    retail: { amount: "59.00", currency: "USD" },
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const listingRef = created.body.listingRef as string;
  if (opts.activate !== false) {
    const activated = await listingCall(handleActivatePromotedListingRequest as never, promoter, { listingRef }, {
      expectedVersion: created.body.version,
    });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
  }
  const listing = await db.listing.findUniqueOrThrow({ where: { listingRef }, select: { internalListingId: true } });
  return { item, promoter, policyId, riskPolicyId, listingRef, internalListingId: listing.internalListingId };
}

// — Checkout and the webhook —

const BUYER_DETAILS = {
  name: "Synthetic Buyer",
  email: "p146-buyer@example.test",
  billingAddress: { line1: "1 Test Street", line2: null, city: "Testville", region: "CA", postalCode: "94000", countryCode: "US" },
  shippingAddress: { line1: "9 Delivery Road", line2: null, city: "Shipton", region: "NY", postalCode: "10001", countryCode: "US" },
} as const;

const checkoutInput = (internalListingId: string, placedAt: string) => ({
  internalListingId,
  buyerAccountId: null,
  taxAmountMinorUnits: 0,
  shippingAmountMinorUnits: 0,
  otherPassThroughAmountMinorUnits: 0,
  currency: "USD" as const,
  productAvailability: "available" as const,
  placedAt,
});

function initiationDouble(): BuyerPaymentInitiationPort & { requests: BuyerPaymentRequest[] } {
  const requests: BuyerPaymentRequest[] = [];
  return {
    requests,
    async initiatePayment(request) {
      requests.push(request);
      const sessionId = `cs_test_${opaque()}`;
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

async function begin(s: Scene, placedAt = next()) {
  const port = initiationDouble();
  const begun = await beginCheckout(
    checkoutInput(s.internalListingId, placedAt),
    s.policyId,
    { provider: "STRIPE", port, taxPort: createZeroRateTaxAdapter(), riskPolicyId: s.riskPolicyId, buyerDetails: BUYER_DETAILS },
    { db },
  );
  return { begun, port };
}

const succeeded = (orderId: string, at: string): BuyerPaymentConfirmation => ({
  disposition: "PAYMENT_RESULT",
  orderId,
  provider: "STRIPE",
  buyerContact: { email: BUYER_DETAILS.email },
  result: { outcome: "SUCCEEDED", provider: "STRIPE", providerTransactionRef: `pi_${opaque()}` },
  confirmedDetails: null,
  providerEventRef: `evt_${opaque()}`,
  observedAt: at,
});

const webhook = (confirmation: BuyerPaymentConfirmation) => {
  const at = next();
  return handleStripeWebhookRequest(
    { rawBody: "{}", signatureHeader: "t=1,v1=irrelevant-the-port-is-injected" },
    { db, port: { confirmPayment: async () => ({ ...confirmation, observedAt: at }) }, mail: createCapturingMailAdapter(), now: () => at },
  );
};

const rejection = async (p: Promise<unknown>) => await p.then(() => undefined, (e: unknown) => e);

// — Cleanup: only this suite's rows, children first —

async function cleanup(): Promise<void> {
  delete process.env.MONACADO_CHECKOUT_POLICY_ID;
  const accountIds = (await db.account.findMany({ where: { email: { startsWith: PREFIX } }, select: { id: true } })).map((a) => a.id);
  const participantIds = (
    await db.marketplaceParticipant.findMany({ where: { accountId: { in: accountIds } }, select: { id: true } })
  ).map((p) => p.id);
  const storefrontIds = (
    await db.storefront.findMany({ where: { ownerParticipantId: { in: participantIds } }, select: { internalStorefrontId: true } })
  ).map((s) => s.internalStorefrontId);
  const listingIds = (
    await db.listing.findMany({
      where: { OR: [{ storefrontId: { in: storefrontIds } }, { controllingParticipantId: { in: participantIds } }] },
      select: { internalListingId: true },
    })
  ).map((l) => l.internalListingId);
  const orderIds = (await db.order.findMany({ where: { internalListingId: { in: listingIds } }, select: { id: true } })).map((o) => o.id);

  if (orderIds.length > 0) {
    await db.notificationDelivery.deleteMany({ where: { subjectKind: "ORDER", subjectRef: { in: orderIds } } });
    await db.outboundEmailDelivery.deleteMany({ where: { subjectKind: "ORDER", subjectRef: { in: orderIds } } });
    await db.transactionReversal.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.orderTaxTransaction.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.orderTaxEvidence.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.orderRefundContactEvidence.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.orderBuyerSnapshot.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.reviewSubmissionAuthority.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.purchaseEvidence.deleteMany({ where: { orderId: { in: orderIds } } });
    const snapshotIds = (
      await db.transactionEconomicSnapshot.findMany({ where: { internalListingId: { in: listingIds } }, select: { id: true } })
    ).map((s) => s.id);
    await db.proceedsObligation.deleteMany({ where: { snapshotId: { in: snapshotIds } } });
    await db.transactionSettlement.deleteMany({ where: { snapshotId: { in: snapshotIds } } });
    await db.transactionEconomicSnapshot.deleteMany({ where: { id: { in: snapshotIds } } });
    await db.notificationObligation.deleteMany({ where: { subjectRef: { in: orderIds } } });
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
  }
  /* Snapshots written directly (binding-integrity tests) have no Order. */
  const orphanSnapshots = (
    await db.transactionEconomicSnapshot.findMany({ where: { internalListingId: { in: listingIds } }, select: { id: true } })
  ).map((s) => s.id);
  await db.transactionSettlement.deleteMany({ where: { snapshotId: { in: orphanSnapshots } } });
  await db.transactionEconomicSnapshot.deleteMany({ where: { id: { in: orphanSnapshots } } });

  await db.notificationDelivery.deleteMany({ where: { recipientParticipantId: { in: participantIds } } });
  await db.outboundEmailDelivery.deleteMany({ where: { recipientParticipantId: { in: participantIds } } });
  await db.listingSourceRecordVersionRow.deleteMany({ where: { internalListingId: { in: listingIds } } });
  await db.listing.deleteMany({ where: { internalListingId: { in: listingIds } } });
  await db.storefrontGovernanceAssignment.deleteMany({ where: { internalStorefrontId: { in: storefrontIds } } });
  await db.storefrontSourceRecordVersionRow.deleteMany({ where: { internalStorefrontId: { in: storefrontIds } } });
  await db.storefront.deleteMany({ where: { internalStorefrontId: { in: storefrontIds } } });
  await db.sellerRefundPolicyVersionRow.deleteMany({ where: { sellerParticipantId: { in: participantIds } } });
  await db.sellerRefundPolicy.deleteMany({ where: { sellerParticipantId: { in: participantIds } } });

  await db.commercialPolicyVersionRow.deleteMany({ where: { policyId: { in: seededCommercialPolicies } } });
  await db.commercialPolicy.deleteMany({ where: { id: { in: seededCommercialPolicies } } });
  seededCommercialPolicies.length = 0;
  await db.riskPolicyVersionRow.deleteMany({ where: { policyId: { in: seededRiskPolicies } } });
  await db.riskPolicy.deleteMany({ where: { id: { in: seededRiskPolicies } } });
  seededRiskPolicies.length = 0;
  await fx.cleanup();
}

const describeDb = RUN ? describe : describe.skip;

describeDb("Phase 1.46 — first complete promoted sale", () => {
  beforeAll(async () => {
    await cleanup();
    await ensureShippedMarketplacePolicyActive(db, { recordedByAccountId: await fx.seedOperator("marketplace-policy:govern"), now: NOW });
  });
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  describe("Storefront go-live", () => {
    it("takes the owner's draft Storefront ACTIVE and PUBLIC through the authoritative version path", async () => {
      const owner = await fx.readyParticipant(["PROMOTER"]);
      const handle = await draftStorefront(owner);
      const live = await goLive(owner, handle);
      expect(live).toMatchObject({ status: 200, body: { publicHandle: handle, lifecycle: "ACTIVE", visibility: "PUBLIC" } });
      expect(JSON.stringify(live.body)).not.toMatch(/mon:/);
      const stable = await db.storefront.findUniqueOrThrow({ where: { publicHandle: handle } });
      expect(stable).toMatchObject({ lifecycle: "ACTIVE", visibility: "PUBLIC", currentSourceRecordVersion: "2" });
      /* History is untouched: version 1 is still the DRAFT + PRIVATE it was. */
      expect(
        await db.storefrontSourceRecordVersionRow.findFirstOrThrow({
          where: { internalStorefrontId: stable.internalStorefrontId, sourceRecordVersion: "1" },
        }),
      ).toMatchObject({ lifecycle: "DRAFT", visibility: "PRIVATE" });

      expect(await goLive(owner, handle)).toMatchObject({ status: 409, body: { error: "STOREFRONT_ALREADY_LIVE" } });
    });

    it("tells a governor why it cannot go live, answers a stranger 404, and refuses a body", async () => {
      const owner = await fx.readyParticipant(["PROMOTER"]);
      const handle = await draftStorefront(owner);
      expect(await goLive(owner, handle, JSON.stringify({ lifecycle: "ACTIVE" }))).toMatchObject({ status: 400 });

      const stranger = await fx.readyParticipant(["PROMOTER"]);
      expect(await goLive(stranger, handle)).toMatchObject({ status: 404, body: { error: "STOREFRONT_NOT_FOUND" } });

      await recordCommerceApproval(
        {
          participantId: owner.participantId,
          decision: "NOT_APPROVED",
          reasonCode: "WITHDRAWN_BY_MONACADO",
          actingAccountId: await fx.seedOperator("participant:commerce-approve"),
          decidedAt: next(),
        },
        { db },
      );
      expect(await goLive(owner, handle)).toMatchObject({
        status: 403,
        body: { error: "STOREFRONT_GO_LIVE_REFUSED", blockers: ["GO_LIVE_NOT_APPROVED"] },
      });
      expect(await db.storefront.findUniqueOrThrow({ where: { publicHandle: handle } })).toMatchObject({ lifecycle: "DRAFT" });
    });
  });

  describe("the sale", () => {
    it("checks out, completes on the webhook, and binds the governed authority end to end", async () => {
      const s = await scene();
      const placedAt = next();

      /* The gate's own answer at the checkout instant is the oracle. */
      const policy = await resolvePromotedListingPolicy(db);
      const gate = await db.$transaction((tx) =>
        readPromotedListingCommerceIn(tx, { internalListingId: s.internalListingId, at: placedAt, policy, purpose: "TRANSACTION" }),
      );
      expect(gate.eligible).toBe(true);
      const bound = gate.bound!;

      const prepared = await prepareCheckout(checkoutInput(s.internalListingId, placedAt), s.policyId, { db });
      expect(prepared).toMatchObject({
        transactionType: "PROMOTED",
        sellerParticipantId: s.item.seller.participantId,
        promoterParticipantId: s.promoter.participantId,
        promotedBinding: {
          promotionAuthorizationId: bound.authorizationId,
          promotionOfferAcceptanceId: bound.acceptance.id,
          offerSourceRecordId: bound.governing.offerSourceRecordId,
          offerSourceRecordVersion: bound.governing.economicsVersion,
        },
        quote: { quotedCommercialRetailAmountMinorUnits: 5_900 },
      });

      const { begun, port } = await begin(s, placedAt);
      expect(begun.order.lifecycle).toBe("PENDING_PAYMENT");
      expect(port.requests[0]!.amountMinorUnits).toBe(5_900);
      const orderRow = await db.order.findUniqueOrThrow({ where: { id: begun.order.orderId } });
      expect(orderRow).toMatchObject({
        transactionType: "PROMOTED",
        sellerParticipantId: s.item.seller.participantId,
        promoterParticipantId: s.promoter.participantId,
        promotionAuthorizationId: bound.authorizationId,
        promotionOfferAcceptanceId: bound.acceptance.id,
        promotedOfferSourceRecordId: bound.governing.offerSourceRecordId,
        promotedOfferSourceRecordVersion: bound.governing.economicsVersion,
      });

      const response = await webhook(succeeded(begun.order.orderId, next()));
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ handled: true, disposition: "SALE_RECORDED" });
      expect((await getOrder(begun.order.orderId, { db })).lifecycle).toBe("PAID");

      const snapshot = await db.transactionEconomicSnapshot.findFirstOrThrow({ where: { orderId: begun.order.orderId } });
      expect(snapshot).toMatchObject({
        transactionType: "PROMOTED",
        promotionAuthorizationId: bound.authorizationId,
        promotionOfferAcceptanceId: bound.acceptance.id,
        offerSourceRecordId: bound.governing.offerSourceRecordId,
        offerSourceRecordVersion: bound.governing.economicsVersion,
      });

      /* $59.00 retail; 7.5% + $1.00 → $5.43 retained (442.5 rounds HALF_UP to
         443, plus 100); $40.00 wholesale less the $4.00 commission → $36.00 to
         the Seller; the rest, $17.57, to the Promoter. Equal to the gate's. */
      const { snapshot: record } = await reconstructTransactionEconomics(snapshot.id, { db });
      expect(record.commercialRetailAmountMinorUnits).toBe(5_900);
      expect(record.economics).toMatchObject({
        transactionType: "PROMOTED",
        monacadoRetainedAmountMinorUnits: 543,
        sellerProceedsMinorUnits: 3_600,
        promoterNetProceedsMinorUnits: 1_757,
        sellerFundedCommissionMinorUnits: 400,
        offerWholesalePriceMinorUnits: 4_000,
      });
      expect(record.economics).toMatchObject({
        monacadoRetainedAmountMinorUnits: bound.economics.monacadoRetainedAmountMinorUnits,
        promoterNetProceedsMinorUnits: bound.economics.promoterNetProceedsMinorUnits,
      });

      const obligations = await listProceedsObligations(snapshot.id, { db });
      expect(obligations.map((o) => [o.party, o.participantId, o.amountMinorUnits]).sort()).toEqual(
        [
          ["PROMOTER", s.promoter.participantId, 1_757],
          ["SELLER", s.item.seller.participantId, 3_600],
        ].sort(),
      );

      /* The Listing moves on; the sale's record does not. */
      expect((await listingCall(handleWithdrawPromotedListingRequest as never, s.promoter, { listingRef: s.listingRef }, {})).status).toBe(200);
      expect((await reconstructTransactionEconomics(snapshot.id, { db })).matches).toBe(true);
    });

    it("completes under its binding when the Listing is withdrawn between placement and payment", async () => {
      const s = await scene();
      const { begun } = await begin(s);
      expect((await listingCall(handleWithdrawPromotedListingRequest as never, s.promoter, { listingRef: s.listingRef }, {})).status).toBe(200);
      const response = await webhook(succeeded(begun.order.orderId, next()));
      expect(response.body).toMatchObject({ disposition: "SALE_RECORDED" });
      const snapshot = await db.transactionEconomicSnapshot.findFirstOrThrow({ where: { orderId: begun.order.orderId } });
      expect(snapshot.promotionOfferAcceptanceId).not.toBeNull();
      expect(snapshot.promoterNetProceedsMinorUnits).toBe(BigInt(1_757));
    });
  });

  describe("the gate", () => {
    it("refuses a Promoter that has not accepted the terms, writes no Order, and shows a buyer nothing about any party", async () => {
      const s = await scene({ accept: false, activate: false });
      /* Without acceptance the Listing cannot go live; force it ACTIVE so the
         TRANSACTION gate itself is what refuses. */
      const listing = await db.listing.findUniqueOrThrow({ where: { internalListingId: s.internalListingId } });
      await db.listing.update({ where: { internalListingId: s.internalListingId }, data: { lifecycle: "ACTIVE" } });
      await db.listingSourceRecordVersionRow.updateMany({
        where: { listingSourceRecordId: listing.listingSourceRecordId },
        data: { lifecycle: "ACTIVE" },
      });

      const before = await db.order.count();
      const refused = await rejection(prepareCheckout(checkoutInput(s.internalListingId, next()), s.policyId, { db }));
      expect(refused).toBeInstanceOf(ListingNotPurchasableError);
      expect((refused as ListingNotPurchasableError).blockingReasons).toContain("TERMS_NOT_ACCEPTED");
      expect(await rejection(begin(s))).toBeInstanceOf(ListingNotPurchasableError);
      expect(await db.order.count()).toBe(before);

      const view = await readListingCheckoutView({ internalListingId: s.internalListingId, policyId: s.policyId, now: next() }, { db });
      expect(view).toMatchObject({ purchasable: false, blockingReasons: [] });
    });

    it("shows the buyer a price and no participant identity for a purchasable promoted Listing", async () => {
      const s = await scene();
      const view = await readListingCheckoutView({ internalListingId: s.internalListingId, policyId: s.policyId, now: next() }, { db });
      expect(view).toEqual({
        internalListingId: s.internalListingId,
        purchasable: true,
        currency: "USD",
        buyerTotalMinorUnits: 5_900,
        blockingReasons: [],
      });
      const json = JSON.stringify(view);
      for (const secret of [s.item.seller.participantId, s.promoter.participantId, s.item.seller.accountId, s.promoter.accountId, PREFIX]) {
        expect(json).not.toContain(secret);
      }
      expect(json).not.toMatch(/mon:(mpart|acct|pauth|pofacc|offer|srec):/);
    });
  });

  describe("binding integrity", () => {
    it("refuses a package-based snapshot with a forged binding, or with none", async () => {
      const s = await scene();
      const prepared = await prepareCheckout(checkoutInput(s.internalListingId, next()), s.policyId, { db });
      const binding = prepared.promotedBinding!;
      const base = {
        internalListingId: s.internalListingId,
        listingSourceRecordVersion: prepared.listingSourceRecordVersion,
        policyId: prepared.policyId,
        policyVersion: prepared.policyVersion,
        currency: "USD",
        taxAmountMinorUnits: 0,
        shippingAmountMinorUnits: 0,
        otherPassThroughAmountMinorUnits: 0,
        occurredAt: next(),
        recordedAt: next(),
      };
      const { offerSourceRecordId, offerSourceRecordVersion, promotionAuthorizationId, promotionOfferAcceptanceId } = binding;
      const asInput = { promotionAuthorizationId, promotionOfferAcceptanceId, offerSourceRecordId, offerSourceRecordVersion };

      const none = await rejection(recordTransactionEconomicSnapshot(base, { db }));
      expect(none).toBeInstanceOf(TransactionEconomicsRefusedError);
      expect((none as TransactionEconomicsRefusedError).reason).toBe("PROMOTED_COMMERCE_NOT_ENABLED");

      const wrongVersion = await rejection(
        recordTransactionEconomicSnapshot({ ...base, promotedBinding: { ...asInput, offerSourceRecordVersion: "999" } }, { db }),
      );
      expect(wrongVersion).toBeInstanceOf(CorruptTransactionRecordError);

      const wrongAuthorization = await rejection(
        recordTransactionEconomicSnapshot({ ...base, promotedBinding: { ...asInput, promotionAuthorizationId: "mon:pauth:NOPE" } }, { db }),
      );
      expect(wrongAuthorization).toBeInstanceOf(CorruptTransactionRecordError);

      expect(await db.transactionEconomicSnapshot.count({ where: { internalListingId: s.internalListingId } })).toBe(0);
      const ok = await recordTransactionEconomicSnapshot({ ...base, promotedBinding: asInput }, { db });
      expect(ok.snapshot.economics.transactionType).toBe("PROMOTED");
    });
  });

  describe("risk-policy bootstrap and operator commands", () => {
    it("bootstraps only for a risk-policy:govern holder, is idempotent, and never overrides", async () => {
      const outsider = await fx.seedOperator("participant:commerce-approve");
      const staff = await fx.seedOperator("risk-policy:govern");
      const policyId = `mon:rpol:${opaque()}`;
      seededRiskPolicies.push(policyId);
      const input = { policyId, controls: RISK_CONTROLS, now: NOW };

      const refused = await rejection(bootstrapRiskPolicy({ ...input, actorAccountId: outsider }, { db }));
      expect(refused).toBeInstanceOf(RiskPolicyBootstrapRefusedError);
      expect((refused as RiskPolicyBootstrapRefusedError).refusal).toBe("ACTOR_NOT_AUTHORIZED");
      expect(await db.riskPolicy.count({ where: { id: policyId } })).toBe(0);

      expect(await bootstrapRiskPolicy({ ...input, actorAccountId: staff }, { db })).toEqual({ outcome: "ACTIVATED", policyId, policyVersion: "1" });
      expect(await bootstrapRiskPolicy({ ...input, actorAccountId: staff }, { db })).toEqual({ outcome: "ALREADY_ACTIVE", policyId, policyVersion: "1" });
      const conflicting = await rejection(
        bootstrapRiskPolicy({ ...input, actorAccountId: staff, controls: { ...RISK_CONTROLS, maxSingleOrderCommercialAmountMinorUnits: 1 } }, { db }),
      );
      expect((conflicting as RiskPolicyBootstrapRefusedError).refusal).toBe("CONFLICTING_ACTIVE_VERSION");
      expect(await db.riskPolicyVersionRow.count({ where: { policyId } })).toBe(1);
    });

    it("the CLIs dry-run by default and act only with the exact phrase", async () => {
      const out = async (command: typeof operatorCommerceCommand, argv: string[]) => {
        const lines: string[] = [];
        const code = await command(argv, LOCAL_ENV, (l) => lines.push(l), { db, now: next });
        expect(lines).toHaveLength(1);
        return { code, json: JSON.parse(lines[0]!) as Record<string, unknown> };
      };

      const staff = await fx.seedOperator("risk-policy:govern");
      const policyId = `mon:rpol:${opaque()}`;
      seededRiskPolicies.push(policyId);
      const riskArgs = ["--target=local", `--actor=${staff}`, `--policy-id=${policyId}`, "--max-order=50000"];
      const dry = await out(riskPolicyBootstrapCommand, riskArgs);
      expect(dry).toMatchObject({ code: 0, json: { result: "DRY_RUN", preflight: { actorAuthorized: true, policyExists: false } } });
      expect(await db.riskPolicy.count({ where: { id: policyId } })).toBe(0);
      const done = await out(riskPolicyBootstrapCommand, [...riskArgs, "--execute", `--confirm=${dry.json.confirmPhrase as string}`]);
      expect(done).toMatchObject({ code: 0, json: { result: "ACTIVATED", policyId } });

      const approver = await fx.seedOperator("participant:commerce-approve");
      const subject = await fx.draftParticipant(["PROMOTER"]);
      const approveArgs = ["commerce-approve", "--target=local", `--actor=${approver}`, `--participant=${subject.participantId}`];
      const dryApprove = await out(operatorCommerceCommand, approveArgs);
      expect(dryApprove.json).toMatchObject({ result: "DRY_RUN", preflight: { currentDecision: null } });
      expect(await out(operatorCommerceCommand, [...approveArgs, "--execute", "--confirm=yes"])).toMatchObject({ code: 2 });
      const approved = await out(operatorCommerceCommand, [...approveArgs, "--execute", `--confirm=${dryApprove.json.confirmPhrase as string}`]);
      expect(approved).toMatchObject({ code: 0, json: { result: "RECORDED" } });
      expect(await db.participantCommerceApproval.count({ where: { participantId: subject.participantId, decision: "APPROVED" } })).toBe(1);

      /* Self-action is the service's refusal, reported as such. */
      const selfArgs = ["commerce-approve", "--target=local", `--actor=${subject.accountId}`, `--participant=${subject.participantId}`];
      const selfDry = await out(operatorCommerceCommand, selfArgs);
      const self = await out(operatorCommerceCommand, [...selfArgs, "--execute", `--confirm=${selfDry.json.confirmPhrase as string}`]);
      expect(self).toMatchObject({ code: 1, json: { result: "REFUSED" } });

      const seller = await fx.readySeller();
      const product = await fx.draftProduct(seller);
      const classifier = await fx.seedOperator("product:tax-classify");
      const taxArgs = ["tax-classify", "--target=local", `--actor=${classifier}`, `--product-ref=${product.productRef}`, "--classification=PHYSICAL_GOOD"];
      const dryTax = await out(operatorCommerceCommand, taxArgs);
      expect(dryTax.json).toMatchObject({ result: "DRY_RUN", preflight: { productExists: true } });
      const classified = await out(operatorCommerceCommand, [...taxArgs, "--execute", `--confirm=${dryTax.json.confirmPhrase as string}`]);
      expect(classified).toMatchObject({ code: 0, json: { result: "CLASSIFIED", taxClassification: "PHYSICAL_GOOD" } });
      for (const line of [JSON.stringify(dry.json), JSON.stringify(approved.json), JSON.stringify(classified.json)]) {
        expect(line).not.toMatch(/mysql:|@example\.com/);
      }
    });
  });
});
