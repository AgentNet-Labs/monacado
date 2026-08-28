/**
 * Dispute evidence response (Phase 1.12).
 *
 * What Monacado assembles to answer a payment dispute, who approved sending it,
 * and what actually went to the provider.
 *
 * ## What 1.11 decided, and what this narrows
 *
 * `dispute-evidence-metadata-service` deliberately stored nothing, reasoning
 * that copying an authoritative record into an evidence table would create a
 * second answer able to disagree with the record it describes. **That reasoning
 * is kept.** Nothing here copies a receipt, a policy, a price, or a buyer
 * detail: a record-backed item is a bounded pointer plus the instant the source
 * was observed, and the pointer is followed at render time.
 *
 * It is narrowed for exactly two facts that have **no authoritative home**:
 *
 *   1. **A seller's factual attestation.** A representment frequently turns on
 *      something no Monacado record contains — that the goods were sent, or the
 *      buyer was answered off-platform. Nobody has asserted it, so there is
 *      nothing to point at.
 *   2. **What Monacado did.** `TransactionDispute.evidenceSubmissionCount` is the
 *      *provider's* assertion, read back from a webhook and overwritten on every
 *      delivery. That Monacado assembled a response and sent it is Monacado's own
 *      conduct, and it was unrecorded. Losing a dispute with no record of whether
 *      anyone answered it is the failure this phase exists to prevent.
 *
 * The two are kept in separate tables from the provider's posture columns
 * precisely so they can **disagree**. A divergence is a finding, not a bug.
 *
 * ## The attestation is a closed vocabulary, never prose
 *
 * `NEVER_ON_TRANSACTION_DISPUTE` forbids `note`, `operatorComment`, and
 * `uncategorizedText` because a free-text column attached to a dispute is where
 * somebody eventually writes down what they think of the cardholder. A seller
 * still has to be able to say "I shipped it", so this phase gives them a
 * **checklist of bounded claims** rather than a text box. Each answer is a
 * vocabulary member, an instant, and the participant who asserted it: storable
 * under this repository's existing rules, and structurally unable to become a
 * mail archive.
 */

import { z } from "zod";
import { DisputeEvidenceCode } from "./dispute-operations";

// — Provenance —

/**
 * Where an item's content comes from, and therefore who is answerable for it.
 *
 * `MONACADO_DERIVATION` is separate from `MONACADO_RECORD` deliberately. A
 * derived item — "the sale-time product version pinned by the tax transaction" —
 * is a **claim about** records rather than a citation of one, and an operator
 * about to send it to a bank should be able to see which it is.
 */
export const DISPUTE_EVIDENCE_SOURCE_KINDS = [
  "MONACADO_RECORD",
  "MONACADO_DERIVATION",
  "SELLER_ATTESTATION",
] as const;
export const DisputeEvidenceSourceKind = z.enum(DISPUTE_EVIDENCE_SOURCE_KINDS);
export type DisputeEvidenceSourceKind = z.infer<typeof DisputeEvidenceSourceKind>;

/** Who asserted an item. A record-backed item is `SYSTEM`; an attestation never is. */
export const DISPUTE_EVIDENCE_ASSERTED_BY_KINDS = ["SYSTEM", "SELLER", "OPERATOR"] as const;
export const DisputeEvidenceAssertedByKind = z.enum(DISPUTE_EVIDENCE_ASSERTED_BY_KINDS);
export type DisputeEvidenceAssertedByKind = z.infer<typeof DisputeEvidenceAssertedByKind>;

/**
 * What a seller may attest to, in full.
 *
 * A closed list, and short on purpose. Every member is a fact about the seller's
 * own conduct that Monacado cannot observe. None of them names a buyer, an
 * address, or an amount, so no member can carry buyer identity into the record.
 *
 * `DELIVERY_EVIDENCE_HELD_OUTSIDE_MONACADO` is the one that earns its place: it
 * converts `SHIPPING_DOCUMENTATION` from *"never available"* into *"not held by
 * Monacado, attested as held by the seller, to be supplied out of band"* — which
 * an operator can act on — without a document store and without the seller
 * typing a tracking number into a system that has nowhere to put one.
 */
export const SELLER_ATTESTATION_CLAIMS = [
  "GOODS_OR_SERVICE_SUPPLIED",
  "SUPPLIED_AS_DESCRIBED",
  "BUYER_CONTACTED_BEFORE_DISPUTE",
  "REFUND_ALREADY_OFFERED",
  "DELIVERY_EVIDENCE_HELD_OUTSIDE_MONACADO",
  "NO_INFORMATION_HELD",
] as const;
export const SellerAttestationClaim = z.enum(SELLER_ATTESTATION_CLAIMS);
export type SellerAttestationClaim = z.infer<typeof SellerAttestationClaim>;

