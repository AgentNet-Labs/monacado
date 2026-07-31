/**
 * Buyer review authority and public review attribution (Phase 0M.1).
 *
 * The binding rule this module encodes: **a buyer's review submission is itself
 * the grant of authority for Monacado to create, register, publish, update,
 * supersede, or revoke that review's capsule — and nothing else.**
 *
 * Four properties shape everything below:
 *
 *   1. **Authority is scoped to one review.** It names one submission, one review
 *      kind, and one target. It confers nothing over the Product, the Seller, the
 *      Storefront, the Listing, or the Offer — the capsules those authorities own
 *      belong to the creator, the promoter, and Monacado (ADR §2), and a buyer
 *      cannot acquire them by writing about them.
 *
 *   2. **The buyer is the factual authority; Monacado is the Publisher.** ADR §2
 *      assigns the Review capsule's authority to the buyer, and ADR §11.0/§11.1
 *      keep Publisher and Registrar with Monacado under controlled credentials.
 *      Both hold at once: the buyer's words are the buyer's, and the submission is
 *      the stored authorisation ADR §11.6 requires before Monacado publishes for
 *      a participant. Buyers receive no publishing credentials.
 *
 *   3. **The lifecycle of the submission drives the lifecycle of the capsule.**
 *      Editing authorizes supersession; withdrawing authorizes revocation. Nothing
 *      else may be inferred — a submitted review does not authorize a revocation,
 *      and a withdrawn one does not authorize a new publication.
 *
 *   4. **Provenance may support authority without being published.** Purchase
 *      evidence proves the buyer transacted; it is referenced by id and never
 *      appears in a capsule (ADR §11.10).
 *
 * Pure data and pure functions. No persistence, no clock, no publication.
 */

import { z } from "zod";
import {
  PURCHASE_EVIDENCE_ID_RE,
  REVIEW_SUBMISSION_AUTHORITY_ID_RE,
  REVIEW_SUBMISSION_ID_RE,
} from "./identity";

// — Identity —

export const ReviewSubmissionId = z
  .string()
  .regex(REVIEW_SUBMISSION_ID_RE, "reviewSubmissionId must be mon:rsub:<opaque>");
export type ReviewSubmissionId = z.infer<typeof ReviewSubmissionId>;

export const ReviewSubmissionAuthorityId = z
  .string()
  .regex(REVIEW_SUBMISSION_AUTHORITY_ID_RE, "authorityId must be mon:rauth:<opaque>");
export type ReviewSubmissionAuthorityId = z.infer<typeof ReviewSubmissionAuthorityId>;

export const PurchaseEvidenceId = z
  .string()
  .regex(PURCHASE_EVIDENCE_ID_RE, "purchaseEvidenceId must be mon:pvev:<opaque>");
export type PurchaseEvidenceId = z.infer<typeof PurchaseEvidenceId>;

// — Review kinds —

/**
 * Two separate capsule authorities, never one "review" capsule with a type field.
 *
 * A product review asserts something about a Product node; a seller review
 * asserts something about a participant's conduct as a seller. They have
 * different subjects, different defamation and moderation exposure, and different
 * supersession consequences — collapsing them would mean revoking one could not
 * help but touch the other's history.
 */
export const REVIEW_CAPSULE_KINDS = ["PRODUCT_REVIEW", "SELLER_REVIEW"] as const;
export const ReviewCapsuleKind = z.enum(REVIEW_CAPSULE_KINDS);
export type ReviewCapsuleKind = z.infer<typeof ReviewCapsuleKind>;

// — Submitter and provenance —

/**
 * Who submitted. A guest is a real, supported case (thesis §5.1) and is not an
 * account in disguise: guest checkout must never silently create one.
 */
export const REVIEW_SUBMITTER_KINDS = ["ACCOUNT_BUYER", "GUEST_BUYER"] as const;
export const ReviewSubmitterKind = z.enum(REVIEW_SUBMITTER_KINDS);
export type ReviewSubmitterKind = z.infer<typeof ReviewSubmitterKind>;

/**
 * How well Monacado can prove the submitter transacted.
 *
 *   - NONE — no transaction is claimed.
 *   - UNVERIFIED — a transaction is claimed and has not been established.
 *   - VERIFIED — Monacado holds evidence binding this submitter to a purchase.
 *
 * VERIFIED is required for **every** review, guest or account holder. Review
 * authority derives from a purchase, not from having logged in; an account that
 * never bought anything is exactly the case this refuses.
 */
