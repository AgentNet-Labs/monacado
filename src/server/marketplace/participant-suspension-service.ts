/**
 * Governed participant suspension and reinstatement (Phase 1.14) — SERVER ONLY.
 *
 * The second thing in this codebase permitted to write `MarketplaceParticipant.
 * status`, and the first permitted to write `SUSPENDED`.
 *
 * ## Why writing it is now allowed, when 0M.8 refused
 *
 * That refusal named its own discharge condition: "the status has no
 * machine-readable content to write … a restriction nobody can enumerate is
 * indistinguishable from a suspension." 0M.R1 discharged it for `RESTRICTED` by
 * giving that status an enumerable evidence row. `ParticipantSuspension` does the
 * same here, and the difference between the two statuses is real and already
 * enforced elsewhere: `DRAFTING_PARTICIPANT_STATUSES` contains `RESTRICTED` and
 * not `SUSPENDED`, so a restriction withholds commerce while leaving the
 * participant able to correct the work that caused it, and a suspension withholds
 * that too. A suspension is therefore not a restriction with a louder name.
 *
 * ## Order of checks, and the order is the point
 *
 *   1. **The terms.** The ACTIVE Marketplace Policy version must authorise acting
 *      on a participant at all. Checked first because an act nobody is permitted
 *      to take should not proceed far enough to read a target.
 *   2. **Authorization** from persisted entitlement state, before any participant
 *      row is read — an unauthorized caller learns nothing about the target, not
 *      even whether it exists.
 *   3. **Self-action**, from the persisted `MarketplaceParticipant.accountId`
 *      foreign key. Nothing is inferred from an email, a name, or a caller claim.
 *   4. The evidence row and the status change, in one transaction.
 *
 * **Emergency waives step 1's prior review, never step 2.** A suspension may be
 * imposed without a completed risk review where waiting would expose buyers or
 * Monacado to loss; the entitlement check is identical either way, and the record
 * says which basis it had by whether it names a review.
 *
 * ## Nothing here is automatic, and nothing here is irreversible
 *
 * No threshold, score, disposition, or report reaches this module. A
 * `SUSPENSION_RECOMMENDED` disposition is a conclusion a person recorded; this is
 * a separate act by a separately-entitled person. And every suspension has its
 * undo built in the same phase, by the same grant — an authority that could start
 * an adverse action but not end it would be worse than none.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  ReinstateParticipantInput,
  SuspendParticipantInput,
  reinstatementTargetStatus,
} from "../../contracts/marketplace/participant-mitigation";
import {
  canSuspendParticipant,
  isInternallyAuthorized,
} from "../../contracts/account/internal-authorization";
import type { ParticipantStatus } from "../../contracts/marketplace/participant";
import { resolveInternalAuthorizationSubject } from "../account/internal-authorization-service";
import { getPrisma } from "../db/client";
import { ParticipantNotFoundError } from "./participant-errors";
import { assertParticipantMitigationAuthorizedInTx } from "./participant-mitigation-policy";
import { recordParticipantDecisionNoticeInTx } from "./participant-mitigation-notice";
import {
  ParticipantAlreadySuspendedError,
  ParticipantMitigationRequestError,
  SuspensionActorNotAuthorizedError,
  SuspensionAlreadyLiftedError,
  SuspensionNotFoundError,
  SuspensionSelfActionNotPermittedError,
} from "./participant-mitigation-errors";
import {
  cryptoParticipantMitigationIdProvider,
  type ParticipantMitigationIdProvider,
} from "./participant-ids";

type Db = ReturnType<typeof getPrisma>;

export interface SuspensionServiceDeps {
  db?: Db;
  ids?: ParticipantMitigationIdProvider;
}

export interface SuspensionSnapshot {
  suspensionId: string;
  participantId: string;
  status: "ACTIVE" | "LIFTED";
  reasonCode: string;
  imposedAt: string;
  imposedByAccountId: string;
  liftedAt: string | null;
  liftedByAccountId: string | null;
  liftedReasonCode: string | null;
  riskReviewId: string | null;
  marketplacePolicyVersion: string;
  participantStatus: ParticipantStatus;
}

function inputError(error: unknown): ParticipantMitigationRequestError {
  return new ParticipantMitigationRequestError(
    error instanceof Error ? "Invalid mitigation input" : "Invalid mitigation input",
  );
}

/** Authorization from persisted entitlement state, before any target is read. */
async function assertSuspensionAuthority(
  tx: Prisma.TransactionClient,
  actingAccountId: string,
): Promise<void> {
  const actor = await resolveInternalAuthorizationSubject(actingAccountId, {
    db: tx as unknown as Db,
  });
  const decision = canSuspendParticipant(actor);
  if (!isInternallyAuthorized(decision)) {
    throw new SuspensionActorNotAuthorizedError([...decision.reasonCodes]);
  }
}

