/**
 * `/account` — the authenticated account home (Phase 1.25; Phase 1.29).
 *
 * Phase 1.25 made this the smallest page that proves a session exists. Phase
 * 1.29 makes it useful to the person who just registered to sell or promote: who
 * they are signed in as, whether their address is verified, and the one step
 * they can take next — starting Seller and/or Promoter setup.
 *
 * It is still deliberately **not** a dashboard or a settings screen. Nothing
 * here edits the account, changes a password, lists sessions, or reaches past
 * setup into activation, payment, or publication.
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
 *
 * ## What is shown, and what is not
 *
 * Name, email, and verification status are read server-side on every render
 * from the account the session resolved to (`readAccountHome`); none of them is
 * carried in the session. No internal identifier — account, session,
 * participant, or role — is ever handed to this page, so none can be rendered.
 *
 * An unverified address is shown plainly and blocks nothing here. Verification
 * gates going live, which is enforced where going live happens, not on setup.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolvePageSession } from "../../src/server/account/page-session";
import { readAccountHome } from "../../src/server/account/account-home";
import {
  EMAIL_UNVERIFIED_LABEL,
  EMAIL_UNVERIFIED_NOTE,
  EMAIL_VERIFIED_LABEL,
  PARTICIPANT_STATUS_LABELS,
  ROLE_LABELS,
  ROLE_STATUS_LABELS,
} from "./account-home-copy";
import { OnboardingForm } from "./onboarding-form";
import { SignOutButton } from "./sign-out-button";
import { SIGN_OUT_DESTINATION } from "./sign-out-submission";

/* This page reads a cookie. A cached render would be somebody else's session. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function AccountPage() {
  const session = await resolvePageSession((await headers()).get("cookie"));
  if (session === undefined) redirect(SIGN_OUT_DESTINATION);

  /* The session resolved, but the account can still have gone in between. That
     is a signed-out visitor, not an error page. */
  const home = await readAccountHome(session.accountId);
  if (home === undefined) redirect(SIGN_OUT_DESTINATION);

  const marketplace = home.marketplace;
  const setupRoles = (marketplace?.roles ?? []).filter((r) => r.role !== "BUYER");

  return (
    <main className="auth-main">
      <div className="auth-card">
        <h1>Monacado</h1>
        <p className="auth-signed-in">You are signed in.</p>

        <dl className="account-details">
          <dt>Name</dt>
          <dd>{home.name}</dd>
          <dt>Email</dt>
          <dd>{home.email}</dd>
          <dt>Email status</dt>
          <dd>{home.emailVerified ? EMAIL_VERIFIED_LABEL : EMAIL_UNVERIFIED_LABEL}</dd>
        </dl>
        {home.emailVerified ? null : <p className="auth-hint account-note">{EMAIL_UNVERIFIED_NOTE}</p>}

        <section className="account-section" aria-labelledby="account-marketplace-heading">
          <h2 id="account-marketplace-heading">Sell or promote on Monacado</h2>

          {setupRoles.length === 0 ? (
            <p className="auth-status">
              Set up as a Seller, a Promoter, or both. Setup is private — nothing is public
              until your setup is complete and approved.
            </p>
          ) : (
            <>
              <p className="auth-status">
                Marketplace status: {PARTICIPANT_STATUS_LABELS[marketplace!.status]}
              </p>
              <ul className="account-roles">
                {setupRoles.map((r) => (
                  <li key={r.role}>
                    {ROLE_LABELS[r.role]} — {ROLE_STATUS_LABELS[r.status]}
                  </li>
                ))}
              </ul>
            </>
          )}

          {home.setupRolesAvailable.length > 0 ? (
            <OnboardingForm
              available={home.setupRolesAvailable}
              submitLabel={setupRoles.length === 0 ? "Start setup" : "Add to setup"}
            />
          ) : null}
        </section>

        <SignOutButton />
      </div>
    </main>
  );
}
