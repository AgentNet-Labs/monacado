/**
 * Versioned JSON-LD context for the Product capsule (Phase 0B).
 *
 * The context maps the compact JSON terms used inside a capsule onto their
 * schema.org or Monacado ontology IRIs. Per ADR §4, semantic meaning lives in
 * the ontology/context (this layer), NOT in Zod. schema.org keywords `@context`,
 * `@type`, and `@id` are JSON-LD reserved keywords and are intentionally not
 * remapped.
 *
 * This object is what would be served at COMMERCE_CONTEXT_DOCUMENT once hosted.
 * It is bundled locally so validation, tests, and the demo require no network.
 */

import {
  COMMERCE_CONTEXT_DOCUMENT,
  MON_NS,
  SCHEMA_ORG,
} from "./commerce.ontology";

/** The JSON-LD context document body (the value of a capsule's `@context`). */
export const COMMERCE_CONTEXT = {
  "@version": 1.1,
  schema: SCHEMA_ORG,
  mon: MON_NS,

  // schema.org reuse
  Product: "schema:Product",
  name: "schema:name",
  description: "schema:description",
  image: { "@id": "schema:image", "@type": "@id" },

  // envelope / framework terms
  capsuleVersion: "mon:capsuleVersion",
  subject: { "@id": "mon:subject", "@type": "@id" },
  data: "mon:data",
  relationships: "mon:relationships",
  provenance: "mon:provenance",
  metadata: "mon:metadata",
  lifecycle: "mon:lifecycle",
  createdAt: { "@id": "mon:createdAt", "@type": "schema:DateTime" },
  updatedAt: { "@id": "mon:updatedAt", "@type": "schema:DateTime" },
  supersedes: { "@id": "mon:supersedes", "@type": "@id" },
  revocation: "mon:revocation",
  authority: "mon:authority",
  createdBy: { "@id": "mon:createdBy", "@type": "@id" },
  contentHash: "mon:contentHash",

  // product domain terms
  productVersion: "mon:productVersion",
  promotable: "mon:promotable",
  generalAvailabilityState: "mon:generalAvailabilityState",
  specifications: "mon:specifications",
  capabilities: "mon:capabilities",
  creator: { "@id": "mon:creator", "@type": "@id" },
  offer: { "@id": "mon:offer", "@type": "@id" },
} as const;

/**
 * The value placed in a capsule's `@context`. A capsule references the
 * provisional context document IRI (a design target); consumers resolve it to
 * COMMERCE_CONTEXT above. Kept as a string reference so the capsule stays
 * compact and the context can evolve independently.
 */
export const COMMERCE_CONTEXT_REF = COMMERCE_CONTEXT_DOCUMENT;

/** Terms defined by the local context (used for validation/consistency checks). */
export const CONTEXT_TERMS: readonly string[] = Object.keys(COMMERCE_CONTEXT).filter(
  (k) => !k.startsWith("@") && k !== "schema" && k !== "mon",
);
