/**
 * Opaque identity generation for Listings (Phase 0M.7) — SERVER ONLY.
 *
 * Same construction as `offer-ids`, `storefront-ids`, and `participant-ids`:
 * `crypto.randomBytes` over the Crockford alphabet, `byte % 32` bias-free
 * because 256 is an exact multiple of the 32-character alphabet.
 *
 * Neither identifier encodes the Product, the Storefront, the controlling
 * participant, the retail price, or the Listing type. A Listing whose price
 * changed — the ordinary case, and the reason versions exist — would otherwise
 * carry a lie in its own identifier. `mon:listing:` is internal and is never an
 * AgentNet Node: a Node is Registrar-issued elsewhere and never derived here.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET, SOURCE_RECORD_ID_RE } from "../../contracts/capsule/identity";
import { INTERNAL_LISTING_ID_RE } from "../../contracts/marketplace/identity";

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
export interface ListingIdProvider {
  nextInternalListingId(): string;
  nextListingSourceRecordId(): string;
}

export const cryptoListingIdProvider: ListingIdProvider = {
  nextInternalListingId: () => `mon:listing:${randomOpaqueBody()}`,
  nextListingSourceRecordId: () => `mon:srec:${randomOpaqueBody()}`,
};

/** Shapes asserted by a test rather than guarded at runtime — they hold by construction. */
export const LISTING_ID_PATTERNS = {
  listing: INTERNAL_LISTING_ID_RE,
  sourceRecord: SOURCE_RECORD_ID_RE,
} as const;
