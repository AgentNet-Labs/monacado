/**
 * Participant closure — the terminal lifecycle act (Phase 1.17).
 *
 * ## Whose act this is
 *
 * **Closure is the participant's own decision to stop, and it is nobody
 * else's.** That is not a ruling this phase invents; it is the one the
 * repository has stated three times and never implemented:
 *
 *   - `participant-record.ts` admitted `CLOSED` to the draft-writable set
 *     because "it is the participant giving up, not Monacado ruling";
 *   - `activation-review.ts` refuses to produce `CLOSED` from a `REJECTED`
 *     activation because "inventing a closure on Monacado's behalf would end an
 *     admission the participant may legitimately resubmit";
 *   - `participant-mitigation.ts` names closure as categorically *not* a
 *     suspension: "It is not a deletion, a closure, or a release from anything
 *     already owed."
 *
 * So there is no Staff closure here, and no `participant:close` entitlement. An
 * internal grant would be an authority strictly wider than `participant:suspend`
 * — irreversible where suspension is reversible — and Marketplace Policy 1.3.0
 * nowhere gives Monacado the power to end a participant's participation. Minting
 * one would be this phase writing a term the policy does not carry, which is the
 * inverse of the rule that document holds itself to.
 *
 * **Authorization is therefore ownership, not entitlement.** The acting account
 * must BE the participant's account, checked against the persisted
 * `MarketplaceParticipant.accountId` — which is `@unique`, so it is the
 * repository's existing one-account-one-participant relation rather than a
 * second notion of ownership. This is verbatim the check
 * `requestReconsideration` already makes for the participant's own act.
 *
 * ## What closure is not
 *
 * Not a deletion, not a rejection, not a mitigation act, and not an
 * exoneration. It withdraws the participant from FUTURE marketplace activity and
 * touches nothing already owed, in either direction — see `CLOSURE_PRESERVES`.
 *
 * In particular, **closing does not lift a restriction or reinstate a
 * suspension.** A standing decision stays standing, because a participant
 * leaving is not Monacado deciding it was wrong; see the note on
 * `CLOSURE_LEAVES_MITIGATION_STANDING`.
 *
 * Pure. No clock, no persistence, no side effects.
 */

import { z } from "zod";
import { AccountId } from "../account/account";
import { MARKETPLACE_PARTICIPANT_ID_RE, PARTICIPANT_CLOSURE_ID_RE } from "./identity";
import type { ParticipantStatus } from "./participant";

const ParticipantId = z
  .string()
  .regex(MARKETPLACE_PARTICIPANT_ID_RE, "must be mon:mpart:<opaque>");

export const ParticipantClosureId = z
  .string()
  .regex(PARTICIPANT_CLOSURE_ID_RE, "must be mon:pcls:<opaque>");
export type ParticipantClosureId = z.infer<typeof ParticipantClosureId>;

// — Reason —

/**
 * Why the participant is closing. Bounded codes, on the vocabulary discipline
 * every other participant record here follows.
 *
 * These are **the participant's own account of their own decision**, which makes
 * them a different kind of value from a restriction or suspension reason: those
 * classify a problem Monacado found, and are written by Monacado. Nothing here
 * classifies the participant, alleges anything, or records a Monacado
 * conclusion — there is no member meaning "closed ahead of enforcement" and
 * there must never be one, because that would be Monacado's characterisation
 * wearing the participant's voice.
 *
 * `REASON_NOT_COVERED_BY_THESE_CODES` is the honest escape hatch, on
 * `CIRCUMSTANCE_NOT_COVERED_BY_THESE_CODES`'s precedent and for its stated
 * reason: a participant with a genuinely novel reason cannot describe it, and
 * the one virtue of the omission is that it makes vocabulary inadequacy
 * COUNTABLE rather than hiding it in a text box nobody governs.
 */
export const PARTICIPANT_CLOSURE_REASON_CODES = [
  /** No longer selling or promoting through Monacado. */
  "NO_LONGER_TRADING_ON_MONACADO",
  /** The participant is trading elsewhere instead. */
  "TRADING_ELSEWHERE",
  /** The account was created and never used for its purpose. */
  "ACCOUNT_NO_LONGER_NEEDED",
  /** The business or activity behind the participant has ended. */
  "BUSINESS_ACTIVITY_ENDED",
  /** The participant does not accept a policy version and elects to stop. */
  "DOES_NOT_ACCEPT_CURRENT_POLICY",
  /** Bounded inadequacy, recorded rather than hidden. */
  "REASON_NOT_COVERED_BY_THESE_CODES",
] as const;
export const ParticipantClosureReasonCode = z.enum(PARTICIPANT_CLOSURE_REASON_CODES);
export type ParticipantClosureReasonCode = z.infer<typeof ParticipantClosureReasonCode>;

