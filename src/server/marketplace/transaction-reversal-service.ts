/**
 * Transaction reversal accounting (Phase 1.2) — SERVER ONLY.
 *
 * Records that a completed sale was given back, as **new immutable evidence**.
 *
 * ## The snapshot is not touched
 *
 * Not one column, not one update. `0M.T1` built `TransactionEconomicSnapshot`
 * with no update path at all, and this service reads it and writes beside it. A
 * test asserts every snapshot field is byte-identical after a reversal.
 *
 * What *does* move is the **settlement** row — `0M.T1`'s mutable half, whose
 * whole purpose is to carry facts that change — advancing to the `REVERSED` state
 * that phase created in anticipation of exactly this.
 *
 * ## What a reversal does to proceeds obligations
 *
 * **Nothing, directly**, and that is deliberate. `ProceedsObligation` is
 * forward-only through `PENDING → ELIGIBLE → PAID`, with no reversed state; adding
 * one would change a committed enum and a committed transition table for a fact
 * that is already recorded elsewhere.
 *
 * Instead the reversal is what makes the obligation **ineligible for payout** —
 * see `advanceProceedsObligation`, which now refuses `ELIGIBLE` on a reversed
 * sale. The net position is arithmetic anybody can check:
 *
 * ```
 * net owed to a party = obligation.amount − reversal's amount for that party
 * ```
 *
 * which for a full reversal is zero. `reconcileProceedsAfterReversal` computes it
 * and a test asserts it lands on zero.
 *
 * ## One reversal per sale
 *
 * Enforced by a unique index on `snapshotId`. A repeat is **refused**, not
 * treated as idempotent, and that asymmetry with `0M.9`'s payment replay is
 * intentional: a repeated payment confirmation is a provider redelivering one
 * fact, whereas a second reversal of one sale is either a duplicate credit or a
 * partial refund arriving under the wrong name. Both deserve to be surfaced.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  TransactionReversalRecord,
  deriveFullReversalAmounts,
  reconcileFullReversal,
  reversedBuyerTotalMinorUnits,
  TransactionReversalError,
  type ReversalKind,
  type ReversalReasonCode,
  type ReversedAmounts,
} from "../../contracts/marketplace/transaction-reversal";
import {
  isValidTransactionSettlementTransition,
  type TransactionSettlementState,
} from "../../contracts/marketplace/transaction-accounting";
import type { PaymentProvider } from "../../contracts/marketplace/payment-account";
import { getPrisma } from "../db/client";
import { snapshotRowToRecord } from "./transaction-accounting-mapper";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};
const isUniqueViolation = (e: unknown): boolean => prismaCode(e) === "P2002";

export interface ReversalIdProvider {
  nextReversalId(): string;
}

export interface ReversalServiceDeps {
  db?: Db;
  ids?: ReversalIdProvider;
}

function rowToRecord(row: {
  id: string;
  snapshotId: string;
  orderId: string;
  kind: string;
  scope: string;
  reasonCode: string;
  currency: string;
  reversedCommercialRetailAmountMinorUnits: bigint;
  reversedTaxAmountMinorUnits: bigint;
  reversedShippingAmountMinorUnits: bigint;
  reversedOtherPassThroughAmountMinorUnits: bigint;
  reversedMonacadoRetainedAmountMinorUnits: bigint;
  reversedSellerProceedsMinorUnits: bigint;
  reversedPromoterNetProceedsMinorUnits: bigint | null;
  provider: string | null;
  providerReversalRef: string | null;
  occurredAt: Date;
  recordedAt: Date;
}): TransactionReversalRecord {
  const parsed = TransactionReversalRecord.safeParse({
    reversalId: row.id,
    snapshotId: row.snapshotId,
    orderId: row.orderId,
    kind: row.kind,
    scope: row.scope,
    reasonCode: row.reasonCode,
    currency: row.currency,
    amounts: {
      commercialRetailAmountMinorUnits: Number(row.reversedCommercialRetailAmountMinorUnits),
      taxAmountMinorUnits: Number(row.reversedTaxAmountMinorUnits),
      shippingAmountMinorUnits: Number(row.reversedShippingAmountMinorUnits),
      otherPassThroughAmountMinorUnits: Number(row.reversedOtherPassThroughAmountMinorUnits),
      monacadoRetainedAmountMinorUnits: Number(row.reversedMonacadoRetainedAmountMinorUnits),
      sellerProceedsMinorUnits: Number(row.reversedSellerProceedsMinorUnits),
      promoterNetProceedsMinorUnits:
        row.reversedPromoterNetProceedsMinorUnits === null
          ? null
          : Number(row.reversedPromoterNetProceedsMinorUnits),
    },
    provider: row.provider,
    providerReversalRef: row.providerReversalRef,
    occurredAt: row.occurredAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
  });
  if (!parsed.success) {
    throw new TransactionReversalError(
      "CORRUPT_REVERSAL_RECORD",
      "A persisted transaction reversal is malformed",
    );
  }
  return parsed.data;
}

export interface RecordedReversal {
  reversal: TransactionReversalRecord;
  /** What the buyer gets back in total. Derived, stored nowhere. */
  reversedBuyerTotalMinorUnits: number;
  settlementState: TransactionSettlementState;
}

