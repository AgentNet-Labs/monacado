# Refunds and Tax Reversals (Phase 1.9)

Phase 1.2 built the **accounting** for undoing a sale and deliberately shipped no
way to execute one. Phase 1.7 reported a sale's tax to a provider and kept *"the
identifier a later reversal names"*. This is that later phase: the **execution**
of both halves, in Stripe TEST mode only.

The invariants this phase owns:

> **A refund is new evidence about a completed sale, never a correction of one —
> and the payment refund and the tax reversal are independently durable facts,
> either of which may fail while the other succeeded.**
>
> **The refund unit is a whole Order line. The seller owns the declared refund
> policy; Monacado enforces the version that governed the purchase.**

Nothing here enables live Stripe, implements payouts or clawback, ingests
chargebacks, files or remits tax, or publishes anything to AgentNet.

---

## 1. The lifecycle

```
Paid Order
   → refund request/decision          requestOrderRefund, commits PENDING
   → payment refund                   Stripe refunds.create      (provider #1)
   → tax reversal                     Stripe tax reversal        (provider #2)
   → durable reconciliation           local rows, no provider call
```

Three durable records, and the split is the point:

| Record | Question it answers | Mutable? |
| --- | --- | --- |
| `OrderRefund` | did the provider return the buyer's funds, and what happened on the way? | lifecycle only |
| `OrderTaxReversal` | did the tax provider reverse the sale's tax? | lifecycle only |
| `TransactionReversal` *(1.2)* | what did each party give back? | **never** — written once |

`TransactionReversal` is an immutable accounting entry with no status column at
all. Bolting attempts, leases, and failures onto it would have made it an
accounting record that changes, which is exactly what `0M.T1` built the snapshot
to prevent. So the entry is written **once**, at the moment the provider
confirms, from records that carried the attempt history separately — the same
split `1.7` drew between `OrderTaxEvidence` and `OrderTaxTransaction`.

### The composite state is derived, never stored

`refundLifecycleState(refundStatus, taxReversalStatus)` combines the two into one
word an operator reads:

```
PENDING → REFUND_IN_PROGRESS → REFUNDED → TAX_REVERSAL_PENDING
                                        → TAX_REVERSAL_IN_PROGRESS → COMPLETED
```

plus `REFUND_RETRY_PENDING`, `REFUND_FAILED_PERMANENT`, and
`MANUAL_REMEDIATION_REQUIRED`. A stored composite would be a third answer able to
disagree with the two facts it summarises — and it would disagree exactly when
one of the two provider calls had failed, which is the case it exists to
describe.

---

## 2. Refund-unit policy — a whole Order line

```
one or more lines   →  each refunded IN FULL   →  allowed
one line            →  refunded in part        →  REFUSED
```

A refund may be **partial relative to the Order** while being **full relative to
every line it touches**. Subset-of-basket refunds are permitted conceptually;
what is refused is an **arbitrary partial-dollar refund of one line**.

`REFUND_SCOPES` is `["LINE_SET"]`. It deliberately replaced `["FULL"]`, which
asserted the wrong invariant — that a refund must cover the whole Order — and
which a basket phase would have had to *rewrite* rather than extend.

The refusal is **structural**: there is no monetary amount parameter anywhere in
the request path. A caller selects **lines**; `deriveRefundAmount` computes the
figure from sale-time evidence plus the bound seller policy.
`requestedAmountMinorUnits` exists for exactly one purpose — so a caller who
names a figure anyway is refused `PARTIAL_LINE_REFUND_NOT_SUPPORTED` **before any
provider is contacted and before any row is written**.

`PARTIAL_LINE_REFUND_DEFERRAL` names what a later **sub-line** phase must rule
on. It is narrower than `1.9`'s first draft, because selecting whole lines needs
no allocation ruling at all: each line's own sale-time economics govern it. What
still needs one is splitting a *single* line — seller proceeds, promoter
proceeds, Monacado's retained amount, tax, and shipping *within* a line. That
ruling is `MONACADO_MOR_BUSINESS_MODEL.md` §I's.

### Future basket semantics, settled now

- selected lines are refunded **in full**;
- unselected lines are **untouched**;
- **each line's original sale-time economics govern its refund**;
- **nothing** is recomputed from current Product, Offer, Listing, or policy data.

### The current single-line execution limit

An Order binds exactly one Listing (`0M.9`), so it has one line and every valid
refund selects all of it — which *executes* as a whole-Order refund. That is a
property of the **Order model**, not of the refund policy, and
`SINGLE_LINE_EXECUTION_LIMIT` says so as data.

The subset path is present and **fails closed** rather than absent:
`SUBSET_LINE_REFUND_NOT_YET_EXECUTABLE`. What blocks it is named —

- no `OrderLine` table;
- `TransactionReversal.scope` has only `FULL`;
- no line-level provider tax evidence;
- no governed shipping-allocation rule.

