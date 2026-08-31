/**
 * Offer persistence service (Phase 0M.6) — SERVER ONLY.
 *
 * The narrow application boundary over Offer persistence: create a draft, read
 * the record and its versions, read one exact historical version, and mint a new
 * immutable version from an authorized material change.
 *
 * Five properties shape everything below:
 *
 *   1. **Immutable history.** A material change inserts a new version row and
 *      moves the stable record's pointer in one transaction. No historical row
 *      is ever updated, and a stable record can never point at a version that
 *      does not exist.
 *
 *   2. **The 0M.2A authority decisions are used, never restated.**
 *      `canCreateDraftOffer`, `canChangeOfferTerms`, `canActivateOffer`,
 *      `canSuspendOffer`, `canResumeOffer`, `canEndOffer`, and
 *      `canWithdrawOffer` decide; this service assembles the facts they need and
 *      honours the answer. A second copy of an authorization rule is a second
 *      rule.
 *
 *   3. **Material change is 0M.2A's classification.** `materialChangesBetween`
 *      decides whether an update is a change at all. An update that changes
 *      nothing material mints no version.
 *
 *   4. **Economics are computed, never accepted.** `calculateOfferEconomics`
 *      produces the commission and gross proceeds from the terms, and the
 *      result is persisted alongside them. Nothing here invents an economic
 *      rule, and Monacado's retail retention is deliberately absent — it is not
 *      an Offer fact.
 *
 *   5. **Nothing reads a clock, generates randomness directly, or touches
 *      `process.env`.** Instants, identities, and the database are injected.
 *
 * **This phase is draft-capable only, and structurally so.** 0M.2A gates
 * activation and resumption behind the full commerce test, which requires
 * `paymentReadiness === "ENABLED"`. No payment record exists until 0M.8, so
 * materialized readiness is always `NOT_STARTED` and those transitions deny with
 * `PAYMENT_NOT_ENABLED`. That is the contract working, not a gap to route
 * around: this service supplies no override, and weakening the gate to make a
 * test pass would let an unpayable seller sell.
 *
 * No HTTP route, no UI, no Node issuance, no publication.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import { CreateDraftOfferInput, UpdateOfferInput } from "../../contracts/marketplace/offer-record";
import {
  INITIAL_OFFER_LIFECYCLE_STATE,
  calculateOfferEconomics,
  canActivateOffer,
  canChangeOfferTerms,
  canCreateDraftOffer,
  canEndOffer,
  canResumeOffer,
  canSuspendOffer,
  canWithdrawOffer,
  isCommerciallySelectable,
  materialChangesBetween,
  normalizeOfferEffectiveIntervalInput,
  type MaterialOfferField,
  type OfferAuthorityDecision,
  type OfferCommercialTerms,
  type OfferLifecycleState,
  type OfferSourceRecord,
  type OfferSourceVersion,
} from "../../contracts/marketplace/offer-source";
import type { MarketplaceSubject } from "../../contracts/marketplace/participant";
import { getPrisma } from "../db/client";
import { toMarketplaceSubject } from "./participant-mapper";
import {
  assertOfferMayBecomeCommerciallyLive,
  assertParticipantMayAuthorMarketplaceState,
} from "./participant-standing-service";
import { ParticipantActionNotPermittedError } from "./participant-standing-errors";
import { cryptoOfferIdProvider, type OfferIdProvider } from "./offer-ids";
import {
  CorruptOfferRecordError,
  DuplicateOfferSourceVersionError,
  InvalidOfferInputError,
  NoMaterialOfferChangeError,
  OfferNotAuthorizedError,
  OfferNotFoundError,
  OfferPersistenceFailureError,
  OfferProductNotFoundError,
  OfferVersionNotFoundError,
  SellerParticipantNotFoundError,
} from "./offer-errors";
import {
  effectiveIntervalToColumns,
  offerRowToSourceRecord,
  termsToColumns,
  versionRowToSourceVersion,
} from "./offer-mapper";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export interface OfferServiceDeps {
  db?: Db;
  ids?: OfferIdProvider;
}

const prismaCode = (error: unknown): string | undefined => {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
};
const isUniqueViolation = (e: unknown): boolean => prismaCode(e) === "P2002";
const isForeignKeyViolation = (e: unknown): boolean => prismaCode(e) === "P2003";

function inputError(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): InvalidOfferInputError {
  return new InvalidOfferInputError(
    Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))),
  );
}

/** Errors that must escape a catch block unwrapped rather than be disguised. */
function isDomainError(error: unknown): boolean {
  return (
    /* Phase 1.15 — a governed standing refusal is a DOMAIN answer, not an
       outage. Wrapped as a persistence failure it would read to a caller as
       though the database had broken, and the bounded denial code the seam
       produced would be lost. */
    error instanceof ParticipantActionNotPermittedError ||
    error instanceof OfferNotFoundError ||
    error instanceof OfferVersionNotFoundError ||
    error instanceof OfferNotAuthorizedError ||
    error instanceof NoMaterialOfferChangeError ||
    error instanceof CorruptOfferRecordError ||
    error instanceof OfferProductNotFoundError ||
    error instanceof SellerParticipantNotFoundError ||
    error instanceof InvalidOfferInputError
  );
}

