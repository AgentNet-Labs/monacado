# Product Source-Record Persistence (Phase 0D)

The first real database persistence layer for authoritative Product source
records. The database stores the enduring Product identity and its **immutable
source-record version history**. Capsule candidates are **not** stored — they are
deterministic derivations regenerated from a persisted version via the Phase 0C
mapper. Follows [`PRODUCT_SOURCE_RECORD_MAPPING.md`](PRODUCT_SOURCE_RECORD_MAPPING.md)
and the ADR.

Scope: local, database-free of any production system. No production/staging Aiven,
no Vercel wiring, no Node/publication/Registrar/resolver models.

## Authoritative database role

The Monacado database is the **system of record** for Monacado-native Product
facts (ADR §1). It does **not** persist duplicate capsule JSON as the
authoritative record; the published capsule is a downstream, regenerable artifact.

## Tables

### `Product` — stable identity (one row per enduring product)

| Column | Purpose |
| --- | --- |
| `internalProductId` (PK) | Opaque `mon:product:<opaque>`; immutable. |
| `sourceRecordId` (unique) | Opaque `mon:srec:<opaque>`; constant across versions; distinct from `internalProductId`. |
| `productRef` (unique) | **Application routing identity** (Phase 1.34) — see below. |
| `currentSourceRecordVersion` | Pointer to the current immutable version. |
| `recordStatus` | Internal Monacado authoring status (not ANS lifecycle). |
| `productRowCreatedAt` | DB row creation (operational; not a domain field). |

#### `productRef` — the stable application-facing Product reference (Phase 1.34)

The selector a route, a form action, or a page link names a Product by. It exists
because every identifier beside it is something else: `mon:product:` and
`mon:srec:` are internal identities, `an:node:` is an AgentNet Node, and the
primary key is a primary key. Using any of them in a URL would publish an
internal identity in order to get a link.

- **Opaque, and carrying no business semantics.** Not the name, not a sequence,
  not the source-record version, and not derivable from anything a caller knows.
- **Server-generated, with no client-settable path.** Minted by
  `ProductRepository.createInitialProductSourceRecord` inside the creating
  transaction. There is no input member for it anywhere, which is the control —
  not a rule that discards a supplied one.
- **Cryptographically random.** 32 characters drawn one CSPRNG byte each from the
  Crockford alphabet: 160 bits, non-enumerable. A populated-database backfill
  writes `HEX(RANDOM_BYTES(16))` — 32 characters of 128 bits over `[0-9A-F]`, a
  strict subset of the same alphabet — so both paths clear 128 bits and produce
  the same shape.
- **Immutable and stable for the life of the Product**, and independent of its
  source-record version: revising a Product advances the version pointer and the
  record status and touches nothing else on the row. A link handed out against
  version 1 still names the same Product at version 12.
- **Un-namespaced, and that is the guarantee.** Every other identifier carries a
  `mon:` or `an:` prefix, so a bare 32-character body **cannot** be read or used
  as an internal Product id, a source-record id, a creator reference, an ANS Node
  ID, a capsule ID, or a ProductNode identity.

It is **application routing identity, not semantic or public AgentNet identity**.
It is not a capsule fact, takes part in no source version, appears in no
projection, and is never published. It may travel to the UI and the API — it is
the only Product identifier that may — and it need not be shown to a person.

### `ProductSourceRecordVersionRow` — immutable version history

One row per authoritative source-record version. **Never updated in place.** A
surrogate autoincrement `seq` provides deterministic creation ordering and the
primary key. Persists every field required to reconstruct the Phase 0C
`ProductSourceRecord`: identity, source-system identity, creator authority
(flattened), Product facts, mapping controls, source timestamps, and internal
record status.

## Uniqueness & integrity constraints

- `Product.internalProductId` — primary key (unique).
- `Product.sourceRecordId` — unique.
- `Product.productRef` — unique (Phase 1.34); NOT NULL.
- `ProductSourceRecordVersionRow (sourceRecordId, sourceRecordVersion)` — unique
  (prevents duplicate versions; hard-guards concurrent revisions).
