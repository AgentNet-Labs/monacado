/**
 * Refund operations (Phase 1.9) — SERVER ONLY.
 *
 * Three read paths and **one** narrow write, on `1.8`'s pattern exactly:
 *
 * ```
 * summarizeRefundBacklog     counts + ages, no identifiers   (a status screen)
 * inspectStuckRefundWork     identifiers + next action        (an operator acting)
 * requeueRefundWork          the one governed state change    (after a human fixed something)
 * ```
 *
 * Plus the proceeds-recovery exception lifecycle, which is read and advanced here
 * because it is operational rather than transactional: nothing in it moves money,
 * and an operator marking one resolved is recording what they did elsewhere.
 *
 * ## Local records only
 *
 * No provider call anywhere in this module. A status command that had to reach
 * Stripe would stop working at the moment a credential problem made it most
 * useful — and for refunds specifically, a credential problem is one of the
 * likeliest reasons the backlog exists.
 *
 * ## The write is deliberately small
 *
 * `requeueRefundWork` moves a terminal row back into the retry pool and does
 * **nothing else**. It does not clear the failure code, does not touch a
 * request-time fact, does not contact a provider, and refuses outright for
 * failures a retry cannot fix. It is the difference between "a human has changed
 * something outside Monacado" and "make this go away".
 */

import "../server-only";
import {
  RefundBacklog,
  RefundInspection,
  REFUND_OPERATIONS_POLICY,
  isRequeueableRefundFailure,
  isRequeueableTaxReversalFailure,
  refundOperatorActionFor,
  taxReversalOperatorActionFor,
  type RefundWorkKind,
} from "../../contracts/marketplace/refund-operations";
import {
  refundLifecycleState,
  type RefundFailureCode,
  type RefundStatus,
} from "../../contracts/marketplace/order-refund";
import {
  ProceedsRecoveryExceptionRecord,
  isValidProceedsRecoveryTransition,
  type ProceedsRecoveryResolutionCode,
  type ProceedsRecoveryStatus,
} from "../../contracts/marketplace/proceeds-recovery";
import type {
  TaxReversalFailureCode,
  TaxReversalStatus,
} from "../../contracts/marketplace/tax-reversal";
import { getPrisma } from "../db/client";
import {
  InvalidProceedsRecoveryTransitionError,
  ProceedsRecoveryNotFoundError,
  RefundError,
  RefundPersistenceFailureError,
  RefundRequeueRefusedError,
} from "./refund-errors";

type Db = ReturnType<typeof getPrisma>;

export interface RefundOperationsDeps {
  db?: Db;
}

const seconds = (from: Date, to: Date): number =>
  Math.max(0, Math.floor((to.getTime() - from.getTime()) / 1_000));

// — Backlog —

/**
 * The counts and ages an operator or a readiness check needs.
 *
 * **No identifiers.** A status summary is rendered on operations screens and
 * pasted into chat; one that enumerated refunds would be a way to enumerate
 * customers *and* their grievances. Identifiers live in `inspectStuckRefundWork`,
 * which is opened deliberately.
 */
