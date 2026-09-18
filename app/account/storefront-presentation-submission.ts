/**
 * The browser half of editing a Storefront's presentation (Phase 1.31) — pure,
 * `fetch` injected.
 *
 * Sends the complete presentation — name, tagline, summary — to the Storefront
 * named by its handle, and nothing else: no account, owner, governance, handle
 * change, lifecycle, visibility, or version label. A tagline or summary left
 * blank is sent as `null`, which is how the source model clears it; the name is
 * sent as typed, and the domain refuses a blank one.
 *
 * A refusal reaches the person as one bounded sentence, never as whatever the
 * server said.
 */

export const storefrontPresentationEndpoint = (publicHandle: string): string =>
  `/api/storefronts/${encodeURIComponent(publicHandle)}/presentation`;

export const PRESENTATION_INVALID =
  "Check the details. A name is required; the tagline can be up to 200 characters and the summary up to 2,000.";
export const PRESENTATION_UNCHANGED = "No changes to save.";
export const PRESENTATION_CONFLICT =
  "This storefront changed while you were editing. Reload the page and try again.";
export const PRESENTATION_NOT_EDITABLE = "This storefront can't be edited right now.";
export const PRESENTATION_SIGNED_OUT = "Your session has ended. Please sign in again.";
export const PRESENTATION_FAILURE = "Unable to save your changes. Please try again.";

export type PresentationOutcome =
  | { outcome: "saved" }
  | { outcome: "unchanged"; message: string }
  | { outcome: "failed"; message: string };

export interface PresentationSubmissionDeps {
  fetchImpl?: typeof fetch;
}

/** A blank optional field clears it; anything else is sent as typed. */
const blankToNull = (value: string): string | null => (value.trim() === "" ? null : value);

export async function submitStorefrontPresentation(
  publicHandle: string,
  input: { displayName: string; tagline: string; summary: string },
  deps: PresentationSubmissionDeps = {},
): Promise<PresentationOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(storefrontPresentationEndpoint(publicHandle), {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        displayName: input.displayName,
        tagline: blankToNull(input.tagline),
        summary: blankToNull(input.summary),
      }),
    });
  } catch {
    return { outcome: "failed", message: PRESENTATION_FAILURE };
  }

  if (response.ok) return { outcome: "saved" };
  if (response.status === 401) return { outcome: "failed", message: PRESENTATION_SIGNED_OUT };

  let code: unknown;
  try {
    code = ((await response.json()) as { error?: unknown }).error;
  } catch {
    code = undefined;
  }
  if (code === "STOREFRONT_PRESENTATION_UNCHANGED") {
    return { outcome: "unchanged", message: PRESENTATION_UNCHANGED };
  }
  const message =
    code === "INVALID_STOREFRONT_PRESENTATION_REQUEST"
      ? PRESENTATION_INVALID
      : code === "STOREFRONT_EDIT_CONFLICT"
        ? PRESENTATION_CONFLICT
        : code === "STOREFRONT_NOT_EDITABLE" || code === "STOREFRONT_NOT_FOUND"
          ? PRESENTATION_NOT_EDITABLE
          : PRESENTATION_FAILURE;
  return { outcome: "failed", message };
}
