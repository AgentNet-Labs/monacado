/**
 * Registrar receipt ingestion integration tests (Phase 0E.6.4).
 *
 * Run ONLY against the disposable local MySQL (RUN_DB_TESTS=1). Self-skips
 * otherwise. Never point at production.
 *
 * NO NETWORK and NO CREDENTIALS. Ingestion takes a receipt as data; nothing is
 * fetched. Every envelope below is synthetic.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ProductSourceRecord } from "../src/contracts/index";
import { MONACADO_PUBLISHER_ID } from "../src/contracts/index";
import { disconnectPrisma, getPrisma } from "../src/server/db/client";
import { ProductRepository } from "../src/server/product/product-repository";
import {
  MONACADO_REGISTRAR_ID,
  ProductNodeRepository,
} from "../src/server/product/product-node-repository";
import { ProductPublicationService } from "../src/server/product/product-publication-service";
import { PublicationOutboxRepository } from "../src/server/product/publication-outbox-repository";
import { PublicationSubmissionAttemptService } from "../src/server/product/submission-attempt-service";
import { RegistrarReceiptService } from "../src/server/product/registrar-receipt-service";
import { ingestRegistrarReceipt } from "../src/server/product/receipt-ingestion-service";
import {
  ExpectedRegistrarMismatchError,
  InvalidReceiptEnvelopeError,
} from "../src/server/product/receipt-ingestion-errors";
import {
  AttemptAbandonedError,
  AttemptAlreadyHasReceiptError,
  AttemptNotDispatchedError,
  ReceiptAttemptMismatchError,
} from "../src/server/product/submission-attempt-errors";
import { ReceiptConflictError } from "../src/server/product/receipt-errors";
import { mapRegistrarTransportResponseToReceiptEnvelope } from "../src/contracts/product/receipt-response-mapper";
import type { RegisterResponseEnvelope } from "../src/contracts/product/registrar-transport";

const RUN = process.env.RUN_DB_TESTS === "1";
const pad26 = (s: string): string =>
  (s.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const AVAILABLE_AT = "2026-09-01T00:00:00.000Z";
const CLAIM_AT = "2026-09-01T01:00:00.000Z";
const SEND_AT = "2026-09-01T01:10:00.000Z";
const REGISTERED_AT = "2026-09-01T01:15:00.000Z";
const RECEIVED_AT = "2026-09-01T01:20:00.000Z";
const LEASE_SECONDS = 3600;

let n = 0;
function syntheticRecord(): ProductSourceRecord {
  n += 1;
  return {
    sourceRecordId: `mon:srec:${pad26(`I${n}SREC`)}`,
    sourceRecordVersion: "1",
    internalProductId: `mon:product:${pad26(`I${n}PRD`)}`,
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    authority: {
      creatorId: `mon:creator:${pad26(`I${n}CRTR`)}`,
      authorityScope: "product-facts",
      authorizationState: "authorized",
    },
    facts: {
      name: "Receipt ingestion fixture product",
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      relationships: { creator: `an:node:${pad26(`I${n}CNDE`)}` },
    },
    capsuleSemver: "1.0.0",
    mappingVersion: "0e.6.4.0",
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
const attempts = RUN
  ? new PublicationSubmissionAttemptService(db)
  : (undefined as unknown as PublicationSubmissionAttemptService);

let idSeq = 0;
const nextAttemptId = () => {
  idSeq += 1;
  return `mon:attempt:${pad26(`IATT${String(idSeq).padStart(3, "0")}`)}`;
};
const nextReceiptId = () => {
  idSeq += 1;
  return `mon:rcpt:${pad26(`IRCPT${String(idSeq).padStart(3, "0")}`)}`;
};

interface Seeded {
  publicationId: string;
  outboxId: string;
  nodeId: string;
  capsuleId: string;
  publishedContentHash: string;
  payloadHash: string;
}

async function seed(): Promise<Seeded> {
  const record = syntheticRecord();
  await repo.createInitialProductSourceRecord({ record });
  const node = await nodes.issueProductNode({
    nodeId: `an:node:${pad26(`I${n}NODE`)}`,
    internalProductId: record.internalProductId,
    nodeKind: "product",
    nodePolicyRef: "an:policy:node:synthetic-0e64",
    nodePolicyVersion: "1.0.0",
    registrarId: MONACADO_REGISTRAR_ID,
    issuedAt: "2026-01-02T00:00:00.000Z",
  });
  idSeq += 1;
  const result = await pubs.prepareProductPublication({
    publicationId: `mon:pub:${pad26(`IPUB${String(idSeq).padStart(3, "0")}`)}`,
    internalProductId: record.internalProductId,
    sourceRecordId: record.sourceRecordId,
    sourceRecordVersion: "1",
    nodeId: node.nodeId,
    capsuleId: `an:capsule:${pad26(`ICAP${String(idSeq).padStart(3, "0")}`)}`,
    capsuleSemver: record.capsuleSemver,
    publishedBy: MONACADO_PUBLISHER_ID,
    publishedAt: "2026-03-01T00:00:00.000Z",
    nodePolicy: { ref: "an:policy:node:synthetic-0e64", version: "1.0.0" },
    capsulePolicy: { ref: "an:policy:capsule:synthetic-0e64", version: "1.0.0" },
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

/** Seed, claim, prepare, and dispatch — the state a receipt may answer. */
async function seedDispatched(): Promise<Seeded & { submissionAttemptId: string }> {
  const s = await seed();
  const claimed = await outbox.claimNextPublicationOutbox({
    now: CLAIM_AT,
    leaseDurationSeconds: LEASE_SECONDS,
  });
  const submissionAttemptId = nextAttemptId();
  await attempts.preparePublicationSubmissionAttempt({
    publicationId: s.publicationId,
    outboxId: s.outboxId,
    lockToken: claimed.lockToken,
    submissionAttemptId,
    preparedAt: CLAIM_AT,
  });
  await attempts.markPublicationSubmissionAttemptDispatched({
    submissionAttemptId,
    lockToken: claimed.lockToken,
    dispatchedAt: SEND_AT,
  });
  return { ...s, submissionAttemptId };
}

