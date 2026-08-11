# Storefront Capsule Projection Shape (Phase 0M.3B)

The deterministic public projection of an authoritative Storefront source
version, on the same terms Phase 0M.2B established for the Offer.

**Contract-only.** No Storefront persistence, no AgentNet Node, no publication,
no route, no UI. Nothing in this phase writes anything.

## 1. Authoritative source → public projection

The one permitted flow, and it runs one way (ADR §12):

```
StorefrontSourceVersion  →  recorded projection context  →  projection mapping
                         →  Storefront Capsule Projection Shape
                         →  (future) capsule finalization and publication
```

The **Storefront source record remains authoritative**. The projection asserts
nothing the database does not already hold, creates no provenance, authorizes no
business change, and cannot be written back.

That is enforced structurally rather than by convention:

- The mapper takes **one explicitly identified `StorefrontSourceVersion`**. There
  is no "current record" parameter, no "latest" lookup, and no repository — it
  cannot reach a database even if someone wanted it to.
- **There is no inverse function.** No `capsuleToStorefrontSource`, no
  `applyCapsule`, no write-back of any kind exists in this module or anywhere
  else, and a test asserts no such export appears.
- The mapper **never mutates its inputs**, asserted by test on both the source
  version and the context.
- The existing `contracts/architecture/transactional-truth` rules are unchanged
  and continue to govern: `capsuleEstablishesProvenance()` returns literal
  `false`, and `evaluateProjectionDirection` denies reverse flow.

## 2. The exact public field set

`data` carries exactly six members, declared once in
`PUBLIC_STOREFRONT_CAPSULE_FIELDS`:

| Public term | Source | Notes |
| --- | --- | --- |
| `publicHandle` | `publicHandle` | The public routing name. Public by construction; never an internal id. |
| `name` | `presentation.displayName` | schema.org `name`, reused verbatim. |
| `slogan` | `presentation.tagline` | schema.org `slogan`. **Omitted** when the source holds `null`. |
| `description` | `presentation.summary` | schema.org `description`, reused verbatim. **Omitted** when `null`. |
| `discoverable` | derived | Whether the storefront belongs in discovery surfaces. |
| `relationships.operatedBy` | context binding | The owner's approved public authority Node. |

`metadata` reuses the shared envelope unchanged: `capsuleId`, `bindsToNode`,
`version`, `provenance`, `nodePolicy`, `capsulePolicy`, `contentHash`.

**The allow-list is the privacy boundary.** A field absent from it has no schema
member, no mapper branch, and no way into the artifact. Three tests keep it
honest: the list must equal the schema's own keys, must equal the keys a fully
populated storefront emits, and every 0M.3A projection-eligible fact must have a
recorded disposition — published under a public term, or deliberately consumed as
a binding. Nothing can be eligible-but-forgotten.

### Absence has one spelling

`slogan` and `description` are **optional, not nullable**. A source `null`
becomes an omitted key, and an explicit `null` is refused. Two spellings of
"absent" in a hashed artifact would mean two different content hashes for the
same storefront.

### `discoverable` is the only state fact

The authoritative `lifecycle` and `visibility` enums are **not republished**. A
public vocabulary able to say `SUSPENDED` or `PRIVATE` would invite projecting
one, and only a live storefront is projectable at all. What survives is the single
distinction a consumer can act on: whether to list this storefront in search and
directories (`PUBLIC` → true, `UNLISTED` → false).

## 3. Excluded and private fields

Never projected, in any phase — this is 0M.3A's
`NEVER_PROJECTION_ELIGIBLE_STOREFRONT_DATA`, and every entry is refused as a
`data` key by test:

- **Governance** — `SUPER_OWNER`, `ADMIN`, governance assignments, and the
  authorizing actor. Who administers a storefront is nobody's business but the
  marketplace's; publishing it would disclose an organization's internal
  structure as a side effect of listing a shop.
- **Identity and account** — account ids, role assignment ids, organization
  membership, raw participant ids, legal identity.
- **Private participant data** — profile fields, email, contact details, terms
  acceptance and email-verification timestamps.
- **Payment** — payment readiness, provider identifiers, payout state, billing
  and subscription plans.
- **Internal governance** — moderation notes, underwriting, activation records,
  audit internals, retention and legal-hold state, analytics.
- **Draft workflow internals** — go-live approval itself is a projection *input*
  and never appears in the artifact.
- **Other entities' claims** — Listing contents, Product facts, and Offer
  commercial terms.

