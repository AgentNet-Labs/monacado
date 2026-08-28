/**
 * Dispute intake and lifecycle (Phase 1.11) — SERVER ONLY.
 *
 * The one place a provider dispute becomes a Monacado fact.
 *
 * ## Three layers of idempotency, and why each is needed
 *
 * 1. **Event level.** `TransactionDisputeEvent` has `@@unique([provider,
 *    providerEventId])`, written first inside the transaction, and a uniqueness
 *    violation means "already ingested" rather than an error. This is the
 *    `ProviderEmailEvent` shape exactly.
 * 2. **Dispute level.** `@@unique([provider, providerDisputeRef])` — a
 *    redelivered `created` is an existing dispute, not a second one.
 * 3. **Ordering.** `lastProviderEventAt` holds the provider's own instant for
 *    the last event *applied*. An older delivery is ingested (so the provider
 *    stops retrying) and applies nothing. Without this, a redelivered `created`
 *    would roll a decided `WON` back to `NEEDS_RESPONSE`.
 *
 * `1.0`'s webhook handler deliberately built no event ledger, on the grounds
 * that "the Order's own lifecycle and the UNIQUE index on
 * `TransactionEconomicSnapshot.orderId` already answer the question". That is
 * true of a payment, which is one-shot and terminal at `PAID`. It is false of a
 * dispute, which five event types mutate over weeks with no terminal guard. This
 * phase narrows that decision by evidence, for disputes only.
 *
 * ## What never happens here
 *
 * **The original sale is never rewritten.** No `TransactionEconomicSnapshot`
 * column is touched — this module contains no `transactionEconomicSnapshot`
 * write of any kind, and a test asserts that by reading this file's source.
 * `Order.lifecycle` stays `PAID`; a chargeback is new evidence about a completed
 * sale, not a correction of one.
 *
 * **No second reversal is ever attempted.** A lost dispute on an already-refunded
 * sale is a **deliberate refusal** checked before the call, not a caught
 * constraint violation. That distinction matters: the constraint would refuse it
 * anyway, but catching a `P2002` would record the situation as an accident when
 * it is a real and foreseeable case (a buyer refunded late still disputes).
 *
 * **No money moves.** No clawback, no offset, no payout. `1.9`'s deferral stands.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  DisputeObservation,
  TransactionDisputeRecord,
  isDisputeOpen,
  isValidDisputeStatusTransition,
  type DisputeEconomicEffect,
  type DisputeFundsState,
  type DisputeRemediationCode,
  type DisputeStatus,
  type DisputeTaxConsequence,
} from "../../contracts/marketplace/transaction-dispute";
import { buyerChargedTotalMinorUnits } from "../../contracts/marketplace/transaction-accounting";
import {
  INITIAL_PROCEEDS_RECOVERY_STATUS,
  recoveryReasonForObligationState,
} from "../../contracts/marketplace/proceeds-recovery";
import { SELLER_CHARGEBACK_FEE_POLICY } from "../../contracts/marketplace/chargeback-fee";
import { getPrisma } from "../db/client";
import { cryptoDisputeIdProvider, type DisputeIdProvider } from "./dispute-ids";
import {
  CorruptDisputeRecordError,
  DisputeError,
  DisputePersistenceFailureError,
  InvalidDisputeInputError,
} from "./dispute-errors";
import { isSnapshotReversedIn, recordFullReversalInTx } from "./transaction-reversal-service";

type Tx = Prisma.TransactionClient;

export interface DisputeServiceDeps {
  db?: ReturnType<typeof getPrisma>;
  ids?: DisputeIdProvider;
}

/** What one intake attempt concluded. */
export interface DisputeIntakeOutcome {
  disputeId: string;
  /** False when the delivery was a replay or arrived out of order. */
  applied: boolean;
  /** True when this exact provider event had already been ingested. */
  duplicateEvent: boolean;
  status: DisputeStatus;
  fundsState: DisputeFundsState;
  economicEffect: DisputeEconomicEffect;
  taxConsequence: DisputeTaxConsequence;
  remediationCode: DisputeRemediationCode | null;
  /** True when no settlement matched the dispute's payment reference. */
  unattributed: boolean;
  /** The `CHARGEBACK` entry written by this event, if one was. */
  reversalId: string | null;
  /** Obligations whose payout this dispute now holds. */
  heldObligationIds: string[];
  /** Recovery exceptions raised by this event. */
  raisedRecoveryExceptionIds: string[];
  /** The $30 seller fee a finalized loss assessed, or NULL where none applied. */
  chargebackFeeId: string | null;
  /** Recovery exceptions closed by this event (a won dispute). */
  closedRecoveryExceptionIds: string[];
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}

