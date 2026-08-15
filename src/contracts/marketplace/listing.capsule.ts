/**
 * Listing Capsule Projection Shape (Phase 0M.4B).
 *
 * The strict public representation produced from **one explicitly identified
 * immutable `ListingSourceVersion`**. It is a projection, not a record: it
 * asserts nothing the database does not already hold, and nothing here can be
 * written back (ADR §12).
 *
 * Six properties shape everything below:
 *
 *   1. **The envelope is the established one.** Exactly `@context`, `@type`,
 *      `metadata`, `data` (ANS §3), with every metadata member reused from
 *      `capsule/envelope.ts`. No second envelope convention is invented.
 *
 *   2. **The public claim set is deliberately small.** A buyer needs to know
 *      what is being sold, where, by whom, at what price, and on what basis. It
 *      is six members, and the allow-list is declared once.
 *
 *   3. **No Monacado economics reach the capsule.** The retained amount, the MoR
 *      wholesale acquisition amount, the fee-policy identity, seller proceeds,
 *      promoter proceeds, the promoter spread, and the minimum viable price are
 *      **settlement facts, not buyer-facing semantics**. None has a field here.
 *
 *   4. **No Offer internals reach it either** — not the accepted wholesale
 *      price, not the seller-funded commission, not the accepted source version,
 *      not the review state. See the note on the deliberately absent Offer
 *      reference below.
 *
 *   5. **Only a purchasable Listing projects at all.** A Listing blocked by its
 *      own lifecycle or by any upstream entity is refused, following the
 *      Storefront precedent where only a live Storefront projects. A public
 *      vocabulary able to say "blocked" would invite publishing one, and the
 *      blocking reason is private operational detail.
 *
 *   6. **`publishedBy`, `publishedAt`, `supersedes`, and `revokes` are absent.**
 *      Those are publication facts, and this phase publishes nothing.
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
import { CurrencyCode, MinorUnitAmount } from "./offer-source";
import { ListingType } from "./listing-source";

export const LISTING_TYPE = "Listing" as const;

const ListingCapsuleType = z.union([
  z.literal(LISTING_TYPE),
  z.array(z.string().min(1)).refine((arr) => arr.includes(LISTING_TYPE), {
    message: `@type must include "${LISTING_TYPE}"`,
  }),
]);

// — Public price —

/**
 * A seller's scheduled sale, published as the seller's own pricing instruction.
 *
 * All three members live in one object, so **all-present-or-all-absent is the
 * shape**, mirroring the authoritative source model rather than restating its
 * invariant as a rule someone can forget.
 *
 * `validFrom` / `validThrough` are reused verbatim from schema.org rather than
 * minted as `saleStartsAt` / `saleEndsAt`: a sale is a price that is valid over
 * an interval, which is exactly what those terms already mean, and the existing
 * `validThrough` description — "instant after which the terms no longer apply" —
 * is already the exclusive end this model uses.
 *
 * **Start inclusive, end exclusive**, UTC. Two consecutive sales cannot both be
 * active for the instant they touch.
 */
export const PublicSaleSchedule = z.strictObject({
  salePrice: MinorUnitAmount,
  /** Inclusive. The sale price applies at exactly this instant. */
  validFrom: z.iso.datetime(),
  /** Exclusive. The sale price no longer applies at exactly this instant. */
  validThrough: z.iso.datetime(),
});
export type PublicSaleSchedule = z.infer<typeof PublicSaleSchedule>;

/**
 * A seller-direct Listing's public price.
 *
 * **Self-describing across time.** The ordinary price and the sale schedule are
 * both published, so a consumer derives the effective price for any instant and
 * the capsule stays semantically correct as the clock advances. Publishing a
 * single time-selected price instead would make the artifact wrong the moment a
 * sale boundary passed, and would oblige a publication pipeline to regenerate on
 * a schedule — republishing because time moved, not because anything changed.
 *
 * A scheduled sale is an **authoritative seller pricing instruction**, not
 * private workflow state: the seller decided it, and it is exactly the kind of
 * fact a buyer-facing artifact should carry.
 */
export const PublicSellerDirectPrice = z
  .strictObject({
    /** The ordinary commercial retail price. Never mutated by a sale. */
    basePrice: MinorUnitAmount,
    priceCurrency: CurrencyCode,
    /** Present only when the seller has scheduled one. */
    sale: PublicSaleSchedule.optional(),
  })
  .superRefine((price, ctx) => {
    if (price.sale === undefined) return;
    if (price.sale.salePrice >= price.basePrice) {
      ctx.addIssue({
        code: "custom",
        path: ["sale", "salePrice"],
        message: "a sale price must be strictly lower than the ordinary price",
      });
    }
    if (Date.parse(price.sale.validThrough) <= Date.parse(price.sale.validFrom)) {
      ctx.addIssue({
        code: "custom",
        path: ["sale", "validThrough"],
        message: "validThrough must be later than validFrom",
      });
    }
  });
