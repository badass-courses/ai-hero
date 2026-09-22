-- AI Hero analytics reliability repair (schema only).
--
-- Additive and rerunnable. Apply through a PlanetScale branch/deploy request,
-- never directly against production. The app schema already reexports
-- DeviceAccessToken from @coursebuilder/adapter-drizzle; these columns bring
-- the existing production table in line with that installed adapter.

-- AI_DeviceAccessToken.scope: varchar(191) NULL
SET @ddl_device_access_token_scope = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_DeviceAccessToken'
        AND COLUMN_NAME = 'scope'
    ),
    'SELECT ''AI_DeviceAccessToken.scope already exists'' AS skipped',
    IF(
      EXISTS (
        SELECT 1
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'AI_DeviceAccessToken'
      ),
      'ALTER TABLE `AI_DeviceAccessToken` ADD COLUMN `scope` varchar(191) NULL AFTER `organizationMembershipId`',
      'SELECT ''AI_DeviceAccessToken missing; scope skipped'' AS skipped'
    )
  )
);
PREPARE stmt FROM @ddl_device_access_token_scope;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- AI_DeviceAccessToken.expiresAt: timestamp(3) NULL
SET @ddl_device_access_token_expires_at = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_DeviceAccessToken'
        AND COLUMN_NAME = 'expiresAt'
    ),
    'SELECT ''AI_DeviceAccessToken.expiresAt already exists'' AS skipped',
    IF(
      EXISTS (
        SELECT 1
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'AI_DeviceAccessToken'
      ),
      'ALTER TABLE `AI_DeviceAccessToken` ADD COLUMN `expiresAt` timestamp(3) NULL AFTER `createdAt`',
      'SELECT ''AI_DeviceAccessToken missing; expiresAt skipped'' AS skipped'
    )
  )
);
PREPARE stmt FROM @ddl_device_access_token_expires_at;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- AI_DeviceAccessToken.revokedAt: timestamp(3) NULL
SET @ddl_device_access_token_revoked_at = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_DeviceAccessToken'
        AND COLUMN_NAME = 'revokedAt'
    ),
    'SELECT ''AI_DeviceAccessToken.revokedAt already exists'' AS skipped',
    IF(
      EXISTS (
        SELECT 1
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'AI_DeviceAccessToken'
      ),
      'ALTER TABLE `AI_DeviceAccessToken` ADD COLUMN `revokedAt` timestamp(3) NULL AFTER `expiresAt`',
      'SELECT ''AI_DeviceAccessToken missing; revokedAt skipped'' AS skipped'
    )
  )
);
PREPARE stmt FROM @ddl_device_access_token_revoked_at;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- AI_ShortlinkClick (timestamp, shortlinkId)
-- The timestamp-leading order serves the bounded 30-day range before grouping
-- the matching rows by shortlink ID.
SET @ddl_shortlink_click_timestamp_shortlink_id = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_ShortlinkClick'
        AND INDEX_NAME = 'ShortlinkClick_timestamp_shortlinkId_idx'
    ),
    'SELECT ''ShortlinkClick_timestamp_shortlinkId_idx already exists'' AS skipped',
    IF(
      EXISTS (
        SELECT 1
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'AI_ShortlinkClick'
      ),
      'ALTER TABLE `AI_ShortlinkClick` ADD INDEX `ShortlinkClick_timestamp_shortlinkId_idx` (`timestamp`, `shortlinkId`)',
      'SELECT ''AI_ShortlinkClick missing; timestamp/shortlinkId index skipped'' AS skipped'
    )
  )
);
PREPARE stmt FROM @ddl_shortlink_click_timestamp_shortlink_id;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
