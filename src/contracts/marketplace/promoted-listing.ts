/**
 * Promoted Listings (Phase 1.45, Contract §13, §14, §15, §16.3, §18, §19) — pure.
 *
 * A promoted Listing is the Promoter's placement of a Seller's Product in a
 * Storefront the Promoter controls, at a retail price the Promoter sets. It is
 * a `PackagePromotedPlacement`: it NAMES NO OFFER. Its authority is derived at
 * an instant from records Phases 1.41–1.44 already keep:
 *
 *   Product → current Promotion Authorization cycle (APPROVED)
 *           → acceptance covering the Seller terms in force → Listing
 *
 * So a Seller revision, a promotion starting or ending, a revocation, or a
 * re-approval writes nothing on the Listing: the gate below simply answers
 * differently. Listing lifecycle is the Promoter's intent; commerce
 * effectiveness is derived.
 *
 * Three permissions, kept apart:
 *
 *   - **draft** — an APPROVED cycle, Promoter + Storefront authority, not
 *     self-promotion, no current placement. No price, payment readiness,
 *     commerce approval, terms in force, or acceptance is needed.
 *   - **activate** — everything in `decidePromotedListingCommerce` with
 *     purpose `ACTIVATION`, including the five-ACTIVE Storefront limit.
 *   - **transact** — the same gate with purpose `TRANSACTION`, at the instant
 *     of sale. Nothing consumes it yet: checkout refuses every promoted Listing
 *     until the transaction phase wires it.
 *
 * Economics: Monacado's retention is the supplied commercial policy (7.5% of
 * retail + $1.00 today, never a constant here); Promoter proceeds =
 * acquisition − wholesale + commission and may be zero, never negative (§18).
 * Wholesale and commission come from the governing Offer version in force —
 * the promotion while it runs, else the standing terms. Nothing is stored.
 */

import { z } from "zod";
import {
  ListingEconomicsError,
  ListingSourceRecordVersion,
  RetailPrice,
  calculatePromotedListingEconomics,
  minimumViablePromotedRetailPrice,
  type ListingLifecycleState,
  type MonacadoWholesaleAcquisitionPolicy,
  type PromotedListingEconomics,
} from "./listing-source";
import { ListingRef, ProductRef } from "./listing-record";
import { PublicHandle } from "./storefront-source";
import type {
  PromotedTermsBlocker,
  PromotedTermsEligibility,
  RecordedOfferAcceptance,
} from "./promotion-offer-acceptance";

const ActingAccountId = z.string().min(1).max(191);

// — Inputs —

/**
 * Create a promoted DRAFT. Two selectors and an optional price; the Promoter
 * is resolved from the session, and nothing names an Offer, a version, a
 * cycle, or an acceptance — those are derived.
 */
export const CreatePromotedListingDraftInput = z.strictObject({
  productRef: ProductRef,
  storefrontHandle: PublicHandle,
  /** Optional: a promoted draft may be unpriced (owner ruling, Phase 1.45). */
  retail: RetailPrice.nullable().optional(),
  actingAccountId: ActingAccountId,
  now: z.iso.datetime(),
});
export type CreatePromotedListingDraftInput = z.infer<typeof CreatePromotedListingDraftInput>;

/** Set or change the retail price of the Promoter's own DRAFT or ACTIVE Listing. */
export const SetPromotedListingPriceInput = z.strictObject({
  listingRef: ListingRef,
  retail: RetailPrice,
  actingAccountId: ActingAccountId,
  now: z.iso.datetime(),
});
export type SetPromotedListingPriceInput = z.infer<typeof SetPromotedListingPriceInput>;

/**
 * Activate the Promoter's own DRAFT. `expectedVersion` is the Listing version
 * the Promoter was shown: a price change in between is a 409, never a silent
 * activation of a different price.
 */
export const ActivatePromotedListingInput = z.strictObject({
  listingRef: ListingRef,
  expectedVersion: ListingSourceRecordVersion,
  actingAccountId: ActingAccountId,
  now: z.iso.datetime(),
});
export type ActivatePromotedListingInput = z.infer<typeof ActivatePromotedListingInput>;

