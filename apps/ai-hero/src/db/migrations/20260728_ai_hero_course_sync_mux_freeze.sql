ALTER TABLE `AI_CourseSyncSourceRevision`
  MODIFY COLUMN `manifestSnapshotUri` varchar(1000) NULL;

ALTER TABLE `AI_CourseSyncSourceRevisionAsset`
  MODIFY COLUMN `snapshotUri` varchar(1000) NULL,
  ADD COLUMN `muxAssetId` varchar(255) NULL AFTER `snapshotUri`,
  ADD COLUMN `muxPlaybackId` varchar(255) NULL AFTER `muxAssetId`,
  ADD COLUMN `providerContentHash` varchar(255) NULL AFTER `muxPlaybackId`,
  ADD COLUMN `duration` double NULL AFTER `providerContentHash`,
  ADD KEY `CourseSyncSourceRevisionAsset_mux_asset_idx` (`muxAssetId`);
