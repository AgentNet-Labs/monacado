/**
 * A ready Seller and an ACTIVE Product, through the real paths (Phase 1.42).
 *
 * Offer activation and resumption require an ACTIVE Product and full Seller
 * readiness — verified email, declared names, participant and SELLER role
 * ACTIVE, payment ENABLED, commerce APPROVED. The Offer suites must prove the
 * acts against exactly that, so this builds it the way Phase 1.40/1.41 suites
 * do: the draft, revision, tax-classification, and activation route handlers,
 * the payment-account and commerce-approval services. Participant and role
 * status are set directly, as those suites do — no service activates them yet.
 *
 * Synthetic data only, scoped by an email prefix; `cleanup` deletes exactly
 * what a suite created, children first, Offer rows included.
 */

import { expect } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { createAccount } from "../../src/server/account/account-service";
import { createAccountSession } from "../../src/server/account/account-session-service";
import { grantAccountEntitlement } from "../../src/server/account/account-entitlement-service";
import { SESSION_COOKIE_NAME } from "../../src/server/account/session-cookie";
import { createDraftParticipant } from "../../src/server/marketplace/participant-service";
import {
  recordObservedProviderState,
  registerParticipantPaymentAccount,
} from "../../src/server/marketplace/payment-account-service";
import { recordCommerceApproval } from "../../src/server/marketplace/participant-commerce-approval-service";
import { handleCreateDraftProductRequest } from "../../src/server/product/product-draft-route-handler";
import { handleReviseProductRequest } from "../../src/server/product/product-revision-route-handler";
import { handleActivateProductRequest } from "../../src/server/product/product-activation-route-handler";
import { handleClassifyProductTaxRequest } from "../../src/server/product/product-tax-classification-route-handler";
import { productRevisionToken } from "../../src/server/product/product-revision-token";

export interface FixtureActor {
  accountId: string;
  participantId: string;
  cookieHeader: string;
}

export interface FixtureProduct {
  productRef: string;
  internalProductId: string;
}

const COMPLETE_BODY = {
  name: "Hand-thrown mug",
  description: "Stoneware, 350 ml.",
  deliveryMode: "PHYSICAL",
  shippingPolicy: { method: "FREE" },
};

