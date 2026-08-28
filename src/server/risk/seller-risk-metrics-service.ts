/**
 * Seller risk metrics (Phase 1.13) — SERVER ONLY.
 *
 * A DETERMINISTIC READ MODEL over rows that already exist. It creates no
 * financial authority, stores nothing, and writes nowhere: every figure it
 * returns is recomputed from `Order`, `TransactionEconomicSnapshot`,
 * `OrderRefund`, and `TransactionDispute` each time it is asked. That is what
 * lets a future risk model recalculate history — nothing was summarised away —
 * and it is why a report can never disagree with the transactions it describes.
 *
 * ## Reproducible from `asOf`, never from the clock
 *
 * Every instant this module uses is supplied. Two runs with the same `asOf` over
 * the same rows return the same values whatever the wall clock says, which is
 * what makes a historical review explicable months later. There is no
 * `new Date()` anywhere in this file.
 *
 * ## Attribution comes from the Order, never from current state
 *
 * `Order.sellerParticipantId` and `Order.promoterParticipantId` are the parties
 * as they were AT THE SALE. Nothing here joins to a current Storefront, Product,
 * or Offer row to work out whose sale it was: on a PROMOTED sale the Listing's
 * controller is the promoter and not the seller, so "who owns the listing now"
 * is both a different question and a mutable answer.
 *
 * ## What is deliberately read, and what is deliberately not
 *
 * Geography is read as `taxCountryCode` and `taxRegionCode` and nothing else.
 * `OrderBuyerSnapshot` also holds a name, an email, address lines, and postal
 * codes; a risk system is the classic route to accumulating exactly those, so
 * the `select` below is explicit and a test asserts the forbidden fields never
 * appear in it.
 *
 * ## Three windows, one pass each
 *
 * Current, prior (for velocity and deviation), and a trailing 90-day baseline
 * (for volume spikes). Orders are fetched once per window with their snapshot
 * and buyer jurisdiction attached; refunds and disputes are fetched by their own
 * anchors, because a refund's window is when the money went back and a
 * chargeback's is when the loss became final — different instants from the sale.
 */

import "../server-only";
import {
  jurisdictionKey,
  priorWindow,
  windowEndingAt,
  type RiskWindow,
  type RiskWindowDays,
} from "../../contracts/marketplace/seller-risk-metrics";
import { getPrisma } from "../db/client";

export interface MetricsDeps {
  db?: ReturnType<typeof getPrisma>;
}

/** The trailing span a volume spike is judged against. */
export const VOLUME_BASELINE_DAYS = 90 as const;

/**
 * One seller's raw counts and sums for one window.
 *
 * NUMERATORS AND DENOMINATORS ONLY. No rate, no percentage, no score — those are
 * derived by the report from these, so there is exactly one place the arithmetic
 * happens and exactly one set of numbers it happened to.
 */
export interface SellerWindowAggregate {
  sellerParticipantId: string;
  paidOrderCount: bigint;
  paidRetailMinorUnits: bigint;

  refundCount: bigint;
  refundRetailMinorUnits: bigint;

  disputeOpenedCount: bigint;
  chargebackLostCount: bigint;
  chargebackLostMinorUnits: bigint;

  /** The four disjoint adverse-event measures. See `ADVERSE_EVENT_MEASURES`. */
  economicLossEventCount: bigint;
  refundBehaviorEventCount: bigint;
  disputeBehaviorEventCount: bigint;
  doubleRecoveryExposureEventCount: bigint;

  /** Jurisdiction key -> paid order count. Country and region only. */
  jurisdictionCounts: Map<string, bigint>;
  /** Promoter participant id -> paid order count. Seller-direct is not a key. */
  promoterOrderCounts: Map<string, bigint>;
  promoterRefundCounts: Map<string, bigint>;
  promoterChargebackCounts: Map<string, bigint>;
}

export interface WindowAggregateResult {
  window: RiskWindow;
  bySeller: Map<string, SellerWindowAggregate>;
  /**
   * Disputes Monacado could not attribute to a sale, and therefore to a seller.
   *
   * `TransactionDispute.orderId` is nullable by design — an unattributable
   * provider dispute is still a real withdrawal, and discarding it is how a
   * chargeback becomes invisible. Counted here and reported beside every rate so
   * the exclusion is visible; NEVER imputed to a seller, because a guess inside a
   * fraud metric is worse than a gap, having the shape of evidence.
   */
  unattributedDisputeCount: bigint;
}

function emptyAggregate(sellerParticipantId: string): SellerWindowAggregate {
  return {
    sellerParticipantId,
    paidOrderCount: 0n,
    paidRetailMinorUnits: 0n,
    refundCount: 0n,
    refundRetailMinorUnits: 0n,
    disputeOpenedCount: 0n,
    chargebackLostCount: 0n,
    chargebackLostMinorUnits: 0n,
    economicLossEventCount: 0n,
    refundBehaviorEventCount: 0n,
    disputeBehaviorEventCount: 0n,
    doubleRecoveryExposureEventCount: 0n,
    jurisdictionCounts: new Map(),
    promoterOrderCounts: new Map(),
    promoterRefundCounts: new Map(),
    promoterChargebackCounts: new Map(),
  };
}

