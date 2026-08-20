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

/** May this internal account read publication-worker operational health? */
export function canReadPublicationWorkerStatus(
  subject: InternalAuthorizationSubject | null,
): InternalAuthorizationDecision {
  return evaluateInternalCapability("publication-worker:status:read", subject);
}

export function isInternallyAuthorized(decision: InternalAuthorizationDecision): boolean {
  return decision.decision === "ALLOW";
}
