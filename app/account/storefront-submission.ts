/**
 * The browser half of draft Storefront creation (Phase 1.30) — pure, `fetch`
 * injected.
 *
 * Sends exactly the display name and handle the person typed, unaltered: no
 * owner, participant, account, governance role, lifecycle, visibility, or
 * instant. A handle is never "fixed" here — the domain refuses a malformed one
 * rather than normalizing it, and so does this.
 *
 * A refusal reaches the person as one bounded sentence, never as whatever the
 * server said.
 */

export const STOREFRONT_ENDPOINT = "/api/storefronts";

export const STOREFRONT_INVALID =
  "Check the storefront name and handle. Handles use 3–63 lowercase letters, numbers, and single hyphens.";
export const STOREFRONT_HANDLE_TAKEN = "That handle is already taken. Please choose another.";
export const STOREFRONT_NOT_ELIGIBLE = "Your account can't create a storefront right now.";
export const STOREFRONT_UPGRADE_REQUIRED = "Additional storefronts require an upgrade.";
export const STOREFRONT_SIGNED_OUT = "Your session has ended. Please sign in again.";
export const STOREFRONT_FAILURE = "Unable to create the storefront. Please try again.";

export type StorefrontOutcome = { outcome: "created" } | { outcome: "failed"; message: string };

export interface StorefrontSubmissionDeps {
  fetchImpl?: typeof fetch;
}

export async function submitDraftStorefront(
  input: { displayName: string; publicHandle: string },
  deps: StorefrontSubmissionDeps = {},
): Promise<StorefrontOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(STOREFRONT_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName: input.displayName, publicHandle: input.publicHandle }),
    });
  } catch {
    return { outcome: "failed", message: STOREFRONT_FAILURE };
  }

  if (response.ok) return { outcome: "created" };
  if (response.status === 401) return { outcome: "failed", message: STOREFRONT_SIGNED_OUT };

  let code: unknown;
  try {
    code = ((await response.json()) as { error?: unknown }).error;
  } catch {
    code = undefined;
  }
  const message =
    code === "INVALID_STOREFRONT_REQUEST"
      ? STOREFRONT_INVALID
      : code === "STOREFRONT_HANDLE_UNAVAILABLE"
        ? STOREFRONT_HANDLE_TAKEN
        : code === "STOREFRONT_NOT_ELIGIBLE"
          ? STOREFRONT_NOT_ELIGIBLE
          : code === "STOREFRONT_UPGRADE_REQUIRED"
            ? STOREFRONT_UPGRADE_REQUIRED
            : STOREFRONT_FAILURE;
  return { outcome: "failed", message };
}
