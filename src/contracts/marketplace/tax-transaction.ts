/**
 * Order tax transaction (Phase 1.7).
 *
 * The post-payment half of the tax lifecycle. `1.6` calculates tax and records
 * **why** the buyer was charged what they were charged, before the charge. This
 * records **what was reported to the tax provider once the charge succeeded**.
 *
 * ```
 * calculation → successful payment → provider Tax Transaction → this record
 * ```
 *
 * ## Why a second record rather than columns on the evidence
 *
 * They are facts about different instants, and one exists without the other. A
 * declined payment leaves a calculation and no transaction; a paid Order whose
 * provider call has not yet succeeded leaves a transaction record that is
 * *committed but not yet reported*. Folding the second into `OrderTaxEvidence`
 * would make "was this reported to the provider?" and "what was calculated?" the
 * same question, and would mean mutating a sale-time evidence row every time a
 * retry advanced.
 *
 * ## Audit-efficient, not a mirror and not a pointer
 *
 * Two failure modes were available and both are refused.
 *
 * **Storing only a provider id** would mean every audit, reconciliation, refund,
 * correction, or filing preparation begins with a round trip to Stripe — and
 * would be unanswerable at all once a credential rotates, an account closes, or a
 * provider is replaced. **Mirroring the raw response** would put an unbounded
 * vendor payload, with a customer address in it, into a table nobody scoped.
 *
 * What is kept instead is the **bounded set of facts a later reader actually
 * needs**: the two provider references, the amounts, the currency, the ship-to
 * jurisdiction code, the exact Product source version and classification, the
 * provider code and mapping version that produced it, and the instants. Enough to
 * explain, reconcile, and reverse a sale without asking the provider anything.
 *
 * ## Immutable facts, mutable lifecycle
 *
 * The sale-time facts are written once and **never rewritten** — not by a retry,
 * not by an adjustment, not by a reversal. `IMMUTABLE_TAX_TRANSACTION_FIELDS`
 * names them and a test asserts a recorded row's are unchanged after a later
 * write. What moves is the *recording* status (did the provider call succeed
 * yet) and the *tax lifecycle* state (has this sale's tax since been adjusted or
 * reversed) — and the second of those is reserved, not implemented.
 *
 * ## What it is not
 *
 * Not filing, not remittance, not a return, not a refund, not a reversal
 * execution, and not a payout. `TAX_FILING_BOUNDARY` is unchanged by this phase
 * except that `providerRecordsTransactions` becomes true.
 *
 * Pure types and pure decisions. No I/O, no clock, no vendor.
 */

import { z } from "zod";
import { ORDER_TAX_EVIDENCE_ID_RE, ORDER_TAX_TRANSACTION_ID_RE } from "./identity";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";
import {
  TaxJurisdictionCode,
  TaxProvider,
  TaxProviderMode,
  TaxTreatment,
} from "./tax-calculation";
import { ProductTaxClassification } from "../product/product-tax-classification";

const Amount = z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT);

// — Identity —

export const OrderTaxTransactionId = z
  .string()
  .regex(ORDER_TAX_TRANSACTION_ID_RE, "taxTransactionId must be mon:txtax:<opaque>");
export type OrderTaxTransactionId = z.infer<typeof OrderTaxTransactionId>;

const TaxEvidenceRef = z
  .string()
  .regex(ORDER_TAX_EVIDENCE_ID_RE, "taxEvidenceId must be mon:taxe:<opaque>");

// — Tax lifecycle —

/**
 * What has happened to this sale's tax **since it was reported**.
 *
 * `RECORDED` is the only state this phase can produce, and the other three are
 * **reserved rather than pretended**: adjustment and reversal execution are a
 * later phase, and nothing here writes them.
 *
 * They exist now for a reason that is not speculation. A tax transaction is a
 * durable record whose *later* states must be expressible without rewriting the
 * sale-time facts underneath them, and a vocabulary introduced at the moment it
 * is first needed tends to be introduced by whoever is mid-way through building a
 * refund — which is how a correction ends up overwriting an original. Naming the
 * shape now is what makes "append evidence, never rewrite" enforceable later.
 *
 * A test asserts the recorder produces `RECORDED` and nothing else.
 */
