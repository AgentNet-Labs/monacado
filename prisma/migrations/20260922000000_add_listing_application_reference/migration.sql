-- Phase 1.35 prerequisite. One column, one index, and nothing else: no lifecycle
-- change, no withdrawal state, no pricing, no Offer, no activation, no quota.
--
-- Listing.listingRef — the stable application-facing PLACEMENT reference.
--
-- Phase 1.34 gave a Seller the ability to create a placement but no way to name
-- one afterwards: `internalListingId` is `mon:listing:<opaque>` and
-- `listingSourceRecordId` is `mon:srec:<opaque>`, both internal identities that
-- must never reach a client, and the primary key is a primary key. A placement
-- was therefore write-only — it could be made and never referred to again,
-- which is why nothing could withdraw one.
--
-- IT NAMES THE AGGREGATE, NOT A VERSION. A Listing mints a new immutable source
-- version whenever its material state moves, and this reference does not move
-- with it. That is the whole point: a link held before a withdrawal still names
-- the same placement after it.
--
-- Written to be correct on a POPULATED database, not merely on the empty one it
-- is first applied to. The same four-step sequence Phase 1.34 used for
-- `Product.productRef`, for the same reason: MySQL cannot add a NOT NULL UNIQUE
-- column with per-row values in one step.
--
-- THE BACKFILL VALUE IS CRYPTOGRAPHICALLY RANDOM, NOT DERIVED. `RANDOM_BYTES` is
-- MySQL's CSPRNG and is evaluated once PER ROW, so no two rows can receive the
-- same value from one statement and no value is derivable from the placement it
-- names. `HEX()` of 16 such bytes is 32 characters of 128 bits drawn from
-- `[0-9A-F]`, a strict subset of the Crockford alphabet the application-side
-- generator uses — so a backfilled value and a minted one are the same shape and
-- satisfy the same format rule. A sequence, a row number, a hash of the Listing
-- id, or a UUID() (time- and MAC-derived, and therefore enumerable) would each
-- have failed the non-enumerability requirement.
--
-- Nothing is backfilled on Production, because there is nothing to backfill.

ALTER TABLE `Listing` ADD COLUMN `listingRef` VARCHAR(32) NULL;

UPDATE `Listing` SET `listingRef` = HEX(RANDOM_BYTES(16)) WHERE `listingRef` IS NULL;

ALTER TABLE `Listing` MODIFY COLUMN `listingRef` VARCHAR(32) NOT NULL;

CREATE UNIQUE INDEX `Listing_listingRef_key` ON `Listing`(`listingRef`);
