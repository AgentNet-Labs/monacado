/**
 * Phase 1.40 — Seller-controlled Product resale availability, against a real
 * database.
 *
 * Proves the route, `setProductResaleAvailabilityAs`, the read model, and the
 * resale-effectiveness reader together:
 *
 *   - every Product starts NOT_OFFERED, with no act recorded;
 *   - only the authoring Seller may change it — another Seller, a Monacado
 *     operator with internal grants, and an unknown reference get one 404;
 *   - AVAILABLE may be set only while the effective lifecycle is ACTIVE;
 *   - a preserved AVAILABLE survives every lifecycle change (COMPLETE,
 *     INCOMPLETE, SUSPENDED) untouched, is ineffective meanwhile, and is
 *     effective again when the Product is ACTIVE again;
 *   - PAUSED and WITHDRAWN follow only the governed transitions; nothing leaves
 *     WITHDRAWN;
 *   - a no-op writes nothing; concurrent requests leave one linear history;
 *   - the legacy `promotable` fact and `generalAvailabilityState` govern nothing;
 *   - no Storefront, Listing, Offer, or Promotion Authorization is required, and
 *     no Order, payment, payout, publication, version, or lifecycle row is written.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createAccountSession } from "../src/server/account/account-session-service";
import { grantAccountEntitlement } from "../src/server/account/account-entitlement-service";
import { SESSION_COOKIE_NAME } from "../src/server/account/session-cookie";
import { readAccountHome } from "../src/server/account/account-home";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import {
  recordObservedProviderState,
  registerParticipantPaymentAccount,
} from "../src/server/marketplace/payment-account-service";
import { recordCommerceApproval } from "../src/server/marketplace/participant-commerce-approval-service";
import {
  reinstateProduct,
  suspendProduct,
} from "../src/server/marketplace/product-suspension-service";
import { handleCreateDraftProductRequest } from "../src/server/product/product-draft-route-handler";
import { handleReviseProductRequest } from "../src/server/product/product-revision-route-handler";
import { handleActivateProductRequest } from "../src/server/product/product-activation-route-handler";
import { handleClassifyProductTaxRequest } from "../src/server/product/product-tax-classification-route-handler";
import {
  PRODUCT_RESALE_AVAILABILITY_ROUTE_ERROR_CODES as CODES,
  handleSetProductResaleAvailabilityRequest,
} from "../src/server/product/product-resale-availability-route-handler";
import { readProductResaleEffectivenessIn } from "../src/server/product/product-resale-availability-service";
import { productRevisionToken } from "../src/server/product/product-revision-token";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-10-01T09:00:00.000Z";
const EMAIL_PREFIX = "p140resale";
const ORIGIN = "https://monacado.test";

let seq = 0;
let clock = 0;
/** A strictly increasing instant, so every act is ordered after the last. */
const tick = (): string => new Date(Date.parse(NOW) + (clock += 1) * 60_000).toISOString();

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
  await db.productResaleAvailabilityAct.deleteMany({ where: { internalProductId: { in: productIds } } });
  /* Suspensions name activations; both name the Product. */
  await db.productSuspension.deleteMany({ where: { internalProductId: { in: productIds } } });
  await db.productTaxClassificationAct.deleteMany({ where: { internalProductId: { in: productIds } } });
  await db.productActivation.deleteMany({ where: { internalProductId: { in: productIds } } });
  await db.productSourceRecordVersionRow.deleteMany({ where: { internalProductId: { in: productIds } } });
  await db.product.deleteMany({ where: { internalProductId: { in: productIds } } });
  const owned = { participantId: { in: participantIds } };
  await db.notificationObligation.deleteMany({ where: { recipientParticipantId: { in: participantIds } } });
  await db.participantRestriction.deleteMany({ where: owned });
  await db.participantSuspension.deleteMany({ where: owned });
  await db.participantCommerceApproval.deleteMany({ where: owned });
  await db.participantPaymentRequirementRow.deleteMany({ where: { paymentAccount: { is: owned } } });
  await db.participantPaymentAccount.deleteMany({ where: owned });
  await db.marketplaceRoleAssignment.deleteMany({ where: owned });
  await db.marketplaceParticipant.deleteMany({ where: { id: { in: participantIds } } });
  await db.accountEntitlement.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

