/**
 * Refund disclosure and receipt read contracts (Phase 1.9 correction).
 *
 * **Two moments, one policy version, and a different clock for each.**
 *
 * ```
 * BEFORE PURCHASE   the seller's ACTIVE policy      ← what the buyer is agreeing to
 * ON THE RECEIPT    the version the ORDER BOUND     ← what actually governed the sale
 * ```
 *
 * They are the same thing at the instant of purchase and diverge the moment the
 * seller publishes a new version. Getting that backwards — showing a buyer
 * today's terms for a purchase made under yesterday's — is the failure this whole
 * correction exists to prevent, and it is a failure that *looks* authoritative,
 * which is what makes it dangerous.
 *
 * ## A read contract, not a receipt engine
 *
 * There is no rendering here, no template, no PDF, and no delivery. This answers
 * the questions a receipt asks so that building one is a presentation problem
 * rather than a policy-archaeology problem — the identical judgement
 * `OrderPolicyView` made in `1.3`, and this deliberately mirrors it rather than
 * inventing a second shape.
 *
 * `RECEIPT_SURFACE` names the future surface explicitly, so "the receipt is not
 * built yet" is a recorded disposition rather than a silence somebody has to
 * infer.
 *
 * ## Two clocks on the receipt, and mixing them was a bug
 *
 * | | Time semantics | Why |
 * | --- | --- | --- |
 * | the governing policy | the version **bound to the Order** | a receipt must show the terms that applied |
 * | the refund procedure | from the **bound** version | the route the buyer was promised |
 * | `purchaseTimeRefundContact` | **frozen at purchase** | a receipt is evidence of what the buyer was told |
 * | `currentSellerSupportContact` | resolved **now**, optional | a buyer acting today wants a mailbox that works today |
 *
 * `1.3` resolves a seller's support contact at ask time and does not snapshot it,
 * reasoning that "sending a buyer to the address that worked at checkout would
 * send them nowhere". That is right for a **support link** and wrong for a
 * **receipt**, and this phase's first draft carried the error across.
 *
 * A receipt is a record of a disclosure. Regenerating an old one must not
 * silently substitute an address the buyer was never shown — the seller may have
 * changed their primary email, nominated a dedicated support address, or both,
 * and a "corrected" receipt is a receipt nobody can rely on as evidence.
 *
 * So the historical value is **frozen at checkout** on
 * `OrderRefundContactEvidence`, and the current one is offered **beside** it,
 * clearly named, and structurally unable to overwrite it. A receipt renders
 * without the current contact being available at all.
 *
 * Pure types. No I/O, no clock, no vendor.
 */

import { z } from "zod";
import {
  SellerRefundPolicyDocument,
  SellerRefundPolicyVersionRecord,
  RefundProcedureKind,
} from "./seller-refund-policy";
import { PolicySection } from "./marketplace-policy";
import { EmailContactPurpose, EmailContactState } from "./participant-email-contact";

// — Pre-purchase disclosure —

/**
 * What a buyer must be able to see **before** completing a purchase.
 *
 * Carries the complete document rather than a summary. A disclosure a buyer
 * cannot read in full is not a disclosure, and a checkout surface that showed
 * only "returns accepted" would be making a claim the terms might not support.
 *
 * `available: false` is a real answer and checkout **refuses the sale** on it —
 * see `SellerRefundPolicyUnavailableError`. It appears here so a listing page can
 * say so honestly rather than rendering an empty box.
 */
export const RefundPolicyDisclosure = z.strictObject({
  available: z.boolean(),
  /** The seller whose terms these are. */
  sellerParticipantId: z.string().min(1).max(191).nullable(),
  /** The exact version a purchase right now would bind. */
  policyId: z.string().min(1).max(191).nullable(),
  policyVersion: z.string().min(1).max(64).nullable(),
  /** The complete declared policy. `null` when none is active. */
  document: SellerRefundPolicyDocument.nullable(),
  /** The enforced terms, so a surface can render them structurally if it wants. */
  refundsAllowed: z.boolean().nullable(),
  refundWindowDays: z.int().nullable(),
  shippingRefundable: z.string().min(1).max(32).nullable(),
  procedureKind: RefundProcedureKind.nullable(),
  /** The exact bytes, so a disclosure can be proved to match what was bound. */
  contentHash: z.string().min(1).max(80).nullable(),
  evaluatedAt: z.iso.datetime(),
});
export type RefundPolicyDisclosure = z.infer<typeof RefundPolicyDisclosure>;

