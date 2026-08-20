/**
 * Payment-provider account errors (Phase 0M.8).
 *
 * Three rules, the first two inherited from the participant and account error
 * modules and the third specific to this domain:
 *
 *   1. **No error carries private data.** Not a provider message, a requirement
 *      detail, a document reference, a bank detail, a legal name, or a database
 *      message. `fields` names paths only.
 *
 *   2. **Internal causes are non-enumerable**, via the shared
 *      `attachInternalCause` helper, so `JSON.stringify(error)` cannot leak a
 *      driver message or a connection string.
 *
 *   3. **A provider's answer is never echoed.** The provider's own error body is
 *      the single richest source of private underwriting data in this phase's
 *      surface area, and it is exactly what a naive adapter would attach to an
 *      error and a naive service would persist. Nothing here accepts one:
 *      `ProviderObservationRejectedError` carries a bounded Monacado
 *      classification and the attempted transition, both of which are members of
 *      closed enums.
 *
 * Deliberately NOT an error: a payment account at `NOT_STARTED`, or one with
 * outstanding requirements. Those are ordinary answers a caller handles.
 */

import { attachInternalCause } from "../product/error-cause";

export type PaymentAccountErrorCode =
  | "INVALID_PAYMENT_ACCOUNT_INPUT"
  | "PAYMENT_ACCOUNT_NOT_FOUND"
  | "DUPLICATE_PAYMENT_ACCOUNT"
  | "PROVIDER_ACCOUNT_REF_ALREADY_LINKED"
  | "PROVIDER_ACCOUNT_REF_MISMATCH"
  | "INVALID_PAYMENT_READINESS_TRANSITION"
  | "MULTIPLE_PAYMENT_PROVIDERS_NOT_SUPPORTED_IN_PHASE"
  | "AMBIGUOUS_PAYMENT_READINESS"
  | "CORRUPT_PAYMENT_ACCOUNT_RECORD"
  | "PAYMENT_ACCOUNT_PERSISTENCE_FAILURE";

export class PaymentAccountError extends Error {
  readonly code: PaymentAccountErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: PaymentAccountErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "PaymentAccountError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/** Malformed input. `fields` names paths only — never the rejected value. */
export class InvalidPaymentAccountInputError extends PaymentAccountError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_PAYMENT_ACCOUNT_INPUT", "Invalid payment account input");
    this.name = "InvalidPaymentAccountInputError";
    this.fields = fields;
  }
}

export class PaymentAccountNotFoundError extends PaymentAccountError {
  constructor() {
    super("PAYMENT_ACCOUNT_NOT_FOUND", "No payment account exists for this participant and provider");
    this.name = "PaymentAccountNotFoundError";
  }
}

/** This participant already holds an account with this provider. */
export class DuplicatePaymentAccountError extends PaymentAccountError {
  constructor(cause?: unknown) {
    super(
      "DUPLICATE_PAYMENT_ACCOUNT",
      "This participant already holds an account with that provider",
      cause,
    );
    this.name = "DuplicatePaymentAccountError";
  }
}

/**
 * Another participant already holds this provider account.
 *
 * Enforced by the `(provider, providerAccountRef)` unique index rather than a
 * read-then-write check, so two concurrent claims cannot both succeed. The
 * reference is deliberately **not** named in the error: which participant holds
 * it is exactly the cross-participant fact a caller must not learn.
 */
export class ProviderAccountRefAlreadyLinkedError extends PaymentAccountError {
  constructor(cause?: unknown) {
    super(
      "PROVIDER_ACCOUNT_REF_ALREADY_LINKED",
      "That provider account is already linked to a participant",
      cause,
    );
    this.name = "ProviderAccountRefAlreadyLinkedError";
  }
}

/**
 * An observation arrived for a different provider account than the stored one.
 *
 * A reconciliation failure, not an update. Silently re-pointing the row would
 * rewrite which external account a participant is linked to on the strength of
 * one API response — and the payout attribution built on it afterwards would be
 * attached to an account nobody decided to link.
 */
