/**
 * Order tax reversal persistence (Phase 1.9) — SERVER ONLY.
 *
 * The second half of one lifecycle, with its own claim, its own attempts, and its
 * own terminal states — because the payment refund and the tax reversal are two
 * provider calls to two systems and either can fail while the other succeeded.
 *
 * ```
 * commitTaxReversalObligationInTx  ← inside the REFUND'S OWN transaction (1.9's
 *                                     order-refund-service owns that write)
 *      … a worker claims it …
 * claimDueTaxReversals
 *      … the provider is called outside any transaction …
 * resolveTaxReversalAttempt        ← REVERSED | RETRY_PENDING | FAILED_PERMANENT
 *   └─ on REVERSED, the SAME transaction moves the original 1.7 report's
 *      lifecycleState to the REVERSED value that phase reserved. Nothing else on
 *      that record is touched.
 * ```
 *
 * ## The obligation commits with the payment refund's success
 *
 * Not before, and not later. Committing it before the money moved would create an
 * obligation to reverse tax on a sale that had not been refunded; committing it
 * afterwards, outside that transaction, would leave a window in which a buyer had
 * their money and Monacado held no record that a return line was owed.
 *
 * ## It never runs before the payment refund succeeded
 *
 * A row exists only because `finalizeRefundInTx` created one inside the refund's
 * own transaction, so the guarantee comes from where the row is written. The
 * refund's status is re-checked anyway in `verifyReversibleTaxReversal`, because a
 * guarantee worth having is worth asserting before Monacado tells a tax provider
 * that a sale came back.
 *
 * ## Immutable facts, mutable lifecycle
 *
 * `IMMUTABLE_TAX_REVERSAL_FIELDS` names what is written once.
 * `resolveTaxReversalAttempt` writes only lifecycle columns and the two provider
 * fields that do not exist until the provider answers.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  OrderTaxReversalRecord,
  TAX_REVERSAL_RETRY_POLICY,
  classifyTaxReversalFailure,
  nextTaxReversalAttemptAt,
  taxReversalIsCoherent,
  type TaxReversalFailureCode,
} from "../../contracts/marketplace/tax-reversal";
import { getPrisma } from "../db/client";
import { markTaxTransactionReversedInTx } from "../marketplace/order-refund-service";
import { cryptoRefundIdProvider, type RefundIdProvider } from "../marketplace/refund-ids";
import { TaxError } from "./tax-errors";

type Db = ReturnType<typeof getPrisma>;

export class TaxReversalPersistenceFailureError extends TaxError {
  readonly operation: string;
  readonly cause?: unknown;
  constructor(operation: string, cause?: unknown) {
    super("TAX_REVERSAL_PERSISTENCE_FAILURE", `Tax reversal persistence failed: ${operation}`);
    this.name = "TaxReversalPersistenceFailureError";
    this.operation = operation;
    this.cause = cause;
  }
}

export interface TaxReversalDeps {
  db?: Db;
  ids?: RefundIdProvider;
}

interface TaxReversalRow {
  id: string;
  orderId: string;
  refundId: string;
  taxTransactionId: string;
  scope: string;
  provider: string;
  providerMode: string;
  originalProviderTaxTransactionRef: string;
  providerReversalRef: string | null;
  providerReversalCreatedAt: Date | null;
  providerReference: string;
  currency: string;
  reversedTaxAmountMinorUnits: bigint;
  reversedTaxableBasisMinorUnits: bigint;
  recordedAt: Date;
  status: string;
  attemptCount: number;
  nextAttemptAt: Date | null;
  lastFailureCode: string | null;
  lastFailureClass: string | null;
  finalizedAt: Date | null;
  requeueCount: number;
  lastRequeuedAt: Date | null;
  updatedAt: Date;
}

export function taxReversalRowToRecord(row: TaxReversalRow): OrderTaxReversalRecord {
  const parsed = OrderTaxReversalRecord.safeParse({
    taxReversalId: row.id,
    orderId: row.orderId,
    refundId: row.refundId,
    taxTransactionId: row.taxTransactionId,
    scope: row.scope,
    provider: row.provider,
    providerMode: row.providerMode,
    originalProviderTaxTransactionRef: row.originalProviderTaxTransactionRef,
    providerReversalRef: row.providerReversalRef,
    providerReversalCreatedAt:
      row.providerReversalCreatedAt === null
        ? null
        : row.providerReversalCreatedAt.toISOString(),
    providerReference: row.providerReference,
    currency: row.currency,
    reversedTaxAmountMinorUnits: Number(row.reversedTaxAmountMinorUnits),
    reversedTaxableBasisMinorUnits: Number(row.reversedTaxableBasisMinorUnits),
    recordedAt: row.recordedAt.toISOString(),
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt === null ? null : row.nextAttemptAt.toISOString(),
    lastFailureCode: row.lastFailureCode,
    lastFailureClass: row.lastFailureClass,
    finalizedAt: row.finalizedAt === null ? null : row.finalizedAt.toISOString(),
    requeueCount: row.requeueCount,
    lastRequeuedAt: row.lastRequeuedAt === null ? null : row.lastRequeuedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!parsed.success) {
    throw new TaxError("CORRUPT_TAX_REVERSAL", "A persisted tax reversal row is malformed");
  }
  return parsed.data;
}

// — Claim —

export interface ClaimedTaxReversal {
  record: OrderTaxReversalRecord;
  lockToken: string;
}

export interface TaxReversalClaim {
  claimed: ClaimedTaxReversal[];
  conflicts: number;
}

/**
 * Claim due tax reversals for one worker.
 *
 * `1.7`'s technique unchanged: one guarded `updateMany` stamps a lock token onto
 * every eligible row, then the rows are read back **by that token**.
 */
