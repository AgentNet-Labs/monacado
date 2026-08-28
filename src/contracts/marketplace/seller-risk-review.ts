/**
 * Seller risk review (Phase 1.13) — what a person is asked to look at, and why.
 *
 * `seller-risk-metrics.ts` is the arithmetic. This is the operational product:
 * a ranked, bounded, explainable list of sellers warranting Staff attention, and
 * the governed record of what a human decided about one.
 *
 * ## Attention, never enforcement
 *
 * Nothing in this phase restricts, suspends, holds, or denies anything. That is
 * not caution — it is what the committed governance actually permits. Marketplace
 * Policy 1.2.0 authorises Monacado to decline, hold, or reverse **a transaction**
 * on risk grounds. It says nothing about monitoring a seller's rates, placing a
 * participant under review, or restricting their selling privileges, and
 * `DISPUTE_EFFECT_ON_PROCEEDS` narrows further still: a per-sale hold "is not a
 * suspension of a participant's other proceeds". Participant-level consequences
 * need terms that do not exist yet, which `MARKETPLACE_POLICY_RISK_TERMS_REQUIRED`
 * below records as a requirement for a future version rather than assuming.
 *
 * Separately, there is no suspension path to invoke even if there were terms:
 * every writer in this repository refuses `SUSPENDED` by name, and the phase that
 * refused it said why — "a restriction nobody can enumerate is indistinguishable
 * from a suspension". So `SUSPENSION_RECOMMENDED` is a recorded recommendation,
 * and the acting is somebody else's, later, under authority that has been written
 * down.
 *
 * ## A rank is a request for attention
 *
 * The ranking is a deterministic integer sum of the weights of REASONS THAT WERE
 * TRIGGERED — not a model output, and not a number anybody may act on directly.
 * Every ranked row carries the reasons, and every reason carries what was
 * observed, what it was compared against, and the sample size behind both. A row
 * that could only say `volumeSpike: true` would be an accusation with no
 * evidence attached.
 *
 * ## No buyer PII, and no amounts
 *
 * The operator surface carries participant ids, counts, basis points, and bounded
 * codes. It carries no name, email, address, or monetary amount — the promise
 * `refund:status` and `dispute:status` already make, and it holds here for a
 * sharper reason than it does there. A risk ranking surfaces small-denominator
 * sellers preferentially, so a seller-level "aggregate" with one sale behind it
 * IS one buyer's purchase amount, printed beside a rank drawing attention to it.
 * A rule that holds except where the report is most used is not a rule.
 *
 * Pure. No I/O, no database, no clock, no randomness.
 */

import { z } from "zod";
import {
  MARKETPLACE_PARTICIPANT_ID_RE,
  PARTICIPANT_RISK_REVIEW_ID_RE,
  SELLER_RISK_REVIEW_POLICY_ID_RE,
} from "./identity";
import { AccountId } from "../account/account";
import {
  RiskRate,
  RiskWindow,
  RiskWindowDays,
  VerticalBaseline,
} from "./seller-risk-metrics";

const ParticipantId = z
  .string()
  .regex(MARKETPLACE_PARTICIPANT_ID_RE, "must be mon:mpart:<opaque>");

// — Identity —

export const SellerRiskReviewPolicyId = z
  .string()
  .regex(SELLER_RISK_REVIEW_POLICY_ID_RE, "must be mon:srrp:<opaque>");
export type SellerRiskReviewPolicyId = z.infer<typeof SellerRiskReviewPolicyId>;

export const ParticipantRiskReviewId = z
  .string()
  .regex(PARTICIPANT_RISK_REVIEW_ID_RE, "must be mon:prrev:<opaque>");
export type ParticipantRiskReviewId = z.infer<typeof ParticipantRiskReviewId>;

/** The stable lookup key, so "which policy governs review" is a lookup. */
export const SELLER_RISK_REVIEW_POLICY_KEY = "seller-risk-review" as const;

/** Reused rather than restated — the lifecycle every governed policy here has. */
export const RISK_REVIEW_POLICY_VERSION_STATUSES = ["DRAFT", "ACTIVE", "RETIRED"] as const;
export const RiskReviewPolicyVersionStatus = z.enum(RISK_REVIEW_POLICY_VERSION_STATUSES);
export type RiskReviewPolicyVersionStatus = z.infer<typeof RiskReviewPolicyVersionStatus>;

