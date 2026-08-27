/**
 * Buyer refund execution (Phase 1.9).
 *
 * `1.2` built the **accounting** for undoing a sale — `TransactionReversal`, an
 * immutable entry stating what each party gave back — and deliberately shipped no
 * way to execute one, because executing a refund moves money and that phase was
 * about the controls that must exist before any money moves. This is the
 * execution, and it is a separate record for a reason worth stating plainly:
 *
 * ```
 * OrderRefund          — did Monacado ask the provider to return the funds,
 *                        and what happened?          ATTEMPTS, LEASES, FAILURES.
 * TransactionReversal  — what did each party give back?          IMMUTABLE ENTRY.
 * ```
 *
 * An entry with a retry schedule bolted onto it would be an accounting record
 * that changes, which is exactly what `0M.T1` built the snapshot to make
 * impossible. So the reversal entry is written **once**, at the moment the
 * provider confirms, from a record that carried the attempt history separately.
 * The same split `1.7` drew between `OrderTaxEvidence` and `OrderTaxTransaction`.
 *
 * ## The original sale is never touched
 *
 * Not one column of `Order`, `TransactionEconomicSnapshot`, `OrderTaxEvidence`, or
 * the sale-time facts on `OrderTaxTransaction`. A refund is **new evidence about**
 * a sale, never a correction *of* one, and a system that could edit a completed
 * sale is a system that cannot prove what it charged anybody.
 *
 * ## The refund unit is a whole Order line
 *
 * ```
 * one or more lines   →  each refunded IN FULL   →  allowed
 * one line            →  refunded in part        →  REFUSED
 * ```
 *
 * A refund may therefore be **partial relative to the Order** while being **full
 * relative to every line it touches**. That is the settled marketplace rule, and
 * it is deliberately not "full Order only": encoding today's one-Listing Order as
 * a permanent invariant would mean the policy had to be rewritten — not merely
 * the plumbing — the day a basket exists.
 *
 * What stays refused is an **arbitrary partial-dollar refund of one line**, and
 * the refusal is **structural**: there is no monetary amount parameter anywhere in
 * the request path. A caller selects *lines*; the system derives the amount from
 * authoritative sale-time facts plus the bound seller policy. Asking for a figure
 * of one's own is `PARTIAL_LINE_REFUND_NOT_SUPPORTED`, **before any provider is
 * contacted and before any row is written**.
 *
 * `1.2` deferred sub-line allocation because it forces a decision about *whose*
 * money comes back first — Monacado's retention, the seller's proceeds, or the
 * promoter's spread — and every rule is a commercial policy decision with
 * different winners. Selecting whole lines needs no such rule: each line's own
 * sale-time economics govern its refund. See `PARTIAL_LINE_REFUND_DEFERRAL`.
 *
 * ## Today's execution limit, recorded rather than encoded
 *
 * An Order currently binds exactly one Listing, so it has exactly one line and
 * every valid refund selects all of it — which *executes* as a whole-Order
 * refund. `SINGLE_LINE_EXECUTION_LIMIT` states that as a property of the current
 * Order model rather than of the refund policy, and the subset path fails closed
 * rather than being absent.
 *
 * ## Payment refund and tax reversal are independently durable
 *
 * They are two provider calls to two systems and either can fail while the other
 * succeeded. `1.9` refuses to pretend otherwise: the payment refund's completion
 * lives here, the tax reversal's lives on `OrderTaxReversal`, and the composite
 * state an operator reads is **derived** from both by `refundLifecycleState`
 * rather than stored as a third answer able to disagree with either.
 *
 * Pure types and pure decisions. No I/O, no clock, no vendor.
 */

import { z } from "zod";
import { ORDER_REFUND_ID_RE } from "./identity";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";
import { PaymentProvider } from "./payment-account";
import { ProviderTransactionRef } from "./transaction-accounting";
import { TaxReversalStatus } from "./tax-reversal";
import {
  shippingIsRefundable,
  type ShippingRefundability,
} from "./seller-refund-policy";

const Amount = z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT);

// — Identity —

export const OrderRefundId = z
  .string()
  .regex(ORDER_REFUND_ID_RE, "refundId must be mon:refnd:<opaque>");
export type OrderRefundId = z.infer<typeof OrderRefundId>;

// — The refund unit —

/**
 * The unit a refund is expressed in. **One or more whole Order lines.**
 *
 * A single-member enum rather than a boolean, on the same terms as
 * `STRIPE_MODES`: adding a sub-line member has to be a deliberate, greppable
 * edit made in a phase that decided the allocation rules, not a value somebody
 * passed.
 *
 * `LINE_SET` deliberately replaces `1.9`'s first draft of `FULL`. That name
 * asserted the wrong invariant — it said a refund must cover the whole Order —
 * and a vocabulary that says so is one a basket phase has to *rewrite* rather
 * than extend.
 */
export const REFUND_SCOPES = ["LINE_SET"] as const;
export const RefundScope = z.enum(REFUND_SCOPES);
export type RefundScope = z.infer<typeof RefundScope>;

/**
 * The settled refund-unit rule, as data.
 *
 * Stated so the policy is checkable and so a later reader can see that the
 * one-line execution limit below is a property of the **Order model**, not of the
 * refund policy.
 */
