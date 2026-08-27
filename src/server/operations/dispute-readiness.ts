/**
 * Dispute readiness (Phase 1.11).
 *
 * Whether this deployment could **intake and track** a payment dispute.
 *
 * Configuration-only and read-only in the strongest sense: no database access,
 * no write, and above all **no provider contact**. The rows half of the question
 * — is the dispute book actually in a defensible state — is
 * `evaluateDisputeOperationsReadiness`, which does read rows. Keeping the two
 * apart is `1.9`'s split between `evaluateRefundReadiness` and
 * `evaluateRefundOperationsReadiness`, and it matters for the same reason: a
 * deployment can be perfectly configured and still have a backlog nobody is
 * answering.
 *
 * ## The claim this phase is careful not to make
 *
 * Dispute **intake** is implemented. Dispute **response** is not: evidence
 * submission has no adapter, and answering a dispute happens in the provider's
 * dashboard.
 *
 * A marketplace that records disputes and cannot answer them loses every one it
 * might have won, so that gap is reported as a blocker rather than a footnote.
 * Claiming "chargeback ready" on the strength of intake alone is exactly the
 * false readiness this module exists to prevent.
 */

import "../server-only";
import {
  DISPUTE_EVIDENCE_SUBMISSION_SEAM,
  DISPUTE_EXECUTION_DEFERRAL,
} from "../../contracts/marketplace/transaction-dispute";
import {
  isStripeEnabled,
  readStripeRuntimeConfig,
  resolveStripeWebhookSecret,
  type Env,
} from "../payments/stripe-runtime-config";

export const DISPUTE_READINESS_BLOCKER_CODES = [
  /** No payment provider is configured, so no dispute event could arrive. */
  "DISPUTE_INTAKE_NOT_CONFIGURED",
  /** No signing secret, so a dispute delivery could not be verified. */
  "DISPUTE_WEBHOOK_NOT_VERIFIABLE",
  /** Monacado cannot answer a dispute from inside this system. */
  "DISPUTE_EVIDENCE_RESPONSE_NOT_IMPLEMENTED",
] as const;
export type DisputeReadinessBlockerCode = (typeof DISPUTE_READINESS_BLOCKER_CODES)[number];

export interface DisputeReadinessReport {
  ready: boolean;
  blockers: DisputeReadinessBlockerCode[];
  satisfied: string[];
  /** Whether the five dispute events can be received and recorded. */
  intakeImplemented: boolean;
  /** Whether a delivery's signature can be verified. */
  webhookVerifiable: boolean;
  /** Whether Monacado can submit evidence. Always false in this phase. */
  evidenceResponseImplemented: boolean;
  evaluatedAt: string;
}

/**
 * What exists in this repository, as a value rather than a probe.
 *
 * Stated so a readiness report can distinguish "not built" from "not
 * configured", which `1.9` records as the distinction it could not previously
 * make.
 */
export const DISPUTE_CAPABILITY_IMPLEMENTATION = {
  disputeIntakeAdapter: "STRIPE_TEST_MODE",
  disputeEventLedger: "IMPLEMENTED",
  disputeProceedsHold: "IMPLEMENTED",
  disputeRecoveryEvidence: "IMPLEMENTED",
  chargebackAccounting: "IMPLEMENTED_FULL_SCOPE_ONLY",
  evidenceSubmissionAdapter: "NOT_IMPLEMENTED",
  disputeAcceptanceAdapter: "NOT_IMPLEMENTED",
  partialDisputeAccounting: "NOT_IMPLEMENTED",
  disputeCausedTaxReversal: "NOT_IMPLEMENTED",
} as const;

export function evaluateDisputeReadiness(
  at: string,
  env: Env = process.env,
): DisputeReadinessReport {
  const blockers: DisputeReadinessBlockerCode[] = [];
  const satisfied: string[] = [];

  /* Intake rides the existing signed webhook — same endpoint, same secret, no
     new environment variable. So the question "could a dispute reach us" is the
     question "is the payment provider configured". */
  const stripeEnabled = isStripeEnabled(env);
  if (!stripeEnabled) {
    blockers.push("DISPUTE_INTAKE_NOT_CONFIGURED");
  } else {
    satisfied.push("DISPUTE_INTAKE_CONFIGURED");
  }

  /* Resolved through the committed path rather than by guessing the variable's
     name: `webhookSecretEnvVar` is itself configuration, and a readiness check
     that hardcoded a convention would pass on a deployment that names it
     something else — and fail on one that is perfectly configured.
     
     PRESENCE ONLY. `resolveStripeWebhookSecret` returns the secret's VALUE, and
     nothing here reads, logs, compares, or returns it. An unreadable control
     counts as a blocker, never as satisfied: a check that cannot run has not
     passed. */
  let webhookVerifiable = false;
  try {
    const config = readStripeRuntimeConfig(env);
    resolveStripeWebhookSecret(config, env);
    webhookVerifiable = true;
  } catch {
    webhookVerifiable = false;
  }
  if (stripeEnabled && !webhookVerifiable) {
    blockers.push("DISPUTE_WEBHOOK_NOT_VERIFIABLE");
  } else if (webhookVerifiable) {
    satisfied.push("DISPUTE_WEBHOOK_VERIFIABLE");
  }

  /* Always a blocker in this phase, and deliberately unconditional. There is no
     configuration that clears it — only a later phase that builds the adapter.
     See DISPUTE_EVIDENCE_SUBMISSION_SEAM for why 1.11 did not. */
  blockers.push("DISPUTE_EVIDENCE_RESPONSE_NOT_IMPLEMENTED");

  return {
    ready: blockers.length === 0,
    blockers,
    satisfied,
    intakeImplemented: true,
    webhookVerifiable,
    evidenceResponseImplemented: false,
    evaluatedAt: at,
  };
}

export { DISPUTE_EVIDENCE_SUBMISSION_SEAM, DISPUTE_EXECUTION_DEFERRAL };