export async function summarizeRefundBacklog(
  at: string,
  deps: RefundOperationsDeps = {},
): Promise<RefundBacklog> {
  const db = deps.db ?? getPrisma();
  const now = new Date(at);

  try {
    const refundsByStatus = await db.orderRefund.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const reversalsByStatus = await db.orderTaxReversal.groupBy({
      by: ["status"],
      _count: { _all: true },
    });
    const refunds = (status: string): number =>
      refundsByStatus.find((r) => r.status === status)?._count._all ?? 0;
    const reversals = (status: string): number =>
      reversalsByStatus.find((r) => r.status === status)?._count._all ?? 0;

    /* Refunded payments whose tax reversal has not completed — counted from the
       reversal side, so a refunded sale with NO reversal row (nothing was ever
       reported to a tax provider) is correctly not counted as a lag. */
    const paymentRefundedTaxNotReversed = await db.orderTaxReversal.count({
      where: {
        status: { in: ["PENDING", "IN_PROGRESS", "RETRY_PENDING"] },
        refund: { is: { status: "REFUNDED" } },
      },
    });
    const manualRemediationRequired = await db.orderTaxReversal.count({
      where: { status: "FAILED_PERMANENT", refund: { is: { status: "REFUNDED" } } },
    });

    const openProceedsRecoveryExceptions = await db.proceedsRecoveryException.count({
      where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } },
    });

    const dueNow =
      (await db.orderRefund.count({
        where: {
          status: { in: ["PENDING", "RETRY_PENDING"] },
          nextAttemptAt: { lte: now },
        },
      })) +
      (await db.orderTaxReversal.count({
        where: {
          status: { in: ["PENDING", "RETRY_PENDING"] },
          nextAttemptAt: { lte: now },
        },
      }));

    const expiredClaims =
      (await db.orderRefund.count({
        where: { status: "IN_PROGRESS", leaseExpiresAt: { lt: now } },
      })) +
      (await db.orderTaxReversal.count({
        where: { status: "IN_PROGRESS", leaseExpiresAt: { lt: now } },
      }));

    /* The oldest refund that has not reached a resting state. A refund whose
       payment succeeded is still unresolved while its tax reversal has not, so
       both conditions are considered. */
    const oldestRefund = await db.orderRefund.findFirst({
      where: { status: { in: ["PENDING", "IN_PROGRESS", "RETRY_PENDING"] } },
      orderBy: { recordedAt: "asc" },
      select: { recordedAt: true },
    });
    const oldestReversal = await db.orderTaxReversal.findFirst({
      where: { status: { in: ["PENDING", "IN_PROGRESS", "RETRY_PENDING"] } },
      orderBy: { recordedAt: "asc" },
      select: { recordedAt: true },
    });
    const oldestAt =
      oldestRefund === null
        ? oldestReversal?.recordedAt ?? null
        : oldestReversal === null
          ? oldestRefund.recordedAt
          : oldestRefund.recordedAt < oldestReversal.recordedAt
            ? oldestRefund.recordedAt
            : oldestReversal.recordedAt;

    return RefundBacklog.parse({
      refundsPending: refunds("PENDING"),
      refundsInProgress: refunds("IN_PROGRESS"),
      refundsRetryPending: refunds("RETRY_PENDING"),
      refundsCompleted: refunds("REFUNDED"),
      refundsPermanentlyFailed: refunds("FAILED_PERMANENT"),
      taxReversalsPending: reversals("PENDING"),
      taxReversalsInProgress: reversals("IN_PROGRESS"),
      taxReversalsRetryPending: reversals("RETRY_PENDING"),
      taxReversalsCompleted: reversals("REVERSED"),
      taxReversalsPermanentlyFailed: reversals("FAILED_PERMANENT"),
      paymentRefundedTaxNotReversed,
      manualRemediationRequired,
      openProceedsRecoveryExceptions,
      dueNow,
      expiredClaims,
      oldestUnresolvedAgeSeconds: oldestAt === null ? null : seconds(oldestAt, now),
      evaluatedAt: at,
    });
  } catch (error) {
    if (error instanceof RefundError) throw error;
    throw new RefundPersistenceFailureError("summarizeRefundBacklog", error);
  }
}

// — Inspection —

/**
 * The rows an operator has to do something about, with the action named.
 *
 * Ordered oldest first. Bounded, and the bound is reported by the caller rather
 * than silently applied — a truncated list that reads as "that is all of them" is
 * worse than no list.
 *
 * Carries provider references, which identify a transaction rather than a person,
 * and **no buyer field of any kind and no amount**.
 */
