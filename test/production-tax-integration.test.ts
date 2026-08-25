/**
 * Production tax integration contract tests (Phase 1.6).
 *
 * **NO NETWORK, NO STRIPE ACCOUNT, NO CREDENTIAL, NO PRODUCTION WRITE.** The
 * Stripe Tax adapter is exercised through an injected `StripeTaxCalculationClient`
 * double, which is the whole reason that port is one method wide — asserting that
 * a classification maps to the right provider code should not require an internet
 * connection.
 *
 * Persistence — that evidence pins the exact Product source version, that a
 * checkout refuses an unclassified Product, that a replay reuses one calculation
 * — lives in `production-tax-integration.integration.test.ts`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  NEVER_ON_TAX_EVIDENCE,
  OrderTaxEvidenceRecord,
  PRODUCTION_TAX_PROVIDERS,
  MONACADO_RETAIL_TAX_POLICY,
  NEVER_A_TAX_EXEMPTION_INPUT,
  TAX_FILING_BOUNDARY,
  TAX_PROVIDERS,
  TaxCalculationRequest,
  TaxDestination,
  TaxQuote,
  taxDestinationJurisdictionCode,
  isProductionTaxProvider,
  productionTaxQuoteIssues,
  taxQuoteIsUsableAt,
} from "../src/contracts/marketplace/tax-calculation";
import {
  BUYER_ADDRESS_POLICY,
  ShipToAddressRequiredError,
  resolveShipToAddress,
} from "../src/contracts/marketplace/order-buyer-snapshot";
import {
  PRODUCT_TAX_CLASSIFICATIONS,
  ProductTaxClassification,
  taxClassificationAgreesWithDelivery,
} from "../src/contracts/product/product-tax-classification";
import {
  PROJECTION_EXCLUDED_FIELDS,
  ProductSourceRecordSchema,
  productSourceRecordToCapsuleCandidate,
  reviseProductSourceRecord,
} from "../src/contracts/product/product-source-record";
import { ProductData } from "../src/contracts/product/product.capsule";
import { candidateHash } from "../src/contracts/integrity/hash";
import {
  TaxDestinationError,
  resolveTaxDestination,
} from "../src/contracts/marketplace/tax-destination";
import {
  createStripeTaxAdapter,
  treatmentFrom,
  type StripeTaxCalculationClient,
} from "../src/server/tax/stripe-tax-adapter";
import { guardTaxPort } from "../src/server/tax/tax-port-guard";
import { resolveTaxPort } from "../src/server/tax/tax-adapters";
import { taxCalculationIdempotencyKey } from "../src/server/tax/tax-idempotency";
import {
  readStripeTaxRuntimeConfig,
  readTaxComplianceConfig,
  registrationConfigurationIsComplete,
  taxCodeCoverage,
  type StripeTaxRuntimeConfig,
} from "../src/server/tax/tax-runtime-config";
import { evaluateTaxReadiness } from "../src/server/tax/tax-readiness";
import {
  ProductTaxClassificationMissingError,
  TaxCalculationNotReferenceableError,
  TaxClassificationNotMappedError,
  TaxProductBasisMismatchError,
  TaxProviderConfigurationError,
  TaxProviderModeNotPermittedError,
  TaxProviderRequestFailedError,
  TaxQuoteExpiredError,
} from "../src/server/tax/tax-errors";
import { StripeCredentialError } from "../src/server/payments/stripe-runtime-config";
import { requireTaxQuoteMatchesOrder } from "../src/server/tax/tax-evidence-service";
import { formatReport, parseCommandOptions } from "../scripts/tax-readiness";

const opaque = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const AT = "2028-06-01T10:00:00.000Z";
const PRODUCT_ID = `mon:product:${opaque("P16PR0D")}`;
const SREC_ID = `mon:srec:${opaque("P16SREC")}`;

const BILLING = {
  line1: "1 Test Street",
  line2: null,
  city: "Testville",
  region: "CA",
  postalCode: "94103",
  countryCode: "US",
} as const;
const SHIPPING = {
  line1: "9 Delivery Road",
  line2: null,
  city: "Shipton",
  region: "NY",
  postalCode: "10001",
  countryCode: "US",
} as const;

const DIGITAL_TAX_CODE = "txcd_TEST_DIGITAL";
const SOFTWARE_TAX_CODE = "txcd_TEST_SOFTWARE";
const PHYSICAL_TAX_CODE = "txcd_TEST_TANGIBLE";

const CONFIG: StripeTaxRuntimeConfig = {
  mode: "TEST",
  apiKeyEnvVar: "MONACADO_STRIPE_SECRET_KEY",
  taxCodes: {
    DIGITAL_GOOD: DIGITAL_TAX_CODE,
    SOFTWARE: SOFTWARE_TAX_CODE,
    PHYSICAL_GOOD: PHYSICAL_TAX_CODE,
  },
  shippingTaxCode: null,
  configVersion: "test-map/1",
};

const productBasis = (over: Record<string, unknown> = {}) => ({
  internalProductId: PRODUCT_ID,
  sourceRecordId: SREC_ID,
  sourceRecordVersion: "3",
  taxClassification: "DIGITAL_GOOD" as const,
  deliveryMode: "DIGITAL" as const,
  ...over,
});

const request = (over: Record<string, unknown> = {}) => ({
  currency: "USD" as const,
  commercialRetailAmountMinorUnits: 10_000,
  shippingAmountMinorUnits: 0,
  internalProductId: PRODUCT_ID,
  sellerParticipantId: `mon:mpart:${opaque("P16SELLER")}`,
  destination: { countryCode: "US", regionCode: "CA", postalCode: "94103" },
  product: productBasis(),
  idempotencyKey: null,
  at: AT,
  ...over,
});

/**
 * A Stripe Tax calculation shaped exactly as the SDK types describe one.
 *
 * `basis` is retail + shipping, so a shipped sale's `amount_total` reconciles the
 * way the adapter insists it must.
 */
