/**
 * Listing capsule projection: context, eligibility, and mapping (Phase 0M.4B).
 *
 * The only permitted flow:
 *
 * ```
 * ListingSourceVersion → recorded projection context → projection mapping
 *   → Listing Capsule Projection Shape
 * ```
 *
 * Six properties shape everything below, mirroring the Offer and Storefront
 * projections:
 *
 *   1. **One exact source version, supplied by the caller.** There is no
 *      "current record" parameter, no "latest" lookup, and no repository — the
 *      mapper cannot reach a database even if someone wanted it to.
 *
 *   2. **Public identity comes only from the context, and must be proven to
 *      match.** Each binding pairs a Registrar-issued Node with the internal
 *      identifier it stands for; the mapper checks the pairing against the
 *      source version and then discards the internal half.
 *
 *   3. **Fails closed.** A Listing that is not purchasable, a mismatched
 *      binding, an invalid source version, or an invalid context produces an
 *      error, never a best-effort capsule. **Projection repairs nothing.**
 *
 *   4. **Deterministic.** Same source version + same context ⇒ byte-identical
 *      capsule and identical hash. Nothing reads a clock or generates
 *      randomness, and no price depends on when the projection ran — the
 *      generation instant is a context field used only for provenance.
 *
 *   5. **It writes nothing.** No transactional fact, authority, provenance, Node
 *      registration, publication state, or source version is created here. There
 *      is deliberately **no inverse function** — no capsule-to-source mapper
 *      exists in this module or anywhere else.
 *
 *   6. **Upstream rules are used, never reimplemented.** Buyer eligibility comes
 *      from the Listing source model's own `evaluateListingBuyerEligibility`,
 *      which in turn defers to the Storefront's accessibility helper and the
 *      Offer's lifecycle. A projection with its own copy would be a second,
 *      contradictory answer.
 *
 * Pure functions. No database, clock, environment read, randomness, or network.
 */

import { z } from "zod";
import {
  AnsNodeId,
  CapsuleId,
  PolicyRef,
  SemVer,
  type ProvenanceRecord,
} from "../capsule/envelope";
import { publishedContentHash, withPublishedContentHash } from "../integrity/hash";
import { AN_O_CONTEXT_REF, COMMERCE_CONTEXT_REF } from "../ontology/commerce.context";
import { GeneralAvailabilityState } from "../product/product.capsule";
import {
  LISTING_TYPE,
  ListingCapsuleProjection,
  type ListingCapsuleData,
} from "./listing.capsule";
import {
  InternalListingId,
  InternalProductRef,
  InternalStorefrontRef,
  ListingSourceRecordId,
  ListingSourceRecordVersion,
  ListingSourceVersion,
  evaluateListingBuyerEligibility,
  type ListingBlockingReason,
} from "./listing-source";
import { MarketplaceParticipantId, type ParticipantStatus, type RoleAssignmentStatus } from "./participant";
import type { OfferAvailability, OfferLifecycleState } from "./offer-source";
import type { StorefrontExposure } from "./storefront-source";

// — Eligibility —

/**
 * Why a Listing source version may not be projected.
 *
 * `NOT_BUYER_ACTIVE` is deliberately **one coarse code covering every upstream
 * block**. The specific reasons — which upstream entity is failing, and how —
 * are private operational detail a caller may read from
 * `evaluateListingBuyerEligibility` directly. Surfacing them through the
 * projection boundary would make a public-facing failure path into a probe for
 * a seller's account standing or a Storefront's approval state.
 */
export const LISTING_PROJECTION_INELIGIBILITY_REASONS = ["NOT_BUYER_ACTIVE"] as const;
export const ListingProjectionIneligibilityReason = z.enum(
  LISTING_PROJECTION_INELIGIBILITY_REASONS,
);
export type ListingProjectionIneligibilityReason = z.infer<
  typeof ListingProjectionIneligibilityReason
>;

/**
 * The upstream state a projection needs to decide whether a Listing is
 * purchasable.
 *
 * Supplied, never fetched. Each field is the *other* entity's own authoritative
 * fact; nothing here decides what those facts mean.
 */
