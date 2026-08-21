import { describe, expect, it } from 'vitest'
import type { SerializedPurchaseTickerHit } from '@/lib/admin-sales-globe-contract'
import {
	MAX_PENDING_HITS,
	mergePendingHits,
	nextHitGapMs,
	oldestFirst,
	replayHitGapMs,
} from './sales-globe-feed'

function hit(id: string): SerializedPurchaseTickerHit {
	return {
		id,
		createdAt: '2026-08-21T17:00:00.000Z',
		amount: 199,
		productName: 'Crash Course',
		productId: 'product_1',
		country: 'US',
		userName: 'Ada',
		userEmail: 'ada@example.com',
		userImage: null,
		isTeam: false,
		seats: null,
	}
}

describe('sales globe feed', () => {
	it('slows for a single hit and speeds up a deep queue', () => {
		expect(nextHitGapMs(0, false)).toBe(620)
		expect(nextHitGapMs(0, true)).toBe(820)
		expect(nextHitGapMs(3, false)).toBe(500)
		expect(nextHitGapMs(6, false)).toBe(400)
		expect(nextHitGapMs(12, true)).toBe(280)
	})

	it('appends unseen hits and skips duplicates', () => {
		expect(
			mergePendingHits([hit('a')], [hit('a'), hit('b')]).map((row) => row.id),
		).toEqual(['a', 'b'])
	})

	it('keeps the newest pending hits when the pipe overflows', () => {
		const pending = [hit('old')]
		const incoming = Array.from({ length: MAX_PENDING_HITS }, (_, index) =>
			hit(`n${index}`),
		)
		const merged = mergePendingHits(pending, incoming, MAX_PENDING_HITS)
		expect(merged).toHaveLength(MAX_PENDING_HITS)
		expect(merged[0]?.id).toBe('n0')
		expect(merged.at(-1)?.id).toBe(`n${MAX_PENDING_HITS - 1}`)
		expect(merged.some((row) => row.id === 'old')).toBe(false)
	})

	it('uses speed as the only replay throttle', () => {
		expect(replayHitGapMs(false, 1)).toBe(620)
		expect(replayHitGapMs(true, 1)).toBe(820)
		expect(replayHitGapMs(false, 2)).toBe(310)
		expect(replayHitGapMs(false, 8)).toBe(78)
		expect(replayHitGapMs(false, 100)).toBe(40)
	})

	it('sorts replay hits oldest first with a stable id tie-break', () => {
		expect(
			[hit('b'), hit('a')].sort(oldestFirst).map((row) => row.id),
		).toEqual(['a', 'b'])
	})
})
