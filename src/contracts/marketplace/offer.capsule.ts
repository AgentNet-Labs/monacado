/**
 * Offer Capsule Projection Shape (Phase 0M.2B).
 *
 * The strict public representation produced from **one explicitly identified
 * immutable `OfferSourceVersion`**. It is a projection, not a record: it asserts
 * nothing the database does not already hold, and nothing here can be written
 * back (ADR §12).
 *
 * Five properties shape everything below:
 *
 *   1. **The envelope is the established one.** Exactly `@context`, `@type`,
 *      `metadata`, `data` (ANS §3), with every metadata member reused from
 *      `capsule/envelope.ts`. No second envelope convention is invented.
 *
 *   2. **Public identity comes only from the projection context.** `data` carries
 *      Registrar-issued Node IRIs. It never carries `mon:offer:`, `mon:srec:`,
 *      `mon:product:`, `mon:mpart:`, `mon:acct:`, or `mon:actor:` — a value scan
 *      refuses any internal identifier anywhere in the capsule, so an internal id
 *      cannot leak through a field that happens to accept strings.
 *
 *   3. **`publishedBy`, `publishedAt`, `supersedes`, and `revokes` are absent.**
 *      Those are publication facts, and this phase publishes nothing. A
 *      projection that carried them would be asserting an event that never
 *      happened.
 *
 *   4. **Product claims are not restated.** No name, description, image,
 *      category, specifications, or capabilities. The Product capsule is the
 *      creator's authority (ADR §2); an Offer that copied it would create a
 *      second, divergent answer to what the thing is.
 *
 *   5. **The source's own rules survive projection unchanged.** FREE carries no
 *      money, PAID is positive integer minor units, promotion requires PAID, and
 *      a fixed commission cannot exceed the price. The projection re-validates
 *      rather than trusting its input, and repairs nothing.
 *
 * Pure data. No clock, no randomness, no I/O.
 */

import { z } from "zod";
import {
  AnsNodeId,
  CapsuleId,
  ContentHash,
  ContextValue,
  PolicyRef,
  ProvenanceRecord,
  SemVer,
} from "../capsule/envelope";
import { findInternalIdentifiers } from "../capsule/internal-identifiers";
import {
  CurrencyCode,
  MAX_COMMISSION_BASIS_POINTS,
  MAX_MINOR_UNIT_AMOUNT,
  MIN_COMMISSION_BASIS_POINTS,
  MinorUnitAmount,
} from "./offer-source";

export const OFFER_TYPE = "Offer" as const;

const OfferType = z.union([
  z.literal(OFFER_TYPE),
  z.array(z.string().min(1)).refine((arr) => arr.includes(OFFER_TYPE), {
    message: `@type must include "${OFFER_TYPE}"`,
  }),
]);

// — Public commercial state —

/**
 * What a consumer of the capsule is told about the Offer's commercial standing.
 *
 * Derived from authoritative lifecycle **and** availability; never a copy of
 * either. The internal `DRAFT`, `SUSPENDED`, and `WITHDRAWN` states have no
 * public member here, because an Offer in one of those states is not projected
 * at all — a public vocabulary able to say "suspended" would invite publishing
 * one.
 */
export const PUBLIC_COMMERCIAL_STATES = [
  "AVAILABLE",
  "TEMPORARILY_UNAVAILABLE",
  "ENDED",
] as const;
export const PublicCommercialState = z.enum(PUBLIC_COMMERCIAL_STATES);
export type PublicCommercialState = z.infer<typeof PublicCommercialState>;

// — Public price —

/**
 * Money survives projection in **minor units**, exactly as the source holds it.
 *
 * schema.org `price` is a decimal, which is why this is a Monacado term: emitting
 * `9.99` would hand a consumer a float where the authoritative record has an
 * integer, and the two would disagree at the third decimal place of some
 * currency.
 */
export const PublicFreePrice = z.strictObject({
  priceType: z.literal("FREE"),
});

/**
 * The **wholesale** price — what the creator is owed, not what a buyer pays.
 *
 * The buyer-facing retail price belongs to a future Listing and set by the
 * Promoter; it has no field here and never will. Publishing a generic "price"
 * was the ambiguity this correction removes.
 */
