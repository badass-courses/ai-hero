-- Additive signed invoice link revocation counter.
-- Apply only on a PlanetScale development branch via a deploy request.
-- Main must show this column before deploying code that reads or rotates it.
-- The migration runner must SHOW COLUMNS first; skip this statement if present.
ALTER TABLE `InvoiceSettings` ADD COLUMN `linkVersion` INT UNSIGNED NOT NULL DEFAULT 1;