`OrderRefundLine` is persisted per refund, so "which lines came back" is durable
rather than inferred from an Order — which matters precisely because an Order
stops meaning one line the day the basket lands.

---

## 3. Seller refund policy — versioned, and bound at purchase

**The seller owns the declared terms; Monacado enforces the version that governed
the purchase.**

```
seller declares terms → version recorded DRAFT → ACTIVE
  → checkout BINDS the exact version to the Order
  → that version governs this sale FOREVER, whatever the seller does later
```

`SellerRefundPolicy` + `SellerRefundPolicyVersionRow` reuse the pattern
`MarketplacePolicyVersionRow` and `CommercialPolicyVersionRow` already
establish — a stable identity, immutable versions, `DRAFT`/`ACTIVE`/`RETIRED`, and
an `activeMarker` enforcing at most one active version. No fourth convention was
invented.

The policy covers, at minimum:

| Term | Where it lives |
| --- | --- |
| whether refunds are allowed | `refundsAllowed` |
| eligibility conditions | `eligibilityConditions`, a closed vocabulary |
| declared time window | `refundWindowDays` — `null` means **no window**, not zero |
| shipping refundability | `shippingRefundability` |
| refund procedure | `procedureKind` + the document's `PROCEDURE` section |
| any other declared terms | bounded document sections |

### Enforced terms are columns; disclosed prose is a hashed document

`MarketplacePolicy` keeps prose in a source module because Monacado authors it. A
seller's prose cannot live in a source module, so it is stored — on an
**immutable version row**, which is a different thing from the editable text
column that model was avoiding, with `contentHash` pinning the exact bytes.

The enforceable terms are separate columns because code decides them.
`sellerRefundPolicyIssues` refuses a version whose document contradicts its terms
— the failure it prevents is a seller whose enforced terms withhold shipping and
whose prose promises it back. Whichever the buyer read, one of them was a lie,
and the buyer read the prose.

### Mutable current prose is never historical authority

An Order binds `(sellerRefundPolicyId, sellerRefundPolicyVersion)`, nullable for
Orders written before the binding existed and **never backfilled**. `RETIRED`
versions stay readable and bindable, because the version a sale was made under is
usually retired by the time anybody asks about it.

A seller who publishes tighter terms tomorrow does not retroactively tighten them
for yesterday's buyer. A test drives exactly that: sell under v1, activate a
"all sales are final" v2, and the historical Order stays refundable under v1.

### Checkout refuses a sale it cannot bind

`SellerRefundPolicyUnavailableError`, on the identical reasoning that refuses a
sale with no active marketplace policy: selling under returns terms Monacado
cannot afterwards name is worse than not selling, because the resulting Order is
an unanswerable question rather than a missing one.

---

## 4. Eligibility, from exact durable sale-time evidence

`evaluateRefundEligibility` reads only, contacts nobody, and returns **every**
refusal rather than the first. It validates:

- the Order is `PAID`;
- an economic snapshot exists and is bound;
- the settlement row carries a provider payment reference;
- no refund already exists, and no `1.2` reversal arrived by another route;
- the currencies agree;
- the selected lines exist on the Order, and at least one was selected;
- the **bound seller policy** permits a refund, and its window is open;
- no conflicting refund or reversal state exists.

Line economics come from the Order's own durable quote; shipping refundability
comes from the **version bound at checkout**, never the seller's current one.

Nothing is recomputed from current Product, Offer, or commercial-policy data. A
refund priced from today's data, under today's terms, would return a figure the
buyer was never charged under terms they were never shown — and both would look
entirely correct.

The same check runs **again** immediately before money moves
(`verifyExecutableRefund`).

---

## 4b. Pre-purchase disclosure and the receipt

Two moments, one policy version, and a different clock for each.

```
BEFORE PURCHASE   readListingRefundPolicyDisclosure   → the seller's ACTIVE policy
ON THE RECEIPT    readOrderRefundReceipt              → the version the ORDER BOUND
```

The disclosure resolves the **seller**, not the Listing's controller — on a
promoted Listing those differ, and the returns terms belong to whoever supplies
the Product. It carries the **complete document**, because a disclosure a buyer
cannot read in full is not a disclosure.

The receipt read returns the complete historical policy, the exact version
reference (`policyId`, `policyVersion`, `contentHash`), the refund procedure, and
the refund-support contact **as it was disclosed at purchase**.

### The support contact is frozen, not re-resolved

`1.3` resolves a seller's support contact at ask time and deliberately does not
snapshot it, reasoning that "sending a buyer to the address that worked at
checkout would send them nowhere". That is right for a **support link** and wrong
for a **receipt**, and this phase's first draft carried the error across.

A receipt is evidence of a disclosure. A seller may later change their primary
email, nominate a dedicated support address, or both — and regenerating an old
receipt must not silently substitute an address the buyer was never shown.

