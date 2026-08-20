/**
 * MoR transaction accounting integration tests (Phase 0M.T1).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0e2
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 *
 * NO NETWORK, NO PROVIDER CALL, NO CHECKOUT, AND NO PAYMENT. Instants and
 * identities are injected. Every value is synthetic; no real personal data and no
 * real provider reference appears.
 *
 * **Test isolation.** Every identifier this suite mints carries the `T1T` opaque
 * prefix and every account address the `txn-acct-` local part, and every delete is
 * filtered by one of those. No `deleteMany({})` appears anywhere.
 *
 * The tests that matter most are the exact-binding ones: a recorded sale's
 * economics must be reproducible from the versions it named, unchanged, after the
 * Listing is repriced, the Offer renegotiated, and the commercial policy replaced.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { createAccount } from "../src/server/account/account-service";
import { createDraftParticipant } from "../src/server/marketplace/participant-service";
import { createDraftOffer, createOfferSourceVersion } from "../src/server/marketplace/offer-service";
import {
  createListingSourceVersion,
  createPromotedListing,
  createSellerDirectListing,
} from "../src/server/marketplace/listing-service";
import {
  activateCommercialPolicyVersion,
  createCommercialPolicy,
  recordCommercialPolicyVersion,
} from "../src/server/marketplace/commercial-policy-service";
import type { CommercialPolicyIdProvider } from "../src/server/marketplace/commercial-policy-ids";
import { CommercialPolicyVersionNotFoundError } from "../src/server/marketplace/commercial-policy-errors";
import {
  advanceTransactionSettlement,
  getTransactionEconomicSnapshot,
  recordProviderTransactionReference,
  recordTransactionEconomicSnapshot,
  reconstructTransactionEconomics,
} from "../src/server/marketplace/transaction-accounting-service";
import * as transactionAccountingService from "../src/server/marketplace/transaction-accounting-service";
import {
  CommercialPolicyVersionNotBindableError,
  DuplicateProviderTransactionReferenceError,
  InvalidSettlementTransitionError,
  InvalidTransactionAccountingInputError,
  ListingSourceVersionNotFoundError,
  ProviderTransactionReferenceAlreadyRecordedError,
  TransactionEconomicsRefusedError,
  TransactionSnapshotNotFoundError,
} from "../src/server/marketplace/transaction-accounting-errors";
import { TRANSACTION_SNAPSHOT_ID_PATTERN } from "../src/server/marketplace/transaction-accounting-ids";
import type { TransactionSnapshotIdProvider } from "../src/server/marketplace/transaction-accounting-ids";
import { buyerChargedTotalMinorUnits } from "../src/contracts/marketplace/transaction-accounting";

const RUN = process.env.RUN_DB_TESTS === "1";
const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);

const TAG = "T1T";
const PRODUCT_TAG = "T1TPR0D";
const PRODUCT_PREFIX = `mon:product:${PRODUCT_TAG}`;
const ACCOUNT_EMAIL_PREFIX = "txn-acct-";
const PASSWORD = "correct-horse-battery-staple-0t1";

const NOW = "2027-11-01T09:00:00.000Z";
const SALE_INSTANT = "2027-12-03T12:00:00.000Z";
const LATER = "2027-12-10T09:00:00.000Z";

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const ACTOR = `mon:actor:${pad26("T1TACT0R")}`;
/** No FK; the column records the durable internal Account identity's shape. */
const RECORDER = `mon:acct:${pad26("T1TREC0RDER")}`;

let seq = 0;
const next = (): number => (seq += 1);

const snapshotIds: TransactionSnapshotIdProvider = {
  nextSnapshotId: () => `mon:txsnp:${pad26(`${TAG}SNAP${next()}`)}`,
};
const policyIds: CommercialPolicyIdProvider = {
  nextPolicyId: () => `mon:cpol:${pad26(`${TAG}P0L${next()}`)}`,
};

const deps = () => ({ db, ids: snapshotIds });

