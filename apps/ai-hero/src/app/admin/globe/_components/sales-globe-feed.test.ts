import { describe, expect, it } from 'vitest'
import type { SerializedPurchaseTickerHit } from '@/lib/admin-sales-globe-contract'
import {
	MAX_PENDING_HITS,
	mergePendingHits,
	nextHitGapMs,
	oldestFirst,
	replayHitGapMs,
	replayLookAtMs,
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
		city: null,
		region: null,
		lat: 38,
		lng: -97,
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
			mergePendingHits([hit('a')], [hit('a'), hit('b')]).map((row) => row.id)
		).toEqual(['a', 'b'])
	})

	it('keeps the newest pending hits when the pipe overflows', () => {
		const pending = [hit('old')]
		const incoming = Array.from({ length: MAX_PENDING_HITS }, (_, index) =>
			hit(`n${index}`)
		)
		const merged = mergePendingHits(pending, incoming, MAX_PENDING_HITS)
		expect(merged).toHaveLength(MAX_PENDING_HITS)
		expect(merged[0]?.id).toBe('n0')
		expect(merged.at(-1)?.id).toBe(`n${MAX_PENDING_HITS - 1}`)
		expect(merged.some((row) => row.id === 'old')).toBe(false)
	})

	it('paces replay from real time between sales, not a metronome', () => {
		expect(
			replayHitGapMs({
				previousCreatedAt: '2026-08-21T17:00:00.000Z',
				nextCreatedAt: '2026-08-21T17:00:01.000Z',
				speed: 1,
			})
		).toBe(1_100)
		expect(
			replayHitGapMs({
				previousCreatedAt: '2026-08-21T17:00:00.000Z',
				nextCreatedAt: '2026-08-21T17:05:00.000Z',
				speed: 1,
			})
		).toBe(2_500)
		expect(
			replayHitGapMs({
				previousCreatedAt: '2026-08-21T17:00:00.000Z',
				nextCreatedAt: '2026-08-21T17:05:00.000Z',
				speed: 2,
			})
		).toBe(1_250)
		expect(
			replayHitGapMs({
				previousCreatedAt: '2026-08-21T17:00:00.000Z',
				nextCreatedAt: '2026-08-21T18:00:00.000Z',
				speed: 1,
			})
		).toBe(3_600)
	})

	it('lets the camera use most of the replay beat', () => {
		expect(replayLookAtMs(1_100)).toBe(900)
		expect(replayLookAtMs(2_500)).toBe(1_800)
		expect(replayLookAtMs(3_600)).toBe(2_000)
	})

	it('sorts replay hits oldest first with a stable id tie-break', () => {
		expect([hit('b'), hit('a')].sort(oldestFirst).map((row) => row.id)).toEqual(
			['a', 'b']
		)
	})
})
