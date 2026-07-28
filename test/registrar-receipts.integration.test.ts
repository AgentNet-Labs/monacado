/**
 * Registrar receipt, reconciliation, and payload-disposal integration tests
 * (Phase 0E.4).
 *
 * Run ONLY against the disposable local MySQL (RUN_DB_TESTS=1). Self-skips
 * otherwise. Never point at production.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ProductSourceRecord } from "../src/contracts/index";
import {
  MONACADO_PUBLISHER_ID,
  canonicalHash,
  finalizeProductCapsule,
  productSourceRecordToCapsuleCandidate,
} from "../src/contracts/index";
import { getPrisma, disconnectPrisma } from "../src/server/db/client";
import { ProductRepository } from "../src/server/product/product-repository";
import {
  MONACADO_REGISTRAR_ID,
  ProductNodeRepository,
} from "../src/server/product/product-node-repository";
import { ProductPublicationService } from "../src/server/product/product-publication-service";
import { PublicationOutboxRepository } from "../src/server/product/publication-outbox-repository";
import { RegistrarReceiptService } from "../src/server/product/registrar-receipt-service";
import { PersistedOutboxContractViolationError } from "../src/server/product/publication-errors";
import {
  InvalidReceiptStateError,
  PersistedReceiptContractViolationError,
  ReceiptConflictError,
  ReceiptPublicationNotFoundError,
} from "../src/server/product/receipt-errors";

const RUN = process.env.RUN_DB_TESTS === "1";
const pad26 = (s: string): string =>
  (s.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const CLAIM_AT = "2026-04-01T00:00:00.000Z";
const REGISTERED_AT = "2026-04-01T01:00:00.000Z";
const RECEIVED_AT = "2026-04-01T01:00:05.000Z";

let n = 0;
function syntheticRecord(): ProductSourceRecord {
  n += 1;
  return {
    sourceRecordId: `mon:srec:${pad26(`R${n}SREC`)}`,
    sourceRecordVersion: "1",
    internalProductId: `mon:product:${pad26(`R${n}PRD`)}`,
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    authority: {
      creatorId: `mon:creator:${pad26(`R${n}CRTR`)}`,
      authorityScope: "product-facts",
      authorizationState: "authorized",
    },
    facts: {
      name: "Receipt fixture product",
      description: "Obviously synthetic Phase 0E.4 fixture.",
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      specifications: { format: "binary" },
      capabilities: ["register"],
      relationships: { creator: `an:node:${pad26(`R${n}CNDE`)}` },
    },
    capsuleSemver: "1.0.0",
    mappingVersion: "0e.4.0.0",
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
const outbox = RUN
  ? new PublicationOutboxRepository(db)
  : (undefined as unknown as PublicationOutboxRepository);
const receipts = RUN
  ? new RegistrarReceiptService(db)
  : (undefined as unknown as RegistrarReceiptService);

interface Prepared {
  record: ProductSourceRecord;
  nodeId: string;
  publicationId: string;
  outboxId: string;
  capsuleId: string;
  publishedContentHash: string;
  payloadHash: string;
  nodePolicy: { ref: string; version: string };
  capsulePolicy: { ref: string; version: string };
  publishedAt: string;
}

let idSeq = 0;

/** Prepare a publication and CLAIM its outbox item, leaving it PROCESSING. */
async function prepareAndClaim(): Promise<Prepared> {
  const record = syntheticRecord();
  await repo.createInitialProductSourceRecord({ record });
  const node = await nodes.issueProductNode({
    nodeId: `an:node:${pad26(`R${n}NODE`)}`,
    internalProductId: record.internalProductId,
    nodeKind: "product",
    nodePolicyRef: "an:policy:node:synthetic-0e4",
    nodePolicyVersion: "1.0.0",
    registrarId: MONACADO_REGISTRAR_ID,
    issuedAt: "2026-01-02T00:00:00.000Z",
  });
  idSeq += 1;
  const nodePolicy = { ref: "an:policy:node:synthetic-0e4", version: "1.0.0" };
  const capsulePolicy = { ref: "an:policy:capsule:synthetic-0e4", version: "1.0.0" };
  const publishedAt = "2026-03-01T00:00:00.000Z";
  const result = await pubs.prepareProductPublication({
    publicationId: `mon:pub:${pad26(`RPUB${idSeq}`)}`,
    internalProductId: record.internalProductId,
    sourceRecordId: record.sourceRecordId,
    sourceRecordVersion: "1",
    nodeId: node.nodeId,
    capsuleId: `an:capsule:${pad26(`RCAP${idSeq}`)}`,
    capsuleSemver: record.capsuleSemver,
    publishedBy: MONACADO_PUBLISHER_ID,
    publishedAt,
    nodePolicy,
    capsulePolicy,
    availableAt: "2026-03-01T00:00:00.000Z",
  });
    // Claims establish a lease (Phase 0E.5.1); a long one keeps these tests
  // about receipts rather than expiry.
  await outbox.claimNextPublicationOutbox({ now: CLAIM_AT, leaseDurationSeconds: 3600 });
  return {
    record,
    nodeId: node.nodeId,
    publicationId: result.publication.publicationId,
    outboxId: result.outbox.outboxId,
    capsuleId: result.publication.capsuleId,
    publishedContentHash: result.publication.publishedContentHash,
    payloadHash: result.outbox.payloadHash,
    nodePolicy,
    capsulePolicy,
    publishedAt,
  };
}

