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
import {
  APPLICATION_REF_RE,
  AUTHORIZING_ACTOR_ID_RE,
  INTERNAL_PRODUCT_ID_RE,
  SOURCE_RECORD_ID_RE,
} from "../capsule/identity";
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

/**
 * The stable APPLICATION-FACING Offer reference (Phase 1.42): opaque,
 * un-namespaced, 32 Crockford characters — the `productRef` construction. How a
 * route names an Offer; the internal ids are never exposed.
 */
export const OfferRef = z
  .string()
  .regex(APPLICATION_REF_RE, "offerRef must be a 32-character opaque application reference");
export type OfferRef = z.infer<typeof OfferRef>;

// — Lifecycle (Phase 1.42) —

/**
 * The Offer's lifecycle — Seller AUTHORITY, never a commercial term.
 *
 * Until Phase 1.42 lifecycle and availability lived on every immutable
 * commercial version, so pausing an Offer minted a "commercial" version that
 * changed no term. Lifecycle is now recorded as append-only `OfferAct` rows and
 * **derived on read**; versions hold commercial terms only.
 *
 *   - `DRAFT`     — created, never activated.
 *   - `ACTIVE`    — activated against an exact confirmed STANDING version.
 *   - `PAUSED`    — the Seller stood it down; RESUME returns it to ACTIVE.
 *   - `WITHDRAWN` — terminal, by a Seller act.
 *   - `ENDED`     — terminal, DERIVED ONLY: the optional overall
 *                   `offerEffectiveUntil` recorded on activation has passed.
 *                   No cron writes it and no act records it.
 *
 * `SUSPENDED` is **reserved** for a future operator act and is not a member: a
 * Seller cannot suspend their own Offer (they pause it), and no operator path
 * exists yet. Adding it later is additive.
 *
 * Product lifecycle, resale availability, and Seller readiness changes **never
 * rewrite** this lifecycle. They gate the acts that make an Offer live
 * (activate, resume), and nothing else.
 */
export const OFFER_LIFECYCLE_STATES = ["DRAFT", "ACTIVE", "PAUSED", "WITHDRAWN", "ENDED"] as const;
export const OfferLifecycleState = z.enum(OFFER_LIFECYCLE_STATES);
export type OfferLifecycleState = z.infer<typeof OfferLifecycleState>;

/** The states an act can RECORD. `DRAFT` is the absence of acts; `ENDED` is never recorded. */
export const RECORDED_OFFER_LIFECYCLE_STATES = ["ACTIVE", "PAUSED", "WITHDRAWN"] as const;
export const RecordedOfferLifecycleState = z.enum(RECORDED_OFFER_LIFECYCLE_STATES);
export type RecordedOfferLifecycleState = z.infer<typeof RecordedOfferLifecycleState>;

/** Reserved, not admitted (Phase 1.42): see `OFFER_LIFECYCLE_STATES`. */
export const RESERVED_OFFER_LIFECYCLE_STATES = ["SUSPENDED"] as const;

/** The only state an Offer may be created in. */
export const INITIAL_OFFER_LIFECYCLE_STATE: OfferLifecycleState = "DRAFT";

/**
 * Terminal: nothing further may be authorized. An Offer that must sell again
 * after it ended or was withdrawn is a **new Offer**, with a new `offerRef` —
 * reviving a terminal one would reattach a new commitment to a record that
 * already closed.
 */
export function isTerminalOfferLifecycleState(state: OfferLifecycleState): boolean {
  return state === "WITHDRAWN" || state === "ENDED";
}

/** The Seller acts that move the lifecycle. */
export const OFFER_LIFECYCLE_ACTS = ["ACTIVATE", "PAUSE", "RESUME", "WITHDRAW"] as const;
export const OfferLifecycleAct = z.enum(OFFER_LIFECYCLE_ACTS);
export type OfferLifecycleAct = z.infer<typeof OfferLifecycleAct>;

/**
 * Every act an `OfferAct` row may record: the lifecycle acts, plus
 * `END_PROMOTION`, which ends a running promotion early and leaves the
 * lifecycle exactly where it was.
 */
export const OFFER_ACTS = [...OFFER_LIFECYCLE_ACTS, "END_PROMOTION"] as const;
export const OfferActKind = z.enum(OFFER_ACTS);
export type OfferActKind = z.infer<typeof OfferActKind>;

