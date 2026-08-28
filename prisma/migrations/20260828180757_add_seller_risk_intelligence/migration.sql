-- Phase 1.13 -- fraud and risk intelligence.
--
-- ADDITIVE. Four new tables, four index changes, and NOT ONE existing column
-- altered, dropped, or backfilled. Nothing here rewrites a financial record,
-- because nothing here IS one: every rate, count, velocity, ticket, and
-- geography figure this phase reports is computed at read time from Order,
-- TransactionEconomicSnapshot, OrderRefund, and TransactionDispute, which stay
-- authoritative and stay untouched.
--
-- WHY NO RISK-EVENT TABLE. A materialised per-sale risk row would be a second
-- answer to "how many sales did this seller make", able to drift from the first
-- and impossible to adjudicate against it. The project's own rule is that
-- capsules and projections never become authoritative records; a risk read model
-- is the same kind of derivative and earns no storage. Keeping the source rows
-- and deriving the report is also what lets a FUTURE risk model recompute
-- history: nothing was summarised away.
--
-- WHY THE HEURISTICS ARE THEIR OWN POLICY. `RiskPolicyVersionRow` is Phase 1.2's
-- synchronous allow/deny gate, resolved AT CHECKOUT and bound to an Order.
-- Review heuristics are resolved WHEN A REPORT RUNS, possibly months after the
-- sales it ranks. Phase 1.12 settled this same question for the chargeback fee
-- and settled it this way: a value decided at a different moment than the sale
-- gets its own policy, because putting it on the sale-time policy makes "which
-- version applies" genuinely ambiguous, whereas a separate policy resolved at
-- the deciding moment has exactly one answer. It is also what keeps
-- `NEVER_ON_RISK_POLICY` true -- no score, window, or threshold column is added
-- to the gate.
--
-- WHY THE INDEX CHANGES ARE NOT COSMETIC. `Order` already had
-- (sellerParticipantId, lifecycle) and (promoterParticipantId, lifecycle), and
-- neither carries a time column. Every question this phase asks is windowed --
-- "this seller's PAID orders between two instants" -- and MySQL cannot range-scan
-- a date that is not in the index, so a 30-day window would read every PAID order
-- the seller had ever placed. The two-column form is a PREFIX of the new
-- three-column form, so every query the old index served is still served and
-- nothing needs a second index kept beside it.
--
-- THE FOREIGN KEYS ARE DROPPED AND RE-ADDED, DELIBERATELY AND IN FULL. MySQL
-- requires an index on a foreign key's columns, and `Order_sellerParticipantId_fkey`
-- was resting on the two-column index being replaced. Dropping the index without
-- first dropping the constraint fails; leaving the constraint off afterwards
-- would silently remove RESTRICT from a commercial transaction table, which is
-- the one outcome this migration must not produce. Both are restored below with
-- their original definitions, unchanged.
--
-- `TransactionDispute` gains (status, closedAt) and `OrderRefund` gains
-- (status, finalizedAt) because a RATE counts on the instant the outcome became
-- final -- when the loss closed, when the buyer's money actually went back --
-- and those are different instants from `openedAt` and `recordedAt`, which the
-- existing indexes serve and which answer different questions.
--
-- NO BUYER PII IS STORED BY ANY TABLE BELOW. There is no name, email, address
-- line, postal code, IP, or device column, and no reviewer note column at all:
-- Phase 0M.R1 and Phase 1.11 both named free-text reviewer fields as forbidden,
-- and 1.11 gave the reason in one line -- an operator commentary column is where
-- a buyer's name eventually lands. Geography reaches this phase as a country and
-- region code read at query time and is never copied here.
--
-- NOTHING BELOW ENFORCES ANYTHING. `ParticipantRiskReview` records what a human
-- decided. It has no writer into `MarketplaceParticipant.status`, no writer into
-- `ParticipantRestriction`, and no path back into the transaction gate. A seller
-- suspended by arithmetic is the failure this shape exists to prevent.

