/**
 * Internal operational authorization decisions (Phase 0M.8).
 *
 * The counterpart to `marketplace/capability.ts`, kept deliberately apart from
 * it. That module answers "may this **participant** do this marketplace thing";
 * this one answers "may this **internal Monacado account** perform this
 * operational act". Two questions, two subjects, two closed vocabularies.
 *
 * Five properties shape everything below:
 *
 *   1. **Authority comes from a persisted entitlement, never from an
 *      assertion.** The subject carries the capabilities a caller *resolved from
 *      the database*, and the resolver is the only thing that can put one there.
 *      There is no parameter through which a caller declares itself authorized.
 *
 *   2. **The subject has no marketplace shape at all.** No role, no participant,
 *      no ownership, no storefront, no offer. Marketplace roles cannot confer an
 *      internal capability here because there is nowhere to put one — structural,
 *      not a convention, and the same reasoning that keeps private profile data
 *      out of `toMarketplaceSubject`.
 *
 *   3. **Decisions are bounded, never booleans.** `ALLOW`/`DENY` with a closed
 *      set of reason codes, matching `CapabilityDecision`. A stub returning
 *      `undefined` cannot be mistaken for consent by a truthiness check.
 *
 *   4. **Reason codes are classifications, never values.** No email, account id,
 *      capability grant record, or free text appears in one.
 *
 *   5. **No I/O.** No database, clock, environment read, randomness, or network.
 *      Every fact a decision needs is in its argument; resolving those facts is
 *      the server-side resolver's job.
 *
 * Pure. Not exported through the browser-facing contracts barrel.
 */

import { z } from "zod";
import { ACCOUNT_CAPABILITIES, AccountCapability, AccountId, AccountStatus } from "./account";

/**
 * The capability that authorizes the governed participant-activation decision.
 *
 * Named once, here, so the string appears in the service, the tests, and the
 * documentation by reference rather than by repetition.
 */
export const ACTIVATION_REVIEW_CAPABILITY = "activation:review" as const satisfies AccountCapability;

/**
 * The capability that authorizes imposing or lifting a governed participant
 * restriction (Phase 0M.R1).
 *
 * **Separate from `activation:review`, not folded into it.** A restriction
 * reaches capabilities an activation review never touches — taking a storefront
 * live, publishing an Offer, receiving a payout, accruing commission, submitting
 * reviews — so reusing the review grant would silently widen the authority of
 * someone approved to decide one admission. Narrow by construction: not `admin`,
 * not `risk:*`, not a wildcard.
 */
export const PARTICIPANT_RESTRICT_CAPABILITY =
  "participant:restrict" as const satisfies AccountCapability;

/**
 * The capability that authorizes Monacado's governed **commerce approval** — the
 * determination that a participant may transact (Phase 0M.9).
 *
 * **A third independent grant, deliberately neither of the other two.**
 *
 *   - Not `activation:review`. That authorizes deciding one *admission*: whether
 *     a participant is admitted to the marketplace at all. A participant may be
 *     admitted and still not cleared to take money — 0M.3A calls go-live approval
 *     "Monacado's resolved determination that a Storefront satisfies every
 *     go-live requirement", which is a later and different question. Folding the
 *     two would mean everyone who could admit a participant could also clear them
 *     to sell.
 *   - Not `participant:restrict`. That authorizes **withholding** a capability
 *     from someone who already has it. This authorizes **granting** the clearance
 *     in the first place. They point in opposite directions, and "may take
 *     commerce away" is not "may hand commerce out" — reusing the restrict grant
 *     would widen it into exactly the authority nobody scoped.
 *
 * Narrow by construction: not `admin`, not `commerce:*`, not a wildcard.
 */
/**
 * The capability that authorizes reading seller risk analytics and recording a
 * Staff risk-review disposition (Phase 1.13).
 *
 * **Separate from `participant:restrict`, and the separation is the safeguard.**
 * A risk reviewer inspects metrics and records a conclusion — including, at the
 * far end, `SUSPENSION_RECOMMENDED`. Imposing anything on a participant remains
 * a different act under a different grant, checked independently. Folding the
 * two together would make recording a recommendation indistinguishable from
 * having the power to carry it out, and a review that can execute its own
 * finding is not a review.
 *
 * Narrow by construction: not `admin`, not `risk:*`, not a wildcard.
 */
