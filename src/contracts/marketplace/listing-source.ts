/**
 * Authoritative Listing source model (Phase 0M.4A).
 *
 * The **authoritative transactional record** for the buyer-facing placement of a
 * Product in a Storefront, plus the immutable source versions a later Capsule
 * Projection Shape will be generated *from*. Business truth, not a published
 * artifact.
 *
 * Seven properties shape everything below:
 *
 *   1. **The database is the sole source of truth** (ADR §12). Every field here
 *      is authoritative. A capsule never supplies data to this record, never
 *      repairs it, and never overrides it.
 *
 *   2. **Two Listing types, structurally impossible to confuse.** A
 *      `SELLER_DIRECT` Listing has no field for an Offer dependency; a
 *      `PROMOTED` Listing has no field for a scheduled sale. They are a
 *      discriminated union, so the wrong field cannot be set — not "is rejected
 *      by a rule", but has nowhere to go.
 *
 *   3. **A promoter's retail price never touches the seller's economics.**
 *      Changing it creates no Offer version, alters no wholesale price, and
 *      changes nothing the seller agreed to. The Offer stays authoritative for
 *      wholesale, and this record binds to one exact Offer source version.
 *
 *   4. **A seller's temporary sale is local to that Listing.** It does not
 *      change the wholesale price, mint an Offer version, alter any promoted
 *      Listing, or create an obligation toward a promoter. There is no field
 *      here through which it could.
 *
 *   5. **Monacado is the Merchant of Record, not a fee collector.** It acquires
 *      the item at the moment of sale for a wholesale acquisition amount derived
 *      from the commercial retail price, and its economics are what it retains
 *      from that price — never a separate platform fee charged on top. Money is
 *      integer minor units, and the versioned acquisition policy is supplied by
 *      the caller, so a commercial decision never becomes a code constant.
 *
 *   6. **The commercial price is the merchandise price alone.** Tax, VAT, GST,
 *      shipping, freight, and other checkout pass-through amounts are outside
 *      every basis here. There is no field for any of them, so none can enter one.
 *
 *   7. **Derived values are derived, never stored.** Effective seller price,
 *      sale-active status, retained amount, acquisition amount, promoter
 *      proceeds, promoter margin rate, minimum viable retail, and buyer-active
 *      eligibility are all computed from the authoritative inputs. A stored copy
 *      is a second answer that can disagree with the first.
 *
 * No projection machinery: no capsule shape, JSON-LD, ontology term, Node or
 * capsule identity, mapping version, publication state, or Registrar field. No
 * persistence, checkout, payment, or risk-management policy selection.
 *
 * Pure data and pure decisions. No database, clock, environment read,
 * randomness, or network. Not exported through the browser-facing barrel.
 */

import { z } from "zod";
import { ACTOR_ID_RE, INTERNAL_PRODUCT_ID_RE, SOURCE_RECORD_ID_RE } from "../capsule/identity";
import { GeneralAvailabilityState } from "../product/product.capsule";
import { INTERNAL_LISTING_ID_RE, INTERNAL_STOREFRONT_ID_RE } from "./identity";
import { MarketplaceParticipantId, RoleAssignmentStatus, ParticipantStatus } from "./participant";
import {
  CurrencyCode,
  MAX_MINOR_UNIT_AMOUNT,
  MinorUnitAmount,
  OfferSourceRecordId,
  OfferSourceRecordVersion,
  InternalOfferId,
  type OfferAvailability,
  type OfferBusinessChangeCategory,
  type OfferLifecycleState,
} from "./offer-source";
import {
  isPubliclyAccessible,
  type StorefrontExposure,
} from "./storefront-source";

// — Identity —

/** The Listing's source-record identity, in the existing `mon:srec:` form. */
export const ListingSourceRecordId = z
  .string()
  .regex(SOURCE_RECORD_ID_RE, "listingSourceRecordId must be opaque (mon:srec:<opaque>)");
export type ListingSourceRecordId = z.infer<typeof ListingSourceRecordId>;

/** The enduring internal Listing identity. Never an ANS Node or capsule id. */
export const InternalListingId = z
  .string()
  .regex(INTERNAL_LISTING_ID_RE, "internalListingId must be mon:listing:<opaque>");
export type InternalListingId = z.infer<typeof InternalListingId>;

export const InternalStorefrontRef = z
  .string()
  .regex(INTERNAL_STOREFRONT_ID_RE, "storefrontId must be mon:storefront:<opaque>");

export const InternalProductRef = z
  .string()
  .regex(INTERNAL_PRODUCT_ID_RE, "internalProductId must be mon:product:<opaque>");

export const AuthorizingActorId = z
  .string()
  .regex(ACTOR_ID_RE, "authorizedByActorId must be mon:actor:<opaque>");

/** Opaque, monotonically-meaningful version label, as Offer and Storefront use. */
export const ListingSourceRecordVersion = z.string().min(1).max(64);
export type ListingSourceRecordVersion = z.infer<typeof ListingSourceRecordVersion>;

// — Listing type —

/**
 * The two ways a Product reaches a buyer.
 *
 * `SELLER_DIRECT` — the seller places their own Product in their own Storefront
 * and sets the retail price. No Offer is involved: there is no third party to
 * agree wholesale terms with.
 *
 * `PROMOTED` — a promoter resells someone else's Product under an Offer's
 * wholesale terms, at a retail price the promoter controls.
 */
export const LISTING_TYPES = ["SELLER_DIRECT", "PROMOTED"] as const;
export const ListingType = z.enum(LISTING_TYPES);
export type ListingType = z.infer<typeof ListingType>;

// — Lifecycle —

/**
 * The Listing's own operational lifecycle.
 *
 * Deliberately the **same vocabulary the Offer uses**, member for member, so a
 * reader does not have to learn a third set of words for the same commercial
 * shape. It is a separate constant rather than a shared import because a Listing
 * and an Offer are different entities whose vocabularies must be free to diverge
 * without one silently changing the other.
 *
 * This is **not** publication lifecycle and not ANS Node lifecycle. Nothing here
 * describes a capsule.
 */
export const LISTING_LIFECYCLE_STATES = [
  "DRAFT",
  "ACTIVE",
  "SUSPENDED",
  "ENDED",
  "WITHDRAWN",
] as const;
export const ListingLifecycleState = z.enum(LISTING_LIFECYCLE_STATES);
export type ListingLifecycleState = z.infer<typeof ListingLifecycleState>;

