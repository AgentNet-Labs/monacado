/**
 * Marketplace capability decisions (Phase 0M.1).
 *
 * Twelve pure functions answering "may this subject do this one thing", plus the
 * review-capsule authority evaluator they delegate to.
 *
 * Five properties shape everything below:
 *
 *   1. **Decisions are bounded, never booleans.** `ALLOW`/`DENY` with a closed set
 *      of reason codes. A stub returning `undefined` cannot be mistaken for
 *      consent by a truthiness check, and a denial always says why in a vocabulary
 *      a route may safely show a caller.
 *
 *   2. **Reason codes are safe by construction.** They are classifications, never
 *      private profile data, provider messages, evidence, identifiers, or free
 *      text. Nothing here can put a legal name or an email into an HTTP response.
 *
 *   3. **Nothing is inferred across axes.** Marketplace activation and payment
 *      readiness are checked separately and are both required for money. Being
 *      logged in is not being a participant; holding a role is not holding an
 *      active one.
 *
 *   4. **Internal entitlement and marketplace role never meet.** Every function
 *      here ignores `subject.internalCapabilities`, and the two mapping functions
 *      at the end of this module state the separation in both directions.
 *
 *   5. **No I/O of any kind.** No database, clock, environment read, randomness,
 *      or network call. Every fact a decision needs is in its argument.
 *
 * Pure. Not exported through the browser-facing contracts barrel.
 */

import { z } from "zod";
import { AccountCapability } from "../account/account";
import {
  DRAFTING_ROLE_STATUSES,
  MarketplaceRole,
  MarketplaceSubject,
  findRoleAssignment,
  isActivatableRole,
  permitsDrafting,
} from "./participant";
import {
  ACTIONS_PERMITTED_WHEN_INVALIDATED,
  AUTHORIZED_ACTIONS_BY_SUBMISSION_STATE,
  CapsuleAuthorityTarget,
  PurchaseProvenanceStatus,
  ReviewCapsuleAction,
  ReviewCapsuleKind,
  ReviewSubmissionAuthorityView,
} from "./review-authority";

// — Capability vocabulary —

/**
 * The closed set of marketplace capabilities this phase decides.
 *
 * Named strings in a closed enum rather than free-form permissions: general RBAC
 * remains out of scope, and an unrecognised capability must be a validation
 * failure rather than something an attacker can invent.
 */
export const MARKETPLACE_CAPABILITIES = [
  "storefront:draft:create",
  "product:draft:create",
  "listing:seller_direct:create",
  "listing:promoted:create",
  "activation:submit",
  "storefront:activate",
  "offer:publish",
  "payout:receive",
  "commission:accrue",
  "review:product:submit",
  "review:seller:submit",
  "review:product:capsule:publish",
  "review:seller:capsule:publish",
] as const;
export const MarketplaceCapability = z.enum(MARKETPLACE_CAPABILITIES);
export type MarketplaceCapability = z.infer<typeof MarketplaceCapability>;

// — Reason codes —

/**
 * The closed denial vocabulary.
 *
 * Every member is a classification of *why the rule did not pass*. None carries a
 * value: no name, address, email, provider requirement string, evidence
 * reference, or identifier appears in a reason code, so a denial is safe to
 * return from a future route without a filtering step someone can forget.
 */
