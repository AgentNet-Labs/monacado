/**
 * Opaque identity generation for risk policies (Phase 1.2) — SERVER ONLY.
 *
 * The same construction as every other identity provider here. A risk policy id
 * encodes nothing — not a threshold, a currency, or an ordering.
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

export interface RiskPolicyIdProvider {
  nextRiskPolicyId(): string;
}

export const cryptoRiskPolicyIdProvider: RiskPolicyIdProvider = {
  nextRiskPolicyId: () => `mon:rpol:${randomOpaqueBody()}`,
};
