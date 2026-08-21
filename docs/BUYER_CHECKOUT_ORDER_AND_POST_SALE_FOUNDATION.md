# Buyer Checkout, Order, and Post-Sale Foundation — Phase `0M.9`

**Status:** implemented. The first phase that creates an actual commercial
transaction.

The complete buyer flow, end to end:

```
Listing → checkout request → Order → payment result → immutable transaction
economics → commission/payout obligations → review eligibility
```

Provider-neutral throughout. **No live payment integration exists.**

---

## 1. The checkout flow

```
prepareCheckout(input, policyId)          ← pure read; writes nothing
   ├─ load the Listing's CURRENT source version, and record which one that was
   ├─ derive the EFFECTIVE retail price at the checkout instant
   ├─ verify buyer eligibility (0M.4A's evaluator, every reason reported)
   ├─ resolve the exact accepted Offer version for a promoted Listing
   ├─ resolve the EFFECTIVE commercial policy → bind (policyId, policyVersion)
   ├─ accept externally supplied tax / shipping / pass-through amounts
   └─ derive the buyer total

placeOrder(...)                           ← Order written, PENDING_PAYMENT
executeOrderPayment(order, provider, port) ← the ONLY I/O; outside any transaction
recordPaymentResult(...)                  ← success: one atomic write; failure: minimal state
```

### Nothing commercial is accepted from a caller

There is **no parameter** for a retail price, Monacado's retention, an acquisition
amount, seller proceeds, a commission, or a promoter's spread. A caller supplies
only what Monacado genuinely cannot derive: which Listing, which buyer, and the
tax, shipping, and pass-through amounts an external system charged. A contract
test walks the list and proves each is refused by the `strictObject`.

The Listing **source version is not a parameter either**. A buyer buys what is on
sale *now*, so checkout follows the current-version pointer once and then records
which version that was; everything downstream binds the recorded label. Letting a
caller name a version would let someone purchase terms already withdrawn.

### Product availability is supplied; go-live approval is **read**

`productAvailability` is an input — it is the Product model's question and this
phase adds no second answer to it.

**Go-live approval is not an input.** It briefly was, on the reasoning that
`0M.3A` made it "a supplied decision input" with no column to read. That was
tolerable while nothing could be bought and became indefensible the moment `0M.9`
performed a real purchase: **a caller passing `APPROVED` would be a caller making
a Listing purchasable.** It is now resolved from the governed
`ParticipantCommerceApproval` record (§2), and there is no parameter anywhere on
the checkout path through which a caller can assert or override it.

`evaluateBuyerEligibility` in the Listing service reads it the same way, so
approval cannot be asserted through that door either.

---

## 2. Governed commerce approval

Monacado's determination that a participant may **transact** — the go-live
approval `0M.3A` defined and deliberately refused to store as a Storefront fact:

> It is **supplied to decisions and derived by nothing here.** It is not a
> Storefront source field… it is Monacado's opinion about a participant, not a
> fact about a shop.

That ruling stands. The decision is recorded **against the participant it is
about**, on `ParticipantCommerceApproval` — there is deliberately **no
`storefrontId` column**, so the approver's judgement never lives inside the
approved thing. What `0M.3A` left open was *where the supplied value comes from*,
and the answer is no longer "a caller".

| | |
| --- | --- |
| Decision | `APPROVED` / `NOT_APPROVED` — `0M.3A`'s own `GO_LIVE_APPROVAL_STATUSES`, reused not restated |
| Reason | bounded code, never free text |
| Actor | `decidedByAccountId`, the **same** identity the entitlement was checked against |
| Instant | `decidedAt`, supplied |
| History | a new decision **supersedes** the previous one; nothing is edited or deleted |
| Currency | one current decision per participant, enforced by a unique marker index |

**Absence means `NOT_APPROVED`.** No row is the default and the default is the
safe one: nothing is seeded, no migration grants anyone clearance, and a
participant nobody has assessed cannot sell. Absence is interpreted in exactly one
place (`effectiveCommerceApproval`), so a forgotten `?? "NOT_APPROVED"` cannot
silently clear somebody.

