/**
 * Governed participant-restriction service (Phase 0M.R1) — SERVER ONLY.
 *
 * The service 0M.8 pointed at. Its activation review refuses `RESTRICTED` behind
 * `RestrictionScopeNotAvailableInPhaseError` because "nothing in the repository
 * yet expresses **which** capability is withheld". This writes that evidence, and
 * is the **only** thing in the codebase that may write the status.
 *
 * Seven properties shape everything below:
 *
 *   1. **A restriction is a separate governed act, not an activation outcome.**
 *      The committed `ACTIVATION_DECISIONS` vocabulary is exactly `APPROVED`,
 *      `MORE_INFORMATION_REQUIRED`, `REJECTED` — there is no restricting
 *      decision, and inventing one purely to make `RESTRICTED` reachable would
 *      change the meaning of an activation review to solve a routing problem. So
 *      0M.8's review is **untouched** and restriction lives here.
 *
 *   2. **Status and evidence move together, or neither does.** The restriction
 *      row and the participant status are written in one transaction, so
 *      `RESTRICTED` can never exist without an active restriction to justify it
 *      — the invariant 0M.8 could not express.
 *
 *   3. **Authority is the persisted `participant:restrict` entitlement**, read
 *      from the database on every call. Not `activation:review`, which authorizes
 *      deciding one admission and would be silently widened; not a marketplace
 *      role; not ownership; not a caller assertion, for which there is no field.
 *
 *   4. **Separation of duties**, extending 0M.8's rule: an actor may not impose
 *      or lift a restriction on the participant its own account owns.
 *
 *   5. **Provider state creates nothing here.** A provider reporting `DISABLED`
 *      or `DETAILS_REQUIRED` is an external observation on
 *      `ParticipantPaymentAccount`. Turning one into a restriction is a Monacado
 *      decision an operator makes, with an actor and a reason — this service has
 *      no path that reads provider state at all.
 *
 *   6. **History is never destroyed.** Lifting is a state change with its own
 *      instant, actor, and reason. Nothing here deletes a restriction.
 *
 *   7. **This is not a risk engine.** No score, reserve, cap, velocity window,
 *      hold, or transaction reference is read or written. `0M.R2` owns all of it.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  ImposeParticipantRestrictionInput,
  INITIAL_RESTRICTION_STATUS,
  LiftParticipantRestrictionInput,
  reconcileParticipantStatusForRestrictions,
  restrictedStatusIsSupported,
  type ParticipantRestrictionRecord,
} from "../../contracts/marketplace/participant-restriction";
import {
  canRestrictParticipant,
  isInternallyAuthorized,
} from "../../contracts/account/internal-authorization";
import { isValidParticipantTransition } from "../../contracts/marketplace/lifecycle";
import type { ParticipantStatus } from "../../contracts/marketplace/participant";
import { getPrisma } from "../db/client";
import { assertParticipantMitigationAuthorizedInTx } from "./participant-mitigation-policy";
import { ParticipantMitigationNotAuthorizedByPolicyError } from "./participant-mitigation-errors";
import { recordParticipantDecisionNoticeInTx } from "./participant-mitigation-notice";
import {
  cryptoParticipantMitigationIdProvider,
  type ParticipantMitigationIdProvider,
} from "./participant-ids";
import { RISK_DERIVED_RESTRICTION_REASON_CODES } from "../../contracts/marketplace/participant-restriction";
import { resolveInternalAuthorizationSubject } from "../account/internal-authorization-service";
import { cryptoParticipantIdProvider, type ParticipantIdProvider } from "./participant-ids";
import { ParticipantNotFoundError } from "./participant-errors";
import {
  CorruptRestrictionRecordError,
  DuplicateActiveRestrictionError,
  InvalidRestrictionInputError,
  RestrictionActorNotAuthorizedError,
  RestrictionAlreadyLiftedError,
  RestrictionNotFoundError,
  RestrictionPersistenceFailureError,
  RestrictionSelfActionNotPermittedError,
} from "./participant-restriction-errors";
import { restrictionRowToRecord } from "./participant-restriction-mapper";

type Db = ReturnType<typeof getPrisma>;

export interface RestrictionServiceDeps {
  /** Phase 1.14 — identity for the notice obligation raised with each decision. */
  mitigationIds?: ParticipantMitigationIdProvider;
  db?: Db;
  ids?: ParticipantIdProvider;
}

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};

