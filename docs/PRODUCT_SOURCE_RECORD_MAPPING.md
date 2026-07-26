# Product Source-Record Persistence Mapping (Phase 0C)

Defines the normalized **Product source record** that a future Monacado database
will persist, and the deterministic mapping between:

```
authoritative Product source record
  → Product capsule candidate
  → validated source-record reconstruction (projection)
```

This is a **contract-only, database-free** phase (Phase 0C). No Prisma, SQL,
MySQL, Aiven, migrations, repositories, adapters, transactions, network calls,
publication workers, or Registrar integration. Source lives in
`src/contracts/product/product-source-record.ts`.

> The **database persistence layer** built on this contract (Phase 0D) is
> documented in [`PRODUCT_PERSISTENCE.md`](PRODUCT_PERSISTENCE.md): the stable
> Product identity, immutable source-record version history, Prisma schema,
> repository, and deterministic candidate regeneration from persisted versions.

## Product source record is authoritative; the candidate is derived

The **source record** is the authoritative Monacado application record for
Monacado-native Product facts. The **capsule candidate** is a derived semantic
representation of **one identified source-record version**. The **published ANS
capsule** is finalised later (Registrar-issued Node ID, capsule ID, Publisher,
publishedAt, policy references, supersession/revocation) and is **not** the
database source record.

## Source-record shape (`ProductSourceRecordSchema`)

Strict Zod-authored schema; TypeScript type inferred. Unknown fields rejected at
every level (no passthrough / catch-all / untyped bags).

| Group | Fields |
| --- | --- |
| Identity | `sourceRecordId` (`mon:srec:<opaque>`), `sourceRecordVersion` (explicit, immutable), `internalProductId` (`mon:product:<opaque>`, distinct) |
| System | `sourceSystem` = `monacado`, `sourceRecordType` = `Product`, `sourceClass` = `governed-database-record` |
| Authority (internal) | `authority` = `{ creatorId (mon:creator:<opaque>), authorityScope, authorizationState, authorizationRef? }` |
| Product facts | `facts` = the `ProductData` shape (name, description?, image?, productVersion, promotable, generalAvailabilityState, specifications?, capabilities?, relationships.creator/offer?) |
| Control | `capsuleSemver`, `mappingVersion`, `recordStatus`, `createdAt`, `updatedAt`, `acquiredAt`, `capsuleGeneratedAt` |

### Timestamp semantics (four distinct events, never conflated)

| Field | Meaning |
| --- | --- |
| `createdAt` | Creation of the authoritative Product source record. |
| `updatedAt` | Latest governed modification to that source record. |
| `acquiredAt` | Time the source information represented by the capsule was acquired. |
| `capsuleGeneratedAt` | Time the governed workflow generated this capsule candidate from the identified source-record version. |

Only `capsuleGeneratedAt` maps to `provenance.generatedAt` (a capsule-generation
event). It is **not** derived from `updatedAt`, `createdAt`, `acquiredAt`, or any
runtime clock. `createdAt` and `updatedAt` are internal audit timestamps that do
not appear in the candidate.

### `capsuleSemver` classification

`capsuleSemver` is a **persisted capsule-mapping control** — **not** an
authoritative Product fact and **not** publication metadata. It exists to make
candidate generation deterministic (it supplies `metadata.version`). It is
retained in this phase and is **subject to reassessment** when publication and
Registrar persistence are designed.

Opaque identifiers reject ANS Node IDs (`an:node:`), capsule IDs (`an:capsule:`),
and semantic URLs by construction. `sourceRecordId` must differ from
`internalProductId`. Neither is an ANS identity.

### Internal record status is not ANS lifecycle

`recordStatus` (`draft` | `authoring-complete` | `withdrawn`) is an **internal
Monacado authoring state**. It is deliberately not named `lifecycle`,
`lifecycleState`, `nodeState`, or `capsuleState`, and is **never** copied into
the candidate or published capsule. ANS Node lifecycle remains Registrar-managed
and external to the capsule.

### Authority is internal, never a published field

The internal `authority` block establishes who may author the Product facts. It
is **not** published and there is **no** `sourceAuthority` capsule field. ANS
factual authority is expressed via the Publisher (finalisation) and the creator
relationship; internal authorisation checks are kept conceptually separate. The
full account/organisation/membership/permissions system is out of scope.

### Product-vs-Offer boundary preserved

`facts` uses `ProductData` (strict) plus a forbidden-field scan over the whole
record, so price, currency, discount, commission, payout, payment, offer
validity, territory-specific commercial terms, and checkout state are rejected
anywhere in the source record.

## Persisted vs. derived vs. later-stage fields

The future database persists the **source record**; it does **not** need to
persist duplicate capsule JSON as the authoritative Product record.

| Classification | Fields |
| --- | --- |
| **Authoritative persisted source** | `sourceRecordId`, `sourceRecordVersion`, `internalProductId`, `sourceSystem`, `sourceRecordType`, `sourceClass`, `authority`, `facts`, `capsuleSemver`, `mappingVersion`, `recordStatus`, `createdAt`, `updatedAt`, `acquiredAt`, `capsuleGeneratedAt` |
| **Derived capsule-candidate** | `@context`, `@type`, `metadata.version` (← `capsuleSemver`), `metadata.provenance` (source/method/acquiredAt/assertionKind + source-record trace), candidate hash, `data` (← `facts`) |
| **Publication-time** | `publishedAt`, `publishedBy`, `nodePolicy`, `capsulePolicy` |
| **Registrar-issued** | `bindsToNode`, `capsuleId` |
| **Receipt / reconciliation** (future, not modeled here) | Registrar registration identifier, registered content hash, receipt, registration timestamp, status, supersession/revocation references |
| **Intentionally excluded from the candidate** | `internalProductId`, `authority`, `recordStatus`, `createdAt` (internal only) |

