# Pre-Live Commerce Controls — Phase `1.2`

**Status:** implemented. The controls that must exist **before** live money can
ever be enabled — not the enabling of it.

`1.0` made a purchase executable and `1.1` made its outcome communicable. Both
ran on assumptions that are fine in test mode and indefensible with real money:
tax was a hard-coded zero, nothing gated a transaction, and a completed sale had
no way to be undone.

```
checkout:  price → RISK GATE → TAX ENGINE → Order → tax evidence → payment
post-sale: snapshot (immutable)  +  reversal (new evidence)  → net = 0
payout:    ELIGIBLE refused while a restriction or a reversal holds the claim
```

**Stripe remains test-mode only.** `STRIPE_MODES` still has one member and
`resolveStripeApiKey` still refuses any key not prefixed `sk_test_`. Nothing here
enables live commerce; §5 only reports whether enabling it would be defensible.

---

## 1. Tax execution boundary

### The zero is gone

`beginCheckout` now obtains an authoritative `TaxQuote` **before** it places an
Order, and there is no path around it: `taxPort` is a required argument, so a
caller cannot omit it and a build cannot compile without one.

### Disabled means refused, never zero

The single most important behaviour in the phase. With no engine configured,
`resolveTaxPort` returns an adapter that **throws**.

A zero returned because tax is unconfigured is indistinguishable from a zero that
is genuinely correct, and the difference is an uncollected liability nobody can
find later. So checkout refuses to sell rather than quietly selling untaxed — an
integration test asserts that a failed calculation leaves **no Order and no
payment attempt**.

### The result, and what is checked about it

| Field | Purpose |
| --- | --- |
| `taxAmountMinorUnits` | what the buyer is charged |
| `currency` | checked equal to the Order's |
| `providerCalculationRef` | the engine's own reference, so an auditor reaches its reasoning without Monacado storing it |
| `basisAmountMinorUnits` | what the tax was assessed **on** — retail + shipping |
| `treatment` | `TAXABLE` / `EXEMPT` / `OUT_OF_SCOPE` |
| `jurisdictionCode` | a bounded **code** (`US-CA`), never an address |
| `calculatedAt` | injected, never a clock read |

`guardTaxPort` wraps **every** adapter and refuses an answer that contradicts
itself: a not-taxable treatment carrying a non-zero amount, tax exceeding its own
basis, a currency mismatch, or a basis the engine invented. A future vendor
adapter cannot forget to apply these, because the wrapper is where they live.

`OUT_OF_SCOPE` rather than `TAXABLE` at zero is deliberate: the zero-rate adapter
is not claiming a rate of zero applies, it is recording that no regime was
consulted. An auditor reading `OUT_OF_SCOPE` learns something true.

### Tax is not commercial revenue

Unchanged, and now load-bearing rather than theoretical.
`reconcileTransactionEconomics` has no term for tax, and a test greps the identity
to prove it. A $100.00 sale with $10.00 tax charges the buyer $110.00 and computes
Monacado's retention on **$100.00** — an integration test asserts the snapshot's
`monacadoRetainedAmountMinorUnits` is $8.50, not $9.35.

### The jurisdiction is authoritative, and comes from the buyer

> **Superseded by Phase 1.6.** `1.2` sourced tax to the **billing** address and
> recorded that a shipping address might later participate "if a real engine
> requires it". The settled rule is different: standard retail checkout collects
> **billing and ship-to on every purchase**, and **tax is always sourced to
> ship-to** — digital, physical, and mixed alike. `taxJurisdictionCodeFor` now
> takes the ship-to address, and there is no runtime choice of tax source. See
> [`PRODUCTION_TAX_INTEGRATION.md`](PRODUCTION_TAX_INTEGRATION.md) §4.

`TaxQuote` is computed from an address the buyer supplied at checkout, derived in
one place and **never from an IP address** — an IP locates a network interface,
not a buyer.

The evidence row names the exact `buyerSnapshotId` whose address produced it, so
three questions stay answerable years later: *what address was used*, *which
calculation reference produced the amount*, and *when it was calculated*.

### No vendor selected