// — Validation —

export const DISPUTE_EVIDENCE_VALIDATION_STATES = [
  "UNVALIDATED",
  "VALIDATED",
  "REJECTED",
  /**
   * The cited record could not be read. Separate from `REJECTED` on purpose: a
   * policy version this deployment no longer ships is not a false claim, and
   * telling an operator "rejected" would send them looking for a lie.
   */
  "SOURCE_UNREADABLE",
] as const;
export const DisputeEvidenceValidationState = z.enum(DISPUTE_EVIDENCE_VALIDATION_STATES);
export type DisputeEvidenceValidationState = z.infer<typeof DisputeEvidenceValidationState>;

// — Preparation lifecycle —

/**
 * The governed path from "we assembled something" to "it left the building".
 *
 * Five states, not four. `PREPARED → APPROVED → SUBMITTED` is the happy path;
 * the two extra terminals are the ones that cost money if absent.
 *
 * `SUPERSEDED` exists because a provider event arriving between approval and
 * submission invalidates the approval. An approval is authorisation to send
 * *this* package against *that* observation, and without this state an ageing
 * approval silently becomes authorisation to send something nobody reviewed.
 *
 * `SUBMISSION_REFUSED` exists because submission is one-shot: a refusal for a
 * passed deadline or an already-submitted dispute is terminal, and a retry
 * button that does nothing is worse than no button.
 */
export const DISPUTE_EVIDENCE_PREPARATION_STATUSES = [
  "PREPARED",
  "APPROVED",
  "SUBMITTED",
  "SUPERSEDED",
  "SUBMISSION_REFUSED",
] as const;
export const DisputeEvidencePreparationStatus = z.enum(DISPUTE_EVIDENCE_PREPARATION_STATUSES);
export type DisputeEvidencePreparationStatus = z.infer<typeof DisputeEvidencePreparationStatus>;

/** Forward-only, with three terminals. */
export const DISPUTE_EVIDENCE_PREPARATION_TRANSITIONS: Readonly<
  Record<DisputeEvidencePreparationStatus, readonly DisputeEvidencePreparationStatus[]>
> = Object.freeze({
  PREPARED: Object.freeze(["APPROVED", "SUPERSEDED", "SUBMISSION_REFUSED"] as const),
  APPROVED: Object.freeze(["SUBMITTED", "SUPERSEDED", "SUBMISSION_REFUSED"] as const),
  SUBMITTED: Object.freeze([] as const),
  SUPERSEDED: Object.freeze([] as const),
  SUBMISSION_REFUSED: Object.freeze([] as const),
});

export function isValidDisputeEvidencePreparationTransition(
  from: DisputeEvidencePreparationStatus,
  to: DisputeEvidencePreparationStatus,
): boolean {
  return DISPUTE_EVIDENCE_PREPARATION_TRANSITIONS[from].includes(to);
}

// — The provider boundary —

/**
 * The evidence fields this phase will send, and the Monacado record each comes
 * from.
 *
 * **Every one is a plain string on the provider's write path**, and every one is
 * a projection of an immutable record. The provider's request object types its
 * document fields as a *file identifier*, so those fields are unreachable
 * without an upload endpoint — see `DISPUTE_EVIDENCE_FILE_STORAGE_GAP`.
 */
export const SUBMITTABLE_EVIDENCE_FIELDS = [
  "product_description",
  "service_date",
  "refund_policy_disclosure",
  "cancellation_policy_disclosure",
  "refund_refusal_explanation",
] as const;
export type SubmittableEvidenceField = (typeof SUBMITTABLE_EVIDENCE_FIELDS)[number];

/**
 * What must never cross the boundary to a provider, whatever a caller passes.
 *
 * The existing `NEVER_ON_TRANSACTION_DISPUTE` and `NEVER_IN_DISPUTE_CAPSULE`
 * lists govern what Monacado **stores** and **publishes**. Neither governs an
 * outbound call, and until this phase nothing did — a submission service could
 * read `OrderBuyerSnapshot` and pass the cardholder's name, email, and addresses
 * to the provider without contradicting a single committed rule.
 *
 * Sending buyer identity to a card network may well be defensible in some
 * representments. It is a **disclosure decision**, and this phase does not take
 * it. The fields are named so that taking it later is a deliberate act against a
 * list, rather than a service quietly widening.
 *
 * `customer_purchase_ip` is on the list although Monacado captures no IP
 * anywhere. Naming it keeps it unsubmittable by construction if one is ever
 * captured for another purpose.
 */
