/**
 * Listing persistence contracts and scope boundaries (Phase 0M.7).
 *
 * Offline. No database, no clock, no network — the DB behaviour lives in
 * `listing-persistence.integration.test.ts`.
 *
 * What this file is for: proving that persistence **added no Listing fact** and
 * **stored no derived value**. 0M.4A is the authority on what a Listing is, and
 * 0M.7 exists only to store it. The derived-value tests matter most: a stored
 * effective price or a stored proceeds figure would be a second answer that goes
 * stale, and a stored effective price would additionally mean a sale starting
 * required a database write.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CreatePromotedListingInput,
  CreateSellerDirectListingInput,
  DEFERRED_LISTING_PERSISTENCE_EXTENSIONS,
  NEVER_ON_LISTING_RECORD,
  UpdateListingInput,
  materialListingChangesBetween,
} from "../src/contracts/marketplace/listing-record";
import {
  ListingSourceVersion,
  MATERIAL_LISTING_FIELDS,
  effectiveSellerRetailPrice,
} from "../src/contracts/marketplace/listing-source";
import { LISTING_ID_PATTERNS } from "../src/server/marketplace/listing-ids";

const source = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

/**
 * Strip comments before asserting absence.
 *
 * The same helper the Storefront and participant suites use, and needed for the
 * same reason: these modules DOCUMENT the fields they refuse, so a naive
 * substring search finds `currentPrice` in the very comment promising there is
 * no such column. Asserting against code alone is the honest check.
 */
const codeOnly = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");

const SCHEMA = source("../prisma/schema.prisma");
const SCHEMA_CODE = codeOnly(SCHEMA).replace(/^\s*\/\/\/.*$/gm, "");
const RECORD_CODE = codeOnly(source("../src/contracts/marketplace/listing-record.ts"));
const SERVICE_CODE = codeOnly(source("../src/server/marketplace/listing-service.ts"));

/**
 * The Listing models alone, extracted BY NAME rather than by slicing to the end
 * of the schema.
 *
 * The earlier slice took everything after `model Listing {`, which quietly
 * included whatever a later phase appended — 0M.T1's transaction accounting
 * tables legitimately carry `monacadoRetained`, `sellerProceeds`, and
 * `taxAmount` columns, and the slice would have read them as Listing columns.
 * Extracting the two models by name makes every claim below about the Listing
 * tables and nothing else, which is what it always meant.
 */
const LISTING_TABLES = [...SCHEMA_CODE.matchAll(/model (Listing\w*) \{[\s\S]*?\n\}/g)]
  .map((m) => m[0])
  .join("\n");

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const PRODUCT = `mon:product:${pad26("M7PR0DUCT")}`;
const STOREFRONT = `mon:storefront:${pad26("M7ST0RE")}`;
const PARTICIPANT = `mon:mpart:${pad26("M7PART")}`;
const ACTOR = `mon:actor:${pad26("M7ACT0R")}`;

const retail = { retailPriceMinorUnits: 10_000, retailPriceCurrency: "USD" };

const sellerDirectInput = (overrides: Record<string, unknown> = {}) => ({
  storefrontId: STOREFRONT,
  internalProductId: PRODUCT,
  controllingParticipantId: PARTICIPANT,
  retail,
  actingAccountId: "acct_synthetic_0m7",
  authorizedByActorId: ACTOR,
  now: "2027-11-01T09:00:00.000Z",
  ...overrides,
});

const policy = {
  policyId: "mon:policy:acquisition/test",
  policyVersion: "1",
  currency: "USD",
  retainedPercentageBasisPoints: 750,
  retainedFixedAmountMinorUnits: 100,
  roundingPolicy: "HALF_UP_TO_MINOR_UNIT" as const,
};

const promotedInput = (overrides: Record<string, unknown> = {}) => ({
  storefrontId: STOREFRONT,
  internalProductId: PRODUCT,
  controllingParticipantId: PARTICIPANT,
  retail: { retailPriceMinorUnits: 12_500, retailPriceCurrency: "USD" },
  acceptedOfferSourceRecordId: `mon:srec:${pad26("M7OFFERSREC")}`,
  acceptedOfferSourceRecordVersion: "3",
  acquisitionPolicy: policy,
  actingAccountId: "acct_synthetic_0m7",
  authorizedByActorId: ACTOR,
  now: "2027-11-01T09:00:00.000Z",
  ...overrides,
});

