/**
 * Phase 1.24 — sign-out over HTTP.
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 *
 * Three cases. The first is the phase, end to end and with nothing simulated:
 * a real account signs in through Phase 1.22, uses the cookie it was handed
 * against a Phase 1.21 governance route, signs out, and then finds the same
 * cookie no longer authenticates. Proving revocation any other way — by reading
 * `revokedAt` off the row, say — would prove the column was written, not that the
 * credential stopped working.
 *
 * Not re-proved here: `revokeAccountSession`'s idempotence and the cookie
 * builders' attributes (`account-identity.integration.test.ts`), sign-in
 * credential semantics (Phase 1.22), throttling (Phase 1.23), and governance
 * authority (Phase 1.21).
 *
 * NO NETWORK. Both route handlers take plain header values, so every rule is
 * exercised directly.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { SESSION_COOKIE_NAME } from "../src/server/account/session-cookie";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import {
  assignStorefrontGovernance,
  createDraftStorefront,
} from "../src/server/marketplace/storefront-service";
import {
  GOVERNANCE_ROUTE_ERROR_CODES,
  handleAppointGovernanceRequest,
} from "../src/server/marketplace/storefront-governance-route-handler";
import { handleSignInRequest } from "../src/server/account/sign-in-route-handler";
import {
  SIGN_OUT_ERROR_CODES,
  handleSignOutRequest,
} from "../src/server/account/sign-out-route-handler";
import { createFakeSignInThrottle } from "./support/sign-in-throttle-fake";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-07-01T09:00:00.000Z";
/* One hour later — inside the twelve-hour default, so a session that stops
   working below stopped for a reason other than expiry. */
const SOON = "2028-07-01T10:00:00.000Z";
const PASSWORD = "correct horse battery staple";
const EMAIL_PREFIX = "p124signout";
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
    { name: "Sign-Out Caller", email, password: PASSWORD, createdAt: NOW },
    { db },
  );
  return { accountId: account.accountId, email };
}

/** Sign in for real and return the cookie a browser would send back. */
async function signIn(email: string): Promise<{ cookieHeader: string }> {
  const result = await handleSignInRequest(
    {
      contentType: "application/json",
      originHeader: ORIGIN,
      rawBody: JSON.stringify({ email, password: PASSWORD }),
    },
    { db, appOrigin: ORIGIN, now: () => NOW, throttle },
  );
  expect(result.status).toBe(200);
  return { cookieHeader: result.headers["set-cookie"]!.split(";")[0]! };
}

const signOut = (cookieHeader: string | null, origin: string | null = ORIGIN) =>
  handleSignOutRequest({ originHeader: origin, cookieHeader }, { db, appOrigin: ORIGIN, now: () => SOON });

const describeDb = RUN ? describe : describe.skip;

describeDb("1.24 — sign-out over HTTP", () => {
  beforeEach(async () => {
    throttle = createFakeSignInThrottle();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("ends the session it was given, and the same cookie stops authorizing", async () => {
    /* The phase, end to end. Nothing is minted or revoked by the test: the only
       credential in play is the one sign-in handed back, and the only thing that
       ends it is the sign-out route. */
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
        publicHandle: `p124-shop-${seq}`,
        presentation: { displayName: "Sign-Out Shop", tagline: null, summary: null },
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

    const { cookieHeader } = await signIn(owner.email);

    const appoint = (participantId: string) =>
      handleAppointGovernanceRequest(
        {
          contentType: "application/json",
          originHeader: ORIGIN,
          cookieHeader,
          rawBody: JSON.stringify({ internalStorefrontId, participantId, role: "ADMIN" }),
        },
        { db, appOrigin: ORIGIN, now: () => SOON },
      );

    /* The cookie works before sign-out. */
    const before = await appoint(appointeeParticipant.participant.participantId);
    expect(before.status).toBe(200);

    const out = await signOut(cookieHeader);
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ signedOut: true });
    /* A clearing cookie whose attributes match the one it replaces — a browser
       only replaces a cookie when name and path agree. */
    const cleared = out.headers["set-cookie"]!;
    expect(cleared).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Path=/");

    /* The point of the phase: the ORIGINAL cookie, replayed by a caller who
       kept a copy, no longer authenticates. */
    const after = await appoint(appointeeParticipant.participant.participantId);
    expect(after.status).toBe(401);
    expect(after.body).toEqual({ error: GOVERNANCE_ROUTE_ERROR_CODES.unauthenticated });

    /* Exactly one session was ended, and the account itself was not touched. */
    const sessions = await db.accountSession.findMany({ where: { accountId: owner.accountId } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.revokedAt).not.toBeNull();
    const row = await db.account.findUnique({ where: { id: owner.accountId } });
    expect(row?.status).toBe("ACTIVE");
  });

  it("answers every sign-out identically, however stale the cookie", async () => {
    /* Signed in, already signed out, a token that was never real, and no cookie
       at all are four different facts, and none of them may be visible. A caller
       who learns that their stale token matched a historical row learns that the
       token was once issued. */
    const account = await seedAccount();
    const { cookieHeader } = await signIn(account.email);

    const first = await signOut(cookieHeader);
    const repeat = await signOut(cookieHeader);
    const neverReal = await signOut(`${SESSION_COOKIE_NAME}=not-a-token-that-was-ever-issued`);
    const noCookie = await signOut(null);

    for (const result of [first, repeat, neverReal, noCookie]) {
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ signedOut: true });
      expect(result.headers["set-cookie"]).toBe(first.headers["set-cookie"]);
      expect(Object.keys(result.headers).sort()).toEqual(Object.keys(first.headers).sort());
    }

    /* The repeat did not rewrite when the session actually ended. */
    const sessions = await db.accountSession.findMany({ where: { accountId: account.accountId } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.revokedAt?.toISOString()).toBe(SOON);
  });

  it("refuses a cross-origin sign-out before it revokes anything", async () => {
    /* A cross-site page that could sign a visitor out of Monacado would be a
       working logout-CSRF. The session must survive it intact. */
    const account = await seedAccount();
    const { cookieHeader } = await signIn(account.email);

    for (const origin of ["https://evil.example", "http://monacado.test"]) {
      const refused = await signOut(cookieHeader, origin);
      expect(refused.status).toBe(403);
      expect(refused.body).toEqual({ error: SIGN_OUT_ERROR_CODES.crossOrigin });
      /* No clearing cookie either — being loaded must not log anyone out. */
      expect(refused.headers["set-cookie"]).toBeUndefined();
    }

    const sessions = await db.accountSession.findMany({ where: { accountId: account.accountId } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.revokedAt).toBeNull();
  });
});