export const PURCHASE_PROVENANCE_STATUSES = ["NONE", "UNVERIFIED", "VERIFIED"] as const;
export const PurchaseProvenanceStatus = z.enum(PURCHASE_PROVENANCE_STATUSES);
export type PurchaseProvenanceStatus = z.infer<typeof PurchaseProvenanceStatus>;

// — Submission lifecycle —

/**
 * The buyer-facing lifecycle of one submission, and the only thing that decides
 * which capsule actions are authorized.
 */
export const REVIEW_SUBMISSION_STATES = ["SUBMITTED", "EDITED", "WITHDRAWN"] as const;
export const ReviewSubmissionState = z.enum(REVIEW_SUBMISSION_STATES);
export type ReviewSubmissionState = z.infer<typeof ReviewSubmissionState>;

/**
 * Monacado's own hold on the authority.
 *
 * INVALIDATED covers the case where the evidence behind a review is later
 * disproven or the content is removed under policy. It permits revocation and
 * nothing else — the published capsule must still be retractable.
 */
export const REVIEW_AUTHORITY_STATUSES = ["ACTIVE", "INVALIDATED"] as const;
export const ReviewAuthorityStatus = z.enum(REVIEW_AUTHORITY_STATUSES);
export type ReviewAuthorityStatus = z.infer<typeof ReviewAuthorityStatus>;

// — Capsule actions and targets —

/**
 * The capsule operations a submission can authorize.
 *
 * REGISTER and PUBLISH are listed separately because ADR §11.0 forbids collapsing
 * the Publisher and Registrar roles into one undifferentiated privilege. One
 * authority record may permit both, but it permits them as two named acts.
 */
export const REVIEW_CAPSULE_ACTIONS = [
  "CREATE",
  "REGISTER",
  "PUBLISH",
  "UPDATE",
  "SUPERSEDE",
  "REVOKE",
] as const;
export const ReviewCapsuleAction = z.enum(REVIEW_CAPSULE_ACTIONS);
export type ReviewCapsuleAction = z.infer<typeof ReviewCapsuleAction>;

/**
 * Every capsule authority a marketplace action could conceivably aim at.
 *
 * The non-review members exist **so they can be denied by name**. A vocabulary
 * containing only review targets would make "a buyer cannot touch the Product
 * capsule" unrepresentable, and therefore untestable.
 */
export const CAPSULE_AUTHORITY_TARGET_KINDS = [
  "PRODUCT_REVIEW",
  "SELLER_REVIEW",
  "PRODUCT",
  "SELLER",
  "STOREFRONT",
  "LISTING",
  "OFFER",
] as const;
export const CapsuleAuthorityTargetKind = z.enum(CAPSULE_AUTHORITY_TARGET_KINDS);
export type CapsuleAuthorityTargetKind = z.infer<typeof CapsuleAuthorityTargetKind>;

/** A bounded opaque reference. Never an email, a name, or a slug. */
export const CapsuleTargetRef = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,191}$/, "target ref must be an opaque bounded identifier");

export const CapsuleAuthorityTarget = z.strictObject({
  kind: CapsuleAuthorityTargetKind,
  ref: CapsuleTargetRef,
});
export type CapsuleAuthorityTarget = z.infer<typeof CapsuleAuthorityTarget>;

// — The stored authority —

/**
 * The stored grant ADR §11.6 requires before Monacado publishes for a
 * participant, projected to exactly what an authority decision needs.
 *
 * There is no field for review text, a rating, a buyer name, an email, an
 * account id, an order id, or a payment reference. `purchaseEvidenceRef` names
 * the private evidence record; it is a pointer, and it is never published.
 */
export const ReviewSubmissionAuthorityView = z.strictObject({
  authorityId: ReviewSubmissionAuthorityId,
  reviewSubmissionId: ReviewSubmissionId,
  reviewKind: ReviewCapsuleKind,
  /** The node the review is about — a Product ref or a seller participant ref. */
  reviewSubjectRef: CapsuleTargetRef,
  submitter: ReviewSubmitterKind,
  purchaseProvenance: PurchaseProvenanceStatus,
  purchaseEvidenceRef: PurchaseEvidenceId.nullable(),
  submissionState: ReviewSubmissionState,
  status: ReviewAuthorityStatus,
});
export type ReviewSubmissionAuthorityView = z.infer<typeof ReviewSubmissionAuthorityView>;

