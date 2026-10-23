/**
 * Promotion Authorization (Phase 1.41, Contract §16.1) — pure.
 *
 * A first-class governed relationship among one **Seller**, one **Product**, and
 * one **Promoter**: whether that Seller permits that Promoter to promote / resell
 * that Product. It is Promoter-specific and Product-specific — never "every
 * Promoter for this Product", never "every Product of this Seller".
 *
 * | State       | Meaning                                                       |
 * | ----------- | ------------------------------------------------------------- |
 * | `REQUESTED` | the Promoter has asked the Seller for permission               |
 * | `APPROVED`  | the Seller has explicitly approved that Promoter               |
 * | `DENIED`    | the Seller rejected the request                                |
 * | `REVOKED`   | the Seller withdrew a previously granted approval              |
 * | `CANCELLED` | the Promoter withdrew its own request or participation         |
 *
 * ## Governed transitions, and only those
 *
 * | From        | Act       | To          | Authority | Source                                     |
 * | ----------- | --------- | ----------- | --------- | ------------------------------------------ |
 * | (none)      | `REQUEST` | `REQUESTED` | Promoter  | §16.1 "Who may act"                        |
 * | `REQUESTED` | `APPROVE` | `APPROVED`  | Seller    | §16.1 "Who may act"                        |
 * | `REQUESTED` | `DENY`    | `DENIED`    | Seller    | §16.1 "Who may act"                        |
 * | `REQUESTED` | `CANCEL`  | `CANCELLED` | Promoter  | §16.1 `CANCELLED` — "its own request"      |
 * | `APPROVED`  | `REVOKE`  | `REVOKED`   | Seller    | §16.1 "Who may act", §16.4                 |
 * | `APPROVED`  | `CANCEL`  | `CANCELLED` | Promoter  | §16.1 `CANCELLED` — "or participation" (Phase 1.41 ruling A) |
 * | `DENIED` / `REVOKED` / `CANCELLED` | `REQUEST` | NEW cycle `REQUESTED` | Promoter | §16.1 "Re-requesting" |
 *
 * `DENIED`, `REVOKED`, and `CANCELLED` are terminal **for their cycle**. A
 * re-request never mutates the old cycle back to `REQUESTED`: it opens a NEW
 * cycle, so the old one — and its decision — is preserved exactly, and approval
 * is never silently restored (§16.1). Deliberately NOT governed, and refused:
 * any act out of a terminal state on the same cycle (`DENIED → APPROVED`,
 * `REVOKED → APPROVED`, `CANCELLED → APPROVED`, …), a Seller `CANCEL`, and a
 * Promoter `APPROVE` / `DENY` / `REVOKE`.
 *
 * ## Independence
 *
 * Product lifecycle (§9.1) and resale availability (§9.3) are separate axes:
 * nothing here reads them, and no change to them rewrites a relationship. An
 * `APPROVED` relationship means only "this Seller permits this Promoter to
 * promote this Product" — never "this Promoter may transact now". Promoted
 * commerce (§16.3) asks this axis as ONE of its gates.
 */

import { z } from "zod";
import { APPLICATION_REF_RE } from "../capsule/identity";
import {
  DRAFTING_ROLE_STATUSES,
  permitsDrafting,
  type ParticipantStatus,
  type RoleAssignmentStatus,
} from "./participant";

export const PROMOTION_AUTHORIZATION_STATES = [
  "REQUESTED",
  "APPROVED",
  "DENIED",
  "REVOKED",
  "CANCELLED",
] as const;
export const PromotionAuthorizationState = z.enum(PROMOTION_AUTHORIZATION_STATES);
export type PromotionAuthorizationState = z.infer<typeof PromotionAuthorizationState>;

/**
 * The stable application-facing reference of one request cycle — the shared
 * application-reference shape (`productRef`, `listingRef`), opaque and
 * un-namespaced. `mon:pauth:` stays internal.
 */
export const PromotionAuthorizationRef = z
  .string()
  .regex(APPLICATION_REF_RE, "authorizationRef must be a 32-character opaque application reference");
export type PromotionAuthorizationRef = z.infer<typeof PromotionAuthorizationRef>;

export const PROMOTION_AUTHORIZATION_ACTS = ["REQUEST", "APPROVE", "DENY", "REVOKE", "CANCEL"] as const;
export const PromotionAuthorizationAct = z.enum(PROMOTION_AUTHORIZATION_ACTS);
export type PromotionAuthorizationAct = z.infer<typeof PromotionAuthorizationAct>;

