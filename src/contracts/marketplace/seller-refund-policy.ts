/**
 * Seller refund policy (Phase 1.9).
 *
 * **The seller owns the declared refund terms; Monacado enforces the terms that
 * governed the purchase.** That sentence is the whole model, and every design
 * decision below follows from it.
 *
 * ```
 * seller declares terms → version recorded → version ACTIVE
 *   → checkout BINDS the exact version to the Order
 *   → that version governs this sale FOREVER, whatever the seller does later
 * ```
 *
 * ## Versioned, because prose that can change is not a term
 *
 * A seller's returns policy is exactly the kind of statement that gets edited
 * after a dispute starts. `SellerRefundPolicyVersionRow` mirrors
 * `MarketplacePolicyVersionRow` and `CommercialPolicyVersionRow` — the pattern
 * this repository already uses — for the same reason all three exist: *a term
 * that changed without a record of who changed it, when, and what a buyer was
 * actually shown is not governance.*
 *
 * **Mutable current profile prose is never historical authority.** An Order binds
 * `(sellerRefundPolicyId, sellerRefundPolicyVersion)`, and a receipt opened next
 * year renders **that** version. A seller who tightens their policy tomorrow does
 * not retroactively tighten it for yesterday's buyer.
 *
 * ## Structured terms AND prose, and why both
 *
 * `MarketplacePolicy` keeps its prose in a source module because Monacado authors
 * it. A seller's prose cannot live in a source module, so it is stored — but on
 * an **immutable version row**, which is a different thing from the editable text
 * column that model was avoiding. `contentHash` pins the exact bytes.
 *
 * The *enforceable* terms are separate, bounded columns rather than sentences,
 * because eligibility and shipping refundability are decided by code:
 *
 * | Decided by code | Read by a human |
 * | --- | --- |
 * | `refundsAllowed`, `refundWindowDays`, `shippingRefundability` | the document's sections |
 *
 * A rule that existed only in prose would be a rule nothing could enforce, and a
 * policy whose prose disagreed with its enforced behaviour is worse than either
 * alone. `documentAgreesWithTerms` is where that disagreement is caught.
 *
 * ## What it does not decide
 *
 * Not whether Monacado *may* refund. Monacado retains operational authority to
 * execute or refuse a refund under applicable law, and **buyer statutory rights
 * are not overridden by a seller's declared terms** — see
 * `MARKETPLACE_REFUND_POSTURE`. This model records what the seller promised; it
 * does not purport to be the last word on what a buyer is owed.
 *
 * Pure types and pure decisions. No I/O, no clock, no vendor.
 */

import { z } from "zod";
import { SELLER_REFUND_POLICY_ID_RE, MARKETPLACE_PARTICIPANT_ID_RE } from "./identity";
import { PolicyVersionStatus } from "./marketplace-policy";
import type { RefundReasonCode } from "./order-refund";

// — Identity —

export const SellerRefundPolicyId = z
  .string()
  .regex(SELLER_REFUND_POLICY_ID_RE, "sellerRefundPolicyId must be mon:srpol:<opaque>");
export type SellerRefundPolicyId = z.infer<typeof SellerRefundPolicyId>;

export const SellerRefundPolicyVersion = z.string().min(1).max(64);
export type SellerRefundPolicyVersion = z.infer<typeof SellerRefundPolicyVersion>;

const ParticipantId = z
  .string()
  .regex(MARKETPLACE_PARTICIPANT_ID_RE, "sellerParticipantId must be mon:mpart:<opaque>");

// — Enforceable terms —

/**
 * The conditions under which the seller says a refund may be claimed.
 *
 * A **closed vocabulary**, and deliberately coarse. These are disclosed to the
 * buyer and rendered on the receipt; they are not adjudicated automatically,
 * because deciding whether an item was "unused" is a judgement about the world
 * and not a database read. What the vocabulary buys is that a buyer can see the
 * condition before purchase and an operator can see the same words afterwards.
 *
 * `ANY_REASON` is a real, common policy and is not a synonym for "no conditions":
 * a window may still apply.
 */
