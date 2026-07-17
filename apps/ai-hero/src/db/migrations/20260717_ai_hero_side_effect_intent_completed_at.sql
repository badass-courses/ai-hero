-- Canonical completion fact for course value-path side-effect intents.
--
-- Cutover order:
--   1. Apply this additive migration through a PlanetScale deploy request.
--   2. Deploy readers that prefer this column and fall back to the legacy
--      metadata.completedAt stamp.
--   3. Deploy the atomic writer (column + legacy stamp in one update).
--   4. After the both-read window is verified, remove the metadata fallback.
--
-- The nullable default keeps old application code safe between steps 1 and 2.

ALTER TABLE `AI_SideEffectIntent`
  ADD COLUMN `completedAt` timestamp(3) NULL DEFAULT NULL
  AFTER `status`;

-- Backfill valid legacy ISO timestamps. Rows without trustworthy completion
-- evidence remain NULL and are surfaced by the operator backfill receipt.
UPDATE `AI_SideEffectIntent`
SET `completedAt` = STR_TO_DATE(
  REPLACE(
    REPLACE(JSON_UNQUOTE(JSON_EXTRACT(`metadata`, '$.completedAt')), 'T', ' '),
    'Z',
    ''
  ),
  '%Y-%m-%d %H:%i:%s.%f'
)
WHERE `completedAt` IS NULL
  AND JSON_TYPE(JSON_EXTRACT(`metadata`, '$.completedAt')) = 'STRING'
  AND JSON_UNQUOTE(JSON_EXTRACT(`metadata`, '$.completedAt'))
    REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$';
