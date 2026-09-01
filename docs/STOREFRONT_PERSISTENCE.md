# Storefront Persistence and Governance (Phase 0M.3C)

The missing stage between the Phase 0M.3A source model and the Phase 0M.3B
capsule projection: an **authoritative source version that actually exists in the
database**.

Until this phase, the Storefront projection could only ever be handed a synthetic
fixture. The declared pipeline —

```
AUTHORITATIVE_SOURCE_MODEL → AUTHORITATIVE_SOURCE_VERSION → PROJECTION_MAPPING
  → CAPSULE_PROJECTION_SHAPE → CAPSULE_PROJECTION
```

— had its second stage missing for the Storefront. It no longer does.

**No Node issuance, no publication, no routes, no UI.**

## 1. Stable record versus immutable source versions

Three tables, following the Product precedent exactly:

| Table | Role | Mutability |
| --- | --- | --- |
| `Storefront` | stable identity + current-version pointer | pointer moves |
| `StorefrontSourceRecordVersionRow` | complete material snapshots | **immutable** |
| `StorefrontGovernanceAssignment` | who administers it | status changes |

`Storefront` carries `internalStorefrontId` (`mon:storefront:`),
`storefrontSourceRecordId` (`mon:srec:`), `currentSourceRecordVersion`, the owner,
and a denormalized copy of the current `publicHandle`, `lifecycle`, and
`visibility` for querying. That copy moves **in the same transaction** as the
pointer, so it can never disagree with the version it points at; the version row
remains authoritative.

Version rows are complete snapshots, not deltas — the same reasoning every other
source model records: a version that had to be replayed through its predecessors
would make reconstruction depend on an unbroken chain.

## 2. Database authority

The database is the sole source of truth (ADR §12). The capsule projection reads
from it one way and writes nothing back; there is no reverse mapper anywhere.

Every persisted column maps **one-to-one** onto a `StorefrontSourceVersion`
member. Persistence adds no Storefront fact and drops none.

## 3. Ownership and governance

**Two axes, never merged.**

- **Ownership** — `Storefront.ownerParticipantId`, a single
  `MarketplaceParticipant`. Ownership is not role-shaped, so no role basis
  accompanies it.
- **Governance** — `SUPER_OWNER` / `ADMIN` assignments held by *humans acting
  for* that owner. An assignment never makes the assignee a co-owner, and no
  governance operation touches `ownerParticipantId`.

> **Creating a Storefront confers no governance authority.** This surfaced during
> testing and is worth stating plainly: a freshly created Storefront has no
> assignment at all, and `canEditStorefrontPresentation` requires one. The owner
> must appoint the first `SUPER_OWNER` — which they may do for themselves, and
> which the service permits only while none exists. A test asserts both halves:
> the edit is refused with `GOVERNANCE_ASSIGNMENT_REQUIRED` before appointment
> and succeeds after.

Assignments are additive and unique per `(storefront, participant)`: appointing
an already-appointed participant updates that row rather than duplicating the
grant.

## 4. SUPER_OWNER and ADMIN

`SUPER_OWNER` holds the 0M.3A exclusivity list — activation, suspension, closure,
visibility withdrawal, ADMIN appointment and revocation, and financial
responsibility. `ADMIN` holds the operational list and **never acquires the
exclusive ones by virtue of being ADMIN**. `SUPER_OWNER` inherits every `ADMIN`
permission.

**At most one active `SUPER_OWNER` per Storefront is enforced by the database.**
`activeSuperOwnerForStorefrontId` mirrors the storefront id when a row is an
active `SUPER_OWNER` and is `NULL` otherwise, so a unique index refuses a second
one. MySQL has no partial indexes; this is the same technique
`RegistrarReceipt.acceptedForPublicationId` and
`ParticipantActivation.undecidedForParticipantId` use.

