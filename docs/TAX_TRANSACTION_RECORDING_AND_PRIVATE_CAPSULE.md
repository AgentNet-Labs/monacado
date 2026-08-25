# Tax Transaction Recording and Private Tax Capsule Foundation (Phase 1.7)

Phase 1.6 calculates tax and records **why** a buyer was charged what they were
charged, before the charge. This adds the half that happens afterwards:

```
calculation → successful payment → provider Tax Transaction → durable Monacado record
```

It also projects the first **private** capsule — the first whose purpose is
reasoning rather than discovery — and publishes nothing.

Nothing here enables live Stripe, implements filing or remittance, executes a
refund or a reversal, executes a payout, or publishes to AgentNet.

---

## 1. Calculation vs Tax Transaction

Two facts about different instants, and one exists without the other.

| | `OrderTaxEvidence` (1.6) | `OrderTaxTransaction` (1.7) |
| --- | --- | --- |
| Answers | what was calculated, and why | what was reported to the provider |
| Instant | **before** the charge | **after** the charge succeeded |
| Exists for | every checkout that priced tax | every **paid** Order |
| A declined payment | leaves one | leaves none |

Folding the second into the first would make "was this reported?" and "what was
calculated?" the same question, and would mean mutating a sale-time evidence row
every time a retry advanced.

**Why the provider needs a transaction at all.** Stripe Tax's reporting, filing,
and reversal products all operate on a **Tax Transaction**, created from a
calculation after payment. Until one exists, the provider's reports do not
contain the sale — and a calculation that expires unrecorded can never become one.
That consequence was recorded as a known gap in `1.6`; this phase closes it.

---

## 2. Audit-efficient persistence

Two failure modes were available and both are refused.

**Storing only a provider id** would mean every audit, reconciliation, refund,
correction, and filing preparation begins with a round trip to Stripe — and would
be unanswerable once a credential rotates, an account closes, or a provider is
replaced.

**Mirroring the raw response** would put an unbounded vendor payload, with a
customer address in it, into a table nobody scoped.

What is kept is the bounded set of facts a later reader actually needs:

| Kept | Why |
| --- | --- |
| provider, provider mode | which engine, in which world |
| provider **calculation** ref | what the transaction was created *from* |
| provider **transaction** ref | **what a reversal names** |
| provider reference (the Order id) | Stripe's own uniqueness guard |
| currency, taxable basis, tax amount | the sale's tax arithmetic |
| provider represented total | the provider's own arithmetic, **checked** |
| ship-to jurisdiction code | where it was sourced |
| treatment | `TAXABLE` / `EXEMPT` / `OUT_OF_SCOPE` |
| Product source record + version | which immutable version priced it |
| Product tax classification | what that version declared |
| provider tax code + config version | what the engine was told, and by which map |
| calculatedAt · provider createdAt · recordedAt | the three instants |

**Deliberately absent:** buyer name, email, billing address, ship-to street,
payment credentials, Product prose, and any raw provider payload.
`NEVER_ON_TAX_TRANSACTION` names them, and each already lives in exactly one
authoritative record — a second copy here would be a second answer able to
disagree.

### Line-level evidence

An `0M.9` Order binds one Listing and therefore one Product, so the Product
fields on the record **are** the line-level tax evidence. A multi-line Order
needs a lines table; that is recorded as a seam rather than built as a table
that would hold exactly one row per parent, duplicating the parent's columns.

---

## 3. Immutable sale-time facts

`IMMUTABLE_TAX_TRANSACTION_FIELDS` names nineteen fields written once, inside the
sale's own transaction, and **never rewritten** — not by a retry, not by a later
adjustment, not by a reversal.

What moves is:

- the **recording status** — did the provider call succeed yet;
- the **tax lifecycle state** — has this sale's tax since been adjusted or
  reversed (reserved; see §7);
- the two provider-transaction fields that do not exist until the provider
  answers.

An integration test drives a failure, a retry, and a success, then asserts every
immutable field is byte-identical to what was committed with the sale.

---

## 4. The payment-finalization boundary

```
recordCompletedSale (ONE transaction)
  ├─ economic snapshot + settlement            (0M.T1)
  ├─ proceeds obligations                      (0M.9)
  ├─ tax-recording obligation  status=PENDING  ← 1.7
  ├─ purchase evidence                         (0M.9)
  └─ notification obligations                  (0M.N1)
        … later, outside any transaction …
  tax:record:once → claim → verify → provider → resolve
```

