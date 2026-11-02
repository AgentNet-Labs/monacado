/**
 * The browser half of taking a Storefront live (Phase 1.46) — pure, `fetch`
 * injected.
 *
 * Sends the handle in the path and an empty JSON object: the act names its own
 * target state, so there is nothing to build. A refusal reaches the person as
 * one bounded sentence, with the domain's reasons translated where it gave any.
 */

export const storefrontGoLiveEndpoint = (publicHandle: string): string =>
  `/api/storefronts/${encodeURIComponent(publicHandle)}/go-live`;

export const GO_LIVE_NOT_AVAILABLE = "That storefront isn't available to you. Refresh the page and try again.";
export const GO_LIVE_ALREADY_LIVE = "That storefront is already live. Refresh the page to see it.";
export const GO_LIVE_SIGNED_OUT = "Your session has ended. Please sign in again.";
export const GO_LIVE_FAILURE = "Unable to take the storefront live. Please try again.";

/** Closed reasons the domain may give a governor, as one short clause each. */
const GO_LIVE_BLOCKER_TEXT: Readonly<Record<string, string>> = {
  SUPER_OWNER_REQUIRED: "only the storefront's owner seat can take it live",
  ACTIVE_SUPER_OWNER_NOT_APPOINTED: "the storefront has no active owner seat",
  MULTIPLE_ACTIVE_SUPER_OWNERS: "the storefront has more than one owner seat",
  GO_LIVE_NOT_APPROVED: "Monacado has not yet approved this account for commerce",
  OWNER_EMAIL_UNVERIFIED: "the owner's email address is not verified",
  PARTICIPANT_NOT_PERMITTED: "this account is not currently permitted to go live",
  STOREFRONT_CLOSED: "the storefront is closed",
  STOREFRONT_LIFECYCLE_TRANSITION_NOT_PERMITTED: "the storefront cannot go live from its current state",
};
const GO_LIVE_OTHER_BLOCKER = "the account is not yet ready to sell (admission or payment setup)";

export type GoLiveOutcome = { outcome: "live" } | { outcome: "failed"; message: string };

export function goLiveRefusalMessage(blockers: readonly string[]): string {
  const clauses = Array.from(new Set(blockers.map((b) => GO_LIVE_BLOCKER_TEXT[b] ?? GO_LIVE_OTHER_BLOCKER)));
  if (clauses.length === 0) return GO_LIVE_FAILURE;
  return `This storefront can't go live yet: ${clauses.join("; ")}.`;
}

export async function submitStorefrontGoLive(
  publicHandle: string,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<GoLiveOutcome> {
  if (publicHandle === "") return { outcome: "failed", message: GO_LIVE_NOT_AVAILABLE };

  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(storefrontGoLiveEndpoint(publicHandle), {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
  } catch {
    return { outcome: "failed", message: GO_LIVE_FAILURE };
  }

  if (response.ok) return { outcome: "live" };
  if (response.status === 401) return { outcome: "failed", message: GO_LIVE_SIGNED_OUT };

  let body: { error?: unknown; blockers?: unknown } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    body = {};
  }
  if (body.error === "STOREFRONT_GO_LIVE_REFUSED") {
    const blockers = Array.isArray(body.blockers) ? body.blockers.filter((b): b is string => typeof b === "string") : [];
    return { outcome: "failed", message: goLiveRefusalMessage(blockers) };
  }
  const message =
    body.error === "STOREFRONT_NOT_FOUND"
      ? GO_LIVE_NOT_AVAILABLE
      : body.error === "STOREFRONT_ALREADY_LIVE"
        ? GO_LIVE_ALREADY_LIVE
        : GO_LIVE_FAILURE;
  return { outcome: "failed", message };
}