function bump(map: Map<string, bigint>, key: string, by = 1n): void {
  map.set(key, (map.get(key) ?? 0n) + by);
}

function aggregateFor(
  bySeller: Map<string, SellerWindowAggregate>,
  sellerId: string,
): SellerWindowAggregate {
  const existing = bySeller.get(sellerId);
  if (existing !== undefined) return existing;
  const created = emptyAggregate(sellerId);
  bySeller.set(sellerId, created);
  return created;
}

/**
 * Aggregate one window.
 *
 * `sellerParticipantId` narrows every query when a single seller is being
 * inspected, so the drill-down commands do not read the whole marketplace to
 * answer a question about one participant.
 */
export async function aggregateWindow(
  input: { asOf: string; windowDays: RiskWindowDays; sellerParticipantId?: string },
  deps: MetricsDeps = {},
): Promise<WindowAggregateResult> {
  const db = deps.db ?? getPrisma();
  const window = windowEndingAt(input.asOf, input.windowDays, "ORDER_PAID_AT");
  const from = new Date(window.startExclusive);
  const to = new Date(window.endInclusive);
  const bySeller = new Map<string, SellerWindowAggregate>();

  // — Denominator: PAID orders, anchored on paidAt. —
  //
  // INCLUDES sales later refunded or charged back: they were real sales, and
  // removing them would inflate every rate by exactly the thing it measures.
  const orders = await db.order.findMany({
    where: {
      lifecycle: "PAID",
      paidAt: { gt: from, lte: to },
      ...(input.sellerParticipantId ? { sellerParticipantId: input.sellerParticipantId } : {}),
    },
    select: {
      id: true,
      sellerParticipantId: true,
      promoterParticipantId: true,
      economicSnapshot: { select: { commercialRetailAmountMinorUnits: true } },
      /* Country and region ONLY. No name, email, address line, or postal code
         is selected here, and a test asserts this select never grows one. */
      orderBuyerSnapshot: { select: { taxCountryCode: true, taxRegionCode: true } },
    },
  });

  for (const order of orders) {
    const agg = aggregateFor(bySeller, order.sellerParticipantId);
    agg.paidOrderCount += 1n;
    /* Value comes from the SNAPSHOT, never from Order.quoted*, which is what the
       buyer was told rather than what the sale was. */
    agg.paidRetailMinorUnits += order.economicSnapshot?.commercialRetailAmountMinorUnits ?? 0n;

    if (order.orderBuyerSnapshot !== null) {
      bump(
        agg.jurisdictionCounts,
        jurisdictionKey(
          order.orderBuyerSnapshot.taxCountryCode,
          order.orderBuyerSnapshot.taxRegionCode,
        ),
      );
    }
    /* A seller-direct sale has NO promoter and gets no bucket. It is never
       coalesced to a sentinel id, the same refusal ProceedsObligation makes
       when it declines to write a zero promoter row. */
    if (order.promoterParticipantId !== null) {
      bump(agg.promoterOrderCounts, order.promoterParticipantId);
    }
  }

  // — Refund numerator: COMPLETED refunds, anchored on finalizedAt. —
  //
  // `REFUNDED` only. A PENDING, IN_PROGRESS, RETRY_PENDING, or FAILED_PERMANENT
  // row is a REQUEST — and a buyer whose refund failed permanently did not get
  // their money, so counting it as a refund would overstate what was returned.
  const refunds = await db.orderRefund.findMany({
    where: {
      status: "REFUNDED",
      finalizedAt: { gt: from, lte: to },
      ...(input.sellerParticipantId
        ? { order: { sellerParticipantId: input.sellerParticipantId } }
        : {}),
    },
    select: {
      /* Retail only. `amountMinorUnits` includes returned tax and shipping,
         which are not in the commercial-retail denominator; pairing them would
         let a fully-refunded book of sales exceed 100%. */
      linesRetailMinorUnits: true,
      order: { select: { sellerParticipantId: true, promoterParticipantId: true } },
    },
  });

  for (const refund of refunds) {
    const agg = aggregateFor(bySeller, refund.order.sellerParticipantId);
    agg.refundCount += 1n;
    agg.refundRetailMinorUnits += refund.linesRetailMinorUnits;
    agg.refundBehaviorEventCount += 1n;
    /* A completed refund IS an economic loss to Monacado. A dispute arriving
       later on the same sale does not add a second one — see below. */
    agg.economicLossEventCount += 1n;
    if (refund.order.promoterParticipantId !== null) {
      bump(agg.promoterRefundCounts, refund.order.promoterParticipantId);
    }
  }

  // — Disputes opened in the window, anchored on the provider's openedAt. —
  const opened = await db.transactionDispute.findMany({
    where: {
      openedAt: { gt: from, lte: to },
      ...(input.sellerParticipantId
        ? { order: { sellerParticipantId: input.sellerParticipantId } }
        : {}),
    },
    select: { orderId: true, order: { select: { sellerParticipantId: true } } },
  });

  let unattributedDisputeCount = 0n;
  for (const dispute of opened) {
    if (dispute.orderId === null || dispute.order === null) {
      unattributedDisputeCount += 1n;
      continue;
    }
    aggregateFor(bySeller, dispute.order.sellerParticipantId).disputeOpenedCount += 1n;
  }

  // — Chargeback numerator: FINALIZED LOSSES, anchored on closedAt. —
  //
  // `LOST` only. OPEN, NEEDS_RESPONSE, UNDER_REVIEW, WON, CLOSED, and
  // MANUAL_REMEDIATION_REQUIRED are NOT chargebacks: a dispute in flight is not
  // a loss and a won dispute is the opposite of one.
  //
  // `SellerChargebackFee` is not consulted anywhere in this module. One
  // finalized loss produces one fee, so counting both would double every
  // seller's chargeback count — and the fee is absent for unattributed losses
  // and when no fee policy stands, so it is not even a complete count of the
  // thing it is not.
  const lost = await db.transactionDispute.findMany({
    where: {
      status: "LOST",
      closedAt: { gt: from, lte: to },
      ...(input.sellerParticipantId
        ? { order: { sellerParticipantId: input.sellerParticipantId } }
        : {}),
    },
    select: {
      orderId: true,
      disputedAmountMinorUnits: true,
      economicEffect: true,
      order: { select: { sellerParticipantId: true, promoterParticipantId: true } },
    },
  });

  for (const dispute of lost) {
    if (dispute.orderId === null || dispute.order === null) {
      /* Counted once, under `unattributedDisputeCount`, if it was not already
         counted as opened in this window. It reaches no seller either way. */
      continue;
    }
    const agg = aggregateFor(bySeller, dispute.order.sellerParticipantId);
    agg.chargebackLostCount += 1n;
    agg.chargebackLostMinorUnits += dispute.disputedAmountMinorUnits;
    agg.disputeBehaviorEventCount += 1n;
    if (dispute.order.promoterParticipantId !== null) {
      bump(agg.promoterChargebackCounts, dispute.order.promoterParticipantId);
    }

    /* THE DOUBLE-EVENT RULE, and the only place it is applied.
       A sale refunded and THEN disputed is a real double-payment exposure in the
       world but exactly ONE Monacado reversal — which is why 1.11 records
       `economicEffect` at all. So the loss counter moves only when this dispute
       is what produced the reversal; when a refund already had, the sale is
       named under `doubleRecoveryExposureEventCount` instead. The sale therefore
       contributes at most once to the one measure that claims financial loss,
       while both behaviours stay separately visible. */
    if (dispute.economicEffect === "ALREADY_REVERSED_BY_REFUND") {
      agg.doubleRecoveryExposureEventCount += 1n;
    } else if (dispute.economicEffect === "REVERSED_BY_THIS_DISPUTE") {
      agg.economicLossEventCount += 1n;
    }
  }

  return { window, bySeller, unattributedDisputeCount };
}

