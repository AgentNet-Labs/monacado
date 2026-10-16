/**
 * The browser half of revising a Product (Phase 1.38) — pure, `fetch` injected.
 *
 * Sends exactly the facts the form governs — name, description, delivery type,
 * and the shipping policy — plus the opaque revision token of the state being
 * edited, and nothing else: no identifier in the body, no status, no tax fact.
 * The Product travels as its opaque reference in the path.
 *
 * The token makes the save conditional: if the Product changed since this form
 * was filled (another tab saved first), the server refuses with a conflict and
 * the person is told to reload — a stale edit never overwrites a newer one.
 *
 * The shipping policy is sent only for a shipped Product, and only as the
 * person chose it: `FREE`, or `FIXED` with the amount exactly as typed (a
 * string — the server converts it without floating point). No choice is sent
 * as `null`, never as free shipping. A blank description is sent as `null`.
 */

import type { DeliveryMode } from "../../src/contracts/product/product.capsule";

export const productRevisionEndpoint = (productRef: string): string =>
  `/api/products/${encodeURIComponent(productRef)}/revise`;

export const REVISION_INVALID =
  "Check the product details. A name and a delivery type are required; the name can be up to 200 characters.";
export const REVISION_CHARGE_EMPTY = "Enter a shipping charge, or choose free shipping.";
export const REVISION_CHARGE_INVALID =
  "Enter the shipping charge in US dollars, for example 4.50. For no charge, choose free shipping.";
export const REVISION_SHIPPING_UNSUPPORTED = "That shipping option isn't available.";
export const REVISION_NOT_AVAILABLE = "This product isn't available to edit.";
export const REVISION_UNCHANGED = "Nothing has changed.";
export const REVISION_CONFLICT =
  "This product has changed since you opened it. Reload the page to see the latest version before editing again.";
export const REVISION_NOT_ELIGIBLE = "Only a Seller can edit products.";
export const REVISION_SIGNED_OUT = "Your session has ended. Please sign in again.";
export const REVISION_FAILURE = "Unable to save the product. Please try again.";

export type ShippingChoice = "FREE" | "FIXED" | null;

export interface ProductRevisionFields {
  productRef: string;
  /** The revision token of the Product state this form is editing. */
  expectedRevision: string;
  name: string;
  description: string;
  deliveryMode: DeliveryMode | null;
  shippingChoice: ShippingChoice;
  /** The fixed charge exactly as typed; used only when `shippingChoice` is FIXED. */
  shippingAmount: string;
  currency: string;
}

export type RevisionOutcome =
  /** `revision` is the new state's token — what the next save from this form sends. */
  | { outcome: "revised"; revision: string }
  | { outcome: "failed"; message: string; conflict?: true };

/**
 * A stored minor-unit amount as the decimal a person would type, for pre-filling
 * the charge field. String surgery, not division, so no float is involved.
 * Hundredths, which holds for USD — the only currency this phase charges in.
 */
export function minorUnitsToDecimalInput(amountMinorUnits: number): string {
  const digits = String(amountMinorUnits).padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

export async function submitProductRevision(
  fields: ProductRevisionFields,
  deps: { fetchImpl?: typeof fetch } = {},
): Promise<RevisionOutcome> {
  if (fields.deliveryMode === null) return { outcome: "failed", message: REVISION_INVALID };

  let shippingPolicy: unknown = null;
  if (fields.deliveryMode === "PHYSICAL" && fields.shippingChoice === "FREE") {
    shippingPolicy = { method: "FREE" };
  } else if (fields.deliveryMode === "PHYSICAL" && fields.shippingChoice === "FIXED") {
    const amount = fields.shippingAmount.trim();
    if (amount === "") return { outcome: "failed", message: REVISION_CHARGE_EMPTY };
    shippingPolicy = { method: "FIXED", amount, currency: fields.currency };
  }

  const doFetch = deps.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await doFetch(productRevisionEndpoint(fields.productRef), {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: fields.expectedRevision,
        name: fields.name,
        description: fields.description.trim() === "" ? null : fields.description,
        deliveryMode: fields.deliveryMode,
        shippingPolicy,
      }),
    });
  } catch {
    return { outcome: "failed", message: REVISION_FAILURE };
  }

  if (response.ok) {
    let revision: unknown;
    try {
      revision = ((await response.json()) as { revision?: unknown }).revision;
    } catch {
      revision = undefined;
    }
    /* Saved, but without a token this form cannot safely save again: treat the
       next edit as needing a reload rather than guessing a revision. */
    if (typeof revision !== "string") return { outcome: "failed", message: REVISION_CONFLICT, conflict: true };
    return { outcome: "revised", revision };
  }
  if (response.status === 401) return { outcome: "failed", message: REVISION_SIGNED_OUT };

  let code: unknown;
  try {
    code = ((await response.json()) as { error?: unknown }).error;
  } catch {
    code = undefined;
  }
  const messages: Record<string, string> = {
    INVALID_PRODUCT_REVISION: REVISION_INVALID,
    INVALID_SHIPPING_CHARGE: REVISION_CHARGE_INVALID,
    UNSUPPORTED_SHIPPING_POLICY: REVISION_SHIPPING_UNSUPPORTED,
    SHIPPING_POLICY_NOT_APPLICABLE: REVISION_INVALID,
    PRODUCT_NOT_AVAILABLE: REVISION_NOT_AVAILABLE,
    PRODUCT_REVISION_UNCHANGED: REVISION_UNCHANGED,
    PRODUCT_REVISION_CONFLICT: REVISION_CONFLICT,
    PRODUCT_NOT_ELIGIBLE: REVISION_NOT_ELIGIBLE,
  };
  if (code === "PRODUCT_REVISION_CONFLICT") {
    return { outcome: "failed", message: REVISION_CONFLICT, conflict: true };
  }
  return {
    outcome: "failed",
    message: typeof code === "string" && code in messages ? messages[code]! : REVISION_FAILURE,
  };
}
