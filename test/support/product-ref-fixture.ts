/**
 * A synthetic `Product.productRef` for a test fixture that writes a `Product`
 * row directly (Phase 1.34).
 *
 * `productRef` is NOT NULL and unique, and the application mints it inside
 * `ProductRepository.createInitialProductSourceRecord` — deliberately, so no
 * caller can choose one. A fixture that bypasses the repository and inserts a
 * row itself therefore has to supply its own, and this is the one place that
 * knows how, so a test never hand-rolls a value in the wrong shape.
 *
 * Drawn from the same alphabet and at the same length as the production
 * generator, so a fixture row is indistinguishable in shape from a real one and
 * the format assertions hold over both. Random rather than seeded because the
 * only property a fixture needs is uniqueness, and a seed counter shared across
 * suites would be one more thing to keep in step.
 */

import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "../../src/contracts/capsule/identity";

const LENGTH = 32;

export function syntheticProductRef(): string {
  const bytes = randomBytes(LENGTH);
  let out = "";
  for (let i = 0; i < LENGTH; i += 1) {
    out += CROCKFORD_ALPHABET[bytes[i]! % CROCKFORD_ALPHABET.length];
  }
  return out;
}
