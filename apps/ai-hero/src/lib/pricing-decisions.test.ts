import { describe, expect, it } from 'vitest'

import { showEvergreenEndedNotice } from './subscriber-marketing/evergreen-offer-notice'
import {
	inlineBuyLabel,
	savingsPercentage,
	seatsTaken,
	showRegionalOffer,
	type RegionalOfferInput,
	type SeatRow,
} from './pricing-decisions'

const bools = [false, true]

describe('showRegionalOffer', () => {
	// The mobile note's old rule: a coupon and nothing else.
	const legacyMobile = (i: RegionalOfferInput) => i.hasRegionalCoupon
	// The desktop box's rule, which the new decision keeps.
	const desktop = (i: RegionalOfferInput) =>
		i.allowPurchase &&
		i.isPPPEnabled &&
		i.hasRegionalCoupon &&
		!i.isPreviouslyPurchased &&
		!i.isDowngrade &&
		!i.isTeamPurchaseActive

	const all: RegionalOfferInput[] = []
	for (const allowPurchase of bools)
		for (const isPPPEnabled of bools)
			for (const hasRegionalCoupon of bools)
				for (const isPreviouslyPurchased of bools)
					for (const isDowngrade of bools)
						for (const isTeamPurchaseActive of bools)
							all.push({
								allowPurchase,
								isPPPEnabled,
								hasRegionalCoupon,
								isPreviouslyPurchased,
								isDowngrade,
								isTeamPurchaseActive,
							})

	it('covers every one of the 64 input combinations', () => {
		expect(all).toHaveLength(64)
		for (const input of all)
			expect(showRegionalOffer(input), JSON.stringify(input)).toBe(
				desktop(input),
			)
	})

	it('shows only for a single-seat buyer who can still buy', () => {
		expect(showRegionalOffer(all.at(-1)!)).toBe(false)
		expect(
			showRegionalOffer({
				allowPurchase: true,
				isPPPEnabled: true,
				hasRegionalCoupon: true,
				isPreviouslyPurchased: false,
				isDowngrade: false,
				isTeamPurchaseActive: false,
			}),
		).toBe(true)
	})

	it('legacy mobile rule offered it where desktop hides it (team mode included)', () => {
		const wrong = all.filter((i) => legacyMobile(i) && !desktop(i))
		expect(wrong.some((i) => i.isTeamPurchaseActive)).toBe(true)
		expect(wrong.some((i) => i.isPreviouslyPurchased)).toBe(true)
		expect(wrong.some((i) => i.isDowngrade)).toBe(true)
		expect(wrong.some((i) => !i.allowPurchase)).toBe(true)
		for (const i of wrong) expect(showRegionalOffer(i)).toBe(false)
	})
})

describe('inlineBuyLabel / savingsPercentage', () => {
	it('never says Buy Now when sold out', () => {
		const legacy = () => 'Buy Now'
		expect(legacy()).toBe('Buy Now') // the bug: ignored isSoldOut
		expect(inlineBuyLabel({ isSoldOut: true })).toBe('Sold Out')
		expect(inlineBuyLabel({ isSoldOut: false })).toBe('Buy Now')
	})

	it('is a whole percent, or null when not a finite number', () => {
		const legacy = (s: number, f: number) => Math.round((s / f) * 100)
		expect(legacy(0, 0)).toBeNaN()
		expect(savingsPercentage(0, 0)).toBeNull()
		expect(savingsPercentage(10, 0)).toBeNull()
		expect(savingsPercentage(Number.NaN, 100)).toBeNull()
		expect(savingsPercentage(10, Number.POSITIVE_INFINITY)).toBeNull()
		expect(savingsPercentage(25, 100)).toBe(25)
		expect(savingsPercentage(0, 100)).toBe(0)
	})
})

describe('seatsTaken', () => {
	// The old counter: every row, whatever its status or kind.
	const legacy = (rows: SeatRow[]) => rows.length

	const statuses = [
		'Valid',
		'Restricted',
		'Refunded',
		'Disputed',
		'Banned',
		'',
		null,
	]
	const holds = (status: string | null) =>
		status === 'Valid' || status === 'Restricted'

	it('single purchases: a seat only while Valid or Restricted', () => {
		for (const status of statuses)
			expect(seatsTaken([{ status }]), String(status)).toBe(
				holds(status) ? 1 : 0,
			)
	})

	it('bulk purchases: seat quantity from the bulk coupon, only while holding', () => {
		for (const status of statuses) {
			const row = { status, bulkCouponId: 'c', bulkCouponMaxUses: 5 }
			expect(seatsTaken([row]), String(status)).toBe(holds(status) ? 5 : 0)
		}
	})

	it('a bulk row with no usable quantity still holds one seat', () => {
		for (const bulkCouponMaxUses of [null, undefined, 0, -1])
			expect(
				seatsTaken([{ status: 'Valid', bulkCouponId: 'c', bulkCouponMaxUses }]),
			).toBe(1)
	})

	it('mixes rows and differs from the legacy count', () => {
		const rows: SeatRow[] = [
			{ status: 'Valid' },
			{ status: 'Restricted' },
			{ status: 'Refunded' },
			{ status: 'Valid', bulkCouponId: 'c', bulkCouponMaxUses: 10 },
			{ status: 'Refunded', bulkCouponId: 'd', bulkCouponMaxUses: 3 },
		]
		expect(legacy(rows)).toBe(5)
		expect(seatsTaken(rows)).toBe(12)
		expect(seatsTaken([])).toBe(0)
	})
})

describe('showEvergreenEndedNotice', () => {
	// The old rule: show whenever the offer ended.
	const legacy = (status: string) => status === 'ended'

	it('hides for owners, shows only for an ended offer to a non-owner', () => {
		for (const status of ['none', 'open', 'ended'] as const)
			for (const viewerOwnsProduct of bools) {
				expect(showEvergreenEndedNotice({ status, viewerOwnsProduct })).toBe(
					status === 'ended' && !viewerOwnsProduct,
				)
			}
		expect(legacy('ended')).toBe(true) // the bug: owners saw it too
	})
})
