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

// — Production tax integration (Phase 1.6) —

/**
 * The deployment's tax configuration is absent, incomplete, or contradictory.
 *
 * Carries **field names**, never values: a tax configuration error is exactly the
 * log line an API key ends up in. The distinction from
 * `TaxCalculationUnavailableError` is deliberate — that one means "no result",
 * this one means "no result, and here is the control an operator must set".
 */
export class TaxProviderConfigurationError extends TaxError {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(
      "TAX_PROVIDER_NOT_CONFIGURED",
      `The tax provider configuration is incomplete: ${issues.join(", ")}`,
    );
    this.name = "TaxProviderConfigurationError";
    this.issues = issues;
  }
}

/**
 * The Product being sold declares no tax classification, so nothing may be sold.
 *
 * **The most important refusal this phase adds.** Every alternative to it is a
 * guess: defaulting to a general goods code taxes software at the wrong rate,
 * defaulting to zero collects nothing where collection was required, and either
 * one is silent. An unclassified Product is a Product nobody has decided the tax
 * treatment of, and that decision is not a checkout's to make.
 *
 * Carries the Product id — an opaque Monacado identifier, safe to log — so an
 * operator can fix the actual record rather than hunt for it.
 */
export class ProductTaxClassificationMissingError extends TaxError {
  readonly internalProductId: string;
  constructor(internalProductId: string) {
    super(
      "PRODUCT_TAX_CLASSIFICATION_MISSING",
      "This product declares no tax classification, so it cannot be sold under a production tax calculation",
    );
    this.name = "ProductTaxClassificationMissingError";
    this.internalProductId = internalProductId;
  }
}

/**
 * A classification exists but this deployment maps it to no provider code.
 *
 * A configuration gap rather than a data gap, and named separately because the
 * remedy is different: the Product is fine, and somebody has to decide which
 * provider tax code Monacado's `SOFTWARE` means **for this deployment's
 * registrations**. That is a fiscal determination, so this repository ships no
 * default for it.
 */
export class TaxClassificationNotMappedError extends TaxError {
  readonly classification: string;
  constructor(classification: string) {
    super(
      "TAX_CLASSIFICATION_NOT_MAPPED",
      "No provider tax code is configured for this product tax classification",
    );
    this.name = "TaxClassificationNotMappedError";
    this.classification = classification;
  }
}

/**
 * The engine computed an amount it will not give Monacado a reference for.
 *
 * Stripe returns a calculation with a **null id** when the result cannot be used
 * to create a provider-side transaction — most commonly because no registration
 * covers the destination. Monacado refuses it rather than charging on it: a sale
 * whose tax cannot afterwards be evidenced to, or reversed with, the engine that
 * computed it is a sale nobody can answer questions about.
 *
 * This is the refusal that makes an unconfigured registration posture *visible*
 * instead of silently producing zero-tax sales.
 */
export class TaxCalculationNotReferenceableError extends TaxError {
  constructor() {
    super(
      "TAX_CALCULATION_NOT_REFERENCEABLE",
      "The tax engine returned a calculation it will not give a durable reference for",
    );
    this.name = "TaxCalculationNotReferenceableError";
  }
}

/**
 * The provider answered from LIVE mode in a phase that permits only TEST.
 *
 * Read from the **provider's own statement** about the object it returned, not
 * from Monacado's configuration — a deployment that believes it is in test mode
 * while holding a live credential is precisely the case a configuration-side
 * check cannot see.
 */
export class TaxProviderModeNotPermittedError extends TaxError {
  readonly observedMode: string;
  constructor(observedMode: string) {
    super(
      "TAX_PROVIDER_MODE_NOT_PERMITTED",
      "The tax engine answered from a mode this deployment does not permit",
    );
    this.name = "TaxProviderModeNotPermittedError";
    this.observedMode = observedMode;
  }
}

/**
 * The engine's answer is past the instant the engine itself said it expires.
 *
 * Never reused anyway. An expired calculation cannot become the provider-side
 * transaction a reversal needs, so charging on one buys a sale that cannot be
 * refunded through the tax engine.
 */
export class TaxQuoteExpiredError extends TaxError {
  constructor() {
    super("TAX_QUOTE_EXPIRED", "The tax calculation is no longer honoured by the provider");
    this.name = "TaxQuoteExpiredError";
  }
}

/**
 * The engine answered about a different Product, or a different version of it.
 *
 * The same class of check as `TaxBasisMismatchError`, applied to the *thing*
 * rather than the *amount*: a quote calculated against a Product source version
 * other than the one being purchased is a rate for a different sale.
 */
export class TaxProductBasisMismatchError extends TaxError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super(
      "TAX_PRODUCT_BASIS_MISMATCH",
      "The tax quote was calculated against a different Product source version",
    );
    this.name = "TaxProductBasisMismatchError";
    this.fields = fields;
  }
}

/**
 * The engine could not be reached, or refused the request.
 *
 * **The provider's message is deliberately discarded.** A vendor error string can
 * carry the request it was about, and this one was about a buyer's address.
 * `cause` is retained for a debugger and is never rendered into a log line by
 * anything in this repository.
 */
export class TaxProviderRequestFailedError extends TaxError {
  readonly cause?: unknown;
  constructor(cause?: unknown) {
    super("TAX_PROVIDER_REQUEST_FAILED", "The tax engine did not return a usable result");
    this.name = "TaxProviderRequestFailedError";
    this.cause = cause;
  }
}
