# Marketplace Assortment and Listing Rules (Phase 1.33, amended at Phase 1.34)

The governing commercial rules for **what a Seller may hold, where it may be
placed, and what that placement costs a Storefront**. Archived here so later
Listing phases implement them rather than rediscover them.

```
Product library        →  Listing placement           →  Offer economics
what the thing IS          where it is shown, in one     the commercial terms
(creator authority)        Storefront (placement          (creator authority)
                           authority)
```

These are three separate authorities and three separate records. None of them
may be collapsed into another ([`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) §2;
[`LISTING_SOURCE_MODEL.md`](LISTING_SOURCE_MODEL.md); [`AUTHORITATIVE_OFFER_SOURCE_MODEL.md`](AUTHORITATIVE_OFFER_SOURCE_MODEL.md)).

Rules marked **(implemented)** are enforced in code today; rules marked
**(governing, not yet enforced)** bind the Listing phases that follow and are
listed with their gaps in §9.

## 1. The Product library is independent of Storefront capacity

**(implemented — Phase 1.33 correction.)**

A Seller may create and maintain any number of Products. Creating a Product
consumes nothing: no Storefront slot, no Listing slot, and no allowance of any
kind. There is **no free-plan limit on Product records** — Phase 1.32's
five-Product limit was a rule in the wrong layer and has been removed.

A Product may sit in its Seller's library indefinitely without being placed in
any Storefront. Private Product drafts never count toward any capacity.

Product authoring stays **SELLER-only** (`canCreateDraftProduct`), decided with
the participant's standing inside the write transaction; a promoter never authors
Product facts (ADR §2).

## 2. Storefront capacity is counted in active Listings

**(governing, not yet enforced.)**

Each Storefront includes up to **5 active Product Listings** on the free tier.

- The allowance is **per Storefront** — never per account, Seller, Promoter,
  Product creator, or Product library. Every Storefront has its own independent
  capacity; opening a second Storefront does not share or pool it.
- Conceptually:

  ```
  activeListingAllowance(storefront) =
      5 included Listings
    + paid Storefront Listing entitlement quantity
  ```

- **Every active Listing consumes one slot, whatever the Product's ownership.**
  For one free Storefront, all of these are valid and all use all 5 slots:
  5 Seller-owned Products · 3 Seller-owned + 2 promoted · 1 Seller-owned +
  4 promoted · 5 promoted.

### When the quota applies

The quota counts **active / listed placements** only:

- Products merely created do not count.
- Private Product drafts do not count.
- A `DRAFT` Listing that is not displayed does not consume an active slot,
  unless a later Listing phase explicitly defines otherwise.

**Activation of a Listing (`DRAFT → ACTIVE`) is the enforcement boundary.** That
is where "owned active < allowed" must be decided — inside the write, under the
same lock-then-locking-count construction the Storefront allowance uses
(Phase 1.30), so two activations cannot both take the last slot.

**The active-Listing quota remains separate from §5 and is still unenforced.**
Phase 1.34 made *placement uniqueness* structural and added a narrow guard
refusing activation of an unpriced placement; it did **not** add a count, an
allowance, or a paid entitlement. Capacity belongs to activation and is that
phase's work.

### Where the paid upgrade lives

The paid capacity entitlement belongs to **the Storefront's Listing capacity**.
It is **not** a Product-creation entitlement, **not** a Seller-global or
Promoter-global Product quota, and **not** an `AccountEntitlement` — which
records internal operational grants only and never marketplace or commercial
authority (0M.1 §1).

## 3. A Listing is the placement of one Product in one Storefront

**(implemented structurally.)**

- **Product** — the authoritative identity and content of the item, under the
  creator's authority.
- **Listing** — the placement of that Product in **one specific Storefront**,
  under the placement authority of that Storefront's owner or its governance.
- **Offer** — the commercial terms, under the creator's authority.

A Listing never restates or overrides the creator's Product facts, and never
modifies an Offer.

## 4. One Product may appear in many Storefronts

**(governing; structurally permitted today.)**

A Product may have Listings in **any number of eligible Storefronts**. There is
**no global "claimed", "consumed", "taken", or exclusive-placement state** for a
Product.

Listing a Product in its Seller's own Storefront **does not remove it from
circulation for promotion**. A promotable Product may simultaneously appear in
one or more Storefronts its Seller controls, one or more independent Promoter
Storefronts, and other eligible Storefronts.

## 5. At most one current placement per Product + Storefront

**(implemented structurally — Phase 1.34.)**

At most **one current Listing aggregate** exists for a given **Product +
Storefront** pair. Historical immutable Listing versions are expected and are not
duplicates: a Listing with fifty source versions is one placement, not fifty.

`Listing.currentPlacementMarker` holds the canonical string `CURRENT` while an
aggregate holds its pair and NULL once a **terminal** lifecycle state (`ENDED`,
`WITHDRAWN`) has released it, and the composite unique index
`(internalProductId, storefrontId, currentPlacementMarker)` enforces the rule in
the database. MySQL's unique indexes do not constrain NULLs, so any number of
released placements may exist for a pair while at most one may be current — a
seller who withdraws a placement may make a new one, and the withdrawn one's
history survives beside it. No release transition was invented for this: both
terminal states already existed.

The application also asks, inside the write transaction, so an ordinary caller
receives the bounded `LISTING_ALREADY_EXISTS` rather than a database error; the
index is the concurrency backstop, and its collision is mapped back to the same
error. **The rule governs both branches** — placement uniqueness is a property of
the shelf, not of who put the item on it.

See [`LISTING_PERSISTENCE.md`](LISTING_PERSISTENCE.md) §11.

## 6. Seller Storefronts may mix owned and promoted Products

**(governing.)**

A Storefront is a **merchandising surface, not a Product-ownership boundary**. A
Seller is not limited to their own Products: if another Seller's Product is
legitimately promotable, the Storefront owner may place it under the
promoted-Listing rules, beside their own seller-direct Listings.

## 7. Promotability is eligibility, not exclusivity

**(governing.)**

A Product's `promotable` fact means **the Product is eligible for legitimate
third-party promotion**. It does **not** mean:

- only while absent from the Seller's own Storefront;
- only one Promoter may list it;
- the first Promoter claims it;
- that seller-direct placement disables promotion.

**Seller-direct placement must never change `promotable`.** Promotion does not
transfer anything (§8.3).

Promotion eligibility is expressed at two levels today, and both remain
authoritative for their own question: the Product fact `promotable` (the
creator's statement that the Product may be promoted at all) and the Offer's
`terms.promotion` (`PROMOTABLE`, with the commission basis — the commercial terms
a promoted Listing binds to). A promoted Listing needs the Offer's terms;
reconciling the two is Listing-phase work (§9).

## 8. Seller-direct versus promoted — by economic principal

**(governing; the principal comparison is not yet enforceable — §9.)**

The relationship is classified by the **economic principals**, not by role
labels:

- **Seller-direct Listing:** Product creator's economic principal **==**
  Storefront owner's economic principal.
- **Promoted Listing:** Product creator's economic principal **!=** Storefront
  owner's (promoting) economic principal, **and** the Product is eligible for
  promotion.

Holding both SELLER and PROMOTER roles does **not** make a principal independent
of itself.

### 8.1 Anti-self-promotion

A Seller must not obtain promoter treatment — commission or margin — for their
own Product by any of: adding the PROMOTER role; opening another Storefront;
labelling a Storefront a promoter Storefront; or using another marketplace role
assignment. **Promoter treatment requires genuine economic independence** between
the Product creator and the Storefront owner / promoting principal.

### 8.2 Cross-account gaming

**Different Account ids do not imply independent principals.** Promoted-Listing
authority must eventually refuse self-promotion when separate accounts resolve to
the same **governed economic / commercial principal** — the principal the
marketplace establishes through onboarding and underwriting. That resolution
subsystem does not exist yet and is not invented here; this is the requirement it
must meet.

### 8.3 What a Promoter Listing does not do

A Promoter Listing does **not** transfer Product ownership or Product authority,
does **not** change the Product's creator, does **not** remove the Product from
any other Storefront, and does **not** prevent additional independent Promoters
from listing the same promotable Product.

## 9. Current implementation and the gaps before promoted Listings launch

Recorded at Phase 1.33 from the code and schema as they stand.

Updated at Phase 1.34 where that phase changed the answer.

| Question | Today |
| --- | --- |
| Many Listings per Product? | **Yes, structurally.** `Listing.internalProductId` is indexed, not unique. |
| Many Listings per Storefront? | **Yes, structurally.** `Listing.storefrontId` is indexed, not unique. |
| Same Product in several Storefronts? | **Permitted.** |
| Two CURRENT Listings for the same Product + Storefront? | **Refused — Phase 1.34.** Composite unique index over `(internalProductId, storefrontId, currentPlacementMarker)`, plus a bounded `LISTING_ALREADY_EXISTS` in the write path. Released (terminal) placements are unconstrained. |
| Must a DRAFT Listing carry a price? | **No — Phase 1.34.** A private `SELLER_DIRECT` draft may carry none; price and currency are a nullable pair. A `PROMOTED` placement still requires both, and `DRAFT → ACTIVE` refuses an unpriced placement. |
| Does a Product have an application-facing reference? | **Yes — Phase 1.34.** `Product.productRef`: opaque, immutable, server-minted, unique. Application routing identity only — not a semantic or public AgentNet identity. |
| Listing lifecycle | `DRAFT`, `ACTIVE`, `SUSPENDED`, `ENDED`, `WITHDRAWN`; created `DRAFT`; `→ ACTIVE` is a separate governed act. |
| Seller-direct pathway | `createSellerDirectListing` / `openSellerDirectListing`: `canCreateSellerDirectListing` (SELLER role), controller is the acting participant, controller holds Product authority (`participantHoldsProductAuthority`), and Storefront placement authority (owner, or ACTIVE governance assignment). |
| Promoted pathway | `createPromotedListing` / `openPromotedListing`: `canCreatePromotedListing` (PROMOTER role), controller is the acting participant, Storefront placement authority, and an exact accepted Offer version whose terms are PAID and `PROMOTABLE`. |
| What decides promoter authority? | **The PROMOTER role label**, plus Storefront authority and the Offer's promotion terms. |
| Same economic principal across roles/accounts? | **Not identifiable.** A participant is one account's marketplace identity; there is no governed economic-principal record linking participants, accounts, or legal entities. |
| Listing capacity | **No count or allowance exists.** |

**Gaps to close before promoted Listings can safely launch:**

1. **Self-promotion refusal (same participant).** The promoted path does not
   compare the promoter with the Offer's seller / the Product's creator
   participant; a participant holding both roles could promote its own Offer.
   Refuse at minimum when they are the same participant. **Unresolved, and
   Phase 1.34 did not touch it** — promoted Listing anti-gaming and
   economic-principal resolution remain REQUIRED before promoted Listing
   self-service is exposed. Promoted Listings stay non-self-service until both
   are settled.
2. **Economic-principal resolution (§8.2).** A governed principal established
   through onboarding/underwriting, so self-promotion across separate accounts
   can be refused.
3. ~~**One current placement per Product + Storefront (§5)**~~ — **closed at
   Phase 1.34** with a nullable current-placement marker and a composite unique
   index, exactly as anticipated here.
4. **Active-Listing allowance at activation (§2)** — 5 per Storefront, lock-and-
   count inside the `→ ACTIVE` write. **Still open**, and separate from §5:
   Phase 1.34 added no count, allowance, or paid entitlement.
5. **Promotability reconciliation (§7)** — whether a promoted Listing must also
   require the Product fact `promotable`, beside the Offer's `PROMOTABLE` terms.
6. **Seller-direct Listing self-service** — the placement route and UI for a
   Seller's own draft Product into their own draft Storefront.

## Reference

- [`LISTING_SOURCE_MODEL.md`](LISTING_SOURCE_MODEL.md) — Listing authority, the SELLER_DIRECT / PROMOTED union
- [`LISTING_PERSISTENCE.md`](LISTING_PERSISTENCE.md) — authorization, lifecycle, and FKs as persisted
- [`AUTHORITATIVE_OFFER_SOURCE_MODEL.md`](AUTHORITATIVE_OFFER_SOURCE_MODEL.md) — the commercial terms a promoted Listing binds to
- [`AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md`](AUTHORITATIVE_STOREFRONT_SOURCE_MODEL.md) — the placement container
- [`PRODUCT_CAPSULE.md`](PRODUCT_CAPSULE.md) — Product facts, including `promotable`
- [`MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md`](MARKETPLACE_ACCOUNT_ROLE_AND_ACTIVATION_ARCHITECTURE.md) — roles, and why `AccountEntitlement` is not commercial
- [`CDD_ARCHITECTURE_DECISIONS.md`](CDD_ARCHITECTURE_DECISIONS.md) — binding ADR
