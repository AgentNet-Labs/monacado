/**
 * Marketplace participant, role, and payment-readiness contracts (Phase 0M.1).
 *
 * The vocabularies and read views a marketplace authorization decision is allowed
 * to see. No persistence, no route, no clock, no environment read.
 *
 * Four properties shape everything below:
 *
 *   1. **An account is not a participant.** `Account` answers "who
 *      authenticated"; `MarketplaceParticipant` answers "who is transacting".
 *      Merging them would put marketplace activation into the authentication
 *      identity, and then disabling a login and suspending a seller would be the
 *      same operation — which they are not.
 *
 *   2. **Roles are additive, not a hierarchy.** SELLER, PROMOTER, and BUYER are
 *      independent grants that coexist on one participant. The thesis is explicit
 *      that a person may be creator, promoter, or both, and ADR §11.5 forbids
 *      issuing a second Node merely because one participant holds several roles.
 *
 *   3. **Three lifecycles, three axes.** Participant status is Monacado's
 *      admission decision, role status is per-role, and payment readiness is the
 *      provider's answer. They move independently and are never inferred from one
 *      another — an ENABLED payout capability is not an activation approval, and
 *      an activation approval does not make money movable.
 *
 *   4. **Views carry no private profile data.** Legal name, address, date of
 *      birth, tax id, documents, and provider secrets have no field here, so a
 *      capability decision cannot come to depend on one and no projection can
 *      leak one.
 *
 * Pure data. Not exported through the browser-facing contracts barrel.
 */

import { z } from "zod";
import { ACCOUNT_CAPABILITIES, AccountCapability, AccountId, AccountStatus } from "../account/account";
import {
  MARKETPLACE_PARTICIPANT_ID_RE,
  MARKETPLACE_ROLE_ASSIGNMENT_ID_RE,
} from "./identity";

// — Identity —

export const MarketplaceParticipantId = z
  .string()
  .regex(MARKETPLACE_PARTICIPANT_ID_RE, "participantId must be mon:mpart:<opaque>");
export type MarketplaceParticipantId = z.infer<typeof MarketplaceParticipantId>;

export const MarketplaceRoleAssignmentId = z
  .string()
  .regex(MARKETPLACE_ROLE_ASSIGNMENT_ID_RE, "roleAssignmentId must be mon:mrole:<opaque>");
export type MarketplaceRoleAssignmentId = z.infer<typeof MarketplaceRoleAssignmentId>;

// — Roles —

/**
 * The closed marketplace role vocabulary.
 *
 * `INTERNAL_OPERATOR` is deliberately **absent**. It is an internal operational
 * entitlement (`AccountEntitlement`), not a marketplace role, and putting it in
 * this enum would be the first step toward a Monacado employee accidentally
 * holding seller authority because one enum served two questions.
 *
 * SELLER is the marketplace role; `Creator` remains the ADR's name for the
 * *publishable capsule authority* the role produces. One is an authorization
 * fact, the other a semantic entity — see the architecture document.
 */
export const MARKETPLACE_ROLES = ["SELLER", "PROMOTER", "BUYER"] as const;
export const MarketplaceRole = z.enum(MARKETPLACE_ROLES);
export type MarketplaceRole = z.infer<typeof MarketplaceRole>;

/** Roles that can transact commercially and therefore pass through activation. */
export const ACTIVATABLE_ROLES = ["SELLER", "PROMOTER"] as const satisfies readonly MarketplaceRole[];

export function isActivatableRole(role: MarketplaceRole): boolean {
  return (ACTIVATABLE_ROLES as readonly MarketplaceRole[]).includes(role);
}

// — Participant status —

