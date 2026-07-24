/**
 * Content hashing (ADR §1; Phase 0B hashing rule).
 *
 * The hash is computed over the COMPLETE validated public capsule, serialized
 * with the deterministic canonical JSON procedure. Included in the hash input:
 * semantic content, identity (@id, subject), version, provenance, lifecycle,
 * and relationships. Excluded: the derived `provenance.contentHash` field
 * itself (hashing it would be circular). Nothing else is stripped — there are
 * no transient runtime-only fields in the capsule schema.
 *
 * Result: `sha256:<hex>`. Equivalent capsules that differ only in key insertion
 * order hash identically; any meaningful change changes the hash.
 */

import { createHash } from "node:crypto";
import { canonicalJsonString } from "./canonical-json";

export const HASH_ALGORITHM = "sha256" as const;

/** Deep clone with the derived contentHash removed, leaving all semantic content. */
function stripDerived<T>(capsule: T): T {
  const clone = structuredClone(capsule) as Record<string, unknown>;
  const provenance = clone["provenance"];
  if (provenance && typeof provenance === "object" && !Array.isArray(provenance)) {
    delete (provenance as Record<string, unknown>)["contentHash"];
  }
  return clone as T;
}

/** The exact string that is hashed — exposed for tests and debugging. */
export function hashInput(capsule: unknown): string {
  return canonicalJsonString(stripDerived(capsule));
}

/** Compute the capsule content hash as `sha256:<hex>`. */
export function contentHash(capsule: unknown): string {
  const digest = createHash(HASH_ALGORITHM).update(hashInput(capsule), "utf8").digest("hex");
  return `${HASH_ALGORITHM}:${digest}`;
}

/** Return a copy of the capsule with `provenance.contentHash` set to its hash. */
export function withContentHash<T extends { provenance: Record<string, unknown> }>(
  capsule: T,
): T {
  const hash = contentHash(capsule);
  return {
    ...capsule,
    provenance: { ...capsule.provenance, contentHash: hash },
  };
}