function calculation(
  over: Partial<Stripe.Tax.Calculation> = {},
  basis = 10_000,
): Stripe.Tax.Calculation {
  const tax = over.tax_amount_exclusive ?? 875;
  const base: Stripe.Tax.Calculation = {
    id: "taxcalc_test_1",
    object: "tax.calculation",
    amount_total: basis + tax,
    currency: "usd",
    customer: null,
    customer_details: {
      address: null,
      address_source: "billing",
      ip_address: null,
      tax_ids: [],
      taxability_override: "none",
    },
    expires_at: Math.floor(Date.parse("2028-08-30T10:00:00.000Z") / 1_000),
    livemode: false,
    ship_from_details: null,
    shipping_cost: null,
    tax_amount_exclusive: tax,
    tax_amount_inclusive: 0,
    tax_breakdown: [
      {
        amount: tax,
        inclusive: false,
        tax_rate_details: {
          country: "US",
          flat_amount: null,
          percentage_decimal: "8.75",
          rate_type: "percentage",
          state: "CA",
          tax_type: "sales_tax",
        },
        taxability_reason: "standard_rated",
        taxable_amount: 10_000,
      },
    ],
    tax_date: Math.floor(Date.parse(AT) / 1_000),
    ...over,
  };
  return base;
}

/** Records what was sent, so the mapping can be asserted without a network. */
function clientDouble(
  result: Stripe.Tax.Calculation | (() => Stripe.Tax.Calculation | never) = calculation(),
): StripeTaxCalculationClient & {
  calls: Array<{ params: Stripe.Tax.CalculationCreateParams; idempotencyKey?: string }>;
} {
  const double = {
    calls: [] as Array<{
      params: Stripe.Tax.CalculationCreateParams;
      idempotencyKey?: string;
    }>,
    async createCalculation(
      params: Stripe.Tax.CalculationCreateParams,
      options?: { idempotencyKey?: string },
    ) {
      double.calls.push({
        params,
        ...(options?.idempotencyKey === undefined
          ? {}
          : { idempotencyKey: options.idempotencyKey }),
      });
      return typeof result === "function" ? result() : result;
    },
  };
  return double;
}

const adapter = (
  client: StripeTaxCalculationClient,
  config: StripeTaxRuntimeConfig = CONFIG,
) => createStripeTaxAdapter({ config, client });

// — 1 · Product tax classification —

describe("1.6 · Product tax classification is explicit, versioned, and unpublished", () => {
  const record = {
    sourceRecordId: SREC_ID,
    sourceRecordVersion: "1",
    internalProductId: PRODUCT_ID,
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    authority: {
      creatorId: `mon:creator:${opaque("P16CRE")}`,
      authorityScope: "product-facts",
      authorizationState: "authorized",
    },
    facts: {
      name: "Synthetic Product",
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      deliveryMode: "DIGITAL",
      relationships: { creator: `an:node:${opaque("P16N0DE")}` },
    },
    capsuleSemver: "1.0.0",
    mappingVersion: "product-mapping/1.0.0",
    recordStatus: "draft",
    createdAt: AT,
    updatedAt: AT,
    acquiredAt: AT,
    capsuleGeneratedAt: AT,
  };

  it("offers no UNSPECIFIED member, so absence can never resolve to a code", () => {
    expect(PRODUCT_TAX_CLASSIFICATIONS).toEqual([
      "DIGITAL_GOOD",
      "SOFTWARE",
      "PHYSICAL_GOOD",
      "SERVICE",
    ]);
    for (const invented of ["UNSPECIFIED", "OTHER", "UNKNOWN", "", "digital_good"]) {
      expect(ProductTaxClassification.safeParse(invented).success, invented).toBe(false);
    }
  });

  it("lives on the source record, and never reaches the published capsule", () => {
    /* A fiscal characterization under CREATOR authority would be exactly the
       flat capsule ADR §2's partitioning exists to prevent. */
    expect(ProductData.safeParse({ ...record.facts, taxClassification: "SOFTWARE" }).success).toBe(
      false,
    );
    expect(PROJECTION_EXCLUDED_FIELDS).toContain("taxClassification");

    const unclassified = ProductSourceRecordSchema.parse(record);
    const classified = ProductSourceRecordSchema.parse({
      ...record,
      taxClassification: "SOFTWARE",
    });
    /* Classifying a Product changes NOTHING about the artifact it publishes —
       same candidate, same hash. */
    expect(candidateHash(productSourceRecordToCapsuleCandidate(classified))).toBe(
      candidateHash(productSourceRecordToCapsuleCandidate(unclassified)),
    );
    expect(
      JSON.stringify(productSourceRecordToCapsuleCandidate(classified)),
    ).not.toContain("SOFTWARE");
  });

  it("is carried forward by revision and changed only when stated", () => {
    const v1 = ProductSourceRecordSchema.parse({ ...record, taxClassification: "DIGITAL_GOOD" });
    const v2 = reviseProductSourceRecord({
      prior: v1,
      sourceRecordVersion: "2",
      updatedAt: AT,
      capsuleGeneratedAt: AT,
    });
    expect(v2.taxClassification).toBe("DIGITAL_GOOD");
    const v3 = reviseProductSourceRecord({
      prior: v2,
      sourceRecordVersion: "3",
      updatedAt: AT,
      capsuleGeneratedAt: AT,
      taxClassification: "SOFTWARE",
    });
    expect(v3.taxClassification).toBe("SOFTWARE");
    /* v2 is immutable and still says what it said — which is why a sale can pin
       the version its rate came from. */
    expect(v2.taxClassification).toBe("DIGITAL_GOOD");
  });

  it("reports the one contradiction worth surfacing, and no more", () => {
    expect(taxClassificationAgreesWithDelivery("PHYSICAL_GOOD", "DIGITAL")).toBe(false);
    expect(taxClassificationAgreesWithDelivery("PHYSICAL_GOOD", "PHYSICAL")).toBe(true);
    /* A service performed at an address, and software on a disc, are both
       ordinary. Only tangible property delivered as a download is not. */
    expect(taxClassificationAgreesWithDelivery("SERVICE", "PHYSICAL")).toBe(true);
    expect(taxClassificationAgreesWithDelivery("SOFTWARE", "PHYSICAL")).toBe(true);
    expect(taxClassificationAgreesWithDelivery("DIGITAL_GOOD", "DIGITAL")).toBe(true);
  });
});

