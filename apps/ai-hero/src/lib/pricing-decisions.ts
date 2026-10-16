// Pure pricing-display and seat-count decisions. Client-safe: no server code.

/** Everything the regional-pricing offer is gated on, desktop and mobile alike. */
export type RegionalOfferInput = {
	allowPurchase: boolean
	isPPPEnabled: boolean
	/** A regional coupon is quoted, applied, or pending re-quote. */
	hasRegionalCoupon: boolean
	isPreviouslyPurchased: boolean
	isDowngrade: boolean
	isTeamPurchaseActive: boolean
}

/**
 * One decision for the desktop buy box and the mobile bar note. Regional
 * pricing is a single-seat offer for someone who can still buy.
 */
export function showRegionalOffer(input: RegionalOfferInput): boolean {
	return (
		input.allowPurchase &&
		input.isPPPEnabled &&
		input.hasRegionalCoupon &&
		!input.isPreviouslyPurchased &&
		!input.isDowngrade &&
		!input.isTeamPurchaseActive
	)
}

/** The inline buy button's label: a sold-out product never says "Buy Now". */
export function inlineBuyLabel(input: { isSoldOut: boolean }) {
	return input.isSoldOut ? 'Sold Out' : 'Buy Now'
}

/** Whole-percent savings, or null when it is not a finite number. */
export function savingsPercentage(savings: number, fullPrice: number) {
	if (!Number.isFinite(savings) || !Number.isFinite(fullPrice)) return null
	if (fullPrice <= 0) return null
	const percentage = Math.round((savings / fullPrice) * 100)
	return Number.isFinite(percentage) ? percentage : null
}

/** A purchase row, reduced to what the seat count reads. */
export type SeatRow = {
	status: string | null | undefined
	/** Set when the purchase created a bulk coupon. */
	bulkCouponId?: string | null
	/** The bulk coupon's `maxUses`: the seats that purchase bought. */
	bulkCouponMaxUses?: number | null
}

/** Statuses that hold a seat. Refunded and every other status free it. */
export const SEAT_HOLDING_STATUSES = ['Valid', 'Restricted'] as const

/**
 * Seats taken by a product's purchases. Only Valid and Restricted rows count;
 * a bulk purchase counts as the seats it bought (its coupon's `maxUses`, at
 * least one), a single purchase as one.
 */
export function seatsTaken(rows: readonly SeatRow[]): number {
	let taken = 0
	for (const row of rows) {
		if (
			!(SEAT_HOLDING_STATUSES as readonly string[]).includes(row.status ?? '')
		)
			continue
		if (row.bulkCouponId) {
			const seats = row.bulkCouponMaxUses
			taken += typeof seats === 'number' && seats > 0 ? seats : 1
		} else {
			taken += 1
		}
	}
	return taken
}