The database therefore guarantees the **"at most one"** half of 0M.3A's
exactly-one rule. The **"at least one"** half is a go-live *readiness* question,
answered through the supplied `activeSuperOwnerCardinality` the contract already
takes — a Storefront may legitimately exist with none while still in `DRAFT`.

**Revocation is a state change, not a delete.** "Never appointed" and "appointed
and removed" are different facts, and an audit trail that conflated them could not
answer who used to hold authority. Revoking clears the active marker, which frees
the seat for a successor.

`NONE` is a member of the 0M.3A status vocabulary but is deliberately **not
storable**: it means "no assignment exists", which is the absence of a row.

## 5. Source-version creation and the current pointer

`createStorefrontSourceVersion` runs, in order:

1. read the current version — the comparison basis;
2. assemble 0M.3A authority facts;
3. ask `materialChangesBetween` whether this is a change at all;
4. **route to the authority decision the change actually requires**, and honour
   it (see §10);
5. check any lifecycle move against the 0M.3A transition table;
6. check the acting owner's governed standing for operational changes (Phase
   1.15);
7. insert the new version and advance the pointer **in one transaction**.

Historical rows are never touched. A stable record can never point at a version
that does not exist — the write path makes it impossible, and the read path fails
loudly rather than returning half a Storefront if it ever did.

The first version is always `DRAFT` + `PRIVATE`, and neither is a caller choice:
0M.3A's lifecycle starts at `DRAFT`, and a Storefront publicly visible before
anyone reviewed it would defeat the go-live gate.

`sourceRecordVersion` is **supplied**, matching the Product and Offer convention —
a service that invented version labels would make two concurrent writers agree by
accident.

## 6. Material updates

Material change is 0M.3A's classification, not a second one:
`materialChangesBetween` decides. An update that changes nothing material is
**refused** with `NO_MATERIAL_CHANGE` rather than silently minting a version — a
version asserting no change is history noise, and returning success would let a
caller believe something landed.

## 7. Handle integrity

- **Shape** is the contract's: lowercase letters, digits, single interior
  hyphens, 3–63 characters. No normalization beyond that; a malformed handle is
  refused, never silently fixed.
- **Uniqueness** is enforced by a unique index on the **stable record only** —
  0M.3A states the shape but leaves uniqueness to persistence, and it is the
  *current* handles that must not collide.
- **History preserves what was authorized.** Version rows carry no unique
  constraint, so a past version keeps the handle it actually had even after the
  name is reassigned. A test asserts exactly this.

A handle change is material under 0M.3A, so it mints a new version.

## 8. Lifecycle and visibility

Both are persisted on the version row and mirrored onto the stable record.
Lifecycle moves are checked against `STOREFRONT_LIFECYCLE_TRANSITIONS`; an
illegal move is refused with the bounded reason code
`STOREFRONT_LIFECYCLE_TRANSITION_NOT_PERMITTED`.

They remain **separate axes**: whether a Storefront is running and whether it may
be seen are different questions, and visibility can never revive an inactive one.

## 9. The go-live approval boundary

**There is no approval column, and there must not be one.**

0M.3A makes Monacado's go-live determination a **supplied decision input**, never
a Storefront field. Storing the approver's decision inside the approved thing is
exactly the coupling that model avoids. `evaluateStorefrontReadiness` takes it as
a parameter and derives `live` through the source model's own `isStorefrontLive`;
there is no stored `isLive` either.

`approvedForGoLive`, `goLiveApproved`, `approvalState`, and `isLive` are all named
in `NEVER_ON_STOREFRONT_RECORD`, and a schema-scanning test asserts none appears.

Operational approval belongs to a later governance mechanism. This phase invents
no approval workflow.

## 10. Authorization

The 0M.3A authority decisions are **used, never restated**. The service assembles
`StorefrontOwnerFacts` and `StorefrontActorFacts` from persisted rows and honours
the decision that matches the act. A refusal carries that contract's own bounded
reason codes — typed to the closed vocabulary rather than `string[]`, after an
early draft invented two codes no contract defines.

