/**
 * Offer capsule projection: context, eligibility, and mapping (Phase 0M.2B).
 *
 * The only permitted flow:
 *
 * ```
 * OfferSourceVersion → recorded projection context → projection mapping
 *   → Offer Capsule Projection Shape
 * ```
 *
 * Six properties shape everything below:
 *
 *   1. **One exact source version, supplied by the caller.** There is no
 *      "current record" parameter, no "latest" lookup, and no repository — the
 *      mapper cannot reach a database even if someone wanted it to. An
 *      unidentified source version fails schema validation before any mapping
 *      happens.
 *
 *   2. **Public identity comes only from the context, and must be proven to
 *      match.** The context carries the internal ids it claims to stand for, the
 *      mapper checks them against the source version, and those internal ids are
 *      then discarded — used for validation, never emitted.
 *
 *   3. **Fails closed.** An ineligible Offer, a mismatched binding, an invalid
 *      source version, or an invalid context produces an error, never a
 *      best-effort capsule. **Projection repairs nothing** — a source that cannot
 *      be projected is a source someone must fix at the source.
 *
 *   4. **Deterministic.** Same source version + same context ⇒ byte-identical
 *      capsule and identical hash. Nothing reads a clock or generates randomness;
 *      the generation instant is a context field.
 *
 *   5. **It writes nothing.** No transactional fact, authority, provenance, Node
 *      registration, publication state, or source version is created here.
 *
 *   6. **Provenance is represented, not created.** The capsule restates facts the
 *      database already holds — which source version, which mapping, when
 *      generated — and asserts none of them into being.
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
import { withPublishedContentHash } from "../integrity/hash";
import { AN_O_CONTEXT_REF, COMMERCE_CONTEXT_REF } from "../ontology/commerce.context";
import {
  OFFER_TYPE,
  OfferCapsuleProjection,
  type OfferCapsuleData,
  type PublicCommercialState,
  type PublicOfferCommission,
  type PublicOfferPrice,
} from "./offer.capsule";
import {
  InternalOfferId,
  InternalProductId,
  OfferSourceRecordId,
  OfferSourceRecordVersion,
  OfferSourceVersion,
  calculateOfferEconomics,
  type OfferAvailability,
  type OfferLifecycleState,
} from "./offer-source";
import { MarketplaceParticipantId } from "./participant";

// — Eligibility —

/**
 * Whether an Offer source version may be projected at all, and as what.
 *
 * `SUSPENDED` and `WITHDRAWN` are ineligible **in this phase**: whether a
 * suspension or withdrawal should supersede, revoke, or simply stop refreshing an
 * already-published capsule is a publication-lifecycle decision, and answering it
 * by quietly projecting something would be answering it by accident.
 */
export const PROJECTION_ELIGIBILITY_REASONS = [
  "DRAFT_NOT_PUBLIC",
  "SUSPENDED_PUBLICATION_DEFERRED",
  "WITHDRAWN_PUBLICATION_DEFERRED",
] as const;
export const ProjectionIneligibilityReason = z.enum(PROJECTION_ELIGIBILITY_REASONS);
export type ProjectionIneligibilityReason = z.infer<typeof ProjectionIneligibilityReason>;

export type OfferProjectionEligibility =
  | { eligible: true; commercialState: PublicCommercialState }
  | { eligible: false; reason: ProjectionIneligibilityReason };

/**
 * The complete lifecycle → public-state mapping.
 *
 * `ENDED` is projectable so an already-published Offer can be shown to have
 * closed; producing that projection is **not** publishing, superseding, or
 * revoking it, and this phase does none of those.
 */
export function evaluateOfferProjectionEligibility(input: {
  lifecycle: OfferLifecycleState;
  availability: OfferAvailability;
}): OfferProjectionEligibility {
  switch (input.lifecycle) {
    case "DRAFT":
      return { eligible: false, reason: "DRAFT_NOT_PUBLIC" };
    case "SUSPENDED":
      return { eligible: false, reason: "SUSPENDED_PUBLICATION_DEFERRED" };
    case "WITHDRAWN":
      return { eligible: false, reason: "WITHDRAWN_PUBLICATION_DEFERRED" };
    case "ENDED":
      return { eligible: true, commercialState: "ENDED" };
    case "ACTIVE":
      return {
        eligible: true,
        commercialState:
          input.availability === "AVAILABLE" ? "AVAILABLE" : "TEMPORARILY_UNAVAILABLE",
      };
  }
}

