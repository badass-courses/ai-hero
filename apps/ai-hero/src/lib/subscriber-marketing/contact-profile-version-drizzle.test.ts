import { describe, expect, it, vi } from 'vitest'

import { createDrizzleContactProfileVersionStore } from './contact-profile-version-drizzle'

function database(row?: Record<string, unknown>) {
	const limit = vi.fn(async () => (row ? [row] : []))
	const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit }) }) }))
	const values = vi.fn(async () => undefined)
	const where = vi.fn(async () => ({ affectedRows: 1 }))
	const set = vi.fn((_values: unknown) => ({ where }))
	return {
		select,
		insert: () => ({ values }),
		update: () => ({ set }),
		values,
		set,
	}
}

const current = {
	version: '4',
	hash: 'hash-a',
	acknowledgedVersion: '4',
	updatedAt: '2026-09-26 16:00:00.000',
}

describe('drizzle contact profile version', () => {
	it.each([
		null,
		'2026-10-03 16:00:00.000',
		new Date('2026-10-03T16:00:00.000Z'),
	])(
		'returns the stored acknowledgement time %s in UTC',
		async (acknowledgedAt) => {
			const db = database({ ...current, acknowledgedAt })
			const store = createDrizzleContactProfileVersionStore(db)
			await expect(store.versionFor('c1', 'hash-a')).resolves.toEqual({
				profileVersion: 4,
				since: '2026-09-26T16:00:00.000Z',
				acknowledged: true,
				acknowledgedAt:
					acknowledgedAt === null ? null : '2026-10-03T16:00:00.000Z',
			})
			expect(db.select).toHaveBeenCalledWith(
				expect.objectContaining({ acknowledgedAt: expect.anything() }),
			)
		},
	)

	it('does not acknowledge new or changed content', async () => {
		for (const row of [undefined, { ...current, acknowledgedAt: null }]) {
			const db = database(row)
			const store = createDrizzleContactProfileVersionStore(db, {
				now: () => '2026-10-03T16:00:00.000Z',
			})
			await expect(store.versionFor('c1', 'hash-b')).resolves.toEqual({
				profileVersion: row ? 5 : 1,
				since: '2026-10-03T16:00:00.000Z',
				acknowledged: false,
				acknowledgedAt: null,
			})
		}
	})

	it('stamps acceptance of the same version without moving its since', async () => {
		const db = database({ ...current, acknowledgedAt: null })
		const store = createDrizzleContactProfileVersionStore(db, {
			now: () => '2026-10-03T16:00:00.000Z',
		})
		await store.acknowledge('c1', 4)
		expect(db.set).toHaveBeenCalledWith({
			acknowledgedVersion: 4,
			acknowledgedAt: '2026-10-03 16:00:00.000',
			updatedAt: expect.anything(),
		})
		expect(db.set.mock.calls[0]![0]).not.toHaveProperty('profileVersion')
	})
})
