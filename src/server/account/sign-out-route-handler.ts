/**
 * Sign-out route handler (Phase 1.24) — SERVER ONLY.
 *
 * The other half of Phase 1.22. Sign-in mints a session and hands back a cookie;
 * until now nothing ended one over HTTP, so the only way out of a session was to
 * wait twelve hours for it to expire. `revokeAccountSession` has existed since
 * Phase 0E.7.4.2A and `buildClearedSessionCookie` since the same phase, both
 * written for "the deferred route adapter". This is that adapter, and it is
 * nothing more.
 *
 * ## It revokes by the token in the cookie, and resolves nothing first
 *
 * There is deliberately no `resolveActingAccount` call here, unlike every other
 * authenticated route. Resolution answers "who is this, and may they act" — and
 * sign-out asks neither question. It needs one thing: the token the caller
 * presented. `revokeAccountSession` matches on `tokenHash = hash(token) AND
 * revokedAt IS NULL`, so the token *is* the scope: it can only ever end the one
 * session it names, and no caller-supplied field can widen that.
 *
 * Resolving first would also be worse than useless. `resolveAccountSession`
 * returns `undefined` for expired, revoked, and since-disabled alike, so a route
 * that resolved before revoking would have to decide what to do about a stale
 * cookie — and every available answer either refuses a sign-out that should
 * always succeed, or discloses whether the presented token was ever real.
 *
 * ## Every sign-out succeeds
 *
 * A valid session, an expired one, an already-revoked one, a token that never
 * existed, and no cookie at all all produce the same 200 and the same clearing
 * `Set-Cookie`. This is the doctrine `revokeAccountSession` already states in as
 * many words — "sign-out must never fail, and reporting 'no such session' would
 * tell the caller whether the token they hold was ever real" — and it is also
 * the only behaviour that is correct for a user: someone pressing sign-out wants
 * to end up signed out, not to be told their session was already gone.
 *
 * `{ revoked }` is therefore read and discarded. Surfacing it would rebuild the
 * oracle the uniform answer exists to close.
 *
 * ## What it does not touch
 *
 * Not the Account row, not its status, not the participant, not any other
 * session belonging to the same account — signing out on a laptop must not sign
 * the same person out on their phone, and "sign out everywhere" is a different
 * authority that this route deliberately does not expose even though
 * `revokeAllAccountSessions` sits next to the primitive it does call.
 *
 * And not Redis. Phase 1.23's sign-in attempt budget is keyed on a credential
 * identifier and is about *failed* authentication; a successful sign-out is not
 * evidence about that, and clearing the bucket here would hand anyone holding
 * any cookie a way to reset a throttle they are supposed to be subject to.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import { revokeAccountSession } from "./account-session-service";
import { buildClearedSessionCookie, readSessionCookie } from "./session-cookie";
import { normalizeOrigin } from "../payments/checkout-runtime-config";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

/**
 * Bounded response codes.
 *
 * Two, and no third. There is no "not signed in" code because that is not a
 * failure here, and no "session not found" code because whether it was found is
 * exactly what must not travel.
 */
export const SIGN_OUT_ERROR_CODES = {
  crossOrigin: "CROSS_ORIGIN_REQUEST_REFUSED",
  unavailable: "SIGN_OUT_UNAVAILABLE",
} as const;

/** The same set sign-in uses; a sign-out response is equally uncacheable. */
export const SIGN_OUT_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
});

export interface SignOutRouteResult {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

/**
 * What the route reads.
 *
 * An origin and a cookie. **No content type and no body** — there is no input to
 * this operation, so there is no parse step, and therefore no payload through
 * which a caller could name a session, an account, or a scope. The absence of
 * those fields is the control; a `strictObject` rejecting them would merely be a
 * second statement of it.
 */
export interface SignOutRouteRequest {
  originHeader: string | null;
  cookieHeader: string | null;
}

export interface SignOutRouteDeps {
  db?: Db | Prisma.TransactionClient;
  /** Injected so a test can pin the instant; production reads the clock. */
  now?: () => string;
  appOrigin?: string | undefined;
}

/** A present origin must match; a missing one is permitted, as on sign-in. */
function originAcceptable(originHeader: string | null, appOrigin: string | undefined): boolean {
  if (originHeader === null || originHeader === "" || originHeader === "null") return true;
  const configured = normalizeOrigin(appOrigin ?? "");
  if (configured === undefined) return false;
  return normalizeOrigin(originHeader) === configured;
}

/**
 * End the session the caller presented, and clear its cookie.
 *
 * Order: origin, then revoke, then clear. Origin first for the reason the
 * governance routes give — a cross-origin caller should learn nothing at all,
 * including whether their cookie was worth anything — and because a cross-site
 * post that could revoke a session would be a working logout-CSRF, which is a
 * denial of service rather than a disclosure but is still not this route's to
 * hand out.
 */
export async function handleSignOutRequest(
  request: SignOutRouteRequest,
  deps: SignOutRouteDeps = {},
): Promise<SignOutRouteResult> {
  const codes = SIGN_OUT_ERROR_CODES;
  const appOrigin = deps.appOrigin ?? process.env.MONACADO_APP_ORIGIN;
  if (!originAcceptable(request.originHeader, appOrigin)) {
    return {
      status: 403,
      body: { error: codes.crossOrigin },
      /* No clearing cookie on a refusal: a cross-site page must not be able to
         log a visitor out of Monacado by being loaded. */
      headers: { ...SIGN_OUT_HEADERS },
    };
  }

  /* `Secure` follows the origin this deployment answers on, exactly as sign-in
     decides it — a clearing cookie whose attributes differ from the cookie it
     clears is one a browser may decline to replace. */
  const secure = (normalizeOrigin(appOrigin ?? "") ?? "").startsWith("https:");
  const cleared = buildClearedSessionCookie({ secure });

  const token = readSessionCookie(request.cookieHeader);
  if (token !== undefined) {
    const now = (deps.now ?? (() => new Date().toISOString()))();
    const db = deps.db as Db | undefined;
    try {
      /* Idempotent, and scoped to this token alone. The `{ revoked }` it returns
         is deliberately discarded — see the module header. */
      await revokeAccountSession(token, {
        revokedAt: now,
        ...(db !== undefined ? { db } : {}),
      });
    } catch {
      /* A persistence failure is the one case the caller is told about, because
         it is the one case where the session may still be live and pretending
         otherwise would be a lie a user acts on. No cookie is cleared, for the
         same reason. */
      return { status: 500, body: { error: codes.unavailable }, headers: { ...SIGN_OUT_HEADERS } };
    }
  }

  /* One answer for every reachable state: signed in, expired, already revoked,
     never real, or no cookie at all. */
  return {
    status: 200,
    body: { signedOut: true },
    headers: { ...SIGN_OUT_HEADERS, "set-cookie": cleared },
  };
}