/** The governed transitions — the whole table. */
export const OFFER_LIFECYCLE_ACT_TRANSITIONS: Readonly<
  Record<OfferLifecycleAct, { from: readonly OfferLifecycleState[]; to: RecordedOfferLifecycleState }>
> = Object.freeze({
  ACTIVATE: { from: ["DRAFT"], to: "ACTIVE" },
  PAUSE: { from: ["ACTIVE"], to: "PAUSED" },
  RESUME: { from: ["PAUSED"], to: "ACTIVE" },
  WITHDRAW: { from: ["DRAFT", "ACTIVE", "PAUSED"], to: "WITHDRAWN" },
});

export type OfferLifecycleActDecision =
  | { outcome: "PERMITTED"; from: OfferLifecycleState; to: RecordedOfferLifecycleState }
  | { outcome: "REFUSED"; reason: "OFFER_LIFECYCLE_TERMINAL" | "OFFER_LIFECYCLE_TRANSITION_NOT_PERMITTED" };

/** Decide one lifecycle act against the DERIVED current state. Pure. */
export function decideOfferLifecycleAct(
  current: OfferLifecycleState,
  act: OfferLifecycleAct,
): OfferLifecycleActDecision {
  if (isTerminalOfferLifecycleState(current)) {
    return { outcome: "REFUSED", reason: "OFFER_LIFECYCLE_TERMINAL" };
  }
  const rule = OFFER_LIFECYCLE_ACT_TRANSITIONS[act];
  if (!rule.from.includes(current)) {
    return { outcome: "REFUSED", reason: "OFFER_LIFECYCLE_TRANSITION_NOT_PERMITTED" };
  }
  return { outcome: "PERMITTED", from: current, to: rule.to };
}

/**
 * The derived lifecycle at one instant.
 *
 * `recordedState` is the current act's state (`null` when no act exists);
 * `offerEffectiveUntil` is the overall end recorded on the ACTIVATE act.
 *
 * WITHDRAWN wins — a withdrawal is the Seller's explicit last word. Otherwise an
 * Offer whose overall end has passed is ENDED, whether it was ACTIVE or PAUSED,
 * at exactly `at >= offerEffectiveUntil` (the end is exclusive).
 */
