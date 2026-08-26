/**
 * Stable refund and tax-reversal idempotency keys (Phase 1.9) — SERVER ONLY.
 *
 * One question, asked of two providers: **is this the same correction we already
 * asked for?**
 *
 * ## Derived from durable identity, and from nothing else
 *
 * Both keys are a digest of Monacado identifiers that are fixed before the first
 * attempt and immutable afterwards. **No clock, no attempt counter, no
 * randomness.**
 *
 * That is deliberate and load-bearing. A key that varied per attempt would make
 * every retry a fresh request, which is the same as having no key: a timeout
 * followed by a retry would return the buyer's money **twice**, and the second
 * refund would look exactly as legitimate as the first. This is the single most
 * expensive mistake available in this phase, and the shape of the key is what
 * prevents it.
 *
 * ## The refund key includes the original charge on purpose
 *
 * `1.7`'s recording key digests the Order plus the calculation; this one digests
 * the refund id plus the original provider transaction. Including the charge
 * means a key can never be reused against a *different* charge even if a refund
 * row were somehow re-pointed — the key would change, and the provider would
 * treat it as the new request it is, rather than silently returning the old
 * refund's result for a charge nobody meant to refund.
 *
 * ## Two guards, not one
 *
 * For the tax reversal, Stripe's own `reference` uniqueness across all
 * transactions **including reversals** is the guard that cannot be lost, exactly
 * as in `1.7`. This key protects the common case — a network timeout inside the
 * retry window — and the provider's rule protects everything else, including a
 * key that expired.
 *
 * Stripe's Refunds API has no equivalent second guard, which is why the refund
 * key is derived from immutable identity rather than anything a caller supplies.
 *
 * ## They disclose nothing
 *
 * Every input is an opaque Monacado or provider identifier, and what leaves is 64
 * hex characters. No amount, buyer, reason, or address is an input, so none can
 * be recovered from the output.
 */

import "../server-only";
import { createHash } from "node:crypto";
import { canonicalJsonString } from "../../contracts/integrity/canonical-json";

/** Namespaces the key so it can never collide with a payment or tax key. */
export const REFUND_IDEMPOTENCY_KEY_PREFIX = "mon-refnd-";
export const TAX_REVERSAL_IDEMPOTENCY_KEY_PREFIX = "mon-txrvs-";

export function refundIdempotencyKey(input: {
  refundId: string;
  providerTransactionRef: string;
}): string {
  const material = canonicalJsonString({
    refundId: input.refundId,
    providerTransactionRef: input.providerTransactionRef,
  });
  return `${REFUND_IDEMPOTENCY_KEY_PREFIX}${createHash("sha256")
    .update(material)
    .digest("hex")}`;
}

export function taxReversalIdempotencyKey(input: {
  taxReversalId: string;
  originalProviderTaxTransactionRef: string;
}): string {
  const material = canonicalJsonString({
    taxReversalId: input.taxReversalId,
    originalProviderTaxTransactionRef: input.originalProviderTaxTransactionRef,
  });
  return `${TAX_REVERSAL_IDEMPOTENCY_KEY_PREFIX}${createHash("sha256")
    .update(material)
    .digest("hex")}`;
}
