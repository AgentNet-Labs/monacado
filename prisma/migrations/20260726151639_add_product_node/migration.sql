-- CreateTable
CREATE TABLE `ProductNode` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `nodeId` VARCHAR(191) NOT NULL,
    `internalProductId` VARCHAR(191) NOT NULL,
    `nodeKind` VARCHAR(64) NOT NULL,
    `lifecycleState` VARCHAR(16) NOT NULL,
    `lifecycleChangedAt` DATETIME(3) NOT NULL,
    `lifecycleReasonCode` VARCHAR(64) NULL,
    `nodePolicyRef` VARCHAR(191) NOT NULL,
    `nodePolicyVersion` VARCHAR(64) NOT NULL,
    `registrarId` VARCHAR(191) NOT NULL,
    `registrarAccreditationRef` VARCHAR(191) NULL,
    `issuedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ProductNode_nodeId_key`(`nodeId`),
    UNIQUE INDEX `ProductNode_internalProductId_key`(`internalProductId`),
    INDEX `ProductNode_internalProductId_idx`(`internalProductId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ProductNode` ADD CONSTRAINT `ProductNode_internalProductId_fkey` FOREIGN KEY (`internalProductId`) REFERENCES `Product`(`internalProductId`) ON DELETE RESTRICT ON UPDATE CASCADE;
