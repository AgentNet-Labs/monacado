/**
 * Prisma ⇄ domain mapping for Offers (Phase 0M.6).
 *
 * **This module is the reason the phase exists.** Until now the Offer capsule
 * projection could only ever be handed a synthetic fixture, because nothing
 * could persist or retrieve an `OfferSourceVersion`. The declared pipeline —
 *
 *   AUTHORITATIVE_SOURCE_MODEL → AUTHORITATIVE_SOURCE_VERSION
 *     → PROJECTION_MAPPING → CAPSULE_PROJECTION_SHAPE → CAPSULE_PROJECTION
 *
 * — was missing its second stage. `versionRowToSourceVersion` supplies it: a
 * persisted row round-trips **exactly** into the canonical contract shape that
 * `projectOfferCapsule` already consumes, with no field added, dropped, or
 * reinterpreted.
 *
 * Every row read is reconstructed through the contract's own schema, so a
 * malformed row surfaces as a structured `CorruptOfferRecordError` rather than a
 * best-effort object. Raw Prisma rows never escape this adapter.
 *
 * Three mappings need care, and each is a place a lesser adapter would lose
 * information:
 *
 *   1. **Discriminated unions.** `price` and `promotion` are flattened to a
 *      discriminator column plus nullable arms. The union is rebuilt FROM the
 *      discriminator, so a stray arm value can never be read under the wrong
 *      arm — a FREE Offer produces an object with no amount field at all, which
 *      is the absence-by-construction the contract requires.
 *
 *   2. **Money.** Minor units are `BIGINT` in MySQL and `number` in the
 *      contract, which is exact only up to `Number.MAX_SAFE_INTEGER`. A value
 *      outside that range is refused as corruption rather than silently losing
 *      precision, because a rounding error in money is the bug that surfaces as
 *      a settlement complaint months later.
 *
 *   3. **The effective interval.** Two nullable columns, and both-NULL means
 *      "no interval" — unambiguous because the contract refuses an interval
 *      whose bounds are both null. One fact, one representation, so a read can
 *      never mint a spurious material change.
 */

import type {
  Offer as OfferRow,
  OfferSourceRecordVersionRow as VersionRow,
} from "@prisma/client";
import {
  MAX_MINOR_UNIT_AMOUNT,
  OfferSourceRecord,
  OfferSourceVersion,
  type OfferCommercialTerms,
  type OfferEffectiveIntervalField,
  type OfferSourceRecord as SourceRecord,
  type OfferSourceVersion as SourceVersion,
} from "../../contracts/marketplace/offer-source";
import { CorruptOfferRecordError } from "./offer-errors";

const iso = (d: Date): string => d.toISOString();
const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

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
    throw new CorruptOfferRecordError([field]);
  }
  return Number(value);
}

function minorUnitsOrNull(value: bigint | null, field: string): number | null {
  return value === null ? null : minorUnits(value, field);
}

/**
 * Rebuild `terms` from the flattened columns.
 *
 * Driven entirely by the two discriminator columns. An arm's columns are read
 * only when its discriminator selects it, so a FREE row carrying a stray
 * currency cannot produce a PAID price, and a NOT_PROMOTABLE row carrying a
 * stray commission method cannot produce a commission. Anything the
 * discriminators do not recognise falls through to the contract, which refuses
 * it as corruption rather than guessing an arm.
 */
function termsFromRow(row: VersionRow): unknown {
  const price =
    row.priceType === "PAID"
      ? {
          type: "PAID",
          wholesalePriceMinorUnits: minorUnitsOrNull(
            row.wholesalePriceMinorUnits,
            "terms.price.wholesalePriceMinorUnits",
          ),
          wholesalePriceCurrency: row.wholesalePriceCurrency,
        }
      : { type: row.priceType };

  let promotion: unknown;
  if (row.promotionType === "PROMOTABLE") {
    const commission =
      row.commissionMethod === "PERCENT_OF_WHOLESALE"
        ? {
            method: "PERCENT_OF_WHOLESALE",
            commissionBasisPoints: row.commissionBasisPoints,
          }
        : {
            method: row.commissionMethod,
            fixedCommissionMinorUnits: minorUnitsOrNull(
              row.fixedCommissionMinorUnits,
              "terms.promotion.commission.fixedCommissionMinorUnits",
            ),
            fixedCommissionCurrency: row.fixedCommissionCurrency,
          };
    promotion = { type: "PROMOTABLE", commission };
  } else {
    promotion = { type: row.promotionType };
  }

  return { price, promotion };
}

/**
 * Rebuild the effective interval from its two nullable columns.
 *
 * Both NULL is the canonical "no interval". Any other combination is an interval
 * with at least one bound, which is exactly what the contract accepts.
 */
function effectiveIntervalFromRow(row: VersionRow): OfferEffectiveIntervalField {
  if (row.effectiveStartsAt === null && row.effectiveEndsAt === null) return null;
  return {
    startsAt: isoOrNull(row.effectiveStartsAt),
    endsAt: isoOrNull(row.effectiveEndsAt),
  } as OfferEffectiveIntervalField;
}

/**
 * Reconstruct one immutable source version from its persisted row.
 *
 * The mapping is total and lossless in both directions: every contract member
 * has exactly one column (or one flattened group), and every column has exactly
 * one member.
 *
 * `economics` is read from storage rather than recomputed. The contract's own
 * refinement then re-checks it against the deterministic calculator, so a row
 * whose amounts drifted from its terms fails loudly here rather than projecting
 * a number the creator never accepted.
 */
