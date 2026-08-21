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
