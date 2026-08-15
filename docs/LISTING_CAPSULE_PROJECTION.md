# Listing Capsule Projection Shape (Phase 0M.4B)

The deterministic public projection of an authoritative Listing source version,
on the terms 0M.2B and 0M.3B established for the Offer and the Storefront.

**Contract-only.** No Listing persistence, no AgentNet Node, no publication, no
checkout, no tax, no shipping, no fulfillment, no route, no UI.

## 1. Authoritative source → public projection

```
ListingSourceVersion  →  recorded projection context  →  projection mapping
                      →  Listing Capsule Projection Shape
                      →  (future) capsule finalization and publication
```

The **Listing source record remains authoritative** (ADR §12). The projection
asserts nothing the database does not already hold, creates no provenance,
authorizes no business change, and cannot be written back.

Enforced structurally: the mapper takes **one explicitly identified
`ListingSourceVersion`** — no "current record", no "latest", no repository;
**there is no inverse function** anywhere, asserted by test; and it **never
mutates its inputs**, asserted on both the source version and the context.

## 2. The public claim set

`data` carries exactly three top-level members — `listingType`, `price`, and
`relationships` — declared once in `PUBLIC_LISTING_CAPSULE_FIELDS`, with the
price members declared alongside them:

| Public term | Source | Notes |
| --- | --- | --- |
| `listingType` | `placement.listingType` | `SELLER_DIRECT` or `PROMOTED` |
| `price.basePrice` | placement retail price | integer minor units, ordinary price |
| `price.priceCurrency` | placement retail currency | schema.org, reused |
| `price.sale.salePrice` | seller sale schedule | seller-direct only, optional |
| `price.sale.validFrom` | `saleStartsAt` | inclusive, schema.org term reused |
| `price.sale.validThrough` | `saleEndsAt` | exclusive, schema.org term reused |
| `relationships.offeredProduct` | context binding | Product Node |
| `relationships.listedInStorefront` | context binding | Storefront Node |
| `relationships.operatedBy` | context binding | controller's authority Node |

`data` is **structurally discriminated by `listingType`**: the promoted branch's
price schema has no `sale` member at all.

`metadata` reuses the shared envelope unchanged: `capsuleId`, `bindsToNode`,
`version`, `provenance`, `nodePolicy`, `capsulePolicy`, `contentHash`.
`publishedBy`, `publishedAt`, `supersedes`, and `revokes` are absent — publication
facts, and this phase publishes nothing.

**The allow-list is the privacy boundary.** A field absent from it has no schema
member, no mapper branch, and no way into the artifact. Three tests keep it
honest: it must equal the schema's keys, equal the keys a projection actually
emits, and **every authoritative Listing fact must carry an explicit
disposition** — projected, derived, consumed as a binding, or deliberately
excluded. Nothing can be silently forgotten.

## 3. Seller-direct versus promoted public semantics

`listingType` is published because "you are buying from the creator" and "you are
buying from a reseller" are materially different facts to a buyer, and both are
already authoritative. It discloses nothing about the commercial arrangement
behind a resale.

Beyond that, the two differ in exactly one place: **the price shape** (§4). A
seller-direct price may carry a sale schedule; a promoted price has no member for
one. That is what makes "a promoted capsule never carries sale fields" true by
construction rather than by a rule.

## 4. Public price semantics

The public price is **self-describing with respect to the seller's authoritative
pricing instructions**, and is structurally different for the two Listing types.

**Seller-direct** publishes the ordinary commercial price and, when the seller
scheduled one, the complete sale schedule:

```
price = { basePrice, priceCurrency, sale?: { salePrice, validFrom, validThrough } }
```

**Promoted** publishes the promoter-controlled retail price alone:

```
price = { basePrice, priceCurrency }
```

The promoted branch has **no `sale` member**, so a seller's ordinary price, sale
price, and sale window cannot appear on a promoted capsule — structurally, not by
a rule. The two branches read different fields of a discriminated union and
produce differently-shaped output.

### Why the schedule is published rather than a time-selected price

A scheduled sale is an **authoritative seller pricing instruction**. The seller
decided it; it is exactly the kind of fact a buyer-facing artifact should carry,
and it is not private workflow state.

Publishing it — rather than a single `currentPrice` selected at projection time —
gives three properties:

- **The capsule stays semantically correct as time advances.** One artifact, one
  content hash, correct on both sides of every sale boundary.
- **No publication event is required merely because a sale starts or ends.** A
  time-selected price would go wrong the moment a boundary passed, obliging a
  publication pipeline to republish because the clock moved rather than because
  anything changed. **There is no sale-boundary regeneration obligation.**
- **Consumers derive the effective price deterministically** from the published
  schedule and their own current time, all of them the same way.

The capsule re-validates the source's own sale invariants rather than trusting
them: a sale price at or above the ordinary price, an inverted window, or a
partial schedule are all refused at the projection boundary.

