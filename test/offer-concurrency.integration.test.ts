/**
 * Offer concurrency and history invariants, against a real database (Phase 1.42).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * Every race runs the competing acts at once and accepts either serialisation —
 * the Product row lock decides the order, never the test — then asserts the
 * outcome is one a serial order could produce, and that the invariants hold:
 *
 *   - at most one non-terminal Offer per Product;
 *   - exactly one current STANDING version per Offer;
 *   - at most one current promotion per Offer, and it is a promotion version;
 *   - one unbroken, immutable version chain ("1".."n", each superseding the last);
 *   - one linear act chain, exactly one current act;
 *   - terminal Offers keep their whole history.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { suspendProduct } from "../src/server/marketplace/product-suspension-service";
import {
  activateOfferAs,
  createOfferAs,
  endPromotionAs,
  lifecycleAt,
  pauseOfferAs,
  promotionStatusAt,
  readOfferStateIn,
  replacePromotionAs,
  resumeOfferAs,
  reviseOfferTermsAs,
  schedulePromotionAs,
  withdrawOfferAs,
} from "../src/server/marketplace/offer-service";
import {
  OfferAlreadyExistsError,
  OfferConfirmationRequiredError,
  OfferConflictError,
  OfferNotAuthorizedError,
  OfferNotReadyError,
  OfferPromotionNotReplaceableError,
  OfferPromotionNotRunningError,
  OfferPromotionPendingError,
  OfferVersionStaleError,
} from "../src/server/marketplace/offer-errors";
import { effectiveOfferTerms } from "../src/contracts/marketplace/offer-source";
import { sellerCommerceFixture, type FixtureActor, type FixtureProduct } from "./support/seller-commerce-fixture";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2029-03-01T09:00:00.000Z";
const BASE = Date.parse("2029-04-01T09:00:00.000Z");
const ORIGIN = "https://monacado.test";

const fx = sellerCommerceFixture({ db, emailPrefix: "p142race", now: NOW, origin: ORIGIN });

let minute = 0;
const next = (): string => new Date(BASE + (minute += 10) * 60_000).toISOString();
const plusMs = (from: string, ms: number): string => new Date(Date.parse(from) + ms).toISOString();
const HOUR = 3_600_000;

const TERMS = { wholesalePrice: "50.00", currency: "USD", commission: { method: "PERCENT_OF_WHOLESALE", percent: "20" } };
const REPRICED = { ...TERMS, wholesalePrice: "60.00" };
const as = (actor: { accountId: string }) => ({ accountId: actor.accountId });

const UNCONFIRMED = {
  version: "999",
  calculatedCommissionMinorUnits: 0,
  calculatedSellerGrossProceedsMinorUnits: 0,
  commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
};

async function disclosureOf(write: () => Promise<unknown>) {
  const error = await write().then(
    () => {
      throw new Error("expected the write to ask for confirmation");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OfferConfirmationRequiredError);
  return (error as OfferConfirmationRequiredError).disclosure;
}

interface Ready {
  seller: FixtureActor;
  product: FixtureProduct;
  offerRef: string;
  internalOfferId: string;
  sel: { productRef: string; offerRef: string };
}

async function draftOffer(seller?: FixtureActor, product?: FixtureProduct): Promise<Ready> {
  const s = seller ?? (await fx.readySeller());
  const p = product ?? (await fx.activeProduct(s));
  const created = await createOfferAs(as(s), { productRef: p.productRef, terms: TERMS, now: next() }, { db });
  const { internalOfferId } = await db.offer.findUniqueOrThrow({ where: { offerRef: created.offerRef } });
  return {
    seller: s,
    product: p,
    offerRef: created.offerRef,
    internalOfferId,
    sel: { productRef: p.productRef, offerRef: created.offerRef },
  };
}

async function activate(o: Ready, opts: { effectiveUntil?: string; now?: string } = {}) {
  const body = { ...o.sel, ...(opts.effectiveUntil ? { effectiveUntil: opts.effectiveUntil } : {}), now: opts.now ?? next() };
  const disclosure = await disclosureOf(() => activateOfferAs(as(o.seller), { ...body, confirmation: UNCONFIRMED }, { db }));
  return activateOfferAs(as(o.seller), { ...body, confirmation: disclosure }, { db });
}

async function activeOffer(opts: { effectiveUntil?: string; now?: string } = {}): Promise<Ready> {
  const o = await draftOffer();
  await activate(o, opts);
  return o;
}

/** A confirmed revision body for the next label, built from the server's own disclosure. */
async function confirmedRevision(o: Ready, terms: typeof TERMS, now: string) {
  const offer = await db.offer.findUniqueOrThrow({ where: { internalOfferId: o.internalOfferId } });
  const body = { ...o.sel, expectedVersion: offer.currentSourceRecordVersion, terms, now };
  const disclosure = await disclosureOf(() => reviseOfferTermsAs(as(o.seller), body, { db }));
  return { ...body, confirmation: disclosure };
}

