/**
 * Governed participant-level mitigation (Phase 1.14).
 *
 * Phase 1.13 built explainable risk intelligence and a Staff review that
 * enforces nothing, then recorded — in source, as a value a test reads — exactly
 * what would have to exist before a participant-level consequence could be
 * operated at all. This module is the authority half of that answer: what may be
 * withheld, who may withhold it, under which terms, and how it is undone.
 *
 * ## Recommendation and enforcement stay different acts
 *
 * Nothing here reads a `dispositionCode`, a review score, or a report row.
 * `SUSPENSION_RECOMMENDED` remains a conclusion a person recorded; a suspension
 * is a separate act by a separately-entitled person, and the only link between
 * them is a reference the consequence carries to its basis. A threshold crossing
 * changes nothing, ever, on its own — which is not caution but the whole design:
 * a seller suspended by arithmetic is the failure the previous phase existed to
 * prevent, and building the enforcement path is precisely when that guarantee
 * has to become mechanical rather than incidental.
 *
 * ## Terms first, and checked rather than assumed
 *
 * Marketplace Policy 1.2.0 authorises acting on **a transaction**. Acting on a
 * **participant** needed terms that did not exist, which is why 1.13 wrote the
 * requirement down instead of half-building the capability. `POLICY_VERSIONS_
 * AUTHORIZING_PARTICIPANT_MITIGATION` is that requirement made executable: the
 * service refuses every act unless the version ACTIVE IN THE DATABASE is one
 * that carries the terms. Shipping the document is not the same as governing
 * under it, and a check against the shipped constant rather than the active row
 * would confuse the two.
 *
 * ## No prose, and no analytics
 *
 * There is no note, rationale, or narrative column anywhere in this phase, for
 * the reason 0M.R1 and 1.11 both gave and 1.13 quoted: an operator commentary
 * column is where a buyer's name eventually lands. There is likewise no score,
 * rate, counter, or threshold on any record — a restriction justified by a
 * stored number would make the arithmetic authoritative over the person.
 *
 * Pure types and pure decisions. No I/O, no clock, no database.
 */

import { z } from "zod";
import {
  MARKETPLACE_PARTICIPANT_ID_RE,
  PARTICIPANT_RECONSIDERATION_ID_RE,
  PARTICIPANT_SUSPENSION_ID_RE,
} from "./identity";
import { AccountId } from "../account/account";
import { PARTICIPANT_STATUSES, ParticipantStatus } from "./participant";
import { isValidParticipantTransition } from "./lifecycle";

const ParticipantId = z
  .string()
  .regex(MARKETPLACE_PARTICIPANT_ID_RE, "must be mon:mpart:<opaque>");

export const ParticipantSuspensionId = z
  .string()
  .regex(PARTICIPANT_SUSPENSION_ID_RE, "must be mon:psus:<opaque>");
export type ParticipantSuspensionId = z.infer<typeof ParticipantSuspensionId>;

export const ParticipantReconsiderationId = z
  .string()
  .regex(PARTICIPANT_RECONSIDERATION_ID_RE, "must be mon:prrcn:<opaque>");
export type ParticipantReconsiderationId = z.infer<typeof ParticipantReconsiderationId>;

// — The governance gate —

/**
 * The Marketplace Policy versions whose terms authorise acting on a PARTICIPANT.
 *
 * 1.0.0, 1.1.0, and 1.2.0 are absent, and their absence is the point. 1.2.0's
 * risk term is transaction-scoped — "declining, holding, or reversing a
 * transaction on fraud or risk grounds" — and its dispute term says in terms that
 * a per-sale hold "is not a suspension of a participant's other proceeds". A
 * deployment still governed by any of them may run the analytics and record a
 * Staff review, and may do nothing to a participant.
 *
 * Checked against the version ACTIVE IN THE DATABASE, never against the newest
 * version this deployment happens to ship. `LATEST_MARKETPLACE_POLICY_VERSION`
 * is explicitly "not an assertion that it governs anything", and an enforcement
 * gate that read it would let publishing a document silently confer an authority
 * nobody activated.
 */
export const POLICY_VERSIONS_AUTHORIZING_PARTICIPANT_MITIGATION = ["1.3.0"] as const;

export function policyVersionAuthorizesParticipantMitigation(
  policyVersion: string | null,
): boolean {
  if (policyVersion === null) return false;
  return (POLICY_VERSIONS_AUTHORIZING_PARTICIPANT_MITIGATION as readonly string[]).includes(
    policyVersion,
  );
}

