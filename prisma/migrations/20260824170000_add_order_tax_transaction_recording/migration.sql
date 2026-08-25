-- Phase 1.7 — Stripe Tax Transaction recording.
--
-- ADDITIVE ONLY. One CREATE TABLE and two foreign keys ON THE NEW TABLE. No
-- existing table is altered, nothing is dropped or renamed, no column is
-- narrowed, no committed migration is modified, and no existing row is rewritten.
--
-- OrderTaxTransaction is the post-payment counterpart to OrderTaxEvidence:
-- evidence records what a tax engine was asked and answered BEFORE the buyer was
-- charged, this records what was reported to the provider AFTER the charge
-- succeeded. Both UNIQUE keys are load-bearing — one tax transaction per Order,
-- and one per calculation evidence row — which is what makes a replayed payment
-- webhook produce ONE obligation rather than a second provider report.
--
-- Both foreign keys are RESTRICT: a tax transaction explains what was reported
-- about a sale, and deleting the Order or the calculation evidence beneath it
-- would leave a filing obligation nobody can account for.
--
-- No backfill. Orders paid before this phase have no tax transaction row and
-- cannot be given one retroactively — a provider transaction can only be created
-- from a live calculation, and inventing a reference would fabricate a report
-- that never happened. Reconciliation names those Orders instead.

-- CreateTable
CREATE TABLE `OrderTaxTransaction` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `taxEvidenceId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `providerMode` VARCHAR(16) NOT NULL,
    `providerCalculationRef` VARCHAR(191) NOT NULL,
    `providerTaxTransactionRef` VARCHAR(191) NULL,
    `providerReference` VARCHAR(191) NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `taxableBasisMinorUnits` BIGINT NOT NULL,
    `taxAmountMinorUnits` BIGINT NOT NULL,
    `providerTotalAmountMinorUnits` BIGINT NULL,
    `jurisdictionCode` VARCHAR(16) NULL,
    `treatment` VARCHAR(24) NOT NULL,
    `internalProductId` VARCHAR(191) NOT NULL,
    `productSourceRecordId` VARCHAR(191) NOT NULL,
    `productSourceRecordVersion` VARCHAR(64) NOT NULL,
    `productTaxClassification` VARCHAR(32) NOT NULL,
    `providerTaxCode` VARCHAR(64) NULL,
    `providerConfigVersion` VARCHAR(64) NULL,
    `calculatedAt` DATETIME(3) NOT NULL,
    `providerTaxTransactionCreatedAt` DATETIME(3) NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `lifecycleState` VARCHAR(24) NOT NULL,
    `recordingStatus` VARCHAR(24) NOT NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NULL,
    `lockToken` VARCHAR(64) NULL,
    `lockedAt` DATETIME(3) NULL,
    `leaseExpiresAt` DATETIME(3) NULL,
    `lastFailureCode` VARCHAR(48) NULL,
    `lastFailureClass` VARCHAR(16) NULL,
    `finalizedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OrderTaxTransaction_orderId_key`(`orderId`),
    UNIQUE INDEX `OrderTaxTransaction_taxEvidenceId_key`(`taxEvidenceId`),
    INDEX `OrderTaxTransaction_recordingStatus_nextAttemptAt_idx`(`recordingStatus`, `nextAttemptAt`),
    INDEX `OrderTaxTransaction_recordingStatus_recordedAt_idx`(`recordingStatus`, `recordedAt`),
    INDEX `OrderTaxTransaction_providerTaxTransactionRef_idx`(`providerTaxTransactionRef`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `OrderTaxTransaction` ADD CONSTRAINT `OrderTaxTransaction_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderTaxTransaction` ADD CONSTRAINT `OrderTaxTransaction_taxEvidenceId_fkey` FOREIGN KEY (`taxEvidenceId`) REFERENCES `OrderTaxEvidence`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

