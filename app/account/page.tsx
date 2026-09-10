/**
 * `/account` — the authenticated landing surface (Phase 1.25).
 *
 * **The smallest page that proves a session exists.** There was no authenticated
 * destination in `app/` at all before this phase — the landing page, the listing
 * page, and the checkout result page are all reachable signed out — so sign-in
 * had nowhere to send anybody. This is that destination and it is nothing more:
 * a statement that the visitor is signed in, the account the session resolved
 * to, and the control that ends it.
 *
 * It is deliberately **not** a dashboard, a profile, or a settings screen. None
 * of those was asked for, each would need data this page does not fetch, and a
 * product surface invented merely to have somewhere to land is how a phase that
 * was supposed to close an auth loop turns into an account area.
 *
 * ## The guard is here, in the page that renders the content
 *
 * Not in `middleware.ts`, which still does not exist. A matcher is a second
 * statement of which paths are protected, kept in a different file from the
 * thing it protects, and the failure mode is a route added later that nobody
 * adds to the list. A page that resolves the session before it renders cannot be
 * forgotten, because forgetting it means the page has no session to render from.
 *
 * The redirect happens during render, so no protected content is ever in the
 * document for an unauthenticated visitor — not briefly, not in a payload the
 * browser discards. `resolvePageSession` returns `undefined` for an expired,
 * revoked, or since-disabled session exactly as it does for no cookie at all, so
 * a stale cookie lands on `/sign-in` like any other signed-out visitor.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolvePageSession } from "../../src/server/account/page-session";
import { SignOutButton } from "./sign-out-button";
import { SIGN_OUT_DESTINATION } from "./sign-out-submission";

/* This page reads a cookie. A cached render would be somebody else's session. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AccountPage() {
  const session = await resolvePageSession((await headers()).get("cookie"));
  if (session === undefined) redirect(SIGN_OUT_DESTINATION);

  return (
    <main className="auth-main">
      <div className="auth-card">
        <h1>Monacado</h1>
        <p className="auth-signed-in">You are signed in.</p>
        {/* The account's own opaque id, shown to the account it belongs to. It
            is what the session resolved to and what `/api/auth/sign-in` already
            returns to the caller, so it discloses nothing the browser was not
            told a moment ago — and it makes this page evidence of *which*
            session is live rather than merely that one is. No email, no name,
            no status: those would need a profile read this phase does not do. */}
        <p className="auth-status">
          Account <code>{session.accountId}</code>
        </p>
        <SignOutButton />
      </div>
    </main>
  );
}
