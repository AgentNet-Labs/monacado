/**
 * The Stripe buyer-payment adapter (Phase 1.0) — SERVER ONLY.
 *
 * The concrete implementation `0M.9` deferred, and the only place Stripe's model
 * of a payment exists. It implements two provider-neutral ports and nothing else:
 *
 *   - `BuyerPaymentInitiationPort` — create a hosted Checkout Session for one
 *     Order and return where the buyer must go.
 *   - `BuyerPaymentConfirmationPort` — verify one webhook delivery and translate
 *     it into a `BuyerPaymentResult` that `recordPaymentResult` already accepts.
 *
 * Five properties shape it:
 *
 *   1. **Stripe never calculates Monacado's economics.** The adapter receives a
 *      `BuyerPaymentRequest` carrying one amount — the buyer's total, already
 *      derived by `prepareCheckout` from the bound Listing version and the bound
 *      commercial policy — and passes it through. There is no `application_fee`,
 *      no `transfer_data`, no `on_behalf_of`, and no destination charge anywhere
 *      in this file. Stripe is told what to charge and reports what happened.
 *
 *   2. **The Order is the idempotency key, end to end.** `0M.9` made the key the
 *      Order id; this adapter hands that same key to Stripe, so a repeated
 *      begin-checkout returns the *same* Checkout Session rather than creating a
 *      second one. One Order therefore has one PaymentIntent, structurally —
 *      which is what makes "a different provider transaction on a paid Order"
 *      the genuine anomaly `0M.9` treats it as, rather than a routine race.
 *
 *   3. **Confirmation is Stripe's, never the browser's.** The only path that can
 *      produce a `SUCCEEDED` result is a webhook body that verifies against the
 *      signing secret. The buyer's return URL reads the database and asserts
 *      nothing. There is no parameter, anywhere, through which a client can state
 *      an outcome.
 *
 *   4. **Buyer data travels INWARD only** (revised in the Phase 1.2 correction).
 *      Monacado still sends Stripe no customer object, no `customer_email`, and
 *      no address — it *asks Stripe to collect* a billing address and reads the
 *      confirmed result back. That direction is the point: what returns is the
 *      identity the payment actually authorized, which a browser cannot forge.
 *      Card data never crosses at all, in either direction.
 *
 *   5. **`payment_intent.payment_failed` is deliberately NOT handled.** During a
 *      hosted Checkout Session a declined card fires that event and the buyer is
 *      simply invited to try another card on the same page. Recording
 *      `PAYMENT_FAILED` there would move the Order to a state from which `PAID`
 *      is unreachable — and the buyer's successful retry, moments later, would be
 *      a payment Monacado took and refused to book. The authoritative failure
 *      signal for this flow is `checkout.session.async_payment_failed`, which
 *      fires only for a delayed-notification method that definitively failed.
 *      Abandonment arrives separately, as `checkout.session.expired`.
 *
 *   6. **Expiry is Stripe's fact, not a Monacado timer** (Phase 1.1). Only the
 *      provider knows whether a hosted session is still payable, so no sweeper,
 *      cron, or `expiresAt` column exists here. A clock of Monacado's own
 *      guessing at it would eventually cancel an Order a buyer was midway
 *      through paying.
 */

import "../server-only";
import type Stripe from "stripe";
import {
  BuyerContact,
  BuyerPaymentConfirmation,
  BuyerPaymentInitiation,
  BuyerPaymentRequest,
  ProviderNotification,
  type BuyerPaymentConfirmationPort,
  type BuyerPaymentInitiationPort,
} from "../../contracts/marketplace/buyer-payment";
import type { PaymentFailureCode } from "../../contracts/marketplace/order";
import { PostalAddress } from "../../contracts/marketplace/order-buyer-snapshot";
import { getStripeRuntime, type StripeRuntime } from "./stripe-client";
import { resolveStripeWebhookSecret, type Env } from "./stripe-runtime-config";
import { toPaymentFailureCodeFromDecline } from "./stripe-failure-mapping";

/**
 * The metadata key carrying Monacado's Order id on a Stripe object.
 *
 * `client_reference_id` was the obvious home and is not usable: Stripe bounds it
 * to alphanumerics, dashes, and underscores, and a Monacado Order id contains
 * colons. Metadata takes the id unaltered, which matters — a reference that had
 * to be reshaped to fit would be a second identifier to map back.
 */
export const ORDER_METADATA_KEY = "monacadoOrderId";

