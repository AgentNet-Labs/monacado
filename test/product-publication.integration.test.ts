/**
 * Product publication preparation + atomic outbox integration tests (Phase 0E.2).
 *
 * Run ONLY against the disposable local MySQL (RUN_DB_TESTS=1). Self-skips
 * otherwise. Never point at production.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ProductSourceRecord, PublishedProductCapsule } from "../src/contracts/index";
import {
  MONACADO_PUBLISHER_ID,
  canonicalHash,
  candidateHash as computeCandidateHash,
  deriveOutboxId,
  productSourceRecordToCapsuleCandidate,
  publicationIdempotencyKey,
} from "../src/contracts/index";
import { getPrisma, disconnectPrisma } from "../src/server/db/client";
import { ProductRepository } from "../src/server/product/product-repository";
import {
  MONACADO_REGISTRAR_ID,
  ProductNodeRepository,
} from "../src/server/product/product-node-repository";
import { ProductPublicationService } from "../src/server/product/product-publication-service";
import { ProductNodeNotFoundError } from "../src/server/product/node-errors";
import {
  DuplicateCapsuleIdError,
  IdempotencyConflictError,
  InvalidPublicationInputError,
  NodeNotEligibleError,
  PersistedOutboxContractViolationError,
  PersistedPublicationContractViolationError,
  ProductNodeMismatchError,
  ProductSourceMismatchError,
  PublicationConflictError,
  PublicationProductNotFoundError,
} from "../src/server/product/publication-errors";

const RUN = process.env.RUN_DB_TESTS === "1";
const pad26 = (s: string): string =>
  (s.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

let n = 0;
function syntheticRecord(): ProductSourceRecord {
  n += 1;
  return {
    sourceRecordId: `mon:srec:${pad26(`P${n}SREC`)}`,
    sourceRecordVersion: "1",
    internalProductId: `mon:product:${pad26(`P${n}PRD`)}`,
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    authority: {
      creatorId: `mon:creator:${pad26(`P${n}CRTR`)}`,
      authorityScope: "product-facts",
      authorizationState: "authorized",
    },
    facts: {
      name: "Publication fixture product",
      description: "Obviously synthetic Phase 0E.2 fixture.",
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      specifications: { format: "binary" },
      capabilities: ["publish"],
      relationships: { creator: `an:node:${pad26(`P${n}CNDE`)}` },
    },
    capsuleSemver: "1.0.0",
    mappingVersion: "0e.2.0.0",
    recordStatus: "authoring-complete",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    acquiredAt: "2026-01-01T00:00:00.000Z",
    capsuleGeneratedAt: "2026-01-01T06:30:00.000Z",
  };
}

const db = RUN ? getPrisma() : (undefined as unknown as ReturnType<typeof getPrisma>);
const repo = RUN ? new ProductRepository(db) : (undefined as unknown as ProductRepository);
const nodes = RUN ? new ProductNodeRepository(db) : (undefined as unknown as ProductNodeRepository);
const pubs = RUN
  ? new ProductPublicationService(db)
  : (undefined as unknown as ProductPublicationService);

interface Fixture {
  record: ProductSourceRecord;
  nodeId: string;
}

/** Persist a Product, its first source version, and an Active Node. */
async function seed(): Promise<Fixture> {
  const record = syntheticRecord();
  await repo.createInitialProductSourceRecord({ record });
  const node = await nodes.issueProductNode({
    nodeId: `an:node:${pad26(`P${n}NODE`)}`,
    internalProductId: record.internalProductId,
    nodeKind: "product",
    nodePolicyRef: "an:policy:node:synthetic-0e2",
    nodePolicyVersion: "1.0.0",
    registrarId: MONACADO_REGISTRAR_ID,
    issuedAt: "2026-01-02T00:00:00.000Z",
  });
  return { record, nodeId: node.nodeId };
}

