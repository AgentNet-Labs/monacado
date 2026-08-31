/**
 * Restriction enforcement seams (Phase 1.15).
 *
 * Phase 0M.R1 gave a restriction a machine-readable **scope**, and Phase 1.14
 * gave Monacado the governed authority to impose one. Neither established that
 * anything *reads* a scope before acting. Four of the six did not: a restriction
 * on `commission:accrue` could be imposed, would move the participant to
 * `RESTRICTED`, would raise a notice obligation — and the operation it names
 * would proceed exactly as before.
 *
 * That is the gap this module closes, and it closes it by refusing to pretend.
 *
 * Five properties shape everything below:
 *
 *   1. **A scope is IMPLEMENTED only if a production service reads it.** Not if a
 *      contract names it, not if a policy paragraph promises it, and not if a
 *      column can hold it. `RESTRICTION_SCOPE_ENFORCEMENT` names the seam for
 *      every implemented scope, and a test walks the registry and greps the
 *      server tree for each one. A scope whose seam disappears fails the build
 *      rather than quietly becoming decorative again.
 *
 *   2. **An unsupported scope is refused at imposition, never advertised.** The
 *      honest answer to "may Monacado withhold this?" is no, not a row that
 *      looks like yes. `imposeParticipantRestriction` rejects an UNSUPPORTED
 *      scope outright.
 *
 *   3. **History is preserved, never rewritten.** `RestrictionScope` still parses
 *      every historical member, so a restriction imposed before this phase reads
 *      back, lifts, and reconsiders normally. Retirement governs *new*
 *      imposition only — the same discipline `RESTRICTION_LIFT_REASON_CODES`
 *      used when it corrected the lift vocabulary without touching stored rows.
 *
 *   4. **Scopes are role-aware.** `offer:publish` is a seller's capability; a
 *      promoter never publishes an Offer. Applying it to a promoter — which the
 *      pre-1.15 checkout gate did, reading one flat scope list for both parties
 *      — blocks a participant on a capability they do not exercise while leaving
 *      the one they do exercise untouched. The registry names the roles each
 *      scope can reach, and the readers respect it.
 *
 *   5. **Suspension is not a scope and is never expressed as one.**
 *      `ParticipantSuspension` withdraws admission; a restriction withholds one
 *      named capability. A suspension mints no restriction row, so any seam that
 *      reads only restrictions cannot see one — which is precisely how a
 *      suspended seller kept selling. Every reader here takes suspension as its
 *      own input and lets it dominate.
 *
 * Pure data and pure decisions. No database, clock, environment read,
 * randomness, or network. Not exported through the browser-facing barrel.
 */

import { z } from "zod";
import { MarketplaceRole } from "./participant";
import {
  RESTRICTABLE_CAPABILITIES,
  RestrictionScope,
} from "./participant-restriction";

// — Disposition —

/**
 * Whether Monacado can actually withhold this capability today.
 *
 * Two members, and no "PARTIAL". A scope read at one seam and ignored at another
 * is the condition that produced this phase; giving it a name would make it
 * survivable.
 */
export const RESTRICTION_SCOPE_DISPOSITIONS = ["IMPLEMENTED", "UNSUPPORTED"] as const;
export const RestrictionScopeDisposition = z.enum(RESTRICTION_SCOPE_DISPOSITIONS);
export type RestrictionScopeDisposition = z.infer<typeof RestrictionScopeDisposition>;

/**
 * One scope's enforcement posture.
 *
 * `seams` is the load-bearing field. It names production functions, and a test
 * asserts each named symbol exists in `src/server/**` — so the registry cannot
 * drift into describing a seam that was renamed or deleted.
 */
export interface RestrictionScopeEnforcement {
  readonly scope: RestrictionScope;
  readonly disposition: RestrictionScopeDisposition;
  /** What withholding this capability actually stops. One sentence, operational. */
  readonly meaning: string;
  /** Production functions that read this scope. EMPTY iff UNSUPPORTED. */
  readonly seams: readonly string[];
  /** Roles this scope can meaningfully reach. Empty for UNSUPPORTED scopes. */
  readonly appliesToRoles: readonly MarketplaceRole[];
  /** Why it is implemented, or why it is not. */
  readonly rationale: string;
}

// — The registry —

/**
 * Every recognized scope, and the truth about each.
 *
 * Ordered as `RESTRICTABLE_CAPABILITIES` orders them, so the two lists read
 * against each other. A test asserts the key sets are identical: a capability
 * added to the restrictable vocabulary without an entry here fails immediately,
 * which is the check that was missing when four scopes arrived with no seam.
 */
