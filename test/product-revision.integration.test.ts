/**
 * Phase 1.38 — Seller Product revision and completeness, against a real
 * database.
 *
 * Proves the route and `reviseProductAs` together: a Seller revises their own
 * Product by its stable reference; the revision writes exactly ONE new
 * immutable source version, advances the current pointer exactly once, leaves
 * every earlier version byte-for-byte unchanged, and never moves `productRef`;
 * another Seller's Product and an unknown reference are one 404; refused and
 * unchanged revisions write nothing; the Seller shipping policy is stored on the
 * new version (FREE, FIXED in minor units), cleared when the Product stops being
 * shipped, and never invented; completeness is evaluated from the current
 * version; and no Offer, Listing, Order, Node, publication, or outbox state
 * appears.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createAccountSession } from "../src/server/account/account-session-service";
import { SESSION_COOKIE_NAME } from "../src/server/account/session-cookie";
import { readAccountHome } from "../src/server/account/account-home";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import { handleCreateDraftProductRequest } from "../src/server/product/product-draft-route-handler";
import {
  PRODUCT_REVISION_ROUTE_ERROR_CODES as CODES,
  handleReviseProductRequest,
} from "../src/server/product/product-revision-route-handler";
import { readCurrentProductCompleteness } from "../src/server/product/product-completeness-service";
import { productRevisionToken } from "../src/server/product/product-revision-token";
import type { MarketplaceRole } from "../src/contracts/marketplace/participant";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-09-01T09:00:00.000Z";
const LATER = "2028-09-02T09:00:00.000Z";
const EMAIL_PREFIX = "p138revise";
const ORIGIN = "https://monacado.test";
const UNKNOWN_REF = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

let seq = 0;

async function cleanup(): Promise<void> {
  const accountIds = (
    await db.account.findMany({ where: { email: { startsWith: EMAIL_PREFIX } }, select: { id: true } })
  ).map((a) => a.id);
  if (accountIds.length === 0) return;
  const participantIds = (
    await db.marketplaceParticipant.findMany({ where: { accountId: { in: accountIds } }, select: { id: true } })
  ).map((p) => p.id);
  const productIds = (
    await db.productSourceRecordVersionRow.findMany({
      where: { authorityCreatorParticipantId: { in: participantIds } },
      select: { internalProductId: true },
    })
  ).map((v) => v.internalProductId);
  await db.productSourceRecordVersionRow.deleteMany({ where: { internalProductId: { in: productIds } } });
  await db.product.deleteMany({ where: { internalProductId: { in: productIds } } });
  await db.marketplaceRoleAssignment.deleteMany({ where: { participantId: { in: participantIds } } });
  await db.marketplaceParticipant.deleteMany({ where: { id: { in: participantIds } } });
  await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

async function signIn(roles: MarketplaceRole[] | null) {
  seq += 1;
  const account = await createAccount(
    { name: "Maker", email: `${EMAIL_PREFIX}${seq}@example.com`, password: "correct horse battery staple", createdAt: NOW },
    { db },
  );
  const participant =
    roles === null
      ? null
      : await createDraftParticipant({ accountId: account.accountId, initialRoles: roles, now: NOW }, { db });
  const { token } = await createAccountSession(
    { accountId: account.accountId, createdAt: NOW, ttlSeconds: 7 * 24 * 3_600 },
    { db },
  );
  return {
    accountId: account.accountId,
    participantId: participant?.participant.participantId ?? null,
    cookieHeader: `${SESSION_COOKIE_NAME}=${token}`,
  };
}

/** Draft a Product through the real route; returns its stable reference and internal id. */
async function draft(cookieHeader: string, overrides: Record<string, unknown> = {}) {
  const result = await handleCreateDraftProductRequest(
    {
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader,
      rawBody: JSON.stringify({
        name: "Hand-thrown mug",
        description: null,
        promotable: true,
        generalAvailabilityState: "available",
        deliveryMode: "PHYSICAL",
        ...overrides,
      }),
    },
    { db, now: () => NOW, appOrigin: ORIGIN },
  );
  expect(result.status).toBe(201);
  const productRef = result.body.productRef as string;
  const row = await db.product.findUniqueOrThrow({ where: { productRef } });
  return { productRef, internalProductId: row.internalProductId };
}

