/**
 * Buyer checkout, Order, and post-sale errors (Phase 0M.9).
 *
 * Four rules, three inherited and one this phase adds:
 *
 *   1. **No error carries private data**, and none carries a monetary value. An
 *      amount in an error message puts a party's economics into a log nobody
 *      decided to publish them in.
 *
 *   2. **Internal causes are non-enumerable**, via the shared
 *      `attachInternalCause` helper, so `JSON.stringify(error)` cannot leak a
 *      driver message or a connection string.
 *
 *   3. **No error carries a provider transaction reference**, for the reason
 *      `0M.T1` records: it is external evidence tying Monacado's record to a
 *      payment, and a reference in an error message is a reference in a log
 *      aggregator.
 *
 *   4. **No error carries buyer identity or a guest claim code.** The claim code
 *      is a credential — the single secret standing between a stranger and a
 *      guest's purchase history — and an error that echoed a rejected one would
 *      put it in every log that captured the failure.
 */

import { attachInternalCause } from "../product/error-cause";

export type OrderErrorCode =
  | "INVALID_ORDER_INPUT"
  | "ORDER_NOT_FOUND"
  | "LISTING_NOT_PURCHASABLE"
  | "LISTING_NOT_FOUND"
  | "ORDER_CURRENCY_MISMATCH"
  | "NO_EFFECTIVE_COMMERCIAL_POLICY"
  | "MARKETPLACE_POLICY_UNAVAILABLE"
  | "SELLER_SUPPORT_CONTACT_UNAVAILABLE"
  | "SELLER_REFUND_POLICY_UNAVAILABLE"
  | "BUYER_ACCOUNT_NOT_FOUND"
  | "SELLER_NOT_RESOLVABLE"
  | "INVALID_ORDER_TRANSITION"
  | "ORDER_ALREADY_PAID"
  | "PAYMENT_RESULT_CONFLICT"
  | "QUOTE_SNAPSHOT_MISMATCH"
  | "ORDER_NOT_COMPLETED"
  | "REVIEW_NOT_ELIGIBLE"
  | "GUEST_CLAIM_REFUSED"
  | "NOT_A_GUEST_ORDER"
  | "INVALID_PROCEEDS_OBLIGATION_TRANSITION"
  | "PROCEEDS_OBLIGATION_NOT_FOUND"
  | "PROCEEDS_PAYOUT_HELD"
  | "BUYER_SNAPSHOT_REFUSED"
  | "CORRUPT_ORDER_RECORD"
  | "ORDER_PERSISTENCE_FAILURE";

export class OrderServiceError extends Error {
  readonly code: OrderErrorCode;
  /** Retained for diagnostics; NON-ENUMERABLE (see product/error-cause). */
  declare readonly internalCause?: unknown;
  constructor(code: OrderErrorCode, message: string, internalCause?: unknown) {
    super(message);
    this.name = "OrderServiceError";
    this.code = code;
    attachInternalCause(this, internalCause);
  }
}

/** Malformed input. `fields` names paths only — never the rejected value. */
export class InvalidOrderInputError extends OrderServiceError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super("INVALID_ORDER_INPUT", "Invalid order input");
    this.name = "InvalidOrderInputError";
    this.fields = fields;
  }
}

export class OrderNotFoundError extends OrderServiceError {
  constructor() {
    super("ORDER_NOT_FOUND", "No order exists for that identifier");
    this.name = "OrderNotFoundError";
  }
}

export class ListingNotFoundError extends OrderServiceError {
  constructor(cause?: unknown) {
    super("LISTING_NOT_FOUND", "No listing exists for that identifier", cause);
    this.name = "ListingNotFoundError";
  }
}

/**
 * The Listing may not be sold right now.
 *
 * `blockingReasons` is `0M.4A`'s own bounded `LISTING_BLOCKING_REASONS`
 * vocabulary, surfaced unchanged rather than rewritten — every member is a
 * classification a route may safely show a buyer, and reporting all of them
 * rather than the first is the committed contract's behaviour.
 */
