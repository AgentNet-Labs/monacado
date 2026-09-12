-- Phase 1.27 — Account-level email verification.
--
-- Additive only. No column is dropped, no column is narrowed, and no existing
-- migration is touched.
--
-- ── Backward compatibility, stated explicitly ────────────────────────────────
--
-- `authenticateAccount` now refuses an account whose `emailVerifiedAt` is NULL.
-- Every Account that existed before this migration was created under rules that
-- never asked anybody to prove an address, so leaving them NULL would lock out
-- every existing account at deploy time.
--
-- They are therefore backfilled as verified, and marked `PRE_VERIFICATION_BACKFILL`
-- so the reason is durable and honest. This is a COMPATIBILITY STATE TRANSITION,
-- NOT evidence that these addresses were ever proved — no historical verification
-- is invented, and the provenance column exists precisely so a later reader can
-- tell a grandfathered account from one that consumed a real challenge.
--
-- `emailVerifiedAt` is set to the migration instant rather than to `createdAt`,
-- because the honest meaning of the timestamp for these rows is "when this
-- account became permitted to authenticate under the new rule" — backdating it
-- to creation would assert something about the past that did not happen.
--
-- Accounts created AFTER this migration by public sign-up start NULL and must
-- prove their address. Administrative creation sets the marker explicitly.

ALTER TABLE `Account`
  ADD COLUMN `emailVerifiedAt` DATETIME(3) NULL,
  ADD COLUMN `emailVerifiedVia` VARCHAR(32) NULL;

UPDATE `Account`
  SET `emailVerifiedAt` = CURRENT_TIMESTAMP(3),
      `emailVerifiedVia` = 'PRE_VERIFICATION_BACKFILL'
  WHERE `emailVerifiedAt` IS NULL;

CREATE TABLE `AccountEmailVerificationChallenge` (
  `id` VARCHAR(191) NOT NULL,
  `accountId` VARCHAR(191) NOT NULL,
  `addressDigest` CHAR(64) NOT NULL,
  `tokenDigest` CHAR(64) NOT NULL,
  `state` VARCHAR(16) NOT NULL,
  `issuedAt` DATETIME(3) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `consumedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `AccountEmailVerificationChallenge_tokenDigest_key`(`tokenDigest`),
  INDEX `AccountEmailVerificationChallenge_accountId_state_idx`(`accountId`, `state`),
  INDEX `AccountEmailVerificationChallenge_state_expiresAt_idx`(`state`, `expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AccountEmailVerificationChallenge`
  ADD CONSTRAINT `AccountEmailVerificationChallenge_accountId_fkey`
  FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
