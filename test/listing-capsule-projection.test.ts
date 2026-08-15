/**
 * Listing Capsule Projection Shape tests (Phase 0M.4B).
 *
 * Offline: no database, no network, no clock. Every instant is supplied.
 *
 * The privacy assertions are **allow-list first**: the capsule's `data` keys are
 * compared against one declared list, so a new field is a test failure the moment
 * it appears. The value scan for internal identifiers and the economics denylist
 * are backstops — they catch a copy-pasted id or a well-meaning "just show the
 * margin" change, and neither is the boundary being relied on.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { canonicalJsonString } from "../src/contracts/integrity/canonical-json";
import { FORBIDDEN_INTERNAL_ID_PREFIXES } from "../src/contracts/capsule/internal-identifiers";
import {
  LISTING_TYPE,
  ListingCapsuleDataBase,
  ListingCapsuleProjection,
  NEVER_IN_LISTING_CAPSULE,
  PUBLIC_LISTING_CAPSULE_FIELDS,
  PUBLIC_PROMOTED_PRICE_FIELDS,
  PUBLIC_SELLER_DIRECT_PRICE_FIELDS,
  PublicPromotedPrice,
  PublicSellerDirectPrice,
  PUBLIC_SALE_SCHEDULE_FIELDS,
  PromotedListingData,
  PublicSaleSchedule,
  SellerDirectListingData,
  effectivePublicListingPrice,
  validateListingCapsuleProjection,
} from "../src/contracts/marketplace/listing.capsule";
import {
  LISTING_PROJECTION_MAPPING_VERSION,
  SUPPORTED_LISTING_CAPSULE_VERSION,
  ListingProjectionError,
  ListingProjectionContext,
  listingSourceRecordToCapsuleProjection,
  verifyListingCapsuleProjection,
} from "../src/contracts/marketplace/listing.projection";
import {
  evaluateListingBuyerEligibility,
  type ListingSourceVersion,
} from "../src/contracts/marketplace/listing-source";
import {
  syntheticListingProjectionContext,
  syntheticListingSourceVersion,
  syntheticPromotedListingSourceVersion,
} from "../src/contracts/fixtures/synthetic-listing";

const body = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);
const ansNode = (seed: string): string => `an:node:${body(seed)}`;

const SOURCE_PATH = new URL(
  "../src/contracts/marketplace/listing.projection.ts",
  import.meta.url,
).pathname;
const CAPSULE_PATH = new URL(
  "../src/contracts/marketplace/listing.capsule.ts",
  import.meta.url,
).pathname;

const codeOnly = (text: string): string =>
  text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");

const seller = (overrides: Partial<ListingSourceVersion> = {}): ListingSourceVersion => ({
  ...syntheticListingSourceVersion(),
  ...overrides,
});

const promoted = (overrides: Partial<ListingSourceVersion> = {}): ListingSourceVersion => ({
  ...syntheticPromotedListingSourceVersion(),
  ...overrides,
});

type ProjectionContext = z.infer<typeof ListingProjectionContext>;

const context = (
  overrides: Partial<ProjectionContext> = {},
): ProjectionContext => ({
  ...syntheticListingProjectionContext(),
  ...overrides,
});

const upstream = (overrides: Record<string, unknown> = {}) =>
  context({
    upstream: { ...syntheticListingProjectionContext().upstream, ...overrides },
  });

const project = (
  sourceVersion: ListingSourceVersion = seller(),
  ctx: ProjectionContext = context(),
) => listingSourceRecordToCapsuleProjection({ sourceVersion, context: ctx });

/** Every string value reachable in a value, for leak assertions. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => allStrings(v, out));
  else if (value !== null && typeof value === "object") {
    Object.values(value).forEach((v) => allStrings(v, out));
  }
  return out;
}

// — 1/2. Valid projections —

describe("1/2. both Listing types project", () => {
  it("1. a seller-direct source version produces a valid capsule", () => {
    const capsule = project(seller());
    expect(validateListingCapsuleProjection(capsule).ok).toBe(true);
    expect(capsule.data.listingType).toBe("SELLER_DIRECT");
  });

  it("2. a promoted source version produces a valid capsule", () => {
    const capsule = project(promoted());
    expect(validateListingCapsuleProjection(capsule).ok).toBe(true);
    expect(capsule.data.listingType).toBe("PROMOTED");
  });

  it("carries exactly the four ANS top-level members", () => {
    expect(Object.keys(project()).sort()).toEqual(["@context", "@type", "data", "metadata"]);
  });

  it("declares the Listing type", () => {
    expect(project()["@type"]).toBe(LISTING_TYPE);
  });

  it("carries a content hash over the published shape", () => {
    expect(project().metadata.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("pins the capsule and mapping versions", () => {
    expect(SUPPORTED_LISTING_CAPSULE_VERSION).toBe("1.0.0");
    expect(LISTING_PROJECTION_MAPPING_VERSION).toBe("listing-projection/1.0.0");
    for (const [field, value] of [
      ["capsuleVersion", "2.0.0"],
      ["mappingVersion", "listing-projection/9.9.9"],
    ] as const) {
      try {
        project(seller(), context({ [field]: value } as Partial<ProjectionContext>));
        throw new Error("expected a projection error");
      } catch (error) {
        expect((error as ListingProjectionError).code).toMatch(/^UNSUPPORTED_/);
      }
    }
  });
});

// — 3-5. Determinism —

describe("3-5. mapping is deterministic and order-independent", () => {
  it("3. is byte-identical across repeated projections", () => {
    expect(JSON.stringify(project())).toBe(JSON.stringify(project()));
  });

  it("4. never mutates the source version or the context", () => {
    const src = seller();
    const ctx = context();
    const srcBefore = JSON.stringify(src);
    const ctxBefore = JSON.stringify(ctx);
    project(src, ctx);
    expect(JSON.stringify(src)).toBe(srcBefore);
    expect(JSON.stringify(ctx)).toBe(ctxBefore);
  });

  it("5. produces the same hash for a reordered but equal source version", () => {
    const original = seller();
    const reordered = Object.fromEntries(
      Object.entries(original).reverse(),
    ) as unknown as ListingSourceVersion;
    expect(canonicalJsonString(original)).toBe(canonicalJsonString(reordered));
    expect(project(reordered).metadata.contentHash).toBe(project(original).metadata.contentHash);
  });

  it("5b. produces the same hash for a reordered projection context", () => {
    const ctx = context();
    const reordered = Object.fromEntries(
      Object.entries(ctx).reverse(),
    ) as unknown as ProjectionContext;
    expect(project(seller(), reordered).metadata.contentHash).toBe(
      project(seller(), ctx).metadata.contentHash,
    );
  });

  it("verifies against its own re-derivation, and detects a stale-hash edit", () => {
    const capsule = project();
    const ok = verifyListingCapsuleProjection({
      sourceVersion: seller(),
      context: context(),
      capsule,
    });
    expect(ok.matches).toBe(true);
    expect(ok.storedContentHashConsistent).toBe(true);

    const tampered = { ...capsule, data: { ...capsule.data, listingType: "PROMOTED" as const } };
    const bad = verifyListingCapsuleProjection({
      sourceVersion: seller(),
      context: context(),
      capsule: tampered,
    });
    expect(bad.matches).toBe(false);
    expect(bad.storedContentHashConsistent).toBe(false);
  });
});

// — 6-9. Node bindings are supplied —

describe("6-9. every public relationship comes from a supplied binding", () => {
  it("6. binds to the supplied Listing Node", () => {
    const ctx = context();
    expect(project(seller(), ctx).metadata.bindsToNode).toBe(ctx.listingBinding.listingNode);
  });

  it("7/8/9. publishes the supplied Product, Storefront, and authority Nodes", () => {
    const ctx = context();
    const rel = project(seller(), ctx).data.relationships;
    expect(rel.offeredProduct).toBe(ctx.productBinding.productNode);
    expect(rel.listedInStorefront).toBe(ctx.storefrontBinding.storefrontNode);
    expect(rel.operatedBy).toBe(ctx.controllerBinding.controllerAuthorityNode);
  });

  it("fabricates no Node — every relationship value came from the context", () => {
    const ctx = context();
    const supplied = new Set([
      ctx.listingBinding.listingNode,
      ctx.productBinding.productNode,
      ctx.storefrontBinding.storefrontNode,
      ctx.controllerBinding.controllerAuthorityNode,
    ]);
    const capsule = project(seller(), ctx);
    for (const value of allStrings(capsule)) {
      if (value.startsWith("an:node:")) expect(supplied.has(value)).toBe(true);
    }
  });

  it("refuses each mismatched binding with its own code", () => {
    const cases: Array<[Partial<ProjectionContext>, string]> = [
      [
        {
          listingBinding: {
            listingNode: ansNode("X1"),
            internalListingId: `mon:listing:${body("OTHERLSTNG")}`,
          },
        },
        "LISTING_BINDING_MISMATCH",
      ],
      [
        {
          productBinding: {
            productNode: ansNode("X2"),
            internalProductId: `mon:product:${body("OTHERPRDCT")}`,
          },
        },
        "PRODUCT_BINDING_MISMATCH",
      ],
      [
        {
          storefrontBinding: {
            storefrontNode: ansNode("X3"),
            storefrontId: `mon:storefront:${body("OTHERSTFRNT")}`,
          },
        },
        "STOREFRONT_BINDING_MISMATCH",
      ],
      [
        {
          controllerBinding: {
            controllerAuthorityNode: ansNode("X4"),
            controllingParticipantId: `mon:mpart:${body("OTHERPART")}`,
          },
        },
        "CONTROLLER_BINDING_MISMATCH",
      ],
      [
        {
          sourceVersionBinding: {
            listingSourceRecordId: syntheticListingSourceVersion().listingSourceRecordId,
            sourceRecordVersion: "99",
          },
        },
        "SOURCE_VERSION_BINDING_MISMATCH",
      ],
    ];
    for (const [override, code] of cases) {
      try {
        project(seller(), context(override));
        throw new Error(`expected ${code}`);
      } catch (error) {
        expect((error as ListingProjectionError).code).toBe(code);
      }
    }
  });
});

// — 10-14. Internal identifiers —

describe("10-14. internal identifiers stay internal", () => {
  const capsule = project(promoted());
  const dataSerialized = JSON.stringify(capsule.data);
  const serialized = JSON.stringify(capsule);

  it("10. does not leak mon:listing:", () => {
    expect(serialized).not.toContain("mon:listing:");
  });

  it("11. does not leak a participant identifier", () => {
    for (const prefix of ["mon:mpart:", "mon:mrole:", "mon:mprof:", "mon:acct:"]) {
      expect(serialized).not.toContain(prefix);
    }
  });

  it("12. does not leak an internal Product identifier", () => {
    expect(serialized).not.toContain("mon:product:");
  });

  it("13. does not leak an internal Storefront identifier", () => {
    expect(serialized).not.toContain("mon:storefront:");
  });

  it("13b. does not leak an internal Offer identifier", () => {
    expect(serialized).not.toContain("mon:offer:");
  });

  it("14. permits mon:srec: only in provenance, the approved traceability pattern", () => {
    expect(capsule.metadata.provenance.sourceRecordId).toContain("mon:srec:");
    expect(dataSerialized).not.toContain("mon:srec:");
  });

  it("reuses the shared guard, which already covers every Listing-side prefix", () => {
    for (const prefix of ["mon:listing:", "mon:offer:", "mon:storefront:", "mon:mpart:"]) {
      expect(FORBIDDEN_INTERNAL_ID_PREFIXES).toContain(prefix);
    }
    /* Deliberately absent, and must stay so: provenance depends on it. */
    expect(FORBIDDEN_INTERNAL_ID_PREFIXES).not.toContain("mon:srec:");
  });

  it("refuses an internal identifier smuggled into a public string field", () => {
    const leaky = {
      ...capsule,
      data: {
        ...capsule.data,
        relationships: { ...capsule.data.relationships, operatedBy: "mon:mpart:leaked" },
      },
    };
    expect(ListingCapsuleProjection.safeParse(leaky).success).toBe(false);
  });
});

