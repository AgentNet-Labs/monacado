/**
 * Order tax reversal (Phase 1.9).
 *
 * The tax half of undoing a completed sale. `1.7` reported the sale to the tax
 * provider and kept the one identifier a reversal needs — *"the provider's Tax
 * Transaction … **the identifier a later reversal names**"*. This is the later
 * phase, and it names exactly that.
 *
 * ```
 * calculation → payment → provider Tax Transaction → refund → THIS REVERSAL
 * ```
 *
 * ## The original report is never rewritten
 *
 * Not one sale-time column of `OrderTaxTransaction`. `1.7` built that record with
 * an immutable half and named it — `IMMUTABLE_TAX_TRANSACTION_FIELDS` — precisely
 * so that this phase could exist without touching it. What moves on the original
 * is its `lifecycleState`, from `RECORDED` to the `REVERSED` value `1.7`
 * **reserved for this**, and nothing else.
 *
 * That reservation is why a reversal is expressible at all without a schema
 * rewrite. `1.7` put it plainly: a vocabulary introduced at the moment it is
 * first needed *"tends to be introduced by whoever is mid-way through building a
 * refund — which is how a correction ends up overwriting an original."*
 *
 * ## The target is the recorded transaction, never a fresh calculation
 *
 * A reversal is derived from `providerTaxTransactionRef` and from nothing else.
 * Calculating tax again for a historical sale would price it at **today's** rates
 * and reverse a figure the buyer was never charged — the identical mistake
 * `CALCULATION_EXPIRY_REMEDIATION` refuses on the way in, and it would be just as
 * invisible on the way out.
 *
 * ## Independently durable from the payment refund
 *
 * A refunded payment whose tax reversal has not succeeded is a real state that
 * has to be expressible, retryable, and visible. It gets its own record, its own
 * lifecycle, and its own retry schedule; `refundLifecycleState` is what combines
 * the two for a reader.
 *
 * Pure types and pure decisions. No I/O, no clock, no vendor.
 */

import { z } from "zod";
import { ORDER_TAX_REVERSAL_ID_RE, ORDER_TAX_TRANSACTION_ID_RE } from "./identity";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";
import { TaxProvider, TaxProviderMode } from "./tax-calculation";

const Amount = z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT);

// — Identity —

export const OrderTaxReversalId = z
  .string()
  .regex(ORDER_TAX_REVERSAL_ID_RE, "taxReversalId must be mon:txrvs:<opaque>");
export type OrderTaxReversalId = z.infer<typeof OrderTaxReversalId>;

const TaxTransactionRef = z
  .string()
  .regex(ORDER_TAX_TRANSACTION_ID_RE, "taxTransactionId must be mon:txtax:<opaque>");

// — Scope —

/**
 * One member, mirroring `REFUND_SCOPES`.
 *
 * A partial tax reversal is not merely unimplemented — it is **unreachable**,
 * because only a full payment refund can occasion a reversal at all and a full
 * refund reverses the whole of the sale's tax by definition. Adding `PARTIAL`
 * belongs to the same governed phase that decides partial-refund allocation.
 */
export const TAX_REVERSAL_SCOPES = ["FULL"] as const;
export const TaxReversalScope = z.enum(TAX_REVERSAL_SCOPES);
export type TaxReversalScope = z.infer<typeof TaxReversalScope>;

// — Status —

/**
 * Where the **tax reversal's provider call** got to.
 *
 * `1.7`'s five-state shape, reused rather than reinvented: a claimed state with a
 * lease, bounded attempts, and a terminal pair.
 *
 * `PENDING` is written inside the same transaction that records the payment
 * refund's success. That ordering is the whole guarantee of §9: the tax reversal
 * obligation cannot exist before the money came back, and cannot fail to exist
 * after it did.
 */
export const TAX_REVERSAL_STATUSES = [
  /** Committed with the payment refund's success; the provider is uncalled. */
  "PENDING",
  /** Claimed by a worker, with a lease. */
  "IN_PROGRESS",
  /** The provider created the reversal transaction and returned its reference. */
  "REVERSED",
  /** A transient failure. `nextAttemptAt` says when to try again. */
  "RETRY_PENDING",
  /** Out of attempts, or a permanent refusal. Needs an operator. */
  "FAILED_PERMANENT",
] as const;
export const TaxReversalStatus = z.enum(TAX_REVERSAL_STATUSES);
export type TaxReversalStatus = z.infer<typeof TaxReversalStatus>;

export const INITIAL_TAX_REVERSAL_STATUS: TaxReversalStatus = "PENDING";

export const RETRYABLE_TAX_REVERSAL_STATUSES: readonly TaxReversalStatus[] = [
  "PENDING",
  "RETRY_PENDING",
];

// — Normalized provider outcome —

/**
 * Why a tax-reversal attempt failed, in Monacado's words.
 *
 * **No raw provider payload is ever persisted**, on `1.7`'s terms exactly: a
 * vendor error string can echo the request, and this request names a transaction
 * that was created from a buyer's ship-to destination.
 */
