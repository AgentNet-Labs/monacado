/**
 * Phase 1.11 — disputes and chargebacks, contract tests.
 *
 * Pure. No database, no network, no credential, no Stripe client. Every provider
 * object below is a plain literal shaped like what the pinned SDK types
 * describe — which is the point: if the adapter ever needed a real client to be
 * tested, it would be reaching one at runtime too.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  DISPUTE_ECONOMIC_EFFECTS,
  DISPUTE_EVENT_KINDS,
  DISPUTE_EVIDENCE_SUBMISSION_SEAM,
  DISPUTE_EXECUTION_DEFERRAL,
  DISPUTE_FUNDS_STATES,
  DISPUTE_LANGUAGE_ON_RECEIPT,
  DISPUTE_REASON_CODES,
  DISPUTE_REMEDIATION_CODES,
  DISPUTE_STATUSES,
  DISPUTE_TAX_CONSEQUENCES,
  DisputeObservation,
  NEVER_ON_TRANSACTION_DISPUTE,
  NON_TERMINAL_DISPUTE_STATUSES,
  REQUIRED_MARKETPLACE_POLICY_DISPUTE_VERSION,
  TransactionDisputeRecord,
  isDisputeOpen,
  isValidDisputeStatusTransition,
} from "../src/contracts/marketplace/transaction-dispute";
import {
  DISPUTE_EVIDENCE_CODES_NEVER_AVAILABLE,
  DISPUTE_OPERATIONS_POLICY,
  DISPUTE_OPERATOR_ACTIONS,
  disputeOperatorActionFor,
} from "../src/contracts/marketplace/dispute-operations";
import {
  DISPUTE_FINDINGS_NEEDING_OPERATOR,
  DISPUTE_PROVIDER_AUDIT_SEAM,
  DISPUTE_RECONCILIATION_FINDING_CODES,
  HEALTHY_DISPUTE_FINDING_CODES,
  disputeFindingNeedsOperator,
} from "../src/contracts/marketplace/dispute-reconciliation";
import {
  DISPUTE_CAPSULE_PUBLICATION_DISPOSITION,
  DisputeCapsuleCandidate,
  NEVER_IN_DISPUTE_CAPSULE,
  disputeCapsuleHash,
  projectDisputeCapsule,
} from "../src/contracts/marketplace/dispute.capsule";
import {
  REVERSAL_KINDS,
  REVERSAL_REASON_CODES,
  REVERSAL_SCOPES,
} from "../src/contracts/marketplace/transaction-reversal";
import {
  PROCEEDS_RECOVERY_CAUSE_KINDS,
  PROCEEDS_RECOVERY_REASON_CODES,
  PROCEEDS_RECOVERY_RESOLUTION_CODES,
  PROCEEDS_RECOVERY_STATUSES,
  causeKindForRecoveryReason,
  recoveryReasonForObligationState,
} from "../src/contracts/marketplace/proceeds-recovery";
import { REFUND_REFUSAL_CODES } from "../src/contracts/marketplace/order-refund";
import { CAPSULE_VISIBILITY_POLICY, capsuleVisibilityFor } from "../src/contracts/capsule/visibility";
import { OUTBOUND_EMAIL_PURPOSES } from "../src/contracts/marketplace/outbound-email";
import {
  MONACADO_MARKETPLACE_POLICY_V1_1,
  MONACADO_MARKETPLACE_POLICY_V1_1_HASH,
} from "../src/contracts/marketplace/marketplace-policy-content";
import { selectSection } from "../src/contracts/marketplace/marketplace-policy";
import {
  DISPUTE_NOTIFICATION_CONTEXT_CODES,
  NOTIFICATION_CATEGORIES,
} from "../src/contracts/marketplace/notification-obligation";
import {
  DISPUTE_READINESS_BLOCKER_CODES,
  DISPUTE_CAPABILITY_IMPLEMENTATION,
  evaluateDisputeReadiness,
} from "../src/server/operations/dispute-readiness";
import { LIVE_READINESS_BLOCKER_CODES } from "../src/server/operations/live-commerce-readiness";
import {
  HANDLED_DISPUTE_EVENT_TYPES,
  createStripeDisputeNotificationPort,
  disputeReasonFromProvider,
  disputeStatusFromProvider,
} from "../src/server/payments/stripe-dispute-adapter";
import { TRANSACTION_DISPUTE_ID_RE } from "../src/contracts/marketplace/identity";

const AT = "2028-09-01T12:00:00.000Z";
const DISPUTE_ID = "mon:dspt:0123456789ABCDEFGHJKMNP0TV";
const SNAPSHOT_ID = "mon:txsnp:0123456789ABCDEFGHJKMNP0TV";
const ORDER_ID = "mon:order:0123456789ABCDEFGHJKMNP0TV";

const RECORD = TransactionDisputeRecord.parse({
  disputeId: DISPUTE_ID,
  orderId: ORDER_ID,
  snapshotId: SNAPSHOT_ID,
  provider: "STRIPE",
  providerMode: "TEST",
  providerDisputeRef: "dp_test_1",
  providerTransactionRef: "pi_test_1",
  providerChargeRef: "ch_test_1",
  disputedAmountMinorUnits: 12_500,
  currency: "USD",
  reasonCode: "PRODUCT_NOT_RECEIVED",
  status: "NEEDS_RESPONSE",
  fundsState: "NOT_WITHDRAWN",
  taxConsequence: "NOT_ASSESSED",
  economicEffect: "NONE",
  evidenceDueBy: "2028-09-08T12:00:00.000Z",
  responsePermitted: true,
  evidenceStagedAtProvider: false,
  evidenceSubmissionCount: 0,
  evidenceSubmittedPastDue: false,
  chargeStillRefundable: true,
  remediationCode: null,
  lastProviderEventAt: AT,
  openedAt: AT,
  fundsWithdrawnAt: null,
  fundsReinstatedAt: null,
  closedAt: null,
  recordedAt: AT,
  updatedAt: AT,
  reversalId: null,
});

const readSource = (relative: string): string =>
  readFileSync(resolve(process.cwd(), relative), "utf8");

/**
 * The same source with comments removed.
 *
 * Several assertions below mean "the CODE never does this", and the code
 * frequently names the very thing it refuses in a comment explaining the
 * refusal. Asserting against raw text would make a well-explained decision
 * indistinguishable from a violation of it — and would punish exactly the
 * comments worth writing.
 */
const readCode = (relative: string): string =>
  readSource(relative)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

// ---------------------------------------------------------------------------

