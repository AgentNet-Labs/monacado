# Production Tax Integration (Phase 1.6)

Phase 1.2 built a provider-neutral tax boundary and deliberately put no vendor
behind it. This phase puts one there: **Stripe Tax**, in test mode, behind the
unchanged `TaxCalculationPort` — plus the authoritative Product fact a real
engine needs, the evidence a real transaction must keep, and a readiness boundary
that refuses to guess at anything fiscal.

Nothing here enables live commerce, executes a payout, implements a refund, or
files a return. `STRIPE_MODES` still has exactly one member.

---

## 1. Provider selection

**Stripe Tax**, as the initial production tax-calculation provider.

The repository had no selected provider — `1.2` recorded that choosing one meant
choosing "a third party, a data-processing relationship, and a filing posture"
and declined to do it inside a phase about boundaries. That decision is now taken
deliberately, and the reasoning is short:

- Stripe is already the payment platform, and Monacado is **merchant of record**
  on those charges.
- A tax engine sharing the payment account is the one whose registrations,
  reports, and eventual reversals line up with the charges they concern. A second
  vendor means reconciling two views of one sale, and the first divergence
  between them is a filing question nobody can answer.
- It adds **no dependency**. Tax calls go through the Stripe SDK the payment
  integration already installed, on the same account and the same
  test-mode-only credential path.

`1.2` also recorded a harder blocker: a real engine needs to know where the buyer
is, and Monacado collected no address. That was resolved by `1.2`'s own buyer
snapshot, and the bounded destination derived from it is what makes a real
calculation possible without a street address ever crossing the tax boundary.

`TAX_PROVIDERS` gains one member. `PRODUCTION_TAX_PROVIDERS` names it as the only
one that may govern real commerce — a separate list rather than "not a test
adapter", so the distinction is a fact one can grep for.

---

## 2. The provider-neutral boundary

Everything Stripe-shaped lives in **two files**:

| File | Holds |
| --- | --- |
| `src/server/tax/stripe-tax-adapter.ts` | the request shape, the response mapping, the SDK call |
| `src/server/tax/tax-runtime-config.ts` | the credential's variable name, the classification → tax-code map, the compliance posture |

The sourcing rule is **not** among them: it lives in
`src/contracts/marketplace/tax-destination.ts` as a provider-neutral
normalization of the Order's ship-to address. The adapter holds only Stripe's
word for it, as a constant.

No general checkout or business logic depends on a Stripe Tax response structure.
`beginCheckout` calls `TaxCalculationPort.calculate` and receives a `TaxQuote`;
it does not know which engine answered. A second engine is a new adapter plus a
new `TAX_PROVIDERS` member, and **no change to any caller**.

The Stripe client is reached through a **one-method port**,
`StripeTaxCalculationClient`. Tests inject a double, and no network call occurs
anywhere in the test suite — asserting that a classification maps to the right
provider code should not require an account, a credential, or an internet
connection.

### What crosses the boundary

**Outward:** two amounts, a currency, a provider tax code, and **one** bounded
destination — the Order's ship-to country, subdivision, and postal code, sent with
Stripe's destination representation (`address_source: "shipping"`, a constant).

**Never outward:** the billing address, buyer name, email, street line, city,
customer object, or IP address. `customer_details.ip_address` is left unset
deliberately rather than by omission.

**Inward:** an amount, a treatment, an expiry, and a calculation reference. No
raw payload is persisted or logged.

---

## 3. Product tax classification

The smallest authoritative Product fact a production calculation needs:
`ProductSourceRecord.taxClassification`, a **provider-neutral Monacado
vocabulary**.

```
DIGITAL_GOOD | SOFTWARE | PHYSICAL_GOOD | SERVICE
```

Four members, each because tax regimes routinely treat it differently from the
others — `SOFTWARE` is separate from `DIGITAL_GOOD` because many US states and
several VAT regimes tax pre-written software, custom software, and SaaS
distinctly.

**There is no `OTHER` or `UNSPECIFIED`.** A member meaning "we do not know" is a
member an engine can be handed, and the whole point of the fact is that an
unclassified Product cannot be sold under a production calculation. Absence is
the field being absent, which fails closed.

