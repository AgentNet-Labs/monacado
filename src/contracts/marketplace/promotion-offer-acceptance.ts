/**
 * Promoter Offer-package acceptance (Phase 1.44, Contract §16.3(7), §19) — pure.
 *
 * Promotion Authorization answers "may this Promoter promote this Product?".
 * Acceptance answers a different question: "has this APPROVED Promoter accepted
 * the Seller's exact commercial terms?". Approval is never acceptance.
 *
 * ## The package
 *
 * There is one Seller-authored Offer per Product. What a Promoter accepts is the
 * Offer's commercial PACKAGE at the instant it accepts — one of:
 *
 *   - `{S}`    — the exact current STANDING version, when no promotion is
 *                SCHEDULED or RUNNING;
 *   - `{S, P}` — S together with the exact SCHEDULED_PROMOTION version P built
 *                on it, while P is SCHEDULED or RUNNING.
 *
 * Acceptance is all-or-nothing: there is no act that accepts S while a promotion
 * is pending, and none that accepts P without S. Accepting `{S, P}` includes
 * accepting S.
 *
 * ## Coverage — derived, never stored
 *
 * Whether the terms IN FORCE at an instant (`effectiveOfferTerms`) are accepted
 * is derived from the cycle's immutable acceptance rows:
 *
 *   - S in force is covered by ANY acceptance naming S — `{S}` or `{S, P}`;
 *   - P in force is covered only by an acceptance naming exactly `(S, P)`.
 *
 * So a promotion starting needs no new acceptance if `{S, P}` was accepted, a
 * running promotion that was not accepted is NOT covered (there is no fallback
 * to S during the Seller's window), and when it ends or is ended early, S is
 * covered again by the earlier `{S}` or `{S, P}` row with no write at all. A
 * replacement P2 is a different version, and `{S, P}` does not cover it; a new
 * standing version S2 has no row until the Promoter accepts it.
 *
 * Every live version differs materially from its predecessor (a revision with
 * no material change is refused), so exact-version coverage is §19's rule. If a
 * non-material version kind is ever introduced, this must be revisited
 * deliberately — never loosened by inference.
 *
 * Nothing here characterizes promotional terms as better or worse than the
 * standard ones: Monacado presents the exact terms and the Promoter decides.
 */

import { z } from "zod";
import {
  CommissionCalculationPolicyVersion,
  CurrencyCode,
  MAX_COMMISSION_BASIS_POINTS,
  MAX_MINOR_UNIT_AMOUNT,
  MIN_COMMISSION_BASIS_POINTS,
  OfferRef,
  OfferSourceRecordVersion,
  isPendingPromotionStatus,
  type EffectiveOfferTerms,
  type OfferLifecycleState,
  type OfferPromotionStatus,
  type OfferSourceVersion,
} from "./offer-source";
import type { ProductLifecycleState } from "../product/product-lifecycle";
import type { ProductResaleAvailability } from "../product/product-resale-availability";
import type { PromotionAuthorizationState } from "./promotion-authorization";

// — The exact package, as the Promoter confirms it —

const MinorUnits = z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT);

/** Commission exactly as the Offer states it: a percentage, or a fixed amount. */
export const AcceptedCommission = z.discriminatedUnion("method", [
  z.strictObject({
    method: z.literal("PERCENT_OF_WHOLESALE"),
    commissionBasisPoints: z.int().min(MIN_COMMISSION_BASIS_POINTS).max(MAX_COMMISSION_BASIS_POINTS),
  }),
  z.strictObject({ method: z.literal("FIXED_AMOUNT"), fixedCommissionMinorUnits: MinorUnits }),
]);
export type AcceptedCommission = z.infer<typeof AcceptedCommission>;

/**
 * One version's terms as the Promoter was shown them: the exact version label
 * and the economics. No Seller proceeds (Promoters are never shown them), no
 * retail price (the Listing's), and no Monacado retention (policy).
 */
const acceptedTermsShape = {
  version: OfferSourceRecordVersion,
  wholesalePriceMinorUnits: MinorUnits,
  currency: CurrencyCode,
  commission: AcceptedCommission,
  calculatedCommissionMinorUnits: MinorUnits,
  commissionCalculationPolicyVersion: CommissionCalculationPolicyVersion,
};
export const AcceptedTermsEcho = z.strictObject(acceptedTermsShape);
export type AcceptedTermsEcho = z.infer<typeof AcceptedTermsEcho>;

