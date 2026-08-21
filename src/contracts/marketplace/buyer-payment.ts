/**
 * Buyer payment execution boundary (Phase 0M.9; extended in Phase 1.0).
 *
 * The **ports** through which Monacado charges a buyer, and nothing behind them.
 * This module still has no adapter, no SDK import, no HTTP client, no credential,
 * no endpoint, and no network call: Phase 1.0 built a concrete Stripe adapter and
 * put it under `src/server/payments/`, on the far side of these interfaces, so
 * everything here remains pure and provider-neutral.
 *
 * Five properties shape everything below:
 *
 *   1. **Provider-neutral by construction.** Nothing here is Stripe-shaped: no
 *      payment intent, no client secret, no confirmation method, no setup intent,
 *      no webhook, no event type, no signature scheme. The request says what to
 *      charge and the result says whether it worked — a provider's model is
 *      mapped onto Monacado's vocabulary by an adapter, which is exactly what
 *      keeps a provider change from becoming a migration. Phase 1.0's Stripe
 *      adapter proved this held: it required no change to any shape above.
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
import { AccountEmail } from "../account/account";

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
 * The single boundary across which Monacado charges a buyer **synchronously**.
 *
 * The right shape for a provider that answers in one call, and the wrong one for
 * redirect-completed card acquiring — which is why Phase 1.0 added
 * `BuyerPaymentInitiationPort` beside it rather than widening this. A test
 * supplies a scripted double. Declaring it here rather than in the service is
 * what lets the whole sale path be exercised end to end without a network, a
 * credential, or a provider account.
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

// — Redirect-completed payments (Phase 1.0) —

/**
 * The second buyer-payment boundary, added when the first executable provider
 * integration landed.
 *
 * `BuyerPaymentPort` above is **unchanged**, and deliberately so: it is a
 * committed `0M.9` contract, it is exactly right for a provider that answers
 * synchronously, and widening its result union to carry a third "not an answer
 * yet" member would have destroyed property 3 — every reader would have had to
 * handle a non-result, and "succeeded but…" would have become expressible.
 *
 * Real card acquiring is not synchronous. The buyer leaves, authenticates, and
 * the authoritative answer arrives later, out of band. That is **two** events,
 * so it gets two shapes rather than one shape asked to mean both:
 *
 *   - an **initiation** — Monacado asked the provider to start a payment, and
 *     the buyer must now go somewhere to complete it. It asserts nothing about
 *     the outcome and carries no outcome field.
 *   - a **confirmation** — the provider's own authoritative statement of what
 *     happened, carrying a `BuyerPaymentResult` unchanged, so the entire `0M.9`
 *     finalization path receives exactly what it already receives.
 *
 * Still provider-neutral: no payment intent, no client secret, no session, no
 * event type, no signature scheme. A hosted redirect URL and an opaque handle
 * are the least provider-shaped description of "the buyer must go and pay" that
 * is still actionable.
 */

/**
 * Where a started payment stands.
 *
 * One member, and one only. `SUCCEEDED` is deliberately not here: a *result* is
 * `BuyerPaymentResult`'s to state, and an initiation that could claim success
 * would be a browser-reachable path to asserting a sale, which is the single
 * thing this design exists to prevent.
 */
export const BUYER_PAYMENT_INITIATION_STATUSES = ["REQUIRES_BUYER_ACTION"] as const;
export const BuyerPaymentInitiationStatus = z.enum(BUYER_PAYMENT_INITIATION_STATUSES);
export type BuyerPaymentInitiationStatus = z.infer<typeof BuyerPaymentInitiationStatus>;

/**
 * A URL the buyer is sent to in order to complete a payment.
 *
 * `https:` only, and only from a provider adapter. It is a **bearer capability**
 * — whoever holds it can complete that one payment — so it is returned to the
 * buyer, persisted nowhere, and named in `NEVER_ON_BUYER_PAYMENT_REQUEST`'s
 * spirit rather than stored beside the Order.
 */
export const BuyerActionUrl = z
  .string()
  .min(1)
  .max(2_048)
  .refine((v) => v.trim() === v, "buyerActionUrl must not carry surrounding whitespace")
  .refine((v) => {
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  }, "buyerActionUrl must be an absolute https: URL");
export type BuyerActionUrl = z.infer<typeof BuyerActionUrl>;

/**
 * The provider has started a payment and the buyer must now complete it.
 *
 * **Not a result.** There is no outcome, no failure code, and no settlement
 * reference — `providerPaymentRef` identifies the *attempt*, not the captured
 * transaction, and is deliberately never persisted: the reference that reaches
 * `TransactionSettlement` is the one on the confirmation, because that is the
 * one the provider stated authoritatively.
 */
export const BuyerPaymentInitiation = z.strictObject({
  orderId: OrderId,
  provider: PaymentProvider,
  status: BuyerPaymentInitiationStatus,
  /** Opaque handle for the attempt. Not the settlement reference. */
  providerPaymentRef: ProviderTransactionRef,
  buyerActionUrl: BuyerActionUrl,
});
export type BuyerPaymentInitiation = z.infer<typeof BuyerPaymentInitiation>;

/**
 * Monacado asks a provider to start a payment the buyer will complete elsewhere.
 *
 * Takes the **same** `BuyerPaymentRequest` as `executePayment`, so one request
 * shape describes one charge regardless of how the provider answers, and the
 * idempotency rule is identical: called twice with the same key it starts one
 * payment and returns the same initiation.
 */
export interface BuyerPaymentInitiationPort {
  initiatePayment(request: BuyerPaymentRequest): Promise<BuyerPaymentInitiation>;
}

// — Authoritative confirmation —

