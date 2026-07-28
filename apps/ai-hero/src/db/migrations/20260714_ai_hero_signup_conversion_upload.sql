CREATE TABLE `AI_GoogleAdsSignupConversionUpload` (
  `id` varchar(255) NOT NULL,
  `contactId` varchar(255) NOT NULL,
  `conversionActionResourceName` varchar(255) NOT NULL,
  `clickIdType` varchar(20) NOT NULL,
  `clickIdHash` varchar(64) NOT NULL,
  `conversionDateTime` varchar(40) NOT NULL,
  `status` varchar(40) NOT NULL,
  `attemptCount` int NOT NULL DEFAULT 0,
  `idempotencyKey` varchar(500) NOT NULL,
  `requestSummary` json NOT NULL,
  `responseSummary` json NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `GoogleAdsSignupConversionUpload_idempotencyKey_uq` (`idempotencyKey`),
  KEY `GoogleAdsSignupConversionUpload_contactId_idx` (`contactId`),
  KEY `GoogleAdsSignupConversionUpload_status_idx` (`status`)
);
