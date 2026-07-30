-- CreateTable
CREATE TABLE `PublicationWorkerRun` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `cycleId` VARCHAR(64) NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `workerOutcome` VARCHAR(24) NULL,
    `exitCode` INTEGER NULL,
    `maximumRuns` INTEGER NOT NULL,
    `runsAttempted` INTEGER NOT NULL DEFAULT 0,
    `itemsClaimed` INTEGER NOT NULL DEFAULT 0,
    `stoppedForNoWork` BOOLEAN NOT NULL DEFAULT false,
    `shutdownRequested` BOOLEAN NOT NULL DEFAULT false,
    `expiredClaimsExamined` INTEGER NOT NULL DEFAULT 0,
    `expiredClaimsRecovered` INTEGER NOT NULL DEFAULT 0,
    `expiredClaimsSkipped` INTEGER NOT NULL DEFAULT 0,
    `issueCodes` VARCHAR(1024) NOT NULL DEFAULT '',
    `startedAt` DATETIME(3) NOT NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `PublicationWorkerRun_cycleId_key`(`cycleId`),
    INDEX `PublicationWorkerRun_status_startedAt_idx`(`status`, `startedAt`),
    INDEX `PublicationWorkerRun_completedAt_idx`(`completedAt`),
    INDEX `PublicationWorkerRun_startedAt_idx`(`startedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
