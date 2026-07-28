/**
 * Registrar REGISTER transport contracts (Phase 0E.6.1).
 *
 * The strict boundary between a prepared submission attempt and the wire. This
 * module defines WHAT is sent and WHAT may come back; it performs no I/O and
 * reads no configuration.
 *
 * Three concerns are kept rigorously apart and must never be conflated:
 *
 *   transport failure  — we could not complete an exchange with the Registrar;
 *   Registrar rejection — the Registrar answered, and its answer was "no";
 *   receipt reconciliation — whether that answer describes the attempt we sent.
 *
 * Only the first two are decided here. **No RegistrarReceipt is created from a
 * transport response in this phase** — an immediate response is returned for a
 * later receipt-ingestion operation to reconcile under the Phase 0E.4 rules.
 *
 * Zod is the single authored source of truth; types are inferred. No passthrough,
 * `any`, or unrestricted JSON — the response envelope rejects unknown keys.
 */

import { z } from "zod";
import { AnsNodeId, CapsuleId, ContentHash } from "../capsule/envelope";
import { RegistrarId } from "./product-node";
import { OutboxId, PublicationId } from "./product-publication";
import { IdempotencyKey } from "./product-publication";
import { SubmissionAttemptId } from "./product-submission-attempt";
import { PublishedProductCapsule } from "./product.capsule";
import { SafeErrorCode, SafeErrorSummary } from "./safe-error-metadata";

// — Protocol identity —

export const REGISTRAR_PROTOCOL = "monacado.registrar" as const;
export const REGISTRAR_PROTOCOL_VERSION = "1.0" as const;
export const REGISTRAR_OPERATION = "REGISTER" as const;

// — Endpoint —

/**
 * Bounds on the request timeout. A zero/negative timeout would abort before the
 * request could leave; an unbounded one would let a hung connection occupy a
 * claim for the whole lease.
 */
export const MIN_TRANSPORT_TIMEOUT_MS = 100;
export const MAX_TRANSPORT_TIMEOUT_MS = 120_000;
export const TransportTimeoutMs = z
  .int()
  .min(MIN_TRANSPORT_TIMEOUT_MS, `timeoutMs must be at least ${MIN_TRANSPORT_TIMEOUT_MS}`)
  .max(MAX_TRANSPORT_TIMEOUT_MS, `timeoutMs must be at most ${MAX_TRANSPORT_TIMEOUT_MS}`);

/** Bounds on how much response body will be read before giving up. */
export const MIN_RESPONSE_BYTES = 1_024;
export const MAX_RESPONSE_BYTES = 1_048_576; // 1 MiB
export const DEFAULT_MAX_RESPONSE_BYTES = 65_536;

/**
 * Where to send. Supplied EXPLICITLY by the caller — never derived from capsule
 * or Registrar-supplied data, which would let content steer our egress.
 *
 * Production endpoint allow-listing is still required before deployment; this
 * contract enforces scheme and shape safety only.
 */
export const RegistrarEndpoint = z.strictObject({
  /** Absolute URL. `https:` required except for loopback (tests only). */
  url: z.string().min(1).max(2_048),
  timeoutMs: TransportTimeoutMs,
  maxResponseBytes: z.int().min(MIN_RESPONSE_BYTES).max(MAX_RESPONSE_BYTES).optional(),
});
export type RegistrarEndpoint = z.infer<typeof RegistrarEndpoint>;

// — Credentials —

/**
 * Header names a credential provider may contribute, beyond `Authorization`.
 * Deliberately tiny: anything that could redirect, spoof, or reframe the request
 * is excluded by omission rather than by blacklist.
 */
export const ALLOWED_CREDENTIAL_HEADERS: readonly string[] = [
  "x-registrar-client",
  "x-registrar-key-id",
  "x-request-id",
];

/**
 * Header names a caller may NEVER supply. Framing headers (`content-length`,
 * `transfer-encoding`, `connection`) would let a caller desynchronise the
 * request; `host` and the forwarding family would let it misrepresent the
 * destination or origin; `cookie` would attach ambient authority.
 */
