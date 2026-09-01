/**
 * Offer persistence integration tests (Phase 0M.6).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * NO NETWORK. Instants and identities are injected, so nothing depends on a real
 * clock. Every value is synthetic; no real personal data appears.
 *
 * The tests that matter most are the round-trip ones: a persisted source version
 * must reconstruct into the exact contract shape `projectOfferCapsule` already
 * consumes, and must produce a byte-identical capsule to the equivalent
 * in-memory source. That is the whole reason this phase exists.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import { grantProductCreatorAuthority } from "./support/product-authority-fixture";
import {
  createDraftOffer,
  createOfferSourceVersion,
  evaluateOfferState,
  getCurrentSourceVersion,
  getOffer,
  getSourceVersion,
  listSourceVersions,
} from "../src/server/marketplace/offer-service";
import {
  CorruptOfferRecordError,
  DuplicateOfferSourceVersionError,
  InvalidOfferInputError,
  NoMaterialOfferChangeError,
  OfferNotAuthorizedError,
  OfferNotFoundError,
  OfferProductNotFoundError,
  OfferVersionNotFoundError,
  SellerParticipantNotFoundError,
} from "../src/server/marketplace/offer-errors";
import { OFFER_ID_PATTERNS } from "../src/server/marketplace/offer-ids";
import { versionRowToSourceVersion } from "../src/server/marketplace/offer-mapper";
import {
  OfferSourceVersion,
  calculateOfferEconomics,
} from "../src/contracts/marketplace/offer-source";
import {
  OFFER_PROJECTION_MAPPING_VERSION,
  projectOfferCapsule,
} from "../src/contracts/marketplace/offer.projection";
import { canonicalJsonString } from "../src/contracts/integrity/canonical-json";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2027-10-01T09:00:00.000Z";
const LATER = "2027-10-02T09:00:00.000Z";
const PASSWORD = "correct-horse-battery-staple-9271";

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

let seq = 0;

const ACTOR = `mon:actor:${pad26("M6ACTOR")}`;

/** `JSON.stringify` refuses BigInt, and version rows carry a BigInt `seq`. */
const safeStringify = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

/* Crockford alphabet only — it excludes I, L, O, and U, so the tag uses a
   zero rather than the letter O. */
const PRODUCT_ID_TAG = "M6PR0D";
const PRODUCT_PREFIX = `mon:product:${PRODUCT_ID_TAG}`;
const ACCOUNT_EMAIL_PREFIX = "offer-seller";

/**
 * Remove only what THIS suite creates.
 *
 * Deliberately **scoped**, not a global truncate. An earlier draft deleted every
 * Product and every Account, which passed in isolation and failed in the full
 * suite: other suites' Products are referenced by their Nodes, publications, and
 * outbox rows, so a blanket delete hit the very RESTRICT rules this phase
 * relies on. Destroying another suite's fixtures to tidy up after this one is
 * the wrong trade in both directions — so identities are prefixed and cleanup
 * matches on the prefix.
 *
 * Children still go before parents, which documents the delete rules.
 */
async function cleanup(): Promise<void> {
  await db.offerSourceRecordVersionRow.deleteMany({});
  await db.offer.deleteMany({});

  const accounts = await db.account.findMany({
    where: { email: { startsWith: ACCOUNT_EMAIL_PREFIX } },
    select: { id: true },
  });
  /* Product source versions first: Phase 1.18 made them reference the creator
     participant with onDelete: Restrict, so a participant that authored one
     cannot be deleted beneath it — which is the point of the constraint. */
  await db.productSourceRecordVersionRow.deleteMany({
    where: { internalProductId: { startsWith: PRODUCT_PREFIX } },
  });

  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length > 0) {
    const participants = await db.marketplaceParticipant.findMany({
      where: { accountId: { in: accountIds } },
      select: { id: true },
    });
    const participantIds = participants.map((p) => p.id);
    if (participantIds.length > 0) {
      await db.participantActivation.deleteMany({
        where: { participantId: { in: participantIds } },
      });
      await db.participantProfile.deleteMany({
        where: { participantId: { in: participantIds } },
      });
      await db.marketplaceRoleAssignment.deleteMany({
        where: { participantId: { in: participantIds } },
      });
      await db.marketplaceParticipant.deleteMany({ where: { id: { in: participantIds } } });
    }
    await db.accountEntitlement.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
    await db.account.deleteMany({ where: { id: { in: accountIds } } });
  }

  await db.product.deleteMany({ where: { internalProductId: { startsWith: PRODUCT_PREFIX } } });
}

/**
 * A persisted Product for an Offer to name, with its creator authority recorded.
 *
 * `creatorParticipantId` is optional: omitting it produces a Product whose
 * current source version names no participant, which is the historical NULL the
 * derivation must fail closed on.
 */
