# Document Authority

**Status:** canonical companion to
[`MONACADO_PROJECT_CONTRACT.md`](MONACADO_PROJECT_CONTRACT.md) (Contract §1).
**Installed:** Documentation Governance 2A, against `main` at `e717985`.

This document states which document governs what, and classifies every
substantive document under `docs/`. It changes no document it classifies:
reconciling stale content is later work, and until it is done **this Contract
governs over any conflicting statement below it.**

## 1. Hierarchy

| Level | Authority | Documents |
| --- | --- | --- |
| 1 | **Project Contract** | [`MONACADO_PROJECT_CONTRACT.md`](MONACADO_PROJECT_CONTRACT.md) |
| 2 | **Binding architecture ADRs** | [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) · [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md) |
| 3 | **Governing detail** — incorporated by the Contract, each for its named domain only | §3 below |
| 4 | **Implementation specs / executable contracts** — phase specs plus the typed contracts, schema, and tests that encode them | §4 below |
| 5 | **Roadmap / status** | §5 below |
| 6 | **Historical phase records and commit history** | §6 below; `git log` |
| 7 | **Original Thesis / CDD source documents** — product-origin and conceptual history unless explicitly incorporated | §6 below |

## 2. Rules

- **Recency alone confers no authority.**
- **Code and database prove implementation state, not policy authority.**
- **A lower level may refine a higher level but never contradict it.**
- **Unresolved conflict between documents at the same level is a STOP** — surface
  it for an explicit ruling; do not resolve it in implementation.
- **The Thesis is no longer the current governing commercial model.**
- A governing detail document governs **only its named domain**. Outside that
  domain it is an implementation record (level 4).
- Where a document's status line calls itself "binding" or "authoritative", that
  claim is read **subject to this hierarchy**: it binds within its level and
  domain, beneath the Contract and the ADRs.
- Code is **not** changed merely to match a lower-authority document that is stale
  against the Contract (Contract §2).

## 3. GOVERNING DETAIL

Incorporated by the Contract for the domain named. Known divergences from the
Contract are listed; the Contract prevails on each.

