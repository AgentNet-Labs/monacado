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

/**
 * Ask the seller for the facts of a disputed sale (Phase 1.12).
 *
 * The obligation `recordDisputeOperationalObligation` already raises, now with a
 * message against it. That function existed in 1.11 with **no caller** — the
 * record for "the seller owes us something" was built and never used, so a seller
 * was never actually asked. This is the caller.
 *
 * The context code is reused rather than replaced: `DISPUTE_EVIDENCE_REQUIRED`
 * already means exactly this, and a synonym would have made two rows for one
 * obligation.
 *
 * **The discriminator is not the bare dispute reference.** Asking again is a NEW
 * message rather than a duplicate to suppress — a seller who lost the first one
 * needs the second — so the request id joins the key, the way a re-issued email
 * verification challenge already does.
 */
export async function requestSellerDisputeEvidence(
  args: { disputeId: string; requestId: string; at?: string },
  deps: DisputeNoticeDeps = {},
): Promise<{ obligationId: string | null; delivered: boolean }> {
  const db = deps.db ?? getPrisma();
  const at = args.at ?? new Date().toISOString();

  const dispute = await db.transactionDispute.findUnique({
    where: { id: args.disputeId },
    select: { orderId: true, providerDisputeRef: true },
  });
  /* An unattributed dispute notifies nobody and fabricates no participant —
     1.11's rule, which every code added since has had to keep. */
  if (dispute === null || dispute.orderId === null) return { obligationId: null, delivered: false };

  const order = await db.order.findUnique({
    where: { id: dispute.orderId },
    select: { sellerParticipantId: true },
  });
  if (order === null) return { obligationId: null, delivered: false };

  const obligationId = await recordDisputeOperationalObligation(
    { disputeId: args.disputeId, at },
    deps,
  );

  const enqueued = await enqueueEmailDelivery(
    {
      purpose: "DISPUTE_EVIDENCE_REQUESTED",
      audience: "SELLER",
      recipientParticipantId: order.sellerParticipantId,
      obligationId: await obligationIdFor(db, {
        recipientParticipantId: order.sellerParticipantId,
        category: "OPERATIONAL_ACTION_REQUIRED",
        orderId: dispute.orderId,
        contextCode: "DISPUTE_EVIDENCE_REQUIRED",
      }),
      subjectKind: "ORDER",
      subjectRef: dispute.orderId,
      discriminator: `${dispute.providerDisputeRef}:${args.requestId}`,
      now: at,
    },
    deps,
  );
  return { obligationId, delivered: enqueued.delivery !== null };
}

/**
 * Tell the seller and any promoter that Monacado answered the dispute
 * (Phase 1.12).
 *
 * Symmetric to the opening notice for the reason 1.11 gave: a promoter's
 * commission turns on the same sale, and telling one party but not the other
 * would leave the promoter's economics moving for reasons they cannot see.
 */
export async function recordDisputeEvidenceSubmittedNotice(
  args: { disputeId: string; at?: string },
  deps: DisputeNoticeDeps = {},
): Promise<{ obligationIds: string[] }> {
  const db = deps.db ?? getPrisma();
  const notificationIds = deps.notificationIds ?? cryptoParticipantIdProvider;
  const at = args.at ?? new Date().toISOString();

  const dispute = await db.transactionDispute.findUnique({
    where: { id: args.disputeId },
    select: { orderId: true, providerDisputeRef: true },
  });
  if (dispute === null || dispute.orderId === null) return { obligationIds: [] };

  const order = await db.order.findUnique({
    where: { id: dispute.orderId },
    select: { sellerParticipantId: true, promoterParticipantId: true },
  });
  if (order === null) return { obligationIds: [] };

  const participants: Array<{ id: string; audience: "SELLER" | "PROMOTER" }> = [
    { id: order.sellerParticipantId, audience: "SELLER" },
  ];
  if (order.promoterParticipantId !== null) {
    participants.push({ id: order.promoterParticipantId, audience: "PROMOTER" });
  }

  const obligationIds: string[] = [];
  for (const participant of participants) {
    const obligation = await db.$transaction((tx) =>
      upsertObligationInTx(tx, {
        id: notificationIds.nextObligationId(),
        recipientParticipantId: participant.id,
        category: "REFUND_OR_CHARGEBACK",
        subject: { kind: "ORDER", ref: dispute.orderId!, versionRef: null },
        contextCode: "DISPUTE_EVIDENCE_SUBMITTED",
        createdAt: at,
      }),
    );
    obligationIds.push(obligation.obligationId);

    await enqueueEmailDelivery(
      {
        purpose: "DISPUTE_EVIDENCE_SUBMITTED",
        audience: participant.audience,
        recipientParticipantId: participant.id,
        obligationId: await obligationIdFor(db, {
          recipientParticipantId: participant.id,
          category: "REFUND_OR_CHARGEBACK",
          orderId: dispute.orderId!,
          contextCode: "DISPUTE_EVIDENCE_SUBMITTED",
        }),
        subjectKind: "ORDER",
        subjectRef: dispute.orderId!,
        discriminator: dispute.providerDisputeRef,
        now: at,
      },
      deps,
    );
  }
  return { obligationIds };
}

/**
 * A submission failed permanently: record that an operator must act
 * (Phase 1.12).
 *
 * **An obligation, and deliberately no email.** 1.9's precedent, restated: a
 * provider-side failure is not a fact a seller can act on, and telling them
 * would invite exactly the direct-to-network contact the marketplace policy
 * forbids.
 */
export async function recordDisputeEvidenceSubmissionFailure(
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
      contextCode: "DISPUTE_EVIDENCE_SUBMISSION_FAILED",
      createdAt: at,
    }),
  );
  return obligation.obligationId;
}
