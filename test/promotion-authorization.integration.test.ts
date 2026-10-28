/**
 * Phase 1.41 — Promotion Authorization, against a real database.
 *
 * Proves the three routes, the service, the read models, and the future
 * promoted-commerce helper together:
 *
 *   - REQUEST: private marketplace identity and a drafting PROMOTER role are
 *     enough — no payment readiness, commerce approval, Product ACTIVE, resale
 *     AVAILABLE, Offer, Storefront, or Listing; a Seller cannot request its own
 *     Product; a non-Promoter cannot request at all;
 *   - SELLER DECISION: only the Product's Seller approves, denies, or revokes —
 *     another Seller and a Monacado operator with internal grants get the same
 *     404 as an unknown Product; approval re-checks the Promoter's standing and
 *     fails closed without touching the request;
 *   - REVOKE / CANCEL: per-Promoter, history preserved, the helper false at once;
 *     the Promoter cancels REQUESTED and APPROVED, never the Seller;
 *   - RE-REQUEST: a new cycle after DENIED / CANCELLED / REVOKED, old cycles
 *     untouched, approval never restored;
 *   - INDEPENDENCE: no lifecycle or resale change rewrites a relationship;
 *   - CONCURRENCY: no fork, one current relationship, one linear history;
 *   - SIDE EFFECTS: no Offer, Listing, Storefront, Order, payment, payout,
 *     publication, Product version, or revision-token change.
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
import { reinstateProduct, suspendProduct } from "../src/server/marketplace/product-suspension-service";
import { handleCreateDraftProductRequest } from "../src/server/product/product-draft-route-handler";
import { handleReviseProductRequest } from "../src/server/product/product-revision-route-handler";
import { handleActivateProductRequest } from "../src/server/product/product-activation-route-handler";
import { handleClassifyProductTaxRequest } from "../src/server/product/product-tax-classification-route-handler";
import { handleSetProductResaleAvailabilityRequest } from "../src/server/product/product-resale-availability-route-handler";
import { productRevisionToken } from "../src/server/product/product-revision-token";
import {
  PROMOTION_AUTHORIZATION_ROUTE_ERROR_CODES as CODES,
  handleCancelPromotionAuthorizationRequest,
  handleDecidePromotionAuthorizationRequest,
  handleRequestPromotionAuthorizationRequest,
} from "../src/server/marketplace/promotion-authorization-route-handler";
import { isPromotionAuthorizationApprovedIn } from "../src/server/marketplace/promotion-authorization-read-service";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-11-01T09:00:00.000Z";
const EMAIL_PREFIX = "p141pauth";
const ORIGIN = "https://monacado.test";
const UNKNOWN_REF = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";

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
  const cycleIds = (
    await db.promotionAuthorization.findMany({
      where: { OR: [{ internalProductId: { in: productIds } }, { promoterParticipantId: { in: participantIds } }] },
      select: { id: true },
    })
  ).map((c) => c.id);
  await db.promotionOfferAcceptance.deleteMany({ where: { authorizationId: { in: cycleIds } } });
  await db.promotionAuthorizationAct.deleteMany({ where: { authorizationId: { in: cycleIds } } });
  await db.promotionAuthorization.deleteMany({ where: { id: { in: cycleIds } } });
  await db.productResaleAvailabilityAct.deleteMany({ where: { internalProductId: { in: productIds } } });
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

async function session(accountId: string): Promise<string> {
  const { token } = await createAccountSession({ accountId, createdAt: NOW, ttlSeconds: 7 * 24 * 3_600 }, { db });
  return `${SESSION_COOKIE_NAME}=${token}`;
}

interface Actor {
  accountId: string;
  participantId: string;
  cookieHeader: string;
}

/**
 * A participant in DRAFT holding the named roles in DRAFT, with private
 * marketplace identity (verified email, declared names) unless told otherwise —
 * and NO payment account, commerce approval, activation, or Storefront.
 */
async function draftParticipant(
  roles: Array<"SELLER" | "PROMOTER">,
  opts: { name?: string; verified?: boolean; firstName?: null; lastName?: null } = {},
): Promise<Actor> {
  seq += 1;
  const account = await createAccount(
    {
      name: opts.name ?? `Participant ${seq}`,
      firstName: opts.firstName ?? "Pat",
      lastName: opts.lastName ?? "Promoter",
      email: `${EMAIL_PREFIX}${seq}@example.com`,
      password: "correct horse battery staple",
      createdAt: NOW,
      ...(opts.verified === false ? {} : { emailVerification: "ADMINISTRATIVE" as const }),
    },
    { db },
  );
  /* A pre-1.37 account that never declared a name: NULL, as the migration left it. */
  if (opts.firstName === null || opts.lastName === null) {
    await db.account.update({
      where: { id: account.accountId },
      data: {
        ...(opts.firstName === null ? { firstName: null } : {}),
        ...(opts.lastName === null ? { lastName: null } : {}),
      },
    });
  }
  const snapshot = await createDraftParticipant({ accountId: account.accountId, initialRoles: roles, now: NOW }, { db });
  return {
    accountId: account.accountId,
    participantId: snapshot.participant.participantId,
    cookieHeader: await session(account.accountId),
  };
}

/** The participant's Monacado-assigned mName (Phase 1.43). */
async function mNameOf(actor: Actor): Promise<string | null> {
  return (await db.marketplaceParticipant.findUniqueOrThrow({ where: { id: actor.participantId } })).marketplaceName;
}

const draftPromoter = (opts: Parameters<typeof draftParticipant>[1] = {}) =>
  /* `Account.name` deliberately differs from the declared "Pat" + "Promoter",
     so a page naming the Promoter by the display name is caught. */
  draftParticipant(["PROMOTER"], { name: "Display Alias", ...opts });

async function seedOperator(capability: string): Promise<string> {
  seq += 1;
  const account = await createAccount(
    { name: "Operator", email: `${EMAIL_PREFIX}op${seq}@example.com`, password: "correct horse battery staple", createdAt: NOW },
    { db },
  );
  await grantAccountEntitlement({ accountId: account.accountId, capability, grantedAt: NOW }, { db });
  return account.accountId;
}

async function signedInOperator(capabilities: string[]) {
  const accountId = await seedOperator(capabilities[0]!);
  for (const capability of capabilities.slice(1)) {
    await grantAccountEntitlement({ accountId, capability, grantedAt: NOW }, { db });
  }
  return { accountId, cookieHeader: await session(accountId) };
}

