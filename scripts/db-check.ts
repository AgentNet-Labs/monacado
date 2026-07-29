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
import { runOneProductPublication } from "../src/server/product/publication-run-service";
import { ingestRegistrarReceipt } from "../src/server/product/receipt-ingestion-service";
import { runProductPublicationWorkerCycle } from "../src/server/product/publication-worker-cycle-service";
import { main as runPublicationWorkerCommand } from "./run-publication-worker";
import { loadRegistrarRuntimeConfiguration } from "../src/server/registrar/registrar-runtime-config";
import type { RegistrarConfigurationLoad } from "../src/server/registrar/registrar-runtime-config";
import type {
  RegisterRequestEnvelope,
  RegistrarRegisterTransport,
  TransportResult,
} from "../src/contracts/product/registrar-transport";
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
const CHECK_PUBLICATION10 = `mon:pub:${pad26("DBCHECKPUB10")}`;
const CHECK_CAPSULE10 = `an:capsule:${pad26("DBCHECKCAPSULE10")}`;
const CHECK_PUBLICATION11 = `mon:pub:${pad26("DBCHECKPUB11")}`;
const CHECK_CAPSULE11 = `an:capsule:${pad26("DBCHECKCAPSULE11")}`;
const CHECK_PUBLICATION12 = `mon:pub:${pad26("DBCHECKPUB12")}`;
const CHECK_CAPSULE12 = `an:capsule:${pad26("DBCHECKCAPSULE12")}`;
const CHECK_PUBLICATION13 = `mon:pub:${pad26("DBCHECKPUB13")}`;
const CHECK_CAPSULE13 = `an:capsule:${pad26("DBCHECKCAPSULE13")}`;
const CHECK_PUBLICATION14 = `mon:pub:${pad26("DBCHECKPUB14")}`;
const CHECK_CAPSULE14 = `an:capsule:${pad26("DBCHECKCAPSULE14")}`;
const CHECK_PUBLICATION15 = `mon:pub:${pad26("DBCHECKPUB15")}`;
const CHECK_CAPSULE15 = `an:capsule:${pad26("DBCHECKCAPSULE15")}`;
const CHECK_PUBLICATION16 = `mon:pub:${pad26("DBCHECKPUB16")}`;
const CHECK_CAPSULE16 = `an:capsule:${pad26("DBCHECKCAPSULE16")}`;
const CHECK_PUBLICATION17 = `mon:pub:${pad26("DBCHECKPUB17")}`;
const CHECK_CAPSULE17 = `an:capsule:${pad26("DBCHECKCAPSULE17")}`;
const CHECK_PUBLICATION18 = `mon:pub:${pad26("DBCHECKWCPUBA")}`;
const CHECK_CAPSULE18 = `an:capsule:${pad26("DBCHECKWCCAPA")}`;
const CHECK_PUBLICATION19 = `mon:pub:${pad26("DBCHECKWCPUBB")}`;
const CHECK_CAPSULE19 = `an:capsule:${pad26("DBCHECKWCCAPB")}`;
const CHECK_PUBLICATION20 = `mon:pub:${pad26("DBCHECKWCPUBC")}`;
const CHECK_CAPSULE20 = `an:capsule:${pad26("DBCHECKWCCAPC")}`;
const CHECK_PUBLICATION21 = `mon:pub:${pad26("DBCHECKEPPUBA")}`;
const CHECK_CAPSULE21 = `an:capsule:${pad26("DBCHECKEPCAPA")}`;
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

    // — Phase 0E.6.3: single-run publication orchestration —
    //
    // These exercise the WHOLE composed path against real rows: claim, attempt,
    // one injected transport call, and the guarded outcome write. No socket is
    // opened; every transport below is a local fake.

    /** A fake transport that records each call. Nothing leaves the process. */
    class CheckTransport implements RegistrarRegisterTransport {
      calls: RegisterRequestEnvelope[] = [];
      constructor(private readonly result: TransportResult) {}
      async sendRegisterRequest(request: RegisterRequestEnvelope): Promise<TransportResult> {
        this.calls.push(request);
        return this.result;
      }
    }

    const RUN_SECRET_VAR = "MONACADO_DBCHECK_FAKE_TOKEN";
    const runSecretSource = { [RUN_SECRET_VAR]: "fake-dbcheck-token-not-a-real-credential" };
    const runConfiguration = loadRegistrarRuntimeConfiguration({
      MONACADO_REGISTRAR_ENABLED: "true",
      MONACADO_REGISTRAR_ID: MONACADO_REGISTRAR_ID,
      MONACADO_REGISTRAR_ENDPOINT: "https://registrar.example/v1/register",
      MONACADO_REGISTRAR_ALLOWED_ORIGINS: "https://registrar.example",
      MONACADO_REGISTRAR_CREDENTIAL_MODE: "BEARER_ENV",
      MONACADO_REGISTRAR_BEARER_TOKEN_ENV: RUN_SECRET_VAR,
    });
    if (runConfiguration.state !== "READY") fail("the db:check runtime configuration is not READY");

    // The orchestrator claims the globally-next due item, so every earlier
    // walkthrough item must be settled first or it would win the race.
    const stillEligible = await db.publicationOutbox.findMany({
      where: { publicationId: { in: [CHECK_PUBLICATION, CHECK_PUBLICATION2, CHECK_PUBLICATION3, CHECK_PUBLICATION4, CHECK_PUBLICATION5, CHECK_PUBLICATION6, CHECK_PUBLICATION7, CHECK_PUBLICATION8, CHECK_PUBLICATION9] }, outboxStatus: { in: ["PENDING", "RETRYABLE"] } },
    });
    for (const row of stillEligible) {
      await outboxRepo.cancelPublicationOutbox({ outboxId: row.outboxId });
    }

    const RUN_T0 = "2026-02-01T00:00:00.000Z";
    const RUN_PREPARED = "2026-02-01T00:00:01.000Z";
    const RUN_SENT = "2026-02-01T00:00:02.000Z";
    const RUN_RETRY_AT = "2026-02-01T01:00:00.000Z";

    let runSeq = 0;
    const seedForRun = async (
      version: string,
      publicationId: string,
      capsuleId: string,
      priorVersion: string,
    ) => {
      await repo.createProductSourceRecordRevision({
        internalProductId: CHECK_INTERNAL,
        expectedCurrentSourceRecordVersion: priorVersion,
        sourceRecordVersion: version,
        updatedAt: RUN_T0,
        capsuleGeneratedAt: RUN_T0,
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
        publishedAt: RUN_T0,
        nodePolicy: { ref: "an:policy:node:dbcheck", version: "1.0.0" },
        capsulePolicy: { ref: "an:policy:capsule:dbcheck", version: "1.0.0" },
        availableAt: RUN_T0,
      });
      runSeq += 1;
      return {
        outboxId: prep.outbox.outboxId,
        payloadHash: prep.outbox.payloadHash,
        submissionAttemptId: `mon:attempt:${pad26(`DBCHECKRUN${String(runSeq).padStart(3, "0")}`)}`,
      };
    };

    const runOnce = async (
      seeded: { submissionAttemptId: string },
      transport: RegistrarRegisterTransport,
      opts: { retryAvailableAt?: string } = {},
    ) =>
      runOneProductPublication(
        {
          now: RUN_T0,
          leaseDurationSeconds: 600,
          submissionAttemptId: seeded.submissionAttemptId,
          preparedAt: RUN_PREPARED,
          dispatchedAt: RUN_SENT,
          ...opts,
        },
        {
          configuration: runConfiguration,
          secretSource: runSecretSource,
          transportOverride: transport,
          db,
        },
      );

    // 17. A successful send leaves the attempt DISPATCHED and the item PROCESSING,
    //     and creates NO receipt — an accepted response is evidence, not authority.
    const run10 = await seedForRun("10", CHECK_PUBLICATION10, CHECK_CAPSULE10, "9");
    const okTransport = new CheckTransport({ outcome: "SUCCESS", transmitted: true, httpStatus: 200 });
    const result10 = await runOnce(run10, okTransport);
    if (result10.outcome !== "SENT") fail(`a successful send returned ${result10.outcome}`);
    if (result10.outboxId !== run10.outboxId) fail("the run claimed an unexpected outbox item");
    if (okTransport.calls.length !== 1) fail("the transport was not invoked exactly once");
    const attempt10 = await attemptService.getPublicationSubmissionAttempt(run10.submissionAttemptId);
    if (attempt10.attemptStatus !== "DISPATCHED") fail("a successful send did not leave DISPATCHED");
    const row10 = await outboxRepo.getPublicationOutboxById(run10.outboxId);
    if (row10.outboxStatus !== "PROCESSING") fail("a successful send did not leave PROCESSING");
    const receipts10 = await db.registrarReceipt.count({ where: { publicationId: CHECK_PUBLICATION10 } });
    if (receipts10 !== 0) fail("a successful send fabricated a Registrar receipt");
    ok("one run claims one item, sends once, leaves DISPATCHED/PROCESSING, and creates no receipt");

    // 18. A failure proven to precede transmission abandons the attempt and
    //     reschedules, preserving the payload for the retry.
    const run11 = await seedForRun("11", CHECK_PUBLICATION11, CHECK_CAPSULE11, "10");
    const before11 = await outboxRepo.getPublicationOutboxById(run11.outboxId);
    const result11 = await runOnce(
      run11,
      new CheckTransport({
        outcome: "RETRYABLE_TRANSPORT_FAILURE",
        transmitted: false,
        failure: { code: "CONNECTION_FAILED", summary: "The connection was never established" },
      }),
      { retryAvailableAt: RUN_RETRY_AT },
    );
    if (result11.outcome !== "RETRY_SCHEDULED") fail(`a pre-connect failure returned ${result11.outcome}`);
    const attempt11 = await attemptService.getPublicationSubmissionAttempt(run11.submissionAttemptId);
    if (attempt11.attemptStatus !== "ABANDONED") fail("a retryable failure did not abandon the attempt");
    const row11 = await outboxRepo.getPublicationOutboxById(run11.outboxId);
    if (row11.outboxStatus !== "RETRYABLE") fail("a retryable failure did not reschedule the item");
    if (row11.lockToken !== undefined) fail("a retryable failure did not release ownership");
    if (row11.availableAt !== RUN_RETRY_AT) fail("the explicit retry time was not applied");
    if (row11.payloadHash !== before11.payloadHash) fail("the payload hash changed across a retry");
    ok("a pre-delivery failure abandons the attempt, reschedules, releases ownership, and preserves the payload");

    // 19. A terminal failure dead-letters without losing the payload.
    const run12 = await seedForRun("12", CHECK_PUBLICATION12, CHECK_CAPSULE12, "11");
    const before12 = await outboxRepo.getPublicationOutboxById(run12.outboxId);
    const result12 = await runOnce(
      run12,
      new CheckTransport({
        outcome: "TERMINAL_TRANSPORT_FAILURE",
        transmitted: false,
        httpStatus: 400,
        failure: { code: "PROTOCOL_REJECTED", summary: "The request was refused before processing" },
      }),
    );
    if (result12.outcome !== "DEAD_LETTERED") fail(`a terminal failure returned ${result12.outcome}`);
    const row12 = await outboxRepo.getPublicationOutboxById(run12.outboxId);
    if (row12.outboxStatus !== "DEAD_LETTER") fail("a terminal failure did not dead-letter the item");
    if (row12.payloadHash !== before12.payloadHash) fail("the payload hash changed on dead-letter");
    const attempt12 = await attemptService.getPublicationSubmissionAttempt(run12.submissionAttemptId);
    if (attempt12.attemptStatus !== "ABANDONED") fail("a terminal failure did not abandon the attempt");
    ok("a terminal failure dead-letters safely and preserves the payload");

    // 20. Ambiguous delivery holds its ground, and a SECOND invocation does not
    //     resend it — the duplicate-registration guard.
    const run13 = await seedForRun("13", CHECK_PUBLICATION13, CHECK_CAPSULE13, "12");
    const result13 = await runOnce(
      run13,
      new CheckTransport({
        outcome: "AMBIGUOUS_DELIVERY",
        transmitted: true,
        failure: { code: "TIMEOUT", summary: "No response was received before the deadline" },
      }),
    );
    if (result13.outcome !== "AMBIGUOUS_DELIVERY") fail(`an ambiguous send returned ${result13.outcome}`);
    const attempt13 = await attemptService.getPublicationSubmissionAttempt(run13.submissionAttemptId);
    if (attempt13.attemptStatus !== "DISPATCHED") fail("ambiguous delivery did not leave DISPATCHED");
    const row13 = await outboxRepo.getPublicationOutboxById(run13.outboxId);
    if (row13.outboxStatus !== "PROCESSING") fail("ambiguous delivery did not leave PROCESSING");
    if (row13.availableAt !== RUN_T0) fail("ambiguous delivery rescheduled the item");

    const secondTransport = new CheckTransport({ outcome: "SUCCESS", transmitted: true, httpStatus: 200 });
    const secondRun = await runOneProductPublication(
      {
        now: RUN_T0,
        leaseDurationSeconds: 600,
        submissionAttemptId: `mon:attempt:${pad26("DBCHECKRUN099")}`,
        preparedAt: RUN_PREPARED,
        dispatchedAt: RUN_SENT,
      },
      { configuration: runConfiguration, secretSource: runSecretSource, transportOverride: secondTransport, db },
    );
    if (secondRun.outcome !== "NO_ELIGIBLE_WORK") {
      fail(`a second invocation found work it should not have: ${secondRun.outcome}`);
    }
    if (secondTransport.calls.length !== 0) fail("a second invocation resent an ambiguous attempt");
    ok("ambiguous delivery holds DISPATCHED/PROCESSING, reschedules nothing, and is never resent");

    // 21. A disabled configuration never touches the queue.
    const disabledTransport = new CheckTransport({ outcome: "SUCCESS", transmitted: true });
    const disabledRun = await runOneProductPublication(
      {
        now: RUN_T0,
        leaseDurationSeconds: 600,
        submissionAttemptId: `mon:attempt:${pad26("DBCHECKRUN098")}`,
        preparedAt: RUN_PREPARED,
        dispatchedAt: RUN_SENT,
      },
      {
        configuration: loadRegistrarRuntimeConfiguration({}),
        secretSource: runSecretSource,
        transportOverride: disabledTransport,
        db,
      },
    );
    if (disabledRun.outcome !== "DISABLED") fail("a disabled configuration did not return DISABLED");
    if (disabledRun.outboxId !== undefined) fail("a disabled run revealed queue contents");
    if (disabledTransport.calls.length !== 0) fail("a disabled run invoked the transport");
    ok("a disabled Registrar configuration returns without querying or mutating publication work");

    // — Phase 0E.6.4: Registrar receipt ingestion —
    //
    // The externally-supplied receipt path, end to end against real rows. Every
    // authoritative mutation still happens inside the existing receipt service;
    // ingestion only validates the envelope and delegates.

    // Same determinism guard as the orchestration section: claiming takes the
    // globally-next eligible item, and the 0E.6.3 retry scheduled above becomes
    // due before these timestamps, so it would win the claim.
    const stillEligibleForIngestion = await db.publicationOutbox.findMany({
      where: {
        publicationId: {
          in: [CHECK_PUBLICATION, CHECK_PUBLICATION2, CHECK_PUBLICATION3, CHECK_PUBLICATION4, CHECK_PUBLICATION5, CHECK_PUBLICATION6, CHECK_PUBLICATION7, CHECK_PUBLICATION8, CHECK_PUBLICATION9, CHECK_PUBLICATION10, CHECK_PUBLICATION11, CHECK_PUBLICATION12, CHECK_PUBLICATION13],
        },
        outboxStatus: { in: ["PENDING", "RETRYABLE"] },
      },
    });
    for (const row of stillEligibleForIngestion) {
      await outboxRepo.cancelPublicationOutbox({ outboxId: row.outboxId });
    }

    const ING_T0 = "2026-03-01T00:00:00.000Z";
    const ING_SENT = "2026-03-01T00:10:00.000Z";
    const ING_REGISTERED = "2026-03-01T00:15:00.000Z";
    const ING_RECEIVED = "2026-03-01T00:20:00.000Z";

    let ingSeq = 0;
    const seedDispatchedForIngestion = async (
      version: string,
      publicationId: string,
      capsuleId: string,
      priorVersion: string,
    ) => {
      await repo.createProductSourceRecordRevision({
        internalProductId: CHECK_INTERNAL,
        expectedCurrentSourceRecordVersion: priorVersion,
        sourceRecordVersion: version,
        updatedAt: ING_T0,
        capsuleGeneratedAt: ING_T0,
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
        publishedAt: ING_T0,
        nodePolicy: { ref: "an:policy:node:dbcheck", version: "1.0.0" },
        capsulePolicy: { ref: "an:policy:capsule:dbcheck", version: "1.0.0" },
        availableAt: ING_T0,
      });
      const claim = await outboxRepo.claimNextPublicationOutbox({
        now: ING_T0,
        // Comfortably longer than the gap to ING_SENT: a lease of exactly 600s
        // expires at the instant of dispatch, which the guard treats as expired.
        leaseDurationSeconds: 3600,
      });
      if (claim.outbox.outboxId !== prep.outbox.outboxId) {
        fail("db:check claimed an unexpected outbox item during ingestion setup");
      }
      ingSeq += 1;
      const attemptId = `mon:attempt:${pad26(`DBCHECKING${String(ingSeq).padStart(3, "0")}`)}`;
      await attemptService.preparePublicationSubmissionAttempt({
        publicationId,
        outboxId: prep.outbox.outboxId,
        lockToken: claim.lockToken,
        submissionAttemptId: attemptId,
        preparedAt: ING_T0,
      });
      return { prep, attemptId, lockToken: claim.lockToken };
    };

    const dispatchFor = async (seeded: { attemptId: string; lockToken: string }) => {
      await attemptService.markPublicationSubmissionAttemptDispatched({
        submissionAttemptId: seeded.attemptId,
        lockToken: seeded.lockToken,
        dispatchedAt: ING_SENT,
      });
    };

    const ingestionEnvelope = (
      publicationId: string,
      attemptId: string,
      capsuleId: string,
      contentHash: string,
      overrides: Record<string, unknown> = {},
    ) => {
      ingSeq += 1;
      return {
        receiptId: `mon:rcpt:${pad26(`DBCHECKIRC${String(ingSeq).padStart(3, "0")}`)}`,
        submissionAttemptId: attemptId,
        publicationId,
        registrarRegistrationId: `dbcheck-ingest-reg-${ingSeq}`,
        registrarId: MONACADO_REGISTRAR_ID,
        nodeId: CHECK_NODE_ANS,
        capsuleId,
        registeredContentHash: contentHash,
        receiptStatus: "ACCEPTED",
        registeredAt: ING_REGISTERED,
        receiptDetails: { registrarStatusCode: "REGISTERED" },
        ...overrides,
      };
    };

    // 22. A matching acceptance ingested through the new boundary resolves the
    //     publication, and the payload is disposed ONLY at that point.
    const ing14 = await seedDispatchedForIngestion("14", CHECK_PUBLICATION14, CHECK_CAPSULE14, "13");
    await dispatchFor(ing14);
    const beforeDisposal = await outboxRepo.getPublicationOutboxById(ing14.prep.outbox.outboxId);
    if (beforeDisposal.payload === undefined) fail("the payload was disposed before acceptance");
    const envelope14 = ingestionEnvelope(
      CHECK_PUBLICATION14,
      ing14.attemptId,
      CHECK_CAPSULE14,
      ing14.prep.publication.publishedContentHash,
    );
    const ingested14 = await ingestRegistrarReceipt(
      {
        envelope: envelope14,
        receivedAt: ING_RECEIVED,
        source: "MANUAL",
        expectedRegistrarId: MONACADO_REGISTRAR_ID,
      },
      { db },
    );
    if (ingested14.outcome !== "ACCEPTED_MATCHED") {
      fail(`a matching acceptance ingested as ${ingested14.outcome}`);
    }
    if (!ingested14.payloadDisposed) fail("a matched acceptance did not dispose the payload");
    const attempt14 = await attemptService.getPublicationSubmissionAttempt(ing14.attemptId);
    if (attempt14.attemptStatus !== "RECEIPT_RECORDED") fail("ingestion did not answer the attempt");
    const row14 = await outboxRepo.getPublicationOutboxById(ing14.prep.outbox.outboxId);
    if (row14.outboxStatus !== "COMPLETED") fail("ingestion did not complete the work item");
    if (row14.payload !== undefined) fail("the payload survived a matched acceptance");
    if (row14.payloadHash !== beforeDisposal.payloadHash) fail("the payload hash was not retained");
    ok("ingested matching acceptance resolves the publication and disposes the payload only then");

    // 23. An identical replay is idempotent; a conflicting one on the same
    //     receiptId is refused, and neither writes a second row.
    const replayed = await ingestRegistrarReceipt(
      { envelope: envelope14, receivedAt: ING_RECEIVED, source: "MANUAL" },
      { db },
    );
    if (replayed.outcome !== "IDEMPOTENT_REPLAY") {
      fail(`an identical replay reported ${replayed.outcome}`);
    }

    const stateBeforeConflict = await pubService.getProductPublication(CHECK_PUBLICATION14);
    let conflictRefused = false;
    try {
      await ingestRegistrarReceipt(
        {
          envelope: { ...envelope14, registeredAt: "2026-03-02T00:00:00.000Z" },
          receivedAt: ING_RECEIVED,
          source: "MANUAL",
        },
        { db },
      );
    } catch {
      conflictRefused = true;
    }
    if (!conflictRefused) fail("a conflicting replay of the same receiptId was accepted");
    const stateAfterConflict = await pubService.getProductPublication(CHECK_PUBLICATION14);
    if (stateAfterConflict.registrationState !== stateBeforeConflict.registrationState) {
      fail("a refused conflicting replay mutated the publication");
    }
    const receiptsFor14 = await db.registrarReceipt.count({
      where: { publicationId: CHECK_PUBLICATION14 },
    });
    if (receiptsFor14 !== 1) fail("replay handling created more than one receipt");
    ok("identical replay is idempotent, a conflicting replay is refused, and one receipt remains");

    // 24. A mismatched acceptance records evidence and requires remediation
    //     WITHOUT falsely marking the publication accepted.
    const ing15 = await seedDispatchedForIngestion("15", CHECK_PUBLICATION15, CHECK_CAPSULE15, "14");
    await dispatchFor(ing15);
    const ingested15 = await ingestRegistrarReceipt(
      {
        envelope: ingestionEnvelope(
          CHECK_PUBLICATION15,
          ing15.attemptId,
          `an:capsule:${pad26("DBCHECKWRONGCAP")}`,
          ing15.prep.publication.publishedContentHash,
        ),
        receivedAt: ING_RECEIVED,
        source: "MANUAL",
      },
      { db },
    );
    if (ingested15.outcome !== "ACCEPTED_MISMATCH") {
      fail(`a mismatched acceptance ingested as ${ingested15.outcome}`);
    }
    if (ingested15.registrationState === "ACCEPTED") {
      fail("a mismatched acceptance falsely marked the publication ACCEPTED");
    }
    if (ingested15.remediationState !== "REQUIRED") fail("a mismatch did not require remediation");
    const row15 = await outboxRepo.getPublicationOutboxById(ing15.prep.outbox.outboxId);
    if (row15.payload === undefined) fail("a mismatched acceptance disposed the payload");
    ok("ingested mismatched acceptance records evidence, requires remediation, and retains the payload");

    // 25. A matching rejection records evidence and retains the payload.
    const ing16 = await seedDispatchedForIngestion("16", CHECK_PUBLICATION16, CHECK_CAPSULE16, "15");
    await dispatchFor(ing16);
    const ingested16 = await ingestRegistrarReceipt(
      {
        envelope: ingestionEnvelope(
          CHECK_PUBLICATION16,
          ing16.attemptId,
          CHECK_CAPSULE16,
          ing16.prep.publication.publishedContentHash,
          {
            receiptStatus: "REJECTED",
            registrarRegistrationId: undefined,
            receiptDetails: { rejectionCode: "POLICY_REFUSED" },
          },
        ),
        receivedAt: ING_RECEIVED,
        source: "MANUAL",
      },
      { db },
    );
    if (ingested16.outcome !== "REJECTED_MATCHED") {
      fail(`a matching rejection ingested as ${ingested16.outcome}`);
    }
    if (ingested16.remediationState !== "REQUIRED") fail("a rejection did not require remediation");
    const row16 = await outboxRepo.getPublicationOutboxById(ing16.prep.outbox.outboxId);
    if (row16.payload === undefined) fail("a rejection disposed the payload");
    ok("ingested matching rejection records evidence, requires remediation, and retains the payload");

    // 26. A PREPARED (never dispatched) attempt cannot be ingested, and neither
    //     can an ABANDONED one. Neither leaves a receipt behind.
    const ing17 = await seedDispatchedForIngestion("17", CHECK_PUBLICATION17, CHECK_CAPSULE17, "16");
    let preparedRefused = false;
    try {
      await ingestRegistrarReceipt(
        {
          envelope: ingestionEnvelope(
            CHECK_PUBLICATION17,
            ing17.attemptId,
            CHECK_CAPSULE17,
            ing17.prep.publication.publishedContentHash,
          ),
          receivedAt: ING_RECEIVED,
          source: "MANUAL",
        },
        { db },
      );
    } catch {
      preparedRefused = true;
    }
    if (!preparedRefused) fail("a PREPARED attempt accepted a receipt");

    await attemptService.markPublicationSubmissionAttemptAbandoned({
      submissionAttemptId: ing17.attemptId,
      abandonedAt: ING_SENT,
    });
    let ingestAbandonedRefused = false;
    try {
      await ingestRegistrarReceipt(
        {
          envelope: ingestionEnvelope(
            CHECK_PUBLICATION17,
            ing17.attemptId,
            CHECK_CAPSULE17,
            ing17.prep.publication.publishedContentHash,
          ),
          receivedAt: ING_RECEIVED,
          source: "MANUAL",
        },
        { db },
      );
    } catch {
      ingestAbandonedRefused = true;
    }
    if (!ingestAbandonedRefused) fail("an ABANDONED attempt accepted a receipt");
    const receiptsFor17 = await db.registrarReceipt.count({
      where: { publicationId: CHECK_PUBLICATION17 },
    });
    if (receiptsFor17 !== 0) fail("a refused ingestion still wrote a receipt");
    ok("PREPARED and ABANDONED attempts are both refused, leaving no receipt");

    // — Phase 0E.7.1: bounded publication worker cycle —
    //
    // The composed cycle against real rows: bounded runs, stop conditions,
    // shutdown, one-time recovery, and the guarantee that ambiguous work is not
    // resent. Every transport is an in-process fake; no socket is opened.

    class CycleTransport implements RegistrarRegisterTransport {
      calls: RegisterRequestEnvelope[] = [];
      constructor(private readonly results: TransportResult[]) {}
      async sendRegisterRequest(request: RegisterRequestEnvelope): Promise<TransportResult> {
        this.calls.push(request);
        return this.results[Math.min(this.calls.length - 1, this.results.length - 1)]!;
      }
    }

    const CYC_T0 = "2026-04-01T00:00:00.000Z";
    let cycClock = Date.parse(CYC_T0);
    const cycTime = {
      now: () => {
        const value = new Date(cycClock);
        cycClock += 1_000;
        return value;
      },
    };
    let cycIdSeq = 0;
    const cycAttemptIds = {
      nextSubmissionAttemptId: () => {
        cycIdSeq += 1;
        return `mon:attempt:${pad26(`DBCHECKCYC${String(cycIdSeq).padStart(3, "0")}`)}`;
      },
    };
    const cycRetry = {
      nextRetryAvailableAt: ({ attemptedAt }: { attemptedAt: Date }) =>
        new Date(attemptedAt.getTime() + 3_600_000),
    };
    const neverShutdown = { isShutdownRequested: () => false };

    const cycConfiguration = loadRegistrarRuntimeConfiguration({
      MONACADO_REGISTRAR_ENABLED: "true",
      MONACADO_REGISTRAR_ID: MONACADO_REGISTRAR_ID,
      MONACADO_REGISTRAR_ENDPOINT: "https://registrar.example/v1/register",
      MONACADO_REGISTRAR_ALLOWED_ORIGINS: "https://registrar.example",
      MONACADO_REGISTRAR_CREDENTIAL_MODE: "BEARER_ENV",
      MONACADO_REGISTRAR_BEARER_TOKEN_ENV: RUN_SECRET_VAR,
    });
    if (cycConfiguration.state !== "READY") fail("the db:check cycle configuration is not READY");

    // Same determinism guard as before: drain anything still eligible so the
    // cycle claims only the items seeded for it.
    const eligibleBeforeCycle = await db.publicationOutbox.findMany({
      where: {
        publicationId: {
          in: [CHECK_PUBLICATION, CHECK_PUBLICATION2, CHECK_PUBLICATION3, CHECK_PUBLICATION4, CHECK_PUBLICATION5, CHECK_PUBLICATION6, CHECK_PUBLICATION7, CHECK_PUBLICATION8, CHECK_PUBLICATION9, CHECK_PUBLICATION10, CHECK_PUBLICATION11, CHECK_PUBLICATION12, CHECK_PUBLICATION13, CHECK_PUBLICATION14, CHECK_PUBLICATION15, CHECK_PUBLICATION16, CHECK_PUBLICATION17],
        },
        outboxStatus: { in: ["PENDING", "RETRYABLE"] },
      },
    });
    for (const row of eligibleBeforeCycle) {
      await outboxRepo.cancelPublicationOutbox({ outboxId: row.outboxId });
    }

    const seedForCycle = async (
      version: string,
      publicationId: string,
      capsuleId: string,
      priorVersion: string,
    ) => {
      await repo.createProductSourceRecordRevision({
        internalProductId: CHECK_INTERNAL,
        expectedCurrentSourceRecordVersion: priorVersion,
        sourceRecordVersion: version,
        updatedAt: CYC_T0,
        capsuleGeneratedAt: CYC_T0,
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
        publishedAt: CYC_T0,
        nodePolicy: { ref: "an:policy:node:dbcheck", version: "1.0.0" },
        capsulePolicy: { ref: "an:policy:capsule:dbcheck", version: "1.0.0" },
        availableAt: CYC_T0,
      });
      return prep;
    };

    const runCycle = (
      opts: {
        maximumRuns: number;
        transport: RegistrarRegisterTransport;
        shutdown?: { isShutdownRequested(): boolean };
        recovery?: { limit: number; availableAt?: string };
        configuration?: RegistrarConfigurationLoad;
      },
    ) =>
      runProductPublicationWorkerCycle(
        {
          cycleStartedAt: CYC_T0,
          maximumRuns: opts.maximumRuns,
          leaseDurationSeconds: 3600,
          ...(opts.recovery !== undefined ? { recovery: opts.recovery } : {}),
        },
        {
          configuration: opts.configuration ?? cycConfiguration,
          secretSource: runSecretSource,
          time: cycTime,
          attemptIds: cycAttemptIds,
          retryTiming: cycRetry,
          shutdown: opts.shutdown ?? neverShutdown,
          transportOverride: opts.transport,
          db,
        },
      );

    // 27. A disabled cycle mutates nothing and never reaches the queue.
    const cyc18 = await seedForCycle("18", CHECK_PUBLICATION18, CHECK_CAPSULE18, "17");
    const disabledTransportCyc = new CycleTransport([{ outcome: "SUCCESS", transmitted: true }]);
    const disabledCycle = await runCycle({
      maximumRuns: 3,
      transport: disabledTransportCyc,
      configuration: loadRegistrarRuntimeConfiguration({}),
    });
    if (disabledCycle.outcome !== "DISABLED") fail("a disabled cycle did not return DISABLED");
    if (disabledCycle.runsAttempted !== 0) fail("a disabled cycle attempted a run");
    if (disabledTransportCyc.calls.length !== 0) fail("a disabled cycle invoked the transport");
    const row18Before = await outboxRepo.getPublicationOutboxById(cyc18.outbox.outboxId);
    if (row18Before.outboxStatus !== "PENDING") fail("a disabled cycle mutated the queue");
    ok("a disabled worker cycle performs no queue access or mutation");

    // 28. A bounded cycle processes two eligible items but never more than
    //     maximumRuns, and creates no receipt.
    const cyc19 = await seedForCycle("19", CHECK_PUBLICATION19, CHECK_CAPSULE19, "18");
    const boundedTransport = new CycleTransport([{ outcome: "SUCCESS", transmitted: true, httpStatus: 200 }]);
    // Recovery is deliberately NOT enabled here: at CYC_T0 the earlier sections'
    // leases have expired, so a sweep would legitimately reclaim their items and
    // the cycle would claim those instead of the two seeded for this check.
    // Recovery reporting is asserted separately below.
    const bounded = await runCycle({ maximumRuns: 2, transport: boundedTransport });
    if (bounded.runsAttempted > 2) fail("the cycle exceeded maximumRuns");
    if (boundedTransport.calls.length !== 2) fail("the cycle did not process both eligible items");
    if (bounded.outcomeCounts.SENT !== 2) fail("the cycle did not aggregate both sends");
    if (bounded.recovery !== undefined) fail("recovery ran though it was not requested");
    for (const id of [cyc18.outbox.outboxId, cyc19.outbox.outboxId]) {
      const row = await outboxRepo.getPublicationOutboxById(id);
      if (row.outboxStatus !== "PROCESSING") fail("a sent item did not remain PROCESSING");
    }
    const receiptsAfterCycle = await db.registrarReceipt.count({
      where: { publicationId: { in: [CHECK_PUBLICATION18, CHECK_PUBLICATION19] } },
    });
    if (receiptsAfterCycle !== 0) fail("the worker cycle created a Registrar receipt");
    ok("a bounded cycle processes two items within maximumRuns and creates no receipt");

    // 28b. When recovery IS requested it runs once and reports only safe counts.
    const recoveryTransport = new CycleTransport([{ outcome: "SUCCESS", transmitted: true, httpStatus: 200 }]);
    const recoveryCycle = await runCycle({
      maximumRuns: 1,
      transport: recoveryTransport,
      recovery: { limit: 10, availableAt: CYC_T0 },
    });
    if (recoveryCycle.recovery === undefined) fail("recovery counts were not reported when requested");
    const recoveryKeys = Object.keys(recoveryCycle.recovery).sort().join(",");
    if (recoveryKeys !== "examined,recoveredCount,skippedCount") {
      fail(`recovery reported unexpected fields: ${recoveryKeys}`);
    }
    ok("requested recovery reports exactly the safe counts and nothing else");

    // 29. Shutdown before the first run prevents any work, and a cycle over an
    //     empty queue stops on NO_ELIGIBLE_WORK rather than polling.
    const shutdownTransport = new CycleTransport([{ outcome: "SUCCESS", transmitted: true }]);
    const shutdownCycle = await runCycle({
      maximumRuns: 5,
      transport: shutdownTransport,
      shutdown: { isShutdownRequested: () => true },
    });
    if (shutdownCycle.outcome !== "SHUTDOWN_REQUESTED") {
      fail(`shutdown produced ${shutdownCycle.outcome}`);
    }
    if (shutdownCycle.runsAttempted !== 0) fail("shutdown did not prevent the first run");
    if (shutdownTransport.calls.length !== 0) fail("shutdown still invoked the transport");

    // The recovery sweep above legitimately made earlier items eligible again,
    // so drain once more to assert the genuinely-empty-queue behaviour.
    const eligibleBeforeDrain = await db.publicationOutbox.findMany({
      where: {
        publicationId: {
          in: [CHECK_PUBLICATION, CHECK_PUBLICATION2, CHECK_PUBLICATION3, CHECK_PUBLICATION4, CHECK_PUBLICATION5, CHECK_PUBLICATION6, CHECK_PUBLICATION7, CHECK_PUBLICATION8, CHECK_PUBLICATION9, CHECK_PUBLICATION10, CHECK_PUBLICATION11, CHECK_PUBLICATION12, CHECK_PUBLICATION13, CHECK_PUBLICATION14, CHECK_PUBLICATION15, CHECK_PUBLICATION16, CHECK_PUBLICATION17, CHECK_PUBLICATION18, CHECK_PUBLICATION19, CHECK_PUBLICATION20],
        },
        outboxStatus: { in: ["PENDING", "RETRYABLE"] },
      },
    });
    for (const row of eligibleBeforeDrain) {
      await outboxRepo.cancelPublicationOutbox({ outboxId: row.outboxId });
    }

    const drainedTransport = new CycleTransport([{ outcome: "SUCCESS", transmitted: true }]);
    const drained = await runCycle({ maximumRuns: 5, transport: drainedTransport });
    if (!drained.stoppedForNoWork) fail("the cycle did not stop for an empty queue");
    if (drainedTransport.calls.length !== 0) fail("an empty queue still invoked the transport");
    ok("shutdown prevents the next run, and an empty queue stops the cycle without polling");

    // 30. An ambiguous first item is never resent, while a later eligible item
    //     still processes in the same bounded cycle.
    const cyc20 = await seedForCycle("20", CHECK_PUBLICATION20, CHECK_CAPSULE20, "19");
    const ambiguousTransport = new CycleTransport([
      { outcome: "AMBIGUOUS_DELIVERY", transmitted: true, failure: { code: "TIMEOUT", summary: "No response before the deadline" } },
    ]);
    const ambiguousCycle = await runCycle({ maximumRuns: 3, transport: ambiguousTransport });
    if (ambiguousCycle.outcomeCounts.AMBIGUOUS_DELIVERY !== 1) {
      fail("the ambiguous outcome was not aggregated");
    }
    if (ambiguousTransport.calls.length !== 1) fail("ambiguous work was resent within the cycle");
    const row20 = await outboxRepo.getPublicationOutboxById(cyc20.outbox.outboxId);
    if (row20.outboxStatus !== "PROCESSING") fail("ambiguous work did not remain PROCESSING");
    if (row20.availableAt !== CYC_T0) fail("ambiguous work was rescheduled");
    ok("ambiguous work is held and never resent inside a bounded cycle");

    // 31. The Phase 0E.7.2 command end to end: one invocation, one bounded cycle.
    //
    // The command owns configuration validation, signal handling, output, and
    // cleanup. Here it drives real rows through a fake transport, so the whole
    // process lifecycle is exercised without a socket. db:check keeps ownership of
    // the Prisma client, so `disconnect` is a no-op.

    const commandLines: string[] = [];
    const commandSink = {
      writeLine: (_stream: "stdout" | "stderr", line: string): void => {
        commandLines.push(line);
      },
    };
    const commandState = { dbCreations: 0 };
    const dbCreations = (): number => commandState.dbCreations;
    const commandEnv = (overrides: Record<string, string | undefined> = {}) => ({
      MONACADO_PUBLICATION_WORKER_ENABLED: "true",
      MONACADO_PUBLICATION_WORKER_MAX_RUNS: "2",
      MONACADO_PUBLICATION_WORKER_LEASE_SECONDS: "3600",
      MONACADO_PUBLICATION_WORKER_RETRY_DELAY_SECONDS: "900",
      MONACADO_REGISTRAR_ENABLED: "true",
      MONACADO_REGISTRAR_ID: MONACADO_REGISTRAR_ID,
      MONACADO_REGISTRAR_ENDPOINT: "https://registrar.example/v1/register",
      MONACADO_REGISTRAR_ALLOWED_ORIGINS: "https://registrar.example",
      MONACADO_REGISTRAR_CREDENTIAL_MODE: "BEARER_ENV",
      MONACADO_REGISTRAR_BEARER_TOKEN_ENV: RUN_SECRET_VAR,
      ...overrides,
    });
    const runCommand = (
      env: Record<string, string | undefined>,
      transport: RegistrarRegisterTransport,
    ) =>
      runPublicationWorkerCommand({
        env,
        secretSource: runSecretSource,
        sink: commandSink,
        exitCodeTarget: { exitCode: -1 },
        time: cycTime,
        attemptIds: cycAttemptIds,
        createDb: () => {
          commandState.dbCreations += 1;
          return db;
        },
        // db:check owns the client for the rest of its run.
        disconnect: async () => {},
        transportOverride: transport,
        cycleId: "dbcheck-once",
      });

    // 31a. A disabled command reaches neither the queue nor the database.
    const cyc21 = await seedForCycle("21", CHECK_PUBLICATION21, CHECK_CAPSULE21, "20");
    const disabledCommandTransport = new CycleTransport([{ outcome: "SUCCESS", transmitted: true }]);
    const disabledCommand = await runCommand(
      commandEnv({ MONACADO_PUBLICATION_WORKER_ENABLED: "false" }),
      disabledCommandTransport,
    );
    if (disabledCommand.status !== "DISABLED") fail("a disabled command did not report DISABLED");
    if (disabledCommand.exitCode !== 0) fail("a disabled command did not exit 0");
    if (dbCreations() !== 0) fail("a disabled command created a database client");
    if (disabledCommandTransport.calls.length !== 0) fail("a disabled command sent a request");
    const row21Before = await outboxRepo.getPublicationOutboxById(cyc21.outbox.outboxId);
    if (row21Before.outboxStatus !== "PENDING") fail("a disabled command mutated the queue");
    ok("the worker command is disabled by default and leaves the queue untouched");

    // 31b. An enabled command runs exactly one bounded cycle, and no more.
    const signalsBefore =
      process.listenerCount("SIGTERM") + process.listenerCount("SIGINT");
    const receipts21Before = await db.registrarReceipt.count({
      where: { publicationId: CHECK_PUBLICATION21 },
    });
    const commandTransport = new CycleTransport([{ outcome: "SUCCESS", transmitted: true }]);
    const enabledCommand = await runCommand(commandEnv(), commandTransport);

    if (enabledCommand.status !== "CYCLE_FINISHED") fail("the command did not finish a cycle");
    if (enabledCommand.exitCode !== 0) fail("a coherent command did not exit 0");
    if (dbCreations() !== 1) fail("the command did not create exactly one client");
    if (enabledCommand.cycle === undefined) fail("the command emitted no cycle result");
    if (enabledCommand.cycle.runsAttempted > 2) fail("the command exceeded maximumRuns");
    if (enabledCommand.cycle.itemsClaimed !== 1) fail("the command did not process one item");
    if (commandTransport.calls.length !== 1) fail("the command sent more than one request");
    const row21After = await outboxRepo.getPublicationOutboxById(cyc21.outbox.outboxId);
    if (row21After.outboxStatus !== "PROCESSING") fail("the sent item did not stay PROCESSING");
    ok("the worker command runs exactly one bounded cycle within maximumRuns");

    // 31c. No receipt is created, no listener survives, and the output is safe.
    const receipts21After = await db.registrarReceipt.count({
      where: { publicationId: CHECK_PUBLICATION21 },
    });
    if (receipts21After !== receipts21Before) fail("the command created a receipt automatically");
    if (process.listenerCount("SIGTERM") + process.listenerCount("SIGINT") !== signalsBefore) {
      fail("the command left a signal listener installed");
    }
    if (commandLines.length === 0) fail("the command emitted no monitoring output");
    for (const line of commandLines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail("the command emitted a line that is not JSON");
      }
      if (typeof parsed !== "object" || parsed === null || !("event" in parsed)) {
        fail("the command emitted a line without an event name");
      }
      for (const forbidden of [
        RUN_SECRET_VAR,
        runSecretSource[RUN_SECRET_VAR]!,
        "registrar.example",
        "mon:lock:",
        "Bearer",
        "mysql://",
      ]) {
        if (line.includes(forbidden)) fail("the command leaked sensitive material to its output");
      }
    }
    ok("the command creates no receipt, leaks nothing, and leaves no listener behind");

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
        in: [CHECK_PUBLICATION, CHECK_PUBLICATION2, CHECK_PUBLICATION3, CHECK_PUBLICATION4, CHECK_PUBLICATION5, CHECK_PUBLICATION6, CHECK_PUBLICATION7, CHECK_PUBLICATION8, CHECK_PUBLICATION9, CHECK_PUBLICATION10, CHECK_PUBLICATION11, CHECK_PUBLICATION12, CHECK_PUBLICATION13, CHECK_PUBLICATION14, CHECK_PUBLICATION15, CHECK_PUBLICATION16, CHECK_PUBLICATION17, CHECK_PUBLICATION18, CHECK_PUBLICATION19, CHECK_PUBLICATION20, CHECK_PUBLICATION21],
      },
    },
  });
  await db.registrarReceipt.deleteMany({
    where: { publicationId: { in: [CHECK_PUBLICATION, CHECK_PUBLICATION2, CHECK_PUBLICATION3, CHECK_PUBLICATION4, CHECK_PUBLICATION5, CHECK_PUBLICATION6, CHECK_PUBLICATION7, CHECK_PUBLICATION8, CHECK_PUBLICATION9, CHECK_PUBLICATION10, CHECK_PUBLICATION11, CHECK_PUBLICATION12, CHECK_PUBLICATION13, CHECK_PUBLICATION14, CHECK_PUBLICATION15, CHECK_PUBLICATION16, CHECK_PUBLICATION17, CHECK_PUBLICATION18, CHECK_PUBLICATION19, CHECK_PUBLICATION20, CHECK_PUBLICATION21] } },
  });
  await db.publicationSubmissionAttempt.deleteMany({
    where: {
      publicationId: {
        in: [CHECK_PUBLICATION, CHECK_PUBLICATION2, CHECK_PUBLICATION3, CHECK_PUBLICATION4, CHECK_PUBLICATION5, CHECK_PUBLICATION6, CHECK_PUBLICATION7, CHECK_PUBLICATION8, CHECK_PUBLICATION9, CHECK_PUBLICATION10, CHECK_PUBLICATION11, CHECK_PUBLICATION12, CHECK_PUBLICATION13, CHECK_PUBLICATION14, CHECK_PUBLICATION15, CHECK_PUBLICATION16, CHECK_PUBLICATION17, CHECK_PUBLICATION18, CHECK_PUBLICATION19, CHECK_PUBLICATION20, CHECK_PUBLICATION21],
      },
    },
  });
  await db.publicationOutbox.deleteMany({
    where: { publicationId: { in: [CHECK_PUBLICATION, CHECK_PUBLICATION2, CHECK_PUBLICATION3, CHECK_PUBLICATION4, CHECK_PUBLICATION5, CHECK_PUBLICATION6, CHECK_PUBLICATION7, CHECK_PUBLICATION8, CHECK_PUBLICATION9, CHECK_PUBLICATION10, CHECK_PUBLICATION11, CHECK_PUBLICATION12, CHECK_PUBLICATION13, CHECK_PUBLICATION14, CHECK_PUBLICATION15, CHECK_PUBLICATION16, CHECK_PUBLICATION17, CHECK_PUBLICATION18, CHECK_PUBLICATION19, CHECK_PUBLICATION20, CHECK_PUBLICATION21] } },
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
