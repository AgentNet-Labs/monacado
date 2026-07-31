/**
 * Internal worker-status route handler (Phase 0E.7.4.2B) — SERVER ONLY.
 *
 * The whole route, expressed **without Next.js**. It takes a cookie header and a
 * query string and returns a status, a JSON-safe body, and headers — so every
 * authentication, authorization, parsing, and response-mapping rule is testable
 * without constructing a framework request. The exported `GET` is a thin wrapper
 * that translates `Request` to these arguments and back.
 *
 * ## What it does not do
 *
 * It owns no policy. Session lifecycle, capability resolution, health assessment,
 * history ordering, safe response projection, and response validation all belong to
 * earlier phases and are **called, never restated**. What is new here is the HTTP
 * boundary: read a cookie, refuse or admit, parse a query, map a principal, and
 * shape a response.
 *
 * It performs **no write**, no worker invocation, no stale-run abandonment, and no
 * network call. It is read-only in the strongest sense available: even session
 * resolution runs without `touch`, so a status read does not update
 * `lastSeenAt`.
 *
 * ## The raw session token
 *
 * Read from the cookie, handed to `resolveAuthenticatedPrincipal`, and then
 * discarded. It is never logged, never audited, never returned, and never passed
 * into the worker-status service — which has no parameter that could accept it.
 */

import "../server-only";
import {
  getInternalPublicationWorkerStatus,
  type InternalPublicationWorkerStatusDeps,
} from "../product/publication-worker-status-service";
import {
  InvalidWorkerStatusRequestError,
  WorkerStatusAccessDeniedError,
} from "../product/worker-status-errors";
import { readSessionCookie } from "../account/session-cookie";
import { resolveAuthenticatedPrincipal } from "../account/account-principal";
import type { AuthenticatedPrincipal } from "../../contracts/account/account";
import { getPrisma } from "../db/client";
import {
  cryptoRequestIdProvider,
  systemRouteClock,
  type RequestIdProvider,
  type RouteClock,
} from "./route-runtime";
import { parseWorkerStatusQuery } from "./worker-status-query";
import {
  createPrincipalWorkerStatusAuthorizer,
  mapAccountPrincipalToWorkerStatusCaller,
} from "./worker-status-caller";

type Db = ReturnType<typeof getPrisma>;

/**
 * Bounded response codes. Every non-200 body is exactly `{ "error": <one of
 * these> }` — no message, no field list, no cause, no stack.
 */
export const ROUTE_ERROR_CODES = {
  unauthenticated: "UNAUTHENTICATED",
  denied: "WORKER_STATUS_ACCESS_DENIED",
  invalidQuery: "INVALID_WORKER_STATUS_QUERY",
  invalidRequest: "INVALID_WORKER_STATUS_REQUEST",
  unavailable: "WORKER_STATUS_UNAVAILABLE",
} as const;

/**
 * `no-store`, always.
 *
 * Worker status is a live operational answer bound to one authenticated operator.
 * A shared cache holding it would serve one operator's view to another, and even a
 * private cache would show a stale health assessment during the incident it is
 * meant to describe. No CORS header is emitted at all — the route is same-origin
 * by omission rather than by a permissive policy someone could widen.
 */
export const ROUTE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
});

export interface RouteResult {
  status: number;
  body: unknown;
  headers: Readonly<Record<string, string>>;
}

// — Audit —

/**
 * Safe route audit events. Identifiers, a classification, and a count — never a
 * response body, run history, cookie, token, email, endpoint, database id, or raw
 * error.
 */
export interface WorkerStatusRouteAudit {
  workerStatusRouteUnauthenticated?(event: { requestId: string }): void;
  workerStatusRouteDenied?(event: { requestId: string; actorId: string }): void;
  workerStatusRouteCompleted?(event: {
    requestId: string;
    actorId: string;
    assessment: string;
    recentRunCount: number;
  }): void;
  workerStatusRouteFailed?(event: { requestId: string; issueCode: string }): void;
}

/**
 * Invoke an audit hook without letting it affect the response.
 *
 * **Documented policy: a route audit failure is swallowed**, matching the Phase
 * 0E.7.4.1 service. It never turns an authorized read into a denial, never changes
 * the body or status, and never triggers any worker action — a hook that throws
 * after the decision cannot un-authorize it, and letting an observability backend
 * deny an operator the health data they are diagnosing an incident with would be
 * the worse failure. Production audit integrity remains deferred.
 */
function notify(fn: (() => void) | undefined): void {
  if (fn === undefined) return;
  try {
    fn();
  } catch {
    // Contained by design. See above.
  }
}

export interface WorkerStatusRouteDeps {
  clock?: RouteClock;
  requestIds?: RequestIdProvider;
  audit?: WorkerStatusRouteAudit;
  db?: Db;
  /** Test seam: substitute session resolution without a database. */
  resolvePrincipal?: (
    token: string,
    options: { now: string; db?: Db },
  ) => Promise<AuthenticatedPrincipal | undefined>;
  /** Test seam: substitute the Phase 0E.7.4.1 service. */
  getStatus?: typeof getInternalPublicationWorkerStatus;
}

/**
 * Handle one GET.
 *
 * Order, and it is deliberate: request id → cookie → principal → 401 → query →
 * caller mapping → 403 → delegate → respond → audit.
 *
 * Authentication precedes query parsing so an anonymous caller learns nothing from
 * probing parameters. Query parsing precedes the 403 so a malformed request is
 * reported as malformed regardless of who sent it — the alternative leaks whether
 * a given account is an operator by varying the status code for the same bad query.
 */
