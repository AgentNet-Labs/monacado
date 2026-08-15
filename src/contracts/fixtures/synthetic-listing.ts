/**
 * Synthetic Listing projection fixture (Phase 0M.4B).
 *
 * Offline test/demo data for the Listing capsule projection. Every identifier is
 * obviously synthetic, and no real participant, product, or storefront appears.
 *
 * Mirrors `synthetic-storefront`: fixtures live beside the contracts so
 * `contracts:validate` can exercise a real projection without a database.
 */

import type { ListingSourceVersion } from "../marketplace/listing-source";
import type { ListingProjectionContext } from "../marketplace/listing.projection";
import {
  LISTING_PROJECTION_MAPPING_VERSION,
  SUPPORTED_LISTING_CAPSULE_VERSION,
} from "../marketplace/listing.projection";

/**
 * Build a valid 26-character Crockford opaque body from a readable seed.
 *
 * Crockford base32 excludes I, L, O, and U, so they are folded to `0` rather
 * than left to fail a regex at test time.
 */
const body = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const SREC = body("0M4BSREC");
const LISTING = body("0M4BLSTNG");
const PRODUCT = body("0M4BPRDCT");
const STOREFRONT = body("0M4BSTFRNT");
const PARTICIPANT = body("0M4BPART");
const ACTOR = body("0M4BACTOR");
const OFFER = body("0M4BOFFER");
const OFFER_SREC = body("0M4BOFFERSREC");

const LISTING_NODE = body("0M4BNODELSTNG");
const PRODUCT_NODE = body("0M4BNODEPRDCT");
const STOREFRONT_NODE = body("0M4BNODESTFRNT");
const AUTHORITY_NODE = body("0M4BNODEAUTH");
const CAPSULE = body("0M4BCAPSULELSTNG");

/** A seller-direct Listing running a temporary sale. */
export function syntheticListingSourceVersion(): ListingSourceVersion {
  return {
    listingSourceRecordId: `mon:srec:${SREC}`,
    sourceRecordVersion: "1",
    supersedesSourceRecordVersion: null,
    internalListingId: `mon:listing:${LISTING}`,
    sourceSystem: "monacado",
    sourceRecordType: "Listing",
    sourceClass: "governed-database-record",
    storefrontId: `mon:storefront:${STOREFRONT}`,
    internalProductId: `mon:product:${PRODUCT}`,
    controllingParticipantId: `mon:mpart:${PARTICIPANT}`,
    lifecycle: "ACTIVE",
    placement: {
      listingType: "SELLER_DIRECT",
      retail: { retailPriceMinorUnits: 10_000, retailPriceCurrency: "USD" },
      sale: {
        salePriceMinorUnits: 8_000,
        salePriceCurrency: "USD",
        saleStartsAt: "2026-03-01T00:00:00.000Z",
        saleEndsAt: "2026-03-08T00:00:00.000Z",
      },
    },
    authorizedByParticipantId: `mon:mpart:${PARTICIPANT}`,
    authorizedByActorId: `mon:actor:${ACTOR}`,
    recordedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** A promoted Listing bound to an accepted Offer source version. */
export function syntheticPromotedListingSourceVersion(): ListingSourceVersion {
  return {
    ...syntheticListingSourceVersion(),
    placement: {
      listingType: "PROMOTED",
      retail: { retailPriceMinorUnits: 12_500, retailPriceCurrency: "USD" },
      offerDependency: {
        internalOfferId: `mon:offer:${OFFER}`,
        offerSourceRecordId: `mon:srec:${OFFER_SREC}`,
        acceptedOfferSourceRecordVersion: "3",
        acceptedWholesalePriceMinorUnits: 5_000,
        acceptedWholesalePriceCurrency: "USD",
        acceptedCommissionCalculationPolicyVersion: "WHOLESALE_COMMISSION_V1",
        acceptedAt: "2026-02-01T00:00:00.000Z",
      },
      upstreamReviewState: "ACCEPTED_CURRENT_VERSION",
    },
  };
}

/** Everything upstream healthy, so the Listing is purchasable. */
export function syntheticListingProjectionContext(): ListingProjectionContext {
  return {
    listingBinding: {
      listingNode: `an:node:${LISTING_NODE}`,
      internalListingId: `mon:listing:${LISTING}`,
    },
    productBinding: {
      productNode: `an:node:${PRODUCT_NODE}`,
      internalProductId: `mon:product:${PRODUCT}`,
    },
    storefrontBinding: {
      storefrontNode: `an:node:${STOREFRONT_NODE}`,
      storefrontId: `mon:storefront:${STOREFRONT}`,
    },
    controllerBinding: {
      controllerAuthorityNode: `an:node:${AUTHORITY_NODE}`,
      controllingParticipantId: `mon:mpart:${PARTICIPANT}`,
    },
    sourceVersionBinding: {
      listingSourceRecordId: `mon:srec:${SREC}`,
      sourceRecordVersion: "1",
    },
    upstream: {
      productAvailability: "available",
      storefrontLifecycle: "ACTIVE",
      storefrontVisibility: "PUBLIC",
      storefrontGoLiveApproval: "APPROVED",
      controllingParticipantStatus: "ACTIVE",
      controllingRoleStatus: "ACTIVE",
      offerLifecycle: "ACTIVE",
      offerAvailability: "AVAILABLE",
    },
    capsuleId: `an:capsule:${CAPSULE}`,
    capsuleVersion: SUPPORTED_LISTING_CAPSULE_VERSION,
    mappingVersion: LISTING_PROJECTION_MAPPING_VERSION,
    generatedAt: "2026-02-01T06:30:00.000Z",
    nodePolicy: { ref: "mon:policy:node/listing/v1", version: "1.0.0" },
    capsulePolicy: { ref: "mon:policy:capsule/listing/v1", version: "1.0.0" },
  };
}