/**
 * Which capsule actions a submission state authorizes.
 *
 * Read this as the binding rule in table form: submitting authorizes first
 * publication, **editing authorizes supersession, withdrawing authorizes
 * revocation** — and no state authorizes anything outside that review.
 */
export const AUTHORIZED_ACTIONS_BY_SUBMISSION_STATE: Record<
  ReviewSubmissionState,
  readonly ReviewCapsuleAction[]
> = Object.freeze({
  SUBMITTED: ["CREATE", "REGISTER", "PUBLISH"],
  EDITED: ["UPDATE", "SUPERSEDE", "PUBLISH"],
  WITHDRAWN: ["REVOKE"],
});

/**
 * The only action an invalidated authority still permits.
 *
 * Retraction must remain possible after the authority is withdrawn — otherwise a
 * review Monacado has decided must come down would be published and unrevocable.
 */
export const ACTIONS_PERMITTED_WHEN_INVALIDATED: readonly ReviewCapsuleAction[] =
  Object.freeze(["REVOKE"]);

// — Public attribution —

/**
 * How a published review credits its author.
 *
 * PSEUDONYMOUS is the default because ADR §11.10 requires a privacy-preserving
 * authorship pattern unless a public identity is explicitly justified and
 * approved. VERIFIED_PURCHASER carries a provenance claim and still no identity.
 */
export const REVIEW_ATTRIBUTION_MODES = [
  "PSEUDONYMOUS",
  "VERIFIED_PURCHASER",
  "APPROVED_PUBLIC_IDENTITY",
] as const;
export const ReviewAttributionMode = z.enum(REVIEW_ATTRIBUTION_MODES);
export type ReviewAttributionMode = z.infer<typeof ReviewAttributionMode>;

/**
 * A display label safe to publish.
 *
 * `@` is refused outright: the single most likely private value to arrive here by
 * accident is an email address, and a label that cannot contain one cannot leak
 * one. Bounded, and no control characters.
 */
export const PublicDisplayLabel = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[^@\p{C}]+$/u, "a public display label must not contain '@' or control characters");

/**
 * The complete publishable attribution.
 *
 * Absent by construction, not by filtering: there is no field for an account id,
 * a participant id, an email, a legal name, an order id, a payment reference, or
 * a purchase-evidence id. A projection cannot leak what the schema cannot hold.
 */
export const PublicReviewAttribution = z.strictObject({
  mode: ReviewAttributionMode,
  displayLabel: PublicDisplayLabel,
  /** A provenance *claim*, not the evidence. The evidence stays private. */
  verifiedPurchase: z.boolean(),
});
export type PublicReviewAttribution = z.infer<typeof PublicReviewAttribution>;

/**
 * Everything the projector is given. Note what is **not** here: no account id, no
 * email, no name, no evidence id. The private facts never enter the function, so
 * they cannot leave it.
 */
export const ProjectReviewAttributionInput = z.strictObject({
  submitter: ReviewSubmitterKind,
  purchaseProvenance: PurchaseProvenanceStatus,
  /** A label the buyer chose, or Monacado assigned. Never derived from an email. */
  pseudonym: PublicDisplayLabel,
  /**
   * Explicit, per-review consent plus policy approval (ADR §11.10). Defaulting
   * this to `true` anywhere would publish a buyer's identity by omission.
   */
  publicIdentityApproved: z.boolean(),
});
export type ProjectReviewAttributionInput = z.infer<typeof ProjectReviewAttributionInput>;

/**
 * Project publishable attribution from private submission facts.
 *
 * Buyer identity is **not published by default**: without an explicit approval the
 * result is pseudonymous, whichever kind of buyer submitted.
 */
export function projectPublicReviewAttribution(
  input: ProjectReviewAttributionInput,
): PublicReviewAttribution {
  const parsed = ProjectReviewAttributionInput.parse(input);
  const verifiedPurchase = parsed.purchaseProvenance === "VERIFIED";
  const mode: ReviewAttributionMode = parsed.publicIdentityApproved
    ? "APPROVED_PUBLIC_IDENTITY"
    : verifiedPurchase
      ? "VERIFIED_PURCHASER"
      : "PSEUDONYMOUS";
  return PublicReviewAttribution.parse({
    mode,
    displayLabel: parsed.pseudonym,
    verifiedPurchase,
  });
}