So checkout freezes the effective verified contact onto
`OrderRefundContactEvidence`, keyed by the Order (`TransactionSettlement`'s
pattern), in the **same transaction** as the policy binding. It holds the exact
address, its `source` (`PRIMARY_PROFILE` | `DEDICATED_SUPPORT`), its `state` at
capture, and the instant — the provenance behind the claim that this was the
effective *verified* contact when the sale occurred. It holds **no seller name,
no second address, no profile field, and nothing about the buyer**.

| Field | Clock |
| --- | --- |
| `procedure.purchaseTimeRefundContact` | **frozen at purchase** |
| `currentSellerSupportContact` | resolved now, informational, top-level |

The two are separately named and separately placed: the historical value lives
*inside* the procedure a buyer follows, the convenience value sits beside it.
Neither can be passed where the other is expected, and **an old receipt renders
with no current contact at all** — including for a seller whose mail now bounces.

It **never substitutes**. An unbound Order returns `POLICY_NOT_BOUND`; a version
whose content has moved returns `POLICY_UNREADABLE`; a pre-correction Order
returns a `null` purchase-time contact rather than today's address. Showing
today's terms or today's mailbox for a historical purchase would be worse than
showing none, because it would look authoritative.

**No renderer is built.** `RECEIPT_SURFACE` records that as data, along with what
the Order already carries so a later renderer needs no backfill — the property
that had to exist now, because it cannot be added retrospectively to sales
already made.

---

## 4. Payment refund lifecycle

```
requestOrderRefund       → PENDING       committed; NO provider call
claimDueRefunds          → IN_PROGRESS   lock token + lease
  … the provider is called OUTSIDE any transaction …
resolveRefundAttempt     → REFUNDED | RETRY_PENDING | FAILED_PERMANENT
```

The provider call is outside the transaction for `1.7`'s reason read in the other
direction: a timeout must not roll back Monacado's record that it owes a buyer
their money. The obligation stands and the unexecuted refund becomes durable
work.

### Idempotency is the whole safety property

Stripe's Refunds API has **no `reference` uniqueness rule** — unlike the Tax API,
which `1.7` could lean on as a second guard. A charge can legitimately be refunded
several times, so nothing at the provider stops a retry returning the money twice.

The only thing that does is the idempotency key, derived from the refund id and
the original charge and therefore **identical on every attempt**. No clock, no
attempt counter, no randomness. A test asserts the key is byte-identical across a
transient failure and its retry.

### Retry policy

Eight attempts over roughly a day (`30s, 2m, 10m, 30m, 2h, 6h, 12h`), a
300-second claim lease, and two terminal states. A worker that dies mid-call
leaves an `IN_PROGRESS` row whose lease expires, so a crash costs an **attempt**
rather than a buyer's money. A live claim is never stolen.

### TEST mode, and one honest limitation

| Check | What it stops |
| --- | --- |
| `config.mode !== "TEST"` | a deployment configured for live mode |
| `resolveTestModeSecretKey` | a live credential in a "test" deployment |

Both go through the *same* single credential reader the rest of the Stripe
surface uses. **There is deliberately no third check**, and this is a real
limitation rather than an oversight: `1.7`'s tax adapter adds a
`transaction.livemode` check — the provider's own statement about its own object —
and **`Stripe.Refund` has no `livemode` field** on the pinned API version.

The credential gate carries the guarantee instead, and carries it completely: an
`sk_test_` key cannot reach live data at Stripe at all. What is lost is only the
belt-and-braces confirmation. What is checked instead is **identity of the
target**: the returned refund must name the payment intent Monacado asked about —
the failure this API can actually surface, and a worse one than a mode confusion.

---

## 5. Tax reversal lifecycle

```
commitTaxReversalObligationInTx  ← inside the REFUND'S OWN transaction
claimDueTaxReversals             → IN_PROGRESS
  … the provider is called outside any transaction …
resolveTaxReversalAttempt        → REVERSED | RETRY_PENDING | FAILED_PERMANENT
   └─ on REVERSED, the SAME transaction moves the original 1.7 report's
      lifecycleState to the REVERSED value that phase RESERVED.
```

### The target is the recorded transaction, never a fresh calculation

`original_transaction` comes from the reversal row's **own copy** of `1.7`'s
`providerTaxTransactionRef`. Copied rather than joined, so the reversal target
cannot silently move if the original row ever changed. Nothing here calculates:
a fresh calculation would price a historical sale at today's rates and reverse a
figure the buyer was never charged.

### Two idempotency guards

`reference` is `<orderId>-reversal` — **derived, not random**, and deliberately
distinct from the original transaction's bare Order id, because Stripe requires
`reference` unique across all transactions **including reversals**. That is the
guard that cannot be lost. The Monacado key protects the common case.

### The original report is never rewritten

Not one sale-time column. `IMMUTABLE_TAX_TRANSACTION_FIELDS` names the boundary
and a test asserts every field is unchanged after a reversal. The **only** thing a
reversal moves on that record is `lifecycleState`, `RECORDED → REVERSED`, and
`REVERSED` is the value `1.7` reserved for exactly this — which is why this phase
needed no schema change to that table.

