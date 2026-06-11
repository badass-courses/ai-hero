-- AI Hero Google Ads offline conversion upload ledger.
-- Idempotent server-side upload state for click conversions. mysqlTable logical
-- names become AI_*.

CREATE TABLE `AI_GoogleAdsConversionUpload` (
  `id` varchar(255) NOT NULL,
  `purchaseId` varchar(255) NOT NULL,
  `conversionActionResourceName` varchar(255) NOT NULL,
  `clickIdType` varchar(20) NOT NULL,
  `clickIdHash` varchar(64) NOT NULL,
  `conversionDateTime` varchar(40) NOT NULL,
  `conversionValue` decimal(12,2) NOT NULL,
  `currencyCode` varchar(3) NOT NULL,
  `orderId` varchar(255) NOT NULL,
  `status` varchar(40) NOT NULL,
  `attemptCount` int NOT NULL DEFAULT 0,
  `idempotencyKey` varchar(500) NOT NULL,
  `requestSummary` json NOT NULL,
  `responseSummary` json,
  `lastError` json,
  `lastAttemptAt` timestamp NULL,
  `uploadedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `GoogleAdsConversionUpload_idempotencyKey_uq` (`idempotencyKey`),
  KEY `GoogleAdsConversionUpload_purchaseId_idx` (`purchaseId`),
  KEY `GoogleAdsConversionUpload_status_idx` (`status`),
  KEY `GoogleAdsConversionUpload_conversionAction_idx` (`conversionActionResourceName`)
);
