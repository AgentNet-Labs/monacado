/**
 * Application-facing reference generation (Phase 1.35) — SERVER ONLY.
 *
 * One definition of "application reference" for the whole codebase. Phase 1.34
 * introduced the idea on `Product.productRef`; Phase 1.35 gives `Listing` one
 * too, and a second private copy of the draw would be a second thing to keep
 * correct — the kind of duplication that stays equal right up until one side
 * gets a shorter length or a different alphabet.
 *
 * What a reference is, and is not:
 *
 *   - **Opaque, and carrying no business semantics.** Not a name, not a
 *     sequence, not a version, not derivable from anything a caller knows.
 *   - **Un-namespaced, and that is the guarantee.** Every internal identity
 *     here wears a `mon:` or `an:` prefix, so a bare 32-character body cannot be
 *     read or used as one — not an internal id, a source-record id, an ANS Node
 *     ID, a capsule ID, or a primary key.
 *   - **Cryptographically random.** 32 characters drawn one `randomBytes` byte
 *     each from the Crockford alphabet: 160 bits, non-enumerable. `byte % 32` is
 *     bias-free because 256 is an exact multiple of the 32-character alphabet.
 *   - **32 characters, not 26.** The length is what lets a populated-database
 *     backfill written in SQL (`HEX(RANDOM_BYTES(16))` — 128 bits over
 *     `[0-9A-F]`, a strict subset of this alphabet) clear 128 bits and produce
 *     the same shape. At 26 the SQL path could carry only 104.
 *
 * Callers wrap this in their own injectable provider so a test can pin a value;
 * nothing here reads a clock, an environment variable, or the network.
 */

import "./server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "../contracts/capsule/identity";

/** Characters in an application-facing reference. See the note above. */
export const APPLICATION_REF_LENGTH = 32;

export function randomApplicationRef(): string {
  const bytes = randomBytes(APPLICATION_REF_LENGTH);
  let out = "";
  for (let i = 0; i < APPLICATION_REF_LENGTH; i += 1) {
    out += CROCKFORD_ALPHABET[bytes[i]! % CROCKFORD_ALPHABET.length];
  }
  return out;
}
