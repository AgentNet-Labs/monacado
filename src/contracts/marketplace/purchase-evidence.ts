/**
 * Purchase evidence and review-submission authority (Phase 0M.9).
 *
 * The two records a completed purchase creates on the review side: the **private
 * evidence that a buyer transacted**, and the **stored grant** ADR §11.6 requires
 * before Monacado publishes anything on a participant's behalf.
 *
 * Six properties shape everything below:
 *
 *   1. **The contracts already exist; this phase persists them.** `0M.1` settled
 *      the review-authority model — `ReviewSubmissionAuthorityView`,
 *      `ReviewCapsuleKind`, `ReviewSubmitterKind`, `PurchaseProvenanceStatus`, the
 *      submission-state action table, and `evaluateReviewCapsuleAuthority`. None of
 *      it is restated here. What was missing was rows, and the roadmap names those
 *      as `0M.9`'s: "the first real `ReviewSubmissionAuthority` rows".
 *
 *   2. **Authority derives from a purchase, not from having logged in.** `0M.1`
 *      requires `VERIFIED` provenance for *every* review, guest or account holder.
 *      Purchase evidence is what makes provenance verifiable, and it is created
 *      only by a completed sale.
 *
 *   3. **A guest may review.** `0M.1` is explicit that a guest is "a real,
 *      supported case… and is not an account in disguise", and
 *      `canSubmitProductReview` permits `subject.account === null`. This phase
 *      therefore does **not** require an account claim before review; inventing
 *      that gate would contradict a settled contract.
 *
 *   4. **Evidence is private and is never published.** ADR §11.10: it is
 *      referenced by id and never appears in a capsule. It holds no buyer name,
 *      email, address, or payment detail — there is no column for any of them.
 *
 *   5. **One authority per governed subject per Order.** A buyer gets one product
 *      review and one seller review out of one purchase, enforced by a unique
 *      index. Buying once does not license writing repeatedly.
 *
 *   6. **No review content.** There is no field for text, a rating, a title, a
 *      photo, or a moderation decision, and no capsule is projected or published.
 *      This phase establishes *who may write*, and the writing is a later phase.
 *
 * Pure data and pure decisions. No database, clock, environment read,
 * randomness, or network. Not exported through the browser-facing barrel.
 */

import { z } from "zod";
import {
  MARKETPLACE_PARTICIPANT_ID_RE,
  ORDER_ID_RE,
} from "./identity";
import { INTERNAL_PRODUCT_ID_RE } from "../capsule/identity";
import {
  PurchaseEvidenceId,
  ReviewAuthorityStatus,
  ReviewCapsuleKind,
  ReviewSubmissionAuthorityId,
  ReviewSubmissionAuthorityView,
  ReviewSubmissionId,
  ReviewSubmissionState,
  ReviewSubmitterKind,
  PurchaseProvenanceStatus,
} from "./review-authority";

const OrderRef = z.string().regex(ORDER_ID_RE, "orderId must be mon:order:<opaque>");
const ParticipantRef = z
  .string()
  .regex(MARKETPLACE_PARTICIPANT_ID_RE, "participant id must be mon:mpart:<opaque>");
const ProductRef = z
  .string()
  .regex(INTERNAL_PRODUCT_ID_RE, "internalProductId must be mon:product:<opaque>");

// — Purchase evidence —

/**
 * Monacado's private record that one buyer transacted for one Product.
 *
 * **Created only by a completed sale**, one per Order, and never by a caller
 * asserting one. It names what a later review needs to know — which Product, and
 * which seller — and nothing about the person.
 *
 * The buyer is identified exactly as the Order identifies them and no more
 * precisely: an account id when there is one, and for a guest **nothing at all**.
 * A guest's evidence is reached through their Order, which they reach with their
 * claim code. There is deliberately no guest identifier here, because a stable
 * per-guest identifier would be the tracking key this design exists without.
 */
