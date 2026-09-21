/**
 * Phase 1.34, Ruling A — the stable application-facing Product reference.
 *
 * `productRef` is the selector a route, a form action, or a page link names a
 * Product by. It exists because every Product identifier that came before it is
 * something else: `mon:product:` and `mon:srec:` are internal identities,
 * `an:node:` is an AgentNet Node, and the primary key is a primary key. Putting
 * any of them in a URL would publish an internal identity to get a link.
 *
 * What this suite proves, against a real database:
 *
 *   1. every newly created Product receives one, automatically;
 *   2. it is unique across Products, and the database enforces that;
 *   3. it is STABLE — revising the Product does not move it;
 *   4. it is none of the identities around it, structurally;
 *   5. no caller, and no client, has a path to choose one;
 *   6. the account-home projection carries it without carrying anything else;
 *   7. the creation API may return it.
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * NO NETWORK. Every value is synthetic; no real personal data appears. Cleanup
 * is SCOPED to this suite's own `p134ref` email prefix — never a global
 * truncate, which would hit the RESTRICT rules other suites rely on.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createAccountSession } from "../src/server/account/account-session-service";
import { SESSION_COOKIE_NAME } from "../src/server/account/session-cookie";
import { readAccountHome } from "../src/server/account/account-home";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import { createDraftProductAs } from "../src/server/marketplace/marketplace-application-service";
import { resolveActingAccount } from "../src/server/account/acting-participant-boundary";
import { ProductRepository } from "../src/server/product/product-repository";
import { cryptoProductRefProvider } from "../src/server/product/product-ids";
import {
  PRODUCT_DRAFT_ROUTE_ERROR_CODES as CODES,
  handleCreateDraftProductRequest,
} from "../src/server/product/product-draft-route-handler";
import { DraftProductInput } from "../src/contracts/product/product-source-record";
import { PRODUCT_REF_RE } from "../src/contracts/capsule/identity";
import { syntheticProductRef } from "./support/product-ref-fixture";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-09-01T09:00:00.000Z";
const LATER = "2028-09-02T09:00:00.000Z";
const EMAIL_PREFIX = "p134ref";
const ORIGIN = "https://monacado.test";
const PASSWORD = "correct-horse-battery-staple-1134";

let seq = 0;

async function cleanup(): Promise<void> {
  const accountIds = (
    await db.account.findMany({
      where: { email: { startsWith: EMAIL_PREFIX } },
      select: { id: true },
    })
  ).map((a) => a.id);
  if (accountIds.length === 0) return;
  const participantIds = (
    await db.marketplaceParticipant.findMany({
      where: { accountId: { in: accountIds } },
      select: { id: true },
    })
  ).map((p) => p.id);
  const productIds = (
    await db.productSourceRecordVersionRow.findMany({
      where: { authorityCreatorParticipantId: { in: participantIds } },
      select: { internalProductId: true },
    })
  ).map((v) => v.internalProductId);
  await db.productSourceRecordVersionRow.deleteMany({
    where: { internalProductId: { in: productIds } },
  });
  await db.product.deleteMany({ where: { internalProductId: { in: productIds } } });
  await db.marketplaceRoleAssignment.deleteMany({
    where: { participantId: { in: participantIds } },
  });
  await db.marketplaceParticipant.deleteMany({ where: { id: { in: participantIds } } });
  await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

/** A real account with a session and a DRAFT SELLER participant. */
async function signInSeller() {
  seq += 1;
  const account = await createAccount(
    {
      name: "Maker",
      email: `${EMAIL_PREFIX}${seq}@example.com`,
      password: PASSWORD,
      createdAt: NOW,
    },
    { db },
  );
  const participant = await createDraftParticipant(
    { accountId: account.accountId, initialRoles: ["SELLER"], now: NOW },
    { db },
  );
  const { token } = await createAccountSession(
    { accountId: account.accountId, createdAt: NOW, ttlSeconds: 7 * 24 * 3_600 },
    { db },
  );
  const cookieHeader = `${SESSION_COOKIE_NAME}=${token}`;
  /* The acting account is RESOLVED from the session, never asserted: the
     application commands take a branded actor precisely so a test cannot hand
     one an account id it did not authenticate. */
  const resolution = await resolveActingAccount({ cookieHeader, now: NOW }, { db });
  if (resolution.outcome !== "AUTHENTICATED") throw new Error("unreachable");
  return {
    accountId: account.accountId,
    participantId: participant.participant.participantId,
    actor: resolution.actor,
    cookieHeader,
  };
}