/** `ENDED` and `WITHDRAWN` are terminal, as they are for an Offer. */
export const LISTING_LIFECYCLE_TRANSITIONS: Record<
  ListingLifecycleState,
  readonly ListingLifecycleState[]
> = Object.freeze({
  DRAFT: ["ACTIVE", "WITHDRAWN"],
  ACTIVE: ["SUSPENDED", "ENDED", "WITHDRAWN"],
  SUSPENDED: ["ACTIVE", "ENDED", "WITHDRAWN"],
  ENDED: [],
  WITHDRAWN: [],
});

export const INITIAL_LISTING_LIFECYCLE_STATE: ListingLifecycleState = "DRAFT";

export function isValidListingLifecycleTransition(
  from: ListingLifecycleState,
  to: ListingLifecycleState,
): boolean {
  return LISTING_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function isTerminalListingLifecycleState(state: ListingLifecycleState): boolean {
  return LISTING_LIFECYCLE_TRANSITIONS[state].length === 0;
}

// — Retail price —

/** A retail price: what a buyer is asked to pay. Always minor units. */
export const RetailPrice = z.strictObject({
  retailPriceMinorUnits: MinorUnitAmount,
  retailPriceCurrency: CurrencyCode,
});
export type RetailPrice = z.infer<typeof RetailPrice>;

// — Seller scheduled sale —

/**
 * An optional temporary sale on a **seller-direct** Listing.
 *
 * All three fields live in one nested object, so "all present or all absent" is
 * the shape rather than a refinement anyone can forget: there is no way to supply
 * a start without a price.
 *
 * `salePriceCurrency` is required and checked against the ordinary retail
 * currency rather than inherited from it — the same treatment the Offer gives a
 * fixed commission's currency. Copying it silently would paper over a caller that
 * genuinely disagreed, which is the case worth surfacing.
 *
 * **Timing is UTC instants, start inclusive, end exclusive.** A half-open
 * interval means two consecutive sales cannot both be active for the instant they
 * touch.
 */
export const SellerSaleSchedule = z.strictObject({
  salePriceMinorUnits: MinorUnitAmount,
  salePriceCurrency: CurrencyCode,
  /** Inclusive. The sale is active at exactly this instant. */
  saleStartsAt: z.iso.datetime(),
  /** Exclusive. The sale is over at exactly this instant. */
  saleEndsAt: z.iso.datetime(),
});
export type SellerSaleSchedule = z.infer<typeof SellerSaleSchedule>;

// — Offer dependency (promoted only) —

/**
 * The exact Offer source version whose wholesale economics this promoter accepted.
 *
 * **Not a copy of the Offer.** Only the identity, the exact version, and the
 * economics actually accepted are recorded — enough to reconstruct what the
 * promoter agreed to and to detect when the upstream Offer has moved past it.
 * Duplicating the Offer would create a second, divergent answer to the seller's
 * own terms.
 *
 * The accepted wholesale price and commission are both **inputs** to the promoted
 * reconciliation below: the seller is owed `wholesale − commission`, and the
 * promoter earns the retail spread over that wholesale price **plus** the
 * seller-funded commission. The Offer stays authoritative for both numbers and
 * neither is recomputed here.
 */
export const AcceptedOfferDependency = z.strictObject({
  internalOfferId: InternalOfferId,
  offerSourceRecordId: OfferSourceRecordId,
  /** The EXACT version accepted — never "current", never "latest". */
  acceptedOfferSourceRecordVersion: OfferSourceRecordVersion,

  /** The wholesale cost this Listing's economics were accepted against. */
  acceptedWholesalePriceMinorUnits: MinorUnitAmount,
  acceptedWholesalePriceCurrency: CurrencyCode,

  /** Recorded for audit; not an input to promoter proceeds. */
  acceptedCommissionCalculationPolicyVersion: z.string().min(1).max(64),

  /** When the promoter accepted these terms. An explicit instant. */
  acceptedAt: z.iso.datetime(),
});
export type AcceptedOfferDependency = z.infer<typeof AcceptedOfferDependency>;

// — Upstream Offer review —

/**
 * Whether the upstream Offer has moved in a way the promoter must answer for.
 *
 * The middle state is the point of the whole mechanism: a wholesale-price change
 * must **never silently reprice an active promoted Listing**. The promoter agreed
 * to a number, and a new number is a new agreement.
 */
export const LISTING_UPSTREAM_REVIEW_STATES = [
  /** The accepted version is still the relevant one. */
  "NO_UPSTREAM_CHANGE",
  /** Upstream economics changed materially; the promoter must explicitly accept. */
  "REVIEW_REQUIRED",
  /** The promoter explicitly accepted the current relevant version. */
  "ACCEPTED_CURRENT_VERSION",
] as const;
export const ListingUpstreamReviewState = z.enum(LISTING_UPSTREAM_REVIEW_STATES);
export type ListingUpstreamReviewState = z.infer<typeof ListingUpstreamReviewState>;

/**
 * Offer business-change categories that force a promoter review.
 *
 * A wholesale-price change is the obvious one — it moves the promoter's cost
 * basis directly. Commission-terms changes are included because the Offer records
 * them as a distinct material category and a promoter's agreement was to the
 * whole of the terms, not to the price alone.
 *
 * `COMMERCIAL_AVAILABILITY_CHANGED` is deliberately **absent**: availability is
 * handled by upstream blocking, which stops the Listing selling without demanding
 * the promoter re-agree to economics that did not move.
 */
export const REVIEW_FORCING_OFFER_CHANGES: readonly OfferBusinessChangeCategory[] = Object.freeze([
  "WHOLESALE_PRICE_CHANGED",
  "COMMISSION_TERMS_CHANGED",
  "OTHER_MATERIAL_OFFER_CHANGE",
]);

export function offerChangeForcesReview(category: OfferBusinessChangeCategory): boolean {
  return REVIEW_FORCING_OFFER_CHANGES.includes(category);
}

/**
 * Decide the review state for one promoted Listing.
 *
 * Pure and total. `changeCategories` describes what moved between the accepted
 * version and the current one; an empty list with a newer version means the Offer
 * was revised in a way that does not affect this Listing.
 *
 * **Acceptance is explicit.** There is no path here that upgrades an accepted
 * version by observing a new one — the caller must record a new
 * `AcceptedOfferDependency` for that.
 */
export function evaluateUpstreamOfferReview(input: {
  acceptedOfferSourceRecordVersion: string;
  currentOfferSourceRecordVersion: string;
  changeCategoriesSinceAccepted: readonly OfferBusinessChangeCategory[];
}): ListingUpstreamReviewState {
  if (input.acceptedOfferSourceRecordVersion === input.currentOfferSourceRecordVersion) {
    return "ACCEPTED_CURRENT_VERSION";
  }
  return input.changeCategoriesSinceAccepted.some(offerChangeForcesReview)
    ? "REVIEW_REQUIRED"
    : "NO_UPSTREAM_CHANGE";
}

// — Monacado wholesale-acquisition policy (Merchant of Record) —

/**
 * The applicable Monacado wholesale-acquisition policy, **supplied by the caller**.
 *
 * Monacado is the retailer and **Merchant of Record** for the buyer-facing
 * transaction. It does not charge the seller or promoter a platform fee on the
 * side: it *acquires* the item at the moment of sale for a wholesale acquisition
 * amount derived from the commercial retail price, and its economics are the
 * amount it retains from that price.
 *
 * ```
 * monacadoRetainedAmount     = percentage(R) + fixed
 * morWholesaleAcquisitionAmount = R − monacadoRetainedAmount
 * ```
 *
 * The current standard policy is 750 basis points plus a small fixed amount, so
 * the acquisition amount is `92.5% of R − fixed`. **Those numbers are not in this
 * module.** They are a commercial decision that will change, and a constant here
 * would make the next repricing a code change inside an economics contract — a
 * test asserts none is embedded. `0M.R` may later supply a different or
 * risk-adjusted policy through this same input.
 *
 * This replaces the earlier "Monacado fee policy" framing, which modelled the
 * platform's economics as a fee charged *to the promoter in addition to* a
 * wholesale purchase. Under the MoR model that would count Monacado's retention
 * twice — once inside the acquisition amount and once as a separate deduction.
 */
export const MonacadoWholesaleAcquisitionPolicy = z.strictObject({
  /** Identifies which policy this is. Opaque to Listing logic. */
  policyId: z.string().min(1).max(191),
  /** The exact version. Economics are only reproducible with it. */
  policyVersion: z.string().min(1).max(64),

  /** The currency this policy is denominated in. Checked, never coerced. */
  currency: CurrencyCode,

  /** Percentage Monacado retains, in basis points (1 = 0.01%). May be zero. */
  retainedPercentageBasisPoints: z.int().min(0).max(10_000),
  /** Fixed amount Monacado retains, in minor units. May be zero. */
  retainedFixedAmountMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),

  /**
   * Stated explicitly so a policy carries its own rounding rule rather than
   * inheriting whatever the calculator happens to do. Matches the Offer's
   * commission rounding.
   */
  roundingPolicy: z.literal("HALF_UP_TO_MINOR_UNIT"),
});
export type MonacadoWholesaleAcquisitionPolicy = z.infer<
  typeof MonacadoWholesaleAcquisitionPolicy