export const REFUND_ELIGIBILITY_CONDITIONS = [
  /** The seller accepts returns for any reason within the declared window. */
  "ANY_REASON",
  /** Only where the item is defective or damaged. */
  "DEFECTIVE_OR_DAMAGED",
  /** Only where the item materially differs from its description. */
  "NOT_AS_DESCRIBED",
  /** Only where the item is unused and in original condition. */
  "UNUSED_AND_UNOPENED",
  /** Digital goods: only where the item has not been downloaded or accessed. */
  "DIGITAL_NOT_ACCESSED",
  /** The item never arrived. */
  "NOT_DELIVERED",
  /** The seller cancelled or could not supply. */
  "SELLER_CANCELLED",
] as const;
export const RefundEligibilityCondition = z.enum(REFUND_ELIGIBILITY_CONDITIONS);
export type RefundEligibilityCondition = z.infer<typeof RefundEligibilityCondition>;

/**
 * Whether the buyer's shipping charge comes back.
 *
 * **Three members, and no fourth.** In particular there is no "prorated" and no
 * "at Monacado's discretion": the first is an allocation rule nobody has ruled
 * on, and the second would make a disclosed term unpredictable, which is the one
 * thing a disclosed term must not be.
 *
 * `REFUNDED_WHEN_SELLER_AT_FAULT` is determinate rather than a judgement call —
 * `shippingIsRefundable` decides it from the refund's own bounded reason code,
 * so the same inputs always produce the same answer and a buyer reading the
 * policy can predict it.
 */
export const SHIPPING_REFUNDABILITY = [
  /** Shipping is returned with the item. */
  "ALWAYS_REFUNDED",
  /** Shipping is never returned. The buyer paid for carriage that happened. */
  "NEVER_REFUNDED",
  /** Returned only where the refund reason attributes fault to the seller. */
  "REFUNDED_WHEN_SELLER_AT_FAULT",
] as const;
export const ShippingRefundability = z.enum(SHIPPING_REFUNDABILITY);
export type ShippingRefundability = z.infer<typeof ShippingRefundability>;

/**
 * Refund reasons that attribute fault to the seller.
 *
 * Named as data rather than decided at a call site, so the shipping rule, the
 * receipt's rendering of it, and any test all read the same list.
 *
 * `DUPLICATE_PAYMENT` is here because a buyer charged twice paid carriage once;
 * withholding shipping on the duplicate would keep money for a service nobody
 * rendered. `CUSTOMER_REQUEST` is not: the buyer changed their mind, and the
 * carriage still happened.
 */
export const SELLER_FAULT_REFUND_REASONS: readonly RefundReasonCode[] = [
  "PRODUCT_FAILURE",
  "DUPLICATE_PAYMENT",
  "OPERATOR_CORRECTION",
];

/**
 * How a buyer starts a refund.
 *
 * Bounded, because the receipt has to tell them what to do and "it depends" is
 * not an instruction. The prose that accompanies it lives in the document's
 * `PROCEDURE` section; this decides which *route* is authoritative.
 */
export const REFUND_PROCEDURE_KINDS = [
  /** Contact the seller through their canonical Monacado support contact. */
  "CONTACT_SELLER_SUPPORT",
  /** Raise it with Monacado, which mediates. */
  "MONACADO_MEDIATED",
] as const;
export const RefundProcedureKind = z.enum(REFUND_PROCEDURE_KINDS);
export type RefundProcedureKind = z.infer<typeof RefundProcedureKind>;

/**
 * The terms code actually enforces.
 *
 * Separate from the document because these decide outcomes. Every one is
 * bounded; none is free text.
 */