| Document | Domain governed | Known divergence from the Contract |
| --- | --- | --- |
| [`SOURCE_VERSION_RETENTION_AND_ARCHIVAL_POLICY.md`](SOURCE_VERSION_RETENTION_AND_ARCHIVAL_POLICY.md) | Storage, retention, and archival of authoritative source versions | — |
| [`MONACADO_MOR_BUSINESS_MODEL.md`](MONACADO_MOR_BUSINESS_MODEL.md) | Merchant-of-Record role, wholesale-acquisition economics, seller-direct and promoted transaction economics, JIT inventory, tax/shipping basis exclusion | §I defers returns/chargebacks to later design; now governed by Contract §22–§27 |
| [`MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md`](MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md) | Accounts, participants, roles, activation lifecycle, capability decisions, review authority | Predates the private / public marketplace identity definitions (Contract §4–§5) |
| [`PAYMENT_PROVIDER_ONBOARDING_AND_ACTIVATION.md`](PAYMENT_PROVIDER_ONBOARDING_AND_ACTIVATION.md) | Payment readiness, provider onboarding, governed activation records | — |
| [`VERSIONED_COMMERCIAL_POLICY_AND_ACTIVATION_RISK.md`](VERSIONED_COMMERCIAL_POLICY_AND_ACTIVATION_RISK.md) | Versioned commercial (wholesale-acquisition) policy records; activation risk records | — |
| [`MARKETPLACE_ASSORTMENT_AND_LISTING_RULES.md`](MARKETPLACE_ASSORTMENT_AND_LISTING_RULES.md) | Placement rules, active-Listing capacity, multi-Storefront placement, promotability, economic-principal classification | **§1 ("any number of Products", "no free-plan limit") is superseded** by Contract §10 Product library tiers; **§7–§8.3 promotability** (the Product `promotable` fact plus Offer terms, open to any independent Promoter) is **superseded**: the `promotable` fact is retired in favor of Contract §9.3 `resaleAvailability`, and promotion also requires §16.1 Promotion Authorization |
| [`AUTHORITATIVE_OFFER_SOURCE_MODEL.md`](AUTHORITATIVE_OFFER_SOURCE_MODEL.md) | Offer authority, terms, wholesale and commission, Offer source versions | Contains a **pre-Merchant-of-Record promoter economics formula** that does not account for Monacado's retained amount and permits economics inconsistent with the current governing model; Contract §17–§18 control. Also states that Promoters may select promotable Offers with no Seller **Promotion Authorization**; Contract §16–§16.3 control |
| [`AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md`](AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md) | Storefront authority, governance, lifecycle, Storefront source versions | Predates Contract §11 additional-Storefront prerequisites |
| [`LISTING_SOURCE_MODEL.md`](LISTING_SOURCE_MODEL.md) | Listing authority, seller-direct / promoted union, retail price authority | **Promoted Listing eligibility** is governed by Contract §14: eligible promotional Offer terms alone are insufficient — Product resale availability (`AVAILABLE`, which supersedes the retired Product `promotable` fact) and distinct economic principals are also required. Its promoted pathway also lacks the **Promotion Authorization**, Product lifecycle `ACTIVE`, and resale-availability `AVAILABLE` gates; Contract §16.3 controls |
| [`NOTIFICATION_OBLIGATION_RECORDS.md`](NOTIFICATION_OBLIGATION_RECORDS.md) | Notification obligations as records distinct from delivery | — |
| [`MARKETPLACE_POLICY_ACCEPTANCE_AND_SUPPORT_CONTACTS.md`](MARKETPLACE_POLICY_ACCEPTANCE_AND_SUPPORT_CONTACTS.md) | Marketplace Policy versioning and acceptance; Seller support contacts and their verification | Version activation sequence now governed by Contract §28 |
| [`PRE_LIVE_COMMERCE_CONTROLS.md`](PRE_LIVE_COMMERCE_CONTROLS.md) | Live-commerce gates, transaction risk gate, payout hold, digital-delivery policy | — |
| [`PRODUCTION_TAX_INTEGRATION.md`](PRODUCTION_TAX_INTEGRATION.md) | Tax classification, ship-to sourcing, exemption refusal, tax readiness posture | — |
| [`MARKETPLACE_REFUND_GOVERNANCE_AND_RECEIPTS.md`](MARKETPLACE_REFUND_GOVERNANCE_AND_RECEIPTS.md) | Refund governance rules and the receipt contract | Marketplace Policy 1.1.0 described here is an intermediate draft (Contract §28) |
| [`PRODUCT_COMPLETENESS_PROFILE.md`](PRODUCT_COMPLETENESS_PROFILE.md) | Product completeness — the versioned profiles of required Seller-authoritative facts (initial `PRODUCT_COMPLETENESS_V1`) from which Contract §9.1 completeness is derived | — (installed by Documentation Governance 2D). Implementation notes: no Seller shipping-policy primitive and no Seller Product-revision path exist yet; `recordStatus = authoring-complete` ([`PRODUCT_SOURCE_RECORD_MAPPING.md`](PRODUCT_SOURCE_RECORD_MAPPING.md)) is **not** a completeness predicate; `generalAvailabilityState` is not a completeness requirement and its use as a Listing blocking reason ([`LISTING_SOURCE_MODEL.md`](LISTING_SOURCE_MODEL.md) §13) awaits reconciliation with the Product lifecycle model |

## 4. IMPLEMENTATION SPEC

Phase specifications and executable contracts. Authoritative for **how** a
mechanism works, never for business policy.

