-- Phase 1.17 -- governed participant terminal closure.
--
-- ADDITIVE. One new table. NOT ONE existing column altered or dropped, and no
-- stored value rewritten.
--
-- WHAT WAS WRONG. `CLOSED` was the last participant status write with no
-- governance at all. `advanceParticipantStatus` gates on the TARGET status only,
-- and `CLOSED` sat in `DRAFT_WRITABLE_PARTICIPANT_STATUSES` on a 0M.5 ground
-- that was true of a draft and not of the function: the 0M.1 table reaches
-- `CLOSED` from `ACTIVE`, `RESTRICTED`, `SUSPENDED`, and `UNDER_REVIEW` as well.
-- So any caller could irreversibly close an admitted, restricted, or suspended
-- participant with no acting account, no authorization, no reason, and no record
-- of who did it or why -- while every other act in this subsystem (restrict,
-- suspend, reinstate, lift, decide) carried an actor, an entitlement, an
-- evidence row, and a notice. The ungoverned act was the irreversible one.
--
-- WHOSE ACT CLOSURE IS, AND WHY THERE IS NO STAFF CLOSURE HERE. The repository
-- has ruled on this three times and never implemented it: 0M.5 admitted `CLOSED`
-- to the draft-writable set because "it is the participant giving up, not
-- Monacado ruling"; 0M.8 refuses to produce `CLOSED` from a `REJECTED`
-- activation because "inventing a closure on Monacado's behalf would end an
-- admission the participant may legitimately resubmit"; and 1.14 names closure
-- as categorically not a suspension. Marketplace Policy 1.3.0 -- which governs
-- restriction and suspension in detail -- nowhere gives Monacado the power to
-- end a participant's participation. A `participant:close` entitlement would
-- therefore be an authority strictly wider than `participant:suspend`,
-- irreversible where suspension is reversible, and written by this migration
-- rather than by any term Monacado has published. It is not created.
--
-- Authorization is OWNERSHIP instead: `closedByAccountId` must equal the
-- participant's own `MarketplaceParticipant.accountId`, which is already
-- `@unique`. That is the same check `requestReconsideration` makes for the
-- participant's own act, so this introduces no second notion of ownership.
--
-- WHY A TABLE AND NOT COLUMNS ON `MarketplaceParticipant`. A closure needs an
-- identity of its own because the notification obligation is keyed on the
-- DECISION, never on the participant -- `notificationObligationKey` hashes
-- recipient, category, subject, and context, and using the participant as
-- subject is the collision the participant-decision notices were written to
-- avoid. `ParticipantActivation` cannot host it either: its decision vocabulary
-- is APPROVED | MORE_INFORMATION_REQUIRED | REJECTED, and 0M.8 explicitly
-- refuses to let a review produce a closure.
--
-- WHAT CLOSURE DOES NOT TOUCH, and this table's shape is the proof: there is no
-- column here that lifts, reinstates, deletes, or releases anything. Standing
-- `ParticipantRestriction` and `ParticipantSuspension` rows keep `status =
-- 'ACTIVE'`, which is the true statement -- the decision stood when
-- participation ended and was never withdrawn. Marking them `LIFTED` would have
-- required choosing a lift reason from a vocabulary in which every member is a
-- false statement about a closure, and naming an account as having lifted them
-- when nobody did.

-- CreateTable
CREATE TABLE `ParticipantClosure` (
    `id` VARCHAR(191) NOT NULL,
    `participantId` VARCHAR(191) NOT NULL,
    `closedByAccountId` VARCHAR(191) NOT NULL,
    `reasonCode` VARCHAR(48) NOT NULL,
    `statusBeforeClosure` VARCHAR(24) NOT NULL,
    `closedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `ParticipantClosure_participantId_key`(`participantId`),
    INDEX `ParticipantClosure_closedAt_idx`(`closedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `ParticipantClosure` ADD CONSTRAINT `ParticipantClosure_participantId_fkey` FOREIGN KEY (`participantId`) REFERENCES `MarketplaceParticipant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