-- CreateTable
CREATE TABLE `SellerRiskReviewPolicy` (
    `id` VARCHAR(191) NOT NULL,
    `policyKey` VARCHAR(64) NOT NULL,
    `label` VARCHAR(200) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `SellerRiskReviewPolicy_policyKey_key`(`policyKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `SellerRiskReviewPolicyVersionRow` (
    `seq` BIGINT NOT NULL AUTO_INCREMENT,
    `policyId` VARCHAR(191) NOT NULL,
    `policyVersion` VARCHAR(64) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `minimumRateSampleCount` INTEGER NOT NULL,
    `minimumBaselineSampleCount` INTEGER NOT NULL,
    `refundCountRateReviewBasisPoints` INTEGER NOT NULL,
    `chargebackCountRateReviewBasisPoints` INTEGER NOT NULL,
    `chargebackToRefundRatioReviewBasisPoints` INTEGER NOT NULL,
    `velocityReviewBasisPoints` INTEGER NOT NULL,
    `averageTicketShiftReviewBasisPoints` INTEGER NOT NULL,
    `volumeSpikeReviewBasisPoints` INTEGER NOT NULL,
    `jurisdictionConcentrationReviewBasisPoints` INTEGER NOT NULL,
    `newJurisdictionReviewCount` INTEGER NOT NULL,
    `promoterConcentrationReviewBasisPoints` INTEGER NOT NULL,
    `attentionScoreFloor` INTEGER NOT NULL,
    `effectiveFrom` DATETIME(3) NOT NULL,
    `recordedByAccountId` VARCHAR(191) NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,
    `retiredAt` DATETIME(3) NULL,
    `retiredByAccountId` VARCHAR(191) NULL,
    `activeMarker` VARCHAR(191) NULL,
    `rowCreatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `SellerRiskReviewPolicyVersionRow_policyId_status_idx`(`policyId`, `status`),
    INDEX `SellerRiskReviewPolicyVersionRow_effectiveFrom_idx`(`effectiveFrom`),
    UNIQUE INDEX `SellerRiskReviewPolicyVersionRow_policyId_policyVersion_key`(`policyId`, `policyVersion`),
    UNIQUE INDEX `SellerRiskReviewPolicyVersionRow_activeMarker_key`(`activeMarker`),
    PRIMARY KEY (`seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ParticipantRiskReview` (
    `id` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `triggerSource` VARCHAR(16) NOT NULL,
    `triggerAsOf` DATETIME(3) NOT NULL,
    `reviewPolicyId` VARCHAR(191) NOT NULL,
    `reviewPolicyVersion` VARCHAR(64) NOT NULL,
    `openedAt` DATETIME(3) NOT NULL,
    `openedByAccountId` VARCHAR(191) NULL,
    `status` VARCHAR(24) NOT NULL,
    `assignedReviewerAccountId` VARCHAR(191) NULL,
    `dispositionCode` VARCHAR(48) NULL,
    `decidedByAccountId` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `resultingRestrictionId` VARCHAR(191) NULL,
    `openForParticipantId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `ParticipantRiskReview_openForParticipantId_key`(`openForParticipantId`),
    INDEX `ParticipantRiskReview_participantId_openedAt_idx`(`participantId`, `openedAt`),
    INDEX `ParticipantRiskReview_status_openedAt_idx`(`status`, `openedAt`),
    INDEX `ParticipantRiskReview_reviewPolicyId_reviewPolicyVersion_idx`(`reviewPolicyId`, `reviewPolicyVersion`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ParticipantRiskReviewTriggerReason` (
    `seq` BIGINT NOT NULL AUTO_INCREMENT,
    `reviewId` VARCHAR(191) NOT NULL,
    `reasonCode` VARCHAR(64) NOT NULL,
    `unit` VARCHAR(16) NOT NULL,
    `observedValue` BIGINT NOT NULL,
    `baselineValue` BIGINT NULL,
    `sampleSize` BIGINT NOT NULL,
    `windowDays` INTEGER NOT NULL,
    `recordedAt` DATETIME(3) NOT NULL,

    INDEX `ParticipantRiskReviewTriggerReason_reasonCode_idx`(`reasonCode`),
    UNIQUE INDEX `ParticipantRiskReviewTriggerReason_reviewId_reasonCode_key`(`reviewId`, `reasonCode`),
    PRIMARY KEY (`seq`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- DropForeignKey
-- Both constraints rest on the two-column indexes replaced below. They are
-- restored, unchanged, at the end of this migration.
ALTER TABLE `Order` DROP FOREIGN KEY `Order_sellerParticipantId_fkey`;

-- DropForeignKey
ALTER TABLE `Order` DROP FOREIGN KEY `Order_promoterParticipantId_fkey`;

-- DropIndex
DROP INDEX `Order_sellerParticipantId_lifecycle_idx` ON `Order`;

-- DropIndex
DROP INDEX `Order_promoterParticipantId_lifecycle_idx` ON `Order`;

-- CreateIndex
CREATE INDEX `Order_sellerParticipantId_lifecycle_paidAt_idx` ON `Order`(`sellerParticipantId`, `lifecycle`, `paidAt`);

-- CreateIndex
CREATE INDEX `Order_promoterParticipantId_lifecycle_paidAt_idx` ON `Order`(`promoterParticipantId`, `lifecycle`, `paidAt`);

-- CreateIndex
CREATE INDEX `OrderRefund_status_finalizedAt_idx` ON `OrderRefund`(`status`, `finalizedAt`);

-- CreateIndex
CREATE INDEX `TransactionDispute_status_closedAt_idx` ON `TransactionDispute`(`status`, `closedAt`);

-- AddForeignKey
ALTER TABLE `SellerRiskReviewPolicyVersionRow` ADD CONSTRAINT `SellerRiskReviewPolicyVersionRow_policyId_fkey` FOREIGN KEY (`policyId`) REFERENCES `SellerRiskReviewPolicy`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantRiskReview` ADD CONSTRAINT `ParticipantRiskReview_participantId_fkey` FOREIGN KEY (`participantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantRiskReview` ADD CONSTRAINT `ParticipantRiskReview_reviewPolicyId_reviewPolicyVersion_fkey` FOREIGN KEY (`reviewPolicyId`, `reviewPolicyVersion`) REFERENCES `SellerRiskReviewPolicyVersionRow`(`policyId`, `policyVersion`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantRiskReview` ADD CONSTRAINT `ParticipantRiskReview_resultingRestrictionId_fkey` FOREIGN KEY (`resultingRestrictionId`) REFERENCES `ParticipantRestriction`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ParticipantRiskReviewTriggerReason` ADD CONSTRAINT `ParticipantRiskReviewTriggerReason_reviewId_fkey` FOREIGN KEY (`reviewId`) REFERENCES `ParticipantRiskReview`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- Restored exactly as `20260820193000_add_buyer_checkout_order_and_post_sale`
-- defined them. RESTRICT on a commercial transaction table is not negotiable.
ALTER TABLE `Order` ADD CONSTRAINT `Order_sellerParticipantId_fkey` FOREIGN KEY (`sellerParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `Order` ADD CONSTRAINT `Order_promoterParticipantId_fkey` FOREIGN KEY (`promoterParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
