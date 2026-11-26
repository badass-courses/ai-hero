-- Additive desk coupon-batch ledger. Apply via a reviewed schema deploy request.
-- No rollout or grant is implicit: without an enabled AI_CouponBatchControl row,
-- admission and queued minting fail closed. All seven tables use InnoDB.
CREATE TABLE IF NOT EXISTS `AI_CouponBatchControl` (
  `id` varchar(191) NOT NULL,
  `enabled` int NOT NULL DEFAULT 0,
  `chunkSize` int NOT NULL DEFAULT 100,
  `paceMs` int NOT NULL DEFAULT 250,
  `nextChunkAt` timestamp(3) NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `AI_CouponBatchGrant` (
  `principalId` varchar(191) NOT NULL,
  `canMint` int NOT NULL DEFAULT 0,
  `canRead` int NOT NULL DEFAULT 0,
  PRIMARY KEY (`principalId`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `AI_CouponBatch` (
  `id` varchar(191) NOT NULL,
  `principalId` varchar(191) NOT NULL,
  `credentialId` varchar(191) NOT NULL,
  `requestKey` varchar(64) NOT NULL,
  `fingerprint` varchar(64) NOT NULL,
  `itemFingerprint` varchar(64) NOT NULL,
  `campaignHash` varchar(64) NOT NULL,
  `templateId` varchar(32) NOT NULL,
  `policyRevision` varchar(16) NOT NULL,
  `deadlineAt` timestamp(3) NOT NULL,
  `acceptedAt` timestamp(3) NOT NULL,
  `acceptedDay` varchar(10) NOT NULL,
  `finishedAt` timestamp(3) NULL,
  `exportUntil` timestamp(3) NOT NULL,
  `total` int NOT NULL,
  `processed` int NOT NULL DEFAULT 0,
  `minted` int NOT NULL DEFAULT 0,
  `refused` int NOT NULL DEFAULT 0,
  `newIntents` int NOT NULL DEFAULT 0,
  `newMints` int NOT NULL DEFAULT 0,
  `requestAlarm` int NOT NULL DEFAULT 0,
  `dailyAlarm` int NOT NULL DEFAULT 0,
  `attempts` int NOT NULL DEFAULT 0,
  `nextAttemptAt` timestamp(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `CouponBatch_queue` (`finishedAt`,`nextAttemptAt`,`acceptedAt`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `AI_CouponBatchItem` (
  `batchId` varchar(191) NOT NULL,
  `ordinal` int NOT NULL,
  `intentKey` varchar(128) NOT NULL,
  `intentId` varchar(64) NOT NULL,
  `result` varchar(48),
  PRIMARY KEY (`batchId`,`ordinal`),
  KEY `CouponBatchItem_lookup` (`intentId`,`batchId`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `AI_CouponBatchIntent` (
  `id` varchar(64) NOT NULL,
  `principalId` varchar(191) NOT NULL,
  `fingerprint` varchar(64) NOT NULL,
  `couponRef` varchar(191),
  `sealedCode` varchar(191),
  `expiresAt` timestamp(3) NOT NULL,
  `exportUntil` timestamp(3) NOT NULL,
  `refused` varchar(48),
  PRIMARY KEY (`id`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `AI_CouponBatchDay` (
  `day` varchar(10) NOT NULL,
  `intents` int NOT NULL,
  `mints` int NOT NULL,
  PRIMARY KEY (`day`)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS `AI_CouponBatchAlert` (
  `id` varchar(191) NOT NULL,
  `batchId` varchar(191) NOT NULL,
  `kind` varchar(16) NOT NULL,
  `count` int NOT NULL,
  `threshold` int NOT NULL,
  `loggedAt` timestamp(3) NULL,
  `deliveredAt` timestamp(3) NULL,
  `attempts` int NOT NULL DEFAULT 0,
  `nextAttemptAt` timestamp(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `CouponBatchAlert_due` (`deliveredAt`,`nextAttemptAt`)
) ENGINE=InnoDB;
