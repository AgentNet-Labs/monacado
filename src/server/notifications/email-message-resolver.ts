/**
 * Re-rendering an outbound message from authoritative state (Phase 1.5) —
 * SERVER ONLY.
 *
 * **The reason no body is stored.** A delivery row holds a source reference, and
 * every attempt comes back here to resolve the recipient and rebuild the message
 * from the record that is authoritative *now*. Three things follow from that, and
 * all three were the point:
 *
 *   1. A retry states what is true today, not what was true when the first
 *      attempt failed four hours ago.
 *   2. The delivery table never becomes a mail archive holding every buyer
 *      address, every amount, and every rendered receipt.
 *   3. **A verification link can be retried without the plaintext token ever
 *      being written down** — see below, because that is the load-bearing one.
 *
 * ## Verification retry, and the token model that is not weakened to permit it
 *
 * `1.3`'s token is returned once and only its SHA-256 digest is stored, so a
 * retry cannot resend the first link — there is nothing to resend from. The
 * obvious workarounds are all worse: storing the plaintext makes a table read a
 * set of working takeovers, and storing it encrypted makes it a key plus a table
 * read.
 *
 * So a retry does not resend the old link. It **mints a fresh challenge**, which
 * supersedes the previous one exactly as `1.3` already specified for reissue.
 * Nothing is weakened: the token is still 256 bits, still opaque, still
 * digest-only, still 24h, still single-use, and still supersedes its predecessor.
 * The superseded token was never delivered — that is *why* there is a retry — so
 * nothing usable is invalidated.
 *
 * The one visible consequence, recorded rather than hidden: if an attempt is
 * ambiguous (the provider accepted it but Monacado recorded a timeout), the
 * recipient may hold a link that the next attempt supersedes. They receive a
 * second message whose link works, which is the standard behaviour of every
 * verification email anybody has used, and strictly better than the `1.4`
 * alternative of no second message at all.
 *
 * ## Where a destination comes from
 *
 * | Recipient | Source | Why not something else |
 * | --- | --- | --- |
 * | buyer, guest **or** account | the durable `OrderBuyerSnapshot` | `NEVER_ON_ORDER` forbids a buyer address column, and `0M.9` meant it. **No Account or Participant is fabricated for a guest** |
 * | seller / promoter | the participant's `Account.email` | already Monacado's, already authoritative, and no new storage |
 * | email verification | the contact row, or `Account.email` for a primary contact | `0M.5`: the primary address lives on `Account` and a second copy would be a second thing to leak |
 */

import "../server-only";
import type { DeliveryFailureCode } from "../../contracts/marketplace/notification-delivery";
import type {
  OutboundEmailDeliveryRecord,
} from "../../contracts/marketplace/outbound-email";
import { getPrisma } from "../db/client";
import type { OrderReceiptView } from "../../contracts/marketplace/order-receipt";
import { getOrder } from "../marketplace/order-service";
import { getBuyerSnapshotIn } from "../marketplace/order-buyer-snapshot-service";
import { readOrderReceipt } from "../marketplace/order-receipt-service";
import { issueVerificationChallenge } from "../policy/email-verification-service";
import { renderVerificationMessage } from "../policy/verification-notice-service";
import {
  buildVerificationUrl,
  readVerificationLinkOrigin,
} from "../policy/verification-link";
import type { PolicyIdProvider } from "../policy/policy-ids";
import {
  renderBuyerConfirmation,
  renderBuyerOrderExpired,
  renderBuyerPaymentFailed,
  renderBuyerRefundCompleted,
  renderParticipantRefundRecorded,
  renderParticipantDisputeRecorded,
  renderParticipantSaleRecorded,
} from "./transactional-notice-service";

type Db = ReturnType<typeof getPrisma>;
export type Env = Record<string, string | undefined>;

export interface MessageResolverDeps {
  db?: Db;
  env?: Env;
  /** Injected so a test asserts a link without setting a global variable. */
  origin?: string;
  /** Injected so a test can produce deterministic challenge ids. */
  policyIds?: PolicyIdProvider;
  /** Injected so a test can assert the digest of a known verification token. */
  tokens?: { nextVerificationToken(): string };
}

