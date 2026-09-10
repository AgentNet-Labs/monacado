/**
 * Sign-in abuse protection (Phase 1.23) — SERVER ONLY.
 *
 * Phase 1.22 shipped the route that turns a password into a session. It closed
 * the enumeration question — one uniform `INVALID_CREDENTIALS`, a timing decoy so
 * an unknown address costs the same as a wrong one — and recorded, in
 * `IDENTITY_SESSION_AND_INTERNAL_ENTITLEMENT_FOUNDATION.md`, exactly what it did
 * not close: "**Rate limiting and lockout** on repeated authentication failures —
 * the timing and message defences here address enumeration, not brute force at
 * volume." This module is that, and only that.
 *
 * ## It is not a rate limiter
 *
 * There is no route key, no policy table, no bucket registry, and no way to apply
 * it to a second endpoint. It counts failed sign-in attempts against one
 * credential identifier and answers one question — is this identifier over
 * budget. A generic limiter is a different phase with a different ruling, and
 * building one here would quietly extend a narrowly-granted Redis authorisation
 * into a platform.
 *
 * ## What is in Redis, and what is not
 *
 * One integer per identifier, under a fifteen-minute expiry. That is the whole
 * data model. Redis is **ephemeral operational state** and is authoritative for
 * nothing: not identity, not account status, not password verification, not
 * session truth, not policy, not commerce, not participant authority. Every one
 * of those stays in MySQL, and `authenticateAccount` is still the only thing that
 * decides whether a credential is good. If Redis were flushed mid-window the
 * worst outcome is that some attackers get a fresh budget — never a corrupted
 * business record, because no business record is written here.
 *
 * ## The key cannot be read backwards
 *
 * The stored key is `monacado:signin:credential:<hmac>`, where the digest is
 * HMAC-SHA256 over the **normalised** address under a dedicated server-held
 * pepper. A plain `sha256(email)` would be worse than useless: addresses are
 * low-entropy and enumerable, so anyone holding a dump and a mailing list could
 * confirm which of those people have Monacado accounts. Under an HMAC they
 * cannot, without the pepper.
 *
 * No raw address, password, session token, account id, participant id, or network
 * address is written to Redis, in a key or in a value. The value is an integer.
 *
 * ## Why the identifier, and not the network
 *
 * Because this repository has no trustworthy network identity to use. Nothing in
 * `src/` or `app/` reads a client address; `x-forwarded-*` appears only in an
 * outbound **denylist**; and `PRE_LIVE_COMMERCE_CONTROLS.md` states the position
 * directly — "never from an IP address — an IP locates a network interface, not a
 * buyer." Throttling on a header any caller can set is not a control, it is a
 * control-shaped object, and adding one would have been the more dangerous
 * choice. Phase 1.23 throttles the submitted identifier and nothing else.
 *
 * ## Counting attempts, not failures
 *
 * The obvious design — verify the password, then increment if it was wrong — has
 * a race: a burst of concurrent attempts all read the same count, all pass the
 * check, and all proceed. So the increment happens **first**, atomically, and a
 * *successful* authentication deletes the key afterwards. A legitimate user
 * therefore never spends budget they can see, an attacker is charged before any
 * expensive Argon2 verification happens, and no read-compare-increment sequence
 * exists to race against. See `admitAttempt`.
 */

import "../server-only";
import { createHmac } from "node:crypto";
import { Redis } from "@upstash/redis";
import { normalizeEmail } from "../../contracts/account/account";
import {
  readSignInThrottleRuntimeConfig,
  resolveSignInThrottleKeySecret,
  resolveSignInThrottleRestToken,
  type Env,
} from "./sign-in-throttle-runtime-config";
import { SignInThrottleUnavailableError } from "./sign-in-throttle-errors";

/**
 * Failed attempts permitted inside one window.
 *
 * Deliberately a constant in source rather than an environment variable. A
 * threshold in an env var is a number that changes with no record of who changed
 * it — the reasoning `.env.example` already gives for keeping the refund retry
 * schedule and the risk thresholds out of the environment.
 */
export const SIGN_IN_ATTEMPT_LIMIT = 8;

/** The fixed window, in seconds. Fifteen minutes, expiring on its own. */
export const SIGN_IN_THROTTLE_WINDOW_SECONDS = 900;

/** Namespaced so a future authorised Redis use cannot collide with this one. */
export const SIGN_IN_THROTTLE_KEY_PREFIX = "monacado:signin:credential:";

/**
 * Increment, set the expiry on first use, and report the count and remaining
 * time — as one atomic server-side operation.
 *
 * `INCR` alone is atomic, but the expiry has to be attached without a second
 * round trip that could be lost between them, and the caller needs the TTL to
 * answer `Retry-After`. One small script is the smallest correct way to get all
 * three; it is a fixed string, not a scripting facility, and nothing else in the
 * repository may use it.
 *
 * The expiry is set only when the counter is created, which is what makes this a
 * **fixed** window: attempts nine through nine hundred do not push the reset
 * further out, so a locked-out identifier always recovers within fifteen minutes
 * of its first failure.
 */
const ADMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return { count, redis.call('TTL', KEYS[1]) }
`;

export interface SignInThrottleDecision {
  /** True when this identifier has spent its budget for the current window. */
  readonly throttled: boolean;
  /**
   * Whole seconds until the window resets, when the backend reported a usable
   * TTL. Absent rather than guessed — a fabricated `Retry-After` is worse than
   * none, because a client will believe it.
   */
  readonly retryAfterSeconds?: number;
}

/**
 * The narrow contract the sign-in route depends on.
 *
 * Two methods, one identifier, no route parameter and no policy argument. A test
 * substitutes a fake implementing exactly this; production gets
 * `redisSignInThrottle`. There is deliberately no in-memory implementation in
 * `src/` for a default to fall back to — see `defaultSignInThrottle`.
 */
export interface SignInThrottle {
  /**
   * Record one attempt against this identifier and report whether it is over
   * budget. Called **before** credential verification.
   *
   * @throws SignInThrottleUnavailableError when the backend cannot answer.
   */
  admitAttempt(submittedEmail: string): Promise<SignInThrottleDecision>;
  /**
   * Release this identifier's budget after a successful authentication.
   *
   * @throws SignInThrottleUnavailableError when the backend cannot answer.
   */
  clear(submittedEmail: string): Promise<void>;
}

/**
 * The Redis key for a submitted address.
 *
 * Normalisation is `normalizeEmail` — the same function `authenticateAccount`
 * uses for its lookup, so `Alice@Example.com ` and `alice@example.com` share one
 * bucket exactly as they share one account row. Deriving it here from the
 * *submitted* value, before any lookup, is what keeps an unknown address and a
 * real one indistinguishable.
 */
export function signInThrottleKey(submittedEmail: string, keySecret: string): string {
  const digest = createHmac("sha256", keySecret).update(normalizeEmail(submittedEmail)).digest("hex");
  return `${SIGN_IN_THROTTLE_KEY_PREFIX}${digest}`;
}

/** The minimal surface of the Upstash client this module uses. */
interface ThrottleBackend {
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * Build the production throttle over a shared Upstash Redis instance.
 *
 * Every backend fault — network, timeout, auth refusal, malformed reply —
 * becomes `SignInThrottleUnavailableError`, whose message names nothing. The
 * provider's own text survives only on the non-enumerable internal cause.
 */
export function redisSignInThrottle(backend: ThrottleBackend, keySecret: string): SignInThrottle {
  return {
    async admitAttempt(submittedEmail: string): Promise<SignInThrottleDecision> {
      const key = signInThrottleKey(submittedEmail, keySecret);
      let raw: unknown;
      try {
        raw = await backend.eval(ADMIT_SCRIPT, [key], [SIGN_IN_THROTTLE_WINDOW_SECONDS]);
      } catch (error) {
        throw new SignInThrottleUnavailableError(error);
      }

      /* A reply that is not [count, ttl] means the backend is not behaving as
         this module requires, which is an outage rather than a permission. */
      if (!Array.isArray(raw) || raw.length < 2) {
        throw new SignInThrottleUnavailableError();
      }
      const count = Number(raw[0]);
      const ttl = Number(raw[1]);
      if (!Number.isFinite(count)) throw new SignInThrottleUnavailableError();

      if (count <= SIGN_IN_ATTEMPT_LIMIT) return { throttled: false };
      return Number.isFinite(ttl) && ttl > 0
        ? { throttled: true, retryAfterSeconds: Math.ceil(ttl) }
        : { throttled: true };
    },

    async clear(submittedEmail: string): Promise<void> {
      try {
        await backend.del(signInThrottleKey(submittedEmail, keySecret));
      } catch (error) {
        throw new SignInThrottleUnavailableError(error);
      }
    },
  };
}

let cachedBackend: ThrottleBackend | undefined;

/**
 * The production throttle, built lazily from the environment.
 *
 * **There is no in-memory fallback, and that is the point.** A limiter that
 * degrades to a process-local `Map` when Redis is missing is not a limiter on a
 * platform with more than one instance — it is a counter each attacker gets a
 * fresh copy of. Missing or invalid configuration throws
 * `SignInThrottleConfigurationError` and the route answers a bounded 503, so a
 * deployment that cannot count attempts declines to check passwords instead of
 * silently checking them unprotected.
 *
 * The client is memoised per process the way `getPrisma` is, so importing this
 * module opens no connection and a build or typecheck never reads the
 * environment.
 */
export function defaultSignInThrottle(env: Env = process.env): SignInThrottle {
  const config = readSignInThrottleRuntimeConfig(env);
  const keySecret = resolveSignInThrottleKeySecret(config, env);
  if (cachedBackend === undefined) {
    cachedBackend = new Redis({
      url: config.restUrl,
      token: resolveSignInThrottleRestToken(config, env),
    }) as unknown as ThrottleBackend;
  }
  return redisSignInThrottle(cachedBackend, keySecret);
}

/** Drop the memoised client (tests and scripts; never part of a request). */
export function resetSignInThrottleBackend(): void {
  cachedBackend = undefined;
}
