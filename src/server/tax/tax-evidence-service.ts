/**
 * Tax evidence persistence (Phase 1.2) — SERVER ONLY.
 *
 * Records **why** an Order was charged the tax it was charged, and checks that
 * the two agree before writing.
 *
 * The Order already holds the *amount* (`quotedTaxAmountMinorUnits`), which is
 * what a buyer was actually charged and is durable from the moment the Order is
 * placed. This adds the audit trail: which engine, which calculation reference,
 * on what basis, under what treatment, at what instant.
 *
 * ## The amount is checked, not copied
 *
 * `recordOrderTaxEvidence` refuses when the quote's tax differs from the Order's,
 * or when the currency differs. That is deliberately the same shape of check as
 * `0M.9`'s `requireQuoteMatchesSnapshot`: two records that overlap must have that
 * overlap **verified**, or the first divergence is unresolvable and Monacado is
 * explaining a charge it did not make.
 *
 * ## One evidence row per Order
 *
 * Enforced by a unique index. A second explanation of one charged amount is a
 * second answer, and no reader could tell which was authoritative. A repeat is
 * therefore reported as already-recorded rather than written again.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  OrderTaxEvidenceRecord,
  type TaxQuote,
} from "../../contracts/marketplace/tax-calculation";
import type { OrderRecord } from "../../contracts/marketplace/order";
import { getPrisma } from "../db/client";
import {
  cryptoTaxEvidenceIdProvider,
  type TaxEvidenceIdProvider,
} from "./tax-calculation-ids";
import {
  TaxBasisMismatchError,
  TaxEvidencePersistenceFailureError,
  TaxError,
} from "./tax-errors";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};
const isUniqueViolation = (e: unknown): boolean => prismaCode(e) === "P2002";

export interface TaxEvidenceDeps {
  db?: Db;
  ids?: TaxEvidenceIdProvider;
}

function rowToRecord(row: {
  id: string;
  orderId: string;
  provider: string;
  providerCalculationRef: string;
  currency: string;
  taxAmountMinorUnits: bigint;
  basisAmountMinorUnits: bigint;
  treatment: string;
  jurisdictionCode: string | null;
  calculatedAt: Date;
  recordedAt: Date;
  buyerSnapshotId: string | null;
}): OrderTaxEvidenceRecord {
  const parsed = OrderTaxEvidenceRecord.safeParse({
    taxEvidenceId: row.id,
    orderId: row.orderId,
    provider: row.provider,
    providerCalculationRef: row.providerCalculationRef,
    currency: row.currency,
    taxAmountMinorUnits: Number(row.taxAmountMinorUnits),
    basisAmountMinorUnits: Number(row.basisAmountMinorUnits),
    treatment: row.treatment,
    jurisdictionCode: row.jurisdictionCode,
    buyerSnapshotId: row.buyerSnapshotId,
    calculatedAt: row.calculatedAt.toISOString(),
    recordedAt: row.recordedAt.toISOString(),
  });
  if (!parsed.success) {
    throw new TaxError("CORRUPT_TAX_EVIDENCE", "A persisted tax evidence row is malformed");
  }
  return parsed.data;
}

/**
 * Assert the quote and the Order describe one sale.
 *
 * Checks the tax amount, the currency, and the basis. The basis check is the one
 * that catches a repriced Listing: if the Order's retail moved between pricing
 * and placement, the tax was assessed on a sale that is not the sale being
 * booked.
 */
export function requireTaxQuoteMatchesOrder(order: OrderRecord, quote: TaxQuote): void {
  const mismatched: string[] = [];
  if (quote.currency !== order.quote.currency) mismatched.push("currency");
  if (quote.taxAmountMinorUnits !== order.quote.quotedTaxAmountMinorUnits) {
    mismatched.push("taxAmountMinorUnits");
  }
  const orderBasis =
    order.quote.quotedCommercialRetailAmountMinorUnits +
    order.quote.quotedShippingAmountMinorUnits;
  if (quote.basisAmountMinorUnits !== orderBasis) mismatched.push("basisAmountMinorUnits");

  if (mismatched.length > 0) throw new TaxBasisMismatchError(mismatched);
}

/** What one attempt to record evidence did. */
export interface RecordedTaxEvidence {
  evidence: OrderTaxEvidenceRecord;
  alreadyRecorded: boolean;
}

export async function recordOrderTaxEvidence(
  args: {
    order: OrderRecord;
    quote: TaxQuote;
    recordedAt: string;
    /** The buyer snapshot whose billing address produced the jurisdiction. */
    buyerSnapshotId?: string;
  },
  deps: TaxEvidenceDeps = {},
): Promise<RecordedTaxEvidence> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoTaxEvidenceIdProvider;

  requireTaxQuoteMatchesOrder(args.order, args.quote);

  try {
    const row = await db.orderTaxEvidence.create({
      data: {
        id: ids.nextTaxEvidenceId(),
        orderId: args.order.orderId,
        provider: args.quote.provider,
        providerCalculationRef: args.quote.providerCalculationRef,
        currency: args.quote.currency,
        taxAmountMinorUnits: BigInt(args.quote.taxAmountMinorUnits),
        basisAmountMinorUnits: BigInt(args.quote.basisAmountMinorUnits),
        treatment: args.quote.treatment,
        jurisdictionCode: args.quote.jurisdictionCode,
        calculatedAt: new Date(args.quote.calculatedAt),
        recordedAt: new Date(args.recordedAt),
        buyerSnapshotId: args.buyerSnapshotId ?? null,
      },
    });
    return { evidence: rowToRecord(row), alreadyRecorded: false };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = await db.orderTaxEvidence.findUnique({
        where: { orderId: args.order.orderId },
      });
      if (existing !== null) {
        return { evidence: rowToRecord(existing), alreadyRecorded: true };
      }
    }
    if (error instanceof TaxError) throw error;
    throw new TaxEvidencePersistenceFailureError("recordOrderTaxEvidence", error);
  }
}

export async function getOrderTaxEvidence(
  orderId: string,
  deps: TaxEvidenceDeps = {},
): Promise<OrderTaxEvidenceRecord | null> {
  const db = deps.db ?? getPrisma();
  try {
    const row = await db.orderTaxEvidence.findUnique({ where: { orderId } });
    return row === null ? null : rowToRecord(row);
  } catch (error) {
    if (error instanceof TaxError) throw error;
    throw new TaxEvidencePersistenceFailureError("getOrderTaxEvidence", error);
  }
}

/** Shared existence read, usable inside and outside a transaction. */
export async function hasTaxEvidenceIn(tx: Tx, orderId: string): Promise<boolean> {
  return (await tx.orderTaxEvidence.count({ where: { orderId } })) > 0;
}
