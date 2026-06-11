-- AI Hero Subscriber Marketing Automation: Phase 1 Gate A durable shapes
-- Review-only. Do not apply automatically. mysqlTable logical names become AI_*.

CREATE TABLE `AI_Contact` (
  `id` varchar(255) NOT NULL,
  `userId` varchar(255),
  `email` varchar(255),
  `name` varchar(255),
  `lifecycle` varchar(50) NOT NULL DEFAULT 'new',
  `isProvisional` boolean NOT NULL DEFAULT true,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `Contact_userId_idx` (`userId`),
  KEY `Contact_email_idx` (`email`),
  KEY `Contact_lifecycle_idx` (`lifecycle`)
);

CREATE TABLE `AI_ProviderIdentity` (
  `id` varchar(255) NOT NULL,
  `contactId` varchar(255) NOT NULL,
  `provider` varchar(50) NOT NULL,
  `externalId` varchar(255) NOT NULL,
  `evidence` json NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ProviderIdentity_provider_externalId_uq` (`provider`, `externalId`),
  KEY `ProviderIdentity_contactId_idx` (`contactId`),
  KEY `ProviderIdentity_provider_idx` (`provider`)
);

CREATE TABLE `AI_ContactLink` (
  `id` varchar(255) NOT NULL,
  `contactId` varchar(255) NOT NULL,
  `userId` varchar(255) NOT NULL,
  `reason` varchar(255) NOT NULL,
  `evidence` json NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ContactLink_contact_user_uq` (`contactId`, `userId`),
  KEY `ContactLink_contactId_idx` (`contactId`),
  KEY `ContactLink_userId_idx` (`userId`)
);

CREATE TABLE `AI_ContactEvent` (
  `id` varchar(255) NOT NULL,
  `contactId` varchar(255) NOT NULL,
  `providerIdentityId` varchar(255) NOT NULL,
  `provider` varchar(50) NOT NULL,
  `providerEventId` varchar(255) NOT NULL,
  `providerReference` varchar(500) NOT NULL,
  `eventType` varchar(100) NOT NULL,
  `semanticIdempotencyKey` varchar(500) NOT NULL,
  `privacyLevel` varchar(50) NOT NULL,
  `identityEvidence` json NOT NULL,
  `payloadSummary` json NOT NULL,
  `schemaVersion` int NOT NULL,
  `occurredAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ContactEvent_semanticIdempotencyKey_uq` (`semanticIdempotencyKey`),
  KEY `ContactEvent_contactId_idx` (`contactId`),
  KEY `ContactEvent_providerIdentityId_idx` (`providerIdentityId`),
  KEY `ContactEvent_providerReference_idx` (`provider`, `providerEventId`),
  KEY `ContactEvent_occurredAt_idx` (`occurredAt`)
);

CREATE TABLE `AI_ContactState` (
  `id` varchar(255) NOT NULL,
  `contactId` varchar(255) NOT NULL,
  `lifecycle` varchar(50) NOT NULL,
  `primaryBucket` varchar(150) NOT NULL,
  `allBuckets` json NOT NULL,
  `whySignals` json NOT NULL,
  `whoSignals` json NOT NULL,
  `confidence` decimal(5,4) NOT NULL,
  `rationale` json NOT NULL,
  `reviewSignals` json NOT NULL,
  `humanReview` boolean NOT NULL DEFAULT false,
  `lastEventId` varchar(255) NOT NULL,
  `schemaVersion` int NOT NULL,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ContactState_contactId_uq` (`contactId`),
  KEY `ContactState_primaryBucket_idx` (`primaryBucket`),
  KEY `ContactState_lastEventId_idx` (`lastEventId`)
);

CREATE TABLE `AI_StateTransition` (
  `id` varchar(255) NOT NULL,
  `contactId` varchar(255) NOT NULL,
  `fromStateId` varchar(255),
  `toStateId` varchar(255) NOT NULL,
  `eventId` varchar(255) NOT NULL,
  `signals` json NOT NULL,
  `rationale` json NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `StateTransition_contactId_idx` (`contactId`),
  KEY `StateTransition_eventId_idx` (`eventId`),
  KEY `StateTransition_toStateId_idx` (`toStateId`)
);

CREATE TABLE `AI_NextAction` (
  `id` varchar(255) NOT NULL,
  `contactId` varchar(255) NOT NULL,
  `contactStateId` varchar(255) NOT NULL,
  `eventId` varchar(255) NOT NULL,
  `type` varchar(100) NOT NULL,
  `status` varchar(50) NOT NULL,
  `gates` json NOT NULL,
  `reviewReasons` json NOT NULL,
  `rationale` json NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `NextAction_contactId_idx` (`contactId`),
  KEY `NextAction_contactStateId_idx` (`contactStateId`),
  KEY `NextAction_eventId_idx` (`eventId`),
  KEY `NextAction_status_idx` (`status`)
);

CREATE TABLE `AI_SideEffectIntent` (
  `id` varchar(255) NOT NULL,
  `nextActionId` varchar(255) NOT NULL,
  `contactId` varchar(255) NOT NULL,
  `provider` varchar(50) NOT NULL,
  `type` varchar(100) NOT NULL,
  `status` varchar(50) NOT NULL,
  `idempotencyKey` varchar(500) NOT NULL,
  `gates` json NOT NULL,
  `reviewReasons` json NOT NULL,
  `metadata` json NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `SideEffectIntent_idempotencyKey_uq` (`idempotencyKey`),
  KEY `SideEffectIntent_nextActionId_idx` (`nextActionId`),
  KEY `SideEffectIntent_contactId_idx` (`contactId`),
  KEY `SideEffectIntent_status_idx` (`status`)
);
