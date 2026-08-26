/**
 * Refund notices (Phase 1.9) — SERVER ONLY.
 *
 * What Monacado commits to telling people when a refund completes, and — equally
 * deliberately — what it does not.
 *
 * ```
 * payment refund REFUNDED
 *   ├─ buyer      REFUND_COMPLETED   the money is coming back
 *   ├─ seller     REFUND_RECORDED    a sale you were credited for was undone
 *   └─ promoter   REFUND_RECORDED    (promoted sales only)
 *
 * tax reversal permanently failed
 *   └─ Monacado operators  OPERATIONAL_ACTION_REQUIRED obligation, no email
 * ```
 *
 * ## Notices are never part of financial integrity
 *
 * Every function here is called **after** the refund's transaction has committed,
 * and the caller swallows every failure. A refund that succeeded and whose
 * receipt could not be queued is a refund that succeeded; the reverse — failing a
 * refund because an email row would not write — would be strictly worse for the
 * buyer, who would then have neither their money nor a message.
 *
 * This is `1.5`'s posture applied to a case where it matters more. An
 * undelivered receipt is recoverable: the delivery row is durable, retried, and
 * visible in the email backlog.
 *
 * ## The buyer's notice fires on the payment refund, not on the whole lifecycle
 *
 * Whether Monacado has finished reversing the sale's tax with a provider is none
 * of the buyer's business, and waiting for it would withhold the one fact they
 * want on the strength of a fact they do not.
 *
 * ## An obligation is not a delivery
 *
 * `NotificationObligation` records what Monacado **owes** a participant;
 * `OutboundEmailDelivery` records what it has **committed to sending**. Both are
 * written for a seller and promoter, and neither changes the other — a message
 * that permanently failed leaves the obligation exactly as owed as it was, which
 * is `0M.N1`'s rule and is unchanged here.
 *
 * The buyer gets a delivery and **no obligation**, on `1.5`'s terms: a guest has
 * no participant, and `NotificationObligation` requires one. Nothing is
 * fabricated for them.
 */

import "../server-only";
import type { NotificationCategory } from "../../contracts/marketplace/notification-obligation";
import type { OutboundEmailDeliveryRecord } from "../../contracts/marketplace/outbound-email";
import { getPrisma } from "../db/client";
import { cryptoParticipantIdProvider } from "../marketplace/participant-ids";
import type { ParticipantIdProvider } from "../marketplace/participant-ids";
import { upsertObligationInTx } from "../marketplace/notification-obligation-service";
import { enqueueEmailDelivery, type OutboundEmailDeps } from "./outbound-email-service";

type Db = ReturnType<typeof getPrisma>;

export interface RefundNoticeDeps extends OutboundEmailDeps {
  db?: Db;
  notificationIds?: ParticipantIdProvider;
}

export interface EnqueuedRefundNotices {
  deliveries: OutboundEmailDeliveryRecord[];
  obligationIds: string[];
}

/** The existing obligation for one participant on one Order, if any. */
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
 * A refund completed: commit to telling the buyer, the seller, and any promoter.
 *
 * Idempotent by construction. Both the obligation key and the delivery key are
 * derived from (recipient, category/purpose, subject), so calling this twice for
 * one Order produces one obligation and one delivery per party — which matters
 * because a retried cycle can legitimately reach this path more than once.
 *
 * **No address is resolved here.** The dispatcher resolves one on every attempt
 * and re-renders the message from authoritative state, which is `1.5`'s design
 * and is what makes a retry state what is true now.
 */
