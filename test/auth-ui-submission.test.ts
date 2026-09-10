/**
 * Phase 1.25 — the browser half of the auth loop, contract tests.
 *
 * Pure. NO DATABASE, NO NETWORK, NO DOM, and no rendered component. `fetch` is
 * injected, so every branch is driven by a `Response` built in the test.
 *
 * ## What this suite is for, and what it deliberately leaves alone
 *
 * Phases 1.22, 1.23 and 1.24 already prove the server: that credentials are
 * verified one way, that every credential failure answers identically, that the
 * attempt budget is charged before the password is checked, that a session
 * digest is what persists, and that sign-out is idempotent and uniform.
 * `auth-sign-in-route.integration.test.ts`,
 * `auth-sign-in-abuse-protection.integration.test.ts` and
 * `auth-sign-out-route.integration.test.ts` are those suites and nothing here
 * repeats them.
 *
 * What was not previously proved is the part a browser contributes: that the
 * page sends exactly the two fields the strict schema accepts and no third, that
 * it asks for the cookie to be honoured, that it carries no credential onward,
 * and that a refusal reaches a person as a bounded sentence rather than as
 * whatever the server said.
 */

import { describe, expect, it } from "vitest";
import {
  GENERIC_SIGN_IN_FAILURE,
  SIGN_IN_CLIENT_ERROR_CODES,
  SIGN_IN_DESTINATION,
  SIGN_IN_ENDPOINT,
  signInFailureMessage,
  submitSignIn,
} from "../app/sign-in/sign-in-submission";
import {
  SIGN_OUT_DESTINATION,
  SIGN_OUT_ENDPOINT,
  SIGN_OUT_FAILURE,
  submitSignOut,
} from "../app/account/sign-out-submission";
import { SIGN_IN_ERROR_CODES } from "../src/server/account/sign-in-route-handler";

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

const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

describe("1.25 — sign-in submission", () => {
  it("sends exactly the two fields the endpoint accepts, and carries nothing back", async () => {
    /* `SignInRequest` is a `strictObject`, so a third key is a 400 rather than
       something quietly dropped — which is the behaviour that makes this worth
       pinning. A form that grew a hidden `accountId`, a `role`, or a remembered
       `sessionId` would stop working rather than smuggle it, but it would stop
       working in production, and this is where that is supposed to be noticed.

       The other half of the assertion is the response. The endpoint answers
       `{ accountId }` and the cookie carries the only credential; nothing here
       may pass either onward. A signed-in outcome with a field on it is the
       first step toward a session in React state. */
    const { calls, fetchImpl } = captureFetch(
      jsonResponse(200, { accountId: "mon:acct:whatever" }),
    );

    const result = await submitSignIn(
      { email: "person@example.com", password: "a-correct-horse-battery" },
      { fetchImpl },
    );

    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(SIGN_IN_ENDPOINT);
    expect(call.init.method).toBe("POST");
    expect(JSON.parse(String(call.init.body))).toEqual({
      email: "person@example.com",
      password: "a-correct-horse-battery",
    });
    /* Without this the browser discards `Set-Cookie` and the sign-in "succeeds"
       with no session — the most confusing possible failure. */
    expect(call.init.credentials).toBe("same-origin");

    /* Exactly one key, and it is not a credential. */
    expect(result).toEqual({ outcome: "signed-in" });
    expect(SIGN_IN_DESTINATION).toBe("/account");
  });

  it("maps every refusal onto bounded copy, and knows the same codes the server does", async () => {
    /* The client restates the server's error vocabulary as literals, because it
       runs in a browser bundle and `sign-in-route-handler.ts` is server-only.
       This is the test that makes the duplication safe: the two lists must
       agree, and a code renamed on one side fails here rather than silently
       degrading a message in production. */
    expect([...SIGN_IN_CLIENT_ERROR_CODES].sort()).toEqual(
      Object.values(SIGN_IN_ERROR_CODES).sort(),
    );

    /* One sentence per code, and the credential case says nothing about which
       half was wrong or whether the address is one Monacado has seen — the 401
       collapse that `account-identity` and the 1.22 route suite both protect
       would be undone by a page that split it apart again. */
    const cases: ReadonlyArray<{ status: number; code: string; expected: string }> = [
      {
        status: 401,
        code: SIGN_IN_ERROR_CODES.invalidCredentials,
        expected: "Email or password is incorrect.",
      },
      {
        status: 503,
        code: SIGN_IN_ERROR_CODES.unavailable,
        expected: "Sign-in is temporarily unavailable. Please try again.",
      },
      { status: 403, code: SIGN_IN_ERROR_CODES.crossOrigin, expected: GENERIC_SIGN_IN_FAILURE },
      { status: 400, code: SIGN_IN_ERROR_CODES.invalidRequest, expected: GENERIC_SIGN_IN_FAILURE },
      /* A code this build has never heard of, and a 500 with no code at all. */
      { status: 418, code: "SOMETHING_NEW", expected: GENERIC_SIGN_IN_FAILURE },
    ];

    for (const { status, code, expected } of cases) {
      const { fetchImpl } = captureFetch(jsonResponse(status, { error: code }));
      const result = await submitSignIn({ email: "a@example.com", password: "x" }, { fetchImpl });
      expect(`${code}:${JSON.stringify(result)}`).toBe(
        `${code}:${JSON.stringify({ outcome: "refused", message: expected })}`,
      );
      /* Nothing the server said reaches the page verbatim. */
      const message = result.outcome === "refused" ? result.message : "";
      expect(message).not.toContain(code);
      expect(message).not.toContain(String(status));
    }

    /* A body that is not JSON at all, and a transport that never answered. Both
       are the generic sentence; neither describes the fault. */
    const notJson = captureFetch(new Response("<html>502 Bad Gateway</html>", { status: 502 }));
    await expect(
      submitSignIn({ email: "a@example.com", password: "x" }, { fetchImpl: notJson.fetchImpl }),
    ).resolves.toEqual({ outcome: "refused", message: GENERIC_SIGN_IN_FAILURE });

    const offline = captureFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      submitSignIn({ email: "a@example.com", password: "x" }, { fetchImpl: offline.fetchImpl }),
    ).resolves.toEqual({ outcome: "refused", message: GENERIC_SIGN_IN_FAILURE });
  });

  it("reports a throttled attempt as a coarse wait, never as the counter's state", async () => {
    /* `Retry-After` is the real remaining TTL of a shared Redis counter.
       Printing it to the second is a live readout of internal throttle state,
       which `sign-in-abuse-protection.ts` is careful never to disclose — so the
       page rounds to whole minutes and the raw number must not survive. */
    const throttled = async (headers: Record<string, string>) => {
      const { fetchImpl } = captureFetch(
        jsonResponse(429, { error: SIGN_IN_ERROR_CODES.tooManyAttempts }, headers),
      );
      const result = await submitSignIn({ email: "a@example.com", password: "x" }, { fetchImpl });
      return result.outcome === "refused" ? result.message : "";
    };

    expect(await throttled({ "retry-after": "900" })).toBe(
      "Too many sign-in attempts. Please try again in about 15 minutes.",
    );
    /* Rounded up, so a caller is never sent back before the budget refills. */
    expect(await throttled({ "retry-after": "61" })).toBe(
      "Too many sign-in attempts. Please try again in about 2 minutes.",
    );
    expect(await throttled({ "retry-after": "874" })).toBe(
      "Too many sign-in attempts. Please try again in about 15 minutes.",
    );
    expect(await throttled({ "retry-after": "30" })).toBe(
      "Too many sign-in attempts. Please try again in less than a minute.",
    );
    /* The seconds themselves never appear. */
    expect(await throttled({ "retry-after": "874" })).not.toContain("874");

    /* No header, an unusable one, and an implausible one all fall back to the
       message that promises nothing. `sign-in-abuse-protection.ts` omits the
       header when the backend reported no real TTL, precisely so that a guessed
       wait is never presented as a real one. */
    const unusable: ReadonlyArray<Record<string, string>> = [
      {},
      { "retry-after": "soon" },
      { "retry-after": "-1" },
      { "retry-after": "999999" },
    ];
    for (const headers of unusable) {
      expect(await throttled(headers)).toBe(
        "Too many sign-in attempts. Please try again later.",
      );
    }

    /* And the mapper says the same thing when asked directly. */
    expect(signInFailureMessage(SIGN_IN_ERROR_CODES.tooManyAttempts, null)).toBe(
      "Too many sign-in attempts. Please try again later.",
    );
  });
});

