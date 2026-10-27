# Monacado — Project Instructions

Persistent, repository-scoped rules for all work in this repo. These apply to
every phase so they need not be repeated in each prompt.

## Terminology

- **CDD** means **Capsule-Driven Development** in this project — always.

## Governing documents

- [`docs/MONACADO_PROJECT_CONTRACT.md`](docs/MONACADO_PROJECT_CONTRACT.md) —
  **the canonical Project Contract; highest authority** for business, economic,
  authority, lifecycle, and compliance rules.
- [`docs/DOCUMENT_AUTHORITY.md`](docs/DOCUMENT_AUTHORITY.md) — the authority
  hierarchy and the classification of every other document.
- [`docs/CDD_ARCHITECTURE_DECISIONS.md`](docs/CDD_ARCHITECTURE_DECISIONS.md) —
  **binding architecture decisions. Follow them for all implementation.** Do not
  reinterpret or replace these decisions.
- `docs/Capsule_Driven_Development_Intro_Cover.docx` — conceptual history of
  CDD; authoritative only where the ADRs and Contract have not scoped or
  superseded it.
- `docs/Monacado_New_Thesis_and_Initial_Site_Map.docx` — product-origin
  history. **Not the current governing commercial model**; the Contract governs.
- `docs/monacado-color-palette.png` — the approved visual palette reference.

**Read `MONACADO_PROJECT_CONTRACT.md` and `DOCUMENT_AUTHORITY.md` before any
consequential marketplace work** — anything touching business, economic,
authority, lifecycle, or compliance rules.

Read other source documents only when the active phase touches their subject, or
when the Contract and ADR leave a genuine ambiguity. The `.docx` sources are
consulted for history and meaning, not re-read by default.

**Do not silently resolve conflicts** among governing documents, or between an
instruction and a governing document. Surface the conflict for review and
proceed only under an explicit ruling. **An unresolved authority conflict is a
STOP.**

**Do not change code merely to match a lower-authority document that is stale
against the Contract.** Surface the stale document for reconciliation instead.

## Core architecture principles

(Full detail lives in the ADR — this is the orientation, not a substitute.)

- **Database first — the sole source of truth.** Monacado conducts commerce
  through an authoritative transactional platform and publishes **deterministic
  capsule projections of selected transactional truth**. The database owns every
  business fact, authority, lifecycle state, immutable source version, audit
  record, and publication obligation. **Capsules never become authoritative
  records, never create provenance, never authorize business changes, and never
  write back into transactional records.** Projection runs one way only:
  authoritative record → source version → mapping → capsule projection →
  publication. See
  [`docs/TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](docs/TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md).
- **Approved terminology.** Authoritative Source Model · Authoritative Source
  Version · Projection Mapping · Capsule Projection Shape · Capsule Projection ·
  Publication Lifecycle. Avoid unqualified "Capsule Foundation" in phase titles;
  "capsule shape" is acceptable shorthand, but formal documentation uses **Capsule
  Projection Shape**.
- **Dual representation.** For publishable descriptive entities (Product,
  Storefront, Creator, Promoter, Listing, Offer), the versioned capsule is the
  **canonical semantic representation of the exact public artifact generated and
  published from an identified authoritative database source version**. **It is
  never the canonical source of transactional truth, authority, provenance, or
  lifecycle state.** Relational records carry that truth, plus integrity,
  authorization, indexing, querying, and deterministic reconstruction.
  Financial/transactional records are relational-first and are not entity
  capsules.
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

## Deployment workflow

The active release path is:

```
local development → local validation → commit
  → push main (= Production application deployment)
  → Production validation where appropriate
```

- **`main` is the development branch; Production is the deployment target.**
- **Push to `main` = Production application deployment.** The Vercel Git
  integration automatically deploys every push to `main` to Production. There
  is no later, independent deployment step after the push: once a commit is on
  `origin/main`, its code is serving Production.
- **There is no staging environment or branch.** The retired `staging` branch
  was deleted locally and from origin; it was already fully contained in `main`.
  Do not recreate it — including as a way to solve migration ordering — and do
  not mention staging in routine prompts or reports, unless a task explicitly
  revives it.

### Migration-bearing releases

Any commit whose application code requires a new Production database migration
must **not** be pushed to `main` until that migration has been deliberately
coordinated. The order is:

1. Verify the migration is additive/safe and validated locally.
2. Apply it to Production through the approved Production migration
   credential/path — **before** Production is exposed to code that requires it.
3. Verify the Production schema.
4. Only then push (or promote) the corresponding application commit to `main`.
5. Verify Production after the deployment.

Pushing first deploys code against a schema that does not yet exist. If the
deployment tooling later supports an explicit deployment hold or manual
Production promotion, this rule may be revised.

### Production migration constraints

Learned applying Phase 1.42's migration, which failed twice on Production
before succeeding:

- **Production (Aiven MySQL) enforces `sql_require_primary_key=ON`.** A table
  created without a primary key — even a transient helper — fails (error 3750).
- **The Production migration user intentionally lacks `DROP`** (it holds
  `SELECT`, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `REFERENCES`, `INDEX`,
  `ALTER`). A migration that creates and then drops a helper table fails
  (error 1142) and can leave the table behind. Prefer ALTER-only guards, e.g. an
  emptiness check via `ADD CONSTRAINT … CHECK (<not-null column> IS NULL)`
  followed by `DROP CHECK`.
- **Local migration validation must emulate both**: run the disposable MySQL
  with `--sql-require-primary-key=ON` and apply migrations as a user granted
  exactly the Production migration privilege set — not as root.
- A failed Production migration must be resolved (`prisma migrate resolve
  --rolled-back <name>`) before it can be re-applied.

### Non-migration changes

Commits with no Production schema dependency may be pushed to `main` normally
under the current auto-deploy model.

## Validation commands

```
npm run lint
npm run typecheck
npm run test
npm run build
npm run validate
```

`validate` runs the full chain. Run it before reporting a phase complete.