async function seedOperator(capability: string): Promise<string> {
  seq += 1;
  const account = await createAccount(
    { name: "Operator", email: `${EMAIL_PREFIX}op${seq}@example.com`, password: "correct horse battery staple", createdAt: NOW },
    { db },
  );
  await grantAccountEntitlement({ accountId: account.accountId, capability, grantedAt: NOW }, { db });
  return account.accountId;
}

/**
 * A Seller who meets every activation gate, built from real rows: a verified
 * address and a declared name; an ACTIVE participant with an ACTIVE SELLER role
 * (made ACTIVE by direct update, as other suites do, with its activation
 * instant); a payment account walked to ENABLED through the provider-observation
 * boundary; and a current APPROVED commerce decision.
 */
async function readySeller() {
  seq += 1;
  const account = await createAccount(
    {
      name: "Maker",
      firstName: "Ada",
      lastName: "Potter",
      email: `${EMAIL_PREFIX}${seq}@example.com`,
      password: "correct horse battery staple",
      createdAt: NOW,
      emailVerification: "ADMINISTRATIVE",
    },
    { db },
  );
  const accountId = account.accountId;
  const snapshot = await createDraftParticipant({ accountId, initialRoles: ["SELLER"], now: NOW }, { db });
  const participantId = snapshot.participant.participantId;
  await db.marketplaceParticipant.update({ where: { id: participantId }, data: { status: "ACTIVE" } });
  await db.marketplaceRoleAssignment.updateMany({
    where: { participantId, role: "SELLER" },
    data: { status: "ACTIVE", activatedAt: new Date(NOW) },
  });
  const providerAccountRef = `acct_p140_${seq}`;
  await registerParticipantPaymentAccount({ participantId, provider: "STRIPE", providerAccountRef, now: NOW }, { db });
  await observePayment(participantId, providerAccountRef, "PENDING_PROVIDER");
  await observePayment(participantId, providerAccountRef, "ENABLED");
  await recordCommerceApproval(
    {
      participantId,
      decision: "APPROVED",
      reasonCode: "REQUIREMENTS_MET",
      actingAccountId: await seedOperator("participant:commerce-approve"),
      decidedAt: tick(),
    },
    { db },
  );
  const { token } = await createAccountSession(
    { accountId, createdAt: NOW, ttlSeconds: 7 * 24 * 3_600 },
    { db },
  );
  return { accountId, participantId, providerAccountRef, cookieHeader: `${SESSION_COOKIE_NAME}=${token}` };
}

type Seller = Awaited<ReturnType<typeof readySeller>>;

async function observePayment(participantId: string, providerAccountRef: string, readiness: string) {
  await recordObservedProviderState(
    { participantId, provider: "STRIPE", providerAccountRef, readiness, outstandingRequirements: [], observedAt: tick() },
    { db },
  );
}

const COMPLETE_BODY = {
  name: "Hand-thrown mug",
  description: "Stoneware, 350 ml.",
  deliveryMode: "PHYSICAL",
  shippingPolicy: { method: "FREE" },
};

/** A signed-in account holding exactly one internal grant — a Monacado operator. */
async function signedInOperator(capability: string) {
  const accountId = await seedOperator(capability);
  const { token } = await createAccountSession(
    { accountId, createdAt: NOW, ttlSeconds: 7 * 24 * 3_600 },
    { db },
  );
  return { accountId, cookieHeader: `${SESSION_COOKIE_NAME}=${token}` };
}

let CLASSIFIER: { accountId: string; cookieHeader: string };

async function classify(
  operator: { cookieHeader: string } | null,
  productRef: string,
  body: Record<string, unknown> | string,
) {
  return handleClassifyProductTaxRequest(
    {
      productRef,
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader: operator?.cookieHeader ?? null,
      rawBody: typeof body === "string" ? body : JSON.stringify(body),
    },
    { db, now: tick, appOrigin: ORIGIN },
  );
}

/**
 * Draft through the real route, make it complete through the real revision
 * route, then have a Monacado operator classify it through the real staff
 * route — the classification is Monacado's fiscal fact, never the Seller's.
 */
