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
import { candidateHash, productSourceRecordToCapsuleCandidate } from "../src/contracts/index";
import type { ProductSourceRecord } from "../src/contracts/index";

/** Produce an exact 26-char Crockford body from a seed (I/L/O/U -> 0). */
const pad26 = (seed: string): string =>
  (seed.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);
const CHECK_INTERNAL = `mon:product:${pad26("DBCHECKPRODUCT")}`;
const CHECK_SREC = `mon:srec:${pad26("DBCHECKSREC")}`;
const CHECK_CREATOR = `mon:creator:${pad26("DBCHECKCREATOR")}`;
const CHECK_NODE = `an:node:${pad26("DBCHECKNODE")}`;
const CHECK_NODE_ANS = `an:node:${pad26("DBCHECKANSNODE")}`;

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
  if (!migrations.some((m) => m.migration_name.includes("init_product_source_records"))) {
    fail("expected migration not applied");
  }
  ok(`migration state (${migrations.length} applied)`);

  // 3. Expected tables.
  const tables = await db.$queryRawUnsafe<Array<{ TABLE_NAME: string }>>(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()",
  );
  const names = new Set(tables.map((t) => t.TABLE_NAME));
  for (const t of ["Product", "ProductSourceRecordVersionRow", "ProductNode"]) {
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
  // Delete Node first (FK RESTRICT), then versions, then the Product.
  await db.productNode.deleteMany({ where: { internalProductId: CHECK_INTERNAL } });
  await db.productSourceRecordVersionRow.deleteMany({ where: { internalProductId: CHECK_INTERNAL } });
  await db.product.deleteMany({ where: { internalProductId: CHECK_INTERNAL } });
}

main()
  .catch((e) => fail("db:check failed", e))
  .finally(() => {
    void disconnectPrisma();
  });
