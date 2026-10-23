# Monacado Project Contract

**Status:** canonical. The highest-authority statement of Monacado's business,
economic, authority, lifecycle, and compliance rules.
**Installed:** Documentation Governance 2A, against `main` at `e717985`
(Phase 1.36 accepted in Production).
**Companion:** [`DOCUMENT_AUTHORITY.md`](DOCUMENT_AUTHORITY.md) classifies every
other document under this Contract.

This Contract states **rules**. It does not describe implementation, and it does
not claim that any rule is already enforced. Where a rule is not yet built, it is
recorded in §34 as a gap — never as a softer rule.

Section references below (`§n`) are to this Contract unless another document is
named. "Versioned commercial policy" means a governed, versioned, database-backed
policy record (see §28), never a constant compiled into code or written here.

---

## Part I — Authority

### §1 Document authority

Authority, highest first:

1. **This Contract** — `MONACADO_PROJECT_CONTRACT.md`.
2. **Binding architecture ADRs** —
   [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) and
   [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md).
3. **Governing domain documents explicitly incorporated by this Contract** — the
   documents classified GOVERNING DETAIL in
   [`DOCUMENT_AUTHORITY.md`](DOCUMENT_AUTHORITY.md), each for its named domain
   only.
4. **Implementation specs and executable contracts** — phase specs, and the
   typed contracts, schema, and tests that encode them.
5. **Roadmap and status** —
   [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md) and track
   status records.
6. **Historical phase records and commit history.**
7. **Original Thesis and CDD source documents** —
   `Monacado_New_Thesis_and_Initial_Site_Map.docx` and
   `Capsule_Driven_Development_Intro_Cover.docx` — product-origin and conceptual
   history, authoritative only where a higher level explicitly incorporates them.

Rules of authority:

- **Recency alone confers no authority.** A newer document at a lower level does
  not override an older one at a higher level.
- **Code and database prove implementation state, not policy authority.** That the
  system does something does not make it the rule; that it does not yet do
  something does not repeal the rule.
- **A lower level may refine a higher level but never contradict it.** A
  contradiction in a lower document is a defect in that document.
- **An unresolved conflict between documents at the same level is a STOP.** It is
  surfaced for an explicit ruling and is not resolved by the implementer.
- **The Thesis is no longer the current governing commercial model.** Where the
  Thesis and this Contract differ, this Contract governs. The binding ADRs remain
  binding on their own authority; their historical citations of the Thesis do not
  restore it as commercial authority.
- **The CDD Intro is conceptual history** wherever the ADRs or this Contract
  scope or supersede it (in particular, capsule canonicality is scoped by ADR §12
  and §2 below).

### §2 Contract amendment

- A change to any consequential **business, economic, authority, lifecycle, or
  compliance** rule requires reconciliation of this Contract, or of the
  incorporated governing detail document for that domain, before or together with
  the implementation that relies on it.
- **Code changes alone never amend policy.** A rule that reaches code without
  reaching the governing documents is a defect.
- **Incomplete implementation never silently amends this Contract.** An unbuilt
  rule remains a rule; it is recorded as a gap (§34).
- Code is **not** changed merely to match a lower-authority document that is
  stale against this Contract. The stale document is reconciled instead.

---

## Part II — Architecture

### §3 Transactional truth and capsule projection

- **The database is the sole source of transactional and business truth** —
  every business fact, authority, lifecycle state, immutable source version,
  audit record, and publication obligation.
- **Capsules are deterministic one-way projections** of selected authoritative
  truth: authoritative record → source version → mapping → capsule projection →
  publication.
- **Capsules never write back, never create authority, and never create
  provenance.** A capsule never supplies, repairs, or overrides a transactional
  record.
- **Product, Storefront, Listing, and Offer are separate concepts** with separate
  records and separate authorities. None may be collapsed into another. Product
  lifecycle (§9.1), Seller-controlled resale availability (§9.3), and Promotion
  Authorization (§16.1) are likewise separate from each other and from these.
- **Internal IDs, application refs, and AgentNet IDs are separate identities.**
  An internal ID is never an application ref; neither is ever an AgentNet
  identity.
- **Publication failure never reverses a marketplace transaction.** A completed
  sale, refund, or other transactional fact is unaffected by whether any capsule
  about it was published.

---

## Part III — Identity and participants

### §4 Private marketplace identity

**Private marketplace identity** consists of:

- an authenticated **Monacado Account**;
- a **verified email address** on that Account;
- a declared **first name**;
- a declared **last name**;
- the corresponding stable **MarketplaceParticipant** identity.

**Only the email address is verified.** The declared name is **not**
KYC-verified, and private marketplace identity implies **no KYC and no
independent identity verification** of any kind.

Private marketplace identity is **sufficient for governed private drafting.**

An eligible **Seller** may, under private marketplace identity:

- create private Products;
- create draft Offers;
- create one included private Storefront, if desired (§11);
- create and manage other permitted draft marketplace state.

An eligible **Promoter** may, under private marketplace identity:

- create one included private Storefront, if desired (§11);
- prepare permitted private promoter state.

Private drafting **does not require** Stripe underwriting, payment readiness, or
public AgentNet identity.

### §5 Public marketplace identity

**Public marketplace identity** requires:

1. private marketplace identity (§4);
2. successful **Stripe underwriting and approval**;
3. the applicable Monacado activation and readiness gates.

For a **Seller**, public marketplace identity permits binding to a governed
public **Creator** identity where appropriate. For a **Promoter**, it permits
binding to a governed public **Promoter** identity.

Public marketplace identity is required before:

- public commercial activation;
- active promotional Offer availability;
- public AgentNet identity publication;
- creation of more than one Storefront (§11);
- any other governed public or commercial exposure that requires underwriting.

### §6 Automated and bot participants

- Bot-operated Sellers and Promoters use **the same participant model** as
  human-operated participants.
- **Automation creates no separate authority class.**
- A bot does **not** bypass verified-email identity, Stripe underwriting, payment
  readiness, Storefront rules, publication rules, or commercial policy.
- **A bot acts through an accountable MarketplaceParticipant**, which bears every
  obligation the participant would bear if it acted directly.

### §7 Activation, email, and support contacts

- **Drafting is more permissive than live commerce.** Private marketplace identity
  allows private drafting; public or commercial exposure requires the applicable
  activation and readiness gates.