async function completeProduct(
  seller: Seller,
  opts: { taxClassified?: boolean; promotable?: boolean; generalAvailabilityState?: string } = {},
) {
  const drafted = await handleCreateDraftProductRequest(
    {
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader: seller.cookieHeader,
      rawBody: JSON.stringify({
        name: "Hand-thrown mug",
        description: null,
        promotable: opts.promotable ?? true,
        generalAvailabilityState: opts.generalAvailabilityState ?? "available",
        deliveryMode: "PHYSICAL",
      }),
    },
    { db, now: () => NOW, appOrigin: ORIGIN },
  );
  expect(drafted.status).toBe(201);
  const productRef = drafted.body.productRef as string;
  const { internalProductId } = await db.product.findUniqueOrThrow({ where: { productRef } });
  const revised = await revise(seller, productRef, COMPLETE_BODY);
  expect(revised.status).toBe(200);
  if (opts.taxClassified !== false) {
    const classified = await classify(CLASSIFIER, productRef, { taxClassification: "PHYSICAL_GOOD" });
    expect(classified.status).toBe(200);
  }
  return { productRef, internalProductId };
}

async function currentToken(productRef: string): Promise<string> {
  const row = await db.product.findUniqueOrThrow({ where: { productRef } });
  return productRevisionToken(row.sourceRecordId, row.currentSourceRecordVersion);
}

async function revise(seller: Seller, productRef: string, body: Record<string, unknown>) {
  return handleReviseProductRequest(
    {
      productRef,
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader: seller.cookieHeader,
      rawBody: JSON.stringify({ expectedRevision: await currentToken(productRef), ...body }),
    },
    { db, now: tick, appOrigin: ORIGIN },
  );
}

async function activate(seller: Seller, productRef: string, expectedRevision?: string) {
  return handleActivateProductRequest(
    {
      productRef,
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader: seller.cookieHeader,
      rawBody: JSON.stringify({ expectedRevision: expectedRevision ?? (await currentToken(productRef)) }),
    },
    { db, now: tick, appOrigin: ORIGIN },
  );
}

async function setResale(
  actor: { cookieHeader: string } | null,
  productRef: string,
  body: Record<string, unknown> | string,
  opts: { origin?: string } = {},
) {
  return handleSetProductResaleAvailabilityRequest(
    {
      productRef,
      contentType: "application/json",
      originHeader: opts.origin ?? ORIGIN,
      cookieHeader: actor?.cookieHeader ?? null,
      rawBody: typeof body === "string" ? body : JSON.stringify(body),
    },
    { db, now: tick, appOrigin: ORIGIN },
  );
}

const to = (seller: Seller, productRef: string, resaleAvailability: string) =>
  setResale(seller, productRef, { resaleAvailability });

/** What the Seller's account page shows for resale. */
async function shownResale(seller: Seller, productRef: string) {
  const home = await readAccountHome(seller.accountId, { db });
  const product = home!.products.find((p) => p.productRef === productRef)!;
  return {
    lifecycle: product.lifecycle,
    resaleAvailability: product.resaleAvailability,
    resaleEffective: product.resaleEffective,
  };
}

const acts = (internalProductId: string) =>
  db.productResaleAvailabilityAct.findMany({ where: { internalProductId }, orderBy: { actedAt: "asc" } });

/** A complete, classified, explicitly activated Product. */
async function activeProduct(seller: Seller, opts: Parameters<typeof completeProduct>[1] = {}) {
  const product = await completeProduct(seller, opts);
  expect((await activate(seller, product.productRef)).status).toBe(200);
  return product;
}

const describeDb = RUN ? describe : describe.skip;