>;

export class ListingEconomicsError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ListingEconomicsError";
    this.code = code;
  }
}

/**
 * Half-up rounding of `amount × basisPoints / 10000`, in `BigInt`.
 *
 * `BigInt` for the same reason the Offer calculator uses it: `amount × bp`
 * exceeds `Number.MAX_SAFE_INTEGER` for ordinary amounts in small-unit
 * currencies, and a silent precision loss in money surfaces months later as a
 * settlement complaint.
 */
function halfUpBasisPoints(amountMinorUnits: number, basisPoints: number): number {
  const scaled = (BigInt(amountMinorUnits) * BigInt(basisPoints) + 5_000n) / 10_000n;
  if (scaled > BigInt(MAX_MINOR_UNIT_AMOUNT)) {
    throw new ListingEconomicsError(
      "RETAINED_AMOUNT_OUT_OF_RANGE",
      "calculated retained amount exceeds the safe minor-unit range",
    );
  }
  return Number(scaled);
}

/**
 * The **commercial retail price** a policy applies to.
 *
 * Deliberately named: the basis is the merchandise or service price alone. Sales
 * tax, VAT, GST, shipping, freight, delivery, and other approved checkout
 * pass-through amounts are **outside** it. They may be added to a buyer's
 * checkout total later, and they must never enlarge Monacado's retained amount,
 * the acquisition amount, a seller-funded commission, or a promoter's margin.
 *
 * No tax or shipping field exists on the Listing source model, so none can enter
 * this basis by accident — the exclusion is structural, not a rule to remember.
 */
export const CommercialRetailBasis = z.strictObject({
  commercialRetailPriceMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  currency: CurrencyCode,
});
export type CommercialRetailBasis = z.infer<typeof CommercialRetailBasis>;

/** What Monacado retains from one sale at the given commercial retail price. */
export function calculateMonacadoRetainedAmount(input: {
  commercialRetailPriceMinorUnits: number;
  currency: string;
  policy: MonacadoWholesaleAcquisitionPolicy;
}): number {
  const policy = MonacadoWholesaleAcquisitionPolicy.parse(input.policy);
  if (policy.currency !== input.currency) {
    throw new ListingEconomicsError(
      "POLICY_CURRENCY_MISMATCH",
      "the wholesale-acquisition policy currency does not match the commercial price currency",
    );
  }
  const percentage = halfUpBasisPoints(
    input.commercialRetailPriceMinorUnits,
    policy.retainedPercentageBasisPoints,
  );
  const total = percentage + policy.retainedFixedAmountMinorUnits;
  if (total > MAX_MINOR_UNIT_AMOUNT) {
    throw new ListingEconomicsError(
      "RETAINED_AMOUNT_OUT_OF_RANGE",
      "calculated retained amount exceeds the safe minor-unit range",
    );
  }
  return total;
}

export const MorAcquisitionResult = z.strictObject({
  commercialRetailPriceMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  monacadoRetainedAmountMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  /**
   * What Monacado pays the supply side for the item at the moment of sale.
   *
   * **Distinct from the Offer's `wholesalePriceMinorUnits`**, which is the fixed
   * amount a creator contracted to be owed. This one is derived from retail and
   * is the whole pool the supply side is paid out of. The two are different
   * economic layers and are never called by the same name.
   */
  morWholesaleAcquisitionAmountMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  currency: CurrencyCode,
  policyId: z.string().min(1).max(191),
  policyVersion: z.string().min(1).max(64),
});
export type MorAcquisitionResult = z.infer<typeof MorAcquisitionResult>;