// — 2 · The provider selection —

describe("1.6 · Stripe Tax is the selected production provider", () => {
  it("is the only production-capable member, and test adapters are not", () => {
    expect(TAX_PROVIDERS).toContain("STRIPE_TAX");
    expect(PRODUCTION_TAX_PROVIDERS).toEqual(["STRIPE_TAX"]);
    expect(isProductionTaxProvider("STRIPE_TAX")).toBe(true);
    expect(isProductionTaxProvider("TEST_FLAT_RATE")).toBe(false);
    expect(isProductionTaxProvider("TEST_ZERO_RATE")).toBe(false);
  });

  it("resolves from configuration, and an unrecognised name still refuses", async () => {
    /* Constructing the port must not read a credential, so this resolves without
       one. The refusal below is the important half. */
    expect(
      typeof resolveTaxPort({ MONACADO_TAX_ENABLED: "true", MONACADO_TAX_PROVIDER: "STRIPE_TAX" })
        .calculate,
    ).toBe("function");
    await expect(
      resolveTaxPort({ MONACADO_TAX_ENABLED: "true", MONACADO_TAX_PROVIDER: "AVALARA" }).calculate(
        request(),
      ),
    ).rejects.toThrow();
  });
});

// — 3 · The adapter —

describe("1.6 · the Stripe Tax adapter maps Monacado facts to a provider request", () => {
  it("maps the Monacado classification to the configured provider tax code", async () => {
    const client = clientDouble();
    await adapter(client).calculate(request());
    const [call] = client.calls;
    expect(call?.params.line_items[0]?.tax_code).toBe(DIGITAL_TAX_CODE);

    const software = clientDouble();
    await adapter(software).calculate(
      request({ product: productBasis({ taxClassification: "SOFTWARE" }) }),
    );
    expect(software.calls[0]?.params.line_items[0]?.tax_code).toBe(SOFTWARE_TAX_CODE);
  });

  it("returns a normalized quote pinning the exact Product source version", async () => {
    const quote = await adapter(clientDouble()).calculate(request());
    expect(quote.provider).toBe("STRIPE_TAX");
    expect(quote.providerMode).toBe("TEST");
    expect(quote.providerCalculationRef).toBe("taxcalc_test_1");
    expect(quote.taxAmountMinorUnits).toBe(875);
    expect(quote.basisAmountMinorUnits).toBe(10_000);
    expect(quote.treatment).toBe("TAXABLE");
    expect(quote.productTaxBasis).toEqual(productBasis());
    expect(quote.providerTaxCode).toBe(DIGITAL_TAX_CODE);
    expect(quote.providerConfigVersion).toBe("test-map/1");
    expect(quote.expiresAt).toBe("2028-08-30T10:00:00.000Z");
    expect(productionTaxQuoteIssues(quote)).toEqual([]);
  });

  it("sends amounts EXCLUSIVE, and refuses an answer that reinterprets them", async () => {
    const client = clientDouble(calculation({}, 10_500));
    await adapter(client).calculate(request({ shippingAmountMinorUnits: 500 }));
    const params = client.calls[0]!.params;
    expect(params.line_items[0]?.tax_behavior).toBe("exclusive");
    expect(params.shipping_cost?.tax_behavior).toBe("exclusive");
    expect(params.shipping_cost?.amount).toBe(500);

    /* Inclusive tax coming back would mean the retail price had been reread as
       tax-inclusive, shrinking every party's revenue silently. */
    await expect(
      adapter(
        clientDouble(calculation({ tax_amount_inclusive: 100 })),
      ).calculate(request()),
    ).rejects.toBeInstanceOf(TaxProviderRequestFailedError);
  });

  it("sends a bounded destination and no buyer identity at all", async () => {
    const client = clientDouble();
    await adapter(client).calculate(request());
    const details = client.calls[0]!.params.customer_details!;
    expect(details.address).toEqual({ country: "US", state: "CA", postal_code: "94103" });
    expect(details.address_source).toBe("shipping");
    expect(details.ip_address).toBeUndefined();
    expect(client.calls[0]!.params.customer).toBeUndefined();

    const serialized = JSON.stringify(client.calls[0]!.params);
    for (const personal of ["Buyer", "@example", "Test Street", "line1", "email"]) {
      expect(serialized, personal).not.toContain(personal);
    }
  });

  it("does not fabricate a shipping address or a shipping cost for a digital sale", async () => {
    const client = clientDouble();
    await adapter(client).calculate(request());
    expect(client.calls[0]!.params.shipping_cost).toBeUndefined();
    expect(client.calls[0]!.params.ship_from_details).toBeUndefined();
  });

  it("always sends the ship-to destination, for physical and digital alike", async () => {
    /* PHYSICAL: ship-to NY reaches the engine. */
    const physical = clientDouble(calculation({}, 11_200));
    const physicalQuote = await adapter(physical).calculate(
      request({
        shippingAmountMinorUnits: 1_200,
        destination: { countryCode: "US", regionCode: "NY", postalCode: "10001" },
        product: productBasis({ taxClassification: "PHYSICAL_GOOD", deliveryMode: "PHYSICAL" }),
      }),
    );
    const physicalParams = physical.calls[0]!.params;
    expect(physicalParams.customer_details?.address_source).toBe("shipping");
    expect(physicalParams.customer_details?.address).toEqual({
      country: "US",
      state: "NY",
      postal_code: "10001",
    });
    expect(physicalQuote.jurisdictionCode).toBe("US-NY");

    /* DIGITAL: the SAME rule. A ship-to address on a download is a tax
       destination, and the engine is told about it exactly as it is for a
       parcel — no billing address crosses either way. */
    const digital = clientDouble();
    const digitalQuote = await adapter(digital).calculate(
      request({ destination: { countryCode: "US", regionCode: "NY", postalCode: "10001" } }),
    );
    const digitalParams = digital.calls[0]!.params;
    expect(digitalParams.customer_details?.address_source).toBe("shipping");
    expect(digitalParams.customer_details?.address).toEqual({
      country: "US",
      state: "NY",
      postal_code: "10001",
    });
    expect(digitalQuote.jurisdictionCode).toBe("US-NY");
    /* A ship-to address does not make anything ship. */
    expect(digitalParams.shipping_cost).toBeUndefined();
    expect(digitalParams.ship_from_details).toBeUndefined();
  });

  it("translates Stripe's reason for a zero without collapsing the distinction", () => {
    expect(treatmentFrom(calculation())).toBe("TAXABLE");
    expect(
      treatmentFrom(
        calculation({ tax_amount_exclusive: 0, amount_total: 10_000, tax_breakdown: [] }),
      ),
    ).toBe("OUT_OF_SCOPE");
    const zeroWith = (reason: string): Stripe.Tax.Calculation =>
      calculation({
        tax_amount_exclusive: 0,
        amount_total: 10_000,
        tax_breakdown: [
          {
            amount: 0,
            inclusive: false,
            tax_rate_details: {
              country: "US",
              flat_amount: null,
              percentage_decimal: "0",
              rate_type: null,
              state: null,
              tax_type: null,
            },
            taxability_reason: reason as never,
            taxable_amount: 10_000,
          },
        ],
      });
    expect(treatmentFrom(zeroWith("not_collecting"))).toBe("OUT_OF_SCOPE");
    expect(treatmentFrom(zeroWith("product_exempt"))).toBe("EXEMPT");
    /* A reason Stripe adds later reads as EXEMPT — true of every zero — rather
       than as a guess at what the new word means. */
    expect(treatmentFrom(zeroWith("some_future_reason"))).toBe("EXEMPT");
  });
});

