/**
 * Product publication + publication-outbox domain contracts (Phase 0E.2).
 *
 * The **publication record** is the durable, immutable statement that one exact
 * Product source-record version was prepared for AgentNet registration as one
 * identified capsule, bound to one Product Node. The **outbox item** is the
 * durable unit of work carrying the validated published capsule payload.
 *
 * This phase is fully OFFLINE: preparation only. There is no claiming, retry,
 * receipt, reconciliation, Resolver, or network concept here, and none may be
 * added to these contracts without a new phase.
 *
 * Zod is the single authored source of truth (ADR §8); types are inferred. No
 * passthrough, catch-all, `any`, or arbitrary metadata bags. Prisma types never
 * appear here — they stay inside the persistence adapter.
 */

import { z } from "zod";
import {
  AnsNodeId,
  CapsuleId,
  ContentHash,
  PolicyRef,
  PublisherId,
  SemVer,
} from "../capsule/envelope";
import {
  LOCK_TOKEN_RE,
  OUTBOX_ID_RE,
  PUBLICATION_ID_RE,
  makeOutboxId,
  opaqueBodyFromHex,
} from "../capsule/identity";
import { SafeErrorCode, SafeErrorSummary } from "./safe-error-metadata";
import { canonicalHash } from "../integrity/hash";
import { InternalProductId, SourceRecordId } from "./product-source-record";
import { PublishedProductCapsule } from "./product.capsule";

// — Opaque internal identifiers —

export const PublicationId = z
  .string()
  .regex(PUBLICATION_ID_RE, "publicationId must be opaque (mon:pub:<opaque>); not an ANS Node/capsule ID");
export const OutboxId = z
  .string()
  .regex(OUTBOX_ID_RE, "outboxId must be opaque (mon:obx:<opaque>); not an ANS Node/capsule ID");

// — Bounded state vocabularies (Phase 0E.2 scope) —

/**
 * Publication status. Deliberately bounded to preparation-time states:
 *   PREPARED  — the publication row exists; the outbox item is not yet enqueued.
 *               Because preparation is atomic, this is the in-transaction
 *               initial state and is not observable as a committed state in this
 *               phase. It is retained for future flows that separate preparation
 *               from enqueue.
 *   QUEUED    — publication prepared AND its REGISTER outbox item enqueued. This
 *               is the committed terminal state of preparation in this phase.
 *   CANCELLED — preparation withdrawn before any submission. Reserved; no
 *               cancellation operation is implemented in this phase.
 *
 * Submission, registration, receipt, retry, reconciliation, and Resolver states
 * are NOT part of this enum and must not be added before their phase.
 */
export const PUBLICATION_STATUSES = ["PREPARED", "QUEUED", "CANCELLED"] as const;
export const PublicationStatus = z.enum(PUBLICATION_STATUSES);
export type PublicationStatus = z.infer<typeof PublicationStatus>;

/** Outbox operation type. REGISTER only in this phase. */
export const OUTBOX_OPERATION_TYPES = ["REGISTER"] as const;
export const OutboxOperationType = z.enum(OUTBOX_OPERATION_TYPES);
export type OutboxOperationType = z.infer<typeof OutboxOperationType>;

/**
 * Outbox state (Phase 0E.3 — worker-facing processing states).
 *
 *   PENDING     — durable, unclaimed work, eligible once `availableAt` is due.
 *   PROCESSING  — claimed by exactly one worker, identified by `lockToken`.
 *   RETRYABLE   — a claimed attempt failed recoverably; eligible again at the
 *                 newly scheduled `availableAt`.
 *   COMPLETED   — the attempt succeeded. Terminal.
 *   DEAD_LETTER — the attempt failed unrecoverably. Terminal.
 *   CANCELLED   — withdrawn before processing. Terminal.
 *
 * Registration, receipt, reconciliation, and Resolver states are NOT part of
 * this enum and must not be added before their phase. "COMPLETED" means the
 * outbox attempt finished — it asserts nothing about Registrar registration.
 */
export const OUTBOX_STATUSES = [
  "PENDING",
  "PROCESSING",
  "RETRYABLE",
  "COMPLETED",
  "DEAD_LETTER",
  "CANCELLED",
] as const;
export const OutboxStatus = z.enum(OUTBOX_STATUSES);
export type OutboxStatus = z.infer<typeof OutboxStatus>;

/** Opaque proof that one worker owns one claim. Not an ANS identity, not a credential. */
export const LockToken = z
  .string()
  .regex(LOCK_TOKEN_RE, "lockToken must be opaque (mon:lock:<opaque>)");
