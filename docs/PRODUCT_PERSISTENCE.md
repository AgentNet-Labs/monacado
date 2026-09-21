# Product Source-Record Persistence (Phase 0D)

The first real database persistence layer for authoritative Product source
records. The database stores the enduring Product identity and its **immutable
source-record version history**. Capsule candidates are **not** stored — they are
deterministic derivations regenerated from a persisted version via the Phase 0C
mapper. Follows [`PRODUCT_SOURCE_RECORD_MAPPING.md`](PRODUCT_SOURCE_RECORD_MAPPING.md)
and the ADR.

Scope: local, database-free of any production system. No production/staging Aiven,
no Vercel wiring, no Node/publication/Registrar/resolver models.

## Authoritative database role

The Monacado database is the **system of record** for Monacado-native Product
facts (ADR §1). It does **not** persist duplicate capsule JSON as the
authoritative record; the published capsule is a downstream, regenerable artifact.

## Tables

### `Product` — stable identity (one row per enduring product)

| Column | Purpose |
| --- | --- |
| `internalProductId` (PK) | Opaque `mon:product:<opaque>`; immutable. |
| `sourceRecordId` (unique) | Opaque `mon:srec:<opaque>`; constant across versions; distinct from `internalProductId`. |
| `productRef` (unique) | **Application routing identity** (Phase 1.34) — see below. |
| `currentSourceRecordVersion` | Pointer to the current immutable version. |
| `recordStatus` | Internal Monacado authoring status (not ANS lifecycle). |
| `productRowCreatedAt` | DB row creation (operational; not a domain field). |

#### `productRef` — the stable application-facing Product reference (Phase 1.34)

The selector a route, a form action, or a page link names a Product by. It exists
because every identifier beside it is something else: `mon:product:` and
`mon:srec:` are internal identities, `an:node:` is an AgentNet Node, and the
primary key is a primary key. Using any of them in a URL would publish an
internal identity in order to get a link.

- **Opaque, and carrying no business semantics.** Not the name, not a sequence,
  not the source-record version, and not derivable from anything a caller knows.
- **Server-generated, with no client-settable path.** Minted by
  `ProductRepository.createInitialProductSourceRecord` inside the creating
  transaction. There is no input member for it anywhere, which is the control —
  not a rule that discards a supplied one.
- **Cryptographically random.** 32 characters drawn one CSPRNG byte each from the
  Crockford alphabet: 160 bits, non-enumerable. A populated-database backfill
  writes `HEX(RANDOM_BYTES(16))` — 32 characters of 128 bits over `[0-9A-F]`, a
  strict subset of the same alphabet — so both paths clear 128 bits and produce
  the same shape.
- **Immutable and stable for the life of the Product**, and independent of its
  source-record version: revising a Product advances the version pointer and the
  record status and touches nothing else on the row. A link handed out against
  version 1 still names the same Product at version 12.
- **Un-namespaced, and that is the guarantee.** Every other identifier carries a
  `mon:` or `an:` prefix, so a bare 32-character body **cannot** be read or used
  as an internal Product id, a source-record id, a creator reference, an ANS Node
  ID, a capsule ID, or a ProductNode identity.

It is **application routing identity, not semantic or public AgentNet identity**.
It is not a capsule fact, takes part in no source version, appears in no
projection, and is never published. It may travel to the UI and the API — it is
the only Product identifier that may — and it need not be shown to a person.

### `ProductSourceRecordVersionRow` — immutable version history

One row per authoritative source-record version. **Never updated in place.** A
surrogate autoincrement `seq` provides deterministic creation ordering and the
primary key. Persists every field required to reconstruct the Phase 0C
`ProductSourceRecord`: identity, source-system identity, creator authority
(flattened), Product facts, mapping controls, source timestamps, and internal
record status.

## Uniqueness & integrity constraints

