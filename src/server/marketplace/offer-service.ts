/**
 * Offer persistence and Seller acts (Phase 0M.6; Phase 1.42) — SERVER ONLY.
 *
 * The ONLY path that writes an Offer. Since Phase 1.42 an Offer is the Seller's
 * commercial authority for promoted resale (Contract §12, §16, §19), and its
 * writes are Seller acts:
 *
 *   - `createOfferAs`            — a DRAFT Offer and its first STANDING version;
 *   - `reviseOfferTermsAs`       — a new STANDING version;
 *   - `activateOfferAs`          — DRAFT → ACTIVE, bound to the confirmed version;
 *   - `pauseOfferAs` / `resumeOfferAs` — ACTIVE ⇄ PAUSED; mint NO version;
 *   - `withdrawOfferAs`          — terminal;
 *   - `schedulePromotionAs` / `replacePromotionAs` — a SCHEDULED_PROMOTION version;
 *   - `endPromotionAs`           — an END_PROMOTION act.
 *
 * ## What is stored, and what is derived
 *
 * Versions hold commercial TERMS only — immutable full snapshots, labelled by
 * the server (`count + 1`), linked into one linear chain. Lifecycle is a linear
 * chain of `OfferAct` rows. Nothing stores ENDED, "promotion running", or the
 * effective terms: each is derived from these rows and an instant by the pure
 * contract (`deriveOfferLifecycleState`, `derivePromotionStatus`,
 * `effectiveOfferTerms`). No cron writes anything.
 *
 * ## Concurrency
 *
 * Every write locks the Product row (`FOR UPDATE`) before reading anything it
 * decides on, so all Offer acts on one Product — and Product activation,
 * suspension, revision, resale, and Promotion Authorization acts, which lock or
 * update the same row — serialise. The database backs that with uniques: one
 * version label per Offer, one non-terminal Offer per Product
 * (`nonTerminalForProductId`), one current act per Offer, and no forked act.
 * A uniqueness race is `OfferConflictError`; nothing from the losing request is
 * written.
 *
 * ## One non-terminal Offer per Product, with no cron
 *
 * `nonTerminalForProductId` is released on WITHDRAW. An Offer that reaches its
 * overall end is ENDED without a write, so its marker is still held; a later
 * create, under the Product lock, derives that holder ENDED at its own instant
 * and releases the marker before inserting. Deterministic, and never earlier
 * than the end.
 *
 * ## What it does not do
 *
 * No Promoter visibility, acceptance, Listing propagation, checkout or Order
 * change, publication, capsule, Node, notification, or payout. Product
 * lifecycle, resale, and readiness never rewrite the Offer lifecycle: they gate
 * activate and resume, and nothing else.
 */

import "../server-only";
import { Prisma } from "@prisma/client";
import type { OfferAct as OfferActRow, Offer as OfferRow, OfferSourceRecordVersionRow } from "@prisma/client";
import {
  ActivateOfferInput,
  CreateOfferInput,
  EndPromotionInput,
  PromotedResaleOfferTerms,
  ReplacePromotionInput,
  ResumeOfferInput,
  ReviseOfferTermsInput,
  SchedulePromotionInput,
  StandDownOfferInput,
  promotionTermsFrom,
  standingTermsFromRequest,
  usdMinorUnits,
  type OfferVersionConfirmation,
} from "../../contracts/marketplace/offer-record";
import {
  OFFER_CONFIRMATION_REASON_CODES,
  OfferPromotionWindow,
  RecordedOfferLifecycleState,
  calculateOfferEconomics,
  canActivateOffer,
  canChangeOfferTerms,
  canCreateDraftOffer,
  canEndPromotion,
  canPauseOffer,
  canResumeOffer,
  canSchedulePromotion,
  canWithdrawOffer,
  deriveOfferLifecycleState,
  derivePromotionStatus,
  evaluateOfferActivationReadiness,
  isPendingPromotionStatus,
  materialChangesBetween,
  type CreatorEconomicsConfirmation,
  type OfferActKind,
  type OfferAuthorityDecision,
  type OfferCommercialTerms,
  type OfferLifecycleState,
  type OfferPromotionStatus,
  type OfferSourceRecord,
  type OfferSourceVersion,
  type OfferTermsKind,
  type OfferTermsResolutionInput,
} from "../../contracts/marketplace/offer-source";
import { getPrisma } from "../db/client";
import { ProductNotAvailableError } from "../product/errors";
import { readProductLifecycleIn, readSellerReadinessFactsIn } from "../product/product-lifecycle-service";
import { resolveActingSubject } from "./acting-subject-service";
import { participantHoldsProductAuthority } from "./product-authority-service";
import {
  assertOfferMayBecomeCommerciallyLive,
  assertParticipantMayAuthorMarketplaceState,
  readParticipantStanding,
} from "./participant-standing-service";
import { ParticipantActionNotPermittedError } from "./participant-standing-errors";
import { cryptoOfferIdProvider, type OfferIdProvider } from "./offer-ids";
import {
  CorruptOfferRecordError,
  InvalidOfferInputError,
  NoMaterialOfferChangeError,
  OfferAlreadyExistsError,
  OfferConfirmationRequiredError,
  OfferError,
  OfferConflictError,
  OfferNotAuthorizedError,
  OfferNotFoundError,
  OfferNotReadyError,
  OfferPersistenceFailureError,
  OfferPromotionNotReplaceableError,
  OfferPromotionNotRunningError,
  OfferPromotionPendingError,
  OfferVersionNotFoundError,
  OfferVersionStaleError,
} from "./offer-errors";
import {
  offerRowToSourceRecord,
  promotionWindowToColumns,
  termsToColumns,
  versionRowToSourceVersion,
} from "./offer-mapper";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export interface OfferServiceDeps {
  db?: Db;
  ids?: OfferIdProvider;
}