/**
 * Monacado's acquisition of one item at the moment of sale.
 *
 * `acquisition = commercialRetail − retained`. Refuses a negative acquisition
 * amount: a price too small to cover the fixed retention cannot be sold under
 * that policy, and reporting a negative number would leave the caller to notice.
 */
export function calculateMorWholesaleAcquisition(input: {
  commercialRetailPriceMinorUnits: number;
  currency: string;
  policy: MonacadoWholesaleAcquisitionPolicy;
}): MorAcquisitionResult {
  const policy = MonacadoWholesaleAcquisitionPolicy.parse(input.policy);
  const retained = calculateMonacadoRetainedAmount(input);
  const acquisition = input.commercialRetailPriceMinorUnits - retained;
  if (acquisition < 0) {
    throw new ListingEconomicsError(
      "NEGATIVE_ACQUISITION_AMOUNT",
      "the commercial retail price does not cover the Monacado retained amount",
    );
  }
  return MorAcquisitionResult.parse({
    commercialRetailPriceMinorUnits: input.commercialRetailPriceMinorUnits,
    monacadoRetainedAmountMinorUnits: retained,
    morWholesaleAcquisitionAmountMinorUnits: acquisition,
    currency: input.currency,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
  });
}

// — Seller-direct economics —

export const SellerDirectEconomics = z.strictObject({
  effectiveCommercialRetailPriceMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  saleActive: z.boolean(),
  monacadoRetainedAmountMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  morWholesaleAcquisitionAmountMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  /** What the seller receives. With no Offer in play, the whole acquisition. */
  sellerProceedsMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  currency: CurrencyCode,
  policyId: z.string().min(1).max(191),
  policyVersion: z.string().min(1).max(64),
});
export type SellerDirectEconomics = z.infer<typeof SellerDirectEconomics>;

/**
 * Seller-direct economics at an explicit instant.
 *
 * The **effective** commercial retail price is the basis: an active scheduled
 * sale price during its window, the ordinary retail price outside it. No Offer
 * and no promoter are involved, so the seller receives the whole acquisition
 * amount.
 *
 * `now` is supplied. Nothing here reads a clock.
 */
export function calculateSellerDirectEconomics(input: {
  placement: z.infer<typeof SellerDirectPlacement>;
  now: string;
  policy: MonacadoWholesaleAcquisitionPolicy;
}): SellerDirectEconomics {
  const effective = effectiveSellerRetailPrice({ placement: input.placement, now: input.now });
  const acquisition = calculateMorWholesaleAcquisition({
    commercialRetailPriceMinorUnits: effective.effectivePriceMinorUnits,
    currency: effective.currency,
    policy: input.policy,
  });
  return SellerDirectEconomics.parse({
    effectiveCommercialRetailPriceMinorUnits: effective.effectivePriceMinorUnits,
    saleActive: effective.saleActive,
    monacadoRetainedAmountMinorUnits: acquisition.monacadoRetainedAmountMinorUnits,
    morWholesaleAcquisitionAmountMinorUnits:
      acquisition.morWholesaleAcquisitionAmountMinorUnits,
    sellerProceedsMinorUnits: acquisition.morWholesaleAcquisitionAmountMinorUnits,
    currency: effective.currency,
    policyId: acquisition.policyId,
    policyVersion: acquisition.policyVersion,
  });
}

// — Promoted economics —

/**
 * The full economic reconciliation of one promoted sale.
 *
 * Three layers meet here, and each keeps its own name:
 *
 *   - **MoR layer.** Monacado retains `retained(R)` from the promoter's
 *     commercial retail price and acquires the item for
 *     `A = R − retained(R)`. `A` is the pool the supply side is paid from.
 *   - **Offer layer.** The seller contracted to be owed `offerWholesalePrice`
 *     (`W`), out of which they fund a promoter commission `C`. The Offer's own
 *     identity `C + creatorProceeds = W` is unchanged and is not recomputed here.
 *   - **Listing layer.** The promoter keeps the retail spread `A − W`, plus the
 *     seller-funded commission `C`.
 *
 * ```
 * monacadoRetained   = retained(R)
 * acquisition    A   = R − retained(R)
 * sellerProceeds     = W − C            (the Offer's creator gross proceeds)
 * promoterRetailSpread = A − W
 * promoterNetProceeds  = (A − W) + C
 * ```
 *
 * The identity `sellerProceeds + promoterNetProceeds + monacadoRetained = R`
 * holds exactly, and is asserted — a reconciliation that does not add up to what
 * the buyer paid is not a reconciliation.
 *
 * **Monacado's retention is deducted exactly once**, inside `A`. There is no
 * separate platform fee charged to the promoter; the earlier model that
 * subtracted one was double-counting under the MoR relationship.
 */
export const PromotedListingEconomics = z.strictObject({
  commercialRetailPriceMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  monacadoRetainedAmountMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  morWholesaleAcquisitionAmountMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),

  /** The Offer's contracted wholesale price. NOT the acquisition amount. */
  offerWholesalePriceMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  /** Seller-funded, computed by the Offer and carried here unchanged. */
  sellerFundedCommissionMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),

  /** `A − W`. May be zero; never negative once proceeds are non-negative. */
  promoterRetailSpreadMinorUnits: z.int().max(MAX_MINOR_UNIT_AMOUNT),
  /** `(A − W) + C`. The authoritative promoter figure. */
  promoterNetProceedsMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  /** Promoter net as a share of commercial retail. Presentational. */
  promoterMarginRateBasisPoints: z.int().min(0).max(10_000),

  /** `W − C` — the Offer's own creator gross proceeds, restated for the ledger. */
  sellerProceedsMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),

  currency: CurrencyCode,
  policyId: z.string().min(1).max(191),
  policyVersion: z.string().min(1).max(64),
});
export type PromotedListingEconomics = z.infer<typeof PromotedListingEconomics>;

/**
 * Compute the promoted reconciliation deterministically.
 *
 * The Offer's wholesale price and commission are **inputs, not recomputed**: the
 * Offer is authoritative for them, and a second commission algorithm here would
 * be a second answer to a question the seller already agreed.
 *
 * Integer minor units throughout; no floating-point money anywhere. Throws when
 * promoter net proceeds would be negative.
 */
