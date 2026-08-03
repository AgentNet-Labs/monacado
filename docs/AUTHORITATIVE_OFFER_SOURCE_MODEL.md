# Authoritative Offer Source Model (Phase 0M.2A)

Status: **binding** for the Offer track. Subordinate to
[`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
(ADR §12) and [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md).

Defines the **authoritative transactional record** for an Offer and the immutable
source versions a later Offer Capsule Projection Shape will be generated *from*.

**No capsule contract, JSON-LD, Node or capsule identity, projection mapping,
canonicalization, hashing, publication preparation, persistence, migration,
route, or UI is introduced by this phase.**

## 1. The database is the sole source of truth

An Offer is an **authoritative database-backed commercial record**. Everything in
§4 is business truth, held relationally, changed only through transactional
services.

Following ADR §12, and repeated here because this is the first entity phase built
under it:

- **Monacado records every authorized business change before any capsule
  projection occurs.** Projection reads a version that already exists.
- **Capsules never supply data to, repair, or override the Offer record.** If a
  published capsule disagrees with the record, the capsule is regenerated,
  superseded, or revoked — the record is never edited to match what was
  published.
- Projection runs one way: authoritative record → source version → mapping →
  projection shape → projection → registration.

## 2. Offer versus Product, Listing, and capsule projection

| | Owns | Authority | This phase |
| --- | --- | --- | --- |
| **Product** | what the thing *is* — identity, specifications, capabilities | creator/seller | already exists; unchanged |
| **Offer** | **what it costs and on what terms it is sold** | seller | **defined here** |
| **Listing** | a promoter's curation, placement, and commentary | promoter | deferred (0M.4A) |
| **Capsule projection** | the published public artifact | none — derived | deferred (0M.2B) |

The Product/Offer boundary is where ADR §10.2 put it: price, currency,
availability windows, and commercial terms belong to the Offer, never to the
Product's `generalAvailabilityState`. The Product source record's forbidden-field
scan already refuses commercial fields, so the two cannot merge by accident from
either side.

**A Listing may reference a promotable Offer; it may never modify one.** Promoter
authority covers curation, not terms.

## 3. Authority

The Offer is controlled through a **marketplace participant holding Seller
authority**, identified by `sellerParticipantId` — an internal operational
identity from Phase 0M.1.

- **Seller authority is transactional.** No Creator Node, `mon:creator:` id, or
  other public semantic identity appears anywhere in this phase.
- **Promoters may later select promotable Offers but cannot modify Offer terms.**
- **Buyers and internal operators have no Offer-writing authority.** An internal
  entitlement grants nothing here, in either direction (Phase 0M.1 §1).
- The mapping from this transactional Seller identity to a **public
  Creator/authority Node remains unresolved** — see §11.

## 4. Authoritative fields

### 4.1 The current Offer record

| Field | Meaning |
| --- | --- |
| `offerSourceRecordId` | `mon:srec:<opaque>` — the **existing** source-record convention, not a second identity system |
| `internalOfferId` | `mon:offer:<opaque>` — the enduring internal Offer identity |
| `currentSourceRecordVersion` | pointer to the latest immutable version |
| `internalProductId` | `mon:product:<opaque>` — **exactly one** authoritative Product |
| `sellerParticipantId` | `mon:mpart:<opaque>` — the controlling Seller participant |
| `sourceSystem` / `sourceRecordType` / `sourceClass` | fixed literals `monacado` / `Offer` / `governed-database-record` |
| `lifecycle` | §5 |
| `availability` | §6 |
| `terms` | price and promotion, validated together (§7, §8) |
| `effectiveInterval` | optional, nullable (§9) |
| `createdAt` / `updatedAt` | explicit UTC instants |

**One Product may have multiple Offers.** Nothing in the contract forbids two
Offers naming the same `internalProductId`; uniqueness rules, if any are ever
wanted, belong to the persistence phase.

### 4.2 What is absent by construction

Every schema is `strictObject`. There is **no field** for: Node ID, capsule ID,
publication or registration state, receipt data, `mappingVersion`, capsule
semver, retention state, database row id, account id, email, legal identity,
private profile data, payment-provider ids, banking or tax data, internal cost or
margin, platform or processing fees, earned commission, order/checkout/payment/
refund/settlement/payout data, audit internals — or a `metadata` bag through which
any of them could arrive.

## 5. Operational lifecycle

```
DRAFT      → ACTIVE, WITHDRAWN
ACTIVE     → SUSPENDED, ENDED, WITHDRAWN
SUSPENDED  → ACTIVE, ENDED, WITHDRAWN
ENDED      → (terminal)
WITHDRAWN  → (terminal)
```

Every other transition — reverse (`ACTIVE → DRAFT`), skipping (`DRAFT → ENDED`),
and self-transitions — is refused. An Offer is created in `DRAFT`.

**`ENDED` and `WITHDRAWN` are terminal.** An Offer that ended and must sell again
is a *new Offer*: reviving a terminal one would silently reattach a new commercial
commitment to a record buyers already saw close.

Lifecycle is separate from commercial availability, publication state, Node state,
and source-version retention state — four different questions, four vocabularies
that share no member.

## 6. Commercial availability

`AVAILABLE` | `TEMPORARILY_UNAVAILABLE`.

Availability answers whether an **otherwise ACTIVE** Offer may presently be
selected commercially. It is **not** inventory quantity, variants, publication
status, or an internal workflow step.

```
isCommerciallySelectable = lifecycle === ACTIVE && availability === AVAILABLE
```

A `DRAFT`, `SUSPENDED`, `ENDED`, or `WITHDRAWN` Offer is unselectable **whatever
the availability field says**. Availability modifies a live Offer; it can never
make a dead one live.

A later projection may derive a public ended state from authoritative lifecycle
data. **That projection is not defined here.**

## 7. Price terms

A strict discriminated union on `type`:

- **`FREE`** — no amount field, no currency field. Absence by construction: a free
  Offer cannot carry a stray price because there is nowhere to put one.
- **`PAID`** — `amountMinorUnits` (positive integer) and `currency`.

**Money is minor units only.** `9.99` is rejected by the type: floating-point
money is a rounding bug that surfaces in settlement months later, so it is refused
at the boundary rather than discovered by the ledger.

### Currency validation is structural, and says so

`/^[A-Z]{3}$/` — three uppercase letters. **This is not ISO 4217 registry
validation**, and must never be described as such. The repository holds no
maintained currency registry, and a frozen list here would be wrong within a year.
Full registry validation — which currencies Monacado actually supports, and their
minor-unit exponents (`JPY` has none, so "minor units" is not universally
"cents") — is a **future service concern**. A test asserts that an unassigned code
still parses, so the limitation is visible rather than assumed away.

## 8. Promotion and commission terms

`NOT_PROMOTABLE` | `PROMOTABLE`, with Seller-controlled commission terms:

- **percentage** — basis points, `1 … 10 000` (1 = 0.01%, 10 000 = 100%);
- **fixed** — positive minor units plus a currency.

Cross-field rules, validated on `terms` as a whole rather than trusted to a
caller:

| Refused | Because |
| --- | --- |
| `PROMOTABLE` on a `FREE` Offer | there are no sale proceeds to pay a commission from |
| fixed commission in a different currency | a cross-rate the Offer never agreed to |
| fixed commission exceeding the price | a sale that pays out more than it takes in |
| a commission on `NOT_PROMOTABLE` | no field exists for one |

**Earned commissions, attribution, settlement, and payouts are not part of the
Offer source record.** Those are financial records — relational-first, not entity
capsules (ADR §1) — about sales that happened. This is the standing term a seller
offers. Non-monetary referral incentives are deferred (§12), not admitted as a
commission on nothing.

## 9. Effective interval

Optional `startsAt` and `endsAt`, each expressed as an explicit `null` when
absent — matching the nullable columns a persistence phase will use, so the
authoritative snapshot and the eventual row agree without a translation step.

- Normalized UTC instants only (`z.iso.datetime()` accepts only a `Z`-suffixed
  value; offsets and dates are refused).
- When both exist, `endsAt` must be **later than** `startsAt` — equal is refused.
- **Nothing reads a clock.** Every instant is caller-supplied.
- **An elapsed interval does not move the lifecycle.** Expiry is a governed
  transition someone performs, not a state the data drifts into while nobody is
  looking — otherwise "why did this Offer end?" would have no actor and no record.

### One canonical representation of absence

`effectiveInterval: null` is the **only** way to say "no effective interval". An
interval object with both bounds null is refused.

Two spellings of one fact would mean two authoritative snapshots of the same
Offer — and therefore a spurious material change, a spurious source version, and
a diff that cannot decide whether anything happened. `normalizeOfferEffectiveIntervalInput`
folds convenient inputs (`undefined`, `null`, `{}`, either bound omitted) into the
canonical value at the edge, so the authoritative schema itself stays strict:
normalizing *inside* the record schema would make both spellings "valid input",
which is how a second representation creeps back in.

## 10. Seller authority decisions

Seven pure decisions returning bounded `ALLOW` / `DENY` with safe reason codes.
They **reuse** the Phase 0M.1 account, participant, role, and payment-readiness
vocabularies rather than duplicating them; only four Offer-specific reason codes
are added (`SELLER_PARTICIPANT_MISMATCH`, `PRODUCT_AUTHORITY_REQUIRED`,
`OFFER_LIFECYCLE_TRANSITION_NOT_PERMITTED`, `OFFER_LIFECYCLE_TERMINAL`).

| Capability | Gates |
| --- | --- |
| `canCreateDraftOffer` | enabled account · drafting-eligible participant · SELLER role in a drafting status · **matching Seller** · **Product authority** |
| `canActivateOffer` | matching Seller · SELLER `ACTIVE` · participant `ACTIVE` · payment `ENABLED` · Product authority · permitted transition |
| `canResumeOffer` | as activation (the Offer becomes live again) |
| `canChangeOfferTerms` | matching Seller · Product authority · **full commerce gates when live**, drafting gates on a `DRAFT` |
| `canSuspendOffer` | matching Seller · permitted transition |
| `canEndOffer` | matching Seller · permitted transition |
| `canWithdrawOffer` | matching Seller · permitted transition |

Two rules deserve stating outright:

- **Standing an Offer down never requires payment readiness or Product
  authority.** Requiring an intact commerce gate to *stop* selling would trap the
  exact seller who most needs to stop — one whose payment capability was just
  restricted. Withdrawing a commitment you made is also not an assertion about the
  Product.
- **Changing the price of something currently on sale is selling**, so live term
  changes face the same gates as activation.

### Editing a DRAFT

A `DRAFT` Offer's terms may be edited by the matching Seller under **exactly the
gates that created the draft** — enabled account, drafting-eligible participant,
SELLER role in a drafting status, matching Seller, and Product authority.
Editing a draft **does not require participant `ACTIVE`** and **does not require
payment readiness `ENABLED`**: that is what drafting is for, and a bare-bones
account that could create a draft but never revise it would be useless.

Unauthorized subjects are refused on a draft exactly as on a live Offer — a
promoter gets `ROLE_NOT_HELD`, a different seller gets
`SELLER_PARTICIPANT_MISMATCH`.

**A `SUSPENDED` Offer's terms currently face the full commerce gates.** That is
pinned by test, not designed: suspension is a stand-down, and this phase grants no
new editing permission during one. Whether a suspended seller should be able to
edit terms *in order to cure* a suspension is a **remediation-policy question,
deferred** — see §16.

Every denial is a classification: no email, name, provider message, identifier
value, or personal data can appear in a reason code. No database, environment,
clock, randomness, or network access exists in any decision — asserted by a test
that greps the module source.

## 11. Immutable source versioning

**Every material Offer change creates a new immutable Authoritative Source
Version.** A version carries:

- `offerSourceRecordId`, `sourceRecordVersion`, `supersedesSourceRecordVersion`
  (null for the first), `internalOfferId`;
- the fixed source-system triple;
- the **complete material snapshot** — Product reference, Seller reference,
  lifecycle, availability, terms, effective interval;
- the authorization trace — `authorizedBySellerParticipantId`,
  `authorizedByActorId` (opaque; never an email or a name), and an explicitly
  supplied `recordedAt`.

**A snapshot, not a delta.** A version that had to be replayed through its
predecessors to be understood would make deterministic reconstruction depend on an
unbroken chain, and one missing link would lose every version after it.

**No `mappingVersion` and no capsule semver.** The Product source record carries
those because it doubles as capsule-candidate input; that is a capsulization-layer
control (ADR §12.2), and this is the transactional layer. Phase 0M.2B introduces
the projection mapping and records its version where the projection lives.

Also binding:

- **Version labels use the existing Product-compatible bounded format** — a
  1–64-character string, matching the `VarChar(64)` the source-version table
  already uses. **Monotonic allocation is a persistence-phase responsibility**;
  no contract here mints or orders labels.
- **Archival location and retention state are not material Offer facts** and
  appear nowhere on the record or the version.
- **Exact historical snapshots remain reconstructable independently of capsule
  storage.** A version carries the complete material state, so rebuilding what an
  Offer said on a given day never requires a capsule body, a Registrar copy, or a
  hash — which verify but cannot reconstruct (Phase 0A.2 §4).

### Offer identity is transactional only

`mon:offer:<opaque>` is an **internal enduring transactional identity**. It is
distinct from `mon:srec:<opaque>` (the source-record identity), and it is **not**
an AgentNet Node IRI, **not** a capsule-version identity, and **not** a Registrar
identifier. Its presence is not evidence that projection work has begun — the
public identity an Offer may eventually carry is Registrar-issued and mapped in a
later phase. Nothing in this phase is called an "Offer Node".

A test asserts that neither the record nor the version accepts a Node, capsule,
mapping, projection-hash, Registrar, receipt, publication, or JSON-LD field, and
that an ANS-shaped value is refused as the internal Offer id.

## 12. Material versus operational changes

**Material** — a new source version is required:
`internalProductId` · `sellerParticipantId` · `lifecycle` · `availability` ·
`price` · `promotion` · `commission` · `effectiveInterval`.

Each alters what a buyer would be agreeing to, who is offering it, or whether it
is on sale at all. `promotion` and `commission` are reported separately: turning
promotability on and changing a rate are different business events.

**Operational only** — no semantic version:
publication retry state · worker lease state · receipt processing · archive
location · operational cache · read timestamps · monitoring counters.

A retry counter moving does not mean the seller changed their offer. Minting a
version for one would fill history with events that assert nothing and make "what
did this Offer say on Tuesday?" unanswerable.

**An unclassified field name is a validation failure, not a guess.** Defaulting is
wrong in both directions — assume material and history fills with noise; assume
operational and a real change goes unrecorded. A new field must be classified
deliberately.

## 13. Public/private classification

**Eligible for a later projection** (classification only — no projection contract
is created here):

- Offer identity — **through a future public Node mapping**, never the raw
  `mon:offer:` id;
- Product reference — **through a future Product Node**;
- an approved public authority reference **derived later** from the Seller/Creator
  mapping;
- lifecycle-derived public commercial state;
- price and currency;
- effective interval;
- promotability and the offered commission terms.

**Never projection-eligible, in any phase:** account id · a raw participant id as
a public identifier · email or legal identity · private profile data ·
payment-provider ids · banking or tax data · internal review notes · internal cost
or margin · platform or processing fees · earned commission · order, checkout,
payment, refund, settlement, or payout data · audit internals · source-retention
state.

Most of these do not exist on the Offer record at all. They are enumerated anyway,
so that "may this be published?" has a written answer before anyone is under
pressure to ship a projection.

## 14. Deferred extensions

Named as deferred, not silently omitted — and **not admissible through arbitrary
metadata**. The core Offer model stays category-neutral; each of these needs a
phase that decides its semantics, not a loose key:

discounts and promotional price schedules · inventory quantities and reservations
· variants and option combinations · territory and geographic eligibility · tax
treatment · shipping and fulfillment constraints · subscriptions, rentals, and
recurring billing · license duration, usage limits, and entitlement delivery ·
category-specific compliance terms · non-monetary referral incentives.

A test asserts each is refused on both the record and the version, and that no
`metadata`, `extensions`, `custom`, `attributes`, `extra`, or `data` bag exists to
smuggle them through.

## 15. Retention compatibility (Phase 0A.2)

Offer source versions follow the generic retention model without reimplementing
it:

- current truth stays operational; material historical versions are immutable;
- the **retention storage lifecycle** (`HOT → ARCHIVE_PENDING → ARCHIVED →
  PURGED`) is separate from the Offer lifecycle;
- **legal hold is orthogonal** and moves nothing;
- **purge eligibility is computed**, never stored;
- published source versions default to **preserving the complete authoritative
  snapshot**;
- **hashes and receipts cannot substitute for a source snapshot** — they verify,
  they do not reconstruct;
- **archival changes no Offer lifecycle state and no public meaning.**

Nothing in this phase persists a retention state; the generic contracts already
model it.

## 16. Unresolved: Seller versus public Creator mapping

This phase deliberately does not resolve it. Open:

1. **Which public identity an Offer's authority projects to** — the ADR's
   `Creator`, a public participant projection, or a Seller-specific Node.
2. **Whether an Offer receives its own Node**, or is expressed as a capsule bound
   to the Product's Node (ADR §11.5 says a Node is issued "where public AgentNet
   identity is warranted"; whether an Offer warrants one is undecided).
3. **How commission terms should be published, if at all** — they are commercially
   sensitive, and "promotable, terms on request" may be the correct projection.
4. **Currency registry and minor-unit exponents** — which currencies are
   supported, and how non-two-decimal currencies are handled.
5. **Whether a Product may have at most one ACTIVE Offer at a time** — permitted
   by contract today; a persistence-phase decision.
6. **Suspended-Offer remediation policy** — whether a seller may edit terms during
   suspension in order to cure it, and under which gates. Today a `SUSPENDED`
   Offer's terms face the full commerce gates (§10); no remediation path is
   designed, and none is implied.

These carry the same standing as Phase 0M.1's open decisions: recorded, not
assumed, and none blocks 0M.2B.

## 17. Expected inputs to Phase 0M.2B

The Offer Capsule Projection Shape will consume:

1. **one identified `OfferSourceVersion`** — never the current record, and never
   "the latest";
2. a **recorded projection mapping version**, introduced by 0M.2B itself;
3. the **projection-eligible field set** of §13, plus the resolved public identity
   mapping from §16;
4. an explicit generation instant, supplied by the caller.

It must not add fields to the Offer source model, read the current record in place
of a version, or write anything back.

## Reference

- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
- [`SOURCE_VERSION_RETENTION_AND_ARCHIVAL_POLICY.md`](SOURCE_VERSION_RETENTION_AND_ARCHIVAL_POLICY.md)
- [`MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md`](MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md)
- [`PRODUCT_SOURCE_RECORD_MAPPING.md`](PRODUCT_SOURCE_RECORD_MAPPING.md), [`PRODUCT_PERSISTENCE.md`](PRODUCT_PERSISTENCE.md)
