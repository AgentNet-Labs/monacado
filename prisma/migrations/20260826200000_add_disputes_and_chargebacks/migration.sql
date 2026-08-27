-- Phase 1.11 -- Disputes and Chargebacks.
--
-- Additive. Two new tables (TransactionDispute, TransactionDisputeEvent) and a
-- widening of ProceedsRecoveryException so a recovery claim can be raised by a
-- dispute as well as by a refund.
--
-- The one non-additive step is deliberate: the UNIQUE index on
-- ProceedsRecoveryException.proceedsObligationId is replaced by a composite
-- UNIQUE on (proceedsObligationId, causeKind). Phase 1.9 made it unique because
-- one refund per Order meant one occasion for an exception against a claim. A
-- sale can now be refunded AND then charged back, and those are two separate
-- claims against the same party that an operator must see separately. No row
-- loses a value: every existing row backfills to causeKind = 'REFUND' and its
-- obligation id is already distinct, so the widened constraint admits every row
-- the narrow one did.

-- DropForeignKey
ALTER TABLE `ProceedsRecoveryException` DROP FOREIGN KEY `ProceedsRecoveryException_proceedsObligationId_fkey`;

-- DropIndex
DROP INDEX `ProceedsRecoveryException_proceedsObligationId_key` ON `ProceedsRecoveryException`;

-- AlterTable
-- Phase 1.11. `causeKind` is added WITH a default and then stripped of it, so
-- that any row Phase 1.9 already wrote backfills to REFUND -- the only cause
-- that existed before this migration -- rather than failing the ALTER or
-- landing as an empty string. The column carries no default afterwards,
-- because every writer from here on states the cause explicitly.
ALTER TABLE `ProceedsRecoveryException` ADD COLUMN `causeKind` VARCHAR(16) NOT NULL DEFAULT 'REFUND',
    ADD COLUMN `disputeId` VARCHAR(191) NULL,
    MODIFY `refundId` VARCHAR(191) NULL;

UPDATE `ProceedsRecoveryException` SET `causeKind` = 'REFUND' WHERE `causeKind` = '';

ALTER TABLE `ProceedsRecoveryException` ALTER COLUMN `causeKind` DROP DEFAULT;

-- CreateTable
CREATE TABLE `TransactionDispute` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NULL,
    `snapshotId` VARCHAR(191) NULL,
    `provider` VARCHAR(32) NOT NULL,
    `providerMode` VARCHAR(16) NOT NULL,
    `providerDisputeRef` VARCHAR(191) NOT NULL,
    `providerTransactionRef` VARCHAR(191) NOT NULL,
    `providerChargeRef` VARCHAR(191) NULL,
    `disputedAmountMinorUnits` BIGINT NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `reasonCode` VARCHAR(32) NOT NULL,
    `status` VARCHAR(32) NOT NULL,
    `fundsState` VARCHAR(24) NOT NULL,
    `taxConsequence` VARCHAR(48) NOT NULL,
    `economicEffect` VARCHAR(40) NOT NULL,
    `evidenceDueBy` DATETIME(3) NULL,
    `responsePermitted` BOOLEAN NOT NULL DEFAULT true,
    `evidenceStagedAtProvider` BOOLEAN NOT NULL DEFAULT false,
    `evidenceSubmissionCount` INTEGER NOT NULL DEFAULT 0,
    `evidenceSubmittedPastDue` BOOLEAN NOT NULL DEFAULT false,
    `chargeStillRefundable` BOOLEAN NOT NULL DEFAULT false,
    `remediationCode` VARCHAR(48) NULL,
    `lastProviderEventAt` DATETIME(3) NOT NULL,
    `openedAt` DATETIME(3) NOT NULL,
    `fundsWithdrawnAt` DATETIME(3) NULL,
    `fundsReinstatedAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `reversalId` VARCHAR(191) NULL,

    UNIQUE INDEX `TransactionDispute_reversalId_key`(`reversalId`),
    INDEX `TransactionDispute_status_openedAt_idx`(`status`, `openedAt`),
    INDEX `TransactionDispute_status_evidenceDueBy_idx`(`status`, `evidenceDueBy`),
    INDEX `TransactionDispute_fundsState_fundsWithdrawnAt_idx`(`fundsState`, `fundsWithdrawnAt`),
    INDEX `TransactionDispute_orderId_idx`(`orderId`),
    INDEX `TransactionDispute_providerTransactionRef_idx`(`providerTransactionRef`),
    UNIQUE INDEX `TransactionDispute_provider_providerDisputeRef_key`(`provider`, `providerDisputeRef`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TransactionDisputeEvent` (
    `id` VARCHAR(191) NOT NULL,
    `disputeId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `providerEventId` VARCHAR(191) NOT NULL,
    `eventKind` VARCHAR(32) NOT NULL,
    `applied` BOOLEAN NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TransactionDisputeEvent_disputeId_occurredAt_idx`(`disputeId`, `occurredAt`),
    UNIQUE INDEX `TransactionDisputeEvent_provider_providerEventId_key`(`provider`, `providerEventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ProceedsRecoveryException_disputeId_idx` ON `ProceedsRecoveryException`(`disputeId`);

-- CreateIndex
CREATE UNIQUE INDEX `ProceedsRecoveryException_proceedsObligationId_causeKind_key` ON `ProceedsRecoveryException`(`proceedsObligationId`, `causeKind`);


-- AddForeignKey
ALTER TABLE `ProceedsRecoveryException` ADD CONSTRAINT `ProceedsRecoveryException_disputeId_fkey` FOREIGN KEY (`disputeId`) REFERENCES `TransactionDispute`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransactionDispute` ADD CONSTRAINT `TransactionDispute_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransactionDispute` ADD CONSTRAINT `TransactionDispute_snapshotId_fkey` FOREIGN KEY (`snapshotId`) REFERENCES `TransactionEconomicSnapshot`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransactionDispute` ADD CONSTRAINT `TransactionDispute_reversalId_fkey` FOREIGN KEY (`reversalId`) REFERENCES `TransactionReversal`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransactionDisputeEvent` ADD CONSTRAINT `TransactionDisputeEvent_disputeId_fkey` FOREIGN KEY (`disputeId`) REFERENCES `TransactionDispute`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- Re-add the foreign key dropped above.
--
-- MySQL requires the FK to be dropped before its backing UNIQUE index can be
-- replaced, so the DropForeignKey at the top of this migration is mechanical
-- rather than intentional. RESTRICT is restored exactly as Phase 1.9 declared
-- it: a recovery exception is a financial claim in the opposite direction to a
-- payout, and the obligation beneath it must never be deletable.
ALTER TABLE `ProceedsRecoveryException` ADD CONSTRAINT `ProceedsRecoveryException_proceedsObligationId_fkey` FOREIGN KEY (`proceedsObligationId`) REFERENCES `ProceedsObligation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