export async function handleWorkerStatusRequest(
  input: { cookieHeader: string | null | undefined; searchParams: URLSearchParams },
  deps: WorkerStatusRouteDeps = {},
): Promise<RouteResult> {
  const requestIds = deps.requestIds ?? cryptoRequestIdProvider;
  const clock = deps.clock ?? systemRouteClock;
  const requestId = requestIds.nextRequestId();

  const fail = (status: number, error: string): RouteResult => ({
    status,
    body: { error },
    headers: ROUTE_HEADERS,
  });

  // — 1-4. Authenticate —
  //
  // The token is read, used, and dropped. Unknown, malformed, expired, revoked,
  // and disabled-account sessions are all simply "not authenticated": one answer,
  // because telling a holder of a stale token why it is stale is information they
  // have no need for.
  const token = readSessionCookie(input.cookieHeader);
  let principal: AuthenticatedPrincipal | undefined;
  if (token !== undefined) {
    const resolve = deps.resolvePrincipal ?? resolveAuthenticatedPrincipal;
    try {
      principal = await resolve(token, {
        now: clock.now().toISOString(),
        // Read-only: no `touch`, so a status read never writes.
        ...(deps.db !== undefined ? { db: deps.db } : {}),
      });
    } catch {
      // A failure while resolving identity is not an authentication success.
      notify(
        deps.audit?.workerStatusRouteFailed &&
          (() =>
            deps.audit?.workerStatusRouteFailed?.({
              requestId,
              issueCode: ROUTE_ERROR_CODES.unavailable,
            })),
      );
      return fail(500, ROUTE_ERROR_CODES.unavailable);
    }
  }

  if (principal === undefined) {
    notify(
      deps.audit?.workerStatusRouteUnauthenticated &&
        (() => deps.audit?.workerStatusRouteUnauthenticated?.({ requestId })),
    );
    return fail(401, ROUTE_ERROR_CODES.unauthenticated);
  }

  // — 5. Query —
  const parsedQuery = parseWorkerStatusQuery(input.searchParams);
  if (!parsedQuery.ok) {
    // Field names are known to the handler but deliberately not returned: the
    // envelope is one bounded code.
    notify(
      deps.audit?.workerStatusRouteFailed &&
        (() =>
          deps.audit?.workerStatusRouteFailed?.({
            requestId,
            issueCode: ROUTE_ERROR_CODES.invalidQuery,
          })),
    );
    return fail(400, ROUTE_ERROR_CODES.invalidQuery);
  }

  // — 6. Map the principal. An ordinary ACCOUNT stops here. —
  const caller = mapAccountPrincipalToWorkerStatusCaller(principal, requestId);
  if (caller === undefined) {
    notify(
      deps.audit?.workerStatusRouteDenied &&
        (() => deps.audit?.workerStatusRouteDenied?.({ requestId, actorId: principal.actorId })),
    );
    // No worker-run query has run, and none will.
    return fail(403, ROUTE_ERROR_CODES.denied);
  }

  // — 7. Delegate. The service authorizes independently before its first query. —
  const getStatus = deps.getStatus ?? getInternalPublicationWorkerStatus;
  const statusDeps: InternalPublicationWorkerStatusDeps = {
    authorizer: createPrincipalWorkerStatusAuthorizer(principal),
    ...(deps.db !== undefined ? { db: deps.db } : {}),
  };

  try {
    const status = await getStatus(
      {
        caller,
        assessedAt: clock.now().toISOString(),
        recentRunLimit: parsedQuery.query.recentRunLimit,
        freshnessSeconds: parsedQuery.query.freshnessSeconds,
        failureStreakThreshold: parsedQuery.query.failureStreakThreshold,
        backlogPressureThreshold: parsedQuery.query.backlogPressureThreshold,
      },
      statusDeps,
    );

    notify(
      deps.audit?.workerStatusRouteCompleted &&
        (() =>
          deps.audit?.workerStatusRouteCompleted?.({
            requestId,
            actorId: caller.actorId,
            assessment: status.assessment,
            recentRunCount: status.recentRuns.length,
          })),
    );

    // — 8. The service's already-validated response, returned unreshaped. —
    //
    // Passed through exactly as produced. Rebuilding or re-projecting it here
    // would create a second definition of "safe" that could drift from the schema
    // that actually enforces it.
    //
    // A FAILED, STALE, or DEGRADED assessment is operational data, not a server
    // fault: the route succeeded in reporting it, so it is 200.
    return { status: 200, body: status, headers: ROUTE_HEADERS };
  } catch (error) {
    // The service authorizes independently; if it refuses, so do we.
    if (error instanceof WorkerStatusAccessDeniedError) {
      notify(
        deps.audit?.workerStatusRouteDenied &&
          (() => deps.audit?.workerStatusRouteDenied?.({ requestId, actorId: caller.actorId })),
      );
      return fail(403, ROUTE_ERROR_CODES.denied);
    }
    const issueCode =
      error instanceof InvalidWorkerStatusRequestError
        ? ROUTE_ERROR_CODES.invalidRequest
        : ROUTE_ERROR_CODES.unavailable;
    notify(
      deps.audit?.workerStatusRouteFailed &&
        (() => deps.audit?.workerStatusRouteFailed?.({ requestId, issueCode })),
    );
    // Bounded code only — never the message, fields, cause, or stack.
    return fail(
      error instanceof InvalidWorkerStatusRequestError ? 400 : 500,
      issueCode,
    );
  }
}
