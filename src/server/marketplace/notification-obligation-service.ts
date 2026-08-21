/**
 * Notification obligation service (Phase 0M.N1) — SERVER ONLY.
 *
 * Records **that Monacado owes a notice**, and nothing about sending one. There
 * is no channel here, no address, no template, no transport, no queue, and no
 * retry: `0M.N2` owns delivery, and this phase is deliberately complete without
 * it.
 *
 * Five properties shape everything below:
 *
 *   1. **Deduplication is a database guarantee.** Every write computes
 *      `notificationObligationKey` from the tuple and the unique index enforces
 *      it, so "one notice per promoter × exact Offer source version × change
 *      category" cannot be violated by a caller who forgot — or by two callers
 *      racing on the same governed event.
 *
 *   2. **Recording an Offer change is idempotent.** Replaying one governed change
 *      returns the obligations that already exist rather than failing or
 *      duplicating. A notification pipeline that could not be safely re-run
 *      would be one nobody dares re-run.
 *
 *   3. **Recipients are derived, never supplied.** The affected promoters come
 *      from persisted promoted Listings bound to the exact prior Offer version. A
 *      caller naming its own recipient list could miss a promoter, and missing one
 *      is the failure this obligation exists to prevent.
 *
 *   4. **The classifier is reused, never restated.** The caller passes exactly
 *      what `classifyOfferBusinessChanges` returned. A notice that disagreed with
 *      the committed classification about what changed would be worse than no
 *      notice, and no Offer economics are recomputed here at all.
 *
 *   5. **Nothing reads a clock, generates randomness directly, or touches
 *      `process.env`.** Instants, identities, and the database are injected.
 *
 * No route, no UI, no delivery. No Order, payment, payout, tax, or ledger record
 * is created or read.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  AdvanceNotificationObligationInput,
  CreateNotificationObligationInput,
  INITIAL_NOTIFICATION_OBLIGATION_STATUS,
  RecordOfferChangeObligationsInput,
  isValidNotificationObligationTransition,
  notificationObligationKey,
  type NotificationObligationRecord,
  type NotificationObligationStatus,
} from "../../contracts/marketplace/notification-obligation";
import { getPrisma } from "../db/client";
import { cryptoParticipantIdProvider, type ParticipantIdProvider } from "./participant-ids";
import {
  CorruptObligationRecordError,
  DuplicateObligationError,
  InvalidObligationInputError,
  InvalidObligationTransitionError,
  ObligationNotFoundError,
  ObligationPersistenceFailureError,
  OfferVersionNotFoundError,
  RecipientParticipantNotFoundError,
} from "./notification-obligation-errors";
import { obligationRowToRecord } from "./notification-obligation-mapper";

type Db = ReturnType<typeof getPrisma>;

export interface ObligationServiceDeps {
  db?: Db;
  ids?: ParticipantIdProvider;
}

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

const isUniqueViolation = (error: unknown): boolean => prismaCode(error) === "P2002";
const isForeignKeyViolation = (error: unknown): boolean => prismaCode(error) === "P2003";

function isDomainError(error: unknown): boolean {
  return (
    error instanceof ObligationNotFoundError ||
    error instanceof InvalidObligationTransitionError ||
    error instanceof RecipientParticipantNotFoundError ||
    error instanceof OfferVersionNotFoundError ||
    error instanceof CorruptObligationRecordError
  );
}

function inputError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): InvalidObligationInputError {
  return new InvalidObligationInputError(
    Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))),
  );
}

/**
 * Record one obligation.
 *
 * The general entry point, and the one `0M.9` will use for its own categories.
 * Created `UNREAD` and at no other status — the input has no `status` parameter,
 * so a caller cannot record an obligation as already handled.
 *
 * Refuses a duplicate rather than absorbing it: a caller reaching this path
 * directly asked for a *new* obligation, and quietly returning an old one would
 * hide that the event had already been recorded. The Offer-change path, which
 * models a replayable governed event, takes the opposite view deliberately.
 */
export async function createNotificationObligation(
  input: unknown,
  deps: ObligationServiceDeps = {},
): Promise<NotificationObligationRecord> {
  const parsed = CreateNotificationObligationInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { recipientParticipantId, category, subject, contextCode, createdAt } = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoParticipantIdProvider;

  try {
    const row = await db.notificationObligation.create({
      data: obligationData({
        id: ids.nextObligationId(),
        recipientParticipantId,
        category,
        subject,
        contextCode,
        createdAt,
      }),
    });
    return obligationRowToRecord(row);
  } catch (error) {
    if (isDomainError(error)) throw error;
    if (isUniqueViolation(error)) throw new DuplicateObligationError(error);
    if (isForeignKeyViolation(error)) throw new RecipientParticipantNotFoundError(error);
    throw new ObligationPersistenceFailureError("createNotificationObligation", error);
  }
}