export const REFUND_UNIT_POLICY = {
  /** The smallest thing that can be refunded. */
  unit: "WHOLE_ORDER_LINE",
  /** More than one may be selected. */
  multipleLinesSelectable: true,
  /** Unselected lines are untouched. */
  unselectedLinesUntouched: true,
  /** Each selected line comes back in full. */
  selectedLinesRefundedInFull: true,
  /** A refund may be partial relative to the Order. */
  mayBePartialRelativeToOrder: true,
  /** An arbitrary monetary amount for one line may not be requested. */
  arbitraryPerLineAmount: "REFUSED",
  /** Each line's own sale-time economics govern its refund. */
  economicsSource: "SALE_TIME_LINE_EVIDENCE",
  /** Nothing is recomputed from current Product, Offer, or policy data. */
  recomputationFromCurrentData: "REFUSED",
} as const;

/**
 * What today's Order model can actually execute, kept apart from the policy.
 *
 * An Order binds exactly one Listing (`0M.9`), so it has exactly one line and a
 * "line set" is always that one line. Every valid refund therefore *executes* as
 * a whole-Order refund — but nothing in the contracts, the services, or the
 * schema says it must, which is the difference this correction exists to make.
 *
 * The subset path is present and **fails closed** rather than being absent: the
 * accounting entry `1.2` writes has one scope (`FULL`), and no line-level tax
 * evidence exists, so a subset refund is refused by name rather than approximated.
 */
export const SINGLE_LINE_EXECUTION_LIMIT = {
  /** Why every refund today covers the whole Order. */
  cause: "ORDER_BINDS_EXACTLY_ONE_LISTING",
  /** Whose limit it is. Not the refund policy's. */
  owner: "ORDER_MODEL",
  linesPerOrderToday: 1,
  /** What the policy already permits, and the Order model does not yet supply. */
  policyPermitsSubsetOfLines: true,
  /** And what a subset refund does today, rather than being approximated. */
  subsetRefundBehaviourToday: "REFUSED_FAIL_CLOSED",
  blockingEvidenceGaps: [
    "NO_ORDER_LINE_TABLE",
    "TRANSACTION_REVERSAL_SCOPE_HAS_ONLY_FULL",
    "NO_LINE_LEVEL_PROVIDER_TAX_EVIDENCE",
    "NO_GOVERNED_SHIPPING_ALLOCATION_RULE",
  ],
} as const;

/**
 * What a later **sub-line** refund phase must decide before one line is written.
 *
 * Narrowed from `1.9`'s first draft: selecting whole lines needs no allocation
 * ruling at all, because each line's own sale-time economics govern it. What
 * still needs one is splitting a *single* line, where whose money comes back
 * first is a commercial decision with different winners.
 */
export const PARTIAL_LINE_REFUND_DEFERRAL = {
  supported: false,
  refusalCode: "PARTIAL_LINE_REFUND_NOT_SUPPORTED",
  /** Whose ruling it is. Not an accounting module's, and not an engineer's. */
  owner: "MONACADO_MOR_BUSINESS_MODEL_SECTION_I",
  /** Every allocation splitting one line would force a decision about. */
  allocationDecisionsRequired: [
    "SELLER_PROCEEDS_WITHIN_A_LINE",
    "PROMOTER_PROCEEDS_WITHIN_A_LINE",
    "MONACADO_RETAINED_AMOUNT_WITHIN_A_LINE",
    "TAX_WITHIN_A_LINE",
    "SHIPPING_AND_PASS_THROUGH_WITHIN_A_LINE",
  ],
  /** And the provider-side half, which is not the hard part but is not free. */
  providerCapabilityAvailable: true,
} as const;

// — Lines —

/**
 * The reference that names one line of one Order.
 *
 * Today an Order has one line and no `OrderLine` table exists, so the reference
 * is **derived from the Order** — `<orderId>#L1`. It is deliberately a derived
 * reference rather than a minted opaque identity: minting one now would create an
 * identifier space with one member per Order that a real `OrderLine` row would
 * immediately have to supersede.
 *
 * When the multi-line Order model lands, a line ref becomes that row's own
 * identity and this helper stops being the only producer. Nothing above parses
 * the string: it is opaque to every caller, compared and never decomposed.
 */
export const ORDER_LINE_REF_SUFFIX = "#L1";

export function singleOrderLineRef(orderId: string): string {
  return `${orderId}${ORDER_LINE_REF_SUFFIX}`;
}

export const OrderLineRef = z.string().min(1).max(220);

/**
 * One refundable line, as its **sale-time** economics recorded it.
 *
 * Every figure is read from durable evidence the sale itself produced. Nothing
 * here is recomputed from a current Product, Offer, Listing, or commercial
 * policy — a line priced from today's data would return a figure the buyer was
 * never charged, and it would look entirely correct.
 *
 * Shipping is **not** a line field. It is one charge for one carriage, governed
 * by the seller's policy at Order level; attaching a share of it to a line would
 * be the proration `SHIPPING_ALLOCATION_SEAM` refuses.
 */
export const RefundableOrderLine = z.strictObject({
  lineRef: OrderLineRef,
  internalProductId: z.string().min(1).max(191),
  /** The exact Listing source version this line was sold under. */
  listingSourceRecordId: z.string().min(1).max(191),
  listingSourceRecordVersion: z.string().min(1).max(64),
  currency: CurrencyCode,
  /** The merchandise amount for this line, as quoted. Never tax, never shipping. */
  commercialRetailAmountMinorUnits: Amount,
  /** The tax attributable to this line, from sale-time evidence. */
  taxAmountMinorUnits: Amount,
});
export type RefundableOrderLine = z.infer<typeof RefundableOrderLine>;

// — Reason —