let idSeq = 0;
function prepInput(f: Fixture, overrides: Record<string, unknown> = {}) {
  idSeq += 1;
  return {
    publicationId: `mon:pub:${pad26(`PUB${idSeq}`)}`,
    internalProductId: f.record.internalProductId,
    sourceRecordId: f.record.sourceRecordId,
    sourceRecordVersion: f.record.sourceRecordVersion,
    nodeId: f.nodeId,
    capsuleId: `an:capsule:${pad26(`CAP${idSeq}`)}`,
    capsuleSemver: f.record.capsuleSemver,
    publishedBy: MONACADO_PUBLISHER_ID,
    publishedAt: "2026-02-01T00:00:00.000Z",
    nodePolicy: { ref: "an:policy:node:synthetic-0e2", version: "1.0.0" },
    capsulePolicy: { ref: "an:policy:capsule:synthetic-0e2", version: "1.0.0" },
    availableAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * The retained capsule payload. A freshly prepared item always has one; payload
 * disposal only happens after a matching Registrar receipt (Phase 0E.4), so an
 * absent payload here is a real regression rather than a typing inconvenience.
 */
function retainedPayload(outbox: { payload?: PublishedProductCapsule }): PublishedProductCapsule {
  if (outbox.payload === undefined) {
    throw new Error("expected the outbox payload to be retained, but it was absent");
  }
  return outbox.payload;
}

/** Column names of a table in the disposable database. */
async function columnsOf(table: string): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
    "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
    table,
  );
  return rows.map((r) => r.COLUMN_NAME);
}

/** Remove every row in FK-safe order: outbox → publication → node → versions → product. */
async function wipe(): Promise<void> {
  await db.publicationOutbox.deleteMany({});
  await db.productPublication.deleteMany({});
  await db.productNode.deleteMany({});
  await db.productSourceRecordVersionRow.deleteMany({});
  await db.product.deleteMany({});
}

