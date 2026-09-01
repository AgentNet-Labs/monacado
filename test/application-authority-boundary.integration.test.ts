/**
 * Phase 1.18 — the trusted actor source, against real rows (disposable MySQL).
 *
 * The pure suite proves the acting-account context cannot be *built*. This one
 * proves it is *resolved correctly*: from a persisted session, failing closed on
 * every not-signed-in condition, and that the application command supplies the
 * identity rather than believing a payload.
 *
 * Deliberately narrow. Authorization rules are asserted in the Offer, Listing,
 * and Storefront suites, which own them; nothing here re-tests a rule.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import {
  createAccountSession,
  revokeAccountSession,
} from "../src/server/account/account-session-service";
import { SESSION_COOKIE_NAME } from "../src/server/account/session-cookie";
import { resolveActingAccount } from "../src/server/account/acting-participant-boundary";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import { createDraftStorefront } from "../src/server/marketplace/storefront-service";
import {
  createProductSourceRecordAs,
  submitStorefrontSourceVersion,
} from "../src/server/marketplace/marketplace-application-service";
import { StorefrontNotAuthorizedError } from "../src/server/marketplace/storefront-errors";
import { ProductCreatorParticipantRequiredError } from "../src/server/product/errors";
import { createDraftOffer } from "../src/server/marketplace/offer-service";
import { syntheticProductSourceRecord } from "../src/contracts/fixtures/synthetic-source-record";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = getPrisma();

const NOW = "2027-09-01T09:00:00.000Z";
const LATER = "2027-09-02T09:00:00.000Z";
const PASSWORD = "correct horse battery staple";
const EMAIL_PREFIX = "p118boundary";
const PRODUCT_PREFIX = "mon:product:P118B";

/** A synthetic Product source record, uniquely identified per call. */
function productRecord(n: number) {
  const pad = (v: string) => v.padEnd(26, "0").slice(0, 26);
  return {
    ...syntheticProductSourceRecord(),
    internalProductId: `mon:product:${pad(`P118B${n}`)}`,
    sourceRecordId: `mon:srec:${pad(`P118BSREC${n}`)}`,
  };
}

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
  await db.accountEntitlement.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

async function cleanupProducts(): Promise<void> {
  await db.offerSourceRecordVersionRow.deleteMany({
    where: { internalProductId: { startsWith: PRODUCT_PREFIX } },
  });
  await db.offer.deleteMany({ where: { internalProductId: { startsWith: PRODUCT_PREFIX } } });
  await db.productSourceRecordVersionRow.deleteMany({
    where: { internalProductId: { startsWith: PRODUCT_PREFIX } },
  });
  await db.product.deleteMany({ where: { internalProductId: { startsWith: PRODUCT_PREFIX } } });
}

/** A real account, a real participant, and a real session. */
async function signIn(roles: Array<"SELLER" | "PROMOTER"> = ["SELLER"]) {
  seq += 1;
  const account = await createAccount(
    {
      name: "Boundary Seller",
      email: `${EMAIL_PREFIX}${seq}@example.com`,
      password: PASSWORD,
      createdAt: NOW,
    },
    { db },
  );
  const participant = await createDraftParticipant(
    { accountId: account.accountId, initialRoles: roles, now: NOW },
    { db },
  );
  const { token } = await createAccountSession(
    { accountId: account.accountId, createdAt: NOW, ttlSeconds: 3_600 },
    { db },
  );
  return {
    accountId: account.accountId,
    participantId: participant.participant.participantId,
    token,
    cookieHeader: `${SESSION_COOKIE_NAME}=${token}`,
  };
}