---

## 6. Ordering and partial-failure recovery

```
1. persist the refund intent           PENDING
2. execute the payment refund          provider #1
3. persist provider refund success  ┐
4. create the tax reversal          ├─ ONE TRANSACTION
5. reverse the settlement + entry   │
6. raise recovery exceptions        ┘
7. execute the tax reversal            provider #2
8. reconcile                           local rows only
```

Steps 3–6 commit together, and that is the opposite trade-off from step 2 for the
opposite reason: once the funds are returned, every consequence must land
together or none can be trusted. A buyer with their money and a settlement row
still saying the sale stands is a window in which a payout can be authorised on a
refunded sale. **No provider call happens inside that transaction.**

### If the payment refund fails

**No tax reversal is created at all** — structurally, because the obligation row
is written only inside the transaction that marks a refund `REFUNDED`.
`verifyReversibleTaxReversal` re-asserts it anyway.

### If the payment refund succeeds and the tax reversal fails

The refund is **not rolled back and not hidden**. The tax reversal stays
retryable, reconciliation reports `PAYMENT_REFUNDED_TAX_NOT_REVERSED`, and a later
cycle closes it — recovering *forward*, never rewriting the original.

### If it is permanently lost

`MANUAL_REMEDIATION_REQUIRED`: money returned, the sale's tax stands reported as
though it had not been, and **no timer will fix it**. The operator action is
`OPERATOR_TAX_ADJUSTMENT_REQUIRED`, never "retry" — the same refusal `1.8` made
for an expired calculation, and for the same reason.

### One cycle runs both halves

Payment refunds first, then tax reversals — including ones committed moments
earlier in the same cycle. An ordinary refund therefore completes in a single
invocation, and a broken one carries into the next.

---

## 6b. Shipping refunds

**Shipping is a separate refundable component**, and `1.9` does none of the three
tempting things: it does not refund all shipping, does not withhold all shipping,
and does not prorate.

Whether it comes back is governed by the **seller refund-policy version bound to
the Order**:

| `shippingRefundability` | Effect |
| --- | --- |
| `ALWAYS_REFUNDED` | shipping is returned with the item |
| `NEVER_REFUNDED` | shipping stays paid — the buyer paid for a carriage that happened |
| `REFUNDED_WHEN_SELLER_AT_FAULT` | returned where the reason attributes fault to the seller |

`SELLER_FAULT_REFUND_REASONS` is `PRODUCT_FAILURE`, `DUPLICATE_PAYMENT`, and
`OPERATOR_CORRECTION`. `CUSTOMER_REQUEST` is not: the buyer changed their mind,
and the carriage still happened. `DUPLICATE_PAYMENT` is, because a buyer charged
twice paid carriage once.

There is deliberately **no `PRORATED` member and no discretionary one** — the
first is an allocation rule nobody has ruled on, and the second makes a disclosed
term unpredictable, which is the one thing a disclosed term must not be.

`shippingIsRefundable` is the **single implementation**, so the amount
derivation, the reconciler, the receipt, and every test reach the same answer.

### The future basket shipping-allocation seam

Where only some lines of a basket come back and shipping is refundable, `1.9`
**fails closed** with `SHIPPING_ALLOCATION_NOT_GOVERNED` rather than prorating.
Which part of one carriage belonged to the returned lines is a commercial ruling
with different winners depending on whether you allocate by value, weight, line
count, or not at all. `SHIPPING_ALLOCATION_SEAM` names the candidate rules and
assigns the ruling to `MONACADO_MOR_BUSINESS_MODEL.md` §I.

Today no Order has more than one line, so the refusal is unreachable in practice
and present in principle — the rule is in the architecture before the basket
exists, rather than being invented by whoever builds it.

---

## 6c. Refund amount semantics

**The invariant that a valid refund must equal the full buyer charge is gone.**

```
  Σ selected line retail
+ Σ tax attributable to those lines        ← sale-time evidence, never recomputed
+ shipping IF the bound seller policy says so
+ other pass-through ONLY where its treatment is authoritative
```

For today's one-line Orders this still lands on the whole Order charge — **or the
whole charge minus non-refundable shipping**, which is the visible proof that the
invariant is gone. A test drives exactly that case.

**The caller names no figure.** It selects lines; every number comes from durable
sale-time facts plus the bound policy. `deriveRefundAmount` returns a *refusal*
rather than a number where the answer is not governed, so a caller cannot receive
a plausible total for an ungoverned case.

Other pass-through has **no governed refund treatment**, so a non-zero one is
refused (`PASS_THROUGH_REFUND_TREATMENT_NOT_GOVERNED`) rather than silently kept.
Quietly retaining a buyer's money because no rule covers it is the worst of the
available answers.

