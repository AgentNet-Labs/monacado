/**
 * Dispute reconciliation (Phase 1.11).
 *
 * What Monacado's own records say about one disputed sale, answered **from local
 * records alone**. No provider call, ever — the same posture
 * `REFUND_PROVIDER_AUDIT_SEAM` takes, and for the same reason: a routine
 * consistency check that reached the network would be a routine way to be rate
 * limited, and would make "are our books right" depend on somebody else's uptime.
 *
 * Attribution is genuinely local. A provider dispute names a payment reference,
 * `TransactionSettlement` carries the identical value under a composite unique
 * index, and the join needs no expansion and no lookup.
 */

import { z } from "zod";
import {
  DisputeEconomicEffect,
  DisputeFundsState,
  DisputeStatus,
  DisputeTaxConsequence,
} from "./transaction-dispute";

/**
 * What a reconciliation can conclude about one sale's dispute.
 *
 * Bounded codes — safe to log, safe to render, carrying no amount and no buyer.
 * The figures that differ are reachable from the records each finding names.
 */
export const DISPUTE_RECONCILIATION_FINDING_CODES = [
  // — Healthy —
  /** Everything agrees. */
  "CONSISTENT",
  /** A paid Order with no dispute. The ordinary case, and not a defect. */
  "NO_DISPUTE",
  /** The network is deciding and nothing is owed yet. Not a defect. */
  "DISPUTE_AWAITING_PROVIDER_DECISION",
  /** Won or closed with no liability, and nothing left outstanding. */
  "DISPUTE_RESOLVED_NO_LIABILITY",

  // — In flight, worth naming, not yet a defect —
  /**
   * A dispute is open and unpaid proceeds are correctly held.
   *
   * Named rather than silent so an operator can see the hold is deliberate
   * rather than wonder why a payout is not moving.
   */
  "DISPUTE_OPEN_PROCEEDS_HELD",

  // — Defects —
  /** No settlement carries this dispute's payment reference. */
  "DISPUTE_UNATTRIBUTED",
  /** The dispute names an Order that is not `PAID`. */
  "DISPUTE_ORDER_NOT_PAID",
  /** The disputed amount is not the amount the buyer was charged. */
  "DISPUTE_AMOUNT_MISMATCH",
  /** The disputed currency is not the sale's currency. */
  "DISPUTE_CURRENCY_MISMATCH",
  /** The dispute has no usable original payment reference. */
  "DISPUTE_MISSING_PAYMENT_REFERENCE",
  /**
   * The sale was refunded and is now also economically reversed by a dispute.
   *
   * The double-reversal finding. Monacado's books hold exactly one reversal
   * because the constraint permits one — but the buyer has been made whole
   * twice in the world, and that needs a human.
   */
  "DISPUTE_ON_ALREADY_REFUNDED_SALE",
  /**
   * A refund is in flight while a dispute is open.
   *
   * Monacado is racing the buyer's bank to return the same money.
   */
  "DISPUTE_AND_REFUND_BOTH_IN_FLIGHT",
  /** Funds are gone and the sale carries no reversal entry. */
  "DISPUTE_LOST_WITHOUT_ACCOUNTING_REVERSAL",
  /** A lost dispute wrote a reversal and the settlement is not `REVERSED`. */
  "DISPUTE_SETTLEMENT_NOT_REVERSED",
  /** An open or lost dispute left a claim still payout-eligible. */
  "DISPUTE_PROCEEDS_STILL_PAYOUT_ELIGIBLE",
  /** A party was paid and no recovery evidence exists. */
  "DISPUTE_PAID_PROCEEDS_LACK_RECOVERY",
  /** A promoter was paid commission on a charged-back sale, with no recovery. */
  "DISPUTE_PAID_PROMOTER_COMMISSION_LACKS_RECOVERY",
  /** A won dispute left a recovery exception standing that nothing is due on. */
  "DISPUTE_WON_STALE_RECOVERY_EXCEPTION",
  /** A won dispute left proceeds held that should have been released. */
  "DISPUTE_WON_STALE_HOLD",
  /** A lost dispute's tax correction is owed and not expressible. */
  "DISPUTE_TAX_CONSEQUENCE_UNRESOLVED",
  /** The sale's tax stands reported and the money has gone back. */
  "DISPUTE_TAX_TRANSACTION_STILL_REPORTED",
  /** Adjudication and funds say incompatible things. */
  "DISPUTE_STATE_CONTRADICTORY",
  /** A human is required and has not been. */
  "DISPUTE_MANUAL_REMEDIATION_OUTSTANDING",
  /** The response deadline passed with the dispute still open. */
  "DISPUTE_DEADLINE_PASSED_UNRESOLVED",
] as const;
export const DisputeReconciliationFindingCode = z.enum(DISPUTE_RECONCILIATION_FINDING_CODES);
export type DisputeReconciliationFindingCode = z.infer<typeof DisputeReconciliationFindingCode>;

