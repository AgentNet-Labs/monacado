/**
 * Publication remediation integration tests (Phase 0E.5.2).
 *
 * Run ONLY against the disposable local MySQL (RUN_DB_TESTS=1). Self-skips
 * otherwise. Never point at production.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ProductSourceRecord } from "../src/contracts/index";
import { MONACADO_PUBLISHER_ID } from "../src/contracts/index";
import { getPrisma, disconnectPrisma } from "../src/server/db/client";
import { ProductRepository } from "../src/server/product/product-repository";
import {
  MONACADO_REGISTRAR_ID,
  ProductNodeRepository,
} from "../src/server/product/product-node-repository";
import { ProductPublicationService } from "../src/server/product/product-publication-service";
import { PublicationOutboxRepository } from "../src/server/product/publication-outbox-repository";
import { PublicationSubmissionAttemptService } from "../src/server/product/submission-attempt-service";
import { RegistrarReceiptService } from "../src/server/product/registrar-receipt-service";
import { PublicationRemediationService } from "../src/server/product/publication-remediation-service";
import { ReceiptConflictError } from "../src/server/product/receipt-errors";
import { AttemptAlreadyHasReceiptError } from "../src/server/product/submission-attempt-errors";
import { ValidationError } from "../src/server/product/errors";
import {
  InvalidRemediationActionError,
  PayloadUnavailableForRetryError,
  PersistedRemediationContractViolationError,
  PublicationClosedError,
  PublicationResolvedError,
  RemediationConflictError,
  RemediationNotRequiredError,
  RemediationReplayConflictError,
  RetryTimeRequiredError,
} from "../src/server/product/remediation-errors";

const RUN = process.env.RUN_DB_TESTS === "1";
const pad26 = (s: string): string =>
  (s.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const CLAIM_AT = "2026-06-01T00:00:00.000Z";
const LEASE_SECONDS = 3600;
const RECEIPT_AT = "2026-06-01T00:30:00.000Z";
const DECIDED_AT = "2026-06-02T00:00:00.000Z";
const RETRY_AT = "2026-06-03T00:00:00.000Z";
const ACTOR = `mon:actor:${pad26("OPERATOR1")}`;

let n = 0;
function syntheticRecord(): ProductSourceRecord {
  n += 1;
  return {
    sourceRecordId: `mon:srec:${pad26(`M${n}SREC`)}`,
    sourceRecordVersion: "1",
    internalProductId: `mon:product:${pad26(`M${n}PRD`)}`,
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    authority: {
      creatorId: `mon:creator:${pad26(`M${n}CRTR`)}`,
      authorityScope: "product-facts",
      authorizationState: "authorized",
    },
    facts: {
      name: "Remediation fixture product",
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      relationships: { creator: `an:node:${pad26(`M${n}CNDE`)}` },
    },
    capsuleSemver: "1.0.0",
    mappingVersion: "0e.5.2.0",
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

interface Prepared {
  publicationId: string;
  outboxId: string;
  nodeId: string;
  capsuleId: string;
  publishedContentHash: string;
  payloadHash: string;
  /** The dispatched attempt the next receipt must name (Phase 0E.5.3). */
  submissionAttemptId: string;
}

let idSeq = 0;

