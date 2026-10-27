/**
 * Phase 1.42 — the Offer Seller routes, against a real database.
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * Proves the edge: origin before session, session before anything is read,
 * opaque references as the only selectors (a malformed one is a 404, another
 * Seller's Offer the same 404 as an unknown one), strict bodies (no participant,
 * lifecycle, version to mint, or economics), the bounded error vocabulary, the
 * two-step confirmation carrying the server's disclosure, and answers carrying
 * references and labels only — never an internal id.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import {
  OFFER_ROUTE_ERROR_CODES as CODES,
  handleActivateOfferRequest,
  handleCreateOfferRequest,
  handleEndPromotionRequest,
  handlePauseOfferRequest,
  handleReplacePromotionRequest,
  handleResumeOfferRequest,
  handleReviseOfferRequest,
  handleSchedulePromotionRequest,
  handleWithdrawOfferRequest,
  type OfferRouteResult,
} from "../src/server/marketplace/offer-route-handler";
import { sellerCommerceFixture, type FixtureActor } from "./support/seller-commerce-fixture";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2029-05-01T09:00:00.000Z";
// Within the fixture session's 7-day lifetime, which starts at NOW.
const BASE = Date.parse("2029-05-02T09:00:00.000Z");
const ORIGIN = "https://monacado.test";
const UNKNOWN_REF = "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";

const fx = sellerCommerceFixture({ db, emailPrefix: "p142route", now: NOW, origin: ORIGIN });

let minute = 0;
const next = (): string => new Date(BASE + (minute += 10) * 60_000).toISOString();
const plus = (from: string, hours: number): string => new Date(Date.parse(from) + hours * 3_600_000).toISOString();

const TERMS = { wholesalePrice: "50.00", currency: "USD", commission: { method: "PERCENT_OF_WHOLESALE", percent: "20" } };

type Handler = typeof handleCreateOfferRequest;

function call(
  handler: Handler,
  actor: { cookieHeader: string } | null,
  refs: { productRef: string; offerRef?: string },
  body: Record<string, unknown> | string,
  opts: { origin?: string | null; contentType?: string; now?: string } = {},
): Promise<OfferRouteResult> {
  return handler(
    {
      ...refs,
      contentType: opts.contentType ?? "application/json",
      originHeader: opts.origin === undefined ? ORIGIN : opts.origin,
      cookieHeader: actor?.cookieHeader ?? null,
      rawBody: typeof body === "string" ? body : JSON.stringify(body),
    },
    { db, now: () => opts.now ?? next(), appOrigin: ORIGIN },
  );
}

/** No internal identifier of any kind leaves the edge. */
function expectNoInternalIds(result: OfferRouteResult): void {
  expect(JSON.stringify(result.body)).not.toMatch(/mon:(offer|srec|offeract|mpart|product|acct):/);
}

async function readyWithOffer() {
  const seller = await fx.readySeller();
  const product = await fx.activeProduct(seller);
  const created = await call(handleCreateOfferRequest, seller, { productRef: product.productRef }, { terms: TERMS });
  expect(created.status).toBe(201);
  const refs = { productRef: product.productRef, offerRef: created.body.offerRef as string };
  return { seller, product, refs };
}

async function activateViaRoutes(seller: FixtureActor, refs: { productRef: string; offerRef: string }) {
  const asked = await call(handleActivateOfferRequest, seller, refs, {
    confirmation: {
      version: "9",
      calculatedCommissionMinorUnits: 0,
      calculatedSellerGrossProceedsMinorUnits: 0,
      commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
    },
  });
  expect(asked.status).toBe(409);
  const confirmed = await call(handleActivateOfferRequest, seller, refs, { confirmation: asked.body.disclosure as object });
  expect(confirmed.status).toBe(200);
  return confirmed;
}

const describeDb = RUN ? describe : describe.skip;

