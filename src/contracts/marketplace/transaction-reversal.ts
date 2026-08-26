/**
 * Transaction reversal accounting (Phase 1.2).
 *
 * The minimum path for undoing a completed sale, and the first entry in what
 * `0M.T1` called "refund and chargeback accounting" when it deferred it.
 *
 * ## A reversal is new evidence, never a correction
 *
 * `0M.T1` built `TransactionEconomicSnapshot` with **no update path at all** —
 * "economic facts are not editable in place" — and put every mutable fact on a
 * separate settlement row. This phase does not weaken that by one column.
 *
 * A reversal is therefore an **additional immutable record about** a snapshot:
 *
 * ```
 * TransactionEconomicSnapshot   — what the sale earned each party.   NEVER EDITED.
 * TransactionReversal           — what was subsequently given back.  ALSO NEVER EDITED.
 * net position                  — the difference, DERIVED, stored nowhere.
 * ```
 *
 * That is why no amount here is negative and no snapshot field is touched.
 * `0M.T1` was explicit that a reversal "will be recorded as its own entry rather
 * than by editing this one — which is exactly why the [`REVERSED`] state exists
 * now: provider reversal evidence arriving must not require rewriting a financial
 * row's schema." This is that entry, and no schema was rewritten.
 *
 * ## Full reversals only
 *
 * `REVERSAL_SCOPES` has one member. Partial refunds are **explicitly deferred**,
 * and not for convenience: a partial refund forces a decision about *whose* money
 * comes back first — Monacado's retention, the seller's proceeds, or the
 * promoter's spread — and every allocation rule is a commercial policy decision
 * with different winners. `MONACADO_MOR_BUSINESS_MODEL.md` §I owns that ruling,
 * and inventing one here would be inventing commercial terms in an accounting
 * module.
 *
 * A full reversal needs no allocation rule: everyone gives back exactly what they
 * received, which is checkable arithmetic rather than a policy.
 *
 * Pure types and pure decisions. No I/O, no clock, no provider.
 */

import { z } from "zod";
import { TRANSACTION_REVERSAL_ID_RE } from "./identity";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";
import { PaymentProvider } from "./payment-account";
import {
  ProviderTransactionRef,
  TransactionEconomicSnapshotId,
  type TransactionEconomics,
} from "./transaction-accounting";

const Amount = z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT);

// — Identity —

export const TransactionReversalId = z
  .string()
  .regex(TRANSACTION_REVERSAL_ID_RE, "reversalId must be mon:txrev:<opaque>");
export type TransactionReversalId = z.infer<typeof TransactionReversalId>;

// — Kind and scope —

/**
 * How the money came back.
 *
 * The distinction is not cosmetic and is why one enum is not enough: a **refund**
 * is Monacado choosing to return funds, a **chargeback** is a buyer's bank taking
 * them. They have different evidence, different disputes, and different downstream
 * treatment — and `0M.T1` named "refund or chargeback distinction" as exactly the
 * thing its settlement state deliberately did not carry.
 */
export const REVERSAL_KINDS = ["REFUND", "CHARGEBACK"] as const;
export const ReversalKind = z.enum(REVERSAL_KINDS);
export type ReversalKind = z.infer<typeof ReversalKind>;

/** One member. `PARTIAL` is deferred — see the module header. */
export const REVERSAL_SCOPES = ["FULL"] as const;
export const ReversalScope = z.enum(REVERSAL_SCOPES);
export type ReversalScope = z.infer<typeof ReversalScope>;

/**
 * Why the sale was reversed, as a closed Monacado vocabulary.
 *
 * No provider text, dispute narrative, or free-text note — the same rule
 * `PaymentFailureCode` and `RestrictionReasonCode` apply, and for the same
 * reason: a free-text reason is where a buyer's name, an address, or a support
 * agent's opinion eventually lands.
 */