// — Suspension —

/**
 * Why a participant was suspended, as a closed vocabulary.
 *
 * SEPARATE FROM `RESTRICTION_REASON_CODES`, because withdrawing admission is a
 * different act from withholding one capability, and a shared vocabulary would
 * let the record understate which one happened.
 *
 * No member names fraud, dishonesty, or any legal wrong. These metrics cannot
 * establish misconduct, and a word that could would follow the participant
 * through every screen that ever rendered this row.
 */
export const SUSPENSION_REASON_CODES = [
  /** Adverse outcomes reached a level Monacado decided it would not carry. */
  "ADVERSE_OUTCOME_LEVEL_UNSUSTAINABLE",
  /** A restriction was imposed and the underlying problem was not corrected. */
  "REMEDIATION_NOT_COMPLETED",
  /** Monacado asked for information it needs to decide, and it has not arrived. */
  "REQUESTED_INFORMATION_OUTSTANDING",
  /** The participant does not meet a marketplace eligibility policy. */
  "POLICY_ELIGIBILITY_SUSPENSION",
  /** Continuing to trade would expose buyers to loss while a matter is decided. */
  "BUYER_PROTECTION_PENDING_REVIEW",
  /** Trading continued through another record while a decision stood. */
  "DECISION_EVASION",
  /** An operator suspended deliberately, outside the categories above. */
  "MANUAL_OPERATIONAL_SUSPENSION",
] as const;
export const SuspensionReasonCode = z.enum(SUSPENSION_REASON_CODES);
export type SuspensionReasonCode = z.infer<typeof SuspensionReasonCode>;

/**
 * Why a suspension was lifted. Separate from the imposition vocabulary for the
 * reason the restriction lift vocabulary is: "why we suspended" and "why we
 * stopped" are different questions.
 */
export const SUSPENSION_LIFT_REASON_CODES = [
  "REQUIREMENT_SATISFIED",
  "REMEDIATION_COMPLETED",
  "ELIGIBILITY_RESTORED",
  "LIFTED_ON_RECONSIDERATION",
  /** It should not have been imposed. Recorded plainly rather than as a cure. */
  "IMPOSED_IN_ERROR",
] as const;
export const SuspensionLiftReasonCode = z.enum(SUSPENSION_LIFT_REASON_CODES);
export type SuspensionLiftReasonCode = z.infer<typeof SuspensionLiftReasonCode>;

/** Two states and no delete, on `ParticipantRestriction`'s terms. */
export const SUSPENSION_STATUSES = ["ACTIVE", "LIFTED"] as const;
export const SuspensionStatus = z.enum(SUSPENSION_STATUSES);
export type SuspensionStatus = z.infer<typeof SuspensionStatus>;

/**
 * Words a mitigation code may never contain.
 *
 * Reused from Phase 1.13's reason vocabulary and applied to every vocabulary in
 * this phase. A restriction is a decision about standing in a marketplace; it is
 * not a finding, and the policy says so in terms.
 */
export const MITIGATION_CODE_FORBIDDEN_TERMS = [
  "FRAUD",
  "ABUSE",
  "SUSPICIOUS",
  "BAD_ACTOR",
  "CONFIRMED",
  "CRIMINAL",
  "SCAM",
  "DISHONEST",
] as const;

export const SuspendParticipantInput = z.strictObject({
  participantId: ParticipantId,
  reasonCode: SuspensionReasonCode,
  /** The acting internal account — authorization principal AND audit actor. */
  actingAccountId: AccountId,
  suspendedAt: z.iso.datetime(),
  /**
   * The Staff risk review this is imposed on the strength of, when there is one.
   *
   * OPTIONAL, and its absence is the emergency path: Staff may act before a
   * review is complete where waiting would expose buyers or Monacado to loss.
   * What emergency never waives is AUTHORIZATION — the same entitlement is
   * checked against persisted state either way, and the same self-action refusal
   * applies. It waives the prior-review prerequisite and nothing else.
   */
  riskReviewId: z.string().min(1).max(191).nullable().default(null),
});
export type SuspendParticipantInput = z.infer<typeof SuspendParticipantInput>;

export const ReinstateParticipantInput = z.strictObject({
  suspensionId: ParticipantSuspensionId,
  reasonCode: SuspensionLiftReasonCode,
  actingAccountId: AccountId,
  reinstatedAt: z.iso.datetime(),
});
export type ReinstateParticipantInput = z.infer<typeof ReinstateParticipantInput>;

