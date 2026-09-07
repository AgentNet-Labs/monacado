/**
 * Risk gate errors (Phase 1.2) — SERVER ONLY.
 *
 * **A denial is not an error.** `evaluateTransactionRisk` returns a `RiskDecision`
 * for every ordinary outcome, including refusal, because a caller must be able to
 * tell "denied, and here is why" from "the gate itself is broken" without
 * catching. These are only for the second case.
 *
 * No error here carries an amount, a participant, or a threshold — an error
 * object is where operational detail leaks into a log.
 */

import "../server-only";

export class RiskError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RiskError";
    this.code = code;
  }
}

/** The gate could not read the state it needs. Fails closed at the caller. */
export class RiskEvaluationFailureError extends RiskError {
  readonly cause?: unknown;
  constructor(cause?: unknown) {
    super("RISK_EVALUATION_FAILURE", "The transaction risk gate could not be evaluated");
    this.name = "RiskEvaluationFailureError";
    this.cause = cause;
  }
}

/**
 * A transaction was denied and a caller attempted to proceed anyway.
 *
 * Carries the bounded reason codes and nothing else — they are safe to log and
 * safe to surface, which is why the vocabulary is closed.
 */
export class TransactionDeniedByRiskError extends RiskError {
  readonly reasonCodes: readonly string[];
  constructor(reasonCodes: readonly string[]) {
    super("TRANSACTION_DENIED_BY_RISK", "This transaction was denied by Monacado's risk controls");
    this.name = "TransactionDeniedByRiskError";
    this.reasonCodes = reasonCodes;
  }
}

/**
 * An account tried to record or activate a risk policy version without the
 * entitlement that permits it (Phase 1.20).
 *
 * A risk policy version is a control rather than a price: it decides whether a
 * sale needs commerce approval and payment readiness at all, and what a single
 * Order may be worth. Until this existed the service read no account of any
 * kind — the actor was an opaque string written straight to the row.
 *
 * Carries the internal vocabulary's bounded reason codes and nothing else: no
 * threshold, no participant, no amount, per this module's standing rule.
 */
export class RiskPolicyActorNotAuthorizedError extends RiskError {
  readonly reasonCodes: readonly string[];
  /** The internal capability that was required. An operator's fact. */
  readonly requiredCapability = "risk-policy:govern";
  constructor(reasonCodes: readonly string[]) {
    super(
      "RISK_POLICY_ACTOR_NOT_AUTHORIZED",
      "That account may not govern risk policy versions",
    );
    this.name = "RiskPolicyActorNotAuthorizedError";
    this.reasonCodes = reasonCodes;
  }
}
