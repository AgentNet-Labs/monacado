/**
 * The Stripe refund adapter (Phase 1.9) — SERVER ONLY.
 *
 * The first concrete implementation of `1.2`'s `RefundExecutionPort`, which that
 * phase deliberately left empty: *"a real Stripe refund is deliberately not
 * implemented, because executing one is a live-money operation and this phase is
 * about the controls that must exist before any live money moves at all."* The
 * controls now exist, so this is the execution — **in TEST mode only**.
 *
 * Nothing above `RefundExecutionPort` knows Stripe exists.
 *
 * ## One operation
 *
 * `refunds.create` against the original PaymentIntent, for the full amount. There
 * is no cancel, no update, no list, and no partial path: an interface one method
 * wide cannot be used to do something nobody scoped, and a `refunds.cancel` sat
 * behind this port would be a capability whose accounting rules nobody decided.
 *
 * ## Idempotency is the whole safety property
 *
 * Stripe's Refunds API has **no `reference` uniqueness rule** — unlike the Tax
 * API, which `1.7` could lean on as a second guard. A charge can legitimately be
 * refunded several times, so nothing at the provider will stop a retry from
 * returning the buyer's money twice.
 *
 * The only thing that stops it is the idempotency key, derived in
 * `refund-idempotency.ts` from the refund id and the original charge and
 * therefore **identical on every attempt**. That is why the key is derived from
 * immutable identity rather than passed in by a caller, and why it contains no
 * clock, counter, or randomness.
 *
 * ## TEST mode only, and refused twice — not three times
 *
 * | Check | What it stops |
 * | --- | --- |
 * | `config.mode !== "TEST"` | a deployment configured for live mode |
 * | `resolveTestModeSecretKey` | a live credential in a "test" deployment |
 *
 * Both go through the *same* single credential reader the rest of the Stripe
 * surface uses — a refund path with its own credential logic would be a second
 * place the live-prefix check could be forgotten, and forgetting it here refunds
 * real cards.
 *
 * **There is deliberately no third check here, and the reason is a limitation
 * worth stating rather than papering over.** `1.7`'s tax adapter adds a
 * `transaction.livemode` check — the provider's own statement about its own
 * object, which catches a deployment holding a live key it believes is a test
 * one. `Stripe.Refund` **has no `livemode` field** on the pinned API version, so
 * that check is not available for refunds.
 *
 * The credential gate is what carries the guarantee instead, and it carries it
 * completely: an `sk_test_` key cannot reach live data at Stripe at all, so a
 * refund executed with one is a test-mode refund by construction. What is lost is
 * only the belt-and-braces confirmation, and the mitigation is that the *same*
 * refusal happens one layer earlier rather than not at all.
 *
 * What is checked instead is **identity of the target**: the returned refund must
 * name the payment intent Monacado asked about. A refund of a charge nobody named
 * is a worse outcome than a mode confusion, and it is the one this API can
 * actually detect.
 *
 * ## Fails closed, and never mid-payment
 *
 * The payment succeeded long before this runs and Monacado already holds a
 * durable obligation to refund. A failure here therefore **never** unwinds
 * anything: it returns a normalised code, the row becomes retryable, and the
 * obligation stands.
 *
 * ## No raw payload, ever
 *
 * Stripe's error text can echo the request, and the request named a charge that
 * names a buyer. Errors are classified into the port's closed vocabulary at this
 * boundary and the vendor's message is discarded.
 */

import "../server-only";
import type Stripe from "stripe";
import {
  RefundExecutionRequest,
  type RefundExecutionPort,
  type RefundExecutionResult,
  type RefundExecutionFailureCode,
} from "../../contracts/marketplace/transaction-reversal";
import type { RefundFailureCode } from "../../contracts/marketplace/order-refund";
import { getStripeClient } from "./stripe-client";
import {
  readStripeRuntimeConfig,
  resolveTestModeSecretKey,
  type Env,
  type StripeRuntimeConfig,
} from "./stripe-runtime-config";

/**
 * The single Stripe refund operation Monacado performs.
 *
 * One method wide, so a test injects a double and **no network call occurs
 * anywhere in the test suite**.
 */
export interface StripeRefundClient {
  createRefund(
    params: Stripe.RefundCreateParams,
    options?: { idempotencyKey?: string },
  ): Promise<Stripe.Refund>;
}

