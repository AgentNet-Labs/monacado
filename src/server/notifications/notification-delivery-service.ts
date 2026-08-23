/**
 * `NotificationDelivery` — **LEGACY, READ-ONLY** (Phase 1.1; retired as a writer
 * in Phase 1.5). SERVER ONLY.
 *
 * ## Status
 *
 * ```
 *   LEGACY / READ-ONLY.  NO NEW EMAIL DELIVERY WRITES.
 *   Use `outbound-email-service.ts` and `OutboundEmailDelivery` instead.
 * ```
 *
 * This module has **no writer**. `attemptDelivery` — which claimed a row, called
 * the port, and recorded the result — was removed in Phase 1.5, because the
 * property that made it correct is the property that made it unfixable: its
 * `deliveryKey` unique index enforced **at-most-once**, so a provider outage lost
 * a buyer's receipt permanently and silently, and no retry could ever be added
 * without breaking the constraint that prevented duplicates.
 *
 * `1.1` recorded that limitation against itself as a pre-live gate. `1.5` did not
 * repair it here; it separated the two ideas the key had conflated — the unique
 * key now governs the **message** and an attempt counter governs the **attempts**
 * — and that separation needed a different table.
 *
 * ## The permanent architecture
 *
 * | Record | Question | Status |
 * | --- | --- | --- |
 * | `NotificationObligation` | what does Monacado **owe**? | canonical (`0M.N1`) |
 * | `OutboundEmailDelivery` | did it **get out**, and when is it tried again? | **canonical** (`1.5`) |
 * | `NotificationDelivery` | what did one `1.1` attempt do? | **legacy, historical read only** |
 *
 * ## This table is kept, indefinitely
 *
 * It is **not** waiting to be dropped. Rows written before `1.5` are evidence of
 * messages Monacado actually attempted, and evidence does not become disposable
 * because a better mechanism arrived. There is no planned destructive cleanup
 * migration, no scheduled deletion, and no rename.
 *
 * What is forbidden is **new** functionality depending on it. Reads exist so a
 * historical row stays legible; nothing new should read one either, because
 * anything after `1.5` is in `OutboundEmailDelivery`.
 */

import "../server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { NotificationDeliveryRecord } from "../../contracts/marketplace/notification-delivery";
import { normalizeEmail } from "../../contracts/account/account";
import { getPrisma } from "../db/client";
import { DeliveryPersistenceFailureError } from "./notification-delivery-errors";
import { deliveryRowToRecord } from "./notification-delivery-mapper";

type Db = ReturnType<typeof getPrisma>;

/**
 * The machine-readable statement of this module's status.
 *
 * A constant rather than only a comment, so the decision is greppable, is
 * asserted by a test, and cannot be quietly reversed by somebody adding a writer
 * back without noticing what they are reversing.
 */
export const LEGACY_NOTIFICATION_DELIVERY = {
  status: "LEGACY_READ_ONLY",
  /** Nothing in this module writes. The `1.1` writer was removed in `1.5`. */
  writesPermitted: false,
  /** Where new email delivery state lives. */
  supersededBy: "OutboundEmailDelivery",
  /** The table is kept indefinitely. There is no planned cleanup migration. */
  retention: "RETAINED_INDEFINITELY_FOR_HISTORICAL_READ",
  plannedDestructiveMigration: "NONE",
} as const;

export interface NotificationDeliveryDeps {
  db?: Db;
}

/**
 * The digest a `1.1` row's destination was stored as.
 *
 * Kept because reading a historical row means knowing how its
 * `destinationDigest` was derived. **New code uses `emailAddressDigest`** in
 * `email-suppression-service.ts`, which is the same construction — normalised
 * through `0M.1`'s own `normalizeEmail`, then SHA-256 — reused rather than
 * restated so a digest computed either way still matches.
 */
export function destinationDigest(address: string): string {
  return createHash("sha256").update(normalizeEmail(address), "utf8").digest("hex");
}

// — Historical reads —

/**
 * Historical `1.1` delivery evidence for one subject.
 *
 * **Reads pre-`1.5` rows only** — nothing has written to this table since. A
 * caller asking what happened to a message sent today wants
 * `listEmailDeliveriesForSubject` in `outbound-email-service.ts`.
 */
export async function listDeliveriesForSubject(
  subject: { kind: string; ref: string },
  deps: NotificationDeliveryDeps = {},
): Promise<NotificationDeliveryRecord[]> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.notificationDelivery.findMany({
      where: { subjectKind: subject.kind, subjectRef: subject.ref },
      orderBy: [{ attemptedAt: "asc" }, { id: "asc" }],
    });
    return rows.map(deliveryRowToRecord);
  } catch (error) {
    throw new DeliveryPersistenceFailureError("listDeliveriesForSubject", error);
  }
}

/** Historical count, usable inside and outside a transaction. Read only. */
export async function countDeliveriesIn(
  tx: Db | Prisma.TransactionClient,
  subject: { kind: string; ref: string },
): Promise<number> {
  return tx.notificationDelivery.count({
    where: { subjectKind: subject.kind, subjectRef: subject.ref },
  });
}
