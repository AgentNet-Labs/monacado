/**
 * Authoritative Offer source model (Phase 0M.2A).
 *
 * The **authoritative transactional record** for creator-authorized commercial
 * terms, plus the immutable source versions a later Capsule Projection Shape will
 * be generated *from*. This is business truth, not a published artifact.
 *
 * Five properties shape everything below:
 *
 *   1. **The database is the sole source of truth** (ADR §12). Every field here
 *      is authoritative. A capsule never supplies data to this record, never
 *      repairs it, and never overrides it — projection runs one way, and this is
 *      the end it starts from.
 *
 *   2. **No projection machinery lives here.** There is no capsule shape, no
 *      JSON-LD, no Node or capsule identity, no projection mapping, no
 *      canonicalization, no hash, and no publication field. Those belong to
 *      0M.2B and the publication track; putting a `mappingVersion` here would put
 *      a capsulization-layer control inside transactional truth.
 *
 *   3. **Authority is transactional.** An Offer is controlled by a marketplace
 *      participant holding Seller authority — `sellerParticipantId`, an internal
 *      operational identity. No Creator Node or other public semantic identity
 *      appears in this phase; that mapping is deliberately unresolved.
 *
 *   4. **Every material change makes a new immutable version.** Publication
 *      retries, worker leases, receipts, archive location, caches, and monitoring
 *      counters are not business changes and create no semantic version.
 *
 *   5. **Category-neutral, and closed.** Inventory, variants, territory, tax,
 *      shipping, subscriptions, and licensing are named as deferred rather than
 *      admitted through an arbitrary metadata bag. Every schema is strict, so
 *      none of them can arrive early by accident.
 *
 * Pure data and pure decisions. No database, clock, environment read,
 * randomness, or network. Not exported through the browser-facing barrel.
 */

import { z } from "zod";
import { ACTOR_ID_RE, INTERNAL_PRODUCT_ID_RE, SOURCE_RECORD_ID_RE } from "../capsule/identity";
import { canonicalJsonString } from "../integrity/canonical-json";
import { INTERNAL_OFFER_ID_RE } from "./identity";
import { CapabilityReasonCode } from "./capability";
import {
  DRAFTING_ROLE_STATUSES,
  MarketplaceParticipantId,
  MarketplaceSubject,
  findRoleAssignment,
  permitsDrafting,
} from "./participant";

// — Identity —

/**
 * The Offer's source-record identity, in the **existing** `mon:srec:<opaque>`
 * form. Deliberately the same convention as the Product source record: one
 * source-record identity scheme, not a second one invented per entity.
 */
export const OfferSourceRecordId = z
  .string()
  .regex(SOURCE_RECORD_ID_RE, "offerSourceRecordId must be opaque (mon:srec:<opaque>)");
export type OfferSourceRecordId = z.infer<typeof OfferSourceRecordId>;

/** The enduring internal Offer identity. Never an ANS Node or capsule ID. */
export const InternalOfferId = z
  .string()
  .regex(INTERNAL_OFFER_ID_RE, "internalOfferId must be opaque (mon:offer:<opaque>)");
export type InternalOfferId = z.infer<typeof InternalOfferId>;

/** The authoritative Product this Offer is for — internal identity, not a Node. */
export const InternalProductId = z
  .string()
  .regex(INTERNAL_PRODUCT_ID_RE, "internalProductId must be opaque (mon:product:<opaque>)");
export type InternalProductId = z.infer<typeof InternalProductId>;

/**
 * Who performed the authorized source action. Opaque by construction — an email,
 * display name, or other private profile datum must never be recorded here.
 */
export const AuthorizingActorId = z
  .string()
  .regex(ACTOR_ID_RE, "authorizedByActorId must be opaque (mon:actor:<opaque>)");
export type AuthorizingActorId = z.infer<typeof AuthorizingActorId>;

/**
 * A source-version label, in the Product source record's existing form: a bounded
 * string, matching the `VarChar(64)` the source-version table already uses.
 */
export const OfferSourceRecordVersion = z.string().min(1).max(64);
export type OfferSourceRecordVersion = z.infer<typeof OfferSourceRecordVersion>;

// — Operational lifecycle —

/**
 * The Offer's own operational lifecycle.
 *
 * Separate from commercial availability, from publication state, from Node state,
 * and from source-version retention state. Four different questions; four
 * vocabularies that share no member.
 */
