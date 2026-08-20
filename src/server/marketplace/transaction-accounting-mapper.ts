/**
 * Prisma ⇄ domain mapping for MoR transaction accounting (Phase 0M.T1).
 *
 * Follows the commercial-policy and Listing mappers exactly: every row read is
 * reconstructed into a validated domain record, malformed persisted data surfaces
 * as a structured `CorruptTransactionRecordError` rather than a best-effort
 * object, and raw Prisma rows never escape this adapter.
 *
 * Two properties carry the weight here:
 *
 *   1. **The discriminated union is rebuilt from the discriminator**, never
 *      assembled from whichever columns happen to be non-NULL. A `SELLER_DIRECT`
 *      row's promoted columns are not read at all, so a stray value in one cannot
 *      become promoter proceeds on a sale that had no promoter — the same
 *      technique the Listing mapper uses for the placement.
 *
 *   2. **`BIGINT` money columns are narrowed explicitly, never coerced.** A
 *      stored amount outside the safe integer range means the database holds
 *      something no code path should have been able to write; quietly rounding it
 *      would produce a plausible figure that is not the one the sale ran under.
 *      The promoter retail spread is the one signed column, and is narrowed with
 *      the signed guard rather than the non-negative one.
 */

import type {
  TransactionEconomicSnapshot as SnapshotRow,
  TransactionSettlement as SettlementRow,
} from "@prisma/client";
import {
  TransactionEconomicSnapshotRecord,
  TransactionSettlementRecord,
  type TransactionEconomicSnapshotRecord as SnapshotRecord,
  type TransactionEconomics,
  type TransactionSettlementRecord as SettlementRecord,
} from "../../contracts/marketplace/transaction-accounting";
import { CorruptTransactionRecordError } from "./transaction-accounting-errors";

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

const issuePaths = (error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string[] => Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)")));

/** Narrow a non-negative stored `BIGINT` money column to a safe integer. */
function amount(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CorruptTransactionRecordError([field]);
  }
  return Number(value);
}

