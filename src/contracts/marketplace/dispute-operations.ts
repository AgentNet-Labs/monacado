/**
 * Dispute operator vocabulary (Phase 1.11).
 *
 * What an operator sees, and what they are told to do about it.
 *
 * Modelled directly on `refund-operations.ts`, including the rule that matters
 * most here: **the summary carries counts and ages only — no Order id, no
 * participant, no buyer, and no amount.** A status summary is rendered on
 * operations screens and pasted into chat, and a dispute summary that enumerated
 * amounts would be enumerating customers *and* the sums they are contesting.
 * Identifiers appear only in the inspection view, which an operator opens
 * deliberately.
 *
 * There is **no dispute worker**. Nothing here is a queue to drain: a dispute is
 * driven by the provider's own webhook deliveries, and the obligation to act
 * arises the moment the dispute exists rather than when a cycle next runs. The
 * deadline is therefore **data surfaced on read**, not a sweep — and a whole
 * secret, endpoint, cron cadence, and lease engine to send a reminder is not
 * proportionate to what it would buy.
 */

import { z } from "zod";
import {
  DisputeFundsState,
  DisputeRemediationCode,
  DisputeStatus,
  DisputeTaxConsequence,
} from "./transaction-dispute";

// — Policy —

/**
 * How close to a deadline is close enough to shout, expressed once.
 *
 * The two thresholds differ in kind, not just in size. `deadlineWarningSeconds`
 * says *an operator should start assembling evidence*; `deadlineCriticalSeconds`
 * says *this is the last chance and it blocks readiness*. Collapsing them into
 * one number would either cry wolf for three days or give a day's notice on
 * something that takes longer than a day to answer.
 */
export const DISPUTE_OPERATIONS_POLICY = {
  /** 72 hours out: time enough to gather what a response needs. */
  deadlineWarningSeconds: 72 * 60 * 60,
  /** 24 hours out: the last useful moment, and a readiness blocker. */
  deadlineCriticalSeconds: 24 * 60 * 60,
  /**
   * How long a dispute may sit unlooked-at before it is itself a finding.
   *
   * Deliberately short. A dispute nobody has opened is the failure mode this
   * whole phase exists to prevent.
   */
  maxUnacknowledgedSeconds: 24 * 60 * 60,
  /** How stale the last provider observation may be before it is suspect. */
  maxObservationStalenessSeconds: 7 * 24 * 60 * 60,
} as const;

// — Backlog —

/**
 * What the dispute book currently holds, as counts and ages.
 *
 * See the header: **no identifiers, no amounts.**
 */
export const DisputeBacklog = z.strictObject({
  open: z.int().min(0),
  needsResponse: z.int().min(0),
  underReview: z.int().min(0),
  won: z.int().min(0),
  lost: z.int().min(0),
  closed: z.int().min(0),
  manualRemediationRequired: z.int().min(0),

  /** Funds axis, independent of adjudication. */
  fundsWithdrawn: z.int().min(0),
  fundsReinstated: z.int().min(0),

  /** Attention counts. */
  unattributed: z.int().min(0),
  deadlineWithinWarning: z.int().min(0),
  deadlineWithinCritical: z.int().min(0),
  deadlinePassedUnresolved: z.int().min(0),
  noResponsePermitted: z.int().min(0),
  observationStale: z.int().min(0),
  taxConsequenceUnresolved: z.int().min(0),
  heldObligations: z.int().min(0),
  openRecoveryExceptions: z.int().min(0),

  /** Ages, in seconds. NULL when there is nothing outstanding. */
  oldestUnresolvedAgeSeconds: z.int().min(0).nullable(),
  soonestDeadlineSeconds: z.int().nullable(),
});
export type DisputeBacklog = z.infer<typeof DisputeBacklog>;

export function disputeBacklogIsHealthy(
  backlog: DisputeBacklog,
): boolean {
  if (backlog.manualRemediationRequired > 0) return false;
  if (backlog.unattributed > 0) return false;
  if (backlog.deadlineWithinCritical > 0) return false;
  if (backlog.deadlinePassedUnresolved > 0) return false;
  if (backlog.taxConsequenceUnresolved > 0) return false;
  if (backlog.observationStale > 0) return false;
  return true;
}

// — Blockers —

/**
 * Why the dispute book is not healthy, as a closed vocabulary.
 *
 * Each member names a situation an operator can act on. None of them is
 * "something went wrong".
 */
