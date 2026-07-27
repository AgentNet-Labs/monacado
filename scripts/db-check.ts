/**
 * db:check — verify the Product persistence layer against the configured
 * (disposable local) database. Offline of any production system.
 *
 * Checks: connectivity, applied migration state, expected tables, expected
 * indexes/constraints, a safe synthetic read/write transaction (cleaned up),
 * Prisma→domain reconstruction, and deterministic candidate generation from a
 * persisted version. Exits non-zero on any failure. Never prints DATABASE_URL.
 */

import "dotenv/config";
import { getPrisma, disconnectPrisma } from "../src/server/db/client";
import { ProductRepository } from "../src/server/product/product-repository";
import {
  MONACADO_REGISTRAR_ID,
  ProductNodeRepository,
} from "../src/server/product/product-node-repository";
import { ProductPublicationService } from "../src/server/product/product-publication-service";
import {
  MONACADO_PUBLISHER_ID,
  canonicalHash,
  candidateHash,
  productSourceRecordToCapsuleCandidate,
  validatePublishedProductCapsule,
} from "../src/contracts/index";
import type { ProductSourceRecord } from "../src/contracts/index";

/** Produce an exact 26-char Crockford body from a seed (I/L/O/U -> 0). */
const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);
const CHECK_INTERNAL = `mon:product:${pad26("DBCHECKPRODUCT")}`;
const CHECK_SREC = `mon:srec:${pad26("DBCHECKSREC")}`;
const CHECK_CREATOR = `mon:creator:${pad26("DBCHECKCREATOR")}`;
const CHECK_NODE = `an:node:${pad26("DBCHECKNODE")}`;
const CHECK_NODE_ANS = `an:node:${pad26("DBCHECKANSNODE")}`;
const CHECK_PUBLICATION = `mon:pub:${pad26("DBCHECKPUB")}`;
const CHECK_CAPSULE = `an:capsule:${pad26("DBCHECKCAPSULE")}`;

function syntheticCheckRecord(): ProductSourceRecord {
  return {
    sourceRecordId: CHECK_SREC,
    sourceRecordVersion: "1",
    internalProductId: CHECK_INTERNAL,
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    authority: {
      creatorId: CHECK_CREATOR,
      authorityScope: "product-facts",
      authorizationState: "authorized",
    },
    facts: {
      name: "db:check synthetic product",
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      specifications: { format: "binary" },
      capabilities: ["check"],
      relationships: { creator: CHECK_NODE },
    },
    capsuleSemver: "1.0.0",
    mappingVersion: "0d.1.0.0",
    recordStatus: "authoring-complete",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    acquiredAt: "2026-01-01T00:00:00.000Z",
    capsuleGeneratedAt: "2026-01-01T06:30:00.000Z",
  };
}

