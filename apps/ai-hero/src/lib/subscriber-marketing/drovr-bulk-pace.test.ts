import { afterEach, expect, it, vi } from 'vitest'
import { RetryAfterError } from 'inngest'
import {
	reserveBulkSlot,
	nextBulkSlot,
	runPacedSend,
	waitForBulkSlot,
	type BulkCursors,
	type BulkClass,
	type PaceStep,
} from './drovr-bulk-pace'

afterEach(() => {
	vi.useRealTimers()
})

function database(initial: BulkCursors = {}, timezone = '+00:00') {
	let cursor = JSON.stringify(initial)
	const query = vi.fn(async (sql: string, values?: unknown[]) => {
		if (sql.startsWith('SELECT `name`')) return [[{ name: 'existing' }]]
		if (sql.includes('FOR UPDATE')) return [[{ cursor, now: 1000, timezone }]]
		if (sql.startsWith('UPDATE')) cursor = String(values![0])
		return [[], []]
	})
	const connection = {
		query,
		beginTransaction: vi.fn(async () => {}),
		commit: vi.fn(async () => {}),
		rollback: vi.fn(async () => {}),
		release: vi.fn(),
	}
	const acquire = vi.fn(async () => connection)
	return { connection, acquire, query }
}
it('seeds once, asserts UTC and allocates future slots under an owned row lock', async () => {
	const db = database()
	const a = await reserveBulkSlot(db.acquire, 'pace_table', 'delta')
	const b = await reserveBulkSlot(db.acquire, 'pace_table', 'delta')
	expect(b - a).toBe(600)
	expect(
		db.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT `name`')),
	).toHaveLength(1)
	expect(
		db.query.mock.calls.filter(([sql]) => sql.includes('FOR UPDATE')),
	).toHaveLength(2)
	expect(
		db.query.mock.calls.filter(([sql]) => sql.startsWith('SET time_zone')),
	).toHaveLength(2)
	expect(
		db.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT')),
	).toHaveLength(0)
	expect(db.connection.commit).toHaveBeenCalledTimes(2)
})
it('a non-UTC clock or excessive lookahead cannot grant a POST slot', async () => {
	const wrong = database({}, 'SYSTEM')
	await expect(
		reserveBulkSlot(wrong.acquire, 'pace_table', 'delta'),
	).rejects.toThrow('BulkClock:')
	expect(wrong.connection.rollback).toHaveBeenCalledOnce()
	const far = database({ backfill: 1000000 })
	await expect(
		reserveBulkSlot(far.acquire, 'pace_table', 'backfill'),
	).rejects.toMatchObject({ name: 'RetryAfterError' })
	expect(far.query.mock.calls.some(([sql]) => sql.startsWith('UPDATE'))).toBe(
		false,
	)
	await expect(
		reserveBulkSlot(far.acquire, 'pace_table', 'delta'),
	).resolves.toBeTypeOf('number')
})
it('the production allocator keeps classes disjoint and protects deltas from a background backlog', () => {
	let cursors: BulkCursors = {}
	const slots: { at: number; kind: BulkClass }[] = []
	for (let index = 0; index < 90; index++) {
		const kind: BulkClass =
			index % 3 === 0 ? 'backfill' : index % 3 === 1 ? 'ingest' : 'restate'
		const next = nextBulkSlot(cursors, kind, 0)
		cursors = next.cursors
		slots.push({ at: next.slot, kind })
	}
	for (let index = 0; index < 120; index++) {
		const next = nextBulkSlot(cursors, 'delta', 0)
		cursors = next.cursors
		slots.push({ at: next.slot, kind: 'delta' })
	}
	expect(slots.find((row) => row.kind === 'delta')!.at).toBe(0)
	expect(new Set(slots.map((row) => row.at)).size).toBe(slots.length)
	for (const row of slots)
		expect(
			slots.filter((other) => other.at >= row.at && other.at < row.at + 60000)
				.length,
		).toBeLessThanOrEqual(100)
	expect(
		Object.fromEntries(
			(['delta', 'restate', 'ingest', 'backfill'] as BulkClass[]).map(
				(kind) => [
					kind,
					slots.filter((row) => row.kind === kind && row.at < 60000).length,
				],
			),
		),
	).toEqual({ delta: 60, restate: 20, ingest: 15, backfill: 5 })
	expect(() => nextBulkSlot({ delta: NaN }, 'delta', 0)).toThrow('BulkCursor:')
})
it('HTTP retries get fresh reservations and durable sleeps, while replay reuses memoized results without POSTing', async () => {
	vi.useFakeTimers()
	vi.setSystemTime(0)
	const memo = new Map<string, unknown>()
	let clock = 0
	const sleeps: number[] = []
	const step: PaceStep = {
		run: async (id, fn) => {
			if (!memo.has(id)) memo.set(id, await fn())
			return memo.get(id)
		},
		sleepUntil: async (_id, date) => {
			sleeps.push(date.getTime())
			clock = Math.max(clock, date.getTime())
			vi.setSystemTime(clock)
		},
	}
	const reserve = vi.fn(async (_kind: BulkClass = 'delta') => clock + 600)
	const pace = (id: string) => waitForBulkSlot(step, id, 'delta', reserve)
	const post = vi.fn(async (attempt: number) => {
		if (attempt === 0) throw new RetryAfterError('synthetic failure', 1000)
		return { accepted: 1 }
	})
	expect(await runPacedSend(step, 'event', pace, post)).toEqual({ accepted: 1 })
	expect(post).toHaveBeenCalledTimes(2)
	expect(reserve).toHaveBeenCalledTimes(2)
	expect(sleeps).toEqual([600, 1600, 2200])
	await runPacedSend(step, 'event', pace, post, 5)
	expect(post).toHaveBeenCalledTimes(2)
	expect(reserve).toHaveBeenCalledTimes(2)
})
