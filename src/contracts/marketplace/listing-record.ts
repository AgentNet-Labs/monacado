/**
 * Persisted Listing records (Phase 0M.7).
 *
 * The record shapes behind the 0M.4A source model. `listing-source.ts` says what
 * a Listing *is* and how its economics reconcile; this module says what a caller
 * supplies to create one or to mint a new immutable version of one.
 *
 * Five properties shape everything below:
 *
 *   1. **The database is the sole source of truth** (ADR §12). The capsule
 *      projection reads it one way and writes nothing back.
 *
 *   2. **This module adds no Listing fact.** Every persisted field maps
 *      one-to-one onto a `ListingSourceVersion` member, so a stored row
 *      round-trips exactly into the contract the projection already consumes.
 *
 *   3. **Derived values are never supplied and never stored.** There is no input
 *      for effective price, sale-active status, Monacado's retained amount, the
 *      MoR acquisition amount, seller proceeds, promoter spread, promoter net
 *      proceeds, or buyer-active eligibility. 0M.4A computes each from
 *      authoritative inputs plus a supplied instant and a supplied policy.
 *
 *   4. **The acquisition policy is supplied per call, never persisted.** A
 *      commercial decision that will change must not become a stored fact or a
 *      code constant — 0M.4A is explicit, and `0M.R` may later supply a
 *      different or risk-adjusted policy through this same input.
 *
 *   5. **The two branches stay structurally distinct.** A seller-direct input
 *      has no field for an Offer dependency; a promoted input has no field for a
 *      scheduled sale. Not "rejected by a rule" — nowhere to go.
 *
 * Pure data. No database, clock, environment read, randomness, or network. Not
 * exported through the browser-facing barrel.
 */

import { z } from "zod";
import { canonicalJsonString } from "../integrity/canonical-json";
import { MarketplaceParticipantId } from "./participant";
import { OfferSourceRecordVersion } from "./offer-source";
import {
  InternalListingId,
  InternalProductRef,
  InternalStorefrontRef,
  ListingLifecycleState,
  ListingSourceRecordVersion,
  MATERIAL_LISTING_FIELDS,
  MonacadoWholesaleAcquisitionPolicy,
  RetailPrice,
  SellerSaleSchedule,
  type ListingPlacement,
  type MaterialListingField,
} from "./listing-source";

/**
 * The account whose marketplace subject is evaluated for authority.
 *
 * An account id rather than a pre-built subject: the service materializes the
 * subject from persisted state using the existing 0M.5 machinery, so an
 * authorization decision is made against the database rather than against
 * whatever a caller asserted about themselves.
 */
const ActingAccountId = z.string().min(1).max(191);

// — Create —

/**
 * Create one draft SELLER_DIRECT Listing and its first immutable source version.
 *
 * The first version is always `DRAFT`: 0M.4A's lifecycle starts there, and a
 * Listing that were buyer-facing before anyone reviewed it would defeat the
 * point of a lifecycle. Going live is a separate, separately authorized act.
 *
 * `sale` is optional and all-or-none by shape — there is no way to supply a
 * start without a price. Its cross-field rules (same currency, strictly lower
 * than ordinary retail, start before end) are 0M.4A's own and are applied when
 * the placement is assembled.
 */
export const CreateSellerDirectListingInput = z.strictObject({
  storefrontId: InternalStorefrontRef,
  internalProductId: InternalProductRef,
  /** The seller that will control this Listing. */
  controllingParticipantId: MarketplaceParticipantId,

  /** The ordinary commercial retail price — merchandise alone. */
  retail: RetailPrice,
  /** An optional temporary sale. Absent when the seller is not running one. */
  sale: SellerSaleSchedule.nullable().optional(),

  actingAccountId: ActingAccountId,

  /** Explicit instants. Nothing here reads a clock. */
  now: z.iso.datetime(),
});
export type CreateSellerDirectListingInput = z.infer<typeof CreateSellerDirectListingInput>;

/**
 * Create one draft PROMOTED Listing bound to an exact accepted Offer version.
 *
 * The caller names the Offer source record and the **exact version label** they
 * accepted. The service reads that persisted version and derives the accepted
 * economics from it — the caller does not supply the wholesale price, because a
 * caller-supplied one could disagree with the Offer the promoter actually
 * accepted, which is precisely the divergence the exact-version binding exists
 * to prevent.
 *
 * `acquisitionPolicy` is supplied and **never stored**: it is the input 0M.4A's
 * viability check needs, and `0M.R` will later own choosing it.
 */