/**
 * The complete refund disclosure a checkout surface must be able to show
 * (Phase 1.10).
 *
 * **One read, and no second source of truth.** `1.9` shipped
 * `RefundPolicyDisclosure` — the seller's terms — and `1.3` shipped the
 * marketplace policy's audience projection. A checkout page needed both plus the
 * knowledge that the sale is about to bind the first of them, and assembling that
 * per surface is how two surfaces end up disclosing different things.
 *
 * Every field is **derived**: the seller half is `RefundPolicyDisclosure`
 * unchanged, and the marketplace half is `selectRefundGovernanceSections` over
 * the version that is `ACTIVE` right now. Nothing here restates a term, and
 * nothing here is authoritative — it is a projection of two authorities that
 * already exist.
 *
 * ## Pre-purchase reads the CURRENT versions, deliberately
 *
 * The opposite clock from a receipt, and for the opposite reason: a buyer about
 * to pay is agreeing to what stands **now**, and the binding below is the promise
 * that what stands now is exactly what their Order will carry.
 */
export const CheckoutRefundDisclosure = z.strictObject({
  /** The seller's terms, complete. `available: false` means checkout refuses. */
  sellerPolicy: RefundPolicyDisclosure,
  /**
   * The marketplace refund rules in force, projected for the buyer.
   *
   * `null` when no marketplace policy is `ACTIVE` — a state in which checkout
   * already refuses every sale, shown honestly rather than as an empty section.
   * `refundSections` may be empty for an active version that states no refund
   * governance, which is 1.0.0's real answer and not a gap.
   */
  marketplacePolicy: z
    .strictObject({
      policyId: z.string().min(1).max(191),
      policyVersion: z.string().min(1).max(64),
      contentHash: z.string().min(1).max(80),
      refundSections: z.array(PolicySection),
    })
    .nullable(),
  /**
   * What the Order will bind, stated before it binds it.
   *
   * The point of the whole shape: a buyer is shown terms and the sale then
   * records *those exact versions*, so "the policy I was shown" and "the policy
   * that governs my purchase" are the same object rather than two reads that
   * happened to agree.
   */
  binding: z.strictObject({
    /** The exact seller version a purchase now would bind. `null` when none. */
    sellerRefundPolicy: z
      .strictObject({
        policyId: z.string().min(1).max(191),
        policyVersion: z.string().min(1).max(64),
        contentHash: z.string().min(1).max(80),
      })
      .nullable(),
    /** The exact marketplace version a purchase now would bind. */
    marketplacePolicy: z
      .strictObject({
        policyId: z.string().min(1).max(191),
        policyVersion: z.string().min(1).max(64),
        contentHash: z.string().min(1).max(80),
      })
      .nullable(),
    /**
     * Whether checkout refuses a sale it cannot bind. Always `true`.
     *
     * A literal because it is `1.9`'s structural guarantee rather than a setting:
     * a sale that completed without a bound refund policy would be a purchase
     * whose terms nobody could produce afterwards.
     */
    saleRefusedWithoutBinding: z.literal(true),
  }),
  evaluatedAt: z.iso.datetime(),
});
export type CheckoutRefundDisclosure = z.infer<typeof CheckoutRefundDisclosure>;

// — Receipt —

/**
 * The refund-support contact as it was **disclosed to this buyer at purchase**.
 *
 * Frozen evidence, read from `OrderRefundContactEvidence` and never refreshed.
 * `source` and `state` are the provenance a receipt's claim rests on: that this
 * was the *effective, verified* seller contact when the sale occurred, rather
 * than merely an address someone had on file.
 */
