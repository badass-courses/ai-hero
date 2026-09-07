-- Schema only. Production apply/backfill is a separately approved stopped gate.
-- Old initial journal rows remain readable, but block NEW admission until their
-- validated contact IDs are backfilled. Never choose a winner for duplicates.
ALTER TABLE `AI_EvergreenOfferJourneyCommit`
  ADD COLUMN `admissionContactId` varchar(500) NULL,
  ADD UNIQUE INDEX `EvergreenOfferJourneyCommit_admission_contact_uq` (`admissionContactId`),
  ADD INDEX `EvergreenOfferJourneyCommit_legacy_admission_idx` (`admissionContactId`, `actorVersion`);

CREATE TABLE `AI_EvergreenOfferJourneyAttempt` (
  `format` varchar(64) NOT NULL,
  `idempotencyKey` varchar(500) NOT NULL,
  `journeyId` varchar(500) NOT NULL,
  `claimToken` varchar(36) NOT NULL,
  `status` varchar(32) NOT NULL,
  `claimedAt` timestamp(3) NOT NULL,
  `leaseExpiresAt` timestamp(3) NOT NULL,
  `outcome` json NULL,
  PRIMARY KEY (`idempotencyKey`),
  UNIQUE KEY `EvergreenOfferJourneyAttempt_token_uq` (`claimToken`),
  KEY `EvergreenOfferJourneyAttempt_recovery_idx` (`status`, `leaseExpiresAt`, `idempotencyKey`)
);