export const PARTICIPANT_RISK_REVIEW_CAPABILITY =
  "participant:risk-review" as const satisfies AccountCapability;

export const PARTICIPANT_COMMERCE_APPROVE_CAPABILITY =
  "participant:commerce-approve" as const satisfies AccountCapability;

// — Reason codes —

export const INTERNAL_AUTHORIZATION_REASON_CODES = [
  /** No authenticated internal account was supplied. */
  "INTERNAL_ACCOUNT_REQUIRED",
  /** The account exists but is DISABLED at the identity level. */
  "INTERNAL_ACCOUNT_DISABLED",
  /** No active entitlement grants the required internal capability. */
  "INTERNAL_CAPABILITY_NOT_GRANTED",
] as const;
export const InternalAuthorizationReasonCode = z.enum(INTERNAL_AUTHORIZATION_REASON_CODES);
export type InternalAuthorizationReasonCode = z.infer<typeof InternalAuthorizationReasonCode>;

// — Subject —

/**
 * Everything an internal authorization decision may consider.
 *
 * An allow-list of three fields, and the omissions are the point. There is no
 * field for a marketplace role, a participant id, a storefront, an ownership
 * relation, an email, a display name, or a session — so no decision below can
 * come to depend on one, and "this account owns the participant" is not a fact
 * this function is capable of learning.
 *
 * `capabilities` must be the **active persisted** set. The server-side resolver
 * reads `AccountEntitlement` on every evaluation, never a token claim and never
 * a cache, so a revocation fails closed on the very next call.
 */
export const InternalAuthorizationSubject = z.strictObject({
  accountId: AccountId,
  /** Identity-level status only — ACTIVE or DISABLED. Never marketplace state. */
  accountStatus: AccountStatus,
  capabilities: z.array(AccountCapability).max(ACCOUNT_CAPABILITIES.length),
});
export type InternalAuthorizationSubject = z.infer<typeof InternalAuthorizationSubject>;

// — Decision —

export const InternalAuthorizationDecision = z
  .strictObject({
    /** Which internal capability was being decided. Always reported. */
    capability: AccountCapability,
    decision: z.enum(["ALLOW", "DENY"]),
    reasonCodes: z
      .array(InternalAuthorizationReasonCode)
      .max(INTERNAL_AUTHORIZATION_REASON_CODES.length),
  })
  .refine(
    (d) => (d.decision === "ALLOW" ? d.reasonCodes.length === 0 : d.reasonCodes.length > 0),
    "ALLOW carries no reason codes; DENY carries at least one",
  );
export type InternalAuthorizationDecision = z.infer<typeof InternalAuthorizationDecision>;

function evaluateInternalCapability(
  capability: AccountCapability,
  subject: InternalAuthorizationSubject | null,
): InternalAuthorizationDecision {
  if (subject === null) {
    return { capability, decision: "DENY", reasonCodes: ["INTERNAL_ACCOUNT_REQUIRED"] };
  }
  const parsed = InternalAuthorizationSubject.parse(subject);

  if (parsed.accountStatus !== "ACTIVE") {
    return { capability, decision: "DENY", reasonCodes: ["INTERNAL_ACCOUNT_DISABLED"] };
  }
  if (!parsed.capabilities.includes(capability)) {
    return { capability, decision: "DENY", reasonCodes: ["INTERNAL_CAPABILITY_NOT_GRANTED"] };
  }
  return { capability, decision: "ALLOW", reasonCodes: [] };
}

/**
 * May this internal account make the governed participant-activation decision?
 *
 * **Requires an explicit active `activation:review` entitlement.** Nothing else
 * grants it:
 *
 *   - not holding SELLER, PROMOTER, or BUYER — those are marketplace roles, and
 *     this function has no parameter that could carry one;
 *   - not owning the participant under review, nor owning the account that owns
 *     it — ownership is likewise not a field here;
 *   - not `publication-worker:status:read`, which answers an unrelated question;
 *   - not merely being authenticated. A session proves who is asking, never what
 *     they may decide (0M.1 §3.1).
 *
 * One human may legitimately hold both a marketplace participant identity and
 * this entitlement. The entitlement is still granted explicitly and checked
 * independently — the two identities never imply each other in either direction.
 */
export function canReviewParticipantActivation(
  subject: InternalAuthorizationSubject | null,
): InternalAuthorizationDecision {
  return evaluateInternalCapability(ACTIVATION_REVIEW_CAPABILITY, subject);
}