## Mapping functions

- **`productSourceRecordToCapsuleCandidate(record)`** — validates the record,
  then deterministically builds the candidate as a **pure function of the
  validated input** (no runtime clock is read). ANS provenance is constructed
  from source-record fields with `assertionKind = Asserted`. Field mapping:
  `provenance.acquiredAt ← acquiredAt`, `provenance.generatedAt ←
  capsuleGeneratedAt` (the capsule-generation event — never `updatedAt`/
  `createdAt`/`acquiredAt`/the system clock), `provenance.generatorVersion ←
  mappingVersion`, `metadata.version ← capsuleSemver`. No publication metadata,
  no undocumented defaults. Same valid record → identical candidate and hash.
- **`productCapsuleCandidateToSourceProjection(candidate)`** — reconstructs the
  source-derived projection for integrity comparison: identity, version, system,
  class, `capsuleSemver`, `mappingVersion`, `acquiredAt`, `capsuleGeneratedAt`
  (from `provenance.generatedAt`), and `facts`. Excluded fields
  (`internalProductId`, `authority`, `recordStatus`, `createdAt`, `updatedAt`)
  are internal and intentionally absent — listed in
  `PROJECTION_EXCLUDED_FIELDS`. No Product fact or source-provenance field is
  silently lost.
- **`verifyProductSourceCandidateMapping(record, candidate)`** — recomputes the
  expected candidate from the record and compares canonical content, candidate
  hash, and granular projection fields. Returns a typed success
  (`{ ok: true, candidateHash }`) or structured failure
  (`{ ok: false, reason, mismatches[] }`) with field-level diagnostics.

## Deterministic round-trip guarantees

1. A valid source record always generates a valid candidate.
2. The same record → byte-equivalent canonical candidate and the same hash.
3. Key insertion order does not affect candidate output or hash.
4. Reconstruction preserves every Product fact represented in the candidate.
5. Reconstruction preserves exact source-record provenance.
6. A meaningful Product change requires a new `sourceRecordVersion` (revision).
7. A `sourceRecordVersion` change changes provenance and the candidate hash.
8. A `mappingVersion` change changes provenance and the candidate hash.
9. Publication metadata is **not** required to reconstruct the source projection.
10. A published capsule can be regenerated later **only if** every
    publication-time field is retained (source record + mapping version +
    publication metadata / receipt). Exact published-capsule regeneration is not
    claimed without all publication-time fields.

## Revision rules

`reviseProductSourceRecord(...)` requires a **new** `sourceRecordVersion` and an
**explicitly supplied `capsuleGeneratedAt`** — the revision API **never silently
inherits, defaults, copies, or derives** it from the prior record. It preserves
`sourceRecordId` and `internalProductId` (rejecting any attempt to change them);
permits governed Product fact changes; updates `updatedAt`; re-validates
(rejecting Offer/payment fields); and yields a new candidate and hash. No
optimistic locking, transactions, or concurrency in this phase.

### `capsuleGeneratedAt` is an event timestamp, not a generation identity

- `capsuleGeneratedAt` **must be supplied explicitly during revision**; omission
  is rejected at the type boundary and at a runtime guard.
- The revision API **never silently inherits** it — the returned record always
  takes the caller-supplied value, never the prior record's.
- **Timestamp equality is not treated as generation identity.** An explicitly
  supplied value equal to the prior one is **permitted**: two generation events
  can occur within the same timestamp precision, and imported or deterministic
  workflows may legitimately preserve equal timestamps. There is **no**
  requirement that each revision carry a different or newer `capsuleGeneratedAt`;
  no monotonic-time requirement is imposed.
- If a future contract genuinely needs a **distinct generation identity**, it
  must use a **separate identifier or governed publication construct** rather
  than overloading `capsuleGeneratedAt`. (No such identifier exists in Phase 0C,
  and none is required by any current Phase 0C requirement — see the design
  observation in the final report.)

## Tamper / contradiction detection

Rejected or reported: mismatched `sourceRecordId` / `sourceRecordVersion` /
source system / record type / internal Product identity; changed Product facts
or creator relationship; changed mapping/generator version; candidate hash
mismatch; malformed provenance; publication metadata appearing in a candidate
(candidate metadata is strict `{ version, provenance }`); ANS Node/capsule IDs or
semantic URLs used as source identifiers; and private/payment/Offer fields in
source records or projections.

## Reconstruction after capsule-body disposal

Because the capsule candidate (and the derived `data`/provenance) is a pure,
deterministic function of the retained source record, **Monacado need not
permanently retain a duplicate published capsule body** after confirmed Registrar
registration. It is sufficient to retain: the source record (and its versions),
the mapping version, the publication metadata / receipt, identifiers, and the
registered content hash — from which the candidate is regenerated and, with the
retained publication-time fields, the published capsule can be reconstructed and
integrity-checked against the registered hash.

## Future database & publication-receipt responsibilities (deferred)

Persistence mapping (Prisma/SQL), optimistic locking, transactions, a publication
outbox, and a production **publication receipt** model are deferred. The receipt
fields above are documented, not implemented, to make the separation clear.
