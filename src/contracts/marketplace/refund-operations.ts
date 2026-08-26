/**
 * Refund operations (Phase 1.9).
 *
 * What the refund pipeline currently owes, what an operator must do about each
 * stuck row, and the one governed state change they may make.
 *
 * ```
 * summarizeRefundBacklog   counts + ages, no identifiers   (a status screen)
 * inspectStuckRefundWork   identifiers + next action        (an operator acting)
 * requeueRefundWork        the one governed state change    (after a human fixed something)
 * ```
 *
 * The shape `1.8` established for tax recording, reused rather than reinvented —
 * including the rule that made it worth having: **a requeue is never an undo**. It
 * alters no request-time fact, clears no failure code, and is refused outright for
 * failures a retry cannot fix.
 *
 * ## No provider call anywhere
 *
 * Every fact is already persisted. A status command that had to reach Stripe
 * would stop working at the moment a credential problem made it most useful.
 *
 * Pure types and pure decisions. No I/O, no clock, no vendor.
 */

import { z } from "zod";
import { RefundFailureCode, RefundStatus } from "./order-refund";
import { TaxReversalFailureCode, TaxReversalStatus } from "./tax-reversal";

// — Backlog —

/**
 * What the refund pipeline currently owes, as counts.
 *
 * Counts and ages only. **No Order id, no buyer, no amount** — a status summary
 * is rendered on operations screens and pasted into chat, and one that enumerated
 * refunds would be a way to enumerate customers *and* their grievances. The
 * identifiers live in the inspection view, which an operator opens deliberately.
 */
export const RefundBacklog = z.strictObject({
  // — Payment refunds —
  refundsPending: z.int().min(0),
  refundsInProgress: z.int().min(0),
  refundsRetryPending: z.int().min(0),
  refundsCompleted: z.int().min(0),
  refundsPermanentlyFailed: z.int().min(0),

  // — Tax reversals —
  taxReversalsPending: z.int().min(0),
  taxReversalsInProgress: z.int().min(0),
  taxReversalsRetryPending: z.int().min(0),
  taxReversalsCompleted: z.int().min(0),
  taxReversalsPermanentlyFailed: z.int().min(0),

  /**
   * Refunds whose payment came back and whose tax reversal has not.
   *
   * Expected *briefly* and alarming if it persists — the number an operator
   * actually watches, and the reason the two halves are counted separately
   * rather than folded into one "in progress".
   */
  paymentRefundedTaxNotReversed: z.int().min(0),
  /**
   * Refunds resting in `MANUAL_REMEDIATION_REQUIRED`: money returned, tax
   * reversal permanently failed. **No timer will fix these.**
   */
  manualRemediationRequired: z.int().min(0),
  /** Open proceeds recovery exceptions. Money owed back to Monacado. */
  openProceedsRecoveryExceptions: z.int().min(0),

  /** Retryable rows of either kind whose `nextAttemptAt` has passed. */
  dueNow: z.int().min(0),
  /** Claims of either kind whose lease has expired. Recovered next cycle. */
  expiredClaims: z.int().min(0),
  /**
   * The age of the oldest refund that has not reached a resting state, in
   * seconds. `null` when there is none.
   *
   * The single most useful number here: a growing oldest-age distinguishes
   * "busy" from "nothing is running".
   */
  oldestUnresolvedAgeSeconds: z.int().min(0).nullable(),
  evaluatedAt: z.iso.datetime(),
});
export type RefundBacklog = z.infer<typeof RefundBacklog>;

/**
 * The thresholds an operator is held to.
 *
 * `maxOverdueSeconds` is generous against the retry schedule — which backs off to
 * twelve hours — so a row legitimately in retry can be a day old without anything
 * being wrong. What it catches is a row that is old because **nothing is
 * running**.
 *
 * `maxTaxReversalLagSeconds` is much tighter, and deliberately so: the two
 * provider calls are seconds apart on the happy path, so a sale sitting in
 * payment-refunded-tax-not-reversed for hours means the second call is failing
 * quietly rather than being slow.
 */
