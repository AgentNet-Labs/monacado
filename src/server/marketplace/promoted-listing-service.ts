/**
 * Promoted Listings (Phase 1.45, Contract §13–§16.3, §18, §19) — SERVER ONLY.
 * The ONLY path that writes a promoted Listing version.
 *
 * A promoted Listing reuses the existing `Listing` aggregate with
 * `listingType = PROMOTED` and the `PackagePromotedPlacement` shape: Product +
 * Storefront + the Promoter as controller + an optional retail price. It names
 * no Offer and copies no acceptance. Which Seller terms govern it, whether the
 * Promoter is authorized, and whether it accepted them are DERIVED at an instant
 * by `readPromotedListingCommerceIn` from:
 *
 *   - the Product's current Offer and its terms in force (`effectiveOfferTerms`);
 *   - the Promoter's current Promotion Authorization cycle;
 *   - that cycle's `PromotionOfferAcceptance` rows (Phase 1.44 coverage).
 *
 * So a Seller revision, a promotion starting or ending, a revocation or
 * cancellation, and a later re-approval write nothing here: the Listing's
 * lifecycle stays the Promoter's intent, and its commerce effectiveness is
 * re-derived. History is never rewritten.
 *
 * Four acts, each its own transaction:
 *
 *   - `createPromotedListingDraft` — an APPROVED cycle, Promoter + Storefront
 *     authority, not self-promotion, a Storefront not owned by the Seller (§14:
 *     that placement would be seller-direct), and no current placement. A price
 *     is optional; when given it must be viable under the terms in force.
 *   - `setPromotedListingPrice` — DRAFT or ACTIVE; an APPROVED cycle, terms in
 *     force, and Promoter proceeds ≥ 0 under them. Mints a version.
 *   - `activatePromotedListing` — the full gate (`decidePromotedListingCommerce`,
 *     purpose ACTIVATION), including the five-ACTIVE Storefront limit counted
 *     under a Storefront row lock, against the exact version the Promoter saw.
 *   - `withdrawPromotedListing` — DRAFT or ACTIVE → WITHDRAWN, never gated.
 *
 * Locks: the Product row first (as every Offer, authorization, and acceptance
 * act does, so these serialize with Seller revisions and revocations), then the
 * Storefront row for activation.
 *
 * Not here: checkout, Orders, transaction snapshots, payment, payouts,
 * publication, and Listing copy. Checkout refuses every promoted Listing with
 * `PROMOTED_COMMERCE_NOT_ENABLED` until the transaction phase consumes
 * `readPromotedListingCommerceIn` with purpose TRANSACTION.
 */

import "../server-only";
import { Prisma } from "@prisma/client";
import {
  ACTIVE_LISTINGS_INCLUDED_PER_STOREFRONT,
  isPackagePromotedPlacement,
  isTerminalListingLifecycleState,
  type ListingLifecycleState,
  type MonacadoWholesaleAcquisitionPolicy,
  type PackagePromotedPlacement,
  type PromotedListingEconomics,
  type RetailPrice,
} from "../../contracts/marketplace/listing-source";
import {
  ActivatePromotedListingInput,
  CreatePromotedListingDraftInput,
  SetPromotedListingPriceInput,
  WithdrawPromotedListingInput,
  decidePromotedListingCommerce,
  evaluatePromotedRetail,
  evaluatePromoterReadiness,
  type GoverningOfferTerms,
  type PromotedListingBlocker,
  type PromotedListingNotEvaluated,
  type PromotedListingPurpose,
  type RetailEconomicsBlocker,
  type RetailEconomicsResult,
} from "../../contracts/marketplace/promoted-listing";
import { acceptedTermsOf } from "../../contracts/marketplace/promotion-offer-acceptance";
import { canCreatePromotedListing, isAllowed } from "../../contracts/marketplace/capability";
import { CommercialPolicyId } from "../../contracts/marketplace/commercial-policy";
import {
  commerceBlockingScopesForRole,
  evaluateParticipantAction,
} from "../../contracts/marketplace/restriction-enforcement";
import { isPubliclyAccessible } from "../../contracts/marketplace/storefront-source";
import type { OfferSourceVersion } from "../../contracts/marketplace/offer-source";
import { getPrisma } from "../db/client";
import { readProductLifecycleIn, readPromoterReadinessFactsIn } from "../product/product-lifecycle-service";
import { resolveActingSubject } from "./acting-subject-service";
import { getEffectiveWholesaleAcquisitionPolicy } from "./commercial-policy-service";
import { CommercialPolicyNotFoundError, NoActiveCommercialPolicyError } from "./commercial-policy-errors";
import { resolveCommerceApproval } from "./participant-commerce-approval-service";
import { assertParticipantMayAuthorMarketplaceState, readParticipantStanding } from "./participant-standing-service";
import { participantHoldsProductAuthority } from "./product-authority-service";
import { readCurrentPromotionAuthorizationIn } from "./promotion-authorization-read-service";
import {
  readOfferPackageContextIn,
  readPromotedTermsEligibilityIn,
  type StoredOfferAcceptance,
} from "./promotion-offer-acceptance-read-service";
import {
  CURRENT_PLACEMENT_INDEX,
  currentPlacementMarkerFor,
  placementToColumns,
  versionRowToSourceVersion,
} from "./listing-mapper";
import {
  insertFirstVersion,
  nextListingSourceRecordVersion,
  readSnapshotInTx,
  requireNoCurrentPlacement,
  requireStorefrontPlacementAuthority,
  storefrontPlacementAuthorityHeldIn,
  type ListingSnapshot,
} from "./listing-service";
import {
  cryptoListingIdProvider,
  cryptoListingRefProvider,
  type ListingIdProvider,
  type ListingRefProvider,
} from "./listing-ids";
import {
  CorruptListingRecordError,
  InvalidListingInputError,
  ListingAlreadyExistsError,
  ListingEconomicsRefusedError,
  ListingNotAuthorizedError,
  ListingNotFoundError,
  ListingNotWithdrawableError,
  ListingPersistenceFailureError,
  ListingPriceUnchangedError,
  ListingProductNotFoundError,
  ListingStorefrontNotFoundError,
  ListingVersionStaleError,
  PromotedListingNotReadyError,
  PromotedListingRefusedError,
} from "./listing-errors";