export const FORBIDDEN_TRANSPORT_HEADERS: readonly string[] = [
  "host",
  "content-length",
  "content-type",
  "connection",
  "cookie",
  "set-cookie",
  "transfer-encoding",
  "te",
  "upgrade",
  "keep-alive",
  "expect",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "proxy-authorization",
  "proxy-connection",
];

/** Header values must be single-line printable ASCII — no CR/LF splitting. */
export const HEADER_VALUE_RE = /^[\x20-\x7E]+$/;

/** Header names must be RFC 7230 tokens — no separators, no CR/LF. */
export const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** True when a header name is one the adapter is willing to send. */
export function isPermittedCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    ALLOWED_CREDENTIAL_HEADERS.includes(lower) && !FORBIDDEN_TRANSPORT_HEADERS.includes(lower)
  );
}

export const RegistrarCredentials = z.strictObject({
  /** The complete `Authorization` header value. Never persisted, never logged. */
  authorization: z.string().min(1).max(8_192).regex(HEADER_VALUE_RE, "invalid header value"),
  /**
   * Optional extra headers. The SHAPE is validated here (a well-formed token
   * name, a single-line value); WHICH names are permitted is enforced by the
   * adapter, so a rejected name reports "forbidden header" rather than the
   * misleading "missing credentials".
   */
  additionalHeaders: z
    .record(
      z.string().regex(HEADER_NAME_RE, "invalid header name"),
      z.string().min(1).max(1_024).regex(HEADER_VALUE_RE, "invalid header value"),
    )
    .optional(),
});
export type RegistrarCredentials = z.infer<typeof RegistrarCredentials>;

/**
 * Injected source of outbound authentication material.
 *
 * The adapter NEVER reads an environment variable, file, or database for
 * credentials — it asks this. That keeps secret sourcing a composition-root
 * decision and makes it trivial to prove, in tests, that nothing real is used.
 */
export interface RegistrarCredentialProvider {
  getRegistrarCredentials(): Promise<RegistrarCredentials> | RegistrarCredentials;
}

// — Request —

/**
 * Exactly what goes on the wire. Everything here is a PROTOCOL identifier or the
 * capsule itself.
 *
 * Deliberately absent: internal row ids, the raw `lockToken`, the
 * `claimTokenHash`, source-record private fields, internal error detail, and any
 * credential — authentication travels in headers, never in the body.
 */
export const RegisterRequestEnvelope = z.strictObject({
  protocol: z.literal(REGISTRAR_PROTOCOL),
  version: z.literal(REGISTRAR_PROTOCOL_VERSION),
  operation: z.literal(REGISTRAR_OPERATION),
  submissionAttemptId: SubmissionAttemptId,
  publicationId: PublicationId,
  outboxId: OutboxId,
  /** The outbox idempotency key, so the Registrar can dedupe a resend. */
  idempotencyKey: IdempotencyKey,
  registrarId: RegistrarId,
  nodeId: AnsNodeId,
  capsuleId: CapsuleId,
  publishedContentHash: ContentHash,
  /** The retained capsule, sent verbatim. Never regenerated. */
  capsule: PublishedProductCapsule,
});
export type RegisterRequestEnvelope = z.infer<typeof RegisterRequestEnvelope>;

// — Response —

export const REGISTRAR_RESPONSE_STATUSES = ["ACCEPTED", "REJECTED"] as const;
export const RegistrarResponseStatus = z.enum(REGISTRAR_RESPONSE_STATUSES);
export type RegistrarResponseStatus = z.infer<typeof RegistrarResponseStatus>;

/**
 * What a Registrar may say. `strictObject` REJECTS unknown keys: an unrecognised
 * field means we are talking to something we do not understand, which is a
 * terminal condition rather than something to shrug off.
 *
 * This is NOT a receipt. It is evidence a later ingestion step may turn into one
 * after full Phase 0E.4 reconciliation.
 */
