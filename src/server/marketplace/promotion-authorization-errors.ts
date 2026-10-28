/**
 * Promotion Authorization errors (Phase 1.41).
 *
 * The rules every marketplace error module here follows: no error carries
 * private data — not a name, an email, an internal id, or a database message —
 * and an internal cause is non-enumerable (`attachInternalCause`). A refusal of
 * the request gate carries the closed classification vocabulary of
 * `participantMayRequestPromotionAuthorization`, safe to return to a caller.
 *
 * Unknown Product and "not your Product" are the shared
 * `ProductNotAvailableError` (`product/errors`), not a code of this module, so
 * every Product route answers a guessed reference identically.
 */

import { attachInternalCause } from "../product/error-cause";
import type { PromotionAuthorizationRequestRefusal } from "../../contracts/marketplace/promotion-authorization";

export type PromotionAuthorizationErrorCode =
  | "PROMOTION_AUTHORIZATION_NOT_FOUND"
  | "PROMOTION_AUTHORIZATION_REQUEST_NOT_PERMITTED"
  | "PROMOTION_AUTHORIZATION_SELF_PROMOTION"
  | "PROMOTION_AUTHORIZATION_ALREADY_REQUESTED"
  | "PROMOTION_AUTHORIZATION_ALREADY_APPROVED"
  | "PROMOTION_AUTHORIZATION_TRANSITION_NOT_GOVERNED"
  | "PROMOTION_AUTHORIZATION_SUPERSEDED"
  | "PROMOTION_AUTHORIZATION_PROMOTER_NOT_ELIGIBLE"
  | "PROMOTION_AUTHORIZATION_CONFLICT"
  | "PROMOTION_AUTHORIZATION_CORRUPT_RECORD"
  | "PROMOTION_OFFER_ACCEPTANCE_REFUSED";

