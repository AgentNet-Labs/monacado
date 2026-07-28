/**
 * Publication submission-attempt contracts (Phase 0E.5.3).
 *
 * A worker's `lockToken` says WHO may work on an outbox item right now. A
 * **submission attempt** says WHAT was sent: one immutable identity per outbound
 * registration attempt, capturing exactly which Node, capsule, Registrar, and
 * content hash that attempt asserted.
 *
 * Without it a Registrar receipt could only be matched by publication identity
 * and hashes — so a late receipt answering an abandoned attempt was
 * indistinguishable from one answering the current retry. With it, every new
 * receipt must name the exact attempt it answers.
 *
 * The raw lock token is NEVER carried into persistence: only a one-way
 * `claimTokenHash`. This phase remains OFFLINE — preparing and dispatching an
 * attempt records intent and confirmation, and performs no network call.
 *
 * Zod is the single authored source of truth; types are inferred. No passthrough,
 * `any`, or unrestricted JSON.
 */

import { z } from "zod";
import { AnsNodeId, CapsuleId, ContentHash } from "../capsule/envelope";
import { SUBMISSION_ATTEMPT_ID_RE } from "../capsule/identity";
import { RegistrarId } from "./product-node";
import {
  LockToken,
  OutboxId,
  OutboxOperationType,
  PublicationId,
} from "./product-publication";

/** Opaque identifier for one outbound registration attempt. */
export const SubmissionAttemptId = z
  .string()
  .regex(SUBMISSION_ATTEMPT_ID_RE, "submissionAttemptId must be opaque (mon:attempt:<opaque>)");

/**
 * Attempt lifecycle.
 *
 *   PREPARED         — the attempt exists and is bound to a live claim; nothing
 *                      has been sent.
 *   DISPATCHED       — a transport adapter confirmed the request left. Only a
 *                      DISPATCHED attempt may receive a receipt.
 *   RECEIPT_RECORDED — a Registrar receipt was bound to this attempt. Terminal.
 *   ABANDONED        — the claim that owned it expired or was administratively
 *                      replaced, so this attempt can never be answered. Terminal.
 */
export const SUBMISSION_ATTEMPT_STATUSES = [
  "PREPARED",
  "DISPATCHED",
  "RECEIPT_RECORDED",
  "ABANDONED",
] as const;
export const SubmissionAttemptStatus = z.enum(SUBMISSION_ATTEMPT_STATUSES);
export type SubmissionAttemptStatus = z.infer<typeof SubmissionAttemptStatus>;

/** Statuses an attempt may still be abandoned from. */
export const ABANDONABLE_ATTEMPT_STATUSES: readonly SubmissionAttemptStatus[] = [
  "PREPARED",
  "DISPATCHED",
];

/** Statuses from which no further transition is permitted. */
export const TERMINAL_ATTEMPT_STATUSES: readonly SubmissionAttemptStatus[] = [
  "RECEIPT_RECORDED",
  "ABANDONED",
];

/** One-way binding hash of the owning claim's lock token. */
export const ClaimTokenHash = ContentHash;

// — Inputs —

/**
 * Prepare one attempt against a live claim. `preparedAt` doubles as the instant
 * the lease is judged against — supplied explicitly, so no clock is read.
 */
export const PrepareSubmissionAttemptInput = z.strictObject({
  publicationId: PublicationId,
  outboxId: OutboxId,
  /** Proves ownership of the current claim. Hashed before persistence. */
  lockToken: LockToken,
  submissionAttemptId: SubmissionAttemptId,
  preparedAt: z.iso.datetime(),
});
export type PrepareSubmissionAttemptInput = z.infer<typeof PrepareSubmissionAttemptInput>;

/** Confirm a transport adapter sent the request. Still no network call here. */
export const DispatchSubmissionAttemptInput = z.strictObject({
  submissionAttemptId: SubmissionAttemptId,
  lockToken: LockToken,
  dispatchedAt: z.iso.datetime(),
});
export type DispatchSubmissionAttemptInput = z.infer<typeof DispatchSubmissionAttemptInput>;

/**
 * Abandon an attempt whose claim can no longer validly resolve it. Takes no lock
 * token: the whole point is that the owning claim is gone.
 */
export const AbandonSubmissionAttemptInput = z.strictObject({
  submissionAttemptId: SubmissionAttemptId,
  abandonedAt: z.iso.datetime(),
});
export type AbandonSubmissionAttemptInput = z.infer<typeof AbandonSubmissionAttemptInput>;

// — Persisted attempt —

const AttemptCoreFields = {
  submissionAttemptId: SubmissionAttemptId,
  publicationId: PublicationId,
  outboxId: OutboxId,
  attemptNumber: z.int().min(1),
  operation: OutboxOperationType,
  // The immutable expectation a receipt must reconcile against.
  nodeId: AnsNodeId,
  capsuleId: CapsuleId,
  registrarId: RegistrarId,
  expectedContentHash: ContentHash,
  payloadHash: ContentHash,
  claimTokenHash: ClaimTokenHash,
  attemptStatus: SubmissionAttemptStatus,
  preparedAt: z.iso.datetime(),
  dispatchedAt: z.iso.datetime().optional(),
  abandonedAt: z.iso.datetime().optional(),
} as const;

