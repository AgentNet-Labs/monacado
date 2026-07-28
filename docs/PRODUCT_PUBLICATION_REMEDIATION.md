# Publication Remediation (Phase 0E.5.2)

An explicit, auditable way for a **person** to decide what happens to a Product
publication whose registration was refused, or whose receipt turned out to
describe something else.

Still **fully offline**: no Registrar call, no Publisher submission, no Resolver
lookup, no scheduler, no automatic remediation. Builds on
[`PRODUCT_REGISTRAR_RECEIPTS.md`](PRODUCT_REGISTRAR_RECEIPTS.md) and
[`PRODUCT_PUBLICATION_OUTBOX_PROCESSING.md`](PRODUCT_PUBLICATION_OUTBOX_PROCESSING.md).

## Why remediation exists

Phase 0E.4 deliberately made two things immovable:

- a **matching rejection** is a definitive refusal, so its work item is
  dead-lettered;
- an **acceptance may not overwrite** a recorded rejection or mismatch.

Both are correct, and together they left publications with nowhere to go. A
Registrar that refused for a transient reason, or a receipt that named the wrong
capsule, would strand the publication permanently. Remediation is the explicit
door out — and it is a door only a person can open.

## Immutable receipt evidence

Remediation **never rewrites history**:

- Registrar receipts are never overwritten or deleted. After a retry that
  succeeds, both the original rejection and the later acceptance remain.
- Expected identifiers and hashes (`nodeId`, `capsuleId`,
  `publishedContentHash`, `candidateHash`) stay exactly as prepared.
- The capsule payload is never regenerated or altered — a retry re-authorises
  the **same** capsule.
- No replacement `ProductPublication` is created.

Each decision is itself immutable: `PublicationRemediation` is written once,
carries no `updatedAt`, and records the state it was decided against
(`priorRegistrationState`, `priorReconciliationState`, `priorOutboxStatus`,
`priorRemediationState`). It holds no receipt contents and no capsule body.

## The remediation state model

`remediationState` on `ProductPublication`, deliberately separate from
`publicationStatus`, `registrationState`, `reconciliationState`, `outboxStatus`,
and Node lifecycle:

| State | Meaning |
| --- | --- |
| `NOT_REQUIRED` | Nothing to decide. The initial state, and where a clean publication stays. |
| `REQUIRED` | A matching rejection, or any mismatched receipt, means a person must decide. |
| `RETRY_AUTHORIZED` | Someone authorised one further registration attempt. |
| `CLOSED` | Someone decided this publication will not be registered. **Terminal** in this phase. |
| `RESOLVED` | A matching acceptance settled it, with or without a preceding decision. |

Set by **receipt recording**:

| Receipt outcome | `remediationState` |
| --- | --- |
| Matching acceptance | `RESOLVED` |
| Matching rejection | `REQUIRED` |
| Mismatched acceptance | `REQUIRED` |
| Mismatched rejection | `REQUIRED` |

Set by **remediation**: `RETRY` → `RETRY_AUTHORIZED`, `CLOSE` → `CLOSED`.

`REQUIRED` is only valid alongside adverse evidence — a recorded rejection or a
mismatch. The contract rejects a publication that claims to need remediation for
nothing.

## RETRY

Permitted **only** when all of these hold:

- `remediationState` is `REQUIRED`;
- there is adverse evidence (`registrationState` `REJECTED` **or**
  `reconciliationState` `MISMATCH`);
- the outbox payload is **still retained** — this phase never regenerates a
  capsule, so a disposed body means no retry is possible;
- the work item is not `COMPLETED`;
- no matching acceptance already settled the publication;
- an explicit `retryAvailableAt` is supplied.

Effects:

| Field | Result |
| --- | --- |
| `remediationState` | → `RETRY_AUTHORIZED` |
| `registrationState` | → `PENDING` (the prior verdict no longer stands) |
| `reconciliationState` | → `PENDING` |
| `outboxStatus` | → `RETRYABLE` |
| `availableAt` | → the supplied `retryAvailableAt` |
| `lockToken`, `lockedAt`, `leaseExpiresAt`, `completedAt` | cleared |
| `lastErrorCode`, `lastErrorSummary` | **cleared** — see below |
| `attemptCount`, `payload`, `payloadHash` | **preserved** |
| receipts, expected identifiers, hashes, source pointers, mapping metadata | **preserved** |

**On clearing the previous error metadata.** That metadata describes an attempt
this authorisation supersedes; leaving it would report freshly-authorised work as
already failed. The evidence is not lost — it survives in the immutable receipt
(`rejectionCode` / `rejectionReason`) and in the remediation record's `prior*`
fields. This is a deliberate, tested decision.

The re-authorised item is ordinary `RETRYABLE` work: a worker claims it again in
the normal way, and `attemptCount` advances on that claim.

## Acceptance after RETRY

A later **matching** acceptance may resolve a publication in `RETRY_AUTHORIZED`.
Phase 0E.4's guard against overwriting a rejection or mismatch is satisfied
precisely because a governed decision cleared the verdict back to `PENDING` — the
guard is not weakened, it is answered.

The resulting acceptance behaves exactly as in Phase 0E.4: `ACCEPTED`/`MATCHED`,
outbox `COMPLETED`, payload disposed, `payloadHash` retained. Identity and
content-hash matching are **unchanged** — a mismatched receipt after a retry is
still a mismatch and puts the publication back to `REQUIRED`.

> **A defect this phase fixed.** The "one accepted receipt per publication"
> unique slot was previously claimed by *any* `ACCEPTED` receipt, including one
> that failed reconciliation. That would have permanently blocked the genuine
> acceptance a retry exists to obtain. The slot is now claimed only by an
> acceptance that actually **reconciled**.

## CLOSE

Permitted **only** when `remediationState` is `REQUIRED`.

| Field | Result |
| --- | --- |
| `remediationState` | → `CLOSED` |
| `registrationState`, `reconciliationState` | **retained** — closing records a decision, it does not revise the verdict |
| `outboxStatus` | → `DEAD_LETTER` |
| `lockToken`, `lockedAt`, `leaseExpiresAt` | cleared |
| `payload`, `payloadHash`, `attemptCount`, prior error metadata, receipts | **retained** as evidence |

Because a mismatch leaves the work item `PROCESSING`, `CLOSE` may move it to
`DEAD_LETTER` from `PENDING`, `PROCESSING`, or `RETRYABLE` as well as leaving it
there. This is an administrative decision, not a worker transition, so it has its
own authority over the work item — but it can never re-terminate something
already `COMPLETED` or `CANCELLED`.

### Acceptance after CLOSE is prohibited

A matching acceptance **cannot** resolve a `CLOSED` publication. Recording one is
refused with a `ReceiptConflictError`, the publication stays `CLOSED`, and
nothing is disposed. Reopening a closed decision is an explicit future phase —
a late receipt must not quietly undo a governed decision.

## Payload retention

| Situation | Payload |
| --- | --- |
| `REQUIRED` (rejection or mismatch) | retained |
| After `RETRY` | retained — it is what gets re-submitted |
| After `CLOSE` | retained as evidence |
| After a matching acceptance (with or without remediation) | **disposed**, `payloadHash` retained |

A disposed payload makes `RETRY` impossible (`PayloadUnavailableForRetryError`),
because this phase neither regenerates a capsule nor creates a replacement
publication.

## Idempotency and concurrency

- An **identical** `remediationId` replay returns the existing decision with
  `alreadyRemediated: true` and creates nothing.
- The same `remediationId` with **different** data fails
  (`RemediationReplayConflictError`, reporting conflicting field **names** only).