type Db = ReturnType<typeof getPrisma>;
type Tx = Db | Prisma.TransactionClient;

export interface PromotedListingServiceDeps {
  db?: Db;
  ids?: ListingIdProvider;
  refs?: ListingRefProvider;
  /**
   * The effective Monacado wholesale-acquisition policy, resolved by the caller
   * (`resolvePromotedListingPolicy`). `null` when none is in force: every
   * economics check then refuses with `NO_EFFECTIVE_COMMERCIAL_POLICY`.
   */
  policy: MonacadoWholesaleAcquisitionPolicy | null;
}

function inputError(error: { issues: Array<{ path: PropertyKey[] }> }): InvalidListingInputError {
  return new InvalidListingInputError(Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)"))));
}

/**
 * The effective commercial policy for promoted economics — the same
 * configured identity checkout prices under (`MONACADO_CHECKOUT_POLICY_ID`),
 * never a request parameter. `null` when the identity is unset or no version is
 * active, so the gates fail closed rather than inventing a rate.
 */
export async function resolvePromotedListingPolicy(
  db: Db,
  env: Record<string, string | undefined> = process.env,
): Promise<MonacadoWholesaleAcquisitionPolicy | null> {
  const policyId = CommercialPolicyId.safeParse(env.MONACADO_CHECKOUT_POLICY_ID ?? "");
  if (!policyId.success) return null;
  try {
    return await getEffectiveWholesaleAcquisitionPolicy(policyId.data, { db });
  } catch (error) {
    if (error instanceof NoActiveCommercialPolicyError || error instanceof CommercialPolicyNotFoundError) return null;
    throw error;
  }
}

// — Governing Seller terms —

function governingTermsOf(version: OfferSourceVersion): GoverningOfferTerms | null {
  const terms = acceptedTermsOf(version);
  if (terms === null) return null;
  return {
    sourceRecordVersion: terms.version,
    wholesalePriceMinorUnits: terms.wholesalePriceMinorUnits,
    currency: terms.currency,
    calculatedCommissionMinorUnits: terms.calculatedCommissionMinorUnits,
  };
}

/**
 * The Seller terms in force at `at` — the running promotion, else the standing
 * version — and a SCHEDULED promotion's terms, for an advance warning. `inForce`
 * is `null` unless the Product's Offer is ACTIVE and still authored by the
 * participant holding Seller authority over the Product.
 */
async function readGoverningTermsIn(
  tx: Tx,
  internalProductId: string,
  sellerParticipantId: string | null,
  at: string,
): Promise<{ inForce: GoverningOfferTerms | null; upcoming: (GoverningOfferTerms & { effectiveFrom: string }) | null }> {
  const context = await readOfferPackageContextIn(tx, internalProductId, at);
  if (context === null || sellerParticipantId === null || context.offer.sellerParticipantId !== sellerParticipantId) {
    return { inForce: null, upcoming: null };
  }
  const { effective, state } = context;
  const inForceVersion =
    effective.kind === "NONE" ? null : effective.kind === "SCHEDULED_PROMOTION" ? state.promotion : state.standing;
  const upcomingTerms =
    context.promotionStatus === "SCHEDULED" && state.promotion !== null && state.promotion.promotionWindow !== null
      ? governingTermsOf(state.promotion)
      : null;
  return {
    inForce: inForceVersion === null ? null : governingTermsOf(inForceVersion),
    upcoming:
      upcomingTerms === null || state.promotion?.promotionWindow == null
        ? null
        : { ...upcomingTerms, effectiveFrom: state.promotion.promotionWindow.effectiveFrom },
  };
}

