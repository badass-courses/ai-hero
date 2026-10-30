import { mysqlTable } from '@/db/mysql-table'
import { mysqlSchema, varchar } from 'drizzle-orm/mysql-core'

// The adapter owns `AI_DeviceAccessToken`. This view adds only the nullable
// `clientName` column from 20261030_ai_hero_device_access_token_client_name.sql.
// Deliberately not exported from `schema.ts`: drizzle-kit must not see a
// second definition of the table, and nothing may read this column until
// `client-name.ts` has seen it in information_schema.
export const deviceAccessTokenClientName = mysqlTable('DeviceAccessToken', {
	token: varchar('token', { length: 191 }).notNull().primaryKey(),
	userId: varchar('userId', { length: 191 }).notNull(),
	clientName: varchar('clientName', { length: 191 }),
})

export const informationSchemaColumns = mysqlSchema('information_schema').table(
	'COLUMNS',
	{
		tableSchema: varchar('TABLE_SCHEMA', { length: 64 }),
		tableName: varchar('TABLE_NAME', { length: 64 }),
		columnName: varchar('COLUMN_NAME', { length: 64 }),
	},
)
