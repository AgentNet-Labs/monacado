-- AlterTable
ALTER TABLE `PublicationOutbox` ADD COLUMN `completedAt` DATETIME(3) NULL,
    ADD COLUMN `lastErrorCode` VARCHAR(64) NULL,
    ADD COLUMN `lastErrorSummary` VARCHAR(256) NULL,
    ADD COLUMN `lockToken` VARCHAR(191) NULL,
    ADD COLUMN `lockedAt` DATETIME(3) NULL;

-- CreateIndex
CREATE UNIQUE INDEX `PublicationOutbox_lockToken_key` ON `PublicationOutbox`(`lockToken`);

