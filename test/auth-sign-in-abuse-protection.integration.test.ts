/**
 * Phase 1.23 — sign-in abuse protection.
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 *
 * Four cases, and deliberately not a fifth. What is new in this phase is that a
 * shared counter now stands between a caller and `authenticateAccount` — so what
 * needs proving is that the budget actually stops attempts, that it cannot be
 * used to learn whether an account exists, that a legitimate sign-in is not
 * damaged by it, and that losing the backend refuses credentials rather than
 * waving them through.
 *
 * Not re-proved here, because it is proved elsewhere and running it through a
 * thicker pipe proves nothing new about the pipe: password verification and the
 * timing decoy (`account-identity.integration.test.ts`), cookie attributes and
 * raw-token custody (Phase 1.22), governance authority (Phase 1.21), and the
 * Upstash client's own behaviour (the vendor's).
 *
 * NO REDIS AND NO NETWORK. The route takes an injected `SignInThrottle`, so the
 * fifteen-minute window is driven by a fake clock and the backend outage is a
 * fake that throws. Production cannot reach this fake: `defaultSignInThrottle`
 * builds a Redis client or refuses, and has no in-memory branch.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { SESSION_COOKIE_NAME } from "../src/server/account/session-cookie";
import { DEFAULT_SESSION_TTL_SECONDS } from "../src/contracts/account/account";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import {
  assignStorefrontGovernance,
  createDraftStorefront,
  listGovernanceAssignments,
} from "../src/server/marketplace/storefront-service";
import { handleAppointGovernanceRequest } from "../src/server/marketplace/storefront-governance-route-handler";
import {
  SIGN_IN_ERROR_CODES,
  handleSignInRequest,
} from "../src/server/account/sign-in-route-handler";
import {
  SIGN_IN_ATTEMPT_LIMIT,
  SIGN_IN_THROTTLE_WINDOW_SECONDS,
} from "../src/server/account/sign-in-abuse-protection";
import { createFakeSignInThrottle } from "./support/sign-in-throttle-fake";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-05-01T09:00:00.000Z";
/* One hour later — inside the twelve-hour default, so a session that fails
   below failed for a reason other than expiry. */
const SOON = "2028-05-01T10:00:00.000Z";
const PASSWORD = "correct horse battery staple";
const WRONG_PASSWORD = "not the right password at all";
const EMAIL_PREFIX = "p123throttle";
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

  const participants = await db.marketplaceParticipant.findMany({
    where: { accountId: { in: accountIds } },
    select: { id: true },
  });
  const participantIds = participants.map((p) => p.id);
  if (participantIds.length > 0) {
    await db.storefrontGovernanceAssignment.deleteMany({
      where: { participantId: { in: participantIds } },
    });
    await db.storefrontSourceRecordVersionRow.deleteMany({
      where: { ownerParticipantId: { in: participantIds } },
    });
    await db.storefront.deleteMany({ where: { ownerParticipantId: { in: participantIds } } });
    await db.marketplaceRoleAssignment.deleteMany({
      where: { participantId: { in: participantIds } },
    });
    await db.marketplaceParticipant.deleteMany({ where: { id: { in: participantIds } } });
  }
  await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.accountEntitlement.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

async function seedAccount(): Promise<{ accountId: string; email: string }> {
  seq += 1;
  const email = `${EMAIL_PREFIX}${seq}@example.com`;
  const account = await createAccount(
    { name: "Throttle Caller", email, password: PASSWORD, createdAt: NOW },
    { db },
  );
  return { accountId: account.accountId, email };
}

const submit = (body: unknown) =>
  handleSignInRequest(
    {
      contentType: "application/json",
      originHeader: ORIGIN,
      rawBody: JSON.stringify(body),
    },
    { db, appOrigin: ORIGIN, now: () => NOW, throttle },
  );

const cookieHeaderFrom = (setCookie: string): string => setCookie.split(";")[0]!;
const sessionCount = (accountId: string) => db.accountSession.count({ where: { accountId } });

const describeDb = RUN ? describe : describe.skip;