async function seedProduct(creatorParticipantId?: string): Promise<string> {
  seq += 1;
  const internalProductId = `${PRODUCT_PREFIX}${pad26(String(seq)).slice(0, 26 - PRODUCT_ID_TAG.length)}`;
  await db.product.create({
    data: {
      internalProductId,
      sourceRecordId: `mon:srec:${pad26(`M6PSREC${seq}`)}`,
      currentSourceRecordVersion: "1",
      recordStatus: "DRAFT",
    },
  });
  if (creatorParticipantId !== undefined) {
    await grantProductCreatorAuthority(db, {
      internalProductId,
      participantId: creatorParticipantId,
      now: NOW,
    });
  }
  return internalProductId;
}

/** A participant holding a SELLER role, able to draft an Offer. */
async function seedSeller(): Promise<{ participantId: string; accountId: string }> {
  seq += 1;
  const account = await createAccount(
    {
      name: "Synthetic Seller",
      email: `${ACCOUNT_EMAIL_PREFIX}${seq}@example.com`,
      password: PASSWORD,
      createdAt: NOW,
    },
    { db },
  );
  const snapshot = await createDraftParticipant(
    { accountId: account.accountId, initialRoles: ["SELLER"], now: NOW },
    { db },
  );
  return { participantId: snapshot.participant.participantId, accountId: account.accountId };
}

const paidPromotableTerms = {
  price: {
    type: "PAID" as const,
    wholesalePriceMinorUnits: 5000,
    wholesalePriceCurrency: "USD",
  },
  promotion: {
    type: "PROMOTABLE" as const,
    commission: { method: "PERCENT_OF_WHOLESALE" as const, commissionBasisPoints: 2000 },
  },
};

async function seedOffer(overrides: Record<string, unknown> = {}) {
  /* The seller is resolved FIRST, because the Product's creator authority now
     has to name them: Phase 1.18 derives `hasProductAuthority` from the
     Product's current source version rather than taking it from this input. */
  const seller = (overrides.seller as { participantId: string; accountId: string }) ??
    (await seedSeller());
  const internalProductId =
    (overrides.internalProductId as string) ?? (await seedProduct(seller.participantId));
  const snapshot = await createDraftOffer(
    {
      internalProductId,
      sellerParticipantId: seller.participantId,
      terms: paidPromotableTerms,
      actingAccountId: seller.accountId,
      now: NOW,
      ...overrides,
    },
    { db },
  );
  return { internalProductId, seller, snapshot };
}

/**
 * A synthetic projection context for a persisted source version.
 *
 * Node and capsule identities are SYNTHETIC and test-only. This phase issues no
 * Node and registers nothing — the projection takes its public identities from
 * the supplied context, which is exactly the boundary 0M.2B drew.
 */
function projectionContext(v: {
  internalOfferId: string;
  internalProductId: string;
  sellerParticipantId: string;
  offerSourceRecordId: string;
  sourceRecordVersion: string;
}) {
  return {
    offerBinding: {
      offerNode: `an:node:${pad26("M6OFFERNODE")}`,
      internalOfferId: v.internalOfferId,
    },
    productBinding: {
      productNode: `an:node:${pad26("M6PRODUCTNODE")}`,
      internalProductId: v.internalProductId,
    },
    authorityBinding: {
      authorityNode: `an:node:${pad26("M6AUTHNODE")}`,
      sellerParticipantId: v.sellerParticipantId,
    },
    sourceVersionBinding: {
      offerSourceRecordId: v.offerSourceRecordId,
      sourceRecordVersion: v.sourceRecordVersion,
    },
    capsuleId: `an:capsule:${pad26("M6CAPSULE")}`,
    capsuleVersion: "2.0.0",
    mappingVersion: OFFER_PROJECTION_MAPPING_VERSION,
    generatedAt: LATER,
    nodePolicy: { ref: "mon:policy:node/offer", version: "1" },
    capsulePolicy: { ref: "mon:policy:capsule/offer", version: "1" },
  };
}

/**
 * Seed an ACTIVE source version DIRECTLY at the database layer, and advance the
 * pointer to it.
 *
 * Deliberately bypassing the service, and deliberately NOT weakening it. 0M.2A
 * gates activation behind commerce tests this phase cannot satisfy (see test
 * 33), so the service cannot produce an ACTIVE Offer and must not be persuaded
 * to. But the mapper and the projection have to be proven against the state
 * 0M.8 WILL produce, and a row is the honest way to express it: this is a
 * fixture for the read path, not a way in through the write path.
 */
