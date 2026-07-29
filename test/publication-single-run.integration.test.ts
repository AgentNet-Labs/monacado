/**
 * Single-run publication orchestration integration tests (Phase 0E.6.3).
 *
 * Run ONLY against the disposable local MySQL (RUN_DB_TESTS=1). Self-skips
 * otherwise. Never point at production.
 *
 * NO EXTERNAL NETWORK. Every transport is an injected fake that records its
 * invocations, so "the transport was called exactly once" is an assertion rather
 * than a hope. All configuration is synthetic: RFC 2606 reserved hostnames, a
 * fabricated Registrar identifier, and an obviously fake secret.
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
import { PublicationRemediationService } from "../src/server/product/publication-remediation-service";
import { runOneProductPublication } from "../src/server/product/publication-run-service";
import {
  InvalidRunInputError,
  PostTransportPersistenceFailureError,
  RunRetryTimeRequiredError,
  RunStateConflictError,
  RuntimeNotReadyError,
} from "../src/server/product/publication-run-errors";
import { loadRegistrarRuntimeConfiguration } from "../src/server/registrar/registrar-runtime-config";
import {
  PublicationClosedError,
  PublicationResolvedError,
} from "../src/server/product/remediation-errors";
import type {
  RegisterRequestEnvelope,
  RegistrarRegisterTransport,
  TransportResult,
} from "../src/contracts/product/registrar-transport";

const RUN = process.env.RUN_DB_TESTS === "1";
const pad26 = (s: string): string =>
  (s.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

const AVAILABLE_AT = "2026-08-01T00:00:00.000Z";
const NOW = "2026-08-01T01:00:00.000Z";
const PREPARED_AT = "2026-08-01T01:00:01.000Z";
const DISPATCHED_AT = "2026-08-01T01:00:02.000Z";
const RETRY_AT = "2026-08-01T02:00:00.000Z";
const LEASE_SECONDS = 3600;

// — Synthetic runtime configuration —

const SECRET_VAR = "MONACADO_TEST_FAKE_RUN_TOKEN";
const secretSource = { [SECRET_VAR]: "fake-run-token-not-a-real-credential" };

const readyEnv = {
  MONACADO_REGISTRAR_ENABLED: "true",
  MONACADO_REGISTRAR_ID: MONACADO_REGISTRAR_ID,
  MONACADO_REGISTRAR_ENDPOINT: "https://registrar.example/v1/register",
  MONACADO_REGISTRAR_ALLOWED_ORIGINS: "https://registrar.example",
  MONACADO_REGISTRAR_CREDENTIAL_MODE: "BEARER_ENV",
  MONACADO_REGISTRAR_BEARER_TOKEN_ENV: SECRET_VAR,
};

const readyConfig = () => loadRegistrarRuntimeConfiguration(readyEnv);
const disabledConfig = () => loadRegistrarRuntimeConfiguration({});
const invalidConfig = () =>
  loadRegistrarRuntimeConfiguration({ ...readyEnv, MONACADO_REGISTRAR_TIMEOUT_MS: "nonsense" });
const incompleteConfig = () =>
  loadRegistrarRuntimeConfiguration({ MONACADO_REGISTRAR_ENABLED: "true" });

// — Fake transports (no sockets are ever opened) —

class FakeTransport implements RegistrarRegisterTransport {
  calls: RegisterRequestEnvelope[] = [];
  constructor(
    private readonly result: TransportResult,
    /** Runs after the call is recorded, before the result is returned. */
    private readonly sideEffect?: () => Promise<void>,
  ) {}
  async sendRegisterRequest(request: RegisterRequestEnvelope): Promise<TransportResult> {
    this.calls.push(request);
    if (this.sideEffect) await this.sideEffect();
    return this.result;
  }
}

const acceptedResult = (): TransportResult => ({
  outcome: "SUCCESS",
  transmitted: true,
  httpStatus: 200,
});

const rejectedResult = (): TransportResult => ({
  outcome: "REMOTE_REJECTION",
  transmitted: true,
  httpStatus: 200,
});

const preConnectFailure = (): TransportResult => ({
  outcome: "RETRYABLE_TRANSPORT_FAILURE",
  transmitted: false,
  failure: { code: "CONNECTION_FAILED", summary: "The connection was never established" },
});