// — The commerce / readiness helper —

/**
 * One promoted Listing's commerce position at an instant — the result a later
 * transaction path binds. Internal ids appear here because this is a server
 * result; no route returns it as is.
 */
export interface PromotedListingCommerce {
  purpose: PromotedListingPurpose;
  eligible: boolean;
  blockers: PromotedListingBlocker[];
  notEvaluated: readonly PromotedListingNotEvaluated[];
  listing: {
    internalListingId: string;
    listingRef: string;
    listingSourceRecordId: string;
    listingSourceRecordVersion: string;
    lifecycle: ListingLifecycleState;
    storefrontId: string;
  };
  internalProductId: string;
  promoterParticipantId: string;
  /** The participant holding Seller authority over the Product, if any. */
  sellerParticipantId: string | null;
  retail: RetailPrice | null;
  /** The Seller terms in force and the economics of this price under them. */
  governingTerms: GoverningOfferTerms | null;
  economics: RetailEconomicsResult | null;
  /** A SCHEDULED promotion's economics at this price — a warning only. */
  upcomingPromotion: { effectiveFrom: string; economics: RetailEconomicsResult } | null;
  /** On a pass only: exactly what governed — cycle, acceptance, versions, economics. */
  bound: {
    authorizationId: string;
    acceptance: { id: string; standingVersion: string; promotionVersion: string | null; acceptedAt: string };
    governing: {
      internalOfferId: string;
      offerSourceRecordId: string;
      standingVersion: string;
      promotionVersion: string | null;
      termsKind: "STANDING" | "SCHEDULED_PROMOTION";
      /** The version whose wholesale and commission the economics used. */
      economicsVersion: string;
    };
    economics: PromotedListingEconomics;
  } | null;
}

/**
 * Derive whether a promoted Listing may activate (`ACTIVATION`) or transact
 * (`TRANSACTION`) at `at`. Reads only. Throws `ListingNotFoundError`, or
 * `PromotedListingRefusedError("NOT_PROMOTED_LISTING")` for a Listing that is
 * not a package-based promoted Listing.
 *
 * For ACTIVATION the caller holds the Storefront row lock, so the ACTIVE count
 * it reads cannot be overtaken before its write commits.
 */
