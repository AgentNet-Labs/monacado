# Versioned Commercial Policy and Activation Risk (Phase 0M.R1)

Status: **binding** for the 0M marketplace track, subordinate to
[`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md),
[`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md), and
[`MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md`](MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md).

## Purpose

Two narrowly defined responsibilities, and no third:

1. **Persist the versioned Monacado wholesale-acquisition policy**, so a
   historical transaction can later bind to an authoritative policy version.
   Since 0M.4A the policy has been a *supplied Zod value* with no home in the
   database — a future Order could record a `policyId`/`policyVersion` pointing
   at nothing.
2. **Give `RESTRICTED` machine-readable meaning.** 0M.8 refused to write the
   status behind `RestrictionScopeNotAvailableInPhaseError` because "nothing in
   the repository yet expresses **which** capability is withheld". This is that
   scope.

**This is not a risk engine.** No transaction caps, velocity checks, fraud
scores, payout holds, reserves, chargeback controls, prohibited-product
enforcement, or manual-review queues. `0M.R2` owns all of it.

## What this phase adds

| File | Contents |
| --- | --- |
| `src/contracts/marketplace/commercial-policy.ts` | Policy and version records, lifecycle, inputs, `toWholesaleAcquisitionPolicy`, `MONACADO_STANDARD_POLICY_V1`. |
| `src/contracts/marketplace/participant-restriction.ts` | Restriction scope, reason codes, record, lifecycle, status reconciliation. |
| `src/server/marketplace/commercial-policy-service.ts` | Create, record, activate, exact lookup, effective lookup, list. |
| `src/server/marketplace/participant-restriction-service.ts` | Impose, lift, list active, history, evaluate. |
| `src/server/marketplace/commercial-policy-mapper.ts` · `participant-restriction-mapper.ts` | Prisma ⇄ domain reconstruction. |
| `src/server/marketplace/commercial-policy-errors.ts` · `participant-restriction-errors.ts` | Bounded error vocabularies. |
| `src/server/marketplace/commercial-policy-ids.ts` | `mon:cpol:` identity generation. |
| `prisma/schema.prisma` | `CommercialPolicy`, `CommercialPolicyVersionRow`, `ParticipantRestriction`. |
| Tests | 54 offline, 59 database. |

Also modified, additively: `contracts/account/account.ts` and
`internal-authorization.ts` (`participant:restrict`), `account-principal.ts`,
`participant-ids.ts`, `contracts/marketplace/identity.ts`.

---

## 1. Persisted commercial-policy authority

**The database is authoritative; the committed contract stays the shape.**

`CommercialPolicy` is the enduring identity (`mon:cpol:`), and exactly what
`MonacadoWholesaleAcquisitionPolicy.policyId` carries.
`CommercialPolicyVersionRow` holds immutable versions keyed by
`(policyId, policyVersion)` — the same composite the Offer source versions use,
so a future Order binds to a pair that **cannot drift onto "whatever is
current"**.

`toWholesaleAcquisitionPolicy` is the single bridge from storage to economics. It
emits the committed contract's own `strictObject`, so a storage field cannot leak
into a calculation, and the 0M.4A calculators consume it unchanged. **There is
still exactly one implementation of the arithmetic in this repository** — 0M.R1
added no second.

Stored are policy *inputs* only: the retained percentage in basis points, the
fixed amount in minor units, an explicit currency, and the rounding rule carried
on the policy rather than inherited from whichever calculator runs. **No derived
value is stored** — not the acquisition percentage (it is
`10000 − retainedPercentageBasisPoints`), not the retained amount (it depends on
a price), not any per-sale figure. Asserted against `information_schema`.

## 2. Versioning and effective-date semantics

| Status | Meaning | Bindable? |
| --- | --- | --- |
| `DRAFT` | recorded, never selectable | **No** — nothing ran under it |
| `ACTIVE` | the version economics run under now | Yes |
| `RETIRED` | superseded | **Yes** — a past Order must stay reproducible |

`DRAFT → ACTIVE → RETIRED`, and nothing returns: "the rate we used until March,
then again from June" is two versions, and pretending otherwise loses the gap.

