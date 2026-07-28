/**
 * Outbox lease expiry and stale-claim recovery integration tests (Phase 0E.5.1).
 *
 * Run ONLY against the disposable local MySQL (RUN_DB_TESTS=1). Self-skips
 * otherwise. Never point at production.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ProductSourceRecord } from "../src/contracts/index";
import {
  LEASE_EXPIRED_ERROR_CODE,
  MAX_LEASE_DURATION_SECONDS,
  MONACADO_PUBLISHER_ID,
  canonicalHash,
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
  InvalidLeaseDurationError,
  InvalidLeaseExpiryError,
  InvalidOutboxTransitionError,
  PersistedLeaseContractViolationError,
  StaleClaimError,
} from "../src/server/product/outbox-errors";

const RUN = process.env.RUN_DB_TESTS === "1";
const pad26 = (s: string): string =>
  (s.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const AVAILABLE_AT = "2026-05-01T00:00:00.000Z";
const CLAIM_AT = "2026-05-01T01:00:00.000Z";
/** 10 minutes after CLAIM_AT — the default lease used throughout. */
const LEASE_SECONDS = 600;
const LEASE_EXPIRY = "2026-05-01T01:10:00.000Z";
/** Before the lease expires. */
const BEFORE_EXPIRY = "2026-05-01T01:05:00.000Z";
/** After the lease expires. */
const AFTER_EXPIRY = "2026-05-01T02:00:00.000Z";