/** The Seller's decision vocabulary — what the decision route accepts. */
export const SELLER_PROMOTION_AUTHORIZATION_DECISIONS = ["APPROVE", "DENY", "REVOKE"] as const;
export const SellerPromotionAuthorizationDecision = z.enum(SELLER_PROMOTION_AUTHORIZATION_DECISIONS);
export type SellerPromotionAuthorizationDecision = z.infer<typeof SellerPromotionAuthorizationDecision>;

/** Who may make each act. Never both: a Seller does not cancel, a Promoter does not decide. */
export type PromotionAuthorizationAuthority = "SELLER" | "PROMOTER";
export const PROMOTION_AUTHORIZATION_ACT_AUTHORITY: Readonly<
  Record<PromotionAuthorizationAct, PromotionAuthorizationAuthority>
> = {
  REQUEST: "PROMOTER",
  APPROVE: "SELLER",
  DENY: "SELLER",
  REVOKE: "SELLER",
  CANCEL: "PROMOTER",
};

/** The within-cycle transitions — the table above, and nothing else. */
const CYCLE_TRANSITIONS: Readonly<
  Record<PromotionAuthorizationState, Partial<Record<PromotionAuthorizationAct, PromotionAuthorizationState>>>
> = {
  REQUESTED: { APPROVE: "APPROVED", DENY: "DENIED", CANCEL: "CANCELLED" },
  APPROVED: { REVOKE: "REVOKED", CANCEL: "CANCELLED" },
  DENIED: {},
  REVOKED: {},
  CANCELLED: {},
};

/** A cycle in one of these states is over; only a NEW request cycle may follow it. */
export const TERMINAL_PROMOTION_AUTHORIZATION_STATES = ["DENIED", "REVOKED", "CANCELLED"] as const;

export function isTerminalPromotionAuthorizationState(state: PromotionAuthorizationState): boolean {
  return (TERMINAL_PROMOTION_AUTHORIZATION_STATES as readonly string[]).includes(state);
}

/** The acts `authority` may make on a cycle in `state` — what a page offers. */
export function governedPromotionAuthorizationActs(
  state: PromotionAuthorizationState,
  authority: PromotionAuthorizationAuthority,
): PromotionAuthorizationAct[] {
  return (Object.keys(CYCLE_TRANSITIONS[state]) as PromotionAuthorizationAct[]).filter(
    (act) => PROMOTION_AUTHORIZATION_ACT_AUTHORITY[act] === authority,
  );
}

export type PromotionAuthorizationRequestDecision =
  | { outcome: "NEW_CYCLE" }
  | { outcome: "REFUSED"; reason: "ALREADY_REQUESTED" | "ALREADY_APPROVED" };

/**
 * Decide a Promoter request against the CURRENT cycle for this Product +
 * Promoter (`null` when there has never been one). An open cycle — `REQUESTED`
 * or `APPROVED` — refuses explicitly rather than silently re-recording; a
 * terminal one, or none, opens a new cycle.
 */
export function decidePromotionAuthorizationRequest(
  current: PromotionAuthorizationState | null,
): PromotionAuthorizationRequestDecision {
  if (current === "REQUESTED") return { outcome: "REFUSED", reason: "ALREADY_REQUESTED" };
  if (current === "APPROVED") return { outcome: "REFUSED", reason: "ALREADY_APPROVED" };
  return { outcome: "NEW_CYCLE" };
}

export type PromotionAuthorizationActDecision =
  | { outcome: "CHANGE"; from: PromotionAuthorizationState; to: PromotionAuthorizationState }
  | { outcome: "REFUSED"; reason: "TRANSITION_NOT_GOVERNED" };

/**
 * Decide one act on an existing cycle. Refused unless the act belongs to the
 * acting authority AND the table governs it from the cycle's current state.
 * `REQUEST` is never an act on an existing cycle — re-requesting opens a new one.
 */
export function decidePromotionAuthorizationAct(input: {
  current: PromotionAuthorizationState;
  act: PromotionAuthorizationAct;
  authority: PromotionAuthorizationAuthority;
}): PromotionAuthorizationActDecision {
  const { current, act, authority } = input;
  if (PROMOTION_AUTHORIZATION_ACT_AUTHORITY[act] !== authority) {
    return { outcome: "REFUSED", reason: "TRANSITION_NOT_GOVERNED" };
  }
  const to = CYCLE_TRANSITIONS[current][act];
  if (to === undefined) return { outcome: "REFUSED", reason: "TRANSITION_NOT_GOVERNED" };
  return { outcome: "CHANGE", from: current, to };
}

