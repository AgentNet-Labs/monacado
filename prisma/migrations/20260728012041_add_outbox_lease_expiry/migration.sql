-- AlterTable
ALTER TABLE `PublicationOutbox` ADD COLUMN `leaseExpiresAt` DATETIME(3) NULL;

-- CreateIndex
CREATE INDEX `PublicationOutbox_outboxStatus_leaseExpiresAt_idx` ON `PublicationOutbox`(`outboxStatus`, `leaseExpiresAt`);