const terminalFailure = (): TransportResult => ({
  outcome: "TERMINAL_TRANSPORT_FAILURE",
  transmitted: false,
  httpStatus: 400,
  failure: { code: "PROTOCOL_REJECTED", summary: "The request was refused before processing" },
});

const ambiguousResult = (): TransportResult => ({
  outcome: "AMBIGUOUS_DELIVERY",
  transmitted: true,
  failure: { code: "TIMEOUT", summary: "No response was received before the deadline" },
});

// — Fixtures —

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
      name: "Single-run orchestration fixture product",
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      relationships: { creator: `an:node:${pad26(`R${n}CNDE`)}` },
    },
    capsuleSemver: "1.0.0",
    mappingVersion: "0e.6.3.0",
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
const remediation = RUN
  ? new PublicationRemediationService(db)
  : (undefined as unknown as PublicationRemediationService);

let idSeq = 0;
const nextAttemptId = () => {
  idSeq += 1;
  return `mon:attempt:${pad26(`RATT${String(idSeq).padStart(3, "0")}`)}`;
};

interface Seeded {
  publicationId: string;
  outboxId: string;
  payloadHash: string;
}

async function seed(): Promise<Seeded> {
  const record = syntheticRecord();
  await repo.createInitialProductSourceRecord({ record });
  const node = await nodes.issueProductNode({
    nodeId: `an:node:${pad26(`R${n}NODE`)}`,
    internalProductId: record.internalProductId,
    nodeKind: "product",
    nodePolicyRef: "an:policy:node:synthetic-0e63",
    nodePolicyVersion: "1.0.0",
    registrarId: MONACADO_REGISTRAR_ID,
    issuedAt: "2026-01-02T00:00:00.000Z",
  });
  idSeq += 1;
  const result = await pubs.prepareProductPublication({
    publicationId: `mon:pub:${pad26(`RPUB${String(idSeq).padStart(3, "0")}`)}`,
    internalProductId: record.internalProductId,
    sourceRecordId: record.sourceRecordId,
    sourceRecordVersion: "1",
    nodeId: node.nodeId,
    capsuleId: `an:capsule:${pad26(`RCAP${String(idSeq).padStart(3, "0")}`)}`,
    capsuleSemver: record.capsuleSemver,
    publishedBy: MONACADO_PUBLISHER_ID,
    publishedAt: "2026-03-01T00:00:00.000Z",
    nodePolicy: { ref: "an:policy:node:synthetic-0e63", version: "1.0.0" },
    capsulePolicy: { ref: "an:policy:capsule:synthetic-0e63", version: "1.0.0" },
    availableAt: AVAILABLE_AT,
  });
  return {
    publicationId: result.publication.publicationId,
    outboxId: result.outbox.outboxId,
    payloadHash: result.outbox.payloadHash,
  };
}

function runInput(overrides: Record<string, unknown> = {}) {
  return {
    now: NOW,
    leaseDurationSeconds: LEASE_SECONDS,
    submissionAttemptId: nextAttemptId(),
    preparedAt: PREPARED_AT,
    dispatchedAt: DISPATCHED_AT,
    retryAvailableAt: RETRY_AT,
    ...overrides,
  };
}

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

const rowOf = (outboxId: string) => db.publicationOutbox.findUnique({ where: { outboxId } });
const attemptOf = (submissionAttemptId: string) =>
  db.publicationSubmissionAttempt.findUnique({ where: { submissionAttemptId } });