/**
 * May this internal account impose or lift a governed participant restriction?
 *
 * Requires an explicit active `participant:restrict` entitlement, on exactly the
 * terms `canReviewParticipantActivation` requires its own. **Holding
 * `activation:review` is not enough** — the two are independent grants, and a
 * reviewer of admissions is not automatically a restrictor of commerce.
 *
 * Marketplace roles, participant ownership, and account ownership confer nothing
 * here either, and could not: the subject has no field capable of carrying one.
 */
export function canRestrictParticipant(
  subject: InternalAuthorizationSubject | null,
): InternalAuthorizationDecision {
  return evaluateInternalCapability(PARTICIPANT_RESTRICT_CAPABILITY, subject);
}

/**
 * May this internal account record Monacado's governed commerce approval?
 *
 * Requires an explicit active `participant:commerce-approve` entitlement, on
 * exactly the terms the two decisions above require their own. **Holding
 * `activation:review` or `participant:restrict` is not enough** — all three are
 * independent grants, and the subject has no field capable of carrying a
 * marketplace role, a participant, or an ownership relation, so none of those can
 * confer it either.
 *
 * This is the authority behind the one determination that makes a Listing
 * sellable. It is checked against persisted entitlement state on every call, so a
 * revocation fails closed on the very next decision.
 */
export function canApproveParticipantCommerce(
  subject: InternalAuthorizationSubject | null,
): InternalAuthorizationDecision {
  return evaluateInternalCapability(PARTICIPANT_COMMERCE_APPROVE_CAPABILITY, subject);
}

/**
 * May this internal account read seller risk analytics and record a Staff
 * risk-review disposition?
 *
 * Requires an explicit active `participant:risk-review` entitlement, on exactly
 * the terms the three decisions above require their own. **Holding
 * `participant:restrict` is not enough, and neither is this enough to restrict.**
 * The two are independent grants in both directions, which is what keeps a
 * recorded `SUSPENSION_RECOMMENDED` a recommendation: the reviewer who wrote it
 * cannot also impose it without a second, separately-granted authority being
 * checked against persisted state.
 */
/**
 * The capability that authorizes suspending a participant and reinstating them
 * (Phase 1.14).
 *
 * **Separate from `participant:restrict`, and strictly wider.** A restriction
 * withholds one named commercial capability and may never reach drafting or
 * `activation:submit`, because a participant has to be able to answer it. A
 * suspension withholds those as well. Folding the two together would widen every
 * existing restrictor's authority to include removing somebody's ability to
 * respond — a change nobody scoped.
 *
 * **Separate from `participant:risk-review` in both directions.** The reviewer
 * who records `SUSPENSION_RECOMMENDED` still cannot carry it out, which is what
 * keeps a recommendation a recommendation.
 *
 * It authorizes the undo as well as the act, on `participant:restrict`'s
 * precedent: an authority that can suspend but not reinstate would leave an
 * adverse action nobody can reverse.
 */
export const PARTICIPANT_SUSPEND_CAPABILITY =
  "participant:suspend" as const satisfies AccountCapability;

/**
 * May this internal account suspend a participant, or reinstate a suspended one?
 *
 * Requires an explicit active `participant:suspend` entitlement, on exactly the
 * terms every decision above requires its own. **Holding `participant:restrict`
 * is not enough, and neither is `participant:risk-review`** — all three are
 * independent grants, and the subject has no field capable of carrying a
 * marketplace role, a participant, or an ownership relation, so none of those can
 * confer it either.
 */
export function canSuspendParticipant(
  subject: InternalAuthorizationSubject | null,
): InternalAuthorizationDecision {
  return evaluateInternalCapability(PARTICIPANT_SUSPEND_CAPABILITY, subject);
}

export function canReviewParticipantRisk(
  subject: InternalAuthorizationSubject | null,
): InternalAuthorizationDecision {
  return evaluateInternalCapability(PARTICIPANT_RISK_REVIEW_CAPABILITY, subject);
}

/** May this internal account read publication-worker operational health? */
export function canReadPublicationWorkerStatus(
  subject: InternalAuthorizationSubject | null,
): InternalAuthorizationDecision {
  return evaluateInternalCapability("publication-worker:status:read", subject);
}

export function isInternallyAuthorized(decision: InternalAuthorizationDecision): boolean {
  return decision.decision === "ALLOW";
}
