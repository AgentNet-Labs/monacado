# Post-0E.7 Marketplace Roadmap (Track 0M)

Phase 0E.7 closed with an authenticated internal status route. Development now
leaves worker operations and resumes the marketplace sequence the thesis
describes.

This roadmap names the phases, in order, with the boundary each one must not
cross. It is a plan, not an authorization: **each phase begins only when
explicitly instructed**, and none of the deferred work below is started early
because it appears here.

## Sequence

Each publishable entity now takes **two phases, in this order**: the authoritative
source model first, its capsule projection shape second. That ordering is the
bifurcated architecture made procedural — a projection cannot be designed before
the truth it projects exists (ADR §12;
[`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)).

| Phase | Title | State |
| --- | --- | --- |
| **0M.1** | Account, role, activation, and review-authority architecture | **complete** — `084b315` |
| **0M.2A** | Authoritative Offer Source Model | **complete** — `4687772` |
| **0M.2B** | Offer Capsule Projection Shape | **complete** — `cb4a96d` |
| **0M.3A** | Authoritative Storefront Source Model | **complete** — `fe0f803` |
| **0M.3B** | Storefront Capsule Projection Shape | **complete** |
| **0M.2C** | **Offer economics correction** — required before any Listing pricing, checkout, or settlement | **complete** |
| **0M.N** | **Notification records** — durable admin-panel notices, deduplication, recipients, notice states | **not started** |
| **0M.4A** | **Authoritative Listing Source Model** — seller-controlled vs promoted, promoter retail price, upstream blocking | **complete** |
| **0M.4B** | Listing Capsule Projection Shape | **complete** |
| **0M.5** | Participant persistence and draft onboarding | **complete** — draft-only |
| **0M.R** | **Risk Management and Commercial Controls** — required before payment activation and checkout are production-capable | **not started** |
| **0M.T** | **Tax, MoR and Transaction Accounting** — required before checkout/payment architecture is production-capable | **not started** |
| 0M.6 | Payment-provider onboarding and activation | planned |
| 0M.7 | Buyer checkout, Order, commission, payout, and review-submission foundation | planned |

**Every publishable marketplace entity now has a source model and a capsule
projection shape.** Notification records, risk management, tax and transaction
accounting, checkout, and settlement are all **not started** — no contract, no
persistence, no route, no orchestration.

**0M.5 was taken out of table order**, ahead of 0M.3B, because every completed
0M contract terminates at a `mon:mpart:` identity that had no table: Offer
authority, Storefront ownership, and all twelve capability decisions were
unreachable from persisted state. It is **draft onboarding only** — no activation
approval, no payment provider, no Node, no capsule, no route, no UI. 0M.3B then
completed the Storefront source-model/projection pair. The remaining phases keep
their numbers and their order.

**No entity is published yet.** Product is the only entity with a publication
path, and it stays gated off. Offer, Storefront, and Listing each have a
projection shape and no publication, no persistence, and no Node.

**Monacado's commercial model is Merchant-of-Record.** Monacado is the retailer
and buyer-facing counterparty, and acquires each item at the moment of sale under
a versioned wholesale-acquisition policy — currently 92.5% of the commercial
retail price minus $1.00. There is no separate platform fee. The governing
description is [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md),
which carries a governance rule: material changes to the MoR role, the
wholesale-acquisition formula, tax or shipping treatment, fulfillment
responsibility, settlement, or risk-policy application must update that document
before or with implementation.

> **Renumbering note.** Splitting Storefront and Listing into their own
> source-model/projection pairs consumed the numbers 0M.3 and 0M.4, so participant
> persistence, payment onboarding, and checkout moved from 0M.4/0M.5/0M.6 to
> 0M.5/0M.6/0M.7. **The order of the work is unchanged**; only the labels moved.
> No committed phase number was altered — 0M.1 means exactly what it meant when it
> was committed.

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

## Notification records (required, not started)

Must define: durable **admin-panel** notices as the canonical channel;
deduplication as one obligation per **promoter participant × exact Offer source
version × change category**; recipients (the promoter participant's active
`SUPER_OWNER` and `ADMIN`); the unread / acknowledged / resolved / archived states;
and optional supplemental delivery channels that can never replace the
admin-panel notice.

**None of this is implemented.** The rules are recorded in
[`AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md`](AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md)
§3/§3a and are binding on these phases; the Storefront source module contains no
executable form of them.

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

## 0M.R — Risk Management and Commercial Controls

**Not started.** Platform-wide risk-adjusted commercial controls, and the phase
that must land **before payment activation and buyer checkout become
production-capable**.

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

## 0M.T — Tax, MoR and Transaction Accounting

**Not started.** The phase that must land **before checkout and payment
architecture become production-capable**, because Merchant-of-Record status
places transaction-tax and transaction-accounting responsibility on Monacado
rather than on the seller.

Reserved for this phase, and designed in none of it yet: sales-tax nexus and
registration; VAT and GST; product tax classification; sourcing; tax calculation;
filing and remittance; tax refunds and reversals; shipping accounting; the MoR
transaction ledger; refunds; chargebacks; and settlement audit evidence.

**Must hold:** tax and shipping stay **outside** the wholesale-acquisition basis
and outside commission and promoter-margin bases — `0M.4A` already enforces that
structurally, and this phase must not relax it. Customer tax and location
evidence remains private operational data and never becomes public capsule
content.

See [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md) §G, §H,
and §I.

## 0M.6 — Payment-provider onboarding and activation

Stripe Connect onboarding, requirement and capability synchronisation, and the
governed activation review that moves a participant to `ACTIVE`.

**Must hold:** the generic `PaymentReadinessStatus` lifecycle stays
provider-neutral — Stripe's requirement model is mapped onto it, never substituted
for it. **No raw participant provider credential is ever stored** (thesis §5.5).
Marketplace activation and payment readiness remain two independent gates, both
required for commerce.

## 0M.7 — Buyer checkout, Order, commission, payout, and review-submission foundation

Guest and account checkout, Order persistence, attributed commissions, payouts,
and the first real `ReviewSubmissionAuthority` rows.

**Must hold:** guest checkout creates no Account; financial records are
relational-first and are not entity capsules (ADR §1); a review submission
authorizes that review's capsule and nothing else; buyer identity is not published
by default. Also the phase that must design the explicit verified process for
claiming prior guest purchases.

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