export async function readPromotedListingCommerceIn(
  tx: Tx,
  input: {
    internalListingId: string;
    at: string;
    policy: MonacadoWholesaleAcquisitionPolicy | null;
    purpose: PromotedListingPurpose;
  },
): Promise<PromotedListingCommerce> {
  const { at, policy, purpose } = input;
  const { record, currentVersion, listingRef } = await readSnapshotInTx(tx, input.internalListingId);
  const placement = currentVersion.placement;
  if (!isPackagePromotedPlacement(placement)) throw new PromotedListingRefusedError("NOT_PROMOTED_LISTING");
  const internalProductId = currentVersion.internalProductId;
  const promoterParticipantId = currentVersion.controllingParticipantId;
  const storefrontId = currentVersion.storefrontId;

  const product = await readProductLifecycleIn(tx, internalProductId);
  const sellerParticipantId = product?.authorityParticipantId ?? null;
  const terms = await readPromotedTermsEligibilityIn(tx, { internalProductId, promoterParticipantId, at });
  const governing = await readGoverningTermsIn(tx, internalProductId, sellerParticipantId, at);

  const storefront = await tx.storefront.findUnique({ where: { internalStorefrontId: storefrontId } });
  if (storefront === null) throw new CorruptListingRecordError(["storefrontId"]);
  const controllerHasAuthority = await storefrontPlacementAuthorityHeldIn(tx, storefrontId, promoterParticipantId);
  const publiclyAccessible =
    purpose === "TRANSACTION" &&
    isPubliclyAccessible({
      lifecycle: storefront.lifecycle as never,
      visibility: storefront.visibility as never,
      goLiveApproval: await resolveCommerceApproval(tx, storefront.ownerParticipantId),
    });
  const activeListingCount =
    purpose === "ACTIVATION" ? await tx.listing.count({ where: { storefrontId, lifecycle: "ACTIVE" } }) : 0;

  /* Promoter readiness: going live is refused by ANY governed restriction (the
     Phase 1.15 Listing seam); a sale only by the PROMOTER commerce scopes. */
  const readiness = await readPromoterReadinessFactsIn(tx, promoterParticipantId);
  const commerceScopes: readonly string[] = commerceBlockingScopesForRole("PROMOTER");
  const promoterReadiness = evaluatePromoterReadiness({
    account: readiness.account,
    participant:
      readiness.participant === null
        ? null
        : {
            ...readiness.participant,
            restricted:
              purpose === "ACTIVATION"
                ? readiness.participant.restrictedScopes.length > 0
                : readiness.participant.restrictedScopes.some((s) => commerceScopes.includes(s)),
          },
  });
  let sellerMayTransact = true;
  if (purpose === "TRANSACTION") {
    sellerMayTransact =
      sellerParticipantId !== null &&
      evaluateParticipantAction({
        standing: await readParticipantStanding(tx, sellerParticipantId),
        requiredScopes: commerceBlockingScopesForRole("SELLER"),
      }).allowed;
  }

  const economics =
    governing.inForce === null ? null : evaluatePromotedRetail({ retail: placement.retail, terms: governing.inForce, policy });
  const upcomingPromotion =
    governing.upcoming === null || placement.retail === null
      ? null
      : {
          effectiveFrom: governing.upcoming.effectiveFrom,
          economics: evaluatePromotedRetail({ retail: placement.retail, terms: governing.upcoming, policy }),
        };

  const decision = decidePromotedListingCommerce<StoredOfferAcceptance>({
    purpose,
    lifecycle: currentVersion.lifecycle,
    retailPresent: placement.retail !== null,
    terms,
    storefront: {
      controllerHasAuthority,
      ownedBySeller: sellerParticipantId !== null && storefront.ownerParticipantId === sellerParticipantId,
      publiclyAccessible,
      activeListingCount,
    },
    promoterReadiness,
    sellerMayTransact,
    economics,
    activeListingAllowance: ACTIVE_LISTINGS_INCLUDED_PER_STOREFRONT,
  });

  const bound =
    decision.eligible && terms.eligible && economics !== null && economics.ok && governing.inForce !== null
      ? {
          authorizationId: terms.authorizationId,
          acceptance: {
            id: terms.acceptance.id,
            standingVersion: terms.acceptance.standingVersion,
            promotionVersion: terms.acceptance.promotionVersion,
            acceptedAt: terms.acceptance.acceptedAt,
          },
          governing: { ...terms.governing, economicsVersion: governing.inForce.sourceRecordVersion },
          economics: economics.economics,
        }
      : null;

  /* The 1.44 decision can pass while no governing terms resolve here — the
     Offer's author no longer holds Seller authority over the Product. Never a
     refusal without a reason: that is the terms blocker. */
  const blockers =
    bound === null && decision.blockers.length === 0
      ? (["NO_OFFER_TERMS_IN_FORCE"] as PromotedListingBlocker[])
      : decision.blockers;

  return {
    purpose,
    eligible: bound !== null,
    blockers,
    notEvaluated: decision.notEvaluated,
    listing: {
      internalListingId: record.internalListingId,
      listingRef,
      listingSourceRecordId: record.listingSourceRecordId,
      listingSourceRecordVersion: currentVersion.sourceRecordVersion,
      lifecycle: currentVersion.lifecycle,
      storefrontId,
    },
    internalProductId,
    promoterParticipantId,
    sellerParticipantId,
    retail: placement.retail,
    governingTerms: governing.inForce,
    economics,
    upcomingPromotion,
    bound,
  };
}

// — Writes —

/** Translate a database refusal; domain errors pass through unchanged. */
function mapWriteError(stage: string, error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    const target = JSON.stringify(error.meta?.target ?? "");
    if (target.includes(CURRENT_PLACEMENT_INDEX) || target.includes("currentPlacementMarker")) {
      throw new ListingAlreadyExistsError(error);
    }
    /* Two writes raced for the same next version label: the loser saw a
       version that is no longer current. */
    throw new ListingVersionStaleError();
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError || error instanceof Prisma.PrismaClientUnknownRequestError) {
    throw new ListingPersistenceFailureError(stage, error);
  }
  throw error;
}

async function lockProduct(tx: Prisma.TransactionClient, internalProductId: string): Promise<void> {
  await tx.$queryRaw`SELECT internalProductId FROM Product WHERE internalProductId = ${internalProductId} FOR UPDATE`;
}

/** The acting participant, or a bounded refusal naming the promoted capability. */
async function actingPromoterIn(tx: Tx, actingAccountId: string): Promise<string> {
  const subject = await resolveActingSubject(tx, actingAccountId);
  const participantId = subject.participant?.participantId;
  if (participantId === undefined) {
    throw new ListingNotAuthorizedError(canCreatePromotedListing(subject).capability, ["PARTICIPANT_REQUIRED"]);
  }
  return participantId;
}

/**
 * The caller's own package-based promoted Listing, by reference. Somebody
 * else's Listing and no Listing are one answer (`ListingNotFoundError`); the
 * caller's own Listing of another kind is `NOT_PROMOTED_LISTING`.
 */
async function ownPromotedListingIn(
  tx: Tx,
  listingRef: string,
  participantId: string,
): Promise<{ snapshot: ListingSnapshot; placement: PackagePromotedPlacement }> {
  const row = await tx.listing.findUnique({ where: { listingRef }, select: { internalListingId: true, controllingParticipantId: true } });
  if (row === null || row.controllingParticipantId !== participantId) throw new ListingNotFoundError();
  const snapshot = await readSnapshotInTx(tx, row.internalListingId);
  const placement = snapshot.currentVersion.placement;
  if (!isPackagePromotedPlacement(placement)) throw new PromotedListingRefusedError("NOT_PROMOTED_LISTING");
  return { snapshot, placement };
}

