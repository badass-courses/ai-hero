import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	deleteExpiredAnonymousContentReadBatch,
	deleteExpiredAnonymousContentReads,
	getContentReadRetentionStart,
} from './content-read-retention'

type Row = {
	id: string
	contactId: string | null
	userId: string | null
	kitSubscriberId: string | null
	emailSha256: string | null
	occurredAt: number
	createdAt: number
}

const state = vi.hoisted(() => ({
	rows: [] as Row[],
	lastIds: [] as string[],
	selects: 0,
	after: null as number | null,
	afterBounds: [] as Array<number | null>,
	cutoffs: {} as Record<string, number>,
	deleteCreatedAtCutoffs: [] as number[],
}))

vi.mock('drizzle-orm', async (importOriginal) => {
	const actual = await importOriginal<typeof import('drizzle-orm')>()
	return {
		...actual,
		lt: (column: any, value: Date) => {
			state.cutoffs[column.name] = value.getTime()
			return actual.lt(column, value)
		},
		gte: (column: any, value: unknown) => {
			if (value instanceof Date) state.after = value.getTime()
			return actual.gte(column, value as any)
		},
	}
})

vi.mock('@/db', () => ({
	db: {
		select: () => ({
			from: () => ({
				where: () => ({
					orderBy: () => ({
						limit: async (n: number) => {
							state.selects++
							const after = state.after
							state.after = null
							state.afterBounds.push(after)
							const picked = [...state.rows]
								.sort((a, b) => a.occurredAt - b.occurredAt)
								.filter((r) => after === null || r.occurredAt >= after)
								.filter((r) => r.occurredAt < state.cutoffs.occurredAt!)
								.filter((r) => r.createdAt < state.cutoffs.createdAt!)
								.filter(
									(r) =>
										!r.contactId &&
										!r.userId &&
										!r.kitSubscriberId &&
										!r.emailSha256,
								)
								.slice(0, n)
							// Require the delete to apply its own createdAt guard again.
							delete state.cutoffs.createdAt
							state.lastIds = picked.map((r) => r.id)
							return picked.map((r) => ({
								id: r.id,
								occurredAt: new Date(r.occurredAt),
							}))
						},
					}),
				}),
			}),
		}),
		delete: () => ({
			where: async () => {
				state.deleteCreatedAtCutoffs.push(state.cutoffs.createdAt!)
				const ids = new Set(state.lastIds)
				const before = state.rows.length
				state.rows = state.rows.filter((r) => !ids.has(r.id))
				return { rowsAffected: before - state.rows.length }
			},
		}),
	},
}))

const fullSweepNow = new Date('1970-01-18T04:35:00Z')

