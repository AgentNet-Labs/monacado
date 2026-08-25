/**
 * Opaque identity for tax transactions (Phase 1.7) — SERVER ONLY.
 *
 * The same construction as every other identity provider here. A tax transaction
 * id encodes nothing — not the Order, the amount, the jurisdiction, or the
 * provider's own reference.
 *
 * **A provider Tax Transaction reference is never minted here.** It is an
 * external string Stripe returns, and generating one would mean Monacado had
 * invented evidence that a transaction was reported.
 *
 * The lock token is a *claim* credential, not an identity: it is compared, never
 * published, and a new one is minted for every claim.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "../../contracts/capsule/identity";

const OPAQUE_BODY_LENGTH = 26;

function randomOpaqueBody(): string {
  const bytes = randomBytes(OPAQUE_BODY_LENGTH);
  let out = "";
  for (let i = 0; i < OPAQUE_BODY_LENGTH; i += 1) {
    out += CROCKFORD_ALPHABET[bytes[i]! % CROCKFORD_ALPHABET.length];
  }
  return out;
}

export interface TaxTransactionIdProvider {
  nextTaxTransactionId(): string;
  nextLockToken(): string;
}

export const cryptoTaxTransactionIdProvider: TaxTransactionIdProvider = {
  nextTaxTransactionId: () => `mon:txtax:${randomOpaqueBody()}`,
  nextLockToken: () => randomBytes(24).toString("hex"),
};
