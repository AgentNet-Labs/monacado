/**
 * Synthetic Product source-record fixtures (Phase 0C). OBVIOUSLY SYNTHETIC data
 * for tests, the validate script, and the demo. Fixed constants → deterministic
 * candidates and hashes. No real records, creators, or endpoints.
 */

import {
  makeInternalCreatorId,
  makeInternalProductId,
  makeSourceRecordId,
  makeSyntheticNodeId,
} from "../capsule/identity";
import type { ProductSourceRecord } from "../product/product-source-record";

// Opaque 26-char Crockford bodies (synthetic), distinct per identifier.
const SOURCE_RECORD_OPAQUE = "01HQ8ZK3M9P7R5T2V4W6XY8N1A";
const INTERNAL_PRODUCT_OPAQUE = "01HQ8ZK3M9P7R5T2V4W6XY8N1B";
const CREATOR_AUTHORITY_OPAQUE = "01HQ8ZK3M9P7R5T2V4W6XY8N1C";
const CREATOR_NODE_OPAQUE = "01HQ8ZK3M9P7R5T2V4W6XY8N1D";
const OFFER_NODE_OPAQUE = "01HQ8ZK3M9P7R5T2V4W6XY8N1E";

export const SYN_SOURCE_RECORD_ID = makeSourceRecordId(SOURCE_RECORD_OPAQUE);
export const SYN_INTERNAL_PRODUCT_ID = makeInternalProductId(INTERNAL_PRODUCT_OPAQUE);
export const SYN_CREATOR_AUTHORITY_ID = makeInternalCreatorId(CREATOR_AUTHORITY_OPAQUE);
export const SYN_CREATOR_NODE_ID = makeSyntheticNodeId(CREATOR_NODE_OPAQUE);
export const SYN_OFFER_NODE_ID = makeSyntheticNodeId(OFFER_NODE_OPAQUE);

export const SYN_MAPPING_VERSION = "0c.1.0.0";

export const SYN_CREATED_AT = "2026-01-01T00:00:00.000Z";
export const SYN_UPDATED_AT = "2026-01-01T00:00:00.000Z";
export const SYN_ACQUIRED_AT = "2026-01-01T00:00:00.000Z";
// Distinct from updatedAt on purpose: the capsule-generation event is separate.
export const SYN_CAPSULE_GENERATED_AT = "2026-01-01T06:30:00.000Z";
export const SYN_UPDATED_AT_V2 = "2026-02-01T00:00:00.000Z";
export const SYN_CAPSULE_GENERATED_AT_V2 = "2026-02-01T06:30:00.000Z";

/** A synthetic authoritative Product source record (version "1"). */
export function syntheticProductSourceRecord(): ProductSourceRecord {
  return {
    sourceRecordId: SYN_SOURCE_RECORD_ID,
    sourceRecordVersion: "1",
    internalProductId: SYN_INTERNAL_PRODUCT_ID,
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    authority: {
      creatorId: SYN_CREATOR_AUTHORITY_ID,
      authorityScope: "product-facts",
      authorizationState: "authorized",
      authorizationRef: "mon:authz:synthetic-0c",
    },
    facts: {
      name: "Synthetic CLI Toolkit",
      description: "An obviously synthetic developer tool used for Phase 0C fixtures.",
      image: "https://monacado.com/media/synthetic/cli-toolkit.png",
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      specifications: { os: "cross-platform", format: "binary", weightGrams: 0, signed: true },
      capabilities: ["scaffold", "validate", "export"],
      relationships: { creator: SYN_CREATOR_NODE_ID, offer: SYN_OFFER_NODE_ID },
    },
    capsuleSemver: "1.0.0",
    mappingVersion: SYN_MAPPING_VERSION,
    recordStatus: "authoring-complete",
    createdAt: SYN_CREATED_AT,
    updatedAt: SYN_UPDATED_AT,
    acquiredAt: SYN_ACQUIRED_AT,
    capsuleGeneratedAt: SYN_CAPSULE_GENERATED_AT,
  };
}
