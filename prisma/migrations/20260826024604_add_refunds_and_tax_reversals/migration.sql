-- CreateTable
CREATE TABLE `OrderRefund` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `snapshotId` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(16) NOT NULL,
    `reasonCode` VARCHAR(32) NOT NULL,
    `requestorKind` VARCHAR(16) NOT NULL,
    `requestedByAccountId` VARCHAR(191) NULL,
    `requestedAt` DATETIME(3) NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `providerMode` VARCHAR(16) NOT NULL,
    `providerTransactionRef` VARCHAR(191) NOT NULL,
    `providerRefundRef` VARCHAR(191) NULL,
    `providerRefundCreatedAt` DATETIME(3) NULL,
    `currency` VARCHAR(3) NOT NULL,
    `amountMinorUnits` BIGINT NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `status` VARCHAR(24) NOT NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NULL,
    `lockToken` VARCHAR(64) NULL,
    `lockedAt` DATETIME(3) NULL,
    `leaseExpiresAt` DATETIME(3) NULL,
    `lastFailureCode` VARCHAR(48) NULL,
    `lastFailureClass` VARCHAR(16) NULL,
    `finalizedAt` DATETIME(3) NULL,
    `requeueCount` INTEGER NOT NULL DEFAULT 0,
    `lastRequeuedAt` DATETIME(3) NULL,
    `reversalId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OrderRefund_orderId_key`(`orderId`),
    UNIQUE INDEX `OrderRefund_snapshotId_key`(`snapshotId`),
    UNIQUE INDEX `OrderRefund_reversalId_key`(`reversalId`),
    INDEX `OrderRefund_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    INDEX `OrderRefund_status_recordedAt_idx`(`status`, `recordedAt`),
    INDEX `OrderRefund_providerTransactionRef_idx`(`providerTransactionRef`),
    UNIQUE INDEX `OrderRefund_provider_providerRefundRef_key`(`provider`, `providerRefundRef`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderTaxReversal` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `refundId` VARCHAR(191) NOT NULL,
    `taxTransactionId` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(16) NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `providerMode` VARCHAR(16) NOT NULL,
    `originalProviderTaxTransactionRef` VARCHAR(191) NOT NULL,
    `providerReversalRef` VARCHAR(191) NULL,
    `providerReversalCreatedAt` DATETIME(3) NULL,
    `providerReference` VARCHAR(191) NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `reversedTaxAmountMinorUnits` BIGINT NOT NULL,
    `reversedTaxableBasisMinorUnits` BIGINT NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `status` VARCHAR(24) NOT NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NULL,
    `lockToken` VARCHAR(64) NULL,
    `lockedAt` DATETIME(3) NULL,
    `leaseExpiresAt` DATETIME(3) NULL,
    `lastFailureCode` VARCHAR(48) NULL,
    `lastFailureClass` VARCHAR(16) NULL,
    `finalizedAt` DATETIME(3) NULL,
    `requeueCount` INTEGER NOT NULL DEFAULT 0,
    `lastRequeuedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OrderTaxReversal_orderId_key`(`orderId`),
    UNIQUE INDEX `OrderTaxReversal_refundId_key`(`refundId`),
    UNIQUE INDEX `OrderTaxReversal_taxTransactionId_key`(`taxTransactionId`),
    INDEX `OrderTaxReversal_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    INDEX `OrderTaxReversal_status_recordedAt_idx`(`status`, `recordedAt`),
    INDEX `OrderTaxReversal_originalProviderTaxTransactionRef_idx`(`originalProviderTaxTransactionRef`),
    UNIQUE INDEX `OrderTaxReversal_provider_providerReversalRef_key`(`provider`, `providerReversalRef`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProceedsRecoveryException` (
    `id` VARCHAR(191) NOT NULL,
    `refundId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `snapshotId` VARCHAR(191) NOT NULL,
    `proceedsObligationId` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `party` VARCHAR(16) NOT NULL,
    `amountMinorUnits` BIGINT NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `reasonCode` VARCHAR(32) NOT NULL,
    `obligationStateAtRefund` VARCHAR(16) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `resolutionCode` VARCHAR(48) NULL,
    `raisedAt` DATETIME(3) NOT NULL,
    `acknowledgedAt` DATETIME(3) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ProceedsRecoveryException_proceedsObligationId_key`(`proceedsObligationId`),
    INDEX `ProceedsRecoveryException_status_raisedAt_idx`(`status`, `raisedAt`),
    INDEX `ProceedsRecoveryException_participantId_status_idx`(`participantId`, `status`),
    INDEX `ProceedsRecoveryException_refundId_idx`(`refundId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `OrderRefund` ADD CONSTRAINT `OrderRefund_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderRefund` ADD CONSTRAINT `OrderRefund_snapshotId_fkey` FOREIGN KEY (`snapshotId`) REFERENCES `TransactionEconomicSnapshot`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderRefund` ADD CONSTRAINT `OrderRefund_requestedByAccountId_fkey` FOREIGN KEY (`requestedByAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderRefund` ADD CONSTRAINT `OrderRefund_reversalId_fkey` FOREIGN KEY (`reversalId`) REFERENCES `TransactionReversal`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderTaxReversal` ADD CONSTRAINT `OrderTaxReversal_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderTaxReversal` ADD CONSTRAINT `OrderTaxReversal_refundId_fkey` FOREIGN KEY (`refundId`) REFERENCES `OrderRefund`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderTaxReversal` ADD CONSTRAINT `OrderTaxReversal_taxTransactionId_fkey` FOREIGN KEY (`taxTransactionId`) REFERENCES `OrderTaxTransaction`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProceedsRecoveryException` ADD CONSTRAINT `ProceedsRecoveryException_refundId_fkey` FOREIGN KEY (`refundId`) REFERENCES `OrderRefund`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProceedsRecoveryException` ADD CONSTRAINT `ProceedsRecoveryException_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProceedsRecoveryException` ADD CONSTRAINT `ProceedsRecoveryException_snapshotId_fkey` FOREIGN KEY (`snapshotId`) REFERENCES `TransactionEconomicSnapshot`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProceedsRecoveryException` ADD CONSTRAINT `ProceedsRecoveryException_proceedsObligationId_fkey` FOREIGN KEY (`proceedsObligationId`) REFERENCES `ProceedsObligation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProceedsRecoveryException` ADD CONSTRAINT `ProceedsRecoveryException_participantId_fkey` FOREIGN KEY (`participantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