/**
 * Reverse one completed sale, in full.
 *
 * **No amount is a parameter.** The reversed figures are derived from the
 * snapshot, which is the whole safety property: a caller cannot return more than
 * the sale earned, cannot return less and call it full, and cannot invent a
 * promoter share on a seller-direct sale.
 *
 * One transaction containing the reversal row and the settlement advance, so a
 * reversal without its settlement state — or the reverse — is impossible rather
 * than merely unlikely.
 */
export async function recordFullReversal(
  input: {
    snapshotId: string;
    kind: ReversalKind;
    reasonCode: ReversalReasonCode;
    provider: PaymentProvider | null;
    providerReversalRef: string | null;
    occurredAt: string;
    recordedAt: string;
  },
  deps: ReversalServiceDeps = {},
): Promise<RecordedReversal> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids;
  if (ids === undefined) {
    throw new TransactionReversalError(
      "REVERSAL_ID_PROVIDER_REQUIRED",
      "an id provider is required",
    );
  }

  try {
    /* One transaction containing the reversal row and the settlement advance, so
       a reversal without its settlement state — or the reverse — is impossible
       rather than merely unlikely. The work itself is `recordFullReversalInTx`,
       which is the ONE place that decides what reversing a sale means. */
    return await db.$transaction((tx) => recordFullReversalInTx(tx, input, ids));
  } catch (error) {
    if (error instanceof TransactionReversalError) throw error;
    if (isUniqueViolation(error)) {
      throw new TransactionReversalError(
        "REVERSAL_ALREADY_RECORDED",
        "This sale has already been reversed",
      );
    }
    throw error;
  }
}

/**
 * Record a full reversal **inside a caller's transaction** (Phase 1.9).
 *
 * Extracted so that `1.9` can write the accounting entry, advance the settlement
 * row, mark the refund `REFUNDED`, commit the tax-reversal obligation, and raise
 * any proceeds recovery exceptions **atomically**. Before this existed, the only
 * way to do it was two transactions with a window between them in which a buyer
 * had their money and Monacado's books said the sale still stood.
 *
 * It is a genuine extraction, not a second implementation: `recordFullReversal`
 * now delegates to it, so there is exactly one place that derives the amounts,
 * checks that they balance, writes the entry, and moves the settlement state.
 * Two implementations of "what does reversing a sale mean" would eventually be
 * two answers.
 *
 * Everything the outer function guaranteed still holds. **The snapshot is not
 * touched**; the amounts are derived from it rather than supplied, so a caller
 * still cannot return more than the sale earned, cannot return less and call it
 * full, and cannot invent a promoter share on a seller-direct sale.
 */
