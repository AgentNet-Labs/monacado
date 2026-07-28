# Registrar Receipts, Reconciliation & Payload Disposal (Phase 0E.4)

Recording what the Registrar said, checking whether it actually refers to the
publication we prepared, and disposing of the transient capsule body once it
demonstrably does.

Receipts arrive as **validated input from a caller** — they are never created
from a transport response. Phase 0E.6.1 added an outbound REGISTER adapter, and
it deliberately returns a Registrar's immediate answer rather than persisting it:
turning that answer into a receipt requires the full reconciliation below. See
[`PRODUCT_REGISTRAR_TRANSPORT.md`](PRODUCT_REGISTRAR_TRANSPORT.md). There is
still no Resolver lookup, worker loop, or scheduled polling. Builds on
[`PRODUCT_PUBLICATION_PREPARATION.md`](PRODUCT_PUBLICATION_PREPARATION.md) and
[`PRODUCT_PUBLICATION_OUTBOX_PROCESSING.md`](PRODUCT_PUBLICATION_OUTBOX_PROCESSING.md).

## The receipt model

`RegistrarReceipt` is the **immutable** record of one Registrar verdict. It is
written once and never updated — there is no `updatedAt` and no update operation.

| Field | Meaning |
| --- | --- |
| `receiptId` | Opaque internal identity (`mon:rcpt:…`), unique |
| `publicationId` | The publication this receipt claims to describe (FK, RESTRICT) |
| `submissionAttemptId` | The exact outbound attempt this receipt answers (Phase 0E.5.3) — required for every new receipt, unique, nullable only for historical rows |
| `outboxId` | The attempt that produced it, when known (FK, RESTRICT) |
| `registrarRegistrationId` | The Registrar's **own** identifier; unique where present |
| `registrarId`, `nodeId`, `capsuleId`, `registeredContentHash` | What the receipt **reports** — compared against expectation, never copied over it |
| `receiptStatus` | `ACCEPTED` or `REJECTED` |
| `registeredAt`, `receivedAt` | Registrar's clock, and ours |
| `receiptDetails` | A narrow, closed, validated structure |

A receipt is **evidence, not authority**. Recording one never rewrites the
publication's expected Node, capsule, or content hash. The capsule body is never
stored on a receipt.

`receiptDetails` is explicitly *not* a metadata bag: it is a strict object of
`registrarStatusCode`, `rejectionCode`, `rejectionReason`, `registrarPolicyRef`,
and `registrarPolicyVersion`. Its free-text fields reuse the Phase 0E.3
safe-metadata contracts, so credentials, connection strings, integrity hashes,
and capsule content are refused at the boundary.

## Registration and reconciliation state

Two bounded enums on `ProductPublication`, deliberately separate from
`publicationStatus` (preparation), from `outboxStatus` (work), and from Node
lifecycle (ADR §11.9):

| `registrationState` | Meaning |
| --- | --- |
| `NOT_SUBMITTED` | Prepared; no Registrar verdict. **The initial state.** |
| `PENDING` | A receipt exists but its verdict is unresolved — it did not reconcile, so it says nothing about this publication. Awaiting remediation |
| `ACCEPTED` | A **matching** accepted receipt was recorded |
| `REJECTED` | A **matching** rejected receipt was recorded. A misidentifying rejection never reaches this state |

| `reconciliationState` | Meaning |
| --- | --- |
| `NOT_REQUIRED` | No receipt recorded yet. **The initial state.** |
| `PENDING` | Reserved; unused in this phase |
| `MATCHED` | The receipt's identity and hash match exactly |
| `MISMATCH` | At least one identity or hash field disagrees |

**Only recording a receipt changes these.** Claiming or completing an outbox item
never marks registration `ACCEPTED` — a Phase 0E.3 completion leaves a
publication at `NOT_SUBMITTED`/`NOT_REQUIRED`, which is covered by a test.

**`publicationStatus` is not touched.** No `REGISTERED` status was added: a
publication's preparation state is not a registration outcome, and registration
already has its own field.

> **Phase 0E.5.3 note.** Every receipt recorded through the service must now name
> the exact **submission attempt** it answers, and that attempt must be
> `DISPATCHED`. Reconciliation is measured against the attempt's *immutable*
> expectation rather than the publication's, which is the same comparison against
> a source that provably cannot have drifted. See
> [`PRODUCT_PUBLICATION_SUBMISSION_ATTEMPTS.md`](PRODUCT_PUBLICATION_SUBMISSION_ATTEMPTS.md).

## Identity and hash matching

Four fields must all agree for a receipt to reconcile:

- `registrarId` — compared against the Registrar that **issued the Node binding**
  (a publication carries no Registrar identity of its own, so the expectation is
  derived from `ProductNode.registrarId` rather than invented);
- `nodeId` — the publication's Node binding;
- `capsuleId` — the published capsule;
- `registeredContentHash` vs the publication's `publishedContentHash`.

Any disagreement is a `MISMATCH`. Expected values are **never** rewritten.

## The decision table

This table is the single documented rule:

| Case | Receipt | Reconciliation | `registrationState` | `reconciliationState` | Outbox | Payload |
| --- | --- | --- | --- | --- | --- | --- |
| **Matching acceptance** | `ACCEPTED` | all four match | `ACCEPTED` | `MATCHED` | `PROCESSING` → `COMPLETED`, `completedAt` set, lock cleared | **cleared** |
| **Misidentifying acceptance** | `ACCEPTED` | any mismatch | `PENDING` | `MISMATCH` | *untouched* | retained |
| **Matching rejection** | `REJECTED` | all four match | `REJECTED` | `MATCHED` | `PROCESSING` → `DEAD_LETTER`, lock cleared | retained |
| **Misidentifying rejection** | `REJECTED` | any mismatch | `PENDING` | `MISMATCH` | *untouched* | retained |

The two rejection rows are the important distinction. **A verdict is only applied
to a publication the receipt actually names.** A receipt that reports a different
Registrar, Node, capsule, or content hash is not about this publication, so its
rejection cannot mark this publication `REJECTED` — no matter how confident the
receipt is. It is kept as immutable mismatch evidence, registration is left
unresolved at `PENDING`, and nothing else moves.

**Mismatch handling.** The receipt is recorded in full (it is evidence worth
keeping), reconciliation is marked `MISMATCH`, and nothing else moves: the
publication is not registered, the outbox is not completed, and the payload is
retained. The caller receives a structured result carrying `mismatchedFields` —
field **names** only, never the compared values, because those include hashes.

**Matching rejections.** A rejection whose Registrar, Node, capsule, and content
hash all match is a definitive refusal of *this* publication:
`registrationState` → `REJECTED`, `reconciliationState` → `MATCHED`, and the
outbox item becomes `DEAD_LETTER` — an existing terminal state that retains the
payload, rather than a new workflow. The bounded rejection code and reason are
copied into `lastErrorCode`/`lastErrorSummary`.

**Misidentifying rejections.** A rejection with **any** identity or hash mismatch
is treated exactly like a misidentifying acceptance: the receipt is retained as
immutable mismatch evidence, `registrationState` → `PENDING`,
`reconciliationState` → `MISMATCH`, the outbox status and its error fields are
left **unchanged**, and the payload is retained. The expected Node ID, capsule
ID, Registrar ID, and hashes are preserved untouched, and the caller receives a
structured mismatch result.

This asymmetry is deliberate. Marking a publication `REJECTED` on the strength of
a receipt that names a *different* Node or capsule would record a false verdict
about work that was never actually refused — and, because an acceptance may not
overwrite a rejection, that false verdict would then block the real one.

An **accepted** receipt requires its outbox item to be `PROCESSING` — the state a
claim leaves it in. An acceptance for an unclaimed item is an
`InvalidReceiptStateError`.

Receipt-driven completion and dead-lettering also **release the claim lease**
(`leaseExpiresAt`, Phase 0E.5.1), so a receipt-completed item can never be picked
up by the stale-claim sweep and its disposed payload can never be resurrected
into retryable work — see
[`PRODUCT_PUBLICATION_LEASE_RECOVERY.md`](PRODUCT_PUBLICATION_LEASE_RECOVERY.md).

## Atomic transaction

Recording the receipt and applying the publication and outbox state changes
happen in **one transaction**. A failure leaves the receipt unrecorded and every
prior state untouched — proven by a test that forces a unique-constraint failure
and asserts no receipt row, no state change, and a retained payload.

## Idempotency and conflicts

- An **identical** receipt replay returns the existing result with
  `alreadyRecorded: true` and creates nothing.
- The same `receiptId` with **different** data fails (`ReceiptConflictError`,
  reporting conflicting field names only).
- The same `registrarRegistrationId` on a different receipt fails — enforced by a
  unique index on a nullable column.
- **One accepted-and-matched receipt per publication**, enforced in the database
  by `acceptedForPublicationId`: a persistence-only column set to `publicationId`
  for an accepted receipt **that also reconciled**, and `NULL` otherwise, so the
  unique index bites exactly once per publication while permitting many rejected
  or mismatched receipts. (MySQL has no partial indexes; this is the standard
  equivalent.) The reconciliation condition was added in Phase 0E.5.2: a
  mismatched acceptance claiming the slot would have permanently blocked the
  genuine acceptance a retry exists to obtain.
