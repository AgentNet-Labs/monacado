/**
 * The Stripe Tax Transaction adapter (Phase 1.7) — SERVER ONLY.
 *
 * The post-payment half of the Stripe Tax integration, behind a
 * **provider-neutral port** exactly as the calculation half is. Nothing above
 * `TaxTransactionRecordingPort` knows Stripe exists.
 *
 * ## One operation
 *
 * `tax.transactions.createFromCalculation` — turn an existing calculation into a
 * reported transaction. **Reversal is deliberately absent**: `createReversal` is
 * a later phase's, and putting it behind this port now would be shipping a
 * capability whose accounting rules nobody has decided.
 *
 * ## Two independent idempotency guards
 *
 * | Guard | Whose | What it stops |
 * | --- | --- | --- |
 * | `idempotencyKey` | Monacado's, derived from the Order and calculation | a retry after a timeout creating a second transaction |
 * | `reference` | Stripe's uniqueness rule over its own transactions | any path at all creating a second transaction for one Order |
 *
 * The second is the one that matters. Stripe requires `reference` to be unique
 * across all transactions **including reversals**, so even a Monacado-side key
 * that was lost, changed, or expired cannot produce two Tax Transactions for one
 * Order. A duplicate is reported as `DUPLICATE_REFERENCE` and classified
 * permanent — retrying it would never succeed and would only burn attempts.
 *
 * ## Fails closed, and never mid-payment
 *
 * The payment has already succeeded by the time this runs. A failure here
 * therefore **never** unwinds anything: it returns a normalised code, the row
 * becomes retryable, and the sale stands. That asymmetry is the point — an
 * unreported tax transaction is recoverable work, and a rolled-back payment is a
 * buyer charged for nothing.
 *
 * ## No raw payload, ever
 *
 * Stripe's error text can echo the request, and the request named a ship-to
 * destination. Errors are classified into `TAX_RECORDING_FAILURE_CODES` at this
 * boundary and the vendor's message is discarded.
 */

import "../server-only";
import type Stripe from "stripe";
import type { TaxRecordingFailureCode } from "../../contracts/marketplace/tax-transaction";
import { getStripeClient } from "../payments/stripe-client";
import {
  readStripeRuntimeConfig,
  resolveTestModeSecretKey,
} from "../payments/stripe-runtime-config";
import { readStripeTaxRuntimeConfig, type Env, type StripeTaxRuntimeConfig } from "./tax-runtime-config";

/**
 * The single Stripe Tax Transaction operation Monacado performs.
 *
 * One method wide, so a test injects a double and **no network call occurs
 * anywhere in the test suite**.
 */
export interface StripeTaxTransactionClient {
  createFromCalculation(
    params: Stripe.Tax.TransactionCreateFromCalculationParams,
    options?: { idempotencyKey?: string },
  ): Promise<Stripe.Tax.Transaction>;
}

/** What a recording attempt asks for, in Monacado's terms. */
export interface TaxTransactionRecordingRequest {
  /** The engine's calculation to report. Exact, from the Order's evidence. */
  providerCalculationRef: string;
  /** Monacado's unique reference for the sale. The Order id. */
  providerReference: string;
  /** Stable, Monacado-derived. See `tax-transaction-idempotency.ts`. */
  idempotencyKey: string;
}

/** What a recording attempt produced, in Monacado's terms. */
export type TaxTransactionRecordingResult =
  | {
      outcome: "RECORDED";
      providerTaxTransactionRef: string;
      providerTaxTransactionCreatedAt: string;
      providerTotalAmountMinorUnits: number;
      providerMode: "TEST" | "LIVE";
    }
  | { outcome: "FAILED"; failureCode: TaxRecordingFailureCode };

/**
 * The boundary across which Monacado reports a sale's tax to a provider.
 *
 * **Never throws for a provider condition.** Every failure is a normalised code
 * in the return value, because the caller has already taken a payment and must
 * always be able to record *something* about the attempt.
 */
export interface TaxTransactionRecordingPort {
  record(request: TaxTransactionRecordingRequest): Promise<TaxTransactionRecordingResult>;
}

/** The live client, built from the same test-mode-only credential path. */
export function createStripeTaxTransactionClient(
  config: StripeTaxRuntimeConfig,
  env: Env = process.env,
): StripeTaxTransactionClient {
  resolveTestModeSecretKey(config.apiKeyEnvVar, env as Record<string, string | undefined>);
  const stripeConfig = readStripeRuntimeConfig(env as Record<string, string | undefined>);
  const client = getStripeClient(
    { ...stripeConfig, apiKeyEnvVar: config.apiKeyEnvVar },
    env as Record<string, string | undefined>,
  );
  return {
    createFromCalculation: (params, options) =>
      client.tax.transactions.createFromCalculation(params, options ?? {}),
  };
}

/**
 * Classify a Stripe failure without keeping a word of it.
 *
 * Reads only the SDK's structured fields — never `message`, which can echo the
 * request. An unrecognised shape is `UNSPECIFIED_FAILURE` and therefore
 * transient, which is the conservative reading: a condition nobody has classified
 * should be retried rather than abandoned.
 */
