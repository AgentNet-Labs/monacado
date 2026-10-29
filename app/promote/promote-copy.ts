/**
 * Promotable Catalog wording (Phase 1.43).
 *
 * Loaded by client components (the card, load-more, the request button), so —
 * like `account-home-copy` — it takes only types from the zod contracts, never
 * a runtime import.
 *
 * A Seller appears as its mName and nothing else. Commission is shown as the
 * Offer states it: a percentage Offer as a percentage, a fixed Offer as an
 * amount — never a percentage worked out from an amount.
 */

import type { PromotableCatalogSort } from "../../src/contracts/marketplace/promotable-catalog";
import { formatRetailPrice } from "../account/account-home-copy";

export const CATALOG_TITLE = "Promotable products";
export const CATALOG_INTRO =
  "Products whose sellers are offering wholesale terms to promoters right now. Asking to promote one sends the seller a request; approval is permission only — nothing is for sale yet.";
export const CATALOG_NOT_PROMOTER =
  "The promotable catalog is for promoters. Start Promoter setup on your account page to browse it.";
export const CATALOG_ACCOUNT_LINK = "Back to your account";
export const CATALOG_EMPTY = "No products match.";
export const CATALOG_FILTERS_IGNORED = "Some filters weren't understood and were left out.";
export const CATALOG_LOAD_MORE = "Load more";
export const CATALOG_LOAD_MORE_FAILED = "Couldn't load more products. Please try again.";
export const CATALOG_APPLY = "Apply";
export const CATALOG_CLEAR = "Clear";

export const CATALOG_FIELD_LABELS = {
  q: "Search",
  deliveryMode: "Delivery",
  wholesaleMin: "Wholesale from ($)",
  wholesaleMax: "Wholesale to ($)",
  commissionMin: "Commission from ($)",
  commissionMax: "Commission to ($)",
  seller: "Seller mName",
  sort: "Sort",
} as const;

export const CATALOG_DELIVERY_ANY = "Any";
export const CATALOG_DELIVERY_LABELS = { PHYSICAL: "Physical", DIGITAL: "Digital" } as const;

export const CATALOG_SORT_LABELS: Readonly<Record<PromotableCatalogSort, string>> = {
  NEWEST: "Newest",
  NAME: "Name: A–Z",
  SELLER: "Seller: A–Z",
  WHOLESALE_LOW: "Wholesale: lowest",
  WHOLESALE_HIGH: "Wholesale: highest",
  COMMISSION_HIGH: "Commission: highest",
  COMMISSION_LOW: "Commission: lowest",
};

type Commission =
  | { method: "PERCENT_OF_WHOLESALE"; commissionBasisPoints: number }
  | { method: "FIXED_AMOUNT"; fixedCommissionMinorUnits: number };

/** "10%", "12.5%", "0.25%" — basis points as a percentage, with no trailing zeros. */
export function formatBasisPoints(basisPoints: number): string {
  return `${Number((basisPoints / 100).toFixed(2))}%`;
}

/** The card's commission: "Commission 10%" or "Commission $5.00". */
export function formatCatalogCommission(commission: Commission, currency: string): string {
  return commission.method === "PERCENT_OF_WHOLESALE"
    ? `Commission ${formatBasisPoints(commission.commissionBasisPoints)}`
    : `Commission ${formatRetailPrice(commission.fixedCommissionMinorUnits, currency)}`;
}

/** The detail page's commission: "10% ($4.00)" or "$5.00". */
export function formatCatalogCommissionDetail(
  commission: Commission,
  calculatedCommissionMinorUnits: number,
  currency: string,
): string {
  return commission.method === "PERCENT_OF_WHOLESALE"
    ? `${formatBasisPoints(commission.commissionBasisPoints)} (${formatRetailPrice(calculatedCommissionMinorUnits, currency)})`
    : formatRetailPrice(commission.fixedCommissionMinorUnits, currency);
}

/** "Wholesale $40.00 · Commission 10%". */
export function formatCatalogTermsLine(terms: {
  wholesalePriceMinorUnits: number;
  currency: string;
  commission: Commission;
}): string {
  return `Wholesale ${formatRetailPrice(terms.wholesalePriceMinorUnits, terms.currency)} · ${formatCatalogCommission(terms.commission, terms.currency)}`;
}

export const CATALOG_PROMOTION_BADGE = "Promotion";

/**
 * Phase 1.44 — a promotion beside the standard terms, by its window: "in force
 * now" while running, or when it starts. Never "better", "worse", or a "deal":
 * Monacado shows the exact terms and the Promoter decides.
 */