export const REVERSAL_REASON_CODES = [
  /** The buyer asked and Monacado agreed. */
  "BUYER_REQUESTED",
  /** The item could not be supplied. */
  "NOT_FULFILLABLE",
  /** Monacado reversed it on its own initiative. */
  "MONACADO_INITIATED",
  /** The buyer's bank reversed it. Pairs with `CHARGEBACK`. */
  "DISPUTED_BY_BUYER",
  /** Reversed to correct a Monacado error. */
  "CORRECTION",
] as const;
export const ReversalReasonCode = z.enum(REVERSAL_REASON_CODES);
export type ReversalReasonCode = z.infer<typeof ReversalReasonCode>;

// — Errors —

export class TransactionReversalError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "TransactionReversalError";
    this.code = code;
  }
}

// — Reversed amounts —

/**
 * What each party gives back, as **positive magnitudes**.
 *
 * Positive rather than signed, deliberately. A signed column invites a reader to
 * add it to the snapshot and call the result the truth, and the first sign error
 * silently doubles somebody's money. Here the record's *kind* carries the
 * direction, the amounts carry only size, and the net position is computed by a
 * named function that subtracts — visibly.
 *
 * Every field mirrors a snapshot field one-for-one, so a full reversal is
 * checkable by equality rather than by interpretation.
 */
export const ReversedAmounts = z.strictObject({
  /** The merchandise amount returned. Mirrors `commercialRetailAmountMinorUnits`. */
  commercialRetailAmountMinorUnits: Amount,
  taxAmountMinorUnits: Amount,
  shippingAmountMinorUnits: Amount,
  otherPassThroughAmountMinorUnits: Amount,

  monacadoRetainedAmountMinorUnits: Amount,
  sellerProceedsMinorUnits: Amount,
  /** Promoted sales only. `null` on a seller-direct reversal, never zero. */
  promoterNetProceedsMinorUnits: Amount.nullable(),
});
export type ReversedAmounts = z.infer<typeof ReversedAmounts>;

/**
 * What the buyer gets back in total.
 *
 * **Derived, never stored** — the same rule `0M.T1` applies to its own totals and
 * `0M.9` to the buyer's. A stored total is a second answer that can disagree with
 * the four amounts it sums.
 */
export function reversedBuyerTotalMinorUnits(amounts: ReversedAmounts): number {
  return (
    amounts.commercialRetailAmountMinorUnits +
    amounts.taxAmountMinorUnits +
    amounts.shippingAmountMinorUnits +
    amounts.otherPassThroughAmountMinorUnits
  );
}

/**
 * The reversal a **full** reversal of these economics must be.
 *
 * Derived from the snapshot rather than supplied, which is the whole safety
 * property: there is no parameter through which a caller can name what comes
 * back, so a reversal cannot return more than the sale earned, cannot return less
 * and call itself full, and cannot invent a promoter share on a seller-direct
 * sale.
 */
export function deriveFullReversalAmounts(input: {
  commercialRetailAmountMinorUnits: number;
  passThrough: {
    taxAmountMinorUnits: number;
    shippingAmountMinorUnits: number;
    otherPassThroughAmountMinorUnits: number;
  };
  economics: TransactionEconomics;
}): ReversedAmounts {
  const { economics } = input;
  return {
    commercialRetailAmountMinorUnits: input.commercialRetailAmountMinorUnits,
    taxAmountMinorUnits: input.passThrough.taxAmountMinorUnits,
    shippingAmountMinorUnits: input.passThrough.shippingAmountMinorUnits,
    otherPassThroughAmountMinorUnits: input.passThrough.otherPassThroughAmountMinorUnits,
    monacadoRetainedAmountMinorUnits: economics.monacadoRetainedAmountMinorUnits,
    sellerProceedsMinorUnits: economics.sellerProceedsMinorUnits,
    promoterNetProceedsMinorUnits:
      economics.transactionType === "PROMOTED" ? economics.promoterNetProceedsMinorUnits : null,
  };
}

