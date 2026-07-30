/**
 * Internal operational status contracts (Phase 0E.7.4.1).
 *
 * The request, caller context, authorization vocabulary, and **safe response
 * projection** for one internal application-service operation: "what is the
 * publication worker's current health, and what did it recently do?"
 *
 * Three properties shape everything below:
 *
 *   1. **The response is an allow-list, not a filter.** Every field a caller may
 *      see is named here. A record is projected field by field onto this schema and
 *      the schema is `strictObject`, so a column added to persistence later cannot
 *      reach a caller by accident — it reaches them only when someone writes it
 *      here and decides it is safe. The surrogate database id, `createdAt`, and
 *      `updatedAt` are deliberately absent.
 *
 *   2. **The caller context is a closed shape, not a bag.** One literal capability,
 *      two bounded actor types, and two opaque identifiers. There are no arbitrary
 *      role names, scopes, metadata maps, environment values, credentials, database
 *      ids, or raw request objects — none of which an authorization decision at
 *      this boundary needs, and all of which would be places for a secret to
 *      arrive.
 *
 *   3. **No policy lives here.** Health precedence, reason codes, recent-run
 *      ordering, and issue-code parsing all belong to Phase 0E.7.3 and are
 *      delegated, never restated.
 *
 * This module is pure data. It performs no query, reads no clock, and is not
 * exported through the browser-facing contracts barrel.
 */

import { z } from "zod";
import {
  MAX_BACKLOG_PRESSURE_STREAK,
  MAX_FAILURE_STREAK,
  MAX_HEALTH_FRESHNESS_SECONDS,
  MAX_WORKER_RUN_ISSUE_CODES,
  MIN_BACKLOG_PRESSURE_STREAK,
  MIN_FAILURE_STREAK,
  MIN_HEALTH_FRESHNESS_SECONDS,
  RecentWorkerRunLimit,
  WorkerHealthAssessment,
  WorkerHealthReasonCode,
  WorkerRunCycleId,
  WorkerRunIssueCode,
  WorkerRunStatus,
  WORKER_HEALTH_REASON_CODES,
} from "./publication-worker-run";
import { WorkerCycleOutcome } from "./publication-worker-cycle";

// — Caller context —

/**
 * Who may ask. Two bounded types, because this boundary serves exactly two kinds
 * of caller: a human operator and another Monacado-internal service.
 *
 * There is deliberately no `EXTERNAL_*` type and no anonymous type. This phase
 * builds no public surface, and a vocabulary that could describe one would invite
 * a route to be wired to it later without a fresh decision.
 */
export const WORKER_STATUS_ACTOR_TYPES = ["INTERNAL_OPERATOR", "INTERNAL_SERVICE"] as const;
export const WorkerStatusActorType = z.enum(WORKER_STATUS_ACTOR_TYPES);
export type WorkerStatusActorType = z.infer<typeof WorkerStatusActorType>;

/**
 * The single capability this operation requires.
 *
 * A `z.literal`, not a free string: general RBAC is explicitly out of scope, and
 * one named capability keeps the authorization question answerable ("may this
 * actor read publication-worker status?") rather than open-ended.
 */
export const PUBLICATION_WORKER_STATUS_READ_CAPABILITY = "publication-worker:status:read";

/** Opaque, bounded identifiers. Never an email, a database id, or a session token. */
const OpaqueActorId = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,191}$/, "actorId must be an opaque bounded identifier");
const OpaqueRequestId = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{1,64}$/, "requestId must be an opaque bounded identifier");

export const InternalCallerContext = z.strictObject({
  actorId: OpaqueActorId,
  actorType: WorkerStatusActorType,
  requestedCapability: z.literal(PUBLICATION_WORKER_STATUS_READ_CAPABILITY),
  requestId: OpaqueRequestId,
});
export type InternalCallerContext = z.infer<typeof InternalCallerContext>;

// — Authorization —

/**
 * Two decisions. Not a boolean, so an authorizer that returns something
 * unexpected — `undefined` from an unimplemented stub, say — cannot be mistaken
 * for consent by a truthiness check.
 */
export const AUTHORIZATION_DECISIONS = ["AUTHORIZED", "DENIED"] as const;
export const WorkerStatusAuthorizationDecision = z.enum(AUTHORIZATION_DECISIONS);
export type WorkerStatusAuthorizationDecision = z.infer<typeof WorkerStatusAuthorizationDecision>;

/**
 * The injected authorization port.
 *
 * There is **no default implementation and no default-allow fallback**: the
 * application service requires an authorizer, so a caller cannot obtain status by
 * omitting one. Production identity, sessions, API keys, and shared secrets are
 * all deferred — this phase defines the seam, not the policy behind it.
 */
export interface PublicationWorkerStatusAuthorizer {
  authorizePublicationWorkerStatusRead(
    caller: InternalCallerContext,
  ): WorkerStatusAuthorizationDecision | Promise<WorkerStatusAuthorizationDecision>;
}

