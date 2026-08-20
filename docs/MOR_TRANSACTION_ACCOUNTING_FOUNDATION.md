# MoR Transaction Accounting Foundation — Phase `0M.T1`

**Status:** implemented. The first half of `0M.T`, and the last cross-cutting
foundation `0M.9` requires.

The immutable **per-sale economic snapshot** and the settlement structure a
future payment provider's evidence attaches to. Nothing here charges anyone,
creates an Order, calculates a tax, or moves a payout.

---

## 1. Purpose

`0M.9` writes Monacado's first real Order and payment transaction. Merchant-of-
Record status means Monacado is the buyer's commercial counterparty, so the
moment a sale exists Monacado owes an exact account of it: what the buyer paid,
what Monacado retained, what the seller is owed, what the promoter earned, and
under which commercial terms all of that was determined.

> **Monacado must not create a transactional payment record it cannot account
> for.** That is the whole reason `0M.T1` precedes `0M.9`.

`0M.T1` supplies the record. It deliberately supplies nothing else: no checkout,
no payment execution, no tax calculation or remittance, no payouts, no refunds,
no chargebacks, and no processor reconciliation workflow.

---

## 2. The immutable economic snapshot

`TransactionEconomicSnapshot` is one sale's economics, written once and **never
updated**. There is no service operation that edits it, and the table has no
`updatedAt` column, because nothing updates it.

It records, in integer minor units with no floating-point money anywhere:

| Fact | Both types | Promoted only |
| --- | --- | --- |
| Commercial retail amount | ● | |
| Currency | ● | |
| Monacado retained amount | ● | |
| MoR wholesale acquisition amount | ● | |
| Seller proceeds | ● | |
| Offer wholesale price | | ● |
| Seller-funded commission | | ● |
| Promoter retail spread | | ● |
| Promoter net proceeds | | ● |
| Tax amount | ● | |
| Shipping amount | ● | |
| Other pass-through amount | ● | |
| `occurredAt`, `recordedAt` | ● | |

**The commercial retail amount is the *effective* price at `occurredAt`.** A
seller-direct sale inside a scheduled sale window records the sale price; outside
it, the ordinary price. Nothing is stored for "is a sale running" — that stays
derived from the persisted schedule plus the supplied instant, exactly as `0M.7`
established.

### Seller-direct versus promoted

A discriminated union, not a flag over shared columns. **A seller-direct snapshot
has no field for an Offer binding, a wholesale price, a commission, a spread, or
promoter proceeds.** Not "they are zero" — nowhere to go. A zero in those columns
would describe a promoter who earned nothing rather than one who does not exist.

In storage the promoted columns are `NULL` on the seller-direct arm, and the
mapper rebuilds the union **from the discriminator**, so a stray value stranded in
a promoted column can never become promoter proceeds on a sale that had no
promoter.

### What the buyer paid in total is derived, never stored

```
buyerChargedTotal = commercialRetail + tax + shipping + otherPassThrough
```

A stored total is a second answer that can disagree with the four amounts it
sums, and the four are the authoritative ones.

---

## 3. Exact source and policy binding

Three composite foreign keys, onto the unique keys `0M.6`, `0M.7`, and `0M.R1`
already established:

```
(listingSourceRecordId, listingSourceRecordVersion) -> ListingSourceRecordVersionRow
(offerSourceRecordId,   offerSourceRecordVersion)   -> OfferSourceRecordVersionRow
(policyId,              policyVersion)              -> CommercialPolicyVersionRow
```

Consequently:

- a snapshot **cannot** name a version that does not exist — the database refuses
  the row;
- none of the three **can be deleted** beneath it — every rule is `RESTRICT`;
- every binding names a **version label**, never a current-version pointer. No
  code path in this phase reads `currentSourceRecordVersion`, and the policy
  lookup is `getCommercialPolicyVersion` — `0M.R1`'s *exact-version* read —
  deliberately not `getEffectiveCommercialPolicyVersion`.

**Historical economics therefore do not move.** A seller reprices the Listing, a
seller renegotiates the Offer, Monacado replaces the commercial policy: the
recorded sale reproduces exactly as it was, and a retired policy version stays
bindable precisely so that it can. All three are asserted by integration tests.

### Everything is read, nothing is asserted

The retail price, the transaction type, the Offer binding, the wholesale price,
and the seller-funded commission are **all read from persisted versions**. There
is no `commercialRetailAmountMinorUnits` parameter and no way to supply one — a
caller-provided number could disagree with the terms actually offered and
accepted, which is the divergence the exact binding exists to prevent.

---

## 4. The accounting identity

Checked before any write, and refused rather than recorded when it fails.

**Promoted:**

