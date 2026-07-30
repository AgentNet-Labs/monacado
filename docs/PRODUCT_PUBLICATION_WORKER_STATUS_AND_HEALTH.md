# Durable Worker-Run Status and Operational Health (Phase 0E.7.3)

One bounded relational row per invocation of the one-shot publication worker
command, plus a safe internal health assessment derived from recent runs.

It answers six questions and nothing else: did the worker start, did it finish,
what bounded outcome did it produce, how much work did it attempt, were there
operational issues, and does recent history look healthy?

## Evidence, never authority

`PublicationWorkerRun` is **operational infrastructure state**. It is not a
publishable capsule, and it is not the authority for anything.

Publication, outbox, submission-attempt, receipt, and remediation records remain
the sole authorities for what happened to the work
([`PRODUCT_PUBLICATION_SINGLE_RUN_ORCHESTRATION.md`](PRODUCT_PUBLICATION_SINGLE_RUN_ORCHESTRATION.md)).
Nothing in this table is ever read back to decide domain state, and no method on
its service returns anything a domain decision could rest on. **If this table were
dropped, every publication would still be in exactly the state its own records
describe.**

That is why the model has **no foreign key** to any domain table. A key would imply
this row participates in publication integrity, and would tie operational
retention to domain retention. `db:check` deletes worker-run rows on their own,
by prefix, in no particular order — precisely because nothing depends on them.

## Safe field policy

Every column is a bounded scalar. There is **no JSON column at all**, so there is
nowhere for arbitrary metadata, a payload, a receipt body, a raw exception, or a
stack trace to accumulate later.

| Stored | Never stored |
| --- | --- |
| `cycleId` (opaque, ≤64 chars) | payload or capsule body |
| `status`, `workerOutcome`, `exitCode` | receipt body |
| `maximumRuns`, `runsAttempted`, `itemsClaimed` | credential or secret variable name |
| `stoppedForNoWork`, `shutdownRequested` | endpoint or allowed origin |
| `expiredClaims{Examined,Recovered,Skipped}` | integrity or content hash |
| `issueCodes` (sorted, comma-joined codes) | lock token or claim-token hash |
| `startedAt`, `completedAt`, `createdAt`, `updatedAt` | environment values, raw Prisma/MySQL text |

The surrogate row `id` never leaves the service layer. It is a storage detail with
no operational meaning, and `cycleId` already identifies a run everywhere else —
in the durable row, in the monitoring output, and in an operator's terminal.

### Issue codes

Stored as one **sorted, deduplicated, comma-joined** list of
SCREAMING_SNAKE_CASE codes in a `VARCHAR(1024)`.

- A code must already satisfy the shared safe-code shape. Anything else is
  **refused, not truncated** — an unrecognised string is exactly where a driver
  message would arrive, and half a driver message in durable storage is worse than
  a rejected write.
- Codes cannot contain a comma by their own shape, so the joined form needs no
  escaping and no JSON.
- Capped at 32 codes.
- Sorted rather than first-seen, because the stored form is compared verbatim when
  checking an identical terminal replay: two invocations that observed the same
  issues in a different order describe the same run.

Codes this phase can actually produce: `MONITORING_HOOK_FAILURE`,
`RUN_STATUS_PERSISTENCE_FAILURE`, `CLEANUP_FAILURE`, `WORKER_RUN_STALE`, plus any
bounded code the Phase 0E.7.1 cycle already reports in its own `issues`.

## Lifecycle

```
STARTED ──► COMPLETED     (coherent cycle result)
        ──► FAILED        (cycle FAILED, cycle threw, or command failed after the row)
        ──► ABANDONED     (explicit operator reconciliation of a run that never reported)
```

`STARTED` is the only non-terminal state. `COMPLETED`, `FAILED`, and `ABANDONED`
never transition again.

`ABANDONED` exists because **process death cannot be observed**. A killed command
leaves a `STARTED` row forever, and no timeout inside the command could cover the
case where the command is the thing that died. Reconciling it is therefore a
separate, explicit, operator-driven decision.

`workerOutcome` stays **null** on a run that failed before producing a cycle
result. Writing `FAILED` into that column would be indistinguishable from a cycle
that ran and failed — and the distinction matters: one means the work was
attempted, the other means it never was.

## Creation boundary

A row is created **only** once all of the following hold:

1. worker configuration is `READY`;
2. Registrar readiness passes;
3. the pre-claim runtime dependencies are constructed;
4. shutdown handlers are installed;
5. the owned database client exists;

— i.e. immediately before the bounded cycle is invoked. Creating it earlier would
record runs that could never have claimed anything; creating it later would lose
exactly the evidence that matters when a command dies mid-cycle.

**Disabled and invalid invocations produce no row**, because they create no
database client at all. That guarantee predates this phase
([`PRODUCT_PUBLICATION_WORKER_ENTRYPOINT.md`](PRODUCT_PUBLICATION_WORKER_ENTRYPOINT.md))
and takes precedence: a disabled worker performs no database access, so it cannot
persist a run, and it does not try. A startup failure before the boundary is
likewise output-only.

## Entry-point integration and its two asymmetric rules

