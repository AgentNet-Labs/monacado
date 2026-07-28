-- AlterTable
ALTER TABLE `ProductPublication` ADD COLUMN `remediationState` VARCHAR(24) NOT NULL DEFAULT 'NOT_REQUIRED';

-- CreateTable
CREATE TABLE `PublicationRemediation` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `remediationId` VARCHAR(191) NOT NULL,
    `publicationId` VARCHAR(191) NOT NULL,
    `outboxId` VARCHAR(191) NULL,
    `remediationAction` VARCHAR(16) NOT NULL,
    `priorRegistrationState` VARCHAR(16) NOT NULL,
    `priorReconciliationState` VARCHAR(16) NOT NULL,
    `priorOutboxStatus` VARCHAR(16) NOT NULL,
    `priorRemediationState` VARCHAR(24) NOT NULL,
    `reasonCode` VARCHAR(64) NOT NULL,
    `reasonSummary` VARCHAR(256) NULL,
    `decidedBy` VARCHAR(191) NOT NULL,
    `decidedAt` DATETIME(3) NOT NULL,
    `retryAvailableAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PublicationRemediation_remediationId_key`(`remediationId`),
    INDEX `PublicationRemediation_publicationId_idx`(`publicationId`),
    INDEX `PublicationRemediation_outboxId_idx`(`outboxId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PublicationRemediation` ADD CONSTRAINT `PublicationRemediation_publicationId_fkey` FOREIGN KEY (`publicationId`) REFERENCES `ProductPublication`(`publicationId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PublicationRemediation` ADD CONSTRAINT `PublicationRemediation_outboxId_fkey` FOREIGN KEY (`outboxId`) REFERENCES `PublicationOutbox`(`outboxId`) ON DELETE RESTRICT ON UPDATE CASCADE;