The parts are stored beside the total (`linesRetailMinorUnits`,
`linesTaxMinorUnits`, `refundedShippingMinorUnits`) so a reconciler **checks** the
sum rather than trusting it.

---

## 7. Immutable original economics

Untouched by a refund, and asserted by test:

- `Order` — including `lifecycle: PAID` and `paidAt`. A refund does not pretend
  the sale never happened.
- `TransactionEconomicSnapshot` — byte-identical afterwards.
- `OrderTaxEvidence`.
- `OrderTaxTransaction`'s sale-time facts.

The two columns a refund **does** move elsewhere are both named and bounded:
`TransactionSettlement.state → REVERSED` (`0M.T1`'s mutable half, created for
exactly this) and `OrderTaxTransaction.lifecycleState → REVERSED` (the value `1.7`
reserved).

Net positions are **derived and stored nowhere**: snapshot minus reversal.

---

## 8. Proceeds and promoter commission consequences

**Seller proceeds and promoter commission are treated identically**, and the
symmetry is deliberate rather than incidental. The alternative — silently
absorbing an already-paid promoter commission into Monacado's economics — would
turn a refund into an unrecorded marketplace expense that nobody authorised and
no ledger names.

| Obligation state at refund | What happens |
| --- | --- |
| `PENDING` | becomes payout-ineligible. **No exception row.** |
| `ELIGIBLE` | `ProceedsRecoveryException(ELIGIBLE_BEFORE_REFUND)`. Not demoted. |
| `PAID` | `ProceedsRecoveryException(PAID_BEFORE_REFUND)`. **Not rewritten.** |

### The attributable amount

`amountMinorUnits` is the obligation's whole figure;
`attributableAmountMinorUnits` is the part the **refunded lines** account for.
Equal for a whole-Order refund, which is every refund today — and separate
columns because a subset refund attributes only part of a party's proceeds. A
phase that discovered it needed the distinction later would be tempted to
overwrite the total, which is the historical rewrite this table exists to avoid.

Both come from **sale-time commission evidence** and never from a fresh
commission calculation. Historical payment evidence is never rewritten or
deleted; collection and offset execution remain `T2`'s.

A `PENDING` claim needs no exception because `advanceProceedsObligation` already
refuses `ELIGIBLE` on a reversed sale — `1.2`'s payout hold, now actually
reachable. The `1.2` entry written moments earlier in the same transaction is what
makes that refusal apply.

### Why an exception and not a correction

Both alternatives were refused.

**Rewriting the obligation** would make the ledger say a payout did not happen
that did. `1.2`'s rule stands: *"refusing to record what was actually paid would
make the ledger wrong rather than safe."* A refund does not un-pay anybody.

**Fabricating a negative obligation** would assert a claim *against* a participant
that no phase has designed — there is no negative-balance model, no offset rule,
no notice requirement, no dispute path, and no payout-recovery execution. Writing
it would be writing commercial terms into an accounting table.

So the row states **that** a recovery is owed and leaves *how* to a governed
settlement phase.

### Deferred to T2 settlement

`RECOVERY_EXECUTION_DEFERRAL` names it as data: clawback execution, negative
balances, offset against future proceeds, and payout cancellation are all
`NOT_IMPLEMENTED`. What `1.9` guarantees instead is that pending obligations
cannot become eligible, paid and eligible ones are never rewritten, and every such
obligation raises a durable, visible exception.

---

## 9. Reconciliation

Local records only, **no provider call** — which is what the audit-efficient
refund and reversal records exist for. It reports; it never repairs.

It answers every question `1.9` requires:

| Finding | Healthy? |
| --- | --- |
| `PAID_ORDER_NO_REFUND` | yes — the ordinary case |
| `REFUND_PENDING` | yes — in flight |
| `PAYMENT_REFUNDED_TAX_NOT_REVERSED` | in flight; a problem if it persists |
| `PAYMENT_REFUND_FAILED` | **operator** |
| `TAX_REVERSAL_FAILED` | **operator** |
| `REFUND_AMOUNT_MISMATCH` | **operator** |
| `CURRENCY_MISMATCH` | **operator** |
| `ORIGINAL_TAX_TRANSACTION_MISSING` | **operator** |
| `CONFLICTING_PROVIDER_REFERENCE` | **operator** |
| `REFUND_WITHOUT_ACCOUNTING_REVERSAL` | **operator** |
| `MISSING_ECONOMIC_SNAPSHOT` | **operator** |
| `PROCEEDS_STILL_PAYOUT_ELIGIBLE` | **operator** |
| `SETTLEMENT_NOT_REVERSED` | **operator** |
| `REFUND_POLICY_VERSION_MISSING` | **operator** |
| `REFUND_POLICY_VERSION_MISMATCH` | **operator** |
| `SHIPPING_TREATMENT_CONTRADICTS_POLICY` | **operator** |
| `PROMOTER_COMMISSION_STILL_PAYABLE` | **operator** |
| `PAID_PROMOTER_COMMISSION_LACKS_RECOVERY` | **operator** |
| `LINE_ECONOMICS_DO_NOT_RECONCILE` | **operator** |
| `TAX_REVERSAL_DOES_NOT_MATCH_REFUNDED_LINES` | **operator** |