// — Review reasons —

/**
 * Why a seller appears on the list, as a closed vocabulary.
 *
 * EVERY CODE NAMES AN OBSERVATION, NEVER A CONCLUSION. There is no `FRAUD`, no
 * `ABUSE`, no `SUSPICIOUS`, no `BAD_ACTOR`, and no `CONFIRMED` anywhere in this
 * list, and a test asserts it. These metrics cannot establish that anybody did
 * anything wrong: an elevated chargeback rate is equally the signature of a
 * seller being defrauded, a product that photographs better than it arrives, or
 * a promoter driving traffic that converts badly. Naming the measurement is
 * honest; naming a motive is not, and the word would follow the seller through
 * every screen that ever renders this row.
 *
 * `INSUFFICIENT_HISTORY_FOR_BASELINE` is emitted rather than suppressed, so a
 * rank driven by a denominator of three reads as thin evidence instead of as a
 * quiet accusation.
 */
export const RISK_REVIEW_REASON_CODES = [
  "REFUND_RATE_ELEVATED",
  "CHARGEBACK_RATE_ELEVATED",
  "CHARGEBACK_TO_REFUND_RATIO_ELEVATED",
  "DOUBLE_RECOVERY_EXPOSURE_PRESENT",
  "ORDER_VELOCITY_SPIKE",
  "VALUE_VELOCITY_SPIKE",
  "ORDER_VOLUME_SPIKE",
  "AVERAGE_TICKET_SHIFT",
  "GEOGRAPHIC_DIVERSITY_SPIKE",
  "GEOGRAPHIC_CONCENTRATION_HIGH",
  "PROMOTER_CONCENTRATION_HIGH",
  "PROMOTER_SPECIFIC_ANOMALY",
  "INSUFFICIENT_HISTORY_FOR_BASELINE",
] as const;
export const RiskReviewReasonCode = z.enum(RISK_REVIEW_REASON_CODES);
export type RiskReviewReasonCode = z.infer<typeof RiskReviewReasonCode>;

/** Words a reason code may never contain. Asserted by test. */
export const REASON_CODE_FORBIDDEN_TERMS = [
  "FRAUD",
  "ABUSE",
  "SUSPICIOUS",
  "BAD_ACTOR",
  "CONFIRMED",
  "CRIMINAL",
  "SCAM",
] as const;

/** Counts and basis points. Never a currency amount. */
export const RISK_OBSERVATION_UNITS = ["COUNT", "BASIS_POINTS"] as const;
export const RiskObservationUnit = z.enum(RISK_OBSERVATION_UNITS);
export type RiskObservationUnit = z.infer<typeof RiskObservationUnit>;

/**
 * One reason, with the evidence for it.
 *
 * `observed` and `baseline` are REQUIRED by the type, which is what makes
 * "`volumeSpike: true` alone" structurally inexpressible rather than merely
 * discouraged. `baseline` is nullable only where there genuinely was none, and
 * in that case the code says so.
 *
 * `sampleSize` travels with every reason so a reader always sees the denominator
 * a rate was computed on, without going to look for it.
 */
export const RiskReviewReason = z.strictObject({
  code: RiskReviewReasonCode,
  unit: RiskObservationUnit,
  observed: z.bigint(),
  baseline: z.bigint().nullable(),
  sampleSize: z.bigint().nonnegative(),
  windowDays: RiskWindowDays,
  /** What `baseline` was drawn from. Only ever the seller's own past. */
  comparison: z.enum(["SELLER_PRIOR_WINDOW", "SELLER_TRAILING_DAILY", "POLICY_THRESHOLD"]),
  weight: z.int().nonnegative(),
});
export type RiskReviewReason = z.infer<typeof RiskReviewReason>;

// — The governed heuristics —

const Bp = z.int().min(0).max(1_000_000);
const Count = z.int().min(0).max(1_000_000);