export function formatCatalogPromotionWindow(promotion: { effectiveFrom: string; effectiveUntil: string; inForce: boolean }): string {
  const window = `${formatCatalogDate(promotion.effectiveFrom)} to ${formatCatalogDate(promotion.effectiveUntil)}`;
  return promotion.inForce ? `in force now, ${window}` : window;
}

/** A date as the catalog shows it, in UTC so the server and browser agree. */
export function formatCatalogDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(iso));
}

export const CATALOG_AUTHORIZATION_LABELS = {
  NONE: "Request to promote",
  REQUESTED: "Request pending",
  APPROVED: "Approved to promote",
} as const;

// — Detail —

export const DETAIL_BACK = "Back to promotable products";
export const DETAIL_SELLER = "Seller";
export const DETAIL_MORE_FROM_SELLER = "More from this seller";
export const DETAIL_DELIVERY = "Delivery";
export const DETAIL_WHOLESALE = "Wholesale";
export const DETAIL_COMMISSION = "Commission per sale";
export const DETAIL_STANDARD_TERMS = "Standard terms";
/** Phase 1.44 — a running promotion is marked as the terms in force; a scheduled one by its window. */
export const DETAIL_PROMOTION_HEADING = (promotion: { effectiveFrom: string; effectiveUntil: string; inForce: boolean }) =>
  promotion.inForce
    ? `Promotional terms — in force now, ${formatCatalogDate(promotion.effectiveFrom)} to ${formatCatalogDate(promotion.effectiveUntil)}`
    : `Upcoming promotional terms — ${formatCatalogDate(promotion.effectiveFrom)} to ${formatCatalogDate(promotion.effectiveUntil)}`;
export const DETAIL_STANDARD_RESUMES = "The standard terms apply again when the promotion ends.";
export const DETAIL_OFFER_ENDS = (iso: string) => `This offer ends ${formatCatalogDate(iso)}.`;
export const DETAIL_REQUEST_NOTE =
  "The seller decides. Approval lets you promote this product; it isn't an agreement to these terms, and nothing is for sale yet.";

// — Offer-package acceptance (Phase 1.44) —

export const ACCEPTANCE_HEADING = "Accept the seller's terms";
export const ACCEPTANCE_NOTE =
  "Accepting covers everything shown here together — you can't accept part of it. You set your own retail price on your listing; it isn't part of these terms.";
export const ACCEPT_STANDARD_LABEL = "Accept standard terms";
export const ACCEPT_PACKAGE_LABEL = "Accept standard + promotional terms";
export const ACCEPTANCE_VERSION_LABEL = "Terms version";

/**
 * Whether the package shown is accepted: exactly, or — with no promotion
 * pending — the standard terms, which are then the terms in force, are covered
 * by an earlier standard + promotional acceptance that included them. Nothing
 * is left to accept, so no accept action is offered.
 */
export function offerPackageAccepted(view: {
  promotion: unknown;
  acceptedAt: string | null;
  inForceCovered: boolean;
}): boolean {
  return view.acceptedAt !== null || (view.promotion === null && view.inForceCovered);
}

export const ACCEPTANCE_COVERED_BY_PACKAGE =
  "You've accepted these standard terms — your acceptance of the standard + promotional terms included them. No new acceptance is needed.";

/** Where the Promoter stands on the package shown — derived from the server's view, never stored. */
export function offerPackageStatus(view: {
  promotion: { effectiveFrom: string; inForce: boolean } | null;
  acceptedAt: string | null;
  hadEarlierAcceptance: boolean;
  inForceCovered: boolean;
}): string {
  if (view.acceptedAt === null && offerPackageAccepted(view)) return ACCEPTANCE_COVERED_BY_PACKAGE;
  if (view.acceptedAt !== null) {
    const when = formatCatalogDate(view.acceptedAt);
    if (view.promotion === null) return `You accepted the standard terms on ${when}.`;
    return view.promotion.inForce
      ? `You accepted the standard + promotional terms on ${when}. The promotional terms are in force now.`
      : `You accepted the standard + promotional terms on ${when}. The promotional terms start ${formatCatalogDate(view.promotion.effectiveFrom)}.`;
  }
  if (view.promotion?.inForce) {
    return "The promotional terms are in force now and you haven't accepted them. You aren't covered under the terms in force until you accept the standard + promotional terms.";
  }
  if (view.promotion !== null && view.inForceCovered) {
    return `You've accepted the standard terms. The promotional terms start ${formatCatalogDate(view.promotion.effectiveFrom)} and need your acceptance, together with the standard terms, to be covered while they're in force.`;
  }
  if (view.hadEarlierAcceptance) return "The seller's terms have changed. The new terms need your acceptance.";
  return "You haven't accepted these terms yet.";
}
