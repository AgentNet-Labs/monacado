/**
 * Notification delivery (Phase 1.1) — SERVER ONLY.
 *
 * One operation: **attempt one message once, and record what happened.**
 *
 * ## Claim, then send
 *
 * ```
 * 1. INSERT the delivery row (status ATTEMPTED) — unique on deliveryKey
 *      └─ duplicate key ⇒ somebody already attempted this. Send NOTHING, return.
 * 2. call the mail port
 * 3. UPDATE the row to ACCEPTED (+ provider ref) or FAILED (+ bounded code)
 * ```
 *
 * The order is the whole design. Claiming *before* sending makes the send
 * **at-most-once**: two concurrent webhook deliveries race on the unique index
 * and exactly one wins, so a buyer never receives two receipts. The alternative —
 * send, then record — is at-least-once, and for transactional mail a duplicate
 * receipt is worse than a missing one, because a second "your payment succeeded"
 * reads as a second charge.
 *
 * A process that dies between steps 1 and 3 leaves a row at `ATTEMPTED`. That is
 * a visible, queryable state an operator can act on, which is precisely what it
 * should be — the honest answer to "did this send?" is *we don't know*, and no
 * automatic retry is going to know any better.
 *
 * ## Delivery is not obligation
 *
 * **Nothing in this module writes to `NotificationObligation`.**
 * `AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md` §3a: the admin panel is canonical
 * and supplemental channels "can never replace it". A delivery does not satisfy,
 * close, or advance an obligation, and a failed one leaves it exactly as owed as
 * it was.
 *
 * ## Retry
 *
 * Deliberately absent. There is no `nextAttemptAt`, no backoff, no scheduler, and
 * no sweeper. Re-attempting after a provider failure needs a decision about how
 * many duplicate receipts are acceptable in exchange for how much reliability,
 * and that decision belongs with `0M.N2`'s delivery policy rather than being
 * assumed here.
 */

import "../server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import {
  notificationDeliveryKey,
  type DeliveryAudience,
  type DeliveryFailureCode,
  type MailPort,
  type NotificationDeliveryRecord,
} from "../../contracts/marketplace/notification-delivery";
import type { NotificationCategory } from "../../contracts/marketplace/notification-obligation";
import { normalizeEmail } from "../../contracts/account/account";
import { getPrisma } from "../db/client";
import {
  cryptoNotificationDeliveryIdProvider,
  type NotificationDeliveryIdProvider,
} from "./notification-delivery-ids";
import { DeliveryPersistenceFailureError } from "./notification-delivery-errors";
import { deliveryRowToRecord } from "./notification-delivery-mapper";

type Db = ReturnType<typeof getPrisma>;

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};
const isUniqueViolation = (e: unknown): boolean => prismaCode(e) === "P2002";

/**
 * The digest that stands in for an address.
 *
 * Normalised first — trim and lowercase, through `0M.1`'s own `normalizeEmail`,
 * reused rather than restated so the digest of an address always matches however
 * it was typed. SHA-256, hex, the same construction as `0M.9`'s guest claim code.
 */
export function destinationDigest(address: string): string {
  return createHash("sha256").update(normalizeEmail(address), "utf8").digest("hex");
}

export interface NotificationDeliveryDeps {
  db?: Db;
  ids?: NotificationDeliveryIdProvider;
}

/** What one attempt did. Bounded, so a caller need not read rows to find out. */
export const DELIVERY_OUTCOMES = ["SENT", "REFUSED", "ALREADY_ATTEMPTED"] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

export interface AttemptedDelivery {
  outcome: DeliveryOutcome;
  /** `null` only when the claim lost the race and no row of ours exists. */
  delivery: NotificationDeliveryRecord | null;
}