/**
 * Why the refund was made, as a closed Monacado vocabulary.
 *
 * The smallest set that distinguishes outcomes anybody acts on differently, and
 * **no free text**. The same rule `ReversalReasonCode`, `PaymentFailureCode`, and
 * `RestrictionReasonCode` follow, for the same reason: a free-text reason is
 * where a buyer's name, an address, or a support agent's opinion eventually
 * lands, in a table nobody scoped for any of them.
 *
 * These are deliberately **not** `ReversalReasonCode`. That vocabulary answers
 * "how was the sale undone" across refunds *and* chargebacks; this one answers
 * "why did Monacado choose to refund", which a bank-initiated reversal never has.
 * `reversalReasonForRefund` maps one to the other so the accounting entry and the
 * refund can never disagree about what happened.
 */
export const REFUND_REASON_CODES = [
  /** The buyer asked and Monacado agreed. */
  "CUSTOMER_REQUEST",
  /** The item could not be supplied, or was not what was sold. */
  "PRODUCT_FAILURE",
  /** The same purchase was charged more than once. */
  "DUPLICATE_PAYMENT",
  /** Refunded on risk or fraud grounds. */
  "FRAUD_OR_RISK",
  /** Refunded to correct a Monacado error. */
  "OPERATOR_CORRECTION",
  /** Governed, recorded elsewhere, and not one of the above. */
  "OTHER_GOVERNED_REASON",
] as const;
export const RefundReasonCode = z.enum(REFUND_REASON_CODES);
export type RefundReasonCode = z.infer<typeof RefundReasonCode>;

/**
 * The `1.2` accounting reason one refund reason records as.
 *
 * Total, so a refund reason can never fail to produce an accounting reason, and
 * one-way: the accounting vocabulary is coarser because it also has to describe
 * chargebacks, and collapsing into it loses nothing the entry needed.
 */
export function reversalReasonForRefund(
  reason: RefundReasonCode,
): "BUYER_REQUESTED" | "NOT_FULFILLABLE" | "MONACADO_INITIATED" | "CORRECTION" {
  switch (reason) {
    case "CUSTOMER_REQUEST":
      return "BUYER_REQUESTED";
    case "PRODUCT_FAILURE":
      return "NOT_FULFILLABLE";
    case "OPERATOR_CORRECTION":
    case "DUPLICATE_PAYMENT":
      return "CORRECTION";
    case "FRAUD_OR_RISK":
    case "OTHER_GOVERNED_REASON":
      return "MONACADO_INITIATED";
  }
}

// — Who asked —

/**
 * Who caused this refund to be requested.
 *
 * A bounded kind, and an **optional** account reference — a refund raised by an
 * operator names the acting account, one raised by an automated governed process
 * names nobody, and a buyer-initiated refund names the buyer's account only when
 * they had one. **A guest is never fabricated an account to be named by**, which
 * is `0M.9`'s promise and is not weakened here.
 */
export const REFUND_REQUESTOR_KINDS = [
  /** An internal operator acting under an entitlement. */
  "OPERATOR",
  /** The buyer, through a governed self-service path. */
  "BUYER",
  /** A governed automated process, e.g. an unfulfillable-order sweep. */
  "SYSTEM",
] as const;
export const RefundRequestorKind = z.enum(REFUND_REQUESTOR_KINDS);
export type RefundRequestorKind = z.infer<typeof RefundRequestorKind>;

// — Status —

/**
 * Where the **payment refund's provider call** got to.
 *
 * The same five-state shape `1.5`'s `OutboundEmailDelivery` and `1.7`'s
 * `OrderTaxTransaction` use — a claimed state with a lease, bounded attempts, and
 * a terminal pair — deliberately rather than a third convention. `IN_PROGRESS`
 * holds a lock token, so a worker that dies mid-call costs an **attempt** rather
 * than the obligation to refund somebody.
 *
 * `PENDING` is written in the same transaction that records the refund request.
 * That is the property that makes a refund impossible to lose: either Monacado
 * holds a durable record that it owes this buyer their money back, or it never
 * accepted the request at all.
 *
 * Note what is **not** here: a state for "the tax was reversed". That is a
 * different provider, a different call, and an independently durable fact —
 * `OrderTaxReversal` carries it, and `refundLifecycleState` combines them.
 */
export const REFUND_STATUSES = [
  /** Committed with the request; the provider has not been called yet. */
  "PENDING",
  /** Claimed by a worker, with a lease. */
  "IN_PROGRESS",
  /** The provider returned the funds and gave back its reference. */
  "REFUNDED",
  /** A transient failure. `nextAttemptAt` says when to try again. */
  "RETRY_PENDING",
  /** Out of attempts, or a permanent refusal. Needs an operator. */
  "FAILED_PERMANENT",
] as const;
export const RefundStatus = z.enum(REFUND_STATUSES);
export type RefundStatus = z.infer<typeof RefundStatus>;

export const INITIAL_REFUND_STATUS: RefundStatus = "PENDING";

/** Statuses from which another provider attempt is due or possible. */
export const RETRYABLE_REFUND_STATUSES: readonly RefundStatus[] = ["PENDING", "RETRY_PENDING"];

/** Statuses nothing moves out of without an operator. */
export const TERMINAL_REFUND_STATUSES: readonly RefundStatus[] = [
  "REFUNDED",
  "FAILED_PERMANENT",
];

// — Normalized provider outcome —