export async function inspectStuckRefundWork(
  args: { at: string; limit?: number; includeRetrying?: boolean },
  deps: RefundOperationsDeps = {},
): Promise<RefundInspection[]> {
  const db = deps.db ?? getPrisma();
  const now = new Date(args.at);
  const limit = Math.max(1, Math.min(args.limit ?? 50, 200));

  const statuses = args.includeRetrying === true
    ? ["PENDING", "IN_PROGRESS", "RETRY_PENDING", "FAILED_PERMANENT"]
    : ["FAILED_PERMANENT"];

  try {
    const refundRows = await db.orderRefund.findMany({
      where: { status: { in: statuses } },
      orderBy: { recordedAt: "asc" },
      take: limit,
    });
    const reversalRows = await db.orderTaxReversal.findMany({
      where: { status: { in: statuses } },
      orderBy: { recordedAt: "asc" },
      take: limit,
    });

    const inspections: RefundInspection[] = [];

    for (const row of refundRows) {
      const failureCode = row.lastFailureCode as RefundFailureCode | null;
      inspections.push(
        RefundInspection.parse({
          kind: "PAYMENT_REFUND" satisfies RefundWorkKind,
          orderId: row.orderId,
          refundId: row.id,
          taxReversalId: null,
          status: row.status,
          attemptCount: row.attemptCount,
          requeueCount: row.requeueCount,
          lastFailureCode: failureCode,
          nextAttemptAt: row.nextAttemptAt === null ? null : row.nextAttemptAt.toISOString(),
          providerTargetRef: row.providerTransactionRef,
          providerResultRef: row.providerRefundRef,
          action: refundOperatorActionFor({
            status: row.status as RefundStatus,
            lastFailureCode: failureCode,
          }),
          /* Only a terminal row is requeueable, and only for a failure whose
             cause is outside the record. */
          requeueable:
            row.status === "FAILED_PERMANENT" && isRequeueableRefundFailure(failureCode),
          ageSeconds: seconds(row.recordedAt, now),
        }),
      );
    }

    for (const row of reversalRows) {
      const failureCode = row.lastFailureCode as TaxReversalFailureCode | null;
      inspections.push(
        RefundInspection.parse({
          kind: "TAX_REVERSAL" satisfies RefundWorkKind,
          orderId: row.orderId,
          refundId: row.refundId,
          taxReversalId: row.id,
          status: row.status,
          attemptCount: row.attemptCount,
          requeueCount: row.requeueCount,
          lastFailureCode: failureCode,
          nextAttemptAt: row.nextAttemptAt === null ? null : row.nextAttemptAt.toISOString(),
          providerTargetRef: row.originalProviderTaxTransactionRef,
          providerResultRef: row.providerReversalRef,
          action: taxReversalOperatorActionFor({
            status: row.status as TaxReversalStatus,
            lastFailureCode: failureCode,
          }),
          requeueable:
            row.status === "FAILED_PERMANENT" && isRequeueableTaxReversalFailure(failureCode),
          ageSeconds: seconds(row.recordedAt, now),
        }),
      );
    }

    return inspections.sort((a, b) => b.ageSeconds - a.ageSeconds).slice(0, limit);
  } catch (error) {
    if (error instanceof RefundError) throw error;
    throw new RefundPersistenceFailureError("inspectStuckRefundWork", error);
  }
}

// — Requeue —

/**
 * Put one terminal row back in the retry pool. **Operator-invoked only.**
 *
 * Refuses unless the row is genuinely terminal *and* its failure has a cause
 * outside the record. `ALREADY_REFUNDED` in particular is refused by name: the
 * provider holds a refund Monacado never observed, and retrying asks it to return
 * money a second time.
 *
 * ## What it changes, and what it does not
 *
 * Changed: `status` → retryable, `nextAttemptAt` → now, `attemptCount` → 0,
 * `finalizedAt` → null, plus the requeue evidence.
 *
 * **Unchanged:** every request-time fact, the original provider reference, and
 * `lastFailureCode` — which is deliberately *kept*. The row should still say what
 * went wrong the last time somebody tried, because a requeue is a decision to try
 * again, not a claim that the failure never happened.
 */
