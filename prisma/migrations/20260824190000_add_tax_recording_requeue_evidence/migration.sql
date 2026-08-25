-- Phase 1.8 — Tax recording operations: requeue evidence.
--
-- ADDITIVE ONLY. Two ADD COLUMN on the table Phase 1.7 created. Nothing is
-- dropped, renamed, or narrowed, no existing row is rewritten, and no committed
-- migration is modified. `requeueCount` takes a DEFAULT so existing rows are
-- correct without a backfill: a row nobody has requeued has been requeued zero
-- times.
--
-- WHY THESE COLUMNS ARE REQUIRED rather than convenient. A governed operator
-- requeue resets `attemptCount`, so the bounded retry schedule starts again
-- instead of immediately re-terminating. That reset would otherwise ERASE the
-- evidence that the work had already been tried eight times and abandoned.
-- `attemptCount` now says how far the CURRENT round has got; `requeueCount` says
-- how many rounds a human authorised, and `lastRequeuedAt` when the last one was.
--
-- A requeue is never an undo: it alters no sale-time fact, clears no failure
-- code, and is refused for failures a retry cannot fix — an expired calculation,
-- a duplicate provider reference, or a divergence between Monacado's own records.

-- AlterTable
ALTER TABLE `OrderTaxTransaction` ADD COLUMN `lastRequeuedAt` DATETIME(3) NULL,
    ADD COLUMN `requeueCount` INTEGER NOT NULL DEFAULT 0;

