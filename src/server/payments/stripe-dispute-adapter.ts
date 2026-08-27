/**
 * Stripe dispute intake (Phase 1.11) — SERVER ONLY, TEST MODE ONLY.
 *
 * **The boundary where Stripe stops.** Everything above this file speaks
 * `DisputeObservation`; nothing above it can tell which provider produced one.
 * That is the rule the webhook route handler already states as "no Stripe type
 * crosses into the service layer", and it is what makes the dispute model
 * provider-neutral rather than merely provider-shaped.
 *
 * ## A separate port, not a widened one
 *
 * `BuyerPaymentConfirmationPort` is deliberately not extended. Its
 * `HANDLED_EVENT_TYPES` list is four `checkout.session.*` events and its body
 * casts `event.data.object` to a Checkout Session unconditionally — adding a
 * `charge.dispute.*` type to that list would cast a `Stripe.Dispute` to a
 * Session, read `undefined` metadata, and throw "not attributable". Beyond the
 * mechanics, `1.2` kept `RefundExecutionPort` separate from `BuyerPaymentPort`
 * because "charging a buyer and refunding one are different privileges", and
 * hearing that a bank reversed a payment is a third.
 *
 * ## Attribution is by PaymentIntent, and only by PaymentIntent
 *
 * A Stripe `Dispute` carries **no Monacado order metadata**. `Dispute.metadata`
 * is the dispute's own, not the PaymentIntent's, and it is always empty here. So
 * the only route from a provider dispute back to a sale is
 * `dispute.payment_intent` matched against `TransactionSettlement`'s stored
 * `providerTransactionRef` — which is the PaymentIntent id, chosen over the
 * session id at `1.0` precisely because it "identifies the captured
 * transaction". No API call and no expansion is needed to make that join.
 *
 * ## What is read and deliberately dropped
 *
 * `dispute.evidence` (cardholder email, name, purchase IP, billing and shipping
 * addresses), `dispute.payment_method_details` (card brand and network),
 * `dispute.network_reason_code` (a free-form issuer string), and
 * `dispute.balance_transactions` (which carries the network's dispute fee, for
 * which no Monacado cost ledger exists). None of it is returned, logged, or
 * persisted.
 */

import "../server-only";
import type Stripe from "stripe";
import {
  DisputeObservation,
  type DisputeEventKind,
  type DisputeReasonCode,
  type DisputeStatus,
} from "../../contracts/marketplace/transaction-dispute";
import type { ProviderNotification } from "../../contracts/marketplace/buyer-payment";
/* Reused, not redeclared: a caller that catches a verification failure must not
   have to know which adapter raised it, and the route handler already maps this
   exact class to 400. */
import { StripeWebhookVerificationError } from "./stripe-buyer-payment-adapter";
import {
  resolveStripeWebhookSecret,
  type Env,
} from "./stripe-runtime-config";
import { getStripeRuntime, type StripeRuntime } from "./stripe-client";

export interface StripeDisputeAdapterDeps {
  runtime?: StripeRuntime;
  env?: Env;
}

/**
 * The five provider events this phase understands.
 *
 * `closed` is handled separately from `funds_withdrawn` because they are
 * different facts: a dispute can close `won` having moved no money, and funds
 * can be withdrawn while it is still under review.
 *
 * Not here, on purpose: `issuing_dispute.*` (card **issuing** — Monacado is not
 * an issuer) and `radar.early_fraud_warning.*` (a pre-dispute signal, which is a
 * different fact needing its own model and its own decision about acting on a
 * warning).
 */
export const HANDLED_DISPUTE_EVENT_TYPES: readonly string[] = Object.freeze([
  "charge.dispute.created",
  "charge.dispute.updated",
  "charge.dispute.closed",
  "charge.dispute.funds_withdrawn",
  "charge.dispute.funds_reinstated",
]);

const EVENT_KIND_BY_TYPE: Readonly<Record<string, DisputeEventKind>> = Object.freeze({
  "charge.dispute.created": "OPENED",
  "charge.dispute.updated": "UPDATED",
  "charge.dispute.closed": "CLOSED",
  "charge.dispute.funds_withdrawn": "FUNDS_WITHDRAWN",
  "charge.dispute.funds_reinstated": "FUNDS_REINSTATED",
});

/**
 * Stripe's dispute status to Monacado's.
 *
 * Total by construction: anything unrecognised becomes
 * `MANUAL_REMEDIATION_REQUIRED` rather than the nearest-looking bucket, which is
 * the posture `stripe-failure-mapping` takes and states as "an unrecognised
 * member must degrade to an honest absence of classification".
 *
 * The `warning_*` family maps to ordinary members rather than gaining its own:
 * an early warning is a real provider state, but what Monacado *does* about it
 * is what the mapped member already says.
 */
export function disputeStatusFromProvider(providerStatus: string): DisputeStatus {
  switch (providerStatus) {
    case "warning_needs_response":
    case "needs_response":
      return "NEEDS_RESPONSE";
    case "warning_under_review":
    case "under_review":
      return "UNDER_REVIEW";
    case "won":
      return "WON";
    case "lost":
      return "LOST";
    case "warning_closed":
    case "prevented":
      return "CLOSED";
    default:
      return "MANUAL_REMEDIATION_REQUIRED";
  }
}

/**
 * Stripe's reason string to Monacado's bounded vocabulary.
 *
 * Stripe types `Dispute.reason` as an open `string`. Everything unrecognised
 * becomes `UNSPECIFIED` — the provider's own word is never stored.
 */