/** Insert the next immutable version and advance the pointer, lifecycle, and marker together. */
async function writeNextVersionIn(
  tx: Tx,
  snapshot: ListingSnapshot,
  next: { lifecycle: ListingLifecycleState; placement: PackagePromotedPlacement; actingAccountId: string; at: Date },
): Promise<void> {
  const current = snapshot.currentVersion;
  const label = nextListingSourceRecordVersion(current.sourceRecordVersion);
  if (label === undefined) throw new CorruptListingRecordError(["currentSourceRecordVersion"]);
  await tx.listingSourceRecordVersionRow.create({
    data: {
      listingSourceRecordId: current.listingSourceRecordId,
      sourceRecordVersion: label,
      supersedesSourceRecordVersion: current.sourceRecordVersion,
      internalListingId: current.internalListingId,
      sourceSystem: "monacado",
      sourceRecordType: "Listing",
      sourceClass: "governed-database-record",
      storefrontId: current.storefrontId,
      internalProductId: current.internalProductId,
      controllingParticipantId: current.controllingParticipantId,
      lifecycle: next.lifecycle,
      ...placementToColumns(next.placement),
      authorizedByParticipantId: current.controllingParticipantId,
      authorizedByActorId: next.actingAccountId,
      recordedAt: next.at,
    },
  });
  /* Guarded on the version read: a concurrent writer that advanced the pointer
     makes this update match nothing, and the whole write is refused as stale. */
  const moved = await tx.listing.updateMany({
    where: { internalListingId: current.internalListingId, currentSourceRecordVersion: current.sourceRecordVersion },
    data: {
      currentSourceRecordVersion: label,
      lifecycle: next.lifecycle,
      listingType: next.placement.listingType,
      currentPlacementMarker: currentPlacementMarkerFor(next.lifecycle),
    },
  });
  if (moved.count !== 1) throw new ListingVersionStaleError();
}

/**
 * Require the Seller terms in force and a viable price under them; returns
 * nothing, writes nothing. Shared by draft-with-price and repricing.
 */
async function requireViablePriceIn(
  tx: Tx,
  input: { internalProductId: string; sellerParticipantId: string | null; retail: RetailPrice; at: string; policy: MonacadoWholesaleAcquisitionPolicy | null },
): Promise<void> {
  const governing = await readGoverningTermsIn(tx, input.internalProductId, input.sellerParticipantId, input.at);
  if (governing.inForce === null) throw new PromotedListingRefusedError("NO_OFFER_TERMS_IN_FORCE");
  const result = evaluatePromotedRetail({ retail: input.retail, terms: governing.inForce, policy: input.policy });
  if (!result.ok) throw new ListingEconomicsRefusedError(result.blocker);
}

/** The current cycle for this Product + Promoter must be APPROVED. */
async function requireApprovedCycleIn(tx: Tx, internalProductId: string, promoterParticipantId: string): Promise<void> {
  const cycle = await readCurrentPromotionAuthorizationIn(tx, { internalProductId, promoterParticipantId });
  if (cycle === null || cycle.state !== "APPROVED") throw new PromotedListingRefusedError("AUTHORIZATION_NOT_APPROVED");
}

/**
 * Create a promoted DRAFT (Phase 1.45). Throws `InvalidListingInputError`,
 * `ListingNotAuthorizedError` (no participant, no drafting PROMOTER role, no
 * Storefront authority), `ParticipantActionNotPermittedError` (suspended),
 * `ListingProductNotFoundError`, `ListingStorefrontNotFoundError`,
 * `PromotedListingRefusedError` (`AUTHORIZATION_NOT_APPROVED`,
 * `SELF_PROMOTION`, `STOREFRONT_OWNED_BY_SELLER`, `NO_OFFER_TERMS_IN_FORCE`),
 * `ListingEconomicsRefusedError`, or `ListingAlreadyExistsError`.
 */
