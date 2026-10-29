/**
 * Phase 1.39 — Product lifecycle and explicit Product activation, against a real
 * database.
 *
 * Proves the route, `activateProductAs`, the lifecycle derivation, and the
 * Product suspension primitive together:
 *
 *   - a complete Product owned by a fully ready Seller is COMPLETE until the
 *     Seller activates it explicitly, then ACTIVE; nothing activates it by itself;
 *   - every readiness gate refuses from real rows, with the first blocker as the
 *     error and the whole ordered set alongside;
 *   - no Storefront, Listing, or Offer is required, and none is written;
 *   - a revision that breaks completeness makes the Product INCOMPLETE; a lapse
 *     of readiness makes it COMPLETE; restoring either NEVER re-activates it;
 *   - a Product suspension is SUSPENDED; lifting it restores ACTIVE only where
 *     ACTIVE stood immediately before and every fact held throughout;
 *   - a stale page and a concurrent second activation are refused;
 *   - activation writes no source version and no Order, Listing, Offer, Node,
 *     publication, or outbox state.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createAccountSession } from "../src/server/account/account-session-service";
import { grantAccountEntitlement } from "./support/entitlement-fixture";
import { SESSION_COOKIE_NAME } from "../src/server/account/session-cookie";
import { readAccountHome } from "../src/server/account/account-home";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import {
  recordObservedProviderState,
  registerParticipantPaymentAccount,
} from "../src/server/marketplace/payment-account-service";
import { recordCommerceApproval } from "../src/server/marketplace/participant-commerce-approval-service";
import {
  imposeParticipantRestriction,
  liftParticipantRestriction,
} from "../src/server/marketplace/participant-restriction-service";
import {
  reinstateProduct,
  suspendProduct,
} from "../src/server/marketplace/product-suspension-service";
import { handleCreateDraftProductRequest } from "../src/server/product/product-draft-route-handler";
import { handleReviseProductRequest } from "../src/server/product/product-revision-route-handler";
import {
  PRODUCT_ACTIVATION_ROUTE_ERROR_CODES as CODES,
  handleActivateProductRequest,
} from "../src/server/product/product-activation-route-handler";
import {
  PRODUCT_TAX_CLASSIFICATION_ROUTE_ERROR_CODES as TAX_CODES,
  handleClassifyProductTaxRequest,
} from "../src/server/product/product-tax-classification-route-handler";
import { readCurrentProductCompleteness } from "../src/server/product/product-completeness-service";
import {
  ProductSuspensionNotAuthorizedError,
  ProductSuspensionSelfActionNotPermittedError,
} from "../src/server/product/errors";
import { productRevisionToken } from "../src/server/product/product-revision-token";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2028-10-01T09:00:00.000Z";
const EMAIL_PREFIX = "p139activate";
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
  const providerAccountRef = `acct_p139_${seq}`;
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
async function completeProduct(seller: Seller, opts: { taxClassified?: boolean } = {}) {
  const drafted = await handleCreateDraftProductRequest(
    {
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader: seller.cookieHeader,
      rawBody: JSON.stringify({
        name: "Hand-thrown mug",
        description: null,
        promotable: true,
        generalAvailabilityState: "available",
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

/** The lifecycle and blockers the Seller's account page shows. */
async function shown(seller: Seller, productRef: string) {
  const home = await readAccountHome(seller.accountId, { db });
  const product = home!.products.find((p) => p.productRef === productRef)!;
  return { lifecycle: product.lifecycle, blockers: product.activationBlockers };
}

const describeDb = RUN ? describe : describe.skip;

