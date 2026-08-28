/**
 * The seller chargeback fee (Phase 1.12).
 *
 * A finalized chargeback lost against a seller costs that seller a fee. **The
 * amount is a governed, versioned commercial value — not a constant in this
 * file.**
 *
 * ## Why the amount is not a constant here
 *
 * The first cut of this phase compiled `$30` into the assessment path. That made
 * the fee correct and unchangeable in the same stroke: raising or lowering it
 * would have required a code deployment, and there would have been no record of
 * what the fee *was* when an older chargeback was assessed. A commercial term
 * Monacado can only change by shipping code is not a governed term.
 *
 * So the fee follows the machinery this repository already uses for every other
 * governed commercial value: a stable policy identity, immutable versions, one
 * `ACTIVE` version at a time enforced by the database, and a recorded operator
 * behind each change. It is the shape `CommercialPolicy` established and
 * `SellerRefundPolicy` reused — **the pattern, not a second configuration
 * system.**
 *
 * ## Why it is its own policy rather than a column on the commercial policy
 *
 * `CommercialPolicyVersionRow` is bound to an **Order at sale time**, and every
 * sale carries the exact version it was quoted under. A chargeback fee is not
 * decided at sale time: it is decided when the chargeback **finalizes**, which
 * may be months later and under a different governing value.
 *
 * Putting the fee on the commercial policy version would therefore have made
 * "which version applies" genuinely ambiguous — the one the Order bound, or the
 * one standing when the bank decided? A separate policy with its own
 * resolution-at-finalization has one answer.
 *
 * ## When it exists, and when it does not
 *
 * | Occasion | Fee |
 * | --- | --- |
 * | A dispute is opened | **No.** Opening one is the cardholder's act, not a finding against the seller. |
 * | A dispute is won | **No.** The sale was valid all along and the seller is vindicated. |
 * | A dispute is lost and finalized | **Yes.** One fee, once, at the then-active amount. |
 *
 * The middle row is worth stating out loud: a seller who successfully defends a
 * sale must be no worse off for having been disputed, or the fee becomes a tax on
 * being a target rather than a consequence of being wrong.
 *
 * ## What this is NOT
 *
 * This is **not** the payment network's own dispute fee, which Monacado also
 * incurs and which `DISPUTE_EXECUTION_DEFERRAL.disputeFeeAccounting` still
 * records as unbuilt. That is a Monacado *cost* with no ledger to land in. This is
 * a marketplace fee Monacado *charges* a seller, and the two are different
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
 * The stable identity of the one fee policy Monacado governs.
 *
 * A **key**, not a minted id: the policy row's opaque id is generated per
 * deployment, so a service resolving "the chargeback fee policy" needs something
 * stable to look it up by. The same reason `MONACADO_MARKETPLACE_POLICY_ID` is a
 * pinned literal rather than a lookup by label.
 */
export const SELLER_CHARGEBACK_FEE_POLICY_KEY = "MONACADO_SELLER_CHARGEBACK_FEE" as const;

/**
 * The values a deployment is **bootstrapped** with, and nothing more.
 *
 * Read by the bootstrap command when an operator asks for an initial version. It
 * is **never** consulted at assessment time: a dispute finalizing with no active
 * policy fails closed and raises an operator finding rather than quietly falling
 * back to these numbers. A silent fallback would reintroduce exactly the
 * hardcoded fee this design removes, while looking governed.
 */
export const SELLER_CHARGEBACK_FEE_BOOTSTRAP_DEFAULT = {
  policyKey: SELLER_CHARGEBACK_FEE_POLICY_KEY,
  policyVersion: "1.0.0",
  label: "Monacado seller chargeback fee",
  amountMinorUnits: 3_000,
  currency: "USD",
} as const;

/**
 * What is true of the fee regardless of which version is active.
 *
 * The *rules* are governed here because they are architecture; the *amount* is
 * governed in the database because it is a commercial term. Conflating the two is
 * what made the first cut unchangeable.
 */
export const SELLER_CHARGEBACK_FEE_RULES = {
  /** The only occasion that creates one. */
  assessedOn: "DISPUTE_FINALIZED_LOST",
  assessedOnDisputeOpened: false,
  assessedOnDisputeWon: false,
  /** One fee per dispute, enforced by a unique index rather than by a service. */
  cardinality: "ONE_PER_DISPUTE",
  /** Nothing historical is rewritten to make room for it. */
  rewritesHistoricalEconomics: false,
  /** The governing version is the one standing when the chargeback finalizes. */
  versionResolvedAt: "DISPUTE_FINALIZATION",
  /** And it is snapshotted onto the assessment, never re-read afterwards. */
  boundToAssessment: true,
  /** No compiled amount is ever used to assess. */
  compiledFallbackAtAssessment: false,
  /** Collection is a settlement act, and settlement is not this phase. */
  collection: "NOT_IMPLEMENTED",
  collectionOwner: "T2_SETTLEMENT_AND_PAYOUT",
} as const;

/** DRAFT | ACTIVE | RETIRED — the vocabulary every governed policy here uses. */
export const SELLER_CHARGEBACK_FEE_POLICY_STATUSES = ["DRAFT", "ACTIVE", "RETIRED"] as const;
export const SellerChargebackFeePolicyStatus = z.enum(SELLER_CHARGEBACK_FEE_POLICY_STATUSES);
export type SellerChargebackFeePolicyStatus = z.infer<typeof SellerChargebackFeePolicyStatus>;

/** One governed version of the fee, as an operator sees it. */
export const SellerChargebackFeePolicyVersionView = z.strictObject({
  policyId: z.string().min(1).max(191),
  policyKey: z.string().min(1).max(64),
  policyVersion: z.string().min(1).max(64),
  status: SellerChargebackFeePolicyStatus,
  amountMinorUnits: z.number().int().min(0),
  currency: z.string().length(3),
  effectiveFrom: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
  retiredAt: z.iso.datetime().nullable(),
});
export type SellerChargebackFeePolicyVersionView = z.infer<
  typeof SellerChargebackFeePolicyVersionView
>;

/** One assessed fee, as an operator sees it. No buyer detail, ever. */
export const SellerChargebackFeeView = z.strictObject({
  feeId: z.string().min(1).max(191),
  disputeId: z.string().min(1).max(191),
  orderId: z.string().min(1).max(191),
  sellerParticipantId: z.string().min(1).max(191),
  amountMinorUnits: z.number().int().min(0),
  currency: z.string().length(3),
  /** The exact governing version, bound at assessment and never re-read. */
  feePolicyId: z.string().min(1).max(191),
  policyVersion: z.string().min(1).max(64),
  state: z.enum(["ASSESSED", "WAIVED", "SETTLED"]),
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

/**
 * Why a fee could not be assessed, from a closed vocabulary.
 *
 * `NO_ACTIVE_FEE_POLICY` is the fail-closed case the whole design turns on: a
 * deployment that has never bootstrapped a fee policy assesses **nothing** and
 * says so, rather than reaching for a compiled number that no operator chose.
 */
export const SELLER_CHARGEBACK_FEE_REFUSAL_CODES = [
  "NO_ACTIVE_FEE_POLICY",
  "ORDER_HAS_NO_SELLER",
  "ALREADY_ASSESSED",
] as const;
export const SellerChargebackFeeRefusalCode = z.enum(SELLER_CHARGEBACK_FEE_REFUSAL_CODES);
export type SellerChargebackFeeRefusalCode = z.infer<typeof SellerChargebackFeeRefusalCode>;
