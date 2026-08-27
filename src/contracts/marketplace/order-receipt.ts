/**
 * The authoritative purchase receipt contract (Phase 1.10).
 *
 * **What a receipt states, assembled once, from purchase-time evidence.**
 *
 * `1.3` shipped `OrderPolicyView` — which marketplace terms governed a sale.
 * `1.9` shipped `OrderRefundReceiptView` — which seller refund terms governed it,
 * and the support contact the buyer was actually shown. Both are reads a receipt
 * needs and neither is a receipt: assembling one still meant a caller knowing to
 * ask three services and knowing which of their answers are historical and which
 * are current. This is the single answer, and it is the **contract a renderer
 * consumes** rather than a second store of anything.
 *
 * ```
 * OrderReceiptView
 *   ├── money        derived from the Order's quote — the four amounts, and the total
 *   ├── lines        the exact Listing/Product the Order bound
 *   ├── shipping     what was charged, and whether the bound policy returns it
 *   ├── refund       1.9's OrderRefundReceiptView, embedded whole
 *   ├── marketplace  the refund rules from the MARKETPLACE version the Order bound
 *   └── seller       the participant, and the contact frozen at purchase
 * ```
 *
 * ## One clock per fact, and the split is load-bearing
 *
 * | Fact | Time semantics |
 * | --- | --- |
 * | monetary summary | the Order's quote — what the buyer was charged |
 * | seller refund terms | the version **bound at checkout** |
 * | marketplace refund rules | the version **bound at checkout** |
 * | refund support contact | **frozen at purchase** |
 * | seller's contact today | resolved now, named separately, never a substitute |
 *
 * Everything historical comes from evidence attached to the sale. Nothing on a
 * receipt is read from a seller's current configuration except the one field
 * explicitly named as current — which is `1.9`'s rule, applied to the whole
 * receipt rather than to the refund section alone.
 *
 * ## What is deliberately absent
 *
 * **No promoter.** Monacado is the merchant of record: it contracts with the
 * buyer, takes the payment, and appears on their statement. A promoter is a
 * counterparty to *Monacado*, and naming one on a buyer's receipt would assert a
 * commercial relationship the buyer does not have. `PROMOTER_ON_BUYER_RECEIPT`
 * records that as a decision rather than an omission.
 *
 * **No economics.** No retained amount, no seller proceeds, no promoter spread,
 * no commission. `1.1` drew that line for the confirmation email and it holds
 * here: what each party earned is Monacado's commercial position, and a receipt
 * is not where it gets published.
 *
 * **No buyer identity.** The Order carries none by construction (`NEVER_ON_ORDER`)
 * and the receipt does not reintroduce it. A renderer addresses the message from
 * `OrderBuyerSnapshot`; the receipt states what was bought, not who bought it.
 *
 * Pure types. No I/O, no clock, no vendor.
 */

import { z } from "zod";
import { PolicySection } from "./marketplace-policy";
import { OrderRefundReceiptView } from "./refund-disclosure";
import { ShippingRefundability } from "./seller-refund-policy";

// — Money —

/**
 * What the buyer was charged, in the shape the Order actually records it.
 *
 * The four quoted components plus their sum. The **total is derived** here
 * exactly as `quotedBuyerTotalMinorUnits` derives it — `NEVER_ON_ORDER` forbids a
 * stored total, and a receipt inventing a second one would create the disagreement
 * that rule exists to prevent.
 */
export const ReceiptMonetarySummary = z.strictObject({
  currency: z.string().length(3),
  /** The merchandise price alone. Tax and shipping are not in it. */
  merchandiseMinorUnits: z.int(),
  taxMinorUnits: z.int(),
  shippingMinorUnits: z.int(),
  otherPassThroughMinorUnits: z.int(),
  /** Derived from the four above. Never read from storage. */
  totalMinorUnits: z.int(),
});
export type ReceiptMonetarySummary = z.infer<typeof ReceiptMonetarySummary>;

// — Lines —

