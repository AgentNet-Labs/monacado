/**
 * Offer persistence errors (Phase 0M.6).
 *
 * Two rules, inherited from the account, participant, Storefront, and
 * publication modules:
 *
 *   1. **No error carries private data.** Not an email address, a legal name, a
 *      profile value, a session token, a price, or a database message. `fields`
 *      names paths only; the offending value is never echoed.
 *
 *   2. **Internal causes are non-enumerable**, via the shared
 *      `attachInternalCause` helper, so `JSON.stringify(error)` cannot leak a
 *      driver message or a connection string.
 *
 * An authorization refusal carries the **bounded reason codes the 0M.2A
 * authority decisions already produce** — a closed classification vocabulary,
 * never free text and never a private value — so a route may safely show them.
 */

import { attachInternalCause } from "../product/error-cause";
import type { OfferReasonCode } from "../../contracts/marketplace/offer-source";

export type OfferErrorCode =
  | "INVALID_OFFER_INPUT"
  | "OFFER_NOT_FOUND"
  | "OFFER_VERSION_NOT_FOUND"
  | "DUPLICATE_SOURCE_VERSION"
  | "PRODUCT_NOT_FOUND"
  | "SELLER_PARTICIPANT_NOT_FOUND"
  | "OFFER_NOT_AUTHORIZED"
  | "NO_MATERIAL_CHANGE"
  | "CORRUPT_OFFER_RECORD"
  | "OFFER_PERSISTENCE_FAILURE";

export class OfferError extends Error {
  readonly code: OfferErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: OfferErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "OfferError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/**
 * Malformed input. `fields` names paths only — never the rejected value.
 *
 * This is also where an economically invalid Offer lands: `OfferCommercialTerms`
 * refuses a promotable FREE Offer, a cross-currency fixed commission, and a
 * fixed commission exceeding the wholesale price, and those refusals arrive here
 * as field paths rather than as amounts.
 */
export class InvalidOfferInputError extends OfferError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_OFFER_INPUT", "Invalid Offer input");
    this.name = "InvalidOfferInputError";
    this.fields = fields;
  }
}

export class OfferNotFoundError extends OfferError {
  constructor() {
    super("OFFER_NOT_FOUND", "No Offer exists for this identifier");
    this.name = "OfferNotFoundError";
  }
}

export class OfferVersionNotFoundError extends OfferError {
  constructor() {
    super("OFFER_VERSION_NOT_FOUND", "No such Offer source version exists");
    this.name = "OfferVersionNotFoundError";
  }
}

/** A version label already exists for this source record. Labels mint once. */
export class DuplicateOfferSourceVersionError extends OfferError {
  constructor(cause?: unknown) {
    super("DUPLICATE_SOURCE_VERSION", "That source-record version already exists", cause);
    this.name = "DuplicateOfferSourceVersionError";
  }
}

/** The referenced Product does not exist. An Offer cannot name a Product that isn't there. */
export class OfferProductNotFoundError extends OfferError {
  constructor(cause?: unknown) {
    super("PRODUCT_NOT_FOUND", "No Product exists for this identifier", cause);
    this.name = "OfferProductNotFoundError";
  }
}

export class SellerParticipantNotFoundError extends OfferError {
  constructor(cause?: unknown) {
    super("SELLER_PARTICIPANT_NOT_FOUND", "No participant exists for this seller", cause);
    this.name = "SellerParticipantNotFoundError";
  }
}

/**
 * An 0M.2A authority decision returned DENY.
 *
 * `reasonCodes` are that contract's own bounded classifications — safe to
 * surface, and never a free-text explanation or a private value. Typed to the
 * closed vocabulary rather than `string[]`, so the compiler refuses a code no
 * contract defines.
 */
export class OfferNotAuthorizedError extends OfferError {
  readonly capability: string;
  readonly reasonCodes: OfferReasonCode[];
  constructor(capability: string, reasonCodes: OfferReasonCode[]) {
    super("OFFER_NOT_AUTHORIZED", "That Offer operation is not permitted");
    this.name = "OfferNotAuthorizedError";
    this.capability = capability;
    this.reasonCodes = reasonCodes;
  }
}

/**
 * An update that changes nothing material.
 *
 * Refused rather than silently minting a version: 0M.2A is explicit that a
 * version asserting no change is history noise, and returning success would let
 * a caller believe a change landed.
 */
export class NoMaterialOfferChangeError extends OfferError {
  constructor() {
    super("NO_MATERIAL_CHANGE", "The update changes no material Offer fact");
    this.name = "NoMaterialOfferChangeError";
  }
}

/**
 * A persisted row failed its contract on the way OUT of the database.
 *
 * Raised rather than returned, and deliberately distinct from an input error: an
 * unparseable stored row means the database holds something no code path should
 * have been able to write, and returning a best-effort object would let corrupt
 * authoritative state flow into a capsule projection.
 *
 * This is also the surface for **drifted economics**. The source contract
 * re-checks stored commission and gross proceeds against the deterministic
 * calculator, so a row whose amounts no longer match its terms fails here rather
 * than projecting a number the creator never accepted.
 */
export class CorruptOfferRecordError extends OfferError {
  readonly fields: string[];
  constructor(fields: string[], cause?: unknown) {
    super("CORRUPT_OFFER_RECORD", "A stored Offer record failed validation", cause);
    this.name = "CorruptOfferRecordError";
    this.fields = fields;
  }
}

/** A durable write failed. The underlying database message is never surfaced. */
export class OfferPersistenceFailureError extends OfferError {
  readonly stage: string;
  constructor(stage: string, cause?: unknown) {
    super("OFFER_PERSISTENCE_FAILURE", "An Offer persistence operation failed", cause);
    this.name = "OfferPersistenceFailureError";
    this.stage = stage;
  }
}
