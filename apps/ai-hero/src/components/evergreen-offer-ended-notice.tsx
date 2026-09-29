'use client'

import * as React from 'react'
import { useSearchParams } from 'next/navigation'
import { readCommerceUrlParams } from '@/app/(content)/workshops/_components/commerce-url-params'
import { TYPE } from '@/components/landing/type'
import {
	evergreenOfferEndedText,
	isEvergreenCouponId,
} from '@/lib/subscriber-marketing/evergreen-offer-notice'
import { z } from 'zod'

const statusSchema = z.discriminatedUnion('status', [
	z.object({ status: z.literal('none') }),
	z.object({ status: z.literal('open') }),
	z.object({ status: z.literal('ended'), deadline: z.string().min(1) }),
])

/**
 * The static workshop page cannot read `?coupon=` on the server, so this asks
 * the uncached status route. The route formats the deadline; this only shows
 * it. Nothing renders unless the link's evergreen coupon has ended.
 */
export function EvergreenOfferEndedNotice({ endpoint }: { endpoint: string }) {
	const searchParams = useSearchParams()
	const couponId = readCommerceUrlParams(searchParams).params.coupon
	const [deadline, setDeadline] = React.useState<string | null>(null)

	React.useEffect(() => {
		setDeadline(null)
		if (!isEvergreenCouponId(couponId)) return
		const controller = new AbortController()
		const url = `${endpoint}?coupon=${encodeURIComponent(couponId!)}`
		fetch(url, { signal: controller.signal, cache: 'no-store' })
			.then((response) => (response.ok ? response.json() : null))
			.then((body) => {
				const parsed = statusSchema.safeParse(body)
				if (parsed.success && parsed.data.status === 'ended')
					setDeadline(parsed.data.deadline)
			})
			.catch(() => undefined)
		return () => controller.abort()
	}, [couponId, endpoint])

	if (!deadline) return null
	return (
		<section
			data-testid="evergreen-offer-ended"
			className="border-border border-y bg-background text-foreground"
		>
			<div className="px-[18px] py-6 sm:px-11">
				<p role="status" className={TYPE.body}>
					{evergreenOfferEndedText(deadline)}
				</p>
			</div>
		</section>
	)
}
