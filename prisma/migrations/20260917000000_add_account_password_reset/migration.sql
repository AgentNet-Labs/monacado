-- Phase 1.28 — Self-service account password reset.
--
-- Additive only: one new table. No existing column, index, or migration is
-- touched, and no existing row is read or written.
--
-- The table stores a SHA-256 digest of each reset token and never the token
-- itself, so a dump of it yields no working link.

CREATE TABLE `AccountPasswordResetChallenge` (
  `id` VARCHAR(191) NOT NULL,
  `accountId` VARCHAR(191) NOT NULL,
  `addressDigest` CHAR(64) NOT NULL,
  `tokenDigest` CHAR(64) NOT NULL,
  `state` VARCHAR(16) NOT NULL,
  `issuedAt` DATETIME(3) NOT NULL,
  `expiresAt` DATETIME(3) NOT NULL,
  `consumedAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `AccountPasswordResetChallenge_tokenDigest_key`(`tokenDigest`),
  INDEX `AccountPasswordResetChallenge_accountId_state_idx`(`accountId`, `state`),
  INDEX `AccountPasswordResetChallenge_state_expiresAt_idx`(`state`, `expiresAt`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `AccountPasswordResetChallenge`
  ADD CONSTRAINT `AccountPasswordResetChallenge_accountId_fkey`
  FOREIGN KEY (`accountId`) REFERENCES `Account`(`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