/**
 * One purchased line, as the Order bound it.
 *
 * References, not descriptions — and that is a **recorded limitation rather than
 * a preference**, see `RECEIPT_LINE_DESCRIPTION_GAP`. The Order binds an exact
 * `ListingSourceRecordVersion`, which carries placement and pricing but no
 * product title; the Product's descriptive facts are versioned separately and the
 * Order binds none of those versions. Reading a title now would read whatever the
 * seller's Product says *today*, which is precisely the substitution this whole
 * phase exists to refuse.
 */
export const ReceiptLine = z.strictObject({
  internalListingId: z.string().min(1).max(191),
  /** The exact version bought — never "current", never "latest". */
  listingSourceRecordVersion: z.string().min(1).max(64),
  internalProductId: z.string().min(1).max(191),
  /**
   * A purchase-time product description, when one is durably bound to the sale.
   *
   * Always `null` today. Left in the shape so a later phase that binds a Product
   * source version to the Order fills it in rather than a renderer growing a
   * second, live-read answer beside this one.
   */
  description: z.string().min(1).max(400).nullable(),
  /** This line's merchandise amount. Equal to the Order's for a one-line Order. */
  merchandiseMinorUnits: z.int(),
});
export type ReceiptLine = z.infer<typeof ReceiptLine>;

/**
 * Why a receipt line names a Product rather than describing one.
 *
 * Stated as data because it is a **gap in the evidence model**, not a rendering
 * choice, and because it cannot be closed retrospectively: a Product source
 * version has to be bound to an Order *at the moment of sale* or the description
 * that applied is gone. Recording it here means whoever builds `OrderLine` /
 * basket checkout meets the requirement rather than discovering it.
 */
export const RECEIPT_LINE_DESCRIPTION_GAP = {
  boundToTheOrder: ["INTERNAL_LISTING_ID", "LISTING_SOURCE_RECORD_VERSION", "INTERNAL_PRODUCT_ID"],
  /** What the bound Listing version carries: placement and commercial terms. */
  listingVersionCarries: "PLACEMENT_AND_COMMERCIAL_TERMS_ONLY",
  /** And what it does not. */
  notBound: "PRODUCT_SOURCE_RECORD_VERSION",
  /** So the honest answer is a reference, never today's title. */
  disposition: "REFERENCE_ONLY_UNTIL_A_PRODUCT_VERSION_IS_BOUND_AT_SALE",
  liveReadSubstitution: "REFUSED",
  requiredOfWhicheverPhaseBindsIt: "RECORD_AT_SALE_TIME_CANNOT_BE_RECONSTRUCTED",
} as const;

// — Shipping —

/**
 * The shipping charge and its declared treatment.
 *
 * `refundability` comes from the **bound** seller policy's terms, so a receipt
 * states the rule the buyer was actually sold under. `null` where no policy is
 * bound — never a default, and in particular never "refunded", because assuming
 * the buyer-favourable answer is still asserting a term nobody agreed.
 *
 * There is no apportioned figure and no per-line share. Shipping is one charge
 * for one carriage; `SHIPPING_ALLOCATION_SEAM` refuses to invent the split, and a
 * receipt that printed one would be publishing a rule nobody adopted.
 */
export const ReceiptShippingTreatment = z.strictObject({
  chargedMinorUnits: z.int(),
  /** From the bound seller policy. `null` when no policy is bound. */
  refundability: ShippingRefundability.nullable(),
  /** Never apportioned across part of an order. Always this literal. */
  apportionment: z.literal("NOT_APPORTIONED"),
});
export type ReceiptShippingTreatment = z.infer<typeof ReceiptShippingTreatment>;

// — Seller —

/**
 * The seller, as a receipt may name them.
 *
 * `displayName` is **always `null`**, and that is a finding rather than a stub:
 * this repository holds no authoritative seller display name anywhere. A
 * participant has an admission status, roles, a profile of completion markers,
 * and an account email — no trading name, no legal name, no public label. Reading
 * a Storefront's name instead would name the *shop the sale happened in*, which
 * on a promoted Listing is the promoter's and not the seller's.
 *
 * So what a receipt can honestly say about the seller is: the marketplace
 * identity the sale was recorded against, and the support contact the buyer was
 * given. The contact lives on `refund.procedure.purchaseTimeRefundContact` and is
 * deliberately **not** copied here — one answer, in one place.
 */
