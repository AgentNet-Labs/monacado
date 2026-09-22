/**
 * Opaque identifiers for self-service Product drafts (Phase 1.32), and the
 * stable application-facing Product reference (Phase 1.34) — SERVER ONLY.
 *
 * `mon:product:` names the enduring Product; `mon:srec:` names its source record.
 * Both are internal application identities — never ANS Node or capsule ids, and
 * never shown to a person. Generated from `crypto.randomBytes`, exactly as the
 * Storefront and participant identities are; injectable so a test can pin them.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "../../contracts/capsule/identity";
import { randomApplicationRef } from "../application-reference";

const OPAQUE_BODY_LENGTH = 26;

/**
 * `OPAQUE_BODY_LENGTH` characters drawn from the Crockford alphabet, one CSPRNG
 * byte each.
 *
 * `byte % 32` is bias-free because 256 is an exact multiple of the 32-character
 * alphabet — the same construction every other identifier generator here uses.
 */
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

/**
 * The stable application-facing Product reference (Phase 1.34) — SERVER ONLY.
 *
 * **Deliberately a SEPARATE provider from `ProductIdProvider`.** The internal
 * identities are built by the draft builder from a caller's facts; `productRef`
 * is minted by the repository inside the creating transaction and has no input
 * path at all. Keeping them apart is what makes "no client may choose it"
 * structural rather than a rule in a comment: the two are not interchangeable
 * and a caller who could supply one still cannot supply the other.
 *
 * Injectable only so a test may pin the value. Production uses the
 * crypto-backed default.
 */
export interface ProductRefProvider {
  nextProductRef(): string;
}

export const cryptoProductRefProvider: ProductRefProvider = {
  /* No namespace prefix, and that is the guarantee: a bare 32-character body
     cannot be mistaken for — or used as — a `mon:product:`, a `mon:srec:`, or an
     `an:node:` identity, because those all carry one. */
  nextProductRef: randomApplicationRef,
};
