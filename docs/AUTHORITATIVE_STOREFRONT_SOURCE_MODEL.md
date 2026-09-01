# Authoritative Storefront Source Model (Phase 0M.3A)

Status: **binding** for the Storefront track. Subordinate to
[`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
(ADR §12) and
[`MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md`](MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md).

Defines the authoritative database-backed **Storefront business record** and its
immutable source-version contract.

**No capsule projection shape, JSON-LD or ontology term, Node or capsule
identity, persistence, migration, route, UI, Listing/placement record, or
publication machinery is introduced by this phase.**

## 1. The database is the sole source of Storefront truth

Every field in §5 is authoritative, held relationally, changed only through
transactional services. Following ADR §12:

- **all business changes are recorded before any capsule projection occurs**;
- a capsule never supplies data to, repairs, or overrides the Storefront record;
- projection runs one way, and this is the end it starts from.

## 2. Ownership belongs to one participant, not to a role and not to a person

A Storefront belongs to **exactly one `MarketplaceParticipant`**. That is the
whole of ownership. There is no owner array, no co-owner field, and no
administrator array on the record or the version.

The owning participant may represent:

- an **individual**; or
- an **organization**.

An organization-owned Storefront may be administered by **multiple organization
members** — and **administrative authority never makes a member a co-owner**.
Ownership stays with the one participant; the members hold *governance
assignments* (§3).

> `MarketplaceParticipant` must eventually support at least `INDIVIDUAL` and
> `ORGANIZATION` kinds. **This phase does not implement the participant-kind
> model or any organization/membership persistence** — the owner's kind arrives as
> a supplied decision input, and `null` (unresolved) is never treated as
> `INDIVIDUAL`.

**A Storefront does not operate under one permanently selected marketplace
role.** There is no `ownershipAuthorityRole`, no Seller-basis or Promoter-basis
mode, no `SELLER_ONLY` / `PROMOTER_ONLY` / `HYBRID` enum, no
permitted-listing-type array, and no `allowsOwnedProducts` /
`allowsPromotedProducts` flag. A test asserts each of those shapes is refused on
both the record and the version.

- **Marketplace roles are the *owner's* commercial capabilities.** A participant
  may hold `SELLER` only, `PROMOTER` only, or both. **Any one Storefront-capable
  role qualifies** them to own a Storefront; holding both qualifies them once.
- **`BUYER` and `INTERNAL_OPERATOR` never qualify.** Buying is not retailing, and
  an internal entitlement is not a marketplace role (Phase 0M.1 §1).
- **The acting human need not hold a marketplace role personally.** The
  organization holds `SELLER`; the member holds a governance assignment. These are
  separate facts and separate inputs.
- **Ownership does not change when a role is granted or revoked.**
- **One participant may eventually own multiple Storefronts.** Plan-based limits
  are service and persistence concerns.

### A Storefront may hold owned Listings, promoted Listings, or both

A single Storefront may eventually contain:

- only Listings for Products and Offers its owner controls;
- only promotional Listings for other Sellers' eligible Offers;
- a hybrid combination of both.

Which is why no basis is recorded: freezing a mode at creation would decide, on
day one, something the owner may legitimately change their mind about on day two —
and would have to be migrated when they did.

## 3. Placement authority is evaluated per Listing

**A Storefront embeds no Product, Offer, or Listing array.** Listing records will
reference Storefronts, not the reverse, and **each placement's authority is
evaluated individually, against the roles the owner holds at that moment.**

Two reasons. First, versioning: an embedded array would make every listing
addition a Storefront change, and therefore a new immutable Storefront source
version — history would fill with events that say nothing about the storefront,
and "what did this storefront say on Tuesday" would become unanswerable. Second,
authority: placement rights follow the owner's *current* capabilities, and a
Storefront-level mode would freeze them.

Expected future rules, recorded here and **not implemented in this phase**:

| Listing kind | Will require |
| --- | --- |
| **Owned** | Storefront authority · `SELLER` role on the owner · authority over the referenced Product · authority over the referenced Offer |
| **Promoted** | Storefront authority · `PROMOTER` role on the owner · an Offer that permits promotion · **no authority to modify the creator's Product or Offer** |

### Future item-management authority

**`ADMIN` and `SUPER_OWNER` may eventually add or remove Listings** from the
Storefront, subject to Storefront authority, Listing lifecycle, Product and Offer
authority, promotion eligibility, and marketplace policy.

**Removing a Listing must never delete the underlying Product or Offer** — a shop
taking something off its shelves does not destroy the item.

### Future pricing authority, and who controls what

The commercial model, binding and **superseding any earlier minimum-resale-price
reading**:

| Controlled by | Facts |
| --- | --- |
| **Creator**, on the Offer | wholesale price · commercial availability · commission method · commission rate or fixed commission amount |
| **Promoter**, on the Listing | the buyer-facing retail price |

**The creator does not control the Promoter's final retail price.**
There is no creator-enforced minimum resale price.

### Commission

The creator selects one commission method:

- **`PERCENT_OF_WHOLESALE`** — `commission = wholesalePrice × commissionRate`
- **`FIXED_AMOUNT`** — `commission = fixedCommissionAmount`

**The Promoter's retail price does not change the commission due.** Commission is
computed from creator-controlled facts alone.

Before Offer activation the creator must see and approve: the wholesale price;
the commission method; the rate or fixed amount;
**the exact calculated commission per completed sale**;
and the expected creator gross proceeds before separately disclosed fees.
**The exact commission must never surprise the creator** — a rate alone is not
disclosure when what a creator wants to know is what they receive per sale.

> **Deterministic minor-unit rounding must be standardized in the Offer-economics
> correction phase before any settlement implementation.**

### Promoter economics

```
promoterGrossEarnings = commission + (promoterRetailPrice − wholesalePrice)
```

This permits a Promoter to compete **below wholesale** by surrendering part of the
commission, to sell **at wholesale** and earn the commission, or to sell **above
wholesale** and earn commission plus positive spread. Many Promoters may carry the
same Offer at different retail prices.

**No pricing calculation is implemented in this phase**, and none of this model is
implemented in the Storefront source module — it is a binding requirement for
**0M.2C (Offer economics correction)** and the authoritative Listing phase.

### Immutable sale economics (future)

Each completed sale must bind to the exact Offer source version, the exact
promoted Listing version, the actual retail price, the wholesale price, the
commission method, the rate or fixed amount, the exact calculated commission, and
the applicable fee schedule.

**Later Offer changes must not alter an already accepted order.** No Order or
settlement record is implemented now.

## 3a. Offer-change notice obligations

A change to **commercial availability**, **wholesale price**, **commission rate**,
**fixed commission amount**, or **commission method** creates a durable
notification obligation to every affected promoter participant.

**The canonical channel is the Monacado admin panel.** Email, SMS, and push may be
added later and are supplemental — they may accompany the notice and
can never replace it. A channel outside Monacado's control cannot be the system of
record for an obligation.

**One notice per (promoter participant × exact Offer source version × change
category).** Not per Listing and not per Storefront: a promoter carrying the same
Offer in five storefronts has one thing to decide, and five notices would be five
chances to miss the one that mattered. Notices should eventually be visible to the
promoter participant's active `SUPER_OWNER` and `ADMIN` governance users; for an
individual promoter the `SUPER_OWNER` sees them in the same admin panel.

### What each change does to dependent Listings

| Change category | Listings remain sellable | Requires explicit price review | Acknowledgement restores selling |
| --- | --- | --- | --- |
| **Commercial availability** | ❌ | — | ❌ |
| **Wholesale price** | ❌ | ✅ | ❌ |
| **Commission terms** | ✅ | ❌ | (nothing to restore) |

The asymmetry is deliberate. Availability and wholesale changes alter *what the
Promoter is selling* or *what it costs them*, so selling must stop until the
Promoter looks. A commission change alters only *what they earn* — stopping their
sales over it would punish them for the creator's decision.

- **Availability → unavailable:** every dependent promoted Listing becomes
  non-sellable and checkout is disabled. Promoter, `ADMIN`, and `SUPER_OWNER`
  cannot override the upstream status. **The Listing relationship is preserved and
  never destructively deleted** — UI may hide it or label it unavailable.
  Restoration behaviour is a future Listing-lifecycle decision.
- **Wholesale price change (increase or decrease):** dependent Listings become
  non-sellable and enter a future price-review-required state. The Promoter must
  explicitly review and reconfirm the retail price; reactivation is explicit, and
  **acknowledgement alone does not reactivate**.
  **Monacado never automatically changes a Promoter's retail price.**
- **Commission change (rate, fixed amount, or method):** Listings remain sellable,
  no deactivation occurs, the new exact commission is computed from the new Offer
  version, projected earnings update, and repricing is **optional**.
  Acknowledgement is informational and is not required for continued sale. The
  Promoter cannot alter the creator's commission terms.

### Notice content

A future notice must carry enough to act safely: the affected Offer; affected
Storefronts and Listing count; change category; effective Offer source version;
the previous value where permitted and the new value; the time recorded; whether
Listings remain sellable; the required action; and a direct path to the affected
Listings.

**It must never expose another participant's private identity or internal audit
evidence.**

Whether notices remain unread, acknowledged, resolved, or archived belongs to the
future notification model. **No notification persistence, delivery, UI, or
executable contract exists in this phase** — the rules above are documentation
that the future notification phase must implement, and the Storefront source
module deliberately contains none of them.

### The Offer contracts predate this model

The committed Offer source and capsule contracts were written before this final
wholesale-price interpretation and **are not modified in this phase**. A bounded
**Offer-economics correction is required before any Listing pricing, checkout, or
settlement implementation** — see the roadmap.

## 4. Identity and handle

| Thing | Form | Is not |
| --- | --- | --- |
| Source-record identity | `mon:srec:<opaque>` | the storefront itself |
| Internal Storefront identity | `mon:storefront:<opaque>` | a Node, a capsule id, or a URL |
| Public handle | `publicHandle` | an identity |

`mon:storefront:` is an **internal transactional identity**, in the same form as
`mon:offer:` and `mon:product:`. It is not an AgentNet Node IRI, not a capsule
identity, and not a public URL; any public Node is Registrar-issued in a later
phase.

**The public handle is routing, not a key.** Format: 3–63 characters, lowercase
ASCII letters, digits, and single interior hyphens —
`/^[a-z0-9]+(-[a-z0-9]+)*$/`. Written as segments rather than a character class
plus separate hyphen rules, so a leading hyphen, a trailing hyphen, and a `--`
run are refused by one expression instead of three checks that could drift out of
step. Case is fixed at lowercase because a handle differing only in case would be
a different handle to a database and the same one to a person.

**Uniqueness is a persistence concern**, not a shape constraint.

## 5. Authoritative fields

### 5.1 The current record

`storefrontSourceRecordId` · `internalStorefrontId` ·
`currentSourceRecordVersion` · `ownerParticipantId` ·
`sourceSystem`/`sourceRecordType`/`sourceClass` (fixed literals) · `lifecycle` ·
`visibility` · `publicHandle` · `presentation` · `createdAt` · `updatedAt`.

### 5.2 Presentation

Bounded public-facing **text only**: `displayName` (1–120), `tagline`
(1–200, nullable), `summary` (1–2000, nullable).

`tagline` and `summary` are **nullable, not optional** — an absent value has
exactly one representation. An omitted key and an explicit `null` would otherwise
be two authoritative snapshots of the same Storefront, and therefore a spurious
material change and a spurious source version. (The same rule the Offer's
effective interval follows.)

### 5.3 Absent by construction

No field exists for: a Listing/Product/Offer array, media, themes, custom domains,
navigation, SEO, localization, social links, analytics, plan limits, moderation
notes, Node or capsule identity, mapping version, publication state, Registrar
data, retention or legal-hold state, or a metadata bag.

## 6. Lifecycle and visibility

```
DRAFT      → ACTIVE, CLOSED
ACTIVE     → SUSPENDED, CLOSED
SUSPENDED  → ACTIVE, CLOSED
CLOSED     → (terminal)
```

Reverse, skipping, and self transitions are refused; a Storefront is created in
`DRAFT`. **`CLOSED` is terminal** — reopening is a new Storefront decision with
its own record, not a state change that quietly restores a public presence buyers
already saw close.

Visibility is a **separate axis**: `PRIVATE` | `UNLISTED` | `PUBLIC`. It is **not
publication state and not Node state** — a storefront can be `PUBLIC` and
unpublished, or published and later set `PRIVATE`.

**Monacado's go-live approval is part of public access, not a separate axis.**

| Lifecycle + visibility | Approval | Discoverable | Publicly accessible | Live |
| --- | --- | --- | --- | --- |
| `ACTIVE` + `PUBLIC` | `APPROVED` | ✅ | ✅ | ✅ |
| `ACTIVE` + `UNLISTED` | `APPROVED` | ❌ | ✅ | ✅ |
| `ACTIVE` + `PRIVATE` | either | ❌ | ❌ | ❌ |
| `ACTIVE` + `PUBLIC`/`UNLISTED` | `NOT_APPROVED` | ❌ | ❌ | ❌ |
| `DRAFT` / `SUSPENDED` / `CLOSED` | either | ❌ | ❌ | ❌ |

All three are **derived on demand and never stored** — there is no `isLive` field,
because a stored boolean would be a fourth thing to keep in agreement and the
first to go stale when approval was revoked. `UNLISTED` is the
reachable-but-not-listed case, which is why accessibility and discoverability are
two functions rather than one flag. **A visibility setting can never revive an
inactive Storefront.**

**There is exactly one definition of public access.** A helper that answered
"accessible" while approval was withdrawn would be a second, contradictory truth —
and the one a UI would reach for first. Configured visibility *intent* is a
separate, deliberately-named question (`visibilityIntentPermitsPublicAccess`); it
answers "what did the owner set", never "what can the public reach".

**Approval revocation takes effect immediately** — before any governed workflow
records `PRIVATE`. Waiting for a persistence step would leave a withdrawn
storefront publicly reachable in the meantime. **Restoring approval does not
restore visibility**: the `SUPER_OWNER` must explicitly go live again, because a
shop reappearing on its own is a decision nobody made.

No capsule-publication behaviour is defined here.

## 7. Storefront governance: SUPER_OWNER and ADMIN

Governance roles describe the authority of **human accounts acting for the
owner**. They are a different axis from `SELLER`/`PROMOTER`, which describe the
owning participant's commercial capabilities.

### SUPER_OWNER

**Exactly one active `SUPER_OWNER` must be appointed before a Storefront can go
live.** Activation and resumption are refused with
`ACTIVE_SUPER_OWNER_NOT_APPOINTED` otherwise.

The `SUPER_OWNER`:

- is the ultimate human administrator, and **may exercise every `ADMIN`
  permission**;
- is **responsible for financial administration** — the responsible party for
  payment-provider underwriting, and the authority over refunds, chargebacks,
  disputes, and payout administration;
- may make the Storefront live, withdraw it from live visibility, suspend it, and
  close it;
- may appoint and revoke `ADMIN` assignments, subject to future governance
  workflows.

### ADMIN

An `ADMIN` holds **limited operational authority**. They may edit presentation
today, and will eventually add and remove Listings and set permitted prices (§3).

An `ADMIN` may **not**, solely by virtue of being `ADMIN`: activate the
Storefront; make it publicly visible; deactivate live visibility; assume
underwriting responsibility; control refunds, chargebacks, disputes, or payouts;
replace the `SUPER_OWNER`; or change the Storefront owner.

The exclusivity list is recorded as data (`SUPER_OWNER_EXCLUSIVE_AUTHORITIES`), so
the boundary is inspectable and testable rather than only described here. **None
of the financial operations is implemented in this phase.**

### Exactly one active SUPER_OWNER

The requirement is expressed as a bounded **cardinality** — `NONE`,
`EXACTLY_ONE`, `MULTIPLE` — supplied as a resolved decision input, not as a
boolean and not as Storefront source truth.

A boolean would collapse two very different failures. **`MULTIPLE` is not a safer
`EXACTLY_ONE`**: two people each believing they hold final financial
responsibility is a governance defect, and going live under it would bake the
ambiguity into a live shop. Both `NONE` and `MULTIPLE` deny activation,
resumption, and increased exposure, with distinct reason codes.

**An actor holding the SUPER_OWNER assignment proves nothing about how many others
exist.** The actor's assignment and the population count are separate facts,
checked separately.

**A defective multiplicity must never trap a Storefront.** Reduction, suspension,
and closure proceed under `MULTIPLE` — those are the actions that make a defective
storefront safer, and requiring `EXACTLY_ONE` to perform them would leave the
storefront live precisely while its governance was broken. No commercial
readiness, payment readiness, go-live approval, owner marketplace role, or
participant `ACTIVE` status is required to stand a storefront down either.

### Contradictory facts fail closed

**Zero active SUPER_OWNER assignments cannot authorize an owner-governance
action.** An actor presented as holding an active `SUPER_OWNER` assignment bound to
this Storefront while the resolved cardinality is `NONE` is a contradiction: those
two facts describe a storefront that both has and has not got a super owner. Since
the safety-reducing actions impose no cardinality requirement, `NONE` there carries
no policy meaning at all — it only signals that the facts came from different
moments or different sources.

Such a request is **denied with `INCONSISTENT_SUPER_OWNER_STATE`** rather than
acted on. The contradiction is never silently ignored, and it is never treated as
an escape hatch: **emergency platform-operator intervention remains a separate,
deferred, audited authority path**, and must not be reachable by feeding
contradictory owner-governance facts to an owner decision.

### One consistent governance snapshot

The actor's governance assignment, its status, its Storefront binding, and the
active `SUPER_OWNER` cardinality **must be resolved from a mutually consistent
governance snapshot**.

This contract implements no governance persistence and no snapshot loading; it
only **rejects a contradictory resolved input when the contradiction is
detectable**. Guaranteeing consistency at the point of resolution belongs to the
future governance phase.

### Governance assignments are separate records

**No administrator array is embedded in the Storefront record or its source
version.** Governance will live in separate authoritative records — a
`StorefrontGovernanceAssignment` or equivalent — each associating one Storefront,
one human Account or organization membership, one governance role, an assignment
lifecycle, the granting authority, and immutable audit history.

**This phase implements no assignment persistence.** The Storefront contract
*accepts resolved governance facts as decision inputs*.

## 7a. Authority decisions

Seven pure decisions returning bounded `ALLOW`/`DENY`, reusing the Phase 0M.1
account, participant, role, and payment-readiness vocabularies.

Inputs are **separated into owner facts and actor facts**, because they are facts
about different entities:

| Owner facts | Actor facts |
| --- | --- |
| `ownerParticipantId` | acting `accountId` and `accountStatus` |
| `ownerKind` (`INDIVIDUAL` / `ORGANIZATION` / unresolved) | `authorizedForOwnerParticipant` |
| `participantStatus` | `governanceRole` (`SUPER_OWNER` / `ADMIN` / `NONE`) |
| `roles` (the owner's `SELLER`/`PROMOTER` assignments) | `governanceAssignmentStatus` |
| `paymentReadiness` | `assignmentStorefrontId` |
| `underwritingApproved` | `internalCapabilities` (proven to grant nothing) |

A decision therefore never depends on the actor personally holding `SELLER` or on
the actor's participant id matching the owner's.

**Authorization to act for the owner is never inferred from descriptive data.**
There is no email, domain, display name, or profile field on actor facts to
derive it from — organization membership must never be inferred from an email
domain.

> **Amended by Phase 1.18.** This passage read "supplied, never derived", and
> the persistence layer took it literally: `actorAuthorizedForOwnerParticipant`
> arrived as a caller-supplied boolean on every Storefront input, so a caller
> asserted its own authorization and the service believed it.
>
> The prohibition above is unchanged and still binding — nothing descriptive may
> establish this fact. What Phase 1.18 changed is that the *service* now derives
> it from **authorization records**: the actor IS the owner, or holds an ACTIVE
> `StorefrontGovernanceAssignment` on this Storefront. An appointment by the
> owner is the owner's own recorded authorization for someone else to act.
>
> The **pure decision model below is untouched**: it still receives
> `authorizedForOwnerParticipant` as an actor fact, and still never depends on
> the actor's participant id matching the owner's. Only the provenance moved.
>
> Organization membership persistence remains deferred, exactly as this document
> defers it. A member who is neither the owner nor a governance assignee has no
> authoritative record and is denied.

| Capability | Requires |
| --- | --- |
| `canCreateStorefrontRecord` | enabled acting account · authorized for the owner · drafting-eligible owner participant · ≥1 Storefront-capable owner role in a usable status |
| `canEditStorefrontPresentation` | enabled account · authorized · **active `ADMIN` or `SUPER_OWNER` assignment naming this Storefront** · lifecycle not `CLOSED` |
| `canActivateStorefrontRecord` | the above, **`SUPER_OWNER` only** · an active `SUPER_OWNER` appointed · owner `ACTIVE` · ≥1 owner role `ACTIVE` · payment `ENABLED` · **`underwritingApproved`** · permitted transition |
| `canResumeStorefrontRecord` | as activation |
| `canDeactivateStorefrontVisibility` | `SUPER_OWNER` only · the Storefront is currently publicly accessible |
| `canSuspendStorefrontRecord` | `SUPER_OWNER` only · permitted transition |
| `canCloseStorefrontRecord` | `SUPER_OWNER` only · permitted transition |

Rules worth stating outright:

- **Draft creation requires no governance assignment**, because none can exist
  yet — the Storefront being created is what an assignment would name. Designating
  the initial `SUPER_OWNER` is part of the creation operation, and **activation
  refuses to proceed without one**. For an individual owner the individual may be
  designated; for an organization owner a qualifying member must be.
- **Draft work requires neither participant `ACTIVE`, payment readiness, nor
  completed underwriting.**
- **Presentation edits never require payment readiness or underwriting, in any
  live state.** Correcting a misleading summary is exactly what an owner whose
  payments were just restricted may most need to do.
- **Suspending and closing never require payment readiness.** An owner who cannot
  be paid must still be able to stop trading.
- **A decision decides; it mutates nothing.** No lifecycle or visibility value is
  changed by any function here — a pure decision that also changed state would
  make the answer and the effect impossible to test apart.

Denied: an `ADMIN` attempting a `SUPER_OWNER` action (`SUPER_OWNER_REQUIRED`); an
actor not authorized for the owner; a missing, inactive, or mismatched governance
assignment (three distinct codes); an owner holding no Storefront-capable role; a
disabled account; and any modification to a `CLOSED` Storefront.

**An internal entitlement alone grants none of this.** A platform-operator
emergency intervention path may exist later, but internal entitlement must not
masquerade as owner authority — and a test proves toggling it changes no decision.

Reason codes are classifications only — no email, name, provider message,
identifier value, or personal data can appear in one. No database, environment,
clock, randomness, or network access exists in any decision.

> **Naming.** Phase 0M.1 defines participant-level capabilities
> `canCreateDraftStorefront` and `canActivateStorefront` — *may this participant
> work with storefronts at all?* These are named `can…StorefrontRecord` and carry
> `storefront:record:*` capability strings, so the two are never confused in code
> or in an audit trail.

### Role loss

Narrow rule, recorded now; **full remediation is deferred**:

- **Losing one role does not affect Storefront ownership** while the participant
  still holds another Storefront-capable role. A Seller who becomes
  Promoter-only still owns their Storefront.
- **Loss of Seller authority will later affect owned Listings**, and **loss of
  Promoter authority will later affect promoted Listings.** Those consequences
  belong to Listing lifecycle and eligibility services, not to this contract.
- **Loss of *all* Storefront-capable roles requires a future explicit Storefront
  restriction policy.** Today it simply means no Storefront decision passes; the
  record is untouched.
- **Nothing here automatically reclassifies, suspends, or closes a Storefront.**
  A contract that quietly closed storefronts on a role change would make a
  reversible administrative action irreversible.

## 8. Immutable source versioning

Every material change creates a new immutable source version carrying the
**complete material snapshot** — owner, lifecycle, visibility, handle, and
presentation — plus lineage (`supersedesSourceRecordVersion`, `null`
for the first), an opaque authorization trace
(`authorizedByParticipantId`, `authorizedByActorId`), and a caller-supplied UTC
`recordedAt`.

**A snapshot, not a delta.** A version that had to be replayed through its
predecessors would make reconstruction depend on an unbroken chain, and one
missing link would lose every version after it (Phase 0A.2 §4).

Version labels use the existing bounded-string form; **monotonic allocation is a
persistence-phase responsibility.** No `mappingVersion`, capsule semver, Node ID,
publication state, Registrar field, or retention state appears — projection
mapping is a capsulization-layer control (ADR §12.2), and this is the
transactional layer.

## 9. Material versus operational changes

**Material** (new source version required): `ownerParticipantId` · `lifecycle` ·
`visibility` · `publicHandle` · `displayName` · `tagline` · `summary`. Exactly
seven.

**Role grants and revocations are not material Storefront changes** — they are
participant facts. Granting a participant `PROMOTER` changes what they may place
in their Storefront and changes nothing about the Storefront; minting a source
version for it would attribute a participant event to every Storefront they own.
Future Listing membership changes are likewise not Storefront changes.

Presentation fields are reported individually — a rename and a summary rewrite are
different business events, even though both live under `presentation`.

**Operational only** (no version): view count · click count · listing count ·
cache state · publication retry state · worker lease state · receipt processing ·
archive location · monitoring counters · last-read timestamps.

A view counter moving does not mean the storefront changed; minting a version for
one would fill history very fast with events that assert nothing.

**An unclassified field name is a validation failure, not a guess** — defaulting
is wrong in both directions.

### Governance changes are not Storefront source versions

- **Governance assignments are separate authoritative records** with their own
  immutable history.
- **Appointing or removing an `ADMIN` does not create a Storefront presentation
  source version.** Nothing about the storefront changed.
- **`SUPER_OWNER` reassignment is a material governance event** — recorded in the
  governance records' own history, not in the Storefront's.
- **Whether a Storefront source version should reference the active
  `SUPER_OWNER` assignment is deferred** to the persistence/governance phase.
- **Marketplace-role changes remain participant facts**, and **Listing membership
  and Listing prices remain separate facts.**

## 10. Public and private boundaries

**Eligible for a later projection:** a future Storefront Node binding; an approved
public owner-authority Node binding; `displayName`; `tagline`; `summary`; a public
URL **derived** from the authoritative handle; lifecycle-derived public
accessibility; and public visibility where appropriate.

The Storefront's own identity and its owner reach a capsule only through
Registrar-issued Node bindings decided in a later phase — never as raw internal
identifiers.

**Never projection-eligible, in any phase:** raw owner participant id · account
id · role-assignment ids · email or legal identity · private profile data ·
payment readiness or provider ids · subscription or billing plan · internal
moderation notes · analytics · Listing contents · publication machinery · audit
internals · retention or legal-hold state — **and every governance fact**:
`SUPER_OWNER` account id, `ADMIN` account ids, organization membership ids, raw
governance-assignment records, underwriting data, bank/tax/payout/refund/dispute/
chargeback data, and internal authorization evidence.

Who administers a storefront is nobody's business but the marketplace's: a public
capsule that named its `SUPER_OWNER` would publish an organization's internal
structure as a side effect of listing a shop.

Most do not exist on the record at all; they are enumerated anyway, so that "may
this be published?" has a written answer before anyone is under pressure to ship a
projection. **No projection contract is created here.**

## 11. Deferred

Named as deferred, not silently omitted — and **not admissible through metadata or
extension bags**:

the Storefront capsule projection shape · Listing membership and ordering ·
Product and Offer placement · merchandising groups and collections · logo, hero
image, and media assets · design templates, themes, and customization · custom
domains · navigation structure · SEO configuration · localization · social links ·
paid placement · plan-based Storefront limits · moderation workflow · analytics ·
arbitrary custom CSS or scripts.

A test asserts each is refused on both the record and the version, that no
`metadata`/`extensions`/`custom`/`attributes`/`extra`/`settings` bag exists, and
that `presentation` itself is closed to media and styling.

## 12. Retention compatibility (Phase 0A.2)

Storefront source versions follow the generic retention model without
reimplementing it:

- source versions are **complete immutable snapshots**;
- the **storage lifecycle** (`HOT → ARCHIVE_PENDING → ARCHIVED → PURGED`) is
  separate from the Storefront lifecycle — a `CLOSED` Storefront is not an
  archived one, and an archived snapshot is not a closed storefront;
- **legal hold is orthogonal** and moves nothing;
- **purge eligibility is computed**, never stored;
- **archived snapshots retain reconstruction value** — the complete material
  state is present, so rebuilding what a storefront said on a given day needs no
  capsule;
- **capsule bodies and receipts cannot replace an authoritative source snapshot**
  — they verify, they do not reconstruct.

Nothing here persists a retention state; the generic contracts already model it.

## 13. Unresolved

1. **The public participant/Creator Node mapping** — still deferred (Phase 0M.1
   §13 item 1). The owner-authority Node binding a projection will need depends on
   it.
2. **Whether a Storefront receives its own Node**, or is expressed as a capsule
   bound to the participant's Node (ADR §11.5 says a Node is issued "where public
   AgentNet identity is warranted").
3. **Handle uniqueness, reservation, and change policy** — including whether a
   released handle may be reused, and what happens to inbound links.
4. **Organization and membership persistence** — the participant-kind model,
   organization records, membership records, and the
   `StorefrontGovernanceAssignment` model itself. This phase consumes resolved
   governance facts; nothing stores them.
5. **Governance workflows** — how a `SUPER_OWNER` is initially designated, how one
   is replaced, whether a replacement needs the outgoing holder's consent or a
   platform review, and how `ADMIN` appointment and revocation are audited.
6. **Platform-operator emergency intervention** — a path may be needed for an
   abandoned or abusive Storefront. It must be an explicit, audited operator
   power, never internal entitlement quietly passing for owner authority.
7. **All pricing and settlement questions in §3**, every one of which must be
   resolved before Listing pricing or settlement code begins.

## 14. Expected inputs to Phase 0M.3B

The Storefront Capsule Projection Shape will consume:

1. **one identified `StorefrontSourceVersion`** — never the current record, and
   never "the latest";
2. a strict **projection context** carrying the Storefront Node, the approved
   public owner-authority Node, the capsule identity and semver, a recorded
   mapping version, an explicit generation instant, and policy references — each
   Node binding paired with the internal identifier it stands for, so mismatches
   are refused;
3. the **projection-eligible field set** of §10, plus the resolved public identity
   mapping from §13;
4. the derived public accessibility from §6, rather than raw lifecycle and
   visibility, if the projection should not disclose the internal axes.

It must not add fields to the Storefront source model, read the current record in
place of a version, or write anything back.

## Reference

- [`AUTHORITATIVE_OFFER_SOURCE_MODEL.md`](AUTHORITATIVE_OFFER_SOURCE_MODEL.md)
- [`OFFER_CAPSULE_PROJECTION_SHAPE.md`](OFFER_CAPSULE_PROJECTION_SHAPE.md)
- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
- [`SOURCE_VERSION_RETENTION_AND_ARCHIVAL_POLICY.md`](SOURCE_VERSION_RETENTION_AND_ARCHIVAL_POLICY.md)
- [`MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md`](MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md)
