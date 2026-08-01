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

- The **versioned capsule is the canonical semantic representation of the exact
  public artifact generated and published from an identified authoritative
  database source version.** **It is never the canonical source of transactional
  truth, authority, provenance, or lifecycle state.**
- **The authoritative database is the sole source of transactional truth.**
  Normalized relational records are not merely an "operational persistence
  representation" — they *are* the truth, responsible for integrity,
  authorization, indexing, querying, joins, transactional consistency, lifecycle,
  authority, provenance, and audit evidence.

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
> for different responsibilities, over the same entity — **and the database's
> responsibility is the truth itself.** The capsule is canonical only for the
> published artifact. See §9 and §12.

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

> **Superseded by ANS Core v2.0 (Phase 0B.1).** The published capsule uses the
> ANS top-level structure — exactly `@context`, `@type`, `metadata`, `data`.
> Identity (`capsuleId`), node binding, publication, versioning, provenance,
> policy linkage, supersession/revocation, and integrity live in `metadata`;
> Product facts live in `data`. There is no top-level `@id`, `name`,
> `description`, `image`, `provenance`, or `relationships`. This §6 list remains
> only as the historical Appendix-C baseline.

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
   responsibilities for the same entity — the capsule is canonical for the
   published artifact, and **the database is the sole source of transactional
   truth** (§12).
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

> **Superseded by ANS Core v2.0 (Phase 0B.1).** The ANS-facing capsule identity
> is an **opaque `capsuleId`** (provisional `an:capsule:{opaque}`), not a
> semantic `/capsule/{n}` IRI, and the node binding is a **Registrar-issued
> opaque ANS Node ID** (`an:node:{opaque}`), not the semantic
> `https://monacado.com/id/product/{ulid}` path (which is retained as an
> **internal** identity only — see §11.5). Capsule **versions are semver
> strings** (`1.0.0`), not integers; each new version gets a new opaque
> `capsuleId`, and `supersedes` references the prior **capsule ID**. The
> `/capsule/{n}` phrasing above is retained only as historical Phase 0B wording.

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

> **Superseded by ANS Core v2.0 (Phase 0B.1).** For the published capsule the
> content hash is stored at **`metadata.contentHash`** and the hash input
> excludes **only `metadata.contentHash`**. The included set is the ANS
> structure — `@context`, `@type`, all of `metadata` (node binding, Publisher,
> `publishedAt`, semver `version`, provenance, policy references,
> supersedes/revokes) except `contentHash`, and `data`. There is no top-level
> `@id`/`subject`/`lifecycle` (capsules carry no lifecycle). The principle
> (meaningful change ⇒ new hash ⇒ new version) is unchanged.

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

## 11. Monacado Walled-Garden AgentNet Operating Model

Binding (Phase 0B.2). Grounded in the Phase 0B.1 ANS Core v2.0 audit. ANS terms
(Publisher, Registrar, Node, Capsule, Authority, Provenance, Policy, Resolver)
are used with their ANS meanings and are not reinterpreted or weakened here.

### 11.0 Core decision and walled-garden definition

Within the Monacado marketplace domain, **Monacado operates as a controlled,
domain-specific "walled-garden" AgentNet implementation** in which **Monacado
acts as both the AgentNet Publisher and the AgentNet Registrar**, and is the
**administrative and trust boundary** for its AgentNet domain.

"**Walled garden**" refers to **governance, admission, authority, and operational
control** — not to non-conformance or semantic isolation. The garden is
**controlled, not semantically isolated**: the implementation **remains
ANS Core v2.0 conformant** and capable of later federation, resolver
interoperability, cross-domain discovery, migration to broader AgentNet
infrastructure, and external conformance testing (see §11.12). No Monacado-only
formats that would prevent those outcomes may be created.

Publisher and Registrar are **separate logical roles** operated by one legal
organisation. They **must not be collapsed into a single undifferentiated
application privilege**. A Publisher action must not implicitly perform a
Registrar action without passing the Registrar's validation and policy gate; a
Registrar action must not alter capsule content or factual claims.

Monacado controls, for its domain: participant admission; Node eligibility; Node
issuance; capsule validation; publication approval; registration; supersession;
revocation; Node retirement; policy enforcement; and audit and reconciliation.
Monacado may publish its own **platform-authoritative** assertions and may
publish **participant-authoritative** assertions **only under stored
authorisation** (§11.6). Acting as Publisher or Registrar **does not make
Monacado the factual authority** for creator-, seller-, promoter-, or
buyer-originated claims.

Five distinct concepts are kept separate throughout:

- **Factual authority** — the entity whose claims a capsule asserts.
- **Source authority** — the governed record/system that is the evidentiary
  origin of those facts.