`TAX_PROVIDERS` names two **test** adapters. The repository configures none, and
choosing one here would be choosing a third party, a data-processing
relationship, and a filing posture on Monacado's behalf inside a phase about
drawing a boundary. Adding a real engine is one new file implementing
`TaxCalculationPort` and no change to any caller.

**Filing and remittance are not implemented** and have no columns —
`NEVER_ON_TAX_EVIDENCE` names them.

---

## 2. Tax evidence

`OrderTaxEvidence`, one row per Order, enforced by a unique index.

The Order already stores the *amount* charged. This stores the **why**: engine,
calculation reference, basis, treatment, jurisdiction, instant. The amount is
repeated deliberately and **checked, not copied** —
`requireTaxQuoteMatchesOrder` refuses when the quote's tax, currency, or basis
disagrees with the Order's, the same shape of check as `0M.9`'s
`requireQuoteMatchesSnapshot`. If the Listing were repriced between pricing and
placement, Monacado would be explaining a charge it did not make.

The address itself lives on `OrderBuyerSnapshot` and is referenced here by
`buyerSnapshotId` rather than copied — two stored answers to "where was this
sourced" could disagree, and only one of them could be right.

---

## 3. Refund / reversal accounting

### New evidence, never a correction

`0M.T1` built `TransactionEconomicSnapshot` with **no update path at all** and
said a reversal "will be recorded as its own entry rather than by editing this
one". This is that entry, and no schema was rewritten:

```
snapshot    — what the sale earned each party.   NEVER EDITED.
reversal    — what was subsequently given back.  ALSO NEVER EDITED.
net         — the difference. DERIVED, stored nowhere.
```

An integration test reads the snapshot before and after a reversal and asserts
the two rows are **equal**.

What *does* move is the settlement row — `0M.T1`'s mutable half — to the
`REVERSED` state that phase created in anticipation of exactly this.

### No amount is a parameter

`deriveFullReversalAmounts` computes every returned figure from the snapshot, so
a caller cannot return more than the sale earned, cannot return less and call it
full, and cannot invent a promoter share on a seller-direct sale.
`reconcileFullReversal` then checks the same identity the forward path checks,
read backwards — **tax and shipping appear in neither**, because they return to
the buyer in full and were never part of what three parties divided.

Amounts are stored as **positive magnitudes**. A signed column invites a reader to
add it to the snapshot and call the result truth, and the first sign error
silently doubles somebody's money. The `kind` carries direction; the amounts carry
size.

### Full only, and said so

`REVERSAL_SCOPES` has one member. **Partial refunds are explicitly deferred** —
not for convenience, but because a partial forces a decision about *whose* money
comes back first (Monacado's retention, the seller's proceeds, or the promoter's
spread) and every allocation rule is a commercial policy decision with different
winners. `MONACADO_MOR_BUSINESS_MODEL.md` §I owns that ruling.

A full reversal needs no allocation rule: everyone gives back exactly what they
received, which is checkable arithmetic.

### Obligations reconcile rather than mutate

`ProceedsObligation` is forward-only with no reversed state, and adding one would
change a committed enum for a fact already recorded elsewhere. So obligations are
untouched and `reconcileProceedsAfterReversal` derives the net:

```
net owed to a party = obligation.amount − reversal's amount for that party
```

which for a full reversal is **zero** — asserted for every party by an
integration test.

### A repeat is refused, not idempotent

Unique on `snapshotId`. The asymmetry with `0M.9`'s payment replay is intentional:
a repeated payment confirmation is a provider redelivering one fact, whereas a
second reversal of one sale is either a duplicate credit or a partial arriving
under the wrong name. Both deserve surfacing.

### No live refund executed

`RefundExecutionPort` is declared and **has no adapter**. Executing a Stripe
refund is a live-money operation, and this phase is about the controls that must
exist before any live money moves.

---

## 4. Risk gate

A narrow synchronous allow/deny taken **before an Order is written**, so a denied
transaction leaves nothing behind — no Order, no tax evidence, no payment, and no
denial log, because a denial log is a manual-review workflow's foundation and this
phase builds none.

### Four controls, each earning its place

