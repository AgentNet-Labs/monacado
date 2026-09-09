/**
 * Sign-in route handler (Phase 1.22) — SERVER ONLY.
 *
 * **The half of authentication that was missing.** The resolution half has been
 * real since Phase 1.18 — `resolveAuthenticatedPrincipal` reads a persisted
 * session and re-reads entitlements on every call, so a revoked session or a
 * disabled account fails closed immediately — but nothing issued a session over
 * HTTP. `acting-participant-boundary` said so in as many words: "No route sets a
 * session cookie yet; sign-in remains deferred." This is that route, and it is
 * only that route.
 *
 * ## It verifies nothing itself
 *
 * Every credential rule already exists in `authenticateAccount`, and this module
 * calls it rather than restating it. That matters more here than elsewhere,
 * because the rules are subtle and each one is load-bearing:
 *
 *   - the lookup is by `normalizedEmail`, the column that is actually unique;
 *   - a missing account still hashes, against `timingDecoyHash()`, so "no such
 *     email" and "wrong password" cost the same;
 *   - a non-`ACTIVE` account is refused **with the same error** as a wrong
 *     password, so a disabled account is not disclosed by its refusal;
 *   - and a malformed submission is a credential failure rather than a
 *     validation report, because naming the bad field tells a caller the other
 *     one was right.
 *
 * Re-deriving any of that at the HTTP edge would be a second answer able to
 * disagree with the first.
 *
 * ## What the route decides
 *
 * Origin, request shape, session lifetime, and the cookie. Nothing else.
 *
 * The request schema is `strictObject`, so an unknown key is a refusal — a
 * caller cannot smuggle `accountId`, a session token, a role, or a cookie option
 * into a sign-in. But the *values* are deliberately unvalidated here beyond
 * being strings: an empty password, an over-long one, and a malformed address
 * are all credential-shaped failures, and they belong on the one uniform 401
 * with everything else rather than on a 400 that says the shape was the problem.
 *
 * ## The token is returned once, and only in a cookie
 *
 * `createAccountSession` hands back the raw token exactly once; only its digest
 * is persisted. It goes into `Set-Cookie` through the existing builder —
 * `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` on an https origin — and
 * never into the response body. A JSON field carrying it would put a live
 * credential into every log, proxy, and browser history that saw the response.
 */

import "../server-only";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { DEFAULT_SESSION_TTL_SECONDS } from "../../contracts/account/account";
import { authenticateAccount } from "./account-service";
import { createAccountSession } from "./account-session-service";
import { buildSessionCookie } from "./session-cookie";
import { InvalidCredentialsError } from "./account-errors";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

/**
 * Bounded response codes.
 *
 * Every non-200 body is exactly `{ "error": <one of these> }`. In particular
 * there is one credential code and no others: an unknown address, a wrong
 * password, and a disabled account are indistinguishable from outside, which is
 * the whole point of `InvalidCredentialsError` and would be undone by a route
 * that split them apart again.
 */
export const SIGN_IN_ERROR_CODES = {
  invalidCredentials: "INVALID_CREDENTIALS",
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  invalidRequest: "INVALID_SIGN_IN_REQUEST",
  unavailable: "SIGN_IN_UNAVAILABLE",
} as const;

export const SIGN_IN_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

export interface SignInRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

export interface SignInRouteRequest {
  contentType: string | null;
  originHeader: string | null;
  rawBody: string;
}

export interface SignInRouteDeps {
  db?: Db | Prisma.TransactionClient;
  now?: () => string;
  appOrigin?: string | undefined;
}

/**
 * What a caller may state.
 *
 * Two members, both plain strings. `strictObject` makes anything else a
 * refusal — there is no field here through which a caller could name an
 * account, present a token, claim a role, or set a cookie option.
 *
 * The values are bounded by `AuthenticateAccountInput` one layer down rather
 * than here, deliberately: a length rule enforced at this layer would answer
 * 400 for an over-long password, which tells a caller their *shape* was wrong
 * when the honest answer is that the credentials did not work.
 */
