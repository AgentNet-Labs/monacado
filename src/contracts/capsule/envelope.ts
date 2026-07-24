/**
 * Reusable base capsule envelope (ADR §6; CDD Appendix C baseline).
 *
 * Zod is the single executable source of truth for structure (ADR §8).
 * TypeScript types are inferred from these schemas — no hand-maintained
 * interfaces. Semantic meaning lives in the ontology/context, not here.
 *
 * This module exports the shared building blocks (context, provenance,
 * lifecycle, revocation) and `baseCapsuleShape`, a field map that entity
 * capsules compose with `z.strictObject({ ...baseCapsuleShape, ...overrides })`.
 */

import { z } from "zod";

/** Capsule lifecycle states (ADR §2 — capsule-level, not marketplace-level). */
export const LIFECYCLE_STATES = [
  "draft",
  "active",
  "superseded",
  "revoked",
  "retired",
] as const;
export const LifecycleState = z.enum(LIFECYCLE_STATES);
export type LifecycleState = z.infer<typeof LifecycleState>;

/** Authority classes (ADR §2). Each capsule is authored by exactly one. */
export const AUTHORITY_CLASSES = ["creator", "promoter", "monacado", "buyer"] as const;
export const AuthorityClass = z.enum(AUTHORITY_CLASSES);
export type AuthorityClass = z.infer<typeof AuthorityClass>;

/**
 * `@context` value: a reference IRI to the context document, an inline context
 * object, or an array combining them.
 */
export const ContextValue = z.union([
  z.url(),
  z.record(z.string(), z.unknown()),
  z.array(z.union([z.url(), z.record(z.string(), z.unknown())])).min(1),
]);

/** `@type`: a single type or a non-empty list of types. */
export const TypeValue = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);

/**
 * Provenance: authorship + integrity trail. `contentHash` is DERIVED and is
 * excluded from the capsule's own hash input (see ../integrity/hash.ts).
 * Note there is no `verifiedBy` here — verification is Monacado authority and
 * belongs to a future MarketplaceVerification capsule, not a creator capsule.
 */
export const Provenance = z.strictObject({
  authority: AuthorityClass,
  createdBy: z.url(),
  contentHash: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/)
    .optional(),
});
export type Provenance = z.infer<typeof Provenance>;

/** Revocation record, present only when a capsule is revoked. */
export const Revocation = z.strictObject({
  revokedAt: z.iso.datetime(),
  reason: z.string().min(1),
});
export type Revocation = z.infer<typeof Revocation>;

/**
 * Base capsule field map. Entity capsules override `@type`, `@id`, `subject`,
 * `data`, `relationships`, and `provenance.authority` with entity-specific
 * constraints, then attach cross-field refinements.
 */
export const baseCapsuleShape = {
  "@context": ContextValue,
  "@type": TypeValue,
  /** capsule-version IRI (identifies THIS version). */
  "@id": z.url(),
  capsuleVersion: z.int().min(1),
  /** enduring node IRI (identifies the entity). */
  subject: z.url(),
  name: z.string().min(1),
  description: z.string().min(1).optional(),
  image: z.url().optional(),
  data: z.record(z.string(), z.unknown()),
  relationships: z.record(z.string(), z.unknown()),
  provenance: Provenance,
  metadata: z.record(z.string(), z.unknown()),
  lifecycle: LifecycleState,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  supersedes: z.url().optional(),
  revocation: Revocation.optional(),
} as const;
