/**
 * Build the first source version of a self-service private Product draft
 * (Phase 1.32) — SERVER ONLY, pure.
 *
 * Takes the SELLER's own facts and stamps everything else a Product source
 * record carries: fresh identifiers, version "1", `recordStatus: "draft"`, the
 * `product-facts` authority scope in the `authorized` state, the Phase 1.32
 * capsule-semver and mapping-version constants, and one instant for all four
 * timestamps. `facts.productVersion` is 1: this is the Product's first version.
 *
 * **Creator identity follows ADR §10.3 exactly.** The authority carries no
 * `creatorId` and the facts carry no `relationships.creator`: a draft's public
 * creator identity is bound at governed admission/publication, and nothing here
 * invents one. `creatorParticipantId` is also left off — it is set by
 * `createProductSourceRecordAs` from the resolved acting participant, the only
 * place authorship is known, and never from anything built here.
 */

import "../server-only";
import {
  INITIAL_PRODUCT_CAPSULE_SEMVER,
  SELF_SERVICE_PRODUCT_MAPPING_VERSION,
  type DraftProductInput,
  type ProductSourceRecord,
} from "../../contracts/product/product-source-record";
import type { ProductIdProvider } from "./product-ids";

export const INITIAL_PRODUCT_SOURCE_RECORD_VERSION = "1" as const;

export function buildDraftProductSourceRecord(
  input: DraftProductInput,
  context: { now: string; ids: ProductIdProvider },
): ProductSourceRecord {
  return {
    sourceRecordId: context.ids.nextSourceRecordId(),
    sourceRecordVersion: INITIAL_PRODUCT_SOURCE_RECORD_VERSION,
    internalProductId: context.ids.nextInternalProductId(),
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    authority: {
      authorityScope: "product-facts",
      authorizationState: "authorized",
    },
    facts: {
      name: input.name,
      ...(input.description !== null ? { description: input.description } : {}),
      productVersion: 1,
      promotable: input.promotable,
      generalAvailabilityState: input.generalAvailabilityState,
      deliveryMode: input.deliveryMode,
      relationships: {},
    },
    capsuleSemver: INITIAL_PRODUCT_CAPSULE_SEMVER,
    mappingVersion: SELF_SERVICE_PRODUCT_MAPPING_VERSION,
    recordStatus: "draft",
    createdAt: context.now,
    updatedAt: context.now,
    acquiredAt: context.now,
    capsuleGeneratedAt: context.now,
  };
}