export const CAPABILITY_REASON_CODES = [
  /** No authenticated account (a guest) where one is required. */
  "ACCOUNT_REQUIRED",
  /** The account exists but is DISABLED at the identity level. */
  "ACCOUNT_DISABLED",
  /** Authenticated, but holds no marketplace participant record. */
  "PARTICIPANT_REQUIRED",
  /** The participant's admission status does not permit this. */
  "PARTICIPANT_STATUS_NOT_ELIGIBLE",
  /** The participant has not been admitted to the marketplace (not ACTIVE). */
  "PARTICIPANT_NOT_ACTIVATED",
  /** The required role has never been claimed. */
  "ROLE_NOT_HELD",
  /** The role is held but not usable in its current status. */
  "ROLE_NOT_ACTIVE",
  /** Required private profile fields are outstanding. */
  "PROFILE_NOT_COMPLETE",
  /** An activation is already under review. */
  "ACTIVATION_ALREADY_SUBMITTED",
  /** The participant is already admitted; there is nothing to submit. */
  "ACTIVATION_ALREADY_COMPLETE",
  /** No role that can be activated is held. */
  "NO_ACTIVATABLE_ROLE",
  /** Payment readiness is not ENABLED. */
  "PAYMENT_NOT_ENABLED",
  /** The provider has withheld capability on a previously enabled account. */
  "PAYMENT_RESTRICTED",
  /** A guest may not perform this capability at all. */
  "GUEST_NOT_PERMITTED",
  /**
   * The subject holds no creator authority over the referenced Product.
   *
   * Shared rather than entity-specific (Phase 1.18): an Offer states commercial
   * terms for a Product and a seller-direct Listing places one in front of
   * buyers, so both must ask the same question, and two spellings of one
   * refusal would be two things to keep in step.
   */
  "PRODUCT_AUTHORITY_REQUIRED",
  /**
   * The subject holds no authority over the destination Storefront.
   *
   * Placement authority (Phase 1.18): a Listing may be placed only in a
   * Storefront the controlling participant owns, or governs under an ACTIVE
   * assignment. Knowing a Storefront's opaque id is not authority over it.
   */
  "STOREFRONT_AUTHORITY_REQUIRED",
  /** Monacado cannot establish that the submitter transacted. */
  "PURCHASE_PROVENANCE_UNVERIFIED",
  /** No stored review-submission authority backs this action. */
  "REVIEW_AUTHORITY_REQUIRED",
  /** The authority exists but Monacado has invalidated it. */
  "REVIEW_AUTHORITY_INVALIDATED",
  /** The authority covers the other review kind. */
  "REVIEW_AUTHORITY_KIND_MISMATCH",
  /** The authority covers a different review than the one targeted. */
  "REVIEW_AUTHORITY_TARGET_MISMATCH",
  /** The target is not a review capsule at all. */
  "REVIEW_AUTHORITY_SCOPE_EXCEEDED",
  /** The submission's current state does not authorize this capsule action. */
  "ACTION_NOT_AUTHORIZED_BY_SUBMISSION",
] as const;
export const CapabilityReasonCode = z.enum(CAPABILITY_REASON_CODES);
export type CapabilityReasonCode = z.infer<typeof CapabilityReasonCode>;

// — Decision —

export const CAPABILITY_DECISIONS = ["ALLOW", "DENY"] as const;
export const CapabilityDecisionOutcome = z.enum(CAPABILITY_DECISIONS);
export type CapabilityDecisionOutcome = z.infer<typeof CapabilityDecisionOutcome>;

/**
 * One decision about one capability.
 *
 * The refinement is the point: an `ALLOW` carrying reason codes, or a `DENY`
 * carrying none, is a malformed decision — the first suggests a rule that
 * half-refused, the second gives a caller nothing to act on.
 */
export const CapabilityDecision = z
  .strictObject({
    capability: MarketplaceCapability,
    decision: CapabilityDecisionOutcome,
    reasonCodes: z.array(CapabilityReasonCode).max(CAPABILITY_REASON_CODES.length),
  })
  .refine(
    (d) => (d.decision === "ALLOW" ? d.reasonCodes.length === 0 : d.reasonCodes.length > 0),
    "ALLOW carries no reason codes; DENY carries at least one",
  );
export type CapabilityDecision = z.infer<typeof CapabilityDecision>;

function allow(capability: MarketplaceCapability): CapabilityDecision {
  return { capability, decision: "ALLOW", reasonCodes: [] };
}

function deny(
  capability: MarketplaceCapability,
  ...reasonCodes: CapabilityReasonCode[]
): CapabilityDecision {
  return { capability, decision: "DENY", reasonCodes };
}

