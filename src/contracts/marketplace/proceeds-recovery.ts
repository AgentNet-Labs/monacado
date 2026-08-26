/**
 * Proceeds recovery exceptions (Phase 1.9).
 *
 * What a refund does to money Monacado had **already committed** to somebody
 * else — and, just as importantly, what it deliberately does **not** do.
 *
 * ## The two cases a refund creates
 *
 * `ProceedsObligation` is forward-only through `PENDING → ELIGIBLE → PAID`, with
 * no reversed state, and `1.2` was explicit that a reversal changes nothing on it
 * *directly*: what a reversal does is make the claim **ineligible for payout**,
 * enforced in `advanceProceedsObligation`, which refuses `ELIGIBLE` on a reversed
 * sale. For a `PENDING` obligation that is the whole answer and this record is
 * not created.
 *
 * Two cases are not covered by it, and both are real:
 *
 * | State at refund | What is true | What `1.9` does |
 * | --- | --- | --- |
 * | `PAID` | Monacado already paid a party for a sale that has now been returned | records an exception. **No clawback.** |
 * | `ELIGIBLE` | The claim is already past the gate that would now refuse it | records an exception. **No demotion.** |
 *
 * ## Why an exception and not a correction
 *
 * The two available alternatives were both refused.
 *
 * **Rewriting the obligation** — flipping `PAID` back, or inventing a `REVERSED`
 * state — would make the ledger say a payout did not happen that did. `1.2` put
 * the rule plainly: *"refusing to record what was actually paid would make the
 * ledger wrong rather than safe."* A refund does not un-pay anybody.
 *
 * **Fabricating a negative obligation** would assert a claim *against* a
 * participant that no phase has designed: there is no negative-balance model, no
 * offset rule against future proceeds, no notice requirement, no dispute path,
 * and no payout-recovery execution. Writing the row would be writing commercial
 * terms into an accounting table, which is the failure `1.2` refused for partial
 * refunds and is refused here for the same reason.
 *
 * So this record states **that a recovery is owed** and leaves *how* to a governed
 * settlement phase. `RECOVERY_EXECUTION_DEFERRAL` names what that phase owes.
 *
 * Pure types and pure decisions. No I/O, no clock, no provider.
 */

import { z } from "zod";
import { PROCEEDS_RECOVERY_EXCEPTION_ID_RE } from "./identity";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";

const Amount = z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT);

// — Identity —

export const ProceedsRecoveryExceptionId = z
  .string()
  .regex(PROCEEDS_RECOVERY_EXCEPTION_ID_RE, "exceptionId must be mon:precx:<opaque>");
export type ProceedsRecoveryExceptionId = z.infer<typeof ProceedsRecoveryExceptionId>;

// — Reason —

/**
 * Which of the two cases produced this exception.
 *
 * Kept distinct rather than collapsed into "recovery needed", because the
 * remedies genuinely differ: `PAID_BEFORE_REFUND` needs money back from a party,
 * `ELIGIBLE_BEFORE_REFUND` needs a payout **stopped** before it runs, and an
 * operator handed one word for both would act late on half of them.
 */
export const PROCEEDS_RECOVERY_REASON_CODES = [
  /** Monacado had already settled this claim when the sale was refunded. */
  "PAID_BEFORE_REFUND",
  /** The claim was already payout-eligible when the sale was refunded. */
  "ELIGIBLE_BEFORE_REFUND",
] as const;
export const ProceedsRecoveryReasonCode = z.enum(PROCEEDS_RECOVERY_REASON_CODES);
export type ProceedsRecoveryReasonCode = z.infer<typeof ProceedsRecoveryReasonCode>;

/** The obligation states that create an exception, paired with their reason. */
export function recoveryReasonForObligationState(
  state: "PENDING" | "ELIGIBLE" | "PAID",
): ProceedsRecoveryReasonCode | null {
  if (state === "PAID") return "PAID_BEFORE_REFUND";
  if (state === "ELIGIBLE") return "ELIGIBLE_BEFORE_REFUND";
  /* PENDING needs no exception: `advanceProceedsObligation` already refuses to
     make a reversed sale's claim eligible, so it can never be paid. */
  return null;
}

// — Status —

/**
 * Where the exception has got to. **Forward-only, and none of it is execution.**
 *
 * `RESOLVED` records that a human settled the matter somewhere Monacado can see;
 * it does not settle it, exactly as `ProceedsObligation.PAID` records rather than
 * performs a payout. There is deliberately no `RECOVERED` state, because nothing
 * in this repository can recover anything.
 */
export const PROCEEDS_RECOVERY_STATUSES = [
  /** Raised by a refund. Nobody has looked yet. */
  "OPEN",
  /** An operator has seen it and is acting. */
  "ACKNOWLEDGED",
  /** Settled outside this system, and recorded as such. Terminal. */
  "RESOLVED",
] as const;
export const ProceedsRecoveryStatus = z.enum(PROCEEDS_RECOVERY_STATUSES);
export type ProceedsRecoveryStatus = z.infer<typeof ProceedsRecoveryStatus>;

export const INITIAL_PROCEEDS_RECOVERY_STATUS: ProceedsRecoveryStatus = "OPEN";

export const PROCEEDS_RECOVERY_TRANSITIONS: Record<
  ProceedsRecoveryStatus,
  readonly ProceedsRecoveryStatus[]
