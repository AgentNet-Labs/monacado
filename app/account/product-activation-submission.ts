/**
 * The browser half of activating a Product (Phase 1.39) — pure, `fetch`
 * injected.
 *
 * Sends the Product's opaque reference in the path and one body field: the
 * revision token of the Product as the page showed it. Nothing else — no target
 * state, no Storefront, no Listing, no Offer — so the request cannot name
 * `ACTIVE` or skip a gate; the server derives readiness from authoritative rows.
 * A refusal reaches the person as one bounded sentence.
 */

import { PRODUCT_ACTIVATION_BLOCKER_LABELS } from "./account-home-copy";
import type { ProductActivationBlocker } from "../../src/contracts/product/product-lifecycle";

export const productActivationEndpoint = (productRef: string): string =>
  `/api/products/${encodeURIComponent(productRef)}/activate`;

export const ACTIVATION_NOT_AVAILABLE = "This product isn't available to activate.";
export const ACTIVATION_CONFLICT =
  "This product has changed since you opened it. Reload the page before activating.";
export const ACTIVATION_ALREADY_ACTIVE = "This product is already active.";
export const ACTIVATION_SIGNED_OUT = "Your session has ended. Please sign in again.";
export const ACTIVATION_FAILURE = "Unable to activate the product. Please try again.";

export type ActivationOutcome = { outcome: "activated" } | { outcome: "failed"; message: string };

export async function submitProductActivation(
  fields: { productRef: string; expectedRevision: string },
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<ActivationOutcome> {
  if (fields.productRef === "") return { outcome: "failed", message: ACTIVATION_NOT_AVAILABLE };

  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(productActivationEndpoint(fields.productRef), {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: fields.expectedRevision }),
    });
  } catch {
    return { outcome: "failed", message: ACTIVATION_FAILURE };
  }

  if (response.ok) return { outcome: "activated" };
  if (response.status === 401) return { outcome: "failed", message: ACTIVATION_SIGNED_OUT };

  let code: unknown;
  try {
    code = ((await response.json()) as { error?: unknown }).error;
  } catch {
    code = undefined;
  }
  if (typeof code === "string" && code in PRODUCT_ACTIVATION_BLOCKER_LABELS) {
    return {
      outcome: "failed",
      message: PRODUCT_ACTIVATION_BLOCKER_LABELS[code as ProductActivationBlocker],
    };
  }
  const message =
    code === "PRODUCT_NOT_AVAILABLE"
      ? ACTIVATION_NOT_AVAILABLE
      : code === "PRODUCT_REVISION_CONFLICT"
        ? ACTIVATION_CONFLICT
        : code === "PRODUCT_ALREADY_ACTIVE"
          ? ACTIVATION_ALREADY_ACTIVE
          : code === "PRODUCT_SUSPENDED"
            ? PRODUCT_ACTIVATION_BLOCKER_LABELS.PRODUCT_SUSPENDED
            : ACTIVATION_FAILURE;
  return { outcome: "failed", message };
}