export const SellerRefundTerms = z.strictObject({
  /**
   * Whether the seller offers refunds at all.
   *
   * `false` is a legitimate declared position and is disclosed as such. It does
   * **not** mean Monacado cannot refund — see `MARKETPLACE_REFUND_POSTURE`.
   */
  refundsAllowed: z.boolean(),
  /**
   * The conditions the seller declares. At least one when refunds are allowed;
   * empty when they are not, because conditions on nothing are not conditions.
   */
  eligibilityConditions: z.array(RefundEligibilityCondition).max(REFUND_ELIGIBILITY_CONDITIONS.length),
  /**
   * Days from the sale within which a refund may be claimed.
   *
   * `null` means **no declared window**, which is not the same as zero: zero
   * would mean refunds expire instantly, and a seller who declared nothing has
   * not declared that. `refundWindowIsOpen` treats `null` as always open.
   */
  refundWindowDays: z.int().min(1).max(3_650).nullable(),
  shippingRefundability: ShippingRefundability,
  procedureKind: RefundProcedureKind,
});
export type SellerRefundTerms = z.infer<typeof SellerRefundTerms>;

// — The disclosed document —

/**
 * The sections a seller's policy document may carry.
 *
 * Closed, so a receipt renders a known shape rather than whatever a seller
 * pasted, and so "the complete applicable policy" is a checkable claim.
 */
export const SELLER_REFUND_POLICY_SECTION_KEYS = [
  /** What the seller will and will not refund. */
  "SUMMARY",
  /** The conditions in the seller's own words. */
  "ELIGIBILITY",
  /** How long a buyer has. */
  "WINDOW",
  /** What happens to the shipping charge. */
  "SHIPPING",
  /** **Required.** What the buyer actually does to start a refund. */
  "PROCEDURE",
  /** Anything else the seller declares, bounded in length. */
  "ADDITIONAL_TERMS",
] as const;
export const SellerRefundPolicySectionKey = z.enum(SELLER_REFUND_POLICY_SECTION_KEYS);
export type SellerRefundPolicySectionKey = z.infer<typeof SellerRefundPolicySectionKey>;

/** Sections without which a policy cannot be recorded. */
export const REQUIRED_SELLER_REFUND_POLICY_SECTIONS: readonly SellerRefundPolicySectionKey[] = [
  "SUMMARY",
  "PROCEDURE",
];

export const SellerRefundPolicySection = z.strictObject({
  key: SellerRefundPolicySectionKey,
  heading: z.string().min(1).max(200),
  /**
   * The seller's own words. Bounded in length, and the **only** free text
   * anywhere in this phase.
   *
   * It is admissible here and nowhere else for one reason: a buyer must be shown
   * the policy before purchase and again on the receipt, and a policy nobody can
   * read is not a disclosure. It is stored on an immutable version row, hashed,
   * and never used to decide anything — every enforced outcome comes from
   * `SellerRefundTerms`.
   */
  body: z.string().min(1).max(4_000),
});
export type SellerRefundPolicySection = z.infer<typeof SellerRefundPolicySection>;

export const SellerRefundPolicyDocument = z.strictObject({
  title: z.string().min(1).max(200),
  sections: z.array(SellerRefundPolicySection).min(1).max(SELLER_REFUND_POLICY_SECTION_KEYS.length),
});
export type SellerRefundPolicyDocument = z.infer<typeof SellerRefundPolicyDocument>;

export function selectSellerRefundSection(
  document: SellerRefundPolicyDocument,
  key: SellerRefundPolicySectionKey,
): SellerRefundPolicySection | null {
  return document.sections.find((s) => s.key === key) ?? null;
}

// — Errors —