### Authority

A **new, narrow internal capability: `participant:commerce-approve`.** Neither
existing internal grant was reused, and neither was close enough to borrow:

- **not `activation:review`** — that decides an *admission*. A participant may be
  admitted and still not cleared to take money; folding them would mean everyone
  who could admit someone could also clear them to sell.
- **not `participant:restrict`** — that authorizes **withholding** a capability
  from someone who already has it. This authorizes **granting** the clearance.
  They point in opposite directions, and "may take commerce away" is not "may
  hand commerce out".

Checked against **persisted entitlement state on every call**, so a revocation
fails closed on the very next decision. A marketplace role, participant
ownership, and account ownership confer nothing — the internal authorization
subject has no field capable of carrying one. **Separation of duties** applies:
an actor may not decide approval for the participant their own account owns.

### Whose approval is read

The **Storefront's owner**, which is whose clearance `storefrontExposure` has
always been about: `isPubliclyAccessible` asks whether the shop is reachable, and
the shop is reachable exactly when Monacado has cleared its owner. A promoted
Listing therefore reads the promoter's clearance, because the promoter owns the
storefront the sale happens in.

Withdrawing approval stops sales immediately — a test buys, withdraws, and
watches the next checkout refuse.

---

## 3. Guest versus authenticated buyer

Guest checkout is **first-class**, not a degraded account.

| | Account buyer | Guest buyer |
| --- | --- | --- |
| `buyerKind` | `ACCOUNT_BUYER` | `GUEST_BUYER` |
| Account | required | **no field for one** |
| Participant | recorded *if the account already holds one* | **no field for one** |
| Claim-code digest | **no field for one** | required |

A discriminated union, preserved in storage and rebuilt from the discriminator by
the mapper — so neither branch can acquire the other's fields.

**Guest checkout creates no `Account` and fabricates no `MarketplaceParticipant`.**
An integration test counts both tables before and after a guest purchase and
asserts neither moved.

**Buying requires no participant, no role, and no activation.** Those gate
*selling*. Most account buyers hold no participant record, and `0M.1` is explicit
that such an account "is treated as a guest buyer, which is what they are until
they claim otherwise."

### No buyer personal data, anywhere

There is no column on any table this phase created for an email, a name, a postal
address, an IP address, a card detail, or a device. The cheapest way to keep a
promise about data is to have no column for it.

### Claiming a guest purchase

The **minimum durable foundation** the roadmap asks for:

- a 256-bit random claim code is minted at checkout and **returned once**;
- only its **SHA-256 digest** is stored — the same construction and reasoning as
  `session-token.ts`, compared by the unique index so there is no timing signal;
- `claimGuestOrder` verifies possession and records `claimedByAccountId` /
  `claimedAt`;
- **every refusal is the same error.** Distinguishing "wrong code" from "already
  claimed" from "no such order" would make this an oracle for probing which order
  ids exist.
- **`buyerKind` stays `GUEST_BUYER` forever.** The sale was made by a guest, and a
  record that quietly became an account purchase would misstate what happened.

There is deliberately **no expiry**: a purchase does not stop having been made,
and a code that expired would strand a buyer's own receipt behind a deadline
nobody told them about. A claim window is a policy decision for the claim phase,
made in the open.

---

## 4. Order lifecycle

```
PENDING_PAYMENT ──> PAID            (terminal)
       │
       ├──────────> PAYMENT_FAILED ──> CANCELLED
       │
       └──────────> CANCELLED
```

- **`PAID` is terminal for the Order.** A completed sale does not become
  uncompleted; a reversal is *settlement standing* on the economic snapshot.
- **A failed payment never becomes paid. A retry is a new Order.** The
  alternative is a row whose history says "failed" while its state says "paid",
  and no reader could tell how many times the buyer was charged.

