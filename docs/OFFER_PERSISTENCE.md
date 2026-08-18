# Offer Persistence (Phase 0M.6)

The authoritative Offer record, its immutable source-record versions, and the
narrow service layer over them — the middle stage that was missing between the
`0M.2A` source model and the `0M.2B` capsule projection.

Until this phase, the declared pipeline

```
AUTHORITATIVE_SOURCE_MODEL → AUTHORITATIVE_SOURCE_VERSION
  → PROJECTION_MAPPING → CAPSULE_PROJECTION_SHAPE → CAPSULE_PROJECTION
```

had nothing behind its second stage for the Offer: `projectOfferCapsule` could
only ever be handed a synthetic fixture. A persisted source version now feeds it
directly and produces a capsule byte-identical to the equivalent in-memory
source.

**This phase adds no Offer fact and no economic rule.** `0M.2A` and `0M.2C`
remain the authority on what an Offer is and what its economics mean; `0M.6`
stores exactly that and nothing more.

---

## 1. Database authority

The database is the sole source of truth (ADR §12). Every column here is
authoritative transactional state. The capsule projection reads it one way and
writes nothing back — there is no inverse mapper, and no code path through which
a capsule could supply, repair, or override a stored value.

Deliberately absent from both tables, and absent by design rather than by
oversight: `mappingVersion`, `capsuleId`, `nodeId`, `contentHash`,
publication state, and retention state. A projection mapping is a
capsulization-layer control (ADR §12.2), and this is the transactional layer.

## 2. Stable Offer versus immutable source versions

Two tables, mirroring the Product and Storefront pattern.

**`Offer`** is the enduring identity. It holds `internalOfferId`, the constant
`offerSourceRecordId`, the `currentSourceRecordVersion` pointer, the Product and
seller references, and a denormalized copy of `lifecycle` and `availability` for
querying. The denormalized copies are never an independent truth: they move with
the pointer inside the same transaction, so they cannot disagree with the version
they point at.

**`OfferSourceRecordVersionRow`** holds complete, immutable snapshots. A material
change inserts a new row; **no historical row is ever updated in place.** Each
snapshot carries every material field rather than a delta, because a version that
had to be replayed through its predecessors would make reconstruction depend on
an unbroken chain, and one missing link would lose every version after it.

Prior versions remain readable forever. No retention or archival rule applies to
Offer versions in this phase.

## 3. Version identity, and the 0M.7 Listing dependency

`@@unique([offerSourceRecordId, sourceRecordVersion])` is the durable key that
names one exact accepted Offer version.

A `0M.7` promoted Listing must bind to an exact accepted Offer source version.
That binding is possible today, through this key alone, **without** depending on:

- mutable current Offer state — `getSourceVersion` names the version explicitly
  and is answered from immutable history, so the answer does not move when the
  Offer is repriced;
- capsule hashes — no capsule is involved in the binding;
- external AgentNet publication — none exists;
- reconstructed in-memory fixtures — the row is the record.

Version labels are **caller-supplied**, matching the Product and Storefront
convention: a service that invented one would make two concurrent writers agree
by accident. A label mints once, enforced by the unique index rather than by a
read-then-write check.

**No Listing persistence is implemented here.** This phase only guarantees that
the identity `0M.7` will need already exists and is stable.

## 4. Product relationship

An Offer names a persisted `Product` through the authoritative
`internalProductId`, on both the stable row and every version row.

It **restates no Product descriptive fact** — that is ADR §2 authority
partitioning, and the Product/Offer boundary ADR §10.2 drew: price, currency,
availability, and checkout eligibility belong to the Offer; descriptive facts
belong to the Product. No second Product record and no second Product ownership
model is introduced.

`hasProductAuthority` is **supplied to the service, never derived.** `0M.2A` is
explicit that authority over a Product is the Product model's question, and
re-deriving it inside an Offer decision would put two answers in the repository
that could disagree.

## 5. Participant authority, and the creator-Node boundary

Offer authority is `sellerParticipantId`, referencing `MarketplaceParticipant`.

