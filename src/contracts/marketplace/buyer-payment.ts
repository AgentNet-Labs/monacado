/**
 * Buyer payment execution boundary (Phase 0M.9).
 *
 * The **port** through which Monacado charges a buyer, and nothing behind it.
 * There is no adapter, no SDK, no HTTP client, no credential, no endpoint, and no
 * network call anywhere in this phase — `0M.8` deferred the concrete provider
 * adapter and this phase does not undefer it.
 *
 * Five properties shape everything below:
 *
 *   1. **Provider-neutral by construction.** Nothing here is Stripe-shaped: no
 *      payment intent, no client secret, no confirmation method, no setup intent,
 *      no webhook. The request says what to charge and the result says whether it
 *      worked — a provider's model is mapped onto Monacado's vocabulary by an
 *      adapter that does not exist yet, which is exactly what keeps a provider
 *      change from becoming a migration.
 *
 *   2. **Distinct from `PaymentProviderPort`.** That port (`0M.8`) asks a provider
 *      where a *participant's account* stands. This one charges a *buyer*. They
 *      are different questions to possibly different systems, and one interface
 *      answering both would be a privilege nobody scoped.
 *
 *   3. **The result is a discriminated union.** A success carries a provider
 *      transaction reference and no failure code; a failure carries a bounded
 *      failure code and no reference. Neither can be read as the other, and there
 *      is no "succeeded but…" shape.
 *
 *   4. **An idempotency key is required, not optional.** The port is called
 *      outside any database transaction (a network call cannot be inside one), so
 *      a retry is always possible and must never charge twice. Making the key
 *      mandatory means a caller cannot omit the one field that prevents it.
 *
 *   5. **No credential passes through.** The request carries no key, token,
 *      secret, or account reference. How an adapter authenticates is the
 *      adapter's problem, and a credential in a request object is a credential in
 *      a log.
 *
 * Pure types and pure decisions. No I/O of any kind is performed *by this module*;
 * the port it declares is the one place I/O is permitted to happen at all.
 */

import { z } from "zod";
import { OrderId, PaymentFailureCode } from "./order";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";
import { PaymentProvider } from "./payment-account";
import { ProviderTransactionRef } from "./transaction-accounting";

// — Request —

/**
 * What an adapter is asked to charge.
 *
 * The amount is the **buyer's total** — merchandise plus tax, shipping, and
 * pass-through — because that is what leaves the buyer's account. The commercial
 * split is Monacado's internal accounting and is no business of the payment
 * provider's, which is why no other figure appears here.
 */
export const BuyerPaymentRequest = z.strictObject({
  /** What this payment is for. The adapter treats it as opaque. */
  orderId: OrderId,
  provider: PaymentProvider,
  currency: CurrencyCode,
  /** The buyer's total, in minor units. */
  amountMinorUnits: z.int().min(1).max(MAX_MINOR_UNIT_AMOUNT),
  /**
   * Stable across every retry of this one charge.
   *
   * Derived from the Order rather than generated per call — a key that changed
   * between attempts would defeat its own purpose, which is the failure mode
   * worth designing out rather than documenting.
   */
  idempotencyKey: z.string().min(1).max(191),
});
export type BuyerPaymentRequest = z.infer<typeof BuyerPaymentRequest>;

// — Result —

export const BUYER_PAYMENT_OUTCOMES = ["SUCCEEDED", "FAILED"] as const;
export const BuyerPaymentOutcome = z.enum(BUYER_PAYMENT_OUTCOMES);
export type BuyerPaymentOutcome = z.infer<typeof BuyerPaymentOutcome>;

/**
 * The provider captured the buyer's funds.
 *
 * Carries the opaque external reference and nothing else. There is no field for
 * a receipt URL, a card brand, a last-four, a risk score, or a customer object —
 * a success is a fact plus the string that lets someone reconcile it later.
 */
export const BuyerPaymentSucceeded = z.strictObject({
  outcome: z.literal("SUCCEEDED"),
  provider: PaymentProvider,
  providerTransactionRef: ProviderTransactionRef,
});

/**
 * The provider did not capture the buyer's funds.
 *
 * Carries a **bounded classification** and no provider text. There is deliberately
 * no provider reference on a failure: this phase records the minimum durable state
 * a failure requires, and a reference to a charge that never happened has no
 * reader until reconciliation exists.
 */
export const BuyerPaymentFailed = z.strictObject({
  outcome: z.literal("FAILED"),
  failureCode: PaymentFailureCode,
});

export const BuyerPaymentResult = z.discriminatedUnion("outcome", [
  BuyerPaymentSucceeded,
  BuyerPaymentFailed,
]);
export type BuyerPaymentResult = z.infer<typeof BuyerPaymentResult>;

export function paymentSucceeded(result: BuyerPaymentResult): boolean {
  return result.outcome === "SUCCEEDED";
}

// — The port —

/**
 * The single boundary across which Monacado charges a buyer.
 *
 * **An interface with no implementation in this phase.** A test supplies a
 * scripted double; production supplies a real adapter when live payment
 * integration lands. Declaring it here rather than in the service is what lets
 * the whole sale path be exercised end to end without a network, a credential, or
 * a provider account.
 *
 * An implementation must be **idempotent on `idempotencyKey`**: called twice with
 * the same key it charges once and returns the same result. Monacado's own write
 * path is idempotent too, but a port that charged twice would have already taken
 * the buyer's money before any database rule could intervene.
 */
export interface BuyerPaymentPort {
  executePayment(request: BuyerPaymentRequest): Promise<BuyerPaymentResult>;
}

// — Never through this boundary —

/**
 * Named as never admissible on a payment request, and refused by the
 * `strictObject` above.
 *
 * The first group is **credentials**, which an adapter holds and a request never
 * carries. The second is **buyer personal data**, which Monacado does not store
 * (see `NEVER_ON_ORDER`) and therefore cannot forward. The third is **Monacado's
 * commercial split**, which the provider has no reason to learn.
 */
export const NEVER_ON_BUYER_PAYMENT_REQUEST = [
  // credentials — the adapter's problem, never a field
  "apiKey",
  "secretKey",
  "publishableKey",
  "clientSecret",
  "accessToken",
  "webhookSecret",
  // buyer personal data — not stored, so not forwardable
  "buyerEmail",
  "buyerName",
  "buyerAddress",
  "cardNumber",
  "cvc",
  "expiryMonth",
  // Monacado's commercial split — no provider needs it
  "monacadoRetainedAmountMinorUnits",
  "sellerProceedsMinorUnits",
  "promoterNetProceedsMinorUnits",
  "applicationFeeAmount",
] as const;
