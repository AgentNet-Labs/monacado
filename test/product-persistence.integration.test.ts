/**
 * Product persistence integration tests (Phase 0D).
 *
 * Run ONLY against the identified disposable local MySQL database:
 *   RUN_DB_TESTS=1  DATABASE_URL=mysql://root@127.0.0.1:3308/monacado_phase0d
 * The whole suite self-skips unless RUN_DB_TESTS=1. Never point at production.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  candidateHash,
  productSourceRecordToCapsuleCandidate,
  type ProductSourceRecord,
} from "../src/contracts/index";
import { getPrisma, disconnectPrisma } from "../src/server/db/client";
import { ProductRepository } from "../src/server/product/product-repository";
import {
  ConcurrencyConflictError,
  DuplicateProductError,
  DuplicateVersionError,
  ImmutableIdentityError,
  PersistedContractViolationError,
  ValidationError,
} from "../src/server/product/errors";

const RUN = process.env.RUN_DB_TESTS === "1";

const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

let counter = 0;
/** A fresh, valid synthetic source record with unique opaque identifiers. */
function syntheticRecord(overrides: Partial<ProductSourceRecord> = {}): ProductSourceRecord {
  counter += 1;
  const tag = pad26(`T${counter}XPRDCT`);
  return {
    sourceRecordId: `mon:srec:${pad26(`T${counter}SREC`)}`,
    sourceRecordVersion: "1",
    internalProductId: `mon:product:${tag}`,
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    authority: {
      creatorId: `mon:creator:${pad26(`T${counter}CRTR`)}`,
      authorityScope: "product-facts",
      authorizationState: "authorized",
      authorizationRef: "mon:authz:synthetic-0d",
    },
    facts: {
      name: "Synthetic Persisted Product",
      description: "Synthetic Phase 0D integration fixture.",
      image: "https://monacado.com/media/synthetic/persisted.png",
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      specifications: { os: "cross-platform", format: "binary", signed: true },
      capabilities: ["scaffold", "validate"],
      relationships: { creator: `an:node:${pad26(`T${counter}NDE`)}` },
    },
    capsuleSemver: "1.0.0",
    mappingVersion: "0d.1.0.0",
    recordStatus: "authoring-complete",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    acquiredAt: "2026-01-01T00:00:00.000Z",
    capsuleGeneratedAt: "2026-01-01T06:30:00.000Z",
    ...overrides,
  };
}

const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);
const repo = RUN ? new ProductRepository(db) : (undefined as unknown as ProductRepository);

