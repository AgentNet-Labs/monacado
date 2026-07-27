/**
 * Prisma ⇄ domain mapping for Product publications and publication-outbox items
 * (Phase 0E.2).
 *
 * Prisma rows are persistence details and never escape the adapter. Every row
 * read is reconstructed into a validated domain object; malformed persisted data
 * surfaces as a structured contract violation. The outbox payload is validated
 * against the strict published-capsule schema AND its stored `payloadHash` is
 * verified against the canonical payload on every read — a stored hash that does
 * not match is a contract violation, not a silent pass.
 *
 * No capsule-generation or hashing logic is duplicated here: hashing reuses the
 * shared canonical primitive from the integrity module.
 */

import type { Prisma, ProductPublication as PublicationRow, PublicationOutbox as OutboxRow } from "@prisma/client";
import {
  ProductPublication,
  ProductPublicationOutbox,
  outboxPayloadHash,
  type ProductPublication as ProductPublicationDomain,
  type ProductPublicationOutbox as ProductPublicationOutboxDomain,
  type ProductPublicationOutboxWrite,
  type ProductPublicationWrite,
} from "../../contracts/product/product-publication";
import {
  PersistedOutboxContractViolationError,
  PersistedPublicationContractViolationError,
} from "./publication-errors";

const iso = (d: Date): string => d.toISOString();

const issues = (error: { issues: Array<{ path: PropertyKey[]; message: string }> }): string[] =>
  error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);

/** Reconstruct a validated domain publication from a persisted row. */
export function publicationRowToDomain(row: PublicationRow): ProductPublicationDomain {
  const candidate = {
    id: row.id.toString(),
    publicationId: row.publicationId,
    internalProductId: row.internalProductId,
    sourceRecordId: row.sourceRecordId,
    sourceRecordVersion: row.sourceRecordVersion,
    nodeId: row.nodeId,
    capsuleId: row.capsuleId,
    capsuleSemver: row.capsuleSemver,
    publishedBy: row.publishedBy,
    publishedAt: iso(row.publishedAt),
    nodePolicyRef: row.nodePolicyRef,
    nodePolicyVersion: row.nodePolicyVersion,
    capsulePolicyRef: row.capsulePolicyRef,
    capsulePolicyVersion: row.capsulePolicyVersion,
    candidateHash: row.candidateHash,
    publishedContentHash: row.publishedContentHash,
    mappingVersion: row.mappingVersion,
    capsuleGeneratedAt: iso(row.capsuleGeneratedAt),
    ...(row.supersedesCapsuleId !== null ? { supersedesCapsuleId: row.supersedesCapsuleId } : {}),
    ...(row.revokesCapsuleId !== null ? { revokesCapsuleId: row.revokesCapsuleId } : {}),
    publicationStatus: row.publicationStatus,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };

  const parsed = ProductPublication.safeParse(candidate);
  if (!parsed.success) {
    throw new PersistedPublicationContractViolationError(
      "Persisted Product publication violates the ProductPublication contract",
      issues(parsed.error),
    );
  }
  return parsed.data;
}

/**
 * Reconstruct a validated domain outbox record from a persisted row, validating
 * the JSON payload and verifying the stored payload hash.
 */
export function outboxRowToDomain(row: OutboxRow): ProductPublicationOutboxDomain {
  const candidate = {
    id: row.id.toString(),
    outboxId: row.outboxId,
    publicationId: row.publicationId,
    idempotencyKey: row.idempotencyKey,
    operationType: row.operationType,
    payload: row.payload,
    payloadHash: row.payloadHash,
    outboxStatus: row.outboxStatus,
    attemptCount: row.attemptCount,
    availableAt: iso(row.availableAt),
    // Claim ownership and outcome fields are absent (not null) when unset, so
    // the strict contract's `.optional()` shape round-trips exactly.
    ...(row.lockedAt !== null ? { lockedAt: iso(row.lockedAt) } : {}),
    ...(row.lockToken !== null ? { lockToken: row.lockToken } : {}),
    ...(row.completedAt !== null ? { completedAt: iso(row.completedAt) } : {}),
    ...(row.lastErrorCode !== null ? { lastErrorCode: row.lastErrorCode } : {}),
    ...(row.lastErrorSummary !== null ? { lastErrorSummary: row.lastErrorSummary } : {}),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };

  const parsed = ProductPublicationOutbox.safeParse(candidate);
  if (!parsed.success) {
    // Field paths and messages only — never the payload contents.
    throw new PersistedOutboxContractViolationError(
      "Persisted publication outbox record violates the ProductPublicationOutbox contract",
      issues(parsed.error),
    );
  }

  // Integrity: the stored hash must match the canonical payload exactly.
  const recomputed = outboxPayloadHash(parsed.data.payload);
  if (recomputed !== parsed.data.payloadHash) {
    throw new PersistedOutboxContractViolationError(
      "Persisted outbox payloadHash does not match the canonical payload",
      ["payloadHash: stored hash does not match the canonical payload"],
    );
  }

  return parsed.data;
}

/** Build the Prisma create input for a publication row from validated domain data. */
export function domainToPublicationCreateInput(
  publication: ProductPublicationWrite,
): Prisma.ProductPublicationUncheckedCreateInput {
  return {
    publicationId: publication.publicationId,
    internalProductId: publication.internalProductId,
    sourceRecordId: publication.sourceRecordId,
    sourceRecordVersion: publication.sourceRecordVersion,
    nodeId: publication.nodeId,
    capsuleId: publication.capsuleId,
    capsuleSemver: publication.capsuleSemver,
    publishedBy: publication.publishedBy,
    publishedAt: new Date(publication.publishedAt),
    nodePolicyRef: publication.nodePolicyRef,
    nodePolicyVersion: publication.nodePolicyVersion,
    capsulePolicyRef: publication.capsulePolicyRef,
    capsulePolicyVersion: publication.capsulePolicyVersion,
    candidateHash: publication.candidateHash,
    publishedContentHash: publication.publishedContentHash,
    mappingVersion: publication.mappingVersion,
    capsuleGeneratedAt: new Date(publication.capsuleGeneratedAt),
    supersedesCapsuleId: publication.supersedesCapsuleId ?? null,
    revokesCapsuleId: publication.revokesCapsuleId ?? null,
    publicationStatus: publication.publicationStatus,
  };
}

/** Build the Prisma create input for an outbox row from validated domain data. */
export function domainToOutboxCreateInput(
  outbox: ProductPublicationOutboxWrite,
): Prisma.PublicationOutboxUncheckedCreateInput {
  return {
    outboxId: outbox.outboxId,
    publicationId: outbox.publicationId,
    idempotencyKey: outbox.idempotencyKey,
    operationType: outbox.operationType,
    payload: outbox.payload as unknown as Prisma.InputJsonValue,
    payloadHash: outbox.payloadHash,
    outboxStatus: outbox.outboxStatus,
    attemptCount: outbox.attemptCount,
    availableAt: new Date(outbox.availableAt),
    // A newly prepared item is unclaimed and unresolved. Claim/outcome fields
    // are written only by the Phase 0E.3 processing transitions.
    lockedAt: outbox.lockedAt !== undefined ? new Date(outbox.lockedAt) : null,
    lockToken: outbox.lockToken ?? null,
    completedAt: outbox.completedAt !== undefined ? new Date(outbox.completedAt) : null,
    lastErrorCode: outbox.lastErrorCode ?? null,
    lastErrorSummary: outbox.lastErrorSummary ?? null,
  };
}
