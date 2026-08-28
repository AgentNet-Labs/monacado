/**
 * The seller chargeback fee (Phase 1.12).
 *
 * A finalized chargeback lost against a seller costs that seller **$30**.
 *
 * ## Why this is a record and not a deduction
 *
 * The obvious implementation — subtract thirty dollars from something — is the
 * one this repository forbids everywhere else and forbids here. A sale's
 * economics are frozen in `TransactionEconomicSnapshot` at the moment it
 * completes, and a dispute is *new evidence about a completed sale, never a
 * correction of one*. Netting a fee out of a historical amount would restate
 * what three parties were told they earned, and it would do so silently.
 *
 * So the fee is its own fact: a governed obligation, assessed once, pointing at
 * the dispute that caused it. Nothing upstream moves.
 *
 * ## When it exists, and when it does not
 *
 * | Occasion | Fee |
 * | --- | --- |
 * | A dispute is opened | **No.** Opening one is the cardholder's act, not a finding against the seller. |
 * | A dispute is won | **No.** The sale was valid all along and the seller is vindicated. |
 * | A dispute is lost and finalized | **Yes.** One fee, once. |
 *
 * The middle row is the one worth stating out loud: a seller who successfully
 * defends a sale must be no worse off for having been disputed, or the fee
 * becomes a tax on being a target rather than a consequence of being wrong.
 *
 * ## What this is NOT
 *
 * This is **not** the payment network's own dispute fee, which Monacado also
 * incurs and which `DISPUTE_EXECUTION_DEFERRAL.disputeFeeAccounting` still
 * records as unbuilt. That is a Monacado cost with no ledger to land in. This is
 * a marketplace fee Monacado charges a seller, and the two are different
 * directions of money that happen to share a word.
 *
 * ## What is deliberately deferred
 *
 * **Collection.** Nothing here nets the fee against a payout, deducts it from a
 * balance, or invoices anybody — `clawbackExecution`, `offsetAgainstFutureProceeds`,
 * and `payoutExecution` are all still `NOT_IMPLEMENTED`, and a fee that quietly
 * executed against proceeds would be building the settlement engine this phase
 * has no business building. The obligation is recorded and an operator can see
 * it; discharging it belongs to `0M.T2`.
 */

import { z } from "zod";

/**
 * The fee, stated once.
 *
 * In **USD minor units**, and denominated in USD regardless of the sale's own
 * currency. That is deliberate: this is a marketplace fee Monacado charges for
 * the work and loss a finalized chargeback creates, not a share of the disputed
 * transaction, so it does not float with the sale. A version label rides along so
 * a fee assessed under today's policy stays readable after the amount changes.
 */
export const SELLER_CHARGEBACK_FEE_POLICY = {
  policyVersion: "1.0.0",
  amountMinorUnits: 3_000,
  currency: "USD",
  /** The only occasion that creates one. */
  assessedOn: "DISPUTE_FINALIZED_LOST",
  assessedOnDisputeOpened: false,
  assessedOnDisputeWon: false,
  /** One fee per dispute, enforced by a unique index rather than by a service. */
  cardinality: "ONE_PER_DISPUTE",
  /** Nothing historical is rewritten to make room for it. */
  rewritesHistoricalEconomics: false,
  /** Collection is a settlement act, and settlement is not this phase. */
  collection: "NOT_IMPLEMENTED",
  collectionOwner: "T2_SETTLEMENT_AND_PAYOUT",
} as const;

/**
 * What has happened to one assessed fee.
 *
 * `ASSESSED` is the only state this phase writes. `WAIVED` exists because an
 * operator reversing a fee is a governed act that must be recordable rather than
 * achieved by deleting a row, and `SETTLED` is named so the column does not
 * change shape when collection lands.
 */
export const SELLER_CHARGEBACK_FEE_STATES = ["ASSESSED", "WAIVED", "SETTLED"] as const;
export const SellerChargebackFeeState = z.enum(SELLER_CHARGEBACK_FEE_STATES);
export type SellerChargebackFeeState = z.infer<typeof SellerChargebackFeeState>;

/** One assessed fee, as an operator sees it. No buyer detail, ever. */
export const SellerChargebackFeeView = z.strictObject({
  feeId: z.string().min(1).max(191),
  disputeId: z.string().min(1).max(191),
  orderId: z.string().min(1).max(191),
  sellerParticipantId: z.string().min(1).max(191),
  amountMinorUnits: z.number().int().min(0),
  currency: z.string().length(3),
  policyVersion: z.string().min(1).max(32),
  state: SellerChargebackFeeState,
  assessedAt: z.iso.datetime(),
});
export type SellerChargebackFeeView = z.infer<typeof SellerChargebackFeeView>;

/**
 * Whether a dispute outcome creates a fee.
 *
 * Total and pure, so the operator tool, the service, and the tests cannot form
 * three opinions about the same question.
 */
export function chargebackFeeAppliesTo(status: string): boolean {
  return status === "LOST";
}
