-- Additive, applies after 20261126_ai_hero_coupon_batches.sql.
CREATE TABLE IF NOT EXISTS `AI_CouponBatchExportAudit` (
  `id` varchar(191) NOT NULL,
  `principalId` varchar(191) NOT NULL,
  `batchId` varchar(191) NOT NULL,
  `exportedAt` timestamp(3) NOT NULL,
  `codeCount` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `CouponBatchExportAudit_batch_time` (`batchId`,`exportedAt`)
);
