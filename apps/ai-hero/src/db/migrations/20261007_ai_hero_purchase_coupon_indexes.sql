-- PlanetScale DR 44: already applied to production main on 2026-10-07.
-- Durable receipt for coupon-chain discovery and bulk-refund enumeration.
-- AI_Purchase's typed indexes are owned by @coursebuilder/adapter-drizzle's
-- getPurchaseSchema (src/lib/mysql/schemas/commerce/purchase.ts). That pinned
-- package is not edited here; its declarations need a separate owner update.
-- Run only through an approved schema deploy. No application startup DDL.
-- MySQL 8 does not support CREATE INDEX IF NOT EXISTS. Check the exact
-- single-column definition first; a conflicting same-name index fails closed.

SET @c5_bulk_index_present = (
  SELECT COUNT(*) = 1 AND MAX(COLUMN_NAME = 'bulkCouponId' AND SEQ_IN_INDEX = 1) = 1
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AI_Purchase'
    AND INDEX_NAME = 'idx_Purchase_on_bulkCouponId'
);
SET @c5_index_ddl = IF(@c5_bulk_index_present,
  'SELECT ''idx_Purchase_on_bulkCouponId already present'' AS migration_status',
  'CREATE INDEX idx_Purchase_on_bulkCouponId ON AI_Purchase (bulkCouponId)');
PREPARE c5_index_statement FROM @c5_index_ddl;
EXECUTE c5_index_statement;
DEALLOCATE PREPARE c5_index_statement;

SET @c5_redeemed_index_present = (
  SELECT COUNT(*) = 1 AND MAX(COLUMN_NAME = 'redeemedBulkCouponId' AND SEQ_IN_INDEX = 1) = 1
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'AI_Purchase'
    AND INDEX_NAME = 'idx_Purchase_on_redeemedBulkCouponId'
);
SET @c5_index_ddl = IF(@c5_redeemed_index_present,
  'SELECT ''idx_Purchase_on_redeemedBulkCouponId already present'' AS migration_status',
  'CREATE INDEX idx_Purchase_on_redeemedBulkCouponId ON AI_Purchase (redeemedBulkCouponId)');
PREPARE c5_index_statement FROM @c5_index_ddl;
EXECUTE c5_index_statement;
DEALLOCATE PREPARE c5_index_statement;
