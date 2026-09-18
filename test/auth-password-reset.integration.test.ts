/**
 * Phase 1.28 — self-service password reset, end to end.
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 *
 * Proves, through the real route handlers, outbox, dispatcher, and resolver:
 *
 *   1. the request endpoint answers identically for known, unknown, and disabled
 *      addresses, and only a known active account gets a challenge and a mail;
 *   2. only a token digest is persisted — nowhere is the plaintext token stored;
 *   3. a link is single-use, expires, and is superseded by a newer one;
 *   4. the registration password rule applies, without spending the link;
 *   5. completion replaces the password, revokes every session, and leaves email
 *      verification exactly as it was;
 *   6. unknown addresses spend the same throttle budget as known ones.
 *
 * Throttle key-space separation is proved without a database in
 * `auth-throttle-domain-separation.test.ts`.
 *
 * NO NETWORK. Mail is captured through `createCapturingMailAdapter`.
 */

import "dotenv/config";
import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import {
  createAccountSession,
  resolveAccountSession,
} from "../src/server/account/account-session-service";
import { handleSignInRequest } from "../src/server/account/sign-in-route-handler";
import {
  handlePasswordResetComplete,
  handlePasswordResetRequest,
  PASSWORD_RESET_ERROR_CODES,
} from "../src/server/account/password-reset-route-handlers";
import { redisPasswordResetThrottle } from "../src/server/account/password-reset-abuse-protection";
import { RESET_PASSWORD_PATH } from "../src/server/account/account-password-reset-notice";
import { ACCOUNT_PASSWORD_RESET_TOKEN_TTL_SECONDS } from "../src/contracts/account/account";
import type { AuthThrottleBackend } from "../src/server/account/auth-throttle";
import { createCapturingMailAdapter } from "../src/server/notifications/mail-port";
import { createFakeSignInThrottle } from "./support/sign-in-throttle-fake";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-11-01T09:00:00.000Z";
const ORIGIN = "https://monacado.test";
const EMAIL_PREFIX = "p128reset";
const OLD_PASSWORD = "the-original-password-1";
const NEW_PASSWORD = "a-brand-new-password-2";
const THROTTLE_SECRET = "test-only-password-reset-pepper-0123456789";

let seq = 0;

/** A Map-backed backend that honours the admit script's [count, ttl] contract. */
function mapBackend(): AuthThrottleBackend {
  const counts = new Map<string, number>();
  return {
    async eval(_script, keys) {
      const next = (counts.get(keys[0]!) ?? 0) + 1;
      counts.set(keys[0]!, next);
      return [next, 3600];
    },
    async del(key) {
      counts.delete(key);
      return 1;
    },
  };
}

let throttle = redisPasswordResetThrottle(mapBackend(), THROTTLE_SECRET);

async function cleanup(): Promise<void> {
  const accounts = await db.account.findMany({
    where: { email: { startsWith: EMAIL_PREFIX } },
    select: { id: true },
  });
  const ids = accounts.map((a) => a.id);
  if (ids.length === 0) return;
  await db.accountPasswordResetChallenge.deleteMany({ where: { accountId: { in: ids } } });
  await db.accountEmailVerificationChallenge.deleteMany({ where: { accountId: { in: ids } } });
  await db.outboundEmailDelivery.deleteMany({ where: { subjectRef: { in: ids } } });
  await db.accountSession.deleteMany({ where: { accountId: { in: ids } } });
  await db.account.deleteMany({ where: { id: { in: ids } } });
}

const nextEmail = () => `${EMAIL_PREFIX}${(seq += 1)}@example.com`;

async function seedAccount(
  opts: { status?: "ACTIVE" | "DISABLED"; verified?: boolean } = {},
) {
  const email = nextEmail();
  const account = await createAccount(
    {
      name: "Reset Person",
      email,
      password: OLD_PASSWORD,
      createdAt: NOW,
      ...(opts.status !== undefined ? { status: opts.status } : {}),
      emailVerification: opts.verified === true ? "ADMINISTRATIVE" : "UNVERIFIED",
    },
    { db },
  );
  return { email, accountId: account.accountId };
}

async function requestReset(
  email: string,
  port = createCapturingMailAdapter(),
  now = NOW,
  defer?: (task: () => Promise<void>) => void,
) {
  const result = await handlePasswordResetRequest(
    {
      contentType: "application/json",
      originHeader: ORIGIN,
      rawBody: JSON.stringify({ email }),
    },
    {
      db,
      appOrigin: ORIGIN,
      now: () => now,
      throttle,
      mailPort: port,
      resetOrigin: ORIGIN,
      ...(defer !== undefined ? { defer } : {}),
    },
  );
  return { result, port };
}

const complete = (token: string, password = NEW_PASSWORD, now = NOW) =>
  handlePasswordResetComplete(
    {
      contentType: "application/json",
      originHeader: ORIGIN,
      rawBody: JSON.stringify({ token, password }),
    },
    { db, appOrigin: ORIGIN, now: () => now },
  );

