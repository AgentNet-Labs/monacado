# Payment-provider Onboarding and Activation (Phase 0M.8)

Status: **binding** for the 0M marketplace track, subordinate to
[`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) and
[`MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md`](MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md).

The phase 0M.5 pointed at. Its participant service refuses `UNDER_REVIEW` and
`ACTIVE` "not because the 0M.1 transition table forbids them, but because
reaching them is a governed activation decision that belongs on a
`ParticipantActivation` row, and this phase writes none." This is the phase that
writes them, and the phase that gives payment readiness real storage.

**0M.8 moves no money.** No charge, payment intent, order, checkout, capture,
refund, chargeback, settlement, payout, commission, tax, or ledger record exists
after it, and no value it persists is an amount. It records who is ready to be
paid and whom Monacado has admitted; it pays nobody.

## What this phase adds

| File | Contents |
| --- | --- |
| `src/contracts/marketplace/payment-account.ts` | Provider vocabulary, the opaque provider account reference, bounded requirement codes, the payment-account record, the two write inputs, and the `PaymentProviderPort` interface. |
| `src/contracts/marketplace/activation-review.ts` | Phase-writable statuses, the `RESTRICTED`/`SUSPENDED` gate set, bounded decision reason codes, and `evaluateActivationApproval`. |
| `src/contracts/account/internal-authorization.ts` | The `activation:review` internal capability, `InternalAuthorizationSubject`, and `canReviewParticipantActivation`. |
| `src/server/account/internal-authorization-service.ts` | Resolves an account's internal authorization subject from persisted entitlements. |
| `src/server/marketplace/payment-account-service.ts` | Link an account, read it, record an observation, sync through an injected port, and report readiness. |
| `src/server/marketplace/activation-service.ts` | Submit for activation, decide a submitted activation, read activation history. |
| `src/server/marketplace/payment-account-mapper.ts` | Prisma ⇄ domain reconstruction, with corrupt rows raised rather than returned. |
| `src/server/marketplace/payment-account-errors.ts` | Ten bounded payment-account error codes. |
| `prisma/schema.prisma` | `ParticipantPaymentAccount`, `ParticipantPaymentRequirementRow`. |
| `test/payment-provider-onboarding-contracts.test.ts` | 66 offline tests. |
| `test/payment-provider-onboarding-and-activation.integration.test.ts` | 70 database tests. |

Also modified, additively: `contracts/account/account.ts` (`activation:review`
added to `ACCOUNT_CAPABILITIES`), `account-principal.ts`
(`INTERNAL_OPERATOR_CAPABILITIES` as a set), `participant-errors.ts` (six new
codes), `participant-ids.ts` (`nextPaymentAccountId`), `participant-record.ts`
(the deciding actor id), `participant-mapper.ts` and `participant-service.ts`
(readiness read from storage instead of a constant).

---

## 1. The provider-neutral payment-account model

`ParticipantPaymentAccount` is **Monacado's own row**, identified `mon:mpay:`.
The provider's identifier is a field on it and never its identity, so the generic
lifecycle can never become provider-shaped by way of its primary key.

| Column | Meaning |
| --- | --- |
| `id` | `mon:mpay:<opaque>` — Monacado's row |
| `participantId` | FK, **RESTRICT** |
| `provider` | which external party, from the closed `PAYMENT_PROVIDERS` enum |
| `providerAccountRef` | the provider's opaque account reference |
| `readiness` | the 0M.1 `PaymentReadinessStatus` |
| `readinessObservedAt` | when the provider last answered; `NULL` until first observation |

Naming *which* provider is a Monacado fact — the record is meaningless without
it, and reconciling a reference against the wrong provider is exactly the mistake
the column prevents. What is **not** present is anything provider-*shaped*: no
`charges_enabled`, no `payouts_enabled`, no `capabilities`, no `requirements`, no
`past_due`, no `disabled_reason`. A test asserts that no provider term appears in
any status, requirement, or reason vocabulary, and that no payment-provider SDK
is a dependency of this repository.

**Two uniqueness guarantees**, both at the index rather than in a read-then-write
check, so concurrent callers cannot both succeed:

- `(participantId, provider)` — one account per participant per provider (0M.1 §9);
- `(provider, providerAccountRef)` — **one provider account belongs to exactly
  one participant.** Without this, two participants could claim the same external
  account and every payout attribution built on it would be ambiguous.

### The multi-provider readiness rule is deferred, and refused rather than guessed

The schema permits one account per `(participant, provider)` because 0M.1 §9
specified that key. What 0M.1 never specified is **which** answer a participant's
single `paymentReadiness` field takes when two providers disagree. Inventing a
reduction — most ready, least ready, most recently observed — would be a
commercial policy decision made inside a persistence phase.

So the second registration is refused
(`MultiplePaymentProvidersNotSupportedInPhaseError`), and
`evaluateParticipantPaymentReadiness` **fails closed** rather than choosing if two
rows are ever reached (`AmbiguousPaymentReadinessError`). The value feeds
`canReceivePayout`; picking one of two disagreeing answers is not a thing a
persistence layer may do quietly.

---

## 2. The external-provider observation boundary

**The database is authoritative for Monacado's state; the provider's answer is an
observed external fact.** A transient API response is not Monacado state until it
commits.

Every observation records four things together, because any one alone is
unreconcilable later: the **provider**, the **observed value**, the **instant**,
and the **account reference it was observed for**.

Three refusals, all fail-closed:

- **A reference mismatch is not an update.** An observation naming a different
  provider account than the stored one is a reconciliation failure. Silently
  re-pointing the row would rewrite which external account a participant is
  linked to on the strength of one API response, and the payout attribution built
  on it afterwards would be attached to an account nobody decided to link.
- **An illegal transition is refused**, from the 0M.1 table itself.
- **Nothing is inferred.** Recording `ENABLED` moves no participant status.

Requirements are **replaced wholesale**, not merged: the provider reports a
current outstanding set, and merging would leave a satisfied requirement standing
forever because no message ever says "this one is done".

Re-recording the *same* readiness is permitted even where the transition table
has no self-edge — polling the same answer twice is the normal case, not an
illegal move.

---

## 3. The readiness lifecycle

**0M.1's, reused exactly.** No parallel state machine was invented, and
`PAYMENT_READINESS_TRANSITIONS` is imported rather than restated.

```
NOT_STARTED       → DETAILS_REQUIRED, PENDING_PROVIDER, DISABLED
DETAILS_REQUIRED  → PENDING_PROVIDER, RESTRICTED, DISABLED
PENDING_PROVIDER  → ENABLED, DETAILS_REQUIRED, RESTRICTED, DISABLED
ENABLED           → RESTRICTED, DETAILS_REQUIRED, DISABLED
RESTRICTED        → ENABLED, DETAILS_REQUIRED, DISABLED
DISABLED          → DETAILS_REQUIRED
```

An account is created `NOT_STARTED` and at no other status:
`RegisterPaymentAccountInput` **has no `readiness` parameter**, which is a
stronger guarantee than validating one. `NOT_STARTED → ENABLED` stays refused —
readiness is always the provider's answer, and a path that reached `ENABLED`
without the provider deciding would let an operator mark an unverified
participant payable.

---

## 4. Provider requirements

`PAYMENT_REQUIREMENT_CODES` is a closed vocabulary of **areas**, at the coarsest
granularity that still lets Monacado tell a participant where to go:

`IDENTITY_DETAILS_REQUIRED` · `BUSINESS_DETAILS_REQUIRED` ·
`REPRESENTATIVE_DETAILS_REQUIRED` · `PAYOUT_DETAILS_REQUIRED` ·
`DOCUMENT_VERIFICATION_REQUIRED` · `ADDITIONAL_VERIFICATION_REQUIRED` ·
`PROVIDER_TERMS_ACCEPTANCE_REQUIRED`

They live on a child table rather than a delimited column, so each outstanding
category is a row that can be indexed and constrained, with
`(paymentAccountId, requirementCode)` unique — the same category twice is one
outstanding thing.

**They say *where* onboarding is incomplete, never *what* the provider asked
for.** There is no column for a document reference, a field name, a rejection
reason, a person, or a provider message. Monacado needs to know onboarding is
outstanding; it must not become the repository of the provider's underwriting
file, and a table that cannot hold one will not become one by accretion.

---

## 5. Privacy

**Nothing below is persisted, and none of it is admissible through any input.**
Every input is a `strictObject`, so each arrives as an unknown key and fails
validation — the guarantee is structural, not a filter someone can forget to
call. `NEVER_ON_PAYMENT_ACCOUNT` names all 29, and a test walks the list against
both write inputs.

Passwords · session tokens · API keys · publishable and secret keys · access,
refresh, and bearer tokens · webhook secrets · client secrets · bank account and
routing numbers · IBANs · card numbers · tax identifiers · VAT numbers · SSNs ·
dates of birth · legal names · addresses · identity documents · document URLs ·
raw KYC/KYB payloads · underwriting data · provider error payloads · raw provider
responses · stack traces.

Two further guards:

- **The provider account reference refuses two shapes.** A `mon:` form, because a
  Monacado identity stored as an external one would leave the next reader unsure
  which layer they held (ADR §11.5); and the prefixes provider *secrets* take
  (`sk_`, `rk_`, `pk_live_`, `whsec_`, `Bearer `, `Basic `), because a reference
  field is exactly where a key gets pasted and the difference between an account
  id and a secret is one autocomplete. A backstop, not the guarantee — the
  guarantee is that no credential column exists at all.
- **Errors disclose nothing.** No error carries a provider message, a requirement
  detail, a bank detail, a legal name, or a database message; internal causes are
  non-enumerable, so `JSON.stringify(error)` cannot leak a driver string. Bounded
  transitions *are* named, because both ends are closed-enum members the caller
  already supplied.

**No public capsule projection exists for payment-account data, and none is
required.** Payment-provider state is operational-only (0M.1 §8) and never
becomes capsule content.

---

## 6. The provider account reference

Persisted for exactly one purpose: reconciling Monacado's participant with the
external account.

- **Not an AgentNet Node**, not a capsule identity, and never published.
- **Participant identity is never inferred from it.** The foreign key is the only
  linkage; the reference is a payload.
- Treated as opaque — no Monacado logic parses, splits, or interprets it.

---

## 7. Payment readiness versus marketplace activation

The 0M.1 §5 separation, now enforced structurally in both directions.

| | Payment readiness | Marketplace activation |
| --- | --- | --- |
| Answers | is the **provider** ready? | has **Monacado** admitted this participant? |
| Decided by | the payment provider | a Monacado reviewer |
| Home | `ParticipantPaymentAccount.readiness` | `MarketplaceParticipant.status` + `ParticipantActivation` |
| Written by | `recordObservedProviderState` only | `activation-service` only |

- **An `ENABLED` observation activates nobody.** It changes no participant status
  and creates no activation row. Tested.
- **An approval writes no provider state.** `activation-service` reads readiness
  and touches `ParticipantPaymentAccount` nowhere, so a Monacado approval cannot
  fabricate a provider answer. Tested by asserting the payment record — readiness,
  observation instant, reference, and `updatedAt` — is byte-identical across an
  approval.
- **Payment readiness is not a gate on *submitting*** (0M.1 §5): provider
  onboarding and Monacado review are independent, and requiring one to start the
  other would make a provider outage a Monacado review outage.
- **Payment readiness `ENABLED` *is* a gate on approving.** Discovering at
  settlement time that an admitted seller cannot be paid is worse than refusing at
  the gate.

### Payout readiness

The committed 0M.1 model has **one** provider axis, and `canReceivePayout` reads
that one field. No payout-specific readiness was invented: splitting the axis
without a contract asking for it would create a second answer that can disagree
with the first.

`canReceivePayout` becomes **evaluable** in this phase — participant `ACTIVE` +
role `ACTIVE` + payment `ENABLED`, all now reachable from persisted state. It
performs no payout, and this phase creates nothing that could.

---

## 8. Submission versus governed approval

Separate acts, separate calls, because `UNDER_REVIEW` is a state of its own
(0M.1 §4.1) and a reviewer needs to see what was submitted before deciding it.
One call that both submitted and approved would make "submitted" unobservable.

### Submission

Authorization is the committed **`canSubmitActivation`** decision, evaluated
against a subject materialized from persisted state — not a local restatement of
its rules. It refuses a disabled account, a non-participant, an incomplete
profile, an already-submitted review, an already-admitted participant, and a
participant holding no activatable role, each with its own bounded reason code.

Three writes, one transaction:

1. the participant moves `PROFILE_COMPLETE → UNDER_REVIEW`, checked against the
   0M.1 table rather than assumed;
2. every activatable role at `DRAFT` moves to `PENDING_ACTIVATION` — that
   status's own meaning, "included in a submitted activation";
3. one undecided `ParticipantActivation` row is appended.

At most one undecided activation per participant, enforced by the
`undecidedForParticipantId` unique index.

### Governed review

Order of checks, and the order is the point:

1. **Reviewer authorization** from persisted entitlement state, before anything
   else is read — an unauthorized caller learns nothing about the participant,
   not even whether it exists.
2. **Self-review**, from the persisted ownership foreign key, before the pending
   activation is looked up — see §9.
3. **Decision/reason coherence** — an `APPROVED` row reading `PROVIDER_DECLINED`
   is an audit record that argues with itself.
4. **An undecided activation exists**, claimed by its own id *and* its
   still-undecided marker, so a concurrent decision updates zero rows rather than
   overwriting the first.
5. **For `APPROVED` only**, every prerequisite via `evaluateActivationApproval`.

`evaluateActivationApproval` **collects every outstanding refusal rather than the
first**. A reviewer told only "profile incomplete", who fixes it and is then told
"payment not enabled", has been made to discover the requirements one round trip
at a time. It accepts no risk input of any kind — no score, classification,
reserve, or restriction scope is a parameter, so `0M.R1` cannot be smuggled in
early. It accepts no reviewer-authorization input either: that is settled first,
with its own vocabulary, so a refusal cannot leak participant state alongside an
authorization failure.

---

## 9. Authorization — two vocabularies, two authorities

**Activation review is a Monacado internal operational authority, not a
marketplace participant role.** The split is exact:

| | Submission | Review |
| --- | --- | --- |
| Capability | `activation:submit` | `activation:review` |
| Vocabulary | `MARKETPLACE_CAPABILITIES` | `ACCOUNT_CAPABILITIES` |
| Answers | may this **participant** submit itself for review? | may this **internal account** make the governed decision? |
| Derived from | participant status + role state | an explicit active `AccountEntitlement` |
| Decided by | `canSubmitActivation` | `canReviewParticipantActivation` |

**The two vocabularies are disjoint, permanently.** Neither accepts the other's
strings — `AccountCapability.safeParse("activation:submit")` fails, and
`activation:review` appears nowhere in `MARKETPLACE_CAPABILITIES`. Unknown
capability strings remain refused by both. This is the 0M.1 §1 separation, which
`marketplaceCapabilitiesGrantedByInternalEntitlement` and
`internalCapabilitiesGrantedByMarketplaceRoles` already enforce in both
directions by returning the empty array permanently.

### Reviewer authority is persisted and evaluated, never caller-asserted

`DecideParticipantActivationInput` has **no authorization field at all** — there
is nothing to assert, and a supplied one is a validation failure. It carries
`reviewerAccountId`, which names *who is acting*, never *what they may do*.

The service then, in order:

1. resolves that account's subject from the database —
   `resolveInternalAuthorizationSubject` reads the account's identity status and
   its **active** entitlements via `listAccountCapabilities`;
2. evaluates `canReviewParticipantActivation`;
3. refuses on `DENY`, **before any participant state is read**.

Capabilities are read on every decision, never from a token claim and never from
a cache, so a **revocation fails closed on the very next decision** — the same
rule `resolveAuthenticatedPrincipal` follows.

Three bounded refusals, each a classification carrying no value:
`INTERNAL_ACCOUNT_REQUIRED` (no such account — distinct from a known account
holding nothing), `INTERNAL_ACCOUNT_DISABLED`, `INTERNAL_CAPABILITY_NOT_GRANTED`.
Every decision reports the governing capability, allowed or refused.

### Marketplace roles and ownership confer nothing

Not SELLER, not PROMOTER, not BUYER, not owning the participant under review, not
owning the account that owns it, not `publication-worker:status:read`, and not
merely being authenticated.

**Structurally, not by a check.** `InternalAuthorizationSubject` is a
`strictObject` of exactly three fields — `accountId`, `accountStatus`,
`capabilities` — with **no field for a role, a participant, a storefront, or an
ownership relation**. "This account owns the participant" is not a fact the
decision function is capable of learning, so no future edit can quietly make one
grant the capability. The same reasoning keeps private profile data out of
`toMarketplaceSubject`.

Prefix incompatibility is **not** relied on as the security control. A fully
activated participant holding every marketplace role is refused, and so is the
participant's own account reviewing itself — both tested against the database. One
human may legitimately hold both a participant identity and this entitlement; the
entitlement is still granted explicitly and checked independently, and the DENY
before the grant is what proves the authority came from the grant.

### Separation of duties — a reviewer may not decide their own

**Holding `activation:review` is necessary but not sufficient.** An entitled
account may review other participants and **may never decide the activation of
the participant it owns**. Deciding one's own admission is the decision a
governed review exists to prevent, and no entitlement makes it self-governed.

The condition comes from persisted state and nothing else:

```
MarketplaceParticipant.accountId === reviewerAccountId  →  refuse
```

`MarketplaceParticipant.accountId` is the authoritative Account ↔ participant
relationship — unique, non-null, and the same column every other ownership
question in this track reads. Ownership is **never** inferred from an email, a
display name, a caller claim, or the shape of an identifier. Prefix
incompatibility is explicitly not the control, and could not be: both sides of
the comparison are `mon:acct:` forms.

**Its own bounded refusal**, `ACTIVATION_SELF_REVIEW_NOT_PERMITTED`, deliberately
not overloaded onto `ACTIVATION_REVIEWER_NOT_AUTHORIZED`,
`INTERNAL_CAPABILITY_NOT_GRANTED`, or any participant-lifecycle error. "You may
not review activations" and "you may review activations, and not this one" are
different answers — an operator told the first would go looking for a grant they
already hold. The error names neither account: disclosing either would expose the
linkage the refusal is about.

**This is independent of marketplace roles.** The rule reads the ownership FK, so
it holds whatever roles the participant carries — SELLER, PROMOTER, BUYER, all
three, or none. The internal rule never consults them.

**It does not touch submission.** `activation:submit` is unchanged, and a
participant submitting *its own* activation request is the ordinary path. The
prohibition is on the internal governed **review**, never on the request.

**And it adds nothing else.** No second reviewer, no quorum, no dual approval, no
risk policy, no `0M.R1`. An entitled reviewer decides another account's
participant exactly as before.

**Check ordering.** Authorization is settled before ownership is looked at, and
self-review is refused before the pending activation is looked up. So an
unauthorized caller who happens to own the target still receives the
*authorization* refusal — it cannot learn that the participant exists or who owns
it — and an entitled self-reviewer does not learn whether a review is even
outstanding.

### The reviewer identity is the audit identity

`decidedByActorId` remains the opaque audit identity, and stores the **reviewing
account id** — one value, not two.

0M.1 §9 anticipated a `mon:actor:` form by analogy with the
publication-remediation decision, which has no account behind it. An activation
reviewer does, and the identity foundation already rules that "the account id IS
the actor id: one stable, opaque, durable identity that authorization keys on"
(`account-principal.ts`), typing `AuthenticatedPrincipal.actorId` as `AccountId`.
Phase 0M.8 reuses that existing mechanism rather than inventing a mapping.

**Using one identity is what binds the audit actor to the authorized reviewer.**
`activation:review` is evaluated against this exact account, and this exact
account is what the row records. Two separately supplied identities — one to
authorize against, one to write down — could disagree, and the audit trail would
then name someone who was never checked. The input refuses a second identity, a
participant id, an email, and a display name.

The activation record stays private operational data (0M.1 §8) and is never
published, so no account id is exposed publicly. The column is unchanged:
`VARCHAR(191)`, nullable while undecided — **no migration**.

### `INTERNAL_OPERATOR` is a classification, not an authorization

`INTERNAL_OPERATOR_CAPABILITIES` became an explicit set, as
`account-principal.ts` anticipated when it held one member. Holding any internal
capability classifies an account as `INTERNAL_OPERATOR`; every internal surface
still checks the **specific** capability it requires, so `activation:review`
grants no publication-worker status read and vice versa. Both directions tested.

---

## 10. Decision outcomes

| Decision | Participant status | Roles | Evidence |
| --- | --- | --- | --- |
| `APPROVED` | → `ACTIVE` | `PENDING_ACTIVATION` → `ACTIVE`, `activatedAt` stamped | decision, instant, actor, reason code |
| `MORE_INFORMATION_REQUIRED` | → `PROFILE_INCOMPLETE` | unchanged | same four fields |
| `REJECTED` | **unchanged** | unchanged | same four fields |

- **`APPROVED` is the only decision that admits**, and only when every
  prerequisite holds — including provider `ENABLED`, which Monacado cannot supply
  for itself.
- **`MORE_INFORMATION_REQUIRED` returns to `PROFILE_INCOMPLETE`**, which the 0M.1
  table permits from `UNDER_REVIEW` and which is what asking for more information
  means without suspending anyone. No notification is invented — see §12.
- **`REJECTED` moves no status and never closes the participant.** The lifecycle
  has no rejected state; `CLOSED` is terminal and means the participant gave up.
  Closing on Monacado's behalf would end an admission the participant may
  legitimately resubmit.

`ACTIVATION_DECISION_REASON_CODES` is the enumeration 0M.1 §9 called for and left
unenumerated. Every decision requires one, including `APPROVED`: a decision with
no recorded reason is an audit row that says what happened and not why, which is
the half that matters at review time. `REASON_CODES_BY_DECISION` pairs each code
with exactly one decision, and the pairing is data rather than a branch.

### ParticipantActivation is the audit record, unchanged

The table 0M.5 created and deliberately left empty is used exactly as designed —
no column added, none repurposed. **Append-only, enforced rather than described:**
a decided row is never re-decided, and a second review is a second submission and
a second row, so the first survives. The deciding actor stays an opaque
`mon:actor:` id, never an email or a display name.

**No status reaches `ACTIVE` without an activation row**: both writes happen in
one transaction, so a participant can never be `ACTIVE` with no record of who
decided it, and an activation can never be decided while the status it justified
failed to move.

---

## 11. The `RESTRICTED` / `SUSPENDED` phase gate

**0M.8 writes neither, from any path.**

> **Phase 1.16 discharged half of this, exactly as §13 anticipated.** The
> premise below — "until [the machine-readable restriction scope] exists" — was
> discharged by `0M.R1`, and Phase 1.15 gave three of its scopes real production
> readers. An activation approval may now land `RESTRICTED`, but only as a
> reconciliation of counted authoritative restriction rows read in the same
> transaction, never as something the review chose.
>
> What did not change: `participantStatusAfterDecision` still cannot return
> `RESTRICTED` or `SUSPENDED`, no caller can request either,
> `RestrictionScopeNotAvailableInPhaseError` still guards the review's own
> output, and `SUSPENDED` remains unreachable from this path — an approval over
> an active suspension is refused outright rather than reconciled.

Both mean "admitted, some capability withheld" (0M.1 §4.1), and nothing in the
repository expresses **which** capability — `capability.ts` tests only
`status !== "ACTIVE"`. Writing either would record a status a later reader cannot
act on, and a restriction nobody can enumerate is indistinguishable from a
suspension.

The machine-readable restriction scope belongs to **`0M.R1`**. Until it exists:

- `RestrictionScopeNotAvailableInPhaseError` is the refusal — a *sibling* of
  `ActivationNotPermittedInPhaseError` and deliberately distinct from it. That one
  means "this phase does not make the decision that would justify the status";
  this one means the stronger thing, "the status has no content to write".
- The refusal **fails closed and substitutes nothing.** No status is silently
  swapped in, and no restriction semantics are fabricated.
- No decision produces either status, and no `restrictionScope`, `riskScore`,
  `riskClassification`, `reserveAmount`, `payoutHold`, `transactionCap`, or
  `velocityLimit` column exists anywhere in the database. Asserted against
  `information_schema`.

**The 0M.5 draft gate was not lifted.** `advanceParticipantStatus` still refuses
all four statuses. 0M.8 added a service that writes `UNDER_REVIEW` and `ACTIVE`
*together with* the activation row, so the draft path stays exactly as narrow as
it was — which is stronger than widening it would have been.

---

## 12. What this phase deliberately does not do

**No money movement.** No model or service for a charge, payment-intent-like
transaction, order, checkout, capture, refund, chargeback, settlement, payout
execution, seller proceeds, promoter proceeds, Monacado retained amount, MoR
acquisition amount, tax, or shipping. Asserted against `information_schema`: no
table whose name contains `order`, `charge`, `paymentintent`, `payout`,
`settlement`, `refund`, `chargeback`, `ledger`, `commission`, `taxclass`,
`taxtransaction`, `riskpolicy`, `riskdecision`, `notification`, or `notice`
exists.

**No notification subsystem (`0M.N1`).** No email, SMS, inbox notice, delivery
channel, or notification-obligation table. The durable activation and payment
state **is** the audit evidence for this phase: `ParticipantPaymentAccount`
carries the provider's answer with its observation instant and outstanding
categories, and `ParticipantActivation` carries the decision, instant, actor, and
reason. Every onboarding event the phase produces — verification required,
onboarding incomplete, provider approved, provider declined, additional
information required, activation approved or refused — is durably recorded by the
state it changes.

**No risk framework (`0M.R1`).** No risk policy table, restriction scope,
reserve, transaction cap, velocity control, fraud rule, or manual-review engine.
The only risk-related rule in this phase is the `RESTRICTED`/`SUSPENDED` gate
above.

**No tax or accounting foundation (`0M.T1`).** No MoR ledger, tax class, tax
calculation, settlement state, transaction economics snapshot, or policy
persistence. No transaction exists yet for any of it to describe.

**No concrete provider adapter.** `PaymentProviderPort` is an injected interface
and, in this phase, only an interface: no implementation, no SDK dependency, no
credential, no endpoint, no network call, no hosted onboarding session, no
webhook ingestion. `package.json` carries no payment-provider dependency and a
test asserts it. The adapter's real work — mapping a provider's dynamic
requirement model onto `PaymentReadinessStatus` and `PaymentRequirementCode` — is
deferred with it, which is what keeps every column above provider-neutral.

**Also not in scope:** HTTP routes, UI, participant Node, participant capsule,
publication, Registrar interaction, and guest checkout.

---

## 13. Deferred to named phases

| Phase | Owns |
| --- | --- |
| `0M.R1` | Versioned commercial policy; the machine-readable restriction/risk scope `RESTRICTED` and `SUSPENDED` require |
| `0M.N1` | Notification obligation records (delivery is `0M.N2`) |
| `0M.T1` | MoR transaction accounting foundation |
| `0M.9` | Buyer checkout, Order, commission, payout, review submission |
| — | The concrete provider adapter |

---

## Reference

- [`MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md`](MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md) — the 0M.1 design this phase completes
- [`PARTICIPANT_PERSISTENCE.md`](PARTICIPANT_PERSISTENCE.md) — the 0M.5 phase this one continues
- [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md) — §J risk, §G/§H tax and shipping boundaries
- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
- [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) — binding ADR
- [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md)