// — 1 —

describe("create inputs", () => {
  it("accepts a well-formed seller-direct input", () => {
    expect(CreateSellerDirectListingInput.safeParse(sellerDirectInput()).success).toBe(true);
  });

  it("accepts a well-formed promoted input", () => {
    expect(CreatePromotedListingInput.safeParse(promotedInput()).success).toBe(true);
  });

  it("keeps the branches structurally distinct at the input boundary", () => {
    /* 0M.4A makes the two impossible to confuse. A seller-direct input has
       nowhere to put an Offer dependency, and a promoted input has nowhere to
       put a sale — not "rejected by a rule", but no field at all. */
    expect(
      CreateSellerDirectListingInput.safeParse(
        sellerDirectInput({ acceptedOfferSourceRecordVersion: "3" }),
      ).success,
    ).toBe(false);
    expect(
      CreatePromotedListingInput.safeParse(
        promotedInput({
          sale: {
            salePriceMinorUnits: 9_000,
            salePriceCurrency: "USD",
            saleStartsAt: "2027-12-01T00:00:00.000Z",
            saleEndsAt: "2027-12-08T00:00:00.000Z",
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("has NO input for lifecycle — a Listing starts DRAFT and going live is a separate act", () => {
    expect(
      CreateSellerDirectListingInput.safeParse(sellerDirectInput({ lifecycle: "ACTIVE" })).success,
    ).toBe(false);
  });

  it("has NO input for identity — it is minted, never supplied", () => {
    expect(
      CreateSellerDirectListingInput.safeParse(
        sellerDirectInput({ internalListingId: `mon:listing:${pad26("X")}` }),
      ).success,
    ).toBe(false);
  });

  it("requires the acquisition policy on the promoted branch, and never stores it on a Listing", () => {
    const { acquisitionPolicy: _drop, ...without } = promotedInput();
    expect(CreatePromotedListingInput.safeParse(without).success).toBe(false);

    /* Supplied per call so a commercial decision never becomes LISTING state.
       Narrowed at Phase 0M.R1 rather than deleted, on the same reasoning as the
       Order/Review assertion in participant-record: what 0M.4A actually claims
       is that a Listing stores no policy, and that still holds. 0M.R1 gave the
       policy its own authoritative home on `CommercialPolicyVersionRow`, which
       is where an immutable versioned rate belongs — a future Order binds to
       (policyId, policyVersion) there, never to a copy on a Listing. */
    const listingModels = [...SCHEMA_CODE.matchAll(/model (Listing\w*) \{[\s\S]*?\n\}/g)].map(
      (m) => m[0],
    );
    expect(listingModels.length).toBeGreaterThan(0);
    for (const model of listingModels) {
      expect(model).not.toContain("retainedPercentageBasisPoints");
      expect(model).not.toContain("retainedFixedAmountMinorUnits");
      expect(model).not.toContain("acquisitionPolicyId");
      expect(model).not.toContain("roundingPolicy");
    }
    expect(SCHEMA_CODE).not.toContain("acquisitionPolicyId");
  });

  it("does not accept a caller-supplied accepted wholesale price", () => {
    /* The accepted economics are read FROM the persisted Offer version. A
       caller-supplied number could disagree with the Offer actually accepted,
       which is the divergence the exact binding exists to prevent. */
    expect(
      CreatePromotedListingInput.safeParse(
        promotedInput({ acceptedWholesalePriceMinorUnits: 5_000 }),
      ).success,
    ).toBe(false);
  });

  it("refuses a non-opaque actor id, so an email can never become an actor", () => {
    expect(
      CreateSellerDirectListingInput.safeParse(
        sellerDirectInput({ authorizedByActorId: "seller@example.com" }),
      ).success,
    ).toBe(false);
  });
});

// — 2 —

describe("update input", () => {
  const update = (overrides: Record<string, unknown> = {}) => ({
    internalListingId: `mon:listing:${pad26("M7LSTNG")}`,
    sourceRecordVersion: "2",
    actingAccountId: "acct_synthetic_0m7",
    authorizedByActorId: ACTOR,
    now: "2027-11-02T09:00:00.000Z",
    ...overrides,
  });

  it("accepts an update stating only what changes", () => {
    expect(UpdateListingInput.safeParse(update({ lifecycle: "WITHDRAWN" })).success).toBe(true);
  });

  it("requires an explicit new version label", () => {
    const { sourceRecordVersion: _drop, ...without } = update();
    expect(UpdateListingInput.safeParse(without).success).toBe(false);
  });

  it("cannot reassign Product, Storefront, or controller through an update", () => {
    /* All three are material fields on the source version, but none is a member
       of the update input: re-pointing a Listing at another Product, Storefront,
       or controller is not an edit — it is a different placement. */
    for (const field of ["internalProductId", "storefrontId", "controllingParticipantId"]) {
      expect(UpdateListingInput.safeParse(update({ [field]: PRODUCT })).success).toBe(false);
    }
  });

  it("rebinds an Offer only by naming a new EXACT version", () => {
    expect(
      UpdateListingInput.safeParse(
        update({ acceptedOfferSourceRecordVersion: "4", acquisitionPolicy: policy }),
      ).success,
    ).toBe(true);
    /* There is deliberately no "rebind to current" flag: an accepted version
       moves only when someone names the version they are accepting. */
    expect(RECORD_CODE).not.toContain("rebindToCurrent");
    expect(RECORD_CODE).not.toContain("followCurrentOfferVersion");
  });
});

// — 3 —

describe("derived values are never stored", () => {
  it("names every forbidden field, and the schema refuses each one", () => {
    for (const field of NEVER_ON_LISTING_RECORD) {
      expect(
        CreateSellerDirectListingInput.safeParse(sellerDirectInput({ [field]: "x" })).success,
      ).toBe(false);
    }
    expect(NEVER_ON_LISTING_RECORD.length).toBeGreaterThan(40);
  });

  it("stores no effective price, sale-active flag, or priced-at instant", () => {
    /* The reason a sale starting or ending needs no database write. */
    const listingTables = LISTING_TABLES;
    for (const forbidden of [
      "currentPrice",
      "effectivePrice",
      "pricedAt",
      "saleIsActive",
      "saleActive",
      "isBuyerActive",
    ]) {
      expect(listingTables).not.toContain(forbidden);
    }
  });

  it("stores no MoR or promoter economics", () => {
    const listingTables = LISTING_TABLES;
    for (const forbidden of [
      "monacadoRetained",
      "morWholesaleAcquisition",
      "sellerProceeds",
      "promoterRetailSpread",
      "promoterNetProceeds",
      "promoterMarginRate",
      "minimumViable",
    ]) {
      expect(listingTables).not.toContain(forbidden);
    }
  });

  it("stores no tax, shipping, or checkout total", () => {
    /* Outside every basis 0M.4A defines — structurally, not as a rule to remember. */
    const listingTables = LISTING_TABLES;
    for (const forbidden of [
      "taxAmount",
      "checkoutTax",
      "vatAmount",
      "gstAmount",
      "shippingAmount",
      "freightAmount",
      "checkoutTotal",
    ]) {
      expect(listingTables).not.toContain(forbidden);
    }
  });

  it("stores no capsule, Node, mapping, or publication column", () => {
    const listingTables = LISTING_TABLES;
    for (const forbidden of [
      "capsuleId",
      "nodeId",
      "listingNode",
      "mappingVersion",
      "contentHash",
      "publicationState",
    ]) {
      expect(listingTables).not.toContain(forbidden);
    }
  });

  it("hard-codes no Monacado retail policy — 0M.R supplies it", () => {
    for (const forbidden of ["92.5", "0.925", "9250", "retainedPercentageBasisPoints: 750"]) {
      expect(RECORD_CODE).not.toContain(forbidden);
      expect(SERVICE_CODE).not.toContain(forbidden);
    }
  });
});

// — 4 —

describe("schema shape", () => {
  it("makes every Listing foreign key RESTRICT — history is never cascade-deleted", () => {
    const listingTables = LISTING_TABLES;
    const relations = listingTables.match(/@relation\([^)]*onDelete: \w+/g) ?? [];
    expect(relations.length).toBe(10);
    for (const relation of relations) expect(relation).toContain("onDelete: Restrict");
    expect(listingTables).not.toContain("onDelete: Cascade");
  });

  it("binds the accepted Offer version by a COMPOSITE key onto the exact version row", () => {
    /* The requirement of the whole promoted branch, made structural: a Listing
       cannot name an Offer version that does not exist, and that version cannot
       be deleted while the Listing depends on it. */
    const listingTables = LISTING_TABLES;
    expect(listingTables).toContain(
      "fields: [acceptedOfferSourceRecordId, acceptedOfferSourceRecordVersion]",
    );
    expect(listingTables).toContain("references: [offerSourceRecordId, sourceRecordVersion]");
  });

  it("mints a version label once per source record", () => {
    expect(SCHEMA_CODE).toContain("@@unique([listingSourceRecordId, sourceRecordVersion])");
  });

  it("keeps the discriminator NOT NULL and both branch arms nullable", () => {
    const versionTable = SCHEMA_CODE.slice(
      SCHEMA_CODE.indexOf("model ListingSourceRecordVersionRow {"),
    );
    expect(versionTable).toMatch(/listingType\s+String\s+@db\.VarChar\(16\)/);
    expect(versionTable).toMatch(/salePriceMinorUnits\s+BigInt\?/);
    expect(versionTable).toMatch(/acceptedOfferSourceRecordVersion\s+String\?/);
    /* Retail is on BOTH branches, so it is NOT NULL. */
    expect(versionTable).toMatch(/retailPriceMinorUnits\s+BigInt\b/);
  });

  it("adds no reverse Listing column to the Storefront tables", () => {
    /* 0M.3A: Listings reference Storefronts, never the reverse. The Prisma
       back-relation is a required virtual field, not a column. */
    const storefrontBlock = SCHEMA_CODE.slice(
      SCHEMA_CODE.indexOf("model Storefront {"),
      SCHEMA_CODE.indexOf("model StorefrontSourceRecordVersionRow {"),
    );
    expect(storefrontBlock).not.toContain("internalListingId");
    expect(storefrontBlock).not.toContain("retailPrice");
    expect(storefrontBlock).not.toContain("listingCount");
  });
});

// — 5 —

describe("identity", () => {
  it("mints an opaque internal Listing id that is never a Node", () => {
    expect(LISTING_ID_PATTERNS.listing.source).toContain("mon:listing:");
    expect(LISTING_ID_PATTERNS.sourceRecord.source).toContain("mon:srec:");
  });

  it("derives identity from no business fact", () => {
    const idsModule = readFileSync(
      new URL("../src/server/marketplace/listing-ids.ts", import.meta.url),
      "utf8",
    );
    expect(idsModule).toContain("randomBytes");
    const generator = idsModule.split("export const cryptoListingIdProvider")[1]!;
    for (const fact of ["retail", "product", "storefront", "listingType", "participant"]) {
      expect(generator.toLowerCase()).not.toContain(fact);
    }
  });
});

// — 6 —

describe("material change uses 0M.4A's own vocabulary", () => {
  const base = {
    storefrontId: STOREFRONT,
    internalProductId: PRODUCT,
    controllingParticipantId: PARTICIPANT,
    lifecycle: "DRAFT" as const,
    placement: { listingType: "SELLER_DIRECT" as const, retail, sale: null },
  };

  it("reports no change when nothing material moved", () => {
    expect(materialListingChangesBetween(base, base)).toEqual([]);
  });

  it("detects a retail price change", () => {
    const next = {
      ...base,
      placement: {
        ...base.placement,
        retail: { retailPriceMinorUnits: 11_000, retailPriceCurrency: "USD" },
      },
    };
    expect(materialListingChangesBetween(base, next)).toEqual(["retailPrice"]);
  });

  it("detects a lifecycle change", () => {
    expect(materialListingChangesBetween(base, { ...base, lifecycle: "ACTIVE" })).toEqual([
      "lifecycle",
    ]);
  });

  it("detects a sale schedule appearing", () => {
    const next = {
      ...base,
      placement: {
        ...base.placement,
        sale: {
          salePriceMinorUnits: 8_000,
          salePriceCurrency: "USD",
          saleStartsAt: "2027-12-01T00:00:00.000Z",
          saleEndsAt: "2027-12-08T00:00:00.000Z",
        },
      },
    };
    expect(materialListingChangesBetween(base, next)).toEqual(["saleSchedule"]);
  });

  it("is driven by MATERIAL_LISTING_FIELDS, so the two cannot drift", () => {
    /* Not a second classification: 0M.4A declares the vocabulary and ships no
       comparator, so persistence supplies one over that exact constant. */
    expect(MATERIAL_LISTING_FIELDS.length).toBe(10);
    for (const field of MATERIAL_LISTING_FIELDS) {
      expect(RECORD_CODE).toContain(`case "${field}":`);
    }
  });
});

// — 7 —

describe("effective price stays a pure derivation", () => {
  const placement = {
    listingType: "SELLER_DIRECT" as const,
    retail,
    sale: {
      salePriceMinorUnits: 8_000,
      salePriceCurrency: "USD",
      saleStartsAt: "2027-12-01T00:00:00.000Z",
      saleEndsAt: "2027-12-08T00:00:00.000Z",
    },
  };

  it("is the ordinary price before the window", () => {
    const p = effectiveSellerRetailPrice({ placement, now: "2027-11-30T23:59:59.999Z" });
    expect(p).toEqual({ effectivePriceMinorUnits: 10_000, currency: "USD", saleActive: false });
  });

  it("is the sale price inside the window, start INCLUSIVE", () => {
    const p = effectiveSellerRetailPrice({ placement, now: "2027-12-01T00:00:00.000Z" });
    expect(p).toEqual({ effectivePriceMinorUnits: 8_000, currency: "USD", saleActive: true });
  });

  it("is the ordinary price at the end instant, end EXCLUSIVE", () => {
    /* Half-open, so two consecutive sales cannot both be active for the instant
       they touch. */
    const p = effectiveSellerRetailPrice({ placement, now: "2027-12-08T00:00:00.000Z" });
    expect(p).toEqual({ effectivePriceMinorUnits: 10_000, currency: "USD", saleActive: false });
  });

  it("the service reads no clock — every instant is supplied", () => {
    expect(SERVICE_CODE).not.toContain("Date.now(");
    expect(SERVICE_CODE).not.toMatch(/new Date\(\s*\)/);
    expect(SERVICE_CODE).not.toContain("Math.random(");
    expect(SERVICE_CODE).not.toContain("process.env");
  });
});

// — 8 —

describe("the source model was not widened", () => {
  it("adds no member to ListingSourceVersion", () => {
    const members = Object.keys(ListingSourceVersion._def.shape ?? {});
    expect(members.sort()).toEqual(
      [
        "authorizedByActorId",
        "authorizedByParticipantId",
        "controllingParticipantId",
        "internalListingId",
        "internalProductId",
        "lifecycle",
        "listingSourceRecordId",
        "placement",
        "recordedAt",
        "sourceClass",
        "sourceRecordType",
        "sourceRecordVersion",
        "sourceSystem",
        "storefrontId",
        "supersedesSourceRecordVersion",
      ].sort(),
    );
  });

  it("defers Node issuance, publication, and checkout by name", () => {
    for (const deferred of [
      "listingNode",
      "nodeIssuance",
      "publicationState",
      "checkout",
      "orderRecords",
      "taxCalculation",
      "shippingExecution",
      "fulfillment",
      "inventoryCustody",
    ]) {
      expect(DEFERRED_LISTING_PERSISTENCE_EXTENSIONS as readonly string[]).toContain(deferred);
    }
  });

  it("creates no Listing Node, publication, or Checkout table", () => {
    /* `model Order` was dropped from this list when Phase 0M.9 built it, on the
       same reasoning 0M.3C and 0M.5 used before: what 0M.7 claims is that *it*
       added none of these, and the remaining three are still absent. An Order
       references a Listing source version; the Listing restates no order fact. */
    for (const model of [
      "model ListingNode",
      "model ListingPublication",
      "model Checkout",
    ]) {
      expect(SCHEMA_CODE).not.toContain(model);
    }
  });
});