/**
 * Lifecycle-consistency rule: each status implies exactly which timestamps must
 * be present. A DISPATCHED attempt with no `dispatchedAt` could never be
 * ordered against a receipt; an ABANDONED one with no `abandonedAt` loses the
 * audit trail.
 */
export function submissionAttemptTimestampIssue(record: {
  attemptStatus: string;
  dispatchedAt?: string;
  abandonedAt?: string;
}): string | undefined {
  const { attemptStatus, dispatchedAt, abandonedAt } = record;
  if (attemptStatus === "PREPARED") {
    if (dispatchedAt !== undefined) return "PREPARED must not carry dispatchedAt";
    if (abandonedAt !== undefined) return "PREPARED must not carry abandonedAt";
    return undefined;
  }
  if (attemptStatus === "DISPATCHED") {
    if (dispatchedAt === undefined) return "DISPATCHED requires dispatchedAt";
    if (abandonedAt !== undefined) return "DISPATCHED must not carry abandonedAt";
    return undefined;
  }
  if (attemptStatus === "RECEIPT_RECORDED") {
    if (dispatchedAt === undefined) return "RECEIPT_RECORDED requires dispatchedAt";
    if (abandonedAt !== undefined) return "RECEIPT_RECORDED must not carry abandonedAt";
    return undefined;
  }
  // ABANDONED — may or may not have been dispatched first, but must say when.
  if (abandonedAt === undefined) return "ABANDONED requires abandonedAt";
  return undefined;
}

const PublicationSubmissionAttemptShape = z.strictObject({
  id: z.string().min(1),
  ...AttemptCoreFields,
  createdAt: z.iso.datetime(),
});

/** A validated, persisted submission attempt. */
export const PublicationSubmissionAttempt = PublicationSubmissionAttemptShape.superRefine(
  (record, ctx) => {
    const issue = submissionAttemptTimestampIssue(record);
    if (issue) ctx.addIssue({ code: "custom", path: ["attemptStatus"], message: issue });
  },
);
export type PublicationSubmissionAttempt = z.infer<typeof PublicationSubmissionAttempt>;

/** The validated attempt before persistence assigns the row id and timestamp. */
export const PublicationSubmissionAttemptWrite = z.strictObject(AttemptCoreFields);
export type PublicationSubmissionAttemptWrite = z.infer<typeof PublicationSubmissionAttemptWrite>;

// — Result —

/**
 * The outcome of preparing an attempt: the validated attempt plus the payload a
 * future transport layer will send. The payload is returned, never re-derived
 * and never altered — this phase only hands it to the caller.
 */
export const SubmissionAttemptPreparationResult = z.strictObject({
  attempt: PublicationSubmissionAttempt,
  /** The already-persisted published capsule. Not regenerated here. */
  payload: z.unknown(),
  /** True when this call returned an existing identical attempt. */
  alreadyPrepared: z.boolean(),
});
export type SubmissionAttemptPreparationResult = z.infer<typeof SubmissionAttemptPreparationResult>;

// — Transitions —

export const ATTEMPT_TRANSITIONS: Readonly<
  Record<SubmissionAttemptStatus, readonly SubmissionAttemptStatus[]>
> = {
  PREPARED: ["DISPATCHED", "ABANDONED"],
  DISPATCHED: ["RECEIPT_RECORDED", "ABANDONED"],
  RECEIPT_RECORDED: [],
  ABANDONED: [],
};

export function isAllowedAttemptTransition(
  from: SubmissionAttemptStatus,
  to: SubmissionAttemptStatus,
): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

/**
 * Fields that must agree for a repeated `submissionAttemptId` to be an
 * idempotent replay rather than a conflict.
 */
export const ATTEMPT_IDENTITY_FIELDS = [
  "publicationId",
  "outboxId",
  "attemptNumber",
  "operation",
  "nodeId",
  "capsuleId",
  "registrarId",
  "expectedContentHash",
  "payloadHash",
  "claimTokenHash",
  "preparedAt",
] as const;
export type AttemptIdentityField = (typeof ATTEMPT_IDENTITY_FIELDS)[number];

/**
 * Compare a receipt against the attempt it claims to answer. The attempt's
 * expectation is immutable and captured at preparation, so this asks a sharper
 * question than publication-level reconciliation: not merely "is this about our
 * publication?" but "is this about the exact request we sent?".
 */
export const ATTEMPT_RECONCILED_FIELDS = [
  "registrarId",
  "nodeId",
  "capsuleId",
  "registeredContentHash",
] as const;
export type AttemptReconciledField = (typeof ATTEMPT_RECONCILED_FIELDS)[number];

export function reconcileReceiptAgainstAttempt(
  attempt: {
    registrarId: string;
    nodeId: string;
    capsuleId: string;
    expectedContentHash: string;
  },
  receipt: {
    registrarId: string;
    nodeId: string;
    capsuleId: string;
    registeredContentHash: string;
  },
): AttemptReconciledField[] {
  const mismatched: AttemptReconciledField[] = [];
  if (attempt.registrarId !== receipt.registrarId) mismatched.push("registrarId");
  if (attempt.nodeId !== receipt.nodeId) mismatched.push("nodeId");
  if (attempt.capsuleId !== receipt.capsuleId) mismatched.push("capsuleId");
  if (attempt.expectedContentHash !== receipt.registeredContentHash) {
    mismatched.push("registeredContentHash");
  }
  return mismatched;
}