async function observePayment(participantId: string, providerAccountRef: string, readiness: string) {
  await recordObservedProviderState(
    { participantId, provider: "STRIPE", providerAccountRef, readiness, outstandingRequirements: [], observedAt: tick() },
    { db },
  );
}

/** A Seller meeting every activation gate (the Phase 1.40 fixture). */
async function readySeller(): Promise<Actor> {
  const seller = await draftParticipant(["SELLER"], { name: "Maker" });
  await db.marketplaceParticipant.update({ where: { id: seller.participantId }, data: { status: "ACTIVE" } });
  await db.marketplaceRoleAssignment.updateMany({
    where: { participantId: seller.participantId, role: "SELLER" },
    data: { status: "ACTIVE", activatedAt: new Date(NOW) },
  });
  const providerAccountRef = `acct_p141_${seq}`;
  await registerParticipantPaymentAccount(
    { participantId: seller.participantId, provider: "STRIPE", providerAccountRef, now: NOW },
    { db },
  );
  await observePayment(seller.participantId, providerAccountRef, "PENDING_PROVIDER");
  await observePayment(seller.participantId, providerAccountRef, "ENABLED");
  await recordCommerceApproval(
    {
      participantId: seller.participantId,
      decision: "APPROVED",
      reasonCode: "REQUIREMENTS_MET",
      actingAccountId: await seedOperator("participant:commerce-approve"),
      decidedAt: tick(),
    },
    { db },
  );
  return seller;
}

const COMPLETE_BODY = {
  name: "Hand-thrown mug",
  description: "Stoneware, 350 ml.",
  deliveryMode: "PHYSICAL",
  shippingPolicy: { method: "FREE" },
};

const json = (body: Record<string, unknown> | string) => (typeof body === "string" ? body : JSON.stringify(body));

/** A private draft Product (INCOMPLETE) through the real draft route. */
async function draftProduct(seller: Actor) {
  const drafted = await handleCreateDraftProductRequest(
    {
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader: seller.cookieHeader,
      rawBody: json({
        name: "Hand-thrown mug",
        description: null,
        promotable: false,
        generalAvailabilityState: "available",
        deliveryMode: "PHYSICAL",
      }),
    },
    { db, now: () => NOW, appOrigin: ORIGIN },
  );
  expect(drafted.status).toBe(201);
  const productRef = drafted.body.productRef as string;
  const { internalProductId } = await db.product.findUniqueOrThrow({ where: { productRef } });
  return { productRef, internalProductId };
}

async function currentToken(productRef: string): Promise<string> {
  const row = await db.product.findUniqueOrThrow({ where: { productRef } });
  return productRevisionToken(row.sourceRecordId, row.currentSourceRecordVersion);
}

async function revise(seller: Actor, productRef: string, body: Record<string, unknown>) {
  return handleReviseProductRequest(
    {
      productRef,
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader: seller.cookieHeader,
      rawBody: json({ expectedRevision: await currentToken(productRef), ...body }),
    },
    { db, now: tick, appOrigin: ORIGIN },
  );
}

let CLASSIFIER: { accountId: string; cookieHeader: string };

/** A complete, Monacado-classified Product (COMPLETE for a ready Seller). */
async function completeProduct(seller: Actor) {
  const product = await draftProduct(seller);
  expect((await revise(seller, product.productRef, COMPLETE_BODY)).status).toBe(200);
  const classified = await handleClassifyProductTaxRequest(
    {
      productRef: product.productRef,
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader: CLASSIFIER.cookieHeader,
      rawBody: json({ taxClassification: "PHYSICAL_GOOD" }),
    },
    { db, now: tick, appOrigin: ORIGIN },
  );
  expect(classified.status).toBe(200);
  return product;
}

async function activeProduct(seller: Actor) {
  const product = await completeProduct(seller);
  const activated = await handleActivateProductRequest(
    {
      productRef: product.productRef,
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader: seller.cookieHeader,
      rawBody: json({ expectedRevision: await currentToken(product.productRef) }),
    },
    { db, now: tick, appOrigin: ORIGIN },
  );
  expect(activated.status).toBe(200);
  return product;
}

async function setResale(seller: Actor, productRef: string, resaleAvailability: string) {
  const result = await handleSetProductResaleAvailabilityRequest(
    {
      productRef,
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader: seller.cookieHeader,
      rawBody: json({ resaleAvailability }),
    },
    { db, now: tick, appOrigin: ORIGIN },
  );
  expect(result.status).toBe(200);
}

const routeDeps = { db, now: tick, appOrigin: ORIGIN };

async function request(
  actor: { cookieHeader: string } | null,
  productRef: string,
  body: Record<string, unknown> | string = {},
  opts: { origin?: string } = {},
) {
  return handleRequestPromotionAuthorizationRequest(
    {
      productRef,
      contentType: "application/json",
      originHeader: opts.origin ?? ORIGIN,
      cookieHeader: actor?.cookieHeader ?? null,
      rawBody: json(body),
    },
    routeDeps,
  );
}

async function decide(
  actor: { cookieHeader: string } | null,
  productRef: string,
  authorizationRef: string,
  decision: string | Record<string, unknown>,
) {
  return handleDecidePromotionAuthorizationRequest(
    {
      productRef,
      authorizationRef,
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader: actor?.cookieHeader ?? null,
      rawBody: json(typeof decision === "string" ? { decision } : decision),
    },
    routeDeps,
  );
}

async function cancel(
  actor: { cookieHeader: string } | null,
  productRef: string,
  authorizationRef: string,
  body: Record<string, unknown> | string = {},
) {
  return handleCancelPromotionAuthorizationRequest(
    {
      productRef,
      authorizationRef,
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader: actor?.cookieHeader ?? null,
      rawBody: json(body),
    },
    routeDeps,
  );
}

/** Request and return the new cycle's reference. */
async function requested(promoter: Actor, productRef: string): Promise<string> {
  const result = await request(promoter, productRef);
  expect(result.status, JSON.stringify(result.body)).toBe(201);
  expect(result.body.state).toBe("REQUESTED");
  return result.body.authorizationRef as string;
}

const cycles = (internalProductId: string, promoterParticipantId?: string) =>
  db.promotionAuthorization.findMany({
    where: { internalProductId, ...(promoterParticipantId !== undefined ? { promoterParticipantId } : {}) },
    orderBy: { cycleNumber: "asc" },
    include: { acts: { orderBy: { actedAt: "asc" } } },
  });

