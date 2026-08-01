# Source-Version Retention and Archival Policy (Phase 0A.2)

Status: **binding** policy. Subordinate to
[`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md).

Defines **where an authoritative source version is stored**, and what must be true
before it moves or is destroyed. It defines no worker, no storage backend, and no
job — those are deferred.

## 1. Three separate questions, three separate models

Retention is not one lifecycle. It is a storage lifecycle, an orthogonal flag, and
a computed decision, and conflating any two of them causes a specific failure:

| Question | Model | Kind |
| --- | --- | --- |
| Where is the payload, and does it still exist? | `RetentionStorageState` | lifecycle |
| Is destruction legally blocked? | `LegalHoldStatus` | orthogonal flag |
| May it be destroyed right now? | `evaluatePayloadPurgeEligibility` | **computed decision** |

These are additionally independent of the business lifecycle (`DRAFT`, `ACTIVE`,
`SUSPENDED`) and the publication lifecycle (`PREPARED`, `ACCEPTED`, `REVOKED`).
**Publication state does not determine storage-retention state.** A published
capsule does not pin its source version to hot storage, and archiving a source
version does not touch its capsule's publication state.

### 1.1 Storage lifecycle

```
HOT             → ARCHIVE_PENDING
ARCHIVE_PENDING → ARCHIVED, HOT        (HOT on failed archival)
ARCHIVED        → PURGED, HOT          (PURGED only after a passing decision)
PURGED          → (terminal)
```

- **`ARCHIVE_PENDING → HOT`** exists for failed archival: a copy that did not
  verify returns where it came from rather than being stranded mid-move.
- **`ARCHIVED → HOT`** keeps archival reversible right up until destruction —
  which is the whole reason archiving and purging are separate acts.
- **`PURGED` is terminal.** There is no path back, because there is nothing to
  come back to.
- **`ARCHIVED → PURGED` is structurally legal and never sufficient on its own.**
  `canTransitionToPurged` additionally requires a passing purge-eligibility
  decision.

The storage vocabulary shares **no member** with any business or publication
vocabulary — no `ACTIVE`, no `PUBLISHED`, no `DRAFT`.

### 1.2 Why `LEGAL_HOLD` and `PURGE_ELIGIBLE` are not storage states

Both were members of an earlier draft of this lifecycle. Both were wrong:

- **Legal hold is orthogonal.** A hold can apply to hot, pending, or archived
  data. Modelling it as a *location* forced a held payload to forget where it
  actually was, and made releasing a hold a storage move — so the release
  transition had to guess where to put it back.
- **Purge eligibility is a decision, not a place.** A persisted `PURGE_ELIGIBLE`
  is a stale answer waiting to be acted on after the facts behind it changed: a
  dispute opened, a hold arrived, a reconciliation reopened. That is precisely how
  data gets destroyed that should not have been.

## 1a. Legal hold

`NONE | ACTIVE`, carried alongside the storage state on every source version.

- A hold **may apply while `HOT`, `ARCHIVE_PENDING`, or `ARCHIVED`.** Only
  `PURGED` refuses it, and not as a judgement — there is nothing left to preserve.
- **Activating a hold does not change storage state.** `setLegalHold` returns the
  storage state untouched by construction.
- **Releasing a hold does not authorize purge.** It restores nothing but the
  absence of the hold; every other gate still applies, and a released hold on hot
  data leaves a payload that is still not purgeable.
- **A hold blocks payload destruction**, and also blocks archival — preserving
  evidence in place is the conservative reading, and an archival pass that
  relocated held data would have to answer for it later.
- **A hold does not revoke, supersede, or republish a capsule.** It is a
  storage-and-destruction constraint and touches no publication state.

## 2. What archival does and does not mean

- **Current records remain in operational tables.** Only immutable historical
  source versions may leave hot storage.
- **Archival does not alter the historical business fact.** The snapshot is the
  same snapshot in a different place.
- **Archival does not revoke or supersede a Node**, and does not change any
  capsule's publication state (ADR §11.9: Node lifecycle is the Registrar's, and
  capsules carry no lifecycle).
- **Archival is not deletion.** Moving a snapshot to verified archival storage is
  the default; destroying it is a separate, gated decision (§5).

## 3. Default policy

For published Product, Offer, Storefront, Listing, and Review source versions:

- **retain the complete authoritative source snapshot**;
- **move older snapshots to verified archival storage rather than destroying
  them**;
- **preserve deterministic reconstruction whenever reasonably required.**

The current implementation already satisfies this: a
`ProductSourceRecordVersionRow` carries the complete Product facts plus its
`mappingVersion` and `capsuleSemver`, and every `ProductPublication` references it
under `onDelete: Restrict` — the source version cannot be removed beneath a
publication that depends on it.

> **Why disposing of the outbox capsule body is consistent with this.** Phase
> 0E.4 disposes of the transient capsule payload after a matching ACCEPTED
> receipt, retaining `payloadHash`. That destroys a **projection**, not truth: the
> capsule is regenerable from the retained source version and mapping version, and
> the hash still proves the disposed body was what it claimed to be. The same act
> applied to the *source snapshot* would be prohibited — see §5.

## 4. Reconstruction versus verification

The distinction the rest of this policy rests on:

| Retained | Verify? | Reconstruct? |
| --- | --- | --- |
| Full source snapshot **+** mapping version | if a hash or receipt is also held | **yes** |
| Full source snapshot, no mapping version | if a hash is held | **no** — yields *some* capsule, not the published one |
| Content hash only | yes | **no** |
| Publication receipt only | yes | **no** |
| Nothing | no | no |

**A hash must never be described as sufficient to rebuild a source version.** It
is a one-way digest: it can confirm a candidate and refute one, and it cannot
produce one. `assessReconstructionCapability` returns both capabilities
separately so no caller can conflate them.

**Payload destruction requires an explicit data-class policy stating that
verification-only retention is acceptable** for that class. Silence is never
consent to destroy — `evaluatePayloadPurgeEligibility` denies with
`VERIFICATION_ONLY_RETENTION_NOT_AUTHORIZED` when no such policy is asserted. No
data class has been granted one yet.

## 5. Archive and purge gates

Pure bounded decisions in
[`src/contracts/architecture/transactional-truth.ts`](../src/contracts/architecture/transactional-truth.ts).
Both report **every** failing condition at once: an operator planning a pass needs
the whole list, not one reason per round trip.

### Archival may proceed only when

- the source version is **no longer current**;
- **no active transaction** requires hot access;
- the **archive destination is available**;
- required **publication preparation is durable**;
- the storage transition to `ARCHIVE_PENDING` is permitted from the current state;
- **no legal hold is active**.

### Payload purge must be denied when

| Condition | Reason code |
| --- | --- |
| a legal hold is active | `LEGAL_HOLD_IN_FORCE` |
| the storage state is not `ARCHIVED` | `RETENTION_STATE_NOT_ARCHIVED` |
| the source version is current | `SOURCE_VERSION_IS_CURRENT` |
| a dispute or refund window is open | `DISPUTE_OR_REFUND_WINDOW_OPEN` |
| financial, tax, or compliance retention applies | `FINANCIAL_RETENTION_APPLIES` |
| publication or reconciliation is incomplete | `PUBLICATION_RECONCILIATION_INCOMPLETE` |
| no verified archive copy exists | `NO_VERIFIED_ARCHIVE_COPY` |
| deterministic reconstruction is still required | `RECONSTRUCTION_STILL_REQUIRED` |
| no data-class policy permits verification-only retention | `VERIFICATION_ONLY_RETENTION_NOT_AUTHORIZED` |

**Only an archived payload is a candidate.** Hot data is destroyed from hot
storage by nobody, and a pending archival has not been verified yet — so the
`ARCHIVED` gate is what makes "there is a verified copy elsewhere" meaningful
rather than assumed.

### A capsule body is not an archive of the source

`ArchiveCopyKind` lists `CAPSULE_BODY` and `REGISTRAR_COPY` **so they can be
refused**. Both are projections: they carry only the claims someone approved for
publication, and none of the private facts, authority linkage, or mapping controls
the source version holds. Only a **verified `AUTHORITATIVE_SOURCE_SNAPSHOT`**
satisfies the archive gate.

**A capsule body or Registrar copy must never substitute for the authoritative
source snapshot.**

## 6. No clock, no ambient state

Every time-derived fact — whether a dispute window is open, whether a retention
period has elapsed — is **supplied as data** by the caller that holds it. The
decisions read no clock, no environment, no database, and no network, so a
retention decision is replayable, and a replayable decision is auditable.

## 7. Deferred

Named as deferred, not missing: the archival worker; archive storage selection and
verification; the purge job; legal-hold persistence (including who may place and
release a hold, and its audit trail); retention-period configuration per data
class; Prisma models and migrations for storage state and hold status; and any
right-to-erasure process, which will have to be reconciled against the `RESTRICT`
deletion rules and the retention gates above.

When storage state and hold status are eventually persisted, **purge eligibility
must not be.** It is computed at the moment of destruction, from facts as they are
then.

## Reference

- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
- [`PRODUCT_PERSISTENCE.md`](PRODUCT_PERSISTENCE.md), [`PRODUCT_CAPSULE.md`](PRODUCT_CAPSULE.md)
- [`PRODUCT_REGISTRAR_RECEIPTS.md`](PRODUCT_REGISTRAR_RECEIPTS.md)