describe.skipIf(!RUN)("Phase 1.18 — the application authority boundary (disposable MySQL)", () => {
  beforeEach(async () => {
    await cleanupProducts();
    await cleanup();
  });
  afterAll(async () => {
    await cleanupProducts();
    await cleanup();
    await disconnectPrisma();
  });

  // — 1. The actor comes from the session, or from nowhere —

  it("resolves the acting account from a persisted session cookie", async () => {
    const seller = await signIn();
    const resolution = await resolveActingAccount(
      { cookieHeader: seller.cookieHeader, now: NOW },
      { db },
    );
    expect(resolution.outcome).toBe("AUTHENTICATED");
    if (resolution.outcome !== "AUTHENTICATED") throw new Error("unreachable");
    expect(resolution.actor.accountId).toBe(seller.accountId);
  });

  it("answers UNAUTHENTICATED identically for absent, unknown, and revoked", async () => {
    /* One answer for every not-signed-in condition, matching
       `resolveAccountSession`: distinguishing them would tell the holder of a
       stale token why it is stale. */
    const seller = await signIn();

    const absent = await resolveActingAccount({ cookieHeader: null, now: NOW }, { db });
    const empty = await resolveActingAccount({ cookieHeader: "", now: NOW }, { db });
    const unknown = await resolveActingAccount(
      { cookieHeader: `${SESSION_COOKIE_NAME}=not-a-real-token`, now: NOW },
      { db },
    );

    await revokeAccountSession(seller.token, { revokedAt: NOW, db });
    const revoked = await resolveActingAccount(
      { cookieHeader: seller.cookieHeader, now: LATER },
      { db },
    );

    for (const resolution of [absent, empty, unknown, revoked]) {
      expect(resolution).toEqual({ outcome: "UNAUTHENTICATED" });
    }
  });

  it("fails closed on the very next call when the account is disabled", async () => {
    const seller = await signIn();
    await db.account.update({ where: { id: seller.accountId }, data: { status: "DISABLED" } });

    expect(
      await resolveActingAccount({ cookieHeader: seller.cookieHeader, now: NOW }, { db }),
    ).toEqual({ outcome: "UNAUTHENTICATED" });
  });

  // — 2. The application command supplies the identity —

  it("acts as the session's account, ignoring an actingAccountId in the payload", async () => {
    /* The load-bearing assertion. A route that forwarded a request body would
       otherwise let a caller name any account and inherit whatever it owns.
       Here the victim owns the Storefront and the attacker holds a session; the
       attacker's payload names the victim's account. */
    const victim = await signIn();
    const attacker = await signIn();

    const storefront = await createDraftStorefront(
      {
        ownerParticipantId: victim.participantId,
        publicHandle: `p118-boundary-${(seq += 1)}`,
        presentation: { displayName: "Victim Shop", tagline: null, summary: null },
        actingAccountId: victim.accountId,
        now: NOW,
      },
      { db },
    );

    const attackerResolution = await resolveActingAccount(
      { cookieHeader: attacker.cookieHeader, now: NOW },
      { db },
    );
    if (attackerResolution.outcome !== "AUTHENTICATED") throw new Error("unreachable");

    await expect(
      submitStorefrontSourceVersion(
        attackerResolution.actor,
        {
          internalStorefrontId: storefront.record.internalStorefrontId,
          sourceRecordVersion: "2",
          presentation: { displayName: "Hijacked", tagline: null, summary: null },
          now: LATER,
          // The forgery: a claimed identity, alongside a genuine session.
          actingAccountId: victim.accountId,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(StorefrontNotAuthorizedError);

    // Nothing was minted.
    const versions = await db.storefrontSourceRecordVersionRow.count({
      where: { internalStorefrontId: storefront.record.internalStorefrontId },
    });
    expect(versions).toBe(1);
  });

  // — 3. Product authority originates at the authenticated write —

  it("records the acting participant as creator authority, and that Product can back an Offer", async () => {
    /* Phase 1.18 closed the loop the derivation left open. Product authority is
       read from `authorityCreatorParticipantId` on the current source version,
       and the production writer set only the opaque `mon:creator:` reference —
       so a Product created by Monacado's own writer could back no commerce at
       all. This asserts the whole chain in one place: authenticated create →
       persisted linkage → Offer authority derived from it. */
    const seller = await signIn();
    const resolution = await resolveActingAccount(
      { cookieHeader: seller.cookieHeader, now: NOW },
      { db },
    );
    if (resolution.outcome !== "AUTHENTICATED") throw new Error("unreachable");

    const created = await createProductSourceRecordAs(resolution.actor, productRecord(1), { db });
    expect(created.authority.creatorParticipantId).toBe(seller.participantId);

    const row = await db.productSourceRecordVersionRow.findFirstOrThrow({
      where: { internalProductId: created.internalProductId },
    });
    expect(row.authorityCreatorParticipantId).toBe(seller.participantId);
    // The legacy opaque reference is untouched beside it, not replaced.
    expect(row.authorityCreatorId).toBe(created.authority.creatorId);

    const offer = await createDraftOffer(
      {
        internalProductId: created.internalProductId,
        sellerParticipantId: seller.participantId,
        terms: {
          price: { type: "PAID", wholesalePriceMinorUnits: 5_000, wholesalePriceCurrency: "USD" },
          promotion: { type: "NOT_PROMOTABLE" },
        },
        actingAccountId: seller.accountId,
        now: NOW,
      },
      { db },
    );
    expect(offer.record.sellerParticipantId).toBe(seller.participantId);
  });

  it("discards a claimed creatorParticipantId and refuses an account with no participant", async () => {
    const seller = await signIn();
    const victim = await signIn();
    const resolution = await resolveActingAccount(
      { cookieHeader: seller.cookieHeader, now: NOW },
      { db },
    );
    if (resolution.outcome !== "AUTHENTICATED") throw new Error("unreachable");

    /* A caller cannot claim creator authority for someone else by writing it
       onto the record: the participant is resolved from the acting account. */
    const claimed = productRecord(2);
    const created = await createProductSourceRecordAs(
      resolution.actor,
      {
        ...claimed,
        authority: { ...claimed.authority, creatorParticipantId: victim.participantId },
      },
      { db },
    );
    expect(created.authority.creatorParticipantId).toBe(seller.participantId);

    /* An account holding no participant is refused — it is not a marketplace
       participant, so there is no identity for creator authority to name. */
    seq += 1;
    const bare = await createAccount(
      {
        name: "No Participant",
        email: `${EMAIL_PREFIX}${seq}@example.com`,
        password: PASSWORD,
        createdAt: NOW,
      },
      { db },
    );
    const { token } = await createAccountSession(
      { accountId: bare.accountId, createdAt: NOW, ttlSeconds: 3_600 },
      { db },
    );
    const bareResolution = await resolveActingAccount(
      { cookieHeader: `${SESSION_COOKIE_NAME}=${token}`, now: NOW },
      { db },
    );
    if (bareResolution.outcome !== "AUTHENTICATED") throw new Error("unreachable");

    await expect(
      createProductSourceRecordAs(bareResolution.actor, productRecord(3), { db }),
    ).rejects.toBeInstanceOf(ProductCreatorParticipantRequiredError);
  });

  // — 4. A denial discloses nothing —

  it("discloses no governance, standing, or risk detail in a refusal", async () => {
    const victim = await signIn();
    const attacker = await signIn();

    const storefront = await createDraftStorefront(
      {
        ownerParticipantId: victim.participantId,
        publicHandle: `p118-boundary-${(seq += 1)}`,
        presentation: { displayName: "Victim Shop", tagline: null, summary: null },
        actingAccountId: victim.accountId,
        now: NOW,
      },
      { db },
    );

    const resolution = await resolveActingAccount(
      { cookieHeader: attacker.cookieHeader, now: NOW },
      { db },
    );
    if (resolution.outcome !== "AUTHENTICATED") throw new Error("unreachable");

    const error = await submitStorefrontSourceVersion(
      resolution.actor,
      {
        internalStorefrontId: storefront.record.internalStorefrontId,
        sourceRecordVersion: "2",
        presentation: { displayName: "Hijacked", tagline: null, summary: null },
        now: LATER,
      },
      { db },
    ).catch((e) => e);

    /* The reason codes are the closed 0M.1 vocabulary — a classification, never
       a value. Nothing names the owner, the incumbent SUPER_OWNER, a mitigation
       reason, or a risk result. */
    const serialized = JSON.stringify({
      ...(error as StorefrontNotAuthorizedError),
      errorMessage: (error as Error).message,
    });
    for (const leak of [
      victim.accountId,
      victim.participantId,
      "SUPER_OWNER",
      "ADMIN",
      "riskScore",
      "suspension",
      "restriction",
    ]) {
      expect(`leak:${serialized.includes(leak) ? leak : "none"}`).toBe("leak:none");
    }
  });
});
