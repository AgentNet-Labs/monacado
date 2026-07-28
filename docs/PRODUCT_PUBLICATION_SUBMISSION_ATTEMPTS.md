# Publication Submission Attempts & Receipt Binding (Phase 0E.5.3)

An immutable identity for every outbound Product registration attempt, and a
requirement that each new Registrar receipt names the exact attempt it answers.

Still **fully offline**: preparing and dispatching an attempt records intent and
confirmation. There is no HTTP client, no Publisher or Registrar credential, no
polling, no scheduler, and no automatic receipt ingestion anywhere in this phase.

## Why durable attempt identity is required

Until now a receipt was matched to a publication by identity and hashes. That
answers "is this about our publication?" but not "is this about the request we
actually sent?" — and those diverge the moment a retry exists:

- a lease expires, the claim is recovered, and a worker re-claims;
- a late receipt arrives answering the **abandoned** attempt;
- by identity and hashes alone it is indistinguishable from a receipt answering
  the **current** attempt, so it would resolve the publication on the strength of
  a request that was superseded.

A submission attempt closes that gap. Each attempt records exactly what was
asserted, and a receipt must name one.

## Lock ownership versus submission identity

These are different questions and are now different objects:

| | Answers | Lifetime |
| --- | --- | --- |
| `lockToken` (Phase 0E.3) | **Who** may work on this item right now | One claim; released or expired |
| `submissionAttemptId` | **What** was sent | Permanent; never reused |

A lock is exclusive and transient. An attempt is a durable historical fact. A
receipt binds to the attempt, never to the lock — recording a receipt does **not**
require the worker's lock token, so answering a request never depends on still
holding the claim that produced it.

## Attempt lifecycle

| Status | Meaning |
| --- | --- |
| `PREPARED` | Bound to a live claim; nothing sent yet. |
| `DISPATCHED` | A transport adapter confirmed the request left. **Only a DISPATCHED attempt may receive a receipt.** |
| `RECEIPT_RECORDED` | A Registrar receipt was bound to it. **Terminal.** |
| `ABANDONED` | Its claim expired or was administratively replaced, so it can never be answered. **Terminal.** |

```
PREPARED ──► DISPATCHED ──► RECEIPT_RECORDED
    │             │
    └─────────────┴──────► ABANDONED
```

Each status implies exactly which timestamps must exist — `DISPATCHED` requires
`dispatchedAt`, `ABANDONED` requires `abandonedAt`, `PREPARED` may have neither.
Violations raise `PersistedAttemptContractViolationError`.

### Preparation

`preparePublicationSubmissionAttempt` requires a **live claim**: the work item
`PROCESSING`, owned by the presented token, with an **unexpired lease** judged
against the supplied `preparedAt`. It also requires a retained payload, and
refuses a `CLOSED` or `RESOLVED` publication — a settled publication says so
explicitly rather than reporting the mere consequence that its item isn't claimed.

The attempt captures, immutably: the outbox `attemptCount`, the `REGISTER`
operation, the expected Registrar (the one that issued the Node binding), the
Node, the capsule, the published content hash, and the payload hash.

It returns the attempt **together with the already-persisted payload** a future
transport layer will send. The payload is handed over exactly as stored — never
regenerated, never altered.

**One attempt per claim**, enforced by a unique `(outboxId, attemptNumber)`
index: a second attempt on the same claim is refused. A further attempt requires
a new claim, which raises `attemptCount`.

### Dispatch

`markPublicationSubmissionAttemptDispatched` is a transport adapter reporting
that the request left. It requires the owning token (by hash), a still-live
claim, and `dispatchedAt` at or after `preparedAt`. An identical replay is a
no-op; a different dispatch time is a conflict. **No network call happens here.**

### Abandonment

`markPublicationSubmissionAttemptAbandoned` marks an attempt that can never be
validly answered. Nothing is deleted and no identifier is ever reused.

It is **never run by a scheduler**. It is driven explicitly by callers, and
transactionally by two existing flows:

- **Stale-claim recovery** (Phase 0E.5.1) — recovering an expired claim abandons
  that claim's unresolved attempts in the *same transaction*, so a recovered item
  can never leave an attempt a late receipt could still answer.
- **Remediation** (Phase 0E.5.2) — a `RETRY` or `CLOSE` decision administratively
  replaces the claim, so its unresolved attempts are abandoned in the same
  transaction as the decision.

## Token hashing

The raw `lockToken` is **never persisted**. Only `claimTokenHash`, a one-way
SHA-256 of the token (`sha256:<hex>`), is stored. A stored token would be a
reusable credential; a hash proves ownership on presentation and is worthless if
the row leaks.

Ownership is checked by hashing the presented token and comparing. Neither the
token nor the hash ever appears in an error message.