/**
 * One immutable version of the review heuristics.
 *
 * REVIEW HEURISTICS, NOT ENFORCEMENT LIMITS. Crossing one of these puts a seller
 * in front of a person. It authorises nothing and denies nothing, which is
 * precisely why they live here and not on `RiskPolicyVersionRow` — everything on
 * that row is a gate, evaluated at checkout against one Order. These are
 * evaluated when a report runs, possibly months after the sales they rank, and
 * Phase 1.12 already ruled on this exact question when it moved the chargeback
 * fee to its own policy: a value decided at a different moment than the sale has
 * exactly one unambiguous version only if it has its own policy.
 *
 * Every field is an INPUT. There is no weight curve, no score formula, and no
 * `autoSuspendAt` — the ranking arithmetic is published in this module, not
 * configured in a row.
 */
export const SellerRiskReviewPolicyVersionRecord = z.strictObject({
  policyId: SellerRiskReviewPolicyId,
  policyVersion: z.string().min(1).max(64),
  status: RiskReviewPolicyVersionStatus,

  /** The smallest denominator a rate may be published AS A RATE under. */
  minimumRateSampleCount: Count,
  /** The smallest prior-window sample a deviation may be claimed against. */
  minimumBaselineSampleCount: Count,

  refundCountRateReviewBasisPoints: Bp,
  chargebackCountRateReviewBasisPoints: Bp,
  chargebackToRefundRatioReviewBasisPoints: Bp,

  velocityReviewBasisPoints: Bp,
  averageTicketShiftReviewBasisPoints: Bp,
  volumeSpikeReviewBasisPoints: Bp,

  jurisdictionConcentrationReviewBasisPoints: Bp,
  newJurisdictionReviewCount: Count,
  promoterConcentrationReviewBasisPoints: Bp,

  /** A reporting floor for "warrants attention". Never an action trigger. */
  attentionScoreFloor: Count,

  effectiveFrom: z.iso.datetime(),
  recordedByAccountId: AccountId,
  recordedAt: z.iso.datetime(),
  retiredAt: z.iso.datetime().nullable(),
  retiredByAccountId: AccountId.nullable(),
});
export type SellerRiskReviewPolicyVersionRecord = z.infer<
  typeof SellerRiskReviewPolicyVersionRecord
>;

/**
 * The weight each reason contributes to the ordering score.
 *
 * PUBLISHED, NOT CONFIGURED. The thresholds that decide whether a reason fires
 * are governed and versioned; the weights that order the fired reasons are in
 * source, where a reader can see the whole ranking rule at once. Splitting them
 * this way keeps the tunable part auditable and the arithmetic part legible —
 * a weight table in a database row would make "why was this seller third"
 * answerable only by querying.
 *
 * The values encode one judgement: a finalized loss outranks a refund, which
 * outranks a change in shape. Nothing here is calibrated against outcomes,
 * because no outcome data exists yet to calibrate against — and a weight tuned
 * on no evidence would be a model wearing a constant's clothing.
 */
export const RISK_REVIEW_REASON_WEIGHTS = {
  CHARGEBACK_RATE_ELEVATED: 50,
  CHARGEBACK_TO_REFUND_RATIO_ELEVATED: 40,
  DOUBLE_RECOVERY_EXPOSURE_PRESENT: 35,
  REFUND_RATE_ELEVATED: 25,
  ORDER_VOLUME_SPIKE: 20,
  VALUE_VELOCITY_SPIKE: 20,
  ORDER_VELOCITY_SPIKE: 15,
  PROMOTER_SPECIFIC_ANOMALY: 15,
  GEOGRAPHIC_DIVERSITY_SPIKE: 10,
  AVERAGE_TICKET_SHIFT: 10,
  GEOGRAPHIC_CONCENTRATION_HIGH: 5,
  PROMOTER_CONCENTRATION_HIGH: 5,
  /** Context, not concern. Contributes nothing to the ordering. */
  INSUFFICIENT_HISTORY_FOR_BASELINE: 0,
} as const satisfies Record<RiskReviewReasonCode, number>;

// — The report —

/**
 * One ranked seller.
 *
 * NO MONETARY AMOUNTS. Counts, rates in basis points, and deviations — see the
 * module header for why an aggregate is not safely different from a purchase
 * amount on precisely this report.
 */
