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
import { PublicationRemediationService } from "../src/server/product/publication-remediation-service";
import { PublicationSubmissionAttemptService } from "../src/server/product/submission-attempt-service";
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
const CHECK_PUBLICATION4 = `mon:pub:${pad26("DBCHECKPUB4")}`;
const CHECK_CAPSULE4 = `an:capsule:${pad26("DBCHECKCAPSULE4")}`;
const CHECK_PUBLICATION5 = `mon:pub:${pad26("DBCHECKPUB5")}`;
const CHECK_CAPSULE5 = `an:capsule:${pad26("DBCHECKCAPSULE5")}`;
const CHECK_ACTOR = `mon:actor:${pad26("DBCHECKACTOR")}`;
const CHECK_PUBLICATION6 = `mon:pub:${pad26("DBCHECKPUB6")}`;
const CHECK_CAPSULE6 = `an:capsule:${pad26("DBCHECKCAPSULE6")}`;
const CHECK_PUBLICATION7 = `mon:pub:${pad26("DBCHECKPUB7")}`;
const CHECK_CAPSULE7 = `an:capsule:${pad26("DBCHECKCAPSULE7")}`;
const CHECK_PUBLICATION8 = `mon:pub:${pad26("DBCHECKPUB8")}`;
const CHECK_CAPSULE8 = `an:capsule:${pad26("DBCHECKCAPSULE8")}`;
const CHECK_PUBLICATION9 = `mon:pub:${pad26("DBCHECKPUB9")}`;
const CHECK_CAPSULE9 = `an:capsule:${pad26("DBCHECKCAPSULE9")}`;
let attemptSeq = 0;

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

let attemptService: PublicationSubmissionAttemptService;

