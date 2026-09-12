/**
 * `/verify-account-email` — the page that proves a login address (Phase 1.27).
 *
 * ## Why this is not `/verify-email`
 *
 * That page consumes a **participant contact** token: it proves the address a
 * seller publishes for customer support. This one consumes an **account** token:
 * it proves the address somebody signs in with. The two token spaces live in
 * different tables and neither verifier can read the other's, which is the
 * property that makes them safe to have side by side.
 *
 * Sharing one path would have meant a verifier that tries one table, then the
 * other — and that function is exactly where "which kind of token is this" gets
 * decided wrongly under a deadline. Two paths cost one file and remove the
 * question.
 *
 * ## It is styled, and the participant page is not
 *
 * Deliberate, not drift. `/verify-email` is the tail of a seller onboarding flow
 * and predates the Phase 1.25 auth surface. This page is the middle of the
 * sign-up journey — a person arrives here from their inbox and must get back to
 * `/sign-in` — so it wears the same `auth-card` as the two pages either side of
 * it and offers the link onward. Dropping them on an unstyled page mid-journey
 * would read as an error even when it says "verified".
 *
 * ## No session is created here
 *
 * Verifying proves an address; it does not sign anybody in. A page that minted a
 * session from a link in an email would make that link a credential, and it
 * travels through inboxes and prefetchers. The person signs in with the password
 * they chose.
 */

import Link from "next/link";
import { handleAccountVerifyEmailRequest } from "../../src/server/account/account-verification-route-handler";

/* This page consumes a token and writes to the database. A cached render would
   be somebody else's verification. */
export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The three outcomes, in the recipient's terms and nobody else's.
 *
 * None of them names an account, an address, or a time. `ALREADY_USED` is kept
 * separate from `NOT_VALID` because the next step genuinely differs: a used link
 * usually means the job is done, and somebody told "not valid" will go looking
 * for another link they do not need.
 */
const OUTCOME: Record<string, { headline: string; explanation: string; signIn: boolean }> = {
  VERIFIED: {
    headline: "Email address confirmed",
    explanation: "Your Monacado account is ready. You can now sign in.",
    signIn: true,
  },
  ALREADY_USED: {
    headline: "This link has already been used",
    explanation:
      "Confirmation links work once. If this address was already confirmed, there is nothing more to do — you can sign in.",
    signIn: true,
  },
  NOT_VALID: {
    headline: "This link is not valid",
    explanation:
      "This confirmation link is not valid, or it has expired. Links expire 24 hours after they are sent, and asking for a new one replaces any earlier link. Sign up again with the same address to receive a fresh link.",
    signIn: false,
  },
};

export default async function VerifyAccountEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.token;
  const token = typeof raw === "string" ? raw : null;

  /* The clock is the server's. Nothing about expiry is decided from anything the
     visitor sent. */
  const result = await handleAccountVerifyEmailRequest({
    token,
    at: new Date().toISOString(),
  });
  const outcome = OUTCOME[result.outcome] ?? OUTCOME.NOT_VALID!;

  return (
    <main className="auth-main">
      <div className="auth-card">
        <h1>Monacado</h1>
        {outcome.signIn ? (
          <p className="auth-signed-in" role="status">
            {outcome.headline}
          </p>
        ) : (
          <p className="auth-error" role="alert">
            {outcome.headline}
          </p>
        )}
        <p className="auth-status">{outcome.explanation}</p>
        <Link
          className="auth-button auth-button-link"
          href={outcome.signIn ? "/sign-in" : "/sign-up"}
        >
          {outcome.signIn ? "Go to sign in" : "Back to sign up"}
        </Link>
      </div>
    </main>
  );
}
