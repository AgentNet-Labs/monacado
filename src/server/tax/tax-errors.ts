/**
 * Tax boundary errors (Phase 1.2) — SERVER ONLY.
 *
 * Bounded and few. **No error carries a buyer address, a jurisdiction detail
 * beyond a bounded code, or an engine's message** — an error object is the first
 * place private detail reaches a log.
 */

import "../server-only";

export class TaxError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TaxError";
    this.code = code;
  }
}

/**
 * No tax result could be obtained, so no payment may be taken.
 *
 * The important property is that this **refuses rather than defaults**. A zero
 * returned because an engine was unreachable is indistinguishable from a zero
 * that is genuinely correct, and the difference is a tax liability nobody
 * recorded.
 */
export class TaxCalculationUnavailableError extends TaxError {
  readonly cause?: unknown;
  constructor(cause?: unknown) {
    super("TAX_CALCULATION_UNAVAILABLE", "No authoritative tax result is available");
    this.name = "TaxCalculationUnavailableError";
    this.cause = cause;
  }
}

/** The engine's answer contradicted itself. Refused before it can be charged. */
export class IncoherentTaxQuoteError extends TaxError {
  constructor() {
    super("INCOHERENT_TAX_QUOTE", "The tax engine returned an incoherent result");
    this.name = "IncoherentTaxQuoteError";
  }
}

/**
 * The quote was computed on a different sale than the Order records.
 *
 * The same class of check as `0M.9`'s `QuoteSnapshotMismatchError`: if the
 * Listing moved between pricing and placement, Monacado would be charging tax
 * assessed on one basis while booking a sale at another.
 */
export class TaxBasisMismatchError extends TaxError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("TAX_BASIS_MISMATCH", "The tax quote does not match the Order it would be charged on");
    this.name = "TaxBasisMismatchError";
    this.fields = fields;
  }
}

export class TaxEvidencePersistenceFailureError extends TaxError {
  readonly operation: string;
  readonly cause?: unknown;
  constructor(operation: string, cause?: unknown) {
    super("TAX_EVIDENCE_PERSISTENCE_FAILURE", `Tax evidence failed to persist: ${operation}`);
    this.name = "TaxEvidencePersistenceFailureError";
    this.operation = operation;
    this.cause = cause;
  }
}
