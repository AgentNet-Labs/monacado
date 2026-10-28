/**
 * Promoter Offer-package acceptance, read side (Phase 1.44) — SERVER ONLY.
 *
 * Reads only, at one explicit instant. Three consumers:
 *
 *   - the Promoter's view of the package it may accept — the exact standing
 *     terms, any SCHEDULED or RUNNING promotion with its window, and whether
 *     this cycle has accepted exactly that package;
 *   - the Seller's per-Promoter status — whether the current package is
 *     accepted, and which versions, when;
 *   - `readPromotedTermsEligibilityIn` — the promoted-terms gate a later phase
 *     consumes. Nothing commercial calls it yet.
 *
 * Every answer is derived from immutable acceptance rows, the Offer's versions
 * and acts, and the instant. Nothing here writes, and nothing a participant
 * sees carries an acceptance id, an account id, or a participant id.
 */

import "../server-only";
import type { Offer as OfferRow, Prisma } from "@prisma/client";
import {
  acceptableOfferPackage,
  acceptanceCoveringTermsInForce,
  acceptanceOfPackage,
  acceptedPromotionTermsOf,
  acceptedTermsOf,
  decidePromotedTermsEligibility,
  resaleAdmitsAcceptance,
  termsInForceOf,
  type AcceptedPromotionEcho,
  type AcceptedTermsEcho,
  type OfferPackage,
  type PromotedTermsEligibility,
  type RecordedOfferAcceptance,
} from "../../contracts/marketplace/promotion-offer-acceptance";
import {
  effectiveOfferTerms,
  type EffectiveOfferTerms,
  type OfferLifecycleState,
  type OfferPromotionStatus,
} from "../../contracts/marketplace/offer-source";
import type { PromotionAuthorizationState } from "../../contracts/marketplace/promotion-authorization";
import { getPrisma } from "../db/client";
import { readProductLifecycleIn } from "../product/product-lifecycle-service";
import { readProductResaleAvailabilityIn } from "../product/product-resale-availability-service";
import { lifecycleAt, promotionStatusAt, readOfferStateIn, type OfferStateRead } from "./offer-service";
import { participantHoldsProductAuthority } from "./product-authority-service";
import { readCurrentPromotionAuthorizationIn } from "./promotion-authorization-read-service";

type Tx = ReturnType<typeof getPrisma> | Prisma.TransactionClient;

// — The Offer's package at an instant —

/** The Product's current Offer, decided at `at`. */
export interface OfferPackageContext {
  offer: OfferRow;
  state: OfferStateRead;
  lifecycle: OfferLifecycleState;
  promotionStatus: OfferPromotionStatus | null;
  /** What a Promoter may accept now: `{S}`, `{S, P}`, or `null` unless ACTIVE. */
  acceptable: OfferPackage | null;
  effective: EffectiveOfferTerms;
}

/**
 * The Product's current (non-terminal-marker) Offer and its package at `at`, or
 * `null` when the Product has none. An Offer that has derived ENDED still holds
 * the marker until a later create releases it; its lifecycle says ENDED.
 */
export async function readOfferPackageContextIn(
  tx: Tx,
  internalProductId: string,
  at: string,
): Promise<OfferPackageContext | null> {
  const offer = await tx.offer.findUnique({ where: { nonTerminalForProductId: internalProductId } });
  if (offer === null) return null;
  const state = await readOfferStateIn(tx, offer);
  const lifecycle = lifecycleAt(state, at);
  const promotionStatus = promotionStatusAt(state, at);
  return {
    offer,
    state,
    lifecycle,
    promotionStatus,
    acceptable: acceptableOfferPackage({
      lifecycle,
      standingVersion: state.standing.sourceRecordVersion,
      promotion:
        state.promotion === null || promotionStatus === null
          ? null
          : { sourceRecordVersion: state.promotion.sourceRecordVersion, status: promotionStatus },
    }),
    effective: effectiveOfferTerms(state.resolution, at),
  };
}

// — Acceptance rows —

/** One stored acceptance. `id` is internal evidence for server callers only. */
export interface StoredOfferAcceptance extends RecordedOfferAcceptance {
  id: string;
  authorizationId: string;
  offerSourceRecordId: string;
}

