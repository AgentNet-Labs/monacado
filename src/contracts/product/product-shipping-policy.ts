/**
 * Seller shipping policy for a Seller-shipped Product (Phase 1.38).
 *
 * The rule the Seller sets for how shipping is charged on this Product — a
 * **Seller-authoritative fulfillment fact** carried by the Product's immutable
 * source versions (`PRODUCT_COMPLETENESS_PROFILE.md` §5.1; Contract §9).
 *
 * ## What it is not
 *
 * It is **not the shipping amount charged on an Order**. That amount is
 * transaction economics: derived at checkout from this policy and other
 * governed inputs, and frozen on the Order / transaction snapshot. Nothing here
 * computes, quotes, or charges it, and no checkout path reads this policy yet.
 *
 * It is not a tax fact, not a payment fact, and not an Offer term; it sits
 * outside every fee and commission basis (Contract §17).
 *
 * ## Two methods, and only two
 *
 *   - `FREE`  — the Seller's explicit choice of free shipping. No amount.
 *   - `FIXED` — a fixed charge, in **integer minor units** of a currency
 *     Monacado prices in (`USD` today, from `retail-amount.ts`). Strictly
 *     positive: a zero charge is stated as `FREE`, never as `FIXED 0`, so
 *     "free" has exactly one spelling.
 *
 * Calculated, carrier, and rate-table methods are deliberately absent: none is
 * governed yet, and a member with no producer is a promise the code does not
 * keep.
 *
 * ## Absence is not FREE
 *
 * A Product with no policy has made **no shipping decision**. That is a
 * different fact from explicit free shipping, and nothing here or downstream
 * reads one as the other (`PRODUCT_COMPLETENESS_PROFILE.md` §4.2).
 *
 * ## Field names
 *
 * The Product source record is scanned by `findForbiddenFields`, a denylist
 * whose purpose is keeping **Offer** commercial terms (`price`, `currency`, …)
 * out of creator Product facts. The Seller shipping policy is governed Product
 * truth (Contract §9), not an Offer term, so its members are named for what
 * they are — `fixedChargeMinorUnits`, `fixedChargeCurrency` — rather than
 * borrowing the Offer vocabulary the scan exists to keep out.
 *
 * Pure data. No database, clock, environment read, or network.
 */

import { z } from "zod";
import { SupportedRetailCurrency } from "../marketplace/retail-amount";
import { MAX_MINOR_UNIT_AMOUNT } from "../marketplace/offer-source";
import type { DeliveryMode } from "./product.capsule";

export const SHIPPING_POLICY_METHODS = ["FREE", "FIXED"] as const;
export const ShippingPolicyMethod = z.enum(SHIPPING_POLICY_METHODS);
export type ShippingPolicyMethod = z.infer<typeof ShippingPolicyMethod>;

export const FreeShippingPolicy = z.strictObject({
  method: z.literal("FREE"),
});

export const FixedShippingPolicy = z.strictObject({
  method: z.literal("FIXED"),
  /** Integer minor units (cents for USD). Strictly positive — zero is `FREE`. */
  fixedChargeMinorUnits: z.int().min(1).max(MAX_MINOR_UNIT_AMOUNT),
  /** A currency Monacado prices in. Explicit, never defaulted. */
  fixedChargeCurrency: SupportedRetailCurrency,
});

export const ProductShippingPolicy = z.discriminatedUnion("method", [
  FreeShippingPolicy,
  FixedShippingPolicy,
]);
export type ProductShippingPolicy = z.infer<typeof ProductShippingPolicy>;

/**
 * Whether a Product with this delivery mode is shipped by its Seller.
 *
 * Under the current vocabulary (`DIGITAL` | `PHYSICAL`) a `PHYSICAL` Product is
 * Seller-shipped: the Seller remains the fulfillment party unless a different
 * arrangement is governed (`MONACADO_MOR_BUSINESS_MODEL.md` §F). An unknown or
 * absent mode is not Seller-shipped — it is not anything yet, and completeness
 * reports the missing mode on its own.
 */
export function deliveryModeIsSellerShipped(
  deliveryMode: DeliveryMode | null | undefined,
): boolean {
  return deliveryMode === "PHYSICAL";
}
