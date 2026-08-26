/**
 * Refund reconciliation (Phase 1.9) — SERVER ONLY.
 *
 * Compares everything Monacado knows about one sale's refund and reports where
 * the records disagree. **Reads only. Writes nothing, retries nothing, refunds
 * nothing, repairs nothing.**
 *
 * ```
 * Order · TransactionSettlement · OrderRefund · TransactionReversal
 *       · OrderTaxTransaction   · OrderTaxReversal · ProceedsObligation
 * ```
 *
 * ## No provider call
 *
 * Routine reconciliation consults **Monacado's own rows and nothing else** —
 * which is precisely what the audit-efficient refund and reversal records exist
 * to make possible. A reconciler that had to ask Stripe would stop working when a
 * credential rotated, would put a rate-limited network call behind an operations
 * page, and would be unusable for the bulk sweep an operator actually wants.
 *
 * ## It reports; it never reconciles anything into agreement
 *
 * A divergence between two authoritative financial records is a fact somebody
 * must decide about. Quietly fixing one would destroy the evidence that they ever
 * disagreed — and in a refund context that evidence is what a chargeback defence
 * rests on.
 *
 * ## Every finding, not the first
 *
 * The same rule the risk gate, the readiness check, and `1.7`'s tax reconciler
 * follow. A refund whose amount *and* currency disagree has two problems, and
 * reporting one would send an operator back for the second.
 */

import "../server-only";
import {
  RefundReconciliationResult,
  refundFindingNeedsOperator,
  HEALTHY_REFUND_FINDING_CODES,
  type RefundReconciliationFindingCode,
} from "../../contracts/marketplace/refund-reconciliation";
import {
  refundLifecycleState,
  type RefundLifecycleState,
  type RefundReasonCode,
  type RefundStatus,
} from "../../contracts/marketplace/order-refund";
import {
  shippingIsRefundable,
  type ShippingRefundability,
} from "../../contracts/marketplace/seller-refund-policy";
import type { TaxReversalStatus } from "../../contracts/marketplace/tax-reversal";
import { getPrisma } from "../db/client";
import { RefundError, RefundPersistenceFailureError } from "./refund-errors";

type Db = ReturnType<typeof getPrisma>;

export interface RefundReconciliationDeps {
  db?: Db;
}

/**
 * Reconcile one Order's refund.
 *
 * Returns `null` for an Order that does not exist. An Order that is not `PAID` is
 * `CONSISTENT` by construction: nothing was taken, so nothing can be owed back,
 * and reporting a pending checkout as a refund gap would bury the paid ones that
 * genuinely are.
 */
