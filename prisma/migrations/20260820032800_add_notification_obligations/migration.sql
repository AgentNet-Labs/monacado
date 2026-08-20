-- CreateTable
CREATE TABLE `NotificationObligation` (
    `id` VARCHAR(191) NOT NULL,
    `recipientParticipantId` VARCHAR(191) NOT NULL,
    `category` VARCHAR(48) NOT NULL,
    `subjectKind` VARCHAR(32) NOT NULL,
    `subjectRef` VARCHAR(191) NOT NULL,
    `subjectVersionRef` VARCHAR(64) NULL,
    `contextCode` VARCHAR(48) NULL,
    `status` VARCHAR(16) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL,
    `acknowledgedAt` DATETIME(3) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `archivedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `obligationKey` VARCHAR(700) NOT NULL,

    UNIQUE INDEX `NotificationObligation_obligationKey_key`(`obligationKey`),
    INDEX `NotificationObligation_recipientParticipantId_status_created_idx`(`recipientParticipantId`, `status`, `createdAt`),
    INDEX `NotificationObligation_category_status_idx`(`category`, `status`),
    INDEX `NotificationObligation_subjectKind_subjectRef_idx`(`subjectKind`, `subjectRef`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `NotificationObligation` ADD CONSTRAINT `NotificationObligation_recipientParticipantId_fkey` FOREIGN KEY (`recipientParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