- FK `ProductSourceRecordVersionRow.internalProductId → Product.internalProductId`
  (`ON DELETE RESTRICT`).
- One current version per Product via the single `currentSourceRecordVersion`
  pointer.
- `sourceRecordId ≠ internalProductId` enforced by the domain schema before write.
- ANS Node IDs / capsule IDs are never accepted as source-record identifiers
  (Phase 0C opaque `mon:srec:` / `mon:product:` schemes only).

## Current-version pointer & transaction boundary

Creating the initial product and creating a revision are each **one transaction**:

- **Initial:** insert `Product` (pointer = `"1"`) + first version row together.
- **Revision:** load product + current version → optimistic-concurrency check →
  Phase 0C revision validation → insert the new immutable version → conditionally
  advance the pointer. On any failure the transaction rolls back: no partial
  version row remains and the pointer is unchanged.

## Concurrency strategy

A narrow **optimistic-concurrency** guard: the caller supplies
`expectedCurrentSourceRecordVersion`. If the stored current version differs, the
repository returns a `ConcurrencyConflictError` (no distributed locks). Two truly
simultaneous revisions with the same expected version are additionally serialized
by the `(sourceRecordId, sourceRecordVersion)` unique constraint — exactly one
succeeds; the loser rolls back.

## Authority persistence

The narrow Phase 0C creator authority is flattened into columns
(`authorityCreatorId`, `authorityScope`, `authorityAuthorizationState`,
`authorityAuthorizationRef?`). `creatorId` is treated as an **opaque governed
reference** this phase. **Deferred:** a foreign-key relationship from
`authorityCreatorId` to a future participant/account model (not created yet).

## Product-fact persistence choices

Bounded query-relevant scalars are normalized columns (`factName`,
`factProductVersion`, `factPromotable`, `factGeneralAvailabilityState`, …).
Structured collections use **validated JSON** columns:

- `factSpecifications` — `Record<string, string|number|boolean>`;
- `factCapabilities` — `string[]`.

JSON is appropriate because both are variable-shape collections validated by the
narrow Phase 0C `ProductData` Zod contract **before write and after read** — child
tables would add join complexity without a query need. The JSON shape stays narrow
and typed; there are no arbitrary metadata bags. The **Product-vs-Offer boundary**
is enforced before persistence: price, currency, discount, commission, payout,
payment, offer validity, and territory-specific commercial terms are rejected
(strict schema + forbidden-field scan).

## Mapping controls

Persisted and preserved exactly, never derived from the runtime clock:

- `capsuleSemver` — persisted capsule-mapping control (not a Product fact, not
  publication metadata);
- `mappingVersion` — identifies the deterministic transformation contract;
- `capsuleGeneratedAt` — the governed candidate-generation event time
  (`provenance.generatedAt` maps from it; never from `updatedAt`/`createdAt`/
  `acquiredAt`/the clock).

Timestamps use `DATETIME(3)` and round-trip exactly for the ms-precision UTC
values the domain uses.

## Persisted vs. derived; excluded publication fields

**Derived (never stored):** capsule `@context`/`@type`/`metadata`/`data`, provenance
structure, candidate hash. **Excluded from these tables:** `bindsToNode`,
`capsuleId`, `publishedBy`, `publishedAt`, Node/Capsule Policy references,
published capsule hash, Registrar registration id, publication receipt,
publication status, resolver state, and the published capsule JSON body.

Those belong to the Node and publication models, not to the source record.
`bindsToNode` lives on `ProductNode` (Phase 0E.1). `capsuleId`, `publishedBy`,
`publishedAt`, policy references, the candidate hash, and the published-capsule
hash live on `ProductPublication`, and the published capsule JSON body lives
**only** in the `PublicationOutbox` payload (Phase 0E.2 —
[`PRODUCT_PUBLICATION_PREPARATION.md`](PRODUCT_PUBLICATION_PREPARATION.md)).
Registrar registration ids, receipts, resolver state, and reconciliation remain
deferred.

