/**
 * Prisma ⇄ domain mapping for `NotificationDelivery` — **LEGACY, READ-ONLY**
 * (Phase 1.1; writer retired in Phase 1.5). SERVER ONLY.
 *
 * ```
 *   LEGACY / READ-ONLY.  NO NEW EMAIL DELIVERY WRITES.
 *   Use `outbound-email-mapper.ts` and `OutboundEmailDelivery` instead.
 * ```
 *
 * Reached only by the historical reads in `notification-delivery-service.ts`.
 * Kept so a pre-`1.5` row stays legible; the table is retained indefinitely and
 * has no planned destructive cleanup migration.
 *
 * Follows `notification-obligation-mapper.ts` exactly: every row is reconstructed
 * into a validated domain record, malformed persisted data surfaces as a
 * structured error, and raw Prisma rows never escape.
 *
 * `deliveryKey` is deliberately **not** emitted, for the reason `obligationKey`
 * is not: it is a storage device — the derived string that makes deduplication a
 * unique index — and not a domain fact. The tuple it is derived from is already
 * on the record, and emitting both would be two answers that can disagree.
 *
 * There is no field to omit for the destination address, because **no column
 * holds one**. The digest is emitted as-is: it is already the safe reference.
 */

import "../server-only";
import type { NotificationDelivery as DeliveryRow } from "@prisma/client";
import { NotificationDeliveryRecord } from "../../contracts/marketplace/notification-delivery";
import { NotificationDeliveryServiceError } from "./notification-delivery-errors";

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export class CorruptDeliveryRecordError extends NotificationDeliveryServiceError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("CORRUPT_DELIVERY_RECORD", "A persisted notification delivery is malformed");
    this.name = "CorruptDeliveryRecordError";
    this.fields = fields;
  }
}

export function deliveryRowToRecord(row: DeliveryRow): NotificationDeliveryRecord {
  const parsed = NotificationDeliveryRecord.safeParse({
    deliveryId: row.id,
    obligationId: row.obligationId,
    audience: row.audience,
    recipientParticipantId: row.recipientParticipantId,
    category: row.category,
    subject: {
      kind: row.subjectKind,
      ref: row.subjectRef,
      /* A delivery has no version axis of its own: it accompanies a subject, and
         the obligation beside it carries the version where one applies. */
      versionRef: null,
    },
    channel: row.channel,
    destinationDigest: row.destinationDigest,
    status: row.status,
    failureCode: row.failureCode,
    providerMessageRef: row.providerMessageRef,
    attemptedAt: iso(row.attemptedAt),
    acceptedAt: isoOrNull(row.acceptedAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) {
    throw new CorruptDeliveryRecordError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  return parsed.data;
}