/**
 * The relationship-level answer future promoted-commerce eligibility (§16.3
 * item 4) consumes: is the CURRENT cycle `APPROVED`? `null` (no relationship)
 * is not approved. Necessary for promoted commerce, never sufficient.
 */
export function promotionAuthorizationIsApproved(current: PromotionAuthorizationState | null): boolean {
  return current === "APPROVED";
}

// — The request gate (Phase 1.41 rulings) —

/**
 * Why a participant may not request (or, at approval, no longer qualifies for)
 * Promotion Authorization. A closed classification vocabulary — never a value.
 */
export const PROMOTION_AUTHORIZATION_REQUEST_REFUSALS = [
  "ACCOUNT_DISABLED",
  "EMAIL_UNVERIFIED",
  "FIRST_NAME_MISSING",
  "LAST_NAME_MISSING",
  "PARTICIPANT_MISSING",
  "PARTICIPANT_STATUS_NOT_ELIGIBLE",
  "PARTICIPANT_SUSPENDED",
  "PROMOTER_ROLE_NOT_HELD",
  "PROMOTER_ROLE_NOT_ELIGIBLE",
] as const;
export type PromotionAuthorizationRequestRefusal = (typeof PROMOTION_AUTHORIZATION_REQUEST_REFUSALS)[number];

/** Every fact the gate weighs, read from authoritative rows by the caller. */
export interface PromotionAuthorizationRequestFacts {
  account: {
    status: string;
    emailVerifiedAt: string | null;
    firstName: string | null;
    lastName: string | null;
  };
  /** `null` for an authenticated account with no marketplace participant. */
  participant: {
    status: ParticipantStatus;
    /** A standing `ParticipantSuspension` — which a pre-admission status cannot express. */
    suspended: boolean;
    /** The PROMOTER role assignment's status, or `null` when never claimed. */
    promoterRoleStatus: RoleAssignmentStatus | null;
  } | null;
}

export interface PromotionAuthorizationRequestEligibility {
  eligible: boolean;
  refusals: PromotionAuthorizationRequestRefusal[];
}

const nonBlank = (value: string | null): boolean => value !== null && value.trim() !== "";

/**
 * May this participant request Promotion Authorization — and, re-asked at
 * approval, does it still qualify? (Phase 1.41 governance rulings.)
 *
 * A PRE-COMMERCIAL relationship gate: private marketplace identity (Contract §4
 * — an enabled account, a verified email, a declared first and last name, the
 * participant) plus a PROMOTER role in the repository's drafting / pre-commercial
 * state (`DRAFTING_ROLE_STATUSES`) on a participant permitted to draft and not
 * suspended. `RESTRICTED` is a drafting status and is NOT refused: a restriction
 * withholds commerce, and no restriction scope governs this act.
 *
 * Deliberately NOT asked: payment readiness, Stripe underwriting, commerce
 * approval, participant activation, public-marketplace readiness, Product
 * lifecycle, resale availability, an Offer, a Storefront, or a Listing. This
 * does not redefine what a PROMOTER role `ACTIVE` means anywhere else; later
 * promoted-commerce eligibility (§16.3) stays stricter and is not stated here.
 *
 * The Product-dependent refusal — a participant requesting its own Product — is
 * asked separately, against Product authority.
 */
export function participantMayRequestPromotionAuthorization(
  facts: PromotionAuthorizationRequestFacts,
): PromotionAuthorizationRequestEligibility {
  const refusals: PromotionAuthorizationRequestRefusal[] = [];
  if (facts.account.status !== "ACTIVE") refusals.push("ACCOUNT_DISABLED");
  if (facts.account.emailVerifiedAt === null) refusals.push("EMAIL_UNVERIFIED");
  if (!nonBlank(facts.account.firstName)) refusals.push("FIRST_NAME_MISSING");
  if (!nonBlank(facts.account.lastName)) refusals.push("LAST_NAME_MISSING");

  const participant = facts.participant;
  if (participant === null) {
    refusals.push("PARTICIPANT_MISSING");
  } else {
    if (!permitsDrafting(participant.status)) refusals.push("PARTICIPANT_STATUS_NOT_ELIGIBLE");
    if (participant.suspended) refusals.push("PARTICIPANT_SUSPENDED");
    if (participant.promoterRoleStatus === null) {
      refusals.push("PROMOTER_ROLE_NOT_HELD");
    } else if (!(DRAFTING_ROLE_STATUSES as readonly string[]).includes(participant.promoterRoleStatus)) {
      refusals.push("PROMOTER_ROLE_NOT_ELIGIBLE");
    }
  }
  return { eligible: refusals.length === 0, refusals };
}
