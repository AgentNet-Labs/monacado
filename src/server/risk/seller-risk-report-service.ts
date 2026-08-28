/**
 * The daily seller risk review (Phase 1.13) — SERVER ONLY.
 *
 * Turns the aggregates into a bounded, ranked, explainable list for Staff.
 *
 * ## Computed live, stored nowhere
 *
 * There is no report snapshot table, deliberately. The report is a pure function
 * of `asOf`, the active heuristics version, and immutable source rows, so the
 * coordinate REGENERATES exactly what a reviewer saw — which a stored copy could
 * not guarantee, because a stored copy can drift from the rows it came from and
 * then there are two answers with no way to adjudicate. A `ParticipantRiskReview`
 * therefore records the coordinate rather than the numbers.
 *
 * ## A rank is a request for attention
 *
 * The score is a deterministic integer sum of the weights of reasons that
 * actually fired. Nothing may act on it: no restriction, no hold, no status
 * change, and no path back into the Phase 1.2 transaction gate. A seller
 * suspended by arithmetic is the failure this phase exists to prevent, and
 * Marketplace Policy 1.2.0 does not authorise a participant-level consequence in
 * any case.
 *
 * ## Every reason carries its evidence
 *
 * `observed`, `baseline`, and `sampleSize` are required by the type, so
 * `volumeSpike: true` is structurally inexpressible. A reviewer can check every
 * number without leaving the row.
 *
 * ## No monetary amounts leave this module
 *
 * Rates, ratios, deviations, and counts. The operator surface has refused to
 * print purchase amounts since `refund:status`, and the reason is sharper here:
 * a risk ranking surfaces small-denominator sellers preferentially, so a
 * seller-level total with one sale behind it IS one buyer's purchase amount.
 */

import "../server-only";
import {
  DEFAULT_RISK_REPORT_TOP,
  RISK_REVIEW_REASON_WEIGHTS,
  compareRiskRows,
  reviewScoreFor,
  type DailySellerRiskReport,
  type RiskReviewReason,
  type RiskReviewReasonCode,
  type SellerPromoterRiskRow,
  type SellerRiskReviewRow,
  type RiskReportTopSelection,
} from "../../contracts/marketplace/seller-risk-review";
import {
  DEFAULT_RISK_WINDOW_DAYS,
  averageMinorUnits,
  deviationBasisPoints,
  rateBasisPoints,
  resolveVerticalBaseline,
  riskRate,
  topJurisdictionShareBasisPoints,
  type RiskWindow,
  type RiskWindowDays,
} from "../../contracts/marketplace/seller-risk-metrics";
import { getPrisma } from "../db/client";
import {
  VOLUME_BASELINE_DAYS,
  aggregateOrEmpty,
  collectSellerMetrics,
  type SellerWindowAggregate,
} from "./seller-risk-metrics-service";
import {
  resolveActiveReviewPolicy,
  type ActiveReviewPolicy,
} from "./seller-risk-review-policy-service";
import { SellerRiskReviewPolicyNotConfiguredError } from "./seller-risk-errors";

export interface ReportDeps {
  db?: ReturnType<typeof getPrisma>;
}

export interface DailyReportInput {
  asOf: string;
  windowDays?: RiskWindowDays;
  top?: RiskReportTopSelection;
}

function reason(
  code: RiskReviewReasonCode,
  unit: "COUNT" | "BASIS_POINTS",
  observed: bigint,
  baseline: bigint | null,
  sampleSize: bigint,
  windowDays: RiskWindowDays,
  comparison: "SELLER_PRIOR_WINDOW" | "SELLER_TRAILING_DAILY" | "POLICY_THRESHOLD",
): RiskReviewReason {
  return {
    code,
    unit,
    observed,
    baseline,
    sampleSize,
    windowDays,
    comparison,
    weight: RISK_REVIEW_REASON_WEIGHTS[code],
  };
}

