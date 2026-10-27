/**
 * The browser half of the Seller's Offer acts (Phase 1.42) — pure, `fetch`
 * injected.
 *
 * Each call sends the Product and Offer references in the path and only what
 * the Seller states in the body: terms as typed (decimal strings — converted on
 * the server, never here), a window, the version they were looking at, and their
 * confirmation of the exact economics the server disclosed. No participant,
 * lifecycle, version to mint, or economics the server must trust.
 *
 * ## Confirmation is a two-step exchange
 *
 * A write that mints a version the Seller has not confirmed is refused with
 * `OFFER_CONFIRMATION_STALE` and the server's own `disclosure` for the exact
 * version it would mint. That comes back here as `{ outcome: "confirm" }`; the
 * page shows it, and only an explicit confirm resends with it. Nothing is
 * computed in the browser.
 */

import type { OfferActivationBlocker } from "../../src/contracts/marketplace/offer-source";
import { formatOfferBlocker } from "./account-home-copy";

const base = (productRef: string): string => `/api/products/${encodeURIComponent(productRef)}/offers`;
const offerBase = (productRef: string, offerRef: string): string =>
  `${base(productRef)}/${encodeURIComponent(offerRef)}`;

export const offerCreateEndpoint = base;
export const offerActEndpoint = (
  productRef: string,
  offerRef: string,
  act: "revise" | "activate" | "pause" | "resume" | "withdraw" | "promotions" | "promotions/replace" | "promotions/end",
): string => `${offerBase(productRef, offerRef)}/${act}`;

export const OFFER_INVALID = "Check the amounts and dates. Prices are in US dollars, like 19.99; commission is a percentage like 10, or an amount.";
export const OFFER_NOT_FOUND = "That offer isn't available. Reload the page.";
export const OFFER_PRODUCT_NOT_AVAILABLE = "We couldn't find that product.";
export const OFFER_NOT_PERMITTED = "That change isn't available on your account right now.";
export const OFFER_ALREADY_EXISTS = "This product already has an offer. Reload the page.";
export const OFFER_STALE = "This offer changed since the page loaded. Reload and try again.";
export const OFFER_TRANSITION = "That change isn't available for this offer's current state. Reload the page.";
export const OFFER_NO_CHANGE = "Those are already the offer's terms.";
export const OFFER_PROMOTION_PENDING = "A promotion is scheduled or running. End or wait for it before changing terms or scheduling another.";
export const OFFER_PROMOTION_NOT_REPLACEABLE = "That promotion has already started and can't be replaced. You can end it early.";
export const OFFER_PROMOTION_NOT_RUNNING = "That promotion isn't running.";
export const OFFER_CONFLICT = "This offer changed while you were updating it. Reload and try again.";
export const OFFER_SIGNED_OUT = "Your session has ended. Please sign in again.";
export const OFFER_FAILURE = "Unable to update the offer. Please try again.";

const MESSAGES: Record<string, string> = {
  INVALID_OFFER_REQUEST: OFFER_INVALID,
  PRODUCT_NOT_AVAILABLE: OFFER_PRODUCT_NOT_AVAILABLE,
  OFFER_NOT_FOUND: OFFER_NOT_FOUND,
  OFFER_NOT_PERMITTED: OFFER_NOT_PERMITTED,
  OFFER_ALREADY_EXISTS: OFFER_ALREADY_EXISTS,
  OFFER_VERSION_STALE: OFFER_STALE,
  OFFER_CONFIRMATION_STALE: OFFER_STALE,
  OFFER_TRANSITION_NOT_PERMITTED: OFFER_TRANSITION,
  OFFER_NO_MATERIAL_CHANGE: OFFER_NO_CHANGE,
  OFFER_PROMOTION_PENDING: OFFER_PROMOTION_PENDING,
  OFFER_PROMOTION_NOT_REPLACEABLE: OFFER_PROMOTION_NOT_REPLACEABLE,
  OFFER_PROMOTION_NOT_RUNNING: OFFER_PROMOTION_NOT_RUNNING,
  OFFER_CONFLICT: OFFER_CONFLICT,
};

/** The server's disclosure of the exact version a write would mint. */
export interface OfferDisclosure {
  version: string;
  calculatedCommissionMinorUnits: number;
  calculatedSellerGrossProceedsMinorUnits: number;
  commissionCalculationPolicyVersion: string;
}

export type OfferOutcome =
  | { outcome: "updated" }
  | { outcome: "confirm"; disclosure: OfferDisclosure }
  | { outcome: "failed"; message: string };

function isDisclosure(value: unknown): value is OfferDisclosure {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.version === "string" &&
    typeof v.calculatedCommissionMinorUnits === "number" &&
    typeof v.calculatedSellerGrossProceedsMinorUnits === "number" &&
    typeof v.commissionCalculationPolicyVersion === "string"
  );
}

export async function postOffer(
  url: string,
  body: Record<string, unknown>,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<OfferOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { outcome: "failed", message: OFFER_FAILURE };
  }
  if (response.ok) return { outcome: "updated" };
  if (response.status === 401) return { outcome: "failed", message: OFFER_SIGNED_OUT };

  let parsed: { error?: unknown; disclosure?: unknown; blockers?: unknown } = {};
  try {
    parsed = (await response.json()) as typeof parsed;
  } catch {
    parsed = {};
  }
  /* Only a confirmation that is missing or for another version is a question
     for the Seller; the disclosure is the server's answer to it. */
  if (parsed.error === "OFFER_CONFIRMATION_STALE" && isDisclosure(parsed.disclosure)) {
    return { outcome: "confirm", disclosure: parsed.disclosure };
  }
  if (parsed.error === "OFFER_NOT_READY" && Array.isArray(parsed.blockers)) {
    return {
      outcome: "failed",
      message: formatOfferBlocker(parsed.blockers as OfferActivationBlocker[]) ?? OFFER_FAILURE,
    };
  }
  const message = typeof parsed.error === "string" ? MESSAGES[parsed.error] : undefined;
  return { outcome: "failed", message: message ?? OFFER_FAILURE };
}

/** The confirmation body for a disclosure the Seller accepted — echoed, never computed. */
export function confirmationFrom(disclosure: OfferDisclosure): Record<string, unknown> {
  return {
    version: disclosure.version,
    calculatedCommissionMinorUnits: disclosure.calculatedCommissionMinorUnits,
    calculatedSellerGrossProceedsMinorUnits: disclosure.calculatedSellerGrossProceedsMinorUnits,
    commissionCalculationPolicyVersion: disclosure.commissionCalculationPolicyVersion,
  };
}

/** Terms as typed. Blank fields are caught here; everything else on the server. */
export interface OfferTermsFields {
  wholesalePrice: string;
  commissionMethod: "PERCENT_OF_WHOLESALE" | "FIXED_AMOUNT";
  commissionValue: string;
}

export function termsBody(fields: OfferTermsFields): Record<string, unknown> | null {
  const wholesalePrice = fields.wholesalePrice.trim();
  const value = fields.commissionValue.trim();
  if (wholesalePrice === "" || value === "") return null;
  return {
    wholesalePrice,
    currency: "USD",
    commission:
      fields.commissionMethod === "PERCENT_OF_WHOLESALE"
        ? { method: "PERCENT_OF_WHOLESALE", percent: value }
        : { method: "FIXED_AMOUNT", amount: value },
  };
}

/**
 * A `datetime-local` value ("2026-11-01T09:00"), read in the browser's own time
 * zone, as a UTC instant. `null` when blank or unreadable.
 */
export function instantFromLocal(value: string): string | null {
  if (value.trim() === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