export async function createPromotedListingDraft(
  input: unknown,
  deps: PromotedListingServiceDeps,
): Promise<ListingSnapshot> {
  const parsed = CreatePromotedListingDraftInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const data = parsed.data;
  const db = deps.db ?? getPrisma();
  const ids = deps.ids ?? cryptoListingIdProvider;
  const internalListingId = ids.nextInternalListingId();
  const listingSourceRecordId = ids.nextListingSourceRecordId();
  const listingRef = (deps.refs ?? cryptoListingRefProvider).nextListingRef();
  const retail = data.retail ?? null;

  try {
    return await db.$transaction(async (tx) => {
      const participantId = await actingPromoterIn(tx, data.actingAccountId);
      const product = await tx.product.findUnique({ where: { productRef: data.productRef }, select: { internalProductId: true } });
      if (product === null) throw new ListingProductNotFoundError();
      const storefront = await tx.storefront.findUnique({
        where: { publicHandle: data.storefrontHandle },
        select: { internalStorefrontId: true, ownerParticipantId: true },
      });
      if (storefront === null) throw new ListingStorefrontNotFoundError();
      const internalProductId = product.internalProductId;
      await lockProduct(tx, internalProductId);

      const decision = canCreatePromotedListing(await resolveActingSubject(tx, data.actingAccountId));
      if (!isAllowed(decision)) throw new ListingNotAuthorizedError(decision.capability, [...decision.reasonCodes]);
      await assertParticipantMayAuthorMarketplaceState(tx, participantId);
      await requireStorefrontPlacementAuthority(tx, {
        storefrontId: storefront.internalStorefrontId,
        controllingParticipantId: participantId,
        capability: decision.capability,
      });

      await requireApprovedCycleIn(tx, internalProductId, participantId);
      if (await participantHoldsProductAuthority(tx, internalProductId, participantId)) {
        throw new PromotedListingRefusedError("SELF_PROMOTION");
      }
      const sellerParticipantId = (await readProductLifecycleIn(tx, internalProductId))?.authorityParticipantId ?? null;
      if (sellerParticipantId !== null && storefront.ownerParticipantId === sellerParticipantId) {
        throw new PromotedListingRefusedError("STOREFRONT_OWNED_BY_SELLER");
      }
      if (retail !== null) {
        await requireViablePriceIn(tx, { internalProductId, sellerParticipantId, retail, at: data.now, policy: deps.policy });
      }
      await requireNoCurrentPlacement(tx, { internalProductId, storefrontId: storefront.internalStorefrontId });

      await insertFirstVersion(tx, {
        internalListingId,
        listingSourceRecordId,
        listingRef,
        storefrontId: storefront.internalStorefrontId,
        internalProductId,
        controllingParticipantId: participantId,
        placement: { listingType: "PROMOTED", termsBasis: "PROMOTION_PACKAGE", retail },
        authorizedByParticipantId: participantId,
        authorizedByActorId: data.actingAccountId,
        recordedAt: new Date(data.now),
      });
      return await readSnapshotInTx(tx, internalListingId);
    });
  } catch (error) {
    mapWriteError("createPromotedListingDraft", error);
  }
}

/**
 * Set or change the retail price of the caller's own DRAFT or ACTIVE promoted
 * Listing. Requires an APPROVED cycle, Seller terms in force, and Promoter
 * proceeds ≥ 0 under them. An ACTIVE Listing stays ACTIVE at the new price.
 */
export async function setPromotedListingPrice(
  input: unknown,
  deps: PromotedListingServiceDeps,
): Promise<ListingSnapshot> {
  const parsed = SetPromotedListingPriceInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const data = parsed.data;
  const db = deps.db ?? getPrisma();

  try {
    return await db.$transaction(async (tx) => {
      const participantId = await actingPromoterIn(tx, data.actingAccountId);
      const { snapshot, placement } = await ownPromotedListingIn(tx, data.listingRef, participantId);
      const current = snapshot.currentVersion;
      if (isTerminalListingLifecycleState(current.lifecycle)) throw new PromotedListingRefusedError("LISTING_TERMINAL");
      await lockProduct(tx, current.internalProductId);
      await assertParticipantMayAuthorMarketplaceState(tx, participantId);
      if (current.lifecycle === "ACTIVE") {
        await requireStorefrontPlacementAuthority(tx, {
          storefrontId: current.storefrontId,
          controllingParticipantId: participantId,
          capability: "listing:promoted:create",
        });
      }
      if (
        placement.retail !== null &&
        placement.retail.retailPriceMinorUnits === data.retail.retailPriceMinorUnits &&
        placement.retail.retailPriceCurrency === data.retail.retailPriceCurrency
      ) {
        throw new ListingPriceUnchangedError();
      }
      await requireApprovedCycleIn(tx, current.internalProductId, participantId);
      const sellerParticipantId = (await readProductLifecycleIn(tx, current.internalProductId))?.authorityParticipantId ?? null;
      await requireViablePriceIn(tx, {
        internalProductId: current.internalProductId,
        sellerParticipantId,
        retail: data.retail,
        at: data.now,
        policy: deps.policy,
      });

      await writeNextVersionIn(tx, snapshot, {
        lifecycle: current.lifecycle,
        placement: { ...placement, retail: data.retail },
        actingAccountId: data.actingAccountId,
        at: new Date(data.now),
      });
      return await readSnapshotInTx(tx, current.internalListingId);
    });
  } catch (error) {
    mapWriteError("setPromotedListingPrice", error);
  }
}