/** Delete only what this suite created, child-to-parent. */
async function cleanup(): Promise<void> {
  const ownSnapshots = { startsWith: `mon:txsnp:${TAG}` };
  await db.transactionSettlement.deleteMany({ where: { snapshotId: ownSnapshots } });
  await db.transactionEconomicSnapshot.deleteMany({ where: { id: ownSnapshots } });

  const accounts = await db.account.findMany({
    where: { email: { startsWith: ACCOUNT_EMAIL_PREFIX } },
    select: { id: true },
  });
  const accountIds = accounts.map((a) => a.id);
  if (accountIds.length > 0) {
    const participants = await db.marketplaceParticipant.findMany({
      where: { accountId: { in: accountIds } },
      select: { id: true },
    });
    const participantIds = participants.map((p) => p.id);
    if (participantIds.length > 0) {
      const listings = await db.listing.findMany({
        where: { controllingParticipantId: { in: participantIds } },
        select: { internalListingId: true },
      });
      await db.listingSourceRecordVersionRow.deleteMany({
        where: { controllingParticipantId: { in: participantIds } },
      });
      await db.listing.deleteMany({
        where: { internalListingId: { in: listings.map((l) => l.internalListingId) } },
      });
      await db.offerSourceRecordVersionRow.deleteMany({
        where: { sellerParticipantId: { in: participantIds } },
      });
      await db.offer.deleteMany({ where: { sellerParticipantId: { in: participantIds } } });
      await db.storefront.deleteMany({
        where: { ownerParticipantId: { in: participantIds } },
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

  const ownPolicies = { startsWith: `mon:cpol:${TAG}` };
  await db.commercialPolicyVersionRow.deleteMany({ where: { policyId: ownPolicies } });
  await db.commercialPolicy.deleteMany({ where: { id: ownPolicies } });

  await db.product.deleteMany({ where: { internalProductId: { startsWith: PRODUCT_PREFIX } } });
}

// — Fixtures —

async function seedProduct(): Promise<string> {
  const n = next();
  const internalProductId = `${PRODUCT_PREFIX}${pad26(String(n)).slice(
    0,
    26 - PRODUCT_TAG.length,
  )}`;
  await db.product.create({
    data: {
      internalProductId,
      sourceRecordId: `mon:srec:${pad26(`T1TPSREC${n}`)}`,
      currentSourceRecordVersion: "1",
      recordStatus: "DRAFT",
    },
  });
  return internalProductId;
}

async function seedParticipant(roles: Array<"SELLER" | "PROMOTER">) {
  const n = next();
  const account = await createAccount(
    {
      name: "Synthetic Counterparty",
      email: `${ACCOUNT_EMAIL_PREFIX}${n}@example.com`,
      password: PASSWORD,
      createdAt: NOW,
    },
    { db },
  );
  const snapshot = await createDraftParticipant(
    { accountId: account.accountId, initialRoles: roles, now: NOW },
    { db },
  );
  return { participantId: snapshot.participant.participantId, accountId: account.accountId };
}

async function seedStorefront(ownerParticipantId: string): Promise<string> {
  const n = next();
  const internalStorefrontId = `mon:storefront:${pad26(`T1TST0RE${n}`)}`;
  await db.storefront.create({
    data: {
      internalStorefrontId,
      storefrontSourceRecordId: `mon:srec:${pad26(`T1TSFSREC${n}`)}`,
      currentSourceRecordVersion: "1",
      ownerParticipantId,
      publicHandle: `t1t-synthetic-shop-${n}`,
      lifecycle: "DRAFT",
      visibility: "PRIVATE",
    },
  });
  return internalStorefrontId;
}

/**
 * A persisted commercial policy with one ACTIVE version.
 *
 * Recorded through 0M.R1's own service — the rate is never written directly, and
 * the standard 7.5% + $1.00 numbers are supplied as data rather than compiled in.
 */
async function seedPolicy(
  economics: {
    retainedPercentageBasisPoints: number;
    retainedFixedAmountMinorUnits: number;
  } = { retainedPercentageBasisPoints: 750, retainedFixedAmountMinorUnits: 100 },
): Promise<{ policyId: string; policyVersion: string }> {
  const policy = await createCommercialPolicy(
    { label: `T1T synthetic policy ${next()}`, now: NOW },
    { db, ids: policyIds },
  );
  await recordCommercialPolicyVersion(
    {
      policyId: policy.policyId,
      policyVersion: "1",
      currency: "USD",
      ...economics,
      roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
      effectiveFrom: NOW,
      recordedByAccountId: RECORDER,
      recordedAt: NOW,
    },
    { db },
  );
  await activateCommercialPolicyVersion(
    {
      policyId: policy.policyId,
      policyVersion: "1",
      activatedByAccountId: RECORDER,
      activatedAt: NOW,
    },
    { db },
  );
  return { policyId: policy.policyId, policyVersion: "1" };
}

/** A seller-direct Listing at $100.00, optionally with a scheduled sale. */
async function seedSellerDirect(sale: Record<string, unknown> | null = null) {
  const seller = await seedParticipant(["SELLER"]);
  const internalProductId = await seedProduct();
  const storefrontId = await seedStorefront(seller.participantId);
  const snapshot = await createSellerDirectListing(
    {
      storefrontId,
      internalProductId,
      controllingParticipantId: seller.participantId,
      retail: { retailPriceMinorUnits: 10_000, retailPriceCurrency: "USD" },
      sale,
      actingAccountId: seller.accountId,
      authorizedByActorId: ACTOR,
      now: NOW,
    },
    { db },
  );
  return { seller, internalProductId, storefrontId, snapshot };
}

const ACQUISITION_POLICY = {
  policyId: `mon:cpol:${pad26("T1TSUPPL0ED")}`,
  policyVersion: "1",
  currency: "USD",
  retainedPercentageBasisPoints: 750,
  retainedFixedAmountMinorUnits: 100,
  roundingPolicy: "HALF_UP_TO_MINOR_UNIT" as const,
};

/**
 * A promoted Listing at $100.00 over a $50.00 Offer with a 20% seller-funded
 * commission — the business model §D worked example, as persisted rows.
 */
async function seedPromoted() {
  const seller = await seedParticipant(["SELLER"]);
  const promoter = await seedParticipant(["PROMOTER"]);
  const internalProductId = await seedProduct();
  const storefrontId = await seedStorefront(promoter.participantId);

  const offer = await createDraftOffer(
    {
      internalProductId,
      sellerParticipantId: seller.participantId,
      terms: {
        price: { type: "PAID", wholesalePriceMinorUnits: 5_000, wholesalePriceCurrency: "USD" },
        promotion: {
          type: "PROMOTABLE",
          commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2_000 },
        },
      },
      actingAccountId: seller.accountId,
      authorizedByActorId: ACTOR,
      hasProductAuthority: true,
      now: NOW,
    },
    { db },
  );

  const snapshot = await createPromotedListing(
    {
      storefrontId,
      internalProductId,
      controllingParticipantId: promoter.participantId,
      retail: { retailPriceMinorUnits: 10_000, retailPriceCurrency: "USD" },
      acceptedOfferSourceRecordId: offer.record.offerSourceRecordId,
      acceptedOfferSourceRecordVersion: "1",
      acquisitionPolicy: ACQUISITION_POLICY,
      actingAccountId: promoter.accountId,
      authorizedByActorId: ACTOR,
      now: NOW,
    },
    { db },
  );
  return { seller, promoter, internalProductId, offer, snapshot };
}

const NO_PASS_THROUGH = {
  taxAmountMinorUnits: 0,
  shippingAmountMinorUnits: 0,
  otherPassThroughAmountMinorUnits: 0,
};

const describeDb = RUN ? describe : describe.skip;

describeDb("0M.T1 — MoR transaction accounting foundation", () => {
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await disconnectPrisma();
  });

  describe("recording an economic snapshot", () => {
    it("records the $100 seller-direct example, calculated from the bound sources", async () => {
      const { snapshot: listing } = await seedSellerDirect();
      const policy = await seedPolicy();

      const { snapshot, settlement } = await recordTransactionEconomicSnapshot(
        {
          internalListingId: listing.record.internalListingId,
          listingSourceRecordVersion: listing.currentVersion.sourceRecordVersion,
          policyId: policy.policyId,
          policyVersion: policy.policyVersion,
          currency: "USD",
          ...NO_PASS_THROUGH,
          occurredAt: SALE_INSTANT,
          recordedAt: SALE_INSTANT,
        },
        deps(),
      );

      expect(snapshot.snapshotId).toMatch(TRANSACTION_SNAPSHOT_ID_PATTERN);
      expect(snapshot.commercialRetailAmountMinorUnits).toBe(10_000);
      expect(snapshot.economics).toEqual({
        transactionType: "SELLER_DIRECT",
        monacadoRetainedAmountMinorUnits: 850,
        morWholesaleAcquisitionAmountMinorUnits: 9_150,
        sellerProceedsMinorUnits: 9_150,
      });
      // Opens PENDING with no provider evidence: nothing has been charged.
      expect(settlement.state).toBe("PENDING");
      expect(settlement.provider).toBeNull();
      expect(settlement.providerTransactionRef).toBeNull();
    });

    it("records the $100 promoted example and its reconciliation identity", async () => {
      const { snapshot: listing, offer } = await seedPromoted();
      const policy = await seedPolicy();

      const { snapshot } = await recordTransactionEconomicSnapshot(
        {
          internalListingId: listing.record.internalListingId,
          listingSourceRecordVersion: listing.currentVersion.sourceRecordVersion,
          policyId: policy.policyId,
          policyVersion: policy.policyVersion,
          currency: "USD",
          ...NO_PASS_THROUGH,
          occurredAt: SALE_INSTANT,
          recordedAt: SALE_INSTANT,
        },
        deps(),
      );

      const e = snapshot.economics;
      if (e.transactionType !== "PROMOTED") throw new Error("expected a promoted snapshot");

      expect(e.monacadoRetainedAmountMinorUnits).toBe(850);
      expect(e.morWholesaleAcquisitionAmountMinorUnits).toBe(9_150);
      expect(e.offerWholesalePriceMinorUnits).toBe(5_000);
      expect(e.sellerFundedCommissionMinorUnits).toBe(1_000);
      expect(e.sellerProceedsMinorUnits).toBe(4_000);
      expect(e.promoterRetailSpreadMinorUnits).toBe(4_150);
      expect(e.promoterNetProceedsMinorUnits).toBe(5_150);

      // seller + promoter + Monacado = exactly what the buyer paid.
      expect(
        e.sellerProceedsMinorUnits +
          e.promoterNetProceedsMinorUnits +
          e.monacadoRetainedAmountMinorUnits,
      ).toBe(snapshot.commercialRetailAmountMinorUnits);

      // The wholesale economics came from the EXACT Offer version accepted.
      expect(e.offerBinding).toEqual({
        internalOfferId: offer.record.internalOfferId,
        offerSourceRecordId: offer.record.offerSourceRecordId,
        offerSourceRecordVersion: "1",
      });
    });

    it("prices a seller-direct sale inside a scheduled window at the sale price", async () => {
      const { snapshot: listing } = await seedSellerDirect({
        salePriceMinorUnits: 8_000,
        salePriceCurrency: "USD",
        saleStartsAt: "2027-12-01T00:00:00.000Z",
        saleEndsAt: "2027-12-08T00:00:00.000Z",
      });
      const policy = await seedPolicy();

      const base = {
        internalListingId: listing.record.internalListingId,
        listingSourceRecordVersion: listing.currentVersion.sourceRecordVersion,
        policyId: policy.policyId,
        policyVersion: policy.policyVersion,
        currency: "USD",
        ...NO_PASS_THROUGH,
      };

      // Inside the window: the sale price is the commercial retail basis.
      const inside = await recordTransactionEconomicSnapshot(
        { ...base, occurredAt: SALE_INSTANT, recordedAt: SALE_INSTANT },
        deps(),
      );
      expect(inside.snapshot.commercialRetailAmountMinorUnits).toBe(8_000);
      expect(inside.snapshot.economics.monacadoRetainedAmountMinorUnits).toBe(700);

      // Outside it, from the SAME source version: the ordinary price returns.
      const outside = await recordTransactionEconomicSnapshot(
        { ...base, occurredAt: LATER, recordedAt: LATER },
        deps(),
      );
      expect(outside.snapshot.commercialRetailAmountMinorUnits).toBe(10_000);
      expect(outside.snapshot.economics.monacadoRetainedAmountMinorUnits).toBe(850);
    });

    it("refuses a retail price the policy's retention does not fit inside", async () => {
      const { snapshot: listing } = await seedSellerDirect();
      // $200.00 fixed retention against a $100.00 price.
      const policy = await seedPolicy({
        retainedPercentageBasisPoints: 0,
        retainedFixedAmountMinorUnits: 20_000,
      });

      await expect(
        recordTransactionEconomicSnapshot(
          {
            internalListingId: listing.record.internalListingId,
            listingSourceRecordVersion: listing.currentVersion.sourceRecordVersion,
            policyId: policy.policyId,
            policyVersion: policy.policyVersion,
            currency: "USD",
            ...NO_PASS_THROUGH,
            occurredAt: SALE_INSTANT,
            recordedAt: SALE_INSTANT,
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(TransactionEconomicsRefusedError);

      // Nothing was written.
      expect(
        await db.transactionEconomicSnapshot.count({
          where: { id: { startsWith: `mon:txsnp:${TAG}` } },
        }),
      ).toBe(0);
    });

    it("refuses a promoted sale that would leave the promoter negative", async () => {
      const { snapshot: listing } = await seedPromoted();
      // 60% retention leaves $40.00 acquisition against a $50.00 Offer wholesale,
      // and the $10.00 commission does not close a $10.00 gap.
      const policy = await seedPolicy({
        retainedPercentageBasisPoints: 6_000,
        retainedFixedAmountMinorUnits: 100,
      });

      await expect(
        recordTransactionEconomicSnapshot(
          {
            internalListingId: listing.record.internalListingId,
            listingSourceRecordVersion: listing.currentVersion.sourceRecordVersion,
            policyId: policy.policyId,
            policyVersion: policy.policyVersion,
            currency: "USD",
            ...NO_PASS_THROUGH,
            occurredAt: SALE_INSTANT,
            recordedAt: SALE_INSTANT,
          },
          deps(),
        ),
      ).rejects.toMatchObject({ reason: "NEGATIVE_PROMOTER_PROCEEDS" });
    });

    it("refuses a currency that disagrees with the Listing or the policy", async () => {
      const { snapshot: listing } = await seedSellerDirect();
      const policy = await seedPolicy();

      await expect(
        recordTransactionEconomicSnapshot(
          {
            internalListingId: listing.record.internalListingId,
            listingSourceRecordVersion: listing.currentVersion.sourceRecordVersion,
            policyId: policy.policyId,
            policyVersion: policy.policyVersion,
            currency: "EUR",
            ...NO_PASS_THROUGH,
            occurredAt: SALE_INSTANT,
            recordedAt: SALE_INSTANT,
          },
          deps(),
        ),
      ).rejects.toMatchObject({ code: "TRANSACTION_CURRENCY_MISMATCH" });
    });

    it("refuses a malformed input by field path, naming no value", async () => {
      await expect(
        recordTransactionEconomicSnapshot({ internalListingId: "not-a-listing" }, deps()),
      ).rejects.toBeInstanceOf(InvalidTransactionAccountingInputError);
    });
  });

  describe("tax, shipping, and pass-through amounts", () => {
    it("records them without changing any commercial figure", async () => {
      const { snapshot: listing } = await seedSellerDirect();
      const policy = await seedPolicy();

      const base = {
        internalListingId: listing.record.internalListingId,
        listingSourceRecordVersion: listing.currentVersion.sourceRecordVersion,
        policyId: policy.policyId,
        policyVersion: policy.policyVersion,
        currency: "USD",
        occurredAt: SALE_INSTANT,
        recordedAt: SALE_INSTANT,
      };

      const bare = await recordTransactionEconomicSnapshot(
        { ...base, ...NO_PASS_THROUGH },
        deps(),
      );
      const charged = await recordTransactionEconomicSnapshot(
        {
          ...base,
          taxAmountMinorUnits: 825,
          shippingAmountMinorUnits: 1_299,
          otherPassThroughAmountMinorUnits: 50,
        },
        deps(),
      );

      // $21.74 of tax, shipping, and pass-through changed NOTHING commercial.
      expect(charged.snapshot.commercialRetailAmountMinorUnits).toBe(
        bare.snapshot.commercialRetailAmountMinorUnits,
      );
      expect(charged.snapshot.economics).toEqual(bare.snapshot.economics);

      // And the buyer's total is derived from the four amounts, never stored.
      expect(buyerChargedTotalMinorUnits(charged.snapshot)).toBe(12_174);
      const columns = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TransactionEconomicSnapshot'`,
      );
      const names = columns.map((c) => c.COLUMN_NAME.toLowerCase());
      expect(names).not.toContain("buyerchargedtotalminorunits");
    });

    it("stores no tax rate, jurisdiction, nexus, refund, payout, or buyer column", async () => {
      const columns = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TransactionEconomicSnapshot'`,
      );
      const names = columns.map((c) => c.COLUMN_NAME.toLowerCase());
      for (const forbidden of [
        "taxrate",
        "jurisdiction",
        "nexus",
        "taxability",
        "remit",
        "refund",
        "chargeback",
        "payout",
        "reserve",
        "buyer",
        "card",
        "bank",
        "risk",
      ]) {
        expect(names.some((n) => n.includes(forbidden)), forbidden).toBe(false);
      }
      expect(names).toContain("taxamountminorunits");
      expect(names).toContain("shippingamountminorunits");
    });
  });

  describe("exact historical binding", () => {
    it("binds the Listing version named, not the Listing's current one", async () => {
      const { snapshot: listing, seller } = await seedSellerDirect();
      const policy = await seedPolicy();

      const { snapshot } = await recordTransactionEconomicSnapshot(
        {
          internalListingId: listing.record.internalListingId,
          listingSourceRecordVersion: "1",
          policyId: policy.policyId,
          policyVersion: policy.policyVersion,
          currency: "USD",
          ...NO_PASS_THROUGH,
          occurredAt: SALE_INSTANT,
          recordedAt: SALE_INSTANT,
        },
        deps(),
      );
      expect(snapshot.economics.sellerProceedsMinorUnits).toBe(9_150);

      // The seller doubles the price. A new version; the old one is untouched.
      await createListingSourceVersion(
        {
          internalListingId: listing.record.internalListingId,
          sourceRecordVersion: "2",
          retail: { retailPriceMinorUnits: 20_000, retailPriceCurrency: "USD" },
          actingAccountId: seller.accountId,
          authorizedByActorId: ACTOR,
          now: LATER,
        },
        { db },
      );

      const reread = await getTransactionEconomicSnapshot(snapshot.snapshotId, deps());
      expect(reread.snapshot.commercialRetailAmountMinorUnits).toBe(10_000);
      expect(reread.snapshot.listingBinding.listingSourceRecordVersion).toBe("1");

      // And it still reconstructs from the version it named.
      const { matches } = await reconstructTransactionEconomics(snapshot.snapshotId, deps());
      expect(matches).toBe(true);
    });

    it("keeps promoted economics when the Offer is renegotiated afterwards", async () => {
      const { snapshot: listing, offer, seller } = await seedPromoted();
      const policy = await seedPolicy();

      const { snapshot } = await recordTransactionEconomicSnapshot(
        {
          internalListingId: listing.record.internalListingId,
          listingSourceRecordVersion: "1",
          policyId: policy.policyId,
          policyVersion: policy.policyVersion,
          currency: "USD",
          ...NO_PASS_THROUGH,
          occurredAt: SALE_INSTANT,
          recordedAt: SALE_INSTANT,
        },
        deps(),
      );

      // The seller raises wholesale to $70.00 and drops the commission to 5%.
      await createOfferSourceVersion(
        {
          internalOfferId: offer.record.internalOfferId,
          sourceRecordVersion: "2",
          terms: {
            price: {
              type: "PAID",
              wholesalePriceMinorUnits: 7_000,
              wholesalePriceCurrency: "USD",
            },
            promotion: {
              type: "PROMOTABLE",
              commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 500 },
            },
          },
          actingAccountId: seller.accountId,
          authorizedByActorId: ACTOR,
          hasProductAuthority: true,
          now: LATER,
        },
        { db },
      );

      const reread = await getTransactionEconomicSnapshot(snapshot.snapshotId, deps());
      const e = reread.snapshot.economics;
      if (e.transactionType !== "PROMOTED") throw new Error("expected a promoted snapshot");
      expect(e.offerBinding.offerSourceRecordVersion).toBe("1");
      expect(e.offerWholesalePriceMinorUnits).toBe(5_000);
      expect(e.sellerFundedCommissionMinorUnits).toBe(1_000);
      expect(e.sellerProceedsMinorUnits).toBe(4_000);
      expect(e.promoterNetProceedsMinorUnits).toBe(5_150);

      const { matches } = await reconstructTransactionEconomics(snapshot.snapshotId, deps());
      expect(matches).toBe(true);
    });

    it("keeps economics when the commercial policy is superseded afterwards", async () => {
      const { snapshot: listing } = await seedSellerDirect();
      const policy = await seedPolicy();

      const { snapshot } = await recordTransactionEconomicSnapshot(
        {
          internalListingId: listing.record.internalListingId,
          listingSourceRecordVersion: "1",
          policyId: policy.policyId,
          policyVersion: "1",
          currency: "USD",
          ...NO_PASS_THROUGH,
          occurredAt: SALE_INSTANT,
          recordedAt: SALE_INSTANT,
        },
        deps(),
      );
      expect(snapshot.economics.monacadoRetainedAmountMinorUnits).toBe(850);

      // Monacado moves to 20% + $2.00. Version 1 retires; it does not change.
      await recordCommercialPolicyVersion(
        {
          policyId: policy.policyId,
          policyVersion: "2",
          currency: "USD",
          retainedPercentageBasisPoints: 2_000,
          retainedFixedAmountMinorUnits: 200,
          roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
          effectiveFrom: LATER,
          recordedByAccountId: RECORDER,
          recordedAt: LATER,
        },
        { db },
      );
      await activateCommercialPolicyVersion(
        {
          policyId: policy.policyId,
          policyVersion: "2",
          activatedByAccountId: RECORDER,
          activatedAt: LATER,
        },
        { db },
      );

      const retired = await db.commercialPolicyVersionRow.findUnique({
        where: {
          policyId_policyVersion: { policyId: policy.policyId, policyVersion: "1" },
        },
      });
      expect(retired?.status).toBe("RETIRED");

      // A RETIRED version stays bindable, so the sale still reproduces exactly.
      const reread = await getTransactionEconomicSnapshot(snapshot.snapshotId, deps());
      expect(reread.snapshot.economics.monacadoRetainedAmountMinorUnits).toBe(850);
      expect(reread.snapshot.policyBinding).toEqual({
        policyId: policy.policyId,
        policyVersion: "1",
      });
      const { matches } = await reconstructTransactionEconomics(snapshot.snapshotId, deps());
      expect(matches).toBe(true);
    });

    it("refuses a DRAFT policy version — nothing ever ran under one", async () => {
      const { snapshot: listing } = await seedSellerDirect();
      const policy = await createCommercialPolicy(
        { label: `T1T draft-only policy ${next()}`, now: NOW },
        { db, ids: policyIds },
      );
      await recordCommercialPolicyVersion(
        {
          policyId: policy.policyId,
          policyVersion: "1",
          currency: "USD",
          retainedPercentageBasisPoints: 750,
          retainedFixedAmountMinorUnits: 100,
          roundingPolicy: "HALF_UP_TO_MINOR_UNIT",
          effectiveFrom: NOW,
          recordedByAccountId: RECORDER,
          recordedAt: NOW,
        },
        { db },
      );

      await expect(
        recordTransactionEconomicSnapshot(
          {
            internalListingId: listing.record.internalListingId,
            listingSourceRecordVersion: "1",
            policyId: policy.policyId,
            policyVersion: "1",
            currency: "USD",
            ...NO_PASS_THROUGH,
            occurredAt: SALE_INSTANT,
            recordedAt: SALE_INSTANT,
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(CommercialPolicyVersionNotBindableError);
    });

    it("refuses a Listing version and a policy version that do not exist", async () => {
      const { snapshot: listing } = await seedSellerDirect();
      const policy = await seedPolicy();
      const base = {
        internalListingId: listing.record.internalListingId,
        listingSourceRecordVersion: "1",
        policyId: policy.policyId,
        policyVersion: policy.policyVersion,
        currency: "USD",
        ...NO_PASS_THROUGH,
        occurredAt: SALE_INSTANT,
        recordedAt: SALE_INSTANT,
      };

      await expect(
        recordTransactionEconomicSnapshot(
          { ...base, listingSourceRecordVersion: "99" },
          deps(),
        ),
      ).rejects.toBeInstanceOf(ListingSourceVersionNotFoundError);

      await expect(
        recordTransactionEconomicSnapshot({ ...base, policyVersion: "99" }, deps()),
      ).rejects.toBeInstanceOf(CommercialPolicyVersionNotFoundError);
    });
  });

  describe("foreign-key integrity", () => {
    it("refuses to delete the Listing version, Offer version, or policy version beneath a snapshot", async () => {
      const { snapshot: listing, offer } = await seedPromoted();
      const policy = await seedPolicy();

      await recordTransactionEconomicSnapshot(
        {
          internalListingId: listing.record.internalListingId,
          listingSourceRecordVersion: "1",
          policyId: policy.policyId,
          policyVersion: policy.policyVersion,
          currency: "USD",
          ...NO_PASS_THROUGH,
          occurredAt: SALE_INSTANT,
          recordedAt: SALE_INSTANT,
        },
        deps(),
      );

      await expect(
        db.listingSourceRecordVersionRow.deleteMany({
          where: {
            listingSourceRecordId: listing.record.listingSourceRecordId,
            sourceRecordVersion: "1",
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });

      await expect(
        db.offerSourceRecordVersionRow.deleteMany({
          where: {
            offerSourceRecordId: offer.record.offerSourceRecordId,
            sourceRecordVersion: "1",
          },
        }),
      ).rejects.toMatchObject({ code: "P2003" });

      await expect(
        db.commercialPolicyVersionRow.deleteMany({
          where: { policyId: policy.policyId, policyVersion: policy.policyVersion },
        }),
      ).rejects.toMatchObject({ code: "P2003" });

      await expect(
        db.listing.deleteMany({ where: { internalListingId: listing.record.internalListingId } }),
      ).rejects.toMatchObject({ code: "P2003" });
    });
  });

  describe("settlement state", () => {
    async function seedSnapshot(): Promise<string> {
      const { snapshot: listing } = await seedSellerDirect();
      const policy = await seedPolicy();
      const { snapshot } = await recordTransactionEconomicSnapshot(
        {
          internalListingId: listing.record.internalListingId,
          listingSourceRecordVersion: "1",
          policyId: policy.policyId,
          policyVersion: policy.policyVersion,
          currency: "USD",
          ...NO_PASS_THROUGH,
          occurredAt: SALE_INSTANT,
          recordedAt: SALE_INSTANT,
        },
        deps(),
      );
      return snapshot.snapshotId;
    }

    it("advances PENDING -> FUNDS_RECEIVED -> SETTLED, stamping each instant", async () => {
      const snapshotId = await seedSnapshot();

      const received = await advanceTransactionSettlement(
        { snapshotId, to: "FUNDS_RECEIVED", at: SALE_INSTANT },
        deps(),
      );
      expect(received.state).toBe("FUNDS_RECEIVED");
      expect(received.fundsReceivedAt).toBe(SALE_INSTANT);
      expect(received.settledAt).toBeNull();

      const settled = await advanceTransactionSettlement(
        { snapshotId, to: "SETTLED", at: LATER },
        deps(),
      );
      expect(settled.state).toBe("SETTLED");
      expect(settled.settledAt).toBe(LATER);
      // The earlier instant survives; nothing is overwritten.
      expect(settled.fundsReceivedAt).toBe(SALE_INSTANT);
    });

    it("refuses a skipped or backward transition", async () => {
      const snapshotId = await seedSnapshot();

      await expect(
        advanceTransactionSettlement({ snapshotId, to: "SETTLED", at: LATER }, deps()),
      ).rejects.toBeInstanceOf(InvalidSettlementTransitionError);

      await advanceTransactionSettlement(
        { snapshotId, to: "FUNDS_RECEIVED", at: SALE_INSTANT },
        deps(),
      );
      await expect(
        advanceTransactionSettlement({ snapshotId, to: "PENDING", at: LATER }, deps()),
      ).rejects.toBeInstanceOf(InvalidSettlementTransitionError);
    });

    it("reaches REVERSED from SETTLED, and REVERSED is terminal", async () => {
      const snapshotId = await seedSnapshot();
      await advanceTransactionSettlement(
        { snapshotId, to: "FUNDS_RECEIVED", at: SALE_INSTANT },
        deps(),
      );
      await advanceTransactionSettlement({ snapshotId, to: "SETTLED", at: LATER }, deps());

      const reversed = await advanceTransactionSettlement(
        { snapshotId, to: "REVERSED", at: LATER },
        deps(),
      );
      expect(reversed.state).toBe("REVERSED");
      expect(reversed.reversedAt).toBe(LATER);

      await expect(
        advanceTransactionSettlement({ snapshotId, to: "FUNDS_RECEIVED", at: LATER }, deps()),
      ).rejects.toBeInstanceOf(InvalidSettlementTransitionError);
    });

    it("refuses a settlement change on a snapshot that does not exist", async () => {
      await expect(
        advanceTransactionSettlement(
          {
            snapshotId: `mon:txsnp:${pad26("T1TAB5ENT")}`,
            to: "FUNDS_RECEIVED",
            at: LATER,
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(TransactionSnapshotNotFoundError);
    });
  });

  describe("the provider transaction reference", () => {
    async function seedSnapshot(): Promise<string> {
      const { snapshot: listing } = await seedSellerDirect();
      const policy = await seedPolicy();
      const { snapshot } = await recordTransactionEconomicSnapshot(
        {
          internalListingId: listing.record.internalListingId,
          listingSourceRecordVersion: "1",
          policyId: policy.policyId,
          policyVersion: policy.policyVersion,
          currency: "USD",
          ...NO_PASS_THROUGH,
          occurredAt: SALE_INSTANT,
          recordedAt: SALE_INSTANT,
        },
        deps(),
      );
      return snapshot.snapshotId;
    }

    it("round-trips an opaque reference with its provider", async () => {
      const snapshotId = await seedSnapshot();
      const ref = `t1t_synthetic_txn_${next()}`;

      const written = await recordProviderTransactionReference(
        { snapshotId, provider: "STRIPE", providerTransactionRef: ref, recordedAt: LATER },
        deps(),
      );
      expect(written.provider).toBe("STRIPE");
      expect(written.providerTransactionRef).toBe(ref);
      expect(written.providerReferenceRecordedAt).toBe(LATER);

      const reread = await getTransactionEconomicSnapshot(snapshotId, deps());
      expect(reread.settlement.providerTransactionRef).toBe(ref);
    });

    it("is write-once", async () => {
      const snapshotId = await seedSnapshot();
      await recordProviderTransactionReference(
        {
          snapshotId,
          provider: "STRIPE",
          providerTransactionRef: `t1t_first_${next()}`,
          recordedAt: LATER,
        },
        deps(),
      );
      await expect(
        recordProviderTransactionReference(
          {
            snapshotId,
            provider: "STRIPE",
            providerTransactionRef: `t1t_second_${next()}`,
            recordedAt: LATER,
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(ProviderTransactionReferenceAlreadyRecordedError);
    });

    it("refuses one provider transaction recorded against two snapshots", async () => {
      const first = await seedSnapshot();
      const second = await seedSnapshot();
      const ref = `t1t_shared_txn_${next()}`;

      await recordProviderTransactionReference(
        { snapshotId: first, provider: "STRIPE", providerTransactionRef: ref, recordedAt: LATER },
        deps(),
      );
      await expect(
        recordProviderTransactionReference(
          {
            snapshotId: second,
            provider: "STRIPE",
            providerTransactionRef: ref,
            recordedAt: LATER,
          },
          deps(),
        ),
      ).rejects.toBeInstanceOf(DuplicateProviderTransactionReferenceError);
    });

    it("refuses a Monacado identifier or a provider secret as a reference", async () => {
      const snapshotId = await seedSnapshot();
      for (const bad of [snapshotId, "sk_live_abc", "whsec_abc", "Bearer abc"]) {
        await expect(
          recordProviderTransactionReference(
            { snapshotId, provider: "STRIPE", providerTransactionRef: bad, recordedAt: LATER },
            deps(),
          ),
        ).rejects.toBeInstanceOf(InvalidTransactionAccountingInputError);
      }
    });
  });

  describe("immutability of the economic facts", () => {
    it("leaves every economic column untouched by settlement and provider writes", async () => {
      const { snapshot: listing } = await seedPromoted();
      const policy = await seedPolicy();
      const { snapshot } = await recordTransactionEconomicSnapshot(
        {
          internalListingId: listing.record.internalListingId,
          listingSourceRecordVersion: "1",
          policyId: policy.policyId,
          policyVersion: policy.policyVersion,
          currency: "USD",
          taxAmountMinorUnits: 825,
          shippingAmountMinorUnits: 0,
          otherPassThroughAmountMinorUnits: 0,
          occurredAt: SALE_INSTANT,
          recordedAt: SALE_INSTANT,
        },
        deps(),
      );

      const before = await db.transactionEconomicSnapshot.findUnique({
        where: { id: snapshot.snapshotId },
      });

      await advanceTransactionSettlement(
        { snapshotId: snapshot.snapshotId, to: "FUNDS_RECEIVED", at: LATER },
        deps(),
      );
      await recordProviderTransactionReference(
        {
          snapshotId: snapshot.snapshotId,
          provider: "STRIPE",
          providerTransactionRef: `t1t_immutable_${next()}`,
          recordedAt: LATER,
        },
        deps(),
      );
      await advanceTransactionSettlement(
        { snapshotId: snapshot.snapshotId, to: "REVERSED", at: LATER },
        deps(),
      );

      const after = await db.transactionEconomicSnapshot.findUnique({
        where: { id: snapshot.snapshotId },
      });
      expect(after).toEqual(before);
    });

    it("exposes no operation that edits a recorded snapshot", () => {
      const operations = Object.keys(transactionAccountingService).filter(
        (k) => typeof (transactionAccountingService as Record<string, unknown>)[k] === "function",
      );
      expect(operations.sort()).toEqual([
        "advanceTransactionSettlement",
        "getTransactionEconomicSnapshot",
        "reconstructTransactionEconomics",
        "recordProviderTransactionReference",
        "recordTransactionEconomicSnapshot",
      ]);
    });

    it("gives the snapshot table no updatedAt column, because nothing updates it", async () => {
      const columns = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TransactionEconomicSnapshot'`,
      );
      const names = columns.map((c) => c.COLUMN_NAME.toLowerCase());
      expect(names).not.toContain("updatedat");
      // The mutable half has one, and lives in its own table.
      const settlementColumns = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'TransactionSettlement'`,
      );
      expect(settlementColumns.map((c) => c.COLUMN_NAME.toLowerCase())).toContain("updatedat");
    });
  });

  describe("suite-scoped cleanup", () => {
    it("removes only this suite's rows", async () => {
      const { snapshot: listing } = await seedSellerDirect();
      const policy = await seedPolicy();
      await recordTransactionEconomicSnapshot(
        {
          internalListingId: listing.record.internalListingId,
          listingSourceRecordVersion: "1",
          policyId: policy.policyId,
          policyVersion: policy.policyVersion,
          currency: "USD",
          ...NO_PASS_THROUGH,
          occurredAt: SALE_INSTANT,
          recordedAt: SALE_INSTANT,
        },
        deps(),
      );

      const foreign = await db.transactionEconomicSnapshot.count({
        where: { id: { not: { startsWith: `mon:txsnp:${TAG}` } } },
      });

      await cleanup();

      expect(
        await db.transactionEconomicSnapshot.count({
          where: { id: { startsWith: `mon:txsnp:${TAG}` } },
        }),
      ).toBe(0);
      expect(
        await db.transactionEconomicSnapshot.count({
          where: { id: { not: { startsWith: `mon:txsnp:${TAG}` } } },
        }),
      ).toBe(foreign);
    });
  });
});
