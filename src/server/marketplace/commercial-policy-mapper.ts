/**
 * Prisma ⇄ domain mapping for commercial policy (Phase 0M.R1).
 *
 * Follows the participant and payment-account mappers exactly: every row read is
 * reconstructed into a validated domain record, malformed persisted data
 * surfaces as a structured `CorruptCommercialPolicyRecordError` rather than a
 * best-effort object, and raw Prisma rows never escape this adapter.
 *
 * The strictness earns its keep here more than anywhere. What this mapper
 * produces becomes the economics a sale is priced under, so a row that parsed
 * loosely would be a corrupt rate flowing into money — silently, and reproducibly
 * wrong for every transaction afterwards.
 *
 * `BigInt` columns are narrowed explicitly rather than coerced. The fixed
 * retained amount is stored as `BIGINT` for the same reason every other minor-unit
 * column is, and a value beyond the safe integer range is a corrupt row rather
 * than something to round.
 */

import type {
  CommercialPolicy as PolicyRow,
  CommercialPolicyVersionRow as VersionRow,
} from "@prisma/client";
import {
  CommercialPolicyRecord,
  CommercialPolicyVersionRecord,
  type CommercialPolicyRecord as PolicyRecord,
  type CommercialPolicyVersionRecord as VersionRecord,
} from "../../contracts/marketplace/commercial-policy";
import { CorruptCommercialPolicyRecordError } from "./commercial-policy-errors";

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

const issuePaths = (error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string[] => Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)")));

/**
 * Narrow a stored `BIGINT` money column to a safe integer.
 *
 * Raised rather than clamped: a stored amount outside the safe range means the
 * database holds something no code path should have been able to write, and
 * quietly rounding it would produce a plausible price that is not the one the
 * policy was recorded with.
 */
function safeMinorUnits(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < 0n) {
    throw new CorruptCommercialPolicyRecordError([field]);
  }
  return Number(value);
}

export function policyRowToRecord(row: PolicyRow): PolicyRecord {
  const parsed = CommercialPolicyRecord.safeParse({
    policyId: row.id,
    label: row.label,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) throw new CorruptCommercialPolicyRecordError(issuePaths(parsed.error));
  return parsed.data;
}

export function policyVersionRowToRecord(row: VersionRow): VersionRecord {
  const parsed = CommercialPolicyVersionRecord.safeParse({
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    status: row.status,
    currency: row.currency,
    retainedPercentageBasisPoints: row.retainedPercentageBasisPoints,
    retainedFixedAmountMinorUnits: safeMinorUnits(
      row.retainedFixedAmountMinorUnits,
      "retainedFixedAmountMinorUnits",
    ),
    roundingPolicy: row.roundingPolicy,
    effectiveFrom: iso(row.effectiveFrom),
    recordedByAccountId: row.recordedByAccountId,
    recordedAt: iso(row.recordedAt),
    retiredAt: isoOrNull(row.retiredAt),
    retiredByAccountId: row.retiredByAccountId,
  });
  if (!parsed.success) throw new CorruptCommercialPolicyRecordError(issuePaths(parsed.error));
  return parsed.data;
}
