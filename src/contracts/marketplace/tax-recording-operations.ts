/**
 * Tax recording operations (Phase 1.8).
 *
 * Phase 1.7 made tax recording **durable**. This makes it **dependable**: the
 * difference between work that survives a crash and work that actually runs.
 *
 * ```
 * commit paid sale + durable tax work
 *   → best-effort immediate attempt        (fast path, never load-bearing)
 *   → scheduled dispatcher                 (the guarantee)
 *   → backlog visibility + governed requeue (what an operator does when neither worked)
 * ```
 *
 * The invariant this phase is responsible for:
 *
 * > **A paid Order requiring provider Tax Transaction recording creates durable
 * > work that remains observable and recoverable until recorded or explicitly
 * > terminal.**
 *
 * `1.7` delivered the first half of that sentence. Without something that *runs*
 * the recorder, "durable" meant a row nobody would ever look at — recoverable in
 * principle and unrecovered in fact.
 *
 * ## No second retry engine
 *
 * Everything here reads or reports. The claim lease, attempt counting, backoff,
 * and terminal states remain exactly `1.7`'s, and the dispatcher invokes `1.7`'s
 * cycle rather than reimplementing it. The only state transition this phase adds
 * is a **governed requeue**, and it is operator-invoked, narrow, and refuses the
 * cases a retry could not fix.
 *
 * Pure types and pure decisions. No I/O, no clock, no vendor.
 */

import { z } from "zod";
import {
  TaxRecordingFailureCode,
  TaxTransactionRecordingStatus,
} from "./tax-transaction";

// — Backlog —

/**
 * What the tax-recording pipeline currently owes, as counts.
 *
 * Counts and ages only. **No Order id, no buyer, no amount** — a status summary
 * is rendered on operations screens and pasted into chat, and one that enumerated
 * sales would be a way to enumerate customers. The identifiers live in the
 * inspection view, which an operator opens deliberately.
 */
export const TaxRecordingBacklog = z.strictObject({
  pending: z.int().min(0),
  retryPending: z.int().min(0),
  /** Currently claimed by a worker, lease unexpired. */
  inProgress: z.int().min(0),
  recorded: z.int().min(0),
  permanentlyFailed: z.int().min(0),

  /**
   * Retryable rows whose `nextAttemptAt` has passed.
   *
   * The number a scheduler should be driving to zero. Persistently non-zero
   * means the dispatcher is not running, not that the work is hard.
   */
  dueNow: z.int().min(0),
  /**
   * Claims whose lease has expired and which no worker still holds.
   *
   * Recovered automatically by the next cycle. A non-zero count is only alarming
   * if it stays non-zero, which would mean no cycle is running at all.
   */
  expiredClaims: z.int().min(0),
  /**
   * The age of the oldest row that is neither recorded nor permanently failed,
   * in seconds. `null` when there is none.
   *
   * The single most useful number here: a growing oldest-age is the signal that
   * distinguishes "busy" from "broken".
   */
  oldestUnresolvedAgeSeconds: z.int().min(0).nullable(),
  /**
   * Paid Orders that need a provider Tax Transaction and have **no record at
   * all** — as opposed to one that exists and has not succeeded yet.
   *
   * A different failure with a different cause: `1.7` writes the row inside the
   * sale's transaction, so a gap here means either a pre-`1.7` Order or evidence
   * that predates the facts a transaction needs. Never fabricated into existence.
   */
  paidOrdersMissingTaxTransaction: z.int().min(0),
  /**
   * Permanently-failed rows whose calculation expired.
   *
   * Broken out because it is the one terminal state a requeue cannot fix — see
   * `CALCULATION_EXPIRY_REMEDIATION`.
   */
  calculationExpired: z.int().min(0),
  evaluatedAt: z.iso.datetime(),
});
export type TaxRecordingBacklog = z.infer<typeof TaxRecordingBacklog>;

/**
 * Whether the pipeline is healthy enough for live commerce.
 *
 * Deliberately not a single boolean on the backlog itself: "is anything stuck"
 * and "how long has it been stuck" are different questions, and an operator
 * chasing the second should not have to re-derive it from counts.
 */
export function backlogIsHealthy(
  backlog: TaxRecordingBacklog,
  policy: { maxOverdueSeconds: number } = TAX_RECORDING_OPERATIONS_POLICY,
): boolean {
  if (backlog.permanentlyFailed > 0) return false;
  if (backlog.paidOrdersMissingTaxTransaction > 0) return false;
  if (backlog.oldestUnresolvedAgeSeconds === null) return true;
  return backlog.oldestUnresolvedAgeSeconds <= policy.maxOverdueSeconds;
}

/**
 * The thresholds an operator is held to.
 *
 * `maxOverdueSeconds` is deliberately generous against the retry schedule: `1.7`
 * backs off to twelve hours, so a row legitimately in retry can be a day old
 * without anything being wrong. What it catches is a row that is old because
 * **nothing is running**, which a shorter threshold would confuse with ordinary
 * backoff and a longer one would not catch before the calculation expired.
 */