// — 4 · Failing closed —

describe("1.6 · everything unresolvable fails closed, and nothing returns zero", () => {
  it("refuses an unclassified Product before contacting the provider", async () => {
    const client = clientDouble();
    await expect(adapter(client).calculate(request({ product: null }))).rejects.toBeInstanceOf(
      ProductTaxClassificationMissingError,
    );
    expect(client.calls).toHaveLength(0);
  });

  it("refuses a classification this deployment maps to no provider code", async () => {
    const client = clientDouble();
    await expect(
      adapter(client).calculate(
        request({ product: productBasis({ taxClassification: "SERVICE" }) }),
      ),
    ).rejects.toBeInstanceOf(TaxClassificationNotMappedError);
    expect(client.calls).toHaveLength(0);
  });

  it("refuses without a destination to compute a rate for", async () => {
    await expect(
      adapter(clientDouble()).calculate(request({ destination: null })),
    ).rejects.toBeInstanceOf(TaxProviderConfigurationError);
  });

  it("refuses a LIVE answer on the provider's own statement, not on our label", async () => {
    await expect(
      adapter(clientDouble(calculation({ livemode: true }))).calculate(request()),
    ).rejects.toBeInstanceOf(TaxProviderModeNotPermittedError);
  });

  it("refuses a calculation the provider will not give a reference for", async () => {
    /* Stripe returns a null id when the calculation cannot become a transaction —
       typically no registration covers the destination. Charging on it would be a
       sale that can never be evidenced to, or reversed with, the engine. */
    await expect(
      adapter(clientDouble(calculation({ id: null }))).calculate(request()),
    ).rejects.toBeInstanceOf(TaxCalculationNotReferenceableError);
  });

  it("refuses a total that does not reconcile with the basis it was sent", async () => {
    await expect(
      adapter(clientDouble(calculation({ amount_total: 99_999 }))).calculate(request()),
    ).rejects.toBeInstanceOf(TaxProviderRequestFailedError);
  });

  it("discards the vendor's message, which could echo the buyer's address", async () => {
    const failing: StripeTaxCalculationClient = {
      async createCalculation() {
        throw new Error("invalid postal_code 94103 for 1 Test Street");
      },
    };
    const error = await adapter(failing)
      .calculate(request())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TaxProviderRequestFailedError);
    expect((error as Error).message).not.toContain("94103");
    expect((error as Error).message).not.toContain("Test Street");
  });

  it("refuses a live credential for tax exactly as it does for a payment", () => {
    const config = readStripeTaxRuntimeConfig({
      MONACADO_TAX_STRIPE_TAX_CODE_DIGITAL_GOOD: DIGITAL_TAX_CODE,
    });
    expect(config.apiKeyEnvVar).toBe("MONACADO_STRIPE_SECRET_KEY");
    /* Tax does not get its own, weaker door into the same Stripe account: the
       one live-prefix refusal is shared. */
    expect(() =>
      createStripeTaxAdapter({
        config,
        env: {
          MONACADO_STRIPE_ENABLED: "true",
          MONACADO_STRIPE_SECRET_KEY: "sk_live_deadbeef",
          MONACADO_STRIPE_SUCCESS_URL: "https://example.test/ok",
          MONACADO_STRIPE_CANCEL_URL: "https://example.test/no",
        },
      }),
    ).toThrow(StripeCredentialError);
  });
});

