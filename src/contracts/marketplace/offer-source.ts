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
import { AUTHORIZING_ACTOR_ID_RE, INTERNAL_PRODUCT_ID_RE, SOURCE_RECORD_ID_RE } from "../capsule/identity";
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
 * Who performed the authorized source action — the **resolved acting account**
 * (Phase 1.18), or a historical `mon:actor:` value on a row written before it.
 *
 * Derived, never supplied. It used to be a caller input beside the acting
 * account id, which made the audit trail forgeable and independently settable:
 * a caller could name any actor for an operation authorized against a different
 * identity. `AUTHORIZING_ACTOR_ID_RE` carries the full reasoning.
 *
 * Opaque by construction — an email, display name, or other private profile
 * datum must never be recorded here, and matches neither form.
 */
export const AuthorizingActorId = z
  .string()
  .regex(
    AUTHORIZING_ACTOR_ID_RE,
    "authorizedByActorId must be opaque (mon:acct:<opaque>, or a historical mon:actor:<opaque>)",
  );
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

/**
 * A **PAID** Offer's wholesale price — what the creator is owed for the item,
 * before any promoter commission is deducted.
 *
 * Deliberately **not** a generic "price": what a buyer eventually pays is the
 * Promoter's retail price, set on a future Listing and never here. Naming this
 * field `price` was the ambiguity this phase exists to correct — the same number
 * cannot be both what the creator receives and what the buyer pays.
 */
export const PaidOfferPrice = z.strictObject({
  type: z.literal("PAID"),
  wholesalePriceMinorUnits: MinorUnitAmount,
  wholesalePriceCurrency: CurrencyCode,
});

/**
 * A discriminated union, so a FREE Offer has **no field** for a wholesale amount
 * or a currency. Absence by construction: a free Offer cannot carry a stray
 * price because there is nowhere to put one.
 */
export const OfferPrice = z.discriminatedUnion("type", [FreeOfferPrice, PaidOfferPrice]);
export type OfferPrice = z.infer<typeof OfferPrice>;

// — Promotion and commission —

/** Basis points: 1 = 0.01%, 10 000 = 100%. */
export const MIN_COMMISSION_BASIS_POINTS = 1;
export const MAX_COMMISSION_BASIS_POINTS = 10_000;

/**
 * The two commission methods, and the only two.
 *
 * **The commission basis is always the wholesale price.** `PERCENT_OF_RETAIL`,
 * `PERCENT_OF_LISTING_PRICE`, `PERCENT_OF_CHECKOUT_TOTAL`, and any selectable
 * basis are refused by construction: a commission computed from a number the
 * Promoter controls would let the Promoter change what the creator owes them, and
 * the creator agreed to neither the number nor the change.
 */
export const COMMISSION_METHODS = ["PERCENT_OF_WHOLESALE", "FIXED_AMOUNT"] as const;
export const CommissionMethod = z.enum(COMMISSION_METHODS);
export type CommissionMethod = z.infer<typeof CommissionMethod>;

export const PercentOfWholesaleCommission = z.strictObject({
  method: z.literal("PERCENT_OF_WHOLESALE"),
  commissionBasisPoints: z
    .int()
    .min(MIN_COMMISSION_BASIS_POINTS, "commission must be greater than 0 basis points")
    .max(MAX_COMMISSION_BASIS_POINTS, "commission may not exceed 10,000 basis points"),
});

export const FixedAmountCommission = z.strictObject({
  method: z.literal("FIXED_AMOUNT"),
  fixedCommissionMinorUnits: MinorUnitAmount,
  fixedCommissionCurrency: CurrencyCode,
});

/**
 * Strictly discriminated, so a percentage carries no fixed fields and a fixed
 * amount carries no basis points.
 *
 * The two stay **semantically distinct even when they produce the same number**
 * for one wholesale price: "20% of whatever I charge" and "£2.00" mean different
 * things the moment the wholesale price moves, and collapsing them would silently
 * reinterpret the creator's intent at the next price change.
 */
export const OfferCommission = z.discriminatedUnion("method", [
  PercentOfWholesaleCommission,
  FixedAmountCommission,
]);
export type OfferCommission = z.infer<typeof OfferCommission>;

export const NotPromotable = z.strictObject({
  type: z.literal("NOT_PROMOTABLE"),
});

