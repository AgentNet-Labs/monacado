/**
 * Opaque identity for Promotion Authorization cycles and acts, and the cycle's
 * application-facing reference (Phase 1.41) — SERVER ONLY.
 *
 * Its own provider, on `product-lifecycle-ids`' reasoning: widening a shared
 * provider would add required methods to interfaces unrelated suites implement.
 * Internal ids use the usual `crypto.randomBytes` construction over the
 * Crockford alphabet; the reference is the shared `randomApplicationRef`, so it
 * has the exact shape of a `productRef` or a `listingRef` and no namespace.
 *
 * None of these encodes the Product, the Seller, the Promoter, the cycle number,
 * the instant, or the state. Only the reference is ever returned to a caller.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "../../contracts/capsule/identity";
import { randomApplicationRef } from "../application-reference";

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
export interface PromotionAuthorizationIdProvider {
  nextPromotionAuthorizationId(): string;
  nextPromotionAuthorizationRef(): string;
  nextPromotionAuthorizationActId(): string;
}

export const cryptoPromotionAuthorizationIdProvider: PromotionAuthorizationIdProvider = {
  nextPromotionAuthorizationId: () => `mon:pauth:${randomOpaqueBody()}`,
  nextPromotionAuthorizationRef: randomApplicationRef,
  nextPromotionAuthorizationActId: () => `mon:pauthact:${randomOpaqueBody()}`,
};

/**
 * Opaque identity for Offer-package acceptances (Phase 1.44). Internal audit
 * only — no acceptance is ever named by a caller or shown to one.
 */
export interface PromotionOfferAcceptanceIdProvider {
  nextPromotionOfferAcceptanceId(): string;
}

export const cryptoPromotionOfferAcceptanceIdProvider: PromotionOfferAcceptanceIdProvider = {
  nextPromotionOfferAcceptanceId: () => `mon:pofacc:${randomOpaqueBody()}`,
};
