-- CreateTable
CREATE TABLE `ProductPublication` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `publicationId` VARCHAR(191) NOT NULL,
    `internalProductId` VARCHAR(191) NOT NULL,
    `sourceRecordId` VARCHAR(191) NOT NULL,
    `sourceRecordVersion` VARCHAR(64) NOT NULL,
    `nodeId` VARCHAR(191) NOT NULL,
    `capsuleId` VARCHAR(191) NOT NULL,
    `capsuleSemver` VARCHAR(64) NOT NULL,
    `publishedBy` VARCHAR(191) NOT NULL,
    `publishedAt` DATETIME(3) NOT NULL,
    `nodePolicyRef` VARCHAR(191) NOT NULL,
    `nodePolicyVersion` VARCHAR(64) NOT NULL,
    `capsulePolicyRef` VARCHAR(191) NOT NULL,
    `capsulePolicyVersion` VARCHAR(64) NOT NULL,
    `candidateHash` VARCHAR(80) NOT NULL,
    `publishedContentHash` VARCHAR(80) NOT NULL,
    `mappingVersion` VARCHAR(64) NOT NULL,
    `capsuleGeneratedAt` DATETIME(3) NOT NULL,
    `supersedesCapsuleId` VARCHAR(191) NULL,
    `revokesCapsuleId` VARCHAR(191) NULL,
    `publicationStatus` VARCHAR(16) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ProductPublication_publicationId_key`(`publicationId`),
    UNIQUE INDEX `ProductPublication_capsuleId_key`(`capsuleId`),
    INDEX `ProductPublication_internalProductId_idx`(`internalProductId`),
    INDEX `ProductPublication_sourceRecordId_sourceRecordVersion_idx`(`sourceRecordId`, `sourceRecordVersion`),
    UNIQUE INDEX `ProductPublication_nodeId_sourceRecordId_sourceRecordVersion_key`(`nodeId`, `sourceRecordId`, `sourceRecordVersion`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PublicationOutbox` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `outboxId` VARCHAR(191) NOT NULL,
    `publicationId` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `operationType` VARCHAR(32) NOT NULL,
    `payload` JSON NOT NULL,
    `payloadHash` VARCHAR(80) NOT NULL,
    `outboxStatus` VARCHAR(16) NOT NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `availableAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PublicationOutbox_outboxId_key`(`outboxId`),
    UNIQUE INDEX `PublicationOutbox_publicationId_key`(`publicationId`),
    UNIQUE INDEX `PublicationOutbox_idempotencyKey_key`(`idempotencyKey`),
    INDEX `PublicationOutbox_outboxStatus_availableAt_idx`(`outboxStatus`, `availableAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ProductPublication` ADD CONSTRAINT `ProductPublication_internalProductId_fkey` FOREIGN KEY (`internalProductId`) REFERENCES `Product`(`internalProductId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductPublication` ADD CONSTRAINT `ProductPublication_nodeId_fkey` FOREIGN KEY (`nodeId`) REFERENCES `ProductNode`(`nodeId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ProductPublication` ADD CONSTRAINT `ProductPublication_sourceRecordId_sourceRecordVersion_fkey` FOREIGN KEY (`sourceRecordId`, `sourceRecordVersion`) REFERENCES `ProductSourceRecordVersionRow`(`sourceRecordId`, `sourceRecordVersion`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PublicationOutbox` ADD CONSTRAINT `PublicationOutbox_publicationId_fkey` FOREIGN KEY (`publicationId`) REFERENCES `ProductPublication`(`publicationId`) ON DELETE RESTRICT ON UPDATE CASCADE;
