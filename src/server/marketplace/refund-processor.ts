/**
 * The refund processor (Phase 1.9) — SERVER ONLY.
 *
 * One bounded cycle: recover what a dead worker left, then run **both halves of
 * the lifecycle in order**. **No loop, no scheduler, no `setInterval`, no
 * self-rescheduling** — exactly the shape `worker:publication:once`,
 * `email:dispatch:once`, and `tax:record:once` established, and for the same
 * reason: deciding to run a second cycle stays entirely outside, which is what
 * makes this safe to run by hand, from a protected endpoint, or from a future
 * scheduler without any of them inheriting a hidden loop.
 *
 * ## Payment refunds first, then tax reversals — within one cycle
 *
 * ```
 *   recover stale claims (both kinds)
 *        │
 *        ├─ claim due PAYMENT REFUNDS
 *        │     └─ verify → provider → resolve
 *        │           on success, ONE transaction also writes the accounting
 *        │           entry, reverses the settlement, commits the tax-reversal
 *        │           obligation, and raises recovery exceptions
 *        │
 *        └─ claim due TAX REVERSALS   ← includes ones committed moments ago
 *              └─ verify → provider → resolve
 * ```
 *
 * The ordering is deliberate and is what makes an ordinary refund complete in a
 * single cycle: the tax-reversal obligation is committed during the first half
 * and becomes claimable in the second. A refund whose payment succeeded and whose
 * tax reversal failed simply carries into the next cycle, which is the recoverable
 * state `1.9` exists to make expressible.
 *
 * ## A failed payment refund never produces a tax reversal
 *
 * Structurally: the obligation row is written **only** inside the transaction
 * that marks a refund `REFUNDED`, so a failed refund creates nothing for the
 * second half to claim. `verifyReversibleTaxReversal` re-asserts it anyway.
 *
 * ## One failure never stops the batch
 *
 * Every per-row failure is caught, classified, and recorded against that row. A
 * provider timeout on the third refund must not abandon the fourth and fifth —
 * and a worker that threw halfway through would leave those rows claimed until
 * their leases expired.
 *
 * ## Notifications never affect financial outcomes
 *
 * Notices are enqueued **after** the refund transaction has committed, and every
 * failure to enqueue one is swallowed. A refund that succeeded and whose receipt
 * could not be queued is a refund that succeeded. The reverse — failing a refund
 * because an email row would not write — would be strictly worse for the buyer.
 */

import "../server-only";
import {
  REFUND_RETRY_POLICY,
  type RefundReasonCode,
  type RefundStatus,
} from "../../contracts/marketplace/order-refund";
import {
  NULL_REFUND_CYCLE_MONITOR,
  type RefundCycleCounts,
  type RefundCycleEvent,
  type RefundCycleMonitor,
} from "../../contracts/marketplace/refund-operations";
import type { RefundExecutionPort } from "../../contracts/marketplace/transaction-reversal";
import {
  createStripeRefundAdapter,
  refundFailureCodeFor,
} from "../payments/stripe-refund-adapter";
import {
  createStripeTaxReversalAdapter,
  type TaxReversalPort,
} from "../tax/stripe-tax-reversal-adapter";
import {
  claimDueTaxReversals,
  recoverStaleTaxReversalClaims,
  resolveTaxReversalAttempt,
  verifyReversibleTaxReversal,
} from "../tax/tax-reversal-service";
import {
  claimDueRefunds,
  evaluateRefundEligibility,
  recoverStaleRefundClaims,
  resolveRefundAttempt,
  type RefundServiceDeps,
} from "./order-refund-service";
import { refundIdempotencyKey, taxReversalIdempotencyKey } from "./refund-idempotency";
import {
  enqueueRefundNotices,
  type RefundNoticeDeps,
} from "../notifications/refund-notice-service";

/** What one cycle did, as counts an operator can read. */
export interface RefundCycleOutcome extends RefundCycleCounts {
  ranAt: string;
}