/**
 * Why a refund attempt failed, in Monacado's words.
 *
 * **No raw provider payload is ever persisted.** A vendor error string can echo
 * the request, and a refund request names a charge that names a buyer. An adapter
 * translates once, at the boundary, into this closed vocabulary; everything above
 * decides from the answer.
 */
export const REFUND_FAILURE_CODES = [
  /** The provider could not be reached, or timed out. */
  "PROVIDER_UNAVAILABLE",
  /** The provider refused the request as malformed or unauthorised. */
  "PROVIDER_REJECTED",
  /** The provider does not know the charge Monacado named. */
  "CHARGE_NOT_FOUND",
  /**
   * The provider says this charge is already refunded.
   *
   * **Permanent, and deliberately not treated as success.** Monacado holds no
   * provider refund reference for a refund it did not observe, so marking it
   * `REFUNDED` would assert evidence that does not exist. Reconciliation is what
   * finds out which refund that was — see `RECONCILE_PROVIDER_REFUND`.
   */
  "ALREADY_REFUNDED",
  /** The amount asked for exceeds what remains on the charge. */
  "AMOUNT_EXCEEDS_CHARGE",
  /** Monacado's own sale-time evidence is missing or self-contradictory. */
  "EVIDENCE_INCONSISTENT",
  /** The payment integration is not configured for this deployment. */
  "PROVIDER_NOT_CONFIGURED",
  /** The provider answered from a mode this deployment does not permit. */
  "PROVIDER_MODE_NOT_PERMITTED",
  /** Anything the adapter could not classify. */
  "UNSPECIFIED_FAILURE",
] as const;
export const RefundFailureCode = z.enum(REFUND_FAILURE_CODES);
export type RefundFailureCode = z.infer<typeof RefundFailureCode>;

export const REFUND_OUTCOME_CLASSES = ["REFUNDED", "TRANSIENT", "PERMANENT"] as const;
export const RefundOutcomeClass = z.enum(REFUND_OUTCOME_CLASSES);
export type RefundOutcomeClass = z.infer<typeof RefundOutcomeClass>;

/**
 * Whether another attempt is worth making.
 *
 * The conservative reading in both directions: an unclassified condition is
 * **transient**, because nobody has proved it cannot succeed; a condition whose
 * cause is inside Monacado's own records or already settled at the provider is
 * **permanent**, because retrying re-sends the same thing.
 */
export function classifyRefundFailure(code: RefundFailureCode): RefundOutcomeClass {
  switch (code) {
    case "ALREADY_REFUNDED":
    case "CHARGE_NOT_FOUND":
    case "AMOUNT_EXCEEDS_CHARGE":
    case "EVIDENCE_INCONSISTENT":
    case "PROVIDER_MODE_NOT_PERMITTED":
      return "PERMANENT";
    default:
      return "TRANSIENT";
  }
}

// — Retry policy —

/**
 * How hard, and how long, Monacado tries to give a buyer their money back.
 *
 * The same shape as `1.7`'s recording policy and a longer tail than `1.5`'s email
 * policy, because the consequence is worse than either. An undelivered receipt is
 * a buyer who has to ask; an unexecuted refund is a buyer who has been charged
 * for something they are owed back, and every hour of that is a chargeback
 * becoming more likely and more expensive.
 *
 * Readable rather than exponential-with-jitter, for the reason `1.5` recorded: a
 * handful of rows does not need load spreading, and a schedule an operator can
 * read off is worth more than one they cannot.
 */
export const REFUND_RETRY_POLICY = {
  /** Provider attempts, including the first. */
  maxAttempts: 8,
  /** Delay before attempt *n+1*, in seconds. */
  backoffSeconds: [30, 120, 600, 1_800, 7_200, 21_600, 43_200],
  /**
   * How long a claim is held before another worker may take the row.
   *
   * Longer than any refund call should take, short enough that a crashed worker
   * does not strand a buyer's money for an hour.
   */
  claimLeaseSeconds: 300,
} as const;

/**
 * When to try again after `attemptCount` failed attempts, or `null` if done.
 *
 * `attemptCount` is the number of attempts **already made**, so the first failure
 * asks for index 0.
 */
export function nextRefundDelaySeconds(attemptCount: number): number | null {
  if (attemptCount >= REFUND_RETRY_POLICY.maxAttempts) return null;
  const index = Math.min(attemptCount - 1, REFUND_RETRY_POLICY.backoffSeconds.length - 1);
  return REFUND_RETRY_POLICY.backoffSeconds[Math.max(0, index)]!;
}

/** The instant of the next attempt, or `null` when the attempts are spent. */
export function nextRefundAttemptAt(input: {
  attemptCount: number;
  failedAt: string;
}): string | null {
  const delay = nextRefundDelaySeconds(input.attemptCount);
  if (delay === null) return null;
  return new Date(new Date(input.failedAt).getTime() + delay * 1_000).toISOString();
}

// — Eligibility —

/**
 * Why a refund request is refused, **before any provider is contacted**.
 *
 * Every one of these is checked against **exact durable sale-time evidence** —
 * the Order's own quote, the bound economic snapshot, the settlement row's
 * provider reference — and never against a recomputation from current policy. A
 * refund computed from today's commercial policy would return a figure the buyer
 * was never charged, and it would look entirely correct.
 */
