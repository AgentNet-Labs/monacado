/**
 * Phase 1.43 — the Promotable Catalog, against a real database.
 *
 *   - INCLUSION: a live Offer on an ACTIVE, AVAILABLE Product from a Seller in
 *     good standing with an mName appears; each gate, broken alone, removes it;
 *     the viewer's own Products never appear.
 *   - CARD: exactly the approved fields; the Seller is its mName; commission as
 *     the Offer states it; no internal id, declared name, `Account.name`, or
 *     email anywhere.
 *   - SEARCH / FILTER / SORT / PAGINATION: name, description, and mName search;
 *     delivery, wholesale, commission, and Seller filters; every sort with its
 *     productRef tie-break; 24 per page with an opaque cursor that covers every
 *     entry exactly once.
 *   - PROMOTIONS: a running promotion's terms are in force; an upcoming one is
 *     shown on the detail page only.
 *   - REQUEST: through the unchanged Phase 1.41 route; the card follows the
 *     relationship.
 *   - ROUTE: the load-more endpoint's refusals and its JSON.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import {
  handleActivateOfferRequest,
  handleCreateOfferRequest,
  handlePauseOfferRequest,
  handleSchedulePromotionRequest,
  handleWithdrawOfferRequest,
  type OfferRouteResult,
} from "../src/server/marketplace/offer-route-handler";
import { handleSetProductResaleAvailabilityRequest } from "../src/server/product/product-resale-availability-route-handler";
import {
  handleCancelPromotionAuthorizationRequest,
  handleDecidePromotionAuthorizationRequest,
  handleRequestPromotionAuthorizationRequest,
} from "../src/server/marketplace/promotion-authorization-route-handler";
import { suspendProduct } from "../src/server/marketplace/product-suspension-service";
import {
  readPromotableCatalogDetail,
  readPromotableCatalogPage,
  resolvePromotableCatalogAccess,
  type PromotableCatalogCard,
} from "../src/server/marketplace/promotable-catalog-read-service";
import { handlePromotableCatalogRequest } from "../src/server/marketplace/promotable-catalog-route-handler";
import {
  parsePromotableCatalogQuery,
  type PromotableCatalogQuery,
} from "../src/contracts/marketplace/promotable-catalog";
import { findParticipantPrivacyViolations } from "../src/contracts/marketplace/participant-record";
import { RESTRICTION_REASON_CODES } from "../src/contracts/marketplace/participant-restriction";
import { sellerCommerceFixture, type FixtureActor } from "./support/seller-commerce-fixture";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2029-08-01T09:00:00.000Z";
const BASE = Date.parse("2029-08-02T09:00:00.000Z");
const ORIGIN = "https://monacado.test";
const PREFIX = "p143cat";

const fx = sellerCommerceFixture({ db, emailPrefix: PREFIX, now: NOW, origin: ORIGIN });

let minute = 0;
/** A strictly increasing instant, ten minutes apart — every act, and every read, is later than the last. */
const next = (): string => new Date(BASE + (minute += 10) * 60_000).toISOString();
const plus = (from: string, minutes: number): string => new Date(Date.parse(from) + minutes * 60_000).toISOString();

type Commission = { method: "PERCENT_OF_WHOLESALE"; percent: string } | { method: "FIXED_AMOUNT"; amount: string };
const terms = (wholesalePrice: string, commission: Commission) => ({ wholesalePrice, currency: "USD", commission });
const pct = (percent: string): Commission => ({ method: "PERCENT_OF_WHOLESALE", percent });
const fixed = (amount: string): Commission => ({ method: "FIXED_AMOUNT", amount });

function offerCall(
  handler: typeof handleCreateOfferRequest,
  seller: FixtureActor,
  refs: { productRef: string; offerRef?: string },
  body: Record<string, unknown>,
  now = next(),
): Promise<OfferRouteResult> {
  return handler(
    {
      ...refs,
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader: seller.cookieHeader,
      rawBody: JSON.stringify(body),
    },
    { db, now: () => now, appOrigin: ORIGIN },
  );
}

interface Listed {
  seller: FixtureActor;
  productRef: string;
  internalProductId: string;
  offerRef: string;
}