**No ambiguity between creator-Node authority and persisted Participant
authority was found, and none was invented.** The `0M.2A` source model is
unambiguous on this point: authority is transactional
(`sellerParticipantId`), and "no Creator Node or other public semantic identity
appears in this phase; that mapping is deliberately unresolved." The
`authorityNode` that appears in the `0M.2B` projection context is a **supplied
public binding**, checked against `sellerParticipantId` and then discarded — it
is validation input to the projection and never a persisted fact. Persistence
therefore stores the participant and nothing else, and the approved boundary is
preserved rather than bridged.

No Seller or Creator table is introduced. The single neutral Participant
identity with additive roles, settled in `0M.5`, is used unchanged.

Authority is never inferred from Account ownership: the acting account is
resolved to a `MarketplaceSubject` through the existing `0M.5` machinery, and
every gate is `0M.2A`'s own.

## 6. Offer identity

`internalOfferId` is `mon:offer:<opaque>`, minted from `crypto.randomBytes` over
the Crockford alphabet — the same construction as participant, account, and
Storefront identity.

It encodes **no business fact**: not the Product, the seller, the price, the
currency, the commission, or the lifecycle. An Offer whose price changed — which
is the ordinary case, and the reason versions exist — would otherwise carry a lie
in its own identifier.

`mon:offer:` is internal and is **never an AgentNet Node.** A Node is
Registrar-issued in a later phase and is never derived from this value. Stable
internal identity and future Node identity stay separate by construction.

## 7. Economic fields, and the invariants that hold

Persisted, because each is a member of the `0M.2A` source version:

| Fact | Storage |
| --- | --- |
| Price discriminator | `priceType` — `FREE` \| `PAID`, NOT NULL |
| Wholesale price | `wholesalePriceMinorUnits` `BIGINT` (PAID only) |
| Wholesale currency | `wholesalePriceCurrency` `VARCHAR(3)` (PAID only) |
| Promotion discriminator | `promotionType` — `NOT_PROMOTABLE` \| `PROMOTABLE`, NOT NULL |
| Commission method | `commissionMethod` — `PERCENT_OF_WHOLESALE` \| `FIXED_AMOUNT` |
| Percentage rate | `commissionBasisPoints` `INT` |
| Fixed amount + currency | `fixedCommissionMinorUnits` `BIGINT`, `fixedCommissionCurrency` |
| Accepted economics | `calculatedCommissionMinorUnits`, `calculatedCreatorGrossProceedsMinorUnits`, `commissionCalculationPolicyVersion` |

**`wholesalePriceMinorUnits` is what the creator/seller is owed before promoter
commission** — never what a buyer pays. Promoter commission is seller-funded, and
creator gross proceeds are wholesale minus commission.

**Economics are computed, never accepted as input.** `calculateOfferEconomics`
produces them from the terms; the service persists the result. Accepting them
would let a caller store numbers the deterministic calculator never produced.
They are **stored rather than recomputed on read**, because `0M.2A` requires the
exact numbers the creator was shown to be reproducible rather than recalculated
under whatever policy is current later. The contract re-checks them against the
calculator on the way out, so a drifted row fails loudly.

Every invariant is the contract's, enforced at the persistence boundary and
tested: positive integer minor units; three-uppercase-letter currency
(structural, not an ISO 4217 registry); commission basis points bounded 1–10 000;
a fixed commission in the same currency as the wholesale price and not exceeding
it; a `FREE` Offer refused promotion because there are no proceeds to pay from;
half-up rounding to the minor unit under `WHOLESALE_COMMISSION_V1`; and the
lifecycle transition table.

**Not stored, and not by omission:** promoter retail price, promoter retail
spread, Monacado retained amount, MoR wholesale-acquisition amount, minimum
viable price, platform or processing fees, earned commission, tax, and shipping.
Retail price belongs to a Listing; Monacado's retention belongs to the versioned
policy `0M.R` supplies per transaction. An Offer asserting either would assert a
number its own authority never agreed to. **Monacado's 92.5%/−$1.00 retail policy
is hard-coded nowhere in this phase**, and a test asserts its absence.

