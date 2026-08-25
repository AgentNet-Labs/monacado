/**
 * Stable tax-transaction idempotency keys (Phase 1.7) — SERVER ONLY.
 *
 * One question: **is this the same report we already asked the provider to
 * make?**
 *
 * ## Unlike the calculation key, this one CAN be Order-derived
 *
 * `1.6` could not key its calculation on the Order, because tax is computed
 * before `placeOrder` commits and there is no Order id yet. By the time a tax
 * transaction is recorded the sale is paid: the Order exists, its calculation
 * reference is fixed, and both are immutable. So the key is simply a digest of
 * the two — no clock, no attempt counter, no randomness.
 *
 * That is deliberate and load-bearing. A key that varied per attempt would make
 * every retry a fresh request, which is the same as having no key: a timeout
 * followed by a retry would create a *second* Tax Transaction for one sale, and
 * the sale would appear twice in a filing.
 *
 * ## It is the weaker of two guards, and that is fine
 *
 * Stripe's own `reference` uniqueness is the guard that cannot be lost. This one
 * protects the common case — a network timeout inside the retry window — and the
 * provider's rule protects everything else, including a key that expired.
 *
 * ## It discloses nothing
 *
 * Both inputs are opaque Monacado and provider identifiers, and what leaves is 64
 * hex characters. No amount, jurisdiction, or address is an input, so none can be
 * recovered from the output.
 */

import "../server-only";
import { createHash } from "node:crypto";
import { canonicalJsonString } from "../../contracts/integrity/canonical-json";

/** Namespaces the key so it can never collide with a calculation or payment key. */
export const TAX_TRANSACTION_IDEMPOTENCY_KEY_PREFIX = "mon-taxtx-";

export function taxTransactionIdempotencyKey(input: {
  orderId: string;
  providerCalculationRef: string;
}): string {
  const material = canonicalJsonString({
    orderId: input.orderId,
    providerCalculationRef: input.providerCalculationRef,
  });
  return `${TAX_TRANSACTION_IDEMPOTENCY_KEY_PREFIX}${createHash("sha256")
    .update(material)
    .digest("hex")}`;
}