export const ListingUpstreamState = z.strictObject({
  productAvailability: GeneralAvailabilityState,
  storefrontLifecycle: z.enum(["DRAFT", "ACTIVE", "SUSPENDED", "CLOSED"]),
  storefrontVisibility: z.enum(["PRIVATE", "UNLISTED", "PUBLIC"]),
  storefrontGoLiveApproval: z.enum(["APPROVED", "NOT_APPROVED"]),
  controllingParticipantStatus: z.enum([
    "DRAFT",
    "PROFILE_INCOMPLETE",
    "PROFILE_COMPLETE",
    "UNDER_REVIEW",
    "ACTIVE",
    "RESTRICTED",
    "SUSPENDED",
    "CLOSED",
  ]),
  controllingRoleStatus: z.enum([
    "DRAFT",
    "PENDING_ACTIVATION",
    "ACTIVE",
    "SUSPENDED",
    "REVOKED",
  ]),
  /** Promoted Listings only — the EXACT accepted Offer version's terms. */
  offerLifecycle: z.enum(["DRAFT", "ACTIVE", "SUSPENDED", "ENDED", "WITHDRAWN"]).optional(),
  /** Promoted Listings only — the EXACT accepted Offer version's terms. */
  offerAvailability: z.enum(["AVAILABLE", "TEMPORARILY_UNAVAILABLE"]).optional(),
  /**
   * Promoted Listings only — the Offer's CURRENT stable state (Phase 1.15,
   * Ruling 1).
   *
   * Separate from the two above, which describe the immutable accepted version.
   * A Seller who ends or withdraws their Offer stops new commerce, and a capsule
   * projected from the frozen version alone would keep presenting a Listing as
   * purchasable after the Seller stopped offering it.
   *
   * Supplied, like every other upstream fact here — the projection reaches no
   * database.
   */
  currentOfferLifecycle: z
    .enum(["DRAFT", "ACTIVE", "SUSPENDED", "ENDED", "WITHDRAWN"])
    .optional(),
  /** Promoted Listings only — the Offer's CURRENT stable state. */
  currentOfferAvailability: z.enum(["AVAILABLE", "TEMPORARILY_UNAVAILABLE"]).optional(),
});
export type ListingUpstreamState = z.infer<typeof ListingUpstreamState>;

// — Projection context —

export const ListingNodeBinding = z.strictObject({
  /**
   * Registrar-issued Node for this Listing. **Never derived from
   * `mon:listing:`** and never encoding the storefront, product, type, or
   * controller — an ANS Node ID is opaque, and a semantic one would leak
   * business meaning into the identity layer (ADR §11.5).
   */
  listingNode: AnsNodeId,
  /** The internal Listing this Node stands for — checked, then discarded. */
  internalListingId: InternalListingId,
});

export const ListingProductBinding = z.strictObject({
  productNode: AnsNodeId,
  internalProductId: InternalProductRef,
});

export const ListingStorefrontBinding = z.strictObject({
  storefrontNode: AnsNodeId,
  storefrontId: InternalStorefrontRef,
});

export const ListingControllerBinding = z.strictObject({
  /** The controlling participant's approved public authority Node. */
  controllerAuthorityNode: AnsNodeId,
  /** The transactional participant it stands for — checked, then discarded. */
  controllingParticipantId: MarketplaceParticipantId,
});

/** Names the exact source version this projection is for. */
export const ListingSourceVersionBinding = z.strictObject({
  listingSourceRecordId: ListingSourceRecordId,
  sourceRecordVersion: ListingSourceRecordVersion,
});

export const ListingProjectionContext = z.strictObject({
  listingBinding: ListingNodeBinding,
  productBinding: ListingProductBinding,
  storefrontBinding: ListingStorefrontBinding,
  controllerBinding: ListingControllerBinding,
  sourceVersionBinding: ListingSourceVersionBinding,

  /** Upstream facts the eligibility decision needs. Supplied, never fetched. */
  upstream: ListingUpstreamState,


  /** The capsule-version identity, issued elsewhere; this phase issues nothing. */
  capsuleId: CapsuleId,
  capsuleVersion: SemVer,
  /** The recorded projection-mapping version. Stamped into provenance. */
  mappingVersion: z.string().min(1).max(64),
  /** Explicit generation instant. There is no default and no clock read. */
  generatedAt: z.iso.datetime(),
  nodePolicy: PolicyRef,
  capsulePolicy: PolicyRef,
});
export type ListingProjectionContext = z.infer<typeof ListingProjectionContext>;

