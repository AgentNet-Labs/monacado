/**
 * Dispute readiness (Phase 1.11, extended in 1.12).
 *
 * Whether this deployment could **intake, track, and answer** a payment dispute.
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
 * ## The claim this module is careful not to make
 *
 * 1.11 reported one unconditional blocker, because evidence submission had no
 * adapter at all. 1.12 builds one — and replacing that blocker with a single
 * cleared boolean would have been the exact false readiness this module exists
 * to prevent, because a port existing is not a marketplace that can answer its
 * disputes.
 *
 * So one boolean became four, and they fail for genuinely different reasons:
 *
 * | Question | Cleared by |
 * | --- | --- |
 * | Is an adapter built? | a phase. **Cleared in 1.12.** |
 * | Is this deployment authorised to send? | a **ruling**, not a variable |
 * | Can every dispute be evidenced? | a phase that builds fulfilment records |
 * | Can a document be sent? | a phase that builds object storage |
 *
 * Three of the four are still blockers, so this deployment is still not
 * dispute-ready — and now it says *why* rather than saying only *not yet*. The
 * third is the load-bearing one: `SHIPPING_DOCUMENTATION` and
 * `ACCESS_ACTIVITY_LOG` are frozen unavailable, so physical-goods and
 * digital-access representment cannot be evidenced however good the port is, and
 * no amount of configuration will change that.
 */

