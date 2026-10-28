/**
 * Phase 1.43 — mName issuance, against a real database.
 *
 *   - ISSUED AT CREATION, ONCE: both participant-creating paths write the row
 *     with its mName; extending setup, or any later act, leaves it alone; a
 *     Seller + Promoter participant has one mName.
 *   - NEVER DERIVED: identical declared names, `Account.name`, and email
 *     prefixes still draw unrelated mNames; the draw is handed only a length.
 *   - COLLISIONS: a committed collision is redrawn inside the transaction; an
 *     uncommitted one (two transactions, one candidate) loses at the unique
 *     index and the transaction reruns; exhaustion fails closed and writes
 *     nothing.
 *   - CONCURRENCY: heavy parallel onboarding, including over a deliberately
 *     tiny candidate pool, yields one distinct valid mName per participant.
 *   - IMMUTABLE: no participant route accepts one; the database refuses a
 *     duplicate in any case.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createAccountSession } from "../src/server/account/account-session-service";
import { SESSION_COOKIE_NAME } from "../src/server/account/session-cookie";
import { beginParticipantOnboarding, createDraftParticipant } from "../src/server/marketplace/participant-service";
import { handleBeginOnboardingRequest } from "../src/server/marketplace/participant-onboarding-route-handler";
import {
  cryptoMarketplaceNameProvider,
  type MarketplaceNameProvider,
} from "../src/server/marketplace/marketplace-name-service";
import { MARKETPLACE_NAME_RE } from "../src/contracts/marketplace/marketplace-name";
import { ParticipantPersistenceFailureError } from "../src/server/marketplace/participant-errors";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2029-07-01T09:00:00.000Z";
const EMAIL_PREFIX = "p143mname";
const ORIGIN = "https://monacado.test";
let seq = 0;

async function cleanup(): Promise<void> {
  const accountIds = (
    await db.account.findMany({ where: { email: { startsWith: EMAIL_PREFIX } }, select: { id: true } })
  ).map((a) => a.id);
  if (accountIds.length === 0) return;
  const participantIds = (
    await db.marketplaceParticipant.findMany({ where: { accountId: { in: accountIds } }, select: { id: true } })
  ).map((p) => p.id);
  await db.marketplaceRoleAssignment.deleteMany({ where: { participantId: { in: participantIds } } });
  await db.marketplaceParticipant.deleteMany({ where: { id: { in: participantIds } } });
  await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

/** Every account gets the SAME declared and display names — only the email differs. */
async function account(): Promise<string> {
  seq += 1;
  const created = await createAccount(
    {
      name: "Same Display",
      firstName: "Same",
      lastName: "Person",
      email: `${EMAIL_PREFIX}${seq}@example.com`,
      password: "correct horse battery staple",
      createdAt: NOW,
    },
    { db },
  );
  return created.accountId;
}

const mNameOf = async (participantId: string) =>
  (await db.marketplaceParticipant.findUniqueOrThrow({ where: { id: participantId } })).marketplaceName;

/** A draw that serves `script` first, recording every requested length, then falls back to crypto. */
function scripted(script: string[]): MarketplaceNameProvider & { lengths: number[] } {
  const queue = [...script];
  const lengths: number[] = [];
  return {
    lengths,
    nextCandidate(length: number) {
      lengths.push(length);
      return queue.shift() ?? cryptoMarketplaceNameProvider.nextCandidate(length);
    },
  };
}

const describeDb = RUN ? describe : describe.skip;

