/**
 * Storefront persistence errors (Phase 0M.3C).
 *
 * Two rules, inherited from the account, participant, and publication modules:
 *
 *   1. **No error carries private data.** Not an email address, a legal name, a
 *      profile value, a session token, or a database message. `fields` names
 *      paths only; the offending value is never echoed.
 *
 *   2. **Internal causes are non-enumerable**, via the shared
 *      `attachInternalCause` helper, so `JSON.stringify(error)` cannot leak a
 *      driver message or a connection string.
 *
 * An authorization refusal carries the **bounded reason codes the 0M.3A
 * authority decisions already produce** — a closed classification vocabulary,
 * never free text and never private profile data — so a route may safely show
 * them to a caller.
 */

import { attachInternalCause } from "../product/error-cause";
import type { StorefrontReasonCode } from "../../contracts/marketplace/storefront-source";

export type StorefrontErrorCode =
  | "INVALID_STOREFRONT_INPUT"
  | "STOREFRONT_NOT_FOUND"
  | "STOREFRONT_VERSION_NOT_FOUND"
  | "DUPLICATE_PUBLIC_HANDLE"
  | "DUPLICATE_SOURCE_VERSION"
  | "OWNER_PARTICIPANT_NOT_FOUND"
  | "GOVERNANCE_PARTICIPANT_NOT_FOUND"
  | "STOREFRONT_NOT_AUTHORIZED"
  | "OWNER_ACCOUNT_EMAIL_UNVERIFIED"
  | "NO_MATERIAL_CHANGE"
  | "SUPER_OWNER_ALREADY_ACTIVE"
  | "GOVERNANCE_ASSIGNMENT_NOT_FOUND"
  | "CORRUPT_STOREFRONT_RECORD"
  | "STOREFRONT_PERSISTENCE_FAILURE";

export class StorefrontError extends Error {
  readonly code: StorefrontErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: StorefrontErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "StorefrontError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/** Malformed input. `fields` names paths only — never the rejected value. */
export class InvalidStorefrontInputError extends StorefrontError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_STOREFRONT_INPUT", "Invalid Storefront input");
    this.name = "InvalidStorefrontInputError";
    this.fields = fields;
  }
}

export class StorefrontNotFoundError extends StorefrontError {
  constructor() {
    super("STOREFRONT_NOT_FOUND", "No Storefront exists for this identifier");
    this.name = "StorefrontNotFoundError";
  }
}

export class StorefrontVersionNotFoundError extends StorefrontError {
  constructor() {
    super("STOREFRONT_VERSION_NOT_FOUND", "No such Storefront source version exists");
    this.name = "StorefrontVersionNotFoundError";
  }
}

/**
 * The public handle is taken.
 *
 * Enforced by the unique index on the stable record, not by a read-then-write
 * check, so two concurrent creations cannot both succeed.
 */
export class DuplicatePublicHandleError extends StorefrontError {
  constructor(cause?: unknown) {
    super("DUPLICATE_PUBLIC_HANDLE", "That public handle is already in use", cause);
    this.name = "DuplicatePublicHandleError";
  }
}

/** A version label already exists for this source record. Labels mint once. */
export class DuplicateSourceVersionError extends StorefrontError {
  constructor(cause?: unknown) {
    super("DUPLICATE_SOURCE_VERSION", "That source-record version already exists", cause);
    this.name = "DuplicateSourceVersionError";
  }
}

export class OwnerParticipantNotFoundError extends StorefrontError {
  constructor(cause?: unknown) {
    super("OWNER_PARTICIPANT_NOT_FOUND", "No participant exists for this owner", cause);
    this.name = "OwnerParticipantNotFoundError";
  }
}

export class GovernanceParticipantNotFoundError extends StorefrontError {
  constructor(cause?: unknown) {
    super(
      "GOVERNANCE_PARTICIPANT_NOT_FOUND",
      "No participant exists for this governance assignment",
      cause,
    );
    this.name = "GovernanceParticipantNotFoundError";
  }
}

/**
 * An 0M.3A authority decision returned DENY.
 *
 * `reasonCodes` are that contract's own bounded classifications — safe to
 * surface, and never a free-text explanation or a private value.
 */
