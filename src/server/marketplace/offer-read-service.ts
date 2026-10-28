/**
 * The Seller's own Offer, for `/account` (Phase 1.42) — SERVER ONLY.
 *
 * Reads only. For each of a Seller's Products: the Product's current Offer (the
 * non-terminal one, else the most recent terminal one so its end is visible),
 * its derived lifecycle and promotion status at an explicit instant, the
 * standing terms and their economics, the current promotion, the readiness
 * blockers that stand between it and going live, and which acts the page may
 * offer. Every decision is the contract's or the Offer service's; this module
 * only assembles it.
 *
 * Seller-facing: this module is the Seller's view of its own Offer, with Seller
 * proceeds, blockers, and acts. Promoters see only the terms in force — wholesale
 * and commission, no Seller proceeds — and only through the Promotable Catalog
 * (Phase 1.43, `promotable-catalog-read-service`). Nothing here is published,
 * and no internal id leaves this module — only `offerRef` and version labels.
 */

import "../server-only";
import type { Prisma } from "@prisma/client";
import {
  canActivateOffer,
  canChangeOfferTerms,
  canEndPromotion,
  canPauseOffer,
  canResumeOffer,
  canSchedulePromotion,
  canWithdrawOffer,
  evaluateOfferActivationReadiness,
  isOfferActionAvailable,
  isPendingPromotionStatus,
  type OfferActivationBlocker,
  type OfferLifecycleState,
  type OfferPromotionStatus,
  type OfferSourceVersion,
} from "../../contracts/marketplace/offer-source";
import { getPrisma } from "../db/client";
import { readProductLifecycleIn, readSellerReadinessFactsIn } from "../product/product-lifecycle-service";
import { readParticipantStanding } from "./participant-standing-service";
import { resolveActingSubject } from "./acting-subject-service";
import { participantHoldsProductAuthority } from "./product-authority-service";
import { evaluateOfferCreationIn, lifecycleAt, promotionStatusAt, readOfferStateIn } from "./offer-service";

type Tx = ReturnType<typeof getPrisma> | Prisma.TransactionClient;

export interface SellerOfferTermsView {
  version: string;
  wholesalePriceMinorUnits: number;
  currency: string;
  commission:
    | { method: "PERCENT_OF_WHOLESALE"; commissionBasisPoints: number }
    | { method: "FIXED_AMOUNT"; fixedCommissionMinorUnits: number };
  calculatedCommissionMinorUnits: number;
  calculatedSellerGrossProceedsMinorUnits: number;
  commissionCalculationPolicyVersion: string;
}

export interface SellerOfferView {
  offerRef: string;
  lifecycle: OfferLifecycleState;
  /** Which terms are in force now — never an aggregate commerce gate. */
  effective: "STANDING" | "SCHEDULED_PROMOTION" | "NONE";
  offerEffectiveUntil: string | null;
  standing: SellerOfferTermsView;
  /**
   * The current promotion. `status` is its SCHEDULE status — what its window,
   * any early end, and any replacement say at this instant — and is history,
   * not effect. `inForce` says whether its terms are the ones in force now: a
   * window covering this instant on a PAUSED, WITHDRAWN, or ENDED Offer is
   * `RUNNING` but not in force, and must never be shown as running.
   */
  promotion:
    | (SellerOfferTermsView & {
        status: OfferPromotionStatus;
        inForce: boolean;
        effectiveFrom: string;
        effectiveUntil: string;
      })
    | null;
  /** The label the next revision or promotion will mint — what a confirmation names. */
  nextVersion: string;
  /** Activation / resumption blockers; empty unless DRAFT or PAUSED. */
  blockers: OfferActivationBlocker[];
  actions: {
    revise: boolean;
    activate: boolean;
    pause: boolean;
    resume: boolean;
    withdraw: boolean;
    schedulePromotion: boolean;
    replacePromotion: boolean;
    endPromotion: boolean;
  };
}

export interface SellerProductOffer {
  /** The Product's current or most recent Offer; `null` if it never had one. */
  offer: SellerOfferView | null;
  /**
   * A new Offer may be created at this instant: the create operation's own gates
   * (`evaluateOfferCreationIn`) — authority, drafting, suspension, and no
   * non-terminal Offer — would admit it.
   */
  canCreate: boolean;
}

function termsView(version: OfferSourceVersion): SellerOfferTermsView | null {
  const { price, promotion } = version.terms;
  if (price.type !== "PAID" || promotion.type !== "PROMOTABLE") return null;
  const c = promotion.commission;
  return {
    version: version.sourceRecordVersion,
    wholesalePriceMinorUnits: price.wholesalePriceMinorUnits,
    currency: price.wholesalePriceCurrency,
    commission:
      c.method === "PERCENT_OF_WHOLESALE"
        ? { method: c.method, commissionBasisPoints: c.commissionBasisPoints }
        : { method: c.method, fixedCommissionMinorUnits: c.fixedCommissionMinorUnits },
    calculatedCommissionMinorUnits: version.economics.calculatedCommissionMinorUnits,
    calculatedSellerGrossProceedsMinorUnits: version.economics.calculatedCreatorGrossProceedsMinorUnits,
    commissionCalculationPolicyVersion: version.economics.commissionCalculationPolicyVersion,
  };
}

