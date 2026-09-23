/**
 * Phase 1.36 — seller-direct retail pricing on an existing private DRAFT
 * placement.
 *
 * Phase 1.34 gave a Seller a placement with no price, deliberately: a Listing is
 * placement and an Offer is commercial terms, and putting an item on a shelf
 * does not require having decided what to charge for it. Phase 1.35 made that
 * placement nameable and removable. This suite proves the sentence a Seller
 * still could not say about one:
 *
 * > "This Product is offered in this Storefront at this retail price."
 *
 * **The version chain is the substance.** Pricing is an ordinary material
 * change: it mints the next immutable source version, moves the pointer, and
 * leaves every earlier version exactly as it was. Version 1 stays unpriced
 * forever; version 2 holds $19.99; version 3 holds $24.50; and `listingRef`
 * names the same aggregate throughout, because it names the placement rather
 * than a version of it.
 *
 * **The boundaries are the rest.** A price is a commercial fact of the
 * *placement*, so the Product and the Storefront must come out byte-identical;
 * no Offer, no commission, no MoR economics, and no order state may appear; the
 * placement must stay `DRAFT`, unlisted, and unpurchasable; and the money that
 * reaches the column must be the exact minor-unit value of what the person
 * typed, never a float's opinion of it.
 *
 * **The non-disclosure is inherited from withdrawal and matters more here.** A
 * reference naming nothing and a real placement belonging to someone else are
 * one answer — otherwise this route becomes a price list for a competitor's
 * private shelf, assembled one 404 at a time.
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * NO NETWORK. Instants are injected; every value is synthetic. Cleanup is
 * SCOPED to this suite's own `p136` prefix.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createAccountSession } from "../src/server/account/account-session-service";
import { SESSION_COOKIE_NAME } from "../src/server/account/session-cookie";
import { readAccountHome } from "../src/server/account/account-home";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import { createDraftStorefront } from "../src/server/marketplace/storefront-service";
import { resolveActingAccount } from "../src/server/account/acting-participant-boundary";
import { createDraftProductAs } from "../src/server/marketplace/marketplace-application-service";
import { createDraftOffer } from "../src/server/marketplace/offer-service";
import {
  createPromotedListing,
  evaluateBuyerEligibility,
  getEffectivePrice,
} from "../src/server/marketplace/listing-service";
import {
  LISTING_PLACEMENT_ROUTE_ERROR_CODES as PLACE_CODES,
  handleCreateListingPlacementRequest,
} from "../src/server/marketplace/listing-placement-route-handler";
import {
  LISTING_PRICE_ROUTE_ERROR_CODES as CODES,
  handleSetListingPriceRequest,
} from "../src/server/marketplace/listing-price-route-handler";
import {
  LISTING_WITHDRAWAL_ROUTE_ERROR_CODES as WITHDRAW_CODES,
  handleWithdrawListingRequest,
} from "../src/server/marketplace/listing-withdrawal-route-handler";
import { CURRENT_PLACEMENT_MARKER } from "../src/server/marketplace/listing-mapper";
import { readListingCheckoutView } from "../src/server/payments/listing-checkout-view";
import type { MarketplaceRole } from "../src/contracts/marketplace/participant";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const NOW = "2029-02-01T09:00:00.000Z";
const EMAIL_PREFIX = "p136";
const ORIGIN = "https://monacado.test";
const PASSWORD = "correct-horse-battery-staple-1136";

const ACQUISITION_POLICY = {
  policyId: "mon:policy:acquisition/synthetic",
  policyVersion: "1",
  currency: "USD",
  retainedPercentageBasisPoints: 750,
  retainedFixedAmountMinorUnits: 100,
  roundingPolicy: "HALF_UP_TO_MINOR_UNIT" as const,
};

let seq = 0;

async function cleanup(): Promise<void> {
  const accountIds = (
    await db.account.findMany({
      where: { email: { startsWith: EMAIL_PREFIX } },
      select: { id: true },
    })
  ).map((a) => a.id);
  if (accountIds.length === 0) return;
  const participantIds = (
    await db.marketplaceParticipant.findMany({
      where: { accountId: { in: accountIds } },
      select: { id: true },
    })
  ).map((p) => p.id);

  await db.listingSourceRecordVersionRow.deleteMany({
    where: { controllingParticipantId: { in: participantIds } },
  });
  await db.listing.deleteMany({ where: { controllingParticipantId: { in: participantIds } } });
  await db.offerSourceRecordVersionRow.deleteMany({
    where: { sellerParticipantId: { in: participantIds } },
  });
  await db.offer.deleteMany({ where: { sellerParticipantId: { in: participantIds } } });
  const productIds = (
    await db.productSourceRecordVersionRow.findMany({
      where: { authorityCreatorParticipantId: { in: participantIds } },
      select: { internalProductId: true },
    })
  ).map((v) => v.internalProductId);
  await db.productSourceRecordVersionRow.deleteMany({
    where: { internalProductId: { in: productIds } },
  });
  await db.product.deleteMany({ where: { internalProductId: { in: productIds } } });
  await db.storefrontGovernanceAssignment.deleteMany({
    where: { participantId: { in: participantIds } },
  });
  await db.storefrontSourceRecordVersionRow.deleteMany({
    where: { ownerParticipantId: { in: participantIds } },
  });
  await db.storefront.deleteMany({ where: { ownerParticipantId: { in: participantIds } } });
  await db.marketplaceRoleAssignment.deleteMany({
    where: { participantId: { in: participantIds } },
  });
  await db.marketplaceParticipant.deleteMany({ where: { id: { in: participantIds } } });
  await db.accountSession.deleteMany({ where: { accountId: { in: accountIds } } });
  await db.account.deleteMany({ where: { id: { in: accountIds } } });
}

async function signIn(roles: MarketplaceRole[] | null) {
  seq += 1;
  const account = await createAccount(
    {
      name: "Maker",
      email: `${EMAIL_PREFIX}${seq}@example.com`,
      password: PASSWORD,
      createdAt: NOW,
    },
    { db },
  );
  const participant =
    roles === null
      ? null
      : await createDraftParticipant(
          { accountId: account.accountId, initialRoles: roles, now: NOW },
          { db },
        );
  const { token } = await createAccountSession(
    { accountId: account.accountId, createdAt: NOW, ttlSeconds: 7 * 24 * 3_600 },
    { db },
  );
  const cookieHeader = `${SESSION_COOKIE_NAME}=${token}`;
  const resolution = await resolveActingAccount({ cookieHeader, now: NOW }, { db });
  if (resolution.outcome !== "AUTHENTICATED") throw new Error("unreachable");
  return {
    accountId: account.accountId,
    participantId: participant?.participant.participantId ?? null,
    actor: resolution.actor,
    cookieHeader,
  };
}
type Seller = Awaited<ReturnType<typeof signIn>>;

async function seedProduct(seller: Seller, name?: string): Promise<string> {
  seq += 1;
  const created = await createDraftProductAs(
    seller.actor,
    {
      name: name ?? `Widget ${seq}`,
      description: null,
      promotable: true,
      generalAvailabilityState: "available",
      deliveryMode: "DIGITAL",
    },
    { db, now: NOW },
  );
  return created.productRef;
}

async function seedStorefront(seller: Seller): Promise<string> {
  seq += 1;
  const publicHandle = `p136-shop-${seq}`;
  await createDraftStorefront(
    {
      ownerParticipantId: seller.participantId!,
      publicHandle,
      presentation: { displayName: `Shop ${seq}`, tagline: null, summary: null },
      actingAccountId: seller.accountId,
      now: NOW,
    },
    { db },
  );
  return publicHandle;
}

const place = (cookieHeader: string | null, body: unknown) =>
  handleCreateListingPlacementRequest(
    {
      contentType: "application/json",
      originHeader: ORIGIN,
      cookieHeader,
      rawBody: JSON.stringify(body),
    },
    { db, now: () => NOW, appOrigin: ORIGIN },
  );

const setPrice = (
  cookieHeader: string | null,
  listingRef: string,
  body: unknown,
  overrides: { originHeader?: string | null; contentType?: string | null; rawBody?: string } = {},
) =>
  handleSetListingPriceRequest(
    {
      listingRef,
      contentType: overrides.contentType === undefined ? "application/json" : overrides.contentType,
      originHeader: overrides.originHeader === undefined ? ORIGIN : overrides.originHeader,
      cookieHeader,
      rawBody: overrides.rawBody ?? JSON.stringify(body),
    },
    { db, now: () => NOW, appOrigin: ORIGIN },
  );

const usd = (amount: string) => ({ amount, currency: "USD" });

/** A Seller holding one unpriced draft placement in one of their Storefronts. */
async function seedPlacement() {
  const seller = await signIn(["SELLER"]);
  const productRef = await seedProduct(seller);
  const storefrontHandle = await seedStorefront(seller);
  const created = await place(seller.cookieHeader, { productRef, storefrontHandle });
  const listingRef = (created.body as { listingRef: string }).listingRef;
  const listing = await db.listing.findFirstOrThrow({ where: { listingRef } });
  return { seller, productRef, storefrontHandle, listingRef, listing };
}

