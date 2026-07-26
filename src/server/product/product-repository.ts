/**
 * Product source-record repository (Phase 0D).
 *
 * Narrow persistence interface over the authoritative Product identity and its
 * IMMUTABLE source-record version history. Returns validated Phase 0C domain
 * objects (never raw Prisma rows). Revisions are atomic and guarded against lost
 * updates via an explicit optimistic-concurrency check plus the
 * (sourceRecordId, sourceRecordVersion) unique constraint. No capsule bodies,
 * Node IDs, or publication metadata are stored.
 */

import { Prisma } from "@prisma/client";
import {
  ProductSourceRecordSchema,
  productSourceRecordToCapsuleCandidate,
  reviseProductSourceRecord,
  SourceRecordRevisionError,
  verifyProductSourceCandidateMapping,
  type MappingVerification,
  type ProductSourceRecord,
} from "../../contracts/product/product-source-record";
import type { ProductCapsuleCandidate } from "../../contracts/product/product.capsule";
import { getPrisma } from "../db/client";
import { domainToVersionCreateInput, versionRowToDomain } from "./persistence-mapper";
import {
  ConcurrencyConflictError,
  DatabaseError,
  DuplicateProductError,
  DuplicateVersionError,
  ImmutableIdentityError,
  NotFoundError,
  ValidationError,
} from "./errors";

type Db = ReturnType<typeof getPrisma>;

function validateDomain(record: unknown): ProductSourceRecord {
  const parsed = ProductSourceRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new ValidationError(
      "Invalid Product source record",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return parsed.data;
}

/** Map a Prisma unique-constraint violation to a typed duplicate error. */
function mapUnique(e: unknown, kind: "product" | "version"): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
    if (kind === "product") {
      throw new DuplicateProductError("A Product with this identity already exists", e.code);
    }
    throw new DuplicateVersionError("This source-record version already exists", e.code);
  }
  // Never surface raw connection details.
  throw new DatabaseError("Database operation failed", e instanceof Error ? e.message : undefined);
}

function mapRevisionError(e: unknown): never {
  if (e instanceof SourceRecordRevisionError) {
    if (/immutable/i.test(e.message)) throw new ImmutableIdentityError(e.message);
    throw new ValidationError(e.message, [e.message]);
  }
  throw e;
}

export interface CreateInitialInput {
  record: ProductSourceRecord;
}

export interface ReviseInput {
  internalProductId: string;
  /** Optimistic-concurrency token: the version the caller believes is current. */
  expectedCurrentSourceRecordVersion: string;
  sourceRecordVersion: string;
  updatedAt: string;
  capsuleGeneratedAt: string;
  facts?: ProductSourceRecord["facts"];
  capsuleSemver?: string;
  mappingVersion?: string;
  recordStatus?: ProductSourceRecord["recordStatus"];
  /** Hostile inputs — rejected if they differ from the stored identity. */
  sourceRecordId?: string;
  internalProductIdOverride?: string;
}

export class ProductRepository {
  constructor(private readonly db: Db = getPrisma()) {}

  /** Create the stable Product and its first immutable source-record version, atomically. */
  async createInitialProductSourceRecord(input: CreateInitialInput): Promise<ProductSourceRecord> {
    const record = validateDomain(input.record);
    if (record.sourceRecordId === record.internalProductId) {
      throw new ImmutableIdentityError("sourceRecordId must differ from internalProductId");
    }
    try {
      await this.db.$transaction(async (tx) => {
        await tx.product.create({
          data: {
            internalProductId: record.internalProductId,
            sourceRecordId: record.sourceRecordId,
            currentSourceRecordVersion: record.sourceRecordVersion,
            recordStatus: record.recordStatus,
          },
        });
        await tx.productSourceRecordVersionRow.create({
          data: domainToVersionCreateInput(record),
        });
      });
    } catch (e) {
      mapUnique(e, "product");
    }
    return record;
  }

  /** Read the current source record for a Product. */
  async getCurrentProductSourceRecord(internalProductId: string): Promise<ProductSourceRecord> {
    const product = await this.db.product.findUnique({ where: { internalProductId } });
    if (!product) throw new NotFoundError("Product not found");
    const row = await this.db.productSourceRecordVersionRow.findUnique({
      where: {
        sourceRecordId_sourceRecordVersion: {
          sourceRecordId: product.sourceRecordId,
          sourceRecordVersion: product.currentSourceRecordVersion,
        },
      },
    });
    if (!row) throw new NotFoundError("Current source-record version not found");
    return versionRowToDomain(row);
  }

