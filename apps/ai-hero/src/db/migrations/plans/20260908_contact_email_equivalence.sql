-- PLAN ONLY: apply through a separately approved safe migration, before deploying
-- schema/repository changes or running their live CLIs. Never run db:push.
-- Backfill with the exact JS v1 helper, atomically writing key/source using a
-- raw-byte CAS; preserve raw email and duplicate IDs. No SQL LOWER backfill.
-- Verify every row and both index plans before separately enabling observation.
ALTER TABLE AI_Contact
 ADD COLUMN emailKey varchar(67) CHARACTER SET ascii COLLATE ascii_bin NULL,
 ADD COLUMN emailKeySource varchar(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
 ADD COLUMN emailKeyStale int GENERATED ALWAYS AS (
CASE
 WHEN email IS NULL THEN CASE WHEN emailKey IS NULL AND emailKeySource IS NULL THEN 0 ELSE 1 END
 WHEN emailKey IS NULL OR emailKeySource IS NULL THEN 1
 WHEN OCTET_LENGTH(emailKey) <> 67 OR OCTET_LENGTH(emailKeySource) <> 64 THEN 1
 WHEN BINARY LEFT(emailKey, 3) <> BINARY 'v1:' THEN 1
 WHEN UNHEX(SUBSTRING(emailKey, 4)) IS NULL OR UNHEX(emailKeySource) IS NULL THEN 1
 WHEN BINARY SUBSTRING(emailKey, 4) <> BINARY LOWER(HEX(UNHEX(SUBSTRING(emailKey, 4)))) THEN 1
 WHEN BINARY emailKeySource <> BINARY LOWER(HEX(UNHEX(emailKeySource))) THEN 1
 WHEN BINARY emailKeySource <> BINARY SHA2(CAST(email AS BINARY), 256) THEN 1
 ELSE 0 END
 ) STORED,
 ADD INDEX Contact_emailKey_idx (emailKey),
 ADD INDEX Contact_emailKeyStale_idx (emailKeyStale);