**Which decision, by branch** (corrected in Phase 1.15):

| The version does | Decision | Governance |
| --- | --- | --- |
| create the record | `canCreateStorefrontRecord` | no assignment yet exists |
| take the Storefront live (`→ ACTIVE`) | `canActivateStorefrontRecord` | **`SUPER_OWNER` only** |
| resume from `SUSPENDED` | `canResumeStorefrontRecord` | **`SUPER_OWNER` only** |
| widen exposure toward the public | `canIncreaseStorefrontExposure` | **`SUPER_OWNER` only** |
| anything else — presentation, standing down | `canEditStorefrontPresentation` | `ADMIN` or `SUPER_OWNER` |

> **Corrected in Phase 1.15.** An earlier revision of this document stated that
> the service "honours `canCreateStorefrontRecord` / `canEditStorefrontPresentation`",
> and the implementation matched: **every** lifecycle and visibility move,
> including `DRAFT → ACTIVE` and `PRIVATE → PUBLIC`, was authorized by the
> presentation-edit decision — which admits an `ADMIN` and reads neither the
> owner's participant standing nor Monacado's go-live determination.
>
> That contradicted the authoritative source model, which reserves activation,
> resumption, and public visibility to the active `SUPER_OWNER`
> ([`AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md`](AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md) §7,
> recorded as data in `SUPER_OWNER_EXCLUSIVE_AUTHORITIES`). This document
> described the weaker behaviour as though it were the design; it was a defect,
> and the authoritative model governs. `ADMIN` retains every operational
> authority it legitimately holds, and standing a Storefront down is never gated
> on commerce readiness.

For the go-live branches the owner's **payment readiness is read** through
`readReadinessIn` and go-live approval through `resolveCommerceApproval`, rather
than taken from `toStorefrontOwnerFacts`, whose hardcoded initial value was
written when no payment record existed and would otherwise make the authority the
source model specifies impossible to satisfy. The presentation branch continues
to pass the conservative `NOT_APPROVED`, because editing does not depend on it.

One fact is deliberately **not** derived from persisted state:

- `ownerKind` — `null`. The participant model records no
  INDIVIDUAL/ORGANIZATION kind, and 0M.3A is explicit that an unresolved kind is
  `null` and is **never silently treated as INDIVIDUAL**.

> **Superseded by Phase 1.18: `authorizedForOwnerParticipant` is now derived.**
> It was supplied by the caller, alongside `authorizedByParticipantId` — which
> named *which participant the caller was*, and from which the service looked up
> the account. Together they meant that knowing one opaque participant id was
> enough to act as its holder on every Storefront write, including go-live and
> governance appointment. Two owner-branch checks compared that claimed id
> against the stored owner id directly, which made a revoke-then-appoint
> takeover of any Storefront possible.
>
> Both members are replaced by `actingAccountId`. The acting participant is
> resolved through `MarketplaceParticipant.accountId`, and authorization to act
> for the owner is derived from the two records that can establish it:
> self-ownership, or an **ACTIVE** `StorefrontGovernanceAssignment` naming the
> actor on this Storefront.
>
> 0M.3A's prohibition is preserved exactly, because it is a prohibition on
> inferring authority from an *email domain, a display name, or a private profile
> datum* — none of which is read, or readable, by the derivation. What 0M.3A
> deferred was organization-membership persistence, and that stays deferred: a
> member of an organization-owned Storefront who is neither the owner nor a
> governance assignee has no authoritative record, and is therefore **denied**.
> Fail-closed is the honest answer for an authority the database cannot
> evidence.

`paymentReadiness` is the initial `NOT_STARTED`: no payment record exists (0M.8
owns that axis), so it cannot report `ENABLED`.

Holding an Account grants nothing. Internal capabilities are carried only so the
0M.3A decisions can be shown to ignore them.

## 11. Exact source reconstruction