## Prisma-to-domain mapping

`versionRowToDomain` reconstructs a **validated** `ProductSourceRecord`
(`ProductSourceRecordSchema`); malformed persisted data raises a structured
`PersistedContractViolationError`. `domainToVersionCreateInput` builds the Prisma
create input from a validated record. Prisma rows are persistence details, never
the public domain contract; no Product-to-capsule logic is duplicated — callers
use the Phase 0C mapper after reconstruction.

## Deterministic candidate regeneration & historical reconstruction

`generateCandidateFromPersistedProductVersion` reconstructs a persisted version
and runs the Phase 0C mapper; the candidate hash matches the in-memory candidate
byte-for-byte. Historical versions regenerate their **original** candidates
(prior versions are immutable), enabling reconstruction of any past capsule from
retained source data — no duplicate capsule-body persistence is needed.

## Repository interface

`ProductRepository`: `createInitialProductSourceRecord`,
`getCurrentProductSourceRecord`, `getProductSourceRecordVersion`,
`listProductSourceRecordVersions`, `createProductSourceRecordRevision`,
`generateCandidateFromPersistedProductVersion`,
`verifyPersistedProductVersionMapping`. Structured error codes:
`VALIDATION_FAILED`, `NOT_FOUND`, `DUPLICATE_PRODUCT`, `DUPLICATE_VERSION`,
`IMMUTABLE_IDENTITY`, `CONCURRENCY_CONFLICT`, `PERSISTED_CONTRACT_VIOLATION`,
`DATABASE_ERROR`. Errors never expose `DATABASE_URL`, credentials, or raw
connection details.

## Local disposable database setup

Prisma MySQL provider; connection via `DATABASE_URL` in a git-ignored `.env`
(see `.env.example`). Use a **local disposable MySQL only** — never production,
staging, or a shared database.

```
# Example: a fresh, empty local instance (loopback, no password)
DATABASE_URL="mysql://root@127.0.0.1:3306/monacado_dev"
```

## Commands

| Command | Purpose |
| --- | --- |
| `npm run db:generate` | Generate the Prisma client (also runs on `postinstall`). |
| `npm run db:migrate` | Apply committed migrations (`prisma migrate deploy`). |
| `npm run db:check` | Connectivity, migration state, tables/indexes, safe synthetic read/write, reconstruction, deterministic candidate. |
| `npm run db:test` | Run DB-backed integration tests (`RUN_DB_TESTS=1`) against the configured disposable DB. |

Integration tests self-skip unless `RUN_DB_TESTS=1`, so `npm run test` needs no
database. Do not make destructive reset part of normal validation.

## Migration ordering & rollback

`prisma/migrations/20260726_..._init_product_source_records` is the initial
additive migration (two tables, indexes, FK). Apply with `prisma migrate deploy`
in order. Rollback for this additive migration is dropping the two tables; no
production data exists to preserve. **Production migrations are not applied in
this phase.**

## Seller revision, shipping policy, and completeness (Phase 1.38)

Implementation record; the governing rules are
[`PRODUCT_COMPLETENESS_PROFILE.md`](PRODUCT_COMPLETENESS_PROFILE.md) and
Contract §9.

- **Seller revision.** `POST /api/products/{productRef}/revise`
  (`product-revision-route-handler.ts` → `reviseProductAs`) restates `name`,
  `description`, `deliveryMode`, and the Seller shipping policy. It writes
  through `createProductSourceRecordRevision`: one new
  `ProductSourceRecordVersionRow` (`"1"` → `"2"` → …), the current pointer
  advanced once under the existing optimistic-concurrency guard, earlier rows
  untouched, `productRef` unchanged. Creator authority
  (`participantHoldsProductAuthority`) and authoring eligibility
  (`assertAccountMayAuthorProductIn`) are re-checked inside the transaction via
  the new `ReviseInput.authorize` hook. Every other fact, `taxClassification`,
  `recordStatus`, and the mapping controls carry forward. A restatement that
  changes nothing is refused (`PRODUCT_REVISION_UNCHANGED`) and writes nothing.