/** The live client, built from the same test-mode-only credential path. */
export function createStripeRefundClient(
  config: StripeRuntimeConfig,
  env: Env = process.env,
): StripeRefundClient {
  /* Resolved here as well as inside `getStripeClient` so a live credential is
     refused before an SDK object exists, not merely before a call is made. */
  resolveTestModeSecretKey(config.apiKeyEnvVar, env);
  const client = getStripeClient(config, env);
  return {
    createRefund: (params, options) => client.refunds.create(params, options ?? {}),
  };
}

/**
 * The Stripe refund reason for a Monacado one, where Stripe has an equivalent.
 *
 * Deliberately **narrow and lossy**. Stripe accepts exactly three values, and
 * `fraudulent` has a side effect its documentation states plainly: it adds the
 * associated card and email to Radar block lists. That is a consequential act
 * about a person, so it is sent only for `FRAUD_OR_RISK`, where somebody
 * deliberately chose that classification.
 *
 * Everything Stripe has no equivalent for sends **no reason at all** rather than
 * the nearest-looking one. A refund miscategorised as `fraudulent` at the
 * provider is a block-list entry nobody decided on.
 */
export function stripeRefundReasonFor(
  reason: RefundFailureCodeSource,
): Stripe.RefundCreateParams.Reason | undefined {
  switch (reason) {
    case "CUSTOMER_REQUEST":
      return "requested_by_customer";
    case "DUPLICATE_PAYMENT":
      return "duplicate";
    case "FRAUD_OR_RISK":
      return "fraudulent";
    default:
      /* PRODUCT_FAILURE, OPERATOR_CORRECTION, OTHER_GOVERNED_REASON. Stripe has
         no member for any of them, and guessing would attach a meaning nobody
         chose to a record Monacado cannot edit. */
      return undefined;
  }
}

/** The Monacado reason vocabulary, as this module needs to read it. */
type RefundFailureCodeSource =
  | "CUSTOMER_REQUEST"
  | "PRODUCT_FAILURE"
  | "DUPLICATE_PAYMENT"
  | "FRAUD_OR_RISK"
  | "OPERATOR_CORRECTION"
  | "OTHER_GOVERNED_REASON";

/**
 * Classify a Stripe failure without keeping a word of it.
 *
 * Reads only the SDK's structured fields — never `message`, which can echo the
 * request. An unrecognised shape is `UNSPECIFIED_FAILURE` and therefore
 * transient, which is the conservative reading: a condition nobody has classified
 * should be retried rather than abandoned, and the bounded attempt count is what
 * stops that being unbounded.
 */
export function classifyStripeRefundError(error: unknown): RefundExecutionFailureCode {
  const candidate = error as { type?: unknown; code?: unknown; statusCode?: unknown } | null;
  const type = typeof candidate?.type === "string" ? candidate.type : "";
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const status = typeof candidate?.statusCode === "number" ? candidate.statusCode : 0;

  if (type === "StripeConnectionError" || type === "StripeAPIError") return "PROVIDER_UNAVAILABLE";
  if (status === 429 || status >= 500) return "PROVIDER_UNAVAILABLE";
  if (type === "StripeAuthenticationError" || type === "StripePermissionError") {
    return "PROVIDER_REJECTED";
  }
  if (code === "charge_already_refunded") return "ALREADY_REVERSED";
  if (code === "resource_missing" || code === "charge_not_found") return "CHARGE_NOT_FOUND";
  if (code === "amount_too_large") return "AMOUNT_EXCEEDS_CHARGE";
  if (type === "StripeInvalidRequestError" || (status >= 400 && status < 500)) {
    return "PROVIDER_REJECTED";
  }
  return "UNSPECIFIED_FAILURE";
}

/**
 * Translate the port's refusal into the durable record's vocabulary.
 *
 * Two vocabularies exist because they answer different questions: the port's is
 * `1.2`'s, describing what a *provider* said, and `RefundFailureCode` is `1.9`'s,
 * describing what a *row* should now do. Keeping them separate is what let the
 * port be extended additively rather than rewritten.
 */
export function refundFailureCodeFor(code: RefundExecutionFailureCode): RefundFailureCode {
  switch (code) {
    case "ALREADY_REVERSED":
      return "ALREADY_REFUNDED";
    case "CHARGE_NOT_FOUND":
      return "CHARGE_NOT_FOUND";
    case "AMOUNT_EXCEEDS_CHARGE":
      return "AMOUNT_EXCEEDS_CHARGE";
    case "PROVIDER_UNAVAILABLE":
      return "PROVIDER_UNAVAILABLE";
    case "PROVIDER_REJECTED":
      return "PROVIDER_REJECTED";
    case "PROVIDER_NOT_CONFIGURED":
      return "PROVIDER_NOT_CONFIGURED";
    case "PROVIDER_MODE_NOT_PERMITTED":
      return "PROVIDER_MODE_NOT_PERMITTED";
    case "UNSPECIFIED_FAILURE":
      return "UNSPECIFIED_FAILURE";
  }
}