export interface OfferSnapshot {
  record: OfferSourceRecord;
  currentVersion: OfferSourceVersion;
}

/** What every Seller act answers with — references and derived state only. */
export interface OfferActResult {
  productRef: string;
  offerRef: string;
  state: OfferLifecycleState;
  standingVersion: string;
  promotionVersion: string | null;
}

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

function inputError(error: { issues: Array<{ path: PropertyKey[] }> }): InvalidOfferInputError {
  return new InvalidOfferInputError(Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))));
}

function parse<T extends { safeParse(input: unknown): { success: true; data: unknown } | { success: false; error: { issues: Array<{ path: PropertyKey[] }> } } }>(
  schema: T,
  input: unknown,
): Extract<ReturnType<T["safeParse"]>, { success: true }>["data"] {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  return parsed.data as never;
}

function requireAllowed(decision: OfferAuthorityDecision): void {
  if (decision.decision === "ALLOW") return;
  throw new OfferNotAuthorizedError(decision.capability, [...decision.reasonCodes]);
}

/**
 * As `requireAllowed`, but a refusal that is ONLY about the confirmation carries
 * the server's disclosure of the exact version the Seller must confirm.
 */
function requireAllowedOrDisclose(
  decision: OfferAuthorityDecision,
  version: string,
  terms: OfferCommercialTerms,
): void {
  if (decision.decision === "ALLOW") return;
  const reasons = [...decision.reasonCodes];
  if (reasons.every((r) => (OFFER_CONFIRMATION_REASON_CODES as readonly string[]).includes(r))) {
    const economics = calculateOfferEconomics(terms);
    throw new OfferConfirmationRequiredError(decision.capability, reasons, {
      version,
      calculatedCommissionMinorUnits: economics.calculatedCommissionMinorUnits,
      calculatedSellerGrossProceedsMinorUnits: economics.calculatedCreatorGrossProceedsMinorUnits,
      commissionCalculationPolicyVersion: economics.commissionCalculationPolicyVersion,
    });
  }
  throw new OfferNotAuthorizedError(decision.capability, reasons);
}

/** Errors that pass through unwrapped; anything else is a persistence failure. */
function isDomainError(error: unknown): boolean {
  /* A governed standing refusal is a DOMAIN answer, not an outage (Phase 1.15);
     wrapped as a persistence failure it would lose its bounded denial code. */
  return (
    error instanceof ParticipantActionNotPermittedError ||
    error instanceof ProductNotAvailableError ||
    (error instanceof OfferError && !(error instanceof OfferPersistenceFailureError))
  );
}

// — Reads by internal id (0M.6) —

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
     written transaction; reading it back must fail loudly. */
  if (currentVersion === null) throw new CorruptOfferRecordError(["currentSourceRecordVersion"]);
  return {
    record: offerRowToSourceRecord(row, currentVersion),
    currentVersion: versionRowToSourceVersion(currentVersion),
  };
}

/** Read one Offer with its current STANDING version. */
export async function getOffer(internalOfferId: string, deps: OfferServiceDeps = {}): Promise<OfferSnapshot> {
  const db = deps.db ?? getPrisma();
  try {
    return await readSnapshotInTx(db, internalOfferId);
  } catch (error) {
    if (isDomainError(error)) throw error;
    throw new OfferPersistenceFailureError("getOffer", error);
  }
}

/** The current STANDING version. */
export async function getCurrentSourceVersion(
  internalOfferId: string,
  deps: OfferServiceDeps = {},
): Promise<OfferSourceVersion> {
  return (await getOffer(internalOfferId, deps)).currentVersion;
}

/**
 * One exact historical version, STANDING or SCHEDULED_PROMOTION. Never "the
 * latest": this is the read an exact-version binding resolves through.
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

/** Every version, oldest first — one linear chain of standing and promotion versions. */
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

// — Derived state —

/** Everything the lifecycle and the resolver decide on, read from one Offer's rows. */
export interface OfferStateRead {
  offer: OfferRow;
  /** The current act, or `null` for a DRAFT that was never acted on. */
  currentAct: OfferActRow | null;
  resolution: OfferTermsResolutionInput;
  standing: OfferSourceVersion;
  promotion: OfferSourceVersion | null;
  versionCount: number;
}

