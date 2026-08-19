/**
 * Prisma ⇄ domain mapping for Listings (Phase 0M.7).
 *
 * **This module closes the last missing pipeline stage.** Until now the Listing
 * capsule projection could only ever be handed a synthetic fixture, because
 * nothing could persist or retrieve a `ListingSourceVersion`. The declared
 * pipeline —
 *
 *   AUTHORITATIVE_SOURCE_MODEL → AUTHORITATIVE_SOURCE_VERSION
 *     → PROJECTION_MAPPING → CAPSULE_PROJECTION_SHAPE → CAPSULE_PROJECTION
 *
 * — now has its second stage for every publishable entity.
 * `versionRowToSourceVersion` round-trips a persisted row **exactly** into the
 * canonical contract shape `listingSourceRecordToCapsuleProjection` consumes.
 *
 * Three mappings carry the weight, and each is where a lesser adapter would lose
 * information or fabricate it:
 *
 *   1. **The discriminated union is rebuilt FROM the discriminator.** A
 *      `SELLER_DIRECT` row produces a placement with no `offerDependency` field
 *      at all, and a `PROMOTED` row produces one with no `sale` field. 0M.4A
 *      makes the two structurally impossible to confuse; a mapper that merged
 *      the columns would undo exactly that.
 *
 *   2. **The sale arm is all-or-none.** Four columns, all present or all NULL. A
 *      partially populated arm is corruption — not a sale with defaults — and is
 *      refused rather than repaired, because a repaired sale would misprice.
 *
 *   3. **The Offer binding is all-or-none too**, and names an exact version. A
 *      promoted row missing any part of it cannot describe what the promoter
 *      accepted, so it fails loudly instead of degrading to "the current Offer".
 *
 * Money is `BIGINT` in MySQL and `number` in the contract, exact only up to
 * `Number.MAX_SAFE_INTEGER`; anything outside is refused rather than silently
 * losing precision. Malformed rows surface as a structured
 * `CorruptListingRecordError`. Raw Prisma rows never escape this adapter.
 */

import type {
  Listing as ListingRow,
  ListingSourceRecordVersionRow as VersionRow,
} from "@prisma/client";
import { MAX_MINOR_UNIT_AMOUNT } from "../../contracts/marketplace/offer-source";
import {
  ListingSourceRecord,
  ListingSourceVersion,
  type ListingPlacement,
  type ListingSourceRecord as SourceRecord,
  type ListingSourceVersion as SourceVersion,
} from "../../contracts/marketplace/listing-source";
import { CorruptListingRecordError } from "./listing-errors";

const iso = (d: Date): string => d.toISOString();

