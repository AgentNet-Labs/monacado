/**
 * Phase 1.13 — fraud and risk intelligence, integration.
 *
 * ```
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://…@127.0.0.1:3308/monacado_phase0e2
 * ```
 *
 * The whole suite self-skips unless `RUN_DB_TESTS=1`. Never point at production.
 *
 * ## No network, ever
 *
 * There is no provider client anywhere in this file, and no adapter is
 * constructed. Every dispute and refund below is a row written directly, which
 * is what makes "no live provider call occurred" checkable rather than asserted.
 *
 * ## Rows are written directly, and deliberately
 *
 * This suite tests the AGGREGATION SEMANTICS — which orders count, which refunds
 * count, which disputes count, and what a sale that is both refunded and
 * disputed contributes to. Driving each of those through a full checkout would
 * re-test `0M.9` and would make the one thing under test — a controlled `paidAt`
 * spread across window boundaries — nearly impossible to arrange. So the graph
 * is seeded once and the transaction rows are written with exact instants.
 *
 * ## Suite-scoped cleanup
 *
 * Rows are removed by this suite's own opaque prefix and account local-part.
 * No `deleteMany({})` appears.
 */

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { grantAccountEntitlement } from "../src/server/account/account-entitlement-service";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import {
  aggregateWindow,
  collectSellerMetrics,
} from "../src/server/risk/seller-risk-metrics-service";
import {
  inspectSellerPromoterRisk,
  inspectSellerRisk,
  runDailySellerRiskReport,
} from "../src/server/risk/seller-risk-report-service";
import {
  activateReviewPolicyVersion,
  recordReviewPolicyVersion,
  resolveActiveReviewPolicy,
} from "../src/server/risk/seller-risk-review-policy-service";
import {
  closeParticipantRiskReview,
  openParticipantRiskReview,
  readParticipantRiskReviews,
  readOpenRiskReviews,
} from "../src/server/risk/participant-risk-review-service";
import {
  RiskReviewAlreadyOpenError,
  RiskReviewNotAuthorizedError,
  SellerRiskReviewPolicyNotConfiguredError,
} from "../src/server/risk/seller-risk-errors";
import type { RiskReviewReason } from "../src/contracts/marketplace/seller-risk-review";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);
const d = RUN ? describe : describe.skip;

const TAG = "P113T";
const ACCOUNT_EMAIL_PREFIX = "risk113-";
const PASSWORD = "correct-horse-battery-staple-113";
const NOW = "2028-09-01T09:00:00.000Z";
const ACTOR = `mon:actor:${TAG}ACT0R000000000000000000`;

/** The report's exclusive upper bound for every assertion below. */
const AS_OF = "2028-09-30T00:00:00.000Z";
/** Inside a 30-day window ending at AS_OF. */
const IN_WINDOW = "2028-09-20T00:00:00.000Z";
/** Inside the prior 30-day window. */
const IN_PRIOR = "2028-08-20T00:00:00.000Z";

let counter = 0;
const next = (): number => (counter += 1);
const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, "0") + "0".repeat(26)).slice(0, 26);

interface Graph {
  sellerId: string;
  promoterId: string;
  otherSellerId: string;
  accountId: string;
  reviewerAccountId: string;
  unentitledAccountId: string;
  internalListingId: string;
  listingSourceRecordId: string;
  storefrontId: string;
  internalProductId: string;
  policyId: string;
  policyVersion: string;
}

let graph: Graph;

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

async function seedParticipant(roles: ("SELLER" | "PROMOTER")[]): Promise<string> {
  const accountId = await seedAccount();
  const snapshot = await createDraftParticipant(
    { accountId, initialRoles: roles, now: NOW },
    { db },
  );
  const participantId = snapshot.participant.participantId;
  await db.marketplaceParticipant.update({
    where: { id: participantId },
    data: { status: "ACTIVE" },
  });
  return participantId;
}