/** A confirmed promotion body for the next label. */
async function confirmedPromotion(o: Ready, window: { from: string; until: string }, wholesalePrice: string, now: string) {
  const offer = await db.offer.findUniqueOrThrow({ where: { internalOfferId: o.internalOfferId } });
  const body = {
    ...o.sel,
    expectedVersion: offer.currentSourceRecordVersion,
    wholesalePrice,
    effectiveFrom: window.from,
    effectiveUntil: window.until,
    now,
  };
  const disclosure = await disclosureOf(() => schedulePromotionAs(as(o.seller), body, { db }));
  return { ...body, confirmation: disclosure };
}

async function stateOf(internalOfferId: string) {
  return readOfferStateIn(db, await db.offer.findUniqueOrThrow({ where: { internalOfferId } }));
}

const fulfilled = (results: PromiseSettledResult<unknown>[]) => results.filter((r) => r.status === "fulfilled").length;
const rejections = (results: PromiseSettledResult<unknown>[]) =>
  results.filter((r): r is PromiseRejectedResult => r.status === "rejected").map((r) => r.reason as unknown);

/** Every rejection is one of the named, bounded refusals — never a 500. */
function expectRefusedAs(results: PromiseSettledResult<unknown>[], ...allowed: Array<new (...args: never[]) => Error>) {
  for (const reason of rejections(results)) {
    expect(allowed.some((cls) => reason instanceof cls), String(reason)).toBe(true);
  }
}

/** The six invariants, for every Offer on a Product. */
async function expectInvariants(internalProductId: string, at: string): Promise<void> {
  const offers = await db.offer.findMany({ where: { internalProductId } });
  expect(offers.filter((o) => o.nonTerminalForProductId !== null).length).toBeLessThanOrEqual(1);
  for (const o of offers) {
    expect(o.nonTerminalForProductId === null || o.nonTerminalForProductId === internalProductId).toBe(true);

    const versions = await db.offerSourceRecordVersionRow.findMany({
      where: { internalOfferId: o.internalOfferId },
      orderBy: { seq: "asc" },
    });
    expect(versions.map((v) => v.sourceRecordVersion)).toEqual(versions.map((_, i) => String(i + 1)));
    versions.forEach((v, i) => expect(v.supersedesSourceRecordVersion).toBe(i === 0 ? null : String(i)));
    const standing = versions.find((v) => v.sourceRecordVersion === o.currentSourceRecordVersion);
    expect(standing?.termsKind).toBe("STANDING");
    if (o.currentPromotionVersion !== null) {
      const promotion = versions.find((v) => v.sourceRecordVersion === o.currentPromotionVersion);
      expect(promotion?.termsKind).toBe("SCHEDULED_PROMOTION");
      expect(Number(promotion!.basisStandingVersion)).toBeLessThan(Number(promotion!.sourceRecordVersion));
    }

    const acts = await db.offerAct.findMany({ where: { internalOfferId: o.internalOfferId }, orderBy: { actedAt: "asc" } });
    if (acts.length > 0) {
      expect(acts.filter((a) => a.currentForOfferId !== null)).toHaveLength(1);
      /* Linear: walk back from the current act and visit every act exactly once. */
      const byId = new Map(acts.map((a) => [a.id, a]));
      let cursor = acts.find((a) => a.currentForOfferId !== null);
      const walked: string[] = [];
      while (cursor !== undefined) {
        walked.push(cursor.id);
        cursor = cursor.supersedesActId === null ? undefined : byId.get(cursor.supersedesActId);
      }
      expect([...walked].sort()).toEqual(acts.map((a) => a.id).sort());
      const chain = [...walked].reverse().map((id) => byId.get(id)!);
      expect(chain[0]!.previousState).toBe("DRAFT");
      chain.slice(1).forEach((a, i) => expect(a.previousState).toBe(chain[i]!.state));
    }
    /* A released marker means terminal at `at`; history stays. */
    if (o.nonTerminalForProductId === null) {
      expect(["WITHDRAWN", "ENDED"]).toContain(lifecycleAt(await readOfferStateIn(db, o), at));
      expect(versions.length).toBeGreaterThan(0);
    }
  }
}

