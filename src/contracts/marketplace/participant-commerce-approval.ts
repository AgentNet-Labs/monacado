/**
 * Governed participant commerce approval (Phase 0M.9).
 *
 * Monacado's **determination that a participant may transact** — the go-live
 * approval `0M.3A` defined and deliberately refused to store as a Storefront
 * fact:
 *
 * > It is **supplied to decisions and derived by nothing here.** It is not a
 * > Storefront source field, is never public, and is never projection-eligible:
 * > it is Monacado's opinion about a participant, not a fact about a shop.
 *
 * That ruling stands, and this record honours it: the decision is recorded
 * **against the participant it is about**, never as a column on the thing being
 * approved. What `0M.3A` left open was *where the supplied value comes from*, and
 * before `0M.9` the answer was "a caller". That was tolerable while nothing could
 * be bought. It is not tolerable now that a Listing being buyer-active means real
 * money moves, so the value now comes from here.
 *
 * Six properties shape everything below:
 *
 *   1. **Absence means NOT_APPROVED.** No record is the default, and the default
 *      is the safe one — nothing needs seeding, no migration grants anyone
 *      clearance, and a participant nobody has considered cannot sell.
 *
 *   2. **A caller cannot assert it.** There is no input anywhere that carries an
 *      approval status into an eligibility decision. The only way a participant
 *      becomes approved is a governed act by an internally entitled account.
 *
 *   3. **The vocabulary is `0M.3A`'s own.** `APPROVED` / `NOT_APPROVED` are the
 *      committed `GO_LIVE_APPROVAL_STATUSES`, reused rather than restated, so the
 *      stored decision and the value `isPubliclyAccessible` consumes can never
 *      come to mean different things.
 *
 *   4. **History is never rewritten.** A new decision supersedes the previous one
 *      and is a new row. Withdrawing approval does not edit the grant that stood;
 *      it records a withdrawal, with its own instant, actor, and reason.
 *
 *   5. **Exactly one decision is current per participant**, enforced by a unique
 *      index rather than by a service remembering — the same NULL-able marker
 *      technique `ParticipantActivation.undecidedForParticipantId` uses, because
 *      MySQL has no partial indexes.
 *
 *   6. **Reason-bounded, never free text.** A reason code is a classification. No
 *      profile content, provider message, underwriting note, or operator comment
 *      has a field here.
 *
 * **This is not a risk engine.** No score, reserve, cap, velocity window, hold,
 * or transaction reference is read or written — `0M.R2` owns all of it.
 *
 * Pure data and pure decisions. No database, clock, environment read,
 * randomness, or network. Not exported through the browser-facing barrel.
 */

import { z } from "zod";
import { AccountId } from "../account/account";
import {
  MARKETPLACE_PARTICIPANT_ID_RE,
  PARTICIPANT_COMMERCE_APPROVAL_ID_RE,
} from "./identity";
import { StorefrontGoLiveApprovalStatus } from "./storefront-source";

// — Identity —

export const ParticipantCommerceApprovalId = z
  .string()
  .regex(PARTICIPANT_COMMERCE_APPROVAL_ID_RE, "approvalId must be mon:pcap:<opaque>");
export type ParticipantCommerceApprovalId = z.infer<typeof ParticipantCommerceApprovalId>;

const ParticipantRef = z
  .string()
  .regex(MARKETPLACE_PARTICIPANT_ID_RE, "participantId must be mon:mpart:<opaque>");

// — Decision —

/**
 * The decision itself, in `0M.3A`'s committed vocabulary.
 *
 * Reused rather than restated. A second enum with the same two members would be
 * two things to keep in agreement, and the first disagreement would be a
 * participant who was approved in one vocabulary and not the other.
 */
export const CommerceApprovalDecision = StorefrontGoLiveApprovalStatus;
export type CommerceApprovalDecision = z.infer<typeof CommerceApprovalDecision>;

/**
 * The default when no governed decision exists.
 *
 * **Absence is not silence, it is a refusal.** A participant nobody has assessed
 * has not been cleared, and the alternative — treating an empty table as consent
 * — is the failure mode this whole record exists to remove.
 */
export const DEFAULT_COMMERCE_APPROVAL: CommerceApprovalDecision = "NOT_APPROVED";

/**
 * Why the decision went the way it did.
 *
 * A closed vocabulary, safe to render, and deliberately small. It carries no
 * provider message, no underwriting detail, no profile content, and no free text
 * — the same rule `0M.R1` applies to a restriction's reason, and for the same
 * reason: a field that could hold a sentence becomes the field where private
 * detail accumulates.
 */
