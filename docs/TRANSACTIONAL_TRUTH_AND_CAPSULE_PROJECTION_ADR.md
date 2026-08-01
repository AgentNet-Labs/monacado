# Transactional Truth, Capsule Projection, and Source-Version Retention (Phase 0A.2)

Status: **binding** for all subsequent Monacado phases. Additive to
[`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) — it refines the
reading of §1 and §9 and replaces nothing.

> **Monacado conducts commerce through an authoritative transactional platform and
> publishes deterministic capsule representations of selected transactional
> truth.**

That sentence is the whole ruling. Everything below is its consequences.

## 1. Monacado is a bifurcated application

Two layers, with a one-way boundary between them.

| | **Transactional platform** | **Capsulization layer** |
| --- | --- | --- |
| Owns | business truth | public representations of selected truth |
| Authority | authoritative | none |
| Direction | writes the record | reads the record |
| Failure mode | a transaction is wrong | a *representation* is wrong |
| Fix | correct the record | regenerate, supersede, or revoke the capsule |

**The database is always the sole source of truth.** It owns accounts and
participants; roles and activation; Products, Offers, Storefronts, Listings,
Reviews, Orders, and financial records; authority and authorization records;
lifecycle state; immutable source versions; audit evidence; and publication
obligations and receipts. **All business changes occur through database-backed
transactional services.**

### What the capsulization layer may do

Exactly this, and nothing else:

1. read an identified **authoritative source version**;
2. validate projection eligibility;
3. select approved public claims;
4. apply a recorded **projection mapping** version;
5. generate a deterministic **capsule projection**;
6. canonicalize and hash it;
7. register, publish, supersede, or revoke it;
8. retain publication and reconciliation evidence.

### The permitted direction

```
authoritative database record
  → immutable authoritative source version
  → projection mapping
  → capsule projection shape
  → capsule projection
  → registration and publication
```

**The reverse direction is prohibited.** Capsules:

- never become authoritative records;
- never create provenance;
- never authorize business changes;
- never write data back into transactional records;
- never replace source-version, authority, audit, or publication-receipt
  evidence.

This is enforced executably in
[`src/contracts/architecture/transactional-truth.ts`](../src/contracts/architecture/transactional-truth.ts):
`evaluateProjectionDirection` refuses any flow whose destination is an
authoritative record and whose origin is a projection, and
`canWriteAuthoritativeRecord` refuses a capsule projection and a Registrar copy
**by name**. A prohibited direction that is merely undefined is one somebody
eventually implements.

## 2. Provenance originates outside the capsule

Provenance originates in authoritative source records, immutable source versions,
authority and authorization records, audit records, projection mapping versions,
generation records, publication receipts, and reconciliation results.

**A capsule may represent selected provenance claims. It does not create or
establish provenance.** Representing is not establishing — a published assertion
that its own provenance is true is worth exactly nothing, which is why the
evidence lives in records the capsule is derived from.

A third role sits between the two layers and must not be collapsed into either:
**evidence**. A Registrar receipt is authoritative about *what the Registrar
answered* and authoritative about nothing else. Treating it as business truth is
the specific mistake `REGISTRAR_COPY_IS_NOT_AUTHORITATIVE` exists to name.

## 3. Approved terminology

| Term | Means |
| --- | --- |
| **Authoritative Source Model** | the live relational record that owns a business fact |
| **Authoritative Source Version** | one immutable historical snapshot of that record |
| **Projection Mapping** | the versioned rules that turn a source version into a projection |
| **Capsule Projection Shape** | the schema a projection must satisfy |
| **Capsule Projection** | one generated, canonicalized, hashed capsule |
| **Publication Lifecycle** | preparation, registration, reconciliation, supersession, revocation |

Rules:

- **Avoid unqualified "Capsule Foundation" in phase titles.** It reads as though
  the capsule were the foundation of the application; the database is.
- "Capsule shape" is acceptable shorthand; formal documentation uses **Capsule
  Projection Shape**.
- **Stable code is not renamed for style.** Only terminology that creates a
  genuine source-of-truth ambiguity is corrected — a broad identifier rename
  would churn every committed phase to fix a wording problem.

### Relationship to ADR §1

ADR §1's own wording has been **corrected in place**, not merely reinterpreted
here. It now reads:

> The versioned capsule is the canonical semantic representation of the exact
> public artifact generated and published from an identified authoritative
> database source version. **It is never the canonical source of transactional
> truth, authority, provenance, or lifecycle state.**

That correction was made because relying on a later section to explain away
earlier contradictory wording leaves the contradiction in the text, where the next
reader finds it first and the correction second. The same narrow correction was
made in `CLAUDE.md`, which is loaded into every session.

The capsule remains canonical for what Monacado published and how that published
meaning is expressed — it is the artifact ANS consumers resolve, and no second
semantic payload may be invented for publication (§5).

## 4. Publication implications

The completed publication pipeline must always publish from either:

- **the exact source-version ID attached to the publication obligation**, or
- **the exact prepared canonical projection attached to that obligation**.

**It must never regenerate an old publication obligation from the entity's current
record.** An obligation records what was true when it was created; republishing
today's facts under yesterday's obligation rewrites history in the one place that
is supposed to be immutable. `evaluatePublicationReplaySource` refuses that
substitution outright — including when a caller regenerates from the current
record *and* attaches the correct version id, because those describe two
different things.

Also binding:

- **Commerce may complete while AgentNet publication is delayed.** Publication
  obligations are asynchronous and durable, and a buyer's order does not wait on
  a Registrar.
- **Publication failure does not reverse transactional truth.** A sale that
  happened, happened, whatever the Registrar says.
- **Disagreement is resolved from authoritative data** — by regenerating,
  superseding, or revoking the capsule. Never by editing the record to match what
  was published.
- **Capsule content never repairs the database.**

## 5. Retention

Retention is **three separate things**, independent of business state and of
publication state, specified in
[`SOURCE_VERSION_RETENTION_AND_ARCHIVAL_POLICY.md`](SOURCE_VERSION_RETENTION_AND_ARCHIVAL_POLICY.md):

- a **storage lifecycle** — `HOT → ARCHIVE_PENDING → ARCHIVED → PURGED`, where
  `PURGED` is terminal and archival stays reversible until then;
- **legal hold** — `NONE | ACTIVE`, orthogonal to storage: it applies at any
  location, changes no storage state when placed or released, blocks destruction,
  and revokes or republishes nothing;
- **purge eligibility** — a **computed decision, never a stored state**, because a
  persisted verdict outlives the dispute or hold that arrived after it was written.

The one rule that belongs here: **a hash is never sufficient to rebuild a source
version.** Hashes and receipts verify; only a full authoritative source snapshot
plus its mapping version reconstructs. Capsule-body disposal is safe **only**
while the authoritative source data remains durable and reconstructable under
policy.

## 6. Audit of completed phases

Every completed Product, publication, worker, identity, and marketplace artifact
was reviewed against the rulings above.

**No contradictory code was found.** The three classifications used:

- **Aligned** — behaviour already follows the bifurcated architecture.
- **Ambiguous** — wording could imply the capsule is a source; implementation is
  correct.
- **Contradictory** — code or documentation actually permits a prohibited
  direction.

| Path | Class | Issue | Action |
| --- | --- | --- | --- |
| `prisma/schema.prisma` → `ProductPublication` | Aligned | Bound to an exact source version by composite FK with `onDelete: Restrict`; unique on `(nodeId, sourceRecordId, sourceRecordVersion)`. The referenced source version cannot be removed beneath a publication. | none |
| `prisma/schema.prisma` → `ProductSourceRecordVersionRow` | Aligned | The immutable snapshot carries the complete Product facts **and** `mappingVersion` / `capsuleSemver`, so deterministic reconstruction is possible from the record alone. | none |
| `src/contracts/product/product-publication.ts` | Aligned | Preparation "accepts no capsule content (the capsule is regenerated from the persisted source-record version)" and requires `capsuleSemver` to equal the persisted version's. | none |
| `src/server/product/registrar-receipt-service.ts` | Aligned | A receipt writes only `registrationState`, `reconciliationState`, `remediationState`, and outbox work state. `publicationStatus` is deliberately untouched; no Product fact and no source version is written from a Registrar response. | none |
| `src/server/product/publication-remediation-service.ts` | Aligned | Records a governed human decision and advances publication/outbox work state; asserts no business fact. | none |
| `src/server/product/product-repository.ts` | Aligned | The only writer of `Product` and source-version rows. A capsule is never an input to either. | none |
| `PublicationOutbox.payload` disposal (0E.4) | Aligned | The transient capsule body is disposed after a matching ACCEPTED receipt, retaining `payloadHash`. Safe **because** the authoritative source version is retained under RESTRICT — the projection is regenerable, so disposing it destroys no truth. Rationale now stated in the retention policy. | rationale documented |
| `src/contracts/marketplace/*` (0M.1) | Aligned | Pure authorization contracts over relational views; no capsule participates in any decision. | none |
| Identity foundation (0E.7.4.2A) | Aligned | Explicitly "relational-first, never a capsule"; nothing published, no capsule references those rows. | none |
| 0E.7 worker track | Aligned | Already carries the property "**evidence is never authority**" — worker-run rows record that a command ran, never what happened to the work. | none |
| `docs/CDD_ARCHITECTURE_DECISIONS.md` §1 | Ambiguous → **resolved** | "The versioned capsule is the canonical semantic representation" read as capsule-as-source-of-truth when quoted alone. | **§1 wording corrected in place**, plus the §1 reconciliation note and §9.3; additive §12 added |
| `CLAUDE.md` core architecture principles | Ambiguous → **resolved** | Same phrasing, in the file loaded into every session. | **corrected in place**, and a database-first rule added ahead of it |
| `docs/README.md` CDD row | Ambiguous → **resolved** | Described the CDD methodology accurately, but without noting Monacado's own ruling. | narrow qualifier added in place |
| `docs/PRODUCT_CAPSULE.md` retention note | Ambiguous → **resolved** | Listed "source records, hashes, identifiers, receipts" in one breath, which could be read as hashes sufficing to rebuild. | narrow correction added, distinguishing reconstruction from verification |

**All four ambiguities are corrected in place.** None is left to be explained away
by a later section: a reader arriving at the original text now finds the corrected
wording, not the contradiction plus a cross-reference.

**No committed runtime behaviour was changed by this phase**, and none needed to
be.

## 7. Scope

This phase adds architecture decisions, executable invariants, documentation
corrections, and the audit above. It implements **no** archival worker, archive
storage, purge job, legal-hold persistence, Prisma model, migration, Offer source
model, Offer capsule shape, Storefront or Listing work, route, UI, Stripe
integration, checkout, Order, commission, payout, or production deployment.

## Reference

- [`SOURCE_VERSION_RETENTION_AND_ARCHIVAL_POLICY.md`](SOURCE_VERSION_RETENTION_AND_ARCHIVAL_POLICY.md)
- [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) §12
- [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md)
- [`PRODUCT_CAPSULE.md`](PRODUCT_CAPSULE.md), [`PRODUCT_PERSISTENCE.md`](PRODUCT_PERSISTENCE.md)
