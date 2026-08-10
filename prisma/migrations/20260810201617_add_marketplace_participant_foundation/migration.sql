-- AlterTable
ALTER TABLE `ProductSourceRecordVersionRow` ADD COLUMN `authorityCreatorParticipantId` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `MarketplaceParticipant` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `status` VARCHAR(24) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `MarketplaceParticipant_accountId_key`(`accountId`),
    INDEX `MarketplaceParticipant_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MarketplaceRoleAssignment` (
    `id` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `role` VARCHAR(16) NOT NULL,
    `status` VARCHAR(24) NOT NULL,
    `grantedAt` DATETIME(3) NOT NULL,
    `activatedAt` DATETIME(3) NULL,
    `revokedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MarketplaceRoleAssignment_participantId_status_idx`(`participantId`, `status`),
    UNIQUE INDEX `MarketplaceRoleAssignment_participantId_role_key`(`participantId`, `role`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ParticipantProfile` (
    `id` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `identityComplete` BOOLEAN NOT NULL DEFAULT false,
    `businessStructureComplete` BOOLEAN NOT NULL DEFAULT false,
    `representativesComplete` BOOLEAN NOT NULL DEFAULT false,
    `commercialProfileComplete` BOOLEAN NOT NULL DEFAULT false,
    `riskComplete` BOOLEAN NOT NULL DEFAULT false,
    `payoutConfigurationComplete` BOOLEAN NOT NULL DEFAULT false,
    `documentsComplete` BOOLEAN NOT NULL DEFAULT false,
    `emailVerifiedAt` DATETIME(3) NULL,
    `termsAcceptedAt` DATETIME(3) NULL,
    `termsVersion` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ParticipantProfile_participantId_key`(`participantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ParticipantActivation` (
    `id` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `submittedAt` DATETIME(3) NOT NULL,
    `decision` VARCHAR(32) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decidedByActorId` VARCHAR(191) NULL,
    `decisionReasonCode` VARCHAR(64) NULL,
    `undecidedForParticipantId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ParticipantActivation_undecidedForParticipantId_key`(`undecidedForParticipantId`),
    INDEX `ParticipantActivation_participantId_submittedAt_idx`(`participantId`, `submittedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ProductSourceRecordVersionRow_authorityCreatorParticipantId_idx` ON `ProductSourceRecordVersionRow`(`authorityCreatorParticipantId`);

-- AddForeignKey
ALTER TABLE `ProductSourceRecordVersionRow` ADD CONSTRAINT `ProductSourceRecordVersionRow_authorityCreatorParticipantId_fkey` FOREIGN KEY (`authorityCreatorParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MarketplaceParticipant` ADD CONSTRAINT `MarketplaceParticipant_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MarketplaceRoleAssignment` ADD CONSTRAINT `MarketplaceRoleAssignment_participantId_fkey` FOREIGN KEY (`participantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantProfile` ADD CONSTRAINT `ParticipantProfile_participantId_fkey` FOREIGN KEY (`participantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantActivation` ADD CONSTRAINT `ParticipantActivation_participantId_fkey` FOREIGN KEY (`participantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