export async function claimDueTaxReversals(
  args: { now: string; limit: number },
  deps: TaxReversalDeps = {},
): Promise<TaxReversalClaim> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoRefundIdProvider;
  const lockToken = ids.nextLockToken();
  const now = new Date(args.now);
  const leaseExpiresAt = new Date(
    now.getTime() + TAX_REVERSAL_RETRY_POLICY.claimLeaseSeconds * 1_000,
  );

  try {
    const eligible = await db.orderTaxReversal.findMany({
      where: {
        status: { in: ["PENDING", "RETRY_PENDING"] },
        nextAttemptAt: { lte: now },
        lockToken: null,
      },
      select: { id: true },
      orderBy: { nextAttemptAt: "asc" },
      take: Math.max(1, Math.min(args.limit, 100)),
    });
    if (eligible.length === 0) return { claimed: [], conflicts: 0 };

    await db.orderTaxReversal.updateMany({
      where: {
        id: { in: eligible.map((r) => r.id) },
        status: { in: ["PENDING", "RETRY_PENDING"] },
        nextAttemptAt: { lte: now },
        lockToken: null,
      },
      data: { status: "IN_PROGRESS", lockToken, lockedAt: now, leaseExpiresAt },
    });

    const claimed = await db.orderTaxReversal.findMany({ where: { lockToken } });
    return {
      claimed: claimed.map((row) => ({ record: taxReversalRowToRecord(row), lockToken })),
      conflicts: eligible.length - claimed.length,
    };
  } catch (error) {
    if (error instanceof TaxError) throw error;
    throw new TaxReversalPersistenceFailureError("claimDueTaxReversals", error);
  }
}

/** Return rows whose claim has expired to the pool. A crash costs an attempt. */
export async function recoverStaleTaxReversalClaims(
  args: { now: string },
  deps: TaxReversalDeps = {},
): Promise<number> {
  const db = deps.db ?? getPrisma();
  const now = new Date(args.now);
  try {
    const result = await db.orderTaxReversal.updateMany({
      where: { status: "IN_PROGRESS", leaseExpiresAt: { lt: now } },
      data: {
        status: "RETRY_PENDING",
        lockToken: null,
        lockedAt: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
      },
    });
    return result.count;
  } catch (error) {
    throw new TaxReversalPersistenceFailureError("recoverStaleTaxReversalClaims", error);
  }
}

// — Verify —

/**
 * Verify a claimed row against Monacado's own records before reversing it.
 *
 * Returns a failure code, or `null` when the row may be reversed. **Fails closed
 * on every disagreement**, on `1.7`'s reasoning: telling a tax provider that a
 * sale came back is a statement Monacado has to stand behind.
 *
 * The check that carries the weight is the first: **the payment refund must have
 * succeeded**. §9 is explicit that a failed payment refund must never produce a
 * tax reversal, and this is where that is enforced against the durable record
 * rather than against the order in which a worker happened to run.
 */