/** Withdraw the Promoter's own DRAFT or ACTIVE Listing. A stand-down: never gated. */
export const WithdrawPromotedListingInput = z.strictObject({
  listingRef: ListingRef,
  actingAccountId: ActingAccountId,
  now: z.iso.datetime(),
});
export type WithdrawPromotedListingInput = z.infer<typeof WithdrawPromotedListingInput>;

// — Promoter readiness —

/**
 * Why the Promoter itself may not sell (Contract §5, §16.3(5)). The same
 * vocabulary as Offer activation's Seller readiness, with the PROMOTER role.
 */
export const PROMOTER_READINESS_BLOCKERS = [
  "EMAIL_UNVERIFIED",
  "FIRST_NAME_MISSING",
  "LAST_NAME_MISSING",
  "PARTICIPANT_MISSING",
  "PARTICIPANT_SUSPENDED",
  "PARTICIPANT_NOT_ACTIVE",
  "PROMOTER_ROLE_NOT_ACTIVE",
  "PAYMENT_NOT_READY",
  "COMMERCE_APPROVAL_MISSING",
  "PARTICIPANT_RESTRICTED",
] as const;
export type PromoterReadinessBlocker = (typeof PROMOTER_READINESS_BLOCKERS)[number];

export interface PromoterReadinessFacts {
  account: { emailVerifiedAt: string | null; firstName: string | null; lastName: string | null };
  participant: {
    status: string;
    suspended: boolean;
    /** A governed restriction withholds this purpose (see the server reader). */
    restricted: boolean;
    promoterRoleStatus: string | null;
    paymentReadiness: string;
    commerceApproval: string;
  } | null;
}

const nonBlank = (value: string | null): boolean => value !== null && value.trim() !== "";

/** Every Promoter readiness blocker that applies. Pure. */
export function evaluatePromoterReadiness(facts: PromoterReadinessFacts): PromoterReadinessBlocker[] {
  const blockers: PromoterReadinessBlocker[] = [];
  if (facts.account.emailVerifiedAt === null) blockers.push("EMAIL_UNVERIFIED");
  if (!nonBlank(facts.account.firstName)) blockers.push("FIRST_NAME_MISSING");
  if (!nonBlank(facts.account.lastName)) blockers.push("LAST_NAME_MISSING");
  const p = facts.participant;
  if (p === null) {
    blockers.push("PARTICIPANT_MISSING");
    return blockers;
  }
  if (p.suspended) blockers.push("PARTICIPANT_SUSPENDED");
  if (p.status !== "ACTIVE") blockers.push("PARTICIPANT_NOT_ACTIVE");
  if (p.promoterRoleStatus !== "ACTIVE") blockers.push("PROMOTER_ROLE_NOT_ACTIVE");
  if (p.paymentReadiness !== "ENABLED") blockers.push("PAYMENT_NOT_READY");
  if (p.commerceApproval !== "APPROVED") blockers.push("COMMERCE_APPROVAL_MISSING");
  if (p.restricted) blockers.push("PARTICIPANT_RESTRICTED");
  return blockers;
}

// — Retail economics —

/** Why a retail price does not work under the governing terms. */
export const RETAIL_ECONOMICS_BLOCKERS = [
  "RETAIL_PRICE_MISSING",
  "NO_EFFECTIVE_COMMERCIAL_POLICY",
  "RETAIL_CURRENCY_MISMATCH",
  "NEGATIVE_PROMOTER_PROCEEDS",
  "RETAIL_ECONOMICS_NOT_VIABLE",
] as const;
export type RetailEconomicsBlocker = (typeof RETAIL_ECONOMICS_BLOCKERS)[number];

/** The Seller terms the economics are computed against: one exact Offer version. */
export interface GoverningOfferTerms {
  /** The exact version whose wholesale and commission apply (P while it runs, else S). */
  sourceRecordVersion: string;
  wholesalePriceMinorUnits: number;
  currency: string;
  /** The Offer's own calculated commission for that version — never recomputed. */
  calculatedCommissionMinorUnits: number;
}

