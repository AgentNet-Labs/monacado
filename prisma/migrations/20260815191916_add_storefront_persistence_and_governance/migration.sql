-- CreateTable
CREATE TABLE `Storefront` (
    `internalStorefrontId` VARCHAR(191) NOT NULL,
    `storefrontSourceRecordId` VARCHAR(191) NOT NULL,
    `currentSourceRecordVersion` VARCHAR(64) NOT NULL,
    `ownerParticipantId` VARCHAR(191) NOT NULL,
    `publicHandle` VARCHAR(63) NOT NULL,
    `lifecycle` VARCHAR(16) NOT NULL,
    `visibility` VARCHAR(16) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `Storefront_storefrontSourceRecordId_key`(`storefrontSourceRecordId`),
    UNIQUE INDEX `Storefront_publicHandle_key`(`publicHandle`),
    INDEX `Storefront_ownerParticipantId_idx`(`ownerParticipantId`),
    INDEX `Storefront_lifecycle_visibility_idx`(`lifecycle`, `visibility`),
    PRIMARY KEY (`internalStorefrontId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StorefrontSourceRecordVersionRow` (
    `seq` BIGINT NOT NULL AUTO_INCREMENT,
    `storefrontSourceRecordId` VARCHAR(191) NOT NULL,
    `sourceRecordVersion` VARCHAR(64) NOT NULL,
    `supersedesSourceRecordVersion` VARCHAR(64) NULL,
    `internalStorefrontId` VARCHAR(191) NOT NULL,
    `sourceSystem` VARCHAR(64) NOT NULL,
    `sourceRecordType` VARCHAR(64) NOT NULL,
    `sourceClass` VARCHAR(64) NOT NULL,
    `ownerParticipantId` VARCHAR(191) NOT NULL,
    `lifecycle` VARCHAR(16) NOT NULL,
    `visibility` VARCHAR(16) NOT NULL,
    `publicHandle` VARCHAR(63) NOT NULL,
    `presentationDisplayName` VARCHAR(120) NOT NULL,
    `presentationTagline` VARCHAR(200) NULL,
    `presentationSummary` TEXT NULL,
    `authorizedByParticipantId` VARCHAR(191) NOT NULL,
    `authorizedByActorId` VARCHAR(191) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `rowCreatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `StorefrontSourceRecordVersionRow_internalStorefrontId_seq_idx`(`internalStorefrontId`, `seq`),
    INDEX `StorefrontSourceRecordVersionRow_ownerParticipantId_idx`(`ownerParticipantId`),
    INDEX `StorefrontSourceRecordVersionRow_authorizedByParticipantId_idx`(`authorizedByParticipantId`),
    UNIQUE INDEX `StorefrontSourceRecordVersionRow_storefrontSourceRecordId_so_key`(`storefrontSourceRecordId`, `sourceRecordVersion`),
    PRIMARY KEY (`seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `StorefrontGovernanceAssignment` (
    `id` VARCHAR(191) NOT NULL,
    `internalStorefrontId` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `role` VARCHAR(16) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `assignedAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `activeSuperOwnerForStorefrontId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `StorefrontGovernanceAssignment_activeSuperOwnerForStorefront_key`(`activeSuperOwnerForStorefrontId`),
    INDEX `StorefrontGovernanceAssignment_internalStorefrontId_role_sta_idx`(`internalStorefrontId`, `role`, `status`),
    INDEX `StorefrontGovernanceAssignment_participantId_idx`(`participantId`),
    UNIQUE INDEX `StorefrontGovernanceAssignment_internalStorefrontId_particip_key`(`internalStorefrontId`, `participantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Storefront` ADD CONSTRAINT `Storefront_ownerParticipantId_fkey` FOREIGN KEY (`ownerParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StorefrontSourceRecordVersionRow` ADD CONSTRAINT `StorefrontSourceRecordVersionRow_internalStorefrontId_fkey` FOREIGN KEY (`internalStorefrontId`) REFERENCES `Storefront`(`internalStorefrontId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StorefrontSourceRecordVersionRow` ADD CONSTRAINT `StorefrontSourceRecordVersionRow_ownerParticipantId_fkey` FOREIGN KEY (`ownerParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StorefrontSourceRecordVersionRow` ADD CONSTRAINT `StorefrontSourceRecordVersionRow_authorizedByParticipantId_fkey` FOREIGN KEY (`authorizedByParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StorefrontGovernanceAssignment` ADD CONSTRAINT `StorefrontGovernanceAssignment_internalStorefrontId_fkey` FOREIGN KEY (`internalStorefrontId`) REFERENCES `Storefront`(`internalStorefrontId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `StorefrontGovernanceAssignment` ADD CONSTRAINT `StorefrontGovernanceAssignment_participantId_fkey` FOREIGN KEY (`participantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