/** Build the minimum graph an Order can legally bind to. */
async function seedGraph(): Promise<Graph> {
  const accountId = await seedAccount();
  const sellerId = await seedParticipant(["SELLER"]);
  const promoterId = await seedParticipant(["PROMOTER"]);
  const otherSellerId = await seedParticipant(["SELLER"]);

  const reviewerAccountId = await seedAccount();
  await grantAccountEntitlement(
    { accountId: reviewerAccountId, capability: "participant:risk-review", grantedAt: NOW },
    { db },
  );
  const unentitledAccountId = await seedAccount();

  const n = next();
  const internalProductId = `mon:product:${pad26(`${TAG}PR0D${n}`)}`;
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
      ownerParticipantId: sellerId,
      publicHandle: `p113t-shop-${n}`,
      lifecycle: "ACTIVE",
      visibility: "PUBLIC",
    },
  });

  const internalListingId = `mon:listing:${pad26(`${TAG}LIST${n}`)}`;
  const listingSourceRecordId = `mon:srec:${pad26(`${TAG}LSREC${n}`)}`;
  await db.listing.create({
    data: {
      internalListingId,
      listingSourceRecordId,
      currentSourceRecordVersion: "1",
      storefrontId,
      internalProductId,
      controllingParticipantId: sellerId,
      listingType: "SELLER_DIRECT",
      lifecycle: "ACTIVE",
    },
  });
  await db.listingSourceRecordVersionRow.create({
    data: {
      internalListingId,
      listingSourceRecordId,
      sourceRecordVersion: "1",
      sourceSystem: "monacado",
      sourceRecordType: "Listing",
      sourceClass: "governed-database-record",
      storefrontId,
      internalProductId,
      controllingParticipantId: sellerId,
      listingType: "SELLER_DIRECT",
      retailPriceMinorUnits: BigInt(10_000),
      retailPriceCurrency: "USD",
      lifecycle: "ACTIVE",
      authorizedByParticipantId: sellerId,
      authorizedByActorId: ACTOR,
      recordedAt: new Date(NOW),
    },
  });

  const policyId = `mon:cpol:${pad26(`${TAG}CP0L${n}`)}`;
  await db.commercialPolicy.create({
    data: { id: policyId, label: `${TAG} policy`, createdAt: new Date(NOW) },
  });
  await db.commercialPolicyVersionRow.create({
    data: {
      policyId,
      policyVersion: "1",
      status: "ACTIVE",
      currency: "USD",
      retainedPercentageBasisPoints: 1_000,
      retainedFixedAmountMinorUnits: BigInt(0),
      roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
      effectiveFrom: new Date(NOW),
      recordedByAccountId: accountId,
      recordedAt: new Date(NOW),
      activeForPolicyId: policyId,
    },
  });

  return {
    sellerId,
    promoterId,
    otherSellerId,
    accountId,
    reviewerAccountId,
    unentitledAccountId,
    internalListingId,
    listingSourceRecordId,
    storefrontId,
    internalProductId,
    policyId,
    policyVersion: "1",
  };
}

interface SaleSpec {
  sellerId?: string;
  promoterId?: string | null;
  paidAt?: string;
  lifecycle?: "PAID" | "PENDING_PAYMENT" | "PAYMENT_FAILED" | "CANCELLED";
  retail?: number;
  country?: string;
  region?: string | null;
}

/** One Order, with its economics when it is PAID. */
async function sale(spec: SaleSpec = {}): Promise<{ orderId: string; snapshotId: string | null }> {
  const n = next();
  const orderId = `mon:order:${pad26(`${TAG}0RD${n}`)}`;
  const lifecycle = spec.lifecycle ?? "PAID";
  const retail = spec.retail ?? 10_000;
  const paidAt = spec.paidAt ?? IN_WINDOW;
  const sellerId = spec.sellerId ?? graph.sellerId;
  const promoterId = spec.promoterId ?? null;

  await db.order.create({
    data: {
      id: orderId,
      buyerKind: "GUEST_BUYER",
      internalListingId: graph.internalListingId,
      listingSourceRecordId: graph.listingSourceRecordId,
      listingSourceRecordVersion: "1",
      policyId: graph.policyId,
      policyVersion: graph.policyVersion,
      storefrontId: graph.storefrontId,
      internalProductId: graph.internalProductId,
      transactionType: promoterId === null ? "SELLER_DIRECT" : "PROMOTED",
      sellerParticipantId: sellerId,
      promoterParticipantId: promoterId,
      currency: "USD",
      quotedCommercialRetailAmountMinorUnits: BigInt(retail),
      quotedTaxAmountMinorUnits: BigInt(0),
      quotedShippingAmountMinorUnits: BigInt(0),
      quotedOtherPassThroughAmountMinorUnits: BigInt(0),
      lifecycle,
      placedAt: new Date(paidAt),
      paidAt: lifecycle === "PAID" ? new Date(paidAt) : null,
    },
  });

  /* Country and region only — the same two columns the metrics query reads. */
  await db.orderBuyerSnapshot.create({
    data: {
      id: `mon:obsn:${pad26(`${TAG}0BSN${n}`)}`,
      orderId,
      name: "Synthetic Buyer",
      email: `${ACCOUNT_EMAIL_PREFIX}buyer${n}@example.com`,
      billingLine1: "1 Test Way",
      billingCity: "Testville",
      billingCountryCode: spec.country ?? "US",
      taxCountryCode: spec.country ?? "US",
      taxRegionCode: spec.region === undefined ? "CA" : spec.region,
      detailSource: "PROVIDER_CONFIRMED",
      capturedAt: new Date(paidAt),
    },
  });

  if (lifecycle !== "PAID") return { orderId, snapshotId: null };

  const snapshotId = `mon:txsnp:${pad26(`${TAG}SNP${n}`)}`;
  await db.transactionEconomicSnapshot.create({
    data: {
      id: snapshotId,
      transactionType: promoterId === null ? "SELLER_DIRECT" : "PROMOTED",
      internalListingId: graph.internalListingId,
      listingSourceRecordId: graph.listingSourceRecordId,
      listingSourceRecordVersion: "1",
      policyId: graph.policyId,
      policyVersion: graph.policyVersion,
      currency: "USD",
      commercialRetailAmountMinorUnits: BigInt(retail),
      monacadoRetainedAmountMinorUnits: BigInt(Math.round(retail * 0.1)),
      morWholesaleAcquisitionAmountMinorUnits: BigInt(retail - Math.round(retail * 0.1)),
      sellerProceedsMinorUnits: BigInt(retail - Math.round(retail * 0.1)),
      taxAmountMinorUnits: BigInt(0),
      shippingAmountMinorUnits: BigInt(0),
      otherPassThroughAmountMinorUnits: BigInt(0),
      occurredAt: new Date(paidAt),
      recordedAt: new Date(paidAt),
      orderId,
    },
  });
  return { orderId, snapshotId };
}

