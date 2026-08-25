/**
 * Capsule visibility governance (Phase 1.7).
 *
 * Until now every capsule this repository projected was public by intent —
 * Product, Storefront, Offer, Listing all exist to be **found**. `1.7` projects
 * the first capsule that exists to be **reasoned about**, and that difference
 * needs a governing rule rather than a per-capsule habit.
 *
 * ## The two purposes
 *
 * | Visibility | What it is for |
 * | --- | --- |
 * | `PUBLIC` | **discoverability** — the artifact a resolver returns to anyone |
 * | `PRIVATE` | **research, reconciliation, audit, and internal agentic workflow** |
 *
 * A private capsule is not a public one that happens to be unpublished. It is a
 * deterministic projection of authoritative Monacado records made available to
 * *internal* readers — a reconciliation agent, a tax-exception investigation, a
 * refund's reasoning — under Monacado's own authority, and it is never handed to
 * the public resolver.
 *
 * ## Why the default is not "unset"
 *
 * There is no third member and no absent case. A capsule shape declares its
 * visibility, and a shape that did not would eventually be published by whoever
 * wired the next publisher, on the reasonable assumption that capsules are for
 * publishing. `capsuleVisibilityFor` is total: every known shape has an answer.
 *
 * ## Making one public is a decision, never a default
 *
 * Nothing here publishes anything, and nothing here *can*. Changing a private
 * shape to public requires editing this file in the open — the same construction
 * `STRIPE_MODES` uses for live payments, and for the same reason: the dangerous
 * transition should be a reviewable diff rather than a flag somebody set.
 *
 * For a tax transaction specifically, public disclosure would need a separate
 * governance decision about what a jurisdiction, a taxable basis, and a Product
 * classification reveal **in aggregate** about a seller's business — a question
 * about disclosure, not about capsule mechanics, and not one a projection module
 * should answer by default.
 *
 * Pure types and pure decisions. No I/O, no publication, no resolver.
 */

import { z } from "zod";

export const CAPSULE_VISIBILITIES = ["PUBLIC", "PRIVATE"] as const;
export const CapsuleVisibility = z.enum(CAPSULE_VISIBILITIES);
export type CapsuleVisibility = z.infer<typeof CapsuleVisibility>;

/**
 * Every capsule shape this repository projects, and what it is for.
 *
 * Kept as one table rather than a property on each shape, so the whole disclosure
 * posture is readable in one place — and so adding a shape without deciding its
 * visibility fails to compile rather than defaulting.
 */
export const CAPSULE_VISIBILITY_POLICY = {
  /** Discoverability. The public artifact a Product's Node resolves to. */
  Product: "PUBLIC",
  Storefront: "PUBLIC",
  Offer: "PUBLIC",
  Listing: "PUBLIC",
  /**
   * **Private.** Research, reconciliation, audit, tax-exception investigation,
   * refund and reversal reasoning, and internal agentic workflows.
   *
   * Never public by default, and never published by this phase at all.
   */
  TaxTransaction: "PRIVATE",
} as const satisfies Record<string, CapsuleVisibility>;

export type GovernedCapsuleType = keyof typeof CAPSULE_VISIBILITY_POLICY;

export function capsuleVisibilityFor(type: GovernedCapsuleType): CapsuleVisibility {
  return CAPSULE_VISIBILITY_POLICY[type];
}

export function isPubliclyDiscoverable(type: GovernedCapsuleType): boolean {
  return capsuleVisibilityFor(type) === "PUBLIC";
}

/**
 * What must be true before any private capsule shape becomes public.
 *
 * Stated as a value so a later reader can check what was claimed against what was
 * done. Nothing enforces this in code — it is a governance requirement, and the
 * only mechanism that enforces it is that the change is a visible diff to
 * `CAPSULE_VISIBILITY_POLICY` above.
 */
export const PUBLIC_DISCLOSURE_REQUIREMENTS = {
  /** An explicit, recorded governance decision. Not an engineering default. */
  governanceDecision: "REQUIRED",
  /** What the fields disclose in aggregate, not merely one at a time. */
  aggregateDisclosureReview: "REQUIRED",
  /** Whether the parties described consented to that disclosure. */
  partyConsentReview: "REQUIRED",
  /** Phase 1.7 publishes nothing, public or private. */
  publicationInThisPhase: "NONE",
} as const;
