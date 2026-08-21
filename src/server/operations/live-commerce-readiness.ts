/**
 * Live-commerce readiness (Phase 1.2) — SERVER ONLY.
 *
 * One question, answered in one place: **may Monacado enable live commerce?**
 *
 * ## A readiness decision, not a deployment switch
 *
 * Nothing here turns anything on. It reads configuration and persisted state and
 * returns whether the controls that must exist do exist. Enabling live payments
 * remains a source change to `stripe-runtime-config.ts` made in the open, in a
 * reviewed phase — this only tells an operator whether that change would be
 * defensible yet.
 *
 * The distinction matters because a readiness function that could also flip a
 * flag would eventually be called by something that wanted the flag flipped.
 *
 * ## Fails closed, and cannot currently pass
 *
 * `LIVE_PROVIDER_NOT_ENABLED` is reported by construction: `STRIPE_MODES` has one
 * member, so no configuration can satisfy it. That is not a placeholder — it is
 * the accurate answer. Every other blocker can be cleared by configuring the
 * control it names; this one can only be cleared by a deliberate, reviewed
 * decision to build live-mode support at all.
 *
 * ## Why each control is on the list
 *
 * | Blocker | Why it gates real money |
 * | --- | --- |
 * | tax not configured | selling untaxed creates a liability nobody recorded |
 * | risk not configured | no ceiling, no restriction check, nothing to stop one mispriced Listing |
 * | notification not configured | a buyer charged real money who is told nothing has no receipt and no recourse |
 * | reversal unavailable | taking money with no way to give it back |
 * | live provider not enabled | the deliberate gate above |
 *
 * Each is checked against **actual state**, not a self-declaration: the tax
 * adapter must resolve, the risk policy must have an `ACTIVE` version in the
 * database, the mail transport must be enabled, and the reversal table must be
 * reachable.
 */

import "../server-only";
import { STRIPE_MODES } from "../payments/stripe-runtime-config";
import { isTaxCalculationEnabled, resolveTaxPort } from "../tax/tax-adapters";
import { isMailEnabled } from "../notifications/mail-port";
import { getActiveRiskPolicyVersion } from "../risk/risk-policy-service";
import { getPrisma } from "../db/client";

type Db = ReturnType<typeof getPrisma>;

export type Env = Record<string, string | undefined>;

/**
 * Why live commerce may not be enabled, as a closed vocabulary.
 *
 * Bounded codes rather than sentences, on the same terms as every other reason
 * vocabulary here: safe to log, safe to render on an operations page, and
 * carrying no credential, threshold, or party.
 */
export const LIVE_READINESS_BLOCKER_CODES = [
  /** No tax engine is configured, so checkout cannot establish a tax amount. */
  "TAX_CALCULATION_NOT_CONFIGURED",
  /** The configured tax adapter cannot actually produce a result. */
  "TAX_CALCULATION_NOT_OPERATIONAL",
  /** No risk policy identity is configured for this deployment. */
  "RISK_POLICY_NOT_CONFIGURED",
  /** The configured risk policy has no ACTIVE version. */
  "RISK_POLICY_NOT_ACTIVE",
  /** No transactional notification channel is configured. */
  "NOTIFICATION_DELIVERY_NOT_CONFIGURED",
  /** Reversal accounting is unavailable. */
  "REVERSAL_ACCOUNTING_UNAVAILABLE",
  /** Live provider support does not exist. Cleared only by a reviewed phase. */
  "LIVE_PROVIDER_NOT_ENABLED",
] as const;
export type LiveReadinessBlockerCode = (typeof LIVE_READINESS_BLOCKER_CODES)[number];

export interface LiveCommerceReadiness {
  /** `false` until every control exists. There is no partial readiness. */
  ready: boolean;
  /** Every blocker, not the first — the same rule the risk gate follows. */
  blockers: LiveReadinessBlockerCode[];
  /** Controls confirmed present, so an operator can see progress. */
  satisfied: string[];
  evaluatedAt: string;
}

export interface LiveReadinessDeps {
  db?: Db;
  env?: Env;
}

/**
 * Evaluate whether live commerce could be enabled.
 *
 * Read-only in the strongest sense: no write, no configuration change, no
 * provider contact. An unreadable control counts as a **blocker**, never as
 * satisfied — a check that cannot run has not passed.
 */
export async function evaluateLiveCommerceReadiness(
  at: string,
  deps: LiveReadinessDeps = {},
): Promise<LiveCommerceReadiness> {
  const env = deps.env ?? process.env;
  const db = deps.db ?? getPrisma();
  const blockers: LiveReadinessBlockerCode[] = [];
  const satisfied: string[] = [];

  // — Tax —
  if (!isTaxCalculationEnabled(env)) {
    blockers.push("TAX_CALCULATION_NOT_CONFIGURED");
  } else {
    /* Configured is not the same as working. The adapter is exercised on a
       nominal basis, because a deployment that names a provider it cannot reach
       is exactly as unable to sell as one that names none. */
    try {
      await resolveTaxPort(env).calculate({
        currency: "USD",
        commercialRetailAmountMinorUnits: 1_000,
        shippingAmountMinorUnits: 0,
        internalProductId: "mon:product:READINESS0PROBE00000000000",
        sellerParticipantId: "mon:mpart:READINESS0PROBE00000000000",
        buyerJurisdictionCode: null,
        at,
      });
      satisfied.push("TAX_CALCULATION");
    } catch {
      blockers.push("TAX_CALCULATION_NOT_OPERATIONAL");
    }
  }

  // — Risk —
  const riskPolicyId = (env.MONACADO_RISK_POLICY_ID ?? "").trim();
  if (riskPolicyId === "") {
    blockers.push("RISK_POLICY_NOT_CONFIGURED");
  } else {
    try {
      const active = await getActiveRiskPolicyVersion(riskPolicyId, { db });
      if (active === null) blockers.push("RISK_POLICY_NOT_ACTIVE");
      else satisfied.push("RISK_POLICY");
    } catch {
      blockers.push("RISK_POLICY_NOT_ACTIVE");
    }
  }

  // — Notification —
  if (!isMailEnabled(env)) {
    /* A buyer charged real money who is told nothing has no receipt and no
       recourse. `1.1` built the channel; this insists it is switched on. */
    blockers.push("NOTIFICATION_DELIVERY_NOT_CONFIGURED");
  } else {
    satisfied.push("NOTIFICATION_DELIVERY");
  }

  // — Reversal —
  try {
    await db.transactionReversal.count();
    satisfied.push("REVERSAL_ACCOUNTING");
  } catch {
    blockers.push("REVERSAL_ACCOUNTING_UNAVAILABLE");
  }

  // — Live provider —
  /* Reported by construction. STRIPE_MODES has one member, so no configuration
     clears this; only a reviewed phase that builds live-mode support can. */
  if (!(STRIPE_MODES as readonly string[]).includes("LIVE")) {
    blockers.push("LIVE_PROVIDER_NOT_ENABLED");
  } else {
    satisfied.push("LIVE_PROVIDER");
  }

  return {
    ready: blockers.length === 0,
    blockers,
    satisfied,
    evaluatedAt: at,
  };
}
