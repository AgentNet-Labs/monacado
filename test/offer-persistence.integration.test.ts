/**
 * Offer persistence and Seller acts, against a real database (Phase 0M.6;
 * rewritten for Phase 1.42).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * NO NETWORK. Every act takes an explicit instant; nothing reads a clock. The
 * Seller is made ready and the Product ACTIVE through the real paths
 * (`seller-commerce-fixture`), and every Offer write goes through the service.
 *
 * Proves:
 *   - CREATE — a DRAFT Offer, an opaque `offerRef`, STANDING version "1", no
 *     act; an unknown or another Seller's Product is one refusal; one
 *     non-terminal Offer per Product;
 *   - REVISE — a new STANDING version, server-labelled and linked; stale
 *     `expectedVersion` and no-change refused; a live revision needs the exact
 *     version confirmed, and the refusal discloses it;
 *   - ACTIVATE / PAUSE / RESUME / WITHDRAW — acts, never versions; readiness
 *     gates going live and nothing else; terminal is terminal;
 *   - ENDED — derived from the overall end, no write; the marker is released by
 *     the next create, never earlier;
 *   - PROMOTIONS — scheduled, replaced before start (history kept), refused
 *     while pending, ended early by an act, reverting with no write;
 *   - OWNERSHIP — another Seller's Offer is the same 404 as an unknown one;
 *   - INTEGRITY — RESTRICT foreign keys, loud corruption, the projection fed by
 *     a persisted version and a derived lifecycle; no publication side effects.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { readAccountHome } from "../src/server/account/account-home";
import { suspendProduct } from "../src/server/marketplace/product-suspension-service";
import { imposeParticipantRestriction } from "../src/server/marketplace/participant-restriction-service";
import { ProductNotAvailableError } from "../src/server/product/errors";
import { ParticipantActionNotPermittedError } from "../src/server/marketplace/participant-standing-errors";
import {
  MARKETPLACE_POLICY_VERSION_1,
  MONACADO_MARKETPLACE_POLICY_ID,
} from "../src/contracts/marketplace/marketplace-policy-content";
import {
  activateOfferAs,
  createOfferAs,
  endPromotionAs,
  getCurrentSourceVersion,
  getOffer,
  getSourceVersion,
  lifecycleAt,
  listSourceVersions,
  pauseOfferAs,
  promotionStatusAt,
  readOfferStateIn,
  replacePromotionAs,
  resumeOfferAs,
  reviseOfferTermsAs,
  schedulePromotionAs,
  withdrawOfferAs,
} from "../src/server/marketplace/offer-service";
import { readSellerProductOffersIn } from "../src/server/marketplace/offer-read-service";
import {
  CorruptOfferRecordError,
  InvalidOfferInputError,
  NoMaterialOfferChangeError,
  OfferAlreadyExistsError,
  OfferConfirmationRequiredError,
  OfferNotAuthorizedError,
  OfferNotFoundError,
  OfferNotReadyError,
  OfferPromotionNotReplaceableError,
  OfferPromotionNotRunningError,
  OfferPromotionPendingError,
  OfferVersionNotFoundError,
  OfferVersionStaleError,
} from "../src/server/marketplace/offer-errors";
import { OFFER_ID_PATTERNS } from "../src/server/marketplace/offer-ids";
import { versionRowToSourceVersion } from "../src/server/marketplace/offer-mapper";
import { OfferSourceVersion, effectiveOfferTerms } from "../src/contracts/marketplace/offer-source";
import { OFFER_PROJECTION_MAPPING_VERSION, projectOfferCapsule } from "../src/contracts/marketplace/offer.projection";
import { canonicalJsonString } from "../src/contracts/integrity/canonical-json";
import { sellerCommerceFixture, type FixtureActor, type FixtureProduct } from "./support/seller-commerce-fixture";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2029-01-01T09:00:00.000Z";
/** Offer acts run a month after the fixture's own instants, one minute apart. */
const BASE = Date.parse("2029-02-01T09:00:00.000Z");
const ORIGIN = "https://monacado.test";
const UNKNOWN_REF = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";

const fx = sellerCommerceFixture({ db, emailPrefix: "p142offer", now: NOW, origin: ORIGIN });

let minute = 0;
/** The next Offer-act instant, strictly increasing. */
const next = (): string => new Date(BASE + (minute += 1) * 60_000).toISOString();
/** An instant `hours` after `from`. */
const plus = (from: string, hours: number): string => new Date(Date.parse(from) + hours * 3_600_000).toISOString();

/** $50.00 wholesale, 20% commission: $10.00 to the Promoter, $40.00 to the Seller. */
const TERMS = { wholesalePrice: "50.00", currency: "USD", commission: { method: "PERCENT_OF_WHOLESALE", percent: "20" } };
const REPRICED = { ...TERMS, wholesalePrice: "60.00" };

const as = (actor: { accountId: string }) => ({ accountId: actor.accountId });

/**
 * Run a write unconfirmed, and return the disclosure the refusal carries. Any
 * other refusal (invalid input, a pending promotion) comes first and is rethrown.
 */
async function disclosureOf(write: () => Promise<unknown>) {
  try {
    await write();
  } catch (error) {
    if (!(error instanceof OfferConfirmationRequiredError)) throw error;
    return error.disclosure;
  }
  throw new Error("expected the write to ask for confirmation");
}

interface Ready {
  seller: FixtureActor;
  product: FixtureProduct;
  offerRef: string;
  internalOfferId: string;
}