export const REFUND_REFUSAL_CODES = [
  /** No such Order. */
  "ORDER_NOT_FOUND",
  /** The Order never completed. Nothing was taken, so nothing comes back. */
  "ORDER_NOT_PAID",
  /** A paid Order with no bound economics. Corrupt, and not refundable blind. */
  "ECONOMIC_SNAPSHOT_MISSING",
  /** No settlement row, or no provider charge reference on it. */
  "PROVIDER_PAYMENT_REFERENCE_MISSING",
  /** A refund already exists for this Order. */
  "REFUND_ALREADY_EXISTS",
  /** The sale already carries a `1.2` reversal entry. */
  "SALE_ALREADY_REVERSED",
  /**
   * A payment dispute is open on this sale (Phase 1.11).
   *
   * Refunding while a bank is deciding whether to reverse the same payment is
   * how a buyer ends up made whole twice: Monacado returns the money, the
   * network then takes it as well, and only one of those is expressible as a
   * Monacado reversal entry. The dispute is resolved first, and the refund
   * remains available afterwards if the dispute is won.
   */
  "SALE_DISPUTE_OPEN",
  /**
   * A payment dispute on this sale was lost (Phase 1.11).
   *
   * The funds have already gone back to the buyer through the network. This is
   * distinct from `SALE_ALREADY_REVERSED` — which is what the caller would
   * otherwise be told, since a lost dispute writes a reversal — so that an
   * operator learns the money left by chargeback rather than by refund.
   */
  "SALE_DISPUTE_LOST",

  // — Refund unit —
  /** No line was selected. A refund of nothing is not a refund. */
  "NO_REFUND_LINES_SELECTED",
  /** A selected line is not on this Order. */
  "REFUND_LINE_NOT_FOUND",
  /**
   * An arbitrary monetary amount was asked for on a line.
   *
   * The unit is a **whole line**; selecting several is fine, splitting one is
   * not. See `PARTIAL_LINE_REFUND_DEFERRAL`.
   */
  "PARTIAL_LINE_REFUND_NOT_SUPPORTED",
  /**
   * A subset of lines was selected and the current Order model cannot express
   * it — no `OrderLine` table, `TransactionReversal` has only `FULL`, and there
   * is no line-level provider tax evidence.
   *
   * **Fails closed rather than approximating.** Unreachable while an Order binds
   * one Listing; present so a basket phase meets a refusal rather than a silent
   * rounding. See `SINGLE_LINE_EXECUTION_LIMIT`.
   */
  "SUBSET_LINE_REFUND_NOT_YET_EXECUTABLE",

  // — Seller policy —
  /** The Order carries no seller refund-policy binding. */
  "SELLER_REFUND_POLICY_NOT_BOUND",
  /** The bound version cannot be read, or its content has moved. */
  "SELLER_REFUND_POLICY_UNREADABLE",
  /** The bound version declares that this seller does not refund. */
  "SELLER_REFUND_POLICY_FORBIDS_REFUND",
  /** The bound version's declared window has closed. */
  "SELLER_REFUND_WINDOW_EXPIRED",

  // — Amounts —
  /**
   * Shipping would have to be split across a partially-refunded basket, and no
   * governed allocation rule exists. See `SHIPPING_ALLOCATION_SEAM`.
   */
  "SHIPPING_ALLOCATION_NOT_GOVERNED",
  /**
   * The Order carries a non-zero other-pass-through amount whose refund
   * treatment nobody has ruled on.
   *
   * **Refused rather than silently kept.** Quietly retaining a buyer's money
   * because no rule covers it is the worst of the available answers.
   */
  "PASS_THROUGH_REFUND_TREATMENT_NOT_GOVERNED",
  /** The derived refund total does not reconcile to the selected lines. */
  "REFUND_AMOUNT_DOES_NOT_RECONCILE",
  /** Two authoritative records disagree about the sale's currency. */
  "CURRENCY_MISMATCH",
  /** Some other conflicting refund or reversal state exists. */
  "CONFLICTING_REFUND_STATE",
] as const;
export const RefundRefusalCode = z.enum(REFUND_REFUSAL_CODES);
export type RefundRefusalCode = z.infer<typeof RefundRefusalCode>;

/**
 * What the buyer is owed back, derived from the selected lines and the policy.
 *
 * **There is no permanent "must equal the whole buyer charge" invariant**, and
 * removing it is the point of this function. The amount is composed from four
 * governed parts:
 *
 * ```
 *   Σ selected line retail
 * + Σ tax attributable to those lines        ← sale-time evidence, never recomputed
 * + shipping IF the bound seller policy says so
 * + other pass-through ONLY where its treatment is authoritative  (today: only 0)
 * ```
 *
 * For today's one-line Order this still lands on the whole Order charge, or the
 * whole charge **minus non-refundable shipping** — which is the visible proof
 * that the invariant is gone.
 *
 * **The caller names no figure.** It selects lines; every number here comes from
 * durable sale-time facts plus the bound policy. That is what makes "a caller
 * cannot choose an arbitrary amount" structural rather than validated.
 *
 * Returns a refusal instead of a number where the answer is not governed, so a
 * caller cannot receive a plausible total for an ungoverned case.
 */
export type RefundAmountDerivation =
  | {
      derived: true;
      /** What the provider will be asked to return. */
      totalMinorUnits: number;
      /** The parts, so a reconciler can check the sum rather than trust it. */
      linesRetailMinorUnits: number;
      linesTaxMinorUnits: number;
      shippingMinorUnits: number;
      /** Whether the bound policy made shipping refundable on this refund. */
      shippingRefundable: boolean;
      /** True when the selection covers every line on the Order. */
      coversWholeOrder: boolean;
    }
  | { derived: false; refusal: RefundRefusalCode };

