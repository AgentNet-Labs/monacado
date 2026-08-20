-- CreateTable
CREATE TABLE `TransactionEconomicSnapshot` (
    `id` VARCHAR(191) NOT NULL,
    `transactionType` VARCHAR(16) NOT NULL,
    `internalListingId` VARCHAR(191) NOT NULL,
    `listingSourceRecordId` VARCHAR(191) NOT NULL,
    `listingSourceRecordVersion` VARCHAR(64) NOT NULL,
    `internalOfferId` VARCHAR(191) NULL,
    `offerSourceRecordId` VARCHAR(191) NULL,
    `offerSourceRecordVersion` VARCHAR(64) NULL,
    `policyId` VARCHAR(191) NOT NULL,
    `policyVersion` VARCHAR(64) NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `commercialRetailAmountMinorUnits` BIGINT NOT NULL,
    `monacadoRetainedAmountMinorUnits` BIGINT NOT NULL,
    `morWholesaleAcquisitionAmountMinorUnits` BIGINT NOT NULL,
    `sellerProceedsMinorUnits` BIGINT NOT NULL,
    `offerWholesalePriceMinorUnits` BIGINT NULL,
    `sellerFundedCommissionMinorUnits` BIGINT NULL,
    `promoterRetailSpreadMinorUnits` BIGINT NULL,
    `promoterNetProceedsMinorUnits` BIGINT NULL,
    `taxAmountMinorUnits` BIGINT NOT NULL,
    `shippingAmountMinorUnits` BIGINT NOT NULL,
    `otherPassThroughAmountMinorUnits` BIGINT NOT NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `rowCreatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `TransactionEconomicSnapshot_internalListingId_occurredAt_idx`(`internalListingId`, `occurredAt`),
    INDEX `TransactionEconomicSnapshot_listingSourceRecordId_listingSou_idx`(`listingSourceRecordId`, `listingSourceRecordVersion`),
    INDEX `TransactionEconomicSnapshot_offerSourceRecordId_offerSourceR_idx`(`offerSourceRecordId`, `offerSourceRecordVersion`),
    INDEX `TransactionEconomicSnapshot_policyId_policyVersion_idx`(`policyId`, `policyVersion`),
    INDEX `TransactionEconomicSnapshot_transactionType_occurredAt_idx`(`transactionType`, `occurredAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `TransactionSettlement` (
    `snapshotId` VARCHAR(191) NOT NULL,
    `state` VARCHAR(24) NOT NULL,
    `provider` VARCHAR(32) NULL,
    `providerTransactionRef` VARCHAR(191) NULL,
    `providerReferenceRecordedAt` DATETIME(3) NULL,
    `fundsReceivedAt` DATETIME(3) NULL,
    `settledAt` DATETIME(3) NULL,
    `reversedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `TransactionSettlement_state_idx`(`state`),
    UNIQUE INDEX `TransactionSettlement_provider_providerTransactionRef_key`(`provider`, `providerTransactionRef`),
    PRIMARY KEY (`snapshotId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `TransactionEconomicSnapshot` ADD CONSTRAINT `TransactionEconomicSnapshot_internalListingId_fkey` FOREIGN KEY (`internalListingId`) REFERENCES `Listing`(`internalListingId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransactionEconomicSnapshot` ADD CONSTRAINT `TransactionEconomicSnapshot_listingSourceRecordId_listingSo_fkey` FOREIGN KEY (`listingSourceRecordId`, `listingSourceRecordVersion`) REFERENCES `ListingSourceRecordVersionRow`(`listingSourceRecordId`, `sourceRecordVersion`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransactionEconomicSnapshot` ADD CONSTRAINT `TransactionEconomicSnapshot_internalOfferId_fkey` FOREIGN KEY (`internalOfferId`) REFERENCES `Offer`(`internalOfferId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransactionEconomicSnapshot` ADD CONSTRAINT `TransactionEconomicSnapshot_offerSourceRecordId_offerSource_fkey` FOREIGN KEY (`offerSourceRecordId`, `offerSourceRecordVersion`) REFERENCES `OfferSourceRecordVersionRow`(`offerSourceRecordId`, `sourceRecordVersion`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransactionEconomicSnapshot` ADD CONSTRAINT `TransactionEconomicSnapshot_policyId_policyVersion_fkey` FOREIGN KEY (`policyId`, `policyVersion`) REFERENCES `CommercialPolicyVersionRow`(`policyId`, `policyVersion`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `TransactionSettlement` ADD CONSTRAINT `TransactionSettlement_snapshotId_fkey` FOREIGN KEY (`snapshotId`) REFERENCES `TransactionEconomicSnapshot`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
