'use client'

import * as React from 'react'
import { createPortal } from 'react-dom'
import { TYPE } from '@/components/landing/type'
import { showRegionalOffer } from '@/lib/pricing-decisions'

import { usePriceCheck } from '@coursebuilder/commerce-next/pricing/pricing-check-context'
import { usePricing } from '@coursebuilder/commerce-next/pricing/pricing-context'
import { cn } from '@coursebuilder/ui/utils/cn'

const SLOT_ID = 'mobile-bar-regional-note'

/**
 * The mobile buy bar's second row, under its title and button, where the
 * regional-pricing note lands. It is empty (and takes no room) until a note
 * renders into it, and it is in the bar's flow, so a note that wraps to two
 * lines makes the bar taller instead of spilling over the row above.
 */
export const RegionalNoteSlot = () => <div id={SLOT_ID} />

/**
 * One-line regional-pricing notice for the mobile bottom bar. The desktop buy
 * box explains PPP with a checkbox and the from-country restriction, but a
 * phone visitor only ever meets the bar — so eligible visitors emailed support
 * asking whether regional pricing exists at all. This surfaces the answer
 * without owning the decision: tapping scrolls to the buy box, where the
 * checkbox and the restriction copy (a condition of the discount) live.
 *
 * It reads the quote of whichever pricing it sits in (the workshop bar's own
 * buy button, or the cohort rail's card) and renders into the bar's
 * `RegionalNoteSlot`. Nothing shows unless a PPP coupon is available for this
 * visitor and not already applied (an applied coupon shows in the price).
 */
export const RegionalPricingNote = ({ targetId }: { targetId: string }) => {
	const {
		options: { isPPPEnabled },
		formattedPrice,
		activeMerchantCoupon,
		allowPurchase,
		isPreviouslyPurchased,
		isTeamPurchaseActive,
	} = usePricing()
	const { isDowngrade } = usePriceCheck()
	const [slot, setSlot] = React.useState<HTMLElement | null>(null)
	React.useEffect(() => {
		setSlot(document.getElementById(SLOT_ID))
	}, [])

	const availablePPPCoupon = Array.isArray(formattedPrice?.availableCoupons)
		? formattedPrice.availableCoupons.find((coupon) => coupon?.type === 'ppp')
		: undefined
	// The same decision as the desktop buy box: no regional offer for someone
	// who cannot buy, already owns it, is downgrading, or is buying team seats.
	if (
		!slot ||
		!availablePPPCoupon ||
		activeMerchantCoupon?.type === 'ppp' ||
		!showRegionalOffer({
			allowPurchase,
			isPPPEnabled,
			hasRegionalCoupon: true,
			isPreviouslyPurchased,
			isDowngrade: isDowngrade(formattedPrice),
			isTeamPurchaseActive,
		})
	)
		return null

	const rawDiscount = availablePPPCoupon.percentageDiscount as
		| string
		| number
		| { toNumber?: () => number }
		| undefined
	const percentOff = Math.floor(
		(typeof rawDiscount === 'string'
			? Number(rawDiscount)
			: typeof rawDiscount === 'number'
				? rawDiscount
				: (rawDiscount?.toNumber?.() ?? 0)) * 100,
	)

	// Same guard as the buy box: `Intl.DisplayNames.of` throws on a structurally
	// invalid region code, and this code is stored coupon data.
	const rawCountryCode = availablePPPCoupon.country || 'US'
	const countryCode = /^[A-Za-z]{2}$/.test(rawCountryCode)
		? rawCountryCode.toUpperCase()
		: 'US'
	const country =
		new Intl.DisplayNames(['en'], { type: 'region' }).of(countryCode) ??
		countryCode

	return createPortal(
		<button
			type="button"
			data-regional-note=""
			onClick={() => {
				document
					.getElementById(targetId)
					?.scrollIntoView({ behavior: 'smooth', block: 'start' })
			}}
			// The type sits on the button, not an inner span: an inline span
			// cannot pull the lines closer than its block's own line height.
			className={cn(
				TYPE.metaSm,
				'border-border text-muted-foreground w-full cursor-pointer text-pretty border-t px-3 py-2 text-left',
			)}
		>
			{/* Rhymes with the buy box's "Buying from {country}?" sentence so the
			    tap lands on familiar words. */}
			Buying from{' '}
			<strong className="text-foreground font-semibold">{country}</strong>?{' '}
			{percentOff}% off regional pricing is available&nbsp;→
		</button>,
		slot,
	)
}