export function calculatePromotedListingEconomics(input: {
  commercialRetailPriceMinorUnits: number;
  currency: string;
  /** From the accepted Offer source version. */
  offerWholesalePriceMinorUnits: number;
  offerWholesalePriceCurrency: string;
  /** From the accepted Offer's economics. Zero when not promotable. */
  sellerFundedCommissionMinorUnits: number;
  policy: MonacadoWholesaleAcquisitionPolicy;
}): PromotedListingEconomics {
  const policy = MonacadoWholesaleAcquisitionPolicy.parse(input.policy);

  if (input.offerWholesalePriceCurrency !== input.currency) {
    throw new ListingEconomicsError(
      "WHOLESALE_CURRENCY_MISMATCH",
      "the Offer wholesale currency does not match the commercial price currency",
    );
  }
  if (input.sellerFundedCommissionMinorUnits > input.offerWholesalePriceMinorUnits) {
    /* The Offer already refuses this; asserted because a violated invariant must
       fail loudly rather than produce impossible seller proceeds. */
    throw new ListingEconomicsError(
      "COMMISSION_EXCEEDS_OFFER_WHOLESALE",
      "the seller-funded commission exceeds the Offer wholesale price",
    );
  }

  const acquisition = calculateMorWholesaleAcquisition({
    commercialRetailPriceMinorUnits: input.commercialRetailPriceMinorUnits,
    currency: input.currency,
    policy,
  });

  const spread =
    acquisition.morWholesaleAcquisitionAmountMinorUnits - input.offerWholesalePriceMinorUnits;
  const promoterNet = spread + input.sellerFundedCommissionMinorUnits;
  if (promoterNet < 0) {
    throw new ListingEconomicsError(
      "NEGATIVE_PROMOTER_PROCEEDS",
      "the commercial retail price leaves the promoter with negative net proceeds",
    );
  }

  const sellerProceeds =
    input.offerWholesalePriceMinorUnits - input.sellerFundedCommissionMinorUnits;

  /* The whole point of the reconciliation: what the buyer paid is exactly what
     the three parties receive. */
  if (
    sellerProceeds + promoterNet + acquisition.monacadoRetainedAmountMinorUnits !==
    input.commercialRetailPriceMinorUnits
  ) {
    throw new ListingEconomicsError(
      "RECONCILIATION_IMBALANCE",
      "seller, promoter, and Monacado amounts do not sum to the commercial retail price",
    );
  }

  const rate =
    input.commercialRetailPriceMinorUnits === 0
      ? 0
      : Number(
          (BigInt(promoterNet) * 10_000n +
            BigInt(input.commercialRetailPriceMinorUnits) / 2n) /
            BigInt(input.commercialRetailPriceMinorUnits),
        );

  return PromotedListingEconomics.parse({
    commercialRetailPriceMinorUnits: input.commercialRetailPriceMinorUnits,
    monacadoRetainedAmountMinorUnits: acquisition.monacadoRetainedAmountMinorUnits,
    morWholesaleAcquisitionAmountMinorUnits:
      acquisition.morWholesaleAcquisitionAmountMinorUnits,
    offerWholesalePriceMinorUnits: input.offerWholesalePriceMinorUnits,
    sellerFundedCommissionMinorUnits: input.sellerFundedCommissionMinorUnits,
    promoterRetailSpreadMinorUnits: spread,
    promoterNetProceedsMinorUnits: promoterNet,
    promoterMarginRateBasisPoints: Math.min(Math.max(rate, 0), 10_000),
    sellerProceedsMinorUnits: sellerProceeds,
    currency: input.currency,
    policyId: policy.policyId,
    policyVersion: policy.policyVersion,
  });
}

/**
 * The lowest commercial retail price at which promoter net proceeds are not
 * negative, under the corrected MoR model.
 *
 * ```
 * promoterNet(R) = (R − retained(R)) − W + C  ≥ 0
 * ```
 *
 * Solved exactly by binary search, with no floating-point arithmetic at any step.
 * The rule survives the correction — it is still a Listing-layer invariant,
 * because it is the promoter's own price that determines it — but the threshold
 * moves: a seller-funded commission `C` lowers it, and Monacado's retention is
 * counted once rather than twice.
 *
 * **Why bisection is valid.** With `retained(R) = ⌊(R·bp + 5000)/10000⌋ + fixed`
 * and `0 ≤ bp ≤ 10000`, raising the price by one minor unit raises the retention
 * by zero or one, so `promoterNet(R)` is non-decreasing and the feasible prices
 * form a suffix.
 *
 * **Why the bound is sound.** `R₀ = ⌈(W − C + fixed) × 10000 / (10000 − bp)⌉` is
 * feasible: it is the answer ignoring rounding, and half-up rounding only reduces
 * the retention relative to the exact share, so `promoterNet(R₀) ≥ −0.5` and —
 * being an integer — therefore `≥ 0`.
 *
 * A closed form plus a small fixed window would be wrong here, and quietly so:
 * half-up rounding can move the true minimum below `R₀` by as much as
 * `5000 / (10000 − bp)` — a fraction of a unit at ordinary rates, thousands as
 * the rate approaches 100%. Bisection has no window to size.
 */
export function minimumViablePromotedRetailPrice(input: {
  offerWholesalePriceMinorUnits: number;
  sellerFundedCommissionMinorUnits: number;
  currency: string;
  policy: MonacadoWholesaleAcquisitionPolicy;
}): number {
  const policy = MonacadoWholesaleAcquisitionPolicy.parse(input.policy);
  if (policy.currency !== input.currency) {
    throw new ListingEconomicsError(
      "POLICY_CURRENCY_MISMATCH",
      "the wholesale-acquisition policy currency does not match the requested currency",
    );
  }
  if (input.sellerFundedCommissionMinorUnits > input.offerWholesalePriceMinorUnits) {
    throw new ListingEconomicsError(
      "COMMISSION_EXCEEDS_OFFER_WHOLESALE",
      "the seller-funded commission exceeds the Offer wholesale price",
    );
  }

  /** `W − C`: what the acquisition amount must still cover after the commission. */
  const netSupplyCost = BigInt(
    input.offerWholesalePriceMinorUnits - input.sellerFundedCommissionMinorUnits,
  );

  /** Exact promoter net at `retail`, in BigInt so no bound can overflow. */
  const promoterNetAt = (retail: bigint): bigint =>
    retail -
    ((retail * BigInt(policy.retainedPercentageBasisPoints) + 5_000n) / 10_000n) -
    BigInt(policy.retainedFixedAmountMinorUnits) -
    netSupplyCost;

  const denominator = 10_000n - BigInt(policy.retainedPercentageBasisPoints);
  if (denominator <= 0n) {
    throw new ListingEconomicsError(
      "NO_VIABLE_RETAIL_PRICE",
      "no commercial retail price yields non-negative promoter proceeds under this policy",
    );
  }

  // ⌈(W − C + fixed) × 10000 / (10000 − bp)⌉ — always feasible, so a valid bound.
  const numerator =
    (netSupplyCost + BigInt(policy.retainedFixedAmountMinorUnits)) * 10_000n;
  let hi = (numerator + denominator - 1n) / denominator;
  if (hi < 1n) hi = 1n;

  if (hi > BigInt(MAX_MINOR_UNIT_AMOUNT) || promoterNetAt(hi) < 0n) {
    throw new ListingEconomicsError(
      "NO_VIABLE_RETAIL_PRICE",
      "no commercial retail price yields non-negative promoter proceeds under this policy",
    );
  }

  let lo = 1n;
  while (lo < hi) {
    const mid = lo + (hi - lo) / 2n;
    if (promoterNetAt(mid) >= 0n) hi = mid;
    else lo = mid + 1n;
  }
  return Number(lo);
}
// — Listing placement (the discriminated core) —

