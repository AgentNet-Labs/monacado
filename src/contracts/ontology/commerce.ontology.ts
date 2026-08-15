/**
 * Monacado commerce ontology — Product subset, ANS-aligned (Phase 0B.1).
 *
 * Semantic layer: names the terms a Product capsule uses and where each term's
 * meaning comes from. Structure/validation live in the Zod layer.
 *
 * Per ADR §4 / §10 / §11 and the Phase 0B.1 ANS audit:
 *   - schema.org terms are reused where meaning fits exactly;
 *   - ANS-defined concepts use AgentNet Core Ontology (AN-O) IRIs — Monacado
 *     does NOT invent duplicate terms for them;
 *   - Monacado-specific terms use the provisional commerce namespace;
 *   - all document URLs are DESIGN TARGETS ONLY (not live/approved).
 */

export const SCHEMA_ORG = "https://schema.org/" as const;

/** Provisional Monacado commerce namespace (version-independent term identity). */
export const MON_NS = "https://monacado.com/ns/commerce#" as const;

/** AgentNet Core Ontology (AN-O) namespace (from ANS Core v2.0, Appendix E). */
export const AN_O_NS = "https://agentnet.ai/ontology/core#" as const;

/** Provisional document targets — DESIGN TARGETS ONLY (not live/resolvable/approved). */
export const COMMERCE_ONTOLOGY_DOCUMENT = "https://monacado.com/ontology/commerce/v1" as const;
export const COMMERCE_CONTEXT_DOCUMENT = "https://monacado.com/context/commerce/v1" as const;

export type TermKind = "class" | "property";
export type TermSource = "schema.org" | "agentnet-core" | "monacado";

export interface OntologyTerm {
  term: string;
  iri: string;
  kind: TermKind;
  source: TermSource;
  description: string;
}

/** schema.org terms reused verbatim (not redefined). */
export const SCHEMA_ORG_TERMS: readonly OntologyTerm[] = [
  { term: "Product", iri: `${SCHEMA_ORG}Product`, kind: "class", source: "schema.org", description: "The enduring product entity the capsule describes." },
  { term: "name", iri: `${SCHEMA_ORG}name`, kind: "property", source: "schema.org", description: "Human-readable product name." },
  { term: "description", iri: `${SCHEMA_ORG}description`, kind: "property", source: "schema.org", description: "Human-readable product description." },
  { term: "image", iri: `${SCHEMA_ORG}image`, kind: "property", source: "schema.org", description: "Representative product image URL." },
  // Offer capsule projection (Phase 0M.2B) — reused where meaning fits exactly.
  { term: "Offer", iri: `${SCHEMA_ORG}Offer`, kind: "class", source: "schema.org", description: "The commercial terms under which a Product is offered." },
  { term: "itemOffered", iri: `${SCHEMA_ORG}itemOffered`, kind: "property", source: "schema.org", description: "The Product Node this Offer is for." },
  { term: "priceCurrency", iri: `${SCHEMA_ORG}priceCurrency`, kind: "property", source: "schema.org", description: "Currency of a paid Offer price." },
  { term: "validFrom", iri: `${SCHEMA_ORG}validFrom`, kind: "property", source: "schema.org", description: "Instant from which the Offer terms apply." },
  { term: "validThrough", iri: `${SCHEMA_ORG}validThrough`, kind: "property", source: "schema.org", description: "Instant after which the Offer terms no longer apply." },
  // Storefront capsule projection (Phase 0M.3B).
  //
  // `schema:Store` is deliberately NOT reused: it is a LocalBusiness subtype and
  // implies physical premises, which a Monacado storefront does not have.
  // `name` and `description` above are reused verbatim for the storefront's
  // display name and summary — the meanings coincide exactly.
  { term: "slogan", iri: `${SCHEMA_ORG}slogan`, kind: "property", source: "schema.org", description: "Short public tagline for a Storefront." },
];