export const NEVER_SUBMITTED_TO_PROVIDER: readonly string[] = Object.freeze([
  "customer_name",
  "customer_email_address",
  "customer_purchase_ip",
  "billing_address",
  "shipping_address",
  /* Free text is where a note about the cardholder ends up. Excluded for the
     same reason the storage lists exclude it. */
  "uncategorized_text",
]);

/**
 * The document evidence this phase cannot supply, stated as data.
 *
 * Recorded in the register `RECEIPT_LINE_DESCRIPTION_GAP` uses, because it is a
 * gap in the evidence model rather than a rendering choice.
 *
 * The honest summary: the provider accepts a *file identifier* for its document
 * fields, obtainable only by uploading through an endpoint this repository does
 * not have. The two highest-value items in a card-not-present representment — the
 * receipt as the buyer received it, and the correspondence — are document
 * fields. Text-only evidence is a real and defensible answer for several dispute
 * reasons; it is not a complete one, and readiness says so.
 */
export const DISPUTE_EVIDENCE_FILE_STORAGE_GAP = {
  objectStorage: "NOT_IMPLEMENTED",
  providerFileUpload: "NOT_IMPLEMENTED",
  /** No body or body digest is retained for any message Monacado sends. */
  retainedMessageBodies: "NONE",
  documentFieldsUnreachable: [
    "receipt",
    "customer_communication",
    "refund_policy",
    "cancellation_policy",
    "service_documentation",
    "shipping_documentation",
    "duplicate_charge_documentation",
    "customer_signature",
    "uncategorized_file",
  ],
  /** Physical representment is blocked on fulfilment data, not on files. */
  blockedOnBeforeFilesWouldHelp: "CARRIER_AND_TRACKING_RECORDS",
  owner: "T2_SETTLEMENT_AND_PAYOUT",
} as const;

// — The port —

/**
 * Whether this call stages evidence or ends the response.
 *
 * Modelled separately because the provider treats them as one call with a
 * boolean, and **that boolean defaults to submitting**. A request shape in which
 * finality is optional would let a caller finalise a dispute by forgetting a
 * field, so it is required at every layer and never defaulted.
 */
export const DisputeEvidenceSubmissionRequest = z.strictObject({
  disputeId: z.string().min(1).max(191),
  providerDisputeRef: z.string().min(1).max(191),
  preparationId: z.string().min(1).max(191),
  /** Projected at call time from immutable records. Never persisted. */
  evidence: z.partialRecord(z.enum(SUBMITTABLE_EVIDENCE_FIELDS), z.string().min(1).max(20_000)),
  /** FALSE stages; TRUE is the irreversible one-shot. Never defaulted. */
  finalSubmission: z.boolean(),
  /** Stable across retries of the same logical request. See `disputeEvidenceIdempotencyKey`. */
  idempotencyKey: z.string().min(1).max(191),
  /**
   * The provider's own submission counter as last observed. The pre-flight
   * guard: a dispute whose counter has already moved has been answered, and a
   * second answer would spend a submission that no longer exists.
   */
  observedSubmissionCount: z.number().int().min(0),
});
export type DisputeEvidenceSubmissionRequest = z.infer<typeof DisputeEvidenceSubmissionRequest>;

/**
 * Why a submission did not happen.
 *
 * Split by whether a retry could ever help, because the operator's next action
 * differs completely. Nothing here carries provider text: a bounded code and
 * nothing else, per this phase's error rules.
 */
export const DISPUTE_EVIDENCE_SUBMISSION_FAILURE_CODES = [
  /* Terminal — no retry helps. */
  "ALREADY_SUBMITTED",
  "RESPONSE_NOT_PERMITTED",
  "DEADLINE_PASSED",
  "DISPUTE_NOT_OPEN",
  "DISPUTE_NOT_FOUND",
  "EVIDENCE_REJECTED",
  "EVIDENCE_TOO_LARGE",
  "EVIDENCE_EMPTY",
  "PROVIDER_MODE_NOT_PERMITTED",
  "PROVIDER_NOT_CONFIGURED",
  /* Transient — a retry is the right response. */
  "PROVIDER_UNAVAILABLE",
  "UNSPECIFIED_FAILURE",
] as const;
export const DisputeEvidenceSubmissionFailureCode = z.enum(
  DISPUTE_EVIDENCE_SUBMISSION_FAILURE_CODES,
);
export type DisputeEvidenceSubmissionFailureCode = z.infer<
  typeof DisputeEvidenceSubmissionFailureCode
