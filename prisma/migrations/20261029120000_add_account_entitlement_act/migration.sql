-- First-operator governance bootstrap — entitlement audit acts and a governed
-- CommercialPolicy bootstrap key.
--
-- Additive only. One new table, one new nullable column with its unique index
-- and CHECK on an existing table. No column is dropped or narrowed, no existing
-- row is touched, no helper table is created, and nothing is backfilled.
--
-- ── What is stored ───────────────────────────────────────────────────────────
--
--   AccountEntitlementAct
--       one append-only GRANT or REVOKE of one capability to one Account: the
--       basis (GOVERNED, or the once-ever BOOTSTRAP_FIRST_GRANT), the acting
--       `entitlement:govern` holder (NULL only for the bootstrap), and the
--       instant. Never updated or deleted. `AccountEntitlement` remains the
--       current-state projection and is written in the same transaction.
--
--       `firstGrantForCapability` is the once-ever marker: equal to
--       `capability` on the bootstrap act, NULL on every other. Its unique index
--       is what lets exactly one of two concurrent bootstraps win, and what
--       keeps a capability's first grant from ever happening twice.
--
--   CommercialPolicy.bootstrapKey
--       'STANDARD_V1' on the policy `commercial-policy:bootstrap` creates, NULL
--       on every other. The unique index makes concurrent bootstraps create one
--       policy, not two.
--
-- ── Production constraints ───────────────────────────────────────────────────
--
-- The CHECKs on AccountEntitlementAct are declared inside CREATE TABLE, so they
-- are created atomically with the table. Both Account foreign keys are
-- ON UPDATE RESTRICT and ON DELETE RESTRICT: MySQL refuses a CHECK on a column
-- used by a CASCADE action (error 3823), and an audit act must outlive nothing
-- it names.
--
-- The new table has a PRIMARY KEY (sql_require_primary_key=ON). Only CREATE,
-- INDEX, ALTER, and REFERENCES are exercised — no DROP. The deployed application
-- reads neither the table nor the column, so this applies safely before the
-- code that uses it is pushed.

-- AlterTable
ALTER TABLE `CommercialPolicy`
    ADD COLUMN `bootstrapKey` VARCHAR(32) NULL,
    ADD CONSTRAINT `CommercialPolicy_bootstrapKey_check` CHECK (`bootstrapKey` IS NULL OR `bootstrapKey` = 'STANDARD_V1');

-- CreateTable
CREATE TABLE `AccountEntitlementAct` (
    `id` VARCHAR(191) NOT NULL,
    `accountId` VARCHAR(191) NOT NULL,
    `capability` VARCHAR(64) NOT NULL,
    `action` VARCHAR(16) NOT NULL,
    `basis` VARCHAR(32) NOT NULL,
    `actorAccountId` VARCHAR(191) NULL,
    `firstGrantForCapability` VARCHAR(64) NULL,
    `actedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `AccountEntitlementAct_firstGrantForCapability_key`(`firstGrantForCapability`),
    INDEX `AccountEntitlementAct_accountId_capability_actedAt_idx`(`accountId`, `capability`, `actedAt`),
    INDEX `AccountEntitlementAct_capability_actedAt_idx`(`capability`, `actedAt`),
    INDEX `AccountEntitlementAct_actorAccountId_idx`(`actorAccountId`),
    PRIMARY KEY (`id`),
    CONSTRAINT `AccountEntitlementAct_action_check` CHECK (`action` IN ('GRANT', 'REVOKE')),
    CONSTRAINT `AccountEntitlementAct_basis_check` CHECK (`basis` IN ('GOVERNED', 'BOOTSTRAP_FIRST_GRANT')),
    CONSTRAINT `AccountEntitlementAct_actor_check` CHECK ((`basis` = 'BOOTSTRAP_FIRST_GRANT') = (`actorAccountId` IS NULL)),
    CONSTRAINT `AccountEntitlementAct_bootstrap_grant_check` CHECK (`basis` <> 'BOOTSTRAP_FIRST_GRANT' OR `action` = 'GRANT'),
    CONSTRAINT `AccountEntitlementAct_marker_check` CHECK (((`basis` = 'BOOTSTRAP_FIRST_GRANT') = (`firstGrantForCapability` IS NOT NULL)) AND (`firstGrantForCapability` IS NULL OR `firstGrantForCapability` = `capability`))
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `CommercialPolicy_bootstrapKey_key` ON `CommercialPolicy`(`bootstrapKey`);

-- AddForeignKey
ALTER TABLE `AccountEntitlementAct` ADD CONSTRAINT `AccountEntitlementAct_accountId_fkey` FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `AccountEntitlementAct` ADD CONSTRAINT `AccountEntitlementAct_actorAccountId_fkey` FOREIGN KEY (`actorAccountId`) REFERENCES `Account`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;