// — 5 · The port guard —

describe("1.6 · the port guard holds every adapter to the same checks", () => {
  const baseQuote = {
    provider: "STRIPE_TAX" as const,
    providerMode: "TEST" as const,
    providerCalculationRef: "taxcalc_x",
    currency: "USD" as const,
    taxAmountMinorUnits: 875,
    basisAmountMinorUnits: 10_000,
    treatment: "TAXABLE" as const,
    jurisdictionCode: "US-CA",
    productTaxBasis: productBasis(),
    providerTaxCode: DIGITAL_TAX_CODE,
    providerConfigVersion: "test-map/1",
    calculatedAt: AT,
    expiresAt: null,
  };
  const portReturning = (quote: unknown) => guardTaxPort({ async calculate() {
    return quote as never;
  } });

  it("refuses a quote calculated against a different Product source version", async () => {
    await expect(
      portReturning({
        ...baseQuote,
        productTaxBasis: productBasis({ sourceRecordVersion: "4" }),
      }).calculate(request()),
    ).rejects.toBeInstanceOf(TaxProductBasisMismatchError);
    await expect(
      portReturning({
        ...baseQuote,
        productTaxBasis: productBasis({ taxClassification: "SOFTWARE" }),
      }).calculate(request()),
    ).rejects.toBeInstanceOf(TaxProductBasisMismatchError);
  });

  it("refuses an already-expired calculation", async () => {
    await expect(
      portReturning({ ...baseQuote, expiresAt: "2028-05-01T00:00:00.000Z" }).calculate(request()),
    ).rejects.toBeInstanceOf(TaxQuoteExpiredError);
    expect(taxQuoteIsUsableAt(TaxQuote.parse(baseQuote), AT)).toBe(true);
    /* Expiry exactly at the instant reads as expired: a boundary honoured
       "usually" fails in production at the worst moment. */
    expect(
      taxQuoteIsUsableAt(TaxQuote.parse({ ...baseQuote, expiresAt: AT }), AT),
    ).toBe(false);
  });

  it("refuses a production quote that could not be interpreted later", async () => {
    await expect(
      portReturning({ ...baseQuote, providerTaxCode: null }).calculate(request()),
    ).rejects.toBeInstanceOf(TaxProviderConfigurationError);
    expect(
      productionTaxQuoteIssues(
        TaxQuote.parse({ ...baseQuote, providerConfigVersion: null, productTaxBasis: null }),
      ),
    ).toEqual(["productTaxBasis", "providerConfigVersion"]);
  });

  it("refuses a currency the request did not ask about", async () => {
    await expect(
      portReturning({ ...baseQuote, currency: "GBP" }).calculate(request()),
    ).rejects.toThrow();
  });
});

// — 6 · Consistency against the Order —

describe("1.6 · a quote is checked against the Order before a card is charged", () => {
  const order = {
    orderId: `mon:order:${opaque("P16RD")}`,
    internalProductId: PRODUCT_ID,
    quote: {
      currency: "USD",
      quotedCommercialRetailAmountMinorUnits: 10_000,
      quotedTaxAmountMinorUnits: 875,
      quotedShippingAmountMinorUnits: 0,
      quotedOtherPassThroughAmountMinorUnits: 0,
    },
  } as never as Parameters<typeof requireTaxQuoteMatchesOrder>[0];

  const quote = TaxQuote.parse({
    provider: "STRIPE_TAX",
    providerMode: "TEST",
    providerCalculationRef: "taxcalc_x",
    currency: "USD",
    taxAmountMinorUnits: 875,
    basisAmountMinorUnits: 10_000,
    treatment: "TAXABLE",
    jurisdictionCode: "US-CA",
    productTaxBasis: productBasis(),
    providerTaxCode: DIGITAL_TAX_CODE,
    providerConfigVersion: "test-map/1",
    calculatedAt: AT,
    expiresAt: "2028-08-30T10:00:00.000Z",
  });

  it("accepts a quote that matches, at an instant inside its validity", () => {
    expect(() => requireTaxQuoteMatchesOrder(order, quote, AT)).not.toThrow();
  });

  it("refuses a currency mismatch, and a taxable-basis mismatch", () => {
    expect(() =>
      requireTaxQuoteMatchesOrder(order, { ...quote, currency: "GBP" }, AT),
    ).toThrow();
    expect(() =>
      requireTaxQuoteMatchesOrder(order, { ...quote, basisAmountMinorUnits: 9_000 }, AT),
    ).toThrow();
    expect(() =>
      requireTaxQuoteMatchesOrder(order, { ...quote, taxAmountMinorUnits: 1 }, AT),
    ).toThrow();
  });

  it("refuses a quote about a different Product, and one that has expired", () => {
    expect(() =>
      requireTaxQuoteMatchesOrder(
        order,
        {
          ...quote,
          productTaxBasis: productBasis({
            internalProductId: `mon:product:${opaque("0THER")}`,
          }),
        },
        AT,
      ),
    ).toThrow(TaxProductBasisMismatchError);
    expect(() =>
      requireTaxQuoteMatchesOrder(order, quote, "2028-09-01T00:00:00.000Z"),
    ).toThrow(TaxQuoteExpiredError);
  });
});

// — 7 · Idempotency —

