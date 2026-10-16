'use client'

import { useSession } from 'next-auth/react'
import { EvergreenOfferEndedNotice } from '@/components/evergreen-offer-ended-notice'
import {
	ownsProductForBuyBox,
	type BuyBoxPurchase,
} from '@/lib/owns-product-for-buy-box'

import { useWorkshopCommerce } from './workshop-pricing'

/**
 * The ended-offer notice with the buy box's ownership signal, read from the
 * same uncached commerce query. It stays hidden until that signal is known,
 * so an owner never sees the notice flash.
 *
 * It calls `useWorkshopCommerce` with the same input as `WorkshopPricingClient`
 * (same URL params and product id), so React Query dedupes the two into one
 * request. That query is disabled for a signed-out visitor with no commerce
 * params; such a visitor owns nothing, so the signal is known (not an owner).
 * If the query errors for a signed-in viewer, ownership cannot be read and the
 * viewer is treated as a non-owner: the notice shows.
 */
export function WorkshopEvergreenOfferEndedNotice({
	endpoint,
	productId,
}: {
	endpoint: string
	productId?: string
}) {
	const { status: sessionStatus } = useSession()
	const { data, isError } = useWorkshopCommerce(productId)
	const known =
		sessionStatus === 'unauthenticated' ||
		(sessionStatus === 'authenticated' && (Boolean(data) || isError))
	if (!known) return null
	return (
		<EvergreenOfferEndedNotice
			endpoint={endpoint}
			viewerOwnsProduct={ownsProductForBuyBox(
				(data as { purchases?: BuyBoxPurchase[] } | undefined)?.purchases,
				productId,
			)}
		/>
	)
}
