/**
 * Internal publication-worker status application service (Phase 0E.7.4.1) —
 * SERVER ONLY.
 *
 * One operation: an explicitly authorized internal caller asks for current worker
 * health plus a bounded slice of recent history, and receives one strictly
 * validated safe response.
 *
 * ## What it is not
 *
 * There is no HTTP route, no public endpoint, no dashboard, no production identity
 * or session integration, no API key, no shared secret, and no general RBAC. This
 * phase defines the *application boundary* so that an authenticated route, an
 * operator command, or a test adapter can be built on it later — none of which
 * exists yet, deliberately, because wiring a transport before the authorization
 * seam is settled is how an internal read becomes a public one.
 *
 * ## Authorize before you query
 *
 * The load-bearing rule. Authorization runs **before any database access**, so a
 * denied caller costs exactly one authorizer call and touches no row. That is not
 * only about work avoided: a denial that had already queried could be timed, and a
 * denial that varied with whether history exists would disclose the very thing it
 * refuses to show. The denial is one stable code with no detail.
 *
 * There is no default authorizer and no permissive fallback — the dependency is
 * required, so status cannot be obtained by omitting it.
 *
 * ## It owns no policy
 *
 * Health precedence, reason codes, recent-run ordering, issue-code parsing, and
 * every persistence rule belong to Phase 0E.7.3 and are **called, never restated**
 * ([`PRODUCT_PUBLICATION_WORKER_STATUS_AND_HEALTH.md`](../../../docs/PRODUCT_PUBLICATION_WORKER_STATUS_AND_HEALTH.md)).
 * What is new here is the caller boundary: validation, authorization, projection,
 * and audit.
 *
 * ## Read-only
 *
 * No write, no schema change, no migration, no queue mutation, no worker
 * invocation, and no stale-run abandonment. Two bounded reads and nothing else.
 * Nothing here reads `process.env`, opens a socket, or runs on import.
 */

import "../server-only";
import {
  GetInternalPublicationWorkerStatusRequest,
  InternalPublicationWorkerStatus,
  type InternalCallerContext,
  type InternalWorkerRunSummary,
  type PublicationWorkerStatusAuditHook,
  type PublicationWorkerStatusAuthorizer,
} from "../../contracts/product/publication-worker-status";
import type { PublicationWorkerRunRecord } from "../../contracts/product/publication-worker-run";
import { getPrisma } from "../db/client";
import { PublicationWorkerRunRepository } from "./publication-worker-run-repository";
import { getPublicationWorkerHealth } from "./publication-worker-health-service";
import { WorkerRunError } from "./worker-run-errors";
import {
  InvalidWorkerStatusRequestError,
  UnsafeWorkerStatusResponseError,
  WorkerStatusAccessDeniedError,
  WorkerStatusQueryFailureError,
} from "./worker-status-errors";

type Db = ReturnType<typeof getPrisma>;

/**
 * The narrow slice of the Phase 0E.7.3 repository this service reads.
 *
 * One method, not the whole repository: this boundary lists history and has no
 * business starting, finalising, or abandoning a run. Injectable so a test can
 * drive read failures and unsafe projections without a database.
 */
export interface WorkerRunHistoryPort {
  listRecentPublicationWorkerRuns(input: unknown): Promise<PublicationWorkerRunRecord[]>;
}

export interface InternalPublicationWorkerStatusDeps {
  /** Required. There is deliberately no default and no permissive fallback. */
  authorizer: PublicationWorkerStatusAuthorizer;
  audit?: PublicationWorkerStatusAuditHook;
  history?: WorkerRunHistoryPort;
  db?: Db;
}