const approved = (internalProductId: string, promoter: Actor) =>
  isPromotionAuthorizationApprovedIn(db, { internalProductId, promoterParticipantId: promoter.participantId });

/** The state of the current act of the current cycle for one pair. */
async function currentState(internalProductId: string, promoter: Actor): Promise<string | null> {
  const cycle = await db.promotionAuthorization.findFirst({
    where: { currentForProductId: internalProductId, currentForPromoterParticipantId: promoter.participantId },
  });
  if (cycle === null) return null;
  const act = await db.promotionAuthorizationAct.findUniqueOrThrow({ where: { currentForAuthorizationId: cycle.id } });
  return act.state;
}

/** Assert one cycle's act chain is linear and ends at its single current act. */
function expectLinear(acts: Array<{ id: string; supersedesActId: string | null; currentForAuthorizationId: string | null; state: string; previousState: string | null }>) {
  expect(acts[0]!.supersedesActId).toBeNull();
  expect(acts[0]!.previousState).toBeNull();
  for (let i = 1; i < acts.length; i += 1) {
    expect(acts[i]!.supersedesActId).toBe(acts[i - 1]!.id);
    expect(acts[i]!.previousState).toBe(acts[i - 1]!.state);
  }
  expect(acts.filter((a) => a.currentForAuthorizationId !== null)).toHaveLength(1);
  expect(acts.at(-1)!.currentForAuthorizationId).not.toBeNull();
}

const describeDb = RUN ? describe : describe.skip;

