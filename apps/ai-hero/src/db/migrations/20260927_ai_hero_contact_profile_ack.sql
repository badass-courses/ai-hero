-- Contact sync (2026-09-27): the version drovr last acknowledged.
--
--   AI_ContactProfileVersion.acknowledgedVersion
--     The profileVersion drovr fully accepted (a 200 batch with nothing
--     rejected or deferred). A live writer (signup, owner assignment, Kit
--     link, offer) skips its push when the content is unchanged AND this
--     equals the current version; a refused or failed push is not an
--     acknowledgement, so it is pushed again. The 15-min reconcile never
--     skips (one re-statement per contact per run keeps drovr's
--     confirmedAt moving).
--   AI_ContactProfileVersion.acknowledgedAt
--     When that acknowledgement was recorded.
--
-- Additive nullable columns on the table created by
-- 20260926_ai_hero_contact_sync.sql (PlanetScale DR #38; profileHash was
-- DR #40). No other change. Deployed code is unaffected (it neither reads
-- nor writes these columns).
--
-- Each ALTER is wrapped in an information_schema existence check so a rerun
-- no-ops instead of failing with ER_DUP_FIELDNAME.

SET @ddl_contact_profile_ack_version = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_ContactProfileVersion'
        AND COLUMN_NAME = 'acknowledgedVersion'
    ),
    'SELECT ''AI_ContactProfileVersion.acknowledgedVersion already exists'' AS skipped',
    'ALTER TABLE `AI_ContactProfileVersion` ADD COLUMN `acknowledgedVersion` bigint unsigned NULL AFTER `profileHash`'
  )
);
PREPARE stmt FROM @ddl_contact_profile_ack_version;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @ddl_contact_profile_ack_at = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_ContactProfileVersion'
        AND COLUMN_NAME = 'acknowledgedAt'
    ),
    'SELECT ''AI_ContactProfileVersion.acknowledgedAt already exists'' AS skipped',
    'ALTER TABLE `AI_ContactProfileVersion` ADD COLUMN `acknowledgedAt` timestamp(3) NULL AFTER `acknowledgedVersion`'
  )
);
PREPARE stmt FROM @ddl_contact_profile_ack_at;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
