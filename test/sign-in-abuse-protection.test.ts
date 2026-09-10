/**
 * Phase 1.23 — the production throttle's own contract. No database, no network.
 *
 * The route-level cases in `auth-sign-in-abuse-protection.integration.test.ts`
 * drive an injected fake, which means the code that actually talks to Redis —
 * the key derivation, the script's reply, and the decision it maps to — would
 * otherwise ship unexercised. This is the one case that covers it.
 *
 * The Upstash client is NOT under test; the vendor owns its transport. What is
 * under test is Monacado's side of the seam: that the key is opaque, that the
 * threshold is applied to the count the script returns, that `Retry-After` comes
 * from a real TTL, and that any backend fault becomes the one bounded error the
 * route turns into a 503.
 */

import { describe, expect, it } from "vitest";
import {
  SIGN_IN_ATTEMPT_LIMIT,
  SIGN_IN_THROTTLE_KEY_PREFIX,
  redisSignInThrottle,
  signInThrottleKey,
} from "../src/server/account/sign-in-abuse-protection";
import { SignInThrottleUnavailableError } from "../src/server/account/sign-in-throttle-errors";

const SECRET = "unit-test-pepper-not-a-real-secret-0123456789";
const EMAIL = "Caller@Example.COM";

/** Records what the throttle asked Redis to do, and answers with a fixed reply. */
function stubBackend(reply: unknown | (() => never)) {
  const evalKeys: string[] = [];
  const deleted: string[] = [];
  return {
    evalKeys,
    deleted,
    backend: {
      async eval(_script: string, keys: string[]): Promise<unknown> {
        evalKeys.push(keys[0]!);
        if (typeof reply === "function") (reply as () => never)();
        return reply;
      },
      async del(key: string): Promise<unknown> {
        deleted.push(key);
        if (typeof reply === "function") (reply as () => never)();
        return 1;
      },
    },
  };
}

describe("1.23 — redis-backed sign-in throttle", () => {
  it("keys opaquely, applies the threshold, and turns any fault into one bounded error", async () => {
    /* The key is an HMAC under a dedicated pepper. Neither the submitted address
       nor its normalised form appears anywhere in it — a Redis dump is not a
       list of who has a Monacado account. */
    const key = signInThrottleKey(EMAIL, SECRET);
    expect(key.startsWith(SIGN_IN_THROTTLE_KEY_PREFIX)).toBe(true);
    expect(key).not.toContain("Caller");
    expect(key).not.toContain("caller");
    expect(key.toLowerCase()).not.toContain("example.com");
    expect(key).toMatch(new RegExp(`^${SIGN_IN_THROTTLE_KEY_PREFIX}[0-9a-f]{64}$`));
    /* Normalised exactly as `authenticateAccount` normalises its lookup, so one
       account cannot be given several budgets by varying case or padding. */
    expect(signInThrottleKey("  caller@example.com ", SECRET)).toBe(key);
    /* And the pepper is load-bearing: a different one yields a different key. */
    expect(signInThrottleKey(EMAIL, `${SECRET}x`)).not.toBe(key);

    /* The last attempt inside the budget is admitted. */
    const atLimit = stubBackend([SIGN_IN_ATTEMPT_LIMIT, 900]);
    expect(
      await redisSignInThrottle(atLimit.backend, SECRET).admitAttempt(EMAIL),
    ).toEqual({ throttled: false });
    expect(atLimit.evalKeys).toEqual([key]);

    /* One past it is refused, and `Retry-After` is the TTL the script reported —
       not a constant, and not the window length. */
    const over = stubBackend([SIGN_IN_ATTEMPT_LIMIT + 1, 42]);
    expect(await redisSignInThrottle(over.backend, SECRET).admitAttempt(EMAIL)).toEqual({
      throttled: true,
      retryAfterSeconds: 42,
    });

    /* A key with no expiry (`TTL` = -1) is still a refusal, but claims no
       retry time rather than inventing one a client would act on. */
    const noTtl = stubBackend([SIGN_IN_ATTEMPT_LIMIT + 1, -1]);
    expect(await redisSignInThrottle(noTtl.backend, SECRET).admitAttempt(EMAIL)).toEqual({
      throttled: true,
    });

    /* Success releases the same key it charged. */
    const cleared = stubBackend([1, 900]);
    await redisSignInThrottle(cleared.backend, SECRET).clear(EMAIL);
    expect(cleared.deleted).toEqual([key]);

    /* Every fault collapses to one error carrying nothing: a thrown transport
       error, and a reply that is not the [count, ttl] this module requires. The
       route maps this to 503 and never says why. */
    const thrown = stubBackend((): never => {
      throw new Error("ECONNREFUSED 10.0.0.1:6379 token=sk_live_leak");
    });
    await expect(
      redisSignInThrottle(thrown.backend, SECRET).admitAttempt(EMAIL),
    ).rejects.toBeInstanceOf(SignInThrottleUnavailableError);
    await expect(
      redisSignInThrottle(thrown.backend, SECRET).clear(EMAIL),
    ).rejects.toBeInstanceOf(SignInThrottleUnavailableError);

    const garbage = stubBackend("OK");
    await expect(
      redisSignInThrottle(garbage.backend, SECRET).admitAttempt(EMAIL),
    ).rejects.toBeInstanceOf(SignInThrottleUnavailableError);

    /* The provider's message — which carried a host and a credential-shaped
       string above — is retained only non-enumerably, so serialising the error
       cannot leak it. */
    const captured = await redisSignInThrottle(thrown.backend, SECRET)
      .admitAttempt(EMAIL)
      .catch((e: unknown) => e as SignInThrottleUnavailableError);
    expect(JSON.stringify(captured)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(captured)).not.toContain("sk_live_leak");
    expect(Object.keys(captured)).not.toContain("internalCause");
  });
});