export const SellerRiskReviewRow = z.strictObject({
  sellerParticipantId: ParticipantId,
  reviewRank: z.int().positive(),
  reviewScore: z.int().nonnegative(),
  /** Whether the score reached the governed attention floor. */
  warrantsAttention: z.boolean(),
  reasons: z.array(RiskReviewReason).max(RISK_REVIEW_REASON_CODES.length),

  paidOrderCount: z.bigint().nonnegative(),
  paidOrderCountPriorWindow: z.bigint().nonnegative(),

  refundCount: z.bigint().nonnegative(),
  refundCountRate: RiskRate,
  refundValueRate: RiskRate,

  disputeOpenedCount: z.bigint().nonnegative(),
  finalizedChargebackCount: z.bigint().nonnegative(),
  finalizedChargebackCountRate: RiskRate,
  finalizedChargebackValueRate: RiskRate,
  chargebackToRefundCountRatio: RiskRate,

  /** The four disjoint measures, so loss is never confused with behaviour. */
  economicLossEventCount: z.bigint().nonnegative(),
  refundBehaviorEventCount: z.bigint().nonnegative(),
  disputeBehaviorEventCount: z.bigint().nonnegative(),
  doubleRecoveryExposureEventCount: z.bigint().nonnegative(),

  /** Movement only. The absolute average is a purchase amount when n is 1. */
  averageTicketShiftBasisPoints: z.bigint().nullable(),
  verticalBaseline: VerticalBaseline,

  orderVelocityBasisPoints: z.bigint().nullable(),
  valueVelocityBasisPoints: z.bigint().nullable(),
  volumeSpikeBasisPoints: z.bigint().nullable(),

  distinctJurisdictionCount: z.int().nonnegative(),
  newJurisdictionCount: z.int().nonnegative(),
  topJurisdictionShareBasisPoints: z.bigint().nullable(),

  promoterContributorCount: z.int().nonnegative(),
  topPromoterShareBasisPoints: z.bigint().nullable(),
  topPromoterParticipantIds: z.array(ParticipantId).max(3),

  baselineSufficient: z.boolean(),
});
export type SellerRiskReviewRow = z.infer<typeof SellerRiskReviewRow>;

/** One seller × promoter pair, for telling a channel problem from a seller problem. */
export const SellerPromoterRiskRow = z.strictObject({
  sellerParticipantId: ParticipantId,
  promoterParticipantId: ParticipantId,
  paidOrderCount: z.bigint().nonnegative(),
  refundCount: z.bigint().nonnegative(),
  refundCountRate: RiskRate,
  finalizedChargebackCount: z.bigint().nonnegative(),
  finalizedChargebackCountRate: RiskRate,
  chargebackToRefundCountRatio: RiskRate,
  /** This pair's share of the seller's window. */
  sellerShareBasisPoints: z.bigint().nullable(),
  /**
   * The pair's chargeback rate against the SELLER'S RATE EXCLUDING THIS PAIR.
   * That exclusion is what separates "this seller has a problem" from "this
   * channel has a problem"; comparing against the seller's total would fold the
   * pair into its own baseline and blunt exactly the signal being looked for.
   */
  anomalyVersusSellerExcludingPairBasisPoints: z.bigint().nullable(),
  reasons: z.array(RiskReviewReason).max(RISK_REVIEW_REASON_CODES.length),
  baselineSufficient: z.boolean(),
});
export type SellerPromoterRiskRow = z.infer<typeof SellerPromoterRiskRow>;

/** Bounded selections. A daily list is for reading, not for exporting. */
export const RISK_REPORT_TOP_SELECTIONS = [10, 100] as const;
export const RiskReportTopSelection = z.literal(RISK_REPORT_TOP_SELECTIONS);
export type RiskReportTopSelection = (typeof RISK_REPORT_TOP_SELECTIONS)[number];
export const DEFAULT_RISK_REPORT_TOP = 10 as const satisfies RiskReportTopSelection;

/**
 * The daily report.
 *
 * Reproducible from `asOf` and `reviewPolicyVersion` alone: the same two inputs
 * over the same source rows produce the same bytes, whatever the wall clock
 * says. That property is why this phase stores no report snapshot — a snapshot
 * would be a derived record that could drift from the rows it was derived from,
 * and the coordinate regenerates it exactly.
 */
