/**
 * Seller risk metrics (Phase 1.13) — the arithmetic, and what it is allowed to mean.
 *
 * Phase 1.12 named this phase as the owner of every rate, window, and attribution
 * rule below (`FRAUD_AND_RISK_ANALYTICS_HANDOFF`), and named what it must not
 * become in the same breath: no scoring thresholds, no risk tiers, no opaque
 * fraud score, no automatic suspension. This module is the first half of the
 * answer — the measurements. `seller-risk-review.ts` is the second — what a
 * human is asked to look at.
 *
 * ## A rate is a triple, never a number
 *
 * Every rate here carries its numerator, its denominator, its window, and the
 * column the window was anchored on. A bare percentage is the failure mode this
 * whole phase exists to avoid: "8% chargeback rate" is one lost dispute out of
 * twelve sales or eight hundred out of ten thousand, and those are not the same
 * fact about a seller. Phase 1.12 wrote the rule down as two separate handoff
 * entries — `EXPLICIT_ROLLING_WINDOWS` and `NUMERATORS_AND_DENOMINATORS` — for
 * exactly this reason.
 *
 * ## Integers throughout, basis points for rates
 *
 * No floating-point money and no floating-point rates. Money is `bigint` minor
 * units, the rule every economics column in this schema follows; rates are
 * integer basis points, the form `retainedPercentageBasisPoints` already
 * established. A rate computed in `number` would round differently on different
 * inputs and make a ranking irreproducible.
 *
 * ## A zero denominator is a stated outcome, not a division
 *
 * `rateBasisPoints` returns `null` for an empty denominator and the surrounding
 * triple says `NO_DENOMINATOR`. `Infinity` and `NaN` are never business output —
 * they serialise to `null` in JSON and to nonsense on an operator's screen.
 *
 * ## No clock
 *
 * Every function here takes the instants it needs. A report that read the clock
 * could not be re-run for a past date, and a historical review that cannot be
 * reproduced is a decision nobody can explain afterwards.
 *
 * Pure. No I/O, no database, no clock, no randomness.
 */

import { z } from "zod";

// — Windows —

/**
 * The rolling windows a daily review is computed over.
 *
 * All four are kept. `1` and `7` answer "what changed since yesterday", which is
 * the cadence the report is actually read on; `30` and `90` are the only windows
 * where a chargeback rate means much, because a card dispute typically finalizes
 * weeks after the sale it disputes. Dropping either pair would make the report
 * answer only half the question it is opened for.
 */
export const RISK_WINDOW_DAYS = [1, 7, 30, 90] as const;
export const RiskWindowDays = z.literal(RISK_WINDOW_DAYS);
export type RiskWindowDays = (typeof RISK_WINDOW_DAYS)[number];

/** The default window a ranked daily report leads with. */
export const DEFAULT_RISK_WINDOW_DAYS = 30 as const satisfies RiskWindowDays;

const MS_PER_DAY = 86_400_000;

/**
 * The column an observation's window was applied to.
 *
 * Named on every measure rather than assumed, because the anchors genuinely
 * differ and mixing them silently is how two correct-looking numbers end up
 * describing different populations. A sale is anchored when it was PAID; a
 * refund when the buyer's money actually went back; a chargeback when the loss
 * became FINAL, which is weeks after the dispute opened.
 */
export const RISK_WINDOW_ANCHORS = [
  "ORDER_PAID_AT",
  "REFUND_FINALIZED_AT",
  "REFUND_REQUESTED_AT",
  "DISPUTE_OPENED_AT",
  "DISPUTE_CLOSED_AT",
] as const;
export const RiskWindowAnchor = z.enum(RISK_WINDOW_ANCHORS);
export type RiskWindowAnchor = z.infer<typeof RiskWindowAnchor>;

/**
 * One half-open interval `(startExclusive, endInclusive]`.
 *
 * Half-open deliberately: adjacent windows then partition time with no overlap
 * and no gap, so an event at a boundary lands in exactly one of "current" and
 * "prior". A closed interval would count a midnight sale twice in a
 * week-over-week comparison and inflate every velocity figure by a little,
 * unpredictably.
 *
 * Exact millisecond arithmetic on UTC instants — no calendar months, no local
 * timezone, no DST. A "30-day window" that is 29 days long twice a year is a
 * window whose results cannot be compared to themselves.
 */
