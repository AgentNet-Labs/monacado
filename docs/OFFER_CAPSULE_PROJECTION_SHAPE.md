# Offer Capsule Projection Shape (Phase 0M.2B)

Status: **binding** for the Offer projection. Subordinate to
[`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
(ADR §12) and [`AUTHORITATIVE_OFFER_SOURCE_MODEL.md`](AUTHORITATIVE_OFFER_SOURCE_MODEL.md).

Defines the strict deterministic **public representation** produced from one
explicitly identified immutable `OfferSourceVersion`.

**No persistence, publication, Node registration, Registrar interaction, route,
UI, Storefront, or Listing work is introduced by this phase.**

## 1. The database remains the sole source of Offer truth

This phase reads; it never writes. It:

- reads **one exact `OfferSourceVersion`**;
- validates projection eligibility;
- maps approved public claims;
- produces a strict Offer Capsule Projection;
- **represents** existing provenance;
- writes nothing back.

It creates no transactional fact, no authority, no provenance, no Node
registration, no publication state, and no source version.

```
OfferSourceVersion → recorded projection context → projection mapping
  → Offer Capsule Projection Shape
```

Prohibited, and structurally impossible rather than merely discouraged: reading
the current Offer record; querying "latest"; accepting an unidentified source
version; writing capsule data into transactional records; deriving authority from
capsule content; treating Registrar data as Offer truth; changing Offer terms
during projection; and generating random or clock-derived business facts.

**There is no repository, loader, or "latest" parameter to pass.** `projectOfferCapsule`
takes exactly one argument — a source version and a context — and the current
Offer record (`OfferSourceRecord`) fails the source-version schema, so handing one
in produces `INVALID_SOURCE_VERSION` rather than yesterday's obligation published
with today's facts.

## 2. Projection context

A strict contract, separate from `OfferSourceVersion`, carrying only
capsulization-side bindings:

| Field | Purpose |
| --- | --- |
| `offerBinding` | the Registrar-issued Offer Node **and** the internal Offer id it stands for |
| `productBinding` | the Product Node **and** the internal Product id it stands for |
| `authorityBinding` | the approved public authority Node **and** the Seller participant it stands for |
| `sourceVersionBinding` | the exact source-record id and version this projection is for |
| `capsuleId` | the capsule-version identity, issued elsewhere |
| `capsuleVersion` | semver for this capsule |
| `mappingVersion` | the recorded projection-mapping version |
| `generatedAt` | explicit UTC generation instant — **no default, no clock read** |
| `nodePolicy` / `capsulePolicy` | applicable policy references |

Each binding pairs a **public** identifier with the **internal** identifier it
claims to stand for. The internal half exists so the mapper can *refuse a
mismatched pairing*; it is validation input and **never reaches the capsule**.
A test asserts the serialized capsule contains none of them.

**No Node is issued, registered, or persisted here.** Binding to an identifier
someone else issued is not the same act as issuing one (ADR §11.2).

## 3. Internal versus public identity

| Internal (transactional) | Public (capsule) |
| --- | --- |
| `mon:offer:<opaque>` | `metadata.bindsToNode` — an `an:node:` Offer Node |
| `mon:product:<opaque>` | `data.relationships.itemOffered` — a Product Node |
| `mon:mpart:<opaque>` | `data.relationships.offeredBy` — an authority Node |
| `mon:srec:<opaque>` | `metadata.provenance.sourceRecordId` — see below |

`AnsNodeId` structurally refuses a semantic or internal value, so a
`mon:product:` id cannot be passed off as a Product Node. On top of that, a
**value scan** (`findInternalIdentifiers`) walks every string in the finished
capsule and refuses any containing `mon:offer:`, `mon:product:`, `mon:mpart:`,
`mon:mrole:`, `mon:acct:`, `mon:asess:`, `mon:aent:`, `mon:actor:`,
`mon:creator:`, `mon:mprof:`, `mon:mact:`, `mon:mpay:`, or `mon:pvev:`. It uses
`includes`, not `startsWith`: an id embedded mid-string — inside a provenance
`source` line, say — is exactly the leak a prefix check would miss.

### Why `mon:srec:` is not forbidden

The source-record identifier **is** the already-approved Product provenance
pattern (`provenance.sourceRecordId`; ANS §3, ADR §11.8). It is opaque, encodes no
business meaning, and exists precisely so a published claim can be traced to the
exact governed record version behind it. Forbidding it would break provenance
rather than protect anything.

This phase introduces **no new raw internal identifier beyond that approved
pattern** — which is why every other prefix is refused.

## 4. Public claims

Envelope: exactly `@context`, `@type`, `metadata`, `data` (ANS §3), reusing the
established building blocks from `capsule/envelope.ts`.

`data` carries:

- `commercialState` — `AVAILABLE` | `TEMPORARILY_UNAVAILABLE` | `ENDED`;
- `price` — `{ priceType: "FREE" }` or `{ priceType: "PAID", priceMinorUnits,
  priceCurrency }`;
- `promotable`, and `commission` **if and only if** promotable;
- `validFrom` / `validThrough` where the source holds them;
- `relationships` — `itemOffered` (Product Node) and `offeredBy` (authority Node).

`metadata` carries `capsuleId`, `bindsToNode`, `version`, `provenance`,
`nodePolicy`, `capsulePolicy`, and `contentHash`.

**`publishedBy`, `publishedAt`, `supersedes`, and `revokes` are deliberately
absent.** They are facts about a publication event, and this phase performs none;
a projection carrying them would assert an event that never happened.

### Product claims are not restated

No `name`, `description`, `image`, `productVersion`, `specifications`,
`capabilities`, `generalAvailabilityState`, or category. The Product capsule is
the creator's authority (ADR §2); an Offer that copied it would create a second,
divergent answer to what the thing is. The only Product linkage is a Node
reference.

## 5. Eligibility

| Source lifecycle + availability | Result |
| --- | --- |
| `DRAFT` | **ineligible** — `DRAFT_NOT_PUBLIC` |
| `ACTIVE` + `AVAILABLE` | eligible → `AVAILABLE` |
| `ACTIVE` + `TEMPORARILY_UNAVAILABLE` | eligible → `TEMPORARILY_UNAVAILABLE` |
| `ENDED` | eligible → `ENDED` |
| `SUSPENDED` | **ineligible** — `SUSPENDED_PUBLICATION_DEFERRED` |
| `WITHDRAWN` | **ineligible** — `WITHDRAWN_PUBLICATION_DEFERRED` |

`SUSPENDED` and `WITHDRAWN` handling is a **publication-lifecycle decision**,
deferred: whether either should supersede, revoke, or merely stop refreshing an
already-published capsule is unanswered, and quietly projecting something would be
answering it by accident.

The public vocabulary **cannot express** `DRAFT`, `SUSPENDED`, or `WITHDRAWN` — a
vocabulary able to say "suspended" would invite publishing one.

**Producing an `ENDED` projection is not publishing, superseding, or revoking
anything.** This phase does none of those.

## 6. Price, interval, and promotion mapping

The source rules survive projection unchanged, and are **re-validated on the
output** rather than trusted:

- `FREE` emits no amount and no currency — there is no field for either;
- `PAID` emits positive integer **minor units** and a structural uppercase
  currency. schema.org `price` is a decimal, which is why `priceMinorUnits` is a
  Monacado term: emitting `9.99` would hand a consumer a float where the record
  holds an integer;
- promotion requires `PAID`; a fixed commission cannot exceed the price;
- a fixed commission **states its own currency** — see below.

### Fixed-commission currency

A fixed commission publishes both halves of the money:

```
{ commissionType: "FIXED", fixedCommissionMinorUnits, fixedCommissionCurrency }
```

**A monetary amount published without a currency is not a monetary amount.** A
consumer reading the commission would otherwise have to reach into a sibling
field to learn what the number means, and any future consumer that forgot to
would be silently wrong.

The currency is taken **directly from the source commission** — not from the
price, and never inferred, substituted, or normalized. The source already
requires the two to be equal, and the published shape **re-checks** it: a capsule
whose commission is denominated differently from its price fails validation and
cannot be hand-assembled. Copying from the price instead would paper over a
source that somehow disagreed, which is exactly the failure worth surfacing.

A **percentage** commission carries basis points only — there is no money in it
to denominate, and a currency field is refused. **FREE** and **NOT_PROMOTABLE**
Offers publish no commission at all, and therefore no commission currency.

**Absent interval bounds are omitted keys**, never `null` — one canonical public
representation, mirroring the source's single canonical `null`. `validFrom` and
`validThrough` are optional rather than nullable, so an explicit `null` is
refused and two spellings cannot coexist.

**The mapper reads no clock, and repairs nothing.** An invalid source version, an
invalid context, a mismatched binding, or an ineligible Offer produces a bounded
`OfferProjectionError` — never a best-effort capsule. A source that cannot be
projected is one someone must fix at the source.

## 7. Provenance is represented, not created

The projection restates facts the database already holds:

- `sourceRecordId` / `sourceRecordVersion` — the exact version projected;
- `sourceSystem`, `sourceRecordType`, `sourceClass`;
- `acquiredAt` — **the instant the database recorded the authorized change**
  (`recordedAt`), not a new instant invented here;
- `generatedAt` and `generatorVersion` — the projection event and mapping version;
- `assertionKind: "Asserted"`;
- `method: "governed-source-version-projection"`.

**It does not imply the capsule created any of them.** The authorization trace —
`authorizedByActorId`, `authorizedBySellerParticipantId` — stays private and never
appears; a test asserts the serialized capsule contains neither the actor id nor
either field name.

Never exposed: `internalOfferId`, `internalProductId`, `sellerParticipantId`,
account id, session or entitlement data, private profile data, payment-provider
identifiers, audit internals, retention state.

## 8. Determinism and hashing

The existing canonicalization and SHA-256 infrastructure is reused — **no second
canonicalizer or hashing implementation was created**. `withPublishedContentHash`
computes `metadata.contentHash` over the canonical serialization of the whole
capsule, excluding only that field.

Same source version + same context ⇒ **byte-identical capsule and identical
hash**, including when the context object's keys are supplied in a different
order. Changing any material public fact — price amount or currency, commercial
state, promotion, commission, interval, capsule version, mapping version,
generation instant, or the source version itself — changes the hash; a test
asserts nine such variants produce nine distinct hashes.

Operational publication data **cannot** affect the projection: publication retry
state, worker lease state, receipt processing, archive location, monitoring
counters, and read timestamps are refused on the source version, on the context,
and in the output — three independent barriers.

## 9. Prohibited content

Structurally excluded by strict schemas and the value scan: internal Offer,
Product, Seller, Account, or participant identifiers; Stripe or payment-provider
data; order, cart, checkout, payment, refund, settlement, or payout data; earned
commission; platform or processing fees; internal cost or margin; tax or banking
data; private review or activation data; retention and legal-hold state; the
deferred Offer extensions (inventory, variants, discounts, territory, tax
treatment, subscriptions, rentals, licensing, shipping); arbitrary metadata or
extension bags; and Product descriptive content.

> **Note on the Product forbidden-field scan.** `integrity/forbidden-fields.ts`
> refuses `price`, `currency`, and `commission` — correctly, for a *creator
> Product* capsule, where those belong to another authority. It is deliberately
> **not** applied to the Offer capsule, whose entire purpose is to carry exactly
> those terms. The Offer's guard is the value scan above plus strict schemas at
> every level.

## 10. Ontology additions

Fifteen terms, the minimum the shape requires — five reused from schema.org
(`Offer`, `itemOffered`, `priceCurrency`, `validFrom`, `validThrough`) and ten
Monacado terms (`commercialState`, `price`, `priceType`, `priceMinorUnits`,
`commission`, `commissionType`, `commissionBasisPoints`,
`fixedCommissionMinorUnits`, `fixedCommissionCurrency`, `offeredBy`).

schema.org `price` (a decimal) and `availability` (an `ItemAvailability`
enumeration) are **not** reused: neither matches Monacado's minor-unit money or
its `AVAILABLE`/`TEMPORARILY_UNAVAILABLE`/`ENDED` state, and reusing them would
quietly change their meaning. The ontology and context stay in sync (49 terms
each), and the derived JSON Schema is generated alongside the Product ones.

## 11. Deferred

- **The publication lifecycle** — submitting, registering, receipts, supersession,
  revocation, and the `SUSPENDED`/`WITHDRAWN` publication decision.
- **Node issuance and registration** — this phase binds to identifiers it is
  given.
- **Persistence** of projections, contexts, or mapping versions.
- **The public authority mapping itself** — which Node a Seller projects to
  remains the unresolved Seller-versus-Creator question
  ([`AUTHORITATIVE_OFFER_SOURCE_MODEL.md`](AUTHORITATIVE_OFFER_SOURCE_MODEL.md)
  §16). The context *accepts* an approved authority Node; deciding what makes one
  approved is not this phase's.
- **Offer extensions** — discounts, inventory, variants, territory, tax,
  shipping, subscriptions, licensing, and non-monetary incentives, all still
  refused rather than omitted.
- **Currency registry and minor-unit exponents.**

## Reference

- [`AUTHORITATIVE_OFFER_SOURCE_MODEL.md`](AUTHORITATIVE_OFFER_SOURCE_MODEL.md)
- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
- [`PRODUCT_CAPSULE.md`](PRODUCT_CAPSULE.md)
- [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) §4, §11
