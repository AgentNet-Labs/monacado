/**
 * MoR transaction accounting errors (Phase 0M.T1).
 *
 * Three rules, two inherited and one this phase adds:
 *
 *   1. **No error carries private data**, and none carries a monetary value.
 *      An amount, a rate, or a computed figure in an error message would put a
 *      party's economics into a log nobody decided to publish them in. Errors
 *      name identifiers, field paths, and closed-enum members only.
 *
 *   2. **Internal causes are non-enumerable**, via the shared
 *      `attachInternalCause` helper, so `JSON.stringify(error)` cannot leak a
 *      driver message or a connection string.
 *
 *   3. **No error carries a provider transaction reference.** It is external
 *      evidence tying Monacado's record to a payment at a provider, and a
 *      reference in an error message is a reference in a log aggregator.
 */

import { attachInternalCause } from "../product/error-cause";

export type TransactionAccountingErrorCode =
  | "INVALID_TRANSACTION_ACCOUNTING_INPUT"
  | "TRANSACTION_SNAPSHOT_NOT_FOUND"
  | "TRANSACTION_SETTLEMENT_NOT_FOUND"
  | "LISTING_SOURCE_VERSION_NOT_FOUND"
  | "OFFER_SOURCE_VERSION_NOT_FOUND"
  | "COMMERCIAL_POLICY_VERSION_NOT_BINDABLE"
  | "TRANSACTION_CURRENCY_MISMATCH"
  | "TRANSACTION_ECONOMICS_REFUSED"
  | "TRANSACTION_RECONCILIATION_REFUSED"
  | "TRANSACTION_ECONOMICS_DRIFTED"
  | "INVALID_SETTLEMENT_TRANSITION"
  | "PROVIDER_TRANSACTION_REFERENCE_ALREADY_RECORDED"
  | "DUPLICATE_PROVIDER_TRANSACTION_REFERENCE"
  | "CORRUPT_TRANSACTION_RECORD"
  | "TRANSACTION_ACCOUNTING_PERSISTENCE_FAILURE";

export class TransactionAccountingServiceError extends Error {
  readonly code: TransactionAccountingErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: TransactionAccountingErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "TransactionAccountingServiceError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/** Malformed input. `fields` names paths only — never the rejected value. */
export class InvalidTransactionAccountingInputError extends TransactionAccountingServiceError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_TRANSACTION_ACCOUNTING_INPUT", "Invalid transaction accounting input");
    this.name = "InvalidTransactionAccountingInputError";
    this.fields = fields;
  }
}

export class TransactionSnapshotNotFoundError extends TransactionAccountingServiceError {
  constructor() {
    super("TRANSACTION_SNAPSHOT_NOT_FOUND", "No transaction economic snapshot exists for that identifier");
    this.name = "TransactionSnapshotNotFoundError";
  }
}

/**
 * A snapshot exists but its settlement row does not.
 *
 * Unreachable through the service — both are written in one transaction — and
 * raised rather than repaired, because a financial record missing half of itself
 * means a partially written transaction that must fail loudly.
 */
export class TransactionSettlementNotFoundError extends TransactionAccountingServiceError {
  constructor() {
    super("TRANSACTION_SETTLEMENT_NOT_FOUND", "No settlement record exists for that snapshot");
    this.name = "TransactionSettlementNotFoundError";
  }
}

/** The exact Listing source version named does not exist. Never "use the current one". */
export class ListingSourceVersionNotFoundError extends TransactionAccountingServiceError {
  constructor(cause?: unknown) {
    super(
      "LISTING_SOURCE_VERSION_NOT_FOUND",
      "No Listing source version exists for that listing and version",
      cause,
    );
    this.name = "ListingSourceVersionNotFoundError";
  }
}

export class OfferSourceVersionNotFoundError extends TransactionAccountingServiceError {
  constructor(cause?: unknown) {
    super(
      "OFFER_SOURCE_VERSION_NOT_FOUND",
      "No Offer source version exists for the version this Listing accepted",
      cause,
    );
    this.name = "OfferSourceVersionNotFoundError";
  }
}

/**
 * The named policy version exists but may not price a sale.
 *
 * A `DRAFT` version is the only unbindable one: nothing ever ran under it, and
 * producing economics from one would let an unapproved rate price a transaction.
 * A `RETIRED` version binds normally — a historical sale reproduces from the
 * version it actually ran under, which by then is usually retired.
 */
export class CommercialPolicyVersionNotBindableError extends TransactionAccountingServiceError {
  constructor(cause?: unknown) {
    super(
      "COMMERCIAL_POLICY_VERSION_NOT_BINDABLE",
      "That commercial policy version may not be used for transaction economics",
      cause,
    );
    this.name = "CommercialPolicyVersionNotBindableError";
  }
}