/**
 * A Product in the catalog: ACTIVE, resale AVAILABLE, with an Offer created and
 * activated through the real routes. `activate: false` leaves the Offer DRAFT;
 * `resale: false` leaves the Product NOT_OFFERED.
 */
async function listed(
  seller: FixtureActor,
  content: { name?: string; description?: string; deliveryMode?: "PHYSICAL" | "DIGITAL" } = {},
  offerTerms = terms("40.00", pct("10")),
  opts: { activate?: boolean; resale?: boolean; effectiveUntil?: string } = {},
): Promise<Listed> {
  const product = await fx.activeProduct(seller, content);
  if (opts.resale !== false) {
    const set = await handleSetProductResaleAvailabilityRequest(
      {
        productRef: product.productRef,
        contentType: "application/json",
        originHeader: ORIGIN,
        cookieHeader: seller.cookieHeader,
        rawBody: JSON.stringify({ resaleAvailability: "AVAILABLE" }),
      },
      { db, now: next, appOrigin: ORIGIN },
    );
    expect(set.status).toBe(200);
  }
  const created = await offerCall(handleCreateOfferRequest, seller, { productRef: product.productRef }, { terms: offerTerms });
  expect(created.status).toBe(201);
  const refs = { productRef: product.productRef, offerRef: created.body.offerRef as string };
  if (opts.activate !== false) {
    const until = opts.effectiveUntil === undefined ? {} : { effectiveUntil: opts.effectiveUntil };
    const asked = await offerCall(handleActivateOfferRequest, seller, refs, { confirmation: STALE_CONFIRMATION, ...until });
    expect(asked.status).toBe(409);
    const done = await offerCall(handleActivateOfferRequest, seller, refs, { confirmation: asked.body.disclosure, ...until });
    expect(done.status).toBe(200);
  }
  return { seller, ...product, offerRef: refs.offerRef };
}

/** A well-formed confirmation naming no real version: the route answers 409 with the true disclosure. */
const STALE_CONFIRMATION = {
  version: "9",
  calculatedCommissionMinorUnits: 0,
  calculatedSellerGrossProceedsMinorUnits: 0,
  commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
};

const query = (q: Record<string, string> = {}): PromotableCatalogQuery => parsePromotableCatalogQuery((n) => q[n]).query;

async function viewerOf(actor: FixtureActor) {
  const access = await resolvePromotableCatalogAccess(db, actor.accountId);
  if (access.outcome !== "ALLOWED") throw new Error("viewer may not browse");
  return access;
}

async function page(viewer: FixtureActor, q: Record<string, string> = {}, at = next()) {
  return await readPromotableCatalogPage(db, await viewerOf(viewer), query(q), at);
}
const refsOf = (cards: PromotableCatalogCard[]) => cards.map((c) => c.productRef);
const mNameOf = async (actor: FixtureActor) =>
  (await db.marketplaceParticipant.findUniqueOrThrow({ where: { id: actor.participantId } })).marketplaceName!;

/** Every private string a page could leak about these participants. */
async function expectNoPrivateIdentity(value: unknown, actors: FixtureActor[]) {
  const json = JSON.stringify(value);
  expect(json).not.toMatch(/mon:[a-z]+:/);
  expect(json).not.toContain(PREFIX);
  expect(json).not.toContain("Participant ");
  expect(json).not.toMatch(/\bSam\b/);
  expect(json).not.toMatch(/"Seller"/);
  for (const a of actors) {
    const account = await db.account.findUniqueOrThrow({ where: { id: a.accountId } });
    for (const secret of [a.accountId, a.participantId, account.email, account.name, account.firstName, account.lastName]) {
      if (secret !== null && secret.trim() !== "") expect(json).not.toContain(secret);
    }
  }
  expect(findParticipantPrivacyViolations(value)).toEqual([]);
}

const describeDb = RUN ? describe : describe.skip;

