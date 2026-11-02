/**
 * Phase 1.45 — Promoted Listing integration, against a real database.
 *
 *   - DRAFT: an APPROVED Promoter places a Product in its own Storefront, priced
 *     or not; the row names no Offer and carries no legacy binding. Refused
 *     without an APPROVED cycle, without Storefront authority, into the
 *     Seller's own Storefront, as a duplicate, or at a non-viable price.
 *   - PRICE: set / change; zero Promoter proceeds pass, negative are refused.
 *   - ACTIVATION: every blocker reported; the exact version shown; the
 *     five-ACTIVE Storefront limit.
 *   - DERIVATION: a Seller revision, a promotion starting and ending, a
 *     revocation, a cancellation, and a re-approval write nothing to the
 *     Listing — effectiveness is re-derived.
 *   - CLOSURE: the retired Offer-copying path refuses; the schema refuses a
 *     legacy binding on the new kind. (Phase 1.46 opened checkout for the
 *     package-based kind; `promoted-sale.integration.test.ts` covers the sale,
 *     and the legacy kind stays refused in `buyer-checkout-and-order`.)
 *   - ROUTES and PRIVACY: bounded codes; references only.
 */

import "dotenv/config";
import { randomInt } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import {
  handleActivateOfferRequest,
  handleCreateOfferRequest,
  handleReviseOfferRequest,
  handleSchedulePromotionRequest,
  type OfferRouteResult,
} from "../src/server/marketplace/offer-route-handler";
import { handleSetProductResaleAvailabilityRequest } from "../src/server/product/product-resale-availability-route-handler";
import {
  handleAcceptOfferPackageRequest,
  handleCancelPromotionAuthorizationRequest,
  handleDecidePromotionAuthorizationRequest,
  handleRequestPromotionAuthorizationRequest,
  type PromotionAuthorizationRouteResult,
} from "../src/server/marketplace/promotion-authorization-route-handler";
import { readPromoterOfferPackageByRefIn, type PromoterOfferPackageView } from "../src/server/marketplace/promotion-offer-acceptance-read-service";
import {
  activatePromotedListing,
  createPromotedListingDraft,
  readPromotedListingCommerceIn,
  readPromoterListingsForProductIn,
  resolvePromotedListingPolicy,
  setPromotedListingPrice,
  withdrawPromotedListing,
} from "../src/server/marketplace/promoted-listing-service";
import {
  PROMOTED_LISTING_ROUTE_ERROR_CODES as CODES,
  handleActivatePromotedListingRequest,
  handleCreatePromotedListingRequest,
  handleSetPromotedListingPriceRequest,
  handleWithdrawPromotedListingRequest,
  type PromotedListingRouteResult,
} from "../src/server/marketplace/promoted-listing-route-handler";
import { createPromotedListing, insertFirstVersion, type ListingSnapshot } from "../src/server/marketplace/listing-service";
import { cryptoListingIdProvider } from "../src/server/marketplace/listing-ids";
import {
  ListingAlreadyExistsError,
  ListingEconomicsRefusedError,
  ListingNotAuthorizedError,
  ListingNotFoundError,
  ListingNotWithdrawableError,
  ListingPriceUnchangedError,
  ListingVersionStaleError,
  PromotedListingNotReadyError,
  PromotedListingPathRetiredError,
  PromotedListingRefusedError,
} from "../src/server/marketplace/listing-errors";
import { prepareCheckout } from "../src/server/marketplace/checkout-service";
import {
  activateCommercialPolicyVersion,
  createCommercialPolicy,
  recordCommercialPolicyVersion,
} from "../src/server/marketplace/commercial-policy-service";
import { findParticipantPrivacyViolations } from "../src/contracts/marketplace/participant-record";
import { syntheticListingRef } from "./support/listing-ref-fixture";
import { sellerCommerceFixture, type FixtureActor } from "./support/seller-commerce-fixture";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2029-11-01T09:00:00.000Z";
const ORIGIN = "https://monacado.test";
const PREFIX = "p145pl";

const fx = sellerCommerceFixture({ db, emailPrefix: PREFIX, now: NOW, origin: ORIGIN });

/* Synthetic, in the shape of the Contract §18 rule: 7.5% of retail + $1.00. */
const POLICY = {
  policyId: "mon:policy:acquisition/synthetic",
  policyVersion: "1",
  currency: "USD",
  retainedPercentageBasisPoints: 750,
  retainedFixedAmountMinorUnits: 100,
  roundingPolicy: "HALF_UP_TO_MINOR_UNIT" as const,
};
const deps = { db, policy: POLICY };
const usd = (retailPriceMinorUnits: number) => ({ retailPriceMinorUnits, retailPriceCurrency: "USD" });

let clock = Date.parse("2029-11-02T09:00:00.000Z");
const next = (): string => new Date((clock += 10 * 60_000)).toISOString();
const advancePast = (iso: string): void => {
  clock = Math.max(clock, Date.parse(iso));
};
const plus = (from: string, minutes: number): string => new Date(Date.parse(from) + minutes * 60_000).toISOString();

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const opaque = (): string => Array.from({ length: 26 }, () => CROCKFORD[randomInt(32)]).join("");
let handles = 0;

// — Seller side, through the real routes (the Phase 1.44 shapes) —