describe("1.6 · replay reuses one provider calculation", () => {
  it("is stable across an identical checkout and different when tax could change", () => {
    const facts = request();
    const key = taxCalculationIdempotencyKey(facts);
    expect(key).toMatch(/^mon-tax-[0-9a-f]{64}$/);
    /* The INSTANT is excluded: including it would make every retry a fresh key,
       which is the same as having no key. */
    expect(taxCalculationIdempotencyKey({ ...facts, at: "2029-01-01T00:00:00.000Z" } as never)).toBe(
      key,
    );

    for (const changed of [
      { commercialRetailAmountMinorUnits: 10_001 },
      { shippingAmountMinorUnits: 1 },
      { destination: { countryCode: "US", regionCode: "CA", postalCode: "94104" } },
      /* A different ship-to region is a different calculation. */
      { destination: { countryCode: "US", regionCode: "NY", postalCode: "10001" } },
      { product: productBasis({ sourceRecordVersion: "4" }) },
      { product: productBasis({ taxClassification: "SOFTWARE" }) },
    ]) {
      expect(taxCalculationIdempotencyKey({ ...facts, ...changed }), JSON.stringify(changed)).not.toBe(
        key,
      );
    }
  });

  it("discloses nothing about the buyer", () => {
    const key = taxCalculationIdempotencyKey(request());
    /* Hex only — the postal code and the Product id are the fragments worth
       checking. A two-letter country or region code is indistinguishable from
       random hex, so asserting its absence would prove nothing either way. */
    expect(key).toMatch(/^mon-tax-[0-9a-f]{64}$/);
    for (const fragment of ["94103", PRODUCT_ID]) {
      expect(key.slice("mon-tax-".length), fragment).not.toContain(fragment.toLowerCase());
    }
  });

  it("is handed to the provider so a repeat returns the same calculation", async () => {
    const client = clientDouble();
    const key = taxCalculationIdempotencyKey(request());
    await adapter(client).calculate(request({ idempotencyKey: key }));
    await adapter(client).calculate(request({ idempotencyKey: key }));
    expect(client.calls.map((c) => c.idempotencyKey)).toEqual([key, key]);
  });
});

// — 8 · Configuration —

describe("1.6 · tax configuration ships no fiscal defaults and infers nothing", () => {
  it("ships no default provider tax codes", () => {
    const config = readStripeTaxRuntimeConfig({});
    expect(config.taxCodes).toEqual({});
    expect(taxCodeCoverage(config).unmapped).toEqual([...PRODUCT_TAX_CLASSIFICATIONS]);
    /* A tax code is a fiscal determination about a specific business's
       registrations. A default is that determination made on behalf of a company
       this repository knows nothing about. */
  });

  it("refuses an unrecognised provider mode rather than defaulting to TEST", () => {
    expect(() => readStripeTaxRuntimeConfig({ MONACADO_TAX_STRIPE_MODE: "LIVE" })).toThrow(
      TaxProviderConfigurationError,
    );
    expect(readStripeTaxRuntimeConfig({}).mode).toBe("TEST");
  });

  it("treats a registration claim without a recorded decision as incomplete", () => {
    const claimed = readTaxComplianceConfig({ MONACADO_TAX_REGISTRATIONS_CONFIGURED: "true" });
    expect(claimed.registrationPosture).toBe("PROVIDER_CONFIGURED");
    expect(registrationConfigurationIsComplete(claimed)).toBe(false);

    const complete = readTaxComplianceConfig({
      MONACADO_TAX_REGISTRATIONS_CONFIGURED: "true",
      MONACADO_TAX_REGISTRATION_CONFIG_REF: "OPS-1421 2026-08-24",
    });
    expect(registrationConfigurationIsComplete(complete)).toBe(true);
  });

  it("treats a misspelled filing posture as UNCONFIGURED, never as a filer", () => {
    expect(readTaxComplianceConfig({ MONACADO_TAX_FILING_POSTURE: "PROVIDER" }).filingPosture).toBe(
      "UNCONFIGURED",
    );
    expect(
      readTaxComplianceConfig({ MONACADO_TAX_FILING_POSTURE: "provider_managed" }).filingPosture,
    ).toBe("PROVIDER_MANAGED");
  });
});

// — 9 · Readiness —

