# Marketplace Refund Policy Governance and the Receipt Contract (Phase 1.10)

`1.9` built the machinery that returns a buyer's money and settled every rule
governing it — who declares the terms, which version governs a purchase, what
happens to shipping, what happens to a promoter's commission. It then
deliberately **did not write any of it into the Marketplace Policy**, because
version 1.0.0 was `ACTIVE` and already accepted, and editing an accepted document
in place is the one thing a governance model exists to make impossible. The
requirement was recorded in `REQUIRED_MARKETPLACE_POLICY_NEXT_VERSION` instead.

**This phase is that version, plus the receipt that states it to a buyer.**

Nothing about refund mechanics changed. No new refund behaviour, no disputes, no
payouts, no live Stripe, no filing, no basket. What changed is that the rules are
now *governed text a participant can be shown*, and a purchase receipt now
carries the terms that actually applied to that purchase.

---

## 1. Marketplace Policy version 1.1.0

`MONACADO_MARKETPLACE_POLICY_V1_1`, in
[`marketplace-policy-content.ts`](../src/contracts/marketplace/marketplace-policy-content.ts).

| | |
| --- | --- |
| Prior version | `1.0.0` — `ACTIVE`, unchanged, `sha256:e50e8771…43cb85` |
| New version | `1.1.0` — recorded `DRAFT` |
| Content ref | `marketplace-policy/1.1.0` |
| Content hash | `sha256:b0a48644c8c146e2247d20de20140f6e124435401cad1ce096140ca5128e74b6` |
| Audiences | `SELLER`, `PROMOTER`, `BUYER` |
| Reacceptance | **required** — it adds obligations a seller and a promoter did not previously undertake |
| Activation prerequisite | an operator activation, deliberately not performed here |

### It is a complete document, written out in full

1.1.0 does **not** compose itself from 1.0.0's sections, and the duplication is
the point. Sharing paragraph constants between two versions would mean that an
edit to a shared paragraph silently changes 1.0.0's bytes — and therefore its
derived hash, and therefore what every participant who accepted 1.0.0 is recorded
as having accepted. A version is a document, not a diff. A test asserts that the
two versions share no section object and that 1.0.0's hash is exactly what it
always was.

### What changed

| Section | Disposition |
| --- | --- |
| `REFUNDS_AND_CANCELLATION` | **new** — the marketplace-level refund rules |
| `REFUND_REQUESTS` | **new** — how a refund is asked for, without an account |
| `PURCHASE_RECEIPTS` | **new** — what a receipt states, and what it never substitutes |
| `REFUND_EFFECT_ON_PROCEEDS` | **new** — proceeds and commission after a refund |
| `SELLER_RESPONSIBILITIES` | extended — refund policy, support contact, honouring the bound version |
| `PROMOTER_RESPONSIBILITIES` | extended — commission is conditional; the promoter sets no refund terms |
| `BUYER_CHECKOUT_INFORMATION` | extended — the seller's policy is disclosed before purchase |
| everything else | verbatim from 1.0.0 |

The four new keys are additive members of `POLICY_SECTION_KEYS`. Adding them does
not touch 1.0.0's bytes: 1.0.0 carries none of those sections, and
`selectRefundGovernanceSections` returns `[]` for it — which is the honest answer
for a version that does not state this governance, and is never filled in from a
newer one.

---

## 2. The authoritative refund rules

### The seller declares; Monacado enforces the bound version

Every seller must maintain a declared refund policy stating whether refunds are
available, the eligibility conditions, any request window, how shipping is
treated, the request procedure, and the support contact for refund requests. The
seller owns those commercial terms subject to marketplace policy and applicable
law; Monacado does not author them.

A purchase is governed by the **exact version bound to the Order at checkout**.
Later publication of different terms does not change a completed purchase, and
the receipt for that purchase goes on showing the terms that governed it.

### The refund unit is a whole line, not a whole Order

> A refund returns one or more complete lines of an order. Every line included is
> returned in full, and lines that are not included are unaffected — so a refund
> may be partial with respect to an order while being complete with respect to
> every line it covers.

Refunding part of the value of a single line is not supported. Where an Order
presently contains one line, refunding it is also a refund of the whole Order —
and the policy says explicitly that this is **a consequence of how orders are
currently composed, not a rule that a refund must cover an entire order**.

