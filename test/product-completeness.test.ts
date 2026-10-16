/**
 * Phase 1.38 — `PRODUCT_COMPLETENESS_V1`, the Seller shipping-policy contract,
 * and the revision rules that keep shipping truth honest. Pure; no database.
 *
 * Proves the governing profile (`PRODUCT_COMPLETENESS_PROFILE.md`): name,
 * description, and delivery mode are required; a Seller-shipped (PHYSICAL)
 * Product also needs an explicit shipping policy, where FREE counts, FIXED
 * counts only with a valid positive charge, and absence never counts; and
 * optional facts, `taxClassification`, `generalAvailabilityState`, and
 * `recordStatus = authoring-complete` never decide anything.
 */

import { describe, expect, it } from "vitest";
import {
  PRODUCT_COMPLETENESS_PROFILE_V1,
  evaluateProductCompletenessV1,
  productCompletenessInputFromRecord,
  type ProductCompletenessInput,
} from "../src/contracts/product/product-completeness";
import {
  ProductShippingPolicy,
  deliveryModeIsSellerShipped,
} from "../src/contracts/product/product-shipping-policy";
import {
  ProductRevisionInput,
  ProductSourceRecordSchema,
  reviseProductSourceRecord,
  type ProductSourceRecord,
} from "../src/contracts/product/product-source-record";
import {
  SYN_CAPSULE_GENERATED_AT_V2,
  SYN_UPDATED_AT_V2,
  syntheticProductSourceRecord,
} from "../src/contracts/fixtures/synthetic-source-record";
import { productSourceRecordToCapsuleCandidate } from "../src/contracts/product/product-source-record";
import { parseRequestedShippingPolicy } from "../src/server/product/product-revision-route-handler";
import { nextSourceRecordVersion } from "../src/server/marketplace/product-revision-service";
import {
  ProductRevisionToken,
  productRevisionToken,
} from "../src/server/product/product-revision-token";
import {
  REVISION_CHARGE_EMPTY,
  REVISION_CONFLICT,
  REVISION_CHARGE_INVALID,
  REVISION_INVALID,
  REVISION_NOT_AVAILABLE,
  minorUnitsToDecimalInput,
  submitProductRevision,
} from "../app/account/product-revision-submission";

const COMPLETE_DIGITAL: ProductCompletenessInput = {
  name: "Field guide",
  description: "A printable PDF.",
  deliveryMode: "DIGITAL",
  shippingPolicy: undefined,
};
const PHYSICAL = { name: "Mug", description: "Stoneware.", deliveryMode: "PHYSICAL" };

/** A synthetic record that is physical, described, and otherwise ordinary. */
function physicalRecord(overrides: Partial<ProductSourceRecord> = {}): ProductSourceRecord {
  const base = syntheticProductSourceRecord();
  return { ...base, facts: { ...base.facts, deliveryMode: "PHYSICAL" }, ...overrides };
}

describe("PRODUCT_COMPLETENESS_V1 — required Seller facts", () => {
  it("a described DIGITAL Product with a name is complete and needs no shipping policy", () => {
    expect(evaluateProductCompletenessV1(COMPLETE_DIGITAL)).toEqual({
      profile: PRODUCT_COMPLETENESS_PROFILE_V1,
      complete: true,
      missing: [],
    });
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace only", "   \n\t "],
  ])("name %s → NAME_MISSING", (_label, name) => {
    expect(evaluateProductCompletenessV1({ ...COMPLETE_DIGITAL, name }).missing).toEqual(["NAME_MISSING"]);
  });

  it.each([
    ["absent", undefined],
    ["null", null],
    ["empty", ""],
    ["whitespace only", "  "],
  ])("description %s → DESCRIPTION_MISSING", (_label, description) => {
    const result = evaluateProductCompletenessV1({ ...COMPLETE_DIGITAL, description });
    expect(result.complete).toBe(false);
    expect(result.missing).toEqual(["DESCRIPTION_MISSING"]);
  });

  it.each([
    ["absent (a pre-1.2 version)", undefined],
    ["null", null],
    ["outside the vocabulary", "SERVICE"],
    ["wrong case", "physical"],
  ])("deliveryMode %s → DELIVERY_MODE_MISSING, and no shipping judgement is made", (_label, deliveryMode) => {
    const result = evaluateProductCompletenessV1({ ...COMPLETE_DIGITAL, deliveryMode });
    expect(result.missing).toEqual(["DELIVERY_MODE_MISSING"]);
  });

  it("reports every gap, in a fixed order", () => {
    expect(
      evaluateProductCompletenessV1({ name: " ", description: null, deliveryMode: "PHYSICAL", shippingPolicy: undefined })
        .missing,
    ).toEqual(["NAME_MISSING", "DESCRIPTION_MISSING", "SHIPPING_POLICY_MISSING"]);
  });
});