export function classifyStripeTaxTransactionError(error: unknown): TaxRecordingFailureCode {
  const candidate = error as { type?: unknown; code?: unknown; statusCode?: unknown } | null;
  const type = typeof candidate?.type === "string" ? candidate.type : "";
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const status = typeof candidate?.statusCode === "number" ? candidate.statusCode : 0;

  if (type === "StripeConnectionError" || type === "StripeAPIError") return "PROVIDER_UNAVAILABLE";
  if (status === 429 || status >= 500) return "PROVIDER_UNAVAILABLE";
  if (type === "StripeAuthenticationError" || type === "StripePermissionError") {
    return "PROVIDER_REJECTED";
  }
  if (code === "resource_already_exists" || code === "tax_transaction_already_exists") {
    return "DUPLICATE_REFERENCE";
  }
  if (code === "tax_calculation_expired" || code === "calculation_expired") {
    return "CALCULATION_EXPIRED";
  }
  if (type === "StripeInvalidRequestError" || (status >= 400 && status < 500)) {
    return "PROVIDER_REJECTED";
  }
  return "UNSPECIFIED_FAILURE";
}

/**
 * The provider's represented total for a transaction, in minor units.
 *
 * **Summed from the transaction's own line items and shipping cost**, because a
 * `Tax.Transaction` carries no total field on the pinned API version — it has
 * `line_items` and `shipping_cost`, and nothing else that adds up. That is why
 * the create call asks for `expand: ["line_items"]`: without the expansion the
 * list is absent, and an absent list is reported as **unknown** rather than
 * silently summed to zero.
 *
 * Every amount is `exclusive` by construction — `1.6`'s calculation sends the
 * lines that way — so `amount` is the basis and `amount_tax` the tax on it, and
 * the total is their sum across every line plus shipping.
 *
 * `null` means "the provider did not tell us", never "zero".
 */
export function providerTotalFrom(transaction: Stripe.Tax.Transaction): number | null {
  const lines = transaction.line_items?.data;
  if (lines === undefined || lines === null) return null;

  let total = 0;
  for (const line of lines) {
    if (!Number.isInteger(line.amount) || !Number.isInteger(line.amount_tax)) return null;
    total += line.amount + line.amount_tax;
  }

  const shipping = transaction.shipping_cost;
  if (shipping !== null) {
    if (!Number.isInteger(shipping.amount) || !Number.isInteger(shipping.amount_tax)) return null;
    total += shipping.amount + shipping.amount_tax;
  }
  return total;
}

export interface StripeTaxTransactionAdapterDeps {
  config?: StripeTaxRuntimeConfig;
  client?: StripeTaxTransactionClient;
  env?: Env;
}

/**
 * The production-capable Stripe Tax Transaction recorder.
 *
 * Configuration is read lazily and a configuration failure becomes a normalised
 * `PROVIDER_NOT_CONFIGURED` result rather than an exception, so a deployment that
 * has not configured tax leaves recoverable rows rather than an unhandled throw
 * inside a worker loop.
 */
export function createStripeTaxTransactionRecorder(
  deps: StripeTaxTransactionAdapterDeps = {},
): TaxTransactionRecordingPort {
  const env = deps.env ?? process.env;
  let client: StripeTaxTransactionClient | undefined = deps.client;

  return {
    async record(request) {
      if (client === undefined) {
        try {
          const config = deps.config ?? readStripeTaxRuntimeConfig(env);
          if (config.mode !== "TEST") {
            return { outcome: "FAILED", failureCode: "PROVIDER_MODE_NOT_PERMITTED" };
          }
          client = createStripeTaxTransactionClient(config, env);
        } catch {
          /* The configuration error's own message is discarded: it names
             environment variables, and a worker log is not the place to enumerate
             a deployment's credential layout. The code says what to fix. */
          return { outcome: "FAILED", failureCode: "PROVIDER_NOT_CONFIGURED" };
        }
      }

      let transaction: Stripe.Tax.Transaction;
      try {
        transaction = await client.createFromCalculation(
          {
            calculation: request.providerCalculationRef,
            /* Unique across ALL Stripe transactions including reversals — the
               guard that makes two Tax Transactions for one Order impossible
               even if Monacado's own key were lost. */
            reference: request.providerReference,
            /* REQUIRED, not decorative. A Tax.Transaction has no total field on
               the pinned API version, so the only way to learn what the provider
               says this sale came to is to expand its lines and add them up —
               and that figure is what the coherence check reconciles against
               Monacado's own basis plus tax. */
            expand: ["line_items"],
          },
          { idempotencyKey: request.idempotencyKey },
        );
      } catch (error) {
        return { outcome: "FAILED", failureCode: classifyStripeTaxTransactionError(error) };
      }

      if (transaction.livemode) {
        /* The PROVIDER's statement about its own object, which is what catches a
           deployment holding a live credential it believes is a test one. */
        return { outcome: "FAILED", failureCode: "PROVIDER_MODE_NOT_PERMITTED" };
      }

      const total = providerTotalFrom(transaction);
      if (total === null) {
        /* A transaction Monacado cannot reconcile against its own basis is one it
           will not mark reported: treating an unreadable total as success would
           bury a disagreement between two systems about one sale.
         *
           Transient rather than permanent, deliberately: the commonest cause is a
           response that arrived without its expansion, and the transaction itself
           may well be fine — a retry hits the same `reference` and Stripe's own
           uniqueness rule returns rather than duplicates. */
        return { outcome: "FAILED", failureCode: "UNSPECIFIED_FAILURE" };
      }

      return {
        outcome: "RECORDED",
        providerTaxTransactionRef: transaction.id,
        providerTaxTransactionCreatedAt: new Date(transaction.created * 1_000).toISOString(),
        providerTotalAmountMinorUnits: total,
        providerMode: "TEST",
      };
    },
  };
}