export const Promotable = z.strictObject({
  type: z.literal("PROMOTABLE"),
  /** Creator-controlled. A promoter selects an Offer; it never sets these terms. */
  commission: OfferCommission,
});

export const OfferPromotion = z.discriminatedUnion("type", [NotPromotable, Promotable]);
export type OfferPromotion = z.infer<typeof OfferPromotion>;

// — Commercial terms (wholesale price and promotion together) —

/**
 * Wholesale price and promotion in one object, because the rules that bind them
 * are cross-field and must be validated together rather than trusted to a caller.
 *
 * Refused combinations, each for a stated reason:
 *   - **PROMOTABLE on a FREE Offer** — there are no proceeds to pay a commission
 *     from. Non-monetary referral incentives are deferred, not smuggled in as a
 *     commission on nothing.
 *   - **Fixed commission in a different currency than the wholesale price** — a
 *     cross-rate the Offer never agreed to.
 *   - **Fixed commission exceeding the wholesale price** — a sale that would owe
 *     the promoter more than the creator is due.
 *
 * Earned commissions, attribution, settlement, and payouts are **not** here.
 * Those are financial records about sales that happened; this is the standing
 * term a creator offers.
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
    if (commission.method !== "FIXED_AMOUNT") return;

    if (commission.fixedCommissionCurrency !== terms.price.wholesalePriceCurrency) {
      ctx.addIssue({
        code: "custom",
        path: ["promotion", "commission", "fixedCommissionCurrency"],
        message: "a fixed commission must be in the same currency as the wholesale price",
      });
    }
    if (commission.fixedCommissionMinorUnits > terms.price.wholesalePriceMinorUnits) {
      ctx.addIssue({
        code: "custom",
        path: ["promotion", "commission", "fixedCommissionMinorUnits"],
        message: "a fixed commission must not exceed the wholesale price",
      });
    }
  });
export type OfferCommercialTerms = z.infer<typeof OfferCommercialTerms>;

// — Deterministic economics —

/**
 * The commission-calculation policy these amounts were produced under.
 *
 * Versioned separately from the capsule mapping version: **how much a creator is
 * owed is a business rule, and how a capsule is shaped is a projection rule.**
 * Tying them together would make a presentational change look like a repricing.
 */
export const COMMISSION_CALCULATION_POLICY_VERSIONS = ["WHOLESALE_COMMISSION_V1"] as const;
export const CommissionCalculationPolicyVersion = z.enum(COMMISSION_CALCULATION_POLICY_VERSIONS);
export type CommissionCalculationPolicyVersion = z.infer<
  typeof CommissionCalculationPolicyVersion
>;

export const CURRENT_COMMISSION_CALCULATION_POLICY: CommissionCalculationPolicyVersion =
  "WHOLESALE_COMMISSION_V1";

/** Half-up to the minor unit — stated as a named policy, not left to a library. */
export const COMMISSION_ROUNDING_POLICY = "HALF_UP_TO_MINOR_UNIT" as const;

/**
 * The largest minor-unit amount this contract accepts.
 *
 * `Number.MAX_SAFE_INTEGER` is the boundary past which integer arithmetic stops
 * being exact in JavaScript. Amounts are checked against it **after** the BigInt
 * computation, so an overflow is refused rather than silently rounded.
 */
export const MAX_MINOR_UNIT_AMOUNT = Number.MAX_SAFE_INTEGER;

export const OfferEconomics = z.strictObject({
  calculatedCommissionMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  calculatedCreatorGrossProceedsMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  commissionCalculationPolicyVersion: CommissionCalculationPolicyVersion,
});
export type OfferEconomics = z.infer<typeof OfferEconomics>;

export class OfferEconomicsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OfferEconomicsError";
  }
}

/**
 * Compute the exact commission and creator gross proceeds for validated terms.
 *
 * Pure: no clock, no randomness, no I/O. Same inputs, same outputs, always.
 *
 * **Percentage arithmetic runs in `BigInt`.** `wholesale × basisPoints` exceeds
 * `Number.MAX_SAFE_INTEGER` for perfectly ordinary amounts once a currency has
 * small units, and a silent precision loss in money is the kind of bug that
 * surfaces as a rounding complaint months later. The result is converted back
 * only after it is confirmed to be in range.
 *
 * Rounding is **half-up to the minor unit**: `floor((wholesale × bp + 5000) /
 * 10000)`. Fixed commissions need no rounding at all.
 *
 * Deliberately **excludes** Monacado fees, payment-processing fees, taxes,
 * shipping, refunds, chargebacks, and payout adjustments — "gross proceeds before
 * separately disclosed fees" means exactly that, and folding a fee in here would
 * make the creator's disclosed number quietly wrong.
 */