## Exact-attempt receipt binding

Every receipt recorded through the service must carry a `submissionAttemptId`.
The service then requires the attempt to:

- exist;
- belong to the **same publication and work item**;
- be `DISPATCHED` — not `PREPARED` (nothing was sent), not `ABANDONED`, and not
  already `RECEIPT_RECORDED`.

**Reconciliation is measured against the attempt's immutable expectation**, not
the publication's. The attempt captured what was actually sent, at send time, and
cannot have drifted. A disagreement is still recorded as a `MISMATCH` — it is
evidence, not a hard failure — which is exactly what keeps the Phase 0E.4
mismatch and Phase 0E.5.2 remediation flows reachable.

On success the attempt moves to `RECEIPT_RECORDED` **in the same transaction** as
the receipt and the publication state.

**One authoritative receipt per attempt**, enforced by a unique
`RegistrarReceipt.submissionAttemptId`. A receipt row carries exactly one attempt
reference, so a receipt cannot bind to two attempts.

### Historical receipts

`RegistrarReceipt.submissionAttemptId` is **nullable in the database** purely so
the migration is safe for receipts recorded before this phase. Those rows stay
readable; the service can never create another like them, because the input
contract requires the field.

## Retries and attempt numbering

- Each re-claim increments the outbox `attemptCount`.
- Each new claim can prepare exactly one attempt, at that `attemptNumber`.
- An authorised retry (Phase 0E.5.2) therefore produces a **new attempt with a
  new identifier** under a later attempt number.
- Earlier attempts remain immutable, with their receipts still attached.
- A later matching acceptance resolves **only the attempt it names**.
- A receipt naming an older, abandoned attempt is refused — it cannot resolve the
  newer retry.

`CLOSED` and `RESOLVED` publications can prepare no further attempts, so they can
be neither dispatched nor accepted.

## Immutable attempt history

Identity, hashes, attempt number, and timestamps are never rewritten; the only
writes after creation are the narrow guarded lifecycle transitions above. No
capsule payload and no receipt body is stored on an attempt. All relations use
`ON DELETE RESTRICT`, so attempt history can never be cascade-deleted.

## The transport boundary

This phase deliberately stops at the boundary. `prepare` says *this is what we
are about to send, and here it is*; `dispatch` says *a transport adapter
confirmed it left*.

> **Phase 0E.6.1 note.** That adapter now exists — an outbound HTTP transport
> that sends one prepared attempt and classifies the outcome, marking the attempt
> `DISPATCHED` only when the request may have been transmitted. See
> [`PRODUCT_REGISTRAR_TRANSPORT.md`](PRODUCT_REGISTRAR_TRANSPORT.md). Production
> endpoints, credentials, and worker orchestration remain deferred.

## Error model

`SubmissionAttemptNotFoundError`, `InvalidAttemptTransitionError`,
`AttemptReplayConflictError`, `AttemptAlreadyExistsForClaimError`,
`ClaimNoLongerOwnedError`, `ClaimLeaseExpiredError`,
`ClaimTokenHashMismatchError`, `AttemptNotDispatchedError`,
`AttemptAbandonedError`, `ReceiptAttemptMismatchError`,
`AttemptAlreadyHasReceiptError`, `PersistedAttemptContractViolationError` — plus
the existing `ValidationError` and `DatabaseError`.

All reuse the hardened **non-enumerable internal cause** pattern. None expose a
raw lock token, the `claimTokenHash`, the capsule payload, receipt contents,
integrity hash values, credentials, or raw Prisma text. Only bounded status names
and field names are surfaced.

## Deferred

- **Live network integration** — HTTP submission, Publisher and Registrar
  credentials, endpoints, transport-level retries, and Registrar polling.
- **Automatic receipt ingestion** — receipts still arrive as validated input from
  a caller.
- Worker process, scheduler, automatic dispatch; heartbeat or lease renewal;
  reopening CLOSED publications; authorisation for remediation actors;
  supersession and revocation; Resolver integration; production DB wiring;
  authentication; Stripe; UI.

## Validation & commands

`db:check` proves the attempt table, unique attempt id, one-attempt-per-claim
index and foreign keys exist; that a prepared attempt binds to the current
`attemptCount`; that the raw lock token is absent while `claimTokenHash` is
present; that a wrong token cannot dispatch; that a receipt binds to a dispatched
attempt and marks it `RECEIPT_RECORDED`; that a receipt for an abandoned attempt
is refused; that expired-claim recovery abandons unresolved attempts; that a
re-claim raises `attemptNumber` and yields a distinct attempt; that an
old-attempt receipt cannot resolve the newer one while a matching receipt on the
new attempt does; and that earlier attempts and receipts remain retained.