describeDb("1.39 — Product lifecycle and explicit Product activation", () => {
  let RESTRICTOR = "";
  let SUSPENDER = "";

  beforeEach(async () => {
    await cleanup();
    RESTRICTOR = await seedOperator("participant:restrict");
    SUSPENDER = await seedOperator("product:suspend");
    CLASSIFIER = await signedInOperator("product:tax-classify");
  });

  afterAll(async () => {
    if (!RUN) return;
    await cleanup();
    await disconnectPrisma();
  });

  describe("explicit activation", () => {
    it("a complete Product of a ready Seller is COMPLETE until the Seller activates it, then ACTIVE", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await completeProduct(seller);

      /* Meeting every requirement makes activation permissible — nothing more. */
      expect(await shown(seller, productRef)).toEqual({ lifecycle: "COMPLETE", blockers: [] });
      expect(await db.productActivation.count({ where: { internalProductId } })).toBe(0);

      const token = await currentToken(productRef);
      const result = await activate(seller, productRef);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ productRef, lifecycle: "ACTIVE", revision: token });
      expect(await shown(seller, productRef)).toEqual({ lifecycle: "ACTIVE", blockers: [] });

      const [activation] = await db.productActivation.findMany({ where: { internalProductId } });
      expect(activation).toMatchObject({
        participantId: seller.participantId,
        activatedByAccountId: seller.accountId,
        /* v1 drafted, v2 the Seller's completing revision, v3 Monacado's classification. */
        activatedSourceRecordVersion: "3",
        currentForProductId: internalProductId,
        supersededAt: null,
      });
    });

    it("an already ACTIVE Product is refused 409 and nothing is written", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await completeProduct(seller);
      expect((await activate(seller, productRef)).status).toBe(200);

      const again = await activate(seller, productRef);
      expect(again.status).toBe(409);
      expect(again.body).toEqual({ error: CODES.alreadyActive });
      expect(await db.productActivation.count({ where: { internalProductId } })).toBe(1);
    });

    it("requires no Storefront, Listing, or Offer, and writes no version, Order, Listing, Offer, Node, or outbox state", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await completeProduct(seller);
      expect(await db.storefront.count({ where: { ownerParticipantId: seller.participantId } })).toBe(0);

      const versionsBefore = await db.productSourceRecordVersionRow.findMany({
        where: { internalProductId },
        orderBy: { seq: "asc" },
      });
      const stableBefore = await db.product.findUniqueOrThrow({ where: { internalProductId } });
      const totals = async () => ({
        orders: await db.order.count(),
        listings: await db.listing.count(),
        offers: await db.offer.count(),
        storefronts: await db.storefront.count(),
        outbox: await db.publicationOutbox.count(),
      });
      const before = await totals();

      expect((await activate(seller, productRef)).status).toBe(200);

      expect(await totals()).toEqual(before);
      /* Every historical version byte-for-byte unchanged; no version written. */
      expect(
        await db.productSourceRecordVersionRow.findMany({ where: { internalProductId }, orderBy: { seq: "asc" } }),
      ).toEqual(versionsBefore);
      expect(await db.product.findUniqueOrThrow({ where: { internalProductId } })).toEqual(stableBefore);
    });

    it("another Seller's Product is one 404, and nothing is written", async () => {
      const owner = await readySeller();
      const other = await readySeller();
      const { productRef, internalProductId } = await completeProduct(owner);

      const result = await activate(other, productRef);
      expect(result.status).toBe(404);
      expect(result.body).toEqual({ error: CODES.notAvailable });
      expect(await db.productActivation.count({ where: { internalProductId } })).toBe(0);
    });

    it("a stale revision token is refused 409 and the Seller never activates a version they did not see", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await completeProduct(seller);
      const stale = await currentToken(productRef);
      expect((await revise(seller, productRef, { ...COMPLETE_BODY, description: "Stoneware, 400 ml." })).status).toBe(200);

      const result = await activate(seller, productRef, stale);
      expect(result.status).toBe(409);
      expect(result.body).toEqual({ error: CODES.conflict });
      expect(await db.productActivation.count({ where: { internalProductId } })).toBe(0);
    });

    it("two concurrent activations: exactly one succeeds and one current activation exists", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await completeProduct(seller);
      const token = await currentToken(productRef);

      const results = await Promise.all([activate(seller, productRef, token), activate(seller, productRef, token)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      const loser = results.find((r) => r.status === 409)!;
      expect([CODES.alreadyActive, CODES.conflict]).toContain(loser.body.error);
      expect(await db.productActivation.count({ where: { internalProductId } })).toBe(1);
    });
  });

  describe("every readiness gate refuses from real rows", () => {
    it("an incomplete Product: 409 PRODUCT_INCOMPLETE", async () => {
      const seller = await readySeller();
      const { productRef } = await completeProduct(seller);
      expect((await revise(seller, productRef, { ...COMPLETE_BODY, shippingPolicy: null })).status).toBe(200);

      const result = await activate(seller, productRef);
      expect(result.status).toBe(409);
      expect(result.body).toEqual({ error: "PRODUCT_INCOMPLETE", blockers: ["PRODUCT_INCOMPLETE"] });
      expect((await shown(seller, productRef)).lifecycle).toBe("INCOMPLETE");
    });

    const refusals: Array<[string, (s: Seller) => Promise<void>, string[]]> = [
      [
        "EMAIL_UNVERIFIED",
        async (s) => {
          await db.account.update({ where: { id: s.accountId }, data: { emailVerifiedAt: null, emailVerifiedVia: null } });
        },
        ["EMAIL_UNVERIFIED"],
      ],
      [
        "FIRST_NAME_MISSING",
        async (s) => {
          await db.account.update({ where: { id: s.accountId }, data: { firstName: null } });
        },
        ["FIRST_NAME_MISSING"],
      ],
      [
        "LAST_NAME_MISSING (blank is missing)",
        async (s) => {
          await db.account.update({ where: { id: s.accountId }, data: { lastName: "   " } });
        },
        ["LAST_NAME_MISSING"],
      ],
      [
        "PARTICIPANT_NOT_ACTIVE",
        async (s) => {
          await db.marketplaceParticipant.update({ where: { id: s.participantId }, data: { status: "DRAFT" } });
        },
        ["PARTICIPANT_NOT_ACTIVE"],
      ],
      [
        "SELLER_ROLE_NOT_ACTIVE",
        async (s) => {
          await db.marketplaceRoleAssignment.updateMany({
            where: { participantId: s.participantId, role: "SELLER" },
            data: { status: "SUSPENDED" },
          });
        },
        ["SELLER_ROLE_NOT_ACTIVE"],
      ],
      [
        "PAYMENT_NOT_READY",
        async (s) => observePayment(s.participantId, s.providerAccountRef, "RESTRICTED"),
        ["PAYMENT_NOT_READY"],
      ],
      [
        "COMMERCE_APPROVAL_MISSING",
        async (s) => {
          await recordCommerceApproval(
            {
              participantId: s.participantId,
              decision: "NOT_APPROVED",
              reasonCode: "REQUIREMENTS_OUTSTANDING",
              actingAccountId: await seedOperator("participant:commerce-approve"),
              decidedAt: tick(),
            },
            { db },
          );
        },
        ["COMMERCE_APPROVAL_MISSING"],
      ],
      [
        "PRODUCT_ACTIVATION_RESTRICTED",
        async (s) => {
          await imposeParticipantRestriction(
            {
              participantId: s.participantId,
              scope: "product:activate",
              reasonCode: "UNDERWRITING_REVIEW_REQUIRED",
              actingAccountId: RESTRICTOR,
              imposedAt: tick(),
            },
            { db },
          );
        },
        /* Any restriction moves an ACTIVE participant to RESTRICTED as well. */
        ["PRODUCT_ACTIVATION_RESTRICTED", "PARTICIPANT_NOT_ACTIVE"],
      ],
    ];

    for (const [label, breakIt, blockers] of refusals) {
      it(`${label}: 403 with the first blocker, and nothing is written`, async () => {
        const seller = await readySeller();
        const { productRef, internalProductId } = await completeProduct(seller);
        await breakIt(seller);

        const result = await activate(seller, productRef);
        expect(result.status).toBe(403);
        expect(result.body).toEqual({ error: blockers[0], blockers });
        expect(await shown(seller, productRef)).toEqual({ lifecycle: "COMPLETE", blockers });
        expect(await db.productActivation.count({ where: { internalProductId } })).toBe(0);
      });
    }

    it("TAX_CLASSIFICATION_NOT_READY: an unclassified Product cannot be activated", async () => {
      const seller = await readySeller();
      const { productRef } = await completeProduct(seller, { taxClassified: false });

      const result = await activate(seller, productRef);
      expect(result.status).toBe(403);
      expect(result.body).toEqual({ error: "TAX_CLASSIFICATION_NOT_READY", blockers: ["TAX_CLASSIFICATION_NOT_READY"] });
    });

    it("Account.name is not a substitute for a declared first and last name", async () => {
      const seller = await readySeller();
      const { productRef } = await completeProduct(seller);
      await db.account.update({
        where: { id: seller.accountId },
        data: { name: "Ada Potter", firstName: null, lastName: null },
      });

      const result = await activate(seller, productRef);
      expect(result.body).toEqual({ error: "FIRST_NAME_MISSING", blockers: ["FIRST_NAME_MISSING", "LAST_NAME_MISSING"] });
    });
  });

  describe("lapses, and restoration never re-activates", () => {
    it("a revision that keeps the Product complete keeps it ACTIVE", async () => {
      const seller = await readySeller();
      const { productRef } = await completeProduct(seller);
      expect((await activate(seller, productRef)).status).toBe(200);

      expect((await revise(seller, productRef, { ...COMPLETE_BODY, description: "Stoneware, 400 ml." })).status).toBe(200);
      expect((await shown(seller, productRef)).lifecycle).toBe("ACTIVE");
    });

    it("a revision that breaks completeness → INCOMPLETE; completing it again → COMPLETE, not ACTIVE", async () => {
      const seller = await readySeller();
      const { productRef } = await completeProduct(seller);
      expect((await activate(seller, productRef)).status).toBe(200);

      expect((await revise(seller, productRef, { ...COMPLETE_BODY, shippingPolicy: null })).status).toBe(200);
      expect((await shown(seller, productRef)).lifecycle).toBe("INCOMPLETE");

      expect((await revise(seller, productRef, COMPLETE_BODY)).status).toBe(200);
      expect(await shown(seller, productRef)).toEqual({ lifecycle: "COMPLETE", blockers: [] });

      /* Only a new explicit activation restores it — and it supersedes the lapsed one. */
      expect((await activate(seller, productRef)).status).toBe(200);
      expect((await shown(seller, productRef)).lifecycle).toBe("ACTIVE");
    });

    it("payment readiness lost → COMPLETE; regained → still COMPLETE until the Seller activates again", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await completeProduct(seller);
      expect((await activate(seller, productRef)).status).toBe(200);

      await observePayment(seller.participantId, seller.providerAccountRef, "RESTRICTED");
      expect(await shown(seller, productRef)).toEqual({ lifecycle: "COMPLETE", blockers: ["PAYMENT_NOT_READY"] });

      await observePayment(seller.participantId, seller.providerAccountRef, "ENABLED");
      expect(await shown(seller, productRef)).toEqual({ lifecycle: "COMPLETE", blockers: [] });

      expect((await activate(seller, productRef)).status).toBe(200);
      expect((await shown(seller, productRef)).lifecycle).toBe("ACTIVE");
      const rows = await db.productActivation.findMany({ where: { internalProductId }, orderBy: { activatedAt: "asc" } });
      expect(rows.map((r) => r.currentForProductId === null)).toEqual([true, false]);
      expect(rows[0]!.supersededAt).not.toBeNull();
    });

    it("re-observing ENABLED without a lapse leaves the Product ACTIVE", async () => {
      const seller = await readySeller();
      const { productRef } = await completeProduct(seller);
      expect((await activate(seller, productRef)).status).toBe(200);

      await observePayment(seller.participantId, seller.providerAccountRef, "ENABLED");
      expect((await shown(seller, productRef)).lifecycle).toBe("ACTIVE");
    });

    it("a product:activate restriction imposed then lifted → COMPLETE, not ACTIVE", async () => {
      const seller = await readySeller();
      const { productRef } = await completeProduct(seller);
      expect((await activate(seller, productRef)).status).toBe(200);

      const imposed = await imposeParticipantRestriction(
        {
          participantId: seller.participantId,
          scope: "product:activate",
          reasonCode: "UNDERWRITING_REVIEW_REQUIRED",
          actingAccountId: RESTRICTOR,
          imposedAt: tick(),
        },
        { db },
      );
      expect((await shown(seller, productRef)).lifecycle).toBe("COMPLETE");

      await liftParticipantRestriction(
        {
          restrictionId: imposed.restriction.restrictionId,
          reasonCode: "ELIGIBILITY_RESTORED",
          actingAccountId: RESTRICTOR,
          liftedAt: tick(),
        },
        { db },
      );
      expect(await shown(seller, productRef)).toEqual({ lifecycle: "COMPLETE", blockers: [] });
    });

    it("commerce approval withdrawn then re-granted → COMPLETE, not ACTIVE", async () => {
      const seller = await readySeller();
      const { productRef } = await completeProduct(seller);
      expect((await activate(seller, productRef)).status).toBe(200);
      const approver = await seedOperator("participant:commerce-approve");

      await recordCommerceApproval(
        { participantId: seller.participantId, decision: "NOT_APPROVED", reasonCode: "REQUIREMENTS_OUTSTANDING", actingAccountId: approver, decidedAt: tick() },
        { db },
      );
      await recordCommerceApproval(
        { participantId: seller.participantId, decision: "APPROVED", reasonCode: "REQUIREMENTS_MET", actingAccountId: approver, decidedAt: tick() },
        { db },
      );
      expect(await shown(seller, productRef)).toEqual({ lifecycle: "COMPLETE", blockers: [] });
    });
  });

  describe("Product suspension and reinstatement", () => {
    it("ACTIVE → SUSPENDED refuses activation; reinstated with every fact intact → ACTIVE", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await completeProduct(seller);
      expect((await activate(seller, productRef)).status).toBe(200);

      const suspended = await suspendProduct(
        { internalProductId, reasonCode: "SAFETY_CONCERN", actingAccountId: SUSPENDER, suspendedAt: tick() },
        { db },
      );
      expect(suspended).toMatchObject({ status: "ACTIVE", lifecycleBeforeSuspension: "ACTIVE", lifecycleNow: "SUSPENDED" });
      expect((await shown(seller, productRef)).lifecycle).toBe("SUSPENDED");

      const refused = await activate(seller, productRef);
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual({ error: CODES.suspended });

      const lifted = await reinstateProduct(
        { suspensionId: suspended.suspensionId, reasonCode: "REVIEW_CONCLUDED", actingAccountId: SUSPENDER, reinstatedAt: tick() },
        { db },
      );
      expect(lifted).toMatchObject({ status: "LIFTED", lifecycleBeforeSuspension: "ACTIVE", lifecycleNow: "ACTIVE" });
      expect((await shown(seller, productRef)).lifecycle).toBe("ACTIVE");

      /* History is kept, not destroyed. */
      const row = await db.productSuspension.findUniqueOrThrow({ where: { id: suspended.suspensionId } });
      expect(row).toMatchObject({ status: "LIFTED", liftedByAccountId: SUSPENDER, activeForProductId: null });
    });

    it("COMPLETE before suspension stays COMPLETE after reinstatement — lifting never creates ACTIVE", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await completeProduct(seller);

      const suspended = await suspendProduct(
        { internalProductId, reasonCode: "MANUAL_OPERATIONAL_SUSPENSION", actingAccountId: SUSPENDER, suspendedAt: tick() },
        { db },
      );
      expect(suspended.lifecycleBeforeSuspension).toBe("COMPLETE");
      const lifted = await reinstateProduct(
        { suspensionId: suspended.suspensionId, reasonCode: "IMPOSED_IN_ERROR", actingAccountId: SUSPENDER, reinstatedAt: tick() },
        { db },
      );
      expect(lifted.lifecycleNow).toBe("COMPLETE");
    });

    it("a readiness lapse during suspension means reinstatement yields COMPLETE, not ACTIVE", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await completeProduct(seller);
      expect((await activate(seller, productRef)).status).toBe(200);

      const suspended = await suspendProduct(
        { internalProductId, reasonCode: "COMMERCE_INTEGRITY_REVIEW", actingAccountId: SUSPENDER, suspendedAt: tick() },
        { db },
      );
      await observePayment(seller.participantId, seller.providerAccountRef, "RESTRICTED");
      await observePayment(seller.participantId, seller.providerAccountRef, "ENABLED");

      const lifted = await reinstateProduct(
        { suspensionId: suspended.suspensionId, reasonCode: "REMEDIATION_COMPLETED", actingAccountId: SUSPENDER, reinstatedAt: tick() },
        { db },
      );
      expect(lifted.lifecycleNow).toBe("COMPLETE");
    });

    it("refuses an actor without the product:suspend grant, and the Seller acting on their own Product", async () => {
      const seller = await readySeller();
      const { internalProductId } = await completeProduct(seller);
      const ungranted = await seedOperator("participant:restrict");

      await expect(
        suspendProduct(
          { internalProductId, reasonCode: "SAFETY_CONCERN", actingAccountId: ungranted, suspendedAt: tick() },
          { db },
        ),
      ).rejects.toBeInstanceOf(ProductSuspensionNotAuthorizedError);

      await grantAccountEntitlement({ accountId: seller.accountId, capability: "product:suspend", grantedAt: NOW }, { db });
      await expect(
        suspendProduct(
          { internalProductId, reasonCode: "SAFETY_CONCERN", actingAccountId: seller.accountId, suspendedAt: tick() },
          { db },
        ),
      ).rejects.toBeInstanceOf(ProductSuspensionSelfActionNotPermittedError);
      expect(await db.productSuspension.count({ where: { internalProductId } })).toBe(0);
    });
  });

  describe("Monacado tax classification (operator authority)", () => {
    const versionsOf = (internalProductId: string) =>
      db.productSourceRecordVersionRow.findMany({ where: { internalProductId }, orderBy: { seq: "asc" } });

    it("refuses no session, a caller without the grant, and the owning Seller — before any Product is read — and writes nothing", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await completeProduct(seller, { taxClassified: false });
      const before = await versionsOf(internalProductId);
      const ungranted = await signedInOperator("product:suspend");

      expect((await classify(null, productRef, { taxClassification: "PHYSICAL_GOOD" })).status).toBe(401);
      for (const caller of [ungranted, seller]) {
        const refused = await classify(caller, productRef, { taxClassification: "PHYSICAL_GOOD" });
        expect(refused.status).toBe(403);
        expect(refused.body).toEqual({ error: TAX_CODES.notAuthorized });
      }
      /* Authorisation is answered first: an unknown reference is no different. */
      expect((await classify(ungranted, "0123456789ABCDEFGHJKMNPQRSTVWXYZ", { taxClassification: "PHYSICAL_GOOD" })).body).toEqual({
        error: TAX_CODES.notAuthorized,
      });
      /* And the Seller holding the grant still may not classify their own Product. */
      await grantAccountEntitlement({ accountId: seller.accountId, capability: "product:tax-classify", grantedAt: NOW }, { db });
      const self = await classify(seller, productRef, { taxClassification: "PHYSICAL_GOOD" });
      expect(self.status).toBe(403);
      expect(self.body).toEqual({ error: TAX_CODES.selfAction });

      expect(await versionsOf(internalProductId)).toEqual(before);
      expect(await db.productTaxClassificationAct.count({ where: { internalProductId } })).toBe(0);
    });

    it("an authorised operator classifies through a NEW immutable version, with audit evidence, and nothing else changes", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await completeProduct(seller, { taxClassified: false });
      const before = await versionsOf(internalProductId);
      const completenessBefore = await readCurrentProductCompleteness(db, internalProductId);

      const result = await classify(CLASSIFIER, productRef, { taxClassification: "PHYSICAL_GOOD" });
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ productRef, taxClassification: "PHYSICAL_GOOD" });

      const after = await versionsOf(internalProductId);
      expect(after).toHaveLength(before.length + 1);
      expect(after.slice(0, before.length)).toEqual(before);
      const prior = before[before.length - 1]!;
      const written = after[after.length - 1]!;
      expect(written.sourceRecordVersion).toBe(String(Number(prior.sourceRecordVersion) + 1));
      expect(written.taxClassification).toBe("PHYSICAL_GOOD");
      /* Every Seller fact, the shipping policy, and the creator authority carry forward. */
      const sellerOwned = (v: typeof prior) => ({
        factName: v.factName,
        factDescription: v.factDescription,
        factDeliveryMode: v.factDeliveryMode,
        factPromotable: v.factPromotable,
        factGeneralAvailabilityState: v.factGeneralAvailabilityState,
        shippingPolicyMethod: v.shippingPolicyMethod,
        authorityCreatorParticipantId: v.authorityCreatorParticipantId,
        authorityScope: v.authorityScope,
        authorityAuthorizationState: v.authorityAuthorizationState,
        recordStatus: v.recordStatus,
      });
      expect(sellerOwned(written)).toEqual(sellerOwned(prior));
      expect((await db.product.findUniqueOrThrow({ where: { internalProductId } })).productRef).toBe(productRef);

      const [act] = await db.productTaxClassificationAct.findMany({ where: { internalProductId } });
      expect(act).toMatchObject({
        sourceRecordVersion: written.sourceRecordVersion,
        previousTaxClassification: null,
        taxClassification: "PHYSICAL_GOOD",
        classifiedByAccountId: CLASSIFIER.accountId,
      });
      expect(act!.id).toMatch(/^mon:pdtax:/);

      /* Classification is operational readiness, not completeness. */
      expect(await readCurrentProductCompleteness(db, internalProductId)).toEqual(completenessBefore);
    });

    it("refuses an ungoverned classification, an extra field, a contradiction with delivery, and a no-op — writing nothing", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await completeProduct(seller);
      const before = await versionsOf(internalProductId);

      for (const body of [
        { taxClassification: "UNSPECIFIED" },
        { taxClassification: null },
        { taxClassification: "SERVICE", deliveryMode: "DIGITAL" },
        "not json",
      ]) {
        const refused = await classify(CLASSIFIER, productRef, body);
        expect(refused.status).toBe(400);
        expect(refused.body).toEqual({ error: TAX_CODES.invalidRequest });
      }
      const unchanged = await classify(CLASSIFIER, productRef, { taxClassification: "PHYSICAL_GOOD" });
      expect(unchanged.status).toBe(409);
      expect(unchanged.body).toEqual({ error: TAX_CODES.unchanged });
      const unknown = await classify(CLASSIFIER, "0123456789ABCDEFGHJKMNPQRSTVWXYZ", { taxClassification: "SERVICE" });
      expect(unknown.status).toBe(404);
      expect(await versionsOf(internalProductId)).toEqual(before);

      /* PHYSICAL_GOOD on a Product delivered DIGITAL is the one refused pairing. */
      const digital = await readySeller();
      const d = await completeProduct(digital, { taxClassified: false });
      expect(
        (await revise(digital, d.productRef, { name: "E-book", description: "A field guide.", deliveryMode: "DIGITAL", shippingPolicy: null }))
          .status,
      ).toBe(200);
      const contradiction = await classify(CLASSIFIER, d.productRef, { taxClassification: "PHYSICAL_GOOD" });
      expect(contradiction.status).toBe(409);
      expect(contradiction.body).toEqual({ error: TAX_CODES.contradictsDelivery });
      expect((await classify(CLASSIFIER, d.productRef, { taxClassification: "DIGITAL_GOOD" })).status).toBe(200);
    });

    it("clears the tax blocker of an otherwise-ready Product without activating it; the Seller still activates explicitly", async () => {
      const seller = await readySeller();
      const { productRef, internalProductId } = await completeProduct(seller, { taxClassified: false });
      expect(await shown(seller, productRef)).toEqual({ lifecycle: "COMPLETE", blockers: ["TAX_CLASSIFICATION_NOT_READY"] });
      const sellerPageToken = await currentToken(productRef);

      expect((await classify(CLASSIFIER, productRef, { taxClassification: "PHYSICAL_GOOD" })).status).toBe(200);
      expect(await shown(seller, productRef)).toEqual({ lifecycle: "COMPLETE", blockers: [] });
      expect(await db.productActivation.count({ where: { internalProductId } })).toBe(0);

      /* A page loaded before the classification names a superseded version. */
      expect((await activate(seller, productRef, sellerPageToken)).status).toBe(409);
      expect((await activate(seller, productRef)).status).toBe(200);
      expect((await shown(seller, productRef)).lifecycle).toBe("ACTIVE");
    });

    it("after activation: a valid reclassification keeps ACTIVE; a tax-invalid version in between lapses it until re-activated", async () => {
      const seller = await readySeller();
      const { productRef } = await completeProduct(seller);
      expect((await activate(seller, productRef)).status).toBe(200);

      /* Still ready, and every version since activation is tax-ready. */
      expect((await classify(CLASSIFIER, productRef, { taxClassification: "SERVICE" })).status).toBe(200);
      expect((await shown(seller, productRef)).lifecycle).toBe("ACTIVE");

      /* PHYSICAL_GOOD carried onto a DIGITAL revision is not tax-ready. */
      expect((await classify(CLASSIFIER, productRef, { taxClassification: "PHYSICAL_GOOD" })).status).toBe(200);
      expect(
        (await revise(seller, productRef, { name: "E-book", description: "A field guide.", deliveryMode: "DIGITAL", shippingPolicy: null }))
          .status,
      ).toBe(200);
      expect(await shown(seller, productRef)).toEqual({ lifecycle: "COMPLETE", blockers: ["TAX_CLASSIFICATION_NOT_READY"] });

      /* Correcting it restores readiness, never ACTIVE. */
      expect((await classify(CLASSIFIER, productRef, { taxClassification: "DIGITAL_GOOD" })).status).toBe(200);
      expect(await shown(seller, productRef)).toEqual({ lifecycle: "COMPLETE", blockers: [] });
      expect((await activate(seller, productRef)).status).toBe(200);
      expect((await shown(seller, productRef)).lifecycle).toBe("ACTIVE");
    });

    it("writes no Listing, Offer, Storefront, Order, payment, or publication state", async () => {
      const seller = await readySeller();
      const { productRef } = await completeProduct(seller, { taxClassified: false });
      const totals = async () => ({
        orders: await db.order.count(),
        listings: await db.listing.count(),
        offers: await db.offer.count(),
        storefronts: await db.storefront.count(),
        outbox: await db.publicationOutbox.count(),
        paymentAccounts: await db.participantPaymentAccount.count(),
        activations: await db.productActivation.count(),
      });
      const before = await totals();
      expect((await classify(CLASSIFIER, productRef, { taxClassification: "PHYSICAL_GOOD" })).status).toBe(200);
      expect(await totals()).toEqual(before);
    });
  });
});