- **Conditional revision.** Each request carries `expectedRevision`, an opaque
  token (`product-revision-token.ts`: a truncated SHA-256 digest of the
  source-record id and current version label — neither is exposed). It is
  checked before any work and again inside the write transaction; a token that
  is not the current one is `409 PRODUCT_REVISION_CONFLICT` and writes nothing.
  The account page receives the current token with each Product, and a success
  returns the new one as `revision`.
- **Shipping policy columns** on `ProductSourceRecordVersionRow`:
  `shippingPolicyMethod` (`FREE` | `FIXED` | NULL), and for `FIXED` only
  `shippingFixedChargeMinorUnits` (BIGINT, > 0) and
  `shippingFixedChargeCurrency` (`USD`). NULL means **no shipping decision**,
  never free shipping. In the domain record it is `shippingPolicy`, beside
  `taxClassification` and **outside `facts`**, so it is versioned with the
  record but **not projected** into the capsule — whether it is ever published
  is undecided. A policy is permitted only when `facts.deliveryMode` is
  `PHYSICAL`; revising to `DIGITAL` writes a version with none (the old version
  keeps its own). A zero charge is stated as `FREE`; `FIXED 0` is refused.
- **Completeness.** `evaluateProductCompletenessV1`
  (`product-completeness.ts`) is the one evaluator;
  `readCurrentProductCompleteness` (`product-completeness-service.ts`) applies
  it to the version the current pointer names. No completeness or lifecycle
  state is stored.

## Product lifecycle and explicit activation (Phase 1.39)

Implementation record; the governing rules are Contract §9.1–§9.2.

- **Derived, never stored.** `deriveProductLifecycle`
  (`contracts/product/product-lifecycle.ts`) computes `INCOMPLETE` /
  `COMPLETE` / `ACTIVE` / `SUSPENDED` on read from current rows:
  `SUSPENDED` when a Product suspension is in effect; otherwise `INCOMPLETE`
  when `PRODUCT_COMPLETENESS_V1` fails on the current version; `ACTIVE` only
  when readiness holds now **and** the current activation's continuity holds;
  else `COMPLETE`. `readProductLifecycleIn`
  (`server/product/product-lifecycle-service.ts`) gathers the facts. There is
  no completeness boolean and no lifecycle column; `recordStatus` is unchanged.
- **One readiness evaluator.** `evaluateProductActivationReadiness` returns the
  ordered blockers: Product suspended or incomplete; email unverified; declared
  first / last name blank (never `Account.name`); participant missing,
  suspended, under a `product:activate` restriction, or not `ACTIVE`; SELLER
  role not `ACTIVE`; payment not `ENABLED`; commerce approval not `APPROVED`;
  tax classification not ready (missing, or `PHYSICAL_GOOD` on a `DIGITAL`
  Product — the checkout rule). No Storefront, Listing, or Offer is required.
- **`ProductActivation`** — one row per explicit Seller activation, never
  updated except to be superseded (`supersededAt`; the unique
  `currentForProductId` marks the one current row). It records the activated
  version and a **readiness basis**: the instants `emailVerifiedAt`, SELLER
  role `activatedAt`, and payment `readinessEnabledSince`, plus counts of the
  append-only participant restriction, participant suspension, non-approval
  commerce decision, and Product suspension rows. A later mismatch in any of
  them, or a later version that is incomplete, not tax-ready, or authored by
  someone else, means the activation **lapsed** — permanently; restoring the
  fact derives `COMPLETE`, and only a new explicit activation restores `ACTIVE`.
  No background job writes anything.
- **`ParticipantPaymentAccount.readinessEnabledSince`** (new, nullable) — set
  by `recordObservedProviderState` on a transition **into** `ENABLED`, cleared
  on a transition out; a repeated identical observation leaves it alone. The
  migration backfills existing `ENABLED` rows from `readinessObservedAt`
  (else `updatedAt`).
