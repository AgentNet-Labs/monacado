/**
 * The browser half of drafting a Product (Phase 1.32) — pure, `fetch` injected.
 *
 * Sends exactly the facts the person entered — name, description, promotable,
 * availability, delivery — and nothing else: no account, participant, creator,
 * identifier, status, price, or any other Offer term. A blank description is
 * sent as `null`. A refusal reaches the person as one bounded sentence.
 */

import type {
  DeliveryMode,
  GeneralAvailabilityState,
} from "../../src/contracts/product/product.capsule";

export const PRODUCT_ENDPOINT = "/api/products";

export const PRODUCT_INVALID =
  "Check the product details. A name and a delivery type are required; the name can be up to 200 characters.";
export const PRODUCT_NOT_ELIGIBLE = "Only a Seller can add products.";
export const PRODUCT_SIGNED_OUT = "Your session has ended. Please sign in again.";
export const PRODUCT_FAILURE = "Unable to add the product. Please try again.";

export type ProductOutcome = { outcome: "created" } | { outcome: "failed"; message: string };

export interface ProductDraftFields {
  name: string;
  description: string;
  promotable: boolean;
  generalAvailabilityState: GeneralAvailabilityState;
  deliveryMode: DeliveryMode | null;
}

export async function submitDraftProduct(
  fields: ProductDraftFields,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<ProductOutcome> {
  if (fields.deliveryMode === null) return { outcome: "failed", message: PRODUCT_INVALID };

  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(PRODUCT_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: fields.name,
        description: fields.description.trim() === "" ? null : fields.description,
        promotable: fields.promotable,
        generalAvailabilityState: fields.generalAvailabilityState,
        deliveryMode: fields.deliveryMode,
      }),
    });
  } catch {
    return { outcome: "failed", message: PRODUCT_FAILURE };
  }

  if (response.ok) return { outcome: "created" };
  if (response.status === 401) return { outcome: "failed", message: PRODUCT_SIGNED_OUT };

  let code: unknown;
  try {
    code = ((await response.json()) as { error?: unknown }).error;
  } catch {
    code = undefined;
  }
  const message =
    code === "INVALID_PRODUCT_REQUEST"
      ? PRODUCT_INVALID
      : code === "PRODUCT_NOT_ELIGIBLE"
        ? PRODUCT_NOT_ELIGIBLE
        : PRODUCT_FAILURE;
  return { outcome: "failed", message };
}