**Tax and shipping are not in any of these prices** — see §6.

## 5. Sale timing

Unchanged from the source model, and re-asserted at the projection boundary: UTC
instants, **start inclusive, end exclusive**. The published `validFrom` /
`validThrough` carry those semantics to consumers.

`effectivePublicListingPrice` is offered as a pure derivation helper — it takes a
**published** price and a caller-supplied instant and returns the effective
price, so every consumer resolves the boundary identically. It reads no clock,
mutates nothing, and works in integer minor units. **Its result is not a capsule
field**: storing it would reintroduce exactly the time-dependent value this shape
exists to avoid. The tests check the boundary at exactly the start, one
millisecond before it, exactly the end, and one millisecond before that.

The projection needs **no pricing instant at all**. `pricedAt` was removed from
the projection context when the schedule became public: nothing in the mapping
depends on when it ran. `generatedAt` remains, and is provenance and generation
metadata only — moving it across a sale window changes no published price, which
a test asserts.

## 6. Tax and shipping exclusion

The public price is the **merchandise or service commercial price alone**. Not
published, and having no field to be published through:

- calculated sales tax, VAT, GST;
- shipping, freight, delivery, fulfillment charges;
- checkout total.

A later checkout may add those amounts to a buyer's total; doing so changes
nothing about this number. No tax or shipping calculation exists in this phase —
that is `0M.T`.

## 7. MoR and private economics exclusion

**None of Monacado's commercial economics reaches the capsule.** Not published:

- the Monacado retained amount, retained percentage, or retained fixed amount;
- the MoR wholesale acquisition amount;
- the wholesale-acquisition policy id or version;
- the minimum viable promoted retail price;
- seller proceeds, promoter net proceeds, promoter retail spread, promoter margin
  rate.

These are **settlement facts, not buyer-facing semantics**. A buyer needs the
price; what each party nets from it is between those parties and Monacado.

Nor does any Offer internal reach it: not the accepted wholesale price, the
seller-funded commission, the accepted source-record version, or the review
state. The mapper never reads `placement.offerDependency` at all.

`NEVER_IN_LISTING_CAPSULE` names every one of these so a test can assert each is
refused as a data key. That is a backstop; the allow-list is the boundary.

### Ruling — a promoted Listing capsule does not identify its Offer

**Binding.** A promoted Listing capsule does **not** directly identify its
accepted Offer, by Node reference or otherwise.

**Reason.** The Offer capsule publishes its own wholesale economics. A direct
link from a promoted Listing's public retail price to that Offer would let any
consumer holding both capsules subtract one public number from the other and
recover the **promoter's retail spread** — which, with settlement economics
generally, is intentionally non-public (§7). **A reference that discloses by
composition discloses just the same.** This is the kind of leak that is invisible
when each capsule is reviewed alone.

**What this does not weaken.** The Listing *source* record still binds the exact
accepted Offer source-record version, privately and immutably
(`AcceptedOfferDependency`). Transactional provenance is unaffected: the
authoritative chain from Listing version to Offer version is intact and
auditable. Only the *public* artifact omits it.

**How it could change.** Only through a deliberate semantic and privacy decision,
accompanied by a Listing capsule version change. It is not an implementation
detail to be revisited casually.

## 8. Identity and Node binding

Every public relationship is a **Registrar-issued ANS Node supplied by the
context**. Nothing is fabricated, and a test asserts every `an:node:` value in the
capsule came from the context.

Each binding pairs the public Node with the internal identifier it stands for —
`listingNode`/`internalListingId`, `productNode`/`internalProductId`,
`storefrontNode`/`storefrontId`, `controllerAuthorityNode`/`controllingParticipantId`.
The mapper **proves each pairing against the source version**, then discards the
internal half: it is validation input and never reaches the capsule. Each
mismatch has its own bounded error code.

`mon:listing:`, `mon:product:`, `mon:storefront:`, `mon:offer:`, and `mon:mpart:`
never appear in a capsule. `mon:listing:` was **added to the shared
internal-identifier guard** by this phase — the guard only ever grows, since
adding a prefix strengthens every capsule that uses it.

## 9. Provenance

Mapped exactly from the source version, and **represented rather than created**:
`sourceClass`, `sourceSystem`, `sourceRecordType`, `sourceRecordId`,
`sourceRecordVersion`, `acquiredAt` ← `recordedAt`, `assertionKind: "Asserted"`,
`generatedAt` and `generatorVersion` from the context, `method:
governed-source-version-projection`.

`mon:srec:` appears in provenance and **only** there — the approved ANS §3 /
ADR §11.8 traceability pattern. It is refused everywhere in `data`.

The ANS distinction holds: the **source** is the factual authority, **Monacado**
is the Publisher (absent here because nothing is published), and the mapping
version records the operational generation.

