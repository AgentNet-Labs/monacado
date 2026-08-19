# Listing Persistence (Phase 0M.7)

The authoritative Listing record, its immutable source-record versions, and the
narrow service over them — the **last** missing middle stage in the marketplace's
persistence chain.

With this phase the declared pipeline

```
AUTHORITATIVE_SOURCE_MODEL → AUTHORITATIVE_SOURCE_VERSION
  → PROJECTION_MAPPING → CAPSULE_PROJECTION_SHAPE → CAPSULE_PROJECTION
```

has its second stage for **every publishable entity**. A persisted Listing source
version now feeds the existing capsule projection directly and produces a capsule
byte-identical to the equivalent canonical in-memory source.

**This phase adds no Listing fact and no economic rule.** `0M.4A` remains the
authority on what a Listing is and how its economics reconcile; `0M.7` stores
exactly that and nothing more.

---

## 1. Stable Listing versus immutable source versions

Two tables, mirroring the Product, Storefront, and Offer pattern.

**`Listing`** is the enduring identity: `internalListingId`, the constant
`listingSourceRecordId`, the `currentSourceRecordVersion` pointer, the three
placement references, and denormalized `listingType` and `lifecycle` for
querying. The denormalized copies move with the pointer inside the same
transaction and are never an independent truth.

**`ListingSourceRecordVersionRow`** holds complete, immutable snapshots. A
material change inserts a new row; **no historical row is ever updated in
place.** Each snapshot carries every material field rather than a delta.

`@@unique([listingSourceRecordId, sourceRecordVersion])` — a version label mints
once, enforced by the index rather than by a read-then-write check. Version
labels are caller-supplied, matching every prior entity.

## 2. SELLER_DIRECT versus PROMOTED

The discriminated union is **preserved, not collapsed**. `listingType` is the
NOT NULL discriminator; each branch's fields are nullable columns read only when
the discriminator selects them, and the mapper rebuilds the union *from* the
discriminator. A `SELLER_DIRECT` row reconstructs with no `offerDependency` field
at all, and a `PROMOTED` row with no `sale` field — the structural impossibility
`0M.4A` designed, carried intact through storage.

Both branches carry an ordinary commercial retail price. Neither branch acquires
the other's fields, and a version that changes branch writes the vacated arm as
explicit `NULL` so no residue survives.

## 3. Product relationship

Every Listing references a persisted `Product` through `internalProductId`, on
both the stable row and every version row, **RESTRICT** on each.

No Product descriptive fact is duplicated — a Listing places a Product; it does
not restate one (ADR §2). Product availability is a *supplied* input to buyer
eligibility, never read here: it is the Product model's question, and this phase
adds no second answer.

## 4. Storefront relationship

Every Listing references a persisted `Storefront` through `storefrontId`, on both
tables, **RESTRICT** on each.

**No reverse Listing array or column is added to the Storefront.** `0M.3A` is
explicit that Listings reference Storefronts and never the reverse. The Prisma
back-relation on `Storefront` is a required virtual field, not a column — a test
asserts the Storefront tables gain no `internalListingId`, no retail price, and
no listing count. Storefront presentation facts are not duplicated; Storefront
remains independent authority.

## 5. Controller Participant relationship

`controllingParticipantId` references `MarketplaceParticipant` on both tables,
plus `authorizedByParticipantId` on the version row — all **RESTRICT**.

The branch decides which role the controller must hold: **SELLER** for
`SELLER_DIRECT`, **PROMOTER** for `PROMOTED`. There is **no Seller table and no
Promoter table** — roles stay additive assignments on the single neutral
participant identity settled in `0M.5`.

Authority is never inferred from Account ownership: the acting account is
resolved to a `MarketplaceSubject` through the existing `0M.5` machinery, and the
subject must additionally *be* the controlling participant.

## 6. The exact accepted Offer source-version binding

This is the centre of the phase.

A promoted Listing binds **one exact persisted `OfferSourceRecordVersionRow`**,
through a **composite foreign key** onto the
`(offerSourceRecordId, sourceRecordVersion)` unique key `0M.6` established:

```prisma
acceptedOfferVersion OfferSourceRecordVersionRow? @relation(
  fields:     [acceptedOfferSourceRecordId, acceptedOfferSourceRecordVersion],
  references: [offerSourceRecordId, sourceRecordVersion],
  onDelete:   Restrict)
```

That makes three guarantees structural rather than merely procedural:

- a promoted Listing **cannot** name an Offer version that does not exist — the
  database refuses the row;
- the accepted version **cannot be deleted** while a Listing depends on it;
- the binding **never follows the Offer's current-version pointer**, because it
  names a version label rather than reading the stable Offer row.

Both columns are `NULL` for `SELLER_DIRECT`, and MySQL's MATCH SIMPLE semantics
leave that branch unconstrained by the composite key.

The accepted wholesale price, currency, and commission-policy version are read
**from the persisted Offer version**, never from the caller: a caller-supplied
number could disagree with the Offer actually accepted, which is precisely the
divergence the exact binding prevents. The service also confirms the Offer is for
the same Product the Listing places.

### When the Offer advances

**Nothing happens to the Listing.** It remains bound to the version it accepted.
A promoter agreed to a number, and a new number is a new agreement.

The accepted binding moves **only** when a caller explicitly names a different
exact version in an update. There is no "rebind to current" flag and no code path
that upgrades an accepted version by observing a newer one. Prior Listing
versions continue to record what was originally accepted.

## 7. Retail price and the scheduled sale

The commercial retail price is persisted as an authoritative Listing fact in
integer minor units with the contract's currency rules. It is the **merchandise
price alone**.

The `SELLER_DIRECT` sale schedule persists all four fields — price, currency,
inclusive start, exclusive end — **all present or all NULL**, mirroring the
contract's single nested object. `0M.4A`'s cross-field rules hold at the
persistence boundary: same currency as ordinary retail, strictly lower, and end
after start.

**The ordinary retail price is never overwritten while a sale runs**, so the
price to return to still exists when the window closes.

### Nothing derived from a clock is stored

There is no `currentPrice`, `effectivePrice`, `pricedAt`, or `saleIsActive`
column. The effective price is computed by `0M.4A`'s own
`effectiveSellerRetailPrice` from the persisted schedule plus a **supplied**
instant.

The consequence is the point: **a Listing needs no database write when a sale
reaches its start or its end.** An integration test crosses all four boundaries —
before, at the inclusive start, mid-window, and at the exclusive end — and asserts
that every version row and the stable row are byte-identical afterwards, with no
new version minted.

## 8. MoR economics boundary

**No derived economics are persisted.** There is no column for Monacado's
retained amount, the MoR wholesale-acquisition amount, seller proceeds, promoter
retail spread, promoter net proceeds, promoter margin rate, the seller-funded
commission, or the minimum viable retail price.

Each is computed by `0M.4A` from three inputs: the Listing's commercial retail
price, the accepted Offer source version, and a **supplied** versioned Monacado
wholesale-acquisition policy. A stored copy would be a second answer that goes
stale the moment any input moves.

The acquisition policy is supplied per call and **never persisted** — a
commercial decision must not become stored state or a code constant. `0M.R` will
own choosing it. **Monacado's 7.5% + $1.00 retail policy is hard-coded nowhere**
in this phase, asserted by test; the integration suite uses a deliberately
synthetic policy.

### Promoted viability

At creation, and at any update that reprices or rebinds with a policy supplied,
the service calls `calculatePromotedListingEconomics` and maps its bounded
refusal codes onto a persistence error. **The formula is not reproduced** — the
contract throws `NEGATIVE_PROMOTER_PROCEEDS`, and the result is discarded because
it is a check, not a stored fact.

A test computes the exact threshold with `minimumViablePromotedRetailPrice`,
confirms that **one minor unit below it is refused**, and that the minimum itself
is accepted.

## 9. Tax, shipping, and JIT inventory boundaries

No transaction tax, VAT, GST, shipping, freight, delivery, or checkout total is
persisted as Listing economics, and no column exists for any of them. The
business rule is unchanged:

```
commercial retail price + transaction tax + shipping = later checkout amount
```

Tax and shipping stay outside Monacado's retention basis, the MoR acquisition
basis, the Offer commission, and the promoter's retail margin.

