/**
 * Opaque identity for Product activations, Product suspensions, and Product
 * tax-classification acts (Phase 1.39)
 * — SERVER ONLY.
 *
 * Its own provider, on `participant-commerce-approval-ids`' reasoning: widening
 * a shared provider would add required methods to interfaces unrelated suites
 * implement. Same construction as every other provider: `crypto.randomBytes`
 * over the Crockford alphabet, bias-free because 256 is a multiple of 32.
 *
 * The identifier encodes nothing — not the Product, the Seller, the instant, or
 * the decision. Neither is ever returned to a caller.
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

/** Injectable identity source; a test supplies deterministic ids. */
export interface ProductLifecycleIdProvider {
  nextProductActivationId(): string;
  nextProductSuspensionId(): string;
  nextProductTaxClassificationId(): string;
}

export const cryptoProductLifecycleIdProvider: ProductLifecycleIdProvider = {
  nextProductActivationId: () => `mon:pdact:${randomOpaqueBody()}`,
  nextProductSuspensionId: () => `mon:pdsus:${randomOpaqueBody()}`,
  nextProductTaxClassificationId: () => `mon:pdtax:${randomOpaqueBody()}`,
};

/**
 * Seller resale-availability acts (Phase 1.40). A separate provider, so the
 * lifecycle provider's implementers are not asked for a method they never use.
 */
export interface ProductResaleAvailabilityIdProvider {
  nextProductResaleAvailabilityActId(): string;
}

export const cryptoProductResaleAvailabilityIdProvider: ProductResaleAvailabilityIdProvider = {
  nextProductResaleAvailabilityActId: () => `mon:pdrsa:${randomOpaqueBody()}`,
};
