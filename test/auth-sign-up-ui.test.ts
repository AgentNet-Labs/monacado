/**
 * Phase 1.27 — the browser half of sign-up, contract tests.
 *
 * Pure. NO DATABASE, NO NETWORK, NO DOM, and no rendered component. `fetch` is
 * injected, so every branch is driven by a `Response` built in the test.
 *
 * ## What this suite is for
 *
 * `auth-sign-up-route.integration.test.ts` proves the server: that an account is
 * created, that an address already in use is answered identically, that no
 * session is issued, and that nothing marketplace-shaped is written. None of that
 * is repeated here.
 *
 * What is proved here is the part a browser contributes and nothing else can: that
 * the page sends exactly the three fields the strict schema accepts, that it
 * carries no credential and no account id onward, and — the one that matters —
 * that its refusal vocabulary is structurally incapable of telling a caller
 * whether an address already has an account.
 *
 * Not re-proved: password hashing (`account-identity`), the `CreateAccountInput`
 * contract's own bounds, or verification-token cryptography (Phase 1.4's suites).
 */

import { describe, expect, it } from "vitest";
import {
  GENERIC_SIGN_UP_FAILURE,
  INVALID_SIGN_UP_MESSAGE,
  MIN_PASSWORD_LENGTH,
  SIGN_UP_CLIENT_ERROR_CODES,
  SIGN_UP_DESTINATION,
  SIGN_UP_ENDPOINT,
  signUpFailureMessage,
  submitSignUp,
} from "../app/sign-up/sign-up-submission";
import {
  SIGN_UP_ACCEPTED_BODY,
  SIGN_UP_ERROR_CODES,
} from "../src/server/account/sign-up-route-handler";
import { MIN_PASSWORD_LENGTH as CONTRACT_MIN_PASSWORD_LENGTH } from "../src/contracts/account/account";

interface CapturedCall {
  url: string;
  init: RequestInit;
}