export type LockToken = z.infer<typeof LockToken>;

/** Deterministic idempotency key: `sha256:<hex>` over the preparation identity. */
export const IdempotencyKey = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, "idempotencyKey must be sha256:<hex>");

// — Preparation input —

/**
 * Input identifying ONE publication preparation. Every field is explicit: no
 * clock is read, no identifier is invented, and no capsule content is accepted
 * (the capsule is regenerated from the persisted source-record version).
 *
 * `capsuleSemver` must equal the persisted source record's `capsuleSemver`
 * mapping control — the caller states it so that a stale or mismatched intent is
 * rejected rather than silently overridden.
 */
export const ProductPublicationPreparationInput = z.strictObject({
  publicationId: PublicationId,
  internalProductId: InternalProductId,
  sourceRecordId: SourceRecordId,
  sourceRecordVersion: z.string().min(1),
  nodeId: AnsNodeId,
  capsuleId: CapsuleId,
  capsuleSemver: SemVer,
  publishedBy: PublisherId,
  publishedAt: z.iso.datetime(),
  nodePolicy: PolicyRef,
  capsulePolicy: PolicyRef,
  /** Prior capsule this one replaces. Mutually exclusive with `revokes`. */
  supersedes: CapsuleId.optional(),
  /** Prior capsule this one revokes. Mutually exclusive with `supersedes`. */
  revokes: CapsuleId.optional(),
  /** Earliest time the outbox item may be considered for work. */
  availableAt: z.iso.datetime(),
});
export type ProductPublicationPreparationInput = z.infer<typeof ProductPublicationPreparationInput>;

/** True when both supersession and revocation are asserted (always invalid). */
export function hasSupersedesRevokesConflict(input: {
  supersedes?: string;
  revokes?: string;
}): boolean {
  return input.supersedes !== undefined && input.revokes !== undefined;
}

// — Persisted publication —

/**
 * A validated, persisted Product publication record.
 *
 * It holds IDENTITY, LINEAGE, and INTEGRITY only. It deliberately holds **no
 * Product facts** (name, description, image, specifications, capabilities,
 * availability, promotable, relationships) — those live on the immutable source
 * record and, semantically, in the capsule. It holds **no capsule body**: the
 * capsule exists only as the outbox payload. It holds **no Node lifecycle**:
 * lifecycle lives on the Node (ADR §11.9).
 */