async function seedActiveVersionRow(
  internalOfferId: string,
  offerSourceRecordId: string,
  base: { internalProductId: string; sellerParticipantId: string; actingAccountId?: string },
): Promise<void> {
  const economics = calculateOfferEconomics(paidPromotableTerms);
  await db.offerSourceRecordVersionRow.create({
    data: {
      offerSourceRecordId,
      sourceRecordVersion: "2",
      supersedesSourceRecordVersion: "1",
      internalOfferId,
      sourceSystem: "monacado",
      sourceRecordType: "Offer",
      sourceClass: "governed-database-record",
      internalProductId: base.internalProductId,
      sellerParticipantId: base.sellerParticipantId,
      lifecycle: "ACTIVE",
      availability: "AVAILABLE",
      priceType: "PAID",
      wholesalePriceMinorUnits: 5000n,
      wholesalePriceCurrency: "USD",
      promotionType: "PROMOTABLE",
      commissionMethod: "PERCENT_OF_WHOLESALE",
      commissionBasisPoints: 2000,
      fixedCommissionMinorUnits: null,
      fixedCommissionCurrency: null,
      effectiveStartsAt: null,
      effectiveEndsAt: null,
      calculatedCommissionMinorUnits: BigInt(economics.calculatedCommissionMinorUnits),
      calculatedCreatorGrossProceedsMinorUnits: BigInt(
        economics.calculatedCreatorGrossProceedsMinorUnits,
      ),
      commissionCalculationPolicyVersion: economics.commissionCalculationPolicyVersion,
      authorizedBySellerParticipantId: base.sellerParticipantId,
      /* The account convention the service now writes (Phase 1.18); a raw row
         may still carry a historical `mon:actor:` value, which stays readable. */
      authorizedByActorId: base.actingAccountId ?? ACTOR,
      recordedAt: new Date(LATER),
    },
  });
  await db.offer.update({
    where: { internalOfferId },
    data: { currentSourceRecordVersion: "2", lifecycle: "ACTIVE", availability: "AVAILABLE" },
  });
}

const describeDb = RUN ? describe : describe.skip;

