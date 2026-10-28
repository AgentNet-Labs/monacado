/**
 * The browser half of Promotion Authorization (Phase 1.41) — pure, `fetch`
 * injected.
 *
 * Each call sends only the references in the path and, for a Seller decision,
 * the one decision word. Nothing else — no participant, state, Offer, price, or
 * commission — so a request cannot skip any server-side authority or
 * transition rule. A refusal reaches the person as one bounded sentence.
 *
 * Phase 1.44's acceptance is the one call with a body that restates terms: it
 * sends back exactly the package the server showed — the Offer reference, the
 * version labels, the economics, and the window — and the server refuses it
 * unless that is still exactly the package in force.
 */

import type {
  PromotionAuthorizationRequestRefusal,
  SellerPromotionAuthorizationDecision,
} from "../../src/contracts/marketplace/promotion-authorization";
import { formatPromotionRequestRefusals } from "./account-home-copy";

const base = (productRef: string): string =>
  `/api/products/${encodeURIComponent(productRef)}/promotion-authorization`;

export const promotionAuthorizationRequestEndpoint = (productRef: string): string => `${base(productRef)}/request`;
export const promotionAuthorizationDecisionEndpoint = (productRef: string, authorizationRef: string): string =>
  `${base(productRef)}/${encodeURIComponent(authorizationRef)}/decision`;
export const promotionAuthorizationCancelEndpoint = (productRef: string, authorizationRef: string): string =>
  `${base(productRef)}/${encodeURIComponent(authorizationRef)}/cancel`;
export const offerPackageAcceptanceEndpoint = (productRef: string, authorizationRef: string): string =>
  `${base(productRef)}/${encodeURIComponent(authorizationRef)}/offer-acceptance`;

export const PROMOTION_PRODUCT_REQUIRED = "Enter the product reference the seller shared with you.";
export const PROMOTION_PRODUCT_NOT_AVAILABLE = "We couldn't find that product.";
export const PROMOTION_NOT_FOUND = "That promotion request isn't available.";
export const PROMOTION_SELF = "You can't ask to promote your own product.";
export const PROMOTION_ALREADY_REQUESTED = "You've already asked to promote this product.";
export const PROMOTION_ALREADY_APPROVED = "You're already approved to promote this product.";
export const PROMOTION_NOT_GOVERNED = "That change isn't available for this request.";
export const PROMOTION_SUPERSEDED = "This request has been replaced by a newer one. Reload the page.";
export const PROMOTION_PROMOTER_NOT_ELIGIBLE =
  "This promoter can't be approved right now. The request stays pending.";
export const PROMOTION_CONFLICT = "This request changed while you were updating it. Reload the page and try again.";
export const PROMOTION_SIGNED_OUT = "Your session has ended. Please sign in again.";
export const PROMOTION_FAILURE = "Unable to update the promotion request. Please try again.";

export const ACCEPTANCE_NOT_APPROVED = "You're not currently approved to promote this product.";
export const ACCEPTANCE_PRODUCT_NOT_ACTIVE = "This product isn't active right now, so its terms can't be accepted.";
export const ACCEPTANCE_RESALE_NOT_OFFERED =
  "The seller isn't offering this product for resale, so its terms can't be accepted.";
export const ACCEPTANCE_OFFER_NOT_ACCEPTING =
  "The seller's terms aren't open for acceptance right now. Reload the page to see where things stand.";
export const ACCEPTANCE_STANDING_STALE =
  "The seller changed the standard terms. Nothing was accepted — reload the page to see the new terms.";
export const ACCEPTANCE_PROMOTION_CHANGED =
  "The seller changed the promotion. Nothing was accepted — reload the page to see the current terms.";
export const ACCEPTANCE_TERMS_MISMATCH =
  "These terms don't match the seller's current terms. Nothing was accepted — reload the page.";
export const ACCEPTANCE_FAILURE = "Unable to accept the terms. Please try again.";

export type PromotionAuthorizationOutcome = { outcome: "updated" } | { outcome: "failed"; message: string };