export const TAX_RECORDING_OPERATIONS_POLICY = {
  /** 36 hours: past the retry schedule's tail, well short of expiry. */
  maxOverdueSeconds: 36 * 60 * 60,
  /** What one dispatcher invocation will process. A request is not a drain. */
  defaultCycleLimit: 25,
  maxCycleLimit: 100,
} as const;

// — Requeue —

/**
 * Terminal failures an operator may legitimately requeue, and why.
 *
 * A requeue is **not** an undo. It does not erase the failure, does not alter a
 * sale-time fact, and does not claim the provider will answer differently — it
 * states that a human has changed something outside Monacado and wants the work
 * to run again.
 *
 * Only the codes whose cause is **outside the record** are here. Each of these
 * became terminal by exhausting attempts against a condition an operator can fix:
 * a provider outage longer than the backoff tail, a deployment that had no tax
 * configuration, a credential in the wrong mode, or an unclassified condition
 * that has since been diagnosed.
 */
export const REQUEUEABLE_FAILURE_CODES: readonly TaxRecordingFailureCode[] = [
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_NOT_CONFIGURED",
  "PROVIDER_REJECTED",
  "PROVIDER_MODE_NOT_PERMITTED",
  "UNSPECIFIED_FAILURE",
];

/**
 * Terminal failures a requeue **cannot** fix, and what is required instead.
 *
 * Stated as data rather than prose so an operator tool can render the next action
 * beside the failure, and so nobody builds a retry button that does nothing.
 *
 *   - `CALCULATION_EXPIRED` — the provider will not turn an expired calculation
 *     into a transaction, ever. No number of retries changes that.
 *   - `DUPLICATE_REFERENCE` — the provider already holds a transaction for this
 *     reference. Retrying asks it to do something it has already done; the real
 *     question is which transaction that is, which is reconciliation's.
 *   - `EVIDENCE_INCONSISTENT` — Monacado's own records disagree. Retrying would
 *     re-send the same disagreement.
 */
export const NON_REQUEUEABLE_FAILURE_REMEDIATION = {
  CALCULATION_EXPIRED: "OPERATOR_TAX_ADJUSTMENT_REQUIRED",
  DUPLICATE_REFERENCE: "RECONCILE_PROVIDER_TRANSACTION",
  EVIDENCE_INCONSISTENT: "INVESTIGATE_RECORD_DIVERGENCE",
} as const;

export function isRequeueableFailure(code: TaxRecordingFailureCode | null): boolean {
  return code !== null && REQUEUEABLE_FAILURE_CODES.includes(code);
}

/**
 * What an operator must do about one stuck row, as a bounded instruction.
 *
 * Closed vocabulary, safe to render and to log. It never says "retry" for a
 * condition retrying cannot fix — the whole reason this exists rather than a
 * generic button.
 */
export const TAX_RECORDING_OPERATOR_ACTIONS = [
  /** Nothing to do; it is recorded. */
  "NONE",
  /** Nothing to do yet; it is due and a cycle will take it. */
  "AWAIT_SCHEDULED_CYCLE",
  /** Nothing to do yet; a worker holds it. */
  "AWAIT_IN_FLIGHT_ATTEMPT",
  /** Fix the named configuration, then requeue. */
  "CORRECT_CONFIGURATION_THEN_REQUEUE",
  /** A provider outage outlasted the retry schedule. Requeue when it is back. */
  "REQUEUE_AFTER_PROVIDER_RECOVERY",
  /**
   * The calculation expired. **No requeue can help.** A paid sale exists whose
   * tax was never reported, and putting that right is an adjustment, not a retry.
   */
  "OPERATOR_TAX_ADJUSTMENT_REQUIRED",
  /** The provider already has a transaction for this reference. Reconcile it. */
  "RECONCILE_PROVIDER_TRANSACTION",
  /** Monacado's own records disagree. Investigate before doing anything. */
  "INVESTIGATE_RECORD_DIVERGENCE",
] as const;
export const TaxRecordingOperatorAction = z.enum(TAX_RECORDING_OPERATOR_ACTIONS);
export type TaxRecordingOperatorAction = z.infer<typeof TaxRecordingOperatorAction>;

/**
 * The action for one row, from its status and last failure alone.
 *
 * Pure, so the operator tool, the readiness check, and a test all derive the same
 * answer from the same inputs rather than three places agreeing by accident.
 */
