-- AI Hero drovr held-continuation state: ONE additive nullable JSON column.
--
-- APPLY FIRST, before the contact-delta PR merges or its writers are enabled.
-- The desk applies this schema-only change through a PlanetScale branch and
-- deploy request. Do not execute directly against production.
-- No table, data backfill, wire-body rewrite, timestamp rewrite or default.
-- lastError remains varchar(1000), containing only the original error string.
--
-- Missing-column readers tolerate the old schema and log once. A writer that
-- cannot persist this column refuses to park: no ACK and no lastError fallback.
--
-- Apply once on the deploy-request branch; inspect the schema first. A second
-- application is an operator error, not an invitation to change existing data.
-- Rollback: DROP COLUMN heldContinuation loses its held operational state,
-- including coordination/pins/completion and replay handoff/claim proof.
-- It does not remove or
-- modify the original wire bodies, clocks or HTTP history. Drain, save and
-- cancel affected SDK work before rollback; dropping state is not a safe
-- cap-preserving automatic resume of old code.

ALTER TABLE `AI_DrovrOutbox`
  ADD COLUMN `heldContinuation` JSON NULL;
