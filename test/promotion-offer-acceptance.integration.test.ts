/**
 * Phase 1.44 — Promoter Offer-package acceptance, against a real database.
 *
 *   - ACCEPT: {S} and {S, P} through the real route — 201 first, 200 on replay
 *     with the same `acceptedAt`; concurrent identical requests leave one row.
 *   - EXACTNESS: a stale standing version, a changed / replaced / ended
 *     promotion, a part-package, and restated economics or window that differ
 *     are each a deterministic 409, writing nothing.
 *   - AUTHORITY: only the cycle's own Promoter, only while current and
 *     APPROVED; a new cycle inherits nothing.
 *   - STATE: Offer DRAFT / PAUSED / WITHDRAWN / ENDED and Product not ACTIVE
 *     refuse; resale PAUSED admits assent; WITHDRAWN / NOT_OFFERED do not.
 *   - COVERAGE: before a promotion, during it, after it expires, after it is
 *     ended early, after a replacement, after a new standing version.
 *   - VIEWS: the Promoter's package, the Seller's per-Promoter status, the
 *     eligibility helper — and no private identity anywhere.
 *   - DATABASE: a promotion not built on the accepted standing version, and a
 *     key that disagrees with the promotion, are refused by the schema itself.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import {
  handleActivateOfferRequest,
  handleCreateOfferRequest,
  handleEndPromotionRequest,
  handlePauseOfferRequest,
  handleReplacePromotionRequest,
  handleReviseOfferRequest,
  handleSchedulePromotionRequest,
  handleWithdrawOfferRequest,
  type OfferRouteResult,
} from "../src/server/marketplace/offer-route-handler";
import { handleSetProductResaleAvailabilityRequest } from "../src/server/product/product-resale-availability-route-handler";
import {
  OFFER_ACCEPTANCE_ROUTE_ERROR_CODES as ACCEPT_CODES,
  PROMOTION_AUTHORIZATION_ROUTE_ERROR_CODES as CODES,
  handleAcceptOfferPackageRequest,
  handleDecidePromotionAuthorizationRequest,
  handleRequestPromotionAuthorizationRequest,
  type PromotionAuthorizationRouteResult,
} from "../src/server/marketplace/promotion-authorization-route-handler";
import { suspendProduct } from "../src/server/marketplace/product-suspension-service";
import { readAccountHome } from "../src/server/account/account-home";
import {
  readPromotedTermsEligibilityIn,
  readPromoterOfferPackageByRefIn,
  readSellerOfferAcceptancesIn,
  type PromoterOfferPackageView,
} from "../src/server/marketplace/promotion-offer-acceptance-read-service";
import { findParticipantPrivacyViolations } from "../src/contracts/marketplace/participant-record";
import { ACCEPTANCE_COVERED_BY_PACKAGE, offerPackageAccepted, offerPackageStatus } from "../app/promote/promote-copy";
import { promotionTermsAcceptanceStatus } from "../app/account/account-home-copy";
import { sellerCommerceFixture, type FixtureActor } from "./support/seller-commerce-fixture";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2029-10-01T09:00:00.000Z";
const ORIGIN = "https://monacado.test";
const PREFIX = "p144acc";

const fx = sellerCommerceFixture({ db, emailPrefix: PREFIX, now: NOW, origin: ORIGIN });

let clock = Date.parse("2029-10-02T09:00:00.000Z");
/** A strictly increasing instant, ten minutes apart — every act, and every read, is later than the last. */
const next = (): string => new Date((clock += 10 * 60_000)).toISOString();
/** Moves the clock to at least `iso`, so the next instant is after it. */
const advancePast = (iso: string): void => {
  clock = Math.max(clock, Date.parse(iso));
};
const plus = (from: string, minutes: number): string => new Date(Date.parse(from) + minutes * 60_000).toISOString();

const pct = (percent: string) => ({ method: "PERCENT_OF_WHOLESALE", percent });
const terms = (wholesalePrice: string, percent = "10") => ({ wholesalePrice, currency: "USD", commission: pct(percent) });

/** A well-formed confirmation naming no real version: the route answers 409 with the true disclosure. */
const STALE_CONFIRMATION = {
  version: "9",
  calculatedCommissionMinorUnits: 0,
  calculatedSellerGrossProceedsMinorUnits: 0,
  commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
};

interface Listed {
  seller: FixtureActor;
  productRef: string;
  internalProductId: string;
  offerRef: string;
}

function offerCall(
  handler: typeof handleCreateOfferRequest,
  seller: FixtureActor,
  refs: { productRef: string; offerRef?: string },
  body: Record<string, unknown>,
): Promise<OfferRouteResult> {
  const now = next();
  return handler(
    { ...refs, contentType: "application/json", originHeader: ORIGIN, cookieHeader: seller.cookieHeader, rawBody: JSON.stringify(body) },
    { db, now: () => now, appOrigin: ORIGIN },
  );
}