describe("1.11 — the handled dispute event set", () => {
  it("names exactly the five charge.dispute events", () => {
    expect([...HANDLED_DISPUTE_EVENT_TYPES].sort()).toEqual([
      "charge.dispute.closed",
      "charge.dispute.created",
      "charge.dispute.funds_reinstated",
      "charge.dispute.funds_withdrawn",
      "charge.dispute.updated",
    ]);
  });

  it("handles no issuing dispute event, because Monacado is not a card issuer", () => {
    expect(HANDLED_DISPUTE_EVENT_TYPES.some((t) => t.startsWith("issuing_dispute"))).toBe(false);
  });

  it("handles no early fraud warning, which is a different fact needing its own model", () => {
    expect(HANDLED_DISPUTE_EVENT_TYPES.some((t) => t.includes("early_fraud"))).toBe(false);
    expect(DISPUTE_EXECUTION_DEFERRAL.earlyFraudWarningIngestion).toBe("NOT_IMPLEMENTED");
  });

  it("keeps closure and funds movement as separate event kinds", () => {
    expect(DISPUTE_EVENT_KINDS).toContain("CLOSED");
    expect(DISPUTE_EVENT_KINDS).toContain("FUNDS_WITHDRAWN");
    expect(DISPUTE_EVENT_KINDS).toContain("FUNDS_REINSTATED");
  });
});

describe("1.11 — status mapping is total and bounded", () => {
  it("maps every status the provider documents to a Monacado member", () => {
    const documented = [
      "warning_needs_response",
      "warning_under_review",
      "warning_closed",
      "needs_response",
      "under_review",
      "won",
      "lost",
      "prevented",
    ];
    for (const status of documented) {
      const mapped = disputeStatusFromProvider(status);
      expect(DISPUTE_STATUSES, status).toContain(mapped);
      /* A DOCUMENTED status must never land in the human-required sink: that
         member is for things this build does not recognise. */
      expect(mapped, status).not.toBe("MANUAL_REMEDIATION_REQUIRED");
    }
  });

  it("degrades an unrecognised provider status rather than guessing the nearest bucket", () => {
    expect(disputeStatusFromProvider("some_future_status")).toBe("MANUAL_REMEDIATION_REQUIRED");
    expect(disputeStatusFromProvider("")).toBe("MANUAL_REMEDIATION_REQUIRED");
  });

  it("treats an early warning as needing a response, not as a separate lifecycle", () => {
    expect(disputeStatusFromProvider("warning_needs_response")).toBe("NEEDS_RESPONSE");
    expect(disputeStatusFromProvider("warning_under_review")).toBe("UNDER_REVIEW");
  });

  it("maps every provider reason into a bounded vocabulary and keeps no provider text", () => {
    expect(disputeReasonFromProvider("fraudulent")).toBe("FRAUDULENT");
    expect(disputeReasonFromProvider("something_new")).toBe("UNSPECIFIED");
    for (const code of DISPUTE_REASON_CODES) expect(typeof code).toBe("string");
  });

  it("derives openness rather than storing it", () => {
    expect(isDisputeOpen("NEEDS_RESPONSE")).toBe(true);
    expect(isDisputeOpen("UNDER_REVIEW")).toBe(true);
    expect(isDisputeOpen("WON")).toBe(false);
    expect(isDisputeOpen("LOST")).toBe(false);
    expect(isDisputeOpen("CLOSED")).toBe(false);
    /* The record carries no `open` column that could disagree with `status`. */
    expect(Object.keys(RECORD)).not.toContain("open");
    expect(Object.keys(RECORD)).not.toContain("isOpen");
  });
});

describe("1.11 — adjudication and funds are independent axes", () => {
  it("keeps a separate funds vocabulary", () => {
    expect(DISPUTE_FUNDS_STATES).toEqual(["NOT_WITHDRAWN", "WITHDRAWN", "REINSTATED"]);
  });

  it("permits a decided dispute that moved no money", () => {
    const won = TransactionDisputeRecord.parse({
      ...RECORD,
      status: "WON",
      fundsState: "NOT_WITHDRAWN",
    });
    expect(won.status).toBe("WON");
    expect(won.fundsState).toBe("NOT_WITHDRAWN");
  });

  it("permits withdrawn funds on a dispute still under review", () => {
    const midflight = TransactionDisputeRecord.parse({
      ...RECORD,
      status: "UNDER_REVIEW",
      fundsState: "WITHDRAWN",
      fundsWithdrawnAt: AT,
    });
    expect(midflight.fundsState).toBe("WITHDRAWN");
  });
});

describe("1.11 — a decided dispute is forward-only", () => {
  it("refuses to leave a terminal adjudication status", () => {
    for (const terminal of ["WON", "LOST", "CLOSED"] as const) {
      expect(isValidDisputeStatusTransition(terminal, "NEEDS_RESPONSE")).toBe(false);
      expect(isValidDisputeStatusTransition(terminal, "UNDER_REVIEW")).toBe(false);
      expect(isValidDisputeStatusTransition(terminal, "OPEN")).toBe(false);
    }
  });

  it("tolerates a redelivery of the same status", () => {
    expect(isValidDisputeStatusTransition("LOST", "LOST")).toBe(true);
  });

  it("lets a human record an outcome on a dispute that needed one", () => {
    expect(isValidDisputeStatusTransition("MANUAL_REMEDIATION_REQUIRED", "LOST")).toBe(true);
  });

  it("names exactly the non-terminal statuses the payout hold keys on", () => {
    expect([...NON_TERMINAL_DISPUTE_STATUSES].sort()).toEqual([
      "MANUAL_REMEDIATION_REQUIRED",
      "NEEDS_RESPONSE",
      "OPEN",
      "UNDER_REVIEW",
    ]);
  });
});

describe("1.11 — a lost dispute reuses the accounting vocabulary 1.2 reserved", () => {
  it("needs no new reversal kind or reason, because both already exist", () => {
    expect(REVERSAL_KINDS).toContain("CHARGEBACK");
    expect(REVERSAL_REASON_CODES).toContain("DISPUTED_BY_BUYER");
  });

  it("still reverses in FULL scope only", () => {
    expect(REVERSAL_SCOPES).toEqual(["FULL"]);
  });

  it("names the partial case as inexpressible rather than approximating it", () => {
    expect(DISPUTE_REMEDIATION_CODES).toContain("PARTIAL_AMOUNT_NOT_EXPRESSIBLE");
    expect(DISPUTE_EXECUTION_DEFERRAL.partialDisputeAccounting).toBe("NOT_IMPLEMENTED");
  });

  it("distinguishes a reversal it wrote from one a refund already wrote", () => {
    expect(DISPUTE_ECONOMIC_EFFECTS).toContain("REVERSED_BY_THIS_DISPUTE");
    expect(DISPUTE_ECONOMIC_EFFECTS).toContain("ALREADY_REVERSED_BY_REFUND");
    expect(DISPUTE_ECONOMIC_EFFECTS).toContain("NOT_EXPRESSIBLE");
  });
});