export class ListingNotPurchasableError extends OrderServiceError {
  readonly blockingReasons: string[];
  constructor(blockingReasons: string[]) {
    super("LISTING_NOT_PURCHASABLE", "That listing is not available for purchase");
    this.name = "ListingNotPurchasableError";
    this.blockingReasons = blockingReasons;
  }
}

/**
 * The requested currency, the Listing's retail currency, and the effective
 * policy's currency do not all agree.
 *
 * Refused rather than coerced, exactly as `0M.4A` and `0M.T1` refuse it: a silent
 * conversion produces a plausible price nobody agreed to. `field` names which
 * comparison failed and carries no currency value.
 */
export class OrderCurrencyMismatchError extends OrderServiceError {
  readonly field: string;
  constructor(field: string) {
    super("ORDER_CURRENCY_MISMATCH", "The order currencies do not agree");
    this.name = "OrderCurrencyMismatchError";
    this.field = field;
  }
}

/**
 * No commercial policy version is currently effective.
 *
 * A refusal rather than a fallback rate — the same rule `0M.R1` enforces, and for
 * the same reason: a default here would be exactly the hard-coded economics
 * `0M.4A` forbids.
 */
export class NoEffectiveCommercialPolicyError extends OrderServiceError {
  constructor(cause?: unknown) {
    super(
      "NO_EFFECTIVE_COMMERCIAL_POLICY",
      "No commercial policy is currently effective; no sale can be priced",
      cause,
    );
    this.name = "NoEffectiveCommercialPolicyError";
  }
}

/**
 * No ACTIVE Marketplace Policy governs new transactions (Phase 1.3 correction).
 *
 * The same shape of refusal as `NoEffectiveCommercialPolicyError`, one level up:
 * that one says the sale cannot be **priced**, this one says it cannot be
 * **governed**. Monacado is merchant of record; selling under terms it cannot
 * name afterwards is worse than not selling, because the Order would be an
 * unanswerable question rather than a missing one.
 *
 * An **operator configuration failure, not a buyer fault**. Nothing the buyer
 * sent is wrong, and no Order, payment, or evidence exists after it.
 */
export class MarketplacePolicyUnavailableError extends OrderServiceError {
  constructor(cause?: unknown) {
    super(
      "MARKETPLACE_POLICY_UNAVAILABLE",
      "No marketplace policy is currently active; no sale can be governed",
      cause,
    );
    this.name = "MarketplacePolicyUnavailableError";
  }
}

/**
 * The seller has no usable support contact right now (Phase 1.3 correction).
 *
 * Activation checks this once; a mailbox can stop working the day after. Selling
 * on behalf of a seller nobody can reach produces a buyer with a problem and no
 * destination for it, so new sales stop until a verified address is restored.
 *
 * Carries **no address and no reason detail** — an error that echoed which
 * mailbox failed would put a seller's private operational address into every log
 * that captured the refusal.
 */
export class SellerSupportContactUnavailableError extends OrderServiceError {
  constructor(cause?: unknown) {
    super(
      "SELLER_SUPPORT_CONTACT_UNAVAILABLE",
      "This seller has no verified support contact; no new sale can be placed",
      cause,
    );
    this.name = "SellerSupportContactUnavailableError";
  }
}

/**
 * The seller has no ACTIVE refund policy version (Phase 1.9 correction).
 *
 * A sale is refund-governed, so checkout binds the exact version in force. With
 * none, the sale is refused on the identical reasoning that refuses a sale with
 * no active marketplace policy: a buyer must see the applicable returns terms
 * before purchasing and on the receipt afterwards, and an Order that bound
 * nothing can supply neither.
 *
 * Carries no policy identity, no seller identity, and no prose — a checkout
 * refusal is rendered to a buyer.
 */