interface Listed {
  seller: FixtureActor;
  productRef: string;
  internalProductId: string;
  offerRef: string;
}

const STALE_CONFIRMATION = {
  version: "9",
  calculatedCommissionMinorUnits: 0,
  calculatedSellerGrossProceedsMinorUnits: 0,
  commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
};
/** $40.00 wholesale, 10% → a $4.00 commission: the $40.00 retail break-even. */
const terms = (wholesalePrice: string) => ({ wholesalePrice, currency: "USD", commission: { method: "PERCENT_OF_WHOLESALE", percent: "10" } });

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

async function confirmed(handler: typeof handleCreateOfferRequest, item: Listed, body: Record<string, unknown>): Promise<void> {
  const refs = { productRef: item.productRef, offerRef: item.offerRef };
  const asked = await offerCall(handler, item.seller, refs, { ...body, confirmation: STALE_CONFIRMATION });
  expect(asked.status, JSON.stringify(asked.body)).toBe(409);
  const done = await offerCall(handler, item.seller, refs, { ...body, confirmation: asked.body.disclosure });
  expect(done.status, JSON.stringify(done.body)).toBeLessThan(300);
}

async function listed(seller?: FixtureActor): Promise<Listed> {
  const s = seller ?? (await fx.readySeller());
  const product = await fx.activeProduct(s);
  const set = await handleSetProductResaleAvailabilityRequest(
    {
      productRef: product.productRef,
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader: s.cookieHeader,
      rawBody: JSON.stringify({ resaleAvailability: "AVAILABLE" }),
    },
    { db, now: next, appOrigin: ORIGIN },
  );
  expect(set.status).toBe(200);
  const created = await offerCall(handleCreateOfferRequest, s, { productRef: product.productRef }, { terms: terms("40.00") });
  expect(created.status).toBe(201);
  const item = { seller: s, ...product, offerRef: created.body.offerRef as string };
  await confirmed(handleActivateOfferRequest, item, {});
  return item;
}

async function standingVersion(item: Listed): Promise<string> {
  const offer = await db.offer.findUniqueOrThrow({ where: { offerRef: item.offerRef } });
  const row = await db.offerSourceRecordVersionRow.findFirstOrThrow({
    where: { offerSourceRecordId: offer.offerSourceRecordId, termsKind: "STANDING" },
    orderBy: { seq: "desc" },
  });
  return row.sourceRecordVersion;
}

// — Promotion Authorization and acceptance (Phase 1.41 / 1.44) —

function cycleCall(
  handler: typeof handleAcceptOfferPackageRequest,
  actor: FixtureActor,
  item: Listed,
  authorizationRef: string,
  body: unknown,
  now = next(),
): Promise<PromotionAuthorizationRouteResult> {
  return handler(
    { productRef: item.productRef, authorizationRef, contentType: "application/json", originHeader: ORIGIN, cookieHeader: actor.cookieHeader, rawBody: JSON.stringify(body) },
    { db, now: () => now, appOrigin: ORIGIN },
  );
}

async function approved(promoter: FixtureActor, item: Listed): Promise<string> {
  const r = await handleRequestPromotionAuthorizationRequest(
    { productRef: item.productRef, contentType: "application/json", originHeader: ORIGIN, cookieHeader: promoter.cookieHeader, rawBody: "{}" },
    { db, now: next, appOrigin: ORIGIN },
  );
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const ref = r.body.authorizationRef as string;
  const d = await cycleCall(handleDecidePromotionAuthorizationRequest, item.seller, item, ref, { decision: "APPROVE" });
  expect(d.status).toBe(200);
  return ref;
}

async function accept(promoter: FixtureActor, item: Listed, authorizationRef: string): Promise<void> {
  const at = next();
  const v: PromoterOfferPackageView | null = await db.$transaction((tx) =>
    readPromoterOfferPackageByRefIn(tx, { authorizationRef, promoterParticipantId: promoter.participantId }, at),
  );
  expect(v).not.toBeNull();
  const promotion = v!.promotion === null ? null : (({ inForce: _d, ...rest }) => rest)(v!.promotion);
  const r = await cycleCall(handleAcceptOfferPackageRequest, promoter, item, authorizationRef, { offerRef: v!.offerRef, standing: v!.standing, promotion }, at);
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
}

// — Storefronts, written directly as the Listing suites do —

async function storefront(ownerParticipantId: string): Promise<{ id: string; handle: string }> {
  handles += 1;
  const id = `mon:storefront:${opaque()}`;
  const handle = `p145-shop-${handles}-${randomInt(1_000_000)}`;
  await db.storefront.create({
    data: {
      internalStorefrontId: id,
      storefrontSourceRecordId: `mon:srec:${opaque()}`,
      currentSourceRecordVersion: "1",
      ownerParticipantId,
      publicHandle: handle,
      lifecycle: "ACTIVE",
      visibility: "PUBLIC",
    },
  });
  return { id, handle };
}

const seededPolicies: string[] = [];