export const PurchaseTimeRefundContact = z.strictObject({
  /** The exact value shown. Never re-resolved. */
  address: z.string().min(1).max(320),
  /** Which contact was effective: a nominated support mailbox, or the account's. */
  source: EmailContactPurpose,
  /** Its state at capture. `VERIFIED` by construction — checkout refuses otherwise. */
  state: EmailContactState,
  capturedAt: z.iso.datetime(),
});
export type PurchaseTimeRefundContact = z.infer<typeof PurchaseTimeRefundContact>;

/**
 * How a buyer starts a refund, as a receipt must be able to state it.
 *
 * Bounded route, the seller's own instructions, and **where they were told to
 * send them**. A procedure that said "contact the seller" without an address
 * would be an instruction a buyer cannot follow.
 *
 * **No buyer account is required to act on it.** A guest reaches their Order with
 * the claim code handed to them once at checkout — see `GUEST_REFUND_INITIATION`.
 */
export const RefundProcedureView = z.strictObject({
  kind: RefundProcedureKind,
  /** The seller's own instructions, from the bound version's PROCEDURE section. */
  instructions: z.string().min(1).max(4_000),
  /**
   * **Where the buyer was told to send it**, frozen at purchase.
   *
   * `null` only for an Order placed before this evidence was captured — never a
   * fallback to whatever the seller's current address happens to be, and never
   * dependent on the seller having a usable contact today. An old receipt must
   * reproduce even for a seller who has since gone dark.
   */
  purchaseTimeRefundContact: PurchaseTimeRefundContact.nullable(),
  /** Whether a buyer needs an account to start one. Always `false`. */
  requiresBuyerAccount: z.literal(false),
});
export type RefundProcedureView = z.infer<typeof RefundProcedureView>;

/**
 * Everything a receipt needs to state this Order's refund position.
 *
 * The complete **historical** policy, its exact version reference, the procedure,
 * and the seller's support contact. Nothing here is today's policy standing in
 * for an old one: `policyVersion` is `null` for a pre-correction Order, and a
 * receipt shows that rather than substituting.
 */
export const OrderRefundReceiptView = z.strictObject({
  orderId: z.string().min(1).max(191),
  /**
   * The exact version bound at checkout, complete. `null` only for an Order
   * placed before the binding existed — never a fallback to the current one.
   */
  policyVersion: SellerRefundPolicyVersionRecord.nullable(),
  /** The reference a receipt prints so the terms can be produced again later. */
  policyRef: z
    .strictObject({
      policyId: z.string().min(1).max(191),
      policyVersion: z.string().min(1).max(64),
      contentHash: z.string().min(1).max(80),
    })
    .nullable(),
  /** How to start a refund, as the buyer was told. `null` when no policy is bound. */
  procedure: RefundProcedureView.nullable(),
  /**
   * The seller's support contact **as it is right now**, for buyer convenience.
   *
   * Deliberately a **separate field with a different name**, so nothing can
   * mistake it for the historical one. It is informational: a buyer acting today
   * may prefer a mailbox that still works, and a seller who moved wants their
   * mail. It **never** alters `procedure.purchaseTimeRefundContact`, and its
   * absence never prevents an old receipt from rendering.
   *
   * `null` when the seller currently has no usable contact — a real state a
   * receipt shows honestly rather than printing a dead address.
   */
  currentSellerSupportContact: z.string().min(1).max(320).nullable(),
  /**
   * Why no policy is shown, where none is. A bounded code, so a receipt renders
   * an explanation rather than an empty section.
   */
  unavailableReason: z
    .enum(["POLICY_NOT_BOUND", "POLICY_UNREADABLE", "ORDER_NOT_FOUND"])
    .nullable(),
  evaluatedAt: z.iso.datetime(),
});
export type OrderRefundReceiptView = z.infer<typeof OrderRefundReceiptView>;