describe.skipIf(!RUN)("Product persistence (integration, disposable DB)", () => {
  beforeEach(async () => {
    // FK-safe order: Nodes reference Products (RESTRICT), so remove any first.
    await db.productNode.deleteMany({});
    await db.productSourceRecordVersionRow.deleteMany({});
    await db.product.deleteMany({});
  });
  afterAll(async () => {
    await disconnectPrisma();
  });

  it("3-6. persists an initial record and reads it back as a valid domain object", async () => {
    const rec = syntheticRecord();
    await repo.createInitialProductSourceRecord({ record: rec });
    const current = await repo.getCurrentProductSourceRecord(rec.internalProductId);
    expect(current).toEqual(rec);
    const exact = await repo.getProductSourceRecordVersion(rec.sourceRecordId, "1");
    expect(exact).toEqual(rec);
  });

  it("7. version listing is deterministic", async () => {
    const rec = syntheticRecord();
    await repo.createInitialProductSourceRecord({ record: rec });
    await repo.createProductSourceRecordRevision({
      internalProductId: rec.internalProductId,
      expectedCurrentSourceRecordVersion: "1",
      sourceRecordVersion: "2",
      updatedAt: "2026-02-01T00:00:00.000Z",
      capsuleGeneratedAt: "2026-02-01T06:30:00.000Z",
      facts: { ...rec.facts, name: "v2" },
    });
    const versions = await repo.listProductSourceRecordVersions(rec.internalProductId);
    expect(versions.map((v) => v.sourceRecordVersion)).toEqual(["1", "2"]);
  });

  it("8. duplicate internalProductId is rejected", async () => {
    const rec = syntheticRecord();
    await repo.createInitialProductSourceRecord({ record: rec });
    const dup = syntheticRecord({ internalProductId: rec.internalProductId });
    await expect(repo.createInitialProductSourceRecord({ record: dup })).rejects.toBeInstanceOf(
      DuplicateProductError,
    );
  });

  it("9. duplicate sourceRecordId/version is rejected", async () => {
    const rec = syntheticRecord();
    await repo.createInitialProductSourceRecord({ record: rec });
    const dup = syntheticRecord({ sourceRecordId: rec.sourceRecordId });
    await expect(repo.createInitialProductSourceRecord({ record: dup })).rejects.toBeInstanceOf(
      DuplicateProductError,
    );
  });

  it("10-13. revision creates a new immutable version; prior unchanged; pointer advances", async () => {
    const rec = syntheticRecord();
    await repo.createInitialProductSourceRecord({ record: rec });
    const next = await repo.createProductSourceRecordRevision({
      internalProductId: rec.internalProductId,
      expectedCurrentSourceRecordVersion: "1",
      sourceRecordVersion: "2",
      updatedAt: "2026-02-01T00:00:00.000Z",
      capsuleGeneratedAt: "2026-02-01T06:30:00.000Z",
      facts: { ...rec.facts, name: "Renamed v2", productVersion: 2 },
    });
    expect(next.sourceRecordVersion).toBe("2");
    const v1 = await repo.getProductSourceRecordVersion(rec.sourceRecordId, "1");
    expect(v1.facts.name).toBe(rec.facts.name); // prior unchanged
    const current = await repo.getCurrentProductSourceRecord(rec.internalProductId);
    expect(current.sourceRecordVersion).toBe("2"); // pointer advanced
  });

  it("14. reused sourceRecordVersion is rejected", async () => {
    const rec = syntheticRecord();
    await repo.createInitialProductSourceRecord({ record: rec });
    await expect(
      repo.createProductSourceRecordRevision({
        internalProductId: rec.internalProductId,
        expectedCurrentSourceRecordVersion: "1",
        sourceRecordVersion: "1",
        updatedAt: "2026-02-01T00:00:00.000Z",
        capsuleGeneratedAt: "2026-02-01T06:30:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("15-16. changed sourceRecordId / internalProductId on revision are rejected", async () => {
    const rec = syntheticRecord();
    await repo.createInitialProductSourceRecord({ record: rec });
    await expect(
      repo.createProductSourceRecordRevision({
        internalProductId: rec.internalProductId,
        expectedCurrentSourceRecordVersion: "1",
        sourceRecordVersion: "2",
        updatedAt: "2026-02-01T00:00:00.000Z",
        capsuleGeneratedAt: "2026-02-01T06:30:00.000Z",
        sourceRecordId: `mon:srec:${pad26("CHANGED")}`,
      }),
    ).rejects.toBeInstanceOf(ImmutableIdentityError);
    await expect(
      repo.createProductSourceRecordRevision({
        internalProductId: rec.internalProductId,
        expectedCurrentSourceRecordVersion: "1",
        sourceRecordVersion: "2",
        updatedAt: "2026-02-01T00:00:00.000Z",
        capsuleGeneratedAt: "2026-02-01T06:30:00.000Z",
        internalProductIdOverride: `mon:product:${pad26("CHANGED")}`,
      }),
    ).rejects.toBeInstanceOf(ImmutableIdentityError);
  });

  it("17. missing creator authority is rejected before persistence", async () => {
    const rec = syntheticRecord() as Record<string, unknown>;
    delete (rec.authority as Record<string, unknown>).creatorId;
    await expect(
      repo.createInitialProductSourceRecord({ record: rec as unknown as ProductSourceRecord }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.product.count()).toBe(0);
  });

  it("18. unknown source field is rejected before persistence", async () => {
    const rec = syntheticRecord() as Record<string, unknown>;
    rec.unexpected = "x";
    await expect(
      repo.createInitialProductSourceRecord({ record: rec as unknown as ProductSourceRecord }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await db.product.count()).toBe(0);
  });

  it("19-22. price / currency / commission / payment are rejected before persistence", async () => {
    for (const bad of ["price", "currency", "promoterCommissionRate", "paymentMethod"]) {
      const rec = syntheticRecord();
      (rec.facts as Record<string, unknown>)[bad] = "x";
      await expect(
        repo.createInitialProductSourceRecord({ record: rec }),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await db.product.count()).toBe(0);
  });

  it("23-26. mapping controls & timestamps persist exactly; updatedAt distinct from capsuleGeneratedAt", async () => {
    const rec = syntheticRecord();
    await repo.createInitialProductSourceRecord({ record: rec });
    const read = await repo.getCurrentProductSourceRecord(rec.internalProductId);
    expect(read.capsuleGeneratedAt).toBe(rec.capsuleGeneratedAt);
    expect(read.mappingVersion).toBe(rec.mappingVersion);
    expect(read.capsuleSemver).toBe(rec.capsuleSemver);
    expect(read.updatedAt).not.toBe(read.capsuleGeneratedAt);
  });

  it("27-30. persisted record regenerates the deterministic candidate; no publication metadata", async () => {
    const rec = syntheticRecord();
    await repo.createInitialProductSourceRecord({ record: rec });
    const fromDb = await repo.generateCandidateFromPersistedProductVersion(rec.sourceRecordId, "1");
    const fromMem = productSourceRecordToCapsuleCandidate(rec);
    expect(candidateHash(fromDb)).toBe(candidateHash(fromMem));
    expect(Object.keys(fromDb.metadata).sort()).toEqual(["provenance", "version"]);
    const v = await repo.verifyPersistedProductVersionMapping(rec.sourceRecordId, "1");
    expect(v.ok).toBe(true);
  });

  it("29. historical versions regenerate their historical candidates", async () => {
    const rec = syntheticRecord();
    await repo.createInitialProductSourceRecord({ record: rec });
    const memV1 = productSourceRecordToCapsuleCandidate(rec);
    await repo.createProductSourceRecordRevision({
      internalProductId: rec.internalProductId,
      expectedCurrentSourceRecordVersion: "1",
      sourceRecordVersion: "2",
      updatedAt: "2026-02-01T00:00:00.000Z",
      capsuleGeneratedAt: "2026-02-01T06:30:00.000Z",
      facts: { ...rec.facts, name: "v2" },
    });
    const dbV1 = await repo.generateCandidateFromPersistedProductVersion(rec.sourceRecordId, "1");
    expect(candidateHash(dbV1)).toBe(candidateHash(memV1)); // v1 candidate unchanged by v2
  });

  it("31. no published capsule JSON body column exists", async () => {
    const cols = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductSourceRecordVersionRow'",
    );
    const names = cols.map((c) => c.COLUMN_NAME.toLowerCase());
    for (const forbidden of ["bindstonode", "capsuleid", "publishedby", "publishedat", "capsulebody", "capsulejson", "contenthash"]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("32-33. concurrency conflict detected; failed check leaves current version unchanged", async () => {
    const rec = syntheticRecord();
    await repo.createInitialProductSourceRecord({ record: rec });
    // advance to v2 legitimately
    await repo.createProductSourceRecordRevision({
      internalProductId: rec.internalProductId,
      expectedCurrentSourceRecordVersion: "1",
      sourceRecordVersion: "2",
      updatedAt: "2026-02-01T00:00:00.000Z",
      capsuleGeneratedAt: "2026-02-01T06:30:00.000Z",
    });
    // stale caller still thinks current is "1"
    await expect(
      repo.createProductSourceRecordRevision({
        internalProductId: rec.internalProductId,
        expectedCurrentSourceRecordVersion: "1",
        sourceRecordVersion: "3",
        updatedAt: "2026-03-01T00:00:00.000Z",
        capsuleGeneratedAt: "2026-03-01T06:30:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ConcurrencyConflictError);
    const current = await repo.getCurrentProductSourceRecord(rec.internalProductId);
    expect(current.sourceRecordVersion).toBe("2"); // unchanged by the failed attempt
    // and no orphan v3 row was left
    await expect(
      repo.getProductSourceRecordVersion(rec.sourceRecordId, "3"),
    ).rejects.toThrow();
  });

  it("34-35. a failed revision leaves no partial version row (transaction rollback)", async () => {
    const rec = syntheticRecord();
    await repo.createInitialProductSourceRecord({ record: rec });
    // Reused version → the Phase 0C rule rejects before insert; ensure no v with bad state.
    await repo.createProductSourceRecordRevision({
      internalProductId: rec.internalProductId,
      expectedCurrentSourceRecordVersion: "1",
      sourceRecordVersion: "2",
      updatedAt: "2026-02-01T00:00:00.000Z",
      capsuleGeneratedAt: "2026-02-01T06:30:00.000Z",
    });
    // Now attempt to insert version "2" again with a fresh (stale) expected — duplicate/rollback.
    await expect(
      repo.createProductSourceRecordRevision({
        internalProductId: rec.internalProductId,
        expectedCurrentSourceRecordVersion: "1", // stale
        sourceRecordVersion: "2", // would duplicate
        updatedAt: "2026-02-02T00:00:00.000Z",
        capsuleGeneratedAt: "2026-02-02T06:30:00.000Z",
      }),
    ).rejects.toBeInstanceOf(ConcurrencyConflictError);
    const versions = await repo.listProductSourceRecordVersions(rec.internalProductId);
    expect(versions.map((v) => v.sourceRecordVersion)).toEqual(["1", "2"]); // no partial extra row
  });

  it("36. malformed persisted data surfaces as a structured contract violation", async () => {
    const rec = syntheticRecord();
    await repo.createInitialProductSourceRecord({ record: rec });
    // Corrupt a persisted scalar directly to an out-of-contract value.
    await db.$executeRawUnsafe(
      "UPDATE ProductSourceRecordVersionRow SET factGeneralAvailabilityState = 'not-a-valid-state' WHERE sourceRecordId = ?",
      rec.sourceRecordId,
    );
    await expect(
      repo.getProductSourceRecordVersion(rec.sourceRecordId, "1"),
    ).rejects.toBeInstanceOf(PersistedContractViolationError);
  });

  it("37. repository errors do not expose database credentials", async () => {
    const rec = syntheticRecord();
    await repo.createInitialProductSourceRecord({ record: rec });
    try {
      await repo.createInitialProductSourceRecord({ record: syntheticRecord({ internalProductId: rec.internalProductId }) });
      throw new Error("should have thrown");
    } catch (e) {
      const text = `${(e as Error).name} ${(e as Error).message}`;
      expect(text).not.toContain("3308");
      expect(text.toLowerCase()).not.toContain("mysql://");
      expect(text).not.toContain("root@");
      expect(e).toBeInstanceOf(DuplicateProductError);
    }
  });

  it("concurrent same-version revisions: exactly one wins, no duplicate", async () => {
    const rec = syntheticRecord();
    await repo.createInitialProductSourceRecord({ record: rec });
    const attempt = (v: string) =>
      repo
        .createProductSourceRecordRevision({
          internalProductId: rec.internalProductId,
          expectedCurrentSourceRecordVersion: "1",
          sourceRecordVersion: "2",
          updatedAt: "2026-02-01T00:00:00.000Z",
          capsuleGeneratedAt: `2026-02-01T06:30:0${v}.000Z`,
          facts: { ...rec.facts, name: `concurrent-${v}` },
        })
        .then(() => "ok" as const)
        .catch((e) => e);
    const [a, b] = await Promise.all([attempt("1"), attempt("2")]);
    const results = [a, b];
    const wins = results.filter((r) => r === "ok").length;
    expect(wins).toBe(1); // exactly one revision succeeds
    const versions = await repo.listProductSourceRecordVersions(rec.internalProductId);
    expect(versions.map((v) => v.sourceRecordVersion)).toEqual(["1", "2"]); // single v2
  });
});