**History is never edited.** Changing economics mints a new version. Activating a
superseding version retires the incumbent **in the same transaction**, touching
only its status, retirement instant, retiring actor, and active marker — never
its numbers. There is no `updateCommercialPolicyVersion` operation, and a test
asserts the exported service surface.

**"The effective policy" has exactly one answer**, enforced by the
`activeForPolicyId` unique index rather than by a service remembering to retire
the incumbent first — the same nullable-marker technique
`ParticipantActivation.undecidedForParticipantId` uses. Two `ACTIVE` rows cannot
exist, so the read never has to choose; if one is somehow reached it raises
`AmbiguousActiveCommercialPolicyError` rather than picking.

**Two lookups, deliberately different functions**, so a caller cannot reach for
"current" where "exact" was meant:

- `getCommercialPolicyVersion(policyId, policyVersion)` — what a *historical*
  transaction reproduces from. Retired versions resolve normally.
- `getEffectiveCommercialPolicyVersion(policyId)` — what a *new* transaction
  prices under. **Refuses when nothing is active; there is no fallback rate.**

## 3. The current standard policy is one version, not an invariant

`MONACADO_MOR_BUSINESS_MODEL.md` §B: 7.5% + $1.00 retained, so 92.5% − $1.00
acquired. On $100 that is $8.50 retained and $91.50 acquired — verified end to
end from a persisted version, through the committed calculators, in both the
seller-direct and promoted paths.

`MONACADO_STANDARD_POLICY_V1` describes those numbers **as data**. It is not a
default and not a fallback: no service reads it, no calculation falls back to it,
and it carries **no `policyId`**, so it cannot become a hard-coded policy
reference. Changing Monacado's rate means recording a new version through the
service, never editing that constant. A test asserts that no 0M.R1 module embeds
`750` or `7.5` in code.

### How the standard policy enters the database

**Explicitly, through the service — never through the migration.** The migration
creates structure only; it writes no business row. Seeding an authoritative rate
inside a migration would make a commercial decision a schema artifact, unversioned
by the governance the policy model exists to provide, and applied silently on
every environment that runs migrations.

`MONACADO_STANDARD_POLICY_V1` exists so a bootstrap caller and a test name the
same numbers once rather than twice. **No production write is performed in this
phase.**

## 4. Relationship to `0M.T1`

`0M.T1`'s per-sale economic snapshot must record the exact policy a transaction
ran under. 0M.R1 supplies the target: `(policyId, policyVersion)` now names a row
that exists, is immutable, and stays resolvable after the rate changes.

0M.R1 **does not** implement the binding, the Order, the ledger, tax lines,
shipping lines, settlement state, or provider transaction references. It makes the
policy version available for those records and stops there.

---

## 5. The participant restriction model

`ParticipantRestriction` is the machine-readable evidence behind
`MarketplaceParticipant.status = RESTRICTED`. One row answers: **who** is
restricted, **which capability**, **why**, **when**, **by whom**, whether it
**stands**, and when and why it was **lifted**.

**A restriction is Monacado's governed decision, never an observation** — see §9.

## 6. Restriction scope

**The scope vocabulary is the capability vocabulary.** A restriction names a
member of the committed `MARKETPLACE_CAPABILITIES`, narrowed to the commerce
subset. Minting a parallel `MARKETPLACE_ACTIVATION` / `OFFER_PUBLICATION`
vocabulary would be two names for one concept, and the day they disagreed the
restriction would be the one that was wrong.

**Restrictable (6):** `storefront:activate` · `offer:publish` · `payout:receive` ·
`commission:accrue` · `review:product:submit` · `review:seller:submit`

**Never restrictable, and why:**

- **Drafting** (`storefront:draft:create`, `product:draft:create`, both listing
  drafts). 0M.1 puts `RESTRICTED` inside `DRAFTING_PARTICIPANT_STATUSES`
  deliberately: a restriction withholds *commerce*, never the ability to correct
  the work that caused it.
- **`activation:submit`.** A participant must be able to answer a restriction;
  restricting the answer would make it unappealable.
- **`review:*:capsule:publish`.** Those answer "does a stored authority back
  *this* capsule action" — a property of a submission, not a standing of a
  participant. Withholding it here would put two unrelated gates on one decision.

