import { beforeEach, expect, it, vi } from 'vitest'
import { MySqlDialect } from 'drizzle-orm/mysql-core'
import { reserveDrovrBulkSlot } from './drovr-bulk-pace'
import { BULK_EVENT_INTERVAL_MS } from './contact-sync-deltas'
const mocks = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@/db', () => ({ db: { execute: mocks.execute } }))
beforeEach(() => {
	mocks.execute.mockReset()
})

it('uses one conditional write and the database clock for every reservation', async () => {
	mocks.execute.mockResolvedValue({ rowsAffected: 1 })
	await reserveDrovrBulkSlot()
	const dialect = new MySqlDialect()
	const query = dialect.sqlToQuery(mocks.execute.mock.calls[1]![0])
	expect(query.sql).toContain(
		'SET `cursor` = CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000 + ? AS UNSIGNED)',
	)
	expect(query.sql).toContain(
		'CAST(`AI_ContactSyncCursor`.`cursor` AS UNSIGNED) <= UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3)) * 1000',
	)
	expect(query.params).toContain(BULK_EVENT_INTERVAL_MS)
})
it('a lost reservation or failed storage write never grants permission to post', async () => {
	mocks.execute.mockResolvedValue([{ affectedRows: 0 }])
	await expect(reserveDrovrBulkSlot()).rejects.toMatchObject({
		name: 'RetryAfterError',
	})
	mocks.execute.mockRejectedValue(new Error('synthetic unavailable store'))
	await expect(reserveDrovrBulkSlot()).rejects.toThrow(
		'synthetic unavailable store',
	)
})
it('understands the alternate driver result shape', async () => {
	mocks.execute.mockResolvedValue([{ affectedRows: 1 }])
	await expect(reserveDrovrBulkSlot()).resolves.toBeUndefined()
})