export function deriveOfferLifecycleState(input: {
  recordedState: RecordedOfferLifecycleState | null;
  offerEffectiveUntil: string | null;
  at: string;
}): OfferLifecycleState {
  if (input.recordedState === "WITHDRAWN") return "WITHDRAWN";
  if (input.recordedState === null) return "DRAFT";
  if (input.offerEffectiveUntil !== null && Date.parse(input.at) >= Date.parse(input.offerEffectiveUntil)) {
    return "ENDED";
  }
  return input.recordedState;
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

// — Promoted-resale terms (Phase 1.42) —

/**
 * The one currency Phase 1.42 admits. `CurrencyCode` stays structural; this is
 * the narrower write-time rule for Seller-authored promoted-resale terms.
 */
export const OFFER_SUPPORTED_CURRENCIES = ["USD"] as const;

/**
 * The terms a Seller may AUTHOR in Phase 1.42: an Offer is the Seller's
 * commercial authority for **promoted resale only** (Contract §12, §16), so it is
 * PAID, PROMOTABLE, and USD. Seller-direct commerce uses no Offer, and a FREE or
 * NOT_PROMOTABLE Offer would be one no Promoter could ever act on.
 *
 * Kept separate from `OfferCommercialTerms`, which remains the general,
 * structural contract every stored version and the capsule projection read: the
 * narrowing is a write rule, not a change to what a version can mean.
 *
 * Retail price is a Listing fact, and the 7.5% + $1 acquisition economics are
 * policy (0M.R); neither is a member here or anywhere on an Offer.
 */
export const PromotedResaleOfferTerms = OfferCommercialTerms.superRefine((terms, ctx) => {
  if (terms.price.type !== "PAID") {
    ctx.addIssue({ code: "custom", path: ["price", "type"], message: "an Offer must be PAID" });
    return;
  }
  if (!(OFFER_SUPPORTED_CURRENCIES as readonly string[]).includes(terms.price.wholesalePriceCurrency)) {
    ctx.addIssue({
      code: "custom",
      path: ["price", "wholesalePriceCurrency"],
      message: "only USD is supported",
    });
  }
  if (terms.promotion.type !== "PROMOTABLE") {
    ctx.addIssue({ code: "custom", path: ["promotion", "type"], message: "an Offer must be PROMOTABLE" });
  }
});
export type PromotedResaleOfferTerms = z.infer<typeof PromotedResaleOfferTerms>;

// — Terms kinds and the promotion window (Phase 1.42) —

/**
 * What one immutable version is.
 *
 *   - `STANDING`            — the Offer's normal terms. Exactly one is current.
 *   - `SCHEDULED_PROMOTION` — a complete snapshot of temporary terms: the
 *     standing commission, unchanged, with a promotional wholesale price, in
 *     force only inside its window. Still an ordinary exact version, so a later
 *     acceptance or Listing may bind it exactly as it binds a standing one.
 */
export const OFFER_TERMS_KINDS = ["STANDING", "SCHEDULED_PROMOTION"] as const;
export const OfferTermsKind = z.enum(OFFER_TERMS_KINDS);
export type OfferTermsKind = z.infer<typeof OfferTermsKind>;

/**
 * A promotion's half-open UTC window, `[effectiveFrom, effectiveUntil)`.
 *
 * Both bounds required, `effectiveUntil` strictly later. Nothing here reads a
 * clock: whether a window is upcoming, running, or over is decided against an
 * explicit instant by `derivePromotionStatus`, and no act or job records a
 * window opening or closing.
 */
export const OfferPromotionWindow = z
  .strictObject({
    effectiveFrom: z.iso.datetime(),
    effectiveUntil: z.iso.datetime(),
  })
  .refine((w) => Date.parse(w.effectiveUntil) > Date.parse(w.effectiveFrom), {
    path: ["effectiveUntil"],
    message: "effectiveUntil must be later than effectiveFrom",
  });
export type OfferPromotionWindow = z.infer<typeof OfferPromotionWindow>;

/**
 * A promotion's status at one instant — derived, never stored.
 *
 *   - `SCHEDULED`   — `at < effectiveFrom`.
 *   - `RUNNING`     — `effectiveFrom <= at < effectiveUntil`, not ended early.
 *   - `ENDED`       — `at >= effectiveUntil`: standing terms apply again, with
 *                     no act and no job.
 *   - `ENDED_EARLY` — an END_PROMOTION act at or before `at` ended it.
 *   - `CANCELLED`   — replaced by a later promotion before it began.
 *
 * "Pending" means SCHEDULED or RUNNING: at most one promotion may be pending.
 */
export const OFFER_PROMOTION_STATUSES = ["SCHEDULED", "RUNNING", "ENDED", "ENDED_EARLY", "CANCELLED"] as const;
export const OfferPromotionStatus = z.enum(OFFER_PROMOTION_STATUSES);
export type OfferPromotionStatus = z.infer<typeof OfferPromotionStatus>;

export function isPendingPromotionStatus(status: OfferPromotionStatus): boolean {
  return status === "SCHEDULED" || status === "RUNNING";
}

export function derivePromotionStatus(input: {
  window: OfferPromotionWindow;
  /** When an END_PROMOTION act ended this promotion, if one did. */
  endedEarlyAt: string | null;
  /** When a later promotion replaced this one, if one did. */
  replacedAt: string | null;
  at: string;
}): OfferPromotionStatus {
  const at = Date.parse(input.at);
  if (input.replacedAt !== null && at >= Date.parse(input.replacedAt)) return "CANCELLED";
  if (input.endedEarlyAt !== null && at >= Date.parse(input.endedEarlyAt)) return "ENDED_EARLY";
  if (at < Date.parse(input.window.effectiveFrom)) return "SCHEDULED";
  if (at < Date.parse(input.window.effectiveUntil)) return "RUNNING";
  return "ENDED";
}

// — Effective terms (Phase 1.42) —

/**
 * Which exact version's terms are in force at one instant.
 *
 *   1. not lifecycle-effective (DRAFT, PAUSED, WITHDRAWN) → none;
 *   2. ENDED → none;
 *   3. a RUNNING promotion covers the instant → that promotion's version;
 *   4. otherwise → the current STANDING version.
 *
 * Pure, and the only place this order is written. It is NOT an aggregate
 * commerce gate: Product lifecycle, resale availability, Promotion
 * Authorization, Listings, and Promoter readiness are other axes, and Phase 1.42
 * wires this into neither checkout nor Listings.
 */
export type EffectiveOfferTerms =
  | { kind: "NONE"; lifecycle: OfferLifecycleState }
  | { kind: "STANDING"; sourceRecordVersion: string }
  | { kind: "SCHEDULED_PROMOTION"; sourceRecordVersion: string };

export interface OfferTermsResolutionInput {
  recordedState: RecordedOfferLifecycleState | null;
  offerEffectiveUntil: string | null;
  standingVersion: string;
  /** The current (most recently scheduled) promotion, if any. */
  promotion: { sourceRecordVersion: string; window: OfferPromotionWindow; endedEarlyAt: string | null } | null;
}

export function effectiveOfferTerms(offer: OfferTermsResolutionInput, at: string): EffectiveOfferTerms {
  const lifecycle = deriveOfferLifecycleState({
    recordedState: offer.recordedState,
    offerEffectiveUntil: offer.offerEffectiveUntil,
    at,
  });
  if (lifecycle !== "ACTIVE") return { kind: "NONE", lifecycle };
  if (
    offer.promotion !== null &&
    derivePromotionStatus({
      window: offer.promotion.window,
      endedEarlyAt: offer.promotion.endedEarlyAt,
      replacedAt: null,
      at,
    }) === "RUNNING"
  ) {
    return { kind: "SCHEDULED_PROMOTION", sourceRecordVersion: offer.promotion.sourceRecordVersion };
  }
  return { kind: "STANDING", sourceRecordVersion: offer.standingVersion };
}

/** The Seller-facing state at one instant: lifecycle, promotion, and what is in force. */
export interface SellerOfferState {
  lifecycle: OfferLifecycleState;
  promotionStatus: OfferPromotionStatus | null;
  effective: EffectiveOfferTerms;
}

export function deriveSellerOfferState(offer: OfferTermsResolutionInput, at: string): SellerOfferState {
  return {
    lifecycle: deriveOfferLifecycleState({
      recordedState: offer.recordedState,
      offerEffectiveUntil: offer.offerEffectiveUntil,
      at,
    }),
    promotionStatus:
      offer.promotion === null
        ? null
        : derivePromotionStatus({
            window: offer.promotion.window,
            endedEarlyAt: offer.promotion.endedEarlyAt,
            replacedAt: null,
            at,
          }),
    effective: effectiveOfferTerms(offer, at),
  };
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
  /** The stable application-facing reference (Phase 1.42). */
  offerRef: OfferRef,
  /**
   * The current STANDING version — exactly one is current (Phase 1.42). A
   * scheduled promotion never moves this pointer.
   */
  currentSourceRecordVersion: OfferSourceRecordVersion,
  /** The most recently scheduled promotion version, or `null` (Phase 1.42). */
  currentPromotionVersion: OfferSourceRecordVersion.nullable(),

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

  // Business state — the current STANDING terms. Lifecycle is not a member:
  // it is Seller authority, recorded as acts and derived (Phase 1.42).
  terms: OfferCommercialTerms,

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
  /** STANDING, or SCHEDULED_PROMOTION (Phase 1.42). Never a lifecycle. */
  termsKind: OfferTermsKind,
  terms: OfferCommercialTerms,
  /** SCHEDULED_PROMOTION only: its window. `null` on a STANDING version. */
  promotionWindow: OfferPromotionWindow.nullable(),
  /** SCHEDULED_PROMOTION only: the STANDING version it was built from. */
  basisStandingVersion: OfferSourceRecordVersion.nullable(),

  // Authorization trace — who authorized this change, and when it was recorded
  /** The exact economics accepted for this version. */
  economics: OfferEconomics,

  authorizedBySellerParticipantId: MarketplaceParticipantId,
  authorizedByActorId: AuthorizingActorId,
  recordedAt: z.iso.datetime(),
});