/**
 * A message ready to hand to the port, or a bounded reason it cannot be built.
 *
 * A failure here is **not an exception**. "This Order has no buyer snapshot" is an
 * ordinary, explicable state the dispatcher must record and classify, not
 * something to throw out of a worker loop mid-batch.
 */
export type ResolvedMessage =
  | { resolved: true; destination: string; subject: string; text: string }
  | { resolved: false; failureCode: DeliveryFailureCode };

const unresolvable = (
  failureCode: DeliveryFailureCode,
): ResolvedMessage => ({ resolved: false, failureCode });

/**
 * Build the message this delivery commits to sending, as of right now.
 *
 * `at` is the dispatcher's instant and is used for anything the message dates —
 * currently only the verification challenge's issue time, so a link retried
 * tomorrow expires 24 hours after *that* attempt rather than 24 hours after a
 * commitment nobody could act on.
 */
export async function resolveOutboundMessage(
  delivery: OutboundEmailDeliveryRecord,
  at: string,
  deps: MessageResolverDeps = {},
): Promise<ResolvedMessage> {
  const db = deps.db ?? getPrisma();

  if (delivery.subjectKind === "EMAIL_CONTACT") {
    return resolveVerificationMessage(db, delivery, at, deps);
  }
  return resolveOrderMessage(db, delivery, at, deps);
}

// — Orders —

async function resolveOrderMessage(
  db: Db,
  delivery: OutboundEmailDeliveryRecord,
  at: string,
  deps: MessageResolverDeps,
): Promise<ResolvedMessage> {
  let order;
  try {
    order = await getOrder(delivery.subjectRef, { db });
  } catch {
    /* The Order is gone or unreadable. No number of retries conjures one. */
    return unresolvable("RECIPIENT_UNRESOLVABLE");
  }

  /* Participant mail. The address is the account's, which is already Monacado's
     and already authoritative — `1.5`'s rule, and no new storage. */
  if (
    delivery.purpose === "SALE_RECORDED" ||
    delivery.purpose === "REFUND_RECORDED" ||
    delivery.purpose === "DISPUTE_RECORDED"
  ) {
    if (delivery.recipientParticipantId === null) return unresolvable("RECIPIENT_UNRESOLVABLE");
    const participant = await db.marketplaceParticipant.findUnique({
      where: { id: delivery.recipientParticipantId },
      select: { account: { select: { email: true } } },
    });
    const address = participant?.account?.email ?? null;
    if (address === null) return unresolvable("RECIPIENT_UNRESOLVABLE");
    const { subject, body } =
      delivery.purpose === "SALE_RECORDED"
        ? renderParticipantSaleRecorded(order)
        : delivery.purpose === "REFUND_RECORDED"
          ? renderParticipantRefundRecorded(order)
          : renderParticipantDisputeRecorded(order);
    return { resolved: true, destination: address, subject, text: body };
  }

  /* Buyer mail. The address comes from the durable snapshot `1.2` added, which
     is what retired `1.1`'s recorded gate about guest addresses being
     irrecoverable from a digest. Nothing is fabricated for a guest: a buyer
     with no snapshot simply has no address, and that is recorded as such. */
  const snapshot = await getBuyerSnapshotIn(db, delivery.subjectRef);
  const address = snapshot?.email ?? null;
  if (address === null) return unresolvable("RECIPIENT_UNRESOLVABLE");

  /* A refund notice states the amount from the REFUND ROW, not from the Order's
     quote. They are equal today — a full refund returns the buyer's whole charge
     — but they are different facts, and rendering the quote would be rendering
     what was charged while claiming it is what came back. A refund row that has
     gone missing is `RECIPIENT_UNRESOLVABLE` rather than a message asserting an
     amount nobody can point at. */
  if (delivery.purpose === "REFUND_COMPLETED") {
    const refund = await db.orderRefund.findUnique({
      where: { orderId: delivery.subjectRef },
      select: { amountMinorUnits: true, currency: true },
    });
    if (refund === null) return unresolvable("RECIPIENT_UNRESOLVABLE");
    const { subject, body } = renderBuyerRefundCompleted(order, {
      amountMinorUnits: Number(refund.amountMinorUnits),
      currency: refund.currency,
    });
    return { resolved: true, destination: address, subject, text: body };
  }

  if (delivery.purpose === "ORDER_CONFIRMATION") {
    /* The receipt is assembled from evidence bound to the sale, so a retry three
       days later renders the terms the buyer was shown rather than the terms the
       seller has published since. A view that cannot be assembled is `null` and
       the confirmation still goes out — withholding a buyer's receipt because
       its refund section failed would deny them the fact they need most. */
    let receipt: OrderReceiptView | null = null;
    try {
      receipt = await readOrderReceipt(delivery.subjectRef, at, { db });
    } catch {
      receipt = null;
    }
    const confirmation = renderBuyerConfirmation(order, receipt);
    return {
      resolved: true,
      destination: address,
      subject: confirmation.subject,
      text: confirmation.body,
    };
  }

  /* EXHAUSTIVE, not a two-branch fallback (hardened at Phase 1.11).
   *
   * This was `purpose === "PAYMENT_FAILED" ? paymentFailed : orderExpired`,
   * which meant every purpose added later silently rendered "your order
   * expired" to a buyer. That is a real hazard rather than a hypothetical one:
   * 1.11 added a purpose, and the wrong message would have gone out with no
   * test failing. An unrecognised purpose is now an honest unresolvable — the
   * dispatcher records it and nobody is told something false. */
  if (delivery.purpose === "PAYMENT_FAILED") {
    const rendered = renderBuyerPaymentFailed(order);
    return { resolved: true, destination: address, subject: rendered.subject, text: rendered.body };
  }
  if (delivery.purpose === "ORDER_CANCELLED") {
    const rendered = renderBuyerOrderExpired(order);
    return { resolved: true, destination: address, subject: rendered.subject, text: rendered.body };
  }
  return unresolvable("RECIPIENT_UNRESOLVABLE");
}

