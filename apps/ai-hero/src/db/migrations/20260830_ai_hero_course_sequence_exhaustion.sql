-- Review-only migration. Apply through a PlanetScale deploy request before enabling
-- AIH_COURSE_SEQUENCE_EXHAUSTION_V1_ENABLED.

ALTER TABLE `AI_ContactEvent`
  MODIFY COLUMN `occurredAt` timestamp(3) NOT NULL,
  ADD COLUMN `domainFactKey` varchar(500)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  ADD COLUMN `payloadFormat` varchar(64)
    CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  ADD COLUMN `domainPayload` json NULL,
  ADD UNIQUE KEY `ContactEvent_domainFactKey_uq` (`domainFactKey`),
  ADD KEY `ContactEvent_eventType_occurredAt_id_idx`
    (`eventType`, `occurredAt`, `id`);