describe("1.11 — the refund path refuses to race a bank for the same money", () => {
  it("names an open and a lost dispute as distinct refusals", () => {
    expect(REFUND_REFUSAL_CODES).toContain("SALE_DISPUTE_OPEN");
    expect(REFUND_REFUSAL_CODES).toContain("SALE_DISPUTE_LOST");
  });

  it("keeps them distinct from SALE_ALREADY_REVERSED, which names a different cause", () => {
    expect(REFUND_REFUSAL_CODES).toContain("SALE_ALREADY_REVERSED");
    const disputeCodes = REFUND_REFUSAL_CODES.filter((c) => c.startsWith("SALE_DISPUTE"));
    expect(disputeCodes).toHaveLength(2);
  });

  it("checks the guard in the one function both refund paths run through", () => {
    /* `verifyExecutableRefund` re-evaluates eligibility immediately before
       contacting the provider, so a refund requested before a dispute arrived
       and claimed after it meets the same refusal. Asserted against the source
       so the single-point property cannot be quietly split in two. */
    const source = readSource("src/server/marketplace/order-refund-service.ts");
    expect(source).toContain("disputeBlockingRefundIn");
    const processor = readSource("src/server/marketplace/refund-processor.ts");
    expect(processor).toContain("evaluateRefundEligibility");
  });
});

describe("1.11 — proceeds recovery gained a cause, and nothing else", () => {
  it("names both causes explicitly rather than inferring from which reference is set", () => {
    expect(PROCEEDS_RECOVERY_CAUSE_KINDS).toEqual(["REFUND", "DISPUTE"]);
  });

  it("keeps the refund reasons and adds the dispute ones", () => {
    expect(PROCEEDS_RECOVERY_REASON_CODES).toContain("PAID_BEFORE_REFUND");
    expect(PROCEEDS_RECOVERY_REASON_CODES).toContain("ELIGIBLE_BEFORE_REFUND");
    expect(PROCEEDS_RECOVERY_REASON_CODES).toContain("PAID_BEFORE_DISPUTE");
    expect(PROCEEDS_RECOVERY_REASON_CODES).toContain("ELIGIBLE_BEFORE_DISPUTE");
  });

  it("raises nothing for a PENDING claim under either cause", () => {
    expect(recoveryReasonForObligationState("PENDING", "REFUND")).toBeNull();
    expect(recoveryReasonForObligationState("PENDING", "DISPUTE")).toBeNull();
  });

  it("keeps 1.9's behaviour when no cause is given", () => {
    expect(recoveryReasonForObligationState("PAID")).toBe("PAID_BEFORE_REFUND");
    expect(recoveryReasonForObligationState("ELIGIBLE")).toBe("ELIGIBLE_BEFORE_REFUND");
  });

  it("maps every reason back to its cause", () => {
    for (const reason of PROCEEDS_RECOVERY_REASON_CODES) {
      expect(PROCEEDS_RECOVERY_CAUSE_KINDS).toContain(causeKindForRecoveryReason(reason));
    }
    expect(causeKindForRecoveryReason("PAID_BEFORE_DISPUTE")).toBe("DISPUTE");
    expect(causeKindForRecoveryReason("PAID_BEFORE_REFUND")).toBe("REFUND");
  });

  it("closes a won dispute's exception as settled, never as raised in error", () => {
    expect(PROCEEDS_RECOVERY_RESOLUTION_CODES).toContain("DISPUTE_RESOLVED_NO_RECOVERY_DUE");
    /* The distinction matters: the exception WAS validly raised, and recording
       it as an error would make correct precautions indistinguishable from
       mistakes when somebody audits how often exceptions are raised wrongly. */
    expect(PROCEEDS_RECOVERY_RESOLUTION_CODES).toContain("RAISED_IN_ERROR");
  });

  it("still has no RECOVERED state, because nothing here recovers anything", () => {
    expect(PROCEEDS_RECOVERY_STATUSES).toEqual(["OPEN", "ACKNOWLEDGED", "RESOLVED"]);
    expect(DISPUTE_EXECUTION_DEFERRAL.clawbackExecution).toBe("NOT_IMPLEMENTED");
  });
});

describe("1.11 — the payout hold is a predicate, not a stored flag", () => {
  it("computes the hold from the dispute rows at the one gate", () => {
    const source = readSource("src/server/marketplace/order-service.ts");
    expect(source).toContain("transactionDispute.count");
    expect(source).toContain("SALE_DISPUTED");
    expect(source).toContain("NON_TERMINAL_DISPUTE_STATUSES");
  });

  it("adds no obligation state and no hold column", () => {
    const schema = readSource("prisma/schema.prisma");
    /* A `HELD` obligation state would reverse a committed forward-only
       transition table; a hold column is on NEVER_ON_PROCEEDS_OBLIGATION. */
    expect(schema).not.toContain("payoutHeldUntil");
    expect(schema).not.toContain("disputeHoldCount");
    expect(schema).not.toContain("reserveHoldMinorUnits BigInt");
  });
});

describe("1.11 — amounts, currency, and deadlines", () => {
  it("keeps money in minor units, as every other financial record does", () => {
    expect(RECORD.disputedAmountMinorUnits).toBe(12_500);
    expect(Number.isInteger(RECORD.disputedAmountMinorUnits)).toBe(true);
  });

  it("refuses a negative disputed amount", () => {
    expect(
      TransactionDisputeRecord.safeParse({ ...RECORD, disputedAmountMinorUnits: -1 }).success,
    ).toBe(false);
  });

  it("stores currency uppercase, though the provider states it lowercase", () => {
    expect(RECORD.currency).toBe("USD");
    expect(TransactionDisputeRecord.safeParse({ ...RECORD, currency: "usd" }).success).toBe(false);
  });

  it("separates no deadline from no response permitted", () => {
    const noDeadline = TransactionDisputeRecord.parse({
      ...RECORD,
      evidenceDueBy: null,
      responsePermitted: true,
    });
    const noResponse = TransactionDisputeRecord.parse({
      ...RECORD,
      evidenceDueBy: null,
      responsePermitted: false,
    });
    /* Both have an empty deadline and they mean opposite things. An operator
       acting on the wrong one wastes the only window there was. */
    expect(noDeadline.evidenceDueBy).toBeNull();
    expect(noResponse.evidenceDueBy).toBeNull();
    expect(noDeadline.responsePermitted).not.toBe(noResponse.responsePermitted);
  });
});

describe("1.11 — nothing provider-shaped or buyer-shaped is persisted", () => {
  it("refuses every field on the never list", () => {
    for (const field of NEVER_ON_TRANSACTION_DISPUTE) {
      const parsed = TransactionDisputeRecord.safeParse({ ...RECORD, [field]: "x" });
      expect(parsed.success, field).toBe(false);
    }
  });

  it("names the buyer identity a dispute event actually carries", () => {
    for (const field of [
      "buyerEmail",
      "buyerName",
      "billingAddress",
      "shippingAddress",
      "customerPurchaseIp",
    ]) {
      expect(NEVER_ON_TRANSACTION_DISPUTE, field).toContain(field);
    }
  });

  it("names the provider text and the raw payload", () => {
    for (const field of ["networkReasonCode", "providerStatusString", "rawEvent", "providerPayload"]) {
      expect(NEVER_ON_TRANSACTION_DISPUTE, field).toContain(field);
    }
  });

  it("stores no raw provider payload column anywhere in the schema", () => {
    const schema = readSource("prisma/schema.prisma");
    const disputeBlock = schema.slice(schema.indexOf("model TransactionDispute {"));
    const block = disputeBlock.slice(0, disputeBlock.indexOf("\n}"));
    for (const f of ["payload", "rawevent", "evidence json", "body json"]) {
      expect(block.toLowerCase(), f).not.toContain(f);
    }
  });

  it("keeps no evidence document, file reference, or tracking number", () => {
    for (const field of ["evidenceDocument", "evidenceFileId", "shippingTrackingNumber"]) {
      expect(NEVER_ON_TRANSACTION_DISPUTE, field).toContain(field);
    }
  });
});

