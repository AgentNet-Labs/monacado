# Internal Publication-Worker Status Service (Phase 0E.7.4.1)

One server-only application-service boundary. An explicitly authorized internal
caller asks for current publication-worker health plus a bounded slice of recent
history, and receives one strictly validated safe response.

```ts
getInternalPublicationWorkerStatus(request, { authorizer, audit?, history?, db? })
```

## What this is not

There is **no HTTP route, no public endpoint, no dashboard, no production identity
or session integration, no API key, no shared secret, and no general RBAC.**

This phase defines the *application boundary* so that an authenticated route, an
operator command, or a test adapter can be built on it later. None of those exists
yet, deliberately: wiring a transport before the authorization seam is settled is
exactly how an internal read becomes a public one.

## Authorize before you query

The load-bearing rule. Authorization runs **before any database access**.

A denied caller costs one authorizer call and touches no row. That is not only
about work avoided:

- a denial that had already queried could be **timed**;
- a denial that varied with whether history exists would **disclose the very thing
  it refuses to show**.

So the denial is one stable code, `WORKER_STATUS_ACCESS_DENIED`, with **no detail
at all** — not which check failed, not whether the actor is known, not whether any
worker history exists. `db:check` and a test both assert the denial is
byte-identical whether the store is empty or full of failures, and that zero
queries ran.

**There is no default authorizer and no permissive fallback.** The dependency is
required, so status cannot be obtained by omitting it.

Phase 0E.7.4.2A supplies what an authorizer can now be built from: a persisted
account, an opaque server-validated session, and an **explicit internal
entitlement** for exactly this capability
([`IDENTITY_SESSION_AND_INTERNAL_ENTITLEMENT_FOUNDATION.md`](IDENTITY_SESSION_AND_INTERNAL_ENTITLEMENT_FOUNDATION.md)).
`resolveAuthenticatedPrincipal` yields `actorType: "INTERNAL_OPERATOR"` only when
that entitlement is active, so a route adapter can map a principal onto the caller
context below without ever authorizing on a login, an email domain, an allow-list,
or an environment value. The adapter itself remains deferred. The decision is a two-value
enum rather than a boolean, so an authorizer returning something unexpected —
`undefined` from an unimplemented stub, say — cannot be mistaken for consent by a
truthiness check. An authorizer that **throws is treated as a denial**: failing
open would turn an outage in the identity path into a disclosure.

## Caller context and capability

A closed shape, not a bag:

| Field | Rule |
| --- | --- |
| `actorId` | opaque, `[A-Za-z0-9._:-]{1,191}` |
| `actorType` | `INTERNAL_OPERATOR` \| `INTERNAL_SERVICE` |
| `requestedCapability` | the literal `publication-worker:status:read` |
| `requestId` | opaque, `[A-Za-z0-9._:-]{1,64}` |

No arbitrary role names, scopes, metadata maps, environment values, credentials,
database ids, or raw request objects — none of which this decision needs, and all
of which would be places for a secret to arrive. Unknown fields fail.

There is no `EXTERNAL_*` or anonymous actor type, because a vocabulary that could
describe a public caller would invite a route to be wired to it without a fresh
decision.

## Query bounds

| Input | Bound |
| --- | --- |
| `recentRunLimit` | 1…100 |
| `freshnessSeconds` | 1…604,800 |
| `failureStreakThreshold` | 1…10 |
| `backlogPressureThreshold` | 2…10, optional |
| `assessedAt` | required; there is no default "now" |

Out-of-range values are **refused, not clamped**. There is no unbounded scan, no
pagination cursor, no filter language, no caller-selected ordering, and no raw
Prisma `where`/`orderBy` reaches persistence. Ordering is the repository's existing
deterministic newest-first order.

`backlogPressureThreshold` is a narrow, principled extension of the Phase 0E.7.3
health input rather than a second implementation: the "consecutive
`RUN_LIMIT_REACHED`" rule now reads its streak length from that field, defaulting
to 2 so existing behaviour is unchanged.

## It owns no policy

Health precedence, reason codes, the terminal-only rule, the future-timestamp
refusal, recent-run ordering, issue-code parsing, and every persistence rule belong
to Phase 0E.7.3 and are **called, never restated**
([`PRODUCT_PUBLICATION_WORKER_STATUS_AND_HEALTH.md`](PRODUCT_PUBLICATION_WORKER_STATUS_AND_HEALTH.md)).

What is new here is the caller boundary: validation, authorization, projection, and
audit.

## Flow

1. **Validate** the request. Unknown fields, wrong capability, and out-of-range
   bounds all fail before an authorizer sees anything.
2. **Authorize** — before any database access.
3. **Bounded history read** via the Phase 0E.7.3 repository.
4. **Delegated health assessment** via `getPublicationWorkerHealth`.
5. **Project and strictly validate** the response.
6. **Audit** the completion.

## Safe response projection

Two gates guard the response, and both are tested:

1. **Projection** copies named fields only, so a column added to persistence later
   cannot ride along. A history record carrying an extra `secretColumn` simply
   never appears.