| Control | Failure it prevents |
| --- | --- |
| max single-order **commercial** amount | one mispriced Listing taking an unrecoverable sum |
| active participant restriction | a restricted party continuing to transact |
| seller commerce approval | selling by a participant nobody cleared |
| payment-account readiness | booking proceeds nobody can ever be paid |

The ceiling is on the **commercial retail** amount, not the buyer total: tax and
shipping are pass-through amounts Monacado neither earns nor sets, and letting
them push an Order over a commercial limit would deny a sale for somebody else's
rate.

**The restriction check is not redundant** with listing eligibility. Any
restriction sets a participant `RESTRICTED`, which `0M.7`'s eligibility read
already catches — but only for the Listing's **controller**. On a promoted sale
the party owed seller proceeds is the *Offer's* seller, whose status that read
never looks at. A test asserts the gate answers about that party independently.

### Thresholds are versioned

`RiskPolicy` / `RiskPolicyVersionRow` mirror `0M.R1`'s commercial policy exactly:
immutable versions, at most one `ACTIVE` enforced by an `activeMarker` unique
index, retired versions still readable. Every decision names the exact
`(policyId, policyVersion)` that produced it — on an **`ALLOW`** as well as a
`DENY`, so a permitted transaction is as explicable after the fact as a refused
one. A test greps the service for a literal threshold and asserts none.

### Fails closed

No `ACTIVE` version is `RISK_POLICY_NOT_CONFIGURED` — a denial, never a default
limit, on the same reasoning that made an absent commerce approval mean
`NOT_APPROVED`. A currency mismatch denies rather than comparing dollars to yen.
An unreadable gate throws, and the caller must refuse.

Every applicable reason is reported, not the first.

### What was not built

**No fraud scoring, no ML, no velocity engine, no reserve system, no chargeback
prediction, and no manual-review workflow.** `NEVER_ON_RISK_POLICY` names each and
a test proves each is refused. Every one needs data Monacado does not have and an
operational function that does not exist, and a score with nobody to review its
output is a number that blocks buyers for reasons no one can explain.

---

## 5. Payout hold

**No payout is executed and none is implemented.** What this adds is the ability
to stop a claim becoming *eligible* for one.

`advanceProceedsObligation` now refuses the `ELIGIBLE` transition when either
holds:

- an **active `payout:receive` restriction** on the participant — `0M.R1`'s own
  record, reused rather than duplicated. It already means exactly "this
  participant may not be paid", and a second flag would be a second answer that
  can disagree with it.
- a **reversed sale** — the money went back, so there is nothing left to become
  eligible. Paying out on a reversed sale is paying twice.

`ProceedsPayoutHeldError` is distinct from an invalid-transition error, and the
distinction is operational: one means the claim is in the wrong *state*, the other
that it is in the right state and something is **holding** it. One is a caller
bug; the other is a governed decision an operator can lift.

Nothing blocks `PAID`. A claim already settled is history, and refusing to record
what was actually paid would make the ledger wrong rather than safe.

---

## 6. Live-commerce readiness

One function answering one question: **may Monacado enable live commerce?**

**A readiness decision, not a deployment switch.** Nothing here turns anything on;
a test greps the module for every write method and asserts none. A readiness
function that could also flip a flag would eventually be called by something that
wanted the flag flipped.

| Blocker | Cleared by |
| --- | --- |
| `TAX_CALCULATION_NOT_CONFIGURED` | configuring an engine |
| `TAX_CALCULATION_NOT_OPERATIONAL` | an engine that actually answers — it is **exercised**, not trusted |
| `RISK_POLICY_NOT_CONFIGURED` | naming a policy |
| `RISK_POLICY_NOT_ACTIVE` | activating a version |
| `NOTIFICATION_DELIVERY_NOT_CONFIGURED` | enabling `1.1`'s channel |
| `REVERSAL_ACCOUNTING_UNAVAILABLE` | reachable reversal storage |
| `LIVE_PROVIDER_NOT_ENABLED` | **a reviewed phase. No configuration clears it.** |

That last row is not a placeholder — it is the accurate answer. `STRIPE_MODES` has
one member, so no environment can satisfy it. An integration test configures every
other control and asserts readiness is **still** `false` with exactly that one
blocker remaining.

