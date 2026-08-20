/**
 * Prisma ⇄ domain mapping for notification obligations (Phase 0M.N1).
 *
 * Follows the participant, payment-account, and restriction mappers exactly:
 * every row is reconstructed into a validated domain record, malformed persisted
 * data surfaces as a structured `CorruptObligationRecordError`, and raw Prisma
 * rows never escape.
 *
 * `obligationKey` is deliberately **not** emitted. It is a storage device — the
 * derived string that makes deduplication a unique index — and not a domain
 * fact. The tuple it is derived from is already on the record, and emitting both
 * would be two answers that can disagree.
 */

import type { NotificationObligation as ObligationRow } from "@prisma/client";
import {
  NotificationObligationRecord,
  type NotificationObligationRecord as ObligationRecord,
} from "../../contracts/marketplace/notification-obligation";
import { CorruptObligationRecordError } from "./notification-obligation-errors";

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

const issuePaths = (error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string[] => Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)")));

export function obligationRowToRecord(row: ObligationRow): ObligationRecord {
  const parsed = NotificationObligationRecord.safeParse({
    obligationId: row.id,
    recipientParticipantId: row.recipientParticipantId,
    category: row.category,
    subject: {
      kind: row.subjectKind,
      ref: row.subjectRef,
      versionRef: row.subjectVersionRef,
    },
    contextCode: row.contextCode,
    status: row.status,
    createdAt: iso(row.createdAt),
    acknowledgedAt: isoOrNull(row.acknowledgedAt),
    resolvedAt: isoOrNull(row.resolvedAt),
    archivedAt: isoOrNull(row.archivedAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) throw new CorruptObligationRecordError(issuePaths(parsed.error));
  return parsed.data;
}
