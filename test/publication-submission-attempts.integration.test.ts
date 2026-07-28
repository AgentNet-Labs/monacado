/**
 * Publication submission-attempt and receipt-binding integration tests
 * (Phase 0E.5.3).
 *
 * Run ONLY against the disposable local MySQL (RUN_DB_TESTS=1). Self-skips
 * otherwise. Never point at production.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ProductSourceRecord } from "../src/contracts/index";
import { MONACADO_PUBLISHER_ID, tokenBindingHash } from "../src/contracts/index";
import { getPrisma, disconnectPrisma } from "../src/server/db/client";
import { ProductRepository } from "../src/server/product/product-repository";
import {
  MONACADO_REGISTRAR_ID,
  ProductNodeRepository,
} from "../src/server/product/product-node-repository";
import { ProductPublicationService } from "../src/server/product/product-publication-service";
import { PublicationOutboxRepository } from "../src/server/product/publication-outbox-repository";
import { RegistrarReceiptService } from "../src/server/product/registrar-receipt-service";
import { PublicationRemediationService } from "../src/server/product/publication-remediation-service";
import { PublicationSubmissionAttemptService } from "../src/server/product/submission-attempt-service";
import { ValidationError } from "../src/server/product/errors";
import { PublicationClosedError, PublicationResolvedError } from "../src/server/product/remediation-errors";
import {
  AttemptAbandonedError,
  AttemptAlreadyExistsForClaimError,
  AttemptAlreadyHasReceiptError,
  AttemptNotDispatchedError,
  AttemptReplayConflictError,
  ClaimLeaseExpiredError,
  ClaimNoLongerOwnedError,
  ClaimTokenHashMismatchError,
  PersistedAttemptContractViolationError,
  ReceiptAttemptMismatchError,
  SubmissionAttemptNotFoundError,
} from "../src/server/product/submission-attempt-errors";

const RUN = process.env.RUN_DB_TESTS === "1";
const pad26 = (s: string): string =>
  (s.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const AVAILABLE_AT = "2026-07-01T00:00:00.000Z";
const CLAIM_AT = "2026-07-01T01:00:00.000Z";
const LEASE_SECONDS = 3600;
/** Within the lease. */
const SEND_AT = "2026-07-01T01:10:00.000Z";
/** Long after the lease expires. */
const AFTER_LEASE = "2026-07-01T05:00:00.000Z";

