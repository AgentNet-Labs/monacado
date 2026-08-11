/**
 * Storefront Capsule Projection Shape (Phase 0M.3B).
 *
 * The strict public representation produced from **one explicitly identified
 * immutable `StorefrontSourceVersion`**. It is a projection, not a record: it
 * asserts nothing the database does not already hold, and nothing here can be
 * written back (ADR §12).
 *
 * Five properties shape everything below:
 *
 *   1. **The envelope is the established one.** Exactly `@context`, `@type`,
 *      `metadata`, `data` (ANS §3), with every metadata member reused from
 *      `capsule/envelope.ts`. No second envelope convention is invented, and the
 *      shape mirrors the Offer projection field for field where the concepts
 *      coincide.
 *
 *   2. **The public field set was decided in 0M.3A, not here.** It is exactly
 *      `PROJECTION_ELIGIBLE_STOREFRONT_FIELDS`, and a test proves the two agree.
 *      This phase invents no Storefront fact; where the source model said a fact
 *      reaches a capsule "only through Registrar-issued Node bindings", it does.
 *
 *   3. **Governance is absent, permanently.** No `SUPER_OWNER`, no `ADMIN`, no
 *      governance assignment, no authorizing actor. Who administers a storefront
 *      is nobody's business but the marketplace's — publishing it would disclose
 *      an organization's internal structure as a side effect of listing a shop
 *      (0M.3A `NEVER_PROJECTION_ELIGIBLE_STOREFRONT_DATA`).
 *
 *   4. **`publishedBy`, `publishedAt`, `supersedes`, and `revokes` are absent.**
 *      Those are publication facts, and this phase publishes nothing. A
 *      projection that carried them would be asserting an event that never
 *      happened.
 *
 *   5. **No Listing, Product, or Offer claim appears.** A Storefront holds no
 *      Listings in the source model, and it does not acquire any by being
 *      projected. Commercial terms belong to the Offer capsule and curation to a
 *      future Listing capsule; restating either here would create a second,
 *      divergent answer under the wrong authority (ADR §2).
 *
 * Pure data. No clock, no randomness, no I/O.
 */

import { z } from "zod";
import {
  AnsNodeId,
  CapsuleId,
  ContentHash,
  ContextValue,
  PolicyRef,
  ProvenanceRecord,
  SemVer,
} from "../capsule/envelope";
import { findInternalIdentifiers } from "../capsule/internal-identifiers";
import {
  MAX_DISPLAY_NAME_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TAGLINE_LENGTH,
  PublicHandle,
} from "./storefront-source";

export const STOREFRONT_TYPE = "Storefront" as const;

const StorefrontType = z.union([
  z.literal(STOREFRONT_TYPE),
  z.array(z.string().min(1)).refine((arr) => arr.includes(STOREFRONT_TYPE), {
    message: `@type must include "${STOREFRONT_TYPE}"`,
  }),
]);

// — Relationships —

/**
 * The one relationship a Storefront capsule asserts.
 *
 * `operatedBy` is the owner's **approved public authority Node**, supplied by the
 * projection context — never `mon:mpart:`, never an account, and never a legal
 * name. `AnsNodeId` structurally refuses a semantic or internal value, so a
 * participant id cannot be passed off as an authority Node.
 *
 * There is deliberately no `containsListing`, `offers`, or `product` member. A
 * Storefront references no Listing in the source model — Listings reference
 * Storefronts, not the reverse — and an array here would make every listing
 * change a Storefront change, and therefore a new Storefront source version.
 */
export const StorefrontRelationships = z.strictObject({
  operatedBy: AnsNodeId,
});
export type StorefrontRelationships = z.infer<typeof StorefrontRelationships>;

// — Data —

/**
 * The complete public Storefront claim set.
 *
 * `tagline` and `summary` are **omitted** when the source holds `null` — one
 * canonical public representation of absence, mirroring the Offer projection's
 * treatment of `validFrom`/`validThrough`. They are optional rather than
 * nullable, so an explicit `null` is refused and two spellings of "absent"
 * cannot coexist in a hashed artifact.
 *
 * `discoverable` is the only state fact published, and it is **derived**: it says
 * whether this storefront should appear in search and directories, which is the
 * single distinction a consumer can act on. The authoritative `lifecycle` and
 * `visibility` enums are **not** republished — a public vocabulary able to say
 * `SUSPENDED` or `PRIVATE` would invite projecting one, and only a live
 * storefront is projectable at all (see `storefront.projection`).
 */