/**
 * What the buyer sees on Stripe's page.
 *
 * Deliberately generic. The Listing's title, the Product's name, and the seller's
 * identity are all Monacado facts that Stripe has no reason to hold, and a line
 * item is exactly where they would leak. Giving the buyer a recognisable
 * description is a real UX gap and is recorded as such — it needs a decision
 * about what Monacado is willing to disclose to a processor, not a default.
 */
export const LINE_ITEM_NAME = "Monacado order";

// — Errors —

export class StripePaymentInitiationError extends Error {
  readonly cause?: unknown;
  constructor(cause?: unknown) {
    super("Stripe could not start this payment");
    this.name = "StripePaymentInitiationError";
    this.cause = cause;
  }
}

/**
 * A webhook body did not verify against the signing secret.
 *
 * Carries no detail at all. A verification failure is either a misconfiguration
 * or someone probing the endpoint, and telling the second one *why* they failed
 * is how a probe becomes a working forgery.
 */
export class StripeWebhookVerificationError extends Error {
  constructor() {
    super("Stripe webhook signature verification failed");
    this.name = "StripeWebhookVerificationError";
  }
}

/**
 * A verified Stripe event was about a buyer payment but could not be attributed
 * to a Monacado Order.
 *
 * Distinct from "not about a payment", which returns `null`: this one means the
 * event *is* ours and something is wrong, and swallowing it would lose a sale.
 */
export class StripeEventNotAttributableError extends Error {
  readonly eventType: string;
  constructor(eventType: string) {
    super(`Stripe event ${eventType} carries no Monacado Order reference`);
    this.name = "StripeEventNotAttributableError";
    this.eventType = eventType;
  }
}

// — Helpers —