**The obligation commits with the sale.** Either the sale and its tax-recording
obligation both exist, or neither does. There is no window in which Monacado has
taken money and holds no record that it owes a tax report.

**The provider is not called there.** Contacting Stripe inside a database
transaction would hold a lock across a network round trip and — far worse — would
let a provider timeout roll back a **completed payment**. The rule is the
opposite: *the payment stands, and the unreported tax becomes durable work.*

**A replayed webhook creates nothing new.** `orderId` is `UNIQUE`, and `0M.9`'s
replay branch returns the existing sale without re-entering the write path.

**A failed, cancelled, or pending Order gets no row at all**, because the row is
only ever written on the successful-sale path. The recorder re-checks the Order
is `PAID` anyway — a guarantee worth having is worth asserting.

**A pre-1.6 Order** whose evidence predates the facts a transaction needs commits
`null`. Nothing is fabricated; reconciliation names the gap instead.

### The state machine

| Recording status | Means |
| --- | --- |
| `PENDING` | committed with the sale; provider not yet called |
| `IN_PROGRESS` | claimed by a worker, with a lease |
| `RECORDED` | the provider created the transaction and returned its reference |
| `RETRY_PENDING` | transient failure; `nextAttemptAt` says when |
| `FAILED_PERMANENT` | out of attempts, or a permanent refusal — needs an operator |

---

## 5. Retry and recovery

**No new queue.** This reuses `1.5`'s `OutboundEmailDelivery` mechanism exactly:
a guarded `updateMany` claim with a lock token and a lease, bounded attempts, a
readable backoff, and a terminal pair — the same technique `PublicationOutbox`
established.

- **8 attempts**, backoff `30s · 2m · 10m · 30m · 2h · 6h · 12h`. More attempts
  and a longer tail than email: an undelivered receipt is a buyer who has to ask;
  an unreported tax transaction is a sale missing from a filing, and the
  calculation eventually expires.
- **A 300-second lease.** A worker that dies mid-call costs an *attempt*, not the
  obligation — the lease expires and the row becomes eligible again.
- **Permanent failures stop immediately** rather than burning eight attempts on a
  refusal that cannot change. `CALCULATION_EXPIRED` and `DUPLICATE_REFERENCE` are
  the clearest cases.
- **One row's failure never abandons the batch.**

`npm run tax:record:once` runs **one bounded cycle** — no loop, no scheduler, no
daemon, the same shape as `worker:publication:once` and `email:dispatch:once`.

### The questions an operator can answer

`listUnreportedTaxTransactions` answers all of them from Monacado's own rows:
which paid Orders still lack provider transactions, why (a bounded failure code),
how many attempts, the last normalised failure, and when the next attempt is due.

**No raw Stripe error payload is persisted.** A vendor error string can echo the
request, and the request named a ship-to destination. Errors are classified into
`TAX_RECORDING_FAILURE_CODES` at the adapter boundary and the message is
discarded.

### Idempotency — two independent guards

| Guard | Whose | Stops |
| --- | --- | --- |
| `idempotencyKey` | Monacado's, `sha256(orderId + calculationRef)` | a retry after a timeout creating a second transaction |
| `reference` | Stripe's uniqueness over its own transactions | **any** path creating a second transaction for one Order |

Unlike `1.6`'s calculation key, this one *can* be Order-derived: by the time it is
needed the sale is paid and both inputs are immutable. It carries no clock and no
attempt counter, so **every attempt sends the identical key**.

---

## 6. Reconciliation

`reconcileOrderTax` compares four things and reports where they disagree:

```
Order  ·  OrderTaxEvidence  ·  OrderTaxTransaction  ·  provider reference/state
```

**No provider call.** Routine reconciliation consults Monacado's own rows and
nothing else — which is exactly what §2's persistence is *for*. A reconciler that
had to ask Stripe would stop working when a credential rotated and would put a
rate-limited network call behind an operations page. `PROVIDER_AUDIT_SEAM` records
that a deeper, provider-consulting audit is a later explicit operation.

**It reports; it never reconciles anything into agreement.** A divergence between
two authoritative records is a fact somebody must decide about, and quietly
fixing one would destroy the evidence that they ever disagreed.