describe("PRODUCT_COMPLETENESS_V1 — Seller shipping policy", () => {
  it("a PHYSICAL Product without a shipping policy is incomplete — missing is never FREE", () => {
    for (const shippingPolicy of [undefined, null, {}, { method: "" }]) {
      expect(evaluateProductCompletenessV1({ ...PHYSICAL, shippingPolicy })).toMatchObject({
        complete: false,
        missing: ["SHIPPING_POLICY_MISSING"],
      });
    }
  });

  it("explicit FREE completes the shipping requirement", () => {
    expect(evaluateProductCompletenessV1({ ...PHYSICAL, shippingPolicy: { method: "FREE" } }).complete).toBe(true);
  });

  it("FIXED with a positive minor-unit charge in a supported currency completes it", () => {
    expect(
      evaluateProductCompletenessV1({
        ...PHYSICAL,
        shippingPolicy: { method: "FIXED", fixedChargeMinorUnits: 450, fixedChargeCurrency: "USD" },
      }).complete,
    ).toBe(true);
  });

  it.each([
    ["zero (free shipping is FREE, not FIXED 0)", { fixedChargeMinorUnits: 0, fixedChargeCurrency: "USD" }],
    ["negative", { fixedChargeMinorUnits: -1, fixedChargeCurrency: "USD" }],
    ["fractional minor units", { fixedChargeMinorUnits: 4.5, fixedChargeCurrency: "USD" }],
    ["unsupported currency", { fixedChargeMinorUnits: 450, fixedChargeCurrency: "EUR" }],
    ["no currency", { fixedChargeMinorUnits: 450 }],
    ["no amount", { fixedChargeCurrency: "USD" }],
  ])("FIXED with %s does not complete it", (_label, rest) => {
    expect(
      evaluateProductCompletenessV1({ ...PHYSICAL, shippingPolicy: { method: "FIXED", ...rest } }).missing,
    ).toEqual(["SHIPPING_POLICY_MISSING"]);
  });

  it("calculated / carrier methods are not governed and do not count", () => {
    expect(
      evaluateProductCompletenessV1({ ...PHYSICAL, shippingPolicy: { method: "CALCULATED" } }).complete,
    ).toBe(false);
    expect(ProductShippingPolicy.safeParse({ method: "CARRIER_RATE" }).success).toBe(false);
  });

  it("only PHYSICAL is Seller-shipped under the current vocabulary", () => {
    expect(deliveryModeIsSellerShipped("PHYSICAL")).toBe(true);
    expect(deliveryModeIsSellerShipped("DIGITAL")).toBe(false);
    expect(deliveryModeIsSellerShipped(undefined)).toBe(false);
  });
});

describe("PRODUCT_COMPLETENESS_V1 — what never decides completeness", () => {
  it("recordStatus = authoring-complete does not make a Product complete", () => {
    const record = syntheticProductSourceRecord(); // authoring-complete, no deliveryMode
    expect(record.recordStatus).toBe("authoring-complete");
    expect(evaluateProductCompletenessV1(productCompletenessInputFromRecord(record)).missing).toEqual([
      "DELIVERY_MODE_MISSING",
    ]);
  });

  it("recordStatus, taxClassification, generalAvailabilityState, and optional facts do not change the answer", () => {
    const base = physicalRecord({ shippingPolicy: { method: "FREE" } });
    const expected = evaluateProductCompletenessV1(productCompletenessInputFromRecord(base));
    expect(expected.complete).toBe(true);

    const variants: ProductSourceRecord[] = [
      { ...base, recordStatus: "draft" },
      { ...base, recordStatus: "withdrawn" },
      { ...base, taxClassification: "PHYSICAL_GOOD" },
      { ...base, facts: { ...base.facts, generalAvailabilityState: "discontinued" } },
      { ...base, facts: { ...base.facts, generalAvailabilityState: "unavailable" } },
      (() => {
        const { image: _i, specifications: _s, capabilities: _c, ...facts } = base.facts;
        return { ...base, facts };
      })(),
    ];
    for (const variant of variants) {
      expect(evaluateProductCompletenessV1(productCompletenessInputFromRecord(variant))).toEqual(expected);
    }
  });

  it("an unresolved taxClassification leaves a complete Product complete", () => {
    const record = physicalRecord({ shippingPolicy: { method: "FREE" } });
    expect(record.taxClassification).toBeUndefined();
    expect(evaluateProductCompletenessV1(productCompletenessInputFromRecord(record)).complete).toBe(true);
  });
});