export async function reconcileOrderRefund(
  orderId: string,
  at: string,
  deps: RefundReconciliationDeps = {},
): Promise<RefundReconciliationResult | null> {
  const db = deps.db ?? getPrisma();

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      lifecycle: true,
      currency: true,
      quotedCommercialRetailAmountMinorUnits: true,
      quotedTaxAmountMinorUnits: true,
      quotedShippingAmountMinorUnits: true,
      quotedOtherPassThroughAmountMinorUnits: true,
      sellerRefundPolicyId: true,
      sellerRefundPolicyVersion: true,
      promoterParticipantId: true,
    },
  });
  if (order === null) return null;

  const refund = await db.orderRefund.findUnique({
    where: { orderId },
    include: { lines: { select: { lineRef: true, commercialRetailAmountMinorUnits: true, taxAmountMinorUnits: true } } },
  });

  if (order.lifecycle !== "PAID") {
    return finish({
      orderId,
      at,
      refundId: refund?.id ?? null,
      findings: ["CONSISTENT"],
    });
  }

  if (refund === null) {
    /* The ordinary case. Named rather than silent, so a sweep can distinguish
       "no refund" from "reconciled and complete" without inferring it. */
    return finish({ orderId, at, findings: ["PAID_ORDER_NO_REFUND"] });
  }

  const findings: RefundReconciliationFindingCode[] = [];

  const snapshot = await db.transactionEconomicSnapshot.findUnique({
    where: { orderId },
    select: { id: true },
  });
  if (snapshot === null) findings.push("MISSING_ECONOMIC_SNAPSHOT");

  const settlement =
    snapshot === null
      ? null
      : await db.transactionSettlement.findUnique({
          where: { snapshotId: snapshot.id },
          select: { state: true, providerTransactionRef: true },
        });

  const taxTransaction = await db.orderTaxTransaction.findUnique({
    where: { orderId },
    select: { id: true, recordingStatus: true, providerTaxTransactionRef: true, currency: true },
  });
  const taxReversal = await db.orderTaxReversal.findUnique({ where: { orderId } });

  const refundStatus = refund.status as RefundStatus;
  const taxReversalStatus = (taxReversal?.status ?? null) as TaxReversalStatus | null;
  const lifecycleState: RefundLifecycleState = refundLifecycleState({
    refundStatus,
    taxReversalStatus,
  });

  // — The payment refund's own lifecycle —
  if (refundStatus === "FAILED_PERMANENT") {
    findings.push("PAYMENT_REFUND_FAILED");
  } else if (refundStatus !== "REFUNDED") {
    findings.push("REFUND_PENDING");
  }

  // — The refund's own parts must sum to what it returned —
  //
  // NOT "must equal the whole Order charge". That invariant is gone: the refund
  // unit is a line set, and a refund of some lines, or of every line minus
  // non-refundable shipping, is correct rather than a mismatch.
  const lineRetail = refund.lines.reduce(
    (sum, l) => sum + Number(l.commercialRetailAmountMinorUnits),
    0,
  );
  const lineTax = refund.lines.reduce((sum, l) => sum + Number(l.taxAmountMinorUnits), 0);

  if (
    lineRetail !== Number(refund.linesRetailMinorUnits) ||
    lineTax !== Number(refund.linesTaxMinorUnits)
  ) {
    /* The stored breakdown does not agree with the lines it was derived from. */
    findings.push("LINE_ECONOMICS_DO_NOT_RECONCILE");
  }
  if (
    Number(refund.amountMinorUnits) !==
    Number(refund.linesRetailMinorUnits) +
      Number(refund.linesTaxMinorUnits) +
      Number(refund.refundedShippingMinorUnits)
  ) {
    /* What moved at the provider does not equal the parts it was composed from. */
    findings.push("REFUND_AMOUNT_MISMATCH");
  }
  if (refund.lines.length === 0) findings.push("LINE_ECONOMICS_DO_NOT_RECONCILE");
  if (refund.currency !== order.currency) findings.push("CURRENCY_MISMATCH");

  // — The bound seller policy, and what it says about shipping —
  if (order.sellerRefundPolicyId === null || order.sellerRefundPolicyVersion === null) {
    findings.push("REFUND_POLICY_VERSION_MISSING");
  } else if (
    refund.sellerRefundPolicyId !== order.sellerRefundPolicyId ||
    refund.sellerRefundPolicyVersion !== order.sellerRefundPolicyVersion
  ) {
    /* The refund was executed under terms other than the ones the buyer was
       shown. The single worst policy failure available here. */
    findings.push("REFUND_POLICY_VERSION_MISMATCH");
  } else {
    const policyRow = await db.sellerRefundPolicyVersionRow.findUnique({
      where: {
        policyId_policyVersion: {
          policyId: refund.sellerRefundPolicyId,
          policyVersion: refund.sellerRefundPolicyVersion,
        },
      },
      select: { shippingRefundability: true },
    });
    if (policyRow === null) {
      findings.push("REFUND_POLICY_VERSION_MISSING");
    } else {
      /* Re-derived from the bound policy through the SINGLE implementation of
         the shipping rule, so the reconciler cannot disagree with the derivation
         by carrying a second copy of it. */
      const shouldRefundShipping =
        shippingIsRefundable({
          shippingRefundability: policyRow.shippingRefundability as ShippingRefundability,
          reasonCode: refund.reasonCode as RefundReasonCode,
        }) && refund.coversWholeOrder;
      const expectedShipping = shouldRefundShipping
        ? Number(order.quotedShippingAmountMinorUnits)
        : 0;
      if (Number(refund.refundedShippingMinorUnits) !== expectedShipping) {
        /* Either the buyer kept money the seller's terms said they would not, or
           lost money the terms promised back. */
        findings.push("SHIPPING_TREATMENT_CONTRADICTS_POLICY");
      }
    }
  }

  /* The refund must still name the charge the settlement row records. Two
     records pointing at different provider objects for one sale is the clearest
     possible corruption signal. */
  if (
    settlement !== null &&
    settlement.providerTransactionRef !== null &&
    settlement.providerTransactionRef !== refund.providerTransactionRef
  ) {
    findings.push("CONFLICTING_PROVIDER_REFERENCE");
  }

  // — What a completed refund must have brought with it —
  if (refundStatus === "REFUNDED") {
    if (refund.reversalId === null) {
      /* Money returned with no `1.2` accounting entry. The books say the sale
         still stands, which is the state every payout gate reads. */
      findings.push("REFUND_WITHOUT_ACCOUNTING_REVERSAL");
    }
    if (settlement !== null && settlement.state !== "REVERSED") {
      findings.push("SETTLEMENT_NOT_REVERSED");
    }

    if (taxReversal === null) {
      /* A refunded sale whose tax WAS reported and which has no reversal record.
         Distinguished from a sale that was never reported: only the former is a
         gap, and only the former can be closed. */
      if (
        taxTransaction !== null &&
        taxTransaction.recordingStatus === "RECORDED" &&
        taxTransaction.providerTaxTransactionRef !== null
      ) {
        findings.push("ORIGINAL_TAX_TRANSACTION_MISSING");
      }
    } else {
      if (taxReversalStatus === "FAILED_PERMANENT") {
        findings.push("TAX_REVERSAL_FAILED");
      } else if (taxReversalStatus !== "REVERSED") {
        /* The single most important finding here. Expected BRIEFLY — the two
           provider calls are sequential — and a real problem if it persists. */
        findings.push("PAYMENT_REFUNDED_TAX_NOT_REVERSED");
      }

      if (
        taxTransaction !== null &&
        taxTransaction.providerTaxTransactionRef !== null &&
        taxTransaction.providerTaxTransactionRef !==
          taxReversal.originalProviderTaxTransactionRef
      ) {
        /* The reversal names a transaction its own `1.7` record does not. */
        findings.push("CONFLICTING_PROVIDER_REFERENCE");
      }
      if (taxTransaction !== null && taxTransaction.currency !== taxReversal.currency) {
        findings.push("CURRENCY_MISMATCH");
      }
    }

    /* The tax reversed must be the tax on the lines that came back.
       Today one line, so it is the whole transaction's tax; the check is written
       against the LINES rather than the Order so it keeps meaning something when
       a subset refund becomes executable. */
    if (taxReversal !== null) {
      if (Number(taxReversal.reversedTaxAmountMinorUnits) !== lineTax) {
        findings.push("TAX_REVERSAL_DOES_NOT_MATCH_REFUNDED_LINES");
      }
    }

    /* Proceeds that are still payout-eligible on a refunded sale.
       `advanceProceedsObligation` refuses to MAKE one eligible once a reversal
       exists, so this means the claim was already eligible when the refund
       landed — exactly what `ProceedsRecoveryException` exists to surface.
       Seller and promoter are reported separately, because a promoter commission
       paying out on a returned sale is a marketplace expense nobody authorised
       and an operator chasing one should not have to infer which party. */
    if (snapshot !== null) {
      const obligations = await db.proceedsObligation.findMany({
        where: { snapshotId: snapshot.id },
        select: { id: true, party: true, state: true },
      });
      const exceptions = await db.proceedsRecoveryException.findMany({
        where: { refundId: refund.id },
        select: { proceedsObligationId: true },
      });
      const covered = new Set(exceptions.map((e) => e.proceedsObligationId));

      for (const obligation of obligations) {
        if (obligation.state === "ELIGIBLE") {
          findings.push(
            obligation.party === "PROMOTER"
              ? "PROMOTER_COMMISSION_STILL_PAYABLE"
              : "PROCEEDS_STILL_PAYOUT_ELIGIBLE",
          );
        }
        if (
          (obligation.state === "PAID" || obligation.state === "ELIGIBLE") &&
          !covered.has(obligation.id)
        ) {
          /* Money already committed to a party on a sale that came back, with no
             durable recovery evidence beside it. For a promoter that is a
             commission silently absorbed into Monacado's economics — which
             `1.9` refuses to let happen quietly. */
          if (obligation.party === "PROMOTER") {
            findings.push("PAID_PROMOTER_COMMISSION_LACKS_RECOVERY");
          }
        }
      }
    }
  }

  return finish({
    orderId,
    at,
    refundId: refund.id,
    taxReversalId: taxReversal?.id ?? null,
    reversalId: refund.reversalId,
    providerRefundRef: refund.providerRefundRef,
    providerTaxReversalRef: taxReversal?.providerReversalRef ?? null,
    lifecycleState,
    sellerRefundPolicyId: refund.sellerRefundPolicyId,
    sellerRefundPolicyVersion: refund.sellerRefundPolicyVersion,
    refundedLineRefs: refund.lines.map((l) => l.lineRef),
    findings,
  });
}

