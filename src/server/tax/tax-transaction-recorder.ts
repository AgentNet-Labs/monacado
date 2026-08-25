/**
 * The tax transaction recorder (Phase 1.7) — SERVER ONLY.
 *
 * One bounded cycle: recover what a dead worker left, claim what is due, and for
 * each claimed row verify → report → resolve. **No loop, no scheduler, no
 * `setInterval`, no self-rescheduling** — exactly the shape
 * `worker:publication:once` and `email:dispatch:once` established, and for the
 * same reason: deciding to run a second cycle stays entirely outside, which is
 * what makes this safe to run by hand, from a protected endpoint, or from a
 * future scheduler without any of them inheriting a hidden loop.
 *
 * ## The order within one row
 *
 * ```
 *   claimed
 *      │
 *      ├─ re-read the 1.6 evidence and check it against the committed facts
 *      │     └─ missing or inconsistent ⇒ EVIDENCE_INCONSISTENT (permanent)
 *      │
 *      ├─ the calculation has not expired
 *      │     └─ expired ⇒ CALCULATION_EXPIRED (permanent — no retry brings it back)
 *      │
 *      ├─ TaxTransactionRecordingPort.record
 *      │
 *      └─ resolve the claim: RECORDED | RETRY_PENDING | FAILED_PERMANENT
 * ```
 *
 * The evidence check is **here and not at commit time**, deliberately. The
 * obligation is committed inside the sale's transaction, when the fastest
 * possible write matters and the provider cannot be consulted anyway; the
 * consistency question is asked at the moment it actually decides something —
 * immediately before Monacado tells a tax provider that a sale happened.
 *
 * ## It never runs for a sale that did not complete
 *
 * A tax transaction row exists only because `recordCompletedSale` created one
 * inside the sale's own transaction. A failed, cancelled, or still-pending Order
 * has no row, so there is nothing for this worker to claim — the guarantee comes
 * from where the row is written, not from a filter here. The Order lifecycle is
 * re-checked anyway, because a guarantee worth having is worth asserting.
 *
 * ## One failure never stops the batch
 *
 * Every per-row failure is caught, classified, and recorded against that row. A
 * provider timeout on the third sale must not abandon the fourth and fifth — and
 * a worker that threw halfway through would leave those rows claimed until their
 * leases expired.
 */

import "../server-only";
import {
  TAX_TRANSACTION_RETRY_POLICY,
  type OrderTaxTransactionRecord,
  type TaxRecordingFailureCode,
} from "../../contracts/marketplace/tax-transaction";
import { getPrisma } from "../db/client";
import {
  claimDueTaxTransactions,
  recoverStaleTaxTransactionClaims,
  resolveTaxTransactionAttempt,
  type TaxTransactionDeps,
} from "./tax-transaction-service";
import { taxTransactionIdempotencyKey } from "./tax-transaction-idempotency";
import { createStripeTaxTransactionRecorder, type TaxTransactionRecordingPort } from "./stripe-tax-transaction-adapter";

/** What one cycle did, as counts an operator can read. */
export interface TaxRecordingCycleOutcome {
  claimed: number;
  recorded: number;
  retryScheduled: number;
  permanentlyFailed: number;
  staleClaimsRecovered: number;
  ranAt: string;
}

export interface TaxRecordingCycleDeps extends TaxTransactionDeps {
  /** Injected so a test drives the whole cycle with no network at all. */
  port?: TaxTransactionRecordingPort;
}

/**
 * Verify a claimed row against its own evidence before reporting it.
 *
 * Returns a failure code, or `null` when the row may be reported. **Fails closed
 * on every disagreement**: telling a tax provider that a sale happened is a
 * statement Monacado has to stand behind, and a row whose evidence has since
 * moved is one nobody can stand behind.
 */