export function operatorActionFor(input: {
  recordingStatus: TaxTransactionRecordingStatus;
  lastFailureCode: TaxRecordingFailureCode | null;
}): TaxRecordingOperatorAction {
  switch (input.recordingStatus) {
    case "RECORDED":
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
    case "CALCULATION_EXPIRED":
      return "OPERATOR_TAX_ADJUSTMENT_REQUIRED";
    case "DUPLICATE_REFERENCE":
      return "RECONCILE_PROVIDER_TRANSACTION";
    case "EVIDENCE_INCONSISTENT":
      return "INVESTIGATE_RECORD_DIVERGENCE";
    case "PROVIDER_UNAVAILABLE":
      return "REQUEUE_AFTER_PROVIDER_RECOVERY";
    case "PROVIDER_NOT_CONFIGURED":
    case "PROVIDER_MODE_NOT_PERMITTED":
    case "PROVIDER_REJECTED":
      return "CORRECT_CONFIGURATION_THEN_REQUEUE";
    default:
      /* An unclassified terminal failure is a configuration question until
         somebody proves otherwise — the conservative reading, and requeueable. */
      return "CORRECT_CONFIGURATION_THEN_REQUEUE";
  }
}

/**
 * What Monacado does about an expired calculation on a **paid** sale.
 *
 * Stated as a value because the tempting move is wrong. Silently calculating tax
 * again for a historical transaction would produce a *new* calculation, at
 * *today's* rates, for a sale priced months ago — and report it as though it were
 * what the buyer was charged. That is a fabricated tax record, and it would be
 * indistinguishable from a correct one.
 *
 * So the row stays terminal, visible, and named. Putting it right is an
 * adjustment against the original sale, which is the later reversal/adjustment
 * phase's subject and needs its own governed design.
 */
export const CALCULATION_EXPIRY_REMEDIATION = {
  /** The provider will not accept an expired calculation. Ever. */
  retryable: false,
  /** Monacado does not silently re-price a historical sale. */
  automaticRecalculation: "REFUSED",
  reason: "A NEW CALCULATION WOULD PRICE A HISTORICAL SALE AT TODAY'S RATES",
  /** What is true, and stays true until somebody acts. */
  surfacedState: [
    "A_PAID_ORDER_EXISTS",
    "TAX_TRANSACTION_RECORDING_INCOMPLETE",
    "OPERATOR_REMEDIATION_REQUIRED",
  ],
  /** Whose problem it becomes. */
  owner: "ADJUSTMENT_AND_RECONCILIATION_WORKFLOW",
} as const;

// — Inspection —

/**
 * One stuck row, as an operator sees it.
 *
 * Carries the identifiers an operator needs to act and **nothing about the
 * buyer**: no name, email, address, or amount. The provider references are
 * included because acting on a stuck row means looking it up in the provider's
 * dashboard, and they identify a transaction rather than a person.
 */
export const TaxRecordingInspection = z.strictObject({
  orderId: z.string().min(1).max(191),
  taxTransactionId: z.string().min(1).max(191),
  recordingStatus: TaxTransactionRecordingStatus,
  attemptCount: z.int().min(0),
  requeueCount: z.int().min(0),
  lastFailureCode: TaxRecordingFailureCode.nullable(),
  nextAttemptAt: z.iso.datetime().nullable(),
  /** The engine's calculation. Safe: an opaque provider object reference. */
  providerCalculationRef: z.string().min(1).max(191),
  /** The engine's transaction, where one exists. */
  providerTaxTransactionRef: z.string().min(1).max(191).nullable(),
  action: TaxRecordingOperatorAction,
  requeueable: z.boolean(),
  ageSeconds: z.int().min(0),
});
export type TaxRecordingInspection = z.infer<typeof TaxRecordingInspection>;

// — Observability —

/**
 * Stable, bounded event names for one recording cycle.
 *
 * A closed list, following `worker-monitoring.ts`: an operator's parser and any
 * future alerting rule depend on these strings, so they are enumerated rather
 * than composed at a call site.
 */
export const TAX_RECORDING_EVENTS = [
  "tax_recording_cycle_started",
  "tax_recording_cycle_completed",
  "tax_recording_cycle_failed",
] as const;
export type TaxRecordingEvent = (typeof TAX_RECORDING_EVENTS)[number];

/**
 * What a cycle reports, as counts.
 *
 * **Allow-list, not deny-list.** Every field is named here, so a field added to a
 * contract later cannot appear in an operational line by accident. Never emitted:
 * a buyer name, email, or address; a Stripe credential or the name of one; a raw
 * provider error; a full provider payload; an amount; a lock token.
 */
export interface TaxRecordingCycleCounts {
  claimed: number;
  recorded: number;
  retryScheduled: number;
  permanentlyFailed: number;
  staleClaimsRecovered: number;
  /** Rows that looked eligible but were taken by another worker first. */
  claimConflicts: number;
}

/**
 * Where cycle events go. **Injected**, and a no-op by default.
 *
 * A monitor can never affect recording: an implementation that throws is
 * contained by the caller, and a line written after a provider was contacted
 * cannot un-contact it. No logging framework and no `console` — the same
 * reasoning `worker-monitoring.ts` records.
 */
export interface TaxRecordingMonitor {
  onEvent(event: TaxRecordingEvent, counts: Partial<TaxRecordingCycleCounts>): void;
}

/** The default: record nothing, and never fail. */
export const NULL_TAX_RECORDING_MONITOR: TaxRecordingMonitor = { onEvent: () => {} };
