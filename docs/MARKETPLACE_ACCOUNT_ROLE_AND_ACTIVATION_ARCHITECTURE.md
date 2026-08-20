# Marketplace Account, Role, Activation, and Review Authority Architecture (Phase 0M.1)

Status: **binding** for the 0M marketplace track, subordinate to
[`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md).

This phase reconciles the Phase 0E.7.4.2A identity foundation — deliberately
minimal, credentials only — with the marketplace participants, roles, activation
lifecycle, and Buyer review authority the product thesis describes. It is an
**architecture-and-contract phase**: pure vocabularies, views, transition tables,
and decision functions, plus this document.

**No route, UI, persistence, migration, Stripe integration, Storefront, Listing,
Offer, Order, commission, payout, or checkout is introduced.** The relational
models in §9 are *proposed*, not migrated.

## What this phase adds

| File | Contents |
| --- | --- |
| `src/contracts/marketplace/identity.ts` | Opaque internal identifier forms for participants, roles, profiles, activations, payment accounts, review submissions, review authorities, and purchase evidence. |
| `src/contracts/marketplace/participant.ts` | Role, participant-status, role-status, and payment-readiness vocabularies; the participant and subject read views. |
| `src/contracts/marketplace/lifecycle.ts` | Three explicit transition tables and their validators. |
| `src/contracts/marketplace/review-authority.ts` | Review kinds, submission and authority views, the state→action authorization table, and the public attribution projection. |
| `src/contracts/marketplace/capability.ts` | Thirteen capability decisions, the review-capsule authority evaluator, and the internal/marketplace boundary functions. Twelve were defined here in 0M.1; `listing:seller_direct:create` was added in 0M.7, because this vocabulary predates 0M.4A splitting Listings into SELLER_DIRECT and PROMOTED and named only the promoted half. |
| `test/marketplace-account-role-activation.test.ts` | 71 pure tests, one `describe` per required property. |

---

## 1. Account versus MarketplaceParticipant

Two records, two questions, and they must never become one:

| | `Account` (0E.7.4.2A, committed) | `MarketplaceParticipant` (proposed) |
| --- | --- | --- |
| Answers | *Who authenticated?* | *Who is transacting in the marketplace?* |
| Status vocabulary | `ACTIVE` \| `DISABLED` | eight admission states (§4) |
| Created by | registration | claiming a marketplace role |
| Required for | any authenticated action | any marketplace action **except guest buying** |
| Classification | operational-only, never a capsule | relational-first, with a **public projection** that may be capsule-backed |

**Marketplace activation is not encoded in `Account.status`, and never will be.**
Identity status answers whether a login is usable. If it also carried
`profile_incomplete` or `review_pending`, then disabling a compromised login and
suspending a seller would be the same operation — and an operator restoring one
would silently restore the other.

`AccountEntitlement` likewise stays what it is: an explicit grant of an **internal
operational capability**. Two exist: `publication-worker:status:read` (0E.7.4.1)
and **`activation:review`** (added by 0M.8 — the governed activation decision is
Monacado's own operational act, so it is an internal entitlement and not a
marketplace capability; `activation:submit` remains the participant's side of
that pair, in `MARKETPLACE_CAPABILITIES`, and the two vocabularies share no
member). **Marketplace roles are never stored as
entitlements**, and the separation is enforced in both directions by
`marketplaceCapabilitiesGrantedByInternalEntitlement` and
`internalCapabilitiesGrantedByMarketplaceRoles` — two functions that return the
empty array permanently, and a test proving that toggling the internal capability
changes no marketplace decision.

> The dangerous direction is the second one. A seller who could read
> publication-worker status would have crossed from the marketplace into
> Monacado's operations because one enum served two questions.

## 2. Additive SELLER, PROMOTER, and BUYER roles

`MARKETPLACE_ROLES = ["SELLER", "PROMOTER", "BUYER"]` — a closed enum, additive,
not a hierarchy.

- **SELLER and PROMOTER coexist.** The thesis states plainly that "a user can
  participate as a creator, a promoter, or both", and §9.4 describes the hybrid
  case as ordinary. ADR §11.5 forbids issuing a second Node merely because one
  participant holds several roles.
- **BUYER coexists with either.** A seller buying from another seller is a buyer.
- **`INTERNAL_OPERATOR` is not in the vocabulary.** It is an entitlement, not a
  role (§1).
- One participant holds **at most one assignment per role** — enforced by a
  refinement on the participant view.

Capability follows the role, not the participant:

| Role | Confers |
| --- | --- |
| SELLER | drafting owned Products, publishing Offers, activating a storefront, payouts |
| PROMOTER | drafting promoted Listings, activating a storefront, accruing commission, payouts |
| BUYER | purchasing, and — with verified purchase provenance — submitting reviews |

### SELLER, and the ADR's `Creator`

The **role** is `SELLER`; the ADR's capsule-backed publishable entity is
`Creator` (ADR §1, §2, §10.3). These are different layers, not a contradiction:
`SELLER` is an authorization fact on an operational record, while `Creator` is the
semantic authority a published capsule asserts. The thesis uses both words for the
same person ("Creators / Sellers", "Creator / seller"). Which name the public
capsule finally carries is listed as an open decision in §13.

## 3. Guest Buyer

A buyer may purchase with **no account at all**. Guest checkout is a first-class
path (thesis §5.1, §9.1) and a stated product principle ("account creation must
not be required merely to buy").

- A guest is modelled as `account: null, participant: null` — the **absence of an
  identity**, which is the only representation that cannot later be mistaken for
  one. `GUEST_SUBJECT` is that frozen value.
- **Guest checkout must not silently create an Account.** No contract here
  creates, implies, or reserves one.
- A later claim of prior purchases requires an **explicit verified process** —
  proving control of the purchase email and binding the evidence deliberately.
  Matching an address at signup is not that process, and is forbidden: it would
  hand one person's purchase history to whoever registers the address next, which
  is precisely why the identity foundation refuses to key authorization on email.
- Guests receive **no AgentNet Node** (ADR §11.5, §11.10).
- **Order persistence is not designed in this phase.**

A guest may still submit a review — see §6.

### 3.1 An authenticated Account with no MarketplaceParticipant

A third case sits between the two, and it is decided explicitly rather than left
to whichever branch happens to run first: someone who registered but has never
claimed a marketplace role.

- They hold **no marketplace capability whatsoever** — every seller, promoter,
  activation, and commerce decision denies `PARTICIPANT_REQUIRED`.
- They may use the **guest-review path, and only through verified transaction
  provenance**. Having an account changes nothing about what they must prove; the
  provenance requirement is identical to a guest's.
- **Authentication alone grants no BUYER role and no review authority.** A
  session proves who is asking, never what they may assert. A BUYER role is
  created by an explicit act, not implied by registering, and review authority
  comes from a purchase in every case.

This is the same rule stated three ways because it is the one place where "logged
in" would most plausibly drift into "entitled", which is exactly the drift the
identity foundation was built to prevent.

## 4. Participant, role, and payment-readiness lifecycles

Three axes, moving independently. Nothing is inferred across them.

### 4.1 Participant status — Monacado's admission decision

`DRAFT → PROFILE_INCOMPLETE → PROFILE_COMPLETE → UNDER_REVIEW → ACTIVE`, plus
`RESTRICTED`, `SUSPENDED`, and terminal `CLOSED`.

| State | Means |
| --- | --- |
| `DRAFT` | the participant record exists; nothing claimed yet |
| `PROFILE_INCOMPLETE` | required private profile fields outstanding |
| `PROFILE_COMPLETE` | profile satisfied; activation may be submitted |
| `UNDER_REVIEW` | submitted; Monacado is deciding |
| `ACTIVE` | admitted to the marketplace |
| `RESTRICTED` | admitted, some capability withheld pending a cure |
| `SUSPENDED` | admission withdrawn pending a cure |
| `CLOSED` | terminal |

**Divergence from the thesis's Appendix A, deliberate and surfaced here rather
than resolved silently:** Appendix A's illustrative `Account` vocabulary
(`registered, email_verified, profile_incomplete, stripe_pending, review_pending,
active, restricted, suspended, closed`) mixes three independent facts into one
column, where `stripe_pending` and `review_pending` cannot both be true even
though both conditions routinely hold at once. The thesis labels these
"illustrative states", and Phase 0M.1's brief binds Account status to identity
level only. The mapping is lossless:

| Appendix A | Here |
| --- | --- |
| `registered` | `Account.status = ACTIVE`, participant `DRAFT` |
| `email_verified` | an activation prerequisite (§5), not a state |
| `profile_incomplete` | participant `PROFILE_INCOMPLETE` |
| `stripe_pending` | payment readiness `PENDING_PROVIDER` / `DETAILS_REQUIRED` |
| `review_pending` | participant `UNDER_REVIEW` |
| `active` | participant `ACTIVE` |
| `restricted` / `suspended` / `closed` | participant `RESTRICTED` / `SUSPENDED` / `CLOSED` |

### 4.2 Role-assignment status — one role on one participant

`DRAFT → PENDING_ACTIVATION → ACTIVE`, plus `SUSPENDED` and terminal `REVOKED`.

Narrow on purpose: it answers "may this participant act in this role at all" and
restates nothing participant-wide. A role carrying its own copy of profile or
payment state would drift out of agreement with the participant's.

**Creation is not a transition.** SELLER and PROMOTER are created `DRAFT` and
reach `ACTIVE` only through activation. BUYER is created `ACTIVE`: buying requires
no Monacado admission decision, and a buyer role needing approval would be
stricter than buying with no account at all.

### 4.3 Payment readiness — the provider's answer

`NOT_STARTED`, `DETAILS_REQUIRED`, `PENDING_PROVIDER`, `ENABLED`, `RESTRICTED`,
`DISABLED`.

**Provider-neutral by construction.** Stripe is the intended provider (thesis
§5.5) and appears nowhere in the vocabulary: `PENDING_PROVIDER`, not
`stripe_pending`, and no `capabilities`, `requirements`, or `charges_enabled`
field. Two reasons — a lifecycle shaped around one provider's API becomes a
migration the day that changes, and the provider's requirement model is dynamic
(thesis §5.4) and must not be frozen into an enum.

`NOT_STARTED → ENABLED` is **not** a transition: readiness is always the
provider's answer, never Monacado's assumption.

### 4.4 Valid transitions

```
Participant   DRAFT              → PROFILE_INCOMPLETE, CLOSED
              PROFILE_INCOMPLETE → PROFILE_COMPLETE, CLOSED
              PROFILE_COMPLETE   → PROFILE_INCOMPLETE, UNDER_REVIEW, CLOSED
              UNDER_REVIEW       → ACTIVE, PROFILE_INCOMPLETE, RESTRICTED, SUSPENDED, CLOSED
              ACTIVE             → RESTRICTED, SUSPENDED, CLOSED
              RESTRICTED         → ACTIVE, SUSPENDED, CLOSED
              SUSPENDED          → ACTIVE, RESTRICTED, CLOSED
              CLOSED             → (terminal)

Role          DRAFT              → PENDING_ACTIVATION, REVOKED
              PENDING_ACTIVATION → ACTIVE, DRAFT, REVOKED
              ACTIVE             → SUSPENDED, REVOKED
              SUSPENDED          → ACTIVE, REVOKED
              REVOKED            → (terminal)

Payment       NOT_STARTED        → DETAILS_REQUIRED, PENDING_PROVIDER, DISABLED
              DETAILS_REQUIRED   → PENDING_PROVIDER, RESTRICTED, DISABLED
              PENDING_PROVIDER   → ENABLED, DETAILS_REQUIRED, RESTRICTED, DISABLED
              ENABLED            → RESTRICTED, DETAILS_REQUIRED, DISABLED
              RESTRICTED         → ENABLED, DETAILS_REQUIRED, DISABLED
              DISABLED           → DETAILS_REQUIRED
```

Notable refusals, each with a reason: `DRAFT → ACTIVE` (activation is a governed
decision; a path that skipped review would make every other gate advisory);
`PROFILE_INCOMPLETE → UNDER_REVIEW` (review is submitted from `PROFILE_COMPLETE`
only); `CLOSED → anything` (reopening is a new admission decision with its own
record); `DRAFT → ACTIVE` for a role; `NOT_STARTED → ENABLED`.

`UNDER_REVIEW → PROFILE_INCOMPLETE` is permitted: a reviewer asking for more
information is the ordinary outcome of a review, and must not require suspending
the participant to express it.

## 5. Activation gates

**Drafting is open; selling is governed.** That is the thesis's "low-friction
creation, governed activation" principle, and it is why a bare-bones account may
build a whole storefront and sell nothing.

| Gate | Required for |
| --- | --- |
| enabled account | everything except guest buying and guest reviewing |
| participant record | everything except guest buying and guest reviewing |
| drafting-eligible participant status | drafting |
| role held in a drafting status | drafting in that role |
| `PROFILE_COMPLETE` + ≥1 activatable role | submitting activation |
| participant `ACTIVE` | all commerce |
| payment readiness `ENABLED` | storefront activation, Offer publication, payouts |
| verified purchase provenance | review submission and review-capsule publication |

Two rules deserve stating outright:

- **Payment readiness alone does not activate marketplace commerce.** The
  provider never decided who may sell on Monacado.
- **Payouts require marketplace activation *and* payment readiness.** Activation
  alone does not make money movable, and discovering that at settlement time is
  worse than refusing at the gate.

Payment readiness is **not** a precondition for *submitting* activation: provider
onboarding and Monacado review are independent, and requiring one to start the
other would make a provider outage a Monacado review outage.

Email verification and baseline-terms acceptance are the thesis's exit condition
from `registered`. They are modelled as **profile-completion prerequisites**, not
as participant states — neither is implemented yet (both are deferred in the
identity foundation), and both are recorded in §13 as an open decision on where
exactly they are enforced.

## 6. Buyer review authority

The binding rule, encoded in `review-authority.ts` and `capability.ts`:

> A Buyer's review submission **is** the grant of authority for Monacado to
> create, register, publish, update, supersede, or revoke **that review's**
> capsule — and nothing else.

- **Buyer status alone grants no general publication authority.** A BUYER role
  confers no capability over any Product, Seller, Storefront, Listing, or Offer
  capsule; the tests assert `ROLE_NOT_HELD` for every one of them.
- **The Buyer is the factual authority; Monacado is the Publisher and
  Registrar.** ADR §2 assigns the Review capsule's authority to the buyer; ADR
  §11.0–§11.2 keep Publisher and Registrar with Monacado under controlled
  credentials. Both hold at once, and the submission is exactly the stored
  authorisation ADR §11.6 requires before Monacado publishes for a participant.
  **Buyers receive no publishing credentials.**
- **Provenance links the assertion to the submission.** The stored authority names
  the submission, the review kind, the reviewed subject, the submitter kind, and a
  pointer to private purchase evidence.
- **Verified purchase provenance is required — guest or account holder.** Review
  authority derives from a purchase, not from having logged in. An account that
  never bought anything is precisely the case this refuses.
- **Editing authorizes supersession. Withdrawing authorizes revocation.** Nothing
  else may be inferred: a submitted review does not authorize a revocation, and a
  withdrawn one does not authorize a new publication.

| Submission state | Authorized capsule actions |
| --- | --- |
| `SUBMITTED` | `CREATE`, `REGISTER`, `PUBLISH` |
| `EDITED` | `UPDATE`, `SUPERSEDE`, `PUBLISH` |
| `WITHDRAWN` | `REVOKE` |
| authority `INVALIDATED` | `REVOKE` only |

`REGISTER` and `PUBLISH` are named separately because ADR §11.0 forbids collapsing
Publisher and Registrar into one undifferentiated privilege. `INVALIDATED` still
permits revocation: a review Monacado has decided must come down would otherwise
be published and unretractable.

Scope is checked **before** health: a target that is not a review capsule is
denied `REVIEW_AUTHORITY_SCOPE_EXCEEDED` no matter how valid the authority is, and
a target naming a *different* review is denied `REVIEW_AUTHORITY_TARGET_MISMATCH`.
An authority over one review is not an authority over reviews.

## 7. ProductReview versus SellerReview

**Two separate capsule authorities**, never one "review" capsule with a type
field.

| | `ProductReview` | `SellerReview` |
| --- | --- | --- |
| Subject | a Product node | a participant acting as a seller |
| Factual authority | the Buyer | the Buyer |
| Publisher / Registrar | Monacado | Monacado |
| Authorized by | that product review submission | that seller review submission |
| Reaches | that ProductReview capsule only | that SellerReview capsule only |

They have different subjects, different moderation and defamation exposure, and
different supersession consequences. Collapsing them would mean revoking one could
not help but touch the other's history. A `PRODUCT_REVIEW` authority applied to a
SellerReview capsule is denied `REVIEW_AUTHORITY_KIND_MISMATCH`, and the converse.

Neither capsule is implemented in this phase: no review persistence, generation,
validation, publication, or Registrar interaction exists.

## 8. Public and private data boundaries

**Publishable (future capsules)**

- public MarketplaceParticipant / Creator projection
- `ProductReview`, `SellerReview`
- `Storefront`, `Product`, `Listing`, `Offer`

**Operational-only — never a capsule, never published**

- `Account`, `AccountSession`, `AccountEntitlement`
- private participant profile
- activation review and its decisions
- payment-provider state and identifiers
- private Buyer identity
- purchase-verification evidence

Confirmed for this phase:

- **Private profile data never enters a capsule.** The participant view has no
  field for a legal name, address, date of birth, tax identifier, document
  reference, provider account id, or provider secret — so a capability rule
  cannot come to depend on one, and no projection of the view can leak one.
- **The privacy boundary is the strict safe projection itself.** Public
  attribution is produced only by `projectPublicReviewAttribution`, whose input
  and output are both `strictObject`s enumerating every permitted field. The
  projector is **never handed** an account id, an email address, a session id, an
  entitlement, a legal identity, a private profile field, payment-provider state,
  or a purchase-evidence reference — none of them is a parameter, and none is a
  field of the result. It cannot emit what it cannot receive, and an unknown key
  on either side is a validation failure rather than a passthrough.

  > The `@` rejection on a display label is **defense-in-depth, not the privacy
  > guarantee.** It catches one careless caller pasting an address into the one
  > free-text field; it is not what keeps private data out of the projection, and
  > it must never be relied upon as though it were.

- **Review capsules use approved public or pseudonymous attribution.**
  `projectPublicReviewAttribution` returns `PSEUDONYMOUS` or
  `VERIFIED_PURCHASER` unless an explicit per-review approval is present; ADR
  §11.10 requires a privacy-preserving authorship pattern by default.
- **Purchase provenance supports authority without being exposed.** The authority
  record carries a `purchaseEvidenceRef` pointer; the evidence itself stays in
  operational storage and is never published.
- **Buyer identity is not published by default.** Publishing it requires explicit
  purpose, consent, and policy approval (ADR §11.10), expressed as
  `APPROVED_PUBLIC_IDENTITY`.

## 9. Proposed relational architecture (documented, not migrated)

No Prisma model, migration, or database write is introduced by this phase. The
following is the candidate design for Phase 0M.5, which implemented it.

### `MarketplaceParticipant`

- **Purpose** — the marketplace identity of one account: who is transacting.
- **Authoritative fields** — `id (mon:mpart:…)`, `accountId`, `status`,
  `createdAt`, `updatedAt`.
- **Lifecycle** — §4.1; created `DRAFT`.
- **Unique** — `accountId` (one participant per account).
- **Foreign keys** — `accountId → Account.id`.
- **Deletion** — **RESTRICT**. A participant is the anchor of commercial history;
  deleting an account that holds one must be refused, forcing an explicit closure
  first.
- **Public/private** — the row is private; a **public projection** (display name,
  roles, activation status) is capsule-backed.
- **Classification** — relational-first, with a capsule-backed public projection.

### `MarketplaceRoleAssignment`

- **Purpose** — one additive role grant on one participant.
- **Authoritative fields** — `id (mon:mrole:…)`, `participantId`, `role`,
  `status`, `grantedAt`, `activatedAt?`, `revokedAt?`.
- **Lifecycle** — §4.2; initial status per `initialRoleAssignmentStatus`.
- **Unique** — `(participantId, role)`.
- **Foreign keys** — `participantId → MarketplaceParticipant.id`.
- **Deletion** — **RESTRICT**. An authorization record; revocation is a state
  change, not a delete, so history survives.
- **Public/private** — role membership may appear in the public projection;
  timestamps and decisions stay private.
- **Classification** — relational-first.

### `ParticipantProfile`

- **Purpose** — the comprehensive private activation profile (thesis §5.4):
  identity, business structure, representatives, commercial profile, risk, payout
  configuration, documents.
- **Authoritative fields** — `id (mon:mprof:…)`, `participantId`,
  `completeness`, per-section completion markers, `updatedAt`. Field-level
  contents are deferred to 0M.4 and must be driven dynamically rather than frozen
  into a static global checklist.
- **Lifecycle** — incomplete ⇄ complete; drives participant `PROFILE_INCOMPLETE` /
  `PROFILE_COMPLETE`.
- **Unique** — `participantId`.
- **Foreign keys** — `participantId → MarketplaceParticipant.id`.
- **Deletion** — **CASCADE** with the participant, subject to retention policy.
- **Public/private** — **entirely private. Never enters a capsule.**
- **Classification** — operational-only.

### `ParticipantActivation`

- **Purpose** — one governed activation review and its decision.
- **Authoritative fields** — `id (mon:mact:…)`, `participantId`, `submittedAt`,
  `decision (APPROVED | MORE_INFORMATION_REQUIRED | REJECTED)`, `decidedAt`,
  `decidedByActorId (mon:actor:…)`, bounded decision reason codes.
- **Lifecycle** — submitted → decided; append-only, one row per submission.
- **Unique** — at most one undecided row per participant.
- **Foreign keys** — `participantId → MarketplaceParticipant.id`.
- **Deletion** — **RESTRICT**. It is the audit trail for admission.
- **Public/private** — private; only the resulting participant status is public.
- **Classification** — operational-only.
- **Note** — the deciding actor is an **opaque identifier**, never an email or a
  display name. **Resolved in 0M.8** to the reviewing *account* id rather than a
  separate `mon:actor:` value: an activation reviewer has an account behind it
  (a remediation decision does not), the identity foundation already rules that
  the account id IS the actor id, and writing the same identity that
  `activation:review` was evaluated against is what binds the audit actor to the
  authorized reviewer.

### `ParticipantPaymentAccount`

- **Purpose** — Monacado's record of the participant's payment-provider linkage
  and readiness.
- **Authoritative fields** — `id (mon:mpay:…)`, `participantId`, `provider`,
  `providerAccountRef`, `readiness`, `readinessObservedAt`, bounded
  requirement/restriction codes.
- **Lifecycle** — §4.3; created `NOT_STARTED`.
- **Unique** — `(participantId, provider)`.
- **Foreign keys** — `participantId → MarketplaceParticipant.id`.
- **Deletion** — **RESTRICT** while any financial record references it.
- **Public/private** — **entirely private.** Provider identifiers, requirement
  detail, and payout configuration are never published. **No raw provider
  credential belonging to the participant is ever stored** (thesis §5.5).
- **Classification** — operational-only.

### `ReviewSubmissionAuthority`

- **Purpose** — **the record that proves Monacado may publish, supersede, or
  revoke a specific review capsule.** It is the stored authorisation ADR §11.6
  requires; without a matching row, Monacado publishes nothing on a buyer's
  behalf.
- **Authoritative fields** — `id (mon:rauth:…)`, `reviewSubmissionId
  (mon:rsub:…)`, `reviewKind (PRODUCT_REVIEW | SELLER_REVIEW)`,
  `reviewSubjectRef`, `submitter (ACCOUNT_BUYER | GUEST_BUYER)`,
  `participantId?`, `purchaseProvenance`, `purchaseEvidenceRef (mon:pvev:…)`,
  `submissionState`, `status`, `grantedAt`, `supersededAt?`, `revokedAt?`.
- **How authority is proven** — a publication attempt names the review kind and
  the target review. The check requires, in order: the target is a review capsule
  at all; it is the same kind as the authority; it is **that** review; provenance
  is `VERIFIED`; the authority is not `INVALIDATED`; and the submission's current
  state authorizes the specific action. Each failure has its own reason code, so a
  future audit record says which condition was not met.
- **Lifecycle** — granted on submission; `submissionState` follows the buyer's
  edit/withdraw actions; `status` becomes `INVALIDATED` if Monacado disproves the
  evidence or removes the content under policy.
- **Unique** — `reviewSubmissionId`.
- **Foreign keys** — `participantId → MarketplaceParticipant.id` (nullable — a
  guest has none); `purchaseEvidenceRef →` the purchase-evidence record.
- **Deletion** — **RESTRICT**. Deleting the authority behind a published capsule
  would leave a published assertion with no provable basis.
- **Public/private** — the row is private. Only the review content and its
  approved attribution are published; the evidence pointer, submitter identity,
  and participant linkage are not.
- **Classification** — operational-only. The **review itself** is capsule-backed.

## 10. Capability matrix

Twelve decisions, all pure, each returning `ALLOW` / `DENY` with a closed set of
reason codes. `ALLOW` carries no reasons and `DENY` carries at least one — a
malformed decision fails schema validation rather than being read as a verdict.

| Capability | Requires |
| --- | --- |
| `canCreateDraftStorefront` | enabled account · participant in a drafting status · SELLER **or** PROMOTER in a drafting status |
| `canCreateDraftProduct` | same, **SELLER** |
| `canCreatePromotedListing` | same, **PROMOTER** |
| `canSubmitActivation` | enabled account · participant `PROFILE_COMPLETE` · ≥1 non-revoked activatable role |
| `canActivateStorefront` | participant `ACTIVE` · SELLER or PROMOTER `ACTIVE` · payment `ENABLED` |
| `canPublishOffer` | participant `ACTIVE` · **SELLER** `ACTIVE` · payment `ENABLED` |
| `canReceivePayout` | participant `ACTIVE` · SELLER or PROMOTER `ACTIVE` · payment `ENABLED` |
| `canAccrueCommission` | participant `ACTIVE` · **PROMOTER** `ACTIVE` · payment not `RESTRICTED`/`DISABLED` |
| `canSubmitProductReview` | account optional (**guest permitted**) · BUYER `ACTIVE` if a participant exists · provenance `VERIFIED` |
| `canSubmitSellerReview` | as above |
| `canPublishProductReviewCapsule` | a matching, healthy `ReviewSubmissionAuthority` for **that** ProductReview, and an action its submission state authorizes |
| `canPublishSellerReviewCapsule` | as above, for SellerReview |

**Commission accrual is deliberately not gated on `ENABLED` payment.** Accrual is
a ledger fact about a sale that already happened; refusing to record it would lose
the obligation rather than defer it. Paying it out still requires
`canReceivePayout`. A provider *hold* (`RESTRICTED` or `DISABLED`) does stop
accrual, because that is a signal about the participant rather than a timing
problem.

**`activation:submit` has no reviewing counterpart in this table, deliberately.**
Deciding an activation is Monacado's internal operational act, so it is the
`activation:review` `AccountEntitlement` and is evaluated by
`canReviewParticipantActivation` (0M.8) against persisted entitlement state. No
marketplace role, participant ownership, or account ownership confers it, and the
decision function has no parameter through which one could.

**Separation of duties narrows it further: an entitled reviewer may not decide
the activation of a participant owned by the same Account.** The entitlement is
necessary but not sufficient — it makes an account a reviewer generally, and
never a reviewer of itself. The condition is read from the persisted
`MarketplaceParticipant.accountId` foreign key, never inferred from an email, a
name, a caller claim, or an identifier prefix, and it is independent of which
marketplace roles the participant holds. **Submission is unaffected**: a
participant submits its own activation request through `activation:submit`, which
is the ordinary path. `ACTIVATION_SELF_REVIEW_NOT_PERMITTED` is its own bounded
refusal, distinct from "this account may not review at all".

Reason codes are **classifications, never values**: no name, address, email,
provider message, evidence reference, or identifier can appear in one, so a
denial is safe to return from a future route without a filtering step someone can
forget.

**No database access, clock read, environment read, randomness, or external call
exists anywhere in these functions** — asserted by a test that greps the module
sources.

## 11. Identity-foundation compatibility

Reviewed against `IDENTITY_SESSION_AND_INTERNAL_ENTITLEMENT_FOUNDATION.md`. **No
contradiction was found, and no committed identity code is altered.**

| Property | Status |
| --- | --- |
| `Account` is the authentication identity | **compatible** — participants attach to it; it gains no marketplace meaning |
| `normalizedEmail` uniqueness | **compatible** — no marketplace record keys on an email |
| Opaque, server-validated sessions | **compatible** — unchanged and untouched |
| `ACCOUNT` and `INTERNAL_OPERATOR` principal types | **compatible** — marketplace roles are not principal types and add none |
| `AccountEntitlement` reserved for internal capabilities | **preserved** — enforced in both directions (§1) |
| No automatic marketplace-role assignment | **preserved** — nothing here grants a role; the closest thing is that a BUYER role is created `ACTIVE`, which is still an explicit creation |
| No automatic operator bootstrap | **preserved** — untouched |
| Account status stays `ACTIVE`/`DISABLED` | **preserved** — §1 |

One **future, non-blocking** change is noted rather than made: when a marketplace
UI exists, `AuthenticatedPrincipal` may need a marketplace-participant reference
so a route need not re-query. That is a change to committed identity code and
belongs to the phase that first needs it (0M.4), with its own review. It is **not
required now** and nothing in this phase depends on it.

## 12. What this phase deliberately does not do

No route, page, or UI. No Prisma model, migration, or database access. No Stripe
or any payment-provider call. No Storefront, Listing, Offer, Product-drafting,
Order, checkout, cart, commission, or payout implementation. No review
persistence, generation, validation, or publication. No capsule, node, or
Registrar interaction. No scheduler, worker, alerting, or production change.

## 13. Unresolved decisions

Each is recorded rather than assumed, and none blocks the roadmap's next phase.

1. **`Creator` versus `Seller` as the published capsule name.** The ADR says
   `Creator`; the marketplace role is `SELLER`; the thesis uses both. A ruling is
   needed before the participant projection capsule is designed (0M.4).
2. **Where email verification and terms acceptance are enforced.** Modelled here
   as profile-completion prerequisites; the thesis makes them the exit condition
   from `registered`. Neither is implemented. The alternative — a distinct
   participant state — was rejected as duplicating an account-level fact, but the
   enforcement point is not yet ratified.
3. **Whether an account Buyer may ever review without a verified purchase.** This
   phase requires provenance from everyone. Relaxing it for account holders would
   be a policy decision with real consequences for review integrity.
4. **The public MarketplaceParticipant projection's field set**, and whether a
   participant receives an AgentNet Node before activation. ADR §11.5 says a Node
   is issued "where public AgentNet identity is warranted"; what warrants it is
   not yet decided.
5. **Storefront-scoped roles.** Roles are participant-wide here. Whether a
   participant may hold different roles on different storefronts is deferred to
   the Storefront phase (0M.3).
6. **Review moderation authority** — who may invalidate a review authority, under
   what policy, and with what audit trail. `INVALIDATED` exists; the operation
   that sets it does not.
7. **Guest purchase-claim process.** §3 requires an explicit verified process; its
   design belongs to 0M.9.
8. **Retention and deletion policy** for participant profiles, activations, and
   purchase evidence, including any right-to-erasure obligation that would
   conflict with the RESTRICT deletion rules in §9.

## Reference

- [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) — binding ADR.
- [`IDENTITY_SESSION_AND_INTERNAL_ENTITLEMENT_FOUNDATION.md`](IDENTITY_SESSION_AND_INTERNAL_ENTITLEMENT_FOUNDATION.md)
- [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md)
- [`PRODUCT_PUBLICATION_WORKER_OPERATIONS_TRACK.md`](PRODUCT_PUBLICATION_WORKER_OPERATIONS_TRACK.md)