**Settlement is not restated here.** Where the *funds* got to — `PENDING`,
`FUNDS_RECEIVED`, `SETTLED`, `REVERSED` — is `0M.T1`'s `TransactionSettlement`.
Two lifecycles over one sale would be two answers to one question, and the first
divergence would be unresolvable. A test asserts the `Order` table has no
settlement column.

---

## 5. The payment-port boundary

```ts
interface BuyerPaymentPort {
  executePayment(request: BuyerPaymentRequest): Promise<BuyerPaymentResult>;
}
```

**An interface with no implementation.** No SDK, no HTTP client, no credential, no
endpoint, no network call, and no payment dependency in `package.json`. A test
supplies a scripted double; production supplies a real adapter when live payment
integration lands.

- **Provider-neutral.** Nothing Stripe-shaped: no payment intent, no client
  secret, no confirmation method, no webhook.
- **Distinct from `PaymentProviderPort`** (`0M.8`), which asks where a
  *participant's account* stands. This charges a *buyer*. One interface answering
  both would be a privilege nobody scoped.
- **The result is a discriminated union.** A success carries a provider
  transaction reference and no failure code; a failure carries a bounded
  classification and no reference. There is no "succeeded but…" shape.
- **The idempotency key is required**, and is the **Order id**, so every retry of
  one charge carries one key. A key generated per call would defeat its own
  purpose.
- **No credential and no buyer data passes through.** How an adapter
  authenticates is the adapter's problem; a credential in a request object is a
  credential in a log.

The request carries the **buyer's total** and nothing about the commercial split
— the provider has no reason to learn what the seller earned.

---

## 6. The successful-sale atomic write

`recordPaymentResult` on success commits **one transaction** containing:

1. the `0M.T1` economic snapshot and its `PENDING` settlement row;
2. the snapshot's `orderId` binding — the additive nullable column `0M.T1`
   anticipated;
3. the provider transaction reference on the settlement row;
4. one `ProceedsObligation` per party owed — one seller-direct, two promoted;
5. the private `PurchaseEvidence`;
6. `SALE_RECORDED` notification obligations for the seller and any promoter;
7. the Order's move to `PAID`.

**The invariants this makes structural**, not merely likely:

- a `PAID` Order **without** economics is impossible;
- economics **without** its Order is impossible;
- a promoted sale **without** its promoter obligation is impossible.

An integration test forces a failure partway through the transaction and asserts
that the snapshot, the settlement row, the obligation, the evidence, and the
notification all rolled back, leaving the Order still `PENDING_PAYMENT`.

### The external call, handled pragmatically

A network call cannot sit inside a database transaction. The design is therefore:
**place the Order first (durable), charge, then record the result.** If the
process dies mid-charge the Order survives as `PENDING_PAYMENT` — a state a human
or a later reconciliation can resolve — rather than a payment nobody can attach to
anything, or a sale nobody can account for.

This is deliberately **not** a distributed workflow engine. It is the smallest
arrangement that never loses money silently.

### Idempotency

| Situation | Behaviour |
| --- | --- |
| Same provider transaction replayed on a `PAID` Order | **Idempotent** — returns the existing sale; nothing is written twice |
| **Different** provider transaction on a `PAID` Order | **Refused** (`PaymentResultConflictError`) |
| Success on a `PAYMENT_FAILED` Order | Refused (`InvalidOrderTransitionError`) |

The second case is the dangerous one, and the reason replay is not blanket-
idempotent: a different provider transaction against an already-paid Order means
the buyer may have been charged twice, and recording it as an ordinary replay
would bury the one fact worth surfacing.

### The quote/snapshot check

An Order records the **quote** — what the buyer was told they would be charged,
which must exist before any payment runs. The snapshot records the **economics** —
what the sale earned each party, knowable only once it completes. They overlap on
the retail, tax, shipping, and pass-through amounts.

That overlap is a **checked invariant, not a duplicate**: the sale path asserts
each quoted amount equals the snapshot's before anything is written, and refuses
with `QuoteSnapshotMismatchError` otherwise. If the Listing were repriced between
placement and payment, Monacado would otherwise be booking a sale for one figure
having charged another.