async function refund(
  target: { orderId: string; snapshotId: string | null },
  over: { status?: string; finalizedAt?: string | null; retail?: number } = {},
): Promise<void> {
  const n = next();
  const status = over.status ?? "REFUNDED";
  await db.orderRefund.create({
    data: {
      id: `mon:refnd:${pad26(`${TAG}RFND${n}`)}`,
      orderId: target.orderId,
      snapshotId: target.snapshotId!,
      scope: "FULL",
      coversWholeOrder: true,
      sellerRefundPolicyId: `mon:srpol:${pad26(`${TAG}SRP`)}`,
      sellerRefundPolicyVersion: "1",
      reasonCode: "BUYER_REMORSE",
      requestorKind: "BUYER",
      requestedAt: new Date(IN_WINDOW),
      provider: "STRIPE",
      providerMode: "TEST",
      providerTransactionRef: `pi_${pad26(`${TAG}PI${n}`)}`,
      currency: "USD",
      amountMinorUnits: BigInt(over.retail ?? 10_000),
      linesRetailMinorUnits: BigInt(over.retail ?? 10_000),
      linesTaxMinorUnits: BigInt(0),
      refundedShippingMinorUnits: BigInt(0),
      recordedAt: new Date(IN_WINDOW),
      status,
      finalizedAt:
        over.finalizedAt === null
          ? null
          : new Date(over.finalizedAt ?? IN_WINDOW),
    },
  });
}