function orderIdFromMetadata(metadata: Stripe.Metadata | null): string | null {
  const value = metadata?.[ORDER_METADATA_KEY];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** A webhook payload leaves references unexpanded, so this is normally a string. */
function paymentIntentRef(value: string | Stripe.PaymentIntent | null): string | null {
  if (value === null) return null;
  return typeof value === "string" ? value : value.id;
}

/**
 * The buyer's address, as Stripe collected it on its own hosted page.
 *
 * Read **inward only**, never sent: Monacado asks Stripe for no customer object
 * and sets no `customer_email` on the session. Stripe collects an address because
 * a hosted checkout must, and this reads it back so a buyer — a guest above all —
 * can be sent their own receipt.
 *
 * `null` is ordinary: a buyer who abandoned before typing anything has none, and
 * an expired session frequently carries no `customer_details` at all.
 */
function buyerContactFrom(session: Stripe.Checkout.Session): { email: string } | null {
  const email = session.customer_details?.email;
  if (typeof email !== "string" || email.trim() === "") return null;
  const parsed = BuyerContact.safeParse({ email: email.trim() });
  /* An address Monacado cannot validate is treated as absent rather than
     forced through — a malformed address is not worth failing a sale over. */
  return parsed.success ? parsed.data : null;
}

/**
 * Translate a Stripe address into Monacado's structured shape (Phase 1.2).
 *
 * `null` for anything incomplete. A partial address is worse than none: it looks
 * authoritative, sources tax to a jurisdiction nobody confirmed, and would
 * silently supersede the complete one the buyer supplied.
 */
function addressFrom(address: Stripe.Address | null | undefined): PostalAddress | null {
  if (address == null) return null;
  const parsed = PostalAddress.safeParse({
    line1: address.line1 ?? "",
    line2: address.line2 === null || address.line2 === undefined ? null : address.line2,
    city: address.city ?? "",
    region: address.state === null || address.state === undefined ? null : address.state,
    postalCode:
      address.postal_code === null || address.postal_code === undefined
        ? null
        : address.postal_code,
    countryCode: (address.country ?? "").toUpperCase(),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * The details the completed payment **actually authorized** (Phase 1.2).
 *
 * Read **inward only**, from the completed session. A browser can post anything;
 * a completed payment cannot, so this is what supersedes the buyer-typed
 * snapshot. Every field is independently nullable: Stripe reports what it
 * collected, and a field it omits is one it has no opinion about — discarding
 * the buyer's own answer because the provider stayed silent would lose
 * information for no gain.
 */
export interface ConfirmedBuyerDetails {
  name: string | null;
  email: string | null;
  billingAddress: PostalAddress | null;
  shippingAddress: PostalAddress | null;
}

function confirmedDetailsFrom(session: Stripe.Checkout.Session): ConfirmedBuyerDetails {
  const details = session.customer_details;
  const shipping = (session as { shipping_details?: { address?: Stripe.Address | null } })
    .shipping_details;
  return {
    name: details?.name ?? null,
    email: details?.email ?? null,
    billingAddress: addressFrom(details?.address),
    shippingAddress: addressFrom(shipping?.address),
  };
}

function buildReturnUrl(base: string, orderId: string): string {
  const url = new URL(base);
  url.searchParams.set("orderId", orderId);
  return url.toString();
}

// — Initiation —

export interface StripeAdapterDeps {
  runtime?: StripeRuntime;
  env?: Env;
}

function resolveRuntime(deps: StripeAdapterDeps): StripeRuntime {
  return deps.runtime ?? getStripeRuntime(deps.env);
}

/**
 * Start one buyer payment as a hosted Stripe Checkout Session.
 *
 * Hosted rather than embedded, and that is the security decision, not the lazy
 * one: no Stripe.js runs in Monacado's page, no publishable key reaches the
 * browser bundle, no card detail ever touches a Monacado origin, and the
 * repository gains no client-side payment SDK. The buyer leaves, pays, and comes
 * back to a page that reads the database.
 */
export function createStripeBuyerPaymentAdapter(
  deps: StripeAdapterDeps = {},
): BuyerPaymentInitiationPort {
  return {
    async initiatePayment(rawRequest) {
      const request = BuyerPaymentRequest.parse(rawRequest);
      const { config, client } = resolveRuntime(deps);

      let session: Stripe.Checkout.Session;
      try {
        session = await client.checkout.sessions.create(
          {
            mode: "payment",
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: request.currency.toLowerCase(),
                  /* The buyer's total, exactly as Monacado derived it. Stripe is
                     not asked to add tax, apply a coupon, or compute anything. */
                  unit_amount: request.amountMinorUnits,
                  product_data: { name: LINE_ITEM_NAME },
                },
              },
            ],
            success_url: buildReturnUrl(config.successUrl, request.orderId),
            cancel_url: buildReturnUrl(config.cancelUrl, request.orderId),
            /* Phase 1.2 correction — Stripe collects BOTH addresses the payment
               is authorized against, so Monacado can supersede the buyer-typed
               ones with what the payment actually confirmed.
             *
               Shipping is collected only when the basket contains something
               physical — decided by Monacado from explicit Product delivery
               modes, never by Stripe and never inferred. The allow-list is
               deployment configuration: Stripe has no "anywhere" value, and a
               list widened to whatever a client typed would be no list. */
            billing_address_collection: "required",
            /* Collected ONLY when the basket needs delivering. An all-digital
               purchase is never asked for an address: demanding one for a
               download is friction with no purpose, and it teaches buyers that
               Monacado asks for data it does not need. */
            ...(request.collectShippingAddress
              ? {
                  shipping_address_collection: {
                    allowed_countries:
                      config.shippingCountries as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[],
                  },
                }
              : {}),
            metadata: { [ORDER_METADATA_KEY]: request.orderId },
            /* Repeated on the PaymentIntent so an event about the intent is
               attributable without a second lookup. */
            payment_intent_data: { metadata: { [ORDER_METADATA_KEY]: request.orderId } },
          },
          /* 0M.9's key, unchanged: a repeat of this call returns the SAME
             session rather than starting a second payment for one Order. */
          { idempotencyKey: request.idempotencyKey },
        );
      } catch (error) {
        throw new StripePaymentInitiationError(error);
      }

      if (session.url === null) throw new StripePaymentInitiationError();

      return BuyerPaymentInitiation.parse({
        orderId: request.orderId,
        provider: request.provider,
        status: "REQUIRES_BUYER_ACTION",
        providerPaymentRef: session.id,
        buyerActionUrl: session.url,
      });
    },
  };
}

// — Confirmation —

/**
 * The event types this phase acts on, and the reason each is here.
 *
 * A short, closed list rather than a dispatch framework. Everything else that
 * verifies is acknowledged and ignored — a provider sends many kinds of
 * notification, and having an opinion about all of them is how a webhook endpoint
 * becomes an event bus nobody designed.
 */
export const HANDLED_EVENT_TYPES: readonly string[] = [
  /** The buyer completed the hosted session. Paid, for an immediate method. */
  "checkout.session.completed",
  /** A delayed-notification method later cleared. */
  "checkout.session.async_payment_succeeded",
  /** A delayed-notification method later failed, definitively. */
  "checkout.session.async_payment_failed",
  /**
   * The hosted session passed its expiry and can no longer be completed
   * (Phase 1.1).
   *
   * **Stripe's own authoritative statement**, which is why no timer, sweeper, or
   * scheduled job exists on Monacado's side. Only Stripe knows whether that
   * session is still payable; a Monacado clock guessing at it would eventually
   * cancel an Order a buyer was midway through paying.
   */
  "checkout.session.expired",
];

/**
 * Read Stripe's own classification of why a delayed payment failed.
 *
 * One extra read, and a best-effort one: the failure is being recorded either
 * way, so a Stripe outage during classification must degrade the *detail* rather
 * than lose the *fact*. `UNSPECIFIED_FAILURE` is the honest answer when Stripe
 * will not say.
 */
async function classifyFailure(
  client: Stripe,
  paymentIntentId: string | null,
): Promise<PaymentFailureCode> {
  if (paymentIntentId === null) return "UNSPECIFIED_FAILURE";
  try {
    const intent = await client.paymentIntents.retrieve(paymentIntentId);
    const error = intent.last_payment_error;
    return toPaymentFailureCodeFromDecline(error?.code, error?.decline_code);
  } catch {
    return "UNSPECIFIED_FAILURE";
  }
}

/**
 * Verify one Stripe delivery and translate it, or refuse.
 *
 * **Verification happens first, over the raw bytes.** The body is never parsed
 * before `constructEventAsync` has authenticated it, because a signature is
 * computed over bytes and parsing first would authenticate something other than
 * what arrived.
 *
 * `observedAt` is injected rather than read from a clock here, so the instant a
 * sale is recorded at is the caller's decision and a test can state it.
 */
export function createStripeBuyerPaymentConfirmationPort(
  args: { observedAt: string },
  deps: StripeAdapterDeps = {},
): BuyerPaymentConfirmationPort {
  return {
    async confirmPayment(rawNotification) {
      const notification = ProviderNotification.parse(rawNotification);
      const { config, client } = resolveRuntime(deps);

      if (notification.signatureHeader === null) throw new StripeWebhookVerificationError();

      let event: Stripe.Event;
      try {
        event = await client.webhooks.constructEventAsync(
          notification.rawBody,
          notification.signatureHeader,
          resolveStripeWebhookSecret(config, deps.env),
        );
      } catch {
        /* Deliberately swallowed and replaced. Stripe's message distinguishes a
           malformed header from a stale timestamp from a wrong secret, and an
           endpoint that reports which is an oracle for forging one. */
        throw new StripeWebhookVerificationError();
      }

      if (!HANDLED_EVENT_TYPES.includes(event.type)) return null;

      const session = event.data.object as Stripe.Checkout.Session;
      const orderId = orderIdFromMetadata(session.metadata);
      if (orderId === null) throw new StripeEventNotAttributableError(event.type);
      const intentRef = paymentIntentRef(session.payment_intent);
      const buyerContact = buyerContactFrom(session);
      const confirmedDetails = confirmedDetailsFrom(session);

      /* The session is over and unpayable. Not a failure — nobody declined
         anything — so it carries no result and no failure code, and it reaches
         `cancelOrder` rather than the payment-failure path. */
      if (event.type === "checkout.session.expired") {
        return BuyerPaymentConfirmation.parse({
          disposition: "ABANDONED",
          orderId,
          provider: "STRIPE",
          buyerContact,
          confirmedDetails,
          providerEventRef: event.id,
          observedAt: args.observedAt,
        });
      }

      if (event.type === "checkout.session.async_payment_failed") {
        return BuyerPaymentConfirmation.parse({
          disposition: "PAYMENT_RESULT",
          orderId,
          provider: "STRIPE",
          buyerContact,
          confirmedDetails,
          result: { outcome: "FAILED", failureCode: await classifyFailure(client, intentRef) },
          providerEventRef: event.id,
          observedAt: args.observedAt,
        });
      }

      /* A completed session whose funds have not arrived is not a sale. A
         delayed-notification method leaves `payment_status` unpaid here and
         resolves later through its own event; treating this as success would
         book a sale on a payment that may still fail. */
      if (session.payment_status !== "paid") return null;

      if (intentRef === null) throw new StripeEventNotAttributableError(event.type);

      return BuyerPaymentConfirmation.parse({
        disposition: "PAYMENT_RESULT",
        orderId,
        provider: "STRIPE",
        buyerContact,
        confirmedDetails,
        /* The PaymentIntent id, not the session id: it is the reference that
           identifies the captured transaction, and the one `0M.T1`'s settlement
           row exists to reconcile against. */
        result: { outcome: "SUCCEEDED", provider: "STRIPE", providerTransactionRef: intentRef },
        providerEventRef: event.id,
        observedAt: args.observedAt,
      });
    },
  };
}
