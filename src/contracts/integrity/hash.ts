/**
 * Content hashing (ADR §10.4 as corrected for ANS; Phase 0B.1 hashing rule).
 *
 * Published-capsule hash: computed over the COMPLETE validated published
 * capsule, serialized with the deterministic canonical JSON procedure,
 * excluding ONLY `metadata.contentHash` (excluding it avoids circularity).
 * Everything else is included — Node binding, Publisher, version, publication
 * time, provenance, policy references, and supersession/revocation metadata.
 *
 * Candidate hash: a separately named, pre-publication integrity value over a
 * candidate. It is NOT the published-capsule hash and the two must not be
 * conflated.
 *
 * Equivalent objects with different key insertion order hash identically; any
 * meaningful change changes the hash. A relational projection or publication
 * envelope is never hashed.
 */

import { createHash } from "node:crypto";
import { canonicalJsonString } from "./canonical-json";

export const HASH_ALGORITHM = "sha256" as const;

function sha256(input: string): string {
  return `${HASH_ALGORITHM}:${createHash(HASH_ALGORITHM).update(input, "utf8").digest("hex")}`;
}

/** Deep clone of a published capsule with the derived `metadata.contentHash` removed. */
function stripPublishedHash<T>(capsule: T): T {
  const clone = structuredClone(capsule) as Record<string, unknown>;
  const metadata = clone["metadata"];
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    delete (metadata as Record<string, unknown>)["contentHash"];
  }
  return clone as T;
}

/** The exact string hashed for a published capsule — exposed for tests/debug. */
export function publishedHashInput(capsule: unknown): string {
  return canonicalJsonString(stripPublishedHash(capsule));
}

/** Content hash of a published capsule as `sha256:<hex>` (excludes contentHash). */
export function publishedContentHash(capsule: unknown): string {
  return sha256(publishedHashInput(capsule));
}

/** Return a copy of the published capsule with `metadata.contentHash` set. */
export function withPublishedContentHash<
  T extends { metadata: Record<string, unknown> },
>(capsule: T): T {
  return {
    ...capsule,
    metadata: { ...capsule.metadata, contentHash: publishedContentHash(capsule) },
  };
}

/**
 * Hash of ANY value under the deterministic canonical JSON procedure, as
 * `sha256:<hex>`. This is the single shared primitive the named hashes below are
 * expressed in terms of — callers needing a canonical hash (e.g. an outbox
 * payload hash) reuse this rather than re-implementing canonicalize-then-digest.
 *
 * It is deliberately unnamed with respect to capsule semantics: a canonical hash
 * of a payload is NOT the published-capsule content hash and the two must not be
 * conflated. `publishedContentHash` excludes `metadata.contentHash`; a payload
 * hash covers the payload exactly as stored, including that field.
 */
export function canonicalHash(value: unknown): string {
  return sha256(canonicalJsonString(value));
}

/**
 * One-way binding hash of an opaque operational token, as `sha256:<hex>`.
 *
 * Used to bind a submission attempt to the worker claim that produced it WITHOUT
 * persisting the raw lock token: a stored token would be a reusable credential,
 * whereas a hash proves ownership on presentation and is useless if the row
 * leaks. The token is hashed as raw UTF-8, not as canonical JSON, because it is
 * a flat string rather than a document.
 */
export function tokenBindingHash(token: string): string {
  return sha256(token);
}

/**
 * Pre-publication candidate hash (distinct from the published-capsule hash).
 * Covers the whole candidate (data + candidate metadata/provenance).
 */
export function candidateHash(candidate: unknown): string {
  return canonicalHash(candidate);
}
