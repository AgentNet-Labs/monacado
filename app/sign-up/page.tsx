/**
 * `/sign-up` — the page a person creates an Account on (Phase 1.27).
 *
 * Phase 1.25 gave Monacado a front door but no way to be issued a key: `/sign-in`
 * could only admit accounts that `scripts/db-check.ts` or a test fixture had
 * already created. This is the surface that makes the loop self-serve.
 *
 * ## The guard is the same one `/sign-in` uses, for the same reason
 *
 * A signed-in visitor is redirected to `/account` before anything renders, in the
 * page that renders the content rather than in a matcher kept somewhere else.
 * `middleware.ts` still does not exist, deliberately — see `page-session.ts`.
 *
 * Resolving during render also means the form is never in the document for
 * somebody who does not need it, which matters more here than on sign-in: a
 * registration form briefly on screen is a registration form a password manager
 * briefly offers to generate a new credential into.
 *
 * ## What this page creates, and what it conspicuously does not
 *
 * An Account. Not a `MarketplaceParticipant`, not a Seller or Promoter role, not
 * a `Storefront`, not a policy acceptance, and not any commercial activation.
 * Those are separate governed phases, and the schema keeps admission on its own
 * record precisely so that signing up and being admitted to the marketplace stay
 * different facts about a person.
 */

import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { resolvePageSession } from "../../src/server/account/page-session";
import { SIGN_IN_DESTINATION } from "../sign-in/sign-in-submission";
import { SignUpForm } from "./sign-up-form";

/* Matching every other page in `app/`: this one reads a cookie, so a cached
   render would be somebody else's session. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function SignUpPage() {
  const session = await resolvePageSession((await headers()).get("cookie"));
  if (session !== undefined) redirect(SIGN_IN_DESTINATION);

  return (
    <main className="auth-main">
      <div className="auth-card">
        <h1>Monacado</h1>
        <p className="auth-lede">Create your account.</p>
        <SignUpForm />
        <p className="auth-alt">
          Already have an account? <Link href="/sign-in">Sign in</Link>
        </p>
      </div>
    </main>
  );
}
