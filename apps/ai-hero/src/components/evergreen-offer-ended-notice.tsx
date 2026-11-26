'use client'

import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import { readCommerceUrlParams } from '@/app/(content)/workshops/_components/commerce-url-params'
import { TYPE } from '@/components/landing/type'
import {
	evergreenOfferEndedText,
	isEvergreenCouponId,
	showEvergreenEndedNotice,
} from '@/lib/subscriber-marketing/evergreen-offer-notice'
import { COUPON_USED_UP_MESSAGE } from '@/lib/purchase-guardrails'
import { z } from 'zod'

const statusSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('none') }),
	z.object({ status: z.literal('open') }),
	z.object({ status: z.literal('used') }),
	z.object({ status: z.literal('ended'), deadline: z.string().min(1) }),
])

/**
 * The static workshop page cannot read `?coupon=` on the server, so this asks
 * the uncached status route. The route formats the deadline; this only shows
 * it. Nothing renders unless the coupon has expired or been used and the
 * viewer does not already own the product. Ownership is a prop because this
 * component sits outside the buy box; `WorkshopEvergreenOfferEndedNotice`
 * (workshop-pricing.tsx) is the call site and reads the buy box's signal.
 */
export function EvergreenOfferEndedNotice({
	endpoint,
	viewerOwnsProduct,
}: {
	endpoint: string
	/** The buy box's display-only ownership signal, from the call site. */
	viewerOwnsProduct: boolean
}) {
	const searchParams = useSearchParams()
	const couponId = readCommerceUrlParams(searchParams).params.coupon
	const [offer, setOffer] = React.useState<z.infer<typeof statusSchema>>({
		status: 'none',
	})

	React.useEffect(() => {
		setOffer({ status: 'none' })
		if (!isEvergreenCouponId(couponId)) return
		const controller = new AbortController()
		const url = `${endpoint}?coupon=${encodeURIComponent(couponId!)}`
		fetch(url, { signal: controller.signal, cache: 'no-store' })
			.then((response) => (response.ok ? response.json() : null))
			.then((body) => {
				const parsed = statusSchema.safeParse(body)
				if (parsed.success && !controller.signal.aborted) setOffer(parsed.data)
			})
			.catch(() => undefined)
		return () => controller.abort()
	}, [couponId, endpoint])

	const message =
		offer.status === 'ended'
			? evergreenOfferEndedText(offer.deadline)
			: offer.status === 'used'
				? `${COUPON_USED_UP_MESSAGE}.`
				: null
	if (
		!message ||
		!showEvergreenEndedNotice({ status: offer.status, viewerOwnsProduct })
	)
		return null
	return (
		<section
			data-testid="evergreen-offer-ended"
			className="border-border border-y bg-background text-foreground"
		>
			<div className="px-[18px] py-6 sm:px-11">
				<p role="status" className={TYPE.body}>
					{message}
				</p>
			</div>
		</section>
	)
}
