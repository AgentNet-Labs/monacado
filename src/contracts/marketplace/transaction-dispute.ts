/**
 * Payment disputes and chargebacks (Phase 1.11).
 *
 * ## A dispute is not a refund
 *
 * A refund is Monacado returning funds because somebody decided to. A dispute is
 * a buyer's **bank** reversing a payment because the cardholder asked it to. They
 * are raised by different parties, decided by different parties, arrive by
 * different routes, and can both happen to the same sale.
 *
 * Phase 1.2 already reserved the vocabulary for the distinction — `REVERSAL_KINDS`
 * has carried `CHARGEBACK` and `REVERSAL_REASON_CODES` has carried
 * `DISPUTED_BY_BUYER` since it was written, with the note *"the buyer's bank
 * reversed it. Pairs with `CHARGEBACK`."* This phase is what makes those members
 * reachable. **No accounting enum is widened here**, because 1.2 sized them for
 * this and getting to use a reserved member is the point of having reserved it.
 *
 * ## Two axes, not one
 *
 * The single most consequential shape decision in this file: **adjudication and
 * funds movement are separate columns.**
 *
 * ```
 * status      — where the dispute has got to with the network
 * fundsState  — whether the money has actually left, and come back
 * ```
 *
 * They genuinely move independently. A dispute can close `won` having never
 * withdrawn a penny. Funds can be withdrawn while the dispute is still under
 * review. Collapsing them into one lifecycle column makes *"has Monacado lost
 * this money"* unanswerable without reading the event history — which is exactly
 * the question a chargeback exists to answer.
 *
 * This is the same split Phase 1.7 made between `OrderTaxTransaction`'s
 * `lifecycleState` (what happened to the tax) and `recordingStatus` (how far the
 * provider call got), and for the same reason.
 *
 * ## What is deliberately absent
 *
 * **No provider text of any kind.** Not the network reason code, not the issuer's
 * message, not the dispute narrative. `stripe-failure-mapping` already forbids
 * persisting an issuer reason; a dispute reason is the same kind of value, and
 * `NEVER_ON_TRANSACTION_REVERSAL` already names `disputeNarrative` specifically.
 *
 * **No evidence, and no buyer.** Stripe's dispute evidence object carries the
 * cardholder's email, name, purchase IP, and billing and shipping addresses.
 * None of it is stored. `OrderBuyerSnapshot` is the one place buyer identity
 * lives, and `NEVER_ON_ORDER_REFUND` already forbids copying it outward.
 *
 * **No partial reversal.** `REVERSAL_SCOPES` has one member, and
 * `recordFullReversalInTx` takes no amount — every figure is derived from the
 * snapshot. Stripe permits a dispute for less than the charge. Such a dispute is
 * **refused into `MANUAL_REMEDIATION_REQUIRED` and writes no accounting entry**,
 * because rounding one up to a full reversal would misstate what three parties
 * owe each other, and the allocation rule that would make it expressible belongs
 * to `MONACADO_MOR_BUSINESS_MODEL` §I.
 */

import { z } from "zod";
import {
  TRANSACTION_DISPUTE_EVENT_ID_RE,
  TRANSACTION_DISPUTE_ID_RE,
} from "./identity";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";

export const TransactionDisputeId = z.string().regex(TRANSACTION_DISPUTE_ID_RE);
export type TransactionDisputeId = z.infer<typeof TransactionDisputeId>;

export const TransactionDisputeEventId = z.string().regex(TRANSACTION_DISPUTE_EVENT_ID_RE);
export type TransactionDisputeEventId = z.infer<typeof TransactionDisputeEventId>;

const Amount = z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT);

// — Adjudication status —

/**
 * Where the dispute has got to with the card network.
 *
 * A **bounded Monacado vocabulary**. The provider's own status strings never
 * escape the adapter — the rule `stripe-webhook-route-handler` states as "no
 * Stripe type crosses into the service layer".
 */
