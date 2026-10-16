import { describe, expect, it, vi } from 'vitest'
import {
	encodeHeldBatchContinuation,
	type HeldBatchContinuation,
} from './contact-sync-held-batch'
import { createDrizzleDrovrOutboxStore } from './drovr-outbox-drizzle'
import { encodeHeldContinuationEnvelope } from './drovr-outbox-control'

const clock = '2032-01-01T00:00:00.000Z'
const target = 'synthetic-purge-target'
const key = 'a'.repeat(64)
const member = { id: 'synthetic-delivered-member', target, dedupeKey: key }
function coordinator(completed = false) {
	const root: HeldBatchContinuation = {
		v: 1,
		target,
		anchorKey: key,
		source: 'contact-profile-sync',
		class: 'delta',
		originalClock: clock,
		parkedAt: clock,
		completion: completed
			? { state: 'completed', at: clock, reason: 'delivered' }
			: { state: 'unfinished' },
		attempt: 1,
		rejectedCarry: 0,
		release: { state: 'held' },
		members: [{ key, phase: 'pending', reason: 'event-not-live' }],
	}
	return {
		target,
		key,
		heldContinuation: encodeHeldContinuationEnvelope({
			v: 1,
			replayProof: { v: 1, handoffs: 0 },
			continuation: {
				v: 1,
				encoded: encodeHeldBatchContinuation(root),
				blocked: !completed,
			},
		}),
	}
}
function database(current: unknown[]) {
	// A new pin appears AFTER the nonlocking planning snapshot. The actual
	// transaction must use its later CURRENT locking read before deleting.
	const results: unknown[][] = [[], [member], current]
	const locks: string[] = []
	type Query = {
		from: () => Query
		where: () => Query
		orderBy: () => Query
		limit: () => Query
		for: (mode: string) => Query
		then: PromiseLike<unknown[]>['then']
	}
	const select = vi.fn(() => {
		const rows = results.shift()!
		const query: Query = {
			from: () => query,
			where: () => query,
			orderBy: () => query,
			limit: () => query,
			for: (mode: string) => {
				locks.push(mode)
				return query
			},
			then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
		}
		return query
	})
	const remove = vi.fn(() => ({
		where: vi.fn(async () => [{ affectedRows: 1 }]),
	}))
	const operations = {
		select,
		insert: vi.fn(),
		update: vi.fn(),
		delete: remove,
	}
	const db = {
		...operations,
		transaction: vi.fn(async <A>(run: (tx: typeof operations) => Promise<A>) =>
			run(operations),
		),
	}
	return { db, remove, locks }
}

describe('actual pin-aware purge control boundary (mocked queries, not SQL proof)', () => {
	it('a newly registered unfinished pin in the current read prevents actual deletion', async () => {
		const { db, remove, locks } = database([coordinator()])
		expect(
			await createDrizzleDrovrOutboxStore(db).deleteDeliveredBefore(
				'2032-01-10T00:00:00.000Z',
				500,
			),
		).toBe(0)
		expect(remove).not.toHaveBeenCalled()
		expect(locks).toEqual(['update', 'update'])
	})
	it('the completion marker permits the next normal purge pass', async () => {
		const { db, remove } = database([coordinator(true)])
		expect(
			await createDrizzleDrovrOutboxStore(db).deleteDeliveredBefore(
				'2032-01-10T00:00:00.000Z',
				500,
			),
		).toBe(1)
		expect(remove).toHaveBeenCalledOnce()
	})
	it('thirty-day expiry NEVER becomes silent deletion permission', async () => {
		const { db, remove } = database([coordinator()])
		expect(
			await createDrizzleDrovrOutboxStore(db).deleteDeliveredBefore(
				'2032-03-01T00:00:00.000Z',
				500,
			),
		).toBe(0)
		expect(remove).not.toHaveBeenCalled()
	})
	it('an invalid reserved coordinator refuses deletion, not a fresh seven-day fallback', async () => {
		const { db, remove } = database([
			{
				target,
				key,
				heldContinuation: { v: 999, continuation: { v: 1, blocked: true } },
			},
		])
		await expect(
			createDrizzleDrovrOutboxStore(db).deleteDeliveredBefore(
				'2032-01-10T00:00:00.000Z',
				500,
			),
		).rejects.toThrow(/purge is refused/)
		expect(remove).not.toHaveBeenCalled()
	})
})