/** An Offer act that asks for confirmation of a disclosure: ask, then confirm exactly what was disclosed. */
async function confirmed(handler: typeof handleCreateOfferRequest, item: Listed, body: Record<string, unknown>): Promise<OfferRouteResult> {
  const refs = { productRef: item.productRef, offerRef: item.offerRef };
  const asked = await offerCall(handler, item.seller, refs, { ...body, confirmation: STALE_CONFIRMATION });
  expect(asked.status, JSON.stringify(asked.body)).toBe(409);
  const done = await offerCall(handler, item.seller, refs, { ...body, confirmation: asked.body.disclosure });
  expect(done.status, JSON.stringify(done.body)).toBeLessThan(300);
  return done;
}

async function setResale(item: Listed, resaleAvailability: string): Promise<void> {
  const set = await handleSetProductResaleAvailabilityRequest(
    {
      productRef: item.productRef,
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader: item.seller.cookieHeader,
      rawBody: JSON.stringify({ resaleAvailability }),
    },
    { db, now: next, appOrigin: ORIGIN },
  );
  expect(set.status, JSON.stringify(set.body)).toBe(200);
}

/** An ACTIVE Product, resale AVAILABLE (unless `resale: false`), with an Offer activated through the real routes. */
async function listed(opts: { activate?: boolean; resale?: boolean; effectiveUntil?: string } = {}): Promise<Listed> {
  const seller = await fx.readySeller();
  const product = await fx.activeProduct(seller);
  const partial = { seller, ...product, offerRef: "" };
  if (opts.resale !== false) await setResale(partial, "AVAILABLE");
  const created = await offerCall(handleCreateOfferRequest, seller, { productRef: product.productRef }, { terms: terms("40.00") });
  expect(created.status).toBe(201);
  const item = { ...partial, offerRef: created.body.offerRef as string };
  if (opts.activate !== false) {
    await confirmed(handleActivateOfferRequest, item, opts.effectiveUntil === undefined ? {} : { effectiveUntil: opts.effectiveUntil });
  }
  return item;
}

async function currentStandingVersion(item: Listed): Promise<string> {
  const offer = await db.offer.findUniqueOrThrow({ where: { offerRef: item.offerRef } });
  const row = await db.offerSourceRecordVersionRow.findFirstOrThrow({
    where: { offerSourceRecordId: offer.offerSourceRecordId, termsKind: "STANDING" },
    orderBy: { seq: "desc" },
  });
  return row.sourceRecordVersion;
}

/** Schedules a promotion on the current standing version; answers its window. */
async function schedule(item: Listed, wholesalePrice: string, fromMinutes: number, lengthMinutes: number) {
  const at = new Date(clock).toISOString();
  const window = { effectiveFrom: plus(at, fromMinutes), effectiveUntil: plus(at, fromMinutes + lengthMinutes) };
  await confirmed(handleSchedulePromotionRequest, item, { expectedVersion: await currentStandingVersion(item), wholesalePrice, ...window });
  return window;
}

function cycleCall(
  handler: typeof handleAcceptOfferPackageRequest,
  actor: FixtureActor,
  item: Listed,
  authorizationRef: string,
  body: unknown,
  now = next(),
): Promise<PromotionAuthorizationRouteResult> {
  return handler(
    {
      productRef: item.productRef,
      authorizationRef,
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader: actor.cookieHeader,
      rawBody: JSON.stringify(body),
    },
    { db, now: () => now, appOrigin: ORIGIN },
  );
}

async function request(promoter: FixtureActor, item: Listed): Promise<string> {
  const r = await handleRequestPromotionAuthorizationRequest(
    { productRef: item.productRef, contentType: "application/json", originHeader: ORIGIN, cookieHeader: promoter.cookieHeader, rawBody: "{}" },
    { db, now: next, appOrigin: ORIGIN },
  );
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.authorizationRef as string;
}

async function decide(item: Listed, authorizationRef: string, decision: "APPROVE" | "DENY" | "REVOKE"): Promise<void> {
  const r = await cycleCall(handleDecidePromotionAuthorizationRequest, item.seller, item, authorizationRef, { decision });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}

async function approved(promoter: FixtureActor, item: Listed): Promise<string> {
  const ref = await request(promoter, item);
  await decide(item, ref, "APPROVE");
  return ref;
}

async function view(promoter: FixtureActor, authorizationRef: string, at = next()): Promise<PromoterOfferPackageView | null> {
  return await db.$transaction((tx) =>
    readPromoterOfferPackageByRefIn(tx, { authorizationRef, promoterParticipantId: promoter.participantId }, at),
  );
}

/** The request body for a view: exactly what the Promoter was shown, minus the display flag. */
function bodyOf(v: PromoterOfferPackageView) {
  const promotion = v.promotion === null ? null : (({ inForce: _display, ...rest }) => rest)(v.promotion);
  return { offerRef: v.offerRef, standing: v.standing, promotion };
}

async function accept(promoter: FixtureActor, item: Listed, authorizationRef: string, at = next()) {
  const v = await view(promoter, authorizationRef, at);
  expect(v).not.toBeNull();
  return await cycleCall(handleAcceptOfferPackageRequest, promoter, item, authorizationRef, bodyOf(v!), at);
}

const acceptanceCount = () => db.promotionOfferAcceptance.count();

async function eligibility(promoter: FixtureActor, item: Listed, at = next()) {
  return await db.$transaction((tx) =>
    readPromotedTermsEligibilityIn(tx, { internalProductId: item.internalProductId, promoterParticipantId: promoter.participantId, at }),
  );
}

