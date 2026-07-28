-- AlterTable
ALTER TABLE `ProductPublication` ADD COLUMN `reconciliationState` VARCHAR(16) NOT NULL DEFAULT 'NOT_REQUIRED',
    ADD COLUMN `registrationState` VARCHAR(16) NOT NULL DEFAULT 'NOT_SUBMITTED';

-- AlterTable
ALTER TABLE `PublicationOutbox` MODIFY `payload` JSON NULL;

-- CreateTable
CREATE TABLE `RegistrarReceipt` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `receiptId` VARCHAR(191) NOT NULL,
    `publicationId` VARCHAR(191) NOT NULL,
    `outboxId` VARCHAR(191) NULL,
    `registrarRegistrationId` VARCHAR(191) NULL,
    `registrarId` VARCHAR(191) NOT NULL,
    `nodeId` VARCHAR(191) NOT NULL,
    `capsuleId` VARCHAR(191) NOT NULL,
    `registeredContentHash` VARCHAR(80) NOT NULL,
    `receiptStatus` VARCHAR(16) NOT NULL,
    `registeredAt` DATETIME(3) NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL,
    `receiptDetails` JSON NOT NULL,
    `acceptedForPublicationId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `RegistrarReceipt_receiptId_key`(`receiptId`),
    UNIQUE INDEX `RegistrarReceipt_registrarRegistrationId_key`(`registrarRegistrationId`),
    UNIQUE INDEX `RegistrarReceipt_acceptedForPublicationId_key`(`acceptedForPublicationId`),
    INDEX `RegistrarReceipt_publicationId_idx`(`publicationId`),
    INDEX `RegistrarReceipt_outboxId_idx`(`outboxId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `RegistrarReceipt` ADD CONSTRAINT `RegistrarReceipt_publicationId_fkey` FOREIGN KEY (`publicationId`) REFERENCES `ProductPublication`(`publicationId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `RegistrarReceipt` ADD CONSTRAINT `RegistrarReceipt_outboxId_fkey` FOREIGN KEY (`outboxId`) REFERENCES `PublicationOutbox`(`outboxId`) ON DELETE RESTRICT ON UPDATE CASCADE;