export const ReceiptSellerIdentity = z.strictObject({
  participantId: z.string().min(1).max(191),
  /** No authoritative seller display name exists. See `SELLER_DISPLAY_NAME_GAP`. */
  displayName: z.null(),
});
export type ReceiptSellerIdentity = z.infer<typeof ReceiptSellerIdentity>;

/** Why a receipt cannot print a seller's trading name. Recorded, not worked around. */
export const SELLER_DISPLAY_NAME_GAP = {
  authoritativeSellerDisplayName: "DOES_NOT_EXIST",
  /** What was considered and rejected, and why. */
  storefrontNameSubstitution: "REFUSED_NAMES_THE_PROMOTER_ON_A_PROMOTED_SALE",
  accountEmailSubstitution: "REFUSED_AN_ACCOUNT_ADDRESS_IS_NOT_A_TRADING_NAME",
  /** What a receipt says instead. */
  disposition: "MARKETPLACE_IDENTITY_AND_THE_DISCLOSED_SUPPORT_CONTACT",
} as const;

/**
 * Whether a promoter is named on a buyer's receipt.
 *
 * They are not. Monacado is the merchant of record and is the buyer's
 * counterparty; a promoter is a counterparty to Monacado. Naming one here would
 * describe a relationship the buyer is not in, and would publish which
 * participant earned from the sale — a commercial position `1.1` already kept out
 * of the confirmation email.
 */
export const PROMOTER_ON_BUYER_RECEIPT = "NOT_INCLUDED" as const;

// — Marketplace rules —

/**
 * The marketplace refund rules that governed this purchase.
 *
 * Sections from the **version bound to the Order**, projected for the buyer — not
 * the version in force today. A receipt reopened after Monacado publishes new
 * terms shows the terms the sale was made under, exactly as it does for the
 * seller's.
 *
 * Empty `refundSections` is a real and correct answer for an Order bound to a
 * version that states no refund governance — 1.0.0 states none — and is shown as
 * such rather than filled in from a newer version.
 */
export const ReceiptMarketplacePolicyView = z.strictObject({
  policyId: z.string().min(1).max(191),
  policyVersion: z.string().min(1).max(64),
  contentHash: z.string().min(1).max(80),
  /** The buyer-facing refund-governance sections of the bound version. */
  refundSections: z.array(PolicySection),
});
export type ReceiptMarketplacePolicyView = z.infer<typeof ReceiptMarketplacePolicyView>;

// — Initiation —

/**
 * How the buyer starts a refund, as the receipt must be able to state it.
 *
 * `requiresBuyerAccount` is a literal `false` and cannot be anything else: a
 * guest holds no account and never will, and a receipt that made one a
 * precondition would strand every guest purchase ever made.
 */
export const ReceiptRefundInitiation = z.strictObject({
  requiresBuyerAccount: z.literal(false),
  /** The evidence a buyer presents. A guest presents the purchase itself. */
  guestVerification: z.literal("ORDER_REFERENCE_AND_PURCHASE_CONFIRMATION"),
  accountCreationAfterPurchase: z.literal("NEVER_REQUIRED"),
});
export type ReceiptRefundInitiation = z.infer<typeof ReceiptRefundInitiation>;

// — The receipt —

/**
 * Everything a receipt states about one purchase.
 *
 * A **read contract**. It renders nothing, sends nothing, and stores nothing; it
 * answers the questions a receipt asks, from evidence bound to the sale, so that
 * producing one — as an email today, as a page or a document later — is a
 * presentation problem.
 *
 * `unavailableReason` is bounded rather than a throw. "This Order has no bound
 * marketplace policy" is an ordinary historical state a receipt must show
 * honestly, not an exception.
 */
