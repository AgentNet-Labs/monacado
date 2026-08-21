-- AlterTable
ALTER TABLE `ProductSourceRecordVersionRow` ADD COLUMN `factDeliveryMode` VARCHAR(16) NULL;

-- CreateTable
CREATE TABLE `OrderBuyerSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(200) NOT NULL,
    `email` VARCHAR(320) NOT NULL,
    `billingLine1` VARCHAR(200) NOT NULL,
    `billingLine2` VARCHAR(200) NULL,
    `billingCity` VARCHAR(120) NOT NULL,
    `billingRegion` VARCHAR(8) NULL,
    `billingPostalCode` VARCHAR(32) NULL,
    `billingCountryCode` CHAR(2) NOT NULL,
    `shippingLine1` VARCHAR(200) NULL,
    `shippingLine2` VARCHAR(200) NULL,
    `shippingCity` VARCHAR(120) NULL,
    `shippingRegion` VARCHAR(8) NULL,
    `shippingPostalCode` VARCHAR(32) NULL,
    `shippingCountryCode` CHAR(2) NULL,
    `taxCountryCode` CHAR(2) NOT NULL,
    `taxRegionCode` VARCHAR(8) NULL,
    `detailSource` VARCHAR(24) NOT NULL,
    `capturedAt` DATETIME(3) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `OrderBuyerSnapshot_orderId_key`(`orderId`),
    INDEX `OrderBuyerSnapshot_email_idx`(`email`),
    INDEX `OrderBuyerSnapshot_taxCountryCode_taxRegionCode_idx`(`taxCountryCode`, `taxRegionCode`),
    INDEX `OrderBuyerSnapshot_detailSource_idx`(`detailSource`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderTaxEvidence` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `providerCalculationRef` VARCHAR(191) NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `taxAmountMinorUnits` BIGINT NOT NULL,
    `basisAmountMinorUnits` BIGINT NOT NULL,
    `treatment` VARCHAR(24) NOT NULL,
    `jurisdictionCode` VARCHAR(16) NULL,
    `buyerSnapshotId` VARCHAR(191) NULL,
    `calculatedAt` DATETIME(3) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `OrderTaxEvidence_orderId_key`(`orderId`),
    INDEX `OrderTaxEvidence_provider_calculatedAt_idx`(`provider`, `calculatedAt`),
    INDEX `OrderTaxEvidence_treatment_idx`(`treatment`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TransactionReversal` (
    `id` VARCHAR(191) NOT NULL,
    `snapshotId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(16) NOT NULL,
    `scope` VARCHAR(16) NOT NULL,
    `reasonCode` VARCHAR(32) NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `reversedCommercialRetailAmountMinorUnits` BIGINT NOT NULL,
    `reversedTaxAmountMinorUnits` BIGINT NOT NULL,
    `reversedShippingAmountMinorUnits` BIGINT NOT NULL,
    `reversedOtherPassThroughAmountMinorUnits` BIGINT NOT NULL,
    `reversedMonacadoRetainedAmountMinorUnits` BIGINT NOT NULL,
    `reversedSellerProceedsMinorUnits` BIGINT NOT NULL,
    `reversedPromoterNetProceedsMinorUnits` BIGINT NULL,
    `provider` VARCHAR(32) NULL,
    `providerReversalRef` VARCHAR(191) NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `TransactionReversal_snapshotId_key`(`snapshotId`),
    INDEX `TransactionReversal_orderId_idx`(`orderId`),
    INDEX `TransactionReversal_kind_occurredAt_idx`(`kind`, `occurredAt`),
    INDEX `TransactionReversal_occurredAt_idx`(`occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RiskPolicy` (
    `id` VARCHAR(191) NOT NULL,
    `label` VARCHAR(120) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `RiskPolicyVersionRow` (
    `seq` BIGINT NOT NULL AUTO_INCREMENT,
    `policyId` VARCHAR(191) NOT NULL,
    `policyVersion` VARCHAR(64) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `maxSingleOrderCommercialAmountMinorUnits` BIGINT NOT NULL,
    `requireSellerCommerceApproval` BOOLEAN NOT NULL,
    `requireSellerPaymentReadiness` BOOLEAN NOT NULL,
    `effectiveFrom` DATETIME(3) NOT NULL,
    `recordedByAccountId` VARCHAR(191) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `retiredAt` DATETIME(3) NULL,
    `retiredByAccountId` VARCHAR(191) NULL,
    `activeMarker` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `RiskPolicyVersionRow_policyId_status_idx`(`policyId`, `status`),
    INDEX `RiskPolicyVersionRow_effectiveFrom_idx`(`effectiveFrom`),
    UNIQUE INDEX `RiskPolicyVersionRow_policyId_policyVersion_key`(`policyId`, `policyVersion`),
    UNIQUE INDEX `RiskPolicyVersionRow_activeMarker_key`(`activeMarker`),
    PRIMARY KEY (`seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `OrderBuyerSnapshot` ADD CONSTRAINT `OrderBuyerSnapshot_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderTaxEvidence` ADD CONSTRAINT `OrderTaxEvidence_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderTaxEvidence` ADD CONSTRAINT `OrderTaxEvidence_buyerSnapshotId_fkey` FOREIGN KEY (`buyerSnapshotId`) REFERENCES `OrderBuyerSnapshot`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransactionReversal` ADD CONSTRAINT `TransactionReversal_snapshotId_fkey` FOREIGN KEY (`snapshotId`) REFERENCES `TransactionEconomicSnapshot`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransactionReversal` ADD CONSTRAINT `TransactionReversal_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RiskPolicyVersionRow` ADD CONSTRAINT `RiskPolicyVersionRow_policyId_fkey` FOREIGN KEY (`policyId`) REFERENCES `RiskPolicy`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

