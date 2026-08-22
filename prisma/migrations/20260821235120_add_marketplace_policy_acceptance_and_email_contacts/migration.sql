-- AlterTable
ALTER TABLE `Order` ADD COLUMN `marketplacePolicyId` VARCHAR(191) NULL,
    ADD COLUMN `marketplacePolicyVersion` VARCHAR(64) NULL;

-- CreateTable
CREATE TABLE `MarketplacePolicy` (
    `id` VARCHAR(191) NOT NULL,
    `label` VARCHAR(200) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `MarketplacePolicyVersionRow` (
    `seq` BIGINT NOT NULL AUTO_INCREMENT,
    `policyId` VARCHAR(191) NOT NULL,
    `policyVersion` VARCHAR(64) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `title` VARCHAR(200) NOT NULL,
    `contentRef` VARCHAR(191) NOT NULL,
    `contentHash` VARCHAR(80) NOT NULL,
    `requiresReacceptance` BOOLEAN NOT NULL,
    `effectiveFrom` DATETIME(3) NOT NULL,
    `recordedByAccountId` VARCHAR(191) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `activatedAt` DATETIME(3) NULL,
    `retiredAt` DATETIME(3) NULL,
    `activeMarker` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `MarketplacePolicyVersionRow_policyId_status_idx`(`policyId`, `status`),
    INDEX `MarketplacePolicyVersionRow_effectiveFrom_idx`(`effectiveFrom`),
    UNIQUE INDEX `MarketplacePolicyVersionRow_policyId_policyVersion_key`(`policyId`, `policyVersion`),
    UNIQUE INDEX `MarketplacePolicyVersionRow_activeMarker_key`(`activeMarker`),
    PRIMARY KEY (`seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ParticipantPolicyAcceptance` (
    `id` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `policyId` VARCHAR(191) NOT NULL,
    `policyVersion` VARCHAR(64) NOT NULL,
    `audience` VARCHAR(16) NOT NULL,
    `contentHash` VARCHAR(80) NOT NULL,
    `mechanism` VARCHAR(32) NOT NULL,
    `acceptedAt` DATETIME(3) NOT NULL,
    `acceptedByAccountId` VARCHAR(191) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ParticipantPolicyAcceptance_participantId_audience_idx`(`participantId`, `audience`),
    INDEX `ParticipantPolicyAcceptance_policyId_policyVersion_idx`(`policyId`, `policyVersion`),
    UNIQUE INDEX `ParticipantPolicyAcceptance_participantId_policyId_policyVer_key`(`participantId`, `policyId`, `policyVersion`, `audience`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ParticipantEmailContact` (
    `id` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `purpose` VARCHAR(24) NOT NULL,
    `address` VARCHAR(320) NULL,
    `state` VARCHAR(24) NOT NULL,
    `verifiedAt` DATETIME(3) NULL,
    `degradedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ParticipantEmailContact_state_idx`(`state`),
    UNIQUE INDEX `ParticipantEmailContact_participantId_purpose_key`(`participantId`, `purpose`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `EmailVerificationChallenge` (
    `id` VARCHAR(191) NOT NULL,
    `contactId` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `purpose` VARCHAR(24) NOT NULL,
    `addressDigest` CHAR(64) NOT NULL,
    `tokenDigest` CHAR(64) NOT NULL,
    `state` VARCHAR(16) NOT NULL,
    `issuedAt` DATETIME(3) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `consumedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `EmailVerificationChallenge_tokenDigest_key`(`tokenDigest`),
    INDEX `EmailVerificationChallenge_participantId_purpose_state_idx`(`participantId`, `purpose`, `state`),
    INDEX `EmailVerificationChallenge_state_expiresAt_idx`(`state`, `expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_marketplacePolicyId_marketplacePolicyVersion_fkey` FOREIGN KEY (`marketplacePolicyId`, `marketplacePolicyVersion`) REFERENCES `MarketplacePolicyVersionRow`(`policyId`, `policyVersion`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `MarketplacePolicyVersionRow` ADD CONSTRAINT `MarketplacePolicyVersionRow_policyId_fkey` FOREIGN KEY (`policyId`) REFERENCES `MarketplacePolicy`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantPolicyAcceptance` ADD CONSTRAINT `ParticipantPolicyAcceptance_participantId_fkey` FOREIGN KEY (`participantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantPolicyAcceptance` ADD CONSTRAINT `ParticipantPolicyAcceptance_policyId_fkey` FOREIGN KEY (`policyId`) REFERENCES `MarketplacePolicy`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantPolicyAcceptance` ADD CONSTRAINT `ParticipantPolicyAcceptance_policyId_policyVersion_fkey` FOREIGN KEY (`policyId`, `policyVersion`) REFERENCES `MarketplacePolicyVersionRow`(`policyId`, `policyVersion`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantEmailContact` ADD CONSTRAINT `ParticipantEmailContact_participantId_fkey` FOREIGN KEY (`participantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `EmailVerificationChallenge` ADD CONSTRAINT `EmailVerificationChallenge_contactId_fkey` FOREIGN KEY (`contactId`) REFERENCES `ParticipantEmailContact`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
