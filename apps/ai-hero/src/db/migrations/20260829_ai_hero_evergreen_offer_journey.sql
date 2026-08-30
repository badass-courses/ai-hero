-- Review-only migration. Apply through a PlanetScale deploy request before runtime wiring.

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
  `settledByStimulusId` varchar(500) NULL,
  `settledAt` timestamp(3) NULL,
  `createdAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`idempotencyKey`),
  UNIQUE KEY `EvergreenOfferJourneyIntent_journey_version_ordinal_uq` (`journeyId`, `actorVersion`, `ordinal`),
  KEY `EvergreenOfferJourneyIntent_journeyId_idx` (`journeyId`),
  KEY `EvergreenOfferJourneyIntent_status_idx` (`status`),
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
