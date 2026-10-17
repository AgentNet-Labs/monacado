/**
 * Structured Product repository errors (Phase 0D).
 *
 * Every error carries a stable code and may preserve an internal `cause`.
 * Messages and codes are safe to surface; the `cause` is for internal
 * diagnostics only. NOTHING here includes DATABASE_URL, credentials, hosts with
 * credentials, or raw Prisma connection details — construct messages from safe
 * text only.
 *
 * The internal cause is retained but NON-ENUMERABLE (see ./error-cause), so it
 * cannot escape through `JSON.stringify`, object spread, or `Object.keys`.
 */

import type { ProductActivationBlocker } from "../../contracts/product/product-lifecycle";
import { attachInternalCause } from "./error-cause";

export type ProductRepositoryErrorCode =
  | "VALIDATION_FAILED"
  | "NOT_FOUND"
  | "DUPLICATE_PRODUCT"
  | "DUPLICATE_VERSION"
  | "IMMUTABLE_IDENTITY"
  | "CONCURRENCY_CONFLICT"
  | "PERSISTED_CONTRACT_VIOLATION"
  | "CREATOR_PARTICIPANT_REQUIRED"
  | "CREATOR_NOT_ELIGIBLE"
  | "PRODUCT_NOT_AVAILABLE"
  | "REVISION_UNCHANGED"
  | "PRODUCT_ALREADY_ACTIVE"
  | "PRODUCT_SUSPENDED"
  | "ACTIVATION_NOT_READY"
  | "SUSPENSION_NOT_AUTHORIZED"
  | "SUSPENSION_SELF_ACTION"
  | "ALREADY_SUSPENDED"
  | "SUSPENSION_NOT_FOUND"
  | "SUSPENSION_ALREADY_LIFTED"
  | "TAX_CLASSIFICATION_NOT_AUTHORIZED"
  | "TAX_CLASSIFICATION_SELF_ACTION"
  | "TAX_CLASSIFICATION_CONTRADICTS_DELIVERY"
  | "TAX_CLASSIFICATION_UNCHANGED"
  | "RESALE_AVAILABILITY_REQUIRES_ACTIVE_PRODUCT"
  | "RESALE_AVAILABILITY_TRANSITION_NOT_GOVERNED"
  | "DATABASE_ERROR";

export class ProductRepositoryError extends Error {
  readonly code: ProductRepositoryErrorCode;
  /**
   * Optional internal cause, retained for diagnostics but defined
   * NON-ENUMERABLE by `attachInternalCause` — invisible to `JSON.stringify`,
   * object spread, and `Object.keys`. Declared (not initialised) here so the
   * class field never re-creates it as an enumerable property.
   */
  declare readonly internalCause?: unknown;

