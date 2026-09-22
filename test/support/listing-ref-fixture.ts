/**
 * A synthetic `Listing.listingRef` for a test fixture that writes a `Listing`
 * row directly (Phase 1.35).
 *
 * `listingRef` is NOT NULL and unique, and the application mints it inside the
 * Listing persistence path — deliberately, so no caller can choose one. A
 * fixture that bypasses the service and inserts a row itself therefore has to
 * supply its own, and this is the one place that knows how.
 *
 * The same shape and alphabet as the production draw, so a fixture row is
 * indistinguishable from a real one and the format assertions hold over both.
 * Random rather than seeded because the only property a fixture needs is
 * uniqueness.
 */

import { randomApplicationRef } from "../../src/server/application-reference";

export const syntheticListingRef = randomApplicationRef;