The shipping check **re-derives** the rule from the bound policy through
`shippingIsRefundable` rather than carrying a second copy, so the reconciler
cannot disagree with the derivation. The amount check compares the refund's own
parts against its total and its lines — **not** against the whole Order charge,
which is no longer the rule.

Healthy states are separated deliberately: collapsing "no refund" into
"inconsistent" would drown the findings that matter in a sea of ordinary sales.

`REFUND_PROVIDER_AUDIT_SEAM` records that a provider-side audit is
`NOT_IMPLEMENTED` and names the two conditions that genuinely need one —
`ALREADY_REFUNDED` and `ALREADY_REVERSED`, both meaning the provider holds an
object Monacado never observed.

---

## 9b. Tax reversal follows the refunded line set

For today's one-line Order the whole Tax Transaction is reversed, because that
line *is* the sale. The reconciler checks `reversedTaxAmountMinorUnits` against
the **lines'** tax rather than the Order's, so the check keeps meaning something
when a subset refund becomes executable.

**No proportional tax allocation is invented.** A subset refund is refused, and
`MULTI_LINE_TAX_EVIDENCE_REQUIREMENT` — recorded in
`SINGLE_LINE_EXECUTION_LIMIT.blockingEvidenceGaps` as
`NO_LINE_LEVEL_PROVIDER_TAX_EVIDENCE` — is the precise gap: Stripe's Tax
Transaction carries line items, but Monacado records no mapping from its own
Order lines to them, and `1.7`'s evidence pins one Product per Order. A basket
phase must record that mapping at sale time; it cannot be reconstructed
afterwards.

No fresh tax calculation is ever used, in any case.

---

## 9c. Refund initiation, including guests

`initiateRefundRequest` verifies **who is asking** and then delegates every
commercial decision to `requestOrderRefund`. A buyer asking politely does not
widen what the bound terms allow — a test drives exactly that.

| Verification | Records |
| --- | --- |
| `GUEST_CLAIM_CODE` | the claim code's digest matches. **No account, `requestedByAccountId: null`** |
| `BUYER_ACCOUNT` | the account is the buyer or the claimant |
| `OPERATOR` | the acting account, for audit |

**A guest never needs an account.** `0M.9` made guest checkout first-class and
fabricated no Account; a refund path requiring one would retro-fit exactly the
account the buyer declined to create and would strand every guest purchase ever
made. The credential is the one the purchase already established — the claim
code, of which only a SHA-256 digest is stored, compared through the same
`hashGuestClaimCode` helper `claimGuestOrder` uses.

**Everything governing the request comes from historical purchase evidence** —
the policy version bound to the Order, and the contact frozen on
`OrderRefundContactEvidence`. A seller changing their support address or
publishing tighter terms cannot invalidate a buyer's purchase-time refund rights
or alter the policy governing their request. A test drives both changes at once
and asserts the guest's refund still binds v1 and still shows the original
contact.

Refusals are **identical** for a wrong code, an unknown Order, and somebody
else's Order. Distinguishing them would make this an oracle for which Order ids
exist. No support portal was built.

---

## 9d. Marketplace policy and legal posture

`MARKETPLACE_REFUND_POSTURE` records the division of authority as data:

- the **seller** owns the declared refund policy;
- **Monacado enforces** the policy that governed the purchase;
- **shipping refundability follows that seller policy**;
- the policy is **disclosed before purchase and included on the receipt**;
- Monacado **retains operational authority** to execute or refuse a refund under
  the bound policy and applicable law — a seller's `refundsAllowed: false` is a
  disclosed seller position, not a ceiling on what Monacado may do;
- **buyer statutory rights, where applicable, are not overridden** by seller
  policy.

**No jurisdiction-specific legal conclusion is asserted.**

### The Marketplace Policy document needs a new version, and this phase did not write it

`MarketplacePolicyVersionRow` is immutable and version 1 is `ACTIVE` and accepted
by participants. Editing its content to describe refund governance would be
exactly the "edited policy under an unchanged version number" that model exists
to prevent — and it would silently change what people already agreed to.

So `REQUIRED_MARKETPLACE_POLICY_NEXT_VERSION` **records the requirement**: which
sections need new text, what they must state, and that the `requiresReacceptance`
decision belongs to whoever owns the marketplace terms. Publishing it is a
governed act through the existing versioning path.

---

## 10. Zero-tax refunds

A full refund of a zero-tax sale follows the **identical** lifecycle, and the
provider **is** called.

