/**
 * The browser half of sign-in (Phase 1.25) — submission and error copy.
 *
 * Separated from the component for the reason every route handler in this
 * repository is separated from its `route.ts`: a rule that lives in a rendered
 * tree can only be tested by rendering one. Everything here is a pure function
 * of a request and a response, so the repository's existing node test
 * environment exercises it directly — no DOM, no bundler, no new dependency.
 *
 * ## It runs in the browser, so it imports nothing from `src/server`
 *
 * Not the error-code constants, not the cookie name, not the session helpers.
 * `src/server/server-only.ts` exists to make that mistake loud, and this is the
 * first phase in the repository with a client bundle for it to be loud about.
 *
 * The codes below are therefore **restated literals, and deliberately so**. That
 * would normally be the second answer this repository refuses to write — but the
 * duplication is bound by a test that imports `SIGN_IN_ERROR_CODES` from the
 * server module and asserts this vocabulary matches it. The runtime coupling is
 * zero and the drift is caught at test time rather than in a browser.
 *
 * And the failure mode of drift is safe by construction: an unrecognised code
 * falls through to the generic message. A server that renamed a code could make
 * this page less specific; it could never make it wrong, and it could never make
 * it disclose something the old code did not.
 *
 * ## What it refuses to tell the user
 *
 * The server already collapses "no such account", "wrong password", and
 * "disabled account" onto one 401 — that collapse is the whole point of
 * `InvalidCredentialsError` — and this module must not widen it back out. It
 * maps a bounded set of codes onto a bounded set of sentences and shows nothing
 * else: no status number, no code, no response body, no `Retry-After` in
 * seconds, no network error text. A message built from anything the server said
 * verbatim is a disclosure channel that nobody reviewed.
 */

/** Where a successful sign-in lands. Fixed, and never read from the request. */
export const SIGN_IN_DESTINATION = "/account";

/** The endpoint Phase 1.22 built. Same-origin and relative, never configurable. */
export const SIGN_IN_ENDPOINT = "/api/auth/sign-in";

/**
 * The server's bounded refusal vocabulary, as the browser knows it.
 *
 * A reader's copy of `SIGN_IN_ERROR_CODES`, not a second definition of it — see
 * the module header for why it is restated and what binds it.
 */
export const SIGN_IN_CLIENT_ERROR_CODES = [
  "INVALID_CREDENTIALS",
  "CROSS_ORIGIN_REQUEST_REFUSED",
  "INVALID_SIGN_IN_REQUEST",
  "TOO_MANY_ATTEMPTS",
  "SIGN_IN_UNAVAILABLE",
] as const;

/**
 * The one message shown for everything unrecognised.
 *
 * A malformed request, a refused origin, an unparseable body, a network fault,
 * and a code this build has never heard of all arrive here. None of them is the
 * user's doing and none of them is safe to describe.
 */
export const GENERIC_SIGN_IN_FAILURE = "Unable to sign in. Please try again.";

export type SignInOutcome =
  | { outcome: "signed-in" }
  | { outcome: "refused"; message: string };

export interface SignInCredentials {
  email: string;
  password: string;
}

export interface SignInSubmissionDeps {
  /** Injected so a test can drive every branch without a server or a network. */
  fetchImpl?: typeof fetch;
}

/**
 * Turn a `Retry-After` into something coarse enough to say out loud.
 *
 * The header carries the real remaining TTL of a shared counter, and printing it
 * to the second would hand a caller a live readout of internal throttle state —
 * precisely what `sign-in-abuse-protection.ts` is careful never to disclose.
 * Whole minutes, rounded up, discard that resolution while still never telling
 * someone to come back before the budget has actually refilled.
 */
function coarseRetryPhrase(retryAfter: string | null): string | undefined {
  if (retryAfter === null) return undefined;
  const seconds = Number(retryAfter.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  /* An hour is already past "please wait a moment" and into "something is
     wrong"; a number that large is more likely a misconfiguration than a real
     wait, and repeating it would just be alarming. */
  if (seconds > 3600) return undefined;
  if (seconds < 60) return "Please try again in less than a minute.";
  const minutes = Math.ceil(seconds / 60);
  return `Please try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

/**
 * Map a refusal onto the sentence a person reads.
 *
 * Exported for the test that pins the copy and proves no branch leaks a code, a
 * status, or a header value into the string.
 */
export function signInFailureMessage(code: unknown, retryAfter: string | null = null): string {
  switch (code) {
    case "INVALID_CREDENTIALS":
      /* Deliberately says nothing about which half was wrong, or whether the
         address is one Monacado has ever seen. */
      return "Email or password is incorrect.";
    case "TOO_MANY_ATTEMPTS": {
      const when = coarseRetryPhrase(retryAfter);
      return when === undefined
        ? "Too many sign-in attempts. Please try again later."
        : `Too many sign-in attempts. ${when}`;
    }
    case "SIGN_IN_UNAVAILABLE":
      /* An operator-side fault. "Temporarily" is the honest word: nothing the
         user can change will help, and retrying later genuinely might. */
      return "Sign-in is temporarily unavailable. Please try again.";
    default:
      return GENERIC_SIGN_IN_FAILURE;
  }
}

/**
 * Submit credentials, and report only what the caller may act on.
 *
 * **The response body is read for one field and otherwise discarded.** The
 * server returns `{ accountId }` on success and this function does not pass it
 * on: the page it navigates to resolves the session from the cookie server-side,
 * so an account id carried through React state would be a second, staler answer
 * to a question the server is already answering.
 *
 * **No credential is stored anywhere.** There is no token in the response by
 * design — `sign-in-route-handler.ts` puts it only in `Set-Cookie` — and nothing
 * here writes to `localStorage`, `sessionStorage`, a cookie, or the URL. The
 * browser's cookie jar is the sole carrier, which is why `credentials` is set:
 * a cross-origin default would discard the `Set-Cookie` and the sign-in would
 * silently succeed with no session.
 */
export async function submitSignIn(
  credentials: SignInCredentials,
  deps: SignInSubmissionDeps = {},
): Promise<SignInOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(SIGN_IN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      /* Exactly the two fields the strict schema accepts. Anything else would be
         refused as an authority-shaped key, and rightly. */
      body: JSON.stringify({ email: credentials.email, password: credentials.password }),
      /* Same-origin, so the session cookie is accepted on the way back. */
      credentials: "same-origin",
    });
  } catch {
    /* Offline, DNS, TLS, an aborted navigation. The user is told to try again
       and nothing about the transport reaches the page. */
    return { outcome: "refused", message: GENERIC_SIGN_IN_FAILURE };
  }

  if (response.ok) return { outcome: "signed-in" };

  /* A refusal body is `{ error: CODE }` and nothing else. If it is missing,
     truncated, or not JSON at all, `code` stays undefined and the generic
     message is what the user sees. */
  let code: unknown;
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      code = (body as { error: unknown }).error;
    }
  } catch {
    code = undefined;
  }

  return {
    outcome: "refused",
    message: signInFailureMessage(code, response.headers.get("retry-after")),
  };
}
