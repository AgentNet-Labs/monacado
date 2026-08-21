/**
 * Executable checkout (Phase 1.0) — SERVER ONLY.
 *
 * The two operations that turn `0M.9`'s provider-neutral flow into a purchase a
 * real buyer can complete, and **no third thing**:
 *
 *   - `beginCheckout` — place the Order, then ask the provider to start a
 *     payment. Both steps are `0M.9`'s and `1.0`'s existing functions; this
 *     composes them and adds no economics.
 *   - `finalizeConfirmedPayment` — take one authoritative provider confirmation
 *     and hand it to `recordPaymentResult` unchanged.
 *
 * What this module deliberately does **not** contain:
 *
 *   - **No pricing.** The retail price, the effective commercial policy, the
 *     retention, the seller's proceeds, the promoter's spread, and the buyer's
 *     total are all `prepareCheckout` and `0M.T1`'s, computed from bound
 *     authoritative versions. Nothing here adds, adjusts, or re-derives an
 *     amount, and there is no parameter through which a caller could supply one.
 *   - **No second finalization path.** `recordPaymentResult` performs the atomic
 *     write — snapshot, settlement, proceeds obligations, purchase evidence,
 *     notification obligations, `PAID` — and this module calls it exactly once.
 *   - **No event framework.** One confirmation in, one bounded disposition out.
 *
 * ## Ordering, and why the Order is written first
 *
 * `placeOrder` commits before any provider is contacted, exactly as `0M.9`
 * designed. If session creation then fails, or the process dies, what survives is
 * a `PENDING_PAYMENT` Order naming precisely what was being bought — recoverable
 * by a human or a later reconciliation — rather than a Stripe payment nobody can
 * attach to anything.
 */

import "../server-only";
import {
  getOrder,
  initiateOrderPayment,
  placeOrder,
  recordPaymentResult,
  type CompletedSale,
  type OrderServiceDeps,
} from "../marketplace/order-service";
import type {
  BuyerPaymentConfirmation,
  BuyerPaymentInitiation,
  BuyerPaymentInitiationPort,
} from "../../contracts/marketplace/buyer-payment";
import type { OrderRecord } from "../../contracts/marketplace/order";
import type { PaymentProvider } from "../../contracts/marketplace/payment-account";

/** An Order placed and a payment started, ready for the buyer to complete. */
export interface BegunCheckout {
  order: OrderRecord;
  /**
   * Returned **once**, for a guest Order only, and stored nowhere.
   *
   * `0M.9`'s rule, unchanged: Monacado kept only the digest and cannot re-issue
   * it. The caller must hand it to the buyer.
   */
  guestClaimCode: string | null;
  buyerTotalMinorUnits: number;
  initiation: BuyerPaymentInitiation;
}

/**
 * Place an Order and start its payment.
 *
 * `policyId` names *which* Monacado commercial policy applies; its effective
 * version is resolved by `prepareCheckout`. Per-transaction policy selection
 * remains `0M.R2`'s subject and is not introduced here.
 */
export async function beginCheckout(
  input: unknown,
  policyId: string,
  args: { provider: PaymentProvider; port: BuyerPaymentInitiationPort },
  deps: OrderServiceDeps = {},
): Promise<BegunCheckout> {
  const placed = await placeOrder(input, policyId, deps);
  const initiation = await initiateOrderPayment(placed.order, args.provider, args.port);
  return {
    order: placed.order,
    guestClaimCode: placed.guestClaimCode,
    buyerTotalMinorUnits: placed.buyerTotalMinorUnits,
    initiation,
  };
}

// — Finalization —

/**
 * What one confirmation did, as a bounded answer.
 *
 * `ALREADY_RECORDED` is the idempotency signal and is load-bearing: a provider
 * that delivers the same event twice must produce one sale, and a caller needs to
 * be able to tell "recorded" from "recorded again" without inspecting rows.
 */
export const CONFIRMATION_DISPOSITIONS = [
  "SALE_RECORDED",
  "FAILURE_RECORDED",
  "ALREADY_RECORDED",
] as const;
export type ConfirmationDisposition = (typeof CONFIRMATION_DISPOSITIONS)[number];

export interface FinalizedPayment {
  disposition: ConfirmationDisposition;
  order: OrderRecord;
  /** Present for a completed sale, including a replayed one. */
  sale: CompletedSale | null;
}

/**
 * Record one authoritative provider confirmation.
 *
 * ## Idempotency, and where each guarantee actually lives
 *
 * | Repeat delivery of | Guarded by |
 * | --- | --- |
 * | a success on a `PAID` Order | `0M.9`'s replay branch — same provider reference returns the existing sale and writes nothing |
 * | a **different** success on a `PAID` Order | `PaymentResultConflictError`, deliberately not idempotent: the buyer may have been charged twice |
 * | a failure on a `PAYMENT_FAILED` Order | the pre-check below, which reports `ALREADY_RECORDED` rather than attempting an invalid transition |
 * | two deliveries racing concurrently | the `UNIQUE` index on `TransactionEconomicSnapshot.orderId` — the loser's whole transaction rolls back, and its retry finds the Order `PAID` and replays |
 *
 * So: no snapshot, no settlement row, no proceeds obligation, no purchase
 * evidence, no notification obligation, and no `PAID` transition is ever created
 * twice — and **none of that is new machinery.** It is `0M.9`'s existing rules,
 * reached from a webhook instead of a test.
 *
 * A failure on a `PAID` Order and any confirmation about a `CANCELLED` Order both
 * raise, because each is a real contradiction between what a provider says and
 * what Monacado has authoritatively recorded. Swallowing one to keep a webhook
 * endpoint quiet would bury the only fact worth surfacing.
 */
export async function finalizeConfirmedPayment(
  confirmation: BuyerPaymentConfirmation,
  deps: OrderServiceDeps = {},
): Promise<FinalizedPayment> {
  const existing = await getOrder(confirmation.orderId, deps);

  /* A repeated failure delivery. `recordPaymentResult` would refuse the
     PAYMENT_FAILED → PAYMENT_FAILED transition, and rightly — but a provider
     redelivering an event it already delivered is not an invalid transition
     attempt, it is the ordinary at-least-once behaviour every webhook has. */
  if (existing.lifecycle === "PAYMENT_FAILED" && confirmation.result.outcome === "FAILED") {
    return { disposition: "ALREADY_RECORDED", order: existing, sale: null };
  }

  const wasAlreadyPaid = existing.lifecycle === "PAID";

  const { order, sale } = await recordPaymentResult(
    confirmation.orderId,
    confirmation.result,
    confirmation.observedAt,
    confirmation.provider,
    deps,
  );

  if (wasAlreadyPaid) return { disposition: "ALREADY_RECORDED", order, sale };
  return {
    disposition: sale === null ? "FAILURE_RECORDED" : "SALE_RECORDED",
    order,
    sale,
  };
}
