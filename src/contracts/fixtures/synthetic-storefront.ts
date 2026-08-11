/**
 * Synthetic Storefront projection fixture (Phase 0M.3B).
 *
 * Offline test/demo data for the Storefront capsule projection. Every identifier
 * is obviously synthetic, and no real participant, handle, or business appears.
 *
 * Deliberately mirrors `synthetic-product`: fixtures live beside the contracts so
 * `contracts:validate` can exercise a real projection without a database.
 */

import type { StorefrontSourceVersion } from "../marketplace/storefront-source";
import type { StorefrontProjectionContext } from "../marketplace/storefront.projection";
import {
  STOREFRONT_PROJECTION_MAPPING_VERSION,
  SUPPORTED_STOREFRONT_CAPSULE_VERSION,
} from "../marketplace/storefront.projection";

/**
 * Build a valid 26-character Crockford opaque body from a readable seed.
 *
 * Crockford base32 excludes I, L, O, and U, so they are folded to `0` rather than
 * left to fail a regex at test time — a fixture that silently produced an invalid
 * identifier would report a contract bug that was really a typo here.
 */
const body = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const SREC = body("0M3BSREC");
const STOREFRONT = body("0M3BSTFRNT");
const OWNER = body("0M3BOWNERPART");
const ACTOR = body("0M3BACTOR");
const STOREFRONT_NODE = body("0M3BNODESTFRNT");
const OWNER_NODE = body("0M3BNODEOWNERAUTH");
const CAPSULE = body("0M3BCAPSULESTFRNT");

export function syntheticStorefrontSourceVersion(): StorefrontSourceVersion {
  return {
    storefrontSourceRecordId: `mon:srec:${SREC}`,
    sourceRecordVersion: "1",
    supersedesSourceRecordVersion: null,
    internalStorefrontId: `mon:storefront:${STOREFRONT}`,
    sourceSystem: "monacado",
    sourceRecordType: "Storefront",
    sourceClass: "governed-database-record",
    ownerParticipantId: `mon:mpart:${OWNER}`,
    lifecycle: "ACTIVE",
    visibility: "PUBLIC",
    publicHandle: "synthetic-example-shop",
    presentation: {
      displayName: "Synthetic Example Shop",
      tagline: "A synthetic storefront used only for offline validation.",
      summary: "This storefront exists solely as a Phase 0M.3B projection fixture.",
    },
    authorizedByParticipantId: `mon:mpart:${OWNER}`,
    authorizedByActorId: `mon:actor:${ACTOR}`,
    recordedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function syntheticStorefrontProjectionContext(): StorefrontProjectionContext {
  return {
    storefrontBinding: {
      storefrontNode: `an:node:${STOREFRONT_NODE}`,
      internalStorefrontId: `mon:storefront:${STOREFRONT}`,
    },
    ownerBinding: {
      ownerAuthorityNode: `an:node:${OWNER_NODE}`,
      ownerParticipantId: `mon:mpart:${OWNER}`,
    },
    sourceVersionBinding: {
      storefrontSourceRecordId: `mon:srec:${SREC}`,
      sourceRecordVersion: "1",
    },
    goLiveApproval: "APPROVED",
    capsuleId: `an:capsule:${CAPSULE}`,
    capsuleVersion: SUPPORTED_STOREFRONT_CAPSULE_VERSION,
    mappingVersion: STOREFRONT_PROJECTION_MAPPING_VERSION,
    generatedAt: "2026-01-01T06:30:00.000Z",
    nodePolicy: { ref: "mon:policy:node/storefront/v1", version: "1.0.0" },
    capsulePolicy: { ref: "mon:policy:capsule/storefront/v1", version: "1.0.0" },
  };
}
