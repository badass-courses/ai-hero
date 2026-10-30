import { readFileSync } from 'node:fs'
import { getTableConfig } from 'drizzle-orm/mysql-core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	columns: vi.fn(),
	names: vi.fn(),
	updateSet: vi.fn(),
	select: vi.fn(),
}))

vi.mock('@/server/logger', () => ({
	log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('@/db', async () => {
	const { informationSchemaColumns } =
		await import('@/db/device-access-token-client-name-schema')
	return {
		db: {
			select: (fields: unknown) => (
				mocks.select(fields),
				{
					from: (table: unknown) => ({
						where: () => {
							const rows =
								table === informationSchemaColumns
									? mocks.columns()
									: mocks.names()
							return Object.assign(Promise.resolve(rows), {
								limit: async () => rows,
							})
						},
					}),
				}
			),
			update: () => ({
				set: (values: unknown) => (
					mocks.updateSet(values),
					{ where: async () => undefined }
				),
			}),
		},
	}
})

import { deviceAccessTokenClientName } from '@/db/device-access-token-client-name-schema'
import { deviceAccessToken } from '@/db/schema'

import {
	clientNameColumnReady,
	clientNamesFor,
	recordClientName,
	resetClientNameDetection,
} from './client-name'

beforeEach(() => {
	vi.clearAllMocks()
	resetClientNameDetection()
})

describe('client name, before and after its migration', () => {
	it('reads and writes nothing until information_schema shows the column', async () => {
		mocks.columns.mockReturnValue([])
		await recordClientName('t1', 'Claude Code')
		expect(await clientNamesFor('u1', ['t1'])).toEqual(new Map())
		expect(mocks.updateSet).not.toHaveBeenCalled()
		expect(mocks.names).not.toHaveBeenCalled()
		// Not seen: checked once, then remembered for a while.
		expect(mocks.columns).toHaveBeenCalledTimes(1)
	})

	it('treats a failed detection as absent', async () => {
		mocks.columns.mockImplementation(() => {
			throw new Error('denied')
		})
		expect(await clientNameColumnReady()).toBe(false)
	})

	it('names the token once the column exists', async () => {
		mocks.columns.mockReturnValue([{ name: 'clientName' }])
		mocks.names.mockReturnValue([{ token: 't1', clientName: 'Claude Code' }])
		await recordClientName('t1', 'Claude Code')
		expect(mocks.updateSet).toHaveBeenCalledWith({ clientName: 'Claude Code' })
		expect(await clientNamesFor('u1', ['t1'])).toEqual(
			new Map([['t1', 'Claude Code']]),
		)
	})
})

describe('the clientName migration', () => {
	const migration = readFileSync(
		new URL(
			'../../../db/migrations/20261030_ai_hero_device_access_token_client_name.sql',
			import.meta.url,
		),
		'utf8',
	)

	it('adds one nullable column to the adapter table, guarded and rerunnable', () => {
		const view = getTableConfig(deviceAccessTokenClientName)
		const adapter = getTableConfig(deviceAccessToken)
		expect(view.name).toBe(adapter.name)
		const column = view.columns.find((entry) => entry.name === 'clientName')
		expect(column?.notNull).toBe(false)
		expect(migration).toContain(
			`ALTER TABLE \`AI_DeviceAccessToken\` ADD COLUMN \`clientName\` ${column?.getSQLType()} NULL AFTER \`scope\``,
		)
		expect(migration).toContain("COLUMN_NAME = 'clientName'")
		expect(migration.match(/ALTER TABLE/g)).toHaveLength(1)
		expect(migration).not.toMatch(
			/\b(DROP|RENAME|TRUNCATE|UPDATE|DELETE|INSERT|MODIFY|CHANGE)\b/i,
		)
	})

	it('keeps the adapter table free of the column until the migration lands', () => {
		expect(
			getTableConfig(deviceAccessToken).columns.map((entry) => entry.name),
		).not.toContain('clientName')
	})
})