describe("1.6 · readiness fails closed, states the posture, and prints no secret", () => {
  const READY_ENV = {
    MONACADO_TAX_ENABLED: "true",
    MONACADO_TAX_PROVIDER: "STRIPE_TAX",
    MONACADO_STRIPE_SECRET_KEY: "sk_test_51SECRETVALUE",
    MONACADO_TAX_STRIPE_TAX_CODE_DIGITAL_GOOD: DIGITAL_TAX_CODE,
    MONACADO_TAX_REGISTRATIONS_CONFIGURED: "true",
    MONACADO_TAX_REGISTRATION_CONFIG_REF: "OPS-1421 2026-08-24",
    MONACADO_TAX_FILING_POSTURE: "PROVIDER_MANAGED",
    /* Phase 1.8 — a recorder nothing runs is not a ready tax system. */
    MONACADO_TAX_RECORDER_SECRET: "p16-dispatcher-secret",
    MONACADO_TAX_RECORDER_SCHEDULE: "vercel-cron:*/5 * * * *",
  };

  it("names every missing control with nothing configured", () => {
    const report = evaluateTaxReadiness(AT, {});
    expect(report.state).toBe("PROVIDER_NOT_CONFIGURED");
    expect(report.calculationConfigured).toBe(false);
    for (const code of [
      "TAX_CALCULATION_NOT_CONFIGURED",
      "REGISTRATION_CONFIGURATION_REQUIRED",
      "FILING_OR_REMITTANCE_CONFIGURATION_REQUIRED",
      "LIVE_PROVIDER_NOT_ENABLED",
    ]) {
      expect(report.blockers).toContain(code);
    }
  });

  it("refuses a test adapter as a production tax engine", () => {
    const report = evaluateTaxReadiness(AT, {
      MONACADO_TAX_ENABLED: "true",
      MONACADO_TAX_PROVIDER: "TEST_FLAT_RATE",
    });
    expect(report.blockers).toContain("TAX_PROVIDER_NOT_PRODUCTION_CAPABLE");
    expect(report.calculationConfigured).toBe(false);
  });

  it("distinguishes calculation readiness from compliance configuration", () => {
    const calculable = {
      MONACADO_TAX_ENABLED: "true",
      MONACADO_TAX_PROVIDER: "STRIPE_TAX",
      MONACADO_STRIPE_SECRET_KEY: "sk_test_x",
      MONACADO_TAX_STRIPE_TAX_CODE_DIGITAL_GOOD: DIGITAL_TAX_CODE,
    };
    const noCompliance = evaluateTaxReadiness(AT, calculable);
    /* Able to calculate, and still owing the decisions that make collecting
       lawful. Reporting them as one number would let clearing the easy half look
       like clearing both. */
    expect(noCompliance.calculationConfigured).toBe(true);
    /* Phase 1.8 — with no dispatcher secret and no declared schedule, the more
       fundamental gap is that nothing would ever RUN the recorder, so that is
       the headline. Declare both and the compliance question resurfaces. */
    expect(noCompliance.state).toBe("TAX_RECORDER_OPERATIONS_REQUIRED");
    expect(
      evaluateTaxReadiness(AT, {
        ...calculable,
        MONACADO_TAX_RECORDER_SECRET: "p16-secret",
        MONACADO_TAX_RECORDER_SCHEDULE: "vercel-cron",
      }).state,
    ).toBe("REGISTRATION_CONFIGURATION_REQUIRED");

    const ready = evaluateTaxReadiness(AT, READY_ENV);
    expect(ready.state).toBe("CALCULATION_READY");
    expect(ready.registration.complete).toBe(true);
    expect(ready.filing.posture).toBe("PROVIDER_MANAGED");
    /* Ready to calculate, and STILL not permitted to charge live — by
       construction, because live-mode support does not exist. */
    expect(ready.liveTaxCommercePermitted).toBe(false);
    expect(ready.blockers).toEqual(["LIVE_PROVIDER_NOT_ENABLED"]);
  });

  it("refuses a live credential, and never echoes any credential value", () => {
    const live = evaluateTaxReadiness(AT, {
      ...READY_ENV,
      MONACADO_STRIPE_SECRET_KEY: "sk_live_REALKEY",
    });
    expect(live.blockers).toContain("TAX_PROVIDER_CREDENTIAL_NOT_CONFIGURED");

    const report = evaluateTaxReadiness(AT, READY_ENV);
    const rendered = formatReport({
      readiness: report,
      catalogue: { state: "SKIPPED", totalProducts: null, classified: null, unclassified: null },
      launchReviewPasses: false,
    });
    const printed = `${rendered}\n${JSON.stringify(report)}`;
    for (const secret of ["sk_test_51SECRETVALUE", "51SECRETVALUE", "sk_live_REALKEY"]) {
      expect(printed, secret).not.toContain(secret);
    }
    /* Variable NAMES are exactly what an operator needs, and are not secrets. */
    expect(printed).toContain("MONACADO_STRIPE_SECRET_KEY");
  });

  it("reads its command flags without touching a database by default", () => {
    expect(parseCommandOptions([])).toEqual({ json: false, useDb: true });
    expect(parseCommandOptions(["--json", "--no-db"])).toEqual({ json: true, useDb: false });
  });
});

// — 10 · Boundaries kept —

describe("1.6 · the boundaries this phase does not cross", () => {
  it("claims no filing or remittance, and says so as a value", () => {
    expect(TAX_FILING_BOUNDARY).toEqual({
      calculation: "IMPLEMENTED",
      /* Phase 1.7 records provider Tax Transactions, so a provider's reports now
         contain Monacado's sales. Filing and remittance below are UNCHANGED —
         somebody still has to be named to submit what those reports show. */
      providerRecordsTransactions: true,
      nexusDetermination: "OPERATOR_AND_ADVISER",
      registration: "OPERATOR_CONFIGURED_IN_PROVIDER",
      filing: "NOT_IMPLEMENTED",
      remittance: "NOT_IMPLEMENTED",
    });
  });

  it("admits no address, payload, or credential onto the request, quote, or evidence", () => {
    /* `strictObject` is the enforcement; this states the intent so a future
       widening has to argue with a named list. */
    for (const forbidden of NEVER_ON_TAX_EVIDENCE) {
      expect(
        OrderTaxEvidenceRecord.safeParse({ forbidden: "x" }).success,
        forbidden,
      ).toBe(false);
    }
    expect(TaxCalculationRequest.safeParse({ ...request(), buyerEmail: "x@y.z" }).success).toBe(
      false,
    );
    expect(
      TaxDestination.safeParse({
        countryCode: "US",
        regionCode: "CA",
        postalCode: "94103",
        line1: "1 Test Street",
      }).success,
    ).toBe(false);
  });

  it("carries no street or city into the destination", () => {
    const destination = resolveTaxDestination(SHIPPING);
    expect(destination).toEqual({ countryCode: "US", regionCode: "NY", postalCode: "10001" });
    expect(Object.keys(destination).sort()).toEqual(["countryCode", "postalCode", "regionCode"]);
  });
});

// — 11 · The settled two-address policy —

