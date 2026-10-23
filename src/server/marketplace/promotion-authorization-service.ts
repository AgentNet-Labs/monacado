/**
 * Promotion Authorization acts (Phase 1.41, Contract §16.1) — SERVER ONLY.
 *
 * The ONLY path that writes Promotion Authorization. Three acts:
 *
 *   - `requestPromotionAuthorizationAs` — a Promoter opens a request cycle;
 *   - `decidePromotionAuthorizationAs`  — the Product's Seller approves, denies,
 *     or revokes;
 *   - `cancelPromotionAuthorizationAs`  — the cycle's Promoter withdraws its
 *     request (`REQUESTED → CANCELLED`) or its participation
 *     (`APPROVED → CANCELLED`).
 *
 * ## Authority, read from rows, never from the request
 *
 * - **Request:** `participantMayRequestPromotionAuthorization` — private
 *   marketplace identity and a PROMOTER role in a drafting / pre-commercial
 *   status. No payment readiness, commerce approval, Product lifecycle, resale
 *   availability, Offer, Storefront, or Listing. A participant holding Seller
 *   authority over the Product is refused (Contract §14): today the
 *   participant IS the strongest authoritative economic principal (one per
 *   account); cross-account principal linkage does not exist yet and is not
 *   invented here.
 * - **Approve / deny / revoke:** Seller authority over the Product
 *   (`participantHoldsProductAuthority`) and nothing else — no internal grant
 *   substitutes for it, and no Seller standing or readiness gate is added
 *   (ruling D). Unknown Product and another Seller's Product are one 404.
 *   **Approval re-asks the Promoter's request gate** (ruling C): a Promoter that
 *   no longer qualifies is a deterministic conflict, and the open request is
 *   left exactly as it was.
 * - **Cancel:** only the cycle's own Promoter. Withdrawing is standing down, not
 *   authoring, so it asks no gate beyond being that participant.
 *
 * ## Concurrency
 *
 * Every act locks the Product row (`FOR UPDATE`) before reading anything it
 * decides on, so all acts on one Product — and Product activation, suspension,
 * revision, and resale changes, which lock or update the same row — serialise;
 * the second request decides on the first's result. The unique cycle pair
 * marker, `supersedesAuthorizationId`, `cycleNumber`, `supersedesActId`, and
 * `currentForAuthorizationId` are the database's own guarantee behind that: no
 * fork, one current relationship per Product + Promoter, one linear history.
 *
 * ## What it does not do
 *
 * Writes no Product source version, Product row, lifecycle, activation,
 * suspension, or resale act, and no Offer, Listing, Storefront, Order, payment,
 * payout, Node, capsule, publication, outbox, or notification state. Reads no
 * Product lifecycle or resale availability. No Product lifecycle or resale
 * change ever calls it.
 */

import "../server-only";
import { Prisma } from "@prisma/client";
import {
  SellerPromotionAuthorizationDecision,
  decidePromotionAuthorizationAct,
  decidePromotionAuthorizationRequest,
  participantMayRequestPromotionAuthorization,
  type PromotionAuthorizationAct,
  type PromotionAuthorizationAuthority,
  type PromotionAuthorizationState,
} from "../../contracts/marketplace/promotion-authorization";
import { getPrisma } from "../db/client";
import { ProductNotAvailableError, ValidationError } from "../product/errors";
import {
  PromotionAuthorizationAlreadyOpenError,
  PromotionAuthorizationConflictError,
  PromotionAuthorizationNotFoundError,
  PromotionAuthorizationPromoterNotEligibleError,
  PromotionAuthorizationRequestNotPermittedError,
  PromotionAuthorizationSelfPromotionError,
  PromotionAuthorizationSupersededError,
  PromotionAuthorizationTransitionNotGovernedError,
} from "./promotion-authorization-errors";
import {
  cryptoPromotionAuthorizationIdProvider,
  type PromotionAuthorizationIdProvider,
} from "./promotion-authorization-ids";
import {
  readCurrentPromotionAuthorizationIn,
  readPromotionAuthorizationByRefIn,
  readPromotionRequestFactsIn,
  type PromotionAuthorizationCycleRead,
} from "./promotion-authorization-read-service";
import { participantHoldsProductAuthority } from "./product-authority-service";

