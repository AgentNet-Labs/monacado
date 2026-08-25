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
  productionTaxQuoteIssues,
  taxQuoteIsUsableAt,
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
  TaxProductBasisMismatchError,
  TaxProviderConfigurationError,
  TaxQuoteExpiredError,
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
  providerMode: string | null;
  providerCalculationRef: string;
  providerCalculationExpiresAt: Date | null;
  currency: string;
  taxAmountMinorUnits: bigint;
  basisAmountMinorUnits: bigint;
  treatment: string;
  jurisdictionCode: string | null;
  productSourceRecordId: string | null;
  productSourceRecordVersion: string | null;
  productTaxClassification: string | null;
  providerTaxCode: string | null;
  providerConfigVersion: string | null;
  calculatedAt: Date;
  recordedAt: Date;
  buyerSnapshotId: string | null;
}): OrderTaxEvidenceRecord {
  const parsed = OrderTaxEvidenceRecord.safeParse({
    taxEvidenceId: row.id,
    orderId: row.orderId,
    provider: row.provider,
    providerMode: row.providerMode,
    providerCalculationRef: row.providerCalculationRef,
    providerCalculationExpiresAt:
      row.providerCalculationExpiresAt === null
        ? null
        : row.providerCalculationExpiresAt.toISOString(),
    currency: row.currency,
    taxAmountMinorUnits: Number(row.taxAmountMinorUnits),
    basisAmountMinorUnits: Number(row.basisAmountMinorUnits),
    treatment: row.treatment,
    jurisdictionCode: row.jurisdictionCode,
    productSourceRecordId: row.productSourceRecordId,
    productSourceRecordVersion: row.productSourceRecordVersion,
    productTaxClassification: row.productTaxClassification,
    providerTaxCode: row.providerTaxCode,
    providerConfigVersion: row.providerConfigVersion,
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
export function requireTaxQuoteMatchesOrder(
  order: OrderRecord,
  quote: TaxQuote,
  /**
   * The instant the sale is being booked at (Phase 1.6).
   *
   * Optional so `1.2`'s callers keep working unchanged; supplied by checkout, and
   * what turns "the provider says this expired" from a fact nobody checked into a
   * refusal. A quote that expired between calculation and placement cannot become
   * the provider-side transaction a later reversal needs.
   */
  at?: string,
): void {
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

  /* — Phase 1.6 —
   *
   * The quote must be about the Product this Order is for. The port guard already
   * checked the quote against the REQUEST; this checks it against the ORDER, and
   * they are different questions — the request was built before `placeOrder`
   * committed, and this is the last point at which a divergence can be caught
   * before a buyer is charged. */
  if (
    quote.productTaxBasis !== null &&
    quote.productTaxBasis.internalProductId !== order.internalProductId
  ) {
    throw new TaxProductBasisMismatchError(["internalProductId"]);
  }

  const incomplete = productionTaxQuoteIssues(quote);
  if (incomplete.length > 0) throw new TaxProviderConfigurationError(incomplete);

  if (at !== undefined && !taxQuoteIsUsableAt(quote, at)) throw new TaxQuoteExpiredError();
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

  /* The instant the evidence is being recorded at is the instant the sale is
     being booked at, so it is also the instant an expiry must be judged against. */
  requireTaxQuoteMatchesOrder(args.order, args.quote, args.recordedAt);

  const basis = args.quote.productTaxBasis;

  try {
    const row = await db.orderTaxEvidence.create({
      data: {
        id: ids.nextTaxEvidenceId(),
        orderId: args.order.orderId,
        provider: args.quote.provider,
        providerMode: args.quote.providerMode,
        providerCalculationRef: args.quote.providerCalculationRef,
        providerCalculationExpiresAt:
          args.quote.expiresAt === null ? null : new Date(args.quote.expiresAt),
        currency: args.quote.currency,
        taxAmountMinorUnits: BigInt(args.quote.taxAmountMinorUnits),
        basisAmountMinorUnits: BigInt(args.quote.basisAmountMinorUnits),
        treatment: args.quote.treatment,
        jurisdictionCode: args.quote.jurisdictionCode,
        /* Pinned from the quote, so the exact Product source version and
           classification this rate came from survive every later change to
           either. */
        productSourceRecordId: basis === null ? null : basis.sourceRecordId,
        productSourceRecordVersion: basis === null ? null : basis.sourceRecordVersion,
        productTaxClassification: basis === null ? null : basis.taxClassification,
        providerTaxCode: args.quote.providerTaxCode,
        providerConfigVersion: args.quote.providerConfigVersion,
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

// — The refund/reversal seam (Phase 1.6) —

/**
 * What a later refund phase needs from this evidence, stated rather than assumed.
 *
 * **No refund execution exists**, here or anywhere in this phase, and nothing
 * below is called. This is the contract the seam has to satisfy, written down at
 * the moment the evidence was designed rather than reconstructed afterwards by
 * whoever picks up the reversal work.
 *
 * ## What is already durable
 *
 *   - `provider` and `providerMode` — which engine, in which world.
 *   - `providerCalculationRef` — **the** identifier. Stripe's reversal path
 *     works from the Tax Transaction that a calculation produces, and this is the
 *     calculation it is produced from.
 *   - `providerCalculationExpiresAt` — when the engine stops honouring it.
 *   - the pinned Product basis, so a reversal is evidently about the same sale.
 *   - `taxAmountMinorUnits` and `basisAmountMinorUnits` — what was charged, and
 *     on what.
 *
 * ## What the reversal phase must add, and why it is not here
 *
 * Stripe Tax's reporting, filing, and reversal products all operate on a **Tax
 * Transaction**, created from a calculation *after* the payment succeeds.
 *
 * **Phase 1.7 built exactly that.** `OrderTaxTransaction` commits the obligation
 * inside the sale's own transaction and a bounded worker reports it, so Stripe's
 * reports now contain Monacado's sales and the durable
 * `providerTaxTransactionRef` a reversal must name exists. What remains for the
 * reversal phase is `createReversal` itself and the accounting rules that decide
 * whose money comes back — not the identifier.
 *
 * **The immutable economic snapshot is not touched by any of this.** `0M.T1` gave
 * `TransactionEconomicSnapshot` no update path, `1.2` added `TransactionReversal`
 * as new evidence *about* a snapshot rather than a correction *of* one, and a tax
 * reversal is the same shape of fact: a new row, never an edit.
 */
export const TAX_REVERSAL_FUTURE_HOOK = {
  /** Already persisted, and sufficient to identify the original calculation. */
  durableIdentifiers: [
    "provider",
    "providerMode",
    "providerCalculationRef",
    "providerCalculationExpiresAt",
    "productSourceRecordId",
    "productSourceRecordVersion",
    "productTaxClassification",
  ],
  /** The first two were delivered by Phase 1.7. The third remains. */
  requiredFutureSteps: ["REVERSE_PROVIDER_TAX_TRANSACTION_ON_REFUND"],
  /** Delivered in Phase 1.7 — see `tax-transaction.ts`. */
  deliveredInPhase17: [
    "RECORD_PROVIDER_TAX_TRANSACTION_ON_CONFIRMED_PAYMENT",
    "PERSIST_PROVIDER_TAX_TRANSACTION_REF",
  ],
  /** Unchanged by this phase, and by the reversal phase. */
  economicSnapshotMutation: "FORBIDDEN",
} as const;
