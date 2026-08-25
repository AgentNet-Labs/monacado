/**
 * Order tax transaction persistence (Phase 1.7) — SERVER ONLY.
 *
 * Four operations, and the ordering between them is the whole guarantee:
 *
 * ```
 * commitTaxTransactionObligationInTx   ← inside the SALE's own transaction
 *      … a worker claims it …
 * claimDueTaxTransactions
 *      … the provider is called outside any transaction …
 * resolveTaxTransactionAttempt         ← RECORDED | RETRY_PENDING | FAILED_PERMANENT
 * ```
 *
 * ## Why the obligation commits with the sale
 *
 * `commitTaxTransactionObligationInTx` takes a transaction client and is called
 * from inside `recordCompletedSale`. Either the sale and its tax-recording
 * obligation both exist, or neither does. **There is no window** in which
 * Monacado has taken money and holds no record that it owes a tax report — which
 * is the failure this phase exists to make impossible.
 *
 * It is deliberately *not* the provider call. Calling Stripe inside a database
 * transaction would hold a lock across a network round trip and, worse, would
 * mean a provider timeout rolled back a **completed payment**. `1.7`'s rule is
 * the opposite: the payment stands, and the unreported tax becomes durable work.
 *
 * ## Immutable facts, mutable lifecycle
 *
 * The sale-time facts are written once by `commitTaxTransactionObligationInTx`
 * and touched by nothing afterwards. `resolveTaxTransactionAttempt` writes only
 * recording-lifecycle columns and the two provider-transaction fields that do not
 * exist until the provider answers. `IMMUTABLE_TAX_TRANSACTION_FIELDS` names the
 * boundary and a test asserts it holds across a retry.
 *
 * ## The claim
 *
 * Exactly `1.5`'s technique, reused rather than reinvented: one guarded
 * `updateMany` re-asserts eligibility and stamps a lock token, then the rows are
 * read back **by that token**. Two workers cannot claim one row, and the read-back
 * cannot see somebody else's work. A live claim is never stolen — this is lease
 * *expiry*, not lock stealing.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  INITIAL_TAX_TRANSACTION_LIFECYCLE_STATE,
  INITIAL_TAX_TRANSACTION_RECORDING_STATUS,
  OrderTaxTransactionRecord,
  TAX_TRANSACTION_RETRY_POLICY,
  classifyTaxRecordingFailure,
  nextTaxRecordingAttemptAt,
  taxTransactionIsCoherent,
  type TaxRecordingFailureCode,
} from "../../contracts/marketplace/tax-transaction";
import type { OrderTaxEvidenceRecord } from "../../contracts/marketplace/tax-calculation";
import { getPrisma } from "../db/client";
import {
  cryptoTaxTransactionIdProvider,
  type TaxTransactionIdProvider,
} from "./tax-transaction-ids";
import { TaxError } from "./tax-errors";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export class TaxTransactionPersistenceFailureError extends TaxError {
  readonly operation: string;
  readonly cause?: unknown;
  constructor(operation: string, cause?: unknown) {
    super(
      "TAX_TRANSACTION_PERSISTENCE_FAILURE",
      `Tax transaction persistence failed: ${operation}`,
    );
    this.name = "TaxTransactionPersistenceFailureError";
    this.operation = operation;
    this.cause = cause;
  }
}

export interface TaxTransactionDeps {
  db?: Db;
  ids?: TaxTransactionIdProvider;
}

interface TaxTransactionRow {
  id: string;
  orderId: string;
  taxEvidenceId: string;
  provider: string;
  providerMode: string;
  providerCalculationRef: string;
  providerTaxTransactionRef: string | null;
  providerReference: string;
  currency: string;
  taxableBasisMinorUnits: bigint;
  taxAmountMinorUnits: bigint;
  providerTotalAmountMinorUnits: bigint | null;
  jurisdictionCode: string | null;
  treatment: string;
  internalProductId: string;
  productSourceRecordId: string;
  productSourceRecordVersion: string;
  productTaxClassification: string;
  providerTaxCode: string | null;
  providerConfigVersion: string | null;
  calculatedAt: Date;
  providerTaxTransactionCreatedAt: Date | null;
  recordedAt: Date;
  lifecycleState: string;
  recordingStatus: string;
  attemptCount: number;
  nextAttemptAt: Date | null;
  lastFailureCode: string | null;
  lastFailureClass: string | null;
  finalizedAt: Date | null;
  updatedAt: Date;
}

export function taxTransactionRowToRecord(row: TaxTransactionRow): OrderTaxTransactionRecord {
  const parsed = OrderTaxTransactionRecord.safeParse({
    taxTransactionId: row.id,
    orderId: row.orderId,
    taxEvidenceId: row.taxEvidenceId,
    provider: row.provider,
    providerMode: row.providerMode,
    providerCalculationRef: row.providerCalculationRef,
    providerTaxTransactionRef: row.providerTaxTransactionRef,
    providerReference: row.providerReference,
    currency: row.currency,
    taxableBasisMinorUnits: Number(row.taxableBasisMinorUnits),
    taxAmountMinorUnits: Number(row.taxAmountMinorUnits),
    providerTotalAmountMinorUnits:
      row.providerTotalAmountMinorUnits === null
        ? null
        : Number(row.providerTotalAmountMinorUnits),
    jurisdictionCode: row.jurisdictionCode,
    treatment: row.treatment,
    internalProductId: row.internalProductId,
    productSourceRecordId: row.productSourceRecordId,
    productSourceRecordVersion: row.productSourceRecordVersion,
    productTaxClassification: row.productTaxClassification,
    providerTaxCode: row.providerTaxCode,
    providerConfigVersion: row.providerConfigVersion,
    calculatedAt: row.calculatedAt.toISOString(),
    providerTaxTransactionCreatedAt:
      row.providerTaxTransactionCreatedAt === null
        ? null
        : row.providerTaxTransactionCreatedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
    lifecycleState: row.lifecycleState,
    recordingStatus: row.recordingStatus,
    attemptCount: row.attemptCount,
    nextAttemptAt: row.nextAttemptAt === null ? null : row.nextAttemptAt.toISOString(),
    lastFailureCode: row.lastFailureCode,
    lastFailureClass: row.lastFailureClass,
    finalizedAt: row.finalizedAt === null ? null : row.finalizedAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
  if (!parsed.success) {
    throw new TaxError(
      "CORRUPT_TAX_TRANSACTION",
      "A persisted tax transaction row is malformed",
    );
  }
  return parsed.data;
}

// — Commit —

/**
 * Commit the obligation to report this sale's tax, inside the sale's transaction.
 *
 * Returns `null` when the Order has no `1.6` calculation evidence — which is a
 * pre-`1.6` Order, and the only honest answer for one. **Nothing is fabricated**:
 * a transaction cannot be created from a calculation that never happened, and
 * reconciliation reports the gap as `PAID_ORDER_MISSING_TAX_EVIDENCE` rather than
 * this function inventing a reference.
 *
 * Every field is copied from the evidence rather than joined to it, so the record
 * a filing rests on stays complete on its own.
 */
