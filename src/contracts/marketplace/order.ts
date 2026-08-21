/**
 * Buyer Order (Phase 0M.9).
 *
 * The authoritative record of **one buyer's purchase of one Listing**: who
 * bought, what they were quoted, and where the payment got to. This is the first
 * phase that creates an actual commercial transaction.
 *
 * Seven properties shape everything below:
 *
 *   1. **An Order is not an economic snapshot, and holds none of its facts.**
 *      What the sale *earned each party* — Monacado's retention, the acquisition
 *      amount, seller proceeds, the promoter's spread and net — lives on
 *      `TransactionEconomicSnapshot` (`0M.T1`) and nowhere else. An Order records
 *      the **quote**: what the buyer was told they would be charged, which must
 *      exist *before* any payment runs and therefore before any snapshot can. The
 *      two are bound one-to-one when the sale completes, and the quote is checked
 *      equal to the snapshot at that moment.
 *
 *   2. **Guest checkout is first-class and creates no Account.** The thesis makes
 *      it so, and `0M.1` already models `GUEST_BUYER` as a real submitter kind.
 *      A guest Order has **no field** for an account and no fabricated
 *      participant — not a null-object account, but nowhere to put one.
 *
 *   3. **No buyer personal data.** There is no field for an email address, a
 *      name, a postal address, an IP address, a card detail, or a device. A guest
 *      is bound to their purchase by a **claim-code digest** and nothing else, on
 *      the same one-way-digest terms as a session token: the raw code is returned
 *      once and never stored. Buyer identity is not published by default, and the
 *      cheapest way to keep a promise about data is to have no column for it.
 *
 *   4. **The binding is exact.** An Order names one
 *      `(listingSourceRecordId, listingSourceRecordVersion)` and one
 *      `(policyId, policyVersion)` — the same composite keys `0M.7` and `0M.R1`
 *      established, so the snapshot created from it binds the identical versions
 *      and a later reprice or rate change moves nothing.
 *
 *   5. **The lifecycle is the payment's, not the money's.** Four states, and no
 *      more. Where the *funds* got to — captured, settled, reversed — is
 *      `0M.T1`'s settlement record, deliberately not restated here: two lifecycles
 *      over one sale would be two answers to one question.
 *
 *   6. **The buyer's total is derived, never stored.** The same rule `0M.T1`
 *      applies to its own pass-through amounts, for the same reason.
 *
 *   7. **No refund, chargeback, or payout concept.** `0M.T2` owns reversal
 *      accounting; a payout is an execution, and this phase records only what is
 *      owed.
 *
 * Pure data and pure decisions. No database, clock, environment read,
 * randomness, or network. Not exported through the browser-facing barrel.
 */

import { z } from "zod";
import { AccountId } from "../account/account";
import {
  COMMERCIAL_POLICY_ID_RE,
  INTERNAL_LISTING_ID_RE,
  INTERNAL_STOREFRONT_ID_RE,
  MARKETPLACE_PARTICIPANT_ID_RE,
  ORDER_ID_RE,
} from "./identity";
import { INTERNAL_PRODUCT_ID_RE } from "../capsule/identity";
import { CurrencyCode, MAX_MINOR_UNIT_AMOUNT } from "./offer-source";
import { TransactionType } from "./transaction-accounting";

// — Identity —

export const OrderId = z.string().regex(ORDER_ID_RE, "orderId must be mon:order:<opaque>");
export type OrderId = z.infer<typeof OrderId>;

const Amount = z.int().min(0).max(MAX_MINOR_UNIT_AMOUNT);
const ParticipantRef = z
  .string()
  .regex(MARKETPLACE_PARTICIPANT_ID_RE, "participant id must be mon:mpart:<opaque>");
const SourceRecordRef = z.string().min(1).max(191);
const SourceVersionRef = z.string().min(1).max(64);

// — Buyer identity —

/**
 * Which kind of buyer placed this Order.
 *
 * The same two `0M.1`'s `ReviewSubmitterKind` already names, and deliberately the
 * same words: the buyer who bought and the buyer who reviews are the same person,
 * and a second vocabulary for them would be a second answer to "was this a
 * guest".
 */
