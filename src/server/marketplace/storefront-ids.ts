/**
 * Opaque identity generation for Storefronts and governance assignments
 * (Phase 0M.3C) — SERVER ONLY.
 *
 * Same construction as `participant-ids` and `account-ids`:
 * `crypto.randomBytes` over the Crockford alphabet, `byte % 32` bias-free
 * because 256 is an exact multiple of the 32-character alphabet.
 *
 * Neither identifier encodes the owner, the handle, the lifecycle, or the role.
 * A Storefront that changed hands, or an assignment that changed role, would
 * otherwise carry a lie in its own identifier.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "../../contracts/capsule/identity";
import {
  INTERNAL_STOREFRONT_ID_RE,
  STOREFRONT_GOVERNANCE_ASSIGNMENT_ID_RE,
} from "../../contracts/marketplace/identity";
import { SOURCE_RECORD_ID_RE } from "../../contracts/capsule/identity";

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
export interface StorefrontIdProvider {
  nextInternalStorefrontId(): string;
  nextStorefrontSourceRecordId(): string;
  nextGovernanceAssignmentId(): string;
}

export const cryptoStorefrontIdProvider: StorefrontIdProvider = {
  nextInternalStorefrontId: () => `mon:storefront:${randomOpaqueBody()}`,
  nextStorefrontSourceRecordId: () => `mon:srec:${randomOpaqueBody()}`,
  nextGovernanceAssignmentId: () => `mon:sgov:${randomOpaqueBody()}`,
};

/** Shapes asserted by a test rather than guarded at runtime — they hold by construction. */
export const STOREFRONT_ID_PATTERNS = {
  storefront: INTERNAL_STOREFRONT_ID_RE,
  sourceRecord: SOURCE_RECORD_ID_RE,
  governanceAssignment: STOREFRONT_GOVERNANCE_ASSIGNMENT_ID_RE,
} as const;
