/**
 * The email verification page (Phase 1.4).
 *
 * Where a verification link lands. It is the smallest page that can do the job:
 * take the token out of the query string, hand it to the handler, and say which
 * of three things happened.
 *
 * ## It renders nothing it was not given
 *
 * No address, no seller name, no participant, no order, and no challenge id — a
 * page reachable by anyone holding a URL must not become a way to look one of
 * those up. The success page does not even confirm *which* address was verified,
 * because the person who asked already knows and anyone else should not learn.
 *
 * ## Unstyled, like every other page here
 *
 * Marketplace design is not this phase's subject, and a page that looked finished
 * would invite people to treat it as finished.
 *
 * Server component. No client JavaScript, no form, and nothing to retry — the
 * link is single-use, so reloading is not a second attempt.
 */

import { handleVerifyEmailRequest } from "../../src/server/policy/verification-route-handler";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/**
 * The three outcomes, said in the recipient's terms.
 *
 * `ALREADY_USED` is separated from `NOT_VALID` because the next step differs: a
 * used link usually means the job is already done, and a person told "not valid"
 * will ask for another one they do not need.
 */
const OUTCOME: Record<string, { headline: string; explanation: string }> = {
  VERIFIED: {
    headline: "Email address verified",
    explanation:
      "Thank you. This address is now verified with Monacado and can be used as a customer support contact. You can close this page.",
  },
  ALREADY_USED: {
    headline: "This link has already been used",
    explanation:
      "Verification links work once. If this address was verified already, there is nothing more to do. If you still need to verify an address, request a new link from your Monacado seller profile.",
  },
  NOT_VALID: {
    headline: "This link is not valid",
    explanation:
      "This verification link is not valid, or it has expired. Links expire 24 hours after they are sent, and requesting a new one replaces any earlier link. Request a fresh link from your Monacado seller profile.",
  },
};

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.token;
  const token = typeof raw === "string" ? raw : null;

  /* The clock is the server's. Nothing about expiry is decided from anything the
     visitor sent. */
  const result = await handleVerifyEmailRequest({ token, at: new Date().toISOString() });
  const outcome = OUTCOME[result.outcome] ?? OUTCOME.NOT_VALID!;

  return (
    <main>
      <h1>{outcome.headline}</h1>
      <p>{outcome.explanation}</p>
    </main>
  );
}
