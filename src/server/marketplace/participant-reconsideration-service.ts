/**
 * Reconsideration of a governed decision (Phase 1.14) — SERVER ONLY.
 *
 * A participant asks Monacado to look again at one decision about them.
 *
 * ## Reconsideration, never appeal
 *
 * There is no external body, no arbitration, no independent panel, and no
 * deadline, so the record is named for what it is. Marketplace Policy 1.3.0 is
 * worded to match, and says so in terms: "This is a reconsideration by Monacado
 * staff. It is not an appeal to anybody outside Monacado." The only structural
 * independence Monacado can honestly offer is that the decider is not the
 * participant, and the self-action refusal below is that guarantee rather than a
 * claim about impartiality nothing enforces.
 *
 * ## Why this is not a `ParticipantRiskReview`
 *
 * Reusing an existing governed record was the preferred outcome and it does not
 * fit. That record requires a report coordinate — a NOT NULL composite key into a
 * review-heuristics version plus a `triggerAsOf` — because the coordinate IS its
 * meaning: it regenerates the ranking a reviewer saw. A participant contesting an
 * eligibility restriction was never in any ranking, and supplying a coordinate
 * would fabricate one. Its `openForParticipantId` unique marker would also make a
 * live risk review and a filed reconsideration mutually exclusive, which is a
 * functional collision rather than a stylistic one. And its trigger-reason child
 * requires an observed value, a sample size, and a window, none of which a ground
 * like "the provider requirement is now resolved" has.
 *
 * ## Bounded input, and the cost of it is stated
 *
 * Grounds and remediation are closed vocabularies. There is no narrative field,
 * no attachment, and no document reference, because this repository bans free
 * text near participants by name and has nowhere to put a document. A participant
 * with a genuinely novel circumstance reaches
 * `CIRCUMSTANCE_NOT_COVERED_BY_THESE_CODES`, which is a real loss and a deliberate
 * one: it makes vocabulary inadequacy countable, so the remedy is a reviewable
 * extension rather than a text box nobody governs.
 *
 * ## Deciding is the imposing authority
 *
 * A determination of `DECISION_LIFTED_ON_RECONSIDERATION` *is* a lift, so it is
 * gated on the entitlement the lift already requires — `participant:restrict` for
 * a restriction, `participant:suspend` for a suspension. Reconsideration is not a
 * side door around either.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  DecideReconsiderationInput,
  RequestReconsiderationInput,
  isValidReconsiderationTransition,
  type ReconsiderationDetermination,
  type ReconsiderationStatus,
} from "../../contracts/marketplace/participant-mitigation";
import {
  canRestrictParticipant,
  canSuspendParticipant,
  isInternallyAuthorized,
} from "../../contracts/account/internal-authorization";
import { resolveInternalAuthorizationSubject } from "../account/internal-authorization-service";
import { getPrisma } from "../db/client";
import { recordParticipantDecisionNoticeInTx } from "./participant-mitigation-notice";
import {
  ParticipantMitigationRequestError,
  ReconsiderationNotAvailableError,
  ReconsiderationNotFoundError,
  ReconsiderationTransitionError,
  SuspensionActorNotAuthorizedError,
  SuspensionSelfActionNotPermittedError,
} from "./participant-mitigation-errors";
import {
  cryptoParticipantMitigationIdProvider,
  type ParticipantMitigationIdProvider,
} from "./participant-ids";

type Db = ReturnType<typeof getPrisma>;

export interface ReconsiderationServiceDeps {
  db?: Db;
  ids?: ParticipantMitigationIdProvider;
}

export interface ReconsiderationSnapshot {
  reconsiderationId: string;
  participantId: string;
  restrictionId: string | null;
  suspensionId: string | null;
  groundCode: string;
  remediationClaimCode: string | null;
  status: ReconsiderationStatus;
  determinationCode: ReconsiderationDetermination | null;
  decidedByAccountId: string | null;
  decidedAt: string | null;
  requestedAt: string;
}

function toSnapshot(row: {
  id: string;
  participantId: string;
  restrictionId: string | null;
  suspensionId: string | null;
  groundCode: string;
  remediationClaimCode: string | null;
  status: string;
  determinationCode: string | null;
  decidedByAccountId: string | null;
  decidedAt: Date | null;
  requestedAt: Date;
}): ReconsiderationSnapshot {
  return {
    reconsiderationId: row.id,
    participantId: row.participantId,
    restrictionId: row.restrictionId,
    suspensionId: row.suspensionId,
    groundCode: row.groundCode,
    remediationClaimCode: row.remediationClaimCode,
    status: row.status as ReconsiderationStatus,
    determinationCode: row.determinationCode as ReconsiderationDetermination | null,
    decidedByAccountId: row.decidedByAccountId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    requestedAt: row.requestedAt.toISOString(),
  };
}

/**
 * File a reconsideration against one standing decision.
 *
 * Refused where there is nothing to contest: a decision already lifted, or one
 * that has already been reconsidered. Bounding it by COUNT rather than by KIND is
 * deliberate — a carve-out excluding some reason codes would be an
 * unreviewable-discretion clause the policy would then have to describe.
 */