- **Account email verification and support-contact verification are distinct
  facts** with distinct subjects: the first proves control of the login address,
  the second proves a participant's buyer-facing support address.
- Only email control is verified; the declared name is not KYC (§4).
- The older participant-profile email-verification marker
  (`ParticipantProfile.emailVerifiedAt`) is a **legacy / deprecation candidate**
  unless a distinct purpose for it is found and recorded.
- **Products, Listings, and Offers do not create redundant verification facts.**
  Verification lives on the Account and on the support contact, once each.

### §8 Restrictions, suspension, and closure

- **Restrictions are capability-specific.** A restriction removes a named
  capability and nothing else.
- **Suspension is broader** than any single restriction.
- **Participant `CLOSED` is owner-initiated.**
- **Monacado enforces through restriction and suspension**, not closure.
- Future **administrative termination** requires a separate, explicit design.
- Reconsideration and reversal of any restriction or suspension must remain
  **governed and auditable**.

---

## Part IV — Catalog, placement, and offers

### §9 Products

A **Product** represents the item being sold — its identity and semantic content,
under its creator's authority.

**Product semantic truth does not own:**

- buyer-facing retail price (§15);
- promoter commission (§16);
- payment data;
- Storefront placement (§13);
- transaction economics (§17–§19).

For a Seller-shipped Product, Product semantic truth **may own the Seller's
shipping policy** — a Seller-authored fulfillment fact such as free or fixed
shipping. It does **not** own the **transaction-specific shipping amount**, which
is transaction economics derived at checkout and frozen on the Order /
transaction snapshot. Detail:
[`PRODUCT_COMPLETENESS_PROFILE.md`](PRODUCT_COMPLETENESS_PROFILE.md) §5.1.

**Seller KYC and underwriting are gates on activation, not Product content.**

#### §9.1 Product lifecycle

| State | Meaning |
| --- | --- |
| `INCOMPLETE` | The Product is under construction: one or more required Product elements are missing. It **cannot participate in commerce.** |
| `COMPLETE` | The required Product definition is complete, but the Product is **not yet commercially eligible** because one or more external readiness gates remain unsatisfied — for example Seller underwriting / approval or another applicable commerce-readiness gate. |
| `ACTIVE` | The Product is complete and **commercially eligible to participate in commerce.** |
| `SUSPENDED` | A **Monacado-controlled administrative commerce block.** |

`ACTIVE` does **not** mean:

- that the Product is currently merchandised in a Storefront;
- that a promotional Offer currently exists;
- that the Product is currently being sold or promoted.

Because `INCOMPLETE` and `COMPLETE` Products cannot participate in commerce,
**any commerce in a Product — seller-direct or promoted — requires Product
lifecycle `ACTIVE`.**

`SUSPENDED`:

- is imposed by Monacado for governed reasons, including fraud, excessive refunds
  or chargebacks, regulatory or compliance review, safety concerns, or other
  governed enforcement;
- **blocks commerce in the Product**;
- **does not rewrite historical Product state or historical transactions**;
- is **reversible through governed administrative action.**

**Product completeness is derived, never declared.** Whether a Product is
`INCOMPLETE` or content-complete is determined from its **authoritative Product
facts** against the applicable **governed, versioned Product-completeness
requirements**. It is not a Seller-set boolean or a manual declaration, and a
Product **cannot become `COMPLETE` merely because a user requests it** while
required Product facts are missing. The exact required elements may be defined in
governing Product detail and may evolve through governed, versioned rules. They
are defined in [`PRODUCT_COMPLETENESS_PROFILE.md`](PRODUCT_COMPLETENESS_PROFILE.md),
incorporated here as governing detail for Product completeness (initial profile
`PRODUCT_COMPLETENESS_V1`).

**Lifecycle transitions driven by changed facts:**

| Change | Transition | Effect |
| --- | --- | --- |
| Required Product content becomes incomplete | `ACTIVE` or `COMPLETE` → `INCOMPLETE` | **Commerce must stop.** |
| Product content stays complete, but Seller / public-marketplace readiness is lost | `ACTIVE` → `COMPLETE` | **Commerce must stop.** |
| Readiness is later restored on a `COMPLETE` Product | **none** — stays `COMPLETE` | Activation becomes **permissible**; the Seller must **explicitly activate** again (§9.2). |
| Monacado lifts a suspension — itself a **governed administrative action** | `SUSPENDED` → **re-evaluated** against current facts, never blindly restored | see **Suspension reinstatement** below |

**Historical Product source versions remain unchanged** by every transition.

**Suspension reinstatement.** Lifting a Monacado Product suspension **must not
create `ACTIVE` authority that did not exist before the suspension.**

| Facts at reinstatement | Result |
| --- | --- |
| Current Product content is incomplete | `INCOMPLETE` |
| Content complete, but the Product was **not `ACTIVE` immediately before suspension** | `COMPLETE` |
| Content complete, but **current readiness is not satisfied** | `COMPLETE` |
| The Product was **`ACTIVE` immediately before suspension**, current content is complete, **and** all current activation / readiness requirements are satisfied | `ACTIVE` |

- A Product that was `COMPLETE` before suspension **remains `COMPLETE`** after
  the suspension is lifted, even if readiness is now satisfied. It still requires
  the explicit Seller activation act (§9.2) before becoming `ACTIVE`.
- **Seller activation may create `ACTIVE` commercial authority. Monacado
  suspension reinstatement may restore previously existing `ACTIVE` authority,
  but may never create it for the first time.**

#### §9.2 Product activation

Product activation is the **upstream commercial-readiness transition** to
`ACTIVE`. A Product may become `ACTIVE` only when:

1. its **Product completeness requirements** are satisfied;
2. the Seller has the applicable **public marketplace identity and readiness**
   (§5);
3. any **Product-specific readiness gates** are satisfied.

**Activation is an explicit act.** Meeting these requirements makes activation
**permissible**; it never silently activates the Product.

- **Initial `COMPLETE` → `ACTIVE` requires an explicit, governed Seller
  activation act.**
- An `ACTIVE` Product that fell to `COMPLETE` because Seller / public-marketplace
  readiness was lost **does not return to `ACTIVE` when readiness is restored.**
  The Seller must explicitly activate it again.
- Lifting a Monacado suspension follows §9.1's governed reinstatement rule
  instead, which may restore `ACTIVE` only where it existed immediately before
  the suspension.

**Storefront ownership and Storefront state are not prerequisites** for Product
activation (§11).

