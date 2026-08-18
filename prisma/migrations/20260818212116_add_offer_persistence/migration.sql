-- CreateTable
CREATE TABLE `Offer` (
    `internalOfferId` VARCHAR(191) NOT NULL,
    `offerSourceRecordId` VARCHAR(191) NOT NULL,
    `currentSourceRecordVersion` VARCHAR(64) NOT NULL,
    `internalProductId` VARCHAR(191) NOT NULL,
    `sellerParticipantId` VARCHAR(191) NOT NULL,
    `lifecycle` VARCHAR(16) NOT NULL,
    `availability` VARCHAR(32) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Offer_offerSourceRecordId_key`(`offerSourceRecordId`),
    INDEX `Offer_internalProductId_idx`(`internalProductId`),
    INDEX `Offer_sellerParticipantId_idx`(`sellerParticipantId`),
    INDEX `Offer_lifecycle_availability_idx`(`lifecycle`, `availability`),
    PRIMARY KEY (`internalOfferId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `OfferSourceRecordVersionRow` (
    `seq` BIGINT NOT NULL AUTO_INCREMENT,
    `offerSourceRecordId` VARCHAR(191) NOT NULL,
    `sourceRecordVersion` VARCHAR(64) NOT NULL,
    `supersedesSourceRecordVersion` VARCHAR(64) NULL,
    `internalOfferId` VARCHAR(191) NOT NULL,
    `sourceSystem` VARCHAR(64) NOT NULL,
    `sourceRecordType` VARCHAR(64) NOT NULL,
    `sourceClass` VARCHAR(64) NOT NULL,
    `internalProductId` VARCHAR(191) NOT NULL,
    `sellerParticipantId` VARCHAR(191) NOT NULL,
    `lifecycle` VARCHAR(16) NOT NULL,
    `availability` VARCHAR(32) NOT NULL,
    `priceType` VARCHAR(8) NOT NULL,
    `wholesalePriceMinorUnits` BIGINT NULL,
    `wholesalePriceCurrency` VARCHAR(3) NULL,
    `promotionType` VARCHAR(16) NOT NULL,
    `commissionMethod` VARCHAR(24) NULL,
    `commissionBasisPoints` INTEGER NULL,
    `fixedCommissionMinorUnits` BIGINT NULL,
    `fixedCommissionCurrency` VARCHAR(3) NULL,
    `effectiveStartsAt` DATETIME(3) NULL,
    `effectiveEndsAt` DATETIME(3) NULL,
    `calculatedCommissionMinorUnits` BIGINT NOT NULL,
    `calculatedCreatorGrossProceedsMinorUnits` BIGINT NOT NULL,
    `commissionCalculationPolicyVersion` VARCHAR(48) NOT NULL,
    `authorizedBySellerParticipantId` VARCHAR(191) NOT NULL,
    `authorizedByActorId` VARCHAR(191) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `rowCreatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `OfferSourceRecordVersionRow_internalOfferId_seq_idx`(`internalOfferId`, `seq`),
    INDEX `OfferSourceRecordVersionRow_internalProductId_idx`(`internalProductId`),
    INDEX `OfferSourceRecordVersionRow_sellerParticipantId_idx`(`sellerParticipantId`),
    INDEX `OfferSourceRecordVersionRow_authorizedBySellerParticipantId_idx`(`authorizedBySellerParticipantId`),
    UNIQUE INDEX `OfferSourceRecordVersionRow_offerSourceRecordId_sourceRecord_key`(`offerSourceRecordId`, `sourceRecordVersion`),
    PRIMARY KEY (`seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Offer` ADD CONSTRAINT `Offer_internalProductId_fkey` FOREIGN KEY (`internalProductId`) REFERENCES `Product`(`internalProductId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Offer` ADD CONSTRAINT `Offer_sellerParticipantId_fkey` FOREIGN KEY (`sellerParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OfferSourceRecordVersionRow` ADD CONSTRAINT `OfferSourceRecordVersionRow_internalOfferId_fkey` FOREIGN KEY (`internalOfferId`) REFERENCES `Offer`(`internalOfferId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OfferSourceRecordVersionRow` ADD CONSTRAINT `OfferSourceRecordVersionRow_internalProductId_fkey` FOREIGN KEY (`internalProductId`) REFERENCES `Product`(`internalProductId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OfferSourceRecordVersionRow` ADD CONSTRAINT `OfferSourceRecordVersionRow_sellerParticipantId_fkey` FOREIGN KEY (`sellerParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `OfferSourceRecordVersionRow` ADD CONSTRAINT `OfferSourceRecordVersionRow_authorizedBySellerParticipantId_fkey` FOREIGN KEY (`authorizedBySellerParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
