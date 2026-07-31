/**
 * Marketplace lifecycle transitions (Phase 0M.1).
 *
 * Three independent state machines — participant admission, one role assignment,
 * and payment readiness — expressed as explicit transition tables.
 *
 * Two properties shape everything below:
 *
 *   1. **A transition is legal only if it is written down.** The tables are
 *      exhaustive `Record<Status, readonly Status[]>` maps, so a state added to a
 *      vocabulary without a transition rule is a type error, not a silently
 *      unreachable — or silently reachable — state.
 *
 *   2. **Creation is not a transition.** A record's first status is checked by a
 *      separate rule, because "where may this start" and "where may this go" are
 *      different questions. A BUYER role legitimately starts ACTIVE; a SELLER role
 *      never does, and one table cannot express both without also permitting a
 *      DRAFT seller to jump straight to ACTIVE.
 *
 * Pure functions over enums. No clock, no persistence, no side effects.
 */

import {
  MarketplaceRole,
  ParticipantStatus,
  PaymentReadinessStatus,
  RoleAssignmentStatus,
} from "./participant";

// — Participant admission —

/**
 * Monacado's admission lifecycle.
 *
 * Notable refusals:
 *   - **DRAFT → ACTIVE is not a transition.** Activation is a governed decision
 *     (thesis §5.3); a path that skipped review would make every other gate
 *     advisory.
 *   - **PROFILE_INCOMPLETE → UNDER_REVIEW is not a transition.** Review is
 *     submitted from PROFILE_COMPLETE only.
 *   - **CLOSED is terminal.** Reopening is a new admission decision with its own
 *     record, not a state change that quietly erases why the participant closed.
 *
 * UNDER_REVIEW may return to PROFILE_INCOMPLETE: a reviewer asking for more
 * information is the ordinary outcome of a review, not a rejection, and it must
 * not require suspending the participant to express it.
 */
export const PARTICIPANT_STATUS_TRANSITIONS: Record<
  ParticipantStatus,
  readonly ParticipantStatus[]
> = Object.freeze({
  DRAFT: ["PROFILE_INCOMPLETE", "CLOSED"],
  PROFILE_INCOMPLETE: ["PROFILE_COMPLETE", "CLOSED"],
  PROFILE_COMPLETE: ["PROFILE_INCOMPLETE", "UNDER_REVIEW", "CLOSED"],
  UNDER_REVIEW: ["ACTIVE", "PROFILE_INCOMPLETE", "RESTRICTED", "SUSPENDED", "CLOSED"],
  ACTIVE: ["RESTRICTED", "SUSPENDED", "CLOSED"],
  RESTRICTED: ["ACTIVE", "SUSPENDED", "CLOSED"],
  SUSPENDED: ["ACTIVE", "RESTRICTED", "CLOSED"],
  CLOSED: [],
});

/** The only status a participant may be created in. */
export const INITIAL_PARTICIPANT_STATUS: ParticipantStatus = "DRAFT";

export function isValidParticipantTransition(
  from: ParticipantStatus,
  to: ParticipantStatus,
): boolean {
  return PARTICIPANT_STATUS_TRANSITIONS[from].includes(to);
}

// — Role assignment —

/**
 * One role's lifecycle.
 *
 * PENDING_ACTIVATION may fall back to DRAFT — an activation withdrawn before a
 * decision returns the role to the drafting state it came from, which is not the
 * same as revoking it.
 */
export const ROLE_ASSIGNMENT_TRANSITIONS: Record<
  RoleAssignmentStatus,
  readonly RoleAssignmentStatus[]
> = Object.freeze({
  DRAFT: ["PENDING_ACTIVATION", "REVOKED"],
  PENDING_ACTIVATION: ["ACTIVE", "DRAFT", "REVOKED"],
  ACTIVE: ["SUSPENDED", "REVOKED"],
  SUSPENDED: ["ACTIVE", "REVOKED"],
  REVOKED: [],
});

export function isValidRoleAssignmentTransition(
  from: RoleAssignmentStatus,
  to: RoleAssignmentStatus,
): boolean {
  return ROLE_ASSIGNMENT_TRANSITIONS[from].includes(to);
}

/**
 * The status a role may be created in.
 *
 * SELLER and PROMOTER start DRAFT: they confer commercial capability, so they
 * pass through activation. BUYER starts ACTIVE: buying requires no Monacado
 * admission decision — the thesis makes guest checkout a first-class path, so a
 * buyer role that needed approval would be stricter than buying with no account
 * at all.
 */
export function initialRoleAssignmentStatus(role: MarketplaceRole): RoleAssignmentStatus {
  return role === "BUYER" ? "ACTIVE" : "DRAFT";
}

export function isValidInitialRoleAssignmentStatus(
  role: MarketplaceRole,
  status: RoleAssignmentStatus,
): boolean {
  return status === initialRoleAssignmentStatus(role);
}

// — Payment readiness —

/**
 * The provider axis.
 *
 * **NOT_STARTED → ENABLED is not a transition.** Readiness is always the
 * provider's answer, never Monacado's assumption; a path that reached ENABLED
 * without the provider deciding would let an operator mark an unverified
 * participant payable.
 *
 * DISABLED → DETAILS_REQUIRED exists so re-onboarding is possible without
 * inventing a second "start over" state.
 */
export const PAYMENT_READINESS_TRANSITIONS: Record<
  PaymentReadinessStatus,
  readonly PaymentReadinessStatus[]
> = Object.freeze({
  NOT_STARTED: ["DETAILS_REQUIRED", "PENDING_PROVIDER", "DISABLED"],
  DETAILS_REQUIRED: ["PENDING_PROVIDER", "RESTRICTED", "DISABLED"],
  PENDING_PROVIDER: ["ENABLED", "DETAILS_REQUIRED", "RESTRICTED", "DISABLED"],
  ENABLED: ["RESTRICTED", "DETAILS_REQUIRED", "DISABLED"],
  RESTRICTED: ["ENABLED", "DETAILS_REQUIRED", "DISABLED"],
  DISABLED: ["DETAILS_REQUIRED"],
});

/** The only readiness a payment account may be created in. */
export const INITIAL_PAYMENT_READINESS: PaymentReadinessStatus = "NOT_STARTED";

export function isValidPaymentReadinessTransition(
  from: PaymentReadinessStatus,
  to: PaymentReadinessStatus,
): boolean {
  return PAYMENT_READINESS_TRANSITIONS[from].includes(to);
}