/** Seed, claim, prepare — but never dispatch. */
async function seedPrepared(): Promise<Seeded & { submissionAttemptId: string; lockToken: string }> {
  const s = await seed();
  const claimed = await outbox.claimNextPublicationOutbox({
    now: CLAIM_AT,
    leaseDurationSeconds: LEASE_SECONDS,
  });
  const submissionAttemptId = nextAttemptId();
  await attempts.preparePublicationSubmissionAttempt({
    publicationId: s.publicationId,
    outboxId: s.outboxId,
    lockToken: claimed.lockToken,
    submissionAttemptId,
    preparedAt: CLAIM_AT,
  });
  return { ...s, submissionAttemptId, lockToken: claimed.lockToken };
}

function envelopeFor(
  s: Seeded,
  submissionAttemptId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    receiptId: nextReceiptId(),
    submissionAttemptId,
    publicationId: s.publicationId,
    registrarRegistrationId: `synthetic-reg-${idSeq}`,
    registrarId: MONACADO_REGISTRAR_ID,
    nodeId: s.nodeId,
    capsuleId: s.capsuleId,
    registeredContentHash: s.publishedContentHash,
    receiptStatus: "ACCEPTED",
    registeredAt: REGISTERED_AT,
    receiptDetails: { registrarStatusCode: "REGISTERED" },
    ...overrides,
  };
}

const ingest = (envelope: unknown, extra: Record<string, unknown> = {}) =>
  ingestRegistrarReceipt(
    { envelope, receivedAt: RECEIVED_AT, source: "TEST_ADAPTER", ...extra },
    { db },
  );