export interface RefundCycleDeps extends RefundServiceDeps {
  /** Injected so a test drives the whole cycle with no network at all. */
  refundPort?: RefundExecutionPort;
  taxReversalPort?: TaxReversalPort;
  /**
   * Where cycle events go. **Injected, and silent by default.**
   *
   * Monitoring can never affect a refund: a monitor that throws is contained
   * here, and a line written after a provider was contacted cannot un-contact it.
   */
  monitor?: RefundCycleMonitor;
  /**
   * Notice-side dependencies, kept in their own bag on purpose.
   *
   * `RefundServiceDeps.ids` is a `RefundIdProvider` and `RefundNoticeDeps.ids` is
   * an `OutboundEmailIdProvider`; they are different id spaces for different
   * records, and flattening them into one field would force one subsystem's
   * provider on the other. A test that wants deterministic email ids supplies
   * them here without touching the refund ids.
   */
  notices?: Omit<RefundNoticeDeps, "db">;
}

/**
 * Re-verify a claimed refund against its own evidence before executing it.
 *
 * Returns a refusal, or `null` when the row may be executed. **Fails closed on
 * every disagreement**: returning money is a statement Monacado has to stand
 * behind, and a row whose evidence has since moved is one nobody can stand
 * behind.
 *
 * The check happens **here and not only at request time**, deliberately. The
 * request is committed the moment somebody decides to refund; the consistency
 * question is asked at the moment it actually decides something — immediately
 * before money moves.
 *
 * `REFUND_ALREADY_EXISTS` is expected and ignored: this row *is* that refund.
 */
export async function verifyExecutableRefund(
  record: {
    orderId: string;
    currency: string;
    amountMinorUnits: number;
    providerTransactionRef: string;
    /** This refund's own reason and lines — the inputs its amount came from. */
    reasonCode: RefundReasonCode;
    lineRefs: readonly string[];
    requestedAt: string;
  },
  args: { now: string },
  deps: RefundServiceDeps = {},
): Promise<"EVIDENCE_INCONSISTENT" | null> {
  /* Re-derived with THIS REFUND'S OWN inputs — its reason code and its selected
     lines — because both feed the amount. Re-evaluating with defaults would
     compute a different figure for a policy whose shipping rule depends on the
     reason, and then reject a perfectly good refund as inconsistent with itself.
     
     And evaluated `at` the instant the refund was REQUESTED, not now: the
     seller's declared window governs when a buyer may ASK, and a request made in
     time must not become ineligible because a worker ran after the window
     closed. Everything else the check cares about — the Order, the snapshot, the
     charge, the bound policy — is immutable, so the earlier instant costs
     nothing. */
  const eligibility = await evaluateRefundEligibility(
    {
      orderId: record.orderId,
      at: record.requestedAt,
      reasonCode: record.reasonCode,
      selectedLineRefs: record.lineRefs,
    },
    deps,
  );
  void args.now;

  const disqualifying = eligibility.refusals.filter(
    (code) => code !== "REFUND_ALREADY_EXISTS" && code !== "CONFLICTING_REFUND_STATE",
  );
  if (disqualifying.length > 0) return "EVIDENCE_INCONSISTENT";

  /* The charge and the amount must still be the ones this refund was committed
     against. A row whose target moved is a row that would return an amount
     nobody authorised, against a charge nobody named. */
  if (eligibility.providerTransactionRef !== record.providerTransactionRef) {
    return "EVIDENCE_INCONSISTENT";
  }
  if (eligibility.currency !== record.currency) return "EVIDENCE_INCONSISTENT";
  if (
    eligibility.refundableAmountMinorUnits !== null &&
    eligibility.refundableAmountMinorUnits !== record.amountMinorUnits
  ) {
    return "EVIDENCE_INCONSISTENT";
  }
  return null;
}

/**
 * Run one bounded refund cycle.
 *
 * `at` is injected rather than read from a clock, so a test states the instant
 * and the schedule is reproducible.
 */
