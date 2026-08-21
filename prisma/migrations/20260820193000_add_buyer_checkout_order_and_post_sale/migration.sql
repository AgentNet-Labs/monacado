-- AlterTable
ALTER TABLE `TransactionEconomicSnapshot` ADD COLUMN `orderId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `Order` (
    `id` VARCHAR(191) NOT NULL,
    `buyerKind` VARCHAR(16) NOT NULL,
    `buyerAccountId` VARCHAR(191) NULL,
    `buyerParticipantId` VARCHAR(191) NULL,
    `guestClaimCodeDigest` VARCHAR(64) NULL,
    `claimedByAccountId` VARCHAR(191) NULL,
    `claimedAt` DATETIME(3) NULL,
    `internalListingId` VARCHAR(191) NOT NULL,
    `listingSourceRecordId` VARCHAR(191) NOT NULL,
    `listingSourceRecordVersion` VARCHAR(64) NOT NULL,
    `policyId` VARCHAR(191) NOT NULL,
    `policyVersion` VARCHAR(64) NOT NULL,
    `storefrontId` VARCHAR(191) NOT NULL,
    `internalProductId` VARCHAR(191) NOT NULL,
    `transactionType` VARCHAR(16) NOT NULL,
    `sellerParticipantId` VARCHAR(191) NOT NULL,
    `promoterParticipantId` VARCHAR(191) NULL,
    `currency` VARCHAR(3) NOT NULL,
    `quotedCommercialRetailAmountMinorUnits` BIGINT NOT NULL,
    `quotedTaxAmountMinorUnits` BIGINT NOT NULL,
    `quotedShippingAmountMinorUnits` BIGINT NOT NULL,
    `quotedOtherPassThroughAmountMinorUnits` BIGINT NOT NULL,
    `lifecycle` VARCHAR(24) NOT NULL,
    `paymentFailureCode` VARCHAR(32) NULL,
    `placedAt` DATETIME(3) NOT NULL,
    `paidAt` DATETIME(3) NULL,
    `failedAt` DATETIME(3) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Order_guestClaimCodeDigest_key`(`guestClaimCodeDigest`),
    INDEX `Order_buyerAccountId_placedAt_idx`(`buyerAccountId`, `placedAt`),
    INDEX `Order_sellerParticipantId_lifecycle_idx`(`sellerParticipantId`, `lifecycle`),
    INDEX `Order_promoterParticipantId_lifecycle_idx`(`promoterParticipantId`, `lifecycle`),
    INDEX `Order_internalListingId_placedAt_idx`(`internalListingId`, `placedAt`),
    INDEX `Order_lifecycle_placedAt_idx`(`lifecycle`, `placedAt`),
    INDEX `Order_listingSourceRecordId_listingSourceRecordVersion_idx`(`listingSourceRecordId`, `listingSourceRecordVersion`),
    INDEX `Order_policyId_policyVersion_idx`(`policyId`, `policyVersion`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProceedsObligation` (
    `id` VARCHAR(191) NOT NULL,
    `snapshotId` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `party` VARCHAR(16) NOT NULL,
    `amountMinorUnits` BIGINT NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `state` VARCHAR(16) NOT NULL,
    `accruedAt` DATETIME(3) NOT NULL,
    `becameEligibleAt` DATETIME(3) NULL,
    `paidAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ProceedsObligation_participantId_state_idx`(`participantId`, `state`),
    INDEX `ProceedsObligation_state_accruedAt_idx`(`state`, `accruedAt`),
    UNIQUE INDEX `ProceedsObligation_snapshotId_party_key`(`snapshotId`, `party`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PurchaseEvidence` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `purchaseProvenance` VARCHAR(16) NOT NULL,
    `submitter` VARCHAR(16) NOT NULL,
    `internalProductId` VARCHAR(191) NOT NULL,
    `sellerParticipantId` VARCHAR(191) NOT NULL,
    `establishedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PurchaseEvidence_orderId_key`(`orderId`),
    INDEX `PurchaseEvidence_internalProductId_idx`(`internalProductId`),
    INDEX `PurchaseEvidence_sellerParticipantId_idx`(`sellerParticipantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ReviewSubmissionAuthority` (
    `id` VARCHAR(191) NOT NULL,
    `reviewSubmissionId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `purchaseEvidenceId` VARCHAR(191) NOT NULL,
    `reviewKind` VARCHAR(24) NOT NULL,
    `reviewSubjectRef` VARCHAR(191) NOT NULL,
    `submitter` VARCHAR(16) NOT NULL,
    `purchaseProvenance` VARCHAR(16) NOT NULL,
    `submissionState` VARCHAR(16) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ReviewSubmissionAuthority_reviewSubmissionId_key`(`reviewSubmissionId`),
    INDEX `ReviewSubmissionAuthority_reviewKind_reviewSubjectRef_idx`(`reviewKind`, `reviewSubjectRef`),
    INDEX `ReviewSubmissionAuthority_purchaseEvidenceId_idx`(`purchaseEvidenceId`),
    UNIQUE INDEX `ReviewSubmissionAuthority_orderId_reviewKind_key`(`orderId`, `reviewKind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `TransactionEconomicSnapshot_orderId_key` ON `TransactionEconomicSnapshot`(`orderId`);

-- AddForeignKey
ALTER TABLE `TransactionEconomicSnapshot` ADD CONSTRAINT `TransactionEconomicSnapshot_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_buyerAccountId_fkey` FOREIGN KEY (`buyerAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_claimedByAccountId_fkey` FOREIGN KEY (`claimedByAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_buyerParticipantId_fkey` FOREIGN KEY (`buyerParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_internalListingId_fkey` FOREIGN KEY (`internalListingId`) REFERENCES `Listing`(`internalListingId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_listingSourceRecordId_listingSourceRecordVersion_fkey` FOREIGN KEY (`listingSourceRecordId`, `listingSourceRecordVersion`) REFERENCES `ListingSourceRecordVersionRow`(`listingSourceRecordId`, `sourceRecordVersion`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_policyId_policyVersion_fkey` FOREIGN KEY (`policyId`, `policyVersion`) REFERENCES `CommercialPolicyVersionRow`(`policyId`, `policyVersion`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_storefrontId_fkey` FOREIGN KEY (`storefrontId`) REFERENCES `Storefront`(`internalStorefrontId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_internalProductId_fkey` FOREIGN KEY (`internalProductId`) REFERENCES `Product`(`internalProductId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_sellerParticipantId_fkey` FOREIGN KEY (`sellerParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_promoterParticipantId_fkey` FOREIGN KEY (`promoterParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProceedsObligation` ADD CONSTRAINT `ProceedsObligation_snapshotId_fkey` FOREIGN KEY (`snapshotId`) REFERENCES `TransactionEconomicSnapshot`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProceedsObligation` ADD CONSTRAINT `ProceedsObligation_participantId_fkey` FOREIGN KEY (`participantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseEvidence` ADD CONSTRAINT `PurchaseEvidence_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseEvidence` ADD CONSTRAINT `PurchaseEvidence_internalProductId_fkey` FOREIGN KEY (`internalProductId`) REFERENCES `Product`(`internalProductId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PurchaseEvidence` ADD CONSTRAINT `PurchaseEvidence_sellerParticipantId_fkey` FOREIGN KEY (`sellerParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReviewSubmissionAuthority` ADD CONSTRAINT `ReviewSubmissionAuthority_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ReviewSubmissionAuthority` ADD CONSTRAINT `ReviewSubmissionAuthority_purchaseEvidenceId_fkey` FOREIGN KEY (`purchaseEvidenceId`) REFERENCES `PurchaseEvidence`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