export const PublicPaidPrice = z.strictObject({
  priceType: z.literal("PAID"),
  wholesalePriceMinorUnits: MinorUnitAmount,
  wholesalePriceCurrency: CurrencyCode,
});

/** A FREE Offer has no field for an amount or a currency. */
export const PublicOfferPrice = z.discriminatedUnion("priceType", [
  PublicFreePrice,
  PublicPaidPrice,
]);
export type PublicOfferPrice = z.infer<typeof PublicOfferPrice>;

// — Public commission —

/**
 * The commission a creator offers a promoter, and the **exact amount** a
 * completed sale owes.
 *
 * The calculated amount is published because a rate alone forces every consumer
 * to re-derive it — and to agree with Monacado's rounding while doing so.
 *
 * A fixed commission states its own currency: a monetary amount published
 * without one is not a monetary amount. It is required to equal the wholesale
 * currency and is checked against it, not assumed. A percentage carries basis
 * points; there is no money in the rate itself to denominate.
 *
 * **Creator gross proceeds are deliberately not a public claim.** What a creator
 * nets is between the creator and Monacado; a promoter needs the commission, and
 * a buyer needs neither.
 */
export const PublicPercentOfWholesaleCommission = z.strictObject({
  commissionMethod: z.literal("PERCENT_OF_WHOLESALE"),
  commissionBasisPoints: z.int().min(MIN_COMMISSION_BASIS_POINTS).max(MAX_COMMISSION_BASIS_POINTS),
  /** The exact amount a completed sale owes, computed from the wholesale price. */
  calculatedCommissionMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
});

export const PublicFixedAmountCommission = z.strictObject({
  commissionMethod: z.literal("FIXED_AMOUNT"),
  fixedCommissionMinorUnits: MinorUnitAmount,
  fixedCommissionCurrency: CurrencyCode,
  calculatedCommissionMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
});

export const PublicOfferCommission = z.discriminatedUnion("commissionMethod", [
  PublicPercentOfWholesaleCommission,
  PublicFixedAmountCommission,
]);
export type PublicOfferCommission = z.infer<typeof PublicOfferCommission>;

// — Relationships —

/**
 * The two Node references an Offer makes.
 *
 * Both are Registrar-issued opaque ANS Node IDs supplied by the projection
 * context. `AnsNodeId` structurally refuses a semantic or internal value, so a
 * `mon:product:` id cannot be passed off as a Product Node.
 */
export const OfferRelationships = z.strictObject({
  /** The Product Node these terms are for (schema.org `itemOffered`). */
  itemOffered: AnsNodeId,
  /** The approved public authority Node offering them. */
  offeredBy: AnsNodeId,
});
export type OfferRelationships = z.infer<typeof OfferRelationships>;

// — Data —

/**
 * The complete public Offer claim set.
 *
 * `validFrom` / `validThrough` are **omitted** when the source has no bound —
 * one canonical public representation of absence, mirroring the source's single
 * canonical `null`. They are optional rather than nullable, so an explicit
 * `null` is refused and two spellings cannot coexist.
 */
export const OfferCapsuleDataBase = z.strictObject({
  commercialState: PublicCommercialState,
  price: PublicOfferPrice,
  promotable: z.boolean(),
  /** Present if and only if `promotable` is true. */
  commission: PublicOfferCommission.optional(),
  validFrom: z.iso.datetime().optional(),
  validThrough: z.iso.datetime().optional(),
  relationships: OfferRelationships,
});