/** ANS-defined concepts mapped to AN-O IRIs (reused, not duplicated). */
export const AGENTNET_CORE_TERMS: readonly OntologyTerm[] = [
  { term: "capsuleId", iri: `${AN_O_NS}capsuleId`, kind: "property", source: "agentnet-core", description: "Opaque identifier of this immutable capsule version." },
  { term: "bindsToNode", iri: `${AN_O_NS}bindsToNode`, kind: "property", source: "agentnet-core", description: "Registrar-issued opaque ANS Node ID this capsule binds to." },
  { term: "publishedBy", iri: `${AN_O_NS}publishedBy`, kind: "property", source: "agentnet-core", description: "ANS Publisher that submitted the capsule (Monacado)." },
  { term: "publishedAt", iri: `${AN_O_NS}publishedAt`, kind: "property", source: "agentnet-core", description: "Publication timestamp." },
  { term: "version", iri: `${AN_O_NS}version`, kind: "property", source: "agentnet-core", description: "Semantic capsule version (MAJOR.MINOR.PATCH)." },
  { term: "provenance", iri: `${AN_O_NS}hasProvenance`, kind: "property", source: "agentnet-core", description: "Provenance record for the capsule's data." },
  { term: "source", iri: `${AN_O_NS}source`, kind: "property", source: "agentnet-core", description: "The data source (ANS provenance)." },
  { term: "method", iri: `${AN_O_NS}method`, kind: "property", source: "agentnet-core", description: "Method of acquisition (ANS provenance)." },
  { term: "acquiredAt", iri: `${AN_O_NS}acquiredAt`, kind: "property", source: "agentnet-core", description: "Time of acquisition (ANS provenance)." },
  { term: "assertionKind", iri: `${AN_O_NS}assertionKind`, kind: "property", source: "agentnet-core", description: "Asserted or Inferred (ANS provenance)." },
  { term: "supersedes", iri: `${AN_O_NS}supersedes`, kind: "property", source: "agentnet-core", description: "Prior capsule ID this version supersedes." },
  { term: "revokes", iri: `${AN_O_NS}revokes`, kind: "property", source: "agentnet-core", description: "Prior capsule ID this capsule revokes." },
  { term: "nodePolicy", iri: `${AN_O_NS}hasNodePolicy`, kind: "property", source: "agentnet-core", description: "Reference to the governing Node Policy." },
  { term: "capsulePolicy", iri: `${AN_O_NS}hasCapsulePolicy`, kind: "property", source: "agentnet-core", description: "Reference to the governing Capsule Policy." },
];

