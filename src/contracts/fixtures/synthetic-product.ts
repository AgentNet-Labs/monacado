/**
 * Synthetic Product capsule fixtures (Phase 0B).
 *
 * OBVIOUSLY SYNTHETIC data for tests, the validate script, and the demo. All
 * ULIDs and timestamps are fixed constants so construction is deterministic and
 * hashes are stable across runs. No real creators, products, or endpoints.
 */

import { makeNodeIri } from "../capsule/identity";
import type { Actor } from "../product/product.authority";
import type { CreateProductInput } from "../product/product.factory";

// Fixed synthetic ULIDs (valid Crockford base32, uppercase, no I/L/O/U).
export const SYN_PRODUCT_ULID = "01J9Z3K7Q0V2M5N8P4R6T1W3XY";
export const SYN_CREATOR_ULID = "01HQ8ZK3M9P7R5T2V4W6XY8N0A";
export const SYN_OFFER_ULID = "01HQ8ZK3M9P7R5T2V4W6XY8N0B";
export const SYN_PROMOTER_ULID = "01HQ8ZK3M9P7R5T2V4W6XY8N0C";

export const SYN_CREATED_AT = "2026-01-01T00:00:00.000Z";
export const SYN_UPDATED_AT = "2026-01-01T00:00:00.000Z";
export const SYN_REVISED_AT = "2026-02-01T00:00:00.000Z";

export const SYN_CREATOR_ACTOR: Actor = {
  role: "creator",
  id: makeNodeIri("creator", SYN_CREATOR_ULID),
};

export const SYN_PROMOTER_ACTOR: Actor = {
  role: "promoter",
  id: makeNodeIri("promoter", SYN_PROMOTER_ULID),
};

/** A valid creator-authoritative Product creation input. */
export function syntheticCreateInput(): CreateProductInput {
  return {
    productUlid: SYN_PRODUCT_ULID,
    name: "Synthetic CLI Toolkit",
    description: "An obviously synthetic developer tool used for Phase 0B fixtures.",
    image: "https://monacado.com/media/synthetic/cli-toolkit.png",
    data: {
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      specifications: {
        os: "cross-platform",
        format: "binary",
        weightGrams: 0,
        signed: true,
      },
      capabilities: ["scaffold", "validate", "export"],
    },
    relationships: {
      creator: makeNodeIri("creator", SYN_CREATOR_ULID),
      offer: makeNodeIri("offer", SYN_OFFER_ULID),
    },
    createdAt: SYN_CREATED_AT,
    updatedAt: SYN_UPDATED_AT,
    actor: SYN_CREATOR_ACTOR,
    metadata: { source: "phase-0b-fixture" },
  };
}
