/**
 * Persisted Offer records (Phase 0M.6; Seller acts, Phase 1.42).
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
 *   3. **Product authority is derived from authoritative state, never supplied**
 *      (Phase 1.18). 0M.2A's reasoning is unchanged — authority over a Product
 *      is the Product model's question, and re-deriving it inside an Offer
 *      *decision* would put two answers in the repository that could disagree.
 *      What moved is where the answer comes from: `hasProductAuthority` was a
 *      member of both inputs below, so any caller could write `true`. The Offer
 *      service now reads it from the Product's current source version. There is
 *      no field here through which a caller can assert it.
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
import { ProductRef } from "./listing-record";
import { parseRetailAmount } from "./retail-amount";
import {
  CommissionCalculationPolicyVersion,
  MAX_MINOR_UNIT_AMOUNT,
  OfferRef,
  OfferSourceRecordVersion,
  PromotedResaleOfferTerms,
  type OfferCommercialTerms,
} from "./offer-source";

/**
 * Everything below is what a Seller states through an authenticated route
 * (Phase 1.42). **No member names who is acting**: the acting account comes from
 * the session, the Seller participant is derived from it, and Product authority
 * is read from the Product's current source version (Phase 1.18). No member
 * names a lifecycle, an economics figure the server must trust, a version label
 * to mint, a participant, or an internal id.
 */

// — Terms, as a Seller states them —

/**
 * Money arrives as the decimal a person typed ("19.99") and is converted HERE,
 * on the server, by the one exact converter (`parseRetailAmount`: string
 * surgery and BigInt, never a float, refused rather than rounded). A browser's
 * rounding never becomes an authoritative price — the Phase 1.36 convention.
 */
const DecimalAmount = z.string().trim().min(1).max(40);

/** A commission percentage as typed: "10", "12.5", "7.25". At most two decimals. */
const PERCENT_RE = /^(?:0|[1-9][0-9]{0,2})(?:\.[0-9]{1,2})?$/;

/**
 * The commission a Seller states: a percentage of the wholesale price, or a
 * fixed amount in the wholesale currency (the only one admitted, USD).
 */
export const OfferCommissionRequest = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("PERCENT_OF_WHOLESALE"), percent: DecimalAmount }),
  z.strictObject({ method: z.literal("FIXED_AMOUNT"), amount: DecimalAmount }),
]);
export type OfferCommissionRequest = z.infer<typeof OfferCommissionRequest>;

/** Standing terms as a Seller states them. */
export const OfferTermsRequest = z.strictObject({
  wholesalePrice: DecimalAmount,
  currency: z.literal("USD"),
  commission: OfferCommissionRequest,
});
export type OfferTermsRequest = z.infer<typeof OfferTermsRequest>;

/** "12.5" → 1250 basis points, by string surgery. `null` when malformed. */
export function percentToBasisPoints(percent: string): number | null {
  if (!PERCENT_RE.test(percent)) return null;
  const [integer, fraction = ""] = percent.split(".") as [string, string?];
  return Number(integer) * 100 + Number(fraction.padEnd(2, "0"));
}

/** One decimal amount in USD minor units, or `null` (malformed, zero, too precise, too large). */
export function usdMinorUnits(amount: string): number | null {
  const parsed = parseRetailAmount({ amount, currency: "USD" });
  return parsed.ok ? parsed.retail.retailPriceMinorUnits : null;
}

/**
 * Fold a Seller's terms into the contract's PAID + PROMOTABLE shape, or name the
 * fields that could not be converted. Cross-field rules (a fixed commission not
 * above the wholesale price, 1–10 000 basis points) are `PromotedResaleOfferTerms`'.
 */
export function standingTermsFromRequest(
  request: OfferTermsRequest,
): { ok: true; terms: unknown } | { ok: false; fields: string[] } {
  const wholesale = usdMinorUnits(request.wholesalePrice);
  const fields: string[] = [];
  if (wholesale === null) fields.push("terms.wholesalePrice");
  let commission: unknown = null;
  if (request.commission.method === "PERCENT_OF_WHOLESALE") {
    const bp = percentToBasisPoints(request.commission.percent);
    if (bp === null) fields.push("terms.commission.percent");
    else commission = { method: "PERCENT_OF_WHOLESALE", commissionBasisPoints: bp };
  } else {
    const fixed = usdMinorUnits(request.commission.amount);
    if (fixed === null) fields.push("terms.commission.amount");
    else commission = { method: "FIXED_AMOUNT", fixedCommissionMinorUnits: fixed, fixedCommissionCurrency: request.currency };
  }
  if (fields.length > 0) return { ok: false, fields };
  return {
    ok: true,
    terms: {
      price: { type: "PAID", wholesalePriceMinorUnits: wholesale, wholesalePriceCurrency: request.currency },
      promotion: { type: "PROMOTABLE", commission },
    },
  };
}

