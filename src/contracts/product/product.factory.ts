/**
 * Product capsule factory (Phase 0B).
 *
 * Constructs and revises creator-authoritative Product capsules. Generation
 * happens here at authoring/update time (ADR §5) — this module performs NO
 * publication, network, or database work. Callers supply explicit timestamps
 * and ULIDs so construction is deterministic and testable (synthetic data).
 */

import { COMMERCE_CONTEXT_REF } from "../ontology/commerce.context";
import { makeCapsuleVersionIri, makeNodeIri } from "../capsule/identity";
import { withContentHash } from "../integrity/hash";
import {
  assertCanWriteProductFacts,
  type Actor,
} from "./product.authority";
import {
  PRODUCT_TYPE,
  ProductCapsule,
  type ProductData,
  type ProductRelationships,
} from "./product.capsule";

export interface CreateProductInput {
  productUlid: string;
  name: string;
  description?: string;
  image?: string;
  data: ProductData;
  relationships: ProductRelationships;
  createdAt: string;
  updatedAt: string;
  /** The creator authoring the capsule. Must have role "creator". */
  actor: Actor;
  metadata?: Record<string, unknown>;
}

/** Create version 1 of a Product capsule (validated, content-hashed). */
export function createProductCapsule(input: CreateProductInput): ProductCapsule {
  assertCanWriteProductFacts(input.actor);

  const subject = makeNodeIri("product", input.productUlid);
  const capsuleVersion = 1;

  const draft = {
    "@context": COMMERCE_CONTEXT_REF,
    "@type": PRODUCT_TYPE,
    "@id": makeCapsuleVersionIri(subject, capsuleVersion),
    capsuleVersion,
    subject,
    name: input.name,
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.image !== undefined ? { image: input.image } : {}),
    data: input.data,
    relationships: input.relationships,
    provenance: {
      authority: "creator" as const,
      createdBy: input.actor.id,
    },
    metadata: input.metadata ?? {},
    lifecycle: "active" as const,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
  };

  const hashed = withContentHash(draft);
  return ProductCapsule.parse(hashed);
}

export interface ReviseProductInput {
  current: ProductCapsule;
  /** Partial creator-authored changes to name/description/image/data/relationships. */
  changes: Partial<
    Pick<
      ProductCapsule,
      "name" | "description" | "image" | "data" | "relationships" | "metadata"
    >
  >;
  updatedAt: string;
  actor: Actor;
}

export interface ReviseProductResult {
  /** The prior capsule, marked superseded. */
  superseded: ProductCapsule;
  /** The new active capsule version, referencing its predecessor. */
  next: ProductCapsule;
}

/**
 * Produce the next Product capsule version from creator changes, and return the
 * prior version marked superseded. Rejects unauthorized actors (ADR §2).
 */
export function reviseProductCapsule(input: ReviseProductInput): ReviseProductResult {
  assertCanWriteProductFacts(input.actor);

  const { current } = input;
  const nextVersion = current.capsuleVersion + 1;

  const nextDraft = {
    ...current,
    ...input.changes,
    capsuleVersion: nextVersion,
    "@id": makeCapsuleVersionIri(current.subject, nextVersion),
    supersedes: current["@id"],
    lifecycle: "active" as const,
    updatedAt: input.updatedAt,
    provenance: {
      authority: "creator" as const,
      createdBy: input.actor.id,
    },
  };
  // Remove any stale derived hash before recomputing.
  delete (nextDraft.provenance as Record<string, unknown>).contentHash;

  const next = ProductCapsule.parse(withContentHash(nextDraft));
  // Lifecycle is part of the hash input, so re-hash the superseded version.
  const superseded = ProductCapsule.parse(
    withContentHash({ ...current, lifecycle: "superseded" as const }),
  );

  return { superseded, next };
}