/** Absolute value, so a collapse in volume is as visible as a surge. */
function magnitude(value: bigint | null): bigint | null {
  if (value === null) return null;
  return value < 0n ? -value : value;
}

function buildSellerRow(
  sellerParticipantId: string,
  current: SellerWindowAggregate,
  prior: SellerWindowAggregate,
  baseline: SellerWindowAggregate,
  window: RiskWindow,
  policy: ActiveReviewPolicy,
): SellerRiskReviewRow {
  const windowDays = window.days;
  const minSample = BigInt(policy.minimumRateSampleCount);
  const reasons: RiskReviewReason[] = [];

  const refundCountRate = riskRate(current.refundCount, current.paidOrderCount, window, minSample);
  const refundValueRate = riskRate(
    current.refundRetailMinorUnits,
    current.paidRetailMinorUnits,
    window,
    minSample,
  );
  const chargebackCountRate = riskRate(
    current.chargebackLostCount,
    current.paidOrderCount,
    window,
    minSample,
  );
  const chargebackValueRate = riskRate(
    current.chargebackLostMinorUnits,
    current.paidRetailMinorUnits,
    window,
    minSample,
  );
  /* A RATIO, not a share. It legitimately exceeds 10 000 basis points when a
     seller is disputed more often than refunded, which is the single most
     interesting case and would be hidden by clamping. */
  const chargebackToRefundRatio = riskRate(
    current.chargebackLostCount,
    current.refundCount,
    window,
    1n,
  );

  /* Baseline sufficiency gates every DEVIATION reason, never the rate reasons.
     A seller with no comparable past can still have an elevated chargeback rate;
     what they cannot have is a meaningful "change". */
  const baselineSufficient =
    prior.paidOrderCount >= BigInt(policy.minimumBaselineSampleCount);

  if (
    refundCountRate.status === "COMPUTED" &&
    refundCountRate.rateBasisPoints !== null &&
    refundCountRate.rateBasisPoints >= BigInt(policy.refundCountRateReviewBasisPoints)
  ) {
    reasons.push(
      reason(
        "REFUND_RATE_ELEVATED",
        "BASIS_POINTS",
        refundCountRate.rateBasisPoints,
        BigInt(policy.refundCountRateReviewBasisPoints),
        current.paidOrderCount,
        windowDays,
        "POLICY_THRESHOLD",
      ),
    );
  }

  if (
    chargebackCountRate.status === "COMPUTED" &&
    chargebackCountRate.rateBasisPoints !== null &&
    chargebackCountRate.rateBasisPoints >= BigInt(policy.chargebackCountRateReviewBasisPoints)
  ) {
    reasons.push(
      reason(
        "CHARGEBACK_RATE_ELEVATED",
        "BASIS_POINTS",
        chargebackCountRate.rateBasisPoints,
        BigInt(policy.chargebackCountRateReviewBasisPoints),
        current.paidOrderCount,
        windowDays,
        "POLICY_THRESHOLD",
      ),
    );
  }

  if (
    chargebackToRefundRatio.status === "COMPUTED" &&
    chargebackToRefundRatio.rateBasisPoints !== null &&
    chargebackToRefundRatio.rateBasisPoints >=
      BigInt(policy.chargebackToRefundRatioReviewBasisPoints)
  ) {
    reasons.push(
      reason(
        "CHARGEBACK_TO_REFUND_RATIO_ELEVATED",
        "BASIS_POINTS",
        chargebackToRefundRatio.rateBasisPoints,
        BigInt(policy.chargebackToRefundRatioReviewBasisPoints),
        current.refundCount,
        windowDays,
        "POLICY_THRESHOLD",
      ),
    );
  }

  /* Named separately from loss, and deliberately. A sale refunded AND charged
     back is one Monacado reversal but two recoveries in the buyer's hands — a
     strong pattern signal that is invisible if only the loss figure is read. */
  if (current.doubleRecoveryExposureEventCount > 0n) {
    reasons.push(
      reason(
        "DOUBLE_RECOVERY_EXPOSURE_PRESENT",
        "COUNT",
        current.doubleRecoveryExposureEventCount,
        0n,
        current.paidOrderCount,
        windowDays,
        "POLICY_THRESHOLD",
      ),
    );
  }

  const orderVelocity = deviationBasisPoints(current.paidOrderCount, prior.paidOrderCount);
  const valueVelocity = deviationBasisPoints(
    current.paidRetailMinorUnits,
    prior.paidRetailMinorUnits,
  );

  if (baselineSufficient) {
    const orderMagnitude = magnitude(orderVelocity);
    if (
      orderMagnitude !== null &&
      orderMagnitude >= BigInt(policy.velocityReviewBasisPoints)
    ) {
      reasons.push(
        reason(
          "ORDER_VELOCITY_SPIKE",
          "COUNT",
          current.paidOrderCount,
          prior.paidOrderCount,
          current.paidOrderCount,
          windowDays,
          "SELLER_PRIOR_WINDOW",
        ),
      );
    }
    const valueMagnitude = magnitude(valueVelocity);
    if (
      valueMagnitude !== null &&
      valueMagnitude >= BigInt(policy.velocityReviewBasisPoints)
    ) {
      /* Reported as the MOVEMENT in basis points, never as the two amounts. The
         amounts are what the operator surface refuses to print. */
      reasons.push(
        reason(
          "VALUE_VELOCITY_SPIKE",
          "BASIS_POINTS",
          valueMagnitude,
          BigInt(policy.velocityReviewBasisPoints),
          current.paidOrderCount,
          windowDays,
          "SELLER_PRIOR_WINDOW",
        ),
      );
    }
  }

  /* Volume spike has a GENUINELY DIFFERENT baseline from velocity: the seller's
     trailing 90-day daily mean, scaled to this window. Velocity asks "is this
     fortnight unlike last fortnight"; this asks "is this fortnight unlike the
     seller's ordinary rhythm", and a seller with a lumpy fortnightly cycle
     answers those two questions differently. */
  const baselineDailyScaled =
    (baseline.paidOrderCount * BigInt(windowDays)) / BigInt(VOLUME_BASELINE_DAYS);
  const volumeSpike = deviationBasisPoints(current.paidOrderCount, baselineDailyScaled);
  if (baselineSufficient) {
    const volumeMagnitude = magnitude(volumeSpike);
    if (
      volumeMagnitude !== null &&
      volumeMagnitude >= BigInt(policy.volumeSpikeReviewBasisPoints)
    ) {
      reasons.push(
        reason(
          "ORDER_VOLUME_SPIKE",
          "COUNT",
          current.paidOrderCount,
          baselineDailyScaled,
          current.paidOrderCount,
          windowDays,
          "SELLER_TRAILING_DAILY",
        ),
      );
    }
  }

  /* Average ticket, as MOVEMENT against the seller's own prior window. There is
     no governed vertical norm to compare against — none exists in this
     repository — so `resolveVerticalBaseline` says so rather than inventing one,
     and the seller's own history carries the comparison instead. */
  const currentTicket = averageMinorUnits(current.paidRetailMinorUnits, current.paidOrderCount);
  const priorTicket = averageMinorUnits(prior.paidRetailMinorUnits, prior.paidOrderCount);
  const ticketShift =
    currentTicket !== null && priorTicket !== null
      ? deviationBasisPoints(currentTicket, priorTicket)
      : null;
  if (baselineSufficient) {
    const ticketMagnitude = magnitude(ticketShift);
    if (
      ticketMagnitude !== null &&
      ticketMagnitude >= BigInt(policy.averageTicketShiftReviewBasisPoints)
    ) {
      reasons.push(
        reason(
          "AVERAGE_TICKET_SHIFT",
          "BASIS_POINTS",
          ticketMagnitude,
          BigInt(policy.averageTicketShiftReviewBasisPoints),
          current.paidOrderCount,
          windowDays,
          "SELLER_PRIOR_WINDOW",
        ),
      );
    }
  }

  const topShare = topJurisdictionShareBasisPoints(current.jurisdictionCounts);
  const newJurisdictions = [...current.jurisdictionCounts.keys()].filter(
    (key) => !prior.jurisdictionCounts.has(key),
  );
  if (
    topShare !== null &&
    topShare >= BigInt(policy.jurisdictionConcentrationReviewBasisPoints) &&
    current.paidOrderCount >= minSample
  ) {
    reasons.push(
      reason(
        "GEOGRAPHIC_CONCENTRATION_HIGH",
        "BASIS_POINTS",
        topShare,
        BigInt(policy.jurisdictionConcentrationReviewBasisPoints),
        current.paidOrderCount,
        windowDays,
        "POLICY_THRESHOLD",
      ),
    );
  }
  if (baselineSufficient && newJurisdictions.length >= policy.newJurisdictionReviewCount) {
    reasons.push(
      reason(
        "GEOGRAPHIC_DIVERSITY_SPIKE",
        "COUNT",
        BigInt(newJurisdictions.length),
        BigInt(prior.jurisdictionCounts.size),
        current.paidOrderCount,
        windowDays,
        "SELLER_PRIOR_WINDOW",
      ),
    );
  }

  const promoters = [...current.promoterOrderCounts.entries()].sort((a, b) =>
    a[1] === b[1] ? (a[0] < b[0] ? -1 : 1) : a[1] < b[1] ? 1 : -1,
  );
  const topPromoterShare =
    promoters.length > 0
      ? rateBasisPoints(promoters[0]![1], current.paidOrderCount)
      : null;
  if (
    topPromoterShare !== null &&
    topPromoterShare >= BigInt(policy.promoterConcentrationReviewBasisPoints) &&
    current.paidOrderCount >= minSample
  ) {
    reasons.push(
      reason(
        "PROMOTER_CONCENTRATION_HIGH",
        "BASIS_POINTS",
        topPromoterShare,
        BigInt(policy.promoterConcentrationReviewBasisPoints),
        current.paidOrderCount,
        windowDays,
        "POLICY_THRESHOLD",
      ),
    );
  }

  /* Emitted rather than suppressed, so a rank driven by a denominator of three
     reads as thin evidence instead of as a quiet accusation. */
  if (!baselineSufficient) {
    reasons.push(
      reason(
        "INSUFFICIENT_HISTORY_FOR_BASELINE",
        "COUNT",
        prior.paidOrderCount,
        BigInt(policy.minimumBaselineSampleCount),
        current.paidOrderCount,
        windowDays,
        "POLICY_THRESHOLD",
      ),
    );
  }

  const score = reviewScoreFor(reasons);

  return {
    sellerParticipantId,
    reviewRank: 0,
    reviewScore: score,
    warrantsAttention: score >= policy.attentionScoreFloor,
    reasons,
    paidOrderCount: current.paidOrderCount,
    paidOrderCountPriorWindow: prior.paidOrderCount,
    refundCount: current.refundCount,
    refundCountRate,
    refundValueRate,
    disputeOpenedCount: current.disputeOpenedCount,
    finalizedChargebackCount: current.chargebackLostCount,
    finalizedChargebackCountRate: chargebackCountRate,
    finalizedChargebackValueRate: chargebackValueRate,
    chargebackToRefundCountRatio: chargebackToRefundRatio,
    economicLossEventCount: current.economicLossEventCount,
    refundBehaviorEventCount: current.refundBehaviorEventCount,
    disputeBehaviorEventCount: current.disputeBehaviorEventCount,
    doubleRecoveryExposureEventCount: current.doubleRecoveryExposureEventCount,
    averageTicketShiftBasisPoints: ticketShift,
    verticalBaseline: resolveVerticalBaseline(),
    orderVelocityBasisPoints: orderVelocity,
    valueVelocityBasisPoints: valueVelocity,
    volumeSpikeBasisPoints: volumeSpike,
    distinctJurisdictionCount: current.jurisdictionCounts.size,
    newJurisdictionCount: newJurisdictions.length,
    topJurisdictionShareBasisPoints: topShare,
    promoterContributorCount: current.promoterOrderCounts.size,
    topPromoterShareBasisPoints: topPromoterShare,
    topPromoterParticipantIds: promoters.slice(0, 3).map(([id]) => id),
    baselineSufficient,
  };
}

