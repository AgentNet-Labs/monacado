# Notification Obligation Records (Phase 0M.N1)

Status: **binding** for the 0M marketplace track, subordinate to
[`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) and
[`AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md`](AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md) §3a.

## 1. Obligation versus delivery

**An obligation is the record that Monacado *owes* a notice. It is not a
message.**

Nothing in this phase sends, renders, addresses, schedules, or retries anything.
There is no channel, no template, no body, no subject line, no locale, no
delivery attempt, no retry count, and no provider message id — `0M.N2` owns all
of it, and a test walks 21 named delivery and contact fields proving each is
refused by the input and absent from the table.

The separation is what makes the obligation durable. Storefront §3a rules that
**the Monacado admin panel is the canonical channel**: email, SMS, and push may
later *accompany* a notice and can never replace it, because a channel outside
Monacado's control cannot be the system of record for an obligation. An
obligation that survives independently of whether any channel worked is the
executable form of that rule.

`0M.N1` is complete without delivery. Every governed obligation is recorded,
deduplicated, and lifecycle-tracked; what remains is showing and sending it.

## 2. Recipient identity

An obligation binds to a persisted **`MarketplaceParticipant`**, `RESTRICT` on
the foreign key — an obligation Monacado owes must not vanish with a delete.

**Never an email address.** An address is a delivery destination and a mutable
contact detail; keying an obligation on one would hand a promoter's notices to
whoever holds the address next, which is the same reason the identity foundation
refuses to key authorization on email. Where a notice is eventually *sent* is
`0M.N2`'s question, answered from the participant.

Storefront §3a additionally records that notices should be visible to the
promoter participant's active `SUPER_OWNER` and `ADMIN` governance users. That is
a **read-side** concern — who may see a participant's obligations — and belongs
with the admin panel in `0M.N2`. The obligation itself is owed to the
participant, which is the durable fact.

## 3. Lifecycle

The four states `POST_0E7_MARKETPLACE_ROADMAP.md` §0M.N already names. No fifth
was invented.

| State | Meaning |
| --- | --- |
| `UNREAD` | owed, and not yet looked at |
| `ACKNOWLEDGED` | the recipient has seen it — **informational only** |
| `RESOLVED` | the thing it asked for has been done |
| `ARCHIVED` | terminal, and out of the working view |

```
UNREAD       → ACKNOWLEDGED, RESOLVED, ARCHIVED
ACKNOWLEDGED → RESOLVED, ARCHIVED
RESOLVED     → ARCHIVED
ARCHIVED     → (terminal)
```

**Forward-only.** Skipping is permitted — resolving something never opened is
ordinary, and archiving an obsolete notice directly is too — but nothing goes
back: "unread again" would erase that someone looked, and re-opening a resolved
obligation would misrepresent a second event as the first.

**`ACKNOWLEDGED` confers nothing.** Storefront §3a is explicit that
acknowledgement alone never reactivates a Listing, and nothing here grants any
commercial effect either.

**Archiving is not deletion.** The row stays with every instant it accumulated;
an obligation that was acknowledged and then resolved keeps both, so the record
says what happened rather than only where it ended up. There is no `DELETED`
state and no delete operation.

## 4. The Offer-change deduplication rule

The rule Storefront §3a already governs, made executable:

> **One obligation per promoter participant × exact Offer source version ×
> change category.**

Not per Listing and not per storefront: a promoter carrying the same Offer in
five storefronts has one thing to decide, and five notices would be five chances
to miss the one that mattered. Verified against the database with a promoter
holding three storefronts — one notice.

### How it is enforced

`notificationObligationKey` derives a canonical string from
`(recipient, category, subjectKind, subjectRef, subjectVersionRef, contextCode)`,
and a **unique index** on it makes deduplication a database guarantee rather than
a rule a caller remembers — or two callers racing on the same governed event.

The key is derived rather than a composite index because **two components are
nullable**, and MySQL treats each NULL in a unique index as distinct: a composite
over them would silently permit exactly the duplicates this exists to prevent. A
sentinel makes absence a value the index can compare, and a component containing
the separator is refused at the boundary rather than escaped, because an escaping
scheme is a second thing to get right.

### Which version, and for whom

The notice is **about** the effective version and **for** whoever holds the prior
one. Those are different versions on purpose — conflating them would either
notify nobody or notify about the wrong thing:

- `subjectVersionRef` is the **effective** version the change produced. A
  promoter who has answered version 3 must still be told about version 4, which
  is why the obligation binds to an exact version rather than to the Offer.
- Recipients are the distinct promoters whose **current** promoted Listing
  version binds the **prior** Offer version. A Listing that has since moved to a
  newer version has already answered for this one.

**Recipients are derived, never supplied.** The input has no recipient field: a
caller naming its own list could miss a promoter, and missing one is the failure
the obligation exists to prevent.

### The classifier is reused, never restated

The caller passes exactly what the committed `classifyOfferBusinessChanges`
returned. No Offer economics are recomputed and no classification rule is copied
— a notice that disagreed with the committed classifier about what changed would
be worse than no notice. `contextCode` is the `OfferBusinessChangeCategory`
itself, so the notice and the classification cannot drift apart.

### Idempotent

Replaying one governed Offer change returns the obligations that already exist
rather than failing or duplicating. A notification pipeline that could not be
safely re-run would be one nobody dares re-run.

**A replay updates nothing.** An obligation the promoter has already
acknowledged does not silently return to `UNREAD`.

The general `createNotificationObligation` path takes the opposite view
deliberately and **refuses** a duplicate: a caller reaching it directly asked for
a *new* obligation, and quietly returning an old one would hide that the event
had already been recorded.

## 5. Future `0M.9` compatibility

**Category and subject are separate axes**, which is what makes this model
survive `0M.9`. The category says what kind of thing is owed; the subject says
what it is about, as a kind plus a reference plus an optional exact version.

An order-confirmation obligation is a **new vocabulary member and a new subject
kind — not a new table, and not a column added to an Offer-shaped schema.**
Verified: an `ORDER_CONFIRMATION` obligation with a null version and null context
persists and reads back through the same model with no schema change.

Named for `0M.9`, with **no producer in this phase**: `ORDER_CONFIRMATION` ·
`SALE_RECORDED` · `PAYMENT_FAILED` · `PAYOUT_STATE_CHANGED` ·
`REFUND_OR_CHARGEBACK` · `REVIEW_ELIGIBILITY` · `OPERATIONAL_ACTION_REQUIRED`.
Subject kinds: `OFFER` · `ORDER` · `PAYMENT` · `PAYOUT` · `REVIEW`.

`IMPLEMENTED_NOTIFICATION_CATEGORIES` names the one category with a producer
today — `OFFER_CHANGE` — so "named" and "implemented" stay distinguishable.
Both vocabularies stay closed: unknown values are refused.

`subjectVersionRef` is nullable **because some obligations are version-specific
and some are not**. An Offer-change notice is about one exact source version; an
order confirmation is about an order, which has no version axis, and forcing one
would be a sentinel nobody could read.

`0M.9` adds a member and calls `createNotificationObligation`. It needs no
migration, no new model, and no change to the deduplication machinery.

## 6. Explicit fields, never a payload

Everything the record carries is an identifier, a member of a closed vocabulary,
or an instant. No JSON blob, no rendered content, no free text — so an obligation
is safe to render, safe to log, and cannot become the place private notice
content accumulates. `contextCode` in particular is a bounded enum rather than a
string: a context that could hold a sentence would become where the notice body
lived, and then where private detail lived.

Storefront §3a's notice **content** requirements — the affected Offer, affected
storefronts and Listing count, previous and new values, whether Listings remain
sellable, the required action, a path to the affected Listings — are a
**rendering** concern. Every one of them is derivable at render time from the
obligation's subject plus the persisted Offer and Listing records, which is why
none is duplicated here. §3a's closing constraint holds by construction: a notice
"must never expose another participant's private identity or internal audit
evidence", and this model has no field that could carry either.

## 7. Service operations

`createNotificationObligation` · `recordOfferChangeObligations` ·
`getNotificationObligation` · `listParticipantObligations` (full history, or
narrowed to the `UNREAD`/`ACKNOWLEDGED` working set) ·
`advanceNotificationObligation`, with `acknowledge` / `resolve` / `archive` as
thin named wrappers over the single lifecycle write so three paths cannot drift.

No routes, no UI, no delivery, and no operation that deletes.

## 8. Deferred

**`0M.N2` — notification delivery channels.** Rendering, addressing, the admin
panel view, supplemental email/SMS/push, delivery attempts and outcomes, and the
`SUPER_OWNER`/`ADMIN` visibility rule.

**`0M.T1` — MoR transaction accounting foundation**, and **`0M.9`** — the
producers for every category named but unimplemented above.

---

## Reference

- [`AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md`](AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md) — §3a, the governing rule
- [`AUTHORITATIVE_OFFER_SOURCE_MODEL.md`](AUTHORITATIVE_OFFER_SOURCE_MODEL.md) — the change classification this reuses
- [`OFFER_PERSISTENCE.md`](OFFER_PERSISTENCE.md) · [`LISTING_PERSISTENCE.md`](LISTING_PERSISTENCE.md) — the exact version binding
- [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) — binding ADR
- [`POST_0E7_MARKETPLACE_ROADMAP.md`](POST_0E7_MARKETPLACE_ROADMAP.md)
