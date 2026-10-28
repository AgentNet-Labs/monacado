/**
 * Promotion Authorization from the database (Phase 1.41) — SERVER ONLY.
 *
 * Reads only. Each reader takes a transaction client, so the write service
 * decides on exactly the rows it then writes.
 *
 * A cycle's state is the `state` of its current act (the one holding
 * `currentForAuthorizationId`) — never a column of the cycle, never a boolean.
 * The current relationship for a Product + Promoter is the cycle holding the
 * pair marker; a pair with no cycle has no relationship at all.
 *
 * Nothing here reads Product lifecycle, resale availability, an Offer, a
 * Storefront, a Listing, or payment state: Promotion Authorization is its own
 * axis (Contract §3, §16.1).
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  PromotionAuthorizationState,
  promotionAuthorizationIsApproved,
  type PromotionAuthorizationRequestFacts,
} from "../../contracts/marketplace/promotion-authorization";
import type { ParticipantStatus, RoleAssignmentStatus } from "../../contracts/marketplace/participant";
import { getPrisma } from "../db/client";
import { PromotionAuthorizationCorruptRecordError } from "./promotion-authorization-errors";
import { isParticipantSuspended } from "./participant-standing-service";

type Tx = ReturnType<typeof getPrisma> | Prisma.TransactionClient;

function parseState(value: string): PromotionAuthorizationState {
  const parsed = PromotionAuthorizationState.safeParse(value);
  if (!parsed.success) {
    throw new PromotionAuthorizationCorruptRecordError("Stored Promotion Authorization state is outside the governed vocabulary");
  }
  return parsed.data;
}

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/**
 * The facts `participantMayRequestPromotionAuthorization` weighs, for one
 * account (`{ accountId }`, the requester) or one participant
 * (`{ participantId }`, the Promoter re-checked at approval). `null` when no
 * such account / participant exists.
 *
 * Reads no payment account, commerce approval, or activation: the gate
 * deliberately does not ask them.
 */
export async function readPromotionRequestFactsIn(
  tx: Tx,
  who: { accountId: string } | { participantId: string },
): Promise<{ facts: PromotionAuthorizationRequestFacts; participantId: string | null } | null> {
  const participant =
    "participantId" in who
      ? await tx.marketplaceParticipant.findUnique({ where: { id: who.participantId } })
      : await tx.marketplaceParticipant.findUnique({ where: { accountId: who.accountId } });
  const accountId = "accountId" in who ? who.accountId : participant?.accountId;
  if (accountId === undefined) return null;
  const account = await tx.account.findUnique({
    where: { id: accountId },
    select: { status: true, emailVerifiedAt: true, firstName: true, lastName: true },
  });
  if (account === null) return null;

  const accountFacts = {
    status: account.status,
    emailVerifiedAt: iso(account.emailVerifiedAt),
    firstName: account.firstName,
    lastName: account.lastName,
  };
  if (participant === null) return { facts: { account: accountFacts, participant: null }, participantId: null };

  const role = await tx.marketplaceRoleAssignment.findUnique({
    where: { participantId_role: { participantId: participant.id, role: "PROMOTER" } },
    select: { status: true },
  });
  return {
    participantId: participant.id,
    facts: {
      account: accountFacts,
      participant: {
        status: participant.status as ParticipantStatus,
        suspended: await isParticipantSuspended(tx, participant.id),
        hasMarketplaceName: participant.marketplaceName !== null,
        promoterRoleStatus: role === null ? null : (role.status as RoleAssignmentStatus),
      },
    },
  };
}

export interface PromotionAuthorizationCycleRead {
  id: string;
  authorizationRef: string;
  internalProductId: string;
  promoterParticipantId: string;
  cycleNumber: number;
  /** Whether this cycle holds the pair's current marker. */
  current: boolean;
  state: PromotionAuthorizationState;
  currentActId: string;
}

const CYCLE_SELECT = {
  id: true,
  authorizationRef: true,
  internalProductId: true,
  promoterParticipantId: true,
  cycleNumber: true,
  currentForProductId: true,
} as const;

async function withState(
  tx: Tx,
  cycle: {
    id: string;
    authorizationRef: string;
    internalProductId: string;
    promoterParticipantId: string;
    cycleNumber: number;
    currentForProductId: string | null;
  },
): Promise<PromotionAuthorizationCycleRead> {
  const act = await tx.promotionAuthorizationAct.findUnique({
    where: { currentForAuthorizationId: cycle.id },
    select: { id: true, state: true },
  });
  if (act === null) throw new PromotionAuthorizationCorruptRecordError("Promotion Authorization cycle has no current act");
  return {
    id: cycle.id,
    authorizationRef: cycle.authorizationRef,
    internalProductId: cycle.internalProductId,
    promoterParticipantId: cycle.promoterParticipantId,
    cycleNumber: cycle.cycleNumber,
    current: cycle.currentForProductId !== null,
    state: parseState(act.state),
    currentActId: act.id,
  };
}

/** The CURRENT cycle for this Product + Promoter, or `null` when none has ever been requested. */
export async function readCurrentPromotionAuthorizationIn(
  tx: Tx,
  pair: { internalProductId: string; promoterParticipantId: string },
): Promise<PromotionAuthorizationCycleRead | null> {
  const cycle = await tx.promotionAuthorization.findFirst({
    where: {
      currentForProductId: pair.internalProductId,
      currentForPromoterParticipantId: pair.promoterParticipantId,
    },
    select: CYCLE_SELECT,
  });
  return cycle === null ? null : await withState(tx, cycle);
}

