/**
 * Persisted Offer records (Phase 0M.6).
 *
 * The record shapes behind the 0M.2A source model. `offer-source.ts` says what
 * an Offer *is* and who may change it; this module says what a caller supplies
 * to create one or to mint a new immutable version of one.
 *
 * Four properties shape everything below:
 *
 *   1. **The database is the sole source of truth** (ADR §12). Every field here
 *      is authoritative transactional state. The capsule projection reads from
 *      it one way and writes nothing back.
 *
 *   2. **This module adds no Offer fact.** Every persisted field maps
 *      one-to-one onto an `OfferSourceVersion` member, so a stored row
 *      round-trips exactly into the contract `projectOfferCapsule` already
 *      consumes. Persistence must not widen the source model, and it does not
 *      introduce a single new economic quantity.
 *
 *   3. **Product authority is supplied, never derived.** 0M.2A is explicit that
 *      authority over a Product is the Product model's question, and that
 *      re-deriving it inside an Offer decision would put two answers in the
 *      repository that could disagree. There is no field here from which it
 *      could be inferred.
 *
 *   4. **Economics are computed, never supplied.** A caller states commercial
 *      *terms*; the deterministic 0M.2C calculator produces the commission and
 *      gross proceeds. Accepting them as input would let a caller persist
 *      numbers the calculator never produced.
 *
 * Pure data. No database, clock, environment read, randomness, or network. Not
 * exported through the browser-facing barrel.
 */

import { z } from "zod";
import { ACTOR_ID_RE } from "../capsule/identity";
import { MarketplaceParticipantId } from "./participant";
import {
  CreatorEconomicsConfirmation,
  InternalOfferId,
  InternalProductId,
  OfferAvailability,
  OfferCommercialTerms,
  OfferEffectiveIntervalField,
  OfferLifecycleState,
  OfferSourceRecordVersion,
} from "./offer-source";

const AuthorizingActorId = z
  .string()
  .regex(ACTOR_ID_RE, "authorizedByActorId must be mon:actor:<opaque>");

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
 * Create one draft Offer and its first immutable source version.
 *
 * The first version is always `DRAFT` and `AVAILABLE`, and neither is a caller
 * choice: 0M.2A's lifecycle starts at `DRAFT`, and availability is a modifier on
 * a live Offer rather than a way to pre-stand-down one that was never live.
 * Taking an Offer live is a separate, separately authorized act.
 *
 * `effectiveInterval` is optional here and canonicalized by the service through
 * `normalizeOfferEffectiveIntervalInput`, so the several convenient spellings of
 * "no interval" all fold to the single canonical `null`.
 */
export const CreateDraftOfferInput = z.strictObject({
  internalProductId: InternalProductId,
  /** The participant that will hold Seller authority over this Offer. */
  sellerParticipantId: MarketplaceParticipantId,

  /** Wholesale price and promotion together — validated as a unit by 0M.2A. */
  terms: OfferCommercialTerms,

  /** Either bound, both, or absent. Absent and bounds-less both mean "none". */
  effectiveInterval: z
    .strictObject({
      startsAt: z.iso.datetime().nullable().optional(),
      endsAt: z.iso.datetime().nullable().optional(),
    })
    .nullable()
    .optional(),

  /** The account acting, and the opaque human actor within it. */
  actingAccountId: ActingAccountId,
  authorizedByActorId: AuthorizingActorId,

  /**
   * Whether the acting subject holds authority over the referenced Product.
   *
   * **Supplied, never derived** — 0M.2A states this explicitly, and deriving it
   * here would create a second answer to a question the Product model owns.
   */
  hasProductAuthority: z.boolean(),

  /** Explicit instants. Nothing here reads a clock. */
  now: z.iso.datetime(),
});
export type CreateDraftOfferInput = z.infer<typeof CreateDraftOfferInput>;

// — Update —

/**
 * A material update, minting a new immutable source version.
 *
 * Every business member is optional: a caller states only what changes, and the
 * service compares the result against the current version using 0M.2A's own
 * `materialChangesBetween`. An update that changes nothing material mints no
 * version — a version asserting nothing would be history noise.
 *
 * `sourceRecordVersion` is supplied rather than generated, matching the Product
 * and Storefront convention: the version label is a caller-controlled identity,
 * and a service that invented one would make two concurrent writers agree by
 * accident.
 *
 * `economicsConfirmation` carries the creator's confirmation of the exact
 * version's economics, required by 0M.2A when an Offer goes live. It binds to
 * both halves of the identity, so a confirmation cannot survive a repricing.
 */