/** A ready Seller, an ACTIVE Product, and a DRAFT Offer on it. */
async function draftOffer(): Promise<Ready> {
  const seller = await fx.readySeller();
  const product = await fx.activeProduct(seller);
  const created = await createOfferAs(as(seller), { productRef: product.productRef, terms: TERMS, now: next() }, { db });
  const { internalOfferId } = await db.offer.findUniqueOrThrow({ where: { offerRef: created.offerRef } });
  return { seller, product, offerRef: created.offerRef, internalOfferId };
}

/** A confirmation of some other version — what a Seller who has not looked yet would send. */
const UNCONFIRMED = {
  version: "999",
  calculatedCommissionMinorUnits: 0,
  calculatedSellerGrossProceedsMinorUnits: 0,
  commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
};

/** Activate through the two-step confirmation: ask, read the disclosure, confirm it. */
async function activate(o: Ready, opts: { effectiveUntil?: string; now?: string } = {}) {
  const body = {
    productRef: o.product.productRef,
    offerRef: o.offerRef,
    ...(opts.effectiveUntil ? { effectiveUntil: opts.effectiveUntil } : {}),
    now: opts.now ?? next(),
  };
  const disclosure = await disclosureOf(() => activateOfferAs(as(o.seller), { ...body, confirmation: UNCONFIRMED }, { db }));
  return activateOfferAs(as(o.seller), { ...body, confirmation: disclosure }, { db });
}

async function activeOffer(opts: { effectiveUntil?: string } = {}): Promise<Ready> {
  const o = await draftOffer();
  await activate(o, opts);
  return o;
}

/** The Seller's own read model of their Products' Offers, at `at`. */
function readOffers(o: { seller: FixtureActor; product: FixtureProduct }, at: string) {
  return readSellerProductOffersIn(
    db,
    [o.product.internalProductId],
    { accountId: o.seller.accountId, sellerParticipantId: o.seller.participantId },
    at,
  );
}

async function stateOf(internalOfferId: string) {
  const offer = await db.offer.findUniqueOrThrow({ where: { internalOfferId } });
  return readOfferStateIn(db, offer);
}

/** Schedule a promotion through the two-step confirmation. */
async function schedule(o: Ready, window: { from: string; until: string }, wholesalePrice = "40.00", now = next()) {
  const offer = await db.offer.findUniqueOrThrow({ where: { internalOfferId: o.internalOfferId } });
  const body = {
    productRef: o.product.productRef,
    offerRef: o.offerRef,
    expectedVersion: offer.currentSourceRecordVersion,
    wholesalePrice,
    effectiveFrom: window.from,
    effectiveUntil: window.until,
    now,
  };
  const disclosure = await disclosureOf(() => schedulePromotionAs(as(o.seller), body, { db }));
  return schedulePromotionAs(as(o.seller), { ...body, confirmation: disclosure }, { db });
}

const describeDb = RUN ? describe : describe.skip;