/**
 * What the receipt surface will be, recorded rather than built.
 *
 * `1.3` shipped `OrderPolicyView` and no renderer, on the reasoning that the hard
 * part is policy archaeology rather than presentation. The same holds here, and
 * the same disposition is recorded: **the Order carries everything needed to
 * render the historical policy later**, and that is the property that had to
 * exist now, because it cannot be added retrospectively to sales already made.
 */
export const RECEIPT_SURFACE = {
  /** What exists today. */
  readContract: "IMPLEMENTED",
  /**
   * Implemented in `1.10`.
   *
   * `1.9` recorded this as `NOT_IMPLEMENTED` on the reasoning that the hard part
   * was policy archaeology rather than presentation — and that reasoning is what
   * made the renderer small when it came: `OrderReceiptView` answers the
   * questions, and `renderBuyerConfirmation` prints them.
   */
  renderer: "IMPLEMENTED",
  /** `1.5`'s durable outbound email, carrying the `ORDER_CONFIRMATION` purpose. */
  delivery: "IMPLEMENTED",
  /** What the Order already carries, so a later renderer needs no backfill. */
  durableOnTheOrder: [
    "SELLER_REFUND_POLICY_ID",
    "SELLER_REFUND_POLICY_VERSION",
    "PURCHASE_TIME_REFUND_CONTACT_ADDRESS",
    "PURCHASE_TIME_REFUND_CONTACT_SOURCE_AND_STATE",
    "MARKETPLACE_POLICY_ID",
    "MARKETPLACE_POLICY_VERSION",
    "COMMERCIAL_POLICY_ID",
    "COMMERCIAL_POLICY_VERSION",
  ],
  /** What a renderer must include when it is built. */
  mustInclude: [
    "COMPLETE_APPLICABLE_SELLER_REFUND_POLICY",
    "EXACT_POLICY_VERSION_REFERENCE",
    "REFUND_INITIATION_PROCEDURE",
    "PURCHASE_TIME_REFUND_SUPPORT_CONTACT",
  ],
  /** And what it must never do. */
  mustNever: [
    "SUBSTITUTE_CURRENT_POLICY_FOR_A_HISTORICAL_ORDER",
    "SUBSTITUTE_CURRENT_SUPPORT_CONTACT_FOR_THE_ONE_DISCLOSED",
    "REQUIRE_A_CURRENT_SUPPORT_CONTACT_TO_REPRODUCE_AN_OLD_RECEIPT",
  ],
} as const;

// — Guest initiation —

/**
 * How a buyer with no account starts a refund.
 *
 * **A guest must remain able to.** `0M.9` made guest checkout first-class and
 * fabricated no Account for it; a refund path that required one would retro-fit
 * exactly the account the buyer declined to create, and would strand every guest
 * purchase ever made.
 *
 * The verification is the same credential the purchase already established: the
 * claim code handed over once at checkout, of which only a SHA-256 digest is
 * stored. Nothing new is minted, no account is created, and the raw code is never
 * persisted or logged.
 */
export const REFUND_INITIATION_VERIFICATION_KINDS = [
  /** A guest proves the purchase with their claim code. No account involved. */
  "GUEST_CLAIM_CODE",
  /** An account holder is already authenticated as the buyer. */
  "BUYER_ACCOUNT",
  /** An operator acting under an entitlement, on a buyer's behalf. */
  "OPERATOR",
] as const;
export const RefundInitiationVerificationKind = z.enum(REFUND_INITIATION_VERIFICATION_KINDS);
export type RefundInitiationVerificationKind = z.infer<
  typeof RefundInitiationVerificationKind
>;

export const GUEST_REFUND_INITIATION = {
  requiresBuyerAccount: false,
  /** The durable evidence a guest presents. */
  verification: "GUEST_CLAIM_CODE_DIGEST",
  /** Nothing is created for them. */
  accountFabrication: "REFUSED",
  /** The raw code is compared and discarded, never stored or logged. */
  rawCredentialRetention: "NONE",
  /** And a wrong code answers identically to an unknown Order. */
  enumerationResistance: "IDENTICAL_REFUSAL",
} as const;
