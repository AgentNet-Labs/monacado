/**
 * Order buyer snapshot identity (`mon:obsn:<opaque>`) — SERVER ONLY.
 *
 * Phase 1.46 — the production default. `captureBuyerSnapshot` required an
 * injected provider and nothing on the live `/api/checkout` path supplied one,
 * so every real checkout refused at this step after its Order was placed. The
 * same construction as the other identity modules: 26 Crockford characters
 * from `randomBytes`.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "../../contracts/capsule/identity";
import type { BuyerSnapshotIdProvider } from "./order-buyer-snapshot-service";

const OPAQUE_BODY_LENGTH = 26;

function randomOpaqueBody(): string {
  const bytes = randomBytes(OPAQUE_BODY_LENGTH);
  let out = "";
  for (let i = 0; i < OPAQUE_BODY_LENGTH; i += 1) {
    out += CROCKFORD_ALPHABET[bytes[i]! % CROCKFORD_ALPHABET.length];
  }
  return out;
}

export const cryptoBuyerSnapshotIdProvider: BuyerSnapshotIdProvider = {
  nextBuyerSnapshotId: () => `mon:obsn:${randomOpaqueBody()}`,
};