export const REFUND_OPERATIONS_POLICY = {
  /** 36 hours: past the retry schedule's tail. */
  maxOverdueSeconds: 36 * 60 * 60,
  /** 6 hours: well past a transient outage, well short of a filing period. */
  maxTaxReversalLagSeconds: 6 * 60 * 60,
  /** What one dispatcher invocation will process. A request is not a drain. */
  defaultCycleLimit: 25,
  maxCycleLimit: 100,
} as const;

export function refundBacklogIsHealthy(
  backlog: RefundBacklog,
  policy: { maxOverdueSeconds: number } = REFUND_OPERATIONS_POLICY,
): boolean {
  if (backlog.refundsPermanentlyFailed > 0) return false;
  if (backlog.taxReversalsPermanentlyFailed > 0) return false;
  if (backlog.manualRemediationRequired > 0) return false;
  if (backlog.oldestUnresolvedAgeSeconds === null) return true;
  return backlog.oldestUnresolvedAgeSeconds <= policy.maxOverdueSeconds;
}

// — Requeue —

/**
 * Terminal payment-refund failures an operator may legitimately requeue.
 *
 * Only the codes whose cause is **outside the record**. Each became terminal by
 * exhausting attempts against a condition an operator can fix: a provider outage
 * longer than the backoff tail, a deployment with no payment configuration, a
 * credential in the wrong mode, or an unclassified condition since diagnosed.
 */
export const REQUEUEABLE_REFUND_FAILURE_CODES: readonly RefundFailureCode[] = [
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_REJECTED",
  "PROVIDER_MODE_NOT_PERMITTED",
  "UNSPECIFIED_FAILURE",
];

/**
 * Terminal payment-refund failures a requeue **cannot** fix.
 *
 * Stated as data so an operator tool can render the next action beside the
 * failure, and so nobody builds a retry button that does nothing.
 */
export const NON_REQUEUEABLE_REFUND_REMEDIATION = {
  /** The provider holds a refund Monacado never observed. Find out which. */
  ALREADY_REFUNDED: "RECONCILE_PROVIDER_REFUND",
  /** The provider does not know the charge. Retrying re-asks the same thing. */
  CHARGE_NOT_FOUND: "INVESTIGATE_RECORD_DIVERGENCE",
  /** More was asked for than remains. An amount question, not a timing one. */
  AMOUNT_EXCEEDS_CHARGE: "INVESTIGATE_RECORD_DIVERGENCE",
  /** Monacado's own records disagree. Retrying re-sends the disagreement. */
  EVIDENCE_INCONSISTENT: "INVESTIGATE_RECORD_DIVERGENCE",
} as const;

export function isRequeueableRefundFailure(code: RefundFailureCode | null): boolean {
  return code !== null && REQUEUEABLE_REFUND_FAILURE_CODES.includes(code);
}

/** The same rule for tax reversals. */
export const REQUEUEABLE_TAX_REVERSAL_FAILURE_CODES: readonly TaxReversalFailureCode[] = [
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_REJECTED",
  "PROVIDER_MODE_NOT_PERMITTED",
  "PAYMENT_REFUND_NOT_COMPLETE",
  "UNSPECIFIED_FAILURE",
];

export const NON_REQUEUEABLE_TAX_REVERSAL_REMEDIATION = {
  ORIGINAL_TRANSACTION_NOT_FOUND: "INVESTIGATE_RECORD_DIVERGENCE",
  ALREADY_REVERSED: "RECONCILE_PROVIDER_TAX_REVERSAL",
  DUPLICATE_REFERENCE: "RECONCILE_PROVIDER_TAX_REVERSAL",
  EVIDENCE_INCONSISTENT: "INVESTIGATE_RECORD_DIVERGENCE",
} as const;

export function isRequeueableTaxReversalFailure(
  code: TaxReversalFailureCode | null,
): boolean {
  return code !== null && REQUEUEABLE_TAX_REVERSAL_FAILURE_CODES.includes(code);
}

// — Operator actions —