/** Read one Offer's acts and current versions. Reads only; takes a transaction. */
export async function readOfferStateIn(tx: Tx, offer: OfferRow): Promise<OfferStateRead> {
  const [currentAct, activation, versionCount, versionRows] = await Promise.all([
    tx.offerAct.findUnique({ where: { currentForOfferId: offer.internalOfferId } }),
    tx.offerAct.findFirst({ where: { internalOfferId: offer.internalOfferId, act: "ACTIVATE" } }),
    tx.offerSourceRecordVersionRow.count({ where: { internalOfferId: offer.internalOfferId } }),
    tx.offerSourceRecordVersionRow.findMany({
      where: {
        offerSourceRecordId: offer.offerSourceRecordId,
        sourceRecordVersion: {
          in: [offer.currentSourceRecordVersion, ...(offer.currentPromotionVersion === null ? [] : [offer.currentPromotionVersion])],
        },
      },
    }),
  ]);
  const byLabel = new Map(versionRows.map((r) => [r.sourceRecordVersion, r]));
  const standingRow = byLabel.get(offer.currentSourceRecordVersion);
  if (standingRow === undefined) throw new CorruptOfferRecordError(["currentSourceRecordVersion"]);
  const standing = versionRowToSourceVersion(standingRow);
  if (standing.termsKind !== "STANDING") throw new CorruptOfferRecordError(["currentSourceRecordVersion"]);

  let promotion: OfferSourceVersion | null = null;
  let endedEarlyAt: string | null = null;
  if (offer.currentPromotionVersion !== null) {
    const row = byLabel.get(offer.currentPromotionVersion);
    if (row === undefined) throw new CorruptOfferRecordError(["currentPromotionVersion"]);
    promotion = versionRowToSourceVersion(row);
    if (promotion.promotionWindow === null) throw new CorruptOfferRecordError(["currentPromotionVersion"]);
    const ended = await tx.offerAct.findFirst({
      where: {
        internalOfferId: offer.internalOfferId,
        act: "END_PROMOTION",
        endedPromotionVersion: offer.currentPromotionVersion,
      },
    });
    endedEarlyAt = ended === null ? null : ended.actedAt.toISOString();
  }

  let recordedState: RecordedOfferLifecycleState | null = null;
  if (currentAct !== null) {
    const parsed = RecordedOfferLifecycleState.safeParse(currentAct.state);
    if (!parsed.success) throw new CorruptOfferRecordError(["acts.state"]);
    recordedState = parsed.data;
  }

  return {
    offer,
    currentAct,
    resolution: {
      recordedState,
      offerEffectiveUntil: activation?.offerEffectiveUntil?.toISOString() ?? null,
      standingVersion: standing.sourceRecordVersion,
      promotion:
        promotion === null
          ? null
          : {
              sourceRecordVersion: promotion.sourceRecordVersion,
              window: promotion.promotionWindow!,
              endedEarlyAt,
            },
    },
    standing,
    promotion,
    versionCount,
  };
}

export function lifecycleAt(state: OfferStateRead, at: string): OfferLifecycleState {
  return deriveOfferLifecycleState({
    recordedState: state.resolution.recordedState,
    offerEffectiveUntil: state.resolution.offerEffectiveUntil,
    at,
  });
}

export function promotionStatusAt(state: OfferStateRead, at: string): OfferPromotionStatus | null {
  const promotion = state.resolution.promotion;
  if (promotion === null) return null;
  return derivePromotionStatus({ window: promotion.window, endedEarlyAt: promotion.endedEarlyAt, replacedAt: null, at });
}

/**
 * The Offer's CURRENT derived lifecycle, by source-record id — the read Listing
 * eligibility and checkout use for "does the Seller currently offer this"
 * (Phase 1.15, Ruling 1). `null` when no such Offer exists.
 */
export async function readOfferLifecycleBySourceRecordIn(
  tx: Tx,
  offerSourceRecordId: string,
  at: string,
): Promise<OfferLifecycleState | null> {
  const offer = await tx.offer.findUnique({ where: { offerSourceRecordId } });
  if (offer === null) return null;
  return lifecycleAt(await readOfferStateIn(tx, offer), at);
}

// — Write helpers —

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

async function sellerParticipantIdOf(tx: Tx, accountId: string): Promise<string | null> {
  const participant = await tx.marketplaceParticipant.findUnique({ where: { accountId }, select: { id: true } });
  return participant?.id ?? null;
}

/**
 * The Offer named, on this Product, controlled by this Seller. Another Seller's
 * Offer, an unknown reference, and an Offer on another Product are one 404.
 */
async function ownedOffer(
  tx: Prisma.TransactionClient,
  internalProductId: string,
  offerRef: string,
  sellerParticipantId: string | null,
): Promise<OfferRow> {
  const offer = await tx.offer.findUnique({ where: { offerRef } });
  if (offer === null || offer.internalProductId !== internalProductId || offer.sellerParticipantId !== sellerParticipantId) {
    throw new OfferNotFoundError();
  }
  return offer;
}

/** Map a uniqueness race to the module's conflict; domain errors pass through. */
async function inTransaction<T>(db: Db, stage: string, run: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  try {
    return await db.$transaction(run);
  } catch (error) {
    if (isUniqueViolation(error)) throw new OfferConflictError(error);
    if (isDomainError(error)) throw error;
    throw new OfferPersistenceFailureError(stage, error);
  }
}

