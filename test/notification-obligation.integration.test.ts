/**
 * Notification obligation integration tests (Phase 0M.N1).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * NO NETWORK and NO DELIVERY. Instants and identities are injected. Every value
 * is synthetic; no real personal data appears.
 *
 * **Test isolation.** Every identifier this suite creates carries the `N1T`
 * opaque prefix and every account address the `0n1t-` local part, and every
 * delete is filtered by one of those. No `deleteMany({})` appears anywhere.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { grantProductCreatorAuthority } from "./support/product-authority-fixture";
import { createAccount } from "../src/server/account/account-service";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import {
  createDraftOffer,
  createOfferSourceVersion,
  getSourceVersion as getOfferSourceVersion,
} from "../src/server/marketplace/offer-service";
import { createPromotedListing } from "../src/server/marketplace/listing-service";
import {
  acknowledgeNotificationObligation,
  advanceNotificationObligation,
  archiveNotificationObligation,
  createNotificationObligation,
  getNotificationObligation,
  listParticipantObligations,
  recordOfferChangeObligations,
  resolveNotificationObligation,
} from "../src/server/marketplace/notification-obligation-service";
import {
  DuplicateObligationError,
  InvalidObligationInputError,
  InvalidObligationTransitionError,
  ObligationNotFoundError,
  OfferVersionNotFoundError,
  RecipientParticipantNotFoundError,
} from "../src/server/marketplace/notification-obligation-errors";
import { PARTICIPANT_ID_PATTERNS } from "../src/server/marketplace/participant-ids";
import type { ParticipantIdProvider } from "../src/server/marketplace/participant-ids";
import { classifyOfferBusinessChanges } from "../src/contracts/marketplace/offer-source";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const TAG = "N1T";
const EMAIL_PREFIX = "0n1t-";
const PRODUCT_PREFIX = "mon:product:N1T";

const NOW = "2027-11-01T09:00:00.000Z";
const LATER = "2027-11-02T09:00:00.000Z";
const LATEST = "2027-11-03T09:00:00.000Z";
const PASSWORD = "correct-horse-battery-staple-0n1";
const ACTOR = "mon:actor:N1TACT0R000000000000000000";

const ACQUISITION_POLICY = {
  policyId: "mon:cpol:N1TP0LCY00000000000000000",
  policyVersion: "1",
  currency: "USD",
  retainedPercentageBasisPoints: 750,
  retainedFixedAmountMinorUnits: 100,
  roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
} as const;

let seq = 0;

function pad26(seed: string): string {
  const body = seed.toUpperCase().replace(/[ILOU]/g, "0");
  return (body + "0".repeat(26)).slice(0, 26);
}

function nextSuffix(): string {
  seq += 1;
  return pad26(`${TAG}${seq}`);
}

const ids: ParticipantIdProvider = {
  nextParticipantId: () => `mon:mpart:${nextSuffix()}`,
  nextRoleAssignmentId: () => `mon:mrole:${nextSuffix()}`,
  nextProfileId: () => `mon:mprof:${nextSuffix()}`,
  nextActivationId: () => `mon:mact:${nextSuffix()}`,
  nextPaymentAccountId: () => `mon:mpay:${nextSuffix()}`,
  nextRestrictionId: () => `mon:prst:${nextSuffix()}`,
  nextObligationId: () => `mon:nobl:${nextSuffix()}`,
};

const deps = () => ({ db, ids });

/** Delete only what this suite created, child-to-parent. */
async function cleanup(): Promise<void> {
  const owned = { startsWith: `mon:mpart:${TAG}` };

  await db.notificationObligation.deleteMany({ where: { recipientParticipantId: owned } });

  /* Offers, Listings, and Storefronts are created through their own services and
     so carry crypto identities. They are found by the prefixed PARTICIPANT
     columns instead, which is exactly as scoped and never touches another
     suite's rows. */
  const listingVersions = await db.listingSourceRecordVersionRow.findMany({
    where: { controllingParticipantId: owned },
    select: { internalListingId: true },
  });
  await db.listingSourceRecordVersionRow.deleteMany({
    where: { controllingParticipantId: owned },
  });
  await db.listing.deleteMany({
    where: { internalListingId: { in: listingVersions.map((v) => v.internalListingId) } },
  });
  await db.storefront.deleteMany({ where: { ownerParticipantId: owned } });
  await db.offerSourceRecordVersionRow.deleteMany({ where: { sellerParticipantId: owned } });
  await db.offer.deleteMany({ where: { sellerParticipantId: owned } });
  /* Phase 1.18 — the Offer fixture now records creator authority on the
     Product's current source version, so the version row has to go first. */
  await db.productSourceRecordVersionRow.deleteMany({
    where: { internalProductId: { startsWith: PRODUCT_PREFIX } },
  });
  await db.product.deleteMany({ where: { internalProductId: { startsWith: PRODUCT_PREFIX } } });
  await db.marketplaceRoleAssignment.deleteMany({ where: { participantId: owned } });
  await db.marketplaceParticipant.deleteMany({ where: { id: owned } });
  await db.accountSession.deleteMany({
    where: { account: { is: { email: { startsWith: EMAIL_PREFIX } } } },
  });
  await db.accountEntitlement.deleteMany({
    where: { account: { is: { email: { startsWith: EMAIL_PREFIX } } } },
  });
  await db.account.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
}