export function isAllowed(decision: CapabilityDecision): boolean {
  return decision.decision === "ALLOW";
}

// — Shared gates —

/**
 * The identity gate. A guest fails it, and so does a disabled account.
 *
 * Account status is read for exactly one thing — whether the login itself is
 * usable. It never carries marketplace meaning.
 */
function requireEnabledAccount(subject: MarketplaceSubject): CapabilityReasonCode | undefined {
  if (subject.account === null) return "ACCOUNT_REQUIRED";
  if (subject.account.status !== "ACTIVE") return "ACCOUNT_DISABLED";
  return undefined;
}

/**
 * A drafting decision: an enabled account, a participant in a drafting status,
 * and the named role held in a drafting status.
 *
 * Deliberately does **not** require activation, profile completion, payment
 * readiness, or review. That is the thesis's bare-bones account: it may build,
 * and it may not sell.
 */
function evaluateDraft(
  capability: MarketplaceCapability,
  subject: MarketplaceSubject,
  role: MarketplaceRole,
): CapabilityDecision {
  const accountProblem = requireEnabledAccount(subject);
  if (accountProblem) return deny(capability, accountProblem);
  if (subject.participant === null) return deny(capability, "PARTICIPANT_REQUIRED");
  if (!permitsDrafting(subject.participant.status)) {
    return deny(capability, "PARTICIPANT_STATUS_NOT_ELIGIBLE");
  }
  const assignment = findRoleAssignment(subject.participant, role);
  if (assignment === undefined) return deny(capability, "ROLE_NOT_HELD");
  if (!(DRAFTING_ROLE_STATUSES as readonly string[]).includes(assignment.status)) {
    return deny(capability, "ROLE_NOT_ACTIVE");
  }
  return allow(capability);
}

/**
 * A commerce decision: admitted to the marketplace **and** payable.
 *
 * Both axes, always. Payment readiness alone is not activation — the provider
 * never decided who may sell on Monacado — and activation alone does not make
 * money movable, which is why an ACTIVE participant with unfinished onboarding is
 * refused here rather than discovering it at settlement time.
 */
function evaluateCommerce(
  capability: MarketplaceCapability,
  subject: MarketplaceSubject,
  roles: readonly MarketplaceRole[],
): CapabilityDecision {
  const accountProblem = requireEnabledAccount(subject);
  if (accountProblem) return deny(capability, accountProblem);
  const participant = subject.participant;
  if (participant === null) return deny(capability, "PARTICIPANT_REQUIRED");
  if (participant.status !== "ACTIVE") return deny(capability, "PARTICIPANT_NOT_ACTIVATED");

  const held = roles.map((role) => findRoleAssignment(participant, role));
  if (held.every((a) => a === undefined)) return deny(capability, "ROLE_NOT_HELD");
  if (!held.some((a) => a?.status === "ACTIVE")) return deny(capability, "ROLE_NOT_ACTIVE");

  if (participant.paymentReadiness === "RESTRICTED") return deny(capability, "PAYMENT_RESTRICTED");
  if (participant.paymentReadiness !== "ENABLED") return deny(capability, "PAYMENT_NOT_ENABLED");
  return allow(capability);
}

// — Drafting capabilities —

/** A seller or a promoter may draft a storefront. Both operate storefronts. */
export function canCreateDraftStorefront(subject: MarketplaceSubject): CapabilityDecision {
  const capability = "storefront:draft:create" as const;
  const asSeller = evaluateDraft(capability, subject, "SELLER");
  if (isAllowed(asSeller)) return asSeller;
  const asPromoter = evaluateDraft(capability, subject, "PROMOTER");
  if (isAllowed(asPromoter)) return asPromoter;
  /* Report the seller path's reason unless the only problem was the role itself,
     in which case neither role was usable and that is the honest answer. */
  return asSeller.reasonCodes[0] === "ROLE_NOT_HELD" ? asPromoter : asSeller;
}

