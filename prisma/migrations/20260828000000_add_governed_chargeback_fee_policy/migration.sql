-- Phase 1.12 (follow-up) -- the seller chargeback fee becomes a governed,
-- versioned commercial value.
--
-- A SEPARATE MIGRATION, not an amendment. The Phase 1.12 migration is already on
-- origin/main, so rewriting it would rewrite published history and desynchronise
-- every clone that has already applied it. Additive follow-up is the only correct
-- shape here, and the project's own rule says so.
--
-- WHAT WAS WRONG. The first cut compiled $30 into the assessment path. That made
-- the fee correct and unchangeable in one stroke: Monacado could not raise or
-- lower it without a deployment, and a fee assessed last month carried no record
-- of what the governing value was at the time. A commercial term that can only
-- change by shipping code is not a governed term.
--
-- THE SHAPE IS BORROWED, NOT INVENTED. SellerChargebackFeePolicy and its version
-- row mirror CommercialPolicyVersionRow and SellerRefundPolicyVersionRow exactly:
-- stable identity, immutable versions, DRAFT -> ACTIVE -> RETIRED, a recorded
-- operator behind each change, and `activeMarker` under a UNIQUE index so AT MOST
-- ONE version is ACTIVE at a time -- enforced by MySQL rather than by a service
-- remembering to retire the incumbent.
--
-- WHY ITS OWN POLICY RATHER THAN A COLUMN ON THE COMMERCIAL POLICY.
-- CommercialPolicyVersionRow is bound to an Order AT SALE TIME. A chargeback fee
-- is decided when the chargeback FINALIZES, possibly months later and under a
-- different value. Putting it on the sale-time policy would have made "which
-- version applies" genuinely ambiguous; a separate policy resolved at
-- finalization has exactly one answer.
--
-- TWO COLUMNS ON SellerChargebackFee, AND THEY ARE THE POINT. `feePolicyId` plus
-- the widened `policyVersion` bind each assessment to the exact version that
-- governed it, under a RESTRICT foreign key -- so a version some seller was
-- actually charged under can never be deleted. The amount stays snapshotted
-- beside them: the amount so a historical fee reads without a join, the version
-- so it stays EXPLICABLE. Activating a new value touches neither.
--
-- `feePolicyId` is added NOT NULL WITHOUT A DEFAULT, deliberately. The table was
-- created in the immediately preceding commit and no production deployment
-- exists, so it is empty everywhere this can run. If a row somehow existed, this
-- migration FAILS rather than admitting an assessment nobody can explain -- which
-- is the correct outcome for a financial record, and the same fail-closed
-- posture the assessment path itself takes when no policy is active.
--
-- `policyVersion` widens VARCHAR(32) -> VARCHAR(64) so the composite foreign key
-- has matching column types. A widening loses no value.

-- AlterTable
ALTER TABLE `SellerChargebackFee` ADD COLUMN `feePolicyId` VARCHAR(191) NOT NULL,
    MODIFY `policyVersion` VARCHAR(64) NOT NULL;

-- CreateTable
CREATE TABLE `SellerChargebackFeePolicy` (
    `id` VARCHAR(191) NOT NULL,
    `policyKey` VARCHAR(64) NOT NULL,
    `label` VARCHAR(200) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SellerChargebackFeePolicy_policyKey_key`(`policyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SellerChargebackFeePolicyVersionRow` (
    `seq` BIGINT NOT NULL AUTO_INCREMENT,
    `policyId` VARCHAR(191) NOT NULL,
    `policyVersion` VARCHAR(64) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `amountMinorUnits` BIGINT NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `effectiveFrom` DATETIME(3) NOT NULL,
    `recordedByAccountId` VARCHAR(191) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `retiredAt` DATETIME(3) NULL,
    `retiredByAccountId` VARCHAR(191) NULL,
    `activeMarker` VARCHAR(191) NULL,
    `rowCreatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SellerChargebackFeePolicyVersionRow_policyId_status_idx`(`policyId`, `status`),
    INDEX `SellerChargebackFeePolicyVersionRow_effectiveFrom_idx`(`effectiveFrom`),
    UNIQUE INDEX `SellerChargebackFeePolicyVersionRow_policyId_policyVersion_key`(`policyId`, `policyVersion`),
    UNIQUE INDEX `SellerChargebackFeePolicyVersionRow_activeMarker_key`(`activeMarker`),
    PRIMARY KEY (`seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `SellerChargebackFee_feePolicyId_policyVersion_idx` ON `SellerChargebackFee`(`feePolicyId`, `policyVersion`);

-- AddForeignKey
ALTER TABLE `SellerChargebackFee` ADD CONSTRAINT `SellerChargebackFee_feePolicyId_policyVersion_fkey` FOREIGN KEY (`feePolicyId`, `policyVersion`) REFERENCES `SellerChargebackFeePolicyVersionRow`(`policyId`, `policyVersion`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SellerChargebackFeePolicyVersionRow` ADD CONSTRAINT `SellerChargebackFeePolicyVersionRow_policyId_fkey` FOREIGN KEY (`policyId`) REFERENCES `SellerChargebackFeePolicy`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

