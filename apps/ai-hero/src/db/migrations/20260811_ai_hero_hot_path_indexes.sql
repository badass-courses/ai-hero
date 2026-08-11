-- Hot-path indexes for three unindexed full-table scans found in PlanetScale
-- query telemetry (24h window, 2026-08-11). All three reported index_usages={}
-- and read the whole table on every execution.
--
--   AI_Purchase (productId)
--     199,886 execs/day x 12,056 rows. `idx_Purchase_on_userId_status_productId`
--     cannot serve productId-only lookups (leftmost prefix rule). Call sites:
--     products/[productId]/availability, products/[productId]/enrollment,
--     event + product pricing pages, ads-operator.
--
--   AI_SideEffectIntent (provider, type)
--     3,561 execs/day x 57,873 rows. Every value-path reader filters
--     provider='kit' AND type='send-value-path-email'
--     (src/lib/subscriber-marketing/drizzle-capture-repository.ts).
--
--   AI_ShortlinkAttribution (shortlinkId, email, type)
--     2,495 execs/day x 49,173 rows. The signup dedupe check in
--     createShortlinkAttribution (src/lib/shortlinks-query.ts) filters
--     shortlinkId AND email AND type. The shortlinkId prefix also serves the
--     shortlink join in getShortlinkStats and the delete-by-shortlink cleanup.
--
-- Index-only, additive, no column or data changes. Deployed code is unaffected.
--
-- Each ALTER is wrapped in an information_schema existence check so a rerun
-- no-ops instead of failing with ER_DUP_KEYNAME. The plain equivalent of each
-- guard is the ALTER TABLE string inside it.

-- AI_Purchase (productId)
SET @ddl_purchase_product = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_Purchase'
        AND INDEX_NAME = 'idx_Purchase_on_productId'
    ),
    'SELECT ''idx_Purchase_on_productId already exists'' AS skipped',
    'ALTER TABLE `AI_Purchase` ADD INDEX `idx_Purchase_on_productId` (`productId`)'
  )
);
PREPARE stmt FROM @ddl_purchase_product;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- AI_SideEffectIntent (provider, type)
SET @ddl_intent_provider_type = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_SideEffectIntent'
        AND INDEX_NAME = 'SideEffectIntent_provider_type_idx'
    ),
    'SELECT ''SideEffectIntent_provider_type_idx already exists'' AS skipped',
    'ALTER TABLE `AI_SideEffectIntent` ADD INDEX `SideEffectIntent_provider_type_idx` (`provider`, `type`)'
  )
);
PREPARE stmt FROM @ddl_intent_provider_type;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- AI_ShortlinkAttribution (shortlinkId, email, type)
SET @ddl_attribution_lookup = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_ShortlinkAttribution'
        AND INDEX_NAME = 'ShortlinkAttribution_shortlink_email_type_idx'
    ),
    'SELECT ''ShortlinkAttribution_shortlink_email_type_idx already exists'' AS skipped',
    'ALTER TABLE `AI_ShortlinkAttribution` ADD INDEX `ShortlinkAttribution_shortlink_email_type_idx` (`shortlinkId`, `email`, `type`)'
  )
);
PREPARE stmt FROM @ddl_attribution_lookup;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