export const RiskWindow = z.strictObject({
  days: RiskWindowDays,
  startExclusive: z.iso.datetime(),
  endInclusive: z.iso.datetime(),
  anchor: RiskWindowAnchor,
});
export type RiskWindow = z.infer<typeof RiskWindow>;

/** The window of `days` ending at `asOf`. */
export function windowEndingAt(
  asOf: string,
  days: RiskWindowDays,
  anchor: RiskWindowAnchor,
): RiskWindow {
  const end = Date.parse(asOf);
  if (Number.isNaN(end)) throw new TypeError("asOf must be an ISO-8601 instant");
  return {
    days,
    startExclusive: new Date(end - days * MS_PER_DAY).toISOString(),
    endInclusive: new Date(end).toISOString(),
    anchor,
  };
}

/**
 * The comparable window immediately before `window` — `(asOf-2N, asOf-N]`.
 *
 * Same length, same anchor, adjacent and non-overlapping. This is the only
 * baseline this phase compares against: the seller's own recent past. Comparing
 * a seller to other sellers would require a norm nobody has governed.
 */
export function priorWindow(window: RiskWindow): RiskWindow {
  const end = Date.parse(window.startExclusive);
  return {
    days: window.days,
    startExclusive: new Date(end - window.days * MS_PER_DAY).toISOString(),
    endInclusive: new Date(end).toISOString(),
    anchor: window.anchor,
  };
}

/** Half-open membership: `startExclusive < instant <= endInclusive`. */
export function windowContains(window: RiskWindow, instant: Date | string): boolean {
  const t = typeof instant === "string" ? Date.parse(instant) : instant.getTime();
  return t > Date.parse(window.startExclusive) && t <= Date.parse(window.endInclusive);
}

// — Rates —

/**
 * Why a rate is or is not a number.
 *
 * `SAMPLE_BELOW_GOVERNED_MINIMUM` is the one that matters operationally. One
 * chargeback out of one sale is 10 000 basis points and means nothing; reporting
 * it as a rate is how a legitimate small seller reaches the top of a risk list.
 * The numerator and denominator are still reported — the sample is withheld from
 * the RATE, never from the reader.
 */
export const RATE_STATUSES = [
  "COMPUTED",
  "NO_DENOMINATOR",
  "SAMPLE_BELOW_GOVERNED_MINIMUM",
] as const;
export const RateStatus = z.enum(RATE_STATUSES);
export type RateStatus = z.infer<typeof RateStatus>;

/**
 * A rate, with everything needed to check it.
 *
 * `rateBasisPoints` is `null` unless `status` is `COMPUTED`, which is asserted
 * below rather than left to a convention a caller might not follow.
 */
export const RiskRate = z
  .strictObject({
    rateBasisPoints: z.bigint().nullable(),
    numerator: z.bigint().nonnegative(),
    denominator: z.bigint().nonnegative(),
    status: RateStatus,
    window: RiskWindow,
  })
  .refine(
    (r) => (r.status === "COMPUTED") === (r.rateBasisPoints !== null),
    "a rate is a number exactly when its status is COMPUTED",
  );
export type RiskRate = z.infer<typeof RiskRate>;

/**
 * `numerator / denominator` in basis points, half-up, exact integer arithmetic.
 *
 * `null` for an empty denominator — never `Infinity`, never `NaN`, and never a
 * silent `0`, which would read as "this seller has no problem" when the truth is
 * "this seller has no sales".
 *
 * NOT CAPPED. A chargeback-to-refund ratio legitimately exceeds 10 000 basis
 * points when a seller is disputed more often than refunded, and clamping it
 * would hide the single most interesting case.
 */
export function rateBasisPoints(numerator: bigint, denominator: bigint): bigint | null {
  if (denominator === 0n) return null;
  return (numerator * 20_000n + denominator) / (2n * denominator);
}

/** Build a rate triple, applying the governed sample floor. */
export function riskRate(
  numerator: bigint,
  denominator: bigint,
  window: RiskWindow,
  minimumSampleCount: bigint,
): RiskRate {
  if (denominator === 0n) {
    return { rateBasisPoints: null, numerator, denominator, status: "NO_DENOMINATOR", window };
  }
  if (denominator < minimumSampleCount) {
    return {
      rateBasisPoints: null,
      numerator,
      denominator,
      status: "SAMPLE_BELOW_GOVERNED_MINIMUM",
      window,
    };
  }
  return {
    rateBasisPoints: rateBasisPoints(numerator, denominator),
    numerator,
    denominator,
    status: "COMPUTED",
    window,
  };
}

