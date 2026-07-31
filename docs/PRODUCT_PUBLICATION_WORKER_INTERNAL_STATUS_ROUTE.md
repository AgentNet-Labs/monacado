# Authenticated Internal Worker-Status Route (Phase 0E.7.4.2B)

```
GET /api/internal/operations/publication-worker/status
```

The repository's first HTTP route: authenticated, read-only, and deliberately the
thinnest possible translation layer over the Phase 0E.7.4.1 application service.

## What this is not

No login or signup UI, no worker dashboard, no general RBAC, no service accounts,
no worker controls, no scheduling, no alert delivery, and no production deployment
wiring. `GET` is the only method.

## Method and exposure

- **`GET` only.** No `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, or `HEAD` is
  exported. Next returns 405 for an unexported method, so their *absence* is the
  enforcement. `OPTIONS` is absent deliberately: emitting one would begin a CORS
  story this route does not have.
- **`force-dynamic` + `revalidate = 0`** — never statically generated; the build
  reports it as `ƒ (Dynamic)`.
- **`Cache-Control: no-store`** on every response, success or failure. Worker
  status is a live answer bound to one authenticated operator: a shared cache would
  serve one operator's view to another, and even a private cache would show a stale
  health assessment during the incident it is meant to describe.
- **No CORS header of any kind** — same-origin by omission rather than by a
  permissive policy someone could later widen.
- Not linked from any page, absent from navigation, and there is no `sitemap.ts` or
  `robots.ts`. No client component imports it.
- Nothing runs on import; the database client is constructed lazily on first use.

## Architecture

The exported route file contains **one import and one call**. Everything that
decides anything lives in framework-free modules that take a cookie header and a
query string:

| Module | Responsibility |
| --- | --- |
| `worker-status-query.ts` | pure strict query parser |
| `worker-status-caller.ts` | principal → caller mapping, and the route authorizer |
| `route-runtime.ts` | injected server clock and request-id provider |
| `worker-status-route-handler.ts` | the whole route, without Next.js |
| `app/.../status/route.ts` | `Request`/`Response` translation only |

This is why the entire policy is testable without constructing a framework
request — and why no rule can hide inside a framework object.

### Order of operations

1. generate a bounded `requestId`;
2. read the session cookie;
3. resolve the authenticated principal;
4. **401** if unauthenticated;
5. parse and validate the query;
6. map the principal to a caller context;
7. **403** if the mapping fails;
8. delegate to `getInternalPublicationWorkerStatus`;
9. return its validated response unreshaped;
10. emit a safe route audit event.

Authentication precedes parsing so an anonymous caller learns nothing from probing
parameters. Parsing precedes the 403 so a malformed request is reported as
malformed regardless of who sent it — otherwise the status code for the same bad
query would reveal whether a given account is an operator.

## Session resolution

Uses the Phase 0E.7.4.2A opaque-session helpers unchanged.

- The raw token is read from the fixed cookie, handed to
  `resolveAuthenticatedPrincipal`, and **discarded**. It is never logged, audited,
  returned, or passed into the worker-status service — which has no parameter that
  could accept it.
- **No identity is ever read from a header or from cookie contents.** Account id,
  actor type, capability, and email are all resolved server-side from the token's
  digest.
- No JWT, no bearer token, no local storage.
- Unknown, malformed, expired, revoked, and disabled-account sessions are all
  simply **unauthenticated** — one answer, because telling the holder of a stale
  token why it is stale is information they have no need for.
- Resolution is **read-only**: `touch` is not requested, so a status read does not
  even update `lastSeenAt`.

## Two independent enforcement boundaries

Neither trusts the other, and that is the point:

1. `resolveAuthenticatedPrincipal` derives `INTERNAL_OPERATOR` **only** from an
   active persisted entitlement, read from the database on every request;
2. the Phase 0E.7.4.1 service **independently** calls its injected authorizer
   before its first worker-run query.

If the mapper were weakened, the service would still refuse. If the service's
authorizer were bypassed, the mapper would already have refused to produce a caller
context. A single boundary would make one careless edit sufficient.

The route's authorizer re-asserts both conditions against the same persisted
principal, and additionally checks that the caller context still describes the
principal it came from. There is no permissive default: the decision is `DENIED`
unless every condition holds.

An ordinary authenticated `ACCOUNT` receives **403 and causes zero worker-run
history queries** — the status service is never even invoked.

## Principal-to-caller mapping

`mapAccountPrincipalToWorkerStatusCaller(principal, requestId)` produces exactly:

```
actorId · actorType · requestedCapability · requestId
```

- only `INTERNAL_OPERATOR` maps; `ACCOUNT` returns `undefined`;
- `actorType` is not trusted alone — the capability list it was derived from is
  checked too;
- `requestedCapability` is always the literal `publication-worker:status:read`;
- `actorId` is the stable, opaque, account-derived principal id.

The projection is deliberately lossy. `accountId`, `sessionId`, the raw
capabilities array, the email, the name, the token, the cookie, and any Prisma
record all stay behind.

`INTERNAL_SERVICE` is **not** used and no service-account credential system exists.

## Query contract

| Parameter | Default | Bounds |
| --- | --- | --- |
| `recentRunLimit` | 20 | 1…100 |
| `freshnessSeconds` | 900 | 1…604,800 |
| `failureStreakThreshold` | 2 | 1…10 |
| `backlogPressureThreshold` | 2 | 2…10 |

`freshnessSeconds` defaults to 15 minutes rather than the hour the health contract
permits: an operator opening this route is asking "is the worker running *now*",
and a window wide enough to call an hour-old run fresh answers a different
question.

**Strict allow-list.** Four parameters are recognised; anything else is a 400.
There is no way to supply `assessedAt`, an actor, a capability, an ordering, a
cursor, a filter, a database id, or a Prisma clause — those are absent from the
vocabulary, not merely unsupported.

**Integers are strict** (`^[0-9]+$`). `Number()` and `parseInt()` are both too
permissive for a security boundary: `parseInt("5abc")` is 5, `Number(" 5 ")` is 5,
`Number("")` is 0, `Number("1e2")` is 100. Signed, decimal, exponent,
whitespace-padded, hex, empty, and partially-parsed values are all refused, as are
**duplicate** parameters (`?limit=1&limit=2` is ambiguous, and guessing about a
bound is how a caller gets more data than they asked for).

Out-of-range values are **refused, not clamped**. Rejections report parameter names
internally but the response body carries only a bounded code — never the offending
value.

## Server clock and request id

- `assessedAt` comes from an **injected server clock**. A caller cannot supply it.
- `requestId` comes from an injected cryptographically secure provider:
  `req-<26 Crockford>`, 130 bits of randomness inside the contract's 64-character
  bound. It encodes **nothing** — no account, session, email, IP address, endpoint,
  timestamp, or token — so it cannot leak by being decoded. Randomness rather than a
  counter because request ids appear in audit events, and a guessable one would let
  a third party assert which request a recorded event describes.
- Neither the identity services nor the status service acquires any hidden clock or
  randomness; tests inject deterministic values.

## HTTP response policy

| Status | Body | When |
| --- | --- | --- |
| **200** | the service's validated status response | authorized read, **any** assessment |
| **400** | `{"error":"INVALID_WORKER_STATUS_QUERY"}` | malformed, unknown, duplicate, or out-of-range parameter |
| **400** | `{"error":"INVALID_WORKER_STATUS_REQUEST"}` | the service rejected the assembled request |
| **401** | `{"error":"UNAUTHENTICATED"}` | no, unknown, expired, revoked, or disabled-account session |
| **403** | `{"error":"WORKER_STATUS_ACCESS_DENIED"}` | authenticated but not an entitled operator |
| **500** | `{"error":"WORKER_STATUS_UNAVAILABLE"}` | any other failure |

> **A `FAILED`, `STALE`, or `DEGRADED` assessment returns HTTP 200.** Those are
> operational data about the worker, not faults of this route — the route succeeded
> in reporting them. Mapping them to 500 or 503 would make every health probe treat
> "the worker had a bad run" as "the status endpoint is broken", and an operator
> would lose the ability to distinguish the two.

Every non-200 body is exactly `{ "error": <bounded code> }`: no message, no field
list, no cause, no stack, no Prisma or MySQL detail, no credential, endpoint,
token, cookie, session, or environment value. The 200 body is the service's
already-validated response, **passed through unreshaped** — rebuilding it here
would create a second definition of "safe" that could drift from the schema that
actually enforces it.

There is no redirect to a login page: this is an API route, and a 302 would turn an
authentication failure into an HTML page a machine client cannot read.

## Denied-caller privacy

A denial reveals nothing about worker history — not whether any runs exist, not the
latest assessment, not whether the account is known. The 401 and 403 bodies are
fixed strings, and `db:check` asserts no response of any kind contains a token,
cookie name, email, password hash, `mon:asess:` identifier, or connection string.

## Route audit

Four optional injected events: `workerStatusRouteUnauthenticated`, `...Denied`,
`...Completed`, `...Failed`.

Payloads are limited to `requestId`, the stable `actorId` (after authentication),
the assessment, a recent-run count, and a bounded issue code. The unauthenticated
event carries **only** `requestId` — no actor, no status. Never a response body,
run history, cookie, token, email, endpoint, database id, or raw error.

> **Documented policy: a route audit failure is swallowed**, matching the Phase
> 0E.7.4.1 service. It never turns an authorized read into a denial, never changes
> the status or body, and never triggers any worker action. Letting an
> observability backend deny an operator the health data they are diagnosing an
> incident with would be the worse failure, and a hook that throws after the
> decision cannot un-authorize it. **Production audit integrity remains deferred.**

## Read-only

No database write, no worker invocation, no stale-run abandonment, no queue
mutation, no external Registrar call, no network call, no `process.env` read, and
no timer. `db:check` compares worker-run and session rows byte-for-byte across a
request.

## Deferred

- **Login, logout, and signup surfaces**, and any operator UI or dashboard.
- **Rate limiting** on authentication failures and on this route.
- **Production audit integrity** — durable, tamper-evident route audit.
- Bearer tokens and service accounts; general RBAC; alert delivery; scheduling;
  production deployment wiring; Stripe; marketplace UI.