// — Verification —

async function resolveVerificationMessage(
  db: Db,
  delivery: OutboundEmailDeliveryRecord,
  at: string,
  deps: MessageResolverDeps,
): Promise<ResolvedMessage> {
  const contact = await db.participantEmailContact.findUnique({
    where: { id: delivery.subjectRef },
    select: {
      participantId: true,
      purpose: true,
      address: true,
      participant: { select: { account: { select: { email: true } } } },
    },
  });
  if (contact === null) return unresolvable("RECIPIENT_UNRESOLVABLE");

  const address =
    contact.purpose === "DEDICATED_SUPPORT"
      ? contact.address
      : (contact.participant?.account?.email ?? null);
  if (address === null) return unresolvable("RECIPIENT_UNRESOLVABLE");

  let origin: string;
  try {
    origin = deps.origin ?? readVerificationLinkOrigin(deps.env ?? process.env);
  } catch {
    /* No public origin configured. A configuration failure, and transient: an
       operator sets the variable and the next attempt builds a real link. */
    return unresolvable("CHANNEL_NOT_CONFIGURED");
  }

  /* A FRESH challenge, minted now and superseding whatever stood before. This is
     `1.3`'s reissue rule, used as the retry mechanism — see the note at the top
     of this file. The token exists in this scope and nowhere else, and only its
     digest is written. */
  const { challenge, token } = await issueVerificationChallenge(
    {
      participantId: contact.participantId,
      purpose: contact.purpose === "DEDICATED_SUPPORT" ? "DEDICATED_SUPPORT" : "PRIMARY_PROFILE",
      address,
      issuedAt: at,
    },
    {
      db,
      ...(deps.policyIds === undefined ? {} : { ids: deps.policyIds }),
      ...(deps.tokens === undefined ? {} : { tokens: deps.tokens }),
    },
  );

  const { subject, body } = renderVerificationMessage({
    verificationUrl: buildVerificationUrl(origin, token),
    expiresAt: challenge.expiresAt,
  });
  return { resolved: true, destination: address, subject, text: body };
}
