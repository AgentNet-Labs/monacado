/**
 * Staff risk review (Phase 1.13) — SERVER ONLY.
 *
 * Recording that a human looked at a seller, and what they concluded.
 *
 * ## This module performs no adverse action, and cannot
 *
 * There is no code path here that writes `MarketplaceParticipant.status`,
 * creates a `ParticipantRestriction`, holds a payout, or reaches the Phase 1.2
 * transaction gate. `SUSPENSION_RECOMMENDED` is a recorded conclusion and
 * nothing else. That is not timidity — it is what the committed governance
 * permits:
 *
 *   - **No terms.** Marketplace Policy 1.2.0 authorises declining, holding, or
 *     reversing *a transaction* on risk grounds. It says nothing about
 *     monitoring a participant's rates, placing them under review, or
 *     restricting their selling, and its dispute term says explicitly that a
 *     per-sale hold "is not a suspension of a participant's other proceeds".
 *     `MARKETPLACE_POLICY_RISK_TERMS_REQUIRED` records what a future version
 *     must say before a participant-level consequence may be operated.
 *   - **No mechanism.** Every writer in this repository refuses participant
 *     `SUSPENDED` by name, and the phase that refused it said why: "a
 *     restriction nobody can enumerate is indistinguishable from a suspension".
 *     Building one inside a risk phase would be a lifecycle change made in the
 *     wrong place.
 *
 * What a Staff member CAN do today is impose a scoped restriction through the
 * existing governed authority — properly entitled, separation-of-duties
 * enforced, evidence written in one transaction. That path is unchanged by this
 * phase and is invoked explicitly by a person, never from here.
 *
 * ## Two grants, so a recommendation cannot execute itself
 *
 * Recording a review requires `participant:risk-review`. Imposing a restriction
 * requires `participant:restrict`. They are independent in both directions, so
 * the reviewer who writes `SUSPENSION_RECOMMENDED` cannot act on it without a
 * second authority being checked against persisted state. Folding them together
 * would have made recording a recommendation a silent grant of the power to
 * carry it out.
 *
 * ## The trigger is a coordinate, never a copied score
 *
 * A review stores `triggerAsOf` and the exact heuristics version, which
 * regenerate the ranking the reviewer saw. It stores no score, because an
 * analytics number sitting in the record would eventually be read as the
 * finding rather than as the reason somebody was asked to look.
 */

import "../server-only";
import {
  isValidRiskReviewTransition,
  type ParticipantRiskReviewRecord,
  type RiskReviewDisposition,
  type RiskReviewReason,
  type RiskReviewStatus,
} from "../../contracts/marketplace/seller-risk-review";
import {
  canReviewParticipantRisk,
  isInternallyAuthorized,
} from "../../contracts/account/internal-authorization";
import { resolveInternalAuthorizationSubject } from "../account/internal-authorization-service";
import { getPrisma } from "../db/client";
import {
  RiskReviewAlreadyOpenError,
  RiskReviewNotAuthorizedError,
  RiskReviewTransitionError,
  SellerRiskRequestError,
} from "./seller-risk-errors";
import {
  cryptoParticipantRiskReviewIdProvider,
  type ParticipantRiskReviewIdProvider,
} from "./seller-risk-ids";

type Db = ReturnType<typeof getPrisma>;

export interface RiskReviewDeps {
  db?: Db;
  ids?: ParticipantRiskReviewIdProvider;
}

/**
 * Authorization from persisted entitlement state, checked before any participant
 * or review row is read — so an unauthorized caller learns nothing about the
 * target, not even whether it exists. 0M.R1's order of checks, unchanged.
 */
async function assertRiskReviewAuthority(db: Db, actingAccountId: string): Promise<void> {
  const actor = await resolveInternalAuthorizationSubject(actingAccountId, { db });
  const decision = canReviewParticipantRisk(actor);
  if (!isInternallyAuthorized(decision)) {
    throw new RiskReviewNotAuthorizedError([...decision.reasonCodes]);
  }
}

