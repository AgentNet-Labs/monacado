/**
 * Opaque identity generation for commercial policies (Phase 0M.R1) — SERVER ONLY.
 *
 * Same construction as `participant-ids`: `crypto.randomBytes` over the
 * Crockford alphabet, `byte % 32` bias-free because 256 is an exact multiple of
 * the 32-character alphabet.
 *
 * A policy id becomes `MonacadoWholesaleAcquisitionPolicy.policyId` and is
 * eventually recorded on every transaction that ran under it, so it must be
 * stable and meaningless. It encodes no rate, no currency, no effective date,
 * and no ordering — an identifier that carried its economics would become a
 * thing people read instead of the version row, and then a thing that lies the
 * first time a rate changes.
 *
 * Policy *versions* get no opaque identity: they are keyed by
 * `(policyId, policyVersion)`, the composite a future Order binds to.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "../../contracts/capsule/identity";
import { COMMERCIAL_POLICY_ID_RE } from "../../contracts/marketplace/identity";

const OPAQUE_BODY_LENGTH = 26;

function randomOpaqueBody(): string {
  const bytes = randomBytes(OPAQUE_BODY_LENGTH);
  let out = "";
  for (let i = 0; i < OPAQUE_BODY_LENGTH; i += 1) {
    out += CROCKFORD_ALPHABET[bytes[i]! % CROCKFORD_ALPHABET.length];
  }
  return out;
}

/** Injectable identity source; a test supplies deterministic ids. */
export interface CommercialPolicyIdProvider {
  nextPolicyId(): string;
}

export const cryptoCommercialPolicyIdProvider: CommercialPolicyIdProvider = {
  nextPolicyId: () => `mon:cpol:${randomOpaqueBody()}`,
};

/** Shape asserted by a test rather than guarded at runtime — it holds by construction. */
export const COMMERCIAL_POLICY_ID_PATTERN = COMMERCIAL_POLICY_ID_RE;
