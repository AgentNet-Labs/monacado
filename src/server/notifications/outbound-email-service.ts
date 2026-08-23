/**
 * Durable outbound email persistence (Phase 1.5) — SERVER ONLY.
 *
 * Four operations, and the order they happen in is the design:
 *
 * ```
 *   enqueue ──▶ claim ──▶ (send happens outside) ──▶ resolve
 *                  ▲                                    │
 *                  └────── recoverStaleClaims ◀─────────┘ (only when a worker died)
 * ```
 *
 * ## Enqueue is idempotent, and that is a unique index
 *
 * `dedupeKey` is derived from the logical identity of the message and carries a
 * `UNIQUE` constraint. Two concurrent webhook deliveries of one sale race on it
 * and exactly one wins; the loser reads back the existing row and returns it. So
 * **one logical message is one row**, no matter how many callers commit to it —
 * which is what makes replay safe without making retry impossible.
 *
 * That is the precise correction to `1.1`. `1.1` conflated "do not send twice"
 * with "do not try twice" and got at-most-once: a provider outage lost a buyer's
 * receipt permanently and silently. Here the unique key governs the **message**
 * and the attempt counter governs the **attempts**, so a receipt is sent once and
 * tried up to five times.
 *
 * ## Claiming is a guarded UPDATE, exactly as the outbox does it
 *
 * `PublicationOutbox` settled this convention and it is reused rather than
 * reinvented: a single `updateMany` re-asserts eligibility and stamps a lock
 * token, so of two concurrent workers exactly one matches a row. Resolution then
 * re-asserts the same token, so a worker whose lease expired while it was
 * sending cannot write its result over the row somebody else now holds.
 *
 * ## A crash costs an attempt, never the message
 *
 * A worker that dies mid-send leaves `IN_PROGRESS` with an expired lease.
 * `recoverStaleClaims` returns it to `RETRY_PENDING` **and counts the attempt**,
 * which is the honest accounting: the message may well have gone out, and a
 * recovery that did not count it would retry a delivered receipt five more times.
 * Bounded at-least-once is the trade, and it is the right way round for
 * transactional mail — `1.1` chose at-most-once when it had no retry at all, and
 * the pre-live gate it recorded was exactly this.
 *
 * Nothing in this module sends anything, renders anything, or reads a provider.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  CLAIMABLE_DELIVERY_STATUSES,
  EMAIL_RETRY_POLICY,
  nextAttemptAt as computeNextAttemptAt,
  outboundEmailDeliveryKey,
  type OutboundDeliveryStatus,
  type OutboundEmailDeliveryRecord,
  type OutboundEmailPurpose,
  type OutboundEmailSubjectKind,
  type SendOutcomeClass,
} from "../../contracts/marketplace/outbound-email";
import type {
  DeliveryAudience,
  DeliveryFailureCode,
} from "../../contracts/marketplace/notification-delivery";
import { getPrisma } from "../db/client";
import {
  cryptoOutboundEmailIdProvider,
  type OutboundEmailIdProvider,
} from "./outbound-email-ids";
import {
  DeliveryClaimConflictError,
  OutboundEmailPersistenceFailureError,
} from "./outbound-email-errors";
import { outboundDeliveryRowToRecord } from "./outbound-email-mapper";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export interface OutboundEmailDeps {
  db?: Db;
  ids?: OutboundEmailIdProvider;
}

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};
const isUniqueViolation = (e: unknown): boolean => prismaCode(e) === "P2002";

// — Enqueue —

export interface EnqueueEmailInput {
  purpose: OutboundEmailPurpose;
  audience: DeliveryAudience;
  /** The participant addressed, or `null` for a buyer holding none. */
  recipientParticipantId: string | null;
  /** The `0M.N1` obligation this accompanies, where one exists. */
  obligationId: string | null;
  subjectKind: OutboundEmailSubjectKind;
  subjectRef: string;
  /**
   * What separates a message that may legitimately be sent again from one that
   * may not. `null` for a once-ever message such as an order receipt.
   */
  discriminator: string | null;
  now: string;
}