describe("1.11 — the Stripe dispute adapter", () => {
  const secret = "whsec_test_dispute";

  const makeClient = (event: unknown) => ({
    webhooks: {
      constructEventAsync: async () => event,
    },
  });

  const runtime = (event: unknown) =>
    ({
      config: { webhookSecretEnvVar: "STRIPE_WEBHOOK_SECRET" },
      client: makeClient(event),
    }) as never;

  const env = { STRIPE_WEBHOOK_SECRET: secret } as Record<string, string>;

  const disputeEvent = (overrides: Record<string, unknown> = {}) => ({
    id: "evt_test_1",
    type: "charge.dispute.created",
    created: 1_800_000_000,
    data: {
      object: {
        id: "dp_test_1",
        payment_intent: "pi_test_1",
        charge: "ch_test_1",
        amount: 12_500,
        currency: "usd",
        reason: "product_not_received",
        status: "needs_response",
        created: 1_800_000_000,
        livemode: false,
        is_charge_refundable: true,
        evidence_details: {
          due_by: 1_800_600_000,
          has_evidence: false,
          past_due: false,
          submission_count: 0,
        },
        ...overrides,
      },
    },
  });

  it("normalises a dispute event with no Stripe type escaping", async () => {
    const port = createStripeDisputeNotificationPort({ runtime: runtime(disputeEvent()), env });
    const observed = await port.observeDispute({ rawBody: "{}", signatureHeader: "sig" });
    expect(observed).not.toBeNull();
    expect(DisputeObservation.safeParse(observed).success).toBe(true);
  });

  it("attributes by payment intent, never by dispute metadata", async () => {
    const port = createStripeDisputeNotificationPort({ runtime: runtime(disputeEvent()), env });
    const observed = await port.observeDispute({ rawBody: "{}", signatureHeader: "sig" });
    expect(observed?.providerTransactionRef).toBe("pi_test_1");
    /* A Stripe Dispute's `metadata` is its own, not the PaymentIntent's, and is
       always empty here — so the adapter must not READ it. Asserted against the
       code below the header comment, which names the field precisely in order
       to explain why it is never consulted. */
    const code = readCode("src/server/payments/stripe-dispute-adapter.ts");
    expect(code).not.toContain("dispute.metadata");
    expect(code).not.toContain("ORDER_METADATA_KEY");
  });

  it("passes minor units through and uppercases the currency", async () => {
    const port = createStripeDisputeNotificationPort({ runtime: runtime(disputeEvent()), env });
    const observed = await port.observeDispute({ rawBody: "{}", signatureHeader: "sig" });
    expect(observed?.disputedAmountMinorUnits).toBe(12_500);
    expect(observed?.currency).toBe("USD");
  });

  it("reads a due_by of 0 as no response permitted, not as 1970", async () => {
    const port = createStripeDisputeNotificationPort({
      runtime: runtime(
        disputeEvent({
          evidence_details: { due_by: 0, has_evidence: false, past_due: false, submission_count: 0 },
        }),
      ),
      env,
    });
    const observed = await port.observeDispute({ rawBody: "{}", signatureHeader: "sig" });
    expect(observed?.evidenceDueBy).toBeNull();
    expect(observed?.responsePermitted).toBe(false);
  });

  it("reports a livemode dispute rather than silently dropping it", async () => {
    const port = createStripeDisputeNotificationPort({
      runtime: runtime(disputeEvent({ livemode: true })),
      env,
    });
    const observed = await port.observeDispute({ rawBody: "{}", signatureHeader: "sig" });
    expect(observed?.providerReportedLivemode).toBe(true);
  });

  it("returns null for an event that is not a dispute", async () => {
    const port = createStripeDisputeNotificationPort({
      runtime: runtime({ id: "evt_x", type: "checkout.session.completed", created: 1, data: { object: {} } }),
      env,
    });
    expect(await port.observeDispute({ rawBody: "{}", signatureHeader: "sig" })).toBeNull();
  });

  it("refuses a delivery with no signature header, before reading anything", async () => {
    const port = createStripeDisputeNotificationPort({ runtime: runtime(disputeEvent()), env });
    await expect(
      port.observeDispute({ rawBody: "{}", signatureHeader: null }),
    ).rejects.toThrow();
  });

  it("keeps no network reason code, evidence body, or card detail", () => {
    const source = readSource("src/server/payments/stripe-dispute-adapter.ts");
    /* Read as a value only inside the doc comment explaining why it is dropped;
       never assigned into the observation. */
    expect(source).not.toContain("network_reason_code:");
    expect(source).not.toContain("payment_method_details:");
    expect(source).not.toContain("customer_email_address");
  });
});

describe("1.11 — operator actions are derived, not decided in three places", () => {
  const base = {
    status: "NEEDS_RESPONSE" as const,
    remediationCode: null,
    taxConsequence: "NOT_ASSESSED" as const,
    responsePermitted: true,
    evidenceDueBy: null,
    hasPaidRecoveryExceptionOpen: false,
    at: AT,
  };

  it("never says submit evidence when the provider permits no response", () => {
    const action = disputeOperatorActionFor({ ...base, responsePermitted: false });
    expect(action).toBe("NO_RESPONSE_PERMITTED_RECORD_ONLY");
  });

  it("never says submit evidence after the deadline has passed", () => {
    const action = disputeOperatorActionFor({
      ...base,
      evidenceDueBy: "2028-08-01T00:00:00.000Z",
    });
    expect(action).toBe("DEADLINE_PASSED_NO_ACTION_POSSIBLE");
  });

  it("says assemble evidence while a deadline is still running", () => {
    const action = disputeOperatorActionFor({
      ...base,
      evidenceDueBy: "2028-09-08T00:00:00.000Z",
    });
    expect(action).toBe("ASSEMBLE_EVIDENCE_AND_SUBMIT_IN_DASHBOARD");
  });

  it("sends an unattributed dispute to attribution before anything else", () => {
    const action = disputeOperatorActionFor({ ...base, remediationCode: "UNATTRIBUTABLE" });
    expect(action).toBe("ATTRIBUTE_DISPUTE_TO_SALE");
  });

  it("names a tax adjustment no retry can fix", () => {
    const action = disputeOperatorActionFor({
      ...base,
      status: "LOST",
      taxConsequence: "REVERSAL_REQUIRED_NOT_EXPRESSIBLE",
    });
    expect(action).toBe("OPERATOR_TAX_ADJUSTMENT_REQUIRED");
  });

  it("names recovery when a party was paid on a lost dispute", () => {
    const action = disputeOperatorActionFor({
      ...base,
      status: "LOST",
      hasPaidRecoveryExceptionOpen: true,
    });
    expect(action).toBe("OPERATOR_RECOVERY_REQUIRED");
  });

  it("says nothing to do about a decided dispute with nothing outstanding", () => {
    expect(disputeOperatorActionFor({ ...base, status: "WON" })).toBe("NONE");
    expect(disputeOperatorActionFor({ ...base, status: "CLOSED" })).toBe("NONE");
  });

  it("returns only members of the closed vocabulary, for every combination", () => {
    for (const status of DISPUTE_STATUSES) {
      for (const responsePermitted of [true, false]) {
        for (const dueBy of [null, "2028-08-01T00:00:00.000Z", "2028-09-08T00:00:00.000Z"]) {
          const action = disputeOperatorActionFor({
            ...base,
            status,
            responsePermitted,
            evidenceDueBy: dueBy,
          });
          expect(DISPUTE_OPERATOR_ACTIONS, `${status}/${responsePermitted}/${dueBy}`).toContain(
            action,
          );
        }
      }
    }
  });
});

