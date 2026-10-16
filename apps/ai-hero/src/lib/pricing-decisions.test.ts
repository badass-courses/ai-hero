import { describe, expect, it } from 'vitest'

import { showEvergreenEndedNotice } from './subscriber-marketing/evergreen-offer-notice'
import {
	inlineBuyLabel,
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

describe('inlineBuyLabel', () => {
	it('never says Buy Now when sold out', () => {
		const legacy = () => 'Buy Now'
		expect(legacy()).toBe('Buy Now') // the bug: ignored isSoldOut
		expect(inlineBuyLabel({ isSoldOut: true })).toBe('Sold Out')
		expect(inlineBuyLabel({ isSoldOut: false })).toBe('Buy Now')
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

	it('one bulk row plus N redeemed seats is maxUses, not maxUses + N', () => {
		const bulk: SeatRow = {
			status: 'Valid',
			bulkCouponId: 'c',
			bulkCouponMaxUses: 5,
		}
		for (const n of [0, 1, 2, 5]) {
			const redemptions: SeatRow[] = Array.from({ length: n }, () => ({
				status: 'Valid',
				redeemedBulkCouponId: 'c',
			}))
			expect(seatsTaken([bulk, ...redemptions]), String(n)).toBe(5)
			expect(legacy([bulk, ...redemptions])).toBe(1 + n)
		}
	})

	it('a redeemed seat stays a seat when its bulk purchase no longer holds', () => {
		for (const status of ['Refunded', 'Banned']) {
			expect(
				seatsTaken([
					{ status, bulkCouponId: 'c', bulkCouponMaxUses: 5 },
					{ status: 'Valid', redeemedBulkCouponId: 'c' },
					{ status: 'Restricted', redeemedBulkCouponId: 'c' },
					{ status: 'Refunded', redeemedBulkCouponId: 'c' },
				]),
			).toBe(2)
		}
	})

	it('a redemption of a coupon bought on another product still counts one', () => {
		expect(
			seatsTaken([{ status: 'Valid', redeemedBulkCouponId: 'other' }]),
		).toBe(1)
	})

	it('add-seat purchases share one coupon with a raised maxUses: counted once', () => {
		const rows: SeatRow[] = [
			{ status: 'Valid', bulkCouponId: 'c', bulkCouponMaxUses: 8 },
			{ status: 'Valid', bulkCouponId: 'c', bulkCouponMaxUses: 8 },
		]
		expect(seatsTaken(rows)).toBe(8)
		expect(legacy(rows)).toBe(2)
		// one of the two refunded: the coupon still holds the seats
		expect(seatsTaken([{ ...rows[0]!, status: 'Refunded' }, rows[1]!])).toBe(8)
		// both refunded: none
		expect(seatsTaken(rows.map((r) => ({ ...r, status: 'Refunded' })))).toBe(0)
		// separate coupons add up
		expect(
			seatsTaken([
				...rows,
				{ status: 'Valid', bulkCouponId: 'd', bulkCouponMaxUses: 3 },
			]),
		).toBe(11)
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