async function blockersFor(
  tx: Tx,
  internalProductId: string,
  sellerParticipantId: string,
): Promise<OfferActivationBlocker[]> {
  const [product, readiness, standing] = await Promise.all([
    readProductLifecycleIn(tx, internalProductId),
    readSellerReadinessFactsIn(tx, sellerParticipantId),
    readParticipantStanding(tx, sellerParticipantId),
  ]);
  return evaluateOfferActivationReadiness({
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
  }).blockers;
}

/** Each Product's Offer as its Seller — acting as `accountId` — sees it, at `at`. */
export async function readSellerProductOffersIn(
  tx: Tx,
  internalProductIds: readonly string[],
  actor: { accountId: string; sellerParticipantId: string },
  at: string,
): Promise<Map<string, SellerProductOffer>> {
  const { sellerParticipantId } = actor;
  /* The acting subject, as every Offer act resolves it — so each action below is
     offered only when the act's own authority decision would admit it. */
  const subject = await resolveActingSubject(tx, actor.accountId);
  const out = new Map<string, SellerProductOffer>();
  if (internalProductIds.length === 0) return out;

  const offers = await tx.offer.findMany({
    where: { internalProductId: { in: [...internalProductIds] }, sellerParticipantId },
    orderBy: { createdAt: "desc" },
  });

  for (const internalProductId of internalProductIds) {
    const canCreate = (await evaluateOfferCreationIn(tx, actor.accountId, internalProductId, at)).allowed;
    const forProduct = offers.filter((o) => o.internalProductId === internalProductId);
    const current = forProduct.find((o) => o.nonTerminalForProductId !== null) ?? forProduct[0];
    if (current === undefined) {
      out.set(internalProductId, { offer: null, canCreate });
      continue;
    }
    const state = await readOfferStateIn(tx, current);
    const lifecycle = lifecycleAt(state, at);
    const promotionStatus = promotionStatusAt(state, at);
    const standing = termsView(state.standing);
    const promotionTerms = state.promotion === null ? null : termsView(state.promotion);
    if (standing === null) {
      out.set(internalProductId, { offer: null, canCreate });
      continue;
    }
    const pending = promotionStatus !== null && isPendingPromotionStatus(promotionStatus);
    const request = {
      subject,
      offerSellerParticipantId: current.sellerParticipantId,
      hasProductAuthority: await participantHoldsProductAuthority(tx, internalProductId, sellerParticipantId),
      lifecycle,
    };
    const blockers =
      lifecycle === "DRAFT" || lifecycle === "PAUSED"
        ? await blockersFor(tx, internalProductId, sellerParticipantId)
        : [];
    const effective =
      lifecycle !== "ACTIVE" ? "NONE" : promotionStatus === "RUNNING" ? "SCHEDULED_PROMOTION" : "STANDING";

    out.set(internalProductId, {
      offer: {
        offerRef: current.offerRef,
        lifecycle,
        effective,
        offerEffectiveUntil: state.resolution.offerEffectiveUntil,
        standing,
        promotion:
          promotionTerms === null || state.resolution.promotion === null || promotionStatus === null
            ? null
            : {
                ...promotionTerms,
                status: promotionStatus,
                inForce: effective === "SCHEDULED_PROMOTION",
                effectiveFrom: state.resolution.promotion.window.effectiveFrom,
                effectiveUntil: state.resolution.promotion.window.effectiveUntil,
              },
        nextVersion: String(state.versionCount + 1),
        blockers,
        /* Each act's own contract decision (a missing confirmation aside — the
           two-step exchange supplies it), plus the service's own state checks. */
        actions: {
          revise: !pending && isOfferActionAvailable(canChangeOfferTerms(request)),
          activate: blockers.length === 0 && isOfferActionAvailable(canActivateOffer(request)),
          pause: isOfferActionAvailable(canPauseOffer(request)),
          resume: blockers.length === 0 && isOfferActionAvailable(canResumeOffer(request)),
          withdraw: isOfferActionAvailable(canWithdrawOffer(request)),
          schedulePromotion: !pending && isOfferActionAvailable(canSchedulePromotion(request)),
          replacePromotion: promotionStatus === "SCHEDULED" && isOfferActionAvailable(canSchedulePromotion(request)),
          endPromotion: promotionStatus === "RUNNING" && isOfferActionAvailable(canEndPromotion(request)),
        },
      },
      canCreate,
    });
  }
  return out;
}
