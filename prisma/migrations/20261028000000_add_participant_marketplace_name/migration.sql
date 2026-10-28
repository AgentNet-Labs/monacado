-- Phase 1.43 — mName: Monacado's assigned marketplace identifier for a
-- MarketplaceParticipant (Contract §4, §5).
--
-- ADDITIVE ONLY. One nullable column and its unique index. No backfill, no
-- helper table, no DROP: it needs only the ALTER and INDEX privileges, and
-- creates no table, so Production's `sql_require_primary_key` does not apply.
--
-- The application assigns an mName in the transaction that creates each
-- participant row, so every participant created from this release on has one.
-- A row created earlier keeps NULL, which every consumer reads as "no mName" —
-- never filled from a declared name, `Account.name`, an email, or an id. Such a
-- row is refused a Promotion Authorization request and kept out of the
-- Promotable Catalog until a governed issuance exists for it.
--
-- NULL is not a value the unique index compares, so any number of earlier rows
-- may coexist without one.

-- AlterTable
ALTER TABLE `MarketplaceParticipant` ADD COLUMN `marketplaceName` VARCHAR(16) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `MarketplaceParticipant_marketplaceName_key` ON `MarketplaceParticipant`(`marketplaceName`);