async function snapshot(
  tx: Prisma.TransactionClient,
  suspensionId: string,
): Promise<SuspensionSnapshot> {
  const row = await tx.participantSuspension.findUnique({ where: { id: suspensionId } });
  if (row === null) throw new SuspensionNotFoundError();
  const participant = await tx.marketplaceParticipant.findUniqueOrThrow({
    where: { id: row.participantId },
    select: { status: true },
  });
  return {
    suspensionId: row.id,
    participantId: row.participantId,
    status: row.status as "ACTIVE" | "LIFTED",
    reasonCode: row.reasonCode,
    imposedAt: row.imposedAt.toISOString(),
    imposedByAccountId: row.imposedByAccountId,
    liftedAt: row.liftedAt?.toISOString() ?? null,
    liftedByAccountId: row.liftedByAccountId,
    liftedReasonCode: row.liftedReasonCode,
    riskReviewId: row.riskReviewId,
    marketplacePolicyVersion: row.marketplacePolicyVersion,
    participantStatus: participant.status as ParticipantStatus,
  };
}

/**
 * Suspend a participant.
 *
 * The status move is guarded twice: the 0M.1 transition table must permit it, and
 * the evidence row must exist in the same transaction that writes the status —
 * so a participant is never `SUSPENDED` without a record saying why, which is the
 * whole condition 0M.8 refused to write without.
 *
 * A participant whose status the table forbids moving still RECEIVES the
 * suspension row. That mirrors how a restriction behaves for a non-`ACTIVE`
 * participant: the decision is real evidence even where the lifecycle has nowhere
 * to move it, and inventing a transition would be a lifecycle change made inside
 * a mitigation phase.
 */
