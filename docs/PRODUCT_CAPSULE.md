# Product Capsule — Semantic Foundation (Phase 0B)

The creator-authoritative **Product capsule** and its supporting layers. This
implements the Phase 0B scope only; it adds no persistence, UI, publication, or
network code. It follows [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md).

Source lives under `src/contracts/`. Nothing here is hosted or live — all
`monacado.com` URLs are **design targets**.

## Product ontology terms

Defined in `src/contracts/ontology/commerce.ontology.ts`.

- **Reused from schema.org (never redefined):** `Product`, `name`,
  `description`, `image`.
- **Monacado terms** (`https://monacado.com/ns/commerce#`) — only genuine
  Monacado concepts:
  - *Envelope/framework:* `capsuleVersion`, `subject`, `data`, `relationships`,
    `provenance`, `metadata`, `lifecycle`, `createdAt`, `updatedAt`,
    `supersedes`, `revocation`, `authority`, `createdBy`, `contentHash`.
  - *Product domain:* `productVersion`, `promotable`,
    `generalAvailabilityState`, `specifications`, `capabilities`, `creator`,
    `offer`.

`creator` is a Monacado marketplace role and is deliberately **not**
`schema:creator`. Commercial terms are intentionally absent (see the boundary
below).

## JSON-LD context policy

Defined in `src/contracts/ontology/commerce.context.ts`. The context maps each
compact capsule term to its schema.org or Monacado IRI. The JSON-LD keywords
`@context`, `@type`, `@id` are reserved and not remapped.

- Semantic meaning lives in the **ontology/context**, not in Zod (ADR §8).
- The namespace (`…/ns/commerce#`) is **independent of document version**;
  compatible revisions do not change term identity. A term gets a new IRI only
  when its meaning changes incompatibly.
- A capsule's `@context` references the provisional context document
  (`https://monacado.com/context/commerce/v1`). The context object is bundled
  locally so validation, tests, and the demo need no network.
- **These URLs are design targets only — not live, resolvable, immutable, or
  approved AgentNet standards.**

## Product capsule anatomy

Base envelope (`src/contracts/capsule/envelope.ts`), per CDD Appendix C:
`@context`, `@type`, `@id`, `capsuleVersion`, `subject`, `name`,
`description?`, `image?`, `data`, `relationships`, `provenance`, `metadata`,
`lifecycle`, `createdAt`, `updatedAt`, `supersedes?`, `revocation?`.

The Product capsule (`src/contracts/product/product.capsule.ts`) constrains:

- `@type` includes `Product`;
- `data`: `productVersion`, `promotable`, `generalAvailabilityState`,
  `specifications?`, `capabilities?`;
- `relationships`: `creator` (required node IRI) and `offer?` (a **reference**
  to a future Offer node — no offer data inline);
- `provenance.authority` is fixed to `creator`.

## Product versus Offer boundary

The Product capsule holds **enduring, creator-authoritative facts**. Time-
sensitive commercial terms — **price, currency, discount, promoter commission
rate, validity dates, territory** — belong to a future **Offer** capsule, not
here. The Product capsule may *reference* a future Offer via `relationships.offer`
but carries none of its data.

Enforcement is twofold: strict object schemas reject unknown keys at each
defined level, and a denylist scan (`src/contracts/integrity/forbidden-fields.ts`)
rejects commercial, promoter, Monacado-verification, buyer-review, payment, and
private-identity keys **anywhere** in the capsule (including open containers like
`specifications` and `metadata`). The substring-based scan is a **temporary
Phase 0B safeguard** (ADR §10.5) to be replaced by allowlisted or namespace-aware
validation before real extensible specs/metadata are accepted.

`generalAvailabilityState` covers broad Product-level lifecycle availability only
— `available`, `unavailable`, `pre-release`, `discontinued` — never offer terms,
inventory, territory, or checkout eligibility (ADR §10.2).

## Identity

Per ADR §3, four identities stay distinct and never substitute for one another:

| Identity | Form |
| --- | --- |
| Product **node IRI** (enduring entity) | `https://monacado.com/id/product/{ULID}` |
| Product **capsule-version IRI** | `…/id/product/{ULID}/capsule/{n}` |
| Human-facing **page URL** | not modeled here (may contain slugs) |
| **Purchase/checkout endpoint** | not modeled here (operational) |

ULIDs are opaque (26-char Crockford base32, uppercase). No slugs in identity;
identifiers are never reused; the node IRI survives renaming/supersession/
retirement. `@id` must equal `subject` + `/capsule/{capsuleVersion}`.

## Zod's role

Zod is the **single executable source of truth for structure** (ADR §8).
TypeScript types are **inferred** from Zod — no hand-maintained interfaces. Zod
does not replace the ontology or context (meaning), and JSON Schema is derived
from Zod, never authored separately.

## Authority rules

Small and explicit (`src/contracts/product/product.authority.ts`) — not a broad
claim-key vocabulary:

- **creator** may create and modify creator-authoritative Product facts;
- **promoter** may not alter them (write attempts throw `ProductAuthorityError`);
- **Monacado** operational assertions and **buyer** observations do not belong
  in this capsule (also blocked structurally).

## Deterministic hashing

`src/contracts/integrity/canonical-json.ts` + `hash.ts`.

- Hash input: the **complete validated public capsule**, excluding only the
  derived `provenance.contentHash` (excluding it avoids circularity). Included:
  semantic content, identity, version, provenance, lifecycle, relationships.
- Canonicalization: recursively sort object keys (UTF-16 order), preserve array
  order, omit `undefined`, require finite numbers, then `JSON.stringify` with no
  whitespace.
- Result: `sha256:<hex>`. Equivalent capsules with different key order hash
  identically; any meaningful change changes the hash. A relational projection
  or publication envelope is **never** hashed.

## Generated JSON Schema

`npm run contracts:export` writes `generated/jsonschema/product.capsule.schema.json`
from the Zod schema (`z.toJSONSchema`). It is a **derived** interoperability
artifact — never hand-edited. `generated/` is **git-ignored** this phase
(regenerate on demand); cross-field refinements (identity agreement,
supersession, forbidden-field scan) are Zod-runtime only and not represented in
JSON Schema.

## Scripts

The `contracts:*` scripts validate **Capsule-Driven artifacts**:

- `contracts:validate` — ontology/context consistency + synthetic capsule validates + schema generates;
- `contracts:export` — write the derived JSON Schema;
- `contracts:demo` — offline end-to-end demonstration (no DB, no network).

`validate` runs `lint → typecheck → contracts:validate → test → build`.

## Deferred work (later phases)

- Offer, Listing, Review, MarketplaceVerification, Promoter, Storefront capsules.
- Relational persistence and deterministic reconstruction from records.
- React consumption of capsule-shaped data.
- AgentNet publication (outbox, gating, receipts) — none of it lives here.
- Hosting the ontology/context/IRIs and confirming domain + resolution before
  any external publication.