/**
 * Monacado's admission lifecycle for one participant.
 *
 * Deliberately **not** the thesis's Appendix A "Account" vocabulary. That list
 * (`registered, email_verified, profile_incomplete, stripe_pending,
 * review_pending, active, …`) mixes three independent facts — authentication
 * identity, Monacado admission, and payment-provider progress — into one column,
 * where `stripe_pending` and `review_pending` cannot both be true. Here each fact
 * has its own axis, and the thesis's illustrative states map onto them without
 * loss (see the architecture document).
 *
 * Each state means something no other state means:
 *   - DRAFT — the participant record exists; nothing has been claimed yet.
 *   - PROFILE_INCOMPLETE — required private profile fields are outstanding.
 *   - PROFILE_COMPLETE — profile satisfied; activation may be submitted.
 *   - UNDER_REVIEW — submitted; Monacado is deciding. No commerce yet.
 *   - ACTIVE — Monacado has admitted this participant to the marketplace.
 *   - RESTRICTED — admitted, but some capability is withheld pending a cure.
 *   - SUSPENDED — admission withdrawn pending a cure; nothing commercial runs.
 *   - CLOSED — terminal.
 */
export const PARTICIPANT_STATUSES = [
  "DRAFT",
  "PROFILE_INCOMPLETE",
  "PROFILE_COMPLETE",
  "UNDER_REVIEW",
  "ACTIVE",
  "RESTRICTED",
  "SUSPENDED",
  "CLOSED",
] as const;
export const ParticipantStatus = z.enum(PARTICIPANT_STATUSES);
export type ParticipantStatus = z.infer<typeof ParticipantStatus>;

/**
 * Statuses in which drafting is permitted.
 *
 * Drafting is deliberately available before activation — the thesis's whole
 * onboarding premise is "low-friction creation, governed activation": a
 * bare-bones account may build storefronts, products, and listings and may not
 * sell. RESTRICTED is included because a restriction withholds *commerce*, not
 * the ability to correct the work that caused it.
 */
export const DRAFTING_PARTICIPANT_STATUSES = [
  "DRAFT",
  "PROFILE_INCOMPLETE",
  "PROFILE_COMPLETE",
  "UNDER_REVIEW",
  "ACTIVE",
  "RESTRICTED",
] as const satisfies readonly ParticipantStatus[];

export function permitsDrafting(status: ParticipantStatus): boolean {
  return (DRAFTING_PARTICIPANT_STATUSES as readonly ParticipantStatus[]).includes(status);
}

// — Role-assignment status —

/**
 * The lifecycle of **one role on one participant**.
 *
 * Narrow on purpose: it answers "may this participant act in this role at all",
 * and nothing else. Profile completeness, activation review, and payment state
 * are participant-wide facts and are not restated here — a role that carried its
 * own copy of them would drift out of agreement with the participant's.
 *
 *   - DRAFT — claimed, not yet put forward for activation.
 *   - PENDING_ACTIVATION — included in a submitted activation.
 *   - ACTIVE — usable.
 *   - SUSPENDED — temporarily withdrawn; may be restored.
 *   - REVOKED — terminal.
 */
export const ROLE_ASSIGNMENT_STATUSES = [
  "DRAFT",
  "PENDING_ACTIVATION",
  "ACTIVE",
  "SUSPENDED",
  "REVOKED",
] as const;
export const RoleAssignmentStatus = z.enum(ROLE_ASSIGNMENT_STATUSES);
export type RoleAssignmentStatus = z.infer<typeof RoleAssignmentStatus>;

/**
 * Role statuses under which drafting in that role is permitted.
 *
 * A DRAFT seller role is exactly the "bare-bones account" the thesis describes:
 * it may define products and may not activate anything.
 */
export const DRAFTING_ROLE_STATUSES = [
  "DRAFT",
  "PENDING_ACTIVATION",
  "ACTIVE",
] as const satisfies readonly RoleAssignmentStatus[];

// — Payment readiness —

/**
 * The payment-provider axis, kept **provider-neutral**.
 *
 * Stripe is the intended provider (thesis §5.5) and appears nowhere in this
 * vocabulary. `PENDING_PROVIDER` rather than `stripe_pending`, and no
 * `capabilities`, `requirements`, or `charges_enabled` field, because a lifecycle
 * shaped around one provider's API becomes a migration the day that changes —
 * and because the provider's own requirement model is dynamic (thesis §5.4) and
 * must not be frozen into an enum.
 *
 *   - NOT_STARTED — no onboarding attempted.
 *   - DETAILS_REQUIRED — the provider is waiting on the participant.
 *   - PENDING_PROVIDER — the provider is deciding; Monacado waits.
 *   - ENABLED — the capabilities required for the selected funds flow are live.
 *   - RESTRICTED — previously enabled, now partially withheld by the provider.
 *   - DISABLED — unusable.
 */
