/**
 * Offer persistence contracts and scope boundaries (Phase 0M.6).
 *
 * Offline. No database, no clock, no network — the DB behaviour lives in
 * `offer-persistence.integration.test.ts`.
 *
 * What this file is for: proving that persistence **added no Offer fact**. The
 * 0M.2A source model is the authority on what an Offer is, and 0M.6 exists only
 * to store it. A test that catches a widened model is worth more here than one
 * that re-proves the economics 0M.2A and 0M.2C already prove.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CreateDraftOfferInput,
  DEFERRED_OFFER_PERSISTENCE_EXTENSIONS,
  NEVER_ON_OFFER_RECORD,
  UpdateOfferInput,
} from "../src/contracts/marketplace/offer-record";
import {
  OfferSourceVersion,
  PROJECTION_ELIGIBLE_OFFER_FIELDS,
  calculateOfferEconomics,
} from "../src/contracts/marketplace/offer-source";
import { OFFER_ID_PATTERNS } from "../src/server/marketplace/offer-ids";

const SCHEMA_CODE = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const RECORD_CODE = readFileSync(
  new URL("../src/contracts/marketplace/offer-record.ts", import.meta.url),
  "utf8",
);

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const PRODUCT = `mon:product:${pad26("M6PRODUCT")}`;
const SELLER = `mon:mpart:${pad26("M6SELLER")}`;
const ACTOR = `mon:actor:${pad26("M6ACTOR")}`;

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

const createInput = (overrides: Record<string, unknown> = {}) => ({
  internalProductId: PRODUCT,
  sellerParticipantId: SELLER,
  terms: paidPromotableTerms,
  actingAccountId: "acct_synthetic_0m6",
  now: "2027-10-01T09:00:00.000Z",
  ...overrides,
});

// — 1 —

describe("create input", () => {
  it("accepts a well-formed draft Offer input", () => {
    expect(CreateDraftOfferInput.safeParse(createInput()).success).toBe(true);
  });

  it("refuses an unknown key — the schema is strict, so a field cannot arrive early", () => {
    expect(
      CreateDraftOfferInput.safeParse(createInput({ promoterRetailPrice: 9999 })).success,
    ).toBe(false);
  });

  it("has NO input for lifecycle or availability — neither is a caller choice", () => {
    /* 0M.2A starts the lifecycle at DRAFT, and availability modifies a LIVE
       Offer. A caller that could set either at creation could stage an Offer
       that was never reviewed into a state implying it had been. */
    expect(CreateDraftOfferInput.safeParse(createInput({ lifecycle: "ACTIVE" })).success).toBe(
      false,
    );
    expect(
      CreateDraftOfferInput.safeParse(createInput({ availability: "TEMPORARILY_UNAVAILABLE" }))
        .success,
    ).toBe(false);
  });

  it("has NO input for economics — they are computed, never supplied", () => {
    /* Accepting them would let a caller persist numbers the deterministic
       calculator never produced, which is precisely what 0M.2C exists to stop. */
    expect(
      CreateDraftOfferInput.safeParse(
        createInput({
          economics: {
            calculatedCommissionMinorUnits: 1,
            calculatedCreatorGrossProceedsMinorUnits: 1,
            commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("has NO input for a source-record id or internal Offer id — identity is minted", () => {
    expect(
      CreateDraftOfferInput.safeParse(createInput({ internalOfferId: `mon:offer:${pad26("X")}` }))
        .success,
    ).toBe(false);
    expect(
      CreateDraftOfferInput.safeParse(createInput({ offerSourceRecordId: `mon:srec:${pad26("X")}` }))
        .success,
    ).toBe(false);
  });

  it("refuses hasProductAuthority — derived, never supplied (Phase 1.18)", () => {
    /* The inversion of what this test asserted through Phase 1.17. The field was
       the deciding fact behind `canCreateDraftOffer`, and any caller could write
       `true`; the Offer service now reads it from the Product's current source
       version. `strictObject` makes the removal active rather than passive — a
       caller still sending it is refused, not quietly ignored. */
    expect(CreateDraftOfferInput.safeParse(createInput()).success).toBe(true);
    expect(
      CreateDraftOfferInput.safeParse({ ...createInput(), hasProductAuthority: true }).success,
    ).toBe(false);
  });

  it("refuses a non-opaque actor id, so an email can never become an actor", () => {
    expect(
      CreateDraftOfferInput.safeParse(createInput({ authorizedByActorId: "seller@example.com" }))
        .success,
    ).toBe(false);
  });

  it("refuses economically invalid terms at the input boundary", () => {
    /* A promotable FREE Offer has no proceeds to pay a commission from. The
       refusal comes from 0M.2A's own cross-field rule, not a second copy. */
    expect(
      CreateDraftOfferInput.safeParse(
        createInput({
          terms: {
            price: { type: "FREE" },
            promotion: {
              type: "PROMOTABLE",
              commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 1000 },
            },
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("refuses a fixed commission exceeding the wholesale price", () => {
    expect(
      CreateDraftOfferInput.safeParse(
        createInput({
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
        }),
      ).success,
    ).toBe(false);
  });
});

// — 2 —

describe("update input", () => {
  const updateInput = (overrides: Record<string, unknown> = {}) => ({
    internalOfferId: `mon:offer:${pad26("M6OFFER")}`,
    sourceRecordVersion: "2",
    actingAccountId: "acct_synthetic_0m6",
    now: "2027-10-02T09:00:00.000Z",
    ...overrides,
  });

  it("accepts an update stating only what changes", () => {
    expect(UpdateOfferInput.safeParse(updateInput({ availability: "TEMPORARILY_UNAVAILABLE" })).success).toBe(
      true,
    );
  });

  it("requires an explicit new version label — never generated for the caller", () => {
    const { sourceRecordVersion: _drop, ...without } = updateInput();
    expect(UpdateOfferInput.safeParse(without).success).toBe(false);
  });

  it("cannot reassign the Product or the seller through an update", () => {
    /* Both are material fields on the source version, but neither is a member of
       the update input: re-pointing an Offer at another Product, or handing it to
       another seller, is not an edit — it is a different Offer. */
    expect(UpdateOfferInput.safeParse(updateInput({ internalProductId: PRODUCT })).success).toBe(
      false,
    );
    expect(
      UpdateOfferInput.safeParse(updateInput({ sellerParticipantId: SELLER })).success,
    ).toBe(false);
  });

  it("accepts null to clear the effective interval, and omission to leave it", () => {
    expect(UpdateOfferInput.safeParse(updateInput({ effectiveInterval: null })).success).toBe(true);
    expect(UpdateOfferInput.safeParse(updateInput({})).success).toBe(true);
  });

  it("refuses an interval with both bounds null — one representation per fact", () => {
    expect(
      UpdateOfferInput.safeParse(
        updateInput({ effectiveInterval: { startsAt: null, endsAt: null } }),
      ).success,
    ).toBe(false);
  });

  it("carries an economics confirmation bound to both halves of the identity", () => {
    const parsed = UpdateOfferInput.safeParse(
      updateInput({
        lifecycle: "ACTIVE",
        economicsConfirmation: {
          confirmedOfferSourceRecordId: `mon:srec:${pad26("M6SREC")}`,
          confirmedOfferSourceRecordVersion: "2",
          ...calculateOfferEconomics(paidPromotableTerms),
        },
      }),
    );
    expect(parsed.success).toBe(true);
  });
});

// — 3 —

describe("privacy and scope", () => {
  it("names every forbidden field, and the schema refuses each one", () => {
    for (const field of NEVER_ON_OFFER_RECORD) {
      expect(CreateDraftOfferInput.safeParse(createInput({ [field]: "x" })).success).toBe(false);
    }
    expect(NEVER_ON_OFFER_RECORD.length).toBeGreaterThan(30);
  });

  it("forbids other layers' economics by name, not merely by omission", () => {
    /* These are not private data — they are facts belonging to a Listing
       (retail price, spread) or to the MoR policy 0M.R supplies (retention,
       acquisition). An Offer asserting one would assert a number its own
       authority never agreed to. */
    for (const field of [
      "promoterRetailPrice",
      "promoterSpread",
      "monacadoRetainedAmount",
      "wholesaleAcquisitionAmount",
      "checkoutTax",
      "shippingAmount",
    ]) {
      expect(NEVER_ON_OFFER_RECORD as readonly string[]).toContain(field);
    }
  });

  it("stores no payment, banking, risk, settlement, or buyer column in the schema", () => {
    const offerTables = SCHEMA_CODE.slice(
      SCHEMA_CODE.indexOf("model Offer {"),
      SCHEMA_CODE.indexOf("model Listing {"),
    );
    for (const forbidden of [
      "paymentProviderToken",
      "stripeAccountId",
      "bankingData",
      "underwritingData",
      "riskClassification",
      "payoutHold",
      "settlementData",
      "buyerId",
      "promoterRetailPrice",
      "monacadoRetainedAmount",
    ]) {
      expect(offerTables).not.toContain(forbidden);
    }
  });

  it("stores no capsule, Node, mapping, or publication column", () => {
    /* ADR §12.2: a projection-layer control inside transactional truth is
       exactly the coupling the source model refuses. */
    const offerTables = SCHEMA_CODE.slice(
      SCHEMA_CODE.indexOf("model Offer {"),
      SCHEMA_CODE.indexOf("model Listing {"),
    );
    for (const forbidden of [
      "capsuleId",
      "nodeId",
      "offerNode",
      "mappingVersion",
      "contentHash",
      "publicationState",
    ]) {
      expect(offerTables).not.toContain(forbidden);
    }
  });

  it("defers Listing binding and Node issuance by name", () => {
    for (const deferred of ["offerNode", "nodeIssuance", "listingPersistence", "listingBinding"]) {
      expect(DEFERRED_OFFER_PERSISTENCE_EXTENSIONS as readonly string[]).toContain(deferred);
    }
  });

  it("creates no Offer Node, publication, or outbox table", () => {
    /* `model Listing` left this list when Phase 0M.7 built it. What 0M.6 claims
       is that *it* added no Listing persistence, and the Offer-side artifacts
       below are still absent. */
    for (const model of ["model OfferNode", "model OfferPublication"]) {
      expect(SCHEMA_CODE).not.toContain(model);
    }
  });
});

// — 4 —

describe("schema shape", () => {
  it("makes every Offer foreign key RESTRICT — history is never cascade-deleted", () => {
    /* Bounded to the Offer models. Phase 0M.7 appended the Listing models after
       them, and an unbounded slice would count that phase's relations too. */
    const offerTables = SCHEMA_CODE.slice(
      SCHEMA_CODE.indexOf("model Offer {"),
      SCHEMA_CODE.indexOf("model Listing {"),
    );
    const relations = offerTables.match(/@relation\([^)]*onDelete: \w+/g) ?? [];
    expect(relations.length).toBe(6);
    for (const relation of relations) expect(relation).toContain("onDelete: Restrict");
    expect(offerTables).not.toContain("onDelete: Cascade");
  });

  it("mints a version label once per source record", () => {
    expect(SCHEMA_CODE).toContain("@@unique([offerSourceRecordId, sourceRecordVersion])");
  });

  it("keeps the money columns BigInt, so minor units cannot silently overflow", () => {
    for (const column of [
      "wholesalePriceMinorUnits BigInt?",
      "fixedCommissionMinorUnits BigInt?",
      "calculatedCommissionMinorUnits           BigInt",
      "calculatedCreatorGrossProceedsMinorUnits BigInt",
    ]) {
      expect(SCHEMA_CODE.replace(/ +/g, " ")).toContain(column.replace(/ +/g, " "));
    }
  });

  it("keeps the discriminator columns NOT NULL and their arms nullable", () => {
    /* Absence by construction: a FREE row has no amount and no currency, so it
       cannot carry a stray price from whatever it superseded. */
    const versionTable = SCHEMA_CODE.slice(
      SCHEMA_CODE.indexOf("model OfferSourceRecordVersionRow {"),
    );
    expect(versionTable).toMatch(/priceType\s+String\s+@db\.VarChar\(8\)/);
    expect(versionTable).toMatch(/promotionType\s+String\s+@db\.VarChar\(16\)/);
    expect(versionTable).toMatch(/wholesalePriceCurrency\s+String\?/);
    expect(versionTable).toMatch(/commissionMethod\s+String\?/);
  });
});

// — 5 —

describe("identity", () => {
  it("mints an opaque internal Offer id that is never a Node", () => {
    expect(OFFER_ID_PATTERNS.offer.source).toContain("mon:offer:");
    expect(OFFER_ID_PATTERNS.sourceRecord.source).toContain("mon:srec:");
  });

  it("derives identity from no business fact", () => {
    /* A price, a handle, or a participant name inside an identifier would become
       a lie the moment the Offer was repriced — which is the ordinary case. */
    const idsModule = readFileSync(
      new URL("../src/server/marketplace/offer-ids.ts", import.meta.url),
      "utf8",
    );
    expect(idsModule).toContain("randomBytes");
    for (const fact of ["wholesale", "currency", "productId", "sellerParticipantId"]) {
      expect(idsModule.split("export const cryptoOfferIdProvider")[1]).not.toContain(fact);
    }
  });
});

// — 6 —

describe("the source model was not widened", () => {
  it("adds no member to OfferSourceVersion", () => {
    /* The persisted shape must be exactly the contract shape. If persistence had
       introduced a field, this list would have grown and the projection would be
       consuming something 0M.2B never agreed to. */
    const members = Object.keys(OfferSourceVersion._def.shape ?? {});
    expect(members.sort()).toEqual(
      [
        "authorizedByActorId",
        "authorizedBySellerParticipantId",
        "availability",
        "economics",
        "effectiveInterval",
        "internalOfferId",
        "internalProductId",
        "lifecycle",
        "offerSourceRecordId",
        "recordedAt",
        "sellerParticipantId",
        "sourceClass",
        "sourceRecordType",
        "sourceRecordVersion",
        "sourceSystem",
        "supersedesSourceRecordVersion",
        "terms",
      ].sort(),
    );
  });

  it("leaves the 0M.2A projection-eligible field set untouched", () => {
    expect([...PROJECTION_ELIGIBLE_OFFER_FIELDS]).toEqual([
      "internalOfferId",
      "internalProductId",
      "sellerParticipantId",
      "lifecycle",
      "availability",
      "price",
      "promotion",
      "commission",
      "effectiveInterval",
    ]);
  });

  it("hard-codes no Monacado retail policy — that belongs outside Offer authority", () => {
    /* 92.5% / 7.5% / the $1.00 fixed retention are MoR policy inputs 0M.R
       supplies per transaction. A rate compiled into Offer persistence would
       freeze a commercial policy inside transactional truth. */
    for (const forbidden of ["92.5", "0.925", "7.5", "9250", "750"]) {
      expect(RECORD_CODE).not.toContain(forbidden);
    }
  });
});
