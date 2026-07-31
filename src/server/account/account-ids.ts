/**
 * Opaque identity generation for accounts, sessions, and entitlements
 * (Phase 0E.7.4.2A) — SERVER ONLY.
 *
 * `crypto.randomBytes` rather than `Math.random`: these identifiers key
 * authorization, and a predictable account or entitlement id would let a third
 * party guess a target for a grant, a revocation, or a lookup.
 *
 * `byte % 32` is bias-free because 256 is an exact multiple of the alphabet's 32
 * characters — no rejection sampling is needed, and adding a loop would be a loop
 * with no effect.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import {
  ACCOUNT_ENTITLEMENT_ID_RE,
  ACCOUNT_ID_RE,
  ACCOUNT_SESSION_ID_RE,
  CROCKFORD_ALPHABET,
} from "../../contracts/capsule/identity";

/** Length of the opaque body shared by every Monacado identifier. */
const OPAQUE_BODY_LENGTH = 26;

function randomOpaqueBody(): string {
  const bytes = randomBytes(OPAQUE_BODY_LENGTH);
  let out = "";
  for (let i = 0; i < OPAQUE_BODY_LENGTH; i += 1) {
    out += CROCKFORD_ALPHABET[bytes[i]! % CROCKFORD_ALPHABET.length];
  }
  return out;
}

/**
 * Injectable identity source. Production uses the crypto-backed default; a test
 * supplies deterministic ids so a fixture can be asserted exactly.
 */
export interface AccountIdProvider {
  nextAccountId(): string;
  nextSessionId(): string;
  nextEntitlementId(): string;
}

export const cryptoAccountIdProvider: AccountIdProvider = {
  nextAccountId: () => `mon:acct:${randomOpaqueBody()}`,
  nextSessionId: () => `mon:asess:${randomOpaqueBody()}`,
  nextEntitlementId: () => `mon:aent:${randomOpaqueBody()}`,
};

/** Shapes asserted by a test rather than guarded at runtime — they hold by construction. */
export const ACCOUNT_ID_PATTERNS = {
  account: ACCOUNT_ID_RE,
  session: ACCOUNT_SESSION_ID_RE,
  entitlement: ACCOUNT_ENTITLEMENT_ID_RE,
} as const;
