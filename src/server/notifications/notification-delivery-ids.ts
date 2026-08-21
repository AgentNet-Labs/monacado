/**
 * Opaque identity generation for delivery attempts (Phase 1.1) — SERVER ONLY.
 *
 * The same construction as every other identity provider here: `crypto.randomBytes`
 * over the Crockford alphabet, `byte % 32` bias-free because 256 is an exact
 * multiple of the 32-character alphabet.
 *
 * A delivery id encodes nothing — not the recipient, not the address, not the
 * channel, not the order. An identifier that encoded a recipient would be a
 * recipient identifier, and this phase's whole premise is that Monacado holds as
 * little about a buyer as a delivery record can function on.
 *
 * **A provider message reference is never minted here.** It is an external string
 * an adapter returns, and generating one would mean Monacado had invented
 * evidence that a message was sent.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "../../contracts/capsule/identity";
import { NOTIFICATION_DELIVERY_ID_RE } from "../../contracts/marketplace/identity";

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
export interface NotificationDeliveryIdProvider {
  nextDeliveryId(): string;
}

export const cryptoNotificationDeliveryIdProvider: NotificationDeliveryIdProvider = {
  nextDeliveryId: () => `mon:ndlv:${randomOpaqueBody()}`,
};

/** Asserted by a test rather than guarded at runtime — it holds by construction. */
export const NOTIFICATION_DELIVERY_ID_PATTERN = NOTIFICATION_DELIVERY_ID_RE;