export const OFFER_LIFECYCLE_STATES = [
  "DRAFT",
  "ACTIVE",
  "SUSPENDED",
  "ENDED",
  "WITHDRAWN",
] as const;
export const OfferLifecycleState = z.enum(OFFER_LIFECYCLE_STATES);
export type OfferLifecycleState = z.infer<typeof OfferLifecycleState>;

/**
 * Permitted lifecycle transitions.
 *
 * `ENDED` and `WITHDRAWN` are terminal. An Offer that ended and must sell again is
 * a **new Offer** — reviving a terminal one would silently reattach a new
 * commercial commitment to a record buyers already saw close.
 */
export const OFFER_LIFECYCLE_TRANSITIONS: Record<
  OfferLifecycleState,
  readonly OfferLifecycleState[]
> = Object.freeze({
  DRAFT: ["ACTIVE", "WITHDRAWN"],
  ACTIVE: ["SUSPENDED", "ENDED", "WITHDRAWN"],
  SUSPENDED: ["ACTIVE", "ENDED", "WITHDRAWN"],
  ENDED: [],
  WITHDRAWN: [],
});

/** The only state an Offer may be created in. */
export const INITIAL_OFFER_LIFECYCLE_STATE: OfferLifecycleState = "DRAFT";

export function isValidOfferLifecycleTransition(
  from: OfferLifecycleState,
  to: OfferLifecycleState,
): boolean {
  return OFFER_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function isTerminalOfferLifecycleState(state: OfferLifecycleState): boolean {
  return OFFER_LIFECYCLE_TRANSITIONS[state].length === 0;
}

// — Commercial availability —

/**
 * Whether an otherwise ACTIVE Offer may presently be selected commercially.
 *
 * This is **not** inventory quantity, variants, publication status, or an
 * internal workflow step. It answers one question — "can a buyer choose this
 * right now" — for an Offer that is already live.
 */
export const OFFER_AVAILABILITY_STATES = ["AVAILABLE", "TEMPORARILY_UNAVAILABLE"] as const;
export const OfferAvailability = z.enum(OFFER_AVAILABILITY_STATES);
export type OfferAvailability = z.infer<typeof OfferAvailability>;

/**
 * Commercial selectability, derived from both axes and never stored.
 *
 * Only `ACTIVE` + `AVAILABLE` selects. A `DRAFT`, `SUSPENDED`, `ENDED`, or
 * `WITHDRAWN` Offer is unselectable **whatever the availability field says** —
 * availability is a modifier on a live Offer, never a way to make a dead one
 * live.
 */
export function isCommerciallySelectable(input: {
  lifecycle: OfferLifecycleState;
  availability: OfferAvailability;
}): boolean {
  return input.lifecycle === "ACTIVE" && input.availability === "AVAILABLE";
}

// — Price terms —

/**
 * A structural currency code: three uppercase letters.
 *
 * **This is not ISO 4217 registry validation**, and must not be described as
 * such. The repository holds no maintained currency registry, and inventing a
 * frozen list here would be wrong within a year. Full registry validation —
 * including which currencies Monacado actually supports, and their minor-unit
 * exponents — is a future service concern (see the architecture document).
 */
export const CurrencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, "currency must be three uppercase letters (structural check only)");
export type CurrencyCode = z.infer<typeof CurrencyCode>;

/**
 * Money, in **minor units only**.
 *
 * `z.int()` rejects `9.99` outright. Floating-point money is a rounding bug that
 * shows up in settlement months later, so the type system refuses it here rather
 * than the ledger discovering it.
 */
export const MinorUnitAmount = z
  .int()
  .positive("amount must be a positive integer in minor currency units");

export const FreeOfferPrice = z.strictObject({
  type: z.literal("FREE"),
});

export const PaidOfferPrice = z.strictObject({
  type: z.literal("PAID"),
  amountMinorUnits: MinorUnitAmount,
  currency: CurrencyCode,
});

/**
 * A discriminated union, so a FREE Offer has **no field** for an amount or a
 * currency. Absence by construction: a free Offer cannot carry a stray price
 * because there is nowhere to put one.
 */
export const OfferPrice = z.discriminatedUnion("type", [FreeOfferPrice, PaidOfferPrice]);
export type OfferPrice = z.infer<typeof OfferPrice>;

// — Promotion and commission —

/** Basis points: 1 = 0.01%, 10 000 = 100%. */
export const MIN_COMMISSION_BASIS_POINTS = 1;
export const MAX_COMMISSION_BASIS_POINTS = 10_000;