export interface OfferSnapshot {
  record: OfferSourceRecord;
  currentVersion: OfferSourceVersion;
}

// — Authorization facts —

/**
 * Materialize the acting account's marketplace subject from persisted state.
 *
 * Deliberately the **0M.5 machinery**, not a second copy: the same account,
 * participant, role, and entitlement rows feed the same `toMarketplaceSubject`
 * mapper the participant service uses. An authorization decision is therefore
 * made against the database rather than against whatever a caller asserted.
 *
 * An unknown account yields the guest subject, which every 0M.2A gate refuses
 * with `ACCOUNT_REQUIRED` — a refusal, not an exception.
 */
async function resolveSubject(tx: Tx, accountId: string): Promise<MarketplaceSubject> {
  const account = await tx.account.findUnique({ where: { id: accountId } });
  if (account === null) {
    return toMarketplaceSubject({
      account: null,
      participant: null,
      roles: [],
      internalCapabilities: [],
    });
  }

  const participant = await tx.marketplaceParticipant.findUnique({ where: { accountId } });
  const roles =
    participant === null
      ? []
      : await tx.marketplaceRoleAssignment.findMany({
          where: { participantId: participant.id },
          orderBy: { role: "asc" },
        });
  const entitlements = await tx.accountEntitlement.findMany({
    where: { accountId, status: "ACTIVE" },
    orderBy: { capability: "asc" },
  });

  return toMarketplaceSubject({
    account,
    participant,
    roles,
    internalCapabilities: entitlements.map((e) => e.capability),
  });
}

function requireAllowed(decision: OfferAuthorityDecision): void {
  if (decision.decision === "ALLOW") return;
  throw new OfferNotAuthorizedError(decision.capability, [...decision.reasonCodes]);
}

// — Reads —

async function readSnapshotInTx(tx: Tx, internalOfferId: string): Promise<OfferSnapshot> {
  const row = await tx.offer.findUnique({ where: { internalOfferId } });
  if (row === null) throw new OfferNotFoundError();

  const currentVersion = await tx.offerSourceRecordVersionRow.findUnique({
    where: {
      offerSourceRecordId_sourceRecordVersion: {
        offerSourceRecordId: row.offerSourceRecordId,
        sourceRecordVersion: row.currentSourceRecordVersion,
      },
    },
  });
  /* A stable record pointing at a nonexistent version would mean a partially
     written transaction; the write path makes it impossible, and reading it
     back must fail loudly rather than return half an Offer. */
  if (currentVersion === null) {
    throw new CorruptOfferRecordError(["currentSourceRecordVersion"]);
  }

  return {
    record: offerRowToSourceRecord(row, currentVersion),
    currentVersion: versionRowToSourceVersion(currentVersion),
  };
}

