/**
 * Synthetic Product fixtures (Phase 0B.1). OBVIOUSLY SYNTHETIC data for tests,
 * the validate script, and the demo. Fixed constants → deterministic hashes. No
 * real creators, products, source records, Nodes, or endpoints.
 */

import { MONACADO_PUBLISHER_ID } from "../product/product.authority";
import {
  makeInternalProductId,
  makeSyntheticCapsuleId,
  makeSyntheticNodeId,
} from "../capsule/identity";
import type { PolicyRef } from "../capsule/envelope";
import type { FinalizeInput, ProductSourceRecord } from "../product/product.factory";

// Opaque 26-char Crockford bodies (synthetic).
const NODE_OPAQUE = "01HQ8ZK3M9P7R5T2V4W6XY8N0A";
const CAPSULE_V1_OPAQUE = "01HQ8ZK3M9P7R5T2V4W6XY8N0B";
const CAPSULE_V2_OPAQUE = "01HQ8ZK3M9P7R5T2V4W6XY8N0C";
const CREATOR_OPAQUE = "01HQ8ZK3M9P7R5T2V4W6XY8N0D";
const OFFER_OPAQUE = "01HQ8ZK3M9P7R5T2V4W6XY8N0E";
const PRODUCT_INTERNAL_OPAQUE = "01HQ8ZK3M9P7R5T2V4W6XY8N0F";

// ANS Node ID (Registrar-issued opaque) — distinct from the internal Product ID.
export const SYN_NODE_ID = makeSyntheticNodeId(NODE_OPAQUE);
export const SYN_INTERNAL_PRODUCT_ID = makeInternalProductId(PRODUCT_INTERNAL_OPAQUE);
export const SYN_CREATOR_NODE_ID = makeSyntheticNodeId(CREATOR_OPAQUE);
export const SYN_OFFER_NODE_ID = makeSyntheticNodeId(OFFER_OPAQUE);
export const SYN_CAPSULE_ID_V1 = makeSyntheticCapsuleId(CAPSULE_V1_OPAQUE);
export const SYN_CAPSULE_ID_V2 = makeSyntheticCapsuleId(CAPSULE_V2_OPAQUE);

// The semantic path that MUST be rejected as an ANS Node ID.
export const SYN_SEMANTIC_NODE_ID = "https://monacado.com/id/product/01J9Z3K7Q0V2M5N8P4R6T1W3XY";

// Timestamps.
export const SYN_ACQUIRED_AT = "2026-01-01T00:00:00.000Z";
export const SYN_GENERATED_AT = "2026-01-01T00:00:00.000Z";
export const SYN_PUBLISHED_AT = "2026-01-02T00:00:00.000Z";
export const SYN_ACQUIRED_AT_V2 = "2026-02-01T00:00:00.000Z";
export const SYN_GENERATED_AT_V2 = "2026-02-01T00:00:00.000Z";
export const SYN_PUBLISHED_AT_V2 = "2026-02-02T00:00:00.000Z";

export const SYN_NODE_POLICY: PolicyRef = { ref: "an:policy:node:synthetic-0b1", version: "1.0.0" };
export const SYN_CAPSULE_POLICY: PolicyRef = { ref: "an:policy:capsule:synthetic-0b1", version: "1.0.0" };

/** A synthetic authoritative Monacado Product source record (version 1). */
export function syntheticSourceRecord(): ProductSourceRecord {
  return {
    sourceRecordId: SYN_INTERNAL_PRODUCT_ID,
    sourceRecordVersion: "1",
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    acquiredAt: SYN_ACQUIRED_AT,
    facts: {
      name: "Synthetic CLI Toolkit",
      description: "An obviously synthetic developer tool used for Phase 0B.1 fixtures.",
      image: "https://monacado.com/media/synthetic/cli-toolkit.png",
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      specifications: { os: "cross-platform", format: "binary", weightGrams: 0, signed: true },
      capabilities: ["scaffold", "validate", "export"],
      relationships: { creator: SYN_CREATOR_NODE_ID, offer: SYN_OFFER_NODE_ID },
    },
  };
}

/** A synthetic revised source record (version 2, changed facts). */
export function syntheticSourceRecordV2(): ProductSourceRecord {
  const base = syntheticSourceRecord();
  return {
    ...base,
    sourceRecordVersion: "2",
    acquiredAt: SYN_ACQUIRED_AT_V2,
    facts: {
      ...base.facts,
      name: "Synthetic CLI Toolkit (Pro)",
      productVersion: 2,
      capabilities: ["scaffold", "validate", "export", "publish"],
    },
  };
}

/** Synthetic publication inputs for finalising version 1 (fresh copy). */
export function syntheticFinalizeInputs(): Omit<FinalizeInput, "candidate"> {
  return {
    capsuleId: SYN_CAPSULE_ID_V1,
    bindsToNode: SYN_NODE_ID,
    publishedBy: MONACADO_PUBLISHER_ID,
    publishedAt: SYN_PUBLISHED_AT,
    nodePolicy: { ...SYN_NODE_POLICY },
    capsulePolicy: { ...SYN_CAPSULE_POLICY },
  };
}