describe("1.11 — evidence submission is a declared seam, not an implementation", () => {
  it("states every unbuilt half as a checkable value", () => {
    /* Two halves moved in 1.12 and two did not, and the pairing is the point:
       submission is built but gated, provider lookup is a pre-flight guard rather
       than a sweep, and both document storage and dispute acceptance remain
       untouched. */
    expect(DISPUTE_EVIDENCE_SUBMISSION_SEAM.evidenceSubmission).toBe(
      "IMPLEMENTED_TEXT_ONLY_TEST_MODE",
    );
    expect(DISPUTE_EVIDENCE_SUBMISSION_SEAM.providerLookup).toBe("IMPLEMENTED_PRE_FLIGHT_ONLY");
    expect(DISPUTE_EVIDENCE_SUBMISSION_SEAM.documentStorage).toBe("NOT_IMPLEMENTED");
    expect(DISPUTE_EVIDENCE_SUBMISSION_SEAM.disputeAcceptance).toBe("NOT_IMPLEMENTED");
    /* The operator now answers through Monacado's own approved-submission path,
       not the provider's dashboard. */
    expect(DISPUTE_EVIDENCE_SUBMISSION_SEAM.operatorResponsePath).toBe(
      "MONACADO_OPERATOR_APPROVED_SUBMISSION",
    );
  });

  it("keeps the intake adapter free of any write to a dispute", () => {
    /* NARROWED, not dropped. 1.12's submission adapter is a SEPARATE module, so
       the module that receives a provider's statement still cannot answer it —
       which is what this assertion was really protecting. */
    const adapter = readSource("src/server/payments/stripe-dispute-adapter.ts");
    expect(adapter).not.toContain("disputes.update");
    expect(adapter).not.toContain("disputes.close");
    expect(adapter).not.toContain("files.create");
  });

  it("closes no dispute and uploads no file, in either adapter", () => {
    /* The two deferrals that must survive 1.12. Accepting a dispute is an
       irreversible acceptance of loss, and no object storage exists — so neither
       adapter may reach either capability. */
    /* `readCode` rather than `readSource`: the 1.12 adapter EXPLAINS in prose why
       it has no close path, and a well-explained decision must not be
       indistinguishable from a violation of it. */
    for (const path of [
      "src/server/payments/stripe-dispute-adapter.ts",
      "src/server/payments/stripe-dispute-evidence-adapter.ts",
    ]) {
      const code = readCode(path);
      expect(code, path).not.toContain("disputes.close");
      expect(code, path).not.toContain("files.create");
    }
  });

  it("names the evidence Monacado can never supply today", () => {
    expect([...DISPUTE_EVIDENCE_CODES_NEVER_AVAILABLE].sort()).toEqual([
      "ACCESS_ACTIVITY_LOG",
      "SHIPPING_DOCUMENTATION",
    ]);
  });

  it("says what it guarantees instead, so the deferral is not read as a gap in everything", () => {
    expect(DISPUTE_EVIDENCE_SUBMISSION_SEAM.guaranteedNow.length).toBeGreaterThan(0);
  });
});

describe("1.11 — the tax consequence fails closed", () => {
  it("names the unexpressible case rather than approximating a reversal", () => {
    expect(DISPUTE_TAX_CONSEQUENCES).toContain("REVERSAL_REQUIRED_NOT_EXPRESSIBLE");
    expect(DISPUTE_EXECUTION_DEFERRAL.disputeCausedTaxReversal).toBe("NOT_IMPLEMENTED");
  });

  it("never reaches a tax calculation port from any dispute path", () => {
    const service = readSource("src/server/marketplace/transaction-dispute-service.ts");
    expect(service).not.toContain("guardTaxPort");
    expect(service).not.toContain("TaxCalculationPort");
    expect(service).not.toContain("calculateTax");
  });

  it("fabricates no refund row to hang a tax reversal from", () => {
    const service = readSource("src/server/marketplace/transaction-dispute-service.ts");
    expect(service).not.toContain("orderRefund.create");
    expect(service).not.toContain("orderTaxReversal.create");
  });
});

describe("1.11 — the original sale is never rewritten", () => {
  it("writes to no snapshot column from the dispute service", () => {
    const service = readSource("src/server/marketplace/transaction-dispute-service.ts");
    for (const forbidden of [
      "transactionEconomicSnapshot.update",
      "transactionEconomicSnapshot.upsert",
      "transactionEconomicSnapshot.create",
      "transactionEconomicSnapshot.delete",
    ]) {
      expect(service, forbidden).not.toContain(forbidden);
    }
  });

  it("changes no Order lifecycle from the dispute service", () => {
    const service = readSource("src/server/marketplace/transaction-dispute-service.ts");
    expect(service).not.toContain("order.update");
    expect(service).not.toContain("lifecycle:");
  });

  it("adds no DISPUTED member to the Order lifecycle", () => {
    const schema = readSource("prisma/schema.prisma");
    expect(schema).not.toContain("PENDING_PAYMENT | PAID | PAYMENT_FAILED | CANCELLED | DISPUTED");
  });

  it("adds no chargeback column to the snapshot", () => {
    const schema = readSource("prisma/schema.prisma");
    const start = schema.indexOf("model TransactionEconomicSnapshot {");
    const block = schema.slice(start, schema.indexOf("\n}", start));
    expect(block).not.toContain("chargebackAmountMinorUnits");
    expect(block).not.toContain("disputedAmount");
  });
});