export async function commitTaxTransactionObligationInTx(
  tx: Tx,
  args: {
    orderId: string;
    /** The commercial basis the Order actually booked. Checked, not trusted. */
    taxableBasisMinorUnits: number;
    recordedAt: string;
  },
  ids: TaxTransactionIdProvider = cryptoTaxTransactionIdProvider,
): Promise<OrderTaxTransactionRecord | null> {
  const evidence = await tx.orderTaxEvidence.findUnique({ where: { orderId: args.orderId } });
  if (evidence === null) return null;

  /* A pre-1.6 evidence row carries no Product basis, mode, or classification, and
     none can be invented after the fact. Reporting a transaction whose
     classification nobody recorded would be asserting a treatment that was never
     chosen — so it is left for reconciliation to surface. */
  if (
    evidence.providerMode === null ||
    evidence.productSourceRecordId === null ||
    evidence.productSourceRecordVersion === null ||
    evidence.productTaxClassification === null
  ) {
    return null;
  }

  const order = await tx.order.findUnique({
    where: { id: args.orderId },
    select: { internalProductId: true },
  });
  if (order === null) return null;

  const row = await tx.orderTaxTransaction.create({
    data: {
      id: ids.nextTaxTransactionId(),
      orderId: args.orderId,
      taxEvidenceId: evidence.id,
      provider: evidence.provider,
      providerMode: evidence.providerMode,
      providerCalculationRef: evidence.providerCalculationRef,
      providerTaxTransactionRef: null,
      /* The Order id, which Stripe enforces as unique across its transactions —
         the second idempotency guard, independent of any Monacado-side key. */
      providerReference: args.orderId,
      currency: evidence.currency,
      taxableBasisMinorUnits: BigInt(args.taxableBasisMinorUnits),
      taxAmountMinorUnits: evidence.taxAmountMinorUnits,
      providerTotalAmountMinorUnits: null,
      jurisdictionCode: evidence.jurisdictionCode,
      treatment: evidence.treatment,
      internalProductId: order.internalProductId,
      productSourceRecordId: evidence.productSourceRecordId,
      productSourceRecordVersion: evidence.productSourceRecordVersion,
      productTaxClassification: evidence.productTaxClassification,
      providerTaxCode: evidence.providerTaxCode,
      providerConfigVersion: evidence.providerConfigVersion,
      calculatedAt: evidence.calculatedAt,
      providerTaxTransactionCreatedAt: null,
      recordedAt: new Date(args.recordedAt),
      lifecycleState: INITIAL_TAX_TRANSACTION_LIFECYCLE_STATE,
      recordingStatus: INITIAL_TAX_TRANSACTION_RECORDING_STATUS,
      attemptCount: 0,
      /* Due immediately: a sale's tax should be reported as soon as a worker
         runs, not after a backoff nothing has earned yet. */
      nextAttemptAt: new Date(args.recordedAt),
    },
  });
  return taxTransactionRowToRecord(row);
}

