CREATE TABLE `AI_CourseSyncPollState` (
  `bindingId` varchar(255) NOT NULL,
  `courseVersionId` varchar(255) NOT NULL,
  `providerRevision` varchar(255) NOT NULL,
  `status` varchar(32) NOT NULL,
  `consecutiveFailures` int NOT NULL DEFAULT 0,
  `controlPlaneRunId` varchar(255),
  `failureClass` varchar(100),
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`bindingId`)
);

CREATE TABLE `AI_CourseSyncPollLog` (
  `id` varchar(255) NOT NULL,
  `bindingId` varchar(255) NOT NULL,
  `courseVersionId` varchar(255) NOT NULL,
  `providerRevision` varchar(255) NOT NULL,
  `runId` varchar(255) NOT NULL,
  `controlPlaneRunId` varchar(255),
  `stage` varchar(32) NOT NULL,
  `outcome` varchar(32) NOT NULL,
  `failureClass` varchar(100),
  `metadata` json,
  `occurredAt` timestamp(3) NOT NULL,
  PRIMARY KEY (`id`),
  KEY `CourseSyncPollLog_version_time_idx` (`courseVersionId`, `occurredAt`),
  KEY `CourseSyncPollLog_run_time_idx` (`runId`, `occurredAt`)
);