export const CreatePromotedListingInput = z.strictObject({
  storefrontId: InternalStorefrontRef,
  internalProductId: InternalProductRef,
  /** The promoter that will control this Listing. */
  controllingParticipantId: MarketplaceParticipantId,

  /** The promoter's own commercial retail price. */
  retail: RetailPrice,

  /** The Offer source record whose exact version is being accepted. */
  acceptedOfferSourceRecordId: z.string().min(1).max(191),
  /** The EXACT version accepted — never "current", never "latest". */
  acceptedOfferSourceRecordVersion: OfferSourceRecordVersion,

  /**
   * The versioned Monacado wholesale-acquisition policy in force for this
   * decision. Supplied, validated against, and never persisted.
   */
  acquisitionPolicy: MonacadoWholesaleAcquisitionPolicy,

  actingAccountId: ActingAccountId,
  now: z.iso.datetime(),
});
export type CreatePromotedListingInput = z.infer<typeof CreatePromotedListingInput>;

// — Update —

/**
 * A material update, minting a new immutable source version.
 *
 * Every business member is optional: a caller states only what changes, and the
 * service compares the result against the current version over 0M.4A's own
 * `MATERIAL_LISTING_FIELDS`. An update that changes nothing material mints no
 * version.
 *
 * `sourceRecordVersion` is supplied rather than generated, matching the Product,
 * Offer, and Storefront convention.
 *
 * Rebinding to a different Offer version is expressed by naming the new exact
 * version — which is the only way a promoted Listing's accepted terms ever move.
 * The binding never advances on its own.
 */
export const UpdateListingInput = z.strictObject({
  internalListingId: InternalListingId,
  /** The new immutable version's label. Must not already exist. */
  sourceRecordVersion: ListingSourceRecordVersion,

  lifecycle: ListingLifecycleState.optional(),
  retail: RetailPrice.optional(),

  /** SELLER_DIRECT only. `null` clears the sale; omitted leaves it unchanged. */
  sale: SellerSaleSchedule.nullable().optional(),

  /** PROMOTED only. Naming a new exact version rebinds the accepted terms. */
  acceptedOfferSourceRecordVersion: OfferSourceRecordVersion.optional(),

  /** Required when promoted economics must be re-validated. */
  acquisitionPolicy: MonacadoWholesaleAcquisitionPolicy.optional(),

  actingAccountId: ActingAccountId,
  now: z.iso.datetime(),
});
export type UpdateListingInput = z.infer<typeof UpdateListingInput>;

// — Material change —

/**
 * Which of 0M.4A's material fields actually differ between two Listing states.
 *
 * **This is not a second classification.** 0M.4A declares the vocabulary in
 * `MATERIAL_LISTING_FIELDS` but ships no comparator, so persistence needs one to
 * answer "did anything material change?" — and it is driven by that constant
 * rather than by a hand-written list, so the two cannot drift. A field added to
 * the contract's vocabulary and not handled here fails the exhaustiveness test.
 *
 * Compared by canonical serialization, so key order in a nested object never
 * registers as a change.
 */
export function materialListingChangesBetween(
  prior: Pick<
    z.infer<typeof ListingComparableState>,
    keyof z.infer<typeof ListingComparableState>
  >,
  next: typeof prior,
): MaterialListingField[] {
  const differs = (a: unknown, b: unknown) => canonicalJsonString(a) !== canonicalJsonString(b);
  const changed: MaterialListingField[] = [];

  const priorPlacement = prior.placement;
  const nextPlacement = next.placement;

  for (const field of MATERIAL_LISTING_FIELDS) {
    switch (field) {
      case "lifecycle":
        if (prior.lifecycle !== next.lifecycle) changed.push(field);
        break;
      case "listingType":
        if (priorPlacement.listingType !== nextPlacement.listingType) changed.push(field);
        break;
      case "retailPrice":
        if (
          priorPlacement.retail.retailPriceMinorUnits !==
          nextPlacement.retail.retailPriceMinorUnits
        ) {
          changed.push(field);
        }
        break;
      case "retailCurrency":
        if (
          priorPlacement.retail.retailPriceCurrency !== nextPlacement.retail.retailPriceCurrency
        ) {
          changed.push(field);
        }
        break;
      case "saleSchedule": {
        /* Only a seller-direct placement has one. A branch change is reported as
           `listingType` rather than as a phantom sale change. */
        const a = priorPlacement.listingType === "SELLER_DIRECT" ? priorPlacement.sale : null;
        const b = nextPlacement.listingType === "SELLER_DIRECT" ? nextPlacement.sale : null;
        if (
          priorPlacement.listingType === nextPlacement.listingType &&
          differs(a, b)
        ) {
          changed.push(field);
        }
        break;
      }
      case "offerDependency": {
        const a =
          priorPlacement.listingType === "PROMOTED" ? priorPlacement.offerDependency : null;
        const b = nextPlacement.listingType === "PROMOTED" ? nextPlacement.offerDependency : null;
        if (priorPlacement.listingType === nextPlacement.listingType && differs(a, b)) {
          changed.push(field);
        }
        break;
      }
      case "upstreamReviewState": {
        const a =
          priorPlacement.listingType === "PROMOTED" ? priorPlacement.upstreamReviewState : null;
        const b =
          nextPlacement.listingType === "PROMOTED" ? nextPlacement.upstreamReviewState : null;
        if (priorPlacement.listingType === nextPlacement.listingType && a !== b) {
          changed.push(field);
        }
        break;
      }
      case "storefrontId":
        if (prior.storefrontId !== next.storefrontId) changed.push(field);
        break;
      case "internalProductId":
        if (prior.internalProductId !== next.internalProductId) changed.push(field);
        break;
      case "controllingParticipantId":
        if (prior.controllingParticipantId !== next.controllingParticipantId) changed.push(field);
        break;
      default: {
        /* Exhaustiveness: a new member of MATERIAL_LISTING_FIELDS must be
           handled deliberately rather than silently ignored. */
        const _never: never = field;
        void _never;
      }
    }
  }
  return changed;
}

