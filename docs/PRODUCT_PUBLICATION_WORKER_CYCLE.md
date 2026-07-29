# Bounded Publication Worker Cycle (Phase 0E.7.1)

`runProductPublicationWorkerCycle` invokes the single-run publication
orchestration at most `maximumRuns` times, then returns.

**It is not a daemon.** There is no sleep, no `setTimeout`/`setInterval`, no
polling after the queue drains, no scheduler, no cron, no self-rescheduling, and
no recursion. Deciding to run another cycle stays outside this phase.

## Why bounded

An unbounded loop over a queue is indistinguishable from a daemon, and a daemon
needs shutdown semantics, backoff, supervision, and alerting that this phase
deliberately does not have.

A cycle that **always terminates** can be called from a test, a one-shot process,
or a future scheduler without any of them inheriting a hidden loop. The bound is
`1 … 100`; a value outside it is refused, not clamped — silently shrinking an
operator's request would make the cycle do something other than what was asked.

## It owns no domain rules

Claiming, leases, attempt preparation, dispatch, outcome persistence, and stale-
claim recovery all live in earlier phases and are **called**, never
reimplemented. The cycle touches no domain table and **opens no transaction of
its own**, so no transaction can span the HTTP call or two runs
([`PRODUCT_PUBLICATION_SINGLE_RUN_ORCHESTRATION.md`](PRODUCT_PUBLICATION_SINGLE_RUN_ORCHESTRATION.md)).

## Cycle outcomes

| Outcome | Meaning |
| --- | --- |
| `DISABLED` | Registrar integration off. No queue access at all. |
| `NO_WORK` | The **first** run found nothing. |
| `COMPLETED` | Work was processed, then the queue ran dry. |
| `RUN_LIMIT_REACHED` | The bound stopped us; work may well remain. |
| `SHUTDOWN_REQUESTED` | The injected signal asked us to stop. |
| `FAILED` | A run failed and ended the cycle early. |

`NO_WORK` and `COMPLETED` are distinct because "nothing was due" and "we drained
what was due" call for different operator attention.

### Precedence

When more than one condition applies, exactly this order decides:

```
DISABLED > SHUTDOWN_REQUESTED > FAILED > NO_WORK > COMPLETED > RUN_LIMIT_REACHED
```

`SHUTDOWN_REQUESTED` outranks `FAILED` because an operator who asked us to stop
needs to know that we stopped; a failing run is the ordinary reason a cycle ends
early and is still reported in `issues`.

## Stop conditions

The loop ends when any of these occurs:

- `maximumRuns` is reached;
- a run returns `NO_ELIGIBLE_WORK` — **no re-poll**: work arriving a moment later
  belongs to the next cycle;
- shutdown is requested;
- a run returns `DISABLED`;
- a run throws.

## Shutdown

A narrow injected interface — `isShutdownRequested(): boolean` — polled rather
than pushed, because a boolean asked about at defined points is far easier to
reason about than a callback that can fire mid-transport.

Checked **before the first run**, **before every subsequent run**, and **again
after each result** before committing to another. No `process.on`, no global
mutable state, and no signal registration exists in the domain service.

## Monitoring hooks

Injected, optional, and dependency-free: `cycleStarted`,
`expiredClaimsRecovered`, `runStarted`, `runCompleted`, `runFailed`,
`cycleCompleted`. No logging library and **no `console` output** in the reusable
service.

Events carry only safe operational data — cycle id, run index,
`submissionAttemptId`, outbox/publication identifiers, result classification,
duration, and bounded issue codes. Never a payload, credential, endpoint, lock
token, token hash, integrity hash, receipt body, or raw Prisma/Zod/network error.

Hooks are synchronous and `void`-returning by contract: one that could return a
promise would let a monitoring backend's latency stall a claim's lease.

> **Documented policy: a monitoring-hook failure never stops the cycle and never
> changes a run's outcome.** It is swallowed and recorded as a
> `MONITORING_HOOK_FAILURE` issue code. Letting a logging backend abort a cycle
> would make observability a source of publication failures — and a hook firing
> after a transmitted request could not undo the send anyway.

## Optional stale-claim recovery

When `recovery` is supplied, the existing bounded sweep runs **once, at cycle
start**, never inside the loop
([`PRODUCT_PUBLICATION_LEASE_RECOVERY.md`](PRODUCT_PUBLICATION_LEASE_RECOVERY.md)).
Sweeping repeatedly would let one cycle reclaim items another worker had
legitimately just taken.