- **Activation route.** `POST /api/products/{productRef}/activate`, body
  `{ "expectedRevision" }` only (`product-activation-route-handler.ts` →
  `activateProductAs`). Inside one transaction with the Product row locked
  (`SELECT … FOR UPDATE`): the revision token must be current, authority is
  re-checked, and `SUSPENDED` / already `ACTIVE` / not ready are refused.
  Activation writes no source version and does not change the revision token.
- **`ProductSuspension`** — governed Monacado suspension of one Product
  (`server/marketplace/product-suspension-service.ts`; no route). Requires an
  active `product:suspend` entitlement and refuses self-action. Records reason,
  actor, instant, `lifecycleBeforeSuspension`, and the activation in effect
  immediately before (only if one was). Lifting is a conditional state change
  with its own actor, instant, and reason; the lifecycle is then re-derived, so
  `ACTIVE` returns only where it stood before and every fact held throughout.
  *Operational (deferred):* with no deployed operator path, running the
  service remotely can exceed Prisma's default 5-second interactive-transaction
  timeout over Production latency (`P2028`, rolled back cleanly). Sanctioned
  tooling must set an appropriate timeout until a deployed internal path exists
  (roadmap: Product suspension operator path).
- **`product:activate`** is a restrictable marketplace capability, enforced by
  `readProductActivationStanding`.
- **Tax classification is Monacado's, not the Seller's.** The Seller cannot set
  or edit `taxClassification`: no Seller route accepts it, and the Seller UI
  shows no control for it. A Monacado operator assigns or changes it through
  `POST /api/internal/products/{productRef}/tax-classification`, body
  `{ "taxClassification" }` only (`product-tax-classification-route-handler.ts`
  → `classifyProductTaxAs`), authenticated by session and authorised by an
  explicit active **`product:tax-classify`** grant — asked before any Product
  is read and again inside the write transaction. An operator whose own
  participant authors the Product is refused (self-action). The value must be a
  governed `ProductTaxClassification` member; `PHYSICAL_GOOD` on a `DIGITAL`
  Product is refused; nothing is inferred or defaulted, and there is no
  clearing. Each act writes a **new immutable source version** through
  `createProductSourceRecordRevision` (Seller facts, shipping policy, and
  creator authority carried forward; `productRef` unchanged) plus a
  **`ProductTaxClassificationAct`** audit row — actor, instant, version
  written, previous value — in the same transaction (`recordEvidence` hook).
  Classification is **operational readiness, not completeness**: it clears the
  `TAX_CLASSIFICATION_NOT_READY` blocker and never activates the Product. After
  activation, a valid reclassification keeps `ACTIVE`; a version that was not
  tax-ready in between lapses the activation as any readiness loss does. A new
  version also supersedes the Seller's page revision token.

## Seller-controlled resale availability (Phase 1.40)

Implementation record; the governing rules are Contract §9.3 (and §16.2 /
§16.4 for pause and withdrawal).

- **A separate axis from the lifecycle.** `resaleAvailability` is the Seller's
  Product-wide switch for third-party resale: `NOT_OFFERED` (default),
  `AVAILABLE`, `PAUSED`, `WITHDRAWN`
  (`contracts/product/product-resale-availability.ts`). It is not derived from
  the lifecycle, the lifecycle is not derived from it, and no lifecycle change
  — to `COMPLETE`, `INCOMPLETE`, `SUSPENDED`, or back to `ACTIVE` — writes or
  rewrites it. Seller `PAUSED` / `WITHDRAWN` are never recorded as, or used as,
  Monacado's `SUSPENDED`.
- **Seller-owned.** Only the participant holding creator authority over the
  Product's current version may change it
  (`server/marketplace/product-resale-availability-service.ts`). No internal
  grant substitutes; a foreign or unknown Product is the same 404.
