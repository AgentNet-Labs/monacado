/**
 * Prisma ⇄ domain mapping for the Order and post-sale records (Phase 0M.9).
 *
 * Follows the `0M.T1` and Listing mappers exactly: every row read is
 * reconstructed into a validated domain record, malformed persisted data surfaces
 * as a structured `CorruptOrderRecordError` rather than a best-effort object, and
 * raw Prisma rows never escape this adapter.
 *
 * Two properties carry the weight here:
 *
 *   1. **The buyer union is rebuilt from the discriminator**, never assembled
 *      from whichever columns happen to be non-NULL. A guest row's account
 *      columns are not read at all, so a stray account id could not become an
 *      account purchase — the same technique the Listing mapper uses for the
 *      placement and the `0M.T1` mapper uses for the economics.
 *
 *   2. **`BIGINT` money columns are narrowed explicitly, never coerced.** A
 *      stored amount outside the safe integer range means the database holds
 *      something no code path should have been able to write; quietly rounding it
 *      would produce a plausible figure that is not the one the buyer was quoted.
 */

import type {
  Order as OrderRow,
  ProceedsObligation as ObligationRow,
  PurchaseEvidence as EvidenceRow,
  ReviewSubmissionAuthority as AuthorityRow,
} from "@prisma/client";
import {
  OrderRecord,
  type BuyerIdentity,
  type OrderRecord as Order,
} from "../../contracts/marketplace/order";
import {
  ProceedsObligationRecord,
  type ProceedsObligationRecord as Obligation,
} from "../../contracts/marketplace/proceeds-obligation";
import {
  PurchaseEvidenceRecord,
  ReviewSubmissionAuthorityRecord,
  type PurchaseEvidenceRecord as Evidence,
  type ReviewSubmissionAuthorityRecord as Authority,
} from "../../contracts/marketplace/purchase-evidence";
import { CorruptOrderRecordError } from "./order-errors";

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

const issuePaths = (error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string[] => Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)")));

/** Narrow a non-negative stored `BIGINT` money column to a safe integer. */
function amount(value: bigint, field: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CorruptOrderRecordError([field]);
  }
  return Number(value);
}

/** A column that must be present on this branch. NULL means a corrupt row. */
function required<T>(value: T | null, field: string): T {
  if (value === null) throw new CorruptOrderRecordError([field]);
  return value;
}

/**
 * Rebuild the buyer union from `buyerKind`.
 *
 * The guest branch reads no account column and the account branch reads no claim
 * digest, so neither can acquire the other's fields on the way out.
 */
function rowToBuyer(row: OrderRow): BuyerIdentity {
  if (row.buyerKind === "GUEST_BUYER") {
    return {
      buyerKind: "GUEST_BUYER",
      guestClaimCodeDigest: required(row.guestClaimCodeDigest, "guestClaimCodeDigest"),
    };
  }
  return {
    buyerKind: "ACCOUNT_BUYER",
    buyerAccountId: required(row.buyerAccountId, "buyerAccountId"),
    buyerParticipantId: row.buyerParticipantId,
  };
}