const facts = (name: string) => ({
  name,
  description: null,
  promotable: false,
  generalAvailabilityState: "available" as const,
  deliveryMode: "DIGITAL" as const,
});

describe.skipIf(!RUN)("Phase 1.34 Ruling A — the Product application reference", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  // — 1. Every new Product receives one —

  it("1. mints a reference for every newly created Product, with no caller involvement", async () => {
    const seller = await signInSeller();
    const created = await createDraftProductAs(seller.actor, facts("Mug"), { db, now: NOW });

    expect(created.productRef).toMatch(PRODUCT_REF_RE);

    const row = await db.product.findUniqueOrThrow({
      where: { internalProductId: created.record.internalProductId },
      select: { productRef: true },
    });
    expect(row.productRef).toBe(created.productRef);
  });

  // — 2. Unique —

  it("2. gives distinct Products distinct references, and the database refuses a collision", async () => {
    const seller = await signInSeller();
    const a = await createDraftProductAs(seller.actor, facts("One"), { db, now: NOW });
    const b = await createDraftProductAs(seller.actor, facts("Two"), { db, now: NOW });
    expect(a.productRef).not.toBe(b.productRef);

    /* The application draws 160 bits per reference, so a collision is not
       something a test can provoke honestly. What IS worth proving is that the
       database would refuse one if it ever happened — the uniqueness is a
       constraint, not a probability argument. */
    await expect(
      db.product.update({
        where: { internalProductId: b.record.internalProductId },
        data: { productRef: a.productRef },
      }),
    ).rejects.toSatisfy(
      (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002",
    );
  });

  it("2a. draws from a CSPRNG over the repo's alphabet, at 160 bits", async () => {
    const drawn = new Set(Array.from({ length: 200 }, () => cryptoProductRefProvider.nextProductRef()));
    expect(drawn.size).toBe(200);
    for (const ref of drawn) expect(ref).toMatch(PRODUCT_REF_RE);
  });

  // — 3. Stable —

  it("3. does not move when the Product is revised — it is independent of the source version", async () => {
    const seller = await signInSeller();
    const created = await createDraftProductAs(seller.actor, facts("Original"), { db, now: NOW });

    await new ProductRepository(db).createProductSourceRecordRevision({
      internalProductId: created.record.internalProductId,
      expectedCurrentSourceRecordVersion: "1",
      sourceRecordVersion: "2",
      updatedAt: LATER,
      capsuleGeneratedAt: LATER,
      facts: { ...created.record.facts, name: "Renamed" },
    });

    const after = await db.product.findUniqueOrThrow({
      where: { internalProductId: created.record.internalProductId },
      select: { productRef: true, currentSourceRecordVersion: true },
    });
    /* The version pointer moved; the reference did not. A link handed out
       against version 1 still names the same Product at version 2. */
    expect(after.currentSourceRecordVersion).toBe("2");
    expect(after.productRef).toBe(created.productRef);
  });

  // — 4. Not any of the identities around it —

  it("4. is not an internal id, a source-record id, a Node identity, or the primary key", async () => {
    const seller = await signInSeller();
    const created = await createDraftProductAs(seller.actor, facts("Mug"), { db, now: NOW });
    const ref = created.productRef;

    expect(ref).not.toBe(created.record.internalProductId);
    expect(ref).not.toBe(created.record.sourceRecordId);
    /* Structural, not incidental: every identity in the repository carries a
       namespace prefix, and this carries none — so it cannot be read as one
       whatever it is passed to. */
    expect(ref.startsWith("mon:product:")).toBe(false);
    expect(ref.startsWith("mon:srec:")).toBe(false);
    expect(ref.startsWith("mon:")).toBe(false);
    expect(ref.startsWith("an:")).toBe(false);
    expect(ref).not.toContain(":");

    /* Not a ProductNode identity either — and the Product has no Node at all. */
    expect(
      await db.productNode.count({ where: { internalProductId: created.record.internalProductId } }),
    ).toBe(0);
    expect(await db.productNode.count({ where: { nodeId: ref } })).toBe(0);

    /* It carries no business semantics: nothing of the name survives in it. */
    expect(ref.toUpperCase()).not.toContain("MUG");
  });

  // — 5. No client path —

  it("5. cannot be supplied by a client through the draft route", async () => {
    const seller = await signInSeller();
    const result = await handleCreateDraftProductRequest(
      {
        contentType: "application/json",
        originHeader: ORIGIN,
        cookieHeader: seller.cookieHeader,
        rawBody: JSON.stringify({ ...facts("Mug"), productRef: syntheticProductRef() }),
      },
      { db, now: () => NOW, appOrigin: ORIGIN },
    );
    /* `DraftProductInput` is a strict object, so an unknown key is refused
        rather than ignored. A silently dropped field would look identical to a
        client that had successfully chosen a reference. */
    expect(result).toMatchObject({ status: 400, body: { error: CODES.invalidRequest } });
    expect(DraftProductInput.safeParse({ ...facts("Mug"), productRef: "X" }).success).toBe(false);
  });

  it("5a. cannot be supplied through the application command either", async () => {
    const seller = await signInSeller();
    /* There is no member to supply, which is the control — not a rule that
       discards one. The cast exists only so the attempt compiles. */
    await expect(
      createDraftProductAs(
        seller.actor,
        { ...facts("Mug"), productRef: syntheticProductRef() } as unknown,
        { db, now: NOW },
      ),
    ).rejects.toMatchObject({ name: "ValidationError" });
  });

  // — 6. The account-home projection —

  it("6. is carried by the account-home projection, and nothing else is", async () => {
    const seller = await signInSeller();
    const a = await createDraftProductAs(seller.actor, facts("First"), { db, now: NOW });
    const b = await createDraftProductAs(seller.actor, facts("Second"), { db, now: NOW });

    const home = await readAccountHome(seller.accountId, { db });
    expect(home!.products.map((p) => p.productRef)).toEqual([a.productRef, b.productRef]);

    /* The reference travels; no internal identity does. */
    const serialized = JSON.stringify(home);
    expect(serialized).not.toMatch(/mon:|an:node/);
    expect(serialized).not.toContain(a.record.internalProductId);
    expect(serialized).not.toContain(a.record.sourceRecordId);
  });

  // — 7. Returned by the creation API —

  it("7. is returned by the creation route, so a page can act on what it just made", async () => {
    const seller = await signInSeller();
    const result = await handleCreateDraftProductRequest(
      {
        contentType: "application/json",
        originHeader: ORIGIN,
        cookieHeader: seller.cookieHeader,
        rawBody: JSON.stringify(facts("Mug")),
      },
      { db, now: () => NOW, appOrigin: ORIGIN },
    );
    expect(result.status).toBe(201);
    const returned = (result.body as { productRef?: unknown }).productRef;
    expect(returned).toMatch(PRODUCT_REF_RE);

    const row = await db.product.findFirstOrThrow({
      where: { productRef: returned as string },
      select: { internalProductId: true },
    });
    /* It resolves back to exactly one Product — which is the whole job. */
    expect(row.internalProductId).toMatch(/^mon:product:/);
  });
});
