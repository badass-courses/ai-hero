import { describe, expect, it, vi } from 'vitest'

import {
	holdPendingInterestFact,
	PENDING_INTEREST_TTL_SECONDS,
	pendingInterestKey,
	releasePendingInterestFact,
	type PendingInterestRow,
	type PendingInterestStore,
} from './interest-fact-pending'

/** Upstash-shaped: set with nx answers null when the key exists. */
function fakeStore() {
	const rows = new Map<string, PendingInterestRow>()
	const store = {
		get: vi.fn(async (key: string) => rows.get(key) ?? null),
		set: vi.fn(
			async (
				key: string,
				value: PendingInterestRow,
				options: { ex: number; nx?: true },
			) => {
				if (options.nx && rows.has(key)) return null
				rows.set(key, value)
				return 'OK'
			},
		),
		del: vi.fn(async (key: string) => (rows.delete(key) ? 1 : 0)),
	}
	return {
		store: store as unknown as PendingInterestStore & typeof store,
		rows,
	}
}

const join = {
	email: 'Reader@Example.test',
	fieldKey: 'waitlist_c6',
	at: '2026-10-29T21:07:00.000Z',
}

describe('pending interest joins', () => {
	it('holds a join for someone with no contact, by email key and list, with no address stored', async () => {
		const { store, rows } = fakeStore()
		expect(await holdPendingInterestFact(store, join)).toEqual({
			status: 'held',
			firstAt: join.at,
		})
		const key = pendingInterestKey(join.email, join.fieldKey)
		expect(rows.get(key)).toEqual({ at: join.at })
		expect(store.set).toHaveBeenCalledWith(
			key,
			{ at: join.at },
			{ nx: true, ex: PENDING_INTEREST_TTL_SECONDS },
		)
		expect(key).not.toContain('example')
		expect(key).not.toContain('@')
		// The confirm window is 7 days; the row outlives the last look.
		expect(PENDING_INTEREST_TTL_SECONDS).toBeGreaterThan(7 * 24 * 60 * 60)
	})

	it('a normalized address is the same pending join', () => {
		expect(pendingInterestKey(' reader@example.test ', 'waitlist_c6')).toBe(
			pendingInterestKey('READER@example.test', 'waitlist_c6'),
		)
		expect(pendingInterestKey('reader@example.test', 'waitlist_c7')).not.toBe(
			pendingInterestKey('reader@example.test', 'waitlist_c6'),
		)
	})

	it('a duplicate join keeps the first time', async () => {
		const { store } = fakeStore()
		await holdPendingInterestFact(store, join)
		expect(
			await holdPendingInterestFact(store, {
				...join,
				at: '2026-10-31T09:00:00.000Z',
			}),
		).toEqual({ status: 'existing', firstAt: join.at })
	})

	it('an earlier join (a backfill with Kit’s date) moves the row back', async () => {
		const { store, rows } = fakeStore()
		await holdPendingInterestFact(store, join)
		const earlier = '2026-10-01T00:00:00.000Z'
		expect(
			await holdPendingInterestFact(store, { ...join, at: earlier }),
		).toEqual({ status: 'held', firstAt: earlier })
		expect(rows.get(pendingInterestKey(join.email, join.fieldKey))).toEqual({
			at: earlier,
		})
	})

	it('a concurrent join that won the slot first gives its time', async () => {
		const { store, rows } = fakeStore()
		const key = pendingInterestKey(join.email, join.fieldKey)
		const raced = '2026-10-29T21:06:59.000Z'
		store.get
			.mockResolvedValueOnce(null)
			.mockImplementationOnce(async () => rows.get(key) ?? null)
		rows.set(key, { at: raced })
		expect(await holdPendingInterestFact(store, join)).toEqual({
			status: 'existing',
			firstAt: raced,
		})
	})

	it('release drops the row', async () => {
		const { store, rows } = fakeStore()
		await holdPendingInterestFact(store, join)
		await releasePendingInterestFact(store, join)
		expect(rows.size).toBe(0)
	})
})