// — Claim —

export interface ClaimedTaxTransaction {
  record: OrderTaxTransactionRecord;
  lockToken: string;
}

/** What one claim attempt got, and what it lost to another worker. */
export interface TaxTransactionClaim {
  claimed: ClaimedTaxTransaction[];
  /**
   * Rows that looked eligible and were taken first.
   *
   * Not an error — it is what concurrency looks like — but a **persistently**
   * non-zero count means more workers are running than the work needs, which is
   * worth an operator seeing.
   */
  conflicts: number;
}

/**
 * Claim due tax transactions for one worker.
 *
 * One guarded `updateMany` stamps a lock token onto every eligible row, then the
 * rows are read back **by that token**. Prisma has no `updateMany … LIMIT`, so
 * eligibility is narrowed by an id list gathered first — a row that stops being
 * eligible between the two statements simply is not claimed, because the `where`
 * re-asserts every condition. The select is a hint, never the guard.
 */
export async function claimDueTaxTransactions(
  args: { now: string; limit: number },
  deps: TaxTransactionDeps = {},
): Promise<TaxTransactionClaim> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoTaxTransactionIdProvider;
  const lockToken = ids.nextLockToken();
  const now = new Date(args.now);
  const leaseExpiresAt = new Date(
    now.getTime() + TAX_TRANSACTION_RETRY_POLICY.claimLeaseSeconds * 1_000,
  );

  try {
    const eligible = await db.orderTaxTransaction.findMany({
      where: {
        recordingStatus: { in: ["PENDING", "RETRY_PENDING"] },
        nextAttemptAt: { lte: now },
        lockToken: null,
      },
      select: { id: true },
      orderBy: { nextAttemptAt: "asc" },
      take: Math.max(1, Math.min(args.limit, 100)),
    });
    if (eligible.length === 0) return { claimed: [], conflicts: 0 };

    await db.orderTaxTransaction.updateMany({
      where: {
        id: { in: eligible.map((r) => r.id) },
        recordingStatus: { in: ["PENDING", "RETRY_PENDING"] },
        nextAttemptAt: { lte: now },
        lockToken: null,
      },
      data: { recordingStatus: "IN_PROGRESS", lockToken, lockedAt: now, leaseExpiresAt },
    });

    const claimed = await db.orderTaxTransaction.findMany({ where: { lockToken } });
    return {
      claimed: claimed.map((row) => ({ record: taxTransactionRowToRecord(row), lockToken })),
      /* Eligible when selected, gone by the time the guarded update ran: another
         worker took them. The `where` re-asserts every condition, so a live claim
         is never stolen — the loser simply gets fewer rows. */
      conflicts: eligible.length - claimed.length,
    };
  } catch (error) {
    if (error instanceof TaxError) throw error;
    throw new TaxTransactionPersistenceFailureError("claimDueTaxTransactions", error);
  }
}