export const SignInRequest = z.strictObject({
  email: z.string(),
  password: z.string(),
});
export type SignInRequest = z.infer<typeof SignInRequest>;

/**
 * Names that must never appear on a sign-in request.
 *
 * The schema is strict, so an unknown key already fails. This list states the
 * intent and gives a test something to enumerate — the same belt-and-braces
 * shape `NEVER_ON_GOVERNANCE_REQUEST` uses, and equally not the control.
 */
export const NEVER_ON_SIGN_IN_REQUEST = [
  "accountId",
  "participantId",
  "sessionId",
  "token",
  "sessionToken",
  "role",
  "capabilities",
  "internalCapabilities",
  "status",
  "ttlSeconds",
  "secure",
  "maxAgeSeconds",
] as const;

function refuse(status: number, code: string): SignInRouteResult {
  return { status, body: { error: code }, headers: { ...SIGN_IN_HEADERS } };
}

/** A present origin must match; a missing one is permitted, as on checkout. */
function originAcceptable(originHeader: string | null, appOrigin: string | undefined): boolean {
  if (originHeader === null || originHeader === "" || originHeader === "null") return true;
  const configured = normalizeOrigin(appOrigin ?? "");
  if (configured === undefined) return false;
  return normalizeOrigin(originHeader) === configured;
}

/**
 * Authenticate, and hand back a session cookie.
 *
 * Order: origin, then shape, then credentials. Unlike the governance routes
 * there is no session to resolve first — this is the endpoint that creates one —
 * so the body must be read before anything can be decided, and the strict parse
 * is what stops that from being an opening.
 */
export async function handleSignInRequest(
  request: SignInRouteRequest,
  deps: SignInRouteDeps = {},
): Promise<SignInRouteResult> {
  const codes = SIGN_IN_ERROR_CODES;
  const appOrigin = deps.appOrigin ?? process.env.MONACADO_APP_ORIGIN;
  if (!originAcceptable(request.originHeader, appOrigin)) {
    return refuse(403, codes.crossOrigin);
  }

  const type = (request.contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/json") return refuse(400, codes.invalidRequest);

  let candidate: unknown;
  try {
    candidate = JSON.parse(request.rawBody);
  } catch {
    return refuse(400, codes.invalidRequest);
  }
  const parsed = SignInRequest.safeParse(candidate);
  if (!parsed.success) return refuse(400, codes.invalidRequest);

  const now = (deps.now ?? (() => new Date().toISOString()))();
  const db = deps.db as Db | undefined;

  try {
    /* Every credential rule — normalized lookup, the timing decoy, the ACTIVE
       requirement, and the single uniform failure — lives here. */
    const account = await authenticateAccount(
      { email: parsed.data.email, password: parsed.data.password },
      { ...(db !== undefined ? { db } : {}) },
    );

    const { token } = await createAccountSession(
      {
        accountId: account.accountId,
        createdAt: now,
        ttlSeconds: DEFAULT_SESSION_TTL_SECONDS,
      },
      { ...(db !== undefined ? { db } : {}) },
    );

    /* `Secure` follows the origin this deployment answers on, exactly as the
       guest-claim cookie decides it. */
    const secure = (normalizeOrigin(appOrigin ?? "") ?? "").startsWith("https:");
    const cookie = buildSessionCookie(token, {
      secure,
      maxAgeSeconds: DEFAULT_SESSION_TTL_SECONDS,
    });

    return {
      status: 200,
      /* The caller's own account id, and nothing else. Not the token — that
         travels only in the cookie — and not the email, name, or status they
         did not ask for. */
      body: { accountId: account.accountId },
      headers: { ...SIGN_IN_HEADERS, "set-cookie": cookie },
    };
  } catch (error) {
    if (error instanceof InvalidCredentialsError) {
      return refuse(401, codes.invalidCredentials);
    }
    return refuse(500, codes.unavailable);
  }
}
