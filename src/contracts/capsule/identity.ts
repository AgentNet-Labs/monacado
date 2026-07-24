/**
 * Canonical identity patterns (ADR §3).
 *
 * Four identities are kept strictly distinct and must never substitute for one
 * another:
 *   1. node IRI            — the enduring entity identity
 *   2. capsule-version IRI — one version of one authority's capsule for that node
 *   3. page URL            — human-facing page (may contain slugs; not identity)
 *   4. purchase endpoint   — operational checkout endpoint (not identity)
 *
 * Only (1) and (2) are modeled here. Node IRIs use opaque ULIDs; no mutable
 * names or slugs appear in canonical identity, and identifiers are never reused.
 *
 * NOTE: `monacado.com` is a DESIGN TARGET. These IRIs are not claimed to be live
 * or resolvable; nothing here should be published until domain control and
 * resolution behavior are confirmed.
 */

export const ID_BASE = "https://monacado.com/id" as const;

/** ULID: 26 chars, Crockford base32, uppercase, excluding I, L, O, U. */
export const ULID_PATTERN = "[0-9A-HJKMNP-TV-Z]{26}";
export const ULID_RE = new RegExp(`^${ULID_PATTERN}$`);

export type EntityType = "product" | "creator" | "promoter" | "storefront" | "listing" | "offer";

/** Node IRI, e.g. https://monacado.com/id/product/01J9Z3K7Q0V2M5N8P4R6T1W3XY */
export function nodeIriPattern(entityType: EntityType): RegExp {
  return new RegExp(`^${ID_BASE}/${entityType}/${ULID_PATTERN}$`);
}

/**
 * Capsule-version IRI: the node IRI plus a version path segment.
 * e.g. https://monacado.com/id/product/{ULID}/capsule/1
 */
export function capsuleVersionIriPattern(entityType: EntityType): RegExp {
  return new RegExp(`^${ID_BASE}/${entityType}/${ULID_PATTERN}/capsule/[1-9][0-9]*$`);
}

export function makeNodeIri(entityType: EntityType, ulid: string): string {
  return `${ID_BASE}/${entityType}/${ulid}`;
}

export function makeCapsuleVersionIri(nodeIri: string, capsuleVersion: number): string {
  return `${nodeIri}/capsule/${capsuleVersion}`;
}

/** Expected capsule-version IRI for a given node + version (used in cross-checks). */
export function expectedCapsuleVersionIri(nodeIri: string, capsuleVersion: number): string {
  return makeCapsuleVersionIri(nodeIri, capsuleVersion);
}
