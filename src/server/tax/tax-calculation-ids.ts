/**
 * Opaque identity generation for tax evidence (Phase 1.2) — SERVER ONLY.
 *
 * The same construction as every other identity provider here. A tax evidence id
 * encodes nothing — not the amount, the jurisdiction, the engine, or the Order.
 *
 * **A provider calculation reference is never minted here.** It is an external
 * string an engine returns, and generating one would mean Monacado had invented
 * evidence that a calculation happened.
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

export interface TaxEvidenceIdProvider {
  nextTaxEvidenceId(): string;
}

export const cryptoTaxEvidenceIdProvider: TaxEvidenceIdProvider = {
  nextTaxEvidenceId: () => `mon:taxe:${randomOpaqueBody()}`,
};