export async function requeueRefundWork(
  args: { kind: RefundWorkKind; id: string; at: string },
  deps: RefundOperationsDeps = {},
): Promise<RefundInspection> {
  const db = deps.db ?? getPrisma();

  if (args.kind === "PAYMENT_REFUND") {
    const existing = await db.orderRefund.findUnique({ where: { id: args.id } });
    if (existing === null) throw new RefundRequeueRefusedError("NOT_FOUND");
    if (existing.status !== "FAILED_PERMANENT") {
      /* A row still retrying does not need help, and a REFUNDED one must never
         be re-sent — that would ask the provider to return the money twice. */
      throw new RefundRequeueRefusedError("NOT_TERMINAL");
    }
    const failureCode = existing.lastFailureCode as RefundFailureCode | null;
    if (!isRequeueableRefundFailure(failureCode)) {
      throw new RefundRequeueRefusedError("FAILURE_NOT_REQUEUEABLE");
    }

    const row = await db.orderRefund.update({
      where: { id: args.id },
      data: {
        status: "RETRY_PENDING",
        nextAttemptAt: new Date(args.at),
        attemptCount: 0,
        finalizedAt: null,
        requeueCount: existing.requeueCount + 1,
        lastRequeuedAt: new Date(args.at),
        /* lastFailureCode / lastFailureClass are deliberately RETAINED. */
      },
    });
    return RefundInspection.parse({
      kind: "PAYMENT_REFUND",
      orderId: row.orderId,
      refundId: row.id,
      taxReversalId: null,
      status: row.status,
      attemptCount: row.attemptCount,
      requeueCount: row.requeueCount,
      lastFailureCode: row.lastFailureCode,
      nextAttemptAt: row.nextAttemptAt === null ? null : row.nextAttemptAt.toISOString(),
      providerTargetRef: row.providerTransactionRef,
      providerResultRef: row.providerRefundRef,
      action: refundOperatorActionFor({
        status: row.status as RefundStatus,
        lastFailureCode: row.lastFailureCode as RefundFailureCode | null,
      }),
      requeueable: false,
      ageSeconds: seconds(row.recordedAt, new Date(args.at)),
    });
  }

  const existing = await db.orderTaxReversal.findUnique({ where: { id: args.id } });
  if (existing === null) throw new RefundRequeueRefusedError("NOT_FOUND");
  if (existing.status !== "FAILED_PERMANENT") {
    throw new RefundRequeueRefusedError("NOT_TERMINAL");
  }
  const failureCode = existing.lastFailureCode as TaxReversalFailureCode | null;
  if (!isRequeueableTaxReversalFailure(failureCode)) {
    throw new RefundRequeueRefusedError("FAILURE_NOT_REQUEUEABLE");
  }

  const row = await db.orderTaxReversal.update({
    where: { id: args.id },
    data: {
      status: "RETRY_PENDING",
      nextAttemptAt: new Date(args.at),
      attemptCount: 0,
      finalizedAt: null,
      requeueCount: existing.requeueCount + 1,
      lastRequeuedAt: new Date(args.at),
    },
  });
  return RefundInspection.parse({
    kind: "TAX_REVERSAL",
    orderId: row.orderId,
    refundId: row.refundId,
    taxReversalId: row.id,
    status: row.status,
    attemptCount: row.attemptCount,
    requeueCount: row.requeueCount,
    lastFailureCode: row.lastFailureCode,
    nextAttemptAt: row.nextAttemptAt === null ? null : row.nextAttemptAt.toISOString(),
    providerTargetRef: row.originalProviderTaxTransactionRef,
    providerResultRef: row.providerReversalRef,
    action: taxReversalOperatorActionFor({
      status: row.status as TaxReversalStatus,
      lastFailureCode: row.lastFailureCode as TaxReversalFailureCode | null,
    }),
    requeueable: false,
    ageSeconds: seconds(row.recordedAt, new Date(args.at)),
  });
}

// — Proceeds recovery exceptions —

