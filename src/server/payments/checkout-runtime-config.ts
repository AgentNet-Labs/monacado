/**
 * Buyer-checkout runtime configuration (Phase 1.0) — SERVER ONLY.
 *
 * The deployment facts the checkout routes need that are **not Stripe's**, kept
 * separate from `stripe-runtime-config.ts` for exactly that reason: which
 * commercial policy governs Monacado's retention is a Monacado decision, and
 * filing it under the payment provider is how it eventually gets read out of one.
 *
 * Two things live here, and both are deliberate:
 *
 *   1. **The commercial policy identity.** `prepareCheckout` takes a `policyId`
 *      and resolves its effective version. That identity is **configuration,
 *      never a request parameter** — a client that could name the policy could
 *      name Monacado's retention rate, which is the single most valuable input to
 *      forge in the whole flow.
 *
 *   2. **Monacado's own origin.** Used to refuse a cross-site form post. A
 *      checkout route reachable by any page on the internet lets a third party
 *      create Orders in a signed-in buyer's name; nothing is charged without the
 *      buyer completing Stripe's page, but a table of unexplained
 *      `PENDING_PAYMENT` rows attributed to real accounts is not a state anyone
 *      should have to reason about.
 *
 * Nothing is read at import time, and no secret is read at all — neither value
 * here is a credential.
 */

import "../server-only";
import { z } from "zod";
import { CommercialPolicyId } from "../../contracts/marketplace/commercial-policy";
import { RiskPolicyId } from "../../contracts/marketplace/transaction-risk";
import { StripeConfigurationError, type Env } from "./stripe-runtime-config";

export const CheckoutRuntimeConfig = z.strictObject({
  /** Which Monacado commercial policy governs checkouts here. Never a parameter. */
  policyId: CommercialPolicyId,
  /**
   * Which risk policy gates transactions here (Phase 1.2).
   *
   * Configuration, never a parameter — a client that could name the risk policy
   * could name its own transaction ceiling. Filed beside the commercial policy
   * and deliberately a **separate** identity: one decides what Monacado earns,
   * the other what Monacado permits, and a change to either must not move the
   * other.
   */
  riskPolicyId: RiskPolicyId,
  /** Normalised `scheme://host:port` this deployment answers on. */
  appOrigin: z.string().min(1).max(2_048),
});
export type CheckoutRuntimeConfig = z.infer<typeof CheckoutRuntimeConfig>;

/** `scheme://host:port` with the effective port filled in, or `undefined`. */
export function normalizeOrigin(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
  if (parsed.hostname === "") return undefined;
  const port = parsed.port !== "" ? parsed.port : parsed.protocol === "https:" ? "443" : "80";
  return `${parsed.protocol}//${parsed.hostname.toLowerCase()}:${port}`;
}

export function readCheckoutRuntimeConfig(env: Env = process.env): CheckoutRuntimeConfig {
  const appOrigin = normalizeOrigin(env.MONACADO_APP_ORIGIN ?? "");
  const parsed = CheckoutRuntimeConfig.safeParse({
    policyId: env.MONACADO_CHECKOUT_POLICY_ID ?? "",
    riskPolicyId: env.MONACADO_RISK_POLICY_ID ?? "",
    appOrigin: appOrigin ?? "",
  });
  if (!parsed.success) {
    throw new StripeConfigurationError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  return parsed.data;
}

/**
 * Whether a request may act.
 *
 * A missing `Origin` is **permitted**: browsers omit it on ordinary same-origin
 * form navigations, and refusing those would refuse the actual buyer flow. A
 * *present* origin must match. That is the standard shape of this check and the
 * one that does not break the thing it protects.
 */
export function isAcceptableOrigin(
  originHeader: string | null,
  config: CheckoutRuntimeConfig,
): boolean {
  if (originHeader === null || originHeader === "" || originHeader === "null") return true;
  return normalizeOrigin(originHeader) === config.appOrigin;
}