A test asserts across every audience's rendering that no phrasing anywhere reads
as "whole Orders only".

### Shipping

Refundability of the buyer's shipping charge is governed by the seller policy
applicable to the purchase. Monacado does **not** return all shipping as a matter
of course, does **not** retain all shipping as a matter of course, and does
**not** apportion a shipping charge across part of an order.

Where a refund would cover only some lines of an order whose shipping was charged
once for a single delivery, the policy states that the apportionment is a
commercial question rather than an arithmetic one, and that Monacado may require
it to be settled under this policy before executing such a refund. That is
`SHIPPING_ALLOCATION_SEAM`'s refusal, stated to the parties it binds rather than
only to the codebase.

### Tax

Tax on refunded merchandise is corrected or reversed through Monacado's tax
process and the mechanisms its tax provider makes available, to the extent a
correction applies. **No jurisdiction-specific outcome is promised**, and no
provider is named in buyer-facing prose — a test asserts against `stripe`,
`payment_intent`, and the rest.

### Proceeds and commissions

Stated in commercially understandable terms, with no internal record or table
named:

- amounts attributable to refunded merchandise that are **unpaid cease to be
  payable** — seller proceeds and promoter commission alike;
- amounts already paid, or already payable, **may be recovered, set off against
  future amounts, or reflected as an account-balance adjustment** under
  Monacado's settlement rules;
- **a refund does not erase a payment that was made**; what was earned and paid
  stays recorded, and the refund is a further fact about the sale.

A promoter's commission is conditional on the sale remaining economically valid.
The policy is explicit that a promoter neither sets the seller's refund terms nor
decides a refund, and is not responsible for the seller's refund decisions.

### Legal posture

Operational throughout. Buyer statutory rights are **not displaced** by a
seller's declared terms; Monacado retains merchant-of-record authority to execute
or decline a refund consistent with the applicable policy, applicable law, and
provider requirements; Monacado may correct its own payment, tax, and accounting
records. What those statutory rights are, and where, is not stated — no governing
law, no jurisdiction, no consumer-law guarantee, and no percentage figure appears
anywhere in the document.

---

## 3. Audience renderings

There is still exactly one projection. `selectSectionsForAudience` is unchanged,
and `selectRefundGovernanceSections` **filters that function's output** rather
than running a second selection — so a section a party may not see in full is a
section they may not see in the narrow view either.

| Audience | Refund sections shown |
| --- | --- |
| `SELLER` | `REFUNDS_AND_CANCELLATION`, `REFUND_REQUESTS`, `PURCHASE_RECEIPTS`, `REFUND_EFFECT_ON_PROCEEDS` |
| `PROMOTER` | `REFUNDS_AND_CANCELLATION`, `REFUND_EFFECT_ON_PROCEEDS` |
| `BUYER` | `REFUNDS_AND_CANCELLATION`, `REFUND_REQUESTS`, `PURCHASE_RECEIPTS` |

Plus the audience-specific obligations in `SELLER_RESPONSIBILITIES` and
`PROMOTER_RESPONSIBILITIES`.

---

## 4. Refund initiation without an account

The policy states that a Monacado account is **not required** to request a
refund, that a guest identifies the purchase with the order reference and the
purchase confirmation issued at checkout, and that Monacado does not require an
account to be created after a purchase in order to ask for money back. That is
`1.9`'s `GUEST_REFUND_INITIATION` — the claim-code digest comparison, nothing
minted, no Account fabricated — stated to buyers rather than only recorded as a
constant.

The receipt carries the same statement and the procedure to follow.

---

## 5. The receipt

### One read

[`OrderReceiptView`](../src/contracts/marketplace/order-receipt.ts) and
`readOrderReceipt`. `1.3` shipped the marketplace half, `1.9` the seller half;
assembling a receipt still meant knowing which three services to ask and which of
their answers were historical. This is the single answer.

```
OrderReceiptView
  ├── money        the Order's four quoted amounts, and the derived total
  ├── lines        the exact Listing/Product the Order bound
  ├── shipping     what was charged, and whether the BOUND policy returns it
  ├── refund       1.9's OrderRefundReceiptView, embedded whole
  ├── marketplace  the refund rules from the MARKETPLACE version the Order bound
  └── seller       the participant, and (in refund) the contact frozen at purchase
```