export class PromotionAuthorizationError extends Error {
  readonly code: PromotionAuthorizationErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: PromotionAuthorizationErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "PromotionAuthorizationError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/**
 * No such authorization on this Product for the acting party — an unknown
 * reference, a reference belonging to another Product, or (for a Promoter) one
 * belonging to another Promoter. One answer for all three.
 */
export class PromotionAuthorizationNotFoundError extends PromotionAuthorizationError {
  constructor() {
    super("PROMOTION_AUTHORIZATION_NOT_FOUND", "No such Promotion Authorization for the acting participant");
    this.name = "PromotionAuthorizationNotFoundError";
  }
}

/** The acting account fails the Phase 1.41 request gate. Nothing is written. */
export class PromotionAuthorizationRequestNotPermittedError extends PromotionAuthorizationError {
  readonly refusals: readonly PromotionAuthorizationRequestRefusal[];
  constructor(refusals: readonly PromotionAuthorizationRequestRefusal[]) {
    super("PROMOTION_AUTHORIZATION_REQUEST_NOT_PERMITTED", "The acting participant may not request Promotion Authorization");
    this.name = "PromotionAuthorizationRequestNotPermittedError";
    this.refusals = [...refusals];
  }
}

/** The requesting participant holds Seller authority over the Product (Contract §14). */
export class PromotionAuthorizationSelfPromotionError extends PromotionAuthorizationError {
  constructor() {
    super("PROMOTION_AUTHORIZATION_SELF_PROMOTION", "A Seller cannot request Promotion Authorization for its own Product");
    this.name = "PromotionAuthorizationSelfPromotionError";
  }
}

/** A request while the current cycle is already open. Nothing is written. */
export class PromotionAuthorizationAlreadyOpenError extends PromotionAuthorizationError {
  constructor(state: "REQUESTED" | "APPROVED") {
    super(
      state === "REQUESTED" ? "PROMOTION_AUTHORIZATION_ALREADY_REQUESTED" : "PROMOTION_AUTHORIZATION_ALREADY_APPROVED",
      state === "REQUESTED"
        ? "A Promotion Authorization request is already pending"
        : "Promotion Authorization is already approved",
    );
    this.name = "PromotionAuthorizationAlreadyOpenError";
  }
}

/** The act is not governed from the cycle's current state, or not the actor's to make. */
export class PromotionAuthorizationTransitionNotGovernedError extends PromotionAuthorizationError {
  constructor() {
    super("PROMOTION_AUTHORIZATION_TRANSITION_NOT_GOVERNED", "This Promotion Authorization change is not a governed transition");
    this.name = "PromotionAuthorizationTransitionNotGovernedError";
  }
}

/** The cycle named has been superseded by a later request cycle. Nothing is written. */
export class PromotionAuthorizationSupersededError extends PromotionAuthorizationError {
  constructor() {
    super("PROMOTION_AUTHORIZATION_SUPERSEDED", "This Promotion Authorization has been superseded by a later request");
    this.name = "PromotionAuthorizationSupersededError";
  }
}

/**
 * At approval, the Promoter no longer satisfies the request gate (Phase 1.41
 * ruling C). Fails closed: no approval is written and the open request is left
 * exactly as it was — neither denied nor cancelled.
 */
export class PromotionAuthorizationPromoterNotEligibleError extends PromotionAuthorizationError {
  constructor() {
    super("PROMOTION_AUTHORIZATION_PROMOTER_NOT_ELIGIBLE", "The Promoter does not currently qualify for approval");
    this.name = "PromotionAuthorizationPromoterNotEligibleError";
  }
}

/** A concurrent change won a uniqueness race the row lock should have prevented. */
export class PromotionAuthorizationConflictError extends PromotionAuthorizationError {
  constructor(internalCause?: unknown) {
    super("PROMOTION_AUTHORIZATION_CONFLICT", "The Promotion Authorization changed concurrently", internalCause);
    this.name = "PromotionAuthorizationConflictError";
  }
}

/** A stored value outside the governed vocabulary, or a cycle with no current act. */
export class PromotionAuthorizationCorruptRecordError extends PromotionAuthorizationError {
  constructor(message: string) {
    super("PROMOTION_AUTHORIZATION_CORRUPT_RECORD", message);
    this.name = "PromotionAuthorizationCorruptRecordError";
  }
}

// — Offer-package acceptance (Phase 1.44) —

/**
 * Why an Offer-package acceptance was refused. A closed vocabulary, safe to
 * return: each names a state of the request or of the terms, never a value.
 *
 *   - `AUTHORIZATION_NOT_APPROVED` — the current cycle is not `APPROVED`;
 *   - `PRODUCT_NOT_ACTIVE`         — the Product's lifecycle is not `ACTIVE`;
 *   - `RESALE_NOT_OFFERED`         — resale is `NOT_OFFERED` or `WITHDRAWN`
 *                                    (`PAUSED` admits acceptance);
 *   - `OFFER_NOT_ACCEPTING`        — no such current Offer for this Product, or
 *                                    it is not `ACTIVE`;
 *   - `STANDING_VERSION_STALE`     — the standing version named is not current;
 *   - `PROMOTION_CHANGED`          — the promotion named (or its absence) is not
 *                                    the current package's;
 *   - `TERMS_MISMATCH`             — the economics or window restated differ
 *                                    from the named immutable versions.
 */
export const OFFER_ACCEPTANCE_REFUSALS = [
  "AUTHORIZATION_NOT_APPROVED",
  "PRODUCT_NOT_ACTIVE",
  "RESALE_NOT_OFFERED",
  "OFFER_NOT_ACCEPTING",
  "STANDING_VERSION_STALE",
  "PROMOTION_CHANGED",
  "TERMS_MISMATCH",
] as const;
export type OfferAcceptanceRefusal = (typeof OFFER_ACCEPTANCE_REFUSALS)[number];

/** The acceptance was refused; nothing is written. */
export class PromotionOfferAcceptanceRefusedError extends PromotionAuthorizationError {
  readonly reason: OfferAcceptanceRefusal;
  constructor(reason: OfferAcceptanceRefusal) {
    super("PROMOTION_OFFER_ACCEPTANCE_REFUSED", `The Offer package cannot be accepted: ${reason}`);
    this.name = "PromotionOfferAcceptanceRefusedError";
    this.reason = reason;
  }
}