- An acceptance **cannot overwrite** a recorded rejection or mismatch by itself.
  Phase 0E.5.2 supplies the explicit door: a governed `RETRY` decision clears the
  verdict back to `PENDING`, after which a matching acceptance may resolve the
  publication. A `CLOSED` publication can never be accepted. See
  [`PRODUCT_PUBLICATION_REMEDIATION.md`](PRODUCT_PUBLICATION_REMEDIATION.md).
- Recording a receipt also sets `remediationState`: a matching acceptance
  `RESOLVED`, and a matching rejection or any mismatch `REQUIRED`.

## Payload disposal

The transient capsule body is cleared **only** on an accepted, reconciled
receipt. Everything needed to reconstruct it is retained:

- `payloadHash` — unchanged, so the disposed body stays verifiable;
- `publishedContentHash` and `candidateHash` on the publication;
- `sourceRecordId` + `sourceRecordVersion` — the exact immutable source version;
- `mappingVersion`, `capsuleSemver`, `capsuleGeneratedAt`;
- Publisher, publication time, and both policy references;
- the receipt itself.

**The outbox row is never deleted.** A mismatched or rejected receipt never
clears a payload.

### Reconstruction guarantee

The published capsule can be regenerated deterministically from retained data
alone — the immutable source-record version through the Phase 0C mapper, then the
Phase 0B.1 finaliser using the publication's own metadata. The result is
byte-identical to the disposed payload: both `db:check` and a test rebuild it and
assert its canonical hash equals the retained `payloadHash` and its
`contentHash` equals the retained `publishedContentHash`.

### Payload-presence rules

- `payload` may be absent **only** in `COMPLETED`. Absence in `PENDING`,
  `PROCESSING`, `RETRYABLE`, `DEAD_LETTER`, or `CANCELLED` is a contract
  violation — durable work must not lose its body.
- While present, the payload must still validate against the strict
  published-capsule schema **and** match `payloadHash`.
- A publication that is `ACCEPTED` **and** `MATCHED` must retain **no** payload.
  This is a cross-entity invariant (`assertPayloadDisposed`), because the outbox
  contract alone cannot settle it: a Phase 0E.3 completion *without* a receipt
  legitimately keeps its body in `COMPLETED`.

## Error model

`ReceiptPublicationNotFoundError`, `ReceiptConflictError`,
`RegistrarIdentityMismatchError`, `ReceiptNodeMismatchError`,
`ReceiptCapsuleMismatchError`, `RegisteredHashMismatchError`,
`InvalidReceiptStateError`, `PersistedReceiptContractViolationError`,
`ReconciliationFailureError` — plus the existing `ValidationError`,
`PersistedOutboxContractViolationError`, and `DatabaseError`.

All reuse the hardened **non-enumerable internal cause** pattern. None expose
credentials, the capsule payload, a lock token, a **hash value**, or raw Prisma
text. Mismatches and conflicts report field **names** only.

Note the normal `recordRegistrarReceipt` path **returns** a structured `MISMATCH`
result rather than throwing the mismatch errors — the evidence is durably
recorded instead of lost. The mismatch error types exist for callers that want a
strict comparison.

## Deferred

- **Live Registrar and Publisher integration** — submission, polling, callbacks,
  credentials, endpoints.
- **Remediation** arrived in Phase 0E.5.2 — an explicit, auditable `RETRY`/`CLOSE`
  decision for mismatched and rejected publications. See
  [`PRODUCT_PUBLICATION_REMEDIATION.md`](PRODUCT_PUBLICATION_REMEDIATION.md).
  **Reopening a CLOSED publication remains deferred.**
- Resolver integration; worker loop; scheduled retries; lease expiry and lock
  stealing; accreditation verification; supersession and revocation workflows;
  production DB wiring; authentication; Stripe; UI; Storefront, Listing, Offer,
  and Review.

## Validation & commands

`db:check` verifies the receipt table, the new publication state columns, the
nullable payload column, receipt uniqueness and foreign keys, a prepared
publication starting `NOT_SUBMITTED`/`NOT_REQUIRED`, a matching accepted receipt
driving `ACCEPTED`/`MATCHED`/`COMPLETED`, payload clearing with all hashes and
source pointers retained, and deterministic capsule regeneration after disposal —
then cleans up receipts first in FK-safe order with no destructive reset.