export const DISPUTE_STATUSES = [
  /**
   * Recorded, and the network has not yet asked for anything.
   *
   * Reachable from an early-warning notice, which is a real provider state that
   * is not yet a demand for evidence.
   */
  "OPEN",
  /** The network is waiting for evidence, and a deadline may be running. */
  "NEEDS_RESPONSE",
  /** Evidence is in, or the network is deciding. Nothing is owed right now. */
  "UNDER_REVIEW",
  /** Decided in the sale's favour. Terminal. */
  "WON",
  /** Decided against the sale. Terminal. */
  "LOST",
  /**
   * Closed with no liability — withdrawn by the cardholder, or prevented before
   * it became a dispute. Terminal, and NOT the same as `WON`: nobody adjudicated.
   */
  "CLOSED",
  /**
   * Monacado cannot proceed automatically and a human must look.
   *
   * Never a mapping target for a status the provider stated clearly. It is the
   * honest sink for four situations: a provider status this build does not
   * recognise, a partial disputed amount, a dispute that cannot be attributed to
   * a sale, and a live-mode dispute arriving at a TEST deployment.
   *
   * This is the posture `stripe-failure-mapping` takes for an unrecognised
   * member — "degrade to an honest absence of classification rather than be
   * forced into the nearest-looking bucket".
   */
  "MANUAL_REMEDIATION_REQUIRED",
] as const;
export const DisputeStatus = z.enum(DISPUTE_STATUSES);
export type DisputeStatus = z.infer<typeof DisputeStatus>;

/** The statuses from which the network may still ask for something. */
export const NON_TERMINAL_DISPUTE_STATUSES: readonly DisputeStatus[] = Object.freeze([
  "OPEN",
  "NEEDS_RESPONSE",
  "UNDER_REVIEW",
  "MANUAL_REMEDIATION_REQUIRED",
]);

/**
 * Whether this dispute still hangs over the sale.
 *
 * **Derived, never stored.** A stored `open` column beside `status` would be a
 * second answer able to disagree with the first — the same reasoning that keeps
 * the net economic position derived rather than columnised.
 */
export function isDisputeOpen(status: DisputeStatus): boolean {
  return NON_TERMINAL_DISPUTE_STATUSES.includes(status);
}

/**
 * Forward-only out of a decided outcome.
 *
 * `WON`, `LOST`, and `CLOSED` are terminal for adjudication. A late or replayed
 * `updated` event carrying `needs_response` after a loss is ingested into the
 * event ledger and applies nothing — otherwise a duplicate provider delivery
 * could roll a decided dispute back to an open one.
 */
export const DISPUTE_STATUS_TRANSITIONS: Record<DisputeStatus, readonly DisputeStatus[]> =
  Object.freeze({
    OPEN: ["NEEDS_RESPONSE", "UNDER_REVIEW", "WON", "LOST", "CLOSED", "MANUAL_REMEDIATION_REQUIRED"],
    NEEDS_RESPONSE: ["UNDER_REVIEW", "WON", "LOST", "CLOSED", "MANUAL_REMEDIATION_REQUIRED"],
    UNDER_REVIEW: ["NEEDS_RESPONSE", "WON", "LOST", "CLOSED", "MANUAL_REMEDIATION_REQUIRED"],
    WON: [],
    LOST: [],
    CLOSED: [],
    /* Absorbing for automation, but a human may record any outcome once they
       have looked. It is not terminal, because the situation it names is one
       somebody is expected to resolve. */
    MANUAL_REMEDIATION_REQUIRED: ["WON", "LOST", "CLOSED"],
  });

export function isValidDisputeStatusTransition(from: DisputeStatus, to: DisputeStatus): boolean {
  if (from === to) return true;
  return DISPUTE_STATUS_TRANSITIONS[from].includes(to);
}

// — Funds movement —

/**
 * Whether the money has actually left.
 *
 * Driven **only** by funds events, never by adjudication status. See the header:
 * the whole point of the second axis is that a closure moves no money and a
 * withdrawal is not a verdict.
 */
export const DISPUTE_FUNDS_STATES = [
  /** Nothing has been taken. */
  "NOT_WITHDRAWN",
  /** The provider has debited the disputed amount. */
  "WITHDRAWN",
  /** The provider returned it after taking it. */
  "REINSTATED",
] as const;
export const DisputeFundsState = z.enum(DISPUTE_FUNDS_STATES);
export type DisputeFundsState = z.infer<typeof DisputeFundsState>;

// — Reason —

/**
 * Why the cardholder's bank says the payment is disputed, as a closed Monacado
 * vocabulary.
 *
 * Stripe types `Dispute.reason` as an open `string`. Mapping it into a bounded
 * set is the same rule `REVERSAL_REASON_CODES` follows — *"no provider text,
 * dispute narrative, or free-text note"*.
 */