export function sellerCommerceFixture(config: { db: PrismaClient; emailPrefix: string; now: string; origin: string }) {
  const { db, emailPrefix, now: NOW, origin: ORIGIN } = config;
  let seq = 0;
  let clock = 0;
  /** A strictly increasing instant after NOW, one minute per call. */
  const tick = (): string => new Date(Date.parse(NOW) + (clock += 1) * 60_000).toISOString();
  let classifier: { accountId: string; cookieHeader: string } | undefined;

  async function session(accountId: string): Promise<string> {
    const { token } = await createAccountSession({ accountId, createdAt: NOW, ttlSeconds: 7 * 24 * 3_600 }, { db });
    return `${SESSION_COOKIE_NAME}=${token}`;
  }

  async function seedOperator(capability: string): Promise<string> {
    seq += 1;
    const account = await createAccount(
      { name: "Operator", email: `${emailPrefix}op${seq}@example.com`, password: "correct horse battery staple", createdAt: NOW },
      { db },
    );
    await grantAccountEntitlement({ accountId: account.accountId, capability, grantedAt: NOW }, { db });
    return account.accountId;
  }

  /** A DRAFT participant holding `roles` in DRAFT, with verified email and declared names. */
  async function draftParticipant(roles: Array<"SELLER" | "PROMOTER">, opts: { verified?: boolean } = {}): Promise<FixtureActor> {
    seq += 1;
    const account = await createAccount(
      {
        name: `Participant ${seq}`,
        firstName: "Sam",
        lastName: "Seller",
        email: `${emailPrefix}${seq}@example.com`,
        password: "correct horse battery staple",
        createdAt: NOW,
        ...(opts.verified === false ? {} : { emailVerification: "ADMINISTRATIVE" as const }),
      },
      { db },
    );
    const snapshot = await createDraftParticipant({ accountId: account.accountId, initialRoles: roles, now: NOW }, { db });
    return {
      accountId: account.accountId,
      participantId: snapshot.participant.participantId,
      cookieHeader: await session(account.accountId),
    };
  }

  /** A Seller meeting every activation gate (the Phase 1.40 fixture). */
  async function readySeller(): Promise<FixtureActor> {
    const seller = await draftParticipant(["SELLER"]);
    await db.marketplaceParticipant.update({ where: { id: seller.participantId }, data: { status: "ACTIVE" } });
    await db.marketplaceRoleAssignment.updateMany({
      where: { participantId: seller.participantId, role: "SELLER" },
      data: { status: "ACTIVE", activatedAt: new Date(NOW) },
    });
    const providerAccountRef = `acct_${emailPrefix}_${seq}`;
    await registerParticipantPaymentAccount(
      { participantId: seller.participantId, provider: "STRIPE", providerAccountRef, now: NOW },
      { db },
    );
    for (const readiness of ["PENDING_PROVIDER", "ENABLED"]) {
      await recordObservedProviderState(
        {
          participantId: seller.participantId,
          provider: "STRIPE",
          providerAccountRef,
          readiness,
          outstandingRequirements: [],
          observedAt: tick(),
        },
        { db },
      );
    }
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

  async function currentToken(productRef: string): Promise<string> {
    const row = await db.product.findUniqueOrThrow({ where: { productRef } });
    return productRevisionToken(row.sourceRecordId, row.currentSourceRecordVersion);
  }

  /** A private draft Product through the real draft route. */
  async function draftProduct(seller: FixtureActor): Promise<FixtureProduct> {
    const drafted = await handleCreateDraftProductRequest(
      {
        contentType: "application/json",
        originHeader: ORIGIN,
        cookieHeader: seller.cookieHeader,
        rawBody: JSON.stringify({
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

  /**
   * An ACTIVE Product: complete, Monacado-classified, activated by its ready
   * Seller. `content` (Phase 1.43) varies the name, description, and delivery
   * mode — a DIGITAL Product is classified `DIGITAL_GOOD` and has no shipping.
   */
  async function activeProduct(
    seller: FixtureActor,
    content: { name?: string; description?: string; deliveryMode?: "PHYSICAL" | "DIGITAL" } = {},
  ): Promise<FixtureProduct> {
    const product = await draftProduct(seller);
    const digital = content.deliveryMode === "DIGITAL";
    const body = {
      ...COMPLETE_BODY,
      ...(content.name !== undefined ? { name: content.name } : {}),
      ...(content.description !== undefined ? { description: content.description } : {}),
      ...(digital ? { deliveryMode: "DIGITAL", shippingPolicy: null } : {}),
    };
    const revised = await handleReviseProductRequest(
      {
        productRef: product.productRef,
        contentType: "application/json",
        originHeader: ORIGIN,
        cookieHeader: seller.cookieHeader,
        rawBody: JSON.stringify({ expectedRevision: await currentToken(product.productRef), ...body }),
      },
      { db, now: tick, appOrigin: ORIGIN },
    );
    expect(revised.status).toBe(200);
    if (classifier === undefined) {
      const accountId = await seedOperator("product:tax-classify");
      classifier = { accountId, cookieHeader: await session(accountId) };
    }
    const classified = await handleClassifyProductTaxRequest(
      {
        productRef: product.productRef,
        contentType: "application/json",
        originHeader: ORIGIN,
        cookieHeader: classifier.cookieHeader,
        rawBody: JSON.stringify({ taxClassification: digital ? "DIGITAL_GOOD" : "PHYSICAL_GOOD" }),
      },
      { db, now: tick, appOrigin: ORIGIN },
    );
    expect(classified.status).toBe(200);
    const activated = await handleActivateProductRequest(
      {
        productRef: product.productRef,
        contentType: "application/json",
        originHeader: ORIGIN,
        cookieHeader: seller.cookieHeader,
        rawBody: JSON.stringify({ expectedRevision: await currentToken(product.productRef) }),
      },
      { db, now: tick, appOrigin: ORIGIN },
    );
    expect(activated.status).toBe(200);
    return product;
  }

  /** Delete exactly what this suite created, children first. */
  async function cleanup(): Promise<void> {
    classifier = undefined;
    const accountIds = (
      await db.account.findMany({ where: { email: { startsWith: emailPrefix } }, select: { id: true } })
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
    const offerIds = (
      await db.offer.findMany({
        where: { OR: [{ internalProductId: { in: productIds } }, { sellerParticipantId: { in: participantIds } }] },
        select: { internalOfferId: true },
      })
    ).map((o) => o.internalOfferId);
    await db.offerAct.deleteMany({ where: { internalOfferId: { in: offerIds } } });
    await db.offerSourceRecordVersionRow.deleteMany({ where: { internalOfferId: { in: offerIds } } });
    await db.offer.deleteMany({ where: { internalOfferId: { in: offerIds } } });
    const cycleIds = (
      await db.promotionAuthorization.findMany({
        where: { OR: [{ internalProductId: { in: productIds } }, { promoterParticipantId: { in: participantIds } }] },
        select: { id: true },
      })
    ).map((c) => c.id);
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

  return { tick, session, seedOperator, draftParticipant, readySeller, draftProduct, activeProduct, cleanup };
}