describe("Seller shipping policy on the Product source record", () => {
  it("validates on a PHYSICAL record and passes the forbidden-field scan", () => {
    for (const shippingPolicy of [
      { method: "FREE" as const },
      { method: "FIXED" as const, fixedChargeMinorUnits: 450, fixedChargeCurrency: "USD" as const },
    ]) {
      expect(ProductSourceRecordSchema.safeParse(physicalRecord({ shippingPolicy })).success).toBe(true);
    }
  });

  it("is refused on a DIGITAL record and on one with no delivery mode", () => {
    const base = syntheticProductSourceRecord();
    const digital = { ...base, facts: { ...base.facts, deliveryMode: "DIGITAL" as const }, shippingPolicy: { method: "FREE" as const } };
    expect(ProductSourceRecordSchema.safeParse(digital).success).toBe(false);
    expect(ProductSourceRecordSchema.safeParse({ ...base, shippingPolicy: { method: "FREE" } }).success).toBe(false);
  });

  it("is not projected into the capsule candidate", () => {
    const record = physicalRecord({
      shippingPolicy: { method: "FIXED", fixedChargeMinorUnits: 450, fixedChargeCurrency: "USD" },
    });
    const candidate = JSON.stringify(productSourceRecordToCapsuleCandidate(record));
    expect(candidate).not.toContain("shipping");
    expect(candidate).not.toContain("fixedCharge");
  });

  it("revision: omitted carries forward, null clears, and the prior record is not mutated", () => {
    const prior = physicalRecord({ shippingPolicy: { method: "FREE" } });
    const snapshot = JSON.stringify(prior);
    const revise = (extra: object) =>
      reviseProductSourceRecord({
        prior,
        sourceRecordVersion: "2",
        updatedAt: SYN_UPDATED_AT_V2,
        capsuleGeneratedAt: SYN_CAPSULE_GENERATED_AT_V2,
        ...extra,
      });

    expect(revise({}).shippingPolicy).toEqual({ method: "FREE" });
    expect(revise({ shippingPolicy: null }).shippingPolicy).toBeUndefined();
    expect(
      revise({ shippingPolicy: { method: "FIXED", fixedChargeMinorUnits: 999, fixedChargeCurrency: "USD" } })
        .shippingPolicy,
    ).toEqual({ method: "FIXED", fixedChargeMinorUnits: 999, fixedChargeCurrency: "USD" });
    // Switching to DIGITAL while keeping a policy is refused; clearing it is accepted.
    const digitalFacts = { ...prior.facts, deliveryMode: "DIGITAL" as const };
    expect(() => revise({ facts: digitalFacts })).toThrow();
    expect(revise({ facts: digitalFacts, shippingPolicy: null }).shippingPolicy).toBeUndefined();
    expect(JSON.stringify(prior)).toBe(snapshot);
  });
});

describe("ProductRevisionInput — what a Seller may state", () => {
  const VALID = { name: "Mug", description: "Stoneware.", deliveryMode: "PHYSICAL", shippingPolicy: null };

  it("accepts an incomplete revision (no description, no shipping policy) and trims text", () => {
    const parsed = ProductRevisionInput.parse({ ...VALID, name: "  Mug  ", description: null });
    expect(parsed).toEqual({ name: "Mug", description: null, deliveryMode: "PHYSICAL", shippingPolicy: null });
  });

  it("refuses a blank name, a non-vocabulary delivery mode, extra members, and a policy for a non-shipped Product", () => {
    expect(ProductRevisionInput.safeParse({ ...VALID, name: "   " }).success).toBe(false);
    expect(ProductRevisionInput.safeParse({ ...VALID, deliveryMode: "SERVICE" }).success).toBe(false);
    expect(ProductRevisionInput.safeParse({ ...VALID, taxClassification: "PHYSICAL_GOOD" }).success).toBe(false);
    expect(
      ProductRevisionInput.safeParse({ ...VALID, deliveryMode: "DIGITAL", shippingPolicy: { method: "FREE" } }).success,
    ).toBe(false);
  });
});

