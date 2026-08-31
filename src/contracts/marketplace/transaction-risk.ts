/**
 * Transaction risk gate (Phase 1.2).
 *
 * A **narrow, synchronous allow/deny** decision taken before a payment is
 * initiated, and the first entry in what the roadmap calls `0M.R2`.
 *
 * ## What it is
 *
 * Four controls, each justified by something that could actually go wrong at
 * launch, and each answerable from state Monacado already holds:
 *
 * | Control | Failure it prevents |
 * | --- | --- |
 * | maximum single-order amount | one mispriced Listing taking an unrecoverable sum |
 * | active participant restriction | a restricted seller continuing to transact |
 * | seller commerce approval | selling by a participant nobody cleared |
 * | payment-account readiness | booking proceeds nobody can ever be paid |
 *
 * ## What it deliberately is not
 *
 * **No fraud scoring, no machine learning, no velocity engine, no reserve system,
 * no chargeback prediction, and no manual-review workflow.** Every one of those
 * needs data Monacado does not have and an operational function that does not
 * exist, and a scoring model with nobody to review its output is a number that
 * blocks buyers for reasons no one can explain.
 *
 * A test asserts the vocabulary names none of them.
 *
 * ## Thresholds are versioned, never constants
 *
 * A maximum order amount hard-coded in source is a number that changes without a
 * record of who changed it or what an Order was evaluated under. `RiskPolicy`
 * mirrors `0M.R1`'s `CommercialPolicy` exactly — immutable versions, one `ACTIVE`
 * at a time, retired versions still bindable — so every decision names the exact
 * `(policyId, policyVersion)` that produced it.
 *
 * ## Fail closed
 *
 * No configured policy is a **denial**, not a default limit. An unconfigured
 * deployment must refuse commerce rather than invent a threshold, for the same
 * reason `0M.9` made absent commerce approval mean `NOT_APPROVED`: the safe
 * reading of silence is "no".
 *
 * Pure types and pure decisions. No I/O, no clock, no database.
 */

import { z } from "zod";
import { RISK_POLICY_ID_RE } from "./identity";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";

const Amount = z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT);

// — Identity —

export const RiskPolicyId = z
  .string()
  .regex(RISK_POLICY_ID_RE, "riskPolicyId must be mon:rpol:<opaque>");
export type RiskPolicyId = z.infer<typeof RiskPolicyId>;

export const RiskPolicyVersion = z.string().min(1).max(64);
export type RiskPolicyVersion = z.infer<typeof RiskPolicyVersion>;

/** `0M.R1`'s own version lifecycle, reused rather than restated. */
export const RISK_POLICY_VERSION_STATUSES = ["DRAFT", "ACTIVE", "RETIRED"] as const;
export const RiskPolicyVersionStatus = z.enum(RISK_POLICY_VERSION_STATUSES);
export type RiskPolicyVersionStatus = z.infer<typeof RiskPolicyVersionStatus>;

// — The policy —

/**
 * One immutable version of Monacado's transaction risk controls.
 *
 * Every field is an **input**, never a derived value. There is no score weight,
 * no model reference, no threshold curve, and no list of blocked identities: this
 * describes limits, and identities are governed by `0M.R1`'s restriction records
 * where they belong.
 */
export const RiskPolicyVersionRecord = z.strictObject({
  policyId: RiskPolicyId,
  policyVersion: RiskPolicyVersion,
  status: RiskPolicyVersionStatus,

  /** Limits are currency-specific; a threshold means nothing without one. */
  currency: CurrencyCode,
  /**
   * The largest **commercial retail** amount one Order may carry.
   *
   * Retail rather than buyer total, deliberately: tax and shipping are
   * pass-through amounts Monacado neither earns nor sets, and letting them push
   * an Order over a commercial limit would deny a sale for somebody else's rate.
   */
  maxSingleOrderCommercialAmountMinorUnits: Amount,

  /** Whether a seller must hold a current `APPROVED` commerce decision. */
  requireSellerCommerceApproval: z.boolean(),
  /** Whether a seller's provider account must be `ENABLED` to sell. */
  requireSellerPaymentReadiness: z.boolean(),

  effectiveFrom: z.iso.datetime(),
  recordedByAccountId: z.string().min(1).max(191),
  recordedAt: z.iso.datetime(),
  retiredAt: z.iso.datetime().nullable(),
  retiredByAccountId: z.string().min(1).max(191).nullable(),
});
export type RiskPolicyVersionRecord = z.infer<typeof RiskPolicyVersionRecord>;

// — The decision —

export const RISK_DECISIONS = ["ALLOW", "DENY"] as const;
export const RiskDecisionOutcome = z.enum(RISK_DECISIONS);
export type RiskDecisionOutcome = z.infer<typeof RiskDecisionOutcome>;

/**
 * Why a transaction was denied, as a closed vocabulary.
 *
 * Bounded codes, never free text and never a score. Each is safe to log, safe to
 * surface to an operator, and carries no name, amount, or provider message. A
 * caller receives **every** applicable reason rather than the first, on the same
 * reasoning as `evaluateListingBuyerEligibility`: fixing one blocker only to meet
 * the next is a worse experience than being told all of them.
 */