export const RESTRICTION_SCOPE_ENFORCEMENT: {
  readonly [S in RestrictionScope]: RestrictionScopeEnforcement;
} = {
  "storefront:activate": {
    scope: "storefront:activate",
    disposition: "IMPLEMENTED",
    meaning:
      "The participant may not take a Storefront live, nor increase its exposure to the public.",
    seams: ["assertStorefrontMayBecomeOperational"],
    appliesToRoles: ["SELLER", "PROMOTER"],
    rationale:
      "Both roles operate storefronts. The seam gates the branch of createStorefrontSourceVersion that makes a Storefront operationally reachable — going ACTIVE, or widening visibility — and never the branch that stands one down. A restricted owner may still close or hide their shop; requiring an intact commerce gate to STOP trading would trap the participant who most needs to stop.",
  },
  "offer:publish": {
    scope: "offer:publish",
    disposition: "IMPLEMENTED",
    meaning:
      "The participant may not make an Offer commercially live, nor be the seller to a new sale.",
    seams: ["assertOfferMayBecomeCommerciallyLive", "assertPartiesMayTransact"],
    appliesToRoles: ["SELLER"],
    rationale:
      "A seller's capability, and deliberately not a promoter's: a promoter never publishes an Offer, so applying this scope to one withholds a capability they do not hold. Two seams because an Offer already live when the restriction lands would otherwise keep selling — publication-time enforcement alone cannot reach a commitment already made.",
  },
  "payout:receive": {
    scope: "payout:receive",
    disposition: "IMPLEMENTED",
    meaning:
      "Monacado will not make its commercial obligation to this participant payable, nor take on new obligations to them.",
    seams: ["advanceProceedsObligation", "assertPartiesMayTransact"],
    appliesToRoles: ["SELLER", "PROMOTER"],
    rationale:
      "The obligation is still RECORDED in full — the restriction withholds settlement of what Monacado owes, never the record of owing it, and never the buyer's own payment. Both roles can be owed proceeds, so both are reachable.",
  },
  "commission:accrue": {
    scope: "commission:accrue",
    disposition: "UNSUPPORTED",
    meaning: "(No operation withholds this.)",
    seams: [],
    appliesToRoles: [],
    rationale:
      "Refused rather than wired, on capability.ts's own reasoning: accrual is a ledger fact about a sale that ALREADY HAPPENED, and refusing to record it would lose the obligation rather than defer it. The two things an operator actually wants are already governed — payout:receive withholds settlement of the commission, and a promoter's participant status withholds new promoted commerce, because on a promoted Listing the promoter is the controlling participant. A third name for either would be a second answer able to disagree.",
  },
  "review:product:submit": {
    scope: "review:product:submit",
    disposition: "UNSUPPORTED",
    meaning: "(No operation withholds this.)",
    seams: [],
    appliesToRoles: [],
    rationale:
      "There is no review-submission service in src/server. The scope names an operation this repository has not built, so no seam can read it and no honest readiness report can claim it.",
  },
  "review:seller:submit": {
    scope: "review:seller:submit",
    disposition: "UNSUPPORTED",
    meaning: "(No operation withholds this.)",
    seams: [],
    appliesToRoles: [],
    rationale:
      "As review:product:submit — one evaluator, one absent service, one scope that cannot be enforced.",
  },
};

export const IMPLEMENTED_RESTRICTION_SCOPES = RESTRICTABLE_CAPABILITIES.filter(
  (s) => RESTRICTION_SCOPE_ENFORCEMENT[s].disposition === "IMPLEMENTED",
);

/**
 * Recognized, historically imposable, and refused for NEW imposition.
 *
 * Not deleted from `RestrictionScope`: a stored row naming one of these must
 * still parse, lift, and be reconsidered. Retiring the vocabulary member instead
 * of the imposition would rewrite history to make the present look tidier.
 */
export const UNSUPPORTED_RESTRICTION_SCOPES = RESTRICTABLE_CAPABILITIES.filter(
  (s) => RESTRICTION_SCOPE_ENFORCEMENT[s].disposition === "UNSUPPORTED",
);

/** May a NEW restriction be imposed on this scope? */
export function isEnforceableRestrictionScope(scope: RestrictionScope): boolean {
  return RESTRICTION_SCOPE_ENFORCEMENT[scope].disposition === "IMPLEMENTED";
}