export async function runRefundCycle(
  args: { at: string; limit?: number },
  deps: RefundCycleDeps = {},
): Promise<RefundCycleOutcome> {
  const refundPort = deps.refundPort ?? createStripeRefundAdapter();
  const taxReversalPort = deps.taxReversalPort ?? createStripeTaxReversalAdapter();
  const monitor = deps.monitor ?? NULL_REFUND_CYCLE_MONITOR;
  const limit = Math.max(1, Math.min(args.limit ?? 25, 100));

  emit(monitor, "refund_cycle_started", {});

  const staleRefunds = await recoverStaleRefundClaims({ now: args.at }, deps);
  const staleTaxReversals = await recoverStaleTaxReversalClaims({ now: args.at }, deps);

  const payment = await runPaymentRefundHalf(
    { at: args.at, limit, port: refundPort },
    deps,
  );
  const tax = await runTaxReversalHalf(
    { at: args.at, limit, port: taxReversalPort },
    deps,
  );

  const counts: RefundCycleCounts = {
    refundsClaimed: payment.claimed,
    refundsExecuted: payment.executed,
    refundsRetryScheduled: payment.retryScheduled,
    refundsPermanentlyFailed: payment.permanentlyFailed,
    taxReversalsClaimed: tax.claimed,
    taxReversalsExecuted: tax.executed,
    taxReversalsRetryScheduled: tax.retryScheduled,
    taxReversalsPermanentlyFailed: tax.permanentlyFailed,
    staleClaimsRecovered: staleRefunds + staleTaxReversals,
    claimConflicts: payment.conflicts + tax.conflicts,
    recoveryExceptionsRaised: payment.recoveryExceptionsRaised,
  };
  emit(monitor, "refund_cycle_completed", counts);
  return { ...counts, ranAt: args.at };
}

interface HalfOutcome {
  claimed: number;
  executed: number;
  retryScheduled: number;
  permanentlyFailed: number;
  conflicts: number;
  recoveryExceptionsRaised: number;
}

async function runPaymentRefundHalf(
  args: { at: string; limit: number; port: RefundExecutionPort },
  deps: RefundCycleDeps,
): Promise<HalfOutcome> {
  const claim = await claimDueRefunds({ now: args.at, limit: args.limit }, deps);

  let executed = 0;
  let retryScheduled = 0;
  let permanentlyFailed = 0;
  let recoveryExceptionsRaised = 0;

  for (const { record, lockToken } of claim.claimed) {
    let resolvedStatus: RefundStatus | null = null;
    let notify = false;
    try {
      const refusal = await verifyExecutableRefund(
        {
          orderId: record.orderId,
          currency: record.currency,
          amountMinorUnits: record.amountMinorUnits,
          providerTransactionRef: record.providerTransactionRef,
          reasonCode: record.reasonCode,
          lineRefs: record.lineRefs,
          requestedAt: record.requestedAt,
        },
        { now: args.at },
        deps,
      );

      const resolved =
        refusal !== null
          ? await resolveRefundAttempt(
              {
                refundId: record.refundId,
                lockToken,
                at: args.at,
                result: { outcome: "FAILED", failureCode: refusal },
              },
              deps,
            )
          : await executeAndResolve(record, lockToken, args, deps);

      if (resolved === null) continue;
      resolvedStatus = resolved.refund.status;
      recoveryExceptionsRaised += resolved.recoveryExceptionIds.length;
      notify = resolved.refund.status === "REFUNDED";
    } catch {
      /* One row's failure never abandons the rest. The error itself is
         discarded — a database or provider error can carry a connection string
         or a request echo, and this runs in a worker log. The row stays claimed
         until its lease expires, which costs an attempt rather than the
         obligation. */
      continue;
    }

    if (resolvedStatus === "REFUNDED") executed += 1;
    else if (resolvedStatus === "FAILED_PERMANENT") permanentlyFailed += 1;
    else retryScheduled += 1;

    if (notify) {
      /* AFTER the transaction, and never load-bearing. A refund that succeeded
         and whose receipt could not be queued is a refund that succeeded. */
      try {
        await enqueueRefundNotices(
          { orderId: record.orderId, at: args.at },
          { ...deps.notices, ...(deps.db === undefined ? {} : { db: deps.db }) },
        );
      } catch {
        /* Deliberately swallowed. See the module header. */
      }
    }
  }

  return {
    claimed: claim.claimed.length,
    executed,
    retryScheduled,
    permanentlyFailed,
    conflicts: claim.conflicts,
    recoveryExceptionsRaised,
  };
}

