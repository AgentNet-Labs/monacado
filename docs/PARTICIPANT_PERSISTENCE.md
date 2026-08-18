# Participant Persistence and Draft Onboarding (Phase 0M.5)

The first phase in the marketplace track to touch the database.

Phases 0M.1 through 0M.3A produced roughly 3,500 lines of contract with no
storage behind any of it. Every one of them terminates at the same identity: an
Offer names a `sellerParticipantId`, a Storefront names an `ownerParticipantId`,
and all twelve capability decisions take a `MarketplaceSubject` carrying a
`MarketplaceParticipantView` — and until now nothing could construct one, because
`mon:mpart:` had no table. This phase gives it one.

**Draft onboarding only.** No activation approval, no payment provider, no
AgentNet Node, no participant capsule, no publication, no HTTP route, no UI.

## 1. Participant identity

`MarketplaceParticipant` is the marketplace identity of one account: who is
*transacting*, as distinct from who *authenticated*.

- **Identity** — `mon:mpart:<opaque>`, 26 Crockford characters from
  `crypto.randomBytes`. It is not the account id, is not derived from it, and
  encodes no role, name, email, storefront, or activation state. An identifier
  that carries meaning becomes a thing people read, and then a thing
  authorization accidentally keys on.
- **One per account**, enforced by a unique index on `accountId` rather than a
  read-then-write check, so two concurrent creations cannot both succeed.
- **Deletion is RESTRICT.** A participant anchors commercial history; deleting an
  account that holds one is refused, forcing an explicit closure first.

The separation is the point. Merging `Account` and `MarketplaceParticipant` would
make disabling a login and suspending a seller the same operation, and they are
not: a disabled account cannot authenticate, while a suspended seller may still
sign in to correct whatever caused the suspension.

## 2. Roles

`MarketplaceRoleAssignment` records one additive grant. SELLER, PROMOTER, and
BUYER coexist on a single participant — the thesis is explicit that a person may
be creator, promoter, or both, and ADR §11.5 forbids issuing a second Node merely
because one participant holds several roles.

| Role | Initial status | Why |
| --- | --- | --- |
| SELLER | `DRAFT` | Confers commercial capability; passes through activation. |
| PROMOTER | `DRAFT` | Same. |
| BUYER | `ACTIVE` | Guest checkout is a first-class path. A buyer role requiring approval would be stricter than buying with no account at all. |

`initialRoleAssignmentStatus` decides this, not the caller — a caller cannot
assert a role into ACTIVE. Granting a role the participant already holds is
**idempotent**: it returns current state and preserves the original `grantedAt`,
because re-granting is not an error a caller should have to distinguish from a
genuine conflict. It never revives a `REVOKED` role; that terminal state stands
until an explicit future operation addresses it.

`INTERNAL_OPERATOR` is not a marketplace role. It is an `AccountEntitlement`, and
one enum serving both questions is how a Monacado employee ends up holding seller
authority.

## 3. Profile privacy

`ParticipantProfile` holds **completion markers and onboarding gates only**.

There is no column for a legal name, trading name, address, date of birth, tax
identifier, document reference, bank or payout detail, provider account id,
provider secret, phone number, private contact field, or internal moderation
note. Phase 0M.1 §9 defers the field-level contents, and the thesis requires the
requirement set to be driven dynamically rather than frozen into a static global
checklist — so this table records **which sections are satisfied, never what was
supplied**.

That is the privacy control, and it is structural rather than procedural: a
projection cannot leak a column that does not exist, and the guarantee holds
against code nobody has written yet. The seven sections are `identity`,
`businessStructure`, `representatives`, `commercialProfile`, `risk`,
`payoutConfiguration`, and `documents`.

Three further safeguards sit on top of it:

1. **Every schema is a `strictObject`.** A private field arriving in a profile
   update is a validation failure, not a silently ignored extra.
2. **`findParticipantPrivacyViolations`** scans any projection-shaped value for
   credential, contact, payment, underwriting, and moderation key fragments at
   any depth. It is a **backstop, not the guarantee** — deliberately separate
   from `integrity/forbidden-fields`, whose own header records that its
   substring matching is a temporary Phase 0B safeguard that must not be
   expanded.
