import { expect, it, vi } from 'vitest'
import { readUnsubscribedValuePathContactIds } from './drovr-value-path-birth-admission-live'

// The only stand-in is the database boundary. No Kit or network calls.
function database(rows: unknown[]) {
	const where = vi.fn(async () => rows)
	const from = vi.fn(() => ({ where }))
	const select = vi.fn((_fields: unknown) => ({ from }))
	// SAFETY: this stand-in implements the SELECT/from/where chain used by this reader.
	const db = { select } as unknown as NonNullable<
		Parameters<typeof readUnsubscribedValuePathContactIds>[1]
	>
	return { db, select, where }
}

it('uses the Kit import observation time, not its original signup, for cancelled state', async () => {
	const d = database([
		{
			contactId: 'c',
			eventType: 'kit.directory-imported',
			occurredAt: new Date('2025-01-01'),
			createdAt: new Date('2026-10-05T10:00:00Z'),
			identityEvidence: { state: 'cancelled', email: 'private@example.test' },
		},
		{
			contactId: 'c',
			eventType: 'contact.resubscribed',
			occurredAt: new Date('2026-10-04'),
			createdAt: new Date('2026-10-04'),
			identityEvidence: {},
		},
	])
	expect(await readUnsubscribedValuePathContactIds(['c'], d.db)).toEqual(['c'])
	expect(d.select).toHaveBeenCalledTimes(1)
	expect(Object.keys(d.select.mock.calls[0]?.[0] ?? {})).toEqual([
		'contactId',
		'eventType',
		'occurredAt',
		'createdAt',
		'identityEvidence',
	])
})

it('deduplicates contacts and bounds each local read to 500 ids', async () => {
	const d = database([])
	expect(await readUnsubscribedValuePathContactIds([], d.db)).toEqual([])
	expect(d.select).not.toHaveBeenCalled()
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