### Where it lives, and why not in the capsule

It sits on the **source record**, beside `recordStatus` — deliberately **not**
inside `facts`, so it never reaches a published capsule.

1. **Authority.** A tax classification is a *fiscal* characterization used by
   Monacado as merchant of record. Publishing it inside the creator's Product
   capsule would put a Monacado-fiscal claim under creator authority, which ADR
   §2's partitioning exists to prevent.
2. **It is not a determination.** A capsule reader would reasonably treat a
   published classification as a statement about tax due. It is an *input* to an
   engine that makes that determination, under registrations configured
   elsewhere.

Consequences, all asserted by test: classifying a Product changes nothing about
the artifact it publishes — same candidate, same hash — and
`PROJECTION_EXCLUDED_FIELDS` names it alongside `recordStatus`.

### Immutable source-version rules

Unchanged. A classification change is a **new `sourceRecordVersion`**;
`reviseProductSourceRecord` carries the prior value forward unless a new one is
stated, and there is no way to *clear* it. An older version keeps the
classification it was sold under, forever — which is what lets a completed sale
keep explaining itself after a reclassification.

The column is `NULL`-able for backward compatibility only: source versions
written before `1.6` declare none, and requiring it would invalidate them
retroactively.

### Provider codes are never a Product fact

A `txcd_…` never enters Product semantics. The mapping
`classification → provider tax code` lives in the configuration layer, so
changing tax engine never rewrites immutable Product history.

### `PHYSICAL_GOOD` is not `deliveryMode: PHYSICAL`

Neither is derived from the other. Delivery mode answers *does this need a
shipping address*; classification answers *how is this taxed*. A service can
require an address; software can ship on a disc. The one **contradiction** worth
surfacing — a `PHYSICAL_GOOD` delivered `DIGITAL` — is reported by
`taxClassificationAgreesWithDelivery` and refuses the checkout.

---

## 4. Calculation flow

```
prepareCheckout            price from authoritative state; writes nothing
  → risk gate              deny leaves NO Order behind
  → commerce readiness     governing policy + reachable seller
  → resolve Product tax facts   ← 1.6: classification + delivery + exact version
      unclassified? → REFUSE, before any provider is contacted
      contradiction? → REFUSE
  → resolveShipToAddress       ← same-as-billing copies billing in
      neither address nor flag? → REFUSE, before any provider call or Order
  → resolveTaxDestination      ← ship-to, bounded. One rule, no choice.
  → TaxCalculationPort.calculate
      request: amounts, currency, ship-to destination, Product basis, idem key
      Stripe Tax: tax.calculations.create
      guardTaxPort: currency, basis, coherence, Product basis, expiry, completeness
  → placeOrder             the Order carries the calculated tax
  → buyer snapshot
  → recordOrderTaxEvidence requireTaxQuoteMatchesOrder(order, quote, at)
  → initiateOrderPayment   only now, a payment
```

Unchanged from `1.2`: tax is calculated **before** Order/payment initiation, and
checkout **fails closed** when calculation is unavailable.

### Addresses, and where tax is sourced

**Standard Monacado retail checkout takes two buyer addresses, and both are
always required.**

| Address | Always required | What it is for |
| --- | --- | --- |
| billing | yes | payment authorization and the transaction record |
| ship-to | yes | the destination, and **the tax jurisdiction** |

There is **no third buyer-facing tax address**, and no runtime choice of tax
source. `resolveTaxDestination` reduces the Order's ship-to address to the
bounded fields an engine needs, and that is the whole of it:

```
tax jurisdiction = ship-to, always — DIGITAL, PHYSICAL, and mixed alike
```

Explicitly not: a buyer-declared tax location, a billing tax-source mode, IP
sourcing, proxy piercing, or device location.

**`shipToSameAsBilling` is why two addresses is not friction.** A buyer shipping
to the address they pay from ticks one box; billing is **copied** into the
authoritative ship-to fields, and nobody types the same address twice. What is
stored afterwards is an ordinary ship-to address, indistinguishable from one that
was typed — deliberately, so that a later correction to billing cannot move where
a completed sale was taxed and sent.