Only safe counts (`examined`, `recoveredCount`, `skippedCount`) reach the result
and the monitoring event — never the recovered rows.

Recovery failing is an **issue, not a fault**: it is an optimisation, and being
unable to reclaim a stale lease does not stop us processing work already
eligible. Omitting `recovery` disables it entirely, leaving sweeps to an external
caller.

## Time and identity providers

Both injected: `now(): Date` and `nextSubmissionAttemptId(): string`. There is no
`Date.now()`, no argumentless `new Date()`, and no UUID/ULID/random generation
anywhere in the service — a test controls time exactly.

A clock or id-provider failure is **fatal**, not collected: every durable record
is stamped with these instants, and continuing without a trustworthy clock would
write a timeline that never happened.

An attempt id is taken only immediately before a run, so a cycle that stops for
shutdown does not burn identities. **A run that turns out to find no work still
consumes one**, because the orchestration needs the id before it can discover the
queue is empty; avoiding that would require a pre-check with a
time-of-check/time-of-use race, which is worse than an unused identifier.

## Result aggregation

The cycle **never reinterprets** a domain outcome. Counts are kept in a closed
record with one key per orchestration outcome — not a growable map — so an
unrecognised outcome cannot be silently absorbed, and a compile-time check makes
adding an outcome without a counter a type error.

| Orchestration outcome | Cycle behaviour |
| --- | --- |
| `SENT` | counted; continue |
| `REMOTE_REJECTION` | counted; continue (receipt ingestion is separate) |
| `RETRY_SCHEDULED` | counted; continue |
| `DEAD_LETTERED` | counted; continue |
| `AMBIGUOUS_DELIVERY` | counted; continue to **other** work, never resend |
| `TERMINAL_FAILURE` | counted; continue |
| `NO_ELIGIBLE_WORK` | stop |
| `DISABLED` | stop immediately |

`issues` is capped, so a long cycle cannot grow it without limit.

### A failed run stops the cycle

A run that **throws** ends the cycle with `FAILED` and its bounded issue code.
Continuing would claim more work while an undiagnosed fault is still present —
and a post-transport persistence failure in particular means the durable record
no longer describes the outside world, which is the worst possible moment to take
on another item.

## Ambiguous delivery

The orchestration leaves an ambiguous item `PROCESSING` under its lease, so the
next iteration simply claims a **different** eligible item. The cycle does not
retry, requeue, or revisit it. Nothing resends it.

## No automatic receipt ingestion

The cycle creates no `RegistrarReceipt` and calls no ingestion path. A sent
attempt is left `DISPATCHED`, awaiting an explicit, separately-authorised
ingestion
([`PRODUCT_REGISTRAR_RECEIPT_INGESTION.md`](PRODUCT_REGISTRAR_RECEIPT_INGESTION.md)).

## Process-signal adapter

`createProcessShutdownSignal` translates SIGTERM/SIGINT into the shutdown
interface. It lives in its own module, away from the domain cycle, because
process signals are an ambient global concern and the cycle must stay a pure
function of its injected collaborators.

- **Nothing happens on import** — handlers register only when the factory is
  called.
- **It never calls `process.exit`.** Exiting is the host's decision; killing the
  process here would abandon an in-flight request whose outcome has not been
  recorded, creating exactly the ambiguity the publication path works to avoid.
- It returns an idempotent `unregister()`, and repeated registration cannot leak
  listeners because each call removes precisely the handlers it added.
- The flag **latches**: a second signal neither clears it nor rewrites which
  signal explained the stop.
- **No worker starts.** This produces a signal, nothing more.

## Runtime configuration

`DISABLED` returns immediately with **no database access and no secret lookup** —
asserted by a test that proxies both and counts zero reads. Claiming an item we
could never send would lock real work behind a lease for nothing
([`PRODUCT_REGISTRAR_RUNTIME_CONFIGURATION.md`](PRODUCT_REGISTRAR_RUNTIME_CONFIGURATION.md)).

## Deferred

- **An executable worker** — CLI, package script, daemon, or deployment command.
- **Production scheduling**, process management, and automatic repeated cycles.
- **A monitoring backend**, metrics export, and alerting.
- Automatic receipt ingestion, webhooks, polling; live Registrar calls;
  authentication and authorisation; production database wiring; Resolver
  integration; Stripe; UI; Storefront, Listing, Offer, Review, and Buyer
  functionality.
