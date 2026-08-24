/**
 * Stable tax-calculation idempotency keys (Phase 1.6) — SERVER ONLY.
 *
 * One question: **is this the same calculation we already asked for?**
 *
 * ## Why it cannot be the Order id
 *
 * `1.0` made the Order id the payment idempotency key, and the obvious move here
 * is to reuse it. It does not work: tax is calculated **before** `placeOrder`
 * commits — deliberately, because an Order whose tax nobody could compute must
 * never exist — so at the moment the engine is called there is no Order id to
 * key on. Minting one early to have a key would mean inventing an Order for a
 * checkout that may be refused.
 *
 * ## What it is instead
 *
 * A digest of **the calculation's own facts**: currency, the two amounts, the
 * Product source version, the classification, the delivery mode, the seller, and
 * the ship-to destination. That gives exactly the property idempotency needs —
 *
 *   - a buyer who reloads, retries, or double-submits the *same* checkout
 *     produces the *same* key, so the provider returns the calculation it already
 *     made rather than making a second one;
 *   - any change that could change the tax owed — a repriced Listing, a different
 *     ship-to postal code, a reclassified Product — produces a *different* key, so
 *     a stale calculation is never reused for a sale it was not computed for.
 *
 * The instant is deliberately **excluded**. Including it would make every retry a
 * fresh key, which is the same as having no key at all.
 *
 * ## It discloses nothing
 *
 * The ship-to postal code is an input to the digest and never an output of it:
 * what leaves this module is 64 hex characters, sent to a provider that already
 * has the destination, and stored nowhere. A key that echoed a fragment of an
 * address would be a key that put one in a log.
 */

import "../server-only";
import { createHash } from "node:crypto";
import type { TaxCalculationRequest } from "../../contracts/marketplace/tax-calculation";
import { canonicalJsonString } from "../../contracts/integrity/canonical-json";

/** Namespaces the key, so it can never collide with a payment idempotency key. */
export const TAX_IDEMPOTENCY_KEY_PREFIX = "mon-tax-";

/**
 * The stable key for one tax calculation.
 *
 * Built from a canonical JSON rendering, so key ordering in the request object
 * cannot change the digest — the same reason every other hash in this repository
 * goes through `canonicalJsonString` rather than `JSON.stringify`.
 */
export function taxCalculationIdempotencyKey(
  request: Omit<TaxCalculationRequest, "at" | "idempotencyKey">,
): string {
  const material = canonicalJsonString({
    currency: request.currency,
    commercialRetailAmountMinorUnits: request.commercialRetailAmountMinorUnits,
    shippingAmountMinorUnits: request.shippingAmountMinorUnits,
    internalProductId: request.internalProductId,
    sellerParticipantId: request.sellerParticipantId,
    destination: request.destination,
    product: request.product,
  });
  return `${TAX_IDEMPOTENCY_KEY_PREFIX}${createHash("sha256").update(material).digest("hex")}`;
}
