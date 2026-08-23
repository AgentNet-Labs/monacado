/**
 * Opaque identity for durable outbound email (Phase 1.5) — SERVER ONLY.
 *
 * The same construction as every other identity provider here. None of these
 * encodes anything: a delivery id carries no recipient and no order, and a
 * suppression id carries no address — the whole point of that table is that the
 * address is a digest, and an identifier that spelled it out would undo it.
 *
 * **A provider message reference is never minted here.** It is an external string
 * an adapter returns, and generating one would mean Monacado had invented
 * evidence that a message was sent.
 *
 * **A lock token is minted here**, because it is a value only this process should
 * be able to present. It is 128 bits of `randomBytes`, not a counter: a guessable
 * token lets a second worker resolve a claim it does not hold.
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

export interface OutboundEmailIdProvider {
  nextOutboundDeliveryId(): string;
  nextSuppressionId(): string;
  nextProviderEventId(): string;
  /** The discriminator that makes one repeatable message distinct from the next. */
  nextMessageDiscriminator(): string;
  nextLockToken(): string;
}

export const cryptoOutboundEmailIdProvider: OutboundEmailIdProvider = {
  nextOutboundDeliveryId: () => `mon:oeml:${randomOpaqueBody()}`,
  nextSuppressionId: () => `mon:esup:${randomOpaqueBody()}`,
  nextProviderEventId: () => `mon:pevt:${randomOpaqueBody()}`,
  nextMessageDiscriminator: () => randomOpaqueBody(),
  nextLockToken: () => randomBytes(16).toString("hex"),
};
