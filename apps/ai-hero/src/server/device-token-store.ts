import { mysqlTable } from '@/db/mysql-table'
import { timestamp, varchar } from 'drizzle-orm/mysql-core'

/**
 * Insert-only mapping of the existing adapter table, including clientName.
 * Not exported from db/schema: this is not a schema change. Unlike the old
 * best-effort label update, a failed clientName write fails the entire mint.
 */
export const deviceAccessTokenForInsert = mysqlTable('DeviceAccessToken', {
	token: varchar('token', { length: 191 }).notNull().primaryKey(),
	userId: varchar('userId', { length: 191 }).notNull(),
	clientName: varchar('clientName', { length: 191 }).notNull(),
	scope: varchar('scope', { length: 191 }).notNull(),
	expiresAt: timestamp('expiresAt', { mode: 'date', fsp: 3 }).notNull(),
	revokedAt: timestamp('revokedAt', { mode: 'date', fsp: 3 }),
})