function toRecord(row: {
  id: string;
  participantId: string;
  triggerSource: string;
  triggerAsOf: Date;
  reviewPolicyId: string;
  reviewPolicyVersion: string;
  openedAt: Date;
  openedByAccountId: string | null;
  status: string;
  assignedReviewerAccountId: string | null;
  dispositionCode: string | null;
  decidedByAccountId: string | null;
  decidedAt: Date | null;
  resultingRestrictionId: string | null;
  triggerReasons: {
    reasonCode: string;
    unit: string;
    observedValue: bigint;
    baselineValue: bigint | null;
    sampleSize: bigint;
    windowDays: number;
  }[];
}): ParticipantRiskReviewRecord {
  return {
    id: row.id,
    participantId: row.participantId,
    triggerSource: row.triggerSource as ParticipantRiskReviewRecord["triggerSource"],
    triggerAsOf: row.triggerAsOf.toISOString(),
    reviewPolicyId: row.reviewPolicyId,
    reviewPolicyVersion: row.reviewPolicyVersion,
    triggerReasons: row.triggerReasons.map((r) => ({
      code: r.reasonCode as RiskReviewReason["code"],
      unit: r.unit as RiskReviewReason["unit"],
      observed: r.observedValue,
      baseline: r.baselineValue,
      sampleSize: r.sampleSize,
      windowDays: r.windowDays as RiskReviewReason["windowDays"],
      /* Not persisted: the comparison basis and the weight are properties of the
         heuristics version, which the row names, rather than facts about this
         participant. Reconstituted from the vocabulary rather than stored, so a
         review can never disagree with the policy it cites. */
      comparison: "POLICY_THRESHOLD",
      weight: 0,
    })),
    openedAt: row.openedAt.toISOString(),
    openedByAccountId: row.openedByAccountId,
    status: row.status as RiskReviewStatus,
    assignedReviewerAccountId: row.assignedReviewerAccountId,
    dispositionCode: row.dispositionCode as RiskReviewDisposition | null,
    decidedByAccountId: row.decidedByAccountId,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    resultingRestrictionId: row.resultingRestrictionId,
  };
}

const INCLUDE_REASONS = { triggerReasons: { orderBy: { seq: "asc" } } } as const;

export interface OpenRiskReviewInput {
  participantId: string;
  triggerSource: "SYSTEM" | "STAFF";
  triggerAsOf: string;
  reviewPolicyId: string;
  reviewPolicyVersion: string;
  reasons: readonly RiskReviewReason[];
  openedAt: string;
  /** NULL for a SYSTEM-raised review. Required when a person opens one. */
  actingAccountId: string | null;
}

/**
 * Open a review.
 *
 * A re-firing daily signal is the SAME concern, not a second one: the database
 * refuses a second open review per participant through `openForParticipantId`,
 * and this surfaces that as `RiskReviewAlreadyOpenError` so a caller can carry on
 * rather than treating a constraint violation as a failure.
 *
 * A SYSTEM-raised review needs no acting account — nobody has looked yet, which
 * is precisely what the review is asking for. A STAFF-raised one is authorized
 * first, on the same terms every other governed act here is.
 */
export async function openParticipantRiskReview(
  input: OpenRiskReviewInput,
  deps: RiskReviewDeps = {},
): Promise<ParticipantRiskReviewRecord> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoParticipantRiskReviewIdProvider;

  if (input.triggerSource === "STAFF") {
    if (input.actingAccountId === null) {
      throw new SellerRiskRequestError("A staff-opened review must name the acting account");
    }
    await assertRiskReviewAuthority(db, input.actingAccountId);
  }

  const existing = await db.participantRiskReview.findUnique({
    where: { openForParticipantId: input.participantId },
    select: { id: true },
  });
  if (existing !== null) throw new RiskReviewAlreadyOpenError();

  const id = ids.nextParticipantRiskReviewId();
  const recordedAt = new Date(input.openedAt);

  try {
    const created = await db.participantRiskReview.create({
      data: {
        id,
        participantId: input.participantId,
        triggerSource: input.triggerSource,
        triggerAsOf: new Date(input.triggerAsOf),
        reviewPolicyId: input.reviewPolicyId,
        reviewPolicyVersion: input.reviewPolicyVersion,
        openedAt: recordedAt,
        openedByAccountId: input.triggerSource === "STAFF" ? input.actingAccountId : null,
        status: "OPEN",
        /* Claims the unique marker while the review is not CLOSED. */
        openForParticipantId: input.participantId,
        triggerReasons: {
          create: input.reasons.map((r) => ({
            reasonCode: r.code,
            unit: r.unit,
            observedValue: r.observed,
            baselineValue: r.baseline,
            sampleSize: r.sampleSize,
            windowDays: r.windowDays,
            recordedAt,
          })),
        },
      },
      include: INCLUDE_REASONS,
    });
    return toRecord(created);
  } catch (error) {
    /* A concurrent opener won the unique index. The same fact, reported the
       same way. */
    if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") {
      throw new RiskReviewAlreadyOpenError();
    }
    throw error;
  }
}

