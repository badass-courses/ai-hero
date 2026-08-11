-- Second round of hot-path index work from PlanetScale query telemetry
-- (24h window, 2026-08-11), following 20260811_ai_hero_hot_path_indexes.sql.
--
--   AI_SideEffectIntent (provider, type, status)
--     The 5-minute value-path executor poll now filters
--     provider='kit' AND type='send-value-path-email' AND status IN
--     ('pending','failed') (drizzle-capture-repository.ts). With only the
--     (provider, type) index the engine still examines all ~65k matching
--     rows to evaluate status; ~64,873 of them are 'completed' and always
--     discarded. Extending the index with status turns the poll into a
--     ~15-row range read. The (provider, type) prefix serves every existing
--     two-column query, so the old index is dropped once the new one exists.
--
--   AI_ContactEvent (eventType, providerReference)
--     The value-path enrollment scan filters eventType='value-path.entered'
--     AND providerReference IN ('value-path:...') — 418 execs/day x 61,749
--     rows, index_usages={}, growing with event volume. Nothing serves it:
--     ContactEvent_providerReference_idx is (provider, providerEventId)
--     despite its name.
--
-- Additive index changes plus one redundant-index drop. No column or data
-- changes. Deployed code is unaffected.
--
-- Each statement is wrapped in an information_schema existence check so a
-- rerun no-ops instead of failing with ER_DUP_KEYNAME / ER_CANT_DROP_FIELD.

-- AI_SideEffectIntent (provider, type, status)
SET @ddl_intent_provider_type_status = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_SideEffectIntent'
        AND INDEX_NAME = 'SideEffectIntent_provider_type_status_idx'
    ),
    'SELECT ''SideEffectIntent_provider_type_status_idx already exists'' AS skipped',
    'ALTER TABLE `AI_SideEffectIntent` ADD INDEX `SideEffectIntent_provider_type_status_idx` (`provider`, `type`, `status`)'
  )
);
PREPARE stmt FROM @ddl_intent_provider_type_status;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Drop the now-redundant (provider, type) index; its prefix lives on in the
-- three-column index above. Guarded to run only when BOTH the new index
-- exists and the old one is still present.
SET @ddl_intent_drop_provider_type = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_SideEffectIntent'
        AND INDEX_NAME = 'SideEffectIntent_provider_type_status_idx'
    )
    AND EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_SideEffectIntent'
        AND INDEX_NAME = 'SideEffectIntent_provider_type_idx'
    ),
    'ALTER TABLE `AI_SideEffectIntent` DROP INDEX `SideEffectIntent_provider_type_idx`',
    'SELECT ''SideEffectIntent_provider_type_idx already dropped or replacement missing'' AS skipped'
  )
);
PREPARE stmt FROM @ddl_intent_drop_provider_type;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- AI_ContactEvent (eventType, providerReference)
SET @ddl_contact_event_type_reference = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_ContactEvent'
        AND INDEX_NAME = 'ContactEvent_eventType_providerReference_idx'
    ),
    'SELECT ''ContactEvent_eventType_providerReference_idx already exists'' AS skipped',
    'ALTER TABLE `AI_ContactEvent` ADD INDEX `ContactEvent_eventType_providerReference_idx` (`eventType`, `providerReference`)'
  )
);
PREPARE stmt FROM @ddl_contact_event_type_reference;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