/** A STANDING version carries no window and no basis; a promotion carries both. */
function termsKindRefine(
  value: {
    termsKind: OfferTermsKind;
    promotionWindow: OfferPromotionWindow | null;
    basisStandingVersion: string | null;
  },
  ctx: z.RefinementCtx,
): void {
  const promotion = value.termsKind === "SCHEDULED_PROMOTION";
  if (promotion !== (value.promotionWindow !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["promotionWindow"],
      message: "a window is required on, and only on, a SCHEDULED_PROMOTION version",
    });
  }
  if (promotion !== (value.basisStandingVersion !== null)) {
    ctx.addIssue({
      code: "custom",
      path: ["basisStandingVersion"],
      message: "a basis is required on, and only on, a SCHEDULED_PROMOTION version",
    });
  }
}

export const OfferSourceVersion = OfferSourceVersionBase.superRefine(economicsRefine).superRefine(
  termsKindRefine,
);
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
  /**
   * Retained in the vocabulary, and NEVER EMITTED since Phase 1.42:
   * availability is no longer a version fact, so no pair of versions can differ
   * in it. Pausing or resuming an Offer is a lifecycle act that mints no version
   * and therefore asks no Promoter to re-accept unchanged economics.
   */
  "COMMERCIAL_AVAILABILITY_CHANGED",
  "WHOLESALE_PRICE_CHANGED",
  "COMMISSION_TERMS_CHANGED",
  "OTHER_MATERIAL_OFFER_CHANGE",
] as const;
export const OfferBusinessChangeCategory = z.enum(OFFER_BUSINESS_CHANGE_CATEGORIES);
export type OfferBusinessChangeCategory = z.infer<typeof OfferBusinessChangeCategory>;

