-- Phase 1.37 — Account declared first / last name (Contract §4).
--
-- Additive only. No column is dropped, no column is narrowed, and no existing
-- migration is touched.
--
-- ── Why both columns are NULLABLE, and nothing is backfilled ─────────────────
--
-- These hold the first and last name DECLARED by the account holder. A NULL is
-- the honest answer for every Account that exists before this migration: nobody
-- declared a name for it. Backfilling — from `name`, from the email, or from a
-- placeholder such as "Unknown" — would write a declaration nobody made, and
-- `name` is a non-authoritative display value that must not be promoted into an
-- identity fact.
--
-- A NOT NULL column would require exactly such a fallback for any existing row,
-- so the columns stay nullable and "not declared" is a state later readiness
-- checks can see and refuse. Public sign-up sets both from this phase on.
--
-- These are declarations, not verifications. Nothing here is KYC, a legal-name
-- check, or identity proof; `emailVerifiedAt` remains the only verification
-- marker on Account, and it proves control of the address only.

ALTER TABLE `Account`
  ADD COLUMN `firstName` VARCHAR(191) NULL,
  ADD COLUMN `lastName` VARCHAR(191) NULL;