/**
 * Seller × promoter rows, for telling a channel problem from a seller problem.
 *
 * The anomaly comparison is against the SELLER'S RATE EXCLUDING THIS PAIR. That
 * exclusion is the whole point: comparing a pair against the seller's total
 * folds the pair into its own baseline and blunts exactly the signal being
 * looked for — a promoter carrying most of a seller's volume would always look
 * unremarkable.
 */
function buildPromoterRows(
  sellerParticipantId: string,
  current: SellerWindowAggregate,
  window: RiskWindow,
  policy: ActiveReviewPolicy,
): SellerPromoterRiskRow[] {
  const rows: SellerPromoterRiskRow[] = [];
  const minSample = BigInt(policy.minimumRateSampleCount);

  for (const [promoterParticipantId, pairOrders] of current.promoterOrderCounts) {
    const pairRefunds = current.promoterRefundCounts.get(promoterParticipantId) ?? 0n;
    const pairChargebacks = current.promoterChargebackCounts.get(promoterParticipantId) ?? 0n;

    const restOrders = current.paidOrderCount - pairOrders;
    const restChargebacks = current.chargebackLostCount - pairChargebacks;

    const pairRate = rateBasisPoints(pairChargebacks, pairOrders);
    const restRate = rateBasisPoints(restChargebacks, restOrders);
    const anomaly =
      pairRate !== null && restRate !== null ? pairRate - restRate : null;

    const reasons: RiskReviewReason[] = [];
    const pairBaselineSufficient = pairOrders >= minSample;
    if (
      pairBaselineSufficient &&
      anomaly !== null &&
      anomaly >= BigInt(policy.chargebackCountRateReviewBasisPoints)
    ) {
      reasons.push(
        reason(
          "PROMOTER_SPECIFIC_ANOMALY",
          "BASIS_POINTS",
          pairRate ?? 0n,
          restRate,
          pairOrders,
          window.days,
          "POLICY_THRESHOLD",
        ),
      );
    }

    rows.push({
      sellerParticipantId,
      promoterParticipantId,
      paidOrderCount: pairOrders,
      refundCount: pairRefunds,
      refundCountRate: riskRate(pairRefunds, pairOrders, window, minSample),
      finalizedChargebackCount: pairChargebacks,
      finalizedChargebackCountRate: riskRate(pairChargebacks, pairOrders, window, minSample),
      chargebackToRefundCountRatio: riskRate(pairChargebacks, pairRefunds, window, 1n),
      sellerShareBasisPoints: rateBasisPoints(pairOrders, current.paidOrderCount),
      anomalyVersusSellerExcludingPairBasisPoints: anomaly,
      reasons,
      baselineSufficient: pairBaselineSufficient,
    });
  }

  return rows;
}