export const TAX_REVERSAL_FAILURE_CODES = [
  /** The provider could not be reached, or timed out. */
  "PROVIDER_UNAVAILABLE",
  /** The provider refused the request as malformed or unauthorised. */
  "PROVIDER_REJECTED",
  /** The provider does not know the Tax Transaction Monacado named. */
  "ORIGINAL_TRANSACTION_NOT_FOUND",
  /**
   * The provider says this transaction is already reversed.
   *
   * Permanent, and **not** treated as success for `1.7`'s reason: Monacado holds
   * no provider reversal reference for a reversal it did not observe, and marking
   * the row `REVERSED` would assert evidence that does not exist.
   */
  "ALREADY_REVERSED",
  /** The reversal reference collides with an existing provider transaction. */
  "DUPLICATE_REFERENCE",
  /** Monacado's own records are missing or self-contradictory. */
  "EVIDENCE_INCONSISTENT",
  /** The payment refund has not succeeded, so no reversal may be attempted. */
  "PAYMENT_REFUND_NOT_COMPLETE",
  /** The tax integration is not configured for this deployment. */
  "PROVIDER_NOT_CONFIGURED",
  /** The provider answered from a mode this deployment does not permit. */
  "PROVIDER_MODE_NOT_PERMITTED",
  /** Anything the adapter could not classify. */
  "UNSPECIFIED_FAILURE",
] as const;
export const TaxReversalFailureCode = z.enum(TAX_REVERSAL_FAILURE_CODES);
export type TaxReversalFailureCode = z.infer<typeof TaxReversalFailureCode>;

export const TAX_REVERSAL_OUTCOME_CLASSES = ["REVERSED", "TRANSIENT", "PERMANENT"] as const;
export const TaxReversalOutcomeClass = z.enum(TAX_REVERSAL_OUTCOME_CLASSES);
export type TaxReversalOutcomeClass = z.infer<typeof TaxReversalOutcomeClass>;

export function classifyTaxReversalFailure(
  code: TaxReversalFailureCode,
): TaxReversalOutcomeClass {
  switch (code) {
    case "ORIGINAL_TRANSACTION_NOT_FOUND":
    case "ALREADY_REVERSED":
    case "DUPLICATE_REFERENCE":
    case "EVIDENCE_INCONSISTENT":
    case "PROVIDER_MODE_NOT_PERMITTED":
      return "PERMANENT";
    default:
      /* `PAYMENT_REFUND_NOT_COMPLETE` is transient on purpose: the payment refund
         is itself retrying, and this row becomes attemptable the moment it
         succeeds. Treating it as permanent would abandon a tax reversal for a
         condition that is actively being fixed. */
      return "TRANSIENT";
  }
}

// — Retry policy —

/**
 * How hard, and how long, Monacado tries to reverse a sale's tax.
 *
 * `1.7`'s recording policy, matched deliberately. The consequence of failure is
 * the same in kind — a filing that misstates what Monacado collected — and two
 * schedules for two halves of one lifecycle would be two things for an operator
 * to hold in their head for no benefit.
 */
export const TAX_REVERSAL_RETRY_POLICY = {
  maxAttempts: 8,
  backoffSeconds: [30, 120, 600, 1_800, 7_200, 21_600, 43_200],
  claimLeaseSeconds: 300,
} as const;

export function nextTaxReversalDelaySeconds(attemptCount: number): number | null {
  if (attemptCount >= TAX_REVERSAL_RETRY_POLICY.maxAttempts) return null;
  const index = Math.min(
    attemptCount - 1,
    TAX_REVERSAL_RETRY_POLICY.backoffSeconds.length - 1,
  );
  return TAX_REVERSAL_RETRY_POLICY.backoffSeconds[Math.max(0, index)]!;
}

export function nextTaxReversalAttemptAt(input: {
  attemptCount: number;
  failedAt: string;
}): string | null {
  const delay = nextTaxReversalDelaySeconds(input.attemptCount);
  if (delay === null) return null;
  return new Date(new Date(input.failedAt).getTime() + delay * 1_000).toISOString();
}

// — The record —

/**
 * One sale's tax reversal.
 *
 * Every provider-side fact needed to explain, reconcile, and audit the reversal
 * without asking the provider anything — the same audit-efficient posture `1.7`
 * chose, and for the same reasons: storing only an id makes every later question
 * a round trip that stops working when a credential rotates, and mirroring the
 * raw response puts an unbounded vendor payload into a table nobody scoped.
 */