describeDb("Phase 1.43 — Promotable Catalog", () => {
  let promoter: FixtureActor;
  beforeEach(async () => {
    await fx.cleanup();
    promoter = await fx.draftParticipant(["PROMOTER"]);
  });
  afterAll(async () => {
    await fx.cleanup();
    await disconnectPrisma();
  });

  it("a live Offer appears as exactly the approved card — Seller by mName, actual commission, no private identity", async () => {
    const seller = await fx.readySeller();
    const item = await listed(seller, { name: "Hand-thrown Stoneware Mug", description: "14 oz artisan ceramic mug\nKiln-fired." });
    const { cards, nextCursor } = await page(promoter);
    expect(nextCursor).toBeNull();
    expect(cards).toEqual([
      {
        productRef: item.productRef,
        name: "Hand-thrown Stoneware Mug",
        sellerMName: await mNameOf(seller),
        summary: "14 oz artisan ceramic mug",
        deliveryMode: "PHYSICAL",
        terms: {
          wholesalePriceMinorUnits: 4000,
          currency: "USD",
          commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 1000 },
          calculatedCommissionMinorUnits: 400,
        },
        termsInForce: "STANDING",
        promotionEndsAt: null,
        authorization: "NONE",
      },
    ]);
    await expectNoPrivateIdentity(cards, [seller, promoter]);
  });

  it("a fixed-commission Offer keeps its fixed amount; no percentage is synthesized", async () => {
    const seller = await fx.readySeller();
    await listed(seller, {}, terms("40.00", fixed("5.00")));
    const [card] = (await page(promoter)).cards;
    expect(card!.terms.commission).toEqual({ method: "FIXED_AMOUNT", fixedCommissionMinorUnits: 500 });
    expect(card!.terms.calculatedCommissionMinorUnits).toBe(500);
    expect(JSON.stringify(card)).not.toContain("commissionBasisPoints");
  });

  it("each gate, broken alone, removes the Product — and the viewer's own Products never appear", async () => {
    const seller = await fx.readySeller();
    const live = await listed(seller, { name: "Live" });
    const draft = await listed(seller, { name: "Draft offer" }, undefined, { activate: false });
    const notOffered = await listed(seller, { name: "Not offered" }, undefined, { resale: false });
    const paused = await listed(seller, { name: "Paused" });
    expect((await offerCall(handlePauseOfferRequest, seller, paused, {})).status).toBe(200);
    const withdrawn = await listed(seller, { name: "Withdrawn" });
    expect((await offerCall(handleWithdrawOfferRequest, seller, withdrawn, {})).status).toBe(200);
    // Its own end falls after the read below (≈ +100 min) and before the later one (+120 more).
    const ending = await listed(seller, { name: "Ending" }, undefined, { effectiveUntil: new Date(BASE + (minute + 150) * 60_000).toISOString() });
    const suspended = await listed(seller, { name: "Suspended" });
    await suspendProduct(
      {
        internalProductId: suspended.internalProductId,
        reasonCode: "SAFETY_CONCERN",
        actingAccountId: await fx.seedOperator("product:suspend"),
        suspendedAt: next(),
      },
      { db },
    );

    const at = next();
    expect(refsOf((await page(promoter, {}, at)).cards).sort()).toEqual([live.productRef, ending.productRef].sort());
    // Derived ENDED once its own end passes — nothing was written.
    expect(refsOf((await page(promoter, {}, plus(at, 120))).cards)).toEqual([live.productRef]);
    for (const gone of [draft, notOffered, paused, withdrawn, suspended]) {
      expect(await readPromotableCatalogDetail(db, await viewerOf(promoter), gone.productRef, at)).toBeNull();
    }

    // The viewer's own Products: a Seller who also promotes sees others, never its own.
    const both = await fx.readySeller();
    await db.marketplaceRoleAssignment.create({
      data: { id: `mon:mrole:P143BOTH${minute}`.padEnd(36, "0"), participantId: both.participantId, role: "PROMOTER", status: "DRAFT", grantedAt: new Date(NOW) },
    });
    const own = await listed(both, { name: "Own" });
    const seen = refsOf((await page(both)).cards);
    expect(seen).toContain(live.productRef);
    expect(seen).not.toContain(own.productRef);
    expect(await readPromotableCatalogDetail(db, await viewerOf(both), own.productRef, next())).toBeNull();
  });

  it("Seller-level gates: a disabled account, a non-ACTIVE participant, an offer:publish restriction, or no mName all remove every Product", async () => {
    const breaks: Array<[string, (s: FixtureActor) => Promise<unknown>]> = [
      ["account disabled", (s) => db.account.update({ where: { id: s.accountId }, data: { status: "DISABLED" } })],
      ["participant RESTRICTED", (s) => db.marketplaceParticipant.update({ where: { id: s.participantId }, data: { status: "RESTRICTED" } })],
      [
        "offer:publish restricted",
        async (s) =>
          db.participantRestriction.create({
            data: {
              id: `mon:prst:P143R${minute}`.padEnd(35, "0"),
              participantId: s.participantId,
              scope: "offer:publish",
              status: "ACTIVE",
              activeForScope: "offer:publish",
              reasonCode: RESTRICTION_REASON_CODES[0],
              imposedByAccountId: await fx.seedOperator("participant:restrict"),
              imposedAt: new Date(NOW),
            },
          }),
      ],
      ["no mName (pre-1.43 row)", (s) => db.marketplaceParticipant.update({ where: { id: s.participantId }, data: { marketplaceName: null } })],
    ];
    for (const [label, breakIt] of breaks) {
      const seller = await fx.readySeller();
      const item = await listed(seller, { name: label });
      expect(refsOf((await page(promoter)).cards), label).toContain(item.productRef);
      await breakIt(seller);
      expect(refsOf((await page(promoter)).cards), label).not.toContain(item.productRef);
    }
  });

  it("search matches Product name, description, and Seller mName — every word, any case or accent", async () => {
    const s1 = await fx.readySeller();
    const s2 = await fx.readySeller();
    const cafe = await listed(s1, { name: "Café Mug", description: "Stoneware, glazed." });
    const tea = await listed(s1, { name: "Teapot", description: "Porcelain, 1 litre." });
    const other = await listed(s2, { name: "Plate", description: "Stoneware dinner plate." });
    expect(refsOf((await page(promoter, { q: "cafe" })).cards)).toEqual([cafe.productRef]);
    expect(refsOf((await page(promoter, { q: "PORCELAIN" })).cards)).toEqual([tea.productRef]);
    expect(refsOf((await page(promoter, { q: "stoneware", sort: "NAME" })).cards)).toEqual([cafe.productRef, other.productRef]);
    expect(refsOf((await page(promoter, { q: "stoneware glazed" })).cards)).toEqual([cafe.productRef]);
    expect(refsOf((await page(promoter, { q: (await mNameOf(s2)).toUpperCase() })).cards)).toEqual([other.productRef]);
    expect((await page(promoter, { q: "Sam" })).cards).toEqual([]); // a declared name finds nothing
  });

  it("filters: delivery mode, wholesale range, commission range, and one Seller by mName", async () => {
    const s1 = await fx.readySeller();
    const s2 = await fx.readySeller();
    const cheap = await listed(s1, { name: "Cheap" }, terms("10.00", pct("10"))); // commission $1.00
    const dear = await listed(s1, { name: "Dear" }, terms("90.00", fixed("20.00"))); // commission $20.00
    const digital = await listed(s2, { name: "Pattern", deliveryMode: "DIGITAL" }, terms("25.00", pct("40"))); // $10.00
    expect(refsOf((await page(promoter, { delivery: "DIGITAL" })).cards)).toEqual([digital.productRef]);
    expect(refsOf((await page(promoter, { delivery: "physical", sort: "NAME" })).cards)).toEqual([cheap.productRef, dear.productRef]);
    expect(refsOf((await page(promoter, { wholesaleMin: "20", wholesaleMax: "90.00", sort: "NAME" })).cards)).toEqual([
      dear.productRef,
      digital.productRef,
    ]);
    expect(refsOf((await page(promoter, { commissionMin: "5", commissionMax: "10" })).cards)).toEqual([digital.productRef]);
    const m1 = await mNameOf(s1);
    expect(refsOf((await page(promoter, { seller: m1.toUpperCase(), sort: "NAME" })).cards)).toEqual([cheap.productRef, dear.productRef]);
    expect((await page(promoter, { seller: "z9z9" })).cards).toEqual([]); // an mName nobody holds
    expect((await page(promoter, { seller: "Sam Seller" })).cards).toEqual([]); // not an mName: nothing, not everything
  });

  it("every sort, with productRef breaking ties; NEWEST is the Offer's activation", async () => {
    const s1 = await fx.readySeller();
    const s2 = await fx.readySeller();
    const a = await listed(s1, { name: "Bowl" }, terms("30.00", pct("10"))); // $3.00
    const b = await listed(s2, { name: "apple tray" }, terms("30.00", fixed("6.00"))); // $6.00
    const c = await listed(s1, { name: "Éclair dish" }, terms("12.00", pct("25"))); // $3.00
    const [m1, m2] = [await mNameOf(s1), await mNameOf(s2)];
    const tie = (x: Listed, y: Listed) => [x.productRef, y.productRef].sort();
    const sorted = async (sort: string) => refsOf((await page(promoter, { sort })).cards);
    expect(await sorted("NEWEST")).toEqual([c.productRef, b.productRef, a.productRef]);
    expect(await sorted("NAME")).toEqual([b.productRef, a.productRef, c.productRef]);
    expect(await sorted("SELLER")).toEqual(m1 < m2 ? [...tie(a, c), b.productRef] : [b.productRef, ...tie(a, c)]);
    expect(await sorted("WHOLESALE_LOW")).toEqual([c.productRef, ...tie(a, b)]);
    expect(await sorted("WHOLESALE_HIGH")).toEqual([...tie(a, b), c.productRef]);
    expect(await sorted("COMMISSION_HIGH")).toEqual([b.productRef, ...tie(a, c)]);
    expect(await sorted("COMMISSION_LOW")).toEqual([...tie(a, c), b.productRef]);
  });

  it("24 per page; the cursor continues the same order and covers every entry exactly once", async () => {
    const sellers = [await fx.readySeller(), await fx.readySeller()];
    const all: string[] = [];
    for (let i = 0; i < 30; i += 1) {
      all.push((await listed(sellers[i % 2]!, { name: `Item ${String(i).padStart(2, "0")}` }, terms(`${10 + (i % 4)}.00`, pct("10")))).productRef);
    }
    for (const sort of ["NEWEST", "NAME", "WHOLESALE_LOW", "COMMISSION_HIGH", "SELLER"]) {
      const at = next();
      const first = await page(promoter, { sort }, at);
      expect(first.cards, sort).toHaveLength(24);
      expect(first.nextCursor, sort).not.toBeNull();
      const second = await page(promoter, { sort, cursor: first.nextCursor! }, at);
      expect(second.cards, sort).toHaveLength(6);
      expect(second.nextCursor, sort).toBeNull();
      const seen = [...refsOf(first.cards), ...refsOf(second.cards)];
      expect(new Set(seen).size, sort).toBe(30);
      expect([...seen].sort(), sort).toEqual([...all].sort());
      // One continuous order: page 2 is exactly what an unpaged read puts after page 1.
      expect(seen, sort).toEqual(refsOf((await readPromotableCatalogPage(db, await viewerOf(promoter), { ...query({ sort }) }, at)).cards).concat(refsOf(second.cards)));
      // A cursor for another sort is ignored, and the list restarts.
      const other = await page(promoter, { sort: sort === "NAME" ? "NEWEST" : "NAME", cursor: first.nextCursor! }, at);
      expect(other.cursorIgnored, sort).toBe(true);
      expect(other.cards, sort).toHaveLength(24);
    }
  });

  it("long non-ASCII names under NAME: the cursor stays readable and pages cover every entry exactly once", async () => {
    const seller = await fx.readySeller();
    const all: string[] = [];
    // 26 names of 150+ CJK characters, every one sharing its first 64: the
    // NAME order falls to productRef across the page boundary.
    for (let i = 0; i < 26; i += 1) {
      const name = `${"陶".repeat(150)}${String.fromCharCode(0x4e00 + (25 - i))}`;
      all.push((await listed(seller, { name })).productRef);
    }
    const at = next();
    const first = await page(promoter, { sort: "NAME" }, at);
    expect(first.cards).toHaveLength(24);
    expect(first.nextCursor).not.toBeNull();
    const second = await page(promoter, { sort: "NAME", cursor: first.nextCursor! }, at);
    expect(second.cursorIgnored).toBe(false);
    expect(second.cards).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const seen = [...refsOf(first.cards), ...refsOf(second.cards)];
    expect(seen).toEqual([...all].sort());
  });

  it("a running promotion's terms are in force on the card; an upcoming one appears on the detail page only", async () => {
    const seller = await fx.readySeller();
    const item = await listed(seller, {}, terms("50.00", pct("20")));
    const at = next();
    const window = { effectiveFrom: plus(at, 60), effectiveUntil: plus(at, 120) };
    const body = { expectedVersion: "1", wholesalePrice: "40.00", ...window };
    const asked = await offerCall(handleSchedulePromotionRequest, seller, item, body, at);
    expect(asked.status).toBe(409);
    expect((await offerCall(handleSchedulePromotionRequest, seller, item, { ...body, confirmation: asked.body.disclosure }, at)).status).toBe(201);

    const before = plus(at, 30);
    const [upcomingCard] = (await page(promoter, {}, before)).cards;
    expect(upcomingCard).toMatchObject({ termsInForce: "STANDING", terms: { wholesalePriceMinorUnits: 5000, calculatedCommissionMinorUnits: 1000 } });
    const upcoming = await readPromotableCatalogDetail(db, await viewerOf(promoter), item.productRef, before);
    expect(upcoming).toMatchObject({
      standingTerms: null,
      upcomingPromotion: { wholesalePriceMinorUnits: 4000, calculatedCommissionMinorUnits: 800, ...window },
    });

    const during = plus(at, 90);
    const [runningCard] = (await page(promoter, {}, during)).cards;
    expect(runningCard).toMatchObject({
      termsInForce: "SCHEDULED_PROMOTION",
      promotionEndsAt: window.effectiveUntil,
      terms: { wholesalePriceMinorUnits: 4000, calculatedCommissionMinorUnits: 800 },
    });
    expect(await readPromotableCatalogDetail(db, await viewerOf(promoter), item.productRef, during)).toMatchObject({
      standingTerms: { wholesalePriceMinorUnits: 5000, calculatedCommissionMinorUnits: 1000 },
      upcomingPromotion: null,
    });
    // Sorting and filtering read the terms in force at the instant.
    expect((await page(promoter, { wholesaleMax: "45" }, during)).cards).toHaveLength(1);
    expect((await page(promoter, { wholesaleMax: "45" }, before)).cards).toHaveLength(0);
  });

  it("Request to Promote goes through the unchanged 1.41 route, and the card follows the relationship", async () => {
    const seller = await fx.readySeller();
    const item = await listed(seller);
    const requested = await handleRequestPromotionAuthorizationRequest(
      { productRef: item.productRef, contentType: "application/json", originHeader: ORIGIN, cookieHeader: promoter.cookieHeader, rawBody: "{}" },
      { db, now: next, appOrigin: ORIGIN },
    );
    expect(requested.status).toBe(201);
    expect((await page(promoter)).cards[0]!.authorization).toBe("REQUESTED");
    const decide = (decision: string) =>
      handleDecidePromotionAuthorizationRequest(
        {
          productRef: item.productRef,
          authorizationRef: requested.body.authorizationRef as string,
          contentType: "application/json",
          originHeader: ORIGIN,
          cookieHeader: seller.cookieHeader,
          rawBody: JSON.stringify({ decision }),
        },
        { db, now: next, appOrigin: ORIGIN },
      );
    expect((await decide("APPROVE")).status).toBe(200);
    expect((await readPromotableCatalogDetail(db, await viewerOf(promoter), item.productRef, next()))!.authorization).toBe("APPROVED");
    expect((await decide("REVOKE")).status).toBe(200);
    expect((await page(promoter)).cards[0]!.authorization).toBe("NONE"); // may ask again
  });

  it("DENIED and CANCELLED both show as NONE — the Promoter may ask again — and the Product stays listed", async () => {
    const seller = await fx.readySeller();
    const item = await listed(seller);
    const ask = async () => {
      const r = await handleRequestPromotionAuthorizationRequest(
        { productRef: item.productRef, contentType: "application/json", originHeader: ORIGIN, cookieHeader: promoter.cookieHeader, rawBody: "{}" },
        { db, now: next, appOrigin: ORIGIN },
      );
      expect(r.status).toBe(201);
      return r.body.authorizationRef as string;
    };
    const denied = await handleDecidePromotionAuthorizationRequest(
      {
        productRef: item.productRef,
        authorizationRef: await ask(),
        contentType: "application/json",
        originHeader: ORIGIN,
        cookieHeader: seller.cookieHeader,
        rawBody: JSON.stringify({ decision: "DENY" }),
      },
      { db, now: next, appOrigin: ORIGIN },
    );
    expect(denied.status).toBe(200);
    expect((await page(promoter)).cards.map((c) => [c.productRef, c.authorization])).toEqual([[item.productRef, "NONE"]]);

    const cancelled = await handleCancelPromotionAuthorizationRequest(
      {
        productRef: item.productRef,
        authorizationRef: await ask(),
        contentType: "application/json",
        originHeader: ORIGIN,
        cookieHeader: promoter.cookieHeader,
        rawBody: "{}",
      },
      { db, now: next, appOrigin: ORIGIN },
    );
    expect(cancelled.status).toBe(200);
    const detail = await readPromotableCatalogDetail(db, await viewerOf(promoter), item.productRef, next());
    expect(detail!.authorization).toBe("NONE");
  });

  it("who may browse: a Promoter may (requesting needs a verified email); a Seller-only participant may not", async () => {
    const unverified = await fx.draftParticipant(["PROMOTER"], { verified: false });
    expect(await resolvePromotableCatalogAccess(db, unverified.accountId)).toMatchObject({
      outcome: "ALLOWED",
      canRequest: false,
      requestRefusals: ["EMAIL_UNVERIFIED"],
    });
    expect(await resolvePromotableCatalogAccess(db, promoter.accountId)).toMatchObject({ outcome: "ALLOWED", canRequest: true });
    const sellerOnly = await fx.readySeller();
    expect(await resolvePromotableCatalogAccess(db, sellerOnly.accountId)).toMatchObject({
      outcome: "NOT_PROMOTER",
      requestRefusals: ["PROMOTER_ROLE_NOT_HELD"],
    });
  });

  it("the load-more route: 401 / 403 / 400 refusals, and a JSON page with no private identity", async () => {
    const seller = await fx.readySeller();
    for (let i = 0; i < 26; i += 1) await listed(seller, { name: `Route ${i}` });
    const call = (actor: FixtureActor | null, search: string) =>
      handlePromotableCatalogRequest({ search, cookieHeader: actor?.cookieHeader ?? null }, { db, now: () => plus(NOW, 60 * 24 * 3) });
    expect(await call(null, "")).toMatchObject({ status: 401, body: { error: "UNAUTHENTICATED" } });
    expect(await call(seller, "")).toMatchObject({ status: 403, body: { error: "PROMOTABLE_CATALOG_NOT_AVAILABLE" } });
    expect(await call(promoter, "?sort=RANDOM&delivery=x")).toMatchObject({ status: 400, body: { invalid: ["delivery", "sort"] } });
    expect(await call(promoter, "?cursor=abc")).toMatchObject({ status: 400, body: { invalid: ["cursor"] } });

    const first = await call(promoter, "?sort=NAME");
    expect(first.status).toBe(200);
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(Object.keys(first.body).sort()).toEqual(["cards", "nextCursor"]);
    expect(first.body.cards).toHaveLength(24);
    const second = await call(promoter, `?sort=NAME&cursor=${first.body.nextCursor as string}`);
    expect(second.body).toMatchObject({ nextCursor: null });
    expect(second.body.cards).toHaveLength(2);
    await expectNoPrivateIdentity(first.body, [seller, promoter]);
    await expectNoPrivateIdentity(second.body, [seller, promoter]);
  });
});