const issuePaths = (error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string[] => Array.from(new Set(error.issues.map((i) => i.path.join(".") || "(root)")));

/**
 * A `BIGINT` minor-unit column as an exact `number`.
 *
 * Refuses anything outside the safe integer range instead of rounding. `field`
 * names the path for the corruption error; the value itself is never echoed.
 */
function minorUnits(value: bigint, field: string): number {
  if (value > BigInt(MAX_MINOR_UNIT_AMOUNT) || value < BigInt(-MAX_MINOR_UNIT_AMOUNT)) {
    throw new CorruptListingRecordError([field]);
  }
  return Number(value);
}

/**
 * Rebuild the optional scheduled sale from its four columns.
 *
 * All four present, or all four NULL. A partial arm is refused: the contract
 * holds the sale as one nested object precisely so "all present or all absent"
 * is the shape rather than a rule anyone can forget, and a row that violated it
 * describes a sale nobody could have configured.
 */
function saleFromRow(row: VersionRow): unknown {
  const parts = [
    row.salePriceMinorUnits,
    row.salePriceCurrency,
    row.saleStartsAt,
    row.saleEndsAt,
  ];
  const present = parts.filter((p) => p !== null).length;
  if (present === 0) return null;
  if (present !== parts.length) {
    throw new CorruptListingRecordError(["placement.sale"]);
  }
  return {
    salePriceMinorUnits: minorUnits(
      row.salePriceMinorUnits!,
      "placement.sale.salePriceMinorUnits",
    ),
    salePriceCurrency: row.salePriceCurrency,
    saleStartsAt: iso(row.saleStartsAt!),
    saleEndsAt: iso(row.saleEndsAt!),
  };
}

/**
 * Rebuild the accepted Offer dependency from its columns.
 *
 * Every part is required together. A promoted Listing whose binding is partial
 * cannot say which exact version the promoter accepted, and there is no safe
 * fallback — reading "the current Offer" would bind terms nobody agreed to.
 */
function offerDependencyFromRow(row: VersionRow): unknown {
  const parts = [
    row.acceptedInternalOfferId,
    row.acceptedOfferSourceRecordId,
    row.acceptedOfferSourceRecordVersion,
    row.acceptedWholesalePriceMinorUnits,
    row.acceptedWholesalePriceCurrency,
    row.acceptedCommissionCalculationPolicyVersion,
    row.acceptedAt,
  ];
  if (parts.some((p) => p === null)) {
    throw new CorruptListingRecordError(["placement.offerDependency"]);
  }
  return {
    internalOfferId: row.acceptedInternalOfferId,
    offerSourceRecordId: row.acceptedOfferSourceRecordId,
    acceptedOfferSourceRecordVersion: row.acceptedOfferSourceRecordVersion,
    acceptedWholesalePriceMinorUnits: minorUnits(
      row.acceptedWholesalePriceMinorUnits!,
      "placement.offerDependency.acceptedWholesalePriceMinorUnits",
    ),
    acceptedWholesalePriceCurrency: row.acceptedWholesalePriceCurrency,
    acceptedCommissionCalculationPolicyVersion:
      row.acceptedCommissionCalculationPolicyVersion,
    acceptedAt: iso(row.acceptedAt!),
  };
}

/**
 * Rebuild the placement, driven entirely by the `listingType` discriminator.
 *
 * An unrecognised discriminator falls through to the contract, which refuses it
 * rather than guessing a branch.
 */
function placementFromRow(row: VersionRow): unknown {
  const retail = {
    retailPriceMinorUnits: minorUnits(
      row.retailPriceMinorUnits,
      "placement.retail.retailPriceMinorUnits",
    ),
    retailPriceCurrency: row.retailPriceCurrency,
  };

  if (row.listingType === "SELLER_DIRECT") {
    return { listingType: "SELLER_DIRECT", retail, sale: saleFromRow(row) };
  }
  if (row.listingType === "PROMOTED") {
    return {
      listingType: "PROMOTED",
      retail,
      offerDependency: offerDependencyFromRow(row),
      upstreamReviewState: row.upstreamReviewState,
    };
  }
  return { listingType: row.listingType, retail };
}

/**
 * Reconstruct one immutable source version from its persisted row.
 *
 * The mapping is total and lossless in both directions: every contract member
 * has exactly one column or flattened group, and every column has exactly one
 * member. No derived value is reconstructed, because none is stored.
 */
export function versionRowToSourceVersion(row: VersionRow): SourceVersion {
  const parsed = ListingSourceVersion.safeParse({
    listingSourceRecordId: row.listingSourceRecordId,
    sourceRecordVersion: row.sourceRecordVersion,
    supersedesSourceRecordVersion: row.supersedesSourceRecordVersion,
    internalListingId: row.internalListingId,

    sourceSystem: row.sourceSystem,
    sourceRecordType: row.sourceRecordType,
    sourceClass: row.sourceClass,

    storefrontId: row.storefrontId,
    internalProductId: row.internalProductId,
    controllingParticipantId: row.controllingParticipantId,
    lifecycle: row.lifecycle,
    placement: placementFromRow(row),

    authorizedByParticipantId: row.authorizedByParticipantId,
    authorizedByActorId: row.authorizedByActorId,
    recordedAt: iso(row.recordedAt),
  });
  if (!parsed.success) throw new CorruptListingRecordError(issuePaths(parsed.error));
  return parsed.data;
}

/**
 * Reconstruct the stable record from its row and its current version.
 *
 * `placement` comes from the **current version**, not from the pointer row: the
 * version is authoritative for material facts, and duplicating the placement
 * onto the stable row would create a second answer that could drift.
 */
export function listingRowToSourceRecord(
  row: ListingRow,
  currentVersion: VersionRow,
): SourceRecord {
  const current = versionRowToSourceVersion(currentVersion);
  const parsed = ListingSourceRecord.safeParse({
    listingSourceRecordId: row.listingSourceRecordId,
    internalListingId: row.internalListingId,
    currentSourceRecordVersion: row.currentSourceRecordVersion,

    storefrontId: row.storefrontId,
    internalProductId: row.internalProductId,
    controllingParticipantId: row.controllingParticipantId,

    sourceSystem: currentVersion.sourceSystem,
    sourceRecordType: currentVersion.sourceRecordType,
    sourceClass: currentVersion.sourceClass,

    lifecycle: row.lifecycle,
    placement: current.placement,

    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) throw new CorruptListingRecordError(issuePaths(parsed.error));
  return parsed.data;
}

/**
 * Flatten a validated placement into its persisted columns.
 *
 * The exact inverse of `placementFromRow`. A branch's columns are written as
 * explicit `null` when that branch does not apply, so a version that changed
 * branch carries no residue from the one it superseded.
 */
export function placementToColumns(placement: ListingPlacement): {
  listingType: string;
  retailPriceMinorUnits: bigint;
  retailPriceCurrency: string;
  salePriceMinorUnits: bigint | null;
  salePriceCurrency: string | null;
  saleStartsAt: Date | null;
  saleEndsAt: Date | null;
  acceptedInternalOfferId: string | null;
  acceptedOfferSourceRecordId: string | null;
  acceptedOfferSourceRecordVersion: string | null;
  acceptedWholesalePriceMinorUnits: bigint | null;
  acceptedWholesalePriceCurrency: string | null;
  acceptedCommissionCalculationPolicyVersion: string | null;
  acceptedAt: Date | null;
  upstreamReviewState: string | null;
} {
  const sale = placement.listingType === "SELLER_DIRECT" ? placement.sale : null;
  const dep = placement.listingType === "PROMOTED" ? placement.offerDependency : null;

  return {
    listingType: placement.listingType,
    retailPriceMinorUnits: BigInt(placement.retail.retailPriceMinorUnits),
    retailPriceCurrency: placement.retail.retailPriceCurrency,

    salePriceMinorUnits: sale === null ? null : BigInt(sale.salePriceMinorUnits),
    salePriceCurrency: sale?.salePriceCurrency ?? null,
    saleStartsAt: sale === null ? null : new Date(sale.saleStartsAt),
    saleEndsAt: sale === null ? null : new Date(sale.saleEndsAt),

    acceptedInternalOfferId: dep?.internalOfferId ?? null,
    acceptedOfferSourceRecordId: dep?.offerSourceRecordId ?? null,
    acceptedOfferSourceRecordVersion: dep?.acceptedOfferSourceRecordVersion ?? null,
    acceptedWholesalePriceMinorUnits:
      dep === null ? null : BigInt(dep.acceptedWholesalePriceMinorUnits),
    acceptedWholesalePriceCurrency: dep?.acceptedWholesalePriceCurrency ?? null,
    acceptedCommissionCalculationPolicyVersion:
      dep?.acceptedCommissionCalculationPolicyVersion ?? null,
    acceptedAt: dep === null ? null : new Date(dep.acceptedAt),
    upstreamReviewState:
      placement.listingType === "PROMOTED" ? placement.upstreamReviewState : null,
  };
}
