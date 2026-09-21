/**
 * The browser half of placing a Product in a Storefront (Phase 1.34) — pure,
 * `fetch` injected.
 *
 * Sends exactly two selectors: the Product's opaque application reference and
 * the Storefront's public handle. No account, participant, controller, internal
 * identifier, lifecycle, price, currency, or Offer term — none of them is a
 * field this module can even build. A refusal reaches the person as one bounded
 * sentence.
 */

export const PLACEMENT_ENDPOINT = "/api/listings";

export const PLACEMENT_INVALID = "Choose a product and a storefront.";
export const PLACEMENT_NOT_AVAILABLE =
  "That product or storefront isn't available to you. Refresh the page and try again.";
export const PLACEMENT_NOT_ELIGIBLE = "Only a Seller can add products to a storefront.";
export const PLACEMENT_ALREADY_EXISTS =
  "That product is already in that storefront.";
export const PLACEMENT_SIGNED_OUT = "Your session has ended. Please sign in again.";
export const PLACEMENT_FAILURE = "Unable to add the listing. Please try again.";

export type PlacementOutcome = { outcome: "created" } | { outcome: "failed"; message: string };

export interface PlacementFields {
  productRef: string;
  storefrontHandle: string;
}

export async function submitPlacement(
  fields: PlacementFields,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<PlacementOutcome> {
  if (fields.productRef === "" || fields.storefrontHandle === "") {
    return { outcome: "failed", message: PLACEMENT_INVALID };
  }

  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(PLACEMENT_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        productRef: fields.productRef,
        storefrontHandle: fields.storefrontHandle,
      }),
    });
  } catch {
    return { outcome: "failed", message: PLACEMENT_FAILURE };
  }

  if (response.ok) return { outcome: "created" };
  if (response.status === 401) return { outcome: "failed", message: PLACEMENT_SIGNED_OUT };

  let code: unknown;
  try {
    code = ((await response.json()) as { error?: unknown }).error;
  } catch {
    code = undefined;
  }
  const message =
    code === "INVALID_LISTING_REQUEST"
      ? PLACEMENT_INVALID
      : code === "PLACEMENT_NOT_AVAILABLE"
        ? PLACEMENT_NOT_AVAILABLE
        : code === "LISTING_NOT_ELIGIBLE"
          ? PLACEMENT_NOT_ELIGIBLE
          : code === "LISTING_ALREADY_EXISTS"
            ? PLACEMENT_ALREADY_EXISTS
            : PLACEMENT_FAILURE;
  return { outcome: "failed", message };
}