interface FinishArgs {
  orderId: string;
  at: string;
  refundId?: string | null;
  taxReversalId?: string | null;
  reversalId?: string | null;
  providerRefundRef?: string | null;
  providerTaxReversalRef?: string | null;
  lifecycleState?: RefundLifecycleState | null;
  sellerRefundPolicyId?: string | null;
  sellerRefundPolicyVersion?: string | null;
  refundedLineRefs?: readonly string[];
  findings: readonly RefundReconciliationFindingCode[];
}

function finish(args: FinishArgs): RefundReconciliationResult {
  const {
    orderId,
    at,
    refundId = null,
    taxReversalId = null,
    reversalId = null,
    providerRefundRef = null,
    providerTaxReversalRef = null,
    lifecycleState = null,
    sellerRefundPolicyId = null,
    sellerRefundPolicyVersion = null,
    refundedLineRefs = [],
    findings,
  } = args;
  const unique = Array.from(new Set(findings));
  const resolved = unique.length === 0 ? (["CONSISTENT"] as const) : unique;
  return RefundReconciliationResult.parse({
    orderId,
    refundId,
    taxReversalId,
    reversalId,
    providerRefundRef,
    providerTaxReversalRef,
    lifecycleState,
    sellerRefundPolicyId,
    sellerRefundPolicyVersion,
    refundedLineRefs: [...refundedLineRefs],
    findings: resolved,
    consistent: resolved.every((f) => HEALTHY_REFUND_FINDING_CODES.includes(f)),
    needsOperator: resolved.some(refundFindingNeedsOperator),
    evaluatedAt: at,
  });
}