#### §9.3 Seller-controlled resale availability

A Product carries a **Seller-controlled resale-availability state** for the
third-party promotion / resale channel, separate from its lifecycle:

| State | Meaning |
| --- | --- |
| `NOT_OFFERED` | The Seller has not made the Product available for third-party resale. |
| `AVAILABLE` | The Seller currently permits the Product to participate in the third-party promotion / resale channel, **subject to Offer and Promotion Authorization rules** (§16). |
| `PAUSED` | The Seller has **temporarily** stopped third-party resale availability. Existing Promotion Authorizations may remain recorded; **no new promoted commerce may occur while paused.** Resuming may make still-valid approvals effective again without reapplication, unless another governing rule requires it. |
| `WITHDRAWN` | The Seller has **intentionally ended** resale availability indefinitely or permanently. Historical Offers, approvals, Listings, and Orders remain preserved. Re-opening a withdrawn Product requires governed future handling and is not defined here. |

- **`resaleAvailability = AVAILABLE` is the authoritative Seller-controlled fact
  that the Product is open to third-party resale.** It **supersedes the Product
  `promotable` fact**, which is **retired** as a governing requirement; existing
  implementation use of `promotable` is a legacy gap (§34).
- **A Seller may set `resaleAvailability = AVAILABLE` only when Product lifecycle
  = `ACTIVE`** (§9.1). Offers may be drafted before Product activation; third-party
  resale availability may not become `AVAILABLE` until the Product itself is
  `ACTIVE`.
- **Product lifecycle and resale availability are independent state axes.** A
  lifecycle change — to `COMPLETE`, `INCOMPLETE`, or `SUSPENDED`, or back to
  `ACTIVE` — **never automatically rewrites `resaleAvailability`.** The Seller's
  recorded choice (`NOT_OFFERED`, `AVAILABLE`, `PAUSED`, or `WITHDRAWN`) is
  preserved unless the Seller changes it or a separate governed rule does.
  - While the Product is not `ACTIVE`, commerce stops because of the lifecycle
    gate (§9.1), whatever `resaleAvailability` says.
  - When the Product becomes `ACTIVE` again, the preserved resale-availability
    state becomes effective again, subject to every other commerce gate.
  - The `ACTIVE`-only rule above governs the Seller **setting** `AVAILABLE`; it
    does not reset a preserved `AVAILABLE` when the lifecycle later moves.
- **Product-level resale availability does not authorize any particular
  Promoter** (§16.1).
- Seller-controlled `PAUSED` and `WITHDRAWN` are **distinct from**
  Monacado-controlled Product `SUSPENDED` (§9.1). Neither is used as, or recorded
  as, the other.

### §10 Product library capacity

Seller Product libraries are **capacity-controlled.** This **replaces** the
earlier rule that a Seller may hold an unlimited number of Products.

| Tier | Product library capacity |
| --- | --- |
| **FREE** | up to **100** Products |
| **POWER SELLER** | up to **250** Products |
| **ENTERPRISE** | **251+** Products |

Rules:

- **The thresholds above are governing marketplace rules.**
- **Prices and rates are not part of this Contract.** Power Seller and Enterprise
  pricing is governed by versioned commercial policy.
- Monacado may change pricing **prospectively** as market, infrastructure,
  support, or commercial conditions change.
- Monacado may use **negotiated, discounted, promotional, category-specific,
  volume-based, or seller-specific pricing** at its discretion. **Seller-specific
  rates are permitted.**
- **Historical obligations are never silently rewritten** by a later pricing
  change.
- A Seller **may not exceed** the capacity of its effective tier without a
  higher-capacity entitlement or an Enterprise arrangement.
- **Each Product aggregate counts once**, regardless of how many source versions
  it has. Immutable Product versions do not consume additional Product slots.
- Counting of terminal or purged Products may be governed later by explicit
  policy. **No additional exclusion is defined now.**
- Product library capacity is **separate** from Storefront entitlement (§11),
  wholesale catalog capacity (§12), and Listing capacity (§13).

### §11 Storefronts

- A Storefront is **optional for a Seller.** Product authority and Offer
  authority do **not** depend on Storefront ownership. A Seller may operate
  wholesale-only with no Storefront (§12).
- **Storefront independence.** None of the following requires a Storefront:
  - Product activation (§9.2);
  - Seller-controlled resale availability (§9.3);
  - Offer activation (§16);
  - Promotion Authorization (§16.1).

  **Storefront merchandising is downstream and optional.**
- **One private Storefront is included** for an eligible participant under private
  marketplace identity. The first Storefront is an **entitlement, not an
  automatically created object.**
- **More than one Storefront requires all of:**
  1. public marketplace identity (§5);
  2. payment readiness;
  3. the applicable **paid additional-Storefront entitlement**.
- Storefront entitlement is **separate** from Product library capacity (§10) and
  **separate** from Listing capacity (§13).

### §12 Wholesale-only Sellers and wholesale catalog capacity

**Seller modes.** A Seller may operate as **retail-only, wholesale-only, or
hybrid.**

- A wholesale-only Seller does **not** need a Storefront.
- Private marketplace identity is sufficient to create Products and draft Offers.
- An Offer may **not** become actively available for third-party promotion until
  the Seller has public marketplace identity (§5) and satisfies the applicable
  readiness gates.
- Wholesale participation that can generate commercial obligations **requires
  successful underwriting**.

**Wholesale catalog capacity** is a commercial control **separate** from Product
library capacity. Three entitlement systems exist, and none implies another:

| Control | Governs |
| --- | --- |
| **Product library capacity** (§10) | how many Products a Seller may maintain |
| **Wholesale catalog capacity** | how many Products / Offers may be **actively exposed for third-party promotion** |
| **Storefront Listing capacity** (§13) | how many **ACTIVE** Listings a Storefront may contain |

- The wholesale catalog pricing and allowance schedule is **versioned commercial
  policy**. **This Contract defines no quantity and no price for it.**
- An **ACTIVE promotional Offer** is treated as the commercial trigger for
  consuming wholesale catalog capacity, unless later governing policy refines that
  rule.

### §13 Listings and Storefront Listing capacity

- A **Listing** is the placement of **one Product in one Storefront.**
- A Product may appear in **multiple Storefronts.**
- **At most one current Listing** exists per Product + Storefront pair.
- **Five ACTIVE Listings are included per Storefront.**
- **DRAFT Listings consume zero** active Listing capacity.
- **Seller-direct and promoted ACTIVE Listings count equally.**
- Additional ACTIVE Listing capacity is a **separate future paid entitlement.**
- Product library tier does **not** increase Listing capacity.
- A paid Storefront entitlement does **not** increase Listing capacity unless
  future policy explicitly bundles them.