>;

/** The failure codes a retry can ever clear. Everything else is terminal. */
export const RETRYABLE_DISPUTE_EVIDENCE_FAILURE_CODES: readonly DisputeEvidenceSubmissionFailureCode[] =
  Object.freeze(["PROVIDER_UNAVAILABLE", "UNSPECIFIED_FAILURE"]);

export function isRetryableDisputeEvidenceFailure(
  code: DisputeEvidenceSubmissionFailureCode,
): boolean {
  return RETRYABLE_DISPUTE_EVIDENCE_FAILURE_CODES.includes(code);
}

export const DisputeEvidenceSubmitted = z.strictObject({
  outcome: z.literal("SUBMITTED"),
  provider: z.literal("STRIPE"),
  providerMode: z.enum(["TEST", "LIVE"]),
  /** The provider's post-state. The only proof finality took. */
  providerSubmissionCount: z.number().int().min(1),
  providerSubmittedPastDue: z.boolean(),
  submittedAt: z.iso.datetime(),
});
export type DisputeEvidenceSubmitted = z.infer<typeof DisputeEvidenceSubmitted>;

export const DisputeEvidenceStaged = z.strictObject({
  outcome: z.literal("STAGED"),
  provider: z.literal("STRIPE"),
  providerMode: z.enum(["TEST", "LIVE"]),
  providerHasEvidence: z.boolean(),
  providerSubmissionCount: z.number().int().min(0),
  stagedAt: z.iso.datetime(),
});
export type DisputeEvidenceStaged = z.infer<typeof DisputeEvidenceStaged>;

export const DisputeEvidenceSubmissionRefused = z.strictObject({
  outcome: z.literal("REFUSED"),
  failureCode: DisputeEvidenceSubmissionFailureCode,
  retryable: z.boolean(),
});
export type DisputeEvidenceSubmissionRefused = z.infer<typeof DisputeEvidenceSubmissionRefused>;

export const DisputeEvidenceSubmissionResult = z.discriminatedUnion("outcome", [
  DisputeEvidenceSubmitted,
  DisputeEvidenceStaged,
  DisputeEvidenceSubmissionRefused,
]);
export type DisputeEvidenceSubmissionResult = z.infer<typeof DisputeEvidenceSubmissionResult>;

/**
 * The provider-neutral evidence boundary.
 *
 * One method wide, deliberately. There is no `close`: accepting a dispute is an
 * immediate, irreversible acceptance of loss, and a method that cannot be called
 * cannot be called by mistake.
 */
export interface DisputeEvidenceSubmissionPort {
  submitEvidence(
    request: DisputeEvidenceSubmissionRequest,
  ): Promise<DisputeEvidenceSubmissionResult>;
}

// — The representment ruling —

/**
 * **Monacado's Merchant-of-Record representment rule. RESOLVED.**
 *
 * Phase 1.11 recorded `requiresRuling: "MONACADO_MOR_BUSINESS_MODEL_SECTION_I"`
 * against evidence submission, because §I reserved chargeback representment
 * policy to `0M.T` and said plainly *"That policy is not designed here."* Phase
 * 1.12 shipped the capability with the send gated behind that ruling.
 *
 * **The ruling has now been made**, and this constant is it. The gate is gone —
 * not bypassed, not defaulted open, but removed, because the question it was
 * holding open has an answer.
 *
 * 1.11's recorded state is **superseded rather than rewritten**: that phase's
 * committed evidence of what was undecided at the time stays exactly as it was,
 * and this is the later fact that resolves it. The same discipline the dispute
 * ledger itself follows — a new fact about a completed thing, never a correction
 * of one.
 *
 * ## The rule
 *
 * Monacado is **always** responsible for responding to a payment-network dispute
 * attributable to a Monacado transaction. That responsibility is not delegable,
 * and the seller's participation does not transfer it.
 *
 * The seller is entitled to a bounded opportunity to defend the sale, and
 * Monacado is obliged to give them one. What the seller supplies comes **to
 * Monacado** — never to the network — and Monacado weighs it alongside its own
 * authoritative records before deciding what, if anything, to submit.
 *
 * The distinction that matters, and the reason this is stated as data rather
 * than left to a service: **the existence of seller input does not delegate
 * representment authority.** A seller who supplies a defence has been heard, not
 * put in charge. Monacado owns the decision and owns the submission.
 */