export const UpdateOfferInput = z.strictObject({
  internalOfferId: InternalOfferId,
  /** The new immutable version's label. Must not already exist. */
  sourceRecordVersion: OfferSourceRecordVersion,

  /** Only the members a caller intends to change. */
  terms: OfferCommercialTerms.optional(),
  lifecycle: OfferLifecycleState.optional(),
  availability: OfferAvailability.optional(),
  /** `null` clears the interval; omitted leaves it unchanged. */
  effectiveInterval: OfferEffectiveIntervalField.optional(),

  actingAccountId: ActingAccountId,
  authorizedByActorId: AuthorizingActorId,
  hasProductAuthority: z.boolean(),

  /**
   * The creator's confirmation of this version's economics. Required to
   * activate; ignored by every action that stands an Offer *down*, because
   * suspending or ending asserts nothing about economics.
   */
  economicsConfirmation: CreatorEconomicsConfirmation.nullable().optional(),

  now: z.iso.datetime(),
});
export type UpdateOfferInput = z.infer<typeof UpdateOfferInput>;

// — Privacy —

/**
 * Field names that must never appear on a persisted Offer record.
 *
 * Every schema above is a `strictObject`, so an unknown key already fails. This
 * list makes the intent explicit and gives a test something to enumerate — the
 * same belt-and-braces pattern the participant, Storefront, and Listing models
 * use, and equally not the primary control.
 *
 * The economic entries deserve their own note. `promoterRetailPrice`,
 * `promoterSpread`, `monacadoRetainedAmount`, and
 * `wholesaleAcquisitionAmount` are not private data — they are **other layers'
 * facts**. Retail price belongs to a Listing, and Monacado's retention belongs
 * to the MoR policy 0M.R supplies. Persisting either here would make the Offer
 * assert a number its authority never agreed to.
 */
export const NEVER_ON_OFFER_RECORD = [
  // Other layers' economics — not private, but not the Offer's to assert
  "promoterRetailPrice",
  "retailPrice",
  "promoterSpread",
  "promoterMargin",
  "monacadoRetainedAmount",
  "wholesaleAcquisitionAmount",
  "wholesaleAcquisitionPolicyId",
  "minimumViablePrice",
  "platformFee",
  "processingFee",
  "internalCost",
  "internalMargin",
  // Sales that happened, rather than terms on offer
  "earnedCommission",
  "orderData",
  "checkoutData",
  "paymentData",
  "refundData",
  "chargebackData",
  "settlementData",
  "payoutData",
  "payoutHold",
  // Tax and shipping — outside every commission basis (0M.2C, 0M.4A)
  "checkoutTax",
  "taxAmount",
  "taxEvidence",
  "shippingAmount",
  "shippingConstraints",
  // Credentials and private identity
  "accountId",
  "email",
  "passwordHash",
  "sessionToken",
  "participantProfile",
  "legalName",
  "address",
  "taxId",
  // Payment, risk, underwriting, card networks
  "paymentProviderToken",
  "stripeAccountId",
  "payoutCredentials",
  "bankingData",
  "underwritingData",
  "riskScore",
  "riskClassification",
  "cardNetworkData",
  // Buyer
  "buyerId",
  "buyerIdentity",
  "purchaseEvidence",
  // Capsule / publication machinery (ADR §12.2 — a capsulization control here
  // would put a projection-layer field inside transactional truth)
  "capsuleId",
  "nodeId",
  "offerNode",
  "bindsToNode",
  "mappingVersion",
  "publicationState",
  "contentHash",
  "sourceRetentionState",
] as const;

/** Named as deferred, and not admissible through a metadata bag. */
export const DEFERRED_OFFER_PERSISTENCE_EXTENSIONS = [
  "offerNode",
  "nodeIssuance",
  "publicationState",
  "outbox",
  "receipt",
  "listingPersistence",
  "listingBinding",
  "paymentOnboarding",
  "riskPolicy",
  "taxTreatment",
  "settlementLedger",
] as const;