const isUniqueViolation = (error: unknown): boolean => prismaCode(error) === "P2002";

function isDomainError(error: unknown): boolean {
  return (
    error instanceof ParticipantNotFoundError ||
    error instanceof RestrictionNotFoundError ||
    error instanceof RestrictionAlreadyLiftedError ||
    error instanceof RestrictionActorNotAuthorizedError ||
    error instanceof RestrictionSelfActionNotPermittedError ||
    error instanceof CorruptRestrictionRecordError ||
    /* Phase 1.14. A governance refusal is a domain answer, not a storage
       failure. Without this the catch-all below would rewrap "the active terms
       do not authorise this" as `RestrictionPersistenceFailureError`, and an
       operator would go looking at the database for a problem that is in the
       policy. */
    error instanceof ParticipantMitigationNotAuthorizedByPolicyError
  );
}

function inputError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): InvalidRestrictionInputError {
  return new InvalidRestrictionInputError(
    Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))),
  );
}

export interface RestrictionSnapshot {
  restriction: ParticipantRestrictionRecord;
  /** The participant's status after reconciliation. */
  participantStatus: ParticipantStatus;
  activeRestrictionCount: number;
}

/**
 * Impose one governed restriction.
 *
 * Order of checks, and the order is the point — it mirrors 0M.8's exactly:
 *
 *   1. **Authorization** from persisted entitlement state, before any
 *      participant state is read. An unauthorized caller learns nothing about
 *      the target, not even whether it exists.
 *   2. **Self-action**, from the persisted `MarketplaceParticipant.accountId`
 *      foreign key, before any restriction is looked up. Nothing is inferred
 *      from an email, a name, a caller claim, or an identifier prefix.
 *   3. The restriction row and any status change, in one transaction.
 *
 * A participant not at `ACTIVE` still receives the restriction row — a policy
 * problem found during onboarding is real evidence — but its status does not
 * move, because the 0M.1 table defines no transition to `RESTRICTED` from
 * anywhere except `ACTIVE`. Inventing one would be a lifecycle change made
 * inside a risk phase.
 */
