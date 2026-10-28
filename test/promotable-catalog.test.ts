/**
 * Phase 1.43 — the Promotable Catalog contract and wording: query parsing,
 * search, ordering and the cursor, card summary, the browse gate, and how
 * commission is shown. Pure; the derivation is proven against a database in
 * `promotable-catalog.integration.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROMOTABLE_CATALOG_SORT,
  PROMOTABLE_CATALOG_NAME_SORT_PREFIX,
  PROMOTABLE_CATALOG_PAGE_SIZE,
  PROMOTABLE_CATALOG_SORTS,
  PromotableCatalogCursor,
  catalogSortValue,
  catalogSummary,
  compareCatalogPositions,
  matchesCatalogSearch,
  parseDollarAmount,
  parsePromotableCatalogQuery,
  promotableCatalogBrowseAllowed,
  type PromotableCatalogSortKeys,
} from "../src/contracts/marketplace/promotable-catalog";
import { PROMOTION_AUTHORIZATION_REQUEST_REFUSALS } from "../src/contracts/marketplace/promotion-authorization";
import {
  decodePromotableCatalogCursor,
  encodePromotableCatalogCursor,
} from "../src/server/marketplace/promotable-catalog-read-service";
import {
  formatBasisPoints,
  formatCatalogCommission,
  formatCatalogCommissionDetail,
  formatCatalogTermsLine,
} from "../app/promote/promote-copy";

const params = (q: Record<string, string>) => (name: string) => q[name];

describe("1.43 — catalog query parsing", () => {
  it("defaults to everything, newest first, no cursor", () => {
    expect(parsePromotableCatalogQuery(params({}))).toEqual({
      query: {
        q: null,
        deliveryMode: null,
        wholesaleMin: null,
        wholesaleMax: null,
        commissionMin: null,
        commissionMax: null,
        seller: null,
        sort: "NEWEST",
        cursor: null,
      },
      invalid: [],
    });
    expect(DEFAULT_PROMOTABLE_CATALOG_SORT).toBe("NEWEST");
    expect(PROMOTABLE_CATALOG_PAGE_SIZE).toBe(24);
  });

  it("reads every filter, normalising case and whitespace, dollars to minor units", () => {
    expect(
      parsePromotableCatalogQuery(
        params({
          q: "  stoneware   mug ",
          delivery: "digital",
          wholesaleMin: "10",
          wholesaleMax: "$40.5",
          commissionMin: "0.99",
          commissionMax: "12.00",
          seller: " M7KX ",
          sort: "commission_high",
        }),
      ),
    ).toEqual({
      query: {
        q: "stoneware mug",
        deliveryMode: "DIGITAL",
        wholesaleMin: 1000,
        wholesaleMax: 4050,
        commissionMin: 99,
        commissionMax: 1200,
        seller: "m7kx",
        sort: "COMMISSION_HIGH",
        cursor: null,
      },
      invalid: [],
    });
  });

  it("reports what it cannot read and drops it — except a seller, which then matches nothing", () => {
    const { query, invalid } = parsePromotableCatalogQuery(
      params({
        q: "x".repeat(101),
        delivery: "teleport",
        wholesaleMin: "ten",
        commissionMax: "1.234",
        seller: "Sam Seller",
        sort: "RANDOM",
        cursor: "not a cursor!",
      }),
    );
    expect(invalid.sort()).toEqual(["commissionMax", "cursor", "delivery", "q", "seller", "sort", "wholesaleMin"]);
    expect(query).toMatchObject({ q: null, deliveryMode: null, wholesaleMin: null, commissionMax: null, sort: "NEWEST", cursor: null });
    expect(query.seller).toBe("");
  });

  it("parses dollars exactly", () => {
    expect(parseDollarAmount("40")).toBe(4000);
    expect(parseDollarAmount("40.5")).toBe(4050);
    expect(parseDollarAmount("$0.07")).toBe(7);
    for (const bad of ["", "-1", "1.234", "1,000", "abc", "1e3"]) expect(parseDollarAmount(bad), bad).toBeNull();
  });
});

describe("1.43 — catalog search", () => {
  it("every word must match name, description, or seller mName — case- and accent-insensitive", () => {
    const fields = ["Café Mug", "Hand-thrown stoneware", "m7kx"];
    expect(matchesCatalogSearch(null, fields)).toBe(true);
    expect(matchesCatalogSearch("cafe", fields)).toBe(true);
    expect(matchesCatalogSearch("CAFÉ stoneware", fields)).toBe(true);
    expect(matchesCatalogSearch("M7KX", fields)).toBe(true);
    expect(matchesCatalogSearch("cafe teapot", fields)).toBe(false);
    expect(matchesCatalogSearch("mug", ["Mug", null, "m7kx"])).toBe(true);
  });

  it("summarises a description as its first line, cut on a word", () => {
    expect(catalogSummary(null)).toBeNull();
    expect(catalogSummary("   ")).toBeNull();
    expect(catalogSummary("14 oz artisan ceramic mug\nDishwasher safe.")).toBe("14 oz artisan ceramic mug");
    const long = catalogSummary("word ".repeat(60))!;
    expect(long.length).toBeLessThanOrEqual(140);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toMatch(/ …$/);
  });
});

describe("1.43 — ordering and the cursor", () => {
  const entry = (productRef: string, over: Partial<PromotableCatalogSortKeys> = {}): PromotableCatalogSortKeys => ({
    productRef,
    activatedAt: "2029-01-01T00:00:00.000Z",
    name: "Mug",
    sellerMName: "m7kx",
    wholesalePriceMinorUnits: 4000,
    calculatedCommissionMinorUnits: 400,
    ...over,
  });
  const order = (sort: (typeof PROMOTABLE_CATALOG_SORTS)[number], entries: PromotableCatalogSortKeys[]) =>
    [...entries]
      .sort((a, b) =>
        compareCatalogPositions(
          sort,
          { value: catalogSortValue(sort, a), productRef: a.productRef },
          { value: catalogSortValue(sort, b), productRef: b.productRef },
        ),
      )
      .map((e) => e.productRef);

  const A = "A".repeat(32);
  const B = "B".repeat(32);
  const C = "C".repeat(32);

  it("orders each sort, breaking every tie by productRef ascending", () => {
    const es = [
      entry(C, { activatedAt: "2029-01-03T00:00:00.000Z", name: "apple", sellerMName: "b2bb", wholesalePriceMinorUnits: 1000, calculatedCommissionMinorUnits: 900 }),
      entry(A, { activatedAt: "2029-01-01T00:00:00.000Z", name: "Banana", sellerMName: "a2aa", wholesalePriceMinorUnits: 3000, calculatedCommissionMinorUnits: 100 }),
      entry(B, { activatedAt: "2029-01-03T00:00:00.000Z", name: "Éclair", sellerMName: "a2aa", wholesalePriceMinorUnits: 1000, calculatedCommissionMinorUnits: 500 }),
    ];
    expect(order("NEWEST", es)).toEqual([B, C, A]);
    expect(order("NAME", es)).toEqual([C, A, B]); // apple, Banana, Éclair — case and accent folded
    expect(order("SELLER", es)).toEqual([A, B, C]);
    expect(order("WHOLESALE_LOW", es)).toEqual([B, C, A]);
    expect(order("WHOLESALE_HIGH", es)).toEqual([A, B, C]);
    expect(order("COMMISSION_HIGH", es)).toEqual([C, B, A]);
    expect(order("COMMISSION_LOW", es)).toEqual([A, B, C]);
  });

  it("round-trips a cursor, and refuses one for another sort or one it did not issue", () => {
    const cursor = { s: "WHOLESALE_LOW" as const, v: 4000, r: A };
    const encoded = encodePromotableCatalogCursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodePromotableCatalogCursor(encoded, "WHOLESALE_LOW")).toEqual(cursor);
    expect(decodePromotableCatalogCursor(encoded, "NEWEST")).toBeNull();
    expect(decodePromotableCatalogCursor("garbage", "WHOLESALE_LOW")).toBeNull();
    expect(
      decodePromotableCatalogCursor(
        Buffer.from(JSON.stringify({ s: "NAME", v: "x", r: "mon:product:X" })).toString("base64url"),
        "NAME",
      ),
    ).toBeNull();
    expect(PromotableCatalogCursor.safeParse({ s: "NAME", v: "x", r: A, extra: 1 }).success).toBe(false);
    // A value of the wrong type for its sort is not a cursor this catalog issued.
    expect(PromotableCatalogCursor.safeParse({ s: "WHOLESALE_LOW", v: "4000", r: A }).success).toBe(false);
    expect(PromotableCatalogCursor.safeParse({ s: "NAME", v: 4000, r: A }).success).toBe(false);
  });

  it("orders NAME by a bounded folded prefix, so the longest, most expansive name still yields a readable cursor", () => {
    // U+FDFA folds (NFKD) to 18 characters; 200 of them would be 3 600.
    const worst = "\uFDFA".repeat(200);
    const value = catalogSortValue("NAME", entry(A, { name: worst }));
    expect(typeof value === "string" && value.length).toBe(PROMOTABLE_CATALOG_NAME_SORT_PREFIX);
    for (const name of [worst, "陶".repeat(200), "\u0001".repeat(200)]) {
      const v = catalogSortValue("NAME", entry(A, { name }));
      const encoded = encodePromotableCatalogCursor({ s: "NAME", v, r: A });
      expect(parsePromotableCatalogQuery(params({ cursor: encoded })).invalid, name.slice(0, 4)).toEqual([]);
      expect(decodePromotableCatalogCursor(encoded, "NAME"), name.slice(0, 4)).toEqual({ s: "NAME", v, r: A });
    }
  });
});

describe("1.43 — who may browse", () => {
  it("closable identity gaps keep the catalog open (requesting stays closed); every other refusal closes it", () => {
    expect(promotableCatalogBrowseAllowed([])).toBe(true);
    expect(
      promotableCatalogBrowseAllowed(["EMAIL_UNVERIFIED", "FIRST_NAME_MISSING", "LAST_NAME_MISSING", "MARKETPLACE_NAME_MISSING"]),
    ).toBe(true);
    for (const refusal of PROMOTION_AUTHORIZATION_REQUEST_REFUSALS) {
      const tolerated = ["EMAIL_UNVERIFIED", "FIRST_NAME_MISSING", "LAST_NAME_MISSING", "MARKETPLACE_NAME_MISSING"].includes(refusal);
      expect(promotableCatalogBrowseAllowed([refusal]), refusal).toBe(tolerated);
    }
  });
});

describe("1.43 — commission as the Offer states it", () => {
  it("a percentage Offer shows its percentage; a fixed Offer its amount — never a synthesized percentage", () => {
    const percent = { method: "PERCENT_OF_WHOLESALE" as const, commissionBasisPoints: 1000 };
    const fixed = { method: "FIXED_AMOUNT" as const, fixedCommissionMinorUnits: 500 };
    expect(formatCatalogCommission(percent, "USD")).toBe("Commission 10%");
    expect(formatCatalogCommission(fixed, "USD")).toBe("Commission $5.00");
    expect(formatCatalogCommission(fixed, "USD")).not.toContain("%");
    expect(formatCatalogCommissionDetail(percent, 400, "USD")).toBe("10% ($4.00)");
    expect(formatCatalogCommissionDetail(fixed, 500, "USD")).toBe("$5.00");
    expect(formatCatalogTermsLine({ wholesalePriceMinorUnits: 4000, currency: "USD", commission: percent })).toBe(
      "Wholesale $40.00 · Commission 10%",
    );
    expect(formatBasisPoints(1250)).toBe("12.5%");
    expect(formatBasisPoints(25)).toBe("0.25%");
  });
});
