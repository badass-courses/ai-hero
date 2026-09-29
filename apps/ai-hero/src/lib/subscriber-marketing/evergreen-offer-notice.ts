// Client-safe: the offer page's notice imports this; keep server code out.

/**
 * What the offer page may say about an evergreen `?coupon=` link, signed in or
 * not. Pricing refuses an expired exclusive coupon and falls back to the full
 * price; without this, the recipient of "final notice" sees that price with
 * no reason given (a support report, 2026-09-29).
 *
 * The answer names no contact and no price. It only restates the deadline the
 * link's own email already printed.
 */
export type EvergreenOfferStatus =
	| { readonly status: 'none' }
	| { readonly status: 'open' }
	| { readonly status: 'ended'; readonly deadline: string }

/** The site coupon id every evergreen offer link carries. */
export const EVERGREEN_COUPON_ID = /^eoj-coupon:[0-9a-f]{64}$/

export function isEvergreenCouponId(value: string | null | undefined) {
	return typeof value === 'string' && EVERGREEN_COUPON_ID.test(value)
}

export function evergreenOfferEndedText(deadline: string) {
	return `This private offer ended ${deadline}.`
}