/** A receipt that matches the prepared publication exactly. */
function matchingReceipt(p: Prepared, overrides: Record<string, unknown> = {}) {
  idSeq += 1;
  return {
    receiptId: `mon:rcpt:${pad26(`RCPT${idSeq}`)}`,
    publicationId: p.publicationId,
    registrarRegistrationId: `reg-${idSeq}-synthetic`,
    registrarId: MONACADO_REGISTRAR_ID,
    nodeId: p.nodeId,
    capsuleId: p.capsuleId,
    registeredContentHash: p.publishedContentHash,
    receiptStatus: "ACCEPTED" as const,
    registeredAt: REGISTERED_AT,
    receivedAt: RECEIVED_AT,
    receiptDetails: { registrarStatusCode: "REGISTERED" },
    ...overrides,
  };
}

async function wipe(): Promise<void> {
  await db.registrarReceipt.deleteMany({});
  await db.publicationOutbox.deleteMany({});
  await db.productPublication.deleteMany({});
  await db.productNode.deleteMany({});
  await db.productSourceRecordVersionRow.deleteMany({});
  await db.product.deleteMany({});
}

describe.skipIf(!RUN)("Registrar receipts and reconciliation (integration)", () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await disconnectPrisma();
  });

  it("1,3,4,5,6. a matching accepted receipt registers, matches, completes, and stamps completedAt", async () => {
    const p = await prepareAndClaim();
    const result = await receipts.recordRegistrarReceipt(matchingReceipt(p));

    expect(result.alreadyRecorded).toBe(false);
    expect(result.mismatchedFields).toEqual([]);
    expect(result.registrationState).toBe("ACCEPTED");
    expect(result.reconciliationState).toBe("MATCHED");
    expect(result.publication.registrationState).toBe("ACCEPTED");
    expect(result.publication.reconciliationState).toBe("MATCHED");
    expect(result.outbox.outboxStatus).toBe("COMPLETED");
    expect(result.outbox.completedAt).toBe(RECEIVED_AT);
    expect(result.outbox.lockToken).toBeUndefined();
    expect(result.outbox.lockedAt).toBeUndefined();
    // publicationStatus is a preparation concern and is deliberately untouched.
    expect(result.publication.publicationStatus).toBe("QUEUED");
  });

  it("2. the receipt persists immutably and is readable", async () => {
    const p = await prepareAndClaim();
    const input = matchingReceipt(p);
    const result = await receipts.recordRegistrarReceipt(input);

    const listed = await receipts.listRegistrarReceipts(p.publicationId);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.receiptId).toBe(input.receiptId);
    expect(listed[0]!.registrarRegistrationId).toBe(input.registrarRegistrationId);
    expect(listed[0]!.receiptStatus).toBe("ACCEPTED");
    expect(listed[0]).toEqual(result.receipt);
    // No updatedAt exists on the contract — receipts are write-once.
    expect(Object.keys(listed[0]!)).not.toContain("updatedAt");
  });

  it("7,8,9,10. payload is cleared while hashes, source pointers, and mappingVersion remain", async () => {
    const p = await prepareAndClaim();

    const before = await outbox.getPublicationOutboxById(p.outboxId);
    expect(before.payload).toBeDefined();

    const result = await receipts.recordRegistrarReceipt(matchingReceipt(p));

    expect(result.payloadDisposed).toBe(true);
    expect(result.outbox.payload).toBeUndefined();
    expect(result.outbox.payloadHash).toBe(p.payloadHash);
    expect(result.publication.publishedContentHash).toBe(p.publishedContentHash);
    expect(result.publication.candidateHash).toBeDefined();
    expect(result.publication.sourceRecordId).toBe(p.record.sourceRecordId);
    expect(result.publication.sourceRecordVersion).toBe("1");
    expect(result.publication.mappingVersion).toBe(p.record.mappingVersion);
    expect(result.publication.capsuleSemver).toBe(p.record.capsuleSemver);

    // The row itself is never deleted.
    expect(await db.publicationOutbox.count({ where: { outboxId: p.outboxId } })).toBe(1);
    // A re-read of the disposed row still validates.
    const after = await outbox.getPublicationOutboxById(p.outboxId);
    expect(after.payload).toBeUndefined();
    expect(after.payloadHash).toBe(p.payloadHash);
  });

  it("11. the published capsule regenerates deterministically after disposal", async () => {
    const p = await prepareAndClaim();
    const original = (await outbox.getPublicationOutboxById(p.outboxId)).payload;
    await receipts.recordRegistrarReceipt(matchingReceipt(p));

    const disposed = await outbox.getPublicationOutboxById(p.outboxId);
    expect(disposed.payload).toBeUndefined();

    // Rebuild from RETAINED data only: the immutable source-record version plus
    // the publication's own metadata.
    const publication = await pubs.getProductPublication(p.publicationId);
    const record = await repo.getProductSourceRecordVersion(
      publication.sourceRecordId,
      publication.sourceRecordVersion,
    );
    const rebuilt = finalizeProductCapsule({
      candidate: productSourceRecordToCapsuleCandidate(record),
      capsuleId: publication.capsuleId,
      bindsToNode: publication.nodeId,
      publishedBy: publication.publishedBy,
      publishedAt: publication.publishedAt,
      nodePolicy: { ref: publication.nodePolicyRef, version: publication.nodePolicyVersion },
      capsulePolicy: {
        ref: publication.capsulePolicyRef,
        version: publication.capsulePolicyVersion,
      },
    });

    expect(rebuilt).toEqual(original);
    expect(rebuilt.metadata.contentHash).toBe(publication.publishedContentHash);
    expect(canonicalHash(rebuilt)).toBe(disposed.payloadHash);
  });

  it("12,13,14,15,16,17. any identity or hash mismatch records MISMATCH and retains the payload", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["registrarId", { registrarId: "an:registrar:someone-else" }],
      ["nodeId", { nodeId: `an:node:${pad26("OTHERNODE")}` }],
      ["capsuleId", { capsuleId: `an:capsule:${pad26("OTHERCAP")}` }],
      ["registeredContentHash", { registeredContentHash: `sha256:${"b".repeat(64)}` }],
    ];

    for (const [field, override] of cases) {
      const p = await prepareAndClaim();
      const result = await receipts.recordRegistrarReceipt(matchingReceipt(p, override));

      expect(result.mismatchedFields, field).toEqual([field]);
      expect(result.reconciliationState, field).toBe("MISMATCH");
      expect(result.registrationState, field).not.toBe("ACCEPTED");
      expect(result.registrationState, field).toBe("PENDING");
      // Payload retained; outbox untouched; expected values unchanged.
      expect(result.payloadDisposed, field).toBe(false);
      expect(result.outbox.payload, field).toBeDefined();
      expect(result.outbox.outboxStatus, field).toBe("PROCESSING");
      expect(result.publication.capsuleId, field).toBe(p.capsuleId);
      expect(result.publication.nodeId, field).toBe(p.nodeId);
      expect(result.publication.publishedContentHash, field).toBe(p.publishedContentHash);
    }
  });

  it("R1,R2,R3,R4. a MATCHING rejected receipt: REJECTED / MATCHED / DEAD_LETTER, payload retained", async () => {
    const p = await prepareAndClaim();
    const result = await receipts.recordRegistrarReceipt(
      matchingReceipt(p, {
        receiptStatus: "REJECTED",
        registrarRegistrationId: undefined,
        receiptDetails: {
          rejectionCode: "POLICY_REFUSED",
          rejectionReason: "Capsule policy version is not accepted by this Registrar.",
        },
      }),
    );

    expect(result.mismatchedFields).toEqual([]);
    expect(result.registrationState).toBe("REJECTED");
    expect(result.reconciliationState).toBe("MATCHED");
    expect(result.outbox.outboxStatus).toBe("DEAD_LETTER");
    expect(result.payloadDisposed).toBe(false);
    expect(result.outbox.payload).toBeDefined();
    expect(result.outbox.payloadHash).toBe(p.payloadHash);
    // Bounded rejection details were copied to the safe outbox error fields.
    expect(result.outbox.lastErrorCode).toBe("POLICY_REFUSED");
    expect(result.outbox.lastErrorSummary).toContain("not accepted");
  });

  it("R5-R12. a MISIDENTIFYING rejected receipt cannot mark the publication REJECTED", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["registrarId", { registrarId: "an:registrar:someone-else" }],
      ["nodeId", { nodeId: `an:node:${pad26("REJOTHERNODE")}` }],
      ["capsuleId", { capsuleId: `an:capsule:${pad26("REJOTHERCAP")}` }],
      ["registeredContentHash", { registeredContentHash: `sha256:${"c".repeat(64)}` }],
    ];

    for (const [field, override] of cases) {
      const p = await prepareAndClaim();
      const before = await outbox.getPublicationOutboxById(p.outboxId);

      const result = await receipts.recordRegistrarReceipt(
        matchingReceipt(p, {
          receiptStatus: "REJECTED",
          registrarRegistrationId: undefined,
          receiptDetails: { rejectionCode: "REFUSED", rejectionReason: "Refused." },
          ...override,
        }),
      );

      // The verdict is NOT applied to a publication the receipt does not name.
      expect(result.registrationState, field).not.toBe("REJECTED");
      expect(result.registrationState, field).toBe("PENDING");
      expect(result.reconciliationState, field).toBe("MISMATCH");
      expect(result.mismatchedFields, field).toEqual([field]);

      // The outbox is untouched and the payload retained.
      expect(result.outbox.outboxStatus, field).toBe(before.outboxStatus);
      expect(result.outbox.outboxStatus, field).toBe("PROCESSING");
      expect(result.outbox.lastErrorCode, field).toBeUndefined();
      expect(result.outbox.completedAt, field).toBeUndefined();
      expect(result.payloadDisposed, field).toBe(false);
      expect(result.outbox.payload, field).toBeDefined();
      expect(result.outbox.payloadHash, field).toBe(p.payloadHash);

      // Expected identity and hashes are preserved, never rewritten.
      expect(result.publication.nodeId, field).toBe(p.nodeId);
      expect(result.publication.capsuleId, field).toBe(p.capsuleId);
      expect(result.publication.publishedContentHash, field).toBe(p.publishedContentHash);

      // The receipt itself is retained as immutable mismatch evidence.
      const kept = await receipts.listRegistrarReceipts(p.publicationId);
      expect(kept, field).toHaveLength(1);
      expect(kept[0]!.receiptStatus, field).toBe("REJECTED");
    }
  });

  it("18,19. a rejected receipt records REJECTED, retains the payload, and dead-letters the work", async () => {
    const p = await prepareAndClaim();
    const result = await receipts.recordRegistrarReceipt(
      matchingReceipt(p, {
        receiptStatus: "REJECTED",
        registrarRegistrationId: undefined,
        receiptDetails: {
          rejectionCode: "POLICY_REFUSED",
          rejectionReason: "Capsule policy version is not accepted by this Registrar.",
        },
      }),
    );

    expect(result.registrationState).toBe("REJECTED");
    expect(result.reconciliationState).toBe("MATCHED");
    expect(result.payloadDisposed).toBe(false);
    expect(result.outbox.payload).toBeDefined();
    expect(result.outbox.payloadHash).toBe(p.payloadHash);
    expect(result.outbox.outboxStatus).toBe("DEAD_LETTER");
    expect(result.outbox.completedAt).toBeUndefined();
    expect(result.outbox.lastErrorCode).toBe("POLICY_REFUSED");
    expect(result.receipt.receiptDetails.rejectionReason).toContain("not accepted");
  });

  it("20. an identical receipt replay is idempotent", async () => {
    const p = await prepareAndClaim();
    const input = matchingReceipt(p);
    const first = await receipts.recordRegistrarReceipt(input);
    const second = await receipts.recordRegistrarReceipt(input);

    expect(second.alreadyRecorded).toBe(true);
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
    expect(second.receipt.id).toBe(first.receipt.id);
    expect(await db.registrarReceipt.count()).toBe(1);
    expect(second.registrationState).toBe("ACCEPTED");
    expect(second.outbox.payload).toBeUndefined();
  });

  it("21. a conflicting replay of the same receiptId fails", async () => {
    const p = await prepareAndClaim();
    const input = matchingReceipt(p);
    await receipts.recordRegistrarReceipt(input);
    await expect(
      receipts.recordRegistrarReceipt({ ...input, registeredAt: "2026-05-05T00:00:00.000Z" }),
    ).rejects.toBeInstanceOf(ReceiptConflictError);
    expect(await db.registrarReceipt.count()).toBe(1);
  });

  it("22. a reused registrarRegistrationId on a different receipt fails", async () => {
    const a = await prepareAndClaim();
    const b = await prepareAndClaim();
    const first = matchingReceipt(a);
    await receipts.recordRegistrarReceipt(first);
    await expect(
      receipts.recordRegistrarReceipt(
        matchingReceipt(b, { registrarRegistrationId: first.registrarRegistrationId }),
      ),
    ).rejects.toBeInstanceOf(ReceiptConflictError);
  });

  it("23. a second incompatible accepted receipt fails", async () => {
    const p = await prepareAndClaim();
    await receipts.recordRegistrarReceipt(matchingReceipt(p));
    // A different accepted receipt for the same publication.
    await expect(receipts.recordRegistrarReceipt(matchingReceipt(p))).rejects.toBeInstanceOf(
      ReceiptConflictError,
    );
    expect(await db.registrarReceipt.count()).toBe(1);
  });

  it("23b. an acceptance cannot overwrite a recorded rejection or mismatch", async () => {
    // After a rejection.
    const a = await prepareAndClaim();
    await receipts.recordRegistrarReceipt(
      matchingReceipt(a, { receiptStatus: "REJECTED", registrarRegistrationId: undefined }),
    );
    await expect(receipts.recordRegistrarReceipt(matchingReceipt(a))).rejects.toBeInstanceOf(
      ReceiptConflictError,
    );
    expect((await pubs.getProductPublication(a.publicationId)).registrationState).toBe("REJECTED");

    // After a mismatch.
    const b = await prepareAndClaim();
    await receipts.recordRegistrarReceipt(
      matchingReceipt(b, { capsuleId: `an:capsule:${pad26("OTHERCAP2")}` }),
    );
    await expect(receipts.recordRegistrarReceipt(matchingReceipt(b))).rejects.toBeInstanceOf(
      ReceiptConflictError,
    );
    const pub = await pubs.getProductPublication(b.publicationId);
    expect(pub.reconciliationState).toBe("MISMATCH");
    expect(pub.registrationState).toBe("PENDING");
  });

  it("24,25. receipt and state updates are atomic; a failed call changes nothing", async () => {
    const p = await prepareAndClaim();

    // Force the commit to fail at the receipt insert by pre-taking the unique
    // registrarRegistrationId with a receipt on another publication.
    const other = await prepareAndClaim();
    const taken = matchingReceipt(other);
    await receipts.recordRegistrarReceipt(taken);

    const beforePub = await pubs.getProductPublication(p.publicationId);
    const beforeObx = await outbox.getPublicationOutboxById(p.outboxId);

    await expect(
      receipts.recordRegistrarReceipt(
        matchingReceipt(p, { registrarRegistrationId: taken.registrarRegistrationId }),
      ),
    ).rejects.toBeInstanceOf(ReceiptConflictError);

    // Neither a receipt row nor any state change survived.
    expect(await db.registrarReceipt.count({ where: { publicationId: p.publicationId } })).toBe(0);
    const afterPub = await pubs.getProductPublication(p.publicationId);
    const afterObx = await outbox.getPublicationOutboxById(p.outboxId);
    expect(afterPub.registrationState).toBe(beforePub.registrationState);
    expect(afterPub.reconciliationState).toBe(beforePub.reconciliationState);
    expect(afterObx.outboxStatus).toBe(beforeObx.outboxStatus);
    expect(afterObx.payload).toBeDefined();
  });

  it("26. a null payload in a non-completed state is a contract violation", async () => {
    const p = await prepareAndClaim();
    // The item is PROCESSING; strip its payload behind the service's back.
    await db.$executeRawUnsafe(
      "UPDATE PublicationOutbox SET payload = NULL WHERE outboxId = ?",
      p.outboxId,
    );
    await expect(outbox.getPublicationOutboxById(p.outboxId)).rejects.toBeInstanceOf(
      PersistedOutboxContractViolationError,
    );

    // The same absence in COMPLETED is legitimate (disposed after reconciliation).
    // Leaving PROCESSING also releases the claim lease, so mimic a real
    // transition rather than leaving a lease behind (Phase 0E.5.1).
    await db.$executeRawUnsafe(
      "UPDATE PublicationOutbox SET outboxStatus = 'COMPLETED', lockToken = NULL, lockedAt = NULL, leaseExpiresAt = NULL WHERE outboxId = ?",
      p.outboxId,
    );
    const ok = await outbox.getPublicationOutboxById(p.outboxId);
    expect(ok.payload).toBeUndefined();
  });

  it("27. a retained payload after a matched acceptance is a contract violation", async () => {
    const p = await prepareAndClaim();
    const original = (await outbox.getPublicationOutboxById(p.outboxId)).payload;
    await receipts.recordRegistrarReceipt(matchingReceipt(p));

    // Put the disposed body back: the publication is ACCEPTED + MATCHED, so the
    // capsule body must no longer exist anywhere.
    await db.publicationOutbox.update({
      where: { outboxId: p.outboxId },
      data: { payload: original as object },
    });
    await expect(receipts.assertPayloadDisposed(p.publicationId)).rejects.toBeInstanceOf(
      PersistedOutboxContractViolationError,
    );
  });

  it("28. a payloadHash mismatch still fails while the payload exists", async () => {
    const p = await prepareAndClaim();
    await db.$executeRawUnsafe(
      "UPDATE PublicationOutbox SET payloadHash = ? WHERE outboxId = ?",
      `sha256:${"0".repeat(64)}`,
      p.outboxId,
    );
    await expect(outbox.getPublicationOutboxById(p.outboxId)).rejects.toBeInstanceOf(
      PersistedOutboxContractViolationError,
    );
  });

  it("29. malformed persisted receipt data raises a structured contract violation", async () => {
    const p = await prepareAndClaim();
    const input = matchingReceipt(p);
    await receipts.recordRegistrarReceipt(input);

    await db.$executeRawUnsafe(
      "UPDATE RegistrarReceipt SET receiptStatus = 'not-a-status' WHERE receiptId = ?",
      input.receiptId,
    );
    await expect(receipts.listRegistrarReceipts(p.publicationId)).rejects.toBeInstanceOf(
      PersistedReceiptContractViolationError,
    );
  });

  it("30. errors expose no credentials, payload, lock token, or hash values", async () => {
    const p = await prepareAndClaim();
    const claimed = await db.publicationOutbox.findUnique({ where: { outboxId: p.outboxId } });
    const lockToken = claimed!.lockToken!;

    const input = matchingReceipt(p);
    await receipts.recordRegistrarReceipt(input);
    try {
      await receipts.recordRegistrarReceipt({ ...input, registeredAt: "2026-09-09T00:00:00.000Z" });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as ReceiptConflictError;
      expect(err).toBeInstanceOf(ReceiptConflictError);
      const text = `${JSON.stringify(err)} ${JSON.stringify({ ...err })} ${String(err)}`;
      expect(text).not.toContain("internalCause");
      expect(text).not.toContain(lockToken);
      expect(text).not.toContain(p.publishedContentHash);
      expect(text).not.toContain(p.payloadHash);
      expect(text).not.toContain("@context");
      expect(text).not.toContain("3308");
      expect(text.toLowerCase()).not.toContain("mysql://");
      // Field NAMES are reported, values are not.
      expect(err.conflictingFields).toContain("registeredAt");
    }
  });

  it("31. a receipt for an unknown publication is reported as not found", async () => {
    const p = await prepareAndClaim();
    await expect(
      receipts.recordRegistrarReceipt(
        matchingReceipt(p, { publicationId: `mon:pub:${pad26("NOSUCHPUB")}` }),
      ),
    ).rejects.toBeInstanceOf(ReceiptPublicationNotFoundError);
  });

  it("32. an accepted receipt for an unclaimed item is an invalid receipt state", async () => {
    // Prepare WITHOUT claiming: the outbox item is still PENDING.
    const record = syntheticRecord();
    await repo.createInitialProductSourceRecord({ record });
    const node = await nodes.issueProductNode({
      nodeId: `an:node:${pad26(`R${n}NODE`)}`,
      internalProductId: record.internalProductId,
      nodeKind: "product",
      nodePolicyRef: "an:policy:node:synthetic-0e4",
      nodePolicyVersion: "1.0.0",
      registrarId: MONACADO_REGISTRAR_ID,
      issuedAt: "2026-01-02T00:00:00.000Z",
    });
    idSeq += 1;
    const prep = await pubs.prepareProductPublication({
      publicationId: `mon:pub:${pad26(`RUNC${idSeq}`)}`,
      internalProductId: record.internalProductId,
      sourceRecordId: record.sourceRecordId,
      sourceRecordVersion: "1",
      nodeId: node.nodeId,
      capsuleId: `an:capsule:${pad26(`RUNC${idSeq}`)}`,
      capsuleSemver: record.capsuleSemver,
      publishedBy: MONACADO_PUBLISHER_ID,
      publishedAt: "2026-03-01T00:00:00.000Z",
      nodePolicy: { ref: "an:policy:node:synthetic-0e4", version: "1.0.0" },
      capsulePolicy: { ref: "an:policy:capsule:synthetic-0e4", version: "1.0.0" },
      availableAt: "2026-03-01T00:00:00.000Z",
    });

    await expect(
      receipts.recordRegistrarReceipt({
        receiptId: `mon:rcpt:${pad26(`RUNC${idSeq}`)}`,
        publicationId: prep.publication.publicationId,
        registrarRegistrationId: `reg-unclaimed-${idSeq}`,
        registrarId: MONACADO_REGISTRAR_ID,
        nodeId: node.nodeId,
        capsuleId: prep.publication.capsuleId,
        registeredContentHash: prep.publication.publishedContentHash,
        receiptStatus: "ACCEPTED",
        registeredAt: REGISTERED_AT,
        receivedAt: RECEIVED_AT,
        receiptDetails: { registrarStatusCode: "REGISTERED" },
      }),
    ).rejects.toBeInstanceOf(InvalidReceiptStateError);

    // Nothing changed.
    expect(await db.registrarReceipt.count()).toBe(0);
    const still = await pubs.getProductPublication(prep.publication.publicationId);
    expect(still.registrationState).toBe("NOT_SUBMITTED");
  });

  it("33. receipt details reject credentials and capsule content", async () => {
    const p = await prepareAndClaim();
    for (const details of [
      { rejectionReason: "connect failed for mysql://synthetic-user:PW@198.51.100.7:9999/db" },
      { rejectionReason: 'payload was {"@context":["https://example.com"]}' },
      { rejectionCode: "lowercase_code" },
      { rejectionReason: "x".repeat(257) },
    ]) {
      await expect(
        receipts.recordRegistrarReceipt(
          matchingReceipt(p, { receiptStatus: "REJECTED", registrarRegistrationId: undefined, receiptDetails: details }),
        ),
      ).rejects.toThrow();
    }
    expect(await db.registrarReceipt.count()).toBe(0);
  });

  it("34. an accepted receipt without a registration identifier is rejected", async () => {
    const p = await prepareAndClaim();
    await expect(
      receipts.recordRegistrarReceipt(matchingReceipt(p, { registrarRegistrationId: undefined })),
    ).rejects.toThrow();
    expect(await db.registrarReceipt.count()).toBe(0);
  });

  it("35. prepared publications begin NOT_SUBMITTED / NOT_REQUIRED", async () => {
    const p = await prepareAndClaim();
    const pub = await pubs.getProductPublication(p.publicationId);
    expect(pub.registrationState).toBe("NOT_SUBMITTED");
    expect(pub.reconciliationState).toBe("NOT_REQUIRED");
  });

  it("36. claiming and completing an outbox item never marks registration ACCEPTED", async () => {
    const p = await prepareAndClaim();
    const claimed = await db.publicationOutbox.findUnique({ where: { outboxId: p.outboxId } });
    await outbox.markPublicationOutboxCompleted({
      outboxId: p.outboxId,
      lockToken: claimed!.lockToken!,
      completedAt: "2026-04-02T00:00:00.000Z",
    });
    const pub = await pubs.getProductPublication(p.publicationId);
    expect(pub.registrationState).toBe("NOT_SUBMITTED");
    expect(pub.reconciliationState).toBe("NOT_REQUIRED");
    // Phase 0E.3 completion retains the payload — only a receipt disposes of it.
    const obx = await outbox.getPublicationOutboxById(p.outboxId);
    expect(obx.payload).toBeDefined();
  });
});
