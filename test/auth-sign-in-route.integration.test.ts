/**
 * Phase 1.22 — sign-in over HTTP.
 *
 * The credential rules themselves are not re-proved here. `authenticateAccount`
 * already owns the normalized lookup, the timing decoy, the `ACTIVE`
 * requirement, and the decision to answer a malformed submission as a credential
 * failure, and `account-identity.integration.test.ts` asserts all of it against
 * the database. Running the same table through a thicker pipe would prove
 * nothing new about the pipe.
 *
 * What is new is the pipe: that signing in actually yields a credential the rest
 * of the application accepts, that the uniform refusal survives the HTTP edge
 * rather than being split back apart by it, that the edge refuses an
 * authority-shaped key instead of discarding it, that a cross-origin submission
 * is refused before any credential work happens, and that the token leaves the
 * server in a cookie and nowhere else.
 *
 * NO NETWORK and no framework request objects: the handler takes a content type,
 * an origin, and a raw body, so every rule is exercised directly.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount, setAccountStatus } from "../src/server/account/account-service";
import { SESSION_COOKIE_NAME } from "../src/server/account/session-cookie";
import { hashSessionToken } from "../src/server/account/session-token";
import { DEFAULT_SESSION_TTL_SECONDS } from "../src/contracts/account/account";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import {
  assignStorefrontGovernance,
  createDraftStorefront,
  listGovernanceAssignments,
} from "../src/server/marketplace/storefront-service";
import { handleAppointGovernanceRequest } from "../src/server/marketplace/storefront-governance-route-handler";
import {
  NEVER_ON_SIGN_IN_REQUEST,
  SIGN_IN_ERROR_CODES,
  handleSignInRequest,
} from "../src/server/account/sign-in-route-handler";
import { createFakeSignInThrottle } from "./support/sign-in-throttle-fake";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-04-01T09:00:00.000Z";
/* One hour later — inside the twelve-hour default the route issues, so a
   session that fails below failed for a reason other than expiry. */
const SOON = "2028-04-01T10:00:00.000Z";
const PASSWORD = "correct horse battery staple";
const EMAIL_PREFIX = "p122signin";
const ORIGIN = "https://monacado.test";

let seq = 0;

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
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

/** A real Account with a real password. No session — that is what is under test. */
async function seedAccount() {
  seq += 1;
  const email = `${EMAIL_PREFIX}${seq}@example.com`;
  const account = await createAccount(
    { name: "Sign-In Caller", email, password: PASSWORD, createdAt: NOW },
    { db },
  );
  return { accountId: account.accountId, email };
}

/* Phase 1.23 added shared abuse protection ahead of credential verification.
   Production resolves a Redis-backed throttle and refuses when it is missing;
   these cases are about the 1.22 pipe, so they inject a fake with a budget none
   of them comes close to spending. Its behaviour is proved separately in
   `auth-sign-in-abuse-protection.integration.test.ts`. */
let throttle = createFakeSignInThrottle();

const submit = (
  body: unknown,
  overrides: { contentType?: string | null; origin?: string | null } = {},
) =>
  handleSignInRequest(
    {
      contentType: overrides.contentType === undefined ? "application/json" : overrides.contentType,
      originHeader: overrides.origin === undefined ? ORIGIN : overrides.origin,
      rawBody: typeof body === "string" ? body : JSON.stringify(body),
    },
    { db, appOrigin: ORIGIN, now: () => NOW, throttle },
  );

/** The token as a browser would send it back. */
function cookieHeaderFrom(setCookie: string): string {
  return setCookie.split(";")[0]!;
}

const sessionCount = (accountId: string) => db.accountSession.count({ where: { accountId } });

const describeDb = RUN ? describe : describe.skip;

