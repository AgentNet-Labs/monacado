-- CreateTable
CREATE TABLE `CommercialPolicy` (
    `id` VARCHAR(191) NOT NULL,
    `label` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `CommercialPolicyVersionRow` (
    `seq` BIGINT NOT NULL AUTO_INCREMENT,
    `policyId` VARCHAR(191) NOT NULL,
    `policyVersion` VARCHAR(64) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `retainedPercentageBasisPoints` INTEGER NOT NULL,
    `retainedFixedAmountMinorUnits` BIGINT NOT NULL,
    `roundingPolicy` VARCHAR(32) NOT NULL,
    `effectiveFrom` DATETIME(3) NOT NULL,
    `recordedByAccountId` VARCHAR(191) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `retiredAt` DATETIME(3) NULL,
    `retiredByAccountId` VARCHAR(191) NULL,
    `activeForPolicyId` VARCHAR(191) NULL,
    `rowCreatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `CommercialPolicyVersionRow_activeForPolicyId_key`(`activeForPolicyId`),
    INDEX `CommercialPolicyVersionRow_policyId_status_idx`(`policyId`, `status`),
    INDEX `CommercialPolicyVersionRow_policyId_effectiveFrom_idx`(`policyId`, `effectiveFrom`),
    UNIQUE INDEX `CommercialPolicyVersionRow_policyId_policyVersion_key`(`policyId`, `policyVersion`),
    PRIMARY KEY (`seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ParticipantRestriction` (
    `id` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `scope` VARCHAR(48) NOT NULL,
    `reasonCode` VARCHAR(48) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `imposedAt` DATETIME(3) NOT NULL,
    `imposedByAccountId` VARCHAR(191) NOT NULL,
    `liftedAt` DATETIME(3) NULL,
    `liftedByAccountId` VARCHAR(191) NULL,
    `liftedReasonCode` VARCHAR(48) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `activeForScope` VARCHAR(48) NULL,

    INDEX `ParticipantRestriction_participantId_status_idx`(`participantId`, `status`),
    INDEX `ParticipantRestriction_status_scope_idx`(`status`, `scope`),
    UNIQUE INDEX `ParticipantRestriction_participantId_activeForScope_key`(`participantId`, `activeForScope`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `CommercialPolicyVersionRow` ADD CONSTRAINT `CommercialPolicyVersionRow_policyId_fkey` FOREIGN KEY (`policyId`) REFERENCES `CommercialPolicy`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantRestriction` ADD CONSTRAINT `ParticipantRestriction_participantId_fkey` FOREIGN KEY (`participantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
