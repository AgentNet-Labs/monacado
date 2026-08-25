/**
 * Tax recording operations (Phase 1.8) — SERVER ONLY.
 *
 * Three read paths and **one** narrow write:
 *
 * ```
 * summarizeTaxRecordingBacklog   counts + ages, no identifiers   (a status screen)
 * inspectStuckTaxRecordings      identifiers + next action        (an operator acting)
 * requeueTaxRecording            the one governed state change    (after a human fixed something)
 * ```
 *
 * ## Local records only
 *
 * No provider call anywhere in this module. Everything an operator needs to know
 * about the backlog is already persisted — which is exactly what `1.7`'s
 * audit-efficient record was for — and a status command that had to reach Stripe
 * would stop working at the moment a credential problem made it most useful.
 *
 * ## The write is deliberately small
 *
 * `requeueTaxRecording` moves a terminal row back into the retry pool and does
 * **nothing else**. It does not clear the failure code, does not touch a
 * sale-time fact, does not contact a provider, and refuses outright for failures
 * a retry cannot fix. It is the difference between "a human has changed something
 * outside Monacado" and "make this go away".
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  TaxRecordingBacklog,
  TaxRecordingInspection,
  isRequeueableFailure,
  operatorActionFor,
  TAX_RECORDING_OPERATIONS_POLICY,
} from "../../contracts/marketplace/tax-recording-operations";
import type { TaxRecordingFailureCode } from "../../contracts/marketplace/tax-transaction";
import { getPrisma } from "../db/client";
import { TaxError } from "./tax-errors";
import { taxTransactionRowToRecord } from "./tax-transaction-service";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export interface TaxRecordingOperationsDeps {
  db?: Db;
}

export class TaxRequeueRefusedError extends TaxError {
  readonly reason: string;
  constructor(reason: string) {
    super("TAX_REQUEUE_REFUSED", `This tax recording may not be requeued: ${reason}`);
    this.name = "TaxRequeueRefusedError";
    this.reason = reason;
  }
}

const seconds = (from: Date, to: Date): number =>
  Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1_000));

// — Backlog —

/**
 * The counts and ages an operator or a readiness check needs.
 *
 * **No identifiers.** A status summary is rendered on operations screens and
 * pasted into chat; one that enumerated sales would be a way to enumerate
 * customers. Identifiers live in `inspectStuckTaxRecordings`, which is opened
 * deliberately.
 *
 * `paidOrdersMissingTaxTransaction` is counted separately from every other
 * number here because it is a **different** failure: `1.7` writes the row inside
 * the sale's transaction, so a gap means a pre-`1.7` Order or evidence that
 * predates the facts a transaction needs — not a provider problem, and not
 * something a cycle will ever fix.
 */
export async function summarizeTaxRecordingBacklog(
  at: string,
  deps: TaxRecordingOperationsDeps = {},
): Promise<TaxRecordingBacklog> {
  const db = deps.db ?? getPrisma();
  const now = new Date(at);

  try {
    const byStatus = await db.orderTaxTransaction.groupBy({
      by: ["recordingStatus"],
      _count: { _all: true },
    });
    const count = (status: string): number =>
      byStatus.find((row) => row.recordingStatus === status)?._count._all ?? 0;

    const dueNow = await db.orderTaxTransaction.count({
      where: {
        recordingStatus: { in: ["PENDING", "RETRY_PENDING"] },
        nextAttemptAt: { lte: now },
      },
    });

    const expiredClaims = await db.orderTaxTransaction.count({
      where: { recordingStatus: "IN_PROGRESS", leaseExpiresAt: { lt: now } },
    });

    const oldest = await db.orderTaxTransaction.findFirst({
      where: { recordingStatus: { in: ["PENDING", "IN_PROGRESS", "RETRY_PENDING"] } },
      orderBy: { recordedAt: "asc" },
      select: { recordedAt: true },
    });

    const calculationExpired = await db.orderTaxTransaction.count({
      where: { recordingStatus: "FAILED_PERMANENT", lastFailureCode: "CALCULATION_EXPIRED" },
    });

    /* A paid Order with NO row at all. Counted through the relation rather than
       by listing ids, so the summary stays free of identifiers. */
    const paidOrdersMissingTaxTransaction = await db.order.count({
      where: { lifecycle: "PAID", taxTransaction: { is: null } },
    });

    return TaxRecordingBacklog.parse({
      pending: count("PENDING"),
      retryPending: count("RETRY_PENDING"),
      inProgress: count("IN_PROGRESS"),
      recorded: count("RECORDED"),
      permanentlyFailed: count("FAILED_PERMANENT"),
      dueNow,
      expiredClaims,
      oldestUnresolvedAgeSeconds:
        oldest === null ? null : seconds(oldest.recordedAt, now),
      paidOrdersMissingTaxTransaction,
      calculationExpired,
      evaluatedAt: at,
    });
  } catch (error) {
    if (error instanceof TaxError) throw error;
    throw new TaxError(
      "TAX_BACKLOG_UNAVAILABLE",
      "The tax recording backlog could not be summarized",
    );
  }
}