export const DailySellerRiskReport = z.strictObject({
  asOf: z.iso.datetime(),
  window: RiskWindow,
  reviewPolicyId: SellerRiskReviewPolicyId,
  reviewPolicyVersion: z.string().min(1).max(64),
  top: RiskReportTopSelection,
  /** How many sellers had any paid order in the window, before ranking. */
  sellersConsidered: z.int().nonnegative(),
  rows: z.array(SellerRiskReviewRow),
  promoterAnomalies: z.array(SellerPromoterRiskRow),
  /**
   * Disputes Monacado could not attribute to any sale, and therefore to any
   * seller. Reported beside every rate so the exclusion is visible; never
   * imputed to a seller.
   */
  unattributedDisputeCount: z.bigint().nonnegative(),
});
export type DailySellerRiskReport = z.infer<typeof DailySellerRiskReport>;

/**
 * Deterministic total ordering.
 *
 * Score first, then the concrete adverse counts in descending severity, and
 * finally the opaque participant id — which is total, so the order is fully
 * determined with no clock, no float, and no randomness anywhere in it. Two runs
 * over the same rows produce the same ranks, which is what makes a historical
 * report reproducible at all.
 */
export function compareRiskRows(a: SellerRiskReviewRow, b: SellerRiskReviewRow): number {
  if (a.reviewScore !== b.reviewScore) return b.reviewScore - a.reviewScore;
  if (a.reasons.length !== b.reasons.length) return b.reasons.length - a.reasons.length;
  if (a.finalizedChargebackCount !== b.finalizedChargebackCount) {
    return a.finalizedChargebackCount < b.finalizedChargebackCount ? 1 : -1;
  }
  if (a.disputeOpenedCount !== b.disputeOpenedCount) {
    return a.disputeOpenedCount < b.disputeOpenedCount ? 1 : -1;
  }
  if (a.refundCount !== b.refundCount) return a.refundCount < b.refundCount ? 1 : -1;
  if (a.paidOrderCount !== b.paidOrderCount) return a.paidOrderCount < b.paidOrderCount ? 1 : -1;
  return a.sellerParticipantId < b.sellerParticipantId ? -1 : 1;
}

/** The published ranking arithmetic: a sum of triggered reason weights. */
export function reviewScoreFor(reasons: readonly RiskReviewReason[]): number {
  return reasons.reduce((total, reason) => total + reason.weight, 0);
}

// — The Staff review record —

/**
 * Where the WORK has got to. Forward-only; `CLOSED` is terminal.
 *
 * Deliberately three states and not seven. `MONITOR`, `MITIGATION_REQUIRED`,
 * `CLEARED`, and `SUSPENSION_RECOMMENDED` are things Monacado CONCLUDED, not
 * positions in a queue, and they live on the disposition axis below. Merging the
 * two would make "has a human looked at this yet" and "what did we decide"
 * answerable only as one question — the collapse Phase 1.11 refused when it kept
 * a dispute's adjudication axis apart from its funds axis.
 *
 * If a signal recurs after a review closes, that is a NEW review with its own
 * instant and actor. Phase 0M.R1 settled the same point for restrictions:
 * "restricted, cleared, restricted again" must read as two events rather than
 * one row that changed its mind.
 */
export const RISK_REVIEW_STATUSES = ["OPEN", "UNDER_REVIEW", "CLOSED"] as const;
export const RiskReviewStatus = z.enum(RISK_REVIEW_STATUSES);
export type RiskReviewStatus = z.infer<typeof RiskReviewStatus>;

export const RISK_REVIEW_TRANSITIONS: Record<RiskReviewStatus, readonly RiskReviewStatus[]> = {
  OPEN: ["UNDER_REVIEW", "CLOSED"],
  UNDER_REVIEW: ["CLOSED"],
  CLOSED: [],
};

export function isValidRiskReviewTransition(
  from: RiskReviewStatus,
  to: RiskReviewStatus,
): boolean {
  return RISK_REVIEW_TRANSITIONS[from].includes(to);
}