| Document | Subject |
| --- | --- |
| [`PRODUCT_CAPSULE.md`](PRODUCT_CAPSULE.md) | Product capsule semantic shape (0B.1) |
| [`PRODUCT_SOURCE_RECORD_MAPPING.md`](PRODUCT_SOURCE_RECORD_MAPPING.md) | Product source record ↔ capsule mapping (0C) |
| [`PRODUCT_PERSISTENCE.md`](PRODUCT_PERSISTENCE.md) | Product source-record persistence (0D) |
| [`PRODUCT_NODE_PERSISTENCE.md`](PRODUCT_NODE_PERSISTENCE.md) | AgentNet Product Node persistence (0E.1) |
| [`PRODUCT_PUBLICATION_PREPARATION.md`](PRODUCT_PUBLICATION_PREPARATION.md) | Publication record and atomic outbox (0E.2) |
| [`PRODUCT_PUBLICATION_OUTBOX_PROCESSING.md`](PRODUCT_PUBLICATION_OUTBOX_PROCESSING.md) | Outbox state transitions (0E.3) |
| [`PRODUCT_REGISTRAR_RECEIPTS.md`](PRODUCT_REGISTRAR_RECEIPTS.md) | Registrar receipts and reconciliation (0E.4) |
| [`PRODUCT_PUBLICATION_LEASE_RECOVERY.md`](PRODUCT_PUBLICATION_LEASE_RECOVERY.md) | Outbox lease recovery (0E.5.1) |
| [`PRODUCT_PUBLICATION_REMEDIATION.md`](PRODUCT_PUBLICATION_REMEDIATION.md) | Publication remediation (0E.5.2) |
| [`PRODUCT_PUBLICATION_SUBMISSION_ATTEMPTS.md`](PRODUCT_PUBLICATION_SUBMISSION_ATTEMPTS.md) | Submission attempts and receipt binding (0E.5.3) |
| [`PRODUCT_REGISTRAR_TRANSPORT.md`](PRODUCT_REGISTRAR_TRANSPORT.md) | Registrar REGISTER transport (0E.6.1) |
| [`PRODUCT_REGISTRAR_RUNTIME_CONFIGURATION.md`](PRODUCT_REGISTRAR_RUNTIME_CONFIGURATION.md) | Registrar runtime configuration (0E.6.2) |
| [`PRODUCT_PUBLICATION_SINGLE_RUN_ORCHESTRATION.md`](PRODUCT_PUBLICATION_SINGLE_RUN_ORCHESTRATION.md) | Single-run orchestration (0E.6.3) |
| [`PRODUCT_REGISTRAR_RECEIPT_INGESTION.md`](PRODUCT_REGISTRAR_RECEIPT_INGESTION.md) | Receipt ingestion (0E.6.4) |
| [`PRODUCT_PUBLICATION_WORKER_CYCLE.md`](PRODUCT_PUBLICATION_WORKER_CYCLE.md) | Bounded worker cycle (0E.7.1) |
| [`PRODUCT_PUBLICATION_WORKER_ENTRYPOINT.md`](PRODUCT_PUBLICATION_WORKER_ENTRYPOINT.md) | Worker entry point (0E.7.2) |
| [`PRODUCT_PUBLICATION_WORKER_STATUS_AND_HEALTH.md`](PRODUCT_PUBLICATION_WORKER_STATUS_AND_HEALTH.md) | Worker-run status and health (0E.7.3) |
| [`PRODUCT_PUBLICATION_WORKER_INTERNAL_STATUS_SERVICE.md`](PRODUCT_PUBLICATION_WORKER_INTERNAL_STATUS_SERVICE.md) | Internal status service (0E.7.4.1) |
| [`IDENTITY_SESSION_AND_INTERNAL_ENTITLEMENT_FOUNDATION.md`](IDENTITY_SESSION_AND_INTERNAL_ENTITLEMENT_FOUNDATION.md) | Account, session, internal entitlement (0E.7.4.2A) |
| [`PRODUCT_PUBLICATION_WORKER_INTERNAL_STATUS_ROUTE.md`](PRODUCT_PUBLICATION_WORKER_INTERNAL_STATUS_ROUTE.md) | Internal status route (0E.7.4.2B) |
| [`OFFER_CAPSULE_PROJECTION_SHAPE.md`](OFFER_CAPSULE_PROJECTION_SHAPE.md) | Offer Capsule Projection Shape (0M.2B/2C) |
| [`STOREFRONT_CAPSULE_PROJECTION.md`](STOREFRONT_CAPSULE_PROJECTION.md) | Storefront Capsule Projection Shape (0M.3B) |
| [`STOREFRONT_PERSISTENCE.md`](STOREFRONT_PERSISTENCE.md) | Storefront persistence and governance (0M.3C) |
| [`LISTING_CAPSULE_PROJECTION.md`](LISTING_CAPSULE_PROJECTION.md) | Listing Capsule Projection Shape (0M.4B) |
| [`PARTICIPANT_PERSISTENCE.md`](PARTICIPANT_PERSISTENCE.md) | Participant persistence and draft onboarding (0M.5); its `ParticipantProfile.emailVerifiedAt` is a legacy / deprecation candidate (Contract §7) |
| [`OFFER_PERSISTENCE.md`](OFFER_PERSISTENCE.md) | Offer persistence (0M.6) |
| [`LISTING_PERSISTENCE.md`](LISTING_PERSISTENCE.md) | Listing persistence (0M.7) |
| [`MOR_TRANSACTION_ACCOUNTING_FOUNDATION.md`](MOR_TRANSACTION_ACCOUNTING_FOUNDATION.md) | Per-sale economic snapshot and settlement structure (0M.T1) |
| [`BUYER_CHECKOUT_ORDER_AND_POST_SALE_FOUNDATION.md`](BUYER_CHECKOUT_ORDER_AND_POST_SALE_FOUNDATION.md) | Checkout, Order, and post-sale foundation (0M.9) |
| [`EXECUTABLE_CHECKOUT_AND_STRIPE_TEST_MODE.md`](EXECUTABLE_CHECKOUT_AND_STRIPE_TEST_MODE.md) | Stripe test-mode checkout (1.0) |
| [`ORDER_EXPIRY_AND_BUYER_NOTIFICATION_DELIVERY.md`](ORDER_EXPIRY_AND_BUYER_NOTIFICATION_DELIVERY.md) | Order expiry and buyer notices (1.1) |
| [`POLICY_BOOTSTRAP_AND_VERIFICATION_EMAIL_DELIVERY.md`](POLICY_BOOTSTRAP_AND_VERIFICATION_EMAIL_DELIVERY.md) | Policy bootstrap and verification email delivery (1.4) |
| [`PRODUCTION_COMMUNICATIONS_AND_NOTIFICATION_DELIVERY.md`](PRODUCTION_COMMUNICATIONS_AND_NOTIFICATION_DELIVERY.md) | Durable email delivery and suppression (1.5); **Postmark content is historical** — Google Workspace SMTP is the Production transport (Contract §29) |
| [`TAX_TRANSACTION_RECORDING_AND_PRIVATE_CAPSULE.md`](TAX_TRANSACTION_RECORDING_AND_PRIVATE_CAPSULE.md) | Tax transaction recording and private tax capsule (1.7) |
| [`TAX_RECORDING_OPERATIONS.md`](TAX_RECORDING_OPERATIONS.md) | Tax recording operations and recovery (1.8) |
| [`REFUNDS_AND_TAX_REVERSALS.md`](REFUNDS_AND_TAX_REVERSALS.md) | Refund and tax-reversal execution (1.9) |

