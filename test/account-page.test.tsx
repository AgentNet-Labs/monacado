/**
 * `/account` presentation and the browser half of Seller/Promoter setup.
 *
 * NO DATABASE, NO NETWORK. The session resolver, the account-home reader,
 * request headers, and router are replaced so the page renders as it would for a
 * live session; what those readers return from real rows is proved by
 * `participant-onboarding.integration.test.ts`, and sign-out submission by
 * `auth-ui-submission.test.ts`.
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountHome } from "../src/server/account/account-home";

/* Vitest compiles JSX (the page's included) to `React.createElement` against a
   global `React`, where Next uses the automatic runtime. Provide it here rather
   than change the transform for every test. */
(globalThis as { React?: typeof React }).React = React;

const ACCOUNT_ID = "mon:acct:01TESTACCOUNTIDENTIFIER00";

const resolvePageSession = vi.fn();
const readAccountHome = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`redirect:${to}`);
});

vi.mock("../src/server/account/page-session", () => ({ resolvePageSession }));
vi.mock("../src/server/account/account-home", () => ({ readAccountHome }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "monacado_session=opaque" }),
}));
vi.mock("next/navigation", () => ({
  redirect,
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));

const { default: AccountPage } = await import("../app/account/page");
const {
  ONBOARDING_CLOSED,
  ONBOARDING_ENDPOINT,
  ONBOARDING_FAILURE,
  ONBOARDING_NO_ROLE_CHOSEN,
  ONBOARDING_SIGNED_OUT,
  submitOnboarding,
} = await import("../app/account/onboarding-submission");

function home(overrides: Partial<AccountHome> = {}): AccountHome {
  return {
    name: "Ada Seller",
    email: "ada@example.com",
    emailVerified: true,
    marketplace: null,
    setupRolesAvailable: ["SELLER", "PROMOTER"],
    ...overrides,
  };
}

async function renderSignedIn(value: AccountHome): Promise<string> {
  resolvePageSession.mockResolvedValue({ accountId: ACCOUNT_ID });
  readAccountHome.mockResolvedValue(value);
  return renderToStaticMarkup(await AccountPage());
}

describe("/account presentation", () => {
  beforeEach(() => {
    resolvePageSession.mockReset();
    readAccountHome.mockReset();
    redirect.mockClear();
  });

  it("shows name, email, and verified status, reads the home by the session's account, and hides the id", async () => {
    const html = await renderSignedIn(home());

    expect(readAccountHome).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(html).toContain("<h1>Monacado</h1>");
    expect(html).toContain("You are signed in.");
    expect(html).toContain("<dd>Ada Seller</dd>");
    expect(html).toContain("<dd>ada@example.com</dd>");
    expect(html).toContain("<dd>Verified</dd>");
    expect(html).not.toContain("Email not verified");
    expect(html).toContain("Sign out");
    expect(html).not.toContain(ACCOUNT_ID);
    expect(html).not.toContain("mon:acct:");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("shows an unverified address plainly and still offers setup", async () => {
    const html = await renderSignedIn(home({ emailVerified: false }));

    expect(html).toContain("<dd>Email not verified</dd>");
    expect(html).toContain("must be verified before anything you set up can go live");
    expect(html).toContain("Start setup");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("offers Seller and Promoter setup to an account that has not started", async () => {
    const html = await renderSignedIn(home());

    expect(html).toContain("Sell or promote on Monacado");
    expect(html).toContain('value="SELLER"');
    expect(html).toContain('value="PROMOTER"');
    expect(html).not.toContain('value="BUYER"');
    expect(html).toContain("Start setup");
  });

  it("shows setup in progress and offers only the role not yet started", async () => {
    const html = await renderSignedIn(
      home({
        marketplace: {
          status: "DRAFT",
          roles: [{ role: "SELLER", status: "DRAFT" }],
          onboardingOpen: true,
        },
        setupRolesAvailable: ["PROMOTER"],
      }),
    );

    expect(html).toContain("Marketplace status: Setup in progress");
    expect(html).toContain("Seller — Setup in progress");
    expect(html).not.toContain('value="SELLER"');
    expect(html).toContain('value="PROMOTER"');
    expect(html).toContain("Add to setup");
  });

  it("offers no setup control once the participant is out of drafting", async () => {
    const html = await renderSignedIn(
      home({
        marketplace: {
          status: "UNDER_REVIEW",
          roles: [{ role: "SELLER", status: "PENDING_ACTIVATION" }],
          onboardingOpen: false,
        },
        setupRolesAvailable: [],
      }),
    );

    expect(html).toContain("Marketplace status: Under review");
    expect(html).toContain("Seller — Awaiting approval");
    expect(html).not.toContain('value="PROMOTER"');
    expect(html).not.toContain("Add to setup");
    expect(html).toContain("Sign out");
  });

  it("still sends a visitor without a session to sign-in", async () => {
    resolvePageSession.mockResolvedValue(undefined);

    await expect(AccountPage()).rejects.toThrow("redirect:/sign-in");
    expect(readAccountHome).not.toHaveBeenCalled();
  });

  it("treats a session whose account has since gone as signed out", async () => {
    resolvePageSession.mockResolvedValue({ accountId: ACCOUNT_ID });
    readAccountHome.mockResolvedValue(undefined);

    await expect(AccountPage()).rejects.toThrow("redirect:/sign-in");
  });
});

describe("Seller/Promoter setup submission", () => {
  function captureFetch(reply: Response | (() => never)) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: unknown, init: unknown) => {
      calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
      if (typeof reply === "function") reply();
      return reply;
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends exactly the chosen roles and nothing else", async () => {
    const { calls, fetchImpl } = captureFetch(json(200, { status: "DRAFT", roles: [] }));

    expect(await submitOnboarding(["SELLER", "PROMOTER"], { fetchImpl })).toEqual({
      outcome: "started",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(ONBOARDING_ENDPOINT);
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.credentials).toBe("same-origin");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ roles: ["SELLER", "PROMOTER"] });
  });

  it("asks for a choice before sending anything", async () => {
    const { calls, fetchImpl } = captureFetch(json(200, {}));

    expect(await submitOnboarding([], { fetchImpl })).toEqual({
      outcome: "failed",
      message: ONBOARDING_NO_ROLE_CHOSEN,
    });
    expect(calls).toHaveLength(0);
  });

  it("maps every refusal onto bounded copy", async () => {
    const cases: Array<[Response | (() => never), string]> = [
      [json(409, { error: "PARTICIPANT_ONBOARDING_CLOSED" }), ONBOARDING_CLOSED],
      [json(401, { error: "UNAUTHENTICATED" }), ONBOARDING_SIGNED_OUT],
      [json(409, { error: "PARTICIPANT_ONBOARDING_CONFLICT" }), ONBOARDING_FAILURE],
      [json(500, { error: "anything the server says" }), ONBOARDING_FAILURE],
      [new Response("not json", { status: 502 }), ONBOARDING_FAILURE],
      [
        () => {
          throw new TypeError("network");
        },
        ONBOARDING_FAILURE,
      ],
    ];
    for (const [reply, message] of cases) {
      const { fetchImpl } = captureFetch(reply);
      expect(await submitOnboarding(["SELLER"], { fetchImpl })).toEqual({
        outcome: "failed",
        message,
      });
    }
  });
});