let n = 0;
function syntheticRecord(): ProductSourceRecord {
  n += 1;
  return {
    sourceRecordId: `mon:srec:${pad26(`S${n}SREC`)}`,
    sourceRecordVersion: "1",
    internalProductId: `mon:product:${pad26(`S${n}PRD`)}`,
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    authority: {
      creatorId: `mon:creator:${pad26(`S${n}CRTR`)}`,
      authorityScope: "product-facts",
      authorizationState: "authorized",
    },
    facts: {
      name: "Submission attempt fixture product",
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      relationships: { creator: `an:node:${pad26(`S${n}CNDE`)}` },
    },
    capsuleSemver: "1.0.0",
    mappingVersion: "0e.5.3.0",
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
const remediation = RUN
  ? new PublicationRemediationService(db)
  : (undefined as unknown as PublicationRemediationService);
const attempts = RUN
  ? new PublicationSubmissionAttemptService(db)
  : (undefined as unknown as PublicationSubmissionAttemptService);

interface Seeded {
  publicationId: string;
  outboxId: string;
  nodeId: string;
  capsuleId: string;
  publishedContentHash: string;
  payloadHash: string;
}

let idSeq = 0;
const nextAttemptId = () => {
  idSeq += 1;
  // Fixed-width: pad26 truncates, so an unpadded counter would collide at 10.
  return `mon:attempt:${pad26(`SATT${String(idSeq).padStart(3, "0")}`)}`;
};

/** Prepare a publication; the outbox item is PENDING and due. */
async function seed(): Promise<Seeded> {
  const record = syntheticRecord();
  await repo.createInitialProductSourceRecord({ record });
  const node = await nodes.issueProductNode({
    nodeId: `an:node:${pad26(`S${n}NODE`)}`,
    internalProductId: record.internalProductId,
    nodeKind: "product",
    nodePolicyRef: "an:policy:node:synthetic-0e53",
    nodePolicyVersion: "1.0.0",
    registrarId: MONACADO_REGISTRAR_ID,
    issuedAt: "2026-01-02T00:00:00.000Z",
  });
  idSeq += 1;
  const result = await pubs.prepareProductPublication({
    publicationId: `mon:pub:${pad26(`SPUB${String(idSeq).padStart(3, "0")}`)}`,
    internalProductId: record.internalProductId,
    sourceRecordId: record.sourceRecordId,
    sourceRecordVersion: "1",
    nodeId: node.nodeId,
    capsuleId: `an:capsule:${pad26(`SCAP${String(idSeq).padStart(3, "0")}`)}`,
    capsuleSemver: record.capsuleSemver,
    publishedBy: MONACADO_PUBLISHER_ID,
    publishedAt: "2026-03-01T00:00:00.000Z",
    nodePolicy: { ref: "an:policy:node:synthetic-0e53", version: "1.0.0" },
    capsulePolicy: { ref: "an:policy:capsule:synthetic-0e53", version: "1.0.0" },
    availableAt: AVAILABLE_AT,
  });
  return {
    publicationId: result.publication.publicationId,
    outboxId: result.outbox.outboxId,
    nodeId: node.nodeId,
    capsuleId: result.publication.capsuleId,
    publishedContentHash: result.publication.publishedContentHash,
    payloadHash: result.outbox.payloadHash,
  };
}

/** Seed and claim, returning the live lock token. */
async function seedAndClaim(): Promise<Seeded & { lockToken: string }> {
  const s = await seed();
  const claimed = await outbox.claimNextPublicationOutbox({
    now: CLAIM_AT,
    leaseDurationSeconds: LEASE_SECONDS,
  });
  expect(claimed.outbox.outboxId).toBe(s.outboxId);
  return { ...s, lockToken: claimed.lockToken };
}

/** Seed, claim, prepare and dispatch one attempt. */
async function seedDispatched() {
  const s = await seedAndClaim();
  const submissionAttemptId = nextAttemptId();
  await attempts.preparePublicationSubmissionAttempt({
    publicationId: s.publicationId,
    outboxId: s.outboxId,
    lockToken: s.lockToken,
    submissionAttemptId,
    preparedAt: CLAIM_AT,
  });
  await attempts.markPublicationSubmissionAttemptDispatched({
    submissionAttemptId,
    lockToken: s.lockToken,
    dispatchedAt: SEND_AT,
  });
  return { ...s, submissionAttemptId };
}

function receiptFor(
  s: { publicationId: string; nodeId: string; capsuleId: string; publishedContentHash: string },
  submissionAttemptId: string,
  overrides: Record<string, unknown> = {},
) {
  idSeq += 1;
  return {
    receiptId: `mon:rcpt:${pad26(`SRCPT${String(idSeq).padStart(3, "0")}`)}`,
    publicationId: s.publicationId,
    submissionAttemptId,
    registrarRegistrationId: `sat-reg-${idSeq}`,
    registrarId: MONACADO_REGISTRAR_ID,
    nodeId: s.nodeId,
    capsuleId: s.capsuleId,
    registeredContentHash: s.publishedContentHash,
    receiptStatus: "ACCEPTED" as const,
    registeredAt: SEND_AT,
    receivedAt: SEND_AT,
    receiptDetails: { registrarStatusCode: "REGISTERED" },
    ...overrides,
  };
}

async function wipe(): Promise<void> {
  await db.publicationRemediation.deleteMany({});
  await db.registrarReceipt.deleteMany({});
  await db.publicationSubmissionAttempt.deleteMany({});
  await db.publicationOutbox.deleteMany({});
  await db.productPublication.deleteMany({});
  await db.productNode.deleteMany({});
  await db.productSourceRecordVersionRow.deleteMany({});
  await db.product.deleteMany({});
}

describe.skipIf(!RUN)("Publication submission attempts (integration)", () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await disconnectPrisma();
  });

  // — Preparation —

  it("1. preparation requires a PROCESSING work item", async () => {
    const s = await seed(); // never claimed
    await expect(
      attempts.preparePublicationSubmissionAttempt({
        publicationId: s.publicationId,
        outboxId: s.outboxId,
        lockToken: `mon:lock:${pad26("NOCLAIM")}`,
        submissionAttemptId: nextAttemptId(),
        preparedAt: CLAIM_AT,
      }),
    ).rejects.toBeInstanceOf(ClaimNoLongerOwnedError);
    expect(await db.publicationSubmissionAttempt.count()).toBe(0);
  });

  it("2. preparation requires an unexpired lease", async () => {
    const s = await seedAndClaim();
    await expect(
      attempts.preparePublicationSubmissionAttempt({
        publicationId: s.publicationId,
        outboxId: s.outboxId,
        lockToken: s.lockToken,
        submissionAttemptId: nextAttemptId(),
        // After the lease has lapsed.
        preparedAt: AFTER_LEASE,
      }),
    ).rejects.toBeInstanceOf(ClaimLeaseExpiredError);
  });

  it("3. preparation requires the owning lock token", async () => {
    const s = await seedAndClaim();
    await expect(
      attempts.preparePublicationSubmissionAttempt({
        publicationId: s.publicationId,
        outboxId: s.outboxId,
        lockToken: `mon:lock:${pad26("WRONGTOKEN")}`,
        submissionAttemptId: nextAttemptId(),
        preparedAt: CLAIM_AT,
      }),
    ).rejects.toBeInstanceOf(ClaimNoLongerOwnedError);
  });

  it("4,5,6,7. a PREPARED attempt captures immutable identity, hashes the token, and matches attemptCount", async () => {
    const s = await seedAndClaim();
    const submissionAttemptId = nextAttemptId();
    const result = await attempts.preparePublicationSubmissionAttempt({
      publicationId: s.publicationId,
      outboxId: s.outboxId,
      lockToken: s.lockToken,
      submissionAttemptId,
      preparedAt: CLAIM_AT,
    });

    const a = result.attempt;
    expect(a.attemptStatus).toBe("PREPARED");
    expect(a.operation).toBe("REGISTER");
    expect(a.nodeId).toBe(s.nodeId);
    expect(a.capsuleId).toBe(s.capsuleId);
    expect(a.registrarId).toBe(MONACADO_REGISTRAR_ID);
    expect(a.expectedContentHash).toBe(s.publishedContentHash);
    expect(a.payloadHash).toBe(s.payloadHash);
    expect(a.dispatchedAt).toBeUndefined();
    expect(a.abandonedAt).toBeUndefined();
    // 7. Bound to the current claim.
    const obx = await outbox.getPublicationOutboxById(s.outboxId);
    expect(a.attemptNumber).toBe(obx.attemptCount);
    expect(a.attemptNumber).toBe(1);
    // The payload is handed over as persisted, not regenerated.
    expect(result.payload).toEqual(obx.payload);

    // 5,6. The raw token is nowhere in the row; the hash is deterministic.
    const row = await db.publicationSubmissionAttempt.findUnique({
      where: { submissionAttemptId },
    });
    const rowText = JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(rowText).not.toContain(s.lockToken);
    expect(row!.claimTokenHash).toBe(tokenBindingHash(s.lockToken));
    expect(row!.claimTokenHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    // One-way: the hash reveals nothing of the token.
    expect(row!.claimTokenHash).not.toContain(s.lockToken.slice("mon:lock:".length));
  });

  it("8. identical preparation replay is idempotent", async () => {
    const s = await seedAndClaim();
    const submissionAttemptId = nextAttemptId();
    const input = {
      publicationId: s.publicationId,
      outboxId: s.outboxId,
      lockToken: s.lockToken,
      submissionAttemptId,
      preparedAt: CLAIM_AT,
    };
    const first = await attempts.preparePublicationSubmissionAttempt(input);
    const second = await attempts.preparePublicationSubmissionAttempt(input);
    expect(second.alreadyPrepared).toBe(true);
    expect(second.attempt.id).toBe(first.attempt.id);
    expect(await db.publicationSubmissionAttempt.count()).toBe(1);
  });

  it("9. a conflicting submissionAttemptId replay fails", async () => {
    const s = await seedAndClaim();
    const submissionAttemptId = nextAttemptId();
    const input = {
      publicationId: s.publicationId,
      outboxId: s.outboxId,
      lockToken: s.lockToken,
      submissionAttemptId,
      preparedAt: CLAIM_AT,
    };
    await attempts.preparePublicationSubmissionAttempt(input);
    await expect(
      attempts.preparePublicationSubmissionAttempt({ ...input, preparedAt: SEND_AT }),
    ).rejects.toBeInstanceOf(AttemptReplayConflictError);
    expect(await db.publicationSubmissionAttempt.count()).toBe(1);
  });

  it("10. a second attempt for the same claim fails", async () => {
    const s = await seedAndClaim();
    await attempts.preparePublicationSubmissionAttempt({
      publicationId: s.publicationId,
      outboxId: s.outboxId,
      lockToken: s.lockToken,
      submissionAttemptId: nextAttemptId(),
      preparedAt: CLAIM_AT,
    });
    await expect(
      attempts.preparePublicationSubmissionAttempt({
        publicationId: s.publicationId,
        outboxId: s.outboxId,
        lockToken: s.lockToken,
        submissionAttemptId: nextAttemptId(),
        preparedAt: CLAIM_AT,
      }),
    ).rejects.toBeInstanceOf(AttemptAlreadyExistsForClaimError);
  });

  // — Dispatch —

  it("11,12,13,14. dispatch requires PREPARED and the owning token, records dispatchedAt, and replays", async () => {
    const s = await seedAndClaim();
    const submissionAttemptId = nextAttemptId();
    await attempts.preparePublicationSubmissionAttempt({
      publicationId: s.publicationId,
      outboxId: s.outboxId,
      lockToken: s.lockToken,
      submissionAttemptId,
      preparedAt: CLAIM_AT,
    });

    // 12. Wrong token.
    await expect(
      attempts.markPublicationSubmissionAttemptDispatched({
        submissionAttemptId,
        lockToken: `mon:lock:${pad26("WRONGTOKEN")}`,
        dispatchedAt: SEND_AT,
      }),
    ).rejects.toBeInstanceOf(ClaimTokenHashMismatchError);

    // 13. Records dispatchedAt.
    const dispatched = await attempts.markPublicationSubmissionAttemptDispatched({
      submissionAttemptId,
      lockToken: s.lockToken,
      dispatchedAt: SEND_AT,
    });
    expect(dispatched.attemptStatus).toBe("DISPATCHED");
    expect(dispatched.dispatchedAt).toBe(SEND_AT);

    // 14. Identical replay is a no-op; a different time conflicts.
    const replay = await attempts.markPublicationSubmissionAttemptDispatched({
      submissionAttemptId,
      lockToken: s.lockToken,
      dispatchedAt: SEND_AT,
    });
    expect(replay.dispatchedAt).toBe(SEND_AT);
    await expect(
      attempts.markPublicationSubmissionAttemptDispatched({
        submissionAttemptId,
        lockToken: s.lockToken,
        dispatchedAt: "2026-07-01T02:00:00.000Z",
      }),
    ).rejects.toBeInstanceOf(AttemptReplayConflictError);
  });

  // — Receipt binding —

  it("15. a receipt requires a submissionAttemptId", async () => {
    const s = await seedDispatched();
    const { submissionAttemptId, ...withoutAttempt } = receiptFor(s, s.submissionAttemptId);
    void submissionAttemptId;
    await expect(receipts.recordRegistrarReceipt(withoutAttempt)).rejects.toBeInstanceOf(
      ValidationError,
    );
    // An unknown attempt is refused too.
    await expect(
      receipts.recordRegistrarReceipt(receiptFor(s, `mon:attempt:${pad26("NOSUCHATT")}`)),
    ).rejects.toBeInstanceOf(SubmissionAttemptNotFoundError);
    expect(await db.registrarReceipt.count()).toBe(0);
  });

  it("16. a receipt requires a DISPATCHED attempt", async () => {
    const s = await seedAndClaim();
    const submissionAttemptId = nextAttemptId();
    await attempts.preparePublicationSubmissionAttempt({
      publicationId: s.publicationId,
      outboxId: s.outboxId,
      lockToken: s.lockToken,
      submissionAttemptId,
      preparedAt: CLAIM_AT,
    });
    await expect(
      receipts.recordRegistrarReceipt(receiptFor(s, submissionAttemptId)),
    ).rejects.toBeInstanceOf(AttemptNotDispatchedError);
  });

  it("17. a receipt must match the attempt's publication and work item", async () => {
    const a = await seedDispatched();
    const b = await seedDispatched();
    // Name B's attempt while claiming to be about A's publication.
    await expect(
      receipts.recordRegistrarReceipt(receiptFor(a, b.submissionAttemptId)),
    ).rejects.toBeInstanceOf(ReceiptAttemptMismatchError);
    expect(await db.registrarReceipt.count()).toBe(0);
  });

  it("18. a receipt disagreeing with the attempt reconciles as MISMATCH, not silently", async () => {
    // Reconciliation is measured against the attempt's IMMUTABLE expectation.
    for (const override of [
      { registrarId: "an:registrar:someone-else" },
      { nodeId: `an:node:${pad26("SOTHERNODE")}` },
      { capsuleId: `an:capsule:${pad26("SOTHERCAP")}` },
      { registeredContentHash: `sha256:${"d".repeat(64)}` },
    ]) {
      const s = await seedDispatched();
      const result = await receipts.recordRegistrarReceipt(
        receiptFor(s, s.submissionAttemptId, override),
      );
      expect(result.reconciliationState).toBe("MISMATCH");
      expect(result.registrationState).not.toBe("ACCEPTED");
      expect(result.mismatchedFields).toHaveLength(1);
      // The evidence is recorded and bound to the attempt it answered.
      expect(result.receipt.submissionAttemptId).toBe(s.submissionAttemptId);
      const answered = await attempts.getPublicationSubmissionAttempt(s.submissionAttemptId);
      expect(answered.attemptStatus).toBe("RECEIPT_RECORDED");
    }
  });

  it("19. a matching receipt sets RECEIPT_RECORDED and resolves", async () => {
    const s = await seedDispatched();
    const result = await receipts.recordRegistrarReceipt(receiptFor(s, s.submissionAttemptId));
    expect(result.registrationState).toBe("ACCEPTED");
    expect(result.reconciliationState).toBe("MATCHED");
    expect(result.receipt.submissionAttemptId).toBe(s.submissionAttemptId);
    const answered = await attempts.getPublicationSubmissionAttempt(s.submissionAttemptId);
    expect(answered.attemptStatus).toBe("RECEIPT_RECORDED");
    expect(answered.dispatchedAt).toBe(SEND_AT);
    expect(answered.abandonedAt).toBeUndefined();
  });

  it("20,21. one attempt takes one receipt, and one receipt binds to one attempt", async () => {
    const s = await seedDispatched();
    await receipts.recordRegistrarReceipt(receiptFor(s, s.submissionAttemptId));
    // 20. A second receipt naming the same attempt is refused.
    await expect(
      receipts.recordRegistrarReceipt(receiptFor(s, s.submissionAttemptId)),
    ).rejects.toBeInstanceOf(AttemptAlreadyHasReceiptError);
    expect(await db.registrarReceipt.count()).toBe(1);

    // 21. A receipt row carries exactly one attempt reference, and the unique
    //     index means no other receipt can claim that attempt.
    const rows = await db.registrarReceipt.findMany({});
    expect(rows[0]!.submissionAttemptId).toBe(s.submissionAttemptId);
    await expect(
      db.registrarReceipt.create({
        data: {
          receiptId: `mon:rcpt:${pad26("SDUPBIND")}`,
          publicationId: s.publicationId,
          submissionAttemptId: s.submissionAttemptId,
          registrarId: MONACADO_REGISTRAR_ID,
          nodeId: s.nodeId,
          capsuleId: s.capsuleId,
          registeredContentHash: s.publishedContentHash,
          receiptStatus: "REJECTED",
          registeredAt: new Date(SEND_AT),
          receivedAt: new Date(SEND_AT),
          receiptDetails: {},
        },
      }),
    ).rejects.toThrow();
  });

  it("22. an abandoned attempt cannot receive a receipt", async () => {
    const s = await seedDispatched();
    await attempts.markPublicationSubmissionAttemptAbandoned({
      submissionAttemptId: s.submissionAttemptId,
      abandonedAt: SEND_AT,
    });
    const abandoned = await attempts.getPublicationSubmissionAttempt(s.submissionAttemptId);
    expect(abandoned.attemptStatus).toBe("ABANDONED");
    expect(abandoned.abandonedAt).toBe(SEND_AT);

    await expect(
      receipts.recordRegistrarReceipt(receiptFor(s, s.submissionAttemptId)),
    ).rejects.toBeInstanceOf(AttemptAbandonedError);
    expect(await db.registrarReceipt.count()).toBe(0);
  });

  // — Recovery, retry, and attempt numbering —

  it("23,24,25,26,27,28. recovery abandons the attempt; a re-claim yields a new one that resolves", async () => {
    const s = await seedDispatched();

    // 23. The expired claim is recovered and its attempt abandoned atomically.
    const swept = await outbox.recoverExpiredPublicationOutboxClaims({
      now: AFTER_LEASE,
      limit: 10,
    });
    expect(swept.recoveredCount).toBe(1);
    const abandoned = await attempts.getPublicationSubmissionAttempt(s.submissionAttemptId);
    expect(abandoned.attemptStatus).toBe("ABANDONED");
    expect(abandoned.abandonedAt).toBeDefined();

    // 24,25. A re-claim raises attemptCount and yields a distinct attempt.
    const reclaimed = await outbox.claimNextPublicationOutbox({
      now: AFTER_LEASE,
      leaseDurationSeconds: LEASE_SECONDS,
    });
    expect(reclaimed.outbox.attemptCount).toBe(2);
    const secondAttemptId = nextAttemptId();
    const second = await attempts.preparePublicationSubmissionAttempt({
      publicationId: s.publicationId,
      outboxId: s.outboxId,
      lockToken: reclaimed.lockToken,
      submissionAttemptId: secondAttemptId,
      preparedAt: AFTER_LEASE,
    });
    expect(secondAttemptId).not.toBe(s.submissionAttemptId);
    expect(second.attempt.attemptNumber).toBe(2);
    await attempts.markPublicationSubmissionAttemptDispatched({
      submissionAttemptId: secondAttemptId,
      lockToken: reclaimed.lockToken,
      dispatchedAt: AFTER_LEASE,
    });

    // 26. A receipt naming the OLD attempt cannot resolve the newer one.
    await expect(
      receipts.recordRegistrarReceipt(
        receiptFor(s, s.submissionAttemptId, { registeredAt: AFTER_LEASE, receivedAt: AFTER_LEASE }),
      ),
    ).rejects.toBeInstanceOf(AttemptAbandonedError);
    expect((await pubs.getProductPublication(s.publicationId)).registrationState).toBe(
      "NOT_SUBMITTED",
    );

    // 27. A matching receipt on the NEW attempt resolves the publication.
    const resolved = await receipts.recordRegistrarReceipt(
      receiptFor(s, secondAttemptId, { registeredAt: AFTER_LEASE, receivedAt: AFTER_LEASE }),
    );
    expect(resolved.registrationState).toBe("ACCEPTED");
    expect(resolved.reconciliationState).toBe("MATCHED");

    // 28. The earlier attempt is untouched and still ABANDONED.
    const history = await attempts.listPublicationSubmissionAttempts(s.publicationId);
    expect(history).toHaveLength(2);
    expect(history[0]!.submissionAttemptId).toBe(s.submissionAttemptId);
    expect(history[0]!.attemptStatus).toBe("ABANDONED");
    expect(history[0]!.attemptNumber).toBe(1);
    expect(history[1]!.attemptStatus).toBe("RECEIPT_RECORDED");
  });

  it("24b. an authorised retry abandons the old attempt and needs a new one", async () => {
    const s = await seedDispatched();
    // A matching rejection requires remediation.
    await receipts.recordRegistrarReceipt(
      receiptFor(s, s.submissionAttemptId, {
        receiptStatus: "REJECTED",
        registrarRegistrationId: undefined,
        receiptDetails: { rejectionCode: "POLICY_REFUSED", rejectionReason: "Refused." },
      }),
    );
    const RETRY_AT = "2026-07-02T00:00:00.000Z";
    await remediation.remediateProductPublication({
      publicationId: s.publicationId,
      remediationId: `mon:rem:${pad26("SREM001")}`,
      action: "RETRY",
      reasonCode: "TRANSIENT_REGISTRAR_FAULT",
      decidedBy: `mon:actor:${pad26("SOPERATOR")}`,
      decidedAt: RETRY_AT,
      retryAvailableAt: RETRY_AT,
    });

    // The answered attempt is untouched by remediation (it already has a receipt).
    const original = await attempts.getPublicationSubmissionAttempt(s.submissionAttemptId);
    expect(original.attemptStatus).toBe("RECEIPT_RECORDED");

    const reclaimed = await outbox.claimNextPublicationOutbox({
      now: RETRY_AT,
      leaseDurationSeconds: LEASE_SECONDS,
    });
    const retryAttemptId = nextAttemptId();
    const prepared = await attempts.preparePublicationSubmissionAttempt({
      publicationId: s.publicationId,
      outboxId: s.outboxId,
      lockToken: reclaimed.lockToken,
      submissionAttemptId: retryAttemptId,
      preparedAt: RETRY_AT,
    });
    expect(prepared.attempt.attemptNumber).toBe(2);
    expect(retryAttemptId).not.toBe(s.submissionAttemptId);
  });

  // — Settled publications —

  it("29. a CLOSED publication cannot prepare an attempt", async () => {
    const s = await seedDispatched();
    await receipts.recordRegistrarReceipt(
      receiptFor(s, s.submissionAttemptId, {
        receiptStatus: "REJECTED",
        registrarRegistrationId: undefined,
        receiptDetails: { rejectionCode: "POLICY_REFUSED", rejectionReason: "Refused." },
      }),
    );
    await remediation.remediateProductPublication({
      publicationId: s.publicationId,
      remediationId: `mon:rem:${pad26("SREM002")}`,
      action: "CLOSE",
      reasonCode: "WITHDRAWN",
      decidedBy: `mon:actor:${pad26("SOPERATOR")}`,
      decidedAt: SEND_AT,
    });

    await expect(
      attempts.preparePublicationSubmissionAttempt({
        publicationId: s.publicationId,
        outboxId: s.outboxId,
        lockToken: `mon:lock:${pad26("ANYTOKEN")}`,
        submissionAttemptId: nextAttemptId(),
        preparedAt: SEND_AT,
      }),
    ).rejects.toBeInstanceOf(PublicationClosedError);
  });

  it("30. a RESOLVED publication cannot prepare another attempt", async () => {
    const s = await seedDispatched();
    await receipts.recordRegistrarReceipt(receiptFor(s, s.submissionAttemptId));
    await expect(
      attempts.preparePublicationSubmissionAttempt({
        publicationId: s.publicationId,
        outboxId: s.outboxId,
        lockToken: `mon:lock:${pad26("ANYTOKEN")}`,
        submissionAttemptId: nextAttemptId(),
        preparedAt: SEND_AT,
      }),
    ).rejects.toBeInstanceOf(PublicationResolvedError);
  });

  // — Failure isolation and persisted validation —

  it("31. a failed receipt leaves the attempt and publication unchanged", async () => {
    const s = await seedDispatched();
    const pubBefore = await pubs.getProductPublication(s.publicationId);

    // A receipt naming another publication's attempt is refused outright.
    const other = await seedDispatched();
    await expect(
      receipts.recordRegistrarReceipt(receiptFor(s, other.submissionAttemptId)),
    ).rejects.toBeInstanceOf(ReceiptAttemptMismatchError);

    expect(await db.registrarReceipt.count()).toBe(0);
    const attemptAfter = await attempts.getPublicationSubmissionAttempt(s.submissionAttemptId);
    expect(attemptAfter.attemptStatus).toBe("DISPATCHED");
    const pubAfter = await pubs.getProductPublication(s.publicationId);
    expect(pubAfter.registrationState).toBe(pubBefore.registrationState);
    expect(pubAfter.remediationState).toBe(pubBefore.remediationState);
  });

  it("32. persisted invalid attempt combinations fail validation", async () => {
    const s = await seedDispatched();
    // DISPATCHED without dispatchedAt could never be ordered against a receipt.
    await db.$executeRawUnsafe(
      "UPDATE PublicationSubmissionAttempt SET dispatchedAt = NULL WHERE submissionAttemptId = ?",
      s.submissionAttemptId,
    );
    await expect(
      attempts.getPublicationSubmissionAttempt(s.submissionAttemptId),
    ).rejects.toBeInstanceOf(PersistedAttemptContractViolationError);

    // ABANDONED without abandonedAt loses the audit trail.
    await db.$executeRawUnsafe(
      "UPDATE PublicationSubmissionAttempt SET attemptStatus = 'ABANDONED', dispatchedAt = ? WHERE submissionAttemptId = ?",
      new Date(SEND_AT),
      s.submissionAttemptId,
    );
    await expect(
      attempts.getPublicationSubmissionAttempt(s.submissionAttemptId),
    ).rejects.toBeInstanceOf(PersistedAttemptContractViolationError);
  });

  it("33. errors expose no tokens, hashes, payloads, receipt data, or credentials", async () => {
    const s = await seedDispatched();
    try {
      await attempts.markPublicationSubmissionAttemptDispatched({
        submissionAttemptId: s.submissionAttemptId,
        lockToken: `mon:lock:${pad26("SECRETTOKEN")}`,
        dispatchedAt: SEND_AT,
      });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as Error;
      const text = `${JSON.stringify(err)} ${JSON.stringify({ ...err })} ${String(err)}`;
      expect(text).not.toContain("internalCause");
      expect(text).not.toContain(s.lockToken);
      expect(text).not.toContain(tokenBindingHash(s.lockToken));
      expect(text).not.toContain(s.payloadHash);
      expect(text).not.toContain(s.publishedContentHash);
      expect(text).not.toContain("@context");
      expect(text).not.toContain("3308");
      expect(text.toLowerCase()).not.toContain("mysql://");
      expect(e).toBeInstanceOf(ClaimTokenHashMismatchError);
    }
  });
});