describe('content read retention batching', () => {
	beforeEach(() => {
		state.rows = []
		state.lastIds = []
		state.selects = 0
		state.after = null
		state.afterBounds = []
		state.cutoffs = {}
		state.deleteCreatedAtCutoffs = []
	})

	it('deletes only anonymous rows; identity rows survive', async () => {
		state.rows = [
			row('a'),
			{ ...row('b'), userId: 'u1' },
			{ ...row('c'), emailSha256: 'x' },
			{ ...row('d'), contactId: 'c1' },
			{ ...row('e'), kitSubscriberId: 'k1' },
		]
		const res = await deleteExpiredAnonymousContentReadBatch({
			cutoff: new Date(),
			batchSize: 10,
		})
		expect(res).toEqual({
			selectedCount: 1,
			deletedCount: 1,
			lastOccurredAt: new Date(0).toISOString(),
		})
		expect(state.rows.map((r) => r.id)).toEqual(['b', 'c', 'd', 'e'])
	})

	it('loops until a short batch and sums deletedCount', async () => {
		state.rows = Array.from({ length: 25 }, (_, i) => row(`r${i}`))
		const res = await deleteExpiredAnonymousContentReads({
			now: fullSweepNow,
			batchSize: 10,
			maxBatches: 10,
		})
		expect(state.selects).toBe(3)
		expect(res.deletedCount).toBe(25)
		expect(res.mode).toBe('write')
		expect(state.rows).toHaveLength(0)
	})

	it('respects the batch cap', async () => {
		state.rows = Array.from({ length: 25 }, (_, i) => row(`r${i}`))
		const res = await deleteExpiredAnonymousContentReads({
			now: fullSweepNow,
			batchSize: 10,
			maxBatches: 2,
		})
		expect(state.selects).toBe(2)
		expect(res.deletedCount).toBe(20)
		expect(state.rows).toHaveLength(5)
	})

	it('carries the inclusive occurredAt cursor between full-sweep batches', async () => {
		state.rows = [
			{ ...row('i1', 1), userId: 'u1' },
			{ ...row('i2', 2), userId: 'u2' },
			row('a1', 3),
			row('a2', 4),
			row('a3', 4),
		]
		const res = await deleteExpiredAnonymousContentReads({
			now: fullSweepNow,
			batchSize: 2,
			maxBatches: 10,
		})
		expect(res.deletedCount).toBe(3)
		expect(state.afterBounds).toEqual([null, 4])
		expect(state.rows.map((r) => r.id)).toEqual(['i1', 'i2'])
	})

	it('bounds daily batches and recovers older leftovers on Sunday', async () => {
		const cutoff = Date.parse('2026-10-27T04:35:00Z')
		const start = Date.parse('2026-10-20T04:35:00Z')
		state.rows = [
			row('old-backlog', start - 1),
			row('at-start', start),
			row('inside-window', start + 1),
			row('same-timestamp', start + 1),
			{ ...row('identified', start), contactId: 'contact' },
			{ ...row('recently-created', start), createdAt: cutoff },
			row('at-cutoff', cutoff),
		]
		const daily = await deleteExpiredAnonymousContentReads({
			now: new Date('2026-11-10T04:35:00Z'),
			batchSize: 2,
		})
		expect(daily.deletedCount).toBe(3)
		expect(state.afterBounds).toEqual([start, start + 1])
		expect(state.deleteCreatedAtCutoffs).toEqual([cutoff, cutoff])
		expect(state.rows.map((r) => r.id)).toEqual([
			'old-backlog',
			'identified',
			'recently-created',
			'at-cutoff',
		])

		state.afterBounds = []
		const sweep = await deleteExpiredAnonymousContentReads({
			now: new Date('2026-11-15T04:35:00Z'),
		})
		expect(sweep.deletedCount).toBe(3)
		expect(state.afterBounds).toEqual([null])
		expect(state.rows.map((r) => r.id)).toEqual(['identified'])
	})

	it('keeps the default batch bounded to 1,000 rows', async () => {
		state.rows = Array.from({ length: 1001 }, (_, i) => row(`r${i}`))
		const res = await deleteExpiredAnonymousContentReadBatch({
			cutoff: new Date(),
		})
		expect(res.selectedCount).toBe(1000)
		expect(res.deletedCount).toBe(1000)
		expect(state.rows).toHaveLength(1)
	})
})

describe('content read retention window', () => {
	it.each([
		['2026-11-09T04:35:00Z', '2026-10-19T04:35:00Z'],
		['2026-11-10T04:35:00Z', '2026-10-20T04:35:00Z'],
		['2026-11-11T04:35:00Z', '2026-10-21T04:35:00Z'],
		['2026-11-12T04:35:00Z', '2026-10-22T04:35:00Z'],
		['2026-11-13T04:35:00Z', '2026-10-23T04:35:00Z'],
		['2026-11-14T04:35:00Z', '2026-10-24T04:35:00Z'],
	])('bounds the daily run on %s', (now, expected) => {
		const cutoff = new Date(now)
		cutoff.setUTCDate(cutoff.getUTCDate() - 14)
		expect(getContentReadRetentionStart(cutoff)?.toISOString()).toBe(new Date(expected).toISOString())
	})

	it('uses Sunday UTC and supports non-default retention days', () => {
		const cutoff = new Date('2026-11-08T00:00:00Z')
		expect(getContentReadRetentionStart(cutoff, 7)).toBeUndefined()
		expect(cutoff.toISOString()).toBe('2026-11-08T00:00:00.000Z')
		expect(
			getContentReadRetentionStart(new Date('2026-11-07T23:59:59Z'), 7)
				?.toISOString(),
		).toBe('2026-10-31T23:59:59.000Z')
	})
})

function row(id: string, occurredAt = 0): Row {
	return {
		id,
		contactId: null,
		userId: null,
		kitSubscriberId: null,
		emailSha256: null,
		occurredAt,
		createdAt: occurredAt,
	}
}