export interface DeliveryRequest {
  audience: DeliveryAudience;
  /** The participant addressed, or `null` for a buyer holding none. */
  recipientParticipantId: string | null;
  /** The `0M.N1` obligation this accompanies, where one exists. */
  obligationId: string | null;
  category: NotificationCategory;
  subject: { kind: string; ref: string; versionRef: string | null };
  /** Transient. Digested here; the raw value reaches only the mail port. */
  destination: string;
  subjectLine: string;
  body: string;
  at: string;
}

/**
 * Attempt one delivery, once.
 *
 * Returns rather than throws for every ordinary outcome — a refused message and
 * an already-attempted one are both normal, and a webhook handler must be able to
 * tell them apart without catching.
 */
export async function attemptDelivery(
  request: DeliveryRequest,
  port: MailPort,
  deps: NotificationDeliveryDeps = {},
): Promise<AttemptedDelivery> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoNotificationDeliveryIdProvider;

  const deliveryKey = notificationDeliveryKey({
    audience: request.audience,
    recipientParticipantId: request.recipientParticipantId,
    category: request.category,
    subject: request.subject,
    channel: "EMAIL",
  });

  /* 1 — CLAIM. The unique index on deliveryKey is what makes the send
     at-most-once; two concurrent webhook deliveries race here and one loses. */
  let claimed;
  try {
    claimed = await db.notificationDelivery.create({
      data: {
        id: ids.nextDeliveryId(),
        obligationId: request.obligationId,
        audience: request.audience,
        recipientParticipantId: request.recipientParticipantId,
        category: request.category,
        subjectKind: request.subject.kind,
        subjectRef: request.subject.ref,
        channel: "EMAIL",
        destinationDigest: destinationDigest(request.destination),
        status: "ATTEMPTED",
        attemptedAt: new Date(request.at),
        deliveryKey,
      },
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      /* Somebody already attempted this exact message. Send nothing. */
      const existing = await db.notificationDelivery.findUnique({ where: { deliveryKey } });
      return {
        outcome: "ALREADY_ATTEMPTED",
        delivery: existing === null ? null : deliveryRowToRecord(existing),
      };
    }
    throw new DeliveryPersistenceFailureError("attemptDelivery.claim", error);
  }

  /* 2 — SEND. Outside any transaction: a network call inside one would hold a
     row lock for the duration of somebody else's outage. */
  let result;
  try {
    result = await port.send({
      to: request.destination,
      subject: request.subjectLine,
      text: request.body,
    });
  } catch {
    /* A port that throws is a port misbehaving — the contract says an ordinary
       refusal is a result, not an exception. Recorded as unclassified rather
       than lost, and the thrown value is deliberately NOT inspected: it is the
       most likely place for an address or a rendered body to be hiding. */
    result = { outcome: "REFUSED" as const, failureCode: "UNSPECIFIED_FAILURE" as const };
  }

  /* 3 — RECORD. Evidence is written whichever way the provider answered. */
  try {
    const updated =
      result.outcome === "ACCEPTED"
        ? await db.notificationDelivery.update({
            where: { id: claimed.id },
            data: {
              status: "ACCEPTED",
              providerMessageRef: result.providerMessageRef,
              acceptedAt: new Date(request.at),
            },
          })
        : await db.notificationDelivery.update({
            where: { id: claimed.id },
            data: {
              status: "FAILED",
              failureCode: result.failureCode satisfies DeliveryFailureCode,
            },
          });
    return {
      outcome: result.outcome === "ACCEPTED" ? "SENT" : "REFUSED",
      delivery: deliveryRowToRecord(updated),
    };
  } catch (error) {
    throw new DeliveryPersistenceFailureError("attemptDelivery.record", error);
  }
}

// — Reads —

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

/** Shared read, usable inside and outside a transaction. */
export async function countDeliveriesIn(
  tx: Db | Prisma.TransactionClient,
  subject: { kind: string; ref: string },
): Promise<number> {
  return tx.notificationDelivery.count({
    where: { subjectKind: subject.kind, subjectRef: subject.ref },
  });
}