- `Product.internalProductId` — primary key (unique).
- `Product.sourceRecordId` — unique.
- `Product.productRef` — unique (Phase 1.34); NOT NULL.
- `ProductSourceRecordVersionRow (sourceRecordId, sourceRecordVersion)` — unique
  (prevents duplicate versions; hard-guards concurrent revisions).
- FK `ProductSourceRecordVersionRow.internalProductId → Product.internalProductId`
  (`ON DELETE RESTRICT`).
- One current version per Product via the single `currentSourceRecordVersion`
  pointer.
- `sourceRecordId ≠ internalProductId` enforced by the domain schema before write.
- ANS Node IDs / capsule IDs are never accepted as source-record identifiers
  (Phase 0C opaque `mon:srec:` / `mon:product:` schemes only).

## Current-version pointer & transaction boundary

Creating the initial product and creating a revision are each **one transaction**:

- **Initial:** insert `Product` (pointer = `"1"`) + first version row together.
- **Revision:** load product + current version → optimistic-concurrency check →
  Phase 0C revision validation → insert the new immutable version → conditionally
  advance the pointer. On any failure the transaction rolls back: no partial
  version row remains and the pointer is unchanged.

## Concurrency strategy

A narrow **optimistic-concurrency** guard: the caller supplies
`expectedCurrentSourceRecordVersion`. If the stored current version differs, the
repository returns a `ConcurrencyConflictError` (no distributed locks). Two truly
simultaneous revisions with the same expected version are additionally serialized
by the `(sourceRecordId, sourceRecordVersion)` unique constraint — exactly one
succeeds; the loser rolls back.

## Authority persistence

The narrow Phase 0C creator authority is flattened into columns
(`authorityCreatorId`, `authorityScope`, `authorityAuthorizationState`,
`authorityAuthorizationRef?`). `creatorId` is treated as an **opaque governed
reference** this phase. **Deferred:** a foreign-key relationship from
`authorityCreatorId` to a future participant/account model (not created yet).

## Product-fact persistence choices

Bounded query-relevant scalars are normalized columns (`factName`,
`factProductVersion`, `factPromotable`, `factGeneralAvailabilityState`, …).
Structured collections use **validated JSON** columns:

- `factSpecifications` — `Record<string, string|number|boolean>`;
- `factCapabilities` — `string[]`.

JSON is appropriate because both are variable-shape collections validated by the
narrow Phase 0C `ProductData` Zod contract **before write and after read** — child
tables would add join complexity without a query need. The JSON shape stays narrow
and typed; there are no arbitrary metadata bags. The **Product-vs-Offer boundary**
is enforced before persistence: price, currency, discount, commission, payout,
payment, offer validity, and territory-specific commercial terms are rejected
(strict schema + forbidden-field scan).

## Mapping controls

Persisted and preserved exactly, never derived from the runtime clock:

- `capsuleSemver` — persisted capsule-mapping control (not a Product fact, not
  publication metadata);
- `mappingVersion` — identifies the deterministic transformation contract;
- `capsuleGeneratedAt` — the governed candidate-generation event time
  (`provenance.generatedAt` maps from it; never from `updatedAt`/`createdAt`/
  `acquiredAt`/the clock).

Timestamps use `DATETIME(3)` and round-trip exactly for the ms-precision UTC
values the domain uses.

## Persisted vs. derived; excluded publication fields

**Derived (never stored):** capsule `@context`/`@type`/`metadata`/`data`, provenance
structure, candidate hash. **Excluded from these tables:** `bindsToNode`,
`capsuleId`, `publishedBy`, `publishedAt`, Node/Capsule Policy references,
published capsule hash, Registrar registration id, publication receipt,
publication status, resolver state, and the published capsule JSON body.

Those belong to the Node and publication models, not to the source record.
`bindsToNode` lives on `ProductNode` (Phase 0E.1). `capsuleId`, `publishedBy`,
`publishedAt`, policy references, the candidate hash, and the published-capsule
hash live on `ProductPublication`, and the published capsule JSON body lives
**only** in the `PublicationOutbox` payload (Phase 0E.2 —
[`PRODUCT_PUBLICATION_PREPARATION.md`](PRODUCT_PUBLICATION_PREPARATION.md)).
Registrar registration ids, receipts, resolver state, and reconciliation remain
deferred.