export const DISPUTE_REASON_CODES = [
  "FRAUDULENT",
  "PRODUCT_NOT_RECEIVED",
  "PRODUCT_UNACCEPTABLE",
  "DUPLICATE",
  "CREDIT_NOT_PROCESSED",
  "SUBSCRIPTION_CANCELED",
  "UNRECOGNIZED",
  "GENERAL",
  /** The provider stated something this build does not classify. */
  "UNSPECIFIED",
] as const;
export const DisputeReasonCode = z.enum(DISPUTE_REASON_CODES);
export type DisputeReasonCode = z.infer<typeof DisputeReasonCode>;

// — Economic effect —

/**
 * What this dispute did to Monacado's own economics.
 *
 * The field that makes double reversal answerable rather than inferable. A sale
 * whose funds were already returned by a refund, and which is then charged back,
 * has a real double-payment exposure in the world — but exactly **one** Monacado
 * reversal entry, because `TransactionReversal.snapshotId` is UNIQUE. Recording
 * which of those happened is what stops a later reader concluding the second
 * reversal was simply missed.
 */
export const DISPUTE_ECONOMIC_EFFECTS = [
  /** No reversal entry, and none owed: the dispute is open, won, or closed. */
  "NONE",
  /** This dispute produced the sale's `CHARGEBACK` reversal entry. */
  "REVERSED_BY_THIS_DISPUTE",
  /**
   * The sale was already reversed by a refund before this dispute resolved.
   *
   * **The buyer has been made whole twice in the real world.** That is a
   * provider-level operational fact requiring recovery from the card network or
   * the buyer, NOT a second Monacado economic reversal — writing one would
   * double-count the loss in Monacado's own books.
   */
  "ALREADY_REVERSED_BY_REFUND",
  /** A reversal is owed but could not be expressed. See `remediationCode`. */
  "NOT_EXPRESSIBLE",
] as const;
export const DisputeEconomicEffect = z.enum(DISPUTE_ECONOMIC_EFFECTS);
export type DisputeEconomicEffect = z.infer<typeof DisputeEconomicEffect>;

// — Tax consequence —

/**
 * What Monacado concluded about the tax on a disputed sale.
 *
 * **This is a recorded decision, not a tax action.** It performs no calculation
 * and commits no reversal.
 *
 * `OrderTaxReversal.refundId` is `NOT NULL` and `@unique` with a `RESTRICT` FK to
 * `OrderRefund`, at the schema, the contract, and the verification gate
 * (`verifyReversibleTaxReversal` refuses anything whose refund is not
 * `REFUNDED`). A dispute has no refund row. **A dispute-caused tax correction is
 * therefore not expressible in the committed architecture**, and the honest move
 * is to say so in a column and surface it, rather than fabricate an `OrderRefund`
 * to hang a reversal from or approximate a correction nobody designed.
 *
 * The provider capability is not the gap — Stripe Tax's `createReversal` is the
 * same call for either cause. The gap is entirely Monacado-side, and it belongs
 * to the phase that owns tax correction, not to a dispute intake phase.
 */
export const DISPUTE_TAX_CONSEQUENCES = [
  /** Not yet assessed — the dispute is not resolved. */
  "NOT_ASSESSED",
  /** No tax transaction was ever recorded for this sale, so nothing to correct. */
  "NO_TAX_TRANSACTION",
  /** The refund that already reversed this sale also reversed its tax. */
  "ALREADY_REVERSED_BY_REFUND",
  /** The dispute was won or closed. The sale stands and its tax stands with it. */
  "NO_ACTION_REQUIRED",
  /**
   * A correction is owed and **cannot be expressed**. Fails closed: surfaced by
   * reconciliation and by readiness, never approximated.
   */
  "REVERSAL_REQUIRED_NOT_EXPRESSIBLE",
] as const;
export const DisputeTaxConsequence = z.enum(DISPUTE_TAX_CONSEQUENCES);
export type DisputeTaxConsequence = z.infer<typeof DisputeTaxConsequence>;

/** The tax consequences that need a human. */
export const DISPUTE_TAX_CONSEQUENCES_NEEDING_OPERATOR: readonly DisputeTaxConsequence[] =
  Object.freeze(["REVERSAL_REQUIRED_NOT_EXPRESSIBLE"]);

// — Remediation —

/**
 * Why a dispute needs a human, from a closed vocabulary.
 *
 * Each member is a situation Monacado can detect but must not resolve
 * automatically. No provider text, no free-form note.
 */
