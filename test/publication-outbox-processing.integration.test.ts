/**
 * Publication-outbox claiming, retry, and terminal-state integration tests
 * (Phase 0E.3).
 *
 * Run ONLY against the disposable local MySQL (RUN_DB_TESTS=1). Self-skips
 * otherwise. Never point at production.
 */

import "dotenv/config";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { ProductSourceRecord } from "../src/contracts/index";
import { MONACADO_PUBLISHER_ID, canonicalHash } from "../src/contracts/index";
import { getPrisma, disconnectPrisma } from "../src/server/db/client";
import { ProductRepository } from "../src/server/product/product-repository";
import {
  MONACADO_REGISTRAR_ID,
  ProductNodeRepository,
} from "../src/server/product/product-node-repository";
import { ProductPublicationService } from "../src/server/product/product-publication-service";
import { PublicationOutboxRepository } from "../src/server/product/publication-outbox-repository";
import {
  InvalidOutboxTransitionError,
  NoEligibleOutboxItemError,
  OutboxClaimConflictError,
  OutboxLockTokenMismatchError,
  OutboxNotFoundError,
  UnsafeErrorMetadataError,
} from "../src/server/product/outbox-errors";

const RUN = process.env.RUN_DB_TESTS === "1";
const pad26 = (s: string): string =>
  (s.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

/**
 * OBVIOUSLY SYNTHETIC unsafe-content fixtures. These are negative-test inputs
 * that must be REFUSED — not real credentials, hosts, or databases. The host is
 * an RFC 5737 documentation address and the database name is fictional, so no
 * real deployment coordinate appears in the repository.
 */
const SYNTHETIC_HOST = "198.51.100.7:9999";
const SYNTHETIC_DATABASE = "synthetic_disposable_db";
const SYNTHETIC_PASSWORD = "SYNTHETIC-NOT-A-REAL-PASSWORD";
const SYNTHETIC_CONNECTION_STRING = `mysql://synthetic-user:${SYNTHETIC_PASSWORD}@${SYNTHETIC_HOST}/${SYNTHETIC_DATABASE}`;

const T0 = "2026-03-01T00:00:00.000Z";
const T1 = "2026-03-01T01:00:00.000Z";
const T2 = "2026-03-01T02:00:00.000Z";
const FUTURE = "2026-06-01T00:00:00.000Z";

let n = 0;
function syntheticRecord(): ProductSourceRecord {
  n += 1;
  return {
    sourceRecordId: `mon:srec:${pad26(`X${n}SREC`)}`,
    sourceRecordVersion: "1",
    internalProductId: `mon:product:${pad26(`X${n}PRD`)}`,
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    authority: {
      creatorId: `mon:creator:${pad26(`X${n}CRTR`)}`,
      authorityScope: "product-facts",
      authorizationState: "authorized",
    },
    facts: {
      name: "Outbox processing fixture product",
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      relationships: { creator: `an:node:${pad26(`X${n}CNDE`)}` },
    },
    capsuleSemver: "1.0.0",
    mappingVersion: "0e.3.0.0",
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

let idSeq = 0;

/**
 * Prepare one publication with a PENDING outbox item, available at `availableAt`.
 * Returns the outboxId and publicationId.
 */
async function seedOutboxItem(
  availableAt: string = T0,
): Promise<{ outboxId: string; publicationId: string; payloadHash: string }> {
  const record = syntheticRecord();
  await repo.createInitialProductSourceRecord({ record });
  const node = await nodes.issueProductNode({
    nodeId: `an:node:${pad26(`X${n}NODE`)}`,
    internalProductId: record.internalProductId,
    nodeKind: "product",
    nodePolicyRef: "an:policy:node:synthetic-0e3",
    nodePolicyVersion: "1.0.0",
    registrarId: MONACADO_REGISTRAR_ID,
    issuedAt: "2026-01-02T00:00:00.000Z",
  });
  idSeq += 1;
  const result = await pubs.prepareProductPublication({
    publicationId: `mon:pub:${pad26(`XPUB${idSeq}`)}`,
    internalProductId: record.internalProductId,
    sourceRecordId: record.sourceRecordId,
    sourceRecordVersion: "1",
    nodeId: node.nodeId,
    capsuleId: `an:capsule:${pad26(`XCAP${idSeq}`)}`,
    capsuleSemver: record.capsuleSemver,
    publishedBy: MONACADO_PUBLISHER_ID,
    publishedAt: "2026-02-01T00:00:00.000Z",
    nodePolicy: { ref: "an:policy:node:synthetic-0e3", version: "1.0.0" },
    capsulePolicy: { ref: "an:policy:capsule:synthetic-0e3", version: "1.0.0" },
    availableAt,
  });
  return {
    outboxId: result.outbox.outboxId,
    publicationId: result.publication.publicationId,
    payloadHash: result.outbox.payloadHash,
  };
}

/** Claim the single due item. */
const claim = (now = T1) => outbox.claimNextPublicationOutbox({ now });

const SAFE_ERROR = { errorCode: "SUBMISSION_TIMEOUT", errorSummary: "Attempt timed out awaiting acknowledgement." };

/** Remove every row in FK-safe order (all publication FKs are RESTRICT). */
async function wipe(): Promise<void> {
  await db.publicationOutbox.deleteMany({});
  await db.productPublication.deleteMany({});
  await db.productNode.deleteMany({});
  await db.productSourceRecordVersionRow.deleteMany({});
  await db.product.deleteMany({});
}

describe.skipIf(!RUN)("Publication outbox claiming and retry state (integration)", () => {
  beforeEach(wipe);
  afterAll(async () => {
    // Leave the database empty: suites that run after this one clean up in an
    // order that predates ProductPublication, so leftover publication rows would
    // block their Node/Product deletes on the RESTRICT foreign keys.
    await wipe();
    await disconnectPrisma();
  });

  it("1. a pending item can be claimed", async () => {
    const { outboxId } = await seedOutboxItem();
    const claimed = await claim();
    expect(claimed.outbox.outboxId).toBe(outboxId);
    expect(claimed.outbox.outboxStatus).toBe("PROCESSING");
  });

  it("2. a retryable item can be claimed once due", async () => {
    const { outboxId } = await seedOutboxItem();
    const first = await claim(T1);
    await outbox.markPublicationOutboxRetryable({
      outboxId,
      lockToken: first.lockToken,
      availableAt: T2,
      ...SAFE_ERROR,
    });
    const second = await outbox.claimNextPublicationOutbox({ now: T2 });
    expect(second.outbox.outboxId).toBe(outboxId);
    expect(second.outbox.outboxStatus).toBe("PROCESSING");
  });

  it("3. a retryable item scheduled in the future is not claimable", async () => {
    const { outboxId } = await seedOutboxItem();
    const first = await claim(T1);
    await outbox.markPublicationOutboxRetryable({
      outboxId,
      lockToken: first.lockToken,
      availableAt: FUTURE,
      ...SAFE_ERROR,
    });
    await expect(outbox.claimNextPublicationOutbox({ now: T2 })).rejects.toBeInstanceOf(
      NoEligibleOutboxItemError,
    );
  });

  it("3b. a pending item is not claimable before availableAt", async () => {
    await seedOutboxItem(FUTURE);
    await expect(claim(T1)).rejects.toBeInstanceOf(NoEligibleOutboxItemError);
  });

  it("4. claim ordering is deterministic (availableAt, then creation order)", async () => {
    // Seeded newest-available first so creation order alone would pick wrongly.
    const later = await seedOutboxItem(T2);
    const earlierA = await seedOutboxItem(T0);
    const earlierB = await seedOutboxItem(T0);

    const first = await claim(FUTURE);
    const second = await claim(FUTURE);
    const third = await claim(FUTURE);

    // Both T0 items precede the T2 item; among equal availableAt, creation order.
    expect(first.outbox.outboxId).toBe(earlierA.outboxId);
    expect(second.outbox.outboxId).toBe(earlierB.outboxId);
    expect(third.outbox.outboxId).toBe(later.outboxId);
  });

  it("5,6. attemptCount increments and lockedAt/lockToken are set", async () => {
    const { outboxId } = await seedOutboxItem();
    const before = await outbox.getPublicationOutboxById(outboxId);
    expect(before.attemptCount).toBe(0);
    expect(before.lockToken).toBeUndefined();
    expect(before.lockedAt).toBeUndefined();

    const claimed = await claim(T1);
    expect(claimed.outbox.attemptCount).toBe(1);
    expect(claimed.outbox.lockToken).toBe(claimed.lockToken);
    expect(claimed.lockToken).toMatch(/^mon:lock:[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(claimed.outbox.lockedAt).toBe(T1);

    // A second attempt after a retry increments again.
    await outbox.markPublicationOutboxRetryable({
      outboxId,
      lockToken: claimed.lockToken,
      availableAt: T2,
      ...SAFE_ERROR,
    });
    const reclaimed = await outbox.claimNextPublicationOutbox({ now: T2 });
    expect(reclaimed.outbox.attemptCount).toBe(2);
  });

  it("7. concurrent claims on one item yield exactly one winner", async () => {
    await seedOutboxItem();
    // Four concurrent claimers against a single eligible item.
    const results = await Promise.allSettled([claim(T1), claim(T1), claim(T1), claim(T1)]);
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(3);
    // Exactly one claim was recorded.
    const rows = await db.publicationOutbox.findMany({});
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attemptCount).toBe(1);
    expect(rows[0]!.outboxStatus).toBe("PROCESSING");
  });

  it("8. a claimed item cannot be claimed again", async () => {
    await seedOutboxItem();
    await claim(T1);
    await expect(claim(T1)).rejects.toBeInstanceOf(NoEligibleOutboxItemError);
  });

  it("9,10,11. a wrong lock token cannot retry, complete, or dead-letter", async () => {
    const { outboxId } = await seedOutboxItem();
    await claim(T1);
    const wrong = `mon:lock:${pad26("WRONGTOKEN")}`;

    await expect(
      outbox.markPublicationOutboxRetryable({ outboxId, lockToken: wrong, availableAt: T2, ...SAFE_ERROR }),
    ).rejects.toBeInstanceOf(OutboxLockTokenMismatchError);
    await expect(
      outbox.markPublicationOutboxCompleted({ outboxId, lockToken: wrong, completedAt: T2 }),
    ).rejects.toBeInstanceOf(OutboxLockTokenMismatchError);
    await expect(
      outbox.markPublicationOutboxDeadLetter({ outboxId, lockToken: wrong, ...SAFE_ERROR }),
    ).rejects.toBeInstanceOf(OutboxLockTokenMismatchError);

    // The claim is untouched.
    const still = await outbox.getPublicationOutboxById(outboxId);
    expect(still.outboxStatus).toBe("PROCESSING");
  });

  it("12,13,14,15. retry succeeds, clears the lock, stores safe metadata, preserves payload", async () => {
    const { outboxId, payloadHash } = await seedOutboxItem();
    const claimed = await claim(T1);
    const payloadBefore = claimed.outbox.payload;

    const retried = await outbox.markPublicationOutboxRetryable({
      outboxId,
      lockToken: claimed.lockToken,
      availableAt: T2,
      ...SAFE_ERROR,
    });

    expect(retried.outboxStatus).toBe("RETRYABLE");
    expect(retried.lockToken).toBeUndefined();
    expect(retried.lockedAt).toBeUndefined();
    expect(retried.availableAt).toBe(T2);
    expect(retried.lastErrorCode).toBe(SAFE_ERROR.errorCode);
    expect(retried.lastErrorSummary).toBe(SAFE_ERROR.errorSummary);
    expect(retried.completedAt).toBeUndefined();
    // Payload and its hash are untouched.
    expect(retried.payload).toEqual(payloadBefore);
    expect(retried.payloadHash).toBe(payloadHash);
    expect(retried.payloadHash).toBe(canonicalHash(retried.payload));
  });

  it("16. a retried item can later be reclaimed", async () => {
    const { outboxId } = await seedOutboxItem();
    const first = await claim(T1);
    await outbox.markPublicationOutboxRetryable({
      outboxId,
      lockToken: first.lockToken,
      availableAt: T2,
      ...SAFE_ERROR,
    });
    const second = await outbox.claimNextPublicationOutbox({ now: T2 });
    expect(second.outbox.outboxId).toBe(outboxId);
    expect(second.lockToken).not.toBe(first.lockToken);
  });

  it("17,18,19. completion succeeds, sets completedAt, preserves payload", async () => {
    const { outboxId, publicationId, payloadHash } = await seedOutboxItem();
    const claimed = await claim(T1);
    const payloadBefore = claimed.outbox.payload;

    const completed = await outbox.markPublicationOutboxCompleted({
      outboxId,
      lockToken: claimed.lockToken,
      completedAt: T2,
    });

    expect(completed.outboxStatus).toBe("COMPLETED");
    expect(completed.completedAt).toBe(T2);
    expect(completed.lockToken).toBeUndefined();
    expect(completed.lockedAt).toBeUndefined();
    expect(completed.payload).toEqual(payloadBefore);
    expect(completed.payloadHash).toBe(payloadHash);

    // Publication status is untouched by outbox processing.
    const publication = await pubs.getProductPublication(publicationId);
    expect(publication.publicationStatus).toBe("QUEUED");
  });

  it("20,21. dead-letter succeeds and preserves the payload", async () => {
    const { outboxId, publicationId, payloadHash } = await seedOutboxItem();
    const claimed = await claim(T1);
    const payloadBefore = claimed.outbox.payload;

    const dead = await outbox.markPublicationOutboxDeadLetter({
      outboxId,
      lockToken: claimed.lockToken,
      errorCode: "UNRECOVERABLE_REJECTION",
      errorSummary: "Attempt rejected without a retryable condition.",
    });

    expect(dead.outboxStatus).toBe("DEAD_LETTER");
    expect(dead.lockToken).toBeUndefined();
    expect(dead.lockedAt).toBeUndefined();
    expect(dead.completedAt).toBeUndefined();
    expect(dead.lastErrorCode).toBe("UNRECOVERABLE_REJECTION");
    expect(dead.payload).toEqual(payloadBefore);
    expect(dead.payloadHash).toBe(payloadHash);

    const publication = await pubs.getProductPublication(publicationId);
    expect(publication.publicationStatus).toBe("QUEUED");
  });

  it("22. pending -> cancelled succeeds", async () => {
    const { outboxId } = await seedOutboxItem();
    const cancelled = await outbox.cancelPublicationOutbox({ outboxId });
    expect(cancelled.outboxStatus).toBe("CANCELLED");
  });

  it("23. retryable -> cancelled succeeds", async () => {
    const { outboxId } = await seedOutboxItem();
    const claimed = await claim(T1);
    await outbox.markPublicationOutboxRetryable({
      outboxId,
      lockToken: claimed.lockToken,
      availableAt: T2,
      ...SAFE_ERROR,
    });
    const cancelled = await outbox.cancelPublicationOutbox({ outboxId });
    expect(cancelled.outboxStatus).toBe("CANCELLED");
  });

  it("24,25,26. completed / dead-lettered / cancelled items cannot be claimed", async () => {
    // COMPLETED
    const a = await seedOutboxItem();
    const ca = await claim(T1);
    await outbox.markPublicationOutboxCompleted({
      outboxId: a.outboxId,
      lockToken: ca.lockToken,
      completedAt: T2,
    });
    await expect(claim(FUTURE)).rejects.toBeInstanceOf(NoEligibleOutboxItemError);

    // DEAD_LETTER
    const b = await seedOutboxItem();
    const cb = await claim(T1);
    await outbox.markPublicationOutboxDeadLetter({
      outboxId: b.outboxId,
      lockToken: cb.lockToken,
      ...SAFE_ERROR,
    });
    await expect(claim(FUTURE)).rejects.toBeInstanceOf(NoEligibleOutboxItemError);

    // CANCELLED
    const c = await seedOutboxItem();
    await outbox.cancelPublicationOutbox({ outboxId: c.outboxId });
    await expect(claim(FUTURE)).rejects.toBeInstanceOf(NoEligibleOutboxItemError);
  });

  it("27. invalid state transitions fail", async () => {
    const { outboxId } = await seedOutboxItem();

    // PENDING -> COMPLETED / RETRYABLE / DEAD_LETTER are all invalid.
    const anyToken = `mon:lock:${pad26("ANYTOKEN")}`;
    await expect(
      outbox.markPublicationOutboxCompleted({ outboxId, lockToken: anyToken, completedAt: T2 }),
    ).rejects.toBeInstanceOf(InvalidOutboxTransitionError);
    await expect(
      outbox.markPublicationOutboxRetryable({ outboxId, lockToken: anyToken, availableAt: T2, ...SAFE_ERROR }),
    ).rejects.toBeInstanceOf(InvalidOutboxTransitionError);
    await expect(
      outbox.markPublicationOutboxDeadLetter({ outboxId, lockToken: anyToken, ...SAFE_ERROR }),
    ).rejects.toBeInstanceOf(InvalidOutboxTransitionError);

    // PROCESSING -> CANCELLED is not permitted (the owner must resolve it).
    await claim(T1);
    await expect(outbox.cancelPublicationOutbox({ outboxId })).rejects.toBeInstanceOf(
      InvalidOutboxTransitionError,
    );
  });

  it("28. terminal states cannot transition", async () => {
    const { outboxId } = await seedOutboxItem();
    const claimed = await claim(T1);
    await outbox.markPublicationOutboxCompleted({
      outboxId,
      lockToken: claimed.lockToken,
      completedAt: T2,
    });

    for (const attempt of [
      () =>
        outbox.markPublicationOutboxCompleted({
          outboxId,
          lockToken: claimed.lockToken,
          completedAt: T2,
        }),
      () =>
        outbox.markPublicationOutboxRetryable({
          outboxId,
          lockToken: claimed.lockToken,
          availableAt: FUTURE,
          ...SAFE_ERROR,
        }),
      () =>
        outbox.markPublicationOutboxDeadLetter({
          outboxId,
          lockToken: claimed.lockToken,
          ...SAFE_ERROR,
        }),
      () => outbox.cancelPublicationOutbox({ outboxId }),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(InvalidOutboxTransitionError);
    }
  });

  it("29. error metadata rejects credentials, hashes, capsule content, and oversized text", async () => {
    const { outboxId } = await seedOutboxItem();
    const claimed = await claim(T1);

    const unsafeSummaries = [
      `failed connecting to ${SYNTHETIC_CONNECTION_STRING}`,
      "DATABASE_URL was unreachable",
      `password: ${SYNTHETIC_PASSWORD} rejected`,
      `hash mismatch sha256:${"a".repeat(64)}`,
      'payload was {"@context":["https://example.com"],"@type":"Product"}',
      "x".repeat(257),
    ];
    for (const errorSummary of unsafeSummaries) {
      await expect(
        outbox.markPublicationOutboxRetryable({
          outboxId,
          lockToken: claimed.lockToken,
          availableAt: T2,
          errorCode: "SUBMISSION_FAILED",
          errorSummary,
        }),
      ).rejects.toBeInstanceOf(UnsafeErrorMetadataError);
    }

    // Malformed codes are refused too.
    for (const errorCode of ["lowercase_code", "has spaces", "x".repeat(65)]) {
      await expect(
        outbox.markPublicationOutboxDeadLetter({
          outboxId,
          lockToken: claimed.lockToken,
          errorCode,
          errorSummary: "A safe summary.",
        }),
      ).rejects.toBeInstanceOf(UnsafeErrorMetadataError);
    }

    // Nothing was persisted by any refused attempt.
    const unchanged = await outbox.getPublicationOutboxById(outboxId);
    expect(unchanged.outboxStatus).toBe("PROCESSING");
    expect(unchanged.lastErrorCode).toBeUndefined();
    expect(unchanged.lastErrorSummary).toBeUndefined();
  });

  it("30. error serialisation exposes no internal cause, credentials, or payload", async () => {
    const { outboxId } = await seedOutboxItem();
    const claimed = await claim(T1);
    try {
      await outbox.markPublicationOutboxRetryable({
        outboxId,
        lockToken: claimed.lockToken,
        availableAt: T2,
        errorCode: "SUBMISSION_FAILED",
        errorSummary: `connect failed for ${SYNTHETIC_CONNECTION_STRING}`,
      });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as UnsafeErrorMetadataError;
      expect(err).toBeInstanceOf(UnsafeErrorMetadataError);
      const serialised = `${JSON.stringify(err)} ${JSON.stringify({ ...err })} ${String(err)}`;
      expect(serialised).not.toContain("internalCause");
      expect(serialised.toLowerCase()).not.toContain("mysql://");
      expect(serialised).not.toContain(SYNTHETIC_HOST);
      expect(serialised).not.toContain(SYNTHETIC_DATABASE);
      expect(serialised).not.toContain(SYNTHETIC_PASSWORD);
      expect(serialised).not.toContain("@context");
      // The refusal names the rule class, not the offending value.
      expect(err.issues.join(" ")).toContain("connection-string");
      expect(err.code).toBe("UNSAFE_ERROR_METADATA");
    }
  });

  it("30b. a lock-token mismatch never echoes either token", async () => {
    const { outboxId } = await seedOutboxItem();
    const claimed = await claim(T1);
    const wrong = `mon:lock:${pad26("SECRETTOKEN")}`;
    try {
      await outbox.markPublicationOutboxCompleted({ outboxId, lockToken: wrong, completedAt: T2 });
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as Error;
      const serialised = `${JSON.stringify(err)} ${err.message}`;
      expect(serialised).not.toContain(wrong);
      expect(serialised).not.toContain(claimed.lockToken);
      expect(e).toBeInstanceOf(OutboxLockTokenMismatchError);
    }
  });

  it("31. an unknown outboxId is reported as not found", async () => {
    await expect(
      outbox.getPublicationOutboxById(`mon:obx:${pad26("NOSUCHITEM")}`),
    ).rejects.toBeInstanceOf(OutboxNotFoundError);
    await expect(
      outbox.cancelPublicationOutbox({ outboxId: `mon:obx:${pad26("NOSUCHITEM")}` }),
    ).rejects.toBeInstanceOf(OutboxNotFoundError);
  });

  it("32. a stale worker cannot resolve a claim taken over after retry", async () => {
    const { outboxId } = await seedOutboxItem();
    const stale = await claim(T1);
    await outbox.markPublicationOutboxRetryable({
      outboxId,
      lockToken: stale.lockToken,
      availableAt: T2,
      ...SAFE_ERROR,
    });
    const fresh = await outbox.claimNextPublicationOutbox({ now: T2 });
    expect(fresh.lockToken).not.toBe(stale.lockToken);

    // The stale worker's token no longer owns the claim.
    await expect(
      outbox.markPublicationOutboxCompleted({
        outboxId,
        lockToken: stale.lockToken,
        completedAt: FUTURE,
      }),
    ).rejects.toBeInstanceOf(OutboxLockTokenMismatchError);

    // The current owner still can.
    const done = await outbox.markPublicationOutboxCompleted({
      outboxId,
      lockToken: fresh.lockToken,
      completedAt: FUTURE,
    });
    expect(done.outboxStatus).toBe("COMPLETED");
  });

  it("33. no receipt, registration, or reconciliation columns exist", async () => {
    const rows = await db.$queryRawUnsafe<Array<{ COLUMN_NAME: string }>>(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'PublicationOutbox'",
    );
    const cols = rows.map((r) => r.COLUMN_NAME.toLowerCase());
    expect(cols).toContain("locktoken");
    for (const forbidden of ["receipt", "registrat", "reconcil", "resolver", "lease", "expires"]) {
      expect(cols.some((c) => c.includes(forbidden))).toBe(false);
    }
  });

  it("34. an item that is only PROCESSING blocks a claim conflict, not a silent overwrite", async () => {
    const { outboxId } = await seedOutboxItem();
    const claimed = await claim(T1);

    // Simulate the row being resolved between another caller's checks and its
    // guarded update: the guard must refuse rather than overwrite.
    await db.publicationOutbox.updateMany({
      where: { outboxId },
      data: { outboxStatus: "COMPLETED", lockToken: null, lockedAt: null, completedAt: new Date(T2) },
    });
    await expect(
      outbox.markPublicationOutboxCompleted({
        outboxId,
        lockToken: claimed.lockToken,
        completedAt: FUTURE,
      }),
    ).rejects.toBeInstanceOf(InvalidOutboxTransitionError);
  });
});

/** Guard: OutboxClaimConflictError is exported and usable by callers. */
describe("outbox error surface", () => {
  it("exposes a claim-conflict error type", () => {
    const err = new OutboxClaimConflictError();
    expect(err.code).toBe("OUTBOX_CLAIM_CONFLICT");
    expect(JSON.stringify(err)).not.toContain("internalCause");
  });
});
