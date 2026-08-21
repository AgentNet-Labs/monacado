/**
 * Creator-authoritative Product capsule — ANS-conformant (Phase 0B.1).
 *
 * Top-level members are exactly `@context`, `@type`, `metadata`, `data`
 * (ANS §3). Product facts live in `data`; identity, node binding, versioning,
 * publication, provenance, policy linkage, supersession/revocation, and
 * integrity live in `metadata`. The capsule carries NO lifecycle state.
 *
 * Two shapes: a pre-publication Candidate (data + source provenance) and a
 * finalised Published capsule (all mandatory ANS publication metadata).
 */

import { z } from "zod";
import {
  AnsNodeId,
  CandidateMetadata,
  ContextValue,
  PublishedMetadata,
} from "../capsule/envelope";
import { findForbiddenFields } from "../integrity/forbidden-fields";

export const PRODUCT_TYPE = "Product" as const;

const ProductType = z.union([
  z.literal(PRODUCT_TYPE),
  z.array(z.string().min(1)).refine((arr) => arr.includes(PRODUCT_TYPE), {
    message: `@type must include "${PRODUCT_TYPE}"`,
  }),
]);

/** Enduring, Product-level availability (ADR §10.2) — never offer-level. */
export const GENERAL_AVAILABILITY_STATES = [
  "available",
  "unavailable",
  "pre-release",
  "discontinued",
] as const;
export const GeneralAvailabilityState = z.enum(GENERAL_AVAILABILITY_STATES);
export type GeneralAvailabilityState = z.infer<typeof GeneralAvailabilityState>;

/** Product relationships (domain data): the authoritative creator, optional offer ref. */
export const ProductRelationships = z.strictObject({
  creator: AnsNodeId,
  offer: AnsNodeId.optional(),
});
export type ProductRelationships = z.infer<typeof ProductRelationships>;

/**
 * Product `data` — enduring, creator-authoritative facts only. Commercial terms
 * (price, currency, discount, commission, payout, territory, offer validity,
 * payment) are excluded and additionally rejected by the forbidden-field scan.
 */
/**
 * How a Product reaches its buyer — an **explicit, authoritative** fact.
 *
 * A closed two-member vocabulary, and deliberately the *only* place delivery is
 * decided. It is never inferred from `specifications`, `capabilities`, a name, or
 * a category: those are free-form and creator-supplied, and reading a checkout
 * rule out of one would make whether a buyer is asked for an address depend on
 * how somebody phrased a spec key.
 *
 * `DIGITAL` — delivered without shipping anything.
 * `PHYSICAL` — requires delivery to an address.
 *
 * A finer vocabulary (`SERVICE`, `MIXED`, per-variant modes) is deliberately
 * absent: the checkout question is binary — *does this need a shipping address* —
 * and members with no producer are promises the code does not keep.
 */
export const DELIVERY_MODES = ["DIGITAL", "PHYSICAL"] as const;
export const DeliveryMode = z.enum(DELIVERY_MODES);
export type DeliveryMode = z.infer<typeof DeliveryMode>;

export const ProductData = z.strictObject({
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  image: z.url().optional(),
  productVersion: z.int().min(1),
  promotable: z.boolean(),
  generalAvailabilityState: GeneralAvailabilityState,
  /**
   * How this Product is delivered. **Optional for backward compatibility only.**
   *
   * Every Product source version written before this fact existed has none, and
   * making it required would invalidate them retroactively — a source-version
   * model exists precisely so history stays readable.
   *
   * **Absence is not a default.** Checkout treats an unknown delivery mode as a
   * refusal, never as "probably digital": guessing would either demand an address
   * nobody needs or ship nothing to a buyer expecting a parcel.
   */
  deliveryMode: DeliveryMode.optional(),
  specifications: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
  capabilities: z.array(z.string().min(1)).optional(),
  relationships: ProductRelationships,
});
export type ProductData = z.infer<typeof ProductData>;

/** Reject foreign-authority / private / payment fields anywhere in the capsule. */
function forbiddenFieldRefine(capsule: unknown, ctx: z.RefinementCtx): void {
  for (const finding of findForbiddenFields(capsule)) {
    ctx.addIssue({
      code: "custom",
      path: finding.path.split(/[.[\]]+/).filter(Boolean),
      message: `Forbidden field "${finding.key}" at ${finding.path} (${finding.reason}); it belongs to another capsule/authority, not the creator Product capsule.`,
    });
  }
}

// — Candidate (pre-publication) —

export const ProductCapsuleCandidateBase = z.strictObject({
  "@context": ContextValue,
  "@type": ProductType,
  metadata: CandidateMetadata,
  data: ProductData,
});

export const ProductCapsuleCandidate = ProductCapsuleCandidateBase.superRefine(
  forbiddenFieldRefine,
);
export type ProductCapsuleCandidate = z.infer<typeof ProductCapsuleCandidate>;

// — Published (finalised, immutable) —

export const PublishedProductCapsuleBase = z.strictObject({
  "@context": ContextValue,
  "@type": ProductType,
  metadata: PublishedMetadata,
  data: ProductData,
});

export const PublishedProductCapsule = PublishedProductCapsuleBase.superRefine(
  (capsule, ctx) => {
    forbiddenFieldRefine(capsule, ctx);
    // Supersedes/revokes must reference a prior capsule ID, never self, never a
    // Node ID (the CapsuleId type already rejects Node IDs structurally).
    if (capsule.metadata.supersedes === capsule.metadata.capsuleId) {
      ctx.addIssue({
        code: "custom",
        path: ["metadata", "supersedes"],
        message: "supersedes must reference a prior capsule ID, not this capsule",
      });
    }
    if (capsule.metadata.revokes === capsule.metadata.capsuleId) {
      ctx.addIssue({
        code: "custom",
        path: ["metadata", "revokes"],
        message: "revokes must reference another capsule ID, not this capsule",
      });
    }
  },
);
export type PublishedProductCapsule = z.infer<typeof PublishedProductCapsule>;

export interface ValidationResult<T> {
  ok: boolean;
  capsule?: T;
  errors?: string[];
}

type SafeParse<T> = { success: true; data: T } | { success: false; error: z.ZodError };

function toResult<T>(result: SafeParse<T>): ValidationResult<T> {
  if (result.success) return { ok: true, capsule: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

export function validateProductCandidate(
  value: unknown,
): ValidationResult<ProductCapsuleCandidate> {
  return toResult(ProductCapsuleCandidate.safeParse(value));
}

export function validatePublishedProductCapsule(
  value: unknown,
): ValidationResult<PublishedProductCapsule> {
  return toResult(PublishedProductCapsule.safeParse(value));
}
