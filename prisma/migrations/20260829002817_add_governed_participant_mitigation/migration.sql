-- Phase 1.14 -- governed participant-level risk mitigation.
--
-- ADDITIVE. Two new tables, four new columns, and NOT ONE existing column
-- altered or dropped. Phase 1.13 built explainable risk intelligence and a Staff
-- review that ENFORCES NOTHING, and recorded exactly what would have to exist
-- before a participant-level consequence could be operated. This is that.
--
-- WHAT THIS PHASE REFUSES TO CHANGE. No threshold invokes anything. No
-- disposition performs anything. No column below is written by reading a review
-- score, a report row, or a `dispositionCode`. `SUSPENSION_RECOMMENDED` remains
-- a conclusion a person recorded, and a suspension remains a separate act by a
-- separately-entitled person. The link between them is a REFERENCE, never a
-- trigger -- which is the whole architecture of the previous phase, preserved.
--
-- WHY A SUSPENSION NEEDS ITS OWN TABLE. Phase 0M.8 refused to write `SUSPENDED`
-- and said precisely why: "the status has no machine-readable content to write
-- ... a restriction nobody can enumerate is indistinguishable from a
-- suspension." That refusal named its own discharge condition, and 0M.R1
-- discharged it for `RESTRICTED` by giving that status an enumerable evidence
-- row. This does the same for `SUSPENDED`.
--
-- It cannot be done with restriction rows instead, however many.
-- `RESTRICTABLE_CAPABILITIES` deliberately EXCLUDES drafting and
-- `activation:submit`, because a participant must be able to answer a
-- restriction and correct the work that caused it. A suspension withholds those
-- too, so it is structurally inexpressible as a set of scopes. That is also the
-- real difference between the two statuses, and it already exists in committed
-- code: `DRAFTING_PARTICIPANT_STATUSES` contains `RESTRICTED` and not
-- `SUSPENDED`. A suspension is therefore not a restriction with a louder name.
--
-- WHY THE POLICY VERSION IS BOUND TO EVERY ACT. The same discipline an Order
-- follows for the terms that governed a purchase. Monacado's authority to have
-- acted is only checkable against the version it acted under, and a participant
-- who asks for reconsideration in September must be answered on the terms in
-- force in March -- not on whatever is current by then. NOT NULL on a suspension
-- because none predates participant-level terms; NULLABLE on a restriction only
-- because the columns are additive over rows imposed before those terms existed.
-- NOTHING BACKFILLS THEM: stamping today's terms onto a historical act would
-- assert an authority nobody held at the time.
--
-- `comparison` ON THE TRIGGER REASON IS A CORRECTION, NOT A FEATURE. Phase 1.13
-- did not persist it and reconstituted it on read as the constant
-- `POLICY_THRESHOLD`, so a review raised by a velocity spike -- which is measured
-- against the seller's own prior window -- read back forever as though it had
-- been measured against a governed threshold. Harmless while the review enforced
-- nothing; an audit defect the moment a restriction cites the review as its
-- basis, because the record would misstate what was compared against what.
--
-- It is added NOT NULL WITHOUT A DEFAULT, deliberately, on the reasoning the
-- chargeback fee policy used for the same shape: the table was created in the
-- immediately preceding commit and no production deployment exists, so it is
-- empty everywhere this can run. If a row somehow existed, this migration FAILS
-- rather than admitting an observation nobody can explain -- which is the correct
-- outcome for the evidence behind a judgement about a person.
--
-- NOTHING HERE IS IRREVERSIBLE. Every adverse act has its undo built in the same
-- phase, by the same grant, preserving the original row untouched: `LIFTED` is
-- terminal and re-imposing is a NEW row, so "suspended, reinstated, suspended
-- again" reads as two events rather than one row that changed its mind. There is
-- no expiry column anywhere -- a suspension that lapsed on its own would be a
-- policy decision nothing here makes. Shipping an adverse action with no path
-- back would have been worse than shipping none.
--
-- NO PROSE AND NO ANALYTICS. There is no note, rationale, narrative, or
-- free-text column on any table below, for the reason 0M.R1 and 1.11 both gave:
-- an operator commentary column is where a buyer's name eventually lands. There
-- is likewise no score, rate, counter, tier, or threshold -- a restriction
-- justified by a stored number would make the arithmetic authoritative over the
-- person, which is the inversion this whole line of work exists to prevent.