/**
 * Drafting an **owned** Product requires SELLER.
 *
 * A promoter curates other people's products and may never author the creator's
 * authoritative product facts (ADR §2; thesis §4.2).
 */
export function canCreateDraftProduct(subject: MarketplaceSubject): CapabilityDecision {
  return evaluateDraft("product:draft:create", subject, "SELLER");
}

/**
 * Drafting a **seller-direct** listing requires SELLER.
 *
 * A seller placing their own Product in their own Storefront: there is no
 * wholesale counterparty and no Offer, so the gate is the seller's own drafting
 * eligibility.
 *
 * Deliberately **separate from `product:draft:create`.** Authoring a Product's
 * authoritative facts and placing a Product for sale are different acts, and one
 * capability answering both would mean a future change to either rule silently
 * moved the other. This capability was added in Phase 0M.7: 0M.1's vocabulary
 * predates 0M.4A splitting Listings into SELLER_DIRECT and PROMOTED, so it named
 * only the promoted half.
 */
export function canCreateSellerDirectListing(subject: MarketplaceSubject): CapabilityDecision {
  return evaluateDraft("listing:seller_direct:create", subject, "SELLER");
}

/** Drafting a promoted listing requires PROMOTER. */
export function canCreatePromotedListing(subject: MarketplaceSubject): CapabilityDecision {
  return evaluateDraft("listing:promoted:create", subject, "PROMOTER");
}

// — Activation —

/**
 * Submitting the participant for Monacado's activation review.
 *
 * Requires a complete profile and at least one activatable role. Payment
 * readiness is **not** a precondition: the provider's onboarding and Monacado's
 * review are independent gates, and requiring one to start the other would make
 * a provider outage a Monacado review outage.
 */
export function canSubmitActivation(subject: MarketplaceSubject): CapabilityDecision {
  const capability = "activation:submit" as const;
  const accountProblem = requireEnabledAccount(subject);
  if (accountProblem) return deny(capability, accountProblem);
  const participant = subject.participant;
  if (participant === null) return deny(capability, "PARTICIPANT_REQUIRED");

  switch (participant.status) {
    case "PROFILE_COMPLETE":
      break;
    case "DRAFT":
    case "PROFILE_INCOMPLETE":
      return deny(capability, "PROFILE_NOT_COMPLETE");
    case "UNDER_REVIEW":
      return deny(capability, "ACTIVATION_ALREADY_SUBMITTED");
    case "ACTIVE":
      return deny(capability, "ACTIVATION_ALREADY_COMPLETE");
    default:
      return deny(capability, "PARTICIPANT_STATUS_NOT_ELIGIBLE");
  }

  const activatable = participant.roles.filter(
    (r) => isActivatableRole(r.role) && r.status !== "REVOKED",
  );
  if (activatable.length === 0) return deny(capability, "NO_ACTIVATABLE_ROLE");
  return allow(capability);
}

/** Taking a storefront live: full commerce gates, seller or promoter. */
export function canActivateStorefront(subject: MarketplaceSubject): CapabilityDecision {
  return evaluateCommerce("storefront:activate", subject, ["SELLER", "PROMOTER"]);
}

/**
 * Publishing an Offer — creator-authorized commercial terms (ADR §2).
 *
 * SELLER only, and behind the full commerce gates: an Offer is a commitment to
 * transact, so it must not be publishable by a participant who cannot be paid.
 */
export function canPublishOffer(subject: MarketplaceSubject): CapabilityDecision {
  return evaluateCommerce("offer:publish", subject, ["SELLER"]);
}

// — Money —

/** Receiving a payout: marketplace activation **and** payment readiness. */
export function canReceivePayout(subject: MarketplaceSubject): CapabilityDecision {
  return evaluateCommerce("payout:receive", subject, ["SELLER", "PROMOTER"]);
}

