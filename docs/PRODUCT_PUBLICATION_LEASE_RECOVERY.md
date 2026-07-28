# Outbox Lease Expiry & Stale-Claim Recovery (Phase 0E.5.1)

Prevents a `PublicationOutbox` item from sitting in `PROCESSING` forever when the
worker holding it crashes, hangs, or is killed.

This was the single most significant limitation called out in
[`PRODUCT_PUBLICATION_OUTBOX_PROCESSING.md`](PRODUCT_PUBLICATION_OUTBOX_PROCESSING.md):
a claim held by a dead worker stayed held. It no longer does.

Still **fully offline** and **caller-driven**: no worker loop, no scheduler, no
polling, no background recovery, no network call.

## Why a lease

Phase 0E.3 made a claim exclusive — one worker, one `lockToken`, guarded
compare-and-set. What it could not do was tell a *dead* claim from a *slow* one.
Without that distinction the safe choice was to leave the item alone, which meant
a crashed worker stranded its item permanently.

A lease supplies the missing fact: **by when** the holder promised to finish.
Past that instant the claim is presumed abandoned and may be recovered.

## Claim expiry

`leaseExpiresAt` is present **if and only if** the item is `PROCESSING`. Every
path out of `PROCESSING` — retry, completion, dead-letter, receipt-driven
completion, and recovery itself — clears it, and the contract rejects any
persisted row that breaks the rule in either direction:

- a `PROCESSING` item **without** a lease could never be recovered — exactly the
  stuck claim this phase exists to prevent;
- a lease **outside** `PROCESSING` means some path left the state without
  releasing ownership.

Both raise `PersistedLeaseContractViolationError` (a subclass of
`PersistedOutboxContractViolationError`, so existing handlers keep working).

## Bounded lease duration

A claim must establish a lease, given as **exactly one** of:

- `leaseDurationSeconds` — bounded to **1 … 86 400** (24 hours);
- `leaseExpiresAt` — an explicit instant, which must be strictly later than `now`.

Supplying both is refused as ambiguous; supplying neither is refused outright.
The lower bound rejects a lease that would be stale the instant it is taken. The
upper bound rejects an effectively-infinite lease, which would quietly
reintroduce the permanently-stuck claim.

Failures are distinguished: `InvalidLeaseDurationError` vs
`InvalidLeaseExpiryError`.

## Explicit time inputs

Every instant is supplied by the caller — `now`, the lease duration or expiry,
and the recovery sweep's `now` and `availableAt`. The repository **never reads a
clock**, matching the discipline used throughout the Product phases and keeping
every test deterministic.

`leaseExpiresAt` is computed once, at claim time, from those explicit inputs.

## Stale-claim recovery

`recoverExpiredPublicationOutboxClaims({ now, limit, availableAt? })` sweeps at
most `limit` rows (bounded 1 … 1000).

**Eligible:** `outboxStatus = PROCESSING` **and** `leaseExpiresAt <= now`.
Ordered by `leaseExpiresAt`, then `id` — the longest-abandoned first.

**Each recovered row:**

| Field | Result |
| --- | --- |
| `outboxStatus` | → `RETRYABLE` |
| `lockToken`, `lockedAt`, `leaseExpiresAt` | cleared |
| `availableAt` | set explicitly — defaults to `now`, i.e. immediately eligible |
| `lastErrorCode` / `lastErrorSummary` | `LEASE_EXPIRED` + a bounded safe summary |
| `attemptCount` | **preserved** — recovery is not a new attempt |
| `payload`, `payloadHash` | **preserved untouched** |

The row is never deleted, and a recovered item is claimable again like any other
`RETRYABLE` item — the next claim increments `attemptCount` normally.

### What is never recovered

- **A live claim.** This is lease *expiry*, not lock *stealing*: an unexpired
  claim is untouched, however long it has been held.
- **Terminal items** (`COMPLETED`, `DEAD_LETTER`, `CANCELLED`) — excluded by the
  `PROCESSING` filter.
- **Receipt-completed items** — see below.

## Concurrency

Each row is taken with a **guarded update** re-asserting `PROCESSING`, an expired
lease, **and the exact `lockToken` observed during selection**. Two concurrent
sweeps therefore cannot both recover the same row: the loser matches zero rows,
counts it as `skipped`, and carries on. A lost race is not an error.

The sweep returns a structured summary — `examined`, `recoveredCount`,
`skippedCount`, and the validated `recovered` records — so a caller can see
exactly what happened. There is **no loop-until-empty**: a sweep that hits its
limit simply leaves the rest for the next call, and says so via `examined`.

## Stale-token invalidation

Once an item is recovered it holds no claim, so the original worker's token is
stale. A resolve attempt (`retry`, `complete`, `dead-letter`) against an item in
a *claimable* state raises **`StaleClaimError`** — deliberately a subclass of
`InvalidOutboxTransitionError`, so callers catching the general case keep
working while new callers can distinguish "your lease lapsed" from "that
transition never made sense".

If the item was recovered **and re-claimed** by another worker, it is `PROCESSING`
again under a new token, and the stale token fails as an
`OutboxLockTokenMismatchError` as before. Either way a stale worker can never
resolve someone else's claim. **No token value is ever echoed in an error.**

## Receipt-completed items

Receipt-driven completion (Phase 0E.4) clears `leaseExpiresAt` along with the
rest of the claim, so a reconciled publication has no lease to expire and can
never be swept. The recovery query additionally excludes any item whose
publication is `ACCEPTED` + `MATCHED` — redundant with the `PROCESSING` filter,
but it makes the guarantee explicit rather than incidental.

This matters because such an item has had its payload **disposed of**: recovery
must never resurrect a disposed capsule body into retryable work.

## No scheduler in this phase

Recovery is an operation, not a daemon. Nothing calls it automatically. There is
no cron, no interval, no background task, and no worker orchestration — the
caller decides when to sweep and how large a batch to take.

## Deferred

- **Monitoring and alerting** on stale-claim volume, lease-expiry rates, and
  repeatedly-recovered items.
- **Automatic worker orchestration** — a scheduled sweep, adaptive lease lengths,
  or a supervisor that sizes leases to observed attempt durations.
- **Lease renewal / heartbeat** for a long-running but healthy attempt. Today a
  worker that legitimately needs longer must take a longer lease up front.
- **A recovery cap or dead-letter escalation** for an item recovered repeatedly —
  `attemptCount` grows but nothing acts on it yet.
- Binding receipts to lock tokens; receipt remediation; rejected-receipt retry
  workflows; live Registrar/Publisher/Resolver calls; supersession and
  revocation; production DB wiring; authentication; Stripe; UI.

## Validation & commands

`db:check` proves the column exists, is nullable, and is indexed; that a claim
records `lockedAt`/`lockToken`/`leaseExpiresAt`; that a non-expired claim is not
recovered; that an expired one becomes `RETRYABLE` with ownership cleared and
attempts, payload, and hash preserved; that a recovered item can be reclaimed;
that the stale original token can no longer resolve it; and that a
receipt-completed item has no lease and is never recovered.