export async function enqueueRefundNotices(
  args: { orderId: string; at: string },
  deps: RefundNoticeDeps = {},
): Promise<EnqueuedRefundNotices> {
  const db = deps.db ?? getPrisma();
  const notificationIds = deps.notificationIds ?? cryptoParticipantIdProvider;

  const order = await db.order.findUnique({
    where: { id: args.orderId },
    select: { id: true, sellerParticipantId: true, promoterParticipantId: true },
  });
  if (order === null) return { deliveries: [], obligationIds: [] };

  const deliveries: OutboundEmailDeliveryRecord[] = [];

  const buyer = await enqueueEmailDelivery(
    {
      purpose: "REFUND_COMPLETED",
      audience: "BUYER",
      /* A guest has no participant and one is NOT invented for them. An account
         buyer may hold one, but the notice is to them as a BUYER, so it is keyed
         the same way — `1.5`'s reasoning, unchanged. */
      recipientParticipantId: null,
      obligationId: null,
      subjectKind: "ORDER",
      subjectRef: args.orderId,
      discriminator: null,
      now: args.at,
    },
    deps,
  );
  deliveries.push(buyer.delivery);

  const participants: Array<{ id: string; audience: "SELLER" | "PROMOTER" }> = [
    { id: order.sellerParticipantId, audience: "SELLER" },
  ];
  if (order.promoterParticipantId !== null) {
    participants.push({ id: order.promoterParticipantId, audience: "PROMOTER" });
  }

  const obligationIds: string[] = [];
  for (const participant of participants) {
    /* The obligation first, in its own transaction: what Monacado OWES a
       participant is a durable fact independent of whether any message about it
       was ever queued. */
    const obligation = await db.$transaction((tx) =>
      upsertObligationInTx(tx, {
        id: notificationIds.nextObligationId(),
        recipientParticipantId: participant.id,
        category: "REFUND_OR_CHARGEBACK",
        subject: { kind: "ORDER", ref: args.orderId, versionRef: null },
        contextCode: null,
        createdAt: args.at,
      }),
    );
    obligationIds.push(obligation.obligationId);

    const enqueued = await enqueueEmailDelivery(
      {
        purpose: "REFUND_RECORDED",
        audience: participant.audience,
        recipientParticipantId: participant.id,
        obligationId: await obligationIdFor(db, {
          recipientParticipantId: participant.id,
          category: "REFUND_OR_CHARGEBACK",
          orderId: args.orderId,
        }),
        subjectKind: "ORDER",
        subjectRef: args.orderId,
        discriminator: null,
        now: args.at,
      },
      deps,
    );
    deliveries.push(enqueued.delivery);
  }

  return { deliveries, obligationIds };
}

/**
 * A refund became permanently inconsistent: record that an operator must act.
 *
 * Raised for the state `refundLifecycleState` calls `MANUAL_REMEDIATION_REQUIRED`
 * — money returned, tax reversal permanently failed — and for a permanently
 * failed payment refund, which is a buyer owed money Monacado cannot return
 * automatically.
 *
 * ## An obligation, and deliberately no email
 *
 * The recipient is Monacado itself, and Monacado has no participant record. An
 * obligation is raised against the **seller** — the party whose sale it is, and
 * the only participant the situation actually concerns — under
 * `OPERATIONAL_ACTION_REQUIRED`, which is the category `0M.N1` named for exactly
 * this.
 *
 * No message is sent to anybody. Telling a seller that Monacado's tax reversal
 * failed would be telling them about an internal provider problem they can do
 * nothing about, and telling the buyer would alarm somebody who already has their
 * money. The durable record is what an operator's backlog reads.
 */
export async function recordRefundRemediationObligation(
  args: { orderId: string; at: string },
  deps: RefundNoticeDeps = {},
): Promise<string | null> {
  const db = deps.db ?? getPrisma();
  const notificationIds = deps.notificationIds ?? cryptoParticipantIdProvider;

  const order = await db.order.findUnique({
    where: { id: args.orderId },
    select: { sellerParticipantId: true },
  });
  if (order === null) return null;

  const obligation = await db.$transaction((tx) =>
    upsertObligationInTx(tx, {
      id: notificationIds.nextObligationId(),
      recipientParticipantId: order.sellerParticipantId,
      category: "OPERATIONAL_ACTION_REQUIRED",
      subject: { kind: "ORDER", ref: args.orderId, versionRef: null },
      contextCode: null,
      createdAt: args.at,
    }),
  );
  return obligation.obligationId;
}
