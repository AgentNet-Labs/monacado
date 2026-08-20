/**
 * Opaque identity generation for transaction economic snapshots (Phase 0M.T1) —
 * SERVER ONLY.
 *
 * Same construction as `commercial-policy-ids` and `participant-ids`:
 * `crypto.randomBytes` over the Crockford alphabet, `byte % 32` bias-free
 * because 256 is an exact multiple of the 32-character alphabet.
 *
 * A snapshot id names one sale's economics forever. It encodes no amount, no
 * currency, no listing, no participant, no policy, and no ordering — an
 * identifier carrying its economics would become a thing people read instead of
 * the row, and then a thing that lies the first time anyone reconciles.
 *
 * The **settlement** record gets no identity of its own: it is keyed by the
 * snapshot it belongs to, one row per snapshot. A separate identity would invite
 * two settlement rows for one sale, which is exactly the ambiguity the shared key
 * makes impossible.
 *
 * A provider transaction reference is never minted here. It is an **external**
 * string supplied by the provider, and generating one would mean Monacado had
 * invented evidence of a transaction that nobody executed.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "../../contracts/capsule/identity";
import { TRANSACTION_ECONOMIC_SNAPSHOT_ID_RE } from "../../contracts/marketplace/identity";

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
export interface TransactionSnapshotIdProvider {
  nextSnapshotId(): string;
}

export const cryptoTransactionSnapshotIdProvider: TransactionSnapshotIdProvider = {
  nextSnapshotId: () => `mon:txsnp:${randomOpaqueBody()}`,
};

/** Shape asserted by a test rather than guarded at runtime — it holds by construction. */
export const TRANSACTION_SNAPSHOT_ID_PATTERN = TRANSACTION_ECONOMIC_SNAPSHOT_ID_RE;
