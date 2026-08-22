/**
 * Marketplace policy — authoritative, versioned, audience-projected (Phase 1.3).
 *
 * The rules every party undertakes when they use Monacado, held **once** and
 * rendered many ways.
 *
 * ## One source, many renderings
 *
 * Seller onboarding, promoter onboarding, a public terms page, a checkout
 * disclosure, a receipt, and a printable document are six *views* of one
 * authoritative version — never six documents. Maintaining a copy per channel is
 * how a marketplace ends up telling a seller one thing and a court another, and
 * the divergence is always discovered at the worst moment.
 *
 * So the policy is **structured content**, not prose in a column: an ordered list
 * of sections, each tagged with the audiences it concerns.
 * `selectSectionsForAudience` is the only projection, and every channel calls it.
 *
 * ## The version is the authority; the rendering never is
 *
 * A `MarketplacePolicyVersionRecord` governs *which* version stands. The content
 * itself lives in a versioned source module and is bound to the record by a
 * **content hash**, so "what exactly did this participant accept" is answerable
 * byte-for-byte years later, and prose cannot drift from the version that
 * governs it without the hash disagreeing.
 *
 * That is deliberately not a prose column. A mutable text field is editable in
 * place, and an edited policy with an unchanged version number is the one thing a
 * governance model must make impossible.
 *
 * ## What it is not
 *
 * It states **operating rules**, not legal conclusions. There is no jurisdiction
 * field, no warranty language, no liability cap, and no claim about which law
 * applies — those are decisions for counsel, and inventing them in a type
 * definition would be inventing legal advice.
 *
 * Pure types and pure decisions. No I/O, no clock, no storage.
 */

import { z } from "zod";
import { MARKETPLACE_POLICY_ID_RE } from "./identity";

// — Identity —

export const MarketplacePolicyId = z
  .string()
  .regex(MARKETPLACE_POLICY_ID_RE, "policyId must be mon:mpol:<opaque>");
export type MarketplacePolicyId = z.infer<typeof MarketplacePolicyId>;

export const MarketplacePolicyVersion = z.string().min(1).max(64);
export type MarketplacePolicyVersion = z.infer<typeof MarketplacePolicyVersion>;

// — Audiences —

/**
 * Who a section speaks to.
 *
 * A section may name **several**: "Monacado is the merchant of record" is a fact
 * a seller, a promoter, and a buyer each need, and duplicating it three times
 * would create three things to keep identical. Audiences select; they do not
 * partition.
 */
export const POLICY_AUDIENCES = ["SELLER", "PROMOTER", "BUYER"] as const;
export const PolicyAudience = z.enum(POLICY_AUDIENCES);
export type PolicyAudience = z.infer<typeof PolicyAudience>;

/** The audiences whose acceptance is required before activation. */
export const ACCEPTANCE_REQUIRED_AUDIENCES = ["SELLER", "PROMOTER"] as const;
export type AcceptanceRequiredAudience = (typeof ACCEPTANCE_REQUIRED_AUDIENCES)[number];

/**
 * A buyer accepts nothing to buy.
 *
 * Deliberate: gating a purchase behind a click-through would add friction to the
 * one flow that must not have it, and guest checkout has no durable identity to
 * record an acceptance against. Buyers are **disclosed to** — at checkout and on
 * the receipt — which is what the buyer-facing sections exist for.
 */
export const BUYER_ACCEPTANCE_MODEL = "DISCLOSURE_NOT_ACCEPTANCE" as const;

// — Sections —

/**
 * The closed set of section identifiers.
 *
 * Keys rather than free-form headings, because every downstream surface selects
 * by key: a checkout disclosure asks for `BUYER_CHECKOUT_INFORMATION` and must
 * keep working when the heading is reworded. A new section is an additive member
 * plus content; it is not a schema change.
 */
export const POLICY_SECTION_KEYS = [
  "MONACADO_ROLE",
  "SELLER_RESPONSIBILITIES",
  "PROMOTER_RESPONSIBILITIES",
  "DIGITAL_DELIVERY",
  "BUYER_CHECKOUT_INFORMATION",
  "COMMERCIAL_POLICY_REFERENCE",
  "POLICY_CHANGES",
] as const;
export const PolicySectionKey = z.enum(POLICY_SECTION_KEYS);
export type PolicySectionKey = z.infer<typeof PolicySectionKey>;