const signIn = (email: string, password: string) =>
  handleSignInRequest(
    { contentType: "application/json", originHeader: ORIGIN, rawBody: JSON.stringify({ email, password }) },
    { db, appOrigin: ORIGIN, now: () => NOW, throttle: createFakeSignInThrottle() },
  );

/** Pull the token out of the one reset link in a captured message. */
function tokenFrom(text: string): string {
  const match = text.match(/https?:\/\/\S+/);
  expect(match).not.toBeNull();
  const url = new URL(match![0]);
  expect(url.origin).toBe(ORIGIN);
  expect(url.pathname).toBe(RESET_PASSWORD_PATH);
  expect([...url.searchParams.keys()]).toEqual(["token"]);
  return url.searchParams.get("token")!;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

const describeDb = RUN ? describe : describe.skip;

describeDb("1.28 — self-service password reset", () => {
  beforeEach(async () => {
    await cleanup();
    throttle = redisPasswordResetThrottle(mapBackend(), THROTTLE_SECRET);
  });

  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("answers known, unknown, and disabled addresses identically, mailing only the known active one", async () => {
    const known = await seedAccount();
    const disabled = await seedAccount({ status: "DISABLED" });

    const a = await requestReset(known.email);
    const b = await requestReset(`${EMAIL_PREFIX}-nobody@example.com`);
    const c = await requestReset(disabled.email);

    for (const { result } of [a, b, c]) {
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ requested: true });
    }
    expect(b.result.headers).toEqual(a.result.headers);
    expect(c.result.headers).toEqual(a.result.headers);
    expect(JSON.stringify(a.result)).not.toContain(known.accountId);

    /* Exactly one challenge and one delivery, for the known active account. */
    const challenges = await db.accountPasswordResetChallenge.findMany({
      where: { accountId: { in: [known.accountId, disabled.accountId] } },
    });
    expect(challenges.map((row) => [row.accountId, row.state])).toEqual([
      [known.accountId, "PENDING"],
    ]);
    const deliveries = await db.outboundEmailDelivery.findMany({
      where: { subjectRef: { in: [known.accountId, disabled.accountId] } },
    });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      purpose: "PASSWORD_RESET",
      audience: "ACCOUNT",
      subjectKind: "ACCOUNT_PASSWORD_RESET",
      subjectRef: known.accountId,
      obligationId: null,
      status: "DELIVERED",
    });

    expect(a.port.sent).toHaveLength(1);
    expect(b.port.sent).toHaveLength(0);
    expect(c.port.sent).toHaveLength(0);
    expect(a.port.sent[0]!.to).toBe(known.email);
    expect(a.port.sent[0]!.text).not.toContain(known.accountId);
    expect(a.port.sent[0]!.text).not.toContain(challenges[0]!.id);
  });

  it("defers the lookup and mail until after the answer when given a defer hook", async () => {
    const known = await seedAccount();
    const deferred: Array<() => Promise<void>> = [];
    const { result, port } = await requestReset(known.email, undefined, NOW, (task) =>
      deferred.push(task),
    );

    expect(result).toMatchObject({ status: 200, body: { requested: true } });
    expect(deferred).toHaveLength(1);
    expect(await db.outboundEmailDelivery.count({ where: { subjectRef: known.accountId } })).toBe(0);

    await deferred[0]!();
    expect(port.sent).toHaveLength(1);
  });

  it("persists only a digest of the token — never the token itself", async () => {
    const known = await seedAccount();
    const { port } = await requestReset(known.email);
    const token = tokenFrom(port.sent[0]!.text);

    const challenge = await db.accountPasswordResetChallenge.findFirstOrThrow({
      where: { accountId: known.accountId },
    });
    expect(challenge.tokenDigest).toBe(sha256(token));
    expect(challenge.expiresAt.getTime() - challenge.issuedAt.getTime()).toBe(
      ACCOUNT_PASSWORD_RESET_TOKEN_TTL_SECONDS * 1000,
    );

    const delivery = await db.outboundEmailDelivery.findFirstOrThrow({
      where: { subjectRef: known.accountId },
    });
    for (const row of [challenge, delivery]) {
      expect(JSON.stringify(row)).not.toContain(token);
    }
  });

  it("resets the password, revokes every session, and leaves email verification untouched", async () => {
    const unverified = await seedAccount();
    const verified = await seedAccount({ verified: true });

    for (const subject of [unverified, verified]) {
      const before = await db.account.findUniqueOrThrow({ where: { id: subject.accountId } });
      const sessions = await Promise.all(
        [1, 2].map(() =>
          createAccountSession(
            { accountId: subject.accountId, createdAt: NOW, ttlSeconds: 3600 },
            { db },
          ),
        ),
      );
      expect(await resolveAccountSession(sessions[0]!.token, { now: NOW, db })).toBeDefined();

      const { port } = await requestReset(subject.email);
      const result = await complete(tokenFrom(port.sent[0]!.text));
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ reset: true });
      expect(result.headers["set-cookie"]).toBeUndefined();

      for (const { token } of sessions) {
        expect(await resolveAccountSession(token, { now: NOW, db })).toBeUndefined();
      }
      expect((await signIn(subject.email, OLD_PASSWORD)).status).toBe(401);
      expect((await signIn(subject.email, NEW_PASSWORD)).status).toBe(200);

      const after = await db.account.findUniqueOrThrow({ where: { id: subject.accountId } });
      expect(after.passwordHash).not.toBe(before.passwordHash);
      expect(after.emailVerifiedAt).toEqual(before.emailVerifiedAt);
      expect(after.emailVerifiedVia).toBe(before.emailVerifiedVia);
      expect(after.status).toBe("ACTIVE");
    }

    /* The unverified account really is still unverified. */
    const still = await db.account.findUniqueOrThrow({ where: { id: unverified.accountId } });
    expect(still.emailVerifiedAt).toBeNull();
    expect(still.emailVerifiedVia).toBeNull();
    expect(
      await db.accountEmailVerificationChallenge.count({
        where: { accountId: unverified.accountId, state: "CONSUMED" },
      }),
    ).toBe(0);
  });

  it("refuses a consumed link on reuse", async () => {
    const known = await seedAccount();
    const { port } = await requestReset(known.email);
    const token = tokenFrom(port.sent[0]!.text);

    expect((await complete(token)).status).toBe(200);
    const again = await complete(token, "yet-another-password-3");
    expect(again.status).toBe(400);
    expect(again.body).toEqual({ error: PASSWORD_RESET_ERROR_CODES.linkInvalid });
    expect((await signIn(known.email, NEW_PASSWORD)).status).toBe(200);
  });

  it("refuses an expired link without changing the password", async () => {
    const known = await seedAccount();
    const { port } = await requestReset(known.email);
    const token = tokenFrom(port.sent[0]!.text);

    const expiredAt = new Date(
      new Date(NOW).getTime() + ACCOUNT_PASSWORD_RESET_TOKEN_TTL_SECONDS * 1000,
    ).toISOString();
    const result = await complete(token, NEW_PASSWORD, expiredAt);
    expect(result.body).toEqual({ error: PASSWORD_RESET_ERROR_CODES.linkInvalid });
    expect((await signIn(known.email, OLD_PASSWORD)).status).toBe(200);
  });

  it("refuses a superseded link and accepts the newer one", async () => {
    const known = await seedAccount();
    const first = tokenFrom((await requestReset(known.email)).port.sent[0]!.text);
    const second = tokenFrom((await requestReset(known.email)).port.sent[0]!.text);
    expect(second).not.toBe(first);

    expect((await complete(first)).body).toEqual({
      error: PASSWORD_RESET_ERROR_CODES.linkInvalid,
    });
    expect((await complete(second)).status).toBe(200);

    const states = await db.accountPasswordResetChallenge.findMany({
      where: { accountId: known.accountId },
      orderBy: { issuedAt: "asc" },
      select: { tokenDigest: true, state: true },
    });
    expect(new Map(states.map((s) => [s.tokenDigest, s.state]))).toEqual(
      new Map([
        [sha256(first), "SUPERSEDED"],
        [sha256(second), "CONSUMED"],
      ]),
    );
  });

  it("enforces the registration password rule without spending the link", async () => {
    const known = await seedAccount();
    const token = tokenFrom((await requestReset(known.email)).port.sent[0]!.text);

    const short = await complete(token, "too-short");
    expect(short.status).toBe(400);
    expect(short.body).toEqual({ error: PASSWORD_RESET_ERROR_CODES.invalidPassword });
    expect((await signIn(known.email, OLD_PASSWORD)).status).toBe(200);

    expect((await complete(token)).status).toBe(200);
  });

  it("refuses malformed and unknown tokens identically", async () => {
    for (const token of ["not-a-token", "A".repeat(43)]) {
      const result = await complete(token);
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ error: PASSWORD_RESET_ERROR_CODES.linkInvalid });
    }
  });

  it("charges unknown addresses the same budget, and throttles the sixth request", async () => {
    const known = await seedAccount();
    const unknown = `${EMAIL_PREFIX}-ghost@example.com`;

    for (const email of [known.email, unknown]) {
      for (let i = 0; i < 5; i += 1) {
        expect((await requestReset(email)).result.status).toBe(200);
      }
      const sixth = await requestReset(email);
      expect(sixth.result.status).toBe(429);
      expect(sixth.result.body).toEqual({ error: PASSWORD_RESET_ERROR_CODES.tooManyAttempts });
      expect(sixth.port.sent).toHaveLength(0);
    }
  });

  it("fails closed when the limiter cannot answer", async () => {
    const known = await seedAccount();
    throttle = redisPasswordResetThrottle(
      {
        async eval() {
          throw new Error("redis is gone");
        },
        async del() {
          throw new Error("redis is gone");
        },
      },
      THROTTLE_SECRET,
    );
    const { result, port } = await requestReset(known.email);
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ error: PASSWORD_RESET_ERROR_CODES.unavailable });
    expect(port.sent).toHaveLength(0);
  });
});
