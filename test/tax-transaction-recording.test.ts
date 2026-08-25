/**
 * Tax transaction recording contract tests (Phase 1.7).
 *
 * **NO NETWORK, NO STRIPE ACCOUNT, NO CREDENTIAL, NO AGENTNET PUBLICATION.** The
 * Stripe Tax Transaction client is an injected double, which is the whole reason
 * that port is one method wide.
 *
 * Persistence — that a paid Order commits exactly one obligation, that replay
 * does not create a second, that a retry is idempotent, that reconciliation names
 * a gap — lives in `tax-transaction-recording.integration.test.ts`.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type Stripe from "stripe";
import {
  IMMUTABLE_TAX_TRANSACTION_FIELDS,
  IMPLEMENTED_TAX_TRANSACTION_LIFECYCLE_STATES,
  NEVER_ON_TAX_TRANSACTION,
  OrderTaxTransactionRecord,
  TAX_TRANSACTION_LIFECYCLE_STATES,
  TAX_TRANSACTION_RECORDING_STATUSES,
  TAX_TRANSACTION_RETRY_POLICY,
  classifyTaxRecordingFailure,
  nextTaxRecordingAttemptAt,
  requiresProviderTaxTransaction,
  taxTransactionIsCoherent,
} from "../src/contracts/marketplace/tax-transaction";
import {
  PROVIDER_AUDIT_SEAM,
  TAX_RECONCILIATION_FINDING_CODES,
} from "../src/contracts/marketplace/tax-reconciliation";
import {
  CAPSULE_VISIBILITY_POLICY,
  PUBLIC_DISCLOSURE_REQUIREMENTS,
  capsuleVisibilityFor,
  isPubliclyDiscoverable,
} from "../src/contracts/capsule/visibility";
import {
  DEFAULT_TAX_TRANSACTION_CAPSULE_SEMVER,
  NEVER_IN_TAX_TRANSACTION_CAPSULE,
  TAX_CAPSULE_PUBLICATION_DISPOSITION,
  TAX_TRANSACTION_MAPPING_VERSION,
  TaxTransactionCapsuleData,
  TaxTransactionProjectionError,
  projectTaxTransactionCapsule,
  taxTransactionCapsuleHash,
} from "../src/contracts/marketplace/tax-transaction.capsule";
import { TAX_FILING_BOUNDARY } from "../src/contracts/marketplace/tax-calculation";
import {
  classifyStripeTaxTransactionError,
  createStripeTaxTransactionRecorder,
  providerTotalFrom,
  type StripeTaxTransactionClient,
} from "../src/server/tax/stripe-tax-transaction-adapter";
import { taxTransactionIdempotencyKey } from "../src/server/tax/tax-transaction-idempotency";
import { evaluateTaxReadiness } from "../src/server/tax/tax-readiness";
import { parseCommandOptions } from "../scripts/run-tax-transaction-recorder";

const opaque = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const AT = "2028-07-01T10:00:00.000Z";
const TX_ID = `mon:txtax:${opaque("P17TX")}`;
const ORDER_ID = `mon:order:${opaque("P170RD")}`;
const EVIDENCE_ID = `mon:taxe:${opaque("P17EV")}`;
const CALC_REF = "taxcalc_test_1";

const record = (over: Record<string, unknown> = {}) =>
  OrderTaxTransactionRecord.parse({
    taxTransactionId: TX_ID,
    orderId: ORDER_ID,
    taxEvidenceId: EVIDENCE_ID,
    provider: "STRIPE_TAX",
    providerMode: "TEST",
    providerCalculationRef: CALC_REF,
    providerTaxTransactionRef: "taxtxn_test_1",
    providerReference: ORDER_ID,
    currency: "USD",
    taxableBasisMinorUnits: 10_000,
    taxAmountMinorUnits: 875,
    providerTotalAmountMinorUnits: 10_875,
    jurisdictionCode: "US-NY",
    treatment: "TAXABLE",
    internalProductId: `mon:product:${opaque("P17PR0D")}`,
    productSourceRecordId: `mon:srec:${opaque("P17SREC")}`,
    productSourceRecordVersion: "1",
    productTaxClassification: "DIGITAL_GOOD",
    providerTaxCode: "txcd_TEST_DIGITAL",
    providerConfigVersion: "test-map/1",
    calculatedAt: AT,
    providerTaxTransactionCreatedAt: AT,
    recordedAt: AT,
    lifecycleState: "RECORDED",
    recordingStatus: "RECORDED",
    attemptCount: 1,
    nextAttemptAt: null,
    lastFailureCode: null,
    lastFailureClass: null,
    finalizedAt: AT,
    updatedAt: AT,
    ...over,
  });

/** A Stripe Tax Transaction shaped exactly as the SDK types describe one. */
function transaction(over: Partial<Stripe.Tax.Transaction> = {}): Stripe.Tax.Transaction {
  return {
    id: "taxtxn_test_1",
    object: "tax.transaction",
    created: Math.floor(Date.parse(AT) / 1_000),
    currency: "usd",
    customer: null,
    customer_details: {
      address: null,
      address_source: "shipping",
      ip_address: null,
      tax_ids: [],
      taxability_override: "none",
    },
    line_items: {
      object: "list",
      data: [
        {
          id: "tax_li_1",
          object: "tax.transaction_line_item",
          amount: 10_000,
          amount_tax: 875,
          livemode: false,
          metadata: null,
          product: null,
          quantity: 1,
          reference: "line-1",
          reversal: null,
          tax_behavior: "exclusive",
          tax_code: "txcd_TEST_DIGITAL",
          type: "transaction",
        },
      ],
      has_more: false,
      url: "/v1/tax/transactions/taxtxn_test_1/line_items",
    } as never,
    livemode: false,
    metadata: null,
    posted_at: Math.floor(Date.parse(AT) / 1_000),
    reference: ORDER_ID,
    reversal: null,
    ship_from_details: null,
    shipping_cost: null,
    tax_date: Math.floor(Date.parse(AT) / 1_000),
    type: "transaction",
    ...over,
  } as Stripe.Tax.Transaction;
}