describeDb("1.41 — Promotion Authorization", () => {
  let SUSPENDER = "";

  beforeEach(async () => {
    await cleanup();
    SUSPENDER = await seedOperator("product:suspend");
    CLASSIFIER = await signedInOperator(["product:tax-classify"]);
  });

  afterAll(async () => {
    if (!RUN) return;
    await cleanup();
    await disconnectPrisma();
  });

  describe("request", () => {
    it("a DRAFT Promoter with no payment account, commerce approval, Storefront, Listing, or Offer requests an INCOMPLETE Product", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const { productRef, internalProductId } = await draftProduct(seller);
      expect(await db.participantPaymentAccount.count({ where: { participantId: promoter.participantId } })).toBe(0);
      expect(await db.participantCommerceApproval.count({ where: { participantId: promoter.participantId } })).toBe(0);
      expect(await db.storefront.count({ where: { ownerParticipantId: promoter.participantId } })).toBe(0);
      expect(await db.offer.count({ where: { internalProductId } })).toBe(0);
      expect(await db.listing.count({ where: { internalProductId } })).toBe(0);

      const result = await request(promoter, productRef);
      expect(result.status).toBe(201);
      expect(Object.keys(result.body).sort()).toEqual(["authorizationRef", "productRef", "state"]);
      expect(result.body).toMatchObject({ productRef, state: "REQUESTED" });
      expect(result.body.authorizationRef).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);
      expect(JSON.stringify(result.body)).not.toContain("mon:");

      const [cycle] = await cycles(internalProductId);
      expect(cycle).toMatchObject({
        authorizationRef: result.body.authorizationRef,
        promoterParticipantId: promoter.participantId,
        cycleNumber: 1,
        supersedesAuthorizationId: null,
        currentForProductId: internalProductId,
        currentForPromoterParticipantId: promoter.participantId,
        requestedByAccountId: promoter.accountId,
      });
      expect(cycle!.id).toMatch(/^mon:pauth:/);
      expect(cycle!.acts).toHaveLength(1);
      expect(cycle!.acts[0]).toMatchObject({
        act: "REQUEST",
        state: "REQUESTED",
        previousState: null,
        actorAuthority: "PROMOTER",
        actorParticipantId: promoter.participantId,
        actedByAccountId: promoter.accountId,
      });
      expect(await approved(internalProductId, promoter)).toBe(false);
    });

    it("COMPLETE, ACTIVE, and non-AVAILABLE Products can all be requested", async () => {
      const seller = await readySeller();
      const promoter = await draftPromoter();
      const complete = await completeProduct(seller);
      const active = await activeProduct(seller);
      for (const product of [complete, active]) {
        expect((await request(promoter, product.productRef)).status).toBe(201);
      }
      const home = await readAccountHome(seller.accountId, { db });
      expect(home!.products.map((p) => [p.lifecycle, p.resaleAvailability])).toEqual([
        ["COMPLETE", "NOT_OFFERED"],
        ["ACTIVE", "NOT_OFFERED"],
      ]);
    });

    it("PENDING_ACTIVATION and ACTIVE PROMOTER roles qualify, and a RESTRICTED participant may still request", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const { productRef } = await draftProduct(seller);
      for (const roleStatus of ["PENDING_ACTIVATION", "ACTIVE"]) {
        const promoter = await draftPromoter();
        await db.marketplaceRoleAssignment.updateMany({
          where: { participantId: promoter.participantId, role: "PROMOTER" },
          data: { status: roleStatus },
        });
        expect((await request(promoter, productRef)).status, roleStatus).toBe(201);
      }
      const restricted = await draftPromoter();
      await db.marketplaceParticipant.update({ where: { id: restricted.participantId }, data: { status: "RESTRICTED" } });
      expect((await request(restricted, productRef)).status).toBe(201);
    });

    it("refuses without private marketplace identity, naming why, and writes nothing", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const { productRef, internalProductId } = await draftProduct(seller);
      const cases: Array<[Parameters<typeof draftPromoter>[0], string[]]> = [
        [{ verified: false }, ["EMAIL_UNVERIFIED"]],
        [{ firstName: null }, ["FIRST_NAME_MISSING"]],
        [{ lastName: null }, ["LAST_NAME_MISSING"]],
      ];
      for (const [opts, refusals] of cases) {
        const promoter = await draftPromoter(opts);
        expect(await request(promoter, productRef)).toMatchObject({
          status: 403,
          body: { error: CODES.requestNotPermitted, refusals },
        });
      }
      expect(await cycles(internalProductId)).toEqual([]);
    });

    it("1.43 — refuses a Promoter with no mName (a pre-1.43 row), naming why, and writes nothing", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const { productRef, internalProductId } = await draftProduct(seller);
      const promoter = await draftPromoter();
      /* Only reachable by direct row edit: every participant is created with one. */
      await db.marketplaceParticipant.update({ where: { id: promoter.participantId }, data: { marketplaceName: null } });
      expect(await request(promoter, productRef)).toMatchObject({
        status: 403,
        body: { error: CODES.requestNotPermitted, refusals: ["MARKETPLACE_NAME_MISSING"] },
      });
      expect(await cycles(internalProductId)).toEqual([]);
    });

    it("the PROMOTER role is required, in a drafting status, on a participant not suspended or closed", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const otherSeller = await draftParticipant(["SELLER"]);
      const { productRef, internalProductId } = await draftProduct(seller);

      expect(await request(otherSeller, productRef)).toMatchObject({
        status: 403,
        body: { error: CODES.requestNotPermitted, refusals: ["PROMOTER_ROLE_NOT_HELD"] },
      });
      for (const roleStatus of ["SUSPENDED", "REVOKED"]) {
        const promoter = await draftPromoter();
        await db.marketplaceRoleAssignment.updateMany({
          where: { participantId: promoter.participantId, role: "PROMOTER" },
          data: { status: roleStatus },
        });
        expect(await request(promoter, productRef)).toMatchObject({
          status: 403,
          body: { refusals: ["PROMOTER_ROLE_NOT_ELIGIBLE"] },
        });
      }
      for (const status of ["SUSPENDED", "CLOSED"]) {
        const promoter = await draftPromoter();
        await db.marketplaceParticipant.update({ where: { id: promoter.participantId }, data: { status } });
        expect(await request(promoter, productRef)).toMatchObject({
          status: 403,
          body: { refusals: ["PARTICIPANT_STATUS_NOT_ELIGIBLE"] },
        });
      }
      /* An account with no participant at all. */
      seq += 1;
      const bare = await createAccount(
        { name: "Bare", firstName: "B", lastName: "A", email: `${EMAIL_PREFIX}${seq}@example.com`, password: "correct horse battery staple", createdAt: NOW, emailVerification: "ADMINISTRATIVE" },
        { db },
      );
      expect(await request({ cookieHeader: await session(bare.accountId) }, productRef)).toMatchObject({
        status: 403,
        body: { refusals: ["PARTICIPANT_MISSING"] },
      });
      expect(await cycles(internalProductId)).toEqual([]);
    });

    it("a Seller cannot request its own Product, even holding the PROMOTER role", async () => {
      const seller = await draftParticipant(["SELLER", "PROMOTER"]);
      const { productRef, internalProductId } = await draftProduct(seller);
      expect(await request(seller, productRef)).toMatchObject({ status: 403, body: { error: CODES.selfPromotion } });
      expect(await cycles(internalProductId)).toEqual([]);
    });

    it("refuses no session (401), a foreign origin (403), a malformed or non-empty body (400), and an unknown Product (404)", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const { productRef, internalProductId } = await draftProduct(seller);

      expect(await request(null, productRef)).toMatchObject({ status: 401, body: { error: CODES.unauthenticated } });
      expect(await request(promoter, productRef, {}, { origin: "https://evil.test" })).toMatchObject({
        status: 403,
        body: { error: CODES.crossOrigin },
      });
      for (const body of ["{nope", { promoterParticipantId: promoter.participantId }, { state: "APPROVED" }]) {
        expect(await request(promoter, productRef, body)).toMatchObject({ status: 400, body: { error: CODES.invalidRequest } });
      }
      for (const ref of [UNKNOWN_REF, "not-a-ref", internalProductId]) {
        expect(await request(promoter, ref)).toMatchObject({ status: 404, body: { error: CODES.productNotAvailable } });
      }
      expect(await cycles(internalProductId)).toEqual([]);
    });

    it("requesting while REQUESTED or APPROVED is an explicit 409 that writes nothing", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const { productRef, internalProductId } = await draftProduct(seller);
      const ref = await requested(promoter, productRef);

      expect(await request(promoter, productRef)).toMatchObject({ status: 409, body: { error: CODES.alreadyRequested } });
      expect((await decide(seller, productRef, ref, "APPROVE")).status).toBe(200);
      const before = await cycles(internalProductId);
      expect(await request(promoter, productRef)).toMatchObject({ status: 409, body: { error: CODES.alreadyApproved } });
      expect(await cycles(internalProductId)).toEqual(before);
    });
  });

  describe("Seller decision", () => {
    it("the authoritative Seller approves: a current APPROVED relationship, recorded with the Seller as actor", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const { productRef, internalProductId } = await draftProduct(seller);
      const ref = await requested(promoter, productRef);

      const result = await decide(seller, productRef, ref, "APPROVE");
      expect(result).toMatchObject({ status: 200, body: { productRef, authorizationRef: ref, state: "APPROVED" } });
      expect(await approved(internalProductId, promoter)).toBe(true);
      const [cycle] = await cycles(internalProductId);
      expectLinear(cycle!.acts);
      expect(cycle!.acts.at(-1)).toMatchObject({
        act: "APPROVE",
        state: "APPROVED",
        previousState: "REQUESTED",
        actorAuthority: "SELLER",
        actorParticipantId: seller.participantId,
        actedByAccountId: seller.accountId,
      });
      expect(cycle!.acts.at(-1)!.id).toMatch(/^mon:pauthact:/);
    });

    it("the authoritative Seller denies; the request survives as history", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const { productRef, internalProductId } = await draftProduct(seller);
      const ref = await requested(promoter, productRef);

      expect(await decide(seller, productRef, ref, "DENY")).toMatchObject({ status: 200, body: { state: "DENIED" } });
      const [cycle] = await cycles(internalProductId);
      expect(cycle!.acts.map((a) => [a.act, a.state])).toEqual([
        ["REQUEST", "REQUESTED"],
        ["DENY", "DENIED"],
      ]);
      expectLinear(cycle!.acts);
      expect(await approved(internalProductId, promoter)).toBe(false);
    });

    it("another Seller, a Monacado operator with internal grants, the Promoter itself, and an unknown Product all get 404 and write nothing", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const otherSeller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const operator = await signedInOperator(["product:suspend", "product:tax-classify", "activation:review"]);
      const { productRef, internalProductId } = await draftProduct(seller);
      const ref = await requested(promoter, productRef);
      const before = await cycles(internalProductId);

      for (const actor of [otherSeller, operator, promoter]) {
        for (const decision of ["APPROVE", "DENY"]) {
          expect(await decide(actor, productRef, ref, decision)).toMatchObject({
            status: 404,
            body: { error: CODES.productNotAvailable },
          });
        }
      }
      expect(await decide(seller, UNKNOWN_REF, ref, "APPROVE")).toMatchObject({
        status: 404,
        body: { error: CODES.productNotAvailable },
      });
      expect(await cycles(internalProductId)).toEqual(before);
    });

    it("an authorization reference belonging to another Product, or unknown, is 404 on this Product", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const a = await draftProduct(seller);
      const b = await draftProduct(seller);
      const refOnB = await requested(promoter, b.productRef);

      expect(await decide(seller, a.productRef, refOnB, "APPROVE")).toMatchObject({ status: 404, body: { error: CODES.notFound } });
      expect(await decide(seller, a.productRef, UNKNOWN_REF, "APPROVE")).toMatchObject({ status: 404, body: { error: CODES.notFound } });
      expect(await decide(seller, a.productRef, "short", "APPROVE")).toMatchObject({ status: 404, body: { error: CODES.notFound } });
      expect(await currentState(b.internalProductId, promoter)).toBe("REQUESTED");
    });

    it("refuses a decision outside the vocabulary and an extra body field (400)", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const { productRef } = await draftProduct(seller);
      const ref = await requested(promoter, productRef);
      for (const body of [{ decision: "CANCEL" }, { decision: "approve" }, { decision: "APPROVE", state: "APPROVED" }, {}]) {
        expect(await decide(seller, productRef, ref, body)).toMatchObject({ status: 400, body: { error: CODES.invalidRequest } });
      }
    });

    it("non-governed decisions are explicit 409s that write nothing: approve twice, deny or revoke the wrong state", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const { productRef, internalProductId } = await draftProduct(seller);
      const ref = await requested(promoter, productRef);

      expect(await decide(seller, productRef, ref, "REVOKE")).toMatchObject({ status: 409, body: { error: CODES.notGoverned } });
      expect((await decide(seller, productRef, ref, "APPROVE")).status).toBe(200);
      const before = await cycles(internalProductId);
      for (const decision of ["APPROVE", "DENY"]) {
        expect(await decide(seller, productRef, ref, decision)).toMatchObject({ status: 409, body: { error: CODES.notGoverned } });
      }
      expect(await cycles(internalProductId)).toEqual(before);

      expect((await decide(seller, productRef, ref, "REVOKE")).status).toBe(200);
      for (const decision of ["APPROVE", "DENY", "REVOKE"]) {
        expect(await decide(seller, productRef, ref, decision)).toMatchObject({ status: 409, body: { error: CODES.notGoverned } });
      }
      expect(await currentState(internalProductId, promoter)).toBe("REVOKED");
    });

    it("approval re-checks the Promoter: a lapsed role, a suspended or closed participant, or lost identity fail closed and leave the request pending", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const { productRef, internalProductId } = await draftProduct(seller);

      const kept = new Map<string, string | null>();
      const lapses: Array<[string, (p: Actor) => Promise<unknown>, (p: Actor) => Promise<unknown>]> = [
        [
          "mName absent (1.43)",
          async (p) => {
            kept.set(p.participantId, await mNameOf(p));
            await db.marketplaceParticipant.update({ where: { id: p.participantId }, data: { marketplaceName: null } });
          },
          (p) =>
            db.marketplaceParticipant.update({
              where: { id: p.participantId },
              data: { marketplaceName: kept.get(p.participantId) ?? null },
            }),
        ],
        [
          "role suspended",
          (p) => db.marketplaceRoleAssignment.updateMany({ where: { participantId: p.participantId, role: "PROMOTER" }, data: { status: "SUSPENDED" } }),
          (p) => db.marketplaceRoleAssignment.updateMany({ where: { participantId: p.participantId, role: "PROMOTER" }, data: { status: "DRAFT" } }),
        ],
        [
          "participant suspended",
          (p) => db.marketplaceParticipant.update({ where: { id: p.participantId }, data: { status: "SUSPENDED" } }),
          (p) => db.marketplaceParticipant.update({ where: { id: p.participantId }, data: { status: "DRAFT" } }),
        ],
        [
          "participant closed",
          (p) => db.marketplaceParticipant.update({ where: { id: p.participantId }, data: { status: "CLOSED" } }),
          (p) => db.marketplaceParticipant.update({ where: { id: p.participantId }, data: { status: "DRAFT" } }),
        ],
        [
          "email no longer verified",
          (p) => db.account.update({ where: { id: p.accountId }, data: { emailVerifiedAt: null, emailVerifiedVia: null } }),
          (p) => db.account.update({ where: { id: p.accountId }, data: { emailVerifiedAt: new Date(NOW), emailVerifiedVia: "ADMINISTRATIVE" } }),
        ],
      ];
      for (const [label, lapse, restore] of lapses) {
        const promoter = await draftPromoter();
        const ref = await requested(promoter, productRef);
        await lapse(promoter);
        const before = await cycles(internalProductId, promoter.participantId);
        expect(await decide(seller, productRef, ref, "APPROVE"), label).toMatchObject({
          status: 409,
          body: { error: CODES.promoterNotEligible },
        });
        expect(await cycles(internalProductId, promoter.participantId), label).toEqual(before);
        expect(await currentState(internalProductId, promoter)).toBe("REQUESTED");
        /* Not approvable while lapsed — but still deniable, and approvable once standing returns. */
        await restore(promoter);
        expect((await decide(seller, productRef, ref, "APPROVE")).status, label).toBe(200);
      }
    });

    it("a Promoter with no payment account or commerce approval is approved — approval is not commerce readiness", async () => {
      const seller = await readySeller();
      const promoter = await draftPromoter();
      const { productRef, internalProductId } = await activeProduct(seller);
      const ref = await requested(promoter, productRef);
      expect((await decide(seller, productRef, ref, "APPROVE")).status).toBe(200);
      expect(await approved(internalProductId, promoter)).toBe(true);
      expect(await db.participantPaymentAccount.count({ where: { participantId: promoter.participantId } })).toBe(0);
    });
  });

  describe("revoke", () => {
    it("revoking one Promoter leaves another approved, makes the helper false at once, and preserves history", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const one = await draftPromoter();
      const two = await draftPromoter();
      const { productRef, internalProductId } = await draftProduct(seller);
      const refOne = await requested(one, productRef);
      const refTwo = await requested(two, productRef);
      expect((await decide(seller, productRef, refOne, "APPROVE")).status).toBe(200);
      expect((await decide(seller, productRef, refTwo, "APPROVE")).status).toBe(200);
      const twoBefore = await cycles(internalProductId, two.participantId);

      expect(await decide(seller, productRef, refOne, "REVOKE")).toMatchObject({ status: 200, body: { state: "REVOKED" } });
      expect(await approved(internalProductId, one)).toBe(false);
      expect(await approved(internalProductId, two)).toBe(true);
      expect(await cycles(internalProductId, two.participantId)).toEqual(twoBefore);

      const [cycle] = await cycles(internalProductId, one.participantId);
      expect(cycle!.acts.map((a) => a.state)).toEqual(["REQUESTED", "APPROVED", "REVOKED"]);
      expectLinear(cycle!.acts);
      expect(cycle!.acts.at(-1)).toMatchObject({ act: "REVOKE", actorAuthority: "SELLER", actorParticipantId: seller.participantId });

      /* The Seller's page lists only the still-open relationship. */
      const home = await readAccountHome(seller.accountId, { db });
      expect(home!.products[0]!.promotionAuthorizations.map((a) => a.state)).toEqual(["APPROVED"]);
    });
  });

  describe("cancel", () => {
    it("the Promoter cancels REQUESTED (withdrawing its request)", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const { productRef, internalProductId } = await draftProduct(seller);
      const ref = await requested(promoter, productRef);

      expect(await cancel(promoter, productRef, ref)).toMatchObject({ status: 200, body: { state: "CANCELLED" } });
      const [cycle] = await cycles(internalProductId);
      expect(cycle!.acts.map((a) => [a.act, a.state, a.actorAuthority])).toEqual([
        ["REQUEST", "REQUESTED", "PROMOTER"],
        ["CANCEL", "CANCELLED", "PROMOTER"],
      ]);
      expectLinear(cycle!.acts);
    });

    it("the Promoter cancels APPROVED (withdrawing its participation); the helper is false at once", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const { productRef, internalProductId } = await draftProduct(seller);
      const ref = await requested(promoter, productRef);
      expect((await decide(seller, productRef, ref, "APPROVE")).status).toBe(200);

      expect(await cancel(promoter, productRef, ref)).toMatchObject({ status: 200, body: { state: "CANCELLED" } });
      expect(await approved(internalProductId, promoter)).toBe(false);
      const [cycle] = await cycles(internalProductId);
      expect(cycle!.acts.map((a) => a.state)).toEqual(["REQUESTED", "APPROVED", "CANCELLED"]);
    });

    it("a Promoter may cancel even after its own role lapsed — withdrawing is standing down", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const { productRef } = await draftProduct(seller);
      const ref = await requested(promoter, productRef);
      await db.marketplaceRoleAssignment.updateMany({
        where: { participantId: promoter.participantId, role: "PROMOTER" },
        data: { status: "REVOKED" },
      });
      expect((await cancel(promoter, productRef, ref)).status).toBe(200);
    });

    it("the Seller, another Promoter, and an operator cannot cancel; terminal states cannot be cancelled", async () => {
      const seller = await draftParticipant(["SELLER", "PROMOTER"]);
      const promoter = await draftPromoter();
      const other = await draftPromoter();
      const operator = await signedInOperator(["product:suspend"]);
      const { productRef, internalProductId } = await draftProduct(seller);
      const ref = await requested(promoter, productRef);
      const before = await cycles(internalProductId);

      for (const actor of [seller, other, operator]) {
        expect(await cancel(actor, productRef, ref)).toMatchObject({ status: 404, body: { error: CODES.notFound } });
      }
      expect(await cancel(promoter, productRef, ref, { reason: "x" })).toMatchObject({ status: 400 });
      expect(await cycles(internalProductId)).toEqual(before);

      expect((await decide(seller, productRef, ref, "DENY")).status).toBe(200);
      expect(await cancel(promoter, productRef, ref)).toMatchObject({ status: 409, body: { error: CODES.notGoverned } });
      expect(await currentState(internalProductId, promoter)).toBe("DENIED");
    });
  });

  describe("re-request", () => {
    for (const ending of ["DENY", "CANCEL", "REVOKE"] as const) {
      it(`after ${ending}: a new REQUESTED cycle; the old cycle is untouched; approval is not restored`, async () => {
        const seller = await draftParticipant(["SELLER"]);
        const promoter = await draftPromoter();
        const { productRef, internalProductId } = await draftProduct(seller);
        const first = await requested(promoter, productRef);
        if (ending === "REVOKE") expect((await decide(seller, productRef, first, "APPROVE")).status).toBe(200);
        const ended =
          ending === "CANCEL" ? await cancel(promoter, productRef, first) : await decide(seller, productRef, first, ending);
        expect(ended.status).toBe(200);
        const [oldBefore] = await cycles(internalProductId);

        const second = await requested(promoter, productRef);
        expect(second).not.toBe(first);
        expect(await approved(internalProductId, promoter)).toBe(false);

        const [oldAfter, fresh] = await cycles(internalProductId);
        /* The old cycle kept every act; only its current-pair marker moved. */
        expect(oldAfter!.acts).toEqual(oldBefore!.acts);
        expect({ ...oldAfter, currentForProductId: oldBefore!.currentForProductId, currentForPromoterParticipantId: oldBefore!.currentForPromoterParticipantId }).toEqual(oldBefore);
        expect(oldAfter).toMatchObject({ currentForProductId: null, currentForPromoterParticipantId: null });
        expect(fresh).toMatchObject({
          authorizationRef: second,
          cycleNumber: 2,
          supersedesAuthorizationId: oldAfter!.id,
          currentForProductId: internalProductId,
          currentForPromoterParticipantId: promoter.participantId,
        });
        expect(fresh!.acts.map((a) => a.state)).toEqual(["REQUESTED"]);

        /* The old cycle cannot be revived — it is superseded. */
        expect(await decide(seller, productRef, first, "APPROVE")).toMatchObject({ status: 409, body: { error: CODES.superseded } });
        expect(await cancel(promoter, productRef, first)).toMatchObject({ status: 409, body: { error: CODES.superseded } });

        /* The Seller must approve the new cycle explicitly. */
        expect((await decide(seller, productRef, second, "APPROVE")).status).toBe(200);
        expect(await approved(internalProductId, promoter)).toBe(true);
      });
    }

    it("the Promoter's page shows the current state of each request and what it may do next", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const a = await draftProduct(seller);
      const b = await draftProduct(seller);
      await requested(promoter, a.productRef);
      const refB = await requested(promoter, b.productRef);
      expect((await decide(seller, b.productRef, refB, "DENY")).status).toBe(200);

      const home = await readAccountHome(promoter.accountId, { db });
      expect(home!.promoter).toMatchObject({ canRequest: true, requestRefusals: [] });
      expect(home!.promoter!.authorizations.map((x) => [x.productRef, x.state, x.canCancel, x.canRequestAgain])).toEqual([
        [a.productRef, "REQUESTED", true, false],
        [b.productRef, "DENIED", false, true],
      ]);
      expect(JSON.stringify(home!.promoter)).not.toContain("mon:");
      /* A Seller-only account has no Promoter section. */
      expect((await readAccountHome(seller.accountId, { db }))!.promoter).toBeNull();
      /* And the Seller's page names the Promoter by display name only. */
      const sellerHome = await readAccountHome(seller.accountId, { db });
      const shown = sellerHome!.products.find((p) => p.productRef === a.productRef)!.promotionAuthorizations;
      expect(shown).toEqual([
        { authorizationRef: expect.any(String), promoterMName: await mNameOf(promoter), state: "REQUESTED", canApprove: true, termsAcceptance: null },
      ]);
    });

    it("1.43 — the Seller sees pending and approved Promoters by mName only — never a declared name, Account.name, email, or id", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const pending = await draftPromoter();
      const accepted = await draftPromoter();
      await db.account.update({ where: { id: accepted.accountId }, data: { firstName: "  Ava ", lastName: " Approved  " } });
      const { productRef } = await draftProduct(seller);
      await requested(pending, productRef);
      const ref = await requested(accepted, productRef);
      expect((await decide(seller, productRef, ref, "APPROVE")).status).toBe(200);

      const home = await readAccountHome(seller.accountId, { db });
      const shown = home!.products[0]!.promotionAuthorizations;
      expect(shown.map((a) => [a.promoterMName, a.state, a.canApprove])).toEqual([
        [await mNameOf(pending), "REQUESTED", true],
        [await mNameOf(accepted), "APPROVED", false],
      ]);
      const serialized = JSON.stringify(shown);
      for (const privateName of ["Display Alias", "Pat", "Promoter", "Ava", "Approved"]) {
        expect(serialized).not.toContain(privateName);
      }
      for (const p of [pending, accepted]) {
        const { email } = await db.account.findUniqueOrThrow({ where: { id: p.accountId } });
        expect(serialized).not.toContain(email);
        expect(serialized).not.toContain(p.participantId);
        expect(serialized).not.toContain(p.accountId);
      }
      expect(serialized).not.toContain("mon:");
    });

    it("1.43 — a Promoter with no mName is listed unnamed, never by a declared name or Account.name; deniable, not approvable", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const { productRef } = await draftProduct(seller);
      const ref = await requested(promoter, productRef);
      /* Only reachable by direct row edit: every participant is created with one. */
      await db.marketplaceParticipant.update({ where: { id: promoter.participantId }, data: { marketplaceName: null } });

      const home = await readAccountHome(seller.accountId, { db });
      expect(home!.products[0]!.promotionAuthorizations).toEqual([
        { authorizationRef: ref, promoterMName: null, state: "REQUESTED", canApprove: false, termsAcceptance: null },
      ]);
      for (const privateName of ["Display Alias", "Pat", "Promoter"]) {
        expect(JSON.stringify(home!.products)).not.toContain(privateName);
      }
      expect(await decide(seller, productRef, ref, "APPROVE")).toMatchObject({
        status: 409,
        body: { error: CODES.promoterNotEligible },
      });
      expect((await decide(seller, productRef, ref, "DENY")).status).toBe(200);
    });
  });

  describe("independence from lifecycle and resale availability", () => {
    it("lifecycle changes (ACTIVE → INCOMPLETE → ACTIVE), resale PAUSED / WITHDRAWN, and Product suspension never rewrite a relationship", async () => {
      const seller = await readySeller();
      const promoter = await draftPromoter();
      const pending = await draftPromoter();
      const { productRef, internalProductId } = await activeProduct(seller);
      const ref = await requested(promoter, productRef);
      await requested(pending, productRef);
      expect((await decide(seller, productRef, ref, "APPROVE")).status).toBe(200);
      const snapshot = async () => cycles(internalProductId);
      const before = await snapshot();

      await setResale(seller, productRef, "AVAILABLE");
      await setResale(seller, productRef, "PAUSED");
      expect(await snapshot()).toEqual(before);
      expect(await approved(internalProductId, promoter)).toBe(true);

      expect((await revise(seller, productRef, { ...COMPLETE_BODY, shippingPolicy: null })).status).toBe(200);
      expect((await readAccountHome(seller.accountId, { db }))!.products[0]!.lifecycle).toBe("INCOMPLETE");
      expect(await snapshot()).toEqual(before);

      const suspended = await suspendProduct(
        { internalProductId, reasonCode: "SAFETY_CONCERN", actingAccountId: SUSPENDER, suspendedAt: tick() },
        { db },
      );
      expect((await readAccountHome(seller.accountId, { db }))!.products[0]!.lifecycle).toBe("SUSPENDED");
      expect(await snapshot()).toEqual(before);
      expect(await approved(internalProductId, promoter)).toBe(true);
      await reinstateProduct(
        { suspensionId: suspended.suspensionId, reasonCode: "REVIEW_CONCLUDED", actingAccountId: SUSPENDER, reinstatedAt: tick() },
        { db },
      );

      await setResale(seller, productRef, "WITHDRAWN");
      expect(await snapshot()).toEqual(before);
      expect(await approved(internalProductId, promoter)).toBe(true);
      expect(await currentState(internalProductId, pending)).toBe("REQUESTED");
    });

    it("the Seller may approve, deny, and revoke while the Product is SUSPENDED or resale is PAUSED", async () => {
      const seller = await readySeller();
      const one = await draftPromoter();
      const two = await draftPromoter();
      const { productRef, internalProductId } = await activeProduct(seller);
      await setResale(seller, productRef, "AVAILABLE");
      await setResale(seller, productRef, "PAUSED");
      await suspendProduct(
        { internalProductId, reasonCode: "SAFETY_CONCERN", actingAccountId: SUSPENDER, suspendedAt: tick() },
        { db },
      );
      const refOne = await requested(one, productRef);
      const refTwo = await requested(two, productRef);
      expect((await decide(seller, productRef, refOne, "APPROVE")).status).toBe(200);
      expect((await decide(seller, productRef, refTwo, "DENY")).status).toBe(200);
      expect((await decide(seller, productRef, refOne, "REVOKE")).status).toBe(200);
    });
  });

  describe("concurrency", () => {
    it("duplicate simultaneous requests: one cycle, one 201, the rest an explicit 409", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const { productRef, internalProductId } = await draftProduct(seller);

      const results = await Promise.all([1, 2, 3].map(() => request(promoter, productRef)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      for (const r of results.filter((x) => x.status !== 201)) {
        expect(r.status).toBe(409);
        expect([CODES.alreadyRequested, CODES.conflict]).toContain(r.body.error);
      }
      const all = await cycles(internalProductId);
      expect(all).toHaveLength(1);
      expect(all[0]!.acts).toHaveLength(1);
    });

    it("concurrent approve and deny on one request: exactly one terminal decision wins", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const { productRef, internalProductId } = await draftProduct(seller);
      const ref = await requested(promoter, productRef);

      const results = await Promise.all([
        decide(seller, productRef, ref, "APPROVE"),
        decide(seller, productRef, ref, "DENY"),
        decide(seller, productRef, ref, "APPROVE"),
      ]);
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      for (const r of results.filter((x) => x.status !== 200)) expect(r.body.error).toBe(CODES.notGoverned);
      const [cycle] = await cycles(internalProductId);
      expect(cycle!.acts).toHaveLength(2);
      expectLinear(cycle!.acts);
      expect(await currentState(internalProductId, promoter)).toBe(results.find((r) => r.status === 200)!.body.state);
    });

    it("revoke racing the Promoter's cancellation: one wins, the other writes nothing", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const { productRef, internalProductId } = await draftProduct(seller);
      const ref = await requested(promoter, productRef);
      expect((await decide(seller, productRef, ref, "APPROVE")).status).toBe(200);

      const [revoke, cancelled] = await Promise.all([decide(seller, productRef, ref, "REVOKE"), cancel(promoter, productRef, ref)]);
      expect([revoke.status, cancelled.status].sort()).toEqual([200, 409]);
      const [cycle] = await cycles(internalProductId);
      expect(cycle!.acts).toHaveLength(3);
      expectLinear(cycle!.acts);
      expect(["REVOKED", "CANCELLED"]).toContain(cycle!.acts.at(-1)!.state);
    });

    it("a re-request racing an action on the old cycle: one current relationship, no fork", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const { productRef, internalProductId } = await draftProduct(seller);
      const first = await requested(promoter, productRef);
      expect((await decide(seller, productRef, first, "DENY")).status).toBe(200);

      const [again, stale, cancelled] = await Promise.all([
        request(promoter, productRef),
        decide(seller, productRef, first, "APPROVE"),
        cancel(promoter, productRef, first),
      ]);
      expect(again.status).toBe(201);
      for (const r of [stale, cancelled]) expect([CODES.notGoverned, CODES.superseded]).toContain(r.body.error);

      const all = await cycles(internalProductId);
      expect(all).toHaveLength(2);
      expect(all.filter((c) => c.currentForProductId !== null)).toHaveLength(1);
      expect(all[0]!.acts.map((a) => a.state)).toEqual(["REQUESTED", "DENIED"]);
      expect(all[1]!.acts.map((a) => a.state)).toEqual(["REQUESTED"]);
      expect(await approved(internalProductId, promoter)).toBe(false);
    });

    it("the database refuses a second current relationship for the same Product + Promoter", async () => {
      const seller = await draftParticipant(["SELLER"]);
      const promoter = await draftPromoter();
      const { productRef, internalProductId } = await draftProduct(seller);
      await requested(promoter, productRef);
      await expect(
        db.promotionAuthorization.create({
          data: {
            id: "mon:pauth:FORKFORKFORKFORKFORKFORKFO",
            authorizationRef: "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF",
            internalProductId,
            promoterParticipantId: promoter.participantId,
            cycleNumber: 9,
            currentForProductId: internalProductId,
            currentForPromoterParticipantId: promoter.participantId,
            requestedByAccountId: promoter.accountId,
            requestedAt: new Date(NOW),
          },
        }),
      ).rejects.toMatchObject({ code: "P2002" });
    });
  });

  describe("side effects", () => {
    it("writes no Offer, Listing, Storefront, Order, payment, payout, publication, Product version, lifecycle or resale state; the revision token is unchanged", async () => {
      const seller = await readySeller();
      const promoter = await draftPromoter();
      const { productRef, internalProductId } = await activeProduct(seller);

      const versionsBefore = await db.productSourceRecordVersionRow.findMany({ where: { internalProductId }, orderBy: { seq: "asc" } });
      const stableBefore = await db.product.findUniqueOrThrow({ where: { internalProductId } });
      const tokenBefore = await currentToken(productRef);
      const activationsBefore = await db.productActivation.findMany({ where: { internalProductId } });
      const totals = async () => ({
        orders: await db.order.count(),
        settlements: await db.transactionSettlement.count(),
        proceeds: await db.proceedsObligation.count(),
        paymentAccounts: await db.participantPaymentAccount.count(),
        listings: await db.listing.count(),
        offers: await db.offer.count(),
        storefronts: await db.storefront.count(),
        nodes: await db.productNode.count(),
        publications: await db.productPublication.count(),
        outbox: await db.publicationOutbox.count(),
        suspensions: await db.productSuspension.count(),
        resaleActs: await db.productResaleAvailabilityAct.count(),
        notifications: await db.notificationObligation.count(),
        emails: await db.outboundEmailDelivery.count(),
      });
      const before = await totals();

      const ref = await requested(promoter, productRef);
      expect((await decide(seller, productRef, ref, "APPROVE")).status).toBe(200);
      expect((await decide(seller, productRef, ref, "REVOKE")).status).toBe(200);
      const again = await requested(promoter, productRef);
      expect((await decide(seller, productRef, again, "DENY")).status).toBe(200);
      const third = await requested(promoter, productRef);
      expect((await cancel(promoter, productRef, third)).status).toBe(200);

      expect(await totals()).toEqual(before);
      expect(await db.productSourceRecordVersionRow.findMany({ where: { internalProductId }, orderBy: { seq: "asc" } })).toEqual(versionsBefore);
      expect(await db.product.findUniqueOrThrow({ where: { internalProductId } })).toEqual(stableBefore);
      expect(await currentToken(productRef)).toBe(tokenBefore);
      expect(await db.productActivation.findMany({ where: { internalProductId } })).toEqual(activationsBefore);
      expect((await readAccountHome(seller.accountId, { db }))!.products[0]).toMatchObject({
        lifecycle: "ACTIVE",
        resaleAvailability: "NOT_OFFERED",
        revisionToken: tokenBefore,
      });
    });
  });
});
