/**
 * Registrar REGISTER transport integration tests (Phase 0E.6.1).
 *
 * Every network exchange here targets a LOCAL LOOPBACK mock server started by
 * the test itself. No external host is ever contacted, and all credentials are
 * obviously synthetic.
 *
 * DB-backed dispatch tests run ONLY against the disposable local MySQL
 * (RUN_DB_TESTS=1); the pure transport tests run unconditionally.
 */

import "dotenv/config";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProductSourceRecord } from "../src/contracts/index";
import {
  MONACADO_PUBLISHER_ID,
  REGISTRAR_OPERATION,
  REGISTRAR_PROTOCOL,
  REGISTRAR_PROTOCOL_VERSION,
  buildRegisterRequest,
  canonicalHash,
  finalizeProductCapsule,
  findEndpointIssues,
  generateProductCandidate,
  serializeRegisterRequest,
  tokenBindingHash,
  type RegistrarCredentialProvider,
} from "../src/contracts/index";
import {
  syntheticFinalizeInputs,
  syntheticSourceRecord,
} from "../src/contracts/fixtures/synthetic-product";
import { getPrisma, disconnectPrisma } from "../src/server/db/client";
import { ProductRepository } from "../src/server/product/product-repository";
import {
  MONACADO_REGISTRAR_ID,
  ProductNodeRepository,
} from "../src/server/product/product-node-repository";
import { ProductPublicationService } from "../src/server/product/product-publication-service";
import { PublicationOutboxRepository } from "../src/server/product/publication-outbox-repository";
import { PublicationSubmissionAttemptService } from "../src/server/product/submission-attempt-service";
import { PublicationRemediationService } from "../src/server/product/publication-remediation-service";
import { RegistrarReceiptService } from "../src/server/product/registrar-receipt-service";
import { HttpRegistrarRegisterTransport } from "../src/server/registrar/http-register-transport";
import { RegistrarDispatchService } from "../src/server/registrar/registrar-dispatch-service";
import {
  DispatchStateConflictError,
  ForbiddenTransportHeaderError,
  InvalidRegistrarEndpointError,
  MissingRegistrarCredentialsError,
  RegisterRequestContractFailureError,
} from "../src/server/registrar/transport-errors";

const RUN = process.env.RUN_DB_TESTS === "1";
const pad26 = (s: string): string =>
  (s.toUpperCase().replace(/[ILOU]/g, "0") + "0".repeat(26)).slice(0, 26);

/**
 * OBVIOUSLY SYNTHETIC credentials. Not a real token, not a real key id — they
 * exist so the tests can prove the header is applied and never leaked.
 */
const SYNTHETIC_AUTHORIZATION = "Bearer SYNTHETIC-NOT-A-REAL-REGISTRAR-TOKEN";
const SYNTHETIC_KEY_ID = "SYNTHETIC-KEY-ID";

const credentials: RegistrarCredentialProvider = {
  getRegistrarCredentials: () => ({
    authorization: SYNTHETIC_AUTHORIZATION,
    additionalHeaders: { "x-registrar-key-id": SYNTHETIC_KEY_ID },
  }),
};

// — Local mock Registrar —

interface MockState {
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void;
  hits: number;
  lastHeaders: Record<string, string | string[] | undefined>;
  lastBody: string;
}

let server: Server;
let baseUrl: string;
const mock: MockState = {
  handler: (_req, res) => res.end(),
  hits: 0,
  lastHeaders: {},
  lastBody: "",
};

function startServer(): Promise<void> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        mock.hits += 1;
        mock.lastHeaders = req.headers;
        mock.lastBody = body;
        mock.handler(req, res, body);
      });
    });
    // Loopback only — never a routable interface.
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      baseUrl = `http://127.0.0.1:${port}/register`;
      resolve();
    });
  });
}

/** Respond with a valid REGISTER envelope. */
function okEnvelope(submissionAttemptId: string, status: "ACCEPTED" | "REJECTED" = "ACCEPTED") {
  return JSON.stringify({
    protocol: REGISTRAR_PROTOCOL,
    version: REGISTRAR_PROTOCOL_VERSION,
    operation: REGISTRAR_OPERATION,
    submissionAttemptId,
    status,
    ...(status === "ACCEPTED"
      ? { registrarRegistrationId: "synthetic-registration-1", statusCode: "REGISTERED" }
      : { rejectionCode: "POLICY_REFUSED", rejectionReason: "Refused by synthetic policy." }),
  });
}