export function deriveRefundAmount(input: {
  /** The lines selected, each refunded in full. */
  selectedLines: readonly RefundableOrderLine[];
  /** How many lines the Order has in total. */
  orderLineCount: number;
  /** The Order's shipping charge, as quoted. One charge, one carriage. */
  quotedShippingAmountMinorUnits: number;
  /** The Order's other pass-through, as quoted. */
  quotedOtherPassThroughAmountMinorUnits: number;
  /** The bound seller policy's shipping rule, and this refund's reason. */
  shippingRefundability: ShippingRefundability;
  reasonCode: RefundReasonCode;
}): RefundAmountDerivation {
  if (input.selectedLines.length === 0) {
    return { derived: false, refusal: "NO_REFUND_LINES_SELECTED" };
  }

  const coversWholeOrder = input.selectedLines.length === input.orderLineCount;

  const linesRetailMinorUnits = input.selectedLines.reduce(
    (sum, line) => sum + line.commercialRetailAmountMinorUnits,
    0,
  );
  const linesTaxMinorUnits = input.selectedLines.reduce(
    (sum, line) => sum + line.taxAmountMinorUnits,
    0,
  );

  /* — Shipping — governed by the seller's bound policy, never by arithmetic. */
  const shippingRefundable = shippingIsRefundable({
    shippingRefundability: input.shippingRefundability,
    reasonCode: input.reasonCode,
  });

  let shippingMinorUnits = 0;
  if (shippingRefundable && input.quotedShippingAmountMinorUnits > 0) {
    if (!coversWholeOrder) {
      /* FAIL CLOSED. Which part of one carriage belonged to the returned lines
         is a commercial ruling, not arithmetic — and proration is refused by
         name rather than chosen by default. */
      return { derived: false, refusal: "SHIPPING_ALLOCATION_NOT_GOVERNED" };
    }
    shippingMinorUnits = input.quotedShippingAmountMinorUnits;
  }

  /* — Other pass-through — no governed refund treatment exists.
   *
   * Zero is unambiguous and refunds to zero. Anything else is a buyer's money
   * whose treatment nobody has ruled on, and quietly keeping it would be worse
   * than refusing. */
  if (input.quotedOtherPassThroughAmountMinorUnits !== 0) {
    return { derived: false, refusal: "PASS_THROUGH_REFUND_TREATMENT_NOT_GOVERNED" };
  }

  return {
    derived: true,
    totalMinorUnits: linesRetailMinorUnits + linesTaxMinorUnits + shippingMinorUnits,
    linesRetailMinorUnits,
    linesTaxMinorUnits,
    shippingMinorUnits,
    shippingRefundable,
    coversWholeOrder,
  };
}

/** The result of asking whether one Order may be refunded. Findings, not a repair. */
export const RefundEligibility = z.strictObject({
  orderId: z.string().min(1).max(191),
  eligible: z.boolean(),
  /** Every refusal, not the first — the same rule the risk gate follows. */
  refusals: z.array(RefundRefusalCode),

  /** Every line on the Order, with its sale-time economics. */
  orderLines: z.array(RefundableOrderLine),
  /** The lines this evaluation selected. */
  selectedLineRefs: z.array(OrderLineRef),
  /** True when the selection covers every line. */
  coversWholeOrder: z.boolean(),

  /** What the selected lines would return, when the answer is governed. */
  refundableAmountMinorUnits: Amount.nullable(),
  /** The parts of it, so nothing has to trust the total. */
  linesRetailMinorUnits: Amount.nullable(),
  linesTaxMinorUnits: Amount.nullable(),
  refundableShippingMinorUnits: Amount.nullable(),
  /** Whether the bound seller policy makes shipping refundable here. */
  shippingRefundable: z.boolean().nullable(),

  /** The exact seller policy version that governed the purchase. */
  sellerRefundPolicyId: z.string().min(1).max(191).nullable(),
  sellerRefundPolicyVersion: z.string().min(1).max(64).nullable(),

  currency: CurrencyCode.nullable(),
  /** The exact charge a refund would name. `null` when there is none. */
  providerTransactionRef: ProviderTransactionRef.nullable(),
  provider: PaymentProvider.nullable(),
  /** The sale's economics, so a caller need not re-read them. `null` if absent. */
  snapshotId: z.string().min(1).max(191).nullable(),
  evaluatedAt: z.iso.datetime(),
});
export type RefundEligibility = z.infer<typeof RefundEligibility>;

// — The record —

/**
 * One Order's refund.
 *
 * Note what has no field, and could not be given one without changing this
 * `strictObject`: a buyer name, email, or address; a card or bank detail; a raw
 * provider payload; a support narrative; a partial-refund running total. Each
 * either lives in exactly one authoritative record already or was refused on
 * purpose — `NEVER_ON_ORDER_REFUND` names them.
 */