export const TAX_TRANSACTION_LIFECYCLE_STATES = [
  /** Reported to the provider. The only state this phase writes. */
  "RECORDED",
  /** Reserved: a correction was reported that did not reverse the sale. */
  "ADJUSTED",
  /** Reserved: part of the sale's tax was reversed. */
  "PARTIALLY_REVERSED",
  /** Reserved: the whole of the sale's tax was reversed. */
  "REVERSED",
] as const;
export const TaxTransactionLifecycleState = z.enum(TAX_TRANSACTION_LIFECYCLE_STATES);
export type TaxTransactionLifecycleState = z.infer<typeof TaxTransactionLifecycleState>;

/** The only lifecycle state a sale-time recording may be created in. */
export const INITIAL_TAX_TRANSACTION_LIFECYCLE_STATE: TaxTransactionLifecycleState = "RECORDED";

/** Lifecycle states this phase can actually reach. Asserted by test. */
export const IMPLEMENTED_TAX_TRANSACTION_LIFECYCLE_STATES: readonly TaxTransactionLifecycleState[] =
  ["RECORDED"];

// — Recording status —

/**
 * Where the **provider call** got to, which is a different question from what
 * happened to the tax.
 *
 * The same five-state shape `1.5`'s `OutboundEmailDelivery` uses, deliberately
 * rather than a second convention: a claimed row with a lease, bounded attempts,
 * and a terminal pair. `IN_PROGRESS` holds a lock token and a lease, so a worker
 * that dies mid-call costs an **attempt** rather than the obligation.
 *
 * `PENDING` is written inside the sale's own transaction. That is the property
 * that makes the obligation impossible to lose: either the sale and its
 * tax-recording obligation both commit, or neither does.
 */
export const TAX_TRANSACTION_RECORDING_STATUSES = [
  /** Committed with the sale; the provider has not been called yet. */
  "PENDING",
  /** Claimed by a worker, with a lease. */
  "IN_PROGRESS",
  /** The provider created the Tax Transaction and returned its reference. */
  "RECORDED",
  /** A transient failure. `nextAttemptAt` says when to try again. */
  "RETRY_PENDING",
  /** Out of attempts, or a permanent refusal. Needs an operator. */
  "FAILED_PERMANENT",
] as const;
export const TaxTransactionRecordingStatus = z.enum(TAX_TRANSACTION_RECORDING_STATUSES);
export type TaxTransactionRecordingStatus = z.infer<typeof TaxTransactionRecordingStatus>;

export const INITIAL_TAX_TRANSACTION_RECORDING_STATUS: TaxTransactionRecordingStatus = "PENDING";

/** Statuses from which another provider attempt is due or possible. */
export const RETRYABLE_RECORDING_STATUSES: readonly TaxTransactionRecordingStatus[] = [
  "PENDING",
  "RETRY_PENDING",
];

// — Retry policy —

/**
 * How hard, and how long, Monacado tries to report a sale's tax.
 *
 * More attempts and a longer tail than `1.5`'s email policy, because the
 * consequences differ. An undelivered receipt is a buyer who has to ask; an
 * unreported tax transaction is a sale missing from a filing, and the provider's
 * calculation expires — after which it can never be reported at all. The schedule
 * is readable rather than exponential-with-jitter for the same reason `1.5` gave:
 * a handful of rows does not need load spreading, and a schedule an operator can
 * read off is worth more than one they cannot.
 */