export const PurchaseEvidenceRecord = z.strictObject({
  purchaseEvidenceId: PurchaseEvidenceId,
  /** The completed Order this evidence is drawn from. One per Order. */
  orderId: OrderRef,

  /** How well Monacado can prove the buyer transacted. Always VERIFIED here. */
  purchaseProvenance: PurchaseProvenanceStatus,
  submitter: ReviewSubmitterKind,

  /** What was bought, and from whom — the two reviewable subjects. */
  internalProductId: ProductRef,
  sellerParticipantId: ParticipantRef,

  /** The instant of the completed sale. Supplied, never a clock read. */
  establishedAt: z.iso.datetime(),
  createdAt: z.iso.datetime(),
});
export type PurchaseEvidenceRecord = z.infer<typeof PurchaseEvidenceRecord>;

// — Review eligibility —

/**
 * Why a buyer may not (yet) review.
 *
 * A bounded vocabulary a route may safely return. It deliberately does **not**
 * duplicate `CAPABILITY_REASON_CODES`: those judge the *subject* — account
 * status, role, participant standing — and `canSubmitProductReview` already
 * decides them. These judge the *purchase*, which is the half `0M.1` left to the
 * phase that would create one.
 */
export const REVIEW_ELIGIBILITY_BLOCKERS = [
  /** The Order has not completed as a sale. */
  "ORDER_NOT_COMPLETED",
  /** No purchase evidence exists for this Order. */
  "PURCHASE_EVIDENCE_MISSING",
  /** An authority for this review kind on this Order already exists. */
  "REVIEW_ALREADY_AUTHORIZED",
] as const;
export const ReviewEligibilityBlocker = z.enum(REVIEW_ELIGIBILITY_BLOCKERS);
export type ReviewEligibilityBlocker = z.infer<typeof ReviewEligibilityBlocker>;

export interface ReviewEligibility {
  eligible: boolean;
  /** Every reason, in the declared order — not just the first found. */
  blockers: ReviewEligibilityBlocker[];
}

/**
 * Whether one completed purchase still licenses one kind of review.
 *
 * **The purchase half only.** The subject half — is this account disabled, does
 * this participant hold an active `BUYER` role — is `capability.ts`'s
 * `canSubmitProductReview` / `canSubmitSellerReview`, which this deliberately does
 * not re-implement. A caller asks both; neither answers the other's question.
 *
 * Every failing condition is reported rather than the first, matching
 * `evaluateListingBuyerEligibility`.
 */
export function evaluatePurchaseReviewEligibility(input: {
  orderCompleted: boolean;
  purchaseEvidenceExists: boolean;
  authorityAlreadyExists: boolean;
}): ReviewEligibility {
  const blockers: ReviewEligibilityBlocker[] = [];
  if (!input.orderCompleted) blockers.push("ORDER_NOT_COMPLETED");
  if (!input.purchaseEvidenceExists) blockers.push("PURCHASE_EVIDENCE_MISSING");
  if (input.authorityAlreadyExists) blockers.push("REVIEW_ALREADY_AUTHORIZED");
  return { eligible: blockers.length === 0, blockers };
}

/**
 * The reviewable subject for one review kind.
 *
 * A product review is about the Product node; a seller review is about the
 * participant's conduct as a seller. `0M.1` keeps them as two capsule authorities
 * rather than one with a type field, and this returns the subject each one names.
 *
 * **The promoter is not a reviewable subject.** A promoter neither made the
 * product nor contracted its supply; reviewing them would be reviewing a
 * shopfront's choice of stock, which is a different assertion nobody has designed.
 */
export function reviewSubjectRefFor(
  kind: ReviewCapsuleKind,
  subjects: { internalProductId: string; sellerParticipantId: string },
): string {
  return kind === "PRODUCT_REVIEW" ? subjects.internalProductId : subjects.sellerParticipantId;
}

// — The stored authority —

