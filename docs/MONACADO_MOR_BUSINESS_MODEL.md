# Monacado Merchant-of-Record Business Model

**Status:** authoritative commercial and operational architecture reference.

This document is not developer documentation. It is the governing description of
how Monacado transacts commercially, written to be read by regulatory, tax,
audit, investor-diligence, payment-processor underwriting, card-network review,
legal, and engineering audiences.

It describes **Monacado's own commercial architecture**. Where a comparable
industry model exists, it is noted as commercial precedent only. **No claim of
legal or regulatory equivalence to any other operator is made or implied.** The
formal architecture is the **Monacado MoR wholesale-acquisition model**.

---

## A. Monacado's role

Monacado operates as:

- **the retailer** in the buyer-facing transaction;
- **the Merchant of Record (MoR)** for that transaction;
- **the buyer's commercial counterparty** — the buyer purchases from Monacado;
- **the operator of the wholesale-acquisition model** described below.

Monacado is not modelled as an agent collecting a fee on someone else's sale. It
acquires the item and resells it. That distinction drives everything that
follows, and it is why there is no separate "platform fee" anywhere in the
economics.

This document describes commercial architecture. It does not constitute legal,
tax, or regulatory advice, and it makes no guarantee about how any authority will
characterise the arrangement.

---

## B. Current wholesale-acquisition policy

The current standard policy:

> **Monacado standard wholesale acquisition amount = 92.5% of the applicable
> commercial retail price − $1.00**

Stated as retained economics — the same arrangement seen from the other side:

> **Monacado retained amount = 7.5% of the applicable commercial retail price
> + $1.00**

Worked example:

| | Amount |
| --- | --- |
| Commercial retail price | $100.00 |
| Monacado retained amount (7.5% + $1.00) | $8.50 |
| **Wholesale acquisition amount** | **$91.50** |

**This is the current standard policy, not a permanent rule.** It is:

- **versioned** — every calculation records the `policyId` and `policyVersion`
  it was produced under, so a historical transaction remains reproducible after
  the policy changes;
- **supplied to calculations**, never embedded in them — no rate or fixed amount
  is compiled into the Listing source model, and an automated test enforces that;
- **changeable by Monacado** as a commercial decision;
- **replaceable per transaction** by a different or risk-adjusted policy through
  `0M.R` (§J).

Arithmetic is integer minor units with deterministic half-up rounding to the
minor unit. No floating-point money is used anywhere.

---

## C. Seller-direct transaction

A seller places their own product in their own storefront and sets the price.

```
buyer pays commercial retail price          R
Monacado retains                            retained(R)
Monacado acquires the item for              A = R − retained(R)
seller receives                             A
```

At the current standard policy and $100.00: Monacado retains $8.50 and the
seller receives $91.50.

### Seller-only temporary sales

A seller may schedule a temporary sale on their own direct listing: a lower
price, a start instant, and an end instant. During that window the **sale price
becomes the commercial retail basis**; outside it, the ordinary price does. The
ordinary price is never overwritten — it is what the listing returns to.

Timing is UTC, with the start **inclusive** and the end **exclusive**, so two
consecutive sales cannot both be active for the instant they touch.

A seller's sale is **isolated**. It does not change any wholesale term, does not
create a new Offer version, does not alter any promoted listing's economics, and
creates no acknowledgement, review, or notification obligation toward a promoter.

---

## D. Promoted transaction

A promoter resells another party's product under an Offer, at a retail price the
promoter controls. Three parties and three layers meet.

**Roles**

| Party | Role |
| --- | --- |
| Buyer | purchases from Monacado |
| Monacado | retailer and Merchant of Record; acquires at the moment of sale |
| Seller (creator) | supplies the product; contracted an Offer wholesale price |
| Promoter | controls the buyer-facing retail price; earns the spread and any seller-funded commission |

**Economics**

```
monacadoRetained     = retained(R)
acquisition      A   = R − retained(R)

sellerProceeds       = offerWholesalePrice − sellerFundedCommission
promoterRetailSpread = A − offerWholesalePrice
promoterNetProceeds  = promoterRetailSpread + sellerFundedCommission
```

The reconciliation identity holds exactly, and is enforced at runtime:

```
sellerProceeds + promoterNetProceeds + monacadoRetained = R
```

Worked example — $100.00 retail, $50.00 Offer wholesale, $10.00 seller-funded
commission, current standard policy:

| Party | Amount |
| --- | --- |
| Monacado retained | $8.50 |
| Monacado acquisition amount | $91.50 |
| Seller proceeds ($50.00 − $10.00) | $40.00 |
| Promoter retail spread ($91.50 − $50.00) | $41.50 |
| Promoter net proceeds ($41.50 + $10.00) | $51.50 |
| **Total to buyer's commercial price** | **$100.00** |

### Two different "wholesale" amounts, deliberately named apart

| Term | Meaning |
| --- | --- |
| **Offer wholesale price** | The fixed amount the seller contracted to be owed. Seller-set. The basis for the seller-funded promoter commission. |
| **MoR wholesale acquisition amount** | What Monacado pays the supply side, derived from the buyer-facing retail price. The pool the seller and promoter are paid from. |

They are different economic layers and are never called by the same name in code
or in documentation.

**Monacado's retention is taken exactly once**, inside the acquisition amount.
The promoter is **not** additionally charged a platform fee.

### Promoter compensation has two components — by design

This is a **settled commercial ruling**, not an artefact of the arithmetic. On a
promoted transaction the promoter may earn **both**:

1. the **seller-funded Offer commission**, and
2. the **promoter retail spread**.

```
promoterNetProceeds = morWholesaleAcquisitionAmount
                    − offerWholesalePrice
                    + sellerFundedCommission
```

The two components answer to different parties and move independently:

- **The Offer commission is based exclusively on Offer wholesale economics.** The
  seller sets it, funds it out of the amount they contracted to be owed, and it is
  computed from the Offer wholesale price — never from retail. A promoter cannot
  change it.
- **The retail spread is the promoter's own.** Raising or lowering the retail
  price changes the spread, and therefore the promoter's total compensation. It
  **does not** change the Offer commission, amend the Offer, or alter the
  seller's contracted economics in any way.

Consequently a promoter who raises their price earns more; a seller who offers a
richer commission gives the promoter more; and neither decision reaches into the
other party's number.

**The retail-derived effective margin rate is never the contractual Offer
commission rate.** They are separate figures with separate bases — the margin
rate is presentational and derived from retail, the commission rate is
contractual and derived from Offer wholesale. Conflating them in an interface, a
report, or a settlement statement would misstate what the seller agreed to.

### Constraints

- A promoter's retail price must not produce **negative promoter net proceeds**.
  Zero is permitted; below zero is refused.
- A promoter's retail-price change **never** amends the Offer, changes the
  wholesale price, or alters the seller's contracted economics.
- A promoted listing binds to **one exact Offer source-record version**. A
  material upstream change (wholesale price or commission terms) puts the listing
  into a review-required state and stops it selling until the promoter
  **explicitly accepts** the new version. Acknowledgement alone never reactivates.

### Deferred

Settlement mechanics — *when* and *how* each party is actually paid, in what
order, on what schedule, and against what ledger — are **not established by the
current contracts**. They belong to `0M.T` and `0M.9`. This document describes
what each party is economically entitled to per sale, not the payment operation.

---

## E. Digital goods

Under the MoR relationship, digital products are acquired by Monacado at the
moment of sale on the same terms and delivered to the buyer under Monacado's
retail relationship. Delivery mechanics, entitlement, licensing, and access
control are not designed or implemented in the current phase.

---

## F. Physical goods — JIT Monacado Inventory

For eligible shipped physical goods, Monacado uses **JIT Monacado Inventory**:

> **Just-In-Time economic inventory acquisition with direct supplier
> fulfillment.**

```
buyer purchases from Monacado
  → Monacado acts as retailer and Merchant of Record
  → Monacado economically acquires the product at the time of sale under the
    applicable wholesale-acquisition policy
  → the seller / manufacturer / supplier fulfills directly to the buyer on
    Monacado's behalf
```

Key clarifications:

- Monacado **need not warehouse** the product.
- Monacado **need not take physical possession** of it.
- **Commercial acquisition and physical custody are distinct concepts.**
  Acquisition is an economic event at the moment of sale; custody is a logistics
  arrangement. JIT inventory means the former, never the latter.