The **authorization trace does not survive projection**:
`authorizedByParticipantId` and `authorizedByActorId` record who inside the
marketplace approved a change, and the mapper never reads them, so no mapping
exists that could publish them.

A second, weaker net sits behind the allow-list: a recursive **value** scan
refuses any forbidden internal identifier anywhere in the capsule, catching an id
copy-pasted into a field that legitimately accepts strings. It is a backstop, not
the boundary.

## 4. Authority boundary

Three authorities stay distinct, and the capsule keeps them that way:

- **The owner** operates the storefront. That is what `operatedBy` says, and all
  it says.
- **Monacado** is the Publisher and Registrar (ADR §11.0/§11.1). No
  `publishedBy` or `publishedAt` member exists in this phase — those are
  publication facts, and a projection carrying them would assert an event that
  never happened.
- **The creator and the promoter** own the Product and Listing capsules
  respectively (ADR §2). A Storefront that restated their claims would create a
  second, divergent answer under the wrong authority.

`supersedes` and `revokes` are likewise absent for the same reason.

## 5. Participant / owner relationship

`data.relationships.operatedBy` is a **Registrar-issued ANS Node**, supplied by
the projection context. It is never `mon:mpart:`, never an account, and never a
legal name.

The context pairs each public identifier with the internal identifier it stands
for — `ownerAuthorityNode` with `ownerParticipantId`, `storefrontNode` with
`internalStorefrontId`. The mapper **proves the pairing against the source
version** and then discards the internal half: it is validation input and never
reaches the capsule. A context describing a different participant or a different
storefront fails with a specific bounded code rather than producing a plausible
capsule.

There is deliberately **no listing container** — no `containsListing`, `offers`,
or `product` member. A Storefront references no Listing in the source model;
Listings reference Storefronts. An array here would make every listing change a
Storefront change, and therefore a new Storefront source version.

## 6. Provenance

Mapped exactly from the source version, and **represented rather than created**:

| Provenance member | Source |
| --- | --- |
| `sourceClass` / `sourceSystem` / `sourceRecordType` | the source version's own literals |
| `sourceRecordId` | `storefrontSourceRecordId` |
| `sourceRecordVersion` | `sourceRecordVersion` |
| `acquiredAt` | `recordedAt` — the instant the authoritative fact was recorded |
| `assertionKind` | `Asserted` |
| `generatedAt` | the context's explicit instant |
| `generatorVersion` | the mapping version |
| `method` | `governed-source-version-projection` |

`mon:srec:` appears in provenance and **only** there. That is the already-approved
traceability pattern (ANS §3 / ADR §11.8): the identifier is opaque, encodes no
business meaning, and exists precisely so a published claim can be traced to the
exact governed record version it came from. It is refused everywhere in `data`.

## 7. Identity separation

The two identifier layers stay distinct (ADR §11.5):

- `mon:storefront:<opaque>` is an **internal operational identity**. It is not a
  Node ID, not a capsule ID, and never appears in a capsule.
- `an:node:<opaque>` is **Registrar-issued** and opaque. It is supplied as a
  projection input — this phase issues nothing and fabricates nothing.
- No Storefront semantics are encoded into a Node ID. A Node that embedded a
  handle, a name, or an owner would leak business meaning into the identity layer
  and become a thing authorization accidentally keys on.

`mon:storefront:` was added to the shared forbidden-prefix list, which now lives
in `contracts/capsule/internal-identifiers` — lifted out of `offer.capsule.ts`
because a rule two capsules share belongs in one place. The Offer module
re-exports every name, so its public surface is unchanged, and the addition
strengthens the Offer guard too.

## 8. Deterministic mapping

`storefrontSourceRecordToCapsuleProjection` validates first and fails closed at
every step, in order: source version → context → source-version binding →
storefront binding → owner binding → capsule version pin → mapping version pin →
eligibility → map → hash → **re-validate the output**.

That final output validation is not belt-and-braces. It is what guarantees no
internal identifier reached the capsule through a field that accepts strings.

The mapper reads **no clock**, generates **no randomness**, and performs **no
database or network access**. The generation instant is a context field. Same
source version + same context ⇒ byte-identical capsule and identical content
hash, and key insertion order in either input is irrelevant because hashing runs
over canonical JSON.

### Eligibility

Only a **live** storefront is projectable: `ACTIVE`, visibility permitting public
access, and Monacado's go-live approval standing. Go-live approval is a supplied
decision, never a Storefront field — storing it on the record the owner controls
would put the approver's decision inside the approved thing.