### §14 Seller-direct versus promoted; promoted Listing eligibility

**Classification is by economic principal, not role label.** A Listing is
seller-direct when the Product creator's economic principal is the Storefront
owner's economic principal, and promoted otherwise.

- A Seller **cannot earn promoter economics on its own Product** through another
  role, another account, or another Storefront.
- **Economic-principal resolution across accounts is required before promoter
  self-service is launch-ready.**

A **promoted Listing** may transact only when **promoted-commerce eligibility
(§16.3)** holds in full.

**Product lifecycle, Seller resale availability, Offer eligibility, and
Promotion Authorization are separate requirements.** None implies another.

### §15 Price authority

- **Retail price belongs to the Listing placement**, not to Product semantic truth.
- The **Seller** sets the seller-direct retail price.
- The **Promoter** sets the promoted retail price.
- A private seller-direct **draft may be unpriced.**
- **An unpriced Listing cannot become commercially ACTIVE.**

### §16 Offer authority

- An **Offer** is the **Seller-controlled upstream commercial terms** for a
  Product.
- **Wholesale price, availability, commission, and Offer lifecycle belong to the
  Offer.**
- A promoted Listing **binds an accepted Offer version** — one exact immutable
  version, not "the current Offer".
- The Offer answers: **"What commercial terms govern permitted third-party resale
  of this Product?"** It may contain the wholesale amount, commission,
  lifecycle / availability terms, and other governed promotional economics.
- **An Offer does not by itself authorize any particular Promoter.** Offer
  availability does not authorize every Promoter.
- **Product resale availability and Offer lifecycle / availability are separate.**
  Product `resaleAvailability` (§9.3) is the Seller's **Product-wide
  third-party-resale switch**; Offer lifecycle / availability governs **whether a
  particular set of resale commercial terms is currently usable.** Promoted
  commerce requires **both** — `resaleAvailability = AVAILABLE` **and** an eligible
  `ACTIVE` promotional Offer (§16.3). **Neither substitutes for the other.**

#### §16.1 Promotion Authorization

**Promotion Authorization** is a first-class governed relationship among one
**Seller**, one **Product**, and one **Promoter**. It records whether that
Seller permits that Promoter to promote / resell that Product.

| State | Meaning |
| --- | --- |
| `REQUESTED` | The Promoter has requested permission to promote / resell the Product. |
| `APPROVED` | The Seller has **explicitly approved** that Promoter for the Product. |
| `DENIED` | The Seller rejected the request. |
| `REVOKED` | The Seller previously approved the Promoter and later withdrew approval. |
| `CANCELLED` | The Promoter withdrew its own request or participation. |

- **Only `APPROVED` authorizes promoted commerce.**
- Authorization is **Promoter-specific**. Product `SUSPENDED` (§9.1) is **never**
  a substitute for revoking one Promoter, and Product-wide `PAUSED` / `WITHDRAWN`
  (§9.3) is never a substitute for it either.
- Promotion Authorization does **not** require a Storefront (§11).

**Who may act:**

| Act | Requires |
| --- | --- |
| **Request** (→ `REQUESTED`) | an authenticated Promoter with **private marketplace identity** (§4) and the **PROMOTER role** |
| **Approve, deny, revoke** (→ `APPROVED` / `DENIED` / `REVOKED`) | **Seller authority over the Product** |

- **Promotion Authorization may precede commerce readiness.** It is preparatory
  Seller permission, not permission to transact. A Seller with authority over the
  Product may `APPROVE` or `DENY` a valid request — and any party may `REQUEST`,
  `CANCEL`, or `REVOKE` within its own authority — **while the Product is not
  `ACTIVE` or not `AVAILABLE`**, unless another existing authority rule
  independently requires otherwise. For example, Promoters may request and
  receive approval for a `COMPLETE` Product before launch, and approvals may
  remain, or new governed approvals be established, while the Product is `PAUSED`.
- A Promoter does **not** need full public-marketplace readiness merely to request
  or receive Seller approval. **Actual promoted commerce still requires** the
  Promoter to satisfy the public / commercial eligibility gates of §16.3.

**Re-requesting.** After `DENIED`, `CANCELLED`, or `REVOKED`, a **later new
`REQUESTED` authorization is permitted.**

- **History is preserved**; the earlier authorization record is not rewritten.
- The old authorization is **never silently restored.**
- The Seller must **explicitly `APPROVE` the new request.**
- Future policy may rate-limit or otherwise constrain repeated requests.

#### §16.2 Seller control

The Seller must be able to:

- see **pending Promoter requests** for a Product;
- **approve** a Promoter;
- **deny** a Promoter;
- know **which Promoters are currently approved** for the Product;
- **revoke one Promoter** without affecting unrelated Promoters;
- **pause or withdraw** Product-wide resale availability (§9.3) independently of
  Promoter-specific approvals.

#### §16.3 Promoted-commerce eligibility

A promoted transaction requires, **at minimum, all of**:

1. Product lifecycle = **`ACTIVE`** (§9.1);
2. Seller-controlled resale availability = **`AVAILABLE`** (§9.3);
3. an **eligible `ACTIVE` promotional Offer** (§16);
4. Promotion Authorization = **`APPROVED`** for the **specific Promoter** (§16.1);
5. the **Promoter itself commercially eligible**;
6. Seller and Promoter are **distinct governed economic principals** (§14);
7. the Promoter has **accepted the material Offer terms** (§19);
8. **all other applicable readiness gates.**

**Product-level resale availability does not automatically authorize every
Promoter, and neither does Offer availability.**

#### §16.4 Revocation and pause effects

**Revoking one Promoter** (`APPROVED → REVOKED`):

- historical Orders remain unchanged;
- historical Listing and source versions remain preserved;
- that Promoter may **not create new sellable configurations** for the Product;
- any **currently sellable promoted commerce that depends on that authorization
  must stop transacting**;
- **other approved Promoters are unaffected.**

**Pausing resale availability** (`AVAILABLE → PAUSED`):

- **promoted commerce for that Product must stop transacting**;
- Promotion Authorization records **may remain `APPROVED`**;
- historical Orders and versions remain unchanged;
- resuming availability may make still-valid approvals effective again.