export const TAX_TRANSACTION_RETRY_POLICY = {
  /** Provider attempts, including the first. */
  maxAttempts: 8,
  /** Delay before attempt *n+1*, in seconds. */
  backoffSeconds: [30, 120, 600, 1_800, 7_200, 21_600, 43_200],
  /**
   * How long a claim is held before another worker may take the row.
   *
   * Longer than any Stripe call should take, short enough that a crashed worker
   * does not strand a filing obligation for an hour.
   */
  claimLeaseSeconds: 300,
} as const;

/**
 * When to try again after `attemptCount` failed attempts, or `null` if done.
 *
 * `attemptCount` is the number of attempts **already made**, so the first failure
 * asks for index 0.
 */
export function nextTaxRecordingDelaySeconds(attemptCount: number): number | null {
  if (attemptCount >= TAX_TRANSACTION_RETRY_POLICY.maxAttempts) return null;
  const index = Math.min(
    attemptCount - 1,
    TAX_TRANSACTION_RETRY_POLICY.backoffSeconds.length - 1,
  );
  return TAX_TRANSACTION_RETRY_POLICY.backoffSeconds[Math.max(0, index)]!;
}

/** The instant of the next attempt, or `null` when the attempts are spent. */
export function nextTaxRecordingAttemptAt(input: {
  attemptCount: number;
  failedAt: string;
}): string | null {
  const delay = nextTaxRecordingDelaySeconds(input.attemptCount);
  if (delay === null) return null;
  return new Date(new Date(input.failedAt).getTime() + delay * 1_000).toISOString();
}

// — Normalized provider outcome —

/**
 * Why a provider attempt failed, in Monacado's words.
 *
 * **No raw Stripe error payload is ever persisted.** A vendor error string can
 * carry the request it was about, and this request was about a buyer's ship-to
 * address. An adapter translates once, at the boundary, into this closed
 * vocabulary; everything above decides from the answer.
 */
export const TAX_RECORDING_FAILURE_CODES = [
  /** The provider could not be reached, or timed out. */
  "PROVIDER_UNAVAILABLE",
  /** The provider refused the request as malformed or unauthorised. */
  "PROVIDER_REJECTED",
  /** The calculation has expired and can never become a transaction. */
  "CALCULATION_EXPIRED",
  /** The provider says a transaction already exists for this reference. */
  "DUPLICATE_REFERENCE",
  /** Monacado's own evidence is missing or self-contradictory. */
  "EVIDENCE_INCONSISTENT",
  /** The tax integration is not configured for this deployment. */
  "PROVIDER_NOT_CONFIGURED",
  /** The provider answered from a mode this deployment does not permit. */
  "PROVIDER_MODE_NOT_PERMITTED",
  /** Anything the adapter could not classify. */
  "UNSPECIFIED_FAILURE",
] as const;
export const TaxRecordingFailureCode = z.enum(TAX_RECORDING_FAILURE_CODES);
export type TaxRecordingFailureCode = z.infer<typeof TaxRecordingFailureCode>;

/**
 * Whether another attempt is worth making.
 *
 * `PERMANENT` failures stop immediately rather than burning eight attempts on a
 * refusal that will not change — and an expired calculation is the clearest case:
 * no number of retries brings it back.
 */
export const TAX_RECORDING_OUTCOME_CLASSES = ["RECORDED", "TRANSIENT", "PERMANENT"] as const;
export const TaxRecordingOutcomeClass = z.enum(TAX_RECORDING_OUTCOME_CLASSES);
export type TaxRecordingOutcomeClass = z.infer<typeof TaxRecordingOutcomeClass>;

export function classifyTaxRecordingFailure(
  code: TaxRecordingFailureCode,
): TaxRecordingOutcomeClass {
  switch (code) {
    case "CALCULATION_EXPIRED":
    case "EVIDENCE_INCONSISTENT":
    case "PROVIDER_MODE_NOT_PERMITTED":
    case "DUPLICATE_REFERENCE":
      return "PERMANENT";
    default:
      return "TRANSIENT";
  }
}