**The authorization trace does not survive projection.**
`authorizedByParticipantId` and `authorizedByActorId` are never read, so no
mapping exists that could publish them.

## 10. Buyer-active eligibility

**Only a purchasable Listing projects at all** — the Storefront precedent, where
only a live Storefront does. A blocked Listing is refused with
`NOT_PROJECTION_ELIGIBLE`.

Eligibility is the **Listing source model's own** `evaluateListingBuyerEligibility`,
which defers in turn to the Storefront's accessibility helper and the Offer's
lifecycle. The projection carries no copy of those rules, and a test asserts it
does not reimplement them.

The refusal carries **one coarse reason, `NOT_BUYER_ACTIVE`**. The specific
reasons — which upstream entity is failing — are private operational detail;
surfacing them through the projection boundary would turn a public-facing failure
into a probe for a seller's account standing or a Storefront's approval state. A
caller entitled to the detail reads it from the source model directly.

Because only available Listings project, there is **no availability field** in
`data`: it would be a constant.

## 11. Deterministic mapping

Validate the source version → validate the context → prove all five bindings →
check the version pins → check eligibility → map → hash → **re-validate the
output**. Each step fails closed. The final output validation is what guarantees
no internal identifier reached the capsule through a field that accepts strings.

No clock, no randomness, no database, no network, no environment read — asserted
by source scan over both modules. Same source version + same context ⇒
byte-identical capsule and identical content hash; key insertion order in either
input is irrelevant because hashing runs over canonical JSON.

Pinned at capsule `1.0.0` and mapping `listing-projection/1.0.0`. Product, Offer,
and Storefront versions are untouched.

`verifyListingCapsuleProjection` re-derives and compares, **recomputing** the
supplied capsule's content hash rather than trusting its stored one — otherwise a
capsule whose body was edited while its hash was left alone would verify.
`storedContentHashConsistent` reports that case separately.

## 12. Ontology and context

Six terms added, ontology and context together:

| Term | Source | Why |
| --- | --- | --- |
| `Listing` | monacado | schema.org has no term for a marketplace placement of one party's product in another's storefront |
| `listingType` | monacado | no schema.org equivalent |
| `basePrice` | monacado | schema.org `price` is a decimal; `mon:price` is already the Offer's price *container*, so reusing either would give one IRI two shapes |
| `salePrice` | monacado | same reasoning |
| `sale` | monacado | container for the published schedule |
| `offeredProduct` | monacado | distinct from `schema:itemOffered`, which names an *Offer's* Product |
| `listedInStorefront` | monacado | no schema.org equivalent |

`priceCurrency` is reused verbatim, and the sale interval reuses schema.org
`validFrom` / `validThrough` rather than minting `saleStartsAt` / `saleEndsAt` — a
sale is a price valid over an interval, which is exactly what those terms already
mean, and `validThrough`'s existing description is already the exclusive end this
model uses. `operatedBy` is reused with its description
generalized from "operates the storefront" to "operates the subject entity — a
Storefront, or a Listing"; the IRI and meaning are unchanged.

Ontology and context remain bidirectionally aligned at 63 terms;
`contracts:validate` runs 13 checks and the JSON Schema export produces 6.

## 13. Deferred

- **Listing persistence** — no Prisma model, migration, repository, or service.
- **Listing Node issuance** — the Node is a projection *input*. A future phase
  must decide what warrants one, and must not derive it from `mon:listing:`.
- **Publication** — no publication, outbox, receipt, reconciliation, or Registrar
  interaction. The projection stops at a validated, hashed artifact.
- **Checkout and transaction accounting** — tax, shipping, order records,
  settlement, refunds, and chargebacks are `0M.T`.
- **Risk** — `0M.R` may supply different commercial policy; none of it is public.

## 14. Relationship to the MoR business model

[`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md) is the
governing commercial description: Monacado is the retailer and Merchant of
Record, acquiring each item at the moment of sale under a versioned
wholesale-acquisition policy.

**This capsule is the buyer-facing half of that model, and only that half.** The
price a buyer sees is public; the acquisition amount, the retention, and every
party's proceeds are not. Section §L of that document requires it to be updated
before or with any material change to the MoR role, the wholesale formula, the
fee basis, economic responsibility, tax or shipping treatment, fulfillment,
settlement, or risk-policy application — and a change to what this capsule
publishes about price would be exactly such a change.

## Reference

- [`LISTING_SOURCE_MODEL.md`](LISTING_SOURCE_MODEL.md) — the 0M.4A source model this projects
- [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md) — the governing commercial model
- [`STOREFRONT_CAPSULE_PROJECTION.md`](STOREFRONT_CAPSULE_PROJECTION.md) — the 0M.3B pattern followed here
- [`OFFER_CAPSULE_PROJECTION_SHAPE.md`](OFFER_CAPSULE_PROJECTION_SHAPE.md)
- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
- [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) — binding ADR
- [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md)