export const DISPUTE_REMEDIATION_CODES = [
  /**
   * The disputed amount is less than the sale total.
   *
   * `REVERSAL_SCOPES` has one member and `recordFullReversalInTx` derives every
   * figure from the snapshot, so a partial chargeback has no expressible entry.
   */
  "PARTIAL_AMOUNT_NOT_EXPRESSIBLE",
  /** No settlement carries this dispute's payment reference. */
  "UNATTRIBUTABLE",
  /** The sale was already reversed, so no second entry can be written. */
  "SALE_ALREADY_REVERSED",
  /** The provider stated a status this build does not classify. */
  "UNRECOGNISED_PROVIDER_STATUS",
  /** A live-mode dispute arrived at a TEST-mode deployment. */
  "LIVEMODE_IN_TEST_DEPLOYMENT",
  /** A tax correction is owed and is not expressible. */
  "TAX_CORRECTION_NOT_EXPRESSIBLE",
  /** The disputed currency is not the sale's currency. */
  "CURRENCY_MISMATCH",
] as const;
export const DisputeRemediationCode = z.enum(DISPUTE_REMEDIATION_CODES);
export type DisputeRemediationCode = z.infer<typeof DisputeRemediationCode>;

// — Provider event kinds —

/**
 * The provider events this phase understands, as a bounded vocabulary.
 *
 * Five, and no more. `CLOSED` is kept separate from `FUNDS_WITHDRAWN` because
 * closure is an adjudication fact and withdrawal is a money fact — see the
 * header's two-axis note.
 */
export const DISPUTE_EVENT_KINDS = [
  "OPENED",
  "UPDATED",
  "CLOSED",
  "FUNDS_WITHDRAWN",
  "FUNDS_REINSTATED",
] as const;
export const DisputeEventKind = z.enum(DISPUTE_EVENT_KINDS);
export type DisputeEventKind = z.infer<typeof DisputeEventKind>;

// — The observation an adapter produces —

/**
 * What a provider adapter hands the service layer.
 *
 * **Already normalised.** No Stripe type, no provider status string, no raw
 * payload. The service that consumes this cannot tell which provider produced
 * it, which is the property that makes the dispute model provider-neutral.
 */
export const DisputeObservation = z.strictObject({
  provider: z.literal("STRIPE"),
  providerMode: z.literal("TEST"),
  providerDisputeRef: z.string().min(1).max(191),
  providerEventId: z.string().min(1).max(191),
  providerTransactionRef: z.string().min(1).max(191),
  providerChargeRef: z.string().min(1).max(191).nullable(),

  eventKind: DisputeEventKind,

  disputedAmountMinorUnits: Amount,
  currency: CurrencyCode,
  reasonCode: DisputeReasonCode,
  status: DisputeStatus,

  /** Present only on the events that state it. */
  evidenceDueBy: z.iso.datetime().nullable(),
  responsePermitted: z.boolean(),
  evidenceStagedAtProvider: z.boolean(),
  evidenceSubmissionCount: z.int().min(0),
  evidenceSubmittedPastDue: z.boolean(),
  chargeStillRefundable: z.boolean(),

  /** The provider's own instants. */
  openedAt: z.iso.datetime(),
  occurredAt: z.iso.datetime(),

  /**
   * Set when the provider's own object says it is live.
   *
   * Carried rather than filtered in the adapter so the refusal is a recorded
   * decision in the service, with a `remediationCode`, instead of a silently
   * dropped event.
   */
  providerReportedLivemode: z.boolean(),
});
export type DisputeObservation = z.infer<typeof DisputeObservation>;

// — The records —