## 8. Authorization

Every decision is `0M.2A`'s own — `canCreateDraftOffer`, `canChangeOfferTerms`,
`canActivateOffer`, `canResumeOffer`, `canSuspendOffer`, `canEndOffer`,
`canWithdrawOffer`. The service assembles the facts they need and honours the
answer; there is no parallel Offer authorization system, because a second copy of
an authorization rule is a second rule.

A lifecycle move is governed by the capability **for that move**. Standing an
Offer down deliberately does not require payment readiness: a seller whose
payment capability was just restricted must still be able to stop selling, and
requiring an intact commerce gate to stop would trap the seller who most needs
to.

Refusals carry the bounded reason codes those decisions produce — never free
text, never a private value, and never an amount.

### This phase is draft-capable only, and structurally so

`0M.2A` gates activation and resumption behind the full commerce test. This phase
fails it twice over:

- `participant.status !== ACTIVE` → `PARTICIPANT_NOT_ACTIVATED`. Reaching
  `ACTIVE` is a governed activation decision, and `0M.5` makes none.
- `paymentReadiness !== ENABLED` → `PAYMENT_NOT_ENABLED`, behind it. No payment
  record exists until `0M.8`, so materialized readiness is always `NOT_STARTED`.

**That is the contract working, not a gap to route around.** The service supplies
no override, and weakening either gate to make an Offer activate would let an
unactivated, unpayable seller sell. `0M.6` is draft-capable only, exactly as
`0M.5` was, and for the same reason. The state `0M.8` will produce is exercised
in tests by seeding a row directly — a fixture for the read path, never a way in
through the write path.

## 9. Privacy

No buyer datum, private profile field, payment credential, banking detail,
underwriting datum, tax evidence, risk classification, payout hold, settlement
record, or card-network datum exists on either table. `NEVER_ON_OFFER_RECORD`
enumerates them, every input schema is strict, and tests assert both the refusal
and the absence of the columns.

The authorization trace records an **opaque** `mon:actor:` identifier — never an
email address or a display name.

## 10. Foreign keys and delete behaviour

**Six foreign keys. All `RESTRICT`. No `CASCADE` anywhere**, and none was
required:

| From | To | Rule |
| --- | --- | --- |
| `Offer.internalProductId` | `Product` | RESTRICT |
| `Offer.sellerParticipantId` | `MarketplaceParticipant` | RESTRICT |
| `OfferSourceRecordVersionRow.internalOfferId` | `Offer` | RESTRICT |
| `OfferSourceRecordVersionRow.internalProductId` | `Product` | RESTRICT |
| `OfferSourceRecordVersionRow.sellerParticipantId` | `MarketplaceParticipant` | RESTRICT |
| `OfferSourceRecordVersionRow.authorizedBySellerParticipantId` | `MarketplaceParticipant` | RESTRICT |

An Offer is a standing commercial commitment and its versions are immutable
history. Deleting the Product it is for, the participant that authored it, or the
Offer beneath its own history is refused by the database. No destructive cleanup
behaviour was introduced for test convenience.

## 11. Transactionality

Creating a new source version and advancing the stable pointer happen in **one
transaction**, so the database cannot hold:

- a stable Offer pointing at a version that does not exist;
- partially created version history;
- a pointer advance without a corresponding immutable source row.

Reading back a stable record whose pointer names no version raises
`CorruptOfferRecordError` rather than returning half an Offer — the write path
makes the state impossible, and the read path refuses to paper over it.

## 12. Exact source reconstruction

`versionRowToSourceVersion` is total and lossless: every contract member has
exactly one column or flattened group, and every column has exactly one member.
A malformed row raises a bounded `CorruptOfferRecordError` naming field paths
only — never a best-effort object, because corrupt authoritative state must not
flow into a capsule projection.

Three mappings carry the weight:

1. **Discriminated unions** are rebuilt *from* the discriminator column, so an
   arm value can never be read under the wrong arm. A `FREE` Offer reconstructs
   with no amount field at all — absence by construction, matching the contract,
   and its columns are written as explicit `NULL` so a repriced version cannot
   leave a stale price behind.
2. **Money** is `BIGINT` in MySQL and `number` in the contract. A value outside
   `Number.MAX_SAFE_INTEGER` is refused as corruption rather than silently losing
   precision.
3. **The effective interval** is two nullable columns, and both-`NULL` means "no
   interval" unambiguously, because the contract refuses an interval whose bounds
   are both null. One fact, one representation — which is what stops a read from
   minting a spurious material change.

`null` versus absent, currency, integer minor units, the commission
discriminator and value, the Product and authority relations, lineage, recorded
timestamps, and the authorization trace all round-trip exactly.

**One normalization is worth naming:** instants are stored as `DATETIME(3)` and
read back as millisecond-precision UTC ISO-8601. The round-trip is exact for
canonical millisecond instants, which is what the service writes and what the
existing Storefront and publication tables already do. A caller supplying
`...T00:00:00Z` reads back `...T00:00:00.000Z` — the same instant, canonically
spelled.

## 13. Projection compatibility

A reconstructed persisted source version feeds `projectOfferCapsule` unchanged.
No capsule semantics were altered, and no contradiction was exposed.

The integration suite proves the equality that matters: a capsule projected from
a **persisted** source version is byte-identical, under canonical JSON, to one
projected from an **independently constructed** canonical in-memory source with
the same values under the same context. The projection can no longer tell whether
its source came from the database or from a fixture.

A `DRAFT` Offer is correctly **not** projection-eligible (`DRAFT_NOT_PUBLIC`),
and persistence does not change that.

Node bindings in tests are **synthetic and test-only**. This phase issues no
Node, registers nothing, and creates no publication, outbox, or receipt row.

## 14. Service operations

All in `src/server/marketplace/offer-service.ts`. No HTTP route, no UI, no global
Prisma access inside contract code, and dependency injection consistent with the
Product, Participant, and Storefront server modules — the database, identity
provider, and every instant are injected, and nothing reads a clock, generates
randomness directly, or touches `process.env`.

| Operation | Behaviour |
| --- | --- |
| `createDraftOffer` | Creates the Offer and its first version, `DRAFT` + `AVAILABLE`, in one transaction |
| `getOffer` | Stable record plus current source version |
| `getCurrentSourceVersion` | The current authoritative version — what a future publication phase hands to the projection |
| `getSourceVersion` | One **exact** historical version, never "the latest" |
| `listSourceVersions` | Every version, oldest first, in deterministic creation order |
| `createOfferSourceVersion` | Mints a new immutable version from an authorized material change |
| `evaluateOfferState` | Commercial selectability via `0M.2A`'s own two-axis rule |

An update that changes nothing material raises `NoMaterialOfferChangeError`
rather than minting a version that asserts nothing.

## 15. Deferred

Not implemented, and named rather than silently omitted: Listing persistence
(`0M.7`); Offer AgentNet Node issuance, publication, Registrar registration, and
Resolver integration; participant Node and capsule; payment-provider onboarding
and Stripe (`0M.8`); checkout, Order, settlement, payout, and chargebacks
(`0M.9`); risk management (`0M.R`); tax, shipping, and the MoR transaction ledger
(`0M.T`); notification records (`0M.N`); HTTP routes and UI.

## Reference

- [`AUTHORITATIVE_OFFER_SOURCE_MODEL.md`](AUTHORITATIVE_OFFER_SOURCE_MODEL.md)
- [`OFFER_CAPSULE_PROJECTION_SHAPE.md`](OFFER_CAPSULE_PROJECTION_SHAPE.md)
- [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md)
- [`STOREFRONT_PERSISTENCE.md`](STOREFRONT_PERSISTENCE.md)
- [`PARTICIPANT_PERSISTENCE.md`](PARTICIPANT_PERSISTENCE.md)
- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
- [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md)
