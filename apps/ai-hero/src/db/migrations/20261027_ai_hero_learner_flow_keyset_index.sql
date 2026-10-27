-- Learner-flow keyset read index (2026-10-27). Additive only: no column,
-- data, or query changes, so deployed code is unaffected.
--
--   AI_SideEffectIntent (provider, type, contactId): lets MySQL seek
--   (provider, type) and read contactId in order for the paged
--   SELECT DISTINCT contactId ... ORDER BY contactId LIMIT n.
--   AI_ContactEvent (eventType, contactId): range read on eventType in
--   contactId order for the ContactEvent twin of that query.
--
-- Applied through PlanetScale deploy request 51.
--
-- Wrapped in an information_schema existence check so a rerun no-ops.

SET @ddl_idx_0 = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_SideEffectIntent'
        AND INDEX_NAME = 'SideEffectIntent_provider_type_contactId_idx'
    ),
    'SELECT ''SideEffectIntent_provider_type_contactId_idx already exists'' AS skipped',
    'ALTER TABLE `AI_SideEffectIntent` ADD INDEX `SideEffectIntent_provider_type_contactId_idx` (`provider`, `type`, `contactId`)'
  )
);
PREPARE stmt FROM @ddl_idx_0;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl_idx_1 = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_ContactEvent'
        AND INDEX_NAME = 'ContactEvent_eventType_contactId_idx'
    ),
    'SELECT ''ContactEvent_eventType_contactId_idx already exists'' AS skipped',
    'ALTER TABLE `AI_ContactEvent` ADD INDEX `ContactEvent_eventType_contactId_idx` (`eventType`, `contactId`)'
  )
);
PREPARE stmt FROM @ddl_idx_1;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