- **`AVAILABLE` requires `ACTIVE` when selected.** Setting `AVAILABLE` (from
  `NOT_OFFERED`, or resuming from `PAUSED`) is refused unless the effective
  lifecycle, derived inside the write transaction, is `ACTIVE`. A preserved
  `AVAILABLE` is never reset when the lifecycle later moves; it is simply
  **ineffective** until the Product is `ACTIVE` again, and it **never overrides
  the lifecycle**. `PAUSED` and `WITHDRAWN` may be chosen in any lifecycle.
- **Governed transitions only:** `NOT_OFFERED → AVAILABLE`;
  `AVAILABLE → PAUSED | WITHDRAWN`; `PAUSED → AVAILABLE | WITHDRAWN`. Refused as
  not governed: anything out of `WITHDRAWN` (re-opening is undefined by §9.3),
  `NOT_OFFERED → PAUSED | WITHDRAWN`, and anything back to `NOT_OFFERED`.
  Requesting the current state is a no-op that writes nothing.
- **`ProductResaleAvailabilityAct`** — not on the immutable Product source
  version and never published. One row per change, recording the new and
  previous state, the act it supersedes (`supersedesActId`, unique — one linear
  history), the participant and account, the instant, and the lifecycle at the
  act. The unique `currentForProductId` marks the current row; no row means
  `NOT_OFFERED`, so the migration needs no backfill. History rows are never
  rewritten; only the current marker moves.
- **Route.** `POST /api/products/{productRef}/resale-availability`, body
  `{ "resaleAvailability" }` only (`product-resale-availability-route-handler.ts`).
  No revision token: the state belongs to no source version, and the decision is
  made against the current state inside one transaction with the Product row
  locked (`SELECT … FOR UPDATE`, the lock activation, suspension, and revision
  also take), so duplicates are no-ops and conflicting requests serialise.
- **Resale-effectiveness, derived.** `productResaleEffectiveness` /
  `readProductResaleEffectivenessIn` answer *lifecycle `ACTIVE` and resale
  `AVAILABLE`* — necessary for promoted commerce (§16.3 items 1–2), never
  sufficient; Offer, Promotion Authorization, and Promoter readiness are later
  gates. No commerce boolean is stored. Nothing consumes it yet: the current
  promoted Listing path is still ungated (Contract §34).
- **Legacy `promotable` is not governing authority.** No resale logic reads
  `factPromotable` or `generalAvailabilityState`. The Seller page no longer
  shows or asks for `promotable` (the draft form sends `false`); the column,
  the draft-route field, and the published capsule field remain as
  compatibility storage (Contract §34).
- Writes no source version, lifecycle, Storefront, Listing, Offer, Order,
  payment, payout, Node, publication, or outbox state.

## Promotion Authorization (Phase 1.41)

Implementation record; the governing rules are Contract §16.1–§16.2, with the
Phase 1.41 governance rulings on the request gate and on `APPROVED → CANCELLED`.
Promotion Authorization is a relationship among the Product's Seller, the
Product, and one Promoter — **not** a Product fact. It is never on a Product
source version, never published, and never a capsule fact; it is documented
here because it hangs off `Product`.

- **Two append-only tables** (`20261023000000_add_promotion_authorization`):
  - **`PromotionAuthorization`** — one **request cycle** per Promoter request:
    the Product, the Promoter participant, `cycleNumber`, the cycle it follows
    (`supersedesAuthorizationId`, unique), the requesting account and instant,
    and an opaque application reference `authorizationRef` (the shared
    32-character shape; `mon:pauth:` stays internal). The unique pair
    (`currentForProductId`, `currentForPromoterParticipantId`) marks the **one
    current relationship** per Product + Promoter; both are NULL once a later
    cycle supersedes it.
  - **`PromotionAuthorizationAct`** — one row per act (`REQUEST`, `APPROVE`,
    `DENY`, `REVOKE`, `CANCEL`): the resulting and previous state, the act it
    follows (`supersedesActId`, unique — one linear chain per cycle), the
    authority it was made under (`SELLER` / `PROMOTER`), the acting participant
    (for a Seller act, the participant holding Product authority at the
    decision) and account, and the instant. The unique
    `currentForAuthorizationId` marks the current act; **its `state` is the
    cycle's state.** No state column on the cycle, and no authorization boolean
    anywhere. Only markers move; no act is rewritten.
