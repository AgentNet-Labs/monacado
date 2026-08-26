/**
 * Refund reconciliation findings (Phase 1.9).
 *
 * One question, asked of local records only: **do the things Monacado knows about
 * one sale's refund agree with each other?**
 *
 * ```
 * Order · TransactionSettlement · OrderRefund · TransactionReversal
 *       · OrderTaxTransaction   · OrderTaxReversal · ProceedsObligation
 * ```
 *
 * ## It reads Monacado's own records
 *
 * Routine reconciliation makes **no provider call**, on `1.7`'s terms exactly and
 * for the same reasons: a reconciler that had to ask Stripe stops working when a
 * credential rotates, puts a rate-limited network call behind an operations
 * screen, and is unusable for the bulk sweep an operator actually wants. Every
 * fact compared here is already persisted, which is what the audit-efficient
 * refund and reversal records exist for.
 *
 * ## Findings, not repairs
 *
 * Every function here **reports**. Nothing writes, retries, refunds, reverses, or
 * reconciles anything into agreement. A divergence between two authoritative
 * financial records is a fact somebody must decide about, and a reconciler that
 * quietly fixed one would destroy the evidence that they ever disagreed.
 *
 * ## Not every finding is a defect
 *
 * A paid Order with no refund is the *normal* case, and a refund still in flight
 * is not a problem. Collapsing those into "inconsistent" would drown the two
 * findings that matter — a payment refunded whose tax was not reversed, and a
 * refunded sale whose proceeds are still payout-eligible — in a sea of healthy
 * sales. So `consistent` excludes the healthy states, and
 * `REFUND_FINDINGS_NEEDING_OPERATOR` names the subset that needs a human.
 *
 * Pure types and pure decisions. No I/O, no clock, no vendor.
 */

import { z } from "zod";
import { RefundLifecycleState } from "./order-refund";

/**
 * What a reconciliation can conclude about one sale's refund.
 *
 * A closed vocabulary of bounded codes — safe to log, safe to render on an
 * operations page, carrying no amount, address, or credential. The amounts that
 * differ are reachable from the records the finding names.
 */
export const REFUND_RECONCILIATION_FINDING_CODES = [
  // — Healthy —
  /** Everything agrees, and the refund lifecycle has completed. */
  "CONSISTENT",
  /** A paid Order with no refund. The ordinary case, and not a defect. */
  "PAID_ORDER_NO_REFUND",
  /** A refund is in flight and has not failed. Not a defect. */
  "REFUND_PENDING",

  // — In flight, but worth naming —
  /**
   * The money went back and the sale's tax stands reported as though it had not.
   *
   * The single most important finding this vocabulary has. It is expected
   * *briefly* — the two provider calls are sequential — and it is a real problem
   * if it persists, which is why it is a named finding rather than an absence.
   */
  "PAYMENT_REFUNDED_TAX_NOT_REVERSED",

  // — Defects —
  /** The payment refund is out of attempts, or permanently refused. */
  "PAYMENT_REFUND_FAILED",
  /** The tax reversal is out of attempts, or permanently refused. */
  "TAX_REVERSAL_FAILED",
  /** The refund amount does not equal what the Order actually charged. */
  "REFUND_AMOUNT_MISMATCH",
  /** Two records disagree about the currency of one sale. */
  "CURRENCY_MISMATCH",
  /** A refunded sale whose tax was reported and which has no reversal record. */
  "ORIGINAL_TAX_TRANSACTION_MISSING",
  /**
   * Two records name different provider objects, or a reversal names a
   * transaction its `1.7` record does not.
   */
  "CONFLICTING_PROVIDER_REFERENCE",
  /** A completed payment refund with no `1.2` accounting entry beside it. */
  "REFUND_WITHOUT_ACCOUNTING_REVERSAL",
  /** A refunded sale with no bound economic snapshot. */
  "MISSING_ECONOMIC_SNAPSHOT",
  /**
   * A refunded sale whose seller or promoter claim is still payout-eligible.
   *
   * `advanceProceedsObligation` refuses to *make* one eligible on a reversed
   * sale, so this means the claim was already eligible when the refund landed —
   * exactly the case `ProceedsRecoveryException` exists to surface.
   */
  "PROCEEDS_STILL_PAYOUT_ELIGIBLE",
  /** A refunded sale whose settlement row does not say `REVERSED`. */
  "SETTLEMENT_NOT_REVERSED",

  // — Seller policy and promoter economics (Phase 1.9 correction) —
  /**
   * The refund names no seller refund-policy version, or names one the Order
   * does not.
   *
   * The refund would have been executed under terms nobody can point at, or under
   * terms other than the ones the buyer was shown.
   */
  "REFUND_POLICY_VERSION_MISSING",
  "REFUND_POLICY_VERSION_MISMATCH",
  /**
   * Shipping was refunded where the bound policy withholds it, or withheld where
   * the bound policy returns it.
   *
   * The most consequential of the policy findings: a buyer either kept money the
   * seller's terms said they would not, or lost money the terms promised back.
   */
  "SHIPPING_TREATMENT_CONTRADICTS_POLICY",
  /**
   * A promoter's commission on a refunded line is still payable.
   *
   * `advanceProceedsObligation` refuses to *make* one eligible on a reversed
   * sale, so this means it was already eligible when the refund landed — and a
   * commission that pays out on a returned sale is a marketplace expense nobody
   * authorised.
   */
  "PROMOTER_COMMISSION_STILL_PAYABLE",
  /** An already-paid promoter commission with no recovery exception beside it. */
  "PAID_PROMOTER_COMMISSION_LACKS_RECOVERY",
  /** The refund's own line amounts do not sum to what it returned. */
  "LINE_ECONOMICS_DO_NOT_RECONCILE",
  /** The tax reversed does not equal the tax on the refunded lines. */
  "TAX_REVERSAL_DOES_NOT_MATCH_REFUNDED_LINES",
] as const;
export const RefundReconciliationFindingCode = z.enum(REFUND_RECONCILIATION_FINDING_CODES);
export type RefundReconciliationFindingCode = z.infer<typeof RefundReconciliationFindingCode>;