export class StorefrontNotAuthorizedError extends StorefrontError {
  readonly capability: string;
  /**
   * Typed to the closed 0M.3A vocabulary, not `string[]`.
   *
   * A looser type let an early draft of the service invent two codes that no
   * contract defines — which is precisely what a bounded classification exists
   * to prevent, and exactly the kind of thing a compiler should catch.
   */
  readonly reasonCodes: StorefrontReasonCode[];
  constructor(capability: string, reasonCodes: StorefrontReasonCode[]) {
    super("STOREFRONT_NOT_AUTHORIZED", "That Storefront operation is not permitted");
    this.name = "StorefrontNotAuthorizedError";
    this.capability = capability;
    this.reasonCodes = reasonCodes;
  }
}

/**
 * The owning account's email address has never been proved.
 *
 * Raised only on the two INCREASING branches of a Storefront source version —
 * going live, and widening exposure toward the public. Never on standing one
 * down, for the reason the standing seams already give: an owner who cannot
 * currently go live must still be able to close or hide their shop.
 *
 * A member of the existing bounded vocabulary rather than a new error family,
 * and deliberately NOT a `StorefrontNotAuthorizedError`: that error means an
 * 0M.3A *authority* decision denied the actor, and this one means the owner's
 * contact address is unproved. Collapsing them would tell a SUPER_OWNER their
 * governance role was insufficient when their role is fine and their inbox is
 * the problem — an unactionable message, and a wrong one.
 *
 * It carries no address, no account id, and no participant id. The owner knows
 * which address they registered; a caller who is not the owner learns nothing.
 */
export class OwnerAccountEmailUnverifiedError extends StorefrontError {
  constructor() {
    super(
      "OWNER_ACCOUNT_EMAIL_UNVERIFIED",
      "The owning account's email address has not been confirmed",
    );
    this.name = "OwnerAccountEmailUnverifiedError";
  }
}

/**
 * An update that changes nothing material.
 *
 * Refused rather than silently minting a version: 0M.3A is explicit that a
 * version asserting no change is history noise, and returning success would let
 * a caller believe a change landed.
 */
export class NoMaterialChangeError extends StorefrontError {
  constructor() {
    super("NO_MATERIAL_CHANGE", "The update changes no material Storefront fact");
    this.name = "NoMaterialChangeError";
  }
}

/**
 * A second active SUPER_OWNER was attempted.
 *
 * The database refuses it through a unique index; this is the named surface for
 * that refusal. 0M.3A permits at most one active SUPER_OWNER per Storefront.
 */
export class SuperOwnerAlreadyActiveError extends StorefrontError {
  constructor(cause?: unknown) {
    super(
      "SUPER_OWNER_ALREADY_ACTIVE",
      "This Storefront already has an active SUPER_OWNER",
      cause,
    );
    this.name = "SuperOwnerAlreadyActiveError";
  }
}

export class GovernanceAssignmentNotFoundError extends StorefrontError {
  constructor() {
    super("GOVERNANCE_ASSIGNMENT_NOT_FOUND", "No governance assignment exists");
    this.name = "GovernanceAssignmentNotFoundError";
  }
}

/**
 * A persisted row failed its contract on the way OUT of the database.
 *
 * Raised rather than returned, and deliberately distinct from an input error: an
 * unparseable stored row means the database holds something no code path should
 * have been able to write, and returning a best-effort object would let corrupt
 * authoritative state flow into a capsule projection.
 */
export class CorruptStorefrontRecordError extends StorefrontError {
  readonly fields: string[];
  constructor(fields: string[], cause?: unknown) {
    super("CORRUPT_STOREFRONT_RECORD", "A stored Storefront record failed validation", cause);
    this.name = "CorruptStorefrontRecordError";
    this.fields = fields;
  }
}

/** A durable write failed. The underlying database message is never surfaced. */
export class StorefrontPersistenceFailureError extends StorefrontError {
  readonly stage: string;
  constructor(stage: string, cause?: unknown) {
    super("STOREFRONT_PERSISTENCE_FAILURE", "A Storefront persistence operation failed", cause);
    this.name = "StorefrontPersistenceFailureError";
    this.stage = stage;
  }
}