export const OrderRefundRecord = z.strictObject({
  refundId: OrderRefundId,
  /** One refund per Order in this phase. Enforced by a unique index. */
  orderId: z.string().min(1).max(191),
  /** The sale's immutable economics. Bound, never recomputed. */
  snapshotId: z.string().min(1).max(191),

  scope: RefundScope,
  reasonCode: RefundReasonCode,

  /**
   * The lines this refund returns, each in full.
   *
   * At least one. Persisted as its own rows rather than inferred from the Order,
   * so "which lines came back" stays answerable after the multi-line model
   * arrives and an Order stops meaning one line.
   */
  lineRefs: z.array(OrderLineRef).min(1),
  /** True when the selection covered every line the Order had. */
  coversWholeOrder: z.boolean(),

  /**
   * The EXACT seller refund-policy version that governed this purchase.
   *
   * Bound at checkout and copied here at request time, never resolved live: the
   * seller's *current* policy is not authority over a historical sale, and a
   * refund that read one would apply terms the buyer was never shown.
   */
  sellerRefundPolicyId: z.string().min(1).max(191),
  sellerRefundPolicyVersion: z.string().min(1).max(64),

  // — Who asked —
  requestorKind: RefundRequestorKind,
  /**
   * The acting account, where one exists. `null` for `SYSTEM`, and `null` for a
   * guest buyer — no account is fabricated to fill it.
   */
  requestedByAccountId: z.string().min(1).max(191).nullable(),
  requestedAt: z.iso.datetime(),

  // — Provider identity —
  provider: PaymentProvider,
  /** `TEST` | `LIVE`, as the deployment's payment configuration states it. */
  providerMode: z.enum(["TEST", "LIVE"]),
  /**
   * The **original** charge this reverses, copied from the settlement row at
   * request time rather than joined at use time — so the pairing a refund rests
   * on survives independently of either row moving.
   */
  providerTransactionRef: ProviderTransactionRef,
  /** The provider's refund. `null` until the provider call succeeds. */
  providerRefundRef: ProviderTransactionRef.nullable(),
  /** When the provider created its refund. `null` until then. */
  providerRefundCreatedAt: z.iso.datetime().nullable(),

  // — Immutable request-time facts —
  currency: CurrencyCode,
  /**
   * What the provider is asked to return, derived by `deriveRefundAmount` from
   * the selected lines plus the bound policy. **Never a caller's figure**, and
   * never asserted to equal the whole Order charge.
   */
  amountMinorUnits: Amount,
  /** The parts, so a reconciler checks the sum rather than trusting it. */
  linesRetailMinorUnits: Amount,
  linesTaxMinorUnits: Amount,
  /** Shipping actually returned. Zero where the bound policy withholds it. */
  refundedShippingMinorUnits: Amount,

  /** When Monacado committed the obligation to refund. */
  recordedAt: z.iso.datetime(),

  // — Lifecycle —
  status: RefundStatus,
  attemptCount: z.number().int().min(0).max(REFUND_RETRY_POLICY.maxAttempts),
  nextAttemptAt: z.iso.datetime().nullable(),
  lastFailureCode: RefundFailureCode.nullable(),
  lastFailureClass: RefundOutcomeClass.nullable(),
  /** When the provider call finally succeeded or was abandoned. */
  finalizedAt: z.iso.datetime().nullable(),
  /** How many times an operator has explicitly requeued this row. */
  requeueCount: z.number().int().min(0),
  lastRequeuedAt: z.iso.datetime().nullable(),
  /**
   * The `1.2` accounting entry this refund produced. `null` until the provider
   * confirms, because an entry written before the money moved would assert a
   * reversal that had not happened.
   */
  reversalId: z.string().min(1).max(191).nullable(),
  updatedAt: z.iso.datetime(),
});
export type OrderRefundRecord = z.infer<typeof OrderRefundRecord>;

/**
 * The request-time facts written once and never rewritten.
 *
 * Not a convention — a checked one. A retry advances the status, an operator
 * requeue resets the schedule, and the provider's own reference arrives on
 * success; none of them may touch anything on this list, because the whole value
 * of the record is that it still says what was asked for and against which
 * original charge. A test asserts they are unchanged across a retry.
 */
export const IMMUTABLE_REFUND_FIELDS = [
  "orderId",
  "snapshotId",
  "scope",
  "reasonCode",
  "lineRefs",
  "coversWholeOrder",
  "sellerRefundPolicyId",
  "sellerRefundPolicyVersion",
  "requestorKind",
  "requestedByAccountId",
  "requestedAt",
  "provider",
  "providerMode",
  "providerTransactionRef",
  "currency",
  "amountMinorUnits",
  "linesRetailMinorUnits",
  "linesTaxMinorUnits",
  "refundedShippingMinorUnits",
  "recordedAt",
] as const;

/**
 * Named as never admissible on a refund, and refused by the `strictObject` above.
 *
 * Each already lives in exactly one authoritative record, or was refused on
 * purpose. The partial-refund fields are on the list because they are precisely
 * the columns that would appear the day somebody implemented partial refunds
 * without deciding the allocation rules.
 */
export const NEVER_ON_ORDER_REFUND = [
  // buyer identity and addresses — OrderBuyerSnapshot holds these, once
  "buyerName",
  "buyerEmail",
  "billingAddress",
  "shippingAddress",
  "postalCode",
  "ipAddress",
  // payment credentials — never anywhere in Monacado
  "cardNumber",
  "cardLast4",
  "paymentMethodPayload",
  // provider payloads and prose
  "rawProviderResponse",
  "providerPayload",
  "providerMessage",
  "reasonText",
  "supportNote",
  "disputeNarrative",
  // sub-line and allocation machinery — refused, see PARTIAL_LINE_REFUND_DEFERRAL
  // and SHIPPING_ALLOCATION_SEAM. Selecting whole lines needs none of it.
  "remainingRefundableMinorUnits",
  "refundedToDateMinorUnits",
  "allocationRule",
  "shippingProrationRule",
  "requestedAmountMinorUnits",
  // the seller's policy PROSE — the version is authoritative, and a copy here
  // would be a second answer able to disagree with the version the buyer saw
  "sellerRefundPolicyText",
  "refundPolicyProse",
  // credentials
  "apiKey",
  "accountId",
] as const;

