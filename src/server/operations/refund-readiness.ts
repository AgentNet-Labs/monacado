/**
 * Refund readiness (Phase 1.9) — SERVER ONLY.
 *
 * One question, answered in one place: **is this deployment able to give money
 * back?**
 *
 * The premise `1.9`'s §17 states, and which this module exists to enforce:
 *
 * > A marketplace capable of taking live payments but unable to refund them must
 * > not be considered launch-ready.
 *
 * That is not a tidiness rule. Every payment network requires a merchant to be
 * able to refund; a marketplace that can charge and cannot return is one whose
 * only remaining correction path is the chargeback, which is slower, more
 * expensive, and adjudicated by somebody else.
 *
 * ## It reads configuration, and calls nobody
 *
 * Pure configuration inspection — no network, no database, no clock, no
 * credential *value* read. `tax-readiness.ts`'s posture exactly, and for the
 * reason that phase recorded: a readiness check that probed the port would make a
 * live API call to a payment provider every time an operator ran a command
 * documented as read-only. Worse here than there — probing a refund port means
 * refunding something.
 *
 * The database-backed half — *is it actually keeping up* — is
 * `evaluateRefundOperationsReadiness`, which reads rows and still calls no
 * provider.
 *
 * ## Implemented is not configured, and configured is not scheduled
 *
 * Three distinctions `1.9` asks for explicitly, kept apart because they fail
 * differently:
 *
 * | Question | Answered by | Fails when |
 * | --- | --- | --- |
 * | is refund execution **implemented**? | a constant | never — the adapter exists |
 * | is it **configured**? | the Stripe block | Stripe is disabled or malformed |
 * | is it **operationally invocable**? | the dispatcher secret + an operator's schedule declaration | nothing runs the processor |
 *
 * The third is the one `1.8` learned to ask. An implemented, configured refund
 * processor that nothing invokes returns nobody's money.
 *
 * ## Nothing here can pass while live commerce is impossible
 *
 * `LIVE_PROVIDER_NOT_ENABLED` is reported by construction, exactly as
 * `live-commerce-readiness.ts` and `tax-readiness.ts` report it: `STRIPE_MODES`
 * has one member, so no configuration can satisfy it.
 */

import "../server-only";
import {
  isRefundProcessorScheduleDeclared,
  isRefundProcessorSecretConfigured,
  REFUND_PROCESSOR_ENDPOINT_PATH,
  REFUND_PROCESSOR_SCHEDULE_GUIDANCE,
} from "../payments/refund-processor-route-handler";
import {
  isStripeEnabled,
  readStripeRuntimeConfig,
  STRIPE_MODES,
} from "../payments/stripe-runtime-config";
import { isTaxCalculationEnabled, selectedTaxProvider } from "../tax/tax-runtime-config";
import { PRODUCTION_TAX_PROVIDERS } from "../../contracts/marketplace/tax-calculation";

export type Env = Record<string, string | undefined>;

/**
 * Why refunds are not ready, as a closed vocabulary.
 *
 * Bounded codes rather than sentences, on the same terms as every other reason
 * vocabulary here: safe to log, safe to render on an operations page, and
 * carrying no credential, amount, or party.
 */
export const REFUND_READINESS_BLOCKER_CODES = [
  /** Stripe is disabled, so there is no payment integration to refund through. */
  "REFUND_EXECUTION_NOT_CONFIGURED",
  /** The Stripe block is present but malformed or incomplete. */
  "REFUND_PROVIDER_CONFIGURATION_INVALID",
  /**
   * Nothing invokes the refund processor.
   *
   * The gap `1.8` named for tax recording, and worse here: durable refund work
   * nobody processes is a buyer's money nobody returns.
   */
  "REFUND_PROCESSOR_NOT_OPERATIONAL",
  /** No tax engine, so a refunded sale's tax cannot be reversed with a provider. */
  "TAX_REVERSAL_NOT_CONFIGURED",
  /**
   * A tax engine is configured and it is a TEST adapter.
   *
   * A stub that "reverses" nothing is more dangerous than no engine, because its
   * silence looks like success — `1.6`'s reasoning about calculation, applied to
   * the reversal half.
   */
  "TAX_REVERSAL_PROVIDER_NOT_PRODUCTION_CAPABLE",
  /** Live provider support does not exist. Cleared only by a reviewed phase. */
  "LIVE_PROVIDER_NOT_ENABLED",
] as const;
export type RefundReadinessBlockerCode = (typeof REFUND_READINESS_BLOCKER_CODES)[number];

export interface RefundReadinessReport {
  /** `false` until every control exists. There is no partial readiness. */
  ready: boolean;
  /** Every blocker, not the first — the same rule the risk gate follows. */
  blockers: RefundReadinessBlockerCode[];
  satisfied: string[];

  /** The adapter exists in this repository. A constant, and honestly so. */
  refundExecutionImplemented: boolean;
  /** The deployment has a payment integration a refund could go through. */
  refundExecutionConfigured: boolean;
  /** The tax-reversal adapter exists in this repository. */
  taxReversalImplemented: boolean;
  /** The deployment has a production-capable tax engine to reverse with. */
  taxReversalConfigured: boolean;
  /** A dispatcher secret is set and an operator has declared a scheduler. */
  processorOperationallyInvocable: boolean;
  /** Reported by construction: `STRIPE_MODES` has one member. */
  liveProviderEnabled: boolean;

