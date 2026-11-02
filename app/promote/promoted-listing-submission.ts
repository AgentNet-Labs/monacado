/**
 * The browser half of the Promoter's "Your listing" panel (Phase 1.46) —
 * pure, `fetch` injected.
 *
 * Four acts over the Phase 1.45 routes, each sending references and a price
 * and nothing else: create a draft in a Storefront, set its price, activate it
 * at the version shown, withdraw it. A refusal reaches the Promoter as one
 * bounded sentence; activation blockers are listed by the codes the gate gave.
 */

export const promotedListingCreateEndpoint = (productRef: string): string =>
  `/api/products/${encodeURIComponent(productRef)}/promoted-listings`;
export const promotedListingActEndpoint = (listingRef: string, act: "price" | "activate" | "withdraw"): string =>
  `/api/promoted-listings/${encodeURIComponent(listingRef)}/${act}`;

export const PROMOTED_LISTING_SIGNED_OUT = "Your session has ended. Please sign in again.";
export const PROMOTED_LISTING_FAILURE = "That didn't work. Please try again.";

/** One short sentence per route error code. */
const ERROR_TEXT: Readonly<Record<string, string>> = {
  INVALID_PROMOTED_LISTING_REQUEST: "That request wasn't valid. Refresh the page and try again.",
  INVALID_RETAIL_AMOUNT: "Enter a price in US dollars, for example 19.99.",
  PRODUCT_NOT_AVAILABLE: "This product isn't available to promote.",
  STOREFRONT_NOT_AVAILABLE: "That storefront isn't available to you.",
  LISTING_NOT_AVAILABLE: "That listing isn't available to you. Refresh the page.",
  PROMOTED_LISTING_NOT_ELIGIBLE: "Your account can't place promoted listings in that storefront right now.",
  PROMOTED_LISTING_REFUSED: "That isn't possible under your current promotion terms.",
  PROMOTED_LISTING_ECONOMICS_REFUSED: "That price doesn't work under the Seller's terms. Check the minimum price.",
  PROMOTED_LISTING_NOT_READY: "This listing can't go live yet.",
  LISTING_ALREADY_PLACED: "This product is already listed in that storefront.",
  LISTING_PRICE_UNCHANGED: "That's already the price.",
  LISTING_VERSION_STALE: "This listing changed since the page loaded. Refresh and try again.",
  LISTING_NOT_WITHDRAWABLE: "This listing can no longer be withdrawn.",
};

export type PromotedListingOutcome = { outcome: "done" } | { outcome: "failed"; message: string; blockers: string[] };

/** A closed code as words: `TERMS_NOT_ACCEPTED` → "terms not accepted". */
export function blockerText(code: string): string {
  return code.toLowerCase().replace(/_/g, " ");
}

async function post(
  url: string,
  body: unknown,
  deps: { fetchImpl?: typeof fetch },
): Promise<PromotedListingOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { outcome: "failed", message: PROMOTED_LISTING_FAILURE, blockers: [] };
  }
  if (response.ok) return { outcome: "done" };
  if (response.status === 401) return { outcome: "failed", message: PROMOTED_LISTING_SIGNED_OUT, blockers: [] };
  let parsed: { error?: unknown; reason?: unknown; blockers?: unknown } = {};
  try {
    parsed = (await response.json()) as typeof parsed;
  } catch {
    parsed = {};
  }
  const code = typeof parsed.error === "string" ? parsed.error : "";
  const blockers = Array.isArray(parsed.blockers)
    ? parsed.blockers.filter((b): b is string => typeof b === "string")
    : typeof parsed.reason === "string"
      ? [parsed.reason]
      : [];
  return { outcome: "failed", message: ERROR_TEXT[code] ?? PROMOTED_LISTING_FAILURE, blockers };
}

export function submitCreatePromotedListing(
  productRef: string,
  input: { storefrontHandle: string; amount: string },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<PromotedListingOutcome> {
  const amount = input.amount.trim();
  return post(
    promotedListingCreateEndpoint(productRef),
    { storefrontHandle: input.storefrontHandle, ...(amount === "" ? {} : { retail: { amount, currency: "USD" } }) },
    deps,
  );
}

export function submitPromotedListingPrice(
  listingRef: string,
  amount: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<PromotedListingOutcome> {
  return post(promotedListingActEndpoint(listingRef, "price"), { amount: amount.trim(), currency: "USD" }, deps);
}

export function submitPromotedListingActivation(
  listingRef: string,
  expectedVersion: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<PromotedListingOutcome> {
  return post(promotedListingActEndpoint(listingRef, "activate"), { expectedVersion }, deps);
}

export function submitPromotedListingWithdrawal(
  listingRef: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<PromotedListingOutcome> {
  return post(promotedListingActEndpoint(listingRef, "withdraw"), {}, deps);
}