export const OrderTaxReversalRecord = z.strictObject({
  taxReversalId: OrderTaxReversalId,
  /** One tax reversal per Order in this phase. Enforced by a unique index. */
  orderId: z.string().min(1).max(191),
  /** The payment refund this reversal accompanies. */
  refundId: z.string().min(1).max(191),
  /** The `1.7` record whose sale-time facts this reverses. Never rewritten. */
  taxTransactionId: TaxTransactionRef,

  scope: TaxReversalScope,

  // — Provider identity —
  provider: TaxProvider,
  providerMode: TaxProviderMode,
  /**
   * The **original** provider Tax Transaction, copied from the `1.7` record at
   * commit time.
   *
   * Copied rather than joined so the pairing a filing rests on survives
   * independently of either row moving — and so the reversal target can never
   * silently become whatever the original row says later.
   */
  originalProviderTaxTransactionRef: z.string().min(1).max(191),
  /** The provider's reversal transaction. `null` until the call succeeds. */
  providerReversalRef: z.string().min(1).max(191).nullable(),
  /**
   * The Monacado reference sent to the provider for the **reversal**.
   *
   * Distinct from the original transaction's reference by construction: Stripe
   * requires `reference` unique across all transactions **including reversals**,
   * so reusing the Order id would be refused. Derived, never supplied — see
   * `taxReversalProviderReference`.
   */
  providerReference: z.string().min(1).max(191),
  /** When the provider created its reversal. `null` until then. */
  providerReversalCreatedAt: z.iso.datetime().nullable(),

  // — Immutable reversal-time facts, copied from the original report —
  currency: CurrencyCode,
  /** The tax being reversed. Copied from the original, never recalculated. */
  reversedTaxAmountMinorUnits: Amount,
  /** The basis the original transaction reported. Copied, for reconciliation. */
  reversedTaxableBasisMinorUnits: Amount,

  /** When Monacado committed the obligation to reverse. */
  recordedAt: z.iso.datetime(),

  // — Lifecycle —
  status: TaxReversalStatus,
  attemptCount: z.number().int().min(0).max(TAX_REVERSAL_RETRY_POLICY.maxAttempts),
  nextAttemptAt: z.iso.datetime().nullable(),
  lastFailureCode: TaxReversalFailureCode.nullable(),
  lastFailureClass: TaxReversalOutcomeClass.nullable(),
  finalizedAt: z.iso.datetime().nullable(),
  requeueCount: z.number().int().min(0),
  lastRequeuedAt: z.iso.datetime().nullable(),
  updatedAt: z.iso.datetime(),
});
export type OrderTaxReversalRecord = z.infer<typeof OrderTaxReversalRecord>;

/**
 * The Monacado reference for one reversal, derived from the Order.
 *
 * **Derived rather than random**, which is what makes it idempotent across
 * retries: a reference that varied per attempt would let a timeout followed by a
 * retry create a *second* reversal, and the sale would appear twice in a return.
 *
 * Suffixed rather than reused, because Stripe enforces `reference` uniqueness
 * across all transactions including reversals — the original report already
 * claimed the bare Order id, so a reversal claiming it too would be refused.
 * Stripe's own documented example is `myOrder_123-refund_1`.
 */
export const TAX_REVERSAL_REFERENCE_SUFFIX = "-reversal";

export function taxReversalProviderReference(orderId: string): string {
  return `${orderId}${TAX_REVERSAL_REFERENCE_SUFFIX}`;
}

/**
 * The reversal-time facts written once and never rewritten.
 *
 * A retry advances the status and the provider's reference arrives on success;
 * neither may touch anything on this list. A test asserts they are unchanged
 * across a retry.
 */
export const IMMUTABLE_TAX_REVERSAL_FIELDS = [
  "orderId",
  "refundId",
  "taxTransactionId",
  "scope",
  "provider",
  "providerMode",
  "originalProviderTaxTransactionRef",
  "providerReference",
  "currency",
  "reversedTaxAmountMinorUnits",
  "reversedTaxableBasisMinorUnits",
  "recordedAt",
] as const;

/**
 * Named as never admissible on a tax reversal, and refused by `strictObject`.
 *
 * `NEVER_ON_TAX_TRANSACTION`'s list, unchanged in substance: a reversal is about
 * a transaction, not a person, and the fields that would identify one are the
 * same fields.
 */
export const NEVER_ON_TAX_REVERSAL = [
  "buyerName",
  "buyerEmail",
  "billingAddress",
  "shippingAddress",
  "shipToAddress",
  "postalCode",
  "ipAddress",
  "cardNumber",
  "paymentMethodPayload",
  "rawProviderResponse",
  "providerPayload",
  "providerMessage",
  "exemptionNumber",
  "vatNumber",
  "apiKey",
  "accountId",
] as const;

// — Coherence —

/**
 * A reversed row agrees with itself.
 *
 * Checked before a row is marked `REVERSED`. A success carrying no provider
 * reference is a reversal Monacado cannot prove happened; one whose reference
 * equals the original transaction's is a provider echoing the input rather than
 * creating a reversal, and accepting it would leave the original looking reversed
 * by itself.
 */
export function taxReversalIsCoherent(record: OrderTaxReversalRecord): boolean {
  if (record.status !== "REVERSED") return true;
  if (record.providerReversalRef === null) return false;
  if (record.providerReversalCreatedAt === null) return false;
  return record.providerReversalRef !== record.originalProviderTaxTransactionRef;
}

/**
 * What the reversal does to the original report's **lifecycle** column.
 *
 * The single value `1.7` reserved, named here so the write site cannot invent a
 * different one. Nothing else on the original moves.
 */
export const REVERSED_TAX_TRANSACTION_LIFECYCLE_STATE = "REVERSED" as const;
