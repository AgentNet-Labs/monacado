/**
 * Basket delivery requirements (Phase 1.2 correction).
 *
 * One derived decision: **does this checkout need a shipping address?**
 *
 * ## The rule
 *
 * ```
 * requiresShippingAddress = ANY line has deliveryMode PHYSICAL
 * ```
 *
 * All-digital baskets are never asked for an address. One physical item makes the
 * whole basket require one, so a **mixed basket requires shipping** — which falls
 * out of "any" rather than needing its own case. There is nowhere to ship half an
 * order to.
 *
 * ## Written for a basket, used on one item
 *
 * `0M.9` Orders bind a single Listing today. This still takes a **list**, because
 * the policy is a property of a *basket* and encoding today's one-item limit into
 * the rule would mean rewriting the policy — not just the plumbing — the day a
 * second line exists. A single-item checkout passes one element and the `any`
 * reduces to that Product's mode.
 *
 * ## Unknown fails closed
 *
 * A line whose delivery mode is absent is **refused**, never assumed. Guessing
 * `DIGITAL` would ship nothing to a buyer expecting a parcel; guessing `PHYSICAL`
 * would demand an address nobody needs. Both are worse than a checkout that says
 * it cannot proceed, and only one of them is silent.
 *
 * That matters because `deliveryMode` is optional on `ProductData` for backward
 * compatibility — Product versions written before the fact existed have none, and
 * this is what stops that compatibility allowance from becoming a default.
 *
 * Pure types and pure decisions. No I/O, no clock, no database.
 */

import { z } from "zod";
import { DeliveryMode } from "../product/product.capsule";

export { DELIVERY_MODES, DeliveryMode } from "../product/product.capsule";
export type { DeliveryMode as DeliveryModeType } from "../product/product.capsule";

// — Errors —

export class BasketFulfillmentError extends Error {
  readonly code: string;
  /** The Products whose delivery mode could not be determined. */
  readonly internalProductIds: readonly string[];
  constructor(code: string, message: string, internalProductIds: readonly string[] = []) {
    super(message);
    this.name = "BasketFulfillmentError";
    this.code = code;
    this.internalProductIds = internalProductIds;
  }
}

// — Lines —

/**
 * One purchasable line's delivery fact.
 *
 * `deliveryMode` is nullable to represent **"this Product does not say"** — the
 * backward-compatibility case — rather than to make absence tolerable. It is the
 * input that triggers the refusal below, not one that is quietly skipped.
 */
export const BasketDeliveryLine = z.strictObject({
  internalProductId: z.string().min(1).max(191),
  deliveryMode: DeliveryMode.nullable(),
});
export type BasketDeliveryLine = z.infer<typeof BasketDeliveryLine>;

/**
 * The basket's fulfillment requirement.
 *
 * Carries the decision *and* what produced it, so a caller — and a later reader
 * of a refused checkout — can see which Product made an address necessary rather
 * than only that one was.
 */
export interface BasketFulfillmentRequirement {
  requiresShippingAddress: boolean;
  /** Products that made shipping necessary. Empty for an all-digital basket. */
  physicalProductIds: string[];
}

/**
 * Decide whether this basket needs a shipping address.
 *
 * Throws rather than returning a decision when any line's mode is unknown, and
 * when the basket is empty. An empty basket has no delivery requirement to
 * derive, and answering `false` would let a caller proceed on a question nobody
 * actually asked.
 */
export function evaluateBasketFulfillment(
  lines: readonly BasketDeliveryLine[],
): BasketFulfillmentRequirement {
  if (lines.length === 0) {
    throw new BasketFulfillmentError(
      "EMPTY_BASKET",
      "A checkout basket must contain at least one line",
    );
  }

  const unknown = lines
    .filter((line) => line.deliveryMode === null)
    .map((line) => line.internalProductId);
  if (unknown.length > 0) {
    /* Fail closed. Absence is not a default — see the module header. */
    throw new BasketFulfillmentError(
      "DELIVERY_MODE_UNKNOWN",
      "This product does not declare how it is delivered, so checkout cannot proceed",
      unknown,
    );
  }

  const physicalProductIds = lines
    .filter((line) => line.deliveryMode === "PHYSICAL")
    .map((line) => line.internalProductId);

  return {
    requiresShippingAddress: physicalProductIds.length > 0,
    physicalProductIds,
  };
}