// — Projection context —

/**
 * The capsulization-side bindings the projection needs, and the proof that they
 * belong to this source version.
 *
 * Each binding pairs the **public** identifier with the **internal** identifier
 * it stands for. The internal half exists so the mapper can refuse a mismatched
 * pairing; it is validation input and never reaches the capsule.
 */
export const OfferNodeBinding = z.strictObject({
  /** Registrar-issued Node for this Offer. Never derived from `mon:offer:`. */
  offerNode: AnsNodeId,
  /** The internal Offer this Node stands for — checked, then discarded. */
  internalOfferId: InternalOfferId,
});

export const ProductNodeBinding = z.strictObject({
  productNode: AnsNodeId,
  internalProductId: InternalProductId,
});

export const AuthorityNodeBinding = z.strictObject({
  /** The approved public Seller/Creator authority Node. */
  authorityNode: AnsNodeId,
  /** The transactional participant it stands for — checked, then discarded. */
  sellerParticipantId: MarketplaceParticipantId,
});

/** Names the exact source version this projection is for. */
export const SourceVersionBinding = z.strictObject({
  offerSourceRecordId: OfferSourceRecordId,
  sourceRecordVersion: OfferSourceRecordVersion,
});

export const OfferProjectionContext = z.strictObject({
  offerBinding: OfferNodeBinding,
  productBinding: ProductNodeBinding,
  authorityBinding: AuthorityNodeBinding,
  sourceVersionBinding: SourceVersionBinding,
  /** The capsule-version identity, issued elsewhere; this phase issues nothing. */
  capsuleId: CapsuleId,
  /** Semantic version of this capsule. */
  capsuleVersion: SemVer,
  /** The recorded projection-mapping version. Stamped into provenance. */
  mappingVersion: z.string().min(1).max(64),
  /** Explicit generation instant. There is no default and no clock read. */
  generatedAt: z.iso.datetime(),
  nodePolicy: PolicyRef,
  capsulePolicy: PolicyRef,
});
export type OfferProjectionContext = z.infer<typeof OfferProjectionContext>;

// — Errors —

export const OFFER_PROJECTION_ERROR_CODES = [
  "INVALID_SOURCE_VERSION",
  "INVALID_PROJECTION_CONTEXT",
  "SOURCE_VERSION_BINDING_MISMATCH",
  "OFFER_BINDING_MISMATCH",
  "PRODUCT_BINDING_MISMATCH",
  "AUTHORITY_BINDING_MISMATCH",
  "NOT_PROJECTION_ELIGIBLE",
  "INVALID_PROJECTION_OUTPUT",
  /** A pre-correction major version cannot carry corrected economic semantics. */
  "STALE_CAPSULE_MAJOR_VERSION",
  /** A capsule version this mapper does not know how to produce. */
  "UNSUPPORTED_CAPSULE_VERSION",
  /** A mapping version other than the one this mapper implements. */
  "UNSUPPORTED_MAPPING_VERSION",
] as const;
export type OfferProjectionErrorCode = (typeof OFFER_PROJECTION_ERROR_CODES)[number];

/**
 * A bounded failure. Carries a code and, for ineligibility, the bounded reason —
 * never a source value, an internal identifier, or a raw validation dump.
 */
export class OfferProjectionError extends Error {
  readonly code: OfferProjectionErrorCode;
  readonly reason?: ProjectionIneligibilityReason;

  constructor(code: OfferProjectionErrorCode, reason?: ProjectionIneligibilityReason) {
    super(reason ? `${code}: ${reason}` : code);
    this.name = "OfferProjectionError";
    this.code = code;
    this.reason = reason;
  }
}

// — Mapping —

/** The method recorded in provenance: this capsule is a projection of a version. */
export const OFFER_PROJECTION_METHOD = "governed-source-version-projection" as const;