/**
 * A full reversal balances against the sale it reverses.
 *
 * The same identity `reconcileTransactionEconomics` checks, read backwards:
 *
 * ```
 * promoted:      sellerProceeds + promoterNetProceeds + monacadoRetained = R
 * seller-direct: sellerProceeds +                       monacadoRetained = R
 * ```
 *
 * **Tax, shipping, and pass-through appear nowhere in it**, exactly as they
 * appear nowhere in the forward identity. They are returned to the buyer in full
 * and were never part of what the three parties divided — a reversal that folded
 * them in would be taking back commercial revenue nobody earned.
 *
 * Checked before any row is written, because an unbalanced reversal is a
 * misstatement of what three parties owe each other.
 */
export function reconcileFullReversal(input: {
  amounts: ReversedAmounts;
  transactionType: "SELLER_DIRECT" | "PROMOTED";
}): void {
  const a = input.amounts;

  if (input.transactionType === "PROMOTED" && a.promoterNetProceedsMinorUnits === null) {
    throw new TransactionReversalError(
      "REVERSAL_PROMOTER_SHARE_MISSING",
      "a promoted reversal must return the promoter's net proceeds",
    );
  }
  if (input.transactionType === "SELLER_DIRECT" && a.promoterNetProceedsMinorUnits !== null) {
    /* A seller-direct sale has no promoter counterparty. A zero here would
       describe one who gave back nothing rather than one who does not exist —
       the same distinction `deriveProceedsClaims` makes on the way in. */
    throw new TransactionReversalError(
      "REVERSAL_PROMOTER_SHARE_UNEXPECTED",
      "a seller-direct reversal has no promoter share",
    );
  }

  const parties =
    a.sellerProceedsMinorUnits +
    (a.promoterNetProceedsMinorUnits ?? 0) +
    a.monacadoRetainedAmountMinorUnits;

  if (parties !== a.commercialRetailAmountMinorUnits) {
    throw new TransactionReversalError(
      "REVERSAL_DOES_NOT_BALANCE",
      "reversed party shares must sum to the reversed commercial retail amount",
    );
  }
}

// — Record —

/**
 * One reversal of one sale.
 *
 * Immutable once written. There is no status column and no lifecycle: a reversal
 * either happened or it did not, and "a reversal that changed its mind" is a
 * second reversal, which the unique index below refuses.
 */
export const TransactionReversalRecord = z.strictObject({
  reversalId: TransactionReversalId,
  /** The exact sale this reverses. One reversal per snapshot, enforced. */
  snapshotId: TransactionEconomicSnapshotId,
  /** Storage lineage, so an operator can reach the Order without a join. */
  orderId: z.string().min(1).max(191),

  kind: ReversalKind,
  scope: ReversalScope,
  reasonCode: ReversalReasonCode,

  currency: CurrencyCode,
  amounts: ReversedAmounts,

  /** Provider evidence, on the same terms as `0M.T1`'s transaction reference. */
  provider: PaymentProvider.nullable(),
  providerReversalRef: ProviderTransactionRef.nullable(),

  /** When the money actually moved back. Supplied, never a clock read. */
  occurredAt: z.iso.datetime(),
  recordedAt: z.iso.datetime(),
});
export type TransactionReversalRecord = z.infer<typeof TransactionReversalRecord>;

// — The refund port —

/**
 * The boundary across which Monacado asks a provider to return funds.
 *
 * Provider-neutral, and separate from `BuyerPaymentPort` for the reason `0M.9`
 * kept that separate from `PaymentProviderPort`: charging a buyer and refunding
 * one are different privileges, and one interface holding both is a privilege
 * nobody scoped.
 *
 * **`1.2` shipped no concrete adapter.** A real Stripe refund was deliberately
 * not implemented there, because executing one is a live-money operation and that
 * phase was about the controls that must exist before any live money moves at
 * all.
 *
 * **Phase 1.9 built the adapter** — `stripe-refund-adapter.ts`, TEST mode only,
 * refusing live credentials by the same single `resolveTestModeSecretKey` gate
 * every other Stripe path goes through. The port's shape is unchanged; the
 * failure vocabulary was extended additively (see
 * `REFUND_EXECUTION_FAILURE_CODES`) and two fields were added to the success
 * arm, because a durable refund record has to say **when** the provider created
 * its refund and **which mode** answered.
 */