/** The Seller's HTTP confirmation, bound to THIS Offer's source record. */
function bindConfirmation(
  offer: OfferRow,
  confirmation: OfferVersionConfirmation | null | undefined,
): CreatorEconomicsConfirmation | null {
  if (confirmation === null || confirmation === undefined) return null;
  return {
    confirmedOfferSourceRecordId: offer.offerSourceRecordId,
    confirmedOfferSourceRecordVersion: confirmation.version,
    calculatedCommissionMinorUnits: confirmation.calculatedCommissionMinorUnits,
    calculatedCreatorGrossProceedsMinorUnits: confirmation.calculatedSellerGrossProceedsMinorUnits,
    commissionCalculationPolicyVersion: confirmation.commissionCalculationPolicyVersion,
  };
}

/** Labels are allocated by the server: the next integer in this Offer's chain. */
const nextLabel = (state: { versionCount: number }): string => String(state.versionCount + 1);

async function insertVersion(
  tx: Prisma.TransactionClient,
  offer: OfferRow,
  version: {
    label: string;
    supersedes: string | null;
    termsKind: OfferTermsKind;
    terms: OfferCommercialTerms;
    window: OfferPromotionWindow | null;
    basisStandingVersion: string | null;
    actingAccountId: string;
    recordedAt: Date;
  },
): Promise<void> {
  const economics = calculateOfferEconomics(version.terms);
  await tx.offerSourceRecordVersionRow.create({
    data: {
      offerSourceRecordId: offer.offerSourceRecordId,
      sourceRecordVersion: version.label,
      supersedesSourceRecordVersion: version.supersedes,
      internalOfferId: offer.internalOfferId,
      sourceSystem: "monacado",
      sourceRecordType: "Offer",
      sourceClass: "governed-database-record",
      internalProductId: offer.internalProductId,
      sellerParticipantId: offer.sellerParticipantId,
      termsKind: version.termsKind,
      basisStandingVersion: version.basisStandingVersion,
      ...termsToColumns(version.terms),
      ...promotionWindowToColumns(version.window),
      calculatedCommissionMinorUnits: BigInt(economics.calculatedCommissionMinorUnits),
      calculatedCreatorGrossProceedsMinorUnits: BigInt(economics.calculatedCreatorGrossProceedsMinorUnits),
      commissionCalculationPolicyVersion: economics.commissionCalculationPolicyVersion,
      authorizedBySellerParticipantId: offer.sellerParticipantId,
      authorizedByActorId: version.actingAccountId,
      recordedAt: version.recordedAt,
    },
  });
}

/** Append one act: release the current act's marker, then record the new current act. */
async function appendAct(
  tx: Prisma.TransactionClient,
  ids: OfferIdProvider,
  state: OfferStateRead,
  act: {
    act: OfferActKind;
    from: OfferLifecycleState;
    to: RecordedOfferLifecycleState;
    activatedStandingVersion?: string;
    offerEffectiveUntil?: Date | null;
    endedPromotionVersion?: string;
    actorParticipantId: string;
    actedByAccountId: string;
    actedAt: Date;
  },
): Promise<void> {
  const internalOfferId = state.offer.internalOfferId;
  if (state.currentAct !== null) {
    await tx.offerAct.update({ where: { id: state.currentAct.id }, data: { currentForOfferId: null } });
  }
  await tx.offerAct.create({
    data: {
      id: ids.nextOfferActId(),
      internalOfferId,
      act: act.act,
      state: act.to,
      previousState: act.from,
      supersedesActId: state.currentAct?.id ?? null,
      currentForOfferId: internalOfferId,
      activatedStandingVersion: act.activatedStandingVersion ?? null,
      offerEffectiveUntil: act.offerEffectiveUntil ?? null,
      endedPromotionVersion: act.endedPromotionVersion ?? null,
      actorParticipantId: act.actorParticipantId,
      actedByAccountId: act.actedByAccountId,
      actedAt: act.actedAt,
    },
  });
}

async function resultOf(
  tx: Prisma.TransactionClient,
  productRef: string,
  internalOfferId: string,
  at: string,
): Promise<OfferActResult> {
  const offer = await tx.offer.findUniqueOrThrow({ where: { internalOfferId } });
  const state = await readOfferStateIn(tx, offer);
  return {
    productRef,
    offerRef: offer.offerRef,
    state: lifecycleAt(state, at),
    standingVersion: offer.currentSourceRecordVersion,
    promotionVersion: offer.currentPromotionVersion,
  };
}

/**
 * Activation and resumption readiness, from the one Product lifecycle reader
 * and the one Seller-readiness reader. Throws `OfferNotReadyError` with every
 * blocker. Resale availability, Promotion Authorization, Storefronts, Listings,
 * and Promoters are deliberately not read.
 *
 * Then the governed `offer:publish` seam (Phase 1.15), which reads the same
 * standing rows: readiness has already reported a restriction or suspension as
 * a blocker, so this never refuses a Seller readiness let through — it keeps
 * going-live routed through the one seam the restriction register names.
 * Stand-downs (pause, withdraw, ending a promotion) call neither.
 */