export interface SellerMetricsBundle {
  current: WindowAggregateResult;
  prior: WindowAggregateResult;
  /** The trailing span a volume spike is judged against. */
  volumeBaseline: WindowAggregateResult;
}

/**
 * The three passes a ranked report needs.
 *
 * `prior` is the adjacent, equal-length, non-overlapping window — the seller's
 * own recent past, which is the ONLY baseline this phase compares against.
 * Comparing a seller to other sellers would need a norm nobody has governed, and
 * inventing one is what `VERTICAL_BASELINE_UNAVAILABLE` exists to refuse.
 */
export async function collectSellerMetrics(
  input: { asOf: string; windowDays: RiskWindowDays; sellerParticipantId?: string },
  deps: MetricsDeps = {},
): Promise<SellerMetricsBundle> {
  const current = await aggregateWindow(input, deps);
  const priorSpec = priorWindow(current.window);
  const prior = await aggregateWindow(
    {
      asOf: priorSpec.endInclusive,
      windowDays: input.windowDays,
      sellerParticipantId: input.sellerParticipantId,
    },
    deps,
  );
  const volumeBaseline = await aggregateWindow(
    {
      asOf: input.asOf,
      windowDays: VOLUME_BASELINE_DAYS,
      sellerParticipantId: input.sellerParticipantId,
    },
    deps,
  );
  return { current, prior, volumeBaseline };
}

export function aggregateOrEmpty(
  result: WindowAggregateResult,
  sellerId: string,
): SellerWindowAggregate {
  return result.bySeller.get(sellerId) ?? emptyAggregate(sellerId);
}