/** Findings that describe a healthy sale. Everything else means work outstanding. */
export const HEALTHY_REFUND_FINDING_CODES: readonly RefundReconciliationFindingCode[] = [
  "CONSISTENT",
  "PAID_ORDER_NO_REFUND",
  "REFUND_PENDING",
];

/**
 * Findings a human has to act on.
 *
 * Deliberately excludes `PAYMENT_REFUNDED_TAX_NOT_REVERSED`, which a retry
 * resolves on its own — until it does not, at which point
 * `TAX_REVERSAL_FAILED` appears beside it and *is* on this list.
 */
export const REFUND_FINDINGS_NEEDING_OPERATOR: readonly RefundReconciliationFindingCode[] = [
  "PAYMENT_REFUND_FAILED",
  "TAX_REVERSAL_FAILED",
  "REFUND_AMOUNT_MISMATCH",
  "CURRENCY_MISMATCH",
  "ORIGINAL_TAX_TRANSACTION_MISSING",
  "CONFLICTING_PROVIDER_REFERENCE",
  "REFUND_WITHOUT_ACCOUNTING_REVERSAL",
  "MISSING_ECONOMIC_SNAPSHOT",
  "PROCEEDS_STILL_PAYOUT_ELIGIBLE",
  "SETTLEMENT_NOT_REVERSED",
  "REFUND_POLICY_VERSION_MISSING",
  "REFUND_POLICY_VERSION_MISMATCH",
  "SHIPPING_TREATMENT_CONTRADICTS_POLICY",
  "PROMOTER_COMMISSION_STILL_PAYABLE",
  "PAID_PROMOTER_COMMISSION_LACKS_RECOVERY",
  "LINE_ECONOMICS_DO_NOT_RECONCILE",
  "TAX_REVERSAL_DOES_NOT_MATCH_REFUNDED_LINES",
];

export function refundFindingNeedsOperator(code: RefundReconciliationFindingCode): boolean {
  return REFUND_FINDINGS_NEEDING_OPERATOR.includes(code);
}

/**
 * One sale's refund reconciliation result.
 *
 * Names the records rather than restating their contents — an operator following
 * a finding reads the authoritative rows, and a result that carried copies would
 * be one more thing able to disagree with the records it is about.
 */
export const RefundReconciliationResult = z.strictObject({
  orderId: z.string().min(1).max(191),
  refundId: z.string().min(1).max(191).nullable(),
  taxReversalId: z.string().min(1).max(191).nullable(),
  reversalId: z.string().min(1).max(191).nullable(),
  /** The seller refund-policy version the refund was executed under. */
  sellerRefundPolicyId: z.string().min(1).max(191).nullable(),
  sellerRefundPolicyVersion: z.string().min(1).max(64).nullable(),
  /** The lines the refund returned, each in full. */
  refundedLineRefs: z.array(z.string().min(1).max(220)),
  /** The provider's refund, where one has been executed. */
  providerRefundRef: z.string().min(1).max(191).nullable(),
  /** The provider's tax reversal, where one has been created. */
  providerTaxReversalRef: z.string().min(1).max(191).nullable(),
  /** The composite state, derived by `refundLifecycleState`. `null` if no refund. */
  lifecycleState: RefundLifecycleState.nullable(),
  /** Every finding, not the first — the same rule the risk gate follows. */
  findings: z.array(RefundReconciliationFindingCode).min(1),
  /** True when every finding is a healthy one. */
  consistent: z.boolean(),
  /** True when at least one finding needs a human. */
  needsOperator: z.boolean(),
  evaluatedAt: z.iso.datetime(),
});
export type RefundReconciliationResult = z.infer<typeof RefundReconciliationResult>;

/**
 * A deeper audit that consults the provider's own view of a refund or reversal.
 *
 * **Not implemented**, and stated as a value so a later reader can check what was
 * claimed against what was built. `ALREADY_REFUNDED` and `ALREADY_REVERSED` are
 * the two conditions that genuinely need it — both mean the provider holds an
 * object Monacado never observed — and both are named rather than guessed at.
 */
export const REFUND_PROVIDER_AUDIT_SEAM = {
  routineReconciliation: "LOCAL_RECORDS_ONLY",
  providerLookup: "NOT_IMPLEMENTED",
  intendedTrigger: "EXPLICIT_OPERATOR_AUDIT",
  conditionsRequiringIt: ["ALREADY_REFUNDED", "ALREADY_REVERSED"],
} as const;