**A ship-to address does not imply physical fulfillment.** On a digital purchase
it is a tax destination and nothing more: no parcel, no carrier, no shipping
address collected on the provider's hosted page, and the digital-delivery
entitlement policy untouched. Whether anything physically ships stays
`evaluateBasketFulfillment`'s separate question, decided from explicit Product
`deliveryMode` facts.

**A mixed basket is ordinary.** Every line shares the one transaction ship-to for
tax sourcing, so differing delivery modes are no longer a reason to refuse. Split
shipments and multiple ship-to destinations are not implemented and would need
their own governed design.

The destination sent is **an address, bounded**: country, subdivision, postal
code. Stripe Tax cannot produce a correct US rate from a two-letter country code
— sales tax varies by municipality, and the postal code is the smallest element
that resolves it. That is exactly the carve-out `1.2` anticipated: *the collected
address remains the jurisdiction source unless the actual provider requires
additional destination information*.

**This does not resolve every international sourcing rule, and does not claim
to.** It decides which transaction facts Monacado supplies; **Stripe Tax
determines the tax result from them**. Origin sourcing, marketplace-facilitator
rules, VAT place-of-supply for digital services, and reverse charge are all the
engine's to apply.

#### What was removed on the way here

Two earlier shapes existed inside this uncommitted phase. The first sourced
everything to billing. The second chose between billing and shipping according to
what the basket delivered, and carried a `BILLING | SHIPPING` enum through the
request, the quote, and an evidence column to record which branch had been taken.

Both are gone, along with the enum, the `destinationSource` column, and the
billing-derived `buyerJurisdictionCode` request field. **A two-member vocabulary
with one legitimate production value is worse than none**: every reader has to
work out which member is real, and the dead one is an invitation to make it
reachable again. A test asserts none of those names survives in the contract.

#### Where the destination decision fails closed

| Condition | Outcome |
| --- | --- |
| neither a ship-to address nor `shipToSameAsBilling` | refuses, before any provider call and before an Order exists |
| a malformed or partial ship-to address | refuses — half an address must not become a tax jurisdiction |
| no billing address | refuses |
| delivery mode unknown | refuses — absence is never a default |

The refusal keeps `1.2`'s error identity (`SHIPPING_ADDRESS_REQUIRED`), so a
caller does not learn a second word for one condition. It lands **before the
Order is written**, because "where does this go" must be answered before the
engine is called — so a purchase that cannot be sourced leaves nothing behind.

Never a silent fallback to billing when ship-to is missing: that would tax a sale
to an address the buyer never nominated, and the resulting quote would look
exactly like a correct one.

### Amounts

Line items and shipping are sent `tax_behavior: "exclusive"` — Monacado quotes
tax **on top of** retail, and sending `inclusive` would reinterpret the retail
price as tax-inclusive and shrink every party's revenue. An answer carrying
inclusive tax is refused.

### Treatment mapping

| Stripe | Monacado |
| --- | --- |
| `tax_amount_exclusive > 0` | `TAXABLE` |
| no breakdown at all | `OUT_OF_SCOPE` |
| every reason in `not_collecting`, `not_subject_to_tax`, `not_supported`, `reverse_charge` | `OUT_OF_SCOPE` |
| any other zero reason | `EXEMPT` |

A reason Stripe adds later reads as `EXEMPT` — true of every zero — rather than a
guess at what the new word means.

### Tax is not commercial revenue

Unchanged, and structurally so: `reconcileTransactionEconomics` has no term for
tax, and `PASS_THROUGH_AMOUNT_FIELDS` is asserted absent from every basis. A test
asserts a real Stripe-Tax-priced sale of $100.00 retail with $8.75 tax still
retains $8.50 and pays the seller $91.50.

---

## 5. Tax evidence

`OrderTaxEvidence` gains seven nullable columns. Every one exists so a completed
transaction stays **interpretable after the world moves on**:

| Column | Answers |
| --- | --- |
| `providerMode` | was this a real calculation, in which world |
| `productSourceRecordId` / `Version` | which immutable Product version priced it |
| `productTaxClassification` | what that version declared |
| `providerTaxCode` | what the engine was actually told |
| `providerConfigVersion` | which mapping produced that code |
| `providerCalculationExpiresAt` | when the engine stops honouring it |

Together with `1.2`'s existing `provider`, `providerCalculationRef`, `currency`,
`taxAmountMinorUnits`, `basisAmountMinorUnits`, `treatment`, `jurisdictionCode`,
`buyerSnapshotId`, and `calculatedAt`.

**Pinned, never joined.** Reclassifying a Product tomorrow, or remapping
`SOFTWARE` next quarter, changes nothing about a sale made today.

`jurisdictionCode` records the jurisdiction of the **ship-to** destination
actually sent. There is deliberately **no companion "which address was this"
column**: tax is always sourced to ship-to, so such a column would have exactly
one legitimate value. The addresses themselves live once, on
`OrderBuyerSnapshot`, reached through `buyerSnapshotId` — the tax evidence never
duplicates one.

**What it deliberately does not hold:** no raw provider payload, no line-item
echo, no copy of the Order or Product snapshot, and no address. The destination
sent to the engine includes a postal code; the evidence keeps only the bounded
jurisdiction code, because the address lives once on the buyer snapshot and is
reached through `buyerSnapshotId`. `NEVER_ON_TAX_EVIDENCE` names the rest.

---

## 6. Calculation consistency

Enforced in two places, checking two different things.

**`guardTaxPort`** — every adapter, against the **request**:

- coherence (`EXEMPT`/`OUT_OF_SCOPE` ⇒ zero; `TAXABLE` ⇒ tax ≤ basis);
- currency equals the request's;
- basis equals retail + shipping;
- Product basis equals the request's, field by field;
- not already expired at the request instant;
- a production quote carries Product basis, provider code, and mapping version.

Non-negativity needs no check: `Amount` is a non-negative integer, so a negative
tax cannot be parsed into a quote at all.

**`requireTaxQuoteMatchesOrder`** — against the **Order**, the last point before
a buyer is charged:

- currency, tax amount, and basis equal the Order's;
- the quote's Product is the Order's Product;
- production completeness;
- not expired at the instant the sale is booked.

Additionally the Stripe adapter checks Stripe's own arithmetic —
`amount_total === basis + tax`, and `tax_amount_inclusive === 0` — rather than
trusting it.

Every failure is a refusal. None returns a zero.

---

### Where the destination decision fails closed

| Condition | Outcome |
| --- | --- |
| `PHYSICAL` with no shipping address | refuses, before any provider call and before an Order exists |
| `DIGITAL` (or any sale) with no billing address | refuses |
| delivery mode unknown | refuses — absence is never a default |
| mixed basket | refuses — see above |
| a decision contradicting its own fulfillment basis | refused by `taxDestinationAgreesWithFulfillment` at the port |
| a quote sourced to a different address than requested | refused by `guardTaxPort` |

The physical-without-shipping refusal keeps `1.2`'s error identity
(`SHIPPING_ADDRESS_REQUIRED`) so a caller does not have to learn a second word
for one condition. **It now lands earlier** — before the Order is written rather
than after — because "where does this go" must be answered before the engine is
called. The requirement itself is unchanged, and a purchase that cannot be
delivered now leaves nothing behind at all.

## 7. Idempotency and quote validity

The Order id cannot be the key: tax is calculated **before** `placeOrder`
commits, so at the moment the engine is called there is no Order id, and minting
one early would invent an Order for a checkout that may be refused.

`taxCalculationIdempotencyKey` digests the calculation's own facts — currency,
both amounts, the Product source version, the classification, the delivery mode,
the seller, and the ship-to destination. The **instant is excluded**: including it would
make every retry a fresh key, which is the same as having no key.

- A reload, retry, or double-submit of the *same* checkout produces the *same*
  key, so Stripe returns the calculation it already made.