export function orderRowToRecord(row: OrderRow): Order {
  const parsed = OrderRecord.safeParse({
    orderId: row.id,
    buyer: rowToBuyer(row),
    guestClaim: {
      claimedByAccountId: row.claimedByAccountId,
      claimedAt: isoOrNull(row.claimedAt),
    },
    internalListingId: row.internalListingId,
    listingSourceRecordId: row.listingSourceRecordId,
    listingSourceRecordVersion: row.listingSourceRecordVersion,
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    storefrontId: row.storefrontId,
    internalProductId: row.internalProductId,
    transactionType: row.transactionType,
    sellerParticipantId: row.sellerParticipantId,
    promoterParticipantId: row.promoterParticipantId,
    quote: {
      currency: row.currency,
      quotedCommercialRetailAmountMinorUnits: amount(
        row.quotedCommercialRetailAmountMinorUnits,
        "quotedCommercialRetailAmountMinorUnits",
      ),
      quotedTaxAmountMinorUnits: amount(
        row.quotedTaxAmountMinorUnits,
        "quotedTaxAmountMinorUnits",
      ),
      quotedShippingAmountMinorUnits: amount(
        row.quotedShippingAmountMinorUnits,
        "quotedShippingAmountMinorUnits",
      ),
      quotedOtherPassThroughAmountMinorUnits: amount(
        row.quotedOtherPassThroughAmountMinorUnits,
        "quotedOtherPassThroughAmountMinorUnits",
      ),
    },
    lifecycle: row.lifecycle,
    paymentFailureCode: row.paymentFailureCode,
    placedAt: iso(row.placedAt),
    paidAt: isoOrNull(row.paidAt),
    failedAt: isoOrNull(row.failedAt),
    cancelledAt: isoOrNull(row.cancelledAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) throw new CorruptOrderRecordError(issuePaths(parsed.error));
  return parsed.data;
}

export function proceedsObligationRowToRecord(row: ObligationRow): Obligation {
  const parsed = ProceedsObligationRecord.safeParse({
    obligationId: row.id,
    snapshotId: row.snapshotId,
    participantId: row.participantId,
    party: row.party,
    amountMinorUnits: amount(row.amountMinorUnits, "amountMinorUnits"),
    currency: row.currency,
    state: row.state,
    accruedAt: iso(row.accruedAt),
    becameEligibleAt: isoOrNull(row.becameEligibleAt),
    paidAt: isoOrNull(row.paidAt),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) throw new CorruptOrderRecordError(issuePaths(parsed.error));
  return parsed.data;
}

export function purchaseEvidenceRowToRecord(row: EvidenceRow): Evidence {
  const parsed = PurchaseEvidenceRecord.safeParse({
    purchaseEvidenceId: row.id,
    orderId: row.orderId,
    purchaseProvenance: row.purchaseProvenance,
    submitter: row.submitter,
    internalProductId: row.internalProductId,
    sellerParticipantId: row.sellerParticipantId,
    establishedAt: iso(row.establishedAt),
    createdAt: iso(row.createdAt),
  });
  if (!parsed.success) throw new CorruptOrderRecordError(issuePaths(parsed.error));
  return parsed.data;
}

export function reviewAuthorityRowToRecord(row: AuthorityRow): Authority {
  const parsed = ReviewSubmissionAuthorityRecord.safeParse({
    authorityId: row.id,
    reviewSubmissionId: row.reviewSubmissionId,
    orderId: row.orderId,
    purchaseEvidenceId: row.purchaseEvidenceId,
    reviewKind: row.reviewKind,
    reviewSubjectRef: row.reviewSubjectRef,
    submitter: row.submitter,
    purchaseProvenance: row.purchaseProvenance,
    submissionState: row.submissionState,
    status: row.status,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) throw new CorruptOrderRecordError(issuePaths(parsed.error));
  return parsed.data;
}

/**
 * Flatten a buyer union onto the Order's columns.
 *
 * The other branch's columns are written as explicit `null` rather than omitted,
 * so a value can never be inherited from anywhere.
 */
export function buyerToColumns(buyer: BuyerIdentity): {
  buyerKind: string;
  buyerAccountId: string | null;
  buyerParticipantId: string | null;
  guestClaimCodeDigest: string | null;
} {
  if (buyer.buyerKind === "GUEST_BUYER") {
    return {
      buyerKind: "GUEST_BUYER",
      buyerAccountId: null,
      buyerParticipantId: null,
      guestClaimCodeDigest: buyer.guestClaimCodeDigest,
    };
  }
  return {
    buyerKind: "ACCOUNT_BUYER",
    buyerAccountId: buyer.buyerAccountId,
    buyerParticipantId: buyer.buyerParticipantId,
    guestClaimCodeDigest: null,
  };
}
