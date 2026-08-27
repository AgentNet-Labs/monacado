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
 * Monacado's retention, a commercial policy id, a provider transaction reference,
 * a claim code, or a Listing source version. A seller's notice says a sale
 * happened and to go and look. Everything else is a marketplace's private
 * commercial position or a bearer credential.
 *
 * ## Phase 1.10: the buyer's receipt carries the terms it was sold under
 *
 * One exception was added, and only one: the buyer's confirmation now names the
 * **seller refund policy version** bound to the purchase and renders that policy
 * in full. That is not a marketplace commercial position — it is the buyer's own
 * disclosed terms, shown to them before they paid, and the receipt is the only
 * artifact they hold that can tell them which version applied. Monacado's
 * commercial policy id, the participants, and every party's economics stay out.
 */

import "../server-only";
import type { OrderRecord } from "../../contracts/marketplace/order";
import { quotedBuyerTotalMinorUnits } from "../../contracts/marketplace/order";
import type { OrderReceiptView } from "../../contracts/marketplace/order-receipt";
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
 * What this rendering of the receipt carries, and what it leaves to a richer one.
 *
 * The **read contract** (`OrderReceiptView`) answers everything a receipt can
 * state. This is one rendering of it — plain text, in an email — and the split is
 * a decision rather than an accident:
 *
 * | Carried here | Left to `OrderReceiptView` |
 * | --- | --- |
 * | the complete seller refund policy that governed the purchase | the marketplace policy's own refund sections, in full |
 * | the exact seller policy version reference | the bound marketplace version's content hash |
 * | the procedure and the contact disclosed at purchase | the purchased line's internal references |
 * | the monetary summary, shipping, and tax | |
 *
 * The seller's policy is inlined because it is the buyer's **operative terms**
 * and §4 requires the complete applicable policy on the receipt. The marketplace
 * document's refund sections are referenced by the version that governed the sale
 * rather than inlined: they were disclosed at checkout, they are identical for
 * every purchase made under that version, and twenty paragraphs of marketplace
 * governance in front of the seller's actual terms would bury the half the buyer
 * needs to act on.
 */
export const RECEIPT_EMAIL_RENDERING = {
  sellerRefundPolicy: "COMPLETE",
  sellerPolicyVersionReference: "INCLUDED",
  refundProcedure: "INCLUDED",
  purchaseTimeSupportContact: "INCLUDED",
  currentSellerSupportContact: "INCLUDED_SEPARATELY_WHEN_IT_DIFFERS",
  monetarySummary: "INCLUDED",
  marketplacePolicyRefundSections: "REFERENCED_BY_BOUND_VERSION",
  promoterIdentity: "NEVER",
  partyEconomics: "NEVER",
  internalReferences: "NEVER",
} as const;

/** One "Label: value" line, padded so a plain-text receipt reads as a column. */
const row = (label: string, value: string): string => `${`${label}:`.padEnd(17)}${value}`;

/**
 * The buyer's receipt.
 *
 * ## Phase 1.10: it states the terms the purchase was sold under
 *
 * `1.1` rendered the order reference and the total, on the reasoning that the
 * buyer already knows what they ordered. That reasoning holds for the *product*
 * and fails for the *terms*: a buyer cannot know, from memory, which version of a
 * seller's refund policy was bound to their purchase, and the receipt is the only
 * artifact they hold that can tell them. So when a receipt view is supplied, the
 * message carries the complete governing policy, the exact version reference, how
 * to request a refund, and the support contact **as it was disclosed to them**.
 *
 * Everything historical comes from the view, which reads it from evidence bound
 * to the sale. Nothing here reaches for a seller's current configuration, and the
 * one current value the view does carry is printed under its own heading and only
 * when it differs from the disclosed one.
 *
 * ## Without a view it renders exactly as it did
 *
 * `receipt` is optional and a missing one is not an error. A receipt that could
 * not be assembled — an Order whose bound policy has become unreadable — still
 * produces the message a buyer needs most, which is confirmation that their money
 * was taken and what for. A dispatcher that threw instead would withhold the
 * whole receipt over the part of it that failed.
 *
 * It still names **no participant, no promoter, no product title, and no
 * economics**: `1.1`'s line, unmoved. What was added is the buyer's own terms,
 * which were disclosed to them before they paid.
 */
export function renderBuyerConfirmation(
  order: OrderRecord,
  receipt?: OrderReceiptView | null,
): { subject: string; body: string } {
  const total = formatAmount(quotedBuyerTotalMinorUnits(order.quote), order.quote.currency);
  const money = receipt?.money ?? null;
  const currency = order.quote.currency;

  const lines: string[] = [
    "Thank you for your order.",
    "",
    row("Order reference", order.orderId),
  ];

  if (money !== null) {
    lines.push(row("Merchandise", formatAmount(money.merchandiseMinorUnits, money.currency)));
    if (money.shippingMinorUnits !== 0) {
      lines.push(row("Shipping", formatAmount(money.shippingMinorUnits, money.currency)));
    }
    /* Tax is stated even at zero. "Tax: $0.00" is a disclosure; silence is
       ambiguous between "none was charged" and "we did not say". */
    lines.push(row("Tax", formatAmount(money.taxMinorUnits, money.currency)));
    if (money.otherPassThroughMinorUnits !== 0) {
      lines.push(
        row("Other charges", formatAmount(money.otherPassThroughMinorUnits, money.currency)),
      );
    }
  }
  lines.push(row("Total charged", total));
  lines.push("", "Your payment has been confirmed and your order is complete.");

  const refundBlock = receipt === undefined || receipt === null ? [] : renderRefundBlock(receipt);
  if (refundBlock.length > 0) lines.push("", ...refundBlock);

  lines.push("", "You can view this order at any time using the reference above.", "", "— Monacado");

  return {
    subject: `Your Monacado order is confirmed — ${formatAmount(
      money?.totalMinorUnits ?? quotedBuyerTotalMinorUnits(order.quote),
      money?.currency ?? currency,
    )}`,
    body: lines.join("\n"),
  };
}

