/**
 * REGISTER request builder (Phase 0E.6.1) — pure and deterministic.
 *
 * Turns one PREPARED submission attempt plus its retained capsule into the exact
 * envelope that goes on the wire. It reads no database, performs no I/O, and
 * **never regenerates the capsule** — the payload is carried through verbatim,
 * because the attempt's `payloadHash` is a promise about that exact byte content.
 *
 * Identifiers come from the attempt's IMMUTABLE record rather than from the
 * publication, so what we send is provably what the attempt committed to.
 *
 * Identical inputs produce byte-equivalent request content: the envelope is a
 * plain object serialised by the canonical JSON procedure, so key insertion
 * order cannot change the bytes.
 */

import {
  REGISTRAR_OPERATION,
  REGISTRAR_PROTOCOL,
  REGISTRAR_PROTOCOL_VERSION,
  RegisterRequestEnvelope,
  type RegisterRequestEnvelope as RequestEnvelope,
} from "./registrar-transport";
import type { PublicationSubmissionAttempt } from "./product-submission-attempt";
import { canonicalJsonString } from "../integrity/canonical-json";
import { canonicalHash } from "../integrity/hash";

export interface BuildRegisterRequestInput {
  /** The attempt to send. Must be PREPARED and REGISTER. */
  attempt: PublicationSubmissionAttempt;
  /** The retained capsule payload, exactly as persisted. */
  payload: unknown;
  /** The outbox idempotency key, so the Registrar can dedupe a resend. */
  idempotencyKey: string;
}

/** Why a request could not be built. Names the RULE, never a hash or payload. */
export interface RequestBuildIssue {
  rule: string;
  reason: string;
}

export class RegisterRequestBuildError extends Error {
  readonly issues: RequestBuildIssue[];
  constructor(issues: RequestBuildIssue[]) {
    super("The REGISTER request could not be built from this submission attempt");
    this.name = "RegisterRequestBuildError";
    this.issues = issues;
  }
}

/**
 * Checks that must hold before anything is sent. Each one prevents sending
 * something we cannot later reconcile:
 *
 *   - a non-PREPARED attempt has already been sent, answered, or abandoned;
 *   - a non-REGISTER operation is not what this transport speaks;
 *   - a missing payload means the body was disposed of after reconciliation;
 *   - a payload whose hash disagrees is not the content the attempt promised.
 */
export function findRequestBuildIssues(input: BuildRegisterRequestInput): RequestBuildIssue[] {
  const issues: RequestBuildIssue[] = [];
  const { attempt, payload } = input;

  if (attempt.attemptStatus !== "PREPARED") {
    issues.push({
      rule: "attempt-status",
      reason: `only a PREPARED attempt may be sent; this one is ${attempt.attemptStatus}`,
    });
  }
  if (attempt.operation !== REGISTRAR_OPERATION) {
    issues.push({ rule: "operation", reason: "only REGISTER is supported" });
  }
  if (payload === undefined || payload === null) {
    issues.push({ rule: "payload-missing", reason: "the capsule payload is no longer retained" });
    return issues;
  }
  if (canonicalHash(payload) !== attempt.payloadHash) {
    issues.push({
      rule: "payload-hash",
      reason: "the payload does not match the hash the attempt committed to",
    });
  }
  return issues;
}

/**
 * Build the validated REGISTER envelope, or throw with structured issues.
 *
 * Note what is NOT copied across: the attempt's `claimTokenHash`, any raw lock
 * token, internal row ids, and source-record internals. Only protocol
 * identifiers and the capsule travel.
 */
export function buildRegisterRequest(input: BuildRegisterRequestInput): RequestEnvelope {
  const issues = findRequestBuildIssues(input);
  if (issues.length > 0) throw new RegisterRequestBuildError(issues);

  const { attempt, payload, idempotencyKey } = input;
  return RegisterRequestEnvelope.parse({
    protocol: REGISTRAR_PROTOCOL,
    version: REGISTRAR_PROTOCOL_VERSION,
    operation: REGISTRAR_OPERATION,
    submissionAttemptId: attempt.submissionAttemptId,
    publicationId: attempt.publicationId,
    outboxId: attempt.outboxId,
    idempotencyKey,
    registrarId: attempt.registrarId,
    nodeId: attempt.nodeId,
    capsuleId: attempt.capsuleId,
    publishedContentHash: attempt.expectedContentHash,
    capsule: payload,
  });
}

/**
 * The exact bytes of a request body. Canonical JSON, so equal envelopes always
 * serialise identically regardless of key insertion order.
 */
export function serializeRegisterRequest(request: RequestEnvelope): string {
  return canonicalJsonString(request);
}
