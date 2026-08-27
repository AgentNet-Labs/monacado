/**
 * Dispute reconciliation (Phase 1.11) — SERVER ONLY.
 *
 * Answers *"do Monacado's own records about this disputed sale agree with each
 * other"* — **from local rows alone, with no provider call**.
 *
 * Every finding is accumulated, not short-circuited: the first problem is rarely
 * the only one, and an operator handed one finding fixes one thing and comes
 * back. That is the rule the risk gate and `refund-reconciliation-service`
 * already follow.
 */

import "../server-only";
import {
  DISPUTE_FINDINGS_NEEDING_OPERATOR,
  HEALTHY_DISPUTE_FINDING_CODES,
  type DisputeReconciliationFindingCode,
  type DisputeReconciliationResult,
  type DisputeReconciliationSummary,
} from "../../contracts/marketplace/dispute-reconciliation";
import {
  NON_TERMINAL_DISPUTE_STATUSES,
  isDisputeOpen,
  type DisputeEconomicEffect,
  type DisputeFundsState,
  type DisputeStatus,
  type DisputeTaxConsequence,
} from "../../contracts/marketplace/transaction-dispute";
import { buyerChargedTotalMinorUnits } from "../../contracts/marketplace/transaction-accounting";
import { getPrisma } from "../db/client";
import { DisputeError, DisputePersistenceFailureError } from "./dispute-errors";

export interface DisputeReconciliationDeps {
  db?: ReturnType<typeof getPrisma>;
}

function finish(input: {
  orderId: string | null;
  disputeId: string | null;
  reversalId: string | null;
  refundId: string | null;
  providerDisputeRef: string | null;
  status: DisputeStatus | null;
  fundsState: DisputeFundsState | null;
  economicEffect: DisputeEconomicEffect | null;
  taxConsequence: DisputeTaxConsequence | null;
  findings: DisputeReconciliationFindingCode[];
  at: string;
}): DisputeReconciliationResult {
  const findings = input.findings.length === 0 ? (["CONSISTENT"] as const) : input.findings;
  return {
    orderId: input.orderId,
    disputeId: input.disputeId,
    reversalId: input.reversalId,
    refundId: input.refundId,
    providerDisputeRef: input.providerDisputeRef,
    status: input.status,
    fundsState: input.fundsState,
    economicEffect: input.economicEffect,
    taxConsequence: input.taxConsequence,
    findings: [...findings],
    consistent: findings.every((f) => HEALTHY_DISPUTE_FINDING_CODES.includes(f)),
    needsOperator: findings.some((f) => DISPUTE_FINDINGS_NEEDING_OPERATOR.includes(f)),
    evaluatedAt: input.at,
  };
}