// — Coherence —

/**
 * A refunded row agrees with itself.
 *
 * Checked before a row is marked `REFUNDED`, so a success with no provider
 * reference — which would be a refund Monacado cannot prove happened — is caught
 * at the boundary rather than discovered during a chargeback.
 */
export function refundIsCoherent(record: OrderRefundRecord): boolean {
  if (record.status !== "REFUNDED") return true;
  if (record.providerRefundRef === null) return false;
  if (record.providerRefundCreatedAt === null) return false;
  return record.providerRefundRef !== record.providerTransactionRef;
}

// — Composite lifecycle —

/**
 * The whole post-sale correction lifecycle, as one word an operator can read.
 *
 * **Derived from the two durable records, never stored.** A stored composite
 * would be a third answer able to disagree with the two facts it summarises, and
 * the disagreement would appear exactly when one of the two provider calls had
 * failed — which is the case it exists to describe.
 *
 * ```
 * PENDING → REFUND_IN_PROGRESS → REFUNDED → TAX_REVERSAL_PENDING
 *                                         → TAX_REVERSAL_IN_PROGRESS → COMPLETED
 * ```
 *
 * `MANUAL_REMEDIATION_REQUIRED` is the state this vocabulary exists for: the
 * payment refund succeeded and the tax reversal is permanently failed. The buyer
 * has their money, the sale's tax stands reported as though it had not been
 * returned, and **no timer will fix it**. Naming that state is the difference
 * between an operator finding it and a filing containing it.
 */
export const REFUND_LIFECYCLE_STATES = [
  "PENDING",
  "REFUND_IN_PROGRESS",
  "REFUND_RETRY_PENDING",
  "REFUND_FAILED_PERMANENT",
  /** Funds returned; this sale's tax needs no provider reversal, or none yet. */
  "REFUNDED",
  "TAX_REVERSAL_PENDING",
  "TAX_REVERSAL_IN_PROGRESS",
  /** Both provider operations are done. The only fully settled state. */
  "COMPLETED",
  /** Funds returned and the tax reversal is permanently failed. */
  "MANUAL_REMEDIATION_REQUIRED",
] as const;
export const RefundLifecycleState = z.enum(REFUND_LIFECYCLE_STATES);
export type RefundLifecycleState = z.infer<typeof RefundLifecycleState>;

/**
 * Combine the two independently durable facts into the one state to render.
 *
 * Total, pure, and the single implementation — so the reconciler, the operator
 * command, the readiness check, and a test all derive the same answer from the
 * same inputs rather than four places agreeing by accident.
 *
 * `taxReversalStatus` is `null` when this sale has **no** tax reversal record,
 * which happens for exactly one legitimate reason: the Order carries no recorded
 * provider Tax Transaction to reverse. A zero-*amount* tax transaction is still
 * reversed — see `requiresTaxReversal` — so `null` never means "the tax was
 * zero".
 */
export function refundLifecycleState(input: {
  refundStatus: RefundStatus;
  taxReversalStatus: TaxReversalStatus | null;
}): RefundLifecycleState {
  switch (input.refundStatus) {
    case "PENDING":
      return "PENDING";
    case "IN_PROGRESS":
      return "REFUND_IN_PROGRESS";
    case "RETRY_PENDING":
      return "REFUND_RETRY_PENDING";
    case "FAILED_PERMANENT":
      return "REFUND_FAILED_PERMANENT";
    case "REFUNDED":
      break;
  }

  switch (input.taxReversalStatus) {
    case null:
      /* Money returned and nothing owed to a tax provider — either no Tax
         Transaction was ever recorded for this sale, or reconciliation has
         already named that gap. Deliberately NOT `COMPLETED`: claiming a tax
         lifecycle completed when none ran would be the exact false assurance
         `1.7` refused when it declined to skip zero-tax reporting. */
      return "REFUNDED";
    case "PENDING":
      return "TAX_REVERSAL_PENDING";
    case "IN_PROGRESS":
      return "TAX_REVERSAL_IN_PROGRESS";
    case "RETRY_PENDING":
      return "TAX_REVERSAL_PENDING";
    case "REVERSED":
      return "COMPLETED";
    case "FAILED_PERMANENT":
      /* The one genuinely inconsistent resting state, and the reason this
         vocabulary is not two booleans. */
      return "MANUAL_REMEDIATION_REQUIRED";
  }
}

/** Lifecycle states that mean somebody has to do something. */
export const REFUND_LIFECYCLE_STATES_NEEDING_OPERATOR: readonly RefundLifecycleState[] = [
  "REFUND_FAILED_PERMANENT",
  "MANUAL_REMEDIATION_REQUIRED",
];

/**
 * Whether a refunded sale still owes a provider tax reversal. **It always does,
 * when a Tax Transaction was recorded.**
 *
 * Stated as a function rather than left implicit because the tempting
 * optimisation — skip the reversal when the tax amount is zero — is wrong in the
 * same way, and for the same reason, that `requiresProviderTaxTransaction`
 * refuses to skip reporting a zero-tax sale. A jurisdiction where Monacado
 * collected nothing and then refunded the sale is still a **return line**, and a
 * reversal the provider never saw cannot appear on one.
 */
export function requiresTaxReversal(input: {
  hasRecordedProviderTaxTransaction: boolean;
  taxAmountMinorUnits: number;
}): boolean {
  void input.taxAmountMinorUnits;
  return input.hasRecordedProviderTaxTransaction;
}
