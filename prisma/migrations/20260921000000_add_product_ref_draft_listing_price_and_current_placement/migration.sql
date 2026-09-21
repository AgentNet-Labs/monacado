-- Phase 1.34 prerequisite schema work. Three independent rulings, one migration,
-- and nothing else: no Listing route, no UI, no activation, no Offer, no quota.
--
-- Written to be correct on a POPULATED database, not merely on the empty one it
-- is first applied to. Production holds 39 applied migrations and zero
-- application rows today; that is a fact about today, not a licence to assume it.
--
-- =========================================================================
-- A. Product.productRef — the stable application-facing Product reference
-- =========================================================================
--
-- MySQL cannot add a NOT NULL UNIQUE column with per-row values in one step, so
-- the standard safe sequence is used: add nullable, backfill every existing row
-- with its own value, tighten to NOT NULL, then add the unique index. Each step
-- is safe to run against rows that already exist, and none reads or rewrites any
-- other column.
--
-- THE BACKFILL VALUE IS CRYPTOGRAPHICALLY RANDOM, NOT DERIVED. `RANDOM_BYTES`
-- is MySQL's CSPRNG and is evaluated once PER ROW, so no two rows can receive
-- the same value from one statement and no value is derivable from the Product
-- it names. `HEX()` of 16 such bytes is 32 characters of 128 bits drawn from
-- `[0-9A-F]`, which is a strict subset of the Crockford alphabet the
-- application-side generator uses — so a backfilled value and a minted one are
-- the same shape and satisfy the same format rule. A sequence, a row number, a
-- hash of the Product id, or a UUID() (time- and MAC-derived, and therefore
-- enumerable) would each have failed the non-enumerability requirement.
--
-- Nothing is backfilled on Production, because there is nothing to backfill.

ALTER TABLE `Product` ADD COLUMN `productRef` VARCHAR(32) NULL;

UPDATE `Product` SET `productRef` = HEX(RANDOM_BYTES(16)) WHERE `productRef` IS NULL;

ALTER TABLE `Product` MODIFY COLUMN `productRef` VARCHAR(32) NOT NULL;

CREATE UNIQUE INDEX `Product_productRef_key` ON `Product`(`productRef`);

-- =========================================================================
-- B. A private DRAFT Listing may exist without commercial price
-- =========================================================================
--
-- Product = item. Listing = placement. Offer = commercial terms. A private draft
-- placement states which Product appears in which Storefront, and that statement
-- does not require a price. The alternative — inserting a zero or a placeholder —
-- would put a fabricated commercial fact into an authoritative record, which is
-- precisely what the transactional-truth ADR forbids.
--
-- LOOSENING ONLY. No row is read, no row is rewritten, no default is introduced,
-- and every existing priced Listing keeps exactly the values it has. The two
-- columns remain a PAIR: both present or both NULL. MySQL cannot express that
-- pairing as a column constraint, so it is held where it can be held
-- structurally — the contract keeps them in one nested object, and the
-- persistence mapper refuses a half-populated row on the way out.
--
-- Commercial activation is unaffected and still requires both; that gate lives
-- in the Listing service's `DRAFT -> ACTIVE` path.

ALTER TABLE `ListingSourceRecordVersionRow`
  MODIFY COLUMN `retailPriceMinorUnits` BIGINT       NULL,
  MODIFY COLUMN `retailPriceCurrency`   VARCHAR(3)   NULL;

-- =========================================================================
-- C. At most one CURRENT Listing per Product + Storefront
-- =========================================================================
--
-- The marker holds one canonical value, `CURRENT`, while a Listing aggregate
-- still holds its (Product, Storefront) pair, and NULL once a terminal lifecycle
-- state has released it. MySQL's unique indexes do not constrain NULLs, so the
-- composite index below permits any number of released placements for a pair
-- while permitting at most one current placement — which is exactly
-- MARKETPLACE_ASSORTMENT_AND_LISTING_RULES.md §5.
--
-- Immutable historical SOURCE VERSIONS are untouched: they live on
-- `ListingSourceRecordVersionRow` and are not aggregates, so a Listing with
-- fifty versions is one placement, not fifty.
--
-- BACKFILL. Every existing Listing in a non-terminal state (`DRAFT`, `ACTIVE`,
-- `SUSPENDED`) becomes current; `ENDED` and `WITHDRAWN` — the two states
-- 0M.4A's transition table leaves with no exit — become NULL. No lifecycle
-- transition is invented for this migration and no lifecycle value is changed.
--
-- IF A POPULATED INSTALLATION ALREADY HOLDS TWO CURRENT LISTINGS FOR ONE PAIR,
-- the CREATE UNIQUE INDEX below FAILS and this migration stops. That is
-- deliberate. Silently NULLing one of them would be this migration deciding, on
-- its own authority, which of a seller's two placements stops being the
-- placement — a commercial decision no schema change may make. Such an
-- installation resolves the duplicates first.

ALTER TABLE `Listing` ADD COLUMN `currentPlacementMarker` VARCHAR(16) NULL;

UPDATE `Listing`
   SET `currentPlacementMarker` = 'CURRENT'
 WHERE `lifecycle` NOT IN ('ENDED', 'WITHDRAWN');

CREATE UNIQUE INDEX `Listing_current_placement_unique`
    ON `Listing`(`internalProductId`, `storefrontId`, `currentPlacementMarker`);