> = Object.freeze({
  OPEN: ["ACKNOWLEDGED", "RESOLVED"],
  ACKNOWLEDGED: ["RESOLVED"],
  RESOLVED: [],
});

export function isValidProceedsRecoveryTransition(
  from: ProceedsRecoveryStatus,
  to: ProceedsRecoveryStatus,
): boolean {
  return PROCEEDS_RECOVERY_TRANSITIONS[from].includes(to);
}

/**
 * How an open exception was finally settled, as a closed vocabulary.
 *
 * Bounded rather than free text, on the same terms as every other reason
 * vocabulary here. `WRITTEN_OFF` is a real outcome and naming it is what keeps it
 * from being expressed by deleting the row.
 */
export const PROCEEDS_RECOVERY_RESOLUTION_CODES = [
  /** The party returned the funds. */
  "RECOVERED_FROM_PARTY",
  /** Offset against later proceeds, outside this phase. */
  "OFFSET_AGAINST_FUTURE_PROCEEDS",
  /** Monacado absorbed it. */
  "WRITTEN_OFF",
  /** The payout was stopped before it ran. */
  "PAYOUT_CANCELLED_BEFORE_EXECUTION",
  /** The exception was raised in error. */
  "RAISED_IN_ERROR",
] as const;
export const ProceedsRecoveryResolutionCode = z.enum(PROCEEDS_RECOVERY_RESOLUTION_CODES);
export type ProceedsRecoveryResolutionCode = z.infer<typeof ProceedsRecoveryResolutionCode>;

// — The record —

/**
 * One party's recovery exception on one refunded sale.
 *
 * The amount is **copied from the obligation**, never recomputed and never
 * derived from the reversal entry: what is at stake is exactly what Monacado
 * committed to that party, and a figure recalculated from current policy would be
 * a different number wearing the same name.
 */
export const ProceedsRecoveryExceptionRecord = z.strictObject({
  exceptionId: ProceedsRecoveryExceptionId,
  /** The refund that raised it. */
  refundId: z.string().min(1).max(191),
  orderId: z.string().min(1).max(191),
  snapshotId: z.string().min(1).max(191),
  /** The claim at stake. One exception per obligation, enforced. */
  proceedsObligationId: z.string().min(1).max(191),

  participantId: z.string().min(1).max(191),
  /** `SELLER` | `PROMOTER`. Monacado is not a member — it owes itself nothing. */
  party: z.enum(["SELLER", "PROMOTER"]),

  /** Copied from the obligation. Never recomputed. */
  amountMinorUnits: Amount,
  currency: CurrencyCode,

  reasonCode: ProceedsRecoveryReasonCode,
  /** The obligation's state at the moment the refund completed. */
  obligationStateAtRefund: z.enum(["ELIGIBLE", "PAID"]),

  status: ProceedsRecoveryStatus,
  resolutionCode: ProceedsRecoveryResolutionCode.nullable(),

  raisedAt: z.iso.datetime(),
  acknowledgedAt: z.iso.datetime().nullable(),
  resolvedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
export type ProceedsRecoveryExceptionRecord = z.infer<typeof ProceedsRecoveryExceptionRecord>;

/**
 * Named as never admissible on a recovery exception.
 *
 * The payout-execution fields are on this list for the same reason the
 * partial-refund fields are on `NEVER_ON_ORDER_REFUND`: they are precisely the
 * columns that would appear the day somebody implemented clawback without
 * designing it.
 */
export const NEVER_ON_PROCEEDS_RECOVERY_EXCEPTION = [
  // party identity beyond the participant reference
  "participantLegalName",
  "participantEmail",
  "bankAccount",
  "payoutDestination",
  // payout execution — deferred, see RECOVERY_EXECUTION_DEFERRAL
  "clawbackTransferRef",
  "negativeBalanceMinorUnits",
  "offsetScheduleId",
  "reserveHoldMinorUnits",
  // free text
  "note",
  "operatorComment",
  "providerMessage",
] as const;

/**
 * What a later settlement phase owes, stated as data.
 *
 * `1.9` records the exception and stops. Everything below is a decision nobody
 * has taken, and taking one silently inside a refund worker would be worse than
 * leaving the row open where an operator can see it.
 */
export const RECOVERY_EXECUTION_DEFERRAL = {
  /** Nothing in this repository moves money back from a participant. */
  clawbackExecution: "NOT_IMPLEMENTED",
  /** No negative-balance model exists. */
  negativeBalanceLedger: "NOT_IMPLEMENTED",
  /** No rule offsets a recovery against a later sale's proceeds. */
  offsetAgainstFutureProceeds: "NOT_IMPLEMENTED",
  /** Payout execution itself is unbuilt, so there is nothing to cancel. */
  payoutExecution: "NOT_IMPLEMENTED",
  /** Whose phase it is. */
  owner: "T2_SETTLEMENT_AND_PAYOUT",
  /** What `1.9` guarantees instead. */
  guaranteedNow: [
    "PENDING_OBLIGATIONS_CANNOT_BECOME_ELIGIBLE_ON_A_REFUNDED_SALE",
    "PAID_AND_ELIGIBLE_OBLIGATIONS_ARE_NEVER_REWRITTEN",
    "EVERY_SUCH_OBLIGATION_RAISES_A_DURABLE_VISIBLE_EXCEPTION",
  ],
} as const;
