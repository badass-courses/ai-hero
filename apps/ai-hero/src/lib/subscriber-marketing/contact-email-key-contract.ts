/** Change together with generated-column DDL and every writer/backfill.
 * A new hash input alone cannot invalidate hidden old-version rows. */
export const CONTACT_EMAIL_KEY_PREFIX = 'v1:'
export const CONTACT_EMAIL_KEY_DOMAIN = 'aih:contact-email:v1'
export const CONTACT_EMAIL_KEY_LENGTH = 67

// Remove only exact lowercase hex characters. Unlike UNHEX, REPLACE does not
// throw for malformed input in a generated column. Arguments are fixed columns.
const hexRemainder = (expression: string): string =>
	Array.from('0123456789abcdef').reduce(
		(value, digit) => `REPLACE(${value}, '${digit}', '')`,
		expression,
	)

/** Total raw-byte integrity predicate, NOT a SQL implementation of JS casing.
 * Explicit NULL branches prevent SQL UNKNOWN escaping the global stale guard. */
export const CONTACT_EMAIL_STALE_SQL = `CASE
 WHEN email IS NULL THEN CASE WHEN emailKey IS NULL AND emailKeySource IS NULL THEN 0 ELSE 1 END
 WHEN emailKey IS NULL OR emailKeySource IS NULL THEN 1
 WHEN OCTET_LENGTH(emailKey) <> ${CONTACT_EMAIL_KEY_LENGTH} OR OCTET_LENGTH(emailKeySource) <> 64 THEN 1
 WHEN BINARY LEFT(emailKey, 3) <> BINARY '${CONTACT_EMAIL_KEY_PREFIX}' THEN 1
 WHEN OCTET_LENGTH(${hexRemainder('SUBSTRING(emailKey, 4)')}) <> 0 THEN 1
 WHEN OCTET_LENGTH(${hexRemainder('emailKeySource')}) <> 0 THEN 1
 WHEN BINARY emailKeySource <> BINARY SHA2(CAST(email AS BINARY), 256) THEN 1
 ELSE 0 END`