describe("1.25 — sign-out submission", () => {
  it("posts no body, and refuses to pretend a failed sign-out worked", async () => {
    /* The endpoint reads an origin and a cookie. A body would be a field through
       which a page could name a session or a scope, and the absence of one is
       the control — so its absence is what is asserted. */
    const ok = captureFetch(jsonResponse(200, { signedOut: true }));
    await expect(submitSignOut({ fetchImpl: ok.fetchImpl })).resolves.toEqual({
      outcome: "signed-out",
    });

    expect(ok.calls).toHaveLength(1);
    const call = ok.calls[0]!;
    expect(call.url).toBe(SIGN_OUT_ENDPOINT);
    expect(call.init.method).toBe("POST");
    expect(call.init.body).toBeUndefined();
    /* The cookie must travel out for the server to know what to revoke, and the
       clearing cookie must be accepted on the way back. */
    expect(call.init.credentials).toBe("same-origin");
    expect(SIGN_OUT_DESTINATION).toBe("/sign-in");

    /* Every reachable state answers 200 — valid, expired, already revoked, never
       real, no cookie at all — so a non-200 is not "already signed out". It is
       the one case the handler singles out: revocation did not persist, no
       cookie was cleared, and the session may still be live. Navigating away
       from that would show a signed-out page to someone who is still signed in. */
    for (const status of [500, 403]) {
      const failed = captureFetch(jsonResponse(status, { error: "SIGN_OUT_UNAVAILABLE" }));
      await expect(submitSignOut({ fetchImpl: failed.fetchImpl })).resolves.toEqual({
        outcome: "failed",
        message: SIGN_OUT_FAILURE,
      });
    }

    const offline = captureFetch(() => {
      throw new TypeError("Failed to fetch");
    });
    await expect(submitSignOut({ fetchImpl: offline.fetchImpl })).resolves.toEqual({
      outcome: "failed",
      message: SIGN_OUT_FAILURE,
    });
  });
});