`1.7` reports zero-tax sales precisely so they appear as return lines, so such a
sale has a recorded Tax Transaction and gets a reversal like any other.
`requiresTaxReversal` keys on *"was a transaction recorded"*, never on the amount —
the tempting optimisation is wrong in exactly the way `requiresProviderTaxTransaction`
refuses on the way in. A jurisdiction where Monacado collected nothing and then
refunded the sale is still a return line, and a reversal the provider never saw
cannot appear on one.

The `null` tax-reversal case therefore never means "the tax was zero". It means
the provider holds nothing to reverse.

---

## 11. Notifications

| Trigger | Recipient | Purpose |
| --- | --- | --- |
| payment refund `REFUNDED` | buyer | `REFUND_COMPLETED` |
| payment refund `REFUNDED` | seller, promoter | `REFUND_RECORDED` + `REFUND_OR_CHARGEBACK` obligation |
| permanently inconsistent | seller | `OPERATIONAL_ACTION_REQUIRED` obligation, **no email** |

**Notices are never part of financial integrity.** They are enqueued *after* the
refund transaction commits and every failure is swallowed. A refund that succeeded
and whose receipt could not be queued is a refund that succeeded; the reverse
would leave the buyer with neither their money nor a message. A test drives a
refund with a notice subsystem that throws on every write and asserts the money
still went back.

The buyer's notice fires on the **payment refund**, not the whole lifecycle:
whether Monacado has finished reversing tax is none of their business, and waiting
would withhold the fact they want on the strength of one they do not. It names no
reason code — a buyer told their refund was categorised `FRAUD_OR_RISK` has been
accused of something in a receipt.

Delivery uses `1.5`'s `OutboundEmailDelivery` unchanged: durable, retried,
suppression-aware, and re-rendered from authoritative state on every attempt.

---

## 12. Operations

```
npm run refund:process:once                        # one bounded cycle
npm run refund:status                              # backlog + what needs an operator
npm run refund:status -- --all                     # include work merely in flight
npm run refund:status -- --reconcile               # local reconciliation sweep
npm run refund:status -- --requeue-refund=<id>     # governed requeue
npm run refund:status -- --requeue-tax=<id>        # governed requeue
```

Plus `POST|GET /api/internal/operations/refund-processor`, gated by a **dedicated**
`MONACADO_REFUND_PROCESSOR_SECRET` — not the tax recorder's and not the email
dispatcher's. `401` answers unconfigured, absent, wrong-scheme, and wrong
identically, with a body naming nothing. `GET` is accepted because Vercel Cron
invokes with `GET` and cannot be configured otherwise.

**No cron is committed**, on `1.8`'s unchanged reasoning: minute-level Vercel Cron
needs Pro or Enterprise, Hobby caps cron at once per day, and this repository
holds no authoritative statement of which plan production runs on. Once a day is
not a cadence for returning somebody's money. The endpoint ships production-ready;
the operator sets the secret, chooses a scheduler, and declares
`MONACADO_REFUND_PROCESSOR_SCHEDULE`. Monacado cannot see its own deployment's
scheduler, so readiness treats that as an **operator statement**.

**A requeue is never an undo.** It refuses `ALREADY_REFUNDED` (the provider holds
a refund Monacado never saw — reconcile it), `CHARGE_NOT_FOUND`,
`AMOUNT_EXCEEDS_CHARGE`, and `EVIDENCE_INCONSISTENT` by name, and it retains
`lastFailureCode` deliberately.

Backlog output carries **counts and ages and no identifiers**; the per-row view
carries Order, refund, and provider object references and **no buyer field and no
amount** — a refund amount is also a purchase amount.

---

## 13. Private capsule posture

`Refund` and `TaxReversal` are both `PRIVATE` in `CAPSULE_VISIBILITY_POLICY`, and
**this phase publishes nothing** — no Node registration, no Registrar call, no
outbox row, no publication state.

The `Refund` candidate carries the **seller refund-policy reference**
(`policyId`, `policyVersion`), the refunded line refs, and the amount breakdown —
because "which terms governed this refund, and what came back" is the first
question an internal audit or reasoning agent asks. It carries **no policy
prose**: the terms live on one authoritative version row, and a copy in a capsule
would be a second answer able to disagree with what the buyer was shown.

The disclosure argument for `Refund` is sharper than for `1.7`'s
`TaxTransaction` and is stated rather than inherited: a public refund capsule
would publish, per sale, that a purchase was returned and under which reason code.
On a marketplace where a Listing binds one Product and one seller, an aggregate of
those is a published failure rate for that seller; individually, each is a
statement about one buyer's dissatisfaction. Neither party agreed to either.

`TaxReversal` is a **second capsule rather than a field on the first** —
`1.7` left `adjustmentRefs` empty *"so that adding one later changes a value
rather than the shape"*, and folding a reversal into the original capsule would
have been the projection equivalent of rewriting a sale-time fact.

Both projections are deterministic, carry no PII, and mint no Node ID, capsule ID,
or Publisher. The refund capsule projects the requestor **kind** and not the
acting account: an operator's account id names a Monacado employee, and a research
capsule is not where an individual's decision history should accumulate.

