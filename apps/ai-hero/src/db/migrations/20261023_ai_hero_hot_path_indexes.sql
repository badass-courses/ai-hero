-- Hot-path indexes for lookups that PlanetScale query insights showed
-- scanning without a usable index (2026-10-23). Index-only and additive:
-- no column or data changes, so deployed code is unaffected.
--
--   AI_Coupon (status, default, expires): default-coupon (sale) lookup: status + default + expires
--   AI_Entitlement (sourceId): entitlement lookups by sourceId without sourceType
--   AI_ContactEvent (providerEventId): contact event lookups by providerEventId without provider
--   AI_PurchaseUserTransfer (purchaseId): transfer lookups by purchaseId
--   AI_MerchantSession (identifier): merchant session lookups by identifier
--
-- Each ALTER is wrapped in an information_schema existence check so a rerun
-- no-ops instead of failing with ER_DUP_KEYNAME.

-- AI_Coupon (status, default, expires)
SET @ddl_idx_0 = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_Coupon'
        AND INDEX_NAME = 'Coupon_status_default_expires_idx'
    ),
    'SELECT ''Coupon_status_default_expires_idx already exists'' AS skipped',
    'ALTER TABLE `AI_Coupon` ADD INDEX `Coupon_status_default_expires_idx` (`status`, `default`, `expires`)'
  )
);
PREPARE stmt FROM @ddl_idx_0;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- AI_Entitlement (sourceId)
SET @ddl_idx_1 = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_Entitlement'
        AND INDEX_NAME = 'idx_Entitlement_on_sourceId'
    ),
    'SELECT ''idx_Entitlement_on_sourceId already exists'' AS skipped',
    'ALTER TABLE `AI_Entitlement` ADD INDEX `idx_Entitlement_on_sourceId` (`sourceId`)'
  )
);
PREPARE stmt FROM @ddl_idx_1;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- AI_ContactEvent (providerEventId)
SET @ddl_idx_2 = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_ContactEvent'
        AND INDEX_NAME = 'idx_ContactEvent_on_providerEventId'
    ),
    'SELECT ''idx_ContactEvent_on_providerEventId already exists'' AS skipped',
    'ALTER TABLE `AI_ContactEvent` ADD INDEX `idx_ContactEvent_on_providerEventId` (`providerEventId`)'
  )
);
PREPARE stmt FROM @ddl_idx_2;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- AI_PurchaseUserTransfer (purchaseId)
SET @ddl_idx_3 = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_PurchaseUserTransfer'
        AND INDEX_NAME = 'idx_PurchaseUserTransfer_on_purchaseId'
    ),
    'SELECT ''idx_PurchaseUserTransfer_on_purchaseId already exists'' AS skipped',
    'ALTER TABLE `AI_PurchaseUserTransfer` ADD INDEX `idx_PurchaseUserTransfer_on_purchaseId` (`purchaseId`)'
  )
);
PREPARE stmt FROM @ddl_idx_3;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- AI_MerchantSession (identifier)
SET @ddl_idx_4 = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_MerchantSession'
        AND INDEX_NAME = 'idx_MerchantSession_on_identifier'
    ),
    'SELECT ''idx_MerchantSession_on_identifier already exists'' AS skipped',
    'ALTER TABLE `AI_MerchantSession` ADD INDEX `idx_MerchantSession_on_identifier` (`identifier`)'
  )
);
PREPARE stmt FROM @ddl_idx_4;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