## 5. ROADMAP / STATUS

Sequencing and status only. Creates no business authority (Contract §33).

| Document | Note |
| --- | --- |
| [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md) | Marketplace sequence and phase status. Its phase table ends at `1.11` and its detailed entries at `1.10`; later phases through `1.36` are not yet reflected. Not updated in this pass. Its Postmark references are historical (Contract §29). |
| [`PRODUCT_PUBLICATION_WORKER_OPERATIONS_TRACK.md`](PRODUCT_PUBLICATION_WORKER_OPERATIONS_TRACK.md) | Status and closure record of the 0E.7 track |

## 6. HISTORICAL / SUPERSEDED

| Document | Status |
| --- | --- |
| `Monacado_New_Thesis_and_Initial_Site_Map.docx` | **Product-origin history.** No longer the current governing commercial model. Authoritative only where the Contract or an ADR explicitly incorporates it. |
| `Capsule_Driven_Development_Intro_Cover.docx` | **Conceptual history** of Capsule-Driven Development, wherever the ADRs or the Contract scope or supersede it — in particular, capsule canonicality is scoped by ADR §12: the database is the sole source of truth. |
| `MARKETPLACE_ASSORTMENT_AND_LISTING_RULES.md` §1 | **Superseded** by Contract §10 (Product library tiers). The rest of that document remains governing detail (§3). |

Historical phase records also include each spec's narrative of what was true at
its own phase, and the commit history (level 6).

## 7. Non-document references

| File | Role |
| --- | --- |
| `monacado-color-palette.png` | Approved visual palette reference. Not a policy document. |
| [`README.md`](README.md) | Index of this directory. Confers no authority. |
