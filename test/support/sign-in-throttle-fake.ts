/**
 * A test double for Phase 1.23 sign-in abuse protection.
 *
 * **TEST ONLY, and deliberately process-local.** It implements the same narrow
 * `SignInThrottle` contract the route depends on, so a test can drive the budget
 * without a Redis endpoint and without a developer holding an Upstash
 * credential. Nothing in `src/` imports it and nothing can fall back to it: the
 * production default is `defaultSignInThrottle`, which builds a Redis client or
 * throws, and has no in-memory branch at all.
 *
 * The window is driven by an injected clock rather than a real timer, so the
 * fifteen-minute reset is exercised in a test that runs in milliseconds — the
 * same seam `now` already provides on the route.
 */

import {
  SIGN_IN_ATTEMPT_LIMIT,
  SIGN_IN_THROTTLE_WINDOW_SECONDS,
  signInThrottleKey,
  type SignInThrottle,
  type SignInThrottleDecision,
} from "../../src/server/account/sign-in-abuse-protection";
import { SignInThrottleUnavailableError } from "../../src/server/account/sign-in-throttle-errors";

/** A pepper for tests only. Never a real secret, and never read from anywhere. */
export const TEST_THROTTLE_SECRET = "test-only-sign-in-throttle-pepper-0123456789";

export interface FakeSignInThrottle extends SignInThrottle {
  /** Advance the fake clock, expiring windows that have run out. */
  advanceSeconds(seconds: number): void;
  /** Make every subsequent call fail as an unavailable backend. */
  breakBackend(): void;
  /** Attempts currently charged against a submitted address. */
  countFor(submittedEmail: string): number;
}

interface Bucket {
  count: number;
  expiresAtSecond: number;
}

export function createFakeSignInThrottle(): FakeSignInThrottle {
  const buckets = new Map<string, Bucket>();
  let clockSecond = 0;
  let broken = false;

  /* Keyed exactly as production keys it — through the real HMAC derivation — so
     a test that accidentally leaked a raw address into a key would still fail. */
  const keyFor = (email: string): string => signInThrottleKey(email, TEST_THROTTLE_SECRET);

  const live = (key: string): Bucket | undefined => {
    const bucket = buckets.get(key);
    if (bucket === undefined) return undefined;
    if (bucket.expiresAtSecond <= clockSecond) {
      buckets.delete(key);
      return undefined;
    }
    return bucket;
  };

  return {
    async admitAttempt(submittedEmail: string): Promise<SignInThrottleDecision> {
      if (broken) throw new SignInThrottleUnavailableError();
      const key = keyFor(submittedEmail);
      const existing = live(key);
      const bucket: Bucket = existing ?? {
        count: 0,
        expiresAtSecond: clockSecond + SIGN_IN_THROTTLE_WINDOW_SECONDS,
      };
      bucket.count += 1;
      buckets.set(key, bucket);

      if (bucket.count <= SIGN_IN_ATTEMPT_LIMIT) return { throttled: false };
      return { throttled: true, retryAfterSeconds: bucket.expiresAtSecond - clockSecond };
    },

    async clear(submittedEmail: string): Promise<void> {
      if (broken) throw new SignInThrottleUnavailableError();
      buckets.delete(keyFor(submittedEmail));
    },

    advanceSeconds(seconds: number): void {
      clockSecond += seconds;
    },

    breakBackend(): void {
      broken = true;
    },

    countFor(submittedEmail: string): number {
      return live(keyFor(submittedEmail))?.count ?? 0;
    },
  };
}