### One clock per fact

| Fact | Time semantics |
| --- | --- |
| monetary summary | the Order's quote — what the buyer was charged |
| seller refund terms | the version **bound at checkout** |
| marketplace refund rules | the version **bound at checkout** |
| refund support contact | **frozen at purchase** on `OrderRefundContactEvidence` |
| the seller's contact today | resolved now, named separately, never a substitute |

Nothing on a receipt reads a seller's current configuration except the one field
explicitly named as current. An Order bound to marketplace version 1.0.0 shows
1.0.0's refund governance — which is **none** — rather than 1.1.0's.

### What is absent, and why

- **No promoter.** Monacado is the merchant of record and is the buyer's
  counterparty. `PROMOTER_ON_BUYER_RECEIPT = "NOT_INCLUDED"`.
- **No economics.** No retained amount, proceeds, spread, or commission.
- **No buyer identity.** `NEVER_ON_ORDER` forbids it upstream; the receipt does
  not reintroduce it.
- **No fields added because they exist internally.** `NEVER_ON_RECEIPT` names
  what is refused, and every member is asserted refused by the schema.

### The renderer

`renderBuyerConfirmation` — `1.1`'s buyer confirmation, extended rather than
replaced. Given a receipt view it carries the monetary breakdown (tax stated even
at zero), the exact seller policy version reference, **the complete governing
policy**, the procedure, and the contact disclosed at purchase. The seller's
current contact appears beside it, under its own heading, **only when it
differs**.

`receipt` is optional. A receipt that cannot be assembled still produces the
confirmation a buyer needs most — withholding it because its refund section
failed would deny them the fact they actually want. The dispatcher's resolver
assembles it on every attempt from evidence bound to the sale, so a retry three
days later renders the terms the buyer was shown.

The marketplace document's refund sections are **referenced by the bound version**
rather than inlined; the seller's are inlined in full, because they are the
buyer's operative terms. `RECEIPT_EMAIL_RENDERING` records that split.

`1.1`'s line holds: the message names no participant, no promoter, no product
title, no commercial policy id, and no economics. The one thing added is the
buyer's own disclosed terms.

---

## 6. Checkout integration

`readCheckoutRefundDisclosure` — the smallest addition that lets a checkout
surface show everything at once, and **no second source of truth**:

- the seller half **is** `readListingRefundPolicyDisclosure`, called;
- the marketplace half is the `ACTIVE` version's own buyer-facing refund
  sections, hash-verified against the source by `readActiveMarketplacePolicy`;
- the `binding` block is the identity of those same two reads, so "the policy I
  was shown" and "the policy that governs my purchase" are the same object rather
  than two reads that happened to agree.

An integration test drives a disclosure and then a real checkout, and asserts the
Order binds exactly the versions the disclosure named.

Checkout itself is unchanged. `saleRefusedWithoutBinding: true` is a literal,
because `1.9` already refuses a sale it cannot bind.

---

## 7. Publishing the version

The existing operator path, extended by the smallest amount that lets it publish
a second version.

```
npm run policy:bootstrap                       # record the newest shipped version as DRAFT
npm run policy:bootstrap -- --version=1.1.0    # or name one explicitly
npm run policy:bootstrap:inspect               # read and report; write nothing
```

Three changes to `marketplace-policy-bootstrap.ts`:

1. **`policyVersion` selects which shipped version**, defaulting to the newest. A
   version this deployment does not ship is `SHIPPED_VERSION_UNKNOWN` (and a
   usage error in the command), never a silent fallback — an operator typing a
   version is stating which terms they mean to publish.
2. **Recording a `DRAFT` beside a standing `ACTIVE` version is permitted.** The
   `CONFLICTING_ACTIVE_VERSION` refusal is now gated on `activate`. A `DRAFT`
   governs nobody — no participant accepts it, no checkout binds it, nothing
   reads it — and it is precisely how the next governed version comes into
   existence. The refusal exists to stop a command retiring live terms by
   accident, which a `DRAFT` cannot do; extending it to cover recording made the
   supported publish-then-activate path unreachable through the only tooling that
   has one. **Activating over a standing version is still refused.**
