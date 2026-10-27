import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	deleteExpiredAnonymousContentReadBatch,
	deleteExpiredAnonymousContentReads,
} from './content-read-retention'

type Row = {
	id: string
	contactId: string | null
	userId: string | null
	kitSubscriberId: string | null
	emailSha256: string | null
	occurredAt: number
}

const state = vi.hoisted(() => ({
	rows: [] as any[],
	lastIds: [] as string[],
	selects: 0,
}))

vi.mock('@/db', () => ({
	db: {
		select: () => ({
			from: () => ({
				where: () => ({
					orderBy: () => ({
						limit: async (n: number) => {
							state.selects++
							const picked = state.rows
								.filter(
									(r) =>
										!r.contactId &&
										!r.userId &&
										!r.kitSubscriberId &&
										!r.emailSha256,
								)
								.slice(0, n)
								.map((r) => r.id)
							state.lastIds = picked
							return picked.map((id) => ({ id }))
						},
					}),
				}),
			}),
		}),
		delete: () => ({
			where: async () => {
				const ids = new Set(state.lastIds)
				const before = state.rows.length
				state.rows = state.rows.filter((r) => !ids.has(r.id))
				return { rowsAffected: before - state.rows.length }
			},
		}),
	},
}))

describe('content read retention batching', () => {
	beforeEach(() => {
		state.rows = []
		state.lastIds = []
		state.selects = 0
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
		expect(res).toEqual({ selectedCount: 1, deletedCount: 1 })
		expect(state.rows.map((r) => r.id)).toEqual(['b', 'c', 'd', 'e'])
	})

	it('loops until a short batch and sums deletedCount', async () => {
		state.rows = Array.from({ length: 25 }, (_, i) => row(`r${i}`))
		const res = await deleteExpiredAnonymousContentReads({
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
			batchSize: 10,
			maxBatches: 2,
		})
		expect(state.selects).toBe(2)
		expect(res.deletedCount).toBe(20)
		expect(state.rows).toHaveLength(5)
	})
})

function row(id: string): Row {
	return {
		id,
		contactId: null,
		userId: null,
		kitSubscriberId: null,
		emailSha256: null,
		occurredAt: 0,
	}
}