// — Inspection —

/**
 * The rows an operator has to do something about, with the action named.
 *
 * Ordered oldest first, because the oldest is the one closest to its calculation
 * expiring. Bounded, and the bound is reported by the caller rather than silently
 * applied — a truncated list that reads as "that is all of them" is worse than no
 * list.
 *
 * Carries provider references, which identify a transaction rather than a person,
 * and **no buyer field of any kind**.
 */
export async function inspectStuckTaxRecordings(
  args: { at: string; limit?: number; includeRetrying?: boolean },
  deps: TaxRecordingOperationsDeps = {},
): Promise<TaxRecordingInspection[]> {
  const db = deps.db ?? getPrisma();
  const now = new Date(args.at);
  const limit = Math.max(1, Math.min(args.limit ?? 50, 200));

  const statuses = args.includeRetrying === true
    ? ["PENDING", "IN_PROGRESS", "RETRY_PENDING", "FAILED_PERMANENT"]
    : ["FAILED_PERMANENT"];

  try {
    const rows = await db.orderTaxTransaction.findMany({
      where: { recordingStatus: { in: statuses } },
      orderBy: { recordedAt: "asc" },
      take: limit,
    });

    return rows.map((row) => {
      const record = taxTransactionRowToRecord(row);
      const failureCode = record.lastFailureCode;
      return TaxRecordingInspection.parse({
        orderId: record.orderId,
        taxTransactionId: record.taxTransactionId,
        recordingStatus: record.recordingStatus,
        attemptCount: record.attemptCount,
        requeueCount: row.requeueCount,
        lastFailureCode: failureCode,
        nextAttemptAt: record.nextAttemptAt,
        providerCalculationRef: record.providerCalculationRef,
        providerTaxTransactionRef: record.providerTaxTransactionRef,
        action: operatorActionFor({
          recordingStatus: record.recordingStatus,
          lastFailureCode: failureCode,
        }),
        /* Only a terminal row is requeueable, and only for a failure whose cause
           is outside the record. */
        requeueable:
          record.recordingStatus === "FAILED_PERMANENT" && isRequeueableFailure(failureCode),
        ageSeconds: seconds(new Date(record.recordedAt), now),
      });
    });
  } catch (error) {
    if (error instanceof TaxError) throw error;
    throw new TaxError(
      "TAX_INSPECTION_UNAVAILABLE",
      "Stuck tax recordings could not be inspected",
    );
  }
}

// — Requeue —

/**
 * Put one terminal recording back in the retry pool. **Operator-invoked only.**
 *
 * Refuses unless the row is genuinely terminal *and* its failure has a cause
 * outside the record. An expired calculation, a duplicate provider reference, and
 * a divergence between Monacado's own records are each refused by name: retrying
 * them would re-send the same condition, and a button that did nothing would be
 * worse than no button.
 *
 * ## What it changes, and what it does not
 *
 * Changed: `recordingStatus` → `RETRY_PENDING`, `nextAttemptAt` → now,
 * `attemptCount` → 0, `finalizedAt` → null, plus the requeue evidence.
 *
 * **Unchanged:** every sale-time fact, the provider calculation reference, the
 * lifecycle state, and `lastFailureCode` — which is deliberately *kept*. The row
 * should still say what went wrong the last time somebody tried, because a
 * requeue is a decision to try again, not a claim that the failure never
 * happened.
 *
 * `attemptCount` resets so the bounded schedule starts again rather than
 * immediately re-terminating; `requeueCount` is what preserves the evidence that
 * it had already been tried and abandoned.
 */
