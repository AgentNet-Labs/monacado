/**
 * The tax destination (Phase 1.6, settled).
 *
 * **One rule, one input, no choice: tax is sourced to the ship-to address.**
 *
 * ## What this replaced, and why nothing is left of it
 *
 * Two earlier shapes existed inside this uncommitted phase and both are gone.
 * The first sourced everything to billing. The second chose between billing and
 * shipping according to what the basket delivered, and carried a
 * `BILLING | SHIPPING` enum through the request, the quote, and the evidence
 * column to record which branch had been taken.
 *
 * Standard Monacado retail checkout now collects **both** addresses on every
 * purchase — billing for payment, ship-to for destination — so the branch cannot
 * occur. What remains is a normalization: take the Order's required ship-to
 * address, validate it, and reduce it to the bounded fields a tax engine needs.
 *
 * The enum went with the branch. A two-member vocabulary with one legitimate
 * production value is worse than no vocabulary: every reader has to work out
 * which member is real, and the dead one is an invitation to make it reachable
 * again.
 *
 * **There is no other tax-location concept.** Not a buyer-declared location, not
 * a billing tax-source mode, not an IP, not proxy piercing, not device location.
 * The buyer nominates one destination and pays tax for it.
 *
 * ## What it is not
 *
 * **Not a claim to have solved international sourcing.** It decides which
 * transaction facts Monacado supplies; the provider determines the tax result
 * from them. Origin sourcing, marketplace-facilitator rules, VAT place-of-supply
 * for digital services, and reverse charge are all the engine's to apply.
 *
 * **Not a fulfillment decision.** A ship-to address on a digital purchase is a
 * tax destination and nothing more — no parcel, no carrier. Whether anything
 * physically ships is `evaluateBasketFulfillment`'s question, and the two are
 * deliberately separate.
 *
 * Pure types and pure decisions. No I/O, no clock, no vendor.
 */

import type { TaxDestination } from "./tax-calculation";
import { PostalAddress } from "./order-buyer-snapshot";

/**
 * No ship-to address could be resolved, so no calculation may be made.
 *
 * Bounded, and **carries no address** — a sourcing failure is exactly the log
 * line an address ends up in. Its `detail` matches the checkout refusal a caller
 * already handles, so one condition keeps one name.
 */
export class TaxDestinationError extends Error {
  readonly code = "SHIP_TO_ADDRESS_REQUIRED";
  readonly detail = "SHIPPING_ADDRESS_REQUIRED";
  constructor() {
    super("A ship-to address is required before tax can be calculated");
    this.name = "TaxDestinationError";
  }
}

/**
 * The bounded destination a tax engine is given, from the Order's ship-to address.
 *
 * **Three fields, and the boundary is the point.** Country is what every regime
 * needs; subdivision is the difference between a correct US or Canadian rate and
 * a wrong one; postal code is the smallest element that resolves a municipal
 * rate. There is deliberately **no `line1`, `line2`, `city`, `name`, or
 * `email`** — a tax engine does not need a street to compute a rate, and a field
 * that exists is a field that ends up in a log.
 *
 * Refuses an absent or malformed address rather than falling back to billing.
 * A fallback here would tax a sale to an address the buyer never nominated, and
 * the resulting quote would look exactly like a correct one.
 */
export function resolveTaxDestination(shipToAddress: PostalAddress | null): TaxDestination {
  const parsed = PostalAddress.safeParse(shipToAddress);
  if (!parsed.success) throw new TaxDestinationError();
  return {
    countryCode: parsed.data.countryCode,
    regionCode: parsed.data.region,
    postalCode: parsed.data.postalCode,
  };
}
