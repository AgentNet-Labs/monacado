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
import { enqueueDisputeNotices } from "../notifications/dispute-notice-service";
import { recordDisputeObservation } from "../marketplace/transaction-dispute-service";
import type { DisputeNotificationPort } from "./stripe-dispute-adapter";
import type { OutboundEmailIdProvider } from "../notifications/outbound-email-ids";
import { dispatchEmailDeliveriesNow } from "../notifications/email-dispatcher";
import {
  enqueueOrderExpiredNotice,
  enqueuePaymentFailedNotice,
  enqueueSaleNotices,
} from "../notifications/transactional-notice-service";
import { PostalAddress } from "../../contracts/marketplace/order-buyer-snapshot";
import { confirmBuyerSnapshot } from "../marketplace/order-buyer-snapshot-service";
import { finalizeConfirmedPayment } from "./executable-checkout-service";
import { runTaxTransactionRecordingCycle } from "../tax/tax-transaction-recorder";
import type { TaxTransactionRecordingPort } from "../tax/stripe-tax-transaction-adapter";
import type { TaxRecordingMonitor } from "../../contracts/marketplace/tax-recording-operations";
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
  /** A dispute was recorded and needs a human (Phase 1.11). Still a 200. */
  disputeRemediation: "DISPUTE_REMEDIATION_REQUIRED",
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
  /**
   * Phase 1.11 — the port that reads a dispute event.
   *
   * A SEPARATE port, consulted only after the payment port has declined the
   * delivery. Injected in the route module alone, exactly as `taxRecordingPort`
   * is, so no test of this handler can reach a network.
   */
  disputePort?: DisputeNotificationPort;
  /** Injected so a test drives delivery without a mail provider. */
  mail?: MailPort;
  deliveryIds?: OutboundEmailIdProvider;
  /**
   * Phase 1.8 — the port a best-effort immediate tax recording uses.
   *
   * **Opt-in, and absent by default.** A webhook route that constructed a real
   * provider client on its own would make every test that exercises the route a
   * test that could reach the network. The production route module supplies it;
   * everything else gets the scheduler, which is the guarantee anyway.
   */
  taxRecordingPort?: TaxTransactionRecordingPort;
  taxRecordingMonitor?: TaxRecordingMonitor;
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

  /* Not a payment event. Before acknowledging, offer it to the dispute port
     (Phase 1.11) — dispute events reached exactly this line before 1.11 and
     were discarded, which meant a bank could take money out of Monacado's
     balance and nothing in the database would record it. */
  if (confirmation === null) {
    if (deps.disputePort !== undefined) {
      let observation;
      try {
        observation = await deps.disputePort.observeDispute({
          rawBody: request.rawBody,
          signatureHeader: request.signatureHeader,
        });
      } catch (error) {
        if (error instanceof StripeWebhookVerificationError) {
          return respond(400, { error: WEBHOOK_ERROR_CODES.verification });
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

      if (observation !== null) {
        try {
          const outcome = await recordDisputeObservation(
            observation,
            { recordedAt: new Date().toISOString() },
            { db },
          );

          /* Notices are enqueued AFTER the dispute row commits, and every
             failure is swallowed: a dispute Monacado recorded but could not
             send mail about is still recorded. Email never determines
             financial truth. */
          if (outcome.applied) {
            try {
              /* Enqueued only. Dispatch is the email dispatcher's job, and a
                 dispute notice has no reason to be more urgent than the retry
                 machinery `1.5` already built for every other message. */
              await enqueueDisputeNotices(
                { disputeId: outcome.disputeId },
                { db, ids: deps.deliveryIds },
              );
            } catch {
              /* Deliberately ignored. See above. */
            }
          }

          /* 200 EVEN WHEN A HUMAN IS NEEDED, and this diverges from the payment
             path's 422 for an unattributable event, deliberately.
             
             A payment event Monacado cannot attribute is a sale it may still
             recover by retry. A DISPUTE Monacado cannot attribute is a real
             withdrawal whose clock is already running: telling the provider to
             keep retrying an event that will never attribute would leave it
             retrying forever while the response window closed, and the dispute
             would be visible nowhere. The row is durable and the operator tool
             surfaces it, which is the outcome that actually helps. */
          return respond(200, {
            received: true,
            handled: true,
            disputeDisposition: outcome.applied
              ? outcome.remediationCode !== null
                ? WEBHOOK_ERROR_CODES.disputeRemediation
                : "RECORDED"
              : "ALREADY_RECORDED",
          });
        } catch {
          /* A genuine write failure. 500 so the provider retries, and the
             retry replays idempotently against the event ledger. A dispute
             webhook failure must not corrupt an already-recorded sale, and
             nothing above this line has touched one. */
          return respond(500, { error: WEBHOOK_ERROR_CODES.unavailable });
        }
      }
    }

    /* Verified, and about something else. Acknowledged so Stripe stops
       retrying, and acted on in no way whatsoever. */
    return respond(200, { received: true, handled: false });
  }

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

    /* — Best-effort immediate tax recording (Phase 1.8) —
     *
     * `1.7` committed the tax-recording obligation inside the sale's own
     * transaction and left the scheduler to process it. That is correct and
     * remains the guarantee; this is the fast path in front of it, so an ordinary
     * sale is reported in seconds rather than at the next cycle.
     *
     * Three properties make it safe to run here:
     *
     *   - it is **outside** the sale's transaction, so no provider call is ever
     *     held inside a database lock;
     *   - it **cannot roll back a completed payment** — the sale is already
     *     committed and this catches everything;
     *   - it claims through `1.7`'s own claim/lease/idempotency machinery, so it
     *     races the scheduler safely and cannot produce a second provider
     *     transaction.
     *
     * A failure here is not a failure: the row stays durable and due, and the
     * scheduled dispatcher recovers it. That is why the webhook still returns
     * 200 — telling Stripe to retry a booked sale because a tax report was slow
     * would be strictly worse. */
    if (finalized.disposition === "SALE_RECORDED" && deps.taxRecordingPort !== undefined) {
      try {
        await runTaxTransactionRecordingCycle(
          { at: observedAt, limit: 1 },
          {
            db,
            port: deps.taxRecordingPort,
            ...(deps.taxRecordingMonitor === undefined
              ? {}
              : { monitor: deps.taxRecordingMonitor }),
          },
        );
      } catch {
        /* Durable work stays durable. The scheduler is the guarantee. */
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
    const notices = await dispatchNotices(finalized, observedAt, {
      db,
      mail: deps.mail ?? resolveMailPort(deps.env),
      ...(deps.deliveryIds === undefined ? {} : { ids: deps.deliveryIds }),
      ...(deps.env === undefined ? {} : { env: deps.env }),
    });

    return respond(200, {
      received: true,
      handled: true,
      disposition: finalized.disposition,
      lifecycle: finalized.order.lifecycle,
      /* What Monacado COMMITTED to sending, not what got out. Sending is the
         dispatcher's, and a message that failed its first attempt is still owed
         and still scheduled — which is precisely what `1.1` could not say. */
      noticesScheduled: notices,
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
 * Commit to whatever this outcome owes, then try immediately — and never let
 * either change the outcome.
 *
 * Returns the number of messages **committed to**, purely so the response is
 * observable in a test and in Stripe's dashboard. Two things happen here and the
 * split is the whole Phase 1.5 correction:
 *
 *   1. **Enqueue.** Durable, idempotent on the logical message, and the part that
 *      matters. Once this succeeds the receipt is owed and will be retried up to
 *      the policy's limit even if every send now fails.
 *   2. **Attempt now, best effort.** A buyer should not wait for a scheduler to
 *      learn their payment succeeded. Restricted to the rows just committed, so a
 *      backlog belonging to somebody else never becomes this response's latency.
 *
 * Every failure in either step is swallowed **after the commitment is durable**:
 * the sale is already booked, and throwing here would turn a mail problem into a
 * webhook retry of a booked sale. `1.1` swallowed failures too — but it had
 * nothing left behind afterwards, which is exactly the gap this closes.
 */
async function dispatchNotices(
  finalized: { disposition: string; order: OrderRecord },
  observedAt: string,
  deps: { db: Db; mail: MailPort; ids?: OutboundEmailIdProvider; env?: Env },
): Promise<number> {
  const noticeDeps = {
    db: deps.db,
    ...(deps.ids === undefined ? {} : { ids: deps.ids }),
    ...(deps.env === undefined ? {} : { env: deps.env }),
  };
  const args = { order: finalized.order, at: observedAt };

  let deliveryIds: string[] = [];
  try {
    switch (finalized.disposition) {
      case "SALE_RECORDED":
        deliveryIds = (await enqueueSaleNotices(args, noticeDeps)).deliveries.map(
          (d) => d.deliveryId,
        );
        break;
      case "FAILURE_RECORDED":
        deliveryIds = (await enqueuePaymentFailedNotice(args, noticeDeps)).deliveries.map(
          (d) => d.deliveryId,
        );
        break;
      case "ORDER_EXPIRED":
        deliveryIds = (await enqueueOrderExpiredNotice(args, noticeDeps)).deliveries.map(
          (d) => d.deliveryId,
        );
        break;
      default:
        /* ALREADY_RECORDED — a replay. Nothing newly became true, so nobody is
           newly owed a message. Decided by the OUTCOME, before the delivery key
           is even consulted. */
        return 0;
    }
  } catch {
    return 0;
  }

  try {
    await dispatchEmailDeliveriesNow(
      { deliveryIds, now: observedAt },
      deps.mail,
      noticeDeps,
    );
  } catch {
    /* The commitment stands and the dispatcher will pick it up. A send that
       failed here is a retry, not a lost receipt. */
  }

  return deliveryIds.length;
}

/** Validate a provider-reported address, or treat it as absent. */
function asAddress(value: unknown): PostalAddress | null {
  if (value === null || value === undefined) return null;
  const parsed = PostalAddress.safeParse(value);
  return parsed.success ? parsed.data : null;
}