type Db = ReturnType<typeof getPrisma>;

export interface PromotionAuthorizationServiceDeps {
  db?: Db;
  ids?: PromotionAuthorizationIdProvider;
}

export interface PromotionAuthorizationResult {
  /** Stable application references only — never an internal id. */
  productRef: string;
  authorizationRef: string;
  state: PromotionAuthorizationState;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

async function lockProduct(tx: Prisma.TransactionClient, internalProductId: string): Promise<void> {
  await tx.$queryRaw`SELECT internalProductId FROM Product WHERE internalProductId = ${internalProductId} FOR UPDATE`;
}

async function findProduct(db: Db, productRef: string) {
  const product = await db.product.findUnique({
    where: { productRef },
    select: { internalProductId: true, productRef: true },
  });
  if (product === null) throw new ProductNotAvailableError();
  return product;
}

/** Map a uniqueness race to the module's conflict; anything else passes through. */
async function inTransaction<T>(db: Db, run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await db.$transaction(run);
  } catch (error) {
    if (isUniqueViolation(error)) throw new PromotionAuthorizationConflictError(error);
    throw error;
  }
}

/** Append one act to a cycle: release the current act's marker, then record the new current act. */
async function appendAct(
  tx: Prisma.TransactionClient,
  ids: PromotionAuthorizationIdProvider,
  cycle: PromotionAuthorizationCycleRead,
  act: {
    act: PromotionAuthorizationAct;
    from: PromotionAuthorizationState;
    to: PromotionAuthorizationState;
    authority: PromotionAuthorizationAuthority;
    actorParticipantId: string;
    actedByAccountId: string;
    actedAt: Date;
  },
): Promise<void> {
  await tx.promotionAuthorizationAct.update({
    where: { id: cycle.currentActId },
    data: { currentForAuthorizationId: null },
  });
  await tx.promotionAuthorizationAct.create({
    data: {
      id: ids.nextPromotionAuthorizationActId(),
      authorizationId: cycle.id,
      act: act.act,
      state: act.to,
      previousState: act.from,
      supersedesActId: cycle.currentActId,
      currentForAuthorizationId: cycle.id,
      actorAuthority: act.authority,
      actorParticipantId: act.actorParticipantId,
      actedByAccountId: act.actedByAccountId,
      actedAt: act.actedAt,
    },
  });
}

/** The cycle named, on this Product; refuses a superseded one before any decision. */
async function currentCycleByRef(
  tx: Prisma.TransactionClient,
  internalProductId: string,
  authorizationRef: string,
): Promise<PromotionAuthorizationCycleRead | null> {
  const cycle = await readPromotionAuthorizationByRefIn(tx, internalProductId, authorizationRef);
  if (cycle !== null && !cycle.current) throw new PromotionAuthorizationSupersededError();
  return cycle;
}

/**
 * A Promoter requests Promotion Authorization for one Product.
 *
 * Throws `ProductNotAvailableError` (no such Product),
 * `PromotionAuthorizationRequestNotPermittedError` (the gate),
 * `PromotionAuthorizationSelfPromotionError`,
 * `PromotionAuthorizationAlreadyOpenError` (current cycle `REQUESTED` /
 * `APPROVED`), or `PromotionAuthorizationConflictError`.
 */
