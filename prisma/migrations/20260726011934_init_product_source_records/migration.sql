-- CreateTable
CREATE TABLE `Product` (
    `internalProductId` VARCHAR(191) NOT NULL,
    `sourceRecordId` VARCHAR(191) NOT NULL,
    `currentSourceRecordVersion` VARCHAR(64) NOT NULL,
    `recordStatus` VARCHAR(32) NOT NULL,
    `productRowCreatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `Product_sourceRecordId_key`(`sourceRecordId`),
    INDEX `Product_sourceRecordId_idx`(`sourceRecordId`),
    PRIMARY KEY (`internalProductId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProductSourceRecordVersionRow` (
    `seq` BIGINT NOT NULL AUTO_INCREMENT,
    `internalProductId` VARCHAR(191) NOT NULL,
    `sourceRecordId` VARCHAR(191) NOT NULL,
    `sourceRecordVersion` VARCHAR(64) NOT NULL,
    `sourceSystem` VARCHAR(64) NOT NULL,
    `sourceRecordType` VARCHAR(64) NOT NULL,
    `sourceClass` VARCHAR(64) NOT NULL,
    `authorityCreatorId` VARCHAR(191) NOT NULL,
    `authorityScope` VARCHAR(64) NOT NULL,
    `authorityAuthorizationState` VARCHAR(32) NOT NULL,
    `authorityAuthorizationRef` VARCHAR(191) NULL,
    `factName` VARCHAR(512) NOT NULL,
    `factDescription` TEXT NULL,
    `factImage` VARCHAR(1024) NULL,
    `factProductVersion` INTEGER NOT NULL,
    `factPromotable` BOOLEAN NOT NULL,
    `factGeneralAvailabilityState` VARCHAR(32) NOT NULL,
    `factSpecifications` JSON NULL,
    `factCapabilities` JSON NULL,
    `factCreatorRef` VARCHAR(191) NOT NULL,
    `factOfferRef` VARCHAR(191) NULL,
    `capsuleSemver` VARCHAR(64) NOT NULL,
    `mappingVersion` VARCHAR(64) NOT NULL,
    `capsuleGeneratedAt` DATETIME(3) NOT NULL,
    `acquiredAt` DATETIME(3) NOT NULL,
    `sourceCreatedAt` DATETIME(3) NOT NULL,
    `sourceUpdatedAt` DATETIME(3) NOT NULL,
    `recordStatus` VARCHAR(32) NOT NULL,
    `rowCreatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ProductSourceRecordVersionRow_internalProductId_seq_idx`(`internalProductId`, `seq`),
    UNIQUE INDEX `ProductSourceRecordVersionRow_sourceRecordId_sourceRecordVer_key`(`sourceRecordId`, `sourceRecordVersion`),
    PRIMARY KEY (`seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ProductSourceRecordVersionRow` ADD CONSTRAINT `ProductSourceRecordVersionRow_internalProductId_fkey` FOREIGN KEY (`internalProductId`) REFERENCES `Product`(`internalProductId`) ON DELETE RESTRICT ON UPDATE CASCADE;
