/**
 * Identity forms (ADR §3, §10.1, §11.5; ANS Core v2.0 §4/§6).
 *
 * Five identities are kept strictly distinct and never substitute for one
 * another:
 *   1. Monacado internal Product ID — a Monacado application identifier
 *      (not an ANS identity; may be semantic/internal).
 *   2. Monacado human-facing Product URL — a page URL (not modeled here).
 *   3. Registrar-issued opaque ANS Node ID — the ANS node binding.
 *   4. Capsule ID — identifies one immutable published capsule version.
 *   5. Source-record ID — the governed DB record the capsule derives from.
 *
 * ANS Node IDs (and, for this phase, synthetic Capsule IDs) MUST be opaque and
 * non-semantic: they MUST NOT encode entity type, role, name, slug, hierarchy,
 * or business meaning (ANS §4). They are treated as Registrar-issued; Monacado's
 * old `https://monacado.com/id/product/{ulid}` pattern is an INTERNAL identity
 * only and MUST NOT be used as an ANS Node ID.
 *
 * The opaque token bodies below use a ULID-style Crockford base32 alphabet
 * purely as a synthetic, provisional stand-in until real Registrar issuance.
 */

/** Opaque token body: 26 chars, Crockford base32 (uppercase, no I/L/O/U). */
export const OPAQUE_BODY = "[0-9A-HJKMNP-TV-Z]{26}";

/**
 * ANS Node ID — opaque, Registrar-issued. Provisional synthetic scheme
 * `an:node:<opaque>`. The `an:node:` prefix is a namespace, not business
 * meaning; the identifying body is opaque.
 */
export const ANS_NODE_ID_RE = new RegExp(`^an:node:${OPAQUE_BODY}$`);

/** Capsule ID — opaque, one per immutable capsule version. Provisional scheme. */
export const CAPSULE_ID_RE = new RegExp(`^an:capsule:${OPAQUE_BODY}$`);

/** Publisher ID — the walled-garden Publisher (Monacado). Not required opaque. */
export const PUBLISHER_ID_RE = /^an:publisher:[A-Za-z0-9._:-]{3,}$/;

/**
 * Tokens that mark an identifier as SEMANTIC and therefore invalid as an ANS
 * Node ID (defense-in-depth beyond the opaque regex). Rejects values such as
 * `https://monacado.com/id/product/{ulid}`.
 */
export const SEMANTIC_ID_MARKERS: readonly string[] = [
  "http://",
  "https://",
  "/",
  "product",
  "storefront",
  "creator",
  "promoter",
  "listing",
  "offer",
  "monacado",
  "platform",
];

/** True if the value looks semantic and must be rejected as an ANS Node ID. */
export function looksSemantic(value: string): boolean {
  const v = value.toLowerCase();
  return SEMANTIC_ID_MARKERS.some((m) => v.includes(m));
}

/**
 * Internal Monacado source-record identifier (`mon:srec:<opaque>`). Opaque and
 * distinct from the internal Product ID, the ANS Node ID, and the capsule ID.
 * Rejects ANS Node/capsule IDs and semantic URLs by construction.
 */
export const SOURCE_RECORD_ID_RE = new RegExp(`^mon:srec:${OPAQUE_BODY}$`);

/** Internal Monacado Product identifier (`mon:product:<opaque>`). Not an ANS identity. */
export const INTERNAL_PRODUCT_ID_RE = new RegExp(`^mon:product:${OPAQUE_BODY}$`);

/** Internal creator authority identifier (`mon:creator:<opaque>`). Internal only. */
export const INTERNAL_CREATOR_ID_RE = new RegExp(`^mon:creator:${OPAQUE_BODY}$`);

// — Synthetic constructors (tests/demo only; a real Registrar issues ANS ids) —

export function makeSyntheticNodeId(opaque: string): string {
  return `an:node:${opaque}`;
}

export function makeSyntheticCapsuleId(opaque: string): string {
  return `an:capsule:${opaque}`;
}

/** Internal Monacado application identifier for a Product (NOT an ANS identity). */
export function makeInternalProductId(opaque: string): string {
  return `mon:product:${opaque}`;
}

/** Internal Monacado source-record identifier (NOT an ANS identity). */
export function makeSourceRecordId(opaque: string): string {
  return `mon:srec:${opaque}`;
}

/** Internal creator authority identifier (NOT an ANS identity). */
export function makeInternalCreatorId(opaque: string): string {
  return `mon:creator:${opaque}`;
}