```
sellerProceeds + promoterNetProceeds + monacadoRetained = commercialRetailAmount
```

**Seller-direct:**

```
sellerProceeds +                       monacadoRetained = commercialRetailAmount
```

**Both**, additionally — the MoR layer's own identity, which is what makes
"Monacado's retention is taken exactly once, inside the acquisition amount" a
checked fact rather than a described one:

```
morWholesaleAcquisition + monacadoRetained = commercialRetailAmount
```

The promoted components are checked individually **before** the sum, because the
promoter's two parts answer to different parties and move independently
(`MONACADO_MOR_BUSINESS_MODEL.md` §D):

```
promoterRetailSpread = morWholesaleAcquisition − offerWholesalePrice
promoterNetProceeds  = promoterRetailSpread    + sellerFundedCommission
sellerProceeds       = offerWholesalePrice     − sellerFundedCommission
```

Given those, the three-party sum telescopes to retail, so the final identity
check is **defence in depth rather than an independent condition** — stated
plainly here because a test that claimed to cover an unreachable branch would be
worse than none. A contract test asserts the implication holds across the range
instead.

### No second implementation of the economics

`calculateSellerDirectEconomics` and `calculatePromotedListingEconomics` are
`0M.4A`'s, consumed unchanged, and `toWholesaleAcquisitionPolicy` is `0M.R1`'s
bridge from storage onto the committed policy contract. There is still exactly
one implementation of the MoR, commission, and promoter-spread arithmetic in this
repository, and this phase did not add a second.

What is *stored* is the result — exactly as `0M.2A` stores an Offer's accepted
economics, and for the same reason: the numbers the parties transacted on must be
reproducible rather than recalculated under whatever policy is current later.
`reconstructTransactionEconomics` re-derives from the bound sources and refuses
on drift rather than repairing it.

---

## 5. Tax and shipping boundary

Tax, shipping, and other permitted pass-through amounts are **recorded** so a
future checkout can state what the buyer was charged, and they are **outside
every commercial basis** (`MONACADO_MOR_BUSINESS_MODEL.md` §G/§H):

- outside Monacado's retained amount;
- outside the wholesale acquisition amount;
- outside the seller-funded commission;
- outside the promoter's margin.

The exclusion is **structural, not remembered**: `CommercialRetailBasis` is a
`strictObject` over the merchandise price alone and has no field for any of them,
so no pass-through amount can enter a calculator. A test charges $21.74 of tax,
shipping, and pass-through against a $100.00 sale and asserts every commercial
figure is byte-identical to the untaxed one.

**`0M.T1` calculates no tax.** There is no column, and no input field, for a tax
rate, a jurisdiction, a nexus finding, a taxability class, a registration, an
exemption certificate, a remittance instant, or a filing. `0M.T2` owns tax
execution.

`otherPassThroughAmount` is one amount rather than a line-item table. Itemising a
buyer's charges is checkout's subject; this phase records the accounting total.

---

## 6. Settlement state

`TransactionSettlement` is **the mutable half, in its own table**, one row per
snapshot keyed by the snapshot's identity. The split is the enforcement: every
legitimate update targets this table, so recording provider evidence can never
rewrite what the parties earned.

Four states, provider-neutral, and no more:

| State | Meaning |
| --- | --- |
| `PENDING` | Economics recorded; no funds evidence yet. |
| `FUNDS_RECEIVED` | The provider reports the buyer's funds were captured. |
| `SETTLED` | The transaction is closed out for accounting purposes. |
| `REVERSED` | The funds movement was undone or never completed. |

```
PENDING ──> FUNDS_RECEIVED ──> SETTLED
   │              │               │
   └──────────────┴───────────────┴──> REVERSED   (terminal)
```

Forward-only along the funds path. `REVERSED` is reachable from every
non-terminal state, because a provider may undo a capture before or after
Monacado closes the transaction out. Nothing returns.

> **`REVERSED` is a state, not a workflow.** It records that the money went back
> and nothing else: there is no reversal amount, no partial reversal, no recovery
> from seller or promoter economics, no representment evidence, and no
> refund-versus-chargeback distinction. That accounting is `0M.T2`
> (`MONACADO_MOR_BUSINESS_MODEL.md` §I), and it will be recorded as its own entry
> rather than by editing a completed sale. The state exists **now** precisely so
> that provider reversal evidence arriving does not require rewriting a financial
> row's schema.

---

## 7. The provider transaction reference