// — Errors —

export const LISTING_PROJECTION_ERROR_CODES = [
  "INVALID_SOURCE_VERSION",
  "INVALID_PROJECTION_CONTEXT",
  "SOURCE_VERSION_BINDING_MISMATCH",
  "LISTING_BINDING_MISMATCH",
  "PRODUCT_BINDING_MISMATCH",
  "STOREFRONT_BINDING_MISMATCH",
  "CONTROLLER_BINDING_MISMATCH",
  "NOT_PROJECTION_ELIGIBLE",
  "INVALID_PROJECTION_OUTPUT",
  "UNSUPPORTED_CAPSULE_VERSION",
  "UNSUPPORTED_MAPPING_VERSION",
] as const;
export type ListingProjectionErrorCode = (typeof LISTING_PROJECTION_ERROR_CODES)[number];

/**
 * A bounded failure.
 *
 * Carries a code and, for ineligibility, only the coarse
 * `NOT_BUYER_ACTIVE` reason — never a source value, an internal identifier, a
 * price, or the specific upstream entity that blocked it.
 */
export class ListingProjectionError extends Error {
  readonly code: ListingProjectionErrorCode;
  readonly reason?: ListingProjectionIneligibilityReason;

  constructor(code: ListingProjectionErrorCode, reason?: ListingProjectionIneligibilityReason) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = "ListingProjectionError";
    this.code = code;
    this.reason = reason;
  }
}

// — Mapping —

/** The method recorded in provenance: this capsule is a projection of a version. */
export const LISTING_PROJECTION_METHOD = "governed-source-version-projection" as const;

/**
 * The exact capsule version this mapper emits and accepts.
 *
 * Pinned rather than treated as a floor, on the Offer's reasoning: a future
 * `1.1.0` would carry claims this mapper does not know how to produce, and
 * accepting it implicitly would let a caller label output as a shape it is not.
 *
 * New to the Listing. Product, Offer, and Storefront versions are untouched.
 */
export const SUPPORTED_LISTING_CAPSULE_VERSION = "1.0.0" as const;

/** The projection mapping version stamped into provenance. */
export const LISTING_PROJECTION_MAPPING_VERSION = "listing-projection/1.0.0" as const;

function buildProvenance(
  source: ListingSourceVersion,
  context: ListingProjectionContext,
): ProvenanceRecord {
  return {
    source: `${source.sourceSystem}:${source.sourceRecordType}:${source.listingSourceRecordId}@${source.sourceRecordVersion}`,
    method: LISTING_PROJECTION_METHOD,
    /* The instant the authoritative fact was recorded — represented, not created.
       The capsule does not claim to have established it. */
    acquiredAt: source.recordedAt,
    assertionKind: "Asserted",
    sourceClass: source.sourceClass,
    sourceSystem: source.sourceSystem,
    sourceRecordType: source.sourceRecordType,
    sourceRecordId: source.listingSourceRecordId,
    sourceRecordVersion: source.sourceRecordVersion,
    generatedAt: context.generatedAt,
    generatorVersion: context.mappingVersion,
  };
}

/**
 * The buyer-facing price for one source version.
 *
 * **No instant is involved.** A seller-direct price publishes the ordinary price
 * and, when the seller scheduled one, the complete sale schedule — so the capsule
 * describes the seller's pricing instructions rather than the answer at one
 * moment, and stays correct as the clock advances. A promoted price is the
 * promoter's retail price, which has no sale mechanism.
 *
 * The two branches read different fields of a discriminated union and produce
 * differently-shaped output, so nothing about a seller's price — ordinary or on
 * sale — can reach a promoted capsule.
 */