export const StorefrontCapsuleDataBase = z.strictObject({
  /** The public routing name. Public by construction; never an internal id. */
  publicHandle: PublicHandle,
  /** schema.org `name` — the storefront's public display name. */
  name: z.string().trim().min(1).max(MAX_DISPLAY_NAME_LENGTH),
  /** schema.org `slogan` — present only when the source holds one. */
  slogan: z.string().trim().min(1).max(MAX_TAGLINE_LENGTH).optional(),
  /** schema.org `description` — present only when the source holds one. */
  description: z.string().trim().min(1).max(MAX_SUMMARY_LENGTH).optional(),
  /** Whether this storefront should be listed in discovery surfaces. */
  discoverable: z.boolean(),
  relationships: StorefrontRelationships,
});

export const StorefrontCapsuleData = StorefrontCapsuleDataBase;
export type StorefrontCapsuleData = z.infer<typeof StorefrontCapsuleData>;

// — Metadata —

/**
 * Projection-stage metadata — identical in shape to the Offer projection's.
 *
 * `capsuleId` and `bindsToNode` are **supplied by the projection context, not
 * issued here**: binding to an identifier someone else issued is not the same act
 * as issuing one (ADR §11.2).
 */
export const StorefrontProjectionMetadata = z.strictObject({
  capsuleId: CapsuleId,
  bindsToNode: AnsNodeId,
  version: SemVer,
  provenance: ProvenanceRecord,
  nodePolicy: PolicyRef,
  capsulePolicy: PolicyRef,
  contentHash: ContentHash,
});
export type StorefrontProjectionMetadata = z.infer<typeof StorefrontProjectionMetadata>;

// — The capsule —

export const StorefrontCapsuleProjectionBase = z.strictObject({
  "@context": ContextValue,
  "@type": StorefrontType,
  metadata: StorefrontProjectionMetadata,
  data: StorefrontCapsuleDataBase,
});

export const StorefrontCapsuleProjection = z
  .strictObject({
    "@context": ContextValue,
    "@type": StorefrontType,
    metadata: StorefrontProjectionMetadata,
    data: StorefrontCapsuleData,
  })
  .superRefine((capsule, ctx) => {
    for (const finding of findInternalIdentifiers(capsule)) {
      ctx.addIssue({
        code: "custom",
        path: finding.path.split(/[.[\]]+/).filter(Boolean),
        message: `Internal identifier (${finding.prefix}…) at ${finding.path} must never appear in a public capsule.`,
      });
    }
  });
export type StorefrontCapsuleProjection = z.infer<typeof StorefrontCapsuleProjection>;

export interface StorefrontValidationResult {
  ok: boolean;
  capsule?: StorefrontCapsuleProjection;
  errors?: string[];
}

export function validateStorefrontCapsuleProjection(value: unknown): StorefrontValidationResult {
  const result = StorefrontCapsuleProjection.safeParse(value);
  if (result.success) return { ok: true, capsule: result.data };
  return {
    ok: false,
    errors: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  };
}

// — Public field allow-list —

/**
 * Every key this capsule's `data` may carry, in one place.
 *
 * The allow-list **is** the privacy boundary: a field absent here has no schema
 * member, no mapper branch, and no way into the artifact. A test asserts this
 * agrees with the schema's own keys, so the two cannot drift — and a second test
 * asserts every 0M.3A-eligible source fact is either published here or
 * deliberately consumed as a Node binding.
 */
export const PUBLIC_STOREFRONT_CAPSULE_FIELDS = [
  "publicHandle",
  "name",
  "slogan",
  "description",
  "discoverable",
  "relationships",
] as const;
export type PublicStorefrontCapsuleField = (typeof PUBLIC_STOREFRONT_CAPSULE_FIELDS)[number];
