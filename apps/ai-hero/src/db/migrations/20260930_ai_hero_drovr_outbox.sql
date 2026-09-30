-- AI Hero drovr outbox (row 204): ONE additive table, schema only.
--
-- Apply through a PlanetScale branch + deploy request, never directly against
-- production (aihero-support .brain/resources/aih-prod-db-migration-runbook.svx).
-- Rerunnable: the statement is guarded on existence, so a second apply is a
-- no-op. Nothing existing is altered or dropped.
--
-- Why: a drovr send that ran out of Inngest retries (a sustained drovr 5xx),
-- or a direct fallback post that drovr answered 5xx, was lost. It now lands
-- here, and drovr-outbox-replay re-posts it by its drovr idempotency key until
-- drovr answers 2xx (drovr dedupes a repeat). Rows for this deployment's own
-- target only (previews share this database). Delivered rows are deleted
-- after 7 days: the inline body can hold contact data.
--
-- The app tolerates the table being absent: the outbox write logs
-- drovr.outbox.unavailable and the caller keeps its previous behaviour. So the
-- code deploys first and this applies after.

SET @ddl_drovr_outbox = (
  SELECT IF(
    EXISTS (
      SELECT 1
      FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'AI_DrovrOutbox'
    ),
    'SELECT ''AI_DrovrOutbox already exists'' AS skipped',
    'CREATE TABLE `AI_DrovrOutbox` (
       `id` varchar(255) NOT NULL,
       `dedupeKey` varchar(64) NOT NULL,
       `target` varchar(255) NOT NULL,
       `endpoint` varchar(20) NOT NULL,
       `tenantId` varchar(100) NOT NULL,
       `contactId` varchar(255) NOT NULL,
       `journeyId` varchar(100) NOT NULL,
       `eventType` varchar(100) NOT NULL,
       `idempotencyKey` varchar(500) NOT NULL,
       `body` json NOT NULL,
       `needsFanOut` boolean NOT NULL DEFAULT false,
       `source` varchar(20) NOT NULL,
       `status` varchar(20) NOT NULL,
       `attempts` int NOT NULL DEFAULT 0,
       `lastStatus` int NULL,
       `lastError` varchar(1000) NULL,
       `occurredAt` timestamp(3) NOT NULL,
       `firstFailedAt` timestamp(3) NOT NULL,
       `nextAttemptAt` timestamp(3) NOT NULL,
       `lastAttemptAt` timestamp(3) NULL,
       `deliveredAt` timestamp(3) NULL,
       `releasedAt` timestamp(3) NULL,
       `createdAt` timestamp(3) NOT NULL,
       PRIMARY KEY (`id`),
       UNIQUE KEY `DrovrOutbox_dedupe_uq` (`dedupeKey`),
       KEY `DrovrOutbox_due_idx` (`status`, `target`, `nextAttemptAt`),
       KEY `DrovrOutbox_delivered_idx` (`status`, `deliveredAt`)
     ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci'
  )
);
PREPARE stmt FROM @ddl_drovr_outbox;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