// — 1-11. Public price is self-describing —

describe("1-11. public price semantics are self-describing across time", () => {
  /* The synthetic seller Listing is $100.00 ordinary with an $80.00 sale
     running 2026-03-01 (inclusive) to 2026-03-08 (exclusive). */

  const noSale = (): ListingSourceVersion => {
    const src = seller();
    if (src.placement.listingType === "SELLER_DIRECT") src.placement.sale = null;
    return src;
  };

  it("1. a seller-direct Listing with no sale publishes only the ordinary price", () => {
    const price = project(noSale()).data.price;
    expect(price.basePrice).toBe(10_000);
    expect(price.priceCurrency).toBe("USD");
    expect("sale" in price).toBe(false);
    expect(JSON.stringify(price)).not.toContain("null");
  });

  it("2. a scheduled sale publishes the ordinary price plus the complete schedule", () => {
    const capsule = project(seller());
    expect(capsule.data.listingType).toBe("SELLER_DIRECT");
    if (capsule.data.listingType !== "SELLER_DIRECT") throw new Error("unreachable");
    expect(capsule.data.price.basePrice).toBe(10_000);
    expect(capsule.data.price.sale).toEqual({
      salePrice: 8_000,
      validFrom: "2026-03-01T00:00:00.000Z",
      validThrough: "2026-03-08T00:00:00.000Z",
    });
  });

  it("3/4/5. sale price, start, and end are public only for SELLER_DIRECT", () => {
    const promotedCapsule = project(promoted());
    const serialized = JSON.stringify(promotedCapsule);
    for (const field of ["sale", "salePrice", "validFrom", "validThrough"]) {
      expect(serialized).not.toContain(field);
    }
    // The promoted price schema has no member for any of them.
    expect([...PUBLIC_PROMOTED_PRICE_FIELDS]).toEqual(["basePrice", "priceCurrency"]);
    expect(
      PublicPromotedPrice.safeParse({
        basePrice: 100,
        priceCurrency: "USD",
        sale: { salePrice: 50, validFrom: "2026-01-01T00:00:00.000Z", validThrough: "2026-02-01T00:00:00.000Z" },
      }).success,
    ).toBe(false);
  });

  it("6/7. a promoted Listing publishes the promoter's price and no seller sale", () => {
    const capsule = project(promoted());
    expect(capsule.data.listingType).toBe("PROMOTED");
    expect(capsule.data.price.basePrice).toBe(12_500);
    expect(Object.keys(capsule.data.price).sort()).toEqual([...PUBLIC_PROMOTED_PRICE_FIELDS].sort());
    // Neither the seller's ordinary price nor the seller's sale price appears.
    const serialized = JSON.stringify(capsule);
    expect(serialized).not.toContain("10000");
    expect(serialized).not.toContain("8000");
  });

  it("8. the helper uses the ordinary price before the sale", () => {
    const capsule = project(seller());
    expect(
      effectivePublicListingPrice({ price: capsule.data.price, now: "2026-02-01T00:00:00.000Z" }),
    ).toEqual({ effectivePriceMinorUnits: 10_000, priceCurrency: "USD", saleActive: false });
  });

  it("9. the helper uses the sale price exactly at the sale start (inclusive)", () => {
    const capsule = project(seller());
    expect(
      effectivePublicListingPrice({ price: capsule.data.price, now: "2026-03-01T00:00:00.000Z" }),
    ).toEqual({ effectivePriceMinorUnits: 8_000, priceCurrency: "USD", saleActive: true });
    // One millisecond earlier is still the ordinary price.
    expect(
      effectivePublicListingPrice({ price: capsule.data.price, now: "2026-02-28T23:59:59.999Z" })
        .effectivePriceMinorUnits,
    ).toBe(10_000);
  });

  it("10. the helper uses the sale price immediately before the sale end", () => {
    const capsule = project(seller());
    expect(
      effectivePublicListingPrice({ price: capsule.data.price, now: "2026-03-07T23:59:59.999Z" })
        .effectivePriceMinorUnits,
    ).toBe(8_000);
  });

  it("11. the helper uses the ordinary price exactly at the sale end (exclusive)", () => {
    const capsule = project(seller());
    expect(
      effectivePublicListingPrice({ price: capsule.data.price, now: "2026-03-08T00:00:00.000Z" }),
    ).toEqual({ effectivePriceMinorUnits: 10_000, priceCurrency: "USD", saleActive: false });
  });

  it("the helper never mutates its input and always returns integers", () => {
    const capsule = project(seller());
    const before = JSON.stringify(capsule.data.price);
    for (const now of ["2026-02-01T00:00:00.000Z", "2026-03-03T00:00:00.000Z"]) {
      const result = effectivePublicListingPrice({ price: capsule.data.price, now });
      expect(Number.isInteger(result.effectivePriceMinorUnits)).toBe(true);
    }
    expect(JSON.stringify(capsule.data.price)).toBe(before);
  });

  it("the helper reports no active sale for a promoted price", () => {
    const capsule = project(promoted());
    expect(
      effectivePublicListingPrice({ price: capsule.data.price, now: "2026-03-03T00:00:00.000Z" }),
    ).toEqual({ effectivePriceMinorUnits: 12_500, priceCurrency: "USD", saleActive: false });
  });

  it("13. the capsule does not go stale merely because a sale boundary passes", () => {
    /* One artifact, one hash, correct on both sides of every boundary — the whole
       point of publishing the schedule instead of a time-selected answer. */
    const capsule = project(seller());
    const derived = [
      "2026-02-01T00:00:00.000Z",
      "2026-03-01T00:00:00.000Z",
      "2026-03-07T23:59:59.999Z",
      "2026-03-08T00:00:00.000Z",
    ].map((now) => effectivePublicListingPrice({ price: capsule.data.price, now }));

    expect(derived.map((d) => d.effectivePriceMinorUnits)).toEqual([10_000, 8_000, 8_000, 10_000]);
    // The artifact itself never changed while producing all four answers.
    expect(project(seller()).metadata.contentHash).toBe(capsule.metadata.contentHash);
  });

  it("publishes no time-selected currentPrice", () => {
    expect(JSON.stringify(project(seller()))).not.toContain("currentPrice");
    expect(JSON.stringify(project(promoted()))).not.toContain("currentPrice");
  });

  it("prices in integer minor units, never a decimal", () => {
    /* Asserted on the monetary values themselves: the published sale schedule
       contains ISO instants, whose fractional seconds would defeat a blanket
       "no digit-dot-digit" scan over the serialized object. */
    for (const src of [seller(), promoted(), noSale()]) {
      const price = project(src).data.price;
      expect(Number.isInteger(price.basePrice)).toBe(true);
      if ("sale" in price && price.sale !== undefined) {
        expect(Number.isInteger(price.sale.salePrice)).toBe(true);
      }
    }
  });

  it("re-validates the source's own sale invariants rather than trusting them", () => {
    const capsule = project(seller());
    if (capsule.data.listingType !== "SELLER_DIRECT") throw new Error("unreachable");
    const price = capsule.data.price;
    // A sale price at or above the ordinary price is refused.
    expect(
      PublicSellerDirectPrice.safeParse({ ...price, sale: { ...price.sale!, salePrice: 10_000 } })
        .success,
    ).toBe(false);
    // An inverted window is refused.
    expect(
      PublicSellerDirectPrice.safeParse({
        ...price,
        sale: { ...price.sale!, validFrom: "2026-03-08T00:00:00.000Z", validThrough: "2026-03-01T00:00:00.000Z" },
      }).success,
    ).toBe(false);
    // A partial schedule cannot be expressed — the object is all-or-nothing.
    expect(
      PublicSellerDirectPrice.safeParse({ ...price, sale: { salePrice: 8_000 } }).success,
    ).toBe(false);
  });
});