/** Does this scope reach a participant acting in this role? */
export function scopeAppliesToRole(scope: RestrictionScope, role: MarketplaceRole): boolean {
  return RESTRICTION_SCOPE_ENFORCEMENT[scope].appliesToRoles.includes(role);
}

/**
 * The implemented scopes that block a party from **new commerce** in this role.
 *
 * Both members withhold something a new sale requires: the right to offer, and
 * the right to be owed. `storefront:activate` is deliberately absent — it gates
 * a shop becoming reachable, not each sale through one, and a Storefront already
 * live is governed by its own lifecycle rather than re-decided per checkout.
 */
export function commerceBlockingScopesForRole(
  role: MarketplaceRole,
): readonly RestrictionScope[] {
  const COMMERCE_BLOCKING = ["offer:publish", "payout:receive"] as const;
  return COMMERCE_BLOCKING.filter(
    (s) => isEnforceableRestrictionScope(s) && scopeAppliesToRole(s, role),
  );
}

// — Denial —

/**
 * Why a governed action was refused, as a closed vocabulary.
 *
 * Two members, and the distinction is the useful one: admission withdrawn versus
 * one capability withheld. Neither carries a reason code, a score, a rate, a
 * threshold, a review, or an operator's rationale — a denial says that the
 * action is unavailable, never why Monacado decided it.
 *
 * Safe to log and safe to show an operator. **Not** safe to show a buyer, who
 * has no standing to learn a counterparty's marketplace status: public surfaces
 * collapse both to a single availability consequence.
 */
export const PARTICIPANT_ACTION_DENIAL_CODES = [
  /** An active ParticipantSuspension stands. Dominates every scope. */
  "PARTICIPANT_SUSPENDED",
  /** An active ParticipantRestriction covers the capability this action needs. */
  "ACTION_RESTRICTED",
] as const;
export const ParticipantActionDenialCode = z.enum(PARTICIPANT_ACTION_DENIAL_CODES);
export type ParticipantActionDenialCode = z.infer<typeof ParticipantActionDenialCode>;

/**
 * A participant's governed standing, as the facts a seam needs and nothing more.
 *
 * Deliberately NOT the participant's status. Status is derived — any active
 * restriction reconciles it to `RESTRICTED` — so reading it back to decide a
 * scope-specific question would answer with the coarsest fact available. The
 * authoritative records are the suspension row and the restriction rows, and
 * these are they.
 */
export interface ParticipantStanding {
  readonly suspended: boolean;
  readonly activeScopes: readonly RestrictionScope[];
}

export interface ParticipantActionDecision {
  readonly allowed: boolean;
  readonly denialCode: ParticipantActionDenialCode | null;
}

const ALLOWED: ParticipantActionDecision = { allowed: true, denialCode: null };

/**
 * May a participant in this standing perform an action requiring these scopes?
 *
 * **Suspension dominates**, and is checked first: a suspension withdraws
 * admission to the marketplace, so it refuses every governed action regardless
 * of which scopes the action needs and regardless of whether any restriction
 * stands. That ordering is the whole of "suspension is not a restriction with a
 * louder name" — before this phase a suspension was the *weaker* of the two at
 * the money seams, because those seams counted restriction rows and a suspension
 * mints none.
 *
 * `requiredScopes` empty means the action needs no capability beyond admission;
 * a suspended participant is still refused, an unsuspended one allowed.
 *
 * Pure, total, and deterministic — the same standing and the same required
 * scopes always yield the same decision.
 */
export function evaluateParticipantAction(input: {
  standing: ParticipantStanding;
  requiredScopes: readonly RestrictionScope[];
}): ParticipantActionDecision {
  if (input.standing.suspended) {
    return { allowed: false, denialCode: "PARTICIPANT_SUSPENDED" };
  }
  const blocked = input.requiredScopes.some((s) => input.standing.activeScopes.includes(s));
  return blocked ? { allowed: false, denialCode: "ACTION_RESTRICTED" } : ALLOWED;
}

// — Never on an enforcement decision —

/**
 * Named as never-carryable on a denial, and asserted by a test.
 *
 * A denial travels further than a restriction record does — into logs, into an
 * operator console, and (collapsed) toward a buyer. Everything here is either
 * `0M.R2` risk material or a Staff judgement, and none of it may ride along.
 */
export const NEVER_ON_PARTICIPANT_ACTION_DENIAL = [
  "riskScore",
  "riskClassification",
  "chargebackRate",
  "refundRate",
  "reviewDisposition",
  "riskReviewId",
  "reasonCode",
  "investigatorNote",
  "internalNote",
  "operatorRationale",
  "thresholds",
] as const;