/**
 * A seller-direct placement.
 *
 * Has **no field** for an Offer dependency: a seller selling their own Product
 * has no wholesale counterparty, and a dependency here would imply one.
 */
export const SellerDirectPlacement = z.strictObject({
  listingType: z.literal("SELLER_DIRECT"),
  retail: RetailPrice,
  /** Optional temporary sale. Absent when the seller is not running one. */
  sale: SellerSaleSchedule.nullable(),
});

/**
 * A promoted placement.
 *
 * Has **no field** for a scheduled sale. Seller sale scheduling is a seller
 * mechanism over their own price; a promoter's price is their own, and giving
 * them a "sale" field here would create a second place a promoted price could
 * move, invisible to the economics check.
 */
export const PromotedPlacement = z.strictObject({
  listingType: z.literal("PROMOTED"),
  retail: RetailPrice,
  offerDependency: AcceptedOfferDependency,
  upstreamReviewState: ListingUpstreamReviewState,
});

export const ListingPlacement = z
  .discriminatedUnion("listingType", [SellerDirectPlacement, PromotedPlacement])
  .superRefine((placement, ctx) => {
    if (placement.listingType !== "SELLER_DIRECT") return;
    const sale = placement.sale;
    if (sale === null) return;

    if (sale.salePriceCurrency !== placement.retail.retailPriceCurrency) {
      ctx.addIssue({
        code: "custom",
        path: ["sale", "salePriceCurrency"],
        message: "a sale price must be in the same currency as the ordinary retail price",
      });
    }
    if (sale.salePriceMinorUnits >= placement.retail.retailPriceMinorUnits) {
      ctx.addIssue({
        code: "custom",
        path: ["sale", "salePriceMinorUnits"],
        message: "a sale price must be strictly lower than the ordinary retail price",
      });
    }
    if (Date.parse(sale.saleStartsAt) >= Date.parse(sale.saleEndsAt)) {
      ctx.addIssue({
        code: "custom",
        path: ["sale", "saleEndsAt"],
        message: "saleEndsAt must be later than saleStartsAt",
      });
    }
  });
export type ListingPlacement = z.infer<typeof ListingPlacement>;

// — Effective seller price —

export const EffectiveSellerPrice = z.strictObject({
  effectivePriceMinorUnits: MinorUnitAmount,
  currency: CurrencyCode,
  saleActive: z.boolean(),
});
export type EffectiveSellerPrice = z.infer<typeof EffectiveSellerPrice>;

/**
 * Whether a scheduled sale is running at `now`.
 *
 * Half-open: `now ≥ start && now < end`. **The instant is supplied**, never read
 * from a clock here — a pricing function that consulted the runtime clock would
 * be untestable at its boundaries and non-deterministic in replay.
 */
export function isSaleActive(input: { sale: SellerSaleSchedule; now: string }): boolean {
  const now = Date.parse(input.now);
  return now >= Date.parse(input.sale.saleStartsAt) && now < Date.parse(input.sale.saleEndsAt);
}

/**
 * The price a buyer would be asked for at `now`.
 *
 * Derived, never stored. **The ordinary retail price is never mutated** when a
 * sale starts or ends: the sale is an overlay with its own window, so the price
 * to return to is still recorded when the window closes.
 */
export function effectiveSellerRetailPrice(input: {
  placement: z.infer<typeof SellerDirectPlacement>;
  now: string;
}): EffectiveSellerPrice {
  const { retail, sale } = input.placement;
  const active = sale !== null && isSaleActive({ sale, now: input.now });
  return {
    effectivePriceMinorUnits: active ? sale!.salePriceMinorUnits : retail.retailPriceMinorUnits,
    currency: retail.retailPriceCurrency,
    saleActive: active,
  };
}

// — The authoritative record and its immutable versions —

/**
 * The current authoritative truth about one Listing.
 *
 * There is **no field** for: a capsule or Node identity, publication state, a
 * participant's private profile, an account, an email address, a payment-provider
 * token, underwriting or risk data, payout credentials, moderation notes, a
 * stored effective price, a stored fee, or a stored proceeds figure.
 */