describe("1.11 — reconciliation answers from local records alone", () => {
  it("makes no provider call and says so as a value", () => {
    expect(DISPUTE_PROVIDER_AUDIT_SEAM.routineReconciliation).toBe("LOCAL_RECORDS_ONLY");
    expect(DISPUTE_PROVIDER_AUDIT_SEAM.providerLookup).toBe("NOT_IMPLEMENTED");
  });

  it("names what local records cannot detect, rather than implying they detect everything", () => {
    expect(DISPUTE_PROVIDER_AUDIT_SEAM.undetectableLocally).toBe(
      "A_PROVIDER_DISPUTE_THAT_NEVER_REACHED_THE_WEBHOOK",
    );
  });

  it("constructs no client in the reconciliation service", () => {
    const source = readSource("src/server/marketplace/dispute-reconciliation-service.ts");
    expect(source).not.toContain("stripe");
    expect(source).not.toContain("Stripe");
  });

  it("covers the double-reversal and stale-hold findings the phase exists to catch", () => {
    for (const code of [
      "DISPUTE_ON_ALREADY_REFUNDED_SALE",
      "DISPUTE_AND_REFUND_BOTH_IN_FLIGHT",
      "DISPUTE_PROCEEDS_STILL_PAYOUT_ELIGIBLE",
      "DISPUTE_PAID_PROCEEDS_LACK_RECOVERY",
      "DISPUTE_PAID_PROMOTER_COMMISSION_LACKS_RECOVERY",
      "DISPUTE_WON_STALE_RECOVERY_EXCEPTION",
      "DISPUTE_WON_STALE_HOLD",
      "DISPUTE_LOST_WITHOUT_ACCOUNTING_REVERSAL",
      "DISPUTE_TAX_CONSEQUENCE_UNRESOLVED",
      "DISPUTE_UNATTRIBUTED",
      "DISPUTE_MISSING_PAYMENT_REFERENCE",
      "DISPUTE_AMOUNT_MISMATCH",
      "DISPUTE_CURRENCY_MISMATCH",
    ]) {
      expect(DISPUTE_RECONCILIATION_FINDING_CODES, code).toContain(code);
    }
  });

  it("separates healthy findings from the ones needing a human", () => {
    for (const code of HEALTHY_DISPUTE_FINDING_CODES) {
      expect(disputeFindingNeedsOperator(code), code).toBe(false);
    }
    for (const code of DISPUTE_FINDINGS_NEEDING_OPERATOR) {
      expect(HEALTHY_DISPUTE_FINDING_CODES, code).not.toContain(code);
    }
  });

  it("treats a working hold as healthy rather than as a defect", () => {
    expect(HEALTHY_DISPUTE_FINDING_CODES).toContain("DISPUTE_OPEN_PROCEEDS_HELD");
  });
});

describe("1.11 — readiness does not claim chargeback readiness", () => {
  /* The same shape every other Stripe test uses: the variable NAMES are
     themselves configuration, so a fixture that invented its own would be
     testing a convention rather than the code. */
  const READY_ENV = {
    MONACADO_STRIPE_ENABLED: "true",
    MONACADO_STRIPE_MODE: "TEST",
    MONACADO_STRIPE_SECRET_KEY: "sk_test_0m9notarealkeyatall000000",
    MONACADO_STRIPE_WEBHOOK_SECRET: "whsec_0m9testsigningsecretvalue000000",
    MONACADO_STRIPE_SUCCESS_URL: "https://monacado.test/checkout/result",
    MONACADO_STRIPE_CANCEL_URL: "https://monacado.test/checkout/result",
  } as Record<string, string>;

  it("still refuses to claim chargeback readiness, now for the right reasons", () => {
    /* 1.11 asserted one unconditional blocker. 1.12 built the adapter and the §I
       ruling authorised the send, so both the capability blocker and the
       governance one clear — and this test exists to make sure clearing them did
       not turn the gate green. Representment being authorised is not the same as
       being able to answer every dispute. */
    const report = evaluateDisputeReadiness(AT, READY_ENV);
    expect(report.representmentAuthorised).toBe(true);
    expect(report.providerSubmissionImplemented).toBe(true);
    expect(report.blockers).not.toContain("DISPUTE_EVIDENCE_RESPONSE_NOT_IMPLEMENTED");

    expect(report.ready).toBe(false);
    expect(report.blockers).toContain("DISPUTE_PROVIDER_MODE_TEST_ONLY");
    expect(report.blockers).toContain("DISPUTE_EVIDENCE_ASSEMBLY_INCOMPLETE");
    expect(report.blockers).toContain("DISPUTE_EVIDENCE_DOCUMENT_SUBMISSION_NOT_IMPLEMENTED");
  });

  it("cannot be made ready by configuration alone, however complete", () => {
    /* The load-bearing one. `DISPUTE_EVIDENCE_ASSEMBLY_INCOMPLETE` is read from a
       frozen constant, so no environment can clear it while whole classes of sale
       remain unevidenceable — and it never encoded the governance hold, which is
       why it survives the ruling that removed the hold. */
    const report = evaluateDisputeReadiness(AT, READY_ENV);
    expect(report.ready).toBe(false);
    expect(report.evidenceAssemblyComplete).toBe(false);
    expect(report.blockers).toContain("DISPUTE_EVIDENCE_ASSEMBLY_INCOMPLETE");
  });

  it("blocks when nothing could receive a dispute at all", () => {
    const report = evaluateDisputeReadiness(AT, {});
    expect(report.blockers).toContain("DISPUTE_INTAKE_NOT_CONFIGURED");
  });

  it("blocks when a dispute delivery could not be verified", () => {
    const { MONACADO_STRIPE_WEBHOOK_SECRET: _omitted, ...noSecret } = READY_ENV;
    const report = evaluateDisputeReadiness(AT, noSecret);
    expect(report.blockers).toContain("DISPUTE_WEBHOOK_NOT_VERIFIABLE");
    expect(report.webhookVerifiable).toBe(false);
  });

  it("clears the verification blocker when the signing secret is configured", () => {
    const report = evaluateDisputeReadiness(AT, READY_ENV);
    expect(report.webhookVerifiable).toBe(true);
    expect(report.blockers).not.toContain("DISPUTE_WEBHOOK_NOT_VERIFIABLE");
    expect(report.blockers).not.toContain("DISPUTE_INTAKE_NOT_CONFIGURED");
  });

  it("returns no secret value, only whether one is present", () => {
    const report = evaluateDisputeReadiness(AT, READY_ENV);
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain("whsec_");
    expect(serialised).not.toContain("sk_test_");
  });

  it("surfaces every dispute blocker on the live-commerce gate", () => {
    for (const code of DISPUTE_READINESS_BLOCKER_CODES) {
      expect(LIVE_READINESS_BLOCKER_CODES, code).toContain(code);
    }
    expect(LIVE_READINESS_BLOCKER_CODES).toContain("DISPUTE_BACKLOG_UNHEALTHY");
  });

  it("says what is built and what is not, so neither is inferred", () => {
    expect(DISPUTE_CAPABILITY_IMPLEMENTATION.disputeIntakeAdapter).toBe("STRIPE_TEST_MODE");
    expect(DISPUTE_CAPABILITY_IMPLEMENTATION.disputeEventLedger).toBe("IMPLEMENTED");
    expect(DISPUTE_CAPABILITY_IMPLEMENTATION.chargebackAccounting).toBe(
      "IMPLEMENTED_FULL_SCOPE_ONLY",
    );
    /* Deliberately not a bare "IMPLEMENTED". The value is read by readiness, and
       a word that flattened test-mode-only, text-only, and gated into one would
       be how a partial capability gets reported as a complete one. */
    expect(DISPUTE_CAPABILITY_IMPLEMENTATION.evidenceSubmissionAdapter).toBe(
      "IMPLEMENTED_TEXT_ONLY_TEST_MODE",
    );
    /* Unchanged, and both must stay so: accepting a loss is irreversible, and no
       object storage exists. */
    expect(DISPUTE_CAPABILITY_IMPLEMENTATION.disputeAcceptanceAdapter).toBe("NOT_IMPLEMENTED");
    expect(DISPUTE_CAPABILITY_IMPLEMENTATION.disputeEvidenceDocumentStorage).toBe(
      "NOT_IMPLEMENTED",
    );
  });

  it("makes no plan-dependent scheduling claim", () => {
    const source = readSource("src/server/operations/dispute-readiness.ts");
    expect(source).not.toContain("cron");
    expect(source).not.toContain("vercel.json");
  });
});