Every blocker is reported, and an unreadable check counts as a blocker rather than
as satisfied: a check that cannot run has not passed.

---

## 6a. Buyer information, and the privacy reversal

**Account login stays optional. Completing a checkout is not anonymous.**

A completed purchase requires information sufficient for payment authorization,
tax jurisdiction and sourcing, fraud and compliance evaluation, transactional
communication and support, and fulfillment where applicable. `OrderBuyerSnapshot`
holds it: name, email, a **structured** billing address, a **structured ship-to
address**, and the tax jurisdiction derived from ship-to. (Phase 1.6 made ship-to
required on every Order and moved the jurisdiction onto it; `1.2` had it optional
and derived from billing.)

Structured rather than a blob because the two things an address is actually for —
deriving a jurisdiction and handing a carrier something deliverable — both need
the parts named, and parsing them back out of a blob is a guess dressed as a
field.

### Billing and ship-to are both required (Phase 1.6)

> **Superseded by Phase 1.6.** `1.2` required a shipping address only when the
> basket needed delivering, and stored none for an all-digital purchase even if
> one was volunteered. The settled policy requires **both addresses on every
> purchase**.

| | |
| --- | --- |
| **Billing address** | **always required** — payment and transaction record |
| **Ship-to address** | **always required** — destination, and the tax jurisdiction |

Both rules apply identically to guest and authenticated buyers.

**`shipToSameAsBilling` keeps it frictionless.** A buyer shipping to the address
they pay from ticks one box; billing is **copied** into the ship-to fields, and
nobody types the same address twice. The stored snapshot holds a populated ship-to
either way — never a null meaning "look at billing instead".

**A ship-to address does not imply physical fulfillment.** For a digital purchase
it is a destination for *tax* purposes only: no parcel, no carrier, no shipping
address collected on the provider's hosted page, and the digital-delivery
entitlement policy below is unchanged.

What still depends on delivery mode is **whether anything physically ships**:

```
all lines DIGITAL   → nothing ships; the hosted page collects no delivery address
any line PHYSICAL   → the basket ships; the hosted page collects one
any line UNKNOWN    → checkout refuses. Absence is never a default.
```

A **mixed basket** ships, and shares the one transaction ship-to for tax sourcing.

The decision comes from `evaluateBasketFulfillment`, reading the **explicit
`deliveryMode` fact** off each Product's authoritative source version. It is never
inferred from a name, a category, `specifications`, or `capabilities`: those are
free-form and creator-supplied, and reading a checkout rule out of one would make
fulfillment depend on how somebody phrased a spec key.

### Delivery mode is an authoritative Product fact

`deliveryMode` (`DIGITAL` | `PHYSICAL`) is a member of `ProductData`, so it
follows the Product source-version model like every other Product fact —
persisted as `factDeliveryMode` on `ProductSourceRecordVersionRow` and read from
the version the stable record currently points at.

It is **optional for backward compatibility only**: source versions written before
the fact existed have none, and making it required would invalidate them
retroactively. **Absence is not a default** — checkout fails closed, because
guessing `DIGITAL` ships nothing to a buyer expecting a parcel and guessing
`PHYSICAL` demands an address nobody needs.

### A guest is still a guest

A guest Order carries a full snapshot with **no `Account`, no
`MarketplaceParticipant`, and no published Node or capsule**. A test counts both
tables across a guest purchase and asserts neither moved. The snapshot is not an
identity and is not reusable: buying twice as a guest produces two snapshots,
because each records who bought *that* order.

### The provider's version wins

| Stage | Source | Trust |
| --- | --- | --- |
| checkout | `BUYER_SUPPLIED` | enough to price tax on — tax must be computed before a charge, and nothing better exists then |
| after payment | `PROVIDER_CONFIRMED` | **the identity the payment actually authorized** |

Stripe always collects billing (`billing_address_collection: "required"`) and
collects a shipping address **only when the basket physically ships** — Monacado
decides from explicit Product delivery modes and tells the provider, so a
download is never asked for one on the hosted page. (Monacado's own ship-to
address is collected in its checkout form regardless, as the tax destination —
these are different questions.) The shipping allow-list is deployment configuration
defaulting to a deliberately narrow starter set: Stripe has no "anywhere" value,
and a list widened to whatever a client typed would be no list.