const versionsOf = (internalListingId: string) =>
  db.listingSourceRecordVersionRow.findMany({
    where: { internalListingId },
    orderBy: { seq: "asc" },
  });

describe.skipIf(!RUN)("Phase 1.36 — pricing a private DRAFT placement", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  // — The immutable version chain —

  it("1. prices an unpriced draft: version 2 holds it, version 1 is untouched", async () => {
    const { seller, listingRef, listing } = await seedPlacement();
    const before = await versionsOf(listing.internalListingId);
    expect(before).toHaveLength(1);
    expect(before[0]!.retailPriceMinorUnits).toBeNull();
    expect(before[0]!.retailPriceCurrency).toBeNull();

    const result = await setPrice(seller.cookieHeader, listingRef, usd("19.99"));

    expect(result.status).toBe(200);
    expect(result.body).toEqual({
      listingRef,
      lifecycle: "DRAFT",
      listed: false,
      retail: { amountMinorUnits: 1999, currency: "USD" },
    });
    /* No internal identity, no Product, no Storefront, no Offer, no economics. */
    expect(JSON.stringify(result.body)).not.toMatch(/mon:|an:/);
    expect(JSON.stringify(result.body)).not.toMatch(/offer|commission|acquisition|wholesale/i);

    const after = await versionsOf(listing.internalListingId);
    expect(after).toHaveLength(2);
    expect(after.map((v) => v.sourceRecordVersion)).toEqual(["1", "2"]);
    /* Version 1 is immutable, and still records the unpriced truth. */
    expect(after[0]).toEqual(before[0]);
    expect(after[1]!.supersedesSourceRecordVersion).toBe("1");
    expect(after[1]!.retailPriceMinorUnits).toBe(1999n);
    expect(after[1]!.retailPriceCurrency).toBe("USD");
    /* And the pointer moved with it, in the same transaction. */
    const stable = await db.listing.findUniqueOrThrow({
      where: { internalListingId: listing.internalListingId },
    });
    expect(stable.currentSourceRecordVersion).toBe("2");
  });

  it("2. changes the price: version 3 holds the new one, version 2 is untouched", async () => {
    const { seller, listingRef, listing } = await seedPlacement();
    await setPrice(seller.cookieHeader, listingRef, usd("19.99"));
    const afterFirst = await versionsOf(listing.internalListingId);

    const result = await setPrice(seller.cookieHeader, listingRef, usd("24.50"));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      lifecycle: "DRAFT",
      listed: false,
      retail: { amountMinorUnits: 2450, currency: "USD" },
    });

    const versions = await versionsOf(listing.internalListingId);
    expect(versions).toHaveLength(3);
    expect(versions.map((v) => v.sourceRecordVersion)).toEqual(["1", "2", "3"]);
    /* Both earlier versions are byte-identical to what they were. */
    expect(versions[0]).toEqual(afterFirst[0]);
    expect(versions[1]).toEqual(afterFirst[1]);
    expect(versions[1]!.retailPriceMinorUnits).toBe(1999n);
    expect(versions[2]!.supersedesSourceRecordVersion).toBe("2");
    expect(versions[2]!.retailPriceMinorUnits).toBe(2450n);
    expect(versions[2]!.lifecycle).toBe("DRAFT");

    const stable = await db.listing.findUniqueOrThrow({
      where: { internalListingId: listing.internalListingId },
    });
    expect(stable.currentSourceRecordVersion).toBe("3");
  });

  it("3. keeps listingRef, the aggregate, and the placement marker stable throughout", async () => {
    const { seller, listingRef, listing } = await seedPlacement();
    await setPrice(seller.cookieHeader, listingRef, usd("19.99"));
    await setPrice(seller.cookieHeader, listingRef, usd("24.50"));

    /* One aggregate, three versions, one reference — the reference names the
       placement rather than a version of it, so a link somebody kept before the
       first price still names the same placement after the second. */
    expect(
      await db.listing.count({ where: { internalListingId: listing.internalListingId } }),
    ).toBe(1);
    const stable = await db.listing.findUniqueOrThrow({
      where: { internalListingId: listing.internalListingId },
    });
    expect(stable.listingRef).toBe(listingRef);
    expect(stable.listingSourceRecordId).toBe(listing.listingSourceRecordId);
    expect(stable.lifecycle).toBe("DRAFT");
    expect(stable.listingType).toBe("SELLER_DIRECT");
    /* Still CURRENT: pricing releases nothing, and the pair is still held. */
    expect(stable.currentPlacementMarker).toBe(CURRENT_PLACEMENT_MARKER);
  });

  it("4. persists exactly the minor-unit amount, and leaves every other money column NULL", async () => {
    const { seller, listingRef, listing } = await seedPlacement();
    await setPrice(seller.cookieHeader, listingRef, usd("19.99"));

    const current = (await versionsOf(listing.internalListingId))[1]!;
    expect(current.retailPriceMinorUnits).toBe(1999n);
    expect(current.retailPriceCurrency).toBe("USD");
    /* The sale overlay is untouched — pricing is not scheduling a sale. */
    expect(current.salePriceMinorUnits).toBeNull();
    expect(current.salePriceCurrency).toBeNull();
    expect(current.saleStartsAt).toBeNull();
    expect(current.saleEndsAt).toBeNull();
    /* And every accepted-Offer column stays NULL. A retail price existing is not
       an Offer existing, and nothing may populate one because one now does. */
    expect(current.acceptedInternalOfferId).toBeNull();
    expect(current.acceptedOfferSourceRecordId).toBeNull();
    expect(current.acceptedOfferSourceRecordVersion).toBeNull();
    expect(current.acceptedWholesalePriceMinorUnits).toBeNull();
    expect(current.acceptedWholesalePriceCurrency).toBeNull();
    expect(current.acceptedCommissionCalculationPolicyVersion).toBeNull();
    expect(current.acceptedAt).toBeNull();
    expect(current.upstreamReviewState).toBeNull();
    /* Authorization is traced to the controller and the acting account. */
    expect(current.authorizedByParticipantId).toBe(seller.participantId);
    expect(current.authorizedByActorId).toBe(seller.accountId);
  });

  it("5. converts a decimal exactly, where floating-point multiplication would not", async () => {
    /* `Number("19.99") * 100` is 1998.9999999999998. The conversion is string
       surgery over a fixed exponent, so the column holds the cent the seller
       typed rather than a rounded approximation of it. */
    for (const [typed, minorUnits] of [
      ["19.99", 1999n],
      ["19", 1900n],
      ["19.9", 1990n],
      ["0.01", 1n],
      ["1234.56", 123456n],
    ] as const) {
      const { seller, listingRef, listing } = await seedPlacement();
      const result = await setPrice(seller.cookieHeader, listingRef, usd(typed));
      expect(result.status).toBe(200);
      const current = (await versionsOf(listing.internalListingId))[1]!;
      expect(current.retailPriceMinorUnits).toBe(minorUnits);
    }
  });

  // — The no-op —

  it("6. refuses a repeat of the current price, and mints nothing", async () => {
    const { seller, listingRef, listing } = await seedPlacement();
    await setPrice(seller.cookieHeader, listingRef, usd("19.99"));
    await setPrice(seller.cookieHeader, listingRef, usd("24.50"));
    const before = await versionsOf(listing.internalListingId);
    expect(before).toHaveLength(3);

    const repeat = await setPrice(seller.cookieHeader, listingRef, usd("24.50"));
    expect(repeat).toMatchObject({ status: 409, body: { error: CODES.priceUnchanged } });
    /* Not a success that did nothing: a version asserting a change that did not
       happen is a lie in an immutable record. */
    expect(await versionsOf(listing.internalListingId)).toEqual(before);
    expect(
      (
        await db.listing.findUniqueOrThrow({
          where: { internalListingId: listing.internalListingId },
        })
      ).currentSourceRecordVersion,
    ).toBe("3");

    /* And a differently-spelled identical amount is the same answer — the
       comparison is on the converted minor units, not on the string. */
    expect(await setPrice(seller.cookieHeader, listingRef, usd("24.5"))).toMatchObject({
      status: 409,
      body: { error: CODES.priceUnchanged },
    });
    expect(await versionsOf(listing.internalListingId)).toEqual(before);
  });

  // — Amount and currency refusals —

  it("7. refuses zero, a negative amount, over-precision, and malformed input", async () => {
    const { seller, listingRef, listing } = await seedPlacement();

    for (const amount of [
      "0",
      "0.00",
      "-1.00",
      "-0.01",
      "19.999",
      "0.001",
      "abc",
      "",
      " ",
      "$19.99",
      "1,999.00",
      "19.",
      ".99",
      "1e2",
      "+19.99",
      "019.99",
      "NaN",
      "Infinity",
    ]) {
      const result = await setPrice(seller.cookieHeader, listingRef, { amount, currency: "USD" });
      expect([400]).toContain(result.status);
      expect([CODES.invalidAmount, CODES.invalidRequest]).toContain(
        (result.body as { error: string }).error,
      );
    }

    /* None of them minted anything, and none of them priced the placement. */
    const versions = await versionsOf(listing.internalListingId);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.retailPriceMinorUnits).toBeNull();
  });

  it("8. refuses an unsupported currency rather than guessing its minor unit", async () => {
    const { seller, listingRef, listing } = await seedPlacement();
    for (const currency of ["EUR", "GBP", "JPY", "usd", "US$", ""]) {
      const result = await setPrice(seller.cookieHeader, listingRef, { amount: "19.99", currency });
      expect(result.status).toBe(400);
      expect([CODES.invalidAmount, CODES.invalidRequest]).toContain(
        (result.body as { error: string }).error,
      );
    }
    expect(await versionsOf(listing.internalListingId)).toHaveLength(1);
  });

  it("9. refuses a numeric amount, a missing member, and a body with anything extra", async () => {
    const { seller, listingRef, listing } = await seedPlacement();

    const bodies: unknown[] = [
      /* A JSON number is an IEEE-754 double the moment it is parsed. */
      { amount: 19.99, currency: "USD" },
      { amount: 1999, currency: "USD" },
      /* A currency is a commercial claim, never supplied on the caller's behalf. */
      { amount: "19.99" },
      { currency: "USD" },
      {},
      null,
      [],
      "19.99",
      /* And every identity or authority field a caller might try to smuggle in. */
      { amount: "19.99", currency: "USD", listingRef: "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ" },
      { amount: "19.99", currency: "USD", internalListingId: "mon:listing:anything" },
      { amount: "19.99", currency: "USD", listingSourceRecordId: "mon:srec:anything" },
      { amount: "19.99", currency: "USD", sourceRecordVersion: "9" },
      { amount: "19.99", currency: "USD", lifecycle: "ACTIVE" },
      { amount: "19.99", currency: "USD", listed: true },
      { amount: "19.99", currency: "USD", controllingParticipantId: "mon:participant:anything" },
      { amount: "19.99", currency: "USD", actingAccountId: "mon:acct:somebody-else" },
      { amount: "19.99", currency: "USD", productRef: "0123456789ABCDEFGHJKMNPQRSTVWXYZ" },
      { amount: "19.99", currency: "USD", storefrontHandle: "somebody-elses-shop" },
      { amount: "19.99", currency: "USD", retail: { retailPriceMinorUnits: 1 } },
      { amount: "19.99", currency: "USD", sale: { salePriceMinorUnits: 1 } },
      { amount: "19.99", currency: "USD", acceptedOfferSourceRecordVersion: "1" },
      { amount: "19.99", currency: "USD", acquisitionPolicy: ACQUISITION_POLICY },
      { amount: "19.99", currency: "USD", taxAmountMinorUnits: 100 },
      { amount: "19.99", currency: "USD", shippingAmountMinorUnits: 100 },
    ];
    for (const body of bodies) {
      expect(await setPrice(seller.cookieHeader, listingRef, body)).toMatchObject({
        status: 400,
        body: { error: CODES.invalidRequest },
      });
    }

    /* A non-JSON content type and an unparseable body, on the same code. */
    expect(
      await setPrice(seller.cookieHeader, listingRef, null, {
        contentType: "text/plain",
        rawBody: '{"amount":"19.99","currency":"USD"}',
      }),
    ).toMatchObject({ status: 400, body: { error: CODES.invalidRequest } });
    expect(
      await setPrice(seller.cookieHeader, listingRef, null, { rawBody: "{not json" }),
    ).toMatchObject({ status: 400, body: { error: CODES.invalidRequest } });

    expect(await versionsOf(listing.internalListingId)).toHaveLength(1);
  });

  // — Non-disclosure —

  it("10. answers the same for an unknown reference and another Seller's placement", async () => {
    const { seller, listingRef, listing } = await seedPlacement();
    await setPrice(seller.cookieHeader, listingRef, usd("19.99"));
    const stranger = await signIn(["SELLER"]);

    const answers = await Promise.all([
      /* A well-formed reference that names nothing. */
      setPrice(stranger.cookieHeader, "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", usd("1.00")),
      /* A real, PRICED placement belonging to somebody else. */
      setPrice(stranger.cookieHeader, listingRef, usd("1.00")),
      /* And one priced at exactly what it is already priced at — which must not
         become an oracle for the price either. */
      setPrice(stranger.cookieHeader, listingRef, usd("19.99")),
      /* A path segment that could never be a reference. */
      setPrice(stranger.cookieHeader, "not-a-reference", usd("1.00")),
      setPrice(stranger.cookieHeader, "", usd("1.00")),
    ]);

    for (const answer of answers) {
      expect(answer).toEqual({
        status: 404,
        body: { error: CODES.notAvailable },
        headers: answer.headers,
      });
    }
    /* The real placement is untouched: still $19.99, still DRAFT, still two
       versions. */
    const versions = await versionsOf(listing.internalListingId);
    expect(versions).toHaveLength(2);
    expect(versions[1]!.retailPriceMinorUnits).toBe(1999n);
    expect(seller.participantId).not.toBe(stranger.participantId);
  });

  it("11. refuses a PROMOTER-only caller, a participant-less account, and a suspended one", async () => {
    const { seller, listingRef, listing } = await seedPlacement();

    /* A promoter-only participant controls nothing here, so they get the
       non-disclosing answer rather than a hint that the reference is real. */
    const promoter = await signIn(["PROMOTER"]);
    expect(await setPrice(promoter.cookieHeader, listingRef, usd("19.99"))).toMatchObject({
      status: 404,
      body: { error: CODES.notAvailable },
    });

    /* No participant at all — there is no identity to control anything. */
    const bare = await signIn(null);
    expect(await setPrice(bare.cookieHeader, listingRef, usd("19.99"))).toMatchObject({
      status: 403,
      body: { error: CODES.notEligible },
    });

    /* A suspended participant may not author marketplace state. */
    await db.marketplaceParticipant.update({
      where: { id: seller.participantId! },
      data: { status: "SUSPENDED" },
    });
    expect(await setPrice(seller.cookieHeader, listingRef, usd("19.99"))).toMatchObject({
      status: 403,
      body: { error: CODES.notEligible },
    });

    /* And a closed one. */
    await db.marketplaceParticipant.update({
      where: { id: seller.participantId! },
      data: { status: "CLOSED" },
    });
    expect(await setPrice(seller.cookieHeader, listingRef, usd("19.99"))).toMatchObject({
      status: 403,
      body: { error: CODES.notEligible },
    });

    const versions = await versionsOf(listing.internalListingId);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.retailPriceMinorUnits).toBeNull();
  });

  it("12. refuses a signed-out caller and a foreign origin", async () => {
    const { listingRef, listing } = await seedPlacement();

    expect(await setPrice(null, listingRef, usd("19.99"))).toMatchObject({
      status: 401,
      body: { error: CODES.unauthenticated },
    });
    /* Origin is checked before the session, so a cross-site post never reaches
       the cookie, the reference, or the amount. */
    const seller = await signIn(["SELLER"]);
    expect(
      await setPrice(seller.cookieHeader, listingRef, usd("19.99"), {
        originHeader: "https://evil.example",
      }),
    ).toMatchObject({ status: 403, body: { error: CODES.crossOrigin } });

    const versions = await versionsOf(listing.internalListingId);
    expect(versions).toHaveLength(1);
    expect(versions[0]!.retailPriceMinorUnits).toBeNull();
  });

  // — Seller-direct DRAFT only —

  it("13. refuses an ACTIVE placement, and a WITHDRAWN one", async () => {
    const active = await seedPlacement();
    /* Fixture only: the state a governed activation would leave. Activation
       itself is not exposed by this phase. */
    await db.listing.update({
      where: { internalListingId: active.listing.internalListingId },
      data: { lifecycle: "ACTIVE" },
    });
    expect(
      await setPrice(active.seller.cookieHeader, active.listingRef, usd("19.99")),
    ).toMatchObject({ status: 409, body: { error: CODES.notRepriceable } });
    expect(await versionsOf(active.listing.internalListingId)).toHaveLength(1);

    /* Terminal, and released. A price on a shelf position that no longer exists
       asserts a commercial term for nothing. */
    const withdrawn = await seedPlacement();
    const gone = await handleWithdrawListingRequest(
      { listingRef: withdrawn.listingRef, originHeader: ORIGIN, cookieHeader: withdrawn.seller.cookieHeader },
      { db, now: () => NOW, appOrigin: ORIGIN },
    );
    expect(gone).toMatchObject({ status: 200 });
    expect(
      await setPrice(withdrawn.seller.cookieHeader, withdrawn.listingRef, usd("19.99")),
    ).toMatchObject({ status: 409, body: { error: CODES.notRepriceable } });
    expect(await versionsOf(withdrawn.listing.internalListingId)).toHaveLength(2);
  });

  it("14. refuses a PROMOTED placement, whose retail is governed by its accepted Offer", async () => {
    /* A promoted Listing's retail price is checked against the exact accepted
       Offer version's wholesale economics, and against the non-negative-proceeds
       rule that runs on it. An independently editable promoted retail would be a
       second place those economics could move, outside the check — and promoted
       self-service does not exist at all until anti-self-promotion and governed
       economic-principal resolution do. */
    const sellerOfRecord = await signIn(["SELLER"]);
    const promoter = await signIn(["SELLER", "PROMOTER"]);
    const productRef = await seedProduct(sellerOfRecord);
    const product = await db.product.findFirstOrThrow({ where: { productRef } });
    const storefrontHandle = await seedStorefront(promoter);
    const storefront = await db.storefront.findUniqueOrThrow({
      where: { publicHandle: storefrontHandle },
    });
    const offer = await createDraftOffer(
      {
        internalProductId: product.internalProductId,
        sellerParticipantId: sellerOfRecord.participantId!,
        terms: {
          price: { type: "PAID", wholesalePriceMinorUnits: 5_000, wholesalePriceCurrency: "USD" },
          promotion: {
            type: "PROMOTABLE",
            commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2_000 },
          },
        },
        actingAccountId: sellerOfRecord.accountId,
        now: NOW,
      },
      { db },
    );
    const promoted = await createPromotedListing(
      {
        storefrontId: storefront.internalStorefrontId,
        internalProductId: product.internalProductId,
        controllingParticipantId: promoter.participantId!,
        retail: { retailPriceMinorUnits: 12_500, retailPriceCurrency: "USD" },
        acceptedOfferSourceRecordId: offer.record.offerSourceRecordId,
        acceptedOfferSourceRecordVersion: "1",
        acquisitionPolicy: ACQUISITION_POLICY,
        actingAccountId: promoter.accountId,
        now: NOW,
      },
      { db },
    );

    expect(await setPrice(promoter.cookieHeader, promoted.listingRef, usd("99.00"))).toMatchObject({
      status: 409,
      body: { error: CODES.notRepriceable },
    });
    const versions = await versionsOf(promoted.record.internalListingId);
    expect(versions).toHaveLength(1);
    /* The promoter's accepted price is exactly as it was. */
    expect(versions[0]!.retailPriceMinorUnits).toBe(12_500n);
    expect(versions[0]!.acceptedOfferSourceRecordVersion).toBe("1");
  });

  // — Nothing else moved —

  it("15. leaves the Product and the Storefront byte-identical", async () => {
    const { seller, productRef, storefrontHandle, listingRef } = await seedPlacement();
    const productBefore = await db.product.findFirstOrThrow({ where: { productRef } });
    const productVersionsBefore = await db.productSourceRecordVersionRow.findMany({
      where: { internalProductId: productBefore.internalProductId },
      orderBy: { seq: "asc" },
    });
    const storeBefore = await db.storefront.findUniqueOrThrow({
      where: { publicHandle: storefrontHandle },
    });
    const storeVersionsBefore = await db.storefrontSourceRecordVersionRow.findMany({
      where: { internalStorefrontId: storeBefore.internalStorefrontId },
      orderBy: { seq: "asc" },
    });
    const govBefore = await db.storefrontGovernanceAssignment.findMany({
      where: { internalStorefrontId: storeBefore.internalStorefrontId },
      orderBy: { id: "asc" },
    });

    await setPrice(seller.cookieHeader, listingRef, usd("19.99"));
    await setPrice(seller.cookieHeader, listingRef, usd("24.50"));

    /* A price is a commercial fact of the PLACEMENT. The Product keeps its
       facts, its version pointer, and its `promotable` statement; the Storefront
       keeps its lifecycle, visibility, and governance. Neither has a price. */
    expect(await db.product.findFirstOrThrow({ where: { productRef } })).toEqual(productBefore);
    expect(
      await db.productSourceRecordVersionRow.findMany({
        where: { internalProductId: productBefore.internalProductId },
        orderBy: { seq: "asc" },
      }),
    ).toEqual(productVersionsBefore);
    expect(
      await db.storefront.findUniqueOrThrow({ where: { publicHandle: storefrontHandle } }),
    ).toEqual(storeBefore);
    expect(
      await db.storefrontSourceRecordVersionRow.findMany({
        where: { internalStorefrontId: storeBefore.internalStorefrontId },
        orderBy: { seq: "asc" },
      }),
    ).toEqual(storeVersionsBefore);
    expect(
      await db.storefrontGovernanceAssignment.findMany({
        where: { internalStorefrontId: storeBefore.internalStorefrontId },
        orderBy: { id: "asc" },
      }),
    ).toEqual(govBefore);
  });

  it("16. creates no Offer, commission, economics, Node, publication, or order state", async () => {
    const { seller, productRef, listingRef } = await seedPlacement();
    await setPrice(seller.cookieHeader, listingRef, usd("19.99"));

    const product = await db.product.findFirstOrThrow({ where: { productRef } });
    const internalProductId = product.internalProductId;
    expect(await db.offer.count({ where: { internalProductId } })).toBe(0);
    expect(await db.offerSourceRecordVersionRow.count({ where: { internalProductId } })).toBe(0);
    expect(await db.order.count({ where: { internalProductId } })).toBe(0);
    expect(await db.productNode.count({ where: { internalProductId } })).toBe(0);
    expect(await db.productPublication.count({ where: { internalProductId } })).toBe(0);
    expect(await db.publicationOutbox.count()).toBe(0);
    /* And nothing went live. A priced draft consumes no active capacity, because
       it is not active. */
    expect(
      await db.listing.count({
        where: { controllingParticipantId: seller.participantId!, lifecycle: "ACTIVE" },
      }),
    ).toBe(0);
  });

  // — Still not for sale —

  it("17. does not make the placement purchasable merely because it has a price", async () => {
    const { seller, listingRef, listing } = await seedPlacement();
    await setPrice(seller.cookieHeader, listingRef, usd("19.99"));

    /* The derived effective price now answers — that is what a price is for. */
    const effective = await getEffectivePrice(listing.internalListingId, NOW, { db });
    expect(effective).toEqual({
      effectivePriceMinorUnits: 1999,
      currency: "USD",
      saleActive: false,
    });

    /* And buyer eligibility still refuses, starting with the lifecycle. A price
       is a commercial term, not a publication or an activation. */
    const eligibility = await evaluateBuyerEligibility(
      listing.internalListingId,
      { productAvailability: "available" },
      { db },
    );
    expect(eligibility.buyerActive).toBe(false);
    expect(eligibility.blockingReasons).toContain("LISTING_NOT_ACTIVE");

    /* The buyer-facing view shows no price and no button, and creates no Order. */
    const view = await readListingCheckoutView(
      { internalListingId: listing.internalListingId, policyId: "mon:policy:absent", now: NOW },
      { db },
    );
    expect(view.purchasable).toBe(false);
    expect(view.buyerTotalMinorUnits).toBeNull();
    expect(await db.order.count()).toBe(0);
  });

  it("18. leaves the placement DRAFT, and every other activation gate untouched", async () => {
    const { seller, listingRef, listing } = await seedPlacement();
    await setPrice(seller.cookieHeader, listingRef, usd("19.99"));

    const stable = await db.listing.findUniqueOrThrow({
      where: { internalListingId: listing.internalListingId },
    });
    expect(stable.lifecycle).toBe("DRAFT");
    expect(stable.currentPlacementMarker).toBe(CURRENT_PLACEMENT_MARKER);

    /* Activation is not reachable from this phase at all, in either direction:
       there is no lifecycle parameter on the route and none in the body (test
       9), and the placement's own lifecycle never moved. What changed is only
       that LISTING_COMMERCIAL_TERMS_REQUIRED would no longer be the reason a
       future activation failed — the standing, verification, Product-authority,
       Storefront-authority, and allowance gates all still decide on their own
       terms, and this phase weakened none of them. */
    const versions = await versionsOf(listing.internalListingId);
    expect(versions.map((v) => v.lifecycle)).toEqual(["DRAFT", "DRAFT"]);
  });

  // — What the account page is given —

  it("19. projects the priced placement to the account page, with no internal identifier", async () => {
    const { seller, listingRef } = await seedPlacement();

    const unpriced = await readAccountHome(seller.accountId, { db });
    expect(unpriced!.placements).toHaveLength(1);
    expect(unpriced!.placements[0]!.listingRef).toBe(listingRef);
    /* Unpriced is STATED, not omitted. */
    expect(unpriced!.placements[0]!.retail).toBeNull();

    await setPrice(seller.cookieHeader, listingRef, usd("19.99"));
    const priced = await readAccountHome(seller.accountId, { db });
    expect(priced!.placements[0]).toMatchObject({
      listingRef,
      lifecycle: "DRAFT",
      retail: { amountMinorUnits: 1999, currency: "USD" },
    });

    await setPrice(seller.cookieHeader, listingRef, usd("24.50"));
    const repriced = await readAccountHome(seller.accountId, { db });
    /* Read from the CURRENT source version, so the page shows the price the
       database now holds rather than the first one it ever held. */
    expect(repriced!.placements[0]!.retail).toEqual({ amountMinorUnits: 2450, currency: "USD" });

    /* And no identifier the page must not hold reaches it. */
    expect(JSON.stringify(repriced)).not.toMatch(/mon:|an:node/);
  });

  it("20. keeps both placements' prices separate", async () => {
    /* Two placements of two Products in one Storefront, priced differently. A
       price belongs to a placement, so neither may reach the other. */
    const { seller, storefrontHandle, listingRef } = await seedPlacement();
    const otherProduct = await seedProduct(seller, "Second widget");
    const second = await place(seller.cookieHeader, {
      productRef: otherProduct,
      storefrontHandle,
    });
    const secondRef = (second.body as { listingRef: string }).listingRef;

    await setPrice(seller.cookieHeader, listingRef, usd("19.99"));
    await setPrice(seller.cookieHeader, secondRef, usd("5.00"));

    const home = await readAccountHome(seller.accountId, { db });
    const byRef = new Map(home!.placements.map((p) => [p.listingRef, p.retail]));
    expect(byRef.get(listingRef)).toEqual({ amountMinorUnits: 1999, currency: "USD" });
    expect(byRef.get(secondRef)).toEqual({ amountMinorUnits: 500, currency: "USD" });
  });

  it("21. still lets a priced draft placement be withdrawn, and releases the pair", async () => {
    /* Pricing does not make a placement permanent. Withdrawal still reaches it,
       the pair is still released, and the price stays in the history it was
       recorded in. */
    const { seller, productRef, storefrontHandle, listingRef, listing } = await seedPlacement();
    await setPrice(seller.cookieHeader, listingRef, usd("19.99"));

    const gone = await handleWithdrawListingRequest(
      { listingRef, originHeader: ORIGIN, cookieHeader: seller.cookieHeader },
      { db, now: () => NOW, appOrigin: ORIGIN },
    );
    expect(gone).toMatchObject({
      status: 200,
      body: { listingRef, lifecycle: "WITHDRAWN", listed: false },
    });

    const versions = await versionsOf(listing.internalListingId);
    expect(versions.map((v) => v.sourceRecordVersion)).toEqual(["1", "2", "3"]);
    /* The withdrawal asserts nothing commercial, so the price it inherited is
       carried forward rather than cleared on the way out. */
    expect(versions[2]!.lifecycle).toBe("WITHDRAWN");
    expect(versions[2]!.retailPriceMinorUnits).toBe(1999n);
    expect(
      (
        await db.listing.findUniqueOrThrow({
          where: { internalListingId: listing.internalListingId },
        })
      ).currentPlacementMarker,
    ).toBeNull();

    /* And the pair is genuinely free: a new, unpriced placement may be made. */
    const again = await place(seller.cookieHeader, { productRef, storefrontHandle });
    expect(again.status).toBe(201);
    const replacementRef = (again.body as { listingRef: string }).listingRef;
    expect(replacementRef).not.toBe(listingRef);
    const replacement = await db.listing.findFirstOrThrow({
      where: { listingRef: replacementRef },
    });
    const replacementVersions = await versionsOf(replacement.internalListingId);
    expect(replacementVersions).toHaveLength(1);
    expect(replacementVersions[0]!.retailPriceMinorUnits).toBeNull();
  });

  it("22. prices only the placement it names, even for the same Product elsewhere", async () => {
    /* One Product, two Storefronts. Pricing the placement in one shop says
       nothing about the placement in the other — the price is the placement's,
       not the Product's. */
    const seller = await signIn(["SELLER"]);
    const productRef = await seedProduct(seller);
    const shopA = await seedStorefront(seller);
    const shopB = await seedStorefront(seller);
    const a = await place(seller.cookieHeader, { productRef, storefrontHandle: shopA });
    const b = await place(seller.cookieHeader, { productRef, storefrontHandle: shopB });
    const refA = (a.body as { listingRef: string }).listingRef;
    const refB = (b.body as { listingRef: string }).listingRef;

    await setPrice(seller.cookieHeader, refA, usd("19.99"));

    const listingA = await db.listing.findFirstOrThrow({ where: { listingRef: refA } });
    const listingB = await db.listing.findFirstOrThrow({ where: { listingRef: refB } });
    expect((await versionsOf(listingA.internalListingId))[1]!.retailPriceMinorUnits).toBe(1999n);
    const bVersions = await versionsOf(listingB.internalListingId);
    expect(bVersions).toHaveLength(1);
    expect(bVersions[0]!.retailPriceMinorUnits).toBeNull();

    /* And the placement route still refuses a duplicate of either pair. */
    expect(await place(seller.cookieHeader, { productRef, storefrontHandle: shopA })).toMatchObject(
      { status: 409, body: { error: PLACE_CODES.alreadyExists } },
    );
  });

  it("23. never becomes an oracle, whatever the refusal", async () => {
    /* One table, read once: for a caller who controls nothing, the answer must
       not depend on anything about the placement. */
    const { seller, listingRef } = await seedPlacement();
    await setPrice(seller.cookieHeader, listingRef, usd("19.99"));

    const unpriced = await seedPlacement();
    const promoterOnly = await signIn(["PROMOTER"]);
    const stranger = await signIn(["SELLER"]);

    const probes = [
      await setPrice(stranger.cookieHeader, listingRef, usd("1.00")),
      await setPrice(stranger.cookieHeader, unpriced.listingRef, usd("1.00")),
      await setPrice(stranger.cookieHeader, "ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ", usd("1.00")),
      await setPrice(promoterOnly.cookieHeader, listingRef, usd("1.00")),
      await setPrice(promoterOnly.cookieHeader, unpriced.listingRef, usd("1.00")),
    ];
    /* Priced, unpriced, nonexistent — one answer. Nothing in it says whether a
       placement exists, who holds it, whether it is priced, what the price is,
       whether it is promoted, or what state it is in. */
    for (const probe of probes) {
      expect(probe.status).toBe(404);
      expect(probe.body).toEqual({ error: CODES.notAvailable });
    }
    expect(WITHDRAW_CODES.notAvailable).toBe(CODES.notAvailable);
  });
});