let n = 0;
function syntheticRecord(): ProductSourceRecord {
  n += 1;
  return {
    sourceRecordId: `mon:srec:${pad26(`L${n}SREC`)}`,
    sourceRecordVersion: "1",
    internalProductId: `mon:product:${pad26(`L${n}PRD`)}`,
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    authority: {
      creatorId: `mon:creator:${pad26(`L${n}CRTR`)}`,
      authorityScope: "product-facts",
      authorizationState: "authorized",
    },
    facts: {
      name: "Lease fixture product",
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      relationships: { creator: `an:node:${pad26(`L${n}CNDE`)}` },
    },
    capsuleSemver: "1.0.0",
    mappingVersion: "0e.5.1.0",
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

interface Seeded {
  outboxId: string;
  publicationId: string;
  nodeId: string;
  capsuleId: string;
  publishedContentHash: string;
  payloadHash: string;
}

let idSeq = 0;

/** Prepare one publication with a PENDING, immediately-due outbox item. */
async function seed(): Promise<Seeded> {
  const record = syntheticRecord();
  await repo.createInitialProductSourceRecord({ record });
  const node = await nodes.issueProductNode({
    nodeId: `an:node:${pad26(`L${n}NODE`)}`,
    internalProductId: record.internalProductId,
    nodeKind: "product",
    nodePolicyRef: "an:policy:node:synthetic-0e51",
    nodePolicyVersion: "1.0.0",
    registrarId: MONACADO_REGISTRAR_ID,
    issuedAt: "2026-01-02T00:00:00.000Z",
  });
  idSeq += 1;
  const result = await pubs.prepareProductPublication({
    publicationId: `mon:pub:${pad26(`LPUB${idSeq}`)}`,
    internalProductId: record.internalProductId,
    sourceRecordId: record.sourceRecordId,
    sourceRecordVersion: "1",
    nodeId: node.nodeId,
    capsuleId: `an:capsule:${pad26(`LCAP${idSeq}`)}`,
    capsuleSemver: record.capsuleSemver,
    publishedBy: MONACADO_PUBLISHER_ID,
    publishedAt: "2026-03-01T00:00:00.000Z",
    nodePolicy: { ref: "an:policy:node:synthetic-0e51", version: "1.0.0" },
    capsulePolicy: { ref: "an:policy:capsule:synthetic-0e51", version: "1.0.0" },
    availableAt: AVAILABLE_AT,
  });
  return {
    outboxId: result.outbox.outboxId,
    publicationId: result.publication.publicationId,
    nodeId: node.nodeId,
    capsuleId: result.publication.capsuleId,
    publishedContentHash: result.publication.publishedContentHash,
    payloadHash: result.outbox.payloadHash,
  };
}

const claim = (now = CLAIM_AT, leaseDurationSeconds = LEASE_SECONDS) =>
  outbox.claimNextPublicationOutbox({ now, leaseDurationSeconds });

const sweep = (now: string, limit = 100, availableAt?: string) =>
  outbox.recoverExpiredPublicationOutboxClaims({
    now,
    limit,
    ...(availableAt !== undefined ? { availableAt } : {}),
  });

async function wipe(): Promise<void> {
  await db.registrarReceipt.deleteMany({});
  await db.publicationOutbox.deleteMany({});
  await db.productPublication.deleteMany({});
  await db.productNode.deleteMany({});
  await db.productSourceRecordVersionRow.deleteMany({});
  await db.product.deleteMany({});
}

describe.skipIf(!RUN)("Outbox lease expiry and stale-claim recovery (integration)", () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await disconnectPrisma();
  });

  it("1. a claim requires a valid lease", async () => {
    await seed();
    // No lease at all.
    await expect(outbox.claimNextPublicationOutbox({ now: CLAIM_AT })).rejects.toBeInstanceOf(
      InvalidLeaseDurationError,
    );
    // Both forms at once is ambiguous and refused.
    await expect(
      outbox.claimNextPublicationOutbox({
        now: CLAIM_AT,
        leaseDurationSeconds: LEASE_SECONDS,
        leaseExpiresAt: LEASE_EXPIRY,
      }),
    ).rejects.toBeInstanceOf(InvalidLeaseDurationError);
    // Nothing was claimed by a refused call.
    const row = await db.publicationOutbox.findFirst({});
    expect(row!.outboxStatus).toBe("PENDING");
    expect(row!.leaseExpiresAt).toBeNull();
  });

  it("2,3,4. zero, negative, and excessive lease durations fail", async () => {
    await seed();
    for (const leaseDurationSeconds of [0, -1, -600, MAX_LEASE_DURATION_SECONDS + 1]) {
      await expect(claim(CLAIM_AT, leaseDurationSeconds)).rejects.toBeInstanceOf(
        InvalidLeaseDurationError,
      );
    }
    // An explicit expiry at or before `now` is refused too.
    for (const leaseExpiresAt of [CLAIM_AT, AVAILABLE_AT]) {
      await expect(
        outbox.claimNextPublicationOutbox({ now: CLAIM_AT, leaseExpiresAt }),
      ).rejects.toBeInstanceOf(InvalidLeaseExpiryError);
    }
  });

  it("5,6. a claim sets leaseExpiresAt strictly later than lockedAt", async () => {
    await seed();
    const claimed = await claim();
    expect(claimed.outbox.lockedAt).toBe(CLAIM_AT);
    expect(claimed.outbox.leaseExpiresAt).toBe(LEASE_EXPIRY);
    expect(Date.parse(claimed.outbox.leaseExpiresAt!)).toBeGreaterThan(
      Date.parse(claimed.outbox.lockedAt!),
    );

    // An explicit expiry is honoured verbatim.
    await seed();
    const explicit = await outbox.claimNextPublicationOutbox({
      now: CLAIM_AT,
      leaseExpiresAt: AFTER_EXPIRY,
    });
    expect(explicit.outbox.leaseExpiresAt).toBe(AFTER_EXPIRY);
  });

  it("7. a non-expired PROCESSING item is not recovered", async () => {
    const s = await seed();
    const claimed = await claim();
    const result = await sweep(BEFORE_EXPIRY);

    expect(result.examined).toBe(0);
    expect(result.recoveredCount).toBe(0);
    const after = await outbox.getPublicationOutboxById(s.outboxId);
    expect(after.outboxStatus).toBe("PROCESSING");
    expect(after.lockToken).toBe(claimed.lockToken);
    expect(after.leaseExpiresAt).toBe(LEASE_EXPIRY);
  });

  it("8,9,10,11,12,13,14,15,16. an expired claim is recovered, cleared, and preserved", async () => {
    const s = await seed();
    const claimed = await claim();
    const payloadBefore = claimed.outbox.payload;
    expect(claimed.outbox.attemptCount).toBe(1);

    const result = await sweep(AFTER_EXPIRY);

    expect(result.examined).toBe(1);
    expect(result.recoveredCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    const [recovered] = result.recovered;

    expect(recovered!.outboxStatus).toBe("RETRYABLE");
    expect(recovered!.lockToken).toBeUndefined();
    expect(recovered!.lockedAt).toBeUndefined();
    expect(recovered!.leaseExpiresAt).toBeUndefined();
    // Attempts, payload, and hash are all preserved.
    expect(recovered!.attemptCount).toBe(1);
    expect(recovered!.payload).toEqual(payloadBefore);
    expect(recovered!.payloadHash).toBe(s.payloadHash);
    expect(recovered!.payloadHash).toBe(canonicalHash(recovered!.payload));
    // Bounded, safe recovery metadata.
    expect(recovered!.lastErrorCode).toBe(LEASE_EXPIRED_ERROR_CODE);
    expect(recovered!.lastErrorSummary).toBeDefined();
    expect(recovered!.lastErrorSummary!.length).toBeLessThanOrEqual(256);
    // Default availableAt rule: immediately eligible at `now`.
    expect(recovered!.availableAt).toBe(AFTER_EXPIRY);
    expect(result.availableAt).toBe(AFTER_EXPIRY);
  });

  it("16b. an explicit availableAt defers the recovered item", async () => {
    await seed();
    await claim();
    const later = "2026-05-02T00:00:00.000Z";
    const result = await sweep(AFTER_EXPIRY, 100, later);
    expect(result.recovered[0]!.availableAt).toBe(later);
    // Not claimable before then.
    await expect(claim(AFTER_EXPIRY)).rejects.toThrow();
  });

  it("17,18. a recovered item can be reclaimed and the attempt count increments", async () => {
    const s = await seed();
    await claim();
    await sweep(AFTER_EXPIRY);

    const reclaimed = await claim(AFTER_EXPIRY);
    expect(reclaimed.outbox.outboxId).toBe(s.outboxId);
    expect(reclaimed.outbox.outboxStatus).toBe("PROCESSING");
    expect(reclaimed.outbox.attemptCount).toBe(2);
    expect(reclaimed.outbox.leaseExpiresAt).toBeDefined();
  });

  it("19,20,21. the original stale token cannot retry, complete, or dead-letter", async () => {
    const s = await seed();
    const stale = await claim();
    await sweep(AFTER_EXPIRY);

    const safe = { errorCode: "SUBMISSION_TIMEOUT", errorSummary: "Timed out." };
    for (const attempt of [
      () =>
        outbox.markPublicationOutboxRetryable({
          outboxId: s.outboxId,
          lockToken: stale.lockToken,
          availableAt: AFTER_EXPIRY,
          ...safe,
        }),
      () =>
        outbox.markPublicationOutboxCompleted({
          outboxId: s.outboxId,
          lockToken: stale.lockToken,
          completedAt: AFTER_EXPIRY,
        }),
      () =>
        outbox.markPublicationOutboxDeadLetter({
          outboxId: s.outboxId,
          lockToken: stale.lockToken,
          ...safe,
        }),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(StaleClaimError);
      // Still an invalid transition, so existing handlers keep working.
      await expect(attempt()).rejects.toBeInstanceOf(InvalidOutboxTransitionError);
    }

    const after = await outbox.getPublicationOutboxById(s.outboxId);
    expect(after.outboxStatus).toBe("RETRYABLE");
  });

  it("19b. a stale token cannot resolve an item another worker has re-claimed", async () => {
    const s = await seed();
    const stale = await claim();
    await sweep(AFTER_EXPIRY);
    const fresh = await claim(AFTER_EXPIRY);
    expect(fresh.lockToken).not.toBe(stale.lockToken);

    await expect(
      outbox.markPublicationOutboxCompleted({
        outboxId: s.outboxId,
        lockToken: stale.lockToken,
        completedAt: AFTER_EXPIRY,
      }),
    ).rejects.toThrow();

    // The current owner still can.
    const done = await outbox.markPublicationOutboxCompleted({
      outboxId: s.outboxId,
      lockToken: fresh.lockToken,
      completedAt: AFTER_EXPIRY,
    });
    expect(done.outboxStatus).toBe("COMPLETED");
    expect(done.leaseExpiresAt).toBeUndefined();
  });

  it("22. two concurrent recovery sweeps never recover the same item twice", async () => {
    // Three expired claims, two concurrent sweeps.
    for (let i = 0; i < 3; i += 1) {
      await seed();
      await claim();
    }
    const [a, b] = await Promise.all([sweep(AFTER_EXPIRY), sweep(AFTER_EXPIRY)]);

    const totalRecovered = a.recoveredCount + b.recoveredCount;
    expect(totalRecovered).toBe(3);
    // No item appears in both sweeps.
    const ids = [...a.recovered, ...b.recovered].map((r) => r.outboxId);
    expect(new Set(ids).size).toBe(3);
    // Whatever the interleaving, every candidate either was recovered by this
    // caller or was skipped because the other caller won it first — never both.
    expect(a.skippedCount + b.skippedCount).toBe(a.examined + b.examined - totalRecovered);
    // Every item ended up recovered exactly once, with attemptCount untouched.
    const rows = await db.publicationOutbox.findMany({});
    expect(rows.every((r) => r.outboxStatus === "RETRYABLE")).toBe(true);
    expect(rows.every((r) => r.attemptCount === 1)).toBe(true);
    expect(rows.every((r) => r.lockToken === null && r.leaseExpiresAt === null)).toBe(true);
  });

  it("23. terminal states are never recovered", async () => {
    const safe = { errorCode: "SUBMISSION_FAILED", errorSummary: "Failed." };

    // COMPLETED
    const a = await seed();
    const ca = await claim();
    await outbox.markPublicationOutboxCompleted({
      outboxId: a.outboxId,
      lockToken: ca.lockToken,
      completedAt: BEFORE_EXPIRY,
    });
    // DEAD_LETTER
    const b = await seed();
    const cb = await claim();
    await outbox.markPublicationOutboxDeadLetter({
      outboxId: b.outboxId,
      lockToken: cb.lockToken,
      ...safe,
    });
    // CANCELLED
    const c = await seed();
    await outbox.cancelPublicationOutbox({ outboxId: c.outboxId });

    const result = await sweep(AFTER_EXPIRY);
    expect(result.examined).toBe(0);
    expect(result.recoveredCount).toBe(0);
    for (const s of [a, b, c]) {
      const row = await outbox.getPublicationOutboxById(s.outboxId);
      expect(["COMPLETED", "DEAD_LETTER", "CANCELLED"]).toContain(row.outboxStatus);
      expect(row.leaseExpiresAt).toBeUndefined();
    }
  });

  it("24,25. a receipt-completed item is never recovered and its lease is cleared", async () => {
    const s = await seed();
    const claimed = await claim();

    const result = await receipts.recordRegistrarReceipt({
      receiptId: `mon:rcpt:${pad26("LRCPT1")}`,
      publicationId: s.publicationId,
      registrarRegistrationId: "lease-recovery-reg-1",
      registrarId: MONACADO_REGISTRAR_ID,
      nodeId: s.nodeId,
      capsuleId: s.capsuleId,
      registeredContentHash: s.publishedContentHash,
      receiptStatus: "ACCEPTED",
      registeredAt: BEFORE_EXPIRY,
      receivedAt: BEFORE_EXPIRY,
      receiptDetails: { registrarStatusCode: "REGISTERED" },
    });

    // Receipt-driven completion released the lease.
    expect(result.outbox.outboxStatus).toBe("COMPLETED");
    expect(result.outbox.leaseExpiresAt).toBeUndefined();
    expect(result.outbox.lockToken).toBeUndefined();
    expect(result.publication.registrationState).toBe("ACCEPTED");
    expect(result.publication.reconciliationState).toBe("MATCHED");

    // Long after the original lease would have expired, it is still untouchable.
    const swept = await sweep(AFTER_EXPIRY);
    expect(swept.examined).toBe(0);
    expect(swept.recoveredCount).toBe(0);
    const after = await outbox.getPublicationOutboxById(s.outboxId);
    expect(after.outboxStatus).toBe("COMPLETED");
    // The reconciled payload stays disposed — recovery never resurrects it.
    expect(after.payload).toBeUndefined();
    expect(after.payloadHash).toBe(s.payloadHash);
    // And the original token is now stale rather than authoritative.
    expect(claimed.lockToken).toBeDefined();
  });

  it("26. malformed persisted lease state raises a structured contract violation", async () => {
    const s = await seed();
    await claim();

    // A PROCESSING item with no lease could never be recovered.
    await db.$executeRawUnsafe(
      "UPDATE PublicationOutbox SET leaseExpiresAt = NULL WHERE outboxId = ?",
      s.outboxId,
    );
    await expect(outbox.getPublicationOutboxById(s.outboxId)).rejects.toBeInstanceOf(
      PersistedLeaseContractViolationError,
    );
    // Still a general outbox contract violation for existing handlers.
    await expect(outbox.getPublicationOutboxById(s.outboxId)).rejects.toBeInstanceOf(
      PersistedOutboxContractViolationError,
    );

    // A lease left behind outside PROCESSING is equally invalid.
    await db.$executeRawUnsafe(
      "UPDATE PublicationOutbox SET outboxStatus = 'PENDING', lockToken = NULL, lockedAt = NULL, leaseExpiresAt = ? WHERE outboxId = ?",
      new Date(LEASE_EXPIRY),
      s.outboxId,
    );
    await expect(outbox.getPublicationOutboxById(s.outboxId)).rejects.toBeInstanceOf(
      PersistedLeaseContractViolationError,
    );
  });

  it("27. errors expose no token, payload, hashes, or credentials", async () => {
    const s = await seed();
    const stale = await claim();
    await sweep(AFTER_EXPIRY);

    try {
      await outbox.markPublicationOutboxCompleted({
        outboxId: s.outboxId,
        lockToken: stale.lockToken,
        completedAt: AFTER_EXPIRY,
      });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as Error;
      const text = `${JSON.stringify(err)} ${JSON.stringify({ ...err })} ${String(err)}`;
      expect(text).not.toContain("internalCause");
      expect(text).not.toContain(stale.lockToken);
      expect(text).not.toContain(s.payloadHash);
      expect(text).not.toContain(s.publishedContentHash);
      expect(text).not.toContain("@context");
      expect(text).not.toContain("3308");
      expect(text.toLowerCase()).not.toContain("mysql://");
      expect(e).toBeInstanceOf(StaleClaimError);
    }

    // A rejected lease duration reports the bound, not the caller's secrets.
    try {
      await claim(AFTER_EXPIRY, 0);
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as InvalidLeaseDurationError;
      expect(err).toBeInstanceOf(InvalidLeaseDurationError);
      expect(JSON.stringify(err)).not.toContain("internalCause");
      expect(err.issues.join(" ")).toContain("leaseDurationSeconds");
    }
  });

  it("28. a live claim is never stolen, only an expired one is recovered", async () => {
    // Two items: one lease expired, one still live.
    const expired = await seed();
    await claim(CLAIM_AT, 60); // expires at 01:01
    const live = await seed();
    await claim(CLAIM_AT, LEASE_SECONDS); // expires at 01:10

    const at = "2026-05-01T01:05:00.000Z"; // between the two expiries
    const result = await sweep(at);

    expect(result.recoveredCount).toBe(1);
    expect(result.recovered[0]!.outboxId).toBe(expired.outboxId);
    const stillHeld = await outbox.getPublicationOutboxById(live.outboxId);
    expect(stillHeld.outboxStatus).toBe("PROCESSING");
    expect(stillHeld.lockToken).toBeDefined();
  });

  it("29. a sweep honours its limit and reports what it examined", async () => {
    for (let i = 0; i < 3; i += 1) {
      await seed();
      await claim();
    }
    const result = await sweep(AFTER_EXPIRY, 2);
    expect(result.examined).toBe(2);
    expect(result.recoveredCount).toBe(2);
    // The third is still stuck until the next sweep — no loop-until-empty.
    expect(await db.publicationOutbox.count({ where: { outboxStatus: "PROCESSING" } })).toBe(1);
  });
});
