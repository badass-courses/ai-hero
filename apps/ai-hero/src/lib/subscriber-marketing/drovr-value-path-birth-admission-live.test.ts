import { expect, it, vi } from 'vitest'
import { contactEvent } from '@/db/schema'
import { readUnsubscribedValuePathContactIds } from './drovr-value-path-birth-admission-live'

// The only stand-in is the database boundary. No Kit or network calls.
function database(rows: unknown[], importedStates: unknown[] = []) {
	const where = vi.fn(async () => rows)
	const from = vi.fn((table: unknown) => ({
		where: table === contactEvent ? where : vi.fn(async () => importedStates),
	}))
	const select = vi.fn((_fields: unknown) => ({ from }))
	// SAFETY: this stand-in implements the SELECT/from/where chain used by this reader.
	const db = { select } as unknown as NonNullable<
		Parameters<typeof readUnsubscribedValuePathContactIds>[1]
	>
	return { db, select, where }
}

it('reads only liftable ContactEvents, not stale imported Kit state', async () => {
	const d = database(
		[],
		[
			{
				contactId: 'c',
				subscriberState: 'cancelled',
				recordedAt: new Date('2026-10-05T10:00:00Z'),
			},
		],
	)
	expect(await readUnsubscribedValuePathContactIds(['c'], d.db)).toEqual([])
	expect(d.select).toHaveBeenCalledTimes(1)
	expect(Object.keys(d.select.mock.calls[0]?.[0] ?? {})).toEqual([
		'contactId',
		'eventType',
		'occurredAt',
	])
})

it('deduplicates contacts and bounds each local read to 500 ids', async () => {
	const d = database([])
	expect(await readUnsubscribedValuePathContactIds([], d.db)).toEqual([])
	expect(d.select).not.toHaveBeenCalled()
	await readUnsubscribedValuePathContactIds(
		[...Array.from({ length: 500 }, (_, i) => `c${i}`), 'c0'],
		d.db,
	)
	expect(d.select).toHaveBeenCalledTimes(1)
	d.select.mockClear()
	await readUnsubscribedValuePathContactIds(
		[...Array.from({ length: 501 }, (_, i) => `c${i}`), 'c0'],
		d.db,
	)
	expect(d.select).toHaveBeenCalledTimes(2)
})

it('a failed local read throws, never returns an empty allow decision', async () => {
	const d = database([])
	d.where.mockRejectedValue(new Error('read unavailable'))
	await expect(
		readUnsubscribedValuePathContactIds(['c'], d.db),
	).rejects.toThrow('read unavailable')
})
