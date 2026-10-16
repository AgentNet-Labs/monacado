# Product Completeness Profile

**Status:** GOVERNING DETAIL for the domain **Product completeness**, incorporated
by [`MONACADO_PROJECT_CONTRACT.md`](MONACADO_PROJECT_CONTRACT.md) §9.1 and
classified in [`DOCUMENT_AUTHORITY.md`](DOCUMENT_AUTHORITY.md) §3.
**Installed:** Documentation Governance 2D, against `main` at `71eb92f`.
**Governs:** which Seller-authoritative facts must be present and valid for a
Product to be content-complete, and how those requirements are versioned.
**Does not govern:** Product lifecycle states and transitions, activation,
suspension, or reinstatement — those remain Contract §9.1–§9.2.

This document states rules. It does not claim that any rule is implemented.

---

## 1. What completeness answers

Product completeness answers exactly one question:

> **Does this Product contain the minimum authoritative Product content required
> to be considered fully defined?**

It is the content input to the Contract §9.1 lifecycle: a Product whose content
is not complete is `INCOMPLETE`; a Product whose content is complete is eligible
to be `COMPLETE` or, through the separate rules of §9.1–§9.2, `ACTIVE` or
`SUSPENDED`.

Completeness **does not** answer, and must never be used to answer:

- whether the Seller is underwritten or otherwise commercially ready;
- whether the Product may transact;
- whether tax readiness is complete;
- whether the Product is listed or placed;
- whether resale is enabled (Contract §9.3);
- whether a Storefront exists (Contract §11).

Each of those is a separate fact with its own authority.

## 2. Seller-authoritative facts only

**Product completeness is determined only from Seller-authoritative facts that
the Seller is expected to provide.** Completeness measures whether the Seller has
finished defining the Product; it is therefore something the Seller can always
reach by supplying their own facts.

**Monacado-authoritative operational facts never determine completeness.**
Excluded, among others:

- tax classification (§5.2) and tax calculation;
- payment and risk controls;
- Monacado underwriting, approval, and activation decisions;
- any other Monacado operational classification.

These may still be **activation or commerce-readiness gates** under Contract §5,
§8, and §9.2. A Monacado operational fact may block `ACTIVE` commerce; it never
makes a Product `INCOMPLETE`.

## 3. Derivation

- Completeness is **derived, never declared** (Contract §9.1). It is computed
  from the Product's **authoritative Seller-supplied facts** against the
  **applicable completeness-profile version** (§6).
- There is **no Seller-controlled or operator-controlled "complete" flag**, and a
  request to be complete cannot make a Product complete while a required fact is
  missing or invalid.
- The Product facts evaluated are those of the Product's **current authoritative
  source version** — the immutable `ProductSourceRecordVersionRow` its stable
  record currently points at — never a capsule, a publication, or a
  caller-supplied copy of the facts (Contract §3).

## 4. `PRODUCT_COMPLETENESS_V1`

The initial completeness profile.

### 4.1 Required facts — every Product

| Fact | Requirement |
| --- | --- |
| `name` | Present, and valid under the existing authoritative validation rules for the Product `name` fact. |
| `description` | Present, and valid under the existing authoritative validation rules for the Product `description` fact. |
| `deliveryMode` | Present, and valid under the existing authoritative validation rules for the Product `deliveryMode` fact (a member of the governed delivery-mode vocabulary). |

### 4.2 Conditional requirement — Seller-shipped Products

| Condition | Requirement |
| --- | --- |
| `deliveryMode` indicates that the **Seller is responsible for physical shipment** | The Product has an **explicit Seller shipping policy** (§5.1). |

- A valid shipping policy may be:
  - **`FREE`** — explicit free shipping;
  - **`FIXED`** — a fixed shipping charge; or
  - a **governed calculated / rate-based method** that the platform supports
    later, once that method is itself governed.
- **`FREE` is valid.** Completeness never requires a shipping charge greater than
  zero.
- **A missing policy is not free shipping.** An explicit `FREE` policy satisfies
  the requirement; the absence of any policy does not. Absence is never read as,
  or defaulted to, `FREE`.
