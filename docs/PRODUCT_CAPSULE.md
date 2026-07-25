# Product Capsule — Semantic Foundation (Phase 0B.1, ANS-conformant)

The creator-authoritative **Product capsule**, refactored to conform to the
binding ANS Core v2.0 decisions recorded in
[`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) (§10, §11) and
the Phase 0B.1 audit. This is an **offline, database-free** contract phase — no
persistence, UI, publication worker, Registrar/Publisher service, or network
code. All `monacado.com` / `agentnet.ai` URLs are **design targets**.

Source lives under `src/contracts/`.

## Authoritative database source record

The Monacado database is the **authoritative source record** for Monacado-native
Product facts. A capsule is a semantic representation **generated from one
identified source-record version**; the Publisher and Registrar roles do not
replace source authority. Provenance chain:

```
authoritative Monacado source record
  → generated candidate  → Publisher submission
  → Registrar registration → resolver availability
```

## Generated candidate vs. published capsule

Generation is separate from publication (ADR §5, §11):

- **Candidate** (`ProductCapsuleCandidate`) — generated deterministically from a
  source record. Contains Product `data` and source `provenance` only. It does
  **not** fabricate a publication time, a Registrar-issued Node ID, or final
  publication metadata.
- **Published capsule** (`PublishedProductCapsule`) — produced only by
  `finalizeProductCapsule(...)`, which attaches all mandatory ANS publication
  metadata and computes the content hash. Immutable after finalisation
  (deep-frozen).

## Capsule structure (ANS §3)

Top-level members are **exactly** `@context`, `@type`, `metadata`, `data`.
Unexpected top-level fields are rejected.

- **`data`** — the Product facts: `name`, `description?`, `image?`,
  `productVersion`, `promotable`, `generalAvailabilityState`, `specifications?`,
  `capabilities?`, and `relationships` (`creator`, optional `offer` reference).
- **`metadata`** (published) — `capsuleId`, `bindsToNode`, `publishedBy`,
  `publishedAt`, `version`, `provenance`, `nodePolicy`, `capsulePolicy`,
  `supersedes?`, `revokes?`, `contentHash`.

## Internal Product ID vs. Registrar-issued ANS Node ID

Five identities are kept distinct (ADR §3, §11.5):

| Identity | Form | Role |
| --- | --- | --- |
| Internal Product ID | `mon:product:{opaque}` | Monacado application id (not an ANS identity) |
| Product page URL | (not modeled) | human-facing |
| **ANS Node ID** | `an:node:{opaque}` | **Registrar-issued, opaque, non-semantic** node binding |
| Capsule ID | `an:capsule:{opaque}` | one immutable published version |
| Source-record ID | opaque | the governed DB record |

The ANS Node ID is opaque and **must not** encode entity type, role, name, slug,
hierarchy, or business meaning. The old `https://monacado.com/id/product/{ulid}`
pattern is an **internal identity only** and is **rejected** as an ANS Node ID.
The `an:node:` / `an:capsule:` schemes are **provisional synthetic** stand-ins
until real Registrar issuance.

## Node lifecycle vs. capsule replacement

Capsules carry **no lifecycle state** — a `lifecycle`/`lifecycleState` field is
rejected. ANS Node lifecycle (Active/Inactive/Retired/Revoked) is
Registrar-managed and lives on the Node. Capsule change uses **semantic
versioning** with `supersedes`/`revokes` (references to a prior **capsule ID**,
never a Node ID). Internal publication-workflow status stays outside the capsule.

## Semver capsule versions

Capsule versions are semver strings (`1.0.0`, `1.0.1`, `1.1.0`) with strict
validation; integer versions are rejected. Replacement uses a **new semver** and
a **new immutable capsule ID**. The `an:capsule:{opaque}` format is provisional
until Registrar integration.

## ANS metadata & AN-O terminology

Mandatory published metadata follows ANS §3 and reuses **AgentNet Core Ontology
(AN-O)** terms for ANS-defined concepts (`capsuleId`, `bindsToNode`,
`publishedBy`, `publishedAt`, `version`, `provenance`/`hasProvenance`,
`supersedes`, `revokes`, `hasNodePolicy`, `hasCapsulePolicy`) — Monacado does not
invent duplicate terms for them. The **Publisher is Monacado**; Publisher
identity is never conflated with the creator/source authority or the generator.

## ANS provenance

Provenance carries the ANS-required `source`, `method`, `acquiredAt`,
`assertionKind` (`Asserted` for current Product facts), plus narrow Monacado
traceability extensions: `sourceClass` (≥ `governed-database-record`),
`sourceSystem` (Monacado), `sourceRecordType` (`Product`), `sourceRecordId`
(stable, opaque), `sourceRecordVersion` (explicit, immutable), `generatedAt`,
`generatorVersion`. There is **no** published `sourceAuthority` field competing
with ANS Publisher authority; internal authorisation checks are kept separate.

## Publisher vs. source authority vs. generator

- **Source/factual authority** — the creator (via provenance and the `creator`
  relationship). Not published as an authority field.
- **Publisher** — Monacado (`an:publisher:monacado-platform`). Finalisation
  rejects any other `publishedBy`, including the generator identity.
- **Generator** — operational only (`generatorVersion` in provenance); holds no
  authority and cannot substitute for the Publisher.

## Source-record revision rules

A meaningful Product revision requires: a **new source-record version**, a **new
capsule semver**, a **new capsule ID**, a **new content hash**, and a
`supersedes` reference to the prior capsule where appropriate. Rejected: reuse of
the prior source-record version for changed content; reuse of the prior semver;
`supersedes` pointing to a Node ID.

## Policy linkage

Published metadata requires structural **Node Policy** and **Capsule Policy**
references (`{ ref, version }`), synthetic and opaque in tests. Policy
evaluation, inheritance, and Effective Policy calculation are **deferred** (no
policy services this phase).

## Deterministic hashing

Canonical JSON (sort object keys, preserve array order, drop `undefined`,
finite numbers, no whitespace). The **published** content hash covers the
complete validated published capsule **excluding only `metadata.contentHash`**,
and includes Node binding, Publisher, version, publication time, provenance,
policy references, and supersession/revocation metadata. Equivalent objects hash
identically; any meaningful change changes the hash. A separate, distinctly named
**candidate hash** exists for pre-publication use and is never conflated with the
published hash.

## Product vs. Offer boundary

Product `data` holds enduring descriptive facts, specifications, capabilities,
the creator relationship, promotable state, and general availability. It must not
contain price, currency, discount, commission, payout, territory-specific
commercial terms, offer validity, or payment data — those belong to a future
Offer model, and are rejected by strict schemas plus the forbidden-field scan
(a temporary Phase 0B safeguard, ADR §10.5).

## Zod, types, JSON Schema

Zod is the single authored executable schema; TypeScript types are inferred;
JSON Schema is **generated** (`z.toJSONSchema`) from the base object shapes and
is a derived artifact — never hand-maintained. Exports are deterministic;
`generated/` is git-ignored this phase (regenerate with `npm run contracts:export`).

## Scripts

The `contracts:*` scripts validate **Capsule-Driven artifacts**:
`contracts:validate` (ontology/context consistency + candidate/published
validation + schema generation), `contracts:export` (derived JSON Schema),
`contracts:demo` (offline end-to-end). `validate` runs
`lint → typecheck → contracts:validate → test → build`.

## Deferred (later phases)

- Real Registrar integration (opaque Node ID generation, registration, receipts)
  and Effective Policy evaluation.
- Relational persistence and deterministic reconstruction from records.
- Offer, Listing, Review, MarketplaceVerification, Storefront, participant
  capsules; React consumption; AgentNet publication workers; resolver integration.
- Retention note: after successful Registrar registration Monacado need not
  retain the published capsule body permanently, provided source records, hashes,
  identifiers, receipts, and reconciliation state are retained.