export async function imposeParticipantRestriction(
  input: unknown,
  deps: RestrictionServiceDeps = {},
): Promise<RestrictionSnapshot> {
  const parsed = ImposeParticipantRestrictionInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { participantId, scope, reasonCode, actingAccountId, imposedAt, riskReviewId } =
    parsed.data;

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoParticipantIdProvider;
  const at = new Date(imposedAt);
  const restrictionId = ids.nextRestrictionId();

  await assertRestrictionAuthority(db, actingAccountId);

  const obligationId = (deps.mitigationIds ?? cryptoParticipantMitigationIdProvider)
    .nextObligationId();

  try {
    return await db.$transaction(async (tx) => {
      /* Phase 1.14 — the terms have to authorise acting on a PARTICIPANT before
         a risk-derived restriction may be imposed at all.
         
         Scoped to risk-derived grounds deliberately. `participant:restrict`
         predates participant-level risk terms and is governed as an operational
         authority: withholding commerce because underwriting is incomplete, or
         because a provider requirement is outstanding, was always within
         Monacado's operational remit and 1.13's recorded gap does not reach it.
         What needed new terms was restricting somebody BECAUSE OF WHAT THE RISK
         ANALYTICS SAID, and that is exactly the set gated here. */
      const risky = (RISK_DERIVED_RESTRICTION_REASON_CODES as readonly string[]).includes(
        reasonCode,
      );
      const governing = risky ? await assertParticipantMitigationAuthorizedInTx(tx) : null;

      const participant = await tx.marketplaceParticipant.findUnique({
        where: { id: participantId },
      });
      if (participant === null) throw new ParticipantNotFoundError();
      if (participant.accountId === actingAccountId) {
        throw new RestrictionSelfActionNotPermittedError();
      }

      await tx.participantRestriction.create({
        data: {
          id: restrictionId,
          participantId,
          scope,
          reasonCode,
          status: INITIAL_RESTRICTION_STATUS,
          imposedAt: at,
          imposedByAccountId: actingAccountId,
          // Set while ACTIVE and NULL once lifted: the unique index on
          // (participantId, activeForScope) is what enforces at most one active
          // restriction per scope, since MySQL has no partial indexes.
          activeForScope: scope,
          /* The consequence names its basis (Phase 1.14). Neither column is read
             to decide anything; both exist so an appeal can be answered. */
          riskReviewId,
          marketplacePolicyId: governing?.policyId ?? null,
          marketplacePolicyVersion: governing?.policyVersion ?? null,
        },
      });

      await reconcileStatusInTx(tx, participantId, participant.status as ParticipantStatus);

      /* One insert more in the same transaction, for the reason 0M.9 gave: a
         participant restricted with no notice owed, and a notice for a
         restriction that rolled back, are both worse than this. */
      await recordParticipantDecisionNoticeInTx(tx, {
        participantId,
        decisionId: restrictionId,
        contextCode: "RESTRICTION_IMPOSED",
        obligationId,
        at: imposedAt,
      });

      return await readSnapshotInTx(tx, participantId, restrictionId);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    if (isUniqueViolation(error)) throw new DuplicateActiveRestrictionError(error);
    throw new RestrictionPersistenceFailureError("imposeParticipantRestriction", error);
  }
}

/**
 * Lift one restriction.
 *
 * A state change, never a delete: `liftedAt`, `liftedByAccountId`, and
 * `liftedReasonCode` are recorded alongside the original imposition, so the
 * history reads as what actually happened.
 *
 * **Lifting one of several changes no status.** The reconciliation counts what
 * remains, so a participant with two active restrictions stays `RESTRICTED`
 * after the first is lifted — and only the last one returning the count to zero
 * restores `ACTIVE`.
 */
export async function liftParticipantRestriction(
  input: unknown,
  deps: RestrictionServiceDeps = {},
): Promise<RestrictionSnapshot> {
  const parsed = LiftParticipantRestrictionInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const { restrictionId, reasonCode, actingAccountId, liftedAt } = parsed.data;

  const db = deps.db ?? getPrisma();
  const at = new Date(liftedAt);
  const liftObligationId = (deps.mitigationIds ?? cryptoParticipantMitigationIdProvider)
    .nextObligationId();

  await assertRestrictionAuthority(db, actingAccountId);

  try {
    return await db.$transaction(async (tx) => {
      const row = await tx.participantRestriction.findUnique({ where: { id: restrictionId } });
      if (row === null) throw new RestrictionNotFoundError();

      const participant = await tx.marketplaceParticipant.findUnique({
        where: { id: row.participantId },
      });
      if (participant === null) throw new ParticipantNotFoundError();
      if (participant.accountId === actingAccountId) {
        throw new RestrictionSelfActionNotPermittedError();
      }

      // Claim by id AND by the still-active marker, so a concurrent lift updates
      // zero rows rather than overwriting the first one's actor and reason.
      const claimed = await tx.participantRestriction.updateMany({
        where: { id: restrictionId, status: "ACTIVE" },
        data: {
          status: "LIFTED",
          liftedAt: at,
          liftedByAccountId: actingAccountId,
          liftedReasonCode: reasonCode,
          activeForScope: null,
        },
      });
      if (claimed.count !== 1) throw new RestrictionAlreadyLiftedError();

      await reconcileStatusInTx(tx, row.participantId, participant.status as ParticipantStatus);

      /* A participant told commerce stopped is told when it resumes. A distinct
         context code, so the two obligations key differently and the second is
         never collapsed into the first. */
      await recordParticipantDecisionNoticeInTx(tx, {
        participantId: row.participantId,
        decisionId: restrictionId,
        contextCode: "RESTRICTION_LIFTED",
        obligationId: liftObligationId,
        at: liftedAt,
      });

      return await readSnapshotInTx(tx, row.participantId, restrictionId);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new RestrictionPersistenceFailureError("liftParticipantRestriction", error);
  }
}

/** Every currently active restriction on one participant. */
export async function listActiveParticipantRestrictions(
  participantId: string,
  deps: RestrictionServiceDeps = {},
): Promise<ParticipantRestrictionRecord[]> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.participantRestriction.findMany({
      where: { participantId, status: "ACTIVE" },
      orderBy: [{ imposedAt: "asc" }, { id: "asc" }],
    });
    return rows.map(restrictionRowToRecord);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new RestrictionPersistenceFailureError("listActiveParticipantRestrictions", error);
  }
}

/** Full restriction history, newest first. Lifted restrictions remain. */
export async function getParticipantRestrictionHistory(
  participantId: string,
  deps: RestrictionServiceDeps = {},
): Promise<ParticipantRestrictionRecord[]> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.participantRestriction.findMany({
      where: { participantId },
      orderBy: [{ imposedAt: "desc" }, { id: "desc" }],
    });
    return rows.map(restrictionRowToRecord);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new RestrictionPersistenceFailureError("getParticipantRestrictionHistory", error);
  }
}