/**
 * A pointer to authority that lives elsewhere.
 *
 * The mechanism that stops this document duplicating figures it does not own.
 * Monacado's retention rate lives in `0M.R1`'s versioned commercial policy; the
 * download allowance lives in `1.2`'s delivery policy. Copying either into prose
 * would create a second authority that can disagree — and the copy is always the
 * one somebody reads.
 */
export const POLICY_REFERENCE_KINDS = [
  /** The versioned `0M.R1` commercial policy bound to each Order. */
  "COMMERCIAL_POLICY",
  /** `1.2`'s digital delivery policy constants. */
  "DIGITAL_DELIVERY_POLICY",
  /** Another section of this same document. */
  "POLICY_SECTION",
] as const;
export const PolicyReferenceKind = z.enum(POLICY_REFERENCE_KINDS);

export const PolicyReference = z.strictObject({
  kind: PolicyReferenceKind,
  /** What is being pointed at. Opaque here; never parsed by this module. */
  ref: z.string().min(1).max(191),
  /** Why a reader is being sent there. */
  note: z.string().min(1).max(400),
});
export type PolicyReference = z.infer<typeof PolicyReference>;

/**
 * One section of the policy.
 *
 * `paragraphs` are plain text and carry **no markup**: the same content has to
 * render into HTML, a receipt, and a printable document, and prose containing one
 * channel's markup renders wrongly in the other two.
 */
export const PolicySection = z.strictObject({
  key: PolicySectionKey,
  heading: z.string().min(1).max(200),
  /** Every audience this section concerns. At least one. */
  audiences: z.array(PolicyAudience).min(1).max(POLICY_AUDIENCES.length),
  paragraphs: z.array(z.string().min(1).max(4_000)).min(1).max(50),
  references: z.array(PolicyReference).max(20),
});
export type PolicySection = z.infer<typeof PolicySection>;

/**
 * One complete, immutable policy document.
 *
 * The **authoritative content**. `contentHash` is derived from everything else by
 * `marketplacePolicyContentHash` and is what the governance row binds to.
 */
export const MarketplacePolicyDocument = z.strictObject({
  policyId: MarketplacePolicyId,
  policyVersion: MarketplacePolicyVersion,
  title: z.string().min(1).max(200),
  sections: z.array(PolicySection).min(1).max(100),
});
export type MarketplacePolicyDocument = z.infer<typeof MarketplacePolicyDocument>;

// — Projection —

/**
 * The sections one audience is shown, in document order.
 *
 * **The only projection.** Every channel calls it, so a seller's onboarding page
 * and a printable seller document cannot disagree about what a seller was told.
 * Order is the document's, never re-sorted per audience: a policy read in a
 * different order is a different policy.
 */
export function selectSectionsForAudience(
  document: MarketplacePolicyDocument,
  audience: PolicyAudience,
): PolicySection[] {
  return document.sections.filter((section) => section.audiences.includes(audience));
}

/** The section with this key, or `null`. Used by narrow surfaces like a receipt. */
export function selectSection(
  document: MarketplacePolicyDocument,
  key: PolicySectionKey,
): PolicySection | null {
  return document.sections.find((section) => section.key === key) ?? null;
}

// — Content hash —

export const PolicyContentHash = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export type PolicyContentHash = z.infer<typeof PolicyContentHash>;

// — Governance record —

/**
 * `0M.R1`'s version lifecycle, reused rather than restated.
 *
 * `RETIRED` remains readable and bindable by historical reference: a participant
 * who accepted version 1 must still be able to see what they accepted, and an
 * Order priced under it must stay explicable.
 */
export const POLICY_VERSION_STATUSES = ["DRAFT", "ACTIVE", "RETIRED"] as const;
export const PolicyVersionStatus = z.enum(POLICY_VERSION_STATUSES);
export type PolicyVersionStatus = z.infer<typeof PolicyVersionStatus>;

