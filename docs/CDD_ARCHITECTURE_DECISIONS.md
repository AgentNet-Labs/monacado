# Monacado — CDD Architecture Decisions

Status: **Binding** for all subsequent Monacado phases (0B onward).
Phase: 0A.1 — Resolve CDD Architecture Conflicts.
Scope of this document: architecture decisions only. It introduces no
application, domain, ontology, schema, or test code.

For this project, **CDD** means **Capsule-Driven Development**.

These rulings reconcile the two governing documents under `docs/`:

- `Capsule_Driven_Development_Intro_Cover.docx` — the CDD methodology.
- `Monacado_New_Thesis_and_Initial_Site_Map.docx` — the Monacado product,
  authority, activation, and production thesis.

Where a later phase would contradict a ruling here, it must surface the
conflict for an explicit new ruling rather than implement around it.

---

## 1. Persistence model — dual representation

Descriptive, publishable entities use a **dual representation**. This applies to:

- Product
- Storefront
- Creator
- Promoter
- Listing
- Offer

For these entities:

- The **versioned capsule is the canonical semantic representation.**
- **Normalized relational records are the operational persistence
  representation**, responsible for integrity, authorization, indexing,
  querying, joins, and transactional consistency.

Requirements (binding):

1. Relational state and the corresponding capsule version are created or updated
   as **one governed write operation** — never as two independently committable
   steps that can diverge.
2. The capsule is **generated at authoring or update time**, not invented later
   only for publication.
3. Reconstruction of the same capsule from the corresponding relational record
   version must be **deterministic** — same relational version in, byte-stable
   capsule out.
4. The stored capsule carries a **version** and a **content hash**.
5. Public entity UI consumes **validated capsule-shaped data** (see §7).
6. AgentNet publication **registers the existing capsule** — it must not create a
   separate semantic payload (see §5).

Financial and transactional records remain **relational-first** and are **not**
canonical entity capsules:

- orders
- payments
- commissions
- refunds
- disputes
- balances
- payouts

Separate **event capsules** may be introduced later where useful, but this
document does not authorize them yet.

> Reconciliation note: this ruling is what resolves the apparent conflict
> between the CDD document's "capsule as canonical semantic model" and the
> thesis's "database as operational system of record" (thesis §6.4). Both hold,
> for different responsibilities, over the same entity. See §9.

---

## 2. Capsule granularity and authority

Use **one enduring node identity per real-world entity**, with **separate
capsules for distinct authorities and relationships**. A single flat capsule
must not carry mixed-authority assertions.

For a Product, the node identity is composed of these capsules:

| Capsule | Authority | Carries |
| --- | --- | --- |
| **Product capsule** | Creator | Creator-authoritative product facts. |
| **Listing capsule** | Promoter / storefront | Curation, commentary, placement, audience framing. |
| **MarketplaceVerification capsule** | Monacado | Activation, verification, marketplace status, sale-enabled status. |
| **Review capsule** | Buyer | Buyer-authored observation. |
| **Offer capsule** | Creator | Creator-authorized commercial terms. |

Each capsule has its own:

- authority
- provenance
- lifecycle
- version
- supersession behavior
- revocation behavior

Consumers may **compose** these capsules around the same node identity, but must
never collapse one authority into another. A promoter's Listing capsule must not
restate or override the creator's Product facts; Monacado's
MarketplaceVerification capsule must not be authored as if it were a creator
claim.

> This makes explicit the split authority model in thesis §4.2 and §6.2. A flat
> Appendix-C-style Product capsule with a single `provenance.createdBy` cannot
> express it, so the entity is partitioned by (entity × authority).

---

## 3. Canonical identity

Use **stable HTTPS IRIs with opaque ULIDs.**

Preferred pattern:

```
https://monacado.com/id/{entity-type}/{ulid}
```

Examples:

```
https://monacado.com/id/product/{ulid}
https://monacado.com/id/storefront/{ulid}
https://monacado.com/id/creator/{ulid}
https://monacado.com/id/promoter/{ulid}
https://monacado.com/id/listing/{ulid}
```

Rules (binding):

- `entity-type` segments are **lowercase**.
- Identifiers are **opaque** — ULIDs only.
- **No mutable names or slugs** appear in canonical identity.
- Identifiers are **never reused**.
- The node IRI **survives** renaming, withdrawal, supersession, and retirement.
- A node IRI identifies the **enduring entity**, not a specific capsule version.

Keep these **four things separate**, and never let one stand in for another:

1. **Enduring node identity** — the HTTPS IRI above.
2. **Capsule-version identity** — identifies one version of one authority's
   capsule for that node.
3. **Human-facing page URL** — may contain slugs and may change freely.
4. **Purchase / checkout endpoint** — an operational endpoint, not an identity.

A `monacado:` compact identifier may later be provided as an **alias**, but the
HTTPS IRI is canonical.