export const DISPUTE_OPERATIONS_BLOCKER_CODES = [
  /** A provider dispute matches no Monacado sale. */
  "DISPUTE_UNATTRIBUTED",
  /** A response deadline is inside the critical window. */
  "DISPUTE_RESPONSE_DEADLINE_NEAR",
  /** A response deadline passed while the dispute was still open. */
  "DISPUTE_RESPONSE_DEADLINE_PASSED",
  /** A dispute needs a human and has not had one. */
  "DISPUTE_MANUAL_REMEDIATION_REQUIRED",
  /** The provider has said nothing for longer than it should have. */
  "DISPUTE_OBSERVATION_STALE",
  /** A lost dispute's tax correction is owed and not expressible. */
  "DISPUTE_TAX_CONSEQUENCE_UNRESOLVED",
  /** A lost dispute left already-paid economics with no recovery evidence. */
  "DISPUTE_RECOVERY_EVIDENCE_MISSING",
  /**
   * A finalized loss carries no seller fee, because no governed fee policy was
   * active when it finalized (Phase 1.12).
   *
   * The visible half of failing closed. The assessment path refuses to reach for
   * a compiled amount no operator activated, so the consequence is a fee that was
   * never charged — and a marketplace that silently stopped charging one would
   * never find out. An operator activates a fee version and re-runs.
   */
  "DISPUTE_CHARGEBACK_FEE_NOT_ASSESSED",
] as const;
export const DisputeOperationsBlockerCode = z.enum(DISPUTE_OPERATIONS_BLOCKER_CODES);
export type DisputeOperationsBlockerCode = z.infer<typeof DisputeOperationsBlockerCode>;

// — Operator actions —

/**
 * What to do about one dispute, in words that name the act.
 *
 * The same discipline `REFUND_OPERATOR_ACTIONS` follows: a closed vocabulary
 * rather than a generic "needs attention", because an operator handed one word
 * for six situations acts late on five of them.
 */
export const DISPUTE_OPERATOR_ACTIONS = [
  /** Nothing to do; it is decided and settled. */
  "NONE",
  /** Nothing to do; the network is deciding. */
  "AWAIT_PROVIDER_DECISION",
  /** Work out which sale this is, or write it off. */
  "ATTRIBUTE_DISPUTE_TO_SALE",
  /**
   * Assemble what Monacado holds and submit it in the provider's dashboard.
   *
   * Says "in the dashboard" deliberately: evidence submission is not implemented
   * here, and an action that said "submit evidence" would imply a button exists.
   */
  "ASSEMBLE_EVIDENCE_AND_SUBMIT_IN_DASHBOARD",
  /** The deadline has gone. Nothing can be responded to now. */
  "DEADLINE_PASSED_NO_ACTION_POSSIBLE",
  /** The provider permits no response at all. Record and move on. */
  "NO_RESPONSE_PERMITTED_RECORD_ONLY",
  /** Monacado's own records disagree. Investigate before doing anything. */
  "INVESTIGATE_RECORD_DIVERGENCE",
  /**
   * A sale's tax stands reported and a bank has taken the money back.
   * **No retry can help** — putting it right is a tax adjustment.
   */
  "OPERATOR_TAX_ADJUSTMENT_REQUIRED",
  /** A party was paid for a sale that has been charged back. */
  "OPERATOR_RECOVERY_REQUIRED",
] as const;
export const DisputeOperatorAction = z.enum(DISPUTE_OPERATOR_ACTIONS);
export type DisputeOperatorAction = z.infer<typeof DisputeOperatorAction>;

/**
 * The action for one dispute, from its own fields alone.
 *
 * Pure and total, so the operator command, the readiness check, and the tests
 * all derive one answer rather than three that agree by accident.
 *
 * Order matters: the checks that make other advice useless come first. Telling
 * somebody to assemble evidence for a dispute the network will not accept a
 * response to is worse than telling them nothing.
 */
export function disputeOperatorActionFor(input: {
  status: DisputeStatus;
  remediationCode: DisputeRemediationCode | null;
  taxConsequence: DisputeTaxConsequence;
  responsePermitted: boolean;
  evidenceDueBy: string | null;
  hasPaidRecoveryExceptionOpen: boolean;
  at: string;
}): DisputeOperatorAction {
  if (input.remediationCode === "UNATTRIBUTABLE") return "ATTRIBUTE_DISPUTE_TO_SALE";

  if (input.taxConsequence === "REVERSAL_REQUIRED_NOT_EXPRESSIBLE") {
    return "OPERATOR_TAX_ADJUSTMENT_REQUIRED";
  }

  if (input.remediationCode !== null) return "INVESTIGATE_RECORD_DIVERGENCE";

  if (input.status === "LOST" && input.hasPaidRecoveryExceptionOpen) {
    return "OPERATOR_RECOVERY_REQUIRED";
  }

  if (input.status === "WON" || input.status === "LOST" || input.status === "CLOSED") {
    return "NONE";
  }

  /* Below here the dispute is live. Whether anything can be DONE about it is
     the provider's call, not Monacado's, so those checks come before advice. */
  if (!input.responsePermitted) return "NO_RESPONSE_PERMITTED_RECORD_ONLY";

  if (input.evidenceDueBy !== null) {
    const due = Date.parse(input.evidenceDueBy);
    const now = Date.parse(input.at);
    if (Number.isFinite(due) && Number.isFinite(now)) {
      if (due <= now) return "DEADLINE_PASSED_NO_ACTION_POSSIBLE";
      return "ASSEMBLE_EVIDENCE_AND_SUBMIT_IN_DASHBOARD";
    }
  }

  if (input.status === "NEEDS_RESPONSE") return "ASSEMBLE_EVIDENCE_AND_SUBMIT_IN_DASHBOARD";
  return "AWAIT_PROVIDER_DECISION";
}

