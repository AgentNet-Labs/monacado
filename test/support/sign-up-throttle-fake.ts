/**
 * A test double for Phase 1.27 sign-up abuse protection.
 *
 * **TEST ONLY, and deliberately process-local.** The same arrangement
 * `sign-in-throttle-fake.ts` makes, for the same reason: a test drives the budget
 * without a Redis endpoint and without a developer holding an Upstash credential.
 * Nothing in `src/` imports it and nothing can fall back to it — the production
 * default is `defaultSignUpThrottle`, which builds a Redis client or throws.
 *
 * It keys through the **real** `authThrottleKey` under the real sign-up policy,
 * so a change that leaked a raw address into a key, or that collided sign-up's
 * key space with sign-in's, would still fail here.
 */

import {
  SIGN_UP_ATTEMPT_LIMIT,
  SIGN_UP_THROTTLE_POLICY,
  SIGN_UP_THROTTLE_WINDOW_SECONDS,
  type SignUpThrottle,
  type SignUpThrottleDecision,
} from "../../src/server/account/sign-up-abuse-protection";
import { authThrottleKey } from "../../src/server/account/auth-throttle";
import { SignInThrottleUnavailableError } from "../../src/server/account/sign-in-throttle-errors";

/** A pepper for tests only. Never a real secret, and never read from anywhere. */
export const TEST_SIGN_UP_SECRET = "test-only-sign-up-throttle-pepper-0123456789";

export interface FakeSignUpThrottle extends SignUpThrottle {
  advanceSeconds(seconds: number): void;
  breakBackend(): void;
  countFor(submittedEmail: string): number;
  /** The production key, so a test can compare namespaces across limiters. */
  keyFor(submittedEmail: string): string;
}

interface Bucket {
  count: number;
  expiresAtSecond: number;
}

export function createFakeSignUpThrottle(): FakeSignUpThrottle {
  const buckets = new Map<string, Bucket>();
  let clockSecond = 0;
  let broken = false;

  const keyFor = (email: string): string =>
    authThrottleKey(SIGN_UP_THROTTLE_POLICY, email, TEST_SIGN_UP_SECRET);

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
    async admitAttempt(submittedEmail: string): Promise<SignUpThrottleDecision> {
      if (broken) throw new SignInThrottleUnavailableError();
      const key = keyFor(submittedEmail);
      const existing = live(key);
      const bucket: Bucket = existing ?? {
        count: 0,
        expiresAtSecond: clockSecond + SIGN_UP_THROTTLE_WINDOW_SECONDS,
      };
      bucket.count += 1;
      buckets.set(key, bucket);

      if (bucket.count <= SIGN_UP_ATTEMPT_LIMIT) return { throttled: false };
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

    keyFor,
  };
}