/**
 * Accruing a promoter commission.
 *
 * Requires an active promoter on an admitted participant. It does **not** require
 * ENABLED payment readiness: accrual is a ledger fact about a sale that already
 * happened, and refusing to record it would lose the obligation rather than defer
 * it. Paying it out still requires `canReceivePayout`. A provider hold
 * (RESTRICTED or DISABLED) does stop accrual, because that is a signal about the
 * participant, not a timing problem.
 */
export function canAccrueCommission(subject: MarketplaceSubject): CapabilityDecision {
  const capability = "commission:accrue" as const;
  const accountProblem = requireEnabledAccount(subject);
  if (accountProblem) return deny(capability, accountProblem);
  const participant = subject.participant;
  if (participant === null) return deny(capability, "PARTICIPANT_REQUIRED");
  if (participant.status !== "ACTIVE") return deny(capability, "PARTICIPANT_NOT_ACTIVATED");

  const promoter = findRoleAssignment(participant, "PROMOTER");
  if (promoter === undefined) return deny(capability, "ROLE_NOT_HELD");
  if (promoter.status !== "ACTIVE") return deny(capability, "ROLE_NOT_ACTIVE");

  if (participant.paymentReadiness === "RESTRICTED") return deny(capability, "PAYMENT_RESTRICTED");
  if (participant.paymentReadiness === "DISABLED") return deny(capability, "PAYMENT_NOT_ENABLED");
  return allow(capability);
}

// — Review submission —

/**
 * What a review submission is judged on.
 *
 * The subject may be a guest (`account: null`); provenance is the gate either
 * way. There is no field for review text or a rating — this decides authority,
 * not content moderation.
 */
export const ReviewSubmissionEligibility = z.strictObject({
  subject: MarketplaceSubject,
  purchaseProvenance: PurchaseProvenanceStatus,
});
export type ReviewSubmissionEligibility = z.infer<typeof ReviewSubmissionEligibility>;

function evaluateReviewSubmission(
  capability: MarketplaceCapability,
  input: ReviewSubmissionEligibility,
): CapabilityDecision {
  const { subject, purchaseProvenance } = input;

  /* A guest is permitted — the thesis makes guest checkout first-class, so the
     buyer who has the most standing to review may well have no account. */
  if (subject.account !== null && subject.account.status !== "ACTIVE") {
    return deny(capability, "ACCOUNT_DISABLED");
  }
  /* An account holder who has claimed the marketplace must hold a usable BUYER
     role; an account with no participant record is treated as a guest buyer,
     which is what they are until they claim otherwise. */
  if (subject.participant !== null) {
    const buyer = findRoleAssignment(subject.participant, "BUYER");
    if (buyer === undefined) return deny(capability, "ROLE_NOT_HELD");
    if (buyer.status !== "ACTIVE") return deny(capability, "ROLE_NOT_ACTIVE");
    if (subject.participant.status === "SUSPENDED" || subject.participant.status === "CLOSED") {
      return deny(capability, "PARTICIPANT_STATUS_NOT_ELIGIBLE");
    }
  }
  if (purchaseProvenance !== "VERIFIED") {
    return deny(capability, "PURCHASE_PROVENANCE_UNVERIFIED");
  }
  return allow(capability);
}

export function canSubmitProductReview(input: ReviewSubmissionEligibility): CapabilityDecision {
  return evaluateReviewSubmission("review:product:submit", input);
}

export function canSubmitSellerReview(input: ReviewSubmissionEligibility): CapabilityDecision {
  return evaluateReviewSubmission("review:seller:submit", input);
}

// — Review capsule authority —

/**
 * A request to act on a capsule under a stored review-submission authority.
 *
 * The target is explicit, because the entire question is *what this authority
 * does not reach*.
 */
export const ReviewCapsuleActionRequest = z.strictObject({
  authority: ReviewSubmissionAuthorityView,
  action: ReviewCapsuleAction,
  target: CapsuleAuthorityTarget,
});
export type ReviewCapsuleActionRequest = z.infer<typeof ReviewCapsuleActionRequest>;