export const PercentageCommission = z.strictObject({
  kind: z.literal("PERCENTAGE"),
  basisPoints: z
    .int()
    .min(MIN_COMMISSION_BASIS_POINTS, "commission must be greater than 0 basis points")
    .max(MAX_COMMISSION_BASIS_POINTS, "commission may not exceed 10,000 basis points"),
});

export const FixedCommission = z.strictObject({
  kind: z.literal("FIXED"),
  amountMinorUnits: MinorUnitAmount,
  currency: CurrencyCode,
});

export const OfferCommission = z.discriminatedUnion("kind", [PercentageCommission, FixedCommission]);
export type OfferCommission = z.infer<typeof OfferCommission>;

export const NotPromotable = z.strictObject({
  type: z.literal("NOT_PROMOTABLE"),
});

export const Promotable = z.strictObject({
  type: z.literal("PROMOTABLE"),
  /** Seller-controlled. A promoter selects an Offer; it never sets these terms. */
  commission: OfferCommission,
});

export const OfferPromotion = z.discriminatedUnion("type", [NotPromotable, Promotable]);
export type OfferPromotion = z.infer<typeof OfferPromotion>;

// — Commercial terms (price and promotion together) —

/**
 * Price and promotion in one object, because the rules that bind them are
 * cross-field and must be validated together rather than trusted to a caller.
 *
 * Refused combinations, each for a stated reason:
 *   - **PROMOTABLE on a FREE Offer** — there is no sale proceeds to pay a
 *     commission from. Non-monetary referral incentives are deferred, not
 *     smuggled in as a commission on nothing.
 *   - **Fixed commission in a different currency than the Offer** — a cross-rate
 *     the Offer never agreed to.
 *   - **Fixed commission exceeding the price** — a sale that pays out more than
 *     it takes in.
 *
 * Earned commissions, attribution, settlement, and payouts are **not** here.
 * Those are financial records (relational-first, ADR §1) about sales that
 * happened; this is the standing term a seller offers.
 */
export const OfferCommercialTerms = z
  .strictObject({
    price: OfferPrice,
    promotion: OfferPromotion,
  })
  .superRefine((terms, ctx) => {
    if (terms.promotion.type !== "PROMOTABLE") return;

    if (terms.price.type === "FREE") {
      ctx.addIssue({
        code: "custom",
        path: ["promotion", "type"],
        message: "a FREE Offer must be NOT_PROMOTABLE; a paid commission requires a PAID Offer",
      });
      return;
    }

    const commission = terms.promotion.commission;
    if (commission.kind !== "FIXED") return;

    if (commission.currency !== terms.price.currency) {
      ctx.addIssue({
        code: "custom",
        path: ["promotion", "commission", "currency"],
        message: "a fixed commission must be in the same currency as the Offer price",
      });
    }
    if (commission.amountMinorUnits > terms.price.amountMinorUnits) {
      ctx.addIssue({
        code: "custom",
        path: ["promotion", "commission", "amountMinorUnits"],
        message: "a fixed commission must not exceed the Offer price",
      });
    }
  });
export type OfferCommercialTerms = z.infer<typeof OfferCommercialTerms>;

// — Effective interval —

/**
 * When the Offer's terms are intended to apply.
 *
 * Either bound may be absent, expressed as explicit `null` — matching the
 * nullable columns a persistence phase will use, so the authoritative snapshot
 * and the eventual row agree without a translation step.
 *
 * **There is exactly one representation of "no interval at all".** An interval
 * object with both bounds null is refused, because `null` (no interval) and
 * `{ startsAt: null, endsAt: null }` would otherwise be two authoritative
 * snapshots of the same fact — and two snapshots of one fact means a spurious
 * material change, a spurious source version, and a diff that cannot decide
 * whether anything happened. Use `normalizeOfferEffectiveIntervalInput` to fold
 * a convenient input into the canonical form.
 *
 * Every instant is an explicit caller-supplied UTC value — `z.iso.datetime()`
 * accepts only a `Z`-suffixed instant, and **nothing here reads a clock**. An
 * interval that has passed does **not** move the lifecycle on its own: expiry is
 * a governed transition someone performs, not a state the data drifts into while
 * nobody is looking.
 */
export const OfferEffectiveInterval = z
  .strictObject({
    startsAt: z.iso.datetime().nullable(),
    endsAt: z.iso.datetime().nullable(),
  })
  .refine((i) => i.startsAt !== null || i.endsAt !== null, {
    message:
      "an interval with no bounds is not an interval; use null for 'no effective interval'",
  })
  .refine(
    (i) => i.startsAt === null || i.endsAt === null || Date.parse(i.endsAt) > Date.parse(i.startsAt),
    { path: ["endsAt"], message: "endsAt must be later than startsAt" },
  );
