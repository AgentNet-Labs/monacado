-- CreateTable
CREATE TABLE `OutboundEmailDelivery` (
    `id` VARCHAR(191) NOT NULL,
    `dedupeKey` VARCHAR(255) NOT NULL,
    `purpose` VARCHAR(48) NOT NULL,
    `obligationId` VARCHAR(191) NULL,
    `audience` VARCHAR(16) NOT NULL,
    `recipientParticipantId` VARCHAR(191) NULL,
    `subjectKind` VARCHAR(32) NOT NULL,
    `subjectRef` VARCHAR(191) NOT NULL,
    `status` VARCHAR(24) NOT NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NULL,
    `lockToken` VARCHAR(64) NULL,
    `lockedAt` DATETIME(3) NULL,
    `leaseExpiresAt` DATETIME(3) NULL,
    `provider` VARCHAR(24) NULL,
    `providerMessageRef` VARCHAR(191) NULL,
    `destinationDigest` CHAR(64) NULL,
    `lastFailureCode` VARCHAR(48) NULL,
    `lastFailureClass` VARCHAR(16) NULL,
    `createdAt` DATETIME(3) NOT NULL,
    `sentAt` DATETIME(3) NULL,
    `finalizedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `OutboundEmailDelivery_dedupeKey_key`(`dedupeKey`),
    INDEX `OutboundEmailDelivery_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    INDEX `OutboundEmailDelivery_status_leaseExpiresAt_idx`(`status`, `leaseExpiresAt`),
    INDEX `OutboundEmailDelivery_subjectKind_subjectRef_idx`(`subjectKind`, `subjectRef`),
    INDEX `OutboundEmailDelivery_obligationId_idx`(`obligationId`),
    INDEX `OutboundEmailDelivery_providerMessageRef_idx`(`providerMessageRef`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmailSuppression` (
    `id` VARCHAR(191) NOT NULL,
    `addressDigest` CHAR(64) NOT NULL,
    `reason` VARCHAR(32) NOT NULL,
    `evidenceEventId` VARCHAR(191) NULL,
    `suppressedAt` DATETIME(3) NOT NULL,
    `liftedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `EmailSuppression_addressDigest_key`(`addressDigest`),
    INDEX `EmailSuppression_reason_suppressedAt_idx`(`reason`, `suppressedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ProviderEmailEvent` (
    `id` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(24) NOT NULL,
    `providerEventId` VARCHAR(191) NOT NULL,
    `eventType` VARCHAR(32) NOT NULL,
    `addressDigest` CHAR(64) NOT NULL,
    `providerMessageRef` VARCHAR(191) NULL,
    `occurredAt` DATETIME(3) NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL,

    INDEX `ProviderEmailEvent_addressDigest_occurredAt_idx`(`addressDigest`, `occurredAt`),
    INDEX `ProviderEmailEvent_providerMessageRef_idx`(`providerMessageRef`),
    UNIQUE INDEX `ProviderEmailEvent_provider_providerEventId_key`(`provider`, `providerEventId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `OutboundEmailDelivery` ADD CONSTRAINT `OutboundEmailDelivery_obligationId_fkey` FOREIGN KEY (`obligationId`) REFERENCES `NotificationObligation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