export class SellerRefundPolicyError extends Error {
  readonly code: string;
  readonly detail: readonly string[];
  constructor(code: string, message: string, detail: readonly string[] = []) {
    super(message);
    this.name = "SellerRefundPolicyError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * A document that contradicts the terms it accompanies is refused.
 *
 * The failure this prevents is specific and nasty: a seller whose enforced terms
 * say shipping is never refunded and whose prose promises it back. Whichever a
 * buyer read, one of them was a lie, and the buyer read the prose.
 *
 * Only **structural** disagreements are checkable — a required section missing,
 * or a window described where none is declared. Nothing here reads the prose for
 * meaning, and nothing pretends to.
 */
export function sellerRefundPolicyIssues(input: {
  terms: SellerRefundTerms;
  document: SellerRefundPolicyDocument;
}): string[] {
  const issues: string[] = [];

  for (const key of REQUIRED_SELLER_REFUND_POLICY_SECTIONS) {
    if (selectSellerRefundSection(input.document, key) === null) {
      issues.push(`missing-section:${key}`);
    }
  }

  if (input.terms.refundsAllowed && input.terms.eligibilityConditions.length === 0) {
    /* "Refunds allowed, on no stated condition" tells a buyer nothing about
       whether theirs qualifies. `ANY_REASON` is how a seller says "no
       conditions", and it is one of the members. */
    issues.push("eligibility-conditions-required");
  }
  if (!input.terms.refundsAllowed && input.terms.eligibilityConditions.length > 0) {
    issues.push("eligibility-conditions-unexpected");
  }
  if (!input.terms.refundsAllowed && input.terms.refundWindowDays !== null) {
    /* A window on a policy that refunds nothing is a term that can never apply. */
    issues.push("refund-window-unexpected");
  }
  if (input.terms.refundWindowDays !== null) {
    if (selectSellerRefundSection(input.document, "WINDOW") === null) {
      issues.push("missing-section:WINDOW");
    }
  }
  if (selectSellerRefundSection(input.document, "SHIPPING") === null) {
    /* Shipping refundability always has an answer, so it always needs disclosing.
       A buyer who cannot tell whether carriage comes back has not been told the
       policy. */
    issues.push("missing-section:SHIPPING");
  }

  const seen = new Set<string>();
  for (const section of input.document.sections) {
    if (seen.has(section.key)) issues.push(`duplicate-section:${section.key}`);
    seen.add(section.key);
  }

  return issues;
}

export function documentAgreesWithTerms(input: {
  terms: SellerRefundTerms;
  document: SellerRefundPolicyDocument;
}): boolean {
  return sellerRefundPolicyIssues(input).length === 0;
}

// — The version record —

/**
 * One immutable governed version of one seller's refund policy.
 *
 * `RETIRED` stays **readable and bindable**, exactly as
 * `MarketplacePolicyVersionRow` requires: an Order sold under version 1 must stay
 * explicable after the seller publishes version 2, and a receipt that could not
 * render a retired version would be a receipt that stops working when a seller
 * updates their terms.
 */
export const SellerRefundPolicyVersionRecord = z.strictObject({
  policyId: SellerRefundPolicyId,
  policyVersion: SellerRefundPolicyVersion,
  sellerParticipantId: ParticipantId,
  status: PolicyVersionStatus,
  terms: SellerRefundTerms,
  document: SellerRefundPolicyDocument,
  /** `sha256:<hex>` over the canonical JSON of terms + document. */
  contentHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  effectiveFrom: z.iso.datetime(),
  recordedByAccountId: z.string().min(1).max(191),
  recordedAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable(),
  retiredAt: z.iso.datetime().nullable(),
});
export type SellerRefundPolicyVersionRecord = z.infer<typeof SellerRefundPolicyVersionRecord>;

// — Decisions —

/**
 * Whether the seller's declared window is still open for this sale.
 *
 * `null` days means **no declared window**, which is always open — deliberately
 * not "expired", because a seller who declared nothing has not declared that a
 * buyer is out of time.
 *
 * Measured from the instant of sale, which is the Order's `paidAt` and not a
 * clock read. Both instants are supplied.
 */
export function refundWindowIsOpen(input: {
  refundWindowDays: number | null;
  paidAt: string;
  at: string;
}): boolean {
  if (input.refundWindowDays === null) return true;
  const deadline =
    new Date(input.paidAt).getTime() + input.refundWindowDays * 24 * 60 * 60 * 1_000;
  return new Date(input.at).getTime() <= deadline;
}

/**
 * Whether the buyer's shipping charge comes back on this refund.
 *
 * **The single implementation of the shipping rule**, so the amount derivation,
 * the reconciler, the receipt, and a test all reach the same answer from the same
 * inputs rather than four places agreeing by accident.
 *
 * Note what it does *not* do: it never prorates, never splits, and never returns
 * "some". Shipping is a whole charge for a whole carriage, and the phase that
 * needs to allocate it across a partially-refunded basket must decide the rule
 * first — see `SHIPPING_ALLOCATION_SEAM`.
 */
export function shippingIsRefundable(input: {
  shippingRefundability: ShippingRefundability;
  reasonCode: RefundReasonCode;
}): boolean {
  switch (input.shippingRefundability) {
    case "ALWAYS_REFUNDED":
      return true;
    case "NEVER_REFUNDED":
      return false;
    case "REFUNDED_WHEN_SELLER_AT_FAULT":
      return SELLER_FAULT_REFUND_REASONS.includes(input.reasonCode);
  }
}

/**
 * The shipping-allocation question this phase refuses to answer.
 *
 * Stated as data because the tempting answers are all wrong and all look
 * reasonable. Shipping is charged once for one carriage; when only some lines of
 * a basket come back, *which* part of that carriage was for them is not
 * arithmetic — it is a commercial ruling with different winners depending on
 * whether you allocate by weight, by value, by line count, or not at all.
 *
 * So `1.9` **fails closed** on that case rather than prorating. Today no Order
 * has more than one line, so the refusal is unreachable in practice and present
 * in principle — which is the point: the rule is in the architecture before the
 * basket exists, rather than being invented by whoever builds it.
 */
export const SHIPPING_ALLOCATION_SEAM = {
  wholeOrderRefund: "GOVERNED_BY_SELLER_POLICY",
  subsetOfLinesRefund: "REFUSED_PENDING_GOVERNED_ALLOCATION_RULE",
  proration: "REFUSED",
  refusalCode: "SHIPPING_ALLOCATION_NOT_GOVERNED",
  candidateRulesRequiringARuling: [
    "ALLOCATE_BY_LINE_VALUE",
    "ALLOCATE_BY_LINE_WEIGHT",
    "ALLOCATE_EVENLY_PER_LINE",
    "REFUND_SHIPPING_ONLY_WHEN_EVERY_LINE_RETURNS",
    "NEVER_REFUND_SHIPPING_ON_A_PARTIAL_BASKET",
  ],
  owner: "MONACADO_MOR_BUSINESS_MODEL_SECTION_I",
} as const;

// — Marketplace posture —

/**
 * The marketplace-level rule, stated as data so it is checkable rather than
 * merely written down somewhere.
 *
 * Deliberately contains **no jurisdiction-specific legal conclusion**. It records
 * the division of authority Monacado operates under; it does not purport to
 * decide what any particular buyer is owed under any particular law.
 */
export const MARKETPLACE_REFUND_POSTURE = {
  /** The seller declares the terms. Monacado does not author them. */
  policyOwner: "SELLER",
  /** Monacado enforces the version that governed the purchase, not the current one. */
  enforcedVersion: "BOUND_AT_PURCHASE",
  /** Shipping refundability follows that seller policy. */
  shippingRefundability: "SELLER_POLICY_GOVERNED",
  /** Shown before purchase and again on the receipt. */
  disclosure: ["BEFORE_PURCHASE", "ON_RECEIPT"],
  /**
   * Monacado is merchant of record and retains operational authority to execute
   * or refuse a refund under the bound policy and applicable law. A seller's
   * `refundsAllowed: false` is a disclosed seller position, not a ceiling on
   * what Monacado may do.
   */
  monacadoOperationalAuthority: "RETAINED",
  /**
   * Buyer statutory rights, where applicable, are **not overridden** by a
   * seller's declared terms. What those rights are, and where, is a legal
   * question this repository does not answer.
   */
  statutoryRights: "NOT_OVERRIDDEN_BY_SELLER_POLICY",
  jurisdictionSpecificConclusions: "NONE_ASSERTED",
  /**
   * Whether the governing Marketplace Policy document itself needs a new version
   * to state this to participants.
   *
   * **It does**, and this phase does not silently mutate an already-governing
   * version to do it. The requirement is recorded here and in
   * `REQUIRED_MARKETPLACE_POLICY_NEXT_VERSION` rather than applied.
   */
  marketplacePolicyDocumentUpdate: "REQUIRED_IN_A_LATER_GOVERNED_VERSION",
} as const;

/**
 * What the next Marketplace Policy version must say, recorded rather than
 * applied.
 *
 * `MarketplacePolicyVersionRow` is immutable by construction and version 1 is
 * ACTIVE and accepted by participants. Editing its content to describe refund
 * governance would be exactly the "edited policy under an unchanged version
 * number" that model exists to make impossible — and it would silently change
 * what people already agreed to.
 *
 * So this phase records the requirement. Publishing it is a governed act by
 * whoever owns the marketplace terms, through the existing versioning path, with
 * `requiresReacceptance` decided by them.
 */
export const REQUIRED_MARKETPLACE_POLICY_NEXT_VERSION = {
  reason: "PHASE_1_9_INTRODUCED_SELLER_REFUND_POLICY_GOVERNANCE",
  mutateActiveVersion: "REFUSED",
  sectionsRequiringNewText: ["REFUNDS_AND_CANCELLATION", "SELLER_OBLIGATIONS"],
  pointsToState: [
    "SELLER_DECLARES_AND_OWNS_THE_REFUND_POLICY",
    "MONACADO_ENFORCES_THE_VERSION_BOUND_AT_PURCHASE",
    "SHIPPING_REFUNDABILITY_FOLLOWS_THE_SELLER_POLICY",
    "POLICY_IS_DISCLOSED_BEFORE_PURCHASE_AND_ON_THE_RECEIPT",
    "MONACADO_RETAINS_OPERATIONAL_AUTHORITY_UNDER_APPLICABLE_LAW",
    "BUYER_STATUTORY_RIGHTS_ARE_NOT_OVERRIDDEN",
  ],
  requiresReacceptanceDecision: "OWNER_OF_MARKETPLACE_TERMS",
} as const;

// — Never on a seller refund policy —

/**
 * Named as never admissible, and refused by the `strictObject`s above.
 *
 * The proration and discretion fields are on this list for the reason every
 * other deferral list in this phase has one: they are precisely the columns that
 * would appear the day somebody implemented basket shipping allocation without
 * deciding the rule.
 */
export const NEVER_ON_SELLER_REFUND_POLICY = [
  // buyer identity — a policy is about terms, not about people
  "buyerName",
  "buyerEmail",
  "buyerAddress",
  // the seller's support address — resolved live through the canonical resolver,
  // never snapshotted, because a receipt must route to a mailbox that works today
  "supportEmail",
  "supportAddress",
  // allocation machinery — refused, see SHIPPING_ALLOCATION_SEAM
  "shippingProrationRule",
  "shippingAllocationBasis",
  "partialLineRefundRule",
  // unpredictable terms are not disclosed terms
  "atSellerDiscretion",
  "atMonacadoDiscretion",
  // restocking economics are a commercial decision nobody has ruled on
  "restockingFeeBasisPoints",
  "restockingFeeMinorUnits",
] as const;