export class SellerRefundPolicyUnavailableError extends OrderServiceError {
  constructor(cause?: unknown) {
    super(
      "SELLER_REFUND_POLICY_UNAVAILABLE",
      "This seller has no active refund policy; no new sale can be placed",
      cause,
    );
    this.name = "SellerRefundPolicyUnavailableError";
  }
}

export class BuyerAccountNotFoundError extends OrderServiceError {
  constructor(cause?: unknown) {
    super("BUYER_ACCOUNT_NOT_FOUND", "No account exists for that buyer", cause);
    this.name = "BuyerAccountNotFoundError";
  }
}

/**
 * The party owed seller proceeds could not be determined.
 *
 * For a promoted Listing the seller is the **Offer's** seller, not the Listing's
 * controller. Raised rather than defaulting to the controller: paying the
 * promoter the seller's proceeds is the single worst mistake this phase could
 * make silently.
 */
export class SellerNotResolvableError extends OrderServiceError {
  constructor(cause?: unknown) {
    super(
      "SELLER_NOT_RESOLVABLE",
      "The party owed seller proceeds could not be determined for this listing",
      cause,
    );
    this.name = "SellerNotResolvableError";
  }
}

export class InvalidOrderTransitionError extends OrderServiceError {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) {
    super("INVALID_ORDER_TRANSITION", "That order state change is not permitted");
    this.name = "InvalidOrderTransitionError";
    this.from = from;
    this.to = to;
  }
}

/**
 * A payment success replayed against an Order that is already `PAID`.
 *
 * Distinct from `PaymentResultConflictError` and deliberately **not an error the
 * caller must handle**: the service returns the existing sale instead of raising
 * this when the provider reference matches. It exists for the case a caller asks
 * for the transition explicitly.
 */
export class OrderAlreadyPaidError extends OrderServiceError {
  constructor() {
    super("ORDER_ALREADY_PAID", "That order has already been paid");
    this.name = "OrderAlreadyPaidError";
  }
}

/**
 * A second, *different* payment result arrived for one Order.
 *
 * The dangerous case, and the reason replay is not blanket-idempotent: a repeat of
 * the same provider transaction is a retry, but a **different** provider
 * transaction against an already-paid Order means the buyer may have been charged
 * twice. Recording it as an ordinary replay would bury that; this refuses so a
 * human sees it.
 */
export class PaymentResultConflictError extends OrderServiceError {
  constructor() {
    super(
      "PAYMENT_RESULT_CONFLICT",
      "A different payment result is already recorded for this order",
    );
    this.name = "PaymentResultConflictError";
  }
}

/**
 * The Order's quote and the computed economic snapshot disagree.
 *
 * The check that makes the overlap between the two records safe. The Order says
 * what the buyer was quoted; the snapshot says what the sale's economics were. If
 * the Listing was repriced between placement and payment, or a caller reached the
 * write path with a stale quote, the amounts diverge — and Monacado would be
 * recording a sale for one figure while having charged another. Refused before
 * anything is written.
 */
export class QuoteSnapshotMismatchError extends OrderServiceError {
  readonly fields: string[];
  constructor(fields: string[]) {
    super(
      "QUOTE_SNAPSHOT_MISMATCH",
      "The order quote does not match the computed sale economics",
    );
    this.name = "QuoteSnapshotMismatchError";
    this.fields = fields;
  }
}

export class OrderNotCompletedError extends OrderServiceError {
  constructor() {
    super("ORDER_NOT_COMPLETED", "That order is not a completed sale");
    this.name = "OrderNotCompletedError";
  }
}

/**
 * The purchase does not (or no longer) licenses this review.
 *
 * `blockers` is the bounded `REVIEW_ELIGIBILITY_BLOCKERS` vocabulary. It judges
 * the **purchase** only; whether the *subject* may submit is
 * `canSubmitProductReview`'s question and is not re-decided here.
 */