> **Do not publish any identity externally until Monacado confirms control of
> the selected production domain and its resolution behavior.** `monacado.com`
> here is a design target, not a claim of live resolution.

---

## 4. Monacado ontology and JSON-LD context

Monacado will define a **small, versioned commerce ontology** for concepts not
adequately covered by established vocabularies.

- The **ontology** defines semantic meaning.
- The **JSON-LD context** maps compact JSON terms to schema.org and Monacado
  ontology IRIs.

Use **schema.org where its meaning fits exactly.** Do not redefine established
terms, including:

`Product`, `Offer`, `Person`, `Organization`, `name`, `description`, `image`,
`price`, `priceCurrency`, `availability`.

Create Monacado ontology terms **only for genuine Monacado concepts**, such as:

`Promoter`, `StorefrontListing`, `MarketplaceVerification`, `promotable`,
`promoterCommissionRate`, `listedInStorefront`, `attributedStorefront`,
`marketplaceActivationStatus`, `agentNetPublicationStatus`,
`commissionEligibility`.

Provisional **planned** locations (design targets only — not yet hosted):

- Ontology namespace: `https://monacado.com/ns/commerce#`
- Ontology document: `https://monacado.com/ontology/commerce/v1`
- JSON-LD context: `https://monacado.com/context/commerce/v1`

> These are **not** live, resolvable, immutable, or approved AgentNet standards.
> The CDD document's own examples declare `"@context": "https://schema.org"` yet
> use `promotable`/`commission`/`provenance` (terms schema.org does not define);
> the Monacado context is what will make such terms valid linked data.

Versioning rule:

- Keep the **ontology namespace independent of a document version**, so
  compatible document revisions do not change term identity.
- A term receives a **new IRI only when its meaning changes incompatibly.**

**Phase 0B introduces only the ontology terms needed for the first Product
capsule** — nothing more.

---

## 5. Capsule generation and publication timing

**Generation** and **publication** are distinct.

- **Capsule generation** occurs **immediately**, during the governed authoring or
  update operation (§1). This preserves the CDD principle that meaning is
  produced as a by-product of building the feature.
- **AgentNet publication is separate and gated.** A capsule may exist internally
  in **draft** form before it is eligible for public publication.

Publication may occur **only after** all applicable gates:

- lifecycle readiness
- Monacado review
- verification
- commercial activation
- applicable Stripe capability checks
- publication validation
- approval routing

Constraints (binding):

- Creators and promoters **do not receive AgentNet publishing credentials.**
- Future publication must be **durable, asynchronous, idempotent, receipt-based,
  retryable, and reconcilable.**
- **Do not place a live synchronous AgentNet call inside an ordinary
  entity-save request.**

> This is the point where the thesis controls. The CDD case study (§5) implies a
> listing is published the moment it is entered; the thesis (§6.3, §6.5, §11)
> gates publication behind activation and forbids user-held publishing
> credentials. The thesis wins; generation-vs-publication separation preserves
> both. See §9.

---

## 6. Capsule structure

Treat **Appendix C of the CDD document as the initial structural baseline.**

A capsule may include:

- `@context`
- `@type`
- `@id`
- `name`
- `description`
- `image`
- `data`
- `provenance`
- `relationships`
- `metadata`

The shorter examples elsewhere in the CDD document (e.g. §5 / §8.1, which put
`price`/`promotable`/`commission` at top level) are **illustrative and do not
override** the Appendix C structure.

Recognized ontology properties should be placed **according to the eventual
ontology and context design** (§4), not by mechanically nesting every field
under `data`.

---

## 7. React binding

- **Do not build a custom `data-bind` DOM runtime.** The declarative
  `data-bind` mechanism in CDD §4.2 / §8.2 is illustrative.
- A **validated capsule-shaped object passed directly into a typed React
  component** satisfies the CDD binding principle (CDD §4.2 explicitly permits
  reactive framework bindings).
- **Do not create duplicate Product view models or DTOs** that restate the same
  semantics. The capsule shape is the shape the UI consumes.

---

## 8. Executable schema and source-of-truth rule

- **Do not generate Zod from JSON Schema.**
- **Do not hand-maintain duplicate JSON Schema and Zod definitions.**

The complete **versioned capsule specification** consists of coordinated
artifacts:

| Artifact | Responsibility |
| --- | --- |
| JSON-LD ontology & context | Semantic meaning |
| **Zod schema** | Executable structure & runtime validation (**authored source**) |
| Authority policy | Who may assert or modify each field |
| Lifecycle policy | Valid states and transitions |
| Relational mapping | Operational persistence & deterministic reconstruction (§1) |
| Generated JSON Schema | **Derived** structural interoperability artifact |
| Tests | Proof that all of the above remain aligned |

Source-of-truth rules (binding):

- Author the **Zod capsule schema once.**
- **Infer TypeScript types from Zod.**
- **Generate JSON Schema from Zod** where useful. JSON Schema is **derived and
  is not a separate source of truth.**