describe.skipIf(!RUN)("Product publication preparation + outbox (integration)", () => {
  beforeEach(wipe);
  afterAll(async () => {
    // Leave the database empty: suites that run after this one clean up in an
    // order that predates ProductPublication, so leftover publication rows would
    // block their Node/Product deletes on the RESTRICT foreign keys.
    await wipe();
    await disconnectPrisma();
  });

  it("1. initial publication preparation succeeds", async () => {
    const f = await seed();
    const result = await pubs.prepareProductPublication(prepInput(f));
    expect(result.alreadyPrepared).toBe(false);
    expect(result.publication.publicationStatus).toBe("QUEUED");
    expect(result.publication.nodeId).toBe(f.nodeId);
    expect(result.outbox.operationType).toBe("REGISTER");
  });

  it("2. the exact source-record version is used", async () => {
    const f = await seed();
    // Revise to v2 with different facts; publish v1 explicitly.
    await repo.createProductSourceRecordRevision({
      internalProductId: f.record.internalProductId,
      expectedCurrentSourceRecordVersion: "1",
      sourceRecordVersion: "2",
      updatedAt: "2026-02-01T00:00:00.000Z",
      capsuleGeneratedAt: "2026-02-01T06:30:00.000Z",
      facts: { ...f.record.facts, name: "v2 name" },
    });
    const result = await pubs.prepareProductPublication(prepInput(f, { sourceRecordVersion: "1" }));
    expect(result.publication.sourceRecordVersion).toBe("1");
    expect(retainedPayload(result.outbox).data.name).toBe(f.record.facts.name);
    expect(retainedPayload(result.outbox).metadata.provenance.sourceRecordVersion).toBe("1");
  });

  it("3. Product/source mismatch fails", async () => {
    const a = await seed();
    const b = await seed();
    await expect(
      pubs.prepareProductPublication(
        prepInput(a, { sourceRecordId: b.record.sourceRecordId }),
      ),
    ).rejects.toBeInstanceOf(ProductSourceMismatchError);
  });

  it("4. Product/Node mismatch fails", async () => {
    const a = await seed();
    const b = await seed();
    await expect(
      pubs.prepareProductPublication(prepInput(a, { nodeId: b.nodeId })),
    ).rejects.toBeInstanceOf(ProductNodeMismatchError);
  });

  it("5. missing Product fails", async () => {
    const f = await seed();
    await expect(
      pubs.prepareProductPublication(
        prepInput(f, { internalProductId: `mon:product:${pad26("MISSING")}` }),
      ),
    ).rejects.toBeInstanceOf(PublicationProductNotFoundError);
  });

  it("6. missing Product Node fails", async () => {
    const f = await seed();
    await expect(
      pubs.prepareProductPublication(prepInput(f, { nodeId: `an:node:${pad26("N0SUCHNODE")}` })),
    ).rejects.toBeInstanceOf(ProductNodeNotFoundError);
  });

  it("7,8,9. Inactive / Retired / Revoked Nodes are not eligible", async () => {
    for (const [state, reason] of [
      ["Inactive", undefined],
      ["Retired", "superseded"],
      ["Revoked", "policy-violation"],
    ] as const) {
      const f = await seed();
      await nodes.transitionProductNodeLifecycle({
        nodeId: f.nodeId,
        toState: state,
        lifecycleChangedAt: "2026-01-15T00:00:00.000Z",
        ...(reason ? { reasonCode: reason } : {}),
      });
      await expect(pubs.prepareProductPublication(prepInput(f))).rejects.toBeInstanceOf(
        NodeNotEligibleError,
      );
    }
  });

  it("10. an Active Node succeeds", async () => {
    const f = await seed();
    const result = await pubs.prepareProductPublication(prepInput(f));
    expect(result.publication.publicationStatus).toBe("QUEUED");
  });

  it("11,13. candidate regenerates deterministically and candidateHash persists", async () => {
    const f = await seed();
    const result = await pubs.prepareProductPublication(prepInput(f));
    const expected = computeCandidateHash(productSourceRecordToCapsuleCandidate(f.record));
    expect(result.publication.candidateHash).toBe(expected);
  });

  it("12,14. the final published capsule validates and publishedContentHash persists", async () => {
    const f = await seed();
    const result = await pubs.prepareProductPublication(prepInput(f));
    // outboxRowToDomain already validates the payload against the strict
    // published-capsule schema; assert the persisted hash matches the capsule.
    expect(retainedPayload(result.outbox).metadata.contentHash).toBe(
      result.publication.publishedContentHash,
    );
    expect(Object.keys(retainedPayload(result.outbox)).sort()).toEqual([
      "@context",
      "@type",
      "data",
      "metadata",
    ]);
  });

  it("15. payloadHash matches the canonical payload", async () => {
    const f = await seed();
    const result = await pubs.prepareProductPublication(prepInput(f));
    expect(result.outbox.payloadHash).toBe(canonicalHash(result.outbox.payload));
    // The payload hash is NOT the capsule content hash (different inputs).
    expect(result.outbox.payloadHash).not.toBe(result.publication.publishedContentHash);
  });

  it("16. publication policy references persist exactly", async () => {
    const f = await seed();
    const input = prepInput(f, {
      nodePolicy: { ref: "an:policy:node:exact", version: "3.1.4" },
      capsulePolicy: { ref: "an:policy:capsule:exact", version: "2.7.1" },
    });
    const result = await pubs.prepareProductPublication(input);
    expect(result.publication.nodePolicyRef).toBe("an:policy:node:exact");
    expect(result.publication.nodePolicyVersion).toBe("3.1.4");
    expect(result.publication.capsulePolicyRef).toBe("an:policy:capsule:exact");
    expect(result.publication.capsulePolicyVersion).toBe("2.7.1");
    expect(retainedPayload(result.outbox).metadata.nodePolicy).toEqual({
      ref: "an:policy:node:exact",
      version: "3.1.4",
    });
  });

  it("17. Product facts are not duplicated into publication columns", async () => {
    const cols = (await columnsOf("ProductPublication")).map((c) => c.toLowerCase());
    // Guard against a vacuous pass if introspection returned nothing.
    expect(cols).toContain("capsuleid");
    for (const fact of [
      "name",
      "description",
      "image",
      "productversion",
      "promotable",
      "generalavailabilitystate",
      "specifications",
      "capabilities",
      "relationships",
      "creator",
      "offer",
    ]) {
      expect(cols.some((c) => c.includes(fact))).toBe(false);
    }
  });

  it("18. the capsule body exists only in the outbox payload", async () => {
    const f = await seed();
    const result = await pubs.prepareProductPublication(prepInput(f));

    // No JSON/TEXT column on ProductPublication could hold a capsule body.
    const types = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string; DATA_TYPE: string }>>(
      "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductPublication'",
    );
    expect(types.filter((t) => ["json", "text", "longtext", "mediumtext"].includes(t.DATA_TYPE))).toEqual([]);

    // The payload is the whole capsule and lives on the outbox row.
    expect(retainedPayload(result.outbox).metadata.capsuleId).toBe(result.publication.capsuleId);
    expect(retainedPayload(result.outbox).metadata.bindsToNode).toBe(result.publication.nodeId);
  });

  it("19. publication and outbox are created atomically (both present, QUEUED)", async () => {
    const f = await seed();
    const input = prepInput(f);
    await pubs.prepareProductPublication(input);
    const pub = await db.productPublication.findUnique({
      where: { publicationId: input.publicationId },
    });
    const obx = await db.publicationOutbox.findUnique({
      where: { publicationId: input.publicationId },
    });
    expect(pub?.publicationStatus).toBe("QUEUED");
    expect(obx).not.toBeNull();
  });

  it("20. a preparation that fails at the outbox insert leaves NEITHER row", async () => {
    const a = await seed();
    const b = await seed();

    // Prepare A, then force A's outbox item to occupy the outboxId that B's
    // preparation will derive. B's idempotency key is unaffected, so preparation
    // proceeds and fails only at the outbox insert — after the publication insert.
    const inputA = prepInput(a);
    await pubs.prepareProductPublication(inputA);

    const inputB = prepInput(b);
    const collidingOutboxId = deriveOutboxId(
      publicationIdempotencyKey({
        nodeId: inputB.nodeId,
        sourceRecordId: inputB.sourceRecordId,
        sourceRecordVersion: inputB.sourceRecordVersion,
        capsuleId: inputB.capsuleId,
        operationType: "REGISTER",
      }),
    );
    await db.publicationOutbox.update({
      where: { publicationId: inputA.publicationId },
      data: { outboxId: collidingOutboxId },
    });

    // The conflict is reported on outboxId, which can ONLY be raised by the
    // outbox insert inside the transaction — proving the publication row had
    // already been inserted when the failure occurred.
    await expect(pubs.prepareProductPublication(inputB)).rejects.toMatchObject({
      code: "PUBLICATION_CONFLICT",
      conflictingFields: ["outboxId"],
    });

    // Neither B's publication nor any outbox row for it survived the rollback.
    expect(
      await db.productPublication.findUnique({ where: { publicationId: inputB.publicationId } }),
    ).toBeNull();
    expect(
      await db.publicationOutbox.findUnique({ where: { publicationId: inputB.publicationId } }),
    ).toBeNull();
  });

  it("20b. a preparation that fails before the publication insert leaves neither row", async () => {
    const f = await seed();
    await nodes.transitionProductNodeLifecycle({
      nodeId: f.nodeId,
      toState: "Inactive",
      lifecycleChangedAt: "2026-01-15T00:00:00.000Z",
    });
    await expect(pubs.prepareProductPublication(prepInput(f))).rejects.toBeInstanceOf(
      NodeNotEligibleError,
    );
    expect(await db.productPublication.count()).toBe(0);
    expect(await db.publicationOutbox.count()).toBe(0);
  });

  it("21,22. identical repeated preparation is idempotent and creates no duplicates", async () => {
    const f = await seed();
    const input = prepInput(f);
    const first = await pubs.prepareProductPublication(input);
    const second = await pubs.prepareProductPublication(input);

    expect(second.alreadyPrepared).toBe(true);
    expect(second.publication.id).toBe(first.publication.id);
    expect(second.outbox.id).toBe(first.outbox.id);
    expect(second.outbox.outboxId).toBe(first.outbox.outboxId);
    expect(await db.productPublication.count()).toBe(1);
    expect(await db.publicationOutbox.count()).toBe(1);
  });

  it("23. a repeat asserting a conflicting Publisher fails", async () => {
    const f = await seed();
    const input = prepInput(f);
    await pubs.prepareProductPublication(input);

    // The Publisher is pinned to Monacado by contract, so a differing Publisher
    // cannot arrive through the input path (it is rejected as invalid input
    // first). Mutate the STORED value to exercise the service-level comparison.
    await db.$executeRawUnsafe(
      "UPDATE ProductPublication SET publishedBy = ? WHERE publicationId = ?",
      "an:publisher:monacado-other",
      input.publicationId,
    );
    await expect(pubs.prepareProductPublication(input)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );

    // And a non-Monacado Publisher in the input is rejected as invalid input.
    const g = await seed();
    await expect(
      pubs.prepareProductPublication(
        prepInput(g, { publishedBy: "an:publisher:someone-else" }),
      ),
    ).rejects.toBeInstanceOf(InvalidPublicationInputError);
  });

  it("24. a repeat asserting a conflicting publishedAt fails", async () => {
    const f = await seed();
    const input = prepInput(f);
    await pubs.prepareProductPublication(input);
    await expect(
      pubs.prepareProductPublication({ ...input, publishedAt: "2026-03-09T00:00:00.000Z" }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("25. a repeat asserting a conflicting policy reference fails", async () => {
    const f = await seed();
    const input = prepInput(f);
    await pubs.prepareProductPublication(input);
    await expect(
      pubs.prepareProductPublication({
        ...input,
        capsulePolicy: { ref: "an:policy:capsule:different", version: "1.0.0" },
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await db.productPublication.count()).toBe(1);
  });

  it("26. a duplicate capsuleId fails", async () => {
    const a = await seed();
    const b = await seed();
    const inputA = prepInput(a);
    await pubs.prepareProductPublication(inputA);
    await expect(
      pubs.prepareProductPublication(prepInput(b, { capsuleId: inputA.capsuleId })),
    ).rejects.toBeInstanceOf(DuplicateCapsuleIdError);
  });

  it("26b. a second capsule for the same Node and source version conflicts", async () => {
    const f = await seed();
    await pubs.prepareProductPublication(prepInput(f));
    await expect(pubs.prepareProductPublication(prepInput(f))).rejects.toBeInstanceOf(
      PublicationConflictError,
    );
  });

  it("27. an invalid capsule semver fails", async () => {
    const f = await seed();
    await expect(
      pubs.prepareProductPublication(prepInput(f, { capsuleSemver: "1.0" })),
    ).rejects.toBeInstanceOf(InvalidPublicationInputError);
  });

  it("28. a semver inconsistent with the source record fails", async () => {
    const f = await seed();
    await expect(
      pubs.prepareProductPublication(prepInput(f, { capsuleSemver: "2.0.0" })),
    ).rejects.toBeInstanceOf(InvalidPublicationInputError);
  });

  it("29. supersedes and revokes together fail", async () => {
    const f = await seed();
    await expect(
      pubs.prepareProductPublication(
        prepInput(f, {
          supersedes: `an:capsule:${pad26("PRIOR")}`,
          revokes: `an:capsule:${pad26("OTHER")}`,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidPublicationInputError);
  });

  it("30. a Node ID cannot substitute for a supersedes/revokes capsule ID", async () => {
    const f = await seed();
    for (const field of ["supersedes", "revokes"] as const) {
      await expect(
        pubs.prepareProductPublication(prepInput(f, { [field]: f.nodeId })),
      ).rejects.toBeInstanceOf(InvalidPublicationInputError);
    }
  });

  it("31,32,33. outbox is REGISTER / PENDING / attemptCount 0", async () => {
    const f = await seed();
    const result = await pubs.prepareProductPublication(prepInput(f));
    expect(result.outbox.operationType).toBe("REGISTER");
    expect(result.outbox.outboxStatus).toBe("PENDING");
    expect(result.outbox.attemptCount).toBe(0);
    expect(result.outbox.availableAt).toBe("2026-02-01T00:00:00.000Z");
  });

  it("34. no receipt / registration / reconciliation fields exist", async () => {
    // Phase 0E.3 moved the boundary: claim ownership (lockToken/lockedAt),
    // outcome (completedAt), and bounded failure metadata (lastError*) are now
    // legitimate outbox columns — see PRODUCT_PUBLICATION_OUTBOX_PROCESSING.md.
    // What remains forbidden is everything still deferred beyond this phase.
    const cols = (await columnsOf("PublicationOutbox")).map((c) => c.toLowerCase());
    expect(cols).toContain("payloadhash");
    for (const forbidden of [
      "claimedby",
      "lease",
      "expires",
      "retrycount",
      "deadletter",
      "receipt",
      "reconcil",
      "registered",
      "registration",
      "submitted",
      "resolver",
      "nextattempt",
      "lastattempt",
    ]) {
      expect(cols.some((c) => c.includes(forbidden))).toBe(false);
    }
    // Phase 0E.4 moved the boundary again: the publication now carries bounded
    // registration and reconciliation STATE (see PRODUCT_REGISTRAR_RECEIPTS.md).
    // Receipts themselves live on their own immutable table, and work-processing
    // concerns still have no business on the publication row.
    const pubCols = (await columnsOf("ProductPublication")).map((c) => c.toLowerCase());
    expect(pubCols).toContain("registrationstate");
    expect(pubCols).toContain("reconciliationstate");
    for (const forbidden of ["receipt", "retry", "attempt", "claim", "lock", "resolver", "payload"]) {
      expect(pubCols.some((c) => c.includes(forbidden))).toBe(false);
    }
  });

  it("35. malformed persisted publication raises a structured contract violation", async () => {
    const f = await seed();
    const input = prepInput(f);
    await pubs.prepareProductPublication(input);
    await db.$executeRawUnsafe(
      "UPDATE ProductPublication SET publicationStatus = 'not-a-status' WHERE publicationId = ?",
      input.publicationId,
    );
    await expect(pubs.getProductPublication(input.publicationId)).rejects.toBeInstanceOf(
      PersistedPublicationContractViolationError,
    );
  });

  it("36. a malformed outbox payload raises a structured contract violation", async () => {
    const f = await seed();
    const input = prepInput(f);
    await pubs.prepareProductPublication(input);
    await db.$executeRawUnsafe(
      "UPDATE PublicationOutbox SET payload = ? WHERE publicationId = ?",
      JSON.stringify({ not: "a capsule" }),
      input.publicationId,
    );
    await expect(pubs.getPublicationOutbox(input.publicationId)).rejects.toBeInstanceOf(
      PersistedOutboxContractViolationError,
    );
  });

  it("37. a stored payloadHash mismatch raises a structured contract violation", async () => {
    const f = await seed();
    const input = prepInput(f);
    await pubs.prepareProductPublication(input);
    await db.$executeRawUnsafe(
      "UPDATE PublicationOutbox SET payloadHash = ? WHERE publicationId = ?",
      `sha256:${"0".repeat(64)}`,
      input.publicationId,
    );
    await expect(pubs.getPublicationOutbox(input.publicationId)).rejects.toBeInstanceOf(
      PersistedOutboxContractViolationError,
    );
  });

  it("38. errors expose neither database credentials nor the full payload", async () => {
    const f = await seed();
    const input = prepInput(f);
    const first = await pubs.prepareProductPublication(input);
    try {
      await pubs.prepareProductPublication({ ...input, publishedAt: "2026-04-01T00:00:00.000Z" });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as Error & { conflictingFields?: string[] };
      const text = `${err.name} ${err.message} ${JSON.stringify(err.conflictingFields ?? [])}`;
      expect(text).not.toContain("3308");
      expect(text.toLowerCase()).not.toContain("mysql://");
      expect(text).not.toContain("root@");
      expect(text).not.toContain("monacado_phase0e2");
      // No capsule payload content and no hash VALUES leak into the error.
      expect(text).not.toContain(first.outbox.payloadHash);
      expect(text).not.toContain(f.record.facts.name);
      expect(text).not.toContain("@context");
      expect(e).toBeInstanceOf(IdempotencyConflictError);
    }
  });

  it("38b. a real database-backed error retains its cause without serialising it", async () => {
    // Force a genuine Prisma P2002 inside the preparation transaction, so the
    // error's cause comes from the driver rather than from a test fixture.
    const a = await seed();
    const b = await seed();
    const inputA = prepInput(a);
    await pubs.prepareProductPublication(inputA);

    const inputB = prepInput(b);
    await db.publicationOutbox.update({
      where: { publicationId: inputA.publicationId },
      data: {
        outboxId: deriveOutboxId(
          publicationIdempotencyKey({
            nodeId: inputB.nodeId,
            sourceRecordId: inputB.sourceRecordId,
            sourceRecordVersion: inputB.sourceRecordVersion,
            capsuleId: inputB.capsuleId,
            operationType: "REGISTER",
          }),
        ),
      },
    });

    try {
      await pubs.prepareProductPublication(inputB);
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as PublicationConflictError;
      expect(err).toBeInstanceOf(PublicationConflictError);
      // Retained for diagnostics …
      expect(err.internalCause).toBe("P2002");
      // … but invisible to ordinary serialisation.
      expect(Object.keys(err)).not.toContain("internalCause");
      const serialised = `${JSON.stringify(err)} ${JSON.stringify({ ...err })}`;
      expect(serialised).not.toContain("internalCause");
      expect(serialised).not.toContain("P2002");
      expect(serialised).not.toContain("3308");
      expect(serialised.toLowerCase()).not.toContain("mysql://");
      expect(serialised).not.toContain("monacado_phase0e2");
      // Public surface still usable.
      expect(err.code).toBe("PUBLICATION_CONFLICT");
      expect(err.conflictingFields).toEqual(["outboxId"]);
    }
  });

  it("39. Node lifecycle is not stored on the publication row", async () => {
    const cols = (await columnsOf("ProductPublication")).map((c) => c.toLowerCase());
    expect(cols.some((c) => c.includes("lifecycle"))).toBe(false);
  });
});