---

## Part V — Economics

### §17 Merchant of Record

- **Monacado is the retailer and Merchant of Record.** The Buyer purchases from
  Monacado.
- **Seller and Promoter amounts are commercial obligations of Monacado**, not
  pass-through Buyer funds.
- The **current standard retention model is 7.5% of retail + $1.00.** This is
  **versioned commercial policy**, not an immutable Contract constant; future
  policy may change it **prospectively**.
- **Tax and shipping are excluded** from fee and commission bases unless future
  policy explicitly changes that.

Detail: [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md).

### §18 Promoter economics

- **Commission is calculated on wholesale, not retail.**
- A **fixed commission cannot exceed wholesale.**
- The Promoter sets the promoted retail price (§15). There is **no general MAP,
  minimum resale price, or suggested-price requirement.**
- **Monacado's retained amount is removed before the promoter spread** is
  computed.
- **Promoter benefit = acquisition amount − wholesale + commission**, where the
  acquisition amount is retail less Monacado's retained amount.
- Promoter benefit **may be zero, never negative.**
- **All commercial arithmetic uses integer minor units.**

### §19 Material Offer changes

- **Wholesale and commission changes are material.**
- A material change to Offer economics **invalidates prior Promoter acceptance.**
- The affected promoted Listing **stops selling until explicit reacceptance.**
  Acknowledgement alone never reactivates it.
- **Non-material** Offer version changes do **not** automatically invalidate
  Listings.
- The exact set of material fields must remain **explicit and testable** — an
  enumerated set, never an inferred one.

---

## Part VI — Transactions and post-sale

### §20 Checkout and Orders

- **Guest checkout is first-class.**
- **The Buyer never supplies authoritative economics.** Every price and amount is
  quoted from authoritative state.
- **Billing and ship-to addresses are required on every Order, including digital
  Orders.** The **ship-to address is the tax destination.**
- A purchase **preserves the applicable policy, refund policy, and effective
  support-contact evidence** in force at the time of purchase.
- **`PAID` is never rewritten.** Later refunds and disputes are separate records.

### §21 Tax

- **Stripe Tax** is the current provider.
- Tax classification is **explicit**. There are **no silent defaults.**
- Monacado accepts **no buyer exemption certificates and no VAT IDs.**
- Where governing operating policy does not permit a sale to a destination, the
  destination / tax operation **fails closed.**
- **Monacado does not invent nexus obligations.** Nexus, registration, filing, and
  remittance posture are operator-governed facts, never inferred by software.

### §22 Refunds

- Sellers maintain a **versioned refund policy.**
- **The policy in force at purchase governs** that purchase.
- A **Monacado, legal, or statutory override** is permitted.
- Under the current one-line Order model, refunds are **whole-line.**
- Refund economics **reverse participant economics according to the transaction
  snapshot.**
- **Historical sale facts are not rewritten**; a refund is new evidence about a
  sale, not a correction of it.

### §23 Disputes

- As MoR, **Monacado owns the processor / network dispute relationship.**
- **Monacado always responds** where a response is available and appropriate.
- **Participants submit evidence to Monacado**, never directly to the card network.
- Each dispute **preserves**:
  - processor dispute ID;
  - processor / network reason code;
  - reason description, if available;
  - disputed amount and currency;
  - opened time;
  - response deadline;
  - Order;
  - Seller;
  - Promoter, where applicable;
  - evidence status;
  - dispute state.
- **The response deadline is operationally significant.**
- An open dispute **may hold affected proceeds** under policy.
- A **win releases** the hold.
- A **loss** that reverses the sale by chargeback triggers **original transaction
  economic reversal / recovery** (§25.1) and, separately, **Monacado Chargeback
  Fee** policy (§25.2, §26).

### §24 Dispute reason classification

Internal responsibility categories:

| Category | Meaning |
| --- | --- |
| `SELLER_RESPONSIBILITY` | the dispute reason is attributable to the Seller |
| `PROMOTER_RESPONSIBILITY` | the dispute reason is attributable to the Promoter |
| `SHARED_COMMERCIAL_RESPONSIBILITY` | attributable to Seller and Promoter jointly |
| `MONACADO_PAYMENT_RISK` | attributable to Monacado's payment-risk position |
| `UNDETERMINED_REVIEW_REQUIRED` | not yet attributable; requires review |

Rules:

- **External provider / network reason codes are not Contract constants.**
- Monacado maintains a **versioned internal mapping** from authoritative processor
  / network reason codes to these categories. Mappings may be added later without
  amending this Contract.
- **Unmapped codes classify as `UNDETERMINED_REVIEW_REQUIRED`.**
- **Unknown or unmapped codes never automatically create Seller or Promoter
  responsibility, and never automatically allocate or assess the Monacado
  Chargeback Fee** (§25.2, §26) to the Seller or the Promoter. This rule governs
  **responsibility classification and the separate Monacado Chargeback Fee
  only.** It does **not** prevent reversal or recovery of the original Seller
  proceeds or Promoter economic benefit when a chargeback reverses the underlying
  sale — that reversal is independent of responsibility classification (§25.1).
- A reason code **guides review and evidence** but **does not by itself prove
  fault.**

### §25 Chargeback reversal and the Monacado Chargeback Fee

A chargeback has **three distinct financial consequences**. None determines,
substitutes for, or is netted into another.

| | Concept | What it is | What decides it |
| --- | --- | --- | --- |
| **A** | **Original transaction economic reversal / recovery** (§25.1) | Reverses the Seller and Promoter economics of a sale reversed by chargeback | The chargeback reversal itself — **not** responsibility classification |
| **B** | **Monacado Chargeback Fee** (§25.2, §26) | A separate, additional Monacado-imposed fee | Responsibility classification (§24) and versioned policy |
| **C** | **Provider / network dispute fee** (§27) | A separate processor / network expense charged to Monacado | Currently borne by Monacado unless future explicit policy changes that treatment |

#### §25.1 Original transaction economic reversal / recovery

If a dispute results in a chargeback that reverses the sale:

- Monacado **must reverse or recover the Seller proceeds** attributable to that
  transaction.
- Monacado **must reverse or recover any Promoter economic benefit** attributable
  to that transaction.
- Amounts are taken from the **immutable transaction economic snapshot that
  governed the sale.** They are **never recomputed** from current Product, Offer,
  Listing, or policy state.