- Any change that could change the tax owed produces a *different* key, so a
  stale calculation is never reused.

The key is 64 hex characters and discloses nothing about the buyer.

**Expiry is modelled explicitly.** Stripe's `expires_at` is read onto
`TaxQuote.expiresAt`, persisted, and checked at both boundaries. An expiry
exactly at the instant reads as expired.

---

## 8. Registration and nexus posture

**Nothing is inferred.** Monacado does not determine nexus, does not decide where
it is registered, and does not read Stripe's registration list at calculation
time.

Stripe Tax **owns registration configuration**: an operator adds a registration
in the Stripe dashboard, and Stripe then collects for that jurisdiction. Monacado
keeps the smallest honest Monacado-side record that the integration is
**intentionally configured**:

| Variable | Meaning |
| --- | --- |
| `MONACADO_TAX_REGISTRATIONS_CONFIGURED` | an operator states the provider-side registrations are configured |
| `MONACADO_TAX_REGISTRATION_CONFIG_REF` | a bounded reference to where that decision is recorded |

Both, or the posture is **incomplete** — claiming registrations exist without
saying where the decision is recorded is half an answer, and the missing half is
the one an auditor asks for. It holds no jurisdiction list, no rate, and no
registration number: each would be a second copy of something the provider owns
authoritatively.

There is one operational consequence worth stating plainly. Stripe returns a
calculation with a **null id** when the result cannot become a Tax Transaction —
most commonly because no registration covers the destination. Monacado
**refuses** such a calculation rather than charging on it, because a sale whose
tax cannot afterwards be evidenced to, or reversed with, the engine is a sale
nobody can answer questions about. That makes an unconfigured registration
posture *visible* instead of silently producing zero-tax sales — and it is a
behaviour an operator must understand before going live (see §12).

---

## 9. Filing and remittance boundary

**Monacado files nothing and remits nothing.** Stated as a value,
`TAX_FILING_BOUNDARY`, so a later reader can check what was claimed against what
was built:

| | |
| --- | --- |
| calculation | `IMPLEMENTED` |
| provider tax transactions recorded | `false` |
| nexus determination | `OPERATOR_AND_ADVISER` |
| registration | `OPERATOR_CONFIGURED_IN_PROVIDER` |
| filing | `NOT_IMPLEMENTED` |
| remittance | `NOT_IMPLEMENTED` |

### What Stripe Tax handles, and what does not exist yet

Stripe Tax handles rate determination, product tax categories, registrations
(configured in its dashboard), and — as separate products — reporting and
filing.

Stripe's reporting, filing, and reversal products all operate on **Tax
Transactions**, created from a calculation *after* the payment succeeds. **This
phase creates none.** It is a write into a provider on a confirmed sale, and its
natural owner is the phase that also needs to reverse it.

The consequence, stated rather than discovered later: **until transactions are
recorded, Stripe Tax's reports do not contain Monacado's sales**, and a
calculation that expires unrecorded cannot be turned into one afterwards. No
Stripe Tax report should be treated as if it covered Monacado's transactions.

### Who still has to do what

- decide where Monacado has nexus — **operator and its tax adviser**;
- add registrations in Stripe — **operator**;
- choose the provider tax code for each Monacado classification — **operator and
  its tax adviser**;
- decide who files and remits, and state it — **operator**
  (`MONACADO_TAX_FILING_POSTURE`);
- record provider-side Tax Transactions — **a later phase** (§10).

---

## 10. The refund/reversal seam

**No refund execution exists in this phase**, and nothing below is called. The
contract is written down now rather than reconstructed later:
`TAX_REVERSAL_FUTURE_HOOK` in `tax-evidence-service.ts`.

**Already durable:** `provider`, `providerMode`, `providerCalculationRef`,
`providerCalculationExpiresAt`, and the pinned Product basis. Together they
identify the original calculation unambiguously.

**Required future steps**, in order:

1. `RECORD_PROVIDER_TAX_TRANSACTION_ON_CONFIRMED_PAYMENT` — must happen at
   confirmation time, inside the calculation's validity window, not at refund
   time;
