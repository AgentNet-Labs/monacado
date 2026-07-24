/**
 * Monacado commerce ontology — Product-only subset (Phase 0B).
 *
 * This module is the *semantic* layer: it names the terms a Product capsule
 * uses and records where each term's meaning comes from. Structure and runtime
 * validation live in the Zod layer (see ../capsule and ../product); this file
 * does not validate anything.
 *
 * Per docs/CDD_ARCHITECTURE_DECISIONS.md §4:
 *   - schema.org terms are reused where their meaning fits exactly and are NOT
 *     redefined here;
 *   - Monacado-specific terms use the provisional namespace below;
 *   - the namespace is independent of any document version, so compatible
 *     revisions do not change term identity;
 *   - the document URLs are DESIGN TARGETS ONLY. They are not live, resolvable,
 *     immutable, or approved AgentNet standards.
 */

export const SCHEMA_ORG = "https://schema.org/" as const;

/** Provisional Monacado commerce namespace (term identity; version-independent). */
export const MON_NS = "https://monacado.com/ns/commerce#" as const;

/**
 * Provisional document targets. DESIGN TARGETS ONLY — not hosted, not live,
 * not resolvable, not approved standards. Do not describe these as live.
 */
export const COMMERCE_ONTOLOGY_DOCUMENT =
  "https://monacado.com/ontology/commerce/v1" as const;
export const COMMERCE_CONTEXT_DOCUMENT =
  "https://monacado.com/context/commerce/v1" as const;

export type TermKind = "class" | "property";
export type TermSource = "schema.org" | "monacado";

export interface OntologyTerm {
  /** Compact term as it appears in capsule JSON. */
  term: string;
  /** Fully-qualified IRI the term maps to. */
  iri: string;
  kind: TermKind;
  source: TermSource;
  /** Concise semantic description. */
  description: string;
}

/**
 * schema.org terms reused verbatim. These are NOT redefined by Monacado; the
 * context simply maps the compact term onto the schema.org IRI.
 */
export const SCHEMA_ORG_TERMS: readonly OntologyTerm[] = [
  {
    term: "Product",
    iri: `${SCHEMA_ORG}Product`,
    kind: "class",
    source: "schema.org",
    description: "The enduring product entity a Product capsule describes.",
  },
  {
    term: "name",
    iri: `${SCHEMA_ORG}name`,
    kind: "property",
    source: "schema.org",
    description: "Human-readable product name.",
  },
  {
    term: "description",
    iri: `${SCHEMA_ORG}description`,
    kind: "property",
    source: "schema.org",
    description: "Human-readable product description.",
  },
  {
    term: "image",
    iri: `${SCHEMA_ORG}image`,
    kind: "property",
    source: "schema.org",
    description: "Representative product image URL.",
  },
] as const;

/**
 * Monacado-specific terms — only genuine Monacado concepts not covered by
 * schema.org. Deliberately small: envelope/framework terms plus the narrow set
 * of creator-authoritative Product facts. Commercial terms (price, commission,
 * validity, territory) are intentionally absent; they belong to a future Offer
 * capsule (see docs/PRODUCT_CAPSULE.md, "Product versus Offer boundary").
 */
