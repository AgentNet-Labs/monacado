/**
 * Listing persistence errors (Phase 0M.7).
 *
 * Two rules, inherited from the account, participant, Storefront, and Offer
 * modules:
 *
 *   1. **No error carries private data.** Not an email address, a legal name, a
 *      profile value, a session token, a price, or a database message. `fields`
 *      names paths only; the offending value is never echoed.
 *
 *   2. **Internal causes are non-enumerable**, via the shared
 *      `attachInternalCause` helper, so `JSON.stringify(error)` cannot leak a
 *      driver message or a connection string.
 *
 * An authorization refusal carries the **bounded 0M.1 reason codes** the
 * existing capability decisions already produce — a closed classification
 * vocabulary, never free text — so a route may safely show them to a caller.
 */

import { attachInternalCause } from "../product/error-cause";
import type { CapabilityReasonCode } from "../../contracts/marketplace/capability";

export type ListingErrorCode =
  | "INVALID_LISTING_INPUT"
  | "LISTING_NOT_FOUND"
  | "LISTING_VERSION_NOT_FOUND"
  | "DUPLICATE_SOURCE_VERSION"
  | "PRODUCT_NOT_FOUND"
  | "STOREFRONT_NOT_FOUND"
  | "CONTROLLER_PARTICIPANT_NOT_FOUND"
  | "OFFER_VERSION_NOT_FOUND"
  | "OFFER_PRODUCT_MISMATCH"
  | "LISTING_NOT_AUTHORIZED"
  | "LISTING_ALREADY_EXISTS"
  | "LISTING_COMMERCIAL_TERMS_REQUIRED"
  | "LISTING_NOT_WITHDRAWABLE"
  | "NO_MATERIAL_CHANGE"
  | "LISTING_ECONOMICS_REFUSED"
  | "CORRUPT_LISTING_RECORD"
  | "LISTING_PERSISTENCE_FAILURE";

export class ListingError extends Error {
  readonly code: ListingErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: ListingErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "ListingError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/**
 * Malformed input. `fields` names paths only — never the rejected value.
 *
 * This is where 0M.4A's scheduled-sale cross-field rules land: a sale in the
 * wrong currency, priced at or above ordinary retail, or ending before it
 * starts arrives here as field paths rather than as amounts.
 */
export class InvalidListingInputError extends ListingError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_LISTING_INPUT", "Invalid Listing input");
    this.name = "InvalidListingInputError";
    this.fields = fields;
  }
}

export class ListingNotFoundError extends ListingError {
  constructor() {
    super("LISTING_NOT_FOUND", "No Listing exists for this identifier");
    this.name = "ListingNotFoundError";
  }
}

export class ListingVersionNotFoundError extends ListingError {
  constructor() {
    super("LISTING_VERSION_NOT_FOUND", "No such Listing source version exists");
    this.name = "ListingVersionNotFoundError";
  }
}

/** A version label already exists for this source record. Labels mint once. */
export class DuplicateListingSourceVersionError extends ListingError {
  constructor(cause?: unknown) {
    super("DUPLICATE_SOURCE_VERSION", "That source-record version already exists", cause);
    this.name = "DuplicateListingSourceVersionError";
  }
}

export class ListingProductNotFoundError extends ListingError {
  constructor(cause?: unknown) {
    super("PRODUCT_NOT_FOUND", "No Product exists for this identifier", cause);
    this.name = "ListingProductNotFoundError";
  }
}

export class ListingStorefrontNotFoundError extends ListingError {
  constructor(cause?: unknown) {
    super("STOREFRONT_NOT_FOUND", "No Storefront exists for this identifier", cause);
    this.name = "ListingStorefrontNotFoundError";
  }
}

export class ControllerParticipantNotFoundError extends ListingError {
  constructor(cause?: unknown) {
    super(
      "CONTROLLER_PARTICIPANT_NOT_FOUND",
      "No participant exists for this Listing controller",
      cause,
    );
    this.name = "ControllerParticipantNotFoundError";
  }
}

/**
 * The exact accepted Offer source version does not exist.
 *
 * A promoted Listing binds one identified version. Falling back to the Offer's
 * current version would silently bind terms the promoter never accepted, which
 * is the whole failure the exact binding exists to prevent.
 */
export class AcceptedOfferVersionNotFoundError extends ListingError {
  constructor(cause?: unknown) {
    super("OFFER_VERSION_NOT_FOUND", "No such Offer source version exists", cause);
    this.name = "AcceptedOfferVersionNotFoundError";
  }
}

/** The accepted Offer is for a different Product than the Listing places. */
export class OfferProductMismatchError extends ListingError {
  constructor() {
    super("OFFER_PRODUCT_MISMATCH", "The accepted Offer is for a different Product");
    this.name = "OfferProductMismatchError";
  }
}

/**
 * An existing capability decision returned DENY.
 *
 * `reasonCodes` are the closed 0M.1 vocabulary — safe to surface, and never a
 * free-text explanation or a private value.
 */
export class ListingNotAuthorizedError extends ListingError {
  readonly capability: string;
  readonly reasonCodes: CapabilityReasonCode[];
  constructor(capability: string, reasonCodes: CapabilityReasonCode[]) {
    super("LISTING_NOT_AUTHORIZED", "That Listing operation is not permitted");
    this.name = "ListingNotAuthorizedError";
    this.capability = capability;
    this.reasonCodes = reasonCodes;
  }
}