/** Every acceptance recorded under these cycles, keyed by cycle id, oldest first. */
export async function readCycleAcceptancesIn(
  tx: Tx,
  authorizationIds: readonly string[],
): Promise<Map<string, StoredOfferAcceptance[]>> {
  const out = new Map<string, StoredOfferAcceptance[]>(authorizationIds.map((id) => [id, []]));
  if (authorizationIds.length === 0) return out;
  const rows = await tx.promotionOfferAcceptance.findMany({
    where: { authorizationId: { in: [...authorizationIds] } },
    orderBy: [{ acceptedAt: "asc" }, { id: "asc" }],
  });
  for (const r of rows) {
    out.get(r.authorizationId)?.push({
      id: r.id,
      authorizationId: r.authorizationId,
      offerSourceRecordId: r.offerSourceRecordId,
      standingVersion: r.standingVersion,
      promotionVersion: r.promotionVersion,
      acceptedAt: r.acceptedAt.toISOString(),
    });
  }
  return out;
}

/** This cycle's acceptances of THIS Offer — another Offer's versions never count. */
function ofOffer(acceptances: readonly StoredOfferAcceptance[], offerSourceRecordId: string): StoredOfferAcceptance[] {
  return acceptances.filter((a) => a.offerSourceRecordId === offerSourceRecordId);
}

// — The Promoter's view —

/**
 * The package an APPROVED Promoter may accept, exactly as it must be confirmed.
 * `standing` and `promotion` (minus `inForce`) are the request body's members:
 * the Promoter sends back what it was shown.
 */
export interface PromoterOfferPackageView {
  /** The Promoter's own cycle reference — where the acceptance is posted. */
  authorizationRef: string;
  offerRef: string;
  standing: AcceptedTermsEcho;
  promotion: (AcceptedPromotionEcho & { inForce: boolean }) | null;
  /** When this cycle accepted exactly this package; `null` when it has not. */
  acceptedAt: string | null;
  /** Whether this cycle accepted any earlier package of this Offer — "new terms". */
  hadEarlierAcceptance: boolean;
  /** Whether the terms in force right now are covered by this cycle's acceptances. */
  inForceCovered: boolean;
}

/**
 * The view for one current cycle, or `null` when no package is acceptable for
 * it now: the cycle is not current and `APPROVED`, the Product is not `ACTIVE`,
 * resale is `NOT_OFFERED` or `WITHDRAWN`, or the Offer is not `ACTIVE` or no
 * longer its Seller's. Terms are disclosed exactly when they may be accepted.
 */
export async function readPromoterOfferPackageIn(
  tx: Tx,
  cycle: {
    id: string;
    authorizationRef: string;
    internalProductId: string;
    current: boolean;
    state: PromotionAuthorizationState;
  },
  at: string,
): Promise<PromoterOfferPackageView | null> {
  if (!cycle.current || cycle.state !== "APPROVED") return null;
  const product = await readProductLifecycleIn(tx, cycle.internalProductId);
  if (product === null || product.lifecycle.lifecycle !== "ACTIVE") return null;
  const { resaleAvailability } = await readProductResaleAvailabilityIn(tx, cycle.internalProductId);
  if (!resaleAdmitsAcceptance(resaleAvailability)) return null;
  const context = await readOfferPackageContextIn(tx, cycle.internalProductId, at);
  if (context === null || context.acceptable === null) return null;
  if (product.authorityParticipantId !== context.offer.sellerParticipantId) return null;

  const standing = acceptedTermsOf(context.state.standing);
  const promotionTerms =
    context.acceptable.promotionVersion === null || context.state.promotion === null
      ? null
      : acceptedPromotionTermsOf(context.state.promotion);
  if (standing === null || (context.acceptable.promotionVersion !== null && promotionTerms === null)) return null;

  const acceptances = ofOffer(
    (await readCycleAcceptancesIn(tx, [cycle.id])).get(cycle.id) ?? [],
    context.offer.offerSourceRecordId,
  );
  const inForce = termsInForceOf(context.effective, context.state.promotion?.basisStandingVersion ?? null);
  return {
    authorizationRef: cycle.authorizationRef,
    offerRef: context.offer.offerRef,
    standing,
    promotion:
      promotionTerms === null ? null : { ...promotionTerms, inForce: context.promotionStatus === "RUNNING" },
    acceptedAt: acceptanceOfPackage(acceptances, context.acceptable)?.acceptedAt ?? null,
    hadEarlierAcceptance: acceptances.length > 0,
    inForceCovered: inForce !== null && acceptanceCoveringTermsInForce(acceptances, inForce) !== null,
  };
}

/** The view for the Promoter's own cycle named by reference; `null` when not its own or none applies. */
export async function readPromoterOfferPackageByRefIn(
  tx: Tx,
  input: { authorizationRef: string; promoterParticipantId: string },
  at: string,
): Promise<PromoterOfferPackageView | null> {
  const cycle = await tx.promotionAuthorization.findUnique({
    where: { authorizationRef: input.authorizationRef },
    select: { id: true, internalProductId: true, promoterParticipantId: true, currentForProductId: true },
  });
  if (cycle === null || cycle.promoterParticipantId !== input.promoterParticipantId) return null;
  const current = await readCurrentPromotionAuthorizationIn(tx, {
    internalProductId: cycle.internalProductId,
    promoterParticipantId: input.promoterParticipantId,
  });
  if (current === null || current.id !== cycle.id) return null;
  return await readPromoterOfferPackageIn(tx, current, at);
}