export const TransactionDisputeRecord = z.strictObject({
  disputeId: TransactionDisputeId,

  /** NULL when the dispute could not be attributed to a sale. */
  orderId: z.string().min(1).max(191).nullable(),
  snapshotId: z.string().min(1).max(191).nullable(),

  provider: z.literal("STRIPE"),
  providerMode: z.literal("TEST"),
  providerDisputeRef: z.string().min(1).max(191),
  providerTransactionRef: z.string().min(1).max(191),
  providerChargeRef: z.string().min(1).max(191).nullable(),

  disputedAmountMinorUnits: Amount,
  currency: CurrencyCode,
  reasonCode: DisputeReasonCode,

  status: DisputeStatus,
  fundsState: DisputeFundsState,
  taxConsequence: DisputeTaxConsequence,
  economicEffect: DisputeEconomicEffect,

  evidenceDueBy: z.iso.datetime().nullable(),
  responsePermitted: z.boolean(),
  evidenceStagedAtProvider: z.boolean(),
  evidenceSubmissionCount: z.int().min(0),
  evidenceSubmittedPastDue: z.boolean(),
  chargeStillRefundable: z.boolean(),

  remediationCode: DisputeRemediationCode.nullable(),

  lastProviderEventAt: z.iso.datetime(),
  openedAt: z.iso.datetime(),
  fundsWithdrawnAt: z.iso.datetime().nullable(),
  fundsReinstatedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  recordedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),

  /** The `CHARGEBACK` entry this dispute produced, if it produced one. */
  reversalId: z.string().min(1).max(191).nullable(),
});
export type TransactionDisputeRecord = z.infer<typeof TransactionDisputeRecord>;

export const TransactionDisputeEventRecord = z.strictObject({
  eventId: TransactionDisputeEventId,
  disputeId: TransactionDisputeId,
  provider: z.literal("STRIPE"),
  providerEventId: z.string().min(1).max(191),
  eventKind: DisputeEventKind,
  /** FALSE for a stale or out-of-order delivery that changed nothing. */
  applied: z.boolean(),
  occurredAt: z.iso.datetime(),
  receivedAt: z.iso.datetime(),
});
export type TransactionDisputeEventRecord = z.infer<typeof TransactionDisputeEventRecord>;

/**
 * Named as never admissible on a dispute record.
 *
 * The buyer fields are on this list because Stripe's evidence object hands them
 * over on every dispute event — they are the columns that would appear the day
 * somebody implemented representment without designing the disclosure. The
 * provider-text fields are on it for the reason `NEVER_ON_TRANSACTION_REVERSAL`
 * names `disputeNarrative`: a free-text column becomes a place people put
 * whatever the provider said, including who the buyer is.
 */
export const NEVER_ON_TRANSACTION_DISPUTE = [
  // buyer identity — OrderBuyerSnapshot is the one place this lives
  "buyerName",
  "buyerEmail",
  "buyerAddress",
  "billingAddress",
  "shippingAddress",
  "customerPurchaseIp",
  // instrument detail
  "cardLast4",
  "cardBrand",
  "cardNetwork",
  "paymentMethodDetails",
  // provider text
  "networkReasonCode",
  "providerStatusString",
  "providerMessage",
  "disputeNarrative",
  "uncategorizedText",
  // evidence itself
  "evidenceDocument",
  "evidenceFileId",
  "representmentEvidence",
  "accessActivityLog",
  "shippingTrackingNumber",
  // raw provider payload
  "rawEvent",
  "providerPayload",
  "eventBody",
  // free text
  "note",
  "operatorComment",
] as const;

// — The evidence-submission seam —

/**
 * The boundary across which Monacado would submit dispute evidence to a
 * provider. **Declared, with no adapter, on purpose.**
 *
 * This is precisely what Phase 1.2 did with `RefundExecutionPort`: named the
 * boundary, shipped no implementation, and said why. Phase 1.9 then built the
 * adapter behind the unchanged port.
 *
 * ### Why 1.11 does not build it
 *
 * 1. **The evidence that wins a card-not-present dispute is files.** Every
 *    field that matters — receipt, customer communication, refund policy,
 *    service documentation, shipping documentation — is typed `string | File`
 *    and needs a provider file upload. There is no blob store, no upload
 *    endpoint, no document model, and no retention policy anywhere in this
 *    repository.
 * 2. **The text-only alternative is buyer PII.** The fields submittable without
 *    a file are the cardholder's email, name, purchase IP, and addresses.
 *    Sending those to a provider is an outbound disclosure decision, not an
 *    implementation detail — `NotificationDelivery` does not even store an
 *    address, only a digest.
 * 3. **Submission is one-shot and effectively irreversible.** Evidence may
 *    typically be submitted once, and closing a dispute is an immediate,
 *    irreversible acceptance of loss. Building an automated path to either in
 *    the same phase as the intake feeding it means a bug loses money with no
 *    undo.
 * 4. **The governing document reserves the policy.** `MONACADO_MOR_BUSINESS_MODEL`
 *    §I assigns "chargeback representment evidence" to `0M.T` and says plainly
 *    *"That policy is not designed here."* Submitting evidence would be
 *    designing representment policy inside an implementation phase.
 *
 * The operational cost of deferring is one manual step in the provider's own
 * dashboard, and `dispute:status` tells the operator exactly which evidence
 * Monacado holds and where.
 */
