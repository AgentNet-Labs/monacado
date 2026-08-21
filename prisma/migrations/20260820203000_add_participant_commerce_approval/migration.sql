-- CreateTable
CREATE TABLE `ParticipantCommerceApproval` (
    `id` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `decision` VARCHAR(16) NOT NULL,
    `reasonCode` VARCHAR(48) NOT NULL,
    `decidedAt` DATETIME(3) NOT NULL,
    `decidedByAccountId` VARCHAR(191) NOT NULL,
    `supersededAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `currentForParticipantId` VARCHAR(191) NULL,

    UNIQUE INDEX `ParticipantCommerceApproval_currentForParticipantId_key`(`currentForParticipantId`),
    INDEX `ParticipantCommerceApproval_participantId_decidedAt_idx`(`participantId`, `decidedAt`),
    INDEX `ParticipantCommerceApproval_decision_decidedAt_idx`(`decision`, `decidedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ParticipantCommerceApproval` ADD CONSTRAINT `ParticipantCommerceApproval_participantId_fkey` FOREIGN KEY (`participantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