export async function requestPromotionAuthorizationAs(
  actor: { accountId: string },
  request: { productRef: string; now: string },
  deps: PromotionAuthorizationServiceDeps = {},
): Promise<PromotionAuthorizationResult> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoPromotionAuthorizationIdProvider;
  const product = await findProduct(db, request.productRef);
  const internalProductId = product.internalProductId;

  return await inTransaction(db, async (tx) => {
    await lockProduct(tx, internalProductId);

    const read = await readPromotionRequestFactsIn(tx, { accountId: actor.accountId });
    if (read === null) throw new PromotionAuthorizationRequestNotPermittedError(["PARTICIPANT_MISSING"]);
    const eligibility = participantMayRequestPromotionAuthorization(read.facts);
    if (!eligibility.eligible || read.participantId === null) {
      throw new PromotionAuthorizationRequestNotPermittedError(eligibility.refusals);
    }
    const promoterParticipantId = read.participantId;

    if (await participantHoldsProductAuthority(tx, internalProductId, promoterParticipantId)) {
      throw new PromotionAuthorizationSelfPromotionError();
    }

    const current = await readCurrentPromotionAuthorizationIn(tx, { internalProductId, promoterParticipantId });
    const decision = decidePromotionAuthorizationRequest(current?.state ?? null);
    if (decision.outcome === "REFUSED") {
      throw new PromotionAuthorizationAlreadyOpenError(
        decision.reason === "ALREADY_REQUESTED" ? "REQUESTED" : "APPROVED",
      );
    }

    /* A new cycle: the old one (terminal) gives up the pair marker and keeps
       everything else, including its decision. */
    if (current !== null) {
      await tx.promotionAuthorization.update({
        where: { id: current.id },
        data: { currentForProductId: null, currentForPromoterParticipantId: null },
      });
    }
    const authorizationId = ids.nextPromotionAuthorizationId();
    const authorizationRef = ids.nextPromotionAuthorizationRef();
    const actedAt = new Date(request.now);
    await tx.promotionAuthorization.create({
      data: {
        id: authorizationId,
        authorizationRef,
        internalProductId,
        promoterParticipantId,
        cycleNumber: (current?.cycleNumber ?? 0) + 1,
        supersedesAuthorizationId: current?.id ?? null,
        currentForProductId: internalProductId,
        currentForPromoterParticipantId: promoterParticipantId,
        requestedByAccountId: actor.accountId,
        requestedAt: actedAt,
      },
    });
    await tx.promotionAuthorizationAct.create({
      data: {
        id: ids.nextPromotionAuthorizationActId(),
        authorizationId,
        act: "REQUEST",
        state: "REQUESTED",
        previousState: null,
        supersedesActId: null,
        currentForAuthorizationId: authorizationId,
        actorAuthority: "PROMOTER",
        actorParticipantId: promoterParticipantId,
        actedByAccountId: actor.accountId,
        actedAt,
      },
    });
    return { productRef: product.productRef, authorizationRef, state: "REQUESTED" as const };
  });
}

/**
 * The Product's Seller approves, denies, or revokes one Promoter's current cycle.
 *
 * Throws `ValidationError` (decision outside the vocabulary),
 * `ProductNotAvailableError` (no such Product, or no Seller authority over it —
 * one answer), `PromotionAuthorizationNotFoundError`,
 * `PromotionAuthorizationSupersededError`,
 * `PromotionAuthorizationTransitionNotGovernedError`,
 * `PromotionAuthorizationPromoterNotEligibleError` (approval only), or
 * `PromotionAuthorizationConflictError`.
 */
