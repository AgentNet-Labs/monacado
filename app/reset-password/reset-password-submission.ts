/**
 * Client-side submission for `/reset-password` (Phase 1.28).
 *
 * The confirmation field is checked here and never sent: the endpoint accepts
 * exactly `{ token, password }`, and the password rule it enforces is the
 * registration contract's own.
 */

import { readErrorCode } from "../forgot-password/forgot-password-submission";
import { MIN_PASSWORD_LENGTH } from "../sign-up/sign-up-submission";

export { MIN_PASSWORD_LENGTH };

export const PASSWORD_RESET_COMPLETE_ENDPOINT = "/api/auth/password-reset/complete";

export const GENERIC_PASSWORD_RESET_FAILURE =
  "Unable to reset your password right now. Please try again.";

export const PASSWORD_MISMATCH_MESSAGE = "The two passwords do not match.";

export const INVALID_PASSWORD_MESSAGE = `A password must be at least ${MIN_PASSWORD_LENGTH} characters.`;

export type PasswordResetOutcome =
  | { outcome: "reset" }
  /** The link cannot be used. The page swaps the form for the invalid-link state. */
  | { outcome: "link-invalid" }
  | { outcome: "refused"; message: string };

export interface ResetDetails {
  token: string;
  password: string;
  confirmation: string;
}

export async function submitPasswordReset(
  details: ResetDetails,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<PasswordResetOutcome> {
  if (details.password !== details.confirmation) {
    return { outcome: "refused", message: PASSWORD_MISMATCH_MESSAGE };
  }
  if (details.password.length < MIN_PASSWORD_LENGTH) {
    return { outcome: "refused", message: INVALID_PASSWORD_MESSAGE };
  }

  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(PASSWORD_RESET_COMPLETE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: details.token, password: details.password }),
      credentials: "same-origin",
    });
  } catch {
    return { outcome: "refused", message: GENERIC_PASSWORD_RESET_FAILURE };
  }
  if (response.ok) return { outcome: "reset" };

  const code = await readErrorCode(response);
  if (code === "PASSWORD_RESET_LINK_INVALID") return { outcome: "link-invalid" };
  if (code === "INVALID_PASSWORD") return { outcome: "refused", message: INVALID_PASSWORD_MESSAGE };
  return { outcome: "refused", message: GENERIC_PASSWORD_RESET_FAILURE };
}
