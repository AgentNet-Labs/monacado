/**
 * Internal-identifier leak guard for public capsules.
 *
 * Introduced by the Offer projection (Phase 0M.2B), lifted here by the Storefront
 * projection (Phase 0M.3B) because a second capsule needing the same rule is the
 * point at which a rule belongs in one place, and extended by the Listing
 * projection (Phase 0M.4B) with `mon:listing:`, and by Storefront persistence
 * (Phase 0M.3C) with `mon:sgov:`. `offer.capsule.ts` re-exports
 * every name below, so its public surface is unchanged.
 *
 * The list only ever grows: adding a prefix strengthens every capsule that uses
 * the guard, and removing one would silently weaken all of them at once.
 *
 * **What this guard is for.** Strict schemas already refuse unknown *keys*. This
 * refuses an internal identifier placed as a *value* in a field that legitimately
 * accepts strings — a display name pasted from an admin console, a handle
 * derived from a row id, a provenance line assembled by hand. The two guards
 * answer different questions, and the value one is what catches a copy-paste.
 *
 * It is a backstop, not the boundary. The boundary is the allow-list: every
 * projection names the exact fields it emits, and no field is populated from an
 * internal identifier in the first place.
 */

/**
 * Internal identifier prefixes that must never appear anywhere in a public
 * capsule — as a value, not merely as a key.
 *
 * **`mon:srec:` is deliberately absent.** The source-record identifier is part of
 * the already-approved provenance pattern (`provenance.sourceRecordId`, ANS §3 /
 * ADR §11.8): it is opaque, encodes no business meaning, and exists precisely so
 * a published claim can be traced back to the exact governed record version it
 * came from. Forbidding it here would break provenance rather than protect
 * anything — and no projection is authorized to introduce a *new* raw internal
 * identifier beyond that approved pattern, which is why every other prefix below
 * is refused.
 */
export const FORBIDDEN_INTERNAL_ID_PREFIXES = [
  "mon:offer:",
  "mon:product:",
  "mon:storefront:",
  "mon:listing:",
  "mon:mpart:",
  "mon:mrole:",
  "mon:sgov:",
  "mon:acct:",
  "mon:asess:",
  "mon:aent:",
  "mon:actor:",
  "mon:creator:",
  "mon:mprof:",
  "mon:mact:",
  "mon:mpay:",
  "mon:pvev:",
] as const;

export interface InternalIdentifierFinding {
  path: string;
  prefix: string;
}

/** Every internal identifier reachable in `value`, with its path. */
export function findInternalIdentifiers(
  value: unknown,
  basePath = "",
): InternalIdentifierFinding[] {
  const findings: InternalIdentifierFinding[] = [];

  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") {
      /* `includes`, not `startsWith`: an internal id embedded mid-string — inside
         a provenance `source` line, say — is exactly the leak worth catching, and
         it is the one a prefix check would miss. */
      for (const prefix of FORBIDDEN_INTERNAL_ID_PREFIXES) {
        if (node.includes(prefix)) findings.push({ path: path || "(root)", prefix });
      }
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${path}[${i}]`));
      return;
    }
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      walk(child, path ? `${path}.${key}` : key);
    }
  };

  walk(value, basePath);
  return findings;
}