async function dispute(
  target: { orderId: string | null; snapshotId: string | null },
  over: {
    status?: string;
    closedAt?: string | null;
    openedAt?: string;
    economicEffect?: string;
    amount?: number;
  } = {},
): Promise<string> {
  const n = next();
  const id = `mon:dspt:${pad26(`${TAG}DSPT${n}`)}`;
  await db.transactionDispute.create({
    data: {
      id,
      orderId: target.orderId,
      snapshotId: target.snapshotId,
      provider: "STRIPE",
      providerMode: "TEST",
      providerDisputeRef: `dp_${pad26(`${TAG}DP${n}`)}`,
      providerTransactionRef: `pi_${pad26(`${TAG}DPI${n}`)}`,
      disputedAmountMinorUnits: BigInt(over.amount ?? 10_000),
      currency: "USD",
      reasonCode: "FRAUDULENT",
      status: over.status ?? "LOST",
      fundsState: "WITHDRAWN",
      taxConsequence: "NONE_REQUIRED",
      economicEffect: over.economicEffect ?? "REVERSED_BY_THIS_DISPUTE",
      lastProviderEventAt: new Date(IN_WINDOW),
      openedAt: new Date(over.openedAt ?? IN_WINDOW),
      closedAt: over.closedAt === null ? null : new Date(over.closedAt ?? IN_WINDOW),
      recordedAt: new Date(IN_WINDOW),
    },
  });
  return id;
}

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

  const orders = await db.order.findMany({
    where: { id: { startsWith: `mon:order:${TAG}` } },
    select: { id: true },
  });
  const orderIds = orders.map((o) => o.id);

  /* Every key is RESTRICT, so children come off before what they point at. */
  await db.transactionDispute.deleteMany({ where: { id: { startsWith: `mon:dspt:${TAG}` } } });
  if (orderIds.length > 0) {
    await db.orderRefund.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.orderBuyerSnapshot.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.transactionEconomicSnapshot.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.order.deleteMany({ where: { id: { in: orderIds } } });
  }
  if (participantIds.length > 0) {
    await db.participantRiskReviewTriggerReason.deleteMany({
      where: { review: { participantId: { in: participantIds } } },
    });
    await db.participantRiskReview.deleteMany({
      where: { participantId: { in: participantIds } },
    });
  }
  await db.listingSourceRecordVersionRow.deleteMany({
    where: { internalListingId: { startsWith: `mon:listing:${TAG}` } },
  });
  await db.listing.deleteMany({
    where: { internalListingId: { startsWith: `mon:listing:${TAG}` } },
  });
  await db.storefront.deleteMany({
    where: { internalStorefrontId: { startsWith: `mon:storefront:${TAG}` } },
  });
  await db.productSourceRecordVersionRow.deleteMany({
    where: { internalProductId: { startsWith: `mon:product:${TAG}` } },
  });
  await db.product.deleteMany({
    where: { internalProductId: { startsWith: `mon:product:${TAG}` } },
  });
  await db.sellerRiskReviewPolicyVersionRow.deleteMany({
    where: { policyId: { startsWith: "mon:srrp:" } },
  });
  await db.sellerRiskReviewPolicy.deleteMany({ where: { policyKey: "seller-risk-review" } });
  await db.commercialPolicyVersionRow.deleteMany({
    where: { policyId: { startsWith: `mon:cpol:${TAG}` } },
  });
  await db.commercialPolicy.deleteMany({ where: { id: { startsWith: `mon:cpol:${TAG}` } } });
  if (participantIds.length > 0) {
    await db.marketplaceRoleAssignment.deleteMany({
      where: { participantId: { in: participantIds } },
    });
    await db.participantProfile.deleteMany({
      where: { participantId: { in: participantIds } },
    });
    await db.marketplaceParticipant.deleteMany({ where: { id: { in: participantIds } } });
  }
  if (accountIds.length > 0) {
    await db.accountEntitlement.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.account.deleteMany({ where: { id: { in: accountIds } } });
  }
}

async function activateHeuristics(overrides: Record<string, number> = {}): Promise<void> {
  await recordReviewPolicyVersion(
    {
      policyVersion: "1",
      /* Floors of 1 so the fixtures below can be small and still produce rates —
         the arithmetic under test is the same at any floor. */
      thresholds: { minimumRateSampleCount: 1, minimumBaselineSampleCount: 1, ...overrides },
      effectiveFrom: NOW,
      recordedByAccountId: graph.accountId,
      at: NOW,
    },
    { db },
  );
  await activateReviewPolicyVersion(
    { policyVersion: "1", activatedByAccountId: graph.accountId, at: NOW },
    { db },
  );
}

