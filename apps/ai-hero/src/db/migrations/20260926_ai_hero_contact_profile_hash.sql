-- Contact sync (2026-09-26), PR 3: a content-addressed profile version.
--
--   AI_ContactProfileVersion.profileHash
--     sha256 of what the last sync pushed at this version (profile, link
--     windows and variables, offers). The version moves only when the hash
--     changes; an unchanged contact is re-sent under the same version, keys
--     and body, which drovr dedupes. Without it, every reconcile re-push
--     (the 1 h overlap) would mint a new version and a new drovr fold.
--
-- Additive nullable column on a table created by
-- 20260926_ai_hero_contact_sync.sql (PlanetScale deploy request #38);
-- nothing reads the table yet (the sync is behind AIH_DROVR_PROFILE_SYNC,
-- off). No other change. Deployed code is unaffected.
--
-- Wrapped in an information_schema existence check so a rerun no-ops
-- instead of failing with ER_DUP_FIELDNAME.

SET @ddl_contact_profile_hash = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_ContactProfileVersion'
        AND COLUMN_NAME = 'profileHash'
    ),
    'SELECT ''AI_ContactProfileVersion.profileHash already exists'' AS skipped',
    'ALTER TABLE `AI_ContactProfileVersion` ADD COLUMN `profileHash` varchar(64) NULL AFTER `profileVersion`'
  )
);
PREPARE stmt FROM @ddl_contact_profile_hash;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
