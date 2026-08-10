'use client'

import { formatDeadline } from '@/utils/discount-formatter'

/**
 * Display discount deadline date in MDX content
 * Receives coupon expiration date from server
 *
 * Renders via `formatDeadline`, so the day is the sale's actual last day in
 * Pacific time with the zone named — not whatever day the expiry instant
 * happens to fall on in the reader's locale.
 */
export function DiscountDeadline({
	format = 'long',
	expires,
}: {
	format?: 'short' | 'long'
	expires: Date | string | null
}) {
	const formatted = formatDeadline(expires, format)
	if (!formatted) return null

	return <>{formatted}</>
}