/**
 * Activate the caller's own promoted DRAFT, exactly as shown
 * (`expectedVersion`). Every blocker of the ACTIVATION gate is reported in one
 * `PromotedListingNotReadyError`; the five-ACTIVE limit is counted under the
 * Storefront row lock so two activations cannot both take the last slot.
 */
export async function activatePromotedListing(
  input: unknown,
  deps: PromotedListingServiceDeps,
): Promise<ListingSnapshot> {
  const parsed = ActivatePromotedListingInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const data = parsed.data;
  const db = deps.db ?? getPrisma();

  try {
    return await db.$transaction(async (tx) => {
      const participantId = await actingPromoterIn(tx, data.actingAccountId);
      const { snapshot, placement } = await ownPromotedListingIn(tx, data.listingRef, participantId);
      const current = snapshot.currentVersion;
      if (isTerminalListingLifecycleState(current.lifecycle)) throw new PromotedListingRefusedError("LISTING_TERMINAL");
      if (current.lifecycle !== "DRAFT") throw new PromotedListingRefusedError("LISTING_NOT_DRAFT");
      if (current.sourceRecordVersion !== data.expectedVersion) throw new ListingVersionStaleError();

      await lockProduct(tx, current.internalProductId);
      await tx.$queryRaw`SELECT internalStorefrontId FROM Storefront WHERE internalStorefrontId = ${current.storefrontId} FOR UPDATE`;

      const commerce = await readPromotedListingCommerceIn(tx, {
        internalListingId: current.internalListingId,
        at: data.now,
        policy: deps.policy,
        purpose: "ACTIVATION",
      });
      if (!commerce.eligible) throw new PromotedListingNotReadyError(commerce.blockers);

      await writeNextVersionIn(tx, snapshot, {
        lifecycle: "ACTIVE",
        placement,
        actingAccountId: data.actingAccountId,
        at: new Date(data.now),
      });
      return await readSnapshotInTx(tx, current.internalListingId);
    });
  } catch (error) {
    mapWriteError("activatePromotedListing", error);
  }
}

/**
 * Withdraw the caller's own DRAFT or ACTIVE promoted Listing. A stand-down:
 * no authorization, readiness, standing, or terms gate — a Promoter whose
 * approval was revoked, or who is suspended, must still be able to stop.
 * Releases the Product + Storefront pair.
 */
export async function withdrawPromotedListing(
  input: unknown,
  deps: Omit<PromotedListingServiceDeps, "policy"> = {},
): Promise<ListingSnapshot> {
  const parsed = WithdrawPromotedListingInput.safeParse(input);
  if (!parsed.success) throw inputError(parsed.error);
  const data = parsed.data;
  const db = deps.db ?? getPrisma();

  try {
    return await db.$transaction(async (tx) => {
      const participantId = await actingPromoterIn(tx, data.actingAccountId);
      const { snapshot, placement } = await ownPromotedListingIn(tx, data.listingRef, participantId);
      const current = snapshot.currentVersion;
      if (isTerminalListingLifecycleState(current.lifecycle)) throw new ListingNotWithdrawableError(current.lifecycle);
      await writeNextVersionIn(tx, snapshot, {
        lifecycle: "WITHDRAWN",
        placement,
        actingAccountId: data.actingAccountId,
        at: new Date(data.now),
      });
      return await readSnapshotInTx(tx, current.internalListingId);
    });
  } catch (error) {
    mapWriteError("withdrawPromotedListing", error);
  }
}

// — The Promoter's own view —

/**
 * The economics a Promoter is shown for its own price: what Monacado keeps,
 * what the Promoter nets, and the lowest viable price. Deliberately narrower
 * than `PromotedListingEconomics` — no Seller proceeds line and no policy
 * identity (D4: the Promoter is not shown a Seller-proceeds label).
 */
export type PromoterRetailEconomicsView =
  | {
      ok: true;
      monacadoRetainedMinorUnits: number;
      promoterNetProceedsMinorUnits: number;
      minimumViableRetailMinorUnits: number;
      currency: string;
    }
  | { ok: false; blocker: RetailEconomicsBlocker; minimumViableRetailMinorUnits: number | null };

function promoterEconomicsView(result: RetailEconomicsResult | null): PromoterRetailEconomicsView | null {
  if (result === null) return null;
  if (!result.ok) return { ok: false, blocker: result.blocker, minimumViableRetailMinorUnits: result.minimumViableRetailMinorUnits };
  return {
    ok: true,
    monacadoRetainedMinorUnits: result.economics.monacadoRetainedAmountMinorUnits,
    promoterNetProceedsMinorUnits: result.economics.promoterNetProceedsMinorUnits,
    minimumViableRetailMinorUnits: result.minimumViableRetailMinorUnits,
    currency: result.economics.currency,
  };
}

