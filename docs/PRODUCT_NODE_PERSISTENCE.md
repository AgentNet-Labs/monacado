# Product Node Persistence & Lifecycle (Phase 0E.1)

The durable **AgentNet Product Node** and Monacado's **offline Registrar-domain**
operations. This phase adds the Node model, opaque-identity contract, issuance,
and ANS lifecycle management — **no** publication records, outbox, receipts,
reconciliation, network calls, or capsule submission. Follows the ADR and
[`PRODUCT_PERSISTENCE.md`](PRODUCT_PERSISTENCE.md).

## Purpose & distinction from Product identity

- **Product** (Phase 0D) — the stable Monacado application identity plus its
  immutable source-record version history. `internalProductId` = `mon:product:…`.
- **Product Node** (this phase) — the enduring **AgentNet Node** that anchors the
  Product in the AgentNet graph. `nodeId` = an opaque `an:node:…`.

They are distinct identities on separate rows. **ANS lifecycle lives on the
Node** — never on Product source records or capsules (ADR §11.9). Changing a
Node's lifecycle never touches Product records, current-version pointer, or
historical versions.

## Opaque Registrar-issued identity

`nodeId` reuses the strict Phase 0B `AnsNodeId` contract: an opaque
`an:node:<opaque>` that **rejects** semantic URLs, slugs, Product IDs
(`mon:product:…`), source-record IDs (`mon:srec:…`), capsule IDs
(`an:capsule:…`), and any identifier encoding entity type/role/name/hierarchy.
`nodeId` is **unique and immutable**; it is **never derived from Product
identity** — the caller (Registrar) supplies it. `nodeKind` is an internal
classification (`product`) and is **not** encoded into `nodeId`.

Test identifiers are clearly synthetic; they are **not** issued by a live
accredited Registrar.

## Monacado's offline Registrar role

Monacado operates the Registrar domain for its walled garden (ADR §11.2, §11.14).
This phase persists the Registrar identity (`an:registrar:monacado`) and an
optional accreditation reference on each Node. **Accreditation verification is
deferred** — no live Registrar, and no claim of accredited status. Publisher and
Registrar remain logically separate roles (ADR §11.3); this phase implements only
Registrar-domain Node issuance/lifecycle.

## Node Policy reference

Each Node persists `nodePolicyRef` + `nodePolicyVersion` (structural policy
linkage). Effective Policy evaluation is deferred.

## Model & constraints

`ProductNode`: surrogate `id`, unique immutable `nodeId`, unique
`internalProductId` (**one Node per Product**), `nodeKind`, `lifecycleState`,
`lifecycleChangedAt`, optional `lifecycleReasonCode`, `nodePolicyRef` /
`nodePolicyVersion`, `registrarId`, optional `registrarAccreditationRef`,
`issuedAt`, `createdAt`, `updatedAt`. FK `internalProductId → Product` with
**`ON DELETE RESTRICT`** — deleting a Product cannot cascade-delete Node history.
Additive migration only.

## Lifecycle states & transitions

States: `Active`, `Inactive`, `Retired`, `Revoked`. Transition matrix:

| From | Allowed to |
| --- | --- |
| Active | Inactive, Revoked, Retired |
| Inactive | Active, Revoked, Retired |
| Retired | *(terminal)* |
| Revoked | *(terminal)* |

- Same-state transitions are **idempotent no-ops** (no write, no reason needed).
- Invalid transitions (incl. any from a terminal state) fail with
  `InvalidLifecycleTransitionError`.
- `lifecycleReasonCode` is **required** when transitioning into `Revoked` or
  `Retired`.
- `lifecycleChangedAt` is supplied explicitly at the service boundary.

## Issuance & idempotency

`issueProductNode` verifies the stable Product exists, validates the opaque
`nodeId`, enforces one Node per Product, and persists Registrar identity, policy
reference, and issuance time (initial lifecycle `Active` at `issuedAt`).

- **Idempotent:** repeating issuance with identical issuance-time fields returns
  the existing Node.
- **Conflict:** a repeat with a different `nodeId`, `nodeKind`, policy ref/
  version, Registrar identity, accreditation ref, or `issuedAt` fails with
  `NodeIssuanceConflictError` (conflicting field names only — no values). A
  `nodeId` already anchoring another Product also conflicts.

## Operations

`ProductNodeRepository` (offline Registrar domain): `issueProductNode`,
`getProductNode`, `getProductNodeByInternalProductId`,
`transitionProductNodeLifecycle`. All return validated domain objects
(`PersistedNodeContractViolationError` if stored data is malformed); Prisma types
stay inside the adapter.

## Error model

`ProductNotFoundError`, `ProductNodeNotFoundError`, `InvalidNodeIdError`,
`NodeIssuanceConflictError`, `InvalidLifecycleTransitionError`,
`PersistedNodeContractViolationError` (+ `DatabaseError`). Stable codes; no
`DATABASE_URL`/credentials/host details in messages.

## Validation & commands

`db:check` verifies the Node table, unique `nodeId`/`internalProductId`, the FK,
synthetic issuance, retrieval by both keys, and one lifecycle transition (cleaned
up, no destructive reset). `db:test` runs the DB-backed integration suites
serially against the disposable database (`RUN_DB_TESTS=1 --no-file-parallelism`).

## Deferred

Accreditation verification; publication records, outbox, retries/claims,
Registrar receipts, reconciliation; capsule payload persistence; live Publisher/
Registrar/Resolver calls; AgentNet credentials; production DB wiring; auth;
Stripe; UI; Storefront/Listing/Offer/Review. A lifecycle-event audit table was
**not** added this phase (the current Node row carries `lifecycleState` +
`lifecycleChangedAt` + `lifecycleReasonCode`; a full event history can be added
later if a richer audit trail is required).