/** One cycle by its application reference, scoped to a Product; `null` when it is not that Product's. */
export async function readPromotionAuthorizationByRefIn(
  tx: Tx,
  internalProductId: string,
  authorizationRef: string,
): Promise<PromotionAuthorizationCycleRead | null> {
  const cycle = await tx.promotionAuthorization.findUnique({
    where: { authorizationRef },
    select: CYCLE_SELECT,
  });
  if (cycle === null || cycle.internalProductId !== internalProductId) return null;
  return await withState(tx, cycle);
}

/**
 * THE helper future promoted-commerce eligibility consumes (Contract §16.3
 * item 4): is Promotion Authorization CURRENTLY `APPROVED` for this Product and
 * this Promoter?
 *
 * Necessary, NEVER sufficient. It does not ask — and a `true` here says nothing
 * about — Product lifecycle `ACTIVE`, resale availability `AVAILABLE`, an
 * eligible `ACTIVE` promotional Offer, the Promoter's commercial eligibility,
 * distinct economic principals, accepted Offer terms, or any other gate.
 */
export async function isPromotionAuthorizationApprovedIn(
  tx: Tx,
  pair: { internalProductId: string; promoterParticipantId: string },
): Promise<boolean> {
  const current = await readCurrentPromotionAuthorizationIn(tx, pair);
  return promotionAuthorizationIsApproved(current?.state ?? null);
}

/** Current cycles, with state, in one pass over the act markers. */
async function currentCyclesWithState(
  tx: Tx,
  where: Prisma.PromotionAuthorizationWhereInput,
) {
  const cycles = await tx.promotionAuthorization.findMany({
    where: { ...where, currentForProductId: { not: null } },
    orderBy: { requestedAt: "asc" },
    select: {
      id: true,
      authorizationRef: true,
      internalProductId: true,
      promoterParticipantId: true,
      requestedAt: true,
    },
  });
  if (cycles.length === 0) return [];
  const acts = await tx.promotionAuthorizationAct.findMany({
    where: { currentForAuthorizationId: { in: cycles.map((c) => c.id) } },
    select: { currentForAuthorizationId: true, state: true, actedAt: true },
  });
  const byCycle = new Map(acts.map((a) => [a.currentForAuthorizationId, a]));
  return cycles.map((c) => {
    const act = byCycle.get(c.id);
    if (act === undefined) throw new PromotionAuthorizationCorruptRecordError("Promotion Authorization cycle has no current act");
    return { ...c, state: parseState(act.state), stateSince: act.actedAt };
  });
}

/** One current relationship as the Seller's page sees it. No internal id. */
export interface SellerPromotionAuthorizationRead {
  authorizationRef: string;
  state: PromotionAuthorizationState;
  /**
   * The Promoter's mName (Phase 1.43) — the ONLY Promoter identity a Seller is
   * shown. Never a declared first / last name, never `Account.name`, never an
   * email, never an id.
   *
   * `null` when the Promoter has no mName: a participant created before Phase
   * 1.43 whose request predates the gate that now requires one. It stays `null`
   * — nothing else is substituted — and approval re-checks the gate, so such a
   * request cannot be approved.
   */
  promoterMName: string | null;
  requestedAt: string;
  stateSince: string;
}

/** The current relationship of every Promoter for each of these Products, keyed by internal id. */
export async function readSellerPromotionAuthorizationsIn(
  tx: Tx,
  internalProductIds: readonly string[],
): Promise<Map<string, SellerPromotionAuthorizationRead[]>> {
  const out = new Map<string, SellerPromotionAuthorizationRead[]>(internalProductIds.map((id) => [id, []]));
  if (internalProductIds.length === 0) return out;
  const cycles = await currentCyclesWithState(tx, { internalProductId: { in: [...internalProductIds] } });
  if (cycles.length === 0) return out;
  /* The mName and nothing else: the Promoter's account is not read at all. */
  const promoters = await tx.marketplaceParticipant.findMany({
    where: { id: { in: [...new Set(cycles.map((c) => c.promoterParticipantId))] } },
    select: { id: true, marketplaceName: true },
  });
  const mNameOf = new Map(promoters.map((p) => [p.id, p.marketplaceName]));
  for (const c of cycles) {
    out.get(c.internalProductId)?.push({
      authorizationRef: c.authorizationRef,
      state: c.state,
      promoterMName: mNameOf.get(c.promoterParticipantId) ?? null,
      requestedAt: c.requestedAt.toISOString(),
      stateSince: c.stateSince.toISOString(),
    });
  }
  return out;
}

/** One current relationship as the Promoter's page sees it. No internal id, no Product fact. */
export interface PromoterPromotionAuthorizationRead {
  /** The reference the Promoter itself submitted — it reveals nothing new. */
  productRef: string;
  authorizationRef: string;
  state: PromotionAuthorizationState;
  requestedAt: string;
  stateSince: string;
}

/** The Promoter's current relationship for every Product it has ever requested. */
export async function readPromoterPromotionAuthorizationsIn(
  tx: Tx,
  promoterParticipantId: string,
): Promise<PromoterPromotionAuthorizationRead[]> {
  const cycles = await currentCyclesWithState(tx, { promoterParticipantId });
  if (cycles.length === 0) return [];
  const products = await tx.product.findMany({
    where: { internalProductId: { in: [...new Set(cycles.map((c) => c.internalProductId))] } },
    select: { internalProductId: true, productRef: true },
  });
  const refOf = new Map(products.map((p) => [p.internalProductId, p.productRef]));
  return cycles.flatMap((c) => {
    const productRef = refOf.get(c.internalProductId);
    if (productRef === undefined) return [];
    return [
      {
        productRef,
        authorizationRef: c.authorizationRef,
        state: c.state,
        requestedAt: c.requestedAt.toISOString(),
        stateSince: c.stateSince.toISOString(),
      },
    ];
  });
}
