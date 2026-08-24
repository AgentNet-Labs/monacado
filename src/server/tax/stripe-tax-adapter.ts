/**
 * The Stripe Tax adapter (Phase 1.6) — SERVER ONLY.
 *
 * The production tax engine `1.2` deliberately left unnamed, behind the
 * unchanged `TaxCalculationPort`. **No caller above the port changed to
 * accommodate it**, which is the property that interface was built for.
 *
 * ## Why Stripe Tax
 *
 * Stripe is already the payment platform, and Monacado is merchant of record on
 * those charges. That makes the tax engine sharing the account the one whose
 * registrations, reports, and eventual reversals line up with the charges they
 * concern — a second vendor would mean reconciling two views of one sale, and the
 * first divergence between them is a filing question nobody can answer.
 *
 * It is a **choice, not a lock-in**: everything Stripe-shaped is inside this
 * file, and a second engine is a new adapter plus a new `TAX_PROVIDERS` member.
 *
 * ## What crosses the boundary, and what does not
 *
 * **Outward:** two amounts, a currency, a provider tax code, and **one** bounded
 * destination — the Order's ship-to country, subdivision, and postal code, sent as
 * Stripe's destination address. The **billing address never crosses this
 * boundary**: it belongs to the payment flow, which reaches Stripe separately.
 * **No buyer name, no email, no street line, no customer object, no IP address.**
 * Stripe Tax computes a rate; it does not need to know who is buying, and
 * `customer_details.ip_address` is left unset deliberately rather than by
 * omission.
 *
 * **Inward:** an amount, a treatment, an expiry, and a calculation reference. No
 * raw payload is persisted or logged.
 *
 * ## Everything fails closed
 *
 * An unclassified Product, an unmapped classification, an absent destination, a
 * live-mode answer, a calculation Stripe will not reference, a basis that does not
 * reconcile — each **throws**, and checkout refuses. Not one of them returns a
 * zero. A zero returned because something was misconfigured is indistinguishable
 * from a zero that is genuinely correct, and the difference is a tax liability
 * nobody recorded.
 *
 * ## The client is a narrow port, not the SDK
 *
 * `StripeTaxCalculationClient` is one method wide. Tests inject a double and
 * **no network call occurs anywhere in the test suite** — asserting that the
 * adapter maps classifications correctly should not require an account, a
 * credential, or an internet connection.
 */

import "../server-only";
import type Stripe from "stripe";
import {
  TaxCalculationRequest,
  taxDestinationJurisdictionCode,
  type ProductTaxBasis,
  type TaxCalculationPort,
  type TaxDestination,
  type TaxQuote,
  type TaxTreatment,
} from "../../contracts/marketplace/tax-calculation";
import { getStripeClient } from "../payments/stripe-client";
import {
  readStripeRuntimeConfig,
  resolveTestModeSecretKey,
} from "../payments/stripe-runtime-config";
import { guardTaxPort } from "./tax-port-guard";
import {
  ProductTaxClassificationMissingError,
  TaxCalculationNotReferenceableError,
  TaxClassificationNotMappedError,
  TaxProviderConfigurationError,
  TaxProviderModeNotPermittedError,
  TaxProviderRequestFailedError,
} from "./tax-errors";
import { readStripeTaxRuntimeConfig, type Env, type StripeTaxRuntimeConfig } from "./tax-runtime-config";

/**
 * The single Stripe Tax operation Monacado performs.
 *
 * One method, because one is all this phase does. **Creating a Tax Transaction
 * is deliberately absent** — that is a write into the provider on a confirmed
 * sale, and it belongs with the reversal work that shares its seam. Adding it
 * here would put a provider-side record-keeping obligation inside a function
 * whose job is to answer a question.
 */
export interface StripeTaxCalculationClient {
  createCalculation(
    params: Stripe.Tax.CalculationCreateParams,
    options?: { idempotencyKey?: string },
  ): Promise<Stripe.Tax.Calculation>;
}

/** The live client, built from the same test-mode-only credential path. */
export function createStripeTaxCalculationClient(
  config: StripeTaxRuntimeConfig,
  env: Env = process.env,
): StripeTaxCalculationClient {
  /* Reuses the payment integration's client construction, and therefore its
     pinned API version, its bounded retries, and its refusal of live keys. The
     key is resolved here only to fail early and identically to a payment. */
  resolveTestModeSecretKey(config.apiKeyEnvVar, env as Record<string, string | undefined>);
  const stripeConfig = readStripeRuntimeConfig(env as Record<string, string | undefined>);
  const client = getStripeClient(
    { ...stripeConfig, apiKeyEnvVar: config.apiKeyEnvVar },
    env as Record<string, string | undefined>,
  );
  return {
    createCalculation: (params, options) =>
      client.tax.calculations.create(params, options ?? {}),
  };
}