/**
 * One governed version of the marketplace policy.
 *
 * `contentRef` names the source module and `contentHash` pins its exact bytes.
 * Together they answer "what precisely was in force" without putting editable
 * prose in a column — an edited policy under an unchanged version number is the
 * one thing this model exists to make impossible.
 */
export const MarketplacePolicyVersionRecord = z.strictObject({
  policyId: MarketplacePolicyId,
  policyVersion: MarketplacePolicyVersion,
  status: PolicyVersionStatus,
  title: z.string().min(1).max(200),
  /** Stable identifier of the source content, e.g. `marketplace-policy/1.0.0`. */
  contentRef: z.string().min(1).max(191),
  contentHash: PolicyContentHash,
  /**
   * Whether adopting this version requires participants to accept again.
   *
   * A **material** change does; a typographical correction does not. Recording it
   * on the version rather than deciding it at read time means the judgement is
   * made once, by whoever published the version, and is auditable afterwards.
   */
  requiresReacceptance: z.boolean(),
  effectiveFrom: z.iso.datetime(),
  recordedByAccountId: z.string().min(1).max(191),
  recordedAt: z.iso.datetime(),
  activatedAt: z.iso.datetime().nullable(),
  retiredAt: z.iso.datetime().nullable(),
});
export type MarketplacePolicyVersionRecord = z.infer<typeof MarketplacePolicyVersionRecord>;

// — Acceptance —

/**
 * How a participant's acceptance was obtained.
 *
 * Bounded, because "how did they agree" is exactly the question a dispute turns
 * on, and free text would make one acceptance unanswerable against another.
 */
export const ACCEPTANCE_MECHANISMS = [
  /** An explicit affirmative action in a Monacado onboarding surface. */
  "ONBOARDING_AFFIRMATION",
  /** Recorded by an authorised Monacado operator on the participant's behalf. */
  "OPERATOR_RECORDED",
] as const;
export const AcceptanceMechanism = z.enum(ACCEPTANCE_MECHANISMS);
export type AcceptanceMechanism = z.infer<typeof AcceptanceMechanism>;

/**
 * One participant's acceptance of one exact policy version, as one audience.
 *
 * **Immutable, and never superseded in place.** A newer version becoming `ACTIVE`
 * does not touch this row: history has to stay queryable, because "they accepted
 * the terms" is worthless without "which terms, and when".
 *
 * Audience is part of the identity because the undertakings differ — a
 * participant holding both roles accepts as each, and one acceptance standing in
 * for the other would record an agreement nobody made.
 */
export const ParticipantPolicyAcceptanceRecord = z.strictObject({
  acceptanceId: z.string().min(1).max(191),
  participantId: z.string().min(1).max(191),
  policyId: MarketplacePolicyId,
  policyVersion: MarketplacePolicyVersion,
  audience: z.enum(ACCEPTANCE_REQUIRED_AUDIENCES),
  /** The exact bytes accepted, so the record survives any later source move. */
  contentHash: PolicyContentHash,
  mechanism: AcceptanceMechanism,
  acceptedAt: z.iso.datetime(),
  /** The account that performed the acceptance. Never a display name. */
  acceptedByAccountId: z.string().min(1).max(191),
  recordedAt: z.iso.datetime(),
});
export type ParticipantPolicyAcceptanceRecord = z.infer<
  typeof ParticipantPolicyAcceptanceRecord
>;

// — Never here —

/**
 * Named as never admissible on a policy document, version, or acceptance.
 *
 * The first group is **secrets**, which must never reach a document that is
 * rendered publicly. The second is **legal conclusions**, which are counsel's and
 * not a type definition's. The third is **mutable commercial figures**, which
 * have a versioned home and would become a second authority here.
 */
export const NEVER_ON_MARKETPLACE_POLICY = [
  // secrets — this content is rendered publicly
  "verificationToken",
  "tokenHash",
  "apiKey",
  "webhookSecret",
  "signingSecret",
  // legal conclusions — counsel's, not a contract module's
  "governingLaw",
  "jurisdiction",
  "warrantyDisclaimer",
  "liabilityCap",
  "arbitrationClause",
  // mutable commercial figures — 0M.R1 owns these
  "retainedPercentageBasisPoints",
  "retainedFixedAmountMinorUnits",
  "commissionBasisPoints",
] as const;