---

## 14. Readiness

`evaluateRefundReadiness` is pure configuration inspection — no network, no
database, no credential value read. Probing a refund port would mean refunding
something.

It distinguishes three things that fail differently:

| Question | Fails when |
| --- | --- |
| **implemented?** | never — both adapters exist |
| **configured?** | Stripe or the tax provider is absent or malformed |
| **operationally invocable?** | no dispatcher secret, or no declared scheduler |

`evaluateLiveCommerceReadiness` gains four blockers:
`REFUND_EXECUTION_NOT_CONFIGURED`, `REFUND_PROCESSOR_NOT_OPERATIONAL`,
`TAX_REVERSAL_NOT_CONFIGURED`, and `REFUND_BACKLOG_UNHEALTHY` (rows, not
configuration).

They are **separate from** `1.2`'s `REVERSAL_ACCOUNTING_UNAVAILABLE` on purpose.
That control asks whether the reversal *table* is reachable — the only
refund-shaped question available when no refund could be executed — and a
deployment can pass it while being wholly unable to return anybody's money. An
operator reading "reversal accounting satisfied" must not be able to conclude
otherwise.

> **A marketplace capable of taking live payments but unable to refund them is not
> launch-ready.** Every payment network requires a merchant to be able to refund;
> without it the only remaining correction path is the chargeback — slower, more
> expensive, and adjudicated by somebody else.

`LIVE_PROVIDER_NOT_ENABLED` is still reported by construction. `STRIPE_MODES` has
one member, so no configuration clears it.

This phase claims **no** chargeback or dispute readiness.

---

## 15. Deferred, and named as data

| Deferred | Where it is recorded |
| --- | --- |
| **Sub-line partial refunds** — refused, not merely unimplemented | `PARTIAL_LINE_REFUND_DEFERRAL` |
| **Subset-of-basket refunds** — permitted by policy, not yet executable | `SINGLE_LINE_EXECUTION_LIMIT` |
| **Basket shipping allocation** — failed closed, never prorated | `SHIPPING_ALLOCATION_SEAM` |
| **Line-level provider tax evidence** for subset reversal | `SINGLE_LINE_EXECUTION_LIMIT.blockingEvidenceGaps` |
| **The Marketplace Policy text** stating refund governance | `REQUIRED_MARKETPLACE_POLICY_NEXT_VERSION` |
| **The receipt renderer** | `RECEIPT_SURFACE` |
| **Chargebacks and disputes** — a bank taking funds is a different event with different evidence | `REFUND_READINESS_EXCLUSIONS` |
| **Payout clawback / negative balance / offset** | `RECOVERY_EXECUTION_DEFERRAL` |
| **Provider-side refund audit** | `REFUND_PROVIDER_AUDIT_SEAM` |
| **Tax filing and remittance** — unchanged, still `0M.T2`'s | `TAX_FILING_BOUNDARY` |
| **Live-mode refunds** | `STRIPE_MODES`, one member |
| **Public refund capsules** | `PUBLIC_DISCLOSURE_REQUIREMENTS` |

---

## 16. Remaining live-provider blockers

Unchanged by this phase and still outstanding: live-mode Stripe support (a
reviewed source change to `stripe-runtime-config.ts`), provider-side tax
registrations, filing and remittance ownership, a deployed scheduler for both the
tax recorder and the refund processor, and dispute handling.

`1.9` removes one blocker that was previously unstatable: Monacado can now
**execute** a refund and reverse the corresponding tax, durably and recoverably,
rather than only account for one.

---

## 17. Migration

One additive migration, Two additive migrations, neither modifying a committed one. Every foreign key is
`RESTRICT`.

`20260826024604_add_refunds_and_tax_reversals` — three `CREATE TABLE`s
(`OrderRefund`, `OrderTaxReversal`, `ProceedsRecoveryException`) and their foreign
keys. No `ALTER` on any existing table.

`20260826043324_add_seller_refund_policy_and_refund_lines` — the correction, with
the historical-receipt fix folded into it rather than added as a third migration.
Four `CREATE TABLE`s (`SellerRefundPolicy`, `SellerRefundPolicyVersionRow`,
`OrderRefundLine`, `OrderRefundContactEvidence`), two **nullable** columns on
`Order` (historical compatibility preserved — pre-binding Orders stay valid and
are never backfilled), and required columns on `OrderRefund` and
`ProceedsRecoveryException`, both of which ship in this same uncommitted phase
and are empty.

---

## 18. Tests

`test/refunds-and-tax-reversals.test.ts` (100) and
`test/refunds-and-tax-reversals.integration.test.ts` (58).

**No network, no Stripe account, no credential, no live money, and no AgentNet
publication.** Every provider port is an injected double, and the tax-reversal
port used in payment-failure tests **throws if called**, so "a failed refund never
produces a tax reversal" is enforced rather than merely observed.