/**
 * The statuses that mean **Monacado admitted this participant** (Phase 1.16).
 *
 * `ACTIVE` and `RESTRICTED` are the only two, and the pairing is the point:
 * 0M.1 §4.1 defines `RESTRICTED` as "admitted, some capability withheld pending
 * a cure", so it is an admitted participant wearing a mitigation overlay rather
 * than a separate standing. `SUSPENDED` is deliberately absent — admission has
 * been withdrawn — and every pre-review stage is absent because admission has
 * not yet been granted.
 *
 * Named so the reconciliation rules below can ask "was this participant ever
 * admitted" as a fact rather than by enumerating statuses at each call site.
 */
export const ADMITTED_PARTICIPANT_STATUSES = [
  "ACTIVE",
  "RESTRICTED",
] as const satisfies readonly ParticipantStatus[];

export function isAdmittedParticipantStatus(status: ParticipantStatus): boolean {
  return (ADMITTED_PARTICIPANT_STATUSES as readonly ParticipantStatus[]).includes(status);
}

/**
 * Where a participant returns to when a suspension is lifted.
 *
 * RECONCILES RATHER THAN ASSUMES. Restoring the status held before the
 * suspension would put a participant back at `ACTIVE` while restrictions still
 * stand against them — the exact divergence `restrictedStatusIsSupported` exists
 * to prevent, in the opposite direction. So standing restrictions win, and the
 * remembered status is used only when there are none.
 *
 * **ADMISSION IS A PRECONDITION, NOT A CONSEQUENCE (Phase 1.16).** Standing
 * restrictions may only produce `RESTRICTED` for a participant who was
 * ALREADY ADMITTED when the suspension landed. Without that clause this function
 * was the second step of a real escalation: a participant suspended while
 * `UNDER_REVIEW`, holding one restriction, was reinstated to `RESTRICTED` —
 * because the restriction count short-circuited before the remembered status was
 * consulted — and lifting that restriction then read `RESTRICTED` + 0 and moved
 * them to `ACTIVE`. A participant reached full admission through two mitigation
 * acts and no approved activation review.
 *
 * `participant-restriction.ts` guarantees that "a participant that never
 * activated cannot reach `ACTIVE` by this path", and it is right about its own
 * path. Phase 1.14 added a SECOND producer of `RESTRICTED` and did not carry the
 * guarantee across. This clause carries it across.
 *
 * `null` means the lifecycle table forbids the move and nothing should be
 * written; the suspension row is still lifted, and the status is left where a
 * later governed act can address it. Refusing to invent a transition is the same
 * discipline `reconcileParticipantStatusForRestrictions` follows.
 */
export function reinstatementTargetStatus(input: {
  currentStatus: ParticipantStatus;
  activeRestrictionCount: number;
  statusBeforeSuspension: ParticipantStatus;
}): ParticipantStatus | null {
  if (input.currentStatus !== "SUSPENDED") return null;

  /* Restrictions decide only for a participant who held admission. For anyone
     else the remembered stage is the whole answer, and their restrictions stand
     as evidence exactly as they did before the suspension. */
  const wasAdmitted = isAdmittedParticipantStatus(input.statusBeforeSuspension);
  const target =
    wasAdmitted && input.activeRestrictionCount > 0
      ? "RESTRICTED"
      : input.statusBeforeSuspension === "RESTRICTED"
        ? "ACTIVE"
        : input.statusBeforeSuspension;

  if (target === input.currentStatus) return null;
  if (!isValidParticipantTransition(input.currentStatus, target)) return null;
  return target;
}

/** A participant is never `SUSPENDED` without an active suspension record. */
export function suspendedStatusIsSupported(activeSuspensionCount: number): boolean {
  return activeSuspensionCount > 0;
}

// — Reconsideration —

/**
 * Why the participant says the decision should not stand. Bounded codes.
 *
 * `CIRCUMSTANCE_NOT_COVERED_BY_THESE_CODES` is the honest escape hatch, and its
 * cost is stated rather than hidden: a participant with a genuinely novel case
 * cannot describe it. Its one virtue is that it makes vocabulary inadequacy
 * COUNTABLE — if it dominates, the vocabulary is wrong, and the fix is a
 * reviewable extension rather than a text box nobody governs.
 */
