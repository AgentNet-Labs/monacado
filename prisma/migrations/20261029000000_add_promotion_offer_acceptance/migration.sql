-- Phase 1.44 — Promoter Offer-package acceptance (Contract §16.3(7), §19).
--
-- Additive only. One new table and one new unique index on an existing table.
-- No column is added, dropped, or narrowed on any existing table, no existing
-- row is touched, no helper table is created, and nothing is backfilled: no
-- Promoter has accepted anything until it does so through the new route.
--
-- ── What is stored, and what is not ──────────────────────────────────────────
--
--   PromotionOfferAcceptance
--       one Promoter's acceptance of one exact commercial PACKAGE — the exact
--       STANDING Offer version, or that version together with the exact
--       SCHEDULED_PROMOTION version built on it — under one Promotion
--       Authorization cycle. Append-only; never updated. The Promoter is the
--       cycle's and is not copied. `promotionVersionKey` is `promotionVersion`
--       or '' so the unique key also covers standard-only packages (MySQL
--       admits any number of NULLs); the CHECK below holds the two equal.
--
--   OfferSourceRecordVersionRow_srec_version_basis_key
--       a superset of the existing (offerSourceRecordId, sourceRecordVersion)
--       unique key — unique by construction, so it cannot fail on existing
--       rows. It is the target of the acceptance's promotion foreign key, which
--       thereby proves the accepted promotion was built on the accepted standing
--       version: a STANDING row's basis is NULL and never matches. A NULL
--       `promotionVersion` passes the composite key under MATCH SIMPLE.
--
-- Not stored: retail price, Monacado's retained amount, transaction money, the
-- economics (the immutable version rows hold them), any participant id, or any
-- accepted / current flag. Nothing here is published.
--
-- ── Production constraints ───────────────────────────────────────────────────
--
-- The CHECK is declared inside CREATE TABLE, so it is created atomically with
-- the table (a CHECK added later by ALTER could fail after the table exists).
-- The two Offer-version foreign keys are ON UPDATE RESTRICT: versions are
-- immutable, and MySQL refuses a CHECK on a column used by a CASCADE action
-- (error 3823).
--
-- The table has a PRIMARY KEY (sql_require_primary_key=ON). Only CREATE, INDEX,
-- ALTER, and REFERENCES are exercised — no DROP. The deployed application
-- reads neither the table nor the index, so this applies safely before the
-- code that uses it is pushed.

-- CreateTable
CREATE TABLE `PromotionOfferAcceptance` (
    `id` VARCHAR(191) NOT NULL,
    `authorizationId` VARCHAR(191) NOT NULL,
    `offerSourceRecordId` VARCHAR(191) NOT NULL,
    `standingVersion` VARCHAR(64) NOT NULL,
    `promotionVersion` VARCHAR(64) NULL,
    `promotionVersionKey` VARCHAR(64) NOT NULL,
    `acceptedByAccountId` VARCHAR(191) NOT NULL,
    `acceptedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `PromotionOfferAcceptance_offerSourceRecordId_standingVersion_idx`(`offerSourceRecordId`, `standingVersion`),
    INDEX `PromotionOfferAcceptance_offerSourceRecordId_promotionVersio_idx`(`offerSourceRecordId`, `promotionVersion`, `standingVersion`),
    UNIQUE INDEX `PromotionOfferAcceptance_authorizationId_offerSourceRecordId_key`(`authorizationId`, `offerSourceRecordId`, `standingVersion`, `promotionVersionKey`),
    PRIMARY KEY (`id`),
    CONSTRAINT `PromotionOfferAcceptance_promotionVersionKey_check` CHECK (`promotionVersionKey` = IFNULL(`promotionVersion`, ''))
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `OfferSourceRecordVersionRow_srec_version_basis_key` ON `OfferSourceRecordVersionRow`(`offerSourceRecordId`, `sourceRecordVersion`, `basisStandingVersion`);

-- AddForeignKey
ALTER TABLE `PromotionOfferAcceptance` ADD CONSTRAINT `PromotionOfferAcceptance_authorizationId_fkey` FOREIGN KEY (`authorizationId`) REFERENCES `PromotionAuthorization`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `PromotionOfferAcceptance` ADD CONSTRAINT `PromotionOfferAcceptance_offerSourceRecordId_standingVersio_fkey` FOREIGN KEY (`offerSourceRecordId`, `standingVersion`) REFERENCES `OfferSourceRecordVersionRow`(`offerSourceRecordId`, `sourceRecordVersion`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `PromotionOfferAcceptance` ADD CONSTRAINT `PromotionOfferAcceptance_offerSourceRecordId_promotionVersi_fkey` FOREIGN KEY (`offerSourceRecordId`, `promotionVersion`, `standingVersion`) REFERENCES `OfferSourceRecordVersionRow`(`offerSourceRecordId`, `sourceRecordVersion`, `basisStandingVersion`) ON DELETE RESTRICT ON UPDATE RESTRICT;
