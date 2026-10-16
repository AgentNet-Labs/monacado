/**
 * Product completeness — `PRODUCT_COMPLETENESS_V1` (Phase 1.38).
 *
 * The ONE evaluator of whether a Product's authoritative content is complete,
 * implementing the governing profile in `docs/PRODUCT_COMPLETENESS_PROFILE.md`.
 * Every caller — the account page today, Product activation later — asks here,
 * so the rule exists once.
 *
 * ## What it reads
 *
 * Only **Seller-authoritative** facts of the Product's **current authoritative
 * source version** (profile §2–§3): `name`, `description`, `deliveryMode`, and —
 * for a Seller-shipped Product — the Seller shipping policy. The input is a
 * plain projection of that version; callers obtain it from the version row the
 * stable Product record points at (`product-completeness-service.ts`), never
 * from a capsule, a publication, or a caller's assertion.
 *
 * ## What it deliberately does not read
 *
 *   - `taxClassification` — Monacado operational data; a Product may be
 *     complete while it is unresolved (profile §5.2);
 *   - `generalAvailabilityState` (profile §5.3);
 *   - `recordStatus`, including `authoring-complete` (profile §5.4);
 *   - image, specifications, capabilities, or any other optional fact (§4.4);
 *   - anything about the Seller, Storefronts, Listings, Offers, or readiness.
 *
 * The input type has no member for any of them, so none can leak in.
 *
 * ## What it answers
 *
 * Content completeness and nothing else. It is **not** Product lifecycle: it
 * produces no `COMPLETE` / `ACTIVE` state, persists nothing, and says nothing
 * about whether the Product may transact.
 *
 * Pure and deterministic: same input, same answer. No database, clock, or I/O.
 */

import { DeliveryMode } from "./product.capsule";
import { ProductShippingPolicy, deliveryModeIsSellerShipped } from "./product-shipping-policy";

/** The governed profile this evaluator implements. */
export const PRODUCT_COMPLETENESS_PROFILE_V1 = "PRODUCT_COMPLETENESS_V1" as const;
export type ProductCompletenessProfile = typeof PRODUCT_COMPLETENESS_PROFILE_V1;

/**
 * Why a Product is not complete. A closed vocabulary, safe to show the Seller,
 * reported in this fixed order.
 */
export const PRODUCT_COMPLETENESS_GAPS = [
  "NAME_MISSING",
  "DESCRIPTION_MISSING",
  "DELIVERY_MODE_MISSING",
  "SHIPPING_POLICY_MISSING",
] as const;
export type ProductCompletenessGap = (typeof PRODUCT_COMPLETENESS_GAPS)[number];

/**
 * The Seller-authoritative facts completeness reads, as the current source
 * version holds them. Values are taken as stored — possibly absent, possibly
 * malformed in a historical row — and judged here rather than trusted.
 */
export interface ProductCompletenessInput {
  name: string | null | undefined;
  description: string | null | undefined;
  deliveryMode: string | null | undefined;
  shippingPolicy: unknown;
}

export interface ProductCompletenessResult {
  profile: ProductCompletenessProfile;
  complete: boolean;
  /** Every failing requirement, in `PRODUCT_COMPLETENESS_GAPS` order. Empty iff complete. */
  missing: ProductCompletenessGap[];
}

/** Present and not blank once surrounding whitespace is ignored. */
function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Evaluate `PRODUCT_COMPLETENESS_V1` against one source version's facts.
 *
 * Required (profile §4.1): `name`, `description`, `deliveryMode` — each present
 * and valid. Conditional (§4.2): a Seller-shipped Product needs a valid Seller
 * shipping policy; `FREE` counts, `FIXED` counts only with a valid positive
 * charge in a supported currency, and absence never counts. A Product whose
 * delivery mode is missing reports that alone: whether it is shipped is not yet
 * a fact, so no shipping requirement can be judged.
 */
export function evaluateProductCompletenessV1(
  input: ProductCompletenessInput,
): ProductCompletenessResult {
  const missing: ProductCompletenessGap[] = [];

  if (!hasText(input.name)) missing.push("NAME_MISSING");
  if (!hasText(input.description)) missing.push("DESCRIPTION_MISSING");

  const mode = DeliveryMode.safeParse(input.deliveryMode);
  if (!mode.success) {
    missing.push("DELIVERY_MODE_MISSING");
  } else if (deliveryModeIsSellerShipped(mode.data)) {
    if (!ProductShippingPolicy.safeParse(input.shippingPolicy).success) {
      missing.push("SHIPPING_POLICY_MISSING");
    }
  }

  return { profile: PRODUCT_COMPLETENESS_PROFILE_V1, complete: missing.length === 0, missing };
}

/**
 * The completeness input carried by a validated Product source record.
 *
 * Structural, so it accepts a `ProductSourceRecord` without importing it (the
 * source-record module imports this one's neighbours, not the other way round).
 */
export function productCompletenessInputFromRecord(record: {
  facts: { name: string; description?: string | undefined; deliveryMode?: string | undefined };
  shippingPolicy?: unknown;
}): ProductCompletenessInput {
  return {
    name: record.facts.name,
    description: record.facts.description,
    deliveryMode: record.facts.deliveryMode,
    shippingPolicy: record.shippingPolicy,
  };
}
