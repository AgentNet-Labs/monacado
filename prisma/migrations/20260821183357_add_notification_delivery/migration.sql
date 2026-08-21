-- CreateTable
CREATE TABLE `NotificationDelivery` (
    `id` VARCHAR(191) NOT NULL,
    `obligationId` VARCHAR(191) NULL,
    `audience` VARCHAR(16) NOT NULL,
    `recipientParticipantId` VARCHAR(191) NULL,
    `category` VARCHAR(48) NOT NULL,
    `subjectKind` VARCHAR(32) NOT NULL,
    `subjectRef` VARCHAR(191) NOT NULL,
    `channel` VARCHAR(16) NOT NULL,
    `destinationDigest` CHAR(64) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `failureCode` VARCHAR(32) NULL,
    `providerMessageRef` VARCHAR(191) NULL,
    `attemptedAt` DATETIME(3) NOT NULL,
    `acceptedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `deliveryKey` VARCHAR(700) NOT NULL,

    UNIQUE INDEX `NotificationDelivery_deliveryKey_key`(`deliveryKey`),
    INDEX `NotificationDelivery_status_attemptedAt_idx`(`status`, `attemptedAt`),
    INDEX `NotificationDelivery_subjectKind_subjectRef_idx`(`subjectKind`, `subjectRef`),
    INDEX `NotificationDelivery_audience_category_idx`(`audience`, `category`),
    INDEX `NotificationDelivery_recipientParticipantId_attemptedAt_idx`(`recipientParticipantId`, `attemptedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `NotificationDelivery` ADD CONSTRAINT `NotificationDelivery_obligationId_fkey` FOREIGN KEY (`obligationId`) REFERENCES `NotificationObligation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `NotificationDelivery` ADD CONSTRAINT `NotificationDelivery_recipientParticipantId_fkey` FOREIGN KEY (`recipientParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