async function seedParticipant(roles: Array<"SELLER" | "PROMOTER">) {
  seq += 1;
  const account = await createAccount(
    {
      name: "Synthetic Person",
      email: `${EMAIL_PREFIX}${seq}@example.invalid`,
      password: PASSWORD,
      createdAt: NOW,
    },
    { db },
  );
  const snapshot = await createDraftParticipant(
    { accountId: account.accountId, initialRoles: roles, now: NOW },
    deps(),
  );
  return { participantId: snapshot.participant.participantId, accountId: account.accountId };
}

async function seedProduct(creatorParticipantId?: string): Promise<string> {
  seq += 1;
  const internalProductId = `${PRODUCT_PREFIX}${pad26(String(seq)).slice(0, 26 - TAG.length)}`;
  await db.product.create({
    data: {
      internalProductId,
      sourceRecordId: `mon:srec:${pad26(`${TAG}PSREC${seq}`)}`,
      currentSourceRecordVersion: "1",
      recordStatus: "DRAFT",
    },
  });
  if (creatorParticipantId !== undefined) {
    await grantProductCreatorAuthority(db, {
      internalProductId,
      participantId: creatorParticipantId,
    });
  }
  return internalProductId;
}

async function seedStorefront(ownerParticipantId: string): Promise<string> {
  seq += 1;
  const internalStorefrontId = `mon:storefront:${pad26(`${TAG}ST0RE${seq}`)}`;
  await db.storefront.create({
    data: {
      internalStorefrontId,
      storefrontSourceRecordId: `mon:srec:${pad26(`${TAG}SFSREC${seq}`)}`,
      currentSourceRecordVersion: "1",
      ownerParticipantId,
      publicHandle: `n1t-synthetic-shop-${seq}`,
      lifecycle: "DRAFT",
      visibility: "PRIVATE",
    },
  });
  return internalStorefrontId;
}

const OFFER_TERMS_V1 = {
  price: { type: "PAID" as const, wholesalePriceMinorUnits: 5_000, wholesalePriceCurrency: "USD" },
  promotion: {
    type: "PROMOTABLE" as const,
    commission: { method: "PERCENT_OF_WHOLESALE" as const, commissionBasisPoints: 2_000 },
  },
};

async function seedOffer(internalProductId: string, seller: { accountId: string; participantId: string }) {
  return createDraftOffer(
    {
      internalProductId,
      sellerParticipantId: seller.participantId,
      terms: OFFER_TERMS_V1,
      actingAccountId: seller.accountId,
      now: NOW,
    },
    { db },
  );
}

/**
 * One Offer with N promoters each carrying it in their own storefront, all bound
 * to version "1".
 */
