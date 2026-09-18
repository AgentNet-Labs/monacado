/**
 * Phase 1.27 — the shared throttle primitive, and the two policies over it.
 *
 * Pure. NO DATABASE, NO NETWORK, NO REDIS. The counter is driven through a fake
 * backend built in the test.
 *
 * ## What this suite exists to protect
 *
 * Phase 1.27 needed a counter for public sign-up and was forbidden from reusing
 * sign-in's, so the mechanism underneath was extracted. Extraction is exactly the
 * kind of change that silently alters something nobody was watching, and two
 * things here would be catastrophic to alter:
 *
 *   1. **Sign-in's key bytes.** Counters are live in staging Redis right now. A
 *      changed derivation resets every in-flight budget on deploy and hands a
 *      mid-attack attacker a fresh eight attempts.
 *   2. **The separation between the two key spaces.** Both policies are peppered
 *      with the same secret, so if the HMAC input were also the same, one
 *      person's sign-in and sign-up budgets would collide into a single counter
 *      and each endpoint would silently eat the other's allowance.
 *
 * Not re-proved here: that the route answers 429, or that a real Upstash `EVAL`
 * works — Phase 1.23's suite and the Phase 1.26 staging proof cover those.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authThrottleKey,
  redisAuthThrottle,
  type AuthThrottleBackend,
} from "../src/server/account/auth-throttle";
import {
  SIGN_IN_ATTEMPT_LIMIT,
  SIGN_IN_THROTTLE_KEY_PREFIX,
  SIGN_IN_THROTTLE_POLICY,
  SIGN_IN_THROTTLE_WINDOW_SECONDS,
  signInThrottleKey,
} from "../src/server/account/sign-in-abuse-protection";
import {
  SIGN_UP_ATTEMPT_LIMIT,
  SIGN_UP_THROTTLE_KEY_PREFIX,
  SIGN_UP_THROTTLE_POLICY,
  SIGN_UP_THROTTLE_WINDOW_SECONDS,
} from "../src/server/account/sign-up-abuse-protection";
import {
  PASSWORD_RESET_ATTEMPT_LIMIT,
  PASSWORD_RESET_THROTTLE_KEY_PREFIX,
  PASSWORD_RESET_THROTTLE_POLICY,
  PASSWORD_RESET_THROTTLE_WINDOW_SECONDS,
  redisPasswordResetThrottle,
} from "../src/server/account/password-reset-abuse-protection";

const SECRET = "a-test-pepper-long-enough-to-be-plausible-0123456789";
const EMAIL = "Person@Example.com";

/** A backend that counts in a Map, so the script's contract is exercised. */
function fakeBackend(): AuthThrottleBackend & { keys: string[]; windows: number[] } {
  const counts = new Map<string, number>();
  const keys: string[] = [];
  const windows: number[] = [];
  return {
    keys,
    windows,
    async eval(_script: string, k: string[], args: (string | number)[]) {
      const key = k[0]!;
      keys.push(key);
      windows.push(Number(args[0]));
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return [next, 900];
    },
    async del(key: string) {
      counts.delete(key);
      return 1;
    },
  };
}

