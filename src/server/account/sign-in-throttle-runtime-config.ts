/**
 * Sign-in throttle runtime configuration (Phase 1.23) — SERVER ONLY.
 *
 * The environment contract for the one thing Phase 1.23 needs: a shared,
 * ephemeral counter that every server instance can see. Phase 1.23 stopped the
 * first time it was attempted because no such thing existed in this repository —
 * `docs/PRODUCT_PERSISTENCE.md` said "no distributed locks" and meant it — and an
 * architecture ruling has since authorised **Upstash Redis** as Monacado's shared
 * ephemeral coordination layer.
 *
 * ## Redis is not a database here
 *
 * Nothing authoritative lives behind this configuration. MySQL remains the sole
 * source of truth for accounts, participants, storefronts, policies, orders,
 * payments, disputes, refunds, provenance, and every durable audit record. What
 * Redis holds for this phase is one integer per submitted credential identifier,
 * with a fifteen-minute expiry, and losing all of it costs nothing but the
 * in-flight throttle state. It can never corrupt business truth, because no
 * business truth is written to it.
 *
 * ## The token is a variable NAME here, never a value
 *
 * `restTokenEnvVar` and `keySecretEnvVar` hold the *names* of the variables that
 * hold the credentials — the construction `stripe-runtime-config.ts` uses for
 * `apiKeyEnvVar` and `mail-runtime-config.ts` for `serverTokenEnvVar`, for the
 * same reason: this object is constructed, passed around, logged in a debugger,
 * and serialised into an error, and a credential that is never in it cannot leak
 * from it. Each secret is read in exactly one function, at the moment it is
 * needed.
 *
 * The REST **URL** is not a secret and is held directly — it is an endpoint, and
 * the token beside it is what authorises anything. It is still never echoed into
 * a route response; see `sign-in-abuse-protection.ts`, where every backend fault
 * collapses to one bounded code.
 *
 * ## Fail closed
 *
 * There is deliberately **no master switch**. A `MONACADO_REDIS_ENABLED=false`
 * would be a way to turn sign-in abuse protection off in production by forgetting
 * a variable, which is precisely the failure this phase exists to remove. Missing
 * or malformed configuration raises `SignInThrottleConfigurationError`, the route
 * answers a bounded 503, and no credential is verified. A deployment that cannot
 * count attempts does not get to accept passwords.
 *
 * Nothing is read at import time. Configuration is resolved when a request needs
 * it, so importing this module never touches `process.env` and a test can drive
 * every branch by passing an environment in.
 */

import "../server-only";
import { z } from "zod";
import { SignInThrottleConfigurationError } from "./sign-in-throttle-errors";

export type Env = Record<string, string | undefined>;

/** A shell-safe environment variable name. Never the value it names. */
const ENV_VAR_NAME_RE = /^[A-Z][A-Z0-9_]{2,63}$/;

export const DEFAULT_REDIS_REST_TOKEN_ENV = "MONACADO_REDIS_REST_TOKEN";
export const DEFAULT_SIGN_IN_THROTTLE_SECRET_ENV = "MONACADO_SIGN_IN_THROTTLE_SECRET";

/**
 * The validated, **secret-free** configuration of the sign-in throttle backend.
 *
 * There is no field here a credential could occupy.
 */
export const SignInThrottleRuntimeConfig = z.strictObject({
  /**
   * The Upstash REST endpoint. `https:` is required — the token travels as a
   * bearer credential on every request, and plain http would put it on the wire.
   */
  restUrl: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), { message: "must be an https: URL" }),
  /** The NAME of the variable holding the REST token. Never the token. */
  restTokenEnvVar: z.string().regex(ENV_VAR_NAME_RE, "must be an environment variable name"),
  /** The NAME of the variable holding the throttle-key pepper. Never the pepper. */
  keySecretEnvVar: z.string().regex(ENV_VAR_NAME_RE, "must be an environment variable name"),
});
export type SignInThrottleRuntimeConfig = z.infer<typeof SignInThrottleRuntimeConfig>;

/**
 * Read the throttle block, or refuse with every issue at once.
 *
 * Names the **fields** at fault and never their values: a configuration error
 * about a secret is exactly the log line a secret otherwise ends up in.
 */
export function readSignInThrottleRuntimeConfig(env: Env = process.env): SignInThrottleRuntimeConfig {
  const parsed = SignInThrottleRuntimeConfig.safeParse({
    restUrl: (env.MONACADO_REDIS_REST_URL ?? "").trim(),
    restTokenEnvVar: env.MONACADO_REDIS_REST_TOKEN_ENV ?? DEFAULT_REDIS_REST_TOKEN_ENV,
    keySecretEnvVar:
      env.MONACADO_SIGN_IN_THROTTLE_SECRET_ENV ?? DEFAULT_SIGN_IN_THROTTLE_SECRET_ENV,
  });
  if (!parsed.success) {
    throw new SignInThrottleConfigurationError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  return parsed.data;
}

/**
 * Resolve the Upstash REST token.
 *
 * **One of the two places a credential is read.** Handed straight to the client
 * constructor and stored in nothing else that can be reached or serialised.
 */
export function resolveSignInThrottleRestToken(
  config: SignInThrottleRuntimeConfig,
  env: Env = process.env,
): string {
  const token = (env[config.restTokenEnvVar] ?? "").trim();
  if (token === "") {
    throw new SignInThrottleConfigurationError([`${config.restTokenEnvVar} is not set`]);
  }
  return token;
}

/**
 * Resolve the throttle-key pepper.
 *
 * **A dedicated secret, deliberately not borrowed.** The password hash, the
 * session token digest, the Stripe key, and the webhook secrets each answer for
 * something else; a pepper shared with any of them would make a throttle-key
 * collision a question about that other thing. It exists for one reason: without
 * it, `sha256(normalized email)` is offline-enumerable against any address list,
 * so a Redis dump would become a membership test over Monacado's users.
 *
 * A minimum length is enforced because a short pepper is a pepper that can be
 * brute-forced back out of one known key.
 */
export function resolveSignInThrottleKeySecret(
  config: SignInThrottleRuntimeConfig,
  env: Env = process.env,
): string {
  const secret = (env[config.keySecretEnvVar] ?? "").trim();
  if (secret === "") {
    throw new SignInThrottleConfigurationError([`${config.keySecretEnvVar} is not set`]);
  }
  if (secret.length < 32) {
    throw new SignInThrottleConfigurationError([`${config.keySecretEnvVar} is too short`]);
  }
  return secret;
}