3. **The profile is a separate read.** `getParticipantProfile` is not part of
   `getParticipant`, so a caller building a public projection is not handed
   private state it never asked for.

**Completeness is derived, never stored.** `deriveProfileCompleteness` is the
only answer, on the same reasoning that keeps `isLive` off the Storefront source
model: a stored copy is a second answer that can disagree with the first. Phase
0M.1 §9's candidate design listed `completeness` as a column; this refines it.

## 4. Activation separation

Four axes, and none is inferred from another:

| Axis | Home | This phase |
| --- | --- | --- |
| Participant admission | `MarketplaceParticipant.status` | Drafting subset only |
| Role assignment | `MarketplaceRoleAssignment.status` | Initial status only |
| Activation review | `ParticipantActivation` | **Table created, no row written** |
| Payment readiness | *(nothing)* | **No storage at all** |

`advanceParticipantStatus` writes only `DRAFT`, `PROFILE_INCOMPLETE`,
`PROFILE_COMPLETE`, and `CLOSED`. It refuses `UNDER_REVIEW`, `ACTIVE`,
`RESTRICTED`, and `SUSPENDED` with `ActivationNotPermittedInPhaseError` — a
distinct error from `InvalidParticipantTransitionError`, because one means "not
in this phase" and the other means "never", and collapsing them would make a
phase boundary look like a domain rule.

The two gates run in that order deliberately: the phase gate first, then the
0M.1 transition table, so an attempt to jump `DRAFT → PROFILE_COMPLETE` is
reported as the illegal transition it is rather than masked.

`ParticipantActivation` exists but is never written here. It carries the deciding
actor as an opaque `mon:actor:` id — never an email or display name — and uses
the `undecidedForParticipantId` unique-index technique (as
`RegistrarReceipt.acceptedForPublicationId` does) to enforce at most one
undecided activation per participant, since MySQL has no partial indexes. The
table exists from the start so 0M.8 records *who decided what* rather than
inventing an activation as a bare status write.

**Payment readiness has no storage.** There is no `ParticipantPaymentAccount`
table and no readiness column, so nothing in this phase can report `ENABLED` —
by construction rather than by discipline. Materialization reports the initial
`NOT_STARTED`; 0M.8 replaces the constant with the provider's real answer.

## 5. Capability materialization

`materializeMarketplaceSubject(accountId)` is the function that makes the twelve
0M.1 capability decisions reachable from persisted state.

Three things it deliberately does not do:

- **It never reads `ParticipantProfile`.** The profile is not a parameter, so a
  capability decision cannot come to depend on a private value. Structural, not a
  convention.
- **It never reports payment readiness from storage** — see above.
- **It never grants an internal capability from a marketplace role.**
  `internalCapabilities` comes from `AccountEntitlement` and is passed through
  untouched, present precisely so `capability.ts` can be shown to ignore it.

An unknown account yields `GUEST_SUBJECT` rather than an error: "not signed in"
is a condition a caller handles, and raising would make every anonymous request
an exception. An account with no participant yields `participant: null` — the
authenticated non-participant.

The result is the thesis's onboarding premise made executable: from a `DRAFT`
participant holding a `DRAFT` SELLER role, `canCreateDraftProduct` and
`canCreateDraftStorefront` both ALLOW, while `canPublishOffer` and
`canReceivePayout` both DENY. Low-friction creation, governed activation.

## 6. Product creator-authority linkage

`ProductSourceRecordVersionRow` carried a deferred FK comment since Phase 0D:
*"opaque governed references; deferred FK to a future participant model."*

A direct FK on the existing `authorityCreatorId` column is **not possible**, and
this is a finding rather than a preference. That column holds `mon:creator:`
identifiers — a different identifier scheme from `mon:mpart:` — and existing
rows carry values matching no participant. Adding the constraint there would have
required one of three forbidden things: fabricating backfill participants,
renaming a committed identifier convention, or standing up a parallel `Creator`
table.

The resolution is **additive and nullable**:

```prisma
authorityCreatorParticipantId String? @db.VarChar(191)
authorityCreatorParticipant   MarketplaceParticipant? @relation(..., onDelete: Restrict)
```