const endpoint = (overrides: Record<string, unknown> = {}) => ({
  url: baseUrl,
  timeoutMs: 2_000,
  ...overrides,
});

const transport = () => new HttpRegistrarRegisterTransport({ credentialProvider: credentials });

// — Fixtures for the pure builder —

const ATTEMPT_ID = `mon:attempt:${pad26("TATT001")}`;
/** A real, fully validated published capsule — the envelope accepts nothing less. */
const SYNTHETIC_CAPSULE = finalizeProductCapsule({
  candidate: generateProductCandidate({
    source: syntheticSourceRecord(),
    version: "1.0.0",
    generatedAt: "2026-01-01T00:00:00.000Z",
  }),
  ...syntheticFinalizeInputs(),
});
const SYNTHETIC_CAPSULE_HASH = canonicalHash(SYNTHETIC_CAPSULE);

describe("Registrar endpoint safety (pure)", () => {
  it("8,9. rejects non-loopback http and unsupported schemes; allows loopback http and https", () => {
    expect(findEndpointIssues("http://registrar.example/register").map((i) => i.rule)).toContain(
      "insecure-scheme",
    );
    expect(findEndpointIssues("https://registrar.example/register")).toEqual([]);
    expect(findEndpointIssues("http://127.0.0.1:8080/register")).toEqual([]);
    expect(findEndpointIssues("http://localhost:8080/register")).toEqual([]);

    for (const [url, rule] of [
      ["file:///etc/passwd", "scheme"],
      ["ftp://registrar.example/x", "scheme"],
      ["https://user:pw@registrar.example/x", "embedded-credentials"],
      ["https://registrar.example/x#frag", "fragment"],
      ["not-a-url", "unparsable"],
    ] as const) {
      expect(findEndpointIssues(url).map((i) => i.rule), url).toContain(rule);
    }
  });

  it("8b. an endpoint issue never echoes the URL", () => {
    const issues = findEndpointIssues("https://user:hunter2@secret-host.example/private/path");
    const text = JSON.stringify(issues);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("secret-host.example");
    expect(text).not.toContain("/private/path");
  });
});

describe("REGISTER request builder (pure)", () => {
  const attempt = {
    id: "1",
    submissionAttemptId: ATTEMPT_ID,
    publicationId: `mon:pub:${pad26("TPUB001")}`,
    outboxId: `mon:obx:${pad26("TOBX001")}`,
    attemptNumber: 1,
    operation: "REGISTER" as const,
    nodeId: `an:node:${pad26("TNODE001")}`,
    capsuleId: `an:capsule:${pad26("TCAP001")}`,
    registrarId: MONACADO_REGISTRAR_ID,
    expectedContentHash: `sha256:${"a".repeat(64)}`,
    payloadHash: `sha256:${"b".repeat(64)}`,
    claimTokenHash: `sha256:${"c".repeat(64)}`,
    attemptStatus: "PREPARED" as const,
    preparedAt: "2026-08-01T00:00:00.000Z",
    createdAt: "2026-08-01T00:00:00.000Z",
  };

  it("1. builds deterministically — identical inputs produce byte-equal content", () => {
    const payload = SYNTHETIC_CAPSULE;
    const a = { ...attempt, payloadHash: SYNTHETIC_CAPSULE_HASH };

    const first = buildRegisterRequest({ attempt: a, payload, idempotencyKey: `sha256:${"d".repeat(64)}` });
    const second = buildRegisterRequest({ attempt: a, payload, idempotencyKey: `sha256:${"d".repeat(64)}` });
    expect(serializeRegisterRequest(first)).toBe(serializeRegisterRequest(second));
  });
});

// — Transport against the local mock server —