// — Mapping —

/**
 * Stripe's reason for a zero, translated into Monacado's coarse vocabulary.
 *
 * The distinction that matters: **out of scope** means no taxing regime applied,
 * while **exempt** means one applied and assessed nothing. An auditor reading the
 * first learns Monacado was not collecting there; reading the second, that it was
 * and the answer was zero. Collapsing them would lose the more useful half.
 *
 * Anything Stripe adds later that this does not recognise maps to `EXEMPT`,
 * because "the engine determined no tax is due" is true of every zero — the
 * conservative reading, never a guess at a new reason's meaning.
 */
const OUT_OF_SCOPE_REASONS: ReadonlySet<string> = new Set([
  "not_collecting",
  "not_subject_to_tax",
  "not_supported",
  "reverse_charge",
]);

export function treatmentFrom(calculation: Stripe.Tax.Calculation): TaxTreatment {
  if (calculation.tax_amount_exclusive > 0) return "TAXABLE";
  const breakdown = calculation.tax_breakdown;
  /* No breakdown at all is Stripe saying nothing applied — out of scope, not an
     assessed zero. */
  if (breakdown.length === 0) return "OUT_OF_SCOPE";
  if (breakdown.every((entry) => OUT_OF_SCOPE_REASONS.has(String(entry.taxability_reason)))) {
    return "OUT_OF_SCOPE";
  }
  return "EXEMPT";
}

/**
 * Stripe's representation of the destination Monacado taxes to.
 *
 * A **constant**, because the sourcing rule is one rule: the ship-to address is
 * the tax destination for every sale. `address_source: "shipping"` is Stripe's
 * word for exactly that, and it is stated rather than left to Stripe to infer.
 *
 * This was briefly a function mapping a `BILLING | SHIPPING` enum. The enum is
 * gone — the branch it selected cannot occur — and what is left is the single
 * value it would always have returned.
 */
export const STRIPE_TAX_ADDRESS_SOURCE = "shipping" as const satisfies
  Stripe.Tax.CalculationCreateParams.CustomerDetails.AddressSource;

/**
 * The jurisdiction recorded against the amount: **the one it was sourced to**.
 *
 * Derived from the ship-to destination actually sent, so the recorded
 * jurisdiction is the one the tax was computed for.
 *
 * Deliberately Monacado's own derivation rather than a jurisdiction read back
 * from Stripe: on the pinned API version the calculation-level `tax_breakdown`
 * carries no jurisdiction at all — only the per-line breakdown does, behind an
 * expansion or a second request — and reaching for it would mean either an extra
 * API call on every checkout or quietly reading the shipping line's jurisdiction
 * and calling it the sale's. The engine's own per-jurisdiction breakdown stays
 * reachable through `providerCalculationRef`, which is exactly what that
 * reference is kept for.
 */
export function sourcedJurisdictionCode(request: {
  destination: TaxDestination | null;
}): string | null {
  if (request.destination === null) return null;
  return taxDestinationJurisdictionCode(request.destination);
}

function isoFromUnixSeconds(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  return new Date(seconds * 1_000).toISOString();
}

// — The adapter —

export interface StripeTaxAdapterDeps {
  config?: StripeTaxRuntimeConfig;
  client?: StripeTaxCalculationClient;
  env?: Env;
}

/**
 * The production-capable Stripe Tax port.
 *
 * Wrapped in `guardTaxPort`, so the same currency, basis, coherence, expiry, and
 * Product-basis checks every other adapter is held to apply here too — enforced
 * once, in one place, rather than restated in a vendor adapter that could forget
 * one.
 */