  constructor(code: ProductRepositoryErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "ProductRepositoryError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

export class ValidationError extends ProductRepositoryError {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super("VALIDATION_FAILED", message);
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export class NotFoundError extends ProductRepositoryError {
  constructor(message: string) {
    super("NOT_FOUND", message);
    this.name = "NotFoundError";
  }
}

export class DuplicateProductError extends ProductRepositoryError {
  constructor(message: string, cause?: unknown) {
    super("DUPLICATE_PRODUCT", message, cause);
    this.name = "DuplicateProductError";
  }
}

export class DuplicateVersionError extends ProductRepositoryError {
  constructor(message: string, cause?: unknown) {
    super("DUPLICATE_VERSION", message, cause);
    this.name = "DuplicateVersionError";
  }
}

export class ImmutableIdentityError extends ProductRepositoryError {
  constructor(message: string) {
    super("IMMUTABLE_IDENTITY", message);
    this.name = "ImmutableIdentityError";
  }
}

export class ConcurrencyConflictError extends ProductRepositoryError {
  constructor(message: string) {
    super("CONCURRENCY_CONFLICT", message);
    this.name = "ConcurrencyConflictError";
  }
}

export class PersistedContractViolationError extends ProductRepositoryError {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super("PERSISTED_CONTRACT_VIOLATION", message, issues);
    this.name = "PersistedContractViolationError";
    this.issues = issues;
  }
}

export class DatabaseError extends ProductRepositoryError {
  constructor(message: string, cause?: unknown) {
    super("DATABASE_ERROR", message, cause);
    this.name = "DatabaseError";
  }
}

/**
 * The acting account holds no marketplace participant (Phase 1.18).
 *
 * Raised by the authenticated Product-creation command, which records the
 * acting participant as the creator authority. This is not an authorization
 * refusal wearing a different name: the account is not a marketplace
 * participant at all, so there is no identity for creator authority to name.
 *
 * Carries no account id, no email, and no participant reference — there is
 * nothing here for a caller to learn about anyone.
 */
/**
 * The acting participant may not draft a Product (Phase 1.32).
 *
 * `canCreateDraftProduct` denied: no SELLER role in a drafting status, a
 * participant status that does not permit drafting, or a disabled account. A
 * PROMOTER curates other creators' Products and never authors their facts, so a
 * promoter-only participant lands here too. Carries no reason code and no
 * identifier — the participant knows which roles they hold.
 */
export class ProductCreatorNotEligibleError extends ProductRepositoryError {
  constructor() {
    super("CREATOR_NOT_ELIGIBLE", "The acting participant may not draft a Product");
    this.name = "ProductCreatorNotEligibleError";
  }
}

export class ProductCreatorParticipantRequiredError extends ProductRepositoryError {
  constructor() {
    super(
      "CREATOR_PARTICIPANT_REQUIRED",
      "The acting account holds no marketplace participant",
    );
    this.name = "ProductCreatorParticipantRequiredError";
  }
}

/**
 * No Product the acting participant may revise answers to this reference
 * (Phase 1.38).
 *
 * Deliberately ONE error for "no such Product" and "a real Product someone else
 * authors": anything finer would let a caller holding a guessed reference learn
 * that it exists. Carries no reference, no identifier, and no reason.
 */
export class ProductNotAvailableError extends ProductRepositoryError {
  constructor() {
    super("PRODUCT_NOT_AVAILABLE", "No Product the acting participant may revise");
    this.name = "ProductNotAvailableError";
  }
}

/**
 * A revision restated exactly what the current version already says
 * (Phase 1.38).
 *
 * Refused rather than written: a version that changes nothing is history that
 * records no event. Raised only after authority is established, so it reveals
 * nothing about a Product the caller does not author.
 */
export class ProductRevisionUnchangedError extends ProductRepositoryError {
  constructor() {
    super("REVISION_UNCHANGED", "The revision changes nothing in the current version");
    this.name = "ProductRevisionUnchangedError";
  }
}

/**
 * The Product is already `ACTIVE` (Phase 1.39). Activation is an explicit act
 * that creates authority; repeating it would record a second act for nothing.
 */
export class ProductAlreadyActiveError extends ProductRepositoryError {
  constructor() {
    super("PRODUCT_ALREADY_ACTIVE", "The Product is already active");
    this.name = "ProductAlreadyActiveError";
  }
}

/**
 * A Monacado Product suspension stands (Phase 1.39). Only Monacado's governed
 * reinstatement ends it; Seller activation cannot.
 */
export class ProductSuspendedError extends ProductRepositoryError {
  constructor() {
    super("PRODUCT_SUSPENDED", "The Product is suspended");
    this.name = "ProductSuspendedError";
  }
}

/**
 * One or more activation-readiness gates fail now (Phase 1.39). Carries the
 * closed blocker classifications, in the evaluator's order — safe to show the
 * Seller they describe, and nothing more.
 */
export class ProductActivationNotReadyError extends ProductRepositoryError {
  readonly blockers: readonly ProductActivationBlocker[];
  constructor(blockers: readonly ProductActivationBlocker[]) {
    super("ACTIVATION_NOT_READY", "The Product cannot be activated now");
    this.name = "ProductActivationNotReadyError";
    this.blockers = [...blockers];
  }
}

/** The acting internal account holds no `product:suspend` grant (Phase 1.39). */
export class ProductSuspensionNotAuthorizedError extends ProductRepositoryError {
  constructor() {
    super("SUSPENSION_NOT_AUTHORIZED", "Not authorized to suspend or reinstate Products");
    this.name = "ProductSuspensionNotAuthorizedError";
  }
}

/** An internal account may not suspend or reinstate a Product it authors. */
export class ProductSuspensionSelfActionNotPermittedError extends ProductRepositoryError {
  constructor() {
    super("SUSPENSION_SELF_ACTION", "A Product's own author may not suspend or reinstate it");
    this.name = "ProductSuspensionSelfActionNotPermittedError";
  }
}

/** A suspension already stands on this Product. */
export class ProductAlreadySuspendedError extends ProductRepositoryError {
  constructor() {
    super("ALREADY_SUSPENDED", "The Product is already suspended");
    this.name = "ProductAlreadySuspendedError";
  }
}

export class ProductSuspensionNotFoundError extends ProductRepositoryError {
  constructor() {
    super("SUSPENSION_NOT_FOUND", "No such Product suspension");
    this.name = "ProductSuspensionNotFoundError";
  }
}

/** The suspension was already lifted — by this request racing another, or before. */
export class ProductSuspensionAlreadyLiftedError extends ProductRepositoryError {
  constructor() {
    super("SUSPENSION_ALREADY_LIFTED", "The Product suspension is already lifted");
    this.name = "ProductSuspensionAlreadyLiftedError";
  }
}

/** The acting account holds no active `product:tax-classify` grant. */
export class ProductTaxClassificationNotAuthorizedError extends ProductRepositoryError {
  constructor() {
    super("TAX_CLASSIFICATION_NOT_AUTHORIZED", "Not authorized to classify a Product for tax");
    this.name = "ProductTaxClassificationNotAuthorizedError";
  }
}

/** The acting account's own participant authors this Product. */
export class ProductTaxClassificationSelfActionNotPermittedError extends ProductRepositoryError {
  constructor() {
    super("TAX_CLASSIFICATION_SELF_ACTION", "A Product's own author may not classify it for tax");
    this.name = "ProductTaxClassificationSelfActionNotPermittedError";
  }
}

/** `PHYSICAL_GOOD` on a Product delivered `DIGITAL` — the one contradiction refused. */
export class ProductTaxClassificationContradictsDeliveryError extends ProductRepositoryError {
  constructor() {
    super(
      "TAX_CLASSIFICATION_CONTRADICTS_DELIVERY",
      "The tax classification contradicts the Product's delivery mode",
    );
    this.name = "ProductTaxClassificationContradictsDeliveryError";
  }
}

/** The Product already carries exactly this classification; nothing is written. */
export class ProductTaxClassificationUnchangedError extends ProductRepositoryError {
  constructor() {
    super("TAX_CLASSIFICATION_UNCHANGED", "The Product already has this tax classification");
    this.name = "ProductTaxClassificationUnchangedError";
  }
}

/**
 * `AVAILABLE` was requested while the Product's effective lifecycle is not
 * `ACTIVE` (Phase 1.40, Contract §9.3). Nothing is written; a preserved
 * `AVAILABLE` is never affected by this refusal.
 */
export class ProductResaleAvailabilityRequiresActiveError extends ProductRepositoryError {
  constructor() {
    super(
      "RESALE_AVAILABILITY_REQUIRES_ACTIVE_PRODUCT",
      "Resale availability can be set to AVAILABLE only while the Product is active",
    );
    this.name = "ProductResaleAvailabilityRequiresActiveError";
  }
}

/**
 * The requested resale-availability transition is not one governing policy
 * defines (Phase 1.40) — e.g. anything out of `WITHDRAWN`. Nothing is written.
 */
export class ProductResaleAvailabilityTransitionNotGovernedError extends ProductRepositoryError {
  constructor() {
    super(
      "RESALE_AVAILABILITY_TRANSITION_NOT_GOVERNED",
      "This resale-availability change is not a governed transition",
    );
    this.name = "ProductResaleAvailabilityTransitionNotGovernedError";
  }
}