function rowToRecord(row: {
  id: string;
  orderId: string | null;
  snapshotId: string | null;
  provider: string;
  providerMode: string;
  providerDisputeRef: string;
  providerTransactionRef: string;
  providerChargeRef: string | null;
  disputedAmountMinorUnits: bigint;
  currency: string;
  reasonCode: string;
  status: string;
  fundsState: string;
  taxConsequence: string;
  economicEffect: string;
  evidenceDueBy: Date | null;
  responsePermitted: boolean;
  evidenceStagedAtProvider: boolean;
  evidenceSubmissionCount: number;
  evidenceSubmittedPastDue: boolean;
  chargeStillRefundable: boolean;
  remediationCode: string | null;
  lastProviderEventAt: Date;
  openedAt: Date;
  fundsWithdrawnAt: Date | null;
  fundsReinstatedAt: Date | null;
  closedAt: Date | null;
  recordedAt: Date;
  updatedAt: Date;
  reversalId: string | null;
}): TransactionDisputeRecord {
  const parsed = TransactionDisputeRecord.safeParse({
    disputeId: row.id,
    orderId: row.orderId,
    snapshotId: row.snapshotId,
    provider: row.provider,
    providerMode: row.providerMode,
    providerDisputeRef: row.providerDisputeRef,
    providerTransactionRef: row.providerTransactionRef,
    providerChargeRef: row.providerChargeRef,
    disputedAmountMinorUnits: Number(row.disputedAmountMinorUnits),
    currency: row.currency,
    reasonCode: row.reasonCode,
    status: row.status,
    fundsState: row.fundsState,
    taxConsequence: row.taxConsequence,
    economicEffect: row.economicEffect,
    evidenceDueBy: row.evidenceDueBy?.toISOString() ?? null,
    responsePermitted: row.responsePermitted,
    evidenceStagedAtProvider: row.evidenceStagedAtProvider,
    evidenceSubmissionCount: row.evidenceSubmissionCount,
    evidenceSubmittedPastDue: row.evidenceSubmittedPastDue,
    chargeStillRefundable: row.chargeStillRefundable,
    remediationCode: row.remediationCode,
    lastProviderEventAt: row.lastProviderEventAt.toISOString(),
    openedAt: row.openedAt.toISOString(),
    fundsWithdrawnAt: row.fundsWithdrawnAt?.toISOString() ?? null,
    fundsReinstatedAt: row.fundsReinstatedAt?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    recordedAt: row.recordedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    reversalId: row.reversalId,
  });
  if (!parsed.success) throw new CorruptDisputeRecordError();
  return parsed.data;
}

/**
 * Raise recovery evidence for every claim a dispute puts at risk.
 *
 * The **same shape** as `1.9`'s refund path, and deliberately so — an operator
 * reads one backlog, not two.
 *
 * `PENDING` claims get no row: the payout gate already refuses to make a
 * disputed sale's claim eligible, so it can never be paid, and an exception to
 * something that cannot happen is an exception to nothing.
 *
 * `ELIGIBLE` and `PAID` claims are **never demoted and never rewritten**. What
 * was actually paid stays recorded as paid; refusing to record it would make the
 * ledger wrong rather than safe.
 */