export function calculateOfferEconomics(terms: OfferCommercialTerms): OfferEconomics {
  const parsed = OfferCommercialTerms.parse(terms);

  if (parsed.price.type === "FREE") {
    return {
      calculatedCommissionMinorUnits: 0,
      calculatedCreatorGrossProceedsMinorUnits: 0,
      commissionCalculationPolicyVersion: CURRENT_COMMISSION_CALCULATION_POLICY,
    };
  }

  const wholesale = parsed.price.wholesalePriceMinorUnits;

  let commission = 0;
  if (parsed.promotion.type === "PROMOTABLE") {
    const terms_ = parsed.promotion.commission;
    if (terms_.method === "PERCENT_OF_WHOLESALE") {
      const scaled =
        (BigInt(wholesale) * BigInt(terms_.commissionBasisPoints) + 5_000n) / 10_000n;
      if (scaled > BigInt(MAX_MINOR_UNIT_AMOUNT)) {
        throw new OfferEconomicsError(
          "calculated commission exceeds the safe minor-unit range",
        );
      }
      commission = Number(scaled);
    } else {
      commission = terms_.fixedCommissionMinorUnits;
    }
  }

  /* Guaranteed by the term refinements above; asserted because a violated
     invariant must fail loudly rather than produce negative proceeds. */
  if (commission > wholesale) {
    throw new OfferEconomicsError("calculated commission exceeds the wholesale price");
  }

  return {
    calculatedCommissionMinorUnits: commission,
    calculatedCreatorGrossProceedsMinorUnits: wholesale - commission,
    commissionCalculationPolicyVersion: CURRENT_COMMISSION_CALCULATION_POLICY,
  };
}