export function createStripeTaxAdapter(deps: StripeTaxAdapterDeps = {}): TaxCalculationPort {
  const env = deps.env ?? process.env;
  const config = deps.config ?? readStripeTaxRuntimeConfig(env);
  if (config.mode !== "TEST") {
    /* Unreachable through `readStripeTaxRuntimeConfig`, which parses a
       single-member enum. Kept because an injected config bypasses that parse,
       and a live-mode configuration must never reach a calculation. */
    throw new TaxProviderConfigurationError(["mode"]);
  }
  const client = deps.client ?? createStripeTaxCalculationClient(config, env);

  return guardTaxPort({
    async calculate(rawRequest) {
      const request = TaxCalculationRequest.parse(rawRequest);

      /* — What the engine cannot compute without — */

      const product: ProductTaxBasis | null = request.product;
      if (product === null) {
        throw new ProductTaxClassificationMissingError(request.internalProductId);
      }
      const taxCode = config.taxCodes[product.taxClassification];
      if (taxCode === undefined) {
        throw new TaxClassificationNotMappedError(product.taxClassification);
      }
      if (request.destination === null) {
        throw new TaxProviderConfigurationError(["destination"]);
      }

      const destination = request.destination;
      const params: Stripe.Tax.CalculationCreateParams = {
        currency: request.currency.toLowerCase(),
        line_items: [
          {
            amount: request.commercialRetailAmountMinorUnits,
            quantity: 1,
            /* Monacado's own opaque Product id. It identifies the line in
               Stripe's tax reports and carries nothing about the buyer. */
            reference: product.internalProductId,
            tax_code: taxCode,
            /* Monacado quotes tax ON TOP of retail — the buyer total is
               retail + tax + shipping — so the amount excludes it. Sending
               `inclusive` would silently reinterpret the retail price as
               tax-inclusive and shrink every party's revenue. */
            tax_behavior: "exclusive",
          },
        ],
        ...(request.shippingAmountMinorUnits > 0
          ? {
              shipping_cost: {
                amount: request.shippingAmountMinorUnits,
                tax_behavior: "exclusive",
                ...(config.shippingTaxCode === null
                  ? {}
                  : { tax_code: config.shippingTaxCode }),
              },
            }
          : {}),
        customer_details: {
          /* ONE address — the Order's ship-to, and never billing. Billing
             belongs to the payment flow and reaches Stripe by its own path;
             sending it here, or sending both and letting Stripe pick, would be
             adopting a sourcing rule by accident. */
          address: {
            country: destination.countryCode,
            ...(destination.regionCode === null ? {} : { state: destination.regionCode }),
            ...(destination.postalCode === null ? {} : { postal_code: destination.postalCode }),
          },
          address_source: STRIPE_TAX_ADDRESS_SOURCE,
        },
      };

      let calculation: Stripe.Tax.Calculation;
      try {
        calculation = await client.createCalculation(
          params,
          request.idempotencyKey === null ? {} : { idempotencyKey: request.idempotencyKey },
        );
      } catch (error) {
        /* The vendor's message is discarded: it can echo the request, and the
           request was about a buyer's address. */
        throw new TaxProviderRequestFailedError(error);
      }

      /* — What the engine's answer must satisfy — */

      if (calculation.livemode) {
        /* The PROVIDER's statement about its own object, not Monacado's belief
           about its configuration. This is the check that catches a deployment
           holding a live credential it thinks is a test one. */
        throw new TaxProviderModeNotPermittedError("LIVE");
      }

      if (calculation.id === null) {
        /* Stripe returns a null id for a calculation that cannot become a
           transaction — typically no registration covers the destination.
           Refused rather than charged on: see the error's own note. */
        throw new TaxCalculationNotReferenceableError();
      }

      const expectedBasis =
        request.commercialRetailAmountMinorUnits + request.shippingAmountMinorUnits;
      const tax = calculation.tax_amount_exclusive;
      /* Stripe's own arithmetic, checked rather than trusted: the total it
         returns must be the basis Monacado sent plus the tax it computed. A
         mismatch means the engine priced something other than this sale, and
         `guardTaxPort` would catch the basis but not this. */
      if (calculation.amount_total !== expectedBasis + tax) {
        throw new TaxProviderRequestFailedError();
      }
      if (calculation.tax_amount_inclusive !== 0) {
        /* Every line was sent `exclusive`. Inclusive tax coming back means the
           engine reinterpreted the amounts, and the buyer's total would be wrong
           in the direction that shorts the seller. */
        throw new TaxProviderRequestFailedError();
      }

      const quote: TaxQuote = {
        provider: "STRIPE_TAX",
        providerMode: "TEST",
        providerCalculationRef: calculation.id,
        currency: request.currency,
        taxAmountMinorUnits: tax,
        basisAmountMinorUnits: expectedBasis,
        treatment: treatmentFrom(calculation),
        jurisdictionCode: sourcedJurisdictionCode(request),
        /* Echoed from the request, so the quote names the EXACT Product source
           version it was calculated under — and `guardTaxPort` checks it. */
        productTaxBasis: product,
        providerTaxCode: taxCode,
        providerConfigVersion: config.configVersion,
        calculatedAt: request.at,
        expiresAt: isoFromUnixSeconds(calculation.expires_at),
      };
      return quote;
    },
  });
}