export const RefundExecutionRequest = z.strictObject({
  /** The original charge to reverse. Opaque to Monacado. */
  providerTransactionRef: ProviderTransactionRef,
  provider: PaymentProvider,
  currency: CurrencyCode,
  amountMinorUnits: Amount,
  /** Stable across retries. The reversal id, so one reversal carries one key. */
  idempotencyKey: z.string().min(1).max(191),
});
export type RefundExecutionRequest = z.infer<typeof RefundExecutionRequest>;

export const RefundExecuted = z.strictObject({
  outcome: z.literal("EXECUTED"),
  provider: PaymentProvider,
  providerReversalRef: ProviderTransactionRef,
  /**
   * When the provider created its refund (Phase 1.9).
   *
   * The provider's own instant, not Monacado's. A refund record that stamped its
   * own clock would be unable to answer "when did the money actually go back",
   * which is the first question asked in a chargeback.
   */
  providerCreatedAt: z.iso.datetime(),
  /**
   * The mode the provider answered from (Phase 1.9).
   *
   * The **provider's** statement about its own object, which is what catches a
   * deployment holding a live credential it believes is a test one — the same
   * check `1.7`'s tax adapter makes against `transaction.livemode`.
   */
  providerMode: z.enum(["TEST", "LIVE"]),
});

/**
 * Why a provider refused to return funds, in Monacado's words.
 *
 * **Extended in Phase 1.9**, additively, when the first real adapter was built
 * behind this port. `1.2` named the five conditions it could foresee; a
 * production-capable adapter also has to distinguish a deployment that is not
 * configured, a credential answering from the wrong mode, and an outright
 * rejection from a transport failure — because those three lead to different
 * operator actions and only one of them is worth retrying on a timer.
 *
 * Additive rather than a rewrite: every `1.2` member is unchanged and still means
 * what it meant. `1.9`'s `RefundFailureCode` is the richer vocabulary the durable
 * record carries, and `refundFailureCodeFor` maps this port's answer into it.
 */
export const REFUND_EXECUTION_FAILURE_CODES = [
  // — Phase 1.2 —
  "ALREADY_REVERSED",
  "CHARGE_NOT_FOUND",
  "AMOUNT_EXCEEDS_CHARGE",
  "PROVIDER_UNAVAILABLE",
  "UNSPECIFIED_FAILURE",
  // — Phase 1.9, when the first adapter made the distinctions load-bearing —
  /** The provider refused the request as malformed or unauthorised. */
  "PROVIDER_REJECTED",
  /** The payment integration is not configured for this deployment. */
  "PROVIDER_NOT_CONFIGURED",
  /** The provider answered from a mode this deployment does not permit. */
  "PROVIDER_MODE_NOT_PERMITTED",
] as const;
export const RefundExecutionFailureCode = z.enum(REFUND_EXECUTION_FAILURE_CODES);
export type RefundExecutionFailureCode = z.infer<typeof RefundExecutionFailureCode>;

export const RefundRefused = z.strictObject({
  outcome: z.literal("REFUSED"),
  failureCode: RefundExecutionFailureCode,
});

export const RefundExecutionResult = z.discriminatedUnion("outcome", [
  RefundExecuted,
  RefundRefused,
]);
export type RefundExecutionResult = z.infer<typeof RefundExecutionResult>;

export interface RefundExecutionPort {
  executeRefund(request: RefundExecutionRequest): Promise<RefundExecutionResult>;
}

// — Never on a reversal —

/**
 * Named as never-persistable, and refused by the `strictObject` above.
 */
export const NEVER_ON_TRANSACTION_REVERSAL = [
  // buyer personal data — 0M.9's promise, unchanged
  "buyerEmail",
  "buyerName",
  "buyerAddress",
  "cardLast4",
  // free text — bounded reason codes only
  "reasonText",
  "disputeNarrative",
  "providerMessage",
  "supportNote",
  // partial-refund machinery — explicitly deferred
  "remainingRefundableMinorUnits",
  "refundedToDateMinorUnits",
  "allocationRule",
  // a reversal has no lifecycle
  "status",
  "state",
] as const;
