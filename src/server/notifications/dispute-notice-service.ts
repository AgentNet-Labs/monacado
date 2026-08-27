/**
 * Dispute notices (Phase 1.11) — SERVER ONLY.
 *
 * ## The buyer is told nothing. Ever.
 *
 * Three reasons, and they are cumulative:
 *
 * 1. **The cardholder disputed with their bank, not with Monacado.** Emailing a
 *    snapshot address may reach somebody who did not file it — a shared or
 *    family card is not unusual.
 * 2. **Anything Monacado writes about a live dispute is correspondence a bank
 *    may weigh.** Sending an unreviewed template into an active adjudication is
 *    worse than sending nothing.
 * 3. **The precedent is already recorded for the closest analogue.** `1.9`'s
 *    tax-reversal remediation deliberately emails nobody, reasoning that
 *    telling a seller about an internal provider problem they can do nothing
 *    about helps no one, and telling the buyer "would alarm somebody who
 *    already has their money".
 *
 * ## The obligation key collision this file exists to avoid
 *
 * `notificationObligationKey` hashes `(recipient, category, subjectKind,
 * subjectRef, subjectVersionRef, contextCode)`, and `1.9` already writes
 * `category: "REFUND_OR_CHARGEBACK"` against `{kind: "ORDER", ref: orderId}`
 * with `contextCode: null`.
 *
 * A dispute obligation carrying that same tuple would resolve — through
 * `upsertObligationInTx` — to the **refund's existing row**, and a seller whose
 * refunded sale was later charged back would silently never be told. Every
 * obligation here therefore carries an explicit `contextCode`, and every
 * delivery carries the provider dispute reference as its discriminator so a
 * second dispute on the same Order is a second message rather than a suppressed
 * duplicate.
 *
 * ## Email never determines financial truth
 *
 * Every function here is called **after** the dispute row has committed, and the
 * caller swallows every failure. A dispute Monacado recorded but could not send
 * mail about is still recorded.
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

export interface DisputeNoticeDeps extends OutboundEmailDeps {
  db?: Db;
  notificationIds?: ParticipantIdProvider;
}

export interface EnqueuedDisputeNotices {
  deliveries: OutboundEmailDeliveryRecord[];
  obligationIds: string[];
}

async function obligationIdFor(
  db: Db,
  args: {
    recipientParticipantId: string;
    category: NotificationCategory;
    orderId: string;
    contextCode: string;
  },
): Promise<string | null> {
  const row = await db.notificationObligation.findFirst({
    where: {
      recipientParticipantId: args.recipientParticipantId,
      category: args.category,
      subjectKind: "ORDER",
      subjectRef: args.orderId,
      contextCode: args.contextCode,
    },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * A dispute was recorded: commit to telling the seller and any promoter.
 *
 * Idempotent by construction — both keys derive from (recipient,
 * category/purpose, subject, context/discriminator), so calling this twice for
 * one dispute yields one obligation and one delivery per party.
 *
 * **An unattributed dispute produces nothing, and invents nothing.**
 * `NotificationObligation.recipientParticipantId` is a non-null FK, and a
 * dispute whose payment reference matches no settlement has no seller. Nothing
 * is fabricated to make the constraint satisfiable; the dispute is durable and
 * visible in `dispute:status`, which is where it belongs.
 */