// — The Seller's view —

/** One APPROVED Promoter's acceptance status, as its Seller sees it. No id of any kind. */
export interface SellerOfferAcceptanceView {
  /** Whether this Promoter's cycle accepted exactly the current package. */
  packageAccepted: boolean;
  /** The current package's acceptance, or else the cycle's latest earlier one; `null` when none. */
  acceptance: { standingVersion: string; promotionVersion: string | null; acceptedAt: string } | null;
}

/**
 * Status for each APPROVED cycle on one Product, keyed by `authorizationRef`.
 * Empty when the Product's Offer has no acceptable package now (not `ACTIVE`).
 */
export async function readSellerOfferAcceptancesIn(
  tx: Tx,
  internalProductId: string,
  authorizationRefs: readonly string[],
  at: string,
): Promise<Map<string, SellerOfferAcceptanceView>> {
  const out = new Map<string, SellerOfferAcceptanceView>();
  if (authorizationRefs.length === 0) return out;
  const context = await readOfferPackageContextIn(tx, internalProductId, at);
  if (context === null || context.acceptable === null) return out;
  const cycles = await tx.promotionAuthorization.findMany({
    where: { authorizationRef: { in: [...authorizationRefs] }, internalProductId },
    select: { id: true, authorizationRef: true },
  });
  const acceptances = await readCycleAcceptancesIn(
    tx,
    cycles.map((c) => c.id),
  );
  for (const c of cycles) {
    const rows = ofOffer(acceptances.get(c.id) ?? [], context.offer.offerSourceRecordId);
    const exact = acceptanceOfPackage(rows, context.acceptable);
    const shown = exact ?? rows[rows.length - 1] ?? null;
    out.set(c.authorizationRef, {
      packageAccepted: exact !== null,
      acceptance:
        shown === null
          ? null
          : { standingVersion: shown.standingVersion, promotionVersion: shown.promotionVersion, acceptedAt: shown.acceptedAt },
    });
  }
  return out;
}

// — The promoted-terms eligibility helper —

/**
 * Are the Seller's terms in force at `at` covered for this Promoter on this
 * Product? Product `ACTIVE`, resale `AVAILABLE`, an `ACTIVE` Offer with terms
 * in force still authored by the Product's Seller, the CURRENT cycle
 * `APPROVED`, not self-promotion, and an acceptance in that cycle covering
 * exactly those terms.
 *
 * NOT transaction eligibility: the answer's `notEvaluated` names the gates it
 * does not ask (Promoter payment and commerce readiness, restrictions, Listing,
 * retail economics, cross-account principals, transaction conditions). On a
 * pass it returns the governing standing / promotion versions, the cycle, and
 * the acceptance evidence. Phase 1.44 wires it into nothing.
 */
export async function readPromotedTermsEligibilityIn(
  tx: Tx,
  input: { internalProductId: string; promoterParticipantId: string; at: string },
): Promise<PromotedTermsEligibility<StoredOfferAcceptance>> {
  const { internalProductId, promoterParticipantId, at } = input;
  const product = await readProductLifecycleIn(tx, internalProductId);
  const { resaleAvailability } = await readProductResaleAvailabilityIn(tx, internalProductId);
  const context = await readOfferPackageContextIn(tx, internalProductId, at);
  const cycle = await readCurrentPromotionAuthorizationIn(tx, { internalProductId, promoterParticipantId });
  const acceptances =
    cycle === null || context === null
      ? []
      : ofOffer((await readCycleAcceptancesIn(tx, [cycle.id])).get(cycle.id) ?? [], context.offer.offerSourceRecordId);

  return decidePromotedTermsEligibility({
    productLifecycle: product?.lifecycle.lifecycle ?? null,
    resaleAvailability,
    offer:
      context === null
        ? null
        : {
            internalOfferId: context.offer.internalOfferId,
            offerSourceRecordId: context.offer.offerSourceRecordId,
            sellerHoldsAuthority: product?.authorityParticipantId === context.offer.sellerParticipantId,
            effective: context.effective,
            promotionBasisStandingVersion: context.state.promotion?.basisStandingVersion ?? null,
          },
    authorization: cycle === null ? null : { authorizationId: cycle.id, state: cycle.state },
    selfPromotion: await participantHoldsProductAuthority(tx, internalProductId, promoterParticipantId),
    acceptances,
  });
}
