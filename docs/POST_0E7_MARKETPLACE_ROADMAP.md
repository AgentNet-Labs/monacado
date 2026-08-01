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
| **0M.2A** | Authoritative Offer Source Model | **not started** |
| 0M.2B | Offer Capsule Projection Shape | planned |
| 0M.3A | Authoritative Storefront Source Model | planned |
| 0M.3B | Storefront Capsule Projection Shape | planned |
| 0M.4A | Authoritative Listing Source Model | planned |
| 0M.4B | Listing Capsule Projection Shape | planned |
| 0M.5 | Participant persistence and draft onboarding | planned |
| 0M.6 | Payment-provider onboarding and activation | planned |
| 0M.7 | Buyer checkout, Order, commission, payout, and review-submission foundation | planned |

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

**Not started.** The authoritative record and immutable source version for
creator-authorized commercial terms: fields, lifecycle, authority linkage,
uniqueness, and the mapping controls a later projection will need.

**Must hold:** the Product/Offer boundary stays where ADR §10.2 put it — price,
currency, availability windows, territory, and checkout eligibility belong to the
Offer, never to `generalAvailabilityState` on the Product. The Offer's factual
authority is the creator.

**Not in scope:** the capsule projection shape, publication, checkout, or pricing
logic.

## 0M.2B — Offer Capsule Projection Shape

The deterministic projection of an Offer source version, following the Product
pattern: authored Zod schema, ontology and context terms, canonical hashing,
derived JSON Schema, and a synthetic fixture.

**Must hold:** the projection reads an identified source version and never the
current record; it creates no provenance; Monacado remains Publisher and
Registrar.

## 0M.3A — Authoritative Storefront Source Model

The authoritative Storefront record and its source versions.

**Not in scope:** the projection shape, activation, publication, or UI.

## 0M.3B — Storefront Capsule Projection Shape

The deterministic Storefront projection, on the same terms as 0M.2B.

## 0M.4A — Authoritative Listing Source Model

The authoritative promoter-curated Listing record and its source versions,
including the relationship to the creator's Product.

**Must hold:** the authority partition ADR §2 requires — **a Listing may not
restate or override the creator's Product facts.**

## 0M.4B — Listing Capsule Projection Shape

The deterministic Listing projection, on the same terms as 0M.2B, preserving the
promoter/creator authority partition.

## 0M.5 — Participant persistence and draft onboarding

The first phase in this track to touch the database. Migrates the models proposed
in 0M.1 §9 — `MarketplaceParticipant`, `MarketplaceRoleAssignment`,
`ParticipantProfile`, `ParticipantActivation` — and wires the 0M.1 capability
decisions to real rows behind an application service.

Also the phase that must settle 0M.1's open decisions 1, 2, and 4 (the `Creator`
versus `Seller` capsule name; where email verification and terms acceptance are
enforced; the public participant projection's field set), and that would carry any
`AuthenticatedPrincipal` change if a route genuinely needs one.

**Must hold:** drafting only. No activation approval, no payment provider, no
publication.

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
