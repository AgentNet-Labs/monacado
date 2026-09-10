/**
 * `/sign-in` — the page a person actually signs in on (Phase 1.25).
 *
 * Phase 1.22 built the endpoint and Phase 1.24 built its exit, but neither was
 * reachable from a browser: the only callers were tests that constructed a
 * request by hand. This is the surface that makes the loop operable.
 *
 * ## The guard is a server redirect, not a client one
 *
 * A signed-in visitor is sent to `/account` before anything renders. Doing this
 * in an effect would post a form to the screen, then take it away — and for the
 * fraction of a second it was there, a password manager would have offered to
 * fill it. Resolving the session during render means the form is never in the
 * document for a visitor who does not need it.
 *
 * ## One destination, and it is written here
 *
 * There is no `?next=` and no `returnTo`. A redirect target taken from the
 * request is an open redirect unless something validates it, and the validator
 * is the part that gets written wrong. Phase 1.25 has exactly one place to be
 * after signing in, so it is a constant in `sign-in-submission.ts` and the same
 * constant answers for the client navigation and this server one.
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolvePageSession } from "../../src/server/account/page-session";
import { SignInForm } from "./sign-in-form";
import { SIGN_IN_DESTINATION } from "./sign-in-submission";

/* Matching every other page in `app/`: this one reads a cookie, so a cached
   render would be somebody else's session. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SignInPage() {
  const session = await resolvePageSession((await headers()).get("cookie"));
  if (session !== undefined) redirect(SIGN_IN_DESTINATION);

  return (
    <main className="auth-main">
      <div className="auth-card">
        <h1>Monacado</h1>
        <p className="auth-lede">Sign in to your account.</p>
        <SignInForm />
      </div>
    </main>
  );
}