export function versionRowToSourceVersion(row: VersionRow): SourceVersion {
  const parsed = OfferSourceVersion.safeParse({
    offerSourceRecordId: row.offerSourceRecordId,
    sourceRecordVersion: row.sourceRecordVersion,
    supersedesSourceRecordVersion: row.supersedesSourceRecordVersion,
    internalOfferId: row.internalOfferId,

    sourceSystem: row.sourceSystem,
    sourceRecordType: row.sourceRecordType,
    sourceClass: row.sourceClass,

    internalProductId: row.internalProductId,
    sellerParticipantId: row.sellerParticipantId,
    lifecycle: row.lifecycle,
    availability: row.availability,
    terms: termsFromRow(row),
    effectiveInterval: effectiveIntervalFromRow(row),

    economics: {
      calculatedCommissionMinorUnits: minorUnits(
        row.calculatedCommissionMinorUnits,
        "economics.calculatedCommissionMinorUnits",
      ),
      calculatedCreatorGrossProceedsMinorUnits: minorUnits(
        row.calculatedCreatorGrossProceedsMinorUnits,
        "economics.calculatedCreatorGrossProceedsMinorUnits",
      ),
      commissionCalculationPolicyVersion: row.commissionCalculationPolicyVersion,
    },

    authorizedBySellerParticipantId: row.authorizedBySellerParticipantId,
    authorizedByActorId: row.authorizedByActorId,
    recordedAt: iso(row.recordedAt),
  });
  if (!parsed.success) throw new CorruptOfferRecordError(issuePaths(parsed.error));
  return parsed.data;
}

/**
 * Reconstruct the stable record from its row and its current version.
 *
 * `terms`, `effectiveInterval`, and `economics` come from the **current
 * version**, not from the pointer row: the version is authoritative for material
 * facts, and duplicating commercial terms onto the stable row would create a
 * second answer that could drift from the one a Listing binds to.
 *
 * `createdAt` and `updatedAt` are the stable row's own operational timestamps,
 * which is what the source record's members mean — when this Offer came into
 * existence and when it last moved, not when any one version was recorded.
 */
export function offerRowToSourceRecord(row: OfferRow, currentVersion: VersionRow): SourceRecord {
  const current = versionRowToSourceVersion(currentVersion);
  const parsed = OfferSourceRecord.safeParse({
    offerSourceRecordId: row.offerSourceRecordId,
    internalOfferId: row.internalOfferId,
    currentSourceRecordVersion: row.currentSourceRecordVersion,

    internalProductId: row.internalProductId,
    sellerParticipantId: row.sellerParticipantId,

    sourceSystem: currentVersion.sourceSystem,
    sourceRecordType: currentVersion.sourceRecordType,
    sourceClass: currentVersion.sourceClass,

    lifecycle: row.lifecycle,
    availability: row.availability,
    terms: current.terms,
    effectiveInterval: current.effectiveInterval,
    economics: current.economics,

    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  });
  if (!parsed.success) throw new CorruptOfferRecordError(issuePaths(parsed.error));
  return parsed.data;
}

/**
 * Flatten validated commercial terms into their persisted columns.
 *
 * The exact inverse of `termsFromRow`. An arm that does not apply is written as
 * explicit `null` rather than left undefined, so a FREE Offer's row carries no
 * stale price from whatever it superseded.
 */
export function termsToColumns(terms: OfferCommercialTerms): {
  priceType: string;
  wholesalePriceMinorUnits: bigint | null;
  wholesalePriceCurrency: string | null;
  promotionType: string;
  commissionMethod: string | null;
  commissionBasisPoints: number | null;
  fixedCommissionMinorUnits: bigint | null;
  fixedCommissionCurrency: string | null;
} {
  const paid = terms.price.type === "PAID" ? terms.price : null;
  const commission = terms.promotion.type === "PROMOTABLE" ? terms.promotion.commission : null;
  const percent = commission?.method === "PERCENT_OF_WHOLESALE" ? commission : null;
  const fixed = commission?.method === "FIXED_AMOUNT" ? commission : null;

  return {
    priceType: terms.price.type,
    wholesalePriceMinorUnits: paid === null ? null : BigInt(paid.wholesalePriceMinorUnits),
    wholesalePriceCurrency: paid?.wholesalePriceCurrency ?? null,
    promotionType: terms.promotion.type,
    commissionMethod: commission?.method ?? null,
    commissionBasisPoints: percent?.commissionBasisPoints ?? null,
    fixedCommissionMinorUnits:
      fixed === null ? null : BigInt(fixed.fixedCommissionMinorUnits),
    fixedCommissionCurrency: fixed?.fixedCommissionCurrency ?? null,
  };
}

/** Flatten the canonical effective interval into its two nullable columns. */
export function effectiveIntervalToColumns(interval: OfferEffectiveIntervalField): {
  effectiveStartsAt: Date | null;
  effectiveEndsAt: Date | null;
} {
  if (interval === null) return { effectiveStartsAt: null, effectiveEndsAt: null };
  return {
    effectiveStartsAt: interval.startsAt === null ? null : new Date(interval.startsAt),
    effectiveEndsAt: interval.endsAt === null ? null : new Date(interval.endsAt),
  };
}
