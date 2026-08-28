/**
 * Seller risk intelligence errors (Phase 1.13) — SERVER ONLY.
 *
 * **An elevated metric is not an error, and neither is a refusal to compute a
 * rate.** A report returns a `NO_DENOMINATOR` or `SAMPLE_BELOW_GOVERNED_MINIMUM`
 * rate for every ordinary case where arithmetic is unavailable, because a caller
 * must be able to tell "this seller has too few sales to rate" from "the report
 * is broken" without catching. These are only for the second case, and for a
 * caller asking for something the governance does not permit.
 *
 * No error here carries a participant, an amount, a rate, or a buyer detail — an
 * error object is where operational detail leaks into a log.
 */

import "../server-only";

export class SellerRiskError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SellerRiskError";
    this.code = code;
  }
}

/**
 * No review-heuristics version is `ACTIVE`.
 *
 * FAILS CLOSED, and refuses rather than inventing thresholds. An unconfigured
 * deployment must not rank sellers against numbers nobody governed — the same
 * reading of silence Phase 1.2 took when it made an absent risk policy a denial
 * rather than a default limit.
 */
export class SellerRiskReviewPolicyNotConfiguredError extends SellerRiskError {
  constructor() {
    super(
      "SELLER_RISK_REVIEW_POLICY_NOT_CONFIGURED",
      "No active seller risk-review policy version. Record and activate one before running a review.",
    );
    this.name = "SellerRiskReviewPolicyNotConfiguredError";
  }
}

/** The caller does not hold `participant:risk-review`. */
export class RiskReviewNotAuthorizedError extends SellerRiskError {
  readonly reasonCodes: readonly string[];
  constructor(reasonCodes: readonly string[]) {
    super("RISK_REVIEW_NOT_AUTHORIZED", "This account may not read or record risk reviews");
    this.name = "RiskReviewNotAuthorizedError";
    this.reasonCodes = reasonCodes;
  }
}

/** A review was asked to move somewhere its lifecycle does not permit. */
export class RiskReviewTransitionError extends SellerRiskError {
  constructor(message: string) {
    super("RISK_REVIEW_TRANSITION_REFUSED", message);
    this.name = "RiskReviewTransitionError";
  }
}

/**
 * A second review was opened for a participant who already has one open.
 *
 * A re-firing daily signal is the SAME concern, not a second one. The database
 * refuses the duplicate through `openForParticipantId`; this names what happened
 * so a caller can carry on rather than treating a constraint violation as a
 * failure.
 */
export class RiskReviewAlreadyOpenError extends SellerRiskError {
  constructor() {
    super("RISK_REVIEW_ALREADY_OPEN", "This participant already has an open risk review");
    this.name = "RiskReviewAlreadyOpenError";
  }
}

/** A malformed or unusable request reached a risk read path. */
export class SellerRiskRequestError extends SellerRiskError {
  constructor(message: string) {
    super("SELLER_RISK_REQUEST_INVALID", message);
    this.name = "SellerRiskRequestError";
  }
}