describe("1.27 — auth throttle primitive", () => {
  it("reproduces Phase 1.23's sign-in key byte for byte", () => {
    /* The literal construction Phase 1.23 shipped: HMAC-SHA256 over the
       NORMALISED address, with no domain label, under the throttle pepper —
       prefixed by the sign-in namespace. Recomputed here from first principles
       rather than by calling the code under test, so this fails if the
       derivation moves rather than agreeing with itself. */
    const expected =
      SIGN_IN_THROTTLE_KEY_PREFIX +
      createHmac("sha256", SECRET).update("person@example.com").digest("hex");

    expect(signInThrottleKey(EMAIL, SECRET)).toBe(expected);
    expect(authThrottleKey(SIGN_IN_THROTTLE_POLICY, EMAIL, SECRET)).toBe(expected);

    /* And the policy itself is unchanged: same limit, same window, same prefix,
       and NO domain label — the absence is the compatibility. */
    expect(SIGN_IN_THROTTLE_POLICY.hmacDomain).toBeUndefined();
    expect(SIGN_IN_ATTEMPT_LIMIT).toBe(8);
    expect(SIGN_IN_THROTTLE_WINDOW_SECONDS).toBe(900);
    expect(SIGN_IN_THROTTLE_KEY_PREFIX).toBe("monacado:signin:credential:");
  });

  it("keeps sign-up in a separate key space under the same secret", () => {
    const signIn = authThrottleKey(SIGN_IN_THROTTLE_POLICY, EMAIL, SECRET);
    const signUp = authThrottleKey(SIGN_UP_THROTTLE_POLICY, EMAIL, SECRET);

    /* Same address, same pepper, different counter. Without the domain label
       these would be the same string and the two endpoints would share a budget. */
    expect(signUp).not.toBe(signIn);
    expect(signUp.startsWith(SIGN_UP_THROTTLE_KEY_PREFIX)).toBe(true);
    expect(SIGN_UP_THROTTLE_KEY_PREFIX).not.toBe(SIGN_IN_THROTTLE_KEY_PREFIX);

    /* The separation is cryptographic, not merely a prefix. Strip both prefixes
       and the digests still differ — so a prefix typo could not collapse them. */
    expect(signUp.slice(SIGN_UP_THROTTLE_KEY_PREFIX.length)).not.toBe(
      signIn.slice(SIGN_IN_THROTTLE_KEY_PREFIX.length),
    );
    expect(SIGN_UP_THROTTLE_POLICY.hmacDomain).toBe("monacado.signup.v1");

    /* No raw address survives into either key, under any casing. */
    for (const key of [signIn, signUp]) {
      expect(key).not.toContain("Person");
      expect(key).not.toContain("person");
      expect(key).not.toContain("example.com");
    }

    /* Normalisation still applies, so casing and surrounding space share a
       bucket exactly as they share an account row. */
    expect(authThrottleKey(SIGN_UP_THROTTLE_POLICY, "  PERSON@EXAMPLE.COM ", SECRET)).toBe(
      signUp,
    );
  });

  it("throttles each policy on its own limit and window", async () => {
    const backend = fakeBackend();
    const wrap = (cause: unknown) => new Error(String(cause));
    const signUp = redisAuthThrottle(backend, SECRET, SIGN_UP_THROTTLE_POLICY, wrap);

    /* Sign-up's threshold is deliberately tighter than sign-in's, because a
       sign-up attempt can put mail in a third party's inbox and a failed sign-in
       cannot. Five per hour against eight per fifteen minutes. */
    expect(SIGN_UP_ATTEMPT_LIMIT).toBe(5);
    expect(SIGN_UP_THROTTLE_WINDOW_SECONDS).toBe(3600);
    expect(SIGN_UP_ATTEMPT_LIMIT).toBeLessThan(SIGN_IN_ATTEMPT_LIMIT);
    expect(SIGN_UP_THROTTLE_WINDOW_SECONDS).toBeGreaterThan(SIGN_IN_THROTTLE_WINDOW_SECONDS);

    for (let i = 1; i <= SIGN_UP_ATTEMPT_LIMIT; i += 1) {
      expect(await signUp.admitAttempt(EMAIL)).toEqual({ throttled: false });
    }
    /* The sixth is refused, and carries the real TTL the backend reported. */
    expect(await signUp.admitAttempt(EMAIL)).toEqual({
      throttled: true,
      retryAfterSeconds: 900,
    });

    /* The window the script was handed is the policy's, not sign-in's. */
    expect(new Set(backend.windows)).toEqual(new Set([SIGN_UP_THROTTLE_WINDOW_SECONDS]));
    /* Every call went to the sign-up namespace. */
    expect(backend.keys.every((k) => k.startsWith(SIGN_UP_THROTTLE_KEY_PREFIX))).toBe(true);
  });

  it("fails closed when the backend cannot answer", async () => {
    /* No in-memory fallback exists anywhere in `src/`, so an outage must surface
       as a thrown error the route turns into a bounded refusal — never as a
       quietly-permitted attempt. Both a rejected call and a malformed reply
       count as an outage. */
    const boom = new Error("redis is gone");
    const wrap = (cause: unknown) => new Error(`wrapped:${String(cause)}`);

    const rejecting: AuthThrottleBackend = {
      async eval() {
        throw boom;
      },
      async del() {
        throw boom;
      },
    };
    const a = redisAuthThrottle(rejecting, SECRET, SIGN_UP_THROTTLE_POLICY, wrap);
    await expect(a.admitAttempt(EMAIL)).rejects.toThrow("wrapped:");
    await expect(a.clear(EMAIL)).rejects.toThrow("wrapped:");

    /* A reply that is not [count, ttl] is a backend not behaving as the module
       requires — an outage, not a permission. */
    for (const reply of [null, "OK", [], [1]]) {
      const odd: AuthThrottleBackend = {
        async eval() {
          return reply;
        },
        async del() {
          return 1;
        },
      };
      const b = redisAuthThrottle(odd, SECRET, SIGN_UP_THROTTLE_POLICY, wrap);
      await expect(b.admitAttempt(EMAIL)).rejects.toThrow();
    }
  });

  it("keeps password reset (Phase 1.28) in a third key space with its own budget", async () => {
    const signIn = authThrottleKey(SIGN_IN_THROTTLE_POLICY, EMAIL, SECRET);
    const signUp = authThrottleKey(SIGN_UP_THROTTLE_POLICY, EMAIL, SECRET);
    const reset = authThrottleKey(PASSWORD_RESET_THROTTLE_POLICY, EMAIL, SECRET);

    /* Distinct as whole keys and as bare digests, so neither a shared prefix nor
       a shared HMAC input could merge reset's budget into another endpoint's. */
    const digest = (key: string) => key.slice(key.lastIndexOf(":") + 1);
    expect(new Set([signIn, signUp, reset]).size).toBe(3);
    expect(new Set([digest(signIn), digest(signUp), digest(reset)]).size).toBe(3);
    expect(reset.startsWith(PASSWORD_RESET_THROTTLE_KEY_PREFIX)).toBe(true);
    expect(PASSWORD_RESET_THROTTLE_POLICY.hmacDomain).toBe("monacado.password-reset.v1");
    expect(reset).not.toContain("example.com");
    expect(authThrottleKey(PASSWORD_RESET_THROTTLE_POLICY, " PERSON@example.COM", SECRET)).toBe(
      reset,
    );

    expect(PASSWORD_RESET_ATTEMPT_LIMIT).toBe(5);
    expect(PASSWORD_RESET_THROTTLE_WINDOW_SECONDS).toBe(3600);

    const backend = fakeBackend();
    const throttle = redisPasswordResetThrottle(backend, SECRET);
    for (let i = 1; i <= PASSWORD_RESET_ATTEMPT_LIMIT; i += 1) {
      expect(await throttle.admitAttempt(EMAIL)).toEqual({ throttled: false });
    }
    expect((await throttle.admitAttempt(EMAIL)).throttled).toBe(true);
    expect(backend.keys.every((k) => k === reset)).toBe(true);
    expect(new Set(backend.windows)).toEqual(new Set([PASSWORD_RESET_THROTTLE_WINDOW_SECONDS]));
  });
});