/** Read one Offer with its current authoritative source version. */
export async function getOffer(
  internalOfferId: string,
  deps: OfferServiceDeps = {},
): Promise<OfferSnapshot> {
  const db = deps.db ?? getPrisma();
  try {
    return await readSnapshotInTx(db, internalOfferId);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new OfferPersistenceFailureError("getOffer", error);
  }
}

/**
 * Read the current authoritative source version.
 *
 * This is the function a future publication phase hands to
 * `projectOfferCapsule` — the whole point of the phase.
 */
export async function getCurrentSourceVersion(
  internalOfferId: string,
  deps: OfferServiceDeps = {},
): Promise<OfferSourceVersion> {
  return (await getOffer(internalOfferId, deps)).currentVersion;
}

/**
 * Read one exact historical source version. Never "the latest".
 *
 * This is the read a 0M.7 promoted Listing will bind through: it names the
 * version explicitly and is answered from immutable history, so the answer does
 * not move when the Offer is repriced.
 */
export async function getSourceVersion(
  internalOfferId: string,
  sourceRecordVersion: string,
  deps: OfferServiceDeps = {},
): Promise<OfferSourceVersion> {
  const db = deps.db ?? getPrisma();
  try {
    const stable = await db.offer.findUnique({ where: { internalOfferId } });
    if (stable === null) throw new OfferNotFoundError();

    const row = await db.offerSourceRecordVersionRow.findUnique({
      where: {
        offerSourceRecordId_sourceRecordVersion: {
          offerSourceRecordId: stable.offerSourceRecordId,
          sourceRecordVersion,
        },
      },
    });
    if (row === null) throw new OfferVersionNotFoundError();
    return versionRowToSourceVersion(row);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new OfferPersistenceFailureError("getSourceVersion", error);
  }
}

/** Every source version, oldest first — deterministic creation order. */
export async function listSourceVersions(
  internalOfferId: string,
  deps: OfferServiceDeps = {},
): Promise<OfferSourceVersion[]> {
  const db = deps.db ?? getPrisma();
  try {
    const rows = await db.offerSourceRecordVersionRow.findMany({
      where: { internalOfferId },
      orderBy: { seq: "asc" },
    });
    if (rows.length === 0) throw new OfferNotFoundError();
    return rows.map(versionRowToSourceVersion);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new OfferPersistenceFailureError("listSourceVersions", error);
  }
}

/**
 * Whether this Offer may presently be selected commercially.
 *
 * Uses 0M.2A's own `isCommerciallySelectable` against persisted state rather
 * than reimplementing the two-axis rule. Only ACTIVE + AVAILABLE selects.
 */
export async function evaluateOfferState(
  internalOfferId: string,
  deps: OfferServiceDeps = {},
): Promise<{
  record: OfferSourceRecord;
  commerciallySelectable: boolean;
}> {
  const snapshot = await getOffer(internalOfferId, deps);
  return {
    record: snapshot.record,
    commerciallySelectable: isCommerciallySelectable({
      lifecycle: snapshot.record.lifecycle,
      availability: snapshot.record.availability,
    }),
  };
}

// — Writes —

/**
 * Create one draft Offer and its first immutable source version.
 *
 * The first version is `DRAFT` + `AVAILABLE`, and neither is a caller choice:
 * 0M.2A's lifecycle starts at DRAFT, and availability modifies a live Offer
 * rather than pre-standing-down one that was never live. Going live is a
 * separate, separately authorized act — and one this phase cannot reach.
 *
 * The Product and seller participant are verified to exist before the authority
 * decision, so a caller learns "no such Product" rather than a confusing refusal
 * about authority over something absent.
 */