const BODY = {
  name: "Hand-thrown mug",
  description: "Stoneware, 350 ml.",
  deliveryMode: "PHYSICAL",
  shippingPolicy: { method: "FREE" },
};

/** The revision token of the Product's current state — what a freshly loaded page holds. */
async function currentToken(productRef: string): Promise<string> {
  const row = await db.product.findUnique({ where: { productRef } });
  return row === null
    ? "0123456789abcdef0123456789abcdef"
    : productRevisionToken(row.sourceRecordId, row.currentSourceRecordVersion);
}

let clock = 0;
/**
 * Revise as a page that has just loaded the current state: `expectedRevision` is
 * filled with the current token unless the body states one (stale-tab cases).
 */
async function revise(cookieHeader: string | null, productRef: string, body: unknown) {
  clock += 1;
  if (typeof body === "object" && body !== null && !("expectedRevision" in body)) {
    body = { expectedRevision: await currentToken(productRef), ...body };
  }
  return await handleReviseProductRequest(
    {
      productRef,
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader,
      rawBody: typeof body === "string" ? body : JSON.stringify(body),
    },
    { db, now: () => new Date(Date.parse(LATER) + clock * 1_000).toISOString(), appOrigin: ORIGIN },
  );
}

const versionsOf = (internalProductId: string) =>
  db.productSourceRecordVersionRow.findMany({ where: { internalProductId }, orderBy: { seq: "asc" } });
const stableOf = (internalProductId: string) =>
  db.product.findUniqueOrThrow({ where: { internalProductId } });

const describeDb = RUN ? describe : describe.skip;

