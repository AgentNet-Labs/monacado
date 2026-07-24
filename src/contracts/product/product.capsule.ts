/**
 * Creator-authoritative Product capsule (Phase 0B).
 *
 * The Product capsule is the canonical semantic representation of the enduring
 * product and its creator-authoritative facts (ADR §1, §2). It carries a NARROW
 * field set. Commercial terms (price, currency, discount, commission, validity,
 * territory), other authorities' assertions, and private/payment data are
 * excluded — enforced both by strict object schemas and by a denylist scan.
 *
 * Zod is the executable source of truth; the TypeScript type is inferred.
 */

import { z } from "zod";
import { baseCapsuleShape } from "../capsule/envelope";
import {
  capsuleVersionIriPattern,
  expectedCapsuleVersionIri,
  nodeIriPattern,
} from "../capsule/identity";
import { findForbiddenFields } from "../integrity/forbidden-fields";

export const PRODUCT_TYPE = "Product" as const;

/**
 * Enduring, Product-level availability (ADR §10.2). Broad lifecycle availability
 * only — never commercial offer terms, inventory, territory, or checkout
 * eligibility. schema.org `availability` is deliberately not reused: it is
 * Offer-associated and would blur the Product-versus-Offer boundary.
 */
export const GENERAL_AVAILABILITY_STATES = [
  "available",
  "unavailable",
  "pre-release",
  "discontinued",
] as const;
export const GeneralAvailabilityState = z.enum(GENERAL_AVAILABILITY_STATES);
export type GeneralAvailabilityState = z.infer<typeof GeneralAvailabilityState>;

/** Structured, creator-authored product facts. `specifications` is open but scanned. */
export const ProductData = z.strictObject({
  productVersion: z.int().min(1),
  promotable: z.boolean(),
  generalAvailabilityState: GeneralAvailabilityState,
  specifications: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
    .optional(),
  capabilities: z.array(z.string().min(1)).optional(),
});
export type ProductData = z.infer<typeof ProductData>;

/**
 * Product relationships: the authoritative creator (required) and an optional
 * REFERENCE to a future Offer node (reference only — no offer data inline).
 */
export const ProductRelationships = z.strictObject({
  creator: nodeIri("creator"),
  offer: nodeIri("offer").optional(),
});
export type ProductRelationships = z.infer<typeof ProductRelationships>;

function nodeIri(entity: "creator" | "offer") {
  return z.string().regex(nodeIriPattern(entity));
}

const productNodeIri = z.string().regex(nodeIriPattern("product"));
const productCapsuleVersionIri = z.string().regex(capsuleVersionIriPattern("product"));

/**
 * The Product capsule object shape (no cross-field refinements). Exposed for
 * derived JSON Schema generation, which represents structural constraints only.
 */
export const ProductCapsuleBase = z.strictObject({
  ...baseCapsuleShape,
  "@type": z.union([
    z.literal(PRODUCT_TYPE),
    z.array(z.string().min(1)).refine((arr) => arr.includes(PRODUCT_TYPE), {
      message: `@type must include "${PRODUCT_TYPE}"`,
    }),
  ]),
  "@id": productCapsuleVersionIri,
  subject: productNodeIri,
  data: ProductData,
  relationships: ProductRelationships,
  provenance: baseCapsuleShape.provenance.extend({
    authority: z.literal("creator"),
  }),
});

/**
 * The Product capsule. The base shape plus cross-field checks: @id/subject
 * agreement, supersession rules, and the forbidden-field scan.
 */
export const ProductCapsule = ProductCapsuleBase.superRefine((capsule, ctx) => {
    // @id must be exactly subject + /capsule/{capsuleVersion}
    const expected = expectedCapsuleVersionIri(capsule.subject, capsule.capsuleVersion);
    if (capsule["@id"] !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["@id"],
        message: `@id must equal ${expected} (subject + /capsule/${capsule.capsuleVersion})`,
      });
    }

    // Supersession rule (ADR §2): v1 has no predecessor; v>1 must reference it.
    if (capsule.capsuleVersion === 1) {
      if (capsule.supersedes !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["supersedes"],
          message: "capsuleVersion 1 must not declare supersedes",
        });
      }
    } else {
      const expectedPrev = expectedCapsuleVersionIri(
        capsule.subject,
        capsule.capsuleVersion - 1,
      );
      if (capsule.supersedes === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["supersedes"],
          message: `capsuleVersion ${capsule.capsuleVersion} requires supersedes = ${expectedPrev}`,
        });
      } else if (capsule.supersedes !== expectedPrev) {
        ctx.addIssue({
          code: "custom",
          path: ["supersedes"],
          message: `supersedes must reference the immediately prior capsule version ${expectedPrev}`,
        });
      }
    }

    // No foreign-authority or private/payment fields anywhere in the capsule.
    for (const finding of findForbiddenFields(capsule)) {
      ctx.addIssue({
        code: "custom",
        path: finding.path.split(/[.[\]]+/).filter(Boolean),
        message: `Forbidden field "${finding.key}" at ${finding.path} (${finding.reason}); it belongs to another capsule/authority, not the creator Product capsule.`,
      });
    }
  });

export type ProductCapsule = z.infer<typeof ProductCapsule>;

export interface ValidationResult {
  ok: boolean;
  capsule?: ProductCapsule;
  errors?: string[];
}

/** Validate an unknown value as a Product capsule. */
export function validateProductCapsule(value: unknown): ValidationResult {
  const result = ProductCapsule.safeParse(value);
  if (result.success) return { ok: true, capsule: result.data };
  return {
    ok: false,
    errors: result.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    ),
  };
}
