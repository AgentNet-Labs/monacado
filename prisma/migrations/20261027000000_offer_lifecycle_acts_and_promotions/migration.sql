-- Phase 1.42 — Offer authority, lifecycle, commercial terms, and scheduled
-- promotions (Contract §12, §16, §19).
--
-- DESTRUCTIVE to two columns on each Offer table, and therefore guarded: the
-- migration refuses to run unless `Offer` and `OfferSourceRecordVersionRow` are
-- EMPTY. Production held 0 Offer rows when this was written (no route ever
-- reached the 0M.6 service), and the guard makes that a precondition rather
-- than an assumption. Nothing else is touched.
--
-- ── Why the columns go ───────────────────────────────────────────────────────
--
--   `lifecycle` / `availability` lived on every immutable commercial version
--   (mirrored onto `Offer`), so pausing or resuming an Offer minted a new
--   "commercial" version that changed no term — and, classified as a material
--   change, would have forced every Promoter to re-accept unchanged economics.
--   Lifecycle is now Seller AUTHORITY, recorded as append-only `OfferAct` rows
--   and derived on read; versions hold commercial terms only.
--
--   `effectiveStartsAt` / `effectiveEndsAt` become `promotionEffectiveFrom` /
--   `promotionEffectiveUntil`: the half-open window of a SCHEDULED_PROMOTION
--   version, NULL on a STANDING version. The Offer's own optional overall end is
--   Seller lifecycle authority and lives on the ACTIVATE act.
--
-- ── What is added ────────────────────────────────────────────────────────────
--
--   Offer.offerRef                 opaque application reference (unique)
--   Offer.nonTerminalForProductId  unique marker: one NON-TERMINAL Offer per
--                                  Product; released on WITHDRAW, or by a later
--                                  create that observes the holder derived ENDED
--   Offer.currentPromotionVersion  the most recently scheduled promotion
--   OfferSourceRecordVersionRow.termsKind / basisStandingVersion
--   OfferAct                       one linear, append-only act chain per Offer
--
-- Not stored: any lifecycle, ENDED, "promotion running", or effective-terms
-- value. Each is derived from these rows and an instant.

-- Guard: refuse unless both Offer tables are EMPTY, before any DDL below.
--
-- Each ADD CONSTRAINT names a CHECK that every existing row violates (the
-- column is NOT NULL), so on a non-empty table MySQL refuses it with error 3819
-- and adds nothing; on an empty table it succeeds and is dropped at once. It
-- needs only the ALTER privilege and creates no table: Production's migration
-- user has no DROP privilege, and Production enforces `sql_require_primary_key`.
-- (CHECK is enforced from MySQL 8.0.16.)
--
-- If it refuses, nothing has changed and Prisma records the migration as
-- failed. Recovery, once the Offer rows are understood: `prisma migrate resolve
-- --rolled-back 20261027000000_offer_lifecycle_acts_and_promotions`.
ALTER TABLE `Offer` ADD CONSTRAINT `_phase_1_42_offer_must_be_empty` CHECK (`createdAt` IS NULL);
ALTER TABLE `Offer` DROP CHECK `_phase_1_42_offer_must_be_empty`;
ALTER TABLE `OfferSourceRecordVersionRow` ADD CONSTRAINT `_phase_1_42_offer_versions_must_be_empty` CHECK (`rowCreatedAt` IS NULL);
ALTER TABLE `OfferSourceRecordVersionRow` DROP CHECK `_phase_1_42_offer_versions_must_be_empty`;

-- DropIndex
DROP INDEX `Offer_lifecycle_availability_idx` ON `Offer`;

-- AlterTable
ALTER TABLE `Offer` DROP COLUMN `availability`,
    DROP COLUMN `lifecycle`,
    ADD COLUMN `currentPromotionVersion` VARCHAR(64) NULL,
    ADD COLUMN `nonTerminalForProductId` VARCHAR(191) NULL,
    ADD COLUMN `offerRef` VARCHAR(32) NOT NULL;

-- AlterTable
ALTER TABLE `OfferSourceRecordVersionRow` DROP COLUMN `availability`,
    DROP COLUMN `effectiveEndsAt`,
    DROP COLUMN `effectiveStartsAt`,
    DROP COLUMN `lifecycle`,
    ADD COLUMN `basisStandingVersion` VARCHAR(64) NULL,
    ADD COLUMN `promotionEffectiveFrom` DATETIME(3) NULL,
    ADD COLUMN `promotionEffectiveUntil` DATETIME(3) NULL,
    ADD COLUMN `termsKind` VARCHAR(24) NOT NULL;

-- CreateTable
CREATE TABLE `OfferAct` (
    `id` VARCHAR(191) NOT NULL,
    `internalOfferId` VARCHAR(191) NOT NULL,
    `act` VARCHAR(16) NOT NULL,
    `state` VARCHAR(16) NOT NULL,
    `previousState` VARCHAR(16) NOT NULL,
    `supersedesActId` VARCHAR(191) NULL,
    `currentForOfferId` VARCHAR(191) NULL,
    `activatedStandingVersion` VARCHAR(64) NULL,
    `offerEffectiveUntil` DATETIME(3) NULL,
    `endedPromotionVersion` VARCHAR(64) NULL,
    `actorParticipantId` VARCHAR(191) NOT NULL,
    `actedByAccountId` VARCHAR(191) NOT NULL,
    `actedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `OfferAct_supersedesActId_key`(`supersedesActId`),
    UNIQUE INDEX `OfferAct_currentForOfferId_key`(`currentForOfferId`),
    INDEX `OfferAct_internalOfferId_actedAt_idx`(`internalOfferId`, `actedAt`),
    INDEX `OfferAct_actorParticipantId_idx`(`actorParticipantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `Offer_offerRef_key` ON `Offer`(`offerRef`);

-- CreateIndex
CREATE UNIQUE INDEX `Offer_nonTerminalForProductId_key` ON `Offer`(`nonTerminalForProductId`);

-- AddForeignKey
ALTER TABLE `OfferAct` ADD CONSTRAINT `OfferAct_internalOfferId_fkey` FOREIGN KEY (`internalOfferId`) REFERENCES `Offer`(`internalOfferId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OfferAct` ADD CONSTRAINT `OfferAct_actorParticipantId_fkey` FOREIGN KEY (`actorParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