/**
 * Assess the seller's chargeback fee for a finalized loss (Phase 1.12).
 *
 * Called on `LOST` and nowhere else. Opening a dispute is the cardholder's act
 * rather than a finding against the seller, and a won dispute vindicates them —
 * a seller who successfully defends a sale must be no worse off for having been
 * disputed, or the fee becomes a tax on being a target.
 *
 * **Writes one new row and moves nothing else.** No snapshot column, no
 * obligation amount, and no payout figure is touched: netting thirty dollars out
 * of a historical amount would restate what three parties were told they earned,
 * and would do it silently. Collection is not attempted here and is not built
 * anywhere — the obligation is recorded and an operator can see it.
 *
 * Idempotent through the unique index on `disputeId`: a redelivered
 * `charge.dispute.closed` is the same loss, so the duplicate is swallowed rather
 * than assessed twice.
 */
async function assessSellerChargebackFeeInTx(
  tx: Tx,
  args: {
    disputeId: string;
    orderId: string;
    assessedAt: string;
    ids: DisputeIdProvider;
  },
): Promise<string | null> {
  const order = await tx.order.findUnique({
    where: { id: args.orderId },
    select: { sellerParticipantId: true },
  });
  /* No seller, no fee. An Order Monacado cannot attribute to a participant is a
     reconciliation problem, and inventing a debtor would be worse than the gap. */
  if (order === null) return null;

  const id = args.ids.nextSellerChargebackFeeId();
  try {
    await tx.sellerChargebackFee.create({
      data: {
        id,
        disputeId: args.disputeId,
        orderId: args.orderId,
        sellerParticipantId: order.sellerParticipantId,
        amountMinorUnits: BigInt(SELLER_CHARGEBACK_FEE_POLICY.amountMinorUnits),
        /* USD regardless of the sale's currency: this is a marketplace fee for
           the work and loss a finalized chargeback creates, not a share of the
           disputed transaction, so it does not float with the sale. */
        currency: SELLER_CHARGEBACK_FEE_POLICY.currency,
        policyVersion: SELLER_CHARGEBACK_FEE_POLICY.policyVersion,
        state: "ASSESSED",
        assessedAt: new Date(args.assessedAt),
      },
    });
    return id;
  } catch {
    /* Already assessed. One finalized loss, one fee. */
    return null;
  }
}

async function raiseDisputeRecoveryExceptionsInTx(
  tx: Tx,
  args: {
    disputeId: string;
    orderId: string;
    snapshotId: string;
    raisedAt: string;
    ids: DisputeIdProvider;
  },
): Promise<string[]> {
  const obligations = await tx.proceedsObligation.findMany({
    where: { snapshotId: args.snapshotId },
  });

  const raised: string[] = [];
  for (const obligation of obligations) {
    const reason = recoveryReasonForObligationState(
      obligation.state as "PENDING" | "ELIGIBLE" | "PAID",
      "DISPUTE",
    );
    if (reason === null) continue;

    const id = args.ids.nextProceedsRecoveryExceptionId();
    try {
      await tx.proceedsRecoveryException.create({
        data: {
          id,
          refundId: null,
          disputeId: args.disputeId,
          causeKind: "DISPUTE",
          orderId: args.orderId,
          snapshotId: args.snapshotId,
          proceedsObligationId: obligation.id,
          participantId: obligation.participantId,
          party: obligation.party,
          /* COPIED from the obligation, never recomputed. What is at stake is
             exactly what Monacado committed to that party — seller proceeds and
             promoter commission alike, from sale-time evidence. */
          amountMinorUnits: obligation.amountMinorUnits,
          /* Equal to the whole obligation: a dispute is full-scope or it is
             refused before reaching here, so this is not an approximation. */
          attributableAmountMinorUnits: obligation.amountMinorUnits,
          currency: obligation.currency,
          reasonCode: reason,
          obligationStateAtRefund: obligation.state,
          status: INITIAL_PROCEEDS_RECOVERY_STATUS,
          resolutionCode: null,
          raisedAt: new Date(args.raisedAt),
        },
      });
      raised.push(id);
    } catch (error) {
      /* One exception per claim per cause. A replayed dispute event finding its
         own exception already standing is the constraint doing its job, not a
         failure — and emphatically not a reason to write a second row. */
      if (!isUniqueViolation(error)) throw error;
    }
  }
  return raised;
}

