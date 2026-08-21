# Post-0E.7 Marketplace Roadmap (Track 0M)

Phase 0E.7 closed with an authenticated internal status route. Development now
leaves worker operations and resumes the marketplace sequence the thesis
describes.

This roadmap names the phases, in order, with the boundary each one must not
cross. It is a plan, not an authorization: **each phase begins only when
explicitly instructed**, and none of the deferred work below is started early
because it appears here.

## Sequence

Each publishable entity takes **three stages**, in this order:

1. **authoritative source model** — what the entity is, and who may change it;
2. **authoritative persistence** — the immutable source *versions* that actually
   exist in the database;
3. **capsule projection shape** — the deterministic public artifact derived from
   one of those versions.

That ordering is the bifurcated architecture made procedural — a projection
cannot be designed before the truth it projects exists (ADR §12;
[`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)).

> **The middle stage was originally missing from this plan.** Offer, Storefront,
> and Listing each received a source model and a projection shape with no
> persistence phase between them, so their projections could only ever be fed
> synthetic fixtures — the declared pipeline's `AUTHORITATIVE_SOURCE_VERSION`
> stage had nothing behind it. `0M.3C` closed that gap for the Storefront,
> `0M.6` for the Offer, and `0M.7` for the Listing — **every publishable entity
> now has all three stages.** Stage *2* may legitimately run after stage *3* for
> an entity whose projection already exists, as it did in all three.

### How phases are numbered

Two numbering conventions coexist, and neither supersedes the other.

- **Numeric `0M.x` phases are the primary implementation sequence.** From this
  point forward they increase monotonically: the next unstarted phase is always
  the next number, never a lower entity-family number.
- **Lettered `0M.N` / `0M.R` / `0M.T` phases are cross-cutting workstreams.**
  Their letter is thematic and **implies no chronological position** — each is a
  prerequisite that must land before the production capability it gates, and the
  Dependency order below states where each one falls.
- **Early entity-family phases used `A`/`B`/`C` suffixes** (`0M.2A`, `0M.3B`,
  `0M.3C`…) to keep an entity's source model, persistence, and projection
  visibly related. That convention is **retired for future work.** Entity lineage
  is now carried in the phase *description*, not by reusing a lower number.

### The `0M.x` sequence is closed

**The marketplace-foundation sequence ends at `0M.9`. There will be no `0M.10`.**

The `0M` track had one job: establish the authoritative records, contracts, and
governed decisions a marketplace needs before it can transact. `0M.9` finished
it — Listing → checkout → Order → payment result → immutable economics →
proceeds obligations → review eligibility all exist, all provider-neutral, all
tested. What was left was not another foundation phase; it was **executing** the
foundation against a real payment provider.

**Operational work is numbered from `1.0`.** The leading `0` in `0M` always meant
pre-operational, and continuing it past the point where real money moves would
have made the label say the opposite of what the system does. Numbering restarts
once, here, and increases monotonically from `1.0` onward.

- **No historical phase is renumbered.** `0M.1` through `0M.9`, and the
  cross-cutting `0M.N` / `0M.R` / `0M.T` workstreams, keep the labels they were
  committed under. A completed phase label is a historical identifier, and this
  document has said so since the `0M.6`/`0M.7` reservation was withdrawn.
- **The cross-cutting `0M` workstreams keep their labels and stay open.**
  `0M.T2`, `0M.R2`, and `0M.N2` are production gates on capabilities the `1.x`
  sequence turns on. Their letters were never chronological, so they do not
  become `1.x` merely because the numeric sequence moved.

**Completed phase labels are historical identifiers and are never reassigned.**
`0M.2A` means exactly what it meant when it was committed. In particular,
Storefront persistence stays `0M.3C` — the label under which it was actually
implemented — rather than being renamed to sit at the end of the sequence.

### Completed phases

Listed in the order the work was actually completed, which is not the order the
labels sort in.

| # | Phase | Title | State |
| --- | --- | --- | --- |
| 1 | **0M.1** | Account, role, activation, and review-authority architecture | **complete** — `084b315` |
| 2 | **0M.2A** | Authoritative Offer Source Model | **complete** — `4687772` |
| 3 | **0M.2B** | Offer Capsule Projection Shape | **complete** — `cb4a96d` |
| 4 | **0M.3A** | Authoritative Storefront Source Model | **complete** — `fe0f803` |
| 5 | **0M.2C** | **Offer economics correction** — required before any Listing pricing, checkout, or settlement | **complete** — `2ac467e` |
| 6 | **0M.5** | Participant persistence and draft onboarding | **complete** — `a316dd1`, draft-only |
| 7 | **0M.3B** | Storefront Capsule Projection Shape | **complete** — `f67383e` |
| 8 | **0M.4A** | **Authoritative Listing Source Model** — seller-controlled vs promoted, promoter retail price, upstream blocking | **complete** — `3d8dee7` |
| 9 | **0M.4B** | Listing Capsule Projection Shape | **complete** — `e6e6885` |
| 10 | **0M.3C** | **Storefront Persistence and Governance** | **complete** — `e93b9e9` |
| 11 | **0M.6** | **Offer Persistence** | **complete** — `7fdf745`, draft-only |
| 12 | **0M.7** | **Listing Persistence** | **complete** — draft-only |
| 13 | **0M.8** | **Payment-provider Onboarding and Activation** | **complete** — `d8424fa` |
| 14 | **0M.R1** | **Versioned Commercial Policy and Activation Risk Records** | **complete** — `4377fc1` |
| 15 | **0M.N1** | **Notification Obligation Records** | **complete** |
| 16 | **0M.T1** | **MoR Transaction Accounting Foundation** | **complete** |
| 17 | **0M.9** | **Buyer Checkout, Order, Commission, Payout, and Review-Submission Foundation** | **complete** — `6abc3ac`; **closes the `0M.x` sequence** |
| 18 | **1.0** | **Executable Checkout and Payment Integration (Stripe test mode)** — the first operational phase | **complete** — `cb5281f` |
| 19 | **1.1** | **Order Expiry and Buyer Notification Delivery** — the first concrete notification channel | **complete** — `a0dba2f` |
| 20 | **1.2** | **Pre-Live Commerce Controls** — tax boundary, reversal accounting, risk gate, payout hold, live-readiness gate | **complete** |

### Forward sequence

`0M.9` completed the first coherent buyer transaction flow — Listing → checkout →
Order → payment result → immutable transaction economics → commission/payout
obligations → review eligibility — and closed the `0M.x` sequence with it.

**`1.0` made that flow executable.** A buyer can now select a Listing, be quoted
from authoritative state, be charged through Stripe **test mode**, and have the
result confirmed by Stripe's own signed statement rather than by their browser.
The `0M.9` write path finalizes the sale unchanged.

What remains between here and money that is really Monacado's are the production
halves of the cross-cutting workstreams below — `0M.T2`, `0M.R2`, and `0M.N2` —
together with the live-mode gate itself, enumerated in
[`EXECUTABLE_CHECKOUT_AND_STRIPE_TEST_MODE.md`](EXECUTABLE_CHECKOUT_AND_STRIPE_TEST_MODE.md).
**No unstarted `1.x` phase is authorized by appearing here.**

**`1.1` closed the operational gaps `1.0` left in the buyer's experience**: an
abandoned checkout now resolves on Stripe's own `checkout.session.expired`, and
buyers — guests included — are actually told what happened.

**`1.2` built the minimum controls live money requires**, and deliberately did not
enable it: a mandatory tax boundary, reversal accounting, a transaction risk gate,
a payout hold, and a readiness evaluation that **fails closed and currently cannot
pass**.

**What remains is the operational half of each workstream**, not another feature:

| Next | Why it is next |
| --- | --- |
| **`0M.T2` — tax operations** | `1.2` supplied the boundary and evidence; nexus determination, product tax classification, sourcing, exemption certificates, filing, and remittance remain. **And the destination problem**: a real engine needs to know where the buyer is, and Monacado collects no address. **The hardest blocker to live mode.** |
| **`0M.R2` — risk operations** | `1.2` supplied a ceiling, restriction and approval checks, and a payout hold. Velocity limits, reserves, per-transaction policy selection, and a review function remain — and a scoring model without somebody to review its output would produce refusals nobody can explain. |
| **`0M.N2` — the canonical channel** | `1.1` built a *supplemental* channel. The admin-panel view, the `SUPER_OWNER`/`ADMIN` visibility rule, and notification preferences remain unbuilt. It also owns the **pre-live gate `1.1` recorded rather than solved**: delivery is at-most-once with no retry, and a guest's address cannot be recovered from a digest, so a failed guest receipt cannot be re-sent from Monacado's data alone. |
| **Live-mode Stripe support** | Does not exist. `STRIPE_MODES` has one member, so `LIVE_PROVIDER_NOT_ENABLED` is reported by construction and no configuration clears it. Building it is a deliberate, reviewed phase. |

| Later operational candidate | Why not now |
| --- | --- |
| **Digital delivery** — entitlements, artifacts, grants, tokens, the download endpoint, seller re-download authorization | `1.2` declared the **policy** (durable entitlement vs transient token, five self-service successful downloads, seller-owned exceptions, no permanent secret URLs) and built none of the machinery. No persistence was needed: `PurchaseEvidence` and the Product's `deliveryMode` already anchor a future entitlement without rewriting Order or Product semantics |
| **Payout execution** — proceeds to sellers and promoters through Connect | `1.0` reads Connect readiness through `0M.8`'s port and creates no transfer. Payouts need `0M.R2`'s holds, reserves, and caps first; paying out without them is paying out irreversibly |
| **Seller/promoter Connect onboarding UI** | The test-mode adapter and the account-link call exist; nothing renders them. It needs the participant-facing surface `0M.8` deferred |
| **Refunds, chargebacks, and reversal accounting** | `0M.T2`'s subject. A live processor produces all three within days |

| Cross-cutting phase | Title | State |
| --- | --- | --- |
| **0M.N** | **Notification Records** — durable admin-panel notices, deduplication, recipients, notice states | **`0M.N1` complete**; `0M.N2` not started |
| **0M.R** | **Risk Management and Commercial Controls** — required before the **production** payment and commerce capabilities it governs are enabled; **not** a prerequisite to `0M.8` | **`0M.R1` complete**; `0M.R2` not started |
| **0M.T** | **Tax, MoR and Transaction Accounting** — required before checkout/payment architecture is production-capable; its `0M.T1` foundation is a prerequisite to `0M.9`, **not** to `0M.8` | **`0M.T1` complete**; `0M.T2` not started |

### Dependency order

The intended primary sequence, with the cross-cutting phases placed at the point
they gate:

1. ~~**`0M.6` — Offer Persistence.**~~ **Complete.**
2. ~~**`0M.7` — Listing Persistence.**~~ **Complete.** A promoted Listing binds
   an exact Offer source version through a composite foreign key onto the
   `(offerSourceRecordId, sourceRecordVersion)` key `0M.6` established.
3. ~~**`0M.8` — Payment-provider Onboarding and Activation.**~~ **Complete.** It
   moved no money and created no transaction, so no part of `0M.R`, `0M.T`, or
   `0M.N` was a prerequisite to it — and none was implemented alongside it.
4. ~~**`0M.R1` — Versioned Commercial Policy and Activation Risk Records.**~~
   **Complete.** The wholesale-acquisition policy now has an authoritative
   versioned home, so `0M.T1` has an exact `(policyId, policyVersion)` to bind
   an Order to; and `RESTRICTED` has machine-readable evidence, so the status
   `0M.8` refused to write now means something a later reader can act on.
5. ~~**`0M.N1` — Notification Obligation Records.**~~ **Complete.** Durable
   records; delivery is `0M.N2`. The governed Offer-change notice obligation is
   now recorded and deduplicated, and the model takes `0M.9`'s categories
   without a schema change.
6. ~~**`0M.T1` — MoR Transaction Accounting Foundation.**~~ **Complete.** The
   immutable per-sale economic snapshot, bound by composite foreign key to the
   exact Listing source version, the exact Offer source version where promoted,
   and the exact `(policyId, policyVersion)` `0M.R1` established — so a recorded
   sale's economics do not move when any of the three does. Settlement standing
   and the provider transaction reference live on a separate row, so the economic
   facts have no update path at all.
7. ~~**`0M.9` — Buyer Checkout, Order, Commission, Payout, and Review-Submission
   Foundation.**~~ **Complete.** Guest and account checkout, Order persistence, a
   provider-neutral payment port with no adapter behind it, the atomic
   successful-sale write, seller and promoter proceeds obligations, and the first
   real `ReviewSubmissionAuthority` rows.
8. ~~**`1.0` — Executable Checkout and Payment Integration.**~~ **Complete.**
   The first operational phase. Stripe's server SDK, concrete adapters behind the
   provider-neutral ports, hosted Checkout Sessions keyed on the Order id,
   webhook-confirmed payment results, three minimal routes, and a buyer UI with
   no client JavaScript. **Stripe test mode only**, and structurally so.
9. ~~**`1.1` — Order Expiry and Buyer Notification Delivery.**~~ **Complete.**
   Stripe's `checkout.session.expired` cancels a still-pending Order through
   `0M.9`'s own `cancelOrder`, creating no economics and never downgrading a
   `PAID` sale. The first concrete notification channel delivers buyer receipts,
   failure notices, and expiry notices — **including to guests, with no
   participant fabricated** — plus supplemental notices to sellers and promoters.
   Delivery evidence is persisted; the address is not.
10. ~~**`1.2` — Pre-Live Commerce Controls.**~~ **Complete.** A mandatory
    provider-neutral tax boundary that **refuses rather than defaults**, tax
    evidence explaining every charge, full reversal accounting recorded **beside**
    the immutable snapshot rather than editing it, a narrow synchronous risk gate
    on a versioned policy, a payout hold reusing `0M.R1`'s own restriction
    records, and a live-commerce readiness evaluation that fails closed. **No
    live-money operation was implemented**, and Stripe remains test-mode only.

Later, as production gates rather than sequence steps: **`0M.R2`** (transaction
and commercial risk enforcement), **`0M.T2`** (tax execution, nexus, remittance,
filing, refund/reversal operations), and **`0M.N2`** (notification delivery
channels).

**The binding rules are three.** Offer and Listing persistence must precede any
payment or checkout implementation. A cross-cutting phase sits where its actual
dependency requires it — never earlier merely because it appears in a list, and
never later than the capability it gates. And the production halves of risk, tax,
and notification must be complete before the production capabilities they govern
are enabled, which is a later gate than the phases above.

> **This list is chronological.** The earlier revision placed `0M.R`, `0M.T`, and
> `0M.N` at step 3, ahead of `0M.8`, which read as requiring all three
> cross-cutting phases before payment-provider onboarding. That was never the
> intent and is corrected here. Only the ordering wording changed; no phase scope
> moved.

**Every publishable marketplace entity now has all three stages** — a source
model, authoritative persistence, and a capsule projection shape. The middle
stage that was missing from the original plan is closed everywhere, and `0M.8`
has given the payment-provider axis real storage and written the first governed
activation decisions. Notification records, risk management, tax and transaction
accounting, checkout, and settlement remain **not started** — no contract, no
persistence, no route, no orchestration.

**0M.5 ran ahead of 0M.3B**, out of label order, because every completed 0M
contract terminates at a `mon:mpart:` identity that had no table: Offer
authority, Storefront ownership, and all twelve capability decisions were
unreachable from persisted state. It is **draft onboarding only** — no activation
approval, no payment provider, no Node, no capsule, no route, no UI. 0M.3B then
completed the Storefront source-model/projection pair, and 0M.3C supplied the
persistence stage that pair had been missing.

**No entity is published yet.** Product is the only entity with a publication
path, and it stays gated off. Storefront, Offer, and Listing now all have
persistence, but none has a Node and none has a publication path.

**Monacado's commercial model is Merchant-of-Record.** Monacado is the retailer
and buyer-facing counterparty, and acquires each item at the moment of sale under
a versioned wholesale-acquisition policy — currently 92.5% of the commercial
retail price minus $1.00. There is no separate platform fee. The governing
description is [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md),
which carries a governance rule: material changes to the MoR role, the
wholesale-acquisition formula, tax or shipping treatment, fulfillment
responsibility, settlement, or risk-policy application must update that document
before or with implementation.

> **Renumbering history.** Two renumberings have occurred, and neither altered a
> committed phase number.
>
> 1. Splitting Storefront and Listing into their own source-model/projection
>    pairs consumed the numbers 0M.3 and 0M.4, so participant persistence,
>    payment onboarding, and checkout moved from 0M.4/0M.5/0M.6 to
>    0M.5/0M.6/0M.7.
> 2. The missing persistence stage was then reserved *backwards*, as `0M.2D` and
>    `0M.4C`, which pointed the next phase at a number lower than completed work.
>    Those two reservations are withdrawn and reissued as **`0M.6`** and
>    **`0M.7`**, and payment onboarding and checkout move to **`0M.8`** and
>    **`0M.9`**. Only unstarted work moved.
>
> **The order of the work is unchanged**; only the labels of unstarted phases
> moved. No committed phase number was altered — 0M.1 means exactly what it meant
> when it was committed, and the same holds for 0M.3C.
>
> **Committed comments were corrected with it.** Source, Prisma schema, and test
> comments written before this normalization forward-referenced payment-provider
> onboarding and the governed activation review as `0M.6`; all nine now read
> `0M.8`. The edits were comment-text only — no Prisma model, contract, service,
> or test logic changed. A bare `0M.6` anywhere in the repository now means
> **Offer Persistence**, with no legacy reading to apply.

---

## 0M.1 — Account, role, activation, and review authority architecture

**Complete.** Reconciles the Phase 0E.7.4.2A identity foundation with the
marketplace's participants, roles, activation lifecycle, and Buyer review
authority.

- `Account` versus `MarketplaceParticipant`, and why activation never enters
  account status.
- Additive SELLER / PROMOTER / BUYER roles; `INTERNAL_OPERATOR` is not one.
- Guest Buyer as the absence of an identity, never a silently created account.
- Three independent lifecycles — participant admission, role assignment, payment
  readiness — with explicit transition tables.
- Twelve pure capability decisions with bounded reason codes.
- Buyer review authority: the submission authorizes that review's capsule and
  nothing else.
- Proposed relational models, documented and **not** migrated.

Full detail:
[`MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md`](MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md).

## 0M.2A — Authoritative Offer Source Model

**Complete.** The authoritative record and immutable source versions for
seller-authorized commercial terms: fields, operational lifecycle, commercial
availability, price and promotion terms, Seller authority decisions, and the
material-change policy that decides when a new source version is minted.

**Must hold:** the Product/Offer boundary stays where ADR §10.2 put it — price,
currency, availability windows, territory, and checkout eligibility belong to the
Offer, never to `generalAvailabilityState` on the Product. Authority is
transactional (`sellerParticipantId`); no Creator Node or other public semantic
identity is introduced.

**Not in scope:** the capsule projection shape, projection mapping, Node or
capsule identity, publication, persistence, checkout, or pricing logic.

Full detail:
[`AUTHORITATIVE_OFFER_SOURCE_MODEL.md`](AUTHORITATIVE_OFFER_SOURCE_MODEL.md).

## 0M.2B — Offer Capsule Projection Shape

**Complete.** The deterministic projection of an Offer source version,
following the Product pattern: authored Zod schema, ontology and context terms,
canonical hashing, and derived JSON Schema — plus a strict projection context
carrying the Node bindings, and a bounded eligibility decision.

**Must hold — the database-first one-way boundary (ADR §12):** the projection
reads **one identified `OfferSourceVersion`**, never the current record and never
"the latest". It adds no field to the Offer source model, creates no provenance,
and **writes nothing back**. Monacado remains Publisher and Registrar; the
`mon:offer:` identity stays internal, and public Node references come only from
the validated projection context.

**Not in scope:** publication, Node issuance or registration, Registrar
interaction, persistence, and the `SUSPENDED`/`WITHDRAWN` publication decision.

Full detail:
[`OFFER_CAPSULE_PROJECTION_SHAPE.md`](OFFER_CAPSULE_PROJECTION_SHAPE.md).

## 0M.3A — Authoritative Storefront Source Model

**Complete.** The authoritative Storefront record and its immutable source
versions, following the source-model-before-projection ordering 0M.2A/0M.2B
established: participant ownership, lifecycle and visibility as separate axes, a
strict public handle, bounded presentation text, six authority decisions, and the
material-change policy.

**Must hold:** a Storefront belongs to **one participant and to no role** — roles
are additive capabilities, not Storefront types, and a Storefront may later hold
owned Listings, promoted Listings, or both. Placement authority is evaluated **per
Listing**, against the roles its owner holds at that moment. It **embeds no
Product, Offer, or Listing array** — Listings reference Storefronts, not the
reverse.

Governance is a second axis: exactly one active **`SUPER_OWNER`** is required
before a Storefront may go live and holds financial responsibility; zero or more
**`ADMIN`** assignments hold operational authority only. Monacado's **go-live
approval** is a supplied decision input, never a Storefront field, and **live** is
derived — there is no stored `isLive`.

**Not in scope:** the capsule projection shape, ontology terms, Node or capsule
identity, persistence, publication, routes, UI, and all Listing or placement
work.

Full detail:
[`AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md`](AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md).

## 0M.2C — Offer economics correction (required)

**Complete.** The committed Offer contracts (`0M.2A`, `0M.2B`) were written
before the final wholesale-price interpretation and are corrected here, **before
any Listing pricing, checkout, or settlement implementation begins.**

Corrected: wholesale-price terminology; `PERCENT_OF_WHOLESALE` and `FIXED_AMOUNT`;
deterministic BigInt half-up commission calculation under
`WHOLESALE_COMMISSION_V1`; exact creator commission and gross-proceeds disclosure;
creator confirmation bound to **both** the Offer source-record id and its version
label, which a material change invalidates by construction; **multi-category**
business-change classification in a deterministic order; and the Offer capsule's
public economic shape, pinned to capsule version **`2.0.0`** and mapping version
**`offer-projection/2.0.0`** exactly.

No Offer persistence or production publication exists, so **no migration or
republishing is performed**.

The correction addressed:

- **wholesale-price terminology** — the Offer's price is what the *creator*
  receives, not what a buyer pays;
- **`PERCENT_OF_WHOLESALE`** and **`FIXED_AMOUNT`** as the commission methods;
- **deterministic commission calculation**, including minor-unit rounding;
- **exact creator-proceeds presentation** — the creator must see the precise
  commission and expected gross proceeds before Offer activation;
- **immutable Offer-version economics** — a completed sale binds to the exact Offer
  source version, and later Offer changes never alter an accepted order;
- **compatibility with the existing Offer capsule projection**, which is already
  committed and published-shaped.

The downstream behaviours documented below — availability flow-through,
wholesale-price review with Listing deactivation, commission-change notice without
deactivation, and canonical admin-panel notices — are **documented policy only**.
0M.2C implements none of them; they belong to the Listing and notification phases,
which have not started.

**Do not start this correction as part of 0M.3A.** The economics are documented in
[`AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md`](AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md)
§3; no committed Offer file is modified there.

## 0M.3B — Storefront Capsule Projection Shape

**Complete.** The deterministic Storefront projection, on the same terms as
0M.2B: authored Zod shape, ontology and context terms, canonical hashing, and
derived JSON Schema — plus a strict projection context carrying the Node
bindings, a bounded eligibility decision, and a re-derivation verifier.

**Must hold — and held:** the projection reads **one identified
`StorefrontSourceVersion`**, never the current record and never "the latest". It
adds no field to the Storefront source model, creates no provenance, and **writes
nothing back**; there is no inverse mapper. The public field set is exactly
0M.3A's `PROJECTION_ELIGIBLE_STOREFRONT_FIELDS`, with governance, account,
private-profile, payment, and moderation data refused by an allow-list rather
than a denylist. `mon:storefront:` stays internal, and public Node references come
only from the validated projection context.

**Not in scope:** publication, Node issuance or registration, Registrar
interaction, persistence, routes, UI, and the `SUSPENDED`/`CLOSED` publication
decision.

Full detail:
[`STOREFRONT_CAPSULE_PROJECTION.md`](STOREFRONT_CAPSULE_PROJECTION.md).

## 0M.3C — Storefront Persistence and Governance

**Complete.** The authoritative Storefront record, its immutable source-record
versions, and its governance assignments — the middle stage that was missing
between `0M.3A` and `0M.3B`. A persisted source version now feeds the existing
capsule projection without a synthetic fixture, producing a byte-identical
capsule to the equivalent in-memory source.

Three tables, all foreign keys `RESTRICT` and **no `CASCADE` anywhere**:
`Storefront` (stable identity plus current-version pointer), 
`StorefrontSourceRecordVersionRow` (immutable snapshots), and
`StorefrontGovernanceAssignment`.

**Must hold — and held:** history is immutable and a material change mints a new
version rather than editing one; the pointer advances in the same transaction, so
a stable record can never point at a version that does not exist; handle
uniqueness applies to current Storefronts while history preserves the handle each
version actually authorized; at most one active `SUPER_OWNER` per Storefront is
enforced by a unique index, with the "at least one" half remaining a go-live
readiness question; and **go-live approval is still a supplied decision input,
with no column anywhere to store it**.

Creating a Storefront deliberately confers **no** governance authority — the
owner must appoint the first `SUPER_OWNER`, which they may do for themselves.

**Not in scope:** Storefront Node issuance, publication, the go-live approval
workflow, Offer or Listing persistence, routes, and UI.

Full detail:
[`STOREFRONT_PERSISTENCE.md`](STOREFRONT_PERSISTENCE.md).

## 0M.4A — Authoritative Listing Source Model

**Complete.** The authoritative Listing record and its immutable source versions:
the buyer-facing placement of a Product in a Storefront, as either a
seller-controlled direct sale or a promoter-controlled resale under an Offer.

Delivered: the `SELLER_DIRECT` / `PROMOTED` discriminated split; seller-only
scheduled sale pricing with half-open UTC timing and a supplied instant;
promoter retail-price autonomy; deterministic non-negative promoter economics in
integer minor units; exact Offer-source-version binding; the wholesale-change
review state with **explicit** reactivation; deterministic upstream blocking; and
the immutable source-version shape.

**Held:** a seller's temporary sale is structurally isolated — it changes no
wholesale price, mints no Offer version, alters no promoted Listing, and creates
no promoter obligation, because a seller placement has no field through which it
could. A promoter's retail-price change never amends the Offer.

**Monacado is the Merchant of Record, not a fee collector.** Listing economics
consume an externally supplied, versioned **wholesale-acquisition policy**:
Monacado retains a percentage plus a fixed amount from the commercial retail
price and acquires the item for the remainder. The earlier "platform fee charged
to the promoter" framing was corrected before commit — it double-counted
Monacado's retention. No rate is hard-coded; policy lookup, risk adjustment, and
override selection belong to `0M.R`.

The seller / promoter / Monacado reconciliation balances exactly to the
commercial retail price, and the Offer's `wholesalePrice` and the MoR
`wholesaleAcquisitionAmount` are named distinctly because they are different
economic layers. Tax and shipping are outside every basis, and the same policy
applies to physical goods under **JIT Monacado Inventory** — just-in-time
economic acquisition with direct supplier fulfillment, requiring no Monacado
warehousing or physical possession.

**Not in scope:** persistence, capsule projection, Node, publication, checkout,
payment, notification delivery, and risk-management policy selection.

Full detail:
[`LISTING_SOURCE_MODEL.md`](LISTING_SOURCE_MODEL.md).

## 0M.4B — Listing Capsule Projection Shape

**Complete.** The deterministic Listing projection, on the same terms as 0M.2B
and 0M.3B: authored Zod shape, ontology and context terms, canonical hashing, and
derived JSON Schema — plus a strict projection context carrying five Node
bindings and the upstream state, a buyer-eligibility gate, and a re-derivation
verifier.

The public claim set is deliberately small — `listingType`, a self-describing
buyer-facing price, and three Node relationships. A seller-direct price publishes
the ordinary price **and** any scheduled sale, so the capsule stays semantically
correct as time advances and **no publication is required merely because a sale
starts or ends**. **No Monacado economics reach it**:
not the retained amount, the MoR wholesale acquisition amount, the policy
identity, the minimum viable price, nor any party's proceeds, spread, or margin.
No Offer internal reaches it either — the mapper never reads the Offer
dependency.

**A promoted Listing publishes no Offer reference**, deliberately: the Offer
capsule publishes its own wholesale price, so a reference would let a consumer
subtract it from this retail price and recover the promoter's spread. A reference
that discloses by composition discloses just the same.

**Must hold — and held:** the projection reads **one identified
`ListingSourceVersion`**, never the current record; it creates no provenance and
**writes nothing back**; there is no inverse mapper. Only a purchasable Listing
projects at all, using the source model's own eligibility decision rather than a
second copy of the upstream rules, and the refusal carries one coarse reason so a
public failure cannot probe a seller's standing. Tax and shipping are outside the
price. The authority partition ADR §2 requires holds — a Listing restates no
Product fact.

**Not in scope:** publication, Node issuance, Registrar interaction, persistence,
checkout, tax, shipping, fulfillment, routes, and UI.

Full detail:
[`LISTING_CAPSULE_PROJECTION.md`](LISTING_CAPSULE_PROJECTION.md).

## 0M.5 — Participant persistence and draft onboarding

**Complete.** The first phase in this track to touch the database. Migrates
`MarketplaceParticipant`, `MarketplaceRoleAssignment`, `ParticipantProfile`, and
`ParticipantActivation` from the 0M.1 §9 design, and wires the twelve 0M.1
capability decisions to real rows behind an application service that
materializes `MarketplaceSubject`.

Settles 0M.1's open decisions 1, 2, and 4: one neutral `Participant` identity
with additive roles rather than separate Creator/Seller identities; email
verification and terms acceptance are operational onboarding gates, never capsule
facts; and the public participant projection is a closed allow-list that excludes
private profile, credentials, payment state, and account/session data. No
`AuthenticatedPrincipal` change was needed — this phase adds no route.

Also resolves `ProductSourceRecordVersionRow`'s long-deferred creator FK, as an
**additive nullable** `authorityCreatorParticipantId` beside the untouched
`mon:creator:` column — the same migration-safety pattern
`RegistrarReceipt.submissionAttemptId` used in 0E.5.3.

**Held:** drafting only. No activation approval, no payment provider, no Node, no
capsule, no publication, no route, no UI.

Full detail:
[`PARTICIPANT_PERSISTENCE.md`](PARTICIPANT_PERSISTENCE.md).

## 0M.6 — Offer Persistence

**Complete.** The authoritative Offer record, its immutable source-record
versions, and the narrow service over them — the middle stage that was missing
between `0M.2A` and `0M.2B`. A persisted source version now feeds the existing
capsule projection without a synthetic fixture, producing a byte-identical
capsule to the equivalent in-memory source.

Two tables, both foreign keys `RESTRICT` and **no `CASCADE` anywhere**: `Offer`
(stable identity plus current-version pointer) and
`OfferSourceRecordVersionRow` (immutable snapshots). Six FKs in total, to
`Product` and `MarketplaceParticipant` as well as to the Offer itself.

**Must hold — and held:** history is immutable and a material change mints a new
version rather than editing one; the pointer advances in the same transaction, so
a stable record can never point at a version that does not exist; the `0M.2C`
wholesale economics are preserved exactly and **no new commission algorithm was
minted** — `calculateOfferEconomics` computes, persistence stores, and the
contract re-checks on the way out; and the
`(offerSourceRecordId, sourceRecordVersion)` unique key gives `0M.7` the exact
accepted version a promoted Listing must bind to, with no dependence on mutable
state, a capsule hash, or publication.

**Draft-only, structurally.** `0M.2A` gates activation behind the full commerce
test, which this phase fails twice over — `PARTICIPANT_NOT_ACTIVATED` (activation
is a governed decision `0M.5` does not make) and `PAYMENT_NOT_ENABLED` behind it
(no payment record until `0M.8`). No override was added; weakening either gate
would let an unactivated, unpayable seller sell.

**Not in scope:** Offer Node issuance, publication, Listing persistence, routes,
and UI. Monacado's retail retention and the promoter's retail price are
deliberately **not** Offer facts and appear nowhere in the schema.

Full detail: [`OFFER_PERSISTENCE.md`](OFFER_PERSISTENCE.md).

## 0M.7 — Listing Persistence

**Complete.** The authoritative Listing record, its immutable source-record
versions, and the narrow service over them — the **last** missing middle stage.
A persisted source version now feeds the existing capsule projection without a
synthetic fixture, producing a byte-identical capsule to the equivalent canonical
in-memory source.

Two tables, ten foreign keys, all `RESTRICT` and **no `CASCADE` anywhere**:
`Listing` (stable identity plus current-version pointer) and
`ListingSourceRecordVersionRow` (immutable snapshots).

**Must hold — and held:** the `SELLER_DIRECT` / `PROMOTED` discriminated union is
preserved rather than collapsed, so neither branch can acquire the other's
fields; a promoted Listing binds **one exact persisted Offer source version**
through a composite foreign key, which makes it structurally impossible to name a
version that does not exist, to delete one a Listing depends on, or to drift onto
the Offer's current-version pointer; and **no derived value is stored** — not the
effective price, not sale-active status, and none of the MoR reconciliation — so
a sale starting or ending requires no database write at all.

**Draft-only, as expected.** Listings persist while remaining non-buyer-active: a
drafting participant is not `ACTIVE` and a draft Storefront is not publicly
accessible. No gate was bypassed to change that.

**Not in scope:** Listing Node issuance, publication, checkout, payment, tax,
shipping, fulfillment, routes, and UI. Monacado's retention, the promoter's
spread, tax, and shipping are deliberately **not** Listing facts and appear
nowhere in the schema.

Full detail: [`LISTING_PERSISTENCE.md`](LISTING_PERSISTENCE.md).

## 0M.N1 — Notification Obligation Records

**Complete.** The first half of `0M.N`: the durable record that Monacado **owes**
a notice, and its lifecycle. **It sends nothing** — there is no channel,
template, body, address, or delivery attempt anywhere, and `0M.N2` owns all of
it.

One table, `NotificationObligation`, `RESTRICT` to its recipient participant.

**Must hold — and held:** the governed §3a rule is enforced by a **unique index**
rather than by discipline — one obligation per promoter participant × exact Offer
source version × change category, so a promoter carrying one Offer in five
storefronts receives one notice; the notice binds to the **exact** effective
Offer source version, and recipients are derived from persisted promoted Listings
rather than supplied, because a caller naming its own list could miss the
promoter the notice exists for; the committed `classifyOfferBusinessChanges` is
**reused, never restated**, so a notice cannot disagree with the classification
about what changed; recording is **idempotent**, and a replay never returns an
acknowledged obligation to unread; recipients are **participants, never
addresses**; and archiving is not deletion.

**`0M.9`-ready by construction.** Category and subject are separate axes, so an
order confirmation is a new vocabulary member and a new subject kind — not a new
table and not a column added to an Offer-shaped schema. Seven future categories
are named with no producer, and a test keeps "named" and "implemented" distinct.

Full detail:
[`NOTIFICATION_OBLIGATION_RECORDS.md`](NOTIFICATION_OBLIGATION_RECORDS.md).

## 0M.N — Notification records (`0M.N1` complete; `0M.N2` deferred)

Defines: durable **admin-panel** notices as the canonical channel;
deduplication as one obligation per **promoter participant × exact Offer source
version × change category**; recipients (the promoter participant's active
`SUPER_OWNER` and `ADMIN`); the unread / acknowledged / resolved / archived states;
and optional supplemental delivery channels that can never replace the
admin-panel notice.

**`0M.N1` implemented the obligation half** — deduplication, recipients, and the
four states, above. **`0M.N2` remains deferred**: rendering, the admin-panel
view, the `SUPER_OWNER`/`ADMIN` visibility rule, and every supplemental delivery
channel. The governing rules are recorded in
[`AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md`](AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md)
§3/§3a and remain binding on both.

## 0M.R1 — Versioned Commercial Policy and Activation Risk Records

**Complete.** The first half of `0M.R`, and the narrowest useful one: the
versioned commercial policy `0M.T1` will bind transactions to, and the
machine-readable restriction scope `0M.8` refused to invent.

Three tables. `CommercialPolicy` (stable `mon:cpol:` identity) and
`CommercialPolicyVersionRow` (immutable versions keyed by
`(policyId, policyVersion)`, the same composite the Offer source versions use);
`ParticipantRestriction` (the evidence behind a `RESTRICTED` status). All foreign
keys `RESTRICT`.

**Must hold — and held:** the database became authoritative for commercial policy
while the committed `MonacadoWholesaleAcquisitionPolicy` stayed the shape, so
**no second implementation of the economics was written** and the 0M.4A
calculators consume a reconstructed version unchanged; policy history is immutable
and a rate change mints a new version, with a retired version still bindable so a
past transaction stays reproducible; **no derived economics are stored**, and no
rate is compiled into any module; and "the effective policy" has exactly one
answer, enforced by a unique index rather than by discipline.

**`RESTRICTED` gained meaning.** A restriction names a member of the committed
`MARKETPLACE_CAPABILITIES` vocabulary — narrowed to commerce, because a
restriction withholds commerce and never the ability to correct the work that
caused it — with a bounded reason code and no private provider or underwriting
content. A participant is never `RESTRICTED` without active evidence, the two are
written in one transaction, and lifting is a state change that preserves history
rather than a delete.

**`SUSPENDED` stayed phase-gated.** This phase's model expresses
capability-scoped withholding, which is what `RESTRICTED` means; suspension is
admission withdrawn wholesale — a different governed act needing its own decision
path and evidence. The distinction was not invented here.

**Authority is a new internal `AccountEntitlement`, `participant:restrict`** —
separate from `activation:review`, which authorizes deciding one admission and
would have been silently widened. No marketplace role or ownership confers it,
and 0M.8's self-review prohibition extends to restriction in both directions.

**No transaction-risk machinery**: no cap, velocity check, fraud score, payout
hold, reserve, chargeback control, or manual-review queue. Those are `0M.R2`.

Full detail:
[`VERSIONED_COMMERCIAL_POLICY_AND_ACTIVATION_RISK.md`](VERSIONED_COMMERCIAL_POLICY_AND_ACTIVATION_RISK.md).

## 0M.R — Risk Management and Commercial Controls

**Partly complete.** Platform-wide risk-adjusted commercial controls, and the
phase that must land **before the production payment and commerce capabilities it
governs are enabled**. **`0M.R1` delivered the foundation half** — the versioned
commercial policy and the activation restriction records, above. What remains is
`0M.R2`: transaction and commercial risk enforcement.

> **"Before payment activation" means production enablement, not `0M.8`.** The
> earlier wording was ambiguous: *payment activation* could be misread as `0M.8`'s
> governed **participant**-activation decision, which would make all of `0M.R` a
> `0M.8` blocker. It never was. `0M.8` is explicitly permitted to persist provider
> onboarding and readiness state, record provider requirements, record provider
> `ENABLED` / `DISABLED` readiness, conduct the governed activation review,
> approve an eligible participant to `ACTIVE`, and record `REJECTED` or
> `MORE_INFORMATION_REQUIRED` — with no part of `0M.R` in place.
>
> **`0M.8` must not write `RESTRICTED` or `SUSPENDED`.** Both mean *admitted, some
> capability withheld* (`0M.1` §4.1), and nothing in the repository yet expresses
> **which** capability — `capability.ts` only tests `status !== "ACTIVE"`. Writing
> either would record a status with no machine-readable meaning. They require a
> machine-readable restriction/risk scope, which belongs to **`0M.R1`**; `0M.8`
> refuses them behind a phase gate, as `0M.5` did for `ACTIVE`. The restriction
> model is not designed here.

Its scope will include the versioned Monacado **wholesale-acquisition policy**
that Listing economics already consume as a supplied input — policy lookup,
applicability, and override selection — together with the risk controls that
adjust commercial terms. 0M.R may supply a higher, lower, or otherwise different
effective policy per transaction, participant, or product class.

**Deliberately not designed yet.** Risk classifications, provider and
card-network scoring, reserves, payout holds, transaction caps, velocity limits,
manual-review policy, enhanced verification, account restrictions, additive
surcharges, and override hierarchy are all named here only to record that they
belong to this phase and to no earlier one.

**Must hold:** risk classifications are **private operational data** and must
never become public capsule facts.

## 0M.T1 — MoR Transaction Accounting Foundation

**Complete.** The immutable per-sale economic snapshot `0M.9` writes its first
real Order and payment against. Monacado must not create a transactional payment
record it cannot account for, and this is the record.

Two tables, and the split is the point. `TransactionEconomicSnapshot` holds
economic facts and has **no update path at all** — no service operation writes to
it after the insert, and it has no `updatedAt` column because nothing updates it.
`TransactionSettlement` holds what legitimately moves: settlement standing and
the provider transaction reference. Recording provider evidence therefore targets
a different table from the one holding what the parties earned.

**The binding is structural.** Three composite foreign keys onto the unique keys
`0M.6`, `0M.7`, and `0M.R1` established — the exact Listing source version, the
exact Offer source version where promoted, and the exact
`(policyId, policyVersion)`. All `RESTRICT`. Every binding names a version
*label*; no code path in the phase reads a current-version pointer, and the policy
lookup is `getCommercialPolicyVersion` rather than the effective one. A seller
reprices, a seller renegotiates, Monacado replaces the rate — the recorded sale
reproduces exactly, and a `RETIRED` policy version stays bindable so that it can.

**Must hold — and held:** the economics are 0M.4A's calculators consumed
unchanged, so **no second implementation of the MoR, commission, or
promoter-spread arithmetic was written**; the retail price is *read* from the
bound version at the sale instant rather than supplied, so a scheduled sale
window prices itself and no caller can invent a price the Listing never offered;
the accounting identity is checked before the write and an imbalance is refused
rather than recorded; and tax, shipping, and pass-through amounts are recorded
but enter **no** basis — structurally, because `CommercialRetailBasis` has no
field for any of them.

**Seller-direct and promoted are a discriminated union.** A seller-direct
snapshot has no field for an Offer binding, a wholesale price, a commission, a
spread, or promoter proceeds — nowhere to go, rather than a zero that would
describe a promoter who earned nothing.

**Settlement is four provider-neutral states** — `PENDING`, `FUNDS_RECEIVED`,
`SETTLED`, `REVERSED` — and `REVERSED` is a *state, not a workflow*: no reversal
amount, no partial reversal, no recovery from seller or promoter economics, no
refund-versus-chargeback distinction. It exists now so that provider reversal
evidence arriving does not require rewriting a financial row's schema.

**No checkout, payment execution, tax calculation, nexus determination,
remittance, payout, refund, chargeback, or processor reconciliation.** No Order
either — `0M.9` mints those and binds one with an additive nullable column.

Full detail:
[`MOR_TRANSACTION_ACCOUNTING_FOUNDATION.md`](MOR_TRANSACTION_ACCOUNTING_FOUNDATION.md).

## 0M.T — Tax, MoR and Transaction Accounting

**Partly complete.** The phase that must land **before checkout and payment
architecture become production-capable**, because Merchant-of-Record status
places transaction-tax and transaction-accounting responsibility on Monacado
rather than on the seller. **`0M.T1` delivered the foundation half**, above; what
remains is `0M.T2`: tax execution and reversal accounting.

> **`0M.T` is not a prerequisite to `0M.8`.** `0M.8` moves no money: no sale, no
> order, no payment, no payout, no tax event, no ledger entry. Every part of this
> phase presupposes a transaction that `0M.8` does not create.
>
> **`0M.T1` — MoR Transaction Accounting Foundation — was a structural
> prerequisite to `0M.9`**, because `0M.9` writes the first real Order and payment
> transaction and must be able to account for its economic components at the
> moment it does. Monacado must not create a transactional payment record it
> cannot account for. It is now **complete** — see the section above.

Reserved for `0M.T2`, and designed in none of it yet: sales-tax nexus and
registration; VAT and GST; product tax classification; sourcing; tax calculation;
filing and remittance; tax refunds and reversals; refund and chargeback
accounting; double-entry ledger postings; processor reconciliation workflows; and
settlement audit evidence. `0M.T1` recorded tax and shipping **amounts** and the
settlement states that will carry provider evidence; it determined, calculated,
and remitted nothing.

**Must hold:** tax and shipping stay **outside** the wholesale-acquisition basis
and outside commission and promoter-margin bases — `0M.4A` already enforces that
structurally, and this phase must not relax it. Customer tax and location
evidence remains private operational data and never becomes public capsule
content.

See [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md) §G, §H,
and §I.

## 0M.8 — Payment-provider Onboarding and Activation

**Complete.** The provider axis 0M.5 deliberately left with no storage, and the
governed activation review the `ParticipantActivation` table was created for and
never written.

Two tables, both foreign keys deliberate and **no `CASCADE` from a participant**:
`ParticipantPaymentAccount` (provider linkage and observed readiness, `RESTRICT`
to the participant) and `ParticipantPaymentRequirementRow` (bounded outstanding
requirement categories, `CASCADE` from its own account because it describes a
current set rather than history).

**Must hold — and held:** the generic `PaymentReadinessStatus` lifecycle stays
provider-neutral, reused from 0M.1 rather than restated, with no
provider-*shaped* status, requirement, or column anywhere and no payment-provider
dependency in `package.json`; **no raw participant provider credential, bank
detail, tax identifier, document, or KYC/KYB payload is stored**, and none is
admissible through a `strictObject` input; marketplace activation and payment
readiness remain two independent gates, so an `ENABLED` observation activates
nobody and an approval writes no provider state; and one provider account belongs
to exactly one participant, so no payout attribution built on it is ambiguous.

**`RESTRICTED` and `SUSPENDED` stayed unreachable** from every path. This phase
advances participant status no further than `UNDER_REVIEW` and `ACTIVE`, and
records the decisions `APPROVED`, `MORE_INFORMATION_REQUIRED`, and `REJECTED`.
The machine-readable restriction scope those two statuses require belongs to
`0M.R1`, and the 0M.5 draft gate was **not** lifted — the activation service
writes the two statuses together with the audit row instead.

**0M.8 moved no money**, and no charge, order, payout, settlement, tax, ledger,
risk, or notification model was introduced.

**The authorization split is settled.** Activation review is a Monacado internal
operational authority, not a marketplace role: `activation:submit` stays a
marketplace capability derived from participant and role state, and
**`activation:review`** is a new internal `AccountEntitlement`, evaluated against
persisted state on every decision. The two closed vocabularies share no member
and neither accepts the other's strings. No marketplace role, participant
ownership, or account ownership confers review authority. See
[`PAYMENT_PROVIDER_ONBOARDING_AND_ACTIVATION.md`](PAYMENT_PROVIDER_ONBOARDING_AND_ACTIVATION.md) §9.

**Not in scope:** the concrete provider adapter (`PaymentProviderPort` is an
interface with no implementation), hosted onboarding, webhook ingestion, routes,
and UI.

Full detail:
[`PAYMENT_PROVIDER_ONBOARDING_AND_ACTIVATION.md`](PAYMENT_PROVIDER_ONBOARDING_AND_ACTIVATION.md).

## 0M.9 — Buyer Checkout, Order, Commission, Payout, and Review-Submission Foundation

**Complete.** The first phase that creates an actual commercial transaction, and
the first coherent buyer flow: Listing → checkout → Order → payment result →
immutable transaction economics → commission/payout obligations → review
eligibility.

Four tables. `Order` (who bought, what they were quoted, where the payment got
to), `ProceedsObligation` (what Monacado owes the seller and any promoter),
`PurchaseEvidence` (the private record that a buyer transacted), and
`ReviewSubmissionAuthority` (the stored grant ADR §11.6 requires) — plus the
**additive nullable `orderId` column** on `TransactionEconomicSnapshot` that
`0M.T1` anticipated, so binding an Order was a migration rather than a rewrite.

**An Order is not an economic snapshot.** It records the **quote** — what the
buyer was told they would be charged, which must exist before any payment runs
and therefore before any snapshot can. What the sale *earned each party* stays on
`0M.T1`'s snapshot, bound one-to-one, and the sale path **asserts the quote equals
the snapshot** before writing. The overlap is a checked invariant rather than a
second answer left to drift.

**Must hold — and held:** guest checkout creates **no Account and no fabricated
participant**, asserted by counting both tables across a guest purchase;
financial records are relational-first and no capsule is projected or published
anywhere in the phase; a review submission authorizes **that review's capsule and
nothing else**, proved by feeding a persisted authority to `0M.1`'s own
`canPublishProductReviewCapsule` and watching it deny the Product capsule and
somebody else's review; and **buyer identity is not published by default** —
there is no column for a buyer's email, name, address, IP, card, or device on any
table this phase created.

**Guest purchase claiming** is the minimum durable foundation, not a subproject: a
256-bit code returned once, only its SHA-256 digest stored, verified by
possession, with every refusal indistinguishable so it cannot become an oracle.
`buyerKind` stays `GUEST_BUYER` after a claim — the sale was made by a guest.

**A guest may review.** `0M.1` settled that a guest is "a real, supported case…
and is not an account in disguise" and requires `VERIFIED` purchase provenance
rather than an account. Requiring a claim first would have contradicted a
committed contract, so the phase does not.

**The successful-sale write is one transaction**: snapshot, settlement row,
provider reference, proceeds obligations, purchase evidence, seller and promoter
notices, and the Order's move to `PAID`. A `PAID` Order without economics,
economics without an Order, and a promoted sale without its promoter obligation
are each **impossible** rather than unlikely — asserted by forcing a mid-transaction
failure and finding nothing survived.

**The payment boundary is a port with no adapter.** `BuyerPaymentPort` is
provider-neutral and has **no implementation**: no SDK, no credential, no
endpoint, no network call, and no payment dependency in `package.json`. A test
supplies a scripted double.

**Go-live approval became a governed record.** `0M.3A` defined it as "a supplied
decision input… Monacado's opinion about a participant, not a fact about a shop",
and until this phase the supplier was a caller. Once a Listing being buyer-active
meant real money moved, that was indefensible: a caller passing `APPROVED` would
have been a caller making a Listing purchasable. `ParticipantCommerceApproval`
records the decision **against the participant**, honouring the 0M.3A ruling —
there is no `storefrontId` column — under a **new narrow internal capability,
`participant:commerce-approve`**, which is deliberately neither `activation:review`
(deciding an admission) nor `participant:restrict` (withholding, the inverse act).
Absence means `NOT_APPROVED`, nothing is seeded, history supersedes rather than
edits, and no checkout input can assert or override it.

**Not in scope, and none of it started:** live payment integration, payout
execution, tax calculation or remittance, refund and chargeback accounting,
review content or capsule publication, routes, and UI.

Full detail:
[`BUYER_CHECKOUT_ORDER_AND_POST_SALE_FOUNDATION.md`](BUYER_CHECKOUT_ORDER_AND_POST_SALE_FOUNDATION.md).

---

## 1.0 — Executable Checkout and Payment Integration (Stripe test mode)

**Complete.** The **first operational phase**, and the one that ends the
pre-operational `0M` numbering: everything before it built the records a
marketplace needs; this one executes a purchase against a real payment provider.

`0M.9` deferred exactly one thing — "the concrete adapter behind
`BuyerPaymentPort`, hosted checkout, 3-D Secure, webhook ingestion". `1.0`
supplies it, in **Stripe test mode only**, and changes no economics doing so.

**What it added.** Stripe's server SDK; concrete adapters behind the
provider-neutral ports; hosted Checkout Sessions keyed on the Order id;
signature-verified webhook confirmation; three minimal routes; and a buyer UI
with no client JavaScript.

**What it did not touch.** No pricing, no commercial policy, no retention, no
seller or promoter proceeds, no transaction snapshot, and no post-sale write
path. `recordPaymentResult` finalizes the sale exactly as `0M.9` wrote it, and
**no second finalization path exists**.

**The three properties that matter.**

1. **Stripe never calculates Monacado's economics.** It is handed one amount —
   the buyer's total, already derived by `prepareCheckout` from the bound Listing
   version and the bound commercial policy — and returns payment evidence. There
   is no application fee, no destination charge, and no `transfer_data` anywhere
   in the repository.
2. **A payment is true because Stripe signed it.** The webhook is the only path
   that can reach `PAID`. The buyer's return page reads the database and asserts
   nothing, and the begin-checkout request has exactly one field — which Listing
   — so there is no shape in which a client could state an outcome.
3. **Test mode is structural, not configured.** `STRIPE_MODES` has one member and
   `resolveStripeApiKey` refuses a key that is not `sk_test_`-prefixed. Live mode
   requires editing source in the open.

**Idempotency, with no new machinery.** The Order id is the idempotency key from
`prepareCheckout` through to Stripe's own `Idempotency-Key` header, so one Order
has one Checkout Session and one PaymentIntent. A repeated webhook delivery
creates no second snapshot, settlement row, proceeds obligation, purchase
evidence, notification obligation, or `PAID` transition — each guarantee resting
on a `0M.9` rule or the `UNIQUE` index on `TransactionEconomicSnapshot.orderId`.
**No event-processing framework and no processed-event ledger was built.**

**Connect, bounded deliberately.** `0M.8`'s `PaymentProviderPort` now has a real
test-mode implementation, so readiness is read from Stripe rather than stubbed.
Test-mode account creation and hosted onboarding links exist as two plain
functions feeding the existing `registerParticipantPaymentAccount`. **No payout,
transfer, or application fee is executed**, and none is implemented.

Detail, configuration, and the full live-mode gate:
[`EXECUTABLE_CHECKOUT_AND_STRIPE_TEST_MODE.md`](EXECUTABLE_CHECKOUT_AND_STRIPE_TEST_MODE.md).

---

## 1.1 — Order Expiry and Buyer Notification Delivery

**Complete.** The second operational phase, and the one that makes the buyer's
experience honest: `1.0` could take money but could neither resolve an abandoned
checkout nor tell anybody anything.

**Order expiry.** Stripe's own `checkout.session.expired` is the trigger — there
is **no sweeper, cron, `expiresAt` column, or timer** anywhere in the payment
path, and a test greps for each. Only Stripe knows whether a hosted session is
still payable; a Monacado clock guessing would eventually cancel an Order a buyer
was midway through paying. A still-pending Order moves to `CANCELLED` through
`0M.9`'s existing `cancelOrder`, which writes one lifecycle column and has no path
to a snapshot, obligation, evidence, or review authority. **A `PAID` Order is
never downgraded** — `PAID` is terminal in `0M.9`'s transition table — and
repeated expiry events are idempotent.

Abandonment got its **own disposition** rather than a new failure code:
`BuyerPaymentConfirmation` is now a union whose `ABANDONED` arm has no `result`
field at all. `PAYMENT_FAILED` asserts a provider reported a failure, and nobody
declined an expired checkout.

**Notification delivery.** The first concrete channel, and **supplemental by
construction**. `AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md` §3a governs: the admin
panel is canonical and email "can never replace it". Nothing in the delivery path
writes to `NotificationObligation` — a test greps for every write method — so a
delivery never satisfies, closes, or advances one.

**Guest delivery, without a fabricated participant.** This closes the gap `0M.9`
recorded in its own words: buyer-facing notice for guests "needs an addressing
model that does not exist yet". `NotificationDelivery.obligationId` and
`recipientParticipantId` are both nullable, so a buyer who is not a participant
still gets a receipt. A test counts `Account` and `MarketplaceParticipant` across
a guest purchase-and-notify and asserts neither moved.

**The address is not stored.** Only a SHA-256 digest of the normalised
destination — the same construction as `0M.9`'s guest claim code. Monacado can
prove *that* it wrote to an address, deduplicate, and answer a support question
without becoming a store of buyer email addresses. The operational cost is real
and was accepted deliberately.

**At-most-once, by claiming before sending.** The row is inserted (unique on a
derived delivery key), then the message is sent, then evidence is recorded.
Send-then-record would be at-least-once, and a second "your payment succeeded"
reads as a second charge. Duplicate suppression sits *above* that too: a replayed
webhook finalizes to `ALREADY_RECORDED`, so nothing newly became true and nobody
is newly owed a message.

**No email vendor was added.** The repository identified none, so this phase built
the provider-neutral `MailPort`, a local logging adapter that redacts the
destination and never logs a body, an in-memory test adapter, and a disabled
adapter. Disabled is first-class: every message is refused with
`CHANNEL_NOT_CONFIGURED` and the delivery row is **still written**, so an
unconfigured deployment reports exactly what it did not send.

One additive migration (`NotificationDelivery`) and one additive `0M.N1` category
(`ORDER_CANCELLED`) — the change that vocabulary was explicitly built to take.

**One pre-live gate is recorded rather than solved**: delivery is at-most-once
with no retry, and because only a digest of a buyer's address is kept, a failed
**guest** receipt cannot be re-sent from Monacado's data alone. Tolerable in test
mode; a real decision — bounded retry, provider re-read, or encrypted retention —
belongs with `0M.N2` alongside bounce handling.

**No `0M.T2`, `0M.R2`, payout, refund, chargeback, or live-mode work was begun.**

Detail:
[`ORDER_EXPIRY_AND_BUYER_NOTIFICATION_DELIVERY.md`](ORDER_EXPIRY_AND_BUYER_NOTIFICATION_DELIVERY.md).

---

## 1.2 — Pre-Live Commerce Controls

**Complete.** The third operational phase, and the one that builds what live money
requires **without enabling it**. `1.0` made a purchase executable and `1.1` made
its outcome communicable; both ran on assumptions that are fine in test mode and
indefensible with real money.

**Tax is no longer an assumption.** Checkout obtains an authoritative `TaxQuote`
before it places an Order, and `taxPort` is a **required argument** — there is no
untaxed path that compiles. With no engine configured the adapter **throws**: a
zero returned because tax is unconfigured is indistinguishable from a zero that is
genuinely correct, and the difference is an uncollected liability nobody can find
later. `OrderTaxEvidence` records which engine answered, on what basis, under
which treatment, and the amount is **checked** against the Order rather than
copied. Tax reaches the buyer's total and **no commercial basis** — a $100.00 sale
with $10.00 tax still retains $8.50, not $9.35. **No tax vendor was selected or
installed.**

**Reversals are new evidence, never a correction.** `0M.T1` built the snapshot
with no update path and said a reversal "will be recorded as its own entry rather
than by editing this one". `TransactionReversal` is that entry: a test reads the
snapshot before and after and asserts the rows are **equal**. The settlement row —
`0M.T1`'s mutable half — advances to the `REVERSED` state that phase created in
anticipation. No amount is a parameter; every figure is derived from the snapshot
and balanced before writing. **Full reversals only**: a partial forces a decision
about *whose* money comes back first, and every allocation rule is a commercial
policy decision with different winners. Proceeds obligations are untouched and
reconcile to **zero** by derivation.

**The risk gate is narrow and versioned.** Four controls — a maximum commercial
order amount, active restrictions, commerce approval, and payment readiness — each
justified by something that could actually go wrong at launch. Thresholds live in
`RiskPolicyVersionRow`, mirroring `0M.R1` exactly, so every decision names the
exact `(policyId, policyVersion)` that produced it, on an **`ALLOW`** as well as a
`DENY`. It **fails closed**: no active policy is a denial, never a default limit.
It runs **before an Order is written**, so a denial leaves nothing behind.
**No fraud scoring, ML, velocity engine, reserve system, chargeback prediction, or
review workflow was built** — a score with nobody to review it is a number that
blocks buyers for reasons no one can explain.

**Payout holds reuse what already exists.** `advanceProceedsObligation` refuses
`ELIGIBLE` when an active `payout:receive` restriction stands or the sale was
reversed. `0M.R1`'s record already means "may not be paid", and a second flag
would be a second answer that can disagree with it. **No payout is executed.**

**Live-commerce readiness fails closed and currently cannot pass.**
`LIVE_PROVIDER_NOT_ENABLED` is reported by construction — `STRIPE_MODES` has one
member, so no configuration clears it. A test configures every other control and
asserts readiness is **still** `false`. It is a readiness *decision*, not a
switch: a test greps the module for every write method and asserts none.

**Checkout collects what a merchant of record needs.** Buyer name, email, and a
structured billing address are always required; a **shipping address only when the
basket contains something physical**, decided from an explicit `deliveryMode`
Product fact and never inferred from free-form metadata. An unknown mode fails
closed. Guests remain first-class throughout, with no `Account` or
`MarketplaceParticipant` created.

**Digital delivery policy is declared, not built.** A completed digital purchase
creates a durable entitlement; a download token is a transient credential and
never the right itself. Five self-service successful downloads by default, the
seller owning exceptions beyond that, and no permanent reusable secret URLs for
externally hosted products.

Additive migrations only, touching no pre-existing table.

**Stripe remains test-mode only, and no live-money operation exists.**

Detail, and the full remaining list before real-money launch:
[`PRE_LIVE_COMMERCE_CONTROLS.md`](PRE_LIVE_COMMERCE_CONTROLS.md).

---

## Standing constraints across the track

1. **Publication stays gated and asynchronous.** Creators and promoters never hold
   AgentNet publishing credentials, and no live Registrar call belongs inside an
   ordinary save request (ADR §5, §11.1).
2. **Authority stays partitioned.** Creator, promoter, Monacado, and buyer
   assertions live in separate capsules around a shared node identity, never one
   flat capsule (ADR §2).
3. **Private data never enters a capsule.** Profiles, provider state, buyer
   identity, and purchase evidence are operational-only.
4. **Internal entitlements and marketplace roles never meet.**
5. **The database is the sole source of truth.** Every phase writes business truth
   through transactional services; capsules are deterministic projections that
   never write back, never create provenance, and never authorize a business
   change (ADR §12).
6. **Narrow phases, tests and validation at every boundary, and a pre-commit
   fix-now-versus-acceptable review** (CLAUDE.md).

## Reference

- [`MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md`](MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md)
- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
- [`SOURCE_VERSION_RETENTION_AND_ARCHIVAL_POLICY.md`](SOURCE_VERSION_RETENTION_AND_ARCHIVAL_POLICY.md)
- [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md)
- [`IDENTITY_SESSION_AND_INTERNAL_ENTITLEMENT_FOUNDATION.md`](IDENTITY_SESSION_AND_INTERNAL_ENTITLEMENT_FOUNDATION.md)
- [`PRODUCT_PUBLICATION_WORKER_OPERATIONS_TRACK.md`](PRODUCT_PUBLICATION_WORKER_OPERATIONS_TRACK.md)
