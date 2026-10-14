# Monacado — Documentation Index

Read in this order. Authority runs top to bottom; see
[`DOCUMENT_AUTHORITY.md`](DOCUMENT_AUTHORITY.md) for the full classification and
rules.

1. **[`MONACADO_PROJECT_CONTRACT.md`](MONACADO_PROJECT_CONTRACT.md)** — the
   canonical Project Contract. Highest authority for business, economic,
   authority, lifecycle, and compliance rules.
2. **[`DOCUMENT_AUTHORITY.md`](DOCUMENT_AUTHORITY.md)** — the authority hierarchy
   and the classification of every document below.
3. **Binding architecture ADRs**
   - [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md)
   - [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
4. **Governing detail** — incorporated by the Contract, each for one domain:
   [MoR business model](MONACADO_MOR_BUSINESS_MODEL.md) ·
   [account, role, and activation](MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md) ·
   [payment-provider onboarding](PAYMENT_PROVIDER_ONBOARDING_AND_ACTIVATION.md) ·
   [versioned commercial policy](VERSIONED_COMMERCIAL_POLICY_AND_ACTIVATION_RISK.md) ·
   [assortment and Listing rules](MARKETPLACE_ASSORTMENT_AND_LISTING_RULES.md) ·
   [Offer source model](AUTHORITATIVE_OFFER_SOURCE_MODEL.md) ·
   [Storefront source model](AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md) ·
   [Listing source model](LISTING_SOURCE_MODEL.md) ·
   [source-version retention](SOURCE_VERSION_RETENTION_AND_ARCHIVAL_POLICY.md) ·
   [notification obligations](NOTIFICATION_OBLIGATION_RECORDS.md) ·
   [policy, acceptance, and support contacts](MARKETPLACE_POLICY_ACCEPTANCE_AND_SUPPORT_CONTACTS.md) ·
   [pre-live commerce controls](PRE_LIVE_COMMERCE_CONTROLS.md) ·
   [tax integration](PRODUCTION_TAX_INTEGRATION.md) ·
   [refund governance and receipts](MARKETPLACE_REFUND_GOVERNANCE_AND_RECEIPTS.md)
5. **Implementation specs** — phase specs for capsules, persistence, publication,
   checkout, notifications, tax, and refunds. Listed in
   [`DOCUMENT_AUTHORITY.md` §4](DOCUMENT_AUTHORITY.md#4-implementation-spec).
6. **Roadmap / status** —
   [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md) ·
   [`PRODUCT_PUBLICATION_WORKER_OPERATIONS_TRACK.md`](PRODUCT_PUBLICATION_WORKER_OPERATIONS_TRACK.md).
   Sequencing only; creates no business authority.
7. **Historical / superseded material**
   - `Monacado_New_Thesis_and_Initial_Site_Map.docx` — **product-origin history.
     Not the top-level commercial authority**; the Contract governs where they
     differ.
   - `Capsule_Driven_Development_Intro_Cover.docx` — **conceptual history** of
     Capsule-Driven Development (CDD) where the ADRs or the Contract scope or
     supersede it. For Monacado, the database is the sole source of truth and a
     capsule is a deterministic one-way projection (ADR §12).

Also here: `monacado-color-palette.png`, the approved visual palette reference.

## Working rule

Where documents conflict, the higher level governs. An unresolved conflict
between documents at the **same** level is a **stop**: surface it for an explicit
ruling rather than resolving it in implementation.