export const RISK_DENIAL_REASON_CODES = [
  /** The commercial amount exceeds the active policy's ceiling. */
  "ORDER_AMOUNT_EXCEEDS_LIMIT",
  /** The order's currency is not the one the active policy governs. */
  "CURRENCY_NOT_PERMITTED",
  /** The seller currently holds an active commerce restriction. */
  "SELLER_RESTRICTED",
  /** The promoter currently holds an active commerce restriction. */
  "PROMOTER_RESTRICTED",
  /** Monacado has not cleared the seller to transact. */
  "SELLER_NOT_COMMERCE_APPROVED",
  /** The seller's payment account is not ready to receive proceeds. */
  "SELLER_PAYMENT_NOT_READY",
  /** No active risk policy exists. Fails closed — never a default limit. */
  "RISK_POLICY_NOT_CONFIGURED",
] as const;
export const RiskDenialReasonCode = z.enum(RISK_DENIAL_REASON_CODES);
export type RiskDenialReasonCode = z.infer<typeof RiskDenialReasonCode>;

/**
 * The denial reasons that describe a PARTY rather than the transaction
 * (Phase 1.15).
 *
 * The vocabulary above is documented as safe to surface **to an operator**, and
 * that qualifier is load-bearing: the four members here each name a counterparty
 * and something withheld from them. A checkout request names one Listing, so a
 * denial naming one of these tells the requester — who may be an anonymous buyer
 * — that this specific seller or promoter has been restricted, not cleared, or
 * cannot be paid.
 *
 * The remaining three describe the transaction itself (its amount, its currency)
 * or Monacado's own configuration, and disclose nothing about a participant.
 */
export const PARTY_DISCLOSING_RISK_DENIAL_REASON_CODES = [
  "SELLER_RESTRICTED",
  "PROMOTER_RESTRICTED",
  "SELLER_NOT_COMMERCE_APPROVED",
  "SELLER_PAYMENT_NOT_READY",
] as const satisfies readonly RiskDenialReasonCode[];

/**
 * The subset of denial reasons safe to return to a buyer.
 *
 * Order-preserving and total. A caller that returns the result discloses no
 * counterparty standing; an empty result is the honest answer that the buyer is
 * owed the outcome and not the cause.
 */
export function buyerSafeRiskDenialReasons(
  reasonCodes: readonly string[],
): readonly string[] {
  const withheld: readonly string[] = PARTY_DISCLOSING_RISK_DENIAL_REASON_CODES;
  return reasonCodes.filter((c) => !withheld.includes(c));
}

/**
 * The gate's answer.
 *
 * A discriminated shape in spirit: an `ALLOW` carries no reasons and a `DENY`
 * carries at least one, checked below. "Allowed, but…" is not expressible, which
 * matters because a caller reading a permissive decision must not have to also
 * inspect a reason list to discover it was really a refusal.
 *
 * The bound policy is named on **both** outcomes, so an allowed transaction is
 * as explicable after the fact as a denied one.
 */
export const RiskDecision = z
  .strictObject({
    decision: RiskDecisionOutcome,
    reasonCodes: z.array(RiskDenialReasonCode).max(RISK_DENIAL_REASON_CODES.length),
    /** `null` only when no policy could be resolved at all. */
    policyId: RiskPolicyId.nullable(),
    policyVersion: RiskPolicyVersion.nullable(),
    evaluatedAt: z.iso.datetime(),
  })
  .refine(
    (d) => (d.decision === "ALLOW" ? d.reasonCodes.length === 0 : d.reasonCodes.length > 0),
    "an ALLOW carries no reasons and a DENY carries at least one",
  );
export type RiskDecision = z.infer<typeof RiskDecision>;

export function riskAllowed(decision: RiskDecision): boolean {
  return decision.decision === "ALLOW";
}

/** Deterministic ordering, so one situation always reports one list. */
export function canonicalizeDenialReasons(
  codes: readonly RiskDenialReasonCode[],
): RiskDenialReasonCode[] {
  return Array.from(new Set(codes)).sort(
    (a, b) => RISK_DENIAL_REASON_CODES.indexOf(a) - RISK_DENIAL_REASON_CODES.indexOf(b),
  );
}

// — Inputs —

export const RecordRiskPolicyVersionInput = z.strictObject({
  policyId: RiskPolicyId,
  policyVersion: RiskPolicyVersion,
  currency: CurrencyCode,
  maxSingleOrderCommercialAmountMinorUnits: Amount,
  requireSellerCommerceApproval: z.boolean(),
  requireSellerPaymentReadiness: z.boolean(),
  effectiveFrom: z.iso.datetime(),
  recordedByAccountId: z.string().min(1).max(191),
  recordedAt: z.iso.datetime(),
});
export type RecordRiskPolicyVersionInput = z.infer<typeof RecordRiskPolicyVersionInput>;

// — Never here —

/**
 * Named as never admissible on a risk policy or a decision.
 *
 * The first group is the **speculative risk machinery** this phase refuses to
 * begin. The second is **personal data**, which a risk system is the classic
 * route to accumulating. A test walks the list and proves each is refused.
 */
export const NEVER_ON_RISK_POLICY = [
  // scoring and prediction — not this phase, and not without a review function
  "riskScore",
  "fraudScore",
  "modelVersion",
  "scoreThreshold",
  "chargebackProbability",
  "velocityWindowSeconds",
  "maxOrdersPerHour",
  "reservePercentageBasisPoints",
  "reserveHoldDays",
  "manualReviewQueue",
  // personal data — restrictions govern identities, not this
  "blockedEmails",
  "blockedIpRanges",
  "blockedCountries",
  "deviceFingerprint",
  "buyerEmail",
] as const;