export const RECONSIDERATION_GROUND_CODES = [
  "UNDERLYING_REQUIREMENT_NOW_SATISFIED",
  "PROVIDER_REQUIREMENT_RESOLVED",
  "ELIGIBILITY_CONDITION_NOW_MET",
  "DECISION_APPEARS_TO_CONCERN_A_DIFFERENT_PARTICIPANT",
  "SCOPE_APPEARS_BROADER_THAN_THE_STATED_REASON",
  "CIRCUMSTANCE_NOT_COVERED_BY_THESE_CODES",
] as const;
export const ReconsiderationGroundCode = z.enum(RECONSIDERATION_GROUND_CODES);
export type ReconsiderationGroundCode = z.infer<typeof ReconsiderationGroundCode>;

/**
 * What the participant asserts they have done about it.
 *
 * Modelled on the seller attestation claims 1.11 introduced for the same
 * problem: a participant still has to be able to say "I fixed it", and a
 * checklist of bounded claims says it without a text box.
 * `SUPPORTING_MATERIAL_HELD_OUTSIDE_MONACADO` is the direct analogue of that
 * phase's delivery-evidence claim — it records that material exists without
 * pretending this repository has anywhere to put it.
 */
export const RECONSIDERATION_REMEDIATION_CLAIM_CODES = [
  "CORRECTED_SUBMISSION_MADE",
  "SUPPORT_CONTACT_REVERIFIED",
  "PROVIDER_ONBOARDING_COMPLETED",
  "POLICY_REACCEPTED",
  "SUPPORTING_MATERIAL_HELD_OUTSIDE_MONACADO",
  "NO_REMEDIATION_CLAIMED",
] as const;
export const ReconsiderationRemediationClaimCode = z.enum(
  RECONSIDERATION_REMEDIATION_CLAIM_CODES,
);
export type ReconsiderationRemediationClaimCode = z.infer<
  typeof ReconsiderationRemediationClaimCode
>;

/** Forward-only; `DECIDED` is terminal. */
export const RECONSIDERATION_STATUSES = ["RECEIVED", "UNDER_REVIEW", "DECIDED"] as const;
export const ReconsiderationStatus = z.enum(RECONSIDERATION_STATUSES);
export type ReconsiderationStatus = z.infer<typeof ReconsiderationStatus>;

export const RECONSIDERATION_TRANSITIONS: Record<
  ReconsiderationStatus,
  readonly ReconsiderationStatus[]
> = {
  RECEIVED: ["UNDER_REVIEW", "DECIDED"],
  UNDER_REVIEW: ["DECIDED"],
  DECIDED: [],
};

export function isValidReconsiderationTransition(
  from: ReconsiderationStatus,
  to: ReconsiderationStatus,
): boolean {
  return RECONSIDERATION_TRANSITIONS[from].includes(to);
}

/**
 * The bounded outcome. Every member is honest about what it performs.
 *
 * There is no `ESCALATED`, no `REFERRED`, and no `EXTERNAL_REVIEW`: nothing
 * outside Monacado exists to escalate to, and a vocabulary member promising one
 * would be the policy over-claiming through the back door.
 */
export const RECONSIDERATION_DETERMINATIONS = [
  "UPHELD",
  "DECISION_LIFTED_ON_RECONSIDERATION",
  "REMEDIATION_REQUIRED_BEFORE_FURTHER_RECONSIDERATION",
  "WITHDRAWN_BY_PARTICIPANT",
  "SUPERSEDED_DECISION_ALREADY_LIFTED",
] as const;
export const ReconsiderationDetermination = z.enum(RECONSIDERATION_DETERMINATIONS);
export type ReconsiderationDetermination = z.infer<typeof ReconsiderationDetermination>;

export const RequestReconsiderationInput = z
  .strictObject({
    participantId: ParticipantId,
    /** EXACTLY ONE of these. Which decision is being contested has one answer. */
    restrictionId: z.string().min(1).max(191).nullable().default(null),
    suspensionId: ParticipantSuspensionId.nullable().default(null),
    requestedByAccountId: AccountId,
    requestedAt: z.iso.datetime(),
    groundCode: ReconsiderationGroundCode,
    remediationClaimCode: ReconsiderationRemediationClaimCode.nullable().default(null),
  })
  .refine(
    (r) => (r.restrictionId === null) !== (r.suspensionId === null),
    "a reconsideration contests exactly one decision",
  );
export type RequestReconsiderationInput = z.infer<typeof RequestReconsiderationInput>;