/**
 * Reconcile a bounded sweep of paid Orders, newest first.
 *
 * Bounded deliberately, on `1.7`'s reasoning: an unbounded sweep over every Order
 * that ever completed is a query nobody can run twice, and an operator wants the
 * recent ones. The cap is reported by the caller rather than silently applied — a
 * truncated sweep that reads as "everything is fine" is worse than no sweep.
 */
export async function reconcilePaidOrderRefunds(
  args: { at: string; limit?: number; refundedOnly?: boolean },
  deps: RefundReconciliationDeps = {},
): Promise<RefundReconciliationResult[]> {
  const db = deps.db ?? getPrisma();
  const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
  try {
    const orders = await db.order.findMany({
      where: {
        lifecycle: "PAID",
        /* An operator chasing refund problems does not want every sale that was
           never refunded. Off by default so a launch review sees the whole set. */
        ...(args.refundedOnly === true ? { refund: { isNot: null } } : {}),
      },
      select: { id: true },
      orderBy: { paidAt: "desc" },
      take: limit,
    });
    const results: RefundReconciliationResult[] = [];
    for (const order of orders) {
      const result = await reconcileOrderRefund(order.id, args.at, deps);
      if (result !== null) results.push(result);
    }
    return results;
  } catch (error) {
    if (error instanceof RefundError) throw error;
    throw new RefundPersistenceFailureError("reconcilePaidOrderRefunds", error);
  }
}

/** A sweep reduced to counts, for a readiness or operations summary. */
export function summarizeRefundReconciliation(
  results: readonly RefundReconciliationResult[],
): {
  reconciled: number;
  consistent: number;
  needingOperator: number;
  findingCounts: Record<string, number>;
} {
  const findingCounts: Record<string, number> = {};
  let consistent = 0;
  let needingOperator = 0;
  for (const result of results) {
    if (result.consistent) consistent += 1;
    if (result.needsOperator) needingOperator += 1;
    for (const finding of result.findings) {
      if (finding === "CONSISTENT") continue;
      findingCounts[finding] = (findingCounts[finding] ?? 0) + 1;
    }
  }
  return {
    reconciled: results.length,
    consistent,
    needingOperator,
    findingCounts,
  };
}