export const BUYER_KINDS = ["ACCOUNT_BUYER", "GUEST_BUYER"] as const;
export const BuyerKind = z.enum(BUYER_KINDS);
export type BuyerKind = z.infer<typeof BuyerKind>;

/**
 * A one-way digest of a guest's claim code.
 *
 * Hex SHA-256, exactly as `hashSessionToken` produces — a 256-bit random code is
 * unguessable, so a fast digest is the right tool and a slow one would only be a
 * self-inflicted cost (`session-token.ts` records the full reasoning).
 *
 * **The raw code is returned once, at checkout, and never stored.** A database
 * disclosure therefore yields no means of claiming anybody's purchase.
 */
export const GuestClaimCodeDigest = z
  .string()
  .regex(/^[0-9a-f]{64}$/, "a guest claim-code digest must be hex SHA-256");
export type GuestClaimCodeDigest = z.infer<typeof GuestClaimCodeDigest>;

/**
 * An authenticated buyer.
 *
 * `buyerParticipantId` is **nullable and usually null**: an account that has never
 * claimed the marketplace holds no participant record, and `0M.1` is explicit that
 * such an account "is treated as a guest buyer, which is what they are until they
 * claim otherwise". Buying requires no participant, no role, and no activation —
 * those gate *selling*.
 */
export const AccountBuyerIdentity = z.strictObject({
  buyerKind: z.literal("ACCOUNT_BUYER"),
  buyerAccountId: AccountId,
  /** Present only when this account already holds a participant record. */
  buyerParticipantId: ParticipantRef.nullable(),
});

/**
 * A guest buyer.
 *
 * Has **no field** for an account, a participant, or any contact detail. The
 * claim digest is the entire binding between a person and their purchase, and it
 * is the foundation the later claim flow verifies against: possession of the code
 * proves the holder was the buyer, without Monacado having stored anything that
 * identifies them.
 */
export const GuestBuyerIdentity = z.strictObject({
  buyerKind: z.literal("GUEST_BUYER"),
  guestClaimCodeDigest: GuestClaimCodeDigest,
});

export const BuyerIdentity = z.discriminatedUnion("buyerKind", [
  AccountBuyerIdentity,
  GuestBuyerIdentity,
]);
export type BuyerIdentity = z.infer<typeof BuyerIdentity>;

/**
 * A guest purchase later attached to an account.
 *
 * The **minimum durable foundation** the roadmap asks for, and deliberately not
 * the flow: the record that a claim happened, who it went to, and when. The
 * verification itself is possession of the claim code, checked against the digest
 * — there is no email round-trip, no token table, and no expiry policy here,
 * because each of those is a decision the claim phase should make in the open
 * rather than inherit from a foundation that guessed.
 *
 * **Claiming never rewrites the purchase.** `buyerKind` stays `GUEST_BUYER`
 * forever: the sale was made by a guest, and a record that quietly became an
 * account purchase would misstate what happened.
 */
export const GuestClaim = z.strictObject({
  claimedByAccountId: AccountId.nullable(),
  claimedAt: z.iso.datetime().nullable(),
});
export type GuestClaim = z.infer<typeof GuestClaim>;

// — Lifecycle —

/**
 * Where this Order's payment got to. Four states, and no more.
 *
 *   - `PENDING_PAYMENT` — placed and quoted; nothing charged yet.
 *   - `PAID` — the provider reported success and the sale was recorded.
 *   - `PAYMENT_FAILED` — the provider reported failure. No sale exists.
 *   - `CANCELLED` — abandoned before payment succeeded.
 *
 * **Where the funds got to afterwards is not here.** Captured, settled, and
 * reversed are `0M.T1`'s `TransactionSettlement` states. Restating them on the
 * Order would be two lifecycles over one sale, and the first divergence between
 * them would be unresolvable.
 */
export const ORDER_LIFECYCLE_STATES = [
  "PENDING_PAYMENT",
  "PAID",
  "PAYMENT_FAILED",
  "CANCELLED",
] as const;
export const OrderLifecycleState = z.enum(ORDER_LIFECYCLE_STATES);
export type OrderLifecycleState = z.infer<typeof OrderLifecycleState>;