/** Narrow a signed stored `BIGINT` money column — the promoter spread alone. */
function signedAmount(value: bigint, field: string): number {
  if (value < -BigInt(Number.MAX_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CorruptTransactionRecordError([field]);
  }
  return Number(value);
}

/** A promoted column that must be present. NULL here means a corrupt row, not a zero. */
function requiredOnPromoted<T>(value: T | null, field: string): T {
  if (value === null) throw new CorruptTransactionRecordError([field]);
  return value;
}

/**
 * Rebuild the economics union from `transactionType`.
 *
 * The seller-direct branch reads none of the promoted columns, so a promoted
 * value stranded on a seller-direct row cannot reach the domain record.
 */
function rowToEconomics(row: SnapshotRow): TransactionEconomics {
  const shared = {
    monacadoRetainedAmountMinorUnits: amount(
      row.monacadoRetainedAmountMinorUnits,
      "monacadoRetainedAmountMinorUnits",
    ),
    morWholesaleAcquisitionAmountMinorUnits: amount(
      row.morWholesaleAcquisitionAmountMinorUnits,
      "morWholesaleAcquisitionAmountMinorUnits",
    ),
    sellerProceedsMinorUnits: amount(
      row.sellerProceedsMinorUnits,
      "sellerProceedsMinorUnits",
    ),
  };

  if (row.transactionType !== "PROMOTED") {
    return { transactionType: "SELLER_DIRECT", ...shared } as TransactionEconomics;
  }

  return {
    transactionType: "PROMOTED",
    offerBinding: {
      internalOfferId: requiredOnPromoted(row.internalOfferId, "internalOfferId"),
      offerSourceRecordId: requiredOnPromoted(
        row.offerSourceRecordId,
        "offerSourceRecordId",
      ),
      offerSourceRecordVersion: requiredOnPromoted(
        row.offerSourceRecordVersion,
        "offerSourceRecordVersion",
      ),
    },
    ...shared,
    offerWholesalePriceMinorUnits: amount(
      requiredOnPromoted(row.offerWholesalePriceMinorUnits, "offerWholesalePriceMinorUnits"),
      "offerWholesalePriceMinorUnits",
    ),
    sellerFundedCommissionMinorUnits: amount(
      requiredOnPromoted(
        row.sellerFundedCommissionMinorUnits,
        "sellerFundedCommissionMinorUnits",
      ),
      "sellerFundedCommissionMinorUnits",
    ),
    promoterRetailSpreadMinorUnits: signedAmount(
      requiredOnPromoted(
        row.promoterRetailSpreadMinorUnits,
        "promoterRetailSpreadMinorUnits",
      ),
      "promoterRetailSpreadMinorUnits",
    ),
    promoterNetProceedsMinorUnits: amount(
      requiredOnPromoted(row.promoterNetProceedsMinorUnits, "promoterNetProceedsMinorUnits"),
      "promoterNetProceedsMinorUnits",
    ),
  } as TransactionEconomics;
}

export function snapshotRowToRecord(row: SnapshotRow): SnapshotRecord {
  const parsed = TransactionEconomicSnapshotRecord.safeParse({
    snapshotId: row.id,
    listingBinding: {
      internalListingId: row.internalListingId,
      listingSourceRecordId: row.listingSourceRecordId,
      listingSourceRecordVersion: row.listingSourceRecordVersion,
    },
    policyBinding: {
      policyId: row.policyId,
      policyVersion: row.policyVersion,
    },
    commercialRetailAmountMinorUnits: amount(
      row.commercialRetailAmountMinorUnits,
      "commercialRetailAmountMinorUnits",
    ),
    currency: row.currency,
    economics: rowToEconomics(row),
    passThrough: {
      taxAmountMinorUnits: amount(row.taxAmountMinorUnits, "taxAmountMinorUnits"),
      shippingAmountMinorUnits: amount(
        row.shippingAmountMinorUnits,
        "shippingAmountMinorUnits",
      ),
      otherPassThroughAmountMinorUnits: amount(
        row.otherPassThroughAmountMinorUnits,
        "otherPassThroughAmountMinorUnits",
      ),
    },
    occurredAt: iso(row.occurredAt),
    recordedAt: iso(row.recordedAt),
  });
  if (!parsed.success) throw new CorruptTransactionRecordError(issuePaths(parsed.error));
  return parsed.data;
}

export function settlementRowToRecord(row: SettlementRow): SettlementRecord {
  const parsed = TransactionSettlementRecord.safeParse({
    snapshotId: row.snapshotId,
    state: row.state,
    provider: row.provider,
    providerTransactionRef: row.providerTransactionRef,
    providerReferenceRecordedAt: isoOrNull(row.providerReferenceRecordedAt),
    fundsReceivedAt: isoOrNull(row.fundsReceivedAt),
    settledAt: isoOrNull(row.settledAt),
    reversedAt: isoOrNull(row.reversedAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) throw new CorruptTransactionRecordError(issuePaths(parsed.error));
  return parsed.data;
}

/**
 * Flatten domain economics onto the snapshot's columns.
 *
 * The promoted columns are written as explicit `null` on the seller-direct
 * branch rather than omitted, so a value can never be inherited from anywhere.
 */
export function economicsToColumns(economics: TransactionEconomics): {
  transactionType: string;
  internalOfferId: string | null;
  offerSourceRecordId: string | null;
  offerSourceRecordVersion: string | null;
  monacadoRetainedAmountMinorUnits: bigint;
  morWholesaleAcquisitionAmountMinorUnits: bigint;
  sellerProceedsMinorUnits: bigint;
  offerWholesalePriceMinorUnits: bigint | null;
  sellerFundedCommissionMinorUnits: bigint | null;
  promoterRetailSpreadMinorUnits: bigint | null;
  promoterNetProceedsMinorUnits: bigint | null;
} {
  const shared = {
    transactionType: economics.transactionType,
    monacadoRetainedAmountMinorUnits: BigInt(economics.monacadoRetainedAmountMinorUnits),
    morWholesaleAcquisitionAmountMinorUnits: BigInt(
      economics.morWholesaleAcquisitionAmountMinorUnits,
    ),
    sellerProceedsMinorUnits: BigInt(economics.sellerProceedsMinorUnits),
  };

  if (economics.transactionType === "SELLER_DIRECT") {
    return {
      ...shared,
      internalOfferId: null,
      offerSourceRecordId: null,
      offerSourceRecordVersion: null,
      offerWholesalePriceMinorUnits: null,
      sellerFundedCommissionMinorUnits: null,
      promoterRetailSpreadMinorUnits: null,
      promoterNetProceedsMinorUnits: null,
    };
  }

  return {
    ...shared,
    internalOfferId: economics.offerBinding.internalOfferId,
    offerSourceRecordId: economics.offerBinding.offerSourceRecordId,
    offerSourceRecordVersion: economics.offerBinding.offerSourceRecordVersion,
    offerWholesalePriceMinorUnits: BigInt(economics.offerWholesalePriceMinorUnits),
    sellerFundedCommissionMinorUnits: BigInt(economics.sellerFundedCommissionMinorUnits),
    promoterRetailSpreadMinorUnits: BigInt(economics.promoterRetailSpreadMinorUnits),
    promoterNetProceedsMinorUnits: BigInt(economics.promoterNetProceedsMinorUnits),
  };
}
