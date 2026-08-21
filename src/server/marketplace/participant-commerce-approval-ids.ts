/**
 * Opaque identity for governed commerce-approval decisions (Phase 0M.9) —
 * SERVER ONLY.
 *
 * Its **own** provider rather than a member on `ParticipantIdProvider`, matching
 * `commercial-policy-ids` and `transaction-accounting-ids`. Widening the shared
 * participant provider would have added a required method to an interface four
 * unrelated suites already implement, for the sake of one identity none of them
 * mints — a change to everybody to serve one caller.
 *
 * Same construction as every other provider here: `crypto.randomBytes` over the
 * Crockford alphabet, `byte % 32` bias-free because 256 is an exact multiple of
 * the 32-character alphabet.
 *
 * The identifier encodes nothing — not the participant, not the decision, not the
 * instant, not an ordering. An id that carried its decision would become a thing
 * people read instead of the row, and then a thing that lies the first time the
 * decision is superseded.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "../../contracts/capsule/identity";
import { PARTICIPANT_COMMERCE_APPROVAL_ID_RE } from "../../contracts/marketplace/identity";

const OPAQUE_BODY_LENGTH = 26;

function randomOpaqueBody(): string {
  const bytes = randomBytes(OPAQUE_BODY_LENGTH);
  let out = "";
  for (let i = 0; i < OPAQUE_BODY_LENGTH; i += 1) {
    out += CROCKFORD_ALPHABET[bytes[i]! % CROCKFORD_ALPHABET.length];
  }
  return out;
}

/** Injectable identity source; a test supplies deterministic ids. */
export interface CommerceApprovalIdProvider {
  nextCommerceApprovalId(): string;
}

export const cryptoCommerceApprovalIdProvider: CommerceApprovalIdProvider = {
  nextCommerceApprovalId: () => `mon:pcap:${randomOpaqueBody()}`,
};

/** Shape asserted by a test rather than guarded at runtime — it holds by construction. */
export const COMMERCE_APPROVAL_ID_PATTERN = PARTICIPANT_COMMERCE_APPROVAL_ID_RE;
