import { describe, expect, it } from 'vitest'
import { getTableConfig } from 'drizzle-orm/mysql-core'
import { deviceAccessToken } from '@/db/schema'
import { deviceAccessTokenClientName } from '@/db/device-access-token-client-name-schema'
import { deviceAccessTokenForInsert } from './device-token-store'

describe('atomic device token insert mapping', () => {
	it('targets the adapter table and includes the already-migrated label column', () => {
		const insert = getTableConfig(deviceAccessTokenForInsert)
		expect(insert.name).toBe(getTableConfig(deviceAccessToken).name)
		expect(insert.name).toBe(getTableConfig(deviceAccessTokenClientName).name)
		for (const name of ['scope', 'clientName', 'expiresAt']) {
			expect(
				insert.columns.find((column) => column.name === name)?.notNull,
			).toBe(true)
		}
	})
})
