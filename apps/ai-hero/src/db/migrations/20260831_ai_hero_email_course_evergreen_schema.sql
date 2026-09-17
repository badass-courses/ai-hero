-- Dormant additive Email Course and Evergreen schema batch.
--
-- This migration performs no backfill, creates no enabled automation control,
-- and activates no runtime caller. Apply through one reviewed PlanetScale
-- deploy request before code depends on these structures.

CREATE TABLE IF NOT EXISTS `AI_EmailCourseCommit` (
  `runId` varchar(500) NOT NULL,
  `actorVersion` int unsigned NOT NULL,
  `stimulusId` varchar(500) NOT NULL,
  `snapshot` json NOT NULL,
  `decision` json NOT NULL,
  `events` json NOT NULL,
  `receipt` json NOT NULL,
  `decidedAt` timestamp(3) NOT NULL,
  `committedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`runId`, `actorVersion`),
  UNIQUE KEY `EmailCourseCommit_stimulusId_uq` (`stimulusId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `AI_AutomationControl` (
  `automationId` varchar(255) NOT NULL,
  `control` json NOT NULL,
  `updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`automationId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `AI_EvergreenOfferJourneyCommit` (
  `format` varchar(64) NOT NULL,
  `journeyId` varchar(500) NOT NULL,
  `actorVersion` int unsigned NOT NULL,
  `stimulusId` varchar(500) NOT NULL,
  `stimulusType` varchar(64) NOT NULL,
  `commitEvidence` json NOT NULL,
  `decision` json NOT NULL,
  `snapshot` json NOT NULL,
  `events` json NOT NULL,
  `receipt` json NOT NULL,
  `decidedAt` timestamp(3) NOT NULL,
  `committedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`journeyId`, `actorVersion`),
  UNIQUE KEY `EvergreenOfferJourneyCommit_stimulusId_uq` (`stimulusId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `AI_EvergreenOfferJourneyIntent` (
  `format` varchar(64) NOT NULL,
  `idempotencyKey` varchar(500) NOT NULL,
  `journeyId` varchar(500) NOT NULL,
  `originatingStimulusId` varchar(500) NOT NULL,
  `actorVersion` int unsigned NOT NULL,
  `ordinal` int unsigned NOT NULL,
  `intentType` varchar(64) NOT NULL,
  `intent` json NOT NULL,
  `status` varchar(32) NOT NULL,
  `availableAt` timestamp(3) NOT NULL,
  `settledByStimulusId` varchar(500) NULL,
  `settledAt` timestamp(3) NULL,
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`idempotencyKey`),
  UNIQUE KEY `EvergreenOfferJourneyIntent_journey_version_ordinal_uq` (`journeyId`, `actorVersion`, `ordinal`),
  KEY `EvergreenOfferJourneyIntent_journeyId_idx` (`journeyId`),
  KEY `EvergreenOfferJourneyIntent_status_availableAt_idx` (`status`, `availableAt`),
  KEY `EvergreenOfferJourneyIntent_originatingStimulus_idx` (`originatingStimulusId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE IF NOT EXISTS `AI_EvergreenOfferJourneyWake` (
  `format` varchar(64) NOT NULL,
  `wakeId` varchar(500) NOT NULL,
  `journeyId` varchar(500) NOT NULL,
  `originatingStimulusId` varchar(500) NOT NULL,
  `actorVersion` int unsigned NOT NULL,
  `ordinal` int unsigned NOT NULL,
  `purposeType` varchar(64) NOT NULL,
  `dueAt` timestamp(3) NOT NULL,
  `wake` json NOT NULL,
  `status` varchar(32) NOT NULL,
  `settledByStimulusId` varchar(500) NULL,
  `settledAt` timestamp(3) NULL,
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`wakeId`),
  UNIQUE KEY `EvergreenOfferJourneyWake_journey_version_ordinal_uq` (`journeyId`, `actorVersion`, `ordinal`),
  KEY `EvergreenOfferJourneyWake_journeyId_idx` (`journeyId`),
  KEY `EvergreenOfferJourneyWake_status_dueAt_idx` (`status`, `dueAt`),
  KEY `EvergreenOfferJourneyWake_originatingStimulus_idx` (`originatingStimulusId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

-- AI_SideEffectIntent nullable course ownership and due-time columns.
SET @ddl_side_effect_course_run_id = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_SideEffectIntent'
        AND COLUMN_NAME = 'courseRunId'
    ),
    'SELECT ''AI_SideEffectIntent.courseRunId already exists'' AS skipped',
    IF(
      EXISTS (
        SELECT 1 FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'AI_SideEffectIntent'
      ),
      'ALTER TABLE `AI_SideEffectIntent` ADD COLUMN `courseRunId` varchar(500) NULL AFTER `completedAt`',
      'SELECT ''AI_SideEffectIntent missing; courseRunId skipped'' AS skipped'
    )
  )
);
PREPARE stmt FROM @ddl_side_effect_course_run_id;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl_side_effect_available_at = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_SideEffectIntent'
        AND COLUMN_NAME = 'availableAt'
    ),
    'SELECT ''AI_SideEffectIntent.availableAt already exists'' AS skipped',
    IF(
      EXISTS (
        SELECT 1 FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'AI_SideEffectIntent'
      ),
      'ALTER TABLE `AI_SideEffectIntent` ADD COLUMN `availableAt` timestamp(3) NULL AFTER `courseRunId`',
      'SELECT ''AI_SideEffectIntent missing; availableAt skipped'' AS skipped'
    )
  )
);
PREPARE stmt FROM @ddl_side_effect_available_at;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl_side_effect_active_slot = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_SideEffectIntent'
        AND COLUMN_NAME = 'activeSlot'
    ),
    'SELECT ''AI_SideEffectIntent.activeSlot already exists'' AS skipped',
    IF(
      EXISTS (
        SELECT 1 FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'AI_SideEffectIntent'
      ),
      'ALTER TABLE `AI_SideEffectIntent` ADD COLUMN `activeSlot` varchar(32) NULL AFTER `availableAt`',
      'SELECT ''AI_SideEffectIntent missing; activeSlot skipped'' AS skipped'
    )
  )
);
PREPARE stmt FROM @ddl_side_effect_active_slot;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl_side_effect_due_index = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_SideEffectIntent'
        AND INDEX_NAME = 'SideEffectIntent_provider_type_status_availableAt_idx'
    ),
    'SELECT ''SideEffectIntent_provider_type_status_availableAt_idx already exists'' AS skipped',
    IF(
      EXISTS (
        SELECT 1 FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'AI_SideEffectIntent'
      ),
      'ALTER TABLE `AI_SideEffectIntent` ADD INDEX `SideEffectIntent_provider_type_status_availableAt_idx` (`provider`, `type`, `status`, `availableAt`)',
      'SELECT ''AI_SideEffectIntent missing; due index skipped'' AS skipped'
    )
  )
);
PREPARE stmt FROM @ddl_side_effect_due_index;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl_side_effect_active_slot_unique = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_SideEffectIntent'
        AND INDEX_NAME = 'SideEffectIntent_courseRun_activeSlot_uq'
    ),
    'SELECT ''SideEffectIntent_courseRun_activeSlot_uq already exists'' AS skipped',
    IF(
      EXISTS (
        SELECT 1 FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'AI_SideEffectIntent'
      ),
      'ALTER TABLE `AI_SideEffectIntent` ADD UNIQUE INDEX `SideEffectIntent_courseRun_activeSlot_uq` (`courseRunId`, `activeSlot`)',
      'SELECT ''AI_SideEffectIntent missing; active-slot index skipped'' AS skipped'
    )
  )
);
PREPARE stmt FROM @ddl_side_effect_active_slot_unique;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Bounded course.sequence-exhausted discovery. No parallel fact or payload
-- columns are added; semantic identity and payload stay on existing fields.
SET @ddl_contact_event_sequence_exhaustion_index = (
  SELECT IF(
    EXISTS (
      SELECT 1 FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_ContactEvent'
        AND INDEX_NAME = 'ContactEvent_eventType_occurredAt_id_idx'
    ),
    'SELECT ''ContactEvent_eventType_occurredAt_id_idx already exists'' AS skipped',
    IF(
      EXISTS (
        SELECT 1 FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'AI_ContactEvent'
      ),
      'ALTER TABLE `AI_ContactEvent` ADD INDEX `ContactEvent_eventType_occurredAt_id_idx` (`eventType`, `occurredAt`, `id`)',
      'SELECT ''AI_ContactEvent missing; sequence-exhaustion index skipped'' AS skipped'
    )
  )
);
PREPARE stmt FROM @ddl_contact_event_sequence_exhaustion_index;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
