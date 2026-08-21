/**
 * Guest purchase claim codes (Phase 0M.9) — SERVER ONLY.
 *
 * A guest buys without an account. The claim code is the **only** thing binding
 * that person to that purchase, and it is deliberately the only thing: Monacado
 * stores no email, no name, and no device for a guest, so possession of the code
 * is both the proof and the entire identity.
 *
 * The construction is `session-token.ts`'s, for its reasons, restated only where
 * this differs:
 *
 *   - **256 bits of randomness, base64url.** Unguessable, so no slow hash is
 *     warranted; a memory-hard KDF here would buy nothing and cost every claim.
 *   - **Only the SHA-256 digest is stored.** The raw code is returned once, at
 *     checkout, and written nowhere. A database disclosure therefore yields no
 *     means of claiming anybody's purchase.
 *   - **Compared by the unique index**, i.e. an indexed equality lookup rather
 *     than a byte-by-byte compare in application code, so there is no
 *     string-comparison timing signal here either.
 *
 * **No expiry.** A purchase does not stop having been made, and a code that
 * expired would strand a buyer's own receipt behind a deadline nobody told them
 * about. If a claim window is ever wanted it is a policy decision for the claim
 * phase, made in the open, rather than a default this foundation guessed.
 */

import "../server-only";
import { createHash, randomBytes } from "node:crypto";

/** 32 bytes = 256 bits. */
const GUEST_CLAIM_CODE_BYTES = 32;

/** base64url of 32 bytes, unpadded. */
export const GUEST_CLAIM_CODE_RE = /^[A-Za-z0-9_-]{43}$/;

/** Hex SHA-256 — the only form ever persisted. */
export const GUEST_CLAIM_CODE_DIGEST_RE = /^[0-9a-f]{64}$/;

/**
 * Injectable code source. Production uses the crypto-backed default; a test
 * supplies a deterministic code so a fixture can assert an exact digest.
 */
export interface GuestClaimCodeProvider {
  nextGuestClaimCode(): string;
}

export const cryptoGuestClaimCodeProvider: GuestClaimCodeProvider = {
  nextGuestClaimCode: () => randomBytes(GUEST_CLAIM_CODE_BYTES).toString("base64url"),
};

/** One-way digest of a guest claim code. The only form ever persisted. */
export function hashGuestClaimCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}