describeDb("1.22 — sign-in over HTTP", () => {
  beforeEach(async () => {
    throttle = createFakeSignInThrottle();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("issues a cookie that authorizes a governance operation", async () => {
    /* The whole point of the phase, end to end: no session is minted by the
       test. The only credential in play is the one the route handed back. */
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
        publicHandle: `p122-shop-${seq}`,
        presentation: { displayName: "Sign-In Shop", tagline: null, summary: null },
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

    const signedIn = await submit({ email: owner.email, password: PASSWORD });

    expect(signedIn.status).toBe(200);
    /* The account's own id, and nothing more — no token, no email, no status. */
    expect(signedIn.body).toEqual({ accountId: owner.accountId });
    const setCookie = signedIn.headers["set-cookie"]!;
    /* Only what the route decided. `HttpOnly`, `SameSite=Strict`, `Path=/` and
       the absence of `Domain` belong to `buildSessionCookie` and are asserted
       against it directly in `account-identity.integration.test.ts`; what the
       route chooses is the cookie's name, its lifetime, and — from the
       configured origin's scheme — whether it may travel in clear text. */
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain(`Max-Age=${DEFAULT_SESSION_TTL_SECONDS}`);
    expect(setCookie).toContain("Secure");

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
      assignments.find(
        (a) => a.participantId === appointeeParticipant.participant.participantId,
      )?.role,
    ).toBe("ADMIN");
  });

  it("answers every credential failure identically", async () => {
    /* An unknown address, a wrong password, and a disabled account are three
       different facts, and the caller must not be able to tell which one they
       hit. Anything that distinguishes them is an enumeration oracle: a distinct
       answer for "no such account" is a free address checker, and a distinct
       answer for DISABLED discloses that an account exists and is in trouble.

       The service already collapses all three onto one error, and
       `account-identity.integration.test.ts` proves that. What is asserted here
       is only that the HTTP edge does not widen them back out — a route that
       mapped an account-not-found differently would undo the collapse. */
    const active = await seedAccount();
    const disabled = await seedAccount();
    await setAccountStatus(disabled.accountId, "DISABLED", { db });

    const refusals = [
      { email: `${EMAIL_PREFIX}-nobody@example.com`, password: PASSWORD },
      { email: active.email, password: "not the password" },
      { email: disabled.email, password: PASSWORD },
    ];

    for (const attempt of refusals) {
      const result = await submit(attempt);
      const label = `${attempt.email}/${attempt.password}`;
      expect(`${label}:${result.status}`).toBe(`${label}:401`);
      expect(result.body).toEqual({ error: SIGN_IN_ERROR_CODES.invalidCredentials });
      /* Not even a hint in the shape of a header. */
      expect(result.headers["set-cookie"]).toBeUndefined();
      expect(result.headers["cache-control"]).toBe("no-store");
    }

    /* And none of it left a session behind. */
    expect(await sessionCount(active.accountId)).toBe(0);
    expect(await sessionCount(disabled.accountId)).toBe(0);
  });

  it("refuses an authority-shaped key rather than discarding it", async () => {
    /* A sign-in body is the one payload an anonymous caller may send, so the
       strictness has to come from the schema rather than from a helper that
       tidies up afterwards. `ttlSeconds` is the sharpest of these: a caller who
       could set it would issue themselves a session that outlives every bound
       the contract defines. */
    const account = await seedAccount();

    for (const forbidden of NEVER_ON_SIGN_IN_REQUEST) {
      const result = await submit({
        email: account.email,
        password: PASSWORD,
        [forbidden]: forbidden === "ttlSeconds" || forbidden === "maxAgeSeconds" ? 2_592_000 : "x",
      });
      expect(`${forbidden}:${result.status}`).toBe(`${forbidden}:400`);
      expect(result.body).toEqual({ error: SIGN_IN_ERROR_CODES.invalidRequest });
      expect(result.headers["set-cookie"]).toBeUndefined();
    }

    /* Correct credentials throughout, and still no session: the refusal was the
       schema's, not the credentials'. */
    expect(await sessionCount(account.accountId)).toBe(0);
  });

  it("refuses a cross-origin submission before it checks the password", async () => {
    /* `SameSite=Strict` protects the session once it exists; nothing protects
       the exchange that creates it except this check. A form posted from
       another site to a signed-out browser cannot start a session here. */
    const account = await seedAccount();
    const valid = { email: account.email, password: PASSWORD };

    for (const origin of ["https://evil.example", "http://monacado.test"]) {
      const result = await submit(valid, { origin });
      expect(`${origin}:${result.status}`).toBe(`${origin}:403`);
      expect(result.body).toEqual({ error: SIGN_IN_ERROR_CODES.crossOrigin });
      expect(result.headers["set-cookie"]).toBeUndefined();
    }
    expect(await sessionCount(account.accountId)).toBe(0);

    /* A non-JSON submission is refused too, so an HTML form post — the shape a
       cross-site attempt actually takes — has no way in even without an origin
       header at all. */
    const formPost = await submit("email=a&password=b", {
      contentType: "application/x-www-form-urlencoded",
      origin: null,
    });
    expect(formPost.status).toBe(400);
    expect(formPost.body).toEqual({ error: SIGN_IN_ERROR_CODES.invalidRequest });
  });

  it("persists a digest and hands the only copy of the token to the cookie", async () => {
    /* The token is a live credential. It exists in exactly two places: this
       response's Set-Cookie header, and the caller's browser. The row keeps a
       SHA-256 of it, so a database disclosure yields nothing usable — and the
       response body must not quietly hold a second copy. */
    const account = await seedAccount();
    const result = await submit({ email: account.email, password: PASSWORD });

    const token = cookieHeaderFrom(result.headers["set-cookie"]!).slice(
      `${SESSION_COOKIE_NAME}=`.length,
    );
    expect(token.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.body)).not.toContain(token);

    const rows = await db.accountSession.findMany({ where: { accountId: account.accountId } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.tokenHash).toBe(hashSessionToken(token));
    expect(row.tokenHash).not.toBe(token);
    expect(row.revokedAt).toBeNull();
    /* Bounded by the contract's default rather than by anything the caller sent. */
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(
      DEFAULT_SESSION_TTL_SECONDS * 1_000,
    );
  });
});