/**
 * Record every obligation one governed Offer change creates.
 *
 * The rule `AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md` §3a already governs, made
 * executable. Three steps, one transaction:
 *
 *   1. **Confirm the effective Offer version exists.** An obligation binds to an
 *      exact version, and a notice about a version nobody can look up is not a
 *      notice.
 *   2. **Resolve affected promoters from persisted Listings** bound to the
 *      *prior* version — the promoters actually carrying the terms that moved.
 *      Distinct participants, so a promoter carrying the Offer in five
 *      storefronts is one recipient rather than five.
 *   3. **Record one obligation per (promoter × effective version × category)**,
 *      skipping any that already exists.
 *
 * The notice is **about** the effective version and **for** whoever holds the
 * prior one — those are different versions on purpose, and conflating them would
 * either notify nobody or notify about the wrong thing.
 *
 * **Idempotent.** Replaying the same governed change returns the same
 * obligations. Nothing is updated on replay either: an obligation the promoter
 * has already acknowledged does not silently return to `UNREAD`.
 */
export async function recordOfferChangeObligations(
  input: unknown,
  deps: ObligationServiceDeps = {},
): Promise<NotificationObligationRecord[]> {
  const parsed = RecordOfferChangeObligationsInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const {
    offerSourceRecordId,
    effectiveOfferSourceRecordVersion,
    priorOfferSourceRecordVersion,
    changeCategories,
    createdAt,
  } = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoParticipantIdProvider;

  try {
    return await db.$transaction(async (tx) => {
      const effective = await tx.offerSourceRecordVersionRow.findUnique({
        where: {
          offerSourceRecordId_sourceRecordVersion: {
            offerSourceRecordId,
            sourceRecordVersion: effectiveOfferSourceRecordVersion,
          },
        },
      });
      if (effective === null) throw new OfferVersionNotFoundError();

      const promoters = await affectedPromotersInTx(
        tx,
        offerSourceRecordId,
        priorOfferSourceRecordVersion,
      );

      const recorded: NotificationObligationRecord[] = [];
      for (const recipientParticipantId of promoters) {
        for (const contextCode of changeCategories) {
          recorded.push(
            await upsertObligationInTx(tx, {
              id: ids.nextObligationId(),
              recipientParticipantId,
              category: "OFFER_CHANGE",
              subject: {
                kind: "OFFER",
                ref: offerSourceRecordId,
                versionRef: effectiveOfferSourceRecordVersion,
              },
              contextCode,
              createdAt,
            }),
          );
        }
      }
      return recorded;
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new ObligationPersistenceFailureError("recordOfferChangeObligations", error);
  }
}

export async function getNotificationObligation(
  obligationId: string,
  deps: ObligationServiceDeps = {},
): Promise<NotificationObligationRecord> {
  const db = deps.db ?? getPrisma();
  try {
    const row = await db.notificationObligation.findUnique({ where: { id: obligationId } });
    if (row === null) throw new ObligationNotFoundError();
    return obligationRowToRecord(row);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new ObligationPersistenceFailureError("getNotificationObligation", error);
  }
}

/**
 * Every obligation owed to one participant, newest first.
 *
 * `statuses` narrows to a working set — the admin panel's unread/acknowledged
 * view — while the default returns the full history, archived rows included.
 * There is no "delete the old ones" operation: an obligation is evidence of a
 * governed event.
 */
export async function listParticipantObligations(
  recipientParticipantId: string,
  options: { statuses?: readonly NotificationObligationStatus[] } = {},
  deps: ObligationServiceDeps = {},
): Promise<NotificationObligationRecord[]> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.notificationObligation.findMany({
      where: {
        recipientParticipantId,
        ...(options.statuses !== undefined ? { status: { in: [...options.statuses] } } : {}),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    return rows.map(obligationRowToRecord);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new ObligationPersistenceFailureError("listParticipantObligations", error);
  }
}

/**
 * Move one obligation forward.
 *
 * The single lifecycle write, so every transition passes the same bounded table
 * and stamps the instant belonging to the state it reached. `acknowledge`,
 * `resolve`, and `archive` are thin named wrappers over it rather than three
 * paths that could drift.
 *
 * **Nothing is deleted, and no earlier instant is cleared.** An obligation that
 * was acknowledged and then resolved keeps both instants, so the record says
 * what actually happened rather than only where it ended up.
 */
export async function advanceNotificationObligation(
  input: unknown,
  deps: ObligationServiceDeps = {},
): Promise<NotificationObligationRecord> {
  const parsed = AdvanceNotificationObligationInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { obligationId, to, at } = parsed.data;

  const db = deps.db ?? getPrisma();
  const instant = new Date(at);

  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.notificationObligation.findUnique({ where: { id: obligationId } });
      if (row === null) throw new ObligationNotFoundError();

      const from = row.status as NotificationObligationStatus;
      if (!isValidNotificationObligationTransition(from, to)) {
        throw new InvalidObligationTransitionError(from, to);
      }

      const updated = await tx.notificationObligation.update({
        where: { id: obligationId },
        data: {
          status: to,
          ...(to === "ACKNOWLEDGED" ? { acknowledgedAt: instant } : {}),
          ...(to === "RESOLVED" ? { resolvedAt: instant } : {}),
          ...(to === "ARCHIVED" ? { archivedAt: instant } : {}),
        },
      });
      return obligationRowToRecord(updated);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new ObligationPersistenceFailureError("advanceNotificationObligation", error);
  }
}

export const acknowledgeNotificationObligation = (
  obligationId: string,
  at: string,
  deps: ObligationServiceDeps = {},
): Promise<NotificationObligationRecord> =>
  advanceNotificationObligation({ obligationId, to: "ACKNOWLEDGED", at }, deps);

export const resolveNotificationObligation = (
  obligationId: string,
  at: string,
  deps: ObligationServiceDeps = {},
): Promise<NotificationObligationRecord> =>
  advanceNotificationObligation({ obligationId, to: "RESOLVED", at }, deps);

export const archiveNotificationObligation = (
  obligationId: string,
  at: string,
  deps: ObligationServiceDeps = {},
): Promise<NotificationObligationRecord> =>
  advanceNotificationObligation({ obligationId, to: "ARCHIVED", at }, deps);

// — Internals —

interface ObligationFields {
  id: string;
  recipientParticipantId: string;
  category: Parameters<typeof notificationObligationKey>[0]["category"];
  subject: Parameters<typeof notificationObligationKey>[0]["subject"];
  contextCode: Parameters<typeof notificationObligationKey>[0]["contextCode"];
  createdAt: string;
}

/** The row shape, with the derived deduplication key computed once. */
function obligationData(fields: ObligationFields) {
  return {
    id: fields.id,
    recipientParticipantId: fields.recipientParticipantId,
    category: fields.category,
    subjectKind: fields.subject.kind,
    subjectRef: fields.subject.ref,
    subjectVersionRef: fields.subject.versionRef,
    contextCode: fields.contextCode,
    status: INITIAL_NOTIFICATION_OBLIGATION_STATUS,
    createdAt: new Date(fields.createdAt),
    obligationKey: notificationObligationKey({
      recipientParticipantId: fields.recipientParticipantId,
      category: fields.category,
      subject: fields.subject,
      contextCode: fields.contextCode,
    }),
  };
}

/**
 * Record an obligation, or return the one that already satisfies it.
 *
 * Read-then-write is safe here because the unique index is the real guarantee:
 * if two callers race past the read, one create fails and this re-reads the
 * winner rather than surfacing a conflict for a governed event that is simply
 * already recorded.
 *
 * **Exported for `0M.9`**, which must write sale obligations inside the same
 * transaction that records the sale — a seller told about a sale that rolled
 * back, or a sale nobody was told about, are both worse than one insert more in
 * the transaction. It takes a `Prisma.TransactionClient` precisely so a caller
 * cannot use it to write outside one by accident.
 */
export async function upsertObligationInTx(
  tx: Prisma.TransactionClient,
  fields: ObligationFields,
): Promise<NotificationObligationRecord> {
  const data = obligationData(fields);

  const existing = await tx.notificationObligation.findUnique({
    where: { obligationKey: data.obligationKey },
  });
  if (existing !== null) return obligationRowToRecord(existing);

  try {
    return obligationRowToRecord(await tx.notificationObligation.create({ data }));
  } catch (error) {
    if (isUniqueViolation(error)) {
      const winner = await tx.notificationObligation.findUnique({
        where: { obligationKey: data.obligationKey },
      });
      if (winner !== null) return obligationRowToRecord(winner);
    }
    if (isForeignKeyViolation(error)) throw new RecipientParticipantNotFoundError(error);
    throw error;
  }
}

/**
 * The distinct promoter participants carrying an exact Offer source version.
 *
 * Read from persisted promoted Listing source versions, and **distinct** because
 * §3a's rule is one notice per promoter, not per Listing or per storefront: a
 * promoter carrying the same Offer in five storefronts has one thing to decide.
 *
 * Only the version rows a Listing currently points at count. A Listing that has
 * since moved to a newer Offer version has already answered for this one, and
 * notifying its promoter again would be a notice about a decision they made.
 */
async function affectedPromotersInTx(
  tx: Prisma.TransactionClient,
  offerSourceRecordId: string,
  offerSourceRecordVersion: string,
): Promise<string[]> {
  const rows = await tx.listingSourceRecordVersionRow.findMany({
    where: {
      acceptedOfferSourceRecordId: offerSourceRecordId,
      acceptedOfferSourceRecordVersion: offerSourceRecordVersion,
      listing: { is: { currentSourceRecordVersion: { not: undefined } } },
    },
    select: {
      controllingParticipantId: true,
      sourceRecordVersion: true,
      listing: { select: { currentSourceRecordVersion: true } },
    },
    orderBy: { controllingParticipantId: "asc" },
  });

  const promoters = new Set<string>();
  for (const row of rows) {
    if (row.sourceRecordVersion !== row.listing.currentSourceRecordVersion) continue;
    promoters.add(row.controllingParticipantId);
  }
  return Array.from(promoters).sort();
}
