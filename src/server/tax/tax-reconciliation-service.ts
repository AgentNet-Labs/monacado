/**
 * Tax reconciliation (Phase 1.7) — SERVER ONLY.
 *
 * Compares the four things Monacado knows about one sale's tax and reports where
 * they disagree. **Reads only. Writes nothing, retries nothing, repairs
 * nothing.**
 *
 * ```
 * Order  ·  OrderTaxEvidence  ·  OrderTaxTransaction  ·  provider reference/state
 * ```
 *
 * ## No provider call
 *
 * Routine reconciliation consults **Monacado's own rows and nothing else** — which
 * is precisely what `1.7`'s audit-efficient persistence exists to make possible.
 * A reconciler that had to ask Stripe would stop working when a credential
 * rotated, would put a rate-limited network call behind an operations page, and
 * would be unusable for the bulk sweep an operator actually wants.
 *
 * The provider *reference* and the recorded status are compared; the provider's
 * own view is not fetched. `PROVIDER_AUDIT_SEAM` records that a deeper audit is a
 * later, explicit operation.
 *
 * ## It reports; it never reconciles anything into agreement
 *
 * A divergence between two authoritative records is a fact somebody must decide
 * about. Quietly fixing one would destroy the evidence that they ever disagreed —
 * and in a tax context that evidence is the whole point.
 *
 * ## Every finding, not the first
 *
 * The same rule the risk gate and the readiness check follow. An Order whose
 * currency *and* amount disagree has two problems, and reporting one would send
 * an operator back for the second.
 */

import "../server-only";
import {
  TaxReconciliationResult,
  type TaxReconciliationFindingCode,
} from "../../contracts/marketplace/tax-reconciliation";
import { getPrisma } from "../db/client";
import { TaxError } from "./tax-errors";

type Db = ReturnType<typeof getPrisma>;

export interface TaxReconciliationDeps {
  db?: Db;
}

/**
 * Reconcile one Order's tax.
 *
 * Returns `null` for an Order that does not exist. An Order that is not `PAID`
 * is `CONSISTENT` by construction: nothing is owed to a tax provider for a sale
 * that never completed, and reporting a pending checkout as a gap would bury the
 * paid ones that are.
 */
