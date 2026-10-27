# Authoritative Offer Source Model (Phase 0M.2A, corrected by 0M.2C; Seller authority in Phase 1.42)

> **Authority status (Documentation Governance 2B).** Remains **governing
> detail** for Offer authority and terms
> ([`DOCUMENT_AUTHORITY.md`](DOCUMENT_AUTHORITY.md) §3). Where it conflicts with
> [`MONACADO_PROJECT_CONTRACT.md`](MONACADO_PROJECT_CONTRACT.md), **the Contract
> controls.** Known conflict: the **"Promoter economics (future Listing)"**
> formula predates the MoR model — it omits Monacado's retained amount and
> contemplates pricing below wholesale. Contract §17–§18 control: the retained
> amount is removed before the promoter spread, and promoter benefit =
> acquisition amount − wholesale + commission, never negative. Promotional
> availability also requires public marketplace identity (Contract §12). The
> body below is not yet reconciled.

Status: **binding** for the Offer track. Subordinate to
[`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
(ADR §12) and [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md).

Defines the **authoritative transactional record** for an Offer and the immutable
source versions a later Offer Capsule Projection Shape will be generated *from*.

**No capsule contract, JSON-LD, Node or capsule identity, projection mapping,
canonicalization, hashing, publication preparation, persistence, migration,
route, or UI is introduced by this phase.**

## Phase 1.42 — Seller Offer Authority (reconciliation)

> **Read this first.** Phase 1.42 implemented the Offer as the **Seller's
> commercial authority for promoted resale** (Contract §12, §16, §19) and
> changed the model below in the places marked *Superseded by Phase 1.42*. Where
> the body and this section disagree, **this section governs**; the Contract
> governs both.

**Scope.** An Offer is the Seller-authored standing terms under which a Promoter
may acquire and resell one Product: **wholesale price and commission**, PAID +
PROMOTABLE, USD only, a positive wholesale amount. Retail price stays on the
Listing (Contract §15). The 7.5% + $1 acquisition economics (§17–§18) are
policy, never stored on the Offer. Promotion Authorization (§16.1) is a separate
record and is neither required nor consulted by any Offer act.

**Cardinality.** At most **one non-terminal Offer per Product**
(`Offer.nonTerminalForProductId`, unique). A Product whose Offer is WITHDRAWN or
ENDED may get a **new** Offer with a new `offerRef`; the terminal one keeps its
full history.

**Lifecycle is split from commercial versions.** Lifecycle is Seller authority
recorded as an append-only, linear chain of `OfferAct` rows (ACTIVATE, PAUSE,
RESUME, WITHDRAW, END_PROMOTION) and **derived on read**:

| State | Meaning |
| --- | --- |
| `DRAFT` | created; no act yet |
| `ACTIVE` | activated against the exact confirmed STANDING version |
| `PAUSED` | the Seller stood it down; RESUME returns it to ACTIVE |
| `WITHDRAWN` | terminal, by a Seller act |
| `ENDED` | terminal, **derived only**: the optional overall `effectiveUntil` recorded on activation has passed (exclusive end). No act or job records it |

Transitions: `ACTIVATE` DRAFT→ACTIVE · `PAUSE` ACTIVE→PAUSED · `RESUME`
PAUSED→ACTIVE · `WITHDRAW` DRAFT/ACTIVE/PAUSED→WITHDRAWN. **PAUSE and RESUME
mint no commercial version.** Seller-controlled `SUSPENDED` is **removed**: it is
reserved for a future operator act and is not a lifecycle member. The Offer's
"availability" (§16) is expressed by `PAUSED`; there is no separate
availability field. Product lifecycle, resale availability, and readiness
changes **never rewrite** Offer lifecycle — they gate activate and resume only.

**Commercial versions hold terms only.** Each version is an immutable full
snapshot, `termsKind` `STANDING` or `SCHEDULED_PROMOTION`, with its economics
computed by the one calculator. Labels are **allocated by the server** (the next
integer in the Offer's chain), and every version supersedes the previous one in
one linear chain. Exactly one STANDING version is current
(`currentSourceRecordVersion`).

**Scheduled promotions.** A promotion is a `SCHEDULED_PROMOTION` version that
overrides **wholesale only** (the commission is the standing one), over a
half-open window `[effectiveFrom, effectiveUntil)`, built on a named
`basisStandingVersion`. At most one is upcoming or running
(`currentPromotionVersion`). It **starts and reverts automatically** — no act and
no job; a future promotion may be **replaced** (the replaced version stays in
history), and a running one may be **ended early** by an `END_PROMOTION` act.
Promotions may be scheduled on an `ACTIVE` or `PAUSED` Offer, never backdated.

**Effective terms.** `effectiveOfferTerms(offer, at)` is pure: not
lifecycle-effective → none; ENDED → none; a RUNNING promotion → its version;
else the standing version. It is **necessary, never sufficient**, for promoted
commerce, and Phase 1.42 wires it into neither checkout nor Listings.

**Confirmation and staleness.** Seller acts that depend on commercial state
carry `expectedVersion` (and `expectedPromotionVersion`); a stale one is a 409.
Activation confirms the exact current STANDING version's economics; a **live
standing revision confirms the exact new version**; a promotion confirms the
exact promotional version. An unconfirmed request is refused with the server's
own disclosure of that version, which the Seller confirms and resends. DRAFT
revisions need no confirmation. A standing revision is refused while a promotion
is upcoming or running.

**Readiness for activate and resume** (`evaluateOfferActivationReadiness`,
every blocker reported): Product `ACTIVE`, verified email, nonblank declared
names, participant `ACTIVE`, SELLER role `ACTIVE`, not suspended, commerce
approval `APPROVED`, payment `ENABLED`, no `offer:publish` restriction — the
Seller's public marketplace identity (Contract §5, §12). Not conditions: resale
availability, Promotion Authorization, a Storefront, a Listing, or any Promoter
fact.

**Material changes (Contract §19).** Wholesale and commission changes are
material: they mint a new version and are classified
(`WHOLESALE_PRICE_CHANGED`, `COMMISSION_TERMS_CHANGED`,
`OTHER_MATERIAL_OFFER_CHANGE`). `COMMERCIAL_AVAILABILITY_CHANGED` stays in the
vocabulary and is **never emitted**: availability is no longer a version fact.
Propagation to promoted Listings remains the Contract §34 gap.

**Owner ruling — scheduled promotions are material (Contract §19).** A
scheduled promotion's wholesale override is a material change. Promoter
acceptance (not built in 1.42) binds the **exact promotional version**, and may
be given any time after scheduling and before `effectiveFrom`. The arrival of
`effectiveFrom` requires **no new acceptance**. When the promotion ends —
naturally or early — and the exact prior standing version resumes, **no new
acceptance** is needed if that standing version was already accepted and is
unchanged. Because a standing revision is refused while a promotion is
upcoming or running, the standing version that resumes is always the one the
promotion was built on (`basisStandingVersion`).

**Privacy.** Offer terms are **private and unpublished in Phase 1.42**: no
Offer capsule, Node, or publication, and no Promoter visibility.

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

> **Superseded by Phase 1.42.** The table below is the 0M.2A lifecycle. It is
> now `DRAFT`, `ACTIVE`, `PAUSED`, `WITHDRAWN`, `ENDED`, recorded as acts and
> derived — see *Phase 1.42* above. `SUSPENDED` is reserved, not a member;
> `ENDED` is derived from the overall end, not a transition anyone performs.

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

> **Superseded by Phase 1.42.** There is no availability field. A Seller stands
> an Offer down by pausing it (`PAUSED`); "currently usable terms" is
> `effectiveOfferTerms`. `isCommerciallySelectable` no longer exists.

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

## 7. Wholesale price (corrected in 0M.2C)

A strict discriminated union on `type`:

- **`FREE`** — no amount field, no currency field, no commission.
- **`PAID`** — `wholesalePriceMinorUnits` (positive integer) and
  `wholesalePriceCurrency`.

**This is the wholesale price: what the creator is owed, before any promoter
commission is deducted.** It is deliberately not a generic "price". What a buyer
eventually pays is the **Promoter's retail price**, set on a future Listing —
the same number cannot be both, and naming it `price` was the ambiguity 0M.2C
exists to correct. The old `amountMinorUnits` / `currency` spellings are refused.

**Money is minor units only**, integer, never a decimal. Currency validation is
structural (`/^[A-Z]{3}$/`) and is **not** an ISO 4217 registry — that remains a
future service concern.

## 8. Commission (corrected in 0M.2C)

The creator selects exactly one method:

| Method | Requires | Commission |
| --- | --- | --- |
| **`PERCENT_OF_WHOLESALE`** | `commissionBasisPoints`, 1–10 000 | `round(wholesale × bp / 10 000)` |
| **`FIXED_AMOUNT`** | `fixedCommissionMinorUnits` + `fixedCommissionCurrency` | the fixed amount |

**The commission basis is always the wholesale price.** `PERCENT_OF_RETAIL`,
`PERCENT_OF_LISTING_PRICE`, `PERCENT_OF_CHECKOUT_TOTAL`, and any selectable basis
are refused by construction: a commission computed from a number the *Promoter*
controls would let the Promoter change what the creator owes them, and the
creator agreed to neither the number nor the change.

The two methods stay **semantically distinct even when they produce the same
amount** for one wholesale price — "20% of whatever I charge" and "£2.00" diverge
the moment the price moves.

Cross-field rules, validated together: promotion requires `PAID`; a fixed
commission must match the wholesale currency and may not exceed the wholesale
price; each method refuses the other's fields.

### Deterministic calculation

```
calculatedCommission              = per the table above
calculatedCreatorGrossProceeds    = wholesalePrice − calculatedCommission
```

- **Rounding policy: `HALF_UP_TO_MINOR_UNIT`** —
  `floor((wholesale × bp + 5 000) / 10 000)`. Named as a policy rather than left
  to a library. Fixed commissions need no rounding.
- **Percentage arithmetic runs in `BigInt`.** `wholesale × basisPoints` exceeds
  `Number.MAX_SAFE_INTEGER` for ordinary amounts in small-unit currencies, and a
  silent precision loss in money surfaces as a rounding complaint months later.
  The result converts back only after it is confirmed in range.
- `calculateOfferEconomics` is pure: no clock, no randomness, no I/O.

Invariants, each tested: commission and proceeds are never negative; neither
method can exceed the wholesale price; **commission + proceeds = wholesale**;
`PAID` + `NOT_PROMOTABLE` gives commission 0 and proceeds = wholesale; `FREE`
gives 0 and 0.

**Excluded from these numbers:** Monacado fees, payment-processing fees, taxes,
shipping, refunds, chargebacks, and payout adjustments. "Gross proceeds before
separately disclosed fees" means exactly that; folding a fee in would make the
creator's disclosed number quietly wrong. Those belong to future checkout and
settlement phases.

### Promoter economics (future Listing)

```
promoterGrossEarnings = calculatedCommission + (promoterRetailPrice − wholesalePrice)
```

A Promoter may price **below wholesale** (surrendering part of the commission),
**at wholesale** (earning the commission), or **above wholesale** (commission plus
positive spread). Many Promoters may carry the same Offer at different retail
prices. **The Promoter's retail price never affects the commission due, the
creator's proceeds, or Offer source truth**, and there is no field for it here.

The Offer model imposes **no** creator-controlled retail floor, minimum advertised
price, suggested retail price, mandatory markup, or minimum promoter profit.
Whether a negative promoter result is permitted or must be separately funded is a
future Listing and checkout decision.

## 8a. Authoritative storage and calculation policy

The immutable source version retains enough to **reproduce and audit** the exact
economics the creator accepted: the wholesale inputs, the commission method and
inputs, `calculatedCommissionMinorUnits`,
`calculatedCreatorGrossProceedsMinorUnits`, and the
`commissionCalculationPolicyVersion` (`WHOLESALE_COMMISSION_V1`).

**The calculation policy version is not the capsule mapping version.** How much a
creator is owed is a business rule; how a capsule is shaped is a projection rule.
Tying them together would make a presentational change look like a repricing.

Validation **rejects stored amounts that do not exactly match the calculator**, so
a hand-edited or drifted snapshot cannot masquerade as accepted economics.

## 8b. Creator disclosure and exact-version confirmation

Before activation the creator must be shown: the wholesale price; the commission
method; the rate or fixed amount; **the exact calculated commission per completed
sale**; **the exact calculated gross proceeds before separately disclosed fees**;
and the calculation policy version. A rate alone is not disclosure — what a
creator wants to know is what they receive per sale.

Confirmation is **not** an unbound `creatorConfirmedEconomics: true`. Such a flag
says nothing about *which* economics were confirmed, so it would survive a
repricing untouched and authorize terms the creator never saw.

It carries exactly five fields:

- `confirmedOfferSourceRecordId`
- `confirmedOfferSourceRecordVersion`
- `calculatedCommissionMinorUnits`
- `calculatedCreatorGrossProceedsMinorUnits`
- `commissionCalculationPolicyVersion`

**Both halves of the identity are required, and are compared independently.** A
version label alone is not unique across Offers: two Offers each have a "v3", and
a confirmation carrying only "v3" would authorize the wrong Offer's economics
whenever the amounts happened to coincide.

Activation denies with a **distinct code for each** failure: a missing
confirmation; one naming another Offer; one naming another version of this Offer;
one whose amounts no longer match the authoritative calculator; and one computed
under a different policy version.

**A material economic change mints a new source version, so a confirmation bound
to the previous one stops matching by construction** — the creator has to look
again before the new terms can sell. Nobody has to remember to clear a flag.

Confirmation persistence and UI are **not** implemented.

## 8bb. Business-change classification

`classifyOfferBusinessChanges` returns a **readonly array of zero or more**
categories, in this fixed order:

1. `COMMERCIAL_AVAILABILITY_CHANGED`
2. `WHOLESALE_PRICE_CHANGED`
3. `COMMISSION_TERMS_CHANGED`
4. `OTHER_MATERIAL_OFFER_CHANGE`

**Multi-category on purpose.** One governed edit can legitimately change
availability, wholesale price, and commission terms at once, and reporting only
the first would leave a promoter unaware of the rest. The order is fixed so two
callers comparing results never disagree because of ordering, and so a test can
assert an exact array rather than a set.

**A calculated commission that moved solely because the wholesale price moved adds
no `COMMISSION_TERMS_CHANGED`.** Only the commission *inputs* — method, basis
points, fixed amount, fixed currency — count. The creator changed one thing, and
saying otherwise would tell a promoter their terms were altered when they were
not.

The classifier notifies nobody, enqueues nothing, persists nothing, mutates no
Listing, and identifies no recipient.

## 8c. Downstream effects (documented, not implemented)

Binding on the future Listing and notification phases. **The canonical notice
channel is the Monacado admin panel**; email, SMS, and push may be supplemental
and can never replace it.

| Offer change | Dependent promoted Listings | Notice | Promoter action |
| --- | --- | --- | --- |
| **Becomes unavailable** | non-sellable, checkout disabled; promoter cannot override; relationships preserved, **never destructively deleted** | yes | none possible until the Offer returns |
| **Wholesale price changes** (up or down) | non-sellable, price-review-required | yes | **explicit review and retail-price confirmation**; acknowledgement alone does not reactivate |
| **Commission terms change** (method, rate, fixed amount) | **remain sellable** | yes | repricing optional; acknowledgement informational |

**Monacado never automatically alters a Promoter's retail price.** Restoration
behaviour after unavailability is a Listing-lifecycle decision.

## 8d. Immutable sale economics (future)

Each completed sale must bind to the exact Offer source version, the exact
promoted Listing version, the actual retail price, the wholesale price, the
commission method, the rate or fixed amount, the exact calculated commission, and
the applicable fee schedule. **Later Offer changes must never alter an already
accepted order.**

## 9. Effective interval

> **Superseded by Phase 1.42.** Versions carry no effective interval. The
> Offer's optional overall end is recorded on the ACTIVATE act and derives
> `ENDED` — so, unlike the rule below, **an elapsed overall end does move the
> derived lifecycle**, deterministically and with the act that set it as its
> record. A promotion's window is `promotionWindow` on a
> `SCHEDULED_PROMOTION` version: both bounds required, `effectiveUntil`
> strictly later; `null` is its only absence, on STANDING versions.

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

> **Superseded in part by Phase 1.42.** The capabilities are now
> `offer:draft:create`, `offer:activate`, `offer:terms:change`, `offer:pause`,
> `offer:resume`, `offer:withdraw`, `offer:promotion:schedule`, and
> `offer:promotion:end` (`canSuspendOffer` and `canEndOffer` are gone).
> Activation and resumption decide Seller authority, Product authority, the
> transition, and (activation) the exact-version confirmation; **commerce
> readiness is decided separately** by `evaluateOfferActivationReadiness`, and
> the service requires both. A `PAUSED` Offer's terms face the full commerce
> gates and a confirmation, as an `ACTIVE` one's do. Stand-downs (pause,
> withdraw, ending a promotion) still require neither readiness nor Product
> authority.

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

> **Superseded in part by Phase 1.42.** The material snapshot is Product
> reference, Seller reference, `termsKind`, terms, `promotionWindow`, and
> `basisStandingVersion` — **no lifecycle, availability, or effective interval**.
> Labels are allocated by the server, not supplied.

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

> **Superseded in part by Phase 1.42.** The material field set is
> `internalProductId` · `sellerParticipantId` · `price` · `promotion` ·
> `commission`. Lifecycle and availability are no longer version facts and are
> not change fields at all.

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