- **Transitions** (`contracts/marketplace/promotion-authorization.ts`):
  `REQUESTED → APPROVED | DENIED` (Seller), `REQUESTED → CANCELLED` (Promoter),
  `APPROVED → REVOKED` (Seller), `APPROVED → CANCELLED` (Promoter). `DENIED`,
  `REVOKED`, and `CANCELLED` end their cycle; a later request opens a **new**
  cycle, so the old decision is preserved and approval is never restored.
  Approving twice, denying or revoking the wrong state, cancelling a terminal
  state, and acting on a superseded cycle are explicit 409s that write nothing.
  Requesting while the current cycle is `REQUESTED` or `APPROVED` is an
  explicit 409.
- **Request gate** — `participantMayRequestPromotionAuthorization`: an enabled
  account with a verified email and nonblank declared first and last names, a
  participant in a drafting status (`RESTRICTED` included; `SUSPENDED`,
  `CLOSED`, and a standing participant suspension refused), and a PROMOTER role
  in `DRAFT`, `PENDING_ACTIVATION`, or `ACTIVE`. **Not** payment readiness,
  underwriting, commerce approval, public readiness, Product `ACTIVE`, resale
  `AVAILABLE`, an Offer, a Storefront, or a Listing. It does not redefine what an
  `ACTIVE` PROMOTER role means anywhere else. A participant holding Seller
  authority over the Product is refused (self-promotion, Contract §14) — the
  strongest principal identity available today; cross-account principal
  linkage does not exist.
- **Authority.** Approve / deny / revoke: Seller authority over the Product
  (`participantHoldsProductAuthority`) only — no internal grant substitutes, and
  no Seller standing gate is added; unknown Product and another Seller's Product
  are one 404. **Approval re-asks the Promoter's request gate** in the same
  transaction and refuses with a conflict if it fails, leaving the request
  pending. Cancel: the cycle's own Promoter only, with no gate — withdrawing is
  standing down.
- **Routes** (`server/marketplace/promotion-authorization-route-handler.ts`):
  `POST /api/products/{productRef}/promotion-authorization/request` (`{}`),
  `…/{authorizationRef}/decision` (`{ "decision": "APPROVE" | "DENY" | "REVOKE" }`),
  `…/{authorizationRef}/cancel` (`{}`). Strict bodies; answers carry only
  `productRef`, `authorizationRef`, and `state`.
- **Concurrency.** Every act locks the Product row (`SELECT … FOR UPDATE`, the
  lock activation, suspension, revision, and resale changes also take) before
  reading what it decides on, so all acts on one Product serialise; the unique
  markers and chain columns are the database's guarantee of no fork.
- **Independence.** Nothing here reads or writes Product lifecycle or resale
  availability, and no lifecycle, suspension, or resale change writes here: an
  `APPROVED` relationship survives `PAUSED`, `WITHDRAWN`, `SUSPENDED`, and a fall
  to `INCOMPLETE`.
- **Future promoted-commerce helper.** `isPromotionAuthorizationApprovedIn`
  (`server/marketplace/promotion-authorization-read-service.ts`) answers *is the
  current cycle `APPROVED` for this Product + Promoter* — necessary, never
  sufficient (§16.3). Nothing commercial consumes it yet.
- **Pages.** `/account` lists each Product's pending and approved Promoters (by the
  Promoter's mName — the cross-participant marketplace identity since Phase 1.43;
  declared names, `Account.name`, and email stay private and are never shown to
  the Seller) with Approve / Deny / Revoke, and, for a PROMOTER, its
  requests by the Product reference it supplied, with Cancel / Request again
  where governed, and a request form taking a reference. No discovery.
- Writes no source version, Product row, lifecycle, resale, Storefront,
  Listing, Offer, Order, payment, payout, Node, publication, outbox, or
  notification state; the Product revision token is unchanged.