export type OfferEffectiveInterval = z.infer<typeof OfferEffectiveInterval>;

/** The canonical authoritative field: an interval with at least one bound, or none. */
export const OfferEffectiveIntervalField = OfferEffectiveInterval.nullable();
export type OfferEffectiveIntervalField = z.infer<typeof OfferEffectiveIntervalField>;

/**
 * Convenience input, folded to the canonical representation.
 *
 * Accepts `undefined`, `null`, a bounds-less object, or an object with either
 * bound omitted — and returns exactly one canonical value for each. Convenience
 * lives here, at the edge, so that **the authoritative schema stays strict**:
 * normalizing inside the record schema would let two spellings of the same fact
 * both be "valid input", which is how two representations creep back in.
 */
export function normalizeOfferEffectiveIntervalInput(
  input:
    | { startsAt?: string | null; endsAt?: string | null }
    | null
    | undefined,
): OfferEffectiveIntervalField {
  if (input === null || input === undefined) return null;
  const startsAt = input.startsAt ?? null;
  const endsAt = input.endsAt ?? null;
  if (startsAt === null && endsAt === null) return null;
  return OfferEffectiveInterval.parse({ startsAt, endsAt });
}

// — The authoritative current Offer record —

/**
 * The current authoritative truth about one Offer.
 *
 * Enumerated field by field and strict. There is no field for inventory,
 * variants, territory, tax, shipping, discounts, licensing, internal cost or
 * margin, platform fees, earned commission, order or payment data, publication
 * state, Node identity, capsule identity, retention state, or a metadata bag —
 * so none of them can arrive without a phase that decides to add it.
 */