// — Counting semantics —

/**
 * The exact populations every measure in this phase is computed over.
 *
 * Stated as a value so a test asserts the rules rather than re-deriving them,
 * and so a reader can check the arithmetic against the intent without reading
 * the queries.
 */
export const RISK_COUNTING_SEMANTICS = {
  /**
   * A sale. `Order.lifecycle = 'PAID'`, anchored on `paidAt`.
   *
   * INCLUDES sales later refunded or charged back — they were real sales, and
   * removing them from the denominator would inflate every rate by exactly the
   * thing the rate is measuring. EXCLUDES `PENDING_PAYMENT`, `PAYMENT_FAILED`,
   * and `CANCELLED`; an abandoned checkout writes no Order at all.
   */
  transactionDenominator: "ORDER_LIFECYCLE_PAID",
  /**
   * A completed refund. `OrderRefund.status = 'REFUNDED'`, anchored on
   * `finalizedAt` — when the money actually went back, not when Monacado
   * committed to returning it.
   */
  refundNumerator: "ORDER_REFUND_STATUS_REFUNDED",
  /**
   * A refund REQUEST, which is a different fact and is never called a refund
   * rate. `PENDING`, `IN_PROGRESS`, `RETRY_PENDING`, and `FAILED_PERMANENT` are
   * requests; a buyer whose refund failed permanently did not get their money.
   */
  refundRequestNumerator: "ORDER_REFUND_ANY_STATUS",
  /**
   * A finalized chargeback. `TransactionDispute.status = 'LOST'`, anchored on
   * `closedAt`. `OPEN`, `NEEDS_RESPONSE`, `UNDER_REVIEW`, `WON`, `CLOSED`, and
   * `MANUAL_REMEDIATION_REQUIRED` are NOT chargebacks — a dispute in flight is
   * not a loss, and a won dispute is the opposite of one.
   */
  chargebackNumerator: "TRANSACTION_DISPUTE_STATUS_LOST",
  /** Disputes raised, whatever became of them. Anchored on `openedAt`. */
  disputeOpenedNumerator: "TRANSACTION_DISPUTE_ANY_STATUS",
  /**
   * Refund VALUE uses `linesRetailMinorUnits`, not `amountMinorUnits`.
   *
   * `amountMinorUnits` includes returned tax and shipping, which are not in
   * `commercialRetailAmountMinorUnits` — the denominator. A retail numerator over
   * a retail denominator is the only pairing that cannot exceed 100% for a
   * fully-refunded book of sales.
   */
  refundValueNumerator: "ORDER_REFUND_LINES_RETAIL_MINOR_UNITS",
  /** Sale VALUE is the snapshot's commercial retail amount. Never the Order quote. */
  transactionValueDenominator: "SNAPSHOT_COMMERCIAL_RETAIL_MINOR_UNITS",
  /**
   * `SellerChargebackFee` is NEVER a chargeback.
   *
   * It is a marketplace charge Monacado raises BECAUSE a chargeback finalized —
   * one loss, one fee, enforced by `disputeId @unique`. Counting both would
   * double every seller's chargeback count. It is also absent for unattributed
   * losses and when no fee policy is active, so it is not even a complete count
   * of the thing it is not.
   */
  chargebackFeeIsNotAChargeback: true,
  /**
   * Provider and network dispute fees are Monacado expenses and appear nowhere
   * in this phase. They are not seller conduct and not a seller metric.
   */
  providerDisputeFeeIsNotASellerMetric: true,
} as const;

/**
 * The four disjoint adverse-event measures, and why there are four.
 *
 * A sale that is refunded and THEN charged back is a real double-payment
 * exposure in the world but exactly ONE Monacado reversal — which is why 1.11
 * records `economicEffect` at all. Collapsing these into a single "loss" figure
 * would either double-count that sale or hide the fact that it happened twice.
 * So: one metric claims financial loss, two describe behaviour, and one names
 * the overlap explicitly.
 */