describe("route shipping-policy parsing", () => {
  it("converts a FIXED decimal exactly once and keeps FREE and none distinct", () => {
    expect(parseRequestedShippingPolicy(null)).toEqual({ ok: true, policy: null });
    expect(parseRequestedShippingPolicy({ method: "FREE" })).toEqual({ ok: true, policy: { method: "FREE" } });
    expect(parseRequestedShippingPolicy({ method: "FIXED", amount: "4.50", currency: "USD" })).toEqual({
      ok: true,
      policy: { method: "FIXED", fixedChargeMinorUnits: 450, fixedChargeCurrency: "USD" },
    });
  });

  it.each([
    [{ method: "CALCULATED" }, "UNSUPPORTED_SHIPPING_POLICY"],
    [{ method: "CARRIER_RATE", carrier: "x" }, "UNSUPPORTED_SHIPPING_POLICY"],
    [{ method: "FIXED", amount: "0", currency: "USD" }, "INVALID_SHIPPING_CHARGE"],
    [{ method: "FIXED", amount: "0.00", currency: "USD" }, "INVALID_SHIPPING_CHARGE"],
    [{ method: "FIXED", amount: "-1", currency: "USD" }, "INVALID_SHIPPING_CHARGE"],
    [{ method: "FIXED", amount: "4.555", currency: "USD" }, "INVALID_SHIPPING_CHARGE"],
    [{ method: "FIXED", amount: "4.50", currency: "EUR" }, "INVALID_SHIPPING_CHARGE"],
    [{ method: "FIXED", amount: "abc", currency: "USD" }, "INVALID_SHIPPING_CHARGE"],
    [{ method: "FIXED", currency: "USD" }, "INVALID_PRODUCT_REVISION"],
    [{ method: "FIXED", amount: 4.5, currency: "USD" }, "INVALID_PRODUCT_REVISION"],
    [{ method: "FREE", amount: "0" }, "INVALID_PRODUCT_REVISION"],
    ["FREE", "INVALID_PRODUCT_REVISION"],
    [[], "INVALID_PRODUCT_REVISION"],
    [{}, "INVALID_PRODUCT_REVISION"],
  ])("refuses %j with %s", (value, code) => {
    expect(parseRequestedShippingPolicy(value)).toEqual({ ok: false, code });
  });

  it("advances self-service version labels and refuses foreign ones", () => {
    expect(nextSourceRecordVersion("1")).toBe("2");
    expect(nextSourceRecordVersion("41")).toBe("42");
    expect(() => nextSourceRecordVersion("v1")).toThrow();
    expect(() => nextSourceRecordVersion("0")).toThrow();
  });
});