describe("1.6 · billing and ship-to, with ship-to governing tax", () => {
  it("states both addresses as always required, and ship-to as the tax source", () => {
    expect(BUYER_ADDRESS_POLICY.billing).toBe("ALWAYS_REQUIRED");
    expect(BUYER_ADDRESS_POLICY.shipTo).toBe("ALWAYS_REQUIRED");
    expect(BUYER_ADDRESS_POLICY.taxJurisdictionSource).toBe("SHIP_TO");
    /* A ship-to address on a digital purchase is a tax destination, not a
       fulfillment instruction. */
    expect(BUYER_ADDRESS_POLICY.digitalShipToImpliesFulfillment).toBe(false);
  });

  it("copies billing into ship-to when the buyer says same-as-billing", () => {
    const resolved = resolveShipToAddress({
      billingAddress: BILLING,
      shippingAddress: null,
      shipToSameAsBilling: true,
    });
    /* A COPY, not a reference: a later correction to billing must not silently
       move where a completed sale was taxed and sent. */
    expect(resolved).toEqual(BILLING);
    expect(resolved).not.toBe(BILLING);
    /* And nobody had to type the same address twice. */
  });

  it("takes a distinct ship-to address when one is supplied", () => {
    expect(
      resolveShipToAddress({
        billingAddress: BILLING,
        shippingAddress: SHIPPING,
        shipToSameAsBilling: false,
      }),
    ).toEqual(SHIPPING);
  });

  it("refuses when neither same-as-billing nor a ship-to address is given", () => {
    /* Never a silent fallback to billing: that would tax a sale to an address
       the buyer never nominated, and the quote would look correct. */
    expect(() =>
      resolveShipToAddress({ billingAddress: BILLING, shippingAddress: null }),
    ).toThrow(ShipToAddressRequiredError);
    expect(() =>
      resolveShipToAddress({
        billingAddress: BILLING,
        shippingAddress: null,
        shipToSameAsBilling: false,
      }),
    ).toThrow(ShipToAddressRequiredError);
  });

  it("normalizes ship-to into the bounded destination, and refuses without one", () => {
    expect(resolveTaxDestination(BILLING)).toEqual({
      countryCode: "US",
      regionCode: "CA",
      postalCode: "94103",
    });
    expect(() => resolveTaxDestination(null)).toThrow(TaxDestinationError);
    /* One condition keeps one name, so a caller that already handles the
       checkout refusal does not learn a second word for it. */
    expect(new TaxDestinationError().detail).toBe("SHIPPING_ADDRESS_REQUIRED");
  });

  it("leaves no billing-versus-shipping choice anywhere in the tax boundary", () => {
    /* The enum that recorded which address had been chosen is gone with the
       branch it selected. A two-member vocabulary with one legitimate production
       value is worse than none: the dead member is an invitation to make it
       reachable again. */
    const contract = readFileSync(
      new URL("../src/contracts/marketplace/tax-calculation.ts", import.meta.url),
      "utf8",
    );
    for (const dead of ["TAX_DESTINATION_SOURCES", "destinationSource", "BUYER_DECLARED"]) {
      expect(contract, dead).not.toContain(dead);
    }
    /* And no third buyer-facing tax address exists. */
    expect(MONACADO_RETAIL_TAX_POLICY.addressesCollected).toEqual(["BILLING", "SHIP_TO"]);
  });
});

// — 12 · Standard retail tax policy —

describe("1.6 · ordinary checkout has no buyer tax-exemption workflow", () => {
  it("accepts no exemption credential, and has no field for one", () => {
    expect(MONACADO_RETAIL_TAX_POLICY.buyerExemptionCredentials).toBe("NOT_ACCEPTED");
    expect(MONACADO_RETAIL_TAX_POLICY.buyerExemptionWorkflow).toBe("NOT_IMPLEMENTED");
    for (const forbidden of NEVER_A_TAX_EXEMPTION_INPUT) {
      expect(
        TaxCalculationRequest.safeParse({ ...request(), [forbidden]: "x" }).success,
        forbidden,
      ).toBe(false);
      expect(
        OrderTaxEvidenceRecord.safeParse({ [forbidden]: "x" }).success,
        forbidden,
      ).toBe(false);
    }
  });

  it("treats a provider-determined zero as a valid result, not a suspicious one", async () => {
    /* Zero is what the engine returned for the pinned classification and the
       ship-to jurisdiction. It is evidenced by the same calculation reference as
       any other amount, and reaches no exemption path — because there is none. */
    const quote = await adapter(
      clientDouble(
        calculation({
          tax_amount_exclusive: 0,
          amount_total: 10_000,
          tax_breakdown: [
            {
              amount: 0,
              inclusive: false,
              tax_rate_details: {
                country: "US",
                flat_amount: null,
                percentage_decimal: "0",
                rate_type: null,
                state: null,
                tax_type: null,
              },
              taxability_reason: "product_exempt",
              taxable_amount: 10_000,
            },
          ],
        }),
      ),
    ).calculate(request());

    expect(quote.taxAmountMinorUnits).toBe(0);
    expect(quote.treatment).toBe("EXEMPT");
    /* Still fully evidenced: same provider reference, same pinned Product basis,
       same mapping version. */
    expect(quote.providerCalculationRef).toBe("taxcalc_test_1");
    expect(quote.productTaxBasis).toEqual(productBasis());
    expect(productionTaxQuoteIssues(quote)).toEqual([]);
    expect(MONACADO_RETAIL_TAX_POLICY.providerDeterminedNonTaxability).toBe(
      "PERMITTED_AND_EVIDENCED",
    );
  });

  it("puts buyer recovery and correction authority in policy, not in checkout", () => {
    expect(MONACADO_RETAIL_TAX_POLICY.buyerRecovery).toBe(
      "BUYER_RESPONSIBILITY_VIA_TAX_AUTHORITY",
    );
    expect(MONACADO_RETAIL_TAX_POLICY.correctionAuthority).toBe("MONACADO_OR_PROVIDER");
    expect(MONACADO_RETAIL_TAX_POLICY.buyerFacingExpression).toBe(
      "MARKETPLACE_POLICY_AND_TERMS",
    );
  });
});