export const RegisterResponseEnvelope = z.strictObject({
  protocol: z.literal(REGISTRAR_PROTOCOL),
  version: z.literal(REGISTRAR_PROTOCOL_VERSION),
  operation: z.literal(REGISTRAR_OPERATION),
  /** Must echo the attempt so a response can be tied to what we sent. */
  submissionAttemptId: SubmissionAttemptId,
  status: RegistrarResponseStatus,
  registrarRegistrationId: z.string().min(1).max(191).optional(),
  registrarId: RegistrarId.optional(),
  nodeId: AnsNodeId.optional(),
  capsuleId: CapsuleId.optional(),
  registeredContentHash: ContentHash.optional(),
  registeredAt: z.iso.datetime().optional(),
  /** Bounded, sanitised Registrar-side codes. Never free-form diagnostics. */
  statusCode: SafeErrorCode.optional(),
  rejectionCode: SafeErrorCode.optional(),
  rejectionReason: SafeErrorSummary.optional(),
});
export type RegisterResponseEnvelope = z.infer<typeof RegisterResponseEnvelope>;

// — Outcome —

/**
 * The five outcomes a send can have.
 *
 *   SUCCESS                     — the Registrar answered and accepted.
 *   REMOTE_REJECTION            — the Registrar answered and refused. NOT a
 *                                 transport failure: the exchange worked.
 *   RETRYABLE_TRANSPORT_FAILURE — we could not complete an exchange, and we know
 *                                 the request did not arrive, or the Registrar
 *                                 told us to come back later.
 *   TERMINAL_TRANSPORT_FAILURE  — something is wrong that retrying will not fix:
 *                                 a protocol, auth, or configuration fault, or a
 *                                 response we cannot understand.
 *   AMBIGUOUS_DELIVERY          — we do not know whether it arrived. Treated
 *                                 conservatively as "possibly delivered".
 */
export const TRANSPORT_OUTCOMES = [
  "SUCCESS",
  "REMOTE_REJECTION",
  "RETRYABLE_TRANSPORT_FAILURE",
  "TERMINAL_TRANSPORT_FAILURE",
  "AMBIGUOUS_DELIVERY",
] as const;
export const TransportOutcome = z.enum(TRANSPORT_OUTCOMES);
export type TransportOutcome = z.infer<typeof TransportOutcome>;

/**
 * Bounded failure detail. Reuses the safe-metadata contracts, so a raw network
 * library message, a URL with credentials, or a response body can never be
 * carried here.
 */
export const TransportFailureDetail = z.strictObject({
  code: SafeErrorCode,
  summary: SafeErrorSummary,
});
export type TransportFailureDetail = z.infer<typeof TransportFailureDetail>;

/**
 * The structured result of exactly one send.
 *
 * `transmitted` is the field the dispatch layer acts on: it means "the request
 * may have reached the Registrar", and is deliberately TRUE whenever we cannot
 * prove otherwise.
 */
export const TransportResult = z.strictObject({
  outcome: TransportOutcome,
  /**
   * True when the request may have reached the Registrar — including the
   * ambiguous case. False only when failure is known to precede transmission.
   */
  transmitted: z.boolean(),
  httpStatus: z.int().min(100).max(599).optional(),
  /** Present only when a well-formed response envelope was parsed. */
  response: RegisterResponseEnvelope.optional(),
  failure: TransportFailureDetail.optional(),
});
export type TransportResult = z.infer<typeof TransportResult>;

/** The transport port the dispatch layer depends on. One send, no retries. */
export interface RegistrarRegisterTransport {
  sendRegisterRequest(
    request: RegisterRequestEnvelope,
    endpoint: RegistrarEndpoint,
  ): Promise<TransportResult>;
}

// — HTTP status classification —

/** Statuses the Registrar uses to say "not now". */
export const RETRYABLE_HTTP_STATUSES: readonly number[] = [408, 425, 429];

/**
 * Classify an HTTP status that carried no usable response envelope.
 * 2xx is handled separately, by parsing.
 */
export function classifyHttpStatus(status: number): TransportOutcome {
  if (RETRYABLE_HTTP_STATUSES.includes(status)) return "RETRYABLE_TRANSPORT_FAILURE";
  if (status >= 500) return "RETRYABLE_TRANSPORT_FAILURE";
  // Everything else — 3xx (we do not follow redirects) and other 4xx
  // protocol/auth/config faults — will not be fixed by trying again.
  return "TERMINAL_TRANSPORT_FAILURE";
}