describe("1.11 — notifications", () => {
  it("adds a dispute purpose distinct from the refund one", () => {
    expect(OUTBOUND_EMAIL_PURPOSES).toContain("DISPUTE_RECORDED");
    expect(OUTBOUND_EMAIL_PURPOSES).toContain("REFUND_RECORDED");
  });

  it("has no buyer-facing dispute purpose at all", () => {
    const buyerish = OUTBOUND_EMAIL_PURPOSES.filter(
      (p) => p.startsWith("DISPUTE") && p.includes("COMPLETED"),
    );
    expect(buyerish).toEqual([]);
  });

  it("reuses the category 0M.N1 already named, rather than widening the vocabulary", () => {
    expect(NOTIFICATION_CATEGORIES).toContain("REFUND_OR_CHARGEBACK");
    expect(NOTIFICATION_CATEGORIES).toContain("OPERATIONAL_ACTION_REQUIRED");
  });

  it("carries a context code, which is what stops a dispute upserting onto a refund's row", () => {
    expect(DISPUTE_NOTIFICATION_CONTEXT_CODES).toContain("DISPUTE_OPENED");
    expect(DISPUTE_NOTIFICATION_CONTEXT_CODES).toContain("DISPUTE_LOST");
    expect(DISPUTE_NOTIFICATION_CONTEXT_CODES).toContain("DISPUTE_WON");
    /* 1.9's refund notices write contextCode: null against the same category
       and subject, so a null here would resolve to the refund's obligation. */
    const notice = readSource("src/server/notifications/dispute-notice-service.ts");
    const code = notice.slice(notice.indexOf("export async function enqueueDisputeNotices"));
    expect(code).toContain("contextCode,");
    expect(code).not.toContain("contextCode: null");
  });

  it("discriminates a second dispute on one Order rather than suppressing it", () => {
    const notice = readSource("src/server/notifications/dispute-notice-service.ts");
    expect(notice).toContain("discriminator: dispute.providerDisputeRef");
  });

  it("renders a purpose-specific message and never falls through to order-expired", () => {
    /* The hazard 1.11 found and closed: the resolver ended in a two-branch
       fallback, so any purpose added later silently rendered "your order
       expired" to a buyer. */
    const resolver = readSource("src/server/notifications/email-message-resolver.ts");
    expect(resolver).toContain('delivery.purpose === "ORDER_CANCELLED"');
    expect(resolver).toContain("renderParticipantDisputeRecorded");
  });

  it("never lets a delivery failure determine financial truth", () => {
    const handler = readSource("src/server/payments/stripe-webhook-route-handler.ts");
    /* Notices are enqueued after the dispute row commits, inside a try that
       swallows. A dispute recorded but unmailed is still recorded. */
    expect(handler).toContain("enqueueDisputeNotices");
  });

  it("tells the buyer nothing, and records that as a decision", () => {
    const notice = readSource("src/server/notifications/dispute-notice-service.ts");
    expect(notice).not.toContain('audience: "BUYER"');
    expect(notice).not.toContain("getBuyerSnapshot");
  });

  it("keeps no amount or buyer detail in the seller's message", () => {
    const renderer = readSource("src/server/notifications/transactional-notice-service.ts");
    const start = renderer.indexOf("export function renderParticipantDisputeRecorded");
    const block = renderer.slice(start, renderer.indexOf("\n}", start));
    expect(block).not.toContain("MinorUnits");
    expect(block).not.toContain("buyer");
    expect(block).not.toContain("reasonCode");
  });
});

describe("1.11 — the private dispute capsule", () => {
  const CONTEXT = {
    generatedAt: AT,
    capsuleSemver: "1.0.0",
    mappingVersion: "dispute-mapping/1.0.0",
  };

  it("is governed PRIVATE", () => {
    expect(capsuleVisibilityFor("Dispute")).toBe("PRIVATE");
    expect(CAPSULE_VISIBILITY_POLICY.Dispute).toBe("PRIVATE");
  });

  it("projects deterministically", () => {
    const a = projectDisputeCapsule(RECORD, CONTEXT);
    const b = projectDisputeCapsule(RECORD, CONTEXT);
    expect(disputeCapsuleHash(a)).toBe(disputeCapsuleHash(b));
    expect(DisputeCapsuleCandidate.safeParse(a).success).toBe(true);
  });

  it("carries no buyer, no evidence, and no provider text", () => {
    const capsule = projectDisputeCapsule(RECORD, CONTEXT);
    const serialised = JSON.stringify(capsule).toLowerCase();
    for (const token of [
      "buyername",
      "buyeremail",
      "billingaddress",
      "shippingaddress",
      "cardlast4",
      "networkreasoncode",
      "evidencedocument",
      "rawprovider",
    ]) {
      expect(serialised, token).not.toContain(token);
    }
  });

  it("refuses every field on the capsule never list", () => {
    const capsule = projectDisputeCapsule(RECORD, CONTEXT);
    for (const field of NEVER_IN_DISPUTE_CAPSULE) {
      const tampered = { ...capsule, data: { ...capsule.data, [field]: "x" } };
      expect(DisputeCapsuleCandidate.safeParse(tampered).success, field).toBe(false);
    }
  });

  it("projects an open and an unattributed dispute, which is what audit needs most", () => {
    const unattributed = TransactionDisputeRecord.parse({
      ...RECORD,
      orderId: null,
      snapshotId: null,
      status: "MANUAL_REMEDIATION_REQUIRED",
      remediationCode: "UNATTRIBUTABLE",
    });
    const capsule = projectDisputeCapsule(unattributed, CONTEXT);
    expect(capsule.data.orderRef).toBeNull();
  });

  it("fails closed on an invalid record rather than projecting best effort", () => {
    expect(() => projectDisputeCapsule({ disputeId: "nope" }, CONTEXT)).toThrow();
  });

  it("publishes nothing, and says so as a value", () => {
    expect(DISPUTE_CAPSULE_PUBLICATION_DISPOSITION.agentNetPublication).toBe("NONE");
    expect(DISPUTE_CAPSULE_PUBLICATION_DISPOSITION.nodeRegistration).toBe("NONE");
    expect(DISPUTE_CAPSULE_PUBLICATION_DISPOSITION.registrarContact).toBe("NONE");
    expect(DISPUTE_CAPSULE_PUBLICATION_DISPOSITION.outboxRow).toBe("NONE");
  });

  it("writes no outbox row anywhere for a dispute capsule", () => {
    const capsule = readSource("src/contracts/marketplace/dispute.capsule.ts");
    const code = capsule.slice(capsule.indexOf("export const DISPUTE_TYPE"));
    expect(code).not.toContain("publicationOutbox");
    expect(code).not.toContain("registrarReceipt");
    expect(code).not.toContain("submitToRegistrar");
    /* The only mention of a Registrar is the disposition constant saying it is
       never contacted, which is the claim rather than a violation of it. */
    expect(DISPUTE_CAPSULE_PUBLICATION_DISPOSITION.registrarContact).toBe("NONE");
  });
});