// — Input —

export const CloseParticipantInput = z.strictObject({
  participantId: ParticipantId,
  /**
   * The acting account — authorization principal AND audit actor, one value.
   *
   * 0M.8's settled rule, and the reason it is settled: two supplied identities,
   * one to authorize against and one to write into the audit row, could
   * disagree, and the record would then name someone other than whoever was
   * actually checked. Here it must equal the participant's own `accountId`.
   */
  actingAccountId: AccountId,
  reasonCode: ParticipantClosureReasonCode,
  closedAt: z.iso.datetime(),
});
export type CloseParticipantInput = z.infer<typeof CloseParticipantInput>;

// — Terminality —

/**
 * The statuses from which a participant may close.
 *
 * Every status except `CLOSED` itself, which is the 0M.1 table's own answer
 * (`CLOSED: []`) restated where the closure service can assert it. Derived
 * rather than listed, so a status added to the vocabulary is covered without
 * anybody remembering to come back here.
 */
export function permitsClosure(status: ParticipantStatus): boolean {
  return status !== "CLOSED";
}

/**
 * Terminal participant lifecycle, as a predicate.
 *
 * One member today. It exists as a named function rather than an inline
 * `=== "CLOSED"` because the seams that must refuse a terminated participant are
 * asking about TERMINALITY, not about one status value, and a second terminal
 * status would otherwise have to find every one of them.
 */
export function isTerminalParticipantStatus(status: ParticipantStatus): boolean {
  return status === "CLOSED";
}

// — Values that make the promises checkable —

/**
 * What closure does NOT do, stated as a value because the policy states it as a
 * promise and a promise nothing checks is a promise nobody keeps.
 *
 * `SUSPENSION_PRESERVES`'s list, and it is deliberately the SAME list rather
 * than a shorter one. Closure is heavier than suspension in what it withdraws
 * and exactly as light in what it discharges: Monacado remains merchant of
 * record for every completed purchase, and a participant who leaves is owed what
 * their completed sales earned just as before. Nothing here is released by
 * anybody stopping.
 */
export const CLOSURE_PRESERVES = [
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
  "ACCEPTED_POLICY_VERSIONS",
] as const;

/**
 * What closure does to a standing restriction or suspension: **nothing.**
 *
 * Stated as a value because the tempting alternative is silent and wrong. A
 * closure that marked mitigation `LIFTED` would have to pick a lift reason from
 * a vocabulary in which every member is a false statement about a closure —
 * `REQUIREMENT_SATISFIED`, `ELIGIBILITY_RESTORED`, `IMPOSED_IN_ERROR` — and
 * would have to name an account as having lifted it when nobody did. The record
 * would then read as though Monacado had resolved the matter, and the
 * participant's departure would have laundered a decision that still stood.
 *
 * So the rows keep `status: "ACTIVE"`, which is the true statement: **the
 * decision stood when participation ended and was never withdrawn.** Its
 * operational reach is nil, not because the row changed but because the
 * participant's lifecycle is terminal — applicability is
 * `terminal ? none : row-state`, computed at the seam and never stored.
 */
export const CLOSURE_LEAVES_MITIGATION_STANDING = {
  restrictionRows: "UNCHANGED",
  suspensionRows: "UNCHANGED",
  pendingReconsiderations: "DECIDABLE",
  liftPerformed: "NONE",
  reinstatementPerformed: "NONE",
} as const;

/**
 * Columns that must never appear on a closure record.
 *
 * `NEVER_ON_PARTICIPANT_MITIGATION`'s discipline, plus the two failure modes
 * specific to this record: a free-text exit reason, and any Monacado
 * characterisation of a departure. A participant's own bounded reason is the
 * whole of what is stored.
 */
export const NEVER_ON_PARTICIPANT_CLOSURE = [
  "riskScore",
  "riskTier",
  "riskClassification",
  "note",
  "internalNote",
  "staffRationale",
  "freeTextReason",
  "closureNarrative",
  "monacadoAssessment",
  "reopenAt",
  "autoReopenAt",
] as const;

/**
 * What this phase publishes about a closure: **nothing.**
 *
 * `PARTICIPANT_MITIGATION_PUBLICATION_DISPOSITION`'s terms. That a participant
 * left is a fact about them, and Monacado does not announce it. Their storefront
 * or listings may cease to be reachable as a CONSEQUENCE, which is the existing
 * eligibility machinery doing its job; an absence is not a statement.
 */
export const PARTICIPANT_CLOSURE_PUBLICATION_DISPOSITION = {
  capsuleProjection: "NONE",
  visibility: "PRIVATE",
  agentNetPublication: "NONE",
  nodeRegistration: "NONE",
  registrarContact: "NONE",
  publicResolverExposure: "NONE",
  outboxRow: "NONE",
} as const;