/**
 * The refund half of the receipt, from purchase-time evidence only.
 *
 * Returns `[]` where no policy is bound — an Order placed before the binding
 * existed, or one whose bound version has become unreadable. **Nothing is
 * substituted in that case**, which is the whole rule: a section headed "your
 * refund rights" filled in from today's terms would look authoritative and be
 * wrong, and an absent section is the honest form of "we cannot reproduce what
 * you were shown".
 */
function renderRefundBlock(receipt: OrderReceiptView): string[] {
  const { refund } = receipt;
  if (refund.policyRef === null || refund.policyVersion === null) return [];

  const out: string[] = [
    "REFUNDS",
    "",
    "These are the refund terms that applied to this purchase. They are the terms",
    "disclosed to you when you bought, and they do not change if the seller",
    "publishes different ones later.",
    "",
    row("Refund policy", `${refund.policyRef.policyId} version ${refund.policyRef.policyVersion}`),
  ];

  if (receipt.marketplacePolicy !== null) {
    out.push(
      row("Marketplace terms", `version ${receipt.marketplacePolicy.policyVersion}`),
    );
  }
  if (receipt.shipping.refundability !== null) {
    out.push(row("Shipping charges", SHIPPING_TREATMENT[receipt.shipping.refundability]));
  }

  /* THE COMPLETE POLICY. A summary would be a claim the terms might not support,
     and a buyer who cannot read them in full has not been given them. */
  for (const section of refund.policyVersion.document.sections) {
    out.push("", section.heading, section.body);
  }

  const procedure = refund.procedure;
  if (procedure !== null) {
    out.push("", "How to request a refund", procedure.instructions);
    if (procedure.purchaseTimeRefundContact !== null) {
      out.push(
        row("Contact", procedure.purchaseTimeRefundContact.address),
        "(this is the support contact that was in effect when you bought)",
      );
    }
    /* Beside the disclosed one, never instead of it, and only when it is
       actually different — printing the same address twice under two headings
       would suggest a distinction that is not there. */
    if (
      refund.currentSellerSupportContact !== null &&
      refund.currentSellerSupportContact !== procedure.purchaseTimeRefundContact?.address
    ) {
      out.push(
        row("Current contact", refund.currentSellerSupportContact),
        "(the seller's support contact today, shown in addition to the one above)",
      );
    }
    out.push(
      "",
      "You do not need a Monacado account to request a refund. Quote the order",
      "reference above together with this confirmation.",
    );
  }

  return out;
}

/** The declared shipping rule, in the buyer's words rather than the enum's. */
const SHIPPING_TREATMENT = {
  ALWAYS_REFUNDED: "refunded with the item under this policy",
  NEVER_REFUNDED: "not refunded under this policy",
  REFUNDED_WHEN_SELLER_AT_FAULT: "refunded where the refund is attributable to the seller",
} as const;

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

/**
 * The buyer's refund notice (Phase 1.9).
 *
 * Says the one thing they want to know — their money is coming back, and how
 * much — and nothing about the marketplace's internals. It deliberately names
 * **no reason code**: Monacado's governed classification of why a refund happened
 * is an internal accounting fact, and a buyer told their refund was categorised
 * `FRAUD_OR_RISK` has been accused of something in a receipt.
 *
 * It also says nothing about tax reversal. Whether Monacado has finished
 * un-reporting the sale to a tax provider is none of the buyer's business, and
 * holding this message until it had would withhold the fact they actually want.
 */
export function renderBuyerRefundCompleted(
  order: OrderRecord,
  refund: { amountMinorUnits: number; currency: string },
): { subject: string; body: string } {
  const total = formatAmount(refund.amountMinorUnits, refund.currency);
  return {
    subject: `Your Monacado order has been refunded — ${total}`,
    body: [
      "Your order has been refunded in full.",
      "",
      `Order reference: ${order.orderId}`,
      `Amount refunded: ${total}`,
      "",
      "The refund has been issued to your original payment method. How long it",
      "takes to appear depends on your bank or card issuer.",
      "",
      "— Monacado",
    ].join("\n"),
  };
}

/**
 * The seller's or promoter's refund notice (Phase 1.9).
 *
 * A different message to a different party about the same event. It states the
 * consequence that matters to them — a sale they were credited for has been
 * undone — and, like the sale notice, names **no economics**: what they earned
 * and are no longer owed is on records they can read, and a figure in an email is
 * a figure that can go stale.
 *
 * It says nothing about recovery either. Whether Monacado will seek money back
 * from an already-paid proceeds claim is a governed settlement decision nobody
 * has taken, and an email implying one would be making it.
 */
export function renderParticipantRefundRecorded(order: OrderRecord): {
  subject: string;
  body: string;
} {
  return {
    subject: "A Monacado sale has been refunded",
    body: [
      "A sale recorded to your account has been refunded to the buyer.",
      "",
      `Order reference: ${order.orderId}`,
      "",
      "Proceeds for this sale are no longer eligible for payout. You can review",
      "the sale and its current standing in your Monacado account.",
      "",
      "— Monacado",
    ].join("\n"),
  };
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
