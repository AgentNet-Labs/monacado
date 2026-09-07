-- AlterTable
ALTER TABLE `CommercialPolicyVersionRow` ADD COLUMN `activatedAt` DATETIME(3) NULL,
    ADD COLUMN `activatedByAccountId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `MarketplacePolicyVersionRow` ADD COLUMN `activatedByAccountId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `RiskPolicyVersionRow` ADD COLUMN `activatedAt` DATETIME(3) NULL,
    ADD COLUMN `activatedByAccountId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `SellerChargebackFeePolicyVersionRow` ADD COLUMN `activatedAt` DATETIME(3) NULL,
    ADD COLUMN `activatedByAccountId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `SellerRefundPolicyVersionRow` ADD COLUMN `activatedByAccountId` VARCHAR(191) NULL;