async function assertReadyToGoLive(
  tx: Prisma.TransactionClient,
  internalProductId: string,
  sellerParticipantId: string,
): Promise<void> {
  const [product, readiness, standing] = await Promise.all([
    readProductLifecycleIn(tx, internalProductId),
    readSellerReadinessFactsIn(tx, sellerParticipantId),
    readParticipantStanding(tx, sellerParticipantId),
  ]);
  const verdict = evaluateOfferActivationReadiness({
    productActive:
      product !== null &&
      product.lifecycle.lifecycle === "ACTIVE" &&
      product.authorityParticipantId === sellerParticipantId,
    account: readiness.account,
    participant:
      readiness.participant === null
        ? null
        : {
            status: readiness.participant.status,
            suspended: readiness.participant.suspended,
            offerPublishRestricted: standing.activeScopes.includes("offer:publish"),
            sellerRoleStatus: readiness.participant.sellerRoleStatus,
            paymentReadiness: readiness.participant.paymentReadiness,
            commerceApproval: readiness.participant.commerceApproval,
          },
  });
  if (!verdict.ready) throw new OfferNotReadyError(verdict.blockers);
  await assertOfferMayBecomeCommerciallyLive(tx, sellerParticipantId);
}

/** Shared preamble for an act on an existing Offer: Product, Seller, lock, Offer, state. */
async function withOwnedOffer<T>(
  db: Db,
  stage: string,
  actor: { accountId: string },
  selectors: { productRef: string; offerRef: string },
  run: (ctx: {
    tx: Prisma.TransactionClient;
    product: { internalProductId: string; productRef: string };
    state: OfferStateRead;
    sellerParticipantId: string;
  }) => Promise<T>,
): Promise<T> {
  const product = await findProduct(db, selectors.productRef);
  const sellerParticipantId = await sellerParticipantIdOf(db, actor.accountId);
  if (sellerParticipantId === null) throw new OfferNotFoundError();
  return await inTransaction(db, stage, async (tx) => {
    await lockProduct(tx, product.internalProductId);
    const offer = await ownedOffer(tx, product.internalProductId, selectors.offerRef, sellerParticipantId);
    const state = await readOfferStateIn(tx, offer);
    return await run({ tx, product, state, sellerParticipantId });
  });
}

async function authorityFacts(tx: Prisma.TransactionClient, accountId: string, state: OfferStateRead) {
  const subject = await resolveActingSubject(tx, accountId);
  const hasProductAuthority = await participantHoldsProductAuthority(
    tx,
    state.offer.internalProductId,
    subject.participant?.participantId ?? null,
  );
  return { subject, offerSellerParticipantId: state.offer.sellerParticipantId, hasProductAuthority };
}

function termsOf(request: Parameters<typeof standingTermsFromRequest>[0]): OfferCommercialTerms {
  const converted = standingTermsFromRequest(request);
  if (!converted.ok) throw new InvalidOfferInputError(converted.fields);
  return parseTerms(converted.terms, "terms");
}

function parseTerms(candidate: unknown, pathPrefix: string): OfferCommercialTerms {
  const parsed = PromotedResaleOfferTerms.safeParse(candidate);
  if (!parsed.success) {
    throw new InvalidOfferInputError(
      Array.from(new Set(parsed.error.issues.map((i) => [pathPrefix, ...i.path.map(String)].join(".")))),
    );
  }
  return parsed.data;
}

// — Acts —

/** Why creating an Offer on a Product would be refused, in the create's own order. */
export type OfferCreationRefusal =
  | { kind: "PRODUCT_NOT_AVAILABLE" }
  | { kind: "NOT_AUTHORIZED"; decision: OfferAuthorityDecision }
  | { kind: "PARTICIPANT_NOT_PERMITTED"; error: ParticipantActionNotPermittedError }
  | { kind: "ALREADY_EXISTS" };

/**
 * The create operation's gates, evaluated without writing: Seller authority over
 * the Product, the drafting gates, suspension, and the Product's non-terminal
 * marker at `at`. A holder derived ENDED at `at` does not block; it is returned
 * for the create to release.
 *
 * `createOfferAs` refuses exactly when this does, and the Seller's read model
 * asks this same question for `canCreate` — one rule, not two that can drift.
 */
export async function evaluateOfferCreationIn(
  tx: Tx,
  accountId: string,
  internalProductId: string,
  at: string,
): Promise<
  | { allowed: true; sellerParticipantId: string; endedHolderId: string | null }
  | { allowed: false; refusal: OfferCreationRefusal }
> {
  const subject = await resolveActingSubject(tx, accountId);
  const sellerParticipantId = subject.participant?.participantId ?? null;
  const hasProductAuthority = await participantHoldsProductAuthority(tx, internalProductId, sellerParticipantId);
  if (sellerParticipantId === null || !hasProductAuthority) {
    return { allowed: false, refusal: { kind: "PRODUCT_NOT_AVAILABLE" } };
  }

  const decision = canCreateDraftOffer({ subject, offerSellerParticipantId: sellerParticipantId, hasProductAuthority });
  if (decision.decision !== "ALLOW") return { allowed: false, refusal: { kind: "NOT_AUTHORIZED", decision } };
  /* Phase 1.16 — suspension withholds authoring. */
  try {
    await assertParticipantMayAuthorMarketplaceState(tx, sellerParticipantId);
  } catch (error) {
    if (error instanceof ParticipantActionNotPermittedError) {
      return { allowed: false, refusal: { kind: "PARTICIPANT_NOT_PERMITTED", error } };
    }
    throw error;
  }

  const holder = await tx.offer.findUnique({ where: { nonTerminalForProductId: internalProductId } });
  if (holder === null) return { allowed: true, sellerParticipantId, endedHolderId: null };
  if (lifecycleAt(await readOfferStateIn(tx, holder), at) !== "ENDED") {
    return { allowed: false, refusal: { kind: "ALREADY_EXISTS" } };
  }
  return { allowed: true, sellerParticipantId, endedHolderId: holder.internalOfferId };
}