| Source state | Outcome |
| --- | --- |
| `DRAFT` | `DRAFT_NOT_PUBLIC` |
| `SUSPENDED` | `SUSPENDED_PUBLICATION_DEFERRED` |
| `CLOSED` | `CLOSED_PUBLICATION_DEFERRED` |
| `ACTIVE` + `PRIVATE` | `VISIBILITY_NOT_PUBLIC` |
| `ACTIVE` + not approved | `GO_LIVE_NOT_APPROVED` |
| `ACTIVE` + `PUBLIC`/`UNLISTED` + approved | projected |

`SUSPENDED` and `CLOSED` are deferred for the reason the Offer projection defers
`SUSPENDED`/`WITHDRAWN`: whether a suspension or closure should supersede,
revoke, or simply stop refreshing an already-published capsule is a
publication-lifecycle decision, and answering it by quietly projecting something
would be answering it by accident.

Both derived answers come from the source model's own `isPubliclyAccessible` and
`isDiscoverable`, never a second copy. 0M.3A is explicit that there is only one
definition of public access.

### Verification

`verifyStorefrontCapsuleProjection` re-derives the capsule and reports whether a
supplied one is the same artifact — the question a publication phase will need to
answer, and the counterpart of the Product track's
`verifyPersistedProductVersionMapping`.

It **recomputes** the supplied capsule's content hash rather than reading its
stored `metadata.contentHash`. Trusting the stored value would let a capsule whose
body had been edited — while its hash was left alone — verify successfully, which
is precisely the tampering the function exists to catch.
`storedContentHashConsistent` reports that case separately, so "someone edited the
body" stays distinguishable from "this is a different version's capsule".

## 9. Ontology and context

Five terms added, ontology and context together:

| Term | Source | Why |
| --- | --- | --- |
| `slogan` | schema.org | Exact meaning match for a storefront tagline. |
| `Storefront` | monacado | `schema:Store` is a `LocalBusiness` subtype implying physical premises, which a Monacado storefront does not have. |
| `publicHandle` | monacado | No schema.org equivalent for a marketplace routing name. |
| `discoverable` | monacado | No schema.org equivalent; derived, never a stored flag. |
| `operatedBy` | monacado | Names a Monacado marketplace role rather than schema.org's `provider`/`seller`, on the same reasoning that made `creator` a Monacado term. |

`name` and `description` are **reused verbatim** from the existing schema.org
terms — the meanings coincide exactly, and inventing Monacado duplicates would
have been the wrong call.

No unrelated ontology area was broadened. The ontology now defines 56 terms,
`contracts:validate` runs 10 checks, and the derived JSON Schema export produces 5
schemas.

## 10. Deferred: Storefront Node persistence

No Storefront AgentNet Node is issued, persisted, or requested. The Node is a
**projection input** — an identifier someone else issued, which the capsule binds
to. Binding to an identifier is not the same act as issuing one (ADR §11.2).

A future phase must decide what warrants a Storefront Node at all, and must not
derive one from `mon:storefront:` or from the public handle.

## 11. Deferred: publication

No publication, outbox, receipt, reconciliation, or Registrar interaction exists
for Storefronts. The projection stops at a validated, hashed artifact.

The Product track shows what publication additionally requires — a
`ProductPublication` row, an outbox item, a submission attempt, a receipt, and
reconciliation — and none of it is created here. The `SUSPENDED`/`CLOSED`
publication decision is deferred with it.

## 12. Relationship to future Listing capsules

A Listing capsule (0M.4B) will reference a Storefront Node, not the reverse. The
authority partition ADR §2 requires must hold: **a Listing may not restate or
override the creator's Product facts**, and a Storefront may not restate a
Listing's.

This projection is deliberately shaped so that adding Listings later requires no
change to it. Because the Storefront publishes no listing container, a listing
being added, reordered, or removed produces no Storefront source version and
therefore no new Storefront capsule.

## Reference

- [`AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md`](AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md) — the 0M.3A source model this projects
- [`OFFER_CAPSULE_PROJECTION_SHAPE.md`](OFFER_CAPSULE_PROJECTION_SHAPE.md) — the 0M.2B pattern followed here
- [`TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md`](TRANSACTIONAL_TRUTH_AND_CAPSULE_PROJECTION_ADR.md)
- [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) — binding ADR
- [`PARTICIPANT_PERSISTENCE.md`](PARTICIPANT_PERSISTENCE.md) — the owner participant this projection binds through
- [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md)