/**
 * One persisted review-submission authority.
 *
 * Every field maps onto `ReviewSubmissionAuthorityView`, which
 * `evaluateReviewCapsuleAuthority` already consumes — so a persisted row feeds the
 * committed decision function unchanged, and this phase adds **no second
 * authority evaluator**.
 *
 * The extra fields here are storage lineage — which Order and which evidence —
 * and are deliberately absent from the view: an authority *decision* has no
 * business knowing an order id, and a view that carried one could leak it into a
 * capsule projection.
 */
export const ReviewSubmissionAuthorityRecord = z.strictObject({
  authorityId: ReviewSubmissionAuthorityId,
  /**
   * The submission this authority is for.
   *
   * Minted with the authority because `0M.1` binds them one-to-one: the
   * submission *is* the grant. The submission's **content** — text, rating,
   * title — has no column anywhere in this phase.
   */
  reviewSubmissionId: ReviewSubmissionId,

  /** Storage lineage. Not part of the authority view. */
  orderId: OrderRef,
  purchaseEvidenceId: PurchaseEvidenceId,

  reviewKind: ReviewCapsuleKind,
  /** The Product id or the seller participant id — see `reviewSubjectRefFor`. */
  reviewSubjectRef: z.string().min(1).max(191),
  submitter: ReviewSubmitterKind,
  purchaseProvenance: PurchaseProvenanceStatus,
  submissionState: ReviewSubmissionState,
  status: ReviewAuthorityStatus,

  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ReviewSubmissionAuthorityRecord = z.infer<typeof ReviewSubmissionAuthorityRecord>;

/**
 * Project a persisted authority onto the committed `0M.1` decision view.
 *
 * **The only bridge between storage and the authority decision**, and deliberately
 * a strict one: it emits `0M.1`'s own `strictObject`, so a storage field this
 * phase added cannot leak into a capsule-authority decision.
 */
export function toReviewSubmissionAuthorityView(
  record: ReviewSubmissionAuthorityRecord,
): ReviewSubmissionAuthorityView {
  const parsed = ReviewSubmissionAuthorityRecord.parse(record);
  return ReviewSubmissionAuthorityView.parse({
    authorityId: parsed.authorityId,
    reviewSubmissionId: parsed.reviewSubmissionId,
    reviewKind: parsed.reviewKind,
    reviewSubjectRef: parsed.reviewSubjectRef,
    submitter: parsed.submitter,
    purchaseProvenance: parsed.purchaseProvenance,
    /* The pointer, not the evidence. It is never published (ADR §11.10). */
    purchaseEvidenceRef: parsed.purchaseEvidenceId,
    submissionState: parsed.submissionState,
    status: parsed.status,
  });
}

// — Inputs —

/**
 * Authorize one review out of one completed purchase.
 *
 * There is **no review content parameter**. This grants authority; it does not
 * accept a review. A caller supplying text would be writing a review through a
 * function that exists to decide whether they may.
 */
export const AuthorizeReviewSubmissionInput = z.strictObject({
  orderId: OrderRef,
  reviewKind: ReviewCapsuleKind,
  at: z.iso.datetime(),
});
export type AuthorizeReviewSubmissionInput = z.infer<typeof AuthorizeReviewSubmissionInput>;

// — Never on these records —

/**
 * Named as never-persistable, and not admissible through any input above.
 *
 * The first group is **buyer identity**, which stays out of evidence for the same
 * reason it stays off the Order. The second is **review content and moderation**,
 * which no part of this phase implements. The third is **capsule and publication
 * state**, which a later phase owns and which must never be inferred from an
 * authority row.
 */
export const NEVER_ON_PURCHASE_EVIDENCE = [
  // buyer identity — never here
  "buyerEmail",
  "buyerName",
  "buyerAddress",
  "buyerIpAddress",
  "guestIdentifier",
  "cardLast4",
  // review content and moderation — not this phase
  "reviewText",
  "reviewBody",
  "rating",
  "title",
  "photoUrl",
  "moderationDecision",
  "moderatorNote",
  // capsule and publication — a later phase
  "capsuleId",
  "nodeId",
  "publicationState",
  "publishedAt",
  "mappingVersion",
  "contentHash",
] as const;
