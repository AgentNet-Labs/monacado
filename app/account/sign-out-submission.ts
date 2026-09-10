/**
 * The browser half of sign-out (Phase 1.25).
 *
 * The same separation `sign-in-submission.ts` makes, for the same reason: this
 * is a pure function of a response, so the node test environment proves it
 * without rendering anything. It imports nothing from `src/server` — it runs in
 * a browser bundle.
 *
 * ## There is no body, and building one would be a mistake
 *
 * `handleSignOutRequest` reads an origin and a cookie and nothing else. Which
 * session ends is decided by the cookie the browser already holds, so there is
 * no field here through which a page could name a session, an account, or a
 * scope — and adding one would be inventing an authority the endpoint
 * deliberately does not expose.
 *
 * ## A failed sign-out is reported as a failed sign-out
 *
 * The server answers 200 for every reachable state — valid session, expired,
 * already revoked, never real, no cookie at all — so a non-200 is not "you were
 * already signed out". It is the one case `sign-out-route-handler.ts` singles
 * out: revocation did not persist, no cookie was cleared, and the session may
 * still be live. Navigating away from that would show someone a signed-out page
 * while their session kept working, which is a lie they would act on.
 */

/** Where a completed sign-out lands. Fixed, and never read from the request. */
export const SIGN_OUT_DESTINATION = "/sign-in";

/** The endpoint Phase 1.24 built. Same-origin and relative, never configurable. */
export const SIGN_OUT_ENDPOINT = "/api/auth/sign-out";

/**
 * The only refusal copy there is.
 *
 * A 403, a 500, and a dropped connection are all the same to the person
 * pressing the button: it did not work, and the honest instruction is to try
 * again. Distinguishing them would describe an outage to someone who cannot act
 * on the distinction.
 */
export const SIGN_OUT_FAILURE = "Unable to sign out. Please try again.";

export type SignOutOutcome =
  | { outcome: "signed-out" }
  | { outcome: "failed"; message: string };

export interface SignOutSubmissionDeps {
  /** Injected so a test can drive every branch without a server or a network. */
  fetchImpl?: typeof fetch;
}

/**
 * End the session this browser is holding.
 *
 * `credentials` is set for the same reason sign-in sets it, in the other
 * direction: the request must carry the session cookie for the server to know
 * which session to revoke, and the response's clearing `Set-Cookie` must be
 * accepted for the browser to stop presenting it.
 *
 * Nothing is cleared client-side on success. The cookie is `HttpOnly`, so this
 * code could not remove it if it tried, and the server's clearing header is the
 * single mechanism — a page that also tried would be a second, weaker answer.
 */
export async function submitSignOut(deps: SignOutSubmissionDeps = {}): Promise<SignOutOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(SIGN_OUT_ENDPOINT, {
      method: "POST",
      credentials: "same-origin",
    });
  } catch {
    return { outcome: "failed", message: SIGN_OUT_FAILURE };
  }

  /* The response body is not read at all. It is `{ signedOut: true }` on
     success, and reading `{ revoked }` out of it is exactly the oracle the
     endpoint's uniform answer exists to close. */
  return response.ok
    ? { outcome: "signed-out" }
    : { outcome: "failed", message: SIGN_OUT_FAILURE };
}
