/**
 * Stripe webhook route handler (Phase 1.0) — SERVER ONLY.
 *
 * **The only path in the repository that can mark an Order `PAID`.** Everything
 * else — the buyer's return page, the status route, the checkout route — reads.
 * That is the correctness property this phase exists to establish: a payment is
 * true because Stripe signed a statement that it happened, not because a browser
 * arrived at a URL saying so.
 *
 * ## Order of operations, and why it is that order
 *
 *   1. **Verify the signature over the raw bytes.** Before parsing, before
 *      looking at the event type, before touching the database. A signature
 *      authenticates bytes; anything done first is done on unauthenticated input.
 *   2. **Translate into Monacado's vocabulary.** The adapter returns a
 *      `BuyerPaymentConfirmation` carrying a `BuyerPaymentResult` and nothing
 *      Stripe-shaped. No Stripe type crosses into the service layer.
 *   3. **Hand it to the existing finalization path**, unchanged.
 *
 * ## Idempotency
 *
 * At-least-once delivery is assumed, not hoped for. A repeated event produces no
 * second transaction snapshot, settlement row, proceeds obligation, purchase
 * evidence, notification obligation, or `PAID` transition — see
 * `finalizeConfirmedPayment`, where each guarantee is named against the mechanism
 * that provides it. **No event-id ledger was built**: the Order's own lifecycle
 * and the `UNIQUE` index on `TransactionEconomicSnapshot.orderId` already answer
 * the question, and a second store of processed events would be a second answer
 * that can disagree with the first.
 *
 * ## What this is not
 *
 * Not an event bus. Four event types are acted on; every other verified delivery
 * is acknowledged with `200` and ignored, because acknowledging is how Stripe is
 * told to stop retrying something Monacado has no opinion about.
 *
 * ## Notices (Phase 1.1)
 *
 * After finalization the handler dispatches buyer and participant notices, driven
 * by **what the write path authoritatively did** rather than by the event type.
 * A replayed event finalizes to `ALREADY_RECORDED` and therefore sends nothing —
 * duplicate delivery is prevented by the outcome, before the delivery layer's own
 * unique key is even consulted. Delivery never changes the response: a mail
 * outage is not a reason to tell Stripe a booked sale failed.
 *
 * ## Status codes, and what Stripe does with them
 *
 * | Situation | Status | Effect |
 * | --- | --- | --- |
 * | recorded, replayed, or ignored | `200` | Stripe stops |
 * | signature absent or invalid | `400` | Stripe stops; the sender learns nothing else |
 * | contradicts authoritative state | `409` | Stripe retries, then surfaces it as a failed webhook — which is where a human should see this |
 * | Monacado could not write | `500` | Stripe retries; the retry replays idempotently |
 */

import "../server-only";
import type {
  BuyerPaymentConfirmation,
  BuyerPaymentConfirmationPort,
} from "../../contracts/marketplace/buyer-payment";
import type { MailPort } from "../../contracts/marketplace/notification-delivery";
import type { OrderRecord } from "../../contracts/marketplace/order";
import { getPrisma } from "../db/client";
import { resolveMailPort } from "../notifications/mail-port";
import type { NotificationDeliveryIdProvider } from "../notifications/notification-delivery-ids";
import {
  dispatchOrderExpiredNotice,
  dispatchPaymentFailedNotice,
  dispatchSaleNotices,
} from "../notifications/transactional-notice-service";
import { PostalAddress } from "../../contracts/marketplace/order-buyer-snapshot";
import { confirmBuyerSnapshot } from "../marketplace/order-buyer-snapshot-service";
import { finalizeConfirmedPayment } from "./executable-checkout-service";
import {
  StripeEventNotAttributableError,
  StripeWebhookVerificationError,
  createStripeBuyerPaymentConfirmationPort,
} from "./stripe-buyer-payment-adapter";
import {
  StripeConfigurationError,
  StripeCredentialError,
  StripeDisabledError,
  type Env,
} from "./stripe-runtime-config";
import {
  InvalidOrderTransitionError,
  OrderNotFoundError,
  PaymentResultConflictError,
  QuoteSnapshotMismatchError,
} from "../marketplace/order-errors";

type Db = ReturnType<typeof getPrisma>;

