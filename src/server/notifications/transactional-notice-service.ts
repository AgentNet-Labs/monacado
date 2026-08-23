/**
 * Buyer and participant transactional notices (Phase 1.1) — SERVER ONLY.
 *
 * The layer that turns **authoritative application state** into messages. Three
 * triggers, each fired from the one place the corresponding fact becomes true:
 *
 * | Trigger | Audience | Category |
 * | --- | --- | --- |
 * | a sale completed | buyer, seller, any promoter | `ORDER_CONFIRMATION` / `SALE_RECORDED` |
 * | an authoritative payment failure | buyer | `PAYMENT_FAILED` |
 * | the hosted session expired | buyer | `ORDER_CANCELLED` |
 *
 * ## Phase 1.5: it commits, it no longer sends
 *
 * These functions **enqueue durable `OutboundEmailDelivery` rows** and return.
 * Sending is the dispatcher's, and the two are deliberately separated: `1.1`
 * sent inline and at-most-once, so a provider outage during a webhook lost a
 * buyer's receipt permanently and silently — the pre-live gate `1.1` recorded
 * against itself. A commitment survives the outage; an inline send did not.
 *
 * The renderers below are unchanged and are now called by the dispatcher's
 * resolver, on **every attempt**, from the authoritative Order. That is what lets
 * a delivery row store a source reference instead of a rendered body.
 *
 * ## It consumes facts; it does not become the authority
 *
 * Every message is assembled from an `OrderRecord` and, for participants, an
 * existing `0M.N1` obligation. **Nothing here writes a `NotificationObligation`,
 * changes one, or reads one to decide whether a notice is owed** — `0M.9`'s
 * atomic sale write already recorded the seller and promoter obligations inside
 * the same transaction as the sale, and §3a is explicit that a supplemental
 * channel can never replace the canonical one.
 *
 * ## Where an address comes from
 *
 * | Recipient | Source | Why not something else |
 * | --- | --- | --- |
 * | buyer (guest **or** account) | the contact the provider collected at checkout | `NEVER_ON_ORDER` forbids a buyer address column, and `0M.9` meant it |
 * | seller / promoter | the participant's `Account.email` | already Monacado's, already authoritative, and no new storage |
 *
 * **No participant is fabricated for a guest.** A guest buyer has no
 * participant, gets no obligation row, and still gets their receipt — which is
 * exactly the gap `0M.9` recorded as "buyer-facing notice for guests needs an
 * addressing model that does not exist yet". This is that addressing model, and
 * it is the smallest one that works: the address travels transiently on the
 * confirmation and is digested at the delivery boundary.
 *
 * ## Rendering
 *
 * Bounded, plain text, assembled from named domain fields. There is no template
 * engine, no partial, no locale, and no caller-supplied string — a body that
 * could be passed in would be a body an attacker could pass in.
 *
 * **No message contains** the seller's proceeds, the promoter's spread,
 * Monacado's retention, a policy id, a provider transaction reference, a claim
 * code, or a Listing source version. A buyer's receipt says what they were
 * charged; a seller's says a sale happened and to go and look. Everything else is
 * a marketplace's private commercial position or a bearer credential.
 */

import "../server-only";
import type { OrderRecord } from "../../contracts/marketplace/order";
import { quotedBuyerTotalMinorUnits } from "../../contracts/marketplace/order";
import type { NotificationCategory } from "../../contracts/marketplace/notification-obligation";
import type { OutboundEmailDeliveryRecord } from "../../contracts/marketplace/outbound-email";
import { getPrisma } from "../db/client";
import {
  enqueueEmailDelivery,
  type OutboundEmailDeps,
} from "./outbound-email-service";

type Db = ReturnType<typeof getPrisma>;

export interface NoticeDeps extends OutboundEmailDeps {
  db?: Db;
}

/**
 * What one trigger committed to.
 *
 * There is no `skippedForNoAddress` any more, and its absence is the improvement:
 * a recipient whose address cannot be resolved is no longer silently skipped at
 * commit time. The commitment is made, the dispatcher resolves the address on
 * every attempt, and an unresolvable one is recorded as
 * `RECIPIENT_UNRESOLVABLE` against a row an operator can find.
 */
export interface EnqueuedNotices {
  deliveries: OutboundEmailDeliveryRecord[];
}