```
config → readiness → dependencies → handlers → db client
       → STARTED row → ONE cycle → terminal row → output → finally: unregister, disconnect
```

The two persistence-failure rules are deliberately **not** symmetric, and the
asymmetry is the whole design:

> **STARTED must be written before the cycle runs. If it cannot be, the cycle does
> not run.** Publishing without durable evidence that we published is the one trade
> this command will not make: an operator would have a registration in the world and
> no record that anything ran. Refusing costs a retry; proceeding costs the audit
> trail. Exit code **70**.

> **A failed terminal write never reruns the cycle.** By then the request has been
> sent, and resending on the strength of a bookkeeping failure would duplicate a
> registration. The command reports `RUN_STATUS_PERSISTENCE_FAILURE` and exits
> **75** (`EX_TEMPFAIL`), leaving the row `STARTED` and reconcilable.

75 is distinct from 1 on purpose: "the cycle failed" and "the cycle succeeded but
we could not record it" call for opposite responses — investigate the publication
path versus investigate the status store — and collapsing them would send an
operator to the wrong place.

Other rules:

- a thrown cycle attempts a **best-effort** `FAILED` finalisation; if that write
  also fails, the row stays `STARTED` and remains reconcilable;
- **monitoring output failure never prevents durable finalisation** — the durable
  row is the audit channel and does not depend on the process channel;
- **cleanup failure never rewrites a durable result.** Cleanup runs after
  finalisation, so a failed disconnect cannot appear in the row; it is reported as
  a bounded monitoring code only;
- exactly one durable row and exactly one cycle per invocation;
- one final `worker.result` line, carrying the real exit code;
- no `process.exit`; no scheduler, loop, sleep, polling, or automatic second cycle.

## Atomicity

- Starting a run is a single `create`.
- Every terminal transition is **compare-and-set**: an `updateMany` whose `WHERE`
  re-asserts `status = 'STARTED'`. A row that moved underneath us matches zero rows
  and the caller is told, rather than a second command silently overwriting the
  first one's evidence.
- **No transaction spans** the worker cycle, the transport, two publication runs,
  or the process lifetime. Operational bookkeeping can never hold a lock across the
  network.
- Worker-run persistence never touches publication, outbox, attempt, receipt, or
  remediation state — asserted by a test that counts every domain table before and
  after.

### Terminal replay

An **identical** terminal replay returns the stored record. That is what makes a
retried finalisation safe.

"Identical" means every authoritative field matches, including the completion
instant: two finalisations that agree on the outcome but disagree on when it
happened are two different pasts, not a replay. A **conflicting** replay throws
`WorkerRunTerminalConflictError` and changes nothing. Terminal history is never
rewritten — a run that reported `COMPLETED` and is later told it `FAILED` describes
two different pasts, and the first is the one an operator has already acted on.

## Stale-run abandonment

`abandonStalePublicationWorkerRuns({ startedBefore, abandonedAt, limit })`.

- **Explicit and operator-driven.** Never invoked automatically, on import, on a
  timer, or at the start of a command. There is no scheduler and no default cutoff:
  only a human (or a future deployment wrapper) knows how long a legitimate command
  may take, and an automatic sweep with a guessed cutoff would eventually mark a
  live run abandoned.
- Only `STARTED` rows with `completedAt IS NULL` and `startedAt < startedBefore`.
- **Oldest first, then by `cycleId`** — a total order, so two sweeps over the same
  data process the same rows in the same order.
- Bounded batch (1…1000), one compare-and-set per row, so a run that finished
  between the scan and the update keeps its own result.
- Original timestamps and counters are preserved; the run keeps whatever it managed
  to report, and gains the bounded code `WORKER_RUN_STALE`.
- Terminal rows are untouchable.

Returns safe counts only: `{ examined, abandonedCount, skippedCount }`.

## Queries

Both are **internal server-only services**. There is no HTTP route, no public
endpoint, and no UI in this phase.

`listRecentPublicationWorkerRuns({ limit, terminalOnly? })`

- `limit` bounded 1…100; out of range is **refused, not clamped**. No unbounded
  scan exists.
- Newest first, ordered by `startedAt DESC, cycleId DESC` — a total order, so two
  calls over unchanged data return the same list even when runs share an instant.
  `startedAt` rather than `completedAt` because it is never null, so an in-flight
  run does not sort unpredictably.
- Safe projection only; no raw row escapes the service.
- No filter language. A bounded limit and a terminal-only flag are what an operator
  needs; an expression language over operational history is a query surface nobody
  asked for.

`getPublicationWorkerHealth({ assessedAt, freshnessSeconds, failureStreakThreshold?, limit })`

- reads only terminal rows, within the bounded window;
- no secret lookup, no network call, no queue mutation, no worker execution, and no
  automatic reconciliation.

## Health classification

`assessPublicationWorkerHealth` is a **pure function** of a bounded record set and
two thresholds. It performs no query, so the entire policy is exercised
exhaustively without a database.