The confirmed result is read back **inward**. Supersession is
one-directional: `BUYER_SUPPLIED` → `PROVIDER_CONFIRMED` replaces, and a
`PROVIDER_CONFIRMED` snapshot is **never** overwritten by later caller-supplied
data. A test attempts exactly that override and asserts it fails.

Buyer data travels inward only — Monacado sends Stripe no customer object, no
`customer_email`, and no address. **Card data crosses in neither direction.**

### What the reversal did *not* touch

`NEVER_ON_BUYER_SNAPSHOT` still forbids, and a test proves no column exists for:
PAN, CVV, expiry, any payment-method payload, bank or IBAN details, processor
secrets, identity-document images or numbers, KYC dossiers, and arbitrary
fraud-provider blobs.

`NEVER_ON_ORDER` still holds **literally**: the `Order` row has no `buyerEmail`,
`buyerName`, or `buyerAddress` column and gains none. The snapshot is a separate
table joined one-to-one, which is what keeps the commercial record and the
personal record separable — one can be retained, exported, or erased on a
different schedule from the other.

Snapshot data is **private transactional data and never capsule or public data**
(ADR §11.10). No projection reads it.

### Notification, simplified

`1.1` recorded that a guest's address was irrecoverable once the transient
confirmation was gone. **That is no longer true.** Transactional notices now read
the Order snapshot first, falling back to the transient contact only before a
snapshot exists. No retry machinery was added; the gap simply narrowed.

---

## 6b. Digital delivery — policy declared, system deferred

A completed **digital** purchase creates a durable right to the product. This
phase declares what that right *is*; it builds none of the machinery.

### Entitlement versus token

```
ENTITLEMENT  — the durable RIGHT to access what was bought.
               Created by a completed purchase. Survives everything below.
TOKEN        — a temporary CREDENTIAL for exercising it once.
               Short-lived, opaque, revocable, replaceable, disposable.
```

**A token is never the entitlement.** Conflating them fails in both directions: a
lost token would mean a lost purchase, and a leaked token would mean a
transferable one. Keeping them apart is what lets a buyer re-download freely
without Monacado ever re-deciding whether they bought the thing.

### The allowance

**Five successful downloads per digital product**, self-service. It is an
allowance, not a limit on the right — the entitlement does not expire when it
does; what expires is getting further credentials *without anyone being asked*.

**Only successful downloads count.** A connection that dropped at 90% is not a
delivery, and charging a buyer's allowance for their own bad wifi is the most
common way this kind of policy turns hostile.

### Re-download

| | |
| --- | --- |
| within allowance | **self-service**; a **fresh** token each time |
| the original token | **never** recovered, reused, or extended |
| beyond allowance | **routed to the seller**, not refused |
| exceptional support | the **seller** owns it |
| infrastructure and routing | **Monacado** owns it |

A previous token cannot be handed back, because doing so would mean it had been
stored in a form that could be — precisely what the token rules forbid. The
seller owns exceptions because they are the only party who can judge whether a
tenth download is a re-install or redistribution.

### Tokens

High-entropy, opaque, short-lived, scoped to one entitlement and one artifact,
usage-limited, revocable, replaceable, and **never persisted in plaintext** —
only a digest, the same construction `0M.9` uses for a guest claim code and `1.1`
for a delivery destination. Each property exists because its absence is a
specific failure, enumerated in `DELIVERY_TOKEN_PROPERTIES`.

A test asserts **no token or download-URL column exists anywhere** in the schema
today — recorded before the pressure to store one "just for debugging" arrives
with the first support request.

### Hosting

`MONACADO_HOSTED` and `EXTERNAL_HOSTED` are both first-class. The difference is
**where the file is**, never who decides who may have it.

**An externally hosted product may not rely on a permanent reusable secret URL.**
Such a link is a bearer credential with no expiry, scope, revocation, or record
of use; once shared it is indistinguishable from publishing the file, and the
seller cannot withdraw it without breaking every legitimate buyer. External
delivery must use **Monacado entitlement verification** or a **Monacado-issued
short-lived credential**, so the same rules apply wherever the bytes sit. The
verification endpoint is **not built here**.

