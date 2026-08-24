/**
 * Prisma ⇄ domain mapping for Product source records (Phase 0D).
 *
 * Prisma rows are persistence details, never the public domain contract. Every
 * row read is reconstructed into a validated Phase 0C `ProductSourceRecord`
 * (via `ProductSourceRecordSchema`); malformed persisted data surfaces as a
 * structured contract violation. Timestamps and mapping controls are preserved
 * exactly; every Product fact is preserved. No Product-to-capsule mapping logic
 * is duplicated here — callers use the existing Phase 0C mapper after
 * reconstruction.
 */

import type { Prisma, ProductSourceRecordVersionRow } from "@prisma/client";
import {
  ProductSourceRecordSchema,
  type ProductSourceRecord,
} from "../../contracts/product/product-source-record";
import { PersistedContractViolationError } from "./errors";

/** ISO-8601 (ms, UTC) string for a persisted DateTime — exact round-trip for ms-precision UTC values. */
function iso(d: Date): string {
  return d.toISOString();
}

/**
 * Reconstruct a validated domain ProductSourceRecord from a persisted version row.
 * Throws PersistedContractViolationError if the stored data violates the contract.
 */
export function versionRowToDomain(row: ProductSourceRecordVersionRow): ProductSourceRecord {
  const specifications = row.factSpecifications;
  const capabilities = row.factCapabilities;

  const candidate = {
    sourceRecordId: row.sourceRecordId,
    sourceRecordVersion: row.sourceRecordVersion,
    internalProductId: row.internalProductId,
    sourceSystem: row.sourceSystem,
    sourceRecordType: row.sourceRecordType,
    sourceClass: row.sourceClass,
    authority: {
      creatorId: row.authorityCreatorId,
      authorityScope: row.authorityScope,
      authorizationState: row.authorityAuthorizationState,
      ...(row.authorityAuthorizationRef !== null
        ? { authorizationRef: row.authorityAuthorizationRef }
        : {}),
    },
    facts: {
      name: row.factName,
      ...(row.factDescription !== null ? { description: row.factDescription } : {}),
      ...(row.factImage !== null ? { image: row.factImage } : {}),
      productVersion: row.factProductVersion,
      promotable: row.factPromotable,
      generalAvailabilityState: row.factGeneralAvailabilityState,
      ...(row.factDeliveryMode !== null ? { deliveryMode: row.factDeliveryMode } : {}),
      ...(specifications !== null && specifications !== undefined ? { specifications } : {}),
      ...(capabilities !== null && capabilities !== undefined ? { capabilities } : {}),
      relationships: {
        creator: row.factCreatorRef,
        ...(row.factOfferRef !== null ? { offer: row.factOfferRef } : {}),
      },
    },
    capsuleSemver: row.capsuleSemver,
    mappingVersion: row.mappingVersion,
    recordStatus: row.recordStatus,
    /* Phase 1.6 — a source-record field, not a Product fact, so it sits beside
       recordStatus rather than inside `facts`. Omitted rather than nulled when
       absent: the contract makes it optional, and an explicit null would not
       parse. */
    ...(row.taxClassification !== null ? { taxClassification: row.taxClassification } : {}),
    createdAt: iso(row.sourceCreatedAt),
    updatedAt: iso(row.sourceUpdatedAt),
    acquiredAt: iso(row.acquiredAt),
    capsuleGeneratedAt: iso(row.capsuleGeneratedAt),
  };

  const parsed = ProductSourceRecordSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PersistedContractViolationError(
      "Persisted Product source record violates the ProductSourceRecord contract",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return parsed.data;
}

/**
 * Build the Prisma create input for a version row from a validated domain record.
 * Timestamps are stored as Date (DATETIME(3)); JSON fields carry validated shapes.
 */
export function domainToVersionCreateInput(
  record: ProductSourceRecord,
): Prisma.ProductSourceRecordVersionRowCreateManyInput {
  return {
    internalProductId: record.internalProductId,
    sourceRecordId: record.sourceRecordId,
    sourceRecordVersion: record.sourceRecordVersion,
    sourceSystem: record.sourceSystem,
    sourceRecordType: record.sourceRecordType,
    sourceClass: record.sourceClass,
    authorityCreatorId: record.authority.creatorId,
    authorityScope: record.authority.authorityScope,
    authorityAuthorizationState: record.authority.authorizationState,
    authorityAuthorizationRef: record.authority.authorizationRef ?? null,
    factName: record.facts.name,
    factDescription: record.facts.description ?? null,
    factImage: record.facts.image ?? null,
    factProductVersion: record.facts.productVersion,
    factPromotable: record.facts.promotable,
    factGeneralAvailabilityState: record.facts.generalAvailabilityState,
    factDeliveryMode: record.facts.deliveryMode ?? null,
    factSpecifications:
      record.facts.specifications === undefined
        ? undefined
        : (record.facts.specifications as Prisma.InputJsonValue),
    factCapabilities:
      record.facts.capabilities === undefined
        ? undefined
        : (record.facts.capabilities as Prisma.InputJsonValue),
    factCreatorRef: record.facts.relationships.creator,
    factOfferRef: record.facts.relationships.offer ?? null,
    capsuleSemver: record.capsuleSemver,
    mappingVersion: record.mappingVersion,
    capsuleGeneratedAt: new Date(record.capsuleGeneratedAt),
    acquiredAt: new Date(record.acquiredAt),
    sourceCreatedAt: new Date(record.createdAt),
    sourceUpdatedAt: new Date(record.updatedAt),
    recordStatus: record.recordStatus,
    taxClassification: record.taxClassification ?? null,
  };
}