/**
 * What Monacado DECIDED, as a closed vocabulary.
 *
 * EVERY MEMBER IS SOMETHING RECORDED, NONE IS SOMETHING PERFORMED. The three
 * that name consequences say `RECOMMENDED`, and they mean it: this phase writes
 * no participant status, imposes no restriction, and holds no payout. A Staff
 * member who decides to act does so afterwards through the existing governed
 * restriction authority, under its own separately-checked entitlement — two acts
 * by two grants, so recording a recommendation can never become a silent grant
 * of the power to impose one.
 */
export const RISK_REVIEW_DISPOSITIONS = [
  "NO_ACTION",
  "SIGNAL_NOT_SUBSTANTIATED",
  "DUPLICATE_OR_SUPERSEDED",
  "MONITOR",
  "INFORMATION_REQUESTED_FROM_PARTICIPANT",
  "REMEDIATION_REQUIRED",
  "COMMERCIAL_RESTRICTION_RECOMMENDED",
  "PAYOUT_HOLD_RECOMMENDED",
  "SUSPENSION_RECOMMENDED",
] as const;
export const RiskReviewDisposition = z.enum(RISK_REVIEW_DISPOSITIONS);
export type RiskReviewDisposition = z.infer<typeof RiskReviewDisposition>;

export const RISK_REVIEW_TRIGGER_SOURCES = ["SYSTEM", "STAFF"] as const;
export const RiskReviewTriggerSource = z.enum(RISK_REVIEW_TRIGGER_SOURCES);
export type RiskReviewTriggerSource = z.infer<typeof RiskReviewTriggerSource>;

/**
 * One Staff review of one participant.
 *
 * The trigger is a REPORT COORDINATE, never a copied score: `triggerAsOf` plus
 * the policy version regenerate the exact ranking the reviewer saw, which a
 * stored number could not do. That is also why there is no score column — an
 * analytics figure must never sit in the record as though it were the finding.
 *
 * There is NO NOTE FIELD, and its absence is deliberate. Phase 0M.R1 forbade
 * `investigatorNote`/`internalNote`/`freeTextReason` on restrictions, Phase 1.11
 * forbade `note`/`operatorComment` on disputes, and 1.11 gave the reason in one
 * line: an operator commentary column is where a buyer's name eventually lands.
 * A fraud-review note is the worst instance of that. Nuance is expressed by
 * extending the trigger vocabulary or the disposition vocabulary — both of which
 * are reviewable, and neither of which can hold a sentence about a person.
 */
export const ParticipantRiskReviewRecord = z
  .strictObject({
    id: ParticipantRiskReviewId,
    participantId: ParticipantId,
    triggerSource: RiskReviewTriggerSource,
    triggerAsOf: z.iso.datetime(),
    reviewPolicyId: SellerRiskReviewPolicyId,
    reviewPolicyVersion: z.string().min(1).max(64),
    triggerReasons: z.array(RiskReviewReason).max(RISK_REVIEW_REASON_CODES.length),
    openedAt: z.iso.datetime(),
    openedByAccountId: AccountId.nullable(),
    status: RiskReviewStatus,
    assignedReviewerAccountId: AccountId.nullable(),
    dispositionCode: RiskReviewDisposition.nullable(),
    decidedByAccountId: AccountId.nullable(),
    decidedAt: z.iso.datetime().nullable(),
    resultingRestrictionId: z.string().min(1).max(191).nullable(),
  })
  .refine(
    (r) => (r.status === "CLOSED") === (r.dispositionCode !== null),
    "a CLOSED review carries a disposition and an open one carries none",
  )
  .refine(
    (r) => (r.dispositionCode === null) === (r.decidedByAccountId === null),
    "a disposition names the account that decided it",
  );
export type ParticipantRiskReviewRecord = z.infer<typeof ParticipantRiskReviewRecord>;

// — Boundaries —

/**
 * Named as never admissible on a risk review.
 *
 * The first group would make an analytics number authoritative over a person's
 * judgement, which is the inversion this record exists to prevent. The second is
 * enforcement this phase has neither the terms nor the authority to perform. The
 * third is personal data. A test walks the list.
 */
