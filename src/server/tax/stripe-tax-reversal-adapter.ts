/**
 * The Stripe Tax reversal adapter (Phase 1.9) — SERVER ONLY.
 *
 * `1.7`'s recording adapter said of this operation: *"Reversal is deliberately
 * absent: `createReversal` is a later phase's, and putting it behind this port
 * now would be shipping a capability whose accounting rules nobody has decided."*
 * The rules are decided, so this is that later phase — behind a **separate**
 * provider-neutral port, in TEST mode only.
 *
 * ## A separate port, not a second method on the recording one
 *
 * Reporting a sale and un-reporting one are different privileges, and one
 * interface holding both is a privilege nobody scoped — the reason `0M.9` kept
 * `BuyerPaymentPort` apart from `PaymentProviderPort`, and `1.2` kept
 * `RefundExecutionPort` apart from both. A `TaxTransactionRecordingPort` that
 * could also reverse would be injectable into the `1.7` recorder, which has no
 * business reversing anything.
 *
 * ## The target is the recorded transaction, never a calculation
 *
 * `original_transaction` comes from the reversal row's copy of `1.7`'s
 * `providerTaxTransactionRef`. Nothing here calculates, and nothing here reads
 * the original row: a fresh calculation would price a historical sale at today's
 * rates, and re-reading the original would let the reversal target silently move
 * if that row ever changed.
 *
 * ## Two independent idempotency guards
 *
 * | Guard | Whose | What it stops |
 * | --- | --- | --- |
 * | `idempotencyKey` | Monacado's, derived from the reversal and its target | a retry after a timeout creating a second reversal |
 * | `reference` | Stripe's uniqueness rule over its own transactions | any path at all creating a second reversal for one sale |
 *
 * The second is the one that cannot be lost. Stripe requires `reference` unique
 * across all transactions **including reversals**, so even a Monacado-side key
 * that expired cannot produce two reversals for one Order — which is why the
 * reference is `<orderId>-reversal`, derived rather than random, and why reusing
 * the original transaction's bare Order id would have been refused outright.
 *
 * ## `mode: "full"` and nothing else
 *
 * `1.9` reverses whole sales. The partial branch of Stripe's API needs
 * `line_items` and `flat_amount` — the allocation decisions `PARTIAL_REFUND_-
 * DEFERRAL` names — and is not reachable from here.
 *
 * ## No raw payload, ever
 *
 * Stripe's error text can echo the request, and the request names a transaction
 * created from a buyer's ship-to destination. Errors are classified into
 * `TAX_REVERSAL_FAILURE_CODES` at this boundary and the vendor's message is
 * discarded.
 */

import "../server-only";
import type Stripe from "stripe";
import type { TaxReversalFailureCode } from "../../contracts/marketplace/tax-reversal";
import { getStripeClient } from "../payments/stripe-client";
import {
  readStripeRuntimeConfig,
  resolveTestModeSecretKey,
} from "../payments/stripe-runtime-config";
import {
  readStripeTaxRuntimeConfig,
  type Env,
  type StripeTaxRuntimeConfig,
} from "./tax-runtime-config";

/**
 * The single Stripe Tax reversal operation Monacado performs.
 *
 * One method wide, so a test injects a double and **no network call occurs
 * anywhere in the test suite**.
 */
export interface StripeTaxReversalClient {
  createReversal(
    params: Stripe.Tax.TransactionCreateReversalParams,
    options?: { idempotencyKey?: string },
  ): Promise<Stripe.Tax.Transaction>;
}

/** What a reversal attempt asks for, in Monacado's terms. */
export interface TaxReversalRequest {
  /** The provider's ORIGINAL Tax Transaction. Exact, from the reversal row. */
  originalProviderTaxTransactionRef: string;
  /** Monacado's unique reference for the reversal. `<orderId>-reversal`. */
  providerReference: string;
  /** Stable, Monacado-derived. See `refund-idempotency.ts`. */
  idempotencyKey: string;
}

/** What a reversal attempt produced, in Monacado's terms. */
export type TaxReversalResult =
  | {
      outcome: "REVERSED";
      providerReversalRef: string;
      providerReversalCreatedAt: string;
      providerMode: "TEST" | "LIVE";
    }
  | { outcome: "FAILED"; failureCode: TaxReversalFailureCode };

/**
 * The boundary across which Monacado un-reports a sale's tax to a provider.
 *
 * **Never throws for a provider condition.** Every failure is a normalised code
 * in the return value, because the caller has already returned a buyer's money
 * and must always be able to record *something* about the attempt.
 */
