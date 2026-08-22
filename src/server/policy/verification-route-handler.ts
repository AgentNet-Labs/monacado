/**
 * Verification consumption handler (Phase 1.4) — SERVER ONLY.
 *
 * The whole `/verify-email` behaviour expressed **without Next.js**, following
 * `checkout-route-handler.ts` and `worker-status-route-handler.ts` deliberately:
 * it takes a token and returns a bounded outcome, so every rule is testable
 * without constructing a framework request and no decision can hide inside a
 * page component.
 *
 * ## It answers in three ways, and none of them is an oracle
 *
 * | Outcome | When |
 * | --- | --- |
 * | `VERIFIED` | a pending, unexpired challenge matched, and its contact is now verified |
 * | `ALREADY_USED` | the challenge matched and had already been consumed |
 * | `NOT_VALID` | everything else — unknown, expired, superseded, or absent |
 *
 * Expired, superseded, and unknown collapse into **one** answer. That is `1.3`'s
 * rule, not a new one: distinguishing "no such token" from "that token has
 * expired" turns the page into a probe for which tokens exist. `ALREADY_USED` is
 * safe to separate because reaching it requires holding a token that was
 * genuinely issued — it tells the holder about their own link and nobody about
 * anybody else's.
 *
 * ## Nothing identifying comes back
 *
 * The result carries no address, no participant id, no contact id, no challenge
 * id, and no account. A verification page is reachable by anyone with a URL, and
 * the URL is exactly what an attacker guessing tokens would have.
 *
 * ## Method
 *
 * The link arrives as a `GET`, which is the only thing a mail client will follow.
 * The consequence — a scanner that follows links consumes the challenge before
 * the recipient does — is recorded in `VERIFICATION_OPERATIONAL_GAPS` rather than
 * papered over. The contact still verifies correctly; only the person clicking is
 * shown the wrong page.
 */

import "../server-only";
import { consumeVerificationChallenge, type VerificationDeps } from "./email-verification-service";
import { PolicyError, VerificationRefusedError } from "./policy-errors";

/** The three things this page can say. Bounded; the page renders from them. */
export const VERIFICATION_OUTCOMES = ["VERIFIED", "ALREADY_USED", "NOT_VALID"] as const;
export type VerificationOutcome = (typeof VERIFICATION_OUTCOMES)[number];

export interface VerificationPageResult {
  outcome: VerificationOutcome;
}

/**
 * Shape of a token that is worth a database lookup.
 *
 * 256 bits, base64url — 43 characters with no padding. Rejecting anything else
 * before touching the database costs nothing and means a flood of junk in the
 * query string is not a flood of queries.
 */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Consume a challenge and report what happened.
 *
 * Never throws for an ordinary refusal — a bad link is the expected case on a
 * page anyone can reach — and a persistence failure is reported as `NOT_VALID`
 * rather than surfacing a stack trace to a stranger. That conflation is
 * deliberate: it is the only outcome that is safe to show without knowing why,
 * and an operator reads the real cause from the logs, not from the page.
 */
export async function handleVerifyEmailRequest(
  input: { token: string | null; at: string },
  deps: VerificationDeps = {},
): Promise<VerificationPageResult> {
  if (input.token === null || !TOKEN_RE.test(input.token)) {
    return { outcome: "NOT_VALID" };
  }

  try {
    await consumeVerificationChallenge({ token: input.token, at: input.at }, deps);
    return { outcome: "VERIFIED" };
  } catch (error) {
    if (error instanceof VerificationRefusedError) {
      return {
        outcome: error.reason === "ALREADY_CONSUMED" ? "ALREADY_USED" : "NOT_VALID",
      };
    }
    if (error instanceof PolicyError) return { outcome: "NOT_VALID" };
    throw error;
  }
}
