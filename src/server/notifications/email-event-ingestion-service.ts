/**
 * Provider email event ingestion (Phase 1.5) — SERVER ONLY.
 *
 * What a normalised bounce or complaint is allowed to change, and what it is
 * emphatically not.
 *
 * ```
 *   normalised event
 *        │
 *        ├─ ProviderEmailEvent row  ← UNIQUE(provider, providerEventId): the idempotency
 *        │                             ledger. A redelivered webhook stops here.
 *        │
 *        ├─ hard bounce / complaint ⇒ suppress the destination digest
 *        │
 *        └─ hard bounce / complaint ⇒ degrade the matching ParticipantEmailContact
 *                                        └─ the 1.3 support resolver then falls back
 * ```
 *
 * ## Idempotent, because every provider retries
 *
 * The whole ingestion is one transaction whose first statement inserts the event
 * row. A redelivered webhook violates `UNIQUE(provider, providerEventId)`, the
 * transaction rolls back, and **nothing is suppressed or degraded twice**. That
 * ordering is the design: suppress-then-record would leave a window in which a
 * crash produced a suppression nobody could trace to an event.
 *
 * ## What a bounce does NOT do
 *
 * **It does not suspend the seller.** `0M.1`'s admission lifecycle is a governed
 * decision about a participant; an address failing is a fact about a mailbox. A
 * seller whose dedicated support address bounces keeps selling on their verified
 * primary — that is precisely what `1.3`'s fallback precedence is for — and only
 * a seller with **no** usable contact left becomes transaction-ineligible, through
 * `1.3`'s existing checkout check, which this phase does not touch.
 *
 * It also advances no `NotificationObligation`, retries nothing, and cancels no
 * committed delivery. A message already in flight is resolved by the dispatcher's
 * own suppression check on its next attempt.
 *
 * ## The address is used and dropped
 *
 * The plaintext address arrives on the event, is used **in memory** to find the
 * affected contact, and is reduced to a digest before anything is written. No row
 * this module touches gains an address column.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import { normalizeEmail } from "../../contracts/account/account";
import { suppressionReasonFor } from "../../contracts/marketplace/outbound-email";
import { getPrisma } from "../db/client";
import { emailAddressDigest, suppressEmailDigestIn } from "./email-suppression-service";
import {
  cryptoOutboundEmailIdProvider,
  type OutboundEmailIdProvider,
} from "./outbound-email-ids";
import { OutboundEmailPersistenceFailureError } from "./outbound-email-errors";
import type { NormalizedEmailEvent } from "./postmark-webhook";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export interface EventIngestionDeps {
  db?: Db;
  ids?: OutboundEmailIdProvider;
}

/** What one ingestion did. Counts and flags — never an address. */
export interface IngestedEvent {
  /** `false` when this exact provider event had already been ingested. */
  ingested: boolean;
  eventType: string;
  suppressed: boolean;
  /** How many `ParticipantEmailContact` rows this degraded. Usually 0 or 1. */
  contactsDegraded: number;
}

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};
const isUniqueViolation = (e: unknown): boolean => prismaCode(e) === "P2002";

/**
 * Degrade every email contact that names this address.
 *
 * Two shapes, because `0M.5` settled that the primary address lives on `Account`
 * and is never copied into a contact row:
 *
 *   - a `DEDICATED_SUPPORT` contact **holds** the address, so it is matched
 *     directly;
 *   - a `PRIMARY_PROFILE` contact holds none, so the `Account` carrying the
 *     normalised address is found first and its participant's contact degraded.
 *
 * `DELIVERY_FAILED`, not `UNVERIFIED`: the distinction records that the address
 * was once good, which is what tells an operator this is a regression rather than
 * unfinished setup. `verifiedAt` is kept and `degradedAt` records when it stopped
 * being trustworthy — `1.3`'s posture, now with a signal driving it.
 */
async function degradeContactsForAddressIn(
  tx: Tx,
  address: string,
  at: string,
): Promise<number> {
  const normalized = normalizeEmail(address);
  const degradedAt = new Date(at);
  let degraded = 0;

  const dedicated = await tx.participantEmailContact.updateMany({
    where: {
      purpose: "DEDICATED_SUPPORT",
      address: normalized,
      state: { in: ["UNVERIFIED", "VERIFIED", "REVERIFY_REQUIRED"] },
    },
    data: { state: "DELIVERY_FAILED", degradedAt },
  });
  degraded += dedicated.count;

  const account = await tx.account.findUnique({
    where: { normalizedEmail: normalized },
    select: { participant: { select: { id: true } } },
  });
  const participantId = account?.participant?.id ?? null;
  if (participantId !== null) {
    const primary = await tx.participantEmailContact.updateMany({
      where: {
        participantId,
        purpose: "PRIMARY_PROFILE",
        state: { in: ["UNVERIFIED", "VERIFIED", "REVERIFY_REQUIRED"] },
      },
      data: { state: "DELIVERY_FAILED", degradedAt },
    });
    degraded += primary.count;
  }

  return degraded;
}

/**
 * Ingest one normalised provider event.
 *
 * One transaction, event row first. Everything else in it is conditional on that
 * insert having succeeded, which is what makes a redelivered webhook a no-op
 * rather than a second suppression.
 */
export async function ingestProviderEmailEvent(
  event: NormalizedEmailEvent,
  receivedAt: string,
  deps: EventIngestionDeps = {},
): Promise<IngestedEvent> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoOutboundEmailIdProvider;
  const addressDigest = emailAddressDigest(event.address);
  const reason = suppressionReasonFor(event.eventType);

  try {
    return await db.$transaction(async (tx) => {
      const eventId = ids.nextProviderEventId();
      await tx.providerEmailEvent.create({
        data: {
          id: eventId,
          provider: event.provider,
          providerEventId: event.providerEventId,
          eventType: event.eventType,
          addressDigest,
          providerMessageRef: event.providerMessageRef,
          occurredAt: new Date(event.occurredAt),
          receivedAt: new Date(receivedAt),
          createdAt: new Date(receivedAt),
        },
      });

      if (reason === null) {
        /* A soft bounce or a delivery confirmation. Recorded so an operator can
           see it happened; it changes nothing, because the retry policy already
           owns transient conditions. */
        return {
          ingested: true,
          eventType: event.eventType,
          suppressed: false,
          contactsDegraded: 0,
        };
      }

      await suppressEmailDigestIn(tx, {
        addressDigest,
        reason,
        evidenceEventId: eventId,
        at: receivedAt,
        suppressionId: ids.nextSuppressionId(),
      });

      const contactsDegraded = await degradeContactsForAddressIn(tx, event.address, receivedAt);

      return { ingested: true, eventType: event.eventType, suppressed: true, contactsDegraded };
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      /* Already ingested. The provider is retrying, which is what providers do. */
      return {
        ingested: false,
        eventType: event.eventType,
        suppressed: false,
        contactsDegraded: 0,
      };
    }
    throw new OutboundEmailPersistenceFailureError("ingestProviderEmailEvent", error);
  }
}