/** One of the Promoter's promoted Listings, as its account page shows it. References only. */
export interface PromoterListingView {
  listingRef: string;
  productRef: string;
  storefrontHandle: string;
  lifecycle: ListingLifecycleState;
  sourceRecordVersion: string;
  retail: RetailPrice | null;
  /** ACTIVATION blockers for a DRAFT; TRANSACTION blockers for an ACTIVE one. */
  blockers: PromotedListingBlocker[];
  /** Economics under the Seller terms in force, when there are any. */
  economics: PromoterRetailEconomicsView | null;
  upcomingPromotion: { effectiveFrom: string; economics: PromoterRetailEconomicsView | null } | null;
  /**
   * Phase 1.46 — where a buyer reaches this Listing, for an ACTIVE one only:
   * the existing buyer page, `/listings/{internalListingId}`. That page and
   * its checkout form already address a Listing by this id, so the path
   * discloses nothing a buyer does not already see; `null` otherwise.
   */
  buyerPath: string | null;
}

/**
 * The Promoter's non-terminal promoted Listings for one Product. Derived at
 * `at`; writes nothing. No Seller identity, no acceptance or authorization
 * id, and no internal id except inside an ACTIVE Listing's `buyerPath`.
 */
export async function readPromoterListingsForProductIn(
  tx: Tx,
  input: { internalProductId: string; promoterParticipantId: string; at: string; policy: MonacadoWholesaleAcquisitionPolicy | null },
): Promise<PromoterListingView[]> {
  const rows = await tx.listing.findMany({
    where: {
      internalProductId: input.internalProductId,
      controllingParticipantId: input.promoterParticipantId,
      listingType: "PROMOTED",
      currentPlacementMarker: { not: null },
    },
    select: { internalListingId: true, product: { select: { productRef: true } }, storefront: { select: { publicHandle: true } } },
    orderBy: { createdAt: "asc" },
  });
  const out: PromoterListingView[] = [];
  for (const row of rows) {
    const version = await readSnapshotInTx(tx, row.internalListingId);
    if (!isPackagePromotedPlacement(version.currentVersion.placement)) continue;
    const commerce = await readPromotedListingCommerceIn(tx, {
      internalListingId: row.internalListingId,
      at: input.at,
      policy: input.policy,
      purpose: version.currentVersion.lifecycle === "DRAFT" ? "ACTIVATION" : "TRANSACTION",
    });
    out.push({
      listingRef: commerce.listing.listingRef,
      productRef: row.product.productRef,
      storefrontHandle: row.storefront.publicHandle,
      lifecycle: commerce.listing.lifecycle,
      sourceRecordVersion: commerce.listing.listingSourceRecordVersion,
      retail: commerce.retail,
      blockers: commerce.blockers,
      economics: promoterEconomicsView(commerce.economics),
      upcomingPromotion:
        commerce.upcomingPromotion === null
          ? null
          : {
              effectiveFrom: commerce.upcomingPromotion.effectiveFrom,
              economics: promoterEconomicsView(commerce.upcomingPromotion.economics),
            },
      buyerPath:
        commerce.listing.lifecycle === "ACTIVE"
          ? `/listings/${encodeURIComponent(commerce.listing.internalListingId)}`
          : null,
    });
  }
  return out;
}

/** The Promoter's "Your listing" panel for one Product (Phase 1.46). References only. */
export interface PromoterListingPanel {
  /** Storefronts the Promoter may place this Product into now: controlled, not CLOSED, not already holding it. */
  storefrontHandles: string[];
  listings: PromoterListingView[];
}

/**
 * Everything `/promote/{productRef}` needs to show and act on the viewer's
 * own promoted Listings for that Product. Reads only; `null` for an unknown
 * Product. The policy is the configured checkout policy, so the economics shown
 * are the ones a sale would use.
 */
export async function readPromoterListingPanelIn(
  tx: Tx,
  input: { productRef: string; promoterParticipantId: string; at: string; policy: MonacadoWholesaleAcquisitionPolicy | null },
): Promise<PromoterListingPanel | null> {
  const product = await tx.product.findUnique({
    where: { productRef: input.productRef },
    select: { internalProductId: true },
  });
  if (product === null) return null;
  const listings = await readPromoterListingsForProductIn(tx, {
    internalProductId: product.internalProductId,
    promoterParticipantId: input.promoterParticipantId,
    at: input.at,
    policy: input.policy,
  });
  const storefronts = await tx.storefront.findMany({
    where: {
      lifecycle: { not: "CLOSED" },
      OR: [
        { ownerParticipantId: input.promoterParticipantId },
        { governanceAssignments: { some: { participantId: input.promoterParticipantId, status: "ACTIVE" } } },
      ],
    },
    select: { publicHandle: true },
    orderBy: { publicHandle: "asc" },
  });
  const placed = new Set(listings.map((l) => l.storefrontHandle));
  return {
    storefrontHandles: storefronts.map((s) => s.publicHandle).filter((h) => !placed.has(h)),
    listings,
  };
}

/** Re-export so callers reading a version row need not reach into the mapper. */
export { versionRowToSourceVersion };
