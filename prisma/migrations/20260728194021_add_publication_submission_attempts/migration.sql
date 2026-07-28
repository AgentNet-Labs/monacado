-- AlterTable
ALTER TABLE `RegistrarReceipt` ADD COLUMN `submissionAttemptId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `PublicationSubmissionAttempt` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `submissionAttemptId` VARCHAR(191) NOT NULL,
    `publicationId` VARCHAR(191) NOT NULL,
    `outboxId` VARCHAR(191) NOT NULL,
    `attemptNumber` INTEGER NOT NULL,
    `operation` VARCHAR(32) NOT NULL,
    `nodeId` VARCHAR(191) NOT NULL,
    `capsuleId` VARCHAR(191) NOT NULL,
    `registrarId` VARCHAR(191) NOT NULL,
    `expectedContentHash` VARCHAR(80) NOT NULL,
    `payloadHash` VARCHAR(80) NOT NULL,
    `claimTokenHash` VARCHAR(80) NOT NULL,
    `attemptStatus` VARCHAR(24) NOT NULL,
    `preparedAt` DATETIME(3) NOT NULL,
    `dispatchedAt` DATETIME(3) NULL,
    `abandonedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PublicationSubmissionAttempt_submissionAttemptId_key`(`submissionAttemptId`),
    INDEX `PublicationSubmissionAttempt_publicationId_idx`(`publicationId`),
    INDEX `PublicationSubmissionAttempt_attemptStatus_idx`(`attemptStatus`),
    UNIQUE INDEX `PublicationSubmissionAttempt_outboxId_attemptNumber_key`(`outboxId`, `attemptNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `RegistrarReceipt_submissionAttemptId_key` ON `RegistrarReceipt`(`submissionAttemptId`);

-- AddForeignKey
ALTER TABLE `RegistrarReceipt` ADD CONSTRAINT `RegistrarReceipt_submissionAttemptId_fkey` FOREIGN KEY (`submissionAttemptId`) REFERENCES `PublicationSubmissionAttempt`(`submissionAttemptId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PublicationSubmissionAttempt` ADD CONSTRAINT `PublicationSubmissionAttempt_publicationId_fkey` FOREIGN KEY (`publicationId`) REFERENCES `ProductPublication`(`publicationId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PublicationSubmissionAttempt` ADD CONSTRAINT `PublicationSubmissionAttempt_outboxId_fkey` FOREIGN KEY (`outboxId`) REFERENCES `PublicationOutbox`(`outboxId`) ON DELETE RESTRICT ON UPDATE CASCADE;