describeDb("Offer persistence (Phase 0M.6)", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  // — Creation and stable identity —

  it("1. creates an Offer and its first immutable source version", async () => {
    const { snapshot } = await seedOffer();
    expect(snapshot.record.internalOfferId).toMatch(OFFER_ID_PATTERNS.offer);
    expect(snapshot.record.offerSourceRecordId).toMatch(OFFER_ID_PATTERNS.sourceRecord);
    expect(snapshot.record.currentSourceRecordVersion).toBe("1");
    expect(snapshot.currentVersion.sourceRecordVersion).toBe("1");
    expect(snapshot.currentVersion.supersedesSourceRecordVersion).toBeNull();
  });

  it("2. stable Offer identity persists and is readable back", async () => {
    const { snapshot } = await seedOffer();
    const reread = await getOffer(snapshot.record.internalOfferId, { db });
    expect(reread.record.internalOfferId).toBe(snapshot.record.internalOfferId);
    expect(reread.record.offerSourceRecordId).toBe(snapshot.record.offerSourceRecordId);
  });

  it("3. starts DRAFT + AVAILABLE, and is therefore not commercially selectable", async () => {
    const { snapshot } = await seedOffer();
    expect(snapshot.record.lifecycle).toBe("DRAFT");
    expect(snapshot.record.availability).toBe("AVAILABLE");
    const state = await evaluateOfferState(snapshot.record.internalOfferId, { db });
    /* Only ACTIVE + AVAILABLE selects. A DRAFT Offer is unselectable whatever
       availability says — availability modifies a live Offer. */
    expect(state.commerciallySelectable).toBe(false);
  });

  it("4. enforces the Product foreign key", async () => {
    const { snapshot, internalProductId } = await seedOffer();
    const row = await db.offer.findUnique({
      where: { internalOfferId: snapshot.record.internalOfferId },
    });
    expect(row?.internalProductId).toBe(internalProductId);
  });

  it("5. refuses an Offer naming a Product that does not exist", async () => {
    const seller = await seedSeller();
    await expect(
      createDraftOffer(
        {
          internalProductId: `mon:product:${pad26("M6MISSING")}`,
          sellerParticipantId: seller.participantId,
          terms: paidPromotableTerms,
          actingAccountId: seller.accountId,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(OfferProductNotFoundError);
  });

  it("6. refuses an Offer whose seller participant does not exist", async () => {
    const internalProductId = await seedProduct();
    const seller = await seedSeller();
    await expect(
      createDraftOffer(
        {
          internalProductId,
          sellerParticipantId: `mon:mpart:${pad26("M6NOBODY")}`,
          terms: paidPromotableTerms,
          actingAccountId: seller.accountId,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(SellerParticipantNotFoundError);
  });

  // — Version identity and history —

  it("7. the stable Offer points at its current version", async () => {
    const { snapshot } = await seedOffer();
    const row = await db.offer.findUnique({
      where: { internalOfferId: snapshot.record.internalOfferId },
    });
    const versions = await db.offerSourceRecordVersionRow.findMany({
      where: { internalOfferId: snapshot.record.internalOfferId },
    });
    expect(versions).toHaveLength(1);
    expect(row?.currentSourceRecordVersion).toBe(versions[0]!.sourceRecordVersion);
  });

  it("8. an exact historical version is retrievable by name, never as 'the latest'", async () => {
    const { snapshot, seller } = await seedOffer();
    await createOfferSourceVersion(
      {
        internalOfferId: snapshot.record.internalOfferId,
        sourceRecordVersion: "2",
        availability: "TEMPORARILY_UNAVAILABLE",
        actingAccountId: seller.accountId,
        now: LATER,
      },
      { db },
    );

    const v1 = await getSourceVersion(snapshot.record.internalOfferId, "1", { db });
    expect(v1.sourceRecordVersion).toBe("1");
    expect(v1.availability).toBe("AVAILABLE");

    const current = await getCurrentSourceVersion(snapshot.record.internalOfferId, { db });
    expect(current.sourceRecordVersion).toBe("2");
    expect(current.availability).toBe("TEMPORARILY_UNAVAILABLE");
  });

  it("9. refuses an unknown version rather than falling back to the current one", async () => {
    const { snapshot } = await seedOffer();
    await expect(
      getSourceVersion(snapshot.record.internalOfferId, "999", { db }),
    ).rejects.toBeInstanceOf(OfferVersionNotFoundError);
  });

  it("10. a material update mints a new version and leaves the prior one untouched", async () => {
    const { snapshot, seller } = await seedOffer();
    const before = await db.offerSourceRecordVersionRow.findFirst({
      where: { internalOfferId: snapshot.record.internalOfferId, sourceRecordVersion: "1" },
    });

    await createOfferSourceVersion(
      {
        internalOfferId: snapshot.record.internalOfferId,
        sourceRecordVersion: "2",
        terms: {
          price: { type: "PAID", wholesalePriceMinorUnits: 7500, wholesalePriceCurrency: "USD" },
          promotion: {
            type: "PROMOTABLE",
            commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2000 },
          },
        },
        actingAccountId: seller.accountId,
        now: LATER,
      },
      { db },
    );

    const after = await db.offerSourceRecordVersionRow.findFirst({
      where: { internalOfferId: snapshot.record.internalOfferId, sourceRecordVersion: "1" },
    });
    /* Byte-for-byte identical: the historical row is never updated in place. */
    expect(safeStringify(after)).toBe(safeStringify(before));
    expect(after!.wholesalePriceMinorUnits).toBe(5000n);
  });

  it("11. the current-version pointer advances with the new version, atomically", async () => {
    const { snapshot, seller } = await seedOffer();
    await createOfferSourceVersion(
      {
        internalOfferId: snapshot.record.internalOfferId,
        sourceRecordVersion: "2",
        availability: "TEMPORARILY_UNAVAILABLE",
        actingAccountId: seller.accountId,
        now: LATER,
      },
      { db },
    );
    const row = await db.offer.findUnique({
      where: { internalOfferId: snapshot.record.internalOfferId },
    });
    expect(row?.currentSourceRecordVersion).toBe("2");
    /* The denormalized pointer-side copy moved in the same transaction, so it
       cannot disagree with the version it points at. */
    expect(row?.availability).toBe("TEMPORARILY_UNAVAILABLE");
  });

  it("12. records lineage — each version names the one it supersedes", async () => {
    const { snapshot, seller } = await seedOffer();
    await createOfferSourceVersion(
      {
        internalOfferId: snapshot.record.internalOfferId,
        sourceRecordVersion: "2",
        availability: "TEMPORARILY_UNAVAILABLE",
        actingAccountId: seller.accountId,
        now: LATER,
      },
      { db },
    );
    const versions = await listSourceVersions(snapshot.record.internalOfferId, { db });
    expect(versions.map((v) => v.sourceRecordVersion)).toEqual(["1", "2"]);
    expect(versions[0]!.supersedesSourceRecordVersion).toBeNull();
    expect(versions[1]!.supersedesSourceRecordVersion).toBe("1");
  });

  it("13. refuses a duplicate version label — a label mints once", async () => {
    const { snapshot, seller } = await seedOffer();
    await expect(
      createOfferSourceVersion(
        {
          internalOfferId: snapshot.record.internalOfferId,
          sourceRecordVersion: "1",
          availability: "TEMPORARILY_UNAVAILABLE",
          actingAccountId: seller.accountId,
          now: LATER,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(DuplicateOfferSourceVersionError);
  });

  it("14. an update changing nothing material mints no version", async () => {
    const { snapshot, seller } = await seedOffer();
    await expect(
      createOfferSourceVersion(
        {
          internalOfferId: snapshot.record.internalOfferId,
          sourceRecordVersion: "2",
          availability: "AVAILABLE",
          actingAccountId: seller.accountId,
          now: LATER,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(NoMaterialOfferChangeError);

    const versions = await db.offerSourceRecordVersionRow.count({
      where: { internalOfferId: snapshot.record.internalOfferId },
    });
    expect(versions).toBe(1);
  });

  // — Economics round-trip —

  it("15. round-trips a PAID wholesale price and currency exactly", async () => {
    const { snapshot } = await seedOffer();
    const v = snapshot.currentVersion;
    expect(v.terms.price).toEqual({
      type: "PAID",
      wholesalePriceMinorUnits: 5000,
      wholesalePriceCurrency: "USD",
    });
  });

  it("16. round-trips a percentage commission exactly", async () => {
    const { snapshot } = await seedOffer();
    expect(snapshot.currentVersion.terms.promotion).toEqual({
      type: "PROMOTABLE",
      commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2000 },
    });
  });

  it("17. round-trips a fixed commission exactly, with no percentage fields", async () => {
    const { snapshot } = await seedOffer({
      terms: {
        price: { type: "PAID", wholesalePriceMinorUnits: 4000, wholesalePriceCurrency: "GBP" },
        promotion: {
          type: "PROMOTABLE",
          commission: {
            method: "FIXED_AMOUNT",
            fixedCommissionMinorUnits: 250,
            fixedCommissionCurrency: "GBP",
          },
        },
      },
    });
    expect(snapshot.currentVersion.terms.promotion).toEqual({
      type: "PROMOTABLE",
      commission: {
        method: "FIXED_AMOUNT",
        fixedCommissionMinorUnits: 250,
        fixedCommissionCurrency: "GBP",
      },
    });
    expect(snapshot.currentVersion.terms.promotion).not.toHaveProperty(
      "commission.commissionBasisPoints",
    );
  });

  it("18. a FREE Offer has NO wholesale amount and NO currency — absence by construction", async () => {
    const { snapshot } = await seedOffer({
      terms: { price: { type: "FREE" }, promotion: { type: "NOT_PROMOTABLE" } },
    });
    expect(snapshot.currentVersion.terms.price).toEqual({ type: "FREE" });
    expect(Object.keys(snapshot.currentVersion.terms.price)).toEqual(["type"]);

    const row = await db.offerSourceRecordVersionRow.findFirst({
      where: { internalOfferId: snapshot.record.internalOfferId },
    });
    expect(row!.wholesalePriceMinorUnits).toBeNull();
    expect(row!.wholesalePriceCurrency).toBeNull();
  });

  it("19. persists the accepted economics, matching the deterministic calculator", async () => {
    const { snapshot } = await seedOffer();
    /* 20% of 5000 = 1000; creator gross proceeds = 4000. Stored, not recomputed
       on read — the contract re-checks them on the way out. */
    expect(snapshot.currentVersion.economics).toEqual(
      calculateOfferEconomics(paidPromotableTerms),
    );
    expect(snapshot.currentVersion.economics.calculatedCommissionMinorUnits).toBe(1000);
    expect(snapshot.currentVersion.economics.calculatedCreatorGrossProceedsMinorUnits).toBe(4000);
    expect(snapshot.currentVersion.economics.commissionCalculationPolicyVersion).toBe(
      "WHOLESALE_COMMISSION_V1",
    );
  });

  it("20. recomputes economics for a repriced version rather than carrying them over", async () => {
    const { snapshot, seller } = await seedOffer();
    const next = await createOfferSourceVersion(
      {
        internalOfferId: snapshot.record.internalOfferId,
        sourceRecordVersion: "2",
        terms: {
          price: { type: "PAID", wholesalePriceMinorUnits: 9000, wholesalePriceCurrency: "USD" },
          promotion: {
            type: "PROMOTABLE",
            commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2000 },
          },
        },
        actingAccountId: seller.accountId,
        now: LATER,
      },
      { db },
    );
    expect(next.currentVersion.economics.calculatedCommissionMinorUnits).toBe(1800);
    expect(next.currentVersion.economics.calculatedCreatorGrossProceedsMinorUnits).toBe(7200);

    /* Version 1's accepted numbers are untouched — the creator agreed to those. */
    const v1 = await getSourceVersion(snapshot.record.internalOfferId, "1", { db });
    expect(v1.economics.calculatedCommissionMinorUnits).toBe(1000);
  });

  it("21. refuses economically invalid terms — invalid seller proceeds cannot persist", async () => {
    const internalProductId = await seedProduct();
    const seller = await seedSeller();
    await expect(
      createDraftOffer(
        {
          internalProductId,
          sellerParticipantId: seller.participantId,
          terms: {
            price: { type: "PAID", wholesalePriceMinorUnits: 500, wholesalePriceCurrency: "USD" },
            promotion: {
              type: "PROMOTABLE",
              commission: {
                method: "FIXED_AMOUNT",
                fixedCommissionMinorUnits: 900,
                fixedCommissionCurrency: "USD",
              },
            },
          },
          actingAccountId: seller.accountId,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(InvalidOfferInputError);
    expect(await db.offer.count()).toBe(0);
  });

  it("22. refuses a cross-currency fixed commission", async () => {
    const internalProductId = await seedProduct();
    const seller = await seedSeller();
    await expect(
      createDraftOffer(
        {
          internalProductId,
          sellerParticipantId: seller.participantId,
          terms: {
            price: { type: "PAID", wholesalePriceMinorUnits: 5000, wholesalePriceCurrency: "USD" },
            promotion: {
              type: "PROMOTABLE",
              commission: {
                method: "FIXED_AMOUNT",
                fixedCommissionMinorUnits: 250,
                fixedCommissionCurrency: "EUR",
              },
            },
          },
          actingAccountId: seller.accountId,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(InvalidOfferInputError);
  });

  // — Interval, trace, timestamps —

  it("23. round-trips an effective interval, and both-null means no interval", async () => {
    const withInterval = await seedOffer({
      effectiveInterval: { startsAt: "2027-11-01T00:00:00.000Z", endsAt: null },
    });
    expect(withInterval.snapshot.currentVersion.effectiveInterval).toEqual({
      startsAt: "2027-11-01T00:00:00.000Z",
      endsAt: null,
    });

    const withoutInterval = await seedOffer();
    expect(withoutInterval.snapshot.currentVersion.effectiveInterval).toBeNull();
  });

  it("24. round-trips the authorization trace and recordedAt", async () => {
    const { snapshot, seller } = await seedOffer();
    /* The resolved acting account (Phase 1.18): the audit actor IS the identity
       the authorization decision was evaluated against, not a second value the
       caller supplied beside it. */
    expect(snapshot.currentVersion.authorizedByActorId).toBe(seller.accountId);
    expect(snapshot.currentVersion.authorizedBySellerParticipantId).toBe(seller.participantId);
    expect(snapshot.currentVersion.recordedAt).toBe(NOW);
  });

  it("25. stores an opaque actor id, never an email or a display name", async () => {
    const { snapshot } = await seedOffer();
    const row = await db.offerSourceRecordVersionRow.findFirst({
      where: { internalOfferId: snapshot.record.internalOfferId },
    });
    /* Still opaque — the namespace moved to the account, the guarantee did not. */
    expect(row!.authorizedByActorId).toMatch(/^mon:acct:/);
    expect(row!.authorizedByActorId).not.toContain("@");
  });

  // — Authorization —

  it("26. an unrelated participant cannot create an Offer under another's authority", async () => {
    const internalProductId = await seedProduct();
    const seller = await seedSeller();
    const stranger = await seedSeller();

    await expect(
      createDraftOffer(
        {
          internalProductId,
          sellerParticipantId: seller.participantId,
          terms: paidPromotableTerms,
          /* The stranger acts, but the Offer names the other seller. */
          actingAccountId: stranger.accountId,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toMatchObject({
      name: "OfferNotAuthorizedError",
      reasonCodes: ["SELLER_PARTICIPANT_MISMATCH"],
    });
  });

  it("27. refuses creation without Product authority — derived, not supplied", async () => {
    /* Phase 1.18. Through 1.17 this was expressed by passing
       `hasProductAuthority: false`, which meant the test proved only that the
       service read its own input. Both ways of NOT holding the authority are
       asserted now, and neither is reachable by anything a caller can send.

       First: a Product whose current source version names no creator
       participant at all — the historical NULL the column is nullable for.
       Authority that cannot be evidenced is granted to nobody. */
    const unattributed = await seedProduct();
    const seller = await seedSeller();
    await expect(
      createDraftOffer(
        {
          internalProductId: unattributed,
          sellerParticipantId: seller.participantId,
          terms: paidPromotableTerms,
          actingAccountId: seller.accountId,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toMatchObject({ reasonCodes: ["PRODUCT_AUTHORITY_REQUIRED"] });

    /* Second, and the one that matters: another creator's Product. An active
       SELLER cannot state commercial terms over work they do not control, and
       knowing the Product id does not help. */
    const creator = await seedSeller();
    const theirProduct = await seedProduct(creator.participantId);
    await expect(
      createDraftOffer(
        {
          internalProductId: theirProduct,
          sellerParticipantId: seller.participantId,
          terms: paidPromotableTerms,
          actingAccountId: seller.accountId,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toMatchObject({ reasonCodes: ["PRODUCT_AUTHORITY_REQUIRED"] });

    /* And a revoked authority is not an authority, even naming the right
       participant. */
    const revoked = await seedProduct();
    await grantProductCreatorAuthority(db, {
      internalProductId: revoked,
      participantId: seller.participantId,
      authorizationState: "revoked",
      now: NOW,
    });
    await expect(
      createDraftOffer(
        {
          internalProductId: revoked,
          sellerParticipantId: seller.participantId,
          terms: paidPromotableTerms,
          actingAccountId: seller.accountId,
          now: NOW,
        },
        { db },
      ),
    ).rejects.toMatchObject({ reasonCodes: ["PRODUCT_AUTHORITY_REQUIRED"] });
  });

  it("28. an unknown acting account is the guest subject, and is refused", async () => {
    const internalProductId = await seedProduct();
    const seller = await seedSeller();
    await expect(
      createDraftOffer(
        {
          internalProductId,
          sellerParticipantId: seller.participantId,
          terms: paidPromotableTerms,
          actingAccountId: "acct_does_not_exist",
          now: NOW,
        },
        { db },
      ),
    ).rejects.toMatchObject({ reasonCodes: ["ACCOUNT_REQUIRED"] });
  });

  it("29. a stranger cannot mutate an existing Offer", async () => {
    const { snapshot } = await seedOffer();
    const stranger = await seedSeller();
    await expect(
      createOfferSourceVersion(
        {
          internalOfferId: snapshot.record.internalOfferId,
          sourceRecordVersion: "2",
          availability: "TEMPORARILY_UNAVAILABLE",
          actingAccountId: stranger.accountId,
          now: LATER,
        },
        { db },
      ),
    ).rejects.toMatchObject({ reasonCodes: ["SELLER_PARTICIPANT_MISMATCH"] });

    /* And nothing was written. */
    expect(
      await db.offerSourceRecordVersionRow.count({
        where: { internalOfferId: snapshot.record.internalOfferId },
      }),
    ).toBe(1);
  });

  it("30. the authorized seller can perform an allowed draft-stage update", async () => {
    const { snapshot, seller } = await seedOffer();
    const next = await createOfferSourceVersion(
      {
        internalOfferId: snapshot.record.internalOfferId,
        sourceRecordVersion: "2",
        availability: "TEMPORARILY_UNAVAILABLE",
        actingAccountId: seller.accountId,
        now: LATER,
      },
      { db },
    );
    expect(next.record.currentSourceRecordVersion).toBe("2");
    expect(next.record.availability).toBe("TEMPORARILY_UNAVAILABLE");
  });

  it("31. refuses an invalid lifecycle transition using 0M.2A's own table", async () => {
    const { snapshot, seller } = await seedOffer();
    /* DRAFT → SUSPENDED is not an edge: DRAFT permits only ACTIVE and WITHDRAWN. */
    await expect(
      createOfferSourceVersion(
        {
          internalOfferId: snapshot.record.internalOfferId,
          sourceRecordVersion: "2",
          lifecycle: "SUSPENDED",
          actingAccountId: seller.accountId,
          now: LATER,
        },
        { db },
      ),
    ).rejects.toMatchObject({ reasonCodes: ["OFFER_LIFECYCLE_TRANSITION_NOT_PERMITTED"] });
  });

  it("32. a terminal Offer refuses further change", async () => {
    const { snapshot, seller } = await seedOffer();
    await createOfferSourceVersion(
      {
        internalOfferId: snapshot.record.internalOfferId,
        sourceRecordVersion: "2",
        lifecycle: "WITHDRAWN",
        actingAccountId: seller.accountId,
        now: LATER,
      },
      { db },
    );

    await expect(
      createOfferSourceVersion(
        {
          internalOfferId: snapshot.record.internalOfferId,
          sourceRecordVersion: "3",
          availability: "TEMPORARILY_UNAVAILABLE",
          actingAccountId: seller.accountId,
          now: LATER,
        },
        { db },
      ),
    ).rejects.toMatchObject({ reasonCodes: ["OFFER_LIFECYCLE_TERMINAL"] });
  });

  it("33. activation is unreachable this phase — the commerce gates refuse it", async () => {
    /* NOT a defect, and NOT worked around. 0M.2A gates going live behind the
       full commerce test, and this phase fails it TWICE over:

         - `participant.status !== ACTIVE` → PARTICIPANT_NOT_ACTIVATED. Reaching
           ACTIVE is a governed activation decision, and 0M.5 makes none.
         - `paymentReadiness !== ENABLED` → PAYMENT_NOT_ENABLED, behind it. No
           payment record exists until 0M.8, so readiness is always NOT_STARTED.

       The participant gate is checked first, so that is the code asserted here.
       Weakening either to make an Offer activate would let an unactivated,
       unpayable seller sell — so 0M.6 is draft-capable only, exactly as 0M.5
       was, and for the same reason. */
    const { snapshot, seller } = await seedOffer();
    await expect(
      createOfferSourceVersion(
        {
          internalOfferId: snapshot.record.internalOfferId,
          sourceRecordVersion: "2",
          lifecycle: "ACTIVE",
          actingAccountId: seller.accountId,
          economicsConfirmation: {
            confirmedOfferSourceRecordId: snapshot.record.offerSourceRecordId,
            confirmedOfferSourceRecordVersion: "2",
            ...calculateOfferEconomics(paidPromotableTerms),
          },
          now: LATER,
        },
        { db },
      ),
    ).rejects.toMatchObject({ reasonCodes: ["PARTICIPANT_NOT_ACTIVATED"] });
  });

  // — Delete/FK behaviour —

  it("34. refuses to delete a Product an Offer depends on", async () => {
    const { internalProductId } = await seedOffer();
    await expect(
      db.product.delete({ where: { internalProductId } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("35. refuses to delete a participant holding Offer authority", async () => {
    const { seller } = await seedOffer();
    await expect(
      db.marketplaceParticipant.delete({ where: { id: seller.participantId } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  it("36. refuses to delete an Offer while its history exists", async () => {
    const { snapshot } = await seedOffer();
    await expect(
      db.offer.delete({ where: { internalOfferId: snapshot.record.internalOfferId } }),
    ).rejects.toMatchObject({ code: "P2003" });
  });

  // — Exact reconstruction and projection compatibility —

  it("37. a persisted row reconstructs into the canonical source contract", async () => {
    const { snapshot } = await seedOffer();
    const row = await db.offerSourceRecordVersionRow.findFirst({
      where: { internalOfferId: snapshot.record.internalOfferId },
    });
    const reconstructed = versionRowToSourceVersion(row!);
    expect(OfferSourceVersion.safeParse(reconstructed).success).toBe(true);
    expect(reconstructed).toEqual(snapshot.currentVersion);
  });

  it("38. a corrupt persisted row fails loudly rather than returning a best-effort object", async () => {
    const { snapshot } = await seedOffer();
    /* Drift the stored commission away from what the terms imply. The contract
       re-checks stored economics against the deterministic calculator, so this
       must be refused rather than projected. */
    await db.offerSourceRecordVersionRow.updateMany({
      where: { internalOfferId: snapshot.record.internalOfferId },
      data: { calculatedCommissionMinorUnits: 4242n },
    });
    await expect(getOffer(snapshot.record.internalOfferId, { db })).rejects.toBeInstanceOf(
      CorruptOfferRecordError,
    );
  });

  it("39. a corrupt discriminator is refused rather than guessed at", async () => {
    const { snapshot } = await seedOffer();
    await db.offerSourceRecordVersionRow.updateMany({
      where: { internalOfferId: snapshot.record.internalOfferId },
      data: { priceType: "NONSENSE" },
    });
    await expect(getOffer(snapshot.record.internalOfferId, { db })).rejects.toBeInstanceOf(
      CorruptOfferRecordError,
    );
  });

  it("40. a DRAFT Offer is correctly NOT projection-eligible", async () => {
    /* 0M.2B refuses to project a DRAFT Offer, with one coarse reason so a public
       failure cannot probe a seller's standing. Persistence does not change
       that, and this phase should not want it to. */
    const { snapshot } = await seedOffer();
    const persisted = await getCurrentSourceVersion(snapshot.record.internalOfferId, { db });
    expect(() =>
      projectOfferCapsule({ sourceVersion: persisted, context: projectionContext(persisted) }),
    ).toThrow(/NOT_PROJECTION_ELIGIBLE/);
  });

  it("41. a persisted source version feeds the existing Offer capsule projection", async () => {
    const { snapshot, seller, internalProductId } = await seedOffer();
    await seedActiveVersionRow(
      snapshot.record.internalOfferId,
      snapshot.record.offerSourceRecordId,
      {
        internalProductId,
        sellerParticipantId: seller.participantId,
        actingAccountId: seller.accountId,
      },
    );

    /* Read back THROUGH the service and the mapper — the pipeline stage this
       phase exists to supply. */
    const persisted = await getCurrentSourceVersion(snapshot.record.internalOfferId, { db });
    const context = projectionContext(persisted);

    const fromPersisted = projectOfferCapsule({ sourceVersion: persisted, context });
    expect(fromPersisted).toBeTruthy();

    /* An INDEPENDENTLY constructed canonical source with the same values — not a
       copy of the persisted object — projected under the identical context. The
       two capsules must be byte-identical. That equality is the whole reason
       this phase exists: the projection can no longer tell whether its source
       came from the database or from a fixture. */
    const canonical = OfferSourceVersion.parse({
      offerSourceRecordId: snapshot.record.offerSourceRecordId,
      sourceRecordVersion: "2",
      supersedesSourceRecordVersion: "1",
      internalOfferId: snapshot.record.internalOfferId,
      sourceSystem: "monacado",
      sourceRecordType: "Offer",
      sourceClass: "governed-database-record",
      internalProductId,
      sellerParticipantId: seller.participantId,
      lifecycle: "ACTIVE",
      availability: "AVAILABLE",
      terms: paidPromotableTerms,
      effectiveInterval: null,
      economics: calculateOfferEconomics(paidPromotableTerms),
      authorizedBySellerParticipantId: seller.participantId,
      /* The resolved acting account (Phase 1.18). */
      authorizedByActorId: seller.accountId,
      recordedAt: LATER,
    });

    expect(persisted).toEqual(canonical);
    const fromCanonical = projectOfferCapsule({ sourceVersion: canonical, context });
    expect(canonicalJsonString(fromPersisted)).toBe(canonicalJsonString(fromCanonical));
  });

  it("42. the projection never receives Monacado or promoter economics", async () => {
    const { snapshot } = await seedOffer();
    const persisted = await getCurrentSourceVersion(snapshot.record.internalOfferId, { db });
    const serialized = canonicalJsonString(persisted);
    for (const forbidden of [
      "retailPrice",
      "promoterSpread",
      "monacadoRetained",
      "wholesaleAcquisition",
      "platformFee",
      "tax",
      "shipping",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  // — Scope —

  it("43. issues no Offer Node and creates no publication, outbox, or receipt", async () => {
    const { snapshot } = await seedOffer();
    expect(snapshot.record).not.toHaveProperty("nodeId");
    expect(snapshot.currentVersion).not.toHaveProperty("nodeId");
    expect(snapshot.currentVersion).not.toHaveProperty("mappingVersion");
    /* No Offer publication path exists at all: the only publication tables are
       the Product ones, and this phase wrote to none of them. */
    expect(await db.publicationOutbox.count()).toBe(0);
    expect(await db.registrarReceipt.count()).toBe(0);
    expect(await db.productPublication.count()).toBe(0);
  });

  it("44. refuses an unknown Offer rather than inventing one", async () => {
    await expect(
      getOffer(`mon:offer:${pad26("M6NOSUCH")}`, { db }),
    ).rejects.toBeInstanceOf(OfferNotFoundError);
    await expect(
      listSourceVersions(`mon:offer:${pad26("M6NOSUCH")}`, { db }),
    ).rejects.toBeInstanceOf(OfferNotFoundError);
  });
});
