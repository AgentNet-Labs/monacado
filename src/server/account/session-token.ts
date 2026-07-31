/**
 * Session tokens (Phase 0E.7.4.2A) — SERVER ONLY.
 *
 * A session token is 256 bits of cryptographic randomness, rendered base64url,
 * and stored **only** as its SHA-256 digest. The raw token is returned once, at
 * creation, and never written anywhere — so a database disclosure yields no
 * usable credential, only digests of tokens that will expire.
 *
 * **Why SHA-256 here and Argon2id for passwords.** A slow, memory-hard hash
 * exists to make guessing a *low-entropy human secret* expensive. A 256-bit
 * random token cannot be guessed at all, so the cost buys nothing — while a fast
 * digest keeps session resolution cheap on every request. Using Argon2id for
 * tokens would be a self-inflicted denial of service; using SHA-256 for passwords
 * would be a real vulnerability. The asymmetry is deliberate.
 *
 * Digests are compared by the database's unique index on `tokenHash`, i.e. by an
 * indexed equality lookup rather than a byte-by-byte compare in application code,
 * so there is no string-comparison timing signal to leak here.
 */

import "../server-only";
import { createHash, randomBytes } from "node:crypto";

/** 32 bytes = 256 bits. */
const SESSION_TOKEN_BYTES = 32;

/** base64url of 32 bytes, unpadded. */
export const SESSION_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Hex SHA-256. */
export const SESSION_TOKEN_HASH_RE = /^[0-9a-f]{64}$/;

/**
 * Injectable token source. Production uses the crypto-backed default; a test
 * supplies a deterministic token so a fixture can assert an exact digest.
 */
export interface SessionTokenProvider {
  nextSessionToken(): string;
}

export const cryptoSessionTokenProvider: SessionTokenProvider = {
  nextSessionToken: () => randomBytes(SESSION_TOKEN_BYTES).toString("base64url"),
};

/** One-way digest of a session token. The only form ever persisted. */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
