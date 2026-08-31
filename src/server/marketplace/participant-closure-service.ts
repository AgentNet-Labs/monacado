/**
 * Participant closure — the governed terminal lifecycle act (Phase 1.17) —
 * SERVER ONLY.
 *
 * ## What this replaces
 *
 * `advanceParticipantStatus` used to be able to reach `CLOSED`. Its phase gate
 * checks only the TARGET status, and `CLOSED` sat in
 * `DRAFT_WRITABLE_PARTICIPANT_STATUSES` on 0M.5's ground that "closing a draft
 * that was never activated needs no activation decision". True of a draft; not
 * true of that function, because the 0M.1 table reaches `CLOSED` from `ACTIVE`,
 * `RESTRICTED`, `SUSPENDED`, and `UNDER_REVIEW` too. So the member admitted for
 * the narrow case authorised the wide one, and the single irreversible act in
 * this subsystem was also the only one with no actor, no authorization, no
 * reason, and no record — while restricting, suspending, reinstating, lifting,
 * and deciding a reconsideration all carried four disciplines each.
 *
 * ## Whose act it is, and why there is no Staff closure
 *
 * Closure is the participant's own decision to stop. The repository has ruled
 * this three times and implemented it none: 0M.5's justification above, 0M.8's
 * refusal to close on a `REJECTED` activation ("inventing a closure on
 * Monacado's behalf would end an admission the participant may legitimately
 * resubmit"), and 1.14's statement that a suspension "is not a deletion, a
 * closure, or a release from anything already owed".
 *
 * Marketplace Policy 1.3.0 governs restriction and suspension in detail and
 * nowhere gives Monacado power to end a participant's participation. A
 * `participant:close` entitlement would therefore be an authority strictly wider
 * than `participant:suspend` — irreversible where suspension is reversible —
 * created by this service rather than by any term Monacado has published. It is
 * not created. **If Monacado ever needs to end a participation itself, that
 * needs terms first, and then its own capability; it is not reachable here.**
 *
 * So authorization is OWNERSHIP, not entitlement: the acting account must BE the
 * participant's account. Checked against the persisted
 * `MarketplaceParticipant.accountId` — `@unique`, therefore the repository's
 * existing one-account-one-participant relation and not a second notion of
 * ownership — and never from anything the caller asserts. This is verbatim the
 * check `requestReconsideration` makes for the participant's own act, refused
 * the same way and for the same reason.
 *
 * ## What closure does not do
 *
 * It does not lift a restriction, reinstate a suspension, cancel a pending
 * reconsideration, delete an identity, revoke a role, touch an Order, rewrite an
 * accepted policy version, or discharge an obligation in either direction.
 * `CLOSURE_PRESERVES` and `CLOSURE_LEAVES_MITIGATION_STANDING` state that as
 * checkable values rather than as prose nothing verifies.
 *
 * Mitigation rows keep `status: "ACTIVE"`, which is the true statement: the
 * decision stood when participation ended and was never withdrawn. Marking them
 * `LIFTED` would have meant choosing a lift reason from a vocabulary in which
 * every member is a false statement about a closure, and naming an account as
 * having lifted something nobody lifted — so a person's departure would have
 * laundered a decision that still stands.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  CloseParticipantInput,
  isTerminalParticipantStatus,
  permitsClosure,
  type ParticipantClosureReasonCode,
} from "../../contracts/marketplace/participant-closure";
import { isValidParticipantTransition } from "../../contracts/marketplace/lifecycle";
import type { ParticipantStatus } from "../../contracts/marketplace/participant";
import { getPrisma } from "../db/client";
import { recordParticipantDecisionNoticeInTx } from "./participant-mitigation-notice";
import {
  ParticipantAlreadyClosedError,
  ParticipantClosureNotFoundError,
  ParticipantClosurePersistenceFailureError,
  ParticipantClosureRequestError,
  ParticipantLifecycleTerminatedError,
} from "./participant-closure-errors";
import {
  cryptoParticipantClosureIdProvider,
  type ParticipantClosureIdProvider,
} from "./participant-ids";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export interface ClosureServiceDeps {
  db?: Db;
  ids?: ParticipantClosureIdProvider;
}

export interface ParticipantClosureSnapshot {
  closureId: string;
  participantId: string;
  closedByAccountId: string;
  reasonCode: ParticipantClosureReasonCode;
  statusBeforeClosure: ParticipantStatus;
  closedAt: string;
}

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

const isUniqueViolation = (error: unknown): boolean => prismaCode(error) === "P2002";

function isDomainError(error: unknown): boolean {
  return (
    error instanceof ParticipantClosureNotFoundError ||
    error instanceof ParticipantAlreadyClosedError ||
    error instanceof ParticipantClosureRequestError ||
    error instanceof ParticipantLifecycleTerminatedError
  );
}

/**
 * Close a participant, on their own authority.
 *
 * One transaction, because a closure with no notice owed, and a notice for a
 * closure that rolled back, are both worse than one insert more — the reason
 * `upsertObligationInTx` is exported at all.
 *
 * The status write is guarded by the committed 0M.1 table rather than assumed.
 * Every non-terminal status lists `CLOSED` among its targets today, so the guard
 * is presently total; it is still checked, because a lifecycle table this
 * service does not own is exactly the thing that should not be assumed.
 */