function recoveryRowToRecord(row: {
  id: string;
  refundId: string;
  orderId: string;
  snapshotId: string;
  proceedsObligationId: string;
  participantId: string;
  party: string;
  amountMinorUnits: bigint;
  currency: string;
  reasonCode: string;
  obligationStateAtRefund: string;
  status: string;
  resolutionCode: string | null;
  raisedAt: Date;
  acknowledgedAt: Date | null;
  resolvedAt: Date | null;
  updatedAt: Date;
}): ProceedsRecoveryExceptionRecord {
  const parsed = ProceedsRecoveryExceptionRecord.safeParse({
    exceptionId: row.id,
    refundId: row.refundId,
    orderId: row.orderId,
    snapshotId: row.snapshotId,
    proceedsObligationId: row.proceedsObligationId,
    participantId: row.participantId,
    party: row.party,
    amountMinorUnits: Number(row.amountMinorUnits),
    currency: row.currency,
    reasonCode: row.reasonCode,
    obligationStateAtRefund: row.obligationStateAtRefund,
    status: row.status,
    resolutionCode: row.resolutionCode,
    raisedAt: row.raisedAt.toISOString(),
    acknowledgedAt: row.acknowledgedAt === null ? null : row.acknowledgedAt.toISOString(),
    resolvedAt: row.resolvedAt === null ? null : row.resolvedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!parsed.success) {
    throw new RefundError(
      "CORRUPT_PROCEEDS_RECOVERY_RECORD",
      "A persisted proceeds recovery exception is malformed",
    );
  }
  return parsed.data;
}

/** Open recovery exceptions, oldest first. Money Monacado is owed back. */
export async function listOpenProceedsRecoveryExceptions(
  args: { limit?: number } = {},
  deps: RefundOperationsDeps = {},
): Promise<ProceedsRecoveryExceptionRecord[]> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.proceedsRecoveryException.findMany({
      where: { status: { in: ["OPEN", "ACKNOWLEDGED"] } },
      orderBy: { raisedAt: "asc" },
      take: Math.max(1, Math.min(args.limit ?? 100, 500)),
    });
    return rows.map(recoveryRowToRecord);
  } catch (error) {
    if (error instanceof RefundError) throw error;
    throw new RefundPersistenceFailureError("listOpenProceedsRecoveryExceptions", error);
  }
}

export async function listProceedsRecoveryExceptionsForRefund(
  refundId: string,
  deps: RefundOperationsDeps = {},
): Promise<ProceedsRecoveryExceptionRecord[]> {
  const db = deps.db ?? getPrisma();
  const rows = await db.proceedsRecoveryException.findMany({
    where: { refundId },
    orderBy: { party: "asc" },
  });
  return rows.map(recoveryRowToRecord);
}

/**
 * Advance one recovery exception's standing.
 *
 * **Records what a human did; it does not do it.** `RESOLVED` states that the
 * matter was settled somewhere Monacado can see — recovered, offset, written off,
 * or a payout stopped before it ran — on the same terms as
 * `ProceedsObligation.PAID`, which records a payout rather than performing one.
 *
 * Forward-only. Reopening a resolved exception would misrepresent a second event
 * as the first, exactly as `0M.N1` reasoned about notification obligations.
 */
export async function advanceProceedsRecoveryException(
  args: {
    exceptionId: string;
    to: ProceedsRecoveryStatus;
    resolutionCode?: ProceedsRecoveryResolutionCode;
    at: string;
  },
  deps: RefundOperationsDeps = {},
): Promise<ProceedsRecoveryExceptionRecord> {
  const db = deps.db ?? getPrisma();
  try {
    return await db.$transaction(async (tx) => {
      const current = await tx.proceedsRecoveryException.findUnique({
        where: { id: args.exceptionId },
      });
      if (current === null) throw new ProceedsRecoveryNotFoundError();
      const from = current.status as ProceedsRecoveryStatus;
      if (!isValidProceedsRecoveryTransition(from, args.to)) {
        throw new InvalidProceedsRecoveryTransitionError(from, args.to);
      }
      if (args.to === "RESOLVED" && args.resolutionCode === undefined) {
        /* A resolution with no stated outcome is a row nobody can audit. Written
           off and recovered are different facts, and "resolved" alone loses the
           distinction permanently. */
        throw new InvalidProceedsRecoveryTransitionError(from, "RESOLVED");
      }

      const row = await tx.proceedsRecoveryException.update({
        where: { id: args.exceptionId },
        data: {
          status: args.to,
          ...(args.to === "ACKNOWLEDGED"
            ? { acknowledgedAt: new Date(args.at) }
            : {
                resolvedAt: new Date(args.at),
                resolutionCode: args.resolutionCode ?? null,
              }),
        },
      });
      return recoveryRowToRecord(row);
    });
  } catch (error) {
    if (error instanceof RefundError) throw error;
    throw new RefundPersistenceFailureError("advanceProceedsRecoveryException", error);
  }
}

export { REFUND_OPERATIONS_POLICY };

// — Operational readiness —

