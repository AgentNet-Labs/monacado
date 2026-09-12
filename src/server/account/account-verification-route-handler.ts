/**
 * Account email verification route handler (Phase 1.27) — SERVER ONLY.
 *
 * Framework-free, like `verification-route-handler.ts` beside it and
 * `checkout-route-handler.ts` before that: it takes a token string and an
 * instant, and answers with one of three bounded outcomes. The page calls it; no
 * `Request`, no `Response`, and no test needs a mocked request context.
 *
 * ## Three outcomes, and what each is allowed to mean
 *
 *   VERIFIED    — the challenge was live and is now spent. The account may sign in.
 *   ALREADY_USED — this exact link was already consumed. Distinguished from the
 *                  refusals because it is a genuinely different situation for the
 *                  person holding it: their address IS proved, they simply
 *                  clicked twice, and telling them to try again would be wrong.
 *                  It discloses nothing a holder of the token did not already
 *                  have — they are the one who used it.
 *   NOT_VALID   — everything else: never existed, expired, superseded by a newer
 *                 link, malformed, absent, or bound to an address the account no
 *                 longer uses. One answer for all of them, because separating
 *                 "expired" from "never existed" tells a caller which of their
 *                 guesses was once real.
 *
 * Nothing identifying is ever returned: no account id, no email, no name, no
 * challenge id, no timestamp. Somebody who opens a stranger's link learns only
 * that it did not work.
 *
 * ## The token is shape-checked before any lookup
 *
 * 43 URL-safe base64 characters — exactly what 32 random bytes produce. A string
 * that cannot be a token is refused without touching the database, so scanning
 * this endpoint costs an attacker a request and Monacado nothing.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  AccountVerificationRefusedError,
  consumeAccountEmailChallenge,
  type AccountVerificationDeps,
} from "./account-email-verification-service";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

export const ACCOUNT_VERIFICATION_OUTCOMES = ["VERIFIED", "ALREADY_USED", "NOT_VALID"] as const;
export type AccountVerificationOutcome = (typeof ACCOUNT_VERIFICATION_OUTCOMES)[number];

/** 32 random bytes, base64url, unpadded. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface AccountVerificationRouteDeps extends AccountVerificationDeps {
  db?: Db | Prisma.TransactionClient;
}

export async function handleAccountVerifyEmailRequest(
  input: { token: string | null; at: string },
  deps: AccountVerificationRouteDeps = {},
): Promise<{ outcome: AccountVerificationOutcome }> {
  if (input.token === null || !TOKEN_RE.test(input.token)) return { outcome: "NOT_VALID" };

  try {
    await consumeAccountEmailChallenge({ token: input.token, at: input.at }, deps);
    return { outcome: "VERIFIED" };
  } catch (error) {
    if (
      error instanceof AccountVerificationRefusedError &&
      error.reason === "ALREADY_CONSUMED"
    ) {
      return { outcome: "ALREADY_USED" };
    }
    /* Every other refusal, and every persistence fault, answers identically. A
       database outage must not be distinguishable from a bad token here. */
    return { outcome: "NOT_VALID" };
  }
}
