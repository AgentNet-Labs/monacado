/**
 * Tax engine adapters (Phase 1.2) — SERVER ONLY.
 *
 * Two adapters, both **test** adapters, and **no production tax vendor**.
 *
 * ## Why no vendor
 *
 * The repository configures none, and choosing one here would be choosing a third
 * party, a data-processing relationship, and a filing posture on Monacado's
 * behalf inside a phase about drawing the boundary. Adding Avalara, Stripe Tax,
 * or TaxJar later is one new file implementing `TaxCalculationPort` and **no
 * change to any caller**.
 *
 * There is a second, harder reason: a real engine needs to know where the buyer
 * is, and **Monacado collects no buyer address**. Wiring a real vendor today
 * would mean either sending it nothing useful or inventing an address, and both
 * are worse than an honest test adapter plus a recorded blocker.
 *
 * ## Disabled is a refusal, never a zero
 *
 * With `MONACADO_TAX_ENABLED` unset, `resolveTaxPort` returns an adapter that
 * **throws**. That is the single most important line in this file. A zero
 * returned because tax is unconfigured is indistinguishable from a zero that is
 * genuinely correct, and the difference is an uncollected liability nobody can
 * find later. Checkout must refuse to sell rather than quietly sell untaxed.
 */

import "../server-only";
import {
  TaxCalculationRequest,
  TaxQuote,
  taxQuoteIsCoherent,
  type TaxCalculationPort,
} from "../../contracts/marketplace/tax-calculation";
import { IncoherentTaxQuoteError, TaxCalculationUnavailableError } from "./tax-errors";

export type Env = Record<string, string | undefined>;

const TRUTHY = new Set(["true", "1", "yes"]);

/** The master switch. Anything other than true/1/yes means disabled. */
export function isTaxCalculationEnabled(env: Env = process.env): boolean {
  const raw = env.MONACADO_TAX_ENABLED;
  return raw !== undefined && TRUTHY.has(raw.trim().toLowerCase());
}

/**
 * Wrap an adapter so an incoherent answer never reaches a buyer's card.
 *
 * The coherence rules live in the contract (`taxQuoteIsCoherent`); this is where
 * they are enforced, once, for every adapter — so a future vendor adapter cannot
 * forget to apply them. **Every adapter below is wrapped**, and a real vendor
 * adapter must be too.
 *
 * Exported so a test exercises the real guard rather than a copy of its rules —
 * a duplicated guard in a test proves only that the copy works.
 */
export function guardTaxPort(port: TaxCalculationPort): TaxCalculationPort {
  return {
    async calculate(rawRequest) {
      const request = TaxCalculationRequest.parse(rawRequest);
      const quote = TaxQuote.parse(await port.calculate(request));

      if (!taxQuoteIsCoherent(quote)) throw new IncoherentTaxQuoteError();
      if (quote.currency !== request.currency) throw new IncoherentTaxQuoteError();

      /* The engine must have assessed the sale Monacado asked about. A basis it
         invented is a basis nobody can reconcile against the Order. */
      const expectedBasis =
        request.commercialRetailAmountMinorUnits + request.shippingAmountMinorUnits;
      if (quote.basisAmountMinorUnits !== expectedBasis) throw new IncoherentTaxQuoteError();

      return quote;
    },
  };
}

/**
 * Assesses no tax and says so honestly.
 *
 * `OUT_OF_SCOPE` rather than `TAXABLE` at zero, and the distinction is the point:
 * this adapter is not claiming a rate of zero applies, it is recording that no
 * taxing regime was consulted. An auditor reading `OUT_OF_SCOPE` learns something
 * true; one reading `TAXABLE` + `0` would be misled.
 */
export function createZeroRateTaxAdapter(
  options: { refs?: () => string } = {},
): TaxCalculationPort {
  let counter = 0;
  const nextRef = options.refs ?? (() => `zero-${(counter += 1)}`);
  return guardTaxPort({
    async calculate(request) {
      return {
        provider: "TEST_ZERO_RATE",
        providerCalculationRef: nextRef(),
        currency: request.currency,
        taxAmountMinorUnits: 0,
        basisAmountMinorUnits:
          request.commercialRetailAmountMinorUnits + request.shippingAmountMinorUnits,
        treatment: "OUT_OF_SCOPE",
        jurisdictionCode: null,
        calculatedAt: request.at,
      };
    },
  });
}

/**
 * A fixed rate on retail plus shipping — enough to prove tax flows correctly.
 *
 * Exists so a test can assert the properties that actually matter: that tax
 * reaches the buyer's total, that it reaches **no** commercial basis, and that
 * the evidence round-trips. It is not a tax engine and makes no claim to be one.
 *
 * Rounding is half-up to the minor unit, matching the rounding rule `0M.R1`'s
 * commercial policy already carries — one rounding convention in the codebase,
 * not two.
 */
export function createFlatRateTaxAdapter(
  args: { basisPoints: number; jurisdictionCode?: string },
  options: { refs?: () => string } = {},
): TaxCalculationPort {
  let counter = 0;
  const nextRef = options.refs ?? (() => `flat-${(counter += 1)}`);
  return guardTaxPort({
    async calculate(request) {
      const basis =
        request.commercialRetailAmountMinorUnits + request.shippingAmountMinorUnits;
      const tax = Math.round((basis * args.basisPoints) / 10_000);
      return {
        provider: "TEST_FLAT_RATE",
        providerCalculationRef: nextRef(),
        currency: request.currency,
        taxAmountMinorUnits: tax,
        basisAmountMinorUnits: basis,
        treatment: tax === 0 ? "EXEMPT" : "TAXABLE",
        jurisdictionCode: args.jurisdictionCode ?? null,
        calculatedAt: request.at,
      };
    },
  });
}

/**
 * An adapter that refuses, for a deployment with no tax engine.
 *
 * **Throws rather than returning zero.** See the module header — this is the
 * behaviour that makes "we never sold something untaxed by accident" true.
 */
export function createUnavailableTaxAdapter(): TaxCalculationPort {
  return {
    async calculate() {
      throw new TaxCalculationUnavailableError();
    },
  };
}

/**
 * The port this deployment should use.
 *
 * Nothing is read at import time, and there is **no production default**: an
 * unconfigured deployment refuses rather than guessing at a rate. An unrecognised
 * provider name is likewise a refusal, not a fallback to zero.
 */
export function resolveTaxPort(env: Env = process.env): TaxCalculationPort {
  if (!isTaxCalculationEnabled(env)) return createUnavailableTaxAdapter();
  const provider = (env.MONACADO_TAX_PROVIDER ?? "").trim().toUpperCase();
  if (provider === "TEST_ZERO_RATE") return createZeroRateTaxAdapter();
  if (provider === "TEST_FLAT_RATE") {
    const raw = Number.parseInt(env.MONACADO_TAX_FLAT_RATE_BASIS_POINTS ?? "", 10);
    if (!Number.isInteger(raw) || raw < 0 || raw > 10_000) {
      return createUnavailableTaxAdapter();
    }
    return createFlatRateTaxAdapter({
      basisPoints: raw,
      ...(env.MONACADO_TAX_JURISDICTION_CODE === undefined
        ? {}
        : { jurisdictionCode: env.MONACADO_TAX_JURISDICTION_CODE }),
    });
  }
  return createUnavailableTaxAdapter();
}