2. `PERSIST_PROVIDER_TAX_TRANSACTION_REF`;
3. `REVERSE_PROVIDER_TAX_TRANSACTION_ON_REFUND`.

**The immutable economic snapshot is not touched, by this phase or that one.**
`0M.T1` gave `TransactionEconomicSnapshot` no update path; `1.2` added
`TransactionReversal` as new evidence *about* a snapshot rather than a correction
*of* one; a tax reversal is the same shape of fact — a new row, never an edit.

---

## 11. TEST / live separation

- `STRIPE_MODES` is **unchanged**: `["TEST"]`. Tax using Stripe does not widen
  it, and `TAX_PROVIDER_MODE_SELECTIONS` deliberately does not diverge from it —
  two mode vocabularies over one Stripe account would eventually disagree, and
  the disagreement would be a live charge from a deployment that believed it was
  in test.
- Tax reaches the Stripe account through the **same** credential resolver,
  extracted as `resolveTestModeSecretKey`, so the live-prefix refusal is enforced
  once. Tax does not get its own, weaker door.
- The adapter additionally refuses a `livemode: true` calculation — the
  **provider's own statement** about its object, which is what catches a
  deployment holding a live credential it believes is a test one.
- `liveTaxCommercePermitted` is `false` by construction and no configuration can
  make it true.

---

## 12. Operator readiness

```
npm run tax:readiness              # configuration + catalogue classification
npm run tax:readiness -- --no-db   # configuration only; opens no database
npm run tax:readiness -- --json    # machine-readable only
```

**Read-only.** No write, no configuration change, no provider call. The only
database access is one aggregate count of how much of the catalogue is
classified, and `--no-db` removes even that.

**It makes no tax calculation.** `1.2`'s live-readiness check proved the adapter
worked by performing one; with Stripe Tax selected that would mean a live API
call to a payment provider every time somebody ran a command documented as
read-only. `evaluateLiveCommerceReadiness` was changed for the same reason.

The narrowing is stated rather than glossed: a configuration check cannot prove
the engine answers. It proves the deployment has decided everything the engine
needs.

**No secrets, by construction.** The report contains variable *names*, booleans,
bounded codes, and counts. `evaluateTaxReadiness` checks a credential's presence
and prefix and returns neither.

### What it reports

provider selected · provider mode · production-capable · calculation configured ·
classifications mapped and unmapped · registration posture and completeness ·
filing posture · whether Monacado files (always `false`) · whether provider tax
transactions are recorded (always `false` in `1.6`) · whether live tax commerce
is permitted (always `false`) · catalogue classified/unclassified counts ·
env vars present and missing · blockers · satisfied controls.

### States

`CALCULATION_READY` · `PROVIDER_NOT_CONFIGURED` ·
`PROVIDER_CONFIGURATION_REQUIRED` · `PRODUCT_CLASSIFICATION_CONFIGURATION_REQUIRED` ·
`REGISTRATION_CONFIGURATION_REQUIRED` ·
`FILING_OR_REMITTANCE_CONFIGURATION_REQUIRED`, with
`LIVE_PROVIDER_NOT_ENABLED` always among the blockers.

Calculation readiness deliberately **excludes** registration and filing: a
deployment can be able to calculate correctly while still owing the compliance
decisions, and reporting them as one number would let clearing the easy half look
like clearing both.

### Live-commerce readiness

`evaluateLiveCommerceReadiness` gains three blockers:

- `TAX_PROVIDER_NOT_PRODUCTION_CAPABLE` — a test adapter returning a plausible
  number is **more** dangerous than no engine, because its answers look
  calculated;
- `TAX_REGISTRATION_CONFIGURATION_REQUIRED`;
- `TAX_FILING_OR_REMITTANCE_CONFIGURATION_REQUIRED` — collecting tax creates an
  obligation to remit it, and live commerce with nobody named as filer is a
  liability with no filer.

---

## 13. Privacy