// — Request —

export const GetInternalPublicationWorkerStatusRequest = z.strictObject({
  caller: InternalCallerContext,
  /** Explicit assessment instant. There is no default "now" at this boundary. */
  assessedAt: z.iso.datetime(),
  freshnessSeconds: z
    .int()
    .min(MIN_HEALTH_FRESHNESS_SECONDS)
    .max(MAX_HEALTH_FRESHNESS_SECONDS),
  /** How many recent runs to return and consider. Bounded 1…100. */
  recentRunLimit: RecentWorkerRunLimit,
  failureStreakThreshold: z.int().min(MIN_FAILURE_STREAK).max(MAX_FAILURE_STREAK),
  backlogPressureThreshold: z
    .int()
    .min(MIN_BACKLOG_PRESSURE_STREAK)
    .max(MAX_BACKLOG_PRESSURE_STREAK)
    .optional(),
});
export type GetInternalPublicationWorkerStatusRequest = z.infer<
  typeof GetInternalPublicationWorkerStatusRequest
>;

// — Response —

/**
 * One recent run, as a caller may see it.
 *
 * Enumerated field by field. The surrogate database id is absent because it is a
 * storage detail with no operational meaning — `cycleId` identifies a run in the
 * durable row, in the JSON-lines output, and in an operator's terminal.
 * `createdAt`/`updatedAt` are absent because they describe when the *row* was
 * written, not when the *work* happened, and `startedAt`/`completedAt` already
 * answer the operational question.
 */
export const InternalWorkerRunSummary = z.strictObject({
  cycleId: WorkerRunCycleId,
  status: WorkerRunStatus,
  workerOutcome: WorkerCycleOutcome.nullable(),
  exitCode: z.int().min(0).max(255).nullable(),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().nullable(),
  maximumRuns: z.int().min(0),
  runsAttempted: z.int().min(0),
  itemsClaimed: z.int().min(0),
  shutdownRequested: z.boolean(),
  stoppedForNoWork: z.boolean(),
  recovery: z.strictObject({
    examined: z.int().min(0),
    recovered: z.int().min(0),
    skipped: z.int().min(0),
  }),
  issueCodes: z.array(WorkerRunIssueCode).max(MAX_WORKER_RUN_ISSUE_CODES),
});
export type InternalWorkerRunSummary = z.infer<typeof InternalWorkerRunSummary>;

export const InternalPublicationWorkerStatus = z.strictObject({
  /**
   * A standing disclaimer carried in the payload. This is publication-worker
   * operational health — not database, Registrar, Resolver, checkout, or Monacado
   * service health — and a consumer cannot quietly widen it.
   */
  scope: z.literal("PUBLICATION_WORKER_ONLY"),
  /** Echoed so a caller can correlate a response with its own request. */
  requestId: OpaqueRequestId,
  assessment: WorkerHealthAssessment,
  assessedAt: z.iso.datetime(),
  mostRecentTerminalRunAt: z.iso.datetime().nullable(),
  mostRecentOutcome: WorkerCycleOutcome.nullable(),
  reasonCodes: z.array(WorkerHealthReasonCode).max(WORKER_HEALTH_REASON_CODES.length),
  counts: z.strictObject({
    /** Terminal runs the health assessment considered. */
    considered: z.int().min(0),
    completed: z.int().min(0),
    failed: z.int().min(0),
    abandoned: z.int().min(0),
    withIssues: z.int().min(0),
    /** Runs returned in `recentRuns`, which may include in-flight rows. */
    returned: z.int().min(0),
  }),
  recentRuns: z.array(InternalWorkerRunSummary).max(100),
});
export type InternalPublicationWorkerStatus = z.infer<typeof InternalPublicationWorkerStatus>;

// — Audit —

/**
 * Safe audit payloads. Every field is an identifier, a classification, or a count.
 *
 * Never a worker payload, credential, endpoint, hash, token, database id,
 * environment value, raw error, or the status response itself — an audit trail
 * that embedded the answer would double every disclosure it recorded.
 */
export interface PublicationWorkerStatusAuditEvent {
  actorId: string;
  actorType: WorkerStatusActorType;
  requestId: string;
  capability: string;
}

export interface PublicationWorkerStatusAuditHook {
  publicationWorkerStatusReadAuthorized?(
    event: PublicationWorkerStatusAuditEvent & { decision: "AUTHORIZED" },
  ): void;
  publicationWorkerStatusReadDenied?(
    event: PublicationWorkerStatusAuditEvent & { decision: "DENIED" },
  ): void;
  publicationWorkerStatusReadCompleted?(
    event: PublicationWorkerStatusAuditEvent & {
      assessment: WorkerHealthAssessment;
      recentRunCount: number;
    },
  ): void;
  publicationWorkerStatusReadFailed?(
    event: PublicationWorkerStatusAuditEvent & { issueCode: string },
  ): void;
}
