-- AI Hero learner MCP OAuth: name the client on a learner token.
--
-- Additive and rerunnable. Apply through a PlanetScale branch and deploy
-- request, after its own approval, never directly against production.
-- The app works before this column exists: it checks information_schema
-- and skips the client name until the column is there
-- (src/lib/learner-agent/oauth/client-name.ts).

-- AI_DeviceAccessToken.clientName: varchar(191) NULL
SET @ddl_device_access_token_client_name = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_DeviceAccessToken'
        AND COLUMN_NAME = 'clientName'
    ),
    'SELECT ''AI_DeviceAccessToken.clientName already exists'' AS skipped',
    IF(
      EXISTS (
        SELECT 1
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'AI_DeviceAccessToken'
      ),
      'ALTER TABLE `AI_DeviceAccessToken` ADD COLUMN `clientName` varchar(191) NULL AFTER `scope`',
      'SELECT ''AI_DeviceAccessToken missing; clientName skipped'' AS skipped'
    )
  )
);
PREPARE stmt FROM @ddl_device_access_token_client_name;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
