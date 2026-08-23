/**
 * Prisma ⇄ domain mapping for durable outbound email (Phase 1.5) — SERVER ONLY.
 *
 * Follows `notification-delivery-mapper.ts` exactly: every row is reconstructed
 * into a validated domain record, malformed persisted data surfaces as a
 * structured error, and raw Prisma rows never escape.
 *
 * Three columns are deliberately **not** emitted. `dedupeKey` is a storage
 * device — the derived string that makes idempotency a unique index — and the
 * tuple it is derived from is already on the record. `lockToken` and
 * `leaseExpiresAt` belong to the claim protocol and to nothing that reads a
 * delivery; a token that reached a read model is a token that reached a log.
 *
 * There is no field to omit for the destination address, because **no column
 * holds one**.
 */

import "../server-only";
import type { OutboundEmailDelivery as DeliveryRow } from "@prisma/client";
import { OutboundEmailDeliveryRecord } from "../../contracts/marketplace/outbound-email";
import { CorruptOutboundEmailRecordError } from "./outbound-email-errors";

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export function outboundDeliveryRowToRecord(row: DeliveryRow): OutboundEmailDeliveryRecord {
  const parsed = OutboundEmailDeliveryRecord.safeParse({
    deliveryId: row.id,
    purpose: row.purpose,
    obligationId: row.obligationId,
    audience: row.audience,
    recipientParticipantId: row.recipientParticipantId,
    subjectKind: row.subjectKind,
    subjectRef: row.subjectRef,
    status: row.status,
    attemptCount: row.attemptCount,
    nextAttemptAt: isoOrNull(row.nextAttemptAt),
    provider: row.provider,
    providerMessageRef: row.providerMessageRef,
    destinationDigest: row.destinationDigest,
    lastFailureCode: row.lastFailureCode,
    lastFailureClass: row.lastFailureClass,
    createdAt: iso(row.createdAt),
    sentAt: isoOrNull(row.sentAt),
    finalizedAt: isoOrNull(row.finalizedAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) {
    throw new CorruptOutboundEmailRecordError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  return parsed.data;
}