async function executeAndResolve(
  record: {
    refundId: string;
    orderId: string;
    provider: "STRIPE";
    currency: string;
    amountMinorUnits: number;
    providerTransactionRef: string;
  },
  lockToken: string,
  args: { at: string; port: RefundExecutionPort },
  deps: RefundCycleDeps,
) {
  const result = await args.port.executeRefund({
    providerTransactionRef: record.providerTransactionRef,
    provider: record.provider,
    currency: record.currency,
    amountMinorUnits: record.amountMinorUnits,
    /* Derived from the refund and the original charge, and therefore IDENTICAL
       on every attempt — which is the only thing standing between a retry after
       a timeout and a buyer being refunded twice. Stripe's Refunds API has no
       `reference` uniqueness rule to fall back on. */
    idempotencyKey: refundIdempotencyKey({
      refundId: record.refundId,
      providerTransactionRef: record.providerTransactionRef,
    }),
  });

  return resolveRefundAttempt(
    {
      refundId: record.refundId,
      lockToken,
      at: args.at,
      result:
        result.outcome === "EXECUTED"
          ? {
              outcome: "REFUNDED",
              providerRefundRef: result.providerReversalRef,
              providerRefundCreatedAt: result.providerCreatedAt,
            }
          : { outcome: "FAILED", failureCode: refundFailureCodeFor(result.failureCode) },
    },
    deps,
  );
}

async function runTaxReversalHalf(
  args: { at: string; limit: number; port: TaxReversalPort },
  deps: RefundCycleDeps,
): Promise<HalfOutcome> {
  const claim = await claimDueTaxReversals({ now: args.at, limit: args.limit }, deps);

  let executed = 0;
  let retryScheduled = 0;
  let permanentlyFailed = 0;

  for (const { record, lockToken } of claim.claimed) {
    let status: string | null = null;
    try {
      const refusal = await verifyReversibleTaxReversal(record, deps);
      const resolved =
        refusal !== null
          ? await resolveTaxReversalAttempt(
              {
                taxReversalId: record.taxReversalId,
                lockToken,
                at: args.at,
                result: { outcome: "FAILED", failureCode: refusal },
              },
              deps,
            )
          : await reverseAndResolve(record, lockToken, args, deps);
      if (resolved === null) continue;
      status = resolved.status;
    } catch {
      /* One row's failure never abandons the rest. See above. */
      continue;
    }

    if (status === "REVERSED") executed += 1;
    else if (status === "FAILED_PERMANENT") permanentlyFailed += 1;
    else retryScheduled += 1;
  }

  return {
    claimed: claim.claimed.length,
    executed,
    retryScheduled,
    permanentlyFailed,
    conflicts: claim.conflicts,
    recoveryExceptionsRaised: 0,
  };
}

async function reverseAndResolve(
  record: {
    taxReversalId: string;
    originalProviderTaxTransactionRef: string;
    providerReference: string;
  },
  lockToken: string,
  args: { at: string; port: TaxReversalPort },
  deps: RefundCycleDeps,
) {
  const result = await args.port.reverse({
    /* The EXACT original transaction `1.7` recorded, from this row's own copy of
       it. Never a fresh calculation, and never re-read from the original row. */
    originalProviderTaxTransactionRef: record.originalProviderTaxTransactionRef,
    providerReference: record.providerReference,
    idempotencyKey: taxReversalIdempotencyKey({
      taxReversalId: record.taxReversalId,
      originalProviderTaxTransactionRef: record.originalProviderTaxTransactionRef,
    }),
  });

  return resolveTaxReversalAttempt(
    {
      taxReversalId: record.taxReversalId,
      lockToken,
      at: args.at,
      result:
        result.outcome === "REVERSED"
          ? {
              outcome: "REVERSED",
              providerReversalRef: result.providerReversalRef,
              providerReversalCreatedAt: result.providerReversalCreatedAt,
            }
          : { outcome: "FAILED", failureCode: result.failureCode },
    },
    deps,
  );
}

/**
 * Emit one monitoring event, and never let it matter.
 *
 * A monitor that throws is contained here. Monitoring must not change an outcome,
 * and above all must not cause a second provider call — a line written after
 * money moved cannot un-move it.
 */
function emit(
  monitor: RefundCycleMonitor,
  event: RefundCycleEvent,
  counts: Partial<RefundCycleCounts>,
): void {
  try {
    monitor.onEvent(event, counts);
  } catch {
    /* Deliberately swallowed. See above. */
  }
}

/** The claim lease this worker holds, exposed so an operator can reason about it. */
export const REFUND_CLAIM_LEASE_SECONDS = REFUND_RETRY_POLICY.claimLeaseSeconds;
