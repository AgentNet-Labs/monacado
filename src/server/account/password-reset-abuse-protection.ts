/**
 * Password-reset abuse protection (Phase 1.28) — SERVER ONLY.
 *
 * The third explicit policy over `auth-throttle.ts`, and the same shape as
 * sign-up's, because it defends against the same thing: every reset request for
 * a real account puts an email in somebody's inbox, so an unbounded endpoint is a
 * free mailer aimed at any address an attacker knows.
 *
 * **Five requests per address per hour**, matching sign-up and for the same
 * reasons: room for a person to ask again when a message is slow, and a hard cap
 * on unsolicited mail to anybody else.
 *
 * The budget is charged against the **submitted** address before anything looks
 * it up, so an address with no account spends exactly the same budget as one
 * with an account — the limiter cannot become an existence oracle.
 *
 * ## Its own key space
 *
 * Same Redis, same pepper, different prefix and a different HMAC domain label,
 * so a person's reset budget can never collide with their sign-in or sign-up
 * budget. It reuses sign-in's environment block for the reason sign-up gives:
 * no new variable to forget, and it fails closed in the same breath as sign-in.
 *
 * ## Fail closed
 *
 * No in-memory fallback. If Redis cannot answer, the request is refused and no
 * mail is sent.
 */

import "../server-only";
import { Redis } from "@upstash/redis";
import {
  redisAuthThrottle,
  type AuthThrottle,
  type AuthThrottleBackend,
  type AuthThrottlePolicy,
} from "./auth-throttle";
import {
  readSignInThrottleRuntimeConfig,
  resolveSignInThrottleKeySecret,
  resolveSignInThrottleRestToken,
  type Env,
} from "./sign-in-throttle-runtime-config";
import { SignInThrottleUnavailableError } from "./sign-in-throttle-errors";

/** Reset requests permitted per address per window. */
export const PASSWORD_RESET_ATTEMPT_LIMIT = 5;

/** One hour. Fixed — it does not slide. */
export const PASSWORD_RESET_THROTTLE_WINDOW_SECONDS = 3600;

/** Its own namespace, distinct from sign-in's and sign-up's. */
export const PASSWORD_RESET_THROTTLE_KEY_PREFIX = "monacado:pwreset:credential:";

/** Its own HMAC domain label. Versioned, as sign-up's is. */
export const PASSWORD_RESET_THROTTLE_HMAC_DOMAIN = "monacado.password-reset.v1";

export const PASSWORD_RESET_THROTTLE_POLICY: AuthThrottlePolicy = {
  keyPrefix: PASSWORD_RESET_THROTTLE_KEY_PREFIX,
  hmacDomain: PASSWORD_RESET_THROTTLE_HMAC_DOMAIN,
  limit: PASSWORD_RESET_ATTEMPT_LIMIT,
  windowSeconds: PASSWORD_RESET_THROTTLE_WINDOW_SECONDS,
};

export type PasswordResetThrottle = AuthThrottle;

/** Build the reset throttle over a backend. Exported for tests. */
export function redisPasswordResetThrottle(
  backend: AuthThrottleBackend,
  keySecret: string,
): PasswordResetThrottle {
  return redisAuthThrottle(backend, keySecret, PASSWORD_RESET_THROTTLE_POLICY, (cause) =>
    cause === undefined
      ? new SignInThrottleUnavailableError()
      : new SignInThrottleUnavailableError(cause),
  );
}

let cachedBackend: AuthThrottleBackend | undefined;

/** The production reset throttle, built lazily from the environment. */
export function defaultPasswordResetThrottle(env: Env = process.env): PasswordResetThrottle {
  const config = readSignInThrottleRuntimeConfig(env);
  const keySecret = resolveSignInThrottleKeySecret(config, env);
  if (cachedBackend === undefined) {
    cachedBackend = new Redis({
      url: config.restUrl,
      token: resolveSignInThrottleRestToken(config, env),
    }) as unknown as AuthThrottleBackend;
  }
  return redisPasswordResetThrottle(cachedBackend, keySecret);
}
