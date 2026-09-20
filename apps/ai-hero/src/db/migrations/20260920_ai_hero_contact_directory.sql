-- Contact-directory seed pages by createdAt. Additive and rerunnable.
SET @ddl_contact_created_at = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_Contact'
        AND INDEX_NAME = 'Contact_createdAt_idx'
    ),
    'SELECT ''Contact_createdAt_idx already exists'' AS skipped',
    'ALTER TABLE `AI_Contact` ADD INDEX `Contact_createdAt_idx` (`createdAt`)'
  )
);
PREPARE stmt FROM @ddl_contact_created_at;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
