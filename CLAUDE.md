# Monacado — Project Instructions

Persistent, repository-scoped rules for all work in this repo. These apply to
every phase so they need not be repeated in each prompt.

## Terminology

- **CDD** means **Capsule-Driven Development** in this project — always.

## Governing documents

- [`docs/CDD_ARCHITECTURE_DECISIONS.md`](docs/CDD_ARCHITECTURE_DECISIONS.md) —
  **binding architecture decisions. Follow them for all implementation.** Do not
  reinterpret or replace these decisions.
- `docs/Capsule_Driven_Development_Intro_Cover.docx` — the authoritative
  conceptual definition of CDD.
- `docs/Monacado_New_Thesis_and_Initial_Site_Map.docx` — the current product and
  marketplace architecture guide.
- `docs/monacado-color-palette.png` — the approved visual palette reference.

Read a source document only when the active phase touches its subject, or when
the ADR leaves a genuine ambiguity. The ADR is the day-to-day reference; the
`.docx` sources are consulted for meaning, not re-read by default.

**Do not silently resolve conflicts** among governing documents, or between an
instruction and a governing document. Surface the conflict for review and
proceed only under an explicit ruling.

## Core architecture principles

(Full detail lives in the ADR — this is the orientation, not a substitute.)

- **Dual representation.** Publishable descriptive entities (Product,
  Storefront, Creator, Promoter, Listing, Offer) use the **versioned capsule as
  their canonical semantic representation**; **relational storage serves
  operational integrity, authorization, indexing, querying, and deterministic
  reconstruction**. Financial/transactional records are relational-first and are
  not entity capsules.
- **Authority partitioning.** Keep assertions partitioned by authority. **Do not
  merge creator, promoter, Monacado, and buyer assertions into one flat
  capsule** — each authority gets its own capsule around a shared node identity.

## How phases run

- **Narrow implementation phases**, with tests and validation at every boundary.
- **End each implementation phase with a pre-commit report**, including a
  **fix-now-versus-acceptable** review.
- **Do not commit or push unless explicitly instructed.**
- **Do not perform destructive operations, production changes, or secret
  management without approval.**

## Validation commands

```
npm run lint
npm run typecheck
npm run test
npm run build
npm run validate
```

`validate` runs the full chain. Run it before reporting a phase complete.