### Promoter Offer-package acceptance (Phase 1.44)

Implementation record; the governing rules are Contract §16, §16.3(7), §19 and
rulings 1.44-1…8. Approval answers *may this Promoter promote this Product*;
acceptance answers *has it accepted the Seller's exact terms*. Approval is never
acceptance.

- **One append-only table** (`20261029000000_add_promotion_offer_acceptance`):
  **`PromotionOfferAcceptance`** — one Promoter's acceptance of one exact
  package under one cycle: `authorizationId`, `offerSourceRecordId`,
  `standingVersion`, nullable `promotionVersion`, `promotionVersionKey`
  (`promotionVersion` or `''`, held equal by a CHECK, so the unique key
  (cycle, Offer, S, P-or-'') also covers standard-only packages), the accepting
  account, and `acceptedAt`. Never updated. The standing FK targets the exact
  version; the promotion FK targets (Offer, P, basis = S), so the database
  refuses a promotion not built on S. No economics (the version rows hold
  them), retail price, Monacado retention, participant id, or current / valid
  flag. Nothing is published.
- **Act** (`server/marketplace/promotion-offer-acceptance-service.ts`,
  `POST /api/products/{productRef}/promotion-authorization/{authorizationRef}/offer-acceptance`):
  the body restates the exact package shown — `offerRef`, `standing` (version
  and economics), and `promotion` (version, economics, window) or `null`. Inside
  one transaction, Product row locked `FOR UPDATE`: the cycle is the caller's,
  current, and `APPROVED`; the request gate and self-promotion are re-asked;
  Product `ACTIVE`; resale `AVAILABLE` or `PAUSED`; the Offer is the Product's
  current, Seller-authored, `ACTIVE` Offer; the package is exactly the
  acceptable one; the restated economics and window equal the immutable
  versions'. Refusals are deterministic 409s (`OFFER_ACCEPTANCE_*`) that write
  nothing. First acceptance 201; an identical replay 200 with the original
  `acceptedAt`. Answers carry references and versions only.
- **Coverage is derived** (`contracts/marketplace/promotion-offer-acceptance.ts`):
  S in force by any row naming S; P in force only by exactly (S, P). A new cycle
  inherits nothing; a revoked cycle's rows stay as evidence and govern nothing.
- **Views.** The Promoter's APPROVED rows on `/account` and the catalog detail
  page show the exact package and **one** button — *Accept standard terms* or
  *Accept standard + promotional terms*. The Seller's `/account` shows each
  APPROVED Promoter (by mName) as having accepted the current package, or not
  (with the last package it did accept). Promotional terms are never
  characterized relative to the standard terms.
- **Helper, unwired.** `readPromotedTermsEligibilityIn` answers whether
  §16.3(1)–(4), the self-promotion part of (6), and (7) hold for the terms in
  force, returning the governing versions and acceptance evidence, and always
  naming what it does not evaluate (Promoter payment / commerce readiness,
  restrictions, Listing, retail economics, cross-account principals,
  transaction conditions). Nothing consumes it in 1.44.
- Writes no Offer, version, act, Promotion Authorization, Product, Listing,
  Order, payment, notification, Node, publication, or outbox state.

## Related: Product Node

The durable AgentNet **Product Node** (opaque Registrar-issued identity + ANS
lifecycle) is a separate model documented in
[`PRODUCT_NODE_PERSISTENCE.md`](PRODUCT_NODE_PERSISTENCE.md) (Phase 0E.1). ANS
lifecycle lives on the Node, never on these source-record tables.

## Future models & known deferrals

- Participant/account/organisation model + FK from `authorityCreatorId`.
- Publisher/Registrar services (live), resolver.
- Outbox claiming/retries, publication receipts, and reconciliation. (The
  publication record and the PENDING REGISTER outbox item — owning `capsuleId`,
  `publishedAt`, policy refs, and the capsule payload — arrived in Phase 0E.2.)
- Offer, Listing, Review, Storefront persistence.
- Production Aiven connection, staging/production migrations, Vercel wiring.