// — Rendering —

/** Minor units to a readable amount. Display only; no arithmetic decision. */
function formatAmount(minorUnits: number, currency: string): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(minorUnits / 100);
}

/**
 * The buyer's receipt.
 *
 * Says what they bought (by order reference), what they were charged, and where
 * to look. It deliberately names **no participant, no product title, and no
 * economics** — the buyer already knows what they ordered, and the rest is either
 * private to the marketplace or absent from the Order by design.
 */
export function renderBuyerConfirmation(order: OrderRecord): { subject: string; body: string } {
  const total = formatAmount(quotedBuyerTotalMinorUnits(order.quote), order.quote.currency);
  return {
    subject: `Your Monacado order is confirmed — ${total}`,
    body: [
      "Thank you for your order.",
      "",
      `Order reference: ${order.orderId}`,
      `Total charged:   ${total}`,
      "",
      "Your payment has been confirmed and your order is complete.",
      "",
      "You can view this order at any time using the reference above.",
      "",
      "— Monacado",
    ].join("\n"),
  };
}

/**
 * The buyer's failure notice.
 *
 * Carries Monacado's **bounded** classification and no provider text — the same
 * rule `0M.9` applies to the column it reads from. It states plainly that no
 * money was taken, because the single most common worry after a failed payment is
 * whether it was taken anyway.
 */
export function renderBuyerPaymentFailed(order: OrderRecord): { subject: string; body: string } {
  const total = formatAmount(quotedBuyerTotalMinorUnits(order.quote), order.quote.currency);
  return {
    subject: "Your Monacado payment did not go through",
    body: [
      "We were not able to take payment for your order.",
      "",
      `Order reference: ${order.orderId}`,
      `Amount:          ${total}`,
      `Reason:          ${order.paymentFailureCode ?? "UNSPECIFIED_FAILURE"}`,
      "",
      "No payment was taken and this order was not completed.",
      "To try again, start a new checkout — each attempt is a separate order.",
      "",
      "— Monacado",
    ].join("\n"),
  };
}

/**
 * The buyer's expiry notice.
 *
 * Not a failure: nobody declined anything. It says the checkout window closed and
 * nothing was charged, which is the only two facts a buyer needs.
 */
export function renderBuyerOrderExpired(order: OrderRecord): { subject: string; body: string } {
  const total = formatAmount(quotedBuyerTotalMinorUnits(order.quote), order.quote.currency);
  return {
    subject: "Your Monacado checkout expired",
    body: [
      "Your checkout session expired before payment was completed.",
      "",
      `Order reference: ${order.orderId}`,
      `Amount:          ${total}`,
      "",
      "No payment was taken and this order has been cancelled.",
      "You are welcome to start a new checkout at any time.",
      "",
      "— Monacado",
    ].join("\n"),
  };
}

/**
 * A participant's sale notice — supplemental to the admin-panel obligation.
 *
 * Deliberately thin: it says a sale was recorded and points at the panel. It
 * carries **no proceeds figure**, because what a party earned is on the `0M.T1`
 * snapshot behind an authenticated view, and putting it in an email would publish
 * a commercial position to whoever holds a mailbox.
 */
export function renderParticipantSaleRecorded(order: OrderRecord): {
  subject: string;
  body: string;
} {
  return {
    subject: "A sale was recorded on Monacado",
    body: [
      "A sale has been recorded against your Monacado account.",
      "",
      `Order reference: ${order.orderId}`,
      "",
      "Full details, including what you are owed, are in your Monacado admin panel.",
      "This email is a notification only; the admin panel is the record.",
      "",
      "— Monacado",
    ].join("\n"),
  };
}

// — Obligation linkage —

/**
 * The `0M.N1` obligation this delivery accompanies, if one was written.
 *
 * Looked up so the delivery can point at it; **never created, and never
 * modified**. A missing obligation does not stop the commitment — it only means
 * the delivery stands alone, which is the ordinary case for a buyer.
 */
async function obligationIdFor(
  db: Db,
  args: { recipientParticipantId: string; category: NotificationCategory; orderId: string },
): Promise<string | null> {
  const row = await db.notificationObligation.findFirst({
    where: {
      recipientParticipantId: args.recipientParticipantId,
      category: args.category,
      subjectKind: "ORDER",
      subjectRef: args.orderId,
    },
    select: { id: true },
  });
  return row?.id ?? null;
}

