CREATE TABLE IF NOT EXISTS `CourseSyncFrozenAssetReceipt` (
  `receiptKey` varchar(64) NOT NULL,
  `bindingId` varchar(255) NOT NULL,
  `courseVersionId` varchar(255) NOT NULL,
  `sourceVideoId` varchar(255) NOT NULL,
  `relativePath` varchar(1000) NOT NULL,
  `providerRevision` varchar(255) NOT NULL,
  `providerContentHash` varchar(255) DEFAULT NULL,
  `producerSha256` varchar(64) NOT NULL,
  `bytes` bigint NOT NULL,
  `snapshotUri` varchar(1000) DEFAULT NULL,
  `muxAssetId` varchar(255) NOT NULL,
  `muxPlaybackId` varchar(255) DEFAULT NULL,
  `duration` double DEFAULT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`receiptKey`),
  KEY `CourseSyncFrozenAssetReceipt_binding_asset_idx` (`bindingId`, `producerSha256`, `bytes`)
);