Findings: `CONSISTENT` · `PAID_ORDER_MISSING_TAX_TRANSACTION` ·
`TAX_TRANSACTION_NOT_RECORDED` · `TAX_TRANSACTION_RECORDING_FAILED` ·
`PAID_ORDER_MISSING_TAX_EVIDENCE` · `CONFLICTING_PROVIDER_REFERENCE` ·
`TAXABLE_BASIS_MISMATCH` · `TAX_AMOUNT_MISMATCH` · `PROVIDER_TOTAL_MISMATCH` ·
`CURRENCY_MISMATCH` · `PRODUCT_VERSION_MISMATCH` · `JURISDICTION_MISMATCH`.

**Every finding, not the first.** An unpaid Order is `CONSISTENT` by construction:
nothing is owed for a sale that never completed, and reporting it as a gap would
bury the paid ones that are.

---

## 7. Zero tax

**A zero-tax sale is still reported.** `requiresProviderTaxTransaction` returns
`true` unconditionally, and it is a function rather than an implicit rule because
the tempting optimisation — skip the call when the amount is zero — is wrong in a
way that only shows up at filing time. A jurisdiction where Monacado is registered
and collected nothing is a **return line**, not an absence, and a transaction the
provider never saw cannot appear on one.

Preserved on the record: the provider calculation reference, the classification,
the ship-to jurisdiction, the treatment (`EXEMPT` vs `OUT_OF_SCOPE` stay
distinct), the zero amount, and the provider transaction reference.

**No buyer exemption workflow exists** — unchanged from `1.6`, and
`NEVER_ON_TAX_TRANSACTION` refuses exemption, VAT, and resale-certificate fields
on this record too.

---

## 8. Adjustment and reversal — the future hook

**Not implemented.** No reversal is executed, and `createReversal` is deliberately
absent from the recording port: putting it there now would ship a capability whose
accounting rules nobody has decided.

What is already durable and sufficient:

- `providerTaxTransactionRef` — **the identifier Stripe reverses**. `1.6` could
  only offer the calculation reference and recorded that as the gap; it is closed.
- `providerCalculationRef`, `provider`, `providerMode`.
- The whole immutable sale-time basis, so a correction can be related to what was
  originally reported.
- `TAX_TRANSACTION_LIFECYCLE_STATES` reserves `ADJUSTED`, `PARTIALLY_REVERSED`,
  and `REVERSED`; only `RECORDED` is reachable, and a test asserts it.

**Append, never rewrite.** The reserved states exist so a later correction can be
expressed without rewriting sale-time facts underneath it. A vocabulary introduced
at the moment it is first needed tends to be introduced by whoever is mid-way
through building a refund — which is how a correction ends up overwriting an
original.

**The Phase 1.2 economic snapshot is untouched**, by this phase and by that one.

---

## 9. Private tax capsule

`projectTaxTransactionCapsule` deterministically projects the authoritative record
into a **private** capsule candidate. Same record + same context ⇒ byte-identical
candidate and identical hash.

**The database stays authoritative.** A projection in the ADR's exact sense: one
way, from an identified authoritative record, creating no provenance and
authorizing no business change. If a capsule and its row ever disagree, the row is
right.

**Candidate metadata, not published metadata.** No capsule id, Node binding,
Publisher, or `publishedAt` is fabricated, because **nothing is published**. A
test asserts the module imports no registrar, publication, outbox, or transport
machinery, and that the candidate carries no publication fields.

**Exposed:** stable tax transaction identity, Order reference, currency, taxable
basis, tax amount, provider total, ship-to jurisdiction **code**, Product and
version references, classification, provider and mode, both provider references,
the instants, lifecycle state, `adjustmentRefs` (always empty this phase), and
provenance back to the authoritative record.

**Never:** buyer name, email, street or billing address, payment credentials, raw
provider payload. `NEVER_IN_TAX_TRANSACTION_CAPSULE` names them and `strictObject`
enforces it.

A `PENDING` transaction is deliberately projectable — a committed-but-unreported
row is exactly what a reconciliation agent needs to reason about, and refusing to
project it would hide the rows that matter most.

---

## 10. Public vs private capsule governance

`src/contracts/capsule/visibility.ts` states the rule that had been a per-capsule
habit until now:

| Visibility | Purpose | Shapes |
| --- | --- | --- |
| `PUBLIC` | **discoverability** | Product, Storefront, Offer, Listing |
| `PRIVATE` | **research, reconciliation, audit, internal agentic workflow** | TaxTransaction |

There is **no third member and no absent case**: a shape that declared no
visibility would eventually be published by whoever wired the next publisher, on
the reasonable assumption that capsules are for publishing.