/**
 * The Offer capsule major version the corrected economic semantics live at.
 *
 * Phase 0M.2C is a breaking change: a consumer reading `priceMinorUnits` as "what
 * a buyer pays" and one reading `wholesalePriceMinorUnits` as "what the creator
 * is owed" cannot both be right, so `1.x` may not be reused.
 *
 * No Offer persistence or production publication exists, so **no migration or
 * republishing operation is performed** — nothing has been published under the
 * old semantics to migrate.
 */
export const CORRECTED_OFFER_CAPSULE_MAJOR = 2;

/**
 * The exact capsule version this mapper emits and accepts.
 *
 * Pinned rather than treated as a floor: a future `2.1.0` would carry claims this
 * mapper does not know how to produce, and accepting it implicitly would let a
 * caller label output as a shape it is not. A later minor is an explicit,
 * reviewed change here — never a silent one.
 */
export const SUPPORTED_OFFER_CAPSULE_VERSION = "2.0.0" as const;

/**
 * The projection mapping version for the corrected economics.
 *
 * Replaced rather than incremented in place, so a stored mapping version can
 * never be mistaken for the pre-correction mapping.
 */
export const OFFER_PROJECTION_MAPPING_VERSION = "offer-projection/2.0.0" as const;

function buildProvenance(
  source: OfferSourceVersion,
  context: OfferProjectionContext,
): ProvenanceRecord {
  return {
    source: `${source.sourceSystem}:${source.sourceRecordType}:${source.offerSourceRecordId}@${source.sourceRecordVersion}`,
    method: OFFER_PROJECTION_METHOD,
    /* The instant the authoritative fact was recorded — represented, not created.
       The capsule does not claim to have established it. */
    acquiredAt: source.recordedAt,
    assertionKind: "Asserted",
    sourceClass: source.sourceClass,
    sourceSystem: source.sourceSystem,
    sourceRecordType: source.sourceRecordType,
    sourceRecordId: source.offerSourceRecordId,
    sourceRecordVersion: source.sourceRecordVersion,
    generatedAt: context.generatedAt,
    generatorVersion: context.mappingVersion,
  };
}

/** Source wholesale price → public wholesale price. Nothing is reinterpreted. */
function mapPrice(source: OfferSourceVersion): PublicOfferPrice {
  const price = source.terms.price;
  return price.type === "FREE"
    ? { priceType: "FREE" }
    : {
        priceType: "PAID",
        wholesalePriceMinorUnits: price.wholesalePriceMinorUnits,
        wholesalePriceCurrency: price.wholesalePriceCurrency,
      };
}

/**
 * Source promotion → public commission, including the **exact calculated amount**.
 *
 * The amount is recomputed from the source terms by the authoritative calculator
 * rather than copied from the version's stored snapshot: the two are required to
 * be equal (the source schema refuses a mismatch), and recomputing means a
 * projection can never publish an amount the calculator would not produce.
 *
 * A fixed commission's currency is taken **directly from the source commission** —
 * not from the wholesale price, and never inferred or normalized. Copying from
 * the price would paper over a source that somehow disagreed, which is exactly
 * the failure worth surfacing.
 */
function mapCommission(source: OfferSourceVersion): PublicOfferCommission | undefined {
  const promotion = source.terms.promotion;
  if (promotion.type !== "PROMOTABLE") return undefined;
  const commission = promotion.commission;
  const { calculatedCommissionMinorUnits } = calculateOfferEconomics(source.terms);

  return commission.method === "PERCENT_OF_WHOLESALE"
    ? {
        commissionMethod: "PERCENT_OF_WHOLESALE",
        commissionBasisPoints: commission.commissionBasisPoints,
        calculatedCommissionMinorUnits,
      }
    : {
        commissionMethod: "FIXED_AMOUNT",
        fixedCommissionMinorUnits: commission.fixedCommissionMinorUnits,
        fixedCommissionCurrency: commission.fixedCommissionCurrency,
        calculatedCommissionMinorUnits,
      };
}

/**
 * Project one identified source version into a public capsule.
 *
 * Order matters, and each step fails closed: validate the source version,
 * validate the context, prove every binding, check eligibility, map, hash,
 * re-validate the output. The output validation is not belt-and-braces — it is
 * what guarantees no internal identifier reached the capsule through a field that
 * accepts strings.
 */
