/**
 * Opaque identity generation for Phase 1.13 risk records — SERVER ONLY.
 *
 * The same construction every other identity provider here uses. A review id
 * encodes nothing — not a participant, a score, a rank, or an ordering. An
 * identifier that carried a risk level would become a thing people read off the
 * row, and then a thing a query accidentally keys on.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "../../contracts/capsule/identity";

const OPAQUE_BODY_LENGTH = 26;

function randomOpaqueBody(): string {
  const bytes = randomBytes(OPAQUE_BODY_LENGTH);
  let out = "";
  for (let i = 0; i < OPAQUE_BODY_LENGTH; i += 1) {
    out += CROCKFORD_ALPHABET[bytes[i]! % CROCKFORD_ALPHABET.length];
  }
  return out;
}

export interface SellerRiskReviewPolicyIdProvider {
  nextSellerRiskReviewPolicyId(): string;
}

export interface ParticipantRiskReviewIdProvider {
  nextParticipantRiskReviewId(): string;
}

export const cryptoSellerRiskReviewPolicyIdProvider: SellerRiskReviewPolicyIdProvider = {
  nextSellerRiskReviewPolicyId: () => `mon:srrp:${randomOpaqueBody()}`,
};

export const cryptoParticipantRiskReviewIdProvider: ParticipantRiskReviewIdProvider = {
  nextParticipantRiskReviewId: () => `mon:prrev:${randomOpaqueBody()}`,
};