/** A promotion's terms, plus its exact window. */
export const AcceptedPromotionEcho = z.strictObject({
  ...acceptedTermsShape,
  effectiveFrom: z.iso.datetime(),
  effectiveUntil: z.iso.datetime(),
});
export type AcceptedPromotionEcho = z.infer<typeof AcceptedPromotionEcho>;

/**
 * The acceptance request body: the Offer, the exact standing terms, and the
 * exact promotional terms (or `null` for a standard-only package). There is
 * deliberately no "accept whatever is current" form — every field names or
 * restates something the Promoter was shown.
 */
export const OfferPackageAcceptanceInput = z.strictObject({
  offerRef: OfferRef,
  standing: AcceptedTermsEcho,
  promotion: AcceptedPromotionEcho.nullable(),
});
export type OfferPackageAcceptanceInput = z.infer<typeof OfferPackageAcceptanceInput>;

/** One version's terms in the shape the Promoter is shown — and sends back. */
export function acceptedTermsOf(version: OfferSourceVersion): AcceptedTermsEcho | null {
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
    commissionCalculationPolicyVersion: version.economics.commissionCalculationPolicyVersion,
  };
}

/** A promotion version's terms and window; `null` for a STANDING version. */
export function acceptedPromotionTermsOf(version: OfferSourceVersion): AcceptedPromotionEcho | null {
  const terms = acceptedTermsOf(version);
  if (terms === null || version.termsKind !== "SCHEDULED_PROMOTION" || version.promotionWindow === null) return null;
  return { ...terms, ...version.promotionWindow };
}

function sameInstant(a: string, b: string): boolean {
  return Date.parse(a) === Date.parse(b);
}

function sameTerms(echo: AcceptedTermsEcho, actual: AcceptedTermsEcho): boolean {
  return (
    echo.version === actual.version &&
    echo.wholesalePriceMinorUnits === actual.wholesalePriceMinorUnits &&
    echo.currency === actual.currency &&
    echo.commission.method === actual.commission.method &&
    (echo.commission.method === "PERCENT_OF_WHOLESALE"
      ? actual.commission.method === "PERCENT_OF_WHOLESALE" &&
        echo.commission.commissionBasisPoints === actual.commission.commissionBasisPoints
      : actual.commission.method === "FIXED_AMOUNT" &&
        echo.commission.fixedCommissionMinorUnits === actual.commission.fixedCommissionMinorUnits) &&
    echo.calculatedCommissionMinorUnits === actual.calculatedCommissionMinorUnits &&
    echo.commissionCalculationPolicyVersion === actual.commissionCalculationPolicyVersion
  );
}

/**
 * Does the Promoter's echo restate exactly what these immutable versions say?
 * Versions are compared first by the caller; this is the economics and window.
 */
export function packageEchoMatches(
  echo: { standing: AcceptedTermsEcho; promotion: AcceptedPromotionEcho | null },
  actual: { standing: OfferSourceVersion; promotion: OfferSourceVersion | null },
): boolean {
  const standing = actual.standing.termsKind === "STANDING" ? acceptedTermsOf(actual.standing) : null;
  if (standing === null || !sameTerms(echo.standing, standing)) return false;
  if (echo.promotion === null || actual.promotion === null) return echo.promotion === null && actual.promotion === null;
  const promotion = acceptedPromotionTermsOf(actual.promotion);
  return (
    promotion !== null &&
    sameTerms(echo.promotion, promotion) &&
    sameInstant(echo.promotion.effectiveFrom, promotion.effectiveFrom) &&
    sameInstant(echo.promotion.effectiveUntil, promotion.effectiveUntil)
  );
}

// — Which package may be accepted —

export interface OfferPackage {
  standingVersion: string;
  /** `null` for a standard-only package. */
  promotionVersion: string | null;
}

/**
 * The package a Promoter may accept at an instant — `{S}`, or `{S, P}` while P
 * is SCHEDULED or RUNNING — or `null` unless the Offer is `ACTIVE`. DRAFT,
 * PAUSED, WITHDRAWN, and ENDED admit no new acceptance (Phase 1.44 ruling 4).
 */
export function acceptableOfferPackage(input: {
  lifecycle: OfferLifecycleState;
  standingVersion: string;
  promotion: { sourceRecordVersion: string; status: OfferPromotionStatus } | null;
}): OfferPackage | null {
  if (input.lifecycle !== "ACTIVE") return null;
  const pending = input.promotion !== null && isPendingPromotionStatus(input.promotion.status);
  return {
    standingVersion: input.standingVersion,
    promotionVersion: pending ? input.promotion!.sourceRecordVersion : null,
  };
}

export type OfferPackageMismatch = "STANDING_VERSION_STALE" | "PROMOTION_CHANGED";