export const ProductPublication = z.strictObject({
  id: z.string().min(1),
  publicationId: PublicationId,
  internalProductId: InternalProductId,
  /** The exact immutable source-record version this publication derives from. */
  sourceRecordId: SourceRecordId,
  sourceRecordVersion: z.string().min(1),
  /** The Product Node this capsule binds to. */
  nodeId: AnsNodeId,
  capsuleId: CapsuleId,
  capsuleSemver: SemVer,
  publishedBy: PublisherId,
  publishedAt: z.iso.datetime(),
  nodePolicyRef: z.string().min(1),
  nodePolicyVersion: z.string().min(1),
  capsulePolicyRef: z.string().min(1),
  capsulePolicyVersion: z.string().min(1),
  /** Integrity of the regenerated pre-publication candidate. */
  candidateHash: ContentHash,
  /** The published capsule's own content hash (excludes metadata.contentHash). */
  publishedContentHash: ContentHash,
  /** Mapping controls carried from the source-record version (not Product facts). */
  mappingVersion: z.string().min(1),
  capsuleGeneratedAt: z.iso.datetime(),
  supersedesCapsuleId: CapsuleId.optional(),
  revokesCapsuleId: CapsuleId.optional(),
  publicationStatus: PublicationStatus,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProductPublication = z.infer<typeof ProductPublication>;

/**
 * The validated publication as authored by the service, before persistence
 * assigns the surrogate row id and row timestamps. This is what the persistence
 * adapter turns into a Prisma create input — a validated domain object, never a
 * loose record.
 */
export const ProductPublicationWrite = ProductPublication.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type ProductPublicationWrite = z.infer<typeof ProductPublicationWrite>;

// — Outbox payload & record —

/**
 * The outbox payload is EXACTLY one validated, final published Product capsule —
 * a strict schema, never an arbitrary bag. Credentials, secrets, connection
 * details, and internal authority records cannot appear in it: the published
 * capsule schema is strict and the forbidden-field scan rejects foreign-authority
 * and private fields.
 */
export const ProductPublicationOutboxPayload = PublishedProductCapsule;
export type ProductPublicationOutboxPayload = z.infer<typeof ProductPublicationOutboxPayload>;

/** A validated, persisted publication-outbox record. */
export const ProductPublicationOutbox = z.strictObject({
  id: z.string().min(1),
  outboxId: OutboxId,
  publicationId: PublicationId,
  idempotencyKey: IdempotencyKey,
  operationType: OutboxOperationType,
  payload: ProductPublicationOutboxPayload,
  /** Canonical hash of the payload exactly as stored. */
  payloadHash: ContentHash,
  outboxStatus: OutboxStatus,
  /** Claims made against this item. Incremented by each successful claim. */
  attemptCount: z.int().min(0),
  /** Earliest time this item may be claimed. Rescheduled on each retry. */
  availableAt: z.iso.datetime(),

  // — Claim ownership (present only while PROCESSING) —
  lockedAt: z.iso.datetime().optional(),
  lockToken: LockToken.optional(),

  // — Outcome (Phase 0E.3) —
  /** Set when the attempt COMPLETED. Never set for RETRYABLE or DEAD_LETTER. */
  completedAt: z.iso.datetime().optional(),
  /** Bounded, sanitised failure metadata from the last failed attempt. */
  lastErrorCode: SafeErrorCode.optional(),
  lastErrorSummary: SafeErrorSummary.optional(),

  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type ProductPublicationOutbox = z.infer<typeof ProductPublicationOutbox>;

/** The validated outbox record before persistence assigns row id/timestamps. */
export const ProductPublicationOutboxWrite = ProductPublicationOutbox.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type ProductPublicationOutboxWrite = z.infer<typeof ProductPublicationOutboxWrite>;

// — Preparation result —

export const ProductPublicationPreparationResult = z.strictObject({
  publication: ProductPublication,
  outbox: ProductPublicationOutbox,
  /**
   * True when this call returned an existing prepared publication rather than
   * creating one (an idempotent repeat). No rows are created in that case.
   */
  alreadyPrepared: z.boolean(),
});
export type ProductPublicationPreparationResult = z.infer<typeof ProductPublicationPreparationResult>;

// — Idempotency —

/**
 * The stable preparation identity. Documented and deliberate: a REGISTER
 * publication is identified by WHICH Node, WHICH exact immutable source version,
 * and WHICH capsule identity — not by the Publisher, the publication time, the
 * policy references, or the payload. Those are compared separately so that a
 * repeat asserting different values fails as a structured idempotency conflict
 * instead of silently succeeding.
 */
export interface IdempotencyIdentity {
  nodeId: string;
  sourceRecordId: string;
  sourceRecordVersion: string;
  capsuleId: string;
  operationType: OutboxOperationType;
}

/** Deterministic idempotency key over the canonical preparation identity. */
export function publicationIdempotencyKey(identity: IdempotencyIdentity): string {
  return canonicalHash({
    nodeId: identity.nodeId,
    sourceRecordId: identity.sourceRecordId,
    sourceRecordVersion: identity.sourceRecordVersion,
    capsuleId: identity.capsuleId,
    operationType: identity.operationType,
  });
}

/**
 * Derive the outbox identifier deterministically from the idempotency key, so a
 * repeated preparation names the same outbox item and no identifier has to be
 * invented at the service boundary.
 */
export function deriveOutboxId(idempotencyKey: string): string {
  const hex = IdempotencyKey.parse(idempotencyKey).slice("sha256:".length);
  return makeOutboxId(opaqueBodyFromHex(hex));
}

/** Canonical hash of an outbox payload (reuses the shared canonical primitive). */
export function outboxPayloadHash(payload: unknown): string {
  return canonicalHash(payload);
}

// — Idempotency conflict comparison —

/**
 * Fields that must match for a repeated preparation to be idempotent. These are
 * the assertions a repeat could contradict; the identity fields above already
 * determine that it IS a repeat.
 *
 * `availableAt` is intentionally excluded: it is scheduling metadata, not part of
 * the publication assertion, and a differing value does not make two preparations
 * contradictory.
 */
export const IDEMPOTENCY_COMPARED_FIELDS = [
  "capsuleId",
  "capsuleSemver",
  "publishedBy",
  "publishedAt",
  "nodePolicyRef",
  "nodePolicyVersion",
  "capsulePolicyRef",
  "capsulePolicyVersion",
  "candidateHash",
  "publishedContentHash",
  "supersedesCapsuleId",
  "revokesCapsuleId",
] as const;
export type IdempotencyComparedField = (typeof IDEMPOTENCY_COMPARED_FIELDS)[number];