export type RetailEconomicsResult =
  | {
      ok: true;
      economics: PromotedListingEconomics;
      /** The lowest price at which Promoter proceeds are not negative. */
      minimumViableRetailMinorUnits: number;
    }
  | { ok: false; blocker: RetailEconomicsBlocker; minimumViableRetailMinorUnits: number | null };

/**
 * One authoritative calculation for a promoted retail price, under the
 * governing terms and the supplied policy, with the policy's own half-up
 * rounding. Zero Promoter proceeds pass; negative are refused (§18).
 */
export function evaluatePromotedRetail(input: {
  retail: { retailPriceMinorUnits: number; retailPriceCurrency: string } | null;
  terms: GoverningOfferTerms;
  policy: MonacadoWholesaleAcquisitionPolicy | null;
}): RetailEconomicsResult {
  const { terms, policy } = input;
  let minimum: number | null = null;
  if (policy !== null && policy.currency === terms.currency) {
    try {
      minimum = minimumViablePromotedRetailPrice({
        offerWholesalePriceMinorUnits: terms.wholesalePriceMinorUnits,
        sellerFundedCommissionMinorUnits: terms.calculatedCommissionMinorUnits,
        currency: terms.currency,
        policy,
      });
    } catch (error) {
      if (!(error instanceof ListingEconomicsError)) throw error;
    }
  }
  const refuse = (blocker: RetailEconomicsBlocker): RetailEconomicsResult => ({
    ok: false,
    blocker,
    minimumViableRetailMinorUnits: minimum,
  });

  if (input.retail === null) return refuse("RETAIL_PRICE_MISSING");
  if (policy === null) return refuse("NO_EFFECTIVE_COMMERCIAL_POLICY");
  if (input.retail.retailPriceCurrency !== terms.currency || policy.currency !== terms.currency) {
    return refuse("RETAIL_CURRENCY_MISMATCH");
  }
  try {
    const economics = calculatePromotedListingEconomics({
      commercialRetailPriceMinorUnits: input.retail.retailPriceMinorUnits,
      currency: input.retail.retailPriceCurrency,
      offerWholesalePriceMinorUnits: terms.wholesalePriceMinorUnits,
      offerWholesalePriceCurrency: terms.currency,
      sellerFundedCommissionMinorUnits: terms.calculatedCommissionMinorUnits,
      policy,
    });
    return { ok: true, economics, minimumViableRetailMinorUnits: minimum ?? 0 };
  } catch (error) {
    if (!(error instanceof ListingEconomicsError)) throw error;
    /* A price below the fixed retention leaves a negative acquisition, which is
       negative Promoter proceeds too — one answer for the Promoter. */
    if (error.code === "NEGATIVE_PROMOTER_PROCEEDS" || error.code === "NEGATIVE_ACQUISITION_AMOUNT") {
      return refuse("NEGATIVE_PROMOTER_PROCEEDS");
    }
    return refuse("RETAIL_ECONOMICS_NOT_VIABLE");
  }
}

// — The promoted-Listing commerce gate —

/**
 * Every reason a promoted Listing may not activate or transact, in this order.
 * A closed vocabulary; every applicable one is reported, never just the first.
 */
export const PROMOTED_LISTING_BLOCKERS = [
  "LISTING_NOT_DRAFT",
  "LISTING_NOT_ACTIVE",
  "PRODUCT_NOT_ACTIVE",
  "RESALE_NOT_AVAILABLE",
  "NO_OFFER_TERMS_IN_FORCE",
  "AUTHORIZATION_NOT_APPROVED",
  "SELF_PROMOTION",
  "TERMS_NOT_ACCEPTED",
  "STOREFRONT_AUTHORITY_REQUIRED",
  "STOREFRONT_OWNED_BY_SELLER",
  ...PROMOTER_READINESS_BLOCKERS,
  "SELLER_NOT_PERMITTED",
  ...RETAIL_ECONOMICS_BLOCKERS,
  "STOREFRONT_ACTIVE_LISTING_LIMIT",
  "STOREFRONT_NOT_PUBLICLY_ACCESSIBLE",
] as const;
export type PromotedListingBlocker = (typeof PROMOTED_LISTING_BLOCKERS)[number];