/**
 * Stripe refund statuses that mean the money is on its way back.
 *
 * `pending` counts, and that is deliberate rather than lax: for many payment
 * methods a refund is asynchronous and never reports `succeeded` synchronously.
 * Refusing to record a `pending` refund would leave Monacado retrying a refund
 * Stripe has already accepted — which the idempotency key would deduplicate, but
 * which would leave the row looking failed while the buyer's money moved.
 *
 * `requires_action` is **not** here: it needs the buyer to do something, which is
 * not a flow this phase implements. `failed` and `canceled` are not either.
 */
export const ACCEPTED_STRIPE_REFUND_STATUSES: readonly string[] = ["succeeded", "pending"];

export interface StripeRefundAdapterDeps {
  config?: StripeRuntimeConfig;
  client?: StripeRefundClient;
  env?: Env;
}

/**
 * The production-capable Stripe refund executor, TEST mode only.
 *
 * Configuration is read lazily and a configuration failure becomes a normalised
 * `PROVIDER_NOT_CONFIGURED` result rather than an exception, so a deployment that
 * has not configured Stripe leaves recoverable rows rather than an unhandled
 * throw inside a worker loop.
 */
export function createStripeRefundAdapter(
  deps: StripeRefundAdapterDeps = {},
): RefundExecutionPort {
  const env = deps.env ?? process.env;
  let client: StripeRefundClient | undefined = deps.client;

  return {
    async executeRefund(rawRequest): Promise<RefundExecutionResult> {
      const request = RefundExecutionRequest.parse(rawRequest);

      if (client === undefined) {
        try {
          const config = deps.config ?? readStripeRuntimeConfig(env);
          if (config.mode !== "TEST") {
            return { outcome: "REFUSED", failureCode: "PROVIDER_MODE_NOT_PERMITTED" };
          }
          client = createStripeRefundClient(config, env);
        } catch {
          /* The configuration error's own message is discarded: it names
             environment variables, and a worker log is not the place to
             enumerate a deployment's credential layout. The code says what to
             fix. */
          return { outcome: "REFUSED", failureCode: "PROVIDER_NOT_CONFIGURED" };
        }
      }

      let refund: Stripe.Refund;
      try {
        refund = await client.createRefund(
          {
            /* The EXACT original payment intent, from the settlement row's own
               provider evidence. Never a charge Monacado looked up, and never
               derived from anything current. */
            payment_intent: request.providerTransactionRef,
            /* The full buyer charge. Sent explicitly rather than omitted — an
               omitted amount means "whatever is left", which for a charge that
               had been partially refunded by some other route would silently
               return a different figure than the one Monacado recorded. */
            amount: request.amountMinorUnits,
          },
          { idempotencyKey: request.idempotencyKey },
        );
      } catch (error) {
        return { outcome: "REFUSED", failureCode: classifyStripeRefundError(error) };
      }

      /* The refund must name the charge Monacado asked about.
       *
       * `Stripe.Refund` carries no `livemode`, so this stands where `1.7`'s
       * `transaction.livemode` check stands in the tax adapter — see the module
       * header. It catches the failure this API can actually surface: a refund
       * created against a payment intent other than the one named, which would be
       * money returned on a sale nobody authorised returning.
       *
       * `payment_intent` is expandable, so it is either the id or an object
       * carrying it. Neither is trusted to be present; an absent one is refused. */
      const refundedIntent =
        typeof refund.payment_intent === "string"
          ? refund.payment_intent
          : (refund.payment_intent?.id ?? null);
      if (refundedIntent !== request.providerTransactionRef) {
        return { outcome: "REFUSED", failureCode: "PROVIDER_REJECTED" };
      }

      const status = refund.status ?? "";
      if (!ACCEPTED_STRIPE_REFUND_STATUSES.includes(status)) {
        /* A refund Stripe created but has not accepted. Transient, because the
           commonest cause is a method that needs another attempt, and the stable
           idempotency key means a retry reuses this same refund rather than
           creating a second. */
        return { outcome: "REFUSED", failureCode: "UNSPECIFIED_FAILURE" };
      }

      return {
        outcome: "EXECUTED",
        provider: "STRIPE",
        providerReversalRef: refund.id,
        providerCreatedAt: new Date(refund.created * 1_000).toISOString(),
        providerMode: "TEST",
      };
    },
  };
}
