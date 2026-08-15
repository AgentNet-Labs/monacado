/**
 * Versioned JSON-LD context for the Product capsule (Phase 0B.1, ANS-aligned).
 *
 * Maps compact capsule terms to schema.org, AgentNet Core Ontology (AN-O), and
 * Monacado commerce IRIs. `@context`, `@type` are JSON-LD keywords; `metadata`
 * and `data` are ANS structural members and are treated structurally (not as
 * ontology terms). ANS-defined concepts map to `an:`; Monacado extensions to
 * `mon:`.
 *
 * This object is what would be served at COMMERCE_CONTEXT_DOCUMENT once hosted;
 * it is bundled locally so validation/tests/demo need no network.
 */

import {
  AN_O_NS,
  COMMERCE_CONTEXT_DOCUMENT,
  MON_NS,
  SCHEMA_ORG,
} from "./commerce.ontology";

export const COMMERCE_CONTEXT = {
  "@version": 1.1,
  schema: SCHEMA_ORG,
  an: AN_O_NS,
  mon: MON_NS,

  // schema.org reuse
  Product: "schema:Product",
  name: "schema:name",
  description: "schema:description",
  image: { "@id": "schema:image", "@type": "@id" },
  Offer: "schema:Offer",
  itemOffered: { "@id": "schema:itemOffered", "@type": "@id" },
  priceCurrency: "schema:priceCurrency",
  validFrom: { "@id": "schema:validFrom", "@type": "schema:DateTime" },
  validThrough: { "@id": "schema:validThrough", "@type": "schema:DateTime" },
  slogan: "schema:slogan",

  // AN-O (ANS-defined concepts)
  capsuleId: "an:capsuleId",
  bindsToNode: { "@id": "an:bindsToNode", "@type": "@id" },
  publishedBy: { "@id": "an:publishedBy", "@type": "@id" },
  publishedAt: { "@id": "an:publishedAt", "@type": "schema:DateTime" },
  version: "an:version",
  provenance: "an:hasProvenance",
  source: "an:source",
  method: "an:method",
  acquiredAt: { "@id": "an:acquiredAt", "@type": "schema:DateTime" },
  assertionKind: "an:assertionKind",
  supersedes: "an:supersedes",
  revokes: "an:revokes",
  nodePolicy: "an:hasNodePolicy",
  capsulePolicy: "an:hasCapsulePolicy",

  // Monacado extensions
  contentHash: "mon:contentHash",
  sourceClass: "mon:sourceClass",
  sourceSystem: "mon:sourceSystem",
  sourceRecordType: "mon:sourceRecordType",
  sourceRecordId: "mon:sourceRecordId",
  sourceRecordVersion: "mon:sourceRecordVersion",
  generatedAt: { "@id": "mon:generatedAt", "@type": "schema:DateTime" },
  generatorVersion: "mon:generatorVersion",
  productVersion: "mon:productVersion",
  promotable: "mon:promotable",
  generalAvailabilityState: "mon:generalAvailabilityState",
  specifications: "mon:specifications",
  capabilities: "mon:capabilities",
  relationships: "mon:relationships",
  creator: { "@id": "mon:creator", "@type": "@id" },
  offer: { "@id": "mon:offer", "@type": "@id" },

  // Offer capsule projection (Phase 0M.2B)
  commercialState: "mon:commercialState",
  price: "mon:price",
  priceType: "mon:priceType",
  wholesalePriceMinorUnits: "mon:wholesalePriceMinorUnits",
  wholesalePriceCurrency: "mon:wholesalePriceCurrency",
  commission: "mon:commission",
  commissionMethod: "mon:commissionMethod",
  calculatedCommissionMinorUnits: "mon:calculatedCommissionMinorUnits",
  commissionBasisPoints: "mon:commissionBasisPoints",
  fixedCommissionMinorUnits: "mon:fixedCommissionMinorUnits",
  fixedCommissionCurrency: "mon:fixedCommissionCurrency",
  offeredBy: { "@id": "mon:offeredBy", "@type": "@id" },

  // Storefront capsule projection (Phase 0M.3B)
  Storefront: "mon:Storefront",
  publicHandle: "mon:publicHandle",
  discoverable: "mon:discoverable",
  operatedBy: { "@id": "mon:operatedBy", "@type": "@id" },

  // Listing capsule projection (Phase 0M.4B)
  Listing: "mon:Listing",
  listingType: "mon:listingType",
  basePrice: "mon:basePrice",
  salePrice: "mon:salePrice",
  sale: "mon:sale",
  offeredProduct: { "@id": "mon:offeredProduct", "@type": "@id" },
  listedInStorefront: { "@id": "mon:listedInStorefront", "@type": "@id" },
} as const;

/** Reference IRI a capsule places in `@context` (design target). */
export const COMMERCE_CONTEXT_REF = COMMERCE_CONTEXT_DOCUMENT;

/** AN-O context reference a capsule places alongside the commerce context. */
export const AN_O_CONTEXT_REF = AN_O_NS;

/** Terms defined by the local context (excludes prefixes and JSON-LD keywords). */
export const CONTEXT_TERMS: readonly string[] = Object.keys(COMMERCE_CONTEXT).filter(
  (k) => !k.startsWith("@") && !["schema", "an", "mon"].includes(k),
);
