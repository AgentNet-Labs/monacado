/**
 * Phase 1.36 — the one conversion from a user-facing decimal amount to the
 * authoritative minor-unit `RetailPrice`.
 *
 * Everything a seller's price touches downstream is an integer, and the whole
 * risk of accepting a decimal at the edge is concentrated in this function. So
 * this suite is about the conversion being **exact and total**: exact, because
 * `Number("19.99") * 100` is `1998.9999999999998` and a repository that refuses
 * floating-point money cannot admit one here; total, because every string that
 * is not a price must be refused with a bounded reason rather than coerced into
 * a number nobody typed.
 *
 * NO DATABASE, NO NETWORK, no clock. Pure functions.
 */

import { describe, expect, it } from "vitest";
import {
  RETAIL_MINOR_UNIT_EXPONENT,
  SUPPORTED_RETAIL_CURRENCIES,
  formatRetailAmount,
  parseRetailAmount,
} from "../src/contracts/marketplace/retail-amount";
import { MAX_MINOR_UNIT_AMOUNT } from "../src/contracts/marketplace/offer-source";
import { RetailPrice } from "../src/contracts/marketplace/listing-source";

const usd = (amount: string) => parseRetailAmount({ amount, currency: "USD" });

describe("Phase 1.36 — the supported-currency scope", () => {
  it("prices in USD alone, and every supported currency has a stated exponent", () => {
    expect([...SUPPORTED_RETAIL_CURRENCIES]).toEqual(["USD"]);
    for (const currency of SUPPORTED_RETAIL_CURRENCIES) {
      expect(RETAIL_MINOR_UNIT_EXPONENT[currency]).toBe(2);
    }
  });

  it("refuses a well-formed but unsupported currency rather than guessing its exponent", () => {
    /* `CurrencyCode` would accept all of these — it is a structural check, three
       uppercase letters, and deliberately not a registry. A decimal cannot be
       converted without the minor-unit exponent, and guessing two places is how
       a zero-decimal currency ends up priced at 1/100 of what was meant. */
    for (const currency of ["EUR", "GBP", "JPY", "KRW", "BHD", "XXX"]) {
      expect(parseRetailAmount({ amount: "19.99", currency })).toEqual({
        ok: false,
        refusal: "CURRENCY_NOT_SUPPORTED",
      });
    }
  });

  it("refuses a malformed currency, and refuses it BEFORE judging the amount", () => {
    for (const currency of ["", "usd", "US", "USDD", "US$", " USD"]) {
      expect(parseRetailAmount({ amount: "abc", currency })).toEqual({
        ok: false,
        refusal: "CURRENCY_NOT_SUPPORTED",
      });
    }
  });
});

describe("Phase 1.36 — exact decimal to minor units", () => {
  it("converts the ordinary shapes exactly", () => {
    const cases: Array<[string, number]> = [
      ["19.99", 1999],
      ["19", 1900],
      ["19.9", 1990],
      ["19.90", 1990],
      ["0.01", 1],
      ["0.99", 99],
      ["24.50", 2450],
      ["1234.56", 123456],
      ["1000000", 100000000],
    ];
    for (const [amount, minorUnits] of cases) {
      expect(usd(amount)).toEqual({
        ok: true,
        retail: { retailPriceMinorUnits: minorUnits, retailPriceCurrency: "USD" },
      });
    }
  });

  it("is exact where floating-point multiplication is not", () => {
    /* Four amounts `x * 100` gets wrong in IEEE-754 double arithmetic. Each one
       is a real price somebody would type, and each one is the reason this
       function does string surgery instead. */
    for (const [amount, minorUnits] of [
      ["19.99", 1999],
      ["1.15", 115],
      ["4.35", 435],
      ["0.07", 7],
    ] as const) {
      expect(Number(amount) * 100).not.toBe(minorUnits);
      expect(usd(amount)).toMatchObject({
        ok: true,
        retail: { retailPriceMinorUnits: minorUnits },
      });
    }
  });

  it("produces a value the authoritative contract accepts", () => {
    const result = usd("19.99");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    /* Not merely shaped like a RetailPrice — parsed by the real one, so a
       positive-integer or currency rule tightening upstream fails here. */
    expect(RetailPrice.parse(result.retail)).toEqual(result.retail);
  });

  it("round-trips back to the decimal a person would recognise", () => {
    /* Two places always, because that is what USD holds and the minor-unit
       amount is what was stored: "19.9" and "19" come back NORMALIZED rather
       than echoed, and "19.99" comes back unchanged. */
    const cases: Array<[string, string]> = [
      ["19.99", "19.99"],
      ["19.90", "19.90"],
      ["19.9", "19.90"],
      ["19", "19.00"],
      ["0.01", "0.01"],
      ["1234.56", "1234.56"],
    ];
    for (const [typed, formatted] of cases) {
      const result = usd(typed);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(formatRetailAmount(result.retail)).toBe(formatted);
      /* And the round trip is stable: re-parsing what was formatted gives back
         exactly the same minor-unit amount. */
      expect(usd(formatted)).toEqual(result);
    }
  });
});

