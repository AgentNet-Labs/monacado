-- CreateTable
CREATE TABLE `ParticipantPaymentAccount` (
    `id` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `provider` VARCHAR(32) NOT NULL,
    `providerAccountRef` VARCHAR(191) NOT NULL,
    `readiness` VARCHAR(24) NOT NULL,
    `readinessObservedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ParticipantPaymentAccount_readiness_idx`(`readiness`),
    UNIQUE INDEX `ParticipantPaymentAccount_participantId_provider_key`(`participantId`, `provider`),
    UNIQUE INDEX `ParticipantPaymentAccount_provider_providerAccountRef_key`(`provider`, `providerAccountRef`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ParticipantPaymentRequirementRow` (
    `seq` BIGINT NOT NULL AUTO_INCREMENT,
    `paymentAccountId` VARCHAR(191) NOT NULL,
    `requirementCode` VARCHAR(48) NOT NULL,
    `observedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ParticipantPaymentRequirementRow_paymentAccountId_requiremen_key`(`paymentAccountId`, `requirementCode`),
    PRIMARY KEY (`seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ParticipantPaymentAccount` ADD CONSTRAINT `ParticipantPaymentAccount_participantId_fkey` FOREIGN KEY (`participantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantPaymentRequirementRow` ADD CONSTRAINT `ParticipantPaymentRequirementRow_paymentAccountId_fkey` FOREIGN KEY (`paymentAccountId`) REFERENCES `ParticipantPaymentAccount`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