/**
 * Create a DRAFT Offer and its first STANDING version (label "1").
 *
 * Unknown Product and another Seller's Product are one 404. Refuses with
 * `OfferAlreadyExistsError` while the Product's non-terminal Offer is DRAFT,
 * ACTIVE, or PAUSED; releases the marker of one derived ENDED at `now`.
 */
export async function createOfferAs(
  actor: { accountId: string },
  input: unknown,
  deps: OfferServiceDeps = {},
): Promise<OfferActResult> {
  const data = parse(CreateOfferInput, input);
  const terms = termsOf(data.terms);
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoOfferIdProvider;
  const product = await findProduct(db, data.productRef);

  return await inTransaction(db, "createOffer", async (tx) => {
    await lockProduct(tx, product.internalProductId);
    const gate = await evaluateOfferCreationIn(tx, actor.accountId, product.internalProductId, data.now);
    if (!gate.allowed) {
      const refusal = gate.refusal;
      switch (refusal.kind) {
        case "PRODUCT_NOT_AVAILABLE":
          throw new ProductNotAvailableError();
        case "NOT_AUTHORIZED":
          throw new OfferNotAuthorizedError(refusal.decision.capability, [...refusal.decision.reasonCodes]);
        case "PARTICIPANT_NOT_PERMITTED":
          throw refusal.error;
        case "ALREADY_EXISTS":
          throw new OfferAlreadyExistsError();
      }
    }
    const { sellerParticipantId } = gate;
    if (gate.endedHolderId !== null) {
      /* Derived ENDED at this transaction's instant: release, keep everything else. */
      await tx.offer.update({ where: { internalOfferId: gate.endedHolderId }, data: { nonTerminalForProductId: null } });
    }

    const internalOfferId = ids.nextInternalOfferId();
    const offer = await tx.offer.create({
      data: {
        internalOfferId,
        offerRef: ids.nextOfferRef(),
        offerSourceRecordId: ids.nextOfferSourceRecordId(),
        currentSourceRecordVersion: "1",
        currentPromotionVersion: null,
        internalProductId: product.internalProductId,
        nonTerminalForProductId: product.internalProductId,
        sellerParticipantId,
      },
    });
    await insertVersion(tx, offer, {
      label: "1",
      supersedes: null,
      termsKind: "STANDING",
      terms,
      window: null,
      basisStandingVersion: null,
      actingAccountId: actor.accountId,
      recordedAt: new Date(data.now),
    });
    return await resultOf(tx, product.productRef, internalOfferId, data.now);
  });
}

/**
 * Revise the STANDING terms: a new STANDING version, with the pointer moved.
 *
 * DRAFT: drafting gates. ACTIVE / PAUSED: commerce gates and the Seller's
 * confirmation of the exact label being minted; the lifecycle is untouched
 * (PAUSED stays PAUSED). Refused while a promotion is SCHEDULED or RUNNING — its
 * commission is the standing one, and silently changing what it was built on is
 * not something the Seller confirmed.
 */
export async function reviseOfferTermsAs(
  actor: { accountId: string },
  input: unknown,
  deps: OfferServiceDeps = {},
): Promise<OfferActResult> {
  const data = parse(ReviseOfferTermsInput, input);
  const terms = termsOf(data.terms);
  const db = deps.db ?? getPrisma();

  return await withOwnedOffer(db, "reviseOfferTerms", actor, data, async ({ tx, product, state }) => {
    if (data.expectedVersion !== state.offer.currentSourceRecordVersion) throw new OfferVersionStaleError();
    const lifecycle = lifecycleAt(state, data.now);
    const promotion = promotionStatusAt(state, data.now);
    if (lifecycle !== "WITHDRAWN" && lifecycle !== "ENDED" && promotion !== null && isPendingPromotionStatus(promotion)) {
      throw new OfferPromotionPendingError();
    }

    const changed = materialChangesBetween(state.standing, { ...state.standing, terms });
    if (changed.length === 0) throw new NoMaterialOfferChangeError();

    const label = nextLabel(state);
    requireAllowedOrDisclose(
      canChangeOfferTerms({
        ...(await authorityFacts(tx, actor.accountId, state)),
        lifecycle,
        economicsContext: {
          offerSourceRecordId: state.offer.offerSourceRecordId,
          sourceRecordVersion: label,
          terms,
          confirmation: bindConfirmation(state.offer, data.confirmation),
        },
      }),
      label,
      terms,
    );

    await insertVersion(tx, state.offer, {
      label,
      supersedes: String(state.versionCount),
      termsKind: "STANDING",
      terms,
      window: null,
      basisStandingVersion: null,
      actingAccountId: actor.accountId,
      recordedAt: new Date(data.now),
    });
    await tx.offer.update({
      where: { internalOfferId: state.offer.internalOfferId },
      data: { currentSourceRecordVersion: label },
    });
    return await resultOf(tx, product.productRef, state.offer.internalOfferId, data.now);
  });
}