/** How a requested package differs from the acceptable one; `null` when it is that package. */
export function offerPackageMismatch(requested: OfferPackage, acceptable: OfferPackage): OfferPackageMismatch | null {
  if (requested.standingVersion !== acceptable.standingVersion) return "STANDING_VERSION_STALE";
  if (requested.promotionVersion !== acceptable.promotionVersion) return "PROMOTION_CHANGED";
  return null;
}

/**
 * Product resale states that admit NEW acceptance (Phase 1.44 ruling 5).
 * `AVAILABLE`, and `PAUSED` — a pause blocks commerce, not assent. `NOT_OFFERED`
 * and `WITHDRAWN` remove third-party resale entirely and admit none.
 */
export const RESALE_STATES_ADMITTING_ACCEPTANCE: readonly ProductResaleAvailability[] = ["AVAILABLE", "PAUSED"];

export function resaleAdmitsAcceptance(resale: ProductResaleAvailability): boolean {
  return RESALE_STATES_ADMITTING_ACCEPTANCE.includes(resale);
}

// — Coverage —

export interface RecordedOfferAcceptance {
  standingVersion: string;
  promotionVersion: string | null;
  acceptedAt: string;
}

const byAcceptedAt = <A extends RecordedOfferAcceptance>(a: A, b: A): number =>
  Date.parse(a.acceptedAt) - Date.parse(b.acceptedAt);

/** The acceptance of exactly this package, if the cycle holds one. */
export function acceptanceOfPackage<A extends RecordedOfferAcceptance>(
  acceptances: readonly A[],
  pkg: OfferPackage,
): A | null {
  return (
    acceptances.find((a) => a.standingVersion === pkg.standingVersion && a.promotionVersion === pkg.promotionVersion) ??
    null
  );
}

/**
 * The acceptance covering a package: exactly that package, or — for `{S}` — an
 * acceptance of `{S, P}`, which includes S. So when a promotion ends and the
 * unchanged S applies again, the earlier `{S, P}` is S's acceptance and no new
 * act is needed. `{S, P}` is covered only exactly. The exact row wins; else the
 * earliest covering one.
 */
export function acceptanceCoveringPackage<A extends RecordedOfferAcceptance>(
  acceptances: readonly A[],
  pkg: OfferPackage,
): A | null {
  return acceptanceOfPackage(acceptances, pkg) ?? acceptanceCoveringTermsInForce(acceptances, pkg);
}

/**
 * The terms in force, as the package members they are: S alone, or P with the
 * standing version it was built on. `null` when no terms are in force.
 */
export interface TermsInForce {
  standingVersion: string;
  promotionVersion: string | null;
}

/**
 * The acceptance covering the terms in force, or `null`. S in force: any row
 * naming S. P in force: exactly `(S, P)`. Several may qualify; the earliest is
 * returned, deterministically — the moment assent to these terms first existed.
 */
export function acceptanceCoveringTermsInForce<A extends RecordedOfferAcceptance>(
  acceptances: readonly A[],
  inForce: TermsInForce,
): A | null {
  const covering = acceptances.filter((a) =>
    inForce.promotionVersion === null
      ? a.standingVersion === inForce.standingVersion
      : a.standingVersion === inForce.standingVersion && a.promotionVersion === inForce.promotionVersion,
  );
  return [...covering].sort(byAcceptedAt)[0] ?? null;
}

/** What `effectiveOfferTerms` resolved, as package members (P needs its basis). */
export function termsInForceOf(
  effective: EffectiveOfferTerms,
  promotionBasisStandingVersion: string | null,
): TermsInForce | null {
  if (effective.kind === "NONE") return null;
  if (effective.kind === "STANDING") return { standingVersion: effective.sourceRecordVersion, promotionVersion: null };
  if (promotionBasisStandingVersion === null) return null;
  return { standingVersion: promotionBasisStandingVersion, promotionVersion: effective.sourceRecordVersion };
}

// — The promoted-terms eligibility gate —

/**
 * Why the Seller's terms in force are not covered for this Promoter. A closed
 * vocabulary; several may hold at once, reported in this order.
 */
export const PROMOTED_TERMS_BLOCKERS = [
  "PRODUCT_NOT_ACTIVE",
  "RESALE_NOT_AVAILABLE",
  "NO_OFFER_TERMS_IN_FORCE",
  "AUTHORIZATION_NOT_APPROVED",
  "SELF_PROMOTION",
  "TERMS_NOT_ACCEPTED",
] as const;
export type PromotedTermsBlocker = (typeof PROMOTED_TERMS_BLOCKERS)[number];