// — The record —

/**
 * One Order's tax transaction.
 *
 * Note what has no field, and could not be given one without changing this
 * `strictObject`: a buyer name, email, billing address, or ship-to street; a card
 * or bank detail; a provider credential; a raw provider payload; a Product
 * description. Each lives in exactly one authoritative record already, and a
 * second copy here would be a second answer able to disagree with it —
 * `NEVER_ON_TAX_TRANSACTION` names them.
 */
export const OrderTaxTransactionRecord = z.strictObject({
  taxTransactionId: OrderTaxTransactionId,
  orderId: z.string().min(1).max(191),
  /** The `1.6` calculation evidence this reports. One-to-one with the Order. */
  taxEvidenceId: TaxEvidenceRef,

  // — Provider identity —
  provider: TaxProvider,
  providerMode: TaxProviderMode,
  /**
   * The engine's calculation this transaction was created **from**.
   *
   * Copied from the evidence at commit time rather than joined at use time, so
   * the pairing a filing rests on survives independently of either row moving.
   */
  providerCalculationRef: z.string().min(1).max(191),
  /**
   * The provider's Tax Transaction. `null` until the provider call succeeds.
   *
   * **The identifier a later reversal names.** Stripe reverses a transaction, not
   * a calculation, so this is the durable handle the correction phase needs.
   */
  providerTaxTransactionRef: z.string().min(1).max(191).nullable(),
  /**
   * The Monacado reference sent to the provider, unique across its transactions.
   *
   * The Order id. Kept because it is the **second** idempotency guard: even if a
   * Monacado-side key were lost, the provider itself refuses a duplicate
   * reference, so one Order cannot legitimately produce two Tax Transactions.
   */
  providerReference: z.string().min(1).max(191),

  // — Immutable sale-time facts —
  currency: CurrencyCode,
  /** Retail + shipping, as reported. Never includes tax. */
  taxableBasisMinorUnits: Amount,
  taxAmountMinorUnits: Amount,
  /**
   * The total the provider represents for this transaction, once recorded.
   *
   * Kept as a **checked** figure, not a second source of truth: a provider total
   * that is not basis + tax means the two systems disagree about the sale, and
   * that is the thing worth surfacing. `null` until recorded.
   */
  providerTotalAmountMinorUnits: Amount.nullable(),
  /** Derived from the Order's ship-to address. The one sourcing rule. */
  jurisdictionCode: TaxJurisdictionCode.nullable(),
  treatment: TaxTreatment,

  /**
   * The exact Product source version this sale's tax was computed under.
   *
   * Pinned rather than joined, for the reason `1.6`'s evidence pins it:
   * reclassifying a Product must change nothing about a sale already made. Today
   * an Order binds one Listing and therefore one Product, so these fields **are**
   * the line-level tax evidence; a future multi-line Order needs a lines table,
   * and that is recorded as a seam rather than built empty now.
   */
  internalProductId: z.string().min(1).max(191),
  productSourceRecordId: z.string().min(1).max(191),
  productSourceRecordVersion: z.string().min(1).max(64),
  productTaxClassification: ProductTaxClassification,
  providerTaxCode: z.string().min(1).max(64).nullable(),
  providerConfigVersion: z.string().min(1).max(64).nullable(),

  // — Instants —
  /** When the engine calculated. Copied from the evidence. */
  calculatedAt: z.iso.datetime(),
  /** When the provider created its Tax Transaction. `null` until recorded. */
  providerTaxTransactionCreatedAt: z.iso.datetime().nullable(),
  /** When Monacado committed this obligation — inside the sale's transaction. */
  recordedAt: z.iso.datetime(),

  // — Lifecycle —
  lifecycleState: TaxTransactionLifecycleState,
  recordingStatus: TaxTransactionRecordingStatus,
  attemptCount: z.number().int().min(0).max(TAX_TRANSACTION_RETRY_POLICY.maxAttempts),
  nextAttemptAt: z.iso.datetime().nullable(),
  lastFailureCode: TaxRecordingFailureCode.nullable(),
  lastFailureClass: TaxRecordingOutcomeClass.nullable(),
  /** When the provider call finally succeeded or was abandoned. */
  finalizedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
export type OrderTaxTransactionRecord = z.infer<typeof OrderTaxTransactionRecord>;

/**
 * The sale-time facts that are written once and never rewritten.
 *
 * Not a convention — a checked one. A retry advances the recording status and an
 * eventual correction appends new evidence; neither may touch anything on this
 * list, because the whole value of the record is that it still says what was true
 * at the moment of sale. A test asserts they are unchanged across a retry.
 */
export const IMMUTABLE_TAX_TRANSACTION_FIELDS = [
  "orderId",
  "taxEvidenceId",
  "provider",
  "providerMode",
  "providerCalculationRef",
  "providerReference",
  "currency",
  "taxableBasisMinorUnits",
  "taxAmountMinorUnits",
  "jurisdictionCode",
  "treatment",
  "internalProductId",
  "productSourceRecordId",
  "productSourceRecordVersion",
  "productTaxClassification",
  "providerTaxCode",
  "providerConfigVersion",
  "calculatedAt",
  "recordedAt",
] as const;

/**
 * Named as never admissible on a tax transaction.
 *
 * Each already lives in exactly one authoritative record: buyer identity and both
 * addresses on `OrderBuyerSnapshot`, payment detail at the processor, Product
 * prose on the Product source version. A second copy here would be a second
 * answer able to disagree — and the raw provider payload is where every field
 * nobody agreed to store eventually appears.
 */
export const NEVER_ON_TAX_TRANSACTION = [
  // buyer identity and addresses — OrderBuyerSnapshot holds these, once
  "buyerName",
  "buyerEmail",
  "billingAddress",
  "shippingAddress",
  "shipToAddress",
  "postalCode",
  "ipAddress",
  // payment credentials — never anywhere in Monacado
  "cardNumber",
  "paymentMethodPayload",
  // provider payloads and prose
  "rawProviderResponse",
  "providerPayload",
  "productDescription",
  "lineItemDescription",
  // exemption credentials — ordinary retail checkout has no such workflow
  "exemptionNumber",
  "vatNumber",
  "resaleCertificate",
  // credentials
  "apiKey",
  "accountId",
] as const;

// — Coherence —

/**
 * A recorded transaction agrees with itself.
 *
 * Checked before a row is marked `RECORDED`, so a provider total that does not
 * reconcile is caught at the boundary rather than discovered in a filing. A
 * transaction that is not yet recorded has no provider total to check.
 */
export function taxTransactionIsCoherent(record: OrderTaxTransactionRecord): boolean {
  if (record.recordingStatus !== "RECORDED") return true;
  if (record.providerTaxTransactionRef === null) return false;
  if (record.providerTotalAmountMinorUnits === null) return false;
  return (
    record.providerTotalAmountMinorUnits ===
    record.taxableBasisMinorUnits + record.taxAmountMinorUnits
  );
}

/**
 * Whether a zero-tax result still needs reporting. **It always does.**
 *
 * Stated as a function rather than left implicit because the tempting
 * optimisation — skip the provider call when the amount is zero — is wrong in a
 * way that only shows up at filing time. A jurisdiction where Monacado is
 * registered and collected nothing is a **return line**, not an absence, and a
 * transaction the provider never saw cannot appear on one.
 *
 * `EXEMPT` and `OUT_OF_SCOPE` are both reported, and the distinction between them
 * survives on the record.
 */
export function requiresProviderTaxTransaction(input: {
  treatment: TaxTreatment;
  taxAmountMinorUnits: number;
}): boolean {
  void input;
  return true;
}