/** Reconcile one dispute against every record it touches. */
export async function reconcileDispute(
  args: { disputeId: string; at: string },
  deps: DisputeReconciliationDeps = {},
): Promise<DisputeReconciliationResult> {
  const db = deps.db ?? getPrisma();
  try {
    const dispute = await db.transactionDispute.findUnique({ where: { id: args.disputeId } });
    if (dispute === null) {
      return finish({
        orderId: null,
        disputeId: args.disputeId,
        reversalId: null,
        refundId: null,
        providerDisputeRef: null,
        status: null,
        fundsState: null,
        economicEffect: null,
        taxConsequence: null,
        findings: ["NO_DISPUTE"],
        at: args.at,
      });
    }

    const status = dispute.status as DisputeStatus;
    const fundsState = dispute.fundsState as DisputeFundsState;
    const economicEffect = dispute.economicEffect as DisputeEconomicEffect;
    const taxConsequence = dispute.taxConsequence as DisputeTaxConsequence;
    const findings: DisputeReconciliationFindingCode[] = [];

    if (dispute.remediationCode !== null) {
      findings.push("DISPUTE_MANUAL_REMEDIATION_OUTSTANDING");
    }
    if (dispute.orderId === null || dispute.snapshotId === null) {
      findings.push("DISPUTE_UNATTRIBUTED");
      return finish({
        orderId: dispute.orderId,
        disputeId: dispute.id,
        reversalId: dispute.reversalId,
        refundId: null,
        providerDisputeRef: dispute.providerDisputeRef,
        status,
        fundsState,
        economicEffect,
        taxConsequence,
        findings,
        at: args.at,
      });
    }
    if (dispute.providerTransactionRef.length === 0) {
      findings.push("DISPUTE_MISSING_PAYMENT_REFERENCE");
    }

    const order = await db.order.findUnique({
      where: { id: dispute.orderId },
      select: { id: true, lifecycle: true, currency: true },
    });
    if (order !== null && order.lifecycle !== "PAID") findings.push("DISPUTE_ORDER_NOT_PAID");

    const snapshot = await db.transactionEconomicSnapshot.findUnique({
      where: { id: dispute.snapshotId },
    });
    if (snapshot !== null) {
      if (snapshot.currency !== dispute.currency) findings.push("DISPUTE_CURRENCY_MISMATCH");
      const charged = buyerChargedTotalMinorUnits({
        commercialRetailAmountMinorUnits: Number(snapshot.commercialRetailAmountMinorUnits),
        passThrough: {
          taxAmountMinorUnits: Number(snapshot.taxAmountMinorUnits),
          shippingAmountMinorUnits: Number(snapshot.shippingAmountMinorUnits),
          otherPassThroughAmountMinorUnits: Number(snapshot.otherPassThroughAmountMinorUnits),
        },
      });
      if (Number(dispute.disputedAmountMinorUnits) !== charged) {
        findings.push("DISPUTE_AMOUNT_MISMATCH");
      }
    }

    // — Refund interaction. The double-reversal checks. —
    const refund = await db.orderRefund.findUnique({ where: { orderId: dispute.orderId } });
    if (refund !== null) {
      if (refund.status === "REFUNDED" && (status === "LOST" || fundsState === "WITHDRAWN")) {
        findings.push("DISPUTE_ON_ALREADY_REFUNDED_SALE");
      }
      if (
        isDisputeOpen(status) &&
        ["PENDING", "IN_PROGRESS", "RETRY_PENDING"].includes(refund.status)
      ) {
        findings.push("DISPUTE_AND_REFUND_BOTH_IN_FLIGHT");
      }
    }

    // — Accounting. —
    const reversal = await db.transactionReversal.findUnique({
      where: { snapshotId: dispute.snapshotId },
    });
    if (status === "LOST" && reversal === null && economicEffect !== "ALREADY_REVERSED_BY_REFUND") {
      findings.push("DISPUTE_LOST_WITHOUT_ACCOUNTING_REVERSAL");
    }
    if (economicEffect === "REVERSED_BY_THIS_DISPUTE") {
      const settlement = await db.transactionSettlement.findUnique({
        where: { snapshotId: dispute.snapshotId },
      });
      if (settlement !== null && settlement.state !== "REVERSED") {
        findings.push("DISPUTE_SETTLEMENT_NOT_REVERSED");
      }
    }

    // — Proceeds. —
    const obligations = await db.proceedsObligation.findMany({
      where: { snapshotId: dispute.snapshotId },
    });
    const exceptions = await db.proceedsRecoveryException.findMany({
      where: { disputeId: dispute.id },
    });

    const live = NON_TERMINAL_DISPUTE_STATUSES.includes(status);
    if (live || status === "LOST") {
      if (obligations.some((o) => o.state === "ELIGIBLE")) {
        findings.push("DISPUTE_PROCEEDS_STILL_PAYOUT_ELIGIBLE");
      }
      for (const obligation of obligations) {
        if (obligation.state !== "PAID") continue;
        const covered = exceptions.some((e) => e.proceedsObligationId === obligation.id);
        if (covered) continue;
        findings.push("DISPUTE_PAID_PROCEEDS_LACK_RECOVERY");
        if (obligation.party === "PROMOTER") {
          findings.push("DISPUTE_PAID_PROMOTER_COMMISSION_LACKS_RECOVERY");
        }
      }
      if (live && obligations.some((o) => o.state === "PENDING") && findings.length === 0) {
        /* The hold is working. Named rather than silent, so an operator can see
           a payout is deliberately held rather than mysteriously stuck. */
        findings.push("DISPUTE_OPEN_PROCEEDS_HELD");
      }
    }

    if (status === "WON") {
      if (exceptions.some((e) => e.status === "OPEN" || e.status === "ACKNOWLEDGED")) {
        findings.push("DISPUTE_WON_STALE_RECOVERY_EXCEPTION");
      }
      /* A stale hold is impossible by construction — the payout gate computes
         the hold from this dispute's own status, so a won dispute lifts it with
         nothing to un-set. Checked anyway: the claim is worth being able to
         prove rather than merely assert. */
      const stillHeld = await db.transactionDispute.count({
        where: {
          snapshotId: dispute.snapshotId,
          status: { in: [...NON_TERMINAL_DISPUTE_STATUSES] },
        },
      });
      if (stillHeld > 0) findings.push("DISPUTE_WON_STALE_HOLD");
    }

    // — Tax. —
    if (taxConsequence === "REVERSAL_REQUIRED_NOT_EXPRESSIBLE") {
      findings.push("DISPUTE_TAX_CONSEQUENCE_UNRESOLVED");
      const taxTransaction = await db.orderTaxTransaction.findUnique({
        where: { orderId: dispute.orderId },
      });
      if (taxTransaction !== null && taxTransaction.lifecycleState === "RECORDED") {
        findings.push("DISPUTE_TAX_TRANSACTION_STILL_REPORTED");
      }
    }

    // — Internal coherence. —
    if ((status === "WON" || status === "CLOSED") && fundsState === "WITHDRAWN") {
      /* Funds gone on a dispute nobody lost. Legal in-flight for a moment, but
         not once the outcome is recorded. */
      findings.push("DISPUTE_STATE_CONTRADICTORY");
    }
    if (live && dispute.evidenceDueBy !== null && dispute.evidenceDueBy.getTime() <= Date.parse(args.at)) {
      findings.push("DISPUTE_DEADLINE_PASSED_UNRESOLVED");
    }
    if (status === "WON" || status === "CLOSED") {
      if (findings.length === 0) findings.push("DISPUTE_RESOLVED_NO_LIABILITY");
    } else if (live && findings.length === 0) {
      findings.push("DISPUTE_AWAITING_PROVIDER_DECISION");
    }

    return finish({
      orderId: dispute.orderId,
      disputeId: dispute.id,
      reversalId: dispute.reversalId,
      refundId: refund?.id ?? null,
      providerDisputeRef: dispute.providerDisputeRef,
      status,
      fundsState,
      economicEffect,
      taxConsequence,
      findings,
      at: args.at,
    });
  } catch (error) {
    if (error instanceof DisputeError) throw error;
    throw new DisputePersistenceFailureError("reconcileDispute", error);
  }
}

/** Reconcile every dispute that is not settled. */
export async function reconcileOpenDisputes(
  args: { at: string; limit?: number },
  deps: DisputeReconciliationDeps = {},
): Promise<DisputeReconciliationResult[]> {
  const db = deps.db ?? getPrisma();
  const rows = await db.transactionDispute.findMany({
    orderBy: { openedAt: "asc" },
    take: Math.max(1, Math.min(args.limit ?? 100, 500)),
    select: { id: true },
  });
  const out: DisputeReconciliationResult[] = [];
  for (const row of rows) {
    out.push(await reconcileDispute({ disputeId: row.id, at: args.at }, deps));
  }
  return out;
}

export function summarizeDisputeReconciliation(
  results: readonly DisputeReconciliationResult[],
): DisputeReconciliationSummary {
  const findingCounts: Record<string, number> = {};
  for (const result of results) {
    for (const finding of result.findings) {
      findingCounts[finding] = (findingCounts[finding] ?? 0) + 1;
    }
  }
  return {
    reconciled: results.length,
    consistent: results.filter((r) => r.consistent).length,
    needingOperator: results.filter((r) => r.needsOperator).length,
    findingCounts,
  };
}