describe("HTTP Registrar transport (loopback mock server)", () => {
  beforeEach(async () => {
    await startServer();
    mock.hits = 0;
    mock.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(okEnvelope(ATTEMPT_ID));
    };
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  /** A minimal valid request aimed at the mock. */
  function request() {
    return buildRegisterRequest({
      attempt: {
        id: "1",
        submissionAttemptId: ATTEMPT_ID,
        publicationId: `mon:pub:${pad26("TPUB001")}`,
        outboxId: `mon:obx:${pad26("TOBX001")}`,
        attemptNumber: 1,
        operation: "REGISTER",
        nodeId: `an:node:${pad26("TNODE001")}`,
        capsuleId: `an:capsule:${pad26("TCAP001")}`,
        registrarId: MONACADO_REGISTRAR_ID,
        expectedContentHash: `sha256:${"a".repeat(64)}`,
        payloadHash: SYNTHETIC_CAPSULE_HASH,
        claimTokenHash: `sha256:${"c".repeat(64)}`,
        attemptStatus: "PREPARED",
        preparedAt: "2026-08-01T00:00:00.000Z",
        createdAt: "2026-08-01T00:00:00.000Z",
      },
      payload: SYNTHETIC_CAPSULE,
      idempotencyKey: `sha256:${"d".repeat(64)}`,
    });
  }

  it("5,9,11. a valid 2xx over loopback http succeeds and applies the credential header", async () => {
    const result = await transport().sendRegisterRequest(request(), endpoint());
    expect(result.outcome).toBe("SUCCESS");
    expect(result.transmitted).toBe(true);
    expect(result.httpStatus).toBe(200);
    expect(result.response?.status).toBe("ACCEPTED");

    expect(mock.lastHeaders.authorization).toBe(SYNTHETIC_AUTHORIZATION);
    expect(mock.lastHeaders["x-registrar-key-id"]).toBe(SYNTHETIC_KEY_ID);
    expect(mock.lastHeaders["content-type"]).toContain("application/json");
  });

  it("2,3,4. the request carries the required identifiers and payload but no claim ownership data", async () => {
    await transport().sendRegisterRequest(request(), endpoint());
    const sent = JSON.parse(mock.lastBody) as Record<string, unknown>;

    for (const key of [
      "protocol",
      "version",
      "operation",
      "submissionAttemptId",
      "publicationId",
      "outboxId",
      "idempotencyKey",
      "registrarId",
      "nodeId",
      "capsuleId",
      "publishedContentHash",
      "capsule",
    ]) {
      expect(sent, key).toHaveProperty(key);
    }
    expect(sent.capsule).toEqual(SYNTHETIC_CAPSULE);

    // Claim ownership never travels.
    expect(mock.lastBody).not.toContain("lockToken");
    expect(mock.lastBody).not.toContain("claimTokenHash");
    expect(mock.lastBody).not.toContain("mon:lock:");
    expect(mock.lastBody).not.toContain(`sha256:${"c".repeat(64)}`);
    // Nor does the credential.
    expect(mock.lastBody).not.toContain(SYNTHETIC_AUTHORIZATION);
  });

  it("6. the credential never appears in a successful result", async () => {
    const result = await transport().sendRegisterRequest(request(), endpoint());
    const text = JSON.stringify(result);
    expect(text).not.toContain(SYNTHETIC_AUTHORIZATION);
    expect(text).not.toContain(SYNTHETIC_KEY_ID);
    expect(text).not.toContain("Bearer");
  });

  it("7. forbidden and non-allow-listed credential headers are refused before sending", async () => {
    const refused: Array<Record<string, string>> = [
      { host: "evil.example" },
      { "content-length": "0" },
      { cookie: "a=b" },
      { "x-forwarded-for": "10.0.0.1" },
      { "x-not-allow-listed": "v" },
    ];
    for (const additionalHeaders of refused) {
      const t = new HttpRegistrarRegisterTransport({
        credentialProvider: {
          getRegistrarCredentials: () => ({
            authorization: SYNTHETIC_AUTHORIZATION,
            additionalHeaders,
          }),
        },
      });
      await expect(
        t.sendRegisterRequest(request(), endpoint()),
        Object.keys(additionalHeaders)[0],
      ).rejects.toBeInstanceOf(ForbiddenTransportHeaderError);
    }
    // Nothing was sent by any refused call.
    expect(mock.hits).toBe(0);
  });

  it("7b. an allow-listed header is applied, and a malformed credential is refused", async () => {
    const ok = new HttpRegistrarRegisterTransport({
      credentialProvider: {
        getRegistrarCredentials: () => ({
          authorization: SYNTHETIC_AUTHORIZATION,
          additionalHeaders: { "x-request-id": "req-1" },
        }),
      },
    });
    const result = await ok.sendRegisterRequest(request(), endpoint());
    expect(result.outcome).toBe("SUCCESS");
    expect(mock.lastHeaders["x-request-id"]).toBe("req-1");

    // A header value carrying CRLF would allow response splitting.
    const bad = new HttpRegistrarRegisterTransport({
      credentialProvider: {
        getRegistrarCredentials: () =>
          ({
            authorization: "Bearer x\r\nX-Injected: 1",
          }) as never,
      },
    });
    await expect(bad.sendRegisterRequest(request(), endpoint())).rejects.toBeInstanceOf(
      MissingRegistrarCredentialsError,
    );
  });

  it("8. a non-loopback http endpoint is refused before any request", async () => {
    await expect(
      transport().sendRegisterRequest(request(), endpoint({ url: "http://registrar.example/x" })),
    ).rejects.toBeInstanceOf(InvalidRegistrarEndpointError);
    expect(mock.hits).toBe(0);
  });

  it("10. a redirect is not followed", async () => {
    mock.handler = (_req, res) => {
      res.writeHead(302, { location: "https://elsewhere.example/register" });
      res.end();
    };
    const result = await transport().sendRegisterRequest(request(), endpoint());
    expect(result.outcome).toBe("TERMINAL_TRANSPORT_FAILURE");
    expect(result.httpStatus).toBe(302);
    // Exactly one hit — the redirect target was never contacted.
    expect(mock.hits).toBe(1);
  });

  it("12. a Registrar rejection is distinguished from a transport failure", async () => {
    mock.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(okEnvelope(ATTEMPT_ID, "REJECTED"));
    };
    const result = await transport().sendRegisterRequest(request(), endpoint());
    expect(result.outcome).toBe("REMOTE_REJECTION");
    expect(result.transmitted).toBe(true);
    expect(result.response?.status).toBe("REJECTED");
    expect(result.response?.rejectionCode).toBe("POLICY_REFUSED");
    // Not a transport failure at all.
    expect(result.failure).toBeUndefined();
  });

  it("13,14. 408/425/429 and 5xx are retryable; other 4xx are terminal", async () => {
    for (const status of [408, 425, 429, 500, 503]) {
      mock.handler = (_req, res) => {
        res.writeHead(status);
        res.end();
      };
      const result = await transport().sendRegisterRequest(request(), endpoint());
      expect(result.outcome, String(status)).toBe("RETRYABLE_TRANSPORT_FAILURE");
      expect(result.transmitted, String(status)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 422]) {
      mock.handler = (_req, res) => {
        res.writeHead(status);
        res.end();
      };
      const result = await transport().sendRegisterRequest(request(), endpoint());
      expect(result.outcome, String(status)).toBe("TERMINAL_TRANSPORT_FAILURE");
    }
  });

  it("15. an invalid or unknown-key 2xx response is terminal", async () => {
    for (const body of [
      "not json at all",
      JSON.stringify({ protocol: "something-else" }),
      JSON.stringify({
        protocol: REGISTRAR_PROTOCOL,
        version: REGISTRAR_PROTOCOL_VERSION,
        operation: REGISTRAR_OPERATION,
        submissionAttemptId: ATTEMPT_ID,
        status: "ACCEPTED",
        registrarRegistrationId: "r",
        unexpectedKey: "surprise",
      }),
    ]) {
      mock.handler = (_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      };
      const result = await transport().sendRegisterRequest(request(), endpoint());
      expect(result.outcome).toBe("TERMINAL_TRANSPORT_FAILURE");
      expect(result.response).toBeUndefined();
    }
  });

  it("16. an oversized response is rejected without being buffered whole", async () => {
    mock.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("x".repeat(20_000));
    };
    const result = await transport().sendRegisterRequest(
      request(),
      endpoint({ maxResponseBytes: 1_024 }),
    );
    expect(result.outcome).toBe("TERMINAL_TRANSPORT_FAILURE");
    expect(result.failure?.code).toBe("RESPONSE_TOO_LARGE");
    expect(JSON.stringify(result)).not.toContain("xxxxxxxxxx");
  });

  it("17. a timeout after transmission produces ambiguous delivery", async () => {
    mock.handler = (_req, res) => {
      // Never respond within the deadline.
      setTimeout(() => {
        try {
          res.end();
        } catch {
          /* socket already gone */
        }
      }, 1_200).unref?.();
    };
    const result = await transport().sendRegisterRequest(request(), endpoint({ timeoutMs: 300 }));
    expect(result.outcome).toBe("AMBIGUOUS_DELIVERY");
    // Conservative: the request may well have arrived.
    expect(result.transmitted).toBe(true);
    expect(result.failure?.code).toBe("TRANSPORT_TIMEOUT");
    // It did reach the server.
    expect(mock.hits).toBe(1);
  });

  it("18. a pre-connect failure is retryable and NOT transmitted", async () => {
    // Close the server so the port refuses connections.
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const result = await transport().sendRegisterRequest(request(), endpoint());
    expect(result.outcome).toBe("RETRYABLE_TRANSPORT_FAILURE");
    expect(result.transmitted).toBe(false);
    expect(result.failure?.code).toBe("TRANSPORT_CONNECT_FAILED");
    // Restart so afterEach's close() has something to close.
    await startServer();
  });

  it("20,21. the transport sends exactly once and never retries", async () => {
    mock.handler = (_req, res) => {
      res.writeHead(503);
      res.end();
    };
    const result = await transport().sendRegisterRequest(request(), endpoint());
    expect(result.outcome).toBe("RETRYABLE_TRANSPORT_FAILURE");
    // Retryable does NOT mean retried — that is a caller decision.
    expect(mock.hits).toBe(1);
  });

  it("27. transport errors and results expose no credential, payload, or endpoint", async () => {
    mock.handler = (_req, res) => {
      res.writeHead(500);
      res.end("internal detail that must not surface");
    };
    const result = await transport().sendRegisterRequest(request(), endpoint());
    const text = JSON.stringify(result);
    expect(text).not.toContain(SYNTHETIC_AUTHORIZATION);
    expect(text).not.toContain("internal detail");
    expect(text).not.toContain("@context");
    expect(text).not.toContain("127.0.0.1");

    try {
      await transport().sendRegisterRequest(request(), endpoint({ url: "https://u:p@h.example/x" }));
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as Error;
      const errText = `${JSON.stringify(err)} ${JSON.stringify({ ...err })} ${String(err)}`;
      expect(err).toBeInstanceOf(InvalidRegistrarEndpointError);
      expect(errText).not.toContain("internalCause");
      expect(errText).not.toContain("h.example");
      expect(errText).not.toContain("u:p");
    }
  });
});