/**
 * Invoke an audit hook without letting it affect the read.
 *
 * **Documented policy: an audit-hook failure is swallowed.** It never turns an
 * authorized read into a denial, never changes the response, and never surfaces
 * caller data. The alternative — failing the read — would let an observability
 * backend deny an operator the health information they are diagnosing an incident
 * with, and a hook that throws *after* the decision cannot un-authorize it anyway.
 *
 * It is deliberately not reported as a response issue either: the response
 * contract describes worker status, and mixing audit-pipeline health into it would
 * make callers parse two unrelated concerns. Audit here is best-effort
 * observability; a genuine audit-integrity requirement belongs with the
 * authenticated route adapter that this phase defers.
 */
function notify(fn: (() => void) | undefined): void {
  if (fn === undefined) return;
  try {
    fn();
  } catch {
    // Contained by design. See above.
  }
}

/** The safe, bounded fields shared by every audit event. */
const auditBase = (caller: InternalCallerContext) => ({
  actorId: caller.actorId,
  actorType: caller.actorType,
  requestId: caller.requestId,
  capability: caller.requestedCapability,
});

/** Project one durable record onto the caller-facing summary, field by field. */
function toSummary(record: PublicationWorkerRunRecord): InternalWorkerRunSummary {
  return {
    cycleId: record.cycleId,
    status: record.status,
    workerOutcome: record.outcome,
    exitCode: record.exitCode,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    maximumRuns: record.maximumRuns,
    runsAttempted: record.runsAttempted,
    itemsClaimed: record.itemsClaimed,
    shutdownRequested: record.shutdownRequested,
    stoppedForNoWork: record.stoppedForNoWork,
    recovery: {
      examined: record.expiredClaimsExamined,
      recovered: record.expiredClaimsRecovered,
      skipped: record.expiredClaimsSkipped,
    },
    issueCodes: record.issueCodes,
  } as InternalWorkerRunSummary;
}

/**
 * Read current publication-worker status.
 *
 * Flow, in exactly this order: validate → authorize → bounded history read →
 * delegated health assessment → strict response validation → audit.
 *
 * `recentRuns` includes in-flight `STARTED` rows so an operator can see that
 * something is running right now. The **health assessment ignores them**, exactly
 * as Phase 0E.7.3 defines: a run in flight is not yet evidence about health. The
 * two counts are reported separately (`counts.considered` versus
 * `counts.returned`) rather than reconciled, because they answer different
 * questions.
 */