/**
 * The daily report.
 *
 * FAILS CLOSED when no heuristics version is active: an unconfigured deployment
 * refuses to rank rather than ranking sellers against numbers nobody governed —
 * the reading of silence Phase 1.2 took when it made an absent risk policy a
 * denial rather than a default limit.
 */
export async function runDailySellerRiskReport(
  input: DailyReportInput,
  deps: ReportDeps = {},
): Promise<DailySellerRiskReport> {
  const policy = await resolveActiveReviewPolicy(deps);
  if (policy === null) throw new SellerRiskReviewPolicyNotConfiguredError();

  const windowDays = input.windowDays ?? DEFAULT_RISK_WINDOW_DAYS;
  const top = input.top ?? DEFAULT_RISK_REPORT_TOP;

  const bundle = await collectSellerMetrics({ asOf: input.asOf, windowDays }, deps);
  const window = bundle.current.window;

  const rows: SellerRiskReviewRow[] = [];
  const promoterAnomalies: SellerPromoterRiskRow[] = [];

  for (const [sellerId, current] of bundle.current.bySeller) {
    rows.push(
      buildSellerRow(
        sellerId,
        current,
        aggregateOrEmpty(bundle.prior, sellerId),
        aggregateOrEmpty(bundle.volumeBaseline, sellerId),
        window,
        policy,
      ),
    );
  }

  rows.sort(compareRiskRows);
  const ranked = rows.slice(0, top).map((row, index) => ({ ...row, reviewRank: index + 1 }));

  /* Promoter detail only for the sellers actually surfaced. A marketplace-wide
     pair dump would be the transaction dump this report refuses to be. */
  for (const row of ranked) {
    const current = bundle.current.bySeller.get(row.sellerParticipantId);
    if (current === undefined) continue;
    for (const pair of buildPromoterRows(row.sellerParticipantId, current, window, policy)) {
      if (pair.reasons.length > 0) promoterAnomalies.push(pair);
    }
  }

  return {
    asOf: input.asOf,
    window,
    reviewPolicyId: policy.policyId,
    reviewPolicyVersion: policy.policyVersion,
    top,
    sellersConsidered: bundle.current.bySeller.size,
    rows: ranked,
    promoterAnomalies,
    unattributedDisputeCount: bundle.current.unattributedDisputeCount,
  };
}

