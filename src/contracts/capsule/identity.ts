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

/**
 * Internal Monacado publication-record identifier (`mon:pub:<opaque>`). Names one
 * durable Monacado publication record; it is NOT an ANS identity and must never
 * substitute for a Node ID or a capsule ID.
 */
export const PUBLICATION_ID_RE = new RegExp(`^mon:pub:${OPAQUE_BODY}$`);

/**
 * Internal Monacado publication-outbox item identifier (`mon:obx:<opaque>`).
 * Operational work identity only — not an ANS identity.
 */
export const OUTBOX_ID_RE = new RegExp(`^mon:obx:${OPAQUE_BODY}$`);

/**
 * Registrar receipt identifier (`mon:rcpt:<opaque>`). Names one immutable
 * recorded Registrar result. Internal Monacado identity — NOT an ANS identity
 * and never a substitute for the Registrar's own registration identifier.
 */
export const RECEIPT_ID_RE = new RegExp(`^mon:rcpt:${OPAQUE_BODY}$`);

/**
 * Outbox claim lock token (`mon:lock:<opaque>`). Proves ownership of one claim
 * by one worker. Operational only — not an ANS identity, not a credential, and
 * never derived from Product, Node, capsule, or publication identity.
 */
export const LOCK_TOKEN_RE = new RegExp(`^mon:lock:${OPAQUE_BODY}$`);

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

/** Internal Monacado publication-record identifier (NOT an ANS identity). */
export function makePublicationId(opaque: string): string {
  return `mon:pub:${opaque}`;
}

/** Internal Monacado publication-outbox identifier (NOT an ANS identity). */
export function makeOutboxId(opaque: string): string {
  return `mon:obx:${opaque}`;
}

/** Registrar receipt identifier (NOT an ANS identity). */
export function makeReceiptId(opaque: string): string {
  return `mon:rcpt:${opaque}`;
}

/** Outbox claim lock token (NOT an ANS identity, NOT a credential). */
export function makeLockToken(opaque: string): string {
  return `mon:lock:${opaque}`;
}

/**
 * Crockford base32 alphabet backing `OPAQUE_BODY` (excludes I, L, O, U).
 * Used to render a deterministic opaque body from a hash digest.
 */
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ" as const;

/**
 * Render a deterministic 26-char Crockford body from a hex digest (the low 130
 * bits). Deterministic and opaque: the same digest always yields the same body,
 * and the body encodes no entity type, name, or business meaning.
 */
export function opaqueBodyFromHex(hex: string): string {
  if (!/^[0-9a-f]+$/i.test(hex)) {
    throw new Error("opaqueBodyFromHex requires a hex digest");
  }
  let n = BigInt(`0x${hex}`);
  const base = 32n;
  let out = "";
  for (let i = 0; i < 26; i += 1) {
    out = CROCKFORD_ALPHABET[Number(n % base)] + out;
    n /= base;
  }
  return out;
}