export async function getInternalPublicationWorkerStatus(
  request: unknown,
  deps: InternalPublicationWorkerStatusDeps,
): Promise<InternalPublicationWorkerStatus> {
  // — 1. Validate. Unknown fields, wrong capability, and out-of-range bounds all
  //      fail here, before an authorizer ever sees the request. —
  const parsed = GetInternalPublicationWorkerStatusRequest.safeParse(request);
  if (!parsed.success) {
    throw new InvalidWorkerStatusRequestError(
      Array.from(new Set(parsed.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }
  const req = parsed.data;
  const caller = req.caller;
  const base = auditBase(caller);

  // — 2. Authorize, BEFORE any database access —
  let decision;
  try {
    decision = await deps.authorizer.authorizePublicationWorkerStatusRead(caller);
  } catch (error) {
    // An authorizer that throws is a denial, not an escape hatch: failing open
    // here would make an outage in the identity path a disclosure.
    notify(
      deps.audit?.publicationWorkerStatusReadFailed &&
        (() =>
          deps.audit?.publicationWorkerStatusReadFailed?.({
            ...base,
            issueCode: "WORKER_STATUS_AUTHORIZATION_FAILURE",
          })),
    );
    void error;
    throw new WorkerStatusAccessDeniedError();
  }

  if (decision !== "AUTHORIZED") {
    notify(
      deps.audit?.publicationWorkerStatusReadDenied &&
        (() => deps.audit?.publicationWorkerStatusReadDenied?.({ ...base, decision: "DENIED" })),
    );
    // No query has run and none will. The error carries no detail — not even
    // whether any worker history exists.
    throw new WorkerStatusAccessDeniedError();
  }

  notify(
    deps.audit?.publicationWorkerStatusReadAuthorized &&
      (() =>
        deps.audit?.publicationWorkerStatusReadAuthorized?.({ ...base, decision: "AUTHORIZED" })),
  );

  const history = deps.history ?? new PublicationWorkerRunRepository(deps.db);

  // — 3. Bounded history read. The limit is validated, never clamped, and there is
  //      no cursor, filter language, or caller-selected ordering: the repository's
  //      deterministic newest-first order is the only one. —
  let recent: PublicationWorkerRunRecord[];
  try {
    recent = await history.listRecentPublicationWorkerRuns({ limit: req.recentRunLimit });
  } catch (error) {
    // A Phase 0E.7.3 fault keeps its own vocabulary rather than being re-badged.
    if (error instanceof WorkerRunError) throw error;
    notify(
      deps.audit?.publicationWorkerStatusReadFailed &&
        (() =>
          deps.audit?.publicationWorkerStatusReadFailed?.({
            ...base,
            issueCode: "WORKER_STATUS_QUERY_FAILURE",
          })),
    );
    throw new WorkerStatusQueryFailureError("history", error);
  }

  // — 4. Health, fully delegated. Precedence, reason codes, the terminal-only rule,
  //      and the future-timestamp refusal all stay in Phase 0E.7.3. —
  let health;
  try {
    health = await getPublicationWorkerHealth({
      assessedAt: req.assessedAt,
      freshnessSeconds: req.freshnessSeconds,
      failureStreakThreshold: req.failureStreakThreshold,
      ...(req.backlogPressureThreshold !== undefined
        ? { backlogPressureThreshold: req.backlogPressureThreshold }
        : {}),
      limit: req.recentRunLimit,
      ...(deps.db !== undefined ? { db: deps.db } : {}),
    });
  } catch (error) {
    if (error instanceof WorkerRunError) throw error;
    notify(
      deps.audit?.publicationWorkerStatusReadFailed &&
        (() =>
          deps.audit?.publicationWorkerStatusReadFailed?.({
            ...base,
            issueCode: "WORKER_STATUS_QUERY_FAILURE",
          })),
    );
    throw new WorkerStatusQueryFailureError("health", error);
  }

  // — 5. Project and validate. This parse is the enforcement gate for "no raw
  //      record escapes": a response that cannot satisfy its own safety contract
  //      is not returned at all. —
  const candidate = {
    scope: "PUBLICATION_WORKER_ONLY" as const,
    requestId: caller.requestId,
    assessment: health.assessment,
    assessedAt: health.assessedAt,
    mostRecentTerminalRunAt: health.mostRecentRunAt ?? null,
    mostRecentOutcome: health.mostRecentOutcome ?? null,
    reasonCodes: health.reasonCodes,
    counts: { ...health.counts, returned: recent.length },
    recentRuns: recent.map(toSummary),
  };

  const validated = InternalPublicationWorkerStatus.safeParse(candidate);
  if (!validated.success) {
    notify(
      deps.audit?.publicationWorkerStatusReadFailed &&
        (() =>
          deps.audit?.publicationWorkerStatusReadFailed?.({
            ...base,
            issueCode: "UNSAFE_WORKER_STATUS_RESPONSE",
          })),
    );
    throw new UnsafeWorkerStatusResponseError(
      Array.from(new Set(validated.error.issues.map((i) => i.path.join(".") || "(root)"))),
    );
  }

  // — 6. Audit the completion with counts and a classification only. The response
  //      itself is never handed to the hook: an audit trail that embedded the
  //      answer would double every disclosure it recorded. —
  notify(
    deps.audit?.publicationWorkerStatusReadCompleted &&
      (() =>
        deps.audit?.publicationWorkerStatusReadCompleted?.({
          ...base,
          assessment: validated.data.assessment,
          recentRunCount: validated.data.recentRuns.length,
        })),
  );

  return validated.data;
}