/** DRAFT → ACTIVE, bound to the exact confirmed STANDING version. */
export async function activateOfferAs(
  actor: { accountId: string },
  input: unknown,
  deps: OfferServiceDeps = {},
): Promise<OfferActResult> {
  const data = parse(ActivateOfferInput, input);
  const until = data.effectiveUntil ?? null;
  if (until !== null && Date.parse(until) <= Date.parse(data.now)) {
    throw new InvalidOfferInputError(["effectiveUntil"]);
  }
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoOfferIdProvider;

  return await withOwnedOffer(db, "activateOffer", actor, data, async ({ tx, product, state, sellerParticipantId }) => {
    const lifecycle = lifecycleAt(state, data.now);
    requireAllowedOrDisclose(
      canActivateOffer({
        ...(await authorityFacts(tx, actor.accountId, state)),
        lifecycle,
        economicsContext: {
          offerSourceRecordId: state.offer.offerSourceRecordId,
          sourceRecordVersion: state.standing.sourceRecordVersion,
          terms: state.standing.terms,
          confirmation: bindConfirmation(state.offer, data.confirmation),
        },
      }),
      state.standing.sourceRecordVersion,
      state.standing.terms,
    );
    await assertReadyToGoLive(tx, state.offer.internalProductId, sellerParticipantId);
    await appendAct(tx, ids, state, {
      act: "ACTIVATE",
      from: lifecycle,
      to: "ACTIVE",
      activatedStandingVersion: state.standing.sourceRecordVersion,
      offerEffectiveUntil: until === null ? null : new Date(until),
      actorParticipantId: sellerParticipantId,
      actedByAccountId: actor.accountId,
      actedAt: new Date(data.now),
    });
    return await resultOf(tx, product.productRef, state.offer.internalOfferId, data.now);
  });
}

/** ACTIVE → PAUSED. Mints no version. A stand-down: no readiness gate. */
export async function pauseOfferAs(
  actor: { accountId: string },
  input: unknown,
  deps: OfferServiceDeps = {},
): Promise<OfferActResult> {
  const data = parse(StandDownOfferInput, input);
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoOfferIdProvider;
  return await withOwnedOffer(db, "pauseOffer", actor, data, async ({ tx, product, state, sellerParticipantId }) => {
    const lifecycle = lifecycleAt(state, data.now);
    requireAllowed(canPauseOffer({ ...(await authorityFacts(tx, actor.accountId, state)), lifecycle }));
    await appendAct(tx, ids, state, {
      act: "PAUSE",
      from: lifecycle,
      to: "PAUSED",
      actorParticipantId: sellerParticipantId,
      actedByAccountId: actor.accountId,
      actedAt: new Date(data.now),
    });
    return await resultOf(tx, product.productRef, state.offer.internalOfferId, data.now);
  });
}

/**
 * PAUSED → ACTIVE under the current STANDING version, which must be the one the
 * Seller was looking at. Mints no version. Requires Product ACTIVE and current
 * Seller readiness, exactly as activation does.
 */
export async function resumeOfferAs(
  actor: { accountId: string },
  input: unknown,
  deps: OfferServiceDeps = {},
): Promise<OfferActResult> {
  const data = parse(ResumeOfferInput, input);
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoOfferIdProvider;
  return await withOwnedOffer(db, "resumeOffer", actor, data, async ({ tx, product, state, sellerParticipantId }) => {
    if (data.expectedVersion !== state.offer.currentSourceRecordVersion) throw new OfferVersionStaleError();
    const lifecycle = lifecycleAt(state, data.now);
    requireAllowed(canResumeOffer({ ...(await authorityFacts(tx, actor.accountId, state)), lifecycle }));
    await assertReadyToGoLive(tx, state.offer.internalProductId, sellerParticipantId);
    await appendAct(tx, ids, state, {
      act: "RESUME",
      from: lifecycle,
      to: "ACTIVE",
      actorParticipantId: sellerParticipantId,
      actedByAccountId: actor.accountId,
      actedAt: new Date(data.now),
    });
    return await resultOf(tx, product.productRef, state.offer.internalOfferId, data.now);
  });
}

/** DRAFT / ACTIVE / PAUSED → WITHDRAWN. Terminal; releases the Product's marker. */
export async function withdrawOfferAs(
  actor: { accountId: string },
  input: unknown,
  deps: OfferServiceDeps = {},
): Promise<OfferActResult> {
  const data = parse(StandDownOfferInput, input);
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoOfferIdProvider;
  return await withOwnedOffer(db, "withdrawOffer", actor, data, async ({ tx, product, state, sellerParticipantId }) => {
    const lifecycle = lifecycleAt(state, data.now);
    requireAllowed(canWithdrawOffer({ ...(await authorityFacts(tx, actor.accountId, state)), lifecycle }));
    await appendAct(tx, ids, state, {
      act: "WITHDRAW",
      from: lifecycle,
      to: "WITHDRAWN",
      actorParticipantId: sellerParticipantId,
      actedByAccountId: actor.accountId,
      actedAt: new Date(data.now),
    });
    await tx.offer.update({
      where: { internalOfferId: state.offer.internalOfferId },
      data: { nonTerminalForProductId: null },
    });
    return await resultOf(tx, product.productRef, state.offer.internalOfferId, data.now);
  });
}