export type PublicSellerDirectPrice = z.infer<typeof PublicSellerDirectPrice>;

/**
 * A promoted Listing's public price.
 *
 * The promoter's own retail price, and **no sale member exists** — seller sale
 * scheduling is a seller mechanism over a seller's price. Its absence here is
 * structural: a promoted capsule cannot carry a sale price, a sale window, or
 * the seller's ordinary price, because there is nowhere to put them.
 */
export const PublicPromotedPrice = z.strictObject({
  basePrice: MinorUnitAmount,
  priceCurrency: CurrencyCode,
});
export type PublicPromotedPrice = z.infer<typeof PublicPromotedPrice>;

// — Effective price derivation —

export interface EffectiveListingPrice {
  effectivePriceMinorUnits: number;
  priceCurrency: string;
  saleActive: boolean;
}

/**
 * Derive the effective buyer price from a **published** seller-direct price and
 * a caller-supplied instant.
 *
 * Offered so every consumer derives it the same way rather than each reimplementing
 * the boundary rule. It is **not** a capsule field: storing the result would
 * reintroduce exactly the time-dependent value this shape exists to avoid.
 *
 * Half-open: `now ≥ validFrom && now < validThrough`. Pure — no clock, no
 * mutation, integer minor units throughout.
 */
export function effectivePublicListingPrice(input: {
  price: PublicSellerDirectPrice | PublicPromotedPrice;
  now: string;
}): EffectiveListingPrice {
  const sale = "sale" in input.price ? input.price.sale : undefined;
  const at = Date.parse(input.now);
  const active =
    sale !== undefined &&
    at >= Date.parse(sale.validFrom) &&
    at < Date.parse(sale.validThrough);

  return {
    effectivePriceMinorUnits: active ? sale.salePrice : input.price.basePrice,
    priceCurrency: input.price.priceCurrency,
    saleActive: active,
  };
}

// — Relationships —

/**
 * The three Node references a Listing makes.
 *
 * All are Registrar-issued opaque ANS Node IDs supplied by the projection
 * context. `AnsNodeId` structurally refuses a semantic or internal value, so a
 * `mon:product:` or `mon:storefront:` id cannot be passed off as a Node.
 *
 * **There is deliberately no Offer reference.** A promoted Listing's accepted
 * Offer is genuine semantic linkage, and publishing it was considered — but the
 * Offer capsule publishes its own wholesale price, so a consumer holding both
 * capsules could subtract one public number from the other and recover the
 * promoter's retail spread. That figure is explicitly not a buyer-facing fact.
 * A reference that discloses by composition discloses just the same, so the
 * relationship stays out until an architecture decision says otherwise.
 */
export const ListingRelationships = z.strictObject({
  /** The Product this Listing sells. */
  offeredProduct: AnsNodeId,
  /** The Storefront it is listed in. */
  listedInStorefront: AnsNodeId,
  /** The approved public authority Node controlling it — seller or promoter. */
  operatedBy: AnsNodeId,
});
export type ListingRelationships = z.infer<typeof ListingRelationships>;

// — Data —

/**
 * The complete public Listing claim set, **structurally discriminated by type**.
 *
 * `listingType` is published because "you are buying from the creator" and "you
 * are buying from a reseller" are materially different facts to a buyer, and both
 * are already authoritative. It discloses nothing about the commercial
 * arrangement behind the resale.
 *
 * The discrimination is what makes the seller/promoter boundary structural: a
 * `PROMOTED` capsule's price schema has **no `sale` member at all**, so a seller
 * sale cannot appear on one even by mistake.
 */
export const SellerDirectListingData = z.strictObject({
  listingType: z.literal("SELLER_DIRECT"),
  price: PublicSellerDirectPrice,
  relationships: ListingRelationships,
});

export const PromotedListingData = z.strictObject({
  listingType: z.literal("PROMOTED"),
  price: PublicPromotedPrice,
  relationships: ListingRelationships,
});

export const ListingCapsuleDataBase = z.discriminatedUnion("listingType", [
  SellerDirectListingData,
  PromotedListingData,
]);

export const ListingCapsuleData = ListingCapsuleDataBase;
export type ListingCapsuleData = z.infer<typeof ListingCapsuleData>;