- **Only one active RETRY authorisation** may exist. While a publication is
  `RETRY_AUTHORIZED`, neither a second `RETRY` nor a `CLOSE` is permitted — it
  must first return to `REQUIRED` through a later receipt outcome.
- `RETRY` and `CLOSE` both fail against `CLOSED` and against `RESOLVED`.
- The decision is applied in **one transaction**, with a guarded update that
  re-asserts the `remediationState` decided against. Of several concurrent
  decisions exactly one wins; the losers are refused rather than silently
  overwriting. A failed transaction leaves the publication, its work item, and
  the remediation history untouched.

## Actor and reason audit fields

- `decidedBy` is an **opaque actor identifier** (`mon:actor:<opaque>`). An email
  address, display name, or other private profile datum is refused at the
  contract boundary. Mapping an opaque actor to a real person is an
  authorisation concern for a later phase.
- `decidedAt` is supplied explicitly — no clock is read inside the service.
- `reasonCode` and `reasonSummary` reuse the Phase 0E.3 safe-metadata contracts,
  so credentials, connection strings, integrity hashes, and capsule content are
  refused rather than persisted.

## Cross-entity invariants

Some rules relate the publication to its work item and cannot live on either row
alone (`assertRemediationConsistency`):

- `RETRY_AUTHORIZED` requires outbox `RETRYABLE` **and** a retained payload;
- `CLOSED` must leave no claimed (`PROCESSING`) work item;
- `RESOLVED` requires `ACCEPTED`/`MATCHED` **and** a disposed payload.

Violations raise `PersistedRemediationContractViolationError`.

## Error model

`RemediationPublicationNotFoundError`, `RemediationNotRequiredError`,
`InvalidRemediationActionError`, `RemediationConflictError`,
`RemediationReplayConflictError`, `PayloadUnavailableForRetryError`,
`RetryTimeRequiredError`, `PublicationClosedError`, `PublicationResolvedError`,
`PersistedRemediationContractViolationError` — plus the existing
`ValidationError` and `DatabaseError`.

All reuse the hardened **non-enumerable internal cause** pattern. None expose
receipt contents, the capsule payload, hash values, lock tokens, credentials, or
raw Prisma text. Bounded state names (`CLOSED`, `NOT_REQUIRED`) are safe to
surface and are; nothing else is.

## Deferred

- **Reopening a CLOSED publication.** Deliberately absent — closing is terminal
  in this phase.
- **Receipt-to-attempt binding** arrived in Phase 0E.5.3: an authorised retry now
  produces a **new submission attempt**, and a receipt must name the exact attempt
  it answers — so a receipt for the pre-retry attempt can no longer resolve the
  retry. The decision also abandons the replaced claim's unresolved attempts in
  the same transaction. See
  [`PRODUCT_PUBLICATION_SUBMISSION_ATTEMPTS.md`](PRODUCT_PUBLICATION_SUBMISSION_ATTEMPTS.md).
- **Automatic remediation** — nothing decides anything by itself; there is no
  policy engine, no auto-retry after N failures, and no escalation.
- **Live Registrar/Publisher/Resolver integration**, background workers,
  scheduled retries, supersession and revocation, production DB wiring,
  authentication, Stripe, and UI.
- **Authorisation** — this phase records *which opaque actor* decided, but does
  not check whether they were permitted to.

## Validation & commands

`db:check` proves the remediation table, unique `remediationId`, foreign keys and
state column exist; that a matching rejection and a mismatch each require
remediation; that `RETRY` records immutable evidence and produces
`RETRY_AUTHORIZED`/`PENDING`/`PENDING` with a `RETRYABLE` work item, applied
`retryAvailableAt`, cleared ownership, and retained payload/hash/attempts; that
prior receipts survive; that a later matching acceptance resolves and disposes
the payload; that `CLOSE` records evidence and produces `CLOSED` + `DEAD_LETTER`
with the payload retained; and that a `CLOSED` publication can be neither retried
nor accepted — then cleans up in FK-safe order with no destructive reset.