export async function requestReconsideration(
  input: unknown,
  deps: ReconsiderationServiceDeps = {},
): Promise<ReconsiderationSnapshot> {
  const parsed = RequestReconsiderationInput.safeParse(input);
  if (!parsed.success) {
    throw new ParticipantMitigationRequestError("Invalid reconsideration request");
  }
  const d = parsed.data;
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoParticipantMitigationIdProvider;
  const decisionId = d.restrictionId ?? d.suspensionId!;

  return db.$transaction(async (tx) => {
    /* — The requester must BE the participant (Phase 1.15). —
     *
     * The invariant the schema already states of `requestedByAccountId` — "the
     * account that asked — the participant's own, never a Staff account" — and
     * which nothing enforced. Knowing a participant id was sufficient to file.
     *
     * That mattered because reconsideration is ONE-SHOT per decision: an
     * unrelated account filing first would permanently consume the participant's
     * only opportunity to contest a restriction or suspension, and no lift could
     * afterwards be asked for. A denial of remedy rather than an escalation, and
     * the more serious for being silent.
     *
     * `MarketplaceParticipant.accountId` is the authoritative relationship and is
     * `@unique`, so this is the repository's existing one-account-one-participant
     * model rather than a second notion of ownership. Nothing here consults a
     * Staff entitlement: `participant:restrict` and `participant:suspend`
     * authorize DECIDING a reconsideration, and letting either stand in for the
     * participant's own request would be exactly the substitution the schema
     * comment rules out.
     *
     * CHECKED FIRST, before any decision is read, and refused as NOT FOUND — the
     * same answer a wrong-participant target already gets below. An unauthorized
     * caller therefore learns nothing: not whether the participant exists, not
     * whether a restriction or suspension stands, and not what it says. */
    const participant = await tx.marketplaceParticipant.findUnique({
      where: { id: d.participantId },
      select: { accountId: true },
    });
    if (participant === null || participant.accountId !== d.requestedByAccountId) {
      throw new ReconsiderationNotFoundError();
    }

    /* The decision must exist, belong to this participant, and still stand. */
    if (d.restrictionId !== null) {
      const restriction = await tx.participantRestriction.findUnique({
        where: { id: d.restrictionId },
        select: { participantId: true, status: true },
      });
      if (restriction === null || restriction.participantId !== d.participantId) {
        throw new ReconsiderationNotFoundError();
      }
      if (restriction.status !== "ACTIVE") {
        throw new ReconsiderationNotAvailableError("DECISION_NO_LONGER_STANDS");
      }
    } else {
      const suspension = await tx.participantSuspension.findUnique({
        where: { id: d.suspensionId! },
        select: { participantId: true, status: true },
      });
      if (suspension === null || suspension.participantId !== d.participantId) {
        throw new ReconsiderationNotFoundError();
      }
      if (suspension.status !== "ACTIVE") {
        throw new ReconsiderationNotAvailableError("DECISION_NO_LONGER_STANDS");
      }
    }

    /* Once decided, a decision is not reconsidered twice. A NEW adverse decision
       carries its own fresh reconsideration, which falls out of 0M.R1's rule that
       re-imposing is a new row rather than needing a rule of its own. */
    const already = await tx.participantReconsideration.findFirst({
      where: d.restrictionId !== null
        ? { restrictionId: d.restrictionId }
        : { suspensionId: d.suspensionId! },
      select: { id: true },
    });
    if (already !== null) {
      throw new ReconsiderationNotAvailableError("ALREADY_RECONSIDERED");
    }

    const created = await tx.participantReconsideration.create({
      data: {
        id: ids.nextReconsiderationId(),
        participantId: d.participantId,
        restrictionId: d.restrictionId,
        suspensionId: d.suspensionId,
        requestedByAccountId: d.requestedByAccountId,
        requestedAt: new Date(d.requestedAt),
        groundCode: d.groundCode,
        remediationClaimCode: d.remediationClaimCode,
        status: "RECEIVED",
        openForDecisionId: decisionId,
      },
    });
    return toSnapshot(created);
  });
}

