-- AI Hero contact sync: additive tables only (schema only).
--
-- Apply through a PlanetScale branch/deploy request, never directly against
-- production. Rerunnable: every statement is guarded on existence, so a
-- second apply is a no-op. Nothing existing is altered or dropped.
--
-- Why (contact sync, 2026-09-26): drovr stops calling
-- POST /api/drovr/personalize on every PostShiba send and keeps a synced
-- contact profile instead. That needs three durable facts in ai-hero:
--   1. AI_ValuePathLinkAnchor  - when an answer URL was FIRST issued, so the
--      same (contact, email) keeps one URL across sends and retries
--      (PostShiba rejects body drift on a retry). PR 1.
--   2. AI_ContactProfileVersion - the per-contact counter drovr orders
--      profile events by. PR 2.
--   3. AI_ContactSyncCursor    - the reconcile's watermark, advanced only
--      after drovr answers 2xx, plus its heartbeat. PR 3.
--
-- The app tolerates all three being absent: the link anchor falls back to the
-- previous dueAt + 30 day expiry, and the emitter and reconcile ship behind a
-- flag that is OFF. So this may be applied before or after the code deploys.

-- 1. The answer-URL first-issue anchor.
SET @ddl_value_path_link_anchor = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_ValuePathLinkAnchor'
    ),
    'SELECT ''AI_ValuePathLinkAnchor already exists'' AS skipped',
    -- anchorKey is one digest of the four key parts: those columns together
    -- exceed MySQL''s 3072-byte unique-index limit (caught on the branch).
    'CREATE TABLE `AI_ValuePathLinkAnchor` (
       `anchorKey` varchar(64) NOT NULL,
       `contactId` varchar(255) NOT NULL,
       `valuePathSlug` varchar(255) NOT NULL,
       `emailResourceId` varchar(255) NOT NULL,
       `fingerprint` varchar(64) NOT NULL,
       `issuedAt` timestamp(3) NOT NULL,
       `expiresAt` timestamp(3) NOT NULL,
       UNIQUE KEY `ValuePathLinkAnchor_anchor_uq` (`anchorKey`),
       KEY `ValuePathLinkAnchor_contact_idx` (`contactId`)
     ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
  )
);
PREPARE stmt FROM @ddl_value_path_link_anchor;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 2. The per-contact profile version drovr orders by (PR 2).
SET @ddl_contact_profile_version = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_ContactProfileVersion'
    ),
    'SELECT ''AI_ContactProfileVersion already exists'' AS skipped',
    'CREATE TABLE `AI_ContactProfileVersion` (
       `contactId` varchar(255) NOT NULL,
       `profileVersion` bigint unsigned NOT NULL DEFAULT 1,
       `updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       PRIMARY KEY (`contactId`)
     ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
  )
);
PREPARE stmt FROM @ddl_contact_profile_version;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- 3. The reconcile watermark and heartbeat (PR 3). One row per job name.
SET @ddl_contact_sync_cursor = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_ContactSyncCursor'
    ),
    'SELECT ''AI_ContactSyncCursor already exists'' AS skipped',
    'CREATE TABLE `AI_ContactSyncCursor` (
       `name` varchar(255) NOT NULL,
       `cursor` varchar(500) NOT NULL,
       `watermark` timestamp(3) NULL,
       `heartbeatAt` timestamp(3) NULL,
       `updatedAt` timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
       PRIMARY KEY (`name`)
     ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
  )
);
PREPARE stmt FROM @ddl_contact_sync_cursor;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