export const DisputeEvidenceSubmissionRequest = z.strictObject({
  disputeId: TransactionDisputeId,
  providerDisputeRef: z.string().min(1).max(191),
});
export type DisputeEvidenceSubmissionRequest = z.infer<typeof DisputeEvidenceSubmissionRequest>;

export interface DisputeEvidenceSubmissionPort {
  submit(request: DisputeEvidenceSubmissionRequest): Promise<never>;
}

/**
 * What a later operational phase owes, stated as data a test can read.
 *
 * Modelled on `REFUND_PROVIDER_AUDIT_SEAM` and `RECOVERY_EXECUTION_DEFERRAL`:
 * the absence is a value, not a silence.
 */
export const DISPUTE_EVIDENCE_SUBMISSION_SEAM = {
  /** Nothing in this repository submits evidence to a provider. */
  evidenceSubmission: "NOT_IMPLEMENTED",
  /** Nothing accepts, stores, or serves a dispute evidence document. */
  documentStorage: "NOT_IMPLEMENTED",
  /** Nothing closes (accepts) a dispute through the provider. */
  disputeAcceptance: "NOT_IMPLEMENTED",
  /** Nothing calls the provider to re-read dispute state. */
  providerLookup: "NOT_IMPLEMENTED",
  /** Routine reconciliation answers from local records alone. */
  routineReconciliation: "LOCAL_RECORDS_ONLY",
  /** Where an operator responds to a dispute today. */
  operatorResponsePath: "PROVIDER_DASHBOARD",
  /** Whose phase it is. */
  owner: "T2_SETTLEMENT_AND_PAYOUT",
  /** The ruling that must precede it. */
  requiresRuling: "MONACADO_MOR_BUSINESS_MODEL_SECTION_I",
  /** What 1.11 guarantees instead. */
  guaranteedNow: [
    "A_PROVIDER_DISPUTE_IS_DURABLY_RECORDED_BEFORE_ANY_DEADLINE_RUNS",
    "AN_OPEN_DISPUTE_HOLDS_UNPAID_SELLER_AND_PROMOTER_PROCEEDS",
    "ALREADY_PAID_ECONOMICS_RAISE_RECOVERY_EVIDENCE_RATHER_THAN_BEING_REWRITTEN",
    "A_LOST_DISPUTE_RECORDS_A_CHARGEBACK_REVERSAL_WITHOUT_TOUCHING_THE_SNAPSHOT",
    "THE_RESPONSE_DEADLINE_IS_VISIBLE_TO_AN_OPERATOR_BEFORE_IT_PASSES",
  ],
} as const;

/**
 * Deferrals this phase records rather than resolves.
 */
export const DISPUTE_EXECUTION_DEFERRAL = {
  /** Nothing recovers money from a seller or promoter. Unchanged from 1.9. */
  clawbackExecution: "NOT_IMPLEMENTED",
  /** A partial chargeback has no expressible accounting entry. */
  partialDisputeAccounting: "NOT_IMPLEMENTED",
  /** A dispute-caused tax correction has no expressible record. */
  disputeCausedTaxReversal: "NOT_IMPLEMENTED",
  /** Pre-dispute fraud warnings are a different fact with a different model. */
  earlyFraudWarningIngestion: "NOT_IMPLEMENTED",
  /** The network's dispute fee has no Monacado cost ledger to land in. */
  disputeFeeAccounting: "NOT_IMPLEMENTED",
  /** No worker sweeps deadlines; the deadline is data, surfaced on read. */
  deadlineSweepWorker: "NOT_IMPLEMENTED",
  owner: "T2_SETTLEMENT_AND_PAYOUT",
} as const;

/**
 * The Marketplace Policy work this phase creates and does **not** perform.
 *
 * Recorded, not applied — exactly the posture `REQUIRED_MARKETPLACE_POLICY_NEXT_VERSION`
 * took in Phase 1.9, which Phase 1.10 then discharged.
 *
 * The decisive gap is narrow and concrete: Marketplace Policy 1.1.0's
 * `PROMOTER_RESPONSIBILITIES` and `REFUND_EFFECT_ON_PROCEEDS` are written
 * entirely in terms of merchandise being **"refunded"**. This repository draws a
 * deliberate distinction between a refund and a chargeback. **On its own words,
 * the governing text therefore does not reverse a promoter's commission on a
 * charged-back sale**, and it states no evidence-cooperation duty and no right to
 * hold proceeds while a dispute is open.
 *
 * 1.1.0 is NOT edited to fix that. A version is a document, not a diff; it is
 * already recorded and hashed wherever the 1.10 suite has run, and moving its
 * bytes would make every later bootstrap of it refuse with a content-hash
 * mismatch.
 */
