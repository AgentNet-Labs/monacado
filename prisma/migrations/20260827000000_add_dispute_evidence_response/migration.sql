-- Phase 1.12 -- Dispute Evidence Response, and the seller chargeback fee.
--
-- Purely additive. Four new tables and their foreign keys. No column on any
-- existing table is added, altered, widened, or dropped, and no index on one is
-- replaced -- so unlike Phase 1.11's migration there is no drop-and-re-add dance
-- and nothing to backfill.
--
-- WHY NEW TABLES RATHER THAN COLUMNS ON TransactionDispute. That model already
-- carries five evidence columns -- evidenceDueBy, responsePermitted,
-- evidenceStagedAtProvider, evidenceSubmissionCount, evidenceSubmittedPastDue --
-- and every one of them is the PROVIDER's assertion, rewritten wholesale from the
-- observation on each applied webhook delivery. Recording Monacado's own conduct
-- there would be erased by the next delivery, and would put a Monacado claim in a
-- column documented as provider posture.
--
-- They are kept apart so that they can DISAGREE. "The provider says no evidence
-- was ever submitted, and Monacado's record says it submitted some" is a finding
-- an operator must see, not a contradiction to design away by deriving one from
-- the other.
--
-- NO EVIDENCE VALUE IS STORED. A record-backed item is a bounded pointer plus the
-- instant its source was observed; the value is read from the cited record at
-- render time, which is what keeps 1.11's "derived, never stored" decision intact
-- in a phase that has to record what it sent. A seller's attestation is a member
-- of a closed vocabulary. There is no free-text column, no document column, no
-- blob, and no provider payload anywhere below -- the same rules
-- NEVER_ON_TRANSACTION_DISPUTE states, kept rather than narrowed.
--
-- SellerChargebackFee IS A NEW FACT, NOT A CORRECTION. A finalized lost
-- chargeback costs the seller $30, and that fee is its own row pointing at the
-- dispute that caused it. NOTHING historical moves: the economic snapshot stays
-- frozen, no proceeds figure is netted, and no payout is touched -- deducting a
-- fee from a historical amount would restate what three parties were told they
-- earned, silently. Collection is deliberately absent; the obligation is recorded
-- and an operator can see it, and discharging it belongs to 0M.T2.

-- CreateTable
CREATE TABLE `DisputeEvidenceItem` (
    `id` VARCHAR(191) NOT NULL,
    `disputeId` VARCHAR(191) NOT NULL,
    `evidenceCode` VARCHAR(48) NOT NULL,
    `sourceKind` VARCHAR(32) NOT NULL,
    `sourceTable` VARCHAR(64) NULL,
    `sourceRef` VARCHAR(191) NULL,
    `sourceObservedAt` DATETIME(3) NULL,
    `attestationClaim` VARCHAR(48) NULL,
    `assertedByKind` VARCHAR(16) NOT NULL,
    `assertedByAccountId` VARCHAR(191) NULL,
    `assertedByParticipantId` VARCHAR(191) NULL,
    `assertedAt` DATETIME(3) NOT NULL,
    `validationState` VARCHAR(24) NOT NULL,
    `validationCode` VARCHAR(48) NULL,
    `supersedesItemId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `DisputeEvidenceItem_disputeId_validationState_idx`(`disputeId`, `validationState`),
    INDEX `DisputeEvidenceItem_sourceTable_sourceRef_idx`(`sourceTable`, `sourceRef`),
    INDEX `DisputeEvidenceItem_assertedByParticipantId_idx`(`assertedByParticipantId`),
    UNIQUE INDEX `DisputeEvidenceItem_disputeId_evidenceCode_sourceRef_key`(`disputeId`, `evidenceCode`, `sourceRef`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DisputeEvidencePreparation` (
    `id` VARCHAR(191) NOT NULL,
    `disputeId` VARCHAR(191) NOT NULL,
    `revision` INTEGER NOT NULL,
    `status` VARCHAR(24) NOT NULL,
    `completeness` VARCHAR(16) NOT NULL,
    `finalSubmission` BOOLEAN NOT NULL DEFAULT true,
    `basedOnProviderEventAt` DATETIME(3) NOT NULL,
    `approvedByAccountId` VARCHAR(191) NULL,
    `approvedAt` DATETIME(3) NULL,
    `providerSubmissionCountAfter` INTEGER NULL,
    `submittedPastDue` BOOLEAN NOT NULL DEFAULT false,
    `failureCode` VARCHAR(48) NULL,
    `attemptCount` INTEGER NOT NULL DEFAULT 0,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `preparedAt` DATETIME(3) NOT NULL,
    `submittedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `DisputeEvidencePreparation_idempotencyKey_key`(`idempotencyKey`),
    INDEX `DisputeEvidencePreparation_status_preparedAt_idx`(`status`, `preparedAt`),
    INDEX `DisputeEvidencePreparation_disputeId_preparedAt_idx`(`disputeId`, `preparedAt`),
    UNIQUE INDEX `DisputeEvidencePreparation_disputeId_revision_key`(`disputeId`, `revision`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `DisputeEvidencePreparationItem` (
    `seq` BIGINT NOT NULL AUTO_INCREMENT,
    `preparationId` VARCHAR(191) NOT NULL,
    `itemId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `DisputeEvidencePreparationItem_itemId_idx`(`itemId`),
    UNIQUE INDEX `DisputeEvidencePreparationItem_preparationId_itemId_key`(`preparationId`, `itemId`),
    PRIMARY KEY (`seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SellerChargebackFee` (
    `id` VARCHAR(191) NOT NULL,
    `disputeId` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `sellerParticipantId` VARCHAR(191) NOT NULL,
    `amountMinorUnits` BIGINT NOT NULL,
    `currency` VARCHAR(3) NOT NULL,
    `policyVersion` VARCHAR(32) NOT NULL,
    `state` VARCHAR(16) NOT NULL,
    `assessedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SellerChargebackFee_disputeId_key`(`disputeId`),
    INDEX `SellerChargebackFee_state_assessedAt_idx`(`state`, `assessedAt`),
    INDEX `SellerChargebackFee_sellerParticipantId_assessedAt_idx`(`sellerParticipantId`, `assessedAt`),
    INDEX `SellerChargebackFee_orderId_idx`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `DisputeEvidenceItem` ADD CONSTRAINT `DisputeEvidenceItem_disputeId_fkey` FOREIGN KEY (`disputeId`) REFERENCES `TransactionDispute`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DisputeEvidenceItem` ADD CONSTRAINT `DisputeEvidenceItem_supersedesItemId_fkey` FOREIGN KEY (`supersedesItemId`) REFERENCES `DisputeEvidenceItem`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DisputeEvidencePreparation` ADD CONSTRAINT `DisputeEvidencePreparation_disputeId_fkey` FOREIGN KEY (`disputeId`) REFERENCES `TransactionDispute`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DisputeEvidencePreparationItem` ADD CONSTRAINT `DisputeEvidencePreparationItem_preparationId_fkey` FOREIGN KEY (`preparationId`) REFERENCES `DisputeEvidencePreparation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `DisputeEvidencePreparationItem` ADD CONSTRAINT `DisputeEvidencePreparationItem_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `DisputeEvidenceItem`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SellerChargebackFee` ADD CONSTRAINT `SellerChargebackFee_disputeId_fkey` FOREIGN KEY (`disputeId`) REFERENCES `TransactionDispute`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `SellerChargebackFee` ADD CONSTRAINT `SellerChargebackFee_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `Order`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