- **Monacado does not fund Seller or Promoter economics for a transaction reversed
  by chargeback.**

| Transaction | Reversed / recovered |
| --- | --- |
| **Seller-direct** | Seller proceeds |
| **Promoted** | Seller proceeds **and** Promoter economic benefit |

This applies **regardless of responsibility classification**, including
`UNDETERMINED_REVIEW_REQUIRED`. **The chargeback reversal — not responsibility
classification — determines whether the original participant economics are
reversed.** §24's rule that an unknown code creates no automatic participant
liability governs responsibility and the Monacado Chargeback Fee; it does not
prevent this reversal.

#### §25.2 Monacado Chargeback Fee

- The **Monacado Chargeback Fee** (the Monacado-imposed Seller Chargeback Fee) is
  **separate** from:
  - the original transaction reversal (§25.1);
  - Seller proceeds recovery;
  - Promoter earnings recovery;
  - the processor / network dispute fee (§27).
- **Responsibility classification determines only who bears this fee.** It does
  not determine whether the original transaction economics are reversed.
- **Participant fee liability is never inferred merely from the fact that a
  chargeback occurred.**
- The fee amount is **versioned commercial policy.** No amount is a timeless
  Contract constant; a current or draft policy version may state $30.00, and
  future policy may change it **prospectively.**
- **There is no fallback fee.** If no applicable policy version exists, no fee is
  assessed.
- **No fee is assessed merely because a dispute opens.** The fee is assessed only
  according to governing policy and dispute outcome.

### §26 Monacado Chargeback Fee allocation

This section governs **only the Monacado Chargeback Fee** (§25.2). It never
alters reversal / recovery of the original transaction economics (§25.1).

**Seller-direct transaction:** the Seller bears the participant share, unless the
governing classification or policy assigns Monacado responsibility.

**Promoted transaction:** allocation follows the responsibility category (§24):

| Category | Allocation |
| --- | --- |
| `SELLER_RESPONSIBILITY` | policy may allocate all or substantially all of the participant fee to the Seller |
| `PROMOTER_RESPONSIBILITY` | policy may allocate all or substantially all of the participant fee to the Promoter |
| `SHARED_COMMERCIAL_RESPONSIBILITY` | **default pro-rata by frozen Seller and Promoter economic benefit** (below) |
| `MONACADO_PAYMENT_RISK` | policy may allocate the fee to Monacado |
| `UNDETERMINED_REVIEW_REQUIRED` | **no automatic participant fee allocation** (below) |

**`UNDETERMINED_REVIEW_REQUIRED`**, on every transaction, seller-direct included:

- the Monacado Chargeback Fee is **not automatically allocated** to the Seller or
  the Promoter;
- allocation requires review, a **governed responsibility determination**, or an
  **applicable versioned policy rule**;
- it does **not** prevent reversal / recovery of the original Seller or Promoter
  economics (§25.1).

**Economic benefit**, for allocation on a promoted transaction, is read from the
**same immutable transaction economic snapshot** that governed the sale — never
recomputed:

| Term | Definition | Normally, under the current model |
| --- | --- | --- |
| **Seller economic benefit** | the Seller proceeds obligation frozen in the snapshot | wholesale amount − commission |
| **Promoter economic benefit** | the Promoter benefit frozen in the snapshot | acquisition amount − wholesale amount + commission (§18) |

**`SHARED_COMMERCIAL_RESPONSIBILITY` denominator:**

```
denominator = frozen Seller economic benefit + frozen Promoter economic benefit
```

The denominator **excludes** Monacado's retained amount, tax, and shipping.

**Zero denominator.** If `SHARED_COMMERCIAL_RESPONSIBILITY` applies and the
denominator is **0**:

- automatic pro-rata allocation is **unavailable**;
- **no 50/50 or other fallback split** is invented;
- the Seller and the Promoter are **not automatically assessed**;
- allocation requires a **governed responsibility determination** or an
  **applicable versioned policy rule**;
- **if no such rule applies, Monacado bears the Monacado Chargeback Fee.**

The zero-denominator rule affects **only** the Monacado Chargeback Fee. It does
not alter reversal / recovery of the original transaction economics (§25.1).

Each allocation **preserves**:

- policy version;
- fee amount;
- Seller economic benefit;
- Promoter economic benefit;
- allocation basis;
- calculated shares;
- responsibility category;
- override reason and evidence, if any.

### §27 Provider / network dispute fee

- The processor / network dispute fee (§25, concept **C**) is **separate** from
  the original transaction reversal (§25.1) and from the Monacado Chargeback Fee
  (§25.2).
- It is **currently a Monacado operating expense**, borne by Monacado unless
  future explicit policy changes that treatment.
- **Participant liability is never inferred merely because the processor charged
  Monacado.**
- Future explicit policy may revise this treatment.

---

## Part VII — Platform governance

### §28 Policy versions

- **The Marketplace Policy is versioned.**
- **Draft text is not automatically active.** Activation is a separate governed
  act.
- Versions **1.1.0 and 1.2.0 are intermediate drafts.**
- The next intended **active** version is a **reconciled 1.3.0 or later.**
- An older version is **never activated merely to preserve sequence.**

### §29 Email transport

- **Google Workspace SMTP is the Production transport.**
- **Postmark references are historical.**
- Policy remains **provider-neutral**.
- **Bounce and complaint suppression is required before live commerce.**
- The current **SMTP-native bounce / complaint ingestion gap remains open** (§34).

### §30 AgentNet

- The **Publisher and Registrar are logically and credentially separated.**
  **Users receive neither credential.**
- **Public capsules contain governed public facts only.**
- **Private economics, Orders, payments, refunds, disputes, payouts, and Buyer
  data are not public AgentNet truth.**
- **Internal IDs and application refs are not AgentNet identities** (§3).
- **Publication receipts are evidence of a publication result**, not authority
  over marketplace truth.
- **Public Product publication requires** governed public marketplace identity
  (§5) **and** a governed public Creator identity.
- **No synthetic, placeholder, or unknown Creator Nodes.**

### §31 Digital delivery and payouts

**Digital delivery**

- **Durable entitlement plus controlled short-lived access.** The entitlement is
  the right; an access token is transient.
- **No permanent secret URLs.**
- Current policy anticipates **five successful self-service downloads.**
- Digital delivery **remains incomplete** (§34).

**Payouts**

- **A payout obligation is not payout execution.**
- Payout **eligibility, holds, reserves, caps, and recovery** must be governed
  before real payouts.