describeDb("1.38 — Seller Product revision and completeness", () => {
  beforeEach(async () => {
    await cleanup();
  });

  afterAll(async () => {
    if (!RUN) return;
    await cleanup();
    await disconnectPrisma();
  });

  it("revises the Seller's own Product: one new immutable version, pointer advanced once, prior version untouched, productRef stable", async () => {
    const seller = await signIn(["SELLER"]);
    const { productRef, internalProductId } = await draft(seller.cookieHeader);
    const [v1Before] = await versionsOf(internalProductId);

    const result = await revise(seller.cookieHeader, productRef, BODY);

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      productRef,
      /* The new state's token — not the label, not an id. */
      revision: productRevisionToken((await stableOf(internalProductId)).sourceRecordId, "2"),
      name: "Hand-thrown mug",
      description: "Stoneware, 350 ml.",
      deliveryMode: "PHYSICAL",
      shippingPolicy: { method: "FREE" },
      completeness: { profile: "PRODUCT_COMPLETENESS_V1", complete: true, missing: [] },
    });
    const text = JSON.stringify(result.body);
    expect(text).not.toContain("mon:");
    expect(text).not.toContain("an:node");

    const versions = await versionsOf(internalProductId);
    expect(versions.map((v) => v.sourceRecordVersion)).toEqual(["1", "2"]);
    expect(versions[0]).toEqual(v1Before); // the historical row, unchanged in every column
    expect(versions[0]!.factDescription).toBeNull();
    expect(versions[0]!.shippingPolicyMethod).toBeNull();

    const v2 = versions[1]!;
    expect(v2.factDescription).toBe("Stoneware, 350 ml.");
    expect(v2.shippingPolicyMethod).toBe("FREE");
    expect(v2.shippingFixedChargeMinorUnits).toBeNull();
    expect(v2.shippingFixedChargeCurrency).toBeNull();
    // Carried forward, not reachable by the Seller:
    expect(v2.factPromotable).toBe(v1Before!.factPromotable);
    expect(v2.factGeneralAvailabilityState).toBe(v1Before!.factGeneralAvailabilityState);
    expect(v2.factProductVersion).toBe(v1Before!.factProductVersion);
    expect(v2.taxClassification).toBe(v1Before!.taxClassification);
    expect(v2.recordStatus).toBe(v1Before!.recordStatus);
    expect(v2.authorityCreatorParticipantId).toBe(seller.participantId);

    const stable = await stableOf(internalProductId);
    expect(stable.currentSourceRecordVersion).toBe("2");
    expect(stable.productRef).toBe(productRef);

    expect(await readCurrentProductCompleteness(db, internalProductId)).toEqual({
      profile: "PRODUCT_COMPLETENESS_V1",
      complete: true,
      missing: [],
    });
  });

  it("a freshly drafted PHYSICAL Product without description or shipping policy is incomplete — missing policy is not FREE", async () => {
    const seller = await signIn(["SELLER"]);
    const { internalProductId } = await draft(seller.cookieHeader);
    expect(await readCurrentProductCompleteness(db, internalProductId)).toEqual({
      profile: "PRODUCT_COMPLETENESS_V1",
      complete: false,
      missing: ["DESCRIPTION_MISSING", "SHIPPING_POLICY_MISSING"],
    });
  });

  it("allows an incomplete revision and reports what is still missing", async () => {
    const seller = await signIn(["SELLER"]);
    const { productRef, internalProductId } = await draft(seller.cookieHeader);

    const result = await revise(seller.cookieHeader, productRef, { ...BODY, shippingPolicy: null, name: "Mug v2" });

    expect(result.status).toBe(200);
    expect(result.body.shippingPolicy).toBeNull();
    expect(result.body.completeness).toEqual({
      profile: "PRODUCT_COMPLETENESS_V1",
      complete: false,
      missing: ["SHIPPING_POLICY_MISSING"],
    });
    expect((await versionsOf(internalProductId))[1]!.shippingPolicyMethod).toBeNull();
  });

  it("stores a FIXED charge in integer minor units, and the answer reports minor units", async () => {
    const seller = await signIn(["SELLER"]);
    const { productRef, internalProductId } = await draft(seller.cookieHeader);

    const result = await revise(seller.cookieHeader, productRef, {
      ...BODY,
      shippingPolicy: { method: "FIXED", amount: "4.50", currency: "USD" },
    });

    expect(result.status).toBe(200);
    expect(result.body.shippingPolicy).toEqual({ method: "FIXED", amountMinorUnits: 450, currency: "USD" });
    expect((result.body.completeness as { complete: boolean }).complete).toBe(true);
    const v2 = (await versionsOf(internalProductId))[1]!;
    expect(v2.shippingPolicyMethod).toBe("FIXED");
    expect(v2.shippingFixedChargeMinorUnits).toBe(450n);
    expect(v2.shippingFixedChargeCurrency).toBe("USD");
  });

  it("switching PHYSICAL → DIGITAL writes a version with no shipping policy and keeps the old one in history", async () => {
    const seller = await signIn(["SELLER"]);
    const { productRef, internalProductId } = await draft(seller.cookieHeader);
    expect((await revise(seller.cookieHeader, productRef, BODY)).status).toBe(200);

    const result = await revise(seller.cookieHeader, productRef, {
      ...BODY,
      deliveryMode: "DIGITAL",
      shippingPolicy: null,
    });

    expect(result.status).toBe(200);
    expect(result.body.shippingPolicy).toBeNull();
    expect((result.body.completeness as { complete: boolean }).complete).toBe(true);
    const versions = await versionsOf(internalProductId);
    expect(versions.map((v) => [v.sourceRecordVersion, v.factDeliveryMode, v.shippingPolicyMethod])).toEqual([
      ["1", "PHYSICAL", null],
      ["2", "PHYSICAL", "FREE"],
      ["3", "DIGITAL", null],
    ]);

    /* And back to PHYSICAL without a policy: incomplete — nothing re-invents FREE. */
    const back = await revise(seller.cookieHeader, productRef, { ...BODY, shippingPolicy: null });
    expect(back.body.completeness).toMatchObject({ complete: false, missing: ["SHIPPING_POLICY_MISSING"] });
  });

  it("refuses a shipping policy for a DIGITAL Product, an unsupported method, and a zero or malformed charge — writing nothing", async () => {
    const seller = await signIn(["SELLER"]);
    const { productRef, internalProductId } = await draft(seller.cookieHeader);

    const cases: Array<[unknown, number, string]> = [
      [{ ...BODY, deliveryMode: "DIGITAL" }, 400, CODES.shippingPolicyNotApplicable],
      [{ ...BODY, shippingPolicy: { method: "CALCULATED" } }, 400, CODES.unsupportedShippingPolicy],
      [{ ...BODY, shippingPolicy: { method: "FIXED", amount: "0", currency: "USD" } }, 400, CODES.invalidShippingCharge],
      [{ ...BODY, shippingPolicy: { method: "FIXED", amount: "4.50", currency: "EUR" } }, 400, CODES.invalidShippingCharge],
      [{ ...BODY, shippingPolicy: { method: "FIXED", currency: "USD" } }, 400, CODES.invalidRequest],
      [{ ...BODY, name: "   " }, 400, CODES.invalidRequest],
      [{ ...BODY, deliveryMode: "SERVICE", shippingPolicy: null }, 400, CODES.invalidRequest],
      [{ ...BODY, taxClassification: "PHYSICAL_GOOD" }, 400, CODES.invalidRequest],
      [{ ...BODY, sourceRecordVersion: "9" }, 400, CODES.invalidRequest],
      ["not json", 400, CODES.invalidRequest],
    ];
    for (const [body, status, code] of cases) {
      const result = await revise(seller.cookieHeader, productRef, body);
      expect([result.status, result.body]).toEqual([status, { error: code }]);
    }
    expect(await versionsOf(internalProductId)).toHaveLength(1);
    expect((await stableOf(internalProductId)).currentSourceRecordVersion).toBe("1");
  });

  it("two tabs: the stale tab is refused with 409 — no version written, pointer not advanced, newer changes kept", async () => {
    const seller = await signIn(["SELLER"]);
    const { productRef, internalProductId } = await draft(seller.cookieHeader);
    const loaded = await currentToken(productRef); // both tabs load the same state

    const tabA = await revise(seller.cookieHeader, productRef, { ...BODY, expectedRevision: loaded });
    expect(tabA.status).toBe(200);
    const afterA = tabA.body.revision as string;
    expect(afterA).toMatch(/^[0-9a-f]{32}$/);
    expect(afterA).not.toBe(loaded);
    expect(afterA).toBe(await currentToken(productRef));

    const tabB = await revise(seller.cookieHeader, productRef, {
      ...BODY,
      description: "Tab B's stale description",
      expectedRevision: loaded,
    });

    expect([tabB.status, tabB.body]).toEqual([409, { error: CODES.conflict }]);
    const versions = await versionsOf(internalProductId);
    expect(versions.map((v) => v.sourceRecordVersion)).toEqual(["1", "2"]);
    expect(versions[1]!.factDescription).toBe("Stoneware, 350 ml."); // A's change survives
    expect((await stableOf(internalProductId)).currentSourceRecordVersion).toBe("2");

    /* With the token the server returned, the same form saves again. */
    const next = await revise(seller.cookieHeader, productRef, {
      ...BODY,
      name: "Mug, second edit",
      expectedRevision: afterA,
    });
    expect(next.status).toBe(200);
    expect(next.body.revision).toBe(await currentToken(productRef));
  });

  it("a stale token is refused before 'unchanged', and a malformed token is a 400 — neither writes", async () => {
    const seller = await signIn(["SELLER"]);
    const { productRef, internalProductId } = await draft(seller.cookieHeader);
    const loaded = await currentToken(productRef);
    expect((await revise(seller.cookieHeader, productRef, BODY)).status).toBe(200);

    // Restating exactly the current content from a stale state is a conflict, not "unchanged".
    const stale = await revise(seller.cookieHeader, productRef, { ...BODY, expectedRevision: loaded });
    expect([stale.status, stale.body]).toEqual([409, { error: CODES.conflict }]);

    for (const expectedRevision of ["2", "not-a-token", ""]) {
      const bad = await revise(seller.cookieHeader, productRef, { ...BODY, name: "Other", expectedRevision });
      expect([bad.status, bad.body]).toEqual([400, { error: CODES.invalidRequest }]);
    }
    const missing = await handleReviseProductRequest(
      {
        productRef,
        contentType: "application/json",
        originHeader: ORIGIN,
        cookieHeader: seller.cookieHeader,
        rawBody: JSON.stringify(BODY),
      },
      { db, now: () => LATER, appOrigin: ORIGIN },
    );
    expect([missing.status, missing.body]).toEqual([400, { error: CODES.invalidRequest }]);
    expect(await versionsOf(internalProductId)).toHaveLength(2);
  });

  it("refuses an unchanged restatement without writing a version", async () => {
    const seller = await signIn(["SELLER"]);
    const { productRef, internalProductId } = await draft(seller.cookieHeader);
    expect((await revise(seller.cookieHeader, productRef, BODY)).status).toBe(200);

    const again = await revise(seller.cookieHeader, productRef, { ...BODY, name: "  Hand-thrown mug " });

    expect([again.status, again.body]).toEqual([409, { error: CODES.unchanged }]);
    expect(await versionsOf(internalProductId)).toHaveLength(2);
  });

  it("another Seller's Product, an unknown reference, and a malformed reference are one 404; signed-out is 401", async () => {
    const owner = await signIn(["SELLER"]);
    const other = await signIn(["SELLER"]);
    const promoter = await signIn(["PROMOTER"]);
    const { productRef, internalProductId } = await draft(owner.cookieHeader);

    for (const [cookie, ref] of [
      [other.cookieHeader, productRef],
      [promoter.cookieHeader, productRef],
      [owner.cookieHeader, UNKNOWN_REF],
      [owner.cookieHeader, "mon:product:nope"],
    ] as const) {
      const result = await revise(cookie, ref, BODY);
      expect([result.status, result.body]).toEqual([404, { error: CODES.notAvailable }]);
    }
    const signedOut = await revise(null, productRef, BODY);
    expect([signedOut.status, signedOut.body]).toEqual([401, { error: CODES.unauthenticated }]);

    expect(await versionsOf(internalProductId)).toHaveLength(1);
  });

  it("does not require a Storefront and creates no Offer, Listing, Order, Node, publication, or outbox state", async () => {
    const seller = await signIn(["SELLER"]);
    const { productRef, internalProductId } = await draft(seller.cookieHeader);
    expect(await db.storefront.count({ where: { ownerParticipantId: seller.participantId! } })).toBe(0);

    expect((await revise(seller.cookieHeader, productRef, BODY)).status).toBe(200);

    expect(await db.offer.count({ where: { internalProductId } })).toBe(0);
    expect(await db.listing.count({ where: { internalProductId } })).toBe(0);
    expect(await db.order.count({ where: { internalProductId } })).toBe(0);
    expect(await db.productNode.count({ where: { internalProductId } })).toBe(0);
    expect(await db.productPublication.count({ where: { internalProductId } })).toBe(0);
  });

  it("the account page shows completeness and the shipping policy from the current version", async () => {
    const seller = await signIn(["SELLER"]);
    const { productRef } = await draft(seller.cookieHeader);
    await draft(seller.cookieHeader, { name: "Field guide", description: "A PDF.", deliveryMode: "DIGITAL" });
    expect(
      (
        await revise(seller.cookieHeader, productRef, {
          ...BODY,
          shippingPolicy: { method: "FIXED", amount: "12", currency: "USD" },
        })
      ).status,
    ).toBe(200);

    const home = await readAccountHome(seller.accountId, { db });
    expect(home!.products[0]!.revisionToken).toBe(await currentToken(productRef));
    expect(
      home!.products.map((p) => ({ name: p.name, shippingPolicy: p.shippingPolicy, completeness: p.completeness })),
    ).toEqual([
      {
        name: "Hand-thrown mug",
        shippingPolicy: { method: "FIXED", amountMinorUnits: 1200, currency: "USD" },
        completeness: { complete: true, missing: [] },
      },
      { name: "Field guide", shippingPolicy: null, completeness: { complete: true, missing: [] } },
    ]);
  });
});