/**
 * A current Listing already places this Product in this Storefront (Phase 1.34).
 *
 * `MARKETPLACE_ASSORTMENT_AND_LISTING_RULES.md` §5: at most one current Listing
 * aggregate exists per Product + Storefront pair. Immutable historical source
 * versions are not duplicates, and neither is a placement a terminal lifecycle
 * state has released.
 *
 * **Raised from two places, and both are load-bearing.** The service asks
 * inside the write transaction so an ordinary caller gets this bounded semantic
 * answer; the composite unique index catches the racing second caller that
 * passed that check before the first committed. The index's own P2002 is
 * translated back into this error rather than escaping as a generic persistence
 * failure — the concurrent caller asked a legitimate question and deserves the
 * same answer as the sequential one.
 *
 * Carries no identifier. Which Listing already holds the pair, and who controls
 * it, are not facts a refused caller is owed.
 */
export class ListingAlreadyExistsError extends ListingError {
  constructor(cause?: unknown) {
    super(
      "LISTING_ALREADY_EXISTS",
      "A current Listing already places this Product in this Storefront",
      cause,
    );
    this.name = "ListingAlreadyExistsError";
  }
}

/**
 * This placement is not in a state self-service withdrawal governs
 * (Phase 1.35).
 *
 * Phase 1.35 exposes exactly one transition: a `SELLER_DIRECT` placement in
 * `DRAFT` becomes `WITHDRAWN`. Everything else is refused here and stays
 * refused:
 *
 *   - **`ACTIVE` and `SUSPENDED`** were in front of buyers. Taking a live
 *     placement down is a commercial act with consequences this phase has not
 *     modelled, and it belongs with the activation work that put it there.
 *   - **`ENDED` and `WITHDRAWN`** are terminal. 0M.4A's transition table gives
 *     them no exit, so a second withdrawal is not a no-op to absorb quietly —
 *     it is a caller believing something about state that is not true, and it
 *     must mint no version.
 *   - **`PROMOTED`** placements are not self-service at all, in either
 *     direction, until anti-self-promotion and governed economic-principal
 *     resolution exist.
 *
 * `state` is the bounded reason, never free text and never the lifecycle of a
 * placement the caller does not control — the route establishes control before
 * this can be raised.
 */
export class ListingNotWithdrawableError extends ListingError {
  readonly state: string;
  constructor(state: string) {
    super("LISTING_NOT_WITHDRAWABLE", "That placement cannot be withdrawn");
    this.name = "ListingNotWithdrawableError";
    this.state = state;
  }
}

/**
 * A commercial transition was attempted on a placement carrying no price
 * (Phase 1.34).
 *
 * A private DRAFT Listing may exist without commercial terms — placement is not
 * pricing. **Going live is where that stops being true.** `DRAFT -> ACTIVE` puts
 * an item in front of buyers, and an item in front of buyers at no stated price
 * is not a draft with a gap in it; it is an unanswerable commercial offer.
 *
 * This is the narrow guard, not the governed commercial-readiness gate. The full
 * gate — required Offer terms, promoted economics, the active-Listing
 * allowance — belongs to the activation phase, and nothing here anticipates it.
 */
export class ListingCommercialTermsRequiredError extends ListingError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super(
      "LISTING_COMMERCIAL_TERMS_REQUIRED",
      "That Listing cannot become commercially active without its commercial terms",
    );
    this.name = "ListingCommercialTermsRequiredError";
    this.fields = fields;
  }
}

/**
 * An update that changes nothing material.
 *
 * Refused rather than silently minting a version that asserts nothing.
 */
export class NoMaterialListingChangeError extends ListingError {
  constructor() {
    super("NO_MATERIAL_CHANGE", "The update changes no material Listing fact");
    this.name = "NoMaterialListingChangeError";
  }
}

/**
 * 0M.4A's economics refused these commercial terms.
 *
 * Carries the contract's own bounded `code` — `NEGATIVE_PROMOTER_PROCEEDS`,
 * `NEGATIVE_ACQUISITION_AMOUNT`, `WHOLESALE_CURRENCY_MISMATCH`, and the rest —
 * rather than a recomputed explanation or any amount.
 */
export class ListingEconomicsRefusedError extends ListingError {
  readonly economicsCode: string;
  constructor(economicsCode: string) {
    super("LISTING_ECONOMICS_REFUSED", "The Listing economics are not viable");
    this.name = "ListingEconomicsRefusedError";
    this.economicsCode = economicsCode;
  }
}

/**
 * A persisted row failed its contract on the way OUT of the database.
 *
 * Raised rather than returned: an unparseable stored row means the database
 * holds something no code path should have been able to write, and returning a
 * best-effort object would let corrupt authoritative state reach a projection.
 *
 * This is the surface for a corrupt discriminator, a half-populated sale arm,
 * and a promoted row whose Offer-version reference is incomplete.
 */
export class CorruptListingRecordError extends ListingError {
  readonly fields: string[];
  constructor(fields: string[], cause?: unknown) {
    super("CORRUPT_LISTING_RECORD", "A stored Listing record failed validation", cause);
    this.name = "CorruptListingRecordError";
    this.fields = fields;
  }
}

/** A durable write failed. The underlying database message is never surfaced. */
export class ListingPersistenceFailureError extends ListingError {
  readonly stage: string;
  constructor(stage: string, cause?: unknown) {
    super("LISTING_PERSISTENCE_FAILURE", "A Listing persistence operation failed", cause);
    this.name = "ListingPersistenceFailureError";
    this.stage = stage;
  }
}