export const COMMERCE_APPROVAL_REASON_CODES = [
  // — Approving —
  /** Every go-live requirement Monacado assessed was met. */
  "REQUIREMENTS_MET",

  // — Refusing or withdrawing —
  /** Onboarding or verification requirements are still outstanding. */
  "REQUIREMENTS_OUTSTANDING",
  /** The participant's payment readiness does not permit taking money. */
  "PAYMENT_NOT_ENABLED",
  /** A governed policy concern Monacado has recorded elsewhere. */
  "POLICY_CONCERN",
  /** Monacado withdrew a clearance that previously stood. */
  "WITHDRAWN_BY_MONACADO",
] as const;
export const CommerceApprovalReasonCode = z.enum(COMMERCE_APPROVAL_REASON_CODES);
export type CommerceApprovalReasonCode = z.infer<typeof CommerceApprovalReasonCode>;

// — Record —

/**
 * One governed commerce-approval decision.
 *
 * Note what has no field: a risk score, a reserve, a cap, a velocity window, a
 * payout hold, a provider message, an underwriting document, a profile value, or
 * an expiry. The first five are `0M.R2`; the rest are private operational data
 * that a governance record has no reason to carry.
 *
 * There is deliberately **no `storefrontId`**. The decision is about a
 * participant, and attaching it to a storefront would put the approver's
 * judgement inside the approved thing — precisely what `0M.3A` refused.
 */
export const ParticipantCommerceApprovalRecord = z.strictObject({
  approvalId: ParticipantCommerceApprovalId,
  participantId: ParticipantRef,

  decision: CommerceApprovalDecision,
  reasonCode: CommerceApprovalReasonCode,

  /** When Monacado decided. Supplied, never a clock read. */
  decidedAt: z.iso.datetime(),
  /**
   * Who decided, as the durable internal Account identity.
   *
   * `0M.8`'s settled actor rule: the identity written here is the **same one**
   * `participant:commerce-approve` was evaluated against, so the audit actor is
   * by construction the authorized one. Two separate identities could disagree,
   * and this row would then name someone who was never checked.
   */
  decidedByAccountId: AccountId,

  /** Set when a later decision supersedes this one. `null` while it stands. */
  supersededAt: z.iso.datetime().nullable(),

  createdAt: z.iso.datetime(),
});
export type ParticipantCommerceApprovalRecord = z.infer<
  typeof ParticipantCommerceApprovalRecord
>;

/** A decision that has not been superseded is the one in force. */
export function isCurrentCommerceApproval(
  record: Pick<ParticipantCommerceApprovalRecord, "supersededAt">,
): boolean {
  return record.supersededAt === null;
}

/**
 * The approval status in force, given the current decision or its absence.
 *
 * **The single place absence is interpreted**, so "no record means NOT_APPROVED"
 * is one decision made once rather than a `?? "NOT_APPROVED"` repeated at every
 * call site, where one omission would silently clear somebody to sell.
 */
export function effectiveCommerceApproval(
  current: Pick<ParticipantCommerceApprovalRecord, "decision"> | null,
): CommerceApprovalDecision {
  return current === null ? DEFAULT_COMMERCE_APPROVAL : current.decision;
}

// — Inputs —

/**
 * Record one governed commerce decision.
 *
 * The same input approves and withdraws: both are governed decisions with an
 * actor, an instant, and a reason, and a separate "withdraw" operation would
 * invite one of them to be recorded less carefully than the other.
 *
 * There is **no `actingActorId`** distinct from the account: `0M.8` settled that
 * the account id *is* the actor id for a decision an account makes, and writing
 * anything else would decouple the audit trail from the authorization check.
 */
export const RecordCommerceApprovalInput = z.strictObject({
  participantId: ParticipantRef,
  decision: CommerceApprovalDecision,
  reasonCode: CommerceApprovalReasonCode,
  /** The internal account making the decision. Its entitlement is checked. */
  actingAccountId: AccountId,
  decidedAt: z.iso.datetime(),
});
export type RecordCommerceApprovalInput = z.infer<typeof RecordCommerceApprovalInput>;

// — Never on a commerce approval —

/**
 * Named as never-persistable, and not admissible through the input above.
 *
 * The first group is **`0M.R2`** — risk machinery this phase must not start. The
 * second is **private operational data** a governance record has no reason to
 * hold. The third is **the 0M.3A boundary**: a storefront reference here would
 * make the decision a fact about a shop rather than about a participant.
 */
export const NEVER_ON_COMMERCE_APPROVAL = [
  // risk machinery — 0M.R2
  "riskScore",
  "riskClassification",
  "reserveAmountMinorUnits",
  "transactionCapMinorUnits",
  "velocityWindow",
  "payoutHold",
  // private operational data
  "providerMessage",
  "underwritingNote",
  "kycPayload",
  "documentUrl",
  "legalName",
  "taxIdentifier",
  "note",
  // the 0M.3A boundary
  "storefrontId",
  "internalStorefrontId",
] as const;