An **opaque external string** on the settlement row, nullable until provider
evidence exists, recorded together with the provider it belongs to — a reference
without its counterparty is unreconcilable, and reconciling one against the wrong
provider is the mistake naming it prevents (`0M.8`'s reasoning, unchanged).

- **Not a Node, not a capsule identity, not public identity, never published.**
- **Never a credential.** The contract refuses `mon:` forms and the recognisable
  provider-secret prefixes, the same backstop `ProviderAccountRef` applies. The
  guarantee is that no column for a credential exists at all.
- **Write-once.** A recorded reference is the evidence of *which* external
  transaction a snapshot is; replacing it would silently re-point a financial
  record at a different one.
- **Unique per `(provider, reference)`**, so one provider charge cannot be
  recorded against two sales. Enforced by an index, not by a read-then-write.

**No provider SDK, credential, endpoint, or API call exists in this phase.** The
service records evidence a caller already holds.

---

## 8. Service operations

Five, and no more:

| Operation | What it does |
| --- | --- |
| `recordTransactionEconomicSnapshot` | Computes one sale's economics from the bound Listing version, Offer version, and policy version; validates the identity; writes the snapshot and its `PENDING` settlement row in one transaction. |
| `getTransactionEconomicSnapshot` | Reads a snapshot with its settlement standing. |
| `reconstructTransactionEconomics` | Re-derives from the bound sources and refuses on drift. |
| `recordProviderTransactionReference` | Attaches the provider's opaque reference. Write-once, settlement row only. |
| `advanceTransactionSettlement` | Moves settlement state and stamps that state's instant. Settlement row only. |

**No Order creation. No checkout route. No payment initiation. No payout.** A
test asserts the module exports exactly these five functions.

---

## 9. Immutability

Economic facts on a recorded snapshot are not editable in place. This is enforced
three ways rather than described once:

1. **The tables are split.** Mutable settlement metadata lives on
   `TransactionSettlement`; the snapshot holds only facts fixed at the instant of
   sale.
2. **No operation writes to the snapshot after its insert**, asserted by the
   exported-function test.
3. **The snapshot table has no `updatedAt` column**, because nothing updates it —
   asserted directly against `information_schema`.

An integration test drives a snapshot through settlement advance, provider-
reference recording, and reversal, then asserts the snapshot row is byte-
identical to what it was before.

---

## 10. Deferred to `0M.T2` and later

**`0M.T2`** — tax calculation · nexus determination · product tax classification ·
sourcing · registration · remittance and filing · tax refunds and reversals ·
refund and chargeback accounting · representment evidence · processor
reconciliation workflows · double-entry ledger postings.

**`0M.9`** — Order and order-line records · checkout · payment initiation · payout
execution.

**`0M.R2`** — per-transaction, per-participant, and per-class policy selection ·
reserves · payout holds · transaction caps.

All of it is named in `NEVER_ON_TRANSACTION_ECONOMIC_SNAPSHOT` and
`DEFERRED_TRANSACTION_ACCOUNTING_EXTENSIONS`, and a test asserts none of those
field names is admissible through any input.

---

## 11. Relationship to `0M.9`

`0M.9` mints the Order. A snapshot has **no Order reference today**, deliberately:
`0M.9` owns Order creation, and an unconstrained nullable column here would be
that phase started early. Binding an Order to a snapshot is an additive nullable
FK column — a migration, not a rewrite, which is exactly the outcome this phase
was scoped to guarantee.

The handshake `0M.9` inherits:

- it calls `recordTransactionEconomicSnapshot` with the **exact** Listing version
  and the **exact** policy version its checkout priced against, plus the tax,
  shipping, and pass-through amounts it charged;
- it receives a snapshot whose economics are already reconciled, and a `PENDING`
  settlement row;
- when its payment provider answers, it records the provider transaction
  reference and advances settlement state;
- it never edits the economics, because there is no operation that could.

---

## Reference

- [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md) — §B the standard policy, §C/§D the worked examples, §G/§H tax and shipping, §I reversals
- [`VERSIONED_COMMERCIAL_POLICY_AND_ACTIVATION_RISK.md`](VERSIONED_COMMERCIAL_POLICY_AND_ACTIVATION_RISK.md) — `0M.R1`, the exact `(policyId, policyVersion)` binding
- [`LISTING_SOURCE_MODEL.md`](LISTING_SOURCE_MODEL.md) — where the economics are encoded
- [`LISTING_PERSISTENCE.md`](LISTING_PERSISTENCE.md) · [`OFFER_PERSISTENCE.md`](OFFER_PERSISTENCE.md) — the version keys bound here
- [`PAYMENT_PROVIDER_ONBOARDING_AND_ACTIVATION.md`](PAYMENT_PROVIDER_ONBOARDING_AND_ACTIVATION.md) — `0M.8`, the provider-reference conventions
- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md) — financial records are relational-first and are not entity capsules
- [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md) — `0M.T`, `0M.9`
