-- Manual, additive migration. Do not apply until separately approved.
CREATE TABLE IF NOT EXISTS `AI_IntegrationToken` (
  `provider` varchar(32) NOT NULL,
  `ciphertext` text NOT NULL,
  `iv` varchar(24) NOT NULL,
  `authTag` varchar(24) NOT NULL,
  `keyVersion` int NOT NULL,
  `fingerprint` varchar(12) NOT NULL,
  `updatedAt` timestamp(3) NOT NULL,
  PRIMARY KEY (`provider`)
);