/** Prepare and dispatch one submission attempt, returning its id (Phase 0E.5.3). */
async function dispatchAttempt(
  publicationId: string,
  outboxId: string,
  lockToken: string,
  at: string,
): Promise<string> {
  attemptSeq += 1;
  const submissionAttemptId = `mon:attempt:${pad26(`DBCHECKATT${String(attemptSeq).padStart(3, "0")}`)}`;
  await attemptService.preparePublicationSubmissionAttempt({
    publicationId,
    outboxId,
    lockToken,
    submissionAttemptId,
    preparedAt: at,
  });
  await attemptService.markPublicationSubmissionAttemptDispatched({
    submissionAttemptId,
    lockToken,
    dispatchedAt: at,
  });
  return submissionAttemptId;
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
    "add_publication_remediation",
    "add_publication_submission_attempts",
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
    "PublicationRemediation",
    "PublicationSubmissionAttempt",
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
    attemptService = new PublicationSubmissionAttemptService(db);
    const attempt2 = await dispatchAttempt(
      CHECK_PUBLICATION2,
      claimed2.outbox.outboxId,
      claimed2.lockToken,
      "2026-01-06T13:00:00.000Z",
    );
    const reconciled = await receiptService.recordRegistrarReceipt({
      receiptId: CHECK_RECEIPT,
      publicationId: CHECK_PUBLICATION2,
      submissionAttemptId: attempt2,
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


    // — Publication remediation (Phase 0E.5.2) —
    const remediationService = new PublicationRemediationService(db);
    const REM_T0 = "2026-01-08T00:00:00.000Z";
    const REM_DECIDED = "2026-01-09T00:00:00.000Z";
    const REM_RETRY_AT = "2026-01-10T00:00:00.000Z";

    // 1. Remediation table and publication state column exist.
    const remCols = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ProductPublication'",
    );
    if (!remCols.some((c) => c.COLUMN_NAME === "remediationState")) {
      fail("missing ProductPublication.remediationState column");
    }
    const remUnique = await uniqueIndexNames("PublicationRemediation");
    if (!remUnique.some((i) => i.includes("remediationId"))) {
      fail("missing unique PublicationRemediation.remediationId index");
    }
    if (!hasFk("PublicationRemediation", "ProductPublication")) {
      fail("missing PublicationRemediation -> ProductPublication foreign key");
    }
    ok("remediation table, unique remediationId, FK, and publication state column present");

    /** Prepare + claim a further publication on a new immutable source version. */
    const prepareAndClaim = async (
      version: string,
      publicationId: string,
      capsuleId: string,
      priorVersion: string,
    ) => {
      await repo.createProductSourceRecordRevision({
        internalProductId: CHECK_INTERNAL,
        expectedCurrentSourceRecordVersion: priorVersion,
        sourceRecordVersion: version,
        updatedAt: REM_T0,
        capsuleGeneratedAt: REM_T0,
      });
      const prep = await pubService.prepareProductPublication({
        publicationId,
        internalProductId: CHECK_INTERNAL,
        sourceRecordId: CHECK_SREC,
        sourceRecordVersion: version,
        nodeId: CHECK_NODE_ANS,
        capsuleId,
        capsuleSemver: "1.0.0",
        publishedBy: MONACADO_PUBLISHER_ID,
        publishedAt: REM_T0,
        nodePolicy: { ref: "an:policy:node:dbcheck", version: "1.0.0" },
        capsulePolicy: { ref: "an:policy:capsule:dbcheck", version: "1.0.0" },
        availableAt: REM_T0,
      });
      const claim = await outboxRepo.claimNextPublicationOutbox({
        now: REM_T0,
        leaseDurationSeconds: 600,
      });
      const attemptId = await dispatchAttempt(
        publicationId,
        prep.outbox.outboxId,
        claim.lockToken,
        REM_T0,
      );
      return { prep, attemptId, lockToken: claim.lockToken };
    };

    // 2. A matching rejection produces remediation REQUIRED.
    const seeded4 = await prepareAndClaim("4", CHECK_PUBLICATION4, CHECK_CAPSULE4, "3");
    const prep4 = seeded4.prep;
    const rejectedResult = await receiptService.recordRegistrarReceipt({
      receiptId: `mon:rcpt:${pad26("DBCHECKRCPT4")}`,
      publicationId: CHECK_PUBLICATION4,
      submissionAttemptId: seeded4.attemptId,
      registrarId: MONACADO_REGISTRAR_ID,
      nodeId: CHECK_NODE_ANS,
      capsuleId: CHECK_CAPSULE4,
      registeredContentHash: prep4.publication.publishedContentHash,
      receiptStatus: "REJECTED",
      registeredAt: REM_T0,
      receivedAt: REM_T0,
      receiptDetails: { rejectionCode: "POLICY_REFUSED", rejectionReason: "Refused for db:check." },
    });
    if (rejectedResult.publication.remediationState !== "REQUIRED") {
      fail("a matching rejection did not require remediation");
    }
    ok("matching rejection -> remediation REQUIRED");

    // 3. A mismatch also produces remediation REQUIRED.
    const seeded5 = await prepareAndClaim("5", CHECK_PUBLICATION5, CHECK_CAPSULE5, "4");
    const prep5 = seeded5.prep;
    const mismatchResult = await receiptService.recordRegistrarReceipt({
      receiptId: `mon:rcpt:${pad26("DBCHECKRCPT5")}`,
      publicationId: CHECK_PUBLICATION5,
      submissionAttemptId: seeded5.attemptId,
      registrarRegistrationId: "dbcheck-registration-mismatch",
      registrarId: MONACADO_REGISTRAR_ID,
      nodeId: CHECK_NODE_ANS,
      capsuleId: CHECK_CAPSULE4, // names a DIFFERENT capsule
      registeredContentHash: prep5.publication.publishedContentHash,
      receiptStatus: "ACCEPTED",
      registeredAt: REM_T0,
      receivedAt: REM_T0,
      receiptDetails: { registrarStatusCode: "REGISTERED" },
    });
    if (mismatchResult.reconciliationState !== "MISMATCH") fail("expected a reconciliation MISMATCH");
    if (mismatchResult.publication.remediationState !== "REQUIRED") {
      fail("a mismatch did not require remediation");
    }
    ok("mismatched receipt -> reconciliation MISMATCH and remediation REQUIRED");

    // 4-9. RETRY records immutable evidence and re-authorises the work.
    const beforeRetry = await outboxRepo.getPublicationOutboxById(prep4.outbox.outboxId);
    const remRetried = await remediationService.remediateProductPublication({
      publicationId: CHECK_PUBLICATION4,
      remediationId: `mon:rem:${pad26("DBCHECKREM4")}`,
      action: "RETRY",
      reasonCode: "TRANSIENT_REGISTRAR_FAULT",
      reasonSummary: "Authorised one further attempt for db:check.",
      decidedBy: CHECK_ACTOR,
      decidedAt: REM_DECIDED,
      retryAvailableAt: REM_RETRY_AT,
    });
    if (remRetried.remediation.remediationAction !== "RETRY") fail("RETRY not recorded");
    if (remRetried.remediation.priorRegistrationState !== "REJECTED") {
      fail("RETRY did not capture the prior registration state");
    }
    if (remRetried.remediation.decidedBy !== CHECK_ACTOR) fail("RETRY did not record the actor");
    if (
      remRetried.publication.remediationState !== "RETRY_AUTHORIZED" ||
      remRetried.publication.registrationState !== "PENDING" ||
      remRetried.publication.reconciliationState !== "PENDING"
    ) {
      fail("RETRY did not produce RETRY_AUTHORIZED / PENDING / PENDING");
    }
    if (remRetried.outbox.outboxStatus !== "RETRYABLE") fail("RETRY did not make the outbox RETRYABLE");
    if (remRetried.outbox.availableAt !== REM_RETRY_AT) fail("RETRY did not apply retryAvailableAt");
    if (
      remRetried.outbox.lockToken !== undefined ||
      remRetried.outbox.lockedAt !== undefined ||
      remRetried.outbox.leaseExpiresAt !== undefined ||
      remRetried.outbox.completedAt !== undefined
    ) {
      fail("RETRY did not clear claim ownership fields");
    }
    if (remRetried.outbox.payload === undefined) fail("RETRY did not retain the payload");
    if (remRetried.outbox.payloadHash !== beforeRetry.payloadHash) fail("RETRY changed payloadHash");
    if (remRetried.outbox.attemptCount !== beforeRetry.attemptCount) {
      fail("RETRY did not preserve attemptCount");
    }
    await remediationService.assertRemediationConsistency(CHECK_PUBLICATION4);
    ok("RETRY: immutable record, RETRY_AUTHORIZED/PENDING/PENDING, RETRYABLE, ownership cleared, payload retained");

    // 10. Prior receipts remain.
    const keptReceipts = await receiptService.listRegistrarReceipts(CHECK_PUBLICATION4);
    if (keptReceipts.length !== 1 || keptReceipts[0]?.receiptStatus !== "REJECTED") {
      fail("the prior rejected receipt did not survive remediation");
    }
    ok("prior Registrar receipts survive remediation unchanged");

    // 11-13. A later matching acceptance succeeds, resolves, and disposes the payload.
    const reclaim4 = await outboxRepo.claimNextPublicationOutbox({
      now: REM_RETRY_AT,
      leaseDurationSeconds: 600,
    });
    const retryAttempt4 = await dispatchAttempt(
      CHECK_PUBLICATION4,
      prep4.outbox.outboxId,
      reclaim4.lockToken,
      REM_RETRY_AT,
    );
    if (retryAttempt4 === seeded4.attemptId) fail("a retry reused the original submission attempt");
    const resolved = await receiptService.recordRegistrarReceipt({
      receiptId: `mon:rcpt:${pad26("DBCHECKRCPT4B")}`,
      publicationId: CHECK_PUBLICATION4,
      submissionAttemptId: retryAttempt4,
      registrarRegistrationId: "dbcheck-registration-retry",
      registrarId: MONACADO_REGISTRAR_ID,
      nodeId: CHECK_NODE_ANS,
      capsuleId: CHECK_CAPSULE4,
      registeredContentHash: prep4.publication.publishedContentHash,
      receiptStatus: "ACCEPTED",
      registeredAt: REM_RETRY_AT,
      receivedAt: REM_RETRY_AT,
      receiptDetails: { registrarStatusCode: "REGISTERED" },
    });
    if (resolved.registrationState !== "ACCEPTED" || resolved.reconciliationState !== "MATCHED") {
      fail("the acceptance after RETRY did not reconcile");
    }
    if (resolved.publication.remediationState !== "RESOLVED") fail("remediation did not become RESOLVED");
    if (!resolved.payloadDisposed || resolved.outbox.payload !== undefined) {
      fail("the payload was not disposed after the matching acceptance");
    }
    if ((await receiptService.listRegistrarReceipts(CHECK_PUBLICATION4)).length !== 2) {
      fail("both receipts should be retained after resolution");
    }
    await remediationService.assertRemediationConsistency(CHECK_PUBLICATION4);
    ok("acceptance after RETRY -> ACCEPTED/MATCHED/RESOLVED with payload disposed");

    // 14-15. CLOSE records immutable evidence and dead-letters the work.
    const closed = await remediationService.remediateProductPublication({
      publicationId: CHECK_PUBLICATION5,
      remediationId: `mon:rem:${pad26("DBCHECKREM5")}`,
      action: "CLOSE",
      reasonCode: "WITHDRAWN",
      reasonSummary: "Closed for db:check.",
      decidedBy: CHECK_ACTOR,
      decidedAt: REM_DECIDED,
    });
    if (closed.remediation.remediationAction !== "CLOSE") fail("CLOSE not recorded");
    if (closed.publication.remediationState !== "CLOSED") fail("CLOSE did not set CLOSED");
    if (closed.outbox.outboxStatus !== "DEAD_LETTER") fail("CLOSE did not dead-letter the outbox");
    if (closed.outbox.payload === undefined) fail("CLOSE must retain the payload");
    if (closed.outbox.leaseExpiresAt !== undefined || closed.outbox.lockToken !== undefined) {
      fail("CLOSE did not release claim ownership");
    }
    await remediationService.assertRemediationConsistency(CHECK_PUBLICATION5);
    ok("CLOSE: immutable record, CLOSED, DEAD_LETTER, payload retained");

    // 16. A CLOSED publication can be neither retried nor accepted.
    let retryRefused = false;
    try {
      await remediationService.remediateProductPublication({
        publicationId: CHECK_PUBLICATION5,
        remediationId: `mon:rem:${pad26("DBCHECKREM5B")}`,
        action: "RETRY",
        reasonCode: "TRANSIENT_REGISTRAR_FAULT",
        decidedBy: CHECK_ACTOR,
        decidedAt: REM_DECIDED,
        retryAvailableAt: REM_RETRY_AT,
      });
    } catch {
      retryRefused = true;
    }
    if (!retryRefused) fail("a CLOSED publication was retried");

    let acceptRefused = false;
    try {
      await receiptService.recordRegistrarReceipt({
        receiptId: `mon:rcpt:${pad26("DBCHECKRCPT5B")}`,
        publicationId: CHECK_PUBLICATION5,
        submissionAttemptId: seeded5.attemptId,
        registrarRegistrationId: "dbcheck-registration-closed",
        registrarId: MONACADO_REGISTRAR_ID,
        nodeId: CHECK_NODE_ANS,
        capsuleId: CHECK_CAPSULE5,
        registeredContentHash: prep5.publication.publishedContentHash,
        receiptStatus: "ACCEPTED",
        registeredAt: REM_RETRY_AT,
        receivedAt: REM_RETRY_AT,
        receiptDetails: { registrarStatusCode: "REGISTERED" },
      });
    } catch {
      acceptRefused = true;
    }
    if (!acceptRefused) fail("a CLOSED publication was resolved by a later acceptance");
    const stillClosed = await pubService.getProductPublication(CHECK_PUBLICATION5);
    if (stillClosed.remediationState !== "CLOSED") fail("the CLOSED state did not hold");
    ok("a CLOSED publication can be neither retried nor accepted");


    // — Submission attempts and receipt binding (Phase 0E.5.3) —
    // 1. Table, uniqueness, and foreign keys.
    const attUnique = await uniqueIndexNames("PublicationSubmissionAttempt");
    if (!attUnique.some((i) => i.includes("submissionAttemptId"))) {
      fail("missing unique PublicationSubmissionAttempt.submissionAttemptId index");
    }
    if (!attUnique.some((i) => i.includes("attemptNumber"))) {
      fail("missing unique (outboxId, attemptNumber) index — one attempt per claim");
    }
    if (
      !hasFk("PublicationSubmissionAttempt", "ProductPublication") ||
      !hasFk("PublicationSubmissionAttempt", "PublicationOutbox")
    ) {
      fail("missing PublicationSubmissionAttempt foreign keys");
    }
    if (!hasFk("RegistrarReceipt", "PublicationSubmissionAttempt")) {
      fail("missing RegistrarReceipt -> PublicationSubmissionAttempt foreign key");
    }
    const rcptAttUnique = await uniqueIndexNames("RegistrarReceipt");
    if (!rcptAttUnique.some((i) => i.includes("submissionAttemptId"))) {
      fail("missing unique RegistrarReceipt.submissionAttemptId index");
    }
    ok("submission-attempt table, unique attempt id, one-attempt-per-claim, and FKs present");

    // Prepare a sixth publication and claim it for the attempt walkthrough.
    const seeded6 = await prepareAndClaim("6", CHECK_PUBLICATION6, CHECK_CAPSULE6, "5");
    const prep6 = seeded6.prep;
    const attemptRow = await db.publicationSubmissionAttempt.findUnique({
      where: { submissionAttemptId: seeded6.attemptId },
    });
    if (!attemptRow) fail("the prepared attempt was not persisted");

    // 2. The attempt binds to the current outbox attemptNumber.
    const claimedOutbox6 = await outboxRepo.getPublicationOutboxById(prep6.outbox.outboxId);
    if (attemptRow!.attemptNumber !== claimedOutbox6.attemptCount) {
      fail("the attempt did not bind to the current outbox attemptCount");
    }
    if (attemptRow!.operation !== "REGISTER") fail("attempt operation is not REGISTER");
    if (attemptRow!.expectedContentHash !== prep6.publication.publishedContentHash) {
      fail("the attempt did not capture the expected content hash");
    }

    // 3-4. The raw lock token is NOT persisted; a one-way hash is.
    const attemptRowText = JSON.stringify(attemptRow, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    );
    if (attemptRowText.includes(seeded6.lockToken)) {
      fail("the raw lock token was persisted on the submission attempt");
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(attemptRow!.claimTokenHash)) {
      fail("claimTokenHash is not a sha256 binding");
    }
    if (attemptRow!.attemptStatus !== "DISPATCHED") fail("the attempt was not dispatched");
    if (attemptRow!.dispatchedAt === null) fail("dispatchedAt was not recorded");
    ok("attempt binds to attemptCount; raw lock token absent; claimTokenHash persisted; dispatched");

    // 6. A wrong token cannot dispatch.
    const seeded7 = await prepareAndClaim("7", CHECK_PUBLICATION7, CHECK_CAPSULE7, "6");
    let wrongTokenRefused = false;
    try {
      await attemptService.markPublicationSubmissionAttemptDispatched({
        submissionAttemptId: seeded7.attemptId,
        lockToken: `mon:lock:${pad26("WRONGTOKEN")}`,
        dispatchedAt: REM_T0,
      });
    } catch {
      wrongTokenRefused = true;
    }
    if (!wrongTokenRefused) fail("a wrong lock token was able to dispatch an attempt");
    ok("a wrong lock token cannot dispatch a submission attempt");

    // 7-8. A receipt binds to the dispatched attempt and marks it answered.
    const boundReceipt = await receiptService.recordRegistrarReceipt({
      receiptId: `mon:rcpt:${pad26("DBCHECKRCPT6")}`,
      publicationId: CHECK_PUBLICATION6,
      submissionAttemptId: seeded6.attemptId,
      registrarRegistrationId: "dbcheck-registration-attempt6",
      registrarId: MONACADO_REGISTRAR_ID,
      nodeId: CHECK_NODE_ANS,
      capsuleId: CHECK_CAPSULE6,
      registeredContentHash: prep6.publication.publishedContentHash,
      receiptStatus: "ACCEPTED",
      registeredAt: REM_T0,
      receivedAt: REM_T0,
      receiptDetails: { registrarStatusCode: "REGISTERED" },
    });
    if (boundReceipt.receipt.submissionAttemptId !== seeded6.attemptId) {
      fail("the receipt did not bind to its submission attempt");
    }
    const answered = await attemptService.getPublicationSubmissionAttempt(seeded6.attemptId);
    if (answered.attemptStatus !== "RECEIPT_RECORDED") {
      fail("the answered attempt did not become RECEIPT_RECORDED");
    }
    ok("receipt binds to the dispatched attempt and marks it RECEIPT_RECORDED");

    // 9-10. A receipt for a PREPARED or ABANDONED attempt is refused.
    const seeded8 = await prepareAndClaim("8", CHECK_PUBLICATION8, CHECK_CAPSULE8, "7");
    const outbox8 = await outboxRepo.getPublicationOutboxById(seeded8.prep.outbox.outboxId);
    void outbox8;
    // Abandon seeded8's dispatched attempt, then try to answer it.
    await attemptService.markPublicationSubmissionAttemptAbandoned({
      submissionAttemptId: seeded8.attemptId,
      abandonedAt: REM_T0,
    });
    let abandonedRefused = false;
    try {
      await receiptService.recordRegistrarReceipt({
        receiptId: `mon:rcpt:${pad26("DBCHECKRCPT8")}`,
        publicationId: CHECK_PUBLICATION8,
        submissionAttemptId: seeded8.attemptId,
        registrarRegistrationId: "dbcheck-registration-abandoned",
        registrarId: MONACADO_REGISTRAR_ID,
        nodeId: CHECK_NODE_ANS,
        capsuleId: CHECK_CAPSULE8,
        registeredContentHash: seeded8.prep.publication.publishedContentHash,
        receiptStatus: "ACCEPTED",
        registeredAt: REM_T0,
        receivedAt: REM_T0,
        receiptDetails: { registrarStatusCode: "REGISTERED" },
      });
    } catch {
      abandonedRefused = true;
    }
    if (!abandonedRefused) fail("a receipt was accepted for an ABANDONED attempt");
    ok("a receipt for an ABANDONED attempt is refused");

    // 11-16. Expired-claim recovery abandons unresolved attempts; a re-claim
    //        creates a higher attemptNumber and a distinct attempt; an
    //        old-attempt receipt cannot resolve the new one.
    //
    // `claimNextPublicationOutbox` takes the next ELIGIBLE item globally, so the
    // earlier walkthrough items are first driven to a terminal state. Otherwise
    // the sweep and re-claim below would pick one of them instead of #9.
    for (const settle of [seeded7, seeded8]) {
      await outboxRepo.markPublicationOutboxDeadLetter({
        outboxId: settle.prep.outbox.outboxId,
        lockToken: settle.lockToken,
        errorCode: "DBCHECK_SETTLED",
        errorSummary: "Settled by db:check so the recovery walkthrough is deterministic.",
      });
    }

    const seeded9 = await prepareAndClaim("9", CHECK_PUBLICATION9, CHECK_CAPSULE9, "8");
    const REC_NOW = "2026-01-20T00:00:00.000Z";
    const swept9 = await outboxRepo.recoverExpiredPublicationOutboxClaims({ now: REC_NOW, limit: 10 });
    if (swept9.recoveredCount < 1) fail("the expired claim was not recovered");
    const abandoned9 = await attemptService.getPublicationSubmissionAttempt(seeded9.attemptId);
    if (abandoned9.attemptStatus !== "ABANDONED") {
      fail("recovery did not abandon the unresolved submission attempt");
    }
    if (abandoned9.abandonedAt === undefined) fail("abandonedAt was not recorded by recovery");

    const reclaim9 = await outboxRepo.claimNextPublicationOutbox({
      now: REC_NOW,
      leaseDurationSeconds: 600,
    });
    if (reclaim9.outbox.attemptCount <= abandoned9.attemptNumber) {
      fail("the re-claim did not increment attemptNumber");
    }
    const attempt9b = await dispatchAttempt(
      CHECK_PUBLICATION9,
      seeded9.prep.outbox.outboxId,
      reclaim9.lockToken,
      REC_NOW,
    );
    if (attempt9b === seeded9.attemptId) fail("the re-claim reused the original attempt id");

    // A receipt naming the OLD abandoned attempt cannot resolve the new one.
    let staleAttemptRefused = false;
    try {
      await receiptService.recordRegistrarReceipt({
        receiptId: `mon:rcpt:${pad26("DBCHECKRCPT9OLD")}`,
        publicationId: CHECK_PUBLICATION9,
        submissionAttemptId: seeded9.attemptId,
        registrarRegistrationId: "dbcheck-registration-stale",
        registrarId: MONACADO_REGISTRAR_ID,
        nodeId: CHECK_NODE_ANS,
        capsuleId: CHECK_CAPSULE9,
        registeredContentHash: seeded9.prep.publication.publishedContentHash,
        receiptStatus: "ACCEPTED",
        registeredAt: REC_NOW,
        receivedAt: REC_NOW,
        receiptDetails: { registrarStatusCode: "REGISTERED" },
      });
    } catch {
      staleAttemptRefused = true;
    }
    if (!staleAttemptRefused) fail("a receipt for the old attempt resolved the newer retry");

    // 15. A matching receipt on the NEW attempt resolves normally.
    const resolved9 = await receiptService.recordRegistrarReceipt({
      receiptId: `mon:rcpt:${pad26("DBCHECKRCPT9NEW")}`,
      publicationId: CHECK_PUBLICATION9,
      submissionAttemptId: attempt9b,
      registrarRegistrationId: "dbcheck-registration-new",
      registrarId: MONACADO_REGISTRAR_ID,
      nodeId: CHECK_NODE_ANS,
      capsuleId: CHECK_CAPSULE9,
      registeredContentHash: seeded9.prep.publication.publishedContentHash,
      receiptStatus: "ACCEPTED",
      registeredAt: REC_NOW,
      receivedAt: REC_NOW,
      receiptDetails: { registrarStatusCode: "REGISTERED" },
    });
    if (resolved9.registrationState !== "ACCEPTED" || resolved9.reconciliationState !== "MATCHED") {
      fail("the receipt on the new attempt did not resolve the publication");
    }

    // 16. Earlier attempts and receipts remain retained.
    const history9 = await attemptService.listPublicationSubmissionAttempts(CHECK_PUBLICATION9);
    if (history9.length !== 2) fail("earlier submission attempts were not retained");
    if (history9[0]?.attemptStatus !== "ABANDONED") fail("the earlier attempt was mutated");
    ok("recovery abandons attempts; re-claim raises attemptNumber; old-attempt receipt refused; new one resolves");

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
  await db.publicationRemediation.deleteMany({
    where: {
      publicationId: {
        in: [CHECK_PUBLICATION, CHECK_PUBLICATION2, CHECK_PUBLICATION3, CHECK_PUBLICATION4, CHECK_PUBLICATION5, CHECK_PUBLICATION6, CHECK_PUBLICATION7, CHECK_PUBLICATION8, CHECK_PUBLICATION9],
      },
    },
  });
  await db.registrarReceipt.deleteMany({
    where: { publicationId: { in: [CHECK_PUBLICATION, CHECK_PUBLICATION2, CHECK_PUBLICATION3, CHECK_PUBLICATION4, CHECK_PUBLICATION5, CHECK_PUBLICATION6, CHECK_PUBLICATION7, CHECK_PUBLICATION8, CHECK_PUBLICATION9] } },
  });
  await db.publicationSubmissionAttempt.deleteMany({
    where: {
      publicationId: {
        in: [CHECK_PUBLICATION, CHECK_PUBLICATION2, CHECK_PUBLICATION3, CHECK_PUBLICATION4, CHECK_PUBLICATION5, CHECK_PUBLICATION6, CHECK_PUBLICATION7, CHECK_PUBLICATION8, CHECK_PUBLICATION9],
      },
    },
  });
  await db.publicationOutbox.deleteMany({
    where: { publicationId: { in: [CHECK_PUBLICATION, CHECK_PUBLICATION2, CHECK_PUBLICATION3, CHECK_PUBLICATION4, CHECK_PUBLICATION5, CHECK_PUBLICATION6, CHECK_PUBLICATION7, CHECK_PUBLICATION8, CHECK_PUBLICATION9] } },
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