/** Bounded drill-down: one seller, every window, no transaction listing. */
export async function inspectSellerRisk(
  input: { sellerParticipantId: string; asOf: string; windowDays?: RiskWindowDays },
  deps: ReportDeps = {},
): Promise<SellerRiskReviewRow> {
  const policy = await resolveActiveReviewPolicy(deps);
  if (policy === null) throw new SellerRiskReviewPolicyNotConfiguredError();

  const windowDays = input.windowDays ?? DEFAULT_RISK_WINDOW_DAYS;
  const bundle = await collectSellerMetrics(
    { asOf: input.asOf, windowDays, sellerParticipantId: input.sellerParticipantId },
    deps,
  );
  const row = buildSellerRow(
    input.sellerParticipantId,
    aggregateOrEmpty(bundle.current, input.sellerParticipantId),
    aggregateOrEmpty(bundle.prior, input.sellerParticipantId),
    aggregateOrEmpty(bundle.volumeBaseline, input.sellerParticipantId),
    bundle.current.window,
    policy,
  );
  return { ...row, reviewRank: 1 };
}

/** Bounded drill-down: one seller's promoter pairs. */
export async function inspectSellerPromoterRisk(
  input: {
    sellerParticipantId: string;
    promoterParticipantId?: string;
    asOf: string;
    windowDays?: RiskWindowDays;
  },
  deps: ReportDeps = {},
): Promise<SellerPromoterRiskRow[]> {
  const policy = await resolveActiveReviewPolicy(deps);
  if (policy === null) throw new SellerRiskReviewPolicyNotConfiguredError();

  const windowDays = input.windowDays ?? DEFAULT_RISK_WINDOW_DAYS;
  const bundle = await collectSellerMetrics(
    { asOf: input.asOf, windowDays, sellerParticipantId: input.sellerParticipantId },
    deps,
  );
  const rows = buildPromoterRows(
    input.sellerParticipantId,
    aggregateOrEmpty(bundle.current, input.sellerParticipantId),
    bundle.current.window,
    policy,
  );
  return input.promoterParticipantId === undefined
    ? rows
    : rows.filter((r) => r.promoterParticipantId === input.promoterParticipantId);
}