export async function decidePromotionAuthorizationAs(
  actor: { accountId: string },
  request: { productRef: string; authorizationRef: string; decision: string; now: string },
  deps: PromotionAuthorizationServiceDeps = {},
): Promise<PromotionAuthorizationResult> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoPromotionAuthorizationIdProvider;
  const decision = SellerPromotionAuthorizationDecision.safeParse(request.decision);
  if (!decision.success) throw new ValidationError("Invalid Promotion Authorization decision", ["decision: unknown value"]);

  const product = await findProduct(db, request.productRef);
  const internalProductId = product.internalProductId;
  const seller = await db.marketplaceParticipant.findUnique({
    where: { accountId: actor.accountId },
    select: { id: true },
  });
  const sellerParticipantId = seller?.id;
  if (sellerParticipantId === undefined || !(await participantHoldsProductAuthority(db, internalProductId, sellerParticipantId))) {
    throw new ProductNotAvailableError();
  }

  return await inTransaction(db, async (tx) => {
    await lockProduct(tx, internalProductId);
    if (!(await participantHoldsProductAuthority(tx, internalProductId, sellerParticipantId))) {
      throw new ProductNotAvailableError();
    }
    const cycle = await currentCycleByRef(tx, internalProductId, request.authorizationRef);
    if (cycle === null) throw new PromotionAuthorizationNotFoundError();

    const outcome = decidePromotionAuthorizationAct({ current: cycle.state, act: decision.data, authority: "SELLER" });
    if (outcome.outcome === "REFUSED") throw new PromotionAuthorizationTransitionNotGovernedError();

    if (decision.data === "APPROVE") {
      /* Ruling C: the Promoter must still qualify, asked inside this transaction.
         Ruling E: and must still not be the Seller. Either failure writes nothing. */
      const promoter = await readPromotionRequestFactsIn(tx, { participantId: cycle.promoterParticipantId });
      if (promoter === null || !participantMayRequestPromotionAuthorization(promoter.facts).eligible) {
        throw new PromotionAuthorizationPromoterNotEligibleError();
      }
      if (await participantHoldsProductAuthority(tx, internalProductId, cycle.promoterParticipantId)) {
        throw new PromotionAuthorizationSelfPromotionError();
      }
    }

    await appendAct(tx, ids, cycle, {
      act: decision.data,
      from: outcome.from,
      to: outcome.to,
      authority: "SELLER",
      actorParticipantId: sellerParticipantId,
      actedByAccountId: actor.accountId,
      actedAt: new Date(request.now),
    });
    return { productRef: product.productRef, authorizationRef: cycle.authorizationRef, state: outcome.to };
  });
}

/**
 * The cycle's own Promoter cancels — `REQUESTED → CANCELLED` (withdrawing its
 * request) or `APPROVED → CANCELLED` (withdrawing its participation).
 *
 * Throws `ProductNotAvailableError` (no such Product),
 * `PromotionAuthorizationNotFoundError` (not this Product's, or not this
 * Promoter's — one answer), `PromotionAuthorizationSupersededError`,
 * `PromotionAuthorizationTransitionNotGovernedError`, or
 * `PromotionAuthorizationConflictError`.
 */
export async function cancelPromotionAuthorizationAs(
  actor: { accountId: string },
  request: { productRef: string; authorizationRef: string; now: string },
  deps: PromotionAuthorizationServiceDeps = {},
): Promise<PromotionAuthorizationResult> {
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoPromotionAuthorizationIdProvider;
  const product = await findProduct(db, request.productRef);
  const internalProductId = product.internalProductId;
  const promoter = await db.marketplaceParticipant.findUnique({
    where: { accountId: actor.accountId },
    select: { id: true },
  });
  if (promoter === null) throw new PromotionAuthorizationNotFoundError();
  const promoterParticipantId = promoter.id;

  return await inTransaction(db, async (tx) => {
    await lockProduct(tx, internalProductId);
    const named = await readPromotionAuthorizationByRefIn(tx, internalProductId, request.authorizationRef);
    if (named === null || named.promoterParticipantId !== promoterParticipantId) {
      throw new PromotionAuthorizationNotFoundError();
    }
    const cycle = await currentCycleByRef(tx, internalProductId, request.authorizationRef);
    if (cycle === null) throw new PromotionAuthorizationNotFoundError();

    const outcome = decidePromotionAuthorizationAct({ current: cycle.state, act: "CANCEL", authority: "PROMOTER" });
    if (outcome.outcome === "REFUSED") throw new PromotionAuthorizationTransitionNotGovernedError();

    await appendAct(tx, ids, cycle, {
      act: "CANCEL",
      from: outcome.from,
      to: outcome.to,
      authority: "PROMOTER",
      actorParticipantId: promoterParticipantId,
      actedByAccountId: actor.accountId,
      actedAt: new Date(request.now),
    });
    return { productRef: product.productRef, authorizationRef: cycle.authorizationRef, state: outcome.to };
  });
}