describeDb("1.40 — Seller-controlled Product resale availability", () => {
  let SUSPENDER = "";

  beforeEach(async () => {
    await cleanup();
    SUSPENDER = await seedOperator("product:suspend");
    CLASSIFIER = await signedInOperator("product:tax-classify");
  });

  afterAll(async () => {
    if (!RUN) return;
    await cleanup();
    await disconnectPrisma();
  });

  describe("default and authority", () => {
    it("a new Product is NOT_OFFERED, with no act recorded, and is not resale-effective even when ACTIVE", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await activeProduct(seller);

      expect(await shownResale(seller, productRef)).toEqual({
        lifecycle: "ACTIVE",
        resaleAvailability: "NOT_OFFERED",
        resaleEffective: false,
      });
      expect(await acts(internalProductId)).toEqual([]);
      expect(await readProductResaleEffectivenessIn(db, internalProductId)).toEqual({
        lifecycle: "ACTIVE",
        resaleAvailability: "NOT_OFFERED",
        effective: false,
        ineffectiveBecause: "RESALE_NOT_AVAILABLE",
      });
    });

    it("refuses no session (401) and a foreign origin (403), writing nothing", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await activeProduct(seller);

      expect(await setResale(null, productRef, { resaleAvailability: "AVAILABLE" })).toMatchObject({
        status: 401,
        body: { error: CODES.unauthenticated },
      });
      expect(
        await setResale(seller, productRef, { resaleAvailability: "AVAILABLE" }, { origin: "https://evil.test" }),
      ).toMatchObject({ status: 403, body: { error: CODES.crossOrigin } });
      expect(await acts(internalProductId)).toEqual([]);
    });

    it("another Seller, a Monacado operator with internal grants, and an unknown reference get the same 404", async () => {
      const owner = await readySeller();
      const other = await readySeller();
      const { productRef, internalProductId } = await activeProduct(owner);
      const operator = await signedInOperator("product:suspend");
      await grantAccountEntitlement(
        { accountId: operator.accountId, capability: "product:tax-classify", grantedAt: NOW },
        { db },
      );

      for (const actor of [other, operator]) {
        const result = await setResale(actor, productRef, { resaleAvailability: "AVAILABLE" });
        expect(result.status).toBe(404);
        expect(result.body).toEqual({ error: CODES.notAvailable });
      }
      const unknown = await setResale(owner, "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", { resaleAvailability: "AVAILABLE" });
      expect(unknown).toMatchObject({ status: 404, body: { error: CODES.notAvailable } });
      const malformed = await setResale(owner, "not-a-ref", { resaleAvailability: "AVAILABLE" });
      expect(malformed).toMatchObject({ status: 404, body: { error: CODES.notAvailable } });
      expect(await acts(internalProductId)).toEqual([]);
    });

    it("refuses a malformed body, an extra field, and a state outside the vocabulary (400)", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await activeProduct(seller);

      for (const body of [
        "{not json",
        {},
        { resaleAvailability: "AVAILABLE", lifecycle: "ACTIVE" },
        { resaleAvailability: "AVAILABLE", expectedRevision: "x" },
        { resaleAvailability: "ON" },
        { resaleAvailability: "available" },
      ]) {
        const result = await setResale(seller, productRef, body);
        expect(result.status).toBe(400);
        expect(result.body).toEqual({ error: CODES.invalidRequest });
      }
      expect(await acts(internalProductId)).toEqual([]);
    });
  });

  describe("AVAILABLE requires ACTIVE when selected", () => {
    it("ACTIVE → AVAILABLE succeeds and records one auditable act", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await activeProduct(seller);

      const result = await to(seller, productRef, "AVAILABLE");
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        productRef,
        resaleAvailability: "AVAILABLE",
        changed: true,
        lifecycle: "ACTIVE",
        resaleEffective: true,
      });
      expect(await shownResale(seller, productRef)).toEqual({
        lifecycle: "ACTIVE",
        resaleAvailability: "AVAILABLE",
        resaleEffective: true,
      });
      const [act] = await acts(internalProductId);
      expect(act).toMatchObject({
        resaleAvailability: "AVAILABLE",
        previousResaleAvailability: "NOT_OFFERED",
        supersedesActId: null,
        participantId: seller.participantId,
        actedByAccountId: seller.accountId,
        lifecycleAtAct: "ACTIVE",
        currentForProductId: internalProductId,
      });
      expect(act!.id).toMatch(/^mon:pdrsa:/);
      /* No internal identity leaves the route. */
      expect(JSON.stringify(result.body)).not.toContain("mon:");
    });

    it("a COMPLETE Product cannot newly become AVAILABLE (409), and nothing is written", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await completeProduct(seller);
      expect((await shownResale(seller, productRef)).lifecycle).toBe("COMPLETE");

      const result = await to(seller, productRef, "AVAILABLE");
      expect(result).toMatchObject({ status: 409, body: { error: CODES.requiresActive } });
      expect(await acts(internalProductId)).toEqual([]);
    });

    it("an INCOMPLETE Product cannot newly become AVAILABLE (409)", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await completeProduct(seller);
      expect((await revise(seller, productRef, { ...COMPLETE_BODY, shippingPolicy: null })).status).toBe(200);
      expect((await shownResale(seller, productRef)).lifecycle).toBe("INCOMPLETE");

      expect(await to(seller, productRef, "AVAILABLE")).toMatchObject({
        status: 409,
        body: { error: CODES.requiresActive },
      });
      expect(await acts(internalProductId)).toEqual([]);
    });

    it("a SUSPENDED Product cannot newly become AVAILABLE (409), even if it was ACTIVE", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await activeProduct(seller);
      await suspendProduct(
        { internalProductId, reasonCode: "SAFETY_CONCERN", actingAccountId: SUSPENDER, suspendedAt: tick() },
        { db },
      );

      expect(await to(seller, productRef, "AVAILABLE")).toMatchObject({
        status: 409,
        body: { error: CODES.requiresActive },
      });
      expect(await acts(internalProductId)).toEqual([]);
    });
  });

  describe("a preserved AVAILABLE survives lifecycle changes, and never overrides them", () => {
    it("ACTIVE → COMPLETE (readiness lost): AVAILABLE stays stored, ineffective; re-activation makes it effective again", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await activeProduct(seller);
      expect((await to(seller, productRef, "AVAILABLE")).status).toBe(200);
      const before = await acts(internalProductId);

      await observePayment(seller.participantId, seller.providerAccountRef, "RESTRICTED");
      expect(await shownResale(seller, productRef)).toEqual({
        lifecycle: "COMPLETE",
        resaleAvailability: "AVAILABLE",
        resaleEffective: false,
      });
      expect(await readProductResaleEffectivenessIn(db, internalProductId)).toMatchObject({
        effective: false,
        ineffectiveBecause: "LIFECYCLE_NOT_ACTIVE",
      });

      await observePayment(seller.participantId, seller.providerAccountRef, "ENABLED");
      /* Restored readiness never re-activates — and resale stays ineffective. */
      expect((await shownResale(seller, productRef)).resaleEffective).toBe(false);

      expect((await activate(seller, productRef)).status).toBe(200);
      expect(await shownResale(seller, productRef)).toEqual({
        lifecycle: "ACTIVE",
        resaleAvailability: "AVAILABLE",
        resaleEffective: true,
      });
      /* No lifecycle change wrote or rewrote a resale act. */
      expect(await acts(internalProductId)).toEqual(before);
    });

    it("ACTIVE → INCOMPLETE (revision): AVAILABLE stays stored; completing and re-activating makes it effective again", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await activeProduct(seller);
      expect((await to(seller, productRef, "AVAILABLE")).status).toBe(200);
      const before = await acts(internalProductId);

      expect((await revise(seller, productRef, { ...COMPLETE_BODY, shippingPolicy: null })).status).toBe(200);
      expect(await shownResale(seller, productRef)).toEqual({
        lifecycle: "INCOMPLETE",
        resaleAvailability: "AVAILABLE",
        resaleEffective: false,
      });

      expect((await revise(seller, productRef, COMPLETE_BODY)).status).toBe(200);
      expect((await activate(seller, productRef)).status).toBe(200);
      expect((await shownResale(seller, productRef)).resaleEffective).toBe(true);
      expect(await acts(internalProductId)).toEqual(before);
    });

    it("SUSPENDED: AVAILABLE stays stored, ineffective; reinstatement to ACTIVE makes it effective again", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await activeProduct(seller);
      expect((await to(seller, productRef, "AVAILABLE")).status).toBe(200);
      const before = await acts(internalProductId);

      const suspended = await suspendProduct(
        { internalProductId, reasonCode: "SAFETY_CONCERN", actingAccountId: SUSPENDER, suspendedAt: tick() },
        { db },
      );
      expect(await shownResale(seller, productRef)).toEqual({
        lifecycle: "SUSPENDED",
        resaleAvailability: "AVAILABLE",
        resaleEffective: false,
      });
      /* Re-requesting the preserved state while suspended is a no-op, never a reset. */
      expect(await to(seller, productRef, "AVAILABLE")).toMatchObject({
        status: 200,
        body: { resaleAvailability: "AVAILABLE", changed: false, lifecycle: "SUSPENDED", resaleEffective: false },
      });

      await reinstateProduct(
        { suspensionId: suspended.suspensionId, reasonCode: "REVIEW_CONCLUDED", actingAccountId: SUSPENDER, reinstatedAt: tick() },
        { db },
      );
      expect(await shownResale(seller, productRef)).toEqual({
        lifecycle: "ACTIVE",
        resaleAvailability: "AVAILABLE",
        resaleEffective: true,
      });
      expect(await acts(internalProductId)).toEqual(before);
    });
  });

  describe("PAUSED and WITHDRAWN follow only the governed transitions", () => {
    it("AVAILABLE → PAUSED → AVAILABLE (resume) while ACTIVE, as a linear history", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await activeProduct(seller);
      expect((await to(seller, productRef, "AVAILABLE")).status).toBe(200);

      expect(await to(seller, productRef, "PAUSED")).toMatchObject({
        status: 200,
        body: { resaleAvailability: "PAUSED", changed: true, resaleEffective: false },
      });
      expect((await shownResale(seller, productRef)).resaleAvailability).toBe("PAUSED");

      expect(await to(seller, productRef, "AVAILABLE")).toMatchObject({
        status: 200,
        body: { resaleAvailability: "AVAILABLE", changed: true, resaleEffective: true },
      });

      const history = await acts(internalProductId);
      expect(history.map((a) => [a.previousResaleAvailability, a.resaleAvailability])).toEqual([
        ["NOT_OFFERED", "AVAILABLE"],
        ["AVAILABLE", "PAUSED"],
        ["PAUSED", "AVAILABLE"],
      ]);
      expect(history.map((a) => a.supersedesActId)).toEqual([null, history[0]!.id, history[1]!.id]);
      expect(history.map((a) => a.currentForProductId)).toEqual([null, null, internalProductId]);
    });

    it("a Seller may pause while the Product is not ACTIVE, but may not resume until it is", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await activeProduct(seller);
      expect((await to(seller, productRef, "AVAILABLE")).status).toBe(200);
      await observePayment(seller.participantId, seller.providerAccountRef, "RESTRICTED");

      expect(await to(seller, productRef, "PAUSED")).toMatchObject({
        status: 200,
        body: { resaleAvailability: "PAUSED", changed: true, lifecycle: "COMPLETE" },
      });
      expect(await to(seller, productRef, "AVAILABLE")).toMatchObject({
        status: 409,
        body: { error: CODES.requiresActive },
      });
      expect((await acts(internalProductId)).at(-1)).toMatchObject({
        resaleAvailability: "PAUSED",
        lifecycleAtAct: "COMPLETE",
      });
    });

    it("a Seller may pause or withdraw a SUSPENDED Product — a Seller act, distinct from Monacado's suspension", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await activeProduct(seller);
      expect((await to(seller, productRef, "AVAILABLE")).status).toBe(200);
      const suspended = await suspendProduct(
        { internalProductId, reasonCode: "SAFETY_CONCERN", actingAccountId: SUSPENDER, suspendedAt: tick() },
        { db },
      );

      expect((await to(seller, productRef, "PAUSED")).status).toBe(200);
      expect((await shownResale(seller, productRef)).lifecycle).toBe("SUSPENDED");
      /* The Seller's pause did not touch Monacado's suspension. */
      expect(await db.productSuspension.findUniqueOrThrow({ where: { id: suspended.suspensionId } })).toMatchObject({
        status: "ACTIVE",
        activeForProductId: internalProductId,
      });
      expect((await to(seller, productRef, "WITHDRAWN")).status).toBe(200);
    });

    it("AVAILABLE → WITHDRAWN, and PAUSED → WITHDRAWN; nothing leaves WITHDRAWN", async () => {
      const seller = await readySeller();
      const a = await activeProduct(seller);
      const b = await activeProduct(seller);
      expect((await to(seller, a.productRef, "AVAILABLE")).status).toBe(200);
      expect((await to(seller, a.productRef, "WITHDRAWN")).body).toMatchObject({ resaleAvailability: "WITHDRAWN", changed: true });
      expect((await to(seller, b.productRef, "AVAILABLE")).status).toBe(200);
      expect((await to(seller, b.productRef, "PAUSED")).status).toBe(200);
      expect((await to(seller, b.productRef, "WITHDRAWN")).body).toMatchObject({ resaleAvailability: "WITHDRAWN", changed: true });

      for (const { productRef, internalProductId } of [a, b]) {
        const before = await acts(internalProductId);
        for (const target of ["AVAILABLE", "PAUSED", "NOT_OFFERED"]) {
          expect(await to(seller, productRef, target)).toMatchObject({
            status: 409,
            body: { error: CODES.notGoverned },
          });
        }
        expect(await acts(internalProductId)).toEqual(before);
        expect(await shownResale(seller, productRef)).toMatchObject({
          resaleAvailability: "WITHDRAWN",
          resaleEffective: false,
        });
      }
    });

    it("NOT_OFFERED cannot be paused or withdrawn, and nothing returns to NOT_OFFERED", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await activeProduct(seller);
      for (const target of ["PAUSED", "WITHDRAWN"]) {
        expect(await to(seller, productRef, target)).toMatchObject({ status: 409, body: { error: CODES.notGoverned } });
      }
      expect(await acts(internalProductId)).toEqual([]);

      expect((await to(seller, productRef, "AVAILABLE")).status).toBe(200);
      expect(await to(seller, productRef, "NOT_OFFERED")).toMatchObject({ status: 409, body: { error: CODES.notGoverned } });
      expect((await to(seller, productRef, "PAUSED")).status).toBe(200);
      expect(await to(seller, productRef, "NOT_OFFERED")).toMatchObject({ status: 409, body: { error: CODES.notGoverned } });
      expect(await acts(internalProductId)).toHaveLength(2);
    });
  });

  describe("no-op and concurrency", () => {
    it("requesting the current state is a deterministic no-op that writes nothing", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await activeProduct(seller);

      expect(await to(seller, productRef, "NOT_OFFERED")).toMatchObject({
        status: 200,
        body: { resaleAvailability: "NOT_OFFERED", changed: false },
      });
      expect(await acts(internalProductId)).toEqual([]);

      expect((await to(seller, productRef, "AVAILABLE")).status).toBe(200);
      const before = await acts(internalProductId);
      for (let i = 0; i < 2; i += 1) {
        expect(await to(seller, productRef, "AVAILABLE")).toMatchObject({
          status: 200,
          body: { resaleAvailability: "AVAILABLE", changed: false, resaleEffective: true },
        });
      }
      expect(await acts(internalProductId)).toEqual(before);
    });

    it("two simultaneous identical requests: one change, one no-op, one act", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await activeProduct(seller);

      const results = await Promise.all([to(seller, productRef, "AVAILABLE"), to(seller, productRef, "AVAILABLE")]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(results.map((r) => r.body.changed).sort()).toEqual([false, true]);
      expect(await acts(internalProductId)).toHaveLength(1);
    });

    it("simultaneous conflicting requests are serialised into one linear history with one current act", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await activeProduct(seller);
      expect((await to(seller, productRef, "AVAILABLE")).status).toBe(200);

      const results = await Promise.all([
        to(seller, productRef, "PAUSED"),
        to(seller, productRef, "WITHDRAWN"),
        to(seller, productRef, "PAUSED"),
      ]);
      expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);

      const history = await acts(internalProductId);
      const current = history.filter((a) => a.currentForProductId !== null);
      expect(current).toHaveLength(1);
      /* Each act follows exactly the one before it — no fork. */
      for (let i = 1; i < history.length; i += 1) {
        expect(history[i]!.supersedesActId).toBe(history[i - 1]!.id);
        expect(history[i]!.previousResaleAvailability).toBe(history[i - 1]!.resaleAvailability);
      }
      expect(new Set(history.map((a) => a.supersedesActId)).size).toBe(history.length);
      /* Every refusal is a governed one; the state shown is the current act's. */
      for (const r of results.filter((x) => x.status === 409)) expect(r.body.error).toBe(CODES.notGoverned);
      expect((await shownResale(seller, productRef)).resaleAvailability).toBe(current[0]!.resaleAvailability);
    });
  });

  describe("legacy facts and other concepts govern nothing", () => {
    it("legacy promotable = true grants nothing, and promotable = false blocks nothing", async () => {
      const seller = await readySeller();
      const promotable = await activeProduct(seller, { promotable: true });
      const notPromotable = await activeProduct(seller, { promotable: false });

      expect(await shownResale(seller, promotable.productRef)).toMatchObject({
        resaleAvailability: "NOT_OFFERED",
        resaleEffective: false,
      });
      expect((await to(seller, notPromotable.productRef, "AVAILABLE")).status).toBe(200);
      expect(await shownResale(seller, notPromotable.productRef)).toMatchObject({
        resaleAvailability: "AVAILABLE",
        resaleEffective: true,
      });
      /* The legacy column is untouched either way. */
      const legacy = await db.productSourceRecordVersionRow.findMany({
        where: { internalProductId: { in: [promotable.internalProductId, notPromotable.internalProductId] } },
        select: { internalProductId: true, factPromotable: true },
      });
      expect(new Set(legacy.filter((v) => v.internalProductId === promotable.internalProductId).map((v) => v.factPromotable))).toEqual(new Set([true]));
      expect(new Set(legacy.filter((v) => v.internalProductId === notPromotable.internalProductId).map((v) => v.factPromotable))).toEqual(new Set([false]));
    });

    it("generalAvailabilityState neither grants nor blocks resale availability", async () => {
      const seller = await readySeller();
      const discontinued = await activeProduct(seller, { generalAvailabilityState: "discontinued" });
      const available = await activeProduct(seller, { generalAvailabilityState: "available" });

      expect((await shownResale(seller, available.productRef)).resaleAvailability).toBe("NOT_OFFERED");
      expect((await to(seller, discontinued.productRef, "AVAILABLE")).status).toBe(200);
      expect((await shownResale(seller, discontinued.productRef)).resaleEffective).toBe(true);
    });

    it("requires no Storefront, Listing, Offer, or Promotion Authorization, and writes no other state", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await activeProduct(seller);
      expect(await db.storefront.count({ where: { ownerParticipantId: seller.participantId } })).toBe(0);
      expect(await db.listing.count({ where: { internalProductId } })).toBe(0);
      expect(await db.offer.count({ where: { internalProductId } })).toBe(0);

      const versionsBefore = await db.productSourceRecordVersionRow.findMany({ where: { internalProductId }, orderBy: { seq: "asc" } });
      const stableBefore = await db.product.findUniqueOrThrow({ where: { internalProductId } });
      const activationsBefore = await db.productActivation.findMany({ where: { internalProductId } });
      const totals = async () => ({
        orders: await db.order.count(),
        settlements: await db.transactionSettlement.count(),
        proceeds: await db.proceedsObligation.count(),
        listings: await db.listing.count(),
        offers: await db.offer.count(),
        storefronts: await db.storefront.count(),
        nodes: await db.productNode.count(),
        publications: await db.productPublication.count(),
        outbox: await db.publicationOutbox.count(),
        suspensions: await db.productSuspension.count(),
        notifications: await db.notificationObligation.count(),
      });
      const before = await totals();

      expect((await to(seller, productRef, "AVAILABLE")).status).toBe(200);
      expect((await to(seller, productRef, "PAUSED")).status).toBe(200);
      expect((await to(seller, productRef, "WITHDRAWN")).status).toBe(200);

      expect(await totals()).toEqual(before);
      expect(await db.productSourceRecordVersionRow.findMany({ where: { internalProductId }, orderBy: { seq: "asc" } })).toEqual(versionsBefore);
      expect(await db.product.findUniqueOrThrow({ where: { internalProductId } })).toEqual(stableBefore);
      expect(await db.productActivation.findMany({ where: { internalProductId } })).toEqual(activationsBefore);
      expect((await shownResale(seller, productRef)).lifecycle).toBe("ACTIVE");
    });
  });
});