export async function reconcileOrderTax(
  orderId: string,
  at: string,
  deps: TaxReconciliationDeps = {},
): Promise<TaxReconciliationResult | null> {
  const db = deps.db ?? getPrisma();

  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      lifecycle: true,
      currency: true,
      internalProductId: true,
      quotedTaxAmountMinorUnits: true,
      quotedCommercialRetailAmountMinorUnits: true,
      quotedShippingAmountMinorUnits: true,
    },
  });
  if (order === null) return null;

  const evidence = await db.orderTaxEvidence.findUnique({ where: { orderId } });
  const transaction = await db.orderTaxTransaction.findUnique({ where: { orderId } });

  const findings: TaxReconciliationFindingCode[] = [];

  /* An unpaid Order owes a tax provider nothing. Reporting one as a gap would
     bury the paid Orders that genuinely are. */
  if (order.lifecycle !== "PAID") {
    return TaxReconciliationResult.parse({
      orderId,
      taxEvidenceId: evidence?.id ?? null,
      taxTransactionId: transaction?.id ?? null,
      providerTaxTransactionRef: transaction?.providerTaxTransactionRef ?? null,
      findings: ["CONSISTENT"],
      consistent: true,
      evaluatedAt: at,
    });
  }

  if (evidence === null) findings.push("PAID_ORDER_MISSING_TAX_EVIDENCE");

  if (transaction === null) {
    findings.push("PAID_ORDER_MISSING_TAX_TRANSACTION");
  } else {
    // — Recording lifecycle —
    if (transaction.recordingStatus === "FAILED_PERMANENT") {
      findings.push("TAX_TRANSACTION_RECORDING_FAILED");
    } else if (transaction.recordingStatus !== "RECORDED") {
      findings.push("TAX_TRANSACTION_NOT_RECORDED");
    }

    // — Against the Order —
    if (transaction.currency !== order.currency) findings.push("CURRENCY_MISMATCH");
    if (Number(transaction.taxAmountMinorUnits) !== Number(order.quotedTaxAmountMinorUnits)) {
      findings.push("TAX_AMOUNT_MISMATCH");
    }
    const orderBasis =
      Number(order.quotedCommercialRetailAmountMinorUnits) +
      Number(order.quotedShippingAmountMinorUnits);
    if (Number(transaction.taxableBasisMinorUnits) !== orderBasis) {
      findings.push("TAXABLE_BASIS_MISMATCH");
    }
    if (transaction.internalProductId !== order.internalProductId) {
      findings.push("PRODUCT_VERSION_MISMATCH");
    }

    // — Against the calculation evidence —
    if (evidence !== null) {
      if (transaction.providerCalculationRef !== evidence.providerCalculationRef) {
        /* The transaction claims to have been created from a calculation the
           evidence does not name. Two records pointing at different provider
           objects for one sale is the clearest possible corruption signal. */
        findings.push("CONFLICTING_PROVIDER_REFERENCE");
      }
      if (transaction.currency !== evidence.currency) findings.push("CURRENCY_MISMATCH");
      if (
        Number(transaction.taxAmountMinorUnits) !== Number(evidence.taxAmountMinorUnits)
      ) {
        findings.push("TAX_AMOUNT_MISMATCH");
      }
      if (
        Number(transaction.taxableBasisMinorUnits) !== Number(evidence.basisAmountMinorUnits)
      ) {
        findings.push("TAXABLE_BASIS_MISMATCH");
      }
      if (
        evidence.productSourceRecordVersion !== null &&
        transaction.productSourceRecordVersion !== evidence.productSourceRecordVersion
      ) {
        findings.push("PRODUCT_VERSION_MISMATCH");
      }
      if (
        evidence.jurisdictionCode !== null &&
        transaction.jurisdictionCode !== evidence.jurisdictionCode
      ) {
        findings.push("JURISDICTION_MISMATCH");
      }
    }

    // — The provider's own arithmetic, as it represented it —
    if (transaction.recordingStatus === "RECORDED") {
      if (transaction.providerTaxTransactionRef === null) {
        findings.push("CONFLICTING_PROVIDER_REFERENCE");
      }
      const total = transaction.providerTotalAmountMinorUnits;
      if (
        total === null ||
        Number(total) !==
          Number(transaction.taxableBasisMinorUnits) + Number(transaction.taxAmountMinorUnits)
      ) {
        findings.push("PROVIDER_TOTAL_MISMATCH");
      }
    }
  }

  const unique = Array.from(new Set(findings));
  return TaxReconciliationResult.parse({
    orderId,
    taxEvidenceId: evidence?.id ?? null,
    taxTransactionId: transaction?.id ?? null,
    providerTaxTransactionRef: transaction?.providerTaxTransactionRef ?? null,
    findings: unique.length === 0 ? ["CONSISTENT"] : unique,
    consistent: unique.length === 0,
    evaluatedAt: at,
  });
}

/**
 * Reconcile a bounded sweep of paid Orders, newest first.
 *
 * Bounded deliberately: an unbounded sweep over every Order that ever completed
 * is a query nobody can run twice, and an operator wants the recent ones. The cap
 * is reported by the caller rather than silently applied — a truncated sweep that
 * reads as "everything is fine" is worse than no sweep.
 */
export async function reconcilePaidOrderTax(
  args: { at: string; limit?: number },
  deps: TaxReconciliationDeps = {},
): Promise<TaxReconciliationResult[]> {
  const db = deps.db ?? getPrisma();
  const limit = Math.max(1, Math.min(args.limit ?? 100, 500));
  try {
    const orders = await db.order.findMany({
      where: { lifecycle: "PAID" },
      select: { id: true },
      orderBy: { paidAt: "desc" },
      take: limit,
    });
    const results: TaxReconciliationResult[] = [];
    for (const order of orders) {
      const result = await reconcileOrderTax(order.id, args.at, deps);
      if (result !== null) results.push(result);
    }
    return results;
  } catch (error) {
    if (error instanceof TaxError) throw error;
    throw new TaxError("TAX_RECONCILIATION_FAILURE", "Tax reconciliation could not be completed");
  }
}

/** A sweep reduced to counts, for a readiness or operations summary. */
export function summarizeTaxReconciliation(results: readonly TaxReconciliationResult[]): {
  reconciled: number;
  consistent: number;
  inconsistent: number;
  findingCounts: Record<string, number>;
} {
  const findingCounts: Record<string, number> = {};
  let consistent = 0;
  for (const result of results) {
    if (result.consistent) consistent += 1;
    for (const finding of result.findings) {
      if (finding === "CONSISTENT") continue;
      findingCounts[finding] = (findingCounts[finding] ?? 0) + 1;
    }
  }
  return {
    reconciled: results.length,
    consistent,
    inconsistent: results.length - consistent,
    findingCounts,
  };
}