/**
 * Commit to sending one message, once.
 *
 * Returns the existing row unchanged when the logical message is already
 * committed — including when it has already been delivered or has permanently
 * failed. A caller re-enqueuing is asserting "this is owed", not "try again", and
 * silently resurrecting a terminal delivery would resend a receipt somebody
 * already has.
 */
export async function enqueueEmailDelivery(
  input: EnqueueEmailInput,
  deps: OutboundEmailDeps = {},
): Promise<{ delivery: OutboundEmailDeliveryRecord; created: boolean }> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoOutboundEmailIdProvider;

  const dedupeKey = outboundEmailDeliveryKey({
    purpose: input.purpose,
    recipientParticipantId: input.recipientParticipantId,
    subjectKind: input.subjectKind,
    subjectRef: input.subjectRef,
    discriminator: input.discriminator,
  });

  try {
    const row = await db.outboundEmailDelivery.create({
      data: {
        id: ids.nextOutboundDeliveryId(),
        dedupeKey,
        purpose: input.purpose,
        obligationId: input.obligationId,
        audience: input.audience,
        recipientParticipantId: input.recipientParticipantId,
        subjectKind: input.subjectKind,
        subjectRef: input.subjectRef,
        status: "PENDING",
        attemptCount: 0,
        /* Due immediately. A dispatcher run that follows the commit picks it up;
           nothing here decides when a dispatcher runs. */
        nextAttemptAt: new Date(input.now),
        createdAt: new Date(input.now),
      },
    });
    return { delivery: outboundDeliveryRowToRecord(row), created: true };
  } catch (error) {
    if (isUniqueViolation(error)) {
      /* Somebody already committed to this exact message. Theirs stands. */
      const existing = await db.outboundEmailDelivery.findUnique({ where: { dedupeKey } });
      if (existing !== null) {
        return { delivery: outboundDeliveryRowToRecord(existing), created: false };
      }
    }
    throw new OutboundEmailPersistenceFailureError("enqueueEmailDelivery", error);
  }
}

// — Claim —

export interface ClaimedDelivery {
  delivery: OutboundEmailDeliveryRecord;
  /** Must be presented to resolve. Never emitted by the mapper or a read. */
  lockToken: string;
}

/**
 * Claim up to `limit` due deliveries for this worker.
 *
 * One guarded `updateMany` stamps a lock token onto every eligible row, then the
 * rows carrying that token are read back. Two workers running concurrently issue
 * two different tokens, and a row can only carry one — so **no row is ever
 * claimed twice**, and the read-back cannot see somebody else's work.
 *
 * Eligibility is re-asserted inside the update rather than checked first: a
 * select-then-update would let a second worker slip between the two.
 */
export async function claimDueEmailDeliveries(
  input: {
    now: string;
    limit: number;
    /**
     * Restrict the claim to these deliveries.
     *
     * Used by the enqueue-then-send-now path, so committing a receipt and
     * attempting it immediately does not also drain somebody else's backlog
     * inside a webhook that has a payment provider waiting on it.
     */
    only?: readonly string[];
  },
  deps: OutboundEmailDeps = {},
): Promise<ClaimedDelivery[]> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoOutboundEmailIdProvider;
  const lockToken = ids.nextLockToken();
  const now = new Date(input.now);
  const leaseExpiresAt = new Date(now.getTime() + EMAIL_RETRY_POLICY.claimLeaseSeconds * 1_000);

  try {
    /* Prisma has no `updateMany ... LIMIT`, so eligibility is narrowed by an
       explicit id list read immediately before. The UPDATE re-asserts every
       condition, so a row that stopped being eligible in between matches zero
       rows and is simply not claimed — the select is a hint, never the guard. */
    const candidates = await db.outboundEmailDelivery.findMany({
      where: {
        status: { in: [...CLAIMABLE_DELIVERY_STATUSES] },
        nextAttemptAt: { lte: now },
        ...(input.only === undefined ? {} : { id: { in: [...input.only] } }),
      },
      orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
      take: Math.max(0, input.limit),
      select: { id: true },
    });
    if (candidates.length === 0) return [];

    await db.outboundEmailDelivery.updateMany({
      where: {
        id: { in: candidates.map((c) => c.id) },
        status: { in: [...CLAIMABLE_DELIVERY_STATUSES] },
        nextAttemptAt: { lte: now },
        lockToken: null,
      },
      data: { status: "IN_PROGRESS", lockToken, lockedAt: now, leaseExpiresAt },
    });

    const claimed = await db.outboundEmailDelivery.findMany({
      where: { lockToken },
      orderBy: [{ nextAttemptAt: "asc" }, { id: "asc" }],
    });
    return claimed.map((row) => ({
      delivery: outboundDeliveryRowToRecord(row),
      lockToken,
    }));
  } catch (error) {
    throw new OutboundEmailPersistenceFailureError("claimDueEmailDeliveries", error);
  }
}