/** A `fetch` that records what it was asked to do and answers a canned reply. */
function captureFetch(reply: Response | (() => never)): {
  calls: CapturedCall[];
  fetchImpl: typeof fetch;
} {
  const calls: CapturedCall[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    if (typeof reply === "function") reply();
    return reply;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

const DETAILS = {
  name: "Ada Lovelace",
  email: "ada@example.com",
  password: "a-correct-horse-battery",
};

describe("1.27 — sign-up submission", () => {
  it("sends exactly the three fields the endpoint accepts, and carries nothing back", async () => {
    /* `SignUpRequest` is a `strictObject`, so a fourth key is a 400 rather than
       something quietly dropped. A form that grew a hidden `status`, a `role`, or
       a client-chosen `createdAt` would stop working rather than smuggle it — and
       this is where that is supposed to be noticed, rather than in production.

       The other half of the assertion is the response. The endpoint answers
       `{ registered: true }` and deliberately no account id, so a successful
       outcome must have no fields at all: an id here would be the first step
       toward a page that knows who it just created. */
    const { calls, fetchImpl } = captureFetch(jsonResponse(200, SIGN_UP_ACCEPTED_BODY));

    const result = await submitSignUp(DETAILS, { fetchImpl });

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(SIGN_UP_ENDPOINT);
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(String(call.init.body))).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
      password: "a-correct-horse-battery",
    });
    expect(call.init.credentials).toBe("same-origin");

    /* Exactly one key, and it is not a credential and not an identifier. */
    expect(result).toEqual({ outcome: "registered" });

    /* Registration issues no session, so the place to go next is sign-in — not
       `/account`, which would bounce a visitor who has no cookie. */
    expect(SIGN_UP_DESTINATION).toBe("/sign-in");
  });

  it("cannot tell a caller whether an address already has an account", async () => {
    /* THE security guarantee of this phase, asserted on the client side.

       `account-errors.ts` recorded the rule before the route existed: a public
       signup "must not surface this code to the caller for the enumeration
       reason above". The server obeys it by answering both branches with the
       same 200. This asserts the browser cannot undo that — there is no code in
       the client vocabulary that names account existence, and no input to the
       message mapper produces copy that mentions it. */
    expect([...SIGN_UP_CLIENT_ERROR_CODES].sort()).toEqual(
      Object.values(SIGN_UP_ERROR_CODES).sort(),
    );

    /* The vocabulary itself is incapable of expressing existence. */
    for (const code of SIGN_UP_CLIENT_ERROR_CODES) {
      expect(code).not.toMatch(/DUPLICATE|EXIST|TAKEN|ALREADY|REGISTERED|IN_USE/i);
    }

    /* And neither is any sentence it can produce — including the ones reached by
       codes the server does not currently define, and by a duplicate-shaped code
       invented here to prove it falls through to the generic message rather than
       being echoed. */
    const everyMessage = [
      ...SIGN_UP_CLIENT_ERROR_CODES.map((code) => signUpFailureMessage(code)),
      signUpFailureMessage("DUPLICATE_ACCOUNT_EMAIL"),
      signUpFailureMessage(undefined),
    ];
    for (const message of everyMessage) {
      expect(message).not.toMatch(/exist|taken|already|registered|in use|duplicate/i);
    }
    expect(signUpFailureMessage("DUPLICATE_ACCOUNT_EMAIL")).toBe(GENERIC_SIGN_UP_FAILURE);

    /* A 200 is a 200 whichever branch produced it, so the outcome is identical
       for an address that was free and one that was not. The client has no way
       to distinguish them because the server handed it nothing to distinguish. */
    const fresh = captureFetch(jsonResponse(200, SIGN_UP_ACCEPTED_BODY));
    const taken = captureFetch(jsonResponse(200, SIGN_UP_ACCEPTED_BODY));
    expect(await submitSignUp(DETAILS, { fetchImpl: fresh.fetchImpl })).toEqual(
      await submitSignUp(DETAILS, { fetchImpl: taken.fetchImpl }),
    );
  });

  it("maps every refusal onto bounded copy that quotes nothing the server said", async () => {
    /* One sentence per code. The invalid-request case names the password
       minimum because that is the rule a person is most likely to trip and
       cannot guess — and it takes the number from the contract, so the copy and
       the server's actual bound cannot drift apart. */
    expect(signUpFailureMessage(SIGN_UP_ERROR_CODES.invalidRequest)).toBe(INVALID_SIGN_UP_MESSAGE);
    expect(INVALID_SIGN_UP_MESSAGE).toContain(String(MIN_PASSWORD_LENGTH));

    /* The binding that makes the restated literal safe. The client cannot import
       the contract without dragging `zod` into the bundle — measured at +19 kB
       for one integer — so it restates the number and this asserts the two agree.
       A raised minimum fails here rather than leaving the form advertising a rule
       the server stopped enforcing. */
    expect(MIN_PASSWORD_LENGTH).toBe(CONTRACT_MIN_PASSWORD_LENGTH);

    expect(signUpFailureMessage(SIGN_UP_ERROR_CODES.unavailable)).toBe(
      "Sign-up is temporarily unavailable. Please try again.",
    );
    /* A refused origin describes a request this page could not have made, so the
       person is told nothing about it. */
    expect(signUpFailureMessage(SIGN_UP_ERROR_CODES.crossOrigin)).toBe(GENERIC_SIGN_UP_FAILURE);

    /* Phase 1.27. The throttle message names no count, no threshold, and no
       remaining time — sign-up's window is an hour, and a "try again in about 47
       minutes" would be a live readout of a counter that may have been started by
       somebody else typing this address. */
    expect(signUpFailureMessage(SIGN_UP_ERROR_CODES.tooManyAttempts)).toBe(
      "Too many sign-up attempts for this email address. Please try again later.",
    );
    expect(signUpFailureMessage(SIGN_UP_ERROR_CODES.tooManyAttempts)).not.toMatch(/\d/);

    const cases: ReadonlyArray<{ status: number; code: string; expected: string }> = [
      { status: 400, code: SIGN_UP_ERROR_CODES.invalidRequest, expected: INVALID_SIGN_UP_MESSAGE },
      {
        status: 429,
        code: SIGN_UP_ERROR_CODES.tooManyAttempts,
        expected: "Too many sign-up attempts for this email address. Please try again later.",
      },
      { status: 403, code: SIGN_UP_ERROR_CODES.crossOrigin, expected: GENERIC_SIGN_UP_FAILURE },
      {
        status: 500,
        code: SIGN_UP_ERROR_CODES.unavailable,
        expected: "Sign-up is temporarily unavailable. Please try again.",
      },
      { status: 418, code: "SOMETHING_NEW", expected: GENERIC_SIGN_UP_FAILURE },
    ];

    for (const { status, code, expected } of cases) {
      const { fetchImpl } = captureFetch(jsonResponse(status, { error: code }));
      const result = await submitSignUp(DETAILS, { fetchImpl });
      expect(`${code}:${JSON.stringify(result)}`).toBe(
        `${code}:${JSON.stringify({ outcome: "refused", message: expected })}`,
      );
      /* Nothing the server said reaches the page verbatim. */
      const message = result.outcome === "refused" ? result.message : "";
      expect(message).not.toContain(code);
      expect(message).not.toContain(String(status));
    }

    /* A body that is not JSON, and a transport that never answered. Both are the
       generic sentence; neither describes the fault. */
    const notJson = captureFetch(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    await expect(submitSignUp(DETAILS, { fetchImpl: notJson.fetchImpl })).resolves.toEqual({
      outcome: "refused",
      message: GENERIC_SIGN_UP_FAILURE,
    });

    const offline = captureFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(submitSignUp(DETAILS, { fetchImpl: offline.fetchImpl })).resolves.toEqual({
      outcome: "refused",
      message: GENERIC_SIGN_UP_FAILURE,
    });
  });
});