**JIT Monacado Inventory remains the commercial model, not an operation.** This
phase persists the commercial Listing facts and nothing else: no physical
custody, warehouse inventory, fulfillment orchestration, shipping-label workflow,
supplier payout, or transaction-time acquisition ledger. No transaction exists in
`0M.7`, so the acquisition operation is not built.

`0M.T` owns tax and MoR transaction accounting; `0M.9` owns checkout.

## 10. Authorization

Every decision comes from the **existing** `0M.1` capability vocabulary, fed a
`MarketplaceSubject` materialized from persisted account, participant, role, and
entitlement rows. There is no parallel Listing permission model.

- `SELLER_DIRECT` → `canCreateSellerDirectListing`, emitting
  **`listing:seller_direct:create`** (requires **SELLER**)
- `PROMOTED` → `canCreatePromotedListing`, emitting
  **`listing:promoted:create`** (requires **PROMOTER**)

A capability decision answers *"may this kind of participant do this kind of
thing"*; it does not answer *"is this that participant"*. Both are required, so
the service additionally requires the subject to **be** the controlling
participant — conflating the two would let any promoter edit any other's Listing.

Refusals carry the closed `CapabilityReasonCode` vocabulary — never free text,
never a private value, never an amount.

> ### The seller-direct capability was added in this phase
>
> `0M.1`'s `MARKETPLACE_CAPABILITIES` originally contained
> `listing:promoted:create` and **no seller-direct counterpart** — the vocabulary
> predates `0M.4A` splitting Listings into two branches, so it named only the
> promoted half. An early draft of this phase worked around the gap by reusing
> `canCreateDraftProduct`, which has the right gate but the wrong meaning.
>
> That coupling is now corrected. `0M.7` adds
> **`listing:seller_direct:create`** to the authoritative vocabulary — thirteen
> members, still closed — together with `canCreateSellerDirectListing`, which
> applies the same drafting gate the promoted decision uses, against the SELLER
> role.
>
> **Product drafting and Listing creation are distinct authorization concerns.**
> Authoring a Product's authoritative facts and placing a Product for sale are
> different acts. `product:draft:create` governs the former and nothing else; its
> semantics are unchanged, the two capability strings are never aliased, and
> Product creation depends on no Listing capability. One capability answering
> both questions would mean a future change to either rule silently moved the
> other.
>
> Nothing else in the authorization model changed: the same drafting gate, the
> same closed reason-code vocabulary, and the same separate check that the
> subject *is* the controlling participant.

## 11. Lifecycle and buyer-active gating

A Listing is created `DRAFT`; going live is a separate act, checked against
`0M.4A`'s own transition table.

**Buyer-active is derived, never stored.** `evaluateListingBuyerEligibility`
computes it from the Listing, Product availability (supplied), Storefront
exposure, controller status, controller role status, and — for promoted Listings
— the accepted Offer version's own commercial state. Every failing condition is
reported, not just the first.

**Expect `buyerActive: false` through `0M.7`, and that is correct.** A drafting
participant is not `ACTIVE`, and a draft Storefront is not publicly accessible.
Nothing here bypasses those gates to make a test pass; Listings persist while
remaining non-purchasable until `0M.8` and later phases supply the missing state.
No checkout capability is added.

## 12. Transactionality

Creating a Listing (or a new version) and advancing the stable pointer happen in
**one transaction**, so the database cannot hold a pointer without a version,
partially created history, a pointer advance without a row, or a promoted Listing
referencing a nonexistent Offer version. The Offer-version read and the
Product-agreement check happen inside the same transaction as the write.

Reading back a stable record whose pointer names no version raises
`CorruptListingRecordError` rather than returning half a Listing.

## 13. Foreign keys and delete behaviour

**Ten foreign keys. All `RESTRICT`. No `CASCADE` anywhere**, and none was
required:

| From | To | Rule |
| --- | --- | --- |
| `Listing.internalProductId` | `Product` | RESTRICT |
| `Listing.storefrontId` | `Storefront` | RESTRICT |
| `Listing.controllingParticipantId` | `MarketplaceParticipant` | RESTRICT |
| `…VersionRow.internalListingId` | `Listing` | RESTRICT |
| `…VersionRow.internalProductId` | `Product` | RESTRICT |
| `…VersionRow.storefrontId` | `Storefront` | RESTRICT |
| `…VersionRow.controllingParticipantId` | `MarketplaceParticipant` | RESTRICT |
| `…VersionRow.authorizedByParticipantId` | `MarketplaceParticipant` | RESTRICT |
| `…VersionRow.acceptedInternalOfferId` | `Offer` | RESTRICT |
| `…VersionRow.(acceptedOfferSourceRecordId, acceptedOfferSourceRecordVersion)` | `OfferSourceRecordVersionRow` | RESTRICT |

Deleting a Product, Storefront, participant, Offer, accepted Offer version, or a
Listing beneath its own history is refused by the database.

## 14. Exact source reconstruction

`versionRowToSourceVersion` is total and lossless; a malformed row raises a
bounded `CorruptListingRecordError` naming field paths only. There is **no
best-effort repair** — corrupt authoritative state must not reach a projection.

Three all-or-none rules carry the weight:

1. **The discriminator drives the branch.** An unrecognised value falls through
   to the contract, which refuses it rather than guessing.
2. **The sale arm is all four columns or none.** A partial arm is corruption, not
   a sale with defaults — a repaired sale would misprice.
3. **The Offer binding is all seven columns or none.** A partial binding cannot
   say which version the promoter accepted, and there is no safe fallback:
   reading "the current Offer" would bind terms nobody agreed to.

Money stays exact — `BIGINT` values outside `Number.MAX_SAFE_INTEGER` are refused
rather than rounded. Instants normalize to canonical millisecond UTC ISO-8601, as
in every prior phase.

## 15. Projection compatibility

A reconstructed persisted version feeds
`listingSourceRecordToCapsuleProjection` unchanged. **No capsule semantics were
altered**, and no contradiction was exposed.

- `SELLER_DIRECT` publishes a self-describing price: base price **and** the sale
  schedule, so the capsule stays semantically correct as time advances and **no
  publication is required merely because a sale starts or ends**.
- `PROMOTED` publishes base retail only.
- Neither emits `currentPrice` or `pricedAt`.

A test proves a capsule from the **persisted** source is byte-identical under
canonical JSON to one from an **independently constructed** canonical source
under the same context.

### The public Offer-reference privacy rule

**A promoted Listing capsule publishes no Offer reference, and this phase keeps
it that way.** `0M.4B` made the decision deliberately: the Offer capsule
publishes its own wholesale price, so a reference would let a consumer subtract
it from the published retail price and recover the promoter's spread. *A
reference that discloses by composition discloses just the same.*

A test asserts the projected promoted capsule contains no Offer source-record id,
no Offer Node, no wholesale figure, no commission, and none of the seller,
promoter, or Monacado economics — while the promoter's own retail price, which is
what a buyer pays, is public.

## 16. Test isolation

The integration suite cleans up **only its own fixtures**, matched by a
`mon:product:M7PR0D…` prefix and a `listing-ctl…` email prefix. There is no
global `product.deleteMany({})` or equivalent against Product, Storefront,
Participant, Account, or publication tables.

`0M.6` exposed why that matters: other suites' Products are referenced by their
Nodes, publications, and outbox rows, so a blanket delete hits the very RESTRICT
rules these phases rely on. The suite was verified **alone, inside the full DB
integration suite, and across repeated consecutive runs**.

## 17. Deferred

Not implemented, and named rather than silently omitted: Listing AgentNet Node
issuance, publication, Registrar registration, and Resolver integration; Offer
publication; payment-provider onboarding and Stripe (`0M.8`); checkout, Order,
settlement, payout, refunds, and chargebacks (`0M.9`); tax calculation and the
MoR transaction ledger (`0M.T`); shipping execution and fulfillment; the
risk-management engine (`0M.R`); participant capsule; HTTP routes and UI.

## Reference

- [`LISTING_SOURCE_MODEL.md`](LISTING_SOURCE_MODEL.md)
- [`LISTING_CAPSULE_PROJECTION.md`](LISTING_CAPSULE_PROJECTION.md)
- [`OFFER_PERSISTENCE.md`](OFFER_PERSISTENCE.md)
- [`STOREFRONT_PERSISTENCE.md`](STOREFRONT_PERSISTENCE.md)
- [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md)
- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
- [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md)
