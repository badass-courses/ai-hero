'use client'

import * as Pricing from '@coursebuilder/commerce-next/pricing/pricing'
import { usePathname, useSearchParams } from 'next/navigation'
import { readCommerceUrlParams } from '@/app/(content)/workshops/_components/commerce-url-params'
import { TYPE } from '@/components/landing/type'
import { COUPON_USED_UP_MESSAGE } from '@/lib/purchase-guardrails'
import { isEvergreenCouponId } from '@/lib/subscriber-marketing/evergreen-offer-notice'

export function WorkshopUsedCouponNotice({
	coupon,
	productId,
}: {
	coupon?: unknown
	productId: string
}) {
	const pathname = usePathname()
	const searchParams = useSearchParams()
	// The Crash Course landing page already mounts the evergreen status banner.
	if (
		productId === 'product-ma254' &&
		pathname === '/workshops/ai-coding-crash-course' &&
		isEvergreenCouponId(readCommerceUrlParams(searchParams).params.coupon)
	)
		return null
	return <UsedCouponNotice coupon={coupon} />
}

const isUsed = (value: unknown) =>
	!!value &&
	typeof value === 'object' &&
	'paidCouponUsedUp' in value &&
	value.paidCouponUsedUp === true

export function UsedCouponNotice({ coupon }: { coupon?: unknown }) {
	const { formattedPrice, isPreviouslyPurchased } = Pricing.usePricing()
	if (
		isPreviouslyPurchased ||
		formattedPrice?.authoritative ||
		!(isUsed(coupon) || isUsed(formattedPrice))
	)
		return null
	return (
		<p role="status" className={TYPE.meta}>
			{COUPON_USED_UP_MESSAGE}
		</p>
	)
}