describeDb("1.23 — sign-in abuse protection", () => {
  beforeEach(async () => {
    throttle = createFakeSignInThrottle();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("spends the budget, refuses with 429, and recovers when the window expires", async () => {
    const account = await seedAccount();

    /* Every attempt inside the budget is answered as an ordinary credential
       failure — the throttle is invisible until it is spent. */
    for (let attempt = 1; attempt <= SIGN_IN_ATTEMPT_LIMIT; attempt += 1) {
      const result = await submit({ email: account.email, password: WRONG_PASSWORD });
      expect(result.status).toBe(401);
      expect(result.body).toEqual({ error: SIGN_IN_ERROR_CODES.invalidCredentials });
      expect(result.headers["set-cookie"]).toBeUndefined();
    }

    /* One past the budget, and the answer changes shape. */
    const throttled = await submit({ email: account.email, password: WRONG_PASSWORD });
    expect(throttled.status).toBe(429);
    expect(throttled.body).toEqual({ error: SIGN_IN_ERROR_CODES.tooManyAttempts });
    expect(throttled.headers["set-cookie"]).toBeUndefined();
    /* A real remaining TTL, not a guess, and nothing else added to the body. */
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
    expect(Number(throttled.headers["retry-after"])).toBeLessThanOrEqual(
      SIGN_IN_THROTTLE_WINDOW_SECONDS,
    );

    /* The correct password is refused too, while the budget is spent. This is
       throttling, not a lockout: nothing durable changed. */
    const correctButThrottled = await submit({ email: account.email, password: PASSWORD });
    expect(correctButThrottled.status).toBe(429);
    expect(await sessionCount(account.accountId)).toBe(0);
    const row = await db.account.findUnique({ where: { id: account.accountId } });
    expect(row?.status).toBe("ACTIVE");

    /* The window is fixed and expires on its own — no operator, no unblock tool,
       no reset endpoint. Fifteen minutes after the first failure, the same
       caller signs in normally. */
    throttle.advanceSeconds(SIGN_IN_THROTTLE_WINDOW_SECONDS + 1);
    const recovered = await submit({ email: account.email, password: PASSWORD });
    expect(recovered.status).toBe(200);
    expect(recovered.headers["set-cookie"]).toContain(`${SESSION_COOKIE_NAME}=`);
  });

  it("charges an unknown address exactly as it charges a wrong password", async () => {
    /* The enumeration question, asked of the throttle rather than of the 401.
       The budget is keyed on the SUBMITTED identifier and charged before any
       lookup, so an address that has no account behaves identically to one that
       does — including the moment it starts answering 429. */
    const known = await seedAccount();
    seq += 1;
    const unknown = `${EMAIL_PREFIX}${seq}-absent@example.com`;

    for (let attempt = 1; attempt <= SIGN_IN_ATTEMPT_LIMIT; attempt += 1) {
      const knownResult = await submit({ email: known.email, password: WRONG_PASSWORD });
      const unknownResult = await submit({ email: unknown, password: WRONG_PASSWORD });
      expect(knownResult.status).toBe(unknownResult.status);
      expect(knownResult.body).toEqual(unknownResult.body);
      expect(knownResult.status).toBe(401);
    }

    const knownThrottled = await submit({ email: known.email, password: WRONG_PASSWORD });
    const unknownThrottled = await submit({ email: unknown, password: WRONG_PASSWORD });
    expect(knownThrottled.status).toBe(429);
    expect(unknownThrottled.status).toBe(429);
    expect(knownThrottled.body).toEqual(unknownThrottled.body);
    /* Identical down to the header set: a 429 that carried a different
       `Retry-After` shape for a real address would be the oracle back again. */
    expect(Object.keys(knownThrottled.headers).sort()).toEqual(
      Object.keys(unknownThrottled.headers).sort(),
    );

    /* Transport failures never touched either budget — the counters above are
       exactly the credential attempts, and nothing else. */
    const malformed = await handleSignInRequest(
      { contentType: "application/json", originHeader: ORIGIN, rawBody: "{ not json" },
      { db, appOrigin: ORIGIN, now: () => NOW, throttle },
    );
    expect(malformed.status).toBe(400);
    const crossOrigin = await handleSignInRequest(
      {
        contentType: "application/json",
        originHeader: "https://evil.example",
        rawBody: JSON.stringify({ email: known.email, password: WRONG_PASSWORD }),
      },
      { db, appOrigin: ORIGIN, now: () => NOW, throttle },
    );
    expect(crossOrigin.status).toBe(403);
  });

  it("releases the budget on a successful sign-in and still authorizes governance", async () => {
    /* A legitimate user who mistypes their password several times must not be
       left closer to a lockout for having eventually got it right. And the whole
       operational loop still has to work with abuse protection in front of it. */
    const owner = await seedAccount();
    const ownerParticipant = await createDraftParticipant(
      { accountId: owner.accountId, initialRoles: ["SELLER"], now: NOW },
      { db },
    );
    const ownerParticipantId = ownerParticipant.participant.participantId;
    seq += 1;
    const snapshot = await createDraftStorefront(
      {
        ownerParticipantId,
        publicHandle: `p123-shop-${seq}`,
        presentation: { displayName: "Throttle Shop", tagline: null, summary: null },
        actingAccountId: owner.accountId,
        now: NOW,
      },
      { db },
    );
    const internalStorefrontId = snapshot.record.internalStorefrontId;
    await assignStorefrontGovernance(
      {
        internalStorefrontId,
        participantId: ownerParticipantId,
        role: "SUPER_OWNER",
        actingAccountId: owner.accountId,
        now: NOW,
      },
      { db },
    );
    const appointee = await seedAccount();
    const appointeeParticipant = await createDraftParticipant(
      { accountId: appointee.accountId, initialRoles: ["SELLER"], now: NOW },
      { db },
    );

    /* Most of the budget spent, then a correct password. */
    for (let attempt = 1; attempt < SIGN_IN_ATTEMPT_LIMIT; attempt += 1) {
      expect((await submit({ email: owner.email, password: WRONG_PASSWORD })).status).toBe(401);
    }
    expect(throttle.countFor(owner.email)).toBe(SIGN_IN_ATTEMPT_LIMIT - 1);

    const signedIn = await submit({ email: owner.email, password: PASSWORD });
    expect(signedIn.status).toBe(200);
    expect(signedIn.body).toEqual({ accountId: owner.accountId });
    /* The bucket is gone, not merely under budget: success releases it. */
    expect(throttle.countFor(owner.email)).toBe(0);

    const setCookie = signedIn.headers["set-cookie"]!;
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain(`Max-Age=${DEFAULT_SESSION_TTL_SECONDS}`);

    const governance = await handleAppointGovernanceRequest(
      {
        contentType: "application/json",
        originHeader: ORIGIN,
        cookieHeader: cookieHeaderFrom(setCookie),
        rawBody: JSON.stringify({
          internalStorefrontId,
          participantId: appointeeParticipant.participant.participantId,
          role: "ADMIN",
        }),
      },
      { db, appOrigin: ORIGIN, now: () => SOON },
    );
    expect(governance.status).toBe(200);
    const assignments = await listGovernanceAssignments(internalStorefrontId, { db });
    expect(
      assignments.find((a) => a.participantId === appointeeParticipant.participant.participantId)
        ?.role,
    ).toBe("ADMIN");
  });

  it("fails closed when the throttle backend is unavailable", async () => {
    /* The decision this phase had to make. A credential endpoint that cannot
       count attempts either stops accepting passwords or becomes an unmetered
       brute-force target; Monacado stops. Note the correct password is refused
       too — the backend being down is not a reason to check credentials
       unprotected, and no session exists afterwards either way. */
    const account = await seedAccount();
    throttle.breakBackend();

    for (const password of [WRONG_PASSWORD, PASSWORD]) {
      const result = await submit({ email: account.email, password });
      expect(result.status).toBe(503);
      expect(result.body).toEqual({ error: SIGN_IN_ERROR_CODES.unavailable });
      expect(result.headers["set-cookie"]).toBeUndefined();
      /* Nothing about Redis, the endpoint, the token, or the key reaches the
         caller — the body is one bounded code and nothing else. */
      expect(Object.keys(result.body)).toEqual(["error"]);
    }
    expect(await sessionCount(account.accountId)).toBe(0);
  });
});
