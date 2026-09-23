/**
 * User-facing retail amounts, and the one deterministic way they become minor
 * units (Phase 1.36).
 *
 * The authoritative money model in this repository is **integer minor units
 * plus a currency**, and nothing here changes that: `RetailPrice` is still the
 * only shape a Listing's price is ever persisted or compared in. What this
 * module adds is the single place a *person's* amount — "19.99", typed into a
 * form — is turned into one, so the conversion exists once rather than at every
 * boundary that ever needs it.
 *
 * Five properties, and each of them is the reason a smaller helper would have
 * been wrong:
 *
 *   1. **No floating-point arithmetic, anywhere.** `Number("19.99") * 100` is
 *      `1998.9999999999998`, and `Math.round` hides that until the day it does
 *      not. The parse is **string surgery over a fixed exponent** — split the
 *      decimal, pad the fraction, concatenate, read as `BigInt` — so the
 *      conversion is exact by construction rather than exact within tolerance.
 *
 *   2. **The currency must be supported, not merely well-formed.**
 *      `CurrencyCode` is a structural check — three uppercase letters — and
 *      deliberately not a registry (`offer-source.ts`). A decimal amount cannot
 *      be converted without knowing the currency's minor-unit exponent, so this
 *      module holds the exponent for the currencies Monacado actually prices in
 *      and **refuses every other**. Guessing two decimal places for an unknown
 *      currency is how a zero-decimal currency ends up priced at 1/100 of what
 *      the seller meant.
 *
 *   3. **One currency today, and the list is the contract.** `USD` is the only
 *      member, because it is the only currency the commercial policy, the
 *      checkout path, and the Offer economics are exercised in. Adding a second
 *      is adding a member and its exponent here — not special-casing a route.
 *      There is no FX, no conversion, and no locale-specific settlement in this
 *      module or reachable from it.
 *
 *   4. **Over-precision is refused, never rounded.** `"19.999"` in USD is not
 *      `1999`; it is a caller stating a price this currency cannot hold.
 *      Silently rounding it would record a number nobody typed as an
 *      authoritative commercial fact.
 *
 *   5. **Absence is not zero and zero is not a price.** A blank, a malformed
 *      string, and `"0"` are three different refusals and none of them is an
 *      unpriced placement — clearing a price is a separate act, and this module
 *      cannot express it.
 *
 * Pure data and pure functions. No database, clock, environment read,
 * randomness, or network.
 */

import { z } from "zod";
import { MAX_MINOR_UNIT_AMOUNT } from "./offer-source";
import type { RetailPrice } from "./listing-source";

/**
 * The currencies a self-service retail amount may be stated in.
 *
 * A **supported-currency list**, not a registry: it says which currencies this
 * product prices in today, and every entry must also appear in
 * `RETAIL_MINOR_UNIT_EXPONENT` below. The structural `CurrencyCode` check stays
 * where it is and keeps answering its own, narrower question.
 */
export const SUPPORTED_RETAIL_CURRENCIES = ["USD"] as const;
export const SupportedRetailCurrency = z.enum(SUPPORTED_RETAIL_CURRENCIES);
export type SupportedRetailCurrency = z.infer<typeof SupportedRetailCurrency>;

/**
 * How many decimal places each supported currency's minor unit carries.
 *
 * Exhaustive over `SUPPORTED_RETAIL_CURRENCIES` by type, so a currency added to
 * that list without its exponent fails the build rather than being converted at
 * a guessed precision.
 */
export const RETAIL_MINOR_UNIT_EXPONENT: Readonly<Record<SupportedRetailCurrency, number>> =
  Object.freeze({
    /** cents */
    USD: 2,
  });

/**
 * The accepted spelling of a user-facing decimal amount.
 *
 * Deliberately narrow, and every exclusion is a case where being lenient would
 * mean deciding what somebody meant:
 *
 *   - no sign — a negative retail price is not a price, and `"+19.99"` is a
 *     caller writing in a notation this does not accept;
 *   - no thousands separators — `"1,999"` is `1999` in one locale and `1.999`
 *     in another, and a payment amount must not depend on which;
 *   - no exponent notation — `"2e3"` is not how a person states a price;
 *   - no leading zeros on the integer part, so one amount has one spelling;
 *   - no bare `"19."` and no bare `".99"` — a decimal point with nothing on one
 *     side of it is a half-typed number, not a value;
 *   - no surrounding whitespace, which callers trim before they get here.
 *
 * The digit bounds are generous rather than commercial: they exist so a
 * pathological string is refused by shape before any arithmetic, and the real
 * range refusal is the `MAX_MINOR_UNIT_AMOUNT` check below. **No commercial
 * minimum or maximum price is invented here** — none is governed anywhere in
 * the repository, and inventing one inside a parser is the wrong place for a
 * commercial decision.
 */