/**
 * Gates this helper deliberately does NOT evaluate. Always returned, so no
 * caller can mistake a pass for "may transact": Phase 1.45 and later own them.
 */
export const PROMOTED_TERMS_NOT_EVALUATED = [
  "PROMOTER_PAYMENT_READINESS",
  "PROMOTER_COMMERCE_APPROVAL",
  "PROMOTER_RESTRICTIONS",
  "LISTING_READINESS",
  "RETAIL_ECONOMICS",
  "CROSS_ACCOUNT_ECONOMIC_PRINCIPAL",
  "TRANSACTION_CONDITIONS",
] as const;
export type PromotedTermsNotEvaluated = (typeof PROMOTED_TERMS_NOT_EVALUATED)[number];

/** Every fact the gate weighs, read from authoritative rows by the caller. */
export interface PromotedTermsFacts<A extends RecordedOfferAcceptance> {
  productLifecycle: ProductLifecycleState | null;
  resaleAvailability: ProductResaleAvailability;
  /** The Product's current Offer, or `null` when it has none. */
  offer: {
    internalOfferId: string;
    offerSourceRecordId: string;
    /** Whether the Offer's author still holds Seller authority over the Product. */
    sellerHoldsAuthority: boolean;
    effective: EffectiveOfferTerms;
    /** The running promotion's basis; `null` unless a promotion is in force. */
    promotionBasisStandingVersion: string | null;
  } | null;
  /** The CURRENT cycle for this Product + Promoter, or `null`. */
  authorization: { authorizationId: string; state: PromotionAuthorizationState } | null;
  selfPromotion: boolean;
  /** The current cycle's acceptances (never another cycle's). */
  acceptances: readonly A[];
}

export type PromotedTermsEligibility<A extends RecordedOfferAcceptance> = {
  notEvaluated: readonly PromotedTermsNotEvaluated[];
} & (
  | {
      eligible: true;
      governing: {
        internalOfferId: string;
        offerSourceRecordId: string;
        standingVersion: string;
        promotionVersion: string | null;
        termsKind: "STANDING" | "SCHEDULED_PROMOTION";
      };
      authorizationId: string;
      acceptance: A;
    }
  | { eligible: false; blockers: PromotedTermsBlocker[] }
);

/**
 * Are the Seller's terms in force covered for this Promoter — Product ACTIVE,
 * resale AVAILABLE, terms in force, the current cycle APPROVED, not
 * self-promotion, and an acceptance covering exactly those terms?
 *
 * NOT "may transact": `notEvaluated` names what it does not ask. On a pass it
 * returns the governing versions, the cycle, and the acceptance evidence, so a
 * later caller can bind exactly what governed.
 */
export function decidePromotedTermsEligibility<A extends RecordedOfferAcceptance>(
  facts: PromotedTermsFacts<A>,
): PromotedTermsEligibility<A> {
  const notEvaluated = PROMOTED_TERMS_NOT_EVALUATED;
  const blockers: PromotedTermsBlocker[] = [];
  if (facts.productLifecycle !== "ACTIVE") blockers.push("PRODUCT_NOT_ACTIVE");
  if (facts.resaleAvailability !== "AVAILABLE") blockers.push("RESALE_NOT_AVAILABLE");
  const inForce =
    facts.offer !== null && facts.offer.sellerHoldsAuthority
      ? termsInForceOf(facts.offer.effective, facts.offer.promotionBasisStandingVersion)
      : null;
  if (inForce === null) blockers.push("NO_OFFER_TERMS_IN_FORCE");
  if (facts.authorization?.state !== "APPROVED") blockers.push("AUTHORIZATION_NOT_APPROVED");
  if (facts.selfPromotion) blockers.push("SELF_PROMOTION");
  const acceptance = inForce === null ? null : acceptanceCoveringTermsInForce(facts.acceptances, inForce);
  if (acceptance === null) blockers.push("TERMS_NOT_ACCEPTED");

  if (blockers.length > 0 || inForce === null || acceptance === null || facts.offer === null || facts.authorization === null) {
    return { notEvaluated, eligible: false, blockers };
  }
  return {
    notEvaluated,
    eligible: true,
    governing: {
      internalOfferId: facts.offer.internalOfferId,
      offerSourceRecordId: facts.offer.offerSourceRecordId,
      standingVersion: inForce.standingVersion,
      promotionVersion: inForce.promotionVersion,
      termsKind: inForce.promotionVersion === null ? "STANDING" : "SCHEDULED_PROMOTION",
    },
    authorizationId: facts.authorization.authorizationId,
    acceptance,
  };
}