/** The state `materialListingChangesBetween` compares. Structural only. */
const ListingComparableState = z.strictObject({
  storefrontId: InternalStorefrontRef,
  internalProductId: InternalProductRef,
  controllingParticipantId: MarketplaceParticipantId,
  lifecycle: ListingLifecycleState,
  placement: z.custom<ListingPlacement>(),
});

// — Privacy —

/**
 * Field names that must never appear on a persisted Listing record.
 *
 * Every schema above is a `strictObject`, so an unknown key already fails. This
 * list makes the intent explicit and gives a test something to enumerate.
 *
 * The derived-economics entries are here for a different reason from the
 * private ones: they are not secrets, they are **computed values**. 0M.4A
 * computes each from the commercial retail price, the accepted Offer version,
 * and a supplied policy. Storing one would create a second answer that goes
 * stale the moment any input moves — and a stored effective price would make a
 * sale's start or end require a database write.
 */
export const NEVER_ON_LISTING_RECORD = [
  // Derived pricing — computed from source plus a supplied instant
  "currentPrice",
  "effectivePrice",
  "effectivePriceMinorUnits",
  "pricedAt",
  "saleIsActive",
  "saleActive",
  "isBuyerActive",
  "buyerActive",
  // Derived economics — computed from source plus a supplied policy
  "monacadoRetainedAmount",
  "monacadoRetainedAmountMinorUnits",
  "morWholesaleAcquisitionAmount",
  "morWholesaleAcquisitionAmountMinorUnits",
  "sellerProceeds",
  "sellerProceedsMinorUnits",
  "promoterRetailSpread",
  "promoterRetailSpreadMinorUnits",
  "promoterNetProceeds",
  "promoterNetProceedsMinorUnits",
  "promoterMarginRateBasisPoints",
  "minimumViableRetailPrice",
  "calculatedCommission",
  "sellerFundedCommissionMinorUnits",
  "acquisitionPolicyId",
  "acquisitionPolicyVersion",
  // Tax and shipping — outside every basis 0M.4A defines
  "taxAmount",
  "checkoutTax",
  "vatAmount",
  "gstAmount",
  "shippingAmount",
  "freightAmount",
  "deliveryFee",
  "checkoutTotal",
  // Credentials and private identity
  "accountId",
  "email",
  "passwordHash",
  "sessionToken",
  "participantProfile",
  "legalName",
  "address",
  "taxId",
  // Payment, risk, underwriting
  "paymentProviderToken",
  "stripeAccountId",
  "payoutCredentials",
  "underwritingData",
  "riskScore",
  "riskClassification",
  "cardNetworkRiskData",
  "reserveAmount",
  "payoutHold",
  // Buyer and order
  "buyerId",
  "orderData",
  "purchaseEvidence",
  // Capsule / publication machinery (ADR §12.2)
  "capsuleId",
  "nodeId",
  "listingNode",
  "bindsToNode",
  "mappingVersion",
  "publicationState",
  "contentHash",
] as const;

/** Named as deferred, and not admissible through a metadata bag. */
export const DEFERRED_LISTING_PERSISTENCE_EXTENSIONS = [
  "listingNode",
  "nodeIssuance",
  "publicationState",
  "outbox",
  "receipt",
  "checkout",
  "orderRecords",
  "settlementLedger",
  "payoutLogic",
  "paymentOnboarding",
  "riskPolicyLookup",
  "acquisitionPolicyLookup",
  "taxCalculation",
  "shippingExecution",
  "fulfillment",
  "inventoryCustody",
  "notificationDelivery",
] as const;