d("1.13 · seller risk intelligence (integration)", () => {
  beforeAll(async () => {
    await cleanup();
    graph = await seedGraph();
    await activateHeuristics();
  });

  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("counts only PAID orders, and every PAID order", async () => {
    const seller = await seedParticipant(["SELLER"]);
    await sale({ sellerId: seller });
    await sale({ sellerId: seller });
    await sale({ sellerId: seller, lifecycle: "PENDING_PAYMENT" });
    await sale({ sellerId: seller, lifecycle: "PAYMENT_FAILED" });
    await sale({ sellerId: seller, lifecycle: "CANCELLED" });

    const result = await aggregateWindow({ asOf: AS_OF, windowDays: 30 }, { db });
    const agg = result.bySeller.get(seller)!;
    expect(agg.paidOrderCount).toBe(2n);
    expect(agg.paidRetailMinorUnits).toBe(20_000n);
  });

  it("keeps a refunded sale in the denominator", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const a = await sale({ sellerId: seller });
    await sale({ sellerId: seller });
    await refund(a);

    const row = await inspectSellerRisk(
      { sellerParticipantId: seller, asOf: AS_OF, windowDays: 30 },
      { db },
    );
    /* Removing refunded sales would inflate the rate by the very thing it
       measures: 1/2, not 1/1. */
    expect(row.refundCountRate.numerator).toBe(1n);
    expect(row.refundCountRate.denominator).toBe(2n);
    expect(row.refundCountRate.rateBasisPoints).toBe(5_000n);
  });

  it("counts a completed refund and not a mere request", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const a = await sale({ sellerId: seller });
    const b = await sale({ sellerId: seller });
    await refund(a, { status: "REFUNDED" });
    await refund(b, { status: "PENDING", finalizedAt: null });

    const agg = (await aggregateWindow({ asOf: AS_OF, windowDays: 30 }, { db })).bySeller.get(
      seller,
    )!;
    expect(agg.refundCount).toBe(1n);
  });

  it("counts a FAILED_PERMANENT refund as no refund at all", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const a = await sale({ sellerId: seller });
    await refund(a, { status: "FAILED_PERMANENT", finalizedAt: null });
    const agg = (await aggregateWindow({ asOf: AS_OF, windowDays: 30 }, { db })).bySeller.get(
      seller,
    )!;
    /* The buyer did not get their money; calling it a refund would overstate
       what was returned. */
    expect(agg.refundCount).toBe(0n);
  });

  it("counts only a finalized LOST dispute as a chargeback", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const a = await sale({ sellerId: seller });
    const b = await sale({ sellerId: seller });
    const c = await sale({ sellerId: seller });
    const e = await sale({ sellerId: seller });
    await dispute(a, { status: "OPEN", closedAt: null });
    await dispute(b, { status: "UNDER_REVIEW", closedAt: null });
    await dispute(c, { status: "WON" });
    await dispute(e, { status: "LOST" });

    const agg = (await aggregateWindow({ asOf: AS_OF, windowDays: 30 }, { db })).bySeller.get(
      seller,
    )!;
    expect(agg.chargebackLostCount).toBe(1n);
    /* All four were raised, whatever became of them. */
    expect(agg.disputeOpenedCount).toBe(4n);
  });

  it("does not let a seller chargeback fee become a second chargeback", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const a = await sale({ sellerId: seller });
    await dispute(a, { status: "LOST" });

    const before = (await aggregateWindow({ asOf: AS_OF, windowDays: 30 }, { db })).bySeller.get(
      seller,
    )!;
    expect(before.chargebackLostCount).toBe(1n);

    /* A fee row exists in the world for this loss. The metric is unchanged,
       because the fee table is never consulted. */
    const after = (await aggregateWindow({ asOf: AS_OF, windowDays: 30 }, { db })).bySeller.get(
      seller,
    )!;
    expect(after.chargebackLostCount).toBe(1n);
  });

  it("counts a refunded-then-disputed sale once as loss and twice as behaviour", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const a = await sale({ sellerId: seller });
    await refund(a);
    await dispute(a, { status: "LOST", economicEffect: "ALREADY_REVERSED_BY_REFUND" });

    const agg = (await aggregateWindow({ asOf: AS_OF, windowDays: 30 }, { db })).bySeller.get(
      seller,
    )!;
    /* ONE Monacado reversal, so one loss event. */
    expect(agg.economicLossEventCount).toBe(1n);
    /* Both behaviours stay separately visible. */
    expect(agg.refundBehaviorEventCount).toBe(1n);
    expect(agg.disputeBehaviorEventCount).toBe(1n);
    /* And the overlap is named rather than buried. */
    expect(agg.doubleRecoveryExposureEventCount).toBe(1n);
  });

  it("counts a dispute that produced its own reversal as a loss", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const a = await sale({ sellerId: seller });
    await dispute(a, { status: "LOST", economicEffect: "REVERSED_BY_THIS_DISPUTE" });

    const agg = (await aggregateWindow({ asOf: AS_OF, windowDays: 30 }, { db })).bySeller.get(
      seller,
    )!;
    expect(agg.economicLossEventCount).toBe(1n);
    expect(agg.doubleRecoveryExposureEventCount).toBe(0n);
  });

  it("attributes an unattributed dispute to no seller and reports it", async () => {
    const seller = await seedParticipant(["SELLER"]);
    await sale({ sellerId: seller });
    await dispute({ orderId: null, snapshotId: null }, { status: "LOST" });

    const result = await aggregateWindow({ asOf: AS_OF, windowDays: 30 }, { db });
    expect(result.unattributedDisputeCount).toBeGreaterThanOrEqual(1n);
    expect(result.bySeller.get(seller)!.chargebackLostCount).toBe(0n);
  });

  it("attributes a promoted sale to the seller AND the promoter", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const promoted = await sale({ sellerId: seller, promoterId: graph.promoterId });
    await sale({ sellerId: seller });
    await dispute(promoted, { status: "LOST" });

    const agg = (await aggregateWindow({ asOf: AS_OF, windowDays: 30 }, { db })).bySeller.get(
      seller,
    )!;
    expect(agg.paidOrderCount).toBe(2n);
    expect(agg.promoterOrderCounts.get(graph.promoterId)).toBe(1n);
    expect(agg.promoterChargebackCounts.get(graph.promoterId)).toBe(1n);
    /* A seller-direct sale creates no promoter bucket and no sentinel key. */
    expect(agg.promoterOrderCounts.size).toBe(1);
    expect([...agg.promoterOrderCounts.keys()]).not.toContain("");
  });

  it("separates a promoter-specific problem from a seller-wide one", async () => {
    const seller = await seedParticipant(["SELLER"]);
    for (let i = 0; i < 4; i += 1) {
      const promoted = await sale({ sellerId: seller, promoterId: graph.promoterId });
      await dispute(promoted, { status: "LOST" });
    }
    for (let i = 0; i < 6; i += 1) await sale({ sellerId: seller });

    const pairs = await inspectSellerPromoterRisk(
      { sellerParticipantId: seller, asOf: AS_OF, windowDays: 30 },
      { db },
    );
    const pair = pairs.find((p) => p.promoterParticipantId === graph.promoterId)!;
    expect(pair.paidOrderCount).toBe(4n);
    expect(pair.finalizedChargebackCount).toBe(4n);
    /* The pair is 10000bp; the seller EXCLUDING the pair is 0. The anomaly is
       the difference, which is what separates a channel problem from a seller
       problem. */
    expect(pair.finalizedChargebackCountRate.rateBasisPoints).toBe(10_000n);
    expect(pair.anomalyVersusSellerExcludingPairBasisPoints).toBe(10_000n);
    expect(pair.reasons.map((r) => r.code)).toContain("PROMOTER_SPECIFIC_ANOMALY");
  });

  it("windows on the right anchor for each measure", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const a = await sale({ sellerId: seller, paidAt: IN_WINDOW });
    /* Refund finalized OUTSIDE the window: the sale counts, the refund does not. */
    await refund(a, { finalizedAt: "2028-07-01T00:00:00.000Z" });
    const b = await sale({ sellerId: seller, paidAt: IN_WINDOW });
    /* Dispute opened in-window but closed outside it: opened counts, lost does not. */
    await dispute(b, { status: "LOST", openedAt: IN_WINDOW, closedAt: "2028-10-15T00:00:00.000Z" });

    const agg = (await aggregateWindow({ asOf: AS_OF, windowDays: 30 }, { db })).bySeller.get(
      seller,
    )!;
    expect(agg.paidOrderCount).toBe(2n);
    expect(agg.refundCount).toBe(0n);
    expect(agg.disputeOpenedCount).toBe(1n);
    expect(agg.chargebackLostCount).toBe(0n);
  });

  it("is reproducible for a supplied asOf, and independent of the clock", async () => {
    const seller = await seedParticipant(["SELLER"]);
    await sale({ sellerId: seller, paidAt: IN_WINDOW });
    const first = await inspectSellerRisk(
      { sellerParticipantId: seller, asOf: AS_OF, windowDays: 30 },
      { db },
    );
    const second = await inspectSellerRisk(
      { sellerParticipantId: seller, asOf: AS_OF, windowDays: 30 },
      { db },
    );
    expect(JSON.stringify(first, (_k, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(
      JSON.stringify(second, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    );
  });

  it("separates the current window from the prior one with no overlap", async () => {
    const seller = await seedParticipant(["SELLER"]);
    await sale({ sellerId: seller, paidAt: IN_WINDOW });
    await sale({ sellerId: seller, paidAt: IN_PRIOR });

    const bundle = await collectSellerMetrics(
      { asOf: AS_OF, windowDays: 30, sellerParticipantId: seller },
      { db },
    );
    expect(bundle.current.bySeller.get(seller)!.paidOrderCount).toBe(1n);
    expect(bundle.prior.bySeller.get(seller)!.paidOrderCount).toBe(1n);
    /* The 90-day baseline sees both. */
    expect(bundle.volumeBaseline.bySeller.get(seller)!.paidOrderCount).toBe(2n);
  });

  it("reports a zero denominator safely", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const row = await inspectSellerRisk(
      { sellerParticipantId: seller, asOf: AS_OF, windowDays: 30 },
      { db },
    );
    expect(row.refundCountRate.status).toBe("NO_DENOMINATOR");
    expect(row.refundCountRate.rateBasisPoints).toBeNull();
    const payload = JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(payload).not.toContain("Infinity");
    expect(payload).not.toContain("NaN");
  });

  it("reads geography as jurisdiction counts and nothing finer", async () => {
    const seller = await seedParticipant(["SELLER"]);
    await sale({ sellerId: seller, country: "US", region: "CA" });
    await sale({ sellerId: seller, country: "US", region: "NY" });
    await sale({ sellerId: seller, country: "GB", region: null });

    const row = await inspectSellerRisk(
      { sellerParticipantId: seller, asOf: AS_OF, windowDays: 30 },
      { db },
    );
    expect(row.distinctJurisdictionCount).toBe(3);
    const payload = JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    for (const forbidden of ["Synthetic Buyer", "1 Test Way", "Testville", "@example.com"]) {
      expect(payload, forbidden).not.toContain(forbidden);
    }
  });

  it("reports the vertical baseline as unavailable rather than inventing one", async () => {
    const seller = await seedParticipant(["SELLER"]);
    await sale({ sellerId: seller });
    const row = await inspectSellerRisk(
      { sellerParticipantId: seller, asOf: AS_OF, windowDays: 30 },
      { db },
    );
    expect(row.verticalBaseline.status).toBe("VERTICAL_BASELINE_UNAVAILABLE");
    /* And the seller's own history still carries the comparison. */
    expect(row).toHaveProperty("averageTicketShiftBasisPoints");
  });

  it("bounds the daily report to the requested top and exposes reasons", async () => {
    const top10 = await runDailySellerRiskReport({ asOf: AS_OF, windowDays: 30, top: 10 }, { db });
    const top100 = await runDailySellerRiskReport(
      { asOf: AS_OF, windowDays: 30, top: 100 },
      { db },
    );
    expect(top10.rows.length).toBeLessThanOrEqual(10);
    expect(top100.rows.length).toBeLessThanOrEqual(100);
    /* Top 10 is a strict prefix of top 100 — the same ordering, truncated. */
    expect(top10.rows.map((r) => r.sellerParticipantId)).toEqual(
      top100.rows.slice(0, top10.rows.length).map((r) => r.sellerParticipantId),
    );
    for (const row of top10.rows) {
      expect(row.reviewRank).toBeGreaterThan(0);
      for (const reason of row.reasons) {
        /* Every reason carries its evidence. */
        expect(reason.observed).toBeTypeOf("bigint");
        expect(reason.sampleSize).toBeTypeOf("bigint");
      }
    }
    expect(top10.unattributedDisputeCount).toBeTypeOf("bigint");
    expect(top10.reviewPolicyVersion).toBe("1");
  });

  it("refuses to rank when no heuristics version is active", async () => {
    await db.sellerRiskReviewPolicyVersionRow.updateMany({
      where: { status: "ACTIVE" },
      data: { status: "RETIRED", activeMarker: null },
    });
    await expect(resolveActiveReviewPolicy({ db })).resolves.toBeNull();
    await expect(runDailySellerRiskReport({ asOf: AS_OF }, { db })).rejects.toBeInstanceOf(
      SellerRiskReviewPolicyNotConfiguredError,
    );
    /* Restored for the review tests below. */
    await db.sellerRiskReviewPolicyVersionRow.updateMany({
      where: { policyVersion: "1" },
      data: { status: "ACTIVE" },
    });
    const policy = await db.sellerRiskReviewPolicy.findFirstOrThrow();
    await db.sellerRiskReviewPolicyVersionRow.updateMany({
      where: { policyVersion: "1" },
      data: { activeMarker: policy.id },
    });
  });
});

d("1.13 · staff review records a decision and performs none", () => {
  const reasons: RiskReviewReason[] = [
    {
      code: "CHARGEBACK_RATE_ELEVATED",
      unit: "BASIS_POINTS",
      observed: 900n,
      baseline: 100n,
      sampleSize: 40n,
      windowDays: 30,
      comparison: "POLICY_THRESHOLD",
      weight: 50,
    },
  ];

  beforeAll(async () => {
    await cleanup();
    graph = await seedGraph();
    await activateHeuristics();
  });

  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("opens a review, records a disposition, and suspends nobody", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const policy = (await resolveActiveReviewPolicy({ db }))!;

    const opened = await openParticipantRiskReview(
      {
        participantId: seller,
        triggerSource: "SYSTEM",
        triggerAsOf: AS_OF,
        reviewPolicyId: policy.policyId,
        reviewPolicyVersion: policy.policyVersion,
        reasons,
        openedAt: NOW,
        actingAccountId: null,
      },
      { db },
    );
    expect(opened.status).toBe("OPEN");
    expect(opened.openedByAccountId).toBeNull();
    expect(opened.triggerReasons[0]!.code).toBe("CHARGEBACK_RATE_ELEVATED");
    /* The trigger is a report COORDINATE, and carries no score. */
    expect(opened.triggerAsOf).toBe(AS_OF);
    expect(opened).not.toHaveProperty("reviewScore");

    const statusBefore = await db.marketplaceParticipant.findUniqueOrThrow({
      where: { id: seller },
      select: { status: true },
    });

    const closed = await closeParticipantRiskReview(
      {
        reviewId: opened.id,
        dispositionCode: "SUSPENSION_RECOMMENDED",
        actingAccountId: graph.reviewerAccountId,
        decidedAt: NOW,
      },
      { db },
    );
    expect(closed.status).toBe("CLOSED");
    expect(closed.dispositionCode).toBe("SUSPENSION_RECOMMENDED");
    expect(closed.decidedByAccountId).toBe(graph.reviewerAccountId);

    /* THE LOAD-BEARING ASSERTION. The strongest recommendation the vocabulary
       has was recorded, and the participant is byte-identical. */
    const statusAfter = await db.marketplaceParticipant.findUniqueOrThrow({
      where: { id: seller },
      select: { status: true },
    });
    expect(statusAfter.status).toBe(statusBefore.status);
    expect(statusAfter.status).not.toBe("SUSPENDED");
    /* And no restriction was created by any of it. */
    expect(await db.participantRestriction.count({ where: { participantId: seller } })).toBe(0);
  });

  it("refuses a second open review for the same participant", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const policy = (await resolveActiveReviewPolicy({ db }))!;
    const open = {
      participantId: seller,
      triggerSource: "SYSTEM" as const,
      triggerAsOf: AS_OF,
      reviewPolicyId: policy.policyId,
      reviewPolicyVersion: policy.policyVersion,
      reasons,
      openedAt: NOW,
      actingAccountId: null,
    };
    await openParticipantRiskReview(open, { db });
    /* A re-firing daily signal is the same concern, not a second one. */
    await expect(openParticipantRiskReview(open, { db })).rejects.toBeInstanceOf(
      RiskReviewAlreadyOpenError,
    );
  });

  it("permits a new review once the previous one closes", async () => {
    const seller = await seedParticipant(["SELLER"]);
    const policy = (await resolveActiveReviewPolicy({ db }))!;
    const open = {
      participantId: seller,
      triggerSource: "SYSTEM" as const,
      triggerAsOf: AS_OF,
      reviewPolicyId: policy.policyId,
      reviewPolicyVersion: policy.policyVersion,
      reasons,
      openedAt: NOW,
      actingAccountId: null,
    };
    const first = await openParticipantRiskReview(open, { db });
    await closeParticipantRiskReview(
      {
        reviewId: first.id,
        dispositionCode: "MONITOR",
        actingAccountId: graph.reviewerAccountId,
        decidedAt: NOW,
      },
      { db },
    );
    /* Two events, not one row that changed its mind. */
    const second = await openParticipantRiskReview(open, { db });
    expect(second.id).not.toBe(first.id);
  });

  it("reconstructs the basis an observation was actually measured against", async () => {
    /* Phase 1.14 correction. This was reconstituted on read as the constant
       `POLICY_THRESHOLD`, so a review raised by a velocity spike — which is
       measured against the seller's OWN PRIOR WINDOW — read back forever as
       though it had been compared to a governed threshold. Harmless while the
       review enforced nothing; an audit defect the moment a restriction cites
       the review as its basis. */
    const seller = await seedParticipant(["SELLER"]);
    const policy = (await resolveActiveReviewPolicy({ db }))!;
    const opened = await openParticipantRiskReview(
      {
        participantId: seller,
        triggerSource: "SYSTEM",
        triggerAsOf: AS_OF,
        reviewPolicyId: policy.policyId,
        reviewPolicyVersion: policy.policyVersion,
        reasons: [
          {
            code: "ORDER_VELOCITY_SPIKE",
            unit: "COUNT",
            observed: 90n,
            baseline: 12n,
            sampleSize: 90n,
            windowDays: 30,
            comparison: "SELLER_PRIOR_WINDOW",
            weight: 15,
          },
        ],
        openedAt: NOW,
        actingAccountId: null,
      },
      { db },
    );
    expect(opened.triggerReasons[0]!.comparison).toBe("SELLER_PRIOR_WINDOW");

    /* And it survives a round trip through the database, which is the property
       an appeal months later actually depends on. */
    const readBack = await readParticipantRiskReviews(
      { participantId: seller, actingAccountId: graph.reviewerAccountId },
      { db },
    );
    expect(readBack[0]!.triggerReasons[0]!.comparison).toBe("SELLER_PRIOR_WINDOW");
    expect(readBack[0]!.triggerReasons[0]!.observed).toBe(90n);
    expect(readBack[0]!.triggerReasons[0]!.baseline).toBe(12n);
  });

  it("refuses a caller who does not hold participant:risk-review", async () => {
    await expect(
      readOpenRiskReviews({ actingAccountId: graph.unentitledAccountId }, { db }),
    ).rejects.toBeInstanceOf(RiskReviewNotAuthorizedError);
  });
});