/** Findings that describe a healthy sale. Everything else means work outstanding. */
export const HEALTHY_DISPUTE_FINDING_CODES: readonly DisputeReconciliationFindingCode[] = [
  "CONSISTENT",
  "NO_DISPUTE",
  "DISPUTE_AWAITING_PROVIDER_DECISION",
  "DISPUTE_RESOLVED_NO_LIABILITY",
  "DISPUTE_OPEN_PROCEEDS_HELD",
];

/**
 * Findings a human has to act on.
 *
 * Deliberately excludes `DISPUTE_OPEN_PROCEEDS_HELD`, which is the system
 * working correctly, and `DISPUTE_AWAITING_PROVIDER_DECISION`, which resolves
 * itself when the network decides.
 */
export const DISPUTE_FINDINGS_NEEDING_OPERATOR: readonly DisputeReconciliationFindingCode[] = [
  "DISPUTE_UNATTRIBUTED",
  "DISPUTE_ORDER_NOT_PAID",
  "DISPUTE_AMOUNT_MISMATCH",
  "DISPUTE_CURRENCY_MISMATCH",
  "DISPUTE_MISSING_PAYMENT_REFERENCE",
  "DISPUTE_ON_ALREADY_REFUNDED_SALE",
  "DISPUTE_AND_REFUND_BOTH_IN_FLIGHT",
  "DISPUTE_LOST_WITHOUT_ACCOUNTING_REVERSAL",
  "DISPUTE_SETTLEMENT_NOT_REVERSED",
  "DISPUTE_PROCEEDS_STILL_PAYOUT_ELIGIBLE",
  "DISPUTE_PAID_PROCEEDS_LACK_RECOVERY",
  "DISPUTE_PAID_PROMOTER_COMMISSION_LACKS_RECOVERY",
  "DISPUTE_WON_STALE_RECOVERY_EXCEPTION",
  "DISPUTE_WON_STALE_HOLD",
  "DISPUTE_TAX_CONSEQUENCE_UNRESOLVED",
  "DISPUTE_TAX_TRANSACTION_STILL_REPORTED",
  "DISPUTE_STATE_CONTRADICTORY",
  "DISPUTE_MANUAL_REMEDIATION_OUTSTANDING",
  "DISPUTE_DEADLINE_PASSED_UNRESOLVED",
];

export function disputeFindingNeedsOperator(code: DisputeReconciliationFindingCode): boolean {
  return DISPUTE_FINDINGS_NEEDING_OPERATOR.includes(code);
}

/**
 * One sale's dispute reconciliation result.
 *
 * Names the records rather than restating their contents.
 */
export const DisputeReconciliationResult = z.strictObject({
  /** NULL when the dispute could not be attributed. */
  orderId: z.string().min(1).max(191).nullable(),
  disputeId: z.string().min(1).max(191).nullable(),
  reversalId: z.string().min(1).max(191).nullable(),
  refundId: z.string().min(1).max(191).nullable(),
  providerDisputeRef: z.string().min(1).max(191).nullable(),

  status: DisputeStatus.nullable(),
  fundsState: DisputeFundsState.nullable(),
  economicEffect: DisputeEconomicEffect.nullable(),
  taxConsequence: DisputeTaxConsequence.nullable(),

  /** Every finding, not the first — the same rule the risk gate follows. */
  findings: z.array(DisputeReconciliationFindingCode).min(1),
  consistent: z.boolean(),
  needsOperator: z.boolean(),
  evaluatedAt: z.iso.datetime(),
});
export type DisputeReconciliationResult = z.infer<typeof DisputeReconciliationResult>;

export const DisputeReconciliationSummary = z.strictObject({
  reconciled: z.int().min(0),
  consistent: z.int().min(0),
  needingOperator: z.int().min(0),
  findingCounts: z.record(z.string(), z.int().min(0)),
});
export type DisputeReconciliationSummary = z.infer<typeof DisputeReconciliationSummary>;

/**
 * A deeper audit that consults the provider's own view of a dispute.
 *
 * **Not implemented**, stated as a value so a later reader can check what was
 * claimed against what was built. The condition that genuinely needs it is a
 * dispute the provider holds and Monacado never observed — which local records
 * cannot detect by construction, because the evidence of it is precisely what is
 * missing.
 */
export const DISPUTE_PROVIDER_AUDIT_SEAM = {
  /** Routine reconciliation reads Monacado's own rows and nothing else. */
  routineReconciliation: "LOCAL_RECORDS_ONLY",
  /** Nothing lists or retrieves disputes from the provider. */
  providerLookup: "NOT_IMPLEMENTED",
  /** The gap local records cannot close on their own. */
  undetectableLocally: "A_PROVIDER_DISPUTE_THAT_NEVER_REACHED_THE_WEBHOOK",
  /** What would trigger it, if it existed. */
  intendedTrigger: "EXPLICIT_OPERATOR_AUDIT",
  owner: "T2_SETTLEMENT_AND_PAYOUT",
} as const;