export async function closeParticipant(
  input: unknown,
  deps: ClosureServiceDeps = {},
): Promise<ParticipantClosureSnapshot> {
  const parsed = CloseParticipantInput.safeParse(input);
  if (!parsed.success) {
    throw new ParticipantClosureRequestError("Invalid closure request");
  }
  const { participantId, actingAccountId, reasonCode, closedAt } = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoParticipantClosureIdProvider;
  const closureId = ids.nextClosureId();
  const obligationId = ids.nextObligationId();
  const at = new Date(closedAt);

  try {
    return await db.$transaction(async (tx) => {
      /* — The closer must BE the participant. —
       *
       * Read first, before anything else is learned, and refused as NOT FOUND —
       * the same answer a non-existent participant gets. An unauthorized caller
       * therefore learns nothing: not whether the participant exists, not what
       * status it holds, and not whether a decision stands against it.
       *
       * Nothing here consults a Staff entitlement, and that is the ruling rather
       * than an omission. There is no internal capability that closes a
       * participant, because no published term gives Monacado that power. */
      const participant = await tx.marketplaceParticipant.findUnique({
        where: { id: participantId },
        select: { accountId: true, status: true },
      });
      if (participant === null || participant.accountId !== actingAccountId) {
        throw new ParticipantClosureNotFoundError();
      }

      const from = participant.status as ParticipantStatus;
      if (!permitsClosure(from)) throw new ParticipantAlreadyClosedError();
      if (!isValidParticipantTransition(from, "CLOSED")) {
        /* Unreachable against today's table — every non-terminal status lists
           CLOSED among its targets — and checked anyway, because a lifecycle
           table this service does not own is exactly the thing not to assume. */
        throw new ParticipantAlreadyClosedError();
      }

      await tx.participantClosure.create({
        data: {
          id: closureId,
          participantId,
          closedByAccountId: actingAccountId,
          reasonCode,
          statusBeforeClosure: from,
          closedAt: at,
        },
      });

      await tx.marketplaceParticipant.update({
        where: { id: participantId },
        data: { status: "CLOSED" },
      });

      /* NOTHING ELSE IS TOUCHED. No restriction is lifted, no suspension is
         reinstated, no reconsideration is cancelled, no role is revoked, and no
         Order, receipt, entitlement, obligation, or accepted policy version is
         written. A participant leaving is not Monacado deciding anything about
         them, and it discharges nothing either party already owes. */

      await recordParticipantDecisionNoticeInTx(tx, {
        participantId,
        /* The CLOSURE, never the participant — the obligation key hashes the
           subject, and using the participant would collide with any other
           standing notice sharing a context code. */
        decisionId: closureId,
        contextCode: "PARTICIPANT_CLOSED",
        obligationId,
        at: closedAt,
      });

      return {
        closureId,
        participantId,
        closedByAccountId: actingAccountId,
        reasonCode,
        statusBeforeClosure: from,
        closedAt: at.toISOString(),
      };
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    /* The unique `participantId` is the database's own answer to a concurrent
       second closure; it is the same refusal, reached by contention. */
    if (isUniqueViolation(error)) throw new ParticipantAlreadyClosedError();
    throw new ParticipantClosurePersistenceFailureError("closeParticipant", error);
  }
}

/**
 * Refuse unless this participant's lifecycle is still live.
 *
 * **A terminal-lifecycle precondition, deliberately NOT part of
 * `readParticipantStanding`.** Phase 1.15 forbids the standing service from
 * reading `MarketplaceParticipant`, and that ban is right: status is DERIVED
 * from the mitigation rows, so a seam that read it back would answer a
 * scope-exact question with the coarsest fact available, and would be reasoning
 * in a circle.
 *
 * `CLOSED` is categorically different, which is why this is a separate function
 * rather than a relaxation of that rule. **No mitigation act can produce it** —
 * `reconcileParticipantStatusForRestrictions` never returns it and
 * `reinstatementTargetStatus` cannot manufacture it — so it is an INDEPENDENT
 * authoritative fact rather than a projection of the rows. Consulting it is not
 * the circularity the ban prohibits, and the standing service keeps its
 * guarantee untouched.
 *
 * FUTURE ACTIVITY ONLY, on `assertPartiesMayTransact`'s terms. This is called
 * before new state exists. It never reaches a completed sale, a refund, a
 * dispute, a tax correction, or a recorded obligation: Monacado remains merchant
 * of record for everything already sold, and still owes what those sales earned.
 */
export async function assertParticipantLifecycleIsLive(
  tx: Tx,
  participantId: string,
): Promise<void> {
  const row = await tx.marketplaceParticipant.findUnique({
    where: { id: participantId },
    select: { status: true },
  });
  /* A missing participant is not this function's refusal to make — the caller
     that resolved the id owns that answer, and inventing one here would turn a
     lookup failure into a lifecycle claim. */
  if (row === null) return;
  if (isTerminalParticipantStatus(row.status as ParticipantStatus)) {
    throw new ParticipantLifecycleTerminatedError();
  }
}

/** Read one participant's closure record, if they have closed. */
export async function readParticipantClosure(
  participantId: string,
  deps: ClosureServiceDeps = {},
): Promise<ParticipantClosureSnapshot | null> {
  const db = deps.db ?? getPrisma();
  const row = await db.participantClosure.findUnique({ where: { participantId } });
  if (row === null) return null;
  return {
    closureId: row.id,
    participantId: row.participantId,
    closedByAccountId: row.closedByAccountId,
    reasonCode: row.reasonCode as ParticipantClosureReasonCode,
    statusBeforeClosure: row.statusBeforeClosure as ParticipantStatus,
    closedAt: row.closedAt.toISOString(),
  };
}