// — DB-backed dispatch —

let n = 0;
function syntheticRecord(): ProductSourceRecord {
  n += 1;
  return {
    sourceRecordId: `mon:srec:${pad26(`T${n}SREC`)}`,
    sourceRecordVersion: "1",
    internalProductId: `mon:product:${pad26(`T${n}PRD`)}`,
    sourceSystem: "monacado",
    sourceRecordType: "Product",
    sourceClass: "governed-database-record",
    authority: {
      creatorId: `mon:creator:${pad26(`T${n}CRTR`)}`,
      authorityScope: "product-facts",
      authorizationState: "authorized",
    },
    facts: {
      name: "Transport fixture product",
      productVersion: 1,
      promotable: true,
      generalAvailabilityState: "available",
      relationships: { creator: `an:node:${pad26(`T${n}CNDE`)}` },
    },
    capsuleSemver: "1.0.0",
    mappingVersion: "0e.6.1.0",
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
const remediation = RUN
  ? new PublicationRemediationService(db)
  : (undefined as unknown as PublicationRemediationService);
const receipts = RUN
  ? new RegistrarReceiptService(db)
  : (undefined as unknown as RegistrarReceiptService);

const CLAIM_AT = "2026-08-01T00:00:00.000Z";
const SEND_AT = "2026-08-01T00:10:00.000Z";
const AFTER_LEASE = "2026-08-01T05:00:00.000Z";
const LEASE_SECONDS = 3600;

let seq = 0;

async function seedPreparedAttempt() {
  const record = syntheticRecord();
  await repo.createInitialProductSourceRecord({ record });
  const node = await nodes.issueProductNode({
    nodeId: `an:node:${pad26(`T${n}NODE`)}`,
    internalProductId: record.internalProductId,
    nodeKind: "product",
    nodePolicyRef: "an:policy:node:synthetic-0e61",
    nodePolicyVersion: "1.0.0",
    registrarId: MONACADO_REGISTRAR_ID,
    issuedAt: "2026-01-02T00:00:00.000Z",
  });
  seq += 1;
  const prep = await pubs.prepareProductPublication({
    publicationId: `mon:pub:${pad26(`TPUB${String(seq).padStart(3, "0")}`)}`,
    internalProductId: record.internalProductId,
    sourceRecordId: record.sourceRecordId,
    sourceRecordVersion: "1",
    nodeId: node.nodeId,
    capsuleId: `an:capsule:${pad26(`TCAP${String(seq).padStart(3, "0")}`)}`,
    capsuleSemver: record.capsuleSemver,
    publishedBy: MONACADO_PUBLISHER_ID,
    publishedAt: "2026-03-01T00:00:00.000Z",
    nodePolicy: { ref: "an:policy:node:synthetic-0e61", version: "1.0.0" },
    capsulePolicy: { ref: "an:policy:capsule:synthetic-0e61", version: "1.0.0" },
    availableAt: "2026-03-01T00:00:00.000Z",
  });
  const claimed = await outbox.claimNextPublicationOutbox({
    now: CLAIM_AT,
    leaseDurationSeconds: LEASE_SECONDS,
  });
  const submissionAttemptId = `mon:attempt:${pad26(`TATT${String(seq).padStart(3, "0")}`)}`;
  await attempts.preparePublicationSubmissionAttempt({
    publicationId: prep.publication.publicationId,
    outboxId: prep.outbox.outboxId,
    lockToken: claimed.lockToken,
    submissionAttemptId,
    preparedAt: CLAIM_AT,
  });
  return {
    submissionAttemptId,
    lockToken: claimed.lockToken,
    publicationId: prep.publication.publicationId,
    outboxId: prep.outbox.outboxId,
    nodeId: node.nodeId,
    capsuleId: prep.publication.capsuleId,
    publishedContentHash: prep.publication.publishedContentHash,
    payloadHash: prep.outbox.payloadHash,
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

describe.skipIf(!RUN)("Prepared-attempt dispatch (integration, loopback mock)", () => {
  beforeEach(async () => {
    await wipe();
    await startServer();
    mock.hits = 0;
    mock.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    };
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  afterAll(async () => {
    await wipe();
    await disconnectPrisma();
  });

  const dispatcher = () => new RegistrarDispatchService(transport(), db);

  it("19,20. a confirmed send marks the attempt DISPATCHED after exactly one call", async () => {
    const s = await seedPreparedAttempt();
    mock.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(okEnvelope(s.submissionAttemptId));
    };

    const result = await dispatcher().sendPreparedPublicationAttempt({
      submissionAttemptId: s.submissionAttemptId,
      lockToken: s.lockToken,
      now: SEND_AT,
      endpoint: endpoint(),
    });

    expect(result.transport.outcome).toBe("SUCCESS");
    expect(result.attemptDispatched).toBe(true);
    expect(mock.hits).toBe(1);
    const after = await attempts.getPublicationSubmissionAttempt(s.submissionAttemptId);
    expect(after.attemptStatus).toBe("DISPATCHED");
    expect(after.dispatchedAt).toBe(SEND_AT);
  });

  it("17b,19b. ambiguous delivery still marks DISPATCHED and does not resend", async () => {
    const s = await seedPreparedAttempt();
    mock.handler = (_req, res) => {
      setTimeout(() => {
        try {
          res.end();
        } catch {
          /* gone */
        }
      }, 1_200).unref?.();
    };

    const result = await dispatcher().sendPreparedPublicationAttempt({
      submissionAttemptId: s.submissionAttemptId,
      lockToken: s.lockToken,
      now: SEND_AT,
      endpoint: endpoint({ timeoutMs: 300 }),
    });

    expect(result.transport.outcome).toBe("AMBIGUOUS_DELIVERY");
    expect(result.attemptDispatched).toBe(true);
    expect(mock.hits).toBe(1);
    const after = await attempts.getPublicationSubmissionAttempt(s.submissionAttemptId);
    expect(after.attemptStatus).toBe("DISPATCHED");
  });

  it("18b. a pre-connect failure leaves the attempt PREPARED and reusable", async () => {
    const s = await seedPreparedAttempt();
    await new Promise<void>((resolve) => server.close(() => resolve()));

    const result = await dispatcher().sendPreparedPublicationAttempt({
      submissionAttemptId: s.submissionAttemptId,
      lockToken: s.lockToken,
      now: SEND_AT,
      endpoint: endpoint(),
    });

    expect(result.transport.outcome).toBe("RETRYABLE_TRANSPORT_FAILURE");
    expect(result.transport.transmitted).toBe(false);
    expect(result.attemptDispatched).toBe(false);
    const after = await attempts.getPublicationSubmissionAttempt(s.submissionAttemptId);
    expect(after.attemptStatus).toBe("PREPARED");
    expect(after.dispatchedAt).toBeUndefined();

    await startServer();
  });

  it("22,23. a wrong token or an expired lease fails before any transport call", async () => {
    const s = await seedPreparedAttempt();

    await expect(
      dispatcher().sendPreparedPublicationAttempt({
        submissionAttemptId: s.submissionAttemptId,
        lockToken: `mon:lock:${pad26("WRONGTOKEN")}`,
        now: SEND_AT,
        endpoint: endpoint(),
      }),
    ).rejects.toBeInstanceOf(DispatchStateConflictError);

    await expect(
      dispatcher().sendPreparedPublicationAttempt({
        submissionAttemptId: s.submissionAttemptId,
        lockToken: s.lockToken,
        now: AFTER_LEASE,
        endpoint: endpoint(),
      }),
    ).rejects.toBeInstanceOf(DispatchStateConflictError);

    expect(mock.hits).toBe(0);
    const after = await attempts.getPublicationSubmissionAttempt(s.submissionAttemptId);
    expect(after.attemptStatus).toBe("PREPARED");
  });

  it("24. a CLOSED or RESOLVED publication cannot be sent", async () => {
    // CLOSED, via a matching rejection then a governed close.
    const a = await seedPreparedAttempt();
    await attempts.markPublicationSubmissionAttemptDispatched({
      submissionAttemptId: a.submissionAttemptId,
      lockToken: a.lockToken,
      dispatchedAt: CLAIM_AT,
    });
    await receipts.recordRegistrarReceipt({
      receiptId: `mon:rcpt:${pad26("TRCPT1")}`,
      publicationId: a.publicationId,
      submissionAttemptId: a.submissionAttemptId,
      registrarId: MONACADO_REGISTRAR_ID,
      nodeId: a.nodeId,
      capsuleId: a.capsuleId,
      registeredContentHash: a.publishedContentHash,
      receiptStatus: "REJECTED",
      registeredAt: CLAIM_AT,
      receivedAt: CLAIM_AT,
      receiptDetails: { rejectionCode: "POLICY_REFUSED", rejectionReason: "Refused." },
    });
    await remediation.remediateProductPublication({
      publicationId: a.publicationId,
      remediationId: `mon:rem:${pad26("TREM1")}`,
      action: "CLOSE",
      reasonCode: "WITHDRAWN",
      decidedBy: `mon:actor:${pad26("TOPERATOR")}`,
      decidedAt: SEND_AT,
    });

    // The attempt is already answered, so seed a fresh one to isolate the check.
    const b = await seedPreparedAttempt();
    await db.$executeRawUnsafe(
      "UPDATE ProductPublication SET remediationState = 'CLOSED' WHERE publicationId = ?",
      b.publicationId,
    );
    await expect(
      dispatcher().sendPreparedPublicationAttempt({
        submissionAttemptId: b.submissionAttemptId,
        lockToken: b.lockToken,
        now: SEND_AT,
        endpoint: endpoint(),
      }),
    ).rejects.toBeInstanceOf(DispatchStateConflictError);

    const c = await seedPreparedAttempt();
    await db.$executeRawUnsafe(
      "UPDATE ProductPublication SET registrationState = 'ACCEPTED', reconciliationState = 'MATCHED', remediationState = 'RESOLVED' WHERE publicationId = ?",
      c.publicationId,
    );
    await expect(
      dispatcher().sendPreparedPublicationAttempt({
        submissionAttemptId: c.submissionAttemptId,
        lockToken: c.lockToken,
        now: SEND_AT,
        endpoint: endpoint(),
      }),
    ).rejects.toBeInstanceOf(DispatchStateConflictError);

    expect(mock.hits).toBe(0);
  });

  it("25. a payload-hash mismatch fails before any transport call", async () => {
    const s = await seedPreparedAttempt();
    // Corrupt the attempt's promise about the payload.
    await db.$executeRawUnsafe(
      "UPDATE PublicationSubmissionAttempt SET payloadHash = ? WHERE submissionAttemptId = ?",
      `sha256:${"0".repeat(64)}`,
      s.submissionAttemptId,
    );
    await expect(
      dispatcher().sendPreparedPublicationAttempt({
        submissionAttemptId: s.submissionAttemptId,
        lockToken: s.lockToken,
        now: SEND_AT,
        endpoint: endpoint(),
      }),
    ).rejects.toBeInstanceOf(RegisterRequestContractFailureError);
    expect(mock.hits).toBe(0);
  });

  it("26. an immediate acceptance does not become a receipt or bypass reconciliation", async () => {
    const s = await seedPreparedAttempt();
    mock.handler = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(okEnvelope(s.submissionAttemptId));
    };

    const result = await dispatcher().sendPreparedPublicationAttempt({
      submissionAttemptId: s.submissionAttemptId,
      lockToken: s.lockToken,
      now: SEND_AT,
      endpoint: endpoint(),
    });
    expect(result.transport.outcome).toBe("SUCCESS");
    expect(result.registrarResponse?.status).toBe("ACCEPTED");

    // No receipt was created, and the publication is untouched by the response.
    expect(await db.registrarReceipt.count()).toBe(0);
    const pub = await pubs.getProductPublication(s.publicationId);
    expect(pub.registrationState).toBe("NOT_SUBMITTED");
    expect(pub.reconciliationState).toBe("NOT_REQUIRED");
    // The payload is still retained — nothing was disposed.
    const obx = await outbox.getPublicationOutboxById(s.outboxId);
    expect(obx.payload).toBeDefined();
    // Resolution still requires the Phase 0E.4 path.
    const reconciled = await receipts.recordRegistrarReceipt({
      receiptId: `mon:rcpt:${pad26("TRCPT2")}`,
      publicationId: s.publicationId,
      submissionAttemptId: s.submissionAttemptId,
      registrarRegistrationId: "synthetic-registration-1",
      registrarId: MONACADO_REGISTRAR_ID,
      nodeId: s.nodeId,
      capsuleId: s.capsuleId,
      registeredContentHash: s.publishedContentHash,
      receiptStatus: "ACCEPTED",
      registeredAt: SEND_AT,
      receivedAt: SEND_AT,
      receiptDetails: { registrarStatusCode: "REGISTERED" },
    });
    expect(reconciled.registrationState).toBe("ACCEPTED");
  });

  it("27b. dispatch errors expose no token, hash, payload, or credential", async () => {
    const s = await seedPreparedAttempt();
    try {
      await dispatcher().sendPreparedPublicationAttempt({
        submissionAttemptId: s.submissionAttemptId,
        lockToken: `mon:lock:${pad26("SECRETTOKEN")}`,
        now: SEND_AT,
        endpoint: endpoint(),
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
      expect(text).not.toContain(SYNTHETIC_AUTHORIZATION);
      expect(text).not.toContain("@context");
      expect(e).toBeInstanceOf(DispatchStateConflictError);
    }
  });
});
