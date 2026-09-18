/**
 * The shared authentication-abuse counter (Phase 1.27) — SERVER ONLY.
 *
 * **This is a primitive, not a platform.** Phase 1.23 built an attempt counter
 * for sign-in and said, in as many words, that it was not a rate limiter: "no
 * route key, no policy table, no bucket registry, and no way to apply it to a
 * second endpoint ... a generic limiter is a different phase with a different
 * ruling, and building one here would quietly extend a narrowly-granted Redis
 * authorisation into a platform." Phase 1.27 needed a second counter, for public
 * sign-up, and that sentence forbade reusing the first one.
 *
 * So the mechanism underneath was extracted and the policies stayed separate.
 * What lives here is the atomic fixed-window counter and nothing else. There is
 * still no registry, no route key, no configuration table, and no way to attach
 * this to an arbitrary endpoint: a caller must construct an explicit
 * `AuthThrottlePolicy` in source, and exactly three exist — `sign-in-abuse-protection.ts`,
 * `sign-up-abuse-protection.ts`, and (Phase 1.28) `password-reset-abuse-protection.ts`.
 * Each was a code change somebody reviewed, which is the property Phase 1.23 was
 * protecting.
 *
 * ## Redis remains ephemeral coordination, and authoritative for nothing
 *
 * One integer per identifier per policy, under an expiry. MySQL remains the sole
 * source of truth for accounts, verification state, and every durable record. If
 * Redis were flushed the worst outcome is that some attackers get a fresh budget
 * — never a corrupted business fact, because no business fact is written here.
 *
 * ## Domain separation is mandatory, not incidental
 *
 * Two policies peppered with the same secret must not be able to produce the same
 * digest for the same address, or a person's sign-in budget and their sign-up
 * budget would collide into one counter and each endpoint would silently consume
 * the other's allowance. `hmacDomain` is mixed into the HMAC *message* so the two
 * key spaces are cryptographically independent.
 *
 * `hmacDomain: undefined` reproduces Phase 1.23's original construction — a bare
 * `HMAC(secret, normalizedEmail)` — byte for byte. That is a compatibility
 * requirement, not an oversight: sign-in's live counters exist in staging Redis
 * right now, and changing its key derivation would silently reset every
 * in-flight budget and hand a mid-attack attacker a fresh eight attempts. A test
 * pins it.
 */

import "../server-only";
import { createHmac } from "node:crypto";
import { normalizeEmail } from "../../contracts/account/account";

/**
 * One counter's complete policy. Constructed in source by the module that owns
 * it; never assembled from configuration, a request, or a lookup.
 */
export interface AuthThrottlePolicy {
  /** Redis key namespace. Must differ per policy, and is asserted to. */
  readonly keyPrefix: string;
  /**
   * HMAC domain label mixed into the digest input. `undefined` means the legacy
   * bare-identifier construction, which only sign-in may use.
   */
  readonly hmacDomain: string | undefined;
  /** Failed attempts permitted inside one window. */
  readonly limit: number;
  /** Window length in seconds. Fixed — it does not slide. */
  readonly windowSeconds: number;
}

/**
 * Increment, set the expiry on first use, and report the count and remaining
 * time — as one atomic server-side operation.
 *
 * Unchanged from Phase 1.23, and deliberately still a fixed string rather than a
 * scripting facility. `INCR` alone is atomic, but the expiry has to be attached
 * without a second round trip that could be lost between them, and the caller
 * needs the TTL to answer `Retry-After`.
 *
 * The expiry is set only when the counter is created, which is what makes the
 * window **fixed**: attempts past the limit do not push the reset further out, so
 * a throttled identifier always recovers within one window of its first failure.
 */
const ADMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[1])
end
return { count, redis.call('TTL', KEYS[1]) }
`;

export interface AuthThrottleDecision {
  /** True when this identifier has spent its budget for the current window. */
  readonly throttled: boolean;
  /**
   * Whole seconds until the window resets, when the backend reported a usable
   * TTL. Absent rather than guessed — a fabricated `Retry-After` is worse than
   * none, because a client will believe it.
   */
  readonly retryAfterSeconds?: number;
}

/** The narrow contract both limiters expose to their route. */
export interface AuthThrottle {
  admitAttempt(identifier: string): Promise<AuthThrottleDecision>;
  clear(identifier: string): Promise<void>;
}

/** The minimal surface of the Upstash client this module uses. */
export interface AuthThrottleBackend {
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
  del(key: string): Promise<unknown>;
}

/**
 * The Redis key for one identifier under one policy.
 *
 * Normalisation is `normalizeEmail`, the same function `authenticateAccount`
 * uses for its lookup, so `Alice@Example.com ` and `alice@example.com` share one
 * bucket exactly as they share one account row. Deriving it from the *submitted*
 * value, before any lookup, is what keeps an unknown address and a real one
 * indistinguishable.
 *
 * The digest is an HMAC rather than a plain hash because addresses are
 * low-entropy and enumerable: under `sha256(email)` anyone holding a Redis dump
 * and a mailing list could confirm which of those people have Monacado accounts.
 * Under an HMAC they cannot, without the secret.
 */
export function authThrottleKey(
  policy: AuthThrottlePolicy,
  identifier: string,
  keySecret: string,
): string {
  const normalized = normalizeEmail(identifier);
  const message =
    policy.hmacDomain === undefined ? normalized : `${policy.hmacDomain}:${normalized}`;
  const digest = createHmac("sha256", keySecret).update(message).digest("hex");
  return `${policy.keyPrefix}${digest}`;
}

/**
 * Build a throttle over a backend and a policy.
 *
 * Errors are deliberately NOT caught here. Each caller wraps this in its own
 * error type — `SignInThrottleUnavailableError` for one, the same for the other —
 * so that the bounded code a route answers with stays the route's decision.
 */
export function redisAuthThrottle(
  backend: AuthThrottleBackend,
  keySecret: string,
  policy: AuthThrottlePolicy,
  wrapError: (cause: unknown) => Error,
): AuthThrottle {
  return {
    async admitAttempt(identifier: string): Promise<AuthThrottleDecision> {
      const key = authThrottleKey(policy, identifier, keySecret);
      let raw: unknown;
      try {
        raw = await backend.eval(ADMIT_SCRIPT, [key], [policy.windowSeconds]);
      } catch (error) {
        throw wrapError(error);
      }

      /* A reply that is not [count, ttl] means the backend is not behaving as
         this module requires, which is an outage rather than a permission. */
      if (!Array.isArray(raw) || raw.length < 2) throw wrapError(undefined);
      const count = Number(raw[0]);
      const ttl = Number(raw[1]);
      if (!Number.isFinite(count)) throw wrapError(undefined);

      if (count <= policy.limit) return { throttled: false };
      return Number.isFinite(ttl) && ttl > 0
        ? { throttled: true, retryAfterSeconds: Math.ceil(ttl) }
        : { throttled: true };
    },

    async clear(identifier: string): Promise<void> {
      try {
        await backend.del(authThrottleKey(policy, identifier, keySecret));
      } catch (error) {
        throw wrapError(error);
      }
    },
  };
}