This is exactly the pattern `RegistrarReceipt.submissionAttemptId` established in
Phase 0E.5.3: nullable so the migration is safe for rows written before the
referenced table existed, with the historical value left untouched and readable.
`authorityCreatorId` is **unchanged** — it is part of an immutable historical
row, and rewriting it would invent a participant that never existed.

`onDelete: Restrict` means a participant that authored any Product source version
cannot be deleted. **Immutable Product history is never cascade-deleted by a
marketplace-side operation.**

**Still open:** the Product write path does not yet *require* a participant for
new source versions. Making it mandatory changes the Product creation contract
and belongs to a Product-track phase, not to participant onboarding. Until then
the column is populated by whoever writes the row, and a NULL means "authored
before participants existed, or by a path that does not yet supply one".

## 7. The three settled 0M.1 decisions

### Decision 1 — `Creator` versus `Seller` as the published capsule name

**Ruling: one neutral `Participant` identity with additive roles.** There is no
`Creator` table and no `Seller` table; there is one `MarketplaceParticipant`
carrying role assignments. `SELLER` remains the authorization fact and `Creator`
remains the ADR's name for the publishable capsule authority the role produces —
one is who may act, the other is what gets published, and they are not competing
names for the same row.

This settles the *identity* question, which is what persistence needed. The
capsule's eventual `@type` label is a projection question and is answered when a
participant projection is designed.

### Decision 2 — Where email verification and terms acceptance are enforced

**Ruling: operational onboarding gates, never capsule facts.** Both are recorded
on `ParticipantProfile` as profile-completion prerequisites, and both are
required for `COMPLETE`. Neither is a participant status: a distinct status would
duplicate an account-level fact onto the marketplace axis, and the two would
drift.

Only the *instant* of email verification is stored — never the address, which
already lives on `Account`. Terms acceptance additionally requires the accepted
version, because "they agreed" without "to what" is not an enforceable record.

### Decision 4 — The public participant projection's field set

**Ruling: a closed allow-list of exactly three members** —
`publicParticipantRef`, `roles`, `participantStatus`
(`PUBLIC_PARTICIPANT_PROJECTION_FIELDS`).

It excludes private profile, credentials, payment state, and account/session data
by naming what is permitted rather than filtering what is not. A display name is
**absent**, because none is stored: the first one added must be an explicitly
public field, not a private profile value promoted into view. Adding any field is
an ADR-level decision.

**Nothing implements this projection.** No function, no capsule, no route. The
ruling is recorded now so a later projection is written against a closed list
rather than against whatever the record happens to hold.

0M.1's decisions 3 and 5–8 remain open and are untouched by this phase.

## 8. Deferred: participant Node and capsule

No participant AgentNet Node is issued and no participant capsule is generated.
ADR §11.5 says a Node is issued "where public AgentNet identity is warranted";
what warrants it for a participant remains open (0M.1 decision 4's second half),
and issuing one during drafting would create public identity for someone Monacado
has not yet admitted.

When that work happens it must hold the authority partition ADR §2 requires:
creator, promoter, Monacado, and buyer assertions live in separate capsules
around a shared node identity, never one flat capsule.

## 9. Deferred: payment provider

Stripe Connect onboarding, requirement synchronisation, and the governed
activation review are 0M.8. The generic `PaymentReadinessStatus` lifecycle stays
provider-neutral — Stripe's requirement model is mapped onto it, never
substituted for it — and **no raw participant provider credential is ever
stored** (thesis §5.5).

## 10. Scope held

Not implemented, and verified absent by test: participant Node, participant
capsule, Storefront persistence, Storefront capsule projection, Offer
persistence, Listing, Review, Stripe, payment onboarding, activation approval,
Publisher/Registrar changes, Resolver, HTTP routes, UI.

The service reads no clock, generates no randomness directly, and touches no
`process.env`; instants, identities, and the database are injected, matching the
account and publication services.

## Reference

- [`MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md`](MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md) — the 0M.1 design this phase migrates
- [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md)
- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
- [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) — binding ADR
- [`IDENTITY_SESSION_AND_INTERNAL_ENTITLEMENT_FOUNDATION.md`](IDENTITY_SESSION_AND_INTERNAL_ENTITLEMENT_FOUNDATION.md)
- [`PRODUCT_PERSISTENCE.md`](PRODUCT_PERSISTENCE.md) — the persistence patterns followed here