export async function suspendParticipant(
  input: unknown,
  deps: SuspensionServiceDeps = {},
): Promise<SuspensionSnapshot> {
  const parsed = SuspendParticipantInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { participantId, reasonCode, actingAccountId, suspendedAt, riskReviewId } = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoParticipantMitigationIdProvider;
  const suspensionId = ids.nextSuspensionId();
  const obligationId = ids.nextObligationId();
  const at = new Date(suspendedAt);

  try {
    return await db.$transaction(async (tx) => {
      const governing = await assertParticipantMitigationAuthorizedInTx(tx);
      await assertSuspensionAuthority(tx, actingAccountId);

      const participant = await tx.marketplaceParticipant.findUnique({
        where: { id: participantId },
      });
      if (participant === null) throw new ParticipantNotFoundError();
      if (participant.accountId === actingAccountId) {
        throw new SuspensionSelfActionNotPermittedError();
      }
      if (participant.status === "SUSPENDED" || participant.status === "CLOSED") {
        /* CLOSED is terminal, and an already-suspended participant is caught by
           the unique marker below; both are refusals rather than second rows. */
        throw new ParticipantAlreadySuspendedError();
      }

      await tx.participantSuspension.create({
        data: {
          id: suspensionId,
          participantId,
          reasonCode,
          status: "ACTIVE",
          statusBeforeSuspension: participant.status,
          imposedAt: at,
          imposedByAccountId: actingAccountId,
          riskReviewId,
          marketplacePolicyId: governing.policyId,
          marketplacePolicyVersion: governing.policyVersion,
          /* Claims the unique marker while ACTIVE. */
          activeForParticipantId: participantId,
        },
      });

      /* The status move, guarded by the committed 0M.1 table. A status this
         phase cannot legally reach is left alone; the evidence row stands. */
      const { isValidParticipantTransition } = await import(
        "../../contracts/marketplace/lifecycle"
      );
      if (isValidParticipantTransition(participant.status as ParticipantStatus, "SUSPENDED")) {
        await tx.marketplaceParticipant.update({
          where: { id: participantId },
          data: { status: "SUSPENDED" },
        });
      }

      await recordParticipantDecisionNoticeInTx(tx, {
        participantId,
        decisionId: suspensionId,
        contextCode: "SUSPENSION_IMPOSED",
        obligationId,
        at: suspendedAt,
      });

      return await snapshot(tx, suspensionId);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new ParticipantAlreadySuspendedError();
    throw error;
  }
}

/**
 * Reinstate a suspended participant.
 *
 * RECONCILES RATHER THAN ASSUMES. A participant with restrictions still standing
 * returns to `RESTRICTED`, not to the status they held before the suspension —
 * otherwise reinstatement would leave somebody at `ACTIVE` holding active
 * restrictions, the exact divergence 0M.R1's invariant exists to prevent.
 *
 * The original imposition is never rewritten. The claim is `updateMany` by id AND
 * by the still-active marker, so a concurrent reinstatement updates zero rows
 * rather than overwriting the first one's actor and reason. `imposedAt`,
 * `imposedByAccountId`, and `reasonCode` appear in no `data` clause in this file.
 */
export async function reinstateParticipant(
  input: unknown,
  deps: SuspensionServiceDeps = {},
): Promise<SuspensionSnapshot> {
  const parsed = ReinstateParticipantInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { suspensionId, reasonCode, actingAccountId, reinstatedAt } = parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoParticipantMitigationIdProvider;
  const obligationId = ids.nextObligationId();
  const at = new Date(reinstatedAt);

  return db.$transaction(async (tx) => {
    /* Reinstatement is the undo of an act the terms authorised; it is checked on
       the same footing so a deployment cannot end up able to suspend but not to
       reverse it. */
    await assertParticipantMitigationAuthorizedInTx(tx);
    await assertSuspensionAuthority(tx, actingAccountId);

    const existing = await tx.participantSuspension.findUnique({
      where: { id: suspensionId },
      select: { participantId: true, statusBeforeSuspension: true },
    });
    if (existing === null) throw new SuspensionNotFoundError();

    const participant = await tx.marketplaceParticipant.findUniqueOrThrow({
      where: { id: existing.participantId },
    });
    if (participant.accountId === actingAccountId) {
      throw new SuspensionSelfActionNotPermittedError();
    }

    const claimed = await tx.participantSuspension.updateMany({
      where: { id: suspensionId, status: "ACTIVE" },
      data: {
        status: "LIFTED",
        liftedAt: at,
        liftedByAccountId: actingAccountId,
        liftedReasonCode: reasonCode,
        /* Released, so the participant may be suspended again later — as a NEW
           row with its own instant and actor, never a resurrection of this one. */
        activeForParticipantId: null,
      },
    });
    if (claimed.count !== 1) throw new SuspensionAlreadyLiftedError();

    const activeRestrictionCount = await tx.participantRestriction.count({
      where: { participantId: existing.participantId, status: "ACTIVE" },
    });
    const target = reinstatementTargetStatus({
      currentStatus: participant.status as ParticipantStatus,
      activeRestrictionCount,
      statusBeforeSuspension: existing.statusBeforeSuspension as ParticipantStatus,
    });
    if (target !== null) {
      await tx.marketplaceParticipant.update({
        where: { id: existing.participantId },
        data: { status: target },
      });
    }

    await recordParticipantDecisionNoticeInTx(tx, {
      participantId: existing.participantId,
      decisionId: suspensionId,
      contextCode: "SUSPENSION_LIFTED",
      obligationId,
      at: reinstatedAt,
    });

    return await snapshot(tx, suspensionId);
  });
}

/** Full suspension history, newest first. Lifted suspensions remain. */
export async function getParticipantSuspensionHistory(
  participantId: string,
  deps: SuspensionServiceDeps = {},
): Promise<SuspensionSnapshot[]> {
  const db = deps.db ?? getPrisma();
  const rows = await db.participantSuspension.findMany({
    where: { participantId },
    orderBy: { imposedAt: "desc" },
  });
  const participant = await db.marketplaceParticipant.findUniqueOrThrow({
    where: { id: participantId },
    select: { status: true },
  });
  return rows.map((row) => ({
    suspensionId: row.id,
    participantId: row.participantId,
    status: row.status as "ACTIVE" | "LIFTED",
    reasonCode: row.reasonCode,
    imposedAt: row.imposedAt.toISOString(),
    imposedByAccountId: row.imposedByAccountId,
    liftedAt: row.liftedAt?.toISOString() ?? null,
    liftedByAccountId: row.liftedByAccountId,
    liftedReasonCode: row.liftedReasonCode,
    riskReviewId: row.riskReviewId,
    marketplacePolicyVersion: row.marketplacePolicyVersion,
    participantStatus: participant.status as ParticipantStatus,
  }));
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && error.code === "P2002"
  );
}