async function seedOfferWithPromoters(promoterCount: number, storefrontsEach = 1) {
  const seller = await seedParticipant(["SELLER"]);
  const internalProductId = await seedProduct(seller.participantId);
  const offer = await seedOffer(internalProductId, seller);

  const promoters: Array<{ participantId: string; accountId: string }> = [];
  for (let i = 0; i < promoterCount; i += 1) {
    const promoter = await seedParticipant(["PROMOTER"]);
    for (let s = 0; s < storefrontsEach; s += 1) {
      const storefrontId = await seedStorefront(promoter.participantId);
      await createPromotedListing(
        {
          storefrontId,
          internalProductId,
          controllingParticipantId: promoter.participantId,
          retail: { retailPriceMinorUnits: 12_500, retailPriceCurrency: "USD" },
          acceptedOfferSourceRecordId: offer.record.offerSourceRecordId,
          acceptedOfferSourceRecordVersion: "1",
          acquisitionPolicy: ACQUISITION_POLICY,
          actingAccountId: promoter.accountId,
          now: NOW,
        },
        { db },
      );
    }
    promoters.push(promoter);
  }
  return { seller, internalProductId, offer, promoters };
}

/**
 * Mint Offer version "2" with a changed wholesale price, and classify the change
 * with the **committed** classifier — the notice must never disagree with it.
 */
async function raiseWholesalePrice(
  internalOfferId: string,
  seller: { accountId: string; participantId: string },
) {
  const prior = await getOfferSourceVersion(internalOfferId, "1", { db });
  const next = await createOfferSourceVersion(
    {
      internalOfferId,
      sourceRecordVersion: "2",
      terms: {
        ...OFFER_TERMS_V1,
        price: {
          type: "PAID" as const,
          wholesalePriceMinorUnits: 6_000,
          wholesalePriceCurrency: "USD",
        },
      },
      actingAccountId: seller.accountId,
      now: LATER,
    },
    { db },
  );
  const categories = classifyOfferBusinessChanges(prior, next.currentVersion);
  return { prior, next, categories };
}

const describeDb = RUN ? describe : describe.skip;