export async function createDraftOffer(
  input: unknown,
  deps: OfferServiceDeps = {},
): Promise<OfferSnapshot> {
  const parsed = CreateDraftOfferInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const data = parsed.data;

  /* Canonicalize the interval at the edge, exactly as 0M.2A intends: the
     several convenient spellings of "no interval" fold to one canonical value
     before anything is stored, so absence has a single representation. */
  const effectiveInterval = normalizeOfferEffectiveIntervalInput(data.effectiveInterval);

  /* Computed, never supplied. The creator's accepted numbers are stored beside
     their inputs so they can be reproduced rather than recalculated later. */
  const economics = calculateOfferEconomics(data.terms);

  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoOfferIdProvider;
  const internalOfferId = ids.nextInternalOfferId();
  const offerSourceRecordId = ids.nextOfferSourceRecordId();
  const at = new Date(data.now);

  try {
    return await db.$transaction(async (tx) => {
      const product = await tx.product.findUnique({
        where: { internalProductId: data.internalProductId },
      });
      if (product === null) throw new OfferProductNotFoundError();

      const seller = await tx.marketplaceParticipant.findUnique({
        where: { id: data.sellerParticipantId },
      });
      if (seller === null) throw new SellerParticipantNotFoundError();

      const subject = await resolveSubject(tx, data.actingAccountId);

      requireAllowed(
        canCreateDraftOffer({
          subject,
          offerSellerParticipantId: data.sellerParticipantId,
          hasProductAuthority: data.hasProductAuthority,
        }),
      );

      /* Phase 1.16 — suspension withholds authoring; see the standing service. */
      await assertParticipantMayAuthorMarketplaceState(tx, data.sellerParticipantId);

      await tx.offer.create({
        data: {
          internalOfferId,
          offerSourceRecordId,
          currentSourceRecordVersion: "1",
          internalProductId: data.internalProductId,
          sellerParticipantId: data.sellerParticipantId,
          lifecycle: INITIAL_OFFER_LIFECYCLE_STATE,
          availability: "AVAILABLE",
        },
      });

      await tx.offerSourceRecordVersionRow.create({
        data: {
          offerSourceRecordId,
          sourceRecordVersion: "1",
          supersedesSourceRecordVersion: null,
          internalOfferId,
          sourceSystem: "monacado",
          sourceRecordType: "Offer",
          sourceClass: "governed-database-record",
          internalProductId: data.internalProductId,
          sellerParticipantId: data.sellerParticipantId,
          lifecycle: INITIAL_OFFER_LIFECYCLE_STATE,
          availability: "AVAILABLE",
          ...termsToColumns(data.terms),
          ...effectiveIntervalToColumns(effectiveInterval),
          calculatedCommissionMinorUnits: BigInt(economics.calculatedCommissionMinorUnits),
          calculatedCreatorGrossProceedsMinorUnits: BigInt(
            economics.calculatedCreatorGrossProceedsMinorUnits,
          ),
          commissionCalculationPolicyVersion: economics.commissionCalculationPolicyVersion,
          authorizedBySellerParticipantId: data.sellerParticipantId,
          authorizedByActorId: data.authorizedByActorId,
          recordedAt: at,
        },
      });

      return await readSnapshotInTx(tx, internalOfferId);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    if (isUniqueViolation(error)) throw new DuplicateOfferSourceVersionError(error);
    if (isForeignKeyViolation(error)) throw new OfferProductNotFoundError(error);
    throw new OfferPersistenceFailureError("createDraftOffer", error);
  }
}

/**
 * Pick the 0M.2A decision that governs this update.
 *
 * A lifecycle move is governed by the capability *for that move* — activating is
 * not the same authority as withdrawing, and 0M.2A gates them differently on
 * purpose: standing an Offer down deliberately does not require payment
 * readiness, so a seller whose payment capability was just restricted can still
 * stop selling. Everything else is a terms change.
 */
function decideUpdate(input: {
  subject: MarketplaceSubject;
  sellerParticipantId: string;
  hasProductAuthority: boolean;
  currentLifecycle: OfferLifecycleState;
  nextLifecycle: OfferLifecycleState;
  economicsContext:
    | {
        offerSourceRecordId: string;
        sourceRecordVersion: string;
        terms: OfferCommercialTerms;
        confirmation: UpdateOfferInput["economicsConfirmation"];
      }
    | undefined;
}): OfferAuthorityDecision {
  const request = {
    subject: input.subject,
    offerSellerParticipantId: input.sellerParticipantId,
    hasProductAuthority: input.hasProductAuthority,
    lifecycle: input.currentLifecycle,
    ...(input.economicsContext === undefined
      ? {}
      : {
          economicsContext: {
            ...input.economicsContext,
            confirmation: input.economicsContext.confirmation ?? null,
          },
        }),
  };

  if (input.nextLifecycle === input.currentLifecycle) return canChangeOfferTerms(request);

  switch (input.nextLifecycle) {
    case "ACTIVE":
      return input.currentLifecycle === "SUSPENDED"
        ? canResumeOffer(request)
        : canActivateOffer(request);
    case "SUSPENDED":
      return canSuspendOffer(request);
    case "ENDED":
      return canEndOffer(request);
    case "WITHDRAWN":
      return canWithdrawOffer(request);
    /* DRAFT is never a transition target: 0M.2A's table has no edge back to it,
       and the lifecycle decision below refuses the move regardless. Routing it
       through the terms-change decision keeps the refusal in the contract
       rather than inventing a second one here. */
    default:
      return canChangeOfferTerms(request);
  }
}

/**
 * Mint a new immutable source version from an authorized material change.
 *
 * The sequence, and each step matters:
 *
 *   1. read the current version — the comparison basis;
 *   2. build the next material state and ask `materialChangesBetween` whether it
 *      is a change at all — an update asserting nothing mints nothing;
 *   3. assemble the acting subject and honour the 0M.2A decision *for the
 *      action actually being performed*;
 *   4. recompute economics from the next terms, so stored amounts always match
 *      the terms beside them;
 *   5. insert the new version and advance the pointer **in one transaction**.
 *
 * Historical rows are never touched. The stable record's denormalized lifecycle
 * and availability move with the pointer in the same transaction, so they cannot
 * disagree with the version they point at.
 *
 * The lifecycle transition table is checked by the 0M.2A decision itself, which
 * denies with `OFFER_LIFECYCLE_TRANSITION_NOT_PERMITTED` or
 * `OFFER_LIFECYCLE_TERMINAL` — this service adds no second copy of that rule.
 */
export async function createOfferSourceVersion(
  input: unknown,
  deps: OfferServiceDeps = {},
): Promise<OfferSnapshot> {
  const parsed = UpdateOfferInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const data = parsed.data;

  const db = deps.db ?? getPrisma();
  const at = new Date(data.now);

  try {
    return await db.$transaction(async (tx) => {
      const stable = await tx.offer.findUnique({
        where: { internalOfferId: data.internalOfferId },
      });
      if (stable === null) throw new OfferNotFoundError();

      const currentRow = await tx.offerSourceRecordVersionRow.findUnique({
        where: {
          offerSourceRecordId_sourceRecordVersion: {
            offerSourceRecordId: stable.offerSourceRecordId,
            sourceRecordVersion: stable.currentSourceRecordVersion,
          },
        },
      });
      if (currentRow === null) {
        throw new CorruptOfferRecordError(["currentSourceRecordVersion"]);
      }
      const current = versionRowToSourceVersion(currentRow);

      const next = {
        internalProductId: current.internalProductId,
        sellerParticipantId: current.sellerParticipantId,
        lifecycle: data.lifecycle ?? current.lifecycle,
        availability: data.availability ?? current.availability,
        terms: data.terms ?? current.terms,
        effectiveInterval:
          data.effectiveInterval === undefined
            ? current.effectiveInterval
            : data.effectiveInterval,
      };

      const changed: MaterialOfferField[] = materialChangesBetween(
        {
          internalProductId: current.internalProductId,
          sellerParticipantId: current.sellerParticipantId,
          lifecycle: current.lifecycle,
          availability: current.availability,
          terms: current.terms,
          effectiveInterval: current.effectiveInterval,
        },
        next,
      );
      if (changed.length === 0) throw new NoMaterialOfferChangeError();

      const subject = await resolveSubject(tx, data.actingAccountId);

      requireAllowed(
        decideUpdate({
          subject,
          sellerParticipantId: current.sellerParticipantId,
          hasProductAuthority: data.hasProductAuthority,
          currentLifecycle: current.lifecycle,
          nextLifecycle: next.lifecycle,
          /* Supplied only when going live, which is the one action 0M.2A binds
             to a creator's exact-version economics confirmation. */
          economicsContext:
            next.lifecycle === "ACTIVE" && current.lifecycle !== "SUSPENDED"
              ? {
                  offerSourceRecordId: stable.offerSourceRecordId,
                  sourceRecordVersion: data.sourceRecordVersion,
                  terms: next.terms,
                  confirmation: data.economicsConfirmation ?? null,
                }
              : undefined,
        }),
      );

      /* Phase 1.15 — `offer:publish` reaches the act it is named for.
       *
       * Only the branch that makes the Offer commercially live: activation, and
       * resumption from SUSPENDED. Suspend, end, and withdraw are deliberately
       * untouched, on `canSuspendOffer`'s own reasoning — a seller whose commerce
       * was just withheld must still be able to take their Offer down, and
       * requiring an intact commerce gate to STOP selling would trap exactly the
       * seller who most needs to stop.
       *
       * Placed AFTER the authority decision and BEFORE the version row is
       * written, which is where the operational effect is chosen. The source
       * version is still authored — this refuses the lifecycle value that makes
       * it live, not the act of recording history. A restricted seller may still
       * mint versions correcting the work that caused the restriction.
       *
       * The status gate in `canActivateOffer` already refuses a non-ACTIVE
       * participant, so this is not the only thing standing here. It is the
       * SCOPE-specific one: without it, `offer:publish` bit only at checkout and
       * the participant's derived status did all the work at publication, which
       * is enforcement by coincidence rather than by the scope an operator
       * chose. */
      if (next.lifecycle === "ACTIVE" && current.lifecycle !== "ACTIVE") {
        await assertOfferMayBecomeCommerciallyLive(tx, current.sellerParticipantId);
      }

      /* Recomputed from the NEXT terms, never carried over: stored amounts and
         the terms beside them must never be able to disagree. */
      const economics = calculateOfferEconomics(next.terms);

      await tx.offerSourceRecordVersionRow.create({
        data: {
          offerSourceRecordId: stable.offerSourceRecordId,
          sourceRecordVersion: data.sourceRecordVersion,
          supersedesSourceRecordVersion: current.sourceRecordVersion,
          internalOfferId: data.internalOfferId,
          sourceSystem: "monacado",
          sourceRecordType: "Offer",
          sourceClass: "governed-database-record",
          internalProductId: next.internalProductId,
          sellerParticipantId: next.sellerParticipantId,
          lifecycle: next.lifecycle,
          availability: next.availability,
          ...termsToColumns(next.terms),
          ...effectiveIntervalToColumns(next.effectiveInterval),
          calculatedCommissionMinorUnits: BigInt(economics.calculatedCommissionMinorUnits),
          calculatedCreatorGrossProceedsMinorUnits: BigInt(
            economics.calculatedCreatorGrossProceedsMinorUnits,
          ),
          commissionCalculationPolicyVersion: economics.commissionCalculationPolicyVersion,
          authorizedBySellerParticipantId: current.sellerParticipantId,
          authorizedByActorId: data.authorizedByActorId,
          recordedAt: at,
        },
      });

      await tx.offer.update({
        where: { internalOfferId: data.internalOfferId },
        data: {
          currentSourceRecordVersion: data.sourceRecordVersion,
          lifecycle: next.lifecycle,
          availability: next.availability,
        },
      });

      return await readSnapshotInTx(tx, data.internalOfferId);
    });
  } catch (error) {
    if (isDomainError(error)) throw error;
    if (isUniqueViolation(error)) throw new DuplicateOfferSourceVersionError(error);
    throw new OfferPersistenceFailureError("createOfferSourceVersion", error);
  }
}