describeDb("Phase 1.43 — mName issuance", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  it("createDraftParticipant creates the row WITH an mName of the issued shape, at the first stage length", async () => {
    const snapshot = await createDraftParticipant({ accountId: await account(), initialRoles: ["SELLER"], now: NOW }, { db });
    expect(snapshot.participant.marketplaceName).toMatch(MARKETPLACE_NAME_RE);
    expect(snapshot.participant.marketplaceName).toHaveLength(4);
    expect(await mNameOf(snapshot.participant.participantId)).toBe(snapshot.participant.marketplaceName);
  });

  it("onboarding creates it once; adding the other role keeps it — one participant, one mName, both roles", async () => {
    const accountId = await account();
    const first = await beginParticipantOnboarding({ accountId, roles: ["SELLER"], now: NOW }, { db });
    const issued = first.participant.marketplaceName;
    expect(issued).toMatch(MARKETPLACE_NAME_RE);
    const second = await beginParticipantOnboarding({ accountId, roles: ["PROMOTER"], now: NOW }, { db });
    expect(second.participant.participantId).toBe(first.participant.participantId);
    expect(second.participant.marketplaceName).toBe(issued);
    expect(second.roles.map((r) => r.role).sort()).toEqual(["PROMOTER", "SELLER"]);
    expect(await db.marketplaceParticipant.count({ where: { accountId } })).toBe(1);
  });

  it("is never derived: identical names draw unrelated mNames, and the draw is handed a length and nothing else", async () => {
    const draw = scripted([]);
    const names = new Set<string | null>();
    for (let i = 0; i < 5; i += 1) {
      const s = await createDraftParticipant({ accountId: await account(), initialRoles: ["PROMOTER"], now: NOW }, { db, mNames: draw });
      names.add(s.participant.marketplaceName);
    }
    expect(names.size).toBe(5);
    expect(draw.lengths.every((l) => l === 4)).toBe(true);
    for (const name of names) expect(name).not.toMatch(/same|person|display|p143/i);
  });

  it("a candidate already issued (committed) is redrawn inside the transaction", async () => {
    const taken = (await createDraftParticipant({ accountId: await account(), initialRoles: ["SELLER"], now: NOW }, { db }))
      .participant.marketplaceName!;
    const draw = scripted([taken, taken, "q7q7"]);
    const s = await createDraftParticipant({ accountId: await account(), initialRoles: ["SELLER"], now: NOW }, { db, mNames: draw });
    expect(s.participant.marketplaceName).toBe("q7q7");
    expect(draw.lengths).toEqual([4, 4, 4]);
  });

  it("exhausting the draws fails closed and creates nothing", async () => {
    const taken = (await createDraftParticipant({ accountId: await account(), initialRoles: ["SELLER"], now: NOW }, { db }))
      .participant.marketplaceName!;
    const accountId = await account();
    const always: MarketplaceNameProvider = { nextCandidate: () => taken };
    await expect(
      createDraftParticipant({ accountId, initialRoles: ["SELLER"], now: NOW }, { db, mNames: always }),
    ).rejects.toBeInstanceOf(ParticipantPersistenceFailureError);
    expect(await db.marketplaceParticipant.count({ where: { accountId } })).toBe(0);
  });

  it("concurrent transactions drawing the SAME untaken candidate: exactly one keeps it, every other reruns and succeeds", async () => {
    const accounts = await Promise.all(Array.from({ length: 8 }, () => account()));
    const results = await Promise.all(
      accounts.map((accountId) =>
        beginParticipantOnboarding({ accountId, roles: ["PROMOTER"], now: NOW }, { db, mNames: scripted(["z9z9"]) }),
      ),
    );
    const names = results.map((r) => r.participant.marketplaceName);
    expect(names.filter((n) => n === "z9z9")).toHaveLength(1);
    expect(new Set(names).size).toBe(8);
    for (const n of names) expect(n).toMatch(MARKETPLACE_NAME_RE);
  });

  it("a candidate held by an UNCOMMITTED transaction: the pre-check cannot see it, the insert loses at the index, and the whole transaction reruns", async () => {
    const holderAccount = await account();
    const racerAccount = await account();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    let inserted!: () => void;
    const holding = new Promise<void>((resolve) => (inserted = resolve));
    const holder = db.$transaction(
      async (tx) => {
        await tx.marketplaceParticipant.create({
          data: { id: `mon:mpart:P143HOLD${seq}`.padEnd(36, "0"), accountId: holderAccount, status: "DRAFT", marketplaceName: "w8w8" },
        });
        inserted();
        await released;
      },
      { timeout: 20_000 },
    );
    await holding;
    const draw = scripted(["w8w8"]);
    const racer = beginParticipantOnboarding({ accountId: racerAccount, roles: ["SELLER"], now: NOW }, { db, mNames: draw });
    // Let the racer reach its INSERT and block on the holder's index lock.
    await new Promise((resolve) => setTimeout(resolve, 750));
    release();
    await holder;
    const result = await racer;
    expect(result.participant.marketplaceName).not.toBe("w8w8");
    expect(result.participant.marketplaceName).toMatch(MARKETPLACE_NAME_RE);
    /* Two transactions' worth of draws: "w8w8" passed the first pre-check (the
       holder had not committed) and lost at the index; the rerun drew again. */
    expect(draw.lengths.length).toBeGreaterThanOrEqual(2);
    expect(await mNameOf(`mon:mpart:P143HOLD${seq}`.padEnd(36, "0"))).toBe("w8w8");
  });

  it("heavy concurrency over a tiny candidate pool: every participant gets one distinct valid mName", async () => {
    const pool = Array.from({ length: 60 }, (_, i) => `k${"23456789abcdefghjkmnpqrstvwxyz"[i % 30]}${i < 30 ? "2" : "3"}x`);
    const fromPool: MarketplaceNameProvider = {
      nextCandidate: (length) =>
        length === 4 ? pool[Math.floor(Math.random() * pool.length)]! : cryptoMarketplaceNameProvider.nextCandidate(length),
    };
    const accounts = await Promise.all(Array.from({ length: 40 }, () => account()));
    const results = await Promise.all(
      accounts.map((accountId) => beginParticipantOnboarding({ accountId, roles: ["SELLER"], now: NOW }, { db, mNames: fromPool })),
    );
    const names = results.map((r) => r.participant.marketplaceName!);
    expect(new Set(names).size).toBe(40);
    for (const n of names) expect(n).toMatch(MARKETPLACE_NAME_RE);
    const stored = await db.marketplaceParticipant.findMany({
      where: { accountId: { in: accounts } },
      select: { marketplaceName: true },
    });
    expect(new Set(stored.map((s) => s.marketplaceName)).size).toBe(40);
  });

  it("heavy concurrency with the real draw: 50 parallel onboardings, 50 distinct mNames", async () => {
    const accounts = await Promise.all(Array.from({ length: 50 }, () => account()));
    const results = await Promise.all(
      accounts.map((accountId) => beginParticipantOnboarding({ accountId, roles: ["SELLER", "PROMOTER"], now: NOW }, { db })),
    );
    expect(new Set(results.map((r) => r.participant.marketplaceName)).size).toBe(50);
  });

  it("the database refuses a duplicate mName in any letter case; any number of rows may have none", async () => {
    const a = await createDraftParticipant({ accountId: await account(), initialRoles: ["SELLER"], now: NOW }, { db });
    const b = await createDraftParticipant({ accountId: await account(), initialRoles: ["SELLER"], now: NOW }, { db });
    await expect(
      db.marketplaceParticipant.update({
        where: { id: b.participant.participantId },
        data: { marketplaceName: a.participant.marketplaceName!.toUpperCase() },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await db.marketplaceParticipant.updateMany({
      where: { id: { in: [a.participant.participantId, b.participant.participantId] } },
      data: { marketplaceName: null },
    });
    expect(await mNameOf(a.participant.participantId)).toBeNull();
  });

  it("no participant route accepts an mName: the onboarding body is strict, and onboarding never changes one", async () => {
    const accountId = await account();
    const { token } = await createAccountSession({ accountId, createdAt: NOW, ttlSeconds: 3_600 }, { db });
    const call = (body: Record<string, unknown>) =>
      handleBeginOnboardingRequest(
        {
          contentType: "application/json",
          originHeader: ORIGIN,
          cookieHeader: `${SESSION_COOKIE_NAME}=${token}`,
          rawBody: JSON.stringify(body),
        },
        { db, now: () => NOW, appOrigin: ORIGIN },
      );
    expect((await call({ roles: ["SELLER"] })).status).toBe(200);
    const participant = await db.marketplaceParticipant.findUniqueOrThrow({ where: { accountId } });
    const issued = participant.marketplaceName;
    for (const extra of [{ marketplaceName: "m7kx" }, { mName: "m7kx" }]) {
      expect((await call({ roles: ["PROMOTER"], ...extra })).status).toBe(400);
    }
    expect((await call({ roles: ["PROMOTER"] })).status).toBe(200);
    expect(await mNameOf(participant.id)).toBe(issued);
  });
});