  /** What an operator must arrange, named once so a runbook can quote it. */
  processorEndpointPath: string;
  processorSchedule: typeof REFUND_PROCESSOR_SCHEDULE_GUIDANCE;
  evaluatedAt: string;
}

/**
 * Both adapters exist in this repository.
 *
 * A constant rather than a probe, and stated as a value so the claim is
 * checkable. `1.2` shipped `RefundExecutionPort` with no implementation and `1.7`
 * shipped tax recording with reversal deliberately absent; both are now built,
 * and a readiness report that could not distinguish "not built" from "not
 * configured" would have been unable to say so.
 */
export const REFUND_CAPABILITY_IMPLEMENTATION = {
  paymentRefundAdapter: "STRIPE_TEST_MODE",
  taxReversalAdapter: "STRIPE_TAX_TEST_MODE",
  partialRefunds: "REFUSED",
  chargebackIngestion: "NOT_IMPLEMENTED",
  payoutClawbackExecution: "NOT_IMPLEMENTED",
} as const;

/**
 * Evaluate whether this deployment could refund a buyer.
 *
 * Read-only in the strongest sense: no write, no configuration change, and above
 * all **no provider contact**. An unreadable control counts as a **blocker**,
 * never as satisfied — a check that cannot run has not passed.
 */
export function evaluateRefundReadiness(
  at: string,
  env: Env = process.env,
): RefundReadinessReport {
  const blockers: RefundReadinessBlockerCode[] = [];
  const satisfied: string[] = [];

  // — Payment refund execution —
  let refundExecutionConfigured = false;
  if (!isStripeEnabled(env)) {
    blockers.push("REFUND_EXECUTION_NOT_CONFIGURED");
  } else {
    try {
      readStripeRuntimeConfig(env);
      refundExecutionConfigured = true;
      satisfied.push("REFUND_EXECUTION_CONFIGURATION");
    } catch {
      /* The issues themselves are not surfaced here: they name environment
         variables, and a readiness report is rendered where a credential layout
         should not be enumerated. `stripe-runtime-config` reports them to the
         operator who is actually fixing them. */
      blockers.push("REFUND_PROVIDER_CONFIGURATION_INVALID");
    }
  }

  // — The processor that runs it —
  const secretConfigured = isRefundProcessorSecretConfigured(env);
  const scheduleDeclared = isRefundProcessorScheduleDeclared(env);
  const processorOperationallyInvocable = secretConfigured && scheduleDeclared;
  if (!processorOperationallyInvocable) {
    blockers.push("REFUND_PROCESSOR_NOT_OPERATIONAL");
  } else {
    satisfied.push("REFUND_PROCESSOR_OPERATIONS");
  }

  // — Tax reversal —
  let taxReversalConfigured = false;
  if (!isTaxCalculationEnabled(env)) {
    /* A deployment with no tax engine cannot reverse a sale's tax, and a refund
       that silently skipped the reversal would leave the sale reported as
       collected. `1.7`'s rule, read backwards. */
    blockers.push("TAX_REVERSAL_NOT_CONFIGURED");
  } else {
    const provider = selectedTaxProvider(env);
    if (!(PRODUCTION_TAX_PROVIDERS as readonly string[]).includes(provider)) {
      blockers.push("TAX_REVERSAL_PROVIDER_NOT_PRODUCTION_CAPABLE");
    } else {
      taxReversalConfigured = true;
      satisfied.push("TAX_REVERSAL_CONFIGURATION");
    }
  }

  // — Live provider —
  /* Reported by construction. STRIPE_MODES has one member, so no configuration
     clears this; only a reviewed phase that builds live-mode support can. */
  const liveProviderEnabled = (STRIPE_MODES as readonly string[]).includes("LIVE");
  if (!liveProviderEnabled) blockers.push("LIVE_PROVIDER_NOT_ENABLED");
  else satisfied.push("LIVE_PROVIDER");

  return {
    ready: blockers.length === 0,
    blockers,
    satisfied,
    refundExecutionImplemented: true,
    refundExecutionConfigured,
    taxReversalImplemented: true,
    taxReversalConfigured,
    processorOperationallyInvocable,
    liveProviderEnabled,
    processorEndpointPath: REFUND_PROCESSOR_ENDPOINT_PATH,
    processorSchedule: REFUND_PROCESSOR_SCHEDULE_GUIDANCE,
    evaluatedAt: at,
  };
}

/**
 * What this phase does **not** make Monacado ready for.
 *
 * Stated as a value so a launch review reads a list rather than inferring an
 * absence. `1.9` implements refunds; it does not implement any of the below, and
 * a readiness report that stayed silent about them would be read as covering
 * them.
 */
export const REFUND_READINESS_EXCLUSIONS = {
  /** A bank taking funds is a different event with different evidence. */
  chargebackAndDisputeHandling: "NOT_IMPLEMENTED",
  /** Requires the allocation ruling `PARTIAL_REFUND_DEFERRAL` names. */
  partialRefunds: "REFUSED",
  /** No clawback, no negative balance, no offset. See RECOVERY_EXECUTION_DEFERRAL. */
  payoutRecoveryExecution: "NOT_IMPLEMENTED",
  /** Filing and remittance remain `0M.T2`'s, unchanged by this phase. */
  taxFilingAndRemittance: "NOT_IMPLEMENTED",
  /** Live payments remain gated by a reviewed source change. */
  liveModeRefunds: "NOT_IMPLEMENTED",
} as const;