export async function requeueTaxRecording(
  args: { taxTransactionId: string; at: string },
  deps: TaxRecordingOperationsDeps = {},
): Promise<TaxRecordingInspection> {
  const db = deps.db ?? getPrisma();

  const existing = await db.orderTaxTransaction.findUnique({
    where: { id: args.taxTransactionId },
  });
  if (existing === null) throw new TaxRequeueRefusedError("NOT_FOUND");
  if (existing.recordingStatus !== "FAILED_PERMANENT") {
    /* A row that is still retrying does not need help, and a recorded one must
       never be re-sent — that would ask the provider for a second transaction. */
    throw new TaxRequeueRefusedError("NOT_TERMINAL");
  }
  const failureCode = existing.lastFailureCode as TaxRecordingFailureCode | null;
  if (!isRequeueableFailure(failureCode)) {
    throw new TaxRequeueRefusedError("FAILURE_NOT_REQUEUEABLE");
  }

  try {
    const row = await db.orderTaxTransaction.update({
      where: { id: args.taxTransactionId },
      data: {
        recordingStatus: "RETRY_PENDING",
        nextAttemptAt: new Date(args.at),
        attemptCount: 0,
        finalizedAt: null,
        requeueCount: existing.requeueCount + 1,
        lastRequeuedAt: new Date(args.at),
        /* lastFailureCode / lastFailureClass are deliberately RETAINED. */
      },
    });
    const record = taxTransactionRowToRecord(row);
    return TaxRecordingInspection.parse({
      orderId: record.orderId,
      taxTransactionId: record.taxTransactionId,
      recordingStatus: record.recordingStatus,
      attemptCount: record.attemptCount,
      requeueCount: row.requeueCount,
      lastFailureCode: record.lastFailureCode,
      nextAttemptAt: record.nextAttemptAt,
      providerCalculationRef: record.providerCalculationRef,
      providerTaxTransactionRef: record.providerTaxTransactionRef,
      action: operatorActionFor({
        recordingStatus: record.recordingStatus,
        lastFailureCode: record.lastFailureCode,
      }),
      requeueable: false,
      ageSeconds: seconds(new Date(record.recordedAt), new Date(args.at)),
    });
  } catch (error) {
    if (error instanceof TaxError) throw error;
    throw new TaxError("TAX_REQUEUE_FAILED", "The tax recording could not be requeued");
  }
}

/** Shared existence read, usable inside and outside a transaction. */
export async function countDueTaxRecordingsIn(tx: Tx, at: string): Promise<number> {
  return tx.orderTaxTransaction.count({
    where: {
      recordingStatus: { in: ["PENDING", "RETRY_PENDING"] },
      nextAttemptAt: { lte: new Date(at) },
    },
  });
}

export { TAX_RECORDING_OPERATIONS_POLICY };

// — Operational readiness —

/**
 * Whether tax recording is not merely configured but **working**.
 *
 * The database-backed half of tax readiness. `evaluateTaxReadiness` stays pure
 * configuration inspection — no network, no database — and answers *is the
 * deployment set up*. This answers *is it actually keeping up*, which only the
 * rows can say.
 *
 * Two blockers, and both are about consequences rather than tidiness:
 *
 *   - **a permanent-failure backlog** means paid sales whose tax was never
 *     reported and which no timer will fix. Every one is a return line that will
 *     be missing.
 *   - **overdue work** means the dispatcher is not running. The threshold sits
 *     past `1.7`'s retry tail and well short of calculation expiry, so ordinary
 *     backoff never trips it and a stopped scheduler always does.
 *
 * Still **no provider call**: every fact is local.
 */
export const TAX_OPERATIONS_BLOCKER_CODES = [
  "TAX_RECORDING_PERMANENT_FAILURES",
  "TAX_RECORDING_OVERDUE",
  "PAID_ORDERS_MISSING_TAX_TRANSACTION",
] as const;
export type TaxOperationsBlockerCode = (typeof TAX_OPERATIONS_BLOCKER_CODES)[number];

export interface TaxOperationsReadiness {
  healthy: boolean;
  blockers: TaxOperationsBlockerCode[];
  backlog: TaxRecordingBacklog;
}

export async function evaluateTaxOperationsReadiness(
  at: string,
  deps: TaxRecordingOperationsDeps = {},
): Promise<TaxOperationsReadiness> {
  const backlog = await summarizeTaxRecordingBacklog(at, deps);
  const blockers: TaxOperationsBlockerCode[] = [];

  if (backlog.permanentlyFailed > 0) blockers.push("TAX_RECORDING_PERMANENT_FAILURES");
  if (backlog.paidOrdersMissingTaxTransaction > 0) {
    blockers.push("PAID_ORDERS_MISSING_TAX_TRANSACTION");
  }
  if (
    backlog.oldestUnresolvedAgeSeconds !== null &&
    backlog.oldestUnresolvedAgeSeconds > TAX_RECORDING_OPERATIONS_POLICY.maxOverdueSeconds
  ) {
    blockers.push("TAX_RECORDING_OVERDUE");
  }

  return { healthy: blockers.length === 0, blockers, backlog };
}