export const INITIAL_ORDER_LIFECYCLE_STATE: OrderLifecycleState = "PENDING_PAYMENT";

/**
 * Valid transitions, as an exhaustive table.
 *
 * `PAID` is terminal **for the Order**: a completed sale does not become
 * uncompleted, and a reversal is settlement standing on the economic snapshot
 * rather than an Order that changed its mind.
 *
 * `PAYMENT_FAILED` may only be cancelled, never retried into `PAID`. **A retry is
 * a new Order**, which keeps one Order equal to one payment attempt outcome — the
 * alternative is a row whose history says "failed" while its state says "paid",
 * and no reader could tell how many times the buyer was charged.
 */
export const ORDER_LIFECYCLE_TRANSITIONS: Record<
  OrderLifecycleState,
  readonly OrderLifecycleState[]
> = Object.freeze({
  PENDING_PAYMENT: ["PAID", "PAYMENT_FAILED", "CANCELLED"],
  PAID: [],
  PAYMENT_FAILED: ["CANCELLED"],
  CANCELLED: [],
});

export function isValidOrderLifecycleTransition(
  from: OrderLifecycleState,
  to: OrderLifecycleState,
): boolean {
  return ORDER_LIFECYCLE_TRANSITIONS[from].includes(to);
}

export function isTerminalOrderLifecycleState(state: OrderLifecycleState): boolean {
  return ORDER_LIFECYCLE_TRANSITIONS[state].length === 0;
}

/** A sale actually happened. The only state that may carry economic facts. */
export function orderRepresentsCompletedSale(state: OrderLifecycleState): boolean {
  return state === "PAID";
}

// — Payment failure —

/**
 * Why a payment did not succeed.
 *
 * A closed, provider-neutral vocabulary. **No provider message, decline text,
 * network code, or issuer reason appears here**, for the same reason `0M.8`
 * refuses a provider's dossier: a free-text failure is where a card detail, an
 * address, or a customer's name eventually lands, and a classification is all a
 * caller can act on anyway.
 */
export const PAYMENT_FAILURE_CODES = [
  /** The provider declined the payment. */
  "DECLINED",
  /** The instrument was rejected as unusable — expired, invalid, unsupported. */
  "INSTRUMENT_REJECTED",
  /** The buyer abandoned or did not complete an authentication step. */
  "AUTHENTICATION_FAILED",
  /** The provider was unreachable or errored. */
  "PROVIDER_UNAVAILABLE",
  /** The provider reported a failure Monacado does not classify further. */
  "UNSPECIFIED_FAILURE",
] as const;
export const PaymentFailureCode = z.enum(PAYMENT_FAILURE_CODES);
export type PaymentFailureCode = z.infer<typeof PaymentFailureCode>;

// — The quote —

/**
 * What the buyer was told they would be charged.
 *
 * **A quote, not economics**, and named so nobody can mistake it: these are the
 * amounts that must exist before a payment can run, whereas the split between
 * Monacado, the seller, and any promoter is only knowable once the sale
 * completes. The successful-sale path asserts each of these equals the
 * corresponding figure on the `0M.T1` snapshot, so the overlap is a **checked
 * invariant** rather than a second answer left to drift.
 *
 * The commercial retail amount is the *effective* price at checkout time — a
 * seller-direct Listing inside a scheduled sale window quotes the sale price.
 *
 * Tax, shipping, and other pass-through amounts are **supplied by the caller and
 * calculated by nothing here**. `0M.T2` owns tax calculation, nexus, and
 * remittance. They are outside every commercial basis, structurally, because no
 * calculator in this repository accepts them.
 */
export const OrderQuote = z.strictObject({
  currency: CurrencyCode,
  /** The merchandise price alone. Tax and shipping are NOT in it. */
  quotedCommercialRetailAmountMinorUnits: Amount,
  /** Recorded, never calculated. 0M.T2 owns tax execution. */
  quotedTaxAmountMinorUnits: Amount,
  quotedShippingAmountMinorUnits: Amount,
  quotedOtherPassThroughAmountMinorUnits: Amount,
});
export type OrderQuote = z.infer<typeof OrderQuote>;

