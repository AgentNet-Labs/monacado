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
 * Pre-publication candidate hash (distinct from the published-capsule hash).
 * Covers the whole candidate (data + candidate metadata/provenance).
 */
export function candidateHash(candidate: unknown): string {
  return sha256(canonicalJsonString(candidate));
}