describeDb("Offer persistence and Seller acts (Phase 1.42)", () => {
  beforeEach(fx.cleanup);
  afterAll(async () => {
    await fx.cleanup();
    await disconnectPrisma();
  });

  // — Create —

  it("1. creates a DRAFT Offer with an opaque ref and STANDING version 1, and records no act", async () => {
    const o = await draftOffer();
    expect(o.offerRef).toMatch(/^[0-9A-HJKMNP-TV-Z]{32}$/);
    expect(o.internalOfferId).toMatch(OFFER_ID_PATTERNS.offer);
    const snapshot = await getOffer(o.internalOfferId, { db });
    expect(snapshot.record.currentSourceRecordVersion).toBe("1");
    expect(snapshot.record.currentPromotionVersion).toBeNull();
    expect(snapshot.currentVersion).toMatchObject({
      sourceRecordVersion: "1",
      supersedesSourceRecordVersion: null,
      termsKind: "STANDING",
      promotionWindow: null,
      basisStandingVersion: null,
      terms: {
        price: { type: "PAID", wholesalePriceMinorUnits: 5000, wholesalePriceCurrency: "USD" },
        promotion: { type: "PROMOTABLE", commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2000 } },
      },
      economics: { calculatedCommissionMinorUnits: 1000, calculatedCreatorGrossProceedsMinorUnits: 4000 },
      authorizedBySellerParticipantId: o.seller.participantId,
      authorizedByActorId: o.seller.accountId,
    });
    expect(await db.offerAct.count({ where: { internalOfferId: o.internalOfferId } })).toBe(0);
    const row = await db.offer.findUniqueOrThrow({ where: { internalOfferId: o.internalOfferId } });
    expect(row.nonTerminalForProductId).toBe(o.product.internalProductId);
    expect(lifecycleAt(await stateOf(o.internalOfferId), next())).toBe("DRAFT");
  });

  it("2. an unknown Product and another Seller's Product are one refusal", async () => {
    const seller = await fx.readySeller();
    const other = await fx.readySeller();
    const theirs = await fx.draftProduct(other);
    for (const productRef of [UNKNOWN_REF, theirs.productRef]) {
      await expect(createOfferAs(as(seller), { productRef, terms: TERMS, now: next() }, { db })).rejects.toBeInstanceOf(
        ProductNotAvailableError,
      );
    }
    const promoter = await fx.draftParticipant(["PROMOTER"]);
    await expect(
      createOfferAs(as(promoter), { productRef: theirs.productRef, terms: TERMS, now: next() }, { db }),
    ).rejects.toBeInstanceOf(ProductNotAvailableError);
    expect(await db.offer.count({ where: { internalProductId: theirs.internalProductId } })).toBe(0);
  });

  it("3. refuses terms the promoted-resale scope does not admit, naming the fields", async () => {
    const seller = await fx.readySeller();
    const product = await fx.draftProduct(seller);
    for (const [terms, field] of [
      [{ ...TERMS, wholesalePrice: "0" }, "terms.wholesalePrice"],
      [{ ...TERMS, wholesalePrice: "19.999" }, "terms.wholesalePrice"],
      [{ ...TERMS, commission: { method: "PERCENT_OF_WHOLESALE", percent: "100.5" } }, "terms"],
      [{ ...TERMS, commission: { method: "FIXED_AMOUNT", amount: "60.00" } }, "terms"],
    ] as const) {
      const error = await createOfferAs(as(seller), { productRef: product.productRef, terms, now: next() }, { db }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(InvalidOfferInputError);
      expect((error as InvalidOfferInputError).fields.some((f) => f.startsWith(field))).toBe(true);
    }
    expect(await db.offer.count({ where: { internalProductId: product.internalProductId } })).toBe(0);
  });

  it("4. one non-terminal Offer per Product: a second create is refused while the first is DRAFT, ACTIVE, or PAUSED", async () => {
    const o = await draftOffer();
    const again = () => createOfferAs(as(o.seller), { productRef: o.product.productRef, terms: TERMS, now: next() }, { db });
    await expect(again()).rejects.toBeInstanceOf(OfferAlreadyExistsError);
    await activate(o);
    await expect(again()).rejects.toBeInstanceOf(OfferAlreadyExistsError);
    await pauseOfferAs(as(o.seller), { productRef: o.product.productRef, offerRef: o.offerRef, now: next() }, { db });
    await expect(again()).rejects.toBeInstanceOf(OfferAlreadyExistsError);
    expect(await db.offer.count({ where: { internalProductId: o.product.internalProductId } })).toBe(1);
  });

  // — Revise —

  it("5. revising a DRAFT mints STANDING version 2, linked to 1, and moves the pointer; 1 is untouched", async () => {
    const o = await draftOffer();
    const before = await getSourceVersion(o.internalOfferId, "1", { db });
    const result = await reviseOfferTermsAs(
      as(o.seller),
      { productRef: o.product.productRef, offerRef: o.offerRef, expectedVersion: "1", terms: REPRICED, now: next() },
      { db },
    );
    expect(result).toMatchObject({ state: "DRAFT", standingVersion: "2", promotionVersion: null });
    const v2 = await getCurrentSourceVersion(o.internalOfferId, { db });
    expect(v2).toMatchObject({ sourceRecordVersion: "2", supersedesSourceRecordVersion: "1", termsKind: "STANDING" });
    expect(v2.economics.calculatedCommissionMinorUnits).toBe(1200);
    expect(await getSourceVersion(o.internalOfferId, "1", { db })).toEqual(before);
    expect((await listSourceVersions(o.internalOfferId, { db })).map((v) => v.sourceRecordVersion)).toEqual(["1", "2"]);
  });

  it("6. a stale expectedVersion and an unchanged revision are refused, and write nothing", async () => {
    const o = await draftOffer();
    const sel = { productRef: o.product.productRef, offerRef: o.offerRef };
    await expect(
      reviseOfferTermsAs(as(o.seller), { ...sel, expectedVersion: "7", terms: REPRICED, now: next() }, { db }),
    ).rejects.toBeInstanceOf(OfferVersionStaleError);
    await expect(
      reviseOfferTermsAs(as(o.seller), { ...sel, expectedVersion: "1", terms: TERMS, now: next() }, { db }),
    ).rejects.toBeInstanceOf(NoMaterialOfferChangeError);
    expect(await db.offerSourceRecordVersionRow.count({ where: { internalOfferId: o.internalOfferId } })).toBe(1);
  });

  it("7. revising a live Offer requires the exact new version confirmed; the refusal discloses it", async () => {
    const o = await activeOffer();
    const body = { productRef: o.product.productRef, offerRef: o.offerRef, expectedVersion: "1", terms: REPRICED };
    const disclosure = await disclosureOf(() => reviseOfferTermsAs(as(o.seller), { ...body, now: next() }, { db }));
    expect(disclosure).toEqual({
      version: "2",
      calculatedCommissionMinorUnits: 1200,
      calculatedSellerGrossProceedsMinorUnits: 4800,
      commissionCalculationPolicyVersion: expect.any(String),
    });
    /* A confirmation of the CURRENT version does not authorize the next one. */
    await expect(
      reviseOfferTermsAs(as(o.seller), { ...body, confirmation: { ...disclosure, version: "1" }, now: next() }, { db }),
    ).rejects.toBeInstanceOf(OfferConfirmationRequiredError);
    expect(await db.offerSourceRecordVersionRow.count({ where: { internalOfferId: o.internalOfferId } })).toBe(1);

    const result = await reviseOfferTermsAs(as(o.seller), { ...body, confirmation: disclosure, now: next() }, { db });
    expect(result).toMatchObject({ state: "ACTIVE", standingVersion: "2" });
  });

  // — Lifecycle acts —

  it("8. activation records an ACTIVATE act bound to the confirmed standing version, and mints no version", async () => {
    const o = await draftOffer();
    const result = await activate(o);
    expect(result).toMatchObject({ state: "ACTIVE", standingVersion: "1" });
    const acts = await db.offerAct.findMany({ where: { internalOfferId: o.internalOfferId } });
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({
      act: "ACTIVATE",
      state: "ACTIVE",
      previousState: "DRAFT",
      supersedesActId: null,
      currentForOfferId: o.internalOfferId,
      activatedStandingVersion: "1",
      offerEffectiveUntil: null,
      actorParticipantId: o.seller.participantId,
      actedByAccountId: o.seller.accountId,
    });
    expect(await db.offerSourceRecordVersionRow.count({ where: { internalOfferId: o.internalOfferId } })).toBe(1);
  });

  it("9. activation is refused, with every blocker, until the Product is ACTIVE", async () => {
    const seller = await fx.readySeller();
    const product = await fx.draftProduct(seller);
    const created = await createOfferAs(as(seller), { productRef: product.productRef, terms: TERMS, now: next() }, { db });
    const o = { seller, product, offerRef: created.offerRef, internalOfferId: "" };
    const error = await activate(o).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OfferNotReadyError);
    expect((error as OfferNotReadyError).blockers).toEqual(["PRODUCT_NOT_ACTIVE"]);
    expect(await db.offerAct.count({ where: { offer: { offerRef: created.offerRef } } })).toBe(0);
  });

  it("10. an offer:publish restriction blocks activation", async () => {
    const o = await draftOffer();
    await imposeParticipantRestriction(
      {
        participantId: o.seller.participantId,
        scope: "offer:publish",
        reasonCode: "UNDERWRITING_REVIEW_REQUIRED",
        actingAccountId: await fx.seedOperator("participant:restrict"),
        imposedAt: next(),
      },
      { db },
    );
    const error = await activate(o).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OfferNotReadyError);
    expect((error as OfferNotReadyError).blockers).toContain("OFFER_PUBLISH_RESTRICTED");
  });

  it("11. pause and resume record acts, mint no version, and resume names the standing version", async () => {
    const o = await activeOffer();
    const sel = { productRef: o.product.productRef, offerRef: o.offerRef };
    expect(await pauseOfferAs(as(o.seller), { ...sel, now: next() }, { db })).toMatchObject({ state: "PAUSED" });
    await expect(
      resumeOfferAs(as(o.seller), { ...sel, expectedVersion: "2", now: next() }, { db }),
    ).rejects.toBeInstanceOf(OfferVersionStaleError);
    expect(await resumeOfferAs(as(o.seller), { ...sel, expectedVersion: "1", now: next() }, { db })).toMatchObject({
      state: "ACTIVE",
    });
    const acts = await db.offerAct.findMany({ where: { internalOfferId: o.internalOfferId }, orderBy: { actedAt: "asc" } });
    expect(acts.map((a) => [a.act, a.previousState, a.state])).toEqual([
      ["ACTIVATE", "DRAFT", "ACTIVE"],
      ["PAUSE", "ACTIVE", "PAUSED"],
      ["RESUME", "PAUSED", "ACTIVE"],
    ]);
    /* One linear chain: each act supersedes the last, and only the last is current. */
    expect(acts[1]!.supersedesActId).toBe(acts[0]!.id);
    expect(acts[2]!.supersedesActId).toBe(acts[1]!.id);
    expect(acts.filter((a) => a.currentForOfferId !== null).map((a) => a.id)).toEqual([acts[2]!.id]);
    expect(await db.offerSourceRecordVersionRow.count({ where: { internalOfferId: o.internalOfferId } })).toBe(1);
  });

  it("12. a PAUSED Offer stays PAUSED when its terms are revised", async () => {
    const o = await activeOffer();
    const sel = { productRef: o.product.productRef, offerRef: o.offerRef };
    await pauseOfferAs(as(o.seller), { ...sel, now: next() }, { db });
    const body = { ...sel, expectedVersion: "1", terms: REPRICED };
    const disclosure = await disclosureOf(() => reviseOfferTermsAs(as(o.seller), { ...body, now: next() }, { db }));
    expect(await reviseOfferTermsAs(as(o.seller), { ...body, confirmation: disclosure, now: next() }, { db })).toMatchObject({
      state: "PAUSED",
      standingVersion: "2",
    });
  });

  it("13. Product suspension never rewrites the Offer; it blocks resume, never pause", async () => {
    const o = await activeOffer();
    const sel = { productRef: o.product.productRef, offerRef: o.offerRef };
    await suspendProduct(
      {
        internalProductId: o.product.internalProductId,
        reasonCode: "SAFETY_CONCERN",
        actingAccountId: await fx.seedOperator("product:suspend"),
        suspendedAt: next(),
      },
      { db },
    );
    const at = next();
    expect(lifecycleAt(await stateOf(o.internalOfferId), at)).toBe("ACTIVE");
    expect(await db.offerAct.count({ where: { internalOfferId: o.internalOfferId } })).toBe(1);

    await pauseOfferAs(as(o.seller), { ...sel, now: next() }, { db });
    const error = await resumeOfferAs(as(o.seller), { ...sel, expectedVersion: "1", now: next() }, { db }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OfferNotReadyError);
    expect((error as OfferNotReadyError).blockers).toContain("PRODUCT_NOT_ACTIVE");
  });

  it("14. withdrawal is terminal, releases the Product, and a new Offer gets a new ref", async () => {
    const o = await activeOffer();
    const sel = { productRef: o.product.productRef, offerRef: o.offerRef };
    expect(await withdrawOfferAs(as(o.seller), { ...sel, now: next() }, { db })).toMatchObject({ state: "WITHDRAWN" });
    const row = await db.offer.findUniqueOrThrow({ where: { internalOfferId: o.internalOfferId } });
    expect(row.nonTerminalForProductId).toBeNull();

    for (const act of [
      () => pauseOfferAs(as(o.seller), { ...sel, now: next() }, { db }),
      () => withdrawOfferAs(as(o.seller), { ...sel, now: next() }, { db }),
      () => resumeOfferAs(as(o.seller), { ...sel, expectedVersion: "1", now: next() }, { db }),
    ]) {
      const error = await act().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(OfferNotAuthorizedError);
      expect((error as OfferNotAuthorizedError).reasonCodes).toEqual(["OFFER_LIFECYCLE_TERMINAL"]);
    }

    const fresh = await createOfferAs(as(o.seller), { productRef: o.product.productRef, terms: TERMS, now: next() }, { db });
    expect(fresh.offerRef).not.toBe(o.offerRef);
    expect(fresh).toMatchObject({ state: "DRAFT", standingVersion: "1" });
    /* The withdrawn Offer and its history are untouched. */
    expect(await db.offerAct.count({ where: { internalOfferId: o.internalOfferId } })).toBe(2);
  });

  // — ENDED —

  it("15. ENDED is derived at the overall end with no write; the next create releases the marker, never earlier", async () => {
    const o = await draftOffer();
    const now = next();
    const until = plus(now, 24);
    await activate(o, { effectiveUntil: until, now });
    const actsBefore = await db.offerAct.count({ where: { internalOfferId: o.internalOfferId } });

    expect(lifecycleAt(await stateOf(o.internalOfferId), plus(until, -0.001))).toBe("ACTIVE");
    expect(lifecycleAt(await stateOf(o.internalOfferId), until)).toBe("ENDED");

    /* Before the end, the Product is still held. */
    await expect(
      createOfferAs(as(o.seller), { productRef: o.product.productRef, terms: TERMS, now: plus(until, -1) }, { db }),
    ).rejects.toBeInstanceOf(OfferAlreadyExistsError);
    const fresh = await createOfferAs(as(o.seller), { productRef: o.product.productRef, terms: TERMS, now: until }, { db });
    expect(fresh.offerRef).not.toBe(o.offerRef);
    expect(await db.offerAct.count({ where: { internalOfferId: o.internalOfferId } })).toBe(actsBefore);
    const ended = await db.offer.findUniqueOrThrow({ where: { internalOfferId: o.internalOfferId } });
    expect(ended.nonTerminalForProductId).toBeNull();
    minute += 24 * 60 + 5;
  });

  it("16. an overall end at or before the activation instant is refused", async () => {
    const o = await draftOffer();
    const now = next();
    await expect(activate(o, { effectiveUntil: now, now })).rejects.toBeInstanceOf(InvalidOfferInputError);
  });

  // — Promotions —

  it("17. a promotion is a SCHEDULED_PROMOTION version on its basis; standing is untouched; it reverts with no write", async () => {
    const o = await activeOffer();
    const now = next();
    const from = plus(now, 1);
    const until = plus(now, 2);
    const result = await schedule(o, { from, until }, "40.00", now);
    expect(result).toMatchObject({ standingVersion: "1", promotionVersion: "2" });
    const promotion = await getSourceVersion(o.internalOfferId, "2", { db });
    expect(promotion).toMatchObject({
      termsKind: "SCHEDULED_PROMOTION",
      basisStandingVersion: "1",
      supersedesSourceRecordVersion: "1",
      promotionWindow: { effectiveFrom: from, effectiveUntil: until },
      terms: { price: { wholesalePriceMinorUnits: 4000 } },
      economics: { calculatedCommissionMinorUnits: 800, calculatedCreatorGrossProceedsMinorUnits: 3200 },
    });
    expect((await getCurrentSourceVersion(o.internalOfferId, { db })).sourceRecordVersion).toBe("1");

    const state = await stateOf(o.internalOfferId);
    expect(promotionStatusAt(state, now)).toBe("SCHEDULED");
    expect(effectiveOfferTerms(state.resolution, now)).toEqual({ kind: "STANDING", sourceRecordVersion: "1" });
    expect(promotionStatusAt(state, from)).toBe("RUNNING");
    expect(effectiveOfferTerms(state.resolution, from)).toEqual({ kind: "SCHEDULED_PROMOTION", sourceRecordVersion: "2" });
    expect(promotionStatusAt(state, until)).toBe("ENDED");
    expect(effectiveOfferTerms(state.resolution, until)).toEqual({ kind: "STANDING", sourceRecordVersion: "1" });
    minute += 3 * 60;
  });

  it("18. while a promotion is pending, a second schedule and a standing revision are refused", async () => {
    const o = await activeOffer();
    const now = next();
    await schedule(o, { from: plus(now, 1), until: plus(now, 2) }, "40.00", now);
    const later = plus(now, 0.5);
    await expect(schedule(o, { from: plus(now, 3), until: plus(now, 4) }, "45.00", later)).rejects.toBeInstanceOf(
      OfferPromotionPendingError,
    );
    await expect(
      reviseOfferTermsAs(
        as(o.seller),
        { productRef: o.product.productRef, offerRef: o.offerRef, expectedVersion: "1", terms: REPRICED, now: later },
        { db },
      ),
    ).rejects.toBeInstanceOf(OfferPromotionPendingError);
    minute += 3 * 60;
  });

  it("19. a promotion may not be backdated, nor scheduled on a DRAFT", async () => {
    const o = await activeOffer();
    const now = next();
    await expect(schedule(o, { from: plus(now, -1), until: plus(now, 1) }, "40.00", now)).rejects.toBeInstanceOf(
      InvalidOfferInputError,
    );
    const d = await draftOffer();
    const error = await schedulePromotionAs(
      as(d.seller),
      {
        productRef: d.product.productRef,
        offerRef: d.offerRef,
        expectedVersion: "1",
        wholesalePrice: "40.00",
        effectiveFrom: plus(now, 1),
        effectiveUntil: plus(now, 2),
        now,
      },
      { db },
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OfferNotAuthorizedError);
    expect((error as OfferNotAuthorizedError).reasonCodes).toEqual(["OFFER_LIFECYCLE_TRANSITION_NOT_PERMITTED"]);
  });

  it("20. a future promotion may be replaced — history kept — but not once it has begun", async () => {
    const o = await activeOffer();
    const now = next();
    await schedule(o, { from: plus(now, 1), until: plus(now, 2) }, "40.00", now);
    const body = {
      productRef: o.product.productRef,
      offerRef: o.offerRef,
      expectedVersion: "1",
      expectedPromotionVersion: "2",
      wholesalePrice: "45.00",
      effectiveFrom: plus(now, 1.5),
      effectiveUntil: plus(now, 3),
    };
    const at = plus(now, 0.25);
    const disclosure = await disclosureOf(() => replacePromotionAs(as(o.seller), { ...body, now: at }, { db }));
    expect(disclosure.version).toBe("3");
    expect(await replacePromotionAs(as(o.seller), { ...body, confirmation: disclosure, now: at }, { db })).toMatchObject({
      promotionVersion: "3",
    });
    expect((await listSourceVersions(o.internalOfferId, { db })).map((v) => [v.sourceRecordVersion, v.termsKind])).toEqual([
      ["1", "STANDING"],
      ["2", "SCHEDULED_PROMOTION"],
      ["3", "SCHEDULED_PROMOTION"],
    ]);

    /* Running now: no longer replaceable. */
    await expect(
      replacePromotionAs(
        as(o.seller),
        { ...body, expectedPromotionVersion: "3", effectiveFrom: plus(now, 4), effectiveUntil: plus(now, 5), now: plus(now, 2) },
        { db },
      ),
    ).rejects.toBeInstanceOf(OfferPromotionNotReplaceableError);
    /* A stale promotion version is refused before anything else. */
    await expect(replacePromotionAs(as(o.seller), { ...body, now: at }, { db })).rejects.toBeInstanceOf(
      OfferVersionStaleError,
    );
    minute += 4 * 60;
  });

  it("21. a running promotion ends early by an act; the lifecycle is unchanged and standing terms apply at once", async () => {
    const o = await activeOffer();
    const now = next();
    await schedule(o, { from: plus(now, 1), until: plus(now, 3) }, "40.00", now);
    const sel = { productRef: o.product.productRef, offerRef: o.offerRef, expectedPromotionVersion: "2" };
    await expect(endPromotionAs(as(o.seller), { ...sel, now: plus(now, 0.5) }, { db })).rejects.toBeInstanceOf(
      OfferPromotionNotRunningError,
    );
    const endedAt = plus(now, 2);
    expect(await endPromotionAs(as(o.seller), { ...sel, now: endedAt }, { db })).toMatchObject({ state: "ACTIVE" });
    const act = await db.offerAct.findFirstOrThrow({ where: { internalOfferId: o.internalOfferId, act: "END_PROMOTION" } });
    expect(act).toMatchObject({ previousState: "ACTIVE", state: "ACTIVE", endedPromotionVersion: "2" });

    const state = await stateOf(o.internalOfferId);
    expect(promotionStatusAt(state, endedAt)).toBe("ENDED_EARLY");
    expect(effectiveOfferTerms(state.resolution, endedAt)).toEqual({ kind: "STANDING", sourceRecordVersion: "1" });
    /* Ended, so no longer pending: a new one may be scheduled. */
    expect(await schedule(o, { from: plus(now, 4), until: plus(now, 5) }, "42.00", plus(now, 2.5))).toMatchObject({
      promotionVersion: "3",
    });
    minute += 6 * 60;
  });

  // — Ownership —

  it("22. another Seller's Offer, an unknown ref, and an Offer named under another Product are one 404", async () => {
    const o = await activeOffer();
    const other = await fx.readySeller();
    const otherProduct = await fx.draftProduct(other);
    const promoter = await fx.draftParticipant(["PROMOTER"]);
    for (const [actor, productRef, offerRef] of [
      [other, o.product.productRef, o.offerRef],
      [promoter, o.product.productRef, o.offerRef],
      [o.seller, o.product.productRef, UNKNOWN_REF],
      [o.seller, otherProduct.productRef, o.offerRef],
    ] as const) {
      await expect(pauseOfferAs(as(actor), { productRef, offerRef, now: next() }, { db })).rejects.toBeInstanceOf(
        OfferNotFoundError,
      );
      await expect(withdrawOfferAs(as(actor), { productRef, offerRef, now: next() }, { db })).rejects.toBeInstanceOf(
        OfferNotFoundError,
      );
    }
    const at = next();
    expect(lifecycleAt(await stateOf(o.internalOfferId), at)).toBe("ACTIVE");
  });

  // — Read model —

  it("23. the Seller's read model shows the derived state, actions, and blockers", async () => {
    const o = await draftOffer();
    const at = next();
    const draft = (await readOffers(o, at)).get(o.product.internalProductId)!;
    expect(draft.canCreate).toBe(false);
    expect(draft.offer).toMatchObject({
      offerRef: o.offerRef,
      lifecycle: "DRAFT",
      effective: "NONE",
      nextVersion: "2",
      blockers: [],
      standing: { version: "1", calculatedCommissionMinorUnits: 1000, calculatedSellerGrossProceedsMinorUnits: 4000 },
      actions: { activate: true, revise: true, withdraw: true, pause: false, schedulePromotion: false },
    });
    expect(JSON.stringify(draft)).not.toContain(o.internalOfferId);

    await withdrawOfferAs(as(o.seller), { productRef: o.product.productRef, offerRef: o.offerRef, now: next() }, { db });
    const home = await readAccountHome(o.seller.accountId, { db, now: next() });
    const product = home!.products.find((p) => p.productRef === o.product.productRef)!;
    expect(product.offer.canCreate).toBe(true);
    expect(product.offer.offer).toMatchObject({ lifecycle: "WITHDRAWN", actions: { withdraw: false, revise: false } });
  });

  it("23a. a promotion whose window covers now is in force only while the Offer is ACTIVE", async () => {
    const o = await activeOffer();
    const now = next();
    await schedule(o, { from: plus(now, 1), until: plus(now, 3) }, "40.00", now);
    const sel = { productRef: o.product.productRef, offerRef: o.offerRef };
    const within = () => plus(now, 1.5);
    const promotionAt = async (at: string) => (await readOffers(o, at)).get(o.product.internalProductId)!.offer!;

    expect(await promotionAt(within())).toMatchObject({
      lifecycle: "ACTIVE",
      effective: "SCHEDULED_PROMOTION",
      promotion: { status: "RUNNING", inForce: true },
    });

    await pauseOfferAs(as(o.seller), { ...sel, now: plus(now, 1.2) }, { db });
    /* The schedule fact is kept — its window covers now — but it is not in force. */
    expect(await promotionAt(within())).toMatchObject({
      lifecycle: "PAUSED",
      effective: "NONE",
      promotion: { status: "RUNNING", inForce: false },
    });

    await withdrawOfferAs(as(o.seller), { ...sel, now: plus(now, 1.3) }, { db });
    expect(await promotionAt(within())).toMatchObject({
      lifecycle: "WITHDRAWN",
      effective: "NONE",
      promotion: { status: "RUNNING", inForce: false },
    });
    minute += 4 * 60;
  });

  it("23b. canCreate agrees with the create operation: a suspension or an inactive SELLER role is false", async () => {
    const suspended = await fx.readySeller();
    const suspendedProduct = await fx.activeProduct(suspended);
    /* A suspension names the policy version it was imposed under. Arrange that
       row only if no earlier suite left one, and remove only what was arranged. */
    const policyKey = { policyId: MONACADO_MARKETPLACE_POLICY_ID, policyVersion: MARKETPLACE_POLICY_VERSION_1 };
    const arrangedPolicy = (await db.marketplacePolicy.count({ where: { id: policyKey.policyId } })) === 0;
    const arrangedVersion = (await db.marketplacePolicyVersionRow.count({ where: policyKey })) === 0;
    if (arrangedPolicy) {
      await db.marketplacePolicy.create({ data: { id: policyKey.policyId, label: "p142offer fixture", createdAt: new Date(NOW) } });
    }
    if (arrangedVersion) {
      await db.marketplacePolicyVersionRow.create({
        data: {
          ...policyKey,
          status: "DRAFT",
          title: "p142offer fixture",
          contentRef: "p142offer/fixture",
          contentHash: "0".repeat(64),
          requiresReacceptance: false,
          effectiveFrom: new Date(NOW),
          recordedByAccountId: suspended.accountId,
          recordedAt: new Date(NOW),
        },
      });
    }
    try {
      await db.participantSuspension.create({
        data: {
          id: `mon:psus:p142offer${(minute += 1)}`,
          participantId: suspended.participantId,
          reasonCode: "ADVERSE_OUTCOME_LEVEL_UNSUSTAINABLE",
          status: "ACTIVE",
          statusBeforeSuspension: "ACTIVE",
          imposedAt: new Date(next()),
          imposedByAccountId: await fx.seedOperator("participant:suspend"),
          marketplacePolicyId: MONACADO_MARKETPLACE_POLICY_ID,
          marketplacePolicyVersion: MARKETPLACE_POLICY_VERSION_1,
          activeForParticipantId: suspended.participantId,
        },
      });
      const at = next();
      expect(
        (await readOffers({ seller: suspended, product: suspendedProduct }, at)).get(suspendedProduct.internalProductId),
      ).toEqual({ offer: null, canCreate: false });
      await expect(
        createOfferAs(as(suspended), { productRef: suspendedProduct.productRef, terms: TERMS, now: at }, { db }),
      ).rejects.toBeInstanceOf(ParticipantActionNotPermittedError);
    } finally {
      await db.participantSuspension.deleteMany({ where: { participantId: suspended.participantId } });
      if (arrangedVersion) await db.marketplacePolicyVersionRow.deleteMany({ where: policyKey });
      if (arrangedPolicy) await db.marketplacePolicy.deleteMany({ where: { id: policyKey.policyId } });
    }

    const revoked = await fx.readySeller();
    const revokedProduct = await fx.activeProduct(revoked);
    await db.marketplaceRoleAssignment.updateMany({
      where: { participantId: revoked.participantId, role: "SELLER" },
      data: { status: "REVOKED" },
    });
    const later = next();
    expect((await readOffers({ seller: revoked, product: revokedProduct }, later)).get(revokedProduct.internalProductId))
      .toEqual({ offer: null, canCreate: false });
    await expect(
      createOfferAs(as(revoked), { productRef: revokedProduct.productRef, terms: TERMS, now: later }, { db }),
    ).rejects.toBeInstanceOf(OfferNotAuthorizedError);
    expect(await db.offer.count({ where: { internalProductId: { in: [suspendedProduct.internalProductId, revokedProduct.internalProductId] } } })).toBe(0);
  });

  it("23c. offered actions agree with each act's refusal: restricted payments withdraw revise and promotions, not stand-downs", async () => {
    const o = await activeOffer();
    await db.participantPaymentAccount.updateMany({
      where: { participantId: o.seller.participantId },
      data: { readiness: "RESTRICTED" },
    });
    const at = next();
    expect((await readOffers(o, at)).get(o.product.internalProductId)!.offer!.actions).toEqual({
      revise: false,
      activate: false,
      pause: true,
      resume: false,
      withdraw: true,
      schedulePromotion: false,
      replacePromotion: false,
      endPromotion: false,
    });
    const sel = { productRef: o.product.productRef, offerRef: o.offerRef };
    await expect(
      reviseOfferTermsAs(as(o.seller), { ...sel, expectedVersion: "1", terms: REPRICED, now: at }, { db }),
    ).rejects.toBeInstanceOf(OfferNotAuthorizedError);
    await expect(
      schedulePromotionAs(
        as(o.seller),
        { ...sel, expectedVersion: "1", wholesalePrice: "40.00", effectiveFrom: plus(at, 1), effectiveUntil: plus(at, 2), now: at },
        { db },
      ),
    ).rejects.toBeInstanceOf(OfferNotAuthorizedError);
    /* Standing down stays open — the Seller who most needs to stop can. */
    expect(await pauseOfferAs(as(o.seller), { ...sel, now: next() }, { db })).toMatchObject({ state: "PAUSED" });
  });

  // — Integrity —

  it("24. history is RESTRICT-protected: no Product, participant, or Offer delete beneath it", async () => {
    const o = await activeOffer();
    await expect(db.product.delete({ where: { internalProductId: o.product.internalProductId } })).rejects.toThrow();
    await expect(db.marketplaceParticipant.delete({ where: { id: o.seller.participantId } })).rejects.toThrow();
    await expect(db.offer.delete({ where: { internalOfferId: o.internalOfferId } })).rejects.toThrow();
  });

  it("25. a persisted row reconstructs into the contract; corruption fails loudly", async () => {
    const o = await draftOffer();
    const row = await db.offerSourceRecordVersionRow.findFirstOrThrow({ where: { internalOfferId: o.internalOfferId } });
    expect(OfferSourceVersion.safeParse(versionRowToSourceVersion(row)).success).toBe(true);
    await expect(getSourceVersion(o.internalOfferId, "9", { db })).rejects.toBeInstanceOf(OfferVersionNotFoundError);

    await db.offerSourceRecordVersionRow.updateMany({
      where: { internalOfferId: o.internalOfferId },
      data: { calculatedCommissionMinorUnits: 4242n },
    });
    await expect(getOffer(o.internalOfferId, { db })).rejects.toBeInstanceOf(CorruptOfferRecordError);
    await db.offerSourceRecordVersionRow.updateMany({
      where: { internalOfferId: o.internalOfferId },
      data: { calculatedCommissionMinorUnits: 1000n, termsKind: "NONSENSE" },
    });
    await expect(getOffer(o.internalOfferId, { db })).rejects.toBeInstanceOf(CorruptOfferRecordError);
  });

  it("26. a persisted version and a derived lifecycle feed the Offer projection; a DRAFT is refused", async () => {
    const o = await activeOffer();
    const persisted = await getCurrentSourceVersion(o.internalOfferId, { db });
    const at = next();
    const context = (offerLifecycle: string) => ({
      offerBinding: { offerNode: `an:node:${"1".repeat(26)}`, internalOfferId: persisted.internalOfferId },
      productBinding: { productNode: `an:node:${"2".repeat(26)}`, internalProductId: persisted.internalProductId },
      authorityBinding: { authorityNode: `an:node:${"3".repeat(26)}`, sellerParticipantId: persisted.sellerParticipantId },
      sourceVersionBinding: {
        offerSourceRecordId: persisted.offerSourceRecordId,
        sourceRecordVersion: persisted.sourceRecordVersion,
      },
      capsuleId: `an:capsule:${"4".repeat(26)}`,
      capsuleVersion: "2.0.0",
      mappingVersion: OFFER_PROJECTION_MAPPING_VERSION,
      generatedAt: at,
      nodePolicy: { ref: "mon:policy:node/offer", version: "1" },
      capsulePolicy: { ref: "mon:policy:capsule/offer", version: "1" },
      offerLifecycle,
    });
    const lifecycle = lifecycleAt(await stateOf(o.internalOfferId), at);
    const capsule = projectOfferCapsule({ sourceVersion: persisted, context: context(lifecycle) as never });
    expect(capsule.data.commercialState).toBe("AVAILABLE");
    const serialized = canonicalJsonString(capsule);
    for (const internal of [o.internalOfferId, o.seller.participantId, o.seller.accountId]) {
      expect(serialized).not.toContain(internal);
    }
    expect(() => projectOfferCapsule({ sourceVersion: persisted, context: context("DRAFT") as never })).toThrow(
      /NOT_PROJECTION_ELIGIBLE/,
    );
  });

  it("27. no Offer act publishes anything", async () => {
    const counts = async () => [
      await db.publicationOutbox.count(),
      await db.registrarReceipt.count(),
      await db.productPublication.count(),
    ];
    const before = await counts();
    const o = await activeOffer();
    const now = next();
    await schedule(o, { from: plus(now, 1), until: plus(now, 2) }, "40.00", now);
    await pauseOfferAs(as(o.seller), { productRef: o.product.productRef, offerRef: o.offerRef, now: plus(now, 0.5) }, { db });
    expect(await counts()).toEqual(before);
    minute += 3 * 60;
  });
});