/**
 * Return rows whose claim has expired to the pool.
 *
 * A worker that died mid-call leaves an `IN_PROGRESS` row; the lease expires and
 * the row becomes eligible again, so a crash costs an **attempt** rather than the
 * obligation. A live claim is never touched.
 */
export async function recoverStaleTaxTransactionClaims(
  args: { now: string },
  deps: TaxTransactionDeps = {},
): Promise<number> {
  const db = deps.db ?? getPrisma();
  const now = new Date(args.now);
  try {
    const result = await db.orderTaxTransaction.updateMany({
      where: { recordingStatus: "IN_PROGRESS", leaseExpiresAt: { lt: now } },
      data: {
        recordingStatus: "RETRY_PENDING",
        lockToken: null,
        lockedAt: null,
        leaseExpiresAt: null,
        nextAttemptAt: now,
      },
    });
    return result.count;
  } catch (error) {
    throw new TaxTransactionPersistenceFailureError("recoverStaleTaxTransactionClaims", error);
  }
}

// — Resolve —

/** What one provider attempt produced. */
export type TaxRecordingAttemptOutcome =
  | {
      outcome: "RECORDED";
      providerTaxTransactionRef: string;
      providerTaxTransactionCreatedAt: string;
      providerTotalAmountMinorUnits: number;
    }
  | { outcome: "FAILED"; failureCode: TaxRecordingFailureCode };

/**
 * Record what one attempt did, and decide whether another follows.
 *
 * Guarded by the lock token, so a worker whose lease expired mid-call cannot
 * stamp a result over the row another worker has since taken.
 *
 * A success is refused if it does not reconcile — `taxTransactionIsCoherent`
 * requires the provider's represented total to equal basis plus tax — because a
 * provider total that disagrees means the two systems describe different sales,
 * and marking that `RECORDED` would bury the one fact worth surfacing. It is
 * treated as a permanent failure rather than silently accepted.
 */