/**
 * Close the recovery exceptions a dispute raised, when it is won.
 *
 * Only `causeKind: "DISPUTE"` rows, and only ones this dispute raised.
 * Refund-caused exceptions on the same claim are **never** touched: they record
 * a different fact, with a different cause, that a won dispute does not settle.
 *
 * The resolution code is `DISPUTE_RESOLVED_NO_RECOVERY_DUE` rather than
 * `RAISED_IN_ERROR`, because the exception was validly raised — at the moment it
 * was written, a party held money on a sale a bank was contesting.
 */
async function closeDisputeRecoveryExceptionsInTx(
  tx: Tx,
  args: { disputeId: string; at: string },
): Promise<string[]> {
  const open = await tx.proceedsRecoveryException.findMany({
    where: {
      disputeId: args.disputeId,
      causeKind: "DISPUTE",
      status: { in: ["OPEN", "ACKNOWLEDGED"] },
    },
  });
  const closed: string[] = [];
  for (const row of open) {
    await tx.proceedsRecoveryException.update({
      where: { id: row.id },
      data: {
        status: "RESOLVED",
        resolutionCode: "DISPUTE_RESOLVED_NO_RECOVERY_DUE",
        resolvedAt: new Date(args.at),
      },
    });
    closed.push(row.id);
  }
  return closed;
}

/**
 * Decide the tax consequence of a resolved dispute.
 *
 * **Records a decision; performs no tax action.** `OrderTaxReversal.refundId` is
 * `NOT NULL` and `@unique` with a `RESTRICT` FK to `OrderRefund`, at the schema,
 * the contract, and the verification gate. A dispute has no refund row, so a
 * dispute-caused tax correction is **not expressible** — and the honest move is
 * to say so and surface it, rather than fabricate an `OrderRefund` to hang a
 * reversal from.
 *
 * No calculation happens here, and this module never reaches the tax
 * calculation port at all.
 */
async function decideTaxConsequenceInTx(
  tx: Tx,
  args: { orderId: string | null; status: DisputeStatus; alreadyReversedByRefund: boolean },
): Promise<DisputeTaxConsequence> {
  if (args.status !== "LOST") {
    if (args.status === "WON" || args.status === "CLOSED") return "NO_ACTION_REQUIRED";
    return "NOT_ASSESSED";
  }
  if (args.alreadyReversedByRefund) return "ALREADY_REVERSED_BY_REFUND";
  if (args.orderId === null) return "NOT_ASSESSED";

  const taxTransaction = await tx.orderTaxTransaction.findUnique({
    where: { orderId: args.orderId },
  });
  if (taxTransaction === null) return "NO_TAX_TRANSACTION";
  if (taxTransaction.recordingStatus !== "RECORDED") return "NO_TAX_TRANSACTION";

  const existingReversal = await tx.orderTaxReversal.findUnique({
    where: { orderId: args.orderId },
  });
  if (existingReversal !== null) return "ALREADY_REVERSED_BY_REFUND";

  /* A sale's tax stands reported and a bank has taken the money back. Fails
     closed: reconciliation and readiness surface this, and no approximation is
     written. */
  return "REVERSAL_REQUIRED_NOT_EXPRESSIBLE";
}

/**
 * Record one provider dispute observation.
 *
 * Everything below happens in **one transaction**, so a dispute is never half
 * recorded — and a failure leaves the provider to retry against an unchanged
 * database, which the idempotency above makes safe.
 */