export const PAYMENT_READINESS_STATUSES = [
  "NOT_STARTED",
  "DETAILS_REQUIRED",
  "PENDING_PROVIDER",
  "ENABLED",
  "RESTRICTED",
  "DISABLED",
] as const;
export const PaymentReadinessStatus = z.enum(PAYMENT_READINESS_STATUSES);
export type PaymentReadinessStatus = z.infer<typeof PaymentReadinessStatus>;

// — Views —

export const MarketplaceRoleAssignmentView = z.strictObject({
  role: MarketplaceRole,
  status: RoleAssignmentStatus,
});
export type MarketplaceRoleAssignmentView = z.infer<typeof MarketplaceRoleAssignmentView>;

/**
 * The safe read view of a participant.
 *
 * An allow-list, not a filter: every field a decision may see is named. There is
 * no field for a legal name, an address, a date of birth, a tax identifier, a
 * document reference, a provider account id, or a provider secret — so a
 * capability rule cannot quietly start depending on private profile data, and no
 * projection of this view can leak any.
 */
export const MarketplaceParticipantView = z
  .strictObject({
    participantId: MarketplaceParticipantId,
    accountId: AccountId,
    status: ParticipantStatus,
    roles: z.array(MarketplaceRoleAssignmentView).max(MARKETPLACE_ROLES.length),
    paymentReadiness: PaymentReadinessStatus,
  })
  .refine(
    (p) => new Set(p.roles.map((r) => r.role)).size === p.roles.length,
    "a participant holds at most one assignment per role",
  );
export type MarketplaceParticipantView = z.infer<typeof MarketplaceParticipantView>;

/** The authenticated half of a subject: identity only, never authorization. */
export const MarketplaceAccountView = z.strictObject({
  accountId: AccountId,
  /**
   * Identity-level status only — ACTIVE or DISABLED. Marketplace activation is
   * **not** encoded here and never will be; it lives on the participant.
   */
  status: AccountStatus,
});
export type MarketplaceAccountView = z.infer<typeof MarketplaceAccountView>;

/**
 * Everything a marketplace capability decision may consider.
 *
 * `account: null` **is** the guest buyer — not a sentinel account, not an
 * anonymous row, and not an account created on their behalf. A guest is modelled
 * by the absence of an identity, which is the only representation that cannot
 * later be mistaken for one.
 *
 * `internalCapabilities` is present precisely so it can be shown to grant
 * nothing: every function in `capability.ts` ignores it, and a test proves that
 * flipping it changes no marketplace decision.
 */
export const MarketplaceSubject = z
  .strictObject({
    account: MarketplaceAccountView.nullable(),
    participant: MarketplaceParticipantView.nullable(),
    internalCapabilities: z.array(AccountCapability).max(ACCOUNT_CAPABILITIES.length),
  })
  .refine(
    (s) => s.participant === null || s.account !== null,
    "a participant cannot exist without an account",
  )
  .refine(
    (s) => s.participant === null || s.participant.accountId === s.account?.accountId,
    "participant.accountId must match account.accountId",
  );
export type MarketplaceSubject = z.infer<typeof MarketplaceSubject>;

/** The guest buyer: no account, no participant, no internal capability. */
export const GUEST_SUBJECT: MarketplaceSubject = Object.freeze({
  account: null,
  participant: null,
  internalCapabilities: [],
});

// — Role lookup —

/** The assignment for `role`, or `undefined`. Never throws; never infers a role. */
export function findRoleAssignment(
  participant: MarketplaceParticipantView | null,
  role: MarketplaceRole,
): MarketplaceRoleAssignmentView | undefined {
  return participant?.roles.find((r) => r.role === role);
}

export function holdsRole(
  participant: MarketplaceParticipantView | null,
  role: MarketplaceRole,
): boolean {
  return findRoleAssignment(participant, role) !== undefined;
}

export function holdsActiveRole(
  participant: MarketplaceParticipantView | null,
  role: MarketplaceRole,
): boolean {
  return findRoleAssignment(participant, role)?.status === "ACTIVE";
}
