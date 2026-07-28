# Publication Outbox Processing (Phase 0E.3)

Worker-facing state transitions and concurrency control for prepared Product
publications. This phase decides **which** item a worker may work on and records
**what happened** — it performs no submission itself.

Still **fully offline**: no network call, no Publisher submission, no Registrar
processing, no worker loop, and no scheduled polling. Builds on
[`PRODUCT_PUBLICATION_PREPARATION.md`](PRODUCT_PUBLICATION_PREPARATION.md).

> **Phase 0E.5.1 note.** A claim now carries a bounded **lease**, and an expired
> claim can be recovered back to `RETRYABLE` — see
> [`PRODUCT_PUBLICATION_LEASE_RECOVERY.md`](PRODUCT_PUBLICATION_LEASE_RECOVERY.md).
> Claiming therefore requires a lease duration or expiry, and every path out of
> `PROCESSING` clears `leaseExpiresAt`.

## Outbox states

| State | Meaning |
| --- | --- |
| `PENDING` | Durable, unclaimed work. Eligible once `availableAt` is due. |
| `PROCESSING` | Claimed by exactly one worker, identified by `lockToken`. |
| `RETRYABLE` | A claimed attempt failed recoverably. Eligible again at the newly scheduled `availableAt`. |
| `COMPLETED` | The attempt succeeded. **Terminal.** |
| `DEAD_LETTER` | The attempt failed unrecoverably. **Terminal.** |
| `CANCELLED` | Withdrawn before processing. **Terminal.** |

`COMPLETED` means **one outbox attempt finished** — it asserts nothing about
Registrar registration. Registration, receipt, reconciliation, and Resolver
states do not exist yet and must not be added before their phase.

The operation type remains **`REGISTER` only**.

## Transition matrix

| From | Allowed to |
| --- | --- |
| `PENDING` | `PROCESSING`, `CANCELLED` |
| `RETRYABLE` | `PROCESSING`, `CANCELLED` |
| `PROCESSING` | `RETRYABLE`, `COMPLETED`, `DEAD_LETTER` |
| `COMPLETED` | *(terminal)* |
| `DEAD_LETTER` | *(terminal)* |
| `CANCELLED` | *(terminal)* |

Everything absent is rejected with `InvalidOutboxTransitionError`.

Note `PROCESSING → CANCELLED` is **not** permitted: a claimed item must first be
resolved by its owning worker (retry, complete, or dead-letter), so cancellation
can never yank work out from under a worker mid-attempt.

**Publication status is untouched by all of this.** A publication stays `QUEUED`
throughout claiming, retrying, completion, and dead-lettering. Outbox state
tracks the *work*; publication state tracks the *preparation*.

> **Phase 0E.5.2 note.** A governed remediation decision may also move the work
> item: `RETRY` returns it to `RETRYABLE` with its payload intact, and `CLOSE`
> dead-letters it. Remediation is an administrative decision rather than a worker
> transition, so it has its own authority over the item — see
> [`PRODUCT_PUBLICATION_REMEDIATION.md`](PRODUCT_PUBLICATION_REMEDIATION.md).

## Claim ordering

Eligibility is `status ∈ {PENDING, RETRYABLE}` **and** `availableAt <= now`,
where `now` is supplied explicitly by the caller — no clock is read inside the
repository, matching the discipline used throughout the Product phases.

Ordering is **`availableAt` ascending, then creation order (`id`)** — fully
deterministic, so two callers agree on the next item and an item cannot be
starved by later arrivals.

The existing `@@index([outboxStatus, availableAt])` serves this query. InnoDB
appends the primary key to every secondary index, so the `(availableAt, id)`
tiebreak is index-ordered without a redundant explicit column — which also keeps
this phase's migration additive (new columns only, no index rebuild).

## Atomic claim

Claiming is a **guarded update** (compare-and-set), not read-then-write:

1. Select the next candidate id deterministically.
2. Issue a single `UPDATE … WHERE id = ? AND status IN (PENDING, RETRYABLE) AND
   availableAt <= now AND lockToken IS NULL`, setting `PROCESSING`, a fresh
   `lockToken`, `lockedAt`, `leaseExpiresAt` (Phase 0E.5.1), and
   `attemptCount = attemptCount + 1`.
3. If the update matched **zero** rows, another worker won the race — the caller
   gets `OutboxClaimConflictError` rather than a silently stolen item.

Because the WHERE clause re-asserts every precondition, **two concurrent
claimers cannot both receive the same item**: exactly one matches a row. This is
covered by a test that races four concurrent claimers against one item and
asserts a single winner and `attemptCount == 1`.

There is deliberately **no loop**: a losing claimer is told, and chooses its own
next move. Callers drive their own cadence.

## Lock-token ownership

Every resolution (`retry`, `complete`, `dead-letter`) requires the `lockToken`
issued by the claim that it is resolving. Tokens are opaque
(`mon:lock:<26 Crockford chars>`) and generated from a CSPRNG. A token is **not**
an ANS identity and **not** a credential.

Checks are ordered deliberately:

