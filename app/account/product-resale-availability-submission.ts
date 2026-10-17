/**
 * The browser half of setting a Product's resale availability (Phase 1.40) —
 * pure, `fetch` injected.
 *
 * Sends the Product's opaque reference in the path and one body field: the
 * target state. Nothing else — no lifecycle, Storefront, Listing, Offer, or
 * Promoter — so the request cannot skip the server's lifecycle gate or its
 * governed transitions. A refusal reaches the person as one bounded sentence.
 */

import type { ProductResaleAvailability } from "../../src/contracts/product/product-resale-availability";
import { RESALE_REQUIRES_ACTIVE } from "./account-home-copy";

export const productResaleAvailabilityEndpoint = (productRef: string): string =>
  `/api/products/${encodeURIComponent(productRef)}/resale-availability`;

export const RESALE_NOT_AVAILABLE = "This product isn't available to change.";
export const RESALE_NOT_GOVERNED = "That resale change isn't available for this product.";
export const RESALE_CONFLICT = "This product changed while you were updating it. Reload the page and try again.";
export const RESALE_SIGNED_OUT = "Your session has ended. Please sign in again.";
export const RESALE_FAILURE = "Unable to update resale availability. Please try again.";

export type ResaleAvailabilityOutcome = { outcome: "updated" } | { outcome: "failed"; message: string };

export async function submitProductResaleAvailability(
  fields: { productRef: string; resaleAvailability: ProductResaleAvailability },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<ResaleAvailabilityOutcome> {
  if (fields.productRef === "") return { outcome: "failed", message: RESALE_NOT_AVAILABLE };

  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(productResaleAvailabilityEndpoint(fields.productRef), {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resaleAvailability: fields.resaleAvailability }),
    });
  } catch {
    return { outcome: "failed", message: RESALE_FAILURE };
  }

  if (response.ok) return { outcome: "updated" };
  if (response.status === 401) return { outcome: "failed", message: RESALE_SIGNED_OUT };

  let code: unknown;
  try {
    code = ((await response.json()) as { error?: unknown }).error;
  } catch {
    code = undefined;
  }
  const message =
    code === "PRODUCT_NOT_AVAILABLE"
      ? RESALE_NOT_AVAILABLE
      : code === "RESALE_AVAILABILITY_REQUIRES_ACTIVE_PRODUCT"
        ? RESALE_REQUIRES_ACTIVE
        : code === "RESALE_AVAILABILITY_TRANSITION_NOT_GOVERNED"
          ? RESALE_NOT_GOVERNED
          : code === "RESALE_AVAILABILITY_CONFLICT"
            ? RESALE_CONFLICT
            : RESALE_FAILURE;
  return { outcome: "failed", message };
}