export const OfferSourceRecord = z.strictObject({
  // Identity
  offerSourceRecordId: OfferSourceRecordId,
  internalOfferId: InternalOfferId,
  /** The latest immutable source version; the pointer into version history. */
  currentSourceRecordVersion: OfferSourceRecordVersion,

  // Authoritative references
  internalProductId: InternalProductId,
  /**
   * The participant holding Seller authority over this Offer. A transactional
   * identity — **not** a Creator Node and not any public semantic identity.
   */
  sellerParticipantId: MarketplaceParticipantId,

  // Source-system identity (the Product source record's existing convention)
  sourceSystem: z.literal("monacado"),
  sourceRecordType: z.literal("Offer"),
  sourceClass: z.literal("governed-database-record"),

  // Business state
  lifecycle: OfferLifecycleState,
  availability: OfferAvailability,
  terms: OfferCommercialTerms,
  effectiveInterval: OfferEffectiveIntervalField,

  // Record control — explicit instants, never read from a clock here
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type OfferSourceRecord = z.infer<typeof OfferSourceRecord>;

// — The immutable source version —

/**
 * One complete, immutable snapshot of an Offer's material business state.
 *
 * Carries **all** material fields, not a delta: a snapshot that had to be
 * replayed through its predecessors to be understood would make deterministic
 * reconstruction depend on an unbroken chain, and one missing link would lose
 * every version after it (Phase 0A.2 §4).
 *
 * Deliberately absent: `mappingVersion`, capsule semver, Node ID, capsule ID,
 * Registrar or receipt fields, publication state, and retention state. A
 * projection mapping is a capsulization-layer control (ADR §12.2), and this is
 * the transactional layer.
 */
export const OfferSourceVersion = z.strictObject({
  // Identity and lineage
  offerSourceRecordId: OfferSourceRecordId,
  sourceRecordVersion: OfferSourceRecordVersion,
  /** The version this one replaces; `null` for the first. */
  supersedesSourceRecordVersion: OfferSourceRecordVersion.nullable(),
  internalOfferId: InternalOfferId,

  // Source-system identity
  sourceSystem: z.literal("monacado"),
  sourceRecordType: z.literal("Offer"),
  sourceClass: z.literal("governed-database-record"),

  // The complete material snapshot
  internalProductId: InternalProductId,
  sellerParticipantId: MarketplaceParticipantId,
  lifecycle: OfferLifecycleState,
  availability: OfferAvailability,
  terms: OfferCommercialTerms,
  effectiveInterval: OfferEffectiveIntervalField,

  // Authorization trace — who authorized this change, and when it was recorded
  authorizedBySellerParticipantId: MarketplaceParticipantId,
  authorizedByActorId: AuthorizingActorId,
  recordedAt: z.iso.datetime(),
});
export type OfferSourceVersion = z.infer<typeof OfferSourceVersion>;

// — Material versus operational change classification —

/**
 * The fields whose change **is** a change in transactional truth.
 *
 * Each one alters what a buyer would be agreeing to, who is offering it, or
 * whether it is on sale at all.
 */
export const MATERIAL_OFFER_FIELDS = [
  "internalProductId",
  "sellerParticipantId",
  "lifecycle",
  "availability",
  "price",
  "promotion",
  "commission",
  "effectiveInterval",
] as const;
export const MaterialOfferField = z.enum(MATERIAL_OFFER_FIELDS);
export type MaterialOfferField = z.infer<typeof MaterialOfferField>;

/**
 * Changes that are **publication machinery, not truth**.
 *
 * A retry counter moving does not mean the seller changed their offer. Minting a
 * semantic version for one would fill version history with events that assert
 * nothing, and make "what did this Offer say on Tuesday" unanswerable.
 */
export const OPERATIONAL_ONLY_OFFER_FIELDS = [
  "publicationRetryState",
  "workerLeaseState",
  "receiptProcessingState",
  "archiveLocation",
  "operationalCache",
  "lastReadAt",
  "monitoringCounters",
] as const;
export const OperationalOnlyOfferField = z.enum(OPERATIONAL_ONLY_OFFER_FIELDS);
export type OperationalOnlyOfferField = z.infer<typeof OperationalOnlyOfferField>;

/**
 * A closed change vocabulary. An unrecognised field name is a **validation
 * failure**, not a guess: a new field must be classified deliberately as material
 * or operational, and the alternative — defaulting — is wrong in both directions.
 */
export const OfferChangeField = z.union([MaterialOfferField, OperationalOnlyOfferField]);
export type OfferChangeField = z.infer<typeof OfferChangeField>;

export const OfferChangeSet = z.array(OfferChangeField).max(
  MATERIAL_OFFER_FIELDS.length + OPERATIONAL_ONLY_OFFER_FIELDS.length,
);

export const OfferChangeClassification = z.strictObject({
  requiresNewSourceVersion: z.boolean(),
  materialFields: z.array(MaterialOfferField),
  operationalFields: z.array(OperationalOnlyOfferField),
});
export type OfferChangeClassification = z.infer<typeof OfferChangeClassification>;

/** Does this set of changed fields require a new immutable source version? */
export function classifyOfferChange(changedFields: readonly string[]): OfferChangeClassification {
  const parsed = OfferChangeSet.parse(changedFields);
  const materialFields = parsed.filter(
    (f): f is MaterialOfferField => MaterialOfferField.safeParse(f).success,
  );
  const operationalFields = parsed.filter(
    (f): f is OperationalOnlyOfferField => OperationalOnlyOfferField.safeParse(f).success,
  );
  return {
    requiresNewSourceVersion: materialFields.length > 0,
    materialFields,
    operationalFields,
  };
}

/**
 * Which material fields actually differ between two Offer states.
 *
 * Compared by canonical serialization, so key order in a nested object never
 * registers as a change. `price`, `promotion`, and `commission` are reported
 * separately because a seller changing a commission rate and a seller changing a
 * price are different business events, even though both live under `terms`.
 */
export function materialChangesBetween(
  prior: Pick<
    OfferSourceRecord,
    | "internalProductId"
    | "sellerParticipantId"
    | "lifecycle"
    | "availability"
    | "terms"
    | "effectiveInterval"
  >,
  next: typeof prior,
): MaterialOfferField[] {
  const changed: MaterialOfferField[] = [];
  const differs = (a: unknown, b: unknown) => canonicalJsonString(a) !== canonicalJsonString(b);

  if (prior.internalProductId !== next.internalProductId) changed.push("internalProductId");
  if (prior.sellerParticipantId !== next.sellerParticipantId) changed.push("sellerParticipantId");
  if (prior.lifecycle !== next.lifecycle) changed.push("lifecycle");
  if (prior.availability !== next.availability) changed.push("availability");
  if (differs(prior.terms.price, next.terms.price)) changed.push("price");

  const priorPromotion = prior.terms.promotion;
  const nextPromotion = next.terms.promotion;
  if (priorPromotion.type !== nextPromotion.type) changed.push("promotion");
  else if (
    priorPromotion.type === "PROMOTABLE" &&
    nextPromotion.type === "PROMOTABLE" &&
    differs(priorPromotion.commission, nextPromotion.commission)
  ) {
    changed.push("commission");
  }

  if (differs(prior.effectiveInterval, next.effectiveInterval)) changed.push("effectiveInterval");
  return changed;
}

// — Projection eligibility (classification only; no projection is built here) —

/**
 * Authoritative fields a **later** projection may draw on.
 *
 * Two of these are not published as they stand: the Offer's own identity and its
 * Product reference are internal, and reach a capsule only through a
 * Registrar-issued Node mapping decided in a later phase (ADR §11.5). Listing
 * them here records what the projection is *derived from*, not what it emits.
 */
export const PROJECTION_ELIGIBLE_OFFER_FIELDS = [
  "internalOfferId",
  "internalProductId",
  "sellerParticipantId",
  "lifecycle",
  "availability",
  "price",
  "promotion",
  "commission",
  "effectiveInterval",
] as const;

/**
 * Fields and data classes that are **never** projection-eligible, in any phase.
 *
 * Most do not exist on the Offer record at all — and are enumerated anyway, so
 * that "may this be published?" has a written answer before someone is under
 * pressure to ship a projection.
 */
export const NEVER_PROJECTION_ELIGIBLE_OFFER_DATA = [
  "accountId",
  "rawParticipantId",
  "email",
  "legalIdentity",
  "privateProfile",
  "paymentProviderId",
  "bankingData",
  "taxData",
  "internalReviewNotes",
  "internalCost",
  "internalMargin",
  "platformFee",
  "processingFee",
  "earnedCommission",
  "orderData",
  "checkoutData",
  "paymentData",
  "refundData",
  "settlementData",
  "payoutData",
  "auditInternals",
  "sourceRetentionState",
] as const;

export function isProjectionEligibleOfferField(field: string): boolean {
  return (PROJECTION_ELIGIBLE_OFFER_FIELDS as readonly string[]).includes(field);
}

export function isNeverProjectionEligible(field: string): boolean {
  return (NEVER_PROJECTION_ELIGIBLE_OFFER_DATA as readonly string[]).includes(field);
}

// — Deferred extensions —

/**
 * Named as deferred, not silently omitted — and **not** admissible through a
 * metadata bag. The core Offer model stays category-neutral; each of these needs
 * a phase that decides its semantics, not a loose key.
 */
export const DEFERRED_OFFER_EXTENSIONS = [
  "discounts",
  "promotionalPriceSchedules",
  "inventoryQuantity",
  "inventoryReservations",
  "variants",
  "optionCombinations",
  "territoryEligibility",
  "taxTreatment",
  "shippingConstraints",
  "fulfillmentConstraints",
  "subscriptionTerms",
  "rentalTerms",
  "recurringBilling",
  "licenseDuration",
  "usageLimits",
  "entitlementDelivery",
  "categoryComplianceTerms",
  "nonMonetaryIncentives",
] as const;

// — Seller authority decisions —

export const OFFER_CAPABILITIES = [
  "offer:draft:create",
  "offer:activate",
  "offer:terms:change",
  "offer:suspend",
  "offer:resume",
  "offer:end",
  "offer:withdraw",
] as const;
export const OfferCapability = z.enum(OFFER_CAPABILITIES);
export type OfferCapability = z.infer<typeof OfferCapability>;

/**
 * Offer-specific denial reasons, **composed with** the Phase 0M.1 vocabulary
 * rather than restating it. Account, participant, role, and payment reasons keep
 * the codes a caller already handles.
 */
export const OFFER_SPECIFIC_REASON_CODES = [
  /** The subject's participant is not the Seller that controls this Offer. */
  "SELLER_PARTICIPANT_MISMATCH",
  /** The subject holds no authority over the referenced Product. */
  "PRODUCT_AUTHORITY_REQUIRED",
  /** The lifecycle move this capability implies is not a permitted transition. */
  "OFFER_LIFECYCLE_TRANSITION_NOT_PERMITTED",
  /** The Offer is in a terminal state; nothing further may be authorized. */
  "OFFER_LIFECYCLE_TERMINAL",
] as const;
export const OfferSpecificReasonCode = z.enum(OFFER_SPECIFIC_REASON_CODES);

export const OfferReasonCode = z.union([CapabilityReasonCode, OfferSpecificReasonCode]);
export type OfferReasonCode = z.infer<typeof OfferReasonCode>;

export const OfferAuthorityDecision = z
  .strictObject({
    capability: OfferCapability,
    decision: z.enum(["ALLOW", "DENY"]),
    reasonCodes: z.array(OfferReasonCode).max(12),
  })
  .refine(
    (d) => (d.decision === "ALLOW" ? d.reasonCodes.length === 0 : d.reasonCodes.length > 0),
    "ALLOW carries no reason codes; DENY carries at least one",
  );
export type OfferAuthorityDecision = z.infer<typeof OfferAuthorityDecision>;

function allow(capability: OfferCapability): OfferAuthorityDecision {
  return { capability, decision: "ALLOW", reasonCodes: [] };
}

function deny(capability: OfferCapability, ...reasonCodes: OfferReasonCode[]): OfferAuthorityDecision {
  return { capability, decision: "DENY", reasonCodes };
}

export function isOfferActionAllowed(decision: OfferAuthorityDecision): boolean {
  return decision.decision === "ALLOW";
}

/**
 * What an Offer authority decision may consider.
 *
 * `hasProductAuthority` is supplied rather than derived: authority over a Product
 * is the Product model's question, and re-deriving it here would put two answers
 * in the repository that could disagree.
 */
export const OfferAuthorityRequest = z.strictObject({
  subject: MarketplaceSubject,
  /** The Seller participant that controls the Offer. */
  offerSellerParticipantId: MarketplaceParticipantId,
  /** Whether the subject holds authority over the referenced Product. */
  hasProductAuthority: z.boolean(),
});
export type OfferAuthorityRequest = z.infer<typeof OfferAuthorityRequest>;

/** A request about an Offer that already exists, and therefore has a state. */
export const OfferLifecycleActionRequest = OfferAuthorityRequest.extend({
  lifecycle: OfferLifecycleState,
});
export type OfferLifecycleActionRequest = z.infer<typeof OfferLifecycleActionRequest>;

/** The subject's participant is the one that controls this Offer. */
function sellerMatches(request: OfferAuthorityRequest): boolean {
  return request.subject.participant?.participantId === request.offerSellerParticipantId;
}

/**
 * The drafting gate: an enabled account, a participant in a drafting status, and
 * a SELLER role in a drafting status.
 *
 * Reuses the Phase 0M.1 vocabularies directly rather than restating them, so a
 * change to what "drafting-eligible" means lands in one place.
 */
function draftingProblem(subject: MarketplaceSubject): CapabilityReasonCode | undefined {
  if (subject.account === null) return "ACCOUNT_REQUIRED";
  if (subject.account.status !== "ACTIVE") return "ACCOUNT_DISABLED";
  if (subject.participant === null) return "PARTICIPANT_REQUIRED";
  if (!permitsDrafting(subject.participant.status)) return "PARTICIPANT_STATUS_NOT_ELIGIBLE";
  const seller = findRoleAssignment(subject.participant, "SELLER");
  if (seller === undefined) return "ROLE_NOT_HELD";
  if (!(DRAFTING_ROLE_STATUSES as readonly string[]).includes(seller.status)) {
    return "ROLE_NOT_ACTIVE";
  }
  return undefined;
}

/**
 * The commerce gate: admitted to the marketplace **and** payable, with an active
 * SELLER role. Both axes, exactly as Phase 0M.1 requires for anything that sells.
 */
function commerceProblem(subject: MarketplaceSubject): CapabilityReasonCode | undefined {
  if (subject.account === null) return "ACCOUNT_REQUIRED";
  if (subject.account.status !== "ACTIVE") return "ACCOUNT_DISABLED";
  const participant = subject.participant;
  if (participant === null) return "PARTICIPANT_REQUIRED";
  if (participant.status !== "ACTIVE") return "PARTICIPANT_NOT_ACTIVATED";
  const seller = findRoleAssignment(participant, "SELLER");
  if (seller === undefined) return "ROLE_NOT_HELD";
  if (seller.status !== "ACTIVE") return "ROLE_NOT_ACTIVE";
  if (participant.paymentReadiness === "RESTRICTED") return "PAYMENT_RESTRICTED";
  if (participant.paymentReadiness !== "ENABLED") return "PAYMENT_NOT_ENABLED";
  return undefined;
}

/**
 * Drafting a new Offer.
 *
 * Requires authority over the referenced Product as well as the Seller drafting
 * gates. An Offer names a Product; drafting one against a Product you do not
 * control would create a record nobody is ever allowed to activate, and would
 * let one seller stage commercial terms over another's work.
 */
export function canCreateDraftOffer(request: OfferAuthorityRequest): OfferAuthorityDecision {
  const capability = "offer:draft:create" as const;
  const problem = draftingProblem(request.subject);
  if (problem) return deny(capability, problem);
  if (!sellerMatches(request)) return deny(capability, "SELLER_PARTICIPANT_MISMATCH");
  if (!request.hasProductAuthority) return deny(capability, "PRODUCT_AUTHORITY_REQUIRED");
  return allow(capability);
}

/**
 * A lifecycle-changing action: full commerce gates when the result is a live
 * Offer, matching Seller authority always, and a permitted transition.
 */
function evaluateLifecycleAction(
  capability: OfferCapability,
  request: OfferLifecycleActionRequest,
  target: OfferLifecycleState,
  options: { requiresCommerce: boolean; requiresProductAuthority: boolean },
): OfferAuthorityDecision {
  const problem = options.requiresCommerce
    ? commerceProblem(request.subject)
    : draftingProblem(request.subject);
  if (problem) return deny(capability, problem);
  if (!sellerMatches(request)) return deny(capability, "SELLER_PARTICIPANT_MISMATCH");
  if (options.requiresProductAuthority && !request.hasProductAuthority) {
    return deny(capability, "PRODUCT_AUTHORITY_REQUIRED");
  }
  if (isTerminalOfferLifecycleState(request.lifecycle)) {
    return deny(capability, "OFFER_LIFECYCLE_TERMINAL");
  }
  if (!isValidOfferLifecycleTransition(request.lifecycle, target)) {
    return deny(capability, "OFFER_LIFECYCLE_TRANSITION_NOT_PERMITTED");
  }
  return allow(capability);
}

/** Taking an Offer live. Full commerce gates plus Product authority. */
export function canActivateOffer(request: OfferLifecycleActionRequest): OfferAuthorityDecision {
  return evaluateLifecycleAction("offer:activate", request, "ACTIVE", {
    requiresCommerce: true,
    requiresProductAuthority: true,
  });
}

/** Resuming a suspended Offer — live again, so the same gates as activation. */
export function canResumeOffer(request: OfferLifecycleActionRequest): OfferAuthorityDecision {
  return evaluateLifecycleAction("offer:resume", request, "ACTIVE", {
    requiresCommerce: true,
    requiresProductAuthority: true,
  });
}

/**
 * Suspending, ending, and withdrawing **stand down** a commercial commitment.
 *
 * They deliberately do not require payment readiness: a seller whose payment
 * capability was just restricted must still be able to take their Offer down.
 * Requiring an intact commerce gate to *stop* selling would trap the exact seller
 * who most needs to stop.
 */
export function canSuspendOffer(request: OfferLifecycleActionRequest): OfferAuthorityDecision {
  return evaluateLifecycleAction("offer:suspend", request, "SUSPENDED", {
    requiresCommerce: false,
    requiresProductAuthority: false,
  });
}

export function canEndOffer(request: OfferLifecycleActionRequest): OfferAuthorityDecision {
  return evaluateLifecycleAction("offer:end", request, "ENDED", {
    requiresCommerce: false,
    requiresProductAuthority: false,
  });
}

export function canWithdrawOffer(request: OfferLifecycleActionRequest): OfferAuthorityDecision {
  return evaluateLifecycleAction("offer:withdraw", request, "WITHDRAWN", {
    requiresCommerce: false,
    requiresProductAuthority: false,
  });
}

/**
 * Changing commercial terms.
 *
 * On a **live** Offer this is a commercial act and faces the full commerce gates:
 * changing the price of something currently on sale is selling. On a `DRAFT` it
 * faces only the drafting gates — that is what drafting is for. Terminal Offers
 * refuse outright: their terms are history.
 */
export function canChangeOfferTerms(request: OfferLifecycleActionRequest): OfferAuthorityDecision {
  const capability = "offer:terms:change" as const;
  const live = request.lifecycle === "ACTIVE" || request.lifecycle === "SUSPENDED";
  const problem = live ? commerceProblem(request.subject) : draftingProblem(request.subject);
  if (problem) return deny(capability, problem);
  if (!sellerMatches(request)) return deny(capability, "SELLER_PARTICIPANT_MISMATCH");
  if (!request.hasProductAuthority) return deny(capability, "PRODUCT_AUTHORITY_REQUIRED");
  if (isTerminalOfferLifecycleState(request.lifecycle)) {
    return deny(capability, "OFFER_LIFECYCLE_TERMINAL");
  }
  return allow(capability);
}