`versionRowToSourceVersion` is the reason for the phase. A persisted row
round-trips **exactly** into the canonical `StorefrontSourceVersion` — validated
through the contract's own schema, with nothing added, dropped, or
reinterpreted. `tagline` and `summary` stay `null` rather than becoming
`undefined`, because the contract holds them as nullable and collapsing the two
would give absence a second representation.

Malformed persisted data raises `CorruptStorefrontRecordError` rather than
returning a best-effort object: an unparseable stored row means the database
holds something no code path should have been able to write, and letting it
through would feed corrupt authoritative state into a capsule projection.

## 12. Projection compatibility

A persisted source version feeds `storefrontSourceRecordToCapsuleProjection`
unchanged. **No projection semantics were altered.**

The tests prove both halves: a capsule built from a persisted version carries the
expected public facts, and an equivalent in-memory source produces a
**byte-identical capsule with the same content hash**.

Node bindings remain supplied projection inputs. The tests use synthetic
Registrar-issued values; **no Node is issued or stored by this phase**.

## 13. Delete behaviour and FK integrity

**Every foreign key is `RESTRICT`. There is no `CASCADE` anywhere in these
tables**, and a test asserts it.

| From | To | Rule |
| --- | --- | --- |
| `Storefront.ownerParticipantId` | `MarketplaceParticipant` | RESTRICT |
| `StorefrontSourceRecordVersionRow.internalStorefrontId` | `Storefront` | RESTRICT |
| `StorefrontSourceRecordVersionRow.ownerParticipantId` | `MarketplaceParticipant` | RESTRICT |
| `StorefrontSourceRecordVersionRow.authorizedByParticipantId` | `MarketplaceParticipant` | RESTRICT |
| `StorefrontGovernanceAssignment.internalStorefrontId` | `Storefront` | RESTRICT |
| `StorefrontGovernanceAssignment.participantId` | `MarketplaceParticipant` | RESTRICT |

A participant who owns a Storefront, authored a version, or holds a governance
assignment cannot be deleted. A Storefront with history cannot be deleted. The
authorization trace is history, so it pins its participants too.

Governance assignments are `RESTRICT` rather than `CASCADE` deliberately: they
are authorization records, and losing them would lose the answer to "who used to
administer this".

## 14. Privacy

The persisted Storefront matches the 0M.3A source contract and does not expand
it. No column exists for credentials, sessions, private contact details,
`ParticipantProfile` data, payment-provider credentials, underwriting, tax
evidence, risk classifications, payout credentials, or moderation notes — nor for
capsule, Node, or publication machinery.

`NEVER_ON_STOREFRONT_RECORD` enumerates the refusals so a test can assert each is
rejected by the input contracts and absent from the schema.

## 15. Deferred

- **Storefront AgentNet Node** — no Node table, no issuance. A future phase must
  decide what warrants one, and must not derive it from `mon:storefront:` or the
  public handle.
- **Publication** — no publication, outbox, receipt, reconciliation, or Registrar
  interaction.
- **Go-live approval workflow** — approval stays a supplied input; the mechanism
  that produces it is a later operational concern.
- **Offer and Listing persistence** — `0M.6` and `0M.7`, the remaining two
  entities in the same position this phase just resolved for the Storefront.
- **Payment onboarding, risk policy** — `0M.8` and `0M.R`.

## Reference

- [`AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md`](AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md) — the 0M.3A model this persists
- [`STOREFRONT_CAPSULE_PROJECTION.md`](STOREFRONT_CAPSULE_PROJECTION.md) — the 0M.3B projection this now feeds
- [`PARTICIPANT_PERSISTENCE.md`](PARTICIPANT_PERSISTENCE.md) — the owner and governance participants
- [`PRODUCT_PERSISTENCE.md`](PRODUCT_PERSISTENCE.md) — the persistence pattern followed here
- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
- [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) — binding ADR
- [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md)