/** Monacado-specific terms: integrity, source-record traceability, and Product facts. */
export const MONACADO_TERMS: readonly OntologyTerm[] = [
  { term: "contentHash", iri: `${MON_NS}contentHash`, kind: "property", source: "monacado", description: "Deterministic content hash of the published capsule (integrity extension; excluded from its own input)." },
  { term: "sourceClass", iri: `${MON_NS}sourceClass`, kind: "property", source: "monacado", description: "Class of source artifact (e.g. governed-database-record)." },
  { term: "sourceSystem", iri: `${MON_NS}sourceSystem`, kind: "property", source: "monacado", description: "System of record that produced the source (Monacado)." },
  { term: "sourceRecordType", iri: `${MON_NS}sourceRecordType`, kind: "property", source: "monacado", description: "Type of the source record (e.g. Product)." },
  { term: "sourceRecordId", iri: `${MON_NS}sourceRecordId`, kind: "property", source: "monacado", description: "Stable opaque identifier of the source record." },
  { term: "sourceRecordVersion", iri: `${MON_NS}sourceRecordVersion`, kind: "property", source: "monacado", description: "Explicit immutable version of the source record." },
  { term: "generatedAt", iri: `${MON_NS}generatedAt`, kind: "property", source: "monacado", description: "Time the capsule candidate was generated." },
  { term: "generatorVersion", iri: `${MON_NS}generatorVersion`, kind: "property", source: "monacado", description: "Version of the capsule generator (operational; not authority)." },
  { term: "productVersion", iri: `${MON_NS}productVersion`, kind: "property", source: "monacado", description: "Creator-authored semantic version of the product itself." },
  { term: "promotable", iri: `${MON_NS}promotable`, kind: "property", source: "monacado", description: "Whether the creator permits promotion. A general fact; no commission terms." },
  { term: "generalAvailabilityState", iri: `${MON_NS}generalAvailabilityState`, kind: "property", source: "monacado", description: "Enduring product-level availability; not offer-level (schema.org availability is deliberately not reused)." },
  { term: "specifications", iri: `${MON_NS}specifications`, kind: "property", source: "monacado", description: "Creator-authored structured product specifications." },
  { term: "capabilities", iri: `${MON_NS}capabilities`, kind: "property", source: "monacado", description: "Creator-authored list of product capabilities." },
  { term: "relationships", iri: `${MON_NS}relationships`, kind: "property", source: "monacado", description: "Container for typed domain relationships in Product data." },
  { term: "creator", iri: `${MON_NS}creator`, kind: "property", source: "monacado", description: "Relationship to the authoritative Creator node (a Monacado marketplace role; not schema:creator)." },
  { term: "offer", iri: `${MON_NS}offer`, kind: "property", source: "monacado", description: "Optional reference to a future Offer node (reference only; no offer data)." },
  // — Offer capsule projection (Phase 0M.2B) —
  //
  // schema.org `price` is a decimal and `availability` is an ItemAvailability
  // enumeration; neither matches Monacado's minor-unit money or its
  // AVAILABLE/TEMPORARILY_UNAVAILABLE/ENDED public state, so these are Monacado
  // terms rather than a reuse that would quietly change their meaning.
  { term: "commercialState", iri: `${MON_NS}commercialState`, kind: "property", source: "monacado", description: "Public commercial state of the Offer, derived from authoritative lifecycle and availability." },
  { term: "price", iri: `${MON_NS}price`, kind: "property", source: "monacado", description: "Container for the Offer's public price terms." },
  { term: "priceType", iri: `${MON_NS}priceType`, kind: "property", source: "monacado", description: "FREE or PAID." },
  { term: "wholesalePriceMinorUnits", iri: `${MON_NS}wholesalePriceMinorUnits`, kind: "property", source: "monacado", description: "Wholesale price — what the creator is owed — as a positive integer in minor currency units. Not the buyer-facing retail price, which a Promoter sets on a Listing." },
  { term: "wholesalePriceCurrency", iri: `${MON_NS}wholesalePriceCurrency`, kind: "property", source: "monacado", description: "Currency of the wholesale price." },
  { term: "commission", iri: `${MON_NS}commission`, kind: "property", source: "monacado", description: "Container for the seller-offered promoter commission terms." },
  { term: "commissionMethod", iri: `${MON_NS}commissionMethod`, kind: "property", source: "monacado", description: "PERCENT_OF_WHOLESALE or FIXED_AMOUNT. The commission basis is always the wholesale price." },
  { term: "calculatedCommissionMinorUnits", iri: `${MON_NS}calculatedCommissionMinorUnits`, kind: "property", source: "monacado", description: "The exact commission a completed sale owes, computed from the wholesale price under the recorded calculation policy." },
  { term: "commissionBasisPoints", iri: `${MON_NS}commissionBasisPoints`, kind: "property", source: "monacado", description: "Percentage commission in basis points (1 = 0.01%)." },
  { term: "fixedCommissionMinorUnits", iri: `${MON_NS}fixedCommissionMinorUnits`, kind: "property", source: "monacado", description: "Fixed commission as a positive integer in minor currency units." },
  { term: "fixedCommissionCurrency", iri: `${MON_NS}fixedCommissionCurrency`, kind: "property", source: "monacado", description: "Currency of a fixed commission; always equal to the Offer's price currency, and validated against it." },
  { term: "offeredBy", iri: `${MON_NS}offeredBy`, kind: "property", source: "monacado", description: "Approved public authority Node offering these terms (a Monacado marketplace role)." },

  // — Storefront capsule projection (Phase 0M.3B) —
  //
  // `Storefront` is a Monacado class because schema.org has no online-marketplace
  // storefront: `schema:Store` implies physical premises. `publicHandle` and
  // `discoverable` are Monacado marketplace concepts with no schema.org
  // equivalent, and `operatedBy` names a Monacado marketplace role rather than
  // schema.org's `provider`/`seller`, on the same reasoning that made `creator` a
  // Monacado term.
  { term: "Storefront", iri: `${MON_NS}Storefront`, kind: "class", source: "monacado", description: "A Monacado marketplace storefront operated by a participant. Not schema:Store, which implies physical premises." },
  { term: "publicHandle", iri: `${MON_NS}publicHandle`, kind: "property", source: "monacado", description: "The storefront's public routing name. Public by construction; never an internal identifier." },
  { term: "discoverable", iri: `${MON_NS}discoverable`, kind: "property", source: "monacado", description: "Whether the storefront should be listed in discovery surfaces. Derived from authoritative visibility and go-live approval; never a stored flag." },
  { term: "operatedBy", iri: `${MON_NS}operatedBy`, kind: "property", source: "monacado", description: "Approved public authority Node that operates the subject entity — a Storefront, or a Listing (a Monacado marketplace role). Never a participant, account, or legal identity. Generalized in Phase 0M.4B; the IRI and meaning are unchanged." },

  // — Listing capsule projection (Phase 0M.4B) —
  //
  // `Listing` is a Monacado class: schema.org has no term for a marketplace
  // placement of someone else's product in someone else's storefront.
  // `basePrice` and `salePrice` are Monacado terms because schema.org `price` is
  // a decimal and these are integer minor units — and because `mon:price` is
  // already the Offer's price CONTAINER, so reusing it would give one IRI two
  // shapes. `priceCurrency`, `operatedBy`, and — for the sale interval —
  // `validFrom` / `validThrough` are reused verbatim: a sale is a price valid
  // over an interval, which is exactly what those schema.org terms already mean.
  { term: "Listing", iri: `${MON_NS}Listing`, kind: "class", source: "monacado", description: "A buyer-facing placement of a Product in a Storefront, sold directly by its seller or resold by a promoter." },
  { term: "listingType", iri: `${MON_NS}listingType`, kind: "property", source: "monacado", description: "SELLER_DIRECT or PROMOTED — whether the buyer is purchasing from the seller or from a reseller. Discloses nothing about the commercial arrangement behind a resale." },
  { term: "basePrice", iri: `${MON_NS}basePrice`, kind: "property", source: "monacado", description: "The ordinary buyer-facing commercial price in integer minor units. The merchandise or service price alone: tax and shipping are excluded, and it is never the Monacado wholesale acquisition amount. Not reduced by a scheduled sale — the sale is published alongside it." },
  { term: "salePrice", iri: `${MON_NS}salePrice`, kind: "property", source: "monacado", description: "A seller's scheduled temporary price in integer minor units, strictly lower than the base price, applying over the published validFrom/validThrough interval. Seller-direct Listings only." },
  { term: "sale", iri: `${MON_NS}sale`, kind: "property", source: "monacado", description: "Container for a seller-direct Listing's scheduled sale: the sale price and the interval it applies over." },
  { term: "offeredProduct", iri: `${MON_NS}offeredProduct`, kind: "property", source: "monacado", description: "The Product Node this Listing sells. Distinct from schema:itemOffered, which names an Offer's Product." },
  { term: "listedInStorefront", iri: `${MON_NS}listedInStorefront`, kind: "property", source: "monacado", description: "The Storefront Node this Listing appears in." },
];

export const ALL_TERMS: readonly OntologyTerm[] = [
  ...SCHEMA_ORG_TERMS,
  ...AGENTNET_CORE_TERMS,
  ...MONACADO_TERMS,
];

export const COMMERCE_ONTOLOGY_META = {
  namespace: MON_NS,
  agentnetCoreNamespace: AN_O_NS,
  ontologyDocument: COMMERCE_ONTOLOGY_DOCUMENT,
  contextDocument: COMMERCE_CONTEXT_DOCUMENT,
  version: "v1",
  status: "provisional-design-target",
  note: "URLs are design targets only; not live, resolvable, immutable, or approved AgentNet standards.",
} as const;