describe.skipIf(!RUN)("Single-run publication orchestration (integration)", () => {
  beforeEach(wipe);
  afterAll(async () => {
    await wipe();
    await disconnectPrisma();
  });

  // — Configuration gating —

  it("1. DISABLED returns without mutating the database", async () => {
    const s = await seed();
    const transport = new FakeTransport(acceptedResult());
    const result = await runOneProductPublication(runInput(), {
      configuration: disabledConfig(),
      secretSource,
      transportOverride: transport,
      db,
    });
    expect(result.outcome).toBe("DISABLED");
    expect(result.outboxId).toBeUndefined();
    expect(transport.calls).toHaveLength(0);
    // The queue is untouched: still PENDING, never claimed.
    const row = await rowOf(s.outboxId);
    expect(row?.outboxStatus).toBe("PENDING");
    expect(row?.lockToken).toBeNull();
    expect(await db.publicationSubmissionAttempt.count()).toBe(0);
  });

  it("2. INVALID runtime configuration fails before any claim", async () => {
    const s = await seed();
    const transport = new FakeTransport(acceptedResult());
    await expect(
      runOneProductPublication(runInput(), {
        configuration: invalidConfig(),
        secretSource,
        transportOverride: transport,
        db,
      }),
    ).rejects.toBeInstanceOf(RuntimeNotReadyError);
    expect(transport.calls).toHaveLength(0);
    expect((await rowOf(s.outboxId))?.outboxStatus).toBe("PENDING");
  });

  it("2b. INCOMPLETE runtime configuration also fails before any claim", async () => {
    const s = await seed();
    await expect(
      runOneProductPublication(runInput(), {
        configuration: incompleteConfig(),
        secretSource,
        db,
      }),
    ).rejects.toBeInstanceOf(RuntimeNotReadyError);
    expect((await rowOf(s.outboxId))?.outboxStatus).toBe("PENDING");
  });

  it("3. NO_ELIGIBLE_WORK returns cleanly when nothing is due", async () => {
    const transport = new FakeTransport(acceptedResult());
    const result = await runOneProductPublication(runInput(), {
      configuration: readyConfig(),
      secretSource,
      transportOverride: transport,
      db,
    });
    expect(result.outcome).toBe("NO_ELIGIBLE_WORK");
    expect(result.outboxId).toBeUndefined();
    expect(transport.calls).toHaveLength(0);
  });

  it("3b. invalid run input is refused with field names only", async () => {
    await expect(
      runOneProductPublication(
        { now: "not-a-timestamp", leaseDurationSeconds: LEASE_SECONDS },
        { configuration: readyConfig(), secretSource, db },
      ),
    ).rejects.toBeInstanceOf(InvalidRunInputError);
  });

  // — One item, one attempt, one send —

  it("4. at most one outbox item is claimed even when several are due", async () => {
    const a = await seed();
    const b = await seed();
    const c = await seed();
    const transport = new FakeTransport(acceptedResult());
    await runOneProductPublication(runInput(), {
      configuration: readyConfig(),
      secretSource,
      transportOverride: transport,
      db,
    });
    const statuses = await Promise.all([a, b, c].map((s) => rowOf(s.outboxId)));
    const processing = statuses.filter((r) => r?.outboxStatus === "PROCESSING");
    expect(processing).toHaveLength(1);
    expect(statuses.filter((r) => r?.outboxStatus === "PENDING")).toHaveLength(2);
  });

  it("5 & 6. exactly one attempt is prepared and the transport is called once", async () => {
    await seed();
    const transport = new FakeTransport(acceptedResult());
    const input = runInput();
    await runOneProductPublication(input, {
      configuration: readyConfig(),
      secretSource,
      transportOverride: transport,
      db,
    });
    expect(await db.publicationSubmissionAttempt.count()).toBe(1);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.submissionAttemptId).toBe(input.submissionAttemptId);
  });

  // — SUCCESS —

  it("7-10. a successful send returns SENT, leaves DISPATCHED/PROCESSING, and creates no receipt", async () => {
    const s = await seed();
    const transport = new FakeTransport(acceptedResult());
    const input = runInput();
    const result = await runOneProductPublication(input, {
      configuration: readyConfig(),
      secretSource,
      transportOverride: transport,
      db,
    });

    expect(result.outcome).toBe("SENT");
    expect(result.transmitted).toBe(true);
    expect(result.outboxId).toBe(s.outboxId);

    expect((await attemptOf(input.submissionAttemptId))?.attemptStatus).toBe("DISPATCHED");
    const row = await rowOf(s.outboxId);
    expect(row?.outboxStatus).toBe("PROCESSING");
    // No receipt: an accepted response is evidence, not authority.
    expect(await db.registrarReceipt.count()).toBe(0);
    const pub = await db.productPublication.findUnique({
      where: { publicationId: s.publicationId },
    });
    expect(pub?.registrationState).toBe("NOT_SUBMITTED");
  });

  it("11. remote rejection is distinct from an authoritative receipt rejection", async () => {
    const s = await seed();
    const input = runInput();
    const result = await runOneProductPublication(input, {
      configuration: readyConfig(),
      secretSource,
      transportOverride: new FakeTransport(rejectedResult()),
      db,
    });

    expect(result.outcome).toBe("REMOTE_REJECTION");
    // The claim and payload survive; nothing is dead-lettered from a response.
    const row = await rowOf(s.outboxId);
    expect(row?.outboxStatus).toBe("PROCESSING");
    expect(row?.payload).not.toBeNull();
    expect((await attemptOf(input.submissionAttemptId))?.attemptStatus).toBe("DISPATCHED");
    // No receipt was fabricated, so registration is still unresolved.
    expect(await db.registrarReceipt.count()).toBe(0);
    const pub = await db.productPublication.findUnique({
      where: { publicationId: s.publicationId },
    });
    expect(pub?.registrationState).toBe("NOT_SUBMITTED");
  });

  // — Retryable —

  it("12-16. a pre-connect failure abandons the attempt and schedules a retry", async () => {
    const s = await seed();
    const before = await rowOf(s.outboxId);
    const input = runInput();
    const result = await runOneProductPublication(input, {
      configuration: readyConfig(),
      secretSource,
      transportOverride: new FakeTransport(preConnectFailure()),
      db,
    });

    expect(result.outcome).toBe("RETRY_SCHEDULED");
    expect(result.retryAvailableAt).toBe(RETRY_AT);
    expect((await attemptOf(input.submissionAttemptId))?.attemptStatus).toBe("ABANDONED");

    const row = await rowOf(s.outboxId);
    expect(row?.outboxStatus).toBe("RETRYABLE");
    // Ownership is released so a later claim can take it.
    expect(row?.lockToken).toBeNull();
    expect(row?.lockedAt).toBeNull();
    expect(row?.leaseExpiresAt).toBeNull();
    expect(row?.availableAt.toISOString()).toBe(RETRY_AT);
    // The payload and its hash are preserved for the retry.
    expect(row?.payloadHash).toBe(s.payloadHash);
    expect(row?.payload).toEqual(before?.payload);
    expect(row?.lastErrorCode).toBe("CONNECTION_FAILED");
  });

  it("16c. a retryable failure without an explicit retry time is refused, not defaulted", async () => {
    const s = await seed();
    // No retryAvailableAt: choosing one here would be the orchestrator reading a
    // clock and inventing a backoff, which is the caller's decision.
    const input = runInput({ retryAvailableAt: undefined });
    await expect(
      runOneProductPublication(input, {
        configuration: readyConfig(),
        secretSource,
        transportOverride: new FakeTransport(preConnectFailure()),
        db,
      }),
    ).rejects.toBeInstanceOf(RunRetryTimeRequiredError);
    // Nothing was rescheduled or dead-lettered; the claim is simply still held
    // and will be reclaimed by the existing lease-expiry recovery sweep.
    expect((await rowOf(s.outboxId))?.outboxStatus).toBe("PROCESSING");
  });

  it("16b. a retryable failure that DID transmit is treated as ambiguous, not resent", async () => {
    // A 5xx after transmission is retryable by classification, but we cannot
    // prove the Registrar did not process it — so nothing is rescheduled.
    const s = await seed();
    const input = runInput();
    const result = await runOneProductPublication(input, {
      configuration: readyConfig(),
      secretSource,
      transportOverride: new FakeTransport({
        outcome: "RETRYABLE_TRANSPORT_FAILURE",
        transmitted: true,
        httpStatus: 503,
        failure: { code: "SERVER_ERROR", summary: "The Registrar reported a server error" },
      }),
      db,
    });
    expect(result.outcome).toBe("AMBIGUOUS_DELIVERY");
    expect((await rowOf(s.outboxId))?.outboxStatus).toBe("PROCESSING");
    expect((await attemptOf(input.submissionAttemptId))?.attemptStatus).toBe("DISPATCHED");
  });

  // — Terminal —

  it("17-19. a terminal failure abandons the attempt, dead-letters, and preserves the payload", async () => {
    const s = await seed();
    const before = await rowOf(s.outboxId);
    const input = runInput();
    const result = await runOneProductPublication(input, {
      configuration: readyConfig(),
      secretSource,
      transportOverride: new FakeTransport(terminalFailure()),
      db,
    });

    expect(result.outcome).toBe("DEAD_LETTERED");
    expect((await attemptOf(input.submissionAttemptId))?.attemptStatus).toBe("ABANDONED");

    const row = await rowOf(s.outboxId);
    expect(row?.outboxStatus).toBe("DEAD_LETTER");
    expect(row?.lockToken).toBeNull();
    expect(row?.payloadHash).toBe(s.payloadHash);
    expect(row?.payload).toEqual(before?.payload);
    expect(row?.lastErrorCode).toBe("PROTOCOL_REJECTED");
  });

  // — Ambiguous —

  it("20-23. ambiguous delivery holds state, schedules nothing, and resends nothing", async () => {
    const s = await seed();
    const input = runInput();
    const transport = new FakeTransport(ambiguousResult());
    const result = await runOneProductPublication(input, {
      configuration: readyConfig(),
      secretSource,
      transportOverride: transport,
      db,
    });

    expect(result.outcome).toBe("AMBIGUOUS_DELIVERY");
    expect(result.transmitted).toBe(true);
    expect((await attemptOf(input.submissionAttemptId))?.attemptStatus).toBe("DISPATCHED");

    const row = await rowOf(s.outboxId);
    expect(row?.outboxStatus).toBe("PROCESSING");
    // Still leased, and NOT rescheduled.
    expect(row?.lockToken).not.toBeNull();
    expect(row?.availableAt.toISOString()).toBe(AVAILABLE_AT);
    expect(transport.calls).toHaveLength(1);
  });

  it("24 & 23b. reinvocation cannot send the same active claim twice", async () => {
    await seed();
    const first = new FakeTransport(ambiguousResult());
    await runOneProductPublication(runInput(), {
      configuration: readyConfig(),
      secretSource,
      transportOverride: first,
      db,
    });

    // The item is still PROCESSING under a live lease, so a second run finds
    // nothing due — the ambiguous attempt is never resent.
    const second = new FakeTransport(acceptedResult());
    const result = await runOneProductPublication(runInput(), {
      configuration: readyConfig(),
      secretSource,
      transportOverride: second,
      db,
    });
    expect(result.outcome).toBe("NO_ELIGIBLE_WORK");
    expect(second.calls).toHaveLength(0);
    expect(await db.publicationSubmissionAttempt.count()).toBe(1);
  });

  // — Stale-claim protection —

  it("25 & 26. a lease recovered during transport cannot be overwritten by the stale run", async () => {
    const s = await seed();
    const input = runInput();
    // The transport recovers the claim mid-flight, exactly as an expiry sweep
    // would, then reports a retryable failure the stale run would try to apply.
    const transport = new FakeTransport(preConnectFailure(), async () => {
      await outbox.recoverExpiredPublicationOutboxClaims({
        now: "2026-08-01T09:00:00.000Z",
        limit: 10,
      });
    });

    await expect(
      runOneProductPublication(input, {
        configuration: readyConfig(),
        secretSource,
        transportOverride: transport,
        db,
      }),
    ).rejects.toBeInstanceOf(RunStateConflictError);

    // The recovered state stands; the stale worker wrote nothing.
    const row = await rowOf(s.outboxId);
    expect(row?.outboxStatus).toBe("RETRYABLE");
    expect(row?.availableAt.toISOString()).not.toBe(RETRY_AT);
  });

  it("27. a CLOSED publication cannot be processed", async () => {
    const s = await seed();
    // The terminal state is set directly: governed closure itself is exercised
    // in the remediation suite, and what is under test here is only that the
    // orchestrator refuses to send for a settled publication.
    await db.productPublication.update({
      where: { publicationId: s.publicationId },
      data: { remediationState: "CLOSED" },
    });
    const transport = new FakeTransport(acceptedResult());
    await expect(
      runOneProductPublication(runInput(), {
        configuration: readyConfig(),
        secretSource,
        transportOverride: transport,
        db,
      }),
    ).rejects.toBeInstanceOf(PublicationClosedError);
    expect(transport.calls).toHaveLength(0);
    expect(await db.registrarReceipt.count()).toBe(0);
  });

  it("28. a RESOLVED publication cannot be processed", async () => {
    const s = await seed();
    await db.productPublication.update({
      where: { publicationId: s.publicationId },
      data: { remediationState: "RESOLVED", registrationState: "ACCEPTED" },
    });
    const transport = new FakeTransport(acceptedResult());
    await expect(
      runOneProductPublication(runInput(), {
        configuration: readyConfig(),
        secretSource,
        transportOverride: transport,
        db,
      }),
    ).rejects.toBeInstanceOf(PublicationResolvedError);
    expect(transport.calls).toHaveLength(0);
  });

  // — Idempotency —

  it("29. replaying a run with the same attempt id creates no duplicate attempt", async () => {
    await seed();
    const input = runInput();
    await runOneProductPublication(input, {
      configuration: readyConfig(),
      secretSource,
      transportOverride: new FakeTransport(ambiguousResult()),
      db,
    });
    expect(await db.publicationSubmissionAttempt.count()).toBe(1);

    // Same input again: the claim is held, so no second attempt appears.
    const replay = new FakeTransport(acceptedResult());
    await runOneProductPublication(input, {
      configuration: readyConfig(),
      secretSource,
      transportOverride: replay,
      db,
    });
    expect(await db.publicationSubmissionAttempt.count()).toBe(1);
    expect(replay.calls).toHaveLength(0);
  });

  it("29b. a later retry claim receives a distinct attempt id and a higher number", async () => {
    const s = await seed();
    const first = runInput();
    await runOneProductPublication(first, {
      configuration: readyConfig(),
      secretSource,
      transportOverride: new FakeTransport(preConnectFailure()),
      db,
    });

    const second = runInput({ now: RETRY_AT });
    expect(second.submissionAttemptId).not.toBe(first.submissionAttemptId);
    await runOneProductPublication(second, {
      configuration: readyConfig(),
      secretSource,
      transportOverride: new FakeTransport(ambiguousResult()),
      db,
    });

    const rows = await db.publicationSubmissionAttempt.findMany({
      where: { outboxId: s.outboxId },
      orderBy: { attemptNumber: "asc" },
    });
    expect(rows.map((r) => r.attemptNumber)).toEqual([1, 2]);
    // The raw lock token is never persisted on the attempt.
    expect(Object.keys(rows[0] ?? {})).not.toContain("lockToken");
  });

  // — Transaction boundaries and post-transport failure —

  it("30. no database transaction is open across the transport call", async () => {
    await seed();
    // Proof by observation: a concurrent connection sees the claim COMMITTED
    // while the transport is still executing. An open transaction would hide it.
    let seenDuringSend: string | undefined;
    const transport = new FakeTransport(acceptedResult(), async () => {
      const row = await db.publicationOutbox.findFirst({
        where: { outboxStatus: "PROCESSING" },
      });
      seenDuringSend = row?.outboxStatus;
    });
    await runOneProductPublication(runInput(), {
      configuration: readyConfig(),
      secretSource,
      transportOverride: transport,
      db,
    });
    expect(seenDuringSend).toBe("PROCESSING");
  });

  it("31. a post-transport persistence failure is reported and never resends", async () => {
    await seed();
    const input = runInput();
    const transport = new FakeTransport(preConnectFailure());
    // Break the write that follows the send, leaving the transport untouched.
    const brokenDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "publicationSubmissionAttempt") {
          return new Proxy(Reflect.get(target, prop, receiver) as object, {
            get(t, p, r) {
              if (p === "update" || p === "updateMany") {
                return async () => {
                  throw new Error("synthetic persistence failure");
                };
              }
              return Reflect.get(t, p, r);
            },
          });
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;

    await expect(
      runOneProductPublication(input, {
        configuration: readyConfig(),
        secretSource,
        transportOverride: transport,
        db: brokenDb,
      }),
    ).rejects.toBeInstanceOf(PostTransportPersistenceFailureError);

    // Exactly one send happened, and nothing tried again.
    expect(transport.calls).toHaveLength(1);
  });

  // — Leakage —

  it("32. results and errors expose no secret, payload, token, hash, or endpoint", async () => {
    const s = await seed();
    const input = runInput();
    const result = await runOneProductPublication(input, {
      configuration: readyConfig(),
      secretSource,
      transportOverride: new FakeTransport(acceptedResult()),
      db,
    });
    const serialized = JSON.stringify(result);
    for (const forbidden of [
      "fake-run-token-not-a-real-credential",
      SECRET_VAR,
      "registrar.example",
      "Bearer",
      s.payloadHash,
      "lockToken",
      "claimTokenHash",
      "payload",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }

    // And the same for a thrown orchestration error.
    try {
      await runOneProductPublication(
        { now: "bad" },
        { configuration: readyConfig(), secretSource, db },
      );
    } catch (error) {
      const text = `${(error as Error).message} ${JSON.stringify(error)}`;
      expect(text).not.toContain("fake-run-token-not-a-real-credential");
      expect(text).not.toContain("registrar.example");
      expect(Object.keys(error as object)).not.toContain("internalCause");
    }
  });
});