export async function recordDisputeObservation(
  rawObservation: unknown,
  args: { recordedAt: string },
  deps: DisputeServiceDeps = {},
): Promise<DisputeIntakeOutcome> {
  const parsed = DisputeObservation.safeParse(rawObservation);
  if (!parsed.success) throw new InvalidDisputeInputError();
  const observation = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoDisputeIdProvider;

  try {
    return await db.$transaction(async (tx) => {
      // — 1. Event ledger first. A replay stops here. —
      const existingEvent = await tx.transactionDisputeEvent.findUnique({
        where: {
          provider_providerEventId: {
            provider: observation.provider,
            providerEventId: observation.providerEventId,
          },
        },
      });

      const existing = await tx.transactionDispute.findUnique({
        where: {
          provider_providerDisputeRef: {
            provider: observation.provider,
            providerDisputeRef: observation.providerDisputeRef,
          },
        },
      });

      if (existingEvent !== null && existing !== null) {
        const record = rowToRecord(existing);
        return {
          disputeId: record.disputeId,
          applied: false,
          duplicateEvent: true,
          status: record.status,
          fundsState: record.fundsState,
          economicEffect: record.economicEffect,
          taxConsequence: record.taxConsequence,
          remediationCode: record.remediationCode,
          unattributed: record.orderId === null,
          reversalId: record.reversalId,
          heldObligationIds: [],
          raisedRecoveryExceptionIds: [],
          chargebackFeeId: null,
          closedRecoveryExceptionIds: [],
        };
      }

      // — 2. Attribution, by payment reference alone. —
      const settlement =
        observation.providerTransactionRef.length > 0
          ? await tx.transactionSettlement.findUnique({
              where: {
                provider_providerTransactionRef: {
                  provider: observation.provider,
                  providerTransactionRef: observation.providerTransactionRef,
                },
              },
            })
          : null;

      const snapshotId = settlement?.snapshotId ?? null;
      const snapshot =
        snapshotId === null
          ? null
          : await tx.transactionEconomicSnapshot.findUnique({ where: { id: snapshotId } });
      const orderId = snapshot?.orderId ?? null;

      // — 3. Refusals, computed before anything is written. —
      let remediationCode: DisputeRemediationCode | null = null;
      let status: DisputeStatus = observation.status;

      if (observation.providerReportedLivemode) {
        /* The provider's own statement that this object is live, arriving at a
           deployment that only ever holds TEST credentials. A configuration
           fault, not a fact to accept. */
        remediationCode = "LIVEMODE_IN_TEST_DEPLOYMENT";
        status = "MANUAL_REMEDIATION_REQUIRED";
      } else if (settlement === null || snapshotId === null || orderId === null) {
        remediationCode = "UNATTRIBUTABLE";
        status = "MANUAL_REMEDIATION_REQUIRED";
      } else if (observation.status === "MANUAL_REMEDIATION_REQUIRED") {
        remediationCode = "UNRECOGNISED_PROVIDER_STATUS";
      } else if (snapshot !== null && observation.currency !== snapshot.currency) {
        remediationCode = "CURRENCY_MISMATCH";
        status = "MANUAL_REMEDIATION_REQUIRED";
      }

      // — 4. Create or update the dispute row. —
      const occurredAt = new Date(observation.occurredAt);
      let disputeId: string;
      let priorStatus: DisputeStatus | null = null;
      let priorFundsState: DisputeFundsState = "NOT_WITHDRAWN";
      let priorEconomicEffect: DisputeEconomicEffect = "NONE";
      let priorReversalId: string | null = null;

      if (existing === null) {
        disputeId = ids.nextDisputeId();
        await tx.transactionDispute.create({
          data: {
            id: disputeId,
            orderId,
            snapshotId,
            provider: observation.provider,
            providerMode: observation.providerMode,
            providerDisputeRef: observation.providerDisputeRef,
            providerTransactionRef: observation.providerTransactionRef,
            providerChargeRef: observation.providerChargeRef,
            disputedAmountMinorUnits: BigInt(observation.disputedAmountMinorUnits),
            currency: observation.currency,
            reasonCode: observation.reasonCode,
            status,
            fundsState: observation.eventKind === "FUNDS_WITHDRAWN" ? "WITHDRAWN" : "NOT_WITHDRAWN",
            taxConsequence: "NOT_ASSESSED",
            economicEffect: "NONE",
            evidenceDueBy:
              observation.evidenceDueBy === null ? null : new Date(observation.evidenceDueBy),
            responsePermitted: observation.responsePermitted,
            evidenceStagedAtProvider: observation.evidenceStagedAtProvider,
            evidenceSubmissionCount: observation.evidenceSubmissionCount,
            evidenceSubmittedPastDue: observation.evidenceSubmittedPastDue,
            chargeStillRefundable: observation.chargeStillRefundable,
            remediationCode,
            lastProviderEventAt: occurredAt,
            openedAt: new Date(observation.openedAt),
            fundsWithdrawnAt: observation.eventKind === "FUNDS_WITHDRAWN" ? occurredAt : null,
            fundsReinstatedAt: null,
            closedAt: observation.eventKind === "CLOSED" ? occurredAt : null,
            recordedAt: new Date(args.recordedAt),
            reversalId: null,
          },
        });
      } else {
        disputeId = existing.id;
        priorStatus = existing.status as DisputeStatus;
        priorFundsState = existing.fundsState as DisputeFundsState;
        priorEconomicEffect = existing.economicEffect as DisputeEconomicEffect;
        priorReversalId = existing.reversalId;

        // — Out-of-order tolerance. —
        if (occurredAt.getTime() < existing.lastProviderEventAt.getTime()) {
          await tx.transactionDisputeEvent.create({
            data: {
              id: ids.nextDisputeEventId(),
              disputeId,
              provider: observation.provider,
              providerEventId: observation.providerEventId,
              eventKind: observation.eventKind,
              applied: false,
              occurredAt,
              receivedAt: new Date(args.recordedAt),
            },
          });
          const record = rowToRecord(existing);
          return {
            disputeId,
            applied: false,
            duplicateEvent: false,
            status: record.status,
            fundsState: record.fundsState,
            economicEffect: record.economicEffect,
            taxConsequence: record.taxConsequence,
            remediationCode: record.remediationCode,
            unattributed: record.orderId === null,
            reversalId: record.reversalId,
            heldObligationIds: [],
            raisedRecoveryExceptionIds: [],
            chargebackFeeId: null,
            closedRecoveryExceptionIds: [],
          };
        }

        /* Terminal adjudication is forward-only. A late `updated` carrying
           `needs_response` after a loss keeps the decided status. */
        const nextStatus = isValidDisputeStatusTransition(priorStatus, status)
          ? status
          : priorStatus;

        await tx.transactionDispute.update({
          where: { id: disputeId },
          data: {
            status: nextStatus,
            ...(observation.eventKind === "FUNDS_WITHDRAWN"
              ? { fundsState: "WITHDRAWN", fundsWithdrawnAt: occurredAt }
              : {}),
            ...(observation.eventKind === "FUNDS_REINSTATED"
              ? { fundsState: "REINSTATED", fundsReinstatedAt: occurredAt }
              : {}),
            ...(observation.eventKind === "CLOSED" ? { closedAt: occurredAt } : {}),
            evidenceDueBy:
              observation.evidenceDueBy === null ? null : new Date(observation.evidenceDueBy),
            responsePermitted: observation.responsePermitted,
            evidenceStagedAtProvider: observation.evidenceStagedAtProvider,
            evidenceSubmissionCount: observation.evidenceSubmissionCount,
            evidenceSubmittedPastDue: observation.evidenceSubmittedPastDue,
            chargeStillRefundable: observation.chargeStillRefundable,
            ...(remediationCode !== null ? { remediationCode } : {}),
            lastProviderEventAt: occurredAt,
          },
        });
        status = nextStatus;
      }

      // — 5. Ingest the event. —
      await tx.transactionDisputeEvent.create({
        data: {
          id: ids.nextDisputeEventId(),
          disputeId,
          provider: observation.provider,
          providerEventId: observation.providerEventId,
          eventKind: observation.eventKind,
          applied: true,
          occurredAt,
          receivedAt: new Date(args.recordedAt),
        },
      });

      // — 6. Economic consequences. —
      let economicEffect: DisputeEconomicEffect = priorEconomicEffect;
      let reversalId: string | null = priorReversalId;
      const heldObligationIds: string[] = [];
      let raisedRecoveryExceptionIds: string[] = [];
      let chargebackFeeId: string | null = null;
      let closedRecoveryExceptionIds: string[] = [];
      let alreadyReversedByRefund = false;

      if (orderId !== null && snapshotId !== null) {
        /* Unpaid claims are held by the payout gate's own predicate, which reads
           the dispute rows directly. Nothing is written to hold them, so nothing
           can be left behind when the hold lifts. Reported for visibility. */
        if (isDisputeOpen(status) || status === "LOST") {
          const heldRows = await tx.proceedsObligation.findMany({
            where: { snapshotId, state: "PENDING" },
            select: { id: true },
          });
          heldObligationIds.push(...heldRows.map((r) => r.id));
        }

        if (isDisputeOpen(status)) {
          raisedRecoveryExceptionIds = await raiseDisputeRecoveryExceptionsInTx(tx, {
            disputeId,
            orderId,
            snapshotId,
            raisedAt: args.recordedAt,
            ids,
          });
        }

        if (status === "WON" || status === "CLOSED") {
          closedRecoveryExceptionIds = await closeDisputeRecoveryExceptionsInTx(tx, {
            disputeId,
            at: args.recordedAt,
          });
          /* Nothing else. A won dispute creates no obligation, no snapshot, and
             no second sale — the original economics were valid all along. */
          economicEffect = reversalId === null ? "NONE" : economicEffect;
        }

        if (status === "LOST") {
          raisedRecoveryExceptionIds = await raiseDisputeRecoveryExceptionsInTx(tx, {
            disputeId,
            orderId,
            snapshotId,
            raisedAt: args.recordedAt,
            ids,
          });

          /* The seller's $30 fee, assessed on a finalized loss and on nothing
             else. A new fact standing beside the sale, never a deduction from
             it. */
          chargebackFeeId = await assessSellerChargebackFeeInTx(tx, {
            disputeId,
            orderId,
            assessedAt: args.recordedAt,
            ids,
          });

          const alreadyReversed = await isSnapshotReversedIn(tx, snapshotId);
          if (alreadyReversed) {
            /* A DELIBERATE refusal, checked before the call rather than caught
               after it. The buyer has been made whole twice in the world; that
               is a provider-level recovery matter, not a second Monacado
               reversal, and writing one would double-count the loss. */
            alreadyReversedByRefund = true;
            economicEffect = "ALREADY_REVERSED_BY_REFUND";
            if (remediationCode === null) remediationCode = "SALE_ALREADY_REVERSED";
          } else if (
            snapshot !== null &&
            observation.disputedAmountMinorUnits !==
              buyerChargedTotalMinorUnits({
                commercialRetailAmountMinorUnits: Number(snapshot.commercialRetailAmountMinorUnits),
                passThrough: {
                  taxAmountMinorUnits: Number(snapshot.taxAmountMinorUnits),
                  shippingAmountMinorUnits: Number(snapshot.shippingAmountMinorUnits),
                  otherPassThroughAmountMinorUnits: Number(
                    snapshot.otherPassThroughAmountMinorUnits,
                  ),
                },
              })
          ) {
            /* A partial chargeback. `REVERSAL_SCOPES` has one member and
               `recordFullReversalInTx` derives every figure from the snapshot,
               so there is no entry to write that would be true. Refused, not
               rounded. */
            economicEffect = "NOT_EXPRESSIBLE";
            remediationCode = "PARTIAL_AMOUNT_NOT_EXPRESSIBLE";
          } else {
            const recorded = await recordFullReversalInTx(
              tx,
              {
                snapshotId,
                /* The members `1.2` reserved for exactly this. */
                kind: "CHARGEBACK",
                reasonCode: "DISPUTED_BY_BUYER",
                provider: "STRIPE",
                providerReversalRef: observation.providerDisputeRef,
                /* The PROVIDER's instant. A reversal stamped with a worker's
                   clock could not answer "when did the funds go back", which is
                   the first question asked in a chargeback. */
                occurredAt: observation.occurredAt,
                recordedAt: args.recordedAt,
              },
              { nextReversalId: () => ids.nextReversalId() },
            );
            reversalId = recorded.reversal.reversalId;
            economicEffect = "REVERSED_BY_THIS_DISPUTE";
          }
        }
      }

      // — 7. Tax consequence, decided and recorded. Never performed. —
      const taxConsequence = await decideTaxConsequenceInTx(tx, {
        orderId,
        status,
        alreadyReversedByRefund,
      });

      if (taxConsequence === "REVERSAL_REQUIRED_NOT_EXPRESSIBLE" && remediationCode === null) {
        remediationCode = "TAX_CORRECTION_NOT_EXPRESSIBLE";
      }

      await tx.transactionDispute.update({
        where: { id: disputeId },
        data: {
          status,
          economicEffect,
          taxConsequence,
          remediationCode,
          reversalId,
        },
      });

      return {
        disputeId,
        applied: true,
        duplicateEvent: false,
        status,
        fundsState:
          observation.eventKind === "FUNDS_WITHDRAWN"
            ? "WITHDRAWN"
            : observation.eventKind === "FUNDS_REINSTATED"
              ? "REINSTATED"
              : priorFundsState,
        economicEffect,
        taxConsequence,
        remediationCode,
        unattributed: orderId === null,
        reversalId,
        heldObligationIds,
        raisedRecoveryExceptionIds,
        chargebackFeeId,
        closedRecoveryExceptionIds,
      };
    });
  } catch (error) {
    if (error instanceof DisputeError) throw error;
    throw new DisputePersistenceFailureError("recordDisputeObservation", error);
  }
}