/** The header Stripe signs its deliveries with. */
export const STRIPE_SIGNATURE_HEADER = "stripe-signature";

export const WEBHOOK_ERROR_CODES = {
  verification: "WEBHOOK_VERIFICATION_FAILED",
  notConfigured: "WEBHOOK_NOT_CONFIGURED",
  unattributable: "EVENT_NOT_ATTRIBUTABLE",
  orderNotFound: "ORDER_NOT_FOUND",
  conflict: "PAYMENT_RESULT_CONFLICT",
  unavailable: "WEBHOOK_UNAVAILABLE",
} as const;

export const WEBHOOK_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

export interface WebhookRouteResult {
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface WebhookRouteDeps {
  db?: Db;
  env?: Env;
  /** Injected so a test drives the whole route without a Stripe account. */
  port?: BuyerPaymentConfirmationPort;
  /** Injected so a test drives delivery without a mail provider. */
  mail?: MailPort;
  deliveryIds?: NotificationDeliveryIdProvider;
  now?: () => string;
}

function respond(status: number, body: Record<string, unknown>): WebhookRouteResult {
  return { status, headers: { ...WEBHOOK_HEADERS }, body };
}

/**
 * Process one Stripe delivery.
 *
 * `rawBody` must be the **exact bytes received**. A caller that parsed and
 * re-serialised would be asking for a signature over something Stripe never sent,
 * and every delivery would fail verification — which is the safe direction for
 * that mistake to fail in, but it is still a mistake, so the Next.js route reads
 * `request.text()` and hands it straight through.
 */
export async function handleStripeWebhookRequest(
  request: { rawBody: string; signatureHeader: string | null },
  deps: WebhookRouteDeps = {},
): Promise<WebhookRouteResult> {
  const db = deps.db ?? getPrisma();
  const observedAt = (deps.now ?? (() => new Date().toISOString()))();

  let port: BuyerPaymentConfirmationPort;
  try {
    port =
      deps.port ??
      createStripeBuyerPaymentConfirmationPort(
        { observedAt },
        deps.env === undefined ? {} : { env: deps.env },
      );
  } catch (error) {
    if (
      error instanceof StripeDisabledError ||
      error instanceof StripeConfigurationError ||
      error instanceof StripeCredentialError
    ) {
      return respond(503, { error: WEBHOOK_ERROR_CODES.notConfigured });
    }
    throw error;
  }

  let confirmation;
  try {
    confirmation = await port.confirmPayment({
      rawBody: request.rawBody,
      signatureHeader: request.signatureHeader,
    });
  } catch (error) {
    if (error instanceof StripeWebhookVerificationError) {
      /* 400 and nothing else. Not 401 (there is no credential to re-present),
         not 403 (this is not an authorization decision), and no detail — the
         difference between a wrong secret and a stale timestamp is exactly what
         a forger needs. */
      return respond(400, { error: WEBHOOK_ERROR_CODES.verification });
    }
    if (error instanceof StripeEventNotAttributableError) {
      return respond(422, { error: WEBHOOK_ERROR_CODES.unattributable });
    }
    if (
      error instanceof StripeDisabledError ||
      error instanceof StripeConfigurationError ||
      error instanceof StripeCredentialError
    ) {
      return respond(503, { error: WEBHOOK_ERROR_CODES.notConfigured });
    }
    return respond(500, { error: WEBHOOK_ERROR_CODES.unavailable });
  }

  /* Verified, and about something else. Acknowledged so Stripe stops retrying,
     and acted on in no way whatsoever. */
  if (confirmation === null) return respond(200, { received: true, handled: false });

  try {
    const finalized = await finalizeConfirmedPayment(confirmation, { db });

    /* — Supersede the buyer snapshot (Phase 1.2 correction) —
     *
     * The completed session carries the details the payment ACTUALLY
     * authorized. A browser can post anything; a completed payment cannot. This
     * runs after finalization and never affects it: knowing more precisely who
     * paid must not change whether the sale was recorded. */
    if (confirmation.confirmedDetails !== null) {
      try {
        await confirmBuyerSnapshot(
          {
            orderId: confirmation.orderId,
            confirmed: {
              name: confirmation.confirmedDetails.name,
              email: confirmation.confirmedDetails.email,
              billingAddress: asAddress(confirmation.confirmedDetails.billingAddress),
              shippingAddress: asAddress(confirmation.confirmedDetails.shippingAddress),
            },
            confirmedAt: observedAt,
          },
          { db },
        );
      } catch {
        /* Recorded-nowhere-else detail failing to land must not fail a booked
           sale, and must not tell Stripe to retry one. */
      }
    }

    /* — Notice dispatch (Phase 1.1) —
     *
     * Driven from what the write path AUTHORITATIVELY DID, never from the event
     * type. Stripe saying "completed" is not the trigger; Monacado having
     * recorded a sale is. That is what makes duplicate delivery structurally
     * impossible on a replay: a redelivered event finalizes to
     * `ALREADY_RECORDED`, which falls through this switch and sends nothing —
     * before the delivery layer's own unique key is even consulted.
     *
     * Delivery never affects the response. A refused message is recorded as
     * evidence and the webhook still returns 200, because a mail outage is not a
     * reason to tell Stripe the payment was not processed — that would earn a
     * retry of a sale already booked. */
    const notices = await dispatchNotices(finalized, confirmation, observedAt, {
      db,
      mail: deps.mail ?? resolveMailPort(deps.env),
      ...(deps.deliveryIds === undefined ? {} : { ids: deps.deliveryIds }),
    });

    return respond(200, {
      received: true,
      handled: true,
      disposition: finalized.disposition,
      lifecycle: finalized.order.lifecycle,
      noticesAttempted: notices,
    });
  } catch (error) {
    if (error instanceof OrderNotFoundError) {
      return respond(404, { error: WEBHOOK_ERROR_CODES.orderNotFound });
    }
    if (
      error instanceof PaymentResultConflictError ||
      error instanceof InvalidOrderTransitionError ||
      error instanceof QuoteSnapshotMismatchError
    ) {
      /* A provider statement that contradicts authoritative Monacado state.
         Never silently accepted: a different provider transaction against a paid
         Order may mean the buyer was charged twice, and a repriced Listing means
         Monacado would be booking a sale for one figure having charged another. */
      return respond(409, { error: WEBHOOK_ERROR_CODES.conflict });
    }
    /* Includes the losing side of two concurrent deliveries, which the snapshot's
       UNIQUE orderId index rolls back. Stripe retries; the retry finds the Order
       PAID and replays idempotently. */
    return respond(500, { error: WEBHOOK_ERROR_CODES.unavailable });
  }
}

/**
 * Send whatever this outcome owes, and never let sending change the outcome.
 *
 * Returns the number of attempts made, purely so the response is observable in a
 * test and in Stripe's dashboard. Every failure is swallowed **after being
 * recorded** by the delivery layer: the sale is already committed, and throwing
 * here would turn a mail problem into a webhook retry of a booked sale.
 */
async function dispatchNotices(
  finalized: { disposition: string; order: OrderRecord },
  confirmation: BuyerPaymentConfirmation,
  observedAt: string,
  deps: { db: Db; mail: MailPort; ids?: NotificationDeliveryIdProvider },
): Promise<number> {
  const buyerAddress = confirmation.buyerContact?.email ?? null;
  const noticeDeps = { db: deps.db, ...(deps.ids === undefined ? {} : { ids: deps.ids }) };
  const args = { order: finalized.order, buyerAddress, at: observedAt };

  try {
    switch (finalized.disposition) {
      case "SALE_RECORDED":
        return (await dispatchSaleNotices(args, deps.mail, noticeDeps)).attempts.length;
      case "FAILURE_RECORDED":
        return (await dispatchPaymentFailedNotice(args, deps.mail, noticeDeps)).attempts.length;
      case "ORDER_EXPIRED":
        return (await dispatchOrderExpiredNotice(args, deps.mail, noticeDeps)).attempts.length;
      default:
        /* ALREADY_RECORDED — a replay. Nothing newly became true, so nobody is
           newly owed a message. */
        return 0;
    }
  } catch {
    return 0;
  }
}

/** Validate a provider-reported address, or treat it as absent. */
function asAddress(value: unknown): PostalAddress | null {
  if (value === null || value === undefined) return null;
  const parsed = PostalAddress.safeParse(value);
  return parsed.success ? parsed.data : null;
}