describe("1.11 — identity", () => {
  it("uses a distinct opaque prefix that encodes nothing", () => {
    expect(TRANSACTION_DISPUTE_ID_RE.test(DISPUTE_ID)).toBe(true);
    expect(TRANSACTION_DISPUTE_ID_RE.test("mon:txrev:0123456789ABCDEFGHJKMNP0TV")).toBe(false);
    /* No amount, party, status, or provider reference in the identifier. */
    expect(DISPUTE_ID).not.toContain("dp_");
    expect(DISPUTE_ID).not.toContain("LOST");
  });
});

describe("1.11 — policy and receipt disposition", () => {
  it("requires a future marketplace policy version rather than editing a standing one", () => {
    expect(REQUIRED_MARKETPLACE_POLICY_DISPUTE_VERSION.mutateActiveVersion).toBe("REFUSED");
    expect(REQUIRED_MARKETPLACE_POLICY_DISPUTE_VERSION.mutateRecordedDraftVersion).toBe("REFUSED");
  });

  it("names the promoter-commission gap that makes a new version necessary", () => {
    expect(REQUIRED_MARKETPLACE_POLICY_DISPUTE_VERSION.pointsToState).toContain(
      "PROMOTER_COMMISSION_IS_CONDITIONAL_HOWEVER_THE_SALE_IS_UNDONE",
    );
  });

  it("preserves buyer payment-network rights and never steers a buyer toward a dispute", () => {
    const points = REQUIRED_MARKETPLACE_POLICY_DISPUTE_VERSION.pointsToState;
    expect(points).toContain(
      "BUYER_PAYMENT_NETWORK_RIGHTS_ARE_NOT_LIMITED_BY_THIS_POLICY_OR_SELLER_TERMS",
    );
    expect(points).toContain(
      "THE_POLICY_NEVER_DIRECTS_A_BUYER_TO_DISPUTE_INSTEAD_OF_REQUESTING_A_REFUND",
    );
  });

  it("records the rulings it does not take, rather than taking them", () => {
    expect(REQUIRED_MARKETPLACE_POLICY_DISPUTE_VERSION.requiringARuling.length).toBeGreaterThan(0);
    expect(REQUIRED_MARKETPLACE_POLICY_DISPUTE_VERSION.rulingOwner).toBe(
      "MONACADO_MOR_BUSINESS_MODEL_SECTION_I",
    );
  });

  it("adds no dispute language to the buyer's receipt", () => {
    /* The receipt's job is making the REFUND path followable. Explaining how to
       reverse a payment through a bank on the same artifact would conflate the
       two exactly where conflation costs most. */
    expect(DISPUTE_LANGUAGE_ON_RECEIPT).toBe("NOT_INCLUDED");
    const receipt = readSource("src/contracts/marketplace/order-receipt.ts");
    expect(receipt).not.toContain("disputeId");
    expect(receipt).not.toContain("disputeStatus");
  });

  it("leaves Marketplace Policy 1.1.0's bytes untouched", () => {
    /* Asserted against 1.1.0's own content hash and its own section list rather
       than by scanning the file for a substring.
       
       The substring form was a proxy for this claim and stopped being true for a
       benign reason the moment 1.12 shipped a SECOND document in the same module.
       The hash is what the claim actually rests on: it is pinned wherever 1.1.0
       has been recorded, and a single character moving in its prose would change
       it and make every later bootstrap of that version refuse. This is strictly
       stronger than the scan it replaces. */
    expect(MONACADO_MARKETPLACE_POLICY_V1_1_HASH).toBe(
      "sha256:b0a48644c8c146e2247d20de20140f6e124435401cad1ce096140ca5128e74b6",
    );
    for (const key of [
      "DISPUTES_AND_CHARGEBACKS",
      "DISPUTE_EVIDENCE_AND_COOPERATION",
      "DISPUTE_EFFECT_ON_PROCEEDS",
    ] as const) {
      expect(selectSection(MONACADO_MARKETPLACE_POLICY_V1_1, key)).toBeNull();
    }
  });
});

describe("1.11 — deadlines and thresholds are stated once", () => {
  it("expresses how urgent is urgent in one place", () => {
    expect(DISPUTE_OPERATIONS_POLICY.deadlineCriticalSeconds).toBeLessThan(
      DISPUTE_OPERATIONS_POLICY.deadlineWarningSeconds,
    );
    expect(DISPUTE_OPERATIONS_POLICY.deadlineCriticalSeconds).toBeGreaterThan(0);
  });
});

describe("1.11 — no live provider or network call is reachable from this phase", () => {
  it("routes every Stripe access through the single TEST-only credential gate", () => {
    const adapter = readSource("src/server/payments/stripe-dispute-adapter.ts");
    expect(adapter).toContain("getStripeRuntime");
    expect(adapter).not.toContain("sk_live");
    expect(adapter).not.toContain("new Stripe(");
  });

  it("makes no outbound provider request from any dispute service", () => {
    for (const file of [
      "src/server/marketplace/transaction-dispute-service.ts",
      "src/server/marketplace/dispute-operations-service.ts",
      "src/server/marketplace/dispute-reconciliation-service.ts",
      "src/server/marketplace/dispute-evidence-metadata-service.ts",
    ]) {
      const source = readSource(file);
      expect(source, file).not.toContain("fetch(");
      expect(source, file).not.toContain("https://");
    }
  });
});
