/**
 * Prisma ⇄ domain mapping for participant payment accounts (Phase 0M.8).
 *
 * Follows the participant mapper exactly: every row read is reconstructed into a
 * validated domain record, malformed persisted data surfaces as a structured
 * `CorruptPaymentAccountRecordError` rather than a best-effort object, and raw
 * Prisma rows never escape this adapter.
 *
 * The strictness matters more here than elsewhere. The value this mapper
 * produces is what `canReceivePayout` and the activation approval read, so a row
 * that parsed loosely would be a corrupt readiness flowing into a money
 * decision.
 */

import type {
  ParticipantPaymentAccount as PaymentAccountRow,
  ParticipantPaymentRequirementRow as RequirementRow,
} from "@prisma/client";
import {
  ParticipantPaymentAccountRecord,
  canonicalizeRequirements,
  type ParticipantPaymentAccountRecord as PaymentAccountRecord,
  type PaymentRequirementCode,
} from "../../contracts/marketplace/payment-account";
import { CorruptPaymentAccountRecordError } from "./payment-account-errors";

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

const issuePaths = (error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string[] => Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)")));

/**
 * Reconstruct a validated payment-account record from its row and requirements.
 *
 * Requirements are canonicalized on the way out so a stored set round-trips in a
 * stable order regardless of insertion order — the same determinism the source
 * mappers apply to everything they reconstruct.
 */
export function paymentAccountRowToRecord(
  row: PaymentAccountRow,
  requirementRows: readonly RequirementRow[],
): PaymentAccountRecord {
  const parsed = ParticipantPaymentAccountRecord.safeParse({
    paymentAccountId: row.id,
    participantId: row.participantId,
    provider: row.provider,
    providerAccountRef: row.providerAccountRef,
    readiness: row.readiness,
    readinessObservedAt: isoOrNull(row.readinessObservedAt),
    outstandingRequirements: canonicalizeRequirements(
      requirementRows.map((r) => r.requirementCode as PaymentRequirementCode),
    ),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) throw new CorruptPaymentAccountRecordError(issuePaths(parsed.error));
  return parsed.data;
}