export const ADVERSE_EVENT_MEASURES = {
  /**
   * THE ONLY MEASURE THAT CLAIMS FINANCIAL LOSS. Completed refunds, plus
   * finalized losses whose `economicEffect` is `REVERSED_BY_THIS_DISPUTE`.
   * A sale contributes AT MOST ONCE.
   */
  economicLossEvents: "REFUNDED_PLUS_LOST_WHERE_REVERSED_BY_THIS_DISPUTE",
  /** Refund behaviour. A later dispute does not un-refund the sale. */
  refundBehaviorEvents: "ALL_REFUNDED",
  /** Dispute behaviour. Includes losses already reversed by a refund. */
  disputeBehaviorEvents: "ALL_LOST",
  /**
   * The overlap, named rather than buried: a sale refunded AND then charged
   * back. A strong abuse signal in its own right, and invisible if the other
   * three are read alone.
   */
  doubleRecoveryExposureEvents: "LOST_WHERE_ALREADY_REVERSED_BY_REFUND",
} as const;

// — Attribution —

/**
 * How a sale, a refund, and a chargeback reach a seller and a promoter.
 *
 * Attribution is read from the ORDER, which carries both parties as they were at
 * the sale. It is never reconstructed from current Storefront, Product, or Offer
 * rows: on a PROMOTED sale the Listing's controller is the promoter, not the
 * seller, so "look up who owns the listing now" is both a different question and
 * a mutable answer.
 */
export const RISK_ATTRIBUTION_RULES = {
  seller: "ORDER_SELLER_PARTICIPANT_ID",
  promoter: "ORDER_PROMOTER_PARTICIPANT_ID",
  /** Refunds reach a seller only through their Order. */
  refund: "ORDER_REFUND_ORDER_ID_JOIN_ORDER",
  /** Disputes likewise — and `orderId` is NULLABLE, which is the gap below. */
  dispute: "TRANSACTION_DISPUTE_ORDER_ID_JOIN_ORDER",
  /**
   * A seller-direct sale has NO promoter. It is reported in its own bucket and
   * never under a synthetic promoter id — the same refusal `ProceedsObligation`
   * makes when it declines to write a zero promoter row for a seller who has no
   * promoter counterparty.
   */
  sellerDirectIsNotASyntheticPromoter: true,
  /**
   * A dispute Monacado could not attribute to a sale belongs to NO seller.
   *
   * `TransactionDispute.orderId` is nullable by design — an unattributable
   * provider dispute is still a real withdrawal and discarding it is how a
   * chargeback becomes invisible. It is therefore excluded from every
   * seller-keyed numerator and reported ALONGSIDE them as
   * `unattributedDisputeCount`, so the exclusion is visible rather than silent.
   * It is NEVER imputed to a seller: a guess in a fraud metric is worse than a
   * gap, because it looks like evidence.
   */
  unattributedDisputesAreReportedNotImputed: true,
} as const;

// — Vertical baseline seam —

/**
 * Whether a governed expected-ticket range exists for a seller.
 *
 * TODAY, FOR EVERY SELLER, IT DOES NOT. This repository holds no authoritative
 * seller vertical, category, industry, or merchant-category classification —
 * `ProductSourceRecordVersionRow.taxClassification` is a fiscal control fact and
 * is emphatically not a risk vertical. So the honest answer is the unavailable
 * one, and the average-ticket comparison falls back to the baseline that always
 * works: the seller's own prior window.
 *
 * Reporting `VERTICAL_BASELINE_UNAVAILABLE` rather than inventing a norm is the
 * whole point of this type. A fabricated "expected ticket for this kind of
 * seller" would be a threshold with no author, applied to people's livelihoods.
 */
export const VERTICAL_BASELINE_STATUSES = [
  "VERTICAL_BASELINE_UNAVAILABLE",
  "VERTICAL_BASELINE_GOVERNED",
] as const;
export const VerticalBaselineStatus = z.enum(VERTICAL_BASELINE_STATUSES);
export type VerticalBaselineStatus = z.infer<typeof VerticalBaselineStatus>;

export const VERTICAL_BASELINE_UNAVAILABLE_REASON =
  "NO_GOVERNED_SELLER_VERTICAL_CLASSIFICATION_EXISTS" as const;

/**
 * The seam a future governed vertical profile lands on.
 *
 * When one arrives it must arrive as an immutable, versioned row in the shape
 * every other governed policy here already uses, and the comparison must name
 * the exact version it applied — a norm that cannot be cited is a threshold with
 * no author. Until then this resolves to the unavailable branch for everyone,
 * and risk reporting continues on the seller's own history rather than stopping.
 */