async function wipe() {
  await db.publicationRemediation.deleteMany({});
  await db.registrarReceipt.deleteMany({});
  await db.publicationSubmissionAttempt.deleteMany({});
  await db.publicationOutbox.deleteMany({});
  await db.productPublication.deleteMany({});
  await db.productNode.deleteMany({});
  await db.productSourceRecordVersionRow.deleteMany({});
  await db.product.deleteMany({});
}

const pubRow = (publicationId: string) =>
  db.productPublication.findUnique({ where: { publicationId } });
const outboxRow = (outboxId: string) => db.publicationOutbox.findUnique({ where: { outboxId } });
const attemptRow = (submissionAttemptId: string) =>
  db.publicationSubmissionAttempt.findUnique({ where: { submissionAttemptId } });

describe.skipIf(!RUN)("Registrar receipt ingestion (integration)", () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await disconnectPrisma();
  });

  // — Matching acceptance —

  it("1-8. a matching acceptance resolves the publication and disposes the payload", async () => {
    const s = await seedDispatched();
    const result = await ingest(envelopeFor(s, s.submissionAttemptId));

    expect(result.outcome).toBe("ACCEPTED_MATCHED");
    expect(result.mismatchedFields).toEqual([]);
    expect(result.payloadDisposed).toBe(true);

    expect((await attemptRow(s.submissionAttemptId))?.attemptStatus).toBe("RECEIPT_RECORDED");
    const pub = await pubRow(s.publicationId);
    expect(pub?.registrationState).toBe("ACCEPTED");
    expect(pub?.reconciliationState).toBe("MATCHED");
    expect(pub?.remediationState).toBe("RESOLVED");

    const row = await outboxRow(s.outboxId);
    expect(row?.outboxStatus).toBe("COMPLETED");
    expect(row?.payload).toBeNull();
    // Retained metadata survives disposal: the hash, source pointers, and
    // mapping version are what make the disposal reversible in evidence terms.
    expect(row?.payloadHash).toBe(s.payloadHash);
    expect(pub?.publishedContentHash).toBe(s.publishedContentHash);
    expect(pub?.sourceRecordId).toBeTruthy();
    expect(pub?.sourceRecordVersion).toBeTruthy();
    expect(await db.registrarReceipt.count()).toBe(1);
  });

  // — Mismatched acceptance —

  it("9-11. a mismatched acceptance records evidence, keeps the payload, and requires remediation", async () => {
    const s = await seedDispatched();
    const result = await ingest(
      envelopeFor(s, s.submissionAttemptId, { capsuleId: `an:capsule:${pad26("IWRONGCAP")}` }),
    );

    expect(result.outcome).toBe("ACCEPTED_MISMATCH");
    expect(result.mismatchedFields.length).toBeGreaterThan(0);
    expect(result.payloadDisposed).toBe(false);

    const pub = await pubRow(s.publicationId);
    // Crucially NOT marked accepted on the strength of a receipt describing
    // something else.
    expect(pub?.registrationState).not.toBe("ACCEPTED");
    expect(pub?.reconciliationState).toBe("MISMATCH");
    expect(pub?.remediationState).toBe("REQUIRED");

    const row = await outboxRow(s.outboxId);
    expect(row?.payload).not.toBeNull();
    expect(row?.payloadHash).toBe(s.payloadHash);
    expect(await db.registrarReceipt.count()).toBe(1);
  });

  // — Rejection —

  it("12-14. a matching rejection records evidence, retains the payload, and requires remediation", async () => {
    const s = await seedDispatched();
    const result = await ingest(
      envelopeFor(s, s.submissionAttemptId, {
        receiptStatus: "REJECTED",
        registrarRegistrationId: undefined,
        receiptDetails: { rejectionCode: "POLICY_REFUSED", rejectionReason: "Refused by policy" },
      }),
    );

    expect(result.outcome).toBe("REJECTED_MATCHED");
    expect(result.payloadDisposed).toBe(false);

    const pub = await pubRow(s.publicationId);
    expect(pub?.registrationState).toBe("REJECTED");
    expect(pub?.reconciliationState).toBe("MATCHED");
    expect(pub?.remediationState).toBe("REQUIRED");

    const row = await outboxRow(s.outboxId);
    expect(row?.payload).not.toBeNull();
    expect(row?.payloadHash).toBe(s.payloadHash);
  });

  it("15-16. a mismatched rejection records evidence and retains the payload", async () => {
    const s = await seedDispatched();
    const result = await ingest(
      envelopeFor(s, s.submissionAttemptId, {
        receiptStatus: "REJECTED",
        registrarRegistrationId: undefined,
        nodeId: `an:node:${pad26("IWRONGNODE")}`,
        receiptDetails: { rejectionCode: "POLICY_REFUSED" },
      }),
    );

    expect(result.outcome).toBe("REJECTED_MISMATCH");
    expect(result.reconciliationState).toBe("MISMATCH");
    expect(result.payloadDisposed).toBe(false);

    const pub = await pubRow(s.publicationId);
    expect(pub?.reconciliationState).toBe("MISMATCH");
    expect(pub?.remediationState).toBe("REQUIRED");
    expect((await outboxRow(s.outboxId))?.payload).not.toBeNull();
  });

  // — Idempotency and conflicts —

  it("17-18. an identical replay reports IDEMPOTENT_REPLAY and creates no duplicate", async () => {
    const s = await seedDispatched();
    const envelope = envelopeFor(s, s.submissionAttemptId);

    const first = await ingest(envelope);
    expect(first.outcome).toBe("ACCEPTED_MATCHED");

    const replay = await ingest(envelope);
    expect(replay.outcome).toBe("IDEMPOTENT_REPLAY");
    expect(await db.registrarReceipt.count()).toBe(1);
    // The state reached by the first call is unchanged.
    expect((await pubRow(s.publicationId))?.registrationState).toBe("ACCEPTED");
  });

  it("19. a conflicting receiptId replay fails without mutating anything", async () => {
    const s = await seedDispatched();
    const envelope = envelopeFor(s, s.submissionAttemptId);
    await ingest(envelope);

    const before = await pubRow(s.publicationId);
    await expect(
      ingest({ ...envelope, registeredAt: "2026-09-02T00:00:00.000Z" }),
    ).rejects.toBeInstanceOf(ReceiptConflictError);

    const after = await pubRow(s.publicationId);
    expect(after?.registrationState).toBe(before?.registrationState);
    expect(await db.registrarReceipt.count()).toBe(1);
  });

  it("20. a second receipt for an already-answered attempt is refused", async () => {
    const s = await seedDispatched();
    await ingest(envelopeFor(s, s.submissionAttemptId));
    // A different receiptId AND a different registration id for the same attempt.
    await expect(
      ingest(
        envelopeFor(s, s.submissionAttemptId, { registrarRegistrationId: "synthetic-reg-other" }),
      ),
    ).rejects.toBeInstanceOf(AttemptAlreadyHasReceiptError);
    expect(await db.registrarReceipt.count()).toBe(1);
  });

  // — Attempt state —

  it("21. a PREPARED attempt is refused", async () => {
    const s = await seedPrepared();
    await expect(ingest(envelopeFor(s, s.submissionAttemptId))).rejects.toBeInstanceOf(
      AttemptNotDispatchedError,
    );
    expect(await db.registrarReceipt.count()).toBe(0);
  });

  it("22. an ABANDONED attempt is refused", async () => {
    const s = await seedDispatched();
    await attempts.markPublicationSubmissionAttemptAbandoned({
      submissionAttemptId: s.submissionAttemptId,
      abandonedAt: "2026-09-01T01:30:00.000Z",
    });
    await expect(ingest(envelopeFor(s, s.submissionAttemptId))).rejects.toBeInstanceOf(
      AttemptAbandonedError,
    );
    expect(await db.registrarReceipt.count()).toBe(0);
  });

  // — Binding —

  it("23. a receipt naming the wrong publication is refused", async () => {
    const a = await seedDispatched();
    const b = await seedDispatched();
    await expect(
      ingest(envelopeFor(a, a.submissionAttemptId, { publicationId: b.publicationId })),
    ).rejects.toBeInstanceOf(ReceiptAttemptMismatchError);
    expect(await db.registrarReceipt.count()).toBe(0);
  });

  it("24. a receipt naming another publication's attempt is refused", async () => {
    const a = await seedDispatched();
    const b = await seedDispatched();
    // The attempt belongs to b's outbox, but the envelope claims a's publication.
    await expect(ingest(envelopeFor(a, b.submissionAttemptId))).rejects.toBeInstanceOf(
      ReceiptAttemptMismatchError,
    );
    expect(await db.registrarReceipt.count()).toBe(0);
  });

  it("25. a receipt from an unexpected Registrar is refused before recording", async () => {
    const s = await seedDispatched();
    await expect(
      ingest(envelopeFor(s, s.submissionAttemptId), {
        expectedRegistrarId: "an:registrar:some-other-registrar",
      }),
    ).rejects.toBeInstanceOf(ExpectedRegistrarMismatchError);
    expect(await db.registrarReceipt.count()).toBe(0);
  });

  it("25b. a matching expected Registrar is accepted", async () => {
    const s = await seedDispatched();
    const result = await ingest(envelopeFor(s, s.submissionAttemptId), {
      expectedRegistrarId: MONACADO_REGISTRAR_ID,
    });
    expect(result.outcome).toBe("ACCEPTED_MATCHED");
  });

  // — Envelope hygiene —

  it("26. unknown envelope keys fail", async () => {
    const s = await seedDispatched();
    await expect(
      ingest({ ...envelopeFor(s, s.submissionAttemptId), somethingExtra: "x" }),
    ).rejects.toBeInstanceOf(InvalidReceiptEnvelopeError);
    expect(await db.registrarReceipt.count()).toBe(0);
  });

  it("27. payload, token, credential, and row-id fields are refused", async () => {
    const s = await seedDispatched();
    for (const forbidden of [
      { payload: { capsule: "anything" } },
      { lockToken: `mon:lock:${pad26("ITOKEN")}` },
      { claimTokenHash: "sha256:" + "0".repeat(64) },
      { id: 1 },
      { authorization: "Bearer fake-token" },
      { receiptDetails: { registrarStatusCode: "OK", extraBag: "x" } },
    ]) {
      await expect(
        ingest({ ...envelopeFor(s, s.submissionAttemptId), ...forbidden }),
      ).rejects.toBeInstanceOf(InvalidReceiptEnvelopeError);
    }
    expect(await db.registrarReceipt.count()).toBe(0);
  });

  // — Transport response mapping —

  it("28. an incomplete transport response cannot be treated as a receipt", async () => {
    const bare: RegisterResponseEnvelope = {
      protocol: "monacado.registrar",
      version: "1.0",
      operation: "REGISTER",
      submissionAttemptId: `mon:attempt:${pad26("IATT900")}`,
      status: "ACCEPTED",
    } as RegisterResponseEnvelope;

    const mapped = mapRegistrarTransportResponseToReceiptEnvelope(bare, {
      receiptId: `mon:rcpt:${pad26("IRCPT900")}`,
      publicationId: `mon:pub:${pad26("IPUB900")}`,
    });
    expect(mapped.authoritative).toBe(false);
    if (mapped.authoritative) return;
    // Nothing is invented — every missing field is reported by name.
    for (const field of [
      "registrarId",
      "nodeId",
      "capsuleId",
      "registeredContentHash",
      "registeredAt",
      "registrarRegistrationId",
    ]) {
      expect(mapped.missingFields).toContain(field);
    }
  });

  it("29. a complete authoritative response maps deterministically and ingests", async () => {
    const s = await seedDispatched();
    const response: RegisterResponseEnvelope = {
      protocol: "monacado.registrar",
      version: "1.0",
      operation: "REGISTER",
      submissionAttemptId: s.submissionAttemptId,
      status: "ACCEPTED",
      registrarRegistrationId: "synthetic-reg-mapped",
      registrarId: MONACADO_REGISTRAR_ID,
      nodeId: s.nodeId,
      capsuleId: s.capsuleId,
      registeredContentHash: s.publishedContentHash,
      registeredAt: REGISTERED_AT,
      statusCode: "REGISTERED",
    } as RegisterResponseEnvelope;

    const context = {
      receiptId: nextReceiptId(),
      publicationId: s.publicationId,
    };
    const first = mapRegistrarTransportResponseToReceiptEnvelope(response, context);
    const second = mapRegistrarTransportResponseToReceiptEnvelope(response, context);
    expect(first.authoritative).toBe(true);
    // Pure and total: identical input, byte-equal output.
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    if (!first.authoritative) return;

    const result = await ingest(first.envelope, { source: "TRANSPORT_RESPONSE" });
    expect(result.outcome).toBe("ACCEPTED_MATCHED");
  });

  // — Delegation and isolation —

  it("30. the existing receipt service is called exactly once", async () => {
    const s = await seedDispatched();
    const real = new RegistrarReceiptService(db);
    let calls = 0;
    const counting = {
      recordRegistrarReceipt: async (input: unknown) => {
        calls += 1;
        return real.recordRegistrarReceipt(input);
      },
    } as unknown as RegistrarReceiptService;

    await ingestRegistrarReceipt(
      {
        envelope: envelopeFor(s, s.submissionAttemptId),
        receivedAt: RECEIVED_AT,
        source: "MANUAL",
      },
      { db, receipts: counting },
    );
    expect(calls).toBe(1);
  });

  it("31. no network call or credential lookup occurs", async () => {
    const s = await seedDispatched();
    const realFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = ((...args: unknown[]) => {
      fetchCalls += 1;
      return (realFetch as (...a: unknown[]) => unknown)(...args);
    }) as typeof fetch;
    try {
      await ingest(envelopeFor(s, s.submissionAttemptId));
    } finally {
      globalThis.fetch = realFetch;
    }
    expect(fetchCalls).toBe(0);
  });

  it("31b. the ingestion module reads no environment variable", async () => {
    // A structural assertion: the module source contains no process.env access.
    const { readFileSync } = await import("node:fs");
    const raw = readFileSync("src/server/product/receipt-ingestion-service.ts", "utf8");
    // Strip comments first: the module's own doc comment says it reads no
    // process.env, and a naive grep would trip on that sentence.
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("process.env");
    expect(code).not.toContain("NEXT_PUBLIC");
  });

  // — Leakage —

  it("32. results and errors expose no payload, body, hash value, token, or credential", async () => {
    const s = await seedDispatched();
    const result = await ingest(
      envelopeFor(s, s.submissionAttemptId, { capsuleId: `an:capsule:${pad26("IWRONGCAP2")}` }),
    );
    const serialized = JSON.stringify(result);
    // Field NAMES are reported; the hash VALUES on either side are not.
    expect(result.mismatchedFields.length).toBeGreaterThan(0);
    // Hash VALUES and secret-bearing keys must be absent. `payloadDisposed` is
    // a legitimate boolean flag, so the check is for the payload KEY, not the
    // substring — and for the hash values themselves rather than field names.
    for (const forbidden of [
      s.publishedContentHash,
      s.payloadHash,
      "Bearer",
      "lockToken",
      "claimTokenHash",
      '"payload"',
      "sha256:",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    try {
      await ingest({ ...envelopeFor(s, s.submissionAttemptId), payload: { secret: "x" } });
    } catch (error) {
      const text = `${(error as Error).message} ${JSON.stringify(error)}`;
      expect(text).not.toContain("secret");
      expect(Object.keys(error as object)).not.toContain("internalCause");
    }
  });
});
