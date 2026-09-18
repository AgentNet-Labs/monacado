/**
 * `/account` presentation — the internal Account id is not shown to the person.
 *
 * NO DATABASE, NO NETWORK. The session resolver, request headers, and router are
 * replaced so the page renders as it would for a live session; what the session
 * resolves to is proved by `auth-page-session.integration.test.ts`, and sign-out
 * submission by `auth-ui-submission.test.ts`.
 */

import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/* Vitest compiles JSX (the page's included) to `React.createElement` against a
   global `React`, where Next uses the automatic runtime. Provide it here rather
   than change the transform for every test. */
(globalThis as { React?: typeof React }).React = React;

const ACCOUNT_ID = "mon:acct:01TESTACCOUNTIDENTIFIER00";

const resolvePageSession = vi.fn();
const redirect = vi.fn((to: string) => {
  throw new Error(`redirect:${to}`);
});

vi.mock("../src/server/account/page-session", () => ({ resolvePageSession }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ cookie: "monacado_session=opaque" }),
}));
vi.mock("next/navigation", () => ({
  redirect,
  useRouter: () => ({ push: () => undefined, refresh: () => undefined }),
}));

const { default: AccountPage } = await import("../app/account/page");

describe("/account presentation", () => {
  beforeEach(() => {
    resolvePageSession.mockReset();
    redirect.mockClear();
  });

  it("renders the signed-in view with sign-out and without the internal account id", async () => {
    resolvePageSession.mockResolvedValue({ accountId: ACCOUNT_ID });

    const html = renderToStaticMarkup(await AccountPage());

    expect(html).toContain("<h1>Monacado</h1>");
    expect(html).toContain("You are signed in.");
    expect(html).toContain("Sign out");
    expect(html).not.toContain(ACCOUNT_ID);
    expect(html).not.toContain("mon:acct:");
    expect(redirect).not.toHaveBeenCalled();
  });

  it("still sends a visitor without a session to sign-in", async () => {
    resolvePageSession.mockResolvedValue(undefined);

    await expect(AccountPage()).rejects.toThrow("redirect:/sign-in");
  });
});
