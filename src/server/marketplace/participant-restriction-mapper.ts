/**
 * Prisma ⇄ domain mapping for participant restrictions (Phase 0M.R1).
 *
 * Follows the participant mapper exactly: every row is reconstructed into a
 * validated domain record, malformed persisted data surfaces as a structured
 * `CorruptRestrictionRecordError`, and raw Prisma rows never escape.
 *
 * `activeForScope` is deliberately **not** emitted. It is a storage device — the
 * nullable marker that makes "at most one active restriction per scope" a unique
 * index — and not a domain fact. `status` already answers whether a restriction
 * stands, and emitting both would be two answers that can disagree.
 */

import type { ParticipantRestriction as RestrictionRow } from "@prisma/client";
import {
  ParticipantRestrictionRecord,
  type ParticipantRestrictionRecord as RestrictionRecord,
} from "../../contracts/marketplace/participant-restriction";
import { CorruptRestrictionRecordError } from "./participant-restriction-errors";

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

const issuePaths = (error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string[] => Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)")));

export function restrictionRowToRecord(row: RestrictionRow): RestrictionRecord {
  const parsed = ParticipantRestrictionRecord.safeParse({
    restrictionId: row.id,
    participantId: row.participantId,
    scope: row.scope,
    reasonCode: row.reasonCode,
    status: row.status,
    imposedAt: iso(row.imposedAt),
    imposedByAccountId: row.imposedByAccountId,
    liftedAt: isoOrNull(row.liftedAt),
    liftedByAccountId: row.liftedByAccountId,
    liftedReasonCode: row.liftedReasonCode,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) throw new CorruptRestrictionRecordError(issuePaths(parsed.error));
  return parsed.data;
}
