import { mysqlTable } from '@/db/mysql-table'
import { int, text, timestamp, varchar } from 'drizzle-orm/mysql-core'

// Previews share the production DB. Provision the key in production only.
// Without the key, the store never imports the DB or reads/writes this table.
export const integrationToken = mysqlTable('IntegrationToken', {
	provider: varchar('provider', { length: 32 })
		.$type<'dropbox' | 'youtube_analytics'>()
		.notNull()
		.primaryKey(),
	ciphertext: text('ciphertext').notNull(),
	iv: varchar('iv', { length: 24 }).notNull(),
	authTag: varchar('authTag', { length: 24 }).notNull(),
	keyVersion: int('keyVersion').notNull(),
	fingerprint: varchar('fingerprint', { length: 12 }).notNull(),
	updatedAt: timestamp('updatedAt', { mode: 'date', fsp: 3 }).notNull(),
})
