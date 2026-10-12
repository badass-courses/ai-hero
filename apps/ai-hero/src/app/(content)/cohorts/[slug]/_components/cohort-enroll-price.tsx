'use client'

import * as Pricing from '@coursebuilder/commerce-next/pricing/pricing'
import { formatUsd } from '@coursebuilder/commerce/format-usd'

/**
 * The price riding along in an inline enroll button, as on the workshop
 * page's "Buy Now | $299": the button and the number it commits you to are
 * one object.
 *
 * It goes in the button's `trailing` slot, reads the price the button itself
 * is waiting on, and renders nothing until there is one. A pending, failed or sold-out price leaves the label
 * alone, because the button already has a state of its own for each of those.
 */
export function CohortEnrollPrice() {
	const { formattedPrice, status, isSoldOut } = Pricing.usePricing()
	const price = formattedPrice?.calculatedPrice

	if (status === 'pending' || status === 'error' || isSoldOut || !price) {
		return null
	}

	const fullPrice = formattedPrice?.fullPrice ?? 0

	return (
		<>
			<span
				aria-hidden="true"
				className="bg-primary-foreground/25 relative z-10 mx-3 h-4 w-px"
			/>
			<span className="relative z-10 flex items-baseline font-mono text-sm font-medium">
				<span className="tabular-nums">{formatUsd(price).dollars}</span>
				{fullPrice > price ? (
					<span className="ml-1.5 font-normal line-through opacity-60">
						{formatUsd(fullPrice).dollars}
					</span>
				) : null}
			</span>
		</>
	)
}
