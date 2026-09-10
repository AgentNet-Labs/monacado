/**
 * Phase 1.25 — what a rendered page is allowed to conclude about the visitor.
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 *
 * One case, and it is the phase's guard end to end with nothing simulated: a
 * real account signs in through Phase 1.22, the cookie it was handed resolves
 * for a page, every way of *not* being signed in resolves to the same nothing,
 * and a real Phase 1.24 sign-out takes the first answer away.
 *
 * ## Why this is the thing worth proving
 *
 * `/account` renders protected content and `/sign-in` sends a signed-in visitor
 * away, and both decisions are `resolvePageSession` returning `undefined` or
 * not. The pages themselves are two lines each on top of that call. So the
 * question that matters is not whether `redirect()` was invoked — it is whether
 * this function ever answers "signed in" for a cookie that should not count.
 *
 * Expired, revoked, and since-disabled are the three that would be easy to get
 * wrong, because each one is a session row that still exists and still matches
 * on `tokenHash`. A guard that looked up a row and stopped there would let all
 * three through.
 *
 * Not re-proved here: sign-in credential semantics (Phase 1.22), the attempt
 * budget (Phase 1.23), sign-out idempotence and its uniform answer (Phase 1.24),
 * or `resolveAccountSession`'s own contract (`account-identity`). This suite
 * asserts only that the page-side entry point inherits them rather than
 * re-deciding them.
 *
 * NO NETWORK. Both route handlers and the resolver take plain header values.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { DEFAULT_SESSION_TTL_SECONDS } from "../src/contracts/account/account";
import { createAccount, setAccountStatus } from "../src/server/account/account-service";
import { handleSignInRequest } from "../src/server/account/sign-in-route-handler";
import { handleSignOutRequest } from "../src/server/account/sign-out-route-handler";
import { resolvePageSession } from "../src/server/account/page-session";
import { createFakeSignInThrottle } from "./support/sign-in-throttle-fake";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-08-01T09:00:00.000Z";
/* One hour in — well inside the twelve-hour default, so a session that stops
   resolving below stopped for a reason other than expiry. */
const SOON = "2028-08-01T10:00:00.000Z";
/* One second past the default lifetime. */
const AFTER_EXPIRY = new Date(
  Date.parse(NOW) + (DEFAULT_SESSION_TTL_SECONDS + 1) * 1000,
).toISOString();

const PASSWORD = "correct horse battery staple";
const EMAIL_PREFIX = "p125page";
const ORIGIN = "https://monacado.test";

let seq = 0;
let throttle = createFakeSignInThrottle();

async function cleanup(): Promise<void> {
  const accounts = await db.account.findMany({
    where: { email: { startsWith: EMAIL_PREFIX } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length === 0) return;
  await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.accountEntitlement.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

async function seedAccount(): Promise<{ accountId: string; email: string }> {
  seq += 1;
  const email = `${EMAIL_PREFIX}${seq}@example.com`;
  const account = await createAccount(
    { name: "Page Visitor", email, password: PASSWORD, createdAt: NOW },
    { db },
  );
  return { accountId: account.accountId, email };
}

/** Sign in for real and return the cookie a browser would send back. */
async function signIn(email: string): Promise<string> {
  const result = await handleSignInRequest(
    {
      contentType: "application/json",
      originHeader: ORIGIN,
      rawBody: JSON.stringify({ email, password: PASSWORD }),
    },
    { db, appOrigin: ORIGIN, now: () => NOW, throttle },
  );
  expect(result.status).toBe(200);
  return result.headers["set-cookie"]!.split(";")[0]!;
}

const resolveAt = (cookieHeader: string | null, now: string = SOON) =>
  resolvePageSession(cookieHeader, { db, now: () => now });

const describeDb = RUN ? describe : describe.skip;

describeDb("1.25 — page session resolution", () => {
  beforeEach(async () => {
    throttle = createFakeSignInThrottle();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("resolves a live session for a page, and nothing else does", async () => {
    const visitor = await seedAccount();
    const cookieHeader = await signIn(visitor.email);

    /* The signed-in case. `/account` renders on this and `/sign-in` redirects
       away from it, and the account it names is the one that signed in — a
       resolver that returned the wrong account would still look like success to
       a guard that only checked for `undefined`. */
    expect(await resolveAt(cookieHeader)).toEqual({ accountId: visitor.accountId });

    /* No cookie at all, a cookie header carrying only unrelated cookies, and a
       token that was never real. A visitor arriving with any of these is simply
       not signed in, and the three are indistinguishable on purpose. */
    expect(await resolveAt(null)).toBeUndefined();
    expect(await resolveAt("")).toBeUndefined();
    expect(await resolveAt("theme=dark; locale=en")).toBeUndefined();
    expect(
      await resolveAt("monacado_session=Ai8kQnJqTHhZc0Zvd0hxTndrM2ZWZWdKZUpsSzBhaWM"),
    ).toBeUndefined();

    /* Expiry. The row still exists and still matches on `tokenHash`; only the
       clock has moved. A guard that looked the session up and stopped there
       would admit this. */
    expect(await resolveAt(cookieHeader, AFTER_EXPIRY)).toBeUndefined();

    /* A disabled account, with a session that is otherwise perfectly live. The
       account is re-read on every resolution precisely so this fails closed
       immediately rather than at the end of the session's twelve hours. */
    await setAccountStatus(visitor.accountId, "DISABLED", { db });
    expect(await resolveAt(cookieHeader)).toBeUndefined();
    await setAccountStatus(visitor.accountId, "ACTIVE", { db });
    expect(await resolveAt(cookieHeader)).toEqual({ accountId: visitor.accountId });

    /* And the loop closes. Nothing is revoked by the test — the real Phase 1.24
       endpoint is called with the cookie a browser would have sent, exactly as
       the sign-out button causes — and afterwards the protected page will not
       render for it. Asserting `revokedAt` on the row instead would prove a
       column was written, not that the credential stopped working. */
    const signedOut = await handleSignOutRequest(
      { originHeader: ORIGIN, cookieHeader },
      { db, appOrigin: ORIGIN, now: () => SOON },
    );
    expect(signedOut.status).toBe(200);
    expect(await resolveAt(cookieHeader)).toBeUndefined();

    /* Signing in again is a different session and works, so what stopped was
       the credential and not the account. */
    const second = await signIn(visitor.email);
    expect(second).not.toBe(cookieHeader);
    expect(await resolveAt(second)).toEqual({ accountId: visitor.accountId });
  });
});