function mapData(
  source: ListingSourceVersion,
  context: ListingProjectionContext,
): ListingCapsuleData {
  const relationships = {
    offeredProduct: context.productBinding.productNode,
    listedInStorefront: context.storefrontBinding.storefrontNode,
    operatedBy: context.controllerBinding.controllerAuthorityNode,
  };

  if (source.placement.listingType === "SELLER_DIRECT") {
    const { retail, sale } = source.placement;
    return {
      listingType: "SELLER_DIRECT",
      price: {
        basePrice: retail.retailPriceMinorUnits,
        priceCurrency: retail.retailPriceCurrency,
        /* One canonical public absence: a sale the source does not hold is an
           omitted key, never `null`. */
        ...(sale !== null
          ? {
              sale: {
                salePrice: sale.salePriceMinorUnits,
                validFrom: sale.saleStartsAt,
                validThrough: sale.saleEndsAt,
              },
            }
          : {}),
      },
      relationships,
    };
  }

  return {
    listingType: "PROMOTED",
    price: {
      basePrice: source.placement.retail.retailPriceMinorUnits,
      priceCurrency: source.placement.retail.retailPriceCurrency,
    },
    relationships,
  };
}

/**
 * Project one identified source version into a public capsule.
 *
 * Order matters, and each step fails closed: validate the source version,
 * validate the context, prove every binding, check the version pins, check
 * buyer eligibility, map, hash, re-validate the output. The output validation is
 * what guarantees no internal identifier reached the capsule through a field
 * that accepts strings.
 *
 * **The authorization trace does not survive projection.**
 * `authorizedByParticipantId` and `authorizedByActorId` record who inside the
 * marketplace approved a change; they are never read here, so no mapping exists
 * that could publish them. The same is true of the entire Offer dependency on a
 * promoted Listing — the mapper never touches `placement.offerDependency`.
 */