/**
 * Record Monacado's determination.
 *
 * Authorized on the entitlement the underlying decision's LIFT requires, because
 * a determination that lifts is a lift. The self-action refusal is the only
 * independence claim the policy makes, so it is enforced here from the persisted
 * `MarketplaceParticipant.accountId` rather than from anything a caller supplies.
 *
 * **This records a determination; it does not perform the lift.** Lifting remains
 * its own governed act with its own actor and instant, so "we decided to reverse
 * it" and "it was reversed" stay two events rather than one row doing both.
 */
export async function decideReconsideration(
  input: unknown,
  deps: ReconsiderationServiceDeps = {},
): Promise<ReconsiderationSnapshot> {
  const parsed = DecideReconsiderationInput.safeParse(input);
  if (!parsed.success) {
    throw new ParticipantMitigationRequestError("Invalid reconsideration determination");
  }
  const { reconsiderationId, determinationCode, actingAccountId, decidedAt } = parsed.data;
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoParticipantMitigationIdProvider;
  const obligationId = ids.nextObligationId();

  return db.$transaction(async (tx) => {
    const existing = await tx.participantReconsideration.findUnique({
      where: { id: reconsiderationId },
    });
    if (existing === null) throw new ReconsiderationNotFoundError();

    await assertDeciderAuthority(tx, actingAccountId, existing.suspensionId !== null);

    const participant = await tx.marketplaceParticipant.findUniqueOrThrow({
      where: { id: existing.participantId },
      select: { accountId: true },
    });
    if (participant.accountId === actingAccountId) {
      throw new SuspensionSelfActionNotPermittedError();
    }

    if (!isValidReconsiderationTransition(existing.status as ReconsiderationStatus, "DECIDED")) {
      throw new ReconsiderationTransitionError(
        `A reconsideration at ${existing.status} cannot be decided`,
      );
    }

    const updated = await tx.participantReconsideration.update({
      where: { id: reconsiderationId },
      data: {
        status: "DECIDED",
        determinationCode,
        decidedByAccountId: actingAccountId,
        decidedAt: new Date(decidedAt),
        /* Released: the decision has been reconsidered, and a further request is
           refused by the count check rather than by this marker. */
        openForDecisionId: null,
      },
    });

    await recordParticipantDecisionNoticeInTx(tx, {
      participantId: existing.participantId,
      decisionId: reconsiderationId,
      contextCode: "RECONSIDERATION_DECIDED",
      obligationId,
      at: decidedAt,
    });

    return toSnapshot(updated);
  });
}

/** Assign a reviewer and move to `UNDER_REVIEW`. */
export async function assignReconsideration(
  input: { reconsiderationId: string; reviewerAccountId: string; actingAccountId: string },
  deps: ReconsiderationServiceDeps = {},
): Promise<ReconsiderationSnapshot> {
  const db = deps.db ?? getPrisma();
  return db.$transaction(async (tx) => {
    const existing = await tx.participantReconsideration.findUnique({
      where: { id: input.reconsiderationId },
      select: { status: true, suspensionId: true },
    });
    if (existing === null) throw new ReconsiderationNotFoundError();
    await assertDeciderAuthority(tx, input.actingAccountId, existing.suspensionId !== null);
    if (
      !isValidReconsiderationTransition(existing.status as ReconsiderationStatus, "UNDER_REVIEW")
    ) {
      throw new ReconsiderationTransitionError(
        `A reconsideration at ${existing.status} cannot move to UNDER_REVIEW`,
      );
    }
    const updated = await tx.participantReconsideration.update({
      where: { id: input.reconsiderationId },
      data: { status: "UNDER_REVIEW", assignedReviewerAccountId: input.reviewerAccountId },
    });
    return toSnapshot(updated);
  });
}

export async function readParticipantReconsiderations(
  participantId: string,
  deps: ReconsiderationServiceDeps = {},
): Promise<ReconsiderationSnapshot[]> {
  const db = deps.db ?? getPrisma();
  const rows = await db.participantReconsideration.findMany({
    where: { participantId },
    orderBy: { requestedAt: "desc" },
  });
  return rows.map(toSnapshot);
}

/**
 * The entitlement a determination requires, chosen by what is being contested.
 *
 * A determination that lifts a suspension is a reinstatement, so it needs
 * `participant:suspend`; one that lifts a restriction needs
 * `participant:restrict`. Neither grant reaches the other's decisions.
 */
async function assertDeciderAuthority(
  tx: Prisma.TransactionClient,
  actingAccountId: string,
  contestsSuspension: boolean,
): Promise<void> {
  const actor = await resolveInternalAuthorizationSubject(actingAccountId, {
    db: tx as unknown as Db,
  });
  const decision = contestsSuspension
    ? canSuspendParticipant(actor)
    : canRestrictParticipant(actor);
  if (!isInternallyAuthorized(decision)) {
    throw new SuspensionActorNotAuthorizedError([...decision.reasonCodes]);
  }
}