// — 14/15. No pricing instant in the context —

describe("14/15. the projection needs no pricing instant", () => {
  it("14. pricedAt is absent from the projection context", () => {
    expect("pricedAt" in context()).toBe(false);
    expect(
      ListingProjectionContext.safeParse({ ...context(), pricedAt: "2026-03-03T00:00:00.000Z" })
        .success,
    ).toBe(false);
    const code = codeOnly(readFileSync(SOURCE_PATH, "utf8"));
    expect(code).not.toContain("pricedAt");
  });

  it("15. generatedAt is provenance only and never selects a price", () => {
    const early = project(seller(), context({ generatedAt: "2026-02-01T00:00:00.000Z" }));
    const late = project(seller(), context({ generatedAt: "2026-03-03T00:00:00.000Z" }));

    expect(early.metadata.provenance.generatedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(late.metadata.provenance.generatedAt).toBe("2026-03-03T00:00:00.000Z");
    // Moving the generation instant across the sale window changes no price.
    expect(early.data.price).toEqual(late.data.price);
  });
});

// — 23-38. Economic and privacy exclusions —

describe("23-38. no private economics, checkout amounts, or operational data", () => {
  const capsule = project(promoted());
  const serialized = JSON.stringify(capsule).toLowerCase();

  it("23-25. publishes no Monacado retained amount, acquisition amount, or policy identity", () => {
    for (const forbidden of [
      "retained",
      "acquisition",
      "morwholesale",
      "policyid",
      "policyversion",
      "basispoints",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("26/27. publishes no Offer wholesale price and no seller-funded commission", () => {
    for (const forbidden of ["wholesale", "commission"]) {
      expect(serialized).not.toContain(forbidden);
    }
    // The accepted wholesale amount from the fixture must not appear either.
    expect(JSON.stringify(capsule)).not.toContain("5000");
  });

  it("28-31. publishes no party settlement figure", () => {
    for (const forbidden of ["proceeds", "spread", "margin", "minimumviable"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("32-34. publishes no tax, shipping, or checkout total", () => {
    for (const forbidden of [
      "tax",
      "vat",
      "gst",
      "shipping",
      "freight",
      "delivery",
      "checkouttotal",
      "fulfillment",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("35/36. publishes no risk, underwriting, processor, or payment data", () => {
    for (const forbidden of [
      "risk",
      "underwriting",
      "stripe",
      "acct_",
      "card",
      "payout",
      "payment",
      "reserve",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("37. publishes no private participant profile data", () => {
    for (const forbidden of ["email", "profile", "legalname", "address", "phone"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("38. publishes no authorization trace and no Offer review internals", () => {
    for (const forbidden of [
      "authorizedby",
      "upstreamreviewstate",
      "acceptedoffer",
      "offerdependency",
      "blockingreason",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("refuses every named forbidden fact as a data key", () => {
    for (const forbidden of NEVER_IN_LISTING_CAPSULE) {
      expect(
        ListingCapsuleDataBase.safeParse({ ...capsule.data, [forbidden]: 1 }).success,
      ).toBe(false);
    }
  });

  it("carries no Offer relationship at all", () => {
    /* Deliberate: the Offer capsule publishes its own wholesale price, so a
       reference here would let a consumer subtract it from this retail price and
       recover the promoter's spread — a figure that is explicitly not public. */
    expect(Object.keys(project(promoted()).data.relationships)).toEqual([
      "offeredProduct",
      "listedInStorefront",
      "operatedBy",
    ]);
    expect(codeOnly(readFileSync(CAPSULE_PATH, "utf8"))).not.toContain("offerNode");
  });
});

// — 39-42. Strictness and purity —

describe("39-42. strictness, malformed inputs, and purity", () => {
  it("39. refuses an unknown public field", () => {
    expect(ListingCapsuleDataBase.safeParse({ ...project().data, extra: "x" }).success).toBe(
      false,
    );
    const capsule = project();
    expect(ListingCapsuleProjection.safeParse({ ...capsule, extra: 1 }).success).toBe(false);
    expect(
      ListingCapsuleProjection.safeParse({
        ...capsule,
        metadata: { ...capsule.metadata, publishedBy: "an:publisher:monacado" },
      }).success,
    ).toBe(false);
  });

  it("40. refuses a malformed source version", () => {
    const bad = { ...seller() } as Record<string, unknown>;
    delete bad.sourceRecordVersion;
    try {
      project(bad as unknown as ListingSourceVersion);
      throw new Error("expected a projection error");
    } catch (error) {
      expect((error as ListingProjectionError).code).toBe("INVALID_SOURCE_VERSION");
    }
  });

  it("41. refuses a malformed projection context", () => {
    try {
      project(seller(), { ...context(), surprise: true } as unknown as ProjectionContext);
      throw new Error("expected a projection error");
    } catch (error) {
      expect((error as ListingProjectionError).code).toBe("INVALID_PROJECTION_CONTEXT");
    }
    const missing = { ...context() } as Record<string, unknown>;
    delete missing.generatedAt;
    try {
      project(seller(), missing as unknown as ProjectionContext);
      throw new Error("expected a projection error");
    } catch (error) {
      expect((error as ListingProjectionError).code).toBe("INVALID_PROJECTION_CONTEXT");
    }
  });

  it("42. reads no clock, generates no randomness, and performs no I/O", () => {
    for (const path of [SOURCE_PATH, CAPSULE_PATH]) {
      const code = codeOnly(readFileSync(path, "utf8"));
      expect(code).not.toContain("Date.now(");
      expect(code).not.toContain("Math.random(");
      expect(code).not.toMatch(/new Date\(\s*\)/);
      expect(code).not.toContain("fetch(");
      expect(code).not.toContain("process.env");
      expect(code).not.toContain("PrismaClient");
      expect(code).not.toContain("getPrisma");
    }
  });

});

// — 43/44. Eligibility —

describe("43/44. only a purchasable Listing projects", () => {
  it("43. defers to the Listing source model's own eligibility decision", () => {
    /* The projection must not carry a second copy of the upstream rules. */
    const code = codeOnly(readFileSync(SOURCE_PATH, "utf8"));
    expect(code).toContain("evaluateListingBuyerEligibility");
    for (const reimplemented of [
      "isPubliclyAccessible(",
      'productAvailability !== "available"',
      'lifecycle !== "ACTIVE"',
    ]) {
      expect(code).not.toContain(reimplemented);
    }
  });

  it("44. refuses a Listing blocked by its own lifecycle", () => {
    for (const lifecycle of ["DRAFT", "SUSPENDED", "ENDED", "WITHDRAWN"] as const) {
      try {
        project(seller({ lifecycle }));
        throw new Error("expected a projection error");
      } catch (error) {
        expect((error as ListingProjectionError).code).toBe("NOT_PROJECTION_ELIGIBLE");
        expect((error as ListingProjectionError).reason).toBe("NOT_BUYER_ACTIVE");
      }
    }
  });

  it("44b. refuses a Listing blocked by any upstream entity", () => {
    const blocked: Array<Record<string, unknown>> = [
      { productAvailability: "discontinued" },
      { storefrontLifecycle: "SUSPENDED" },
      { storefrontVisibility: "PRIVATE" },
      { storefrontGoLiveApproval: "NOT_APPROVED" },
      { controllingParticipantStatus: "SUSPENDED" },
      { controllingRoleStatus: "DRAFT" },
    ];
    for (const override of blocked) {
      try {
        project(seller(), upstream(override));
        throw new Error(`expected a projection error for ${JSON.stringify(override)}`);
      } catch (error) {
        expect((error as ListingProjectionError).code).toBe("NOT_PROJECTION_ELIGIBLE");
      }
    }
  });

  it("44c. refuses a promoted Listing on an unselectable Offer or outstanding review", () => {
    try {
      project(promoted(), upstream({ offerAvailability: "TEMPORARILY_UNAVAILABLE" }));
      throw new Error("expected a projection error");
    } catch (error) {
      expect((error as ListingProjectionError).code).toBe("NOT_PROJECTION_ELIGIBLE");
    }

    const needsReview = promoted();
    if (needsReview.placement.listingType === "PROMOTED") {
      needsReview.placement.upstreamReviewState = "REVIEW_REQUIRED";
    }
    try {
      project(needsReview);
      throw new Error("expected a projection error");
    } catch (error) {
      expect((error as ListingProjectionError).code).toBe("NOT_PROJECTION_ELIGIBLE");
    }
  });

  it("44d. discloses only the coarse reason, never which entity blocked it", () => {
    try {
      project(seller(), upstream({ controllingParticipantStatus: "SUSPENDED" }));
    } catch (error) {
      const e = error as ListingProjectionError;
      expect(e.reason).toBe("NOT_BUYER_ACTIVE");
      const serialized = JSON.stringify({ message: e.message, code: e.code, reason: e.reason });
      for (const leaked of ["PARTICIPANT", "STOREFRONT", "PRODUCT", "OFFER", "mon:"]) {
        expect(serialized).not.toContain(leaked);
      }
    }
    /* The specific reasons remain available from the source model directly, for
       callers entitled to them. */
    const detail = evaluateListingBuyerEligibility({
      lifecycle: "ACTIVE",
      listingType: "SELLER_DIRECT",
      productAvailability: "available",
      storefrontExposure: {
        lifecycle: "ACTIVE",
        visibility: "PUBLIC",
        goLiveApproval: "APPROVED",
      },
      controllingParticipantStatus: "SUSPENDED",
      controllingRoleStatus: "ACTIVE",
    });
    expect(detail.blockingReasons).toContain("CONTROLLING_PARTICIPANT_NOT_ACTIVE");
  });

  it("publishes no availability field, because only available Listings project", () => {
    expect(Object.keys(project().data)).not.toContain("availability");
    expect(Object.keys(project().data)).not.toContain("buyerActive");
  });
});

// — 45. One-way —

describe("45. projection is one-way", () => {
  it("exports no inverse mapper", async () => {
    const projection = await import("../src/contracts/marketplace/listing.projection");
    const capsule = await import("../src/contracts/marketplace/listing.capsule");
    for (const name of [...Object.keys(projection), ...Object.keys(capsule)]) {
      expect(name).not.toMatch(/CapsuleToSource|capsuleTo|ToSourceRecord|applyCapsule|writeBack/i);
    }
  });
});

// — Allow-list is the boundary —

describe("the public allow-list is the privacy boundary", () => {
  it("matches the schema's own data keys exactly, on both branches", () => {
    for (const branch of [SellerDirectListingData, PromotedListingData]) {
      expect(Object.keys(branch.shape).sort()).toEqual([...PUBLIC_LISTING_CAPSULE_FIELDS].sort());
    }
  });

  it("21. the price allow-lists match their schemas exactly", () => {
    expect(Object.keys(PublicSellerDirectPrice.shape).sort()).toEqual(
      [...PUBLIC_SELLER_DIRECT_PRICE_FIELDS].sort(),
    );
    expect(Object.keys(PublicPromotedPrice.shape).sort()).toEqual(
      [...PUBLIC_PROMOTED_PRICE_FIELDS].sort(),
    );
    expect(Object.keys(PublicSaleSchedule.shape).sort()).toEqual(
      [...PUBLIC_SALE_SCHEDULE_FIELDS].sort(),
    );
  });

  it("equals the keys a projected Listing actually emits", () => {
    for (const src of [seller(), promoted()]) {
      expect(Object.keys(project(src).data).sort()).toEqual(
        [...PUBLIC_LISTING_CAPSULE_FIELDS].sort(),
      );
    }
  });

  it("gives every authoritative Listing fact an explicit disposition", () => {
    const disposition: Record<string, string> = {
      internalListingId: "consumed as the Listing Node binding (metadata.bindsToNode)",
      listingSourceRecordId: "provenance only (approved mon:srec: traceability)",
      sourceRecordVersion: "provenance only",
      supersedesSourceRecordVersion: "excluded — publication lineage, not a buyer fact",
      sourceSystem: "provenance only",
      sourceRecordType: "provenance only",
      sourceClass: "provenance only",
      storefrontId: "consumed as the Storefront Node binding (relationships.listedInStorefront)",
      internalProductId: "consumed as the Product Node binding (relationships.offeredProduct)",
      controllingParticipantId: "consumed as the authority Node binding (relationships.operatedBy)",
      lifecycle: "consumed by eligibility; never republished",
      placement: "listingType published; retail and sale published as data.price; offerDependency excluded",
      authorizedByParticipantId: "excluded — internal authorization trace",
      authorizedByActorId: "excluded — internal authorization trace",
      recordedAt: "provenance only (acquiredAt)",
    };
    expect(Object.keys(disposition).sort()).toEqual(Object.keys(seller()).sort());
  });
});