export async function enqueueDisputeNotices(
  args: { disputeId: string; at?: string },
  deps: DisputeNoticeDeps = {},
): Promise<EnqueuedDisputeNotices> {
  const db = deps.db ?? getPrisma();
  const notificationIds = deps.notificationIds ?? cryptoParticipantIdProvider;
  const at = args.at ?? new Date().toISOString();

  const dispute = await db.transactionDispute.findUnique({
    where: { id: args.disputeId },
    select: {
      id: true,
      orderId: true,
      status: true,
      providerDisputeRef: true,
      remediationCode: true,
    },
  });
  if (dispute === null || dispute.orderId === null) return { deliveries: [], obligationIds: [] };

  const order = await db.order.findUnique({
    where: { id: dispute.orderId },
    select: { id: true, sellerParticipantId: true, promoterParticipantId: true },
  });
  if (order === null) return { deliveries: [], obligationIds: [] };

  /* Which fact this notice is about. The discriminator that keeps a dispute
     obligation from resolving onto a refund's row — see the header. */
  const contextCode =
    dispute.status === "WON"
      ? "DISPUTE_WON"
      : dispute.status === "LOST"
        ? "DISPUTE_LOST"
        : "DISPUTE_OPENED";

  const participants: Array<{ id: string; audience: "SELLER" | "PROMOTER" }> = [
    { id: order.sellerParticipantId, audience: "SELLER" },
  ];
  /* A promoter is told too: their commission is conditional on the sale
     remaining economically valid, and the refund path already notifies them
     symmetrically. They are not a party to the dispute and supply no evidence
     about fulfilment they did not perform. */
  if (order.promoterParticipantId !== null) {
    participants.push({ id: order.promoterParticipantId, audience: "PROMOTER" });
  }

  const deliveries: OutboundEmailDeliveryRecord[] = [];
  const obligationIds: string[] = [];

  for (const participant of participants) {
    /* The obligation first, in its own transaction: what Monacado owes a
       participant is a durable fact independent of whether any message about it
       was ever queued. */
    const obligation = await db.$transaction((tx) =>
      upsertObligationInTx(tx, {
        id: notificationIds.nextObligationId(),
        recipientParticipantId: participant.id,
        /* The category `0M.N1` named for exactly this, reused rather than
           widened. */
        category: "REFUND_OR_CHARGEBACK",
        subject: { kind: "ORDER", ref: dispute.orderId!, versionRef: null },
        contextCode,
        createdAt: at,
      }),
    );
    obligationIds.push(obligation.obligationId);

    const enqueued = await enqueueEmailDelivery(
      {
        purpose: "DISPUTE_RECORDED",
        audience: participant.audience,
        recipientParticipantId: participant.id,
        obligationId: await obligationIdFor(db, {
          recipientParticipantId: participant.id,
          category: "REFUND_OR_CHARGEBACK",
          orderId: dispute.orderId!,
          contextCode,
        }),
        subjectKind: "ORDER",
        subjectRef: dispute.orderId!,
        /* The provider dispute reference, not null: a second dispute against
           the same Order is a second message, not a suppressed duplicate. */
        discriminator: dispute.providerDisputeRef,
        now: at,
      },
      deps,
    );
    deliveries.push(enqueued.delivery);
  }

  return { deliveries, obligationIds };
}

/**
 * A dispute needs an operator: record that somebody must act.
 *
 * ## An obligation, and deliberately no email
 *
 * `1.9`'s reasoning, unchanged. The recipient is Monacado itself, which has no
 * participant record, so the obligation is raised against the **seller** — the
 * party whose sale it is and the only participant the situation concerns — under
 * `OPERATIONAL_ACTION_REQUIRED`.
 *
 * Nobody is emailed. A dispute needing internal remediation is not a fact a
 * seller can act on, and it is emphatically not one to send a buyer.
 */
export async function recordDisputeOperationalObligation(
  args: { disputeId: string; at?: string },
  deps: DisputeNoticeDeps = {},
): Promise<string | null> {
  const db = deps.db ?? getPrisma();
  const notificationIds = deps.notificationIds ?? cryptoParticipantIdProvider;
  const at = args.at ?? new Date().toISOString();

  const dispute = await db.transactionDispute.findUnique({
    where: { id: args.disputeId },
    select: { orderId: true },
  });
  if (dispute === null || dispute.orderId === null) return null;

  const order = await db.order.findUnique({
    where: { id: dispute.orderId },
    select: { sellerParticipantId: true },
  });
  if (order === null) return null;

  const obligation = await db.$transaction((tx) =>
    upsertObligationInTx(tx, {
      id: notificationIds.nextObligationId(),
      recipientParticipantId: order.sellerParticipantId,
      category: "OPERATIONAL_ACTION_REQUIRED",
      subject: { kind: "ORDER", ref: dispute.orderId!, versionRef: null },
      contextCode: "DISPUTE_EVIDENCE_REQUIRED",
      createdAt: at,
    }),
  );
  return obligation.obligationId;
}