export async function verifyRecordableTaxTransaction(
  record: OrderTaxTransactionRecord,
  args: { now: string },
  deps: TaxTransactionDeps = {},
): Promise<TaxRecordingFailureCode | null> {
  const db = deps.db ?? getPrisma();

  const order = await db.order.findUnique({
    where: { id: record.orderId },
    select: { lifecycle: true, quotedTaxAmountMinorUnits: true, currency: true },
  });
  /* Asserted rather than assumed. The row cannot exist for an unpaid Order —
     it is written inside the sale's transaction — and a guarantee worth having
     is worth checking before Monacado reports a sale to a tax authority's
     system of record. */
  if (order === null || order.lifecycle !== "PAID") return "EVIDENCE_INCONSISTENT";

  const evidence = await db.orderTaxEvidence.findUnique({
    where: { orderId: record.orderId },
  });
  if (evidence === null) return "EVIDENCE_INCONSISTENT";

  /* The calculation the transaction will be created FROM must still be the one
     the sale was evidenced under. */
  if (evidence.providerCalculationRef !== record.providerCalculationRef) {
    return "EVIDENCE_INCONSISTENT";
  }
  if (evidence.currency !== record.currency) return "EVIDENCE_INCONSISTENT";
  if (Number(evidence.taxAmountMinorUnits) !== record.taxAmountMinorUnits) {
    return "EVIDENCE_INCONSISTENT";
  }
  if (Number(evidence.basisAmountMinorUnits) !== record.taxableBasisMinorUnits) {
    return "EVIDENCE_INCONSISTENT";
  }
  if (Number(order.quotedTaxAmountMinorUnits) !== record.taxAmountMinorUnits) {
    return "EVIDENCE_INCONSISTENT";
  }
  if (order.currency !== record.currency) return "EVIDENCE_INCONSISTENT";

  /* An expired calculation can never become a transaction, so a retry would only
     burn attempts against a refusal that cannot change. Permanent, and the row
     needs an operator rather than a timer. */
  if (
    evidence.providerCalculationExpiresAt !== null &&
    evidence.providerCalculationExpiresAt.getTime() <= new Date(args.now).getTime()
  ) {
    return "CALCULATION_EXPIRED";
  }

  return null;
}

/**
 * Run one bounded recording cycle.
 *
 * `at` is injected rather than read from a clock, so a test states the instant
 * and the schedule is reproducible.
 */
export async function runTaxTransactionRecordingCycle(
  args: { at: string; limit?: number },
  deps: TaxRecordingCycleDeps = {},
): Promise<TaxRecordingCycleOutcome> {
  const port = deps.port ?? createStripeTaxTransactionRecorder();
  const limit = Math.max(1, Math.min(args.limit ?? 25, 100));

  const staleClaimsRecovered = await recoverStaleTaxTransactionClaims({ now: args.at }, deps);
  const claimed = await claimDueTaxTransactions({ now: args.at, limit }, deps);

  let recorded = 0;
  let retryScheduled = 0;
  let permanentlyFailed = 0;

  for (const { record, lockToken } of claimed) {
    let resolved: OrderTaxTransactionRecord | null = null;
    try {
      const refusal = await verifyRecordableTaxTransaction(record, { now: args.at }, deps);
      if (refusal !== null) {
        resolved = await resolveTaxTransactionAttempt(
          { taxTransactionId: record.taxTransactionId, lockToken, at: args.at, result: { outcome: "FAILED", failureCode: refusal } },
          deps,
        );
      } else {
        const result = await port.record({
          providerCalculationRef: record.providerCalculationRef,
          providerReference: record.providerReference,
          /* Derived from the Order and the calculation, and therefore IDENTICAL
             on every attempt — which is what makes a retry after a timeout reuse
             the provider's existing transaction instead of creating a second. */
          idempotencyKey: taxTransactionIdempotencyKey({
            orderId: record.orderId,
            providerCalculationRef: record.providerCalculationRef,
          }),
        });
        resolved = await resolveTaxTransactionAttempt(
          {
            taxTransactionId: record.taxTransactionId,
            lockToken,
            at: args.at,
            result:
              result.outcome === "RECORDED"
                ? {
                    outcome: "RECORDED",
                    providerTaxTransactionRef: result.providerTaxTransactionRef,
                    providerTaxTransactionCreatedAt: result.providerTaxTransactionCreatedAt,
                    providerTotalAmountMinorUnits: result.providerTotalAmountMinorUnits,
                  }
                : { outcome: "FAILED", failureCode: result.failureCode },
          },
          deps,
        );
      }
    } catch {
      /* One row's failure never abandons the rest. The error itself is
         discarded — a database or provider error can carry a connection string
         or a request echo, and this runs in a worker log. The row stays claimed
         until its lease expires, which costs an attempt rather than the
         obligation. */
      continue;
    }

    if (resolved === null) continue;
    if (resolved.recordingStatus === "RECORDED") recorded += 1;
    else if (resolved.recordingStatus === "FAILED_PERMANENT") permanentlyFailed += 1;
    else retryScheduled += 1;
  }

  return {
    claimed: claimed.length,
    recorded,
    retryScheduled,
    permanentlyFailed,
    staleClaimsRecovered,
    ranAt: args.at,
  };
}

/** The claim lease this worker holds, exposed so an operator can reason about it. */
export const TAX_RECORDING_CLAIM_LEASE_SECONDS = TAX_TRANSACTION_RETRY_POLICY.claimLeaseSeconds;