/** A real commercial policy, ACTIVE at 7.5% + $1.00, configured as the checkout identity. */
async function configuredPolicy(): Promise<string> {
  const governor = await fx.seedOperator("commercial-policy:govern");
  const policy = await createCommercialPolicy({ label: `P145 policy ${next()}`, now: NOW }, { db });
  seededPolicies.push(policy.policyId);
  await recordCommercialPolicyVersion(
    {
      policyId: policy.policyId,
      policyVersion: "1",
      currency: "USD",
      retainedPercentageBasisPoints: 750,
      retainedFixedAmountMinorUnits: 100,
      roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
      effectiveFrom: NOW,
      recordedByAccountId: governor,
      recordedAt: NOW,
    },
    { db },
  );
  await activateCommercialPolicyVersion(
    { policyId: policy.policyId, policyVersion: "1", activatedByAccountId: governor, activatedAt: NOW },
    { db },
  );
  process.env.MONACADO_CHECKOUT_POLICY_ID = policy.policyId;
  return policy.policyId;
}

/** Everything this suite adds beyond the fixture: Listings, governance, Storefronts, policies. */
async function cleanupListings(): Promise<void> {
  delete process.env.MONACADO_CHECKOUT_POLICY_ID;
  await db.commercialPolicyVersionRow.deleteMany({ where: { policyId: { in: seededPolicies } } });
  await db.commercialPolicy.deleteMany({ where: { id: { in: seededPolicies } } });
  seededPolicies.length = 0;
  const accountIds = (await db.account.findMany({ where: { email: { startsWith: PREFIX } }, select: { id: true } })).map((a) => a.id);
  const participantIds = (
    await db.marketplaceParticipant.findMany({ where: { accountId: { in: accountIds } }, select: { id: true } })
  ).map((p) => p.id);
  const storefrontIds = (
    await db.storefront.findMany({ where: { ownerParticipantId: { in: participantIds } }, select: { internalStorefrontId: true } })
  ).map((s) => s.internalStorefrontId);
  const listingIds = (
    await db.listing.findMany({
      where: { OR: [{ storefrontId: { in: storefrontIds } }, { controllingParticipantId: { in: participantIds } }] },
      select: { internalListingId: true },
    })
  ).map((l) => l.internalListingId);
  await db.listingSourceRecordVersionRow.deleteMany({ where: { internalListingId: { in: listingIds } } });
  await db.listing.deleteMany({ where: { internalListingId: { in: listingIds } } });
  await db.storefrontGovernanceAssignment.deleteMany({ where: { internalStorefrontId: { in: storefrontIds } } });
  await db.storefront.deleteMany({ where: { internalStorefrontId: { in: storefrontIds } } });
}

interface Scene {
  item: Listed;
  promoter: FixtureActor;
  shop: { id: string; handle: string };
  authorizationRef: string;
}

/** A ready Promoter, APPROVED and accepted on a listed Product, with its own Storefront. */
async function scene(opts: { accept?: boolean } = {}): Promise<Scene> {
  const item = await listed();
  const promoter = await fx.readyParticipant(["PROMOTER"]);
  const shop = await storefront(promoter.participantId);
  const authorizationRef = await approved(promoter, item);
  if (opts.accept !== false) await accept(promoter, item, authorizationRef);
  return { item, promoter, shop, authorizationRef };
}

const draft = (s: Scene, retail: ReturnType<typeof usd> | null = null, actor = s.promoter) =>
  createPromotedListingDraft(
    { productRef: s.item.productRef, storefrontHandle: s.shop.handle, retail, actingAccountId: actor.accountId, now: next() },
    deps,
  );
const price = (snapshot: ListingSnapshot, actor: FixtureActor, retail: ReturnType<typeof usd>) =>
  setPromotedListingPrice({ listingRef: snapshot.listingRef, retail, actingAccountId: actor.accountId, now: next() }, deps);
const activate = (snapshot: ListingSnapshot, actor: FixtureActor, policy: typeof POLICY | null = POLICY) =>
  activatePromotedListing(
    { listingRef: snapshot.listingRef, expectedVersion: snapshot.currentVersion.sourceRecordVersion, actingAccountId: actor.accountId, now: next() },
    { db, policy },
  );
const commerce = (snapshot: ListingSnapshot, purpose: "ACTIVATION" | "TRANSACTION", at = next()) =>
  db.$transaction((tx) =>
    readPromotedListingCommerceIn(tx, { internalListingId: snapshot.record.internalListingId, at, policy: POLICY, purpose }),
  );
const versionCount = (snapshot: ListingSnapshot) =>
  db.listingSourceRecordVersionRow.count({ where: { internalListingId: snapshot.record.internalListingId } });
const rejection = async (p: Promise<unknown>) => await p.then(() => undefined, (e: unknown) => e);

const describeDb = RUN ? describe : describe.skip;