export function disputeReasonFromProvider(providerReason: string): DisputeReasonCode {
  switch (providerReason) {
    case "fraudulent":
      return "FRAUDULENT";
    case "product_not_received":
      return "PRODUCT_NOT_RECEIVED";
    case "product_unacceptable":
      return "PRODUCT_UNACCEPTABLE";
    case "duplicate":
      return "DUPLICATE";
    case "credit_not_processed":
      return "CREDIT_NOT_PROCESSED";
    case "subscription_canceled":
      return "SUBSCRIPTION_CANCELED";
    case "unrecognized":
      return "UNRECOGNIZED";
    case "general":
      return "GENERAL";
    default:
      return "UNSPECIFIED";
  }
}

/**
 * A provider deadline to an instant.
 *
 * `0` is **not** the epoch. Stripe documents `due_by` as *"0 if the customer's
 * bank or credit card company doesn't allow a response"*, so storing it as a
 * date would render a deadline permanently in the past, poison the operator's
 * deadline query, and make "no deadline" indistinguishable from "no response
 * possible" — two opposite situations.
 */
function dueByToInstant(dueBy: number | null | undefined): string | null {
  if (dueBy === null || dueBy === undefined) return null;
  if (dueBy === 0) return null;
  return new Date(dueBy * 1_000).toISOString();
}

function stringRef(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (value !== null && typeof value === "object" && "id" in value) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

/** What this adapter can be asked to do. Provider-neutral by shape. */
export interface DisputeNotificationPort {
  observeDispute(notification: ProviderNotification): Promise<DisputeObservation | null>;
}

/**
 * Read one verified provider webhook as a dispute observation.
 *
 * Returns `null` when the event is not a dispute event — the caller then knows
 * this delivery was none of its business, exactly as `confirmPayment` returns
 * `null` for an event it does not handle.
 *
 * **The signature is verified here, over the raw bytes, before anything is
 * parsed.** A second HMAC per delivery is cheap, and verifying independently
 * leaves the committed money path byte-for-byte unchanged rather than
 * refactoring a shared helper out of it inside a phase that touches money.
 */
export function createStripeDisputeNotificationPort(
  deps: StripeDisputeAdapterDeps = {},
): DisputeNotificationPort {
  return {
    async observeDispute(notification) {
      const { config, client } = deps.runtime
        ? { config: deps.runtime.config, client: deps.runtime.client }
        : (() => {
            const runtime = getStripeRuntime(deps.env);
            return { config: runtime.config, client: runtime.client };
          })();

      if (notification.signatureHeader === null) throw new StripeWebhookVerificationError();

      let event: Stripe.Event;
      try {
        event = await client.webhooks.constructEventAsync(
          notification.rawBody,
          notification.signatureHeader,
          resolveStripeWebhookSecret(config, deps.env),
        );
      } catch {
        /* Swallowed and replaced, on `1.0`'s terms: Stripe's message
           distinguishes a malformed header from a stale timestamp from a wrong
           secret, and an endpoint that reports which is an oracle for forging
           one. */
        throw new StripeWebhookVerificationError();
      }

      if (!HANDLED_DISPUTE_EVENT_TYPES.includes(event.type)) return null;

      const dispute = event.data.object as Stripe.Dispute;
      const evidence = dispute.evidence_details ?? null;

      const observation = {
        provider: "STRIPE" as const,
        providerMode: "TEST" as const,
        providerDisputeRef: dispute.id,
        providerEventId: event.id,
        /* The attribution key. Never `dispute.metadata` — see the header. */
        providerTransactionRef: stringRef(dispute.payment_intent) ?? "",
        providerChargeRef: stringRef(dispute.charge),

        eventKind: EVENT_KIND_BY_TYPE[event.type] ?? "UPDATED",

        /* Stripe's amount is already minor units, and so is every money column
           in this repository. It passes through unmodified. */
        disputedAmountMinorUnits: dispute.amount,
        /* Stripe returns lowercase; CurrencyCode is /^[A-Z]{3}$/. */
        currency: (dispute.currency ?? "").toUpperCase(),
        reasonCode: disputeReasonFromProvider(dispute.reason ?? ""),
        status: disputeStatusFromProvider(dispute.status ?? ""),

        evidenceDueBy: dueByToInstant(evidence?.due_by),
        /* `due_by === 0` means the bank permits no response at all. */
        responsePermitted: evidence?.due_by !== 0,
        evidenceStagedAtProvider: evidence?.has_evidence === true,
        evidenceSubmissionCount: evidence?.submission_count ?? 0,
        evidenceSubmittedPastDue: evidence?.past_due === true,
        chargeStillRefundable: dispute.is_charge_refundable === true,

        openedAt: new Date((dispute.created ?? 0) * 1_000).toISOString(),
        occurredAt: new Date((event.created ?? 0) * 1_000).toISOString(),

        /* Carried, not filtered. The refusal is a recorded decision in the
           service with a remediation code, rather than a silently dropped
           event. `1.9`'s refund adapter noted it could NOT check this, because
           a Stripe Refund carries no `livemode`; a Dispute does, so use it. */
        providerReportedLivemode: dispute.livemode === true,
      };

      /* Parsed rather than cast: a provider that changed shape underneath this
         adapter should fail here, at the boundary, and not three layers up. */
      return DisputeObservation.parse(observation);
    },
  };
}