/** Shared by schedule and replace: validate the window and terms, decide, mint, point. */
async function mintPromotion(
  ctx: { tx: Prisma.TransactionClient; product: { productRef: string }; state: OfferStateRead },
  actor: { accountId: string },
  data: SchedulePromotionInput,
): Promise<OfferActResult> {
  const { tx, state } = ctx;
  if (data.expectedVersion !== state.offer.currentSourceRecordVersion) throw new OfferVersionStaleError();
  const window = OfferPromotionWindow.safeParse({ effectiveFrom: data.effectiveFrom, effectiveUntil: data.effectiveUntil });
  if (!window.success) throw inputError(window.error);
  /* May be scheduled in advance, never backdated: a window that has already
     opened would reprice sales the Seller never confirmed it for. */
  if (Date.parse(window.data.effectiveFrom) < Date.parse(data.now)) {
    throw new InvalidOfferInputError(["effectiveFrom"]);
  }
  const wholesale = usdMinorUnits(data.wholesalePrice);
  if (wholesale === null) throw new InvalidOfferInputError(["wholesalePrice"]);
  const terms = parseTerms(promotionTermsFrom(state.standing.terms, wholesale), "promotion");

  const label = nextLabel(state);
  requireAllowedOrDisclose(
    canSchedulePromotion({
      ...(await authorityFacts(tx, actor.accountId, state)),
      lifecycle: lifecycleAt(state, data.now),
      economicsContext: {
        offerSourceRecordId: state.offer.offerSourceRecordId,
        sourceRecordVersion: label,
        terms,
        confirmation: bindConfirmation(state.offer, data.confirmation),
      },
    }),
    label,
    terms,
  );

  await insertVersion(tx, state.offer, {
    label,
    supersedes: String(state.versionCount),
    termsKind: "SCHEDULED_PROMOTION",
    terms,
    window: window.data,
    basisStandingVersion: state.standing.sourceRecordVersion,
    actingAccountId: actor.accountId,
    recordedAt: new Date(data.now),
  });
  await tx.offer.update({
    where: { internalOfferId: state.offer.internalOfferId },
    data: { currentPromotionVersion: label },
  });
  return await resultOf(tx, ctx.product.productRef, state.offer.internalOfferId, data.now);
}

/** Schedule a promotion. Refused while another is SCHEDULED or RUNNING. */
export async function schedulePromotionAs(
  actor: { accountId: string },
  input: unknown,
  deps: OfferServiceDeps = {},
): Promise<OfferActResult> {
  const data = parse(SchedulePromotionInput, input);
  const db = deps.db ?? getPrisma();
  return await withOwnedOffer(db, "schedulePromotion", actor, data, async (ctx) => {
    const status = promotionStatusAt(ctx.state, data.now);
    if (status !== null && isPendingPromotionStatus(status)) throw new OfferPromotionPendingError();
    return await mintPromotion(ctx, actor, data);
  });
}

/**
 * Replace the current promotion before it begins. The replaced version stays in
 * history (derived CANCELLED); the pointer moves to the new one.
 */
export async function replacePromotionAs(
  actor: { accountId: string },
  input: unknown,
  deps: OfferServiceDeps = {},
): Promise<OfferActResult> {
  const data = parse(ReplacePromotionInput, input);
  const db = deps.db ?? getPrisma();
  return await withOwnedOffer(db, "replacePromotion", actor, data, async (ctx) => {
    if (data.expectedPromotionVersion !== ctx.state.offer.currentPromotionVersion) throw new OfferVersionStaleError();
    if (promotionStatusAt(ctx.state, data.now) !== "SCHEDULED") throw new OfferPromotionNotReplaceableError();
    const { expectedPromotionVersion: _expected, ...schedule } = data;
    return await mintPromotion(ctx, actor, schedule);
  });
}

/** End the RUNNING promotion now; the standing terms apply from this instant. */
export async function endPromotionAs(
  actor: { accountId: string },
  input: unknown,
  deps: OfferServiceDeps = {},
): Promise<OfferActResult> {
  const data = parse(EndPromotionInput, input);
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoOfferIdProvider;
  return await withOwnedOffer(db, "endPromotion", actor, data, async ({ tx, product, state, sellerParticipantId }) => {
    if (data.expectedPromotionVersion !== state.offer.currentPromotionVersion) throw new OfferVersionStaleError();
    const lifecycle = lifecycleAt(state, data.now);
    requireAllowed(canEndPromotion({ ...(await authorityFacts(tx, actor.accountId, state)), lifecycle }));
    if (promotionStatusAt(state, data.now) !== "RUNNING") throw new OfferPromotionNotRunningError();
    const recorded = state.resolution.recordedState;
    if (recorded === null || recorded === "WITHDRAWN") throw new OfferPromotionNotRunningError();
    await appendAct(tx, ids, state, {
      act: "END_PROMOTION",
      from: recorded,
      to: recorded,
      endedPromotionVersion: data.expectedPromotionVersion,
      actorParticipantId: sellerParticipantId,
      actedByAccountId: actor.accountId,
      actedAt: new Date(data.now),
    });
    return await resultOf(tx, product.productRef, state.offer.internalOfferId, data.now);
  });
}