/**
 * Return deliveries whose worker died, and **count the attempt**.
 *
 * A live claim is never touched — this is lease *expiry*, not lock stealing, the
 * same distinction `PublicationOutbox` draws. Counting the attempt is the honest
 * accounting: the send may well have reached the provider, and a recovery that
 * did not count it would retry a delivered receipt for the full policy.
 */
export async function recoverStaleEmailClaims(
  input: { now: string; limit: number },
  deps: OutboundEmailDeps = {},
): Promise<number> {
  const db = deps.db ?? getPrisma();
  const now = new Date(input.now);

  const stale = await db.outboundEmailDelivery.findMany({
    where: { status: "IN_PROGRESS", leaseExpiresAt: { lte: now } },
    orderBy: [{ leaseExpiresAt: "asc" }, { id: "asc" }],
    take: Math.max(0, input.limit),
    select: { id: true, attemptCount: true, lockToken: true },
  });

  let recovered = 0;
  for (const row of stale) {
    const attemptCount = row.attemptCount + 1;
    const retryAt = computeNextAttemptAt({ attemptCount, failedAt: input.now });
    const result = await db.outboundEmailDelivery.updateMany({
      /* The exact token observed during selection: a claim renewed in between is
         a live claim and must not be recovered. */
      where: { id: row.id, status: "IN_PROGRESS", lockToken: row.lockToken, leaseExpiresAt: { lte: now } },
      data:
        retryAt === null
          ? {
              status: "PERMANENTLY_FAILED",
              attemptCount,
              nextAttemptAt: null,
              lockToken: null,
              lockedAt: null,
              leaseExpiresAt: null,
              lastFailureCode: "UNSPECIFIED_FAILURE",
              lastFailureClass: "TRANSIENT",
              finalizedAt: now,
            }
          : {
              status: "RETRY_PENDING",
              attemptCount,
              nextAttemptAt: new Date(retryAt),
              lockToken: null,
              lockedAt: null,
              leaseExpiresAt: null,
              lastFailureCode: "UNSPECIFIED_FAILURE",
              lastFailureClass: "TRANSIENT",
            },
    });
    recovered += result.count;
  }
  return recovered;
}

// — Resolve —

export interface DeliveryResolution {
  outcomeClass: SendOutcomeClass;
  provider: string;
  providerMessageRef: string | null;
  failureCode: DeliveryFailureCode | null;
  destinationDigest: string | null;
  at: string;
}

/**
 * Record what one attempt did, and decide what happens next.
 *
 * The whole retry decision lives here, in one place, driven by the normalised
 * outcome class and the bounded policy — never by a provider's response and never
 * by a number written at a call site.
 *
 * The update re-asserts the lock token. A worker whose lease expired mid-send
 * finds zero rows and raises `DeliveryClaimConflictError` rather than overwriting
 * a row somebody else now holds.
 */