- **Publisher** — the ANS role that submits and controls capsules (Monacado).
- **Capsule generator** — the operational component that builds a capsule from a
  source record (a delegated task; holds no authority).
- **Verifier** — the party asserting verification (Monacado, for marketplace
  verification, via its own Monacado-authoritative capsules).

Generation or registration **never** confers factual authority (ANS §2
Publisher/Authority; Publisher "MAY delegate operational tasks without
delegating authority").

### 11.1 Publisher role

Monacado, acting as Publisher:

- publishes capsules through **controlled Monacado-held credentials**;
- may publish on behalf of authorised creators, sellers, promoters, storefront
  operators, and other participants — **only** after verifying a stored grant of
  publishing authority (see §11.6);
- **preserves source provenance and the participant's authority**; does **not**
  become the factual authority merely by generating or submitting the capsule;
- may publish **Monacado-authoritative** capsules for marketplace status,
  verification, policy, and platform assertions;
- controls publication, supersession, revocation, and withdrawal workflows;
- retains publication audit records and receipts.

For **creator-authored Product facts, the creator remains the factual/source
authority** and Monacado is the operational Publisher.

### 11.2 Registrar role

Monacado, acting as Registrar:

- issues **opaque, stable, non-semantic** AgentNet Node IDs (ANS §4/§6);
- **prevents publishers or users from selecting Node IDs** (no operator
  influence, direct or indirect);
- binds capsules to Nodes and records the binding;
- manages Node lifecycle (Active, Inactive, Retired, Revoked);
- enforces registration rules and **rejects non-conforming identifiers and
  registrations**;
- records issuance, registration, replacement, revocation, and retirement
  events, and **preserves Node and capsule history**;
- operates the authoritative Node registry for the Monacado domain and
  exposes/supplies the records downstream resolver infrastructure requires.

A Node ID **must not encode** entity type, role, product category, participant
name, storefront name, slug, platform hierarchy, or any business meaning. (This
supersedes, for the ANS-facing Node ID, the semantic `…/id/product/{ulid}`
pattern of §3/§10.1 — see §11.5.)

### 11.3 Separation of duties

Even with one operator, the following are logically distinct and must be
distinguishable in any future implementation:

| Publisher side | Registrar side |
| --- | --- |
| Publisher credential | Registrar credential |
| Publisher authorisation scope | Registrar authorisation scope |
| Publisher audit event | Registrar audit event |
| Publication approval | Node issuance approval |
| Capsule validation | Registration validation |

- A Publisher action **must pass the Registrar's validation and policy gate**
  before any Node binding is treated as registered.
- A Registrar action **must not** modify capsule content, provenance, or factual
  claims (ANS §6: Registrars "SHALL NOT exercise authority over Capsule
  content").

### 11.4 Platform Node

Monacado has its own **Registrar-issued, opaque Platform Node** representing the
Monacado marketplace, platform identity, policy, Monacado-issued marketplace
verification, and its publication/registration relationships.

The words "platform"/"monacado" **must not** appear in the opaque Node ID. The
semantic meaning that the Node *represents Monacado* lives in **capsules bound to
that Node**, never in the identifier (ANS §4: Node IDs non-semantic; all meaning
expressed through Capsules).

### 11.5 Participant and entity Nodes

Preferred direction — each an **independent Node** related to the Platform Node
through capsules and graph relationships (not by identifier nesting):

- Monacado Platform — independent Node.
- Participant identity — independent Node where public AgentNet identity is
  warranted.
- Storefront — independent Node.
- Product — independent Node.
- Creator/seller organisation — independent Node where distinct.
- Promoter — the participant's Node with a promoter role, unless a separate legal
  or commercial identity warrants another Node.
- Guest buyer — **no Node**.
- Ordinary private buyer account — **no public Node by default**.
- Public buyer identity — only with explicit purpose, consent, and policy
  approval.

**"Sub-node" is not an architectural primitive.** Nodes are peers; relationships
are expressed in capsules.

A single **participant Node may hold multiple marketplace roles** — creator,
seller, promoter, storefront operator. **Do not issue separate Nodes solely
because one participant holds multiple roles.** Roles are expressed as capsule
claims and relationships on the participant's one Node; a separate Node is
warranted only when a distinct legal or commercial identity genuinely exists.

This is the ANS-facing reconciliation of §3/§10.1: the Monacado
`https://monacado.com/id/{type}/{ulid}` IRI is retained only as an **internal**
canonical identity; the **ANS Node binding uses the separate Registrar-issued
opaque Node ID**. The two identifier layers are distinct and must not be
conflated.

### 11.6 Publisher authority for participants

Monacado may publish for a participant **only when the source database holds a
valid authorisation record** establishing: participant identity; authority
scope; entity or claims covered; publication permission; effective date;
revocation state; applicable policy. The Publisher role **must check this
authorisation before publication**. **Users receive neither Publisher nor
Registrar credentials.**

### 11.7 Publication and registration flow (future — not implemented now)

1. A governed Monacado source record becomes eligible for AgentNet
   representation.
2. **Stored publication authorisation is checked** (§11.6).
3. The Monacado Registrar issues or resolves the appropriate opaque Node ID.
4. The Node ID is stored in the Monacado database.
5. Monacado generates an ANS-conformant capsule from the source record, bound to
   that Registrar-issued Node ID.
6. The Monacado Publisher submits the capsule.
7. The Registrar validates: identifier; Node binding; policy linkage;
   provenance; capsule structure; versioning; authorisation.
8. The Registrar records the Node–Capsule binding and stores a result/receipt.
9. Resolver-facing infrastructure exposes the registered state according to
   policy.

### 11.8 Source-of-record and provenance

The **Monacado database remains the authoritative source record** for
Monacado-native marketplace facts. Provenance chain:

```
authoritative Monacado source record
  → generated capsule
  → Publisher submission
  → Registrar registration
  → Resolver availability
```

Each capsule must preserve provenance back to: source system; source-record
type; source-record identifier; source-record version; acquisition method;
acquisition timestamp; asserted-or-inferred status (ANS §3 Provenance;
`an:source`/`an:method`/`an:acquiredAt`/`an:assertionKind`, plus Monacado
extensions per the 0B.1 audit). **Registrar issuance and Publisher submission do
not replace source authority.**

### 11.9 Node lifecycle versus capsule replacement

- Node lifecycle is controlled by the **Registrar**.
- **Capsules do not carry Node lifecycle state** (ANS §4 — corrects the current
  capsule `lifecycle` field flagged in the 0B.1 audit).
- Capsule changes use **semantic versioning** with supersession/revocation.
- Node revocation/retirement **does not rewrite prior capsules**.
- Node and capsule histories must remain auditable.

### 11.10 Buyers and privacy

- **Guest buyers receive no AgentNet Node.**
- **Ordinary buyer accounts remain private Monacado database records by
  default** — no public Node.
- A **public Buyer Node requires explicit purpose, consent, and policy
  approval**.
- **Private purchase, payment, shipping, and account data are never published.**
- **Review authorship should use a privacy-preserving pattern** unless a public
  identity is explicitly justified and approved.

### 11.11 Resolver model

Monacado may initially use a **private resolver**, a domain-specific managed
resolver, or another Monacado-controlled resolution surface. The **resolver is a
discovery and retrieval layer, not the source of authority**, and remains
**distinct** from the authoritative Monacado database, the Publisher, the
Registrar, and the source records. **Resolver availability does not confer
factual authority** (ANS §5 — Resolvers MUST NOT modify capsules and MUST
preserve provenance/authority; resolution does not imply endorsement).

### 11.12 Federation (optional, policy-controlled)

Federation is **optional and policy-controlled**. Possible future modes: fully
private Monacado resolution; selective publication to broader AgentNet
infrastructure; managed federation with approved resolvers; public discovery of
selected Nodes/Capsules; private resolution for restricted entities. **No
federation behaviour is implemented in this phase.**

To keep every mode reachable, Monacado-controlled Nodes and Capsules **must
retain**: ANS-compatible opaque Node IDs; ANS metadata; ANS provenance; semantic
capsule versioning; Node Policy and Capsule Policy linkage; authority
separation; immutable publication history; and supersession/revocation
semantics.

### 11.13 Policy (future — not implemented now)

The walled-garden model requires future policy layers for: Platform Node Policy;
entity Node Policy; Capsule Policy; participant publication authorisation;
Registrar issuance policy; publication eligibility; privacy; restricted
categories; revocation and retirement; federation eligibility; and resolver
visibility. **Effective Policy evaluation is required before publication and
registration** (ANS §3 policy linkage/inheritance). No policy evaluation is
implemented in this phase.

### 11.14 Registrar accreditation

Binding. ANS Core v2.0 §6 requires a Registrar to be **accredited**, with
**publicly verifiable** accreditation status. This resolves that open item.

1. **Common founder ownership of AgentNet and Monacado does not, by itself,
   constitute the publicly verifiable Registrar accreditation ANS requires.**
   Accreditation is never inferred from shared ownership or operator identity.
2. **AgentNet's authorised standards or governance authority will formally
   accredit** the Monacado Registrar operation.
3. The **accredited subject** is either **Monacado as the legal/operating
   organisation**, or **a specifically identified Monacado Registrar service**
   operated by that organisation.
4. Accreditation must exist as a **durable governance artifact**, not an inferred
   consequence of founder identity.
5. The accreditation record must eventually identify at least: accreditation
   identifier; accredited organisation or service; accrediting authority; ANS
   version / conformance scope; permitted Registrar domain / operating scope;
   effective date; status; expiration or review date (if applicable);
   restrictions or conditions; revocation or suspension state; and a
   verification / publication location.
6. **Steve Rouse may approve or execute the accreditation in his authorised
   AgentNet capacity, but the accreditation belongs to the organisations and
   operating roles, not to him personally.**
7. **Monacado must not claim accredited Registrar status in production until the
   accreditation record has actually been issued and made verifiable** through
   the selected AgentNet governance mechanism.
8. Future Monacado Registrar configuration must **reference the accreditation
   identifier and status** rather than infer accreditation from ownership or
   operator identity.
9. The precise accreditation document, registry, signature mechanism, and public
   verification endpoint remain **deferred to AgentNet governance work**.

---

## 12. Transactional truth and capsule projection

Binding (Phase 0A.2 — Transactional Truth, Capsule Projection, and Source-Version
Retention). **Additive**: it accompanies the narrow correction made to §1 and
replaces nothing. Full ruling:
[`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md).

**Monacado conducts commerce through an authoritative transactional platform and
publishes deterministic capsule representations of selected transactional truth.**

### 12.1 The database is the sole source of truth

The authoritative database owns accounts and participants; roles and activation;
Products, Offers, Storefronts, Listings, Reviews, Orders, and financial records;
authority and authorization records; lifecycle state; immutable source versions;
audit evidence; and publication obligations and receipts. **All business changes
occur through database-backed transactional services.**

### 12.2 The capsulization layer and its one permitted direction

The capsulization layer may only: read an identified authoritative source version;
validate projection eligibility; select approved public claims; apply a recorded
projection mapping version; generate a deterministic capsule projection;
canonicalize and hash it; register, publish, supersede, or revoke it; and retain
publication and reconciliation evidence.

```
authoritative record → source version → projection mapping
  → capsule projection shape → capsule projection → registration
```

**The reverse direction is prohibited.** Capsules never become authoritative
records, never create provenance, never authorize business changes, never write
back into transactional records, and never replace source-version, authority,
audit, or publication-receipt evidence.

### 12.3 Scoping §1

§1's ruling that the versioned capsule is the "canonical semantic representation"
**stands, and is narrower than it sounds.** The capsule is canonical for *what
Monacado published and how that published meaning is expressed* — the artifact ANS
consumers resolve, for which no second semantic payload may be invented (§5). It
is **not** canonical for whether a fact is true, who is authorized, what state an
entity is in, or what happened in a transaction.

Where §1's phrasing and §12 could be read against each other, **§12 controls.**

### 12.4 Provenance

Provenance originates in authoritative source records, immutable source versions,
authority and authorization records, audit records, projection mapping versions,
generation records, publication receipts, and reconciliation results. A capsule
may **represent** selected provenance claims; it does not **create** them. This
restates §11.8 rather than amending it.

### 12.5 Publication replay

A publication obligation is satisfied only from the **exact source-version ID**
bound to it, or the **exact prepared canonical projection** attached to it. It must
never be regenerated from the entity's current record. Publication failure never
reverses transactional truth, and capsule content never repairs the database.

### 12.6 Retention

Storage retention is a lifecycle independent of business and publication state.
Archival alters no historical fact and revokes no Node. A hash or receipt
**verifies**; only a full authoritative source snapshot plus its mapping version
**reconstructs**. See
[`SOURCE_VERSION_RETENTION_AND_ARCHIVAL_POLICY.md`](SOURCE_VERSION_RETENTION_AND_ARCHIVAL_POLICY.md).

### 12.7 Terminology

Authoritative Source Model · Authoritative Source Version · Projection Mapping ·
Capsule Projection Shape · Capsule Projection · Publication Lifecycle. Unqualified
"Capsule Foundation" is avoided in phase titles. Stable code is **not** renamed for
style; only terminology creating a genuine source-of-truth ambiguity is corrected.

---

## Out of scope for this document

This ADR records decisions only. The Phase 0A.1 sections (§§1–9) introduced no
code; the §10 ratifications accompany the Phase 0B Product capsule
implementation; §11 (Phase 0B.2) is an architecture decision only. No Offer,
persistence, Prisma, Registrar service, publication worker, credentials, policy
evaluation, or live network code is authorized by this document. Several §11 and
0B.1 rulings (semantic versioning, removal of capsule lifecycle, ANS `metadata`
block, Registrar-issued node binding, provenance fields) describe **future
corrections** to the Phase 0B implementation and are not applied here.
