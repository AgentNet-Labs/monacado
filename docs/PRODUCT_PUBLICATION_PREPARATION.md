# Product Publication Preparation & Atomic Outbox (Phase 0E.2)

The durable **Product publication record** and the **atomic outbox boundary** that
prepare a validated Product capsule for future AgentNet registration.

This phase is **fully offline**. Nothing here calls a Publisher, Registrar, or
Resolver, and nothing claims, retries, completes, or reconciles work. It follows
the ADR (§5, §11.7, §11.8, §11.9) and builds on
[`PRODUCT_PERSISTENCE.md`](PRODUCT_PERSISTENCE.md) and
[`PRODUCT_NODE_PERSISTENCE.md`](PRODUCT_NODE_PERSISTENCE.md).

## Purpose of the publication record

`ProductPublication` is the immutable statement that **one exact Product
source-record version** was prepared for registration as **one identified
capsule**, bound to **one Product Node**, under **one pair of policy
references**, by **one Publisher**, at **one publication time**.

It is a record of *identity, lineage, and integrity* — deliberately not a copy of
the Product:

| The publication record holds | The publication record does NOT hold |
| --- | --- |
| `publicationId`, `capsuleId`, `capsuleSemver` | any Product fact (name, description, image, specifications, capabilities, availability, promotable, relationships) |
| `internalProductId`, `sourceRecordId`, `sourceRecordVersion`, `nodeId` | the capsule JSON body |
| `publishedBy`, `publishedAt`, policy refs + versions | Node lifecycle state (ADR §11.9 — lifecycle lives on `ProductNode`) |
| `candidateHash`, `publishedContentHash` | receipts, retries, claims, reconciliation, or Resolver state |
| `mappingVersion`, `capsuleGeneratedAt` (mapping controls, not facts) | credentials or connection details |

Product facts are **not duplicated** because the immutable source-record version
already holds them and the publication references that exact version by foreign
key. `db:check` and the test suite both assert their absence structurally.

## Exact source-version lineage

The publication carries a **composite foreign key** to
`ProductSourceRecordVersionRow(sourceRecordId, sourceRecordVersion)` — the exact
immutable version, never "the current version". Preparation loads that version
and regenerates the capsule from it, so publishing v1 after the Product has moved
on to v2 yields v1's capsule, not v2's.

All publication foreign keys use **`ON DELETE RESTRICT`**: publication history can
never be cascade-deleted, and the referenced source version, Node, or Product
cannot be removed out from under it.

## Product Node relationship

The publication references the Product Node by `nodeId` (FK to
`ProductNode.nodeId`), and the capsule's `metadata.bindsToNode` is that same Node.
Preparation requires the Node to belong to the same Product **and** to be in
lifecycle state **`Active`** — `Inactive`, `Retired`, and `Revoked` Nodes are
rejected as not eligible. Node lifecycle itself is never copied onto the
publication.

## Preparation flow

`prepareProductPublication` (in `ProductPublicationService`) performs exactly:

1. Validate the input contract (strict Zod; supersedes/revokes mutually exclusive).
2. Load the Product by `internalProductId`.
3. Load the **exact** persisted source-record version.
4. Confirm that version belongs to that Product.
5. Load the Product Node; confirm it belongs to that Product; require `Active`.
6. Confirm `capsuleSemver` matches the source record's `capsuleSemver` mapping
   control (a stale or mismatched intent is rejected, never silently overridden).
7. Regenerate the capsule **candidate** through the existing Phase 0C mapper.
8. Finalise the **published capsule** through the existing Phase 0B.1 finaliser.
9. Validate the final published capsule.
10. Compute and verify `candidateHash`, `publishedContentHash`, and the outbox
    `payloadHash`.
11. Resolve idempotency (see below).
12. **In one transaction:** create the publication (`PREPARED`) → create the one
    `REGISTER` outbox item (`PENDING`) → advance the publication to `QUEUED`.
13. Return validated domain objects.

No capsule-generation or hashing logic is re-implemented: the mapper, the
finaliser, and the shared canonical-hash primitive are reused.

## Atomic publication/outbox transaction

The publication row and its outbox item are created in a **single database
transaction**. There is no window in which a publication exists without its work
item, or vice versa:

- a failure **before** the publication insert leaves neither row;
- a failure **after** the publication insert but **before** the outbox insert
  rolls back both;
- a duplicate or conflicting identity cannot leave partial data — uniqueness is
  enforced by the database, not only by the service.

Both properties are proven by DB-backed tests, one of which forces a unique-key
failure at the outbox insert (after the publication insert) and asserts that
neither row survives.

## Publication status

One bounded enum for this phase:

| Status | Meaning |
| --- | --- |
| `PREPARED` | The publication row exists; its outbox item is not yet enqueued. Because preparation is atomic, this is the **in-transaction** initial state and is not observable as a committed state in this phase. Retained for future flows that separate preparation from enqueue. |
| `QUEUED` | Publication prepared **and** its `REGISTER` outbox item enqueued. The committed terminal state of preparation in this phase. |
| `CANCELLED` | Preparation withdrawn before any submission. **Reserved** — no cancellation operation exists yet. |

Submission, registration, receipt, retry, reconciliation, and Resolver states are
deliberately **absent** and must not be added before their phase.

> **Later-phase notes.** Worker-facing claiming, retry, completion,
> dead-lettering, and cancellation of the outbox item are documented in
> [`PRODUCT_PUBLICATION_OUTBOX_PROCESSING.md`](PRODUCT_PUBLICATION_OUTBOX_PROCESSING.md)
> (Phase 0E.3). Registrar receipts, reconciliation, and disposal of the capsule
> payload are documented in
> [`PRODUCT_REGISTRAR_RECEIPTS.md`](PRODUCT_REGISTRAR_RECEIPTS.md) (Phase 0E.4);
> that phase added `registrationState` and `reconciliationState` to the
> publication and made the outbox payload nullable. **`publicationStatus` is
> unchanged and stays `QUEUED` throughout** — registration has its own field.

## REGISTER-only outbox scope

`PublicationOutbox` holds exactly **one `REGISTER` item per publication**
(enforced by a unique `publicationId`). Operation type is bounded to `REGISTER`;
outbox state is bounded to `PENDING` | `CANCELLED`; `attemptCount` begins at `0`.

The table deliberately has **no** claim, lock, lease, retry, error, dead-letter,
receipt, registration, completion, reconciliation, or Resolver columns. Their
absence is asserted by tests and by `db:check`.

## Idempotency

The **stable preparation identity** is:

```
nodeId + sourceRecordId + sourceRecordVersion + capsuleId + operationType
```

`idempotencyKey` is the `sha256:<hex>` canonical hash of exactly those five
fields, and `outboxId` is derived deterministically from that key — so a repeated
preparation names the same outbox item without inventing an identifier.

Enforcement is **both** database-level and service-level:

- **Database:** unique `idempotencyKey`, unique `outboxId`, unique
  `publicationId`, unique `capsuleId`, and unique
  `(nodeId, sourceRecordId, sourceRecordVersion)`.
- **Service:** when the key already exists, the stored publication is compared
  field-by-field against the submitted assertion.

Outcomes:

- an **identical** repeat returns the existing publication and outbox item with
  `alreadyPrepared: true` and creates **no** rows;
- a repeat with the same identity but a conflicting `capsuleSemver`,
  `publishedBy`, `publishedAt`, policy reference/version, `candidateHash`,
  `publishedContentHash`, `payloadHash`, or supersedes/revokes fails with a
  structured **`IdempotencyConflictError`** naming the conflicting fields (names
  only — never values);
- a *different* capsule identity for the same Node and source version is not the
  same identity at all: it fails as a **`PublicationConflictError`** on the
  `(nodeId, sourceRecordId, sourceRecordVersion)` uniqueness constraint.

`availableAt` is intentionally **excluded** from the conflict comparison: it is
scheduling metadata, not part of the publication assertion, so a differing value
does not make two preparations contradictory.

### Uniqueness constraints and why

| Constraint | Prevents |
| --- | --- |
| unique `publicationId` | two records claiming one publication identity |
| unique `capsuleId` | one capsule identity being published twice |
| unique `(nodeId, sourceRecordId, sourceRecordVersion)` | two conflicting capsule identities for the same source version on one Node |
| unique `idempotencyKey` | duplicate work for one preparation identity |
| unique `outboxId` | duplicate outbox items |
| unique `PublicationOutbox.publicationId` | more than one `REGISTER` item per publication |