// — Inspection —

/**
 * One dispute, as an operator needs to see it.
 *
 * Carries the identifiers needed to act and **nothing about the buyer**: no
 * name, no email, no address — and no amount, for the reason in the header.
 */
export const DisputeInspection = z.strictObject({
  disputeId: z.string().min(1).max(191),
  /** NULL when unattributed. */
  orderId: z.string().min(1).max(191).nullable(),
  providerDisputeRef: z.string().min(1).max(191),

  status: DisputeStatus,
  fundsState: DisputeFundsState,
  taxConsequence: DisputeTaxConsequence,
  remediationCode: DisputeRemediationCode.nullable(),

  responsePermitted: z.boolean(),
  evidenceDueBy: z.iso.datetime().nullable(),
  secondsUntilDeadline: z.int().nullable(),

  openedAt: z.iso.datetime(),
  ageSeconds: z.int().min(0),
  lastProviderEventAt: z.iso.datetime(),
  observationAgeSeconds: z.int().min(0),

  heldObligationCount: z.int().min(0),
  openRecoveryExceptionCount: z.int().min(0),

  action: DisputeOperatorAction,
});
export type DisputeInspection = z.infer<typeof DisputeInspection>;

/** Readiness of the dispute book itself. */
export const DisputeOperationsReadiness = z.strictObject({
  healthy: z.boolean(),
  blockers: z.array(DisputeOperationsBlockerCode),
  backlog: DisputeBacklog,
});
export type DisputeOperationsReadiness = z.infer<typeof DisputeOperationsReadiness>;

// — Evidence availability —

/**
 * What Monacado holds that could answer a dispute, as a **derived** view.
 *
 * Deliberately **not a table**. Every entry below already exists as an
 * authoritative record; copying it into a dispute-evidence table would create a
 * second answer able to disagree with the record it describes — and the two most
 * valuable entries, the receipt and the buyer correspondence, would turn such a
 * table into a mail archive holding buyer addresses.
 *
 * So this is computed on request from immutable records, and carries a
 * **reference** to each, never a copy of its contents.
 */
export const DISPUTE_EVIDENCE_CODES = [
  /** The receipt, plus provable delivery of it to the cardholder's address. */
  "RECEIPT_AND_DELIVERY_PROOF",
  /** Every message Monacado sent about this Order. */
  "CUSTOMER_COMMUNICATION",
  /** The seller's refund policy version bound at purchase. */
  "REFUND_POLICY_VERSION_BOUND_AT_PURCHASE",
  /** The marketplace policy version in force at purchase. */
  "MARKETPLACE_POLICY_VERSION_AT_PURCHASE",
  /** What was bought, from sale-time evidence. */
  "PRODUCT_DESCRIPTION_AT_SALE",
  /** When the sale completed. */
  "SERVICE_DATE",
  /** The seller support contact disclosed with the purchase. */
  "DISCLOSED_SELLER_CONTACT",
  /**
   * Proof of physical dispatch. **Never available**: no carrier, tracking, or
   * fulfilment field exists anywhere in this repository, so physical-goods
   * representment cannot be evidenced today. Named so the gap is visible rather
   * than discovered during a dispute.
   */
  "SHIPPING_DOCUMENTATION",
  /**
   * Proof of digital access. **Never available**: entitlement delivery is
   * declared as policy and its machinery is unbuilt.
   */
  "ACCESS_ACTIVITY_LOG",
] as const;
export const DisputeEvidenceCode = z.enum(DISPUTE_EVIDENCE_CODES);
export type DisputeEvidenceCode = z.infer<typeof DisputeEvidenceCode>;

export const DisputeEvidenceAvailability = z.strictObject({
  evidenceCode: DisputeEvidenceCode,
  available: z.boolean(),
  /** A pointer into Monacado's own records. Never the evidence itself. */
  monacadoRecordRef: z.string().min(1).max(191).nullable(),
});
export type DisputeEvidenceAvailability = z.infer<typeof DisputeEvidenceAvailability>;

/** The evidence codes no Monacado record can currently satisfy. */
export const DISPUTE_EVIDENCE_CODES_NEVER_AVAILABLE: readonly DisputeEvidenceCode[] =
  Object.freeze(["SHIPPING_DOCUMENTATION", "ACCESS_ACTIVITY_LOG"]);
