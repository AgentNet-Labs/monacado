-- Phase 1.41 — Promotion Authorization (Contract §16.1).
--
-- Additive only. Two new tables. No column is added, dropped, or narrowed on any
-- existing table, no existing row is touched, and no existing migration is
-- changed. Nothing is backfilled: no Product has any relationship until a
-- Promoter requests one.
--
-- ── What is stored, and what is not ──────────────────────────────────────────
--
--   PromotionAuthorization
--       one REQUEST CYCLE between one Product and one Promoter participant. The
--       current cycle for a pair holds the unique (currentForProductId,
--       currentForPromoterParticipantId) marker; a re-request after DENIED,
--       REVOKED, or CANCELLED opens a NEW cycle naming the one it follows
--       (`supersedesAuthorizationId`, unique), so the earlier cycle is never
--       rewritten and approval is never restored.
--
--   PromotionAuthorizationAct
--       one append-only act on a cycle (REQUEST, APPROVE, DENY, REVOKE,
--       CANCEL). The current act holds `currentForAuthorizationId` (unique);
--       its `state` is the cycle's state. Each act names the one it follows
--       (`supersedesActId`, unique) — one linear history per cycle.
--
-- Not stored: any `isAuthorized` / commerce boolean, and nothing on any Product
-- source version. Product lifecycle and resale availability are not read and
-- not written. Nothing here is published.

-- CreateTable
CREATE TABLE `PromotionAuthorization` (
    `id` VARCHAR(191) NOT NULL,
    `authorizationRef` VARCHAR(32) NOT NULL,
    `internalProductId` VARCHAR(191) NOT NULL,
    `promoterParticipantId` VARCHAR(191) NOT NULL,
    `cycleNumber` INTEGER NOT NULL,
    `supersedesAuthorizationId` VARCHAR(191) NULL,
    `currentForProductId` VARCHAR(191) NULL,
    `currentForPromoterParticipantId` VARCHAR(191) NULL,
    `requestedByAccountId` VARCHAR(191) NOT NULL,
    `requestedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PromotionAuthorization_authorizationRef_key`(`authorizationRef`),
    UNIQUE INDEX `PromotionAuthorization_supersedesAuthorizationId_key`(`supersedesAuthorizationId`),
    INDEX `PromotionAuthorization_promoterParticipantId_idx`(`promoterParticipantId`),
    UNIQUE INDEX `PromotionAuthorization_currentForProductId_currentForPromote_key`(`currentForProductId`, `currentForPromoterParticipantId`),
    UNIQUE INDEX `PromotionAuthorization_internalProductId_promoterParticipant_key`(`internalProductId`, `promoterParticipantId`, `cycleNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `PromotionAuthorizationAct` (
    `id` VARCHAR(191) NOT NULL,
    `authorizationId` VARCHAR(191) NOT NULL,
    `act` VARCHAR(16) NOT NULL,
    `state` VARCHAR(16) NOT NULL,
    `previousState` VARCHAR(16) NULL,
    `supersedesActId` VARCHAR(191) NULL,
    `currentForAuthorizationId` VARCHAR(191) NULL,
    `actorAuthority` VARCHAR(16) NOT NULL,
    `actorParticipantId` VARCHAR(191) NOT NULL,
    `actedByAccountId` VARCHAR(191) NOT NULL,
    `actedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `PromotionAuthorizationAct_supersedesActId_key`(`supersedesActId`),
    UNIQUE INDEX `PromotionAuthorizationAct_currentForAuthorizationId_key`(`currentForAuthorizationId`),
    INDEX `PromotionAuthorizationAct_authorizationId_actedAt_idx`(`authorizationId`, `actedAt`),
    INDEX `PromotionAuthorizationAct_actorParticipantId_idx`(`actorParticipantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `PromotionAuthorization` ADD CONSTRAINT `PromotionAuthorization_internalProductId_fkey` FOREIGN KEY (`internalProductId`) REFERENCES `Product`(`internalProductId`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PromotionAuthorization` ADD CONSTRAINT `PromotionAuthorization_promoterParticipantId_fkey` FOREIGN KEY (`promoterParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PromotionAuthorizationAct` ADD CONSTRAINT `PromotionAuthorizationAct_authorizationId_fkey` FOREIGN KEY (`authorizationId`) REFERENCES `PromotionAuthorization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PromotionAuthorizationAct` ADD CONSTRAINT `PromotionAuthorizationAct_actorParticipantId_fkey` FOREIGN KEY (`actorParticipantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
