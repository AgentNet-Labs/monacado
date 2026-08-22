/**
 * Opaque identity generation for policy and contact records (Phase 1.3) —
 * SERVER ONLY.
 *
 * The same construction as every other identity provider here. None of these
 * encodes anything: an acceptance id carries no participant, no version, and no
 * instant, and a challenge id carries no token.
 *
 * **A verification token is not minted here.** It is a credential, not an
 * identifier, and it lives in `email-verification-service.ts` where its digest
 * rule lives with it — the same separation `0M.9` made between `order-ids.ts` and
 * `guest-claim-code.ts`.
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

export interface PolicyIdProvider {
  nextAcceptanceId(): string;
  nextEmailContactId(): string;
  nextVerificationChallengeId(): string;
}

export const cryptoPolicyIdProvider: PolicyIdProvider = {
  nextAcceptanceId: () => `mon:pacc:${randomOpaqueBody()}`,
  nextEmailContactId: () => `mon:pemc:${randomOpaqueBody()}`,
  nextVerificationChallengeId: () => `mon:evch:${randomOpaqueBody()}`,
};
