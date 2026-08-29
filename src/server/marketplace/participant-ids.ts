/**
 * Opaque identity generation for participants, role assignments, profiles, and
 * activations (Phase 0M.5) — SERVER ONLY.
 *
 * Same construction as `account/account-ids`: `crypto.randomBytes` over the
 * Crockford alphabet, `byte % 32` bias-free because 256 is an exact multiple of
 * the 32-character alphabet.
 *
 * These identifiers key authorization decisions — a participant id is what an
 * Offer's `sellerParticipantId` and a Storefront's `ownerParticipantId` point at
 * — so a predictable one would let a third party guess a target for a role
 * grant, a profile read, or an activation.
 *
 * None of them encodes a role, a legal name, an email address, a storefront
 * name, or an activation state. An identifier that carries meaning becomes a
 * thing people read, and then a thing authorization accidentally keys on.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "../../contracts/capsule/identity";
import {
  MARKETPLACE_PARTICIPANT_ID_RE,
  MARKETPLACE_ROLE_ASSIGNMENT_ID_RE,
  PARTICIPANT_ACTIVATION_ID_RE,
  PARTICIPANT_PAYMENT_ACCOUNT_ID_RE,
  PARTICIPANT_PROFILE_ID_RE,
  PARTICIPANT_RESTRICTION_ID_RE,
  NOTIFICATION_OBLIGATION_ID_RE,
} from "../../contracts/marketplace/identity";

/** Length of the opaque body shared by every Monacado identifier. */
const OPAQUE_BODY_LENGTH = 26;

function randomOpaqueBody(): string {
  const bytes = randomBytes(OPAQUE_BODY_LENGTH);
  let out = "";
  for (let i = 0; i < OPAQUE_BODY_LENGTH; i += 1) {
    out += CROCKFORD_ALPHABET[bytes[i]! % CROCKFORD_ALPHABET.length];
  }
  return out;
}

/**
 * Injectable identity source. Production uses the crypto-backed default; a test
 * supplies deterministic ids so a fixture can be asserted exactly.
 */
export interface ParticipantIdProvider {
  nextParticipantId(): string;
  nextRoleAssignmentId(): string;
  nextProfileId(): string;
  nextActivationId(): string;
  /**
   * Phase 0M.8. Names Monacado's own payment-account row, never the provider's
   * account — the provider's identifier is a field on that row, so a Monacado id
   * and an external reference can never be mistaken for each other.
   */
  nextPaymentAccountId(): string;
  /**
   * Phase 0M.R1. Names one governed restriction — the evidence behind a
   * RESTRICTED status, never the participant and never the scope.
   */
  nextRestrictionId(): string;
  /**
   * Phase 0M.N1. Names one obligation Monacado owes — never a message, and
   * never the recipient.
   */
  nextObligationId(): string;
}

export const cryptoParticipantIdProvider: ParticipantIdProvider = {
  nextParticipantId: () => `mon:mpart:${randomOpaqueBody()}`,
  nextRoleAssignmentId: () => `mon:mrole:${randomOpaqueBody()}`,
  nextProfileId: () => `mon:mprof:${randomOpaqueBody()}`,
  nextActivationId: () => `mon:mact:${randomOpaqueBody()}`,
  nextPaymentAccountId: () => `mon:mpay:${randomOpaqueBody()}`,
  nextRestrictionId: () => `mon:prst:${randomOpaqueBody()}`,
  nextObligationId: () => `mon:nobl:${randomOpaqueBody()}`,
};

/** Shapes asserted by a test rather than guarded at runtime — they hold by construction. */
export const PARTICIPANT_ID_PATTERNS = {
  participant: MARKETPLACE_PARTICIPANT_ID_RE,
  roleAssignment: MARKETPLACE_ROLE_ASSIGNMENT_ID_RE,
  profile: PARTICIPANT_PROFILE_ID_RE,
  activation: PARTICIPANT_ACTIVATION_ID_RE,
  paymentAccount: PARTICIPANT_PAYMENT_ACCOUNT_ID_RE,
  restriction: PARTICIPANT_RESTRICTION_ID_RE,
  obligation: NOTIFICATION_OBLIGATION_ID_RE,
} as const;

/**
 * Identity for Phase 1.14's governed mitigation records — SERVER ONLY.
 *
 * A SEPARATE PROVIDER rather than two more members on `ParticipantIdProvider`,
 * on the convention every other domain here already follows. Widening the shared
 * interface would oblige every existing test double that mints a participant to
 * also mint a suspension, which is a change to twenty call sites to serve two.
 *
 * A suspension id encodes nothing — not a participant, a reason, or an ordering.
 */
export interface ParticipantMitigationIdProvider {
  nextSuspensionId(): string;
  nextReconsiderationId(): string;
  nextObligationId(): string;
}

export const cryptoParticipantMitigationIdProvider: ParticipantMitigationIdProvider = {
  nextSuspensionId: () => `mon:psus:${randomOpaqueBody()}`,
  nextReconsiderationId: () => `mon:prrcn:${randomOpaqueBody()}`,
  nextObligationId: () => `mon:nobl:${randomOpaqueBody()}`,
};