1. the item exists;
2. the transition is permitted **from its current state** — so a terminal item
   reports an invalid transition rather than a token mismatch caused by the token
   having already been cleared;
3. the presented token owns the claim;
4. a guarded update re-asserts `(outboxId, lockToken, PROCESSING)` atomically.

A **stale worker cannot** retry, complete, or dead-letter another worker's claim.
Once an item is retried, recovered, or re-claimed, the old token is refused — a
token presented against an item holding no claim raises `StaleClaimError`
(itself an `InvalidOutboxTransitionError`). Error messages never echo either
token.

## Attempt counting

`attemptCount` starts at `0` on preparation and is incremented by **each
successful claim** — so it counts attempts actually started, not failures
recorded. It is never reset.

## Retry scheduling

Retry requires an **explicitly supplied** `availableAt`. No backoff is computed
and no clock is read: scheduling policy belongs to the caller, not to the
persistence layer. Retry clears `lockedAt`/`lockToken`, stores bounded error
metadata, and leaves `payload`, `payloadHash`, and `completedAt` untouched.

## Terminal states

`COMPLETED`, `DEAD_LETTER`, and `CANCELLED` are terminal in this phase: no
outgoing transition is permitted, and none of them is claimable.

## Payload retention

`payload` and `payloadHash` are **never modified** by any transition in this
phase — not on retry, not on completion, not on dead-letter. Every read
re-validates the payload against the strict published-capsule schema and
re-verifies `payloadHash`.

Phase 0E.4 added the one exception: recording a **matching ACCEPTED Registrar
receipt** disposes of the capsule body (see
[`PRODUCT_REGISTRAR_RECEIPTS.md`](PRODUCT_REGISTRAR_RECEIPTS.md)). `payloadHash`
is still retained, the outbox row is never deleted, and the payload may be absent
**only** in `COMPLETED` — absence in any other state is a contract violation. A
completion recorded here *without* a receipt legitimately keeps its payload.

## Safe error metadata

Persisted failure text is the most likely place for a secret to leak into durable
storage, so it is deliberately narrow — and the rule is **reject, not scrub**:

- `lastErrorCode` — `SCREAMING_SNAKE_CASE`, ≤ 64 chars.
- `lastErrorSummary` — ≤ 256 chars, human-written.

Both are refused (`UnsafeErrorMetadataError`) when they contain:

| Rule | Rejects |
| --- | --- |
| `uri-credentials` | `scheme://user:pass@host` |
| `connection-string` | `mysql://`, `postgres://`, `mongodb://`, … |
| `database-url` | any mention of `DATABASE_URL` |
| `secret-assignment` | `password:`, `secret=`, `api_key:`, `bearer:`, … |
| `integrity-hash` | `sha256:<hex>` and friends |
| `capsule-body` | `@context`, `@type`, `"metadata":`, `"payload":` |
| `control-characters` | control bytes |

Callers must therefore pass a deliberate summary — **never a raw driver message,
and never a serialised payload**. Refusals name the rule *class*, never the
offending value, and nothing is persisted by a refused attempt.

## Error model

`NoEligibleOutboxItemError`, `OutboxClaimConflictError`,
`OutboxLockTokenMismatchError`, `InvalidOutboxTransitionError`,
`OutboxNotFoundError`, `UnsafeErrorMetadataError` — plus the existing
`PersistedOutboxContractViolationError`, `ValidationError`, and `DatabaseError`.

All carry stable codes and reuse the hardened **non-enumerable internal cause**
pattern (`attachInternalCause`), so no cause, Prisma text, connection detail,
credential, hash, payload, or lock token can escape through `JSON.stringify`,
object spread, or `Object.keys`.

## Deferred

- **Lease expiry** arrived in Phase 0E.5.1 — a claim held by a crashed worker no
  longer stays held forever. See
  [`PRODUCT_PUBLICATION_LEASE_RECOVERY.md`](PRODUCT_PUBLICATION_LEASE_RECOVERY.md).
  **Lock stealing from a LIVE claim remains deliberately absent**, as do lease
  renewal/heartbeat and any automatic sweep.
- **Worker loop and scheduled polling** — callers claim one item per call.
- **Network submission, Publisher submission, Registrar processing.**
- Registrar receipts, registration state, reconciliation, and payload disposal
  arrived in Phase 0E.4 — see
  [`PRODUCT_REGISTRAR_RECEIPTS.md`](PRODUCT_REGISTRAR_RECEIPTS.md). Remediation
  of mismatches and rejected receipts remains deferred.
- **Supersession and revocation processing.**
- Production DB wiring, authentication, Stripe, UI.

## Validation & commands

`db:check` verifies the new columns (present and nullable), the absence of
receipt/registration/reconciliation/lease columns, a claim (`PENDING →
PROCESSING` with `attemptCount` 1), a retry (lock cleared, payload preserved),
that a retried item is not claimable before its new `availableAt` and is at it,
refusal of unsafe error metadata, and completion with the publication still
`QUEUED` — then cleans up in FK-safe order with no destructive reset.