export function listingSourceRecordToCapsuleProjection(input: {
  sourceVersion: ListingSourceVersion;
  context: ListingProjectionContext;
}): ListingCapsuleProjection {
  const sourceParsed = ListingSourceVersion.safeParse(input.sourceVersion);
  if (!sourceParsed.success) throw new ListingProjectionError("INVALID_SOURCE_VERSION");
  const source = sourceParsed.data;

  const contextParsed = ListingProjectionContext.safeParse(input.context);
  if (!contextParsed.success) throw new ListingProjectionError("INVALID_PROJECTION_CONTEXT");
  const context = contextParsed.data;

  /* The context must be for THIS source version — not for the Listing in
     general, and certainly not for whatever the current record happens to say. */
  if (
    context.sourceVersionBinding.listingSourceRecordId !== source.listingSourceRecordId ||
    context.sourceVersionBinding.sourceRecordVersion !== source.sourceRecordVersion
  ) {
    throw new ListingProjectionError("SOURCE_VERSION_BINDING_MISMATCH");
  }
  if (context.listingBinding.internalListingId !== source.internalListingId) {
    throw new ListingProjectionError("LISTING_BINDING_MISMATCH");
  }
  if (context.productBinding.internalProductId !== source.internalProductId) {
    throw new ListingProjectionError("PRODUCT_BINDING_MISMATCH");
  }
  if (context.storefrontBinding.storefrontId !== source.storefrontId) {
    throw new ListingProjectionError("STOREFRONT_BINDING_MISMATCH");
  }
  if (context.controllerBinding.controllingParticipantId !== source.controllingParticipantId) {
    throw new ListingProjectionError("CONTROLLER_BINDING_MISMATCH");
  }

  if (context.capsuleVersion !== SUPPORTED_LISTING_CAPSULE_VERSION) {
    throw new ListingProjectionError("UNSUPPORTED_CAPSULE_VERSION");
  }
  if (context.mappingVersion !== LISTING_PROJECTION_MAPPING_VERSION) {
    throw new ListingProjectionError("UNSUPPORTED_MAPPING_VERSION");
  }

  /* Eligibility is the Listing source model's decision, not a second copy of it.
     Only a purchasable Listing projects — the Storefront precedent, where only a
     live Storefront does. */
  const eligibility = evaluateListingBuyerEligibility({
    lifecycle: source.lifecycle,
    listingType: source.placement.listingType,
    productAvailability: context.upstream.productAvailability,
    storefrontExposure: {
      lifecycle: context.upstream.storefrontLifecycle,
      visibility: context.upstream.storefrontVisibility,
      goLiveApproval: context.upstream.storefrontGoLiveApproval,
    } satisfies StorefrontExposure,
    controllingParticipantStatus: context.upstream.controllingParticipantStatus as ParticipantStatus,
    controllingRoleStatus: context.upstream.controllingRoleStatus as RoleAssignmentStatus,
    ...(context.upstream.offerLifecycle !== undefined &&
    context.upstream.offerAvailability !== undefined
      ? {
          offer: {
            lifecycle: context.upstream.offerLifecycle as OfferLifecycleState,
            availability: context.upstream.offerAvailability as OfferAvailability,
          },
        }
      : {}),
    ...(context.upstream.currentOfferLifecycle !== undefined &&
    context.upstream.currentOfferAvailability !== undefined
      ? {
          currentOffer: {
            lifecycle: context.upstream.currentOfferLifecycle as OfferLifecycleState,
            availability: context.upstream.currentOfferAvailability as OfferAvailability,
          },
        }
      : {}),
    ...(source.placement.listingType === "PROMOTED"
      ? { upstreamReviewState: source.placement.upstreamReviewState }
      : {}),
  });
  if (!eligibility.buyerActive) {
    throw new ListingProjectionError("NOT_PROJECTION_ELIGIBLE", "NOT_BUYER_ACTIVE");
  }

  const data = mapData(source, context);

  const draft = {
    "@context": [COMMERCE_CONTEXT_REF, AN_O_CONTEXT_REF],
    "@type": LISTING_TYPE,
    metadata: {
      capsuleId: context.capsuleId,
      bindsToNode: context.listingBinding.listingNode,
      version: context.capsuleVersion,
      provenance: buildProvenance(source, context),
      nodePolicy: context.nodePolicy,
      capsulePolicy: context.capsulePolicy,
    },
    data,
  };

  const hashed = withPublishedContentHash(draft);
  const result = ListingCapsuleProjection.safeParse(hashed);
  if (!result.success) throw new ListingProjectionError("INVALID_PROJECTION_OUTPUT");
  return result.data;
}

export interface ListingProjectionVerification {
  /** The supplied capsule's content is exactly what this source version produces. */
  matches: boolean;
  expectedContentHash: string;
  /** Hash RECOMPUTED from the supplied capsule's own content. */
  actualContentHash: string;
  /** Whether the supplied capsule's stored hash agrees with its own content. */
  storedContentHashConsistent: boolean;
}

/**
 * Re-derive a capsule and report whether the one supplied is the same artifact.
 *
 * The same helper the Storefront projection carries, for the same reason: a
 * publication phase must be able to ask *is this published artifact still the one
 * this source version produces?*
 *
 * `actualContentHash` is **recomputed from the supplied capsule's content**, not
 * read from its `metadata.contentHash`. Trusting the stored value would let a
 * capsule whose body had been edited — while its hash was left alone — verify
 * successfully, which is precisely the tampering this function exists to catch.
 *
 * Pure, and it repairs nothing — it reports.
 */
export function verifyListingCapsuleProjection(input: {
  sourceVersion: ListingSourceVersion;
  context: ListingProjectionContext;
  capsule: ListingCapsuleProjection;
}): ListingProjectionVerification {
  const expected = listingSourceRecordToCapsuleProjection({
    sourceVersion: input.sourceVersion,
    context: input.context,
  });
  const actual = publishedContentHash(input.capsule);
  return {
    matches: expected.metadata.contentHash === actual,
    expectedContentHash: expected.metadata.contentHash,
    actualContentHash: actual,
    storedContentHashConsistent: input.capsule.metadata.contentHash === actual,
  };
}

/** Re-exported so callers can read the private detail the projection refuses to. */
export type { ListingBlockingReason };
