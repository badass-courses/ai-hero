// Pure pricing-display and seat-count decisions. Client-safe: no server code.

import { regionalAllowedForQuantity } from './purchase-guardrails'

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

export const REGIONAL_SINGLE_SEAT_COPY =
	'Regional pricing applies to single-seat purchases.'

/**
 * Whether the regional toggle is offered at this quantity. Shares its
 * quantity rule with the checkout guard (`regionalAllowedForQuantity`).
 */
export function showRegionalToggle(input: {
	quantity: number
	regionalOfferAvailable: boolean
}): boolean {
	return (
		input.regionalOfferAvailable &&
		Number.isInteger(input.quantity) &&
		input.quantity > 0 &&
		regionalAllowedForQuantity(input.quantity)
	)
}

/**
 * A regional (PPP) coupon must not follow the buyer to a team quantity.
 * Only a regional coupon is cleared; any other merchant coupon stays.
 */
export function clearRegionalSelection(input: {
	quantity: number
	activeCouponType: string | null | undefined
}): boolean {
	return (
		!regionalAllowedForQuantity(input.quantity) &&
		input.activeCouponType === 'ppp'
	)
}

/** The offer exists, but not at this quantity: show the reason instead. */
export function showRegionalReason(input: {
	quantity: number
	regionalOfferExists: boolean
}): boolean {
	return input.regionalOfferExists && !regionalAllowedForQuantity(input.quantity)
}

/** The inline buy button's label: a sold-out product never says "Buy Now". */
export function inlineBuyLabel(input: { isSoldOut: boolean }) {
	return input.isSoldOut ? 'Sold Out' : 'Buy Now'
}

/** A purchase row, reduced to what the seat count reads. */
export type SeatRow = {
	status: string | null | undefined
	/** Set when the purchase created (or topped up) a bulk coupon. */
	bulkCouponId?: string | null
	/** The bulk coupon's `maxUses`: the seats bought on that coupon so far. */
	bulkCouponMaxUses?: number | null
	/** Set when the purchase is a redeemed team seat of someone's bulk coupon. */
	redeemedBulkCouponId?: string | null
}

/** Statuses that hold a seat. Refunded and every other status free it. */
export const SEAT_HOLDING_STATUSES = ['Valid', 'Restricted'] as const

const holdsSeat = (status: string | null | undefined) =>
	(SEAT_HOLDING_STATUSES as readonly string[]).includes(status ?? '')

/**
 * Seats taken by a product's purchases, the spec the SQL in
 * `seats-taken-query.ts` must match.
 *
 * - Only Valid and Restricted rows hold a seat.
 * - A bulk coupon counts once, as its `maxUses` (at least one), however many
 *   holding purchases point at it: adding seats raises `maxUses` on the same
 *   coupon and adds another purchase row.
 * - A redeemed team seat is inside its bulk coupon's `maxUses`, so it counts
 *   0 while a holding bulk purchase owns that coupon. If the bulk purchase is
 *   refunded, the redeemer still holds a seat and counts 1.
 * - Any other holding purchase counts 1.
 */
export function seatsTaken(rows: readonly SeatRow[]): number {
	const bulkCoupons = new Map<string, number>()
	for (const row of rows) {
		if (!holdsSeat(row.status) || !row.bulkCouponId) continue
		const seats = row.bulkCouponMaxUses
		bulkCoupons.set(
			row.bulkCouponId,
			Math.max(
				bulkCoupons.get(row.bulkCouponId) ?? 0,
				typeof seats === 'number' && seats > 0 ? seats : 1,
			),
		)
	}
	let taken = 0
	for (const seats of bulkCoupons.values()) taken += seats
	for (const row of rows) {
		if (!holdsSeat(row.status) || row.bulkCouponId) continue
		if (row.redeemedBulkCouponId && bulkCoupons.has(row.redeemedBulkCouponId))
			continue
		taken += 1
	}
	return taken
}