export interface TaxReversalPort {
  reverse(request: TaxReversalRequest): Promise<TaxReversalResult>;
}

/** The live client, built from the same test-mode-only credential path. */
export function createStripeTaxReversalClient(
  config: StripeTaxRuntimeConfig,
  env: Env = process.env,
): StripeTaxReversalClient {
  resolveTestModeSecretKey(config.apiKeyEnvVar, env as Record<string, string | undefined>);
  const stripeConfig = readStripeRuntimeConfig(env as Record<string, string | undefined>);
  const client = getStripeClient(
    { ...stripeConfig, apiKeyEnvVar: config.apiKeyEnvVar },
    env as Record<string, string | undefined>,
  );
  return {
    createReversal: (params, options) =>
      client.tax.transactions.createReversal(params, options ?? {}),
  };
}

/**
 * Classify a Stripe failure without keeping a word of it.
 *
 * Reads only the SDK's structured fields — never `message`. An unrecognised shape
 * is `UNSPECIFIED_FAILURE` and therefore transient.
 */
export function classifyStripeTaxReversalError(error: unknown): TaxReversalFailureCode {
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
    /* The provider already holds a transaction under this reference. Permanent:
       retrying asks it to do something it has already done, and the real
       question is which reversal that is — which is reconciliation's. */
    return "DUPLICATE_REFERENCE";
  }
  if (code === "tax_transaction_already_reversed") return "ALREADY_REVERSED";
  if (code === "resource_missing") return "ORIGINAL_TRANSACTION_NOT_FOUND";
  if (type === "StripeInvalidRequestError" || (status >= 400 && status < 500)) {
    return "PROVIDER_REJECTED";
  }
  return "UNSPECIFIED_FAILURE";
}

export interface StripeTaxReversalAdapterDeps {
  config?: StripeTaxRuntimeConfig;
  client?: StripeTaxReversalClient;
  env?: Env;
}

/**
 * The production-capable Stripe Tax reversal executor, TEST mode only.
 *
 * Configuration is read lazily and a configuration failure becomes a normalised
 * `PROVIDER_NOT_CONFIGURED` result rather than an exception, so a deployment that
 * has not configured tax leaves recoverable rows rather than an unhandled throw
 * inside a worker loop.
 */
export function createStripeTaxReversalAdapter(
  deps: StripeTaxReversalAdapterDeps = {},
): TaxReversalPort {
  const env = deps.env ?? process.env;
  let client: StripeTaxReversalClient | undefined = deps.client;

  return {
    async reverse(request) {
      if (client === undefined) {
        try {
          const config = deps.config ?? readStripeTaxRuntimeConfig(env);
          if (config.mode !== "TEST") {
            return { outcome: "FAILED", failureCode: "PROVIDER_MODE_NOT_PERMITTED" };
          }
          client = createStripeTaxReversalClient(config, env);
        } catch {
          return { outcome: "FAILED", failureCode: "PROVIDER_NOT_CONFIGURED" };
        }
      }

      let reversal: Stripe.Tax.Transaction;
      try {
        reversal = await client.createReversal(
          {
            /* FULL, and nothing else. The partial branch needs the allocation
               decisions PARTIAL_REFUND_DEFERRAL names, and is unreachable. */
            mode: "full",
            /* The EXACT original transaction, from the reversal row's own copy of
               it — never re-read from the `1.7` record, and never derived from a
               fresh calculation. */
            original_transaction: request.originalProviderTaxTransactionRef,
            /* Unique across ALL Stripe transactions including reversals — the
               guard that makes two reversals for one sale impossible even if
               Monacado's own key were lost. */
            reference: request.providerReference,
          },
          { idempotencyKey: request.idempotencyKey },
        );
      } catch (error) {
        return { outcome: "FAILED", failureCode: classifyStripeTaxReversalError(error) };
      }

      if (reversal.livemode) {
        /* The PROVIDER's statement about its own object. */
        return { outcome: "FAILED", failureCode: "PROVIDER_MODE_NOT_PERMITTED" };
      }

      if (reversal.type !== "reversal") {
        /* Stripe returned a transaction that is not a reversal. Recording it as
           one would leave Monacado's books saying a sale's tax came back on the
           strength of an object that says otherwise. Permanent: the same request
           will produce the same answer, and the question is what that object is. */
        return { outcome: "FAILED", failureCode: "EVIDENCE_INCONSISTENT" };
      }

      return {
        outcome: "REVERSED",
        providerReversalRef: reversal.id,
        providerReversalCreatedAt: new Date(reversal.created * 1_000).toISOString(),
        providerMode: "TEST",
      };
    },
  };
}