describe("browser revision submission", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef";
  const NEXT = "fedcba9876543210fedcba9876543210";
  const FIELDS = {
    productRef: "0123456789ABCDEFGHJKMNPQRSTVWXYZ",
    expectedRevision: TOKEN,
    name: "Mug",
    description: "",
    deliveryMode: "PHYSICAL" as const,
    shippingChoice: null,
    shippingAmount: "",
    currency: "USD",
  };

  function capture(status = 200, body: unknown = { revision: NEXT }) {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it("sends the expected revision token, no choice as null — never as free shipping — and a blank description as null", async () => {
    const { calls, fetchImpl } = capture();
    expect(await submitProductRevision(FIELDS, { fetchImpl })).toEqual({ outcome: "revised", revision: NEXT });
    expect(calls[0]!.url).toBe("/api/products/0123456789ABCDEFGHJKMNPQRSTVWXYZ/revise");
    expect(calls[0]!.body).toEqual({
      expectedRevision: TOKEN,
      name: "Mug",
      description: null,
      deliveryMode: "PHYSICAL",
      shippingPolicy: null,
    });
  });

  it("a stale revision is a conflict that tells the person to reload — never a silent overwrite", async () => {
    const stale = capture(409, { error: "PRODUCT_REVISION_CONFLICT" });
    expect(await submitProductRevision(FIELDS, { fetchImpl: stale.fetchImpl })).toEqual({
      outcome: "failed",
      message: REVISION_CONFLICT,
      conflict: true,
    });
    expect(REVISION_CONFLICT).toMatch(/changed/);
    expect(REVISION_CONFLICT).toMatch(/Reload/);
  });

  it("a success without a new token is treated as needing a reload, not as safe to save again", async () => {
    const { fetchImpl } = capture(200, {});
    expect(await submitProductRevision(FIELDS, { fetchImpl })).toEqual({
      outcome: "failed",
      message: REVISION_CONFLICT,
      conflict: true,
    });
  });

  it("sends FREE, and FIXED with the amount exactly as typed", async () => {
    const free = capture();
    await submitProductRevision({ ...FIELDS, shippingChoice: "FREE" }, { fetchImpl: free.fetchImpl });
    expect((free.calls[0]!.body as { shippingPolicy: unknown }).shippingPolicy).toEqual({ method: "FREE" });

    const fixed = capture();
    await submitProductRevision(
      { ...FIELDS, shippingChoice: "FIXED", shippingAmount: " 4.50 " },
      { fetchImpl: fixed.fetchImpl },
    );
    expect((fixed.calls[0]!.body as { shippingPolicy: unknown }).shippingPolicy).toEqual({
      method: "FIXED",
      amount: "4.50",
      currency: "USD",
    });
  });

  it("sends no shipping policy for a digital Product, whatever was chosen before", async () => {
    const { calls, fetchImpl } = capture();
    await submitProductRevision({ ...FIELDS, deliveryMode: "DIGITAL", shippingChoice: "FREE" }, { fetchImpl });
    expect((calls[0]!.body as { shippingPolicy: unknown }).shippingPolicy).toBeNull();
  });

  it("refuses locally without a delivery type or a fixed amount, and maps server codes to sentences", async () => {
    const { calls, fetchImpl } = capture();
    expect(await submitProductRevision({ ...FIELDS, deliveryMode: null }, { fetchImpl })).toEqual({
      outcome: "failed",
      message: REVISION_INVALID,
    });
    expect(await submitProductRevision({ ...FIELDS, shippingChoice: "FIXED" }, { fetchImpl })).toEqual({
      outcome: "failed",
      message: REVISION_CHARGE_EMPTY,
    });
    expect(calls).toHaveLength(0);

    const charge = capture(400, { error: "INVALID_SHIPPING_CHARGE" });
    expect(
      await submitProductRevision({ ...FIELDS, shippingChoice: "FIXED", shippingAmount: "0" }, { fetchImpl: charge.fetchImpl }),
    ).toEqual({ outcome: "failed", message: REVISION_CHARGE_INVALID });
    const missing = capture(404, { error: "PRODUCT_NOT_AVAILABLE" });
    expect(await submitProductRevision(FIELDS, { fetchImpl: missing.fetchImpl })).toEqual({
      outcome: "failed",
      message: REVISION_NOT_AVAILABLE,
    });
  });

  it("pre-fills a stored charge as a decimal without floating point", () => {
    expect(minorUnitsToDecimalInput(450)).toBe("4.50");
    expect(minorUnitsToDecimalInput(5)).toBe("0.05");
    expect(minorUnitsToDecimalInput(123456)).toBe("1234.56");
  });
});

describe("Product revision token", () => {
  const SREC = "mon:srec:01HQ8ZK3M9P7R5T2V4W6XY8N1A";
  const OTHER = "mon:srec:01HQ8ZK3M9P7R5T2V4W6XY8N1Z";

  it("is deterministic, opaque, and well-formed", () => {
    const token = productRevisionToken(SREC, "1");
    expect(token).toBe(productRevisionToken(SREC, "1"));
    expect(ProductRevisionToken.safeParse(token).success).toBe(true);
    expect(token).not.toContain("mon:");
    expect(token).not.toContain("01HQ8ZK3");
  });

  it("changes with every version and differs between Products", () => {
    expect(productRevisionToken(SREC, "2")).not.toBe(productRevisionToken(SREC, "1"));
    expect(productRevisionToken(OTHER, "1")).not.toBe(productRevisionToken(SREC, "1"));
  });

  it("refuses malformed tokens", () => {
    for (const bad of ["", "1", "0123456789ABCDEF0123456789ABCDEF", "0123456789abcdef0123456789abcde", "g".repeat(32)]) {
      expect(ProductRevisionToken.safeParse(bad).success).toBe(false);
    }
  });
});