/**
 * The transaction currency, the Listing's retail currency, and the policy
 * currency do not all agree.
 *
 * Refused rather than coerced, exactly as 0M.4A refuses it: a silent conversion
 * would produce a plausible price nobody agreed to. `field` names which
 * comparison failed and carries no currency value.
 */
export class TransactionCurrencyMismatchError extends TransactionAccountingServiceError {
  readonly field: string;
  constructor(field: string) {
    super("TRANSACTION_CURRENCY_MISMATCH", "The transaction currencies do not agree");
    this.name = "TransactionCurrencyMismatchError";
    this.field = field;
  }
}

/**
 * The committed 0M.4A calculator refused these economics.
 *
 * `reason` is the calculator's own bounded code — `NEGATIVE_ACQUISITION_AMOUNT`,
 * `NEGATIVE_PROMOTER_PROCEEDS`, `COMMISSION_EXCEEDS_OFFER_WHOLESALE`, and so on.
 * The refusal is surfaced rather than rewritten, so the reason a sale could not
 * be accounted for is the reason the economics gave.
 */
export class TransactionEconomicsRefusedError extends TransactionAccountingServiceError {
  readonly reason: string;
  constructor(reason: string) {
    super("TRANSACTION_ECONOMICS_REFUSED", "The transaction economics were refused");
    this.name = "TransactionEconomicsRefusedError";
    this.reason = reason;
  }
}

/**
 * The accounting identity did not hold, so nothing was written.
 *
 * The guarantee this phase exists to provide: a snapshot that does not add up to
 * what the buyer was charged for the merchandise never reaches a row.
 */
export class TransactionReconciliationRefusedError extends TransactionAccountingServiceError {
  readonly reason: string;
  constructor(reason: string) {
    super(
      "TRANSACTION_RECONCILIATION_REFUSED",
      "The transaction economics do not reconcile and were not recorded",
    );
    this.name = "TransactionReconciliationRefusedError";
    this.reason = reason;
  }
}

/**
 * A stored snapshot no longer matches what its bound sources deterministically
 * produce.
 *
 * Unreachable while the bindings are exact and the versions immutable — which is
 * the point of checking. `fields` names which amounts disagree and carries no
 * amounts.
 */
export class TransactionEconomicsDriftedError extends TransactionAccountingServiceError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super(
      "TRANSACTION_ECONOMICS_DRIFTED",
      "A stored transaction snapshot does not match its bound authoritative sources",
    );
    this.name = "TransactionEconomicsDriftedError";
    this.fields = fields;
  }
}

export class InvalidSettlementTransitionError extends TransactionAccountingServiceError {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) {
    super("INVALID_SETTLEMENT_TRANSITION", "That settlement state change is not permitted");
    this.name = "InvalidSettlementTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * An attempt to replace a recorded provider transaction reference.
 *
 * Write-once by design. A recorded reference is the evidence of *which* external
 * transaction a snapshot is, and replacing it would silently re-point a financial
 * record at a different one.
 */
export class ProviderTransactionReferenceAlreadyRecordedError extends TransactionAccountingServiceError {
  constructor() {
    super(
      "PROVIDER_TRANSACTION_REFERENCE_ALREADY_RECORDED",
      "A provider transaction reference is already recorded for this snapshot",
    );
    this.name = "ProviderTransactionReferenceAlreadyRecordedError";
  }
}

/**
 * The same provider transaction is already recorded against another snapshot.
 *
 * Enforced by the `(provider, providerTransactionRef)` unique index rather than
 * a read-then-write check, so two concurrent reconciliations cannot both bind one
 * provider charge to a different sale.
 */
export class DuplicateProviderTransactionReferenceError extends TransactionAccountingServiceError {
  constructor(cause?: unknown) {
    super(
      "DUPLICATE_PROVIDER_TRANSACTION_REFERENCE",
      "That provider transaction is already recorded against another snapshot",
      cause,
    );
    this.name = "DuplicateProviderTransactionReferenceError";
  }
}

export class CorruptTransactionRecordError extends TransactionAccountingServiceError {
  readonly fields: string[];
  constructor(fields: string[], cause?: unknown) {
    super("CORRUPT_TRANSACTION_RECORD", "A stored transaction record failed validation", cause);
    this.name = "CorruptTransactionRecordError";
    this.fields = fields;
  }
}

export class TransactionAccountingPersistenceFailureError extends TransactionAccountingServiceError {
  readonly stage: string;
  constructor(stage: string, cause?: unknown) {
    super(
      "TRANSACTION_ACCOUNTING_PERSISTENCE_FAILURE",
      "A transaction accounting persistence operation failed",
      cause,
    );
    this.name = "TransactionAccountingPersistenceFailureError";
    this.stage = stage;
  }
}