  /** Read an exact historical version. */
  async getProductSourceRecordVersion(
    sourceRecordId: string,
    sourceRecordVersion: string,
  ): Promise<ProductSourceRecord> {
    const row = await this.db.productSourceRecordVersionRow.findUnique({
      where: { sourceRecordId_sourceRecordVersion: { sourceRecordId, sourceRecordVersion } },
    });
    if (!row) throw new NotFoundError("Source-record version not found");
    return versionRowToDomain(row);
  }

  /** List all versions for a Product in deterministic (creation) order. */
  async listProductSourceRecordVersions(internalProductId: string): Promise<ProductSourceRecord[]> {
    const rows = await this.db.productSourceRecordVersionRow.findMany({
      where: { internalProductId },
      orderBy: { seq: "asc" },
    });
    return rows.map(versionRowToDomain);
  }

  /**
   * Create a new immutable source-record version atomically, guarded against
   * lost updates. The prior version is never modified; the current pointer
   * advances only if the caller's expected version still matches.
   */
  async createProductSourceRecordRevision(input: ReviseInput): Promise<ProductSourceRecord> {
    try {
      return await this.db.$transaction(async (tx) => {
        const product = await tx.product.findUnique({
          where: { internalProductId: input.internalProductId },
        });
        if (!product) throw new NotFoundError("Product not found");

        // Optimistic-concurrency check (fail before doing any work).
        if (product.currentSourceRecordVersion !== input.expectedCurrentSourceRecordVersion) {
          throw new ConcurrencyConflictError(
            "Current source-record version has changed; expected version no longer matches",
          );
        }

        const currentRow = await tx.productSourceRecordVersionRow.findUnique({
          where: {
            sourceRecordId_sourceRecordVersion: {
              sourceRecordId: product.sourceRecordId,
              sourceRecordVersion: product.currentSourceRecordVersion,
            },
          },
        });
        if (!currentRow) throw new NotFoundError("Current source-record version not found");
        const prior = versionRowToDomain(currentRow);

        // Phase 0C revision rules (immutable identity, required capsuleGeneratedAt, ...).
        let next: ProductSourceRecord;
        try {
          next = reviseProductSourceRecord({
            prior,
            sourceRecordVersion: input.sourceRecordVersion,
            updatedAt: input.updatedAt,
            capsuleGeneratedAt: input.capsuleGeneratedAt,
            ...(input.facts !== undefined ? { facts: input.facts } : {}),
            ...(input.capsuleSemver !== undefined ? { capsuleSemver: input.capsuleSemver } : {}),
            ...(input.mappingVersion !== undefined ? { mappingVersion: input.mappingVersion } : {}),
            ...(input.recordStatus !== undefined ? { recordStatus: input.recordStatus } : {}),
            ...(input.sourceRecordId !== undefined ? { sourceRecordId: input.sourceRecordId } : {}),
            ...(input.internalProductIdOverride !== undefined
              ? { internalProductId: input.internalProductIdOverride }
              : {}),
          });
        } catch (e) {
          mapRevisionError(e);
        }

        // Insert the new immutable version (unique constraint hard-guards races).
        try {
          await tx.productSourceRecordVersionRow.create({
            data: domainToVersionCreateInput(next),
          });
        } catch (e) {
          mapUnique(e, "version");
        }

        // Advance the current pointer only if it still matches (lost-update guard).
        const advanced = await tx.product.updateMany({
          where: {
            internalProductId: input.internalProductId,
            currentSourceRecordVersion: input.expectedCurrentSourceRecordVersion,
          },
          data: {
            currentSourceRecordVersion: next.sourceRecordVersion,
            recordStatus: next.recordStatus,
          },
        });
        if (advanced.count !== 1) {
          throw new ConcurrencyConflictError("Current source-record version changed during revision");
        }

        return next;
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError) mapUnique(e, "version");
      throw e;
    }
  }

  /** Generate a deterministic capsule candidate from a persisted version. */
  async generateCandidateFromPersistedProductVersion(
    sourceRecordId: string,
    sourceRecordVersion: string,
  ): Promise<ProductCapsuleCandidate> {
    const record = await this.getProductSourceRecordVersion(sourceRecordId, sourceRecordVersion);
    return productSourceRecordToCapsuleCandidate(record);
  }

  /** Verify a persisted version reconstructs to a candidate consistent with the record. */
  async verifyPersistedProductVersionMapping(
    sourceRecordId: string,
    sourceRecordVersion: string,
  ): Promise<MappingVerification> {
    const record = await this.getProductSourceRecordVersion(sourceRecordId, sourceRecordVersion);
    const candidate = productSourceRecordToCapsuleCandidate(record);
    return verifyProductSourceCandidateMapping(record, candidate);
  }
}
