/**
 * The browser half of withdrawing a draft placement (Phase 1.35) — pure,
 * `fetch` injected.
 *
 * Sends **one selector and no body at all**: the placement's opaque reference
 * travels in the path, and there is nothing else for this module to build — no
 * lifecycle, no Product, no Storefront, no participant, no price, no Offer. A
 * refusal reaches the person as one bounded sentence.
 */

export const placementWithdrawEndpoint = (listingRef: string): string =>
  `/api/listings/${encodeURIComponent(listingRef)}/withdraw`;

export const WITHDRAW_NOT_AVAILABLE =
  "That listing isn't available to you. Refresh the page and try again.";
export const WITHDRAW_NOT_WITHDRAWABLE =
  "That listing can no longer be removed here. Refresh the page to see its current state.";
export const WITHDRAW_NOT_ELIGIBLE = "Only a Seller can change a storefront listing.";
export const WITHDRAW_SIGNED_OUT = "Your session has ended. Please sign in again.";
export const WITHDRAW_FAILURE = "Unable to remove the listing. Please try again.";

export type WithdrawOutcome = { outcome: "withdrawn" } | { outcome: "failed"; message: string };

export async function submitPlacementWithdrawal(
  listingRef: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<WithdrawOutcome> {
  if (listingRef === "") return { outcome: "failed", message: WITHDRAW_NOT_AVAILABLE };

  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(placementWithdrawEndpoint(listingRef), {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {
    return { outcome: "failed", message: WITHDRAW_FAILURE };
  }

  if (response.ok) return { outcome: "withdrawn" };
  if (response.status === 401) return { outcome: "failed", message: WITHDRAW_SIGNED_OUT };

  let code: unknown;
  try {
    code = ((await response.json()) as { error?: unknown }).error;
  } catch {
    code = undefined;
  }
  const message =
    code === "LISTING_NOT_AVAILABLE"
      ? WITHDRAW_NOT_AVAILABLE
      : code === "LISTING_NOT_WITHDRAWABLE"
        ? WITHDRAW_NOT_WITHDRAWABLE
        : code === "LISTING_NOT_ELIGIBLE"
          ? WITHDRAW_NOT_ELIGIBLE
          : WITHDRAW_FAILURE;
  return { outcome: "failed", message };
}
