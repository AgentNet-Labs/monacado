/**
 * The browser half of pricing a draft placement (Phase 1.36) — pure, `fetch`
 * injected.
 *
 * Sends **one selector and one commercial fact**: the placement's opaque
 * reference travels in the path, and the body carries the amount exactly as the
 * person typed it plus the currency it is in. There is nothing else for this
 * module to build — no lifecycle, no Product, no Storefront, no participant, no
 * Offer, no commission, no tax, no shipping.
 *
 * **The amount is sent as a string, unaltered apart from trimming.** Parsing it
 * here would mean parsing money in the browser and sending the browser's answer
 * to the server, which is exactly the arrangement that lets a client's rounding
 * become an authoritative price. The server converts, and the server's answer
 * is the one that is stored. The only local check is that the field is not
 * blank — a person who typed nothing should be told so without a round trip,
 * and a blank must never be read as "clear the price", which is not an act this
 * phase exposes at all.
 *
 * A refusal reaches the person as one bounded sentence.
 */

export const placementPriceEndpoint = (listingRef: string): string =>
  `/api/listings/${encodeURIComponent(listingRef)}/price`;

export const PRICE_EMPTY = "Enter a price.";
export const PRICE_INVALID_AMOUNT =
  "Enter a price as an amount in US dollars, like 19.99. It must be more than zero.";
export const PRICE_NOT_AVAILABLE =
  "That listing isn't available to you. Refresh the page and try again.";
export const PRICE_NOT_REPRICEABLE =
  "That listing can no longer be priced here. Refresh the page to see its current state.";
export const PRICE_UNCHANGED = "That is already the price for this listing.";
export const PRICE_NOT_ELIGIBLE = "Only a Seller can price a storefront listing.";
export const PRICE_SIGNED_OUT = "Your session has ended. Please sign in again.";
export const PRICE_FAILURE = "Unable to save the price. Please try again.";

export type PriceOutcome = { outcome: "priced" } | { outcome: "failed"; message: string };

export interface PriceFields {
  listingRef: string;
  /** Exactly what was typed. Converted on the server, never here. */
  amount: string;
  currency: string;
}

export async function submitPlacementPrice(
  fields: PriceFields,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<PriceOutcome> {
  if (fields.listingRef === "") {
    return { outcome: "failed", message: PRICE_NOT_AVAILABLE };
  }
  const amount = fields.amount.trim();
  if (amount === "") return { outcome: "failed", message: PRICE_EMPTY };

  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(placementPriceEndpoint(fields.listingRef), {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount, currency: fields.currency }),
    });
  } catch {
    return { outcome: "failed", message: PRICE_FAILURE };
  }

  if (response.ok) return { outcome: "priced" };
  if (response.status === 401) return { outcome: "failed", message: PRICE_SIGNED_OUT };

  let code: unknown;
  try {
    code = ((await response.json()) as { error?: unknown }).error;
  } catch {
    code = undefined;
  }
  const message =
    code === "INVALID_RETAIL_AMOUNT" || code === "INVALID_LISTING_REQUEST"
      ? PRICE_INVALID_AMOUNT
      : code === "LISTING_NOT_AVAILABLE"
        ? PRICE_NOT_AVAILABLE
        : code === "LISTING_NOT_REPRICEABLE"
          ? PRICE_NOT_REPRICEABLE
          : code === "LISTING_PRICE_UNCHANGED"
            ? PRICE_UNCHANGED
            : code === "LISTING_NOT_ELIGIBLE"
              ? PRICE_NOT_ELIGIBLE
              : PRICE_FAILURE;
  return { outcome: "failed", message };
}