/** Gates this decision does not evaluate. Always returned, so a pass is never mistaken for more. */
export const PROMOTED_LISTING_NOT_EVALUATED = ["CROSS_ACCOUNT_ECONOMIC_PRINCIPAL", "TRANSACTION_CONDITIONS"] as const;
export type PromotedListingNotEvaluated = (typeof PROMOTED_LISTING_NOT_EVALUATED)[number];

export type PromotedListingPurpose = "ACTIVATION" | "TRANSACTION";

export interface PromotedListingCommerceFacts<A extends RecordedOfferAcceptance> {
  purpose: PromotedListingPurpose;
  lifecycle: ListingLifecycleState;
  /** The Listing carries a retail price (§15: an unpriced Listing cannot be ACTIVE). */
  retailPresent: boolean;
  /** The 1.44 promoted-terms decision for this Product + Promoter at the instant. */
  terms: PromotedTermsEligibility<A>;
  storefront: {
    controllerHasAuthority: boolean;
    ownedBySeller: boolean;
    /** TRANSACTION only. */
    publiclyAccessible: boolean;
    /** ACTIVATION only: ACTIVE Listings already in this Storefront. */
    activeListingCount: number;
  };
  promoterReadiness: readonly PromoterReadinessBlocker[];
  /** TRANSACTION only: the Seller's governed standing permits a new sale. */
  sellerMayTransact: boolean;
  /** `null` when no Seller terms are in force (already a terms blocker). */
  economics: RetailEconomicsResult | null;
  activeListingAllowance: number;
}

export type PromotedListingCommerceDecision = {
  notEvaluated: readonly PromotedListingNotEvaluated[];
  blockers: PromotedListingBlocker[];
  eligible: boolean;
};

/**
 * May this promoted Listing activate (purpose `ACTIVATION`) or transact
 * (purpose `TRANSACTION`) at the instant its facts were read? Pure; reports
 * every blocker. Storefront exposure is a transaction condition only — a Listing
 * may be ACTIVE in a Storefront that is not yet live — and the five-ACTIVE
 * limit applies only to a new activation.
 */
export function decidePromotedListingCommerce<A extends RecordedOfferAcceptance>(
  facts: PromotedListingCommerceFacts<A>,
): PromotedListingCommerceDecision {
  const blockers: PromotedListingBlocker[] = [];
  const activation = facts.purpose === "ACTIVATION";
  if (activation && facts.lifecycle !== "DRAFT") blockers.push("LISTING_NOT_DRAFT");
  if (!activation && facts.lifecycle !== "ACTIVE") blockers.push("LISTING_NOT_ACTIVE");
  if (!facts.retailPresent) blockers.push("RETAIL_PRICE_MISSING");
  if (!facts.terms.eligible) blockers.push(...(facts.terms.blockers as PromotedTermsBlocker[]));
  if (!facts.storefront.controllerHasAuthority) blockers.push("STOREFRONT_AUTHORITY_REQUIRED");
  if (facts.storefront.ownedBySeller) blockers.push("STOREFRONT_OWNED_BY_SELLER");
  blockers.push(...facts.promoterReadiness);
  if (!activation && !facts.sellerMayTransact) blockers.push("SELLER_NOT_PERMITTED");
  if (facts.economics !== null && !facts.economics.ok) blockers.push(facts.economics.blocker);
  if (activation && facts.storefront.activeListingCount >= facts.activeListingAllowance) {
    blockers.push("STOREFRONT_ACTIVE_LISTING_LIMIT");
  }
  if (!activation && !facts.storefront.publiclyAccessible) blockers.push("STOREFRONT_NOT_PUBLICLY_ACCESSIBLE");

  const ordered = PROMOTED_LISTING_BLOCKERS.filter((b) => blockers.includes(b));
  return { notEvaluated: PROMOTED_LISTING_NOT_EVALUATED, blockers: ordered, eligible: ordered.length === 0 };
}