- The seller or manufacturer remains the **fulfillment party** unless a different
  fulfillment arrangement is defined later.
- **Shipping is not part of the wholesale-acquisition basis** (§G/§H).

The **same standard policy** applies to eligible physical goods — 92.5% − $1.00
unless a different versioned policy is supplied. There is deliberately **no
separate physical-goods rate**, and the source model has no product-kind or
fulfillment-type input through which one could be selected.

No inventory, fulfillment, shipping, tracking, or warehouse system is implemented
in the current phase.

---

## G. Taxes

Acting as Merchant of Record creates transaction-tax responsibilities that sit
with Monacado rather than with the seller. Those responsibilities will be
discharged by a later tax and compliance architecture (`0M.T`); no tax engine
exists today.

Recorded now as binding architectural boundaries:

- Applicable tax is **added or included at checkout**, per the eventual tax
  architecture.
- Tax is **outside** the wholesale-acquisition basis. It does not increase
  Monacado's retained percentage or fixed economics.
- Tax is **outside** commission and promoter-margin bases.
- Customer tax and location evidence is **private operational data**. It does not
  become public capsule content.

---

## H. Shipping

- Shipping may be charged separately from the commercial price.
- Actual shipping cost may depend on fulfillment details known only at
  fulfillment time.
- Shipping is **outside** the wholesale-acquisition basis and outside commission
  and promoter-margin bases.
- A future Order and fulfillment architecture will snapshot the shipping charged
  and the fulfillment evidence for each transaction.

The checkout decomposition, for the avoidance of doubt:

```
checkout total = commercial price + applicable tax + shipping + permitted pass-through
```

Only **commercial price** is the economic base for retention, acquisition,
commission, and margin.

---

## I. Returns, refunds, and chargebacks

As Merchant of Record, Monacado is the party to the buyer's payment
relationship, and therefore the party to returns, refunds, and chargebacks.

These require a transaction-accounting policy covering at minimum: reversal of
retained amounts, recovery from seller and promoter economics, partial refunds,
post-fulfillment returns of physical goods, and chargeback representment
evidence.

**That policy is not designed here.** It belongs to `0M.T`.

---

## J. Risk

**0M.R — Risk Management and Commercial Controls** is the phase that owns
risk-adjusted commercial controls.

0M.R may supply a **higher, lower, or otherwise different effective
wholesale-acquisition policy** for a given transaction, participant, or product
class, through the same versioned policy input the economics already consume. It
may also add controls beyond pricing.

Nothing beyond that relationship is designed or enumerated here. Risk
classifications and the evidence behind them are **private operational data** and
must never become public capsule facts.

---

## K. Authority and privacy

- **Authoritative database records are transactional truth.** Every commercial
  fact above lives in a governed relational record.
- **Capsules are one-way semantic projections.** A capsule never supplies,
  repairs, or overrides a transactional record, and never writes back.
- **Private payment, risk, tax, underwriting, profile, and fulfillment-contract
  data does not become public capsule content.**
- **This document is operational and commercial governance documentation. It is
  not a capsule** and is not published as marketplace semantics.

---

## L. Governance

**Material changes to any of the following require a corresponding update to this
document — and to the applicable architecture decisions — before or together with
implementation:**

- the Merchant-of-Record role;
- the wholesale-acquisition formula;
- the fee or retention basis;
- seller or promoter economic responsibility;
- the JIT Monacado Inventory model;
- tax treatment;
- shipping treatment;
- fulfillment responsibility;
- settlement architecture;
- risk-policy application.

A change to any of these that reaches code without reaching this document is a
defect, not an implementation detail. This is the record that regulatory, tax,
audit, underwriting, and diligence review will be conducted against.

---

## Reference

- [`LISTING_SOURCE_MODEL.md`](LISTING_SOURCE_MODEL.md) — where these economics are encoded
- [`AUTHORITATIVE_OFFER_SOURCE_MODEL.md`](AUTHORITATIVE_OFFER_SOURCE_MODEL.md) — Offer wholesale price and seller-funded commission
- [`AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md`](AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md)
- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
- [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) — binding ADR
- [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md) — `0M.R`, `0M.T`