export async function verifyReversibleTaxReversal(
  record: OrderTaxReversalRecord,
  deps: TaxReversalDeps = {},
): Promise<TaxReversalFailureCode | null> {
  const db = deps.db ?? getPrisma();

  const refund = await db.orderRefund.findUnique({
    where: { id: record.refundId },
    select: { status: true, orderId: true, currency: true },
  });
  if (refund === null) return "EVIDENCE_INCONSISTENT";
  if (refund.orderId !== record.orderId) return "EVIDENCE_INCONSISTENT";
  /* THE ORDERING GUARANTEE. Transient rather than permanent, because the payment
     refund is itself retrying: this row becomes attemptable the moment it
     succeeds, and abandoning it would give up on a tax reversal for a condition
     actively being fixed. */
  if (refund.status !== "REFUNDED") return "PAYMENT_REFUND_NOT_COMPLETE";

  const original = await db.orderTaxTransaction.findUnique({
    where: { id: record.taxTransactionId },
    select: {
      orderId: true,
      currency: true,
      taxAmountMinorUnits: true,
      taxableBasisMinorUnits: true,
      recordingStatus: true,
      providerTaxTransactionRef: true,
    },
  });
  if (original === null) return "EVIDENCE_INCONSISTENT";
  if (original.orderId !== record.orderId) return "EVIDENCE_INCONSISTENT";

  /* The target must still be the transaction this reversal was committed
     against. A row whose original reference has moved is one nobody can stand
     behind — and reversing whatever the original says NOW would be exactly the
     silent re-targeting the copied reference exists to prevent. */
  if (original.providerTaxTransactionRef !== record.originalProviderTaxTransactionRef) {
    return "EVIDENCE_INCONSISTENT";
  }
  if (original.recordingStatus !== "RECORDED") return "EVIDENCE_INCONSISTENT";
  if (original.currency !== record.currency) return "EVIDENCE_INCONSISTENT";
  if (Number(original.taxAmountMinorUnits) !== record.reversedTaxAmountMinorUnits) {
    return "EVIDENCE_INCONSISTENT";
  }
  if (Number(original.taxableBasisMinorUnits) !== record.reversedTaxableBasisMinorUnits) {
    return "EVIDENCE_INCONSISTENT";
  }
  if (refund.currency !== record.currency) return "EVIDENCE_INCONSISTENT";

  return null;
}

// — Resolve —

export type TaxReversalAttemptOutcome =
  | {
      outcome: "REVERSED";
      providerReversalRef: string;
      providerReversalCreatedAt: string;
    }
  | { outcome: "FAILED"; failureCode: TaxReversalFailureCode };

/**
 * Record what one attempt did, and decide whether another follows.
 *
 * Guarded by the lock token, so a worker whose lease expired mid-call cannot
 * stamp a result over the row another worker has since taken.
 *
 * On success, **one transaction** marks the reversal `REVERSED` and moves the
 * original `1.7` report's `lifecycleState` to the value that phase reserved. The
 * two cannot disagree, which is the whole reason they commit together. Every
 * sale-time fact on the original is untouched, and a test asserts it.
 */
export async function resolveTaxReversalAttempt(
  args: {
    taxReversalId: string;
    lockToken: string;
    result: TaxReversalAttemptOutcome;
    at: string;
  },
  deps: TaxReversalDeps = {},
): Promise<OrderTaxReversalRecord | null> {
  const db = deps.db ?? getPrisma();
  try {
    const existing = await db.orderTaxReversal.findUnique({
      where: { id: args.taxReversalId },
    });
    if (existing === null || existing.lockToken !== args.lockToken) return null;

    const result = args.result;
    if (result.outcome === "FAILED") {
      return await failTaxReversalAttempt(db, existing, result.failureCode, args);
    }

    const candidate = taxReversalRowToRecord({
      ...existing,
      status: "REVERSED",
      providerReversalRef: result.providerReversalRef,
      providerReversalCreatedAt: new Date(result.providerReversalCreatedAt),
    });
    if (!taxReversalIsCoherent(candidate)) {
      /* A provider echoing the original transaction's id, or answering without a
         reference at all, is not a reversal. Marking it `REVERSED` would leave
         the original looking reversed by itself. */
      return await failTaxReversalAttempt(db, existing, "EVIDENCE_INCONSISTENT", args);
    }

    return await db.$transaction(async (tx) => {
      const row = await tx.orderTaxReversal.update({
        where: { id: args.taxReversalId },
        data: {
          /* ONLY lifecycle columns and the two provider fields that did not exist
             until now. No reversal-time fact is touched. */
          status: "REVERSED",
          providerReversalRef: result.providerReversalRef,
          providerReversalCreatedAt: new Date(result.providerReversalCreatedAt),
          attemptCount: existing.attemptCount + 1,
          nextAttemptAt: null,
          lockToken: null,
          lockedAt: null,
          leaseExpiresAt: null,
          finalizedAt: new Date(args.at),
        },
      });

      /* The ONE column a reversal moves on `1.7`'s record, to the ONE value that
         phase reserved for it. */
      await markTaxTransactionReversedInTx(tx, existing.taxTransactionId);

      return taxReversalRowToRecord(row);
    });
  } catch (error) {
    if (error instanceof TaxError) throw error;
    throw new TaxReversalPersistenceFailureError("resolveTaxReversalAttempt", error);
  }
}

