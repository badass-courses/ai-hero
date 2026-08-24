import { formatInTimeZone } from 'date-fns-tz'

/**
 * Format discount amount for display based on coupon type
 *
 * @param coupon - Coupon object with discount information
 * @param coupon.amountDiscount - Fixed amount discount in cents (optional)
 * @param coupon.percentageDiscount - Percentage discount as decimal (e.g., 0.25 for 25%) (optional)
 * @returns Formatted discount string (e.g., "$20.00" or "25%")
 *
 * @example
 * ```ts
 * // Fixed discount
 * formatDiscount({ amountDiscount: 2000 }) // "$20.00"
 *
 * // Percentage discount
 * formatDiscount({ percentageDiscount: 0.25 }) // "25%"
 * ```
 */
export function formatDiscount(coupon: {
	amountDiscount?: number | null
	percentageDiscount?: number | string | null
}): string {
	const hasFixedDiscount = coupon.amountDiscount && coupon.amountDiscount > 0

	if (hasFixedDiscount && coupon.amountDiscount) {
		// Fixed amount discount (in cents, convert to dollars). Whole dollars
		// print without cents: every real sale is authored as one ("Save $100",
		// not "Save $100.00"), and the trailing zeros read as machine output on
		// every surface this string reaches (nav, hero, sale banner).
		const discountValue = coupon.amountDiscount / 100
		return Number.isInteger(discountValue)
			? `$${discountValue}`
			: `$${discountValue.toFixed(2)}`
	} else {
		// Percentage discount
		const percentOff = Number(coupon.percentageDiscount) * 100
		return `${percentOff}%`
	}
}

/**
 * The one way a coupon deadline is written out, so every surface names the
 * same calendar day. Sale coupons are authored to end at 11:59 PM Pacific;
 * formatting that instant in the reader's locale (or the server's) slides it
 * across midnight and prints the wrong day — the boss letter said "August 25"
 * under a sidebar saying "Aug 24". Pinned to PT and labeled with it, shorthand
 * on purpose.
 *
 * @example formatDeadline(coupon.expires) // "August 24, 2026 (PT)"
 * @example formatDeadline(coupon.expires, 'short') // "Aug 24 (PT)"
 */
export function formatDeadline(
	expires: Date | string | null | undefined,
	format: 'short' | 'long' = 'long',
): string | null {
	if (!expires) return null
	const date = typeof expires === 'string' ? new Date(expires) : expires
	const pattern = format === 'long' ? 'MMMM d, yyyy' : 'MMM d'
	return `${formatInTimeZone(date, 'America/Los_Angeles', pattern)} (PT)`
}