- **No full billing address is logged.** Errors carry bounded codes, field names,
  and opaque Monacado identifiers. `TaxProviderRequestFailedError` deliberately
  discards the vendor's message, which can echo the request — and the request was
  about a buyer's address.
- **No address in evidence.** Only the bounded jurisdiction code and the
  `buyerSnapshotId` linkage.
- **No buyer tax or address information in any capsule.** The classification
  itself is excluded from the published capsule; buyer data never approached one.
- **No credential in configuration, evidence, logs, or the readiness report.**
  Configuration holds variable *names*.
- The postal code crosses to the engine and is persisted nowhere by this phase.
- **Only the ship-to address crosses per calculation.** The billing address never
  reaches the tax boundary at all; it belongs to the payment flow, which reaches
  Stripe by its own path.

---

## 14. Configuration reference

| Variable | Required | Meaning |
| --- | --- | --- |
| `MONACADO_TAX_ENABLED` | yes | master switch; anything but `true`/`1`/`yes` disables |
| `MONACADO_TAX_PROVIDER` | yes | `STRIPE_TAX` for production; `TEST_ZERO_RATE` / `TEST_FLAT_RATE` for local work |
| `MONACADO_TAX_STRIPE_MODE` | no | `TEST` only; any other value refuses |
| `MONACADO_TAX_API_KEY_ENV` | no | variable *name* holding the key; defaults to `MONACADO_STRIPE_SECRET_KEY` |
| `MONACADO_TAX_STRIPE_TAX_CODE_DIGITAL_GOOD` | per classification sold | provider tax code |
| `MONACADO_TAX_STRIPE_TAX_CODE_SOFTWARE` | per classification sold | provider tax code |
| `MONACADO_TAX_STRIPE_TAX_CODE_PHYSICAL_GOOD` | per classification sold | provider tax code |
| `MONACADO_TAX_STRIPE_TAX_CODE_SERVICE` | per classification sold | provider tax code |
| `MONACADO_TAX_STRIPE_SHIPPING_TAX_CODE` | no | shipping tax code; Stripe's Tax Settings default applies when unset |
| `MONACADO_TAX_CONFIG_VERSION` | no | mapping version label pinned onto evidence |
| `MONACADO_TAX_REGISTRATIONS_CONFIGURED` | yes, for live | operator statement |
| `MONACADO_TAX_REGISTRATION_CONFIG_REF` | yes, for live | where that decision is recorded |
| `MONACADO_TAX_FILING_POSTURE` | yes, for live | `PROVIDER_MANAGED` \| `OPERATOR_MANAGED` |

### There are no default tax codes, and that is deliberate

A provider tax code is a **fiscal determination about a specific business's
registrations**. A shipped default is that determination made by a repository on
behalf of a company it knows nothing about; wrong, it under-collects silently and
surfaces as an assessment years later.

Stripe publishes its tax code catalogue at
`https://stripe.com/docs/tax/tax-codes`. An operator — with its tax adviser —
**selects and verifies** the code for each Monacado classification and sets it
explicitly. A partial map is legitimate configuration: a deployment that sells
only software need not decide what its `PHYSICAL_GOOD` code would be. Selling a
classification it has not mapped is what refuses.

---

## 15. Internal retail tax policy

Recorded as a value — `MONACADO_RETAIL_TAX_POLICY` in `tax-calculation.ts` — so a
later reader can check what was claimed against what was built, and so a test can
assert that no exemption machinery quietly appeared.

**None of it is checkout copy.** This phase displays nothing new to a buyer. The
buyer-facing expression belongs in Marketplace Policy and Terms material, which is
a governed, versioned artifact — not something a tax module writes, and not
something added to an already-active policy version as a side effect of a tax
phase.

### What Monacado does

Calculates and collects applicable tax using the **ship-to jurisdiction** and the
governed Product classification and provider mapping. One rule, one source,
evidenced per transaction.

### What ordinary retail checkout does not do

**It does not accept buyer exemption credentials to reduce tax.** There is no
field for an exemption number, a VAT number, a resale certificate, a buyer
exemption state, or an approval workflow — not disabled ones, none.
`NEVER_A_TAX_EXEMPTION_INPUT` names the vocabulary and a test asserts every member
is refused by the request and the evidence.