- **Payout restrictions do not erase amounts owed.**

---

## Part VIII — Maturity, sequencing, and gaps

### §32 Maturity definitions

**Production deployment**

- Running on Production infrastructure and domain.
- **Does not imply real-money commerce.**

**Credible MVP**

- Controlled seed users can complete the core marketplace journey sufficiently to
  demonstrate the product.
- For the initial **Seller-direct MVP**: account / auth · Seller onboarding ·
  Product · Storefront · Listing · pricing · activation · public presentation /
  discovery · checkout / order · applicable fulfillment / delivery.
- **May use controlled or test payment rails.**
- **Promoter self-service is not required** for the earliest Seller-direct MVP
  unless explicitly added.

**Live commerce**

- **Real Buyer funds and real Seller / Promoter obligations are permitted.**
- Requires the applicable **payment, policy, tax, underwriting, capacity, payout,
  dispute, delivery, scheduling, monitoring, suppression, and compliance gates.**

### §33 Roadmap and phase conventions

- The roadmap records **sequencing and status only.** **It creates no business
  authority.**
- A **phase number identifies a work unit**, not a one-to-one commit.
  **Multi-commit phases are valid.**
- **Corrective commits may remain unnumbered.**
- **Phase 1.26** is associated with commit `b9c40e1`.
- Commit `8433355` remains an **unnumbered account-identity correction.**

### §34 Recognized implementation gaps

Recorded as **gaps against this Contract, not as new policy.** Each rule it
names still binds.

| Gap | Governing section |
| --- | --- |
| Listing activation and five-ACTIVE enforcement | §13 |
| Paid Listing-capacity entitlement | §13 |
| Product-library paid entitlement implementation | §10 |
| Wholesale catalog entitlement implementation | §12 |
| Promoter self-service | §14 |
| Economic-principal resolution. **Narrowed by Phase 1.41:** Promotion Authorization refuses self-promotion when the requesting Promoter participant is the participant holding Seller authority over the Product, and re-checks it at approval — the strongest authoritative principal identity available today (one participant per account). **Still open:** a common economic principal across separate accounts remains unresolved until the repository has an authoritative principal-linkage model | §14 |
| Promoted-commerce eligibility enforcement (replaces "Product / Offer promotability enforcement") | §14, §16.3 |
| **Declared first / last-name identity primitive — primitive exists, enforcement open.** `Account.firstName` and `Account.lastName` now exist as declared-name primitives (Phase 1.37), and public registration requires both. They are declarations only; no KYC or name verification is implied. Pre-1.37 accounts may still have NULL declared names. **Still open:** downstream private / public marketplace identity readiness checks must require the declared names where governed; a future account / profile flow is needed if pre-existing accounts must declare or update their names; and Promotion Authorization request implementation still depends on private marketplace identity enforcement. **Narrowed by Phase 1.39:** Product activation now requires nonblank declared first and last names (never `Account.name`). **Narrowed by Phase 1.41:** a Promotion Authorization request — and its approval, re-checked — requires private marketplace identity: a verified email and nonblank declared first and last names (never `Account.name`) | §4, §5, §16.1 |
| Product lifecycle implementation (`INCOMPLETE` / `COMPLETE` / `ACTIVE` / `SUSPENDED`), including **deterministic completeness** derived from governed, versioned requirements, the fact-driven transitions, and suspension reinstatement — which requires preserving **enough suspension context to determine the Product's lifecycle state immediately before suspension**; today Products carry only an internal authoring `recordStatus`. **Narrowed by Phase 1.38:** deterministic `PRODUCT_COMPLETENESS_V1` evaluation from the current source version, Seller Product revision, and the Seller shipping-policy primitive now exist; the lifecycle states, transitions, and suspension reinstatement remain open. **Narrowed by Phase 1.39:** the four states are derived on read (nothing redundant is stored); a completeness loss derives `INCOMPLETE` and a readiness loss `COMPLETE`, permanently for that activation; governed Product suspension and reinstatement exist as a server primitive (`ProductSuspension`, recording the lifecycle and activation in effect immediately before suspension, on a new internal `product:suspend` grant). Product `taxClassification` is Monacado operator authority, assigned or changed only through the staff route `POST /api/internal/products/{productRef}/tax-classification` on a new internal `product:tax-classify` grant — never by the Seller; it is operational readiness, not Product completeness. **Still open:** an operator surface and a Seller notice for Product suspension | §9.1 |
| Product activation as an **explicit Seller act**, including explicit reactivation after lost readiness is restored. **Narrowed by Phase 1.39:** `POST /api/products/{productRef}/activate` is the only path to `ACTIVE`, gated by one readiness evaluator (completeness, Seller authority, verified email, declared names, `ACTIVE` participant and SELLER role, payment `ENABLED`, commerce approval `APPROVED`, no participant suspension, no `product:activate` restriction, tax classification); restored readiness never re-activates. The commerce gate on `ACTIVE` (row below) remains open | §9.2 |
| **Legacy Product `promotable` fact** — retired as a governing requirement and superseded by `resaleAvailability`; implementation use to be migrated / removed. **Narrowed by Phase 1.40:** no resale logic reads it, and the Seller UI no longer asks for or shows it (the draft form sends `false`). **Still open:** the `factPromotable` source-version column, the required `promotable` field of the draft route and Product source-record contract, and the published Product capsule `promotable` field remain as compatibility storage; removing them is a later, publication-governed change | §9.3 |
| Product lifecycle gate on all commerce, seller-direct included | §9.1 |
| Seller-controlled resale availability, including the `ACTIVE`-only gate on setting `AVAILABLE` and **preservation of the recorded state across lifecycle changes**. **Narrowed by Phase 1.40:** the four states exist as a Seller-authoritative Product-wide record (`ProductResaleAvailabilityAct`, default `NOT_OFFERED`, history preserved), set only through `POST /api/products/{productRef}/resale-availability` under Product authority; `AVAILABLE` is refused unless the effective lifecycle is `ACTIVE`; no lifecycle change rewrites the recorded state; resale-effectiveness (`ACTIVE` and `AVAILABLE`) is derived, never stored. Implemented transitions: `NOT_OFFERED → AVAILABLE`, `AVAILABLE → PAUSED / WITHDRAWN`, `PAUSED → AVAILABLE / WITHDRAWN`. **Still open:** re-opening a `WITHDRAWN` Product (undefined by §9.3, refused); the effect of the state on promoted commerce (below) | §9.3 |
| Promotion Authorization request / approve / deny / revoke / cancel / re-request flow and Seller controls, **usable before the Product is `ACTIVE` or `AVAILABLE`**. **Narrowed by Phase 1.41:** implemented as an append-only, per-Product-per-Promoter record (`PromotionAuthorization` request cycles and `PromotionAuthorizationAct` acts; one current relationship per pair, history preserved; no stored authorization boolean; never on a Product source version or published). Request requires private marketplace identity and a PROMOTER role in a drafting status on a participant not suspended or closed — never payment readiness, commerce approval, Product `ACTIVE`, resale `AVAILABLE`, an Offer, a Storefront, or a Listing. Approve / deny / revoke require Seller authority over the Product only; approval re-checks the Promoter's request gate and fails closed. Cancel is Promoter-only, from `REQUESTED` (its request) or `APPROVED` (its participation). Re-request after `DENIED` / `REVOKED` / `CANCELLED` opens a new cycle; approval is never restored. Product lifecycle and resale changes never rewrite a relationship. Seller and Promoter controls are on `/account`. **Still open:** Promoter discovery of Products (the Promoter names a Product by the reference its Seller shared); any future rate limit on repeated requests (§16.1) | §16.1, §16.2 |
| Enforcement of Promotion Authorization on promoted commerce. **Narrowed by Phase 1.41:** the consumable helper `isPromotionAuthorizationApprovedIn` (current cycle `APPROVED` for this Product + Promoter) exists; nothing commercial calls it yet, and it is never sufficient alone | §16.3 |
| Pause, withdrawal, and revocation propagation to promoted commerce | §16.4 |
| **Unresolved architecture:** the broader Listing-versus-Storefront-placement model is not yet reconciled with §9–§16 Storefront independence. Listing / Storefront coupling: the current promoted path is authorized by the PROMOTER role, Storefront placement authority, and the Offer's `PROMOTABLE` terms, with no Promotion Authorization, Product lifecycle, or resale-availability gate | §11, §16.3 |
| Offer-change propagation to promoted Listings | §19 |
| Public Storefront / browse / search | §11, §32 |
| Payout execution | §31 |
| Digital delivery | §31 |
| Live Stripe mode | §32 |
| Tax operating posture | §21 |
| Activation / review UI | §5, §7 |
| Refund-request routes | §22 |
| SMTP bounce / complaint ingestion | §29 |
| Complete AgentNet publication readiness | §30 |
| Admin / operator UI | §8, §23 |