/** One dispute, by Monacado identity. */
export async function getDispute(
  disputeId: string,
  deps: DisputeServiceDeps = {},
): Promise<TransactionDisputeRecord | null> {
  const db = deps.db ?? getPrisma();
  const row = await db.transactionDispute.findUnique({ where: { id: disputeId } });
  return row === null ? null : rowToRecord(row);
}

/** Every dispute recorded against one sale, newest first. */
export async function listDisputesForOrder(
  orderId: string,
  deps: DisputeServiceDeps = {},
): Promise<TransactionDisputeRecord[]> {
  const db = deps.db ?? getPrisma();
  const rows = await db.transactionDispute.findMany({
    where: { orderId },
    orderBy: { openedAt: "desc" },
  });
  return rows.map(rowToRecord);
}

/**
 * Whether a sale currently has a dispute that should stop a refund.
 *
 * Read by the refund path, which must refuse rather than race a bank for the
 * same money. Returns the blocking status so the caller can name it.
 */
export async function disputeBlockingRefundIn(
  tx: Tx,
  snapshotId: string,
): Promise<"SALE_DISPUTE_OPEN" | "SALE_DISPUTE_LOST" | null> {
  const rows = await tx.transactionDispute.findMany({
    where: { snapshotId },
    select: { status: true },
  });
  if (rows.some((r) => r.status === "LOST")) return "SALE_DISPUTE_LOST";
  if (rows.some((r) => isDisputeOpen(r.status as DisputeStatus))) return "SALE_DISPUTE_OPEN";
  return null;
}