export const OrderReceiptView = z.strictObject({
  orderId: z.string().min(1).max(191),
  /** PENDING_PAYMENT | PAID | PAYMENT_FAILED | CANCELLED, as the Order records it. */
  lifecycle: z.string().min(1).max(24),
  placedAt: z.iso.datetime(),
  /** `null` unless the sale completed. A receipt for an unpaid Order says so. */
  paidAt: z.iso.datetime().nullable(),

  seller: ReceiptSellerIdentity,
  lines: z.array(ReceiptLine),
  money: ReceiptMonetarySummary,
  shipping: ReceiptShippingTreatment,

  /** `1.9`'s historical refund view, embedded whole rather than restated. */
  refund: OrderRefundReceiptView,
  /** The marketplace terms bound to the sale. `null` for a pre-1.3 Order. */
  marketplacePolicy: ReceiptMarketplacePolicyView.nullable(),
  refundInitiation: ReceiptRefundInitiation,

  unavailableReason: z.enum(["ORDER_NOT_FOUND"]).nullable(),
  evaluatedAt: z.iso.datetime(),
});
export type OrderReceiptView = z.infer<typeof OrderReceiptView>;

// — What a receipt must and must never do —

/**
 * The receipt surface's obligations, stated as data so a test can hold the
 * renderer to them rather than a reviewer having to.
 *
 * `1.9` recorded `RECEIPT_SURFACE.mustNever` against a renderer that did not
 * exist yet. It exists now, and these are the same prohibitions expressed as
 * properties of the thing that has to obey them.
 */
export const RECEIPT_CONTRACT = {
  /** Assembled from one read. No caller stitches three services together. */
  assembly: "SINGLE_READ",
  mustInclude: [
    "ORDER_REFERENCE",
    "SELLER_MARKETPLACE_IDENTITY",
    "EXACT_SELLER_REFUND_POLICY_VERSION_REFERENCE",
    "COMPLETE_APPLICABLE_SELLER_REFUND_POLICY",
    "REFUND_INITIATION_PROCEDURE",
    "PURCHASE_TIME_REFUND_SUPPORT_CONTACT",
    "PURCHASED_LINE_REFERENCES",
    "MONETARY_SUMMARY",
    "SHIPPING_TREATMENT",
    "TAX_CHARGED",
    "MARKETPLACE_REFUND_RULES_AS_BOUND",
  ],
  mustNever: [
    "SUBSTITUTE_CURRENT_POLICY_FOR_A_HISTORICAL_ORDER",
    "SUBSTITUTE_CURRENT_SUPPORT_CONTACT_FOR_THE_ONE_DISCLOSED",
    "REQUIRE_A_CURRENT_SUPPORT_CONTACT_TO_REPRODUCE_AN_OLD_RECEIPT",
    "REQUIRE_A_BUYER_ACCOUNT_TO_REQUEST_A_REFUND",
    "NAME_A_PROMOTER",
    "STATE_ANY_PARTY_ECONOMICS",
    "APPORTION_A_SHIPPING_CHARGE",
  ],
} as const;

/**
 * Named as never admissible on a receipt view.
 *
 * Refused by the `strictObject`s above, and listed so the reasoning survives.
 * The economics group is `0M.T1`'s and is a marketplace's commercial position;
 * the buyer group is absent from the Order by construction and is not
 * reintroduced by the surface that renders it.
 */
export const NEVER_ON_RECEIPT = [
  // economics — 0M.T1 owns these, and a receipt is not where they are published
  "monacadoRetainedAmountMinorUnits",
  "sellerProceedsMinorUnits",
  "promoterNetProceedsMinorUnits",
  "sellerFundedCommissionMinorUnits",
  "morWholesaleAcquisitionAmountMinorUnits",
  // the promoter — not the buyer's counterparty
  "promoterParticipantId",
  // buyer identity — NEVER_ON_ORDER forbids it upstream and this does not undo it
  "buyerEmail",
  "buyerName",
  "buyerAddress",
  "cardLast4",
  // credentials — a receipt is forwarded, printed, and archived
  "guestClaimCode",
  "guestClaimCodeDigest",
  // provider mechanics — never in a buyer-facing artifact
  "paymentIntentId",
  "providerRefundId",
  "taxTransactionReference",
] as const;
