/**
 * Opaque identifiers for self-service Product drafts (Phase 1.32) — SERVER ONLY.
 *
 * `mon:product:` names the enduring Product; `mon:srec:` names its source record.
 * Both are internal application identities — never ANS Node or capsule ids, and
 * never shown to a person. Generated from `crypto.randomBytes`, exactly as the
 * Storefront and participant identities are; injectable so a test can pin them.
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

export interface ProductIdProvider {
  nextInternalProductId(): string;
  nextSourceRecordId(): string;
}

export const cryptoProductIdProvider: ProductIdProvider = {
  nextInternalProductId: () => `mon:product:${randomOpaqueBody()}`,
  nextSourceRecordId: () => `mon:srec:${randomOpaqueBody()}`,
};