/**
 * One notification a provider sent, exactly as received.
 *
 * Structurally generic — a body and the header that authenticates it — because
 * every provider that reports out of band does so with those two things. The
 * body is kept **raw**: a signature is computed over bytes, so parsing before
 * verifying would verify something other than what arrived.
 */
export const ProviderNotification = z.strictObject({
  /** The exact bytes received, unparsed and unmodified. */
  rawBody: z.string(),
  /** The header carrying the provider's signature, or `null` when absent. */
  signatureHeader: z.string().nullable(),
});
export type ProviderNotification = z.infer<typeof ProviderNotification>;

/**
 * How a payment attempt ended, as the provider tells it (Phase 1.1).
 *
 * Two members, because a provider can authoritatively say two different things
 * about an attempt, and collapsing them would lose the distinction the Order
 * lifecycle already draws:
 *
 *   - `PAYMENT_RESULT` — the attempt produced an answer. Carries a
 *     `BuyerPaymentResult` and nothing else new.
 *   - `ABANDONED` — the attempt **ended without one** and can no longer complete.
 *     Carries no result and no failure code, because there was no failure: nobody
 *     declined anything, the buyer simply never finished.
 *
 * `ABANDONED` is deliberately **not** modelled as a `FAILED` result with a new
 * failure code. `0M.9` reserves `PAYMENT_FAILED` for "the provider reported
 * failure" and `CANCELLED` for "abandoned before payment succeeded" — two states
 * with different meanings and different terminal behaviour. Routing abandonment
 * through a failure code would put the Order in the wrong one and would invent a
 * decline nobody issued.
 */
export const BUYER_PAYMENT_DISPOSITIONS = ["PAYMENT_RESULT", "ABANDONED"] as const;
export const BuyerPaymentDisposition = z.enum(BUYER_PAYMENT_DISPOSITIONS);
export type BuyerPaymentDisposition = z.infer<typeof BuyerPaymentDisposition>;

/**
 * The buyer's contact details, as the provider collected them — **transient**.
 *
 * The one piece of buyer personal data that crosses this boundary, and it exists
 * for exactly one reason: Monacado cannot send a buyer their own receipt without
 * an address, and a guest has no account to read one from.
 *
 * Three rules make that safe, and all three are asserted by tests:
 *
 *   1. **Never persisted.** `NEVER_PERSISTED_FROM_CONFIRMATION` names it, no
 *      column exists for it on any table, and the delivery layer stores only a
 *      SHA-256 digest — the same construction `0M.9` uses for a guest claim code.
 *   2. **Never on the request.** `BuyerPaymentRequest` has no field for it and
 *      `NEVER_ON_BUYER_PAYMENT_REQUEST` already forbids one. It travels *inward*
 *      from the provider only.
 *   3. **Nullable, and absence is ordinary.** A buyer who abandoned before typing
 *      an address simply has none, and no notice is owed to nobody.
 */
export const BuyerContact = z.strictObject({
  email: AccountEmail,
});
export type BuyerContact = z.infer<typeof BuyerContact>;

const confirmationBase = {
  orderId: OrderId,
  provider: PaymentProvider,
  /** Transient. Digested at the delivery boundary and never stored raw. */
  buyerContact: BuyerContact.nullable(),
  /**
   * The provider's own identifier for this notification, kept so an operator can
   * correlate one delivery with one provider record. No decision is made from it.
   */
  providerEventRef: z.string().min(1).max(191),
  observedAt: z.iso.datetime(),
};

/**
 * The provider's authoritative statement of what happened to a payment.
 *
 * Carries a `BuyerPaymentResult` **unchanged**, so `recordPaymentResult` — the
 * whole `0M.9` finalization path, its replay rules, and its atomic write —
 * receives precisely what it already receives. No second finalization path
 * exists, and confirmation adds no economics, no amounts, and no split.
 */
export const BuyerPaymentResultReported = z.strictObject({
  disposition: z.literal("PAYMENT_RESULT"),
  ...confirmationBase,
  result: BuyerPaymentResult,
});

/**
 * The provider's authoritative statement that the attempt is over, unpaid.
 *
 * **Has no `result` field at all**, so "abandoned but succeeded" is not a shape
 * that exists. What Monacado does with it is cancel a still-pending Order —
 * `0M.9`'s `CANCELLED`, reached through `cancelOrder`, which creates no economics.
 */
export const BuyerPaymentAbandoned = z.strictObject({
  disposition: z.literal("ABANDONED"),
  ...confirmationBase,
});

export const BuyerPaymentConfirmation = z.discriminatedUnion("disposition", [
  BuyerPaymentResultReported,
  BuyerPaymentAbandoned,
]);
export type BuyerPaymentConfirmation = z.infer<typeof BuyerPaymentConfirmation>;

/**
 * Carried on a confirmation and **never written to any table**.
 *
 * A short list with one member today, kept as a list because the pressure to add
 * "just the buyer's name for the receipt" arrives the moment someone writes a
 * template. A test walks it against the Prisma schema and asserts no column of
 * that name exists anywhere.
 */
export const NEVER_PERSISTED_FROM_CONFIRMATION = ["buyerEmail", "buyerContact"] as const;

/**
 * Verify one provider notification and translate it into Monacado's vocabulary.
 *
 * **Verification is not optional and not separable.** There is no method that
 * parses without checking the signature, so a caller cannot accidentally trust an
 * unverified body — an implementation must refuse rather than return anything at
 * all when the signature does not verify.
 *
 * `null` means *this notification is not about a buyer payment* — a provider
 * sends many kinds, and a verified notification Monacado has no opinion about is
 * an ordinary outcome rather than an error.
 */
export interface BuyerPaymentConfirmationPort {
  confirmPayment(notification: ProviderNotification): Promise<BuyerPaymentConfirmation | null>;
}
