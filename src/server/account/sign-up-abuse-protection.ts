/**
 * Sign-up abuse protection (Phase 1.27) — SERVER ONLY.
 *
 * Phase 1.27's first pre-commit report named this as a FIX NOW: public sign-up
 * shipped unthrottled, and an unthrottled account-creation endpoint is a real
 * exposure. This closes it, with a counter of its own rather than a share of
 * sign-in's.
 *
 * ## What this actually defends against — stated honestly
 *
 * The counter is keyed by the **submitted address**, so it bounds *repeated
 * registrations of one address*. The abuse that matters there is not account
 * creation: it is **verification-email bombing**. Every sign-up attempt on an
 * address can dispatch a real email to a third party who never asked for it, and
 * without a bound this endpoint is a free mailer aimed at anybody whose address
 * an attacker knows. That is the hole being closed.
 *
 * It does **not** bound distributed mass registration across many different
 * addresses. Nothing keyed on the address can: an attacker with ten thousand
 * addresses gets ten thousand budgets. Bounding that needs a network identity or
 * a challenge, and this repository has neither — `PRE_LIVE_COMMERCE_CONTROLS.md`
 * rules out IP-derived identity ("an IP locates a network interface, not a
 * buyer"), and CAPTCHA was explicitly excluded from this phase. So the limit is
 * not claimed to solve it, and it is carried as a named deferral rather than
 * quietly implied to be covered.
 *
 * ## The threshold, and why it is tighter than sign-in's
 *
 * **Five attempts per address per hour**, against sign-in's eight per fifteen
 * minutes. Deliberately stricter on both axes, because the two endpoints have
 * different victims. A failed sign-in costs an attacker one Argon2 verification
 * and costs the account holder nothing; a sign-up attempt can put a message in
 * somebody else's inbox. Five leaves a genuine person room to fumble the form,
 * retry after a typo, and ask for the link again when it did not arrive, while
 * capping an inbox at five unsolicited Monacado emails an hour rather than as
 * many as a script can issue.
 *
 * The window is an hour rather than fifteen minutes for the same reason: a
 * fifteen-minute window refills four times as often, which is four times the mail
 * an attacker can aim at one address per hour.
 *
 * ## Why it does not reuse the Phase 1.23 limiter
 *
 * Because that module forbids it in its own header: "no route key, no policy
 * table, no bucket registry, and no way to apply it to a second endpoint." The
 * shared *mechanism* was extracted to `auth-throttle.ts`; the *policies* stayed
 * separate, and sign-in's prefix, limit, window, and key bytes are untouched.
 *
 * ## Domain separation
 *
 * Both policies are peppered with the same secret, so the HMAC **message** must
 * differ or one person's sign-in and sign-up budgets would collide into a single
 * counter and each endpoint would silently eat the other's allowance. Sign-up
 * mixes in an explicit domain label; sign-in keeps the bare construction it has
 * always used. See `auth-throttle.ts`.
 *
 * ## Fail closed
 *
 * There is no in-memory fallback and no master switch, for the reason Phase 1.23
 * gives: a limiter that degrades to a process-local `Map` is not a limiter on a
 * platform with more than one instance. If Redis cannot answer, public sign-up
 * refuses — it does not create accounts and send mail unprotected.
 */

import "../server-only";
import { Redis } from "@upstash/redis";
import {
  redisAuthThrottle,
  type AuthThrottle,
  type AuthThrottleBackend,
  type AuthThrottleDecision,
  type AuthThrottlePolicy,
} from "./auth-throttle";
import {
  readSignInThrottleRuntimeConfig,
  resolveSignInThrottleKeySecret,
  resolveSignInThrottleRestToken,
  type Env,
} from "./sign-in-throttle-runtime-config";
import { SignInThrottleUnavailableError } from "./sign-in-throttle-errors";

/** Registrations permitted per address per window. See the header for why five. */
export const SIGN_UP_ATTEMPT_LIMIT = 5;

/** One hour. Fixed — it does not slide. */
export const SIGN_UP_THROTTLE_WINDOW_SECONDS = 3600;

/** Its own namespace, so a sign-up counter can never be read as a sign-in one. */
export const SIGN_UP_THROTTLE_KEY_PREFIX = "monacado:signup:credential:";

/**
 * The HMAC domain label. Distinct from sign-in's (which has none, for backward
 * compatibility), so the same address under the same secret yields unrelated
 * digests on the two endpoints.
 *
 * Versioned so that if the construction ever has to change, the new label
 * abandons the old key space cleanly rather than half-colliding with it.
 */
export const SIGN_UP_THROTTLE_HMAC_DOMAIN = "monacado.signup.v1";

export const SIGN_UP_THROTTLE_POLICY: AuthThrottlePolicy = {
  keyPrefix: SIGN_UP_THROTTLE_KEY_PREFIX,
  hmacDomain: SIGN_UP_THROTTLE_HMAC_DOMAIN,
  limit: SIGN_UP_ATTEMPT_LIMIT,
  windowSeconds: SIGN_UP_THROTTLE_WINDOW_SECONDS,
};

export type SignUpThrottleDecision = AuthThrottleDecision;
export type SignUpThrottle = AuthThrottle;

/** Build the sign-up throttle over a backend. Exported for tests. */
export function redisSignUpThrottle(
  backend: AuthThrottleBackend,
  keySecret: string,
): SignUpThrottle {
  return redisAuthThrottle(backend, keySecret, SIGN_UP_THROTTLE_POLICY, (cause) =>
    cause === undefined
      ? new SignInThrottleUnavailableError()
      : new SignInThrottleUnavailableError(cause),
  );
}

let cachedBackend: AuthThrottleBackend | undefined;

/**
 * The production sign-up throttle, built lazily from the environment.
 *
 * **It reuses sign-in's environment block deliberately**, and this is the one
 * place that choice is visible. `MONACADO_REDIS_REST_URL`, the REST token, and
 * `MONACADO_SIGN_IN_THROTTLE_SECRET` all already exist in every environment that
 * can accept a password, so sign-up needs no new variable and no new staging
 * provisioning to be protected. What keeps that safe is not the shared secret but
 * the domain label above: the two key spaces are cryptographically independent
 * even though the pepper is one value.
 *
 * The alternative — a second secret — would have meant a deployment where
 * sign-in is protected and sign-up silently is not because a variable was
 * forgotten. Reusing one governed secret under explicit domain separation fails
 * closed in the same breath as sign-in does.
 */
export function defaultSignUpThrottle(env: Env = process.env): SignUpThrottle {
  const config = readSignInThrottleRuntimeConfig(env);
  const keySecret = resolveSignInThrottleKeySecret(config, env);
  if (cachedBackend === undefined) {
    cachedBackend = new Redis({
      url: config.restUrl,
      token: resolveSignInThrottleRestToken(config, env),
    }) as unknown as AuthThrottleBackend;
  }
  return redisSignUpThrottle(cachedBackend, keySecret);
}

/** Drop the memoised client (tests and scripts; never part of a request). */
export function resetSignUpThrottleBackend(): void {
  cachedBackend = undefined;
}