---

## 7. Relationship to the transaction snapshot

**One-to-one, with the foreign key on the snapshot side.**

```
TransactionEconomicSnapshot.orderId  (nullable, UNIQUE)  ──> Order.id   RESTRICT
```

Nullable because the column is additive over rows written before `0M.9` existed;
every snapshot this phase writes sets it inside the same transaction that marks
the Order `PAID`. The key is on the snapshot side because an Order exists before
any economics do — a column on the Order would be null for the entire window in
which the payment is actually running.

**No economic fact is duplicated onto the Order.** Monacado's retention, the
acquisition amount, seller proceeds, the Offer wholesale price, the commission,
the promoter's spread and net — none has a column on `Order`, and all are named
in `NEVER_ON_ORDER`.

`0M.T1` gained one refactor to make the atomic write possible:
`recordTransactionEconomicSnapshotInTx` — the same reads, the same committed
calculators, the same reconciliation check, inside a transaction the caller
already holds. The public function is now a thin wrapper around it. **No second
implementation of the economics exists.**

---

## 8. Seller and promoter obligations

`ProceedsObligation` answers: **what is each party owed, and where does that claim
stand.**

| Sale type | Obligations created |
| --- | --- |
| Seller-direct | one — `SELLER`, the whole acquisition amount |
| Promoted | two — `SELLER` and `PROMOTER` |

Not "two, one of them zero": a seller selling their own product has no promoter
counterparty, and a zero row would describe one who earned nothing rather than
one who does not exist.

**Amounts are copied from the snapshot, never recomputed.** A seller's claim is
exactly `sellerProceedsMinorUnits`; a promoter's is exactly
`promoterNetProceedsMinorUnits` — spread **plus** the seller-funded commission.
Taking only the spread would silently withhold what the seller funded, which is
precisely the conflation `MONACADO_MOR_BUSINESS_MODEL.md` §D warns against.

**Monacado is not a party.** Its retained amount is what it *kept*, already on the
snapshot; an obligation row for it would model the retailer as its own creditor.

```
PENDING ──> ELIGIBLE ──> PAID   (terminal)
```

Forward-only. `PAID` records that Monacado settled the claim — **it does not
settle it. No payout is executed in this phase.** What *moves* an obligation to
`ELIGIBLE` is deliberately not decided here: funds settlement is `0M.T1`, return
windows are unbuilt, and payout holds are explicitly `0M.R2`.

There is no column for a transfer, batch, schedule, bank detail, provider payout
identifier, reserve, or tax withholding.

### The promoted worked example, as rows

$100.00 retail, $50.00 Offer wholesale, 20% seller-funded commission:

| Record | Amount |
| --- | --- |
| Snapshot — Monacado retained | $8.50 |
| `ProceedsObligation` SELLER | $40.00 |
| `ProceedsObligation` PROMOTER | $51.50 |
| **Total** | **$100.00** |

---

## 9. Review eligibility and submission foundation

`0M.1` settled the review-authority model. This phase supplies the **rows** the
roadmap names as `0M.9`'s: "the first real `ReviewSubmissionAuthority` rows".

**`PurchaseEvidence`** — Monacado's private record that a buyer transacted, one
per completed Order. It names which Product and which seller, and **nothing about
the person**. Referenced by id and never published (ADR §11.10).

There is deliberately **no guest identifier** on it: a stable per-guest identifier
would be the tracking key this design exists without. A guest reaches their
evidence through their Order, which they reach with their claim code.

**`ReviewSubmissionAuthority`** — every column maps onto `0M.1`'s committed
`ReviewSubmissionAuthorityView`, so a persisted row feeds
`evaluateReviewCapsuleAuthority` unchanged. **No second authority evaluator was
written.** `orderId` and `purchaseEvidenceId` are storage lineage and are
deliberately absent from that view: an authority decision has no business knowing
an order id, and a view carrying one could leak it into a capsule projection.

- **A completed purchase makes the buyer eligible** to review the Product and the
  Seller.