**Sequencing constraint.** Retail Listing activation (§13, §15) may not be
implemented until these gaps are closed, because each is a precondition of the
commerce it enables:

1. declared first / last-name enforcement in the applicable private / public
   marketplace identity readiness checks (§4–§5);
2. Product lifecycle (§9.1);
3. Product activation (§9.2).

This constrains order only; it assigns no phase numbers (§33).

---

## Appendix — Ruling traceability

Documentation Governance 2A rulings and where each is encoded.

| Ruling | Subject | Section |
| --- | --- | --- |
| A | Document authority | §1 |
| B | Architecture | §3 |
| C | Private marketplace identity | §4 |
| D | Public marketplace identity | §5 |
| E | Automated / bot participants | §6 |
| F | Products and private library capacity | §9, §10 |
| G | Storefronts | §11 |
| H | Wholesale-only Sellers | §12 |
| I | Wholesale catalog capacity | §12 |
| J | Listings and Storefront capacity | §13 |
| K | Seller-direct vs promoted | §14 |
| L | Promoted Listing eligibility | §14 |
| M | Price authority | §15 |
| N | Offer authority | §16 |
| O | Promoter economics | §18 |
| P | Material Offer changes | §19 |
| Q | Merchant of Record | §17 |
| R | Checkout / Orders | §20 |
| S | Tax | §21 |
| T | Refunds | §22 |
| U | Disputes | §23 |
| V | Dispute reason classification | §24 |
| W | Chargeback Fee | §25 |
| X | Chargeback Fee allocation | §26 |
| Y | Provider / network dispute fee | §27 |
| Z | Activation / email / support | §7 |
| AA | Policy versions | §28 |
| AB | Email transport | §29 |
| AC | Restrictions / suspension / closure | §8 |
| AD | AgentNet | §30 |
| AE | Digital delivery / payouts | §31 |
| AF | Maturity definitions | §32 |
| AG | Roadmap / phase conventions | §33 |
| AH | Recognized implementation gaps | §34 |
| AI | Contract amendment | §2 |

Documentation Governance 2C rulings:

| Ruling | Subject | Section |
| --- | --- | --- |
| 1 | Product lifecycle | §9.1 |
| 2 | Product activation | §9.2 |
| 3 | Seller-controlled resale availability | §9.3 |
| 4 | Offer | §16 |
| 5 | Promotion Authorization | §16.1 |
| 6 | Seller control | §16.2 |
| 7 | Promoted-commerce eligibility | §16.3, §14 |
| 8 | Revocation effect | §16.4 |
| 9 | Pause effect | §16.4 |
| 10 | Storefront independence | §11 |
| 11 | Document authority | `DOCUMENT_AUTHORITY.md` §3 |
| 12 | Recognized gaps | §34 |
| 2C-R1 | Retire Product `promotable` | §9.3, §34 |
| 2C-R2 | Product vs Offer availability | §16 |
| 2C-R3 | Product lifecycle transitions | §9.1 |
| 2C-R4 | `AVAILABLE` requires Product `ACTIVE` | §9.3 |
| 2C-R5 | Promotion Authorization edges | §16.1 |
| 2C-R6 | Listing / Storefront model left unresolved | §11, §34 |
| 2C-R7 | Implementation sequence | §34 |
| 2C-F1 | Resale availability preserved across lifecycle changes | §9.3 |
| 2C-F2 | Product completeness is derived | §9.1 |
| 2C-F3 | Explicit activation and reactivation | §9.1, §9.2 |
| 2C-F4 | Promotion Authorization may precede commerce readiness | §16.1 |
| 2C-F5 | Declared-name prerequisite | §34 |
| 2C-F6 | Storefront-activation question retired; placement architecture unresolved | §11, §34 |
| 2C-F7 | Gaps | §34 |
| 2C-S1 | Suspension reinstatement never creates `ACTIVE` authority | §9.1, §9.2, §34 |