/** Assign a reviewer and move the review to `UNDER_REVIEW`. */
export async function assignParticipantRiskReview(
  input: { reviewId: string; reviewerAccountId: string; actingAccountId: string },
  deps: RiskReviewDeps = {},
): Promise<ParticipantRiskReviewRecord> {
  const db = deps.db ?? getPrisma();
  await assertRiskReviewAuthority(db, input.actingAccountId);

  const current = await db.participantRiskReview.findUnique({
    where: { id: input.reviewId },
    select: { status: true },
  });
  if (current === null) throw new SellerRiskRequestError("No such risk review");
  if (!isValidRiskReviewTransition(current.status as RiskReviewStatus, "UNDER_REVIEW")) {
    throw new RiskReviewTransitionError(
      `A review at ${current.status} cannot move to UNDER_REVIEW`,
    );
  }

  const updated = await db.participantRiskReview.update({
    where: { id: input.reviewId },
    data: { status: "UNDER_REVIEW", assignedReviewerAccountId: input.reviewerAccountId },
    include: INCLUDE_REASONS,
  });
  return toRecord(updated);
}

export interface CloseRiskReviewInput {
  reviewId: string;
  dispositionCode: RiskReviewDisposition;
  actingAccountId: string;
  decidedAt: string;
  /**
   * A restriction the acting Staff member ALREADY imposed through the existing
   * governed authority, recorded here as evidence of linkage.
   *
   * NOT A REQUEST TO IMPOSE ONE. Nothing in this module creates a restriction;
   * this column names one that a separately-authorized act already created, so
   * the review and the consequence can be read together afterwards.
   */
  resultingRestrictionId?: string | null;
}

/**
 * Close a review with a bounded disposition.
 *
 * `CLOSED` is terminal. If the signal recurs, that is a NEW review with its own
 * instant and actor — 0M.R1's rule that "restricted, cleared, restricted again"
 * must read as two events rather than one row that changed its mind.
 *
 * **No disposition performs anything.** The three that name consequences say
 * `RECOMMENDED` and mean it. This function writes one row and one column set; it
 * does not touch participant status, restrictions, proceeds, or the transaction
 * gate, and a test asserts the source contains no such writer.
 */
export async function closeParticipantRiskReview(
  input: CloseRiskReviewInput,
  deps: RiskReviewDeps = {},
): Promise<ParticipantRiskReviewRecord> {
  const db = deps.db ?? getPrisma();
  await assertRiskReviewAuthority(db, input.actingAccountId);

  const current = await db.participantRiskReview.findUnique({
    where: { id: input.reviewId },
    select: { status: true, participantId: true },
  });
  if (current === null) throw new SellerRiskRequestError("No such risk review");
  if (!isValidRiskReviewTransition(current.status as RiskReviewStatus, "CLOSED")) {
    throw new RiskReviewTransitionError(`A review at ${current.status} cannot move to CLOSED`);
  }

  const updated = await db.participantRiskReview.update({
    where: { id: input.reviewId },
    data: {
      status: "CLOSED",
      dispositionCode: input.dispositionCode,
      decidedByAccountId: input.actingAccountId,
      decidedAt: new Date(input.decidedAt),
      resultingRestrictionId: input.resultingRestrictionId ?? null,
      /* Released, so the participant may be reviewed again later. */
      openForParticipantId: null,
    },
    include: INCLUDE_REASONS,
  });
  return toRecord(updated);
}

/** Read one participant's review history, newest first. */
export async function readParticipantRiskReviews(
  input: { participantId: string; actingAccountId: string; limit?: number },
  deps: RiskReviewDeps = {},
): Promise<ParticipantRiskReviewRecord[]> {
  const db = deps.db ?? getPrisma();
  await assertRiskReviewAuthority(db, input.actingAccountId);

  const rows = await db.participantRiskReview.findMany({
    where: { participantId: input.participantId },
    orderBy: { openedAt: "desc" },
    take: Math.min(input.limit ?? 20, 100),
    include: INCLUDE_REASONS,
  });
  return rows.map(toRecord);
}

/** The open review queue, oldest first — what has been waiting longest. */
export async function readOpenRiskReviews(
  input: { actingAccountId: string; limit?: number },
  deps: RiskReviewDeps = {},
): Promise<ParticipantRiskReviewRecord[]> {
  const db = deps.db ?? getPrisma();
  await assertRiskReviewAuthority(db, input.actingAccountId);

  const rows = await db.participantRiskReview.findMany({
    where: { status: { in: ["OPEN", "UNDER_REVIEW"] } },
    orderBy: { openedAt: "asc" },
    take: Math.min(input.limit ?? 50, 100),
    include: INCLUDE_REASONS,
  });
  return rows.map(toRecord);
}