/** Does this participant carry any active restriction? A read, never a decision. */
export async function hasActiveRestrictions(
  participantId: string,
  deps: RestrictionServiceDeps = {},
): Promise<boolean> {
  const db = deps.db ?? getPrisma();
  try {
    return (await db.participantRestriction.count({
      where: { participantId, status: "ACTIVE" },
    })) > 0;
  } catch (error) {
    throw new RestrictionPersistenceFailureError("hasActiveRestrictions", error);
  }
}

// — Internals —

/**
 * Authorization, resolved from persisted entitlements and checked before any
 * participant or restriction query runs.
 */
async function assertRestrictionAuthority(db: Db, actingAccountId: string): Promise<void> {
  const actor = await resolveInternalAuthorizationSubject(actingAccountId, { db });
  const decision = canRestrictParticipant(actor);
  if (!isInternallyAuthorized(decision)) {
    throw new RestrictionActorNotAuthorizedError([...decision.reasonCodes]);
  }
}

/**
 * Move the participant's status to match its active restriction count, if the
 * deterministic rule says one is warranted.
 *
 * Two guards, both structural:
 *
 *   - the target must be permitted by the 0M.1 transition table, so this phase
 *     cannot reach a status the lifecycle forbids;
 *   - `RESTRICTED` is additionally refused unless active evidence exists, which
 *     is the invariant this whole phase exists to establish. Belt and braces on
 *     purpose: the count that decided the transition and the count that
 *     validates it are read in the same transaction, so they cannot diverge.
 */
async function reconcileStatusInTx(
  tx: Prisma.TransactionClient,
  participantId: string,
  currentStatus: ParticipantStatus,
): Promise<void> {
  const activeRestrictionCount = await tx.participantRestriction.count({
    where: { participantId, status: "ACTIVE" },
  });

  const next = reconcileParticipantStatusForRestrictions({
    currentStatus,
    activeRestrictionCount,
  });
  if (next === null || next === currentStatus) return;
  if (!isValidParticipantTransition(currentStatus, next)) return;
  if (next === "RESTRICTED" && !restrictedStatusIsSupported(activeRestrictionCount)) return;

  await tx.marketplaceParticipant.update({
    where: { id: participantId },
    data: { status: next },
  });
}

async function readSnapshotInTx(
  tx: Prisma.TransactionClient,
  participantId: string,
  restrictionId: string,
): Promise<RestrictionSnapshot> {
  const row = await tx.participantRestriction.findUnique({ where: { id: restrictionId } });
  if (row === null) throw new RestrictionNotFoundError();

  const participant = await tx.marketplaceParticipant.findUnique({ where: { id: participantId } });
  if (participant === null) throw new ParticipantNotFoundError();

  const activeRestrictionCount = await tx.participantRestriction.count({
    where: { participantId, status: "ACTIVE" },
  });

  return {
    restriction: restrictionRowToRecord(row),
    participantStatus: participant.status as ParticipantStatus,
    activeRestrictionCount,
  };
}
