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
 * | tax provider is a test adapter | a stub's plausible number looks calculated |
 * | tax registrations not stated | nobody has said where Monacado collects |
 * | tax filing not stated | collected tax with nobody named to remit it |
 * | tax recorder not operational | a recorder nothing runs is work nobody processes |
 * | tax recording backlog unhealthy | paid sales whose tax report is stuck or overdue |
 * | risk not configured | no ceiling, no restriction check, nothing to stop one mispriced Listing |
 * | notification not configured | a buyer charged real money who is told nothing has no receipt and no recourse |
 * | reversal unavailable | taking money with no way to give it back |
 * | live provider not enabled | the deliberate gate above |
 *
 * Each is checked against **actual state**, not a self-declaration: the risk
 * policy must have an `ACTIVE` version in the database, the mail transport must
 * be enabled, and the reversal table must be reachable.
 *
 * The tax controls are the one exception, and the exception is honest: Monacado
 * cannot read Stripe's registration list, so registration and filing posture are
 * **operator statements**. What is checked is that somebody made them explicitly
 * and said where the decision is recorded — evidence that a human looked, not a
 * copy of what they found. Inferring either would be asserting a fiscal position
 * nobody took, inside the document an operator reads instead of checking.
 */

import "../server-only";
import { STRIPE_MODES } from "../payments/stripe-runtime-config";
import { evaluateTaxReadiness } from "../tax/tax-readiness";
import { evaluateTaxOperationsReadiness } from "../tax/tax-recording-operations-service";
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
  /** The tax configuration is incomplete, so no calculation could be made. */
  "TAX_CALCULATION_NOT_OPERATIONAL",
  /**
   * A tax engine is configured, and it is a TEST adapter (Phase 1.6).
   *
   * A stub returning a plausible number is **more** dangerous than no engine at
   * all, because its answers look calculated.
   */
  "TAX_PROVIDER_NOT_PRODUCTION_CAPABLE",
  /** Nobody has stated that provider-side tax registrations are configured. */
  "TAX_REGISTRATION_CONFIGURATION_REQUIRED",
  /** Nobody has stated who files and remits the tax Monacado collects. */
  "TAX_FILING_OR_REMITTANCE_CONFIGURATION_REQUIRED",
  /**
   * Tax can be recorded and nothing runs the recorder (Phase 1.8).
   *
   * The gap `1.7` left: a bounded cycle with no dispatcher secret and no declared
   * schedule is durable work nobody will ever process.
   */
  "TAX_RECORDER_NOT_OPERATIONAL",
  /**
   * Paid sales whose tax reporting is stuck or overdue (Phase 1.8).
   *
   * Every permanently-failed row is a return line that will be missing, and an
   * overdue backlog means the dispatcher is not running.
   */
  "TAX_RECORDING_BACKLOG_UNHEALTHY",
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
  /* Phase 1.6 — CONFIGURATION IS INSPECTED, NOT EXERCISED.
   *
   * `1.2` proved the adapter worked by performing a calculation on a nominal
   * basis. That was safe while every adapter was a local test double, and is not
   * safe now: with Stripe Tax selected, this readiness check would make a live
   * API call to a payment provider every time an operator ran a command
   * documented as read-only.
   *
   * The narrowing is deliberate and is recorded rather than glossed: a
   * configuration check cannot prove the engine answers. It proves the deployment
   * has decided everything the engine needs, which is the question a launch
   * review is actually asking. */
  const tax = evaluateTaxReadiness(at, env);
  if (!tax.enabled) {
    blockers.push("TAX_CALCULATION_NOT_CONFIGURED");
  } else if (!tax.productionCapableProvider) {
    blockers.push("TAX_PROVIDER_NOT_PRODUCTION_CAPABLE");
  } else if (!tax.calculationConfigured) {
    blockers.push("TAX_CALCULATION_NOT_OPERATIONAL");
  } else {
    satisfied.push("TAX_CALCULATION");
  }

  if (!tax.registration.complete) {
    blockers.push("TAX_REGISTRATION_CONFIGURATION_REQUIRED");
  } else satisfied.push("TAX_REGISTRATION_CONFIGURATION");

  /* Phase 1.8 — recording CODE is not recording OPERATIONS. A deployment able to
     price and report a sale, with nothing that invokes the recorder, collects tax
     whose report nobody sends. */
  if (!tax.recorderOperations.operationallyInvocable) {
    blockers.push("TAX_RECORDER_NOT_OPERATIONAL");
  } else satisfied.push("TAX_RECORDER_OPERATIONS");

  /* And configured is not the same as keeping up. This is the one tax control
     that reads rows rather than configuration — no provider call, all local. */
  try {
    const operations = await evaluateTaxOperationsReadiness(at, { db });
    if (!operations.healthy) blockers.push("TAX_RECORDING_BACKLOG_UNHEALTHY");
    else satisfied.push("TAX_RECORDING_BACKLOG");
  } catch {
    /* A control that cannot be read has not passed. */
    blockers.push("TAX_RECORDING_BACKLOG_UNHEALTHY");
  }

  if (tax.filing.posture === "UNCONFIGURED") {
    /* Collecting tax creates an obligation to remit it. Live commerce with
       nobody named as filer is a liability with no filer. */
    blockers.push("TAX_FILING_OR_REMITTANCE_CONFIGURATION_REQUIRED");
  } else satisfied.push("TAX_FILING_POSTURE");

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