// — Triggers —

/**
 * A sale completed: commit to telling the buyer, the seller, and any promoter.
 *
 * The buyer is committed first and is the priority: they are the only party with
 * no other way to learn the outcome, since a guest has no account, no panel, and
 * no participant.
 *
 * **No address is resolved here.** `1.1` looked one up at this moment and skipped
 * the recipient when it found none; the dispatcher now resolves it on every
 * attempt from the durable `OrderBuyerSnapshot`, so a receipt is owed from the
 * instant the sale is booked rather than from the instant an address happened to
 * be readable.
 */
export async function enqueueSaleNotices(
  args: { order: OrderRecord; at: string },
  deps: NoticeDeps = {},
): Promise<EnqueuedNotices> {
  const db = deps.db ?? getPrisma();
  const deliveries: OutboundEmailDeliveryRecord[] = [];

  const buyer = await enqueueEmailDelivery(
    {
      purpose: "ORDER_CONFIRMATION",
      audience: "BUYER",
      /* A guest has no participant and one is NOT invented for them. An account
         buyer may hold one, but the notice is to them as a BUYER, so it is keyed
         the same way — otherwise the same person buying twice, once before and
         once after claiming a participant, would dedupe inconsistently. */
      recipientParticipantId: null,
      obligationId: null,
      subjectKind: "ORDER",
      subjectRef: args.order.orderId,
      discriminator: null,
      now: args.at,
    },
    deps,
  );
  deliveries.push(buyer.delivery);

  const participants: Array<{ id: string; audience: "SELLER" | "PROMOTER" }> = [
    { id: args.order.sellerParticipantId, audience: "SELLER" },
  ];
  if (args.order.promoterParticipantId !== null) {
    participants.push({ id: args.order.promoterParticipantId, audience: "PROMOTER" });
  }

  for (const participant of participants) {
    const enqueued = await enqueueEmailDelivery(
      {
        purpose: "SALE_RECORDED",
        audience: participant.audience,
        recipientParticipantId: participant.id,
        /* Points at the canonical obligation 0M.9 already wrote. Supplemental:
           this row never changes that obligation's status, and five attempts at
           it leave the obligation exactly as owed as one did. */
        obligationId: await obligationIdFor(db, {
          recipientParticipantId: participant.id,
          category: "SALE_RECORDED",
          orderId: args.order.orderId,
        }),
        subjectKind: "ORDER",
        subjectRef: args.order.orderId,
        discriminator: null,
        now: args.at,
      },
      deps,
    );
    deliveries.push(enqueued.delivery);
  }

  return { deliveries };
}

/**
 * An authoritative payment failure: commit to telling the buyer.
 *
 * Only the buyer. A seller has no sale to hear about, and telling them about
 * every failed attempt on their Listing would be telling them about traffic, not
 * commerce.
 */
export async function enqueuePaymentFailedNotice(
  args: { order: OrderRecord; at: string },
  deps: NoticeDeps = {},
): Promise<EnqueuedNotices> {
  const enqueued = await enqueueEmailDelivery(
    {
      purpose: "PAYMENT_FAILED",
      audience: "BUYER",
      recipientParticipantId: null,
      obligationId: null,
      subjectKind: "ORDER",
      subjectRef: args.order.orderId,
      discriminator: null,
      now: args.at,
    },
    deps,
  );
  return { deliveries: [enqueued.delivery] };
}

/**
 * The checkout expired: commit to telling the buyer.
 *
 * Categorised `ORDER_CANCELLED` — reusing `PAYMENT_FAILED` would have been wrong,
 * not merely loose: it asserts that a provider reported a failure, and nobody
 * declined an expired checkout.
 */
export async function enqueueOrderExpiredNotice(
  args: { order: OrderRecord; at: string },
  deps: NoticeDeps = {},
): Promise<EnqueuedNotices> {
  const enqueued = await enqueueEmailDelivery(
    {
      purpose: "ORDER_CANCELLED",
      audience: "BUYER",
      recipientParticipantId: null,
      obligationId: null,
      subjectKind: "ORDER",
      subjectRef: args.order.orderId,
      discriminator: null,
      now: args.at,
    },
    deps,
  );
  return { deliveries: [enqueued.delivery] };
}