The `(nodeId, sourceRecordId, sourceRecordVersion)` constraint is scoped to this
phase's **REGISTER-only** model. When non-REGISTER operations arrive, it must be
revisited — a future revoke/supersede operation against the same source version
would legitimately need its own row.

## Payload validation and hashing

The outbox `payload` is **exactly one validated final published Product capsule** —
a strict schema, never an arbitrary bag. It is validated against
`PublishedProductCapsule` on write **and again on every read**. Because the schema
is strict and the forbidden-field scan rejects foreign-authority, commercial, and
private fields, credentials and secrets cannot enter a payload.

Three distinct hashes, never conflated:

| Hash | Over | Stored on |
| --- | --- | --- |
| `candidateHash` | the regenerated pre-publication candidate | publication |
| `publishedContentHash` | the published capsule **excluding** `metadata.contentHash` | publication (and as the capsule's own `metadata.contentHash`) |
| `payloadHash` | the canonical outbox payload **exactly as stored**, including `contentHash` | outbox |

Every outbox read recomputes `payloadHash` and compares it to the stored value; a
mismatch is a structured contract violation, not a silent pass.

## Persisted versus transient capsule data

The **capsule body is persisted in exactly one place**: the outbox `payload`
column. The publication row has no JSON or TEXT column and therefore nowhere to
hold a capsule — asserted structurally by `db:check` and by tests.

The **candidate** is never persisted: it is a deterministic derivation
regenerated from the immutable source-record version whenever it is needed, and
only its hash is retained.

Payload disposal after registration is deferred to Phase 0E.4, where the body is
cleared only after a matching ACCEPTED Registrar receipt — see
[`PRODUCT_REGISTRAR_RECEIPTS.md`](PRODUCT_REGISTRAR_RECEIPTS.md). `payloadHash`
is retained so the disposed body stays verifiable.

## Prisma-to-domain mapping

`publication-mapper.ts` is the only place Prisma rows are touched. It provides
`publicationRowToDomain`, `outboxRowToDomain`, `domainToPublicationCreateInput`,
and `domainToOutboxCreateInput`. Raw Prisma rows never escape the adapter; every
read is reconstructed into a validated domain object, and malformed persisted
data raises `PersistedPublicationContractViolationError` or
`PersistedOutboxContractViolationError`.

## Error model

`PublicationProductNotFoundError`, `SourceRecordVersionNotFoundError`,
`ProductSourceMismatchError`, `ProductNodeMismatchError`, `NodeNotEligibleError`,
`InvalidPublicationInputError`, `DuplicateCapsuleIdError`,
`PublicationConflictError`, `IdempotencyConflictError`,
`PersistedPublicationContractViolationError`,
`PersistedOutboxContractViolationError`, `AtomicPreparationFailureError` (plus the
existing `DatabaseError` and `ProductNodeNotFoundError`).

All carry stable codes. None expose `DATABASE_URL`, credentials, host or database
names, raw Prisma connection details, or capsule payload contents — conflicts
report field **names** only.

## No live network activity

There is no HTTP client, no Publisher submission, no Registrar call, no Resolver
lookup, and no credential handling anywhere in this phase. `prepareProductPublication`
touches only the local disposable database.

## Deferred

Outbox claiming, worker locks/leases, retries, attempt processing, error
summaries, dead-letter handling; Registrar receipts; reconciliation; payload
disposal after registration; supersession and revocation services; live Publisher/
Registrar/Resolver calls; accreditation verification; production DB wiring;
authentication; Stripe; UI; Storefront, Listing, Offer, and Review.

## Validation & commands

`db:check` verifies both tables, the expected foreign keys (RESTRICT), unique
`publicationId` / `capsuleId` / `idempotencyKey`, absence of Product-fact and
capsule-body columns on the publication, one synthetic preparation, atomic
publication/outbox creation, published-capsule validation, `payloadHash`
correctness, and an idempotent repeat — then cleans up in FK-safe order with no
destructive reset. `db:test` runs the DB-backed suites serially against the
disposable database.
