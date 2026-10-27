/**
 * Offer persistence contracts and scope boundaries (Phase 0M.6; Phase 1.42).
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
  ActivateOfferInput,
  CreateOfferInput,
  DEFERRED_OFFER_PERSISTENCE_EXTENSIONS,
  EndPromotionInput,
  NEVER_ON_OFFER_RECORD,
  ReplacePromotionInput,
  ResumeOfferInput,
  ReviseOfferTermsInput,
  SchedulePromotionInput,
  StandDownOfferInput,
  percentToBasisPoints,
  standingTermsFromRequest,
  usdMinorUnits,
} from "../src/contracts/marketplace/offer-record";
import {
  OfferSourceVersion,
  PROJECTION_ELIGIBLE_OFFER_FIELDS,
  PromotedResaleOfferTerms,
} from "../src/contracts/marketplace/offer-source";
import { OFFER_ID_PATTERNS } from "../src/server/marketplace/offer-ids";

const SCHEMA_CODE = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const RECORD_CODE = readFileSync(
  new URL("../src/contracts/marketplace/offer-record.ts", import.meta.url),
  "utf8",
);

const PRODUCT_REF = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const OFFER_REF = "ABCDEFGHJKMNPQRSTVWXYZ0123456789";
const NOW = "2027-10-01T09:00:00.000Z";

const terms = {
  wholesalePrice: "50.00",
  currency: "USD",
  commission: { method: "PERCENT_OF_WHOLESALE", percent: "20" },
};

const createInput = (overrides: Record<string, unknown> = {}) => ({
  productRef: PRODUCT_REF,
  terms,
  now: NOW,
  ...overrides,
});

const confirmation = {
  version: "2",
  calculatedCommissionMinorUnits: 1000,
  calculatedSellerGrossProceedsMinorUnits: 4000,
  commissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
};

// — 1 —

describe("create input (Phase 1.42)", () => {
  it("accepts terms as typed, named by the Product reference", () => {
    expect(CreateOfferInput.safeParse(createInput()).success).toBe(true);
  });

  it("refuses an unknown key — the schema is strict, so a field cannot arrive early", () => {
    expect(CreateOfferInput.safeParse(createInput({ inventory: 3 })).success).toBe(false);
  });

  it("has NO input for who acts, the Seller, a lifecycle, economics, or identity", () => {
    for (const extra of [
      { actingAccountId: "acct_1" },
      { sellerParticipantId: `mon:mpart:${"B".repeat(26)}` },
      { hasProductAuthority: true },
      { lifecycle: "ACTIVE" },
      { availability: "AVAILABLE" },
      { economics: { calculatedCommissionMinorUnits: 0 } },
      { internalOfferId: `mon:offer:${"C".repeat(26)}` },
      { sourceRecordVersion: "1" },
      { internalProductId: `mon:product:${"D".repeat(26)}` },
    ]) {
      expect(CreateOfferInput.safeParse(createInput(extra)).success).toBe(false);
    }
  });

  it("admits USD only", () => {
    expect(CreateOfferInput.safeParse(createInput({ terms: { ...terms, currency: "EUR" } })).success).toBe(false);
  });
});

describe("terms conversion — money parsed on the server, never rounded", () => {
  it("converts decimal strings to minor units and percentages to basis points", () => {
    expect(usdMinorUnits("19.9")).toBe(1990);
    expect(usdMinorUnits("0")).toBeNull();
    expect(usdMinorUnits("1.999")).toBeNull();
    expect(usdMinorUnits("abc")).toBeNull();
    expect(percentToBasisPoints("12.5")).toBe(1250);
    expect(percentToBasisPoints("7.25")).toBe(725);
    expect(percentToBasisPoints("100")).toBe(10_000);
    expect(percentToBasisPoints("1.234")).toBeNull();
  });

  it("builds PAID + PROMOTABLE USD terms, and names fields it cannot convert", () => {
    const ok = standingTermsFromRequest({ wholesalePrice: "50", currency: "USD", commission: { method: "FIXED_AMOUNT", amount: "2" } });
    expect(ok).toEqual({
      ok: true,
      terms: {
        price: { type: "PAID", wholesalePriceMinorUnits: 5000, wholesalePriceCurrency: "USD" },
        promotion: {
          type: "PROMOTABLE",
          commission: { method: "FIXED_AMOUNT", fixedCommissionMinorUnits: 200, fixedCommissionCurrency: "USD" },
        },
      },
    });
    expect(
      standingTermsFromRequest({ wholesalePrice: "0", currency: "USD", commission: { method: "PERCENT_OF_WHOLESALE", percent: "x" } }),
    ).toEqual({ ok: false, fields: ["terms.wholesalePrice", "terms.commission.percent"] });
  });

  it("refuses FREE, NOT_PROMOTABLE, non-USD, zero, and over-100% terms at the write boundary", () => {
    const paid = { type: "PAID", wholesalePriceMinorUnits: 5000, wholesalePriceCurrency: "USD" };
    const promotable = { type: "PROMOTABLE", commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 2000 } };
    expect(PromotedResaleOfferTerms.safeParse({ price: paid, promotion: promotable }).success).toBe(true);
    expect(PromotedResaleOfferTerms.safeParse({ price: { type: "FREE" }, promotion: { type: "NOT_PROMOTABLE" } }).success).toBe(false);
    expect(PromotedResaleOfferTerms.safeParse({ price: paid, promotion: { type: "NOT_PROMOTABLE" } }).success).toBe(false);
    expect(PromotedResaleOfferTerms.safeParse({ price: { ...paid, wholesalePriceCurrency: "EUR" }, promotion: promotable }).success).toBe(false);
    expect(PromotedResaleOfferTerms.safeParse({ price: { ...paid, wholesalePriceMinorUnits: 0 }, promotion: promotable }).success).toBe(false);
    expect(
      PromotedResaleOfferTerms.safeParse({
        price: paid,
        promotion: { type: "PROMOTABLE", commission: { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: 10_001 } },
      }).success,
    ).toBe(false);
    expect(
      PromotedResaleOfferTerms.safeParse({
        price: paid,
        promotion: { type: "PROMOTABLE", commission: { method: "FIXED_AMOUNT", fixedCommissionMinorUnits: 5001, fixedCommissionCurrency: "USD" } },
      }).success,
    ).toBe(false);
  });
});

describe("act inputs (Phase 1.42)", () => {
  const sel = { productRef: PRODUCT_REF, offerRef: OFFER_REF, now: NOW };

  it("requires expectedVersion where stale commercial state matters", () => {
    expect(ReviseOfferTermsInput.safeParse({ ...sel, terms }).success).toBe(false);
    expect(ReviseOfferTermsInput.safeParse({ ...sel, terms, expectedVersion: "1" }).success).toBe(true);
    expect(ResumeOfferInput.safeParse(sel).success).toBe(false);
    expect(ResumeOfferInput.safeParse({ ...sel, expectedVersion: "1" }).success).toBe(true);
    const promotion = { ...sel, wholesalePrice: "40.00", effectiveFrom: NOW, effectiveUntil: "2027-10-08T09:00:00.000Z" };
    expect(SchedulePromotionInput.safeParse(promotion).success).toBe(false);
    expect(SchedulePromotionInput.safeParse({ ...promotion, expectedVersion: "1" }).success).toBe(true);
    expect(ReplacePromotionInput.safeParse({ ...promotion, expectedVersion: "1" }).success).toBe(false);
    expect(ReplacePromotionInput.safeParse({ ...promotion, expectedVersion: "1", expectedPromotionVersion: "2" }).success).toBe(true);
    expect(EndPromotionInput.safeParse(sel).success).toBe(false);
    expect(EndPromotionInput.safeParse({ ...sel, expectedPromotionVersion: "2" }).success).toBe(true);
  });

  it("requires an exact-version confirmation to activate, and never a version label to mint", () => {
    expect(ActivateOfferInput.safeParse(sel).success).toBe(false);
    expect(ActivateOfferInput.safeParse({ ...sel, confirmation }).success).toBe(true);
    expect(ActivateOfferInput.safeParse({ ...sel, confirmation, effectiveUntil: "2028-01-01T00:00:00.000Z" }).success).toBe(true);
    for (const schema of [ReviseOfferTermsInput, ActivateOfferInput, SchedulePromotionInput]) {
      expect(Object.keys(schema.shape)).not.toContain("sourceRecordVersion");
    }
  });

  it("carries nothing when standing down — pausing or withdrawing asserts no terms", () => {
    expect(Object.keys(StandDownOfferInput.shape).sort()).toEqual(["now", "offerRef", "productRef"]);
    expect(StandDownOfferInput.safeParse({ ...sel, lifecycle: "PAUSED" }).success).toBe(false);
  });

  it("names no actor, participant, or lifecycle on any act input", () => {
    for (const schema of [
      CreateOfferInput,
      ReviseOfferTermsInput,
      ActivateOfferInput,
      StandDownOfferInput,
      ResumeOfferInput,
      SchedulePromotionInput,
      ReplacePromotionInput,
      EndPromotionInput,
    ]) {
      const keys = Object.keys(schema.shape);
      for (const forbidden of ["actingAccountId", "sellerParticipantId", "lifecycle", "availability", "internalOfferId"]) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });
});

describe("privacy and scope", () => {
  it("names every forbidden field, and the schema refuses each one", () => {
    for (const field of NEVER_ON_OFFER_RECORD) {
      expect(CreateOfferInput.safeParse(createInput({ [field]: "x" })).success).toBe(false);
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
    /* Six from 0M.6, plus OfferAct's two (Phase 1.42): its Offer and its actor. */
    expect(relations.length).toBe(8);
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
  it("holds exactly the terms-only members of OfferSourceVersion (Phase 1.42)", () => {
    /* The persisted shape must be exactly the contract shape. Phase 1.42 removed
       lifecycle, availability, and the effective interval (lifecycle is Seller
       authority, recorded as acts) and added the terms kind, the promotion
       window, and the promotion's standing basis — and nothing else. */
    const members = Object.keys(OfferSourceVersion._def.shape ?? {});
    expect(members.sort()).toEqual(
      [
        "authorizedByActorId",
        "authorizedBySellerParticipantId",
        "basisStandingVersion",
        "economics",
        "internalOfferId",
        "internalProductId",
        "offerSourceRecordId",
        "promotionWindow",
        "recordedAt",
        "sellerParticipantId",
        "sourceClass",
        "sourceRecordType",
        "sourceRecordVersion",
        "sourceSystem",
        "supersedesSourceRecordVersion",
        "terms",
        "termsKind",
      ].sort(),
    );
  });

  it("names the projection-eligible fields (lifecycle now a recorded context value)", () => {
    expect([...PROJECTION_ELIGIBLE_OFFER_FIELDS]).toEqual([
      "internalOfferId",
      "internalProductId",
      "sellerParticipantId",
      "lifecycle",
      "price",
      "promotion",
      "commission",
      "promotionWindow",
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