export class ProviderAccountRefMismatchError extends PaymentAccountError {
  constructor() {
    super(
      "PROVIDER_ACCOUNT_REF_MISMATCH",
      "The observed provider account reference does not match the linked account",
    );
    this.name = "ProviderAccountRefMismatchError";
  }
}

/**
 * A readiness change the 0M.1 transition table forbids.
 *
 * Carries the attempted transition — both ends are members of a closed public
 * enum, so naming them discloses nothing the caller did not already supply. The
 * consequential refusal is `NOT_STARTED → ENABLED`: readiness is always the
 * provider's answer, and a path that reached ENABLED without the provider
 * deciding would let an operator mark an unverified participant payable.
 */
export class InvalidPaymentReadinessTransitionError extends PaymentAccountError {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) {
    super("INVALID_PAYMENT_READINESS_TRANSITION", "That payment readiness change is not permitted");
    this.name = "InvalidPaymentReadinessTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * A second provider for one participant, which this phase does not support.
 *
 * A phase boundary, not a domain rule — hence its own error, on the same
 * reasoning that keeps `ActivationNotPermittedInPhaseError` distinct from
 * `InvalidParticipantTransitionError`.
 *
 * The schema permits one account per `(participant, provider)` because 0M.1 §9
 * specified that key. What 0M.1 never specified is **which** answer a
 * participant's single `paymentReadiness` field takes when two providers
 * disagree. Inventing a reduction rule — most ready, least ready, most recently
 * observed — would be a commercial policy decision made inside a persistence
 * phase. So the second registration is refused here, and the rule is deferred to
 * the phase that first needs two providers.
 */
export class MultiplePaymentProvidersNotSupportedInPhaseError extends PaymentAccountError {
  constructor() {
    super(
      "MULTIPLE_PAYMENT_PROVIDERS_NOT_SUPPORTED_IN_PHASE",
      "A participant may hold one payment-provider account in this phase; the multi-provider readiness rule is not yet decided",
    );
    this.name = "MultiplePaymentProvidersNotSupportedInPhaseError";
  }
}

/**
 * Storage holds more than one payment account for one participant.
 *
 * Unreachable through the service, which refuses the second registration. Raised
 * rather than resolved because picking one of two stored answers is the
 * undecided reduction rule above: materialization must fail closed instead of
 * choosing, since the value it produces feeds `canReceivePayout`.
 */
export class AmbiguousPaymentReadinessError extends PaymentAccountError {
  constructor() {
    super(
      "AMBIGUOUS_PAYMENT_READINESS",
      "More than one payment account exists for this participant and no reduction rule is defined",
    );
    this.name = "AmbiguousPaymentReadinessError";
  }
}

/**
 * A persisted row failed its contract on the way OUT of the database.
 *
 * Distinct from an input error for the reason the participant module already
 * records: an unparseable stored row means the database holds something no code
 * path should have been able to write, and returning a best-effort object would
 * let a corrupt readiness flow into an activation approval.
 */
export class CorruptPaymentAccountRecordError extends PaymentAccountError {
  readonly fields: string[];
  constructor(fields: string[], cause?: unknown) {
    super("CORRUPT_PAYMENT_ACCOUNT_RECORD", "A stored payment account record failed validation", cause);
    this.name = "CorruptPaymentAccountRecordError";
    this.fields = fields;
  }
}

/** A durable write failed. The underlying database message is never surfaced. */
export class PaymentAccountPersistenceFailureError extends PaymentAccountError {
  readonly stage: string;
  constructor(stage: string, cause?: unknown) {
    super("PAYMENT_ACCOUNT_PERSISTENCE_FAILURE", "A payment account persistence operation failed", cause);
    this.name = "PaymentAccountPersistenceFailureError";
    this.stage = stage;
  }
}