describeDb("Phase 1.45 — promoted Listing integration", () => {
  beforeEach(async () => {
    await cleanupListings();
    await fx.cleanup();
  });
  afterAll(async () => {
    await cleanupListings();
    await fx.cleanup();
    await disconnectPrisma();
  });

  describe("draft creation", () => {
    it("creates an UNPRICED draft that names no Offer and carries no legacy binding", async () => {
      const s = await scene();
      const snapshot = await draft(s);
      expect(snapshot.currentVersion.lifecycle).toBe("DRAFT");
      expect(snapshot.currentVersion.controllingParticipantId).toBe(s.promoter.participantId);
      expect(snapshot.currentVersion.placement).toEqual({ listingType: "PROMOTED", termsBasis: "PROMOTION_PACKAGE", retail: null });

      const row = await db.listingSourceRecordVersionRow.findFirstOrThrow({ where: { internalListingId: snapshot.record.internalListingId } });
      expect(row.promotedTermsBasis).toBe("PROMOTION_PACKAGE");
      for (const column of [
        row.acceptedInternalOfferId,
        row.acceptedOfferSourceRecordId,
        row.acceptedOfferSourceRecordVersion,
        row.acceptedWholesalePriceMinorUnits,
        row.acceptedWholesalePriceCurrency,
        row.acceptedCommissionCalculationPolicyVersion,
        row.acceptedAt,
        row.upstreamReviewState,
      ]) {
        expect(column).toBeNull();
      }
    });

    it("needs only an APPROVED cycle to draft — not yet an acceptance", async () => {
      const s = await scene({ accept: false });
      expect((await draft(s)).currentVersion.lifecycle).toBe("DRAFT");
    });

    it("refuses without an APPROVED cycle, and writes nothing", async () => {
      const item = await listed();
      const promoter = await fx.readyParticipant(["PROMOTER"]);
      const shop = await storefront(promoter.participantId);
      const refused = await rejection(draft({ item, promoter, shop, authorizationRef: "" }));
      expect(refused).toBeInstanceOf(PromotedListingRefusedError);
      expect((refused as PromotedListingRefusedError).reason).toBe("AUTHORIZATION_NOT_APPROVED");
      expect(await db.listing.count({ where: { storefrontId: shop.id } })).toBe(0);
    });

    it("refuses after a revocation and after a cancellation", async () => {
      const s = await scene();
      await cycleCall(handleDecidePromotionAuthorizationRequest, s.item.seller, s.item, s.authorizationRef, { decision: "REVOKE" });
      expect(await rejection(draft(s))).toMatchObject({ reason: "AUTHORIZATION_NOT_APPROVED" });

      const t = await scene();
      const cancelled = await cycleCall(handleCancelPromotionAuthorizationRequest, t.promoter, t.item, t.authorizationRef, {});
      expect(cancelled.status).toBe(200);
      expect(await rejection(draft(t))).toMatchObject({ reason: "AUTHORIZATION_NOT_APPROVED" });
    });

    it("refuses a Storefront the Promoter has no authority over", async () => {
      const s = await scene();
      const stranger = await fx.readyParticipant(["PROMOTER"]);
      const theirs = await storefront(stranger.participantId);
      const refused = await rejection(draft({ ...s, shop: theirs }));
      expect(refused).toBeInstanceOf(ListingNotAuthorizedError);
      expect((refused as ListingNotAuthorizedError).reasonCodes).toContain("STOREFRONT_AUTHORITY_REQUIRED");
    });

    it("refuses the Seller's own Storefront — that placement would be seller-direct", async () => {
      const s = await scene();
      const sellersShop = await storefront(s.item.seller.participantId);
      await db.storefrontGovernanceAssignment.create({
        data: {
          id: `mon:sgov:${opaque()}`,
          internalStorefrontId: sellersShop.id,
          participantId: s.promoter.participantId,
          role: "ADMIN",
          status: "ACTIVE",
          assignedAt: new Date(NOW),
        },
      });
      expect(await rejection(draft({ ...s, shop: sellersShop }))).toMatchObject({ reason: "STOREFRONT_OWNED_BY_SELLER" });
    });

    it("refuses a duplicate placement of the same Product in the same Storefront", async () => {
      const s = await scene();
      await draft(s);
      expect(await rejection(draft(s))).toBeInstanceOf(ListingAlreadyExistsError);
    });

    it("refuses a non-viable price at draft, and accepts the break-even price", async () => {
      const s = await scene();
      expect(await rejection(draft(s, usd(3_999)))).toMatchObject({ economicsCode: "NEGATIVE_PROMOTER_PROCEEDS" });
      const ok = await draft(s, usd(4_000));
      expect(ok.currentVersion.placement).toMatchObject({ retail: usd(4_000) });
    });
  });

  describe("price", () => {
    it("sets, changes, and refuses negative proceeds — zero proceeds pass", async () => {
      const s = await scene();
      const d = await draft(s);
      const priced = await price(d, s.promoter, usd(4_000));
      expect(priced.currentVersion.sourceRecordVersion).toBe("2");
      expect(priced.currentVersion.lifecycle).toBe("DRAFT");

      const refused = await rejection(price(priced, s.promoter, usd(3_999)));
      expect(refused).toBeInstanceOf(ListingEconomicsRefusedError);
      expect((refused as ListingEconomicsRefusedError).economicsCode).toBe("NEGATIVE_PROMOTER_PROCEEDS");
      expect(await rejection(price(priced, s.promoter, usd(4_000)))).toBeInstanceOf(ListingPriceUnchangedError);
      expect(await versionCount(d)).toBe(2);
    });

    it("answers a stranger exactly as an unknown Listing", async () => {
      const s = await scene();
      const d = await draft(s);
      const stranger = await fx.readyParticipant(["PROMOTER"]);
      expect(await rejection(price(d, stranger, usd(5_000)))).toBeInstanceOf(ListingNotFoundError);
    });

    it("fails closed with no commercial policy", async () => {
      const s = await scene();
      const d = await draft(s);
      const refused = await rejection(
        setPromotedListingPrice({ listingRef: d.listingRef, retail: usd(9_000), actingAccountId: s.promoter.accountId, now: next() }, { db, policy: null }),
      );
      expect(refused).toMatchObject({ economicsCode: "NO_EFFECTIVE_COMMERCIAL_POLICY" });
    });
  });

  describe("activation", () => {
    it("activates a priced draft whose terms are accepted, at the exact version shown", async () => {
      const s = await scene();
      const d = await draft(s, usd(5_000));
      const active = await activate(d, s.promoter);
      expect(active.currentVersion.lifecycle).toBe("ACTIVE");
      expect(active.currentVersion.sourceRecordVersion).toBe("2");
      const listing = await db.listing.findUniqueOrThrow({ where: { internalListingId: d.record.internalListingId } });
      expect(listing.lifecycle).toBe("ACTIVE");
      expect(listing.currentPlacementMarker).not.toBeNull();
    });

    it("reports every blocker of an unpriced, unaccepted draft at once", async () => {
      const s = await scene({ accept: false });
      const d = await draft(s);
      const refused = await rejection(activate(d, s.promoter, null));
      expect(refused).toBeInstanceOf(PromotedListingNotReadyError);
      expect((refused as PromotedListingNotReadyError).blockers).toEqual(["TERMS_NOT_ACCEPTED", "RETAIL_PRICE_MISSING"]);
      expect(await versionCount(d)).toBe(1);
    });

    it("refuses with no commercial policy in force", async () => {
      const s = await scene();
      const d = await draft(s, usd(5_000));
      expect(await rejection(activate(d, s.promoter, null))).toMatchObject({ blockers: ["NO_EFFECTIVE_COMMERCIAL_POLICY"] });
    });

    it("refuses an unready Promoter, naming why", async () => {
      const s = await scene();
      const d = await draft(s, usd(5_000));
      await db.marketplaceParticipant.update({ where: { id: s.promoter.participantId }, data: { status: "DRAFT" } });
      const refused = (await rejection(activate(d, s.promoter))) as PromotedListingNotReadyError;
      expect(refused).toBeInstanceOf(PromotedListingNotReadyError);
      expect(refused.blockers).toEqual(["PARTICIPANT_NOT_ACTIVE"]);
    });

    it("refuses when the Product is no longer resale-AVAILABLE or the Offer is not ACTIVE", async () => {
      const s = await scene();
      const d = await draft(s, usd(5_000));
      const set = await handleSetProductResaleAvailabilityRequest(
        {
          productRef: s.item.productRef,
          contentType: "application/json",
          originHeader: ORIGIN,
          cookieHeader: s.item.seller.cookieHeader,
          rawBody: JSON.stringify({ resaleAvailability: "WITHDRAWN" }),
        },
        { db, now: next, appOrigin: ORIGIN },
      );
      expect(set.status).toBe(200);
      expect(((await rejection(activate(d, s.promoter))) as PromotedListingNotReadyError).blockers).toContain("RESALE_NOT_AVAILABLE");
    });

    it("refuses a stale version: a price change between view and click", async () => {
      const s = await scene();
      const shown = await draft(s, usd(5_000));
      await price(shown, s.promoter, usd(6_000));
      expect(await rejection(activate(shown, s.promoter))).toBeInstanceOf(ListingVersionStaleError);
    });

    it("refuses a second activation, and a withdrawn Listing", async () => {
      const s = await scene();
      const d = await draft(s, usd(5_000));
      const active = await activate(d, s.promoter);
      expect(await rejection(activate(active, s.promoter))).toMatchObject({ reason: "LISTING_NOT_DRAFT" });
      const withdrawn = await withdrawPromotedListing({ listingRef: d.listingRef, actingAccountId: s.promoter.accountId, now: next() }, { db });
      expect(await rejection(activate(withdrawn, s.promoter))).toMatchObject({ reason: "LISTING_TERMINAL" });
    });

    it("includes five ACTIVE Listings per Storefront: the sixth waits until one is withdrawn", async () => {
      const s = await scene();
      /* Five ACTIVE Listings of other Products already in the Storefront. */
      for (let i = 0; i < 5; i += 1) {
        const other = await fx.activeProduct(s.item.seller);
        const internalListingId = cryptoListingIdProvider.nextInternalListingId();
        await insertFirstVersion(db, {
          internalListingId,
          listingSourceRecordId: cryptoListingIdProvider.nextListingSourceRecordId(),
          listingRef: syntheticListingRef(),
          storefrontId: s.shop.id,
          internalProductId: other.internalProductId,
          controllingParticipantId: s.promoter.participantId,
          placement: { listingType: "PROMOTED", termsBasis: "PROMOTION_PACKAGE", retail: usd(5_000) },
          authorizedByParticipantId: s.promoter.participantId,
          authorizedByActorId: s.promoter.accountId,
          recordedAt: new Date(NOW),
        });
        await db.listing.update({ where: { internalListingId }, data: { lifecycle: "ACTIVE" } });
      }
      const sixth = await draft(s, usd(5_000));
      expect(await rejection(activate(sixth, s.promoter))).toMatchObject({ blockers: ["STOREFRONT_ACTIVE_LISTING_LIMIT"] });

      const one = await db.listing.findFirstOrThrow({ where: { storefrontId: s.shop.id, lifecycle: "ACTIVE" } });
      await withdrawPromotedListing({ listingRef: one.listingRef, actingAccountId: s.promoter.accountId, now: next() }, { db });
      expect((await activate(sixth, s.promoter)).currentVersion.lifecycle).toBe("ACTIVE");
      expect(await db.listing.count({ where: { storefrontId: s.shop.id, lifecycle: "ACTIVE" } })).toBe(5);
    });
  });

  describe("derived effectiveness — nothing is written to the Listing", () => {
    it("a Seller revision suspends coverage until the Promoter accepts the new terms", async () => {
      const s = await scene();
      const active = await activate(await draft(s, usd(5_000)), s.promoter);
      expect((await commerce(active, "TRANSACTION")).blockers).not.toContain("TERMS_NOT_ACCEPTED");

      await confirmed(handleReviseOfferRequest, s.item, { expectedVersion: await standingVersion(s.item), terms: terms("45.00") });
      const after = await commerce(active, "TRANSACTION");
      expect(after.blockers).toContain("TERMS_NOT_ACCEPTED");
      /* $50.00 is still viable at $45.00 wholesale / $4.50 commission. */
      expect(after.economics).toMatchObject({ ok: true });
      expect(after.governingTerms?.wholesalePriceMinorUnits).toBe(4_500);

      await accept(s.promoter, s.item, s.authorizationRef);
      expect((await commerce(active, "TRANSACTION")).blockers).not.toContain("TERMS_NOT_ACCEPTED");
      expect(await versionCount(active)).toBe(2);
      expect((await db.listing.findUniqueOrThrow({ where: { internalListingId: active.record.internalListingId } })).lifecycle).toBe("ACTIVE");
    });

    it("a Seller revision can make the price non-viable — reported, never repriced", async () => {
      const s = await scene();
      const active = await activate(await draft(s, usd(4_000)), s.promoter);
      await confirmed(handleReviseOfferRequest, s.item, { expectedVersion: await standingVersion(s.item), terms: terms("45.00") });
      await accept(s.promoter, s.item, s.authorizationRef);
      const after = await commerce(active, "TRANSACTION");
      expect(after.blockers).toContain("NEGATIVE_PROMOTER_PROCEEDS");
      expect(after.retail).toEqual(usd(4_000));
      expect(await versionCount(active)).toBe(2);
    });

    it("a promotion governs only while it runs, and is warned of before", async () => {
      const s = await scene();
      const active = await activate(await draft(s, usd(5_000)), s.promoter);
      const at = new Date(clock).toISOString();
      const window = { effectiveFrom: plus(at, 600), effectiveUntil: plus(at, 720) };
      await confirmed(handleSchedulePromotionRequest, s.item, { expectedVersion: await standingVersion(s.item), wholesalePrice: "30.00", ...window });
      await accept(s.promoter, s.item, s.authorizationRef);

      const before = await commerce(active, "TRANSACTION");
      expect(before.governingTerms?.wholesalePriceMinorUnits).toBe(4_000);
      expect(before.upcomingPromotion).toMatchObject({ effectiveFrom: window.effectiveFrom, economics: { ok: true } });

      advancePast(window.effectiveFrom);
      const during = await commerce(active, "TRANSACTION");
      expect(during.governingTerms?.wholesalePriceMinorUnits).toBe(3_000);
      expect(during.blockers).not.toContain("TERMS_NOT_ACCEPTED");

      advancePast(window.effectiveUntil);
      const afterwards = await commerce(active, "TRANSACTION");
      expect(afterwards.governingTerms?.wholesalePriceMinorUnits).toBe(4_000);
      expect(await versionCount(active)).toBe(2);
    });

    it("revocation suspends it; a new approval and acceptance restore it — the same Listing", async () => {
      const s = await scene();
      const active = await activate(await draft(s, usd(5_000)), s.promoter);
      await cycleCall(handleDecidePromotionAuthorizationRequest, s.item.seller, s.item, s.authorizationRef, { decision: "REVOKE" });
      expect((await commerce(active, "TRANSACTION")).blockers).toContain("AUTHORIZATION_NOT_APPROVED");
      expect((await db.listing.findUniqueOrThrow({ where: { internalListingId: active.record.internalListingId } })).lifecycle).toBe("ACTIVE");

      const again = await approved(s.promoter, s.item);
      /* A new cycle inherits no acceptance. */
      expect((await commerce(active, "TRANSACTION")).blockers).toContain("TERMS_NOT_ACCEPTED");
      await accept(s.promoter, s.item, again);
      const restored = await commerce(active, "TRANSACTION");
      expect(restored.blockers).not.toContain("AUTHORIZATION_NOT_APPROVED");
      expect(restored.blockers).not.toContain("TERMS_NOT_ACCEPTED");
      expect(await versionCount(active)).toBe(2);
    });

    it("a Promoter's cancellation suspends it, and withdrawal still works afterwards", async () => {
      const s = await scene();
      const active = await activate(await draft(s, usd(5_000)), s.promoter);
      await cycleCall(handleCancelPromotionAuthorizationRequest, s.promoter, s.item, s.authorizationRef, {});
      expect((await commerce(active, "TRANSACTION")).blockers).toContain("AUTHORIZATION_NOT_APPROVED");

      const withdrawn = await withdrawPromotedListing({ listingRef: active.listingRef, actingAccountId: s.promoter.accountId, now: next() }, { db });
      expect(withdrawn.currentVersion.lifecycle).toBe("WITHDRAWN");
      expect(
        await rejection(withdrawPromotedListing({ listingRef: active.listingRef, actingAccountId: s.promoter.accountId, now: next() }, { db })),
      ).toBeInstanceOf(ListingNotWithdrawableError);
      const row = await db.listing.findUniqueOrThrow({ where: { internalListingId: active.record.internalListingId } });
      expect(row.currentPlacementMarker).toBeNull();
    });

    it("binds exactly what governed on a pass, for the later transaction phase", async () => {
      const s = await scene();
      const active = await activate(await draft(s, usd(5_000)), s.promoter);
      await db.storefront.update({ where: { internalStorefrontId: s.shop.id }, data: { lifecycle: "ACTIVE" } });
      const result = await commerce(active, "TRANSACTION");
      /* The Storefront owner here has commerce approval, so it is exposed. */
      expect(result.blockers).toEqual([]);
      expect(result.eligible).toBe(true);
      expect(result.notEvaluated).toEqual(["CROSS_ACCOUNT_ECONOMIC_PRINCIPAL", "TRANSACTION_CONDITIONS"]);
      expect(result.bound).toMatchObject({
        governing: { termsKind: "STANDING", economicsVersion: await standingVersion(s.item) },
        economics: { promoterNetProceedsMinorUnits: 925 },
      });
    });
  });

  describe("closure of the old path and of checkout", () => {
    it("the retired Offer-copying path refuses", async () => {
      const s = await scene();
      const offer = await db.offer.findUniqueOrThrow({ where: { offerRef: s.item.offerRef } });
      const refused = await rejection(
        createPromotedListing(
          {
            storefrontId: s.shop.id,
            internalProductId: s.item.internalProductId,
            controllingParticipantId: s.promoter.participantId,
            retail: usd(5_000),
            acceptedOfferSourceRecordId: offer.offerSourceRecordId,
            acceptedOfferSourceRecordVersion: "1",
            acquisitionPolicy: POLICY,
            actingAccountId: s.promoter.accountId,
            now: next(),
          },
          { db },
        ),
      );
      expect(refused).toBeInstanceOf(PromotedListingPathRetiredError);
      expect(await db.listing.count({ where: { storefrontId: s.shop.id } })).toBe(0);
    });

    it("checkout prices an ACTIVE, fully eligible package-based Listing and binds its authority (Phase 1.46)", async () => {
      const s = await scene();
      const policyId = await configuredPolicy();
      const active = await activate(await draft(s, usd(5_000)), s.promoter);
      const orders = await db.order.count();
      const prepared = await prepareCheckout(
        {
          internalListingId: active.record.internalListingId,
          buyerAccountId: null,
          taxAmountMinorUnits: 0,
          shippingAmountMinorUnits: 0,
          otherPassThroughAmountMinorUnits: 0,
          currency: "USD",
          productAvailability: "available",
          placedAt: next(),
        } as never,
        policyId,
        { db },
      );
      expect(prepared).toMatchObject({
        transactionType: "PROMOTED",
        sellerParticipantId: s.item.seller.participantId,
        promoterParticipantId: s.promoter.participantId,
        promotedBinding: { offerSourceRecordVersion: await standingVersion(s.item) },
      });
      /* Preparation writes nothing. */
      expect(await db.order.count()).toBe(orders);
    });

    it("the schema refuses a legacy binding on a package-based row", async () => {
      const s = await scene();
      const d = await draft(s);
      await expect(
        db.listingSourceRecordVersionRow.updateMany({
          where: { internalListingId: d.record.internalListingId },
          data: { acceptedAt: new Date(NOW) },
        }),
      ).rejects.toThrow();
      await expect(
        db.listingSourceRecordVersionRow.updateMany({
          where: { internalListingId: d.record.internalListingId },
          data: { upstreamReviewState: "NO_UPSTREAM_CHANGE" },
        }),
      ).rejects.toThrow();
    });

    it("resolves no policy from an unset or malformed identity — fail closed", async () => {
      expect(await resolvePromotedListingPolicy(db, {})).toBeNull();
      expect(await resolvePromotedListingPolicy(db, { MONACADO_CHECKOUT_POLICY_ID: "not-a-policy" })).toBeNull();
    });
  });

  describe("routes and privacy", () => {
    const call = (
      handler: (r: never, d: never) => Promise<PromotedListingRouteResult>,
      actor: FixtureActor | null,
      ref: { productRef: string } | { listingRef: string },
      body: unknown,
      origin = ORIGIN,
    ) =>
      handler(
        {
          ...ref,
          contentType: "application/json",
          originHeader: origin,
          cookieHeader: actor?.cookieHeader ?? null,
          rawBody: JSON.stringify(body),
        } as never,
        { db, now: next, appOrigin: ORIGIN } as never,
      );

    it("drafts, prices, activates, and withdraws through the routes, answering references only", async () => {
      const s = await scene();
      const policyId = await configuredPolicy();
      expect(await resolvePromotedListingPolicy(db)).toMatchObject({ policyId, retainedPercentageBasisPoints: 750 });

      const created = await call(handleCreatePromotedListingRequest, s.promoter, { productRef: s.item.productRef }, { storefrontHandle: s.shop.handle });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      expect(Object.keys(created.body).sort()).toEqual(["lifecycle", "listingRef", "retail", "version"]);
      expect(created.body).toMatchObject({ lifecycle: "DRAFT", version: "1", retail: null });
      const listingRef = created.body.listingRef as string;

      const priced = await call(handleSetPromotedListingPriceRequest, s.promoter, { listingRef }, { amount: "40.00", currency: "USD" });
      expect(priced).toMatchObject({ status: 200, body: { version: "2", retail: { amountMinorUnits: 4_000, currency: "USD" } } });

      const negative = await call(handleSetPromotedListingPriceRequest, s.promoter, { listingRef }, { amount: "39.99", currency: "USD" });
      expect(negative).toMatchObject({ status: 409, body: { error: CODES.economicsRefused, reason: "NEGATIVE_PROMOTER_PROCEEDS" } });
      /* No wholesale, commission, Seller, or proceeds figure in a refusal. */
      expect(Object.keys(negative.body).sort()).toEqual(["error", "reason"]);

      const activated = await call(handleActivatePromotedListingRequest, s.promoter, { listingRef }, { expectedVersion: "2" });
      expect(activated).toMatchObject({ status: 200, body: { lifecycle: "ACTIVE", version: "3" } });

      const withdrawn = await call(handleWithdrawPromotedListingRequest, s.promoter, { listingRef }, {});
      expect(withdrawn).toMatchObject({ status: 200, body: { lifecycle: "WITHDRAWN", version: "4" } });

      for (const r of [created, priced, negative, activated, withdrawn]) {
        const json = JSON.stringify(r.body);
        expect(json).not.toMatch(/mon:[a-z]+:/);
        expect(json).not.toContain(s.promoter.participantId);
        expect(json).not.toContain(s.item.seller.participantId);
        expect(findParticipantPrivacyViolations(r.body)).toEqual([]);
      }
    });

    it("fails closed through the routes when no commercial policy is configured", async () => {
      const s = await scene();
      const created = await call(handleCreatePromotedListingRequest, s.promoter, { productRef: s.item.productRef }, { storefrontHandle: s.shop.handle });
      const listingRef = created.body.listingRef as string;
      expect(await call(handleSetPromotedListingPriceRequest, s.promoter, { listingRef }, { amount: "50.00", currency: "USD" })).toMatchObject({
        status: 409,
        body: { error: CODES.economicsRefused, reason: "NO_EFFECTIVE_COMMERCIAL_POLICY" },
      });
      expect(await call(handleActivatePromotedListingRequest, s.promoter, { listingRef }, { expectedVersion: "1" })).toMatchObject({
        status: 409,
        body: { error: CODES.notReady, blockers: ["RETAIL_PRICE_MISSING"] },
      });
    });

    it("refuses a stranger, a forged body, a foreign origin, and no session — each bounded", async () => {
      const s = await scene();
      const d = await draft(s, usd(5_000));
      const stranger = await fx.readyParticipant(["PROMOTER"]);
      expect(await call(handleSetPromotedListingPriceRequest, stranger, { listingRef: d.listingRef }, { amount: "60.00", currency: "USD" })).toMatchObject({
        status: 404,
        body: { error: CODES.listingNotAvailable },
      });
      expect(
        await call(handleCreatePromotedListingRequest, s.promoter, { productRef: s.item.productRef }, { storefrontHandle: s.shop.handle, offerRef: s.item.offerRef }),
      ).toMatchObject({ status: 400, body: { error: CODES.invalidRequest } });
      expect(
        await call(handleActivatePromotedListingRequest, s.promoter, { listingRef: d.listingRef }, { expectedVersion: "1", lifecycle: "ACTIVE" }),
      ).toMatchObject({ status: 400 });
      expect(await call(handleWithdrawPromotedListingRequest, s.promoter, { listingRef: d.listingRef }, {}, "https://evil.test")).toMatchObject({
        status: 403,
        body: { error: CODES.crossOrigin },
      });
      expect(await call(handleWithdrawPromotedListingRequest, null, { listingRef: d.listingRef }, {})).toMatchObject({
        status: 401,
        body: { error: CODES.unauthenticated },
      });
      expect(await call(handleActivatePromotedListingRequest, s.promoter, { listingRef: d.listingRef }, { expectedVersion: "7" })).toMatchObject({
        status: 409,
        body: { error: CODES.versionStale },
      });
      expect(await versionCount(d)).toBe(1);
    });

    it("the Promoter's own view carries no internal id, Seller identity, or authorization", async () => {
      const s = await scene();
      await draft(s, usd(5_000));
      const views = await db.$transaction((tx) =>
        readPromoterListingsForProductIn(tx, {
          internalProductId: s.item.internalProductId,
          promoterParticipantId: s.promoter.participantId,
          at: next(),
          policy: POLICY,
        }),
      );
      expect(views).toHaveLength(1);
      expect(views[0]).toMatchObject({ lifecycle: "DRAFT", storefrontHandle: s.shop.handle, blockers: [] });
      const json = JSON.stringify(views);
      expect(json).not.toMatch(/mon:[a-z]+:/);
      expect(json).not.toContain(s.item.seller.participantId);
      expect(json).not.toContain(s.authorizationRef);
      expect(json).not.toMatch(/participantId|accountId|authorizationId|acceptance/);
    });
  });
});