2. **A final strict parse** is the enforcement gate for "no raw record escapes". A
   response that cannot satisfy its own schema is **not returned at all** — it
   raises `UNSAFE_WORKER_STATUS_RESPONSE`, naming field paths only.

Each recent run exposes exactly: `cycleId`, `status`, `workerOutcome`, `exitCode`,
`startedAt`, `completedAt`, `maximumRuns`, `runsAttempted`, `itemsClaimed`,
`shutdownRequested`, `stoppedForNoWork`, `recovery{examined,recovered,skipped}`,
`issueCodes`.

Absent by design: the **surrogate database id** (a storage detail with no
operational meaning — `cycleId` identifies a run everywhere else) and
**`createdAt`/`updatedAt`** (they describe when the *row* was written, not when the
*work* happened, which `startedAt`/`completedAt` already answer). Also never
present: payload, receipt body, credential, endpoint, hash, token, environment
value, raw error, SQL, or Prisma detail.

The response carries `scope: "PUBLICATION_WORKER_ONLY"`, so a consumer cannot
quietly widen it into a claim about database, Registrar, Resolver, checkout, or
Monacado service health.

### In-flight runs

`recentRuns` **includes** `STARTED` rows so an operator can see that something is
running right now. The **health assessment ignores them**, exactly as Phase 0E.7.3
defines — a run in flight is not yet evidence about health. The two counts are
reported separately (`counts.considered` for terminal runs the assessment used,
`counts.returned` for rows in the list) rather than reconciled, because they answer
different questions.

## Audit hook

Four optional injected hooks: `publicationWorkerStatusReadAuthorized`,
`...Denied`, `...Completed`, `...Failed`.

Safe payloads only — `actorId`, `actorType`, `requestId`, `capability`, the
authorization decision, the assessment, a recent-run count, and a bounded issue
code. **The response itself is never handed to a hook**: an audit trail that
embedded the answer would double every disclosure it recorded. A denial event
carries no status data whatsoever.

> **Documented policy: an audit-hook failure is swallowed.** It never turns an
> authorized read into a denial, never changes the response, and never surfaces
> caller data. Failing the read instead would let an observability backend deny an
> operator the health information they are diagnosing an incident with — and a hook
> that throws after the decision cannot un-authorize it anyway.

It is deliberately **not** reported as a response issue either: the response
contract describes worker status, and mixing audit-pipeline health into it would
make callers parse two unrelated concerns. Audit here is best-effort observability;
a genuine audit-integrity requirement belongs with the authenticated route adapter
this phase defers.

No logging framework, and no `console` output in the service.

## Error model

Four new reachable errors, all with stable codes and bounded field paths:

`INVALID_WORKER_STATUS_REQUEST` · `WORKER_STATUS_ACCESS_DENIED` ·
`WORKER_STATUS_QUERY_FAILURE` · `UNSAFE_WORKER_STATUS_RESPONSE`

Phase 0E.7.3's `InvalidWorkerRunInputError` **propagates unchanged** rather than
being re-badged — one fault, one vocabulary. `NO_HISTORY` and an empty recent-run
list remain ordinary results, not faults.

A request that failed validation never has its *values* echoed: that is exactly
where an operator might have pasted a token into the wrong field. Internal causes
use the shared non-enumerable pattern, so `JSON.stringify(error)` cannot leak one,
and no error exposes a database message, credential, endpoint, hash, token,
environment value, or stack trace.

## Read-only and server-only

- **No write, no schema change, no migration.** Two bounded reads and nothing else.
- **No worker invocation** and **no stale-run abandonment** — a status read never
  reconciles anything. `db:check` asserts a stale `STARTED` row is still `STARTED`
  afterwards, and compares the whole store byte for byte before and after.
- **No `process.env`, no network call, no HTTP request/response dependency, no
  Next.js route, no Express/Fastify server, no scheduler, no timer.**
- **Nothing runs on import.**
- Not exported through the browser-facing contracts barrel; no `NEXT_PUBLIC_`
  value exists.

## The route built on this service

Phase 0E.7.4.2B adds exactly one authenticated caller,
`GET /api/internal/operations/publication-worker/status`
([`PRODUCT_PUBLICATION_WORKER_INTERNAL_STATUS_ROUTE.md`](PRODUCT_PUBLICATION_WORKER_INTERNAL_STATUS_ROUTE.md)).

It restates none of the policy here. It resolves an opaque session, requires an
active persisted entitlement, maps the principal onto the caller context above, and
delegates — so **authorize-before-query survives as a second, independent
boundary**: this service still calls its injected authorizer before its first
worker-run query, regardless of what the route decided. There is still no public
endpoint, no dashboard, and no UI.

## Deferred

- **Operator CLI or any other transport** beyond that one route.
- **Admin dashboard and any UI.**
- **Alert delivery** — email, Slack, SMS, PagerDuty, webhooks.
- **Retention policy** for operational history, and any purge job.
- General RBAC; API keys and shared secrets; metrics-vendor integration;
  schedulers, cron, and polling; automatic receipt ingestion; live Registrar calls;
  production database wiring; Stripe; Storefront, Listing, Offer, Review, Buyer,
  and checkout functionality.