export const REQUIRED_MARKETPLACE_POLICY_DISPUTE_VERSION = {
  reason: "PHASE_1_11_INTRODUCED_DISPUTE_AND_CHARGEBACK_GOVERNANCE",
  /** A standing version is never edited. */
  mutateActiveVersion: "REFUSED",
  /** Nor is a recorded draft, which is already hashed. */
  mutateRecordedDraftVersion: "REFUSED",
  sectionsRequiringNewText: [
    "DISPUTES_AND_CHARGEBACKS",
    "DISPUTE_EVIDENCE_AND_COOPERATION",
    "DISPUTE_EFFECT_ON_PROCEEDS",
    "MONACADO_ROLE",
    "SELLER_RESPONSIBILITIES",
    "PROMOTER_RESPONSIBILITIES",
  ],
  pointsToState: [
    "MONACADO_IS_THE_ONLY_PARTY_TO_THE_PAYMENT_DISPUTE",
    "A_SELLER_OR_PROMOTER_IS_NOT_A_PARTY_AND_CANNOT_ADDRESS_THE_NETWORK",
    "BUYER_PAYMENT_NETWORK_RIGHTS_ARE_NOT_LIMITED_BY_THIS_POLICY_OR_SELLER_TERMS",
    "THE_POLICY_NEVER_DIRECTS_A_BUYER_TO_DISPUTE_INSTEAD_OF_REQUESTING_A_REFUND",
    "SELLER_OWES_FULFILMENT_EVIDENCE_TO_MONACADO_WITHIN_A_STATED_PERIOD",
    "EVIDENCE_IS_SUPPLIED_TO_MONACADO_NEVER_DIRECTLY_TO_A_NETWORK",
    "PROCEEDS_ATTRIBUTABLE_TO_A_DISPUTED_SALE_MAY_BE_HELD_WHILE_IT_IS_OPEN",
    "UNPAID_AMOUNTS_CEASE_TO_BE_PAYABLE_AND_PAID_AMOUNTS_MAY_BE_RECOVERED_OR_OFFSET",
    "PROMOTER_COMMISSION_IS_CONDITIONAL_HOWEVER_THE_SALE_IS_UNDONE",
    "MONACADO_MAY_ACT_ON_FRAUD_OR_RISK_GROUNDS_WITHOUT_THE_SELLERS_AGREEMENT",
    "RISK_CLASSIFICATIONS_ARE_PRIVATE_AND_ARE_NEVER_DISCLOSED_OR_PUBLISHED",
    "CONTESTING_OR_ACCEPTING_A_DISPUTE_IS_NOT_A_WAIVER_OF_RECOVERY",
  ],
  requiringARuling: [
    "PASS_THROUGH_OF_NETWORK_IMPOSED_DISPUTE_COSTS_TO_A_SELLER",
    "WHETHER_1_1_0_IS_ACTIVATED_BEFORE_A_DISPUTE_VERSION_IS_PUBLISHED",
  ],
  rulingOwner: "MONACADO_MOR_BUSINESS_MODEL_SECTION_I",
  requiresReacceptanceDecision: "OWNER_OF_MARKETPLACE_TERMS",
} as const;

/**
 * Dispute language is **not** added to the buyer's receipt.
 *
 * Recorded as data for the same reason `PROMOTER_ON_BUYER_RECEIPT` is: a
 * deliberate exclusion that reads as an oversight unless it is stated.
 *
 * A receipt records the purchase *as it was made*, and a dispute is a later
 * event with no existence at receipt time. More pointedly, the receipt's job is
 * to make the **refund** path followable; a receipt that also explained
 * reversing the payment through the buyer's bank would raise the chargeback rate
 * on a marketplace whose own modules treat that as the slower, dearer,
 * externally-adjudicated path.
 */
export const DISPUTE_LANGUAGE_ON_RECEIPT = "NOT_INCLUDED" as const;