describeDb("Offer Seller routes (Phase 1.42)", () => {
  beforeEach(fx.cleanup);
  afterAll(async () => {
    await fx.cleanup();
    await disconnectPrisma();
  });

  it("1. create answers 201 with references and labels only, no-store", async () => {
    const seller = await fx.readySeller();
    const product = await fx.activeProduct(seller);
    const created = await call(handleCreateOfferRequest, seller, { productRef: product.productRef }, { terms: TERMS });
    expect(created.status).toBe(201);
    expect(Object.keys(created.body).sort()).toEqual(["offerRef", "productRef", "promotionVersion", "standingVersion", "state"]);
    expect(created.body).toMatchObject({ productRef: product.productRef, state: "DRAFT", standingVersion: "1", promotionVersion: null });
    expect(created.headers["cache-control"]).toBe("no-store");
    expectNoInternalIds(created);
  });

  it("2. a foreign origin is refused before the session is read; no session is 401", async () => {
    const { seller, refs } = await readyWithOffer();
    const foreign = await call(handlePauseOfferRequest, null, refs, {}, { origin: "https://evil.test" });
    expect(foreign).toMatchObject({ status: 403, body: { error: CODES.crossOrigin } });
    expect(await call(handlePauseOfferRequest, null, refs, {})).toMatchObject({ status: 401, body: { error: CODES.unauthenticated } });
    expect((await call(handlePauseOfferRequest, seller, refs, {}, { origin: "https://evil.test" })).status).toBe(403);
  });

  it("3. bodies are strict: no participant, lifecycle, version, or economics; JSON only", async () => {
    const { seller, product, refs } = await readyWithOffer();
    for (const [handler, path, body] of [
      [handleCreateOfferRequest, { productRef: product.productRef }, { terms: TERMS, sellerParticipantId: "x" }],
      [handleCreateOfferRequest, { productRef: product.productRef }, { terms: TERMS, economics: {} }],
      [handlePauseOfferRequest, refs, { lifecycle: "PAUSED" }],
      [handleReviseOfferRequest, refs, { expectedVersion: "1", terms: TERMS, sourceRecordVersion: "5" }],
      [handleActivateOfferRequest, refs, {}],
      [handleResumeOfferRequest, refs, {}],
    ] as const) {
      const result = await call(handler, seller, path, body);
      expect(result).toMatchObject({ status: 400, body: { error: CODES.invalidRequest } });
    }
    expect((await call(handlePauseOfferRequest, seller, refs, "{", {})).status).toBe(400);
    expect((await call(handlePauseOfferRequest, seller, refs, {}, { contentType: "text/plain" })).status).toBe(400);
  });

  it("4. malformed and unknown references are 404; another Seller's Offer is the same 404", async () => {
    const { seller, product, refs } = await readyWithOffer();
    expect(
      await call(handleCreateOfferRequest, seller, { productRef: "not-a-ref" }, { terms: TERMS }),
    ).toMatchObject({ status: 404, body: { error: CODES.productNotAvailable } });
    expect(
      await call(handleCreateOfferRequest, seller, { productRef: UNKNOWN_REF }, { terms: TERMS }),
    ).toMatchObject({ status: 404, body: { error: CODES.productNotAvailable } });
    expect(await call(handlePauseOfferRequest, seller, { productRef: product.productRef, offerRef: "nope" }, {})).toMatchObject({
      status: 404,
      body: { error: CODES.notFound },
    });
    const unknown = await call(handlePauseOfferRequest, seller, { productRef: product.productRef, offerRef: UNKNOWN_REF }, {});
    const other = await fx.readySeller();
    const foreign = await call(handlePauseOfferRequest, other, refs, {});
    expect(foreign).toEqual(unknown);
    expect(foreign).toMatchObject({ status: 404, body: { error: CODES.notFound } });
    /* And another Seller cannot create on this Product either. */
    expect(await call(handleCreateOfferRequest, other, { productRef: product.productRef }, { terms: TERMS })).toMatchObject({
      status: 404,
      body: { error: CODES.productNotAvailable },
    });
  });

  it("5. invalid terms are 400 naming fields; a second create is 409 ALREADY_EXISTS", async () => {
    const { seller, product } = await readyWithOffer();
    const invalid = await call(
      handleCreateOfferRequest,
      seller,
      { productRef: product.productRef },
      { terms: { ...TERMS, wholesalePrice: "1.999" } },
    );
    expect(invalid).toMatchObject({ status: 400, body: { error: CODES.invalidRequest, fields: ["terms.wholesalePrice"] } });
    expect(await call(handleCreateOfferRequest, seller, { productRef: product.productRef }, { terms: TERMS })).toMatchObject({
      status: 409,
      body: { error: CODES.alreadyExists },
    });
  });

  it("6. activation is a two-step exchange: 409 with the server's disclosure, then 200", async () => {
    const { seller, refs } = await readyWithOffer();
    const asked = await call(handleActivateOfferRequest, seller, refs, {
      confirmation: {
        version: "1",
        calculatedCommissionMinorUnits: 1,
        calculatedSellerGrossProceedsMinorUnits: 1,
        commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
      },
    });
    expect(asked).toMatchObject({
      status: 409,
      body: {
        error: CODES.confirmationStale,
        disclosure: { version: "1", calculatedCommissionMinorUnits: 1000, calculatedSellerGrossProceedsMinorUnits: 4000 },
      },
    });
    expectNoInternalIds(asked);
    const confirmed = await call(handleActivateOfferRequest, seller, refs, { confirmation: asked.body.disclosure as object });
    expect(confirmed).toMatchObject({ status: 200, body: { state: "ACTIVE", standingVersion: "1" } });
    /* Activating again is a lifecycle refusal, not an authority one. */
    expect(
      await call(handleActivateOfferRequest, seller, refs, { confirmation: asked.body.disclosure as object }),
    ).toMatchObject({ status: 409, body: { error: CODES.transitionNotPermitted, reasons: ["OFFER_LIFECYCLE_TRANSITION_NOT_PERMITTED"] } });
  });

  it("7. not-ready is 409 with every blocker", async () => {
    const seller = await fx.readySeller();
    const product = await fx.draftProduct(seller);
    const created = await call(handleCreateOfferRequest, seller, { productRef: product.productRef }, { terms: TERMS });
    const refs = { productRef: product.productRef, offerRef: created.body.offerRef as string };
    const asked = await call(handleActivateOfferRequest, seller, refs, {
      confirmation: {
        version: "9",
        calculatedCommissionMinorUnits: 0,
        calculatedSellerGrossProceedsMinorUnits: 0,
        commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
      },
    });
    const result = await call(handleActivateOfferRequest, seller, refs, { confirmation: asked.body.disclosure as object });
    expect(result).toMatchObject({ status: 409, body: { error: CODES.notReady, blockers: ["PRODUCT_NOT_ACTIVE"] } });
  });

  it("8. pause, stale resume, resume, withdraw, and terminal refusal", async () => {
    const { seller, refs } = await readyWithOffer();
    await activateViaRoutes(seller, refs);
    expect(await call(handlePauseOfferRequest, seller, refs, {})).toMatchObject({ status: 200, body: { state: "PAUSED" } });
    expect(await call(handleResumeOfferRequest, seller, refs, { expectedVersion: "4" })).toMatchObject({
      status: 409,
      body: { error: CODES.versionStale },
    });
    expect(await call(handleResumeOfferRequest, seller, refs, { expectedVersion: "1" })).toMatchObject({
      status: 200,
      body: { state: "ACTIVE" },
    });
    expect(await call(handleWithdrawOfferRequest, seller, refs, {})).toMatchObject({ status: 200, body: { state: "WITHDRAWN" } });
    expect(await call(handlePauseOfferRequest, seller, refs, {})).toMatchObject({
      status: 409,
      body: { error: CODES.transitionNotPermitted, reasons: ["OFFER_LIFECYCLE_TERMINAL"] },
    });
  });

  it("9. revision: no-change 409, live revision asks for confirmation of the next label", async () => {
    const { seller, refs } = await readyWithOffer();
    expect(await call(handleReviseOfferRequest, seller, refs, { expectedVersion: "1", terms: TERMS })).toMatchObject({
      status: 409,
      body: { error: CODES.noMaterialChange },
    });
    await activateViaRoutes(seller, refs);
    const repriced = { ...TERMS, wholesalePrice: "60.00" };
    const asked = await call(handleReviseOfferRequest, seller, refs, { expectedVersion: "1", terms: repriced });
    expect(asked).toMatchObject({ status: 409, body: { error: CODES.confirmationStale, disclosure: { version: "2" } } });
    expect(
      await call(handleReviseOfferRequest, seller, refs, { expectedVersion: "1", terms: repriced, confirmation: asked.body.disclosure }),
    ).toMatchObject({ status: 200, body: { standingVersion: "2", state: "ACTIVE" } });
  });

  it("10. promotions: schedule 201, pending 409, replace 201, end before start 409", async () => {
    const { seller, refs } = await readyWithOffer();
    await activateViaRoutes(seller, refs);
    const now = next();
    const window = { effectiveFrom: plus(now, 1), effectiveUntil: plus(now, 2) };
    const body = { expectedVersion: "1", wholesalePrice: "40.00", ...window };
    const asked = await call(handleSchedulePromotionRequest, seller, refs, body, { now });
    expect(asked).toMatchObject({ status: 409, body: { error: CODES.confirmationStale, disclosure: { version: "2" } } });
    const scheduled = await call(handleSchedulePromotionRequest, seller, refs, { ...body, confirmation: asked.body.disclosure }, { now });
    expect(scheduled).toMatchObject({ status: 201, body: { standingVersion: "1", promotionVersion: "2" } });

    expect(
      await call(handleSchedulePromotionRequest, seller, refs, { ...body, confirmation: asked.body.disclosure }, { now }),
    ).toMatchObject({ status: 409, body: { error: CODES.promotionPending } });

    const replaceBody = { ...body, expectedPromotionVersion: "2", wholesalePrice: "45.00" };
    const askedReplace = await call(handleReplacePromotionRequest, seller, refs, replaceBody, { now });
    expect(askedReplace.body.disclosure).toMatchObject({ version: "3" });
    expect(
      await call(handleReplacePromotionRequest, seller, refs, { ...replaceBody, confirmation: askedReplace.body.disclosure }, { now }),
    ).toMatchObject({ status: 201, body: { promotionVersion: "3" } });

    expect(await call(handleEndPromotionRequest, seller, refs, { expectedPromotionVersion: "3" }, { now })).toMatchObject({
      status: 409,
      body: { error: CODES.promotionNotRunning },
    });
    expect(await call(handleEndPromotionRequest, seller, refs, { expectedPromotionVersion: "2" }, { now })).toMatchObject({
      status: 409,
      body: { error: CODES.versionStale },
    });
    minute += 300;
  });
});