/**
 * A promotion's terms: the STANDING terms with only the wholesale price
 * replaced. The commission is the standing commission, unchanged — a commission
 * promotion is deferred.
 */
export function promotionTermsFrom(
  standing: OfferCommercialTerms,
  wholesalePriceMinorUnits: number,
): unknown {
  if (standing.price.type !== "PAID") return { price: { type: "FREE" }, promotion: standing.promotion };
  return {
    price: { ...standing.price, wholesalePriceMinorUnits },
    promotion: standing.promotion,
  };
}

export { PromotedResaleOfferTerms };

// — Exact-version confirmation, as a Seller sends it —

/**
 * What the Seller confirms: the exact version label and the economics they were
 * shown for it. The server pairs it with the Offer's own source-record id to
 * build a `CreatorEconomicsConfirmation`, so it cannot name another Offer.
 *
 * For a live revision or a promotion, `version` is the label the read model
 * advertised as `nextVersion` — the one the write will mint — so a concurrent
 * write that took that label makes the confirmation stale by construction.
 */
export const OfferVersionConfirmation = z.strictObject({
  version: OfferSourceRecordVersion,
  calculatedCommissionMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  calculatedSellerGrossProceedsMinorUnits: z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT),
  commissionCalculationPolicyVersion: CommissionCalculationPolicyVersion,
});
export type OfferVersionConfirmation = z.infer<typeof OfferVersionConfirmation>;

const Selectors = { productRef: ProductRef, offerRef: OfferRef };
const Instant = z.iso.datetime();

// — Acts —

/** Create a DRAFT Offer and its first STANDING version. */
export const CreateOfferInput = z.strictObject({
  productRef: ProductRef,
  terms: OfferTermsRequest,
  now: Instant,
});
export type CreateOfferInput = z.infer<typeof CreateOfferInput>;

/**
 * Revise the STANDING terms. `expectedVersion` is the standing version the
 * Seller was looking at; a confirmation is required unless the Offer is DRAFT.
 */
export const ReviseOfferTermsInput = z.strictObject({
  ...Selectors,
  expectedVersion: OfferSourceRecordVersion,
  terms: OfferTermsRequest,
  confirmation: OfferVersionConfirmation.nullable().optional(),
  now: Instant,
});
export type ReviseOfferTermsInput = z.infer<typeof ReviseOfferTermsInput>;

/**
 * Activate a DRAFT Offer, confirming the exact current STANDING version.
 * `effectiveUntil` is the optional overall end; once it passes, the Offer is
 * derived ENDED.
 */
export const ActivateOfferInput = z.strictObject({
  ...Selectors,
  confirmation: OfferVersionConfirmation,
  effectiveUntil: Instant.nullable().optional(),
  now: Instant,
});
export type ActivateOfferInput = z.infer<typeof ActivateOfferInput>;

/** Pause or withdraw: standing down asserts nothing about terms. */
export const StandDownOfferInput = z.strictObject({ ...Selectors, now: Instant });
export type StandDownOfferInput = z.infer<typeof StandDownOfferInput>;

/** Resume a PAUSED Offer under the standing version the Seller was looking at. */
export const ResumeOfferInput = z.strictObject({
  ...Selectors,
  expectedVersion: OfferSourceRecordVersion,
  now: Instant,
});
export type ResumeOfferInput = z.infer<typeof ResumeOfferInput>;

/** Schedule a promotion: a promotional wholesale price over a half-open window. */
export const SchedulePromotionInput = z.strictObject({
  ...Selectors,
  /** The STANDING version the promotion is built from. */
  expectedVersion: OfferSourceRecordVersion,
  /** The promotional wholesale price, as typed; converted on the server. */
  wholesalePrice: DecimalAmount,
  effectiveFrom: Instant,
  effectiveUntil: Instant,
  /** Absent on the first ask: the refusal then discloses what to confirm. */
  confirmation: OfferVersionConfirmation.nullable().optional(),
  now: Instant,
});
export type SchedulePromotionInput = z.infer<typeof SchedulePromotionInput>;

/** Replace the current promotion before it begins. History is kept. */
export const ReplacePromotionInput = SchedulePromotionInput.extend({
  expectedPromotionVersion: OfferSourceRecordVersion,
});
export type ReplacePromotionInput = z.infer<typeof ReplacePromotionInput>;

/** End the running promotion early; the standing terms apply at once. */
export const EndPromotionInput = z.strictObject({
  ...Selectors,
  expectedPromotionVersion: OfferSourceRecordVersion,
  now: Instant,
});
export type EndPromotionInput = z.infer<typeof EndPromotionInput>;

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