export const MONACADO_TERMS: readonly OntologyTerm[] = [
  // — Capsule envelope / framework terms —
  {
    term: "capsuleVersion",
    iri: `${MON_NS}capsuleVersion`,
    kind: "property",
    source: "monacado",
    description:
      "Monotonic version of this capsule for its subject node; distinct from productVersion.",
  },
  {
    term: "subject",
    iri: `${MON_NS}subject`,
    kind: "property",
    source: "monacado",
    description:
      "The enduring node IRI this capsule describes (distinct from @id, which identifies this capsule version).",
  },
  {
    term: "data",
    iri: `${MON_NS}data`,
    kind: "property",
    source: "monacado",
    description: "Container for the entity's structured, type-specific facts.",
  },
  {
    term: "relationships",
    iri: `${MON_NS}relationships`,
    kind: "property",
    source: "monacado",
    description: "Container for typed references to other node identities.",
  },
  {
    term: "provenance",
    iri: `${MON_NS}provenance`,
    kind: "property",
    source: "monacado",
    description:
      "Authorship and integrity trail for this capsule (authority, author, content hash).",
  },
  {
    term: "metadata",
    iri: `${MON_NS}metadata`,
    kind: "property",
    source: "monacado",
    description: "Supplementary, non-authoritative system attributes.",
  },
  {
    term: "lifecycle",
    iri: `${MON_NS}lifecycle`,
    kind: "property",
    source: "monacado",
    description: "Capsule lifecycle state (draft, active, superseded, revoked, retired).",
  },
  {
    term: "createdAt",
    iri: `${MON_NS}createdAt`,
    kind: "property",
    source: "monacado",
    description: "ISO 8601 timestamp when this capsule version was created.",
  },
  {
    term: "updatedAt",
    iri: `${MON_NS}updatedAt`,
    kind: "property",
    source: "monacado",
    description: "ISO 8601 timestamp of the most recent revision to this capsule version.",
  },
  {
    term: "supersedes",
    iri: `${MON_NS}supersedes`,
    kind: "property",
    source: "monacado",
    description: "Capsule-version IRI of the immediately prior version this one replaces.",
  },
  {
    term: "revocation",
    iri: `${MON_NS}revocation`,
    kind: "property",
    source: "monacado",
    description: "Revocation record (timestamp and reason) when a capsule is revoked.",
  },
  {
    term: "authority",
    iri: `${MON_NS}authority`,
    kind: "property",
    source: "monacado",
    description:
      "The authority class that produced this capsule (creator, promoter, monacado, buyer).",
  },
  {
    term: "createdBy",
    iri: `${MON_NS}createdBy`,
    kind: "property",
    source: "monacado",
    description: "Node IRI of the author within the declared authority.",
  },
  {
    term: "contentHash",
    iri: `${MON_NS}contentHash`,
    kind: "property",
    source: "monacado",
    description:
      "Deterministic content hash of the capsule; derived, excluded from its own hash input.",
  },
  // — Product domain terms —
  {
    term: "productVersion",
    iri: `${MON_NS}productVersion`,
    kind: "property",
    source: "monacado",
    description: "Creator-authored semantic version of the product itself.",
  },
  {
    term: "promotable",
    iri: `${MON_NS}promotable`,
    kind: "property",
    source: "monacado",
    description:
      "Whether the creator permits this product to be promoted by storefronts. A general fact only; commission terms are NOT part of the Product capsule.",
  },
  {
    term: "generalAvailabilityState",
    iri: `${MON_NS}generalAvailabilityState`,
    kind: "property",
    source: "monacado",
    description:
      "Enduring product-level availability (available, unavailable, pre-release, discontinued). Distinct from offer-level availability; schema.org availability is deliberately not reused (it is Offer-associated).",
  },
  {
    term: "specifications",
    iri: `${MON_NS}specifications`,
    kind: "property",
    source: "monacado",
    description: "Creator-authored structured product specifications (key/value facts).",
  },
  {
    term: "capabilities",
    iri: `${MON_NS}capabilities`,
    kind: "property",
    source: "monacado",
    description: "Creator-authored list of product capabilities.",
  },
  {
    term: "creator",
    iri: `${MON_NS}creator`,
    kind: "property",
    source: "monacado",
    description:
      "Relationship to the authoritative Creator node IRI. A Monacado marketplace role, deliberately not schema:creator.",
  },
  {
    term: "offer",
    iri: `${MON_NS}offer`,
    kind: "property",
    source: "monacado",
    description:
      "Optional reference to a future Offer node IRI. A reference only — no offer/commercial data is carried in the Product capsule.",
  },
] as const;

export const ALL_TERMS: readonly OntologyTerm[] = [
  ...SCHEMA_ORG_TERMS,
  ...MONACADO_TERMS,
];

/** Ontology metadata. `status` makes the provisional nature explicit. */
export const COMMERCE_ONTOLOGY_META = {
  namespace: MON_NS,
  ontologyDocument: COMMERCE_ONTOLOGY_DOCUMENT,
  contextDocument: COMMERCE_CONTEXT_DOCUMENT,
  version: "v1",
  status: "provisional-design-target",
  note: "URLs are design targets only; not live, resolvable, immutable, or approved AgentNet standards.",
} as const;
