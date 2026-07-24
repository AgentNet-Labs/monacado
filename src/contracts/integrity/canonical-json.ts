/**
 * Deterministic canonical JSON serialization (ADR §1, §8; Phase 0B hashing rule).
 *
 * Algorithm (exact):
 *   1. Objects (non-null, non-array): emit a new object whose keys are sorted
 *      ascending by JavaScript string comparison (UTF-16 code-unit order). Each
 *      value is canonicalized recursively. Keys whose value is `undefined` are
 *      omitted (they are absent, not null).
 *   2. Arrays: order is preserved (array order is semantic); each element is
 *      canonicalized recursively.
 *   3. Strings, booleans, null: emitted as-is via standard JSON escaping.
 *   4. Numbers: must be finite. The Product capsule carries only integers, so
 *      number formatting is unambiguous; non-finite numbers throw.
 *   5. The resulting structure is serialized with `JSON.stringify` and no
 *      whitespace. Because keys are pre-sorted, insertion order cannot affect
 *      the output — equivalent objects with different key order serialize
 *      identically.
 *
 * This operates on the semantic capsule object only. It never serializes a
 * relational projection or a publication envelope.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json | undefined };

function canonicalize(value: unknown): Json {
  if (value === null) return null;

  if (Array.isArray(value)) {
    return value.map((v) => canonicalize(v));
  }

  const t = typeof value;

  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) {
      throw new Error("Cannot canonicalize a non-finite number");
    }
    return n;
  }

  if (t === "string" || t === "boolean") {
    return value as string | boolean;
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, Json> = {};
    for (const key of Object.keys(obj).sort()) {
      const v = obj[key];
      if (v === undefined) continue; // absent, not null
      out[key] = canonicalize(v);
    }
    return out;
  }

  throw new Error(`Cannot canonicalize value of type ${t}`);
}

/** Canonicalize and serialize to a stable, whitespace-free JSON string. */
export function canonicalJsonString(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