describeDb("Phase 0M.N1 — notification obligation records", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  // — 1. Creation and retrieval —

  describe("1. creation, retrieval, and recipient integrity", () => {
    it("creates an obligation UNREAD and retrieves it", async () => {
      const promoter = await seedParticipant(["PROMOTER"]);
      const created = await createNotificationObligation(
        {
          recipientParticipantId: promoter.participantId,
          category: "OFFER_CHANGE",
          subject: { kind: "OFFER", ref: `mon:srec:${pad26(`${TAG}X`)}`, versionRef: "2" },
          contextCode: "WHOLESALE_PRICE_CHANGED",
          createdAt: NOW,
        },
        deps(),
      );

      expect(created.obligationId).toMatch(PARTICIPANT_ID_PATTERNS.obligation);
      expect(created.status).toBe("UNREAD");
      expect(created.createdAt).toBe(NOW);
      expect(created.acknowledgedAt).toBeNull();

      const read = await getNotificationObligation(created.obligationId, deps());
      expect(read).toEqual(created);
    });

    it("refuses a recipient participant that does not exist", async () => {
      await expect(
        createNotificationObligation(
          {
            recipientParticipantId: `mon:mpart:${pad26(`${TAG}GH0ST`)}`,
            category: "OFFER_CHANGE",
            subject: { kind: "OFFER", ref: "mon:srec:X", versionRef: "1" },
            contextCode: "WHOLESALE_PRICE_CHANGED",
            createdAt: NOW,
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(RecipientParticipantNotFoundError);
    });

    it("refuses deleting a participant that is owed an obligation", async () => {
      const promoter = await seedParticipant(["PROMOTER"]);
      await createNotificationObligation(
        {
          recipientParticipantId: promoter.participantId,
          category: "OFFER_CHANGE",
          subject: { kind: "OFFER", ref: "mon:srec:Y", versionRef: "1" },
          contextCode: "WHOLESALE_PRICE_CHANGED",
          createdAt: NOW,
        },
        deps(),
      );
      await expect(
        db.marketplaceParticipant.delete({ where: { id: promoter.participantId } }),
      ).rejects.toMatchObject({ code: "P2003" });
    });

    it("refuses an unknown category and an unknown subject kind", async () => {
      const promoter = await seedParticipant(["PROMOTER"]);
      for (const bad of [{ category: "SOMETHING" }, { subject: { kind: "WIDGET", ref: "x", versionRef: null } }]) {
        await expect(
          createNotificationObligation(
            {
              recipientParticipantId: promoter.participantId,
              category: "OFFER_CHANGE",
              subject: { kind: "OFFER", ref: "mon:srec:Z", versionRef: "1" },
              contextCode: "WHOLESALE_PRICE_CHANGED",
              createdAt: NOW,
              ...bad,
            },
            deps(),
          ),
        ).rejects.toBeInstanceOf(InvalidObligationInputError);
      }
    });

    it("refuses a duplicate through the general create path", async () => {
      const promoter = await seedParticipant(["PROMOTER"]);
      const input = {
        recipientParticipantId: promoter.participantId,
        category: "OFFER_CHANGE",
        subject: { kind: "OFFER", ref: `mon:srec:${pad26(`${TAG}D`)}`, versionRef: "2" },
        contextCode: "WHOLESALE_PRICE_CHANGED",
        createdAt: NOW,
      };
      await createNotificationObligation(input, deps());
      await expect(createNotificationObligation(input, deps())).rejects.toBeInstanceOf(
        DuplicateObligationError,
      );
    });

    it("a future 0M.9 category persists with no schema change", async () => {
      const buyer = await seedParticipant(["PROMOTER"]);
      const created = await createNotificationObligation(
        {
          recipientParticipantId: buyer.participantId,
          category: "ORDER_CONFIRMATION",
          subject: { kind: "ORDER", ref: `mon:order:${pad26(`${TAG}0RD`)}`, versionRef: null },
          contextCode: null,
          createdAt: NOW,
        },
        deps(),
      );
      expect(created.category).toBe("ORDER_CONFIRMATION");
      expect(created.subject.versionRef).toBeNull();
      expect(created.contextCode).toBeNull();
    });
  });

  // — 2. Lifecycle —

  describe("2. lifecycle transitions and retention", () => {
    async function seedObligation() {
      const promoter = await seedParticipant(["PROMOTER"]);
      seq += 1;
      return createNotificationObligation(
        {
          recipientParticipantId: promoter.participantId,
          category: "OFFER_CHANGE",
          subject: { kind: "OFFER", ref: `mon:srec:${pad26(`${TAG}L${seq}`)}`, versionRef: "2" },
          contextCode: "WHOLESALE_PRICE_CHANGED",
          createdAt: NOW,
        },
        deps(),
      );
    }

    it("acknowledging stamps its instant and keeps createdAt", async () => {
      const o = await seedObligation();
      const acked = await acknowledgeNotificationObligation(o.obligationId, LATER, deps());
      expect(acked.status).toBe("ACKNOWLEDGED");
      expect(acked.acknowledgedAt).toBe(LATER);
      expect(acked.createdAt).toBe(NOW);
      expect(acked.resolvedAt).toBeNull();
    });

    it("resolving after acknowledging keeps both instants", async () => {
      const o = await seedObligation();
      await acknowledgeNotificationObligation(o.obligationId, LATER, deps());
      const resolved = await resolveNotificationObligation(o.obligationId, LATEST, deps());
      expect(resolved.status).toBe("RESOLVED");
      expect(resolved.acknowledgedAt).toBe(LATER);
      expect(resolved.resolvedAt).toBe(LATEST);
    });

    it("archiving is not deletion — the row and every instant survive", async () => {
      const o = await seedObligation();
      await acknowledgeNotificationObligation(o.obligationId, LATER, deps());
      const archived = await archiveNotificationObligation(o.obligationId, LATEST, deps());

      expect(archived.status).toBe("ARCHIVED");
      expect(archived.archivedAt).toBe(LATEST);
      expect(archived.acknowledgedAt).toBe(LATER);
      expect(await db.notificationObligation.count({ where: { id: o.obligationId } })).toBe(1);
      expect(await getNotificationObligation(o.obligationId, deps())).toBeTruthy();
    });

    it("refuses a backwards transition", async () => {
      const o = await seedObligation();
      await acknowledgeNotificationObligation(o.obligationId, LATER, deps());
      await expect(
        advanceNotificationObligation(
          { obligationId: o.obligationId, to: "UNREAD", at: LATEST },
          deps(),
        ),
      ).rejects.toBeInstanceOf(InvalidObligationTransitionError);
    });

    it("refuses any transition out of ARCHIVED", async () => {
      const o = await seedObligation();
      await archiveNotificationObligation(o.obligationId, LATER, deps());
      for (const to of ["ACKNOWLEDGED", "RESOLVED", "UNREAD"] as const) {
        await expect(
          advanceNotificationObligation({ obligationId: o.obligationId, to, at: LATEST }, deps()),
        ).rejects.toBeInstanceOf(InvalidObligationTransitionError);
      }
    });

    it("refuses advancing an obligation that does not exist", async () => {
      await expect(
        acknowledgeNotificationObligation(`mon:nobl:${pad26(`${TAG}N0NE`)}`, LATER, deps()),
      ).rejects.toBeInstanceOf(ObligationNotFoundError);
    });

    it("lists a participant's obligations, and narrows to the working set", async () => {
      const promoter = await seedParticipant(["PROMOTER"]);
      const mk = async (n: string) =>
        createNotificationObligation(
          {
            recipientParticipantId: promoter.participantId,
            category: "OFFER_CHANGE",
            subject: { kind: "OFFER", ref: `mon:srec:${pad26(`${TAG}${n}`)}`, versionRef: "2" },
            contextCode: "WHOLESALE_PRICE_CHANGED",
            createdAt: NOW,
          },
          deps(),
        );
      const open = await mk("A");
      const done = await mk("B");
      await archiveNotificationObligation(done.obligationId, LATER, deps());

      const all = await listParticipantObligations(promoter.participantId, {}, deps());
      expect(all).toHaveLength(2);

      const working = await listParticipantObligations(
        promoter.participantId,
        { statuses: ["UNREAD", "ACKNOWLEDGED"] },
        deps(),
      );
      expect(working.map((o) => o.obligationId)).toEqual([open.obligationId]);
    });
  });

  // — 3. Offer-change obligation —

  describe("3. the governed Offer-change obligation", () => {
    it("records one obligation per affected promoter and change category", async () => {
      const { seller, offer, promoters } = await seedOfferWithPromoters(2);
      const { categories } = await raiseWholesalePrice(offer.record.internalOfferId, seller);
      expect(categories).toContain("WHOLESALE_PRICE_CHANGED");

      const recorded = await recordOfferChangeObligations(
        {
          internalOfferId: offer.record.internalOfferId,
          offerSourceRecordId: offer.record.offerSourceRecordId,
          effectiveOfferSourceRecordVersion: "2",
          priorOfferSourceRecordVersion: "1",
          changeCategories: [...categories],
          createdAt: LATER,
        },
        deps(),
      );

      expect(recorded).toHaveLength(promoters.length * categories.length);
      for (const promoter of promoters) {
        const owed = await listParticipantObligations(promoter.participantId, {}, deps());
        expect(owed).toHaveLength(categories.length);
        expect(owed[0]!.category).toBe("OFFER_CHANGE");
        expect(owed[0]!.subject.kind).toBe("OFFER");
        expect(owed[0]!.subject.ref).toBe(offer.record.offerSourceRecordId);
        expect(owed[0]!.subject.versionRef).toBe("2");
      }
    });

    /** §3a: one notice per promoter, not per Listing or per storefront. */
    it("a promoter carrying the Offer in three storefronts gets ONE notice", async () => {
      const { seller, offer, promoters } = await seedOfferWithPromoters(1, 3);
      await raiseWholesalePrice(offer.record.internalOfferId, seller);

      await recordOfferChangeObligations(
        {
          internalOfferId: offer.record.internalOfferId,
          offerSourceRecordId: offer.record.offerSourceRecordId,
          effectiveOfferSourceRecordVersion: "2",
          priorOfferSourceRecordVersion: "1",
          changeCategories: ["WHOLESALE_PRICE_CHANGED"],
          createdAt: LATER,
        },
        deps(),
      );

      const owed = await listParticipantObligations(promoters[0]!.participantId, {}, deps());
      expect(owed).toHaveLength(1);
    });

    it("is idempotent — replaying the change creates no second notice", async () => {
      const { seller, offer, promoters } = await seedOfferWithPromoters(1);
      await raiseWholesalePrice(offer.record.internalOfferId, seller);

      const input = {
        internalOfferId: offer.record.internalOfferId,
        offerSourceRecordId: offer.record.offerSourceRecordId,
        effectiveOfferSourceRecordVersion: "2",
        priorOfferSourceRecordVersion: "1",
        changeCategories: ["WHOLESALE_PRICE_CHANGED"] as const,
        createdAt: LATER,
      };
      const first = await recordOfferChangeObligations(input, deps());
      const second = await recordOfferChangeObligations(input, deps());

      expect(second.map((o) => o.obligationId)).toEqual(first.map((o) => o.obligationId));
      expect(
        await listParticipantObligations(promoters[0]!.participantId, {}, deps()),
      ).toHaveLength(1);
    });

    /** A replay must not silently return an acknowledged notice to UNREAD. */
    it("a replay does not reset an already-acknowledged obligation", async () => {
      const { seller, offer } = await seedOfferWithPromoters(1);
      await raiseWholesalePrice(offer.record.internalOfferId, seller);
      const input = {
        internalOfferId: offer.record.internalOfferId,
        offerSourceRecordId: offer.record.offerSourceRecordId,
        effectiveOfferSourceRecordVersion: "2",
        priorOfferSourceRecordVersion: "1",
        changeCategories: ["WHOLESALE_PRICE_CHANGED"] as const,
        createdAt: LATER,
      };
      const [only] = await recordOfferChangeObligations(input, deps());
      await acknowledgeNotificationObligation(only!.obligationId, LATEST, deps());

      const replayed = await recordOfferChangeObligations(input, deps());
      expect(replayed[0]!.status).toBe("ACKNOWLEDGED");
      expect(replayed[0]!.acknowledgedAt).toBe(LATEST);
    });

    /** A different Offer version is a different thing to decide. */
    it("a later Offer version creates a new obligation", async () => {
      const { seller, offer, promoters } = await seedOfferWithPromoters(1);
      await raiseWholesalePrice(offer.record.internalOfferId, seller);

      await recordOfferChangeObligations(
        {
          internalOfferId: offer.record.internalOfferId,
          offerSourceRecordId: offer.record.offerSourceRecordId,
          effectiveOfferSourceRecordVersion: "2",
          priorOfferSourceRecordVersion: "1",
          changeCategories: ["WHOLESALE_PRICE_CHANGED"],
          createdAt: LATER,
        },
        deps(),
      );
      await recordOfferChangeObligations(
        {
          internalOfferId: offer.record.internalOfferId,
          offerSourceRecordId: offer.record.offerSourceRecordId,
          effectiveOfferSourceRecordVersion: "2",
          priorOfferSourceRecordVersion: "1",
          changeCategories: ["COMMISSION_TERMS_CHANGED"],
          createdAt: LATEST,
        },
        deps(),
      );

      const owed = await listParticipantObligations(promoters[0]!.participantId, {}, deps());
      expect(owed).toHaveLength(2);
      expect(owed.map((o) => o.contextCode).sort()).toEqual([
        "COMMISSION_TERMS_CHANGED",
        "WHOLESALE_PRICE_CHANGED",
      ]);
    });

    it("each affected promoter receives its own obligation", async () => {
      const { seller, offer, promoters } = await seedOfferWithPromoters(3);
      await raiseWholesalePrice(offer.record.internalOfferId, seller);

      await recordOfferChangeObligations(
        {
          internalOfferId: offer.record.internalOfferId,
          offerSourceRecordId: offer.record.offerSourceRecordId,
          effectiveOfferSourceRecordVersion: "2",
          priorOfferSourceRecordVersion: "1",
          changeCategories: ["WHOLESALE_PRICE_CHANGED"],
          createdAt: LATER,
        },
        deps(),
      );

      for (const promoter of promoters) {
        const owed = await listParticipantObligations(promoter.participantId, {}, deps());
        expect(owed).toHaveLength(1);
        expect(owed[0]!.recipientParticipantId).toBe(promoter.participantId);
      }
    });

    /** A promoter bound to a different version is not carrying these terms. */
    it("a promoter on an unrelated Offer receives nothing", async () => {
      const affected = await seedOfferWithPromoters(1);
      const unrelated = await seedOfferWithPromoters(1);
      await raiseWholesalePrice(affected.offer.record.internalOfferId, affected.seller);

      await recordOfferChangeObligations(
        {
          internalOfferId: affected.offer.record.internalOfferId,
          offerSourceRecordId: affected.offer.record.offerSourceRecordId,
          effectiveOfferSourceRecordVersion: "2",
          priorOfferSourceRecordVersion: "1",
          changeCategories: ["WHOLESALE_PRICE_CHANGED"],
          createdAt: LATER,
        },
        deps(),
      );

      expect(
        await listParticipantObligations(unrelated.promoters[0]!.participantId, {}, deps()),
      ).toHaveLength(0);
    });

    it("refuses an effective Offer version that does not exist", async () => {
      const { offer } = await seedOfferWithPromoters(1);
      await expect(
        recordOfferChangeObligations(
          {
            internalOfferId: offer.record.internalOfferId,
            offerSourceRecordId: offer.record.offerSourceRecordId,
            effectiveOfferSourceRecordVersion: "99",
            priorOfferSourceRecordVersion: "1",
            changeCategories: ["WHOLESALE_PRICE_CHANGED"],
            createdAt: LATER,
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(OfferVersionNotFoundError);
    });

    it("binds the obligation to the exact effective source version", async () => {
      const { seller, offer, promoters } = await seedOfferWithPromoters(1);
      await raiseWholesalePrice(offer.record.internalOfferId, seller);

      await recordOfferChangeObligations(
        {
          internalOfferId: offer.record.internalOfferId,
          offerSourceRecordId: offer.record.offerSourceRecordId,
          effectiveOfferSourceRecordVersion: "2",
          priorOfferSourceRecordVersion: "1",
          changeCategories: ["WHOLESALE_PRICE_CHANGED"],
          createdAt: LATER,
        },
        deps(),
      );

      const [owed] = await listParticipantObligations(promoters[0]!.participantId, {}, deps());
      expect(owed!.subject.versionRef).toBe("2");
      expect(owed!.subject.ref).toBe(offer.record.offerSourceRecordId);

      // The version it names actually exists.
      const version = await db.offerSourceRecordVersionRow.findUnique({
        where: {
          offerSourceRecordId_sourceRecordVersion: {
            offerSourceRecordId: owed!.subject.ref,
            sourceRecordVersion: owed!.subject.versionRef!,
          },
        },
      });
      expect(version).not.toBeNull();
    });

    it("stores no delivery column at all", async () => {
      const columns = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'NotificationObligation'`,
      );
      const names = columns.map((c) => c.COLUMN_NAME.toLowerCase());
      for (const forbidden of [
        "channel",
        "email",
        "phone",
        "devicetoken",
        "subjectline",
        "body",
        "template",
        "rendered",
        "locale",
        "attempt",
        "retry",
        "sentat",
        "providermessage",
        "note",
      ]) {
        expect(names.some((n) => n.includes(forbidden)), forbidden).toBe(false);
      }
      expect(names).toContain("recipientparticipantid");
      expect(names).toContain("obligationkey");
    });
  });
});
