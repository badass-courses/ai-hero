-- Contact sync (2026-09-26), PR 3: the reconcile's link rotation.
--
--   AI_ValuePathLinkAnchor (issuedAt)
--     Answer links re-issue every 90 days from their first issue
--     (value-path-link-anchor). Every 15 minutes the contact-sync reconcile
--     selects the anchors whose next 90-day boundary fell since its last
--     run, one issuedAt range per boundary, and republishes those
--     contacts' links. Without this index each range reads the whole table.
--
-- Additive index on a table created by 20260926_ai_hero_contact_sync.sql
-- (PlanetScale deploy request #38); nothing else reads that table yet. No
-- column or data changes. Deployed code is unaffected.
--
-- Wrapped in an information_schema existence check so a rerun no-ops
-- instead of failing with ER_DUP_KEYNAME.

SET @ddl_link_anchor_issued_at = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_ValuePathLinkAnchor'
        AND INDEX_NAME = 'ValuePathLinkAnchor_issuedAt_idx'
    ),
    'SELECT ''ValuePathLinkAnchor_issuedAt_idx already exists'' AS skipped',
    'ALTER TABLE `AI_ValuePathLinkAnchor` ADD INDEX `ValuePathLinkAnchor_issuedAt_idx` (`issuedAt`)'
  )
);
PREPARE stmt FROM @ddl_link_anchor_issued_at;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