-- AlterTable
ALTER TABLE `ParticipantRestriction` ADD COLUMN `marketplacePolicyId` VARCHAR(191) NULL,
    ADD COLUMN `marketplacePolicyVersion` VARCHAR(64) NULL,
    ADD COLUMN `riskReviewId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `ParticipantRiskReviewTriggerReason` ADD COLUMN `comparison` VARCHAR(32) NOT NULL;

-- CreateTable
CREATE TABLE `ParticipantSuspension` (
    `id` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `reasonCode` VARCHAR(48) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `statusBeforeSuspension` VARCHAR(24) NOT NULL,
    `imposedAt` DATETIME(3) NOT NULL,
    `imposedByAccountId` VARCHAR(191) NOT NULL,
    `liftedAt` DATETIME(3) NULL,
    `liftedByAccountId` VARCHAR(191) NULL,
    `liftedReasonCode` VARCHAR(48) NULL,
    `riskReviewId` VARCHAR(191) NULL,
    `marketplacePolicyId` VARCHAR(191) NOT NULL,
    `marketplacePolicyVersion` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `activeForParticipantId` VARCHAR(191) NULL,

    UNIQUE INDEX `ParticipantSuspension_activeForParticipantId_key`(`activeForParticipantId`),
    INDEX `ParticipantSuspension_participantId_imposedAt_idx`(`participantId`, `imposedAt`),
    INDEX `ParticipantSuspension_status_imposedAt_idx`(`status`, `imposedAt`),
    INDEX `ParticipantSuspension_riskReviewId_idx`(`riskReviewId`),
    INDEX `ParticipantSuspension_marketplacePolicyId_marketplacePolicyV_idx`(`marketplacePolicyId`, `marketplacePolicyVersion`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ParticipantReconsideration` (
    `id` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `restrictionId` VARCHAR(191) NULL,
    `suspensionId` VARCHAR(191) NULL,
    `requestedByAccountId` VARCHAR(191) NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL,
    `groundCode` VARCHAR(48) NOT NULL,
    `remediationClaimCode` VARCHAR(48) NULL,
    `status` VARCHAR(24) NOT NULL,
    `assignedReviewerAccountId` VARCHAR(191) NULL,
    `determinationCode` VARCHAR(64) NULL,
    `decidedByAccountId` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,
    `openForDecisionId` VARCHAR(191) NULL,

    UNIQUE INDEX `ParticipantReconsideration_openForDecisionId_key`(`openForDecisionId`),
    INDEX `ParticipantReconsideration_participantId_requestedAt_idx`(`participantId`, `requestedAt`),
    INDEX `ParticipantReconsideration_status_requestedAt_idx`(`status`, `requestedAt`),
    INDEX `ParticipantReconsideration_restrictionId_idx`(`restrictionId`),
    INDEX `ParticipantReconsideration_suspensionId_idx`(`suspensionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `ParticipantRestriction_riskReviewId_idx` ON `ParticipantRestriction`(`riskReviewId`);

-- CreateIndex
CREATE INDEX `ParticipantRestriction_marketplacePolicyId_marketplacePolicy_idx` ON `ParticipantRestriction`(`marketplacePolicyId`, `marketplacePolicyVersion`);

-- AddForeignKey
ALTER TABLE `ParticipantRestriction` ADD CONSTRAINT `ParticipantRestriction_riskReviewId_fkey` FOREIGN KEY (`riskReviewId`) REFERENCES `ParticipantRiskReview`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantRestriction` ADD CONSTRAINT `ParticipantRestriction_marketplacePolicyId_marketplacePolic_fkey` FOREIGN KEY (`marketplacePolicyId`, `marketplacePolicyVersion`) REFERENCES `MarketplacePolicyVersionRow`(`policyId`, `policyVersion`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantSuspension` ADD CONSTRAINT `ParticipantSuspension_participantId_fkey` FOREIGN KEY (`participantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantSuspension` ADD CONSTRAINT `ParticipantSuspension_riskReviewId_fkey` FOREIGN KEY (`riskReviewId`) REFERENCES `ParticipantRiskReview`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantSuspension` ADD CONSTRAINT `ParticipantSuspension_marketplacePolicyId_marketplacePolicy_fkey` FOREIGN KEY (`marketplacePolicyId`, `marketplacePolicyVersion`) REFERENCES `MarketplacePolicyVersionRow`(`policyId`, `policyVersion`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantReconsideration` ADD CONSTRAINT `ParticipantReconsideration_participantId_fkey` FOREIGN KEY (`participantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantReconsideration` ADD CONSTRAINT `ParticipantReconsideration_restrictionId_fkey` FOREIGN KEY (`restrictionId`) REFERENCES `ParticipantRestriction`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantReconsideration` ADD CONSTRAINT `ParticipantReconsideration_suspensionId_fkey` FOREIGN KEY (`suspensionId`) REFERENCES `ParticipantSuspension`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