/**
 * What an operator must do about one stuck row, as a bounded instruction.
 *
 * Closed vocabulary, safe to render and to log. It never says "retry" for a
 * condition retrying cannot fix — the whole reason this exists rather than a
 * generic button.
 */
export const REFUND_OPERATOR_ACTIONS = [
  /** Nothing to do; it is done. */
  "NONE",
  /** Nothing to do yet; it is due and a cycle will take it. */
  "AWAIT_SCHEDULED_CYCLE",
  /** Nothing to do yet; a worker holds it. */
  "AWAIT_IN_FLIGHT_ATTEMPT",
  /** Fix the named configuration, then requeue. */
  "CORRECT_CONFIGURATION_THEN_REQUEUE",
  /** A provider outage outlasted the retry schedule. Requeue when it is back. */
  "REQUEUE_AFTER_PROVIDER_RECOVERY",
  /** The provider already holds a refund Monacado never saw. Reconcile it. */
  "RECONCILE_PROVIDER_REFUND",
  /** The provider already holds a reversal Monacado never saw. Reconcile it. */
  "RECONCILE_PROVIDER_TAX_REVERSAL",
  /** Monacado's own records disagree. Investigate before doing anything. */
  "INVESTIGATE_RECORD_DIVERGENCE",
  /**
   * A buyer has their money back and the sale's tax stands reported as though
   * they do not. **No retry can help.** Putting it right is a tax adjustment.
   */
  "OPERATOR_TAX_ADJUSTMENT_REQUIRED",
] as const;
export const RefundOperatorAction = z.enum(REFUND_OPERATOR_ACTIONS);
export type RefundOperatorAction = z.infer<typeof RefundOperatorAction>;

/**
 * The action for one payment refund, from its status and last failure alone.
 *
 * Pure, so the operator tool, the readiness check, and a test all derive the same
 * answer from the same inputs rather than three places agreeing by accident.
 */
export function refundOperatorActionFor(input: {
  status: RefundStatus;
  lastFailureCode: RefundFailureCode | null;
}): RefundOperatorAction {
  switch (input.status) {
    case "REFUNDED":
      return "NONE";
    case "IN_PROGRESS":
      return "AWAIT_IN_FLIGHT_ATTEMPT";
    case "PENDING":
    case "RETRY_PENDING":
      return "AWAIT_SCHEDULED_CYCLE";
    case "FAILED_PERMANENT":
      break;
  }

  switch (input.lastFailureCode) {
    case "ALREADY_REFUNDED":
      return "RECONCILE_PROVIDER_REFUND";
    case "CHARGE_NOT_FOUND":
    case "AMOUNT_EXCEEDS_CHARGE":
    case "EVIDENCE_INCONSISTENT":
      return "INVESTIGATE_RECORD_DIVERGENCE";
    case "PROVIDER_UNAVAILABLE":
      return "REQUEUE_AFTER_PROVIDER_RECOVERY";
    default:
      /* An unclassified terminal failure is a configuration question until
         somebody proves otherwise — the conservative reading, and requeueable. */
      return "CORRECT_CONFIGURATION_THEN_REQUEUE";
  }
}

/** The same, for a tax reversal. */
export function taxReversalOperatorActionFor(input: {
  status: TaxReversalStatus;
  lastFailureCode: TaxReversalFailureCode | null;
}): RefundOperatorAction {
  switch (input.status) {
    case "REVERSED":
      return "NONE";
    case "IN_PROGRESS":
      return "AWAIT_IN_FLIGHT_ATTEMPT";
    case "PENDING":
    case "RETRY_PENDING":
      return "AWAIT_SCHEDULED_CYCLE";
    case "FAILED_PERMANENT":
      break;
  }

  switch (input.lastFailureCode) {
    case "ALREADY_REVERSED":
    case "DUPLICATE_REFERENCE":
      return "RECONCILE_PROVIDER_TAX_REVERSAL";
    case "ORIGINAL_TRANSACTION_NOT_FOUND":
    case "EVIDENCE_INCONSISTENT":
      /* The buyer has their money and the sale's tax cannot be reversed by any
         retry. That is an adjustment against the original sale, not a timer. */
      return "OPERATOR_TAX_ADJUSTMENT_REQUIRED";
    case "PROVIDER_UNAVAILABLE":
      return "REQUEUE_AFTER_PROVIDER_RECOVERY";
    default:
      return "CORRECT_CONFIGURATION_THEN_REQUEUE";
  }
}