export async function resolveTaxTransactionAttempt(
  args: {
    taxTransactionId: string;
    lockToken: string;
    result: TaxRecordingAttemptOutcome;
    at: string;
  },
  deps: TaxTransactionDeps = {},
): Promise<OrderTaxTransactionRecord | null> {
  const db = deps.db ?? getPrisma();
  try {
    const existing = await db.orderTaxTransaction.findUnique({
      where: { id: args.taxTransactionId },
    });
    if (existing === null || existing.lockToken !== args.lockToken) return null;

    if (args.result.outcome === "RECORDED") {
      const candidate = taxTransactionRowToRecord({
        ...existing,
        recordingStatus: "RECORDED",
        providerTaxTransactionRef: args.result.providerTaxTransactionRef,
        providerTotalAmountMinorUnits: BigInt(args.result.providerTotalAmountMinorUnits),
      });
      if (!taxTransactionIsCoherent(candidate)) {
        return await failAttempt(db, existing, "EVIDENCE_INCONSISTENT", args);
      }

      const row = await db.orderTaxTransaction.update({
        where: { id: args.taxTransactionId },
        data: {
          /* ONLY recording-lifecycle columns and the two provider-transaction
             fields that did not exist until now. No sale-time fact is touched. */
          recordingStatus: "RECORDED",
          providerTaxTransactionRef: args.result.providerTaxTransactionRef,
          providerTaxTransactionCreatedAt: new Date(
            args.result.providerTaxTransactionCreatedAt,
          ),
          providerTotalAmountMinorUnits: BigInt(args.result.providerTotalAmountMinorUnits),
          attemptCount: existing.attemptCount + 1,
          nextAttemptAt: null,
          lockToken: null,
          lockedAt: null,
          leaseExpiresAt: null,
          finalizedAt: new Date(args.at),
        },
      });
      return taxTransactionRowToRecord(row);
    }

    return await failAttempt(db, existing, args.result.failureCode, args);
  } catch (error) {
    if (error instanceof TaxError) throw error;
    throw new TaxTransactionPersistenceFailureError("resolveTaxTransactionAttempt", error);
  }
}

async function failAttempt(
  db: Db,
  existing: TaxTransactionRow,
  failureCode: TaxRecordingFailureCode,
  args: { taxTransactionId: string; at: string },
): Promise<OrderTaxTransactionRecord> {
  const failureClass = classifyTaxRecordingFailure(failureCode);
  const attemptCount = existing.attemptCount + 1;
  const retryAt =
    failureClass === "PERMANENT"
      ? null
      : nextTaxRecordingAttemptAt({ attemptCount, failedAt: args.at });
  const terminal = retryAt === null;

  const row = await db.orderTaxTransaction.update({
    where: { id: args.taxTransactionId },
    data: {
      recordingStatus: terminal ? "FAILED_PERMANENT" : "RETRY_PENDING",
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
  return taxTransactionRowToRecord(row);
}

// — Reads —

export async function getTaxTransactionForOrder(
  orderId: string,
  deps: TaxTransactionDeps = {},
): Promise<OrderTaxTransactionRecord | null> {
  const db = deps.db ?? getPrisma();
  try {
    const row = await db.orderTaxTransaction.findUnique({ where: { orderId } });
    return row === null ? null : taxTransactionRowToRecord(row);
  } catch (error) {
    if (error instanceof TaxError) throw error;
    throw new TaxTransactionPersistenceFailureError("getTaxTransactionForOrder", error);
  }
}

/**
 * The operational question: **which paid sales are not yet reported, and why?**
 *
 * Answers it from Monacado's own rows — no provider call — carrying the attempt
 * count, the last normalised failure, and when the next attempt is due. That is
 * the whole of what an operator needs to decide whether to wait or intervene.
 */
export async function listUnreportedTaxTransactions(
  args: { limit?: number } = {},
  deps: TaxTransactionDeps = {},
): Promise<OrderTaxTransactionRecord[]> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.orderTaxTransaction.findMany({
      where: { recordingStatus: { in: ["PENDING", "IN_PROGRESS", "RETRY_PENDING", "FAILED_PERMANENT"] } },
      orderBy: { recordedAt: "asc" },
      take: Math.max(1, Math.min(args.limit ?? 100, 500)),
    });
    return rows.map(taxTransactionRowToRecord);
  } catch (error) {
    if (error instanceof TaxError) throw error;
    throw new TaxTransactionPersistenceFailureError("listUnreportedTaxTransactions", error);
  }
}

/** The `1.6` evidence a tax transaction reports, for consistency checks. */
export async function getEvidenceForTaxTransaction(
  record: OrderTaxTransactionRecord,
  deps: TaxTransactionDeps = {},
): Promise<OrderTaxEvidenceRecord | null> {
  const { getOrderTaxEvidence } = await import("./tax-evidence-service");
  return getOrderTaxEvidence(record.orderId, deps.db === undefined ? {} : { db: deps.db });
}