async function failTaxReversalAttempt(
  db: Db,
  existing: TaxReversalRow,
  failureCode: TaxReversalFailureCode,
  args: { taxReversalId: string; at: string },
): Promise<OrderTaxReversalRecord> {
  const failureClass = classifyTaxReversalFailure(failureCode);
  const attemptCount = existing.attemptCount + 1;
  const retryAt =
    failureClass === "PERMANENT"
      ? null
      : nextTaxReversalAttemptAt({ attemptCount, failedAt: args.at });
  const terminal = retryAt === null;

  const row = await db.orderTaxReversal.update({
    where: { id: args.taxReversalId },
    data: {
      status: terminal ? "FAILED_PERMANENT" : "RETRY_PENDING",
      attemptCount,
      nextAttemptAt: retryAt === null ? null : new Date(retryAt),
      lastFailureCode: failureCode,
      lastFailureClass: failureClass,
      lockToken: null,
      lockedAt: null,
      leaseExpiresAt: null,
      finalizedAt: terminal ? new Date(args.at) : null,
    },
  });
  return taxReversalRowToRecord(row);
}

// — Reads —

export async function getTaxReversalForOrder(
  orderId: string,
  deps: TaxReversalDeps = {},
): Promise<OrderTaxReversalRecord | null> {
  const db = deps.db ?? getPrisma();
  try {
    const row = await db.orderTaxReversal.findUnique({ where: { orderId } });
    return row === null ? null : taxReversalRowToRecord(row);
  } catch (error) {
    if (error instanceof TaxError) throw error;
    throw new TaxReversalPersistenceFailureError("getTaxReversalForOrder", error);
  }
}

export async function getTaxReversal(
  taxReversalId: string,
  deps: TaxReversalDeps = {},
): Promise<OrderTaxReversalRecord | null> {
  const db = deps.db ?? getPrisma();
  try {
    const row = await db.orderTaxReversal.findUnique({ where: { id: taxReversalId } });
    return row === null ? null : taxReversalRowToRecord(row);
  } catch (error) {
    if (error instanceof TaxError) throw error;
    throw new TaxReversalPersistenceFailureError("getTaxReversal", error);
  }
}

/**
 * The operational question: **which refunded sales are not yet un-reported?**
 *
 * Local rows only — no provider call — carrying the attempt count, the last
 * normalised failure, and when the next attempt is due.
 */
export async function listUnresolvedTaxReversals(
  args: { limit?: number } = {},
  deps: TaxReversalDeps = {},
): Promise<OrderTaxReversalRecord[]> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.orderTaxReversal.findMany({
      where: { status: { in: ["PENDING", "IN_PROGRESS", "RETRY_PENDING", "FAILED_PERMANENT"] } },
      orderBy: { recordedAt: "asc" },
      take: Math.max(1, Math.min(args.limit ?? 100, 500)),
    });
    return rows.map(taxReversalRowToRecord);
  } catch (error) {
    if (error instanceof TaxError) throw error;
    throw new TaxReversalPersistenceFailureError("listUnresolvedTaxReversals", error);
  }
}

/** Shared existence read, usable inside and outside a transaction. */
export async function countDueRefundTaxReversalsIn(
  tx: Db | Prisma.TransactionClient,
  at: string,
): Promise<number> {
  return tx.orderTaxReversal.count({
    where: {
      status: { in: ["PENDING", "RETRY_PENDING"] },
      nextAttemptAt: { lte: new Date(at) },
    },
  });
}
