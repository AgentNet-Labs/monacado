/**
 * The application-safe Product revision token (Phase 1.38) — SERVER ONLY.
 *
 * Names ONE current-version state of ONE Product, so a Seller's revision can be
 * made conditional on the state the Seller actually edited. Two tabs editing
 * the same Product hold the same token; the first save moves the Product to a
 * new version (and a new token), and the second — still holding the old one —
 * is refused instead of silently overwriting the first.
 *
 * ## Why not the version label
 *
 * Every self-service route keeps `sourceRecordVersion` out of the client: it is
 * an internal record label, and the routes argue that it has "nowhere to go".
 * The token is purpose-built instead:
 *
 *   SHA-256( "monacado:product-revision:v1" ‖ sourceRecordId ‖ sourceRecordVersion )
 *   → first 128 bits, lowercase hex
 *
 * - **Opaque.** It is a digest, not an identifier: it cannot be inverted to the
 *   `mon:srec:` id or the version label, and because the source-record id is
 *   160 random bits, nobody can compute a token for a Product's version without
 *   already holding that internal id.
 * - **Deterministic and stateless.** Recomputed from the authoritative current
 *   pointer on every read and every write; nothing is stored, so no schema
 *   exists for it and none can drift.
 * - **Changes on every revision**, because every revision has a new version
 *   label, and never repeats across Products, because the source-record id
 *   differs.
 *
 * It is not an authorization credential: holding a token grants nothing, and
 * every revision still proves creator authority independently.
 */

import "../server-only";
import { createHash } from "node:crypto";
import { z } from "zod";

const DOMAIN = "monacado:product-revision:v1";

/** 32 lowercase hex characters (128 bits). */
export const ProductRevisionToken = z
  .string()
  .regex(/^[0-9a-f]{32}$/, "revision token must be 32 lowercase hex characters");
export type ProductRevisionToken = z.infer<typeof ProductRevisionToken>;

export function productRevisionToken(sourceRecordId: string, sourceRecordVersion: string): string {
  return createHash("sha256")
    .update(`${DOMAIN}\u0000${sourceRecordId}\u0000${sourceRecordVersion}`)
    .digest("hex")
    .slice(0, 32);
}