describe("Phase 1.36 — what is refused, and why", () => {
  it("refuses zero, in every spelling of it", () => {
    /* A zero price is not "no price": it says the item is free, which is a
       commercial claim nobody made. */
    for (const amount of ["0", "0.0", "0.00"]) {
      expect(usd(amount)).toEqual({ ok: false, refusal: "AMOUNT_NOT_POSITIVE" });
    }
  });

  it("refuses a negative amount", () => {
    for (const amount of ["-1.00", "-0.01", "-19.99", "-0"]) {
      expect(usd(amount)).toEqual({ ok: false, refusal: "AMOUNT_MALFORMED" });
    }
  });

  it("refuses over-precision rather than rounding it", () => {
    /* "19.999" in USD is a price this currency cannot hold. Recording 1999 —
       or 2000 — would record a number nobody typed as an authoritative
       commercial fact. */
    for (const amount of ["19.999", "19.991", "0.001", "1.005"]) {
      expect(usd(amount)).toEqual({ ok: false, refusal: "AMOUNT_PRECISION_EXCEEDED" });
    }
  });

  it("refuses every spelling that is not a plain decimal", () => {
    const malformed = [
      "abc",
      "",
      " ",
      "19.99 ",
      " 19.99",
      "$19.99",
      "19,99",
      "1,999.00",
      "19.",
      ".99",
      "19..99",
      "1e2",
      "1E2",
      "19.99e1",
      "+19.99",
      "019.99",
      "00",
      "Infinity",
      "NaN",
      "1/2",
      "nineteen",
      "19.99USD",
      "0x10",
      "١٩",
    ];
    for (const amount of malformed) {
      expect(usd(amount)).toEqual({ ok: false, refusal: "AMOUNT_MALFORMED" });
    }
  });

  it("refuses a non-string amount without coercing it", () => {
    for (const amount of [19.99, null, undefined, {}, [], true] as unknown[]) {
      expect(parseRetailAmount({ amount: amount as string, currency: "USD" })).toEqual({
        ok: false,
        refusal: "AMOUNT_MALFORMED",
      });
    }
  });

  it("refuses an amount beyond the persistence bound, and accepts the bound itself", () => {
    /* MAX_MINOR_UNIT_AMOUNT is Number.MAX_SAFE_INTEGER — the point past which a
       BIGINT column can no longer round-trip into a `number` exactly. The
       concatenation runs in BigInt precisely so this is DETECTED rather than
       silently losing its low digits. */
    const max = BigInt(MAX_MINOR_UNIT_AMOUNT);
    const atBound = `${max / 100n}.${String(max % 100n).padStart(2, "0")}`;
    expect(usd(atBound)).toEqual({
      ok: true,
      retail: { retailPriceMinorUnits: MAX_MINOR_UNIT_AMOUNT, retailPriceCurrency: "USD" },
    });

    expect(usd("99999999999999999.99")).toEqual({
      ok: false,
      refusal: "AMOUNT_OUT_OF_RANGE",
    });
    /* One minor unit past the bound is refused too, so the boundary is the
       boundary rather than approximately it. */
    const pastBound = max + 1n;
    expect(usd(`${pastBound / 100n}.${String(pastBound % 100n).padStart(2, "0")}`)).toEqual({
      ok: false,
      refusal: "AMOUNT_OUT_OF_RANGE",
    });
    /* And a string longer than the shape admits is refused earlier, by shape,
       before any arithmetic runs at all. */
    expect(usd("1000000000000000000")).toEqual({ ok: false, refusal: "AMOUNT_MALFORMED" });
  });

  it("invents no commercial minimum or maximum price", () => {
    /* No governed bound exists anywhere in the repository, and a parser is the
       wrong place for a commercial decision. One cent and eight figures are
       both accepted; whether Monacado wants either is somebody else's rule. */
    expect(usd("0.01")).toMatchObject({ ok: true });
    expect(usd("99999999.99")).toMatchObject({ ok: true });
  });
});