/**
 * What the buyer pays in total.
 *
 * **Derived, never stored** — the same rule `0M.T1` applies to its own totals. A
 * stored total is a second answer that can disagree with the four amounts it
 * sums, and the four are the authoritative ones.
 */
export function quotedBuyerTotalMinorUnits(quote: OrderQuote): number {
  return (
    quote.quotedCommercialRetailAmountMinorUnits +
    quote.quotedTaxAmountMinorUnits +
    quote.quotedShippingAmountMinorUnits +
    quote.quotedOtherPassThroughAmountMinorUnits
  );
}

// — The record —

/**
 * One Order.
 *
 * Note what has no field, and could not be given one without changing this
 * `strictObject`: a buyer email, name, or address; a card, bank, or device
 * detail; Monacado's retained amount, the acquisition amount, seller proceeds,
 * or any promoter figure; a settlement state; a payout; a refund or chargeback
 * amount; a tax rate or jurisdiction. The economics belong to the snapshot, the
 * funds standing to its settlement row, and the rest to `0M.T2` or nowhere.
 */
export const OrderRecord = z.strictObject({
  orderId: OrderId,

  // — Buyer —
  buyer: BuyerIdentity,
  /** Meaningful for a guest Order; both members are null on an account Order. */
  guestClaim: GuestClaim,

  // — Exact Listing binding —
  internalListingId: z
    .string()
    .regex(INTERNAL_LISTING_ID_RE, "internalListingId must be mon:listing:<opaque>"),
  listingSourceRecordId: SourceRecordRef,
  /** The EXACT version — never "current", never "latest". */
  listingSourceRecordVersion: SourceVersionRef,

  // — Exact commercial policy binding —
  policyId: z.string().regex(COMMERCIAL_POLICY_ID_RE, "policyId must be mon:cpol:<opaque>"),
  policyVersion: SourceVersionRef,

  // — Operational references —
  storefrontId: z
    .string()
    .regex(INTERNAL_STOREFRONT_ID_RE, "storefrontId must be mon:storefront:<opaque>"),
  internalProductId: z
    .string()
    .regex(INTERNAL_PRODUCT_ID_RE, "internalProductId must be mon:product:<opaque>"),

  // — Counterparties —
  /**
   * SELLER_DIRECT or PROMOTED, read from the bound Listing source version. It is
   * the discriminator for whether a promoter is owed anything at all.
   */
  transactionType: TransactionType,
  /**
   * The party owed seller proceeds. For a seller-direct sale this is the Listing's
   * controller; for a promoted sale it is the **Offer's** seller, who is not the
   * controller.
   */
  sellerParticipantId: ParticipantRef,
  /** Promoted sales only. `null` on a seller-direct Order — no promoter exists. */
  promoterParticipantId: ParticipantRef.nullable(),

  // — The quote —
  quote: OrderQuote,

  // — Lifecycle —
  lifecycle: OrderLifecycleState,
  /** Set only in PAYMENT_FAILED. Bounded classification, never provider text. */
  paymentFailureCode: PaymentFailureCode.nullable(),

  placedAt: z.iso.datetime(),
  paidAt: z.iso.datetime().nullable(),
  failedAt: z.iso.datetime().nullable(),
  cancelledAt: z.iso.datetime().nullable(),

  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type OrderRecord = z.infer<typeof OrderRecord>;

// — Inputs —

/**
 * What a caller supplies to place an Order.
 *
 * **Every commercial figure is absent.** There is no parameter for a retail
 * price, Monacado's retention, an acquisition amount, seller proceeds, a
 * commission, or a promoter's spread — the retail price is read from the bound
 * Listing version at `placedAt`, and the rest are `0M.4A`'s calculators' answer
 * at the moment the sale completes. A caller can supply only what Monacado
 * genuinely cannot derive: which Listing, which buyer, and the tax, shipping, and
 * pass-through amounts an external system charged.
 *
 * The Listing source version is **not** a parameter either: a buyer buys what is
 * on sale now, so checkout resolves the Listing's current version and records
 * which one that was. Naming a version would let a caller purchase terms that had
 * already been withdrawn.
 */
export const PlaceOrderInput = z.strictObject({
  internalListingId: z
    .string()
    .regex(INTERNAL_LISTING_ID_RE, "internalListingId must be mon:listing:<opaque>"),

  /**
   * The authenticated buyer's account, or `null` for a guest.
   *
   * A guest is the default rather than an exception: passing nothing yields a
   * guest Order, and no Account is created, looked up, or implied.
   */
  buyerAccountId: AccountId.nullable(),

  /** Recorded, never calculated. Required — a defaulted zero tax is silent. */
  taxAmountMinorUnits: Amount,
  shippingAmountMinorUnits: Amount,
  otherPassThroughAmountMinorUnits: Amount,

  /** Checked against the Listing's retail currency and the policy's. */
  currency: CurrencyCode,

  /**
   * Product availability, supplied exactly as `0M.7`'s eligibility read already
   * requires: availability is the Product model's question and this phase adds
   * no second answer to it.
   *
   * **Go-live approval is deliberately NOT here.** It was, briefly, on the
   * reasoning that `0M.3A` made it "a supplied decision input" with no column to
   * read. That was tolerable while nothing could be bought and is not tolerable
   * now: a caller passing `APPROVED` would have been a caller making a Listing
   * purchasable, which is the one thing a buyer-facing input must never do. It is
   * resolved from the governed `ParticipantCommerceApproval` record instead, and
   * there is no parameter through which a caller can assert or override it.
   */
  productAvailability: z.enum(["available", "unavailable"]),

  placedAt: z.iso.datetime(),
});
export type PlaceOrderInput = z.infer<typeof PlaceOrderInput>;

export const CancelOrderInput = z.strictObject({
  orderId: OrderId,
  at: z.iso.datetime(),
});
export type CancelOrderInput = z.infer<typeof CancelOrderInput>;

/**
 * Attach a guest purchase to an account.
 *
 * The claim code is supplied raw and compared by digest; nothing here stores it.
 * `buyerKind` is untouched — see `GuestClaim`.
 */
export const ClaimGuestOrderInput = z.strictObject({
  orderId: OrderId,
  /** The code handed to the buyer once, at checkout. Never persisted raw. */
  guestClaimCode: z.string().min(1).max(191),
  claimedByAccountId: AccountId,
  claimedAt: z.iso.datetime(),
});
export type ClaimGuestOrderInput = z.infer<typeof ClaimGuestOrderInput>;

// — Never on an Order —

/**
 * Named as never-persistable, and not admissible through any input above.
 *
 * Four groups, four reasons:
 *
 *   - **Buyer personal data** — never stored, so it cannot leak, cannot be
 *     subpoenaed from a column that does not exist, and cannot reach a capsule.
 *   - **Economic facts** — `0M.T1` owns them. A copy here would be a second
 *     answer to what each party earned.
 *   - **Settlement** — also `0M.T1`. Two lifecycles over one sale is one too many.
 *   - **Reversal and payout** — `0M.T2` and later.
 */
export const NEVER_ON_ORDER = [
  // buyer personal data
  "buyerEmail",
  "buyerName",
  "buyerPhone",
  "buyerAddress",
  "shippingAddress",
  "billingAddress",
  "buyerIpAddress",
  "cardLast4",
  "cardFingerprint",
  "bankAccountNumber",
  "deviceFingerprint",
  // economics — 0M.T1 owns these
  "monacadoRetainedAmountMinorUnits",
  "morWholesaleAcquisitionAmountMinorUnits",
  "sellerProceedsMinorUnits",
  "offerWholesalePriceMinorUnits",
  "sellerFundedCommissionMinorUnits",
  "promoterRetailSpreadMinorUnits",
  "promoterNetProceedsMinorUnits",
  // settlement — 0M.T1 owns this
  "settlementState",
  "fundsReceivedAt",
  "settledAt",
  "reversedAt",
  // reversal and payout — 0M.T2 and later
  "refundAmountMinorUnits",
  "chargebackAmountMinorUnits",
  "payoutId",
  "payoutBatchId",
  // derived values that must stay derived
  "quotedBuyerTotalMinorUnits",
  "buyerChargedTotalMinorUnits",
] as const;
