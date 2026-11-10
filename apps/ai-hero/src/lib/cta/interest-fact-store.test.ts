import { describe, expect, it, vi } from 'vitest'

import { writeLocalInterestFact } from './interest-fact-store'

/** A drizzle-shaped fake: each select answers the next queued row set. */
function fakeDb(selects: unknown[][], insert = vi.fn().mockResolvedValue({})) {
	const queue = [...selects]
	const chain = () => {
		const step: any = {
			from: () => step,
			where: () => step,
			orderBy: () => step,
			limit: async () => queue.shift() ?? [],
		}
		return step
	}
	return {
		db: {
			select: vi.fn(chain),
			insert: vi.fn(() => ({ values: insert })),
		},
		insert,
	}
}

const args = {
	contactId: 'local-1',
	fieldKey: 'waitlist_c6' as const,
	at: '2026-10-29T12:00:00.000Z',
}

describe('writeLocalInterestFact', () => {
	it('an existing join answers its own time and writes nothing', async () => {
		const { db, insert } = fakeDb([
			[{ occurredAt: new Date('2026-10-01T00:00:00Z') }],
		])
		expect(await writeLocalInterestFact(db, args)).toEqual({
			status: 'existing',
			occurredAt: '2026-10-01T00:00:00.000Z',
		})
		expect(insert).not.toHaveBeenCalled()
	})

	it('a contact with no provider identity cannot hold a ContactEvent', async () => {
		const { db, insert } = fakeDb([[], []])
		expect(await writeLocalInterestFact(db, args)).toEqual({
			status: 'no-identity',
		})
		expect(insert).not.toHaveBeenCalled()
	})

	it('inserts one row keyed by contact and list, on the ai-hero identity first', async () => {
		const { db, insert } = fakeDb([
			[],
			[
				{ id: 'pi-kit', provider: 'kit' },
				{ id: 'pi-aihero', provider: 'ai-hero' },
			],
		])
		expect(await writeLocalInterestFact(db, args)).toEqual({
			status: 'inserted',
			occurredAt: args.at,
		})
		expect(insert).toHaveBeenCalledWith(
			expect.objectContaining({
				contactId: 'local-1',
				providerIdentityId: 'pi-aihero',
				provider: 'ai-hero',
				eventType: 'interest.expressed',
				providerReference: 'interest:waitlist_c6',
				semanticIdempotencyKey:
					'ai-hero:interest.expressed:local-1:waitlist_c6',
				occurredAt: new Date(args.at),
			}),
		)
		expect(JSON.stringify(insert.mock.calls)).not.toContain('@')
	})

	it('a concurrent join that won the unique key is the fact', async () => {
		const { db } = fakeDb(
			[
				[],
				[{ id: 'pi-kit', provider: 'kit' }],
				[{ occurredAt: new Date('2026-10-29T11:59:59Z') }],
			],
			vi.fn().mockRejectedValue(new Error('ER_DUP_ENTRY')),
		)
		expect(await writeLocalInterestFact(db, args)).toEqual({
			status: 'existing',
			occurredAt: '2026-10-29T11:59:59.000Z',
		})
	})
})
