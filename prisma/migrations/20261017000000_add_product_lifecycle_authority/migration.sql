-- Phase 1.39 — Product lifecycle authority and explicit Product activation
-- (Contract §9.1, §9.2).
--
-- Additive only. Three new tables and one new NULLABLE column. No column is
-- dropped or narrowed, and no existing migration is changed.
--
-- ── What is stored, and what is not ──────────────────────────────────────────
--
-- The Product lifecycle (INCOMPLETE / COMPLETE / ACTIVE / SUSPENDED) is NOT a
-- column. It is derived on read from the current source version, current
-- readiness, and the two authorities below. No completeness boolean is stored.
--
--   ProductActivation  the Seller's explicit activation act — the only thing
--                      that creates ACTIVE authority — with the readiness basis
--                      it was granted against, so a later lapse (even one since
--                      restored) is recognisable on read, with no background job.
--   ProductSuspension  Monacado's governed Product block, preserving whether
--                      ACTIVE authority existed immediately before it.
--   ProductTaxClassificationAct
--                      audit evidence of a Monacado tax-classification act: who
--                      assigned which classification, when, to which version.
--                      The classification itself stays on the immutable
--                      Product source version, as since Phase 1.6.
--
-- ── ParticipantPaymentAccount.readinessEnabledSince ─────────────────────────
--
-- When payment readiness most recently ENTERED `ENABLED`; NULL otherwise. It is
-- the one readiness fact whose lapse-and-restore left no trace before: the
-- readiness column returns to the same value, and `readinessObservedAt` moves on
-- every re-observation. From now on it is written only on a transition into or
-- out of `ENABLED`.
--
-- Backfill: a row ALREADY `ENABLED` takes its last observation instant (or, if
-- none was recorded, its last update). No Product activation exists before this
-- migration, so no activation basis can be compared against a backfilled value
-- earlier than the truth; the value only has to be stable from here on. Rows in
-- any other readiness stay NULL. No other existing row is touched.

-- AlterTable
ALTER TABLE `ParticipantPaymentAccount` ADD COLUMN `readinessEnabledSince` DATETIME(3) NULL;

UPDATE `ParticipantPaymentAccount`
   SET `readinessEnabledSince` = COALESCE(`readinessObservedAt`, `updatedAt`)
 WHERE `readiness` = 'ENABLED';

-- CreateTable
CREATE TABLE `ProductActivation` (
    `id` VARCHAR(191) NOT NULL,
    `internalProductId` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `activatedByAccountId` VARCHAR(191) NOT NULL,
    `activatedAt` DATETIME(3) NOT NULL,
    `activatedSourceRecordVersion` VARCHAR(64) NOT NULL,
    `activatedVersionSeq` BIGINT NOT NULL,
    `basisEmailVerifiedAt` DATETIME(3) NOT NULL,
    `basisSellerRoleActivatedAt` DATETIME(3) NOT NULL,
    `basisPaymentEnabledSince` DATETIME(3) NOT NULL,
    `basisRestrictionCount` INTEGER NOT NULL,
    `basisParticipantSuspensionCount` INTEGER NOT NULL,
    `basisNonApprovalDecisionCount` INTEGER NOT NULL,
    `basisProductSuspensionCount` INTEGER NOT NULL,
    `supersededAt` DATETIME(3) NULL,
    `currentForProductId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ProductActivation_currentForProductId_key`(`currentForProductId`),
    INDEX `ProductActivation_internalProductId_activatedAt_idx`(`internalProductId`, `activatedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductSuspension` (
    `id` VARCHAR(191) NOT NULL,
    `internalProductId` VARCHAR(191) NOT NULL,
    `reasonCode` VARCHAR(48) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `lifecycleBeforeSuspension` VARCHAR(16) NOT NULL,
    `activationIdBeforeSuspension` VARCHAR(191) NULL,
    `imposedAt` DATETIME(3) NOT NULL,
    `imposedByAccountId` VARCHAR(191) NOT NULL,
    `liftedAt` DATETIME(3) NULL,
    `liftedByAccountId` VARCHAR(191) NULL,
    `liftedReasonCode` VARCHAR(48) NULL,
    `activeForProductId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ProductSuspension_activeForProductId_key`(`activeForProductId`),
    INDEX `ProductSuspension_internalProductId_imposedAt_idx`(`internalProductId`, `imposedAt`),
    INDEX `ProductSuspension_activationIdBeforeSuspension_idx`(`activationIdBeforeSuspension`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductTaxClassificationAct` (
    `id` VARCHAR(191) NOT NULL,
    `internalProductId` VARCHAR(191) NOT NULL,
    `sourceRecordVersion` VARCHAR(64) NOT NULL,
    `previousTaxClassification` VARCHAR(24) NULL,
    `taxClassification` VARCHAR(24) NOT NULL,
    `classifiedAt` DATETIME(3) NOT NULL,
    `classifiedByAccountId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ProductTaxClassificationAct_internalProductId_sourceRecordVe_key`(`internalProductId`, `sourceRecordVersion`),
    INDEX `ProductTaxClassificationAct_internalProductId_classifiedAt_idx`(`internalProductId`, `classifiedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ProductActivation` ADD CONSTRAINT `ProductActivation_internalProductId_fkey` FOREIGN KEY (`internalProductId`) REFERENCES `Product`(`internalProductId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductSuspension` ADD CONSTRAINT `ProductSuspension_internalProductId_fkey` FOREIGN KEY (`internalProductId`) REFERENCES `Product`(`internalProductId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductSuspension` ADD CONSTRAINT `ProductSuspension_activationIdBeforeSuspension_fkey` FOREIGN KEY (`activationIdBeforeSuspension`) REFERENCES `ProductActivation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductTaxClassificationAct` ADD CONSTRAINT `ProductTaxClassificationAct_internalProductId_fkey` FOREIGN KEY (`internalProductId`) REFERENCES `Product`(`internalProductId`) ON DELETE RESTRICT ON UPDATE CASCADE;