### Guests

The entitlement is anchored to the **purchase**, not an identity: `0M.9`'s
`PurchaseEvidence` names the Order, Product, and seller, and `1.2`'s buyer
snapshot holds the verified checkout email. Recovery uses the order reference plus
that email.

**No `Account` and no `MarketplaceParticipant` is created for delivery** — the
same promise `0M.9` made about buying and `1.1` about being notified. If the buyer
later claims the purchase into an account, **the entitlement does not change**:
the right was created by the purchase, not by who logs in to look at it.

### Reserved architecture, and why no persistence was added

A delivery phase will add `DigitalDeliveryEntitlement`, `DigitalDeliveryArtifact`,
`DigitalDeliveryGrant`, and `DigitalDeliveryToken`. **None is created here, and
none is needed yet.**

A completed sale already records everything an entitlement must anchor to:
`PurchaseEvidence` names the Order, the Product, and the seller; the Product's
source version names its `deliveryMode`; the buyer snapshot names the verified
email. So entitlements can be issued later **without rewriting Order or Product
semantics** — which is the only thing this correction had to protect, and it
turned out to already hold.

What is deferred is listed in `DEFERRED_DELIVERY_IMPLEMENTATION`, so "digital
delivery is done" is never mistakable for true.

---

## 7. What still remains before real-money launch

**Blocking, and named honestly.**

1. ~~**A real tax engine.**~~ **Delivered in Phase 1.6** — Stripe Tax behind the
   unchanged port, sourced to the Order's ship-to address.
2. **Nexus determination, exemption certificates, filing and remittance.**
   `0M.T2`'s operational half; product tax classification and sourcing were
   delivered in `1.6`. This phase records what an engine says; it files nothing.
   Ordinary retail checkout deliberately accepts **no buyer exemption
   credentials** — see [`PRODUCTION_TAX_INTEGRATION.md`](PRODUCTION_TAX_INTEGRATION.md) §15.
3. **Partial refunds**, and the allocation ruling they require (§3).
4. **Live refund execution.** `RefundExecutionPort` has no adapter.
5. **Payout execution.** Obligations record what is owed and can now be held;
   nothing moves money.
6. **Live-mode Stripe support**, which does not exist — plus webhook registration,
   secret rotation, and HTTPS return URLs.
7. **Chargeback ingestion.** A `CHARGEBACK` reversal can be recorded by hand; no
   Stripe dispute webhook feeds it.
8. **`1.1`'s recorded gate**: delivery is at-most-once with no retry, and a failed
   **guest** receipt cannot be re-sent because only a digest of the address is
   kept.

**Not blocking, but true.** The risk gate's controls are the four a launch can
justify; velocity limits and reserves become necessary at volume this system has
not seen, and building them before there is anyone to review their output would
produce refusals nobody can explain.

---

## Reference

- [`MOR_TRANSACTION_ACCOUNTING_FOUNDATION.md`](MOR_TRANSACTION_ACCOUNTING_FOUNDATION.md) — `0M.T1`, the immutable snapshot this reverses beside
- [`VERSIONED_COMMERCIAL_POLICY_AND_ACTIVATION_RISK.md`](VERSIONED_COMMERCIAL_POLICY_AND_ACTIVATION_RISK.md) — `0M.R1`, the versioning and restriction records reused here
- [`BUYER_CHECKOUT_ORDER_AND_POST_SALE_FOUNDATION.md`](BUYER_CHECKOUT_ORDER_AND_POST_SALE_FOUNDATION.md) — `0M.9`, the Order and proceeds obligations
- [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md) — §G/§H tax and shipping, §I reversals
- [`EXECUTABLE_CHECKOUT_AND_STRIPE_TEST_MODE.md`](EXECUTABLE_CHECKOUT_AND_STRIPE_TEST_MODE.md) — `1.0`
- [`ORDER_EXPIRY_AND_BUYER_NOTIFICATION_DELIVERY.md`](ORDER_EXPIRY_AND_BUYER_NOTIFICATION_DELIVERY.md) — `1.1`
- [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md)
- [`.env.example`](../.env.example)