let checks = 0;
const ok = (m: string) => {
  checks += 1;
  console.log(`✓ ${m}`);
};
function fail(m: string, e?: unknown): never {
  console.error(`✗ ${m}${e instanceof Error ? `: ${e.message}` : ""}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const db = getPrisma();

  // 1. Connectivity.
  try {
    await db.$queryRaw`SELECT 1`;
    ok("connectivity");
  } catch (e) {
    fail("connectivity", e);
  }

  // 2. Applied migration state.
  const migrations = await db.$queryRawUnsafe<Array<{ migration_name: string }>>(
    "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL",
  );
  for (const expected of [
    "init_product_source_records",
    "add_product_node",
    "add_product_publication_and_outbox",
  ]) {
    if (!migrations.some((m) => m.migration_name.includes(expected))) {
      fail(`expected migration not applied: ${expected}`);
    }
  }
  ok(`migration state (${migrations.length} applied)`);

  // 3. Expected tables.
  const tables = await db.$queryRawUnsafe<Array<{ TABLE_NAME: string }>>(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()",
  );
  const names = new Set(tables.map((t) => t.TABLE_NAME));
  for (const t of [
    "Product",
    "ProductSourceRecordVersionRow",
    "ProductNode",
    "ProductPublication",
    "PublicationOutbox",
  ]) {
    if (!names.has(t)) fail(`missing table ${t}`);
  }
  ok("expected tables present");

  // ProductNode uniqueness constraints + FK.
  const nodeIdx = await db.$queryRawUnsafe<Array<{ INDEX_NAME: string; NON_UNIQUE: number }>>(
    "SELECT DISTINCT INDEX_NAME, NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductNode'",
  );
  const uniqNode = (col: string) =>
    nodeIdx.some((i) => i.INDEX_NAME.includes(col) && Number(i.NON_UNIQUE) === 0);
  if (!uniqNode("nodeId")) fail("missing unique ProductNode.nodeId index");
  if (!uniqNode("internalProductId")) fail("missing unique ProductNode.internalProductId index");
  const nodeFk = await db.$queryRawUnsafe<Array<{ c: number }>>(
    "SELECT COUNT(*) c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductNode' AND REFERENCED_TABLE_NAME = 'Product'",
  );
  if (Number(nodeFk[0]?.c ?? 0) === 0) fail("missing ProductNode -> Product foreign key");
  ok("ProductNode unique(nodeId), unique(internalProductId), FK present");

  // 4. Expected indexes / uniqueness constraints.
  const idx = await db.$queryRawUnsafe<Array<{ INDEX_NAME: string; NON_UNIQUE: number }>>(
    "SELECT DISTINCT INDEX_NAME, NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductSourceRecordVersionRow'",
  );
  const hasUniqueVersion = idx.some(
    (i) => i.INDEX_NAME.includes("sourceRecordId_sourceRecordVer") && Number(i.NON_UNIQUE) === 0,
  );
  if (!hasUniqueVersion) fail("missing unique (sourceRecordId, sourceRecordVersion) index");
  ok("expected indexes/constraints present");

  // 4b. Publication / outbox uniqueness constraints.
  const uniqueIndexNames = async (table: string): Promise<string[]> => {
    const rows = await db.$queryRawUnsafe<Array<{ INDEX_NAME: string; NON_UNIQUE: number }>>(
      "SELECT DISTINCT INDEX_NAME, NON_UNIQUE FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
      table,
    );
    return rows.filter((r) => Number(r.NON_UNIQUE) === 0).map((r) => r.INDEX_NAME);
  };
  const pubUnique = await uniqueIndexNames("ProductPublication");
  for (const col of ["publicationId", "capsuleId", "nodeId_sourceRecordId_sourceRecordVersion"]) {
    if (!pubUnique.some((i) => i.includes(col.slice(0, 30)))) {
      fail(`missing unique ProductPublication index for ${col}`);
    }
  }
  const obxUnique = await uniqueIndexNames("PublicationOutbox");
  for (const col of ["outboxId", "publicationId", "idempotencyKey"]) {
    if (!obxUnique.some((i) => i.includes(col))) fail(`missing unique PublicationOutbox.${col} index`);
  }
  ok("unique publicationId, capsuleId, idempotencyKey (+ one publication per Node/source version)");

  // 4c. Expected foreign keys.
  const fks = await db.$queryRawUnsafe<
    Array<{ TABLE_NAME: string; REFERENCED_TABLE_NAME: string; DELETE_RULE: string }>
  >(
    `SELECT k.TABLE_NAME, k.REFERENCED_TABLE_NAME, r.DELETE_RULE
       FROM information_schema.KEY_COLUMN_USAGE k
       JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.CONSTRAINT_SCHEMA = k.TABLE_SCHEMA
      WHERE k.TABLE_SCHEMA = DATABASE() AND k.REFERENCED_TABLE_NAME IS NOT NULL`,
  );
  const hasFk = (from: string, to: string) =>
    fks.some((f) => f.TABLE_NAME === from && f.REFERENCED_TABLE_NAME === to);
  for (const [from, to] of [
    ["ProductPublication", "Product"],
    ["ProductPublication", "ProductNode"],
    ["ProductPublication", "ProductSourceRecordVersionRow"],
    ["PublicationOutbox", "ProductPublication"],
  ] as const) {
    if (!hasFk(from, to)) fail(`missing foreign key ${from} -> ${to}`);
  }
  const restricted = fks.filter(
    (f) =>
      (f.TABLE_NAME === "ProductPublication" || f.TABLE_NAME === "PublicationOutbox") &&
      f.DELETE_RULE !== "RESTRICT" &&
      f.DELETE_RULE !== "NO ACTION",
  );
  if (restricted.length > 0) fail("publication foreign keys must not cascade on delete");
  ok("publication/outbox foreign keys present with RESTRICT on delete");

  // 4d. Product facts must not be duplicated into publication columns, and the
  //     capsule body must have nowhere to live on the publication row.
  const pubCols = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string; DATA_TYPE: string }>>(
    "SELECT COLUMN_NAME, DATA_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductPublication'",
  );
  if (pubCols.length === 0) fail("could not introspect ProductPublication columns");
  const lowerPubCols = pubCols.map((c) => c.COLUMN_NAME.toLowerCase());
  for (const fact of [
    "name",
    "description",
    "image",
    "productversion",
    "promotable",
    "generalavailability",
    "specification",
    "capabilit",
    "relationship",
    "lifecycle",
  ]) {
    if (lowerPubCols.some((c) => c.includes(fact))) {
      fail(`ProductPublication must not carry a Product fact / lifecycle column matching "${fact}"`);
    }
  }
  if (pubCols.some((c) => ["json", "text", "longtext", "mediumtext"].includes(c.DATA_TYPE))) {
    fail("ProductPublication must not hold a capsule body (no JSON/TEXT columns)");
  }
  ok("Product facts absent from publication columns; no capsule body column");

  // 5-7. Safe synthetic read/write transaction + reconstruction + deterministic candidate.
  const repo = new ProductRepository(db);
  await cleanup(db);
  try {
    const record = syntheticCheckRecord();
    await repo.createInitialProductSourceRecord({ record });
    const read = await repo.getCurrentProductSourceRecord(CHECK_INTERNAL);
    if (read.capsuleGeneratedAt !== record.capsuleGeneratedAt) fail("capsuleGeneratedAt round-trip mismatch");
    ok("synthetic write + Prisma→domain reconstruction");

    const fromDb = await repo.generateCandidateFromPersistedProductVersion(CHECK_SREC, "1");
    const fromMem = productSourceRecordToCapsuleCandidate(record);
    if (candidateHash(fromDb) !== candidateHash(fromMem)) fail("deterministic candidate hash mismatch");
    ok("deterministic candidate generation from persisted version");

    // Product Node: synthetic issuance, retrieval, one lifecycle transition.
    const nodeRepo = new ProductNodeRepository(db);
    await nodeRepo.issueProductNode({
      nodeId: CHECK_NODE_ANS,
      internalProductId: CHECK_INTERNAL,
      nodeKind: "product",
      nodePolicyRef: "an:policy:node:dbcheck",
      nodePolicyVersion: "1.0.0",
      registrarId: MONACADO_REGISTRAR_ID,
      issuedAt: "2026-01-02T00:00:00.000Z",
    });
    const byNode = await nodeRepo.getProductNode(CHECK_NODE_ANS);
    const byProduct = await nodeRepo.getProductNodeByInternalProductId(CHECK_INTERNAL);
    if (byNode.nodeId !== byProduct.nodeId) fail("node retrieval mismatch");
    if (byNode.lifecycleState !== "Active") fail("issued node not Active");
    ok("Product Node issuance + retrieval by nodeId and productId");

    // Publication preparation (offline) — requires the Node to still be Active,
    // so it runs BEFORE the lifecycle transition below.
    const pubService = new ProductPublicationService(db);
    const prepared = await pubService.prepareProductPublication({
      publicationId: CHECK_PUBLICATION,
      internalProductId: CHECK_INTERNAL,
      sourceRecordId: CHECK_SREC,
      sourceRecordVersion: "1",
      nodeId: CHECK_NODE_ANS,
      capsuleId: CHECK_CAPSULE,
      capsuleSemver: record.capsuleSemver,
      publishedBy: MONACADO_PUBLISHER_ID,
      publishedAt: "2026-01-02T12:00:00.000Z",
      nodePolicy: { ref: "an:policy:node:dbcheck", version: "1.0.0" },
      capsulePolicy: { ref: "an:policy:capsule:dbcheck", version: "1.0.0" },
      availableAt: "2026-01-02T12:00:00.000Z",
    });
    if (prepared.publication.publicationStatus !== "QUEUED") fail("prepared publication not QUEUED");
    if (prepared.outbox.operationType !== "REGISTER") fail("outbox operation is not REGISTER");
    if (prepared.outbox.outboxStatus !== "PENDING") fail("outbox state is not PENDING");
    if (prepared.outbox.attemptCount !== 0) fail("outbox attemptCount did not begin at zero");
    ok("synthetic publication preparation (QUEUED + PENDING REGISTER outbox item)");

    // Both rows exist — the transaction committed atomically.
    const pubRow = await db.productPublication.findUnique({
      where: { publicationId: CHECK_PUBLICATION },
    });
    const obxRow = await db.publicationOutbox.findUnique({
      where: { publicationId: CHECK_PUBLICATION },
    });
    if (!pubRow || !obxRow) fail("publication and outbox were not created atomically");
    ok("publication + outbox created atomically in one transaction");

    // The published capsule validates, and the payload hash matches canonically.
    const validated = validatePublishedProductCapsule(prepared.outbox.payload);
    if (!validated.ok) fail(`published capsule failed validation: ${validated.errors?.join("; ")}`);
    if (prepared.outbox.payloadHash !== canonicalHash(prepared.outbox.payload)) {
      fail("outbox payloadHash does not match the canonical payload");
    }
    if (prepared.outbox.payload.metadata.contentHash !== prepared.publication.publishedContentHash) {
      fail("publishedContentHash does not match the capsule contentHash");
    }
    ok("published capsule validates; payloadHash matches canonical payload");

    // The capsule body exists ONLY in the outbox payload. (BigInt row ids are not
    // JSON-serializable, so stringify them explicitly.)
    const pubRowText = JSON.stringify(pubRow, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    for (const marker of ["@context", "@type", record.facts.name]) {
      if (pubRowText.includes(marker)) fail("capsule body leaked into the publication row");
    }
    ok("capsule body exists only in the outbox payload");

    // Identical repeat is idempotent — no duplicate rows.
    const repeat = await pubService.prepareProductPublication({
      publicationId: CHECK_PUBLICATION,
      internalProductId: CHECK_INTERNAL,
      sourceRecordId: CHECK_SREC,
      sourceRecordVersion: "1",
      nodeId: CHECK_NODE_ANS,
      capsuleId: CHECK_CAPSULE,
      capsuleSemver: record.capsuleSemver,
      publishedBy: MONACADO_PUBLISHER_ID,
      publishedAt: "2026-01-02T12:00:00.000Z",
      nodePolicy: { ref: "an:policy:node:dbcheck", version: "1.0.0" },
      capsulePolicy: { ref: "an:policy:capsule:dbcheck", version: "1.0.0" },
      availableAt: "2026-01-02T12:00:00.000Z",
    });
    if (!repeat.alreadyPrepared) fail("repeated preparation was not idempotent");
    const pubCount = await db.productPublication.count({ where: { publicationId: CHECK_PUBLICATION } });
    const obxCount = await db.publicationOutbox.count({ where: { publicationId: CHECK_PUBLICATION } });
    if (pubCount !== 1 || obxCount !== 1) fail("idempotent repeat created duplicate rows");
    ok("idempotent repeat returns the existing publication and outbox item");

    const transitioned = await nodeRepo.transitionProductNodeLifecycle({
      nodeId: CHECK_NODE_ANS,
      toState: "Inactive",
      lifecycleChangedAt: "2026-01-03T00:00:00.000Z",
    });
    if (transitioned.lifecycleState !== "Inactive") fail("lifecycle transition did not apply");
    ok("Product Node lifecycle transition (Active -> Inactive)");
  } finally {
    await cleanup(db);
  }

  console.log(`\ndb:check — ${checks} checks passed.`);
}

async function cleanup(db: ReturnType<typeof getPrisma>): Promise<void> {
  // FK-safe order (all publication FKs are RESTRICT): outbox → publication →
  // Node → source versions → Product.
  await db.publicationOutbox.deleteMany({ where: { publicationId: CHECK_PUBLICATION } });
  await db.productPublication.deleteMany({ where: { internalProductId: CHECK_INTERNAL } });
  await db.productNode.deleteMany({ where: { internalProductId: CHECK_INTERNAL } });
  await db.productSourceRecordVersionRow.deleteMany({ where: { internalProductId: CHECK_INTERNAL } });
  await db.product.deleteMany({ where: { internalProductId: CHECK_INTERNAL } });
}

main()
  .catch((e) => fail("db:check failed", e))
  .finally(() => {
    void disconnectPrisma();
  });