// — Inspection —

/** Which half of the lifecycle one inspected row belongs to. */
export const REFUND_WORK_KINDS = ["PAYMENT_REFUND", "TAX_REVERSAL"] as const;
export const RefundWorkKind = z.enum(REFUND_WORK_KINDS);
export type RefundWorkKind = z.infer<typeof RefundWorkKind>;

/**
 * One stuck row, as an operator sees it.
 *
 * Carries the identifiers an operator needs to act and **nothing about the
 * buyer**: no name, email, address, or amount. The provider references are
 * included because acting on a stuck row means looking it up in the provider's
 * dashboard, and they identify a transaction rather than a person.
 */
export const RefundInspection = z.strictObject({
  kind: RefundWorkKind,
  orderId: z.string().min(1).max(191),
  refundId: z.string().min(1).max(191),
  /** Present only for a `TAX_REVERSAL` row. */
  taxReversalId: z.string().min(1).max(191).nullable(),
  /** The row's own status, in its own vocabulary. */
  status: z.string().min(1).max(32),
  attemptCount: z.int().min(0),
  requeueCount: z.int().min(0),
  lastFailureCode: z.string().min(1).max(48).nullable(),
  nextAttemptAt: z.iso.datetime().nullable(),
  /** The provider object this row acts on. Opaque; identifies no person. */
  providerTargetRef: z.string().min(1).max(191).nullable(),
  /** The provider object this row produced, where it succeeded. */
  providerResultRef: z.string().min(1).max(191).nullable(),
  action: RefundOperatorAction,
  requeueable: z.boolean(),
  ageSeconds: z.int().min(0),
});
export type RefundInspection = z.infer<typeof RefundInspection>;

// — Observability —

/**
 * Stable, bounded event names for one refund cycle.
 *
 * A closed list, following `1.8`: an operator's parser and any future alerting
 * rule depend on these strings, so they are enumerated rather than composed at a
 * call site.
 */
export const REFUND_CYCLE_EVENTS = [
  "refund_cycle_started",
  "refund_cycle_completed",
  "refund_cycle_failed",
] as const;
export type RefundCycleEvent = (typeof REFUND_CYCLE_EVENTS)[number];

/**
 * What a cycle reports, as counts.
 *
 * **Allow-list, not deny-list.** Every field is named here, so a field added to a
 * contract later cannot appear in an operational line by accident. Never emitted:
 * a buyer name, email, or address; a Stripe credential or the name of one; a raw
 * provider error; a full provider payload; an amount; a lock token.
 */
export interface RefundCycleCounts {
  refundsClaimed: number;
  refundsExecuted: number;
  refundsRetryScheduled: number;
  refundsPermanentlyFailed: number;
  taxReversalsClaimed: number;
  taxReversalsExecuted: number;
  taxReversalsRetryScheduled: number;
  taxReversalsPermanentlyFailed: number;
  staleClaimsRecovered: number;
  /** Rows that looked eligible but were taken by another worker first. */
  claimConflicts: number;
  /** Proceeds recovery exceptions raised by refunds completed this cycle. */
  recoveryExceptionsRaised: number;
}

/**
 * Where cycle events go. **Injected**, and a no-op by default.
 *
 * A monitor can never affect a refund: an implementation that throws is contained
 * by the caller, and a line written after a provider was contacted cannot
 * un-contact it. No logging framework and no `console`.
 */
export interface RefundCycleMonitor {
  onEvent(event: RefundCycleEvent, counts: Partial<RefundCycleCounts>): void;
}

/** The default: record nothing, and never fail. */
export const NULL_REFUND_CYCLE_MONITOR: RefundCycleMonitor = { onEvent: () => {} };