export function projectOfferCapsule(input: {
  sourceVersion: OfferSourceVersion;
  context: OfferProjectionContext;
}): OfferCapsuleProjection {
  const sourceParsed = OfferSourceVersion.safeParse(input.sourceVersion);
  if (!sourceParsed.success) throw new OfferProjectionError("INVALID_SOURCE_VERSION");
  const source = sourceParsed.data;

  const contextParsed = OfferProjectionContext.safeParse(input.context);
  if (!contextParsed.success) throw new OfferProjectionError("INVALID_PROJECTION_CONTEXT");
  const context = contextParsed.data;

  /* The context must be for THIS source version — not for the Offer in general,
     and certainly not for whatever the current record happens to say. */
  if (
    context.sourceVersionBinding.offerSourceRecordId !== source.offerSourceRecordId ||
    context.sourceVersionBinding.sourceRecordVersion !== source.sourceRecordVersion
  ) {
    throw new OfferProjectionError("SOURCE_VERSION_BINDING_MISMATCH");
  }
  if (context.offerBinding.internalOfferId !== source.internalOfferId) {
    throw new OfferProjectionError("OFFER_BINDING_MISMATCH");
  }
  if (context.productBinding.internalProductId !== source.internalProductId) {
    throw new OfferProjectionError("PRODUCT_BINDING_MISMATCH");
  }
  if (context.authorityBinding.sellerParticipantId !== source.sellerParticipantId) {
    throw new OfferProjectionError("AUTHORITY_BINDING_MISMATCH");
  }

  /* The corrected shape may not be published under a pre-correction major
     version — the same number would mean two different economic things — nor
     under a future version whose claims this mapper cannot produce. */
  const major = Number(context.capsuleVersion.split(".")[0]);
  if (major < CORRECTED_OFFER_CAPSULE_MAJOR) {
    throw new OfferProjectionError("STALE_CAPSULE_MAJOR_VERSION");
  }
  if (context.capsuleVersion !== SUPPORTED_OFFER_CAPSULE_VERSION) {
    throw new OfferProjectionError("UNSUPPORTED_CAPSULE_VERSION");
  }
  if (context.mappingVersion !== OFFER_PROJECTION_MAPPING_VERSION) {
    throw new OfferProjectionError("UNSUPPORTED_MAPPING_VERSION");
  }

  const eligibility = evaluateOfferProjectionEligibility({
    lifecycle: source.lifecycle,
    availability: source.availability,
  });
  if (!eligibility.eligible) {
    throw new OfferProjectionError("NOT_PROJECTION_ELIGIBLE", eligibility.reason);
  }

  const commission = mapCommission(source);
  const interval = source.effectiveInterval;

  const data: OfferCapsuleData = {
    commercialState: eligibility.commercialState,
    price: mapPrice(source),
    promotable: source.terms.promotion.type === "PROMOTABLE",
    ...(commission !== undefined ? { commission } : {}),
    /* One canonical public absence: a bound the source does not hold is an
       omitted key, never `null`. The source already has exactly one
       representation of "no interval", so this mapping is total. */
    ...(interval?.startsAt != null ? { validFrom: interval.startsAt } : {}),
    ...(interval?.endsAt != null ? { validThrough: interval.endsAt } : {}),
    relationships: {
      itemOffered: context.productBinding.productNode,
      offeredBy: context.authorityBinding.authorityNode,
    },
  };

  const draft = {
    "@context": [COMMERCE_CONTEXT_REF, AN_O_CONTEXT_REF],
    "@type": OFFER_TYPE,
    metadata: {
      capsuleId: context.capsuleId,
      bindsToNode: context.offerBinding.offerNode,
      version: context.capsuleVersion,
      provenance: buildProvenance(source, context),
      nodePolicy: context.nodePolicy,
      capsulePolicy: context.capsulePolicy,
    },
    data,
  };

  const hashed = withPublishedContentHash(draft);
  const result = OfferCapsuleProjection.safeParse(hashed);
  if (!result.success) throw new OfferProjectionError("INVALID_PROJECTION_OUTPUT");
  return result.data;
}
