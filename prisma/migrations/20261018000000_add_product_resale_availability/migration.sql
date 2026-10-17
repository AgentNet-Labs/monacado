-- Phase 1.40 — Seller-controlled Product resale availability (Contract §9.3).
--
-- Additive only. One new table. No column is added, dropped, or narrowed on any
-- existing table, no existing row is touched, and no existing migration is
-- changed.
--
-- ── What is stored, and what is not ──────────────────────────────────────────
--
--   ProductResaleAvailabilityAct
--       one Seller act setting a Product's resale availability (AVAILABLE,
--       PAUSED, WITHDRAWN). The current state is the row holding the unique
--       `currentForProductId` marker; a Product with no row is NOT_OFFERED, the
--       default — so no backfill is needed and none is done. Each act names the
--       act it superseded (`supersedesActId`, unique), so the history is one
--       linear chain that is never rewritten.
--
-- Not stored: any resale / commerce boolean. Resale-effectiveness (lifecycle
-- ACTIVE and resale AVAILABLE) is derived on read. The lifecycle is untouched
-- and still derived, never stored. The legacy `factPromotable` column on the
-- immutable source version is NOT read by, and does not seed, this table.

-- CreateTable
CREATE TABLE `ProductResaleAvailabilityAct` (
    `id` VARCHAR(191) NOT NULL,
    `internalProductId` VARCHAR(191) NOT NULL,
    `resaleAvailability` VARCHAR(16) NOT NULL,
    `previousResaleAvailability` VARCHAR(16) NOT NULL,
    `supersedesActId` VARCHAR(191) NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `actedByAccountId` VARCHAR(191) NOT NULL,
    `actedAt` DATETIME(3) NOT NULL,
    `lifecycleAtAct` VARCHAR(16) NOT NULL,
    `currentForProductId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ProductResaleAvailabilityAct_supersedesActId_key`(`supersedesActId`),
    UNIQUE INDEX `ProductResaleAvailabilityAct_currentForProductId_key`(`currentForProductId`),
    INDEX `ProductResaleAvailabilityAct_internalProductId_actedAt_idx`(`internalProductId`, `actedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ProductResaleAvailabilityAct` ADD CONSTRAINT `ProductResaleAvailabilityAct_internalProductId_fkey` FOREIGN KEY (`internalProductId`) REFERENCES `Product`(`internalProductId`) ON DELETE RESTRICT ON UPDATE CASCADE;