export const NEVER_ON_RISK_REVIEW = [
  "riskScore",
  "fraudScore",
  "riskTier",
  "modelVersion",
  "autoSuspendAt",
  "automaticRestrictionScope",
  "suspendedAt",
  "note",
  "internalNote",
  "investigatorNote",
  "freeTextReason",
  "buyerEmail",
  "buyerName",
  "ipAddress",
] as const;

/**
 * What this phase does about publication: **nothing**.
 *
 * Stated as a value so the claim is checkable, on
 * `DISPUTE_CAPSULE_PUBLICATION_DISPOSITION`'s terms.
 *
 * There is NO CAPSULE SHAPE AT ALL, which is a stronger statement than "private".
 * A capsule is a projection of an authoritative entity; a risk ranking is a
 * derived analytical opinion about a participant, and giving it a capsule
 * identity would invite exactly the reading this phase refuses — that the score
 * is a fact about the seller rather than a request that somebody look. The
 * `Dispute` capsule was already ruled private because dispute rates are
 * confidential merchant performance data; a seller risk ranking is strictly more
 * sensitive than the rate it is computed from.
 */
export const SELLER_RISK_PUBLICATION_DISPOSITION = {
  capsuleProjection: "NONE",
  visibility: "PRIVATE",
  agentNetPublication: "NONE",
  nodeRegistration: "NONE",
  registrarContact: "NONE",
  publicResolverExposure: "NONE",
  outboxRow: "NONE",
} as const;

/**
 * What a FUTURE Marketplace Policy version must say before any participant-level
 * risk consequence may be operated.
 *
 * RECORDED, NOT CREATED. Version 1.2.0 is not mutated by this phase and no new
 * version is drafted or activated by it. This is the requirement written down at
 * the moment it became visible, which is the same thing Phase 1.12 did when it
 * recorded the fraud-analytics handoff rather than half-building it.
 *
 * The gap is specific. 1.2.0 authorises declining, holding, or reversing **a
 * transaction** on fraud or risk grounds, and states that the classifications
 * behind such a decision are private operational records. It says nothing about
 * monitoring a participant's rates over time, placing a participant under Staff
 * review, or restricting or suspending selling privileges — and its
 * dispute-proceeds term explicitly says a per-sale hold "is not a suspension of a
 * participant's other proceeds". Reporting and internal review are within 1.2.0
 * as it stands; consequences to a participant are not.
 */
export const MARKETPLACE_POLICY_RISK_TERMS_REQUIRED = {
  currentVersionUnchangedByThisPhase: "1.2.0",
  requiredInFutureVersion: "1.3.0",
  permittedUnderCurrentTerms: [
    "PRIVATE_RISK_REPORTING",
    "INTERNAL_STAFF_REVIEW_RECORD",
    "PER_TRANSACTION_RISK_DECISIONS_ALREADY_GOVERNED",
  ],
  requiresNewTermsBeforeOperating: [
    "ONGOING_PARTICIPANT_LEVEL_RISK_MONITORING",
    "PLACING_A_PARTICIPANT_UNDER_STAFF_REVIEW_AS_A_DISCLOSED_TERM",
    "RESTRICTING_SELLING_CAPABILITY_ON_RISK_GROUNDS",
    "SUSPENDING_A_PARTICIPANT_ON_RISK_GROUNDS",
    "NOTICE_AND_APPEAL_FOR_A_PARTICIPANT_LEVEL_RISK_DECISION",
  ],
  requiresReacceptance: true,
  createdOrActivatedByThisPhase: "NONE",
} as const;

/**
 * Recommended daily execution. NOT a committed scheduler configuration.
 *
 * No cron file, no platform configuration, and no deployment manifest is added
 * by this phase — the repository holds no authoritative statement of where
 * production runs, and guessing would put a schedule in source that nobody
 * operates. Unlike the refund processor, a DAILY cadence is genuinely sufficient
 * here, because a daily review is the product rather than a compromise.
 */
export const SELLER_RISK_REVIEW_SCHEDULE_GUIDANCE = {
  recommendedCron: "0 9 * * *",
  recommendedIntervalSeconds: 86_400,
  dailyCadenceAdequate: true,
  committedCronDeclaration: "NONE",
} as const;