export async function recordFullReversalInTx(
  tx: Prisma.TransactionClient,
  input: {
    snapshotId: string;
    kind: ReversalKind;
    reasonCode: ReversalReasonCode;
    provider: PaymentProvider | null;
    providerReversalRef: string | null;
    occurredAt: string;
    recordedAt: string;
  },
  ids: ReversalIdProvider,
): Promise<RecordedReversal> {
  const snapshotRow = await tx.transactionEconomicSnapshot.findUnique({
    where: { id: input.snapshotId },
  });
  if (snapshotRow === null) {
    throw new TransactionReversalError(
      "REVERSAL_SNAPSHOT_NOT_FOUND",
      "This sale has no economic snapshot",
    );
  }
  if (snapshotRow.orderId === null) {
    /* A snapshot with no Order is pre-`0M.9` data or a corrupt row. Reversing
       one would produce evidence pointing at nothing. */
    throw new TransactionReversalError(
      "REVERSAL_ORDER_NOT_BOUND",
      "This sale has no bound Order and cannot be reversed",
    );
  }
  const snapshot = snapshotRowToRecord(snapshotRow);

  const amounts: ReversedAmounts = deriveFullReversalAmounts({
    commercialRetailAmountMinorUnits: snapshot.commercialRetailAmountMinorUnits,
    passThrough: snapshot.passThrough,
    economics: snapshot.economics,
  });

  /* Balanced before anything is written. An unbalanced reversal is a
     misstatement of what three parties owe each other. */
  reconcileFullReversal({ amounts, transactionType: snapshot.economics.transactionType });

  const settlement = await tx.transactionSettlement.findUnique({
    where: { snapshotId: input.snapshotId },
  });
  if (settlement === null) {
    throw new TransactionReversalError(
      "REVERSAL_SETTLEMENT_MISSING",
      "This sale has no settlement record",
    );
  }
  const from = settlement.state as TransactionSettlementState;
  if (!isValidTransactionSettlementTransition(from, "REVERSED")) {
    /* REVERSED is terminal, so this is reached exactly when the sale is already
       reversed — which the unique index on `snapshotId` also refuses. */
    throw new TransactionReversalError(
      "REVERSAL_ALREADY_RECORDED",
      "This sale has already been reversed",
    );
  }

  const created = await tx.transactionReversal.create({
    data: {
      id: ids.nextReversalId(),
      snapshotId: input.snapshotId,
      orderId: snapshotRow.orderId,
      kind: input.kind,
      scope: "FULL",
      reasonCode: input.reasonCode,
      currency: snapshot.currency,
      reversedCommercialRetailAmountMinorUnits: BigInt(
        amounts.commercialRetailAmountMinorUnits,
      ),
      reversedTaxAmountMinorUnits: BigInt(amounts.taxAmountMinorUnits),
      reversedShippingAmountMinorUnits: BigInt(amounts.shippingAmountMinorUnits),
      reversedOtherPassThroughAmountMinorUnits: BigInt(
        amounts.otherPassThroughAmountMinorUnits,
      ),
      reversedMonacadoRetainedAmountMinorUnits: BigInt(
        amounts.monacadoRetainedAmountMinorUnits,
      ),
      reversedSellerProceedsMinorUnits: BigInt(amounts.sellerProceedsMinorUnits),
      reversedPromoterNetProceedsMinorUnits:
        amounts.promoterNetProceedsMinorUnits === null
          ? null
          : BigInt(amounts.promoterNetProceedsMinorUnits),
      provider: input.provider,
      providerReversalRef: input.providerReversalRef,
      occurredAt: new Date(input.occurredAt),
      recordedAt: new Date(input.recordedAt),
    },
  });

  /* 0M.T1's mutable half, moving to the state that phase created for exactly
     this. The snapshot itself is untouched. */
  await tx.transactionSettlement.update({
    where: { snapshotId: input.snapshotId },
    data: { state: "REVERSED", reversedAt: new Date(input.occurredAt) },
  });

  return {
    reversal: rowToRecord(created),
    reversedBuyerTotalMinorUnits: reversedBuyerTotalMinorUnits(amounts),
    settlementState: "REVERSED" as const,
  };
}

// — Reads —

export async function getReversalForSnapshot(
  snapshotId: string,
  deps: ReversalServiceDeps = {},
): Promise<TransactionReversalRecord | null> {
  const db = deps.db ?? getPrisma();
  const row = await db.transactionReversal.findUnique({ where: { snapshotId } });
  return row === null ? null : rowToRecord(row);
}

/** Shared existence read, usable inside and outside a transaction. */
export async function isSnapshotReversedIn(tx: Tx, snapshotId: string): Promise<boolean> {
  return (await tx.transactionReversal.count({ where: { snapshotId } })) > 0;
}

/**
 * What each party is **net** owed after any reversal.
 *
 * Derived, never stored — the obligation says what the sale created and the
 * reversal says what came back, and a stored net is a third answer that can
 * disagree with both. For a full reversal every net lands on zero, which is what
 * makes "the accounting reconciles" a checkable claim rather than a described one.
 */
export interface NetProceedsPosition {
  party: "SELLER" | "PROMOTER";
  participantId: string;
  obligationAmountMinorUnits: number;
  reversedAmountMinorUnits: number;
  netAmountMinorUnits: number;
}

export async function reconcileProceedsAfterReversal(
  snapshotId: string,
  deps: ReversalServiceDeps = {},
): Promise<NetProceedsPosition[]> {
  const db = deps.db ?? getPrisma();
  const obligations = await db.proceedsObligation.findMany({
    where: { snapshotId },
    orderBy: { party: "asc" },
  });
  const reversal = await getReversalForSnapshot(snapshotId, { db });

  return obligations.map((o) => {
    const obligationAmount = Number(o.amountMinorUnits);
    const reversed =
      reversal === null
        ? 0
        : o.party === "SELLER"
          ? reversal.amounts.sellerProceedsMinorUnits
          : (reversal.amounts.promoterNetProceedsMinorUnits ?? 0);
    return {
      party: o.party as "SELLER" | "PROMOTER",
      participantId: o.participantId,
      obligationAmountMinorUnits: obligationAmount,
      reversedAmountMinorUnits: reversed,
      netAmountMinorUnits: obligationAmount - reversed,
    };
  });
}
