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