async function sellerView(item: Listed, authorizationRef: string, at = next()) {
  return (
    await db.$transaction((tx) => readSellerOfferAcceptancesIn(tx, item.internalProductId, [authorizationRef], at))
  ).get(authorizationRef);
}

/** Every private string a value could leak about these participants. */
async function expectNoPrivateIdentity(value: unknown, actors: FixtureActor[]) {
  const json = JSON.stringify(value);
  expect(json).not.toMatch(/mon:[a-z]+:/);
  expect(json).not.toContain(PREFIX);
  expect(json).not.toMatch(/acceptedByAccountId|accountId|participantId|firstName|lastName|email/);
  for (const a of actors) {
    const account = await db.account.findUniqueOrThrow({ where: { id: a.accountId } });
    for (const secret of [a.accountId, a.participantId, account.email, account.name, account.firstName, account.lastName]) {
      if (secret !== null && secret.trim() !== "") expect(json).not.toContain(secret);
    }
  }
  expect(findParticipantPrivacyViolations(value)).toEqual([]);
}

const describeDb = RUN ? describe : describe.skip;

describeDb("Phase 1.44 — Promoter Offer-package acceptance", () => {
  let promoter: FixtureActor;
  beforeEach(async () => {
    await fx.cleanup();
    promoter = await fx.draftParticipant(["PROMOTER"]);
  });
  afterAll(async () => {
    await fx.cleanup();
    await disconnectPrisma();
  });

  describe("accept", () => {
    it("{S}: 201 with references only, then 200 on replay with the same acceptedAt — one row", async () => {
      const item = await listed();
      const ref = await approved(promoter, item);
      const before = await view(promoter, ref);
      expect(before).toMatchObject({ acceptedAt: null, hadEarlierAcceptance: false, inForceCovered: false, promotion: null });

      const first = await accept(promoter, item, ref);
      expect(first.status).toBe(201);
      expect(Object.keys(first.body).sort()).toEqual(
        ["acceptedAt", "authorizationRef", "offerRef", "productRef", "promotionVersion", "standingVersion"].sort(),
      );
      expect(first.body).toMatchObject({ productRef: item.productRef, authorizationRef: ref, offerRef: item.offerRef, promotionVersion: null });
      await expectNoPrivateIdentity(first.body, [promoter, item.seller]);

      const replay = await accept(promoter, item, ref);
      expect(replay.status).toBe(200);
      expect(replay.body.acceptedAt).toBe(first.body.acceptedAt);
      expect(await acceptanceCount()).toBe(1);

      const row = await db.promotionOfferAcceptance.findFirstOrThrow();
      expect(row).toMatchObject({ promotionVersion: null, promotionVersionKey: "", acceptedByAccountId: promoter.accountId });
      expect(await view(promoter, ref)).toMatchObject({ acceptedAt: first.body.acceptedAt, inForceCovered: true });
      expect(await sellerView(item, ref)).toEqual({
        packageAccepted: true,
        currentPackage: { standingVersion: first.body.standingVersion, promotionVersion: null },
        acceptance: { standingVersion: first.body.standingVersion, promotionVersion: null, acceptedAt: first.body.acceptedAt },
      });
      expect(await eligibility(promoter, item)).toMatchObject({ eligible: true, governing: { termsKind: "STANDING" } });
    });

    it("concurrent identical acceptances leave exactly one row; both succeed", async () => {
      const item = await listed();
      const ref = await approved(promoter, item);
      const v = (await view(promoter, ref))!;
      const at = next();
      const results = await Promise.all(
        [0, 1, 2].map(() => cycleCall(handleAcceptOfferPackageRequest, promoter, item, ref, bodyOf(v), at)),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.every((s) => s === 200 || s === 201 || s === 409)).toBe(true);
      expect(await acceptanceCount()).toBe(1);
    });

    it("{S, P} while P is SCHEDULED: one act accepts both; it covers P when it starts and S when it expires", async () => {
      const item = await listed();
      const ref = await approved(promoter, item);
      const window = await schedule(item, "30.00", 600, 60);
      const v = (await view(promoter, ref))!;
      expect(v.promotion).toMatchObject({ wholesalePriceMinorUnits: 3000, ...window, inForce: false });

      // All or nothing: S alone while P is pending is refused, and writes nothing.
      const partOnly = await cycleCall(handleAcceptOfferPackageRequest, promoter, item, ref, { ...bodyOf(v), promotion: null });
      expect(partOnly).toMatchObject({ status: 409, body: { error: ACCEPT_CODES.PROMOTION_CHANGED } });
      expect(await acceptanceCount()).toBe(0);

      const done = await accept(promoter, item, ref);
      expect(done.status).toBe(201);
      expect(done.body).toMatchObject({ standingVersion: v.standing.version, promotionVersion: v.promotion!.version });

      // Before the window S is in force and covered by {S, P}.
      expect(await eligibility(promoter, item)).toMatchObject({ eligible: true, governing: { promotionVersion: null } });
      // During it P is in force and covered — no new act.
      const during = plus(window.effectiveFrom, 30);
      expect(await eligibility(promoter, item, during)).toMatchObject({
        eligible: true,
        governing: { standingVersion: v.standing.version, promotionVersion: v.promotion!.version, termsKind: "SCHEDULED_PROMOTION" },
      });
      expect(await view(promoter, ref, during)).toMatchObject({ acceptedAt: done.body.acceptedAt, inForceCovered: true, promotion: { inForce: true } });
      // After it expires S is in force again and still covered — nothing written.
      const after = plus(window.effectiveUntil, 30);
      expect(await eligibility(promoter, item, after)).toMatchObject({ eligible: true, governing: { promotionVersion: null } });
      const resumed = (await view(promoter, ref, after))!;
      expect(resumed).toMatchObject({ promotion: null, acceptedAt: null, inForceCovered: true });
      // ...and both sides read it as accepted: {S, P} included S. Nothing to accept again.
      expect(offerPackageAccepted(resumed)).toBe(true);
      expect(offerPackageStatus(resumed)).toBe(ACCEPTANCE_COVERED_BY_PACKAGE);
      expect(await sellerView(item, ref, after)).toEqual({
        packageAccepted: true,
        currentPackage: { standingVersion: v.standing.version, promotionVersion: null },
        acceptance: { standingVersion: v.standing.version, promotionVersion: v.promotion!.version, acceptedAt: done.body.acceptedAt },
      });
      expect(await acceptanceCount()).toBe(1);
    });

    it("{S, P} accepted while P runs, then ended early: resumed S reads as accepted on both sides — no new row", async () => {
      const item = await listed();
      const ref = await approved(promoter, item);
      const window = await schedule(item, "30.00", 600, 120);
      advancePast(plus(window.effectiveFrom, 1));
      const done = await accept(promoter, item, ref);
      expect(done.status).toBe(201);
      const promotionVersion = done.body.promotionVersion as string;
      expect(promotionVersion).not.toBeNull();

      const ended = await offerCall(handleEndPromotionRequest, item.seller, item, { expectedPromotionVersion: promotionVersion });
      expect(ended.status, JSON.stringify(ended.body)).toBe(200);
      const later = next();
      expect(await eligibility(promoter, item, later)).toMatchObject({ eligible: true, governing: { promotionVersion: null } });
      const resumed = (await view(promoter, ref, later))!;
      expect(resumed).toMatchObject({ standing: { version: done.body.standingVersion }, promotion: null, acceptedAt: null, inForceCovered: true });
      expect(offerPackageAccepted(resumed)).toBe(true);
      expect(offerPackageStatus(resumed)).toBe(ACCEPTANCE_COVERED_BY_PACKAGE);

      // The Seller's /account row: accepted, as part of the {S, P} acceptance.
      const sellerRow = (await readAccountHome(item.seller.accountId, { db, now: next() }))!.products
        .find((p) => p.productRef === item.productRef)!
        .promotionAuthorizations.find((a) => a.authorizationRef === ref)!;
      expect(sellerRow.termsAcceptance).toMatchObject({ packageAccepted: true, acceptance: { promotionVersion, acceptedAt: done.body.acceptedAt } });
      expect(promotionTermsAcceptanceStatus(sellerRow.termsAcceptance!)).toMatch(
        new RegExp(`^accepted your current terms \\(standard terms version ${done.body.standingVersion}\\) on .*, as part of standard terms version ${done.body.standingVersion} \\+ promotional terms version ${promotionVersion}$`),
      );
      await expectNoPrivateIdentity(sellerRow.termsAcceptance, [promoter, item.seller]);
      expect(await acceptanceCount()).toBe(1);
    });

    it("{S} accepted before a promotion is scheduled covers S, but NOT a running P — no fallback; ended early, S is covered again", async () => {
      const item = await listed();
      const ref = await approved(promoter, item);
      expect((await accept(promoter, item, ref)).status).toBe(201);
      const window = await schedule(item, "30.00", 600, 120);

      const v = (await view(promoter, ref))!;
      expect(v).toMatchObject({ acceptedAt: null, hadEarlierAcceptance: true, inForceCovered: true });
      expect(await sellerView(item, ref)).toMatchObject({ packageAccepted: false, acceptance: { promotionVersion: null } });

      advancePast(plus(window.effectiveFrom, 1));
      const running = next();
      expect(await view(promoter, ref, running)).toMatchObject({ inForceCovered: false, promotion: { inForce: true } });
      expect(await eligibility(promoter, item, running)).toMatchObject({ eligible: false, blockers: ["TERMS_NOT_ACCEPTED"] });

      // The Seller ends it early: S is in force and covered by the earlier {S} — nothing written.
      const promotionVersion = v.promotion!.version;
      const ended = await offerCall(handleEndPromotionRequest, item.seller, item, { expectedPromotionVersion: promotionVersion });
      expect(ended.status, JSON.stringify(ended.body)).toBe(200);
      const later = next();
      expect(await eligibility(promoter, item, later)).toMatchObject({ eligible: true, governing: { promotionVersion: null } });
      expect(await view(promoter, ref, later)).toMatchObject({ promotion: null, acceptedAt: expect.any(String), inForceCovered: true });
      expect(await sellerView(item, ref, later)).toMatchObject({ packageAccepted: true, acceptance: { promotionVersion: null } });
      expect(await acceptanceCount()).toBe(1);
    });

    it("a running promotion accepted mid-window: {S, P} is accepted and P is covered", async () => {
      const item = await listed();
      const ref = await approved(promoter, item);
      const window = await schedule(item, "30.00", 600, 120);
      advancePast(plus(window.effectiveFrom, 1));
      const done = await accept(promoter, item, ref);
      expect(done.status).toBe(201);
      expect(done.body.promotionVersion).not.toBeNull();
      expect(await eligibility(promoter, item)).toMatchObject({ eligible: true, governing: { termsKind: "SCHEDULED_PROMOTION" } });
    });
  });

  describe("exactness — a Seller change between view and click binds nothing", () => {
    it("a new standing version S2 refuses the stale S1 package, and needs its own acceptance", async () => {
      const item = await listed();
      const ref = await approved(promoter, item);
      const stale = (await view(promoter, ref))!;
      expect((await accept(promoter, item, ref)).status).toBe(201);

      await confirmed(handleReviseOfferRequest, item, { expectedVersion: stale.standing.version, terms: terms("45.00") });
      const refused = await cycleCall(handleAcceptOfferPackageRequest, promoter, item, ref, bodyOf(stale));
      expect(refused).toMatchObject({ status: 409, body: { error: ACCEPT_CODES.STANDING_VERSION_STALE } });

      const fresh = (await view(promoter, ref))!;
      expect(fresh.standing.version).not.toBe(stale.standing.version);
      expect(fresh).toMatchObject({ acceptedAt: null, hadEarlierAcceptance: true, inForceCovered: false });
      expect(offerPackageAccepted(fresh)).toBe(false);
      expect(await eligibility(promoter, item)).toMatchObject({ eligible: false, blockers: ["TERMS_NOT_ACCEPTED"] });
      expect(await sellerView(item, ref)).toMatchObject({ packageAccepted: false, acceptance: { standingVersion: stale.standing.version } });
      expect((await accept(promoter, item, ref)).status).toBe(201);
      expect(await acceptanceCount()).toBe(2);
    });

    it("a replaced promotion P2 refuses the {S, P1} package, and {S, P1} does not cover P2", async () => {
      const item = await listed();
      const ref = await approved(promoter, item);
      const window = await schedule(item, "30.00", 600, 60);
      const first = (await view(promoter, ref))!;
      expect((await accept(promoter, item, ref)).status).toBe(201);

      await confirmed(handleReplacePromotionRequest, item, {
        expectedVersion: first.standing.version,
        expectedPromotionVersion: first.promotion!.version,
        wholesalePrice: "32.00",
        ...window,
      });
      const refused = await cycleCall(handleAcceptOfferPackageRequest, promoter, item, ref, bodyOf(first));
      expect(refused).toMatchObject({ status: 409, body: { error: ACCEPT_CODES.PROMOTION_CHANGED } });
      const replaced = (await view(promoter, ref))!;
      expect(replaced.promotion!.version).not.toBe(first.promotion!.version);
      expect(replaced.acceptedAt).toBeNull();
      expect(await eligibility(promoter, item, plus(window.effectiveFrom, 1))).toMatchObject({
        eligible: false,
        blockers: ["TERMS_NOT_ACCEPTED"],
      });
      expect(await acceptanceCount()).toBe(1);
    });

    it("restated economics or window that differ from the immutable versions are TERMS_MISMATCH; malformed bodies are 400", async () => {
      const item = await listed();
      const ref = await approved(promoter, item);
      await schedule(item, "30.00", 600, 60);
      const v = bodyOf((await view(promoter, ref))!);
      const mismatches = [
        { ...v, standing: { ...v.standing, wholesalePriceMinorUnits: v.standing.wholesalePriceMinorUnits + 1 } },
        { ...v, standing: { ...v.standing, calculatedCommissionMinorUnits: 1 } },
        { ...v, standing: { ...v.standing, commission: { method: "FIXED_AMOUNT", fixedCommissionMinorUnits: 400 } } },
        { ...v, promotion: { ...v.promotion!, wholesalePriceMinorUnits: 2999 } },
        { ...v, promotion: { ...v.promotion!, effectiveUntil: plus(v.promotion!.effectiveUntil, 1) } },
        { ...v, promotion: { ...v.promotion!, effectiveFrom: plus(v.promotion!.effectiveFrom, -1) } },
      ];
      for (const body of mismatches) {
        const r = await cycleCall(handleAcceptOfferPackageRequest, promoter, item, ref, body);
        expect(r, JSON.stringify(body)).toMatchObject({ status: 409, body: { error: ACCEPT_CODES.TERMS_MISMATCH } });
      }
      const otherOffer = await cycleCall(handleAcceptOfferPackageRequest, promoter, item, ref, { ...v, offerRef: "ABCDEFGHJKMNPQRSTVWXYZ0123456789" });
      expect(otherOffer).toMatchObject({ status: 409, body: { error: ACCEPT_CODES.OFFER_NOT_ACCEPTING } });
      for (const body of [{}, { ...v, retailPriceMinorUnits: 9000 }, { ...v, promotion: { ...v.promotion!, inForce: false } }]) {
        const r = await cycleCall(handleAcceptOfferPackageRequest, promoter, item, ref, body);
        expect(r).toMatchObject({ status: 400, body: { error: CODES.invalidRequest } });
      }
      expect(await acceptanceCount()).toBe(0);
    });
  });

  describe("authority", () => {
    it("only the cycle's own current APPROVED Promoter; approval is not acceptance; a new cycle inherits nothing", async () => {
      const item = await listed();
      const ref = await request(promoter, item);
      // REQUESTED: no view, and the act is refused.
      expect(await view(promoter, ref)).toBeNull();
      const body = { offerRef: item.offerRef, standing: null, promotion: null };
      const standing = {
        version: await currentStandingVersion(item),
        wholesalePriceMinorUnits: 4000,
        currency: "USD",
        commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 1000 },
        calculatedCommissionMinorUnits: 400,
        commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
      };
      const echo = { ...body, standing };
      expect(await cycleCall(handleAcceptOfferPackageRequest, promoter, item, ref, echo)).toMatchObject({
        status: 409,
        body: { error: ACCEPT_CODES.AUTHORIZATION_NOT_APPROVED },
      });

      await decide(item, ref, "APPROVE");
      expect(await eligibility(promoter, item)).toMatchObject({ eligible: false, blockers: ["TERMS_NOT_ACCEPTED"] });
      // Another Promoter — even an APPROVED one — cannot act on this cycle; the Seller cannot either.
      const other = await fx.draftParticipant(["PROMOTER"]);
      await approved(other, item);
      expect(await cycleCall(handleAcceptOfferPackageRequest, other, item, ref, echo)).toMatchObject({
        status: 404,
        body: { error: CODES.notFound },
      });
      expect(await cycleCall(handleAcceptOfferPackageRequest, item.seller, item, ref, echo)).toMatchObject({ status: 404 });
      expect(await view(other, ref)).toBeNull();
      // Each Promoter's acceptance is its own.
      expect((await cycleCall(handleAcceptOfferPackageRequest, promoter, item, ref, echo)).status).toBe(201);
      expect(await eligibility(other, item)).toMatchObject({ eligible: false, blockers: ["TERMS_NOT_ACCEPTED"] });

      // Revoked: the cycle is current but not APPROVED.
      await decide(item, ref, "REVOKE");
      expect(await cycleCall(handleAcceptOfferPackageRequest, promoter, item, ref, echo)).toMatchObject({
        status: 409,
        body: { error: ACCEPT_CODES.AUTHORIZATION_NOT_APPROVED },
      });
      // The revoked cycle's acceptance is evidence, kept; it no longer governs anything.
      expect(await eligibility(promoter, item)).toMatchObject({ eligible: false, blockers: ["AUTHORIZATION_NOT_APPROVED"] });

      // A new cycle starts with nothing accepted; the old one is superseded.
      const again = await approved(promoter, item);
      expect(await view(promoter, again)).toMatchObject({ acceptedAt: null, hadEarlierAcceptance: false, inForceCovered: false });
      expect(await eligibility(promoter, item)).toMatchObject({ eligible: false, blockers: ["TERMS_NOT_ACCEPTED"] });
      expect(await cycleCall(handleAcceptOfferPackageRequest, promoter, item, ref, echo)).toMatchObject({
        status: 409,
        body: { error: CODES.superseded },
      });
      expect(await cycleCall(handleAcceptOfferPackageRequest, promoter, item, again, echo)).toMatchObject({ status: 201 });
    });

    it("signed out, cross-origin, and an unknown cycle are refused before anything is read", async () => {
      const item = await listed();
      const ref = await approved(promoter, item);
      const body = bodyOf((await view(promoter, ref))!);
      const signedOut = await handleAcceptOfferPackageRequest(
        { productRef: item.productRef, authorizationRef: ref, contentType: "application/json", originHeader: ORIGIN, cookieHeader: null, rawBody: JSON.stringify(body) },
        { db, now: next, appOrigin: ORIGIN },
      );
      expect(signedOut).toMatchObject({ status: 401, body: { error: CODES.unauthenticated } });
      const crossOrigin = await handleAcceptOfferPackageRequest(
        {
          productRef: item.productRef,
          authorizationRef: ref,
          contentType: "application/json",
          originHeader: "https://elsewhere.test",
          cookieHeader: promoter.cookieHeader,
          rawBody: JSON.stringify(body),
        },
        { db, now: next, appOrigin: ORIGIN },
      );
      expect(crossOrigin.status).toBe(403);
      expect(await cycleCall(handleAcceptOfferPackageRequest, promoter, item, "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", body)).toMatchObject({
        status: 404,
      });
      expect(await acceptanceCount()).toBe(0);
    });
  });

  describe("state", () => {
    it("an Offer PAUSED, WITHDRAWN, or ENDED admits no new acceptance — and the view offers none", async () => {
      const paused = await listed();
      const pausedRef = await approved(promoter, paused);
      const pausedBody = bodyOf((await view(promoter, pausedRef))!);
      expect((await offerCall(handlePauseOfferRequest, paused.seller, paused, {})).status).toBe(200);
      expect(await view(promoter, pausedRef)).toBeNull();
      expect(await cycleCall(handleAcceptOfferPackageRequest, promoter, paused, pausedRef, pausedBody)).toMatchObject({
        status: 409,
        body: { error: ACCEPT_CODES.OFFER_NOT_ACCEPTING },
      });

      const withdrawn = await listed();
      const withdrawnRef = await approved(promoter, withdrawn);
      const withdrawnBody = bodyOf((await view(promoter, withdrawnRef))!);
      expect((await offerCall(handleWithdrawOfferRequest, withdrawn.seller, withdrawn, {})).status).toBe(200);
      expect(await cycleCall(handleAcceptOfferPackageRequest, promoter, withdrawn, withdrawnRef, withdrawnBody)).toMatchObject({
        status: 409,
        body: { error: ACCEPT_CODES.OFFER_NOT_ACCEPTING },
      });

      const ending = await listed({ effectiveUntil: plus(new Date(clock).toISOString(), 600) });
      const endingRef = await approved(promoter, ending);
      const endingBody = bodyOf((await view(promoter, endingRef))!);
      advancePast(plus(new Date(clock).toISOString(), 700));
      expect(await cycleCall(handleAcceptOfferPackageRequest, promoter, ending, endingRef, endingBody)).toMatchObject({
        status: 409,
        body: { error: ACCEPT_CODES.OFFER_NOT_ACCEPTING },
      });
      expect(await acceptanceCount()).toBe(0);
    });

    it("an Offer still DRAFT admits none", async () => {
      const draft = await listed({ activate: false });
      const ref = await approved(promoter, draft);
      expect(await view(promoter, ref)).toBeNull();
      const echo = {
        offerRef: draft.offerRef,
        standing: {
          version: await currentStandingVersion(draft),
          wholesalePriceMinorUnits: 4000,
          currency: "USD",
          commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 1000 },
          calculatedCommissionMinorUnits: 400,
          commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
        },
        promotion: null,
      };
      expect(await cycleCall(handleAcceptOfferPackageRequest, promoter, draft, ref, echo)).toMatchObject({
        status: 409,
        body: { error: ACCEPT_CODES.OFFER_NOT_ACCEPTING },
      });
    });

    it("resale PAUSED admits assent (not commerce); WITHDRAWN and NOT_OFFERED admit none", async () => {
      const item = await listed();
      const ref = await approved(promoter, item);
      await setResale(item, "PAUSED");
      expect((await accept(promoter, item, ref)).status).toBe(201);
      expect(await eligibility(promoter, item)).toMatchObject({ eligible: false, blockers: ["RESALE_NOT_AVAILABLE"] });

      const withdrawn = await listed();
      const wRef = await approved(promoter, withdrawn);
      const body = bodyOf((await view(promoter, wRef))!);
      await setResale(withdrawn, "WITHDRAWN");
      expect(await view(promoter, wRef)).toBeNull();
      expect(await cycleCall(handleAcceptOfferPackageRequest, promoter, withdrawn, wRef, body)).toMatchObject({
        status: 409,
        body: { error: ACCEPT_CODES.RESALE_NOT_OFFERED },
      });

      const notOffered = await listed({ resale: false });
      const nRef = await approved(promoter, notOffered);
      expect(await view(promoter, nRef)).toBeNull();
      const nBody = { ...body, offerRef: notOffered.offerRef, standing: { ...body.standing, version: await currentStandingVersion(notOffered) } };
      expect(await cycleCall(handleAcceptOfferPackageRequest, promoter, notOffered, nRef, nBody)).toMatchObject({
        status: 409,
        body: { error: ACCEPT_CODES.RESALE_NOT_OFFERED },
      });
      expect(await acceptanceCount()).toBe(1);
    });

    it("a Product that is not ACTIVE (suspended) admits none", async () => {
      const item = await listed();
      const ref = await approved(promoter, item);
      const body = bodyOf((await view(promoter, ref))!);
      await suspendProduct(
        {
          internalProductId: item.internalProductId,
          reasonCode: "SAFETY_CONCERN",
          actingAccountId: await fx.seedOperator("product:suspend"),
          suspendedAt: next(),
        },
        { db },
      );
      expect(await cycleCall(handleAcceptOfferPackageRequest, promoter, item, ref, body)).toMatchObject({
        status: 409,
        body: { error: ACCEPT_CODES.PRODUCT_NOT_ACTIVE },
      });
      expect(await eligibility(promoter, item)).toMatchObject({ eligible: false });
      expect(await acceptanceCount()).toBe(0);
    });
  });

  describe("no side effects, no private identity", () => {
    it("writes only the acceptance row — no Offer version, act, authorization, notification, or Listing", async () => {
      const item = await listed();
      const ref = await approved(promoter, item);
      const counts = async () => ({
        versions: await db.offerSourceRecordVersionRow.count(),
        offerActs: await db.offerAct.count(),
        cycles: await db.promotionAuthorization.count(),
        cycleActs: await db.promotionAuthorizationAct.count(),
        notifications: await db.notificationObligation.count(),
        listings: await db.listing.count(),
      });
      const before = await counts();
      const cycleBefore = await db.promotionAuthorization.findUniqueOrThrow({ where: { authorizationRef: ref } });
      expect((await accept(promoter, item, ref)).status).toBe(201);
      expect(await counts()).toEqual(before);
      expect(await db.promotionAuthorization.findUniqueOrThrow({ where: { authorizationRef: ref } })).toEqual(cycleBefore);
    });

    it("/account: the Promoter's row carries the package to accept; the Seller's row its acceptance status — by mName, no ids", async () => {
      const item = await listed();
      const ref = await approved(promoter, item);
      const rowOf = async () =>
        (await readAccountHome(promoter.accountId, { db, now: next() }))!.promoter!.authorizations.find((a) => a.authorizationRef === ref)!;
      expect((await rowOf()).termsAcceptance).toMatchObject({ authorizationRef: ref, offerRef: item.offerRef, acceptedAt: null });
      const sellerRow = async () =>
        (await readAccountHome(item.seller.accountId, { db, now: next() }))!.products
          .find((p) => p.productRef === item.productRef)!
          .promotionAuthorizations.find((a) => a.authorizationRef === ref)!;
      expect((await sellerRow()).termsAcceptance).toEqual({
        packageAccepted: false,
        currentPackage: { standingVersion: (await view(promoter, ref))!.standing.version, promotionVersion: null },
        acceptance: null,
      });

      const done = await accept(promoter, item, ref);
      expect((await rowOf()).termsAcceptance).toMatchObject({ acceptedAt: done.body.acceptedAt, inForceCovered: true });
      const seller = await sellerRow();
      expect(seller.termsAcceptance).toMatchObject({ packageAccepted: true, acceptance: { acceptedAt: done.body.acceptedAt } });
      await expectNoPrivateIdentity(seller.termsAcceptance, [promoter, item.seller]);
    });

    it("the Promoter's view, the Seller's view, and the eligibility answer carry no private identity", async () => {
      const item = await listed();
      const ref = await approved(promoter, item);
      await schedule(item, "30.00", 600, 60);
      expect((await accept(promoter, item, ref)).status).toBe(201);
      await expectNoPrivateIdentity(await view(promoter, ref), [promoter, item.seller]);
      await expectNoPrivateIdentity(await sellerView(item, ref), [promoter, item.seller]);
      // The eligibility helper is server-only and returns internal evidence by design — but never identity.
      const decision = await eligibility(promoter, item);
      const json = JSON.stringify(decision);
      for (const secret of [promoter.accountId, promoter.participantId, item.seller.accountId, item.seller.participantId]) {
        expect(json).not.toContain(secret);
      }
    });
  });

  describe("the database itself", () => {
    it("refuses a promotion not built on the accepted standing version, and a key that disagrees with the promotion", async () => {
      const item = await listed();
      const ref = await approved(promoter, item);
      const s1 = await currentStandingVersion(item);
      const window = await schedule(item, "30.00", 600, 60);
      const p1 = (await view(promoter, ref))!.promotion!.version;
      // A standing revision waits for the promotion to end (1.42); let it start, end it early, then revise.
      advancePast(plus(window.effectiveFrom, 1));
      expect((await offerCall(handleEndPromotionRequest, item.seller, item, { expectedPromotionVersion: p1 })).status).toBe(200);
      await confirmed(handleReviseOfferRequest, item, { expectedVersion: s1, terms: terms("45.00") });
      const s2 = await currentStandingVersion(item);
      expect(s2).not.toBe(s1);

      const cycle = await db.promotionAuthorization.findUniqueOrThrow({ where: { authorizationRef: ref } });
      const offer = await db.offer.findUniqueOrThrow({ where: { offerRef: item.offerRef } });
      const row = (id: string, standingVersion: string, promotionVersion: string | null, promotionVersionKey: string) => ({
        id,
        authorizationId: cycle.id,
        offerSourceRecordId: offer.offerSourceRecordId,
        standingVersion,
        promotionVersion,
        promotionVersionKey,
        acceptedByAccountId: promoter.accountId,
        acceptedAt: new Date(next()),
      });
      // P1 was built on S1, not S2.
      await expect(db.promotionOfferAcceptance.create({ data: row("mon:pofacc:T1", s2, p1, p1) })).rejects.toThrow();
      // A promotion version named as the standing version: a STANDING row's basis never matches.
      await expect(db.promotionOfferAcceptance.create({ data: row("mon:pofacc:T2", s1, s1, s1) })).rejects.toThrow();
      // The key must equal the promotion, or '' for none.
      await expect(db.promotionOfferAcceptance.create({ data: row("mon:pofacc:T3", s1, p1, "") })).rejects.toThrow();
      await expect(db.promotionOfferAcceptance.create({ data: row("mon:pofacc:T4", s1, null, p1) })).rejects.toThrow();
      // The two well-formed packages are admitted, and each only once.
      await db.promotionOfferAcceptance.create({ data: row("mon:pofacc:T5", s1, p1, p1) });
      await db.promotionOfferAcceptance.create({ data: row("mon:pofacc:T6", s1, null, "") });
      await expect(db.promotionOfferAcceptance.create({ data: row("mon:pofacc:T7", s1, null, "") })).rejects.toThrow();
      expect(await acceptanceCount()).toBe(2);
    });
  });
});