| Assessment | Meaning |
| --- | --- |
| `NO_HISTORY` | no terminal run exists |
| `HEALTHY` | latest terminal run is recent, `COMPLETED`, coherent, and issue-free |
| `DEGRADED` | latest run completed but carries issues, or there are failures in the window, or repeated `RUN_LIMIT_REACHED` |
| `STALE` | latest terminal run is older than the freshness window |
| `FAILED` | latest terminal run is `FAILED`/`ABANDONED`, or a consecutive-failure streak reaches the threshold |

### Precedence

```
NO_HISTORY > FAILED > STALE > DEGRADED > HEALTHY
```

- **`FAILED` outranks `STALE`** because a worker that failed and then stopped
  running is failing; reporting "stale" would send an operator to look at
  scheduling when the last thing it did was break.
- **`STALE` outranks `DEGRADED`** because a run outside the window says nothing
  current about degradation — the freshness problem is the one to fix first.

Coherent outcomes are `COMPLETED`, `NO_WORK`, `RUN_LIMIT_REACHED`,
`SHUTDOWN_REQUESTED`, and `DISABLED`. `NO_WORK` is **healthy**, not a separate idle
state: a worker that ran and found nothing did its job. One `RUN_LIMIT_REACHED` is
ordinary — the bound did its job — but **two in a row** is backlog pressure and
reads as `DEGRADED`.

### Only terminal runs are classified

A `STARTED` row is evidence that something is in flight, not evidence about health.
It may be a perfectly healthy command running right now, and counting it would make
every invocation briefly look ambiguous. A command that died leaves a `STARTED` row
that becomes `ABANDONED` through explicit reconciliation — and *then* counts as a
failure. That is why abandonment is an operator action rather than an inference the
health query makes on its own.

### Explicit time

`assessedAt` and `freshnessSeconds` are required; there is no default "now" and no
default window, because a health answer whose meaning depends on an unstated
threshold is not actionable. The same data assessed at two instants correctly gives
two answers.

A run whose terminal instant is **after** `assessedAt` is **refused**, not clamped
to age zero. Assessing health as of a moment before a run finished is a
contradiction, and silently absorbing it would hide a clock or ordering bug.

### Scope

The result carries `scope: "PUBLICATION_WORKER_ONLY"`, so a consumer cannot quietly
treat it as a system-wide signal. This is **publication-worker operational health
only**. It is **not**:

- database health;
- Registrar availability;
- Resolver health;
- checkout health;
- Monacado service health.

Worker history cannot support those claims, and a health value that implied them
would be actively misleading.

## Monitoring versus durable authority

JSON Lines remains the **immediate process-observation** channel; durable
worker-run rows are the **post-execution audit and status** channel.

- Both use the **same `cycleId`**, so a stream line and a stored row can always be
  correlated.
- Three announcement events were added: `worker.run_status_started` (stdout),
  `worker.run_status_persisted` (stdout), `worker.run_status_persistence_failed`
  (stderr). They announce what was written and carry no database identifier, SQL
  text, connection detail, or raw cause.
- Monitoring output failure cannot alter a durable record; durable persistence
  failure cannot trigger a resend.
- **No monitoring line is ever persisted.** There is no raw-log storage, no
  log-ingestion subsystem, and no event-by-event table — one bounded summary row
  per invocation, which is what the questions at the top of this document actually
  require.

## Error model

Five reachable errors, all carrying a stable code and at most a `cycleId`:

`INVALID_WORKER_RUN_INPUT`, `DUPLICATE_WORKER_RUN_CYCLE_ID`,
`WORKER_RUN_NOT_FOUND`, `WORKER_RUN_TERMINAL_CONFLICT`,
`WORKER_RUN_PERSISTENCE_FAILURE`.

Deliberately **not** errors: an empty stale sweep (zeroed counts), `NO_HISTORY`
(a health assessment — a freshly deployed worker has no runs, and that is the
correct answer), and an identical terminal replay (returns the stored record).

Internal causes use the shared non-enumerable pattern, so `JSON.stringify(error)`
cannot leak one. No error exposes a credential, endpoint, payload, receipt body,
hash, token, environment value, or raw Prisma/MySQL message.

## Schema and migration

One additive migration, `add_publication_worker_runs`: a single `CREATE TABLE`, no
`DROP`, no `ALTER` of any existing table, and the repository's standard
`utf8mb4_unicode_ci`.

Indexes:

- `UNIQUE (cycleId)` — one durable row per invocation;
- `(status, startedAt)` — the oldest-first stale sweep;
- `(completedAt)` and `(startedAt)` — recent-history and health ordering.

## Deferred

- **Alert routing** — email, Slack, SMS, PagerDuty, webhooks. This phase produces
  an assessment; it ships nothing that delivers one.
- **Dashboards, a public health endpoint, and any UI.**
- **Automatic stale-run reconciliation** and any scheduler, cron, timer, or polling
  loop that would invoke it.
- **Production retention and purge** of operational history.
- **Deployment wiring** — choosing an invocation cadence, a supervisor, and who
  calls the health query.
- Metrics-vendor integration; authentication and authorisation; automatic receipt
  ingestion; live Registrar calls; production database wiring; Resolver
  integration; Stripe; Storefront, Listing, Offer, Review, Buyer, and checkout
  functionality.