import "../server-only";
import {
  DISPUTE_EVIDENCE_FILE_STORAGE_GAP,
  MONACADO_REPRESENTMENT_RULING,
  SELLER_EVIDENCE_INPUT_LIMITATION,
} from "../../contracts/marketplace/dispute-evidence";
import { DISPUTE_EVIDENCE_CODES_NEVER_AVAILABLE } from "../../contracts/marketplace/dispute-operations";
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
  /** Nothing assembles an evidence package from Monacado's own records. */
  "DISPUTE_EVIDENCE_ASSEMBLY_NOT_IMPLEMENTED",
  /** Nothing lets a named operator approve a package before it is sent. */
  "DISPUTE_OPERATOR_REVIEW_NOT_IMPLEMENTED",
  /** No adapter can submit a response to a provider. */
  "DISPUTE_EVIDENCE_SUBMISSION_NOT_IMPLEMENTED",
  /** The submission adapter exists and this deployment cannot reach a provider. */
  "DISPUTE_EVIDENCE_SUBMISSION_NOT_CONFIGURED",
  /**
   * Disputes can be answered in TEST mode only.
   *
   * A real production blocker rather than a governance one: representment is
   * authorised, and a deployment that can only answer test disputes still cannot
   * answer a real cardholder's bank.
   */
  "DISPUTE_PROVIDER_MODE_TEST_ONLY",
  /**
   * Whole categories of sale cannot be evidenced at all.
   *
   * **Kept, and it never encoded the governance hold.** It is driven by
   * `DISPUTE_EVIDENCE_CODES_NEVER_AVAILABLE`, which is non-empty because no
   * carrier, tracking, fulfilment, or entitlement-access record exists anywhere
   * in this repository. Physical-goods and digital-access representment are
   * therefore unevidenceable however good the port is and whatever the ruling
   * says. **No configuration clears this** — only a phase that builds those
   * records. The report names which categories, so the blocker is actionable
   * rather than merely discouraging.
   */
  "DISPUTE_EVIDENCE_ASSEMBLY_INCOMPLETE",
  /** No document may be submitted, because no object storage exists. */
  "DISPUTE_EVIDENCE_DOCUMENT_SUBMISSION_NOT_IMPLEMENTED",
  /**
   * No worker watches a deadline.
   *
   * The deadline is data surfaced on read, so a dispute can run out of time
   * while nobody runs the command. Stated as a blocker rather than left implied,
   * because 1.12 introduces a WAIT ON A THIRD PARTY — the seller's defence
   * opportunity — and a wait with no clock is how the only window gets missed.
   */
  "DISPUTE_DEADLINE_MONITORING_NOT_IMPLEMENTED",
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
  /** Whether a package can be assembled from Monacado's own records. */
  evidenceAssemblyImplemented: boolean;
  /** Whether a named operator can approve a package before it is sent. */
  operatorReviewImplemented: boolean;
  /** Whether an adapter can submit a response. */
  providerSubmissionImplemented: boolean;
  /** Whether this deployment could actually reach a provider. */
  providerSubmissionConfigured: boolean;
  /** TEST | LIVE. Never anything else while `STRIPE_MODES` has one member. */
  providerMode: "TEST" | "LIVE";
  /** Whether every evidence code has some record able to satisfy it. */
  evidenceAssemblyComplete: boolean;
  /** Which categories nothing can satisfy. Named, so the gap is actionable. */
  unsupportedEvidenceCategories: string[];
  /** Whether a document could be submitted. False while no object store exists. */
  documentSubmissionImplemented: boolean;
  /** Whether anything watches a deadline without an operator running a command. */
  deadlineMonitoringImplemented: boolean;
  /**
   * Whether Monacado is authorised to represent a dispute at all.
   *
   * TRUE, and permanently: `MONACADO_REPRESENTMENT_RULING` resolved it. Reported
   * so that a reader of a red report can see the refusal is about capability
   * rather than permission — the distinction 1.12 previously had to encode as a
   * blocker and no longer does.
   */
  representmentAuthorised: boolean;
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
  /**
   * Built in 1.12, TEST mode only, text evidence only, and now AUTHORISED.
   *
   * Deliberately not a bare "IMPLEMENTED": the value is read by readiness and by
   * tests, and a word that flattened test-mode-only and text-only is how a
   * partial capability gets reported as a complete one. What it no longer says
   * is "gated" — the §I ruling resolved that.
   */
  evidenceSubmissionAdapter: "IMPLEMENTED_TEXT_ONLY_TEST_MODE",
  evidenceAssembly: "IMPLEMENTED",
  operatorReviewAndApproval: "IMPLEMENTED",
  sellerDefenceOpportunity: "IMPLEMENTED_STRUCTURED_ATTESTATION_ONLY",
  deadlineSweepWorker: "NOT_IMPLEMENTED",
  disputeAcceptanceAdapter: "NOT_IMPLEMENTED",
  disputeEvidenceDocumentStorage: "NOT_IMPLEMENTED",
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

  /* — The four capability dimensions, each a value rather than a probe. —
   *
   * 1.11 asked one question and 1.12's first cut asked two. Neither was enough:
   * a marketplace can assemble evidence it cannot review, review a package it
   * cannot send, and send one it is not configured to deliver. They fail
   * separately, so they are reported separately. */
  const evidenceAssemblyImplemented =
    (DISPUTE_CAPABILITY_IMPLEMENTATION.evidenceAssembly as string) !== "NOT_IMPLEMENTED";
  if (!evidenceAssemblyImplemented) {
    blockers.push("DISPUTE_EVIDENCE_ASSEMBLY_NOT_IMPLEMENTED");
  } else {
    satisfied.push("DISPUTE_EVIDENCE_ASSEMBLY_IMPLEMENTED");
  }

  const operatorReviewImplemented =
    (DISPUTE_CAPABILITY_IMPLEMENTATION.operatorReviewAndApproval as string) !== "NOT_IMPLEMENTED";
  if (!operatorReviewImplemented) {
    blockers.push("DISPUTE_OPERATOR_REVIEW_NOT_IMPLEMENTED");
  } else {
    satisfied.push("DISPUTE_OPERATOR_REVIEW_IMPLEMENTED");
  }

  const providerSubmissionImplemented =
    (DISPUTE_CAPABILITY_IMPLEMENTATION.evidenceSubmissionAdapter as string) !== "NOT_IMPLEMENTED";
  if (!providerSubmissionImplemented) {
    blockers.push("DISPUTE_EVIDENCE_SUBMISSION_NOT_IMPLEMENTED");
  } else {
    satisfied.push("DISPUTE_EVIDENCE_SUBMISSION_IMPLEMENTED");
  }

  /* OPERATIONAL CONFIGURATION, distinct from the capability above. Presence only:
     nothing here reads, logs, or returns a credential's value. */
  const providerSubmissionConfigured = stripeEnabled && webhookVerifiable;
  if (!providerSubmissionConfigured) {
    blockers.push("DISPUTE_EVIDENCE_SUBMISSION_NOT_CONFIGURED");
  } else {
    satisfied.push("DISPUTE_EVIDENCE_SUBMISSION_CONFIGURED");
  }

  /* PROVIDER MODE. `STRIPE_MODES` has exactly one member, so this deployment can
     only ever answer a TEST dispute — a genuine production gap, and deliberately
     NOT the governance refusal it replaced. Representment is authorised; the
     credential simply cannot reach a real cardholder's bank. */
  const providerMode: "TEST" | "LIVE" = "TEST";
  blockers.push("DISPUTE_PROVIDER_MODE_TEST_ONLY");

  /* THE ONE NO CONFIGURATION CLEARS, and the one this correction had to judge
     honestly. It never encoded the §I hold: it is driven by the frozen
     never-available list, which is non-empty because no carrier, tracking,
     fulfilment, or entitlement-access record exists. Physical-goods and
     digital-access representment stay unevidenceable whatever the ruling says,
     so the blocker stays — now naming which categories, so it is actionable. */
  const unsupportedEvidenceCategories = [...DISPUTE_EVIDENCE_CODES_NEVER_AVAILABLE];
  const evidenceAssemblyComplete = unsupportedEvidenceCategories.length === 0;
  if (!evidenceAssemblyComplete) {
    blockers.push("DISPUTE_EVIDENCE_ASSEMBLY_INCOMPLETE");
  } else {
    satisfied.push("DISPUTE_EVIDENCE_ASSEMBLY_COMPLETE");
  }

  const documentSubmissionImplemented =
    (DISPUTE_EVIDENCE_FILE_STORAGE_GAP.providerFileUpload as string) !== "NOT_IMPLEMENTED";
  if (!documentSubmissionImplemented) {
    blockers.push("DISPUTE_EVIDENCE_DOCUMENT_SUBMISSION_NOT_IMPLEMENTED");
  }

  /* DEADLINE MONITORING. Newly a blocker, and 1.12 is why: the seller's defence
     opportunity introduces a wait on a third party, and a wait nothing times is
     how the only response window gets missed. */
  const deadlineMonitoringImplemented =
    (DISPUTE_CAPABILITY_IMPLEMENTATION.deadlineSweepWorker as string) !== "NOT_IMPLEMENTED";
  if (!deadlineMonitoringImplemented) {
    blockers.push("DISPUTE_DEADLINE_MONITORING_NOT_IMPLEMENTED");
  }

  return {
    ready: blockers.length === 0,
    blockers,
    satisfied,
    intakeImplemented: true,
    webhookVerifiable,
    evidenceAssemblyImplemented,
    operatorReviewImplemented,
    providerSubmissionImplemented,
    providerSubmissionConfigured,
    providerMode,
    evidenceAssemblyComplete,
    unsupportedEvidenceCategories,
    documentSubmissionImplemented,
    deadlineMonitoringImplemented,
    /* Permanently true. Reported so a red report reads as "cannot yet", never as
       "may not". */
    representmentAuthorised: MONACADO_REPRESENTMENT_RULING.ruling === "RESOLVED",
    evaluatedAt: at,
  };
}

export {
  DISPUTE_EVIDENCE_FILE_STORAGE_GAP,
  MONACADO_REPRESENTMENT_RULING,
  SELLER_EVIDENCE_INPUT_LIMITATION,
  DISPUTE_EVIDENCE_SUBMISSION_SEAM,
  DISPUTE_EXECUTION_DEFERRAL,
};