export const VerticalBaseline = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("VERTICAL_BASELINE_UNAVAILABLE"),
    reasonCode: z.literal(VERTICAL_BASELINE_UNAVAILABLE_REASON),
  }),
  z.strictObject({
    status: z.literal("VERTICAL_BASELINE_GOVERNED"),
    policyId: z.string().min(1).max(191),
    policyVersion: z.string().min(1).max(64),
    expectedTicketLowMinorUnits: z.bigint().nonnegative(),
    expectedTicketHighMinorUnits: z.bigint().nonnegative(),
  }),
]);
export type VerticalBaseline = z.infer<typeof VerticalBaseline>;

/** Today's only inhabited branch. */
export function resolveVerticalBaseline(): VerticalBaseline {
  return {
    status: "VERTICAL_BASELINE_UNAVAILABLE",
    reasonCode: VERTICAL_BASELINE_UNAVAILABLE_REASON,
  };
}

// — Geography —

/**
 * The ONLY buyer-derived fields this phase may read.
 *
 * `OrderBuyerSnapshot` holds a name, an email, full billing and shipping lines,
 * and postal codes. A risk system is the classic route to accumulating exactly
 * that, so the admissible set is named here and asserted by test rather than
 * left to the discipline of each query. Jurisdiction is what a geography signal
 * needs; everything finer identifies a person.
 *
 * `taxCountryCode` is derived from the billing address at capture and is NEVER
 * derived from an IP address — there is no IP anywhere in this schema, and this
 * phase adds none.
 */
export const ADMISSIBLE_RISK_GEOGRAPHY_FIELDS = ["taxCountryCode", "taxRegionCode"] as const;

/** Named so a test can assert each is refused, rather than inferring the absence. */
export const NEVER_IN_RISK_GEOGRAPHY = [
  "name",
  "email",
  "billingLine1",
  "billingLine2",
  "billingCity",
  "billingPostalCode",
  "shippingLine1",
  "shippingLine2",
  "shippingCity",
  "shippingPostalCode",
  "ipAddress",
  "deviceFingerprint",
] as const;

/** A jurisdiction key: country, plus region where one is recorded. */
export function jurisdictionKey(countryCode: string, regionCode: string | null): string {
  return `${countryCode}/${regionCode ?? "-"}`;
}

/**
 * Concentration as the TOP JURISDICTION'S SHARE, in basis points.
 *
 * Chosen over a Herfindahl index deliberately. A staff member — and, if it ever
 * comes to it, a seller — must be able to hear the number and check it: "63% of
 * your orders billed to one region" is auditable by eye. An HHI of 0.41 is
 * defensible arithmetic that nobody can verify, and an unverifiable number is
 * not an explanation.
 */
export function topJurisdictionShareBasisPoints(
  countsByJurisdiction: ReadonlyMap<string, bigint>,
): bigint | null {
  let total = 0n;
  let top = 0n;
  for (const count of countsByJurisdiction.values()) {
    total += count;
    if (count > top) top = count;
  }
  return rateBasisPoints(top, total);
}

// — Deviation —

/**
 * Signed movement of `observed` against `baseline`, in basis points.
 *
 * `null` when there is no baseline to move against. A first-ever sale is not an
 * infinite increase; it is a seller with no history, which the reason vocabulary
 * says in words rather than expressing as a number that cannot be printed.
 */
export function deviationBasisPoints(observed: bigint, baseline: bigint): bigint | null {
  if (baseline === 0n) return null;
  const delta = observed - baseline;
  const magnitude = rateBasisPoints(delta < 0n ? -delta : delta, baseline);
  if (magnitude === null) return null;
  return delta < 0n ? -magnitude : magnitude;
}

/** Integer mean, half-up. `null` for an empty sample — never a zero average. */
export function averageMinorUnits(totalMinorUnits: bigint, count: bigint): bigint | null {
  if (count === 0n) return null;
  return (totalMinorUnits * 2n + count) / (2n * count);
}

// — Never here —

/**
 * Named as never admissible on a risk metric.
 *
 * The first group is the speculative machinery Phase 1.2 refused and Phase 1.12
 * confirmed 1.13 would not build either: this phase reports measurements a
 * person can check, not a model's opinion. The second is personal data. A test
 * walks the list.
 */
export const NEVER_ON_RISK_METRICS = [
  "riskScore",
  "fraudScore",
  "fraudProbability",
  "modelVersion",
  "chargebackProbability",
  "riskTier",
  "autoSuspendAt",
  "blockedCountries",
  "buyerEmail",
  "buyerName",
  "ipAddress",
  "deviceFingerprint",
] as const;