const describeDb = RUN ? describe : describe.skip;

describeDb("Offer concurrency and history (Phase 1.42)", () => {
  beforeEach(fx.cleanup);
  afterAll(async () => {
    await fx.cleanup();
    await disconnectPrisma();
  });

  it("1. concurrent creates: exactly one Offer", async () => {
    const seller = await fx.readySeller();
    const product = await fx.activeProduct(seller);
    const now = next();
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => createOfferAs(as(seller), { productRef: product.productRef, terms: TERMS, now }, { db })),
    );
    expect(fulfilled(results)).toBe(1);
    expectRefusedAs(results, OfferAlreadyExistsError, OfferConflictError);
    expect(await db.offer.count({ where: { internalProductId: product.internalProductId } })).toBe(1);
    await expectInvariants(product.internalProductId, now);
  });

  it("2. a create racing the prior Offer's withdrawal: never two non-terminal Offers", async () => {
    const o = await activeOffer();
    const now = next();
    const [withdrawn, created] = await Promise.allSettled([
      withdrawOfferAs(as(o.seller), { ...o.sel, now }, { db }),
      createOfferAs(as(o.seller), { productRef: o.product.productRef, terms: TERMS, now }, { db }),
    ]);
    expect(withdrawn.status).toBe("fulfilled");
    expectRefusedAs([created], OfferAlreadyExistsError);
    /* Whichever order the lock chose, a create now succeeds or already has. */
    if (created.status === "rejected") {
      await createOfferAs(as(o.seller), { productRef: o.product.productRef, terms: TERMS, now: next() }, { db });
    }
    expect(await db.offer.count({ where: { internalProductId: o.product.internalProductId } })).toBe(2);
    await expectInvariants(o.product.internalProductId, next());
  });

  it("3. concurrent creates after the prior Offer's derived end: one new Offer, the ENDED one intact", async () => {
    const start = next();
    const until = plusMs(start, HOUR);
    const o = await activeOffer({ effectiveUntil: until, now: start });
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        createOfferAs(as(o.seller), { productRef: o.product.productRef, terms: TERMS, now: until }, { db }),
      ),
    );
    expect(fulfilled(results)).toBe(1);
    expectRefusedAs(results, OfferAlreadyExistsError, OfferConflictError);
    expect(lifecycleAt(await stateOf(o.internalOfferId), until)).toBe("ENDED");
    expect(await db.offerAct.count({ where: { internalOfferId: o.internalOfferId } })).toBe(1);
    await expectInvariants(o.product.internalProductId, until);
    minute += 120;
  });

  it("4. concurrent standing revisions from the same version: one wins, the other is stale", async () => {
    const o = await draftOffer();
    const now = next();
    const results = await Promise.allSettled([
      reviseOfferTermsAs(as(o.seller), { ...o.sel, expectedVersion: "1", terms: REPRICED, now }, { db }),
      reviseOfferTermsAs(as(o.seller), { ...o.sel, expectedVersion: "1", terms: { ...TERMS, wholesalePrice: "70.00" }, now }, { db }),
    ]);
    expect(fulfilled(results)).toBe(1);
    expectRefusedAs(results, OfferVersionStaleError, OfferConflictError);
    expect(await db.offerSourceRecordVersionRow.count({ where: { internalOfferId: o.internalOfferId } })).toBe(2);
    await expectInvariants(o.product.internalProductId, now);
  });

  it("5. stale confirmations race: two Sellers' tabs confirm the same next version — one mints it", async () => {
    const o = await activeOffer();
    const now = next();
    const a = await confirmedRevision(o, REPRICED, now);
    const b = await confirmedRevision(o, { ...TERMS, wholesalePrice: "70.00" }, now);
    const results = await Promise.allSettled([
      reviseOfferTermsAs(as(o.seller), a, { db }),
      reviseOfferTermsAs(as(o.seller), b, { db }),
    ]);
    expect(fulfilled(results)).toBe(1);
    expectRefusedAs(results, OfferVersionStaleError, OfferConflictError);
    await expectInvariants(o.product.internalProductId, now);
  });

  it("6. activation confirming v1 races a DRAFT revision minting v2: one lands, the other must re-confirm", async () => {
    const o = await draftOffer();
    const now = next();
    const disclosure = await disclosureOf(() =>
      activateOfferAs(as(o.seller), { ...o.sel, confirmation: UNCONFIRMED, now }, { db }),
    );
    const results = await Promise.allSettled([
      activateOfferAs(as(o.seller), { ...o.sel, confirmation: disclosure, now }, { db }),
      reviseOfferTermsAs(as(o.seller), { ...o.sel, expectedVersion: "1", terms: REPRICED, now }, { db }),
    ]);
    expect(fulfilled(results)).toBe(1);
    /* Revision first: the activation's v1 confirmation no longer names the
       standing version. Activation first: the revision is now live and
       unconfirmed. Either way the loser is asked to confirm, never applied. */
    expectRefusedAs(results, OfferConfirmationRequiredError);
    await expectInvariants(o.product.internalProductId, now);
  });

  it("7. activate vs withdraw: the Offer ends WITHDRAWN, by a linear chain", async () => {
    const o = await draftOffer();
    const now = next();
    const disclosure = await disclosureOf(() =>
      activateOfferAs(as(o.seller), { ...o.sel, confirmation: UNCONFIRMED, now }, { db }),
    );
    const [activated, withdrawn] = await Promise.allSettled([
      activateOfferAs(as(o.seller), { ...o.sel, confirmation: disclosure, now }, { db }),
      withdrawOfferAs(as(o.seller), { ...o.sel, now }, { db }),
    ]);
    expect(withdrawn.status).toBe("fulfilled");
    if (activated.status === "rejected") {
      expect(activated.reason).toBeInstanceOf(OfferNotAuthorizedError);
      expect((activated.reason as OfferNotAuthorizedError).reasonCodes).toEqual(["OFFER_LIFECYCLE_TERMINAL"]);
    }
    expect(lifecycleAt(await stateOf(o.internalOfferId), now)).toBe("WITHDRAWN");
    await expectInvariants(o.product.internalProductId, now);
  });

  it("8. pause vs a confirmed revision: both land in either order; PAUSED under the new version", async () => {
    const o = await activeOffer();
    const now = next();
    const revision = await confirmedRevision(o, REPRICED, now);
    const results = await Promise.allSettled([
      pauseOfferAs(as(o.seller), { ...o.sel, now }, { db }),
      reviseOfferTermsAs(as(o.seller), revision, { db }),
    ]);
    expect(fulfilled(results)).toBe(2);
    const state = await stateOf(o.internalOfferId);
    expect(lifecycleAt(state, now)).toBe("PAUSED");
    expect(state.offer.currentSourceRecordVersion).toBe("2");
    await expectInvariants(o.product.internalProductId, now);
  });

  it("9. resume vs Product suspension: resume lands first or is refused not-ready — never resumed onto a suspended Product after", async () => {
    const o = await activeOffer();
    await pauseOfferAs(as(o.seller), { ...o.sel, now: next() }, { db });
    const suspender = await fx.seedOperator("product:suspend");
    const now = next();
    const [resumed, suspended] = await Promise.allSettled([
      resumeOfferAs(as(o.seller), { ...o.sel, expectedVersion: "1", now }, { db }),
      suspendProduct(
        { internalProductId: o.product.internalProductId, reasonCode: "SAFETY_CONCERN", actingAccountId: suspender, suspendedAt: now },
        { db },
      ),
    ]);
    expect(suspended.status).toBe("fulfilled");
    expectRefusedAs([resumed], OfferNotReadyError);
    /* Suspension never rewrites the Offer: whatever the resume decided stands. */
    expect(lifecycleAt(await stateOf(o.internalOfferId), now)).toBe(resumed.status === "fulfilled" ? "ACTIVE" : "PAUSED");
    await expectInvariants(o.product.internalProductId, now);
  });

  it("10. concurrent promotion scheduling: one promotion", async () => {
    const o = await activeOffer();
    const now = next();
    const window = { from: plusMs(now, HOUR), until: plusMs(now, 2 * HOUR) };
    const a = await confirmedPromotion(o, window, "40.00", now);
    const b = await confirmedPromotion(o, window, "40.00", now);
    const results = await Promise.allSettled([
      schedulePromotionAs(as(o.seller), a, { db }),
      schedulePromotionAs(as(o.seller), b, { db }),
    ]);
    expect(fulfilled(results)).toBe(1);
    expectRefusedAs(results, OfferPromotionPendingError, OfferConflictError);
    expect(
      await db.offerSourceRecordVersionRow.count({ where: { internalOfferId: o.internalOfferId, termsKind: "SCHEDULED_PROMOTION" } }),
    ).toBe(1);
    await expectInvariants(o.product.internalProductId, now);
    minute += 180;
  });

  it("11. concurrent replacement of a future promotion: one replacement, the original kept", async () => {
    const o = await activeOffer();
    const now = next();
    await schedulePromotionAs(
      as(o.seller),
      await confirmedPromotion(o, { from: plusMs(now, HOUR), until: plusMs(now, 2 * HOUR) }, "40.00", now),
      { db },
    );
    const replace = async (wholesalePrice: string) => {
      const body = {
        ...o.sel,
        expectedVersion: "1",
        expectedPromotionVersion: "2",
        wholesalePrice,
        effectiveFrom: plusMs(now, 3 * HOUR),
        effectiveUntil: plusMs(now, 4 * HOUR),
        now,
      };
      const disclosure = await disclosureOf(() => replacePromotionAs(as(o.seller), body, { db }));
      return { ...body, confirmation: disclosure };
    };
    const [a, b] = [await replace("41.00"), await replace("42.00")];
    const results = await Promise.allSettled([
      replacePromotionAs(as(o.seller), a, { db }),
      replacePromotionAs(as(o.seller), b, { db }),
    ]);
    expect(fulfilled(results)).toBe(1);
    expectRefusedAs(results, OfferVersionStaleError, OfferConflictError);
    expect(await db.offerSourceRecordVersionRow.count({ where: { internalOfferId: o.internalOfferId } })).toBe(3);
    await expectInvariants(o.product.internalProductId, now);
    minute += 300;
  });

  it("12. standing revision vs promotion scheduling: exactly one, and the loser is refused for the winner's reason", async () => {
    const o = await activeOffer();
    const now = next();
    const revision = await confirmedRevision(o, REPRICED, now);
    const promotion = await confirmedPromotion(o, { from: plusMs(now, HOUR), until: plusMs(now, 2 * HOUR) }, "40.00", now);
    const [revised, scheduled] = await Promise.allSettled([
      reviseOfferTermsAs(as(o.seller), revision, { db }),
      schedulePromotionAs(as(o.seller), promotion, { db }),
    ]);
    expect(fulfilled([revised, scheduled])).toBe(1);
    /* Revision first: the promotion was built on a superseded standing version.
       Promotion first: a pending promotion freezes the standing terms. */
    if (revised.status === "rejected") expect(revised.reason).toBeInstanceOf(OfferPromotionPendingError);
    if (scheduled.status === "rejected") expect(scheduled.reason).toBeInstanceOf(OfferVersionStaleError);
    await expectInvariants(o.product.internalProductId, now);
    minute += 180;
  });

  it("13. a standing revision is refused while a promotion is upcoming and while it runs", async () => {
    const o = await activeOffer();
    const now = next();
    const from = plusMs(now, HOUR);
    await schedulePromotionAs(as(o.seller), await confirmedPromotion(o, { from, until: plusMs(now, 2 * HOUR) }, "40.00", now), {
      db,
    });
    for (const at of [plusMs(now, 1), from]) {
      await expect(
        reviseOfferTermsAs(as(o.seller), { ...o.sel, expectedVersion: "1", terms: REPRICED, now: at }, { db }),
      ).rejects.toBeInstanceOf(OfferPromotionPendingError);
    }
    await expectInvariants(o.product.internalProductId, from);
    minute += 180;
  });

  it("14. concurrent early ends: one END_PROMOTION act", async () => {
    const o = await activeOffer();
    const now = next();
    await schedulePromotionAs(
      as(o.seller),
      await confirmedPromotion(o, { from: plusMs(now, HOUR), until: plusMs(now, 3 * HOUR) }, "40.00", now),
      { db },
    );
    const at = plusMs(now, 2 * HOUR);
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () => endPromotionAs(as(o.seller), { ...o.sel, expectedPromotionVersion: "2", now: at }, { db })),
    );
    expect(fulfilled(results)).toBe(1);
    expectRefusedAs(results, OfferPromotionNotRunningError, OfferConflictError);
    expect(await db.offerAct.count({ where: { internalOfferId: o.internalOfferId, act: "END_PROMOTION" } })).toBe(1);
    await expectInvariants(o.product.internalProductId, at);
    minute += 240;
  });

  it("15. the exact effectiveFrom boundary: scheduled and replaceable before, running and not replaceable at", async () => {
    const o = await activeOffer();
    const now = next();
    const from = plusMs(now, HOUR);
    const until = plusMs(now, 2 * HOUR);
    await schedulePromotionAs(as(o.seller), await confirmedPromotion(o, { from, until }, "40.00", now), { db });
    const state = await stateOf(o.internalOfferId);
    const before = plusMs(from, -1);
    expect(promotionStatusAt(state, before)).toBe("SCHEDULED");
    expect(effectiveOfferTerms(state.resolution, before)).toEqual({ kind: "STANDING", sourceRecordVersion: "1" });
    expect(promotionStatusAt(state, from)).toBe("RUNNING");
    expect(effectiveOfferTerms(state.resolution, from)).toEqual({ kind: "SCHEDULED_PROMOTION", sourceRecordVersion: "2" });

    await expect(
      endPromotionAs(as(o.seller), { ...o.sel, expectedPromotionVersion: "2", now: before }, { db }),
    ).rejects.toBeInstanceOf(OfferPromotionNotRunningError);
    await expect(
      replacePromotionAs(
        as(o.seller),
        {
          ...o.sel,
          expectedVersion: "1",
          expectedPromotionVersion: "2",
          wholesalePrice: "45.00",
          effectiveFrom: plusMs(now, 3 * HOUR),
          effectiveUntil: plusMs(now, 4 * HOUR),
          now: from,
        },
        { db },
      ),
    ).rejects.toBeInstanceOf(OfferPromotionNotReplaceableError);
    minute += 300;
  });

  it("16. the exact effectiveUntil boundary: running before, reverted at — with no write", async () => {
    const o = await activeOffer();
    const now = next();
    const from = plusMs(now, HOUR);
    const until = plusMs(now, 2 * HOUR);
    await schedulePromotionAs(as(o.seller), await confirmedPromotion(o, { from, until }, "40.00", now), { db });
    const acts = await db.offerAct.count({ where: { internalOfferId: o.internalOfferId } });
    const state = await stateOf(o.internalOfferId);
    expect(promotionStatusAt(state, plusMs(until, -1))).toBe("RUNNING");
    expect(promotionStatusAt(state, until)).toBe("ENDED");
    expect(effectiveOfferTerms(state.resolution, until)).toEqual({ kind: "STANDING", sourceRecordVersion: "1" });
    await expect(
      endPromotionAs(as(o.seller), { ...o.sel, expectedPromotionVersion: "2", now: until }, { db }),
    ).rejects.toBeInstanceOf(OfferPromotionNotRunningError);
    /* No longer pending at `until`: the standing terms may be revised again. */
    const revision = await confirmedRevision(o, REPRICED, until);
    expect((await reviseOfferTermsAs(as(o.seller), revision, { db })).standingVersion).toBe("3");
    expect(await db.offerAct.count({ where: { internalOfferId: o.internalOfferId } })).toBe(acts);
    await expectInvariants(o.product.internalProductId, until);
    minute += 180;
  });

  it("17. withdraw while a promotion runs, racing its early end: WITHDRAWN, nothing in force, history kept", async () => {
    const o = await activeOffer();
    const now = next();
    await schedulePromotionAs(
      as(o.seller),
      await confirmedPromotion(o, { from: plusMs(now, HOUR), until: plusMs(now, 3 * HOUR) }, "40.00", now),
      { db },
    );
    const at = plusMs(now, 2 * HOUR);
    const [withdrawn, ended] = await Promise.allSettled([
      withdrawOfferAs(as(o.seller), { ...o.sel, now: at }, { db }),
      endPromotionAs(as(o.seller), { ...o.sel, expectedPromotionVersion: "2", now: at }, { db }),
    ]);
    expect(withdrawn.status).toBe("fulfilled");
    if (ended.status === "rejected") {
      expect(ended.reason).toBeInstanceOf(OfferNotAuthorizedError);
      expect((ended.reason as OfferNotAuthorizedError).reasonCodes).toEqual(["OFFER_LIFECYCLE_TERMINAL"]);
    }
    const state = await stateOf(o.internalOfferId);
    expect(lifecycleAt(state, at)).toBe("WITHDRAWN");
    expect(effectiveOfferTerms(state.resolution, at)).toEqual({ kind: "NONE", lifecycle: "WITHDRAWN" });
    expect(await db.offerSourceRecordVersionRow.count({ where: { internalOfferId: o.internalOfferId } })).toBe(2);
    await expectInvariants(o.product.internalProductId, at);
    minute += 240;
  });
});
