# Authoritative Listing Source Model (Phase 0M.4A)

The authoritative transactional record for the buyer-facing placement of a
Product in a Storefront, plus the immutable source versions a later Capsule
Projection Shape will be generated from.

**Contract/design only.** No persistence, no capsule, no Node, no publication, no
checkout, no payment, and no risk-management policy selection.

## 1. Listing authority

The **Listing source record is authoritative** (ADR §12). A capsule never
supplies data to it, never repairs it, and never overrides it. The Listing is not
capsule-authoritative and gets no AgentNet Node in this phase.

Identity follows the existing conventions: `mon:listing:<opaque>` for the
enduring Listing, `mon:srec:<opaque>` for its source record. Neither is an ANS
Node ID or a capsule ID. The Listing identifier encodes neither the storefront,
the product, the type, nor the controlling participant — a Listing that changed
hands would otherwise carry a lie in its own identifier.

A Listing identifies: `storefrontId`, `internalProductId`,
`controllingParticipantId`, `listingType`, `lifecycle`,
`currentSourceRecordVersion`, and — for promoted Listings — its exact Offer
dependency.

Lifecycle reuses the Offer's vocabulary member for member (`DRAFT`, `ACTIVE`,
`SUSPENDED`, `ENDED`, `WITHDRAWN`) so a reader need not learn a third set of
words for the same commercial shape. It is a separate constant rather than a
shared import, because a Listing and an Offer must be free to diverge without one
silently changing the other. This is **not** publication lifecycle and **not**
ANS Node lifecycle.

## 2. Seller-direct versus promoted

The two are a **discriminated union**, so the wrong field has nowhere to go
rather than merely being rejected by a rule:

| | `SELLER_DIRECT` | `PROMOTED` |
| --- | --- | --- |
| Controlled by | the seller | the promoter |
| Retail price | seller's own | promoter's own |
| Scheduled sale | **optional** | **no such field** |
| Offer dependency | **no such field** | **required, exact version** |
| Upstream review state | **no such field** | required |

A seller selling their own Product has no wholesale counterparty, so a dependency
would imply one. A promoter's price is already their own, so a "sale" field there
would create a second place a promoted price could move — invisible to the
economics check that keeps proceeds non-negative.

## 3. Seller-only scheduled sales

An optional `sale` object on a seller-direct placement, with all three fields in
one nested object so **all-present-or-all-absent is the shape**, not a refinement
someone can forget. There is no way to supply a start without a price.

- `salePriceMinorUnits` — strictly lower than ordinary retail
- `salePriceCurrency` — required, and **checked against** the retail currency
  rather than inherited from it, the same treatment the Offer gives a fixed
  commission's currency. Copying it silently would paper over a caller that
  genuinely disagreed.
- `saleStartsAt` / `saleEndsAt` — UTC instants

### Timing semantics

**Start inclusive, end exclusive** — a half-open interval, so two consecutive
sales cannot both be active for the instant they touch.

```
saleActive(now) ⇔ now ≥ saleStartsAt ∧ now < saleEndsAt
effectivePrice(now) = saleActive(now) ? salePrice : ordinaryRetail
```

`now` is **supplied by the caller**. Nothing here reads the runtime clock: a
pricing function that consulted it would be untestable at its boundaries and
non-deterministic in replay.

**The ordinary retail price is never mutated** when a sale starts or ends. The
sale is an overlay with its own window, so the price to return to is still
recorded when the window closes.

## 4. Seller-sale isolation

A seller's temporary sale:

- affects only that seller-direct Listing;
- does **not** change the wholesale price;
- does **not** create a new Offer version;
- does **not** alter any promoted Listing;
- does **not** require promoter acknowledgement;
- does **not** require promoter review;
- does **not** create a notification obligation;
- does **not** change promoter minimum-price economics.

The guarantee is **structural**: a sale lives inside a `SELLER_DIRECT` placement,
and that placement has no field for an Offer, a wholesale price, a promoted
Listing, a promoter obligation, or a notification. There is nothing for it to
reach. `SELLER_SALE_ISOLATED_FROM` records the list executably and
`sellerSaleForcesPromoterReview()` returns literal `false`, so the promise is
testable rather than merely written down.

## 5. Promoter retail-price autonomy

A promoter sets and changes their retail price independently. A change:

- does not change the wholesale price;
- does not create or amend the Offer;
- does not change the seller's contractual economics;
- may change promoter proceeds and margin rate;
- must keep proceeds non-negative.

### Promoter compensation is commission *plus* resale margin — by design

A **settled commercial ruling**, recorded here because it is easy to mistake for
an accident of the arithmetic. A promoter may earn **both** the seller-funded
Offer commission **and** the retail spread they create:

```
promoterNetProceeds = morWholesaleAcquisitionAmount − offerWholesalePrice
                    + sellerFundedCommission
```

The two components are independent:

- the **Offer commission** is based **exclusively on Offer wholesale economics**,
  set and funded by the seller, and a promoter cannot change it;
- the **retail spread** is the promoter's own — changing the retail price changes
  the spread and nothing else. It does not change the Offer commission, amend the
  Offer, or touch the seller's contracted economics.

Full commercial description:
[`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md) §D.

### Terminology

The derived retail-relative share is **promoter margin rate**, never a commission
rate. The Offer's commission is a creator-defined amount computed from the Offer
wholesale price; the margin is what remains to the promoter after the supply cost
and Monacado's retention. Calling both "commission" would let two different
numbers answer to the same word in the same sale — and would misstate what the
seller agreed to, since only one of them is contractual. Existing Offer
commission terminology is unchanged.

- **promoter retail spread** — `acquisition − offerWholesalePrice`
- **promoter net proceeds** — the spread plus the seller-funded commission; the
  authoritative figure
- **promoter margin / margin rate** — the same amount as a share of commercial
  retail; presentational

## 6. Non-negative promoted economics

Monacado is the **Merchant of Record**. It does not charge the promoter a
platform fee on the side; it acquires the item at the moment of sale and its
economics are what it retains from the commercial retail price:

```
monacadoRetained     = halfUp(R × retainedBasisPoints / 10000) + retainedFixed
acquisition      A   = R − monacadoRetained
promoterRetailSpread = A − offerWholesalePrice
promoterNetProceeds  = promoterRetailSpread + sellerFundedCommission   ≥ 0
sellerProceeds       = offerWholesalePrice − sellerFundedCommission
```

The identity `sellerProceeds + promoterNetProceeds + monacadoRetained = R` holds
exactly and is asserted at runtime — a reconciliation that does not add up to what
the buyer paid is not a reconciliation.

**Monacado's retention is deducted exactly once**, inside `A`. The earlier
formula `retail − wholesale − monacadoFee` modelled the platform's economics as a
fee charged *in addition to* a wholesale purchase, which under the MoR
relationship counts the retention twice. It has been removed.

Integer minor units throughout; **no floating-point money anywhere**. The
percentage runs in `BigInt` for the same reason the Offer calculator does —
`amount × basisPoints` exceeds `Number.MAX_SAFE_INTEGER` for ordinary amounts in
small-unit currencies. Rounding is half-up to the minor unit, matching
`COMMISSION_ROUNDING_POLICY`.

Negative promoter proceeds are **refused**, not returned.

## 7. Monacado wholesale-acquisition policy dependency

> **The Listing economics layer consumes the applicable versioned Monacado
> wholesale-acquisition policy supplied by the platform.**

That is the whole architectural dependency. This module defines **no default rate
and no default fixed amount**. The current standard policy retains 7.5% plus
$1.00 — equivalently, Monacado acquires at 92.5% of the commercial retail price
minus $1.00 — but that is a commercial decision that will change, and a constant
here would make the next repricing a code change inside an economics contract. A
test asserts none is embedded, and that no physical-goods-specific rate exists.

`MonacadoWholesaleAcquisitionPolicy` carries `policyId`, `policyVersion`,
`currency`, `retainedPercentageBasisPoints`, `retainedFixedAmountMinorUnits`, and
an explicit `roundingPolicy`. Currency compatibility is **checked, never
coerced**.

Policy lookup, applicability, risk adjustment, and override selection are **not**
in this phase — they belong to `0M.R`, which may supply a different or
risk-adjusted policy through this same input. The caller resolves which policy
applies and hands it in already chosen.

## 8. Minimum viable promoted retail price

`minimumViablePromotedRetailPrice` returns the lowest commercial retail price at
which promoter net proceeds are not negative:

```
promoterNet(R) = (R − monacadoRetained(R)) − offerWholesalePrice
                 + sellerFundedCommission   ≥ 0
```

The rule **survives the correction** and stays a Listing-layer invariant: it is
the promoter's own price that determines it. The threshold moves, though — a
seller-funded commission lowers it, and Monacado's retention is now counted once
rather than twice.

Solved **exactly by binary search**, with no floating-point arithmetic.

**Why bisection is valid.** With `retained(R) = ⌊(R·bp + 5000)/10000⌋ + fixed`
and `0 ≤ bp ≤ 10000`, raising the price by one minor unit raises the retention by
zero or one, so `promoterNet(R)` is non-decreasing and the feasible prices form a
suffix.

**Why the bound is sound.** `R₀ = ⌈(W − C + fixed) × 10000 / (10000 − bp)⌉` is
feasible: it is the answer ignoring rounding, and half-up rounding only reduces
the retention relative to the exact share, so `promoterNet(R₀) ≥ −0.5` and — being
an integer — therefore `≥ 0`.

> A closed form plus a small fixed window would be wrong here, and quietly so.
> Half-up rounding can move the true minimum **below** `R₀` by as much as
> `5000 / (10000 − bp)` — a fraction of a unit at ordinary rates, but thousands of
> units as the rate approaches 100%. An early draft used a ±2 window and was
> exactly wrong in that regime. Bisection has no window to size. The tests check
> the boundary at every combination of rate, fixed retention, supply cost, and
> commission rather than assuming it.

Infeasible policies are refused rather than answered.

## 9. Commercial price basis — tax and shipping excluded

The wholesale-acquisition policy applies to the **commercial merchandise or
service price alone**. Outside that basis:

- sales tax, VAT, GST;
- shipping, freight, delivery charges;
- any other approved checkout pass-through amount.

These may be added to a buyer's checkout total later:

```
checkout total = commercial price + applicable tax + shipping + permitted pass-through
```

but the economic base remains the **commercial price**. Explicitly:

- tax does **not** enlarge the wholesale-acquisition basis or Monacado's retained
  percentage or fixed economics;
- shipping does **not** enlarge them either;
- neither enters a seller-funded promoter commission;
- neither enters promoter margin or promoter net proceeds.

**The exclusion is structural.** There is no tax field and no shipping field on
the Listing source model, so neither can reach a calculation, and a strict schema
refuses one if someone adds it. No tax or shipping amount was introduced merely
to support this rule, and no tax or shipping calculation exists in this phase —
that is `0M.T`.

## 10. Physical goods and JIT Monacado Inventory

The same Merchant-of-Record model applies to eligible shipped physical goods
under **JIT Monacado Inventory** — *just-in-time economic inventory acquisition
with direct supplier fulfillment*:

```
buyer purchases from Monacado
  → Monacado acts as retailer and Merchant of Record
  → Monacado economically acquires the item at the time of sale under the
    applicable wholesale-acquisition policy
  → the seller / manufacturer / supplier fulfills directly to the buyer on
    Monacado's behalf
```

- Monacado need **not warehouse** the product.
- Monacado need **not take physical possession**.
- **Commercial acquisition and physical custody are distinct concepts**; the
  first is an economic event at the moment of sale, the second is a logistics
  arrangement.
- The seller or manufacturer remains the fulfillment party unless another
  fulfillment arrangement is later defined.
- **Shipping is not part of the wholesale-acquisition basis** (§9).

The **same standard policy** applies — there is no separate physical-goods rate.
The model has nowhere to express one: there is no product-kind, fulfillment-type,
or is-physical input, and a test asserts none exists.

No inventory, fulfillment, shipping, tracking, or warehouse logic is implemented
in this phase.

## 11. Offer-version binding

A promoted Listing binds to **one exact Offer source-record version** — the one
whose wholesale economics the promoter accepted. `AcceptedOfferDependency`
records the Offer identity, that exact version, the wholesale price accepted, the
commission-calculation policy version, and when acceptance happened.

**Not a copy of the Offer.** Only what was accepted is recorded; duplicating the
Offer would create a second, divergent answer to the seller's own terms.

> **Reconciled in this phase.** The Offer layer and the MoR layer are different
> economic layers and are now named distinctly: `offerWholesalePrice` is the fixed
> amount the seller contracted to be owed, and `morWholesaleAcquisitionAmount` is
> what Monacado pays the supply side, derived from retail. The promoter earns the
> spread between them **plus** the seller-funded commission, and the three-party
> identity balances to the commercial price exactly. What remains deferred is
> *settlement mechanics* — when and how each party is actually paid — which
> belongs to `0M.T` and `0M.9`.

## 12. Upstream review and reactivation

Three states, and the middle one is the point of the mechanism:

| State | Meaning |
| --- | --- |
| `NO_UPSTREAM_CHANGE` | The accepted version is still the relevant one |
| `REVIEW_REQUIRED` | Upstream economics moved materially; the promoter must explicitly accept |
| `ACCEPTED_CURRENT_VERSION` | The promoter explicitly accepted the current version |

**A wholesale-price change never silently reprices an active promoted Listing.**
The promoter agreed to a number, and a new number is a new agreement. A
review-required Listing is not buyer-active, so the old economics cannot keep
selling under new terms.

Review-forcing changes are `WHOLESALE_PRICE_CHANGED`, `COMMISSION_TERMS_CHANGED`,
and `OTHER_MATERIAL_OFFER_CHANGE`, reusing the Offer's own change categories.
`COMMERCIAL_AVAILABILITY_CHANGED` is deliberately absent: availability is handled
by upstream blocking, which stops the Listing selling without demanding the
promoter re-agree to economics that did not move.

**Acceptance is explicit.** No path upgrades an accepted version by observing a
new one — the caller must record a new `AcceptedOfferDependency`. Acknowledgement
alone never reactivates.

## 13. Upstream blocking

`evaluateListingBuyerEligibility` derives whether a Listing may be sold right
now, returning **every** failing reason rather than the first — a promoter fixing
one problem should not discover the next only after saving.

| Reason | Condition |
| --- | --- |
| `LISTING_NOT_ACTIVE` | the Listing's own lifecycle |
| `PRODUCT_UNAVAILABLE` | Product `generalAvailabilityState` is not `available` |
| `STOREFRONT_NOT_PUBLICLY_ACCESSIBLE` | via the Storefront's own `isPubliclyAccessible` |
| `CONTROLLING_PARTICIPANT_NOT_ACTIVE` | participant admission status |
| `CONTROLLING_ROLE_NOT_ACTIVE` | the controlling role assignment |
| `OFFER_NOT_COMMERCIALLY_SELECTABLE` | promoted only — Offer lifecycle/availability |
| `OFFER_VERSION_REVIEW_REQUIRED` | promoted only — review outstanding |

Upstream states are **supplied, not fetched**; the function reaches no database.
Each upstream entity's own rules decide its own domain — the Storefront's
accessibility helper, the Offer's lifecycle and availability — so nothing here
reinvents another entity's semantics or invents publication lifecycle.

## 14. Derived versus authoritative

Derived and never stored: effective seller retail price, sale-active status,
Monacado retained amount, MoR wholesale acquisition amount, promoter retail
spread, promoter net proceeds, promoter margin rate, seller proceeds, minimum
viable retail price, and buyer-active eligibility. A stored copy is a second answer that can
disagree with the first — the same reasoning that keeps `isLive` off the
Storefront and `completeness` off the participant profile.

Authoritative Listing facts are the **inputs**: prices, currencies, the sale
schedule, the accepted Offer dependency, lifecycle, and placement identity.

## 15. Source-record versioning

Follows the Offer and Storefront pattern exactly: a stable record with a pointer
to `currentSourceRecordVersion`, and immutable `ListingSourceVersion` snapshots
carrying identity, lineage (`supersedesSourceRecordVersion`), the complete
material state, an authorization trace, and `recordedAt`.

Snapshots, not deltas — a version that had to be replayed through its
predecessors would make reconstruction depend on an unbroken chain.
`MATERIAL_LISTING_FIELDS` names what mints a version;
`OPERATIONAL_ONLY_LISTING_FIELDS` names what does not. **A sale beginning or
ending is neither**: the schedule was the change, and the clock passing a
boundary is not a business decision anyone made.

## 16. Privacy boundary

A Listing source record has no field for a participant's private profile, an
account, an email address, a password or session, a payment-provider token,
underwriting data, risk scores or classifications, card-network risk data,
moderation notes, payout credentials, reserves, or payout holds. Every schema is
a `strictObject`, and `NEVER_ON_LISTING_SOURCE_RECORD` enumerates the refusals so
a test can assert each one.

**Risk reasoning stays private operational data and must never become a public
capsule fact.**

## 17. Deferred: risk management

Comprehensive risk management is explicitly out of scope. Not defined here:
high-risk classifications, provider or card-network scoring, reserves, payout
holds, transaction caps, velocity limits, manual-review policy, enhanced
verification, account restrictions, additive risk surcharges, and override
hierarchy.

The single architectural dependency this phase records is the one quoted in §7.
Everything else belongs to **0M.R — Risk Management and Commercial Controls**,
which must land before payment activation and buyer checkout become
production-capable.

## 18. Deferred: Listing persistence

No Prisma model, no migration, no repository, no service. The Listing joins
Offer and Storefront as a source model awaiting its persistence phase.

## 19. Deferred: Listing capsule

No capsule projection shape, no ontology term, no Node binding, no publication.
0M.4B will define the projection on the terms 0M.2B and 0M.3B established, and
must hold the authority partition ADR §2 requires: **a Listing may not restate or
override the creator's Product facts.**

## Reference

- [`AUTHORITATIVE_OFFER_SOURCE_MODEL.md`](AUTHORITATIVE_OFFER_SOURCE_MODEL.md) — wholesale economics this depends on
- [`AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md`](AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md) — placement container and accessibility rules
- [`PARTICIPANT_PERSISTENCE.md`](PARTICIPANT_PERSISTENCE.md) — the controlling participant
- [`STOREFRONT_CAPSULE_PROJECTION.md`](STOREFRONT_CAPSULE_PROJECTION.md) — the projection pattern 0M.4B will follow
- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
- [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) — binding ADR
- [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md) — the governing commercial model
- [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md)