export async function resolveEmailDelivery(
  input: { deliveryId: string; lockToken: string; resolution: DeliveryResolution },
  deps: OutboundEmailDeps = {},
): Promise<OutboundEmailDeliveryRecord> {
  const db = deps.db ?? getPrisma();
  const { resolution } = input;
  const at = new Date(resolution.at);

  const current = await db.outboundEmailDelivery.findUnique({
    where: { id: input.deliveryId },
    select: { attemptCount: true },
  });
  if (current === null) throw new DeliveryClaimConflictError();
  const attemptCount = current.attemptCount + 1;

  const common = {
    attemptCount,
    provider: resolution.provider,
    lockToken: null,
    lockedAt: null,
    leaseExpiresAt: null,
    ...(resolution.destinationDigest === null
      ? {}
      : { destinationDigest: resolution.destinationDigest }),
  };

  let data: Prisma.OutboundEmailDeliveryUpdateManyMutationInput;
  if (resolution.outcomeClass === "ACCEPTED") {
    data = {
      ...common,
      status: "DELIVERED",
      nextAttemptAt: null,
      providerMessageRef: resolution.providerMessageRef,
      lastFailureCode: null,
      lastFailureClass: "ACCEPTED",
      sentAt: at,
      finalizedAt: at,
    };
  } else {
    /* A permanent failure never schedules another attempt, whatever the counter
       says: retrying a rejected or suppressed address is how a sender's
       reputation dies. */
    const retryAt =
      resolution.outcomeClass === "PERMANENT"
        ? null
        : computeNextAttemptAt({ attemptCount, failedAt: resolution.at });
    data = {
      ...common,
      status: retryAt === null ? "PERMANENTLY_FAILED" : "RETRY_PENDING",
      nextAttemptAt: retryAt === null ? null : new Date(retryAt),
      lastFailureCode: resolution.failureCode,
      lastFailureClass: resolution.outcomeClass,
      ...(retryAt === null ? { finalizedAt: at } : {}),
    };
  }

  try {
    const updated = await db.outboundEmailDelivery.updateMany({
      where: { id: input.deliveryId, status: "IN_PROGRESS", lockToken: input.lockToken },
      data,
    });
    if (updated.count !== 1) throw new DeliveryClaimConflictError();
  } catch (error) {
    if (error instanceof DeliveryClaimConflictError) throw error;
    throw new OutboundEmailPersistenceFailureError("resolveEmailDelivery", error);
  }

  const row = await db.outboundEmailDelivery.findUniqueOrThrow({
    where: { id: input.deliveryId },
  });
  return outboundDeliveryRowToRecord(row);
}

// — Reads —

/**
 * The delivery evidence a future admin or support surface needs.
 *
 * Answers, for one subject: was it scheduled, delivered, retrying, or
 * permanently failed; what did the provider call it; and what was the last
 * normalised reason. It returns **no address and no body**, because neither is
 * stored — a support agent can be told a message to the buyer's recorded address
 * permanently failed without being handed the address to read.
 */
export async function listEmailDeliveriesForSubject(
  subject: { kind: OutboundEmailSubjectKind; ref: string },
  deps: OutboundEmailDeps = {},
): Promise<OutboundEmailDeliveryRecord[]> {
  const db = deps.db ?? getPrisma();
  const rows = await db.outboundEmailDelivery.findMany({
    where: { subjectKind: subject.kind, subjectRef: subject.ref },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return rows.map(outboundDeliveryRowToRecord);
}

export async function getEmailDelivery(
  deliveryId: string,
  deps: OutboundEmailDeps = {},
): Promise<OutboundEmailDeliveryRecord | null> {
  const db = deps.db ?? getPrisma();
  const row = await db.outboundEmailDelivery.findUnique({ where: { id: deliveryId } });
  return row === null ? null : outboundDeliveryRowToRecord(row);
}

/** How many deliveries stand in each status. The operator's one-line health read. */
export async function summarizeEmailDeliveries(
  deps: OutboundEmailDeps = {},
): Promise<Record<OutboundDeliveryStatus, number>> {
  const db = deps.db ?? getPrisma();
  const grouped = await db.outboundEmailDelivery.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const summary: Record<string, number> = {
    PENDING: 0,
    IN_PROGRESS: 0,
    DELIVERED: 0,
    RETRY_PENDING: 0,
    PERMANENTLY_FAILED: 0,
  };
  for (const row of grouped) summary[row.status] = row._count._all;
  return summary as Record<OutboundDeliveryStatus, number>;
}

/** Shared read, usable inside and outside a transaction. */
export async function countEmailDeliveriesIn(
  tx: Tx,
  subject: { kind: OutboundEmailSubjectKind; ref: string },
): Promise<number> {
  return tx.outboundEmailDelivery.count({
    where: { subjectKind: subject.kind, subjectRef: subject.ref },
  });
}
