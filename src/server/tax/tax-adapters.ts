/**
 * Tax engine adapters (Phase 1.2, production provider added in Phase 1.6) —
 * SERVER ONLY.
 *
 * Three adapters now: two **test** adapters, unchanged, and **Stripe Tax** —
 * selected in `1.6` as the production tax-calculation provider because Stripe is
 * already the payment platform and Monacado is merchant of record on those
 * charges. The Stripe-shaped half lives entirely in `stripe-tax-adapter.ts`; this
 * module only knows which name selects it.
 *
 * ## What `1.2` recorded, and what changed
 *
 * `1.2` declined to name a vendor for two reasons. The first — that choosing one
 * is choosing a third party and a data-processing relationship — is now a
 * decision taken deliberately, in the open, in a phase about exactly that. The
 * second was harder and has since been resolved by other work: a real engine
 * needs to know where the buyer is, and Monacado collected no address. It does
 * now, on `OrderBuyerSnapshot`, and the bounded destination derived from it is
 * what makes a real calculation possible without a street address ever crossing
 * the tax boundary.
 *
 * ## Disabled is a refusal, never a zero
 *
 * With `MONACADO_TAX_ENABLED` unset, `resolveTaxPort` returns an adapter that
 * **throws**. That is still the single most important line in this file. A zero
 * returned because tax is unconfigured is indistinguishable from a zero that is
 * genuinely correct, and the difference is an uncollected liability nobody can
 * find later. Checkout must refuse to sell rather than quietly sell untaxed.
 *
 * The same holds for every `1.6` failure mode — an unclassified Product, an
 * unmapped classification, an unreachable engine. Each throws.
 */

import "../server-only";
import type { TaxCalculationPort } from "../../contracts/marketplace/tax-calculation";
import { TaxCalculationUnavailableError } from "./tax-errors";
import { guardTaxPort } from "./tax-port-guard";
import { isTaxCalculationEnabled, selectedTaxProvider, type Env } from "./tax-runtime-config";

export { guardTaxPort } from "./tax-port-guard";
export { isTaxCalculationEnabled, selectedTaxProvider } from "./tax-runtime-config";
export type { Env } from "./tax-runtime-config";

/**
 * Assesses no tax and says so honestly.
 *
 * `OUT_OF_SCOPE` rather than `TAXABLE` at zero, and the distinction is the point:
 * this adapter is not claiming a rate of zero applies, it is recording that no
 * taxing regime was consulted. An auditor reading `OUT_OF_SCOPE` learns something
 * true; one reading `TAXABLE` + `0` would be misled.
 *
 * Its `1.6` fields are all `null`, and that is the accurate answer: it consulted
 * no classification, used no provider code, and has no expiry — which is also why
 * `productionTaxQuoteIssues` exempts it and `tax-readiness.ts` refuses to let it
 * govern live commerce.
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
        providerMode: "TEST",
        providerCalculationRef: nextRef(),
        currency: request.currency,
        taxAmountMinorUnits: 0,
        basisAmountMinorUnits:
          request.commercialRetailAmountMinorUnits + request.shippingAmountMinorUnits,
        treatment: "OUT_OF_SCOPE",
        jurisdictionCode: null,
        productTaxBasis: request.product,
        providerTaxCode: null,
        providerConfigVersion: null,
        calculatedAt: request.at,
        expiresAt: null,
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
        providerMode: "TEST",
        providerCalculationRef: nextRef(),
        currency: request.currency,
        taxAmountMinorUnits: tax,
        basisAmountMinorUnits: basis,
        treatment: tax === 0 ? "EXEMPT" : "TAXABLE",
        jurisdictionCode: args.jurisdictionCode ?? null,
        productTaxBasis: request.product,
        providerTaxCode: null,
        providerConfigVersion: null,
        calculatedAt: request.at,
        expiresAt: null,
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
 *
 * `STRIPE_TAX` is constructed lazily, and a **configuration failure becomes an
 * adapter that throws** rather than an exception at resolution time. That keeps
 * the resolver's contract uniform — it always returns a port — so a caller cannot
 * accidentally treat "misconfigured" as a different kind of event from "cannot
 * compute". Both refuse the sale, at the same place, with a tax error.
 */
export function resolveTaxPort(env: Env = process.env): TaxCalculationPort {
  if (!isTaxCalculationEnabled(env)) return createUnavailableTaxAdapter();
  const provider = selectedTaxProvider(env);
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
  if (provider === "STRIPE_TAX") return createLazyStripeTaxPort(env);
  return createUnavailableTaxAdapter();
}

/**
 * Stripe Tax, constructed on first use.
 *
 * Deferred for the reason nothing else in this repository reads configuration at
 * import time: resolving a port must not require a credential, and a module that
 * needed one to load could not be imported by a test, a build, or a readiness
 * check. The dynamic import also keeps the Stripe SDK out of any bundle that
 * never calculates tax.
 */
function createLazyStripeTaxPort(env: Env): TaxCalculationPort {
  /* Memoised per resolved port, not globally: a test that supplies a different
     environment gets a different adapter rather than whichever one happened to be
     constructed first — the same rule `getStripeClient` follows. A construction
     that FAILED is not cached, so fixing the configuration takes effect without a
     restart. */
  let adapter: TaxCalculationPort | undefined;
  return {
    async calculate(request) {
      if (adapter === undefined) {
        const { createStripeTaxAdapter } = await import("./stripe-tax-adapter");
        adapter = createStripeTaxAdapter({ env });
      }
      return adapter.calculate(request);
    },
  };
}