Standard retail checkout is not a venue for adjudicating a buyer's tax status, and
a field that existed would imply Monacado had undertaken to verify what was typed
into it.

**A buyer whose own tax status entitles them to relief pursues it through the
applicable tax processes** — deduction, reclaim, or recovery — with the authority
concerned. The transaction evidence Monacado keeps is what such a process needs
from a seller.

### What remains possible

**Provider-determined non-taxability is ordinary and evidenced.** See §16.

**Corrections remain available.** Monacado or its providers may process
corrections, adjustments, refunds, reporting changes, or other actions required
where transaction tax is later determined to have been charged or reported
incorrectly, or where governing tax procedures require an adjustment. Stating that
is not a claim that any of it is implemented in this phase — refunds and reporting
are explicitly out of scope (§9, §10) — and **no wording here overrides applicable
law**.

---

## 16. Zero tax is a result, not a suspicion

A zero tax amount is valid whenever the governed provider calculation returns one
for the pinned Product classification and the ship-to jurisdiction. It is not
treated as anomalous merely because it is zero, and it reaches **no separate
buyer-exemption path** — because none exists.

What makes it evidence rather than an absence:

- the same `providerCalculationRef` any other amount carries;
- the same pinned Product source version, classification, and provider code;
- a `treatment` that says which kind of zero it was — `EXEMPT` where a regime
  applied and assessed nothing, `OUT_OF_SCOPE` where none applied. Collapsing the
  two would lose the more useful half.

`taxQuoteIsCoherent` requires a non-`TAXABLE` treatment to carry exactly zero, so
a zero is checked for coherence like any other result rather than waved through.

---

## 17. Migration

One additive migration:
`20260824120000_add_production_tax_classification_and_evidence`.

```sql
ALTER TABLE ProductSourceRecordVersionRow ADD COLUMN taxClassification VARCHAR(32) NULL;
ALTER TABLE OrderTaxEvidence ADD COLUMN providerMode …, productSourceRecordId …,
  productSourceRecordVersion …, productTaxClassification …, providerTaxCode …,
  providerConfigVersion …, providerCalculationExpiresAt … (all NULL);
CREATE INDEX OrderTaxEvidence_productSourceRecordId_productSourceRecordVe_idx …;
```

`ADD COLUMN` and `CREATE INDEX` only. Nothing dropped, nothing renamed, no column
narrowed, no committed migration modified, no existing row rewritten. Applied
against the disposable local MySQL at `127.0.0.1:3308` only.

---

## 18. Known behaviours an operator must decide about before live

1. **A destination with no registration refuses the sale.** Stripe returns a
   null-id calculation there, and Monacado will not charge on a calculation it
   cannot later evidence or reverse. The alternative — selling untaxed on an
   unreferenceable zero — was judged worse. If Monacado intends to sell into
   jurisdictions where it is not registered, this needs an explicit decision, not
   a silent default.
2. **Stripe Tax reports do not contain Monacado's sales** until provider-side Tax
   Transactions are recorded (§9, §10).
3. **Sourcing is ship-to, and not exhaustive.** Origin sourcing,
   marketplace-facilitator rules, and VAT place-of-supply for digital services
   remain the engine's to apply from the facts supplied.
5. **Multiple ship-to destinations are not implemented.** One transaction, one
   destination; split shipments need their own governed design.
4. **Per-product provider overrides do not exist.** The mapping is per
   classification. A deployment needing finer granularity than four
   classifications must add a governed Monacado-authority record for it — not a
   Stripe code in Product facts.

---

## Reference

- [`PRE_LIVE_COMMERCE_CONTROLS.md`](PRE_LIVE_COMMERCE_CONTROLS.md) — the `1.2`
  boundary this phase fills in
- [`EXECUTABLE_CHECKOUT_AND_STRIPE_TEST_MODE.md`](EXECUTABLE_CHECKOUT_AND_STRIPE_TEST_MODE.md)
- [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md)
- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