// — Metadata —

/**
 * Projection-stage metadata — identical in shape to the Offer and Storefront
 * projections'.
 *
 * `capsuleId` and `bindsToNode` are **supplied by the projection context, not
 * issued here**: binding to an identifier someone else issued is not the same act
 * as issuing one (ADR §11.2).
 */
export const ListingProjectionMetadata = z.strictObject({
  capsuleId: CapsuleId,
  bindsToNode: AnsNodeId,
  version: SemVer,
  provenance: ProvenanceRecord,
  nodePolicy: PolicyRef,
  capsulePolicy: PolicyRef,
  contentHash: ContentHash,
});
export type ListingProjectionMetadata = z.infer<typeof ListingProjectionMetadata>;

// — The capsule —

export const ListingCapsuleProjectionBase = z.strictObject({
  "@context": ContextValue,
  "@type": ListingCapsuleType,
  metadata: ListingProjectionMetadata,
  data: ListingCapsuleDataBase,
});

export const ListingCapsuleProjection = z
  .strictObject({
    "@context": ContextValue,
    "@type": ListingCapsuleType,
    metadata: ListingProjectionMetadata,
    data: ListingCapsuleData,
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
export type ListingCapsuleProjection = z.infer<typeof ListingCapsuleProjection>;

export interface ListingValidationResult {
  ok: boolean;
  capsule?: ListingCapsuleProjection;
  errors?: string[];
}

export function validateListingCapsuleProjection(value: unknown): ListingValidationResult {
  const result = ListingCapsuleProjection.safeParse(value);
  if (result.success) return { ok: true, capsule: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

// — Public field allow-list —

/**
 * Every key this capsule's `data` may carry, in one place.
 *
 * The allow-list **is** the privacy boundary: a field absent here has no schema
 * member, no mapper branch, and no way into the artifact. A test asserts it
 * agrees with the schema's own keys, and a second test gives every authoritative
 * Listing fact an explicit disposition — projected, derived into a public fact,
 * or deliberately excluded — so nothing can be silently forgotten.
 */
export const PUBLIC_LISTING_CAPSULE_FIELDS = [
  "listingType",
  "price",
  "relationships",
] as const;

/** Every key a seller-direct public price may carry. */
export const PUBLIC_SELLER_DIRECT_PRICE_FIELDS = [
  "basePrice",
  "priceCurrency",
  "sale",
] as const;

/** Every key a promoted public price may carry. Deliberately has no `sale`. */
export const PUBLIC_PROMOTED_PRICE_FIELDS = ["basePrice", "priceCurrency"] as const;

/** Every key a published sale schedule may carry. */
export const PUBLIC_SALE_SCHEDULE_FIELDS = ["salePrice", "validFrom", "validThrough"] as const;
export type PublicListingCapsuleField = (typeof PUBLIC_LISTING_CAPSULE_FIELDS)[number];

/**
 * Facts that must never appear in a public Listing capsule, named so a test can
 * enumerate them.
 *
 * A backstop, not the boundary — the allow-list above is the boundary. This list
 * exists because the economics of a promoted sale are the single most tempting
 * thing to publish "just for transparency", and a named refusal is harder to
 * undo by accident than an omission.
 */
export const NEVER_IN_LISTING_CAPSULE = [
  // MoR / Monacado economics
  "monacadoRetainedAmountMinorUnits",
  "morWholesaleAcquisitionAmountMinorUnits",
  "retainedPercentageBasisPoints",
  "retainedFixedAmountMinorUnits",
  "policyId",
  "policyVersion",
  "minimumViableRetailPrice",
  "currentPrice",
  // Offer internals
  "offerWholesalePriceMinorUnits",
  "sellerFundedCommissionMinorUnits",
  "acceptedOfferSourceRecordVersion",
  "acceptedWholesalePriceMinorUnits",
  "upstreamReviewState",
  "offerDependency",
  // Party settlement figures
  "sellerProceedsMinorUnits",
  "promoterNetProceedsMinorUnits",
  "promoterRetailSpreadMinorUnits",
  "promoterMarginRateBasisPoints",
  // Checkout concerns
  "taxMinorUnits",
  "shippingMinorUnits",
  "checkoutTotalMinorUnits",
  // Private operational data
  "accountId",
  "email",
  "participantProfile",
  "paymentProviderToken",
  "stripeAccountId",
  "riskClassification",
  "underwritingData",
  "moderationNotes",
  "payoutCredentials",
  "authorizedByActorId",
  "authorizedByParticipantId",
  "blockingReasons",
] as const;