function clientDouble(
  result: Stripe.Tax.Transaction | (() => Stripe.Tax.Transaction) = transaction(),
): StripeTaxTransactionClient & {
  calls: Array<{
    params: Stripe.Tax.TransactionCreateFromCalculationParams;
    idempotencyKey?: string;
  }>;
} {
  const double = {
    calls: [] as Array<{
      params: Stripe.Tax.TransactionCreateFromCalculationParams;
      idempotencyKey?: string;
    }>,
    async createFromCalculation(
      params: Stripe.Tax.TransactionCreateFromCalculationParams,
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

const recorder = (client: StripeTaxTransactionClient) =>
  createStripeTaxTransactionRecorder({
    config: {
      mode: "TEST",
      apiKeyEnvVar: "MONACADO_STRIPE_SECRET_KEY",
      taxCodes: { DIGITAL_GOOD: "txcd_TEST_DIGITAL" },
      shippingTaxCode: null,
      configVersion: "test-map/1",
    },
    client,
  });

const request = {
  providerCalculationRef: CALC_REF,
  providerReference: ORDER_ID,
  idempotencyKey: taxTransactionIdempotencyKey({
    orderId: ORDER_ID,
    providerCalculationRef: CALC_REF,
  }),
};

// — 1 · The provider call —

describe("1.7 · the Stripe Tax Transaction adapter reports from the exact calculation", () => {
  it("creates the transaction from the exact calculation reference", async () => {
    const client = clientDouble();
    const result = await recorder(client).record(request);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!.params.calculation).toBe(CALC_REF);
    /* The Order id, which Stripe enforces unique across ALL its transactions
       including reversals — the guard a lost Monacado key cannot defeat. */
    expect(client.calls[0]!.params.reference).toBe(ORDER_ID);
    expect(result.outcome).toBe("RECORDED");
  });

  it("expands line items, because a Tax Transaction carries no total", async () => {
    const client = clientDouble();
    const result = await recorder(client).record(request);
    expect(client.calls[0]!.params.expand).toEqual(["line_items"]);
    expect(result).toMatchObject({
      outcome: "RECORDED",
      providerTaxTransactionRef: "taxtxn_test_1",
      /* Summed from the lines: 10_000 basis + 875 tax. */
      providerTotalAmountMinorUnits: 10_875,
    });
  });

  it("sums shipping into the provider total, and reports an absent list as unknown", () => {
    expect(providerTotalFrom(transaction())).toBe(10_875);
    expect(
      providerTotalFrom(
        transaction({
          shipping_cost: {
            amount: 1_200,
            amount_tax: 105,
            tax_behavior: "exclusive",
            tax_code: "txcd_TEST_SHIPPING",
          } as never,
        }),
      ),
    ).toBe(12_180);
    /* `null` means "the provider did not tell us", never zero. */
    expect(providerTotalFrom(transaction({ line_items: null }))).toBeNull();
  });

  it("hands the provider a stable idempotency key, identical on every attempt", async () => {
    const client = clientDouble();
    await recorder(client).record(request);
    await recorder(client).record(request);
    expect(client.calls[0]!.idempotencyKey).toMatch(/^mon-taxtx-[0-9a-f]{64}$/);
    /* Derived from the Order and the calculation only — no clock, no attempt
       counter — so a retry after a timeout reuses the provider's existing
       transaction instead of creating a second. */
    expect(client.calls[1]!.idempotencyKey).toBe(client.calls[0]!.idempotencyKey);

    const other = taxTransactionIdempotencyKey({
      orderId: ORDER_ID,
      providerCalculationRef: "taxcalc_test_2",
    });
    expect(other).not.toBe(client.calls[0]!.idempotencyKey);
  });

  it("refuses a LIVE answer on the provider's own statement", async () => {
    const result = await recorder(clientDouble(transaction({ livemode: true }))).record(request);
    expect(result).toEqual({ outcome: "FAILED", failureCode: "PROVIDER_MODE_NOT_PERMITTED" });
  });

  it("classifies failures without keeping a word of the vendor's message", async () => {
    const failing: StripeTaxTransactionClient = {
      async createFromCalculation() {
        throw Object.assign(new Error("no such calculation for 9 Delivery Road, NY 10001"), {
          type: "StripeInvalidRequestError",
          statusCode: 400,
        });
      },
    };
    const result = await recorder(failing).record(request);
    expect(result).toEqual({ outcome: "FAILED", failureCode: "PROVIDER_REJECTED" });
    expect(JSON.stringify(result)).not.toContain("10001");
    expect(JSON.stringify(result)).not.toContain("Delivery Road");
  });

  it("maps the conditions that decide whether another attempt happens", () => {
    expect(classifyStripeTaxTransactionError({ type: "StripeConnectionError" })).toBe(
      "PROVIDER_UNAVAILABLE",
    );
    expect(classifyStripeTaxTransactionError({ statusCode: 503 })).toBe("PROVIDER_UNAVAILABLE");
    expect(classifyStripeTaxTransactionError({ code: "resource_already_exists" })).toBe(
      "DUPLICATE_REFERENCE",
    );
    expect(classifyStripeTaxTransactionError({ code: "tax_calculation_expired" })).toBe(
      "CALCULATION_EXPIRED",
    );
    /* An unclassified condition is retried rather than abandoned. */
    expect(classifyTaxRecordingFailure(classifyStripeTaxTransactionError({}))).toBe("TRANSIENT");

    /* A duplicate and an expired calculation never improve with retrying. */
    expect(classifyTaxRecordingFailure("DUPLICATE_REFERENCE")).toBe("PERMANENT");
    expect(classifyTaxRecordingFailure("CALCULATION_EXPIRED")).toBe("PERMANENT");
    expect(classifyTaxRecordingFailure("PROVIDER_UNAVAILABLE")).toBe("TRANSIENT");
  });

  it("reports an unconfigured deployment rather than throwing inside a worker", async () => {
    const result = await createStripeTaxTransactionRecorder({ env: {} }).record(request);
    expect(result).toEqual({ outcome: "FAILED", failureCode: "PROVIDER_NOT_CONFIGURED" });
  });
});

// — 2 · Zero tax —

describe("1.7 · a zero-tax sale is still reported", () => {
  it("requires a provider transaction regardless of amount or treatment", () => {
    for (const treatment of ["TAXABLE", "EXEMPT", "OUT_OF_SCOPE"] as const) {
      expect(
        requiresProviderTaxTransaction({ treatment, taxAmountMinorUnits: 0 }),
        treatment,
      ).toBe(true);
    }
    /* A jurisdiction where Monacado collected nothing is a RETURN LINE, not an
       absence, and a transaction the provider never saw cannot appear on one. */
  });

  it("records a zero-tax transaction with its treatment and references intact", async () => {
    const zero = transaction({
      line_items: {
        object: "list",
        data: [
          {
            id: "tax_li_1",
            object: "tax.transaction_line_item",
            amount: 10_000,
            amount_tax: 0,
            livemode: false,
            metadata: null,
            product: null,
            quantity: 1,
            reference: "line-1",
            reversal: null,
            tax_behavior: "exclusive",
            tax_code: "txcd_TEST_DIGITAL",
            type: "transaction",
          },
        ],
        has_more: false,
        url: "/x",
      } as never,
    });
    const result = await recorder(clientDouble(zero)).record(request);
    expect(result).toMatchObject({
      outcome: "RECORDED",
      providerTaxTransactionRef: "taxtxn_test_1",
      providerTotalAmountMinorUnits: 10_000,
    });

    /* And the record keeps the distinction a zero came under. */
    const exempt = record({
      taxAmountMinorUnits: 0,
      treatment: "EXEMPT",
      providerTotalAmountMinorUnits: 10_000,
    });
    expect(taxTransactionIsCoherent(exempt)).toBe(true);
    expect(exempt.providerCalculationRef).toBe(CALC_REF);
    expect(exempt.productTaxClassification).toBe("DIGITAL_GOOD");
    expect(exempt.jurisdictionCode).toBe("US-NY");
  });
});

// — 3 · Immutability and lifecycle —

describe("1.7 · sale-time facts are immutable, lifecycle is not", () => {
  it("names the immutable fields, and none of them is a lifecycle column", () => {
    for (const mutable of [
      "recordingStatus",
      "lifecycleState",
      "attemptCount",
      "nextAttemptAt",
      "providerTaxTransactionRef",
      "providerTotalAmountMinorUnits",
      "providerTaxTransactionCreatedAt",
      "lastFailureCode",
      "finalizedAt",
    ]) {
      expect(IMMUTABLE_TAX_TRANSACTION_FIELDS, mutable).not.toContain(mutable);
    }
    for (const immutable of [
      "providerCalculationRef",
      "taxableBasisMinorUnits",
      "taxAmountMinorUnits",
      "productSourceRecordVersion",
      "productTaxClassification",
      "calculatedAt",
    ]) {
      expect(IMMUTABLE_TAX_TRANSACTION_FIELDS, immutable).toContain(immutable);
    }
  });

  it("reserves the correction vocabulary without pretending those flows exist", () => {
    expect(TAX_TRANSACTION_LIFECYCLE_STATES).toEqual([
      "RECORDED",
      "ADJUSTED",
      "PARTIALLY_REVERSED",
      "REVERSED",
    ]);
    /* Only one is reachable in this phase, and a test says so rather than a
       comment. */
    expect(IMPLEMENTED_TAX_TRANSACTION_LIFECYCLE_STATES).toEqual(["RECORDED"]);
  });

  it("refuses a recorded transaction whose provider total does not reconcile", () => {
    expect(taxTransactionIsCoherent(record())).toBe(true);
    expect(
      taxTransactionIsCoherent(record({ providerTotalAmountMinorUnits: 99_999 })),
    ).toBe(false);
    expect(
      taxTransactionIsCoherent(record({ providerTaxTransactionRef: null })),
    ).toBe(false);
    /* A row that has not been reported yet has no provider total to check. */
    expect(
      taxTransactionIsCoherent(
        record({
          recordingStatus: "PENDING",
          providerTaxTransactionRef: null,
          providerTotalAmountMinorUnits: null,
          finalizedAt: null,
          attemptCount: 0,
        }),
      ),
    ).toBe(true);
  });

  it("bounds retries on an increasing, readable schedule", () => {
    expect(TAX_TRANSACTION_RECORDING_STATUSES).toEqual([
      "PENDING",
      "IN_PROGRESS",
      "RECORDED",
      "RETRY_PENDING",
      "FAILED_PERMANENT",
    ]);
    expect(nextTaxRecordingAttemptAt({ attemptCount: 1, failedAt: AT })).toBe(
      "2028-07-01T10:00:30.000Z",
    );
    /* Spent attempts yield null, which is what makes the retry bounded. */
    expect(
      nextTaxRecordingAttemptAt({
        attemptCount: TAX_TRANSACTION_RETRY_POLICY.maxAttempts,
        failedAt: AT,
      }),
    ).toBeNull();
  });

  it("admits no buyer identity, payload, or exemption credential", () => {
    for (const forbidden of NEVER_ON_TAX_TRANSACTION) {
      expect(
        OrderTaxTransactionRecord.safeParse({ ...record(), [forbidden]: "x" }).success,
        forbidden,
      ).toBe(false);
    }
  });
});

// — 4 · The private capsule —

describe("1.7 · the tax capsule is private, deterministic, and free of buyer PII", () => {
  const context = {
    generatedAt: AT,
    capsuleSemver: DEFAULT_TAX_TRANSACTION_CAPSULE_SEMVER,
    mappingVersion: TAX_TRANSACTION_MAPPING_VERSION,
  };

  it("defaults tax transactions to PRIVATE, and says why in one place", () => {
    expect(capsuleVisibilityFor("TaxTransaction")).toBe("PRIVATE");
    expect(isPubliclyDiscoverable("TaxTransaction")).toBe(false);
    /* Public capsules are for discoverability; this one is not one. */
    for (const publicType of ["Product", "Storefront", "Offer", "Listing"] as const) {
      expect(CAPSULE_VISIBILITY_POLICY[publicType], publicType).toBe("PUBLIC");
    }
    expect(PUBLIC_DISCLOSURE_REQUIREMENTS.governanceDecision).toBe("REQUIRED");
    expect(PUBLIC_DISCLOSURE_REQUIREMENTS.publicationInThisPhase).toBe("NONE");
  });

  it("projects deterministically, and stamps the visibility on the candidate", () => {
    const first = projectTaxTransactionCapsule(record(), context);
    const second = projectTaxTransactionCapsule(record(), context);
    expect(first).toEqual(second);
    expect(taxTransactionCapsuleHash(first)).toBe(taxTransactionCapsuleHash(second));
    expect(first.visibility).toBe("PRIVATE");
    expect(first["@type"]).toBe("TaxTransaction");
    /* CandidateMetadata, not PublishedMetadata: nothing is published, so no
       capsule id, Node binding, Publisher, or publishedAt is fabricated. */
    expect(first.metadata).not.toHaveProperty("capsuleId");
    expect(first.metadata).not.toHaveProperty("publishedAt");
    expect(first.metadata.provenance.sourceRecordType).toBe("OrderTaxTransaction");
  });

  it("exposes the facts an internal reader needs and no buyer identity at all", () => {
    const capsule = projectTaxTransactionCapsule(record(), context);
    expect(capsule.data).toMatchObject({
      taxTransactionRef: TX_ID,
      orderRef: ORDER_ID,
      currency: "USD",
      taxableBasisMinorUnits: 10_000,
      taxAmountMinorUnits: 875,
      shipToJurisdictionCode: "US-NY",
      treatment: "TAXABLE",
      productTaxClassification: "DIGITAL_GOOD",
      provider: "STRIPE_TAX",
      providerMode: "TEST",
      providerCalculationRef: CALC_REF,
      providerTaxTransactionRef: "taxtxn_test_1",
      lifecycleState: "RECORDED",
      /* Empty by construction — this phase records no corrections. */
      adjustmentRefs: [],
    });

    const serialized = JSON.stringify(capsule);
    for (const personal of ["Delivery Road", "Testville", "@example", "sk_test"]) {
      expect(serialized, personal).not.toContain(personal);
    }
    for (const forbidden of NEVER_IN_TAX_TRANSACTION_CAPSULE) {
      expect(
        TaxTransactionCapsuleData.safeParse({ ...capsule.data, [forbidden]: "x" }).success,
        forbidden,
      ).toBe(false);
    }
  });

  it("projects an unreported transaction rather than hiding it", () => {
    /* A committed-but-unreported row is exactly what a reconciliation agent needs
       to reason about; refusing to project it would hide the rows that matter. */
    const pending = projectTaxTransactionCapsule(
      record({
        recordingStatus: "PENDING",
        providerTaxTransactionRef: null,
        providerTotalAmountMinorUnits: null,
        providerTaxTransactionCreatedAt: null,
        finalizedAt: null,
        attemptCount: 0,
      }),
      context,
    );
    expect(pending.data.providerTaxTransactionRef).toBeNull();
    expect(pending.data.providerTotalAmountMinorUnits).toBeNull();
  });

  it("fails closed on an invalid record or context, and repairs nothing", () => {
    expect(() => projectTaxTransactionCapsule({ nope: true }, context)).toThrow(
      TaxTransactionProjectionError,
    );
    expect(() => projectTaxTransactionCapsule(record(), { generatedAt: "no" })).toThrow(
      TaxTransactionProjectionError,
    );
  });

  it("publishes nothing to AgentNet, and contains no publication machinery", () => {
    expect(TAX_CAPSULE_PUBLICATION_DISPOSITION).toEqual({
      visibility: "PRIVATE",
      agentNetPublication: "NONE",
      nodeRegistration: "NONE",
      registrarContact: "NONE",
      publicResolverExposure: "NONE",
    });
    /* Asserted against the source's IMPORTS, not its prose: no registrar
       transport, publication outbox, or Node registration is reachable from the
       tax capsule module. (The prose mentions them precisely to say they are
       absent, so matching on words would assert the opposite of the intent.) */
    const source = readFileSync(
      new URL("../src/contracts/marketplace/tax-transaction.capsule.ts", import.meta.url),
      "utf8",
    );
    const imports = source.match(/^import .*$/gm) ?? [];
    for (const machinery of ["registrar", "publication", "outbox", "transport"]) {
      expect(imports.join("\n").toLowerCase(), machinery).not.toContain(machinery);
    }
    /* And no publication metadata is fabricated: a candidate carries none. */
    const capsule = projectTaxTransactionCapsule(record(), context);
    for (const published of ["capsuleId", "bindsToNode", "publishedBy", "publishedAt"]) {
      expect(Object.keys(capsule.metadata), published).not.toContain(published);
    }
  });
});

// — 5 · Reconciliation vocabulary and readiness —

describe("1.7 · reconciliation is local, and readiness separates the two capabilities", () => {
  it("names every divergence it can conclude, and consults no provider", () => {
    for (const code of [
      "PAID_ORDER_MISSING_TAX_TRANSACTION",
      "TAXABLE_BASIS_MISMATCH",
      "TAX_AMOUNT_MISMATCH",
      "CURRENCY_MISMATCH",
      "PRODUCT_VERSION_MISMATCH",
      "CONFLICTING_PROVIDER_REFERENCE",
    ]) {
      expect(TAX_RECONCILIATION_FINDING_CODES).toContain(code);
    }
    expect(PROVIDER_AUDIT_SEAM.routineReconciliation).toBe("LOCAL_RECORDS_ONLY");
    expect(PROVIDER_AUDIT_SEAM.providerLookup).toBe("NOT_IMPLEMENTED");
  });

  it("reports recording capability separately from calculation capability", () => {
    const configured = {
      MONACADO_TAX_ENABLED: "true",
      MONACADO_TAX_PROVIDER: "STRIPE_TAX",
      MONACADO_STRIPE_SECRET_KEY: "sk_test_x",
      MONACADO_TAX_STRIPE_TAX_CODE_DIGITAL_GOOD: "txcd_TEST_DIGITAL",
    };
    const ready = evaluateTaxReadiness(AT, configured);
    expect(ready.calculationConfigured).toBe(true);
    expect(ready.taxTransactionRecordingAvailable).toBe(true);
    expect(ready.satisfied).toContain("TAX_TRANSACTION_RECORDING");
    /* Phase 1.8 — the recording CAPABILITY is available and the lifecycle is
       still not ready, because nothing would invoke the recorder. Declaring the
       dispatcher and its schedule is what closes it. */
    expect(ready.taxLifecycleReady).toBe(false);
    expect(
      evaluateTaxReadiness(AT, {
        ...configured,
        MONACADO_TAX_RECORDER_SECRET: "p17-secret",
        MONACADO_TAX_RECORDER_SCHEDULE: "vercel-cron",
      }).taxLifecycleReady,
    ).toBe(true);
  });

  it("refuses tax lifecycle readiness when recording capability is absent", () => {
    /* A credential the provider needs is missing: tax can neither be calculated
       nor reported, and BOTH are reported false rather than one masking the
       other. */
    const noCredential = evaluateTaxReadiness(AT, {
      MONACADO_TAX_ENABLED: "true",
      MONACADO_TAX_PROVIDER: "STRIPE_TAX",
      MONACADO_TAX_STRIPE_TAX_CODE_DIGITAL_GOOD: "txcd_TEST_DIGITAL",
    });
    expect(noCredential.taxTransactionRecordingAvailable).toBe(false);
    expect(noCredential.taxLifecycleReady).toBe(false);
    expect(noCredential.blockers).toContain("TAX_TRANSACTION_RECORDING_NOT_AVAILABLE");

    /* A test adapter can never report a provider transaction either. */
    const testAdapter = evaluateTaxReadiness(AT, {
      MONACADO_TAX_ENABLED: "true",
      MONACADO_TAX_PROVIDER: "TEST_FLAT_RATE",
    });
    expect(testAdapter.taxTransactionRecordingAvailable).toBe(false);
    expect(testAdapter.taxLifecycleReady).toBe(false);
  });

  it("does not let recording imply filing readiness", () => {
    /* Stripe's reports now contain Monacado's sales. Somebody still has to be
       named to file them, and this phase names nobody. */
    expect(TAX_FILING_BOUNDARY.providerRecordsTransactions).toBe(true);
    expect(TAX_FILING_BOUNDARY.filing).toBe("NOT_IMPLEMENTED");
    expect(TAX_FILING_BOUNDARY.remittance).toBe("NOT_IMPLEMENTED");

    const ready = evaluateTaxReadiness(AT, {
      MONACADO_TAX_ENABLED: "true",
      MONACADO_TAX_PROVIDER: "STRIPE_TAX",
      MONACADO_STRIPE_SECRET_KEY: "sk_test_x",
      MONACADO_TAX_STRIPE_TAX_CODE_DIGITAL_GOOD: "txcd_TEST_DIGITAL",
    });
    expect(ready.filing.recordingImpliesFilingReadiness).toBe(false);
    expect(ready.blockers).toContain("FILING_OR_REMITTANCE_CONFIGURATION_REQUIRED");
    expect(ready.liveTaxCommercePermitted).toBe(false);
  });

  it("reads its command flags without touching a database", () => {
    expect(parseCommandOptions([])).toEqual({ json: false, limit: 25 });
    expect(parseCommandOptions(["--json", "--limit=5"])).toEqual({ json: true, limit: 5 });
  });
});
