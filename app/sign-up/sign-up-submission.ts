/**
 * The browser half of sign-up (Phase 1.27) — submission and error copy.
 *
 * Separated from the component for the same reason `sign-in-submission.ts` is: a
 * rule that lives in a rendered tree can only be tested by rendering one.
 * Everything here is a pure function of a request and a response, so the node
 * test environment exercises it directly — no DOM, no bundler, no new dependency.
 *
 * ## It runs in the browser, so it imports nothing from `src/server`
 *
 * Not the error codes, not the handler, not the account service. The codes below
 * are **restated literals**, bound by a test that imports `SIGN_UP_ERROR_CODES`
 * from the server module and asserts the two vocabularies agree — the same
 * arrangement Phase 1.25 made for sign-in, and safe for the same reason: an
 * unrecognised code falls through to the generic message, so drift can make this
 * page less specific but never wrong and never more disclosing.
 *
 * `MIN_PASSWORD_LENGTH` is restated for the same reason and by the same
 * arrangement. Importing it from `src/contracts/account/account` was tried first
 * and measured: it pulls `zod` and the capsule identity helpers into the client
 * bundle, taking this route from 1.4 kB to 20.8 kB to carry one integer. A
 * literal bound by a test costs nothing and cannot drift, which is the trade the
 * error codes above already make.
 *
 * ## What it refuses to tell the user
 *
 * The server answers identically for a new address and one that already has an
 * account — see `sign-up-route-handler.ts` — and this module must not widen that
 * back out. There is no branch here for "already registered", no copy for it, and
 * no way to reach one: an accepted registration produces exactly one outcome.
 * Anything else maps onto a bounded set of sentences that quote no status, no
 * code, and no response body.
 */

/**
 * Where a person goes after registering: the sign-in page, to use the password
 * they just chose. Not `/account` — registration issues no session, deliberately.
 */
export const SIGN_UP_DESTINATION = "/sign-in";

/** The endpoint this phase built. Same-origin and relative, never configurable. */
export const SIGN_UP_ENDPOINT = "/api/auth/sign-up";

/**
 * A reader's copy of the contract's `MIN_PASSWORD_LENGTH`, not a second
 * definition of it — see the module header for why it is restated rather than
 * imported. `auth-sign-up-ui.test.ts` imports the contract's value and asserts
 * this equals it, so a changed rule fails a test rather than leaving the form
 * advertising a minimum the server no longer enforces.
 *
 * The form's `minLength` attribute and its hint copy both read this, so the two
 * cannot disagree with each other either.
 */
export const MIN_PASSWORD_LENGTH = 12;

/**
 * The server's bounded refusal vocabulary, as the browser knows it.
 *
 * A reader's copy of `SIGN_UP_ERROR_CODES`, not a second definition of it. Note
 * that no member of this list names account existence, because no such code
 * exists on the server to name.
 */
export const SIGN_UP_CLIENT_ERROR_CODES = [
  "CROSS_ORIGIN_REQUEST_REFUSED",
  "INVALID_SIGN_UP_REQUEST",
  "TOO_MANY_ATTEMPTS",
  "SIGN_UP_UNAVAILABLE",
] as const;

/** The one message shown for everything unrecognised or untellable. */
export const GENERIC_SIGN_UP_FAILURE = "Unable to create your account. Please try again.";

/**
 * What a person is told when their submission was the problem.
 *
 * The server refuses an empty name, an implausible address, and a short password
 * with one code, so this sentence covers all three. It names the password
 * minimum because that is the rule a person is most likely to trip and least
 * likely to guess — and because the form states the same number beside the field,
 * from the same constant.
 */
export const INVALID_SIGN_UP_MESSAGE =
  `Please check your details. A password must be at least ${MIN_PASSWORD_LENGTH} characters.`;

export type SignUpOutcome =
  | { outcome: "registered" }
  | { outcome: "refused"; message: string };

export interface SignUpDetails {
  name: string;
  email: string;
  password: string;
}

export interface SignUpSubmissionDeps {
  /** Injected so a test can drive every branch without a server or a network. */
  fetchImpl?: typeof fetch;
}

/**
 * Map a refusal onto the sentence a person reads.
 *
 * Exported for the test that pins the copy and proves no branch leaks a code, a
 * status, or a hint about whether the address was already taken.
 */
export function signUpFailureMessage(code: unknown): string {
  switch (code) {
    case "INVALID_SIGN_UP_REQUEST":
      return INVALID_SIGN_UP_MESSAGE;
    case "TOO_MANY_ATTEMPTS":
      /* Phase 1.27. Deliberately says nothing about the count, the threshold, or
         the remaining window — and nothing about whether the address is one
         Monacado has seen. The `Retry-After` header is not read here at all:
         sign-in coarsens it to whole minutes, but sign-up's window is an hour and
         a "try again in about 47 minutes" is a live readout of a counter that
         started when somebody else typed this address. */
      return "Too many sign-up attempts for this email address. Please try again later.";
    case "SIGN_UP_UNAVAILABLE":
      /* An operator-side fault. Nothing the person can change will help. */
      return "Sign-up is temporarily unavailable. Please try again.";
    default:
      /* Includes `CROSS_ORIGIN_REQUEST_REFUSED`, which describes a request the
         page itself could not have made, and every code this build has not
         heard of. */
      return GENERIC_SIGN_UP_FAILURE;
  }
}

/**
 * Submit a registration, and report only what the caller may act on.
 *
 * **The response body is not read on success.** The server returns
 * `{ registered: true }` with no account id — it has none to give on the
 * duplicate branch, and returning one on the other branch would be the
 * difference that makes an oracle. So there is nothing here to carry onward, and
 * the success outcome has no fields.
 *
 * **No credential is stored anywhere.** Nothing writes to `localStorage`,
 * `sessionStorage`, a cookie, or the URL. No session is issued by this endpoint,
 * so unlike sign-in there is not even a cookie to preserve — `credentials` is
 * still set to `same-origin` so the request carries the origin the server checks
 * and behaves identically to its sibling.
 */
export async function submitSignUp(
  details: SignUpDetails,
  deps: SignUpSubmissionDeps = {},
): Promise<SignUpOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await doFetch(SIGN_UP_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      /* Exactly the three fields the strict schema accepts. A fourth — a role, a
         status, a createdAt — would be refused rather than quietly dropped. */
      body: JSON.stringify({
        name: details.name,
        email: details.email,
        password: details.password,
      }),
      credentials: "same-origin",
    });
  } catch {
    /* Offline, DNS, TLS, an aborted navigation. Nothing about the transport
       reaches the page. */
    return { outcome: "refused", message: GENERIC_SIGN_UP_FAILURE };
  }

  if (response.ok) return { outcome: "registered" };

  /* A refusal body is `{ error: CODE }` and nothing else. Missing, truncated, or
     not JSON at all leaves `code` undefined and the generic message stands. */
  let code: unknown;
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body) {
      code = (body as { error: unknown }).error;
    }
  } catch {
    code = undefined;
  }

  return { outcome: "refused", message: signUpFailureMessage(code) };
}