export const ListingSourceRecord = z.strictObject({
  // Identity
  listingSourceRecordId: ListingSourceRecordId,
  internalListingId: InternalListingId,
  /** The latest immutable source version; the pointer into version history. */
  currentSourceRecordVersion: ListingSourceRecordVersion,

  // Placement
  storefrontId: InternalStorefrontRef,
  internalProductId: InternalProductRef,
  /** The participant who controls this Listing — seller or promoter. */
  controllingParticipantId: MarketplaceParticipantId,

  // Source-system identity (the existing convention)
  sourceSystem: z.literal("monacado"),
  sourceRecordType: z.literal("Listing"),
  sourceClass: z.literal("governed-database-record"),

  // Business state
  lifecycle: ListingLifecycleState,
  placement: ListingPlacement,

  // Record control — explicit instants, never read from a clock here
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ListingSourceRecord = z.infer<typeof ListingSourceRecord>;

/**
 * One complete, immutable snapshot of a Listing's material business state.
 *
 * A snapshot, not a delta — the same reasoning the Offer and Storefront versions
 * record: a version that had to be replayed through its predecessors would make
 * reconstruction depend on an unbroken chain.
 */
export const ListingSourceVersion = z.strictObject({
  // Identity and lineage
  listingSourceRecordId: ListingSourceRecordId,
  sourceRecordVersion: ListingSourceRecordVersion,
  /** The version this one replaces; `null` for the first. */
  supersedesSourceRecordVersion: ListingSourceRecordVersion.nullable(),
  internalListingId: InternalListingId,

  // Source-system identity
  sourceSystem: z.literal("monacado"),
  sourceRecordType: z.literal("Listing"),
  sourceClass: z.literal("governed-database-record"),

  // The complete material snapshot
  storefrontId: InternalStorefrontRef,
  internalProductId: InternalProductRef,
  controllingParticipantId: MarketplaceParticipantId,
  lifecycle: ListingLifecycleState,
  placement: ListingPlacement,

  // Authorization trace
  authorizedByParticipantId: MarketplaceParticipantId,
  authorizedByActorId: AuthorizingActorId,
  recordedAt: z.iso.datetime(),
});
export type ListingSourceVersion = z.infer<typeof ListingSourceVersion>;

// — Material change classification —

/**
 * Changes that mint a new immutable source version.
 *
 * A sale beginning or ending is **not** here: the schedule was the change, and
 * the clock passing a boundary is not a business decision anyone made.
 */
export const MATERIAL_LISTING_FIELDS = [
  "lifecycle",
  "listingType",
  "retailPrice",
  "retailCurrency",
  "saleSchedule",
  "offerDependency",
  "upstreamReviewState",
  "storefrontId",
  "internalProductId",
  "controllingParticipantId",
] as const;
export const MaterialListingField = z.enum(MATERIAL_LISTING_FIELDS);
export type MaterialListingField = z.infer<typeof MaterialListingField>;

/**
 * Operational facts that change nothing semantic and mint no version.
 *
 * Publication retries, worker leases, receipts, caches, and monitoring counters
 * are not business changes — the same list the Offer and Storefront models name.
 */
export const OPERATIONAL_ONLY_LISTING_FIELDS = [
  "updatedAt",
  "viewCount",
  "impressionCount",
  "cacheWarmedAt",
  "searchIndexedAt",
  "publicationRetryCount",
  "workerLeaseExpiresAt",
] as const;

// — Upstream blocking —

/**
 * Why a Listing is not available to buyers.
 *
 * Bounded classifications, never free text, never a private value. A route may
 * safely show any of these to a caller.
 */
export const LISTING_BLOCKING_REASONS = [
  "LISTING_NOT_ACTIVE",
  "PRODUCT_UNAVAILABLE",
  "STOREFRONT_NOT_PUBLICLY_ACCESSIBLE",
  "CONTROLLING_PARTICIPANT_NOT_ACTIVE",
  "CONTROLLING_ROLE_NOT_ACTIVE",
  "OFFER_NOT_COMMERCIALLY_SELECTABLE",
  "OFFER_VERSION_REVIEW_REQUIRED",
  /**
   * The Seller no longer offers this commercially (Phase 1.15, Ruling 1).
   *
   * DISTINCT FROM `OFFER_NOT_COMMERCIALLY_SELECTABLE`, and the distinction is
   * the whole correction. That code answers "were the accepted TERMS sellable
   * when the promoter accepted them", read from the exact immutable version the
   * Listing binds. This one answers "does the Seller CURRENTLY authorise new
   * commerce under that Offer", read from the Offer's stable record.
   *
   * Two questions, two sources, and conflating them is what let a Seller end or
   * withdraw an Offer while dependent promoted Listings kept selling: the bound
   * version row is frozen and reads `ACTIVE`/`AVAILABLE` forever, exactly as an
   * immutable historical record should.
   *
   * Describes the OFFER, not the participant — so it is safe on a public
   * surface, on the same footing as the other Offer and Listing codes.
   */
  "OFFER_NOT_CURRENTLY_OFFERED",
] as const;
export const ListingBlockingReason = z.enum(LISTING_BLOCKING_REASONS);
export type ListingBlockingReason = z.infer<typeof ListingBlockingReason>;

/**
 * The blocking reasons that describe a PARTICIPANT rather than a Listing
 * (Phase 1.15).
 *
 * Both are bounded codes, and bounded is not the same as public. Because any
 * active restriction reconciles a participant to `RESTRICTED` and a suspension
 * to `SUSPENDED`, either of these returned on a public surface tells an
 * anonymous visitor — per listing, on demand — that this participant's
 * marketplace standing has been withheld. That makes a public failure path a
 * probe for a seller's account standing.
 *
 * The other five describe the *thing being sold* or the shop it sits in, which
 * a buyer is entitled to know about. `STOREFRONT_NOT_PUBLICLY_ACCESSIBLE` sits
 * on the safe side deliberately: it conflates lifecycle, visibility, and go-live
 * approval into one code, so it identifies no particular cause — the coarseness
 * is the protection.
 *
 * Operators read the specific reasons from the governed records, where they hold
 * the entitlement to.
 */
export const PARTICIPANT_STANDING_BLOCKING_REASONS = [
  "CONTROLLING_PARTICIPANT_NOT_ACTIVE",
  "CONTROLLING_ROLE_NOT_ACTIVE",
] as const satisfies readonly ListingBlockingReason[];

/**
 * The subset of blocking reasons safe to show a buyer.
 *
 * Order-preserving and total: every input code is either kept or dropped, and
 * nothing is rewritten into a different code. A caller that shows the result
 * discloses no participant standing.
 */
export function publicSafeBlockingReasons(
  reasons: readonly string[],
): readonly string[] {
  const withheld: readonly string[] = PARTICIPANT_STANDING_BLOCKING_REASONS;
  return reasons.filter((r) => !withheld.includes(r));
}

export interface ListingBuyerEligibility {
  buyerActive: boolean;
  /** Every reason, in the declared order — not just the first one found. */
  blockingReasons: ListingBlockingReason[];
}

/**
 * Whether a Listing may be sold to a buyer right now.
 *
 * **Derived, never stored.** A stored `isBuyerActive` would be a fourth thing to
 * keep in agreement with the Listing, the Storefront, the participant, and the
 * Offer — and the first to go stale when any of them moved.
 *
 * Every failing condition is reported rather than the first: a promoter fixing
 * one problem should not discover the next one only after saving.
 *
 * Upstream states are **supplied**, not fetched. This function reaches no
 * database, and the existing helpers decide their own domains —
 * `isPubliclyAccessible` for the Storefront, the Offer's own lifecycle and
 * availability for the Offer. Nothing here reinvents another entity's rules.
 */
export function evaluateListingBuyerEligibility(input: {
  lifecycle: ListingLifecycleState;
  listingType: ListingType;
  productAvailability: GeneralAvailabilityState;
  storefrontExposure: StorefrontExposure;
  controllingParticipantStatus: ParticipantStatus;
  controllingRoleStatus: RoleAssignmentStatus;
  /**
   * Promoted Listings only — the EXACT accepted Offer version.
   *
   * The historical, immutable terms the promoter accepted. Supplies what the
   * sale is priced on, and answers whether those terms were commercially
   * selectable. Never the Offer's current state.
   */
  offer?: {
    lifecycle: OfferLifecycleState;
    availability: OfferAvailability;
  };
  /**
   * Promoted Listings only — the Offer's CURRENT stable state (Phase 1.15,
   * Ruling 1).
   *
   * The Seller's standing authorization for new commerce under this Offer,
   * read from the stable `Offer` record rather than from any version row. A
   * Seller who ends or withdraws their Offer stops new dependent sales through
   * this input, without anything rewriting the accepted version the Listing
   * binds or the Listing version that binds it.
   *
   * OPTIONAL, and its absence is treated as a REFUSAL for a promoted Listing
   * rather than a pass — a promoted sale whose upstream Offer cannot be resolved
   * is not one Monacado can stand behind. Silence reads as "no", which is the
   * rule `goLiveApproval` already follows.
   */
  currentOffer?: {
    lifecycle: OfferLifecycleState;
    availability: OfferAvailability;
  };
  /** Promoted Listings only. */
  upstreamReviewState?: ListingUpstreamReviewState;
}): ListingBuyerEligibility {
  const reasons: ListingBlockingReason[] = [];

  if (input.lifecycle !== "ACTIVE") reasons.push("LISTING_NOT_ACTIVE");
  if (input.productAvailability !== "available") reasons.push("PRODUCT_UNAVAILABLE");
  if (!isPubliclyAccessible(input.storefrontExposure)) {
    reasons.push("STOREFRONT_NOT_PUBLICLY_ACCESSIBLE");
  }
  if (input.controllingParticipantStatus !== "ACTIVE") {
    reasons.push("CONTROLLING_PARTICIPANT_NOT_ACTIVE");
  }
  if (input.controllingRoleStatus !== "ACTIVE") reasons.push("CONTROLLING_ROLE_NOT_ACTIVE");

  if (input.listingType === "PROMOTED") {
    const offerSelectable =
      input.offer !== undefined &&
      input.offer.lifecycle === "ACTIVE" &&
      input.offer.availability === "AVAILABLE";
    if (!offerSelectable) reasons.push("OFFER_NOT_COMMERCIALLY_SELECTABLE");

    /* Phase 1.15, Ruling 1 — the accepted version supplies the TERMS; the stable
       Offer supplies CURRENT AUTHORIZATION for new commerce. Both must hold.

       Reported separately from the line above rather than folded into it: an
       operator reading "the accepted terms were not selectable" about a Seller
       who simply withdrew their Offer last week would look for a problem in the
       promoter's acceptance, which is the wrong place entirely. */
    const currentlyOffered =
      input.currentOffer !== undefined &&
      input.currentOffer.lifecycle === "ACTIVE" &&
      input.currentOffer.availability === "AVAILABLE";
    if (!currentlyOffered) reasons.push("OFFER_NOT_CURRENTLY_OFFERED");

    if (input.upstreamReviewState === "REVIEW_REQUIRED") {
      reasons.push("OFFER_VERSION_REVIEW_REQUIRED");
    }
  }

  return { buyerActive: reasons.length === 0, blockingReasons: reasons };
}

// — Seller-sale isolation —

/**
 * The facts a seller's temporary sale is **guaranteed not to touch**.
 *
 * Recorded executably rather than only in prose, so the guarantee is testable
 * and a future change that broke it would break a test rather than a promise.
 *
 * The guarantee is structural: a sale lives inside a `SELLER_DIRECT` placement,
 * and that placement has no field for an Offer, a wholesale price, a promoted
 * Listing, a promoter obligation, or a notification. There is nothing for it to
 * reach.
 */
export const SELLER_SALE_ISOLATED_FROM = [
  "wholesalePrice",
  "offerSourceRecordVersion",
  "offerCommissionTerms",
  "promotedListingRetailPrice",
  "promotedListingEconomics",
  "promoterAcknowledgement",
  "promoterReviewRequirement",
  "promoterNotificationObligation",
  "promoterMinimumViableRetailPrice",
] as const;

/**
 * A seller sale never forces a promoter review.
 *
 * Stated as a function so the rule is callable rather than merely documented: no
 * seller-side sale schedule is an Offer business change, because it is not a
 * change to the Offer at all.
 */
export function sellerSaleForcesPromoterReview(): false {
  return false;
}

// — Privacy —

/**
 * Field names that must never appear on a Listing source record.
 *
 * Every schema above is a `strictObject`, so an unknown key already fails. This
 * list makes the intent explicit and gives a test something to enumerate — the
 * same belt-and-braces pattern the participant model uses, and equally not the
 * primary control.
 *
 * Risk classifications are absent by design and stay **private operational
 * data**. They must never become public capsule facts (§ risk boundary).
 */
export const NEVER_ON_LISTING_SOURCE_RECORD = [
  "accountId",
  "email",
  "passwordHash",
  "sessionToken",
  "participantProfile",
  "legalName",
  "address",
  "taxId",
  "paymentProviderToken",
  "stripeAccountId",
  "payoutCredentials",
  "underwritingData",
  "riskScore",
  "riskClassification",
  "cardNetworkRiskData",
  "moderationNotes",
  "reserveAmount",
  "payoutHold",
] as const;

// — Deferred —

/** Named as deferred, and not admissible through a metadata bag. */
export const DEFERRED_LISTING_EXTENSIONS = [
  "capsuleProjection",
  "listingNode",
  "publicationState",
  "persistence",
  "checkout",
  "orderRecords",
  "payoutLogic",
  "notificationDelivery",
  "riskManagement",
  "wholesaleAcquisitionPolicyLookup",
  "wholesaleAcquisitionPolicyOverrides",
  "inventory",
  "variants",
  "shipping",
  "tax",
  "territory",
  "bundling",
  "subscriptions",
] as const;
