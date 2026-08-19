-- CreateTable
CREATE TABLE `Listing` (
    `internalListingId` VARCHAR(191) NOT NULL,
    `listingSourceRecordId` VARCHAR(191) NOT NULL,
    `currentSourceRecordVersion` VARCHAR(64) NOT NULL,
    `listingType` VARCHAR(16) NOT NULL,
    `internalProductId` VARCHAR(191) NOT NULL,
    `storefrontId` VARCHAR(191) NOT NULL,
    `controllingParticipantId` VARCHAR(191) NOT NULL,
    `lifecycle` VARCHAR(16) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Listing_listingSourceRecordId_key`(`listingSourceRecordId`),
    INDEX `Listing_internalProductId_idx`(`internalProductId`),
    INDEX `Listing_storefrontId_idx`(`storefrontId`),
    INDEX `Listing_controllingParticipantId_idx`(`controllingParticipantId`),
    INDEX `Listing_listingType_lifecycle_idx`(`listingType`, `lifecycle`),
    PRIMARY KEY (`internalListingId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ListingSourceRecordVersionRow` (
    `seq` BIGINT NOT NULL AUTO_INCREMENT,
    `listingSourceRecordId` VARCHAR(191) NOT NULL,
    `sourceRecordVersion` VARCHAR(64) NOT NULL,
    `supersedesSourceRecordVersion` VARCHAR(64) NULL,
    `internalListingId` VARCHAR(191) NOT NULL,
    `sourceSystem` VARCHAR(64) NOT NULL,
    `sourceRecordType` VARCHAR(64) NOT NULL,
    `sourceClass` VARCHAR(64) NOT NULL,
    `storefrontId` VARCHAR(191) NOT NULL,
    `internalProductId` VARCHAR(191) NOT NULL,
    `controllingParticipantId` VARCHAR(191) NOT NULL,
    `lifecycle` VARCHAR(16) NOT NULL,
    `listingType` VARCHAR(16) NOT NULL,
    `retailPriceMinorUnits` BIGINT NOT NULL,
    `retailPriceCurrency` VARCHAR(3) NOT NULL,
    `salePriceMinorUnits` BIGINT NULL,
    `salePriceCurrency` VARCHAR(3) NULL,
    `saleStartsAt` DATETIME(3) NULL,
    `saleEndsAt` DATETIME(3) NULL,
    `acceptedInternalOfferId` VARCHAR(191) NULL,
    `acceptedOfferSourceRecordId` VARCHAR(191) NULL,
    `acceptedOfferSourceRecordVersion` VARCHAR(64) NULL,
    `acceptedWholesalePriceMinorUnits` BIGINT NULL,
    `acceptedWholesalePriceCurrency` VARCHAR(3) NULL,
    `acceptedCommissionCalculationPolicyVersion` VARCHAR(64) NULL,
    `acceptedAt` DATETIME(3) NULL,
    `upstreamReviewState` VARCHAR(32) NULL,
    `authorizedByParticipantId` VARCHAR(191) NOT NULL,
    `authorizedByActorId` VARCHAR(191) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `rowCreatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ListingSourceRecordVersionRow_internalListingId_seq_idx`(`internalListingId`, `seq`),
    INDEX `ListingSourceRecordVersionRow_internalProductId_idx`(`internalProductId`),
    INDEX `ListingSourceRecordVersionRow_storefrontId_idx`(`storefrontId`),
    INDEX `ListingSourceRecordVersionRow_controllingParticipantId_idx`(`controllingParticipantId`),
    INDEX `ListingSourceRecordVersionRow_authorizedByParticipantId_idx`(`authorizedByParticipantId`),
    INDEX `ListingSourceRecordVersionRow_acceptedInternalOfferId_idx`(`acceptedInternalOfferId`),
    INDEX `ListingSourceRecordVersionRow_acceptedOfferSourceRecordId_ac_idx`(`acceptedOfferSourceRecordId`, `acceptedOfferSourceRecordVersion`),
    UNIQUE INDEX `ListingSourceRecordVersionRow_listingSourceRecordId_sourceRe_key`(`listingSourceRecordId`, `sourceRecordVersion`),
    PRIMARY KEY (`seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Listing` ADD CONSTRAINT `Listing_internalProductId_fkey` FOREIGN KEY (`internalProductId`) REFERENCES `Product`(`internalProductId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Listing` ADD CONSTRAINT `Listing_storefrontId_fkey` FOREIGN KEY (`storefrontId`) REFERENCES `Storefront`(`internalStorefrontId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Listing` ADD CONSTRAINT `Listing_controllingParticipantId_fkey` FOREIGN KEY (`controllingParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ListingSourceRecordVersionRow` ADD CONSTRAINT `ListingSourceRecordVersionRow_internalListingId_fkey` FOREIGN KEY (`internalListingId`) REFERENCES `Listing`(`internalListingId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ListingSourceRecordVersionRow` ADD CONSTRAINT `ListingSourceRecordVersionRow_internalProductId_fkey` FOREIGN KEY (`internalProductId`) REFERENCES `Product`(`internalProductId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ListingSourceRecordVersionRow` ADD CONSTRAINT `ListingSourceRecordVersionRow_storefrontId_fkey` FOREIGN KEY (`storefrontId`) REFERENCES `Storefront`(`internalStorefrontId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ListingSourceRecordVersionRow` ADD CONSTRAINT `ListingSourceRecordVersionRow_controllingParticipantId_fkey` FOREIGN KEY (`controllingParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ListingSourceRecordVersionRow` ADD CONSTRAINT `ListingSourceRecordVersionRow_authorizedByParticipantId_fkey` FOREIGN KEY (`authorizedByParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ListingSourceRecordVersionRow` ADD CONSTRAINT `ListingSourceRecordVersionRow_acceptedInternalOfferId_fkey` FOREIGN KEY (`acceptedInternalOfferId`) REFERENCES `Offer`(`internalOfferId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ListingSourceRecordVersionRow` ADD CONSTRAINT `ListingSourceRecordVersionRow_acceptedOfferSourceRecordId_a_fkey` FOREIGN KEY (`acceptedOfferSourceRecordId`, `acceptedOfferSourceRecordVersion`) REFERENCES `OfferSourceRecordVersionRow`(`offerSourceRecordId`, `sourceRecordVersion`) ON DELETE RESTRICT ON UPDATE CASCADE;