3. `requiresReacceptance` is read from the shipped registry rather than
   hard-coded, so the judgement belongs to whoever published the version.

The outcome gained `standingActiveVersion` (reported on every outcome, so an
operator can see which terms still govern while a `DRAFT` sits there) and
`requiresReacceptance`. `contentRef` and `sourceHash` became nullable for the
unknown-version refusal, where there is no document to name or hash.

### Activation state

**1.1.0 is `DRAFT`. No activation was performed, in any environment.**

Activating it retires 1.0.0 and starts governing live participants and live
sales, and the repository treats that as a separate, deliberate operator act —
`policy:bootstrap:activate`, plus `--confirm-production` for a production target,
because "yes, write to production" and "yes, govern live sellers with these
terms" are different answers. `requiresReacceptance: true` means adopting it
obliges participants to accept again, which is a rollout with consequences for
every activated seller and promoter.

The one activation this phase performs at all is inside the disposable local
database, in one integration test that proves the marketplace refund rules reach
a checkout disclosure and a receipt once the version stating them governs. That
test restores 1.0.0 and deletes the 1.1.0 row afterwards.

---

## 8. Migration

**None.** No schema change, no migration, and no backfill. `1.9` already
persisted everything a receipt needs: the seller refund-policy binding, the
frozen support contact on `OrderRefundContactEvidence`, and the marketplace
policy binding `1.3` added before it.

---

## 9. Two gaps found, recorded rather than papered over

Both are stated as data in `order-receipt.ts` so they are checkable, and neither
was closed with schema in this phase.

### There is no authoritative seller display name

`SELLER_DISPLAY_NAME_GAP`. A participant has an admission status, roles, a
profile of completion markers, and an account email — no trading name, no legal
name, no public label, anywhere in the repository. Two substitutions were
considered and refused:

- a **Storefront name** names the shop the sale happened in, which on a promoted
  Listing is the promoter's, not the seller's;
- an **account address** is not a trading name.

So `seller.displayName` is `null` by type, and what a receipt honestly says about
the seller is the marketplace identity and the support contact that was disclosed
to the buyer.

### There is no purchase-time product description

`RECEIPT_LINE_DESCRIPTION_GAP`. The Order binds an exact
`ListingSourceRecordVersion`, which carries placement and commercial terms and
**no product title**. Product descriptive facts are versioned separately and the
Order binds none of those versions — `Product.currentSourceRecordVersion` is a
mutable pointer. Reading a title now would read whatever the seller's Product
says *today*, which is the substitution this whole phase exists to refuse.

So a receipt line carries references, and `description` is `null`. **This cannot
be closed retrospectively**: a Product source version has to be bound to an Order
at the moment of sale or the description that applied is gone. It is required of
whichever phase implements `OrderLine` / basket checkout, alongside the
line-level tax evidence `1.9` recorded under the same constraint.

---

## 10. What this phase did not do

No refund mechanics changed. No disputes or chargebacks, no payout or clawback
execution, no live Stripe, no filing or remittance, no basket persistence, no
sub-line refunds.

**No AgentNet publication.** Marketplace Policy may eventually have a public
semantic representation; this phase publishes none, projects no capsule for one,
and leaves `SellerRefundPolicy` and historical Order evidence as the
authoritative records. A capsule never becomes policy authority.

**No production network or provider write.** Every provider port in the tests is
an injected double.

---

## Reference

- [`REFUNDS_AND_TAX_REVERSALS.md`](REFUNDS_AND_TAX_REVERSALS.md) — the mechanics
  this governs
- [`MARKETPLACE_POLICY_ACCEPTANCE_AND_SUPPORT_CONTACTS.md`](MARKETPLACE_POLICY_ACCEPTANCE_AND_SUPPORT_CONTACTS.md)
  — the versioning model reused unchanged
- [`POLICY_BOOTSTRAP_AND_VERIFICATION_EMAIL_DELIVERY.md`](POLICY_BOOTSTRAP_AND_VERIFICATION_EMAIL_DELIVERY.md)
  — the operator path extended here
- [`PRODUCTION_COMMUNICATIONS_AND_NOTIFICATION_DELIVERY.md`](PRODUCTION_COMMUNICATIONS_AND_NOTIFICATION_DELIVERY.md)
  — the delivery the receipt rides on