/**
 * Whether refund execution is not merely implemented but **working**.
 *
 * The database-backed half of refund readiness. `evaluateRefundReadiness` stays
 * pure configuration inspection — no network, no database — and answers *is the
 * deployment set up*. This answers *is it actually keeping up*, which only the
 * rows can say.
 *
 * Four blockers, and every one is about a consequence rather than tidiness:
 *
 *   - **permanently failed refunds** are buyers owed money Monacado cannot return
 *     automatically. Every one is a chargeback waiting to happen.
 *   - **permanently failed tax reversals** are refunded sales whose tax stands
 *     reported. Every one is a return line that will overstate what was collected.
 *   - **manual remediation required** is the resting inconsistency: money back,
 *     tax not reversed, and no timer that will fix it.
 *   - **overdue work** means the processor is not running.
 *
 * Still **no provider call**: every fact is local.
 */
export const REFUND_OPERATIONS_BLOCKER_CODES = [
  "REFUND_PERMANENT_FAILURES",
  "TAX_REVERSAL_PERMANENT_FAILURES",
  "REFUND_MANUAL_REMEDIATION_REQUIRED",
  "REFUND_WORK_OVERDUE",
  "REFUND_TAX_REVERSAL_LAG",
] as const;
export type RefundOperationsBlockerCode = (typeof REFUND_OPERATIONS_BLOCKER_CODES)[number];

export interface RefundOperationsReadiness {
  healthy: boolean;
  blockers: RefundOperationsBlockerCode[];
  backlog: RefundBacklog;
}

export async function evaluateRefundOperationsReadiness(
  at: string,
  deps: RefundOperationsDeps = {},
): Promise<RefundOperationsReadiness> {
  const backlog = await summarizeRefundBacklog(at, deps);
  const blockers: RefundOperationsBlockerCode[] = [];

  if (backlog.refundsPermanentlyFailed > 0) blockers.push("REFUND_PERMANENT_FAILURES");
  if (backlog.taxReversalsPermanentlyFailed > 0) {
    blockers.push("TAX_REVERSAL_PERMANENT_FAILURES");
  }
  if (backlog.manualRemediationRequired > 0) {
    blockers.push("REFUND_MANUAL_REMEDIATION_REQUIRED");
  }
  if (
    backlog.oldestUnresolvedAgeSeconds !== null &&
    backlog.oldestUnresolvedAgeSeconds > REFUND_OPERATIONS_POLICY.maxOverdueSeconds
  ) {
    blockers.push("REFUND_WORK_OVERDUE");
  }

  /* The tighter threshold. The two provider calls are seconds apart on the happy
     path, so a sale sitting refunded-but-not-tax-reversed for hours means the
     second call is failing quietly rather than being slow. */
  if (backlog.paymentRefundedTaxNotReversed > 0) {
    const db = deps.db ?? getPrisma();
    const cutoff = new Date(
      new Date(at).getTime() - REFUND_OPERATIONS_POLICY.maxTaxReversalLagSeconds * 1_000,
    );
    const lagging = await db.orderTaxReversal.count({
      where: {
        status: { in: ["PENDING", "IN_PROGRESS", "RETRY_PENDING"] },
        recordedAt: { lt: cutoff },
        refund: { is: { status: "REFUNDED" } },
      },
    });
    if (lagging > 0) blockers.push("REFUND_TAX_REVERSAL_LAG");
  }

  return { healthy: blockers.length === 0, blockers, backlog };
}

/**
 * The composite lifecycle of every unresolved refund, for a status screen.
 *
 * Derived per row by `refundLifecycleState`, so the command, the reconciler, and
 * the capsule all report the same word.
 */
export async function summarizeRefundLifecycleStates(
  args: { limit?: number } = {},
  deps: RefundOperationsDeps = {},
): Promise<Record<string, number>> {
  const db = deps.db ?? getPrisma();
  const rows = await db.orderRefund.findMany({
    select: { status: true, taxReversal: { select: { status: true } } },
    take: Math.max(1, Math.min(args.limit ?? 500, 2_000)),
  });
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const state = refundLifecycleState({
      refundStatus: row.status as RefundStatus,
      taxReversalStatus: (row.taxReversal?.status ?? null) as TaxReversalStatus | null,
    });
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return counts;
}
