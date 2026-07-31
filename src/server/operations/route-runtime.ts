/**
 * Route runtime providers (Phase 0E.7.4.2B) — SERVER ONLY.
 *
 * The clock and the request-id source for the route boundary, both injectable so a
 * test drives deterministic values and neither the Phase 0E.7.4.1 service nor the
 * identity services acquire hidden nondeterminism.
 */

import "../server-only";
import { randomBytes } from "node:crypto";
import { CROCKFORD_ALPHABET } from "../../contracts/capsule/identity";

/** `req-` plus 26 Crockford characters, inside the caller contract's 64-char bound. */
export const REQUEST_ID_RE = /^req-[0-9A-HJKMNP-TV-Z]{26}$/;

const OPAQUE_BODY_LENGTH = 26;

export interface RouteClock {
  now(): Date;
}

export interface RequestIdProvider {
  nextRequestId(): string;
}

/** The system clock. Permitted here because this module is the runtime adapter. */
export const systemRouteClock: RouteClock = {
  now: () => new Date(),
};

/**
 * Cryptographically random correlation ids.
 *
 * `randomBytes` rather than a counter or a timestamp: a request id appears in
 * audit events, so a guessable one would let a third party assert which request a
 * recorded event describes. `byte % 32` is bias-free because 256 is an exact
 * multiple of the 32-character alphabet.
 *
 * The id encodes **nothing** — no account, session, email, IP address, endpoint,
 * timestamp, or token. It is 130 bits of randomness with a fixed prefix, so it
 * cannot leak by being decoded.
 */
export const cryptoRequestIdProvider: RequestIdProvider = {
  nextRequestId(): string {
    const bytes = randomBytes(OPAQUE_BODY_LENGTH);
    let out = "";
    for (let i = 0; i < OPAQUE_BODY_LENGTH; i += 1) {
      out += CROCKFORD_ALPHABET[bytes[i]! % CROCKFORD_ALPHABET.length];
    }
    return `req-${out}`;
  },
};