**Making a private shape public requires editing that file in the open** — the
same construction `STRIPE_MODES` uses for live payments, and for the same reason.
`PUBLIC_DISCLOSURE_REQUIREMENTS` records what a decision must include: an explicit
governance decision, an **aggregate** disclosure review, and a party-consent
review. For a tax transaction specifically, public disclosure would need a
judgement about what a jurisdiction, a taxable basis, and a Product classification
reveal in aggregate about a seller's business.

**Nothing is published to the AgentNet public resolver, or anywhere else.**

---

## 11. Readiness

The tax posture now distinguishes five things rather than four:

| | |
| --- | --- |
| calculation configured | `calculationConfigured` |
| **transaction recording available** | `taxTransactionRecordingAvailable` |
| **whole lifecycle** | `taxLifecycleReady` = both of the above |
| registration configured | `registration.complete` |
| filing/remittance configured | `filing.posture` |
| live provider enabled | by construction, never |

A deployment that can calculate but not record reports
`TAX_TRANSACTION_RECORDING_NOT_AVAILABLE` and **does not report tax lifecycle
readiness** — a system in that state collects tax that never reaches a return.

**Recording is not filing readiness.** `TAX_FILING_BOUNDARY.providerRecordsTransactions`
becomes `true`; `filing` and `remittance` are unchanged at `NOT_IMPLEMENTED`, and
`filing.recordingImpliesFilingReadiness` is `false` so the distinction cannot be
misread. Stripe's reports now contain Monacado's sales; somebody still has to be
named to submit them.

---

## 12. Migration

One additive migration:
`20260824170000_add_order_tax_transaction_recording`.

One `CREATE TABLE` and two foreign keys **on that new table**. No existing table
is altered, nothing is dropped, renamed, or narrowed, and no committed migration
is modified.

Both `UNIQUE` keys are load-bearing — one tax transaction per Order, and one per
calculation evidence row. Both foreign keys are `RESTRICT`: deleting the Order or
the evidence beneath a tax transaction would leave a filing obligation nobody can
account for.

**No backfill.** Orders paid before this phase have no row and cannot be given one
— a provider transaction can only be created from a live calculation, and
inventing a reference would fabricate a report that never happened.
Reconciliation names those Orders instead.

---

## 13. Remaining work and blockers

1. **Filing and remittance.** Still `NOT_IMPLEMENTED`. Stripe's reports now
   contain Monacado's sales; who files them is an operator posture, and no
   machinery exists here.
2. **Reversal execution.** `createReversal`, the accounting rules for whose money
   comes back, and the relation between a tax reversal and an Order refund.
3. **Live Stripe.** `STRIPE_MODES` still has one member.
4. **Nexus determination and registrations** — unchanged operator
   responsibilities from `1.6`.

   **Buyer tax-exemption certificates are not remaining work.** Standard
   Monacado retail checkout does not support exemption or resale certificates,
   buyer-entered VAT IDs that reduce checkout tax, exemption-number validation,
   or a buyer exemption approval workflow — and none of that is planned. It is a
   settled policy decision, not a gap: see `MONACADO_RETAIL_TAX_POLICY` and
   [`PRODUCTION_TAX_INTEGRATION.md`](PRODUCTION_TAX_INTEGRATION.md) §15.

   That is a different thing from **provider-determined non-taxability**, which
   is fully supported and fully evidenced (§7). A buyer who may recover tax
   because of their own tax status does so through the applicable tax recovery
   and filing procedures; Monacado or its providers may later make required tax
   corrections or adjustments.
5. **A scheduler for `tax:record:once`.** The cycle is bounded and deliberately
   has no loop; something must run it. Until then an unreported sale waits for an
   operator, and `tax:record:once` exits non-zero when a row is permanently stuck.
6. **Multi-line Orders** would need a tax lines table (§2).
7. **Provider-side audit** — `PROVIDER_AUDIT_SEAM`, deliberately not built.
8. **Private capsule publication** — the projection exists; where a private
   capsule is *served* to internal readers is not designed here.

---

## Reference

- [`PRODUCTION_TAX_INTEGRATION.md`](PRODUCTION_TAX_INTEGRATION.md) — Phase 1.6
- [`PRE_LIVE_COMMERCE_CONTROLS.md`](PRE_LIVE_COMMERCE_CONTROLS.md) — Phase 1.2
- [`MOR_TRANSACTION_ACCOUNTING_FOUNDATION.md`](MOR_TRANSACTION_ACCOUNTING_FOUNDATION.md)
- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