- **Zod does not replace the ontology or JSON-LD context.** It validates
  structure; the ontology/context carries meaning.

> This satisfies the standing constraint that Zod may validate capsules but must
> not become a competing source of truth, and thesis §7.2's requirement for
> machine-checkable shape contracts — one authored schema, everything else
> derived from it.

---

## 9. Conflict resolution between the source documents

Recorded explicitly and binding:

1. **The CDD document governs the meaning of Capsule-Driven Development** — what
   a capsule is, its structure, and the generation/binding/registration
   lifecycle.
2. **The Monacado thesis governs marketplace-specific authority, activation,
   privacy, payment, operational, and production constraints.**
3. **The dual-representation persistence ruling (§1) reconciles** the apparent
   conflict between "capsule as canonical semantic model" (CDD) and "database as
   operational system of record" (thesis §6.4). Both are true, over different
   responsibilities for the same entity.
4. **The thesis controls publication gating** (§5) where the earlier CDD
   examples imply immediate publication.
5. **No unresolved material conflict may be silently implemented.** A phase that
   encounters one stops and requests a ruling.

---

## 10. Phase 0B ratifications (Product capsule)

These rulings were left open at the end of §§1–9 and are now binding. They
refine, and do not replace, the earlier decisions.

### 10.1 Capsule-version IRI

The canonical Product capsule-version IRI is:

```
https://monacado.com/id/product/{ulid}/capsule/{n}
```

- The Product **node IRI** remains `https://monacado.com/id/product/{ulid}`.
- `{n}` is a **positive, monotonically increasing integer** within that Product
  node.
- A capsule-version IRI identifies **one immutable semantic version**.
- A revised capsule receives a **new** capsule-version IRI.
- **Supersession references the prior capsule-version IRI** (`supersedes`).
- Published capsule-version IRIs are **never reused or reassigned**.
- This pattern remains **provisional** until the `monacado.com` identity paths
  are actually hosted (see §3 — nothing is published until domain control and
  resolution are confirmed).

The subordinate **`/capsule/{n}` pattern is the preferred default for other
future entity capsule versions** (storefront, creator, promoter, listing,
offer, …) unless a later ADR deliberately changes it.

### 10.2 Product-level general availability

`generalAvailabilityState` is a **Monacado ontology property**. Its purpose is
limited to **broad Product-level lifecycle availability**, not commercial offer
terms. It may represent states such as: `available`, `unavailable`,
`pre-release`, `discontinued`.

It must **not** be used for price, currency, inventory quantity, territory,
discount, sale period, commission, or checkout eligibility. Those belong to
future Offer, inventory, marketplace-verification, or operational records.

**Why not schema.org `availability`:** schema.org `availability` is normally
associated with an **Offer** (`ItemAvailability` on `Offer`). Reusing it at the
Product level would blur the binding Product-versus-Offer boundary (§10.2 relates
directly to the Product/Offer split in §2 and the Phase 0B scope).

### 10.3 Creator relationship

`creator` is a **Monacado commerce-ontology relationship**. It identifies the
creator-authoritative Monacado entity responsible for the Product facts and must
reference a **canonical creator node IRI**
(`https://monacado.com/id/creator/{ulid}`).

It is **not** mapped to schema.org `creator`, because that term does not
precisely express Monacado's marketplace authority relationship. A future
**Creator capsule** will define that node's descriptive and authoritative
representation.

### 10.4 Content hash

The Product capsule content hash is stored at **`provenance.contentHash`**.

The hash input is the **complete validated public capsule** after deterministic
canonical JSON serialization, **excluding only `provenance.contentHash`** itself
(to prevent circularity).

**Included:** `@context`, `@type`, `@id`, capsule version, `subject`, semantic
Product `data`, `relationships`, provenance other than `contentHash`,
`lifecycle`, timestamps, supersession/revocation data, public `metadata`.

**Excluded:** transient runtime values not present in the capsule, publication
envelopes, relational projections, generated JSON Schema, and
`provenance.contentHash`.

A **meaningful capsule change must produce a new hash**, and generally requires
a **new capsule version** (§10.1).

### 10.5 Forbidden-field safeguard (temporary)

The substring-based forbidden-field scan
(`src/contracts/integrity/forbidden-fields.ts`) is a **temporary Phase 0B
safeguard**. It is acceptable for the current narrow synthetic Product shape and
must not be expanded during Phase 0B.

Before real, extensible `specifications` or `metadata` are accepted, this scan
**must be replaced or supplemented** by explicit allowlisted schemas or
namespace-aware validation, to avoid false positives (legitimate keys containing
substrings like `price`) and semantic ambiguity.

---

## Out of scope for this document

This ADR records decisions only. The Phase 0A.1 sections (§§1–9) introduced no
code; the §10 ratifications accompany the Phase 0B Product capsule
implementation but this file itself remains documentation. No Offer,
persistence, Prisma, React binding, publication worker, or live network code is
authorized by this document.