/** Prepare a publication and claim its outbox item, leaving it PROCESSING. */
async function prepareAndClaim(): Promise<Prepared> {
  const record = syntheticRecord();
  await repo.createInitialProductSourceRecord({ record });
  const node = await nodes.issueProductNode({
    nodeId: `an:node:${pad26(`M${n}NODE`)}`,
    internalProductId: record.internalProductId,
    nodeKind: "product",
    nodePolicyRef: "an:policy:node:synthetic-0e52",
    nodePolicyVersion: "1.0.0",
    registrarId: MONACADO_REGISTRAR_ID,
    issuedAt: "2026-01-02T00:00:00.000Z",
  });
  idSeq += 1;
  const result = await pubs.prepareProductPublication({
    publicationId: `mon:pub:${pad26(`MPUB${idSeq}`)}`,
    internalProductId: record.internalProductId,
    sourceRecordId: record.sourceRecordId,
    sourceRecordVersion: "1",
    nodeId: node.nodeId,
    capsuleId: `an:capsule:${pad26(`MCAP${idSeq}`)}`,
    capsuleSemver: record.capsuleSemver,
    publishedBy: MONACADO_PUBLISHER_ID,
    publishedAt: "2026-03-01T00:00:00.000Z",
    nodePolicy: { ref: "an:policy:node:synthetic-0e52", version: "1.0.0" },
    capsulePolicy: { ref: "an:policy:capsule:synthetic-0e52", version: "1.0.0" },
    availableAt: "2026-03-01T00:00:00.000Z",
  });
  const claimed = await outbox.claimNextPublicationOutbox({
    now: CLAIM_AT,
    leaseDurationSeconds: LEASE_SECONDS,
  });
  const submissionAttemptId = await dispatchAttempt(
    result.publication.publicationId,
    result.outbox.outboxId,
    claimed.lockToken,
    CLAIM_AT,
  );
  return {
    submissionAttemptId,
    publicationId: result.publication.publicationId,
    outboxId: result.outbox.outboxId,
    nodeId: node.nodeId,
    capsuleId: result.publication.capsuleId,
    publishedContentHash: result.publication.publishedContentHash,
    payloadHash: result.outbox.payloadHash,
  };
}

/** Prepare and dispatch one attempt, returning its id (Phase 0E.5.3). */
async function dispatchAttempt(
  publicationId: string,
  outboxId: string,
  lockToken: string,
  at: string,
): Promise<string> {
  idSeq += 1;
  const submissionAttemptId = `mon:attempt:${pad26(`MATT${idSeq}`)}`;
  await attempts.preparePublicationSubmissionAttempt({
    publicationId,
    outboxId,
    lockToken,
    submissionAttemptId,
    preparedAt: at,
  });
  await attempts.markPublicationSubmissionAttemptDispatched({
    submissionAttemptId,
    lockToken,
    dispatchedAt: at,
  });
  return submissionAttemptId;
}

function receiptFor(p: Prepared, overrides: Record<string, unknown> = {}) {
  idSeq += 1;
  return {
    receiptId: `mon:rcpt:${pad26(`MRCPT${idSeq}`)}`,
    publicationId: p.publicationId,
    submissionAttemptId: p.submissionAttemptId,
    registrarRegistrationId: `rem-reg-${idSeq}`,
    registrarId: MONACADO_REGISTRAR_ID,
    nodeId: p.nodeId,
    capsuleId: p.capsuleId,
    registeredContentHash: p.publishedContentHash,
    receiptStatus: "ACCEPTED" as const,
    registeredAt: RECEIPT_AT,
    receivedAt: RECEIPT_AT,
    receiptDetails: { registrarStatusCode: "REGISTERED" },
    ...overrides,
  };
}

const REJECTED = {
  receiptStatus: "REJECTED" as const,
  registrarRegistrationId: undefined,
  receiptDetails: { rejectionCode: "POLICY_REFUSED", rejectionReason: "Refused by policy." },
};

/** Drive a publication to a matching rejection (remediation REQUIRED). */
async function rejected(): Promise<Prepared> {
  const p = await prepareAndClaim();
  await receipts.recordRegistrarReceipt(receiptFor(p, REJECTED));
  return p;
}

/** Drive a publication to an accepted mismatch (remediation REQUIRED). */
async function mismatched(): Promise<Prepared> {
  const p = await prepareAndClaim();
  await receipts.recordRegistrarReceipt(
    receiptFor(p, { capsuleId: `an:capsule:${pad26(`MOTHER${idSeq}`)}` }),
  );
  return p;
}

function decision(p: Prepared, overrides: Record<string, unknown> = {}) {
  idSeq += 1;
  return {
    publicationId: p.publicationId,
    remediationId: `mon:rem:${pad26(`MREM${idSeq}`)}`,
    action: "RETRY" as const,
    reasonCode: "TRANSIENT_REGISTRAR_FAULT",
    reasonSummary: "Registrar reported a transient fault; a further attempt is authorised.",
    decidedBy: ACTOR,
    decidedAt: DECIDED_AT,
    retryAvailableAt: RETRY_AT,
    ...overrides,
  };
}

const closeDecision = (p: Prepared, overrides: Record<string, unknown> = {}) =>
  decision(p, { action: "CLOSE", retryAvailableAt: undefined, reasonCode: "WITHDRAWN", ...overrides });

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

