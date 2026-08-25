/**
 * Tax reconciliation findings (Phase 1.7).
 *
 * One question, asked of local records only: **do the four things Monacado knows
 * about one sale's tax agree with each other?**
 *
 * ```
 * Order  ·  OrderTaxEvidence  ·  OrderTaxTransaction  ·  provider reference/state
 * ```
 *
 * ## It reads Monacado's own records
 *
 * Routine reconciliation makes **no provider call**. Every fact it compares is
 * already persisted — deliberately, because that is what `1.7`'s audit-efficient
 * persistence is *for*. A reconciliation that had to ask Stripe to render a page
 * would be one that stops working when a credential rotates, and would put a
 * rate-limited network call behind an operations screen.
 *
 * The provider *reference* and the recorded status are compared; the provider is
 * not consulted. A deeper audit that does fetch the provider's own view is a
 * later, deliberate operation — named here as a seam, not built.
 *
 * ## Findings, not repairs
 *
 * Every function here **reports**. Nothing writes, retries, corrects, or
 * reconciles anything into agreement. A divergence between two authoritative
 * records is a fact somebody must decide about, and a reconciler that quietly
 * fixed one would destroy the evidence that they ever disagreed.
 *
 * Pure types and pure decisions. No I/O, no clock, no vendor.
 */

import { z } from "zod";

/**
 * What a reconciliation can conclude about one sale.
 *
 * A closed vocabulary of bounded codes — safe to log, safe to render on an
 * operations page, carrying no amount, address, or credential. The amounts that
 * differ are reachable from the records the finding names.
 */
export const TAX_RECONCILIATION_FINDING_CODES = [
  /** Everything agrees. The only non-finding. */
  "CONSISTENT",
  /** A paid Order with no tax transaction record at all. */
  "PAID_ORDER_MISSING_TAX_TRANSACTION",
  /** A tax transaction committed but never reported to the provider. */
  "TAX_TRANSACTION_NOT_RECORDED",
  /** Reporting is out of attempts, or permanently refused. Needs an operator. */
  "TAX_TRANSACTION_RECORDING_FAILED",
  /** A paid Order with no `1.6` calculation evidence to report from. */
  "PAID_ORDER_MISSING_TAX_EVIDENCE",
  /**
   * Two records name different provider transactions, or a transaction claims a
   * calculation its evidence does not.
   */
  "CONFLICTING_PROVIDER_REFERENCE",
  /** The transaction's basis does not equal the Order's commercial basis. */
  "TAXABLE_BASIS_MISMATCH",
  /** The transaction's tax amount does not equal the Order's quoted tax. */
  "TAX_AMOUNT_MISMATCH",
  /** The provider's represented total does not reconcile to basis + tax. */
  "PROVIDER_TOTAL_MISMATCH",
  /** Two records disagree about the currency of one sale. */
  "CURRENCY_MISMATCH",
  /** The transaction pins a different Product, or a different source version. */
  "PRODUCT_VERSION_MISMATCH",
  /** The transaction was reported under a different jurisdiction than sourced. */
  "JURISDICTION_MISMATCH",
] as const;
export const TaxReconciliationFindingCode = z.enum(TAX_RECONCILIATION_FINDING_CODES);
export type TaxReconciliationFindingCode = z.infer<typeof TaxReconciliationFindingCode>;

/** Findings that mean a sale's tax is not yet fully and correctly reported. */
export const UNRESOLVED_TAX_FINDING_CODES: readonly TaxReconciliationFindingCode[] =
  TAX_RECONCILIATION_FINDING_CODES.filter((code) => code !== "CONSISTENT");

/**
 * One sale's reconciliation result.
 *
 * Names the records rather than restating their contents — an operator following
 * a finding reads the authoritative rows, and a finding that carried copies would
 * be a fifth thing able to disagree with the four it is about.
 */
export const TaxReconciliationResult = z.strictObject({
  orderId: z.string().min(1).max(191),
  taxEvidenceId: z.string().min(1).max(191).nullable(),
  taxTransactionId: z.string().min(1).max(191).nullable(),
  /** The provider's Tax Transaction, where one has been recorded. */
  providerTaxTransactionRef: z.string().min(1).max(191).nullable(),
  /** Every finding, not the first — the same rule the risk gate follows. */
  findings: z.array(TaxReconciliationFindingCode).min(1),
  consistent: z.boolean(),
  evaluatedAt: z.iso.datetime(),
});
export type TaxReconciliationResult = z.infer<typeof TaxReconciliationResult>;

/**
 * A deeper audit that consults the provider's own view of a transaction.
 *
 * **Not implemented**, and stated as a value so a later reader can check what was
 * claimed against what was built. Routine reconciliation is local by design; when
 * a provider-side audit is built it belongs behind an explicit operator action,
 * not inside a page render.
 */
export const PROVIDER_AUDIT_SEAM = {
  routineReconciliation: "LOCAL_RECORDS_ONLY",
  providerLookup: "NOT_IMPLEMENTED",
  intendedTrigger: "EXPLICIT_OPERATOR_AUDIT",
} as const;