export const OfferCapsuleData = OfferCapsuleDataBase.superRefine((data, ctx) => {
  if (data.promotable && data.commission === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["commission"],
      message: "a promotable Offer must publish its commission terms",
    });
  }
  if (!data.promotable && data.commission !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["commission"],
      message: "commission terms may only appear on a promotable Offer",
    });
  }
  if (data.promotable && data.price.priceType === "FREE") {
    ctx.addIssue({
      code: "custom",
      path: ["promotable"],
      message: "a FREE Offer cannot be promotable; a paid commission requires a PAID Offer",
    });
  }
  if (data.commission !== undefined && data.price.priceType === "PAID") {
    if (data.commission.calculatedCommissionMinorUnits > data.price.wholesalePriceMinorUnits) {
      ctx.addIssue({
        code: "custom",
        path: ["commission", "calculatedCommissionMinorUnits"],
        message: "a commission must not exceed the wholesale price",
      });
    }
    if (data.commission.commissionMethod === "FIXED_AMOUNT") {
      if (data.commission.fixedCommissionMinorUnits > data.price.wholesalePriceMinorUnits) {
        ctx.addIssue({
          code: "custom",
          path: ["commission", "fixedCommissionMinorUnits"],
          message: "a fixed commission must not exceed the wholesale price",
        });
      }
      /* The published currency is checked against the wholesale price, not
         trusted: a capsule whose commission is denominated differently cannot be
         assembled by hand or by a future mapper that got it wrong. */
      if (data.commission.fixedCommissionCurrency !== data.price.wholesalePriceCurrency) {
        ctx.addIssue({
          code: "custom",
          path: ["commission", "fixedCommissionCurrency"],
          message: "a fixed commission must be in the same currency as the wholesale price",
        });
      }
    }
  }
  if (
    data.validFrom !== undefined &&
    data.validThrough !== undefined &&
    Date.parse(data.validThrough) <= Date.parse(data.validFrom)
  ) {
    ctx.addIssue({
      code: "custom",
      path: ["validThrough"],
      message: "validThrough must be later than validFrom",
    });
  }
});
export type OfferCapsuleData = z.infer<typeof OfferCapsuleData>;

// — Metadata —

/**
 * Projection-stage metadata.
 *
 * Every member is reused from the shared envelope. `publishedBy`, `publishedAt`,
 * `supersedes`, and `revokes` are **deliberately absent**: they are facts about a
 * publication event, and this phase performs none. They arrive when a publication
 * phase actually publishes.
 *
 * `capsuleId` and `bindsToNode` are **supplied by the projection context, not
 * issued here** — binding to an identifier someone else issued is not the same
 * act as issuing one (ADR §11.2).
 */
export const OfferProjectionMetadata = z.strictObject({
  capsuleId: CapsuleId,
  bindsToNode: AnsNodeId,
  version: SemVer,
  provenance: ProvenanceRecord,
  nodePolicy: PolicyRef,
  capsulePolicy: PolicyRef,
  contentHash: ContentHash,
});
export type OfferProjectionMetadata = z.infer<typeof OfferProjectionMetadata>;

// — Internal-identifier guard —

/**
 * The guard moved to `capsule/internal-identifiers` in Phase 0M.3B, when the
 * Storefront projection needed the same rule — a rule two capsules share belongs
 * in one place, not copied.
 *
 * Re-exported here so this module's public surface is unchanged. The shared list
 * additionally refuses `mon:storefront:`, which strengthens this capsule too.
 */
export {
  FORBIDDEN_INTERNAL_ID_PREFIXES,
  findInternalIdentifiers,
  type InternalIdentifierFinding,
} from "../capsule/internal-identifiers";

// — The capsule —

export const OfferCapsuleProjectionBase = z.strictObject({
  "@context": ContextValue,
  "@type": OfferType,
  metadata: OfferProjectionMetadata,
  data: OfferCapsuleDataBase,
});

export const OfferCapsuleProjection = z
  .strictObject({
    "@context": ContextValue,
    "@type": OfferType,
    metadata: OfferProjectionMetadata,
    data: OfferCapsuleData,
  })
  .superRefine((capsule, ctx) => {
    for (const finding of findInternalIdentifiers(capsule)) {
      ctx.addIssue({
        code: "custom",
        path: finding.path.split(/[.[\]]+/).filter(Boolean),
        message: `Internal identifier (${finding.prefix}…) at ${finding.path} must never appear in a public capsule.`,
      });
    }
  });
export type OfferCapsuleProjection = z.infer<typeof OfferCapsuleProjection>;

export interface OfferValidationResult {
  ok: boolean;
  capsule?: OfferCapsuleProjection;
  errors?: string[];
}

export function validateOfferCapsuleProjection(value: unknown): OfferValidationResult {
  const result = OfferCapsuleProjection.safeParse(value);
  if (result.success) return { ok: true, capsule: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}