export class ReviewNotEligibleError extends OrderServiceError {
  readonly blockers: string[];
  constructor(blockers: string[]) {
    super("REVIEW_NOT_ELIGIBLE", "That purchase does not authorize this review");
    this.name = "ReviewNotEligibleError";
    this.blockers = blockers;
  }
}

/**
 * A guest claim was refused.
 *
 * Deliberately **one error for every cause** — wrong code, already claimed, no
 * such order. Distinguishing them would turn this into an oracle: a caller could
 * learn which order ids exist and which codes are close, by reading the refusal.
 * The code itself never appears in the message (rule 4).
 */
export class GuestClaimRefusedError extends OrderServiceError {
  constructor() {
    super("GUEST_CLAIM_REFUSED", "That purchase could not be claimed");
    this.name = "GuestClaimRefusedError";
  }
}

export class NotAGuestOrderError extends OrderServiceError {
  constructor() {
    super("NOT_A_GUEST_ORDER", "That order was not placed as a guest purchase");
    this.name = "NotAGuestOrderError";
  }
}

export class InvalidProceedsObligationTransitionError extends OrderServiceError {
  readonly from: string;
  readonly to: string;
  constructor(from: string, to: string) {
    super(
      "INVALID_PROCEEDS_OBLIGATION_TRANSITION",
      "That proceeds obligation state change is not permitted",
    );
    this.name = "InvalidProceedsObligationTransitionError";
    this.from = from;
    this.to = to;
  }
}

export class ProceedsObligationNotFoundError extends OrderServiceError {
  constructor() {
    super("PROCEEDS_OBLIGATION_NOT_FOUND", "No proceeds obligation exists for that identifier");
    this.name = "ProceedsObligationNotFoundError";
  }
}

export class CorruptOrderRecordError extends OrderServiceError {
  readonly fields: string[];
  constructor(fields: string[], cause?: unknown) {
    super("CORRUPT_ORDER_RECORD", "A stored order record failed validation", cause);
    this.name = "CorruptOrderRecordError";
    this.fields = fields;
  }
}

export class OrderPersistenceFailureError extends OrderServiceError {
  readonly stage: string;
  constructor(stage: string, cause?: unknown) {
    super("ORDER_PERSISTENCE_FAILURE", "An order persistence operation failed", cause);
    this.name = "OrderPersistenceFailureError";
    this.stage = stage;
  }
}

/**
 * A proceeds obligation may not become payout-eligible (Phase 1.2).
 *
 * Distinct from `InvalidProceedsObligationTransitionError`, and the distinction
 * matters operationally: an invalid transition means the claim is in the wrong
 * *state*, while this means the claim is in the right state and something else is
 * **holding** it. One is a caller bug; the other is a governed decision an
 * operator can lift.
 *
 * `holdReason` is a bounded code, never free text — safe to log and safe to
 * surface, on the same terms as every other reason vocabulary here.
 */
export type ProceedsPayoutHoldReason =
  | "PARTICIPANT_PAYOUT_RESTRICTED"
  | "SALE_REVERSED"
  /**
   * A payment dispute is open on the sale this claim arises from (Phase 1.11).
   *
   * Distinct from `SALE_REVERSED`, and deliberately so: a reversed sale is
   * decided and the money is gone, whereas a disputed sale may still be won, at
   * which point the claim becomes payable again on its ordinary terms. An
   * operator told "reversed" about a dispute that is still open would conclude
   * a payout was permanently lost when it is merely held.
   */
  | "SALE_DISPUTED";

export class ProceedsPayoutHeldError extends OrderServiceError {
  readonly obligationId: string;
  readonly holdReason: ProceedsPayoutHoldReason;
  constructor(
    obligationId: string,
    holdReason: ProceedsPayoutHoldReason,
  ) {
    super("PROCEEDS_PAYOUT_HELD", "This claim may not become payout-eligible");
    this.name = "ProceedsPayoutHeldError";
    this.obligationId = obligationId;
    this.holdReason = holdReason;
  }
}