function evaluateReviewCapsule(
  capability: MarketplaceCapability,
  expectedKind: ReviewCapsuleKind,
  request: ReviewCapsuleActionRequest,
): CapabilityDecision {
  const { authority, action, target } = request;

  if (authority.reviewKind !== expectedKind) {
    return deny(capability, "REVIEW_AUTHORITY_KIND_MISMATCH");
  }
  /* Scope first: anything that is not a review capsule is out of reach no matter
     how healthy the authority is. A buyer never acquires the creator's Product
     capsule, the promoter's Listing, or Monacado's marketplace assertions by
     writing a review. */
  if (target.kind !== "PRODUCT_REVIEW" && target.kind !== "SELLER_REVIEW") {
    return deny(capability, "REVIEW_AUTHORITY_SCOPE_EXCEEDED");
  }
  if (target.kind !== authority.reviewKind) {
    return deny(capability, "REVIEW_AUTHORITY_KIND_MISMATCH");
  }
  /* …and only *that* review. An authority over one review is not an authority
     over reviews. */
  if (target.ref !== authority.reviewSubmissionId) {
    return deny(capability, "REVIEW_AUTHORITY_TARGET_MISMATCH");
  }
  if (authority.purchaseProvenance !== "VERIFIED") {
    return deny(capability, "PURCHASE_PROVENANCE_UNVERIFIED");
  }
  if (authority.status === "INVALIDATED") {
    return ACTIONS_PERMITTED_WHEN_INVALIDATED.includes(action)
      ? allow(capability)
      : deny(capability, "REVIEW_AUTHORITY_INVALIDATED");
  }
  if (!AUTHORIZED_ACTIONS_BY_SUBMISSION_STATE[authority.submissionState].includes(action)) {
    return deny(capability, "ACTION_NOT_AUTHORIZED_BY_SUBMISSION");
  }
  return allow(capability);
}

/**
 * May Monacado act on a ProductReview capsule under this authority?
 *
 * Monacado remains the Publisher and Registrar throughout (ADR §11.0–§11.2). This
 * answers only whether the buyer's submission authorizes the act.
 */
export function canPublishProductReviewCapsule(
  request: ReviewCapsuleActionRequest,
): CapabilityDecision {
  return evaluateReviewCapsule("review:product:capsule:publish", "PRODUCT_REVIEW", request);
}

/** May Monacado act on a SellerReview capsule under this authority? */
export function canPublishSellerReviewCapsule(
  request: ReviewCapsuleActionRequest,
): CapabilityDecision {
  return evaluateReviewCapsule("review:seller:capsule:publish", "SELLER_REVIEW", request);
}

/**
 * The kind-agnostic evaluator, for asking what an authority reaches without first
 * assuming which review it covers.
 */
export function evaluateReviewCapsuleAuthority(
  request: ReviewCapsuleActionRequest,
): CapabilityDecision {
  return request.authority.reviewKind === "PRODUCT_REVIEW"
    ? canPublishProductReviewCapsule(request)
    : canPublishSellerReviewCapsule(request);
}

// — The internal/marketplace boundary —

/**
 * Marketplace capabilities granted by holding internal operator entitlements:
 * **none, permanently.**
 *
 * `AccountEntitlement` exists to answer one question — may this account read
 * internal operational data — and a Monacado operator is not thereby a seller.
 * Returning a non-empty array here would be an ADR-level change, not a tweak.
 */
export function marketplaceCapabilitiesGrantedByInternalEntitlement(
  _capabilities: readonly AccountCapability[],
): readonly MarketplaceCapability[] {
  return [];
}

/**
 * Internal capabilities granted by holding marketplace roles: **none,
 * permanently.**
 *
 * The inverse, and the more dangerous direction: a seller who could read
 * publication-worker status would have crossed from the marketplace into
 * Monacado's operations because one enum served two questions.
 */
export function internalCapabilitiesGrantedByMarketplaceRoles(
  _roles: readonly MarketplaceRole[],
): readonly AccountCapability[] {
  return [];
}
