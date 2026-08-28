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
 * | refund execution not configured | *(1.9)* the same thing, now checkable: `1.2`'s reversal accounting existed with no way to execute one |
 * | refund processor not operational | *(1.9)* durable refund work nobody runs is a buyer's money nobody returns |
 * | tax reversal not configured | *(1.9)* a refunded sale whose tax stands reported overstates what was collected |
 * | refund backlog unhealthy | *(1.9)* refunds stuck, or refunded sales whose tax was never reversed |
 * | risk review heuristics not active | *(1.13)* nobody would be watching refund and chargeback rates at all |
 * | seller risk mitigation not implemented | *(1.13)* the report notices and a human decides, but no governed way to ACT on a participant exists |
 * | live provider not enabled | the deliberate gate above |
 *
 * ## Why `1.9` added four rather than folding into `REVERSAL_ACCOUNTING`
 *
 * `1.2`'s `REVERSAL_ACCOUNTING_UNAVAILABLE` asks whether the reversal *table* is
 * reachable, which was the only refund-shaped question that could be asked when
 * no refund could be executed. It is now the weakest of five, and keeping it
 * separate is what makes the report legible: an operator reading "reversal
 * accounting satisfied" should not be able to conclude that Monacado can refund
 * anybody, which is exactly what one code covering both would have implied.
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
import { evaluateRefundReadiness } from "./refund-readiness";
import { evaluateRefundOperationsReadiness } from "../marketplace/refund-operations-service";
import { evaluateDisputeReadiness } from "./dispute-readiness";
import { evaluateDisputeOperationsReadiness } from "../marketplace/dispute-operations-service";
import { isMailEnabled } from "../notifications/mail-port";
import { getActiveRiskPolicyVersion } from "../risk/risk-policy-service";
import { resolveActiveReviewPolicy } from "../risk/seller-risk-review-policy-service";
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
  /**
   * No payment integration a refund could go through (Phase 1.9).
   *
   * `1.2` could only ask whether the reversal TABLE was reachable, because no
   * refund could be executed. This asks whether one could be.
   */
  "REFUND_EXECUTION_NOT_CONFIGURED",
  /**
   * Nothing invokes the refund processor (Phase 1.9).
   *
   * `1.8`'s lesson, applied where it costs more: a bounded cycle with no
   * dispatcher secret and no declared schedule is durable work nobody will ever
   * process — and here that work is returning a buyer's money.
   */
  "REFUND_PROCESSOR_NOT_OPERATIONAL",
  /**
   * A refunded sale's tax cannot be reversed with a provider (Phase 1.9).
   *
   * Separate from `TAX_CALCULATION_NOT_CONFIGURED` because they fail at
   * different moments and a deployment can pass the first while failing this
   * one — a test tax adapter calculates plausibly and reverses nothing.
   */
  "TAX_REVERSAL_NOT_CONFIGURED",
  /**
   * Refunds stuck, or refunded sales whose tax was never reversed (Phase 1.9).
   *
   * The rows-not-configuration control. Every permanently failed refund is a
   * buyer owed money, and every failed tax reversal is a return line that will
   * overstate what Monacado collected.
   */
  "REFUND_BACKLOG_UNHEALTHY",
  /**
   * Nothing could record a payment dispute (Phase 1.11).
   *
   * The gap this phase closed. A marketplace that accepts live card payments and
   * cannot intake a dispute lets a bank take money out of its balance with
   * nothing in the database recording it — and every dispute clock runs whether
   * or not anybody noticed.
   */
  "DISPUTE_INTAKE_NOT_CONFIGURED",
  /**
   * A dispute delivery could not be verified (Phase 1.11).
   *
   * Separate from intake because they fail differently: intake asks whether a
   * provider exists at all, this asks whether its statements can be trusted.
   * An unverified dispute webhook is an endpoint anybody can post a chargeback
   * to.
   */
  "DISPUTE_WEBHOOK_NOT_VERIFIABLE",
  /**
   * Monacado cannot answer a dispute from inside this system (Phase 1.11).
   *
   * **Reported by construction, and this is the point of the control.** Evidence
   * submission has no adapter; answering happens in the provider's dashboard.
   * A marketplace that records disputes and cannot respond loses every one it
   * might have won, so 1.11 refuses to let intake alone read as chargeback
   * readiness. Cleared only by a phase that builds the response path.
   */
  /* Phase 1.12, restated after the §I ruling. The old
     `DISPUTE_EVIDENCE_RESPONSE_NOT_IMPLEMENTED` and its governance sibling are
     both gone: representment is authorised and the adapter exists, so what is
     left are capability and configuration gaps that name themselves. */
  "DISPUTE_EVIDENCE_ASSEMBLY_NOT_IMPLEMENTED",
  "DISPUTE_OPERATOR_REVIEW_NOT_IMPLEMENTED",
  "DISPUTE_EVIDENCE_SUBMISSION_NOT_IMPLEMENTED",
  "DISPUTE_EVIDENCE_SUBMISSION_NOT_CONFIGURED",
  /** Disputes can be answered in TEST mode only (Phase 1.12). */
  "DISPUTE_PROVIDER_MODE_TEST_ONLY",
  /** Whole classes of sale cannot be evidenced at all (Phase 1.12). */
  "DISPUTE_EVIDENCE_ASSEMBLY_INCOMPLETE",
  /** No document can be submitted, because no object storage exists (Phase 1.12). */
  "DISPUTE_EVIDENCE_DOCUMENT_SUBMISSION_NOT_IMPLEMENTED",
  /** Nothing watches a response deadline (Phase 1.12). */
  "DISPUTE_DEADLINE_MONITORING_NOT_IMPLEMENTED",
  /**
   * The dispute book is not in a defensible state (Phase 1.11).
   *
   * The rows-not-configuration control, on `REFUND_BACKLOG_UNHEALTHY`'s terms.
   * An unattributed dispute, a response deadline about to pass, or a lost
   * dispute whose tax correction is owed and unexpressible each mean real money
   * is at stake and nobody has acted.
   */
  "DISPUTE_BACKLOG_UNHEALTHY",
  /**
   * No governed seller risk-review heuristics stand (Phase 1.13).
   *
   * A REPORTING control, and named as one. Without an ACTIVE version the daily
   * review refuses to run rather than ranking sellers against numbers nobody
   * activated — so selling live with this unset means nobody would be looking at
   * refund and chargeback rates at all.
   */
  "SELLER_RISK_REVIEW_POLICY_NOT_ACTIVE",
  /**
   * Risk REPORTING exists; participant-level MITIGATION does not (Phase 1.13).
   *
   * Reported by construction, and deliberately never clearable by configuration
   * — the posture `DISPUTE_DEADLINE_MONITORING_NOT_IMPLEMENTED` takes, for a
   * sharper reason. A daily ranked report plus a Staff review record is a
   * capability to NOTICE and to DECIDE. It is not a capability to ACT: no
   * participant suspension path exists in this repository, and Marketplace
   * Policy 1.2.0 authorises per-transaction risk decisions only, saying nothing
   * about restricting or suspending a participant on risk grounds.
   *
   * This blocker exists so that shipping the report cannot be mistaken for
   * shipping fraud controls. A generated list of risky sellers with nothing
   * governed to do about them is exactly the overstatement an honest readiness
   * document has to refuse.
   */
  "SELLER_RISK_MITIGATION_NOT_IMPLEMENTED",
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

  // — Refunds (Phase 1.9) —
  /* CONFIGURATION IS INSPECTED, NOT EXERCISED, on `1.6`'s terms and more so:
     probing a refund port means refunding something. `evaluateRefundReadiness`
     makes no network call and reads no credential value.
     `LIVE_PROVIDER_NOT_ENABLED` is deliberately not re-reported from it — this
     function reports that once, below, from the same single-member enum. */
  const refunds = evaluateRefundReadiness(at, env);
  if (!refunds.refundExecutionConfigured) {
    /* A marketplace able to take live payments and unable to refund them is not
       launch-ready. Every payment network requires a merchant to be able to
       refund, and the only remaining correction path without one is the
       chargeback — slower, dearer, and adjudicated by somebody else. */
    blockers.push("REFUND_EXECUTION_NOT_CONFIGURED");
  } else satisfied.push("REFUND_EXECUTION");

  if (!refunds.processorOperationallyInvocable) {
    blockers.push("REFUND_PROCESSOR_NOT_OPERATIONAL");
  } else satisfied.push("REFUND_PROCESSOR_OPERATIONS");

  if (!refunds.taxReversalConfigured) {
    blockers.push("TAX_REVERSAL_NOT_CONFIGURED");
  } else satisfied.push("TAX_REVERSAL_CONFIGURATION");

  /* And configured is not the same as keeping up. Rows, not configuration, and
     still no provider call. */
  try {
    const refundOperations = await evaluateRefundOperationsReadiness(at, { db });
    if (!refundOperations.healthy) blockers.push("REFUND_BACKLOG_UNHEALTHY");
    else satisfied.push("REFUND_BACKLOG");
  } catch {
    /* A control that cannot be read has not passed. */
    blockers.push("REFUND_BACKLOG_UNHEALTHY");
  }

  // — Disputes (Phase 1.11) —
  /* CONFIGURATION IS INSPECTED, NOT EXERCISED, on the same terms as refunds:
     `evaluateDisputeReadiness` makes no network call, reads no credential
     value, and touches no row. */
  const disputes = evaluateDisputeReadiness(at, env);
  /* Mapped member by member, and exhaustively.
   *
   * This was a bare `else` that funnelled every unrecognised dispute blocker into
   * `DISPUTE_EVIDENCE_RESPONSE_NOT_IMPLEMENTED`. That was harmless while three
   * codes existed and exactly one of them was the fallback; 1.12 adds three more,
   * and the old shape would have reported "no evidence adapter" for a deployment
   * whose real problem was an unopened governance gate — sending an operator to
   * build something that already exists. */
  for (const blocker of disputes.blockers) {
    blockers.push(blocker);
  }
  for (const ok of disputes.satisfied) satisfied.push(ok);

  /* And configured is not the same as keeping up. Rows, not configuration, and
     still no provider call. */
  try {
    const disputeOperations = await evaluateDisputeOperationsReadiness({ at }, { db });
    if (!disputeOperations.healthy) blockers.push("DISPUTE_BACKLOG_UNHEALTHY");
    else satisfied.push("DISPUTE_BACKLOG");
  } catch {
    /* A control that cannot be read has not passed. */
    blockers.push("DISPUTE_BACKLOG_UNHEALTHY");
  }

  // — Seller risk intelligence (Phase 1.13) —
  /* Rows, not configuration, and still no provider call. The question is only
     whether governed heuristics stand, so a daily review could actually run. */
  try {
    const reviewPolicy = await resolveActiveReviewPolicy({ db });
    if (reviewPolicy === null) blockers.push("SELLER_RISK_REVIEW_POLICY_NOT_ACTIVE");
    else satisfied.push("SELLER_RISK_REVIEW_POLICY");
  } catch {
    /* A control that cannot be read has not passed. */
    blockers.push("SELLER_RISK_REVIEW_POLICY_NOT_ACTIVE");
  }

  /* Reported by construction, and never satisfied. See the code's own comment:
     noticing and deciding are built; acting on a participant is neither
     implemented nor authorised by the current marketplace terms. */
  blockers.push("SELLER_RISK_MITIGATION_NOT_IMPLEMENTED");

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