Every capability is classified restrictable or not, with none unaccounted for.
No transaction-risk scope was invented: `TRANSACTION_CAP`, `VELOCITY`, and
`PAYOUT_HOLD` are all refused.

## 7. Restriction reasons

Five bounded codes, the smallest vocabulary the current architecture justifies:
`UNDERWRITING_REVIEW_REQUIRED` · `POLICY_ELIGIBILITY_RESTRICTION` ·
`PROVIDER_REQUIREMENT_UNRESOLVED` · `COMMERCIAL_ELIGIBILITY_RESTRICTION` ·
`MANUAL_OPERATIONAL_RESTRICTION`.

Each is a classification of the *kind* of problem, at the granularity an operator
acts on. **Not persisted, and not admissible through any input:** underwriting
payloads, provider rejection messages, KYC/KYB documents, document URLs,
investigator or internal notes, free-text reasons, external error text, identity
data, or stack traces. Every input is a `strictObject`, so each arrives as an
unknown key and fails validation — and `information_schema` confirms no such
column exists.

Richer explanation, if it is ever needed, belongs in a separately governed
internal record — never in the field that controls semantics.

## 8. Restriction lifecycle and `RESTRICTED` semantics

`ACTIVE → LIFTED`, and **nothing is ever deleted**. `LIFTED` is terminal:
re-imposing is a new restriction with its own instant and actor, so "restricted,
cleared, restricted again" reads as two events rather than one row that changed
its mind. `imposedAt`, `imposedByAccountId`, `liftedAt`, `liftedByAccountId`, and
`liftedReasonCode` are all retained. There is **no expiry** — a self-lapsing
restriction would be a policy decision nothing in this phase makes.

At most one active restriction per `(participant, scope)`, enforced by a unique
index on a nullable marker column.

### Status reconciliation — deterministic and narrow

| Current status | Active restrictions | Result |
| --- | --- | --- |
| `ACTIVE` | 0 → 1 | → `RESTRICTED` |
| `RESTRICTED` | ≥ 1 remaining | unchanged |
| `RESTRICTED` | → 0 | → `ACTIVE` |
| anything else | any | unchanged |

**The invariant 0M.8 could not express:** a participant is never `RESTRICTED`
without at least one active restriction. The restriction row and the status are
written in one transaction, and the restriction service is the **only** thing in
the codebase that may write the status — `advanceParticipantStatus` still refuses
it outright.

**Lifting one of several changes nothing**; only the last one returning the count
to zero restores `ACTIVE`.

**No activation prerequisite is bypassed.** Returning to `ACTIVE` is reachable
only *from* `RESTRICTED`, which is reachable only *from* `ACTIVE` — so the
participant was already admitted through a governed activation review, and this
restores what a restriction withheld rather than granting admission. A participant
that never activated cannot reach `ACTIVE` by this path, and a test walks every
status to prove it.

A `DRAFT`, `PROFILE_INCOMPLETE`, `PROFILE_COMPLETE`, or `UNDER_REVIEW`
participant **may hold restrictions** — a policy problem found during onboarding
is real evidence — but its status does not move, because the 0M.1 table defines
no transition to `RESTRICTED` from any of them. Inventing one would be a lifecycle
change made inside a risk phase.

### `SUSPENDED` remains deferred

0M.1 §4.1 distinguishes the two in prose — `RESTRICTED` is "admitted, some
capability withheld"; `SUSPENDED` is "admission withdrawn pending a cure" — and
that distinction is real. But this phase's model expresses **capability-scoped
withholding**, which is exactly what `RESTRICTED` means. Suspension is admission
*withdrawn wholesale*: a different governed act, needing its own decision path,
its own evidence, and its own answer to how it is lifted. None of that is
derivable from the restriction scope, and inventing it would be exactly the
fabrication 0M.8 refused.

**`SUSPENDED` therefore stays phase-gated.** `advanceParticipantStatus` still
refuses it, no decision produces it, and suspension semantics remain deferred to
the phase that defines them.

## 9. Provider state and restriction are separate authorities

**Provider readiness is an external observed fact** on
`ParticipantPaymentAccount`; a **restriction is a governed Monacado decision**
with an actor and a reason. Neither creates the other:

- A provider reporting `DISABLED`, `DETAILS_REQUIRED`, or `RESTRICTED` creates
  **no** restriction. The restriction service reads provider state nowhere — it
  has no path that could. Converting one into the other requires an explicit
  operator decision, for which `PROVIDER_REQUIREMENT_UNRESOLVED` exists as a
  reason code.
- Imposing or lifting a restriction mutates **no** provider readiness. Verified
  by asserting the payment record — readiness, observation instant, reference,
  and `updatedAt` — is byte-identical across both operations.

## 10. Internal restriction authority

**`participant:restrict`** — a new internal `AccountEntitlement`, evaluated by
`canRestrictParticipant` against persisted state read on **every** call, so a
revocation fails closed on the very next operation.

**Why not `activation:review`?** A restriction reaches capabilities an activation
review never touches — taking a storefront live, publishing an Offer, receiving a
payout, accruing commission, submitting reviews. Reusing the review grant would
silently widen the authority of someone approved to decide one admission. The two
are independent in both directions, and tested so.

**Narrow by construction:** not `admin`, not `risk:*`, not `participant:*`, not a
wildcard. `ACCOUNT_CAPABILITIES` remains a closed enum of three; unknown values
are refused.

**Nothing else confers it.** Not SELLER, PROMOTER, or BUYER; not owning the
participant; not owning the account; not merely being authenticated.
Structurally, not by a check — `InternalAuthorizationSubject` has no field
capable of carrying a role, a participant, or an ownership relation. The input
likewise carries *who is acting*, never *what they may do*: `isAuthorized`,
`riskApproved`, and `reviewerAuthorized` are all validation failures.

Authorization is checked **before any participant or restriction state is read**,
so an unauthorized caller learns nothing about the target — not even whether it
exists.

## 11. Self-restriction prohibition

Extending 0M.8's separation-of-duties rule from activation review to restriction:
**an internal actor may not impose or lift a restriction on the participant its
own account owns.**

Lifting one's own is the sharper half — it would let an operator restore their
own commerce — and imposing is refused on the same principle rather than left as
an asymmetry someone has to reason about.

The comparison reads the persisted `MarketplaceParticipant.accountId` foreign key.
Nothing is inferred from an email, a name, a caller claim, or an identifier
prefix; both sides are `mon:acct:` forms in any case. Its own bounded refusal,
`RESTRICTION_SELF_ACTION_NOT_PERMITTED`, distinct from "not authorized at all" —
the caller *is* a restrictor, and being told otherwise would send them looking for
a grant they already hold.

A refused self-action writes nothing: no restriction row, no status change.

No quorum or four-eyes control is implemented.

## 12. Policy and restriction are separate concerns

Two model families, deliberately not one generic polymorphic "policy" table. They
are both cross-cutting and that is their **only** similarity: one describes
Monacado's economics, the other a governed decision about one participant. A
shared table would make every reader ask which kind of row they were holding.

## 13. Deferred to `0M.R2` and later

**`0M.R2`:** transaction value caps · velocity checks · fraud scores · payout
holds · reserve balances · chargeback controls · payment blocks ·
prohibited-product enforcement · category risk · manual-review queues ·
**per-transaction, per-participant, and per-class policy selection** (named in
`NEVER_ON_COMMERCIAL_POLICY_VERSION` so a column for it cannot appear early).

**`0M.T1`:** Order economics snapshot · MoR transaction ledger · settlement state
· provider transaction references · tax lines · shipping lines.

**`0M.N1`:** notification obligation records and delivery.

**Later:** `SUSPENDED` semantics; per-capability restriction *enforcement*
(`capability.ts` still gates coarsely on `status !== "ACTIVE"`, while the scope
records the governed intent — see the ambiguity note in the phase report).

---

## Reference

- [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md) — §B the standard policy, §J risk
- [`LISTING_SOURCE_MODEL.md`](LISTING_SOURCE_MODEL.md) — where the economics are encoded
- [`MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md`](MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md) — §4.1 the status vocabulary
- [`PAYMENT_PROVIDER_ONBOARDING_AND_ACTIVATION.md`](PAYMENT_PROVIDER_ONBOARDING_AND_ACTIVATION.md) — the gate this phase opens
- [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) — binding ADR
- [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md)