/** True when a stored economics snapshot exactly matches the calculator. */
export function economicsMatch(terms: OfferCommercialTerms, stored: OfferEconomics): boolean {
  const computed = calculateOfferEconomics(terms);
  return (
    computed.calculatedCommissionMinorUnits === stored.calculatedCommissionMinorUnits &&
    computed.calculatedCreatorGrossProceedsMinorUnits ===
      stored.calculatedCreatorGrossProceedsMinorUnits &&
    computed.commissionCalculationPolicyVersion === stored.commissionCalculationPolicyVersion
  );
}

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
export const OfferSourceRecordBase = z.strictObject({
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
  /**
   * The exact economics the creator was shown, stored alongside their inputs so
   * the accepted numbers can be reproduced and audited rather than recomputed
   * under whatever policy happens to be current later.
   */
  economics: OfferEconomics,

  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** Stored economics must match the deterministic calculator exactly. */
function economicsRefine(
  value: { terms: OfferCommercialTerms; economics: OfferEconomics },
  ctx: z.RefinementCtx,
): void {
  if (!economicsMatch(value.terms, value.economics)) {
    ctx.addIssue({
      code: "custom",
      path: ["economics"],
      message:
        "stored economics do not match the authoritative calculation for these commercial terms",
    });
  }
}

export const OfferSourceRecord = OfferSourceRecordBase.superRefine(economicsRefine);
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
export const OfferSourceVersionBase = z.strictObject({
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
  /** The exact economics accepted for this version. */
  economics: OfferEconomics,

  authorizedBySellerParticipantId: MarketplaceParticipantId,
  authorizedByActorId: AuthorizingActorId,
  recordedAt: z.iso.datetime(),
});

export const OfferSourceVersion = OfferSourceVersionBase.superRefine(economicsRefine);
export type OfferSourceVersion = z.infer<typeof OfferSourceVersion>;

// — Creator disclosure and exact-version confirmation —

/**
 * Everything a creator must see **before** activating an Offer.
 *
 * The exact commission and exact gross proceeds are here because a rate alone is
 * not disclosure: what a creator wants to know is what they receive per sale, and
 * making them compute it themselves is how a surprise becomes possible.
 *
 * Fees, taxes, shipping, refunds, and payout adjustments are deliberately absent —
 * this is gross proceeds **before separately disclosed fees**, and folding one in
 * would make the disclosed number quietly wrong.
 */
export const CreatorEconomicsDisclosure = z.strictObject({
  offerSourceRecordId: OfferSourceRecordId,
  /** The exact version whose economics are being shown. */
  sourceRecordVersion: OfferSourceRecordVersion,
  terms: OfferCommercialTerms,
  economics: OfferEconomics,
});
export type CreatorEconomicsDisclosure = z.infer<typeof CreatorEconomicsDisclosure>;

/** Build the disclosure for one version's terms. Pure; nothing is persisted. */
export function buildCreatorEconomicsDisclosure(input: {
  offerSourceRecordId: string;
  sourceRecordVersion: string;
  terms: OfferCommercialTerms;
}): CreatorEconomicsDisclosure {
  return CreatorEconomicsDisclosure.parse({
    offerSourceRecordId: input.offerSourceRecordId,
    sourceRecordVersion: input.sourceRecordVersion,
    terms: input.terms,
    economics: calculateOfferEconomics(input.terms),
  });
}

/**
 * A creator's confirmation of the economics they were shown.
 *
 * Deliberately **not** a bare boolean. `creatorConfirmedEconomics: true` says
 * nothing about *which* economics were confirmed, so it would survive a price
 * change untouched and authorize terms the creator never saw.
 *
 * It binds to **both halves of the identity** — the source-record id *and* the
 * version label — because a version label alone is not unique across Offers. Two
 * Offers each have a "v3", and a confirmation carrying only "v3" would authorize
 * the wrong Offer's economics with amounts that happened to match.
 */
export const CreatorEconomicsConfirmation = z.strictObject({
  /** The exact Offer whose disclosure the creator confirmed. */
  confirmedOfferSourceRecordId: OfferSourceRecordId,
  /** The exact version of that Offer. */
  confirmedOfferSourceRecordVersion: OfferSourceRecordVersion,
  calculatedCommissionMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  calculatedCreatorGrossProceedsMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  commissionCalculationPolicyVersion: CommissionCalculationPolicyVersion,
});
export type CreatorEconomicsConfirmation = z.infer<typeof CreatorEconomicsConfirmation>;

export const CONFIRMATION_MISMATCH_REASONS = [
  "CONFIRMATION_MISSING",
  "CONFIRMATION_SOURCE_RECORD_MISMATCH",
  "CONFIRMATION_VERSION_MISMATCH",
  "CONFIRMATION_AMOUNTS_STALE",
  "CONFIRMATION_POLICY_VERSION_MISMATCH",
] as const;
export const ConfirmationMismatchReason = z.enum(CONFIRMATION_MISMATCH_REASONS);
export type ConfirmationMismatchReason = z.infer<typeof ConfirmationMismatchReason>;

/**
 * Whether a confirmation authorizes activating **this** Offer version's economics.
 *
 * Five distinct failures, five codes: absent, for another Offer, for another
 * version of this Offer, carrying amounts that no longer match, or computed under
 * a different policy. The two identity components are compared **independently**,
 * so "right Offer, wrong version" and "right version label, wrong Offer" are
 * never conflated — an operator reading a refusal should not have to guess which.
 */
export function checkCreatorEconomicsConfirmation(input: {
  offerSourceRecordId: string;
  sourceRecordVersion: string;
  terms: OfferCommercialTerms;
  confirmation: CreatorEconomicsConfirmation | null;
}): ConfirmationMismatchReason | undefined {
  const { confirmation } = input;
  if (confirmation === null) return "CONFIRMATION_MISSING";
  if (confirmation.confirmedOfferSourceRecordId !== input.offerSourceRecordId) {
    return "CONFIRMATION_SOURCE_RECORD_MISMATCH";
  }
  if (confirmation.confirmedOfferSourceRecordVersion !== input.sourceRecordVersion) {
    return "CONFIRMATION_VERSION_MISMATCH";
  }
  const authoritative = calculateOfferEconomics(input.terms);
  if (
    confirmation.commissionCalculationPolicyVersion !==
    authoritative.commissionCalculationPolicyVersion
  ) {
    return "CONFIRMATION_POLICY_VERSION_MISMATCH";
  }
  if (
    confirmation.calculatedCommissionMinorUnits !==
      authoritative.calculatedCommissionMinorUnits ||
    confirmation.calculatedCreatorGrossProceedsMinorUnits !==
      authoritative.calculatedCreatorGrossProceedsMinorUnits
  ) {
    return "CONFIRMATION_AMOUNTS_STALE";
  }
  return undefined;
}

// — Business change classification —

/**
 * What kind of business change happened between two immutable versions.
 *
 * `WHOLESALE_PRICE_CHANGED` **absorbs** the derived commission movement under a
 * percentage method: the creator changed one thing, and reporting two changes
 * would tell a promoter their commission terms were altered when they were not.
 * `COMMISSION_TERMS_CHANGED` means the creator changed the method, the rate, or
 * the fixed amount itself.
 */
export const OFFER_BUSINESS_CHANGE_CATEGORIES = [
  "COMMERCIAL_AVAILABILITY_CHANGED",
  "WHOLESALE_PRICE_CHANGED",
  "COMMISSION_TERMS_CHANGED",
  "OTHER_MATERIAL_OFFER_CHANGE",
] as const;
export const OfferBusinessChangeCategory = z.enum(OFFER_BUSINESS_CHANGE_CATEGORIES);
export type OfferBusinessChangeCategory = z.infer<typeof OfferBusinessChangeCategory>;

type OfferBusinessState = Pick<
  OfferSourceVersion,
  | "internalProductId"
  | "sellerParticipantId"
  | "lifecycle"
  | "availability"
  | "terms"
  | "effectiveInterval"
>;

function commissionTermsOf(terms: OfferCommercialTerms): unknown {
  return terms.promotion.type === "PROMOTABLE" ? terms.promotion.commission : null;
}

function wholesaleOf(terms: OfferCommercialTerms): unknown {
  return terms.price.type === "PAID"
    ? {
        amount: terms.price.wholesalePriceMinorUnits,
        currency: terms.price.wholesalePriceCurrency,
      }
    : null;
}

/**
 * The deterministic order categories are reported in.
 *
 * Fixed so two callers comparing results never disagree because of ordering, and
 * so a test can assert an exact array rather than a set.
 */
export const OFFER_BUSINESS_CHANGE_ORDER: readonly OfferBusinessChangeCategory[] = Object.freeze([
  "COMMERCIAL_AVAILABILITY_CHANGED",
  "WHOLESALE_PRICE_CHANGED",
  "COMMISSION_TERMS_CHANGED",
  "OTHER_MATERIAL_OFFER_CHANGE",
]);

/**
 * Classify the business changes between two validated versions.
 *
 * Returns **zero or more** categories in `OFFER_BUSINESS_CHANGE_ORDER`: one
 * governed edit can legitimately change availability, wholesale price, and
 * commission terms at once, and reporting only the first would leave a promoter
 * unaware of the rest.
 *
 * **A calculated commission that moved solely because the wholesale price moved
 * adds no `COMMISSION_TERMS_CHANGED`** — the creator changed one thing, and
 * saying otherwise would tell a promoter their terms were altered when they were
 * not. Only the commission *inputs* (method, basis points, fixed amount, fixed
 * currency) count.
 *
 * **Classification only.** It creates no notification, identifies no recipient,
 * mutates no Listing, persists no event, and starts no job — those belong to the
 * future notification phase, and a classifier that did any of them would make
 * "what changed?" impossible to ask without side effects.
 */
export function classifyOfferBusinessChanges(
  prior: OfferBusinessState,
  next: OfferBusinessState,
): readonly OfferBusinessChangeCategory[] {
  const categories: OfferBusinessChangeCategory[] = [];
  const differs = (a: unknown, b: unknown) => canonicalJsonString(a) !== canonicalJsonString(b);

  if (prior.availability !== next.availability) categories.push("COMMERCIAL_AVAILABILITY_CHANGED");
  if (differs(wholesaleOf(prior.terms), wholesaleOf(next.terms))) {
    categories.push("WHOLESALE_PRICE_CHANGED");
  }
  if (differs(commissionTermsOf(prior.terms), commissionTermsOf(next.terms))) {
    categories.push("COMMISSION_TERMS_CHANGED");
  }
  if (
    prior.internalProductId !== next.internalProductId ||
    prior.sellerParticipantId !== next.sellerParticipantId ||
    prior.lifecycle !== next.lifecycle ||
    differs(prior.effectiveInterval, next.effectiveInterval)
  ) {
    categories.push("OTHER_MATERIAL_OFFER_CHANGE");
  }
  return Object.freeze(
    OFFER_BUSINESS_CHANGE_ORDER.filter((category) => categories.includes(category)),
  );
}

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
  /** The lifecycle move this capability implies is not a permitted transition. */
  "OFFER_LIFECYCLE_TRANSITION_NOT_PERMITTED",
  /** The Offer is in a terminal state; nothing further may be authorized. */
  "OFFER_LIFECYCLE_TERMINAL",
  /** No creator confirmation of this version's economics was supplied. */
  "CREATOR_ECONOMICS_NOT_CONFIRMED",
  /** The confirmation names a different Offer. */
  "CREATOR_CONFIRMATION_SOURCE_RECORD_MISMATCH",
  /** The confirmation names a different version of this Offer. */
  "CREATOR_CONFIRMATION_VERSION_MISMATCH",
  /** The confirmed amounts no longer match the authoritative calculation. */
  "CREATOR_CONFIRMATION_STALE",
  /** The confirmation was computed under a different calculation policy. */
  "CREATOR_CONFIRMATION_POLICY_MISMATCH",
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
 * `hasProductAuthority` stays a supplied *input to this pure decision* — the
 * Product model owns the question, and re-deriving it here would put two
 * answers in the repository that could disagree. What changed in Phase 1.18 is
 * its **provenance**, one layer out: the Offer service reads it from the
 * Product's current source version (`participantHoldsProductAuthority`) rather
 * than accepting it on `CreateDraftOfferInput` / `UpdateOfferInput`, where any
 * caller could write `true`. The rules below are unchanged; only the caller's
 * ability to forge their premise is gone.
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
  /**
   * The version and terms being acted on, plus the creator's confirmation of the
   * economics they were shown. Supplied for activation; absent elsewhere because
   * standing an Offer down asserts nothing about its economics.
   */
  economicsContext: z
    .strictObject({
      offerSourceRecordId: OfferSourceRecordId,
      sourceRecordVersion: OfferSourceRecordVersion,
      terms: OfferCommercialTerms,
      confirmation: CreatorEconomicsConfirmation.nullable(),
    })
    .optional(),
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

const CONFIRMATION_REASON_BY_MISMATCH: Record<ConfirmationMismatchReason, OfferReasonCode> = {
  CONFIRMATION_MISSING: "CREATOR_ECONOMICS_NOT_CONFIRMED",
  CONFIRMATION_SOURCE_RECORD_MISMATCH: "CREATOR_CONFIRMATION_SOURCE_RECORD_MISMATCH",
  CONFIRMATION_VERSION_MISMATCH: "CREATOR_CONFIRMATION_VERSION_MISMATCH",
  CONFIRMATION_AMOUNTS_STALE: "CREATOR_CONFIRMATION_STALE",
  CONFIRMATION_POLICY_VERSION_MISMATCH: "CREATOR_CONFIRMATION_POLICY_MISMATCH",
};

/**
 * Going live requires the creator to have confirmed **this exact version's**
 * economics.
 *
 * A material change to the wholesale price or commission terms mints a new
 * version, so a confirmation bound to the previous one stops matching by
 * construction — the creator has to look again before the new terms can sell.
 */
function creatorConfirmationProblem(
  request: OfferLifecycleActionRequest,
): OfferReasonCode | undefined {
  const context = request.economicsContext;
  if (context === undefined) return "CREATOR_ECONOMICS_NOT_CONFIRMED";
  const mismatch = checkCreatorEconomicsConfirmation({
    offerSourceRecordId: context.offerSourceRecordId,
    sourceRecordVersion: context.sourceRecordVersion,
    terms: context.terms,
    confirmation: context.confirmation,
  });
  return mismatch === undefined ? undefined : CONFIRMATION_REASON_BY_MISMATCH[mismatch];
}

/**
 * Taking an Offer live. Full commerce gates, Product authority, **and the
 * creator's exact-version economics confirmation.**
 */
export function canActivateOffer(request: OfferLifecycleActionRequest): OfferAuthorityDecision {
  const gated = evaluateLifecycleAction("offer:activate", request, "ACTIVE", {
    requiresCommerce: true,
    requiresProductAuthority: true,
  });
  if (!isOfferActionAllowed(gated)) return gated;
  const confirmation = creatorConfirmationProblem(request);
  return confirmation === undefined
    ? gated
    : { capability: "offer:activate", decision: "DENY", reasonCodes: [confirmation] };
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