export const DecideReconsiderationInput = z.strictObject({
  reconsiderationId: ParticipantReconsiderationId,
  determinationCode: ReconsiderationDetermination,
  actingAccountId: AccountId,
  decidedAt: z.iso.datetime(),
});
export type DecideReconsiderationInput = z.infer<typeof DecideReconsiderationInput>;

// — Notice —

/**
 * What a participant is told, and what they are never told.
 *
 * A notice states MONACADO'S DECISION AND ITS BOUNDED REASON CATEGORY. It never
 * states the observation, threshold, rate, ranking, or review policy behind it —
 * which is not new policy but 1.2.0's own standing term, extended from a
 * transaction to a participant: "The classifications and the evidence behind such
 * a decision are private operational records."
 */
export const PARTICIPANT_NOTICE_DISCLOSABLE_FIELDS = [
  "decisionKind",
  "scope",
  "reasonCode",
  "effectiveAt",
  "reconsiderationAvailable",
] as const;

/**
 * Named as never admissible in a notice to a participant. A test walks the list.
 *
 * The first group is the analysis, which stays private. The second is other
 * people's data — a notice about one participant must never carry a buyer, an
 * order, or a provider's words. The third is prose, for the reason every record
 * near participants and money already refuses it.
 */
export const NEVER_IN_PARTICIPANT_NOTICE = [
  "riskScore",
  "reviewScore",
  "reviewRank",
  "refundRateBasisPoints",
  "chargebackRateBasisPoints",
  "thresholdBasisPoints",
  "reviewPolicyVersion",
  "triggerReasonCode",
  "observedValue",
  "baselineValue",
  "buyerName",
  "buyerEmail",
  "orderId",
  "disputeId",
  "providerMessage",
  "networkReasonCode",
  "note",
  "internalNote",
  "freeTextReason",
] as const;

/**
 * Named as never admissible on any mitigation record in this phase.
 *
 * The first group would make an analytics number the standing justification for
 * withholding somebody's livelihood. The second is enforcement automation this
 * phase refuses to build. The third is prose and other people's data.
 */
export const NEVER_ON_PARTICIPANT_MITIGATION = [
  "riskScore",
  "fraudScore",
  "riskTier",
  "riskClassification",
  "modelVersion",
  "autoSuspendAt",
  "autoRestrictAt",
  "scoreThreshold",
  "expiresAt",
  "autoLiftAt",
  "note",
  "internalNote",
  "investigatorNote",
  "freeTextReason",
  "staffRationale",
  "buyerName",
  "buyerEmail",
  "ipAddress",
  "documentUrl",
  "providerMessage",
] as const;

/**
 * What this phase does about publication: **nothing**.
 *
 * Stated as a value so the claim is checkable, on
 * `SELLER_RISK_PUBLICATION_DISPOSITION`'s terms. A restriction is more sensitive
 * than the analytics that may have prompted it: publishing that a participant is
 * restricted would be a statement about them made to people who are not party to
 * the decision, and the policy says in terms that Monacado does not make it.
 *
 * A storefront or listing may cease to be publicly available as a CONSEQUENCE of
 * a decision. That is the existing eligibility machinery doing its job, it
 * reports one coarse reason, and an absence is not a statement.
 */
export const PARTICIPANT_MITIGATION_PUBLICATION_DISPOSITION = {
  capsuleProjection: "NONE",
  visibility: "PRIVATE",
  agentNetPublication: "NONE",
  nodeRegistration: "NONE",
  registrarContact: "NONE",
  publicResolverExposure: "NONE",
  outboxRow: "NONE",
} as const;

/**
 * What suspension does NOT do, stated as a value because the policy states it as
 * a promise and a promise nothing checks is a promise nobody keeps.
 *
 * A suspension changes what a participant may do next. It is not a deletion, a
 * closure, or a release from anything already owed.
 */
export const SUSPENSION_PRESERVES = [
  "PARTICIPANT_IDENTITY",
  "MARKETPLACE_ROLES",
  "COMPLETED_ORDERS",
  "PURCHASE_RECEIPTS",
  "DIGITAL_ENTITLEMENTS",
  "BUYER_REFUND_RIGHTS",
  "DISPUTE_OBLIGATIONS",
  "TAX_RECORDS",
  "PROCEEDS_ACCOUNTING",
  "AUDIT_EVIDENCE",
] as const;

/** Named so a test can assert the set rather than infer it. */
export const PARTICIPANT_STATUSES_REQUIRING_EVIDENCE = [
  "RESTRICTED",
  "SUSPENDED",
] as const satisfies readonly (typeof PARTICIPANT_STATUSES)[number][];