type OfferBusinessState = Pick<
  OfferSourceVersion,
  "internalProductId" | "sellerParticipantId" | "termsKind" | "terms" | "promotionWindow"
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

  if (differs(wholesaleOf(prior.terms), wholesaleOf(next.terms))) {
    categories.push("WHOLESALE_PRICE_CHANGED");
  }
  if (differs(commissionTermsOf(prior.terms), commissionTermsOf(next.terms))) {
    categories.push("COMMISSION_TERMS_CHANGED");
  }
  if (
    prior.internalProductId !== next.internalProductId ||
    prior.sellerParticipantId !== next.sellerParticipantId ||
    prior.termsKind !== next.termsKind ||
    differs(prior.promotionWindow, next.promotionWindow)
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
  "price",
  "promotion",
  "commission",
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
  prior: Pick<OfferSourceRecord, "internalProductId" | "sellerParticipantId" | "terms">,
  next: typeof prior,
): MaterialOfferField[] {
  const changed: MaterialOfferField[] = [];
  const differs = (a: unknown, b: unknown) => canonicalJsonString(a) !== canonicalJsonString(b);

  if (prior.internalProductId !== next.internalProductId) changed.push("internalProductId");
  if (prior.sellerParticipantId !== next.sellerParticipantId) changed.push("sellerParticipantId");
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
  "price",
  "promotion",
  "commission",
  "promotionWindow",
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
  /* `promotionalPriceSchedules` left this list in Phase 1.42: ONE scheduled
     wholesale promotion per Offer is now modelled. Several at once, commission
     promotions, and Promoter-specific terms remain deferred. */
  "multiplePromotionSchedules",
  "commissionPromotions",
  "promoterSpecificOffers",
  "additionalCurrencies",
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
  "offer:pause",
  "offer:resume",
  "offer:withdraw",
  "offer:promotion:schedule",
  "offer:promotion:end",
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

/** The reasons that mean "the confirmation is absent or stale", not "you may not". */
export const OFFER_CONFIRMATION_REASON_CODES = [
  "CREATOR_ECONOMICS_NOT_CONFIRMED",
  "CREATOR_CONFIRMATION_SOURCE_RECORD_MISMATCH",
  "CREATOR_CONFIRMATION_VERSION_MISMATCH",
  "CREATOR_CONFIRMATION_STALE",
  "CREATOR_CONFIRMATION_POLICY_MISMATCH",
] as const satisfies readonly OfferReasonCode[];

/** The reasons that mean "the lifecycle does not permit this act". */
export const OFFER_LIFECYCLE_REASON_CODES = [
  "OFFER_LIFECYCLE_TRANSITION_NOT_PERMITTED",
  "OFFER_LIFECYCLE_TERMINAL",
] as const satisfies readonly OfferReasonCode[];

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
 * May the Seller be offered this act? Allowed, or refused ONLY because the
 * exact-version confirmation is not yet in hand — which the two-step exchange
 * supplies. Any other reason is a refusal the act would meet deterministically.
 */
export function isOfferActionAvailable(decision: OfferAuthorityDecision): boolean {
  return (
    decision.decision === "ALLOW" ||
    decision.reasonCodes.every((r) => (OFFER_CONFIRMATION_REASON_CODES as readonly string[]).includes(r))
  );
}

/**
 * What an Offer authority decision may consider.
 *
 * `hasProductAuthority` stays a supplied *input to this pure decision* — the
 * Product model owns the question, and re-deriving it here would put two
 * answers in the repository that could disagree. Its **provenance** is the
 * Offer service, which reads it from the Product's current source version
 * (`participantHoldsProductAuthority`, Phase 1.18); no caller input carries it.
 */
export const OfferAuthorityRequest = z.strictObject({
  subject: MarketplaceSubject,
  /** The Seller participant that controls the Offer. */
  offerSellerParticipantId: MarketplaceParticipantId,
  /** Whether the subject holds authority over the referenced Product. */
  hasProductAuthority: z.boolean(),
});
export type OfferAuthorityRequest = z.infer<typeof OfferAuthorityRequest>;

/** A request about an Offer that already exists, and therefore has a DERIVED state. */
export const OfferLifecycleActionRequest = OfferAuthorityRequest.extend({
  lifecycle: OfferLifecycleState,
  /**
   * The version and terms being confirmed, plus the Seller's confirmation of
   * the economics they were shown. Supplied for activation, a live terms
   * revision, and scheduling a promotion; absent elsewhere, because standing an
   * Offer down asserts nothing about its economics.
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

const CONFIRMATION_REASON_BY_MISMATCH: Record<ConfirmationMismatchReason, OfferReasonCode> = {
  CONFIRMATION_MISSING: "CREATOR_ECONOMICS_NOT_CONFIRMED",
  CONFIRMATION_SOURCE_RECORD_MISMATCH: "CREATOR_CONFIRMATION_SOURCE_RECORD_MISMATCH",
  CONFIRMATION_VERSION_MISMATCH: "CREATOR_CONFIRMATION_VERSION_MISMATCH",
  CONFIRMATION_AMOUNTS_STALE: "CREATOR_CONFIRMATION_STALE",
  CONFIRMATION_POLICY_VERSION_MISMATCH: "CREATOR_CONFIRMATION_POLICY_MISMATCH",
};

/**
 * The Seller must have confirmed **this exact version's** economics.
 *
 * A material change mints a new version, so a confirmation bound to the
 * previous one stops matching by construction — the Seller has to look again
 * before the new terms can sell.
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
 * A lifecycle act: the gate it names, matching Seller authority always, Product
 * authority where the act makes the Offer live, and the governed transition.
 */
function evaluateLifecycleAct(
  capability: OfferCapability,
  act: OfferLifecycleAct,
  request: OfferLifecycleActionRequest,
  options: { requiresProductAuthority: boolean },
): OfferAuthorityDecision {
  const problem = draftingProblem(request.subject);
  if (problem) return deny(capability, problem);
  if (!sellerMatches(request)) return deny(capability, "SELLER_PARTICIPANT_MISMATCH");
  if (options.requiresProductAuthority && !request.hasProductAuthority) {
    return deny(capability, "PRODUCT_AUTHORITY_REQUIRED");
  }
  const transition = decideOfferLifecycleAct(request.lifecycle, act);
  if (transition.outcome === "REFUSED") return deny(capability, transition.reason);
  return allow(capability);
}

/**
 * Taking a DRAFT Offer live: Seller and Product authority, the governed
 * transition, and the Seller's exact-version confirmation of the STANDING
 * version being activated.
 *
 * Commerce READINESS — Product ACTIVE, verified email, declared names,
 * participant and SELLER role ACTIVE, no suspension, commerce approval, payment
 * ENABLED, no `offer:publish` restriction — is decided separately by
 * `evaluateOfferActivationReadiness`, which reports every blocker rather than the
 * first. Neither resale availability, Promotion Authorization, a Storefront, a
 * Listing, nor any Promoter fact is a condition.
 */
export function canActivateOffer(request: OfferLifecycleActionRequest): OfferAuthorityDecision {
  const gated = evaluateLifecycleAct("offer:activate", "ACTIVATE", request, {
    requiresProductAuthority: true,
  });
  if (!isOfferActionAllowed(gated)) return gated;
  const confirmation = creatorConfirmationProblem(request);
  return confirmation === undefined ? gated : deny("offer:activate", confirmation);
}

/** Resuming a PAUSED Offer — live again, so the same authority and readiness as activation. */
export function canResumeOffer(request: OfferLifecycleActionRequest): OfferAuthorityDecision {
  return evaluateLifecycleAct("offer:resume", "RESUME", request, { requiresProductAuthority: true });
}

/**
 * Pausing and withdrawing **stand down** a commercial commitment.
 *
 * They deliberately do not require payment readiness or Product authority: a
 * seller whose payment capability was just restricted must still be able to take
 * their Offer down. Requiring an intact commerce gate to *stop* selling would
 * trap the exact seller who most needs to stop.
 */
export function canPauseOffer(request: OfferLifecycleActionRequest): OfferAuthorityDecision {
  return evaluateLifecycleAct("offer:pause", "PAUSE", request, { requiresProductAuthority: false });
}

export function canWithdrawOffer(request: OfferLifecycleActionRequest): OfferAuthorityDecision {
  return evaluateLifecycleAct("offer:withdraw", "WITHDRAW", request, { requiresProductAuthority: false });
}

/**
 * Revising the STANDING terms.
 *
 * On a `DRAFT` it faces only the drafting gates — that is what drafting is for.
 * On an `ACTIVE` or `PAUSED` Offer it is a commercial act: the full commerce
 * gates, and the Seller's confirmation of the exact version being minted.
 * (Whether a promotion is pending is the service's question; it refuses then.)
 * Terminal Offers refuse outright: their terms are history.
 */
export function canChangeOfferTerms(request: OfferLifecycleActionRequest): OfferAuthorityDecision {
  const capability = "offer:terms:change" as const;
  const live = request.lifecycle === "ACTIVE" || request.lifecycle === "PAUSED";
  const problem = live ? commerceProblem(request.subject) : draftingProblem(request.subject);
  if (problem) return deny(capability, problem);
  if (!sellerMatches(request)) return deny(capability, "SELLER_PARTICIPANT_MISMATCH");
  if (!request.hasProductAuthority) return deny(capability, "PRODUCT_AUTHORITY_REQUIRED");
  if (isTerminalOfferLifecycleState(request.lifecycle)) {
    return deny(capability, "OFFER_LIFECYCLE_TERMINAL");
  }
  if (live) {
    const confirmation = creatorConfirmationProblem(request);
    if (confirmation !== undefined) return deny(capability, confirmation);
  }
  return allow(capability);
}

/**
 * Scheduling (or replacing) a promotion: an activated, non-terminal Offer —
 * `ACTIVE` or `PAUSED` — the full commerce gates, Product authority, and the
 * Seller's confirmation of the exact promotion version being minted.
 */
export function canSchedulePromotion(request: OfferLifecycleActionRequest): OfferAuthorityDecision {
  const capability = "offer:promotion:schedule" as const;
  const problem = commerceProblem(request.subject);
  if (problem) return deny(capability, problem);
  if (!sellerMatches(request)) return deny(capability, "SELLER_PARTICIPANT_MISMATCH");
  if (!request.hasProductAuthority) return deny(capability, "PRODUCT_AUTHORITY_REQUIRED");
  if (isTerminalOfferLifecycleState(request.lifecycle)) {
    return deny(capability, "OFFER_LIFECYCLE_TERMINAL");
  }
  if (request.lifecycle === "DRAFT") return deny(capability, "OFFER_LIFECYCLE_TRANSITION_NOT_PERMITTED");
  const confirmation = creatorConfirmationProblem(request);
  return confirmation === undefined ? allow(capability) : deny(capability, confirmation);
}

/**
 * Ending a running promotion early returns the Offer to standing terms the Seller
 * already confirmed — a stand-down, gated like pausing.
 */
export function canEndPromotion(request: OfferLifecycleActionRequest): OfferAuthorityDecision {
  const capability = "offer:promotion:end" as const;
  const problem = draftingProblem(request.subject);
  if (problem) return deny(capability, problem);
  if (!sellerMatches(request)) return deny(capability, "SELLER_PARTICIPANT_MISMATCH");
  if (isTerminalOfferLifecycleState(request.lifecycle)) {
    return deny(capability, "OFFER_LIFECYCLE_TERMINAL");
  }
  if (request.lifecycle === "DRAFT") return deny(capability, "OFFER_LIFECYCLE_TRANSITION_NOT_PERMITTED");
  return allow(capability);
}

// — Activation and resumption readiness (Phase 1.42) —

/**
 * Why an Offer may not become live yet — reported together, in this order, so a
 * Seller fixing one sees the rest. The Seller-standing codes are the Product
 * activation codes (one vocabulary), plus the two Offer-specific ones.
 */
export const OFFER_ACTIVATION_BLOCKERS = [
  "PRODUCT_NOT_ACTIVE",
  "EMAIL_UNVERIFIED",
  "FIRST_NAME_MISSING",
  "LAST_NAME_MISSING",
  "PARTICIPANT_MISSING",
  "PARTICIPANT_SUSPENDED",
  "PARTICIPANT_NOT_ACTIVE",
  "SELLER_ROLE_NOT_ACTIVE",
  "PAYMENT_NOT_READY",
  "COMMERCE_APPROVAL_MISSING",
  "OFFER_PUBLISH_RESTRICTED",
] as const;
export const OfferActivationBlocker = z.enum(OFFER_ACTIVATION_BLOCKERS);
export type OfferActivationBlocker = z.infer<typeof OfferActivationBlocker>;

/** The current facts activation and resumption readiness is decided on. */
export interface OfferActivationReadinessFacts {
  /** The Product's DERIVED lifecycle is ACTIVE. */
  productActive: boolean;
  account: { emailVerifiedAt: string | null; firstName: string | null; lastName: string | null };
  participant: {
    status: string;
    suspended: boolean;
    /** An ACTIVE `offer:publish` restriction exists. */
    offerPublishRestricted: boolean;
    sellerRoleStatus: string | null;
    paymentReadiness: string;
    commerceApproval: string;
  } | null;
}

const nonBlank = (value: string | null): boolean => value !== null && value.trim() !== "";

/**
 * Every readiness blocker that applies. Pure.
 *
 * Deliberately NOT conditions: resale availability, Promotion Authorization, a
 * Storefront, a Listing, and Promoter readiness. Those are other axes.
 */
export function evaluateOfferActivationReadiness(
  facts: OfferActivationReadinessFacts,
): { ready: boolean; blockers: OfferActivationBlocker[] } {
  const blockers: OfferActivationBlocker[] = [];
  if (!facts.productActive) blockers.push("PRODUCT_NOT_ACTIVE");
  if (facts.account.emailVerifiedAt === null) blockers.push("EMAIL_UNVERIFIED");
  if (!nonBlank(facts.account.firstName)) blockers.push("FIRST_NAME_MISSING");
  if (!nonBlank(facts.account.lastName)) blockers.push("LAST_NAME_MISSING");
  const participant = facts.participant;
  if (participant === null) {
    blockers.push("PARTICIPANT_MISSING");
  } else {
    if (participant.suspended) blockers.push("PARTICIPANT_SUSPENDED");
    if (participant.status !== "ACTIVE") blockers.push("PARTICIPANT_NOT_ACTIVE");
    if (participant.sellerRoleStatus !== "ACTIVE") blockers.push("SELLER_ROLE_NOT_ACTIVE");
    if (participant.paymentReadiness !== "ENABLED") blockers.push("PAYMENT_NOT_READY");
    if (participant.commerceApproval !== "APPROVED") blockers.push("COMMERCE_APPROVAL_MISSING");
    if (participant.offerPublishRestricted) blockers.push("OFFER_PUBLISH_RESTRICTED");
  }
  return { ready: blockers.length === 0, blockers };
}