## Prisma-to-domain mapping

`versionRowToDomain` reconstructs a **validated** `ProductSourceRecord`
(`ProductSourceRecordSchema`); malformed persisted data raises a structured
`PersistedContractViolationError`. `domainToVersionCreateInput` builds the Prisma
create input from a validated record. Prisma rows are persistence details, never
the public domain contract; no Product-to-capsule logic is duplicated — callers
use the Phase 0C mapper after reconstruction.

## Deterministic candidate regeneration & historical reconstruction

`generateCandidateFromPersistedProductVersion` reconstructs a persisted version
and runs the Phase 0C mapper; the candidate hash matches the in-memory candidate
byte-for-byte. Historical versions regenerate their **original** candidates
(prior versions are immutable), enabling reconstruction of any past capsule from
retained source data — no duplicate capsule-body persistence is needed.

## Repository interface

`ProductRepository`: `createInitialProductSourceRecord`,
`getCurrentProductSourceRecord`, `getProductSourceRecordVersion`,
`listProductSourceRecordVersions`, `createProductSourceRecordRevision`,
`generateCandidateFromPersistedProductVersion`,
`verifyPersistedProductVersionMapping`. Structured error codes:
`VALIDATION_FAILED`, `NOT_FOUND`, `DUPLICATE_PRODUCT`, `DUPLICATE_VERSION`,
`IMMUTABLE_IDENTITY`, `CONCURRENCY_CONFLICT`, `PERSISTED_CONTRACT_VIOLATION`,
`DATABASE_ERROR`. Errors never expose `DATABASE_URL`, credentials, or raw
connection details.

## Local disposable database setup

Prisma MySQL provider; connection via `DATABASE_URL` in a git-ignored `.env`
(see `.env.example`). Use a **local disposable MySQL only** — never production,
staging, or a shared database.

```
# Example: a fresh, empty local instance (loopback, no password)
DATABASE_URL="mysql://root@127.0.0.1:3306/monacado_dev"
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run db:generate` | Generate the Prisma client (also runs on `postinstall`). |
| `npm run db:migrate` | Apply committed migrations (`prisma migrate deploy`). |
| `npm run db:check` | Connectivity, migration state, tables/indexes, safe synthetic read/write, reconstruction, deterministic candidate. |
| `npm run db:test` | Run DB-backed integration tests (`RUN_DB_TESTS=1`) against the configured disposable DB. |

Integration tests self-skip unless `RUN_DB_TESTS=1`, so `npm run test` needs no
database. Do not make destructive reset part of normal validation.

## Migration ordering & rollback

`prisma/migrations/20260726_..._init_product_source_records` is the initial
additive migration (two tables, indexes, FK). Apply with `prisma migrate deploy`
in order. Rollback for this additive migration is dropping the two tables; no
production data exists to preserve. **Production migrations are not applied in
this phase.**

## Related: Product Node

The durable AgentNet **Product Node** (opaque Registrar-issued identity + ANS
lifecycle) is a separate model documented in
[`PRODUCT_NODE_PERSISTENCE.md`](PRODUCT_NODE_PERSISTENCE.md) (Phase 0E.1). ANS
lifecycle lives on the Node, never on these source-record tables.

## Future models & known deferrals

- Participant/account/organisation model + FK from `authorityCreatorId`.
- Publisher/Registrar services (live), resolver.
- Outbox claiming/retries, publication receipts, and reconciliation. (The
  publication record and the PENDING REGISTER outbox item — owning `capsuleId`,
  `publishedAt`, policy refs, and the capsule payload — arrived in Phase 0E.2.)
- Offer, Listing, Review, Storefront persistence.
- Production Aiven connection, staging/production migrations, Vercel wiring.