const MESSAGES: Record<string, string> = {
  PRODUCT_NOT_AVAILABLE: PROMOTION_PRODUCT_NOT_AVAILABLE,
  PROMOTION_AUTHORIZATION_NOT_FOUND: PROMOTION_NOT_FOUND,
  PROMOTION_AUTHORIZATION_SELF_PROMOTION: PROMOTION_SELF,
  PROMOTION_AUTHORIZATION_ALREADY_REQUESTED: PROMOTION_ALREADY_REQUESTED,
  PROMOTION_AUTHORIZATION_ALREADY_APPROVED: PROMOTION_ALREADY_APPROVED,
  PROMOTION_AUTHORIZATION_TRANSITION_NOT_GOVERNED: PROMOTION_NOT_GOVERNED,
  PROMOTION_AUTHORIZATION_SUPERSEDED: PROMOTION_SUPERSEDED,
  PROMOTION_AUTHORIZATION_PROMOTER_NOT_ELIGIBLE: PROMOTION_PROMOTER_NOT_ELIGIBLE,
  PROMOTION_AUTHORIZATION_CONFLICT: PROMOTION_CONFLICT,
  OFFER_ACCEPTANCE_AUTHORIZATION_NOT_APPROVED: ACCEPTANCE_NOT_APPROVED,
  OFFER_ACCEPTANCE_PRODUCT_NOT_ACTIVE: ACCEPTANCE_PRODUCT_NOT_ACTIVE,
  OFFER_ACCEPTANCE_RESALE_NOT_OFFERED: ACCEPTANCE_RESALE_NOT_OFFERED,
  OFFER_ACCEPTANCE_OFFER_NOT_ACCEPTING: ACCEPTANCE_OFFER_NOT_ACCEPTING,
  OFFER_ACCEPTANCE_STANDING_VERSION_STALE: ACCEPTANCE_STANDING_STALE,
  OFFER_ACCEPTANCE_PROMOTION_CHANGED: ACCEPTANCE_PROMOTION_CHANGED,
  OFFER_ACCEPTANCE_TERMS_MISMATCH: ACCEPTANCE_TERMS_MISMATCH,
};

async function post(
  url: string,
  body: Record<string, unknown>,
  deps: { fetchImpl?: typeof fetch },
  failure: string = PROMOTION_FAILURE,
): Promise<PromotionAuthorizationOutcome> {
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
    return { outcome: "failed", message: failure };
  }
  if (response.ok) return { outcome: "updated" };
  if (response.status === 401) return { outcome: "failed", message: PROMOTION_SIGNED_OUT };

  let parsed: { error?: unknown; refusals?: unknown } = {};
  try {
    parsed = (await response.json()) as typeof parsed;
  } catch {
    parsed = {};
  }
  if (parsed.error === "PROMOTION_AUTHORIZATION_REQUEST_NOT_PERMITTED" && Array.isArray(parsed.refusals)) {
    return {
      outcome: "failed",
      message: formatPromotionRequestRefusals(parsed.refusals as PromotionAuthorizationRequestRefusal[]),
    };
  }
  const message = typeof parsed.error === "string" ? MESSAGES[parsed.error] : undefined;
  return { outcome: "failed", message: message ?? failure };
}

/** A Promoter asks for permission to promote the Product it names. */
export async function submitPromotionAuthorizationRequest(
  fields: { productRef: string },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<PromotionAuthorizationOutcome> {
  const productRef = fields.productRef.trim();
  if (productRef === "") return { outcome: "failed", message: PROMOTION_PRODUCT_REQUIRED };
  return await post(promotionAuthorizationRequestEndpoint(productRef), {}, deps);
}

/** The Seller approves, denies, or revokes one Promoter. */
export async function submitPromotionAuthorizationDecision(
  fields: { productRef: string; authorizationRef: string; decision: SellerPromotionAuthorizationDecision },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<PromotionAuthorizationOutcome> {
  if (fields.productRef === "" || fields.authorizationRef === "") {
    return { outcome: "failed", message: PROMOTION_NOT_FOUND };
  }
  return await post(
    promotionAuthorizationDecisionEndpoint(fields.productRef, fields.authorizationRef),
    { decision: fields.decision },
    deps,
  );
}

/** The Promoter withdraws its own request or participation. */
export async function submitPromotionAuthorizationCancel(
  fields: { productRef: string; authorizationRef: string },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<PromotionAuthorizationOutcome> {
  if (fields.productRef === "" || fields.authorizationRef === "") {
    return { outcome: "failed", message: PROMOTION_NOT_FOUND };
  }
  return await post(promotionAuthorizationCancelEndpoint(fields.productRef, fields.authorizationRef), {}, deps);
}

/**
 * The cycle's own APPROVED Promoter accepts the exact package it was shown
 * (Phase 1.44). `pkg` is the server's own view, sent back unaltered.
 */
export async function submitOfferPackageAcceptance(
  fields: {
    productRef: string;
    authorizationRef: string;
    pkg: { offerRef: string; standing: Record<string, unknown>; promotion: Record<string, unknown> | null };
  },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<PromotionAuthorizationOutcome> {
  if (fields.productRef === "" || fields.authorizationRef === "") {
    return { outcome: "failed", message: PROMOTION_NOT_FOUND };
  }
  const { offerRef, standing, promotion } = fields.pkg;
  return await post(
    offerPackageAcceptanceEndpoint(fields.productRef, fields.authorizationRef),
    { offerRef, standing, promotion },
    deps,
    ACCEPTANCE_FAILURE,
  );
}