const DECIMAL_AMOUNT_RE = /^(?:0|[1-9][0-9]{0,17})(?:\.[0-9]{1,18})?$/;

/**
 * Why an amount was refused. A closed vocabulary, safe to surface, and never
 * an echo of the value.
 */
export type RetailAmountRefusal =
  | "CURRENCY_NOT_SUPPORTED"
  | "AMOUNT_MALFORMED"
  | "AMOUNT_PRECISION_EXCEEDED"
  | "AMOUNT_NOT_POSITIVE"
  | "AMOUNT_OUT_OF_RANGE";

export type RetailAmountResult =
  | { ok: true; retail: RetailPrice }
  | { ok: false; refusal: RetailAmountRefusal };

/**
 * Convert one user-facing decimal amount into the authoritative `RetailPrice`.
 *
 * Returns a refusal rather than throwing: every caller is a boundary that has
 * to answer a person, and a bounded reason is what it needs.
 *
 * The conversion, in full:
 *
 * ```
 *  "19.9"  exponent 2  →  integer "19", fraction "9"
 *                      →  fraction padded to "90"
 *                      →  BigInt("19" + "90")  =  1990n
 * ```
 *
 * `BigInt` rather than `Number` for the concatenation, so an amount beyond the
 * safe-integer range is **detected** instead of silently losing its low digits;
 * the range check then refuses it, and only a value that survives becomes a
 * `number`.
 */
export function parseRetailAmount(input: {
  amount: string;
  currency: string;
}): RetailAmountResult {
  const currency = SupportedRetailCurrency.safeParse(input.currency);
  if (!currency.success) return { ok: false, refusal: "CURRENCY_NOT_SUPPORTED" };

  if (typeof input.amount !== "string" || !DECIMAL_AMOUNT_RE.test(input.amount)) {
    return { ok: false, refusal: "AMOUNT_MALFORMED" };
  }

  const exponent = RETAIL_MINOR_UNIT_EXPONENT[currency.data];
  const [integerPart, fractionPart = ""] = input.amount.split(".") as [string, string?];
  if (fractionPart.length > exponent) {
    /* Refused, never rounded: "19.999" in USD is a price this currency cannot
       hold, and recording 1999 would record a number nobody typed. */
    return { ok: false, refusal: "AMOUNT_PRECISION_EXCEEDED" };
  }

  const scaled = BigInt(integerPart + fractionPart.padEnd(exponent, "0"));
  /* Zero is not "no price": it says the item is free, which is a commercial
     claim nobody made (`LISTING_SOURCE_MODEL.md` §2a). Absence is a different
     act, and this function cannot express it. */
  if (scaled <= 0n) return { ok: false, refusal: "AMOUNT_NOT_POSITIVE" };
  if (scaled > BigInt(MAX_MINOR_UNIT_AMOUNT)) {
    return { ok: false, refusal: "AMOUNT_OUT_OF_RANGE" };
  }

  return {
    ok: true,
    retail: {
      retailPriceMinorUnits: Number(scaled),
      retailPriceCurrency: currency.data,
    },
  };
}

/**
 * The same amount, back as the decimal a person would recognise.
 *
 * String surgery again, not division: `1999 / 100` is a float, and the point of
 * this module is that no money value ever passes through one. Used for
 * round-trip proof and for pre-filling an input with the price already stored —
 * **not** for display, which belongs to a presentation layer with a currency
 * symbol and a locale.
 */
export function formatRetailAmount(input: RetailPrice): string {
  const currency = SupportedRetailCurrency.safeParse(input.retailPriceCurrency);
  const exponent = currency.success ? RETAIL_MINOR_UNIT_EXPONENT[currency.data] : 0;
  if (exponent === 0) return String(input.retailPriceMinorUnits);

  const digits = String(input.retailPriceMinorUnits).padStart(exponent + 1, "0");
  return `${digits.slice(0, -exponent)}.${digits.slice(-exponent)}`;
}
