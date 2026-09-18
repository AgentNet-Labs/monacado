/**
 * Client-side submission for `/forgot-password` (Phase 1.28).
 *
 * Framework-free so it is testable without a browser, as sign-up's is. The only
 * success the page can show is "if an account exists, a link is on its way" —
 * the endpoint never says more, so this never claims more.
 */

export const PASSWORD_RESET_REQUEST_ENDPOINT = "/api/auth/password-reset/request";

export const GENERIC_PASSWORD_RESET_REQUEST_FAILURE =
  "Unable to send a reset link right now. Please try again.";

export type PasswordResetRequestOutcome =
  | { outcome: "requested" }
  | { outcome: "refused"; message: string };

export interface PasswordResetSubmissionDeps {
  fetchImpl?: typeof fetch;
}

export function passwordResetRequestFailureMessage(code: unknown): string {
  switch (code) {
    case "INVALID_PASSWORD_RESET_REQUEST":
      return "Please enter the email address you sign in with.";
    case "TOO_MANY_ATTEMPTS":
      return "Too many reset requests for this email address. Please try again later.";
    default:
      return GENERIC_PASSWORD_RESET_REQUEST_FAILURE;
  }
}

/** Read `{ error: CODE }` from a refusal, or `undefined` for anything else. */
export async function readErrorCode(response: Response): Promise<unknown> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      return (body as { error: unknown }).error;
    }
  } catch {
    /* Not JSON. The generic message stands. */
  }
  return undefined;
}

export async function submitPasswordResetRequest(
  email: string,
  deps: PasswordResetSubmissionDeps = {},
): Promise<PasswordResetRequestOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(PASSWORD_RESET_REQUEST_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
      credentials: "same-origin",
    });
  } catch {
    return { outcome: "refused", message: GENERIC_PASSWORD_RESET_REQUEST_FAILURE };
  }
  if (response.ok) return { outcome: "requested" };
  return {
    outcome: "refused",
    message: passwordResetRequestFailureMessage(await readErrorCode(response)),
  };
}