describe.skipIf(!RUN)("Publication remediation (integration)", () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await disconnectPrisma();
  });

  // — Remediation state driven by receipts —

  it("1. a matching rejection sets remediation REQUIRED", async () => {
    const p = await rejected();
    const pub = await pubs.getProductPublication(p.publicationId);
    expect(pub.registrationState).toBe("REJECTED");
    expect(pub.reconciliationState).toBe("MATCHED");
    expect(pub.remediationState).toBe("REQUIRED");
  });

  it("2,3. an accepted or rejected mismatch sets remediation REQUIRED", async () => {
    const a = await mismatched();
    const pubA = await pubs.getProductPublication(a.publicationId);
    expect(pubA.reconciliationState).toBe("MISMATCH");
    expect(pubA.remediationState).toBe("REQUIRED");

    const b = await prepareAndClaim();
    await receipts.recordRegistrarReceipt(
      receiptFor(b, { ...REJECTED, nodeId: `an:node:${pad26("MOTHERNODE")}` }),
    );
    const pubB = await pubs.getProductPublication(b.publicationId);
    expect(pubB.reconciliationState).toBe("MISMATCH");
    expect(pubB.remediationState).toBe("REQUIRED");
  });

  it("4. a clean publication remains NOT_REQUIRED", async () => {
    const p = await prepareAndClaim();
    const pub = await pubs.getProductPublication(p.publicationId);
    expect(pub.remediationState).toBe("NOT_REQUIRED");
  });

  it("5. a matching acceptance becomes RESOLVED", async () => {
    const p = await prepareAndClaim();
    const result = await receipts.recordRegistrarReceipt(receiptFor(p));
    expect(result.publication.remediationState).toBe("RESOLVED");
    await remediation.assertRemediationConsistency(p.publicationId);
  });

  // — RETRY —

  it("6. RETRY requires the REQUIRED state", async () => {
    const clean = await prepareAndClaim();
    await expect(
      remediation.remediateProductPublication(decision(clean)),
    ).rejects.toBeInstanceOf(RemediationNotRequiredError);

    const resolved = await prepareAndClaim();
    await receipts.recordRegistrarReceipt(receiptFor(resolved));
    await expect(
      remediation.remediateProductPublication(decision(resolved)),
    ).rejects.toBeInstanceOf(PublicationResolvedError);
  });

  it("7. RETRY requires a retained payload", async () => {
    const p = await rejected();
    // Simulate a disposed body behind the service's back.
    await db.$executeRawUnsafe(
      "UPDATE PublicationOutbox SET payload = NULL, outboxStatus = 'COMPLETED', lockToken = NULL, lockedAt = NULL, leaseExpiresAt = NULL WHERE outboxId = ?",
      p.outboxId,
    );
    await expect(remediation.remediateProductPublication(decision(p))).rejects.toBeInstanceOf(
      PayloadUnavailableForRetryError,
    );
  });

  it("8. RETRY requires retryAvailableAt", async () => {
    const p = await rejected();
    await expect(
      remediation.remediateProductPublication(decision(p, { retryAvailableAt: undefined })),
    ).rejects.toBeInstanceOf(RetryTimeRequiredError);
    expect(await db.publicationRemediation.count()).toBe(0);
  });

  it("9,10,11,12,13,14,15,16,17. RETRY records evidence and re-authorises the work", async () => {
    const p = await rejected();
    const before = await outbox.getPublicationOutboxById(p.outboxId);
    const payloadBefore = before.payload;
    const attemptsBefore = before.attemptCount;

    const input = decision(p);
    const result = await remediation.remediateProductPublication(input);

    // 9. Immutable evidence, capturing the state decided against.
    expect(result.alreadyRemediated).toBe(false);
    expect(result.remediation.remediationId).toBe(input.remediationId);
    expect(result.remediation.remediationAction).toBe("RETRY");
    expect(result.remediation.priorRegistrationState).toBe("REJECTED");
    expect(result.remediation.priorReconciliationState).toBe("MATCHED");
    expect(result.remediation.priorRemediationState).toBe("REQUIRED");
    expect(result.remediation.priorOutboxStatus).toBe("DEAD_LETTER");
    expect(result.remediation.decidedBy).toBe(ACTOR);
    expect(result.remediation.decidedAt).toBe(DECIDED_AT);
    expect(result.remediation.retryAvailableAt).toBe(RETRY_AT);
    expect(Object.keys(result.remediation)).not.toContain("updatedAt");

    // 10,11,12. Publication state.
    expect(result.publication.remediationState).toBe("RETRY_AUTHORIZED");
    expect(result.publication.registrationState).toBe("PENDING");
    expect(result.publication.reconciliationState).toBe("PENDING");

    // 13,14. Work item re-authorised with ownership released.
    expect(result.outbox.outboxStatus).toBe("RETRYABLE");
    expect(result.outbox.availableAt).toBe(RETRY_AT);
    expect(result.outbox.lockToken).toBeUndefined();
    expect(result.outbox.lockedAt).toBeUndefined();
    expect(result.outbox.leaseExpiresAt).toBeUndefined();
    expect(result.outbox.completedAt).toBeUndefined();
    // Documented decision: the superseded attempt's error metadata is cleared.
    expect(result.outbox.lastErrorCode).toBeUndefined();
    expect(result.outbox.lastErrorSummary).toBeUndefined();

    // 15,16. Attempts, payload, and hash preserved.
    expect(result.outbox.attemptCount).toBe(attemptsBefore);
    expect(result.outbox.payload).toEqual(payloadBefore);
    expect(result.outbox.payloadHash).toBe(p.payloadHash);

    // 17. Prior receipts survive untouched.
    const kept = await receipts.listRegistrarReceipts(p.publicationId);
    expect(kept).toHaveLength(1);
    expect(kept[0]!.receiptStatus).toBe("REJECTED");

    // Expected identity is never rewritten.
    expect(result.publication.capsuleId).toBe(p.capsuleId);
    expect(result.publication.publishedContentHash).toBe(p.publishedContentHash);

    await remediation.assertRemediationConsistency(p.publicationId);
  });

  // — Acceptance after RETRY —

  it("18,19,20,21. a matching acceptance after RETRY resolves and disposes the payload", async () => {
    const p = await rejected();
    await remediation.remediateProductPublication(decision(p));

    // A worker re-claims the re-authorised item and prepares a NEW attempt.
    const claimed = await outbox.claimNextPublicationOutbox({
      now: RETRY_AT,
      leaseDurationSeconds: LEASE_SECONDS,
    });
    expect(claimed.outbox.outboxId).toBe(p.outboxId);
    const retryAttemptId = await dispatchAttempt(p.publicationId, p.outboxId, claimed.lockToken, RETRY_AT);
    expect(retryAttemptId).not.toBe(p.submissionAttemptId);

    const result = await receipts.recordRegistrarReceipt(
      receiptFor(p, {
        submissionAttemptId: retryAttemptId,
        registeredAt: RETRY_AT,
        receivedAt: RETRY_AT,
      }),
    );

    expect(result.registrationState).toBe("ACCEPTED");
    expect(result.reconciliationState).toBe("MATCHED");
    expect(result.publication.remediationState).toBe("RESOLVED");
    expect(result.outbox.outboxStatus).toBe("COMPLETED");
    expect(result.payloadDisposed).toBe(true);
    expect(result.outbox.payload).toBeUndefined();
    expect(result.outbox.payloadHash).toBe(p.payloadHash);

    // 21. The earlier rejection remains stored as immutable evidence.
    const kept = await receipts.listRegistrarReceipts(p.publicationId);
    expect(kept).toHaveLength(2);
    expect(kept.map((r) => r.receiptStatus).sort()).toEqual(["ACCEPTED", "REJECTED"]);
    // And so does the remediation decision.
    expect(await remediation.listPublicationRemediations(p.publicationId)).toHaveLength(1);

    await remediation.assertRemediationConsistency(p.publicationId);
  });

  it("18b. a mismatched publication can also be retried and then resolved", async () => {
    const p = await mismatched();
    await remediation.remediateProductPublication(decision(p));
    // The mismatch left the item PROCESSING; RETRY returned it to RETRYABLE.
    const reclaimed = await outbox.claimNextPublicationOutbox({
      now: RETRY_AT,
      leaseDurationSeconds: LEASE_SECONDS,
    });
    const retryAttemptId = await dispatchAttempt(
      p.publicationId,
      p.outboxId,
      reclaimed.lockToken,
      RETRY_AT,
    );
    const result = await receipts.recordRegistrarReceipt(
      receiptFor(p, {
        submissionAttemptId: retryAttemptId,
        registeredAt: RETRY_AT,
        receivedAt: RETRY_AT,
      }),
    );
    expect(result.publication.remediationState).toBe("RESOLVED");
    expect(result.reconciliationState).toBe("MATCHED");
  });

  // — CLOSE —

  it("22. CLOSE requires the REQUIRED state", async () => {
    const clean = await prepareAndClaim();
    await expect(
      remediation.remediateProductPublication(closeDecision(clean)),
    ).rejects.toBeInstanceOf(RemediationNotRequiredError);
  });

  it("23,24,25,26,27. CLOSE records evidence, dead-letters the work, and retains everything", async () => {
    const p = await rejected();
    const before = await outbox.getPublicationOutboxById(p.outboxId);

    const input = closeDecision(p);
    const result = await remediation.remediateProductPublication(input);

    expect(result.remediation.remediationAction).toBe("CLOSE");
    expect(result.remediation.retryAvailableAt).toBeUndefined();
    expect(result.remediation.priorRemediationState).toBe("REQUIRED");
    expect(result.publication.remediationState).toBe("CLOSED");
    // 25. Registration and reconciliation evidence is untouched.
    expect(result.publication.registrationState).toBe("REJECTED");
    expect(result.publication.reconciliationState).toBe("MATCHED");
    // 26,27.
    expect(result.outbox.outboxStatus).toBe("DEAD_LETTER");
    expect(result.outbox.lockToken).toBeUndefined();
    expect(result.outbox.leaseExpiresAt).toBeUndefined();
    expect(result.outbox.payload).toEqual(before.payload);
    expect(result.outbox.payloadHash).toBe(p.payloadHash);
    // Prior error evidence is retained on CLOSE.
    expect(result.outbox.lastErrorCode).toBe("POLICY_REFUSED");

    expect(await receipts.listRegistrarReceipts(p.publicationId)).toHaveLength(1);
    await remediation.assertRemediationConsistency(p.publicationId);
  });

  it("23b. CLOSE dead-letters a mismatched item that was left PROCESSING", async () => {
    const p = await mismatched();
    const before = await outbox.getPublicationOutboxById(p.outboxId);
    expect(before.outboxStatus).toBe("PROCESSING");

    const result = await remediation.remediateProductPublication(closeDecision(p));
    expect(result.outbox.outboxStatus).toBe("DEAD_LETTER");
    expect(result.outbox.lockToken).toBeUndefined();
    expect(result.outbox.leaseExpiresAt).toBeUndefined();
    await remediation.assertRemediationConsistency(p.publicationId);
  });

  it("28. a CLOSED publication cannot be retried", async () => {
    const p = await rejected();
    await remediation.remediateProductPublication(closeDecision(p));
    await expect(remediation.remediateProductPublication(decision(p))).rejects.toBeInstanceOf(
      PublicationClosedError,
    );
    await expect(
      remediation.remediateProductPublication(closeDecision(p)),
    ).rejects.toBeInstanceOf(PublicationClosedError);
  });

  it("29. a CLOSED publication cannot be resolved by a later receipt", async () => {
    const p = await rejected();
    await remediation.remediateProductPublication(closeDecision(p));

    // Phase 0E.5.3 enforces this a layer earlier and more completely: a receipt
    // must name a DISPATCHED attempt, and a CLOSED publication can prepare none.
    await expect(
      attempts.preparePublicationSubmissionAttempt({
        publicationId: p.publicationId,
        outboxId: p.outboxId,
        lockToken: `mon:lock:${pad26("ANYTOKEN")}`,
        submissionAttemptId: `mon:attempt:${pad26("MCLOSED")}`,
        preparedAt: RETRY_AT,
      }),
    ).rejects.toBeInstanceOf(PublicationClosedError);

    // Nor can the already-answered original attempt be reused.
    await expect(
      receipts.recordRegistrarReceipt(receiptFor(p, { registeredAt: RETRY_AT, receivedAt: RETRY_AT })),
    ).rejects.toBeInstanceOf(AttemptAlreadyHasReceiptError);

    const pub = await pubs.getProductPublication(p.publicationId);
    expect(pub.remediationState).toBe("CLOSED");
    expect(pub.registrationState).toBe("REJECTED");
    // The payload is still retained — a refused acceptance disposes nothing.
    const obx = await outbox.getPublicationOutboxById(p.outboxId);
    expect(obx.payload).toBeDefined();
  });

  it("30. a RESOLVED publication cannot be remediated", async () => {
    const p = await prepareAndClaim();
    await receipts.recordRegistrarReceipt(receiptFor(p));
    await expect(remediation.remediateProductPublication(decision(p))).rejects.toBeInstanceOf(
      PublicationResolvedError,
    );
    await expect(
      remediation.remediateProductPublication(closeDecision(p)),
    ).rejects.toBeInstanceOf(PublicationResolvedError);
  });

  // — Idempotency and concurrency —

  it("31. an identical remediation replay is idempotent", async () => {
    const p = await rejected();
    const input = decision(p);
    const first = await remediation.remediateProductPublication(input);
    const second = await remediation.remediateProductPublication(input);

    expect(second.alreadyRemediated).toBe(true);
    expect(second.remediation.id).toBe(first.remediation.id);
    expect(await db.publicationRemediation.count()).toBe(1);
    expect(second.publication.remediationState).toBe("RETRY_AUTHORIZED");
  });

  it("32. a conflicting remediationId replay fails", async () => {
    const p = await rejected();
    const input = decision(p);
    await remediation.remediateProductPublication(input);
    await expect(
      remediation.remediateProductPublication({ ...input, reasonCode: "SOMETHING_ELSE" }),
    ).rejects.toBeInstanceOf(RemediationReplayConflictError);
    expect(await db.publicationRemediation.count()).toBe(1);
  });

  it("32b. only one active RETRY authorisation may exist", async () => {
    const p = await rejected();
    await remediation.remediateProductPublication(decision(p));
    // A second, different retry decision while one is outstanding.
    await expect(remediation.remediateProductPublication(decision(p))).rejects.toBeInstanceOf(
      InvalidRemediationActionError,
    );
    // CLOSE is equally refused until a later receipt returns it to REQUIRED.
    await expect(
      remediation.remediateProductPublication(closeDecision(p)),
    ).rejects.toBeInstanceOf(InvalidRemediationActionError);
    expect(await db.publicationRemediation.count()).toBe(1);
  });

  it("33. concurrent remediation attempts yield exactly one winner", async () => {
    const p = await rejected();
    const results = await Promise.allSettled([
      remediation.remediateProductPublication(decision(p)),
      remediation.remediateProductPublication(decision(p)),
      remediation.remediateProductPublication(closeDecision(p)),
    ]);
    const won = results.filter((r) => r.status === "fulfilled");
    expect(won).toHaveLength(1);

    // Exactly one decision took effect; the publication is in one coherent state.
    const pub = await pubs.getProductPublication(p.publicationId);
    expect(["RETRY_AUTHORIZED", "CLOSED"]).toContain(pub.remediationState);
    await remediation.assertRemediationConsistency(p.publicationId);
  });

  it("34. a failed remediation leaves all prior state intact", async () => {
    const p = await rejected();
    const pubBefore = await pubs.getProductPublication(p.publicationId);
    const obxBefore = await outbox.getPublicationOutboxById(p.outboxId);

    // Retry with a payload that has been disposed — refused at the guard.
    await db.$executeRawUnsafe(
      "UPDATE PublicationOutbox SET payload = NULL, outboxStatus = 'COMPLETED' WHERE outboxId = ?",
      p.outboxId,
    );
    await expect(remediation.remediateProductPublication(decision(p))).rejects.toThrow();
    // Restore so the comparison is about remediation, not our fixture.
    await db.publicationOutbox.update({
      where: { outboxId: p.outboxId },
      data: { payload: obxBefore.payload as object, outboxStatus: obxBefore.outboxStatus },
    });

    expect(await db.publicationRemediation.count()).toBe(0);
    const pubAfter = await pubs.getProductPublication(p.publicationId);
    expect(pubAfter.remediationState).toBe(pubBefore.remediationState);
    expect(pubAfter.registrationState).toBe(pubBefore.registrationState);
    expect(await receipts.listRegistrarReceipts(p.publicationId)).toHaveLength(1);
  });

  // — Cross-entity validation —

  it("35. invalid persisted remediation combinations fail validation", async () => {
    // RETRY_AUTHORIZED without a RETRYABLE work item.
    const a = await rejected();
    await remediation.remediateProductPublication(decision(a));
    await db.$executeRawUnsafe(
      "UPDATE PublicationOutbox SET outboxStatus = 'PENDING' WHERE outboxId = ?",
      a.outboxId,
    );
    await expect(remediation.assertRemediationConsistency(a.publicationId)).rejects.toBeInstanceOf(
      PersistedRemediationContractViolationError,
    );

    // RESOLVED with the payload still retained.
    const b = await prepareAndClaim();
    await receipts.recordRegistrarReceipt(receiptFor(b));
    const original = (await db.publicationOutbox.findUnique({ where: { outboxId: b.outboxId } }))!;
    await db.publicationOutbox.update({
      where: { outboxId: b.outboxId },
      data: { payload: { restored: true } as object },
    });
    await expect(remediation.assertRemediationConsistency(b.publicationId)).rejects.toBeInstanceOf(
      PersistedRemediationContractViolationError,
    );
    expect(original.payload).toBeNull();

    // REQUIRED with no adverse evidence is rejected by the publication contract.
    const c = await prepareAndClaim();
    await db.$executeRawUnsafe(
      "UPDATE ProductPublication SET remediationState = 'REQUIRED' WHERE publicationId = ?",
      c.publicationId,
    );
    await expect(pubs.getProductPublication(c.publicationId)).rejects.toThrow();
  });

  it("36. errors expose no payload, receipt data, hashes, tokens, or credentials", async () => {
    const p = await rejected();
    const claimedRow = await db.publicationOutbox.findUnique({ where: { outboxId: p.outboxId } });
    await remediation.remediateProductPublication(closeDecision(p));

    try {
      await remediation.remediateProductPublication(decision(p));
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as Error;
      const text = `${JSON.stringify(err)} ${JSON.stringify({ ...err })} ${String(err)}`;
      expect(text).not.toContain("internalCause");
      expect(text).not.toContain(p.payloadHash);
      expect(text).not.toContain(p.publishedContentHash);
      expect(text).not.toContain("@context");
      expect(text).not.toContain("POLICY_REFUSED");
      expect(text).not.toContain("3308");
      expect(text.toLowerCase()).not.toContain("mysql://");
      if (claimedRow?.lockToken) expect(text).not.toContain(claimedRow.lockToken);
      expect(e).toBeInstanceOf(PublicationClosedError);
    }
  });

  it("36b. a remediation conflict reports field names only", async () => {
    const p = await rejected();
    const input = decision(p);
    await remediation.remediateProductPublication(input);
    try {
      await remediation.remediateProductPublication({ ...input, decidedBy: `mon:actor:${pad26("OTHER")}` });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as RemediationReplayConflictError;
      expect(err).toBeInstanceOf(RemediationReplayConflictError);
      expect(err.conflictingFields).toEqual(["decidedBy"]);
      expect(JSON.stringify(err)).not.toContain("internalCause");
    }
  });

  it("37. a remediation with no open decision reports the current state safely", async () => {
    const p = await prepareAndClaim();
    try {
      await remediation.remediateProductPublication(decision(p));
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as RemediationNotRequiredError;
      expect(err).toBeInstanceOf(RemediationNotRequiredError);
      // A bounded state name is safe to surface; nothing else is.
      expect(err.remediationState).toBe("NOT_REQUIRED");
      expect(JSON.stringify(err)).not.toContain(p.payloadHash);
    }
    expect(await db.publicationRemediation.count()).toBe(0);
  });

  it("38. a decidedBy that is not an opaque actor id is refused", async () => {
    const p = await rejected();
    // An email address or display name must never be persisted as the actor.
    for (const decidedBy of ["operator@example.com", "Jane Doe", "mon:actor:short", ACTOR.slice(4)]) {
      await expect(
        remediation.remediateProductPublication(decision(p, { decidedBy })),
      ).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await db.publicationRemediation.count()).toBe(0);
  });
});
