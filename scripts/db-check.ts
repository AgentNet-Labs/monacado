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
import { PublicationOutboxRepository } from "../src/server/product/publication-outbox-repository";
import { UnsafeErrorMetadataError } from "../src/server/product/outbox-errors";
import { LEASE_EXPIRED_ERROR_CODE } from "../src/contracts/index";
import { RegistrarReceiptService } from "../src/server/product/registrar-receipt-service";
import {
  MONACADO_PUBLISHER_ID,
  canonicalHash,
  candidateHash,
  finalizeProductCapsule,
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
const CHECK_PUBLICATION2 = `mon:pub:${pad26("DBCHECKPUB2")}`;
const CHECK_CAPSULE2 = `an:capsule:${pad26("DBCHECKCAPSULE2")}`;
const CHECK_RECEIPT = `mon:rcpt:${pad26("DBCHECKRECEIPT")}`;
const CHECK_PUBLICATION3 = `mon:pub:${pad26("DBCHECKPUB3")}`;
const CHECK_CAPSULE3 = `an:capsule:${pad26("DBCHECKCAPSULE3")}`;

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
    "add_outbox_claiming_and_retry_state",
    "add_registrar_receipts_and_reconciliation",
    "add_outbox_lease_expiry",
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
    "RegistrarReceipt",
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
    const preparedPayload = prepared.outbox.payload;
    if (preparedPayload === undefined) fail("a freshly prepared outbox item has no payload");
    if (prepared.outbox.payloadHash !== canonicalHash(preparedPayload)) {
      fail("outbox payloadHash does not match the canonical payload");
    }
    if (preparedPayload.metadata.contentHash !== prepared.publication.publishedContentHash) {
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

    // — Outbox processing (Phase 0E.3): claim → retry → re-claim → complete —
    const outboxRepo = new PublicationOutboxRepository(db);
    const OBX_T1 = "2026-01-03T00:00:00.000Z";
    const OBX_T2 = "2026-01-04T00:00:00.000Z";
    const OBX_T3 = "2026-01-05T00:00:00.000Z";

    // New columns exist and are unset on a freshly prepared item.
    const obxCols = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string; IS_NULLABLE: string }>>(
      "SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'PublicationOutbox'",
    );
    const obxColNames = obxCols.map((c) => c.COLUMN_NAME);
    for (const col of ["lockedAt", "lockToken", "completedAt", "lastErrorCode", "lastErrorSummary"]) {
      if (!obxColNames.includes(col)) fail(`missing PublicationOutbox.${col} column`);
      if (obxCols.find((c) => c.COLUMN_NAME === col)?.IS_NULLABLE !== "YES") {
        fail(`PublicationOutbox.${col} must be nullable`);
      }
    }
    // "lease" is legitimate from Phase 0E.5.1 (leaseExpiresAt); receipts,
    // registration, reconciliation, and Resolver state still have no place here.
    for (const forbidden of ["receipt", "registrat", "reconcil", "resolver"]) {
      if (obxColNames.some((c) => c.toLowerCase().includes(forbidden))) {
        fail(`PublicationOutbox must not carry a "${forbidden}" column in this phase`);
      }
    }
    ok("outbox claim/outcome columns present and nullable; no receipt/reconciliation columns");

    // Claim the prepared item.
    const claimed = await outboxRepo.claimNextPublicationOutbox({ now: OBX_T1, leaseDurationSeconds: 3600 });
    if (claimed.outbox.outboxStatus !== "PROCESSING") fail("claimed item is not PROCESSING");
    if (claimed.outbox.attemptCount !== 1) fail("attemptCount did not increment to 1");
    if (claimed.outbox.lockToken !== claimed.lockToken) fail("lockToken not recorded on the row");
    if (claimed.outbox.lockedAt !== OBX_T1) fail("lockedAt not recorded");
    ok("outbox claim (PENDING -> PROCESSING, attemptCount 1, lock held)");

    // Retry: reschedules, clears the lock, stores bounded safe metadata.
    const retried = await outboxRepo.markPublicationOutboxRetryable({
      outboxId: claimed.outbox.outboxId,
      lockToken: claimed.lockToken,
      availableAt: OBX_T2,
      errorCode: "SUBMISSION_TIMEOUT",
      errorSummary: "Attempt timed out awaiting acknowledgement.",
    });
    if (retried.outboxStatus !== "RETRYABLE") fail("retry did not transition to RETRYABLE");
    if (retried.lockToken !== undefined || retried.lockedAt !== undefined) {
      fail("retry did not clear the lock fields");
    }
    if (retried.availableAt !== OBX_T2) fail("retry did not reschedule availableAt");
    if (retried.lastErrorCode !== "SUBMISSION_TIMEOUT") fail("retry did not store the error code");
    if (retried.payloadHash !== canonicalHash(retried.payload)) {
      fail("retry altered the payload or payloadHash");
    }
    ok("outbox retry (PROCESSING -> RETRYABLE, lock cleared, payload preserved)");

    // Not claimable before the new availableAt; claimable at it.
    let tooEarly = false;
    try {
      await outboxRepo.claimNextPublicationOutbox({ now: OBX_T1, leaseDurationSeconds: 3600 });
    } catch {
      tooEarly = true;
    }
    if (!tooEarly) fail("a retryable item was claimable before its availableAt");
    const reclaimed = await outboxRepo.claimNextPublicationOutbox({ now: OBX_T2, leaseDurationSeconds: 3600 });
    if (reclaimed.outbox.attemptCount !== 2) fail("re-claim did not increment attemptCount to 2");
    ok("outbox re-claim only after availableAt (attemptCount 2)");

    // Unsafe error metadata is refused, and nothing is persisted.
    let refused = false;
    try {
      await outboxRepo.markPublicationOutboxRetryable({
        outboxId: reclaimed.outbox.outboxId,
        lockToken: reclaimed.lockToken,
        availableAt: OBX_T3,
        errorCode: "SUBMISSION_FAILED",
        errorSummary: "connect failed for mysql://user:pw@host:3306/db",
      });
    } catch (e) {
      refused = e instanceof UnsafeErrorMetadataError;
    }
    if (!refused) fail("unsafe error metadata was not refused");
    ok("unsafe error metadata refused (connection string)");

    // Completion.
    const completed = await outboxRepo.markPublicationOutboxCompleted({
      outboxId: reclaimed.outbox.outboxId,
      lockToken: reclaimed.lockToken,
      completedAt: OBX_T3,
    });
    if (completed.outboxStatus !== "COMPLETED") fail("completion did not transition to COMPLETED");
    if (completed.completedAt !== OBX_T3) fail("completedAt not recorded");
    if (completed.lockToken !== undefined) fail("completion did not clear the lock");
    if (completed.payloadHash !== canonicalHash(completed.payload)) {
      fail("completion altered the payload");
    }
    const stillQueued = await pubService.getProductPublication(CHECK_PUBLICATION);
    if (stillQueued.publicationStatus !== "QUEUED") {
      fail("outbox processing changed the publication status");
    }
    ok("outbox completion (PROCESSING -> COMPLETED, payload retained, publication still QUEUED)");


    // — Registrar receipts and reconciliation (Phase 0E.4) —
    // Structural: new publication state columns and a nullable outbox payload.
    const pubStateCols = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductPublication'",
    );
    const pubStateNames = pubStateCols.map((c) => c.COLUMN_NAME);
    for (const col of ["registrationState", "reconciliationState"]) {
      if (!pubStateNames.includes(col)) fail(`missing ProductPublication.${col} column`);
    }
    const payloadCol = await db.$queryRawUnsafe<Array<{ IS_NULLABLE: string }>>(
      "SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'PublicationOutbox' AND COLUMN_NAME = 'payload'",
    );
    if (payloadCol[0]?.IS_NULLABLE !== "YES") fail("PublicationOutbox.payload must be nullable");
    const rcptUnique = await uniqueIndexNames("RegistrarReceipt");
    for (const col of ["receiptId", "registrarRegistrationId", "acceptedForPublicationId"]) {
      if (!rcptUnique.some((i) => i.includes(col))) fail(`missing unique RegistrarReceipt.${col} index`);
    }
    if (!hasFk("RegistrarReceipt", "ProductPublication")) {
      fail("missing RegistrarReceipt -> ProductPublication foreign key");
    }
    ok("receipt table, publication state columns, nullable payload, receipt uniqueness + FK");

    // Prepare a SECOND publication (new immutable source version) and claim it,
    // so the Phase 0E.3 completion above is left intact.
    await repo.createProductSourceRecordRevision({
      internalProductId: CHECK_INTERNAL,
      expectedCurrentSourceRecordVersion: "1",
      sourceRecordVersion: "2",
      updatedAt: "2026-01-06T00:00:00.000Z",
      capsuleGeneratedAt: "2026-01-06T06:30:00.000Z",
    });
    const prepared2 = await pubService.prepareProductPublication({
      publicationId: CHECK_PUBLICATION2,
      internalProductId: CHECK_INTERNAL,
      sourceRecordId: CHECK_SREC,
      sourceRecordVersion: "2",
      nodeId: CHECK_NODE_ANS,
      capsuleId: CHECK_CAPSULE2,
      capsuleSemver: "1.0.0",
      publishedBy: MONACADO_PUBLISHER_ID,
      publishedAt: "2026-01-06T12:00:00.000Z",
      nodePolicy: { ref: "an:policy:node:dbcheck", version: "1.0.0" },
      capsulePolicy: { ref: "an:policy:capsule:dbcheck", version: "1.0.0" },
      availableAt: "2026-01-06T12:00:00.000Z",
    });
    if (prepared2.publication.registrationState !== "NOT_SUBMITTED") {
      fail("a prepared publication must begin NOT_SUBMITTED");
    }
    if (prepared2.publication.reconciliationState !== "NOT_REQUIRED") {
      fail("a prepared publication must begin NOT_REQUIRED");
    }
    const claimed2 = await outboxRepo.claimNextPublicationOutbox({ now: "2026-01-06T13:00:00.000Z", leaseDurationSeconds: 3600 });
    const payloadBefore = claimed2.outbox.payload;
    if (payloadBefore === undefined) fail("payload must be present before reconciliation");
    ok("second publication prepared (NOT_SUBMITTED / NOT_REQUIRED) and claimed");

    // Record a MATCHING accepted receipt.
    const receiptService = new RegistrarReceiptService(db);
    const reconciled = await receiptService.recordRegistrarReceipt({
      receiptId: CHECK_RECEIPT,
      publicationId: CHECK_PUBLICATION2,
      registrarRegistrationId: "dbcheck-registration-0e4",
      registrarId: MONACADO_REGISTRAR_ID,
      nodeId: CHECK_NODE_ANS,
      capsuleId: CHECK_CAPSULE2,
      registeredContentHash: prepared2.publication.publishedContentHash,
      receiptStatus: "ACCEPTED",
      registeredAt: "2026-01-06T14:00:00.000Z",
      receivedAt: "2026-01-06T14:00:05.000Z",
      receiptDetails: { registrarStatusCode: "REGISTERED" },
    });
    if (reconciled.mismatchedFields.length !== 0) fail("a matching receipt reported a mismatch");
    if (reconciled.registrationState !== "ACCEPTED") fail("registration did not become ACCEPTED");
    if (reconciled.reconciliationState !== "MATCHED") fail("reconciliation did not become MATCHED");
    if (reconciled.outbox.outboxStatus !== "COMPLETED") fail("outbox did not become COMPLETED");
    if (reconciled.outbox.completedAt === undefined) fail("completedAt was not set");
    ok("matching accepted receipt: registration ACCEPTED, reconciliation MATCHED, outbox COMPLETED");

    // Payload cleared; hashes and source pointers retained.
    if (!reconciled.payloadDisposed || reconciled.outbox.payload !== undefined) {
      fail("payload was not cleared after a matching accepted receipt");
    }
    if (reconciled.outbox.payloadHash !== prepared2.outbox.payloadHash) fail("payloadHash changed");
    if (reconciled.publication.publishedContentHash !== prepared2.publication.publishedContentHash) {
      fail("publishedContentHash changed");
    }
    if (reconciled.publication.candidateHash !== prepared2.publication.candidateHash) {
      fail("candidateHash changed");
    }
    if (
      reconciled.publication.sourceRecordId !== CHECK_SREC ||
      reconciled.publication.sourceRecordVersion !== "2" ||
      reconciled.publication.mappingVersion !== prepared2.publication.mappingVersion
    ) {
      fail("source pointers or mappingVersion were not retained");
    }
    await receiptService.assertPayloadDisposed(CHECK_PUBLICATION2);
    if ((await db.publicationOutbox.count({ where: { publicationId: CHECK_PUBLICATION2 } })) !== 1) {
      fail("the outbox row must not be deleted on disposal");
    }
    ok("payload cleared; payloadHash, content/candidate hashes, and source pointers retained");

    // Deterministic regeneration from RETAINED data only.
    const retainedRecord = await repo.getProductSourceRecordVersion(CHECK_SREC, "2");
    const rebuilt = finalizeProductCapsule({
      candidate: productSourceRecordToCapsuleCandidate(retainedRecord),
      capsuleId: reconciled.publication.capsuleId,
      bindsToNode: reconciled.publication.nodeId,
      publishedBy: reconciled.publication.publishedBy,
      publishedAt: reconciled.publication.publishedAt,
      nodePolicy: {
        ref: reconciled.publication.nodePolicyRef,
        version: reconciled.publication.nodePolicyVersion,
      },
      capsulePolicy: {
        ref: reconciled.publication.capsulePolicyRef,
        version: reconciled.publication.capsulePolicyVersion,
      },
    });
    if (canonicalHash(rebuilt) !== reconciled.outbox.payloadHash) {
      fail("regenerated capsule does not match the retained payloadHash");
    }
    if (rebuilt.metadata.contentHash !== reconciled.publication.publishedContentHash) {
      fail("regenerated capsule contentHash does not match the publication");
    }
    ok("published capsule regenerates deterministically after payload disposal");


    // — Lease expiry and stale-claim recovery (Phase 0E.5.1) —
    const LEASE_T0 = "2026-01-07T00:00:00.000Z";
    const LEASE_EXPIRY_AT = "2026-01-07T00:10:00.000Z";
    const BEFORE_LEASE_EXPIRY = "2026-01-07T00:05:00.000Z";
    const AFTER_LEASE_EXPIRY = "2026-01-07T01:00:00.000Z";

    // 1. leaseExpiresAt column exists and is nullable.
    const leaseCol = await db.$queryRawUnsafe<Array<{ IS_NULLABLE: string }>>(
      "SELECT IS_NULLABLE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'PublicationOutbox' AND COLUMN_NAME = 'leaseExpiresAt'",
    );
    if (leaseCol.length === 0) fail("missing PublicationOutbox.leaseExpiresAt column");
    if (leaseCol[0]?.IS_NULLABLE !== "YES") fail("PublicationOutbox.leaseExpiresAt must be nullable");
    const leaseIdx = await db.$queryRawUnsafe<Array<{ INDEX_NAME: string }>>(
      "SELECT DISTINCT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'PublicationOutbox' AND COLUMN_NAME = 'leaseExpiresAt'",
    );
    if (leaseIdx.length === 0) fail("missing index covering PublicationOutbox.leaseExpiresAt");
    ok("leaseExpiresAt column exists, is nullable, and is indexed for stale lookup");

    // Prepare a THIRD publication so the earlier flows stay intact.
    await repo.createProductSourceRecordRevision({
      internalProductId: CHECK_INTERNAL,
      expectedCurrentSourceRecordVersion: "2",
      sourceRecordVersion: "3",
      updatedAt: "2026-01-07T00:00:00.000Z",
      capsuleGeneratedAt: "2026-01-07T00:00:00.000Z",
    });
    const prepared3 = await pubService.prepareProductPublication({
      publicationId: CHECK_PUBLICATION3,
      internalProductId: CHECK_INTERNAL,
      sourceRecordId: CHECK_SREC,
      sourceRecordVersion: "3",
      nodeId: CHECK_NODE_ANS,
      capsuleId: CHECK_CAPSULE3,
      capsuleSemver: "1.0.0",
      publishedBy: MONACADO_PUBLISHER_ID,
      publishedAt: "2026-01-07T00:00:00.000Z",
      nodePolicy: { ref: "an:policy:node:dbcheck", version: "1.0.0" },
      capsulePolicy: { ref: "an:policy:capsule:dbcheck", version: "1.0.0" },
      availableAt: LEASE_T0,
    });

    // 2. A claim sets lockedAt, lockToken, and leaseExpiresAt.
    const leaseClaim = await outboxRepo.claimNextPublicationOutbox({
      now: LEASE_T0,
      leaseDurationSeconds: 600,
    });
    if (leaseClaim.outbox.outboxId !== prepared3.outbox.outboxId) fail("claimed the wrong item");
    if (leaseClaim.outbox.lockedAt !== LEASE_T0) fail("claim did not record lockedAt");
    if (leaseClaim.outbox.lockToken === undefined) fail("claim did not record lockToken");
    if (leaseClaim.outbox.leaseExpiresAt !== LEASE_EXPIRY_AT) fail("claim did not record leaseExpiresAt");
    const claimedPayload = leaseClaim.outbox.payload;
    if (claimedPayload === undefined) fail("claimed item has no payload");
    ok("claim sets lockedAt, lockToken, and leaseExpiresAt");

    // 3. A non-expired claim is not recovered.
    const early = await outboxRepo.recoverExpiredPublicationOutboxClaims({
      now: BEFORE_LEASE_EXPIRY,
      limit: 10,
    });
    if (early.recoveredCount !== 0 || early.examined !== 0) {
      fail("a live (non-expired) claim was recovered");
    }
    ok("a non-expired claim is not recovered");

    // 4-7. An expired claim becomes RETRYABLE with ownership cleared and
    //      attemptCount, payload, and payloadHash preserved.
    const swept = await outboxRepo.recoverExpiredPublicationOutboxClaims({
      now: AFTER_LEASE_EXPIRY,
      limit: 10,
    });
    if (swept.recoveredCount !== 1) fail("an expired claim was not recovered");
    const recovered = swept.recovered[0]!;
    if (recovered.outboxStatus !== "RETRYABLE") fail("recovery did not set RETRYABLE");
    if (
      recovered.lockToken !== undefined ||
      recovered.lockedAt !== undefined ||
      recovered.leaseExpiresAt !== undefined
    ) {
      fail("recovery did not clear all claim ownership fields");
    }
    if (recovered.attemptCount !== leaseClaim.outbox.attemptCount) {
      fail("recovery did not preserve attemptCount");
    }
    if (recovered.payload === undefined) fail("recovery did not preserve the payload");
    if (recovered.payloadHash !== prepared3.outbox.payloadHash) fail("recovery changed payloadHash");
    if (recovered.payloadHash !== canonicalHash(recovered.payload)) {
      fail("recovered payload no longer matches its hash");
    }
    if (recovered.lastErrorCode !== LEASE_EXPIRED_ERROR_CODE) {
      fail("recovery did not record LEASE_EXPIRED metadata");
    }
    ok("expired claim -> RETRYABLE; ownership cleared; attempts, payload, and hash preserved");

    // 8. The recovered item can be claimed again.
    const leaseReclaimed = await outboxRepo.claimNextPublicationOutbox({
      now: AFTER_LEASE_EXPIRY,
      leaseDurationSeconds: 600,
    });
    if (leaseReclaimed.outbox.outboxId !== prepared3.outbox.outboxId) {
      fail("recovered item was not reclaimable");
    }
    if (leaseReclaimed.outbox.attemptCount !== leaseClaim.outbox.attemptCount + 1) {
      fail("re-claim did not increment attemptCount");
    }
    ok("a recovered item can be claimed again (attemptCount advances)");

    // 9. The stale original token can no longer resolve the item.
    let staleRefused = false;
    try {
      await outboxRepo.markPublicationOutboxCompleted({
        outboxId: prepared3.outbox.outboxId,
        lockToken: leaseClaim.lockToken,
        completedAt: AFTER_LEASE_EXPIRY,
      });
    } catch {
      staleRefused = true;
    }
    if (!staleRefused) fail("a stale lock token was still able to resolve the item");
    ok("the stale original lock token can no longer resolve the item");

    // 10. A receipt-completed item is never recoverable.
    const completedLease = await db.publicationOutbox.findUnique({
      where: { publicationId: CHECK_PUBLICATION2 },
    });
    if (completedLease?.leaseExpiresAt !== null) {
      fail("receipt-driven completion did not clear leaseExpiresAt");
    }
    const sweepAgain = await outboxRepo.recoverExpiredPublicationOutboxClaims({
      now: "2030-01-01T00:00:00.000Z",
      limit: 10,
    });
    if (sweepAgain.recovered.some((r) => r.publicationId === CHECK_PUBLICATION2)) {
      fail("a receipt-completed item was recovered");
    }
    ok("receipt-completed item has no lease and is never recovered");

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
  await db.registrarReceipt.deleteMany({
    where: { publicationId: { in: [CHECK_PUBLICATION, CHECK_PUBLICATION2, CHECK_PUBLICATION3] } },
  });
  await db.publicationOutbox.deleteMany({
    where: { publicationId: { in: [CHECK_PUBLICATION, CHECK_PUBLICATION2, CHECK_PUBLICATION3] } },
  });
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