- Under the current delivery-mode vocabulary (`DIGITAL` | `PHYSICAL`), a
  `PHYSICAL` Product is Seller-shipped, because the Seller remains the
  fulfillment party unless a different fulfillment arrangement is defined
  ([`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md) §F). Any
  future arrangement in which the Seller is not responsible for shipment must be
  governed separately, together with its completeness consequence.
- **Where `deliveryMode` does not require physical shipment, no shipping policy
  is required for completeness.**

### 4.3 Evaluation

- **A required fact (§4.1, or §4.2 where it applies) that is absent, blank, or
  invalid makes the Product `INCOMPLETE`.** "Blank" includes a text value that is
  empty or consists only of whitespace.
- **Absence is never defaulted.** A source version written before a required
  fact existed (for example a version with no `deliveryMode`) does not satisfy
  the requirement.
- The profile requires **all** applicable facts. There is no partial
  completeness.

### 4.4 Optional facts

Not required for completeness under V1:

- image / media;
- specifications;
- capabilities;
- any other optional descriptive Product fact.

Their absence never makes a Product `INCOMPLETE` under V1. Where present they
remain subject to their own existing validation rules, which this profile does
not change.

### 4.5 No category-specific requirements

V1 defines **no** category- or type-specific requirements. The only conditional
requirement is the Seller-shipping rule (§4.2), which follows from delivery
responsibility rather than category.

## 5. Authority boundaries

### 5.1 Shipping: Seller shipping policy versus transaction shipping amount

Two different facts, with different authorities and different homes:

| | **Seller shipping policy** | **Transaction shipping amount** |
| --- | --- | --- |
| What it is | The rule the Seller sets for how shipping is charged on this Product — e.g. `FREE`, `FIXED`, or a later governed calculated / rate-based method | The shipping amount actually charged on one particular Order |
| Authority | **Seller-authoritative fulfillment fact** | **Transaction economics** |
| Belongs to | The **authoritative Product source model** — the Product's current source version | The **Order / transaction snapshot**, where it is **frozen** |
| Product semantic truth? | **Yes** — Product semantic truth may own it | **No** |
| Required for completeness? | Yes, for Seller-shipped Products (§4.2) | Never |

- **The Seller is responsible for fulfillment and shipping** of Seller-shipped
  Products, and **controls the shipping policy**.
- **The transaction shipping amount is derived at checkout** from governed
  inputs — the Seller's shipping policy, the destination, the quantity, and any
  other governed input — and the resulting amount is **frozen on the Order /
  transaction snapshot**. A later change to the Seller's shipping policy never
  changes an amount already frozen.
- **Neither is a Monacado tax fact or payment-authority fact.**
- **Shipping remains outside Monacado fee and commission bases** under current
  governing economics (Contract §17;
  [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md) §H) unless
  future policy explicitly changes that.
- **Source-model placement (intended architecture).** Because completeness is
  derived from the Product's current authoritative source version (§3), the
  Seller shipping policy belongs in the authoritative Product source model and
  is carried by the Product's source versions. The realized transaction shipping
  amount does not belong there.
- This document **does not design** the schema, record shape, vocabulary
  encoding, carrier / rate / zone / weight mechanics, checkout derivation, or
  whether or how the shipping policy is projected into a published capsule.

### 5.2 `taxClassification`

- **`taxClassification` is Monacado-authoritative operational data** — a fiscal
  control fact, not a Seller-authoritative Product fact.
- **It is not a Seller completeness requirement.** A Product may be `COMPLETE`
  while its tax classification is unresolved.
- Where tax classification is required for activation or commerce, **it may block
  `ACTIVE` commerce, but it must never change a Product from `COMPLETE` to
  `INCOMPLETE`.**
- **Existing fail-closed behavior is unchanged.** Checkout and tax calculation
  continue to refuse a Product with no tax classification; nothing here weakens
  that.

### 5.3 `generalAvailabilityState`

- **`generalAvailabilityState` is not a completeness requirement** under V1,
  whatever its value.
- It is **not** mapped to, inferred from, or substituted for Product lifecycle
  (Contract §9.1) or Seller-controlled resale availability (Contract §9.3).
- **Reconciliation required.** ADR §10.2 describes it as broad Product-level
  lifecycle availability and forbids its use for checkout eligibility, while
  [`LISTING_SOURCE_MODEL.md`](LISTING_SOURCE_MODEL.md) §13 and the current
  Listing buyer-eligibility implementation use it as an upstream blocking reason
  (`PRODUCT_UNAVAILABLE`). Its relationship to the newer Product lifecycle and
  resale-availability model requires later governed reconciliation. This
  document does not resolve it.

### 5.4 `recordStatus = authoring-complete`

- The existing internal `recordStatus` value `authoring-complete` (see
  [`PRODUCT_SOURCE_RECORD_MAPPING.md`](PRODUCT_SOURCE_RECORD_MAPPING.md)) is
  **not authoritative for derived Product completeness** and must not be used as
  the completeness predicate, as an input to it, or as a substitute for it.
- It is a **legacy implementation / status primitive** requiring later
  reconciliation or retirement.

### 5.5 Other non-content gates

Seller identity, KYC, underwriting, payment readiness, commerce approval,
restrictions, suspensions, Storefront ownership, Listings, Offers, and resale
availability are not Seller-supplied Product content and never affect
completeness. They are activation or commerce gates under Contract §5, §8,
§9.2, §9.3, and §11.

## 6. Versioning

- Product-completeness requirements are **versioned**. Each profile has a stable
  identifier; the initial profile is **`PRODUCT_COMPLETENESS_V1`**, as defined in
  §4.
- **The required set of a profile version never changes silently.** Any future
  required Seller-authored fact — adding, removing, or redefining a required or
  conditional fact, or introducing category-specific requirements — requires a
  **new governed completeness-profile version** recorded in this document (or its
  governed successor).
- How a new profile version applies to existing Products — migration,
  grandfathering, re-evaluation, or notice — **is not decided here.** Any future
  profile change requires explicit governance of those mechanics before or
  together with the implementation that relies on it (Contract §2).
- Until a later profile is governed, **`PRODUCT_COMPLETENESS_V1` is the
  applicable profile for every Product.**

## 7. Seller Product revision — recorded requirement

Because completeness depends only on Seller-authoritative facts (§2), the Seller
must be able to supply every one of them. **Seller Product-revision capability
must eventually allow the Seller to supply all Seller-authoritative completeness
facts** — including `description` and, where §4.2 applies, the Seller shipping
policy — through governed creation of new immutable source versions.

Today Seller authoring creates a Product's first source version only; there is
no Seller revision path, and no shipping policy can be recorded at all.
Until both exist, a Product missing a required Seller fact remains `INCOMPLETE`
with no Seller remedy. This is an implementation gap, not a relaxation of §4.

## 8. Relationship to other documents

- **Contract §9.1–§9.2** govern lifecycle states, transitions, activation,
  suspension, and reinstatement. This document supplies only the content
  requirements §9.1 refers to.
- **Contract §9 — no conflict.** §9 says Product semantic truth does not own
  buyer-facing retail price or transaction economics. The Seller shipping policy
  is neither: it is a Seller-authored fulfillment rule, and Product semantic
  truth may own it (§5.1). Product semantic truth still does **not** own the
  transaction-specific shipping amount, retail price, or Order economics — the
  shipping amount is transaction economics, derived at checkout and frozen on the
  Order / transaction snapshot. Contract §9 records this distinction explicitly.
- **Implementation specs** ([`PRODUCT_CAPSULE.md`](PRODUCT_CAPSULE.md),
  [`PRODUCT_SOURCE_RECORD_MAPPING.md`](PRODUCT_SOURCE_RECORD_MAPPING.md),
  [`PRODUCT_PERSISTENCE.md`](PRODUCT_PERSISTENCE.md)) remain authoritative for
  the shape, validation, and persistence of each Product fact. Their treatment
  of `description` and `deliveryMode` as optional in the stored and projected
  shapes is **not a divergence**: those shapes must still hold incomplete drafts
  and historical versions. Optional in the shape means "may be stored absent";
  under V1 an absent value makes the Product `INCOMPLETE`.
- Nothing here changes capsule projection, publication, or the immutability of
  Product source versions.

## 9. Phase 1.38

This document **closes the governance blocker for deterministic Product
completeness** reported at the start of Phase 1.38. It implements nothing.

**Sequencing.** Sellers must be able to satisfy `PRODUCT_COMPLETENESS_V1` before
lifecycle and activation can be meaningful (§7). Therefore:

1. **Phase 1.38** provides **Product revision and completeness enablement**,
   including the **Seller shipping-policy primitive**.
2. **Explicit Product lifecycle and activation** (Contract §9.1–§9.2) follow,
   after Sellers can actually satisfy `PRODUCT_COMPLETENESS_V1`.

This records order only; it assigns no further phase number (Contract §33).
