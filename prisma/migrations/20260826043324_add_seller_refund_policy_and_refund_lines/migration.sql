/*
  Warnings:

  - Added the required column `coversWholeOrder` to the `OrderRefund` table without a default value. This is not possible if the table is not empty.
  - Added the required column `linesRetailMinorUnits` to the `OrderRefund` table without a default value. This is not possible if the table is not empty.
  - Added the required column `linesTaxMinorUnits` to the `OrderRefund` table without a default value. This is not possible if the table is not empty.
  - Added the required column `refundedShippingMinorUnits` to the `OrderRefund` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sellerRefundPolicyId` to the `OrderRefund` table without a default value. This is not possible if the table is not empty.
  - Added the required column `sellerRefundPolicyVersion` to the `OrderRefund` table without a default value. This is not possible if the table is not empty.
  - Added the required column `attributableAmountMinorUnits` to the `ProceedsRecoveryException` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE `Order` ADD COLUMN `sellerRefundPolicyId` VARCHAR(191) NULL,
    ADD COLUMN `sellerRefundPolicyVersion` VARCHAR(64) NULL;

-- AlterTable
ALTER TABLE `OrderRefund` ADD COLUMN `coversWholeOrder` BOOLEAN NOT NULL,
    ADD COLUMN `linesRetailMinorUnits` BIGINT NOT NULL,
    ADD COLUMN `linesTaxMinorUnits` BIGINT NOT NULL,
    ADD COLUMN `refundedShippingMinorUnits` BIGINT NOT NULL,
    ADD COLUMN `sellerRefundPolicyId` VARCHAR(191) NOT NULL,
    ADD COLUMN `sellerRefundPolicyVersion` VARCHAR(64) NOT NULL;

-- AlterTable
ALTER TABLE `ProceedsRecoveryException` ADD COLUMN `attributableAmountMinorUnits` BIGINT NOT NULL;

-- CreateTable
CREATE TABLE `SellerRefundPolicy` (
    `id` VARCHAR(191) NOT NULL,
    `sellerParticipantId` VARCHAR(191) NOT NULL,
    `label` VARCHAR(200) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SellerRefundPolicy_sellerParticipantId_key`(`sellerParticipantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SellerRefundPolicyVersionRow` (
    `seq` BIGINT NOT NULL AUTO_INCREMENT,
    `policyId` VARCHAR(191) NOT NULL,
    `policyVersion` VARCHAR(64) NOT NULL,
    `sellerParticipantId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `refundsAllowed` BOOLEAN NOT NULL,
    `eligibilityConditions` VARCHAR(255) NOT NULL,
    `refundWindowDays` INTEGER NULL,
    `shippingRefundability` VARCHAR(32) NOT NULL,
    `procedureKind` VARCHAR(32) NOT NULL,
    `documentJson` TEXT NOT NULL,
    `contentHash` VARCHAR(80) NOT NULL,
    `effectiveFrom` DATETIME(3) NOT NULL,
    `recordedByAccountId` VARCHAR(191) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `activatedAt` DATETIME(3) NULL,
    `retiredAt` DATETIME(3) NULL,
    `activeMarker` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `SellerRefundPolicyVersionRow_policyId_status_idx`(`policyId`, `status`),
    INDEX `SellerRefundPolicyVersionRow_sellerParticipantId_status_idx`(`sellerParticipantId`, `status`),
    INDEX `SellerRefundPolicyVersionRow_effectiveFrom_idx`(`effectiveFrom`),
    UNIQUE INDEX `SellerRefundPolicyVersionRow_policyId_policyVersion_key`(`policyId`, `policyVersion`),
    UNIQUE INDEX `SellerRefundPolicyVersionRow_activeMarker_key`(`activeMarker`),
    PRIMARY KEY (`seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderRefundLine` (
    `seq` BIGINT NOT NULL AUTO_INCREMENT,
    `refundId` VARCHAR(191) NOT NULL,
    `lineRef` VARCHAR(220) NOT NULL,
    `internalProductId` VARCHAR(191) NOT NULL,
    `listingSourceRecordId` VARCHAR(191) NOT NULL,
    `listingSourceRecordVersion` VARCHAR(64) NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `commercialRetailAmountMinorUnits` BIGINT NOT NULL,
    `taxAmountMinorUnits` BIGINT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OrderRefundLine_internalProductId_idx`(`internalProductId`),
    UNIQUE INDEX `OrderRefundLine_refundId_lineRef_key`(`refundId`, `lineRef`),
    PRIMARY KEY (`seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OrderRefundContactEvidence` (
    `orderId` VARCHAR(191) NOT NULL,
    `contactAddress` VARCHAR(320) NOT NULL,
    `contactSource` VARCHAR(24) NOT NULL,
    `contactState` VARCHAR(24) NOT NULL,
    `capturedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`orderId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_sellerRefundPolicyId_sellerRefundPolicyVersion_fkey` FOREIGN KEY (`sellerRefundPolicyId`, `sellerRefundPolicyVersion`) REFERENCES `SellerRefundPolicyVersionRow`(`policyId`, `policyVersion`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SellerRefundPolicy` ADD CONSTRAINT `SellerRefundPolicy_sellerParticipantId_fkey` FOREIGN KEY (`sellerParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SellerRefundPolicyVersionRow` ADD CONSTRAINT `SellerRefundPolicyVersionRow_policyId_fkey` FOREIGN KEY (`policyId`) REFERENCES `SellerRefundPolicy`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderRefundLine` ADD CONSTRAINT `OrderRefundLine_refundId_fkey` FOREIGN KEY (`refundId`) REFERENCES `OrderRefund`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OrderRefundContactEvidence` ADD CONSTRAINT `OrderRefundContactEvidence_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
