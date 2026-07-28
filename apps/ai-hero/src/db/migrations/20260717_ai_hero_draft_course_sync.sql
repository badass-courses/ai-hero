CREATE TABLE `AI_CourseSyncBinding` (
  `bindingId` varchar(255) NOT NULL,
  `sourceCourseId` varchar(255) NOT NULL,
  `productId` varchar(255) NOT NULL,
  `anchorWorkshopId` varchar(255) NOT NULL,
  `status` varchar(32) NOT NULL,
  `binding` json NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`bindingId`),
  UNIQUE KEY `CourseSyncBinding_sourceCourseId_uq` (`sourceCourseId`),
  UNIQUE KEY `CourseSyncBinding_target_uq` (`productId`, `anchorWorkshopId`)
);

CREATE TABLE `AI_CourseSyncSourceRevision` (
  `sourceRevisionId` varchar(255) NOT NULL,
  `bindingId` varchar(255) NOT NULL,
  `courseVersionId` varchar(255) NOT NULL,
  `providerRevision` varchar(255) NOT NULL,
  `manifestSha256` varchar(64) NOT NULL,
  `manifestSnapshotUri` varchar(1000) NOT NULL,
  `manifest` json NOT NULL,
  `stagedAt` timestamp NOT NULL,
  PRIMARY KEY (`sourceRevisionId`),
  UNIQUE KEY `CourseSyncSourceRevision_binding_version_uq` (`bindingId`, `courseVersionId`),
  KEY `CourseSyncSourceRevision_binding_idx` (`bindingId`)
);

CREATE TABLE `AI_CourseSyncSourceRevisionAsset` (
  `sourceRevisionId` varchar(255) NOT NULL,
  `sourceVideoId` varchar(255) NOT NULL,
  `relativePath` varchar(1000) NOT NULL,
  `providerRevision` varchar(255) NOT NULL,
  `producerSha256` varchar(64) NOT NULL,
  `bytes` bigint NOT NULL,
  `snapshotUri` varchar(1000) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `CourseSyncSourceRevisionAsset_revision_video_uq` (`sourceRevisionId`, `sourceVideoId`),
  KEY `CourseSyncSourceRevisionAsset_revision_idx` (`sourceRevisionId`)
);

CREATE TABLE `AI_CourseSyncRun` (
  `runId` varchar(255) NOT NULL,
  `bindingId` varchar(255) NOT NULL,
  `sourceRevisionId` varchar(255) NOT NULL,
  `courseVersionId` varchar(255) NOT NULL,
  `state` varchar(32) NOT NULL,
  `stageIdempotencyKey` varchar(255) NOT NULL,
  `stageFingerprint` varchar(64) NOT NULL,
  `applyIdempotencyKey` varchar(255),
  `rollbackOfRunId` varchar(255),
  `compensatingRunId` varchar(255),
  `plan` json,
  `planSha256` varchar(64),
  `failureCode` varchar(100),
  `failureReason` text,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`runId`),
  UNIQUE KEY `CourseSyncRun_binding_stage_key_uq` (`bindingId`, `stageIdempotencyKey`),
  KEY `CourseSyncRun_binding_state_idx` (`bindingId`, `state`),
  KEY `CourseSyncRun_revision_idx` (`sourceRevisionId`)
);

CREATE TABLE `AI_CourseSyncRunResourceVersion` (
  `runId` varchar(255) NOT NULL,
  `resourceId` varchar(255) NOT NULL,
  `contentResourceVersionId` varchar(255) NOT NULL,
  `parentVersionId` varchar(255),
  `previousParentResourceId` varchar(255),
  `previousPosition` int,
  `action` varchar(16) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `CourseSyncRunResourceVersion_run_resource_uq` (`runId`, `resourceId`),
  KEY `CourseSyncRunResourceVersion_run_idx` (`runId`)
);