export const MONACADO_REPRESENTMENT_RULING = {
  ruling: "RESOLVED",
  supersedes: "MONACADO_MOR_BUSINESS_MODEL_SECTION_I_UNRESOLVED",
  /** Non-delegable, and true of every dispute attributable to a transaction. */
  responsibility: "MONACADO_ALWAYS_RESPONDS",
  sellerMustBeNotified: true,
  sellerMayDefend: true,
  /** Evidence travels to Monacado. Never from a seller to the network. */
  sellerEvidenceDestination: "MONACADO_ONLY",
  sellerMayContactNetwork: false,
  /** Monacado weighs its own records plus whatever the seller supplied. */
  reviewBasis: "MONACADO_RECORDS_PLUS_SELLER_EVIDENCE",
  finalDecision: "MONACADO",
  providerSubmission: "MONACADO",
  /** The load-bearing negative. Being heard is not being in charge. */
  sellerInputDelegatesAuthority: false,
} as const;

/**
 * The seller's defence path, stated as an ordered vocabulary.
 *
 * Written down because the ordering is the safety property. Every stage before
 * the last is Monacado gathering; only the last one reaches a provider, and it
 * is reachable only from an operator-approved preparation.
 */
export const SELLER_DEFENSE_WORKFLOW = [
  "DISPUTE_NOTICE",
  "SELLER_EVIDENCE_OPPORTUNITY",
  "MONACADO_REVIEW",
  "MONACADO_PROVIDER_RESPONSE",
] as const;
export type SellerDefenseStage = (typeof SELLER_DEFENSE_WORKFLOW)[number];

/**
 * What a seller can actually supply today, and what they cannot.
 *
 * **Preserved explicitly rather than left to be discovered.** The ruling grants
 * the seller an opportunity to provide *a defence statement and supporting
 * proof*. Monacado can accept the first as a bounded structured attestation. It
 * cannot accept the second: there is no object storage, no upload endpoint, and
 * no self-service page, so a seller holding a signed delivery receipt has no way
 * to hand it over through this system.
 *
 * The gap is therefore in the **channel**, not in the policy — and the honest
 * consequence is that `DELIVERY_EVIDENCE_HELD_OUTSIDE_MONACADO` exists as a
 * claim: a seller can tell Monacado the proof exists so an operator can chase it
 * out of band, which is worth more than silence and much less than the document.
 */
export const SELLER_EVIDENCE_INPUT_LIMITATION = {
  structuredAttestation: "IMPLEMENTED",
  freeTextStatement: "NOT_IMPLEMENTED_BY_DESIGN",
  documentUpload: "NOT_IMPLEMENTED",
  selfServicePage: "NOT_IMPLEMENTED",
  /** How a seller answers today: through the support contact, recorded by an operator. */
  channel: "SUPPORT_CONTACT_RECORDED_BY_OPERATOR",
  owner: "T2_SETTLEMENT_AND_PAYOUT",
} as const;

// — Evidence completeness —

/**
 * Whether an assembled package is worth sending, as a bounded judgement.
 *
 * `EMPTY` and `PARTIAL` are different operator problems. An empty package means
 * the sale has no answerable evidence at all — the operator's next step is the
 * seller, or accepting the loss. A partial one means Monacado holds something
 * and could send it now.
 */
export const DISPUTE_EVIDENCE_COMPLETENESS = ["EMPTY", "PARTIAL", "SUBSTANTIVE"] as const;
export const DisputeEvidenceCompleteness = z.enum(DISPUTE_EVIDENCE_COMPLETENESS);
export type DisputeEvidenceCompleteness = z.infer<typeof DisputeEvidenceCompleteness>;

/**
 * The codes that, on their own, make a response worth sending.
 *
 * Deliberately narrow: a response carrying only a service date says nothing a
 * bank will weigh. A bound policy version plus what was sold is the minimum that
 * answers anything.
 */
export const SUBSTANTIVE_EVIDENCE_CODES: readonly DisputeEvidenceCode[] = Object.freeze([
  "REFUND_POLICY_VERSION_BOUND_AT_PURCHASE",
  "MARKETPLACE_POLICY_VERSION_AT_PURCHASE",
  "PRODUCT_DESCRIPTION_AT_SALE",
]);

export function disputeEvidenceCompletenessFor(
  available: readonly DisputeEvidenceCode[],
): DisputeEvidenceCompleteness {
  if (available.length === 0) return "EMPTY";
  const substantive = available.filter((code) => SUBSTANTIVE_EVIDENCE_CODES.includes(code));
  return substantive.length >= 2 ? "SUBSTANTIVE" : "PARTIAL";
}