- **One authority per governed subject per Order**, enforced by a unique index.
  Buying once does not license writing repeatedly.
- **The promoter is not a reviewable subject.** They neither made the product nor
  contracted its supply.
- **A guest may review.** `0M.1` is explicit that a guest is "a real, supported
  case… and is not an account in disguise", and `canSubmitProductReview` permits
  `subject.account === null`. Authority derives from a **purchase**, not from
  having logged in — `VERIFIED` provenance is required of every reviewer, account
  holder or not. **Requiring an account claim before review would contradict a
  committed contract**, so this phase does not.

**No review content and no publication.** There is no column for text, a rating, a
title, a photo, or a moderation decision, and no capsule is projected, registered,
or published. This phase establishes *who may write*; the writing is a later
phase.

An integration test feeds a persisted authority to `canPublishProductReviewCapsule`
and asserts it authorizes publication of **its own review**, denies the Product
capsule with `REVIEW_AUTHORITY_SCOPE_EXCEEDED`, and denies somebody else's review
with `REVIEW_AUTHORITY_TARGET_MISMATCH`.

---

## 10. What remains deferred

**Live payment integration** — the concrete adapter behind `BuyerPaymentPort`,
hosted checkout, 3-D Secure, webhook ingestion, and processor reconciliation. No
SDK, credential, endpoint, or network call exists.

**`0M.T2`** — tax calculation, nexus determination, product tax classification,
sourcing, remittance and filing; refund and chargeback accounting; reversal
economics; double-entry ledger postings; settlement audit evidence. This phase
*records* tax and shipping amounts and calculates neither.

**`0M.R2`** — transaction and commercial risk enforcement, per-transaction policy
selection, reserves, payout holds, transaction caps, velocity limits. `0M.9` takes
a policy **identity** as an input and resolves its effective version; choosing
among policies is `0M.R2`'s subject.

**`0M.N2`** — notification rendering and delivery. `0M.9` records obligations
only.

**Payout execution** — obligations record what is owed. Nothing moves money to a
seller or promoter.

**Routes and UI** — no HTTP route, page, or component was added.

### A recorded boundary: buyer-facing notices

`0M.N1` keys notification obligations on **participants, never addresses**, by
design — "keying an obligation on one would hand a promoter's notices to whoever
holds the address next." A guest buyer has no participant, so **a guest receives
no obligation row**. `SALE_RECORDED` therefore goes to the seller and any
promoter (always participants); `PAYMENT_FAILED` goes to a buyer **only when that
buyer already holds a participant record**.

Buyer-facing notice for guests needs an addressing model that does not exist yet.
It belongs with `0M.N2`, which owns delivery and addressing, and is recorded here
rather than solved by inventing a guest recipient.

---

## Reference

- [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md) — §C/§D the worked examples, §G/§H tax and shipping, §I reversals
- [`MOR_TRANSACTION_ACCOUNTING_FOUNDATION.md`](MOR_TRANSACTION_ACCOUNTING_FOUNDATION.md) — `0M.T1`, the economic snapshot bound here
- [`VERSIONED_COMMERCIAL_POLICY_AND_ACTIVATION_RISK.md`](VERSIONED_COMMERCIAL_POLICY_AND_ACTIVATION_RISK.md) — `0M.R1`, the effective-policy read
- [`NOTIFICATION_OBLIGATION_RECORDS.md`](NOTIFICATION_OBLIGATION_RECORDS.md) — `0M.N1`, the obligations a sale records
- [`LISTING_SOURCE_MODEL.md`](LISTING_SOURCE_MODEL.md) · [`LISTING_PERSISTENCE.md`](LISTING_PERSISTENCE.md) — eligibility and pricing
- [`MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md`](MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md) — `0M.1`, review authority and capability decisions
- [`PAYMENT_PROVIDER_ONBOARDING_AND_ACTIVATION.md`](PAYMENT_PROVIDER_ONBOARDING_AND_ACTIVATION.md) — `0M.8`, provider-reference conventions
- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md) — financial records are relational-first
- [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md)
